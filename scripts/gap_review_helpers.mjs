import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, '..');

export const CONDITIONAL_OBLIGATION_PATTERNS = /\b(if the (facility|program|provider)|for (facilities|programs|providers) (that|which|who)|when (providing|operating|offering)|facilities (with|operating|that)|only applicable (to|for|if|when)|does not apply (to|if|when|unless)|limited to facilities)\b/i;

export const ADMIN_MARKERS = [
  /submit.*report/i,
  /\bESC\b/,
  /accreditation committee/i,
  /survey submission/i,
  /submission to the joint commission/i,
  /accreditation.*process/i,
];

const MAX_PROVISIONS_PER_POLICY = 8;
const MAX_TOTAL_PROVISIONS = 96;
const MIN_PROVISIONS_PER_POLICY = 4;
const MAX_CITATION_PINNED_PER_POLICY = 2;

export function rowsOf(result) {
  return result?.rows || result || [];
}

export async function loadEnvFile(filePath) {
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

export async function loadRepoEnv() {
  await loadEnvFile(path.join(repoRoot, '.env.local'));
}

export async function loadDbContext() {
  const [{ db, dbClient }, { sql }] = await Promise.all([
    import(pathToFileURL(path.join(repoRoot, 'lib', 'db.js')).href),
    import('drizzle-orm'),
  ]);
  return { db, dbClient, sql };
}

export async function loadOriginMainMatchingModule() {
  const matchingSource = process.env.ORIGIN_MAIN_MATCHING_B64
    ? Buffer.from(process.env.ORIGIN_MAIN_MATCHING_B64, 'base64').toString('utf8')
    : execFileSync(
      'git',
      ['show', 'origin/main:lib/matching.js'],
      { cwd: repoRoot, encoding: 'utf8' }
    );

  const replacements = [
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
  }

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(rewrittenSource).toString('base64')}`;
  return import(moduleUrl);
}

export function buildCandidateContext(
  obligation,
  candidates,
  provisionsByPolicy,
  provisionSimilarityMap,
  provisionKeywordOverlapMap
) {
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

export function capProvisions(candidateContext, obligation, provsByPolicy, provisionSimilarityMap, provisionKeywordOverlapMap) {
  const oblCitation = (obligation.citation || '').toLowerCase().trim();
  const simMap = provisionSimilarityMap || {};
  const keywordMap = provisionKeywordOverlapMap || {};

  const globalTextSeen = new Map();
  for (const candidate of candidateContext) {
    const allProvs = provsByPolicy[candidate.policy_id] || [];
    for (const prov of allProvs) {
      const normText = normalizeWhitespace(prov.text).toLowerCase();
      const sim = simMap[prov.id] || 0;
      const existing = globalTextSeen.get(normText);
      if (!existing || sim > existing.sim) {
        globalTextSeen.set(normText, { policy_id: candidate.policy_id, prov_id: prov.id, sim });
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

export function summarizeProvisionPacket(candidateContext) {
  const totalProvisionsPresented = candidateContext.reduce(
    (sum, candidate) => sum + candidate.provisions.length,
    0
  );

  const topPolicyPackets = candidateContext.slice(0, 3).map(candidate => {
    const sections = uniqueNonEmpty(candidate.provisions.map(prov => prov.section)).slice(0, 4);
    const sourceCitations = uniqueNonEmpty(candidate.provisions.map(prov => prov.source_citation)).slice(0, 4);
    const snippets = candidate.provisions.slice(0, 2).map(prov => trimSnippet(prov.text, 200));

    return {
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

export function packetSummaryText(packetSummary) {
  const packetParts = packetSummary.top_policy_packets.map(packet => {
    const sectionText = packet.sections.length > 0
      ? `sections=${packet.sections.join(' | ')}`
      : 'sections=none';
    return `${packet.policy_number || 'UNKNOWN'} (${packet.provisions_presented} provs; ${sectionText})`;
  });

  return `${packetSummary.candidate_policies_presented} candidate policies, ${packetSummary.total_provisions_presented} provisions; ${packetParts.join('; ')}`;
}

export function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function trimSnippet(text, maxLength = 180) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function uniqueNonEmpty(values) {
  return [...new Set(values.filter(Boolean))];
}

export function citationDepth(citation) {
  return (String(citation || '').match(/\(/g) || []).length;
}

export function hasLocApplicability(row) {
  if (!row.loc_applicability) return false;
  if (Array.isArray(row.loc_applicability)) return row.loc_applicability.length > 0;
  return true;
}

export function getEdgeSignals(row) {
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

export function edgePriority(signals) {
  let score = 0;
  if (signals.includes('conditional_language')) score += 4;
  if (signals.includes('admin_process_marker')) score += 4;
  if (signals.includes('loc_applicability_present')) score += 3;
  if (signals.includes('deep_parenthetical_citation')) score += 2;
  if (signals.includes('crosswalked_ep_citation')) score += 1;
  return score;
}

export function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function toCsv(rows, columns) {
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

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
