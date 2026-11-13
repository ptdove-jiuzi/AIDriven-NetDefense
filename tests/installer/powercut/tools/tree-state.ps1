# Summarise an installed tree in one JSON object: the handful of files that decide
# "was this tree really rewritten / really left alone", plus a cheap whole-tree digest.
#
# Round-5 powercut seat (POST-SHIP-PATH / powercut-r5).
#
# Why the key files: the two generations of this product differ in *some* payload files,
# but the guards that decide "may I install/uninstall here" read exactly these:
#   <tree>\install\install.json           the install record (version/installPath/ownership)
#   <tree>\manifests\files.sha256         the payload hash manifest (sampled by _manifest_has_rows)
#   <tree>\AIDrivenNetDefense.exe         the entry point (first data row of that manifest)
#   <tree>\bundle.json                    the payload description (_bundle_is_ours)
#
# `inventoryDigest` is sha256 over the sorted "<relative path>\t<bytes>" lines: it proves a
# reinstall attempt wrote *nothing* without paying for 50k file hashes, and the key-file
# sha256s above then prove the bytes themselves did not move.
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Label = ''
)
$ErrorActionPreference = 'Stop'

function Get-FileSha([string]$path) {
  if (Test-Path -LiteralPath $path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() }
  return $null
}

$exists = Test-Path -LiteralPath $Root
$state = [ordered]@{
  label              = $Label
  root               = $Root
  capturedAt         = (Get-Date).ToString('o')
  exists             = $exists
  fileCount          = $null
  inventoryDigest    = $null
  entries            = @()
  exeSha256          = $null
  exeBytes           = $null
  manifestSha256     = $null
  manifestBytes      = $null
  installJsonSha256  = $null
  installJsonVersion = $null
  installJsonUpgradedFrom = $null
  installJsonInstallPath  = $null
  bundleJsonSha256   = $null
  bundleKind         = $null
}

if ($exists) {
  $full = (Resolve-Path -LiteralPath $Root).Path
  $state.entries = @(Get-ChildItem -LiteralPath $full -Force | Sort-Object Name | ForEach-Object { $_.Name })
  $lines = New-Object System.Collections.Generic.List[string]
  $count = 0
  Get-ChildItem -LiteralPath $full -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($full.Length + 1)
    $lines.Add("$rel`t$($_.Length)")
    $count++
  }
  $state.fileCount = $count
  $lines.Sort([System.StringComparer]::Ordinal)
  $joined = [string]::Join("`n", $lines)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $state.inventoryDigest = ([System.BitConverter]::ToString(
        $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined)))).Replace('-', '').ToLower()
  } finally { $sha.Dispose() }

  $state.exeSha256 = Get-FileSha (Join-Path $full 'AIDrivenNetDefense.exe')
  if (Test-Path -LiteralPath (Join-Path $full 'AIDrivenNetDefense.exe')) { $state.exeBytes = (Get-Item -LiteralPath (Join-Path $full 'AIDrivenNetDefense.exe')).Length }
  $manifest = Join-Path $full 'manifests\files.sha256'
  $state.manifestSha256 = Get-FileSha $manifest
  if (Test-Path -LiteralPath $manifest) { $state.manifestBytes = (Get-Item -LiteralPath $manifest).Length }
  $record = Join-Path $full 'install\install.json'
  $state.installJsonSha256 = Get-FileSha $record
  if (Test-Path -LiteralPath $record) {
    try {
      $json = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
      $state.installJsonVersion = $json.version
      $state.installJsonUpgradedFrom = $json.upgradedFrom
      $state.installJsonInstallPath = $json.installPath
    } catch {
      $state.installJsonVersion = 'UNPARSEABLE'
    }
  }
  $bundle = Join-Path $full 'bundle.json'
  $state.bundleJsonSha256 = Get-FileSha $bundle
  if (Test-Path -LiteralPath $bundle) {
    try {
      $b = Get-Content -LiteralPath $bundle -Raw -Encoding UTF8 | ConvertFrom-Json
      $state.bundleKind = $b.kind
    } catch { $state.bundleKind = 'UNPARSEABLE' }
  }
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Output ("tree-state {0} -> {1}  exists={2} files={3} version={4} exe={5} manifest={6}" -f `
    $Root, $Out, $state.exists, $state.fileCount, $state.installJsonVersion, $state.exeSha256, $state.manifestSha256)
