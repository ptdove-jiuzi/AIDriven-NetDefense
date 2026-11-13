# P1-CLOSE host restore — remove only AIDriven-owned global artefacts left by non-elevated %TEMP% installs.
# Usage: pwsh -NoProfile -File evidence\p1-close\tools\host-restore.ps1 -Out <result.json> [-TreePath <dir>]...
# Safety: -TreePath is only removed when its path contains 'p1-close' or 'upgrade-path' (campaign temp roots).
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string[]]$TreePath = @()
)
$ErrorActionPreference = 'Continue'
$steps = @()

function Add-Step([string]$name, $data) {
  $script:steps += [ordered]@{ step = $name; at = (Get-Date -Format 'o'); data = $data }
  Write-Output ("[{0}] {1}" -f $name, ($data | ConvertTo-Json -Compress -Depth 5))
}

# 1. kill product processes
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'AIDriven' })
foreach ($p in $procs) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Add-Step 'kill-process' ([ordered]@{ id = $p.Id; name = $p.ProcessName; ok = $true }) }
  catch { Add-Step 'kill-process' ([ordered]@{ id = $p.Id; name = $p.ProcessName; ok = $false; error = $_.Exception.Message }) }
}
Add-Step 'kill-process-summary' ([ordered]@{ matched = $procs.Count; remaining = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'AIDriven' }).Count })

# 2. remove campaign temp trees (guarded)
foreach ($tree in $TreePath) {
  if ([string]::IsNullOrWhiteSpace($tree)) { continue }
  $full = [System.IO.Path]::GetFullPath($tree)
  if ($full -notmatch '(?i)\\p1-close\\|\\upgrade-path\\') {
    Add-Step 'remove-tree-skipped-guard' ([ordered]@{ path = $full; reason = 'not a campaign temp root' })
    continue
  }
  $existed = Test-Path -LiteralPath $full
  if ($existed) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue }
  Add-Step 'remove-tree' ([ordered]@{ path = $full; existed = $existed; stillExists = (Test-Path -LiteralPath $full) })
}

# 3. uninstall keys (HKCU removable non-elevated; HKLM reported, removal best-effort)
foreach ($key in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense'
  )) {
  $existed = Test-Path $key
  if ($existed) { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue }
  Add-Step "uninstall-key $key" ([ordered]@{ existed = $existed; stillExists = (Test-Path $key) })
}

# 4. Run value (HKCU only — this campaign never elevates)
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runExisted = $false
if (Test-Path $runKey) {
  $props = (Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue).PSObject.Properties |
    Where-Object { $_.Name -eq 'AIDrivenNetDefense' }
  $runExisted = [bool]$props
  if ($runExisted) { Remove-ItemProperty -LiteralPath $runKey -Name 'AIDrivenNetDefense' -Force -ErrorAction SilentlyContinue }
}
Add-Step 'run-value' ([ordered]@{ existed = $runExisted; stillExists = [bool]((Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -eq 'AIDrivenNetDefense' }) })

# 5. start menu + desktop shortcuts (only AIDriven-named)
foreach ($d in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem $d -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'AIDriven|网域' } | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Add-Step 'remove-start-menu' ([ordered]@{ path = $_.FullName; stillExists = (Test-Path -LiteralPath $_.FullName) })
  }
}
foreach ($d in @((Join-Path $env:USERPROFILE 'Desktop'), (Join-Path $env:PUBLIC 'Desktop'))) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem $d -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'AIDriven|网域' } | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    Add-Step 'remove-desktop-lnk' ([ordered]@{ path = $_.FullName; stillExists = (Test-Path -LiteralPath $_.FullName) })
  }
}

$result = [ordered]@{ at = (Get-Date -Format 'o'); steps = $steps }
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllText($Out, ($result | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
Write-Output ("[host-restore] -> {0}" -f $Out)
