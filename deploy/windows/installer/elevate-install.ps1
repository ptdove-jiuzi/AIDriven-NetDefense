#requires -Version 5.1
<#
.SYNOPSIS
    AIDriven NetDefense — one-click elevated install / uninstall with evidence.

.DESCRIPTION
    WHY THIS FILE EXISTS
    --------------------
    The rc.3 acceptance run failed in the worst possible way: the command line was
    correct, the window looked normal, and the installer spent five minutes unpacking
    450 MiB before dying with

        ERROR  [WinError 5] 拒绝访问。: 'C:\Program Files\AIDriven Net Defense'

    Nothing was wrong except that the process was never elevated.  Two independent
    guards now make that specific failure impossible to reach slowly:

      1. `Setup.exe` itself refuses before touching the archive (exit code 7,
         `EXIT_NEEDS_ADMIN`) when the target is under a protected root and the token is
         not elevated — see deploy/windows/installer/app/main.py;
      2. this script checks elevation *before* running Setup.exe at all, and when it is
         not elevated it asks Windows for one UAC consent and re-runs itself inside the
         elevated process.

    WHY `Start-Process -Verb RunAs` AND NOT A SCHEDULED TASK
    -------------------------------------------------------
    * `schtasks.exe` is blocked by local security policy on this machine, so the only
      way to create a task is the `*-ScheduledTask` cmdlets — and registering a task
      with `-RunLevel Highest` requires the caller to already be elevated
      (`Access is denied` for a filtered token).  A mechanism that needs the very
      privilege it is supposed to obtain is not a mechanism.  The negative experiment
      is recorded in docs/implementation/evidence/rc3/a3/mechanism-negative.txt.
    * The interactive session is a standard UAC *split* token: `BUILTIN\Administrators`
      is present but "used for deny only" (see the same evidence file), so the user can
      approve a consent prompt with one click — no administrator password needed.
    * `Start-Process -Verb RunAs` is a documented ShellExecute path, it works from the
      same non-elevated shell, and it has an unambiguous cancel signal (the exception
      raised when the prompt is dismissed), which is what makes the "user refused"
      branch (exit 8) honest.

    WHAT IT DOES WHEN ELEVATED
    --------------------------
    install -> install.json -> uninstall registry entry -> live /healthz -> uninstall ->
    verify nothing is left behind.  Every observation is written to `-EvidenceDir`
    (`evidence.json` + `transcript.log`), so the run is inspectable after the elevated
    window closes.

    NOTHING IS FAKED: no token manipulation, no privilege bypass, no manifest trick.
    If the process is not elevated and the target needs elevation, only a real UAC
    consent moves it forward.

.PARAMETER Setup
    The installer executable.  Defaults to the rc.3 artifact in this repository.

.PARAMETER Dir
    Install target.  Defaults to `%ProgramFiles%\AIDriven Net Defense`.

.PARAMETER Uninstall
    Uninstall from `-Dir` and verify the cleanup, instead of installing first.

.PARAMETER NoRelaunch
    Never request UAC.  This is the self-test switch for the refusal branch: it must
    exit 7 without running the installer.

.PARAMETER DryRun
    Print the resolved plan and the exact elevated command line, then exit 0.  No UAC
    prompt, no installer run.  Used by the automated self-test.

.PARAMETER SkipHealth
    Do not launch the desktop shell and poll /healthz (for a headless self-test).

.PARAMETER HealthTimeoutSec
    How long to wait for the daemon's /healthz to answer 200.

.PARAMETER EvidenceDir
    Where `evidence.json` / `transcript.log` go.  Defaults to
    docs/implementation/evidence/rc3/a3/elevated-run.

.PARAMETER Elevated
    Internal: set on the re-launched (already elevated) process.  Not user-facing.

.NOTES
    Author: PT-dove
    Exit codes: 0 all checks passed; 1 a check failed; 2 bad usage;
                7 not elevated and elevation required; 8 UAC prompt cancelled.
#>
[CmdletBinding()]
param(
    [string]$Setup = '',
    [string]$Dir = '',
    [switch]$Uninstall,
    [switch]$NoRelaunch,
    [switch]$DryRun,
    [switch]$SkipHealth,
    [switch]$ProbeArgv,
    [int]$HealthTimeoutSec = 120,
    [string]$EvidenceDir = '',
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- console encoding
# The messages are bilingual, so neither a cp936 nor a UTF-8 console is right for both
# cases.  Rule used here:
#   * output redirected (evidence capture, automation) -> UTF-8, stable on any locale;
#   * interactive console -> leave the console's own encoding alone.  Setting UTF-8 here
#     would garble every Chinese line in the elevated window, because elevate-install.cmd
#     runs `chcp 936` for its own cp936-encoded text.
try {
    if ([Console]::IsOutputRedirected) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
        $OutputEncoding = New-Object System.Text.UTF8Encoding $false
    }
} catch { }

$Here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot = (Resolve-Path (Join-Path $Here '..\..\..')).Path

if (-not $Setup) {
    $Setup = Join-Path $RepoRoot 'dist\release\0.0.1-rc.3\AIDrivenNetDefense-Setup-0.0.1-rc.3.exe'
}
if (-not $Dir) {
    $Dir = Join-Path $env:ProgramFiles 'AIDriven Net Defense'
}
if (-not $EvidenceDir) {
    $EvidenceDir = Join-Path $RepoRoot 'docs\implementation\evidence\rc3\a3\elevated-run'
}
$Dir = $Dir.TrimEnd('\')

$script:Checks = @()
$script:Lines = @()
#: Filled by the install phase; the uninstall-only mode reads them, so they must exist.
$script:WrittenHive = ''
$script:HealthzEvidence = $null

function Add-Line {
    param([string]$Text)
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $line = "$stamp  $Text"
    $script:Lines += $line
    Write-Host $line
}

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $script:Checks += [ordered]@{ name = $Name; ok = $Ok; detail = $Detail }
    $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
    Add-Line ("[{0}] {1}  {2}" -f $mark, $Name, $Detail)
}

function Test-Elevated {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal $identity
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

#: Environment roots only an elevated token can create children in.  Mirrors the
#: `_PROTECTED_ENV_ROOTS` list in app/main.py on purpose: the script and the installer
#: have to agree, because the script must never promise "this needs elevation" for a
#: target the installer would accept.
$ProtectedEnvRoots = @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SystemRoot')

function Get-ProtectedRoot {
    param([string]$Target)
    $full = [IO.Path]::GetFullPath($Target).TrimEnd('\')
    foreach ($name in $ProtectedEnvRoots) {
        $root = [Environment]::GetEnvironmentVariable($name)
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
        if ($full.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
            $full.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
            return "%$name%"
        }
    }
    $parent = Split-Path -Parent $full
    if ($parent -and ([IO.Path]::GetPathRoot($full).TrimEnd('\') -eq $parent.TrimEnd('\'))) {
        return $parent        # a directory directly under a drive root: \Foo on C:
    }
    return $null
}

function Get-RegistryEntry {
    param([string]$Hive = '')
    $subkey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense'
    $hives = if ($Hive) { @($Hive) } else { @('HKLM:', 'HKCU:') }
    foreach ($hive in $hives) {
        $path = "$hive\$subkey"
        try {
            if (Test-Path $path) {
                $values = Get-ItemProperty -Path $path -ErrorAction Stop
                # A key with no values is not an entry: this machine carries an empty
                # HKLM leftover from an earlier non-elevated attempt (its probe creates
                # the key and then cannot write the values).  Reporting it as an
                # installed product would be wrong.
                if ($values.DisplayName -or $values.InstallLocation) {
                    return [ordered]@{
                        hive = $hive.TrimEnd(':')
                        path = $path
                        displayName = $values.DisplayName
                        displayVersion = $values.DisplayVersion
                        installLocation = $values.InstallLocation
                        uninstallString = $values.UninstallString
                    }
                }
            }
        } catch { }
    }
    return $null
}

function Test-RegistryKey {
    param([string]$Hive)
    $subkey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense'
    return (Test-Path "$Hive\$subkey")
}

function Get-ProcessesUnder {
    param([string]$Root)
    $found = @()
    foreach ($proc in Get-Process -ErrorAction SilentlyContinue) {
        try {
            $path = $proc.Path
        } catch {
            continue        # protected/short-lived process: not ours
        }
        if ($path -and $path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
            $found += [ordered]@{ pid = $proc.Id; name = $proc.ProcessName; path = $path }
        }
    }
    return $found
}

# ---------------------------------------------------------------- runtime.json / /healthz
# The shell's data root is ``%LOCALAPPDATA%\<APP_DIR_NAME>\`` — and ``APP_DIR_NAME`` is NOT
# the product name: ``apps/desktop/aidn/paths.py`` declares it, and it has historically
# differed in spacing ("AIDriven NetDefense" vs "AIDriven Net Defense").  Hard-coding one
# spelling is exactly the defect that made the 22:08 elevated run wait 120 s for a file that
# had been written three seconds after launch under the other spelling.  So: take the
# constant from the source when it is next to us, then try every plausible spelling.
function Get-RuntimeCandidates {
    $names = @()
    $pathsPy = Join-Path $RepoRoot 'apps\desktop\aidn\paths.py'
    if (Test-Path -LiteralPath $pathsPy -PathType Leaf) {
        $declared = Select-String -LiteralPath $pathsPy -Pattern '^\s*APP_DIR_NAME\s*=\s*"([^"]+)"' | Select-Object -First 1
        if ($declared) { $names += $declared.Matches[0].Groups[1].Value }
    }
    foreach ($fallback in @('AIDriven NetDefense', 'AIDriven Net Defense')) {
        if ($names -notcontains $fallback) { $names += $fallback }
    }
    $candidates = @()
    if ($env:AIDN_BASE_DIR) { $candidates += (Join-Path $env:AIDN_BASE_DIR 'data\shell\runtime.json') }
    if ($env:LOCALAPPDATA) {
        foreach ($name in $names) {
            $candidates += (Join-Path (Join-Path $env:LOCALAPPDATA $name) 'data\shell\runtime.json')
        }
    }
    return $candidates
}

#: ``runtime.json`` is only trusted when it was written after this run launched: a file left
#: by an earlier instance would otherwise let a shell that never started "pass" /healthz
#: against somebody else's port.
function Get-RuntimeFreshPorts {
    param([string[]]$Candidates, [hashtable]$Before, [datetime]$Deadline)
    while ((Get-Date) -lt $Deadline) {
        foreach ($candidate in $Candidates) {
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            $stamp = (Get-Item -LiteralPath $candidate).LastWriteTimeUtc
            $isNew = (-not $Before.ContainsKey($candidate)) -or ($null -eq $Before[$candidate]) -or ($stamp -gt $Before[$candidate])
            if (-not $isNew) { continue }
            try {
                $ports = Get-Content -LiteralPath $candidate -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($ports.daemon_port -or $ports.ui_port) {
                    return [ordered]@{ state = $candidate; ports = $ports }
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    }
    return [ordered]@{ state = ''; ports = $null }
}

#: GET as soon as the ports are known; a port that is not listening yet is retried every
#: 500 ms instead of being given one shot after a long blind wait (the 22:08 transcript sat
#: 121 s doing nothing and then never issued a request at all).
function Get-Healthz {
    param($Ports, [datetime]$Deadline)
    $result = [ordered]@{ url = ''; status = 0; body = ''; attempts = 0; lastError = '' }
    while ((Get-Date) -lt $Deadline) {
        foreach ($candidatePort in @($Ports.daemon_port, $Ports.ui_port)) {
            if (-not $candidatePort) { continue }
            $url = "http://127.0.0.1:$candidatePort/healthz"
            $result.attempts++
            try {
                $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
                $body = $response.Content.Trim()
                Add-Line ("GET $url -> $($response.StatusCode) $body")
                if ($response.StatusCode -eq 200) {
                    $result.url = $url
                    $result.status = 200
                    $result.body = $body
                    return $result
                }
                $result.lastError = "HTTP $($response.StatusCode)"
            } catch {
                $result.lastError = $_.Exception.Message
                Add-Line ("GET $url -> EXCEPTION $($_.Exception.Message)")
            }
        }
        Start-Sleep -Milliseconds 500
    }
    return $result
}

$isAdmin = Test-Elevated
$protectedRoot = Get-ProtectedRoot $Dir

Add-Line '======================================================================'
Add-Line 'AIDriven NetDefense — elevated install / uninstall'
Add-Line "started:        $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')"
Add-Line "user:           $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
Add-Line "is_elevated:    $isAdmin"
Add-Line "target:         $Dir"
Add-Line "protected_root: $(if ($protectedRoot) { $protectedRoot } else { '(none — user-writable target)' })"
Add-Line "setup:          $Setup"
Add-Line "mode:           $(if ($Uninstall) { 'uninstall+verify' } elseif ($DryRun) { 'dry-run (plan only)' } else { 'install->verify->uninstall' })"
Add-Line '======================================================================'

# ---------------------------------------------------------------- dry run
if ($DryRun) {
    Add-Line 'DRY-RUN: no UAC prompt, no installer run.'
    if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) {
        Add-Line "DRY-RUN: setup not found: $Setup"
        exit 2
    }
    $info = Get-Item -LiteralPath $Setup
    Add-Line ("DRY-RUN: setup bytes=$($info.Length) mtime=$($info.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))")
    # The /healthz path defect of the 22:08 run is checkable right here: the candidate list
    # must name the directory the shell actually uses (apps/desktop/aidn/paths.py).
    foreach ($candidate in (Get-RuntimeCandidates)) { Add-Line "DRY-RUN: runtime.json candidate: $candidate" }
    Add-Line "DRY-RUN: installer argv (quoted, exactly what Start-Process will pass):"
    Add-Line "DRY-RUN:   install:   /S /DIR=`"$Dir`""
    Add-Line "DRY-RUN:   uninstall: /S /uninstall /DIR=`"$Dir`""
    if ($protectedRoot -and -not $isAdmin) {
        Add-Line "DRY-RUN: elevation required ($protectedRoot); would relaunch via:"
        Add-Line "DRY-RUN:   Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated -Setup `"$Setup`" -Dir `"$Dir`" ...' -Wait"
        Add-Line 'DRY-RUN: expected: one UAC consent prompt, then the elevated process installs.'
    } elseif (-not $isAdmin) {
        Add-Line 'DRY-RUN: target is user-writable; no elevation needed, the sequence would run as-is.'
    } else {
        Add-Line 'DRY-RUN: already elevated; the sequence would install directly.'
    }
    exit 0
}

# ---------------------------------------------------------------- elevation gate
# -ProbeArgv deliberately bypasses the gate: it exists to observe the installer's own
# behaviour on an unelevated run (nothing is installed, the protected target is refused).
if ($protectedRoot -and -not $isAdmin -and -not $ProbeArgv) {
    if ($NoRelaunch) {
        Add-Line 'REFUSED: administrator rights are required and are not present.'
        Add-Line "REFUSED: $Dir is under the protected root $protectedRoot; this process is not elevated."
        Add-Line 'REFUSED: nothing was installed, unpacked or written. (-NoRelaunch forbids the UAC request.)'
        Add-Line 'REFUSED: re-run with rights: right-click → Run as administrator, or drop -NoRelaunch'
        exit 7
    }
    if ($Elevated) {
        # The relaunched process was supposed to be elevated and is not: refuse loudly
        # instead of pretending, otherwise a failed UAC consent would look like a
        # successful re-launch that then fails somewhere else.
        Add-Line 'REFUSED: the re-launched process is still not elevated — UAC consent did not take effect.'
        exit 7
    }
    Add-Line 'NOT ELEVATED: requesting one UAC consent prompt, then re-running this script elevated…'
    Add-Line ("NOT ELEVATED: installer argv will be: /S /DIR=`"$Dir`"")
    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
        '-Elevated',
        '-Setup', "`"$Setup`"",
        '-Dir', "`"$Dir`"",
        '-EvidenceDir', "`"$EvidenceDir`"",
        '-HealthTimeoutSec', "$HealthTimeoutSec"
    )
    if ($Uninstall) { $argList += '-Uninstall' }
    if ($SkipHealth) { $argList += '-SkipHealth' }
    $argString = $argList -join ' '
    $child = $null
    try {
        $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argString -Wait -PassThru
    } catch {
        # A real dismissal is ShellExecute's 0x800704C7 ("The operation was canceled by the
        # user").  Any other failure (no interactive desktop, policy, bad executable) is not
        # a user decision and must not be reported as exit 8.
        # NOTE FROM THE 21:31 RUN: the observed -1073741510 (0xC000013A, STATUS_CONTROL_C_EXIT)
        # came from the parent shell being terminated, not from this catch — the exit-8 path
        # is therefore NOT verified; it is documented as such in the status file.
        $message = $_.Exception.Message
        $hresult = $null
        try { $hresult = $_.Exception.HResult } catch { }
        Add-Line ("ELEVATION FAILED: {0} (HResult={1})" -f $message, $hresult)
        if ($message -match 'cancel|cancell?ed|取消|0x800704C7|1223' -or $hresult -eq -2147023417) {
            Add-Line 'REFUSED: the UAC prompt was dismissed; nothing was installed, unpacked or written.'
            exit 8
        }
        Add-Line 'REFUSED: elevation could not be started at all; nothing was installed.'
        exit 7
    }
    if (-not $child) {
        Add-Line 'REFUSED: no elevated process was produced; nothing was installed.'
        exit 8
    }
    Add-Line "elevated run finished: exit=$($child.ExitCode)"
    Add-Line "evidence: $EvidenceDir"
    exit $child.ExitCode
}

if (-not $isAdmin) {
    if ($protectedRoot) {
        Add-Line "NOTE: not elevated and $Dir is under $protectedRoot — the gate is bypassed on purpose (-ProbeArgv); the installer has to refuse on its own."
    } else {
        Add-Line "NOTE: this process is not elevated, but $Dir is user-writable, so no elevation is needed."
        Add-Line 'NOTE: the sequence below is the real sequence; only elevated-only effects (HKLM) are absent.'
    }
}

# ---------------------------------------------------------------- preflight
if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) {
    Add-Line "ERROR: installer not found: $Setup"
    exit 2
}
if (-not (Test-Path -LiteralPath $EvidenceDir -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
}
$setupInfo = Get-Item -LiteralPath $Setup
$runId = (Get-Date).ToString('yyyyMMdd-HHmmss')
Add-Line ("setup: bytes=$($setupInfo.Length) mtime=$($setupInfo.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))")
Add-Line ("evidence run: $runId -> $EvidenceDir")

$installRecordPath = Join-Path $Dir 'install\install.json'
$preState = [ordered]@{
    dirExists = Test-Path -LiteralPath $Dir -PathType Container
    installRecordExists = Test-Path -LiteralPath $installRecordPath -PathType Leaf
    registry = Get-RegistryEntry
}
Add-Line ("pre-state: dirExists=$($preState.dirExists) installRecordExists=$($preState.installRecordExists) registry=$(if ($preState.registry) { $preState.registry.hive } else { 'none' })")

$startedAt = Get-Date
$setupExit = $null
$setupSeconds = $null

function Invoke-Setup {
    param([string]$ArgString, [string]$Label)
    # Setup.exe is a GUI-subsystem (``--noconsole``) executable: `& $Setup` returns
    # immediately and never sets $LASTEXITCODE, so the wait and the exit code have to come
    # from Start-Process.
    #
    # AND -ArgumentList is passed through verbatim: Windows PowerShell 5.1 joins an array
    # with single spaces and adds NO quoting.  The first version passed an array
    # ('/S', "/DIR=$Dir"), so a target with spaces arrived as `/S /DIR=C:\Program Files\
    # AIDriven Net Defense` — four tokens — and the installer correctly answered
    # "unknown argument" with exit code 2.  Hence: one string, quotes written by us, the
    # same shape a person would type.
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $Setup -ArgumentList $ArgString -Wait -PassThru
    $code = $proc.ExitCode
    $watch.Stop()
    $seconds = [math]::Round($watch.Elapsed.TotalSeconds, 2)
    Add-Line ("{0}: exit={1} elapsed={2}s argv={3}" -f $Label, $code, $seconds, $ArgString)
    Start-Sleep -Milliseconds 400

    # %TEMP% is shared with every other session on this machine.  "Newest AIDriven-Setup-*.log"
    # was not enough: the 21:31 run copied a concurrent REV session's log into the evidence.
    # A candidate is only accepted when its text mentions THIS run's target.
    $needles = @($Dir, ($Dir -replace '\\', '\\'))
    $newLog = $null
    $rejected = @()
    foreach ($candidate in @(Get-ChildItem -Path $env:TEMP -Filter 'AIDriven-Setup-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
        if ($candidate.LastWriteTime -lt $startedAt) { continue }
        # The console-less fallback written by main.py is not a run log, even though its
        # text mentions the target (that is exactly why it matched here once).
        if ($candidate.Name -like 'AIDriven-Setup-usage-error.log') { continue }
        $candidateText = ''
        try { $candidateText = Get-Content -LiteralPath $candidate.FullName -Raw -Encoding UTF8 } catch { continue }
        # A real run log starts with main.py's "start: <version> argv=[...]" line.
        if (-not $candidateText.Contains('start: ')) { continue }
        $match = $false
        foreach ($needle in $needles) {
            if ($needle -and $candidateText.Contains($needle)) { $match = $true; break }
        }
        if ($match) { $newLog = $candidate; break }
        $rejected += $candidate.Name
    }
    $logText = ''
    $logPath = ''
    $copyPath = ''
    $logMismatch = $false
    if ($newLog) {
        $logPath = $newLog.FullName
        $logText = Get-Content -LiteralPath $newLog.FullName -Raw -Encoding UTF8
        $copyPath = Join-Path $EvidenceDir ("$runId-$Label-setup.log")
        Copy-Item -LiteralPath $newLog.FullName -Destination $copyPath -Force
        Add-Line ("{0}: installer log {1} -> {2}" -f $Label, $newLog.FullName, $copyPath)
    } else {
        $logMismatch = $true
        Add-Line ("{0}: WARN no log in %TEMP% mentions this target — nothing copied (logMismatch=true)." -f $Label)
        if ($rejected.Count -gt 0) {
            Add-Line ("{0}: rejected {1} concurrent log(s): {2}" -f $Label, $rejected.Count, ($rejected -join ', '))
        }
    }
    # The installer logs the hive it actually wrote; that line is the authority for
    # "which key must be gone after the uninstall", not a guess from the process token.
    $writtenHive = ''
    if ($logText -match 'uninstall key written to (HKLM|HKCU)') {
        $writtenHive = $Matches[1]
    }
    return [ordered]@{
        label = $Label
        argv = $ArgString
        exitCode = $code
        seconds = $seconds
        logPath = $logPath
        logCopied = $copyPath
        logMismatch = $logMismatch
        registryHiveWritten = $writtenHive
        logHasUnpackMarker = $logText.Contains('解压程序文件')
        logHasCopyMarker = $logText.Contains('复制程序文件')
        logHasError = $logText.Contains('ERROR')
    }
}

# ---------------------------------------------------------------- argv probe (self-test)
# Runs the script's own Invoke-Setup once and reports what the installer answered.  This is
# the only way to prove that *this file* passes a quoted /DIR: a hand-typed equivalent
# command would prove nothing about the code path that failed on 2026-11-04.
if ($ProbeArgv) {
    Add-Line '--- argv probe (quoting self-test, nothing is installed) ---'
    Add-Line ("probe target: {0}  protected_root: {1}" -f $Dir, $(if ($protectedRoot) { $protectedRoot } else { '(none)' }))
    $probe = Invoke-Setup -ArgString ("/S /DIR=`"$Dir`"") -Label 'probe'
    $probeOk = ($probe.exitCode -eq 7)
    Add-Check -Name 'probe: quoted /DIR arrived as one argument (installer pre-check answered 7)' -Ok $probeOk -Detail ("exit={0}, {1}s" -f $probe.exitCode, $probe.seconds)
    if (-not $probeOk) {
        Add-Line 'probe: FAILED — exit 2 means the path was split again; a hang means a modal box came back.'
    }
    $probeFailed = @($script:Checks | Where-Object { -not $_.ok })
    $probeSummary = [ordered]@{
        runId = $runId
        mode = 'argv-probe'
        finishedAt = (Get-Date).ToString('o')
        user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        isElevated = $isAdmin
        protectedRoot = $protectedRoot
        setup = $Setup
        setupBytes = $setupInfo.Length
        target = $Dir
        probe = $probe
        checks = $script:Checks
        passed = ($script:Checks.Count - $probeFailed.Count)
        failed = $probeFailed.Count
        overall = $(if ($probeFailed.Count -eq 0) { 'PASS' } else { 'FAIL' })
    }
    $probeJson = Join-Path $EvidenceDir "$runId-argv-probe.json"
    $probeLogPath = Join-Path $EvidenceDir "$runId-argv-probe.log"
    $script:Lines | Set-Content -LiteralPath $probeLogPath -Encoding UTF8
    try { $probeSummary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $probeJson -Encoding UTF8 } catch { Add-Line "WARN probe evidence json not written: $($_.Exception.Message)" }
    Add-Line ("RESULT: {0} ({1} passed / {2} failed)" -f $probeSummary.overall, $probeSummary.passed, $probeSummary.failed)
    Add-Line "evidence: $probeJson"
    if ($probeFailed.Count -eq 0) { exit 0 }
    exit 1
}

# ---------------------------------------------------------------- install
$installResult = $null
$uninstallResult = $null

if (-not $Uninstall) {
    Add-Line '--- install ---'
    $installResult = Invoke-Setup -ArgString ("/S /DIR=`"$Dir`"") -Label 'install'
    $startedAt = Get-Date
    Add-Check -Name 'installer exit code 0' -Ok ($installResult.exitCode -eq 0) -Detail ("exit={0}, {1}s" -f $installResult.exitCode, $installResult.seconds)

    # --- install.json
    $record = $null
    if (Test-Path -LiteralPath $installRecordPath -PathType Leaf) {
        try {
            $record = Get-Content -LiteralPath $installRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            Add-Line "install.json: unreadable: $($_.Exception.Message)"
        }
    }
    Add-Check -Name 'install.json exists' -Ok ($null -ne $record) -Detail $installRecordPath
    if ($record) {
        $expectedVersion = '0.0.1-rc.3'
        Add-Line ("install.json: version={0} installPath={1} desktopExe={2} entryKind={3} payloadBuiltAt={4}" -f `
            $record.version, $record.installPath, $record.desktopExe, $record.entryKind, $record.payloadBuiltAt)
        Add-Check -Name 'install.json version is 0.0.1-rc.3' -Ok ("$($record.version)" -eq $expectedVersion) -Detail "version=$($record.version)"
        Add-Check -Name 'install.json installPath == -Dir' -Ok ([string]::Equals([string]$record.installPath, $Dir, [StringComparison]::OrdinalIgnoreCase)) -Detail "installPath=$($record.installPath)"
        $exePath = Join-Path $Dir ([string]$record.desktopExe)
        Add-Check -Name 'recorded desktop entry exists' -Ok (Test-Path -LiteralPath $exePath -PathType Leaf) -Detail $exePath
    }

    # --- uninstall registry entry
    $registry = Get-RegistryEntry
    Add-Check -Name 'uninstall registry entry exists' -Ok ($null -ne $registry) -Detail $(if ($registry) { "$($registry.hive):\$($registry.path)" } else { 'none' })
    if ($registry) {
        Add-Line ("registry: hive={0} DisplayVersion={1} InstallLocation={2}" -f $registry.hive, $registry.displayVersion, $registry.installLocation)
        Add-Check -Name 'registry InstallLocation == -Dir' -Ok ([string]::Equals([string]$registry.installLocation, $Dir, [StringComparison]::OrdinalIgnoreCase)) -Detail "InstallLocation=$($registry.installLocation)"
        if ($isAdmin) {
            # The whole point of a machine-wide install is the machine-wide entry: a
            # per-user key from an elevated run would be a silent downgrade.
            Add-Check -Name 'elevated run wrote HKLM (machine-wide) entry' -Ok ($registry.hive -eq 'HKLM') -Detail "hive=$($registry.hive)"
        }
    }
    $script:WrittenHive = if ($installResult -and $installResult.registryHiveWritten) {
        $installResult.registryHiveWritten
    } elseif ($registry) {
        $registry.hive
    } else {
        'HKLM'
    }
    Add-Line "registry: installer wrote to $script:WrittenHive (this is the key the uninstall must remove)"
    $otherHive = if ($script:WrittenHive -eq 'HKLM') { 'HKCU' } else { 'HKLM' }
    if (Test-RegistryKey -Hive "${otherHive}:") {
        Add-Line "note: a separate ${otherHive}: uninstall key already exists (pre-existing, not written by this run)"
    }

    # --- live /healthz
    if (-not $SkipHealth) {
        Add-Line '--- /healthz ---'
        # Candidates first, launch second, then wait for a *new* file among the candidates:
        # the directory name comes from the shell's own constant, not from a guess.
        $runtimeCandidates = Get-RuntimeCandidates
        foreach ($candidate in $runtimeCandidates) { Add-Line "runtime candidate: $candidate" }
        $runtimeBefore = @{}
        foreach ($candidate in $runtimeCandidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $runtimeBefore[$candidate] = (Get-Item -LiteralPath $candidate).LastWriteTimeUtc
            } else {
                $runtimeBefore[$candidate] = $null
            }
        }
        if ($record) {
            $shellExe = Join-Path $Dir ([string]$record.desktopExe)
            $existing = Get-ProcessesUnder -Root $Dir
            if ($existing.Count -eq 0) {
                Add-Line "launching: $shellExe --port 17801"
                $launch = Start-Process -FilePath $shellExe -ArgumentList '--port', '17801' -PassThru
            } else {
                Add-Line "already running under target: $($existing.Count) process(es)"
            }
        }
        $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
        $runtime = Get-RuntimeFreshPorts -Candidates $runtimeCandidates -Before $runtimeBefore -Deadline $deadline
        if ($runtime.ports) {
            Add-Line ("runtime.json: {0} ui_port={1} daemon_port={2}" -f $runtime.state, $runtime.ports.ui_port, $runtime.ports.daemon_port)
            $health = Get-Healthz -Ports $runtime.ports -Deadline $deadline
            Add-Line ("healthz attempts: {0}" -f $health.attempts)
        } else {
            Add-Line "runtime.json: no fresh file among the candidates within ${HealthTimeoutSec}s"
            $health = [ordered]@{ url = ''; status = 0; body = ''; attempts = 0; lastError = 'no fresh runtime.json' }
        }
        $script:HealthzEvidence = [ordered]@{ runtimeState = $runtime.state; health = $health }
        Add-Check -Name '/healthz returns 200' -Ok ($health.status -eq 200) -Detail $(
            if ($health.status -eq 200) { "$($health.url) -> 200 $($health.body)" }
            else { "no 200 (attempts=$($health.attempts), lastError=$($health.lastError), runtime=$($runtime.state))" }
        )
        # Stop what we started before uninstalling, so "no leftover process" is the
        # uninstaller's own result and not ours.
        foreach ($proc in (Get-ProcessesUnder -Root $Dir)) {
            try {
                Add-Line ("stopping pid={0} {1}" -f $proc.pid, $proc.name)
                Stop-Process -Id $proc.pid -Force -ErrorAction Stop
            } catch {
                Add-Line ("WARN could not stop pid={0}: {1}" -f $proc.pid, $_.Exception.Message)
            }
        }
        Start-Sleep -Seconds 2
    } else {
        Add-Line '--- /healthz: skipped (-SkipHealth) ---'
    }

    # --- uninstall
    Add-Line '--- uninstall ---'
    $uninstallResult = Invoke-Setup -ArgString ("/S /uninstall /DIR=`"$Dir`"") -Label 'uninstall'
    $startedAt = Get-Date
    Add-Check -Name 'uninstaller exit code 0' -Ok ($uninstallResult.exitCode -eq 0) -Detail ("exit={0}, {1}s" -f $uninstallResult.exitCode, $uninstallResult.seconds)
} elseif ($Uninstall) {
    # ------------------------------------------------------------ uninstall-only mode
    Add-Line '--- uninstall (requested) ---'
    $uninstallResult = Invoke-Setup -ArgString ("/S /uninstall /DIR=`"$Dir`"") -Label 'uninstall'
    Add-Check -Name 'uninstaller exit code 0' -Ok ($uninstallResult.exitCode -eq 0) -Detail ("exit={0}, {1}s" -f $uninstallResult.exitCode, $uninstallResult.seconds)
}

# ---------------------------------------------------------------- post-uninstall state
if ($uninstallResult) {
    Start-Sleep -Seconds 1
    Add-Check -Name 'install directory removed' -Ok (-not (Test-Path -LiteralPath $Dir)) -Detail $Dir
    Add-Check -Name 'install.json removed' -Ok (-not (Test-Path -LiteralPath $installRecordPath)) -Detail $installRecordPath
    $writtenHive = if ($script:WrittenHive) { $script:WrittenHive } elseif ($preState.registry) { $preState.registry.hive } else { 'HKLM' }
    # "Key gone" is too strict on this machine: an empty HKLM key (nine values absent) has
    # existed since an earlier non-elevated probe, and a non-elevated process can never
    # delete an HKLM key.  The question that actually matters is "does the key still carry
    # the values this install wrote?".
    $stillEntry = Get-RegistryEntry -Hive "${writtenHive}:"
    $emptyKeyLeft = (-not $stillEntry) -and (Test-RegistryKey -Hive "${writtenHive}:")
    Add-Check -Name "uninstall registry entry removed (${writtenHive}:)" -Ok ($null -eq $stillEntry) -Detail $(
        if ($stillEntry) {
            "values still present: DisplayVersion=$($stillEntry.displayVersion) InstallLocation=$($stillEntry.installLocation)"
        } elseif ($emptyKeyLeft) {
            'key exists but carries no values (pre-existing empty debris, not written by this run)'
        } else {
            'gone'
        }
    )
    foreach ($hive in @('HKLM', 'HKCU')) {
        if ($hive -eq $writtenHive) { continue }
        if (Test-RegistryKey -Hive "${hive}:") {
            Add-Line "note: unrelated ${hive}: uninstall key still present — not written by this run (pre-existing)"
            if (-not $isAdmin -and $hive -eq 'HKLM') {
                Add-Line 'note: a non-elevated process cannot delete an HKLM key; this is expected, not a failure'
            }
        }
    }
    $leftover = @(Get-ProcessesUnder -Root $Dir)
    Add-Check -Name 'no process left under the target' -Ok ($leftover.Count -eq 0) -Detail $(if ($leftover.Count -eq 0) { 'none' } else { ($leftover | ForEach-Object { "pid=$($_.pid)" }) -join ',' })
    if ($uninstallResult.logHasUnpackMarker) {
        Add-Line 'note: the uninstall run also logged the unpack marker (uninstall does not unpack; check the log pairing)'
    }
}

# ---------------------------------------------------------------- evidence
$failed = @($script:Checks | Where-Object { -not $_.ok })
$modeText = if ($Uninstall) { 'uninstall-only' } else { 'install-verify-uninstall' }
$summary = [ordered]@{
    runId = $runId
    startedAt = $startedAt.ToString('o')
    finishedAt = (Get-Date).ToString('o')
    user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    isElevated = $isAdmin
    protectedRoot = $protectedRoot
    setup = $Setup
    setupBytes = $setupInfo.Length
    target = $Dir
    mode = $modeText
    install = $installResult
    uninstall = $uninstallResult
    preState = $preState
    healthz = $script:HealthzEvidence
    checks = $script:Checks
    failed = $failed.Count
    passed = ($script:Checks.Count - $failed.Count)
    overall = if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' }
}
$jsonPath = Join-Path $EvidenceDir "$runId-evidence.json"
$logPath = Join-Path $EvidenceDir "$runId-transcript.log"
Add-Line '======================================================================'
Add-Line ("RESULT: {0} ({1} passed / {2} failed)" -f $summary.overall, $summary.passed, $summary.failed)
Add-Line "target was: $Dir"
Add-Line "elevated:   $isAdmin$(if ($protectedRoot) { "  (protected root $protectedRoot)" } else { '' })"
Add-Line '======================================================================'
foreach ($check in $failed) { Add-Line ("FAILED: {0}  {1}" -f $check.name, $check.detail) }

$script:Lines | Set-Content -LiteralPath $logPath -Encoding UTF8
try {
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
} catch {
    Add-Line "WARN evidence json not written: $($_.Exception.Message)"
}
Add-Line "evidence: $jsonPath"
Add-Line "transcript: $logPath"

if ($failed.Count -gt 0) { exit 1 }
exit 0
