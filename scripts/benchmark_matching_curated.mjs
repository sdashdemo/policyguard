import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env.local');
const labelsPath = path.join(__dirname, 'matching_audit_labels.json');
const mapRunId = process.argv[2] || 'run_mm8f0sr6_m5fglsty';

await loadEnvFile(envPath);

const [{ db, dbClient }, { sql }, { findCandidatesHybrid }] = await Promise.all([
  import(pathToFileURL(path.join(repoRoot, 'lib', 'db.js')).href),
  import('drizzle-orm'),
  import(pathToFileURL(path.join(repoRoot, 'lib', 'matching.js')).href),
]);

try {
  const labels = JSON.parse(await readFile(labelsPath, 'utf8'));
  const labelByCitation = new Map(labels.map(label => [label.citation, label]));
  const citationsSql = sql.join(labels.map(label => sql`${label.citation}`), sql`, `);
  const result = await db.execute(sql`
    SELECT DISTINCT ON (o.citation)
      ca.obligation_id,
      ca.covering_policy_number,
      o.citation,
      o.requirement
    FROM coverage_assessments ca
    JOIN obligations o ON o.id = ca.obligation_id
    WHERE ca.map_run_id = ${mapRunId}
      AND o.citation IN (${citationsSql})
    ORDER BY o.citation, ca.created_at DESC NULLS LAST, ca.id DESC
  `);

  const obligations = rowsOf(result).map(row => ({
    obligation_id: row.obligation_id,
    citation: row.citation,
    requirement: row.requirement,
    benchmark_policy_number: row.covering_policy_number,
    ...labelByCitation.get(row.citation),
  }));

  const found = new Set(obligations.map(row => row.citation));
  const missing = labels
    .map(label => label.citation)
    .filter(citation => !found.has(citation));
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.length} audited citations in ${mapRunId}: ${missing.join(', ')}`);
  }

  const rows = [];
  for (const obligation of obligations) {
    const startedAt = Date.now();
    const { candidates } = await findCandidatesHybrid({
      id: obligation.obligation_id,
      citation: obligation.citation,
      requirement: obligation.requirement,
    });
    const latencyMs = Date.now() - startedAt;
    const accepted = new Set(obligation.accepted_policy_numbers.map(normalizePolicyNumber));
    const topPolicies = candidates.map(candidate => ({
      policy_number: candidate.policy_number,
      normalized: normalizePolicyNumber(candidate.policy_number),
      score: candidate.score,
      rank_score: candidate.rank_score,
      signal_breakdown: candidate.signal_breakdown,
    }));
    const foundRank = topPolicies.findIndex(candidate => accepted.has(candidate.normalized));
    const matchedCandidate = foundRank >= 0 ? topPolicies[foundRank] : null;

    rows.push({
      citation: obligation.citation,
      bucket: obligation.bucket,
      benchmark_policy_number: obligation.benchmark_policy_number,
      accepted_policy_numbers: obligation.accepted_policy_numbers,
      top1_policy_number: topPolicies[0]?.policy_number || null,
      found_rank: foundRank >= 0 ? foundRank + 1 : null,
      top1_hit: foundRank === 0,
      top3_hit: foundRank >= 0 && foundRank < 3,
      top10_hit: foundRank >= 0 && foundRank < 10,
      latency_ms: latencyMs,
      top1_signal_breakdown: topPolicies[0]?.signal_breakdown || null,
      matched_signal_breakdown: matchedCandidate?.signal_breakdown || null,
    });
  }

  const summary = summarize(rows);
  console.log(JSON.stringify({ map_run_id: mapRunId, summary, rows }, null, 2));
} finally {
  await dbClient.end({ timeout: 5 });
}

function rowsOf(result) {
  return result?.rows || result || [];
}

function normalizePolicyNumber(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s-]+/g, '');
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

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function summarize(rows) {
  const buckets = ['gold', 'soft', 'all'];
  const summary = {};
  for (const bucket of buckets) {
    const bucketRows = bucket === 'all'
      ? rows
      : rows.filter(row => row.bucket === bucket);
    summary[bucket] = {
      total: bucketRows.length,
      top1: bucketRows.filter(row => row.top1_hit).length,
      top3: bucketRows.filter(row => row.top3_hit).length,
      top10: bucketRows.filter(row => row.top10_hit).length,
      avg_latency_ms: round(average(bucketRows.map(row => row.latency_ms))),
      p95_latency_ms: percentile(bucketRows.map(row => row.latency_ms), 95),
    };
  }
  return summary;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function round(value) {
  return Math.round(value * 10) / 10;
}
