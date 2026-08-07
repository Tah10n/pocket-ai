[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.IO.Compression
$fixtureRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $fixtureRoot 'pocket-ai\archives'))
$expectedPrefix = $fixtureRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to generate archive fixtures outside the fixture root.'
}
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null

function Add-ZipTextEntry {
  param(
    [Parameter(Mandatory)][System.IO.Compression.ZipArchive]$Archive,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Text,
    [System.IO.Compression.CompressionLevel]$Compression = [System.IO.Compression.CompressionLevel]::Optimal
  )
  $entry = $Archive.CreateEntry($Name, $Compression)
  $entry.LastWriteTime = [datetimeoffset]'2000-01-01T00:00:00Z'
  $stream = $entry.Open()
  $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
  try {
    $writer.Write($Text)
  } finally {
    $writer.Dispose()
  }
}

$output = [System.IO.Path]::GetFullPath((Join-Path $outputRoot 'epub-repeated-itemref-64.epub'))
if (-not $output.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing unsafe EPUB output path.'
}
if (Test-Path -LiteralPath $output) {
  Remove-Item -LiteralPath $output -Force
}

$stream = [System.IO.File]::Open($output, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite)
$archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
try {
  Add-ZipTextEntry $archive 'mimetype' 'application/epub+zip' ([System.IO.Compression.CompressionLevel]::NoCompression)
  Add-ZipTextEntry $archive 'META-INF/container.xml' @'
<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
'@
  $spine = ((1..64) | ForEach-Object { '<itemref idref="chapter"/>' }) -join ''
  Add-ZipTextEntry $archive 'OEBPS/content.opf' @"
<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">pocket-anydoc-issue-43</dc:identifier>
    <dc:title>Synthetic repeated itemref regression</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine>$spine</spine>
</package>
"@
  Add-ZipTextEntry $archive 'OEBPS/chapter.xhtml' @'
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ORCHID-742</title></head>
<body><h1>Repeated chapter</h1><p>Issue 43 sentinel ORCHID-742.</p></body></html>
'@
} finally {
  $archive.Dispose()
  $stream.Dispose()
}

$manifest = [ordered]@{
  schemaVersion = 1
  files = @([ordered]@{
    file = [System.IO.Path]::GetFileName($output)
    bytes = (Get-Item -LiteralPath $output).Length
    sha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    expected = 'resource_limit:max_epub_repeated_itemrefs'
  })
}
[System.IO.File]::WriteAllText(
  (Join-Path $outputRoot 'manifest.json'),
  ($manifest | ConvertTo-Json -Depth 4) + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host 'Generated deterministic EPUB issue #43 regression fixture.'
