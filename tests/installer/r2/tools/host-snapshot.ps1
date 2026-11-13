# P1-CLOSE host snapshot — AIDriven installer/gobal side-effect state, UTF-8 JSON out.
# Usage: pwsh -NoProfile -File evidence\p1-close\tools\host-snapshot.ps1 -Out <file.json> [-Label before-x]
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
        keyPath = $_.Name
        displayName = $display
        displayVersion = [string]$props.DisplayVersion
        installLocation = $loc
        uninstallString = [string]$props.UninstallString
        quietUninstallString = [string]$props.QuietUninstallString
        publisher = [string]$props.Publisher
      }
    }
  }
  return $result
}

$snap = [ordered]@{
  label = $Label
  takenAt = (Get-Date -Format 'o')
  user = [string]$env:USERNAME
  elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  runValues = @()
  uninstall = [ordered]@{
    hkcu = @(Get-UninstallEntries 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
    hkcuWow = @(Get-UninstallEntries 'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
    hklm = @(Get-UninstallEntries 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
    hklmWow = @(Get-UninstallEntries 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
  }
  startMenu = @()
  desktop = @()
  programFilesTreeExists = (Test-Path 'C:\Program Files\AIDriven Net Defense')
  processes = @()
  tempTrees = @()
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path $runKey) {
  $props = Get-ItemProperty $runKey -ErrorAction SilentlyContinue
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -match 'AIDriven|aidn|Aegis|网域') {
      $snap.runValues += [ordered]@{ name = $p.Name; value = [string]$p.Value }
    }
  }
}

foreach ($d in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")) {
  if (Test-Path $d) {
    Get-ChildItem $d -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'AIDriven|网域|安装目录|诊断' } |
      ForEach-Object { $snap.startMenu += $_.FullName }
  }
}

foreach ($d in @((Join-Path $env:USERPROFILE 'Desktop'), (Join-Path $env:PUBLIC 'Desktop'))) {
  if (Test-Path $d) {
    Get-ChildItem $d -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'AIDriven|网域' } |
      ForEach-Object { $snap.desktop += $_.FullName }
  }
}

$snap.processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'AIDriven' } |
  ForEach-Object { [ordered]@{ id = $_.Id; name = $_.ProcessName; startTime = $(try { $_.StartTime.ToString('o') } catch { '' }) } })

foreach ($base in @((Join-Path $env:TEMP 'p1-close'), (Join-Path $env:TEMP 'upgrade-path'))) {
  if (Test-Path $base) {
    Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $snap.tempTrees += [ordered]@{ path = $_.FullName; lastWriteTime = $_.LastWriteTime.ToString('o') }
    }
  }
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$json = $snap | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output ("[host-snapshot] {0} -> {1}" -f $Label, $Out)
