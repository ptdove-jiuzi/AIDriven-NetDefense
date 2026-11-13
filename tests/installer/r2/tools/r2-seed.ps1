# r2-seed.ps1 — after the real rc.5 install: seed BOTH data channels with the product's own
# event-store, and take the per-file sha256 baseline the upgrade must not disturb.
#
# Why both channels: `<target>\data` is the portable/adopt root and
# `%LOCALAPPDATA%\AIDriven NetDefense\data` is the desktop shell's real user data root.
# "data not lost" is measured on both, per file, not by "the DB opened".
#
# Pre-existing %LOCALAPPDATA% content (from earlier campaign rounds) is copied aside first,
# and restored after this round's evidence runs (recorded, not silently kept).
#
#   pwsh -NoProfile -File r2-seed.ps1 -Target <tree> -OutDir <dir> [-Events 60]
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Events = 60,
  [switch]$BackupLa
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'r2-lib.ps1')

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$targetFull = [System.IO.Path]::GetFullPath($Target.TrimEnd('\'))
$targetData = Join-Path $targetFull 'data'
$laData = $env:R2LaData
$summary = [ordered]@{
  label = 'seed'
  at = (Get-Date).ToString('o')
  target = $targetFull
  events = $Events
  steps = @()
}

# 1. target channel: a fresh install must not have one yet
$pre = @(Get-ChildItem -LiteralPath $targetData -Recurse -File -Force -ErrorAction SilentlyContinue)
$summary.steps += [ordered]@{ step = 'target-data-preexisting'; files = $pre.Count; note = 'a fresh install should have none' }
New-Item -ItemType Directory -Path $targetData -Force | Out-Null
$seedScript = Join-Path $PSScriptRoot 'seed-data.mjs'
$seedTarget = & $env:R2Node $seedScript --data-dir $targetData --events $Events 2>&1
Set-Content -LiteralPath (Join-Path $OutDir 'seed-target-data.json') -Value ($seedTarget -join "`n") -Encoding utf8
$summary.steps += [ordered]@{ step = 'seed-target-data'; output = (($seedTarget -join "`n") | ConvertFrom-Json) }

# 2. %LOCALAPPDATA% channel: copy anything pre-existing aside, then seed
if ($BackupLa) {
  $backup = Join-Path $OutDir 'la-data-preexisting'
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  if (Test-Path -LiteralPath $laData) {
    $robo = Start-Process -FilePath 'robocopy.exe' -ArgumentList @($laData, $backup, '/MIR', '/COPY:DAT', '/DCOPY:T', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', '/NP') -Wait -PassThru -NoNewWindow
    $summary.steps += [ordered]@{ step = 'backup-preexisting-localappdata'; robocopyExit = $robo.ExitCode; stat = (Get-R2DirStat $backup) }
  } else {
    New-Item -ItemType Directory -Path $laData -Force | Out-Null
    $summary.steps += [ordered]@{ step = 'backup-preexisting-localappdata'; existed = $false }
  }
} else {
  New-Item -ItemType Directory -Path $laData -Force | Out-Null
}
$seedLa = & $env:R2Node $seedScript --data-dir $laData --events $Events 2>&1
Set-Content -LiteralPath (Join-Path $OutDir 'seed-la-data.json') -Value ($seedLa -join "`n") -Encoding utf8
$summary.steps += [ordered]@{ step = 'seed-la-data'; output = (($seedLa -join "`n") | ConvertFrom-Json) }

# 3. per-file sha256 baselines for both channels (what the upgrade must leave untouched)
$summary.targetDataBefore = Get-R2DataFingerprint -Root $targetData -OutTsv (Join-Path $OutDir 'data-target-before.tsv') -OutJson (Join-Path $OutDir 'data-target-before.json')
$summary.laDataBefore = Get-R2DataFingerprint -Root $laData -OutTsv (Join-Path $OutDir 'data-la-before.tsv') -OutJson (Join-Path $OutDir 'data-la-before.json')

# 4. host state after the install, before the upgrade
$snap = Join-Path $OutDir 'host-after-seed.json'
[void](Get-R2HostSnapshot -Out $snap -Label 'after-seed')
$summary.hostSummary = Get-R2HostSummary $snap $targetFull
$summary.tree = Get-R2TreeFacts $targetFull
$summary.markers = Get-R2Markers $targetFull
$summary.shortcuts = Get-R2ShortcutSummary

Save-R2Json $summary (Join-Path $OutDir 'seed.json')
Write-Output ("seed ok: targetDataFiles={0} laDataFiles={1} uninstallKeys={2} run={3} startMenuLnk={4} desktopLnk={5}" -f `
    $summary.targetDataBefore.summary.fileCount, $summary.laDataBefore.summary.fileCount, $summary.hostSummary.uninstallCount, `
    $summary.hostSummary.runValueCount, $summary.shortcuts.startMenuLnkCount, $summary.shortcuts.desktopLnkCount)
Write-Output ("-> {0}" -f (Join-Path $OutDir 'seed.json'))
