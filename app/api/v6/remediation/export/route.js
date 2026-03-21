import {
  getAssessmentDetail,
  getRemediationGroups,
  getRemediationItems,
  getRemediationSummary,
} from '@/lib/remediation';
import {
  buildWorkbookBuffer,
  formatTimestamp,
  mapInBatches,
  normalizeExportBatchSize,
  normalizeRemediationFilters,
  normalizeRemediationSort,
  normalizeString,
  XLSX_MIME,
} from '@/lib/remediation-export';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

async function collectAllGroups(runId, filters, sort, pageSize) {
  const firstPage = await getRemediationGroups(runId, filters, sort, 1, pageSize);
  const groups = [...(firstPage.groups || [])];

  if ((firstPage.totalPages || 0) <= 1) {
    return groups;
  }

  const remainingPages = Array.from(
    { length: Math.max(0, firstPage.totalPages - 1) },
    (_, index) => index + 2,
  );

  const remainingResults = await mapInBatches(remainingPages, 4, (page) => (
    getRemediationGroups(runId, filters, sort, page, pageSize)
  ));

  for (const pageResult of remainingResults) {
    groups.push(...(pageResult.groups || []));
  }

  return groups;
}

async function collectItemsForGroups(runId, groups, filters) {
  const groupItems = await mapInBatches(groups, 8, async (group) => ({
    policyNumber: group.policyNumber,
    items: await getRemediationItems(runId, group.policyNumber, filters),
  }));

  return groupItems.flatMap((entry) => entry.items || []);
}

async function collectDefectRows(runId, filters, sort, pageSize, existingItems) {
  const defectItems = filters.includeDefects
    ? (existingItems || []).filter((item) => item.hasDefect)
    : await (async () => {
      const defectGroups = await collectAllGroups(runId, { ...filters, includeDefects: true }, sort, pageSize);
      const defectUniverseItems = await collectItemsForGroups(runId, defectGroups, { ...filters, includeDefects: true });
      return defectUniverseItems.filter((item) => item.hasDefect);
    })();

  if (!defectItems.length) return [];

  const uniqueItems = [];
  const seen = new Set();
  for (const item of defectItems) {
    if (seen.has(item.assessmentId)) continue;
    seen.add(item.assessmentId);
    uniqueItems.push(item);
  }

  const details = await mapInBatches(uniqueItems, 8, async (item) => {
    const detail = await getAssessmentDetail(item.assessmentId);
    return {
      assessmentId: item.assessmentId,
      citation: item.citation,
      status: item.status,
      defectClass: detail.defect?.defect_class || null,
      defectStatus: detail.defect?.status || null,
      note: detail.defect?.note || null,
    };
  });

  return details;
}

function buildWorkbookSheets({ runId, exportedAt, summary, groups, items, defects }) {
  const sheets = [
    {
      name: 'Summary',
      columns: [
        { header: 'Run ID', key: 'runId', width: 24 },
        { header: 'Exported At', key: 'exportedAt', width: 24 },
        { header: 'GAP Count', key: 'gapCount', width: 12 },
        { header: 'PARTIAL Count', key: 'partialCount', width: 14 },
        { header: 'Policies Needing Work', key: 'totalPoliciesNeedingWork', width: 20 },
        { header: 'Reviewed Count', key: 'reviewedCount', width: 14 },
        { header: 'Dismissed Count', key: 'dismissedCount', width: 14 },
        { header: 'Defect Count', key: 'defectCount', width: 12 },
        { header: 'Unreviewed', key: 'progressUnreviewed', width: 12 },
        { header: 'Confirmed', key: 'progressConfirmed', width: 12 },
        { header: 'Overridden', key: 'progressOverridden', width: 12 },
        { header: 'Flagged Engine Defect', key: 'progressFlaggedEngineDefect', width: 20 },
        { header: 'Dismissed', key: 'progressDismissed', width: 12 },
      ],
      rows: [{
        runId,
        exportedAt: formatTimestamp(exportedAt),
        gapCount: summary.gapCount,
        partialCount: summary.partialCount,
        totalPoliciesNeedingWork: summary.totalPoliciesNeedingWork,
        reviewedCount: summary.reviewedCount,
        dismissedCount: summary.dismissedCount,
        defectCount: summary.defectCount,
        progressUnreviewed: summary.progress?.unreviewed || 0,
        progressConfirmed: summary.progress?.confirmed || 0,
        progressOverridden: summary.progress?.overridden || 0,
        progressFlaggedEngineDefect: summary.progress?.flagged_engine_defect || 0,
        progressDismissed: summary.progress?.dismissed || 0,
      }],
    },
    {
      name: 'Policy Groups',
      columns: [
        { header: 'Policy Number', key: 'policyNumber', width: 20 },
        { header: 'Policy Title', key: 'policyTitle', width: 34, wrap: true },
        { header: 'Canonical Policy ID', key: 'canonicalPolicyId', width: 24 },
        { header: 'Distinct Policy IDs', key: 'distinctPolicyIds', width: 18 },
        { header: 'GAP Count', key: 'gapCount', width: 12 },
        { header: 'PARTIAL Count', key: 'partialCount', width: 14 },
        { header: 'Total Count', key: 'totalCount', width: 12 },
        { header: 'Score', key: 'score', width: 10 },
      ],
      rows: groups,
    },
    {
      name: 'Items',
      columns: [
        { header: 'Assessment ID', key: 'assessmentId', width: 24 },
        { header: 'Citation', key: 'citation', width: 24 },
        { header: 'Requirement', key: 'requirement', width: 60, wrap: true },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Confidence', key: 'confidence', width: 14 },
        { header: 'Source Name', key: 'sourceName', width: 30, wrap: true },
        { header: 'Risk Tier', key: 'riskTier', width: 16 },
        { header: 'Effective Policy ID', key: 'effectivePolicyId', width: 24 },
        { header: 'Covering Policy Number', key: 'coveringPolicyNumber', width: 20 },
        { header: 'Policy Title', key: 'policyTitle', width: 34, wrap: true },
        { header: 'Policy Domain', key: 'policyDomain', width: 18 },
        { header: 'Policy Link Source', key: 'effectivePolicyLinkSource', width: 22 },
        { header: 'Review Disposition', key: 'reviewDisposition', width: 18 },
        { header: 'Override Status', key: 'overrideStatus', width: 18 },
        { header: 'Review Note', key: 'reviewNote', width: 40, wrap: true },
        { header: 'Has Defect', key: 'hasDefect', width: 12 },
        { header: 'Gap Detail', key: 'gapDetail', width: 54, wrap: true },
        { header: 'Reasoning', key: 'reasoning', width: 54, wrap: true },
      ],
      rows: items.map((item) => ({
        ...item,
        coveringPolicyNumber: item.coveringPolicyNumber || 'Unassigned',
        reviewDisposition: item.reviewDisposition || 'unreviewed',
      })),
    },
  ];

  if (defects.length) {
    sheets.push({
      name: 'Defects',
      columns: [
        { header: 'Assessment ID', key: 'assessmentId', width: 24 },
        { header: 'Citation', key: 'citation', width: 24 },
        { header: 'Assessment Status', key: 'status', width: 16 },
        { header: 'Defect Class', key: 'defectClass', width: 20 },
        { header: 'Defect Status', key: 'defectStatus', width: 18 },
        { header: 'Note', key: 'note', width: 48, wrap: true },
      ],
      rows: defects,
    });
  }

  return sheets;
}

export async function POST(req) {
  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const runId = normalizeString(body?.runId);
    if (!runId) {
      return Response.json({ error: 'Missing runId' }, { status: 400 });
    }

    const filters = normalizeRemediationFilters(body?.filters);
    const sort = normalizeRemediationSort(body?.sort);
    const pageSize = normalizeExportBatchSize(body?.pageSize);
    const exportedAt = new Date();

    const summary = await getRemediationSummary(runId, filters);
    const groups = await collectAllGroups(runId, filters, sort, pageSize);
    const items = await collectItemsForGroups(runId, groups, filters);
    const defects = await collectDefectRows(runId, filters, sort, pageSize, items);

    const sheets = buildWorkbookSheets({
      runId,
      exportedAt,
      summary,
      groups,
      items,
      defects,
    });

    const workbookBuffer = await buildWorkbookBuffer(sheets, {
      exportedAt,
      workbookTitle: 'Remediation Export',
    });
    const timestamp = formatTimestamp(exportedAt).replace(/[:]/g, '-');
    const filename = `remediation_${runId}_${timestamp}.xlsx`;

    return new Response(workbookBuffer, {
      status: 200,
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Remediation export error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
