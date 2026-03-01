import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { policies, provisions, obligations, subDomainLabels, coverageAssessments, facilityProfiles } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { findCandidatesHybrid, HIGH_RISK_TOPICS } from '@/lib/matching';
import { ASSESS_PROMPT } from '@/lib/prompts';
import { logAuditEvent, PROMPT_VERSIONS, MODEL_ID } from '@/lib/audit';
import { ulid } from '@/lib/ulid';
import { parseJSON } from '@/lib/parse';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ORG_ID = 'ars';
const MAX_RETRIES = 2;
const VALID_STATUSES = ['COVERED', 'PARTIAL', 'GAP', 'CONFLICTING', 'NOT_APPLICABLE'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];

// ── Provision capping constants ──
const MAX_PROVISIONS_PER_POLICY = 8;
const MAX_TOTAL_PROVISIONS = 96;
const MIN_PROVISIONS_PER_POLICY = 4;
const MAX_CITATION_PINNED_PER_POLICY = 2;

// ── N/A validation constants ──
const BOILERPLATE_BLACKLIST = new Set([
  'Not specified',
  'None specified',
  'No',
  'YES',
  'Services Excluded: None specified',
  'Smoking Policy: Not specified',
  'Accreditations: Not specified',
]);

const LOW_INFO_TOKENS = new Set([
  'program', 'facility', 'policy', 'organization', 'services', 'service',
  'provided', 'required', 'shall', 'must', 'will', 'include', 'ensure',
  'maintain', 'process', 'procedure', 'documentation', 'applicable',
  'appropriate', 'criteria', 'standard', 'individuals', 'staff', 'patients',
  'residents', 'client', 'clients', 'person', 'persons', 'records', 'record',
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'to', 'for', 'is', 'are',
  'be', 'by', 'with', 'that', 'this', 'from', 'at', 'on', 'as', 'not',
  'all', 'each', 'any', 'has', 'have', 'been', 'their', 'its', 'may',
]);

// Synonym families for N/A validation — bidirectional lookup
const SYNONYM_FAMILIES = {
  restraint: ['restraint', 'seclusion', 'physical intervention', 'physical interventions'],
  smoking: ['smoking', 'tobacco', 'vaping', 'smoke'],
  otp: ['otp', 'methadone', 'opioid treatment program', 'opioid treatment'],
  work: ['work', 'employment', 'labor', 'wages', 'vocational'],
};

// Known LOC keywords for Path A validation
const LOC_KEYWORDS = new Set([
  'residential', 'php', 'iop', 'op', 'outpatient', 'detox',
  'inpatient', 'mh_rtf', 'day/night', 'day treatment',
]);

// Admin/process markers for Rule 10 stopgap
const ADMIN_MARKERS = [
  /submit.*report/i, /\bESC\b/, /accreditation committee/i,
  /survey submission/i, /submission to the joint commission/i,
  /accreditation.*process/i,
];

// Negation markers for Path B (activity-based N/A)
const NEGATION_MARKERS = [
  'prohibit', 'does not', 'no —', 'not operate', 'not permitted',
  'excluded', 'prohibited', 'all physical interventions prohibited',
];


// ═══════════════════════════════════════════════════════
// Provision capping with citation-pinned bypass (hot-fix 2a)
// ═══════════════════════════════════════════════════════

function capProvisions(candidateContext, obligation, provsByPolicy) {
  const oblCitation = (obligation.citation || '').toLowerCase().trim();

  for (const candidate of candidateContext) {
    const allProvs = provsByPolicy[candidate.policy_id] || [];
    if (allProvs.length <= MIN_PROVISIONS_PER_POLICY) {
      candidate.provisions = [...allProvs];
      continue;
    }

    // 1. Citation-pinned provisions bypass vector ranking
    const citationPinned = [];
    const unpinned = [];
    for (const prov of allProvs) {
      const provCitation = (prov.source_citation || '').toLowerCase().trim();
      if (provCitation && oblCitation && provCitation.includes(oblCitation)) {
        citationPinned.push(prov);
      } else {
        unpinned.push(prov);
      }
    }
    const pinnedToUse = citationPinned.slice(0, MAX_CITATION_PINNED_PER_POLICY);
    const pinnedIds = new Set(pinnedToUse.map(p => p.id));

    // 2. Fill remaining slots from unpinned provisions (DB order = section order)
    const remaining = unpinned.filter(p => !pinnedIds.has(p.id));
    const slots = Math.max(MIN_PROVISIONS_PER_POLICY, MAX_PROVISIONS_PER_POLICY) - pinnedToUse.length;
    const topRemaining = remaining.slice(0, Math.max(0, slots));

    candidate.provisions = [...pinnedToUse, ...topRemaining];
  }

  // Global cap: if total exceeds MAX_TOTAL, trim from largest candidates first
  let total = candidateContext.reduce((sum, c) => sum + c.provisions.length, 0);
  while (total > MAX_TOTAL_PROVISIONS) {
    let maxIdx = -1;
    let maxLen = MIN_PROVISIONS_PER_POLICY;
    for (let i = 0; i < candidateContext.length; i++) {
      if (candidateContext[i].provisions.length > maxLen) {
        maxLen = candidateContext[i].provisions.length;
        maxIdx = i;
      }
    }
    if (maxIdx === -1) break;
    candidateContext[maxIdx].provisions.pop();
    total--;
  }

  return candidateContext;
}


// ═══════════════════════════════════════════════════════
// Server-side v7 validation (3-path N/A, all hot-fixes)
// ═══════════════════════════════════════════════════════

function validateV7Assessment(parsed, candidatePolicies, obligation, facility, allProvisionTexts) {
  const errors = [];
  const warnings = [];

  // ── Basic status validation ──
  if (!VALID_STATUSES.includes(parsed.status)) {
    errors.push(`Invalid status: ${parsed.status}`);
  }
  if (!parsed.confidence || !VALID_CONFIDENCE.includes(parsed.confidence)) {
    parsed.confidence = 'medium';
  }

  // Fix covering_policy_number if model returned index or wrapped format
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

  // Null out covering_policy for GAP and NOT_APPLICABLE
  if (parsed.status === 'GAP' || parsed.status === 'NOT_APPLICABLE') {
    parsed.covering_policy_number = null;
  }

  const candidatePolicyNumbers = new Set(candidatePolicies.map(c => c.policy_number));
  const requirementText = obligation.requirement || '';
  const citationText = obligation.citation || '';
  const locLine = obligation.loc_applicability
    ? (Array.isArray(obligation.loc_applicability) ? obligation.loc_applicability.join(', ') : String(obligation.loc_applicability))
    : '';

  // Build facility context string for substring validation
  const facilityContextBlock = facility ? [
    `Facility: ${facility.name} (${facility.abbreviation})`,
    `State: ${facility.state}`,
    `Levels of Care: ${facility.levels_of_care?.join(', ') || 'Not specified'}`,
    `Services Offered: ${facility.services_offered?.join(', ') || 'Not specified'}`,
    `Services Excluded: ${facility.services_excluded?.join(', ') || 'None specified'}`,
    `Accreditations: ${facility.accreditations?.join(', ') || 'Not specified'}`,
    `Prohibits Restraint/Seclusion: ${facility.prohibits_restraint ? 'YES — all physical interventions prohibited by policy' : 'No'}`,
    `OTP/Methadone: ${facility.operates_otp ? 'YES' : 'NO — facility does not operate an OTP or dispense methadone'}`,
    `Smoking Policy: ${facility.smoking_in_buildings_allowed ? 'Smoking permitted in buildings' : facility.smoking_in_buildings_allowed === false ? 'NO — smoking prohibited in all buildings' : 'Not specified'}`,
    `Patient Work Program: ${facility.allows_patient_work_program ? 'YES' : facility.allows_patient_work_program === false ? 'NO — facility does not operate patient work programs' : 'Not specified'}`,
  ].join('\n') : '';

  const allProvTexts = allProvisionTexts || [];


  // ═══════════════════════════════════════════════════════
  // NOT_APPLICABLE validation (3-path: LOC / Activity / Reject)
  // ═══════════════════════════════════════════════════════

  if (parsed.status === 'NOT_APPLICABLE') {
    // Rule 10 — Admin/process stopgap: force GAP, not N/A
    if (ADMIN_MARKERS.some(rx => rx.test(requirementText))) {
      errors.push('NOT_APPLICABLE rejected: administrative/accreditation process item');
      parsed._force_status = 'GAP';
      parsed._force_gap_detail = 'Administrative/accreditation process item — should be excluded upstream.';
      parsed._force_recommended_policy = null;
      return { valid: false, errors, warnings, parsed };
    }

    // Require both anchors
    if (!parsed.trigger_span) {
      errors.push('NOT_APPLICABLE requires trigger_span');
    }
    if (!parsed.inapplicability_reason) {
      errors.push('NOT_APPLICABLE requires inapplicability_reason');
    }

    if (parsed.trigger_span && parsed.inapplicability_reason) {
      // Boilerplate blacklist
      if (BOILERPLATE_BLACKLIST.has(parsed.inapplicability_reason.trim())) {
        errors.push(`inapplicability_reason is boilerplate: "${parsed.inapplicability_reason}"`);
      }

      // trigger_span must be substring of requirement, citation, or LOC line
      const triggerInReq = requirementText.includes(parsed.trigger_span);
      const triggerInCit = citationText.includes(parsed.trigger_span);
      const triggerInLoc = locLine.includes(parsed.trigger_span);
      if (!triggerInReq && !triggerInCit && !triggerInLoc) {
        errors.push('trigger_span not found as substring of Requirement, Citation, or LOC Applicability');
      }

      // inapplicability_reason must be substring of facility context or a provision
      const reasonInFacility = facilityContextBlock.includes(parsed.inapplicability_reason);
      const reasonInProvision = allProvTexts.some(t => t.includes(parsed.inapplicability_reason));
      if (!reasonInFacility && !reasonInProvision) {
        errors.push('inapplicability_reason not found as substring of facility context or any provision');
      }

      // Minimum substance: trigger_span >= 8 chars
      if (parsed.trigger_span.length < 8) {
        errors.push(`trigger_span too short (${parsed.trigger_span.length} chars, need >= 8)`);
      }

      // ── Three-path N/A validation (red-team hot-fixes 1a/1b/1c) ──
      const triggerLower = parsed.trigger_span.toLowerCase();
      const reasonLower = parsed.inapplicability_reason.toLowerCase();

      // Determine which path applies
      const triggerHasLOC = [...LOC_KEYWORDS].some(k => triggerLower.includes(k))
        || triggerInLoc; // trigger source is LOC Applicability line

      if (triggerHasLOC) {
        // PATH A — LOC-based N/A
        // Programmatic check: verify the triggered LOC isn't in facility's levels_of_care
        const facilityLOCs = (facility?.levels_of_care || []).map(l => l.toLowerCase());
        const triggerLOCTokens = [...LOC_KEYWORDS].filter(k => triggerLower.includes(k));

        // Also include LOC Applicability values if trigger came from that line
        const locValues = obligation.loc_applicability
          ? (Array.isArray(obligation.loc_applicability) ? obligation.loc_applicability : [obligation.loc_applicability])
          : [];
        const allTriggerLOCs = [...triggerLOCTokens, ...locValues.map(v => v.toLowerCase())];

        const facilityHasLOC = allTriggerLOCs.some(tl =>
          facilityLOCs.some(fl => fl.toLowerCase().includes(tl) || tl.includes(fl.toLowerCase()))
        );
        if (facilityHasLOC) {
          errors.push(`LOC-based N/A rejected: facility offers LOC (trigger: ${allTriggerLOCs.join(', ')}, facility: ${facilityLOCs.join(', ')})`);
        }

      } else {
        // Check known activity families
        let triggerFamily = null;
        for (const [family, synonyms] of Object.entries(SYNONYM_FAMILIES)) {
          if (synonyms.some(s => triggerLower.includes(s))) {
            triggerFamily = family;
            break;
          }
        }

        if (triggerFamily) {
          // PATH B — Activity-based N/A
          // Require synonym overlap with the same family
          const familySynonyms = SYNONYM_FAMILIES[triggerFamily];
          const reasonHasFamilyToken = familySynonyms.some(s => reasonLower.includes(s));
          if (!reasonHasFamilyToken) {
            errors.push(`Activity N/A: inapplicability_reason lacks token from ${triggerFamily} family (${familySynonyms.join(', ')})`);
          }
          // Require negation marker in evidence
          const hasNegation = NEGATION_MARKERS.some(m => reasonLower.includes(m));
          if (!hasNegation) {
            errors.push('Activity N/A: inapplicability_reason lacks negation marker (prohibit, does not, NO —, etc.)');
          }

        } else {
          // PATH C — Unknown trigger: reject N/A entirely
          errors.push('NOT_APPLICABLE rejected: trigger does not match known LOC or activity family (restraint/smoking/otp/work)');
        }
      }
    }

    // Set retry instruction if N/A validation failed
    if (errors.length > 0) {
      parsed._retry_instruction = 'NOT_APPLICABLE rejected: invalid evidence. Reassess as COVERED/PARTIAL/GAP.';
    }
  }


  // ═══════════════════════════════════════════════════════
  // CONFLICTING validation
  // ═══════════════════════════════════════════════════════

  if (parsed.status === 'CONFLICTING') {
    if (!parsed.conflict_detail) {
      errors.push('CONFLICTING requires conflict_detail');
    }
    if (parsed.covering_policy_number && !candidatePolicyNumbers.has(parsed.covering_policy_number)) {
      errors.push(`covering_policy_number "${parsed.covering_policy_number}" not in candidates`);
    }
    if (parsed.obligation_span && !requirementText.includes(parsed.obligation_span)) {
      errors.push('obligation_span not found as substring of Requirement');
    }
    if (parsed.provision_span) {
      if (!allProvTexts.some(t => t.includes(parsed.provision_span))) {
        errors.push('provision_span not found as substring of any presented provision');
      }
    }
  }


  // ═══════════════════════════════════════════════════════
  // COVERED / PARTIAL validation
  // ═══════════════════════════════════════════════════════

  if (parsed.status === 'COVERED' || parsed.status === 'PARTIAL') {
    if (!parsed.covering_policy_number) {
      if (candidatePolicies.length > 0) {
        errors.push(`${parsed.status} requires covering_policy_number`);
      }
    } else if (!candidatePolicyNumbers.has(parsed.covering_policy_number)) {
      errors.push(`covering_policy_number "${parsed.covering_policy_number}" not in candidates`);
    }
    if (parsed.obligation_span && !requirementText.includes(parsed.obligation_span)) {
      warnings.push('obligation_span not exact substring of Requirement (non-blocking)');
    }
    if (parsed.provision_span) {
      if (!allProvTexts.some(t => t.includes(parsed.provision_span))) {
        warnings.push('provision_span not exact substring of any presented provision (non-blocking)');
      }
    }
  }

  if (parsed.status === 'PARTIAL') {
    if (!parsed.gap_detail || parsed.gap_detail.length < 10) {
      errors.push('PARTIAL requires gap_detail with >= 10 chars');
    }
  }

  if (parsed.status === 'GAP') {
    if (!parsed.gap_detail) {
      warnings.push('GAP should have gap_detail');
    }
  }


  // ═══════════════════════════════════════════════════════
  // reviewed_provision_refs validation
  // ═══════════════════════════════════════════════════════

  if (['COVERED', 'PARTIAL', 'CONFLICTING'].includes(parsed.status)) {
    const refs = parsed.reviewed_provision_refs;
    const totalProvisions = candidatePolicies.reduce((sum, c) => sum + (c.provisions?.length || 0), 0);
    const minRefs = Math.min(2, totalProvisions);
    if (!Array.isArray(refs) || refs.length < minRefs) {
      warnings.push(`reviewed_provision_refs should have >= ${minRefs} entries`);
    }
    if (Array.isArray(refs)) {
      const refPattern = /^[A-Za-z0-9._\- ]+\[\d+\]$/;
      for (const ref of refs) {
        if (!refPattern.test(ref)) {
          warnings.push(`reviewed_provision_ref "${ref}" doesn't match expected format`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, parsed };
}


// ── High-risk escalation ──

function isHighRiskObligation(obligation) {
  const text = (obligation.requirement || '').toLowerCase();
  const topics = obligation.topics || [];
  return topics.some(t => HIGH_RISK_TOPICS.has(t)) ||
    /\b(involuntary|restraint|seclusion|abuse|neglect|confidential|suicide|controlled substance)\b/.test(text);
}


// ═══════════════════════════════════════════════════════
// GET: Assessment stats
// ═══════════════════════════════════════════════════════

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get('run_id');

    let effectiveRunId = runId;
    if (!effectiveRunId) {
      const latest = await db.execute(sql`
        SELECT id FROM map_runs ORDER BY (status = 'completed') DESC, started_at DESC LIMIT 1
      `);
      effectiveRunId = (latest.rows || latest)?.[0]?.id || null;
    }

    const runFilter = effectiveRunId
      ? sql`WHERE map_run_id = ${effectiveRunId}`
      : sql``;

    const result = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM obligations) as total_obligations,
        (SELECT count(DISTINCT obligation_id) FROM coverage_assessments ${runFilter}) as assessed,
        (SELECT count(*) FROM obligations WHERE id NOT IN (
          SELECT obligation_id FROM coverage_assessments ${runFilter}
        )) as unassessed,
        (SELECT count(*) FROM coverage_assessments ${runFilter} WHERE COALESCE(human_status, status) = 'COVERED') as covered,
        (SELECT count(*) FROM coverage_assessments ${runFilter} WHERE COALESCE(human_status, status) = 'PARTIAL') as partial,
        (SELECT count(*) FROM coverage_assessments ${runFilter} WHERE COALESCE(human_status, status) = 'GAP') as gap,
        (SELECT count(*) FROM coverage_assessments ${runFilter} WHERE COALESCE(human_status, status) = 'CONFLICTING') as conflicting,
        (SELECT count(*) FROM coverage_assessments ${runFilter} WHERE COALESCE(human_status, status) = 'NOT_APPLICABLE') as not_applicable,
        (SELECT count(*) FROM coverage_assessments ${runFilter} WHERE COALESCE(human_status, status) = 'NEEDS_LEGAL_REVIEW') as needs_review
    `);
    const row = (result.rows || result)[0];
    return Response.json({ ...row, run_id: effectiveRunId });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}


// ═══════════════════════════════════════════════════════
// POST: Run one assessment (v7 pipeline)
// ═══════════════════════════════════════════════════════

export async function POST(req) {
  try {
    const body = await req.json();
    const { map_run_id, facility_id, label } = body;
    let runId = map_run_id;

    // Create a new run record if no run_id provided
    if (!runId) {
      runId = ulid('run');
      await db.execute(sql`
        INSERT INTO map_runs (id, org_id, state, scope, label, status, model_id, prompt_version, started_at)
        VALUES (${runId}, 'ars', 'FL', 'baseline', ${label || 'FL v2 — prompt v7'}, 'running',
                ${MODEL_ID}, ${PROMPT_VERSIONS.ASSESS_COVERAGE}, NOW())
        ON CONFLICT (id) DO NOTHING
      `);
    }

    // Find next unassessed obligation FOR THIS RUN
    const nextResult = await db.execute(sql`
      SELECT id FROM obligations
      WHERE id NOT IN (SELECT obligation_id FROM coverage_assessments WHERE map_run_id = ${runId})
      ORDER BY reg_source_id, citation
      LIMIT 1
    `);
    const nextRow = (nextResult.rows || nextResult)[0];

    if (!nextRow) {
      // Run complete
      await db.execute(sql`
        UPDATE map_runs SET
          status = 'completed',
          completed_at = NOW(),
          total_obligations = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId}),
          covered = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'COVERED'),
          partial = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'PARTIAL'),
          gaps = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'GAP'),
          not_applicable = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'NOT_APPLICABLE'),
          needs_legal_review = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'NEEDS_LEGAL_REVIEW')
        WHERE id = ${runId}
      `);
      return Response.json({ ok: true, done: true, message: 'All obligations assessed', map_run_id: runId });
    }

    // Load obligation with source name and loc_applicability
    const [obl] = await db.select().from(obligations).where(eq(obligations.id, nextRow.id));
    const sourceResult = await db.execute(sql`SELECT name FROM reg_sources WHERE id = ${obl.reg_source_id}`);
    obl.source_name = (sourceResult.rows || sourceResult)?.[0]?.name || null;

    // Load facility profile
    let facility = null;
    if (facility_id) {
      const [f] = await db.select().from(facilityProfiles).where(eq(facilityProfiles.id, facility_id));
      facility = f || null;
    }
    if (!facility) {
      const fResult = await db.execute(sql`
        SELECT * FROM facility_profiles WHERE state = 'FL' ORDER BY name LIMIT 1
      `);
      facility = (fResult.rows || fResult)?.[0] || null;
    }

    // Load matching data
    const allPolicies = await db.select().from(policies);
    const allProvisions = await db.select().from(provisions);
    const allLabels = await db.select().from(subDomainLabels);

    const provsByPolicy = {};
    for (const prov of allProvisions) {
      if (!provsByPolicy[prov.policy_id]) provsByPolicy[prov.policy_id] = [];
      provsByPolicy[prov.policy_id].push(prov);
    }

    // Run hybrid matching
    const candidates = await findCandidatesHybrid(obl, allPolicies, allProvisions, allLabels);

    if (candidates.length === 0) {
      const assessId = ulid('ca');
      await db.insert(coverageAssessments).values({
        id: assessId, org_id: ORG_ID, facility_id: facility?.id || null,
        obligation_id: obl.id, policy_id: null, provision_id: null,
        status: 'GAP', confidence: 'high',
        gap_detail: 'No candidate policies found by matching algorithm',
        match_method: 'none', match_score: 0,
        map_run_id: runId, assessed_by: 'algorithm',
        model_id: MODEL_ID, prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
      });

      const remaining = await db.execute(sql`
        SELECT count(*) as c FROM obligations WHERE id NOT IN (SELECT obligation_id FROM coverage_assessments WHERE map_run_id = ${runId})
      `);
      const left = Number((remaining.rows || remaining)[0].c);

      return Response.json({
        ok: true, done: left === 0,
        obligation_id: obl.id, citation: obl.citation,
        status: 'GAP', confidence: 'high', candidates: 0,
        remaining: left, map_run_id: runId,
      });
    }

    // Build candidate context with provision capping (hot-fix 2a)
    let candidateContext = candidates.map(c => ({
      policy_number: c.policy_number, title: c.title, score: c.score,
      policy_id: c.policy_id,
      provisions: (provsByPolicy[c.policy_id] || []),
    }));

    candidateContext = capProvisions(candidateContext, obl, provsByPolicy);

    // Collect all provision texts for validation
    const allProvisionTexts = candidateContext.flatMap(c =>
      (c.provisions || []).map(p => p.text)
    );

    // ── LLM assessment with v7 prompt + validation + retry ──
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let assessment = null;
    let lastError = null;
    let validationWarnings = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        let promptContent = ASSESS_PROMPT(obl, candidateContext, facility);

        // On retry, prepend corrective instruction
        if (attempt > 0 && lastError) {
          promptContent = `IMPORTANT: Your previous response was rejected. ${lastError}\n\n${promptContent}`;
        }

        const message = await client.messages.create({
          model: MODEL_ID,
          max_tokens: 1024,
          messages: [{ role: 'user', content: promptContent }],
        });

        const parsed = parseJSON(message.content[0].text);
        const { valid, errors, warnings, parsed: validated } = validateV7Assessment(
          parsed, candidateContext, obl, facility, allProvisionTexts
        );
        validationWarnings = warnings;

        // Handle forced status (admin/process stopgap)
        if (validated._force_status) {
          validated.status = validated._force_status;
          validated.gap_detail = validated._force_gap_detail || validated.gap_detail;
          validated.recommended_policy = validated._force_recommended_policy ?? validated.recommended_policy;
          validated.trigger_span = null;
          validated.inapplicability_reason = null;
          assessment = validated;
          break;
        }

        if (!valid && attempt < MAX_RETRIES) {
          lastError = validated._retry_instruction || errors.join('; ');
          continue;
        }

        // Final attempt: fall back gracefully
        if (!valid && attempt === MAX_RETRIES) {
          if (!VALID_STATUSES.includes(validated.status)) {
            validated.status = 'GAP';
            validated.confidence = 'low';
            validated.gap_detail = `Validation failed after retries: ${errors.join('; ')}`;
          } else if (validated.status === 'NOT_APPLICABLE') {
            validated.status = 'GAP';
            validated.confidence = 'low';
            validated.gap_detail = `NOT_APPLICABLE rejected (validation failed): ${errors.join('; ')}`;
            validated.trigger_span = null;
            validated.inapplicability_reason = null;
          } else if (validated.status === 'CONFLICTING') {
            validated.status = 'PARTIAL';
            validated.confidence = 'low';
            validated.gap_detail = validated.gap_detail || `CONFLICTING downgraded (validation failed): ${errors.join('; ')}`;
            validated.conflict_detail = null;
          }
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

    // Escalation for high-risk low-confidence
    if (assessment.confidence === 'low' && isHighRiskObligation(obl) && assessment.status !== 'COVERED') {
      finalStatus = 'NEEDS_LEGAL_REVIEW';
    }

    // Hot-fix 3b: Flag high-similarity GAP for human review
    let reviewFlag = null;
    if (finalStatus === 'GAP' && candidates.length > 0) {
      const topScore = candidates[0].score;
      const topMethod = candidates[0].methods?.[0]?.method;
      if (topScore > 60 || topMethod === 'citation_exact') {
        reviewFlag = 'high_similarity_gap';
      }
    }

    // ── Persist assessment ──
    const assessId = ulid('ca');
    await db.insert(coverageAssessments).values({
      id: assessId, org_id: ORG_ID, facility_id: facility?.id || null,
      obligation_id: obl.id, policy_id: matchedPolicyId, provision_id: null,
      status: finalStatus, confidence: assessment.confidence || 'medium',
      gap_detail: assessment.gap_detail || null,
      recommended_policy: assessment.recommended_policy || null,
      obligation_span: assessment.obligation_span || null,
      provision_span: assessment.provision_span || null,
      reasoning: assessment.reasoning || null,
      covering_policy_number: assessment.covering_policy_number || null,
      trigger_span: assessment.trigger_span || null,
      inapplicability_reason: assessment.inapplicability_reason || null,
      conflict_detail: assessment.conflict_detail || null,
      reviewed_provision_refs: assessment.reviewed_provision_refs || null,
      match_method: matchMethod, match_score: matchScore,
      vector_score: vectorScore,
      map_run_id: runId, assessed_by: 'llm',
      model_id: MODEL_ID, prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
      review_notes: reviewFlag ? `[auto] ${reviewFlag}` : null,
    });

    await logAuditEvent({
      event_type: 'assessment', entity_type: 'coverage_assessment', entity_id: assessId,
      actor: 'llm', model_id: MODEL_ID, prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
      input_summary: `${obl.citation} | ${candidates.length} cands | ${allProvisionTexts.length} provs`,
      output_summary: `${finalStatus} (${assessment.confidence}) → ${assessment.covering_policy_number || 'none'}${reviewFlag ? ` [${reviewFlag}]` : ''}`,
      metadata: {
        validation_warnings: validationWarnings.length > 0 ? validationWarnings : undefined,
        provision_cap_applied: candidateContext.some(c => (provsByPolicy[c.policy_id]?.length || 0) > c.provisions.length),
      },
    });

    const remaining = await db.execute(sql`
      SELECT count(*) as c FROM obligations WHERE id NOT IN (SELECT obligation_id FROM coverage_assessments WHERE map_run_id = ${runId})
    `);
    const left = Number((remaining.rows || remaining)[0].c);

    return Response.json({
      ok: true, done: left === 0,
      obligation_id: obl.id, citation: obl.citation,
      status: finalStatus, confidence: assessment.confidence,
      covering_policy: assessment.covering_policy_number,
      candidates: candidates.length,
      provisions_shown: allProvisionTexts.length,
      remaining: left, map_run_id: runId,
      review_flag: reviewFlag,
    });

  } catch (err) {
    console.error('Assess error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
