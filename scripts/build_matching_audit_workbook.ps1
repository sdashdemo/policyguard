$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactsDir = Join-Path $repoRoot 'artifacts'
$outputPath = Join-Path $artifactsDir 'matching_ground_truth_audit.xlsx'

if (-not (Test-Path $artifactsDir)) {
    New-Item -ItemType Directory -Path $artifactsDir | Out-Null
}

function Get-NodeExe {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $portableNode = Join-Path $env:USERPROFILE 'Apps\node-v24.14.0-win-x64\node.exe'
    if (Test-Path $portableNode) {
        return $portableNode
    }

    throw 'node.exe was not found. Make sure portable Node is available.'
}

function Convert-ToExcelColumnName {
    param([int]$Index)

    $name = ''
    while ($Index -gt 0) {
        $Index--
        $name = [char](65 + ($Index % 26)) + $name
        $Index = [math]::Floor($Index / 26)
    }
    return $name
}

function Escape-XmlText {
    param([string]$Text)

    if ($null -eq $Text) {
        return ''
    }

    $escaped = [System.Security.SecurityElement]::Escape($Text)
    if ($escaped.StartsWith(' ') -or $escaped.EndsWith(' ') -or $escaped.Contains("`n")) {
        return "<t xml:space=`"preserve`">$escaped</t>"
    }

    return "<t>$escaped</t>"
}

function New-InlineCellXml {
    param(
        [int]$ColumnIndex,
        [int]$RowIndex,
        [string]$Value,
        [int]$StyleIndex = 2
    )

    $cellRef = '{0}{1}' -f (Convert-ToExcelColumnName $ColumnIndex), $RowIndex
    $textNode = Escape-XmlText $Value
    return "<c r=`"$cellRef`" s=`"$StyleIndex`" t=`"inlineStr`"><is>$textNode</is></c>"
}

function New-RowXml {
    param(
        [int]$RowIndex,
        [object[]]$Values,
        [int]$StyleIndex = 2
    )

    $cells = for ($i = 0; $i -lt $Values.Count; $i++) {
        New-InlineCellXml -ColumnIndex ($i + 1) -RowIndex $RowIndex -Value ([string]$Values[$i]) -StyleIndex $StyleIndex
    }

    return "<row r=`"$RowIndex`">$($cells -join '')</row>"
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

$nodeExe = Get-NodeExe

$nodeScript = @'
process.loadEnvFile('.env.local');
import postgres from 'postgres';

const RUN_ID = 'run_mm8f0sr6_m5fglsty';
const auditRows = [
  { bucket: 'mismatch', citation: 'CTS.03.01.09 EP 3', expected_policy_number: 'LD 4.003', top1_policy_number: 'CL-1.011', found_rank: 2 },
  { bucket: 'mismatch', citation: 'CTS.04.03.33 EP 9', expected_policy_number: 'EC-1.004', top1_policy_number: 'CL 6.002', found_rank: 2 },
  { bucket: 'mismatch', citation: 'TJC LS.02.01.40 EP 1', expected_policy_number: 'LS-1.001', top1_policy_number: 'EC-1.008', found_rank: 2 },
  { bucket: 'mismatch', citation: 'TJC LS.04.02.30 EP 12', expected_policy_number: 'LS-1.001', top1_policy_number: 'EC-1.008', found_rank: 2 },
  { bucket: 'mismatch', citation: 'TJC LS.04.02.30 EP 17', expected_policy_number: 'LS-1.001', top1_policy_number: 'EC-1.008', found_rank: 2 },
  { bucket: 'mismatch', citation: 'CTS.05.04.03 EP 1', expected_policy_number: 'CL3.007', top1_policy_number: 'LD 4.003', found_rank: 3 },
  { bucket: 'sibling_confusion', citation: 'TJC LD.03.03.01 EP 2', expected_policy_number: 'LD-2.004', top1_policy_number: 'LD-2.005', found_rank: 3 },
  { bucket: 'mismatch', citation: 'TJC LS.04.02.30 EP 4', expected_policy_number: 'LS-1.001', top1_policy_number: 'EC-1.008', found_rank: 3 },
  { bucket: 'sibling_confusion', citation: 'CTS.02.02.05 EP 3', expected_policy_number: 'CL2.004', top1_policy_number: 'CL-7.003', found_rank: 4 },
  { bucket: 'mismatch', citation: 'CTS.04.01.01 EP 3', expected_policy_number: 'NUR-3.001', top1_policy_number: 'CL-1.011', found_rank: 4 },
  { bucket: 'clean_hit', citation: '397.321(7)(a)', expected_policy_number: 'CL2.004', top1_policy_number: 'CL2.004', found_rank: 1 },
  { bucket: 'clean_hit', citation: '65D-30.004(1)', expected_policy_number: 'LD-4.001', top1_policy_number: 'LD-4.001', found_rank: 1 },
  { bucket: 'clean_hit', citation: '65D-30.0042(2)(a)(2)', expected_policy_number: 'MED-3.004a', top1_policy_number: 'MED-3.004a', found_rank: 1 },
  { bucket: 'clean_hit', citation: '65D-30.0042(2)(b)(3)', expected_policy_number: 'CL2.004', top1_policy_number: 'CL2.004', found_rank: 1 },
  { bucket: 'clean_hit', citation: '65D-30.0044(1)(a)', expected_policy_number: 'CL3.007', top1_policy_number: 'CL3.007', found_rank: 1 },
  { bucket: 'sibling_confusion', citation: '397.403(1)(f)', expected_policy_number: 'EC 1.010', top1_policy_number: 'EC-1.008', found_rank: 2 },
  { bucket: 'sibling_confusion', citation: '65D-30.012(2)(b)2', expected_policy_number: 'CL1.007', top1_policy_number: 'CL1.014', found_rank: 2 },
  { bucket: 'sibling_confusion', citation: 'TJC EC.02.03.03 EP 1', expected_policy_number: 'EC-1.007', top1_policy_number: 'EC-1.008', found_rank: 2 },
  { bucket: 'sibling_confusion', citation: 'TJC MM.05.01.17 EP 1 ESP-1', expected_policy_number: 'MMP-3.007', top1_policy_number: 'MMP-2.005', found_rank: 2 },
  { bucket: 'sibling_confusion', citation: 'CTS.06.02.03 EP 1', expected_policy_number: 'CL-1.005', top1_policy_number: 'CL-1.003', found_rank: 3 },
];

function placeholders(values, start = 1) {
  return values.map((_, index) => `$${start + index}`).join(', ');
}

function normalizePolicyNumber(value) {
  return String(value || '').toUpperCase().replace(/[\s-]/g, '');
}

function reviewFocus(bucket) {
  switch (bucket) {
    case 'clean_hit':
      return 'Confirm that the expected policy is clearly the best match.';
    case 'sibling_confusion':
      return 'Check whether both policies are acceptable siblings or whether only one truly addresses the requirement.';
    default:
      return 'Decide whether the benchmark picked the wrong policy or the current top1 is just a generic thematic match.';
  }
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

const citations = auditRows.map(row => row.citation);
const obligationQuery = `
  select distinct on (o.citation)
    o.id as obligation_id,
    o.citation,
    o.requirement
  from obligations o
  join coverage_assessments ca on ca.obligation_id = o.id
  where ca.map_run_id = $1
    and o.citation in (${placeholders(citations, 2)})
  order by o.citation, ca.updated_at desc nulls last, ca.created_at desc nulls last
`;
const obligationRows = await sql.unsafe(obligationQuery, [RUN_ID, ...citations]);
const obligationsByCitation = new Map(obligationRows.map(row => [row.citation, row]));

const policyNumbers = [...new Set(auditRows.flatMap(row => [row.expected_policy_number, row.top1_policy_number]).map(normalizePolicyNumber))];
const policyQuery = `
  select id, policy_number, title
  from policies
  where upper(regexp_replace(coalesce(policy_number, ''), '[\\s-]+', '', 'g')) in (${placeholders(policyNumbers)})
`;
const policyRows = await sql.unsafe(policyQuery, policyNumbers);
const policiesByNumber = new Map(
  policyRows.map(row => [normalizePolicyNumber(row.policy_number), row])
);

const enriched = auditRows.map(row => {
  const obligation = obligationsByCitation.get(row.citation) || {};
  const expectedPolicy = policiesByNumber.get(normalizePolicyNumber(row.expected_policy_number)) || {};
  const top1Policy = policiesByNumber.get(normalizePolicyNumber(row.top1_policy_number)) || {};

  return {
    bucket: row.bucket,
    review_focus: reviewFocus(row.bucket),
    citation: row.citation,
    obligation_id: obligation.obligation_id || '',
    requirement: obligation.requirement || '',
    expected_policy_number: row.expected_policy_number,
    expected_title: expectedPolicy.title || '',
    current_top1_policy_number: row.top1_policy_number,
    current_top1_title: top1Policy.title || '',
    found_rank: row.found_rank,
    review_label: '',
    comments: '',
  };
});

console.log(JSON.stringify(enriched, null, 2));
await sql.end();
'@

Push-Location $repoRoot
try {
    $auditJson = $nodeScript | & $nodeExe --input-type=module -
}
finally {
    Pop-Location
}

$auditRows = $auditJson | ConvertFrom-Json

$instructions = @(
    @('Topic', 'Guidance'),
    @('Goal', 'Validate whether covering_policy_number is trustworthy benchmark ground truth. You are not tuning the matcher here.'),
    @('What to compare', 'For each row, compare the obligation requirement against the Expected Policy and the Current Top1 Policy.'),
    @('If titles are not enough', 'Open the two policies and inspect the most relevant provision or section that actually addresses the requirement.'),
    @('Gold correct', 'The Expected Policy is clearly the best policy for the obligation.'),
    @('Acceptable alternate', 'The Current Top1 is also a reasonable match, so the benchmark may be too strict for this row.'),
    @('Benchmark wrong', 'The Current Top1 looks better than the Expected Policy.'),
    @('Ambiguous', 'Both are plausible or neither is clearly right without more context.'),
    @('What you are looking for', 'Favor the policy that directly satisfies the requirement, not the one that only shares generic words like fire, safety, referral, policy, or reporting.'),
    @('How to use the buckets', 'Mismatch rows stress the benchmark. Sibling confusion rows check whether the benchmark is distinguishing similar policy families fairly. Clean hit rows confirm the benchmark is not obviously broken.'),
    @('Decision threshold', 'If about 17 or more of the 20 rows are Gold correct, the benchmark is trustworthy enough for matcher tuning. If many rows are Acceptable alternate or Ambiguous, top3 or top5 is a more honest KPI than strict top1.')
)

$auditTable = @(
    @(
        'Bucket',
        'Review Focus',
        'Citation',
        'Obligation ID',
        'Requirement',
        'Expected Policy #',
        'Expected Title',
        'Current Top1 Policy #',
        'Current Top1 Title',
        'Found Rank',
        'Review Label',
        'Comments'
    )
)

foreach ($row in $auditRows) {
    $auditTable += ,@(
        [string]$row.bucket,
        [string]$row.review_focus,
        [string]$row.citation,
        [string]$row.obligation_id,
        [string]$row.requirement,
        [string]$row.expected_policy_number,
        [string]$row.expected_title,
        [string]$row.current_top1_policy_number,
        [string]$row.current_top1_title,
        [string]$row.found_rank,
        '',
        ''
    )
}

$instructionsRowsXml = for ($rowIndex = 0; $rowIndex -lt $instructions.Count; $rowIndex++) {
    New-RowXml -RowIndex ($rowIndex + 1) -Values $instructions[$rowIndex] -StyleIndex ($(if ($rowIndex -eq 0) { 1 } else { 2 }))
}

$auditRowsXml = for ($rowIndex = 0; $rowIndex -lt $auditTable.Count; $rowIndex++) {
    New-RowXml -RowIndex ($rowIndex + 1) -Values $auditTable[$rowIndex] -StyleIndex ($(if ($rowIndex -eq 0) { 1 } else { 2 }))
}

$instructionsCols = @(
    '<col min="1" max="1" width="20" customWidth="1"/>',
    '<col min="2" max="2" width="120" customWidth="1"/>'
) -join ''

$auditCols = @(
    '<col min="1" max="1" width="18" customWidth="1"/>',
    '<col min="2" max="2" width="55" customWidth="1"/>',
    '<col min="3" max="3" width="25" customWidth="1"/>',
    '<col min="4" max="4" width="24" customWidth="1"/>',
    '<col min="5" max="5" width="80" customWidth="1"/>',
    '<col min="6" max="6" width="18" customWidth="1"/>',
    '<col min="7" max="7" width="38" customWidth="1"/>',
    '<col min="8" max="8" width="20" customWidth="1"/>',
    '<col min="9" max="9" width="38" customWidth="1"/>',
    '<col min="10" max="10" width="12" customWidth="1"/>',
    '<col min="11" max="11" width="20" customWidth="1"/>',
    '<col min="12" max="12" width="55" customWidth="1"/>'
) -join ''

$instructionsSheet = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>$instructionsCols</cols>
  <sheetData>
    $($instructionsRowsXml -join "`n    ")
  </sheetData>
</worksheet>
"@

$auditSheet = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>$auditCols</cols>
  <sheetData>
    $($auditRowsXml -join "`n    ")
  </sheetData>
</worksheet>
"@

$contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>
'@

$rootRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
'@

$workbookXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Instructions" sheetId="1" r:id="rId1"/>
    <sheet name="Audit" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>
'@

$workbookRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
'@

$stylesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">
      <alignment wrapText="1" vertical="top"/>
    </xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>
'@

$stagingRoot = Join-Path $artifactsDir 'matching_ground_truth_audit_build'
if (Test-Path $stagingRoot) {
    Remove-Item -Recurse -Force $stagingRoot
}
New-Item -ItemType Directory -Path $stagingRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot '_rels') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot 'xl') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot 'xl\_rels') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot 'xl\worksheets') | Out-Null

Write-Utf8NoBom -Path (Join-Path $stagingRoot '[Content_Types].xml') -Content $contentTypes
Write-Utf8NoBom -Path (Join-Path $stagingRoot '_rels\.rels') -Content $rootRels
Write-Utf8NoBom -Path (Join-Path $stagingRoot 'xl\workbook.xml') -Content $workbookXml
Write-Utf8NoBom -Path (Join-Path $stagingRoot 'xl\_rels\workbook.xml.rels') -Content $workbookRels
Write-Utf8NoBom -Path (Join-Path $stagingRoot 'xl\styles.xml') -Content $stylesXml
Write-Utf8NoBom -Path (Join-Path $stagingRoot 'xl\worksheets\sheet1.xml') -Content $instructionsSheet
Write-Utf8NoBom -Path (Join-Path $stagingRoot 'xl\worksheets\sheet2.xml') -Content $auditSheet

if (Test-Path $outputPath) {
    Remove-Item -Force $outputPath
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingRoot, $outputPath)
Remove-Item -Recurse -Force $stagingRoot

Write-Host $outputPath
