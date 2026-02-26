import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { policies, provisions, obligations, subDomainLabels, coverageAssessments } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { findCandidatesHybrid, HIGH_RISK_TOPICS } from '@/lib/matching';
import { ASSESS_PROMPT } from '@/lib/prompts';
import { logAuditEvent, PROMPT_VERSIONS, MODEL_ID } from '@/lib/audit';

export const maxDuration = 120;

const ORG_ID = 'ars';
const MAX_RETRIES = 2;
const VALID_STATUSES = ['COVERED', 'PARTIAL', 'GAP', 'CONFLICTING'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];

function ulid() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}_${rand}`;
}

function parseJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON found');
  let jsonStr = text.slice(start);
  const end = jsonStr.lastIndexOf('}');
  if (end >= 0) jsonStr = jsonStr.slice(0, end + 1);
  return JSON.parse(jsonStr);
}

function isHighRiskObligation(obligation) {
  const text = (obligation.requirement || '').toLowerCase();
  const topics = obligation.topics || [];
  return topics.some(t => HIGH_RISK_TOPICS.has(t)) ||
    HIGH_RISK_TOPICS.has(text) ||
    /\b(involuntary|restraint|seclusion|abuse|neglect|confidential|suicide|controlled substance)\b/.test(text);
}

function validateAssessment(parsed, candidatePolicies, obligation) {
  const errors = [];

  if (!VALID_STATUSES.includes(parsed.status)) {
    errors.push(`Invalid status: ${parsed.status}`);
  }
  if (parsed.confidence && !VALID_CONFIDENCE.includes(parsed.confidence)) {
    parsed.confidence = 'medium';
  }
  if (!parsed.confidence) {
    parsed.confidence = 'medium';
  }

  // Fix numeric policy references
  if (parsed.covering_policy_number) {
    const num = parsed.covering_policy_number;
    if (/^\d+$/.test(String(num))) {
      const idx = parseInt(num) - 1;
      if (idx >= 0 && idx < candidatePolicies.length) {
        parsed.covering_policy_number = candidatePolicies[idx].policy_number;
      } else {
        parsed.covering_policy_number = null;
      }
    }
    const policyMatch = String(num).match(/Policy\s+"?([^"]+)"?/i);
    if (policyMatch) {
      parsed.covering_policy_number = policyMatch[1];
    }
  }

  if (parsed.status === 'GAP' && parsed.covering_policy_number) {
    parsed.covering_policy_number = null;
  }
  if (parsed.status === 'COVERED' && !parsed.covering_policy_number && candidatePolicies.length > 0) {
    errors.push('COVERED but no covering_policy_number');
  }

  // Hybrid confidence: auto-escalate low-confidence high-risk to NEEDS_LEGAL_REVIEW
  if (parsed.confidence === 'low' && isHighRiskObligation(obligation) && parsed.status !== 'COVERED') {
    parsed._escalated = true;
  }

  return { valid: errors.length === 0, errors, parsed };
}

async function assessWithRetry(client, obligation, candidateContext) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await client.messages.create({
        model: MODEL_ID,
        max_tokens: 1024,
        messages: [{ role: 'user', content: ASSESS_PROMPT(obligation, candidateContext) }],
      });

      const parsed = parseJSON(message.content[0].text);
      const { valid, errors, parsed: validated } = validateAssessment(parsed, candidateContext, obligation);

      if (!valid && attempt < MAX_RETRIES) {
        lastError = errors.join(', ');
        continue;
      }

      if (!VALID_STATUSES.includes(validated.status)) {
        validated.status = 'GAP';
        validated.confidence = 'low';
        validated.gap_detail = `Assessment validation failed: ${errors.join(', ')}`;
      }

      return validated;

    } catch (err) {
      lastError = err.message;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }
  }

  return {
    status: 'GAP', confidence: 'low',
    covering_policy_number: null,
    gap_detail: `Assessment failed after ${MAX_RETRIES + 1} attempts: ${lastError}`,
    reasoning: 'Error during assessment',
  };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { obligation_ids, map_run_id, facility_id } = body;

    if (!obligation_ids?.length) {
      return Response.json({ error: 'Missing obligation_ids' }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const allPolicies = await db.select().from(policies);
    const allProvisions = await db.select().from(provisions);
    const allLabels = await db.select().from(subDomainLabels);

    const provsByPolicy = {};
    for (const prov of allProvisions) {
      if (!provsByPolicy[prov.policy_id]) provsByPolicy[prov.policy_id] = [];
      provsByPolicy[prov.policy_id].push(prov);
    }

    const results = [];
    const runId = map_run_id || ulid();

    for (const oblId of obligation_ids) {
      const oblRows = await db.select().from(obligations).where(eq(obligations.id, oblId));
      if (oblRows.length === 0) continue;
      const obl = oblRows[0];

      // Hybrid matching: vector + keyword
      const candidates = await findCandidatesHybrid(obl, allPolicies, allProvisions, allLabels);

      if (candidates.length === 0) {
        const assessId = ulid();
        await db.insert(coverageAssessments).values({
          id: assessId, org_id: ORG_ID, facility_id: facility_id || null,
          obligation_id: obl.id, policy_id: null, provision_id: null,
          status: 'GAP', confidence: 'high',
          gap_detail: 'No candidate policies found by matching algorithm',
          match_method: 'none', match_score: 0,
          map_run_id: runId, assessed_by: 'algorithm',
          model_id: MODEL_ID, prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
        });
        results.push({ obligation_id: obl.id, citation: obl.citation, status: 'GAP', candidates: 0 });

        await logAuditEvent({
          event_type: 'assessment', entity_type: 'coverage_assessment', entity_id: assessId,
          actor: 'llm', model_id: MODEL_ID, prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
          input_summary: `Obligation: ${obl.citation}`, output_summary: 'GAP - no candidates',
        });
        continue;
      }

      const candidateContext = candidates.map(c => ({
        policy_number: c.policy_number,
        title: c.title,
        score: c.score,
        provisions: (provsByPolicy[c.policy_id] || []).slice(0, 15),
      }));

      const assessment = await assessWithRetry(client, obl, candidateContext);

      let matchedPolicyId = null;
      let matchScore = 0;
      let matchMethod = 'llm';
      let vectorScore = null;

      if (assessment.covering_policy_number) {
        const matched = candidates.find(c => c.policy_number === assessment.covering_policy_number);
        if (matched) {
          matchedPolicyId = matched.policy_id;
          matchScore = matched.score;
          matchMethod = matched.methods?.[0]?.method || 'llm';
          vectorScore = matched.signal_breakdown?.vector || null;
        }
      }

      // Apply hybrid escalation
      let finalStatus = assessment.status;
      if (assessment._escalated) {
        finalStatus = 'NEEDS_LEGAL_REVIEW';
      }

      const assessId = ulid();
      await db.insert(coverageAssessments).values({
        id: assessId, org_id: ORG_ID, facility_id: facility_id || null,
        obligation_id: obl.id, policy_id: matchedPolicyId, provision_id: null,
        status: finalStatus, confidence: assessment.confidence || 'medium',
        gap_detail: assessment.gap_detail || null,
        recommended_policy: assessment.recommended_policy || null,
        obligation_span: assessment.obligation_span || null,
        provision_span: assessment.provision_span || null,
        reasoning: assessment.reasoning || null,
        match_method: matchMethod, match_score: matchScore,
        vector_score: vectorScore,
        map_run_id: runId, assessed_by: 'llm',
        model_id: MODEL_ID, prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
      });

      await logAuditEvent({
        event_type: 'assessment', entity_type: 'coverage_assessment', entity_id: assessId,
        actor: 'llm', model_id: MODEL_ID, prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
        input_summary: `Obligation: ${obl.citation} | ${candidates.length} candidates`,
        output_summary: `${finalStatus} (${assessment.confidence}) → ${assessment.covering_policy_number || 'none'}`,
      });

      results.push({
        obligation_id: obl.id, citation: obl.citation, status: finalStatus,
        confidence: assessment.confidence, covering_policy: assessment.covering_policy_number,
        gap_detail: assessment.gap_detail, reasoning: assessment.reasoning,
        candidates: candidates.length,
      });
    }

    return Response.json({ results, map_run_id: runId, total: results.length });

  } catch (err) {
    console.error('Assess error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
