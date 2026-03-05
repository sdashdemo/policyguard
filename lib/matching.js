// lib/matching.js — Hybrid matching: pgvector semantic + keyword/citation signals

import { db } from './db.js';
import { sql } from 'drizzle-orm';
import { generateQueryEmbedding } from './embeddings.js';

const CITATION_EXACT = 60;
const CITATION_SECTION = 40;
const SUBDOMAIN_MATCH = 35;
const KEYWORD_BASE = 15;
const KEYWORD_BONUS = 10;
const VECTOR_WEIGHT = 50; // Max score from vector similarity
const FTS_WEIGHT = 45; // Max score from full-text rank
const MIN_FTS_RANK = 0.01;
const MAX_CANDIDATES = 12;
const MIN_SCORE = 15;

const HIGH_VALUE_KEYWORDS = new Set([
  'biopsychosocial', 'psychiatric', 'ciwa', 'cows', 'involuntary',
  'restraint', 'seclusion', 'buprenorphine', 'methadone', 'naloxone',
  'tuberculosis', 'bloodborne', 'hipaa', '42 cfr', 'asam',
  'credentialing', 'privileging', 'formulary', 'narcotic',
  'grievance', 'suicide', 'homicidal', 'discharge plan',
  'informed consent', 'release of information', 'controlled substance',
]);

const TOKEN_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'into', 'their',
  'shall', 'must', 'will', 'have', 'has', 'been', 'were', 'which',
  'when', 'where', 'what', 'also', 'your', 'than', 'then', 'they',
  'them', 'such', 'each', 'every', 'ensure', 'policy', 'procedure',
  'patient', 'patients', 'facility', 'program', 'services', 'service',
]);

// High-risk domains that auto-escalate to NEEDS_LEGAL_REVIEW when confidence is low
export const HIGH_RISK_TOPICS = new Set([
  'patient_rights', 'consent', 'confidential', 'involuntary',
  'abuse', 'neglect', 'restraint', 'seclusion', 'medication_management',
  'controlled substance', 'suicide', 'reporting',
]);

function citationPrefixes(citation) {
  if (!citation) return [];
  const prefixes = [citation.trim()];
  let current = citation.trim();
  while (true) {
    const match = current.match(/^(.+?)\([^)]*\)\s*$/);
    if (!match) break;
    current = match[1].trim();
    prefixes.push(current);
  }
  const epMatch = current.match(/^(.+?)\s+EP\s+\d+/i);
  if (epMatch) prefixes.push(epMatch[1].trim());
  return [...new Set(prefixes)];
}

function extractKeywords(text) {
  if (!text) return [];
  const lower = text.toLowerCase().replace(/-/g, '');
  const terms = [
    'assessment', 'biopsychosocial', 'psychiatric', 'evaluation', 'screening',
    'treatment plan', 'treatment planning', 'individualized',
    'discharge', 'discharge plan', 'aftercare', 'transition', 'continuity',
    'consent', 'informed consent', 'voluntary', 'involuntary',
    'confidential', 'hipaa', '42 cfr', 'privacy', 'release of information',
    'medication', 'prescri', 'controlled substance', 'narcotic', 'formulary',
    'restraint', 'seclusion', 'grievance', 'complaint', 'patient rights', 'rights',
    'abuse', 'neglect', 'reporting', 'infection', 'tuberculosis', 'bloodborne', 'exposure',
    'credentialing', 'privileging', 'scope of practice',
    'training', 'competency', 'orientation',
    'documentation', 'clinical record', 'medical record', 'chart',
    'detox', 'withdrawal', 'ciwa', 'cows',
    'group therapy', 'individual therapy', 'counseling',
    'mat', 'buprenorphine', 'methadone', 'naloxone', 'narcan',
    'safety plan', 'suicide', 'homicidal', 'risk',
    'emergency', 'disaster', 'evacuation',
    'quality', 'performance improvement', 'outcome',
    'staffing', 'caseload', 'supervision',
    'admission', 'intake', 'referral',
    'transportation', 'visitor', 'phone', 'mail',
    'fire', 'safety', 'hazardous',
    'laboratory', 'specimen', 'drug screen',
    'utilization', 'length of stay', 'asam',
    'governance', 'bylaws', 'ethics', 'committee',
  ];
  return terms.filter(term => lower.includes(term));
}

function extractSearchTokens(text) {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 4 && !TOKEN_STOPWORDS.has(token));
  return [...new Set(tokens)];
}

function countTokenOverlap(queryTokens, text) {
  if (!queryTokens?.length || !text) return 0;
  const textTokens = new Set(extractSearchTokens(text));
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap++;
  }
  return overlap;
}

/**
 * Hybrid matching: combine vector similarity with keyword/citation signals
 */
export async function findCandidatesHybrid(obligation, policiesData, provisionsData, labelsData) {
  const scores = {};

  function addScore(policyId, policy, method, detail, score) {
    if (!scores[policyId]) {
      scores[policyId] = { policy, citation: 0, sub_domain: 0, keyword: 0, title: 0, vector: 0, fts: 0, methods: [] };
    }
    const bucket = method === 'citation'
      ? 'citation'
      : method === 'sub_domain'
        ? 'sub_domain'
        : method === 'title'
          ? 'title'
          : method === 'vector'
            ? 'vector'
            : method === 'fts'
              ? 'fts'
              : 'keyword';
    scores[policyId][bucket] = Math.max(scores[policyId][bucket], score);
    scores[policyId].methods.push({ method, detail, score });
  }

  // ── Signal 1: Vector similarity (pgvector) ──
  let vectorCandidates = [];
  try {
    const queryEmbedding = await generateQueryEmbedding(
      `${obligation.citation}: ${obligation.requirement}`
    );
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    const vectorResults = await db.execute(sql`
      SELECT
        p.id as provision_id,
        p.policy_id,
        p.text as provision_text,
        p.section,
        1 - (p.embedding <=> ${vectorStr}::vector) as similarity
      FROM provisions p
      WHERE p.embedding IS NOT NULL
      ORDER BY p.embedding <=> ${vectorStr}::vector
      LIMIT 20
    `);

    vectorCandidates = (vectorResults.rows || vectorResults || []).filter(r => r.similarity > 0.25);

    // Group by policy, take best similarity per policy
    const policyBestSim = {};
    for (const vc of vectorCandidates) {
      if (!policyBestSim[vc.policy_id] || vc.similarity > policyBestSim[vc.policy_id]) {
        policyBestSim[vc.policy_id] = vc.similarity;
      }
    }

    for (const [policyId, sim] of Object.entries(policyBestSim)) {
      const policy = policiesData.find(p => p.id === policyId);
      if (policy) {
        const vectorScore = Math.round(sim * VECTOR_WEIGHT);
        addScore(policyId, policy, 'vector', `similarity: ${sim.toFixed(3)}`, vectorScore);
      }
    }
  } catch (err) {
    // Vector search failed (maybe embeddings not generated yet) — fall back to keyword-only
    console.warn('Vector search unavailable:', err.message);
  }

  // ── Signal 2: Citation matching with popularity penalty ──
  const oblPrefixes = citationPrefixes(obligation.citation);

  const citationPopularity = {};
  for (const policy of policiesData) {
    const allCits = [...(policy.dcf_citations || []), ...(policy.tjc_citations || [])];
    for (const cit of allCits) {
      const norm = cit.trim().toLowerCase();
      citationPopularity[norm] = (citationPopularity[norm] || 0) + 1;
    }
  }

  for (const policy of policiesData) {
    const policyCitations = [...(policy.dcf_citations || []), ...(policy.tjc_citations || [])];
    for (const policyCit of policyCitations) {
      const pNorm = policyCit.trim().toLowerCase();
      for (const oblPrefix of oblPrefixes) {
        const oNorm = oblPrefix.toLowerCase();
        const isExact = pNorm === oNorm;
        const isSection = !isExact && (pNorm.startsWith(oNorm) || oNorm.startsWith(pNorm));

        if (isExact || isSection) {
          const popularity = citationPopularity[pNorm] || 1;
          const penalty = popularity > 10 ? 0.3 : popularity > 5 ? 0.5 : popularity > 2 ? 0.75 : 1.0;
          const baseScore = isExact ? CITATION_EXACT : CITATION_SECTION;
          const finalScore = Math.round(baseScore * penalty);
          addScore(policy.id, policy, 'citation', `${isExact ? 'exact' : 'section'}: ${policyCit} (${popularity} cite)`, finalScore);
          break;
        }
      }
    }
  }

  // ── Signal 3: Sub-domain affinity ──
  const oblText = obligation.requirement.toLowerCase();
  const matchedSubDomains = new Set();

  for (const label of labelsData) {
    const affinityKw = label.affinity_keywords || [];
    if (affinityKw.some(kw => oblText.includes(kw.toLowerCase()))) {
      matchedSubDomains.add(label.prefix);
    }
  }

  for (const policy of policiesData) {
    if (policy.sub_domain && matchedSubDomains.has(policy.sub_domain)) {
      addScore(policy.id, policy, 'sub_domain', `${policy.sub_domain} affinity`, SUBDOMAIN_MATCH);
    }
  }

  // ── Signal 4: Keyword overlap ──
  // Signal 4: Full-text provision retrieval (requirement text only)
  let ftsCandidates = [];
  const requirementSearchText = (obligation.requirement || '').trim();
  if (requirementSearchText) {
    try {
      const ftsResults = await db.execute(sql`
        WITH q AS (
          SELECT websearch_to_tsquery('english', ${requirementSearchText}) AS tsq
        )
        SELECT
          p.id AS provision_id,
          p.policy_id,
          ts_rank_cd(p.search_tsv, q.tsq) AS rank
        FROM provisions p
        CROSS JOIN q
        WHERE p.search_tsv @@ q.tsq
        ORDER BY rank DESC
        LIMIT 120
      `);

      ftsCandidates = (ftsResults.rows || ftsResults || [])
        .map(r => ({ ...r, rank: Number(r.rank) || 0 }))
        .filter(r => r.rank >= MIN_FTS_RANK);

      const topRank = ftsCandidates.length > 0
        ? Math.max(...ftsCandidates.map(r => r.rank))
        : 0;

      const policyBestRank = {};
      for (const fc of ftsCandidates) {
        if (!policyBestRank[fc.policy_id] || fc.rank > policyBestRank[fc.policy_id]) {
          policyBestRank[fc.policy_id] = fc.rank;
        }
      }

      for (const [policyId, rank] of Object.entries(policyBestRank)) {
        const policy = policiesData.find(p => p.id === policyId);
        if (policy && topRank > 0) {
          const normalized = Math.min(rank / topRank, 1);
          const ftsScore = Math.max(8, Math.round(normalized * FTS_WEIGHT));
          addScore(policyId, policy, 'fts', `fts rank: ${rank.toFixed(4)}`, ftsScore);
        }
      }
    } catch (err) {
      // If search_tsv is not migrated yet, continue with other signals.
      console.warn('FTS search unavailable:', err.message);
    }
  }

  // Signal 5: Keyword overlap
  const oblKeywords = extractKeywords(obligation.requirement);
  const obligationTokens = extractSearchTokens(obligation.requirement);
  const provisionKeywordOverlapMap = {};

  if (oblKeywords.length > 0 || obligationTokens.length > 0) {
    const provsByPolicy = {};
    for (const prov of provisionsData) {
      if (!provsByPolicy[prov.policy_id]) provsByPolicy[prov.policy_id] = [];
      provsByPolicy[prov.policy_id].push(prov);
    }

    for (const [policyId, provs] of Object.entries(provsByPolicy)) {
      let bestKeywordScore = 0;
      let bestOverlap = 0;
      let highValueHits = 0;
      let bestTokenOverlap = 0;

      for (const prov of provs) {
        const provKeywords = extractKeywords(prov.text);
        const overlap = oblKeywords.filter(kw => provKeywords.includes(kw));
        const overlapHighValue = overlap.filter(kw => HIGH_VALUE_KEYWORDS.has(kw)).length;
        const tokenOverlap = countTokenOverlap(obligationTokens, prov.text);
        const keywordOverlapScore = overlap.length + overlapHighValue + Math.min(tokenOverlap, 4);

        if (keywordOverlapScore > 0) {
          provisionKeywordOverlapMap[prov.id] = Math.max(
            provisionKeywordOverlapMap[prov.id] || 0,
            keywordOverlapScore
          );
        }

        if (keywordOverlapScore > bestKeywordScore) {
          bestKeywordScore = keywordOverlapScore;
          bestOverlap = overlap.length;
          highValueHits = overlapHighValue;
          bestTokenOverlap = tokenOverlap;
        }
      }

      if (bestKeywordScore >= 1) {
        const policy = policiesData.find(p => p.id === policyId);
        if (policy) {
          const kwScore = Math.min(
            KEYWORD_BASE + bestOverlap * KEYWORD_BONUS + highValueHits * 10 + Math.min(bestTokenOverlap, 4) * 4,
            70
          );
          addScore(
            policyId,
            policy,
            'keyword',
            `${bestOverlap} keywords (${highValueHits} high-value, ${bestTokenOverlap} token overlap)`,
            kwScore
          );
        }
      }
    }

    // Title keyword matching
    for (const policy of policiesData) {
      const titleKeywords = extractKeywords(policy.title);
      const overlap = oblKeywords.filter(kw => titleKeywords.includes(kw));
      if (overlap.length >= 1) {
        const highValueHits = overlap.filter(kw => HIGH_VALUE_KEYWORDS.has(kw)).length;
        const titleScore = Math.min(10 + overlap.length * 12 + highValueHits * 10, 50);
        addScore(policy.id, policy, 'title', `${overlap.length} title keywords`, titleScore);
      }
    }
  }

  // ── Combine scores ──
  const candidates = Object.values(scores)
    .map(({ policy, citation, sub_domain, keyword, title, vector, fts, methods }) => ({
      policy_id: policy.id,
      policy_number: policy.policy_number,
      title: policy.title,
      domain: policy.domain,
      sub_domain: policy.sub_domain,
      score: citation + sub_domain + keyword + title + vector + fts,
      signal_breakdown: { citation, sub_domain, keyword, title, vector, fts },
      methods,
    }))
    .filter(c => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  // Build provision similarity map for ranked provision capping
  // Maps provision_id → similarity score (0-1)
  const provisionSimilarityMap = {};
  for (const vc of vectorCandidates) {
    if (!provisionSimilarityMap[vc.provision_id] || vc.similarity > provisionSimilarityMap[vc.provision_id]) {
      provisionSimilarityMap[vc.provision_id] = vc.similarity;
    }
  }

  // Build FTS rank map as fallback keyword signal for provision capping.
  for (const fc of ftsCandidates) {
    if (!provisionKeywordOverlapMap[fc.provision_id]) {
      provisionKeywordOverlapMap[fc.provision_id] = fc.rank;
    }
  }

  return { candidates, provisionSimilarityMap, provisionKeywordOverlapMap };
}

// Re-export for backward compatibility
export const findCandidates = findCandidatesHybrid;
