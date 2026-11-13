# r2-facts.ps1 — the acceptance facts for one tree, as expectations with expected vs actual.
#
# Used for the four booleans of the rc.5 -> rc.6 overwrite upgrade (README §4 T1.1) and for
# the per-timepoint four checks (README §4 T1.2).  Everything here is measured, not inferred:
# per-file sha256 on both data channels, the install record's own fields, the uninstall keys
# as Windows reports them, and the .lnk files on disk.
#
#   pwsh -NoProfile -File r2-facts.ps1 -Target <tree> -OutDir <dir> -Label b -BaselineDir <seed dir> [-RunDir <run dir>]
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$BaselineDir = '',
  [string]$RunDir = '',
  [string]$ExpectVersion = '0.0.1-rc.6',
  [string]$ExpectUpgradedFrom = '0.0.1-rc.5'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'r2-lib.ps1')

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$targetFull = [System.IO.Path]::GetFullPath($Target.TrimEnd('\'))
$facts = [ordered]@{
  label = $Label
  at = (Get-Date).ToString('o')
  target = $targetFull
  baselineDir = $BaselineDir
  tree = Get-R2TreeFacts $targetFull
  markers = Get-R2Markers $targetFull
  shortcuts = Get-R2ShortcutSummary
  expectations = @()
  data = [ordered]@{}
  host = $null
  logs = [ordered]@{ files = @(); lines = @() }
}

# ---------------- data channel diffs (boolean a) ------------------------------
$dataTarget = Join-Path $targetFull 'data'
$targetAfter = Get-R2DataFingerprint -Root $dataTarget -OutTsv (Join-Path $OutDir 'data-target-after.tsv') -OutJson (Join-Path $OutDir 'data-target-after.json')
$laAfter = Get-R2DataFingerprint -Root $env:R2LaData -OutTsv (Join-Path $OutDir 'data-la-after.tsv') -OutJson (Join-Path $OutDir 'data-la-after.json')
$facts.data.targetAfter = $targetAfter
$facts.data.laAfter = $laAfter
$targetDiff = $null
$laDiff = $null
if ($BaselineDir) {
  $tBefore = Join-Path $BaselineDir 'data-target-before.tsv'
  $lBefore = Join-Path $BaselineDir 'data-la-before.tsv'
  if (Test-Path -LiteralPath $tBefore) {
    $targetDiff = Get-R2FingerprintDiff -Before $tBefore -After (Join-Path $OutDir 'data-target-after.tsv') -Out (Join-Path $OutDir 'data-target-diff.json')
  }
  if (Test-Path -LiteralPath $lBefore) {
    $laDiff = Get-R2FingerprintDiff -Before $lBefore -After (Join-Path $OutDir 'data-la-after.tsv') -Out (Join-Path $OutDir 'data-la-diff.json')
  }
}
$facts.data.targetDiff = $targetDiff
$facts.data.laDiff = $laDiff

$hostSnap = Join-Path $OutDir 'host.json'
[void](Get-R2HostSnapshot -Out $hostSnap -Label $Label)
$facts.host = Get-R2HostSummary $hostSnap $targetFull

# installer logs of the run that produced this state (for the "期望 vs 实际" of the record)
if ($RunDir) {
  foreach ($log in @(Get-ChildItem -LiteralPath $RunDir -Filter 'installer-*.log' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
    $lines = @(Get-Content -LiteralPath $log.FullName -Encoding utf8 -ErrorAction SilentlyContinue)
    $facts.logs.files += [ordered]@{ path = $log.FullName; lines = $lines.Count }
    $facts.logs.lines += @($lines | Where-Object { $_ -match '升级|install|target:|WARN|ERROR|卸载' })
  }
}

# ---------------- expectations -------------------------------------------------
$record = $facts.tree.installRecord
$exp = @()

$exp += [ordered]@{
  id = 'a-target-data-unchanged'
  expected = 'per-file sha256 of <target>\\data before and after the rc.6 overwrite: 0 differences'
  actual = if ($targetDiff) { "differenceCount=$($targetDiff.diff.differenceCount) before=$($targetDiff.diff.beforeCount) after=$($targetDiff.diff.afterCount) added=$(@($targetDiff.diff.added).Count) removed=$(@($targetDiff.diff.removed).Count) changed=$(@($targetDiff.diff.changed).Count)" } else { 'NO BASELINE' }
  pass = [bool]($targetDiff -and ($targetDiff.diff.differenceCount -eq 0) -and ($targetDiff.diff.beforeCount -gt 0))
  evidence = if ($targetDiff) { $targetDiff.diff } else { $null }
}
$exp += [ordered]@{
  id = 'a-localappdata-data-unchanged'
  expected = 'per-file sha256 of %LOCALAPPDATA%\\AIDriven NetDefense\\data before and after: 0 differences'
  actual = if ($laDiff) { "differenceCount=$($laDiff.diff.differenceCount) before=$($laDiff.diff.beforeCount) after=$($laDiff.diff.afterCount) added=$(@($laDiff.diff.added).Count) removed=$(@($laDiff.diff.removed).Count) changed=$(@($laDiff.diff.changed).Count)" } else { 'NO BASELINE' }
  pass = [bool]($laDiff -and ($laDiff.diff.differenceCount -eq 0) -and ($laDiff.diff.beforeCount -gt 0))
  evidence = if ($laDiff) { $laDiff.diff } else { $null }
}
$exp += [ordered]@{
  id = 'b-upgradedFrom'
  expected = "install\\install.json.version == $ExpectVersion and upgradedFrom == $ExpectUpgradedFrom"
  actual = "version=$($record.version) upgradedFrom=$($record.upgradedFrom) installPath=$($record.installPath) autostart=$($record.autostart) ownership=$(if ($record.ownership) { $record.ownership.scheme } else { $null })"
  pass = [bool]($record -and ($record.version -eq $ExpectVersion) -and ($record.upgradedFrom -eq $ExpectUpgradedFrom))
  evidence = [ordered]@{ installJsonSha256 = $facts.tree.installJsonSha256; record = $record }
}
$exp += [ordered]@{
  id = 'c-uninstall-entry-exactly-one'
  expected = 'exactly 1 AIDriven uninstall entry across HKCU/HKCU-WOW/HKLM/HKLM-WOW and it points at this tree'
  actual = "count=$($facts.host.uninstallCount) entries=$($facts.host.uninstallEntries | ConvertTo-Json -Compress -Depth 5)"
  pass = [bool](($facts.host.uninstallCount -eq 1) -and (@($facts.host.uninstallEntries)[0].pointsAtTarget))
  evidence = $facts.host.uninstallEntries
}
$exp += [ordered]@{
  id = 'd-shortcuts-not-duplicated'
  expected = 'exactly 1 Start Menu .lnk and exactly 1 Desktop .lnk for the product (no duplicates)'
  actual = "startMenuLnk=$($facts.shortcuts.startMenuLnkCount) desktopLnk=$($facts.shortcuts.desktopLnkCount) rows=$($facts.shortcuts.rows | ConvertTo-Json -Compress -Depth 4)"
  pass = [bool](($facts.shortcuts.startMenuLnkCount -eq 1) -and ($facts.shortcuts.desktopLnkCount -eq 1) -and $facts.shortcuts.noDuplicates)
  evidence = $facts.shortcuts
}
# informational (not one of the four user-named booleans, but part of the state)
$exp += [ordered]@{
  id = 'x-run-value'
  expected = '1 HKCU Run value pointing into this tree (the four-boolean round does NOT pass /NOREG)'
  actual = "runValueCount=$($facts.host.runValueCount) values=$($facts.host.runValues | ConvertTo-Json -Compress -Depth 4)"
  pass = [bool]($facts.host.runValueCount -eq 1)
  evidence = $facts.host.runValues
}
$exp += [ordered]@{
  id = 'x-markers-pass-with-rc6-app'
  expected = 'shipped rc.6/current-source gates: installMarker non-null, upgradeMarker non-null, ownershipVerifyOk=true'
  actual = "installMarker=$($facts.markers.installMarker) upgradeMarker=$($facts.markers.upgradeMarker) ownershipVerifyOk=$($facts.markers.ownershipVerifyOk) ownershipVerifyReason=$($facts.markers.ownershipVerifyReason)"
  pass = [bool]($facts.markers.installMarker -and $facts.markers.upgradeMarker -and $facts.markers.ownershipVerifyOk)
  evidence = $facts.markers
}

$facts.expectations = $exp
$facts.summary = [ordered]@{
  total = $exp.Count
  pass = @($exp | Where-Object { $_.pass }).Count
  fail = @($exp | Where-Object { -not $_.pass }).Count
  fourBooleansPass = @($exp | Where-Object { $_.id -match '^[abcd]-' -and -not $_.pass }).Count -eq 0
}
Save-R2Json $facts (Join-Path $OutDir 'facts.json')
Write-Output ("facts {0}: fourBooleansPass={1} pass={2}/{3}" -f $Label, $facts.summary.fourBooleansPass, $facts.summary.pass, $facts.summary.total)
foreach ($e in $exp) { Write-Output ("  [{0}] {1}: {2}" -f $(if ($e.pass) { 'PASS' } else { 'FAIL' }), $e.id, $e.actual) }
Write-Output ("-> {0}" -f (Join-Path $OutDir 'facts.json'))
