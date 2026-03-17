import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(repoRoot, 'artifacts');
const outputJsonPath = path.join(artifactsDir, 'gap_audit_sample.json');
const outputCsvPath = path.join(artifactsDir, 'gap_audit_sample.csv');

const CONCURRENCY = 4;
const TOP_CANDIDATE_COUNT = 5;
const BUCKET_SIZE = 20;

const REVIEW_COLUMNS = [
  'TRUE_GAP',
  'GAP_SHOULD_BE_PARTIAL',
  'GAP_SHOULD_BE_NOT_APPLICABLE',
  'EVIDENCE_PACKET_ISSUE',
  'AMBIGUOUS_STANDARD',
  'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY',
];

// Known from the March 11 briefing:
// - The controlling matcher/instrumentation is the version on origin/main, not the older local working tree.
// - GAP rows with policy_id IS NULL are LLM assessment outcomes, not proven retrieval failures.
//
// Inferred for this audit artifact:
// - "Higher-score" and "middle-score" are defined using the current baseline top candidate score.
// - "Conditional/admin/edge-case" is approximated with the same conditional/admin markers used in origin/main
//   plus a few structural signals that make manual review more delicate.
//
// Unresolved by design:
// - This script does not adjudicate whether any GAP is correct.
// - The edge-case heuristic is a sampling aid, not a claim that every flagged row is truly ambiguous.

const CONDITIONAL_OBLIGATION_PATTERNS = /\b(if the (facility|program|provider)|for (facilities|programs|providers) (that|which|who)|when (providing|operating|offering)|facilities (with|operating|that)|only applicable (to|for|if|when)|does not apply (to|if|when|unless)|limited to facilities)\b/i;

const ADMIN_MARKERS = [
  /submit.*report/i,
  /\bESC\b/,
  /accreditation committee/i,
  /survey submission/i,
  /submission to the joint commission/i,
  /accreditation.*process/i,
];

// Mirrored from origin/main:app/api/v6/assess/route.js so the packet summary reflects the evidence
// shown to the assessor, without modifying the production route itself.
const MAX_PROVISIONS_PER_POLICY = 8;
const MAX_TOTAL_PROVISIONS = 96;
const MIN_PROVISIONS_PER_POLICY = 4;
const MAX_CITATION_PINNED_PER_POLICY = 2;

await loadRepoEnv();

const [{ db, dbClient, sql }, { findCandidatesHybrid }] = await Promise.all([
  loadDbContext(),
  loadOriginMainMatchingModule(),
]);

function rowsOf(result) {
  return result?.rows || result || [];
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function trimSnippet(text, maxLength = 180) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter(Boolean))];
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function compareByCitation(a, b) {
  return String(a.citation || '').localeCompare(String(b.citation || ''));
}

function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function citationDepth(citation) {
  return (String(citation || '').match(/\(/g) || []).length;
}

function hasLocApplicability(row) {
  if (!row.loc_applicability) return false;
  if (Array.isArray(row.loc_applicability)) return row.loc_applicability.length > 0;
  return true;
}

function getEdgeSignals(row) {
  const signals = [];
  const combinedText = `${row.requirement || ''} ${row.citation || ''}`;

  if (CONDITIONAL_OBLIGATION_PATTERNS.test(combinedText)) {
    signals.push('conditional_language');
  }
  if (ADMIN_MARKERS.some(pattern => pattern.test(row.requirement || ''))) {
    signals.push('admin_process_marker');
  }
  if (hasLocApplicability(row)) {
    signals.push('loc_applicability_present');
  }
  if (citationDepth(row.citation) >= 2) {
    signals.push('deep_parenthetical_citation');
  }
  if (row.tjc_crosswalk && /\bEP\s+\d+\b/i.test(row.citation || '')) {
    signals.push('crosswalked_ep_citation');
  }

  return signals;
}

function edgePriority(signals) {
  let score = 0;
  if (signals.includes('conditional_language')) score += 4;
  if (signals.includes('admin_process_marker')) score += 4;
  if (signals.includes('loc_applicability_present')) score += 3;
  if (signals.includes('deep_parenthetical_citation')) score += 2;
  if (signals.includes('crosswalked_ep_citation')) score += 1;
  return score;
}

function topCandidateSummaryText(topCandidates) {
  return topCandidates
    .map((candidate, index) => {
      const breakdown = candidate.signal_breakdown || {};
      return `${index + 1}) ${candidate.policy_number || 'UNKNOWN'} [score=${candidate.score}; citation=${breakdown.citation || 0}; sub_domain=${breakdown.sub_domain || 0}; keyword=${breakdown.keyword || 0}; title=${breakdown.title || 0}; vector=${breakdown.vector || 0}; fts=${breakdown.fts || 0}]`;
    })
    .join(' ; ');
}

function summarizeProvisionPacket(candidateContext) {
  const totalProvisionsPresented = candidateContext.reduce(
    (sum, candidate) => sum + candidate.provisions.length,
    0
  );

  const topPolicyPackets = candidateContext.slice(0, 3).map(candidate => {
    const sections = uniqueNonEmpty(candidate.provisions.map(prov => prov.section)).slice(0, 4);
    const sourceCitations = uniqueNonEmpty(candidate.provisions.map(prov => prov.source_citation)).slice(0, 4);
    const snippets = candidate.provisions.slice(0, 2).map(prov => trimSnippet(prov.text, 200));

    return {
      policy_id: candidate.policy_id,
      policy_number: candidate.policy_number,
      title: candidate.title,
      score: candidate.score,
      provisions_presented: candidate.provisions.length,
      sections,
      source_citations: sourceCitations,
      snippets,
    };
  });

  return {
    candidate_policies_presented: candidateContext.length,
    total_provisions_presented: totalProvisionsPresented,
    top_policy_packets: topPolicyPackets,
  };
}

function packetSummaryText(packetSummary) {
  const packetParts = packetSummary.top_policy_packets.map(packet => {
    const sectionText = packet.sections.length > 0
      ? `sections=${packet.sections.join(' | ')}`
      : 'sections=none';
    return `${packet.policy_number || 'UNKNOWN'} (${packet.provisions_presented} provs; ${sectionText})`;
  });

  return `${packetSummary.candidate_policies_presented} candidate policies, ${packetSummary.total_provisions_presented} provisions; ${packetParts.join('; ')}`;
}

function buildObligation(row) {
  return {
    id: row.obligation_id,
    org_id: row.org_id,
    reg_source_id: row.reg_source_id,
    parent_id: row.parent_id,
    citation: row.citation,
    requirement: row.requirement,
    source_type: row.source_type,
    topics: row.topics,
    levels_of_care: row.levels_of_care,
    responsible_party: row.responsible_party,
    timeframe: row.timeframe,
    documentation_required: row.documentation_required,
    applicability: row.applicability,
    tjc_crosswalk: row.tjc_crosswalk,
    risk_tier: row.risk_tier,
    loc_applicability: row.loc_applicability,
    exclude_from_assessment: row.exclude_from_assessment,
    exclude_reason: row.exclude_reason,
    source_name: row.source_name,
  };
}

async function retryFindCandidates(obligation, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await findCandidatesHybrid(obligation);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 400 * attempt));
      }
    }
  }
  throw lastError;
}

function capProvisions(candidateContext, obligation, provsByPolicy, provisionSimilarityMap, provisionKeywordOverlapMap) {
  const oblCitation = (obligation.citation || '').toLowerCase().trim();
  const simMap = provisionSimilarityMap || {};
  const keywordMap = provisionKeywordOverlapMap || {};

  const globalTextSeen = new Map();
  for (const candidate of candidateContext) {
    const allProvs = provsByPolicy[candidate.policy_id] || [];
    for (const prov of allProvs) {
      const normalizedText = normalizeWhitespace(prov.text).toLowerCase();
      const sim = simMap[prov.id] || 0;
      const existing = globalTextSeen.get(normalizedText);
      if (!existing || sim > existing.sim) {
        globalTextSeen.set(normalizedText, { prov_id: prov.id, sim });
      }
    }
  }

  const dedupWinners = new Set(Array.from(globalTextSeen.values()).map(value => value.prov_id));

  for (const candidate of candidateContext) {
    const allProvs = (provsByPolicy[candidate.policy_id] || []).filter(prov => dedupWinners.has(prov.id));
    if (allProvs.length <= MIN_PROVISIONS_PER_POLICY) {
      candidate.provisions = [...allProvs];
      continue;
    }

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
    const pinnedIds = new Set(pinnedToUse.map(prov => prov.id));

    const remaining = unpinned
      .filter(prov => !pinnedIds.has(prov.id))
      .map(prov => ({
        ...prov,
        _sim: Number(simMap[prov.id] || 0),
        _kw: Number(keywordMap[prov.id] || 0),
      }));

    const slots = Math.max(MIN_PROVISIONS_PER_POLICY, MAX_PROVISIONS_PER_POLICY) - pinnedToUse.length;
    const bySemantic = [...remaining].sort((a, b) => b._sim - a._sim || b._kw - a._kw);
    const byKeyword = [...remaining].sort((a, b) => b._kw - a._kw || b._sim - a._sim);
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

    const semanticReserve = Math.min(2, Math.max(0, slots));
    const keywordReserve = Math.min(2, Math.max(0, slots - semanticReserve));
    takeFrom(bySemantic, semanticReserve);
    takeFrom(byKeyword, keywordReserve);
    takeFrom(bySemantic, Math.max(0, slots - selected.length));

    selected.sort((a, b) => {
      const aPrimary = Math.max(a._sim, a._kw);
      const bPrimary = Math.max(b._sim, b._kw);
      if (bPrimary !== aPrimary) return bPrimary - aPrimary;
      return (b._sim + b._kw) - (a._sim + a._kw);
    });

    candidate.provisions = [...pinnedToUse, ...selected];
  }

  let total = candidateContext.reduce((sum, candidate) => sum + candidate.provisions.length, 0);
  while (total > MAX_TOTAL_PROVISIONS) {
    let maxIndex = -1;
    let maxLen = MIN_PROVISIONS_PER_POLICY;
    for (let index = 0; index < candidateContext.length; index++) {
      if (candidateContext[index].provisions.length > maxLen) {
        maxLen = candidateContext[index].provisions.length;
        maxIndex = index;
      }
    }
    if (maxIndex === -1) break;
    candidateContext[maxIndex].provisions.pop();
    total--;
  }

  return candidateContext;
}

function buildCandidateContext(obligation, candidates, provisionsByPolicy, provisionSimilarityMap, provisionKeywordOverlapMap) {
  let candidateContext = candidates.map(candidate => ({
    policy_id: candidate.policy_id,
    policy_number: candidate.policy_number,
    title: candidate.title,
    score: candidate.score,
    provisions: [...(provisionsByPolicy[candidate.policy_id] || [])],
  }));

  candidateContext = capProvisions(
    candidateContext,
    obligation,
    provisionsByPolicy,
    provisionSimilarityMap,
    provisionKeywordOverlapMap
  );

  return candidateContext;
}

async function enrichGapRows(rows) {
  const results = new Array(rows.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= rows.length) return;

      const row = rows[currentIndex];
      const obligation = buildObligation(row);
      const matchResult = await retryFindCandidates(obligation);
      const {
        candidates,
        provisionsByPolicy,
        provisionSimilarityMap,
        provisionKeywordOverlapMap,
      } = matchResult;

      const candidateContext = buildCandidateContext(
        obligation,
        candidates,
        provisionsByPolicy,
        provisionSimilarityMap,
        provisionKeywordOverlapMap
      );

      const topCandidates = candidates.slice(0, TOP_CANDIDATE_COUNT).map(candidate => ({
        policy_id: candidate.policy_id,
        policy_number: candidate.policy_number,
        title: candidate.title,
        domain: candidate.domain,
        sub_domain: candidate.sub_domain,
        score: candidate.score,
        rank_score: candidate.rank_score,
        signal_breakdown: candidate.signal_breakdown,
        methods: candidate.methods,
      }));

      const packetSummary = summarizeProvisionPacket(candidateContext);
      const edgeSignals = getEdgeSignals(row);

      results[currentIndex] = {
        assessment_id: row.assessment_id,
        obligation_id: row.obligation_id,
        citation: row.citation,
        obligation_text: normalizeWhitespace(row.requirement),
        source_name: row.source_name,
        source_type: row.source_type,
        baseline_candidate_count: candidates.length,
        baseline_top_score: candidates[0]?.score ?? null,
        edge_signals: edgeSignals,
        edge_priority: edgePriority(edgeSignals),
        persisted_assessment: {
          id: row.assessment_id,
          org_id: row.assessment_org_id,
          facility_id: row.assessment_facility_id,
          obligation_id: row.obligation_id,
          policy_id: row.policy_id,
          provision_id: row.provision_id,
          status: row.status,
          confidence: row.confidence,
          gap_detail: row.gap_detail,
          recommended_policy: row.recommended_policy,
          obligation_span: row.obligation_span,
          provision_span: row.provision_span,
          reasoning: row.reasoning,
          trigger_span: row.trigger_span,
          inapplicability_reason: row.inapplicability_reason,
          conflict_detail: row.conflict_detail,
          reviewed_provision_refs: row.reviewed_provision_refs,
          covering_policy_number: row.covering_policy_number,
          match_method: row.match_method,
          match_score: row.match_score,
          vector_score: row.vector_score,
          keyword_score: row.keyword_score,
          map_run_id: row.map_run_id,
          assessed_by: row.assessed_by,
          model_id: row.model_id,
          prompt_version: row.prompt_version,
          human_status: row.human_status,
          reviewed_by: row.reviewed_by,
          reviewed_at: toIso(row.reviewed_at),
          review_notes: row.review_notes,
          created_at: toIso(row.created_at),
          updated_at: toIso(row.updated_at),
        },
        top_candidates: topCandidates,
        top_candidates_summary_text: topCandidateSummaryText(topCandidates),
        provision_packet_summary: packetSummary,
        provision_packet_summary_text: packetSummaryText(packetSummary),
      };

      completed++;
      if (completed % 10 === 0 || completed === rows.length) {
        console.error(`[${completed}/${rows.length}] scored GAP rows`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()));
  return results;
}

function selectStratifiedSample(enrichedRows) {
  const edgePool = enrichedRows
    .filter(row => row.edge_signals.length > 0)
    .sort((a, b) =>
      b.edge_priority - a.edge_priority ||
      (b.baseline_top_score ?? -1) - (a.baseline_top_score ?? -1) ||
      compareByCitation(a, b)
    );

  if (edgePool.length < BUCKET_SIZE) {
    throw new Error(`Need ${BUCKET_SIZE} conditional/admin/edge-case rows, found ${edgePool.length}`);
  }

  const edgeSelected = edgePool.slice(0, BUCKET_SIZE).map((row, index) => ({
    ...row,
    sample_bucket: 'conditional_admin_edge_case',
    sample_rule: `Matched one or more edge signals (${row.edge_signals.join(', ')}) and ranked by edge priority, then baseline top score.`,
    sample_rank_within_bucket: index + 1,
  }));

  const edgePoolIds = new Set(edgePool.map(row => row.obligation_id));
  const nonEdgePool = enrichedRows
    .filter(row => !edgePoolIds.has(row.obligation_id))
    .sort((a, b) =>
      (b.baseline_top_score ?? -1) - (a.baseline_top_score ?? -1) ||
      b.baseline_candidate_count - a.baseline_candidate_count ||
      compareByCitation(a, b)
    );

  if (nonEdgePool.length < BUCKET_SIZE * 2) {
    throw new Error(`Need ${BUCKET_SIZE * 2} non-edge rows, found ${nonEdgePool.length}`);
  }

  const higherSelected = nonEdgePool.slice(0, BUCKET_SIZE).map((row, index) => ({
    ...row,
    sample_bucket: 'higher_score',
    sample_rule: 'Non-edge GAP rows sorted by baseline top candidate score descending, then candidate count descending.',
    sample_rank_within_bucket: index + 1,
  }));

  const higherIds = new Set(higherSelected.map(row => row.obligation_id));
  const middlePool = nonEdgePool.filter(row => !higherIds.has(row.obligation_id));
  const middleMedian = median(
    middlePool
      .map(row => row.baseline_top_score)
      .filter(score => typeof score === 'number')
  );

  const middleSelected = middlePool
    .sort((a, b) =>
      Math.abs((a.baseline_top_score ?? middleMedian) - middleMedian) -
        Math.abs((b.baseline_top_score ?? middleMedian) - middleMedian) ||
      b.baseline_candidate_count - a.baseline_candidate_count ||
      compareByCitation(a, b)
    )
    .slice(0, BUCKET_SIZE)
    .map((row, index) => ({
      ...row,
      sample_bucket: 'middle_score',
      sample_rule: `Non-edge GAP rows closest to the non-edge median baseline top score (${middleMedian}). Ties break on candidate count, then citation.`,
      sample_rank_within_bucket: index + 1,
    }));

  return [...higherSelected, ...middleSelected, ...edgeSelected];
}

function addBlankReviewColumns(rows) {
  return rows.map(row => {
    const reviewColumns = Object.fromEntries(REVIEW_COLUMNS.map(column => [column, '']));
    return {
      ...row,
      ...reviewColumns,
    };
  });
}

function flattenForCsv(row) {
  const top1 = row.top_candidates[0] || {};
  const top2 = row.top_candidates[1] || {};
  const top3 = row.top_candidates[2] || {};

  return {
    sample_bucket: row.sample_bucket,
    sample_rule: row.sample_rule,
    sample_rank_within_bucket: row.sample_rank_within_bucket,
    obligation_id: row.obligation_id,
    assessment_id: row.assessment_id,
    citation: row.citation,
    obligation_text: row.obligation_text,
    source_name: row.source_name,
    source_type: row.source_type,
    baseline_candidate_count: row.baseline_candidate_count,
    baseline_top_score: row.baseline_top_score,
    edge_signals: row.edge_signals.join('|'),
    persisted_assessment_json: row.persisted_assessment,
    persisted_status: row.persisted_assessment.status,
    persisted_confidence: row.persisted_assessment.confidence,
    persisted_gap_detail: row.persisted_assessment.gap_detail,
    persisted_trigger_span: row.persisted_assessment.trigger_span,
    persisted_inapplicability_reason: row.persisted_assessment.inapplicability_reason,
    persisted_review_notes: row.persisted_assessment.review_notes,
    top_candidate_1_policy_number: top1.policy_number || '',
    top_candidate_1_title: top1.title || '',
    top_candidate_1_score: top1.score ?? '',
    top_candidate_1_signal_breakdown_json: top1.signal_breakdown || null,
    top_candidate_2_policy_number: top2.policy_number || '',
    top_candidate_2_title: top2.title || '',
    top_candidate_2_score: top2.score ?? '',
    top_candidate_2_signal_breakdown_json: top2.signal_breakdown || null,
    top_candidate_3_policy_number: top3.policy_number || '',
    top_candidate_3_title: top3.title || '',
    top_candidate_3_score: top3.score ?? '',
    top_candidate_3_signal_breakdown_json: top3.signal_breakdown || null,
    top_candidates_summary_text: row.top_candidates_summary_text,
    top_candidates_json: row.top_candidates,
    provision_packet_summary_text: row.provision_packet_summary_text,
    provision_packet_summary_json: row.provision_packet_summary,
    TRUE_GAP: row.TRUE_GAP,
    GAP_SHOULD_BE_PARTIAL: row.GAP_SHOULD_BE_PARTIAL,
    GAP_SHOULD_BE_NOT_APPLICABLE: row.GAP_SHOULD_BE_NOT_APPLICABLE,
    EVIDENCE_PACKET_ISSUE: row.EVIDENCE_PACKET_ISSUE,
    AMBIGUOUS_STANDARD: row.AMBIGUOUS_STANDARD,
    GAP_BUT_CITATION_TO_NEIGHBOR_POLICY: row.GAP_BUT_CITATION_TO_NEIGHBOR_POLICY,
  };
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map(column => escapeCsv(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

async function loadEnvFile(filePath) {
  const text = await readFile(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    if (!process.env[key]) process.env[key] = stripQuotes(value);
  }
}

async function loadRepoEnv() {
  await loadEnvFile(path.join(repoRoot, '.env.local'));
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function loadDbContext() {
  const [{ db, dbClient }, { sql }] = await Promise.all([
    import(pathToFileURL(path.join(repoRoot, 'lib', 'db.js')).href),
    import('drizzle-orm'),
  ]);
  return { db, dbClient, sql };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadOriginMainMatchingModule() {
  let matchingSource;
  const gitCandidates = [
    process.env.GIT_EXE,
    'git',
    'C:\\Users\\swinikoff\\AppData\\Local\\GitHubDesktop\\app-3.5.5\\resources\\app\\git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
  ].filter(Boolean);

  try {
    if (process.env.ORIGIN_MAIN_MATCHING_FILE) {
      matchingSource = await readFile(process.env.ORIGIN_MAIN_MATCHING_FILE, 'utf8');
    } else if (process.env.ORIGIN_MAIN_MATCHING_B64) {
      matchingSource = Buffer.from(process.env.ORIGIN_MAIN_MATCHING_B64, 'base64').toString('utf8');
    } else {
      let lastError = null;
      for (const gitPath of gitCandidates) {
        try {
          matchingSource = execFileSync(
            gitPath,
            ['show', 'origin/main:lib/matching.js'],
            { cwd: repoRoot, encoding: 'utf8' }
          );
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!matchingSource) {
        throw lastError || new Error('Unable to read origin/main:lib/matching.js');
      }
    }
  } catch (error) {
    throw new Error(`Failed to load origin/main matcher source. Fetch origin/main and retry. ${error.message}`);
  }

  const replacements = [
    ['drizzle-orm', pathToFileURL(path.join(repoRoot, 'node_modules', 'drizzle-orm', 'index.js')).href],
    ['./db.js', pathToFileURL(path.join(repoRoot, 'lib', 'db.js')).href],
    ['./schema.js', pathToFileURL(path.join(repoRoot, 'lib', 'schema.js')).href],
    ['./embeddings.js', pathToFileURL(path.join(repoRoot, 'lib', 'embeddings.js')).href],
  ];

  let rewrittenSource = matchingSource;
  for (const [from, to] of replacements) {
    rewrittenSource = rewrittenSource.replace(
      new RegExp(`from '${escapeRegExp(from)}'`, 'g'),
      `from '${to}'`
    );
    rewrittenSource = rewrittenSource.replace(
      new RegExp(`from "${escapeRegExp(from)}"`, 'g'),
      `from "${to}"`
    );
  }

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(rewrittenSource).toString('base64')}`;
  return import(moduleUrl);
}

try {
  const [runRow] = rowsOf(await db.execute(sql`
    SELECT id, status, completed_at, created_at
    FROM map_runs
    WHERE status = 'completed'
    ORDER BY completed_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
  `));

  if (!runRow) {
    throw new Error('No completed map_runs found.');
  }

  const [countRow] = rowsOf(await db.execute(sql`
    SELECT
      COUNT(*) AS total_assessments,
      COUNT(*) FILTER (
        WHERE ca.status = 'GAP' AND ca.policy_id IS NULL
      ) AS gap_null_policy_count
    FROM coverage_assessments ca
    WHERE ca.map_run_id = ${runRow.id}
  `));

  const gapRows = rowsOf(await db.execute(sql`
    SELECT
      ca.id AS assessment_id,
      ca.org_id AS assessment_org_id,
      ca.facility_id AS assessment_facility_id,
      ca.obligation_id,
      ca.policy_id,
      ca.provision_id,
      ca.status,
      ca.confidence,
      ca.gap_detail,
      ca.recommended_policy,
      ca.obligation_span,
      ca.provision_span,
      ca.reasoning,
      ca.trigger_span,
      ca.inapplicability_reason,
      ca.conflict_detail,
      ca.reviewed_provision_refs,
      ca.covering_policy_number,
      ca.match_method,
      ca.match_score,
      ca.vector_score,
      ca.keyword_score,
      ca.map_run_id,
      ca.assessed_by,
      ca.model_id,
      ca.prompt_version,
      ca.human_status,
      ca.reviewed_by,
      ca.reviewed_at,
      ca.review_notes,
      ca.created_at,
      ca.updated_at,
      o.org_id,
      o.reg_source_id,
      o.parent_id,
      o.citation,
      o.requirement,
      o.source_type,
      o.topics,
      o.levels_of_care,
      o.responsible_party,
      o.timeframe,
      o.documentation_required,
      o.applicability,
      o.tjc_crosswalk,
      o.risk_tier,
      o.loc_applicability,
      o.exclude_from_assessment,
      o.exclude_reason,
      rs.name AS source_name
    FROM coverage_assessments ca
    JOIN obligations o ON o.id = ca.obligation_id
    LEFT JOIN reg_sources rs ON rs.id = o.reg_source_id
    WHERE ca.map_run_id = ${runRow.id}
      AND ca.status = 'GAP'
      AND ca.policy_id IS NULL
    ORDER BY o.citation
  `));

  console.error(`Using map_run_id: ${runRow.id}`);
  console.error(`Found ${gapRows.length} GAP rows with status='GAP' and policy_id IS NULL`);

  const enrichedRows = await enrichGapRows(gapRows);
  const sampledRows = addBlankReviewColumns(selectStratifiedSample(enrichedRows));
  const csvRows = sampledRows.map(flattenForCsv);
  const csvColumns = Object.keys(csvRows[0]);

  const jsonArtifact = {
    generated_at: new Date().toISOString(),
    matcher_logic_source: 'origin/main:lib/matching.js',
    provision_packet_source: 'origin/main:app/api/v6/assess/route.js#capProvisions',
    latest_completed_run: {
      map_run_id: runRow.id,
      completed_at: toIso(runRow.completed_at),
      created_at: toIso(runRow.created_at),
      actual_total_assessments: Number(countRow.total_assessments),
      actual_gap_status_null_policy_count: Number(countRow.gap_null_policy_count),
    },
    sampling_rules: {
      higher_score: 'Take the top 20 non-edge rows by baseline top candidate score, breaking ties by baseline candidate count and citation.',
      middle_score: 'Take the 20 remaining non-edge rows whose baseline top candidate scores are closest to the non-edge median score.',
      conditional_admin_edge_case: 'Take 20 rows flagged by conditional language, admin/process markers, loc applicability, deep parenthetical citations, or crosswalked EP citations; rank by edge priority, then baseline top score.',
    },
    rows: sampledRows,
  };

  await mkdir(artifactsDir, { recursive: true });
  await writeFile(outputJsonPath, JSON.stringify(jsonArtifact, null, 2));
  await writeFile(outputCsvPath, toCsv(csvRows, csvColumns));

  console.log(JSON.stringify({
    map_run_id: runRow.id,
    output_json: outputJsonPath,
    output_csv: outputCsvPath,
    sampled_rows: sampledRows.length,
  }, null, 2));
} finally {
  await dbClient.end({ timeout: 5 });
}
