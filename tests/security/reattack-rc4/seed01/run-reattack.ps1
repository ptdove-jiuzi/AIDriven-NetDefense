# REATTACK-RC4 / seed01-installer — independent third-party re-attack harness (one-click replay)
#
# Attacks BOTH uninstall paths of AIDriven NetDefense against forged / hostile targets:
#   A. Python: deploy/windows/installer/app/main.py /uninstall /DIR=<path> /NOREG
#      (refusal contract: exit code EXIT_TARGET_INVALID = 5)
#   B. PowerShell: dot-source deploy/windows/installer/Setup.ps1 with
#      AIDN_SETUP_TEST_DOTSOURCE=1, then Uninstall-Target -KeepData $false -SkipRegistry $true
#      (refusal contract: the function throws)
#
# Safety:
#   * every target is created fresh under %TEMP%\reattack-rc4-seed01\run-<stamp>;
#   * Python runs with PYTHONDONTWRITEBYTECODE=1 (no .pyc in the product tree);
#   * TEMP/TMP and the installer's Start-Menu/Desktop test seams are redirected per case;
#   * -Mode mutate edits two product files, but backs them up, records sha256
#     before/mutated/restored, restores byte-identically and re-runs the case; the run
#     aborts with exit 3 if any product file hash differs at the end.
#
# Author: PT-dove
[CmdletBinding()]
param(
    [ValidateSet('check', 'full', 'mutate')]
    [string]$Mode = 'check',
    [switch]$WithMutations,
    [switch]$SkipRealTree,
    [switch]$SkipUnitProbes,
    [string]$EvidenceDir = '',
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# -Mode is the documented one-click switch:
#   check  -> fast attack matrix + unit probes (no 464 MiB real-payload copy)
#   full   -> check + real dist/bundle/win32-x64-v16 payload-tree positive control
#   mutate -> check + 5 mutation experiments (product files edited, restored byte-identically)
if ($Mode -eq 'check') { $SkipRealTree = $true }
elseif ($Mode -eq 'mutate') { $WithMutations = $true; $SkipRealTree = $true }

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..\..')).Path }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$AppDir    = Join-Path $RepoRoot 'deploy\windows\installer\app'
$MainPy    = Join-Path $AppDir 'main.py'
$InstallPy = Join-Path $AppDir 'aidn\install.py'
$SetupPs1  = Join-Path $RepoRoot 'deploy\windows\installer\Setup.ps1'
$Python    = if ($env:AIDN_PYTHON) { $env:AIDN_PYTHON } else { 'D:\Python311\python.exe' }
$PwshExe   = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $PwshExe)) { $PwshExe = 'pwsh' }

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Base  = Join-Path $env:TEMP 'reattack-rc4-seed01'
$RunRoot = Join-Path $Base "run-$Stamp"
$CasesRoot = Join-Path $RunRoot 'cases'
if (-not $EvidenceDir) { $EvidenceDir = Join-Path $Base "evidence-$Stamp" }
New-Item -ItemType Directory -Force -Path $RunRoot, $CasesRoot, $EvidenceDir | Out-Null
$EvidenceDir = (Resolve-Path -LiteralPath $EvidenceDir).Path

$script:Results = New-Object System.Collections.ArrayList
$script:PythonLogs = New-Object System.Collections.ArrayList

function Write-Utf8 {
    param([string]$Path, [string]$Text)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-Bytes {
    param([string]$Path, [byte[]]$Bytes)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllBytes($Path, $Bytes)
}
function Get-Sha256File {
    param([string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-Sha256Text {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

# ---------------------------------------------------------------- tree snapshots
function Get-TreeSnapshot {
    param([string]$Root, [switch]$NoHash)
    $entries = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Root)) {
        return [pscustomobject]@{ Exists = $false; Digest = 'MISSING'; FileCount = 0; DirCount = 0; Entries = @() }
    }
    $dirs = New-Object System.Collections.ArrayList
    function Walk {
        param([string]$Dir, [string]$Rel)
        $items = @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction Stop)
        foreach ($it in $items) {
            $r = if ($Rel) { "$Rel/$($it.Name)" } else { $it.Name }
            $isReparse = [bool]($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
            if ($isReparse) {
                [void]$entries.Add("L|$r")
                continue
            }
            if ($it.PSIsContainer) {
                [void]$dirs.Add($r)
                Walk -Dir $it.FullName -Rel $r
            } else {
                $h = if ($NoHash) { "size=$($it.Length)" } else { Get-Sha256File $it.FullName }
                [void]$entries.Add("F|$r|$h")
            }
        }
    }
    Walk -Dir $Root -Rel ''
    $sorted = @($entries | Sort-Object) -join "`n"
    [pscustomobject]@{
        Exists    = $true
        Digest    = (Get-Sha256Text $sorted)
        FileCount = @($entries | Where-Object { $_ -like 'F|*' }).Count
        DirCount  = $dirs.Count
        Entries   = @($entries)
    }
}
function Get-SnapshotMany {
    param([string[]]$Paths)
    $map = @{}
    foreach ($p in $Paths) { $map[$p] = (Get-TreeSnapshot -Root $p).Digest }
    return $map
}
function Test-SameSnapshot {
    param($Before, $After)
    foreach ($key in $Before.Keys) {
        if ($Before[$key] -ne $After[$key]) { return $false }
    }
    return $true
}

# ---------------------------------------------------------------- target builders
function New-CaseDir {
    param([string]$Id)
    $d = Join-Path $CasesRoot $Id
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    return $d
}
function New-SentinelTree {
    param([string]$Target)
    New-Item -ItemType Directory -Force -Path (Join-Path $Target 'notes') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Target 'photos\2026') | Out-Null
    Write-Utf8 (Join-Path $Target 'notes\thesis.docx') "irreplaceable user document`n"
    Write-Utf8 (Join-Path $Target 'photos\2026\a.jpg') "jpeg-bytes`n"
    Write-Utf8 (Join-Path $Target 'top.txt') "top-level user file`n"
}
function Write-InstallJson {
    param([string]$Target, [hashtable]$Overrides = @{})
    $rec = [ordered]@{
        product     = 'AIDriven NetDefense'
        version     = '0.0.1-rc.4'
        installPath = $Target
        installedAt = '2026-11-05T00:00:00+08:00'
        desktopExe  = 'AIDrivenNetDefense.exe'
        entryKind   = 'exe'
        autostart   = $false
        upgradedFrom = $null
        channel     = 'installed'
    }
    foreach ($k in $Overrides.Keys) { $rec[$k] = $Overrides[$k] }
    Write-Utf8 (Join-Path $Target 'install\install.json') (($rec | ConvertTo-Json -Depth 4) + "`n")
}
function Write-FakeManifest {
    param([string]$Target, [string[]]$Paths = @(), [switch]$AllFake, [int]$FakeCount = 3)
    $rows = New-Object System.Collections.ArrayList
    if ($AllFake) {
        for ($i = 1; $i -le $FakeCount; $i++) {
            [void]$rows.Add(("a" * 64) + "  fake/path-$i.bin")
        }
    } else {
        foreach ($rel in $Paths) {
            $full = Join-Path $Target ($rel -replace '/', '\')
            [void]$rows.Add((Get-Sha256File $full) + "  " + $rel)
        }
    }
    Write-Utf8 (Join-Path $Target 'manifests\files.sha256') (($rows -join "`n") + "`n")
}
function New-GenuineTree {
    param([string]$Target)
    Write-Utf8 (Join-Path $Target 'AIDrivenNetDefense.exe') "MZ fixture shell`n"
    Write-Utf8 (Join-Path $Target 'runtime\node\node.exe') "fixture runtime placeholder`n"
    Write-Utf8 (Join-Path $Target 'console\index.html') "<!doctype html><title>fixture</title>`n"
    Write-FakeManifest -Target $Target -Paths @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html')
    Write-InstallJson -Target $Target
}
function New-BundleTree {
    param([string]$Target)
    Write-Utf8 (Join-Path $Target 'AIDrivenNetDefense.exe') "MZ fixture shell`n"
    Write-Utf8 (Join-Path $Target 'runtime\node\node.exe') "fixture runtime placeholder`n"
    Write-Utf8 (Join-Path $Target 'console\index.html') "<!doctype html><title>fixture</title>`n"
    Write-FakeManifest -Target $Target -Paths @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html')
    $bundle = [ordered]@{
        schemaVersion = '1.0'
        author        = 'PT-dove'
        kind          = 'packaging-poc'
        paths         = [ordered]@{ node = 'runtime/node/node.exe'; console = 'console/index.html' }
    }
    Write-Utf8 (Join-Path $Target 'bundle.json') (($bundle | ConvertTo-Json -Depth 4) + "`n")
}
function New-Junction {
    param([string]$Link, [string]$Target)
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
}

# ---------------------------------------------------------------- runners
function Invoke-PythonUninstall {
    param([string]$Target, [string]$CaseDir)
    $work = Join-Path $CaseDir 'work'
    $tmp  = Join-Path $work 'temp'
    New-Item -ItemType Directory -Force -Path $tmp, (Join-Path $work 'start-menu'), (Join-Path $work 'desktop') | Out-Null
    $saved = @{ TEMP = $env:TEMP; TMP = $env:TMP; AIDN_SETUP_STARTMENU_DIR = $env:AIDN_SETUP_STARTMENU_DIR; AIDN_SETUP_DESKTOP_DIR = $env:AIDN_SETUP_DESKTOP_DIR; PYTHONDONTWRITEBYTECODE = $env:PYTHONDONTWRITEBYTECODE; PYTHONIOENCODING = $env:PYTHONIOENCODING }
    $env:TEMP = $tmp; $env:TMP = $tmp
    $env:AIDN_SETUP_STARTMENU_DIR = Join-Path $work 'start-menu'
    $env:AIDN_SETUP_DESKTOP_DIR = Join-Path $work 'desktop'
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $command = "`"$Python`" `"$MainPy`" /uninstall /DIR=`"$Target`" /NOREG"
    Push-Location $AppDir
    try {
        $stdout = (& $Python $MainPy '/uninstall' "/DIR=$Target" '/NOREG' 2>&1 | Out-String)
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        foreach ($k in $saved.Keys) {
            if ($null -eq $saved[$k]) { Remove-Item -Path "env:$k" -ErrorAction SilentlyContinue } else { Set-Item -Path "env:$k" -Value $saved[$k] }
        }
    }
    $log = ''
    $logFile = Get-ChildItem -LiteralPath $tmp -Filter 'AIDriven-Setup-*.log' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($logFile) { $log = Get-Content -LiteralPath $logFile.FullName -Raw -Encoding UTF8 }
    return [pscustomobject]@{ Channel = 'python'; ExitCode = $code; Outcome = ''; Message = ''; Stdout = $stdout; Log = $log; Command = $command }
}

function Invoke-PsUninstall {
    param([string]$Target, [string]$CaseDir)
    $work = Join-Path $CaseDir 'work-ps'
    $tmp  = Join-Path $work 'temp'
    New-Item -ItemType Directory -Force -Path $tmp, (Join-Path $work 'start-menu'), (Join-Path $work 'desktop') | Out-Null
    $wrapper = Join-Path $work 'call.ps1'
    $resultFile = Join-Path $work 'result.json'
    Write-Utf8 $wrapper @'
$ErrorActionPreference = 'Stop'
$env:AIDN_SETUP_TEST_DOTSOURCE = '1'
. $env:SEED01_SETUP
$result = [ordered]@{ outcome = 'NO_THROW'; message = '' }
try {
    Uninstall-Target -Target $env:SEED01_TARGET -KeepData $false -SkipRegistry $true -OnStep $null
} catch {
    $result.outcome = 'THROW'
    $result.message = $_.Exception.Message
}
($result | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $env:SEED01_RESULT -Encoding UTF8
exit 0
'@
    $saved = @{ TEMP = $env:TEMP; TMP = $env:TMP; AIDN_SETUP_STARTMENU_DIR = $env:AIDN_SETUP_STARTMENU_DIR; AIDN_SETUP_DESKTOP_DIR = $env:AIDN_SETUP_DESKTOP_DIR; SEED01_SETUP = $env:SEED01_SETUP; SEED01_TARGET = $env:SEED01_TARGET; SEED01_RESULT = $env:SEED01_RESULT }
    $env:TEMP = $tmp; $env:TMP = $tmp
    $env:AIDN_SETUP_STARTMENU_DIR = Join-Path $work 'start-menu'
    $env:AIDN_SETUP_DESKTOP_DIR = Join-Path $work 'desktop'
    $env:SEED01_SETUP = $SetupPs1
    $env:SEED01_TARGET = $Target
    $env:SEED01_RESULT = $resultFile
    try {
        $stdout = (& $PwshExe -NoProfile -File $wrapper 2>&1 | Out-String)
        $code = $LASTEXITCODE
    } finally {
        foreach ($k in $saved.Keys) {
            if ($null -eq $saved[$k]) { Remove-Item -Path "env:$k" -ErrorAction SilentlyContinue } else { Set-Item -Path "env:$k" -Value $saved[$k] }
        }
    }
    $outcome = 'NO_RESULT'
    $message = ''
    if (Test-Path -LiteralPath $resultFile) {
        $r = Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $outcome = [string]$r.outcome
        $message = [string]$r.message
    }
    $log = ''
    $logFile = Get-ChildItem -LiteralPath $tmp -Filter 'AIDriven-Setup-*.log' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($logFile) { $log = Get-Content -LiteralPath $logFile.FullName -Raw -Encoding UTF8 }
    $command = "pwsh -NoProfile -File <wrapper>  # dot-source Setup.ps1 (AIDN_SETUP_TEST_DOTSOURCE=1); Uninstall-Target -Target `"$Target`" -KeepData `$false -SkipRegistry `$true -OnStep `$null"
    return [pscustomobject]@{ Channel = 'ps'; ExitCode = $code; Outcome = $outcome; Message = $message; Stdout = $stdout; Log = $log; Command = $command }
}

# ---------------------------------------------------------------- case recorder
function Add-Result {
    param(
        [string]$Id,
        [string]$Attack,
        [string]$Channel,
        [string]$Kind,
        [string]$Expect,
        $Run,
        [string]$Target,
        $Before,
        $After,
        [string]$Verdict,
        [string]$Notes = ''
    )
    $caseDir = Join-Path $EvidenceDir "cases\$Id"
    New-Item -ItemType Directory -Force -Path $caseDir | Out-Null
    $unchanged = Test-SameSnapshot -Before $Before -After $After
    $targetDeleted = ($After[$Target] -eq 'MISSING')
    $refused = (($Channel -eq 'python') -and ($Run.ExitCode -eq 5)) -or (($Channel -eq 'ps') -and ($Run.Outcome -eq 'THROW'))
    $meta = [ordered]@{
        id             = $Id
        attack         = $Attack
        channel        = $Channel
        kind           = $Kind
        expect         = $Expect
        command        = $Run.Command
        exitcode       = $Run.ExitCode
        ps_outcome     = $Run.Outcome
        refused        = $refused
        target         = $Target
        target_deleted = $targetDeleted
        tree_unchanged = $unchanged
        before         = $Before
        after          = $After
        verdict        = $Verdict
        notes          = $Notes
        evidence       = @()
    }
    Write-Utf8 (Join-Path $caseDir 'command.txt') ($Run.Command + "`n`nexitcode=" + $Run.ExitCode + "`nps_outcome=" + $Run.Outcome + "`n")
    Write-Utf8 (Join-Path $caseDir 'stdout.txt') ([string]$Run.Stdout)
    Write-Utf8 (Join-Path $caseDir 'log.txt') ([string]$Run.Log)
    Write-Utf8 (Join-Path $caseDir 'snapshot.json') (([ordered]@{ before = $Before; after = $After } | ConvertTo-Json -Depth 5))
    $meta.evidence = @(
        (Join-Path $caseDir 'command.txt'),
        (Join-Path $caseDir 'stdout.txt'),
        (Join-Path $caseDir 'log.txt'),
        (Join-Path $caseDir 'snapshot.json'),
        (Join-Path $caseDir 'meta.json')
    )
    Write-Utf8 (Join-Path $caseDir 'meta.json') (($meta | ConvertTo-Json -Depth 6))
    [void]$script:Results.Add([pscustomobject]$meta)
    $tag = switch ($Verdict) { 'CLOSED' { 'CLOSED ' } 'BYPASSED' { 'BYPASSED!' } default { $Verdict } }
    Write-Host ("[{0,-8}] {1,-32} {2,-6} exit={3,-4} ps={4,-9} unchanged={5,-5} deleted={6,-5} :: {7}" -f $tag, $Id, $Channel, $Run.ExitCode, $Run.Outcome, $unchanged, $targetDeleted, $Attack)
    return [pscustomobject]$meta
}

function Invoke-RefusalCase {
    param([string]$Id, [string]$Attack, [string]$Channel, [scriptblock]$Build, [string]$Expect = 'EXIT5/THROW')
    $caseDir = New-CaseDir $Id
    $b = & $Build $caseDir
    $target = [string]$b.Target
    $watch = @($target) + @($b.Watch)
    $before = Get-SnapshotMany -Paths $watch
    $run = if ($Channel -eq 'python') { Invoke-PythonUninstall -Target $target -CaseDir $caseDir } else { Invoke-PsUninstall -Target $target -CaseDir $caseDir }
    $after = Get-SnapshotMany -Paths $watch
    $refused = (($Channel -eq 'python') -and ($run.ExitCode -eq 5)) -or (($Channel -eq 'ps') -and ($run.Outcome -eq 'THROW'))
    $unchanged = Test-SameSnapshot -Before $before -After $after
    if ($refused -and $unchanged) { $verdict = 'CLOSED' }
    elseif (-not $unchanged) { $verdict = 'BYPASSED' }
    else { $verdict = 'unreproducible' }
    $note = ''
    if (-not $refused -and $unchanged) { $note = 'no refusal observed, but nothing was deleted' }
    if ($Channel -eq 'ps' -and $run.Outcome -eq 'THROW') { $note = ('refusal message: ' + $run.Message) }
    return Add-Result -Id $Id -Attack $Attack -Channel $Channel -Kind 'refusal' -Expect $Expect -Run $run -Target $target -Before $before -After $after -Verdict $verdict -Notes $note
}

# ---------------------------------------------------------------- preflight / drift
$driftFiles = @($MainPy, $InstallPy, $SetupPs1, (Join-Path $AppDir 'aidn\paths.py'), (Join-Path $AppDir 'aidn\procs.py'))
$driftBefore = @{}
foreach ($f in $driftFiles) { $driftBefore[$f] = Get-Sha256File $f }
$driftMtime = @{}
foreach ($f in $driftFiles) { $driftMtime[$f] = (Get-Item -LiteralPath $f).LastWriteTime.ToString("o") }
Write-Host "=== REATTACK-RC4 seed01 harness ==="
Write-Host "repo: $RepoRoot"
Write-Host "run root: $RunRoot"
Write-Host "evidence: $EvidenceDir"
foreach ($f in $driftFiles) { Write-Host ("sha256 {0}  {1}" -f $driftBefore[$f], (Split-Path -Leaf $f)) }

# ---------------------------------------------------------------- attack matrix: Python channel
Write-Host "`n=== A. Python uninstaller: forged / hostile targets ==="

Invoke-RefusalCase -Id 'py-01-random-dir' -Channel 'python' -Attack 'arbitrary non-empty user dir, no markers' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'py-02-installjson-only' -Channel 'python' -Attack 'forged install.json (all identity fields), no manifests' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    Write-InstallJson -Target $t
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'py-03-installjson-empty-manifest' -Channel 'python' -Attack 'forged install.json + empty manifests/files.sha256' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    Write-InstallJson -Target $t
    Write-Utf8 (Join-Path $t 'manifests\files.sha256') ''
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'py-04-installjson-fake-manifest' -Channel 'python' -Attack 'forged install.json + manifest with 3 all-fake sha rows' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    Write-InstallJson -Target $t
    Write-FakeManifest -Target $t -AllFake -FakeCount 3
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'py-05-fake-bundle' -Channel 'python' -Attack 'forged bundle.json (product/version/schema 1.0) + all-fake manifest' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'looks-like-payload'
    New-SentinelTree $t
    $bundle = [ordered]@{ schemaVersion = '1.0'; product = 'AIDriven NetDefense'; version = '0.0.1-rc.4'; installPath = $t }
    Write-Utf8 (Join-Path $t 'bundle.json') (($bundle | ConvertTo-Json) + "`n")
    Write-FakeManifest -Target $t -AllFake -FakeCount 3
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'py-06-two-empty-files' -Channel 'python' -Attack 'N-011 X-03: two empty files impersonating install markers' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    Write-Utf8 (Join-Path $t 'install\install.json') ''
    Write-Utf8 (Join-Path $t 'manifests\files.sha256') ''
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'py-07-bundle-no-manifests' -Channel 'python' -Attack 'half set: bundle.json only, no manifests' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'looks-like-payload'
    New-SentinelTree $t
    $bundle = [ordered]@{ schemaVersion = '1.0'; product = 'AIDriven NetDefense'; version = '0.0.1-rc.4' }
    Write-Utf8 (Join-Path $t 'bundle.json') (($bundle | ConvertTo-Json) + "`n")
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'py-08-manifest-missing-files' -Channel 'python' -Attack 'half set: manifest rows point at files that do not exist' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'looks-like-payload'
    New-SentinelTree $t
    $bundle = [ordered]@{ schemaVersion = '1.0'; product = 'AIDriven NetDefense'; version = '0.0.1-rc.4' }
    Write-Utf8 (Join-Path $t 'bundle.json') (($bundle | ConvertTo-Json) + "`n")
    $rows = @()
    foreach ($i in 1..3) { $rows += (('b' * 64) + "  missing/file-$i.bin") }
    Write-Utf8 (Join-Path $t 'manifests\files.sha256') (($rows -join "`n") + "`n")
    @{ Target = $t; Watch = @() }
} | Out-Null

# target itself is a junction
$caseDir = New-CaseDir 'py-09-target-junction'
$victim = Join-Path $caseDir 'victim'
New-SentinelTree $victim
$link = Join-Path $caseDir 'link-to-victim'
New-Junction -Link $link -Target $victim
$before = Get-SnapshotMany -Paths @($victim)
$run = Invoke-PythonUninstall -Target $link -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($victim)
$victimUnchanged = Test-SameSnapshot -Before $before -After $after
$linkAlive = Test-Path -LiteralPath $link
Add-Result -Id 'py-09-target-junction' -Attack 'target itself is a junction to a user directory' -Channel 'python' -Kind 'refusal' -Expect 'EXIT5 + victim intact' -Run $run -Target $link -Before $before -After $after -Verdict $(if ($run.ExitCode -eq 5 -and $victimUnchanged -and $linkAlive) { 'CLOSED' } elseif (-not $victimUnchanged) { 'BYPASSED' } else { 'unreproducible' }) -Notes ("victim_unchanged=$victimUnchanged link_alive=$linkAlive") | Out-Null

# target reached through a parent junction
$caseDir = New-CaseDir 'py-10-parent-junction'
$realParent = Join-Path $caseDir 'real-parent'
$realTree = Join-Path $realParent 'tree'
New-SentinelTree $realTree
$linkParent = Join-Path $caseDir 'link-parent'
New-Junction -Link $linkParent -Target $realParent
$typed = Join-Path $linkParent 'tree'
$before = Get-SnapshotMany -Paths @($realTree)
$run = Invoke-PythonUninstall -Target $typed -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($realTree)
$victimUnchanged = Test-SameSnapshot -Before $before -After $after
Add-Result -Id 'py-10-parent-junction' -Attack 'target path contains a junction in a parent directory' -Channel 'python' -Kind 'refusal' -Expect 'EXIT5 + real tree intact' -Run $run -Target $realTree -Before $before -After $after -Verdict $(if ($run.ExitCode -eq 5 -and $victimUnchanged) { 'CLOSED' } elseif (-not $victimUnchanged) { 'BYPASSED' } else { 'unreproducible' }) -Notes ("real_tree_unchanged=$victimUnchanged") | Out-Null

# target contains an internal junction pointing outside
$caseDir = New-CaseDir 'py-11-internal-junction'
$victim = Join-Path $caseDir 'victim'
New-SentinelTree $victim
$tree = Join-Path $caseDir 'AIDriven NetDefense'
New-GenuineTree $tree
New-Junction -Link (Join-Path $tree 'stuck-junction') -Target $victim
$beforeVictim = Get-SnapshotMany -Paths @($victim)
$beforeTree = Get-TreeSnapshot -Root $tree
$run = Invoke-PythonUninstall -Target $tree -CaseDir $caseDir
$afterVictim = Get-SnapshotMany -Paths @($victim)
$afterTree = Get-TreeSnapshot -Root $tree
$victimUnchanged = Test-SameSnapshot -Before $beforeVictim -After $afterVictim
$verdict = if (-not $victimUnchanged) { 'BYPASSED' } else { 'CLOSED' }
Add-Result -Id 'py-11-internal-junction' -Attack 'genuine tree contains a junction to an outside directory' -Channel 'python' -Kind 'penetration' -Expect 'no deletion outside the target' -Run $run -Target $tree -Before @{ tree = $beforeTree.Digest; victim = $beforeVictim[$victim] } -After @{ tree = $afterTree.Digest; victim = $afterVictim[$victim] } -Verdict $verdict -Notes ("victim_unchanged=$victimUnchanged tree_exists_after=$(Test-Path -LiteralPath $tree) junction_alive=$(Test-Path -LiteralPath (Join-Path $tree 'stuck-junction')) exit=$($run.ExitCode)") | Out-Null

# empty directory
$caseDir = New-CaseDir 'py-12-empty-dir'
$empty = Join-Path $caseDir 'empty'
New-Item -ItemType Directory -Force -Path $empty | Out-Null
$before = Get-SnapshotMany -Paths @($empty)
$run = Invoke-PythonUninstall -Target $empty -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($empty)
$deleted = ($after[$empty] -eq 'MISSING')
Add-Result -Id 'py-12-empty-dir' -Attack 'empty directory (no data to lose)' -Channel 'python' -Kind 'design' -Expect 'design-allowed: removed, exit 0' -Run $run -Target $empty -Before $before -After $after -Verdict $(if ($run.ExitCode -eq 0 -and $deleted) { 'CLOSED' } else { 'unreproducible' }) -Notes ("deleted=$deleted (documented empty-dir exception)") | Out-Null

# 8.3 short name
$caseDir = New-CaseDir 'py-13-shortname'
$longDir = Join-Path $caseDir 'LongDirectoryNameForShortName'
New-SentinelTree $longDir
$shortPath = (& cmd.exe /c "for %I in (`"$longDir`") do @echo %~sI" 2>&1 | Out-String).Trim()
$before = Get-SnapshotMany -Paths @($longDir)
$run = Invoke-PythonUninstall -Target $shortPath -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($longDir)
$unchanged = Test-SameSnapshot -Before $before -After $after
Add-Result -Id 'py-13-shortname' -Attack '8.3 short name path to a user dir' -Channel 'python' -Kind 'refusal' -Expect 'refused, tree intact' -Run $run -Target $longDir -Before $before -After $after -Verdict $(if ($unchanged -and $run.ExitCode -ne 0) { 'CLOSED' } elseif (-not $unchanged) { 'BYPASSED' } else { 'unreproducible' }) -Notes ("short_path=$shortPath exit=$($run.ExitCode) unchanged=$unchanged") | Out-Null

# lexical .. path
$caseDir = New-CaseDir 'py-14-dotdot-path'
$fake = Join-Path $caseDir 'fake'
New-SentinelTree $fake
$typed = Join-Path $caseDir 'a\..\fake'
$before = Get-SnapshotMany -Paths @($fake)
$run = Invoke-PythonUninstall -Target $typed -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($fake)
$unchanged = Test-SameSnapshot -Before $before -After $after
Add-Result -Id 'py-14-dotdot-path' -Attack '/DIR with lexical .. segments resolving to a user dir' -Channel 'python' -Kind 'refusal' -Expect 'refused, tree intact' -Run $run -Target $fake -Before $before -After $after -Verdict $(if ($unchanged -and $run.ExitCode -eq 5) { 'CLOSED' } elseif (-not $unchanged) { 'BYPASSED' } else { 'unreproducible' }) -Notes ("exit=$($run.ExitCode) unchanged=$unchanged") | Out-Null

# extended-length prefix (defense-in-depth probe: validate_target bypass, ownership gate should hold)
$caseDir = New-CaseDir 'py-15-extended-path'
$fake = Join-Path $caseDir 'fake'
New-SentinelTree $fake
$typed = '\\?\' + $fake
$before = Get-SnapshotMany -Paths @($fake)
$run = Invoke-PythonUninstall -Target $typed -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($fake)
$unchanged = Test-SameSnapshot -Before $before -After $after
Add-Result -Id 'py-15-extended-path' -Attack 'extended-length \\?\ path to a user dir (validate_target bypass probe)' -Channel 'python' -Kind 'refusal' -Expect 'refused by ownership gate; tree intact' -Run $run -Target $fake -Before $before -After $after -Verdict $(if ($unchanged -and $run.ExitCode -eq 5) { 'CLOSED' } elseif (-not $unchanged) { 'BYPASSED' } else { 'unreproducible' }) -Notes ("typed=$typed exit=$($run.ExitCode) unchanged=$unchanged; validate_target bypass recorded separately in unit-probes") | Out-Null

# boundary probe: self-consistent forged marker around real user files
$caseDir = New-CaseDir 'py-16-selfconsistent-forgery'
$t = Join-Path $caseDir 'my-notes'
New-SentinelTree $t
Write-InstallJson -Target $t
Write-FakeManifest -Target $t -Paths @('notes/thesis.docx', 'photos/2026/a.jpg', 'top.txt')
$before = Get-SnapshotMany -Paths @($t)
$run = Invoke-PythonUninstall -Target $t -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($t)
$deleted = ($after[$t] -eq 'MISSING')
Add-Result -Id 'py-16-selfconsistent-forgery' -Attack 'BOUNDARY: forged install.json + manifest whose rows hash the victim files themselves' -Channel 'python' -Kind 'boundary' -Expect 'guard cannot distinguish self-certified tree' -Run $run -Target $t -Before $before -After $after -Verdict $(if ($deleted) { 'BYPASSED' } else { 'CLOSED' }) -Notes ("deleted=$deleted exit=$($run.ExitCode); by-design self-certification (fix-wave tests use the same shape as their positive fixture); requires write access to the target") | Out-Null

# boundary probe: fake rows in the middle (sampling)
$caseDir = New-CaseDir 'py-17-manifest-filler'
$t = Join-Path $caseDir 'AIDriven NetDefense'
New-GenuineTree $t
$realRows = @()
foreach ($rel in @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html')) {
    $realRows += ((Get-Sha256File (Join-Path $t ($rel -replace '/', '\'))) + "  $rel")
}
$rows = New-Object System.Collections.ArrayList
$rows.AddRange($realRows[0..0])
$rows.AddRange($realRows[1..1])
$rows.AddRange($realRows[2..2])
for ($i = 1; $i -le 60; $i++) { [void]$rows.Add((('c' * 64) + "  filler/fake-$i.bin")) }
for ($i = 0; $i -lt 3; $i++) { [void]$rows.Add($realRows[$i] + '') }
# re-write with first 3 real, 60 fake, last 3 real
$rows = New-Object System.Collections.ArrayList
foreach ($r in $realRows) { [void]$rows.Add($r) }
for ($i = 1; $i -le 60; $i++) { [void]$rows.Add((('c' * 64) + "  filler/fake-$i.bin")) }
foreach ($r in $realRows) { [void]$rows.Add($r) }
Write-Utf8 (Join-Path $t 'manifests\files.sha256') (($rows -join "`n") + "`n")
$before = Get-SnapshotMany -Paths @($t)
$run = Invoke-PythonUninstall -Target $t -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($t)
$deleted = ($after[$t] -eq 'MISSING')
Add-Result -Id 'py-17-manifest-filler' -Attack 'BOUNDARY: 60 all-fake manifest rows between the sampled first/last 3 real rows' -Channel 'python' -Kind 'boundary' -Expect 'sampling documented; fake middle rows are never checked' -Run $run -Target $t -Before $before -After $after -Verdict $(if ($deleted) { 'BYPASSED' } else { 'CLOSED' }) -Notes ("deleted=$deleted exit=$($run.ExitCode); documented bounded sampling, no outside data touched") | Out-Null

# positive control: genuine-looking install tree
$caseDir = New-CaseDir 'py-18-genuine-tree'
$t = Join-Path $caseDir 'AIDriven NetDefense'
New-GenuineTree $t
$before = Get-SnapshotMany -Paths @($t)
$run = Invoke-PythonUninstall -Target $t -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($t)
$deleted = ($after[$t] -eq 'MISSING')
Add-Result -Id 'py-18-genuine-tree' -Attack 'POSITIVE: self-consistent genuine install tree must still be removable' -Channel 'python' -Kind 'positive' -Expect 'exit 0 + tree removed' -Run $run -Target $t -Before $before -After $after -Verdict $(if ($run.ExitCode -eq 0 -and $deleted) { 'CLOSED' } else { 'unreproducible' }) -Notes ("deleted=$deleted exit=$($run.ExitCode)") | Out-Null

# positive control: real release payload tree copy (dist/bundle/win32-x64-v16)
if (-not $SkipRealTree) {
    $caseDir = New-CaseDir 'py-19-real-bundle'
    $src = Join-Path $RepoRoot 'dist\bundle\win32-x64-v16'
    $dst = Join-Path $caseDir 'AIDriven NetDefense'
    if (-not (Test-Path -LiteralPath (Join-Path $src 'bundle.json'))) {
        Write-Host "[SKIP    ] py-19-real-bundle  source bundle missing"
    } else {
        $copyTimer = [System.Diagnostics.Stopwatch]::StartNew()
        $null = robocopy.exe $src $dst /E /MT:16 /NFL /NDL /NJH /NJS /NP /R:1 /W:1 2>&1
        $copyTimer.Stop()
        $fileCount = @([System.IO.Directory]::EnumerateFiles($dst, '*', [System.IO.SearchOption]::AllDirectories)).Count
        $bytes = (Get-ChildItem -LiteralPath $dst -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        $before = @{ $dst = "count=$fileCount;bytes=$bytes" }
        $runTimer = [System.Diagnostics.Stopwatch]::StartNew()
        $run = Invoke-PythonUninstall -Target $dst -CaseDir $caseDir
        $runTimer.Stop()
        $deleted = -not (Test-Path -LiteralPath $dst)
        $after = @{ $dst = $(if ($deleted) { 'MISSING' } else { 'PRESENT' }) }
        Add-Result -Id 'py-19-real-bundle' -Attack 'POSITIVE: real 0.0.1-rc.4 payload tree copied from dist/bundle/win32-x64-v16' -Channel 'python' -Kind 'positive' -Expect 'exit 0 + tree removed' -Run $run -Target $dst -Before $before -After $after -Verdict $(if ($run.ExitCode -eq 0 -and $deleted) { 'CLOSED' } else { 'unreproducible' }) -Notes ("deleted=$deleted exit=$($run.ExitCode) copy=$([math]::Round($copyTimer.Elapsed.TotalSeconds,1))s run=$([math]::Round($runTimer.Elapsed.TotalSeconds,1))s files=$fileCount bytes=$bytes") | Out-Null
        if (Test-Path -LiteralPath $dst) {
            Write-Host "[cleanup ] py-19-real-bundle target still present; removing copy"
            Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---------------------------------------------------------------- attack matrix: PowerShell channel
Write-Host "`n=== B. Setup.ps1 Uninstall-Target (dot-sourced): forged / hostile targets ==="

Invoke-RefusalCase -Id 'ps-01-random-dir' -Channel 'ps' -Attack 'arbitrary non-empty user dir, no markers' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'ps-02-installjson-only' -Channel 'ps' -Attack 'forged install.json (all identity fields), no manifests' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    Write-InstallJson -Target $t
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'ps-03-installjson-empty-manifest' -Channel 'ps' -Attack 'forged install.json + empty manifests/files.sha256' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    Write-InstallJson -Target $t
    Write-Utf8 (Join-Path $t 'manifests\files.sha256') ''
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'ps-04-installjson-fake-manifest' -Channel 'ps' -Attack 'forged install.json + manifest with 3 all-fake sha rows' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    Write-InstallJson -Target $t
    Write-FakeManifest -Target $t -AllFake -FakeCount 3
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'ps-05-fake-bundle' -Channel 'ps' -Attack 'forged bundle.json (product/version/schema 1.0) + all-fake manifest' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'looks-like-payload'
    New-SentinelTree $t
    $bundle = [ordered]@{ schemaVersion = '1.0'; product = 'AIDriven NetDefense'; version = '0.0.1-rc.4' }
    Write-Utf8 (Join-Path $t 'bundle.json') (($bundle | ConvertTo-Json) + "`n")
    Write-FakeManifest -Target $t -AllFake -FakeCount 3
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'ps-06-two-empty-files' -Channel 'ps' -Attack 'N-011 X-03: two empty files impersonating install markers' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'my-notes'
    New-SentinelTree $t
    Write-Utf8 (Join-Path $t 'install\install.json') ''
    Write-Utf8 (Join-Path $t 'manifests\files.sha256') ''
    @{ Target = $t; Watch = @() }
} | Out-Null

Invoke-RefusalCase -Id 'ps-07-bundle-no-manifests' -Channel 'ps' -Attack 'half set: bundle.json only, no manifests' -Build {
    param($caseDir)
    $t = Join-Path $caseDir 'looks-like-payload'
    New-SentinelTree $t
    $bundle = [ordered]@{ schemaVersion = '1.0'; product = 'AIDriven NetDefense'; version = '0.0.1-rc.4' }
    Write-Utf8 (Join-Path $t 'bundle.json') (($bundle | ConvertTo-Json) + "`n")
    @{ Target = $t; Watch = @() }
} | Out-Null

# target itself is a junction
$caseDir = New-CaseDir 'ps-08-target-junction'
$victim = Join-Path $caseDir 'victim'
New-SentinelTree $victim
$link = Join-Path $caseDir 'link-to-victim'
New-Junction -Link $link -Target $victim
$before = Get-SnapshotMany -Paths @($victim)
$run = Invoke-PsUninstall -Target $link -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($victim)
$victimUnchanged = Test-SameSnapshot -Before $before -After $after
$linkAlive = Test-Path -LiteralPath $link
Add-Result -Id 'ps-08-target-junction' -Attack 'target itself is a junction to a user directory' -Channel 'ps' -Kind 'refusal' -Expect 'throw + victim intact' -Run $run -Target $link -Before $before -After $after -Verdict $(if ($run.Outcome -eq 'THROW' -and $victimUnchanged -and $linkAlive) { 'CLOSED' } elseif (-not $victimUnchanged) { 'BYPASSED' } else { 'unreproducible' }) -Notes ("victim_unchanged=$victimUnchanged link_alive=$linkAlive") | Out-Null

# target contains an internal junction pointing outside
$caseDir = New-CaseDir 'ps-09-internal-junction'
$victim = Join-Path $caseDir 'victim'
New-SentinelTree $victim
$tree = Join-Path $caseDir 'AIDriven NetDefense'
New-GenuineTree $tree
New-Junction -Link (Join-Path $tree 'stuck-junction') -Target $victim
$beforeVictim = Get-SnapshotMany -Paths @($victim)
$beforeTree = Get-TreeSnapshot -Root $tree
$run = Invoke-PsUninstall -Target $tree -CaseDir $caseDir
$afterVictim = Get-SnapshotMany -Paths @($victim)
$afterTree = Get-TreeSnapshot -Root $tree
$victimUnchanged = Test-SameSnapshot -Before $beforeVictim -After $afterVictim
Add-Result -Id 'ps-09-internal-junction' -Attack 'genuine tree contains a junction to an outside directory' -Channel 'ps' -Kind 'penetration' -Expect 'no deletion outside the target' -Run $run -Target $tree -Before @{ tree = $beforeTree.Digest; victim = $beforeVictim[$victim] } -After @{ tree = $afterTree.Digest; victim = $afterVictim[$victim] } -Verdict $(if (-not $victimUnchanged) { 'BYPASSED' } else { 'CLOSED' }) -Notes ("victim_unchanged=$victimUnchanged tree_exists_after=$(Test-Path -LiteralPath $tree) junction_alive=$(Test-Path -LiteralPath (Join-Path $tree 'stuck-junction')) outcome=$($run.Outcome)") | Out-Null

# parent junction + genuine bundle tree (PS has no realpath check)
$caseDir = New-CaseDir 'ps-10-parent-junction'
$realParent = Join-Path $caseDir 'real-parent'
$realTree = Join-Path $realParent 'AIDriven NetDefense'
New-BundleTree $realTree
$linkParent = Join-Path $caseDir 'link-parent'
New-Junction -Link $linkParent -Target $realParent
$typed = Join-Path $linkParent 'AIDriven NetDefense'
$before = Get-SnapshotMany -Paths @($realTree)
$run = Invoke-PsUninstall -Target $typed -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($realTree)
$realTreeDeleted = ($after[$realTree] -eq 'MISSING')
Add-Result -Id 'ps-10-parent-junction' -Attack 'genuine bundle tree reached through a parent junction (no realpath guard in PS)' -Channel 'ps' -Kind 'consistency' -Expect 'observed; compare with Python link_reason refusal' -Run $run -Target $realTree -Before $before -After $after -Verdict 'CLOSED' -Notes ("real_tree_deleted=$realTreeDeleted outcome=$($run.Outcome); PS has no equivalent of install.py::_link_reason; no non-owned data involved") | Out-Null

# empty directory
$caseDir = New-CaseDir 'ps-11-empty-dir'
$empty = Join-Path $caseDir 'empty'
New-Item -ItemType Directory -Force -Path $empty | Out-Null
$before = Get-SnapshotMany -Paths @($empty)
$run = Invoke-PsUninstall -Target $empty -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($empty)
$deleted = ($after[$empty] -eq 'MISSING')
Add-Result -Id 'ps-11-empty-dir' -Attack 'empty directory (no data to lose)' -Channel 'ps' -Kind 'design' -Expect 'design-allowed: removed, no throw' -Run $run -Target $empty -Before $before -After $after -Verdict $(if ($run.Outcome -eq 'NO_THROW' -and $deleted) { 'CLOSED' } else { 'unreproducible' }) -Notes ("deleted=$deleted outcome=$($run.Outcome) (documented empty-dir exception)") | Out-Null

# positive control: genuine tree
$caseDir = New-CaseDir 'ps-12-genuine-tree'
$t = Join-Path $caseDir 'AIDriven NetDefense'
New-GenuineTree $t
$before = Get-SnapshotMany -Paths @($t)
$run = Invoke-PsUninstall -Target $t -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($t)
$deleted = ($after[$t] -eq 'MISSING')
Add-Result -Id 'ps-12-genuine-tree' -Attack 'POSITIVE: self-consistent genuine install tree must still be removable' -Channel 'ps' -Kind 'positive' -Expect 'no throw + tree removed' -Run $run -Target $t -Before $before -After $after -Verdict $(if ($run.Outcome -eq 'NO_THROW' -and $deleted) { 'CLOSED' } else { 'unreproducible' }) -Notes ("deleted=$deleted outcome=$($run.Outcome)") | Out-Null

# boundary probe: self-consistent forged marker around real user files (PowerShell channel)
$caseDir = New-CaseDir 'ps-14-selfconsistent-forgery'
$t = Join-Path $caseDir 'my-notes'
New-SentinelTree $t
Write-InstallJson -Target $t
Write-FakeManifest -Target $t -Paths @('notes/thesis.docx', 'photos/2026/a.jpg', 'top.txt')
$before = Get-SnapshotMany -Paths @($t)
$run = Invoke-PsUninstall -Target $t -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($t)
$deleted = ($after[$t] -eq 'MISSING')
Add-Result -Id 'ps-14-selfconsistent-forgery' -Attack 'BOUNDARY: forged install.json + manifest whose rows hash the victim files themselves' -Channel 'ps' -Kind 'boundary' -Expect 'guard cannot distinguish self-certified tree' -Run $run -Target $t -Before $before -After $after -Verdict $(if ($deleted) { 'BYPASSED' } else { 'CLOSED' }) -Notes ("deleted=$deleted outcome=$($run.Outcome); same self-certification shape as the Python boundary case and as the fix-wave positive fixture; requires write access to the target") | Out-Null

# boundary probe: fake rows in the middle (sampling), PowerShell channel
$caseDir = New-CaseDir 'ps-15-manifest-filler'
$t = Join-Path $caseDir 'AIDriven NetDefense'
New-GenuineTree $t
$realRows = @()
foreach ($rel in @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html')) {
    $realRows += ((Get-Sha256File (Join-Path $t ($rel -replace '/', '\'))) + "  $rel")
}
$rows = New-Object System.Collections.ArrayList
foreach ($r in $realRows) { [void]$rows.Add($r) }
for ($i = 1; $i -le 60; $i++) { [void]$rows.Add((('c' * 64) + "  filler/fake-$i.bin")) }
foreach ($r in $realRows) { [void]$rows.Add($r) }
Write-Utf8 (Join-Path $t 'manifests\files.sha256') (($rows -join "`n") + "`n")
$before = Get-SnapshotMany -Paths @($t)
$run = Invoke-PsUninstall -Target $t -CaseDir $caseDir
$after = Get-SnapshotMany -Paths @($t)
$deleted = ($after[$t] -eq 'MISSING')
Add-Result -Id 'ps-15-manifest-filler' -Attack 'BOUNDARY: 60 all-fake manifest rows between the sampled first/last 3 real rows' -Channel 'ps' -Kind 'boundary' -Expect 'sampling documented; fake middle rows are never checked' -Run $run -Target $t -Before $before -After $after -Verdict $(if ($deleted) { 'BYPASSED' } else { 'CLOSED' }) -Notes ("deleted=$deleted outcome=$($run.Outcome); documented bounded sampling, no outside data touched") | Out-Null

# silent-mode contract: production entry powershell.exe 5.1, any throw -> exit 1
$caseDir = New-CaseDir 'ps-13-silent-exit-code'
$fake = Join-Path $caseDir 'my-notes'
New-SentinelTree $fake
$work = Join-Path $caseDir 'work'
$tmp = Join-Path $work 'temp'
New-Item -ItemType Directory -Force -Path $tmp, (Join-Path $work 'start-menu'), (Join-Path $work 'desktop') | Out-Null
$saved = @{ TEMP = $env:TEMP; TMP = $env:TMP; AIDN_SETUP_STARTMENU_DIR = $env:AIDN_SETUP_STARTMENU_DIR; AIDN_SETUP_DESKTOP_DIR = $env:AIDN_SETUP_DESKTOP_DIR }
$env:TEMP = $tmp; $env:TMP = $tmp
$env:AIDN_SETUP_STARTMENU_DIR = Join-Path $work 'start-menu'
$env:AIDN_SETUP_DESKTOP_DIR = Join-Path $work 'desktop'
$before = Get-SnapshotMany -Paths @($fake)
$silentOut = ''
$silentCode = -1
try {
    $silentOut = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SetupPs1 '/S' '/uninstall' "/DIR=$fake" '/NOREG' 2>&1 | Out-String)
    $silentCode = $LASTEXITCODE
} finally {
    foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { Remove-Item -Path "env:$k" -ErrorAction SilentlyContinue } else { Set-Item -Path "env:$k" -Value $saved[$k] } }
}
$after = Get-SnapshotMany -Paths @($fake)
$unchanged = Test-SameSnapshot -Before $before -After $after
$run = [pscustomobject]@{ Channel = 'ps'; ExitCode = $silentCode; Outcome = ''; Message = ''; Stdout = $silentOut; Log = ''; Command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File Setup.ps1 /S /uninstall /DIR=`"$fake`" /NOREG" }
Add-Result -Id 'ps-13-silent-exit-code' -Attack 'silent mode: refused uninstall must expose a stable automation exit code' -Channel 'ps' -Kind 'contract' -Expect 'P2: throw -> exit 1, not EXIT_TARGET_INVALID=5' -Run $run -Target $fake -Before $before -After $after -Verdict $(if ($unchanged -and $silentCode -ne 0) { 'CLOSED' } elseif (-not $unchanged) { 'BYPASSED' } else { 'unreproducible' }) -Notes ("silent_exit_code=$silentCode tree_unchanged=$unchanged; Python channel uses 5, PS channel uses 1 -> automation contract inconsistency (P2)") | Out-Null

# ---------------------------------------------------------------- unit probes (Python)
if (-not $SkipUnitProbes) {
    Write-Host "`n=== C. Unit probes (path validation / manifest proof) ==="
    $probeDir = Join-Path $EvidenceDir 'unit-probes'
    New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
    $pyProbe = Join-Path $Base 'probe-python.py'
    Write-Utf8 $pyProbe @'
import hashlib, json, os, shutil, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from aidn import paths, install

out = {"validate_target": [], "manifest": [], "manifest_path_safe": [], "notes": []}
BS = chr(92)

def p(*parts):
    return BS.join(parts)

cases = [
    "C:" + BS, "C:", "C:" + BS + "Windows", "c:" + BS + "WINDOWS" + BS + "Temp" + BS + "x",
    "C:" + BS + "Windows" + BS + "Temp" + BS + ".." + BS + ".." + BS + "Temp" + BS + "x",
    "C:" + BS + "Windows." + BS + "Temp" + BS + "evil",
    BS + BS + "?" + BS + "C:" + BS + "Windows" + BS + "Temp" + BS + "evil",
    BS + BS + "?" + BS + "C:" + BS,
    BS + BS + "localhost" + BS + "C$" + BS + "Windows" + BS + "Temp" + BS + "evil",
    "C:" + BS + "PROGRA~1" + BS + "evil",
    "C:" + BS + "WindowsX" + BS + "evil",
]
for raw in cases:
    try:
        n = str(paths.normalise(raw))
    except Exception as e:
        n = "<raised %s>" % e
    try:
        v = paths.validate_target(str(n))
    except Exception as e:
        v = "<raised %s>" % e
    try:
        rp = os.path.realpath(raw)
    except Exception as e:
        rp = "<raised %s>" % e
    out["validate_target"].append({"raw": raw, "normalised": n, "validate": v, "realpath": rp})

base = Path(sys.argv[2])
shutil.rmtree(base, ignore_errors=True)
base.mkdir(parents=True, exist_ok=True)

def tree(name, files):
    root = base / name
    root.mkdir(parents=True)
    for rel, data in files.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
    return root

def manifest(root, rows):
    (root / "manifests").mkdir(parents=True, exist_ok=True)
    (root / "manifests" / "files.sha256").write_bytes(("\n".join(rows) + "\n").encode("utf-8"))

def h(root, rel):
    return hashlib.sha256((root / rel).read_bytes()).hexdigest()

payload = {"AIDrivenNetDefense.exe": b"MZ fixture\n", "runtime/node/node.exe": b"node fixture\n", "console/index.html": b"<html>\n"}

# shape matrix
r = tree("m-empty", payload)
manifest(r, [])
out["manifest"].append({"case": "empty", "rows": 0, "has_rows": install._manifest_has_rows(r)})

r = tree("m-header", payload)
manifest(r, ["# header only", ""])
out["manifest"].append({"case": "header-only", "rows": 0, "has_rows": install._manifest_has_rows(r)})

r = tree("m-one-fake", payload)
manifest(r, ["a" * 64 + "  AIDrivenNetDefense.exe"])
out["manifest"].append({"case": "one-fake-row", "rows": 1, "has_rows": install._manifest_has_rows(r)})

r = tree("m-three-fake", payload)
manifest(r, ["a" * 64 + "  AIDrivenNetDefense.exe", "b" * 64 + "  runtime/node/node.exe", "c" * 64 + "  console/index.html"])
out["manifest"].append({"case": "three-fake-rows", "rows": 3, "has_rows": install._manifest_has_rows(r)})

r = tree("m-three-real", payload)
manifest(r, [h(r, "AIDrivenNetDefense.exe") + "  AIDrivenNetDefense.exe", h(r, "runtime/node/node.exe") + "  runtime/node/node.exe", h(r, "console/index.html") + "  console/index.html"])
out["manifest"].append({"case": "three-real-rows", "rows": 3, "has_rows": install._manifest_has_rows(r)})

r = tree("m-real-bom", payload)
manifest(r, [h(r, "AIDrivenNetDefense.exe") + "  AIDrivenNetDefense.exe", h(r, "runtime/node/node.exe") + "  runtime/node/node.exe", h(r, "console/index.html") + "  console/index.html"])
raw = (r / "manifests" / "files.sha256").read_bytes()
(r / "manifests" / "files.sha256").write_bytes(b"\xef\xbb\xbf" + raw)
out["manifest"].append({"case": "real-rows-with-BOM", "rows": 3, "has_rows": install._manifest_has_rows(r)})

r = tree("m-real-crlf", payload)
rows = [h(r, "AIDrivenNetDefense.exe") + "  AIDrivenNetDefense.exe", h(r, "runtime/node/node.exe") + "  runtime/node/node.exe", h(r, "console/index.html") + "  console/index.html"]
(r / "manifests").mkdir(parents=True, exist_ok=True)
(r / "manifests" / "files.sha256").write_bytes(("\r\n".join(rows) + "\r\n").encode("utf-8"))
out["manifest"].append({"case": "real-rows-CRLF", "rows": 3, "has_rows": install._manifest_has_rows(r)})

r = tree("m-traversal", payload)
manifest(r, [h(r, "AIDrivenNetDefense.exe") + "  .." + BS + "outside.txt", h(r, "runtime/node/node.exe") + "  runtime/node/node.exe", h(r, "console/index.html") + "  console/index.html"])
out["manifest"].append({"case": "traversal-row", "rows": 3, "has_rows": install._manifest_has_rows(r)})

r = tree("m-absolute", payload)
manifest(r, [h(r, "AIDrivenNetDefense.exe") + "  C:" + BS + "Windows" + BS + "System32" + BS + "cmd.exe", h(r, "runtime/node/node.exe") + "  runtime/node/node.exe", h(r, "console/index.html") + "  console/index.html"])
out["manifest"].append({"case": "absolute-row", "rows": 3, "has_rows": install._manifest_has_rows(r)})

r = tree("m-dotdot-space", payload)
manifest(r, [h(r, "AIDrivenNetDefense.exe") + "  .. " + BS + "outside.txt", h(r, "runtime/node/node.exe") + "  runtime/node/node.exe", h(r, "console/index.html") + "  console/index.html"])
out["manifest"].append({"case": "dotdot-space-row", "rows": 3, "has_rows": install._manifest_has_rows(r)})

r = tree("m-mixed-sep", payload)
manifest(r, [h(r, "runtime/node/node.exe") + "  runtime" + BS + "node" + BS + "node.exe", h(r, "AIDrivenNetDefense.exe") + "  AIDrivenNetDefense.exe", h(r, "console/index.html") + "  console/index.html"])
out["manifest"].append({"case": "mixed-separators", "rows": 3, "has_rows": install._manifest_has_rows(r)})

r = tree("m-filler", payload)
rows = [h(r, "AIDrivenNetDefense.exe") + "  AIDrivenNetDefense.exe", h(r, "runtime/node/node.exe") + "  runtime/node/node.exe", h(r, "console/index.html") + "  console/index.html"]
rows += ["c" * 64 + "  filler/fake-%d.bin" % i for i in range(1, 61)]
rows += [h(r, "AIDrivenNetDefense.exe") + "  AIDrivenNetDefense.exe", h(r, "runtime/node/node.exe") + "  runtime/node/node.exe", h(r, "console/index.html") + "  console/index.html"]
manifest(r, rows)
out["manifest"].append({"case": "3-real+60-fake+3-real", "rows": len(rows), "has_rows": install._manifest_has_rows(r)})

for rel in [".." + BS + "victim.txt", ".. " + BS + "victim.txt", "..." + BS + "victim.txt", "C:" + BS + "x", "a" + BS + "b", "a//b", "." + BS + "a", "a" + BS + ".." + BS + "b", BS + "abs", "/abs"]:
    out["manifest_path_safe"].append({"rel": rel, "safe": install._manifest_path_is_safe(rel)})

bundle = Path(sys.argv[3])
out["notes"].append({"real_bundle_bundle_is_ours": install._bundle_is_ours(bundle), "real_bundle_manifest_has_rows": install._manifest_has_rows(bundle)})

Path(sys.argv[4]).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print("python probes written")
'@
    $pyProbeOut = Join-Path $probeDir 'python-probes.json'
    & $Python $pyProbe $AppDir (Join-Path $RunRoot 'unit-trees') (Join-Path $RepoRoot 'dist\bundle\win32-x64-v16') $pyProbeOut 2>&1 | Out-String | Write-Host
    if (Test-Path -LiteralPath $pyProbeOut) {
        Write-Host "python unit probes: $pyProbeOut"
    } else {
        Write-Host "[WARN] python unit probes produced no output"
    }

    # PS unit probes: Test-ManifestProof / Test-InstallRecordProof / Test-BundleProof / Test-TargetPath
    $psProbeRoot = Join-Path $RunRoot 'unit-trees-ps'
    New-Item -ItemType Directory -Force -Path $psProbeRoot | Out-Null
    # compute rows after the tree exists: use a helper that hashes inside a tree
    $mk = {
        param([string]$Name, [string[]]$RelList, [switch]$Fake, [switch]$WithRecord, [switch]$WithBundle, [switch]$Bom, [switch]$Crlf, [int]$Filler = 0, [string]$RowStyle = 'real')
        $root = Join-Path $psProbeRoot $Name
        New-Item -ItemType Directory -Force -Path (Join-Path $root 'runtime\node'), (Join-Path $root 'console'), (Join-Path $root 'manifests') | Out-Null
        Write-Utf8 (Join-Path $root 'AIDrivenNetDefense.exe') "MZ fixture`n"
        Write-Utf8 (Join-Path $root 'runtime\node\node.exe') "node fixture`n"
        Write-Utf8 (Join-Path $root 'console\index.html') "<html>`n"
        $rows = New-Object System.Collections.ArrayList
        foreach ($rel in $RelList) {
            if ($RowStyle -eq 'fake') { [void]$rows.Add(("a" * 64) + "  $rel") }
            else { [void]$rows.Add((Get-Sha256File (Join-Path $root ($rel -replace '/', '\'))) + "  $rel") }
        }
        for ($i = 1; $i -le $Filler; $i++) { [void]$rows.Add(("c" * 64) + "  filler/fake-$i.bin") }
        if ($Filler -gt 0) { foreach ($rel in $RelList) { [void]$rows.Add((Get-Sha256File (Join-Path $root ($rel -replace '/', '\'))) + "  $rel") } }
        $sep = if ($Crlf) { "`r`n" } else { "`n" }
        $text = ($rows -join $sep) + $sep
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
        if ($Bom) { $bytes = [byte[]](0xEF, 0xBB, 0xBF) + $bytes }
        [System.IO.File]::WriteAllBytes((Join-Path $root 'manifests\files.sha256'), $bytes)
        if ($WithRecord) { Write-InstallJson -Target $root }
        if ($WithBundle) {
            $bundle = [ordered]@{ schemaVersion = '1.0'; author = 'PT-dove'; kind = 'packaging-poc'; paths = [ordered]@{ node = 'runtime/node/node.exe' } }
            Write-Utf8 (Join-Path $root 'bundle.json') (($bundle | ConvertTo-Json -Depth 4) + "`n")
        }
        return $root
    }
    $r1 = & $mk -Name 'ps-empty' -RelList @() -WithRecord
    $r2 = & $mk -Name 'ps-one-fake' -RelList @('AIDrivenNetDefense.exe') -RowStyle 'fake' -WithRecord
    $r3 = & $mk -Name 'ps-three-fake' -RelList @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html') -RowStyle 'fake' -WithRecord
    $r4 = & $mk -Name 'ps-three-real-record' -RelList @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html') -WithRecord
    $r5 = & $mk -Name 'ps-real-bom-record' -RelList @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html') -WithRecord -Bom
    $r6 = & $mk -Name 'ps-real-crlf-record' -RelList @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html') -WithRecord -Crlf
    $r7 = & $mk -Name 'ps-three-real-bundle' -RelList @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html') -WithBundle
    $r8 = & $mk -Name 'ps-filler-record' -RelList @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html') -WithRecord -Filler 60
    # traversal / absolute / dotdot-space rows via raw text
    $trav = & $mk -Name 'ps-traversal-record' -RelList @() -WithRecord
    $rows = @(('d' * 64) + '  ..\outside.txt', (Get-Sha256File (Join-Path $trav 'runtime\node\node.exe')) + '  runtime/node/node.exe', (Get-Sha256File (Join-Path $trav 'console\index.html')) + '  console/index.html')
    Write-Utf8 (Join-Path $trav 'manifests\files.sha256') (($rows -join "`n") + "`n")
    $abs = & $mk -Name 'ps-absolute-record' -RelList @() -WithRecord
    $rows = @(('d' * 64) + '  C:\Windows\System32\cmd.exe', (Get-Sha256File (Join-Path $abs 'runtime\node\node.exe')) + '  runtime/node/node.exe', (Get-Sha256File (Join-Path $abs 'console\index.html')) + '  console/index.html')
    Write-Utf8 (Join-Path $abs 'manifests\files.sha256') (($rows -join "`n") + "`n")
    $dds = & $mk -Name 'ps-dotdot-space-record' -RelList @() -WithRecord
    $rows = @(('d' * 64) + '  .. \outside.txt', (Get-Sha256File (Join-Path $dds 'runtime\node\node.exe')) + '  runtime/node/node.exe', (Get-Sha256File (Join-Path $dds 'console\index.html')) + '  console/index.html')
    Write-Utf8 (Join-Path $dds 'manifests\files.sha256') (($rows -join "`n") + "`n")

    $psProbeScript = Join-Path $Base 'probe-ps.ps1'
    Write-Utf8 $psProbeScript @'
$ErrorActionPreference = 'Stop'
$env:AIDN_SETUP_TEST_DOTSOURCE = '1'
. $env:SEED01_SETUP
$root = $env:SEED01_PROBE_ROOT
$out = [ordered]@{ manifest = @(); target_path = @() }
foreach ($d in (Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name)) {
    $item = [ordered]@{
        name     = $d.Name
        manifest = (Test-ManifestProof -Root $d.FullName)
        record   = (Test-InstallRecordProof -Root $d.FullName)
        bundle   = (Test-BundleProof -Root $d.FullName)
    }
    $out.manifest += $item
}
foreach ($p in @('C:\', 'C:\Windows', 'C:\Windows\Temp\x', '\\?\C:\Windows\Temp\x', 'C:\WindowsX\y', ('C:\' + ('a' * 200)))) {
    $out.target_path += [ordered]@{ path = $p; error = (Test-TargetPath -Path $p) }
}
($out | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $env:SEED01_RESULT -Encoding UTF8
'@
    $psProbeOut = Join-Path $probeDir 'powershell-probes.json'
    $savedProbe = @{ TEMP = $env:TEMP; TMP = $env:TMP; SEED01_SETUP = $env:SEED01_SETUP; SEED01_PROBE_ROOT = $env:SEED01_PROBE_ROOT; SEED01_RESULT = $env:SEED01_RESULT }
    $env:TEMP = (Join-Path $RunRoot 'probe-temp'); $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
    $env:SEED01_SETUP = $SetupPs1
    $env:SEED01_PROBE_ROOT = $psProbeRoot
    $env:SEED01_RESULT = $psProbeOut
    try {
        $psOut = (& $PwshExe -NoProfile -File $psProbeScript 2>&1 | Out-String)
        Write-Host $psOut
    } finally {
        foreach ($k in $savedProbe.Keys) { if ($null -eq $savedProbe[$k]) { Remove-Item -Path "env:$k" -ErrorAction SilentlyContinue } else { Set-Item -Path "env:$k" -Value $savedProbe[$k] } }
    }
    if (Test-Path -LiteralPath $psProbeOut) { Write-Host "powershell unit probes: $psProbeOut" } else { Write-Host "[WARN] powershell unit probes produced no output" }
}

# ---------------------------------------------------------------- mutations
if ($WithMutations) {
    Write-Host "`n=== D. Mutation testing (product files temporarily edited, restored byte-identical) ==="
    $mutRoot = Join-Path $RunRoot 'mutants'
    New-Item -ItemType Directory -Force -Path $mutRoot | Out-Null
    $mutants = New-Object System.Collections.ArrayList

    function Invoke-Mutation {
        param(
            [string]$Id,
            [string]$FilePath,
            [string]$Description,
            [scriptblock]$Apply,
            [string]$Channel,
            [scriptblock]$Build,
            [string]$ReRunId
        )
        $backup = Join-Path $mutRoot ((Split-Path -Leaf $FilePath) + ".$Id.bak")
        Copy-Item -LiteralPath $FilePath -Destination $backup -Force
        $before = Get-Sha256File $FilePath
        & $Apply
        $mutated = Get-Sha256File $FilePath
        $caseDir = New-CaseDir $ReRunId
        $b = & $Build $caseDir
        $target = [string]$b.Target
        $watch = @($target) + @($b.Watch)
        $snapBefore = Get-SnapshotMany -Paths $watch
        $run = if ($Channel -eq 'python') { Invoke-PythonUninstall -Target $target -CaseDir $caseDir } else { Invoke-PsUninstall -Target $target -CaseDir $caseDir }
        $snapAfter = Get-SnapshotMany -Paths $watch
        $changed = -not (Test-SameSnapshot -Before $snapBefore -After $snapAfter)
        $red = if ($Channel -eq 'python') { $run.ExitCode -ne 5 -and $changed } else { $run.Outcome -ne 'THROW' -and $changed }
        # restore immediately
        Copy-Item -LiteralPath $backup -Destination $FilePath -Force
        $restored = Get-Sha256File $FilePath
        # re-run the same case on restored code -> must be refused again
        $caseDir2 = New-CaseDir ($ReRunId + '-restored')
        $b2 = & $Build $caseDir2
        $target2 = [string]$b2.Target
        $watch2 = @($target2) + @($b2.Watch)
        $snapBefore2 = Get-SnapshotMany -Paths $watch2
        $run2 = if ($Channel -eq 'python') { Invoke-PythonUninstall -Target $target2 -CaseDir $caseDir2 } else { Invoke-PsUninstall -Target $target2 -CaseDir $caseDir2 }
        $snapAfter2 = Get-SnapshotMany -Paths $watch2
        $greenAgain = if ($Channel -eq 'python') { $run2.ExitCode -eq 5 -and (Test-SameSnapshot -Before $snapBefore2 -After $snapAfter2) } else { $run2.Outcome -eq 'THROW' -and (Test-SameSnapshot -Before $snapBefore2 -After $snapAfter2) }
        $mutDir = Join-Path $EvidenceDir "mutations\$Id"
        New-Item -ItemType Directory -Force -Path $mutDir | Out-Null
        $info = [ordered]@{
            id             = $Id
            description    = $Description
            file           = $FilePath
            sha256_before  = $before
            sha256_mutated = $mutated
            sha256_restored = $restored
            restored_identical = ($before -eq $restored)
            mutated_run    = [ordered]@{ channel = $Channel; exitcode = $run.ExitCode; ps_outcome = $run.Outcome; tree_changed = $changed; turns_red = $red; stdout = [string]$run.Stdout }
            restored_run   = [ordered]@{ channel = $Channel; exitcode = $run2.ExitCode; ps_outcome = $run2.Outcome; refused_again = $greenAgain; stdout = [string]$run2.Stdout }
        }
        Write-Utf8 (Join-Path $mutDir 'mutation.json') (($info | ConvertTo-Json -Depth 6))
        Write-Utf8 (Join-Path $mutDir 'mutated-run.txt') ([string]$run.Stdout + "`n`n" + [string]$run.Log)
        Write-Utf8 (Join-Path $mutDir 'restored-run.txt') ([string]$run2.Stdout + "`n`n" + [string]$run2.Log)
        [void]$mutants.Add([pscustomobject]$info)
        $tag = if ($red -and $greenAgain -and ($before -eq $restored)) { 'MUTATION-OK' } else { 'MUTATION-FAIL' }
        Write-Host ("[{0}] {1,-28} {2,-6} red={3,-5} restored_identical={4,-5} green_again={5}" -f $tag, $Id, $Channel, $red, ($before -eq $restored), $greenAgain)
        return [pscustomobject]$info
    }

    # M1: Python ownership gate removed (marker forced) -> py-01 random dir must be deleted
    Invoke-Mutation -Id 'M1-python-ownership-gate-removed' -FilePath $InstallPy -Description 'install.py:uninstall marker forced to a non-None value -> ownership refusal block is dead code' -Channel 'python' -ReRunId 'mut-M1-random-dir' -Apply {
        $raw = [System.IO.File]::ReadAllText($InstallPy, [System.Text.Encoding]::UTF8)
        $needle = "    marker = _install_marker(target)`r`n"
        $replacement = "    marker = 'MUTANT: ownership gate removed'  # REATTACK-RC4 seed01 mutation`r`n"
        if (-not $raw.Contains($needle)) { throw "mutation anchor not found in install.py" }
        $raw = $raw.Replace($needle, $replacement)
        [System.IO.File]::WriteAllText($InstallPy, $raw, (New-Object System.Text.UTF8Encoding($false)))
    } -Build {
        param($caseDir)
        $t = Join-Path $caseDir 'my-notes'
        New-SentinelTree $t
        @{ Target = $t; Watch = @() }
    } | Out-Null

    # M2: PowerShell Uninstall-Target no longer calls Assert-UninstallOwnership -> ps-01 deleted
    Invoke-Mutation -Id 'M2-ps-assert-ownership-commented' -FilePath $SetupPs1 -Description 'Setup.ps1:Uninstall-Target Assert-UninstallOwnership call commented out' -Channel 'ps' -ReRunId 'mut-M2-random-dir' -Apply {
        $raw = [System.IO.File]::ReadAllText($SetupPs1, [System.Text.Encoding]::UTF8)
        $needle = "    Assert-UninstallOwnership -Target `$Target`n"
        $replacement = "    # Assert-UninstallOwnership -Target `$Target  # REATTACK-RC4 seed01 mutation`n"
        if (-not $raw.Contains($needle)) { throw "mutation anchor not found in Setup.ps1" }
        $raw = $raw.Replace($needle, $replacement)
        [System.IO.File]::WriteAllText($SetupPs1, $raw, (New-Object System.Text.UTF8Encoding($true)))
    } -Build {
        param($caseDir)
        $t = Join-Path $caseDir 'my-notes'
        New-SentinelTree $t
        @{ Target = $t; Watch = @() }
    } | Out-Null

    # M3: PowerShell Test-ManifestProof always true -> ps-03 (install.json + empty manifest) deleted
    Invoke-Mutation -Id 'M3-ps-manifest-proof-always-true' -FilePath $SetupPs1 -Description 'Setup.ps1:Test-ManifestProof returns $true immediately' -Channel 'ps' -ReRunId 'mut-M3-installjson-empty-manifest' -Apply {
        $raw = [System.IO.File]::ReadAllText($SetupPs1, [System.Text.Encoding]::UTF8)
        $needle = "function Test-ManifestProof {`n    param([string]`$Root)`n"
        $replacement = "function Test-ManifestProof {`n    param([string]`$Root)`n    return `$true  # REATTACK-RC4 seed01 mutation`n"
        if (-not $raw.Contains($needle)) { throw "mutation anchor not found in Setup.ps1 Test-ManifestProof" }
        $raw = $raw.Replace($needle, $replacement)
        [System.IO.File]::WriteAllText($SetupPs1, $raw, (New-Object System.Text.UTF8Encoding($true)))
    } -Build {
        param($caseDir)
        $t = Join-Path $caseDir 'my-notes'
        New-SentinelTree $t
        Write-InstallJson -Target $t
        Write-Utf8 (Join-Path $t 'manifests\files.sha256') ''
        @{ Target = $t; Watch = @() }
    } | Out-Null

    # M4: Python _manifest_has_rows always true -> py-03 deleted
    Invoke-Mutation -Id 'M4-python-manifest-proof-always-true' -FilePath $InstallPy -Description 'install.py:_manifest_has_rows returns True immediately' -Channel 'python' -ReRunId 'mut-M4-installjson-empty-manifest' -Apply {
        $raw = [System.IO.File]::ReadAllText($InstallPy, [System.Text.Encoding]::UTF8)
        $needle = "def _manifest_has_rows(root: Path) -> bool:`r`n"
        $replacement = "def _manifest_has_rows(root: Path) -> bool:`r`n    return True  # REATTACK-RC4 seed01 mutation`r`n"
        if (-not $raw.Contains($needle)) { throw "mutation anchor not found in install.py _manifest_has_rows" }
        $raw = $raw.Replace($needle, $replacement)
        [System.IO.File]::WriteAllText($InstallPy, $raw, (New-Object System.Text.UTF8Encoding($false)))
    } -Build {
        param($caseDir)
        $t = Join-Path $caseDir 'my-notes'
        New-SentinelTree $t
        Write-InstallJson -Target $t
        Write-Utf8 (Join-Path $t 'manifests\files.sha256') ''
        @{ Target = $t; Watch = @() }
    } | Out-Null

    # M5: Python _link_reason forced None -> junction target uninstall penetrates into victim
    Invoke-Mutation -Id 'M5-python-link-guard-removed' -FilePath $InstallPy -Description 'install.py:_link_reason returns None immediately -> junction target accepted' -Channel 'python' -ReRunId 'mut-M5-target-junction' -Apply {
        $raw = [System.IO.File]::ReadAllText($InstallPy, [System.Text.Encoding]::UTF8)
        $needle = "def _link_reason(target: Path) -> str | None:`r`n"
        $replacement = "def _link_reason(target: Path) -> str | None:`r`n    return None  # REATTACK-RC4 seed01 mutation`r`n"
        if (-not $raw.Contains($needle)) { throw "mutation anchor not found in install.py _link_reason" }
        $raw = $raw.Replace($needle, $replacement)
        [System.IO.File]::WriteAllText($InstallPy, $raw, (New-Object System.Text.UTF8Encoding($false)))
    } -Build {
        param($caseDir)
        $victim = Join-Path $caseDir 'victim'
        New-BundleTree $victim
        $link = Join-Path $caseDir 'link-to-victim'
        New-Junction -Link $link -Target $victim
        @{ Target = $link; Watch = @($victim) }
    } | Out-Null

    Write-Utf8 (Join-Path $EvidenceDir 'mutations.json') (($mutants | ConvertTo-Json -Depth 8))
}

# ---------------------------------------------------------------- final drift + result
$driftAfter = @{}
foreach ($f in $driftFiles) { $driftAfter[$f] = Get-Sha256File $f }
$driftOk = $true
foreach ($f in $driftFiles) { if ($driftBefore[$f] -ne $driftAfter[$f]) { $driftOk = $false } }

$verdictCounts = [ordered]@{ CLOSED = 0; BYPASSED = 0; unreproducible = 0 }
foreach ($r in $script:Results) { $verdictCounts[$r.verdict] = [int]$verdictCounts[$r.verdict] + 1 }
$result = [ordered]@{
    campaign   = 'REATTACK-RC4'
    seed       = 'seed01-installer'
    generated_at = (Get-Date).ToString('o')
    repo_root  = $RepoRoot
    python     = (& $Python -V 2>&1 | Out-String).Trim()
    pwsh       = $PSVersionTable.PSVersion.ToString()
    run_root   = $RunRoot
    drift      = [ordered]@{ files = $driftBefore; mtime = $driftMtime; after = $driftAfter; unchanged = $driftOk }
    verdict_counts = $verdictCounts
    results    = $script:Results
}
Write-Utf8 (Join-Path $EvidenceDir 'RESULT.json') (($result | ConvertTo-Json -Depth 10))
Write-Host "`n=== SUMMARY ==="
Write-Host ("cases: {0}  CLOSED={1}  BYPASSED={2}  unreproducible={3}" -f $script:Results.Count, $verdictCounts.CLOSED, $verdictCounts.BYPASSED, $verdictCounts.unreproducible)
Write-Host ("drift unchanged: {0}" -f $driftOk)
if (-not $driftOk) {
    Write-Host "[FATAL] product files changed during the run!"
    foreach ($f in $driftFiles) { if ($driftBefore[$f] -ne $driftAfter[$f]) { Write-Host ("  CHANGED: {0}  {1} -> {2}" -f $f, $driftBefore[$f], $driftAfter[$f]) } }
    exit 3
}
Write-Host "RESULT.json: $(Join-Path $EvidenceDir 'RESULT.json')"

# Exit-code contract for automation:
#   0 = every mandated attack was refused (CLOSED), positive controls still uninstall
#   2 = a mandated attack (kind=refusal/penetration) was BYPASSED -> P0
#   4 = a positive control (genuine tree) could not be uninstalled -> over-fix regression
#   3 = product files drifted during the run (see drift section)
$mandatedBypass = @($script:Results | Where-Object { $_.verdict -eq 'BYPASSED' -and ($_.kind -eq 'refusal' -or $_.kind -eq 'penetration') })
$positiveFail = @($script:Results | Where-Object { $_.kind -eq 'positive' -and $_.verdict -ne 'CLOSED' })
if ($mandatedBypass.Count -gt 0) {
    Write-Host ("[P0] mandated attack bypassed: " + (($mandatedBypass | ForEach-Object { $_.id }) -join ', '))
    exit 2
}
if ($positiveFail.Count -gt 0) {
    Write-Host ("[REGRESSION] positive control failed: " + (($positiveFail | ForEach-Object { $_.id }) -join ', '))
    exit 4
}
exit 0
