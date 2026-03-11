import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env.local');

await loadEnvFile(envPath);

const [{ db, dbClient }, { sql }, { findCandidatesHybrid }] = await Promise.all([
  import(pathToFileURL(path.join(repoRoot, 'lib', 'db.js')).href),
  import('drizzle-orm'),
  import(pathToFileURL(path.join(repoRoot, 'lib', 'matching.js')).href),
]);

// ---------------------------------------------------------------------------
// Mode definitions
// ---------------------------------------------------------------------------
const MODES = {
  baseline: { debug: true },
  relaxed_a: {
    debug: true,
    MAX_STAGE1_POLICIES: 100,
    MAX_CANDIDATES: 25,
    FTS_LIMIT: 250,
    VECTOR_LIMIT: 50,
  },
  relaxed_b: {
    debug: true,
    MAX_STAGE1_POLICIES: 100,
    MAX_CANDIDATES: 25,
    FTS_LIMIT: 250,
    VECTOR_LIMIT: 50,
    MIN_SCORE: 8,
    MIN_FTS_RANK: 0.001,
  },
  vector_only: {
    debug: true,
    disableFts: true,
    disableCitation: true,
    disableTitle: true,
    disableSubDomain: true,
    disableKeyword: true,
  },
  fts_only: {
    debug: true,
    disableVector: true,
    disableCitation: true,
    disableTitle: true,
    disableSubDomain: true,
    disableKeyword: true,
  },
  lexical_seeded: {
    debug: true,
    disableVector: true,
    disableFts: true,
    disableSubDomain: true,
  },
};

const MODE_NAMES = Object.keys(MODES);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rowsOf(result) {
  return result?.rows || result || [];
}

function summarizeMode(result) {
  const { candidates, debugInfo } = result;
  const top = candidates.length > 0 ? candidates[0] : null;
  return {
    candidate_count: candidates.length,
    top_score: top ? top.score : null,
    top_policy_id: top ? top.policy_id : null,
    top_policy_number: top ? top.policy_number : null,
    top_policy_title: top ? top.title : null,
    emptyReason: debugInfo.emptyReason,
    stage1Total: debugInfo.stage1Total,
    stage1AfterCap: debugInfo.stage1AfterCap,
    preFilterCount: debugInfo.preFilterCount,
    postFilterCount: debugInfo.postFilterCount,
    finalCount: debugInfo.finalCount,
  };
}

function assignBucket(summaries) {
  const {
    baseline,
    relaxed_a,
    relaxed_b,
    vector_only,
    fts_only,
    lexical_seeded,
  } = summaries;

  // (1) NO_SIGNAL_ANYWHERE
  const allEmpty = MODE_NAMES.every(m => summaries[m].candidate_count === 0);
  const allStage1Zero = MODE_NAMES.every(m => summaries[m].stage1Total === 0);
  if (allEmpty && allStage1Zero) return 'NO_SIGNAL_ANYWHERE';

  // (2) STAGE1_EMPTY_BASELINE
  if (
    baseline.stage1Total === 0 &&
    (relaxed_a.candidate_count > 0 || relaxed_b.candidate_count > 0)
  ) return 'STAGE1_EMPTY_BASELINE';

  // (3) MIN_SCORE_SUPPRESSION
  if (
    baseline.stage1Total > 0 &&
    baseline.candidate_count === 0 &&
    baseline.emptyReason === 'FILTERED_BY_MIN_SCORE' &&
    relaxed_b.candidate_count > 0
  ) return 'MIN_SCORE_SUPPRESSION';

  // (4) VECTOR_ONLY_SIGNAL
  if (
    vector_only.candidate_count > 0 &&
    fts_only.candidate_count === 0 &&
    lexical_seeded.candidate_count === 0 &&
    baseline.candidate_count === 0
  ) return 'VECTOR_ONLY_SIGNAL';

  // (5) FTS_ONLY_SIGNAL
  if (
    fts_only.candidate_count > 0 &&
    vector_only.candidate_count === 0 &&
    lexical_seeded.candidate_count === 0 &&
    baseline.candidate_count === 0
  ) return 'FTS_ONLY_SIGNAL';

  // (6) PLAUSIBLE_UNDER_RELAXATION
  if (
    baseline.candidate_count === 0 &&
    (relaxed_a.candidate_count > 0 || relaxed_b.candidate_count > 0)
  ) return 'PLAUSIBLE_UNDER_RELAXATION';

  // (7) LIKELY_TRUE_GAP
  const anyHighScore = MODE_NAMES.some(m => summaries[m].top_score !== null && summaries[m].top_score >= 15);
  const anyMeaningfulStage1 = MODE_NAMES.some(m => summaries[m].stage1Total > 0);
  if (!anyHighScore && !anyMeaningfulStage1) return 'LIKELY_TRUE_GAP';

  // Fallback — doesn't fit neatly into any bucket
  return 'LIKELY_TRUE_GAP';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
try {
  // 1. Find the latest completed run
  const runRows = rowsOf(await db.execute(sql`
    SELECT id FROM map_runs
    WHERE status = 'completed'
    ORDER BY completed_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
  `));

  if (runRows.length === 0) {
    console.error('No completed map_runs found.');
    process.exit(1);
  }

  const mapRunId = runRows[0].id;
  console.error(`Using map_run_id: ${mapRunId}`);

  // 2. Load GAP obligations with policy_id IS NULL
  const gapRows = rowsOf(await db.execute(sql`
    SELECT
      ca.obligation_id,
      o.id,
      o.citation,
      o.requirement,
      o.org_id,
      o.reg_source_id,
      o.parent_id,
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
    WHERE ca.map_run_id = ${mapRunId}
      AND ca.status = 'GAP'
      AND ca.policy_id IS NULL
    ORDER BY o.citation
  `));

  const total = gapRows.length;
  console.error(`Found ${total} GAP obligations with no policy_id`);

  if (total === 0) {
    console.error('Nothing to diagnose.');
    process.exit(0);
  }

  // 3. Run diagnostics
  const results = [];
  const bucketCounts = {};

  for (let i = 0; i < total; i++) {
    const row = gapRows[i];

    if ((i + 1) % 10 === 0 || i === 0) {
      console.error(`[${i + 1}/${total}] ${row.citation}...`);
    }

    // Construct the full obligation object matching the caller shape
    const obligation = {
      id: row.id,
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

    const entry = {
      map_run_id: mapRunId,
      obligation_id: row.id,
      citation: row.citation,
      obligation_text: (row.requirement || '').slice(0, 200),
      domain: row.source_type || null,
    };

    try {
      const summaries = {};
      for (const modeName of MODE_NAMES) {
        const result = await findCandidatesHybrid(obligation, MODES[modeName]);
        summaries[modeName] = summarizeMode(result);
      }

      Object.assign(entry, summaries);
      entry.diagnostic_bucket = assignBucket(summaries);
    } catch (err) {
      console.error(`  ERROR on ${row.citation}: ${err.message}`);
      entry.error = err.message;
      entry.diagnostic_bucket = 'ERROR';
      for (const modeName of MODE_NAMES) {
        if (!entry[modeName]) {
          entry[modeName] = {
            candidate_count: 0,
            top_score: null,
            top_policy_id: null,
            top_policy_number: null,
            top_policy_title: null,
            emptyReason: null,
            stage1Total: 0,
            stage1AfterCap: 0,
            preFilterCount: 0,
            postFilterCount: 0,
            finalCount: 0,
          };
        }
      }
    }

    bucketCounts[entry.diagnostic_bucket] = (bucketCounts[entry.diagnostic_bucket] || 0) + 1;
    results.push(entry);
  }

  // 4. Write output JSON
  const outputPath = path.join(repoRoot, 'scripts', 'diagnostic_nomatch_results.json');
  await writeFile(outputPath, JSON.stringify(results, null, 2));
  console.error(`\nResults written to ${outputPath}`);

  // 5. Print summary to stdout
  const BUCKET_ORDER = [
    'NO_SIGNAL_ANYWHERE',
    'STAGE1_EMPTY_BASELINE',
    'MIN_SCORE_SUPPRESSION',
    'VECTOR_ONLY_SIGNAL',
    'FTS_ONLY_SIGNAL',
    'PLAUSIBLE_UNDER_RELAXATION',
    'LIKELY_TRUE_GAP',
  ];

  console.log('\n=== NO_MATCH DIAGNOSTIC SUMMARY ===');
  console.log(`Total: ${total}`);
  for (const bucket of BUCKET_ORDER) {
    console.log(`${bucket}: ${bucketCounts[bucket] || 0}`);
  }
  // Print any extra buckets (e.g. ERROR)
  for (const [bucket, count] of Object.entries(bucketCounts)) {
    if (!BUCKET_ORDER.includes(bucket)) {
      console.log(`${bucket}: ${count}`);
    }
  }

} finally {
  await dbClient.end({ timeout: 5 });
}

// ---------------------------------------------------------------------------
// Env loader (repo pattern)
// ---------------------------------------------------------------------------
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
