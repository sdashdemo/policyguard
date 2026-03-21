import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(repoRoot, 'artifacts');

const RUN_ID = 'run_mmuoz0vl_0xql2cp1';
const LINK_BASIS = 'covering_policy_number_backfill';
const STATUS_SCOPE = ['GAP', 'PARTIAL'];
const OUTPUT_JSON_PATH = path.join(
  artifactsDir,
  `assessment_policy_links_backfill_${RUN_ID}.json`,
);
const OUTPUT_CSV_PATH = path.join(
  artifactsDir,
  `assessment_policy_links_backfill_${RUN_ID}.csv`,
);

const CSV_COLUMNS = [
  'classification',
  'assessment_id',
  'status',
  'citation',
  'covering_policy_number',
  'requirement_snippet',
  'candidate_count',
  'candidate_policy_ids',
  'candidate_policy_titles',
  'candidate_policy_metadata',
];

await loadEnvFile(path.join(repoRoot, '.env.local'));

const [{ dbClient }] = await Promise.all([
  import(pathToFileURL(path.join(repoRoot, 'lib', 'db.js')).href),
]);

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function trimSnippet(value, maxLength = 180) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function compareManualReviewRows(a, b) {
  return (
    String(a.coveringPolicyNumber || '').localeCompare(String(b.coveringPolicyNumber || ''))
    || String(a.citation || '').localeCompare(String(b.citation || ''))
    || String(a.assessmentId || '').localeCompare(String(b.assessmentId || ''))
  );
}

function candidateSummary(candidate) {
  return [
    candidate.policyId,
    candidate.title || 'Untitled policy',
    candidate.domain || '-',
    candidate.subDomain || '-',
    toIso(candidate.indexedAt) || '-',
    toIso(candidate.updatedAt) || '-',
    toIso(candidate.createdAt) || '-',
  ].join(' | ');
}

function flattenManualReviewRow(row, classification) {
  return {
    classification,
    assessment_id: row.assessmentId,
    status: row.status,
    citation: row.citation,
    covering_policy_number: row.coveringPolicyNumber,
    requirement_snippet: row.requirementSnippet,
    candidate_count: row.candidateCount,
    candidate_policy_ids: row.candidates.map((candidate) => candidate.policyId).join(' | '),
    candidate_policy_titles: row.candidates.map((candidate) => candidate.title || 'Untitled policy').join(' | '),
    candidate_policy_metadata: row.candidates.map(candidateSummary).join(' || '),
  };
}

function groupCandidateRows(rows) {
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row.assessment_id)) {
      grouped.set(row.assessment_id, {
        assessmentId: row.assessment_id,
        obligationId: row.obligation_id,
        status: row.status,
        citation: row.citation,
        coveringPolicyNumber: row.covering_policy_number,
        requirementSnippet: trimSnippet(row.requirement),
        candidateCount: toInt(row.candidate_count),
        candidates: [],
      });
    }

    const entry = grouped.get(row.assessment_id);
    if (row.candidate_policy_id) {
      entry.candidates.push({
        policyId: row.candidate_policy_id,
        policyNumber: row.candidate_policy_number,
        title: row.candidate_policy_title,
        domain: row.candidate_policy_domain,
        subDomain: row.candidate_policy_sub_domain,
        indexedAt: row.candidate_indexed_at,
        updatedAt: row.candidate_updated_at,
        createdAt: row.candidate_created_at,
      });
    }
  }

  return Array.from(grouped.values()).sort(compareManualReviewRows);
}

function summarizeAmbiguousPolicyNumbers(rows) {
  const counts = new Map();

  for (const row of rows) {
    const current = counts.get(row.coveringPolicyNumber) || 0;
    counts.set(row.coveringPolicyNumber, current + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => String(a[0] || '').localeCompare(String(b[0] || '')))
    .map(([policyNumber, assessmentCount]) => ({
      policyNumber,
      assessmentCount,
    }));
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
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function ensureAssessmentPolicyLinksTableExists() {
  const rows = await dbClient`
    SELECT to_regclass('public.assessment_policy_links') AS table_name
  `;

  if (!rows[0]?.table_name) {
    throw new Error(
      'assessment_policy_links does not exist yet. Run db-assessment-policy-links-migration.sql first.',
    );
  }
}

async function loadScopeSummary() {
  const rows = await dbClient`
    SELECT
      COUNT(*)::int AS remediation_assessment_count,
      COUNT(*) FILTER (
        WHERE NULLIF(BTRIM(covering_policy_number), '') IS NOT NULL
      )::int AS remediation_rows_with_covering_policy_number,
      COUNT(*) FILTER (
        WHERE NULLIF(BTRIM(covering_policy_number), '') IS NULL
      )::int AS remediation_rows_without_covering_policy_number
    FROM coverage_assessments
    WHERE map_run_id = ${RUN_ID}
      AND status IN ('GAP', 'PARTIAL')
  `;

  return rows[0] || {};
}

async function loadCandidateRows() {
  return dbClient`
    WITH target_rows AS (
      SELECT
        ca.id AS assessment_id,
        ca.obligation_id,
        ca.status,
        NULLIF(BTRIM(ca.covering_policy_number), '') AS covering_policy_number,
        o.citation,
        o.requirement
      FROM coverage_assessments ca
      JOIN obligations o ON o.id = ca.obligation_id
      WHERE ca.map_run_id = ${RUN_ID}
        AND ca.status IN ('GAP', 'PARTIAL')
        AND NULLIF(BTRIM(ca.covering_policy_number), '') IS NOT NULL
    ),
    candidate_rows AS (
      SELECT
        tr.assessment_id,
        tr.obligation_id,
        tr.status,
        tr.covering_policy_number,
        tr.citation,
        tr.requirement,
        p.id AS candidate_policy_id,
        p.policy_number AS candidate_policy_number,
        p.title AS candidate_policy_title,
        p.domain AS candidate_policy_domain,
        p.sub_domain AS candidate_policy_sub_domain,
        p.indexed_at AS candidate_indexed_at,
        p.updated_at AS candidate_updated_at,
        p.created_at AS candidate_created_at,
        COUNT(p.id) OVER (PARTITION BY tr.assessment_id)::int AS candidate_count,
        ROW_NUMBER() OVER (
          PARTITION BY tr.assessment_id
          ORDER BY
            p.indexed_at DESC NULLS LAST,
            p.updated_at DESC NULLS LAST,
            p.created_at DESC NULLS LAST,
            p.id ASC
        ) AS candidate_rank
      FROM target_rows tr
      LEFT JOIN policies p
        ON p.policy_number = tr.covering_policy_number
    )
    SELECT
      assessment_id,
      obligation_id,
      status,
      covering_policy_number,
      citation,
      requirement,
      candidate_policy_id,
      candidate_policy_number,
      candidate_policy_title,
      candidate_policy_domain,
      candidate_policy_sub_domain,
      candidate_indexed_at,
      candidate_updated_at,
      candidate_created_at,
      candidate_count,
      candidate_rank
    FROM candidate_rows
    ORDER BY
      covering_policy_number ASC,
      citation ASC,
      assessment_id ASC,
      candidate_rank ASC,
      candidate_policy_id ASC NULLS LAST
  `;
}

async function loadExistingLinks() {
  return dbClient`
    SELECT
      apl.assessment_id,
      apl.policy_id,
      apl.link_basis
    FROM assessment_policy_links apl
    JOIN coverage_assessments ca ON ca.id = apl.assessment_id
    WHERE ca.map_run_id = ${RUN_ID}
      AND ca.status IN ('GAP', 'PARTIAL')
  `;
}

async function replaceBackfillOwnedLinks(deterministicRows, existingRows) {
  const existingByAssessmentId = new Map(
    existingRows.map((row) => [
      row.assessment_id,
      {
        policyId: row.policy_id,
        linkBasis: row.link_basis,
      },
    ]),
  );

  const preservedExplicitSelections = deterministicRows.filter((row) => {
    const existing = existingByAssessmentId.get(row.assessmentId);
    return existing && existing.linkBasis !== LINK_BASIS;
  }).length;

  let deletedBackfillRows = 0;
  let insertedBackfillRows = 0;

  await dbClient.begin(async (tx) => {
    const deleteResult = await tx`
      DELETE FROM assessment_policy_links apl
      USING coverage_assessments ca
      WHERE apl.assessment_id = ca.id
        AND ca.map_run_id = ${RUN_ID}
        AND ca.status IN ('GAP', 'PARTIAL')
        AND apl.link_basis = ${LINK_BASIS}
    `;
    deletedBackfillRows = toInt(deleteResult.count);

    for (const row of deterministicRows) {
      const existing = existingByAssessmentId.get(row.assessmentId);
      if (existing && existing.linkBasis !== LINK_BASIS) {
        continue;
      }

      const inserted = await tx`
        INSERT INTO assessment_policy_links (
          assessment_id,
          policy_id,
          link_basis,
          linked_by,
          note,
          created_at,
          updated_at
        )
        VALUES (
          ${row.assessmentId},
          ${row.policyId},
          ${LINK_BASIS},
          NULL,
          NULL,
          now(),
          now()
        )
        ON CONFLICT (assessment_id) DO NOTHING
      `;
      insertedBackfillRows += toInt(inserted.count);
    }
  });

  return {
    deletedBackfillRows,
    insertedBackfillRows,
    preservedExplicitSelections,
  };
}

async function loadPostRunCounts() {
  const rows = await dbClient`
    SELECT
      COUNT(*) FILTER (WHERE apl.link_basis = ${LINK_BASIS})::int AS backfill_link_count,
      COUNT(*) FILTER (WHERE apl.link_basis = 'reviewer_selected')::int AS reviewer_selected_link_count
    FROM assessment_policy_links apl
    JOIN coverage_assessments ca ON ca.id = apl.assessment_id
    WHERE ca.map_run_id = ${RUN_ID}
      AND ca.status IN ('GAP', 'PARTIAL')
  `;

  return rows[0] || {};
}

try {
  await ensureAssessmentPolicyLinksTableExists();

  const [scopeSummary, candidateRows, existingRows] = await Promise.all([
    loadScopeSummary(),
    loadCandidateRows(),
    loadExistingLinks(),
  ]);

  const groupedRows = groupCandidateRows(candidateRows);
  const deterministicRows = [];
  const ambiguousRows = [];
  const unresolvedRows = [];

  for (const row of groupedRows) {
    if (row.candidateCount === 1 && row.candidates.length === 1) {
      deterministicRows.push({
        assessmentId: row.assessmentId,
        obligationId: row.obligationId,
        policyId: row.candidates[0].policyId,
        policyNumber: row.candidates[0].policyNumber,
        citation: row.citation,
      });
      continue;
    }

    if (row.candidateCount > 1) {
      ambiguousRows.push(row);
      continue;
    }

    unresolvedRows.push(row);
  }

  const backfillResult = await replaceBackfillOwnedLinks(deterministicRows, existingRows);
  const postRunCounts = await loadPostRunCounts();

  const ambiguousPolicyNumbers = summarizeAmbiguousPolicyNumbers(ambiguousRows);
  const manualReviewRows = [
    ...ambiguousRows.map((row) => flattenManualReviewRow(row, 'ambiguous')),
    ...unresolvedRows.map((row) => flattenManualReviewRow(row, 'unresolved')),
  ];

  const artifact = {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    status_scope: STATUS_SCOPE,
    link_basis: LINK_BASIS,
    migration_file: 'db-assessment-policy-links-migration.sql',
    candidate_ordering_rule: {
      source: 'lib/remediation.js policy_lookup ordering',
      order_by: [
        'indexed_at DESC NULLS LAST',
        'updated_at DESC NULLS LAST',
        'created_at DESC NULLS LAST',
        'id ASC',
      ],
      behavior: 'Insert only single-candidate matches. Leave duplicate-policy-number rows unset for manual review.',
    },
    summary: {
      remediation_assessment_count: toInt(scopeSummary.remediation_assessment_count),
      remediation_rows_with_covering_policy_number: toInt(scopeSummary.remediation_rows_with_covering_policy_number),
      remediation_rows_without_covering_policy_number: toInt(scopeSummary.remediation_rows_without_covering_policy_number),
      deterministic_rows: deterministicRows.length,
      ambiguous_rows: ambiguousRows.length,
      unresolved_rows: unresolvedRows.length,
      deleted_prior_backfill_rows: backfillResult.deletedBackfillRows,
      inserted_backfill_rows: backfillResult.insertedBackfillRows,
      preserved_existing_non_backfill_links: backfillResult.preservedExplicitSelections,
      resulting_backfill_link_count: toInt(postRunCounts.backfill_link_count),
      resulting_reviewer_selected_link_count: toInt(postRunCounts.reviewer_selected_link_count),
    },
    ambiguous_policy_numbers: ambiguousPolicyNumbers,
    ambiguous_rows: ambiguousRows,
    unresolved_rows: unresolvedRows,
  };

  await mkdir(artifactsDir, { recursive: true });
  await writeFile(OUTPUT_JSON_PATH, JSON.stringify(artifact, null, 2));
  await writeFile(OUTPUT_CSV_PATH, toCsv(manualReviewRows, CSV_COLUMNS));

  console.log(JSON.stringify({
    run_id: RUN_ID,
    output_json: OUTPUT_JSON_PATH,
    output_csv: OUTPUT_CSV_PATH,
    summary: artifact.summary,
  }, null, 2));
} finally {
  await dbClient.end({ timeout: 5 });
}
