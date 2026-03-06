param(
    [string]$RunId = 'run_mm8f0sr6_m5fglsty',
    [int]$SampleSize = 100
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactsDir = Join-Path $repoRoot 'artifacts'
$jsonPath = Join-Path $artifactsDir ("matching_benchmark_{0}_n{1}.json" -f $RunId, $SampleSize)
$outputPath = Join-Path $artifactsDir ("matching_benchmark_{0}_n{1}.xlsx" -f $RunId, $SampleSize)

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

function Format-SignalBreakdown {
    param($Signal)

    if ($null -eq $Signal) {
        return ''
    }

    return @(
        "citation=$($Signal.citation)"
        "sub_domain=$($Signal.sub_domain)"
        "keyword=$($Signal.keyword)"
        "title=$($Signal.title)"
        "vector=$($Signal.vector)"
        "fts=$($Signal.fts)"
    ) -join "`n"
}

function Format-TopCandidates {
    param($Candidates)

    if ($null -eq $Candidates) {
        return ''
    }

    $lines = foreach ($candidate in $Candidates) {
        $signal = Format-SignalBreakdown $candidate.signal_breakdown
        "{0}. {1} | {2} | score={3} | rank_score={4}`n{5}" -f `
            $candidate.rank,
            $candidate.policy_number,
            $candidate.title,
            $candidate.score,
            $candidate.rank_score,
            $signal
    }

    return ($lines -join "`n`n").Trim()
}

$nodeExe = Get-NodeExe

Push-Location $repoRoot
try {
    & $nodeExe (Join-Path $repoRoot 'scripts\benchmark_matching_broad.mjs') $RunId $SampleSize | Out-Null
}
finally {
    Pop-Location
}

if (-not (Test-Path $jsonPath)) {
    throw "Benchmark JSON was not created at $jsonPath"
}

$benchmark = Get-Content -Path $jsonPath -Raw | ConvertFrom-Json

$summaryRows = @(
    @('Metric', 'Value'),
    @('Map Run', [string]$benchmark.map_run_id),
    @('Sample Size', [string]$benchmark.sample_size),
    @('Generated At', [string]$benchmark.generated_at),
    @('Top1 Hits', [string]$benchmark.summary.top1),
    @('Top3 Hits', [string]$benchmark.summary.top3),
    @('Top5 Hits', [string]$benchmark.summary.top5),
    @('Top10 Hits', [string]$benchmark.summary.top10),
    @('Average Latency Ms', [string]$benchmark.summary.avg_latency_ms),
    @('P95 Latency Ms', [string]$benchmark.summary.p95_latency_ms),
    @('Top1 With Vector', [string]$benchmark.summary.top1_with_vector),
    @('Top1 With FTS', [string]$benchmark.summary.top1_with_fts),
    @('Any Top5 With Vector', [string]$benchmark.summary.any_top5_with_vector),
    @('Any Top5 With FTS', [string]$benchmark.summary.any_top5_with_fts)
)

$instructions = @(
    @('Topic', 'Guidance'),
    @('Goal', 'Review broad matcher behavior on a deterministic sample from the latest mapping run.'),
    @('How to use it', 'Start with the rows where Found Rank is blank or greater than 1. Those are the most useful tuning cases.'),
    @('What to compare', 'Compare the Requirement against the Benchmark Policy and the Top1 Policy. Use Top5 Candidates when the benchmark looks noisy or too strict.'),
    @('Review Label options', 'Use Gold correct, Acceptable alternate, Benchmark wrong, Ambiguous, or Leave out.'),
    @('What to watch for', 'Look for generic policies beating more specific ones, citation crosswalks dominating the wrong family, and broad titles winning on weak overlap.'),
    @('How to tweak', 'If you see a repeated failure mode, note the general rule in Comments. Do not write policy-specific fixes unless the data proves it is isolated.'),
    @('Important', 'This sheet is for matcher tuning. The broad sample uses covering_policy_number as provisional ground truth, so treat single-row disagreements carefully.')
)

$resultsTable = @(
    @(
        'Citation',
        'Obligation ID',
        'Requirement',
        'Benchmark Policy #',
        'Benchmark Title',
        'Top1 Policy #',
        'Top1 Title',
        'Found Rank',
        'Top1 Hit',
        'Top3 Hit',
        'Top5 Hit',
        'Top10 Hit',
        'Latency Ms',
        'Top1 Has Vector',
        'Top1 Has FTS',
        'Any Top5 Has Vector',
        'Any Top5 Has FTS',
        'Top5 Candidates',
        'Top1 Signals',
        'Matched Signals',
        'Review Label',
        'Comments'
    )
)

foreach ($row in $benchmark.rows) {
    $resultsTable += ,@(
        [string]$row.citation,
        [string]$row.obligation_id,
        [string]$row.requirement,
        [string]$row.benchmark_policy_number,
        [string]$row.benchmark_title,
        [string]$row.top1_policy_number,
        [string]$row.top1_title,
        [string]$row.found_rank,
        [string]$row.top1_hit,
        [string]$row.top3_hit,
        [string]$row.top5_hit,
        [string]$row.top10_hit,
        [string]$row.latency_ms,
        [string]$row.top1_has_vector,
        [string]$row.top1_has_fts,
        [string]$row.any_top5_has_vector,
        [string]$row.any_top5_has_fts,
        (Format-TopCandidates $row.top5_candidates),
        (Format-SignalBreakdown $row.top1_signal_breakdown),
        (Format-SignalBreakdown $row.matched_signal_breakdown),
        '',
        ''
    )
}

$summaryRowsXml = for ($rowIndex = 0; $rowIndex -lt $summaryRows.Count; $rowIndex++) {
    New-RowXml -RowIndex ($rowIndex + 1) -Values $summaryRows[$rowIndex] -StyleIndex ($(if ($rowIndex -eq 0) { 1 } else { 2 }))
}

$instructionsRowsXml = for ($rowIndex = 0; $rowIndex -lt $instructions.Count; $rowIndex++) {
    New-RowXml -RowIndex ($rowIndex + 1) -Values $instructions[$rowIndex] -StyleIndex ($(if ($rowIndex -eq 0) { 1 } else { 2 }))
}

$resultsRowsXml = for ($rowIndex = 0; $rowIndex -lt $resultsTable.Count; $rowIndex++) {
    New-RowXml -RowIndex ($rowIndex + 1) -Values $resultsTable[$rowIndex] -StyleIndex ($(if ($rowIndex -eq 0) { 1 } else { 2 }))
}

$summaryCols = @(
    '<col min="1" max="1" width="28" customWidth="1"/>',
    '<col min="2" max="2" width="24" customWidth="1"/>'
) -join ''

$instructionsCols = @(
    '<col min="1" max="1" width="24" customWidth="1"/>',
    '<col min="2" max="2" width="120" customWidth="1"/>'
) -join ''

$resultsCols = @(
    '<col min="1" max="1" width="26" customWidth="1"/>',
    '<col min="2" max="2" width="24" customWidth="1"/>',
    '<col min="3" max="3" width="90" customWidth="1"/>',
    '<col min="4" max="4" width="20" customWidth="1"/>',
    '<col min="5" max="5" width="34" customWidth="1"/>',
    '<col min="6" max="6" width="20" customWidth="1"/>',
    '<col min="7" max="7" width="34" customWidth="1"/>',
    '<col min="8" max="8" width="12" customWidth="1"/>',
    '<col min="9" max="12" width="12" customWidth="1"/>',
    '<col min="13" max="13" width="12" customWidth="1"/>',
    '<col min="14" max="17" width="14" customWidth="1"/>',
    '<col min="18" max="18" width="70" customWidth="1"/>',
    '<col min="19" max="20" width="24" customWidth="1"/>',
    '<col min="21" max="21" width="20" customWidth="1"/>',
    '<col min="22" max="22" width="55" customWidth="1"/>'
) -join ''

$summarySheet = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>$summaryCols</cols>
  <sheetData>
    $($summaryRowsXml -join "`n    ")
  </sheetData>
</worksheet>
"@

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

$resultsSheet = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>$resultsCols</cols>
  <sheetData>
    $($resultsRowsXml -join "`n    ")
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
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
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
    <sheet name="Summary" sheetId="1" r:id="rId1"/>
    <sheet name="Instructions" sheetId="2" r:id="rId2"/>
    <sheet name="Results" sheetId="3" r:id="rId3"/>
  </sheets>
</workbook>
'@

$workbookRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
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

$stagingRoot = Join-Path $artifactsDir ("matching_benchmark_{0}_n{1}_build" -f $RunId, $SampleSize)
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
Write-Utf8NoBom -Path (Join-Path $stagingRoot 'xl\worksheets\sheet1.xml') -Content $summarySheet
Write-Utf8NoBom -Path (Join-Path $stagingRoot 'xl\worksheets\sheet2.xml') -Content $instructionsSheet
Write-Utf8NoBom -Path (Join-Path $stagingRoot 'xl\worksheets\sheet3.xml') -Content $resultsSheet

if (Test-Path $outputPath) {
    Remove-Item -Force $outputPath
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingRoot, $outputPath)
Remove-Item -Recurse -Force $stagingRoot

Write-Host $outputPath
