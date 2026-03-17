import { asc, eq, sql } from 'drizzle-orm';
import { db } from './db.js';
import { provisions } from './schema.js';

const REMEDIATION_STATUSES = ['GAP', 'PARTIAL'];
const REVIEWED_DISPOSITIONS = ['confirmed', 'overridden', 'flagged_engine_defect', 'dismissed'];
const UNASSIGNED_BUCKET = 'Unassigned';
const DEFAULT_PAGE_SIZE = 25;

function rowsOf(result) {
  return result?.rows || result || [];
}

function toInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeStatus(value) {
  return REMEDIATION_STATUSES.includes(value) ? value : null;
}

function normalizeConfidenceValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(3, Math.max(1, numeric));
}

function normalizeFilters(filters = {}) {
  const normalized = {
    status: normalizeStatus(filters.status),
    source: normalizeString(filters.source),
    domain: normalizeString(filters.domain),
    riskTier: normalizeString(filters.riskTier),
    confidenceMin: normalizeConfidenceValue(filters.confidenceMin),
    confidenceMax: normalizeConfidenceValue(filters.confidenceMax),
    q: normalizeString(filters.q),
    includeDefects: filters.includeDefects === true,
  };

  if (
    normalized.confidenceMin !== null &&
    normalized.confidenceMax !== null &&
    normalized.confidenceMin > normalized.confidenceMax
  ) {
    [normalized.confidenceMin, normalized.confidenceMax] = [
      normalized.confidenceMax,
      normalized.confidenceMin,
    ];
  }

  return normalized;
}

function normalizePositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const normalized = Math.floor(numeric);
  return normalized > 0 ? normalized : fallback;
}

function normalizeSort(sort) {
  return ['worst', 'policy_number', 'title'].includes(sort) ? sort : 'worst';
}

function normalizePolicyNumber(policyNumber) {
  const normalized = normalizeString(policyNumber);
  return normalized || UNASSIGNED_BUCKET;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function normalizedPolicyNumberSql(column) {
  return sql`NULLIF(BTRIM(${column}), '')`;
}

function policyBucketSql(column) {
  return sql`COALESCE(${normalizedPolicyNumberSql(column)}, ${UNASSIGNED_BUCKET})`;
}

function reviewDispositionSql(column) {
  return sql`COALESCE(${column}, 'unreviewed')`;
}

function buildDefectClause(filters, options = {}) {
  if (options.requireDefect) return sql`sd.assessment_id IS NOT NULL`;
  if (filters.includeDefects) return null;
  return sql`sd.assessment_id IS NULL`;
}

function confidenceValueSql(column) {
  // coverage_assessments.confidence is written as low/medium/high text bands in this repo,
  // so numeric filters map those bands to 1/2/3 without changing the returned payload value.
  return sql`
    CASE LOWER(COALESCE(BTRIM(${column}), ''))
      WHEN 'low' THEN 1
      WHEN 'medium' THEN 2
      WHEN 'high' THEN 3
      ELSE NULL
    END
  `;
}

function buildSearchClause(q) {
  if (!q) return null;

  const pattern = `%${escapeLike(q)}%`;
  return sql`(
    o.citation ILIKE ${pattern} ESCAPE '\'
    OR o.requirement ILIKE ${pattern} ESCAPE '\'
    OR ca.covering_policy_number ILIKE ${pattern} ESCAPE '\'
    OR pl.title ILIKE ${pattern} ESCAPE '\'
  )`;
}

function buildConfidenceClause(filters) {
  const confidenceRank = confidenceValueSql(sql`ca.confidence`);
  const clauses = [];

  if (filters.confidenceMin !== null) {
    clauses.push(sql`${confidenceRank} IS NOT NULL AND ${confidenceRank} >= ${filters.confidenceMin}`);
  }
  if (filters.confidenceMax !== null) {
    clauses.push(sql`${confidenceRank} IS NOT NULL AND ${confidenceRank} <= ${filters.confidenceMax}`);
  }

  return clauses;
}

function buildPolicyLookupCte() {
  return sql`
    policy_lookup AS (
      -- Deduplicate on policy_number so duplicate policy rows never multiply remediation rows.
      SELECT DISTINCT ON (p.policy_number)
        p.policy_number,
        p.id,
        p.title,
        p.domain,
        p.sub_domain
      FROM policies p
      WHERE p.policy_number IS NOT NULL
        AND BTRIM(p.policy_number) <> ''
      ORDER BY
        p.policy_number,
        p.indexed_at DESC NULLS LAST,
        p.updated_at DESC NULLS LAST,
        p.created_at DESC NULLS LAST,
        p.id ASC
    )
  `;
}

function buildBaseCte(runId, filters = {}, options = {}) {
  const normalized = normalizeFilters(filters);
  const where = [
    sql`ca.map_run_id = ${runId}`,
    normalized.status
      ? sql`ca.status = ${normalized.status}`
      : sql`ca.status IN ('GAP', 'PARTIAL')`,
  ];

  if (normalized.source) where.push(sql`rs.name = ${normalized.source}`);
  if (normalized.domain) where.push(sql`pl.domain = ${normalized.domain}`);
  if (normalized.riskTier) where.push(sql`o.risk_tier = ${normalized.riskTier}`);

  const searchClause = buildSearchClause(normalized.q);
  if (searchClause) where.push(searchClause);

  for (const clause of buildConfidenceClause(normalized)) {
    where.push(clause);
  }

  const defectClause = buildDefectClause(normalized, options);
  if (defectClause) where.push(defectClause);

  return sql`
    WITH
    ${buildPolicyLookupCte()},
    base_rows AS (
      SELECT
        ca.id AS assessment_id,
        ca.obligation_id,
        ca.map_run_id,
        ca.status,
        ca.confidence,
        ca.gap_detail,
        ca.reasoning,
        ca.covering_policy_number,
        ${policyBucketSql(sql`ca.covering_policy_number`)} AS policy_bucket,
        o.citation,
        o.requirement,
        o.risk_tier,
        o.topics,
        o.loc_applicability,
        rs.name AS source_name,
        pl.id AS policy_id,
        pl.title AS policy_title,
        pl.domain AS policy_domain,
        pl.sub_domain AS policy_sub_domain,
        ar.id AS review_id,
        ar.assessment_id AS review_assessment_id,
        ar.disposition AS review_disposition,
        ar.override_status,
        ar.note AS review_note,
        ar.dismiss_reason,
        ar.reviewed_by AS review_reviewed_by,
        ar.reviewed_at AS review_reviewed_at,
        ar.created_at AS review_created_at,
        ar.updated_at AS review_updated_at,
        sd.id AS defect_id,
        sd.assessment_id AS defect_assessment_id,
        sd.defect_class,
        sd.status AS defect_status,
        sd.severity AS defect_severity,
        sd.seeded_from AS defect_seeded_from,
        sd.note AS defect_note,
        sd.owner AS defect_owner,
        sd.created_at AS defect_created_at,
        sd.updated_at AS defect_updated_at,
        sd.resolved_at AS defect_resolved_at
      FROM coverage_assessments ca
      JOIN obligations o ON ca.obligation_id = o.id
      JOIN reg_sources rs ON o.reg_source_id = rs.id
      LEFT JOIN assessment_reviews ar ON ar.assessment_id = ca.id
      LEFT JOIN system_defects sd ON sd.assessment_id = ca.id
      LEFT JOIN policy_lookup pl ON ${normalizedPolicyNumberSql(sql`ca.covering_policy_number`)} = pl.policy_number
      WHERE ${sql.join(where, sql` AND `)}
    )
  `;
}

function mapGroupRow(row) {
  return {
    policyNumber: row.policy_number,
    policyTitle: row.policy_title,
    gapCount: toInt(row.gap_count),
    partialCount: toInt(row.partial_count),
    totalCount: toInt(row.total_count),
    score: toInt(row.score),
  };
}

function buildProgressObject(row) {
  return {
    unreviewed: toInt(row.progress_unreviewed),
    confirmed: toInt(row.progress_confirmed),
    overridden: toInt(row.progress_overridden),
    flagged_engine_defect: toInt(row.progress_flagged_engine_defect),
    dismissed: toInt(row.progress_dismissed),
  };
}

function buildGroupOrderBy(sort) {
  switch (normalizeSort(sort)) {
    case 'policy_number':
      return sql`policy_number ASC`;
    case 'title':
      return sql`
        CASE WHEN policy_title IS NULL THEN 1 ELSE 0 END ASC,
        policy_title ASC,
        policy_number ASC
      `;
    case 'worst':
    default:
      return sql`score DESC, total_count DESC, policy_number ASC`;
  }
}

function emptyDetail() {
  return {
    assessment: null,
    obligation: null,
    policy: null,
    provisions: [],
    review: null,
    defect: null,
  };
}

export async function getRemediationSummary(runId, filters = {}) {
  const reviewedDispositionList = sql.join(
    REVIEWED_DISPOSITIONS.map((value) => sql`${value}`),
    sql`, `,
  );

  const summaryResult = await db.execute(sql`
    ${buildBaseCte(runId, filters)}
    SELECT
      count(*) FILTER (WHERE status = 'GAP') AS gap_count,
      count(*) FILTER (WHERE status = 'PARTIAL') AS partial_count,
      (SELECT count(*) FROM (SELECT policy_bucket FROM base_rows GROUP BY policy_bucket) grouped) AS total_policies_needing_work,
      count(*) FILTER (
        WHERE ${reviewDispositionSql(sql`review_disposition`)} IN (${reviewedDispositionList})
      ) AS reviewed_count,
      count(*) FILTER (WHERE review_disposition = 'dismissed') AS dismissed_count,
      count(*) FILTER (WHERE ${reviewDispositionSql(sql`review_disposition`)} = 'unreviewed') AS progress_unreviewed,
      count(*) FILTER (WHERE review_disposition = 'confirmed') AS progress_confirmed,
      count(*) FILTER (WHERE review_disposition = 'overridden') AS progress_overridden,
      count(*) FILTER (WHERE review_disposition = 'flagged_engine_defect') AS progress_flagged_engine_defect,
      count(*) FILTER (WHERE review_disposition = 'dismissed') AS progress_dismissed
    FROM base_rows
  `);

  const topPoliciesResult = await db.execute(sql`
    ${buildBaseCte(runId, filters)}
    SELECT
      policy_bucket AS policy_number,
      CASE WHEN policy_bucket = ${UNASSIGNED_BUCKET} THEN NULL ELSE MAX(policy_title) END AS policy_title,
      count(*) FILTER (WHERE status = 'GAP') AS gap_count,
      count(*) FILTER (WHERE status = 'PARTIAL') AS partial_count,
      count(*) AS total_count,
      ((count(*) FILTER (WHERE status = 'GAP')) * 3 + (count(*) FILTER (WHERE status = 'PARTIAL'))) AS score
    FROM base_rows
    GROUP BY policy_bucket
    ORDER BY score DESC, total_count DESC, policy_number ASC
    LIMIT 10
  `);

  const defectCountResult = await db.execute(sql`
    ${buildBaseCte(runId, filters, { requireDefect: true })}
    SELECT count(*) AS defect_count
    FROM base_rows
  `);

  const summaryRow = rowsOf(summaryResult)[0] || {};
  const defectRow = rowsOf(defectCountResult)[0] || {};

  return {
    gapCount: toInt(summaryRow.gap_count),
    partialCount: toInt(summaryRow.partial_count),
    totalPoliciesNeedingWork: toInt(summaryRow.total_policies_needing_work),
    reviewedCount: toInt(summaryRow.reviewed_count),
    dismissedCount: toInt(summaryRow.dismissed_count),
    defectCount: toInt(defectRow.defect_count),
    topPolicies: rowsOf(topPoliciesResult).map(mapGroupRow),
    progress: buildProgressObject(summaryRow),
  };
}

export async function getRemediationGroups(
  runId,
  filters = {},
  sort = 'worst',
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const normalizedPage = normalizePositiveInt(page, 1);
  const normalizedPageSize = normalizePositiveInt(pageSize, DEFAULT_PAGE_SIZE);
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const orderBy = buildGroupOrderBy(sort);

  const totalResult = await db.execute(sql`
    ${buildBaseCte(runId, filters)}
    SELECT count(*) AS total_groups
    FROM (
      SELECT policy_bucket
      FROM base_rows
      GROUP BY policy_bucket
    ) grouped_rows
  `);

  const groupsResult = await db.execute(sql`
    ${buildBaseCte(runId, filters)},
    grouped_rows AS (
      SELECT
        policy_bucket AS policy_number,
        CASE WHEN policy_bucket = ${UNASSIGNED_BUCKET} THEN NULL ELSE MAX(policy_title) END AS policy_title,
        count(*) FILTER (WHERE status = 'GAP') AS gap_count,
        count(*) FILTER (WHERE status = 'PARTIAL') AS partial_count,
        count(*) AS total_count,
        ((count(*) FILTER (WHERE status = 'GAP')) * 3 + (count(*) FILTER (WHERE status = 'PARTIAL'))) AS score
      FROM base_rows
      GROUP BY policy_bucket
    )
    SELECT
      policy_number,
      policy_title,
      gap_count,
      partial_count,
      total_count,
      score
    FROM grouped_rows
    ORDER BY ${orderBy}
    LIMIT ${normalizedPageSize}
    OFFSET ${offset}
  `);

  const totalGroups = toInt(rowsOf(totalResult)[0]?.total_groups);
  const totalPages = totalGroups === 0 ? 0 : Math.ceil(totalGroups / normalizedPageSize);

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalGroups,
    totalPages,
    groups: rowsOf(groupsResult).map(mapGroupRow),
  };
}

export async function getRemediationItems(runId, policyNumber, filters = {}) {
  const normalizedPolicyNumber = normalizePolicyNumber(policyNumber);

  const itemsResult = await db.execute(sql`
    ${buildBaseCte(runId, filters)}
    SELECT
      assessment_id,
      obligation_id,
      citation,
      requirement,
      status,
      confidence,
      gap_detail,
      reasoning,
      source_name,
      risk_tier,
      covering_policy_number,
      policy_title,
      policy_domain,
      review_disposition,
      override_status,
      review_note,
      defect_id IS NOT NULL AS has_defect
    FROM base_rows
    WHERE policy_bucket = ${normalizedPolicyNumber}
    ORDER BY
      CASE status
        WHEN 'GAP' THEN 1
        WHEN 'PARTIAL' THEN 2
        ELSE 3
      END,
      COALESCE(${confidenceValueSql(sql`confidence`)}, 4),
      citation ASC,
      assessment_id ASC
  `);

  return rowsOf(itemsResult).map((row) => ({
    assessmentId: row.assessment_id,
    obligationId: row.obligation_id,
    citation: row.citation,
    requirement: row.requirement,
    status: row.status,
    confidence: row.confidence,
    gapDetail: row.gap_detail,
    reasoning: row.reasoning,
    sourceName: row.source_name,
    riskTier: row.risk_tier,
    coveringPolicyNumber: row.covering_policy_number,
    policyTitle: row.policy_title,
    policyDomain: row.policy_domain,
    reviewDisposition: row.review_disposition,
    overrideStatus: row.override_status,
    reviewNote: row.review_note,
    hasDefect: Boolean(row.has_defect),
  }));
}

export async function getAssessmentDetail(assessmentId, options = {}) {
  void options;

  if (!normalizeString(assessmentId)) {
    return emptyDetail();
  }

  const detailResult = await db.execute(sql`
    WITH
    ${buildPolicyLookupCte()}
    SELECT
      ca.id AS assessment_id,
      ca.map_run_id,
      ca.status,
      ca.confidence,
      ca.reasoning,
      ca.gap_detail,
      ca.covering_policy_number,
      o.id AS obligation_id,
      o.citation,
      o.requirement,
      o.risk_tier,
      o.topics,
      o.loc_applicability,
      pl.id AS policy_id,
      pl.policy_number,
      pl.title AS policy_title,
      pl.domain AS policy_domain,
      pl.sub_domain AS policy_sub_domain,
      ar.id AS review_id,
      ar.assessment_id AS review_assessment_id,
      ar.disposition AS review_disposition,
      ar.override_status,
      ar.note AS review_note,
      ar.dismiss_reason,
      ar.reviewed_by AS review_reviewed_by,
      ar.reviewed_at AS review_reviewed_at,
      ar.created_at AS review_created_at,
      ar.updated_at AS review_updated_at,
      sd.id AS defect_id,
      sd.assessment_id AS defect_assessment_id,
      sd.defect_class,
      sd.status AS defect_status,
      sd.severity AS defect_severity,
      sd.seeded_from AS defect_seeded_from,
      sd.note AS defect_note,
      sd.owner AS defect_owner,
      sd.created_at AS defect_created_at,
      sd.updated_at AS defect_updated_at,
      sd.resolved_at AS defect_resolved_at
    FROM coverage_assessments ca
    JOIN obligations o ON ca.obligation_id = o.id
    LEFT JOIN assessment_reviews ar ON ar.assessment_id = ca.id
    LEFT JOIN system_defects sd ON sd.assessment_id = ca.id
    LEFT JOIN policy_lookup pl ON ${normalizedPolicyNumberSql(sql`ca.covering_policy_number`)} = pl.policy_number
    WHERE ca.id = ${assessmentId}
    LIMIT 1
  `);

  const row = rowsOf(detailResult)[0];
  if (!row) return emptyDetail();

  const provisionRows = row.policy_id
    ? await db
      .select({
        id: provisions.id,
        text: provisions.text,
        section: provisions.section,
        sourceCitation: provisions.source_citation,
      })
      .from(provisions)
      .where(eq(provisions.policy_id, row.policy_id))
      .orderBy(
        sql`CASE WHEN ${provisions.section} IS NULL OR BTRIM(${provisions.section}) = '' THEN 1 ELSE 0 END`,
        asc(provisions.section),
        sql`CASE WHEN ${provisions.source_citation} IS NULL OR BTRIM(${provisions.source_citation}) = '' THEN 1 ELSE 0 END`,
        asc(provisions.source_citation),
        asc(provisions.id),
      )
    : [];

  const review = row.review_id
    ? {
      id: row.review_id,
      assessment_id: row.review_assessment_id,
      disposition: row.review_disposition,
      override_status: row.override_status,
      note: row.review_note,
      dismiss_reason: row.dismiss_reason,
      reviewed_by: row.review_reviewed_by,
      reviewed_at: row.review_reviewed_at,
      created_at: row.review_created_at,
      updated_at: row.review_updated_at,
    }
    : null;

  const defect = row.defect_id
    ? {
      id: row.defect_id,
      assessment_id: row.defect_assessment_id,
      defect_class: row.defect_class,
      status: row.defect_status,
      severity: row.defect_severity,
      seeded_from: row.defect_seeded_from,
      note: row.defect_note,
      owner: row.defect_owner,
      created_at: row.defect_created_at,
      updated_at: row.defect_updated_at,
      resolved_at: row.defect_resolved_at,
    }
    : null;

  return {
    assessment: {
      id: row.assessment_id,
      mapRunId: row.map_run_id,
      status: row.status,
      confidence: row.confidence,
      reasoning: row.reasoning,
      gapDetail: row.gap_detail,
      coveringPolicyNumber: row.covering_policy_number,
    },
    obligation: {
      id: row.obligation_id,
      citation: row.citation,
      requirement: row.requirement,
      riskTier: row.risk_tier,
      topics: row.topics,
      locApplicability: row.loc_applicability,
    },
    policy: row.policy_id
      ? {
        id: row.policy_id,
        policyNumber: row.policy_number,
        title: row.policy_title,
        domain: row.policy_domain,
        subDomain: row.policy_sub_domain,
      }
      : null,
    provisions: provisionRows,
    review,
    defect,
  };
}
