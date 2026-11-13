# Host-level side-effect snapshot: Run value / uninstall keys / start menu / desktop /
# %ProgramFiles% / product processes / %LOCALAPPDATA% product data.
#
# Round-5 powercut seat. Same口径 as evidence/upgrade/r4/host/snapshot.ps1, plus the
# explicit `zero` verdict used by this seat's收工判据 (all six host seams empty).
#
# Background: this product's uninstall cleanup is NOT isolated by `/DIR=` (N-028 §7, still
# an open P2), so any install/uninstall probe can remove the global Run value, the
# uninstall keys and the start-menu folder. That is why every step of this seat brackets
# itself with this snapshot instead of trusting the install log.
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Label = ''
)
$ErrorActionPreference = 'Continue'

function Get-UninstallEntries([string]$Path) {
  $result = @()
  if (-not (Test-Path $Path)) { return $result }
  Get-ChildItem $Path -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $props) { return }
    $display = [string]$props.DisplayName
    $loc = [string]$props.InstallLocation
    if ($display -match 'AIDriven|网域' -or $loc -match 'AIDriven') {
      $result += [ordered]@{
        keyPath              = $_.Name
        displayName          = $display
        displayVersion       = [string]$props.DisplayVersion
        installLocation      = $loc
        uninstallString      = [string]$props.UninstallString
        quietUninstallString = [string]$props.QuietUninstallString
      }
    }
  }
  return $result
}

$runItems = @()
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path $runKey) {
  $props = Get-ItemProperty $runKey -ErrorAction SilentlyContinue
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -match 'AIDriven|aidn|Aegis') {
      $runItems += [ordered]@{ name = $p.Name; value = [string]$p.Value }
    }
  }
}

$startMenu = @()
foreach ($d in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")) {
  if (Test-Path $d) {
    Get-ChildItem $d -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'AIDriven|网域' } |
      ForEach-Object { $startMenu += $_.FullName }
  }
}
$desktop = @()
if (Test-Path "$env:USERPROFILE\Desktop") {
  Get-ChildItem "$env:USERPROFILE\Desktop" -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'AIDriven|网域' } |
    ForEach-Object { $desktop += $_.FullName }
}

$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'AIDriven|aidn|Aegis' } |
    ForEach-Object { [ordered]@{ id = $_.Id; name = $_.ProcessName; path = $_.Path } })

$laProduct = Join-Path $env:LOCALAPPDATA 'AIDriven NetDefense'
$laData = Join-Path $laProduct 'data'
$laDataFiles = if (Test-Path $laData) {
  @(Get-ChildItem $laData -Recurse -File -ErrorAction SilentlyContinue).Count
} else { 0 }

$kept = @(Get-ChildItem $env:TEMP -Directory -Filter 'aidn-setup-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })

$record = [ordered]@{
  label                    = $Label
  capturedAt               = (Get-Date).ToString('o')
  programFilesInstallExists = (Test-Path 'C:\Program Files\AIDriven Net Defense')
  hkcuRunAidriven          = @($runItems)
  uninstallHKCU            = @(Get-UninstallEntries 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
  uninstallHKLM            = @(Get-UninstallEntries 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
  uninstallHKLM_WOW        = @(Get-UninstallEntries 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
  startMenu                = @($startMenu)
  desktop                  = @($desktop)
  processes                = @($procs)
  localAppDataProductExists = (Test-Path $laProduct)
  localAppDataDataFileCount = $laDataFiles
  tempExtractionDirs       = @($kept)
}
$record.zero = (
  ($record.hkcuRunAidriven.Count -eq 0) -and
  ($record.uninstallHKCU.Count -eq 0) -and
  ($record.uninstallHKLM.Count -eq 0) -and
  ($record.uninstallHKLM_WOW.Count -eq 0) -and
  ($record.startMenu.Count -eq 0) -and
  ($record.desktop.Count -eq 0) -and
  (-not $record.programFilesInstallExists) -and
  ($record.processes.Count -eq 0)
)

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Output ("snapshot[{0}] -> {1}  run={2} hkcu={3} hklm={4} hklmwow={5} sm={6} desk={7} pf={8} procs={9} laDataFiles={10} zero={11}" -f `
    $Label, $Out, $record.hkcuRunAidriven.Count, $record.uninstallHKCU.Count, $record.uninstallHKLM.Count, `
    $record.uninstallHKLM_WOW.Count, $record.startMenu.Count, $record.desktop.Count, `
    $record.programFilesInstallExists, $record.processes.Count, $record.localAppDataDataFileCount, $record.zero)
