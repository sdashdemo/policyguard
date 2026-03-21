import { asc, eq, sql } from 'drizzle-orm';
import { db } from './db.js';
import { provisions } from './schema.js';

const REMEDIATION_STATUSES = ['GAP', 'PARTIAL'];
const REVIEWED_DISPOSITIONS = ['confirmed', 'overridden', 'flagged_engine_defect', 'dismissed'];
const DEFECT_LIFECYCLE_STATUSES = ['open', 'acknowledged', 'fixed', 'wont_fix'];
const DEFECT_SEVERITIES = ['low', 'medium', 'high'];
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

function normalizeDefectStatus(value) {
  const normalized = normalizeString(value)?.toLowerCase();
  return DEFECT_LIFECYCLE_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeDefectSeverity(value) {
  const normalized = normalizeString(value)?.toLowerCase();
  return DEFECT_SEVERITIES.includes(normalized) ? normalized : null;
}

function normalizeDefectQueueFilters(filters = {}) {
  return {
    status: normalizeDefectStatus(filters.status),
    severity: normalizeDefectSeverity(filters.severity),
    owner: normalizeString(filters.owner),
    source: normalizeString(filters.source),
    policyNumber: normalizeString(filters.policyNumber),
    q: normalizeString(filters.q),
  };
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

function effectivePolicyNumberSql(explicitColumn, fallbackColumn) {
  return sql`COALESCE(${normalizedPolicyNumberSql(explicitColumn)}, ${normalizedPolicyNumberSql(fallbackColumn)})`;
}

function effectivePolicyBucketSql(explicitColumn, fallbackColumn) {
  return sql`COALESCE(${effectivePolicyNumberSql(explicitColumn, fallbackColumn)}, ${UNASSIGNED_BUCKET})`;
}

function resolvePolicyLinkSource(row) {
  const explicitBasis = normalizeString(row?.policy_link_basis);
  if (explicitBasis === 'reviewer_selected') return 'reviewer_selected';
  if (explicitBasis === 'covering_policy_number_backfill') return 'covering_policy_number_backfill';
  if (normalizeString(row?.covering_policy_number)) return 'fallback_legacy_covering_policy_number';
  return null;
}

function buildPolicyLinkState(row) {
  const effectiveSource = resolvePolicyLinkSource(row);

  return {
    explicitLinkId: row?.policy_link_id || null,
    explicitLinkBasis: row?.policy_link_basis || null,
    hasExplicitLink: Boolean(row?.policy_link_id),
    effectiveSource,
    effectivePolicyId: row?.policy_id || null,
    effectivePolicyNumber: normalizeString(row?.resolved_policy_number),
    effectivePolicyTitle: normalizeString(row?.policy_title),
    legacyCoveringPolicyNumber: normalizeString(row?.covering_policy_number),
    linkedBy: normalizeString(row?.policy_linked_by),
    note: normalizeString(row?.policy_link_note),
    hasEffectivePolicy: Boolean(row?.policy_id),
  };
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return false;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeString(item))
      .filter(Boolean);
  }

  const normalized = normalizeString(value);
  if (!normalized) return [];

  if (!/\r?\n/.test(normalized)) {
    return [normalized];
  }

  return normalized
    .split(/\r?\n+/)
    .map((line) => normalizeString(line.replace(/^[-*]\s*/, '')))
    .filter(Boolean);
}

function implementationNotesToText(notes) {
  return Array.isArray(notes) && notes.length
    ? notes.join('\n')
    : null;
}

function normalizePolicyHealthSeverity(value) {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function normalizePolicyHealthType(value, flags = {}) {
  const normalized = normalizeString(value)
    ?.toLowerCase()
    .replace(/\s+/g, '_');

  if (normalized) return normalized;
  if (flags.staleCitation) return 'stale_citation';
  if (flags.abbreviationDiscipline) return 'abbreviation_discipline';
  if (flags.definedTermDiscipline) return 'defined_term_discipline';
  return 'general_gap';
}

function normalizePolicyHealthFinding(value) {
  if (typeof value === 'string') {
    const issue = normalizeString(value);
    if (!issue) return null;

    return {
      severity: 'medium',
      type: 'general_gap',
      issue,
      suggestedInsertionPoint: null,
      staleCitation: false,
      abbreviationDiscipline: false,
      definedTermDiscipline: false,
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const issue = normalizeString(value.issue)
    || normalizeString(value.description)
    || normalizeString(value.summary);

  if (!issue) return null;

  const staleCitation = normalizeBoolean(value.staleCitation);
  const abbreviationDiscipline = normalizeBoolean(value.abbreviationDiscipline);
  const definedTermDiscipline = normalizeBoolean(value.definedTermDiscipline);

  return {
    severity: normalizePolicyHealthSeverity(value.severity),
    type: normalizePolicyHealthType(value.type, {
      staleCitation,
      abbreviationDiscipline,
      definedTermDiscipline,
    }),
    issue,
    suggestedInsertionPoint: normalizeString(value.suggestedInsertionPoint)
      || normalizeString(value.insertionPoint)
      || normalizeString(value.location),
    staleCitation,
    abbreviationDiscipline,
    definedTermDiscipline,
  };
}

function normalizePolicyHealthFindings(value) {
  const rawFindings = Array.isArray(value?.findings)
    ? value.findings
    : (Array.isArray(value?.issues)
      ? value.issues
      : (Array.isArray(value) ? value : []));

  return rawFindings
    .map((finding) => normalizePolicyHealthFinding(finding))
    .filter(Boolean)
    .slice(0, 5);
}

function buildPolicyHealthIssues(findings = []) {
  return findings
    .map((finding) => normalizeString(finding?.issue))
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeSuggestedFixState(rawResponse, row) {
  const rawSuggestedFix = normalizeObject(rawResponse?.suggestedFix);
  const rawSuggestedFixText = rawSuggestedFix ? null : normalizeString(rawResponse?.suggestedFix);
  const implementationNotes = normalizeStringList(
    rawSuggestedFix?.implementationNotes
    ?? rawSuggestedFix?.notes
    ?? rawResponse?.implementationNotes
    ?? row.fix_suggestion_implementation_notes,
  );

  return {
    draftLanguage: normalizeString(rawSuggestedFix?.draftLanguage)
      || normalizeString(rawSuggestedFix?.draft)
      || normalizeString(rawSuggestedFix?.text)
      || normalizeString(rawResponse?.draftLanguage)
      || normalizeString(row.fix_suggestion_suggested_fix)
      || rawSuggestedFixText
      || 'No persisted draft language is available.',
    implementationNotes,
    implementationNotesText: implementationNotesToText(implementationNotes),
  };
}

function buildPolicyHealthCheckState(row) {
  if (!row?.policy_health_check_id) {
    return null;
  }

  const findings = normalizePolicyHealthFindings(row.policy_health_findings_json);

  return {
    id: row.policy_health_check_id,
    assessmentId: row.assessment_id,
    policyId: row.policy_health_policy_id,
    summary: normalizeString(row.policy_health_summary) || 'Matched policy review was unavailable.',
    findings,
    issues: buildPolicyHealthIssues(findings),
    promptVersion: normalizeString(row.policy_health_prompt_version),
    modelId: normalizeString(row.policy_health_model_id),
    contextHash: normalizeString(row.policy_health_context_hash),
    generatedAt: row.policy_health_generated_at || null,
    createdAt: row.policy_health_created_at || null,
    updatedAt: row.policy_health_updated_at || null,
  };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function buildAssessmentFixSuggestionState(row) {
  if (!row?.fix_suggestion_id) {
    return null;
  }

  const rawResponse = normalizeObject(row.fix_suggestion_raw_response_json);
  const rawMetadata = normalizeObject(rawResponse?.metadata);
  const rawPolicyHealth = normalizeObject(rawResponse?.policyHealth);
  const hasMatchedPolicy = typeof rawMetadata?.hasMatchedPolicy === 'boolean'
    ? rawMetadata.hasMatchedPolicy
    : Boolean(row.policy_id);
  const suggestedFix = normalizeSuggestedFixState(rawResponse, row);

  const fallbackFindings = row.fix_suggestion_policy_health_check_id
    ? normalizePolicyHealthFindings(row.policy_health_findings_json)
    : [];
  const fallbackPolicyHealth = row.fix_suggestion_policy_health_check_id
    ? {
      summary: normalizeString(row.policy_health_summary) || 'Matched policy review was unavailable.',
      findings: fallbackFindings,
      issues: buildPolicyHealthIssues(fallbackFindings),
    }
    : null;
  const rawPolicyHealthFindings = normalizePolicyHealthFindings(rawPolicyHealth);

  return {
    id: row.fix_suggestion_id,
    assessmentId: row.assessment_id,
    policyHealthCheckId: row.fix_suggestion_policy_health_check_id || null,
    summary: normalizeString(row.fix_suggestion_summary)
      || normalizeString(rawResponse?.summary)
      || 'No persisted suggestion summary is available.',
    suggestedFix,
    draftLanguage: suggestedFix.draftLanguage,
    implementationNotes: suggestedFix.implementationNotes,
    implementationNotesText: suggestedFix.implementationNotesText,
    promptVersion: normalizeString(row.fix_suggestion_prompt_version),
    modelId: normalizeString(row.fix_suggestion_model_id),
    generatedAt: row.fix_suggestion_generated_at || null,
    createdAt: row.fix_suggestion_created_at || null,
    updatedAt: row.fix_suggestion_updated_at || null,
    policyHealth: rawPolicyHealth
      ? {
        summary: normalizeString(rawPolicyHealth.summary) || 'Matched policy review was unavailable.',
        findings: rawPolicyHealthFindings,
        issues: buildPolicyHealthIssues(rawPolicyHealthFindings),
      }
      : fallbackPolicyHealth,
    metadata: {
      hasMatchedPolicy,
      policyNumber: normalizeString(rawMetadata?.policyNumber) || normalizeString(row.resolved_policy_number),
      policyHealthSource: normalizeString(rawMetadata?.policyHealthSource)
        || (row.fix_suggestion_policy_health_check_id ? 'generated' : 'not_applicable'),
      policyHealthGeneratedAt: rawMetadata?.policyHealthGeneratedAt || row.policy_health_generated_at || null,
      policyHealthPromptVersion: normalizeString(rawMetadata?.policyHealthPromptVersion)
        || normalizeString(row.policy_health_prompt_version),
      policyHealthCheckId: normalizeString(rawMetadata?.policyHealthCheckId)
        || row.fix_suggestion_policy_health_check_id
        || null,
      suggestionSource: 'persisted',
      suggestionId: row.fix_suggestion_id,
      suggestionGeneratedAt: row.fix_suggestion_generated_at || null,
      suggestionPromptVersion: normalizeString(row.fix_suggestion_prompt_version),
    },
  };
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
    OR lp.policy_number ILIKE ${pattern} ESCAPE '\'
    OR fp.policy_number ILIKE ${pattern} ESCAPE '\'
    OR lp.title ILIKE ${pattern} ESCAPE '\'
    OR fp.title ILIKE ${pattern} ESCAPE '\'
  )`;
}

function buildDefectQueueSearchClause(q) {
  if (!q) return null;

  const pattern = `%${escapeLike(q)}%`;
  return sql`(
    citation ILIKE ${pattern} ESCAPE '\'
    OR requirement ILIKE ${pattern} ESCAPE '\'
    OR policy_bucket ILIKE ${pattern} ESCAPE '\'
    OR policy_title ILIKE ${pattern} ESCAPE '\'
    OR defect_note ILIKE ${pattern} ESCAPE '\'
    OR defect_owner ILIKE ${pattern} ESCAPE '\'
    OR source_name ILIKE ${pattern} ESCAPE '\'
  )`;
}

function joinWhereClauses(clauses) {
  return clauses.length ? sql.join(clauses, sql` AND `) : sql`TRUE`;
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
  if (normalized.domain) where.push(sql`COALESCE(lp.domain, fp.domain) = ${normalized.domain}`);
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
        apl.id AS policy_link_id,
        apl.link_basis AS policy_link_basis,
        apl.linked_by AS policy_linked_by,
        apl.note AS policy_link_note,
        ${effectivePolicyNumberSql(sql`lp.policy_number`, sql`ca.covering_policy_number`)} AS resolved_policy_number,
        ${effectivePolicyBucketSql(sql`lp.policy_number`, sql`ca.covering_policy_number`)} AS policy_bucket,
        o.citation,
        o.requirement,
        o.risk_tier,
        o.topics,
        o.loc_applicability,
        rs.name AS source_name,
        COALESCE(lp.id, fp.id) AS policy_id,
        COALESCE(lp.title, fp.title) AS policy_title,
        COALESCE(lp.domain, fp.domain) AS policy_domain,
        COALESCE(lp.sub_domain, fp.sub_domain) AS policy_sub_domain,
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
      LEFT JOIN assessment_policy_links apl ON apl.assessment_id = ca.id
      LEFT JOIN policies lp ON lp.id = apl.policy_id
      LEFT JOIN assessment_reviews ar ON ar.assessment_id = ca.id
      LEFT JOIN system_defects sd ON sd.assessment_id = ca.id
      LEFT JOIN policy_lookup fp ON ${normalizedPolicyNumberSql(sql`ca.covering_policy_number`)} = fp.policy_number
      WHERE ${sql.join(where, sql` AND `)}
    )
  `;
}

function mapGroupRow(row) {
  return {
    policyNumber: row.policy_number,
    policyTitle: row.policy_title,
    canonicalPolicyId: row.canonical_policy_id || null,
    distinctPolicyIds: toInt(row.distinct_policy_ids),
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

function mapDefectQueueRow(row) {
  return {
    defectId: row.defect_id,
    assessmentId: row.assessment_id,
    obligationId: row.obligation_id,
    citation: row.citation,
    requirement: row.requirement,
    assessmentStatus: row.assessment_status,
    confidence: row.confidence,
    sourceName: row.source_name,
    riskTier: row.risk_tier,
    policyNumber: row.policy_number,
    policyTitle: row.policy_title,
    reviewDisposition: row.review_disposition,
    overrideStatus: row.override_status,
    defectClass: row.defect_class,
    status: row.defect_status,
    severity: row.defect_severity,
    owner: row.defect_owner,
    note: row.defect_note,
    createdAt: row.defect_created_at || null,
    updatedAt: row.defect_updated_at || null,
    resolvedAt: row.defect_resolved_at || null,
  };
}

function buildDefectStatusCounts(row = {}) {
  return {
    open: toInt(row.open_count),
    acknowledged: toInt(row.acknowledged_count),
    fixed: toInt(row.fixed_count),
    wont_fix: toInt(row.wont_fix_count),
  };
}

function emptyDetail() {
  return {
    assessment: null,
    obligation: null,
    policyLink: null,
    policyHealthCheck: null,
    fixSuggestion: null,
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
      CASE
        WHEN count(DISTINCT policy_id) = 1 THEN MAX(policy_id)
        ELSE NULL
      END AS canonical_policy_id,
      count(DISTINCT policy_id) AS distinct_policy_ids,
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
        CASE
          WHEN count(DISTINCT policy_id) = 1 THEN MAX(policy_id)
          ELSE NULL
        END AS canonical_policy_id,
        count(DISTINCT policy_id) AS distinct_policy_ids,
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
      canonical_policy_id,
      distinct_policy_ids,
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
      policy_id,
      resolved_policy_number,
      covering_policy_number,
      policy_link_id,
      policy_link_basis,
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
    effectivePolicyId: row.policy_id || null,
    coveringPolicyNumber: row.resolved_policy_number,
    legacyCoveringPolicyNumber: row.covering_policy_number,
    policyTitle: row.policy_title,
    policyDomain: row.policy_domain,
    hasExplicitPolicyLink: Boolean(row.policy_link_id),
    policyLinkBasis: row.policy_link_basis,
    effectivePolicyLinkSource: resolvePolicyLinkSource(row),
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
      apl.id AS policy_link_id,
      apl.link_basis AS policy_link_basis,
      apl.linked_by AS policy_linked_by,
      apl.note AS policy_link_note,
      o.id AS obligation_id,
      o.citation,
      o.requirement,
      o.risk_tier,
      o.topics,
      o.loc_applicability,
      COALESCE(lp.id, fp.id) AS policy_id,
      ${effectivePolicyNumberSql(sql`lp.policy_number`, sql`ca.covering_policy_number`)} AS resolved_policy_number,
      COALESCE(lp.title, fp.title) AS policy_title,
      COALESCE(lp.domain, fp.domain) AS policy_domain,
      COALESCE(lp.sub_domain, fp.sub_domain) AS policy_sub_domain,
      phc.id AS policy_health_check_id,
      phc.policy_id AS policy_health_policy_id,
      phc.summary AS policy_health_summary,
      phc.findings_json AS policy_health_findings_json,
      phc.prompt_version AS policy_health_prompt_version,
      phc.model_id AS policy_health_model_id,
      phc.context_hash AS policy_health_context_hash,
      phc.generated_at AS policy_health_generated_at,
      phc.created_at AS policy_health_created_at,
      phc.updated_at AS policy_health_updated_at,
      afs.id AS fix_suggestion_id,
      afs.policy_health_check_id AS fix_suggestion_policy_health_check_id,
      afs.summary AS fix_suggestion_summary,
      afs.suggested_fix AS fix_suggestion_suggested_fix,
      afs.implementation_notes AS fix_suggestion_implementation_notes,
      afs.raw_response_json AS fix_suggestion_raw_response_json,
      afs.prompt_version AS fix_suggestion_prompt_version,
      afs.model_id AS fix_suggestion_model_id,
      afs.generated_at AS fix_suggestion_generated_at,
      afs.created_at AS fix_suggestion_created_at,
      afs.updated_at AS fix_suggestion_updated_at,
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
    LEFT JOIN assessment_policy_links apl ON apl.assessment_id = ca.id
    LEFT JOIN policies lp ON lp.id = apl.policy_id
    LEFT JOIN policy_lookup fp ON ${normalizedPolicyNumberSql(sql`ca.covering_policy_number`)} = fp.policy_number
    LEFT JOIN policy_health_checks phc
      ON phc.assessment_id = ca.id
      AND phc.policy_id = COALESCE(lp.id, fp.id)
    LEFT JOIN assessment_fix_suggestions afs
      ON afs.assessment_id = ca.id
      AND (
        (COALESCE(lp.id, fp.id) IS NULL AND afs.policy_health_check_id IS NULL)
        OR (phc.id IS NOT NULL AND afs.policy_health_check_id = phc.id)
      )
    LEFT JOIN assessment_reviews ar ON ar.assessment_id = ca.id
    LEFT JOIN system_defects sd ON sd.assessment_id = ca.id
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

  const policyLink = buildPolicyLinkState(row);
  const policyHealthCheck = buildPolicyHealthCheckState(row);
  const fixSuggestion = buildAssessmentFixSuggestionState(row);

  return {
    assessment: {
      id: row.assessment_id,
      mapRunId: row.map_run_id,
      status: row.status,
      confidence: row.confidence,
      reasoning: row.reasoning,
      gapDetail: row.gap_detail,
      coveringPolicyNumber: row.resolved_policy_number,
      legacyCoveringPolicyNumber: row.covering_policy_number,
      hasExplicitPolicyLink: policyLink.hasExplicitLink,
      policyLinkBasis: policyLink.explicitLinkBasis,
      effectivePolicyLinkSource: policyLink.effectiveSource,
    },
    obligation: {
      id: row.obligation_id,
      citation: row.citation,
      requirement: row.requirement,
      riskTier: row.risk_tier,
      topics: row.topics,
      locApplicability: row.loc_applicability,
    },
    policyLink,
    policyHealthCheck,
    fixSuggestion,
    policy: row.policy_id
      ? {
        id: row.policy_id,
        policyNumber: row.resolved_policy_number,
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

export async function getAssessmentPolicyLink(assessmentId) {
  const detail = await getAssessmentDetail(assessmentId);

  if (!detail.assessment) {
    return {
      assessment: null,
      obligation: null,
      policyLink: null,
      policy: null,
    };
  }

  return {
    assessment: detail.assessment,
    obligation: detail.obligation,
    policyLink: detail.policyLink,
    policy: detail.policy,
  };
}

export async function getDefectQueue(
  runId,
  filters = {},
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const normalizedRunId = normalizeString(runId);
  if (!normalizedRunId) {
    return {
      page: 1,
      pageSize: normalizePositiveInt(pageSize, DEFAULT_PAGE_SIZE),
      totalDefects: 0,
      totalPages: 0,
      counts: buildDefectStatusCounts(),
      defects: [],
    };
  }

  const normalizedFilters = normalizeDefectQueueFilters(filters);
  const normalizedPage = normalizePositiveInt(page, 1);
  const normalizedPageSize = normalizePositiveInt(pageSize, DEFAULT_PAGE_SIZE);
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const baseFilters = {
    source: normalizedFilters.source,
    includeDefects: true,
  };
  const where = [];

  if (normalizedFilters.status) {
    where.push(sql`defect_status = ${normalizedFilters.status}`);
  }
  if (normalizedFilters.severity) {
    where.push(sql`defect_severity = ${normalizedFilters.severity}`);
  }
  if (normalizedFilters.owner) {
    where.push(sql`defect_owner ILIKE ${`%${escapeLike(normalizedFilters.owner)}%`} ESCAPE '\'`);
  }
  if (normalizedFilters.policyNumber) {
    where.push(sql`LOWER(policy_bucket) = LOWER(${normalizePolicyNumber(normalizedFilters.policyNumber)})`);
  }

  const searchClause = buildDefectQueueSearchClause(normalizedFilters.q);
  if (searchClause) where.push(searchClause);

  const whereSql = joinWhereClauses(where);

  const countsResult = await db.execute(sql`
    ${buildBaseCte(normalizedRunId, baseFilters, { requireDefect: true })}
    SELECT
      count(*) AS total_defects,
      count(*) FILTER (WHERE defect_status = 'open') AS open_count,
      count(*) FILTER (WHERE defect_status = 'acknowledged') AS acknowledged_count,
      count(*) FILTER (WHERE defect_status = 'fixed') AS fixed_count,
      count(*) FILTER (WHERE defect_status = 'wont_fix') AS wont_fix_count
    FROM base_rows
    WHERE ${whereSql}
  `);

  const defectsResult = await db.execute(sql`
    ${buildBaseCte(normalizedRunId, baseFilters, { requireDefect: true })}
    SELECT
      defect_id,
      assessment_id,
      obligation_id,
      citation,
      requirement,
      status AS assessment_status,
      confidence,
      source_name,
      risk_tier,
      resolved_policy_number AS policy_number,
      policy_title,
      review_disposition,
      override_status,
      defect_class,
      defect_status,
      defect_severity,
      defect_owner,
      defect_note,
      defect_created_at,
      defect_updated_at,
      defect_resolved_at
    FROM base_rows
    WHERE ${whereSql}
    ORDER BY
      CASE defect_status
        WHEN 'open' THEN 0
        WHEN 'acknowledged' THEN 1
        WHEN 'fixed' THEN 2
        WHEN 'wont_fix' THEN 3
        ELSE 4
      END,
      CASE defect_severity
        WHEN 'high' THEN 0
        WHEN 'medium' THEN 1
        WHEN 'low' THEN 2
        ELSE 3
      END,
      COALESCE(defect_updated_at, defect_created_at) DESC,
      assessment_id ASC
    LIMIT ${normalizedPageSize}
    OFFSET ${offset}
  `);

  const countsRow = rowsOf(countsResult)[0] || {};
  const totalDefects = toInt(countsRow.total_defects);
  const totalPages = totalDefects === 0 ? 0 : Math.ceil(totalDefects / normalizedPageSize);

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalDefects,
    totalPages,
    counts: buildDefectStatusCounts(countsRow),
    defects: rowsOf(defectsResult).map(mapDefectQueueRow),
  };
}

export async function getDefectQueueDetail(defectId) {
  const normalizedDefectId = normalizeString(defectId);
  if (!normalizedDefectId) {
    return {
      defectId: null,
      assessmentId: null,
      runId: null,
      detail: emptyDetail(),
    };
  }

  const defectResult = await db.execute(sql`
    SELECT
      sd.id AS defect_id,
      sd.assessment_id,
      ca.map_run_id
    FROM system_defects sd
    JOIN coverage_assessments ca ON ca.id = sd.assessment_id
    WHERE sd.id = ${normalizedDefectId}
    LIMIT 1
  `);

  const row = rowsOf(defectResult)[0];
  if (!row) {
    return {
      defectId: null,
      assessmentId: null,
      runId: null,
      detail: emptyDetail(),
    };
  }

  return {
    defectId: row.defect_id,
    assessmentId: row.assessment_id,
    runId: row.map_run_id,
    detail: await getAssessmentDetail(row.assessment_id),
  };
}

export async function searchRemediationPolicies(query, limit = 10) {
  const normalizedQuery = normalizeString(query);
  const normalizedLimit = Math.min(normalizePositiveInt(limit, 10), 50);
  const pattern = normalizedQuery ? `%${escapeLike(normalizedQuery)}%` : null;
  const startsWithPattern = normalizedQuery ? `${escapeLike(normalizedQuery)}%` : null;

  const results = await db.execute(sql`
    SELECT
      p.id,
      p.policy_number,
      p.title,
      p.domain,
      p.sub_domain,
      p.facility_name,
      p.indexed_at
    FROM policies p
    WHERE p.indexed_at IS NOT NULL
      AND ${normalizedPolicyNumberSql(sql`p.policy_number`)} IS NOT NULL
      ${normalizedQuery
    ? sql`AND (
          p.policy_number ILIKE ${pattern} ESCAPE '\'
          OR p.title ILIKE ${pattern} ESCAPE '\'
          OR p.domain ILIKE ${pattern} ESCAPE '\'
          OR p.facility_name ILIKE ${pattern} ESCAPE '\'
        )`
    : sql``}
    ORDER BY
      ${normalizedQuery
    ? sql`CASE
          WHEN p.policy_number ILIKE ${startsWithPattern} ESCAPE '\' THEN 0
          WHEN p.title ILIKE ${startsWithPattern} ESCAPE '\' THEN 1
          ELSE 2
        END,`
    : sql``}
      p.policy_number ASC,
      p.title ASC,
      p.id ASC
    LIMIT ${normalizedLimit}
  `);

  return rowsOf(results).map((row) => ({
    id: row.id,
    policyNumber: row.policy_number,
    title: row.title,
    domain: row.domain,
    subDomain: row.sub_domain,
    facilityName: row.facility_name,
    indexedAt: row.indexed_at,
  }));
}
