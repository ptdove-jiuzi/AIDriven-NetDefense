# Compare two fingerprint TSVs (relative path <tab> bytes <tab> sha256) -> JSON diff.
# Author: PT-dove
# NOTE: earlier version assigned the result to `$before`, which PowerShell treats as the same
# variable as the parameter `$Before` (variable names are case-insensitive); the report then
# labelled the input file with the dictionary's type name.  Locals are renamed `*Map` here.
param(
  [Parameter(Mandatory=$true)][string]$Before,
  [Parameter(Mandatory=$true)][string]$After,
  [Parameter(Mandatory=$true)][string]$Out
)
$ErrorActionPreference = 'Stop'

function Read-Fp([string]$path) {
  $map = [ordered]@{}
  if (-not (Test-Path -LiteralPath $path)) { return ,$map }
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line.Split("`t")
    if ($parts.Count -lt 3) { continue }
    $map[$parts[0]] = [ordered]@{ bytes = [int64]$parts[1]; sha256 = $parts[2] }
  }
  return ,$map
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
  beforeFile = $beforePath
  afterFile = $afterPath
  beforeCount = $beforeMap.Count
  afterCount = $afterMap.Count
  added = @($added | Sort-Object)
  removed = @($removed | Sort-Object)
  changed = @($changed | Sort-Object)
  resized = @($resized | Sort-Object)
  differenceCount = $added.Count + $removed.Count + $changed.Count + $resized.Count
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Output "diff $beforePath vs $afterPath -> $($result.differenceCount) difference(s) (before=$($result.beforeCount) after=$($result.afterCount) added=$($added.Count) removed=$($removed.Count) changed=$($changed.Count) resized=$($resized.Count))"
