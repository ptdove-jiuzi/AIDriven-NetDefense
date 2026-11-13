#requires -Version 5.1
<#
  Drive the PowerShell installer channel's HKCU Run (autostart) code with real registry I/O.

  Dot-sources the real Setup.ps1 through its documented test seam
  ($env:AIDN_SETUP_TEST_DOTSOURCE=1, which returns before the silent/GUI entry points), so
  `Set-Autostart` / `Remove-Autostart` / `Test-Autostart` below are the shipped functions,
  not copies.  Nothing is stubbed: the value really is written to, read from and deleted
  from HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run.

  Jobs (JSON array file):
    { "op": "set",        "name": "...", "exe": "<path to exe>" }
    { "op": "remove-for", "name": "...", "target": "<install root this uninstall is for>" }
    { "op": "state",      "name": "..." }

  Each job yields one object; the array is written to <WorkDir>\verdicts-runkey.json and
  that path is printed after the AIDN_PS1_RUNKEY_JSON: marker (the console code page on
  this machine is CP936, so the JSON travels through a UTF-8 file, not stdout).

  Author: PT-dove
#>
param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [Parameter(Mandatory = $true)][string]$JobFile
)

$ErrorActionPreference = 'Stop'

$env:TEMP = Join-Path $WorkDir 'temp'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$env:AIDN_SETUP_TEST_DOTSOURCE = '1'
$env:AIDN_SETUP_STARTMENU_DIR = Join-Path $WorkDir 'redirected-start-menu'
$env:AIDN_SETUP_DESKTOP_DIR = Join-Path $WorkDir 'redirected-desktop'
$env:AIDN_SETUP_DEFAULT_DIR = Join-Path $WorkDir 'redirected-default-dir'

. $SetupPath

$runKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'AIDrivenNetDefense'

function Read-RunKeyRaw {
    param([string]$Name)
    try {
        $item = Get-ItemProperty -Path $runKey -Name $Name -ErrorAction Stop
        return [string]$item.$Name
    } catch { return $null }
}

$jobsText = [System.IO.File]::ReadAllText($JobFile, [System.Text.Encoding]::UTF8)
$jobs = $jobsText | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList

foreach ($job in $jobs) {
    $entry = [ordered]@{ name = [string]$job.name; op = [string]$job.op; error = '' }
    try {
        switch ([string]$job.op) {
            'set' {
                $entry.returned = Set-Autostart -Enabled $true -ExePath ([string]$job.exe)
            }
            'remove-for' {
                $entry.returned = Remove-Autostart -Target ([string]$job.target)
            }
            'state' { }
            default { $entry.error = "unknown op: $($job.op)" }
        }
    } catch {
        $entry.error = $_.Exception.Message
    }
    # Observation is deliberately taken with plain Get-ItemProperty / Test-Autostart, not
    # with a helper this change introduces, so a red result means the *behaviour* is wrong.
    $entry.raw = Read-RunKeyRaw -Name $runValue
    $entry.registered = [bool](Test-Autostart)
    [void]$results.Add([pscustomobject]$entry)
}

$verdictPath = Join-Path $WorkDir 'verdicts-runkey.json'
$json = ConvertTo-Json -InputObject $results -Depth 6 -Compress
[System.IO.File]::WriteAllText($verdictPath, $json, (New-Object System.Text.UTF8Encoding($false)))
[Console]::Out.WriteLine('AIDN_PS1_RUNKEY_JSON:' + $verdictPath)
exit 0
