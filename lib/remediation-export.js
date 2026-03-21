import JSZip from 'jszip';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export function normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function normalizeRemediationFilters(rawFilters = {}) {
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

export function normalizeRemediationSort(value) {
  return ['worst', 'policy_number', 'title'].includes(value) ? value : 'worst';
}

export function normalizeExportBatchSize(value) {
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

export async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (const batch of chunk(items, batchSize)) {
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
  }
  return results;
}

export function formatTimestamp(value) {
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

function buildCoreXml(exportedAt, workbookTitle) {
  const timestamp = formatTimestamp(exportedAt);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(workbookTitle)}</dc:title>
  <dc:creator>PolicyGuard</dc:creator>
  <cp:lastModifiedBy>PolicyGuard</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>
</cp:coreProperties>`;
}

export async function buildWorkbookBuffer(
  sheets,
  {
    exportedAt = new Date(),
    workbookTitle = 'Remediation Export',
  } = {},
) {
  const zip = new JSZip();
  const sanitizedSheetNames = sheets.map((sheet) => sanitizeSheetName(sheet.name));

  zip.file('[Content_Types].xml', buildContentTypesXml(sheets.length));
  zip.folder('_rels').file('.rels', buildRootRelsXml());
  zip.folder('docProps').file('app.xml', buildAppXml(sanitizedSheetNames));
  zip.folder('docProps').file('core.xml', buildCoreXml(exportedAt, workbookTitle));
  zip.folder('xl').file('workbook.xml', buildWorkbookXml(sanitizedSheetNames));
  zip.folder('xl').folder('_rels').file('workbook.xml.rels', buildWorkbookRels(sheets.length));
  zip.folder('xl').file('styles.xml', buildStylesXml());

  const worksheetFolder = zip.folder('xl').folder('worksheets');
  sheets.forEach((sheet, index) => {
    worksheetFolder.file(`sheet${index + 1}.xml`, buildWorksheetXml(sheet));
  });

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
