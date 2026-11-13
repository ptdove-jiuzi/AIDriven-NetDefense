# data-fingerprint.ps1 — byte-exact fingerprint of a data tree.
#
# Why per-file SHA-256 and not "the DB opened fine": the acceptance criterion of this
# experiment is "the user's data did not change", and the only way to say that without
# trusting the product is to hash every file before and after. Sorted by relative path so
# two runs can be compared with a plain text diff.
#
# Output: TSV (relative_path <TAB> bytes <TAB> sha256) plus a single roll-up line, and
# optionally a JSON summary with the aggregate digest.
#
#   pwsh -NoProfile -File data-fingerprint.ps1 -Root <data dir> -OutTsv <file.tsv> [-OutJson <file.json>]
#
# Author: PT-dove
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$OutTsv,
    [string]$OutJson = ''
)

$ErrorActionPreference = 'Stop'

function Get-RelativePath {
    param([string]$Base, [string]$Full)
    $baseTrim = $Base.TrimEnd('\')
    if ($Full.StartsWith($baseTrim, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Full.Substring($baseTrim.Length).TrimStart('\')
    }
    return $Full
}

$rows = New-Object System.Collections.Generic.List[string]
$totalBytes = [long]0
$fileCount = 0
$rootExists = Test-Path -LiteralPath $Root -PathType Container

if ($rootExists) {
    $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue |
        Sort-Object -Property FullName)
    foreach ($file in $files) {
        $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $relative = Get-RelativePath -Base $Root -Full $file.FullName
        $rows.Add(("{0}`t{1}`t{2}" -f $relative, $file.Length, $digest))
        $totalBytes += $file.Length
        $fileCount += 1
    }
}

$dir = Split-Path -Parent $OutTsv
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
Set-Content -LiteralPath $OutTsv -Value $rows -Encoding utf8

# Aggregate over the *file list only* (not the timestamps): this is the single value two
# runs must agree on. A hash of the TSV would also change if the file order changed.
$aggregate = [System.Security.Cryptography.SHA256]::Create()
try {
    $builder = New-Object System.Text.StringBuilder
    foreach ($row in $rows) { [void]$builder.Append($row).Append("`n") }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $aggregateDigest = -join ($aggregate.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
} finally {
    $aggregate.Dispose()
}

$summary = [ordered]@{
    root           = (Resolve-Path -LiteralPath $Root -ErrorAction SilentlyContinue).Path
    rootExists     = $rootExists
    fileCount      = $fileCount
    totalBytes     = $totalBytes
    aggregateSha256 = $aggregateDigest
    tsv            = (Resolve-Path -LiteralPath $OutTsv).Path
    capturedAtUtc  = (Get-Date).ToUniversalTime().ToString('o')
}
if ($OutJson) {
    $summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutJson -Encoding utf8
}
Write-Output ("files={0} bytes={1} aggregate={2}" -f $fileCount, $totalBytes, $aggregateDigest)
