import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { obligations, coverageAssessments, facilityProfiles } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { findCandidatesHybrid, HIGH_RISK_TOPICS } from '@/lib/matching';
import { ASSESS_PROMPT } from '@/lib/prompts';
import {
  buildFacilityContextString,
  canonicalize,
  extractLocKeywords,
  findTriggerFamily,
  reasonSupportsFamily,
  BOILERPLATE_BLACKLIST,
} from '@/lib/facility-attributes';
import { logAuditEvent, PROMPT_VERSIONS, MODEL_ID } from '@/lib/audit';
import { ulid } from '@/lib/ulid';
import { parseJSON } from '@/lib/parse';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ORG_ID = 'ars';
const MAX_RETRIES = 2;
const VALID_STATUSES = ['COVERED', 'PARTIAL', 'GAP', 'CONFLICTING', 'NOT_APPLICABLE', 'REVIEW_NEEDED'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];

// ── Conditional language patterns suggesting obligation may be N/A ──
const CONDITIONAL_OBLIGATION_PATTERNS = /\b(if the (facility|program|provider)|for (facilities|programs|providers) (that|which|who)|when (providing|operating|offering)|facilities (with|operating|that)|only applicable (to|for|if|when)|does not apply (to|if|when|unless)|limited to facilities)\b/i;

// ── Provision capping constants ──
const MAX_PROVISIONS_PER_POLICY = 8;
const MAX_TOTAL_PROVISIONS = 96;
const MIN_PROVISIONS_PER_POLICY = 4;
const MAX_CITATION_PINNED_PER_POLICY = 2;

// ── N/A validation: admin/process markers (not attribute-dependent) ──
const ADMIN_MARKERS = [
  /submit.*report/i,
  /\bESC\b/i,
  /accreditation committee/i,
  /survey submission/i,
  /submission to the joint commission/i,
  /accreditation.*process/i,
];

const SHORT_LOC_TRIGGER_ALLOWLIST = new Set(['op', 'php', 'iop']);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractAllTriggerLocs(triggerSpan, locApplicability) {
  const fromTrigger = extractLocKeywords(triggerSpan || '');

  const locValues = Array.isArray(locApplicability)
    ? locApplicability
    : (locApplicability ? [locApplicability] : []);

  const fromApplicability = locValues.flatMap(v => extractLocKeywords(String(v)));

  return unique([...fromTrigger, ...fromApplicability]);
}

function extractFacilityLocs(facility) {
  const facilityLocs = Array.isArray(facility?.levels_of_care)
    ? facility.levels_of_care
    : [];

  return unique(facilityLocs.flatMap(v => extractLocKeywords(String(v))));
}

const LEXICAL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'shall', 'must', 'will',
  'may', 'can', 'could', 'should', 'would', 'into', 'onto', 'upon', 'such', 'each', 'every', 'any',
  'all', 'both', 'either', 'neither', 'where', 'when', 'while', 'within', 'under', 'over', 'after',
  'before', 'during', 'through', 'including', 'include', 'includes', 'provided', 'provide',
  'provides', 'policy', 'procedure', 'procedures', 'organization', 'facility', 'program',
  'provider', 'individual', 'individuals', 'staff', 'patient', 'patients', 'client', 'clients',
  'services', 'service', 'care', 'treatment', 'documentation', 'document', 'records', 'record',
  'required', 'requirement', 'requirements', 'applicable', 'compliance', 'regulation',
  'regulations', 'standard', 'standards', 'section', 'sections', 'chapter', 'chapters',
]);

function lexicalTokens(text = '') {
  return [...new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s\-\/]/g, ' ')
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !LEXICAL_STOPWORDS.has(t)),
  )];
}

function lexicalOverlapScore(requirementText = '', provisionText = '') {
  const reqTokens = lexicalTokens(requirementText);
  if (reqTokens.length === 0) return 0;

  const provTokens = new Set(lexicalTokens(provisionText));
  let hits = 0;
  let strongHits = 0;

  for (const token of reqTokens) {
    if (provTokens.has(token)) {
      hits++;
      if (token.length >= 8) strongHits++;
    }
  }

  return (hits * 2) + strongHits + (hits / reqTokens.length);
}

// ═══════════════════════════════════════════════════════
// Provision capping with citation-pinned bypass + dual-rank retention
// ═══════════════════════════════════════════════════════

function capProvisions(candidateContext, obligation, provsByPolicy, provisionSimilarityMap, provisionKeywordOverlapMap) {
  const oblCitation = (obligation.citation || '').toLowerCase().trim();
  const requirementText = obligation.requirement || '';
  const simMap = provisionSimilarityMap || {};
  const keywordMap = provisionKeywordOverlapMap || {};

  // Dedup provisions across policies by normalized text, keeping the strongest global copy.
  const globalTextSeen = new Map(); // normalized text -> { policy_id, prov_id, composite }

  for (const candidate of candidateContext) {
    const allProvs = provsByPolicy[candidate.policy_id] || [];
    for (const prov of allProvs) {
      const normText = String(prov.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const sim = Number(simMap[prov.id] || 0);
      const kw = keywordMap[prov.id] != null
        ? Number(keywordMap[prov.id])
        : lexicalOverlapScore(requirementText, prov.text || '');

      const composite = Math.max(sim, kw) + ((sim + kw) * 0.25);

      const existing = globalTextSeen.get(normText);
      if (!existing || composite > existing.composite) {
        globalTextSeen.set(normText, {
          policy_id: candidate.policy_id,
          prov_id: prov.id,
          composite,
        });
      }
    }
  }

  const dedupWinners = new Set(Array.from(globalTextSeen.values()).map(v => v.prov_id));

  for (const candidate of candidateContext) {
    const allProvs = (provsByPolicy[candidate.policy_id] || []).filter(p => dedupWinners.has(p.id));

    if (allProvs.length <= MIN_PROVISIONS_PER_POLICY) {
      candidate.provisions = allProvs.map(p => {
        const sim = Number(simMap[p.id] || 0);
        const kw = keywordMap[p.id] != null
          ? Number(keywordMap[p.id])
          : lexicalOverlapScore(requirementText, p.text || '');

        return {
          ...p,
          _sim: sim,
          _kw: kw,
          _pinned: false,
          _composite: Math.max(sim, kw) + ((sim + kw) * 0.25),
        };
      });
      continue;
    }

    const citationPinned = [];
    const unpinned = [];

    for (const prov of allProvs) {
      const provCitation = (prov.source_citation || '').toLowerCase().trim();
      const sim = Number(simMap[prov.id] || 0);
      const kw = keywordMap[prov.id] != null
        ? Number(keywordMap[prov.id])
        : lexicalOverlapScore(requirementText, prov.text || '');

      const enriched = {
        ...prov,
        _sim: sim,
        _kw: kw,
        _pinned: false,
        _composite: Math.max(sim, kw) + ((sim + kw) * 0.25),
      };

      if (provCitation && oblCitation && provCitation.includes(oblCitation)) {
        enriched._pinned = true;
        citationPinned.push(enriched);
      } else {
        unpinned.push(enriched);
      }
    }

    citationPinned.sort((a, b) => b._composite - a._composite);
    const pinnedToUse = citationPinned.slice(0, MAX_CITATION_PINNED_PER_POLICY);

    const slots = Math.max(MAX_PROVISIONS_PER_POLICY - pinnedToUse.length, 0);
    const bySemantic = [...unpinned].sort((a, b) => b._sim - a._sim || b._kw - a._kw);
    const byKeyword = [...unpinned].sort((a, b) => b._kw - a._kw || b._sim - a._sim);

    const selected = [];
    const selectedIds = new Set();

    function takeFrom(list, maxToTake) {
      let taken = 0;
      for (const prov of list) {
        if (selected.length >= slots || taken >= maxToTake) break;
        if (selectedIds.has(prov.id)) continue;
        selected.push(prov);
        selectedIds.add(prov.id);
        taken++;
      }
    }

    const semanticReserve = Math.ceil(slots / 2);
    const keywordReserve = Math.floor(slots / 2);

    takeFrom(bySemantic, semanticReserve);
    takeFrom(byKeyword, keywordReserve);
    takeFrom(bySemantic, Math.max(0, slots - selected.length));

    selected.sort((a, b) => b._composite - a._composite);
    candidate.provisions = [...pinnedToUse, ...selected];
  }

  // Global cap: trim the weakest removable provision across all candidates.
  let total = candidateContext.reduce((sum, c) => sum + (c.provisions?.length || 0), 0);

  while (total > MAX_TOTAL_PROVISIONS) {
    let worstCandidateIdx = -1;
    let worstProvisionIdx = -1;
    let worstScore = Infinity;

    for (let i = 0; i < candidateContext.length; i++) {
      const provs = candidateContext[i].provisions || [];
      if (provs.length <= MIN_PROVISIONS_PER_POLICY) continue;

      for (let j = 0; j < provs.length; j++) {
        const prov = provs[j];
        if (prov._pinned) continue;

        const composite = prov._composite != null
          ? prov._composite
          : (
              Math.max(Number(prov._sim || 0), Number(prov._kw || 0)) +
              ((Number(prov._sim || 0) + Number(prov._kw || 0)) * 0.25)
            );

        if (composite < worstScore) {
          worstScore = composite;
          worstCandidateIdx = i;
          worstProvisionIdx = j;
        }
      }
    }

    if (worstCandidateIdx === -1) break;

    candidateContext[worstCandidateIdx].provisions.splice(worstProvisionIdx, 1);
    total--;
  }

  return candidateContext;
}

// ═══════════════════════════════════════════════════════
// Server-side v8 validation
// ═══════════════════════════════════════════════════════

function validateAssessment(parsed, candidatePolicies, obligation, facility, allProvisionTexts) {
  const errors = [];
  const warnings = [];

  if (!VALID_STATUSES.includes(parsed.status)) {
    errors.push(`Invalid status: ${parsed.status}`);
  }
  if (!parsed.confidence || !VALID_CONFIDENCE.includes(parsed.confidence)) {
    parsed.confidence = 'medium';
  }

  if (parsed.covering_policy_number) {
    const num = parsed.covering_policy_number;
    if (/^\d+$/.test(String(num))) {
      const idx = parseInt(num, 10) - 1;
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

  if (parsed.status === 'GAP' || parsed.status === 'NOT_APPLICABLE') {
    parsed.covering_policy_number = null;
  }

  const candidatePolicyNumbers = new Set(candidatePolicies.map(c => c.policy_number));
  const requirementText = obligation.requirement || '';
  const citationText = obligation.citation || '';
  const locLine = obligation.loc_applicability
    ? (Array.isArray(obligation.loc_applicability) ? obligation.loc_applicability.join(', ') : String(obligation.loc_applicability))
    : '';

  const facilityContextBlock = buildFacilityContextString(facility);
  const allProvTexts = allProvisionTexts || [];

  const canonicalRequirementText = canonicalize(requirementText);
  const canonicalCitationText = canonicalize(citationText);
  const canonicalLocLine = canonicalize(locLine);
  const canonicalFacilityContextBlock = canonicalize(facilityContextBlock);
  const canonicalAllProvTexts = allProvTexts.map(t => canonicalize(t));

  if (parsed.status === 'NOT_APPLICABLE') {
    if (ADMIN_MARKERS.some(rx => rx.test(requirementText))) {
      errors.push('NOT_APPLICABLE rejected: administrative/accreditation process item');
      parsed._force_status = 'GAP';
      parsed._force_gap_detail = 'Administrative/accreditation process item — should be excluded upstream.';
      parsed._force_recommended_policy = null;
      return { valid: false, errors, warnings, parsed };
    }

    if (!parsed.trigger_span) {
      errors.push('NOT_APPLICABLE requires trigger_span');
    }
    if (!parsed.inapplicability_reason) {
      errors.push('NOT_APPLICABLE requires inapplicability_reason');
    }

    if (parsed.trigger_span && parsed.inapplicability_reason) {
      if (BOILERPLATE_BLACKLIST.has(parsed.inapplicability_reason.trim())) {
        errors.push(`inapplicability_reason is boilerplate: "${parsed.inapplicability_reason}"`);
      }

      const canonicalTriggerSpan = canonicalize(parsed.trigger_span);
      const canonicalReason = canonicalize(parsed.inapplicability_reason);

      const triggerInReq = canonicalRequirementText.includes(canonicalTriggerSpan);
      const triggerInCit = canonicalCitationText.includes(canonicalTriggerSpan);
      const triggerInLoc = canonicalLocLine.includes(canonicalTriggerSpan);

      if (!triggerInReq && !triggerInCit && !triggerInLoc) {
        errors.push('trigger_span not found as substring of Requirement, Citation, or LOC Applicability');
      }

      const reasonInFacility = canonicalFacilityContextBlock.includes(canonicalReason);
      const reasonInProvision = canonicalAllProvTexts.some(t => t.includes(canonicalReason));

      if (!reasonInFacility && !reasonInProvision) {
        errors.push('inapplicability_reason not found as substring of facility context or any provision');
      }

      const matchedShortLocs = extractLocKeywords(parsed.trigger_span || '');
      const shortLocTriggerAllowed =
        matchedShortLocs.length > 0 &&
        matchedShortLocs.every(k => SHORT_LOC_TRIGGER_ALLOWLIST.has(k));

      if (canonicalTriggerSpan.length < 8 && !shortLocTriggerAllowed) {
        errors.push(`trigger_span too short (${parsed.trigger_span.length} chars, need >= 8 unless it is a known short LOC token)`);
      }

      const triggerLocTokens = extractLocKeywords(parsed.trigger_span || '');
      const applicabilityLocTokens = extractLocKeywords(locLine || '');
      const triggerHasLOC = triggerLocTokens.length > 0 || applicabilityLocTokens.length > 0 || triggerInLoc;

      if (triggerHasLOC) {
        const facilityLOCs = extractFacilityLocs(facility);
        const allTriggerLOCs = extractAllTriggerLocs(parsed.trigger_span, obligation.loc_applicability);

        const facilityHasLOC = allTriggerLOCs.some(t => facilityLOCs.includes(t));
        if (facilityHasLOC) {
          errors.push(`LOC-based N/A rejected: facility offers LOC (trigger: ${allTriggerLOCs.join(', ')}, facility: ${facilityLOCs.join(', ')})`);
        }
      } else {
        const match = findTriggerFamily(parsed.trigger_span);

        if (match) {
          if (!reasonSupportsFamily(parsed.inapplicability_reason, match.def)) {
            errors.push(`Activity N/A: inapplicability_reason does not support ${match.key} family (${match.def.trigger_family.join(', ')})`);
          }
        } else {
          errors.push('NOT_APPLICABLE rejected: trigger does not match known LOC or any registered attribute family');
        }
      }
    }

    if (errors.length > 0) {
      parsed._retry_instruction = 'NOT_APPLICABLE rejected: invalid evidence. Reassess as COVERED/PARTIAL/GAP.';
    }
  }

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
    if (parsed.provision_span && !allProvTexts.some(t => t.includes(parsed.provision_span))) {
      errors.push('provision_span not found as substring of any presented provision');
    }
  }

  if (parsed.status === 'COVERED' || parsed.status === 'PARTIAL') {
    if (!parsed.covering_policy_number) {
      if (candidatePolicies.length > 0) {
        errors.push(`${parsed.status} requires covering_policy_number`);
      }
    } else if (!candidatePolicyNumbers.has(parsed.covering_policy_number)) {
      errors.push(`covering_policy_number "${parsed.covering_policy_number}" not in candidates`);
    }

    if (!parsed.obligation_span) {
      errors.push(`${parsed.status} requires obligation_span`);
    } else if (!requirementText.includes(parsed.obligation_span)) {
      errors.push('obligation_span not exact substring of Requirement');
    }

    if (!parsed.provision_span) {
      errors.push(`${parsed.status} requires provision_span`);
    } else if (!allProvTexts.some(t => t.includes(parsed.provision_span))) {
      errors.push('provision_span not exact substring of any presented provision');
    }

    const refs = parsed.reviewed_provision_refs;
    const totalProvisions = candidatePolicies.reduce((sum, c) => sum + (c.provisions?.length || 0), 0);
    const minRefs = parsed.status === 'COVERED' ? 1 : Math.min(2, totalProvisions);

    if (!Array.isArray(refs) || refs.length < minRefs) {
      errors.push(`reviewed_provision_refs required: need >= ${minRefs} entries, got ${Array.isArray(refs) ? refs.length : 0}`);
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

  if (parsed.status === 'CONFLICTING') {
    const refs = parsed.reviewed_provision_refs;
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
        SELECT id
        FROM map_runs
        ORDER BY (status = 'completed') DESC, started_at DESC
        LIMIT 1
      `);
      effectiveRunId = (latest.rows || latest)?.[0]?.id || null;
    }

    const runCondition = effectiveRunId
      ? sql`map_run_id = ${effectiveRunId}`
      : sql`TRUE`;

    const result = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM obligations) as total_obligations,
        (SELECT count(DISTINCT obligation_id) FROM coverage_assessments WHERE ${runCondition}) as assessed,
        (SELECT count(*) FROM obligations WHERE id NOT IN (
          SELECT obligation_id FROM coverage_assessments WHERE ${runCondition}
        )) as unassessed,
        (SELECT count(*) FROM coverage_assessments WHERE ${runCondition} AND COALESCE(human_status, status) = 'COVERED') as covered,
        (SELECT count(*) FROM coverage_assessments WHERE ${runCondition} AND COALESCE(human_status, status) = 'PARTIAL') as partial,
        (SELECT count(*) FROM coverage_assessments WHERE ${runCondition} AND COALESCE(human_status, status) = 'GAP') as gap,
        (SELECT count(*) FROM coverage_assessments WHERE ${runCondition} AND COALESCE(human_status, status) = 'CONFLICTING') as conflicting,
        (SELECT count(*) FROM coverage_assessments WHERE ${runCondition} AND COALESCE(human_status, status) = 'NOT_APPLICABLE') as not_applicable,
        (SELECT count(*) FROM coverage_assessments WHERE ${runCondition} AND COALESCE(human_status, status) = 'NEEDS_LEGAL_REVIEW') as needs_review,
        (SELECT count(*) FROM coverage_assessments WHERE ${runCondition} AND COALESCE(human_status, status) = 'REVIEW_NEEDED') as review_needed
    `);

    const row = (result.rows || result)[0];
    return Response.json({ ...row, run_id: effectiveRunId });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════
// POST: Run one assessment (v8 pipeline)
// ═══════════════════════════════════════════════════════

export async function POST(req) {
  try {
    const body = await req.json();
    const { map_run_id, facility_id: requestedFacilityId, label, state: runState, scope: runScope, reg_source_ids } = body;
    let runId = map_run_id;
    let runRecord = null;

    let scopedSourceIds = reg_source_ids || null;

    if (runId) {
      const runRecordResult = await db.execute(sql`
        SELECT id, state, facility_id, reg_sources_used
        FROM map_runs
        WHERE id = ${runId}
        LIMIT 1
      `);
      runRecord = (runRecordResult.rows || runRecordResult)[0] || null;

      if (!runRecord) {
        return Response.json({ error: `map_run_id not found: ${runId}` }, { status: 404 });
      }

      if (requestedFacilityId && runRecord.facility_id && requestedFacilityId !== runRecord.facility_id) {
        return Response.json(
          { error: 'facility_id does not match the existing run facility' },
          { status: 400 },
        );
      }

      if (!scopedSourceIds && runRecord.reg_sources_used) {
        scopedSourceIds = runRecord.reg_sources_used;
      }
    }

    const effectiveFacilityId = requestedFacilityId || runRecord?.facility_id || null;
    if (!effectiveFacilityId) {
      return Response.json(
        { error: 'facility_id is required when starting or resuming an assessment run' },
        { status: 400 },
      );
    }

    const [facilityRecord] = await db
      .select()
      .from(facilityProfiles)
      .where(eq(facilityProfiles.id, effectiveFacilityId));

    if (!facilityRecord) {
      return Response.json({ error: `Invalid facility_id: ${effectiveFacilityId}` }, { status: 400 });
    }

    const effectiveRunState = runRecord?.state || runState || facilityRecord.state || 'FL';

    if (!runId) {
      runId = ulid('run');
      await db.execute(sql`
        INSERT INTO map_runs (id, org_id, facility_id, state, scope, label, status, model_id, prompt_version, reg_sources_used, started_at)
        VALUES (
          ${runId},
          'ars',
          ${effectiveFacilityId},
          ${effectiveRunState},
          ${runScope || 'baseline'},
          ${label || `${effectiveRunState} — prompt v8`},
          'running',
          ${MODEL_ID},
          ${PROMPT_VERSIONS.ASSESS_COVERAGE},
          ${scopedSourceIds ? JSON.stringify(scopedSourceIds) : null},
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `);
    } else if (!runRecord?.facility_id && requestedFacilityId) {
      await db.execute(sql`
        UPDATE map_runs
        SET facility_id = ${effectiveFacilityId}
        WHERE id = ${runId}
      `);
    }

    const sourceFilter = scopedSourceIds?.length
      ? sql`AND reg_source_id IN (${sql.join(scopedSourceIds.map(id => sql`${id}`), sql`, `)})`
      : sql``;

    const nextResult = await db.execute(sql`
      SELECT id
      FROM obligations
      WHERE id NOT IN (
        SELECT obligation_id FROM coverage_assessments WHERE map_run_id = ${runId}
      )
        AND (exclude_from_assessment IS NULL OR exclude_from_assessment = false)
        ${sourceFilter}
      ORDER BY reg_source_id, citation
      LIMIT 1
    `);
    const nextRow = (nextResult.rows || nextResult)[0];

    if (!nextRow) {
      await db.execute(sql`
        UPDATE map_runs
        SET
          status = 'completed',
          completed_at = NOW(),
          total_obligations = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId}),
          covered = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'COVERED'),
          partial = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'PARTIAL'),
          gaps = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'GAP'),
          not_applicable = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) = 'NOT_APPLICABLE'),
          needs_legal_review = (SELECT count(*) FROM coverage_assessments WHERE map_run_id = ${runId} AND COALESCE(human_status, status) IN ('NEEDS_LEGAL_REVIEW', 'REVIEW_NEEDED'))
        WHERE id = ${runId}
      `);

      return Response.json({ ok: true, done: true, message: 'All obligations assessed', map_run_id: runId });
    }

    const [obl] = await db.select().from(obligations).where(eq(obligations.id, nextRow.id));
    const sourceResult = await db.execute(sql`SELECT name FROM reg_sources WHERE id = ${obl.reg_source_id}`);
    obl.source_name = (sourceResult.rows || sourceResult)?.[0]?.name || null;

    let facility = facilityRecord;

    if (facility) {
      const attrs = facility.attributes || {};
      if (attrs.prohibits_restraint === undefined && facility.prohibits_restraint !== undefined) {
        attrs.prohibits_restraint = facility.prohibits_restraint;
      }
      if (attrs.operates_otp === undefined && facility.operates_otp !== undefined) {
        attrs.operates_otp = facility.operates_otp;
      }
      if (attrs.smoking_in_buildings === undefined && facility.smoking_in_buildings_allowed !== undefined) {
        attrs.smoking_in_buildings = facility.smoking_in_buildings_allowed;
      }
      if (attrs.patient_work_program === undefined && facility.allows_patient_work_program !== undefined) {
        attrs.patient_work_program = facility.allows_patient_work_program;
      }
      facility.attributes = attrs;
    }

    const {
      candidates,
      provisionsByPolicy,
      provisionSimilarityMap,
      provisionKeywordOverlapMap,
    } = await findCandidatesHybrid(obl);

    if (candidates.length === 0) {
      const assessId = ulid('ca');
      await db.insert(coverageAssessments).values({
        id: assessId,
        org_id: ORG_ID,
        facility_id: facility?.id || null,
        obligation_id: obl.id,
        policy_id: null,
        provision_id: null,
        status: 'GAP',
        confidence: 'high',
        gap_detail: 'No candidate policies found by matching algorithm',
        match_method: 'none',
        match_score: 0,
        map_run_id: runId,
        assessed_by: 'algorithm',
        model_id: MODEL_ID,
        prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
      });

      const remaining = await db.execute(sql`
        SELECT count(*) as c
        FROM obligations
        WHERE id NOT IN (
          SELECT obligation_id FROM coverage_assessments WHERE map_run_id = ${runId}
        )
          AND (exclude_from_assessment IS NULL OR exclude_from_assessment = false)
          ${sourceFilter}
      `);
      const left = Number((remaining.rows || remaining)[0].c);

      return Response.json({
        ok: true,
        done: left === 0,
        obligation_id: obl.id,
        citation: obl.citation,
        status: 'GAP',
        confidence: 'high',
        candidates: 0,
        remaining: left,
        map_run_id: runId,
      });
    }

    let candidateContext = candidates.map(c => ({
      policy_number: c.policy_number,
      title: c.title,
      score: c.score,
      policy_id: c.policy_id,
      provisions: (provisionsByPolicy[c.policy_id] || []),
    }));

    candidateContext = capProvisions(
      candidateContext,
      obl,
      provisionsByPolicy,
      provisionSimilarityMap,
      provisionKeywordOverlapMap,
    );

    const allProvisionTexts = candidateContext.flatMap(c =>
      (c.provisions || []).map(p => p.text),
    );

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let assessment = null;
    let lastError = null;
    let validationWarnings = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        let promptContent = ASSESS_PROMPT(obl, candidateContext, facility);

        if (attempt > 0 && lastError) {
          promptContent = `IMPORTANT: Your previous response was rejected. ${lastError}\n\n${promptContent}`;
        }

        const message = await client.messages.create({
          model: MODEL_ID,
          max_tokens: 1536,
          messages: [{ role: 'user', content: promptContent }],
        });

        const parsed = parseJSON(message.content[0].text);
        const { valid, errors, warnings, parsed: validated } = validateAssessment(
          parsed,
          candidateContext,
          obl,
          facility,
          allProvisionTexts,
        );
        validationWarnings = warnings;

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

        if (!valid && attempt === MAX_RETRIES) {
          if (!VALID_STATUSES.includes(validated.status)) {
            validated.status = 'GAP';
            validated.confidence = 'low';
            validated.gap_detail = `Validation failed after retries: ${errors.join('; ')}`;
          } else if (validated.status === 'NOT_APPLICABLE') {
            const oblText = `${obl.requirement || ''} ${obl.citation || ''}`;
            if (CONDITIONAL_OBLIGATION_PATTERNS.test(oblText)) {
              validated.status = 'REVIEW_NEEDED';
              validated.confidence = 'low';
              validated.gap_detail = `N/A validation failed but obligation appears conditional: ${errors.join('; ')}`;
              validated.review_notes = `SUSPECTED_NA — model reason: ${validated.inapplicability_reason || 'none'}`;
            } else {
              validated.status = 'GAP';
              validated.confidence = 'low';
              validated.gap_detail = `NOT_APPLICABLE rejected (validation failed): ${errors.join('; ')}`;
            }
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
        status: 'GAP',
        confidence: 'low',
        covering_policy_number: null,
        gap_detail: `Assessment failed: ${lastError}`,
        reasoning: 'Error during assessment',
      };
    }

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

    if (assessment.confidence === 'low' && isHighRiskObligation(obl) && assessment.status !== 'COVERED') {
      finalStatus = 'NEEDS_LEGAL_REVIEW';
    }

    let reviewFlag = null;
    if (finalStatus === 'GAP' && candidates.length > 0) {
      const topScore = candidates[0].score;
      const topMethod = candidates[0].methods?.[0]?.method;
      if (topScore > 60 || topMethod === 'citation_exact') {
        reviewFlag = 'high_similarity_gap';
      }
    }

    const assessId = ulid('ca');
    await db.insert(coverageAssessments).values({
      id: assessId,
      org_id: ORG_ID,
      facility_id: facility?.id || null,
      obligation_id: obl.id,
      policy_id: matchedPolicyId,
      provision_id: null,
      status: finalStatus,
      confidence: assessment.confidence || 'medium',
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
      match_method: matchMethod,
      match_score: matchScore,
      vector_score: vectorScore,
      map_run_id: runId,
      assessed_by: 'llm',
      model_id: MODEL_ID,
      prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
      review_notes: assessment.review_notes || (reviewFlag ? `[auto] ${reviewFlag}` : null),
    });

    await logAuditEvent({
      event_type: 'assessment',
      entity_type: 'coverage_assessment',
      entity_id: assessId,
      actor: 'llm',
      model_id: MODEL_ID,
      prompt_version: PROMPT_VERSIONS.ASSESS_COVERAGE,
      input_summary: `${obl.citation} | ${candidates.length} cands | ${allProvisionTexts.length} provs`,
      output_summary: `${finalStatus} (${assessment.confidence}) → ${assessment.covering_policy_number || 'none'}${reviewFlag ? ` [${reviewFlag}]` : ''}`,
      metadata: {
        validation_warnings: validationWarnings.length > 0 ? validationWarnings : undefined,
        provision_cap_applied: candidateContext.some(c => (provisionsByPolicy[c.policy_id]?.length || 0) > c.provisions.length),
      },
    });

    const remaining = await db.execute(sql`
      SELECT count(*) as c
      FROM obligations
      WHERE id NOT IN (
        SELECT obligation_id FROM coverage_assessments WHERE map_run_id = ${runId}
      )
        AND (exclude_from_assessment IS NULL OR exclude_from_assessment = false)
        ${sourceFilter}
    `);
    const left = Number((remaining.rows || remaining)[0].c);

    return Response.json({
      ok: true,
      done: left === 0,
      obligation_id: obl.id,
      citation: obl.citation,
      status: finalStatus,
      confidence: assessment.confidence,
      covering_policy: assessment.covering_policy_number,
      candidates: candidates.length,
      provisions_shown: allProvisionTexts.length,
      remaining: left,
      map_run_id: runId,
      review_flag: reviewFlag,
    });
  } catch (err) {
    console.error('Assess error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}