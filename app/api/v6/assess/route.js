import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { policies, provisions, obligations, subDomainLabels, coverageAssessments } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
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
    /\b(involuntary|restraint|seclusion|abuse|neglect|confidential|suicide|controlled substance)\b/.test(text);
}

function validateAssessment(parsed, candidatePolicies, obligation) {
  const errors = [];
  if (!VALID_STATUSES.includes(parsed.status)) {
    errors.push(`Invalid status: ${parsed.status}`);
  }
  if (!parsed.confidence || !VALID_CONFIDENCE.includes(parsed.confidence)) {
    parsed.confidence = 'medium';
  }
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
  if (parsed.status === 'GAP') parsed.covering_policy_number = null;
  if (parsed.status === 'COVERED' && !parsed.covering_policy_number && candidatePolicies.length > 0) {
    errors.push('COVERED but no covering_policy_number');
  }
  if (parsed.confidence === 'low' && isHighRiskObligation(obligation) && parsed.status !== 'COVERED') {
    parsed._escalated = true;
  }
  return { valid: errors.length === 0, errors, parsed };
}

// GET: return assessment progress
export async function GET() {
  try {
    const result = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM obligations) as total_obligations,
        (SELECT count(DISTINCT obligation_id) FROM coverage_assessments) as assessed,
        (SELECT count(*) FROM obligations WHERE id NOT IN (SELECT obligation_id FROM coverage_assessments)) as unassessed,
        (SELECT count(*) FROM coverage_assessments WHERE status = 'COVERED') as covered,
        (SELECT count(*) FROM coverage_assessments WHERE status = 'PARTIAL') as partial,
        (SELECT count(*) FROM coverage_assessments WHERE status = 'GAP') as gap,
        (SELECT count(*) FROM coverage_assessments WHERE status = 'CONFLICTING') as conflicting,
        (SELECT count(*) FROM coverage_assessments WHERE status = 'NEEDS_LEGAL_REVIEW') as needs_review
    `);
    const row = (result.rows || result)[0];
    return Response.json(row);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// POST: assess one obligation
export async function POST(req) {
  try {
    const body = await req.json();
    const { map_run_id, facility_id } = body;
    const runId = map_run_id || ulid();

    // Get next unassessed obligation
    const nextResult = await db.execute(sql`
      SELECT id FROM obligations
      WHERE id NOT IN (SELECT obligation_id FROM coverage_assessments)
      ORDER BY reg_source_id, citation
      LIMIT 1
    `);
    const nextRow = (nextResult.rows || nextResult)[0];

    if (!nextRow) {
      return Response.json({ ok: true, done: true, message: 'All obligations assessed' });
    }

    const [obl] = await db.select().from(obligations).where(eq(obligations.id, nextRow.id));

    // Load all policies and provisions (cached per call — not ideal but works)
    const allPolicies = await db.select().from(policies);
    const allProvisions = await db.select().from(provisions);
    const allLabels = await db.select().from(subDomainLabels);

    const provsByPolicy = {};
    for (const prov of allProvisions) {
      if (!provsByPolicy[prov.policy_id]) provsByPolicy[prov.policy_id] = [];
      provsByPolicy[prov.policy_id].push(prov);
    }

    // Hybrid matching
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

      const remaining = await db.execute(sql`
        SELECT count(*) as c FROM obligations WHERE id NOT IN (SELECT obligation_id FROM coverage_assessments)
      `);
      const left = Number((remaining.rows || remaining)[0].c);

      return Response.json({
        ok: true, done: left === 0,
        obligation_id: obl.id, citation: obl.citation,
        status: 'GAP', confidence: 'high', candidates: 0,
        remaining: left, map_run_id: runId,
      });
    }

    // Build candidate context for Claude
    const candidateContext = candidates.map(c => ({
      policy_number: c.policy_number,
      title: c.title,
      score: c.score,
      provisions: (provsByPolicy[c.policy_id] || []).slice(0, 15),
    }));

    // Assess with retry
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let assessment = null;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const message = await client.messages.create({
          model: MODEL_ID,
          max_tokens: 1024,
          messages: [{ role: 'user', content: ASSESS_PROMPT(obl, candidateContext) }],
        });
        const parsed = parseJSON(message.content[0].text);
        const { valid, errors, parsed: validated } = validateAssessment(parsed, candidateContext, obl);

        if (!valid && attempt < MAX_RETRIES) {
          lastError = errors.join(', ');
          continue;
        }

        if (!VALID_STATUSES.includes(validated.status)) {
          validated.status = 'GAP';
          validated.confidence = 'low';
          validated.gap_detail = `Validation failed: ${errors.join(', ')}`;
        }
        assessment = validated;
        break;
      } catch (err) {
        lastError = err.message;
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    if (!assessment) {
      assessment = {
        status: 'GAP', confidence: 'low',
        covering_policy_number: null,
        gap_detail: `Assessment failed: ${lastError}`,
        reasoning: 'Error during assessment',
      };
    }

    // Resolve matched policy
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

    let finalStatus = assessment.status;
    if (assessment._escalated) finalStatus = 'NEEDS_LEGAL_REVIEW';

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
      input_summary: `${obl.citation} | ${candidates.length} candidates`,
      output_summary: `${finalStatus} (${assessment.confidence}) → ${assessment.covering_policy_number || 'none'}`,
    });

    const remaining = await db.execute(sql`
      SELECT count(*) as c FROM obligations WHERE id NOT IN (SELECT obligation_id FROM coverage_assessments)
    `);
    const left = Number((remaining.rows || remaining)[0].c);

    return Response.json({
      ok: true, done: left === 0,
      obligation_id: obl.id, citation: obl.citation,
      status: finalStatus, confidence: assessment.confidence,
      covering_policy: assessment.covering_policy_number,
      candidates: candidates.length,
      remaining: left, map_run_id: runId,
    });

  } catch (err) {
    console.error('Assess error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
