import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { getAssessmentDetail, getRemediationItems } from './remediation.js';
import {
  buildWorkbookBuffer,
  formatTimestamp,
  mapInBatches,
  normalizeRemediationFilters,
  normalizeString,
} from './remediation-export.js';
import { policies } from './schema.js';

const REVIEWED_DISPOSITIONS = new Set(['confirmed', 'overridden', 'flagged_engine_defect', 'dismissed']);

function sanitizeFilenamePart(value) {
  const normalized = normalizeString(value) || 'policy';
  return normalized.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeString(item))
      .filter(Boolean);
  }

  const normalized = normalizeString(value);
  return normalized ? [normalized] : [];
}

function formatImplementationNotes(value) {
  return normalizeStringList(value).join('\n');
}

function formatPolicyHealthFindings(findings = []) {
  return (Array.isArray(findings) ? findings : [])
    .map((finding) => {
      if (!finding || typeof finding !== 'object') return null;

      const parts = [];
      const severity = normalizeString(finding.severity);
      const issue = normalizeString(finding.issue);
      if (!issue) return null;

      if (severity) parts.push(`[${severity}]`);
      parts.push(issue);

      const insertionPoint = normalizeString(finding.suggestedInsertionPoint);
      if (insertionPoint) parts.push(`Insertion: ${insertionPoint}`);
      if (finding.staleCitation) parts.push('Stale citation');
      if (finding.abbreviationDiscipline) parts.push('Abbreviation discipline');
      if (finding.definedTermDiscipline) parts.push('Defined-term discipline');

      return parts.join(' | ');
    })
    .filter(Boolean)
    .join('\n\n');
}

function buildSummaryRow({
  runId,
  exportedAt,
  policy,
  items,
  details,
  filters,
}) {
  const reviewedCount = details.filter((detail) => REVIEWED_DISPOSITIONS.has(detail.review?.disposition)).length;
  const defectRows = details.filter((detail) => detail.defect);
  const openDefects = defectRows.filter((detail) => detail.defect?.status === 'open').length;
  const acknowledgedDefects = defectRows.filter((detail) => detail.defect?.status === 'acknowledged').length;
  const fixedDefects = defectRows.filter((detail) => detail.defect?.status === 'fixed').length;
  const wontFixDefects = defectRows.filter((detail) => detail.defect?.status === 'wont_fix').length;
  const reviewerSelectedLinks = details.filter((detail) => detail.policyLink?.effectiveSource === 'reviewer_selected').length;
  const backfillLinks = details.filter((detail) => detail.policyLink?.effectiveSource === 'covering_policy_number_backfill').length;
  const legacyFallbackLinks = details.filter((detail) => detail.policyLink?.effectiveSource === 'fallback_legacy_covering_policy_number').length;
  const fixSuggestionRows = details.filter((detail) => detail.fixSuggestion).length;
  const policyHealthRows = details.filter((detail) => detail.policyHealthCheck).length;

  return {
    runId,
    exportedAt: formatTimestamp(exportedAt),
    policyId: policy.id,
    policyNumber: policy.policyNumber,
    policyTitle: policy.title,
    policyDomain: policy.domain,
    policySubDomain: policy.subDomain,
    totalItems: items.length,
    gapCount: items.filter((item) => item.status === 'GAP').length,
    partialCount: items.filter((item) => item.status === 'PARTIAL').length,
    reviewedCount,
    defectCount: defectRows.length,
    openDefects,
    acknowledgedDefects,
    fixedDefects,
    wontFixDefects,
    reviewerSelectedLinks,
    backfillLinks,
    legacyFallbackLinks,
    policyHealthRows,
    fixSuggestionRows,
    filtersApplied: JSON.stringify(filters),
  };
}

export function buildPerPolicyWorkbookSheets({
  runId,
  exportedAt,
  policy,
  items,
  details,
  filters,
}) {
  const detailByAssessmentId = new Map(details.map((detail) => [detail.assessment?.id, detail]));
  const summaryRow = buildSummaryRow({ runId, exportedAt, policy, items, details, filters });
  const policyHealthRows = details
    .filter((detail) => detail.policyHealthCheck)
    .map((detail) => ({
      assessmentId: detail.assessment.id,
      citation: detail.obligation?.citation || null,
      generatedAt: detail.policyHealthCheck.generatedAt,
      promptVersion: detail.policyHealthCheck.promptVersion,
      modelId: detail.policyHealthCheck.modelId,
      summary: detail.policyHealthCheck.summary,
      findings: formatPolicyHealthFindings(detail.policyHealthCheck.findings),
    }));
  const suggestionRows = details
    .filter((detail) => detail.fixSuggestion)
    .map((detail) => ({
      assessmentId: detail.assessment.id,
      citation: detail.obligation?.citation || null,
      generatedAt: detail.fixSuggestion.generatedAt,
      promptVersion: detail.fixSuggestion.promptVersion,
      summary: detail.fixSuggestion.summary,
      draftLanguage: detail.fixSuggestion.draftLanguage,
      implementationNotes: formatImplementationNotes(detail.fixSuggestion.implementationNotes),
      policyHealthSource: detail.fixSuggestion.metadata?.policyHealthSource || null,
      policyHealthCheckId: detail.fixSuggestion.metadata?.policyHealthCheckId || null,
    }));
  const defectRows = details
    .filter((detail) => detail.defect)
    .map((detail) => ({
      assessmentId: detail.assessment.id,
      citation: detail.obligation?.citation || null,
      reviewDisposition: detail.review?.disposition || 'unreviewed',
      defectClass: detail.defect.defect_class,
      defectStatus: detail.defect.status,
      defectSeverity: detail.defect.severity,
      defectOwner: detail.defect.owner,
      resolvedAt: detail.defect.resolved_at,
      note: detail.defect.note,
    }));

  const sheets = [
    {
      name: 'Summary',
      columns: [
        { header: 'Run ID', key: 'runId', width: 24 },
        { header: 'Exported At', key: 'exportedAt', width: 24 },
        { header: 'Policy ID', key: 'policyId', width: 24 },
        { header: 'Policy Number', key: 'policyNumber', width: 20 },
        { header: 'Policy Title', key: 'policyTitle', width: 38, wrap: true },
        { header: 'Policy Domain', key: 'policyDomain', width: 18 },
        { header: 'Policy Sub-domain', key: 'policySubDomain', width: 20 },
        { header: 'Total Items', key: 'totalItems', width: 12 },
        { header: 'GAP Count', key: 'gapCount', width: 12 },
        { header: 'PARTIAL Count', key: 'partialCount', width: 14 },
        { header: 'Reviewed Count', key: 'reviewedCount', width: 14 },
        { header: 'Defect Count', key: 'defectCount', width: 12 },
        { header: 'Open Defects', key: 'openDefects', width: 12 },
        { header: 'Acknowledged Defects', key: 'acknowledgedDefects', width: 18 },
        { header: 'Fixed Defects', key: 'fixedDefects', width: 12 },
        { header: "Won't Fix Defects", key: 'wontFixDefects', width: 16 },
        { header: 'Reviewer-selected Links', key: 'reviewerSelectedLinks', width: 18 },
        { header: 'Backfill Links', key: 'backfillLinks', width: 14 },
        { header: 'Legacy Fallback Links', key: 'legacyFallbackLinks', width: 18 },
        { header: 'Policy Health Rows', key: 'policyHealthRows', width: 16 },
        { header: 'Fix Suggestion Rows', key: 'fixSuggestionRows', width: 16 },
        { header: 'Filters Applied', key: 'filtersApplied', width: 44, wrap: true },
      ],
      rows: [summaryRow],
    },
    {
      name: 'Assessments',
      columns: [
        { header: 'Assessment ID', key: 'assessmentId', width: 24 },
        { header: 'Citation', key: 'citation', width: 24 },
        { header: 'Requirement', key: 'requirement', width: 60, wrap: true },
        { header: 'Assessment Status', key: 'status', width: 16 },
        { header: 'Confidence', key: 'confidence', width: 14 },
        { header: 'Source Name', key: 'sourceName', width: 30, wrap: true },
        { header: 'Risk Tier', key: 'riskTier', width: 16 },
        { header: 'Effective Policy ID', key: 'effectivePolicyId', width: 24 },
        { header: 'Effective Policy Number', key: 'coveringPolicyNumber', width: 22 },
        { header: 'Policy Link Source', key: 'effectivePolicyLinkSource', width: 22 },
        { header: 'Review Disposition', key: 'reviewDisposition', width: 18 },
        { header: 'Override Status', key: 'overrideStatus', width: 18 },
        { header: 'Review Note', key: 'reviewNote', width: 40, wrap: true },
        { header: 'Defect Queue Status', key: 'defectStatus', width: 18 },
        { header: 'Defect Severity', key: 'defectSeverity', width: 16 },
        { header: 'Defect Owner', key: 'defectOwner', width: 18 },
        { header: 'Defect Resolved At', key: 'defectResolvedAt', width: 24 },
        { header: 'Policy Health Cached', key: 'hasPolicyHealth', width: 16 },
        { header: 'Policy Health Generated At', key: 'policyHealthGeneratedAt', width: 24 },
        { header: 'Fix Suggestion Saved', key: 'hasFixSuggestion', width: 16 },
        { header: 'Fix Suggestion Generated At', key: 'fixSuggestionGeneratedAt', width: 24 },
        { header: 'Gap Detail', key: 'gapDetail', width: 54, wrap: true },
        { header: 'Reasoning', key: 'reasoning', width: 54, wrap: true },
      ],
      rows: items.map((item) => {
        const detail = detailByAssessmentId.get(item.assessmentId);
        return {
          ...item,
          reviewDisposition: item.reviewDisposition || 'unreviewed',
          defectStatus: detail?.defect?.status || null,
          defectSeverity: detail?.defect?.severity || null,
          defectOwner: detail?.defect?.owner || null,
          defectResolvedAt: detail?.defect?.resolved_at || null,
          hasPolicyHealth: Boolean(detail?.policyHealthCheck),
          policyHealthGeneratedAt: detail?.policyHealthCheck?.generatedAt || null,
          hasFixSuggestion: Boolean(detail?.fixSuggestion),
          fixSuggestionGeneratedAt: detail?.fixSuggestion?.generatedAt || null,
        };
      }),
    },
    {
      name: 'Provisions',
      columns: [
        { header: 'Provision ID', key: 'id', width: 24 },
        { header: 'Section', key: 'section', width: 20 },
        { header: 'Source Citation', key: 'sourceCitation', width: 28 },
        { header: 'Text', key: 'text', width: 90, wrap: true },
      ],
      rows: details[0]?.provisions || [],
    },
  ];

  if (policyHealthRows.length) {
    sheets.push({
      name: 'Policy Health',
      columns: [
        { header: 'Assessment ID', key: 'assessmentId', width: 24 },
        { header: 'Citation', key: 'citation', width: 24 },
        { header: 'Generated At', key: 'generatedAt', width: 24 },
        { header: 'Prompt Version', key: 'promptVersion', width: 18 },
        { header: 'Model ID', key: 'modelId', width: 24 },
        { header: 'Summary', key: 'summary', width: 54, wrap: true },
        { header: 'Findings', key: 'findings', width: 80, wrap: true },
      ],
      rows: policyHealthRows,
    });
  }

  if (suggestionRows.length) {
    sheets.push({
      name: 'Fix Suggestions',
      columns: [
        { header: 'Assessment ID', key: 'assessmentId', width: 24 },
        { header: 'Citation', key: 'citation', width: 24 },
        { header: 'Generated At', key: 'generatedAt', width: 24 },
        { header: 'Prompt Version', key: 'promptVersion', width: 18 },
        { header: 'Summary', key: 'summary', width: 48, wrap: true },
        { header: 'Draft Language', key: 'draftLanguage', width: 90, wrap: true },
        { header: 'Implementation Notes', key: 'implementationNotes', width: 48, wrap: true },
        { header: 'Policy Health Source', key: 'policyHealthSource', width: 18 },
        { header: 'Policy Health Check ID', key: 'policyHealthCheckId', width: 24 },
      ],
      rows: suggestionRows,
    });
  }

  if (defectRows.length) {
    sheets.push({
      name: 'Defects',
      columns: [
        { header: 'Assessment ID', key: 'assessmentId', width: 24 },
        { header: 'Citation', key: 'citation', width: 24 },
        { header: 'Review Disposition', key: 'reviewDisposition', width: 18 },
        { header: 'Defect Class', key: 'defectClass', width: 18 },
        { header: 'Queue Status', key: 'defectStatus', width: 18 },
        { header: 'Severity', key: 'defectSeverity', width: 14 },
        { header: 'Owner', key: 'defectOwner', width: 18 },
        { header: 'Resolved At', key: 'resolvedAt', width: 24 },
        { header: 'Note', key: 'note', width: 60, wrap: true },
      ],
      rows: defectRows,
    });
  }

  return sheets;
}

function createStatusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function getPerPolicyExportPayload({
  runId,
  policyId,
  filters = {},
  itemLimit = null,
}) {
  const normalizedRunId = normalizeString(runId);
  if (!normalizedRunId) {
    throw createStatusError('Missing runId', 400);
  }

  const normalizedPolicyId = normalizeString(policyId);
  if (!normalizedPolicyId) {
    throw createStatusError('Missing policyId', 400);
  }

  const normalizedFilters = normalizeRemediationFilters(filters);
  const [policyRow] = await db
    .select({
      id: policies.id,
      policyNumber: policies.policy_number,
      title: policies.title,
      domain: policies.domain,
      subDomain: policies.sub_domain,
    })
    .from(policies)
    .where(eq(policies.id, normalizedPolicyId))
    .limit(1);

  if (!policyRow) {
    throw createStatusError('Policy not found', 404);
  }

  const policyNumber = normalizeString(policyRow.policyNumber);
  if (!policyNumber) {
    throw createStatusError('Selected policy does not have a policy number', 400);
  }

  const items = (await getRemediationItems(normalizedRunId, policyNumber, normalizedFilters))
    .filter((item) => item.effectivePolicyId === normalizedPolicyId);

  if (!items.length) {
    throw createStatusError('No remediation items found for this policy under the current filters', 404);
  }

  const normalizedItemLimit = Number.isFinite(Number(itemLimit)) && Number(itemLimit) > 0
    ? Math.floor(Number(itemLimit))
    : null;
  const scopedItems = normalizedItemLimit ? items.slice(0, normalizedItemLimit) : items;
  const details = await mapInBatches(scopedItems, 8, async (item) => (
    getAssessmentDetail(item.assessmentId)
  ));

  return {
    runId: normalizedRunId,
    policyId: normalizedPolicyId,
    policy: {
      ...policyRow,
      policyNumber,
    },
    filters: normalizedFilters,
    items: scopedItems,
    details,
    totalAvailableItems: items.length,
  };
}

export async function buildPerPolicyExportArtifact({
  runId,
  policyId,
  filters = {},
  exportedAt = new Date(),
  itemLimit = null,
}) {
  const payload = await getPerPolicyExportPayload({
    runId,
    policyId,
    filters,
    itemLimit,
  });

  const sheets = buildPerPolicyWorkbookSheets({
    runId: payload.runId,
    exportedAt,
    policy: payload.policy,
    items: payload.items,
    details: payload.details,
    filters: payload.filters,
  });

  const workbookBuffer = await buildWorkbookBuffer(sheets, {
    exportedAt,
    workbookTitle: `Policy Export ${payload.policy.policyNumber}`,
  });
  const timestamp = formatTimestamp(exportedAt).replace(/[:]/g, '-');
  const filename = `policy_${sanitizeFilenamePart(payload.policy.policyNumber)}_${payload.runId}_${timestamp}.xlsx`;

  return {
    ...payload,
    exportedAt,
    sheets,
    workbookBuffer,
    filename,
  };
}
