#requires -Version 5.1
<#
  N-017 (PowerShell channel): prove the uninstaller never kills its own process family.

  The registry QuietUninstallString points at <install>\installer\Setup.ps1, so when the
  in-tree copy runs, its own PID / parent cmd-powershell / helper children all have the
  install root in their command line. The old matcher killed them (self-kill, exit != 0,
  nothing deleted). `Select-TargetProcesses` is the testable core of the fix.

  This fixture dot-sources the real Setup.ps1 through its test seam, feeds a synthetic
  Win32_Process-shaped table and prints the selection as JSON:

    AIDN_PS1_FAMILY_JSON:{"selfPid":…,"parentPid":…,"childPid":…,"selected":[…],"family":[…]}

  Nothing is stopped: the fixture only calls the selection function.

  Author: PT-dove
#>
param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$env:AIDN_SETUP_TEST_DOTSOURCE = '1'
$env:AIDN_SETUP_STARTMENU_DIR = Join-Path $env:TEMP 'aidn-family-start-menu'
$env:AIDN_SETUP_DESKTOP_DIR = Join-Path $env:TEMP 'aidn-family-desktop'

. $SetupPath

$selfPid = [int]$PID
$parentPid = 7000
$childPid = 7001
$unrelatedPid = 7100
$outsidePid = 7200
$rootPrefix = $Root.TrimEnd('\') + '\'

$table = @(
    [pscustomobject]@{
        ProcessId = $selfPid; ParentProcessId = $parentPid; Name = 'powershell.exe'
        ExecutablePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
        CommandLine = '-NoProfile -File "' + $rootPrefix + 'installer\Setup.ps1" /S /uninstall'
    },
    [pscustomobject]@{
        ProcessId = $parentPid; ParentProcessId = 1; Name = 'node.exe'
        ExecutablePath = 'C:\Program Files\nodejs\node.exe'
        CommandLine = 'node --test ' + $rootPrefix + 'tests'
    },
    [pscustomobject]@{
        ProcessId = $childPid; ParentProcessId = $selfPid; Name = 'taskkill.exe'
        ExecutablePath = 'C:\Windows\System32\taskkill.exe'
        CommandLine = 'taskkill /F /PID 1'
    },
    [pscustomobject]@{
        ProcessId = $unrelatedPid; ParentProcessId = 1; Name = 'node.exe'
        ExecutablePath = $rootPrefix + 'runtime\node\node.exe'
        CommandLine = '"' + $rootPrefix + 'runtime\node\node.exe" daemon/bin.js'
    },
    [pscustomobject]@{
        ProcessId = $outsidePid; ParentProcessId = 1; Name = 'notepad.exe'
        ExecutablePath = 'C:\Windows\System32\notepad.exe'
        CommandLine = 'notepad'
    }
)

$selected = @()
$family = @()
if (Get-Command Select-TargetProcesses -ErrorAction SilentlyContinue) {
    $match = Select-TargetProcesses -Root $Root -ProcessTable $table
    $selected = @($match.Keys | ForEach-Object { [int]$_ } | Sort-Object)
    $familyIds = Get-SelfFamilyIds -ProcessTable $table
    $family = @($familyIds.Keys | ForEach-Object { [int]$_ } | Sort-Object)
} else {
    [Console]::Error.WriteLine('Select-TargetProcesses is missing from Setup.ps1 (pre-fix file?)')
    exit 3
}

$payload = [pscustomobject]@{
    selfPid      = $selfPid
    parentPid    = $parentPid
    childPid     = $childPid
    unrelatedPid = $unrelatedPid
    selected     = $selected
    family       = $family
}
[Console]::Out.WriteLine('AIDN_PS1_FAMILY_JSON:' + ($payload | ConvertTo-Json -Depth 4 -Compress))
exit 0
