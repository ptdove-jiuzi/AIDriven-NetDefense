# Compare two fingerprint TSVs (relative path <tab> bytes <tab> sha256) -> JSON diff.
#
# Round-5 powercut seat. Same口径 as evidence/upgrade/r4/compare-fingerprint.ps1: a
# user-visible "数据没丢" claim is only worth something if it is a per-file sha256 diff
# with an explicit added/removed/changed/resized count, not a directory size comparison.
#
# NOTE (carried over from round 4): locals are named `*Map` on purpose — PowerShell
# parameter and local variable names are case-insensitive, so a local `$before` would
# silently be the same variable as the parameter `$Before`.
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Before,
  [Parameter(Mandatory = $true)][string]$After,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'

function Read-Fp([string]$path) {
  $map = [ordered]@{}
  if (-not (Test-Path -LiteralPath $path)) { return , $map }
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line.Split("`t")
    if ($parts.Count -lt 3) { continue }
    $map[$parts[0]] = [ordered]@{ bytes = [int64]$parts[1]; sha256 = $parts[2] }
  }
  return , $map
}

$beforePath = $Before
$afterPath = $After
$beforeMap = Read-Fp $beforePath
$afterMap = Read-Fp $afterPath
if ($beforeMap -isnot [System.Collections.IDictionary]) { throw "before fingerprint did not parse as a map: $($beforeMap.GetType().FullName)" }
if ($afterMap -isnot [System.Collections.IDictionary]) { throw "after fingerprint did not parse as a map: $($afterMap.GetType().FullName)" }

$added = @(); $removed = @(); $changed = @(); $resized = @()
foreach ($key in $afterMap.Keys) { if (-not $beforeMap.Contains($key)) { $added += $key } }
foreach ($key in $beforeMap.Keys) {
  if (-not $afterMap.Contains($key)) { $removed += $key; continue }
  if ($beforeMap[$key].sha256 -ne $afterMap[$key].sha256) { $changed += $key }
  if ($beforeMap[$key].bytes -ne $afterMap[$key].bytes) { $resized += $key }
}
$result = [ordered]@{
  beforeFile      = $beforePath
  afterFile       = $afterPath
  beforeCount     = $beforeMap.Count
  afterCount      = $afterMap.Count
  added           = @($added | Sort-Object)
  removed         = @($removed | Sort-Object)
  changed         = @($changed | Sort-Object)
  resized         = @($resized | Sort-Object)
  differenceCount = $added.Count + $removed.Count + $changed.Count + $resized.Count
}
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Output ("diff {0} vs {1} -> {2} difference(s) (before={3} after={4} added={5} removed={6} changed={7} resized={8})" -f `
    $beforePath, $afterPath, $result.differenceCount, $result.beforeCount, $result.afterCount, `
    $added.Count, $removed.Count, $changed.Count, $resized.Count)
