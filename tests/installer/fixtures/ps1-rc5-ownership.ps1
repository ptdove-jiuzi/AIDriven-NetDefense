#requires -Version 5.1
<#
  Drive the PowerShell installer channel's RC5-N01 ownership credential without touching
  the machine.

  Dot-sources the real Setup.ps1 through its documented test seam
  ($env:AIDN_SETUP_TEST_DOTSOURCE=1, which returns before the silent/GUI entry points),
  replaces the side-effecting helpers with stubs, then executes a list of jobs:

    { "op": "install",    "name": "...", "target": "<dir>", "payload": "<dir>" }
    { "op": "uninstall",  "name": "...", "target": "<dir>" }
    { "op": "credential", "name": "...", "target": "<dir>", "channel": "...",
      "version": "...", "installId": "<32 hex>" }
    { "op": "verify",     "name": "...", "target": "<dir>" }

  Every job produces one JSON object; the whole array is printed on a single line after
  the AIDN_PS1_RC5_JSON: marker.  Nothing outside -WorkDir (plus the payload copy the
  installer makes into the target) is created, stopped, or deleted.

  Author: PT-dove
#>
param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [Parameter(Mandatory = $true)][string]$JobFile
)

$ErrorActionPreference = 'Stop'

$env:AIDN_SETUP_TEST_DOTSOURCE = '1'
$env:AIDN_SETUP_STARTMENU_DIR = Join-Path $WorkDir 'redirected-start-menu'
$env:AIDN_SETUP_DESKTOP_DIR = Join-Path $WorkDir 'redirected-desktop'
$env:AIDN_SETUP_DEFAULT_DIR = Join-Path $WorkDir 'redirected-default-dir'

. $SetupPath

# --- side effects stubbed out: a test must never stop processes, edit shortcuts,
# --- write the registry or the Run key.  The ownership gate runs before any of them.
function Stop-TargetProcesses { param([string]$Root) return 0 }
function Remove-Shortcuts { }
function Remove-Autostart { }
function Set-Autostart { param([bool]$Enabled, [string]$ExePath) }
function New-InstallShortcuts { param([string]$Root, [string]$ExeRel, [bool]$Desktop) }

function Get-OptionalCommand([string]$Name) {
    return (Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

# 显式 UTF-8 读：作业里可能含非 ASCII 目标路径（中文目录），而 PS 5.1 的 Get-Content 对
# 无 BOM 文件按 ANSI 代码页解码，会把中文路径读成乱码（夹具自己的坑，与被测产品无关）。
$jobsText = [System.IO.File]::ReadAllText($JobFile, [System.Text.Encoding]::UTF8)
$jobs = $jobsText | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList

foreach ($job in $jobs) {
    $entry = [ordered]@{ name = [string]$job.name; op = [string]$job.op }

    switch ([string]$job.op) {
        'uninstall' {
            $entry.refused = $false
            $entry.message = ''
            try {
                Uninstall-Target -Target ([string]$job.target) -KeepData $false -SkipRegistry $true -OnStep $null
            } catch {
                $entry.refused = $true
                $entry.message = $_.Exception.Message
            }
            $entry.exists = Test-Path -LiteralPath ([string]$job.target)
            $entry.deleted = -not $entry.exists
        }
        'install' {
            $script:PayloadDir = [string]$job.payload
            $entry.ok = $false
            $entry.message = ''
            try {
                Install-Target -Target ([string]$job.target) -DesktopShortcut $false -SkipRegistry $true `
                    -NoShortcut $true -Autostart $false -OnStep $null | Out-Null
                $entry.ok = $true
            } catch {
                $entry.ok = $false
                $entry.message = $_.Exception.Message
            }
            $record = Get-InstallJson -Root ([string]$job.target)
            if ($record) {
                $entry.channel = [string]$record.channel
                $entry.version = [string]$record.version
                $entry.installPath = [string]$record.installPath
                $entry.ownership = $record.ownership
            }
        }
        'credential' {
            $entry.ok = $false
            $entry.error = ''
            if (-not (Get-OptionalCommand 'New-OwnershipBlock')) {
                $entry.error = 'New-OwnershipBlock is not defined by this Setup.ps1'
            } else {
                try {
                    $block = New-OwnershipBlock -Root ([string]$job.target) -Channel ([string]$job.channel) `
                        -Version ([string]$job.version) -InstallId ([string]$job.installId)
                    $entry.credential = $block
                    $entry.ok = $true
                } catch {
                    $entry.error = $_.Exception.Message
                }
            }
        }
        'verify' {
            $entry.ok = $false
            $entry.error = ''
            if (-not (Get-OptionalCommand 'Test-OwnershipProof')) {
                $entry.error = 'Test-OwnershipProof is not defined by this Setup.ps1'
            } else {
                try {
                    $entry.ok = [bool](Test-OwnershipProof -Root ([string]$job.target))
                } catch {
                    $entry.error = $_.Exception.Message
                }
            }
        }
        default {
            $entry.error = "unknown op: $($job.op)"
        }
    }

    [void]$results.Add([pscustomobject]$entry)
}

$json = ConvertTo-Json -InputObject $results -Depth 6 -Compress
# Chinese in the refusal messages must survive the console code page (cmd.exe here is
# CP936, and a UTF-8 .ps1 read by PowerShell 5.1 would mangle it): write the verdicts to
# a UTF-8 file and print only its path on stdout.
$verdictPath = Join-Path $WorkDir 'verdicts.json'
[System.IO.File]::WriteAllText($verdictPath, $json, (New-Object System.Text.UTF8Encoding($false)))
[Console]::Out.WriteLine('AIDN_PS1_RC5_JSON:' + $verdictPath)
exit 0
