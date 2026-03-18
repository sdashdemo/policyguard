import JSZip from 'jszip';
import {
  getAssessmentDetail,
  getRemediationGroups,
  getRemediationItems,
  getRemediationSummary,
} from '@/lib/remediation';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeFilters(rawFilters = {}) {
  return {
    status: ['GAP', 'PARTIAL'].includes(rawFilters?.status) ? rawFilters.status : null,
    source: normalizeString(rawFilters?.source),
    domain: normalizeString(rawFilters?.domain),
    riskTier: normalizeString(rawFilters?.riskTier),
    confidenceMin: normalizeNullableNumber(rawFilters?.confidenceMin),
    confidenceMax: normalizeNullableNumber(rawFilters?.confidenceMax),
    q: normalizeString(rawFilters?.q),
    includeDefects: rawFilters?.includeDefects === true,
  };
}

function normalizeSort(value) {
  return ['worst', 'policy_number', 'title'].includes(value) ? value : 'worst';
}

function normalizeBatchSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 250;
  return Math.min(500, Math.max(100, Math.floor(numeric)));
}

function chunk(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (const batch of chunk(items, batchSize)) {
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
  }
  return results;
}

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

function formatTimestamp(value) {
  return new Date(value).toISOString();
}

function toCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeXml(value) {
  return String(value)
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function sanitizeSheetName(name) {
  return String(name)
    .replace(/[:\\/?*\[\]]/g, ' ')
    .slice(0, 31) || 'Sheet';
}

function buildCellXml(ref, value, options = {}) {
  const styleIndex = options.header
    ? (options.wrap ? 3 : 2)
    : (options.wrap ? 1 : 0);

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${styleIndex}"><v>${value}</v></c>`;
  }

  const text = escapeXml(toCellValue(value));
  return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function buildWorksheetXml(sheet) {
  const columns = sheet.columns || [];
  const rows = sheet.rows || [];
  const lastCell = `${columnName(Math.max(columns.length - 1, 0))}${rows.length + 1}`;
  const colsXml = columns.length
    ? `<cols>${columns.map((column, index) => (
      `<col min="${index + 1}" max="${index + 1}" width="${column.width || 18}" customWidth="1"/>`
    )).join('')}</cols>`
    : '';

  const headerRow = `<row r="1">${columns.map((column, index) => (
    buildCellXml(`${columnName(index)}1`, column.header, { header: true, wrap: Boolean(column.wrap) })
  )).join('')}</row>`;

  const bodyRows = rows.map((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = columns.map((column, columnIndex) => {
      const value = typeof column.value === 'function'
        ? column.value(row)
        : row[column.key];
      return buildCellXml(
        `${columnName(columnIndex)}${excelRow}`,
        value,
        { wrap: Boolean(column.wrap) },
      );
    }).join('');
    return `<row r="${excelRow}">${cells}</row>`;
  }).join('');

  const autoFilter = rows.length && columns.length
    ? `<autoFilter ref="A1:${lastCell}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  ${colsXml}
  <sheetData>${headerRow}${bodyRows}</sheetData>
  ${autoFilter}
</worksheet>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font>
      <sz val="11"/>
      <name val="Calibri"/>
      <family val="2"/>
    </font>
    <font>
      <b/>
      <sz val="11"/>
      <name val="Calibri"/>
      <family val="2"/>
    </font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill>
      <patternFill patternType="solid">
        <fgColor rgb="FFF5F5F4"/>
        <bgColor indexed="64"/>
      </patternFill>
    </fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">
      <alignment wrapText="1" vertical="top"/>
    </xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1">
      <alignment vertical="top"/>
    </xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1">
      <alignment wrapText="1" vertical="top"/>
    </xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
}

function buildWorkbookXml(sheetNames) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews>
    <workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/>
  </bookViews>
  <sheets>
    ${sheetNames.map((name, index) => (
      `<sheet name="${escapeXml(sanitizeSheetName(name))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )).join('')}
  </sheets>
</workbook>`;
}

function buildWorkbookRels(sheetCount) {
  const sheetRels = Array.from({ length: sheetCount }, (_, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function buildContentTypesXml(sheetCount) {
  const sheetOverrides = Array.from({ length: sheetCount }, (_, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${sheetOverrides}
</Types>`;
}

function buildRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildAppXml(sheetNames) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>PolicyGuard</Application>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="${sheetNames.length}" baseType="lpstr">
      ${sheetNames.map((name) => `<vt:lpstr>${escapeXml(sanitizeSheetName(name))}</vt:lpstr>`).join('')}
    </vt:vector>
  </TitlesOfParts>
</Properties>`;
}

function buildCoreXml(exportedAt) {
  const timestamp = formatTimestamp(exportedAt);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Remediation Export</dc:title>
  <dc:creator>PolicyGuard</dc:creator>
  <cp:lastModifiedBy>PolicyGuard</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>
</cp:coreProperties>`;
}

async function buildWorkbookBuffer(sheets, exportedAt) {
  const zip = new JSZip();
  const sanitizedSheetNames = sheets.map((sheet) => sanitizeSheetName(sheet.name));

  zip.file('[Content_Types].xml', buildContentTypesXml(sheets.length));
  zip.folder('_rels').file('.rels', buildRootRelsXml());
  zip.folder('docProps').file('app.xml', buildAppXml(sanitizedSheetNames));
  zip.folder('docProps').file('core.xml', buildCoreXml(exportedAt));
  zip.folder('xl').file('workbook.xml', buildWorkbookXml(sanitizedSheetNames));
  zip.folder('xl').folder('_rels').file('workbook.xml.rels', buildWorkbookRels(sheets.length));
  zip.folder('xl').file('styles.xml', buildStylesXml());

  const worksheetFolder = zip.folder('xl').folder('worksheets');
  sheets.forEach((sheet, index) => {
    worksheetFolder.file(`sheet${index + 1}.xml`, buildWorksheetXml(sheet));
  });

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
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
        { header: 'Covering Policy Number', key: 'coveringPolicyNumber', width: 20 },
        { header: 'Policy Title', key: 'policyTitle', width: 34, wrap: true },
        { header: 'Policy Domain', key: 'policyDomain', width: 18 },
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

    const filters = normalizeFilters(body?.filters);
    const sort = normalizeSort(body?.sort);
    const pageSize = normalizeBatchSize(body?.pageSize);
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

    const workbookBuffer = await buildWorkbookBuffer(sheets, exportedAt);
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
