import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env.local');
const artifactsDir = path.join(repoRoot, 'artifacts');

const mapRunId = process.argv[2] || 'run_mm8f0sr6_m5fglsty';
const sampleSize = Number(process.argv[3] || 100);

await loadEnvFile(envPath);

const [{ db, dbClient }, { sql }, { findCandidatesHybrid }] = await Promise.all([
  import(pathToFileURL(path.join(repoRoot, 'lib', 'db.js')).href),
  import('drizzle-orm'),
  import(pathToFileURL(path.join(repoRoot, 'lib', 'matching.js')).href),
]);

try {
  const sampledObligations = rowsOf(await db.execute(sql`
    WITH latest_assessments AS (
      SELECT DISTINCT ON (ca.obligation_id)
        ca.obligation_id,
        ca.covering_policy_number,
        o.citation,
        o.requirement
      FROM coverage_assessments ca
      JOIN obligations o ON o.id = ca.obligation_id
      WHERE ca.map_run_id = ${mapRunId}
        AND ca.covering_policy_number IS NOT NULL
        AND ca.covering_policy_number <> ''
      ORDER BY
        ca.obligation_id,
        ca.updated_at DESC NULLS LAST,
        ca.created_at DESC NULLS LAST,
        ca.id DESC
    )
    SELECT
      la.obligation_id,
      la.citation,
      la.requirement,
      la.covering_policy_number,
      p.title AS benchmark_title
    FROM latest_assessments la
    LEFT JOIN policies p
      ON upper(regexp_replace(coalesce(p.policy_number, ''), '[\\s-]+', '', 'g')) =
         upper(regexp_replace(coalesce(la.covering_policy_number, ''), '[\\s-]+', '', 'g'))
    ORDER BY md5(la.obligation_id)
    LIMIT ${sampleSize}
  `));

  const rows = [];
  for (const obligation of sampledObligations) {
    const startedAt = Date.now();
    const { candidates } = await findCandidatesHybrid({
      id: obligation.obligation_id,
      citation: obligation.citation,
      requirement: obligation.requirement,
    });
    const latencyMs = Date.now() - startedAt;

    const normalizedBenchmark = normalizePolicyNumber(obligation.covering_policy_number);
    const topPolicies = candidates.map(candidate => ({
      policy_number: candidate.policy_number,
      title: candidate.title,
      normalized: normalizePolicyNumber(candidate.policy_number),
      score: candidate.score,
      rank_score: candidate.rank_score,
      signal_breakdown: candidate.signal_breakdown,
    }));

    const foundIndex = topPolicies.findIndex(candidate => candidate.normalized === normalizedBenchmark);
    const top5 = topPolicies.slice(0, 5);
    const matchedCandidate = foundIndex >= 0 ? topPolicies[foundIndex] : null;

    rows.push({
      obligation_id: obligation.obligation_id,
      citation: obligation.citation,
      requirement: obligation.requirement,
      benchmark_policy_number: obligation.covering_policy_number,
      benchmark_title: obligation.benchmark_title || '',
      top1_policy_number: topPolicies[0]?.policy_number || '',
      top1_title: topPolicies[0]?.title || '',
      found_rank: foundIndex >= 0 ? foundIndex + 1 : null,
      top1_hit: foundIndex === 0,
      top3_hit: foundIndex >= 0 && foundIndex < 3,
      top5_hit: foundIndex >= 0 && foundIndex < 5,
      top10_hit: foundIndex >= 0 && foundIndex < 10,
      latency_ms: latencyMs,
      top1_has_vector: Number(topPolicies[0]?.signal_breakdown?.vector || 0) > 0,
      top1_has_fts: Number(topPolicies[0]?.signal_breakdown?.fts || 0) > 0,
      any_top5_has_vector: top5.some(candidate => Number(candidate.signal_breakdown?.vector || 0) > 0),
      any_top5_has_fts: top5.some(candidate => Number(candidate.signal_breakdown?.fts || 0) > 0),
      top5_candidates: top5.map((candidate, index) => ({
        rank: index + 1,
        policy_number: candidate.policy_number,
        title: candidate.title,
        score: candidate.score,
        rank_score: candidate.rank_score,
        signal_breakdown: candidate.signal_breakdown,
      })),
      top1_signal_breakdown: topPolicies[0]?.signal_breakdown || null,
      matched_signal_breakdown: matchedCandidate?.signal_breakdown || null,
      review_label: '',
      comments: '',
    });
  }

  const payload = {
    map_run_id: mapRunId,
    sample_size: sampleSize,
    generated_at: new Date().toISOString(),
    summary: summarize(rows),
    rows,
  };

  await mkdir(artifactsDir, { recursive: true });
  const outputPath = path.join(artifactsDir, `matching_benchmark_${mapRunId}_n${sampleSize}.json`);
  await writeFile(outputPath, JSON.stringify(payload, null, 2));

  console.log(JSON.stringify({
    output_path: outputPath,
    summary: payload.summary,
  }, null, 2));
} finally {
  await dbClient.end({ timeout: 5 });
}

function rowsOf(result) {
  return result?.rows || result || [];
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

function normalizePolicyNumber(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s-]+/g, '');
}

function summarize(rows) {
  return {
    total: rows.length,
    top1: rows.filter(row => row.top1_hit).length,
    top3: rows.filter(row => row.top3_hit).length,
    top5: rows.filter(row => row.top5_hit).length,
    top10: rows.filter(row => row.top10_hit).length,
    avg_latency_ms: round(average(rows.map(row => row.latency_ms))),
    p95_latency_ms: percentile(rows.map(row => row.latency_ms), 95),
    top1_with_vector: rows.filter(row => row.top1_has_vector).length,
    top1_with_fts: rows.filter(row => row.top1_has_fts).length,
    any_top5_with_vector: rows.filter(row => row.any_top5_has_vector).length,
    any_top5_with_fts: rows.filter(row => row.any_top5_has_fts).length,
  };
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
