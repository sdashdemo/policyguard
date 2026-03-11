// lib/matching.js - Hybrid matching with SQL-first candidate generation

import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { subDomainLabels } from './schema.js';
import { generateQueryEmbedding } from './embeddings.js';

const COMPOSITE_DOC_TYPES = new Set(['manual', 'plan']);
const COMPOSITE_DOC_DAMPENER = 0.7;

// Domain routing: citation prefix → { allowed domains, boost tier }
// High confidence (1-2 domains): +20, Medium (2-3): +15, Broad (4+): +10
const DOMAIN_ROUTING = {
  // TJC chapters (universal, all facilities)
  'LS':   { domains: new Set(['life_safety', 'environment_of_care']), boost: 20 },
  'EC':   { domains: new Set(['environment_of_care']), boost: 20 },
  'EM':   { domains: new Set(['emergency_management']), boost: 20 },
  'IC':   { domains: new Set(['infection_control']), boost: 20 },
  'HRM':  { domains: new Set(['human_resources']), boost: 20 },
  'LD':   { domains: new Set(['leadership']), boost: 20 },
  'APR':  { domains: new Set(['leadership']), boost: 20 },
  'RI':   { domains: new Set(['clinical', 'information_management']), boost: 15 },
  'RC':   { domains: new Set(['information_management', 'clinical']), boost: 15 },
  'MM':   { domains: new Set(['pharmacy', 'nursing', 'medical']), boost: 15 },
  'CTS':  { domains: new Set(['clinical', 'nursing', 'medical', 'pharmacy', 'lab']), boost: 10 },
  'NPSG': { domains: new Set(['clinical', 'nursing', 'lab', 'medical']), boost: 10 },
  // Florida state regs
  '65D-30.004':  { domains: new Set(['leadership', 'human_resources', 'medical', 'environment_of_care']), boost: 10 },
  '65D-30.0037': { domains: new Set(['leadership']), boost: 20 },
  '65D-30.0041': { domains: new Set(['information_management']), boost: 20 },
  '65D-30.0042': { domains: new Set(['medical', 'clinical']), boost: 15 },
  '65D-30.0044': { domains: new Set(['clinical']), boost: 20 },
  '65D-30.0047': { domains: new Set(['environment_of_care']), boost: 20 },
  '65D-30.010':  { domains: new Set(['clinical']), boost: 20 },
  '397.403':     { domains: new Set(['environment_of_care']), boost: 20 },
  '397.4073':    { domains: new Set(['human_resources']), boost: 20 },
};

function getRoutingBoost(citation, policyDomain) {
  if (!citation || !policyDomain) return 0;
  const c = citation.trim();
  // Try TJC chapter match: extract prefix before first dot or space+digit
  const tjcMatch = c.match(/^(?:TJC\s+)?([A-Z]+)/);
  const tjcPrefix = tjcMatch ? tjcMatch[1] : null;
  // Try state reg match: longest matching prefix
  let stateRoute = null;
  for (const key of Object.keys(DOMAIN_ROUTING)) {
    if (c.startsWith(key) && (!stateRoute || key.length > stateRoute.length)) {
      stateRoute = key;
    }
  }
  const route = DOMAIN_ROUTING[tjcPrefix] || (stateRoute ? DOMAIN_ROUTING[stateRoute] : null);
  if (!route) return 0;
  return route.domains.has(policyDomain) ? route.boost : 0;
}

const CITATION_EXACT = 60;
const CITATION_SECTION = 40;
const SUBDOMAIN_MATCH = 35;
const KEYWORD_BASE = 15;
const KEYWORD_BONUS = 10;
const TOKEN_ONLY_KEYWORD_CAP = 24;
const CONSENSUS_RANK_BONUS = 12;
const VECTOR_WEIGHT = 50;
const FTS_WEIGHT = 45;
const MIN_FTS_RANK = 0.01;
const MAX_CANDIDATES = 12;
const MAX_STAGE1_POLICIES = 48;
const MIN_SCORE = 15;
const VECTOR_LIMIT = 20;
const FTS_LIMIT = 120;
const TITLE_LIMIT = 20;
const SUBDOMAIN_LIMIT = 20;

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

function rowsOf(result) {
  return result?.rows || result || [];
}

function textArraySql(values) {
  return sql`ARRAY[${sql.join(values.map(value => sql`${value}`), sql`, `)}]::text[]`;
}

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
    'recall', 'recalled', 'discontinued', 'expiration', 'expired',
    'safety plan', 'suicide', 'homicidal', 'risk',
    'emergency', 'disaster', 'evacuation',
    'quality', 'performance improvement', 'outcome',
    'staffing', 'caseload', 'supervision',
    'admission', 'intake', 'referral',
    'planning', 'systematic',
    'transportation', 'visitor', 'phone', 'mail',
    'fire', 'safety', 'hazardous',
    'inspection', 'inspections', 'local code', 'zoning', 'ordinance', 'ordinances', 'compliance',
    'trauma', 'exploitation',
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

function bumpStage1Score(stage1Scores, policyId, score) {
  if (!policyId || !Number.isFinite(score) || score <= 0) return;
  stage1Scores.set(policyId, (stage1Scores.get(policyId) || 0) + score);
}

async function fetchVectorCandidates(obligation, vectorLimit) {
  try {
    const queryEmbedding = await generateQueryEmbedding(
      `${obligation.citation}: ${obligation.requirement}`
    );
    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const result = await db.execute(sql`
      SELECT
        p.id AS provision_id,
        p.policy_id,
        1 - (p.embedding <=> ${vectorStr}::vector) AS similarity
      FROM provisions p
      WHERE p.embedding IS NOT NULL
      ORDER BY p.embedding <=> ${vectorStr}::vector
      LIMIT ${vectorLimit}
    `);
    return rowsOf(result)
      .map(row => ({
        provision_id: row.provision_id,
        policy_id: row.policy_id,
        similarity: Number(row.similarity) || 0,
      }))
      .filter(row => row.similarity > 0.25);
  } catch (err) {
    console.warn('Vector search unavailable:', err.message);
    return [];
  }
}

async function fetchFtsCandidates(requirementSearchText, ftsLimit, minFtsRank) {
  if (!requirementSearchText) return [];
  try {
    const result = await db.execute(sql`
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
      LIMIT ${ftsLimit}
    `);
    return rowsOf(result)
      .map(row => ({
        provision_id: row.provision_id,
        policy_id: row.policy_id,
        rank: Number(row.rank) || 0,
      }))
      .filter(row => row.rank >= minFtsRank);
  } catch (err) {
    console.warn('FTS search unavailable:', err.message);
    return [];
  }
}

async function fetchCitationCandidates(oblPrefixes) {
  if (!oblPrefixes.length) return [];
  const prefixesSql = textArraySql(oblPrefixes);
  const result = await db.execute(sql`
    WITH prefixes AS (
      SELECT unnest(${prefixesSql}) AS prefix
    ),
    policy_citations AS (
      SELECT
        p.id AS policy_id,
        cit.citation
      FROM policies p
      CROSS JOIN LATERAL (
        SELECT value AS citation FROM jsonb_array_elements_text(COALESCE(p.dcf_citations, '[]'::jsonb))
        UNION ALL
        SELECT value AS citation FROM jsonb_array_elements_text(COALESCE(p.tjc_citations, '[]'::jsonb))
      ) cit
    ),
    popularity AS (
      SELECT lower(citation) AS citation_key, count(*) AS citation_count
      FROM policy_citations
      GROUP BY lower(citation)
    ),
    matched AS (
      SELECT
        pc.policy_id,
        pc.citation,
        prefixes.prefix,
        CASE
          WHEN lower(pc.citation) = lower(prefixes.prefix) THEN 'exact'
          WHEN lower(pc.citation) LIKE lower(prefixes.prefix) || '%'
            OR lower(prefixes.prefix) LIKE lower(pc.citation) || '%'
            THEN 'section'
          ELSE NULL
        END AS match_type
      FROM policy_citations pc
      JOIN prefixes
        ON lower(pc.citation) = lower(prefixes.prefix)
        OR lower(pc.citation) LIKE lower(prefixes.prefix) || '%'
        OR lower(prefixes.prefix) LIKE lower(pc.citation) || '%'
    )
    SELECT DISTINCT ON (m.policy_id)
      m.policy_id,
      m.citation,
      m.match_type,
      COALESCE(popularity.citation_count, 1) AS popularity
    FROM matched m
    LEFT JOIN popularity ON popularity.citation_key = lower(m.citation)
    WHERE m.match_type IS NOT NULL
    ORDER BY
      m.policy_id,
      CASE m.match_type WHEN 'exact' THEN 2 ELSE 1 END DESC,
      COALESCE(popularity.citation_count, 1) ASC
  `);
  return rowsOf(result).map(row => ({
    policy_id: row.policy_id,
    citation: row.citation,
    match_type: row.match_type,
    popularity: Number(row.popularity) || 1,
  }));
}

async function fetchTitleCandidates(oblKeywords, titleLimit) {
  if (!oblKeywords.length) return [];
  const keywordsSql = textArraySql(oblKeywords.slice(0, 12));
  const result = await db.execute(sql`
    WITH terms AS (
      SELECT unnest(${keywordsSql}) AS term
    )
    SELECT
      p.id AS policy_id,
      count(DISTINCT lower(terms.term)) AS hits
    FROM policies p
    JOIN terms ON lower(p.title) LIKE '%' || lower(terms.term) || '%'
    GROUP BY p.id
    ORDER BY hits DESC, p.id
    LIMIT ${titleLimit}
  `);
  return rowsOf(result).map(row => ({
    policy_id: row.policy_id,
    hits: Number(row.hits) || 0,
  }));
}

async function fetchSubDomainCandidates(matchedSubDomains, subdomainLimit) {
  if (!matchedSubDomains.length) return [];
  const prefixesSql = textArraySql(matchedSubDomains);
  const result = await db.execute(sql`
    SELECT id AS policy_id
    FROM policies
    WHERE sub_domain = ANY(${prefixesSql})
    ORDER BY id
    LIMIT ${subdomainLimit}
  `);
  return rowsOf(result).map(row => ({ policy_id: row.policy_id }));
}

async function fetchCandidatePolicies(policyIds) {
  if (!policyIds.length) return [];
  const idsSql = sql.join(policyIds.map(id => sql`${id}`), sql`, `);
  const result = await db.execute(sql`
    SELECT
      id,
      policy_number,
      title,
      domain,
      sub_domain,
      dcf_citations,
      tjc_citations,
      source_type
    FROM policies
    WHERE id IN (${idsSql})
  `);
  return rowsOf(result);
}

async function fetchCandidateProvisions(policyIds) {
  if (!policyIds.length) return [];
  const idsSql = sql.join(policyIds.map(id => sql`${id}`), sql`, `);
  const result = await db.execute(sql`
    SELECT
      id,
      policy_id,
      text,
      section,
      source_citation
    FROM provisions
    WHERE policy_id IN (${idsSql})
  `);
  return rowsOf(result);
}

export async function findCandidatesHybrid(obligation, opts = {}) {
  const cfg = {
    MAX_CANDIDATES: opts.MAX_CANDIDATES ?? MAX_CANDIDATES,
    MAX_STAGE1_POLICIES: opts.MAX_STAGE1_POLICIES ?? MAX_STAGE1_POLICIES,
    MIN_SCORE: opts.MIN_SCORE ?? MIN_SCORE,
    VECTOR_LIMIT: opts.VECTOR_LIMIT ?? VECTOR_LIMIT,
    FTS_LIMIT: opts.FTS_LIMIT ?? FTS_LIMIT,
    TITLE_LIMIT: opts.TITLE_LIMIT ?? TITLE_LIMIT,
    SUBDOMAIN_LIMIT: opts.SUBDOMAIN_LIMIT ?? SUBDOMAIN_LIMIT,
    MIN_FTS_RANK: opts.MIN_FTS_RANK ?? MIN_FTS_RANK,
    disableVector: opts.disableVector ?? false,
    disableFts: opts.disableFts ?? false,
    disableCitation: opts.disableCitation ?? false,
    disableTitle: opts.disableTitle ?? false,
    disableSubDomain: opts.disableSubDomain ?? false,
    disableKeyword: opts.disableKeyword ?? false,
    debug: opts.debug ?? false,
  };

  const debugInfo = cfg.debug ? {
    sourceCounts: {
      vector: 0,
      fts: 0,
      citation: 0,
      title: 0,
      subdomain: 0,
    },
    stage1Total: 0,
    stage1AfterCap: 0,
    preFilterCount: 0,
    postFilterCount: 0,
    finalCount: 0,
    emptyReason: null,
    topCandidates: [],
  } : null;

  const scores = {};
  const provisionSimilarityMap = {};
  const provisionKeywordOverlapMap = {};
  const oblKeywords = extractKeywords(obligation.requirement);
  const obligationTokens = extractSearchTokens(obligation.requirement);
  const requirementSearchText = (obligation.requirement || '').trim();
  const oblPrefixes = citationPrefixes(obligation.citation);

  function addScore(policyId, policy, method, detail, score) {
    if (!scores[policyId]) {
      scores[policyId] = {
        policy,
        citation: 0,
        sub_domain: 0,
        keyword: 0,
        title: 0,
        vector: 0,
        fts: 0,
        methods: [],
      };
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

  const labelsData = await db.select({
    prefix: subDomainLabels.prefix,
    affinity_keywords: subDomainLabels.affinity_keywords,
  }).from(subDomainLabels);

  const matchedSubDomains = [];
  const oblText = obligation.requirement.toLowerCase();
  for (const label of labelsData) {
    const affinityKw = label.affinity_keywords || [];
    if (affinityKw.some(keyword => oblText.includes(keyword.toLowerCase()))) {
      matchedSubDomains.push(label.prefix);
    }
  }

  const [
    vectorCandidates,
    ftsCandidates,
    citationCandidates,
    titleCandidates,
    subDomainCandidates,
  ] = await Promise.all([
    cfg.disableVector ? [] : fetchVectorCandidates(obligation, cfg.VECTOR_LIMIT),
    cfg.disableFts ? [] : fetchFtsCandidates(requirementSearchText, cfg.FTS_LIMIT, cfg.MIN_FTS_RANK),
    cfg.disableCitation ? [] : fetchCitationCandidates(oblPrefixes),
    cfg.disableTitle ? [] : fetchTitleCandidates(oblKeywords, cfg.TITLE_LIMIT),
    cfg.disableSubDomain ? [] : fetchSubDomainCandidates([...new Set(matchedSubDomains)], cfg.SUBDOMAIN_LIMIT),
  ]);

  if (debugInfo) {
    debugInfo.sourceCounts.vector = vectorCandidates.length;
    debugInfo.sourceCounts.fts = ftsCandidates.length;
    debugInfo.sourceCounts.citation = citationCandidates.length;
    debugInfo.sourceCounts.title = titleCandidates.length;
    debugInfo.sourceCounts.subdomain = subDomainCandidates.length;
  }

  const stage1Scores = new Map();

  for (const row of vectorCandidates) {
    bumpStage1Score(stage1Scores, row.policy_id, Math.round(row.similarity * 100));
    provisionSimilarityMap[row.provision_id] = Math.max(
      provisionSimilarityMap[row.provision_id] || 0,
      row.similarity
    );
  }

  const topFtsRank = ftsCandidates.length > 0
    ? Math.max(...ftsCandidates.map(row => row.rank))
    : 0;
  for (const row of ftsCandidates) {
    if (topFtsRank > 0) {
      bumpStage1Score(stage1Scores, row.policy_id, Math.round((row.rank / topFtsRank) * 60));
    }
    provisionKeywordOverlapMap[row.provision_id] = Math.max(
      provisionKeywordOverlapMap[row.provision_id] || 0,
      row.rank
    );
  }

  for (const row of citationCandidates) {
    const baseScore = row.match_type === 'exact' ? CITATION_EXACT : CITATION_SECTION;
    const penalty = row.popularity > 10 ? 0.3 : row.popularity > 5 ? 0.5 : row.popularity > 2 ? 0.75 : 1;
    bumpStage1Score(stage1Scores, row.policy_id, Math.round(baseScore * penalty));
  }

  for (const row of titleCandidates) {
    bumpStage1Score(stage1Scores, row.policy_id, Math.min(row.hits * 14, 42));
  }

  for (const row of subDomainCandidates) {
    bumpStage1Score(stage1Scores, row.policy_id, SUBDOMAIN_MATCH);
  }

  if (debugInfo) {
    debugInfo.stage1Total = stage1Scores.size;
  }

  const candidatePolicyIds = [...stage1Scores.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, cfg.MAX_STAGE1_POLICIES)
    .map(([policyId]) => policyId);

  if (debugInfo) {
    debugInfo.stage1AfterCap = candidatePolicyIds.length;
  }

  if (candidatePolicyIds.length === 0) {
    if (debugInfo) {
      debugInfo.emptyReason = 'STAGE1_EMPTY';
      return { candidates: [], provisionsByPolicy: {}, provisionSimilarityMap, provisionKeywordOverlapMap, debugInfo };
    }
    return { candidates: [], provisionsByPolicy: {}, provisionSimilarityMap, provisionKeywordOverlapMap };
  }

  const [policiesData, provisionsData] = await Promise.all([
    fetchCandidatePolicies(candidatePolicyIds),
    fetchCandidateProvisions(candidatePolicyIds),
  ]);

  const policyById = new Map(policiesData.map(policy => [policy.id, policy]));
  const provsByPolicy = {};
  for (const prov of provisionsData) {
    if (!provsByPolicy[prov.policy_id]) provsByPolicy[prov.policy_id] = [];
    provsByPolicy[prov.policy_id].push(prov);
  }

  const policyBestVector = {};
  for (const row of vectorCandidates) {
    if (!policyById.has(row.policy_id)) continue;
    if (!policyBestVector[row.policy_id] || row.similarity > policyBestVector[row.policy_id]) {
      policyBestVector[row.policy_id] = row.similarity;
    }
  }
  for (const [policyId, similarity] of Object.entries(policyBestVector)) {
    const policy = policyById.get(policyId);
    if (!policy) continue;
    addScore(
      policyId,
      policy,
      'vector',
      `similarity: ${similarity.toFixed(3)}`,
      Math.round(similarity * VECTOR_WEIGHT)
    );
  }

  for (const row of citationCandidates) {
    const policy = policyById.get(row.policy_id);
    if (!policy) continue;
    const penalty = row.popularity > 10 ? 0.3 : row.popularity > 5 ? 0.5 : row.popularity > 2 ? 0.75 : 1;
    const baseScore = row.match_type === 'exact' ? CITATION_EXACT : CITATION_SECTION;
    addScore(
      row.policy_id,
      policy,
      'citation',
      `${row.match_type}: ${row.citation} (${row.popularity} cite)`,
      Math.round(baseScore * penalty)
    );
  }

  if (!cfg.disableSubDomain) {
    const matchedSubDomainSet = new Set(matchedSubDomains);
    for (const policy of policiesData) {
      if (policy.sub_domain && matchedSubDomainSet.has(policy.sub_domain)) {
        addScore(policy.id, policy, 'sub_domain', `${policy.sub_domain} affinity`, SUBDOMAIN_MATCH);
      }
    }
  }

  const policyBestFts = {};
  for (const row of ftsCandidates) {
    if (!policyById.has(row.policy_id)) continue;
    if (!policyBestFts[row.policy_id] || row.rank > policyBestFts[row.policy_id]) {
      policyBestFts[row.policy_id] = row.rank;
    }
  }
  const topCandidateFtsRank = Object.keys(policyBestFts).length > 0
    ? Math.max(...Object.values(policyBestFts))
    : 0;
  for (const [policyId, rank] of Object.entries(policyBestFts)) {
    const policy = policyById.get(policyId);
    if (!policy || topCandidateFtsRank <= 0) continue;
    const normalized = Math.min(rank / topCandidateFtsRank, 1);
    const ftsScore = Math.round(normalized * FTS_WEIGHT);
    addScore(policyId, policy, 'fts', `fts rank: ${rank.toFixed(4)}`, ftsScore);
  }

  if (!cfg.disableKeyword && (oblKeywords.length > 0 || obligationTokens.length > 0)) {
    for (const [policyId, provs] of Object.entries(provsByPolicy)) {
      let bestKeywordScore = 0;
      let bestOverlap = 0;
      let highValueHits = 0;
      let bestTokenOverlap = 0;

      for (const prov of provs) {
        const provKeywords = extractKeywords(prov.text);
        const overlap = oblKeywords.filter(keyword => provKeywords.includes(keyword));
        const overlapHighValue = overlap.filter(keyword => HIGH_VALUE_KEYWORDS.has(keyword)).length;
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
        const policy = policyById.get(policyId);
        if (!policy) continue;
        const tokenOnlyMatch = bestOverlap === 0 && highValueHits === 0;
        const tokenScore = tokenOnlyMatch
          ? Math.min(bestTokenOverlap, 2) * 3
          : Math.min(bestTokenOverlap, 4) * 4;
        const kwScore = Math.min(
          KEYWORD_BASE + bestOverlap * KEYWORD_BONUS + highValueHits * 10 + tokenScore,
          tokenOnlyMatch ? TOKEN_ONLY_KEYWORD_CAP : 70
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

    for (const policy of policiesData) {
      const titleKeywords = extractKeywords(policy.title);
      const overlap = oblKeywords.filter(keyword => titleKeywords.includes(keyword));
      if (overlap.length >= 1) {
        const highValueHits = overlap.filter(keyword => HIGH_VALUE_KEYWORDS.has(keyword)).length;
        const titleScore = Math.min(6 + overlap.length * 8 + highValueHits * 10, 40);
        addScore(policy.id, policy, 'title', `${overlap.length} title keywords`, titleScore);
      }
    }
  }

  const allScored = Object.values(scores)
    .map(({ policy, citation, sub_domain, keyword, title, vector, fts, methods }) => {
      const score = citation + sub_domain + keyword + title + vector + fts;
      const isComposite = COMPOSITE_DOC_TYPES.has(policy.source_type);
      const adjustedKeyword = isComposite ? Math.round(keyword * COMPOSITE_DOC_DAMPENER) : keyword;
      const adjustedTitle = isComposite ? Math.round(title * COMPOSITE_DOC_DAMPENER) : title;
      const adjustedFts = isComposite ? Math.round(fts * COMPOSITE_DOC_DAMPENER) : fts;
      const adjustedScore = citation + sub_domain + adjustedKeyword + adjustedTitle + vector + adjustedFts;
      const routingBoost = getRoutingBoost(obligation.citation, policy.domain);
      const routedScore = adjustedScore + routingBoost;
      const lexicalSupport = citation > 0 || fts > 0 || title > 0;
      const rankScore = routedScore + (vector > 0 && lexicalSupport ? CONSENSUS_RANK_BONUS : 0);
      return {
        policy_id: policy.id,
        policy_number: policy.policy_number,
        title: policy.title,
        domain: policy.domain,
        sub_domain: policy.sub_domain,
        score: routedScore,
        raw_score: score,
        rank_score: rankScore,
        signal_breakdown: { citation, sub_domain, keyword, title, vector, fts },
        methods,
      };
    })
    .sort((a, b) => b.rank_score - a.rank_score || b.score - a.score);

  if (debugInfo) {
    debugInfo.preFilterCount = allScored.length;
    debugInfo.topCandidates = allScored.slice(0, 5).map(c => ({
      policy_id: c.policy_id,
      policy_number: c.policy_number,
      title: c.title,
      score: c.score,
      rank_score: c.rank_score,
      vector: c.signal_breakdown.vector,
      fts: c.signal_breakdown.fts,
      citation: c.signal_breakdown.citation,
      subdomain: c.signal_breakdown.sub_domain,
      keyword: c.signal_breakdown.keyword,
      title_score: c.signal_breakdown.title,
    }));
  }

  const filtered = allScored.filter(candidate => candidate.score >= cfg.MIN_SCORE);

  if (debugInfo) {
    debugInfo.postFilterCount = filtered.length;
  }

  const candidates = filtered.slice(0, cfg.MAX_CANDIDATES);

  if (debugInfo) {
    debugInfo.finalCount = candidates.length;
    if (candidates.length > 0) {
      debugInfo.emptyReason = 'RETURNED_CANDIDATES';
    } else if (allScored.length > 0) {
      debugInfo.emptyReason = 'FILTERED_BY_MIN_SCORE';
    } else {
      debugInfo.emptyReason = 'STAGE1_EMPTY';
    }
    return { candidates, provisionsByPolicy: provsByPolicy, provisionSimilarityMap, provisionKeywordOverlapMap, debugInfo };
  }

  return { candidates, provisionsByPolicy: provsByPolicy, provisionSimilarityMap, provisionKeywordOverlapMap };
}

export const findCandidates = findCandidatesHybrid;
