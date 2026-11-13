#requires -Version 5.1
<#
  AIDriven NetDefense - installer v2 acceptance run
  Author: PT-dove

  Runs the real installer (silent mode) against a throwaway directory and asserts
  the v2 contract:

    1. silent install  -> exe present, shortcuts point at the exe, install.json
                          records version + upgradedFrom
    2. silent overwrite -> upgradedFrom non-empty, data\ untouched
    3. launch from the Start Menu shortcut -> process alive (tasklist)
    4. uninstall        -> tree gone, HKCU Run entry gone, no leftover process
    5. /NOSHORTCUT      -> no shortcuts created

  Nothing outside the temp root is written: the installer's shortcut roots and
  default install directory are redirected through its test seams, and /NOREG
  keeps the uninstall registry key out of the picture except in the one case that
  deliberately tests registry detection (that key lives under HKCU and is removed
  again by the uninstall step).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File run-acceptance.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File run-acceptance.ps1 -PayloadDir D:\path\to\v14-bundle
    powershell -NoProfile -ExecutionPolicy Bypass -File run-acceptance.ps1 -KeepRoot

  -PayloadDir points the run at a real v14 bundle. Without it the script builds a
  synthetic v14-shaped fixture whose AIDrivenNetDefense.exe is a stand-in copy of
  cmd.exe: that exercises the shortcut -> exe -> live process plumbing (tasklist
  shows an AIDrivenNetDefense.exe image) but cannot show a tray icon, because the
  real desktop shell is not in this repository yet.
#>
param(
    [string]$PayloadDir,
    [switch]$KeepRoot
)

$ErrorActionPreference = 'Stop'
$script:checks = New-Object System.Collections.ArrayList
$script:step = 0

function Add-Check {
    param([string]$Name, [bool]$Pass, [string]$Detail)
    [void]$script:checks.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    $tag = if ($Pass) { 'PASS' } else { 'FAIL' }
    Write-Host ("[{0}] {1}" -f $tag, $Name)
    if ($Detail) { Write-Host ("       {0}" -f $Detail) }
}

function Get-TasklistCount {
    param([string]$ImageName)
    $raw = & tasklist.exe /FI ("IMAGENAME eq " + $ImageName) /NH /FO CSV 2>$null
    return @($raw | Where-Object { $_ -match [regex]::Escape($ImageName) }).Count
}

function Get-LnkTarget {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $sh = New-Object -ComObject WScript.Shell
    return $sh.CreateShortcut($Path).TargetPath
}

function Get-ProcessesUnder {
    param([string]$Root)
    $prefix = $Root.TrimEnd('\') + '\'
    $hits = @()
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $ep = $p.ExecutablePath
        $cl = $p.CommandLine
        if (($ep -and $ep.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) -or
            ($cl -and $cl.IndexOf($prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
            $hits += $p
        }
    }
    return $hits
}

$here = $PSScriptRoot
$src  = Split-Path -Parent $here
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = Join-Path $env:TEMP ("aidn-installer-v2-$stamp")
$dist = Join-Path $root 'dist'
$menu = Join-Path $root 'StartMenu'
$desk = Join-Path $root 'Desktop'
$def  = Join-Path $root 'default'

Write-Host "== AIDriven NetDefense installer v2 acceptance =="
Write-Host "root: $root"

# ------------------------------------------------------------------ fixture
New-Item -ItemType Directory -Path $dist, $menu, $desk, $def -Force | Out-Null
foreach ($f in @('Setup.ps1', 'Setup.cmd', 'SelfCheck.mjs', 'INSTALL.txt')) {
    Copy-Item -LiteralPath (Join-Path $src $f) -Destination $dist -Force
}

$payload = Join-Path $dist 'payload'
$standIn = $false
if ($PayloadDir) {
    # Real bundle: copy it in, so the layout is exercised exactly as shipped.
    Write-Host "payload: $PayloadDir (real)"
    & robocopy.exe $PayloadDir $payload /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy of -PayloadDir failed: $LASTEXITCODE" }
} else {
    Write-Host "payload: synthetic v14-shaped fixture (stand-in exe)"
    $standIn = $true
    New-Item -ItemType Directory -Path (Join-Path $payload 'app\daemon'), (Join-Path $payload 'app\console') -Force | Out-Null
    $bundle = [ordered]@{
        schemaVersion = '1.0'
        author        = 'PT-dove'
        kind          = 'desktop-bundle'
        builtAt       = (Get-Date).ToString('o')
        components    = @('daemon', 'console')
        fixture       = 'acceptance-stand-in'
    }
    ($bundle | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath (Join-Path $payload 'bundle.json') -Encoding UTF8
    '// fixture daemon entry' | Set-Content -LiteralPath (Join-Path $payload 'app\daemon\bin.js') -Encoding UTF8
    '<!doctype html><title>fixture</title>' | Set-Content -LiteralPath (Join-Path $payload 'app\console\index.html') -Encoding UTF8
    # Stand-in entry point: a copy of cmd.exe keeps the same image name and stays
    # alive when launched with no arguments, which is what the shortcut does.
    # notepad.exe was tried first and exits instantly on current Windows builds.
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination (Join-Path $payload 'app\AIDrivenNetDefense.exe') -Force
}

# Test seams: no real Start Menu / Desktop / Program Files is touched.
$env:AIDN_SETUP_DEFAULT_DIR   = $def
$env:AIDN_SETUP_STARTMENU_DIR = $menu
$env:AIDN_SETUP_DESKTOP_DIR   = $desk

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Invoke-Setup {
    param([string[]]$SetupArgs, [string]$SetupDir)
    if (-not $SetupDir) { $SetupDir = $dist }
    $script:step++
    $logPath = Join-Path $root ("setup-{0:D2}.log" -f $script:step)
    # A failing setup writes to stderr; keep that as data, not as a terminating error.
    $prevEA = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SetupDir 'Setup.ps1') @SetupArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEA
    ("ARGS: " + ($SetupArgs -join ' ') + "`nEXIT: $code`n$out") | Set-Content -LiteralPath $logPath -Encoding UTF8
    return [pscustomobject]@{ Code = $code; Output = $out.Trim(); Log = $logPath }
}

$app1 = Join-Path $root 'app1'
$menuLnk  = Join-Path $menu 'AIDriven NetDefense.lnk'
$deskLnk  = Join-Path $desk 'AIDriven NetDefense.lnk'
$diagLnk  = Join-Path $menu '诊断\自检.lnk'
$runKey   = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'AIDrivenNetDefense'

function Get-RunEntry {
    if (-not (Test-Path $runKey)) { return $null }
    $v = Get-ItemProperty -Path $runKey -Name $runValue -ErrorAction SilentlyContinue
    if ($v) { return $v.$runValue }
    return $null
}

# Snapshot the two HKCU keys this run touches, so a machine that already has a
# real install is left exactly as it was.
$arpPath = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense'
$arpKeyName = 'HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense'
$runKeyName = 'HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$arpBak = Join-Path $root 'arp-backup.reg'
$runBak = Join-Path $root 'run-backup.reg'
$arpHad = Test-Path $arpPath
$runHad = $null -ne (Get-RunEntry)
if ($arpHad) { & reg.exe export $arpKeyName $arpBak /y | Out-Null }
if ($runHad) { & reg.exe export $runKeyName $runBak /y | Out-Null }
if ($arpHad) { Remove-Item -Path $arpPath -Recurse -Force -ErrorAction SilentlyContinue }
if ($runHad) { Remove-ItemProperty -Path $runKey -Name $runValue -Force -ErrorAction SilentlyContinue }

try {
    # ------------------------------------------------------------ T1 install
    Write-Host "`n-- T1 silent install (/S /DIR= /NOREG)"
    $r1 = Invoke-Setup @('/S', "/DIR=$app1", '/NOREG')
    $exe = Join-Path $app1 'app\AIDrivenNetDefense.exe'
    $ij  = Join-Path $app1 'install\install.json'
    $record = $null
    if (Test-Path -LiteralPath $ij) { $record = Get-Content -LiteralPath $ij -Raw | ConvertFrom-Json }

    Add-Check 'T1 exit code 0' ($r1.Code -eq 0) ("exit=$($r1.Code) $($r1.Output)")
    Add-Check 'T1 exe present' (Test-Path -LiteralPath $exe) $exe
    Add-Check 'T1 install.json present' ($null -ne $record) $ij
    Add-Check 'T1 install.json version' ($record -and $record.version -eq '0.0.1-rc.1') ("version=$($record.version)")
    Add-Check 'T1 install.json upgradedFrom empty on fresh install' ($record -and -not $record.upgradedFrom) ("upgradedFrom=[$($record.upgradedFrom)]")
    Add-Check 'T1 install.json desktopExe' ($record -and $record.desktopExe -eq 'app\AIDrivenNetDefense.exe') ("desktopExe=$($record.desktopExe)")

    $mt = Get-LnkTarget $menuLnk
    Add-Check 'T1 start menu shortcut -> exe' ($mt -and $mt -ieq $exe) ("target=$mt")
    $dt = Get-LnkTarget $deskLnk
    Add-Check 'T1 desktop shortcut -> exe' ($dt -and $dt -ieq $exe) ("target=$dt")
    $g = Get-LnkTarget $diagLnk
    Add-Check 'T1 诊断 sub-menu points at self-check' ($g -and $g -like '*启动-自检.cmd') ("target=$g")
    $selfCheck = Join-Path $app1 '启动-自检.cmd'
    Add-Check 'T1 self-check script kept' (Test-Path -LiteralPath $selfCheck) $selfCheck
    Add-Check 'T1 no autostart without /AUTOSTART' ($null -eq (Get-RunEntry)) ("run=[$(Get-RunEntry)]")

    # ------------------------------------------------------- T2 user data
    Write-Host "`n-- T2 seed user data"
    $dataDir = Join-Path $app1 'data'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $dataFile = Join-Path $dataDir 'state.db'
    ('user-data-' + $stamp) | Set-Content -LiteralPath $dataFile -Encoding UTF8
    $dataHash = (Get-FileHash -LiteralPath $dataFile -Algorithm SHA256).Hash
    Add-Check 'T2 seeded data file' (Test-Path -LiteralPath $dataFile) $dataFile

    # ------------------------------------------------- T3 overwrite upgrade
    Write-Host "`n-- T3 silent overwrite install (/S /DIR= /NOREG /AUTOSTART)"
    $r3 = Invoke-Setup @('/S', "/DIR=$app1", '/NOREG', '/AUTOSTART')
    $record2 = $null
    if (Test-Path -LiteralPath $ij) { $record2 = Get-Content -LiteralPath $ij -Raw | ConvertFrom-Json }
    Add-Check 'T3 exit code 0' ($r3.Code -eq 0) ("exit=$($r3.Code) $($r3.Output)")
    Add-Check 'T3 upgradedFrom non-empty' ($record2 -and $record2.upgradedFrom) ("upgradedFrom=[$($record2.upgradedFrom)]")
    Add-Check 'T3 data file survived upgrade' ((Test-Path -LiteralPath $dataFile) -and ((Get-FileHash -LiteralPath $dataFile -Algorithm SHA256).Hash -eq $dataHash)) $dataFile
    Add-Check 'T3 exe still present' (Test-Path -LiteralPath $exe) $exe
    $runEntry = Get-RunEntry
    Add-Check 'T3 /AUTOSTART wrote HKCU Run' ($runEntry -and $runEntry -like "*$exe*") ("run=[$runEntry]")
    Add-Check 'T3 install.json autostart=true' ($record2 -and $record2.autostart -eq $true) ("autostart=$($record2.autostart)")

    # -------------------------------------------------- T4 launch from menu
    Write-Host "`n-- T4 launch via Start Menu shortcut"
    Start-Process -FilePath $menuLnk | Out-Null
    $alive = 0
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        $alive = Get-TasklistCount 'AIDrivenNetDefense.exe'
        if ($alive -gt 0) { break }
    }
    Add-Check 'T4 shortcut launched the exe (tasklist)' ($alive -gt 0) ("instances=$alive")
    # CIM can lag tasklist by a beat; give the path match its own small window.
    $procs = @()
    for ($i = 0; $i -lt 12; $i++) {
        $procs = @(Get-ProcessesUnder -Root $app1 | Where-Object { $_.ExecutablePath })
        if ($procs.Count -gt 0) { break }
        Start-Sleep -Milliseconds 250
    }
    $inRoot = @($procs | Where-Object { $_.ExecutablePath -like "$($app1.TrimEnd('\'))\*" })
    Add-Check 'T4 process path is inside install dir' ($inRoot.Count -gt 0) ("matched=$($inRoot.Count)")

    # daemon-like child whose command line references the install dir
    $note = Join-Path $app1 'data\note.txt'
    'daemon-child' | Set-Content -LiteralPath $note -Encoding UTF8
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\notepad.exe') -ArgumentList "`"$note`"" | Out-Null
    Start-Sleep -Milliseconds 700
    $child = @(Get-ProcessesUnder -Root $app1 | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -notlike "$($app1.TrimEnd('\'))\*") })
    Add-Check 'T4 cmdline-matched child detected' ($child.Count -gt 0) ("cmdline-only matches=$($child.Count)")

    # ------------------------------------------------------- T5 uninstall
    Write-Host "`n-- T5 silent uninstall (/S /uninstall /DIR= /NOREG)"
    $r5 = Invoke-Setup @('/S', '/uninstall', "/DIR=$app1", '/NOREG')
    Add-Check 'T5 exit code 0' ($r5.Code -eq 0) ("exit=$($r5.Code) $($r5.Output)")
    $left = @()
    if (Test-Path -LiteralPath $app1) { $left = @(Get-ChildItem -LiteralPath $app1 -Force) }
    Add-Check 'T5 install dir emptied/removed' ($left.Count -eq 0) ("leftover items=$($left.Count)")
    Add-Check 'T5 HKCU Run entry removed' ($null -eq (Get-RunEntry)) ("run=[$(Get-RunEntry)]")
    Add-Check 'T5 no AIDrivenNetDefense process' ((Get-TasklistCount 'AIDrivenNetDefense.exe') -eq 0) ("instances=$(Get-TasklistCount 'AIDrivenNetDefense.exe')")
    Add-Check 'T5 no process under install dir' (@(Get-ProcessesUnder -Root $app1).Count -eq 0) ("matches=$(@(Get-ProcessesUnder -Root $app1).Count)")
    Add-Check 'T5 start menu folder gone' (-not (Test-Path -LiteralPath $menuLnk)) $menuLnk
    Add-Check 'T5 desktop shortcut gone' (-not (Test-Path -LiteralPath $deskLnk)) $deskLnk

    # ---------------------------------------------------- T6 /NOSHORTCUT
    Write-Host "`n-- T6 /NOSHORTCUT"
    $app2 = Join-Path $root 'app2'
    $r6 = Invoke-Setup @('/S', "/DIR=$app2", '/NOREG', '/NOSHORTCUT')
    Add-Check 'T6 exit code 0' ($r6.Code -eq 0) ("exit=$($r6.Code)")
    Add-Check 'T6 no start menu shortcut' (-not (Test-Path -LiteralPath $menuLnk)) $menuLnk
    Add-Check 'T6 no desktop shortcut' (-not (Test-Path -LiteralPath $deskLnk)) $deskLnk
    $r6b = Invoke-Setup @('/S', '/uninstall', "/DIR=$app2", '/NOREG')
    Add-Check 'T6 uninstall exit 0' ($r6b.Code -eq 0) ("exit=$($r6b.Code)")

    # ------------------------------------- T7 keep-data uninstall (GUI path)
    Write-Host "`n-- T7 uninstall keep-data (function level, same code the GUI calls)"
    $app3 = Join-Path $root 'app3'
    $r7 = Invoke-Setup @('/S', "/DIR=$app3", '/NOREG')
    Add-Check 'T7 install exit 0' ($r7.Code -eq 0) ("exit=$($r7.Code)")
    New-Item -ItemType Directory -Path (Join-Path $app3 'data') -Force | Out-Null
    'keep-me' | Set-Content -LiteralPath (Join-Path $app3 'data\keep.db') -Encoding UTF8
    $prevEnv = $env:AIDN_SETUP_TEST_DOTSOURCE
    $env:AIDN_SETUP_TEST_DOTSOURCE = '1'
    $out7 = & $psExe -NoProfile -ExecutionPolicy Bypass -Command @"
`$env:AIDN_SETUP_TEST_DOTSOURCE='1'
. '$dist\Setup.ps1'
Uninstall-Target -Target '$app3' -KeepData `$true -SkipRegistry:`$true -OnStep `$null
"@ 2>&1 | Out-String
    if ($prevEnv) { $env:AIDN_SETUP_TEST_DOTSOURCE = $prevEnv } else { Remove-Item Env:\AIDN_SETUP_TEST_DOTSOURCE -ErrorAction SilentlyContinue }
    Add-Check 'T7 data\ kept' (Test-Path -LiteralPath (Join-Path $app3 'data\keep.db')) ("out: $($out7.Trim())")
    Add-Check 'T7 install\ kept' (Test-Path -LiteralPath (Join-Path $app3 'install')) (Join-Path $app3 'install')
    Add-Check 'T7 program files removed' (-not (Test-Path -LiteralPath (Join-Path $app3 'app'))) (Join-Path $app3 'app')
    Remove-Item -LiteralPath $app3 -Recurse -Force -ErrorAction SilentlyContinue

    # ------------------------- T8 install.json fallback (no registry, no /DIR)
    Write-Host "`n-- T8 upgrade detection via install.json fallback (both installs /NOREG, no /DIR)"
    $r8a = Invoke-Setup @('/S', '/NOREG')
    $recordA = $null
    if (Test-Path -LiteralPath (Join-Path $def 'install\install.json')) {
        $recordA = Get-Content -LiteralPath (Join-Path $def 'install\install.json') -Raw | ConvertFrom-Json
    }
    Add-Check 'T8 first install landed on default dir' (($r8a.Code -eq 0) -and $recordA -and $recordA.installPath -ieq $def) ("path=$($recordA.installPath)")
    $r8b = Invoke-Setup @('/S', '/NOREG')
    $recordB = $null
    if (Test-Path -LiteralPath (Join-Path $def 'install\install.json')) {
        $recordB = Get-Content -LiteralPath (Join-Path $def 'install\install.json') -Raw | ConvertFrom-Json
    }
    Add-Check 'T8 second install reused default dir' ($r8b.Code -eq 0 -and $recordB -and $recordB.installPath -ieq $def) ("path=$($recordB.installPath)")
    Add-Check 'T8 upgradedFrom resolved from install.json' ($recordB -and $recordB.upgradedFrom) ("upgradedFrom=[$($recordB.upgradedFrom)]")
    [void](Invoke-Setup @('/S', '/uninstall', "/DIR=$def", '/NOREG'))

    # ------------------------------- T9 upgrade detection via registry ARP key
    Write-Host "`n-- T9 upgrade detection via registry InstallLocation (no /NOREG here)"
    $app4 = Join-Path $root 'app4'
    $r9a = Invoke-Setup @('/S', "/DIR=$app4")
    $arp = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense' -ErrorAction SilentlyContinue
    Add-Check 'T9 ARP key written with InstallLocation' ($arp -and $arp.InstallLocation -ieq $app4) ("InstallLocation=$($arp.InstallLocation)")
    $r9b = Invoke-Setup @('/S')
    $record9 = $null
    if (Test-Path -LiteralPath (Join-Path $app4 'install\install.json')) {
        $record9 = Get-Content -LiteralPath (Join-Path $app4 'install\install.json') -Raw | ConvertFrom-Json
    }
    Add-Check 'T9 second install hit the registry path' ($r9b.Code -eq 0 -and $record9 -and $record9.installPath -ieq $app4) ("path=$($record9.installPath)")
    Add-Check 'T9 upgradedFrom non-empty' ($record9 -and $record9.upgradedFrom) ("upgradedFrom=[$($record9.upgradedFrom)]")
    $r9c = Invoke-Setup @('/S', '/uninstall', "/DIR=$app4")
    Add-Check 'T9 uninstall exit 0' ($r9c.Code -eq 0) ("exit=$($r9c.Code)")
    Add-Check 'T9 ARP key removed' (-not (Test-Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense')) 'HKCU ARP'

    # ------------------------------- T10 v13 payload must be refused outright
    Write-Host "`n-- T10 v13-shaped payload refused before writing anything"
    $dist13 = Join-Path $root 'dist13'
    $p13 = Join-Path $dist13 'payload'
    New-Item -ItemType Directory -Path (Join-Path $p13 'app'), (Join-Path $p13 'launch') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $dist 'Setup.ps1') -Destination $dist13 -Force
    Copy-Item -LiteralPath (Join-Path $dist 'SelfCheck.mjs') -Destination $dist13 -Force
    '// v13 daemon-less app entry' | Set-Content -LiteralPath (Join-Path $p13 'app\cli.js') -Encoding UTF8
    ([ordered]@{ schemaVersion = '1.0'; author = 'PT-dove'; kind = 'packaging-poc'; builtAt = (Get-Date).ToString('o') } |
        ConvertTo-Json) | Set-Content -LiteralPath (Join-Path $p13 'bundle.json') -Encoding UTF8
    $app13 = Join-Path $root 'app13'
    $r10 = Invoke-Setup -SetupArgs @('/S', "/DIR=$app13", '/NOREG') -SetupDir $dist13
    Add-Check 'T10 v13 payload rejected (non-zero exit)' ($r10.Code -ne 0) ("exit=$($r10.Code)")
    Add-Check 'T10 error names the missing exe' ($r10.Output -like '*AIDrivenNetDefense.exe*') ("out=$($r10.Output)")
    Add-Check 'T10 nothing written to target' (-not (Test-Path -LiteralPath $app13)) $app13
}
finally {
    # Never leave a stray stand-in process behind.
    Get-Process -Name 'AIDrivenNetDefense' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    foreach ($p in (Get-ProcessesUnder -Root $root)) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
    Remove-Item Env:\AIDN_SETUP_DEFAULT_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\AIDN_SETUP_STARTMENU_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\AIDN_SETUP_DESKTOP_DIR -ErrorAction SilentlyContinue

    # Put back whatever the machine had before the run started.
    if ($arpHad -and (Test-Path -LiteralPath $arpBak)) { & reg.exe import $arpBak | Out-Null }
    if ($runHad -and (Test-Path -LiteralPath $runBak)) { & reg.exe import $runBak | Out-Null }
}

$pass = @($script:checks | Where-Object { $_.pass }).Count
$fail = @($script:checks | Where-Object { -not $_.pass }).Count
$payloadLabel = 'synthetic v14-shaped fixture'
if ($PayloadDir) { $payloadLabel = $PayloadDir }
$verdict = 'PASS'
if ($fail -gt 0) { $verdict = 'FAIL' }

$report = [ordered]@{
    schemaVersion = '1.0'
    author        = 'PT-dove'
    generatedAt   = (Get-Date).ToString('o')
    installer     = 'Setup.ps1 v2 (payload v14, exe shortcuts, /AUTOSTART)'
    productVersion = '0.0.1-rc.1'
    payload       = $payloadLabel
    payloadStandInExe = $standIn
    root          = $root
    checks        = $script:checks
    passed        = $pass
    failed        = $fail
    verdict       = $verdict
}
$reportPath = Join-Path $here ("acceptance-$stamp.json")
($report | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ""
Write-Host ("== {0}: {1} passed / {2} failed ==" -f $report.verdict, $pass, $fail)
Write-Host "report: $reportPath"

if (-not $KeepRoot) {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "temp root removed"
} else {
    Write-Host "temp root kept: $root"
}

if ($fail -gt 0) { exit 1 }
exit 0
