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

/**
 * Hybrid matching: combine vector similarity with keyword/citation signals
 */
export async function findCandidatesHybrid(obligation, policiesData, provisionsData, labelsData) {
  const scores = {};

  function addScore(policyId, policy, method, detail, score) {
    if (!scores[policyId]) {
      scores[policyId] = { policy, citation: 0, sub_domain: 0, keyword: 0, title: 0, vector: 0, methods: [] };
    }
    const bucket = method === 'citation' ? 'citation' : method === 'sub_domain' ? 'sub_domain' : method === 'title' ? 'title' : method === 'vector' ? 'vector' : 'keyword';
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
  const oblKeywords = extractKeywords(obligation.requirement);

  if (oblKeywords.length > 0) {
    const provsByPolicy = {};
    for (const prov of provisionsData) {
      if (!provsByPolicy[prov.policy_id]) provsByPolicy[prov.policy_id] = [];
      provsByPolicy[prov.policy_id].push(prov);
    }

    for (const [policyId, provs] of Object.entries(provsByPolicy)) {
      let bestOverlap = 0;
      let highValueHits = 0;
      for (const prov of provs) {
        const provKeywords = extractKeywords(prov.text);
        const overlap = oblKeywords.filter(kw => provKeywords.includes(kw));
        if (overlap.length > bestOverlap) {
          bestOverlap = overlap.length;
          highValueHits = overlap.filter(kw => HIGH_VALUE_KEYWORDS.has(kw)).length;
        }
      }
      if (bestOverlap >= 1) {
        const policy = policiesData.find(p => p.id === policyId);
        if (policy) {
          const kwScore = Math.min(KEYWORD_BASE + bestOverlap * KEYWORD_BONUS + highValueHits * 10, 70);
          addScore(policyId, policy, 'keyword', `${bestOverlap} keywords (${highValueHits} high-value)`, kwScore);
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
  return Object.values(scores)
    .map(({ policy, citation, sub_domain, keyword, title, vector, methods }) => ({
      policy_id: policy.id,
      policy_number: policy.policy_number,
      title: policy.title,
      domain: policy.domain,
      sub_domain: policy.sub_domain,
      score: citation + sub_domain + keyword + title + vector,
      signal_breakdown: { citation, sub_domain, keyword, title, vector },
      methods,
    }))
    .filter(c => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

// Re-export for backward compatibility
export const findCandidates = findCandidatesHybrid;
