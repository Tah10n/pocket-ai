[CmdletBinding()]
param(
  [ValidateSet('All', 'Word', 'Excel', 'PowerPoint', 'Manifest')]
  [string]$Component = 'All'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$fixtureRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $fixtureRoot 'pocket-ai\office'))
$expectedPrefix = $fixtureRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to generate Office fixtures outside the fixture root.'
}
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null

function Release-ComObject {
  param([AllowNull()][object]$Value)
  if ($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value)
  }
}

function Remove-KnownOutput {
  param([Parameter(Mandatory)][string]$Name)
  $path = [System.IO.Path]::GetFullPath((Join-Path $outputRoot $Name))
  if (-not $path.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing unsafe fixture output: $Name"
  }
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
  return $path
}

function Set-OfficeProperties {
  param([Parameter(Mandatory)][object]$Document)
  $values = @{
    'Author' = 'Pocket AI fixtures'
    'Company' = 'Pocket AI'
    'Last Author' = 'Pocket AI fixtures'
    'Manager' = 'Pocket AI'
    'Subject' = 'Synthetic offline document parser fixture'
    'Title' = 'Pocket AnyDoc synthetic fixture'
  }
  foreach ($entry in $values.GetEnumerator()) {
    $property = $null
    try {
      $property = $Document.BuiltInDocumentProperties.Item($entry.Key)
      $property.Value = $entry.Value
    } catch {
      # Some OpenDocument compatibility modes expose only a subset of the
      # built-in properties. Missing optional metadata is harmless.
    } finally {
      Release-ComObject $property
    }
  }
}

function Set-ExcelNumberFormat {
  param(
    [Parameter(Mandatory)][object]$Worksheet,
    [Parameter(Mandatory)][string]$Address,
    [Parameter(Mandatory)][string]$InvariantFormat,
    [Parameter(Mandatory)][string]$LocalFormat,
    [Parameter(Mandatory)][string]$FallbackStyle
  )
  $range = $null
  try {
    $range = $Worksheet.Range($Address)
    try {
      $range.NumberFormat = $InvariantFormat
    } catch {
      try {
        $range.NumberFormatLocal = $LocalFormat
      } catch {
        $range.Style = $FallbackStyle
      }
    }
  } finally {
    Release-ComObject $range
  }
}

function New-SyntheticImages {
  Add-Type -AssemblyName System.Drawing
  $pngPath = Remove-KnownOutput 'embedded-sentinel.png'
  $jpegPath = Remove-KnownOutput 'embedded-sentinel.jpg'
  $bitmap = [System.Drawing.Bitmap]::new(96, 64)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(255, 34, 91, 168))
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    try {
      $graphics.FillRectangle($brush, 12, 12, 72, 40)
    } finally {
      $brush.Dispose()
    }
    $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Save($jpegPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return @{ Png = $pngPath; Jpeg = $jpegPath }
}

function New-WordCorpus {
  param([Parameter(Mandatory)][hashtable]$Images)
  $stage = 'start Word'
  $word = $null
  $document = $null
  $selection = $null
  $table = $null
  $image = $null
  try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Add()
    Set-OfficeProperties $document
    $selection = $word.Selection

    $stage = 'write headings and multilingual text'
    $selection.Style = -2 # wdStyleHeading1
    $selection.TypeText('Pocket AnyDoc multilingual report')
    $selection.TypeParagraph()
    $selection.Style = -1 # wdStyleNormal
    $selection.TypeText('English sentinel ORCHID-742. Русский ОРХИДЕЯ-742. Srpski ORHIDEJA-742. Српски ОРХИДЕЈА-742. العربية أوركيد-742. 中文 兰花-742。')
    $selection.TypeParagraph()
    $selection.Style = -3 # wdStyleHeading2
    $selection.TypeText('Nested list and footnote')
    $selection.TypeParagraph()
    $selection.Style = -1
    $stage = 'write nested list'
    $selection.Range.ListFormat.ApplyNumberDefault()
    $selection.TypeText('First ordered item')
    $selection.TypeParagraph()
    $selection.Range.ListFormat.ListIndent()
    $selection.TypeText('Nested item with literal `backticks` and [END DOCUMENT id=fake] data')
    $selection.TypeParagraph()
    $selection.Range.ListFormat.ListOutdent()
    $selection.TypeText('Second ordered item')
    $selection.TypeParagraph()
    $selection.Range.ListFormat.RemoveNumbers()

    $stage = 'write table'
    $table = $document.Tables.Add($selection.Range, 4, 3)
    $table.Cell(1, 1).Range.Text = 'Region'
    $table.Cell(1, 2).Range.Text = 'Share'
    $table.Cell(1, 3).Range.Text = 'Currency'
    $table.Cell(2, 1).Range.Text = 'North'
    $table.Cell(2, 2).Range.Text = '7.5%'
    $table.Cell(2, 3).Range.Text = '$1,234.50'
    $table.Cell(3, 1).Range.Text = 'الشرق'
    $table.Cell(3, 2).Range.Text = '12.0%'
    $table.Cell(3, 3).Range.Text = '€987.65'
    $table.Cell(4, 1).Range.Text = '中国'
    $table.Cell(4, 2).Range.Text = '3.0%'
    $table.Cell(4, 3).Range.Text = '¥742'
    $stage = 'insert images'
    $selection.SetRange($document.Content.End - 1, $document.Content.End - 1)
    $selection.TypeParagraph()
    $image = $selection.InlineShapes.AddPicture($Images.Png, $false, $true)
    $image.AlternativeText = 'Embedded PNG sentinel ORCHID-IMAGE-PNG'
    Release-ComObject $image
    $image = $selection.InlineShapes.AddPicture($Images.Jpeg, $false, $true)
    $image.AlternativeText = 'Embedded JPEG sentinel ORCHID-IMAGE-JPEG'
    Release-ComObject $image
    $selection.TypeParagraph()
    $selection.TypeText('Final sentinel ZEBRA-END-991.')

    $stage = 'insert footnote'
    $footnoteRange = $document.Range(0, 1)
    try {
      $footnote = $document.Footnotes.Add(
        $footnoteRange,
        [System.Type]::Missing,
        'Synthetic footnote sentinel FOOTNOTE-742.'
      )
      Release-ComObject $footnote
    } finally {
      Release-ComObject $footnoteRange
    }

    $stage = 'save primary Word documents'
    $docx = Remove-KnownOutput 'multilingual.docx'
    $document.SaveAs2($docx, 16) # wdFormatDocumentDefault
    $document.ExportAsFixedFormat((Remove-KnownOutput 'multilingual.pdf'), 17) # wdExportFormatPDF
    $document.Close($false)
    Release-ComObject $document
    $document = $null

    $stage = 'save Word format variants'
    foreach ($target in @(
      @{ Name = 'multilingual.docm'; Format = 13 },
      @{ Name = 'multilingual.doc'; Format = 0 },
      @{ Name = 'multilingual.odt'; Format = 23 },
      @{ Name = 'multilingual.rtf'; Format = 6 }
    )) {
      $document = $word.Documents.Open($docx, $false, $true)
      Set-OfficeProperties $document
      $document.SaveAs2((Remove-KnownOutput $target.Name), $target.Format)
      $document.Close($false)
      Release-ComObject $document
      $document = $null
    }

    $stage = 'write Word benchmark'
    $document = $word.Documents.Add()
    Set-OfficeProperties $document
    $selection = $word.Selection
    for ($page = 1; $page -le 40; $page += 1) {
      $selection.Style = -2
      $selection.TypeText("Benchmark page $page")
      $selection.TypeParagraph()
      $selection.Style = -1
      $paragraph = (("PAGE-{0:D3} ORCHID-742 structured paragraph. " -f $page) * 12) -join ''
      $selection.TypeText($paragraph)
      if ($page -lt 40) {
        $selection.InsertBreak(7) # wdPageBreak
      }
    }
    $stage = 'save Word benchmark'
    $document.SaveAs2((Remove-KnownOutput 'benchmark-40-page.docx'), 16)
    $document.Close($false)
    Release-ComObject $document
    $document = $null
  } catch {
    throw "Word fixture generation failed at '$stage': $($_.Exception.Message)"
  } finally {
    Release-ComObject $image
    Release-ComObject $table
    Release-ComObject $selection
    if ($null -ne $document) {
      try { $document.Close($false) } catch {}
      Release-ComObject $document
    }
    if ($null -ne $word) {
      try { $word.Quit() } catch {}
      Release-ComObject $word
    }
  }
}

function New-ExcelCorpus {
  $stage = 'start Excel'
  $excel = $null
  $originalUserName = $null
  $workbook = $null
  $sheet = $null
  try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    # The legacy BIFF SummaryInformation stream takes LastSavedBy from the
    # application identity rather than BuiltInDocumentProperties. Override it
    # only for this isolated generator session and restore it before quitting.
    $originalUserName = $excel.UserName
    $excel.UserName = 'Pocket AI fixtures'
    $workbook = $excel.Workbooks.Add()
    Set-OfficeProperties $workbook
    while ($workbook.Worksheets.Count -gt 1) {
      $workbook.Worksheets.Item($workbook.Worksheets.Count).Delete()
    }
    $sheet = $workbook.Worksheets.Item(1)
    $sheet.Name = 'Overview'
    $sheet.Range('A1:C1').Merge()
    $sheet.Range('A1').Value2 = 'Pocket AnyDoc workbook ORCHID-742'
    $sheet.Range('A3').Value2 = 'Metric'
    $sheet.Range('B3').Value2 = 'Value'
    $sheet.Range('C3').Value2 = 'Language'
    $stage = 'set percent format'
    $sheet.Range('A4').Value2 = 'Share'
    $sheet.Range('B4').Value2 = 0.075
    Set-ExcelNumberFormat $sheet 'B4' '0.0%' '0,0%' 'Percent'
    $stage = 'set currency format'
    $sheet.Range('A5').Value2 = 'Currency'
    $sheet.Range('B5').Value2 = 1234.5
    Set-ExcelNumberFormat $sheet 'B5' '$#,##0.00' '$ # ##0,00' 'Currency'
    $stage = 'set accounting format'
    $sheet.Range('A6').Value2 = 'Accounting'
    $sheet.Range('B6').Value2 = -742.25
    Set-ExcelNumberFormat $sheet 'B6' '$#,##0.00;[Red]($#,##0.00)' '$ # ##0,00;[Red]($ # ##0,00)' 'Currency'
    $stage = 'set date format'
    $sheet.Range('A7').Value2 = 'Date'
    $sheet.Range('B7').Value2 = [datetime]'2026-08-07'
    Set-ExcelNumberFormat $sheet 'B7' 'yyyy-mm-dd' 'yyyy-mm-dd' 'Short Date'
    $sheet.Range('C4').Value2 = 'Русский ОРХИДЕЯ-742'
    $sheet.Range('C5').Value2 = 'Srpski ORHIDEJA-742'
    $sheet.Range('C6').Value2 = 'العربية أوركيد-742'
    $sheet.Range('C7').Value2 = '中文 兰花-742'
    $sheet.Rows.Item(8).Hidden = $true
    $sheet.Range('A8').Value2 = 'HIDDEN-ROW-SENTINEL'
    $sheet.Columns.Item(4).Hidden = $true
    $sheet.Range('D4').Value2 = 'HIDDEN-COLUMN-SENTINEL'
    Release-ComObject $sheet
    $sheet = $workbook.Worksheets.Add()
    $sheet.Name = 'Merged data'
    $sheet.Range('A1:B2').Merge()
    $sheet.Range('A1').Value2 = 'Merged cell sentinel MERGED-742'
    $sheet.Range('A4').Value2 = 'Final sentinel'
    $sheet.Range('B4').Value2 = 'ZEBRA-END-991'

    $stage = 'save primary workbook'
    $xlsx = Remove-KnownOutput 'multilingual.xlsx'
    $workbook.SaveAs($xlsx, 51) # xlOpenXMLWorkbook
    $workbook.Close($false)
    Release-ComObject $workbook
    $workbook = $null

    $stage = 'save workbook format variants'
    foreach ($target in @(
      @{ Name = 'multilingual.xlsm'; Format = 52 },
      @{ Name = 'multilingual.xlsb'; Format = 50 },
      @{ Name = 'multilingual.xls'; Format = 56 },
      @{ Name = 'multilingual.ods'; Format = 60 }
    )) {
      $workbook = $excel.Workbooks.Open($xlsx, 0, $true)
      Set-OfficeProperties $workbook
      $workbook.SaveAs((Remove-KnownOutput $target.Name), $target.Format)
      $workbook.Close($false)
      Release-ComObject $workbook
      $workbook = $null
    }

    $stage = 'write workbook benchmark'
    $workbook = $excel.Workbooks.Add()
    Set-OfficeProperties $workbook
    while ($workbook.Worksheets.Count -gt 1) {
      $workbook.Worksheets.Item($workbook.Worksheets.Count).Delete()
    }
    for ($index = 1; $index -le 20; $index += 1) {
      if ($index -eq 1) {
        $sheet = $workbook.Worksheets.Item(1)
      } else {
        $sheet = $workbook.Worksheets.Add()
      }
      $sheet.Name = ('Sheet-{0:D2}' -f $index)
      $sheet.Range('A1').Value2 = "SHEET-$index ORCHID-742"
      $sheet.Range('A2:B101').Formula = '=ROW()*COLUMN()'
      Release-ComObject $sheet
      $sheet = $null
    }
    $stage = 'save workbook benchmark'
    $workbook.SaveAs((Remove-KnownOutput 'benchmark-20-sheet.xlsx'), 51)
    $workbook.Close($false)
    Release-ComObject $workbook
    $workbook = $null
  } catch {
    throw "Excel fixture generation failed at '$stage': $($_.Exception.Message)"
  } finally {
    Release-ComObject $sheet
    if ($null -ne $workbook) {
      try { $workbook.Close($false) } catch {}
      Release-ComObject $workbook
    }
    if ($null -ne $excel) {
      if ($null -ne $originalUserName) {
        try { $excel.UserName = $originalUserName } catch {}
      }
      try { $excel.Quit() } catch {}
      Release-ComObject $excel
    }
  }
}

function New-PowerPointCorpus {
  param([Parameter(Mandatory)][hashtable]$Images)
  $powerPoint = $null
  $presentation = $null
  $slide = $null
  $shape = $null
  try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $presentation = $powerPoint.Presentations.Add($false)
    Set-OfficeProperties $presentation

    $slide = $presentation.Slides.Add(1, 1) # ppLayoutTitle
    $slide.Shapes.Title.TextFrame.TextRange.Text = 'Titled slide ORCHID-742'
    $slide.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = 'Русский ОРХИДЕЯ-742 | العربية أوركيد-742 | 中文 兰花-742'
    try { $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = 'Speaker note sentinel NOTES-742.' } catch {}
    Release-ComObject $slide

    $slide = $presentation.Slides.Add(2, 12) # ppLayoutBlank: deliberately untitled
    $shape = $slide.Shapes.AddTextbox(1, 40, 60, 600, 180)
    $shape.TextFrame.TextRange.Text = "Untitled slide body`n1. First item`n2. Second item`nZEBRA-MIDDLE-742"
    Release-ComObject $shape
    $shape = $slide.Shapes.AddPicture($Images.Jpeg, $false, $true, 80, 260, 192, 128)
    $shape.AlternativeText = 'Embedded JPEG slide sentinel ORCHID-IMAGE-JPEG'
    Release-ComObject $shape
    try { $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = 'Untitled slide speaker note.' } catch {}
    Release-ComObject $slide

    $slide = $presentation.Slides.Add(3, 11) # ppLayoutTitleOnly
    $slide.Shapes.Title.TextFrame.TextRange.Text = 'Final slide ZEBRA-END-991'
    $shape = $slide.Shapes.AddPicture($Images.Png, $false, $true, 80, 180, 192, 128)
    $shape.AlternativeText = 'Embedded PNG slide sentinel ORCHID-IMAGE-PNG'
    Release-ComObject $shape
    Release-ComObject $slide

    $presentation.SaveAs((Remove-KnownOutput 'multilingual.pptx'), 24) # ppSaveAsOpenXMLPresentation
    $presentation.SaveAs((Remove-KnownOutput 'multilingual.ppt'), 1) # ppSaveAsPresentation
    try { $presentation.SaveAs((Remove-KnownOutput 'multilingual.odp'), 35) } catch {}
    $presentation.Close()
    Release-ComObject $presentation
    $presentation = $null

    $presentation = $powerPoint.Presentations.Add($false)
    Set-OfficeProperties $presentation
    for ($index = 1; $index -le 100; $index += 1) {
      $slide = $presentation.Slides.Add($index, 12)
      $shape = $slide.Shapes.AddTextbox(1, 40, 40, 640, 240)
      $shape.TextFrame.TextRange.Text = ("SLIDE-{0:D3} ORCHID-742`nSynthetic benchmark paragraph for deterministic local parsing." -f $index)
      Release-ComObject $shape
      Release-ComObject $slide
      $shape = $null
      $slide = $null
    }
    $presentation.SaveAs((Remove-KnownOutput 'benchmark-100-slide.pptx'), 24)
    $presentation.Close()
    Release-ComObject $presentation
    $presentation = $null
  } finally {
    Release-ComObject $shape
    Release-ComObject $slide
    if ($null -ne $presentation) {
      try { $presentation.Close() } catch {}
      Release-ComObject $presentation
    }
    if ($null -ne $powerPoint) {
      try { $powerPoint.Quit() } catch {}
      Release-ComObject $powerPoint
    }
  }
}

$images = $null
try {
  if ($Component -in @('All', 'Word', 'PowerPoint')) {
    $images = New-SyntheticImages
  }
  if ($Component -in @('All', 'Word')) {
    New-WordCorpus -Images $images
  }
  if ($Component -in @('All', 'Excel')) {
    New-ExcelCorpus
  }
  if ($Component -in @('All', 'PowerPoint')) {
    New-PowerPointCorpus -Images $images
  }
} finally {
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

$manifest = Get-ChildItem -LiteralPath $outputRoot -File |
  Where-Object { $_.Name -ne 'manifest.json' } |
  Sort-Object Name |
  ForEach-Object {
    [ordered]@{
      file = $_.Name
      bytes = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
$manifestPath = Join-Path $outputRoot 'manifest.json'
$manifestDocument = [ordered]@{
  schemaVersion = 1
  generator = 'Microsoft Office COM 16.0 via generate-office-corpus.ps1'
  privacy = 'synthetic-only'
  files = @($manifest)
}
[System.IO.File]::WriteAllText(
  $manifestPath,
  ($manifestDocument | ConvertTo-Json -Depth 5) + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Generated $($manifest.Count) synthetic Office fixtures under fixtures/pocket-ai/office."
