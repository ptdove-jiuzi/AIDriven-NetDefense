# round-5 power-cut seat: one step at a time.
#
# POST-SHIP-PATH / powercut-r5. Task: prove what a power-cut *in the middle of the copy
# phase* of an rc.5 -> rc.6 overwrite upgrade does to (a) the directory, (b) the user data
# and (c) the user's ability to reinstall or uninstall.
#
# Serial protocol (hard): this script is only to be run after the upgrade seat
# (upgrade-r5) has released %TEMP%\upgrade-path\r5\WINDOW.lock and the Lead has said GO.
# Every step except -Step clone/resign/workdir asserts that lock is gone before touching
# an installer.
#
# Steps (each one is a separate process so a tool-call timeout can never lose the state):
#   preflight  verify read-only inputs, host baseline snapshot, back up %LOCALAPPDATA% data
#   cold       rc.5 factory Setup cold-installs the base tree            (~300-360 s)
#   seed       real product event-store writes synthetic user data into <base>\data
#   clone      robocopy the base tree into <point>\tree, re-issue the ownership credential
#   kill       rc.6 upgrade of the clone, killed (whole process family) in the copy phase
#   reinstall  immediate direct reinstall of rc.6 onto the half-new tree (expected refusal)
#   recovery   move data out -> delete tree -> clean rc.6 install -> move data back
#   control    same clone, same installer, NO kill -> completes (proves the kill caused it)
#   cleanup    tree-outside rc.6 uninstaller per tree, force-remove leftovers, clear host
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('preflight', 'cold', 'seed', 'clone', 'kill', 'reinstall', 'recovery', 'control', 'cleanup')]
  [string]$Step,

  [ValidateSet('K1', 'K2', 'CONTROL')][string]$Point = 'K1',

  # Kill delay measured from the moment the installer log says the copy started.
  [int]$KillAfterMs = -1,

  # Cold install switches. /NOREG /NOSHORTCUT keeps the host clean (no uninstall key, no
  # shortcuts); the task allows /NOREG as long as it is declared and no criterion depends
  # on the uninstall key. Autostart is never requested.
  [string[]]$InstallArgs = @('/NOREG', '/NOSHORTCUT'),

  # Already-installed rc.5 tree to clone from (Lead handoff: no second cold install).
  [string]$Source = '',

  [int]$SetupTimeoutSeconds = 1800
)
$ErrorActionPreference = 'Stop'

# Console + child-process output must round-trip UTF-8: the installer writes Chinese log
# lines and this repo's path contains CJK characters.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONDONTWRITEBYTECODE = '1'

$REPO = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$TOOLS = Join-Path $PSScriptRoot 'tools'
$EV = Join-Path $REPO 'evidence\upgrade\powercut\r5'
$WORK = Join-Path $env:TEMP 'upgrade-path\r5\powercut'
$WINDOW_LOCK = Join-Path $env:TEMP 'upgrade-path\r5\WINDOW.lock'
$BASE_TREE = Join-Path $WORK 'base'
if (-not $Source) { $Source = Join-Path $env:TEMP 'upgrade-path\r5\handoff-base-sceneA-pristine' }
$POINT_ROOT = Join-Path $WORK $Point
$TREE = Join-Path $POINT_ROOT 'tree'
$HOLD = Join-Path $POINT_ROOT 'holding'
$LA_PRODUCT = Join-Path $env:LOCALAPPDATA 'AIDriven NetDefense'
$LA_DATA = Join-Path $LA_PRODUCT 'data'
$LA_BACKUP = Join-Path $WORK 'host\la-product-backup'
$APP = Join-Path $REPO 'deploy\windows\installer\app'
$RC5 = Join-Path $REPO 'dist\release\0.0.1-rc.5\AIDrivenNetDefense-Setup-0.0.1-rc.5.exe'
$RC6 = Join-Path $REPO 'dist\release\0.0.1-rc.6\AIDrivenNetDefense-Setup-0.0.1-rc.6.exe'
$RC5_SHA = 'CA0297D0F4E8E7941BA1C3C2910E02380F01DF5AE70289B2BCB91F9C6070884A'
$RC6_SHA = '9BC1B3A79378ABDA1DF14BB110E594ED9F1B099F08E400F42BBFFF38A789057B'
$RC5_MANIFEST = Join-Path $EV 'manifests\rc5-manifest.sha256'
$RC6_MANIFEST = Join-Path $EV 'manifests\rc6-manifest.sha256'
$RC5_MANIFEST_SHA = '33C9FF45305DE4AE5D9098A6872A61D70C5CF889DB830260472E8E96A555E27B'
$RC6_MANIFEST_SHA = '6EC4051C166119196FE9696E599BA8A84EA384B72335B69364284B9136324D0C'
$RC6_EXE_SHA = '48716d63f0e22be78647bceafcf8bd5eca56f19753a841b0a2a697fb3fa56021'
$RC6_EXE_BYTES = 13918792
$PYTHON = 'D:\Python311\python.exe'
if (-not (Test-Path $PYTHON)) { $PYTHON = (Get-Command python -ErrorAction SilentlyContinue).Source }
$STARTED_AT = (Get-Date).ToString('o')

New-Item -ItemType Directory -Force -Path $EV, $WORK | Out-Null

# ------------------------------------------------------------------ helpers
function Write-Json([string]$Path, $Object, [int]$Depth = 10) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $Object | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $Path -Encoding UTF8
  Write-Output "wrote $Path"
}

function Get-Sha([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
  return $null
}

function Invoke-Tool([string]$Script, [hashtable]$Arguments) {
  & (Join-Path $TOOLS $Script) @Arguments
}

function Get-ForeignProcesses {
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'AIDrivenNetDefense-Setup|AIDrivenNetDefense\.exe' } |
      Select-Object ProcessId, ParentProcessId, Name, ExecutablePath)
}

function Assert-NoForeignInstaller([string]$Why) {
  # The protective WINDOW.lock is what keeps other seats from installing; a foreign
  # process is therefore recorded as contended, never killed (Lead instruction 17:10:
  # RC6-ACCEPT may start a dry-run the moment the lock disappears - it must not be touched).
  # Only a leftover installer *of this seat* (its command line names $WORK) aborts the step.
  $foreign = @(Get-ForeignProcesses)
  $mine = @($foreign | Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($WORK)) })
  if ($mine.Count -gt 0) {
    $mine | Format-Table -AutoSize | Out-String | Write-Output
    throw "ABORT ($Why): a leftover installer of THIS seat is still running ($($mine.ProcessId -join ',')); refusing to overlap it."
  }
  if ($foreign.Count -gt 0) {
    Write-Output "WARNING ($Why): $($foreign.Count) foreign AIDriven process(es) running (contended, not killed): $($foreign.ProcessId -join ',')"
  }
  return $foreign
}

function Assert-WindowFree([string]$Why) {
  # The upgrade seat released the window at 17:06:56; the Lead then created a protective
  # lock owned by this seat (17:10:18) so the RC6-ACCEPT wait-for-clean poller keeps
  # waiting. So "lock present" is fine as long as it is OURS.
  if (-not (Test-Path $WINDOW_LOCK)) { return }
  $owner = $null
  try { $owner = (Get-Content -LiteralPath $WINDOW_LOCK -Raw -Encoding UTF8 | ConvertFrom-Json).owner } catch { }
  if ($owner -and ($owner -match 'powercut-r5')) {
    Write-Output "window lock present, owner=$owner (this seat) - continuing ($Why)"
    return
  }
  throw "ABORT ($Why): $WINDOW_LOCK exists and is owned by '$owner', not by powercut-r5 - another seat owns the host window."
}

function Get-SetupLogs {
  return @(Get-ChildItem $env:TEMP -Filter 'AIDriven-Setup-*.log' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
}

function Read-LogText([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  try { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) } catch { return '' }
}

#: Locate this run's installer log by metadata only (the file is unreadable while the
#: installer holds it), then verify it can be read (i.e. the installer is gone).
function Resolve-RunLog([string[]]$Before, [datetime]$After) {
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    $candidates = @(Get-SetupLogs | Where-Object {
        ($Before -notcontains $_) -and ((Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue).CreationTime -ge $After.AddSeconds(-5))
      })
    if ($candidates.Count -gt 0) {
      $pick = $candidates | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending | Select-Object -First 1
      try { $null = [System.IO.File]::ReadAllBytes($pick); return $pick } catch { }
    }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Get-LogKeyLines([string]$Path, [string]$Out) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $patterns = '安装被拒|卸载被拒|复制程序文件|创建安装目录|写入安装记录|升级完成|安装完成|卸载完成|不是空目录|没有安装标记|归属凭据|WARN|ERROR|payload:|target:|版本|upgraded'
  $lines = @(Select-String -LiteralPath $Path -Pattern $patterns -Encoding UTF8 -ErrorAction SilentlyContinue |
      ForEach-Object { $_.Line.Trim() })
  if ($Out) {
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $lines | Set-Content -LiteralPath $Out -Encoding UTF8
  }
  return $lines
}

#: Start the factory Setup and wait, with a wall-clock guard.
function Invoke-SetupWait([string]$Setup, [string]$Target, [string]$LogOut, [string]$LogKeyOut) {
  $logsBefore = @(Get-SetupLogs)
  $runStartedAt = (Get-Date).ToString('o')
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $Setup -ArgumentList (@('/S', "/DIR=$Target") + $InstallArgs) -PassThru
  $null = $proc.Handle  # keep the handle so ExitCode is readable after exit
  $exited = $proc.WaitForExit($SetupTimeoutSeconds * 1000)
  $sw.Stop()
  if (-not $exited) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    throw "Setup did not exit within $SetupTimeoutSeconds s (killed): $Target"
  }
  $exitCode = $proc.ExitCode
  $log = $null
  foreach ($i in 0..30) {
    $log = @(Get-SetupLogs | Where-Object { $logsBefore -notcontains $_ } | Sort-Object { (Get-Item $_).LastWriteTime } -Descending | Select-Object -First 1)
    if ($log -and ((Read-LogText $log[0]) -match [regex]::Escape($Target))) { break }
    Start-Sleep -Milliseconds 300
  }
  $logPath = if ($log) { $log[0] } else { $null }
  if ($logPath -and $LogOut) { Copy-Item -LiteralPath $logPath -Destination $LogOut -Force }
  $keyLines = if ($logPath) { Get-LogKeyLines $logPath $LogKeyOut } else { @() }
  return [ordered]@{
    exitCode = $exitCode
    elapsedSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    logSource = $logPath
    logCopy = $LogOut
    keyLines = @($keyLines)
    target = $Target
    startedAt = $runStartedAt
  }
}

#: Distinguishable payload rows between the two generations, as {path; old; new}.
function Get-DistinguishableRows([string]$OldManifest, [string]$NewManifest) {
  function Read-Map([string]$Path) {
    $map = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith('#')) { continue }
      $idx = $t.IndexOf('  ')
      if ($idx -ne 64) { continue }
      $map[$t.Substring(66)] = $t.Substring(0, 64).ToLower()
    }
    return $map
  }
  $old = Read-Map $OldManifest
  $new = Read-Map $NewManifest
  $rows = @()
  foreach ($key in $old.Keys) {
    if ($new.ContainsKey($key) -and $new[$key] -ne $old[$key]) {
      $rows += [ordered]@{ path = $key; oldSha = $old[$key]; newSha = $new[$key] }
    }
  }
  return @($rows | Sort-Object { $_.path })
}

function Measure-Landed($Distinguishable, [string]$Root) {
  $landedNew = 0; $stillOld = 0; $other = 0; $missing = 0
  foreach ($row in $Distinguishable) {
    $file = Join-Path $Root ($row.path -replace '/', '\')
    if (-not (Test-Path -LiteralPath $file)) { $missing++; continue }
    $sha = $null
    try { $sha = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() } catch { $missing++; continue }
    if ($sha -eq $row.newSha) { $landedNew++ }
    elseif ($sha -eq $row.oldSha) { $stillOld++ }
    else { $other++ }
  }
  return [ordered]@{
    landedNew = $landedNew
    stillOld = $stillOld
    other = $other
    missing = $missing
    distinguishable = $Distinguishable.Count
    ratio = if ($Distinguishable.Count -gt 0) { [math]::Round($landedNew / $Distinguishable.Count, 4) } else { 0 }
  }
}

function Remove-Tree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  # rd is an order of magnitude faster than Remove-Item on 50k files; verify afterwards.
  & cmd.exe /c "rd /s /q `"$Path`"" 2>&1 | Out-Null
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue }
  return -not (Test-Path -LiteralPath $Path)
}

#: Every tree this seat created (base + one per kill point + the control).
function Get-ExperimentTrees {
  $trees = @($BASE_TREE)
  foreach ($name in @('K1', 'K2', 'CONTROL')) {
    $candidate = Join-Path (Join-Path $WORK $name) 'tree'
    if (Test-Path $candidate) { $trees += $candidate }
  }
  return @($trees | Select-Object -Unique)
}

#: Wall-clock start of this seat, taken from the preflight record (falls back to 8 h ago).
function Get-SeatStart {
  $path = Join-Path $EV 'preflight.json'
  if (Test-Path $path) {
    try { return [datetime](Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json).startedAt } catch { }
  }
  return (Get-Date).AddHours(-8)
}

# ------------------------------------------------------------------ step implementations
function Step-Preflight {
  $facts = [ordered]@{
    step = 'preflight'
    startedAt = $STARTED_AT
    repo = $REPO
    work = $WORK
    windowLockPresent = (Test-Path $WINDOW_LOCK)
    windowLockOwner = $null
    rc5 = [ordered]@{ path = $RC5; exists = (Test-Path $RC5); bytes = if (Test-Path $RC5) { (Get-Item $RC5).Length } else { $null }; sha256 = Get-Sha $RC5; expectedSha256 = $RC5_SHA }
    rc6 = [ordered]@{ path = $RC6; exists = (Test-Path $RC6); bytes = if (Test-Path $RC6) { (Get-Item $RC6).Length } else { $null }; sha256 = Get-Sha $RC6; expectedSha256 = $RC6_SHA }
    rc5Manifest = [ordered]@{ path = $RC5_MANIFEST; sha256 = Get-Sha $RC5_MANIFEST; expectedSha256 = $RC5_MANIFEST_SHA }
    rc6Manifest = [ordered]@{ path = $RC6_MANIFEST; sha256 = Get-Sha $RC6_MANIFEST; expectedSha256 = $RC6_MANIFEST_SHA }
    appDir = [ordered]@{ path = $APP; exists = (Test-Path (Join-Path $APP 'aidn\install.py')) }
    python = $PYTHON
    foreignProcesses = @(Get-ForeignProcesses)
    diskFreeGB = [math]::Round((Get-PSDrive ($env:SystemDrive.Substring(0, 1))).Free / 1GB, 1)
    installArgs = @($InstallArgs)
    laProductExists = (Test-Path $LA_PRODUCT)
    laDataExists = (Test-Path $LA_DATA)
  }
  if ($facts.rc5.sha256 -ne $RC5_SHA) { throw "rc.5 Setup sha256 mismatch: $($facts.rc5.sha256)" }
  if ($facts.rc6.sha256 -ne $RC6_SHA) { throw "rc.6 Setup sha256 mismatch: $($facts.rc6.sha256)" }
  if ($facts.rc5Manifest.sha256 -ne $RC5_MANIFEST_SHA) { throw "rc.5 manifest copy sha256 mismatch: $($facts.rc5Manifest.sha256)" }
  if ($facts.rc6Manifest.sha256 -ne $RC6_MANIFEST_SHA) { throw "rc.6 manifest copy sha256 mismatch: $($facts.rc6Manifest.sha256)" }

  Invoke-Tool 'host-snapshot.ps1' @{ Out = (Join-Path $EV 'host\before.json'); Label = 'before-r5' } | Out-Null
  if (Test-Path $LA_DATA) {
    Invoke-Tool 'fingerprint.ps1' @{ Path = $LA_DATA; Out = (Join-Path $EV 'host\la-data-before.tsv') } | Out-Null
  }
  if ((Test-Path $LA_PRODUCT) -and -not (Test-Path $LA_BACKUP)) {
    & robocopy $LA_PRODUCT $LA_BACKUP /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
    $facts.laBackup = [ordered]@{ path = $LA_BACKUP; robocopyExit = $LASTEXITCODE }
  }
  Write-Json (Join-Path $EV 'preflight.json') $facts
  $lockOwner = $null
  if ($facts.windowLockPresent) {
    try { $lockOwner = (Get-Content -LiteralPath $WINDOW_LOCK -Raw -Encoding UTF8 | ConvertFrom-Json).owner } catch { }
    if ($lockOwner -and ($lockOwner -match 'powercut-r5')) {
      Write-Output "window lock present and owned by $lockOwner (this seat) - OK to proceed"
    } else {
      Write-Output "WARNING: WINDOW.lock present and owned by '$lockOwner' (not this seat) - do not proceed past preflight."
    }
  }
  if ($facts.foreignProcesses.Count -gt 0) { Write-Output "WARNING: $($facts.foreignProcesses.Count) foreign AIDriven process(es) present (contended; the lock is what keeps them out)" }
}

function Step-Cold {
  Assert-WindowFree 'cold install'
  Assert-NoForeignInstaller 'cold install'
  if (Test-Path $BASE_TREE) { throw "base tree already exists: $BASE_TREE (refusing to overwrite evidence)" }
  New-Item -ItemType Directory -Force -Path $POINT_ROOT, $HOLD | Out-Null
  Invoke-Tool 'host-snapshot.ps1' @{ Out = (Join-Path $EV 'host\before-cold.json'); Label = 'before-cold' } | Out-Null

  $run = Invoke-SetupWait $RC5 $BASE_TREE (Join-Path $EV 'cold\cold-install-rc5.log') (Join-Path $EV 'cold\cold-install-key-lines.txt')
  Invoke-Tool 'tree-state.ps1' @{ Root = $BASE_TREE; Out = (Join-Path $EV 'cold\tree-state.json'); Label = 'after-cold-install' } | Out-Null
  $state = Get-Content (Join-Path $EV 'cold\tree-state.json') -Raw | ConvertFrom-Json
  $record = if (Test-Path (Join-Path $BASE_TREE 'install\install.json')) { Get-Content (Join-Path $BASE_TREE 'install\install.json') -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  if ($record) { Write-Json (Join-Path $EV 'cold\install-json.json') $record }
  $probe = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $APP $BASE_TREE
  $probe | Set-Content -LiteralPath (Join-Path $EV 'cold\marker-probe.json') -Encoding UTF8

  $result = [ordered]@{
    step = 'cold'
    setup = $RC5
    setupSha256 = $RC5_SHA
    installArgs = @($InstallArgs + "/DIR=$BASE_TREE")
    run = $run
    treeState = $state
    installJsonVersion = if ($record) { $record.version } else { $null }
    installJsonUpgradedFrom = if ($record) { $record.upgradedFrom } else { $null }
    manifestSha256MatchesRc5 = ($state.manifestSha256 -eq $RC5_MANIFEST_SHA)
    markerProbe = ($probe | ConvertFrom-Json)
    verdict = [ordered]@{
      exitCodeZero = ($run.exitCode -eq 0)
      versionIsRc5 = ($record -and $record.version -eq '0.0.1-rc.5')
      upgradedFromNull = ($record -and -not $record.upgradedFrom)
      manifestIsRc5 = ($state.manifestSha256 -eq $RC5_MANIFEST_SHA)
    }
  }
  Write-Json (Join-Path $EV 'cold\cold-install.json') $result
  Invoke-Tool 'host-snapshot.ps1' @{ Out = (Join-Path $EV 'host\after-cold.json'); Label = 'after-cold' } | Out-Null
}

function Initialize-DataChannel([string]$Tree, [string]$EvDir, [string]$Label) {
  # A real user has files under data\ that an upgrade must not touch. Seed them with the
  # product's own event store (not a hand-written sqlite file) so "opened=true +
  # hmacVerified" is a statement about the product, not about sqlite.
  $dataDir = Join-Path $Tree 'data'
  if (Test-Path $dataDir) { Remove-Tree $dataDir | Out-Null }
  $seed = & node (Join-Path $TOOLS 'seed-data.mjs') --data-dir $dataDir --events 120 --sentinel '断电实验哨兵：复制中断后这行必须原样还在。'
  $seed | Set-Content -LiteralPath (Join-Path $EvDir 'seed-data.json') -Encoding UTF8
  Invoke-Tool 'fingerprint.ps1' @{ Path = $dataDir; Out = (Join-Path $EvDir 'target-data-before.tsv') } | Out-Null
  $open = & node (Join-Path $TOOLS 'open-store.mjs') --db (Join-Path $dataDir 'store\aegis.db')
  $open | Set-Content -LiteralPath (Join-Path $EvDir 'open-store-baseline.json') -Encoding UTF8
  return [ordered]@{
    label = $Label
    dataDir = $dataDir
    seed = ($seed | ConvertFrom-Json)
    openStore = ($open | ConvertFrom-Json)
  }
}

function Step-Seed {
  # Fallback path only (cold-installed base tree). The normal path seeds each clone in
  # Step-Clone, because the Lead handed over an already-installed rc.5 tree.
  $tree = if (Test-Path (Join-Path $BASE_TREE 'install\install.json')) { $BASE_TREE } elseif (Test-Path (Join-Path $TREE 'install\install.json')) { $TREE } else { throw 'no base tree to seed' }
  $pointEv = if ($tree -eq $BASE_TREE) { Join-Path $EV 'base' } else { Join-Path $EV $Point }
  New-Item -ItemType Directory -Force -Path $pointEv | Out-Null
  $seeded = Initialize-DataChannel $tree $pointEv 'seed'
  Invoke-Tool 'tree-state.ps1' @{ Root = $tree; Out = (Join-Path $pointEv 'tree-state.json'); Label = 'after-seed' } | Out-Null
  Write-Output "seeded: $($seeded.seed | ConvertTo-Json -Compress)"
}

function Step-Clone {
  Assert-WindowFree 'clone'
  if (-not (Test-Path (Join-Path $Source 'AIDrivenNetDefense.exe'))) { throw "clone source tree missing: $Source" }
  if (Test-Path $TREE) { throw "point tree already exists: $TREE (refusing to overwrite evidence)" }
  New-Item -ItemType Directory -Force -Path $POINT_ROOT | Out-Null
  $pointEv = Join-Path $EV $Point
  New-Item -ItemType Directory -Force -Path $pointEv | Out-Null

  # the source is evidence handed over by the upgrade seat: record what it is before touching
  Invoke-Tool 'tree-state.ps1' @{ Root = $Source; Out = (Join-Path $EV 'source\tree-state.json'); Label = 'handoff-source' } | Out-Null
  & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $APP $Source | Set-Content -LiteralPath (Join-Path $EV 'source\marker-probe.json') -Encoding UTF8

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & robocopy $Source $TREE /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
  $rcExit = $LASTEXITCODE
  $sw.Stop()
  if ($rcExit -ge 8) { throw "robocopy clone failed with exit code $rcExit" }

  Invoke-Tool 'tree-state.ps1' @{ Root = $TREE; Out = (Join-Path $pointEv 'tree-state-as-cloned.json'); Label = 'as-cloned' } | Out-Null
  $probeAsCopied = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $APP $TREE
  $probeAsCopied | Set-Content -LiteralPath (Join-Path $pointEv 'marker-probe-as-copied.json') -Encoding UTF8
  $resign = & $PYTHON (Join-Path $TOOLS 'resign-clone.py') --app $APP --tree $TREE --out (Join-Path $pointEv 'resign-clone.json')
  $probeAfter = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $APP $TREE
  $probeAfter | Set-Content -LiteralPath (Join-Path $pointEv 'marker-probe-at-base.json') -Encoding UTF8

  # user data channel: real event-store seed, then the baseline fingerprint every later
  # step is compared against
  $seeded = Initialize-DataChannel $TREE $pointEv 'clone'
  Invoke-Tool 'tree-state.ps1' @{ Root = $TREE; Out = (Join-Path $pointEv 'tree-state-at-base.json'); Label = 'at-base-after-resign' } | Out-Null

  $sourceState = Get-Content (Join-Path $EV 'source\tree-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $cloneState = Get-Content (Join-Path $pointEv 'tree-state-at-base.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Json (Join-Path $pointEv 'clone-result.json') ([ordered]@{
      step = 'clone'; point = $Point; source = $Source; destination = $TREE
      robocopyExit = $rcExit; elapsedSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
      sourceState = $sourceState; cloneState = $cloneState
      asCopiedMarkerProbe = ($probeAsCopied | ConvertFrom-Json)
      resignClone = ($resign | ConvertFrom-Json)
      afterResignMarkerProbe = ($probeAfter | ConvertFrom-Json)
      seededDataChannel = $seeded
      verdict = [ordered]@{
        exeEqual = ($sourceState.exeSha256 -eq $cloneState.exeSha256)
        manifestEqual = ($sourceState.manifestSha256 -eq $cloneState.manifestSha256)
        cloneVersionIsRc5 = ($cloneState.installJsonVersion -eq '0.0.1-rc.5')
        asCopiedInstallMarkerIsNull = ($null -eq ($probeAsCopied | ConvertFrom-Json).installMarker)
        installMarkerNonNilAfterResign = ($null -ne ($probeAfter | ConvertFrom-Json).installMarker)
        upgradeMarkerNonNilAfterResign = ($null -ne ($probeAfter | ConvertFrom-Json).upgradeMarker)
        dataSeedEventCount = $seeded.seed.eventCount
        dataSeedStoreOpens = ($seeded.openStore.opened -eq $true)
        dataSeedAuditHmacVerified = ($seeded.openStore.auditChain.hmacVerified -eq $true)
      }
    })
  Write-Output "clone done: $TREE (robocopy=$rcExit, $([math]::Round($sw.Elapsed.TotalSeconds,1))s) seedEvents=$($seeded.seed.eventCount) installMarker=$((($probeAfter | ConvertFrom-Json).installMarker))"
}

function Step-Kill {
  Assert-WindowFree 'kill'
  Assert-NoForeignInstaller 'kill'
  $pointEv = Join-Path $EV $Point
  if (-not (Test-Path (Join-Path $TREE 'AIDrivenNetDefense.exe'))) { throw "point tree missing: $TREE" }
  $delayMs = if ($KillAfterMs -ge 0) { $KillAfterMs } else { if ($Point -eq 'K2') { 75000 } else { 1500 } }

  Invoke-Tool 'host-snapshot.ps1' @{ Out = (Join-Path $pointEv 'host-before-kill.json'); Label = 'before-kill' } | Out-Null
  # Pre-kill sanity: on the healthy rc.5 clone none of the rc.6 rows have landed yet.
  $preAudit = & $PYTHON (Join-Path $TOOLS 'manifest-audit.py') --old $RC5_MANIFEST --new $RC6_MANIFEST --tree $TREE --out (Join-Path $pointEv 'manifest-audit-pre-kill.json') --app $APP
  $preAudit | Set-Content -LiteralPath (Join-Path $pointEv 'manifest-audit-pre-kill.stdout.json') -Encoding UTF8
  Write-Output "pre-kill audit: $preAudit"
  $preKillDetails = (Get-Content (Join-Path $pointEv 'manifest-audit-pre-kill.json') -Raw -Encoding UTF8 | ConvertFrom-Json).details
  $distinguishable = @($preKillDetails | ForEach-Object { [ordered]@{ path = $_.path; oldSha = $_.oldSha256; newSha = $_.newSha256 } })

  $treeStateBefore = Get-Content (Join-Path $pointEv 'tree-state-at-base.json') -Raw | ConvertFrom-Json
  $logsBefore = @(Get-SetupLogs)
  $exePath = Join-Path $TREE 'AIDrivenNetDefense.exe'
  $manifestPath = Join-Path $TREE 'manifests\files.sha256'
  $baseExeSha = $treeStateBefore.exeSha256
  $baseManifestBytes = $treeStateBefore.manifestBytes
  $trigger = $null
  $proc = Start-Process -FilePath $RC6 -ArgumentList (@('/S', "/DIR=$TREE") + $InstallArgs) -PassThru
  $setupPid = $proc.Id
  $launchedAt = Get-Date
  Write-Output "upgrade launched pid=$setupPid target=$TREE delayMs=$delayMs"

  # --- wait for the content-defined kill window to open -----------------------------
  # Measured at 17:13-17:15: while the installer runs, its log file is opened in a way
  # that denies concurrent reads (every ReadAllText / Get-Content attempt threw "the file
  # is being used by another process"), so the log CANNOT be polled for the copy-phase
  # line. The tree itself is the signal and it is the same signal the shipped guards read:
  # the entry exe is the first data row of the payload manifest and is rewritten at the
  # start of the copy, while manifests\files.sha256 stays the rc.5 file until the very end.
  $windowOpen = $null
  $waitDeadline = (Get-Date).AddMinutes(30)
  while (-not $windowOpen) {
    if ($proc.HasExited) { $trigger = 'installer-exited-before-window'; break }
    $exeLen = if (Test-Path -LiteralPath $exePath) { (Get-Item -LiteralPath $exePath).Length } else { $null }
    $manifestLen = if (Test-Path -LiteralPath $manifestPath) { (Get-Item -LiteralPath $manifestPath).Length } else { $null }
    if ($exeLen -eq $RC6_EXE_BYTES -and $manifestLen -eq $baseManifestBytes) {
      try {
        $sha = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLower()
        if ($sha -eq $RC6_EXE_SHA) { $windowOpen = (Get-Date); break }
      } catch { }
    } elseif (($null -ne $manifestLen) -and ($manifestLen -ne $baseManifestBytes)) {
      $trigger = 'window-lost-manifest-already-new'
      break
    }
    if ((Get-Date) -gt $waitDeadline) { $trigger = 'window-never-opened-30min'; break }
    Start-Sleep -Milliseconds 500
  }

  $copyStart = $windowOpen
  $timeline = New-Object System.Collections.Generic.List[object]
  $samples = New-Object System.Collections.Generic.List[object]
  $lastSampleSec = -100
  if ($windowOpen) {
    Write-Output "kill window opened at $($windowOpen.ToString('o')) (entry exe is rc.6 bytes, manifest still rc.5)"
    while ($true) {
      $elapsedMs = [int]((Get-Date) - $copyStart).TotalMilliseconds
      $exeLen = if (Test-Path -LiteralPath $exePath) { (Get-Item -LiteralPath $exePath).Length } else { $null }
      $manifestLen = if (Test-Path -LiteralPath $manifestPath) { (Get-Item -LiteralPath $manifestPath).Length } else { $null }
      $exited = $proc.HasExited
      $timeline.Add([ordered]@{ at = (Get-Date).ToString('o'); elapsedMs = $elapsedMs; exeLen = $exeLen; manifestLen = $manifestLen; setupExited = $exited })
      if ($exited) { $trigger = 'installer-exited-before-kill'; break }
      if (($null -ne $manifestLen) -and ($manifestLen -ne $baseManifestBytes)) {
        $trigger = 'window-closed-manifest-new'; break
      }
      if ($elapsedMs -ge $delayMs) { $trigger = 'exe-changed-manifest-old'; break }
      if ($elapsedMs -ge 900000) { $trigger = 'timeout-fallback-900s'; break }
      $elapsedSec = [int]($elapsedMs / 1000)
      if ($elapsedSec -ge ($lastSampleSec + 10)) {
        $lastSampleSec = $elapsedSec
        $sampled = Measure-Landed $distinguishable $TREE
        $samples.Add([ordered]@{ at = (Get-Date).ToString('o'); elapsedMs = $elapsedMs; landed = $sampled })
      }
      Start-Sleep -Milliseconds 100
    }
  }

  $killedAt = Get-Date
  if (-not $windowOpen -or $proc.HasExited -or ($trigger -ne 'exe-changed-manifest-old')) {
    # No power-cut evidence from this attempt: record why, leave the tree alone, and throw
    # so the caller cannot mistake this for a completed kill point.
    $logPath = Resolve-RunLog $logsBefore $launchedAt
    if ($logPath) { Copy-Item -LiteralPath $logPath -Destination (Join-Path $pointEv 'killed-run-aborted.log') -Force }
    Write-Json (Join-Path $pointEv 'kill-result.json') ([ordered]@{
        step = 'kill'; point = $Point; aborted = $true; trigger = $trigger
        note = 'no kill performed: the content-defined window was not available (installer exited or the manifest moved first). No power-cut evidence from this attempt.'
        setupPid = $setupPid; launchedAt = $launchedAt.ToString('o')
        elapsedMsFromWindow = if ($windowOpen) { [int](($killedAt - $windowOpen).TotalMilliseconds) } else { $null }
        log = $logPath; timeline = $timeline.ToArray(); landedSamples = $samples.ToArray()
      })
    throw "kill not performed: $trigger"
  }
  if ($proc.HasExited) {
    $result = [ordered]@{
      step = 'kill'; point = $Point; aborted = $true; trigger = $trigger
      note = 'the installer finished before the kill condition was met - no kill performed, no power-cut evidence from this run'
      setupPid = $setupPid; elapsedMsFromCopyStart = [int](($killedAt - $copyStart).TotalMilliseconds)
      log = $logPath; timeline = $timeline.ToArray(); landedSamples = $samples.ToArray()
    }
    Copy-Item -LiteralPath $logPath -Destination (Join-Path $pointEv 'killed-run.log') -Force
    Write-Json (Join-Path $pointEv 'kill-result.json') $result
    throw "kill not performed: $trigger (installer already exited)"
  }

  $familyOut = Join-Path $pointEv 'killed-process-family.json'
  Invoke-Tool 'process-family.ps1' @{ ImagePath = $RC6; RootPid = $setupPid; Kill = $true; Out = $familyOut; Label = "kill-$Point"; VerifySeconds = 20 } | Out-Null
  Start-Sleep -Milliseconds 700
  $family = Get-Content $familyOut -Raw -Encoding UTF8 | ConvertFrom-Json

  $logPath = Resolve-RunLog $logsBefore $launchedAt
  if ($logPath) {
    Copy-Item -LiteralPath $logPath -Destination (Join-Path $pointEv 'killed-run.log') -Force
    $runLogText = Read-LogText $logPath
    $runLogText | Set-Content -LiteralPath (Join-Path $pointEv 'killed-run.log.txt') -Encoding UTF8
    Write-Output "run log: $logPath ($($runLogText.Length) chars)"
  } else {
    Write-Output 'WARNING: could not resolve this run''s installer log even after the kill'
  }
  Invoke-Tool 'tree-state.ps1' @{ Root = $TREE; Out = (Join-Path $pointEv 'tree-state-at-kill.json'); Label = 'at-kill' } | Out-Null
  Invoke-Tool 'fingerprint.ps1' @{ Path = (Join-Path $TREE 'data'); Out = (Join-Path $pointEv 'target-data-at-kill.tsv') } | Out-Null
  if (Test-Path $LA_DATA) { Invoke-Tool 'fingerprint.ps1' @{ Path = $LA_DATA; Out = (Join-Path $pointEv 'la-data-at-kill.tsv') } | Out-Null }
  $auditRaw = & $PYTHON (Join-Path $TOOLS 'manifest-audit.py') --old $RC5_MANIFEST --new $RC6_MANIFEST --tree $TREE --out (Join-Path $pointEv 'manifest-audit-at-kill.json') --app $APP
  $auditRaw | Set-Content -LiteralPath (Join-Path $pointEv 'manifest-audit-at-kill.stdout.json') -Encoding UTF8
  Write-Output "at-kill audit: $auditRaw"
  $probeRaw = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $APP $TREE
  $probeRaw | Set-Content -LiteralPath (Join-Path $pointEv 'marker-probe-at-kill.json') -Encoding UTF8
  Write-Output "at-kill marker probe: $probeRaw"
  if ($logPath) { Get-LogKeyLines $logPath (Join-Path $pointEv 'killed-run-key-lines.txt') | Out-Null }

  $atKill = Get-Content (Join-Path $pointEv 'tree-state-at-kill.json') -Raw | ConvertFrom-Json
  $audit = Get-Content (Join-Path $pointEv 'manifest-audit-at-kill.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $probe = Get-Content (Join-Path $pointEv 'marker-probe-at-kill.json') -Raw -Encoding UTF8 | ConvertFrom-Json

  Write-Json (Join-Path $pointEv 'kill-result.json') ([ordered]@{
      step = 'kill'; point = $Point; aborted = $false
      baseTree = $BASE_TREE; cloneTree = $TREE
      setup = $RC6; setupSha256 = $RC6_SHA; setupPid = $setupPid
      launchedAt = $launchedAt.ToString('o')
      copyPhaseStartedAt = $copyStart.ToString('o')
      killedAt = $killedAt.ToString('o')
      copyElapsedMsAtKill = [int](($killedAt - $copyStart).TotalMilliseconds)
      requestedDelayMs = $delayMs
      trigger = $trigger
      timeline = $timeline.ToArray()
      landedSamplesDuringCopy = $samples.ToArray()
      killedProcessFamily = $family
      treeBefore = $treeStateBefore
      treeAtKill = $atKill
      manifestAuditAtKill = [ordered]@{
        distinguishableCount = $audit.distinguishableCount
        landedNew = $audit.landedNew
        stillOld = $audit.stillOld
        other = $audit.other
        missing = $audit.missing
        landedRatioOfDistinguishable = $audit.landedRatioOfDistinguishable
        firstDataRow = $audit.firstDataRow
        headOldLines = $audit.headOldLines
        manifestHasRowsByShippedRuleOld = $audit.shippedSamplingWindow.old.manifestHasRowsByShippedRule
        manifestHasRowsByShippedRuleNew = $audit.shippedSamplingWindow.new.manifestHasRowsByShippedRule
        sampledRowCount = $audit.shippedSamplingWindow.old.rowsChecked
        sampledMismatchFirst = $audit.shippedSamplingWindow.old.mismatched | Select-Object -First 6
      }
      markerProbeAtKill = $probe
      verdict = [ordered]@{
        entryExeIsRc6 = ($atKill.exeSha256 -ne $treeStateBefore.exeSha256)
        manifestStillRc5 = ($atKill.manifestSha256 -eq $treeStateBefore.manifestSha256)
        installRecordStillRc5 = ($atKill.installJsonVersion -eq '0.0.1-rc.5')
        killVerifiedZeroAlive = ($family.killVerified -eq $true)
        installMarkerNull = ($null -eq $probe.installMarker)
        upgradeMarkerNull = ($null -eq $probe.upgradeMarker)
        manifestHasRowsFalse = ($probe.manifestHasRows -eq $false)
      }
    })
  Invoke-Tool 'host-snapshot.ps1' @{ Out = (Join-Path $pointEv 'host-after-kill.json'); Label = 'after-kill' } | Out-Null
  Write-Output "killed pids=[$($family.processIds -join ',')] aliveAfter=$($family.aliveAfterCount) trigger=$trigger copyElapsedMs=$([int](($killedAt - $copyStart).TotalMilliseconds)) landedNew=$($audit.landedNew)/$($audit.distinguishableCount)"
}

function Step-Reinstall {
  Assert-WindowFree 'direct reinstall'
  Assert-NoForeignInstaller 'direct reinstall'
  $pointEv = Join-Path $EV $Point
  Invoke-Tool 'tree-state.ps1' @{ Root = $TREE; Out = (Join-Path $pointEv 'tree-state-before-reinstall.json'); Label = 'before-direct-reinstall' } | Out-Null
  Invoke-Tool 'fingerprint.ps1' @{ Path = (Join-Path $TREE 'data'); Out = (Join-Path $pointEv 'target-data-before-reinstall.tsv') } | Out-Null
  $before = Get-Content (Join-Path $pointEv 'tree-state-before-reinstall.json') -Raw | ConvertFrom-Json

  $run = Invoke-SetupWait $RC6 $TREE (Join-Path $pointEv 'direct-reinstall.log') (Join-Path $pointEv 'direct-reinstall-key-lines.txt')
  Invoke-Tool 'tree-state.ps1' @{ Root = $TREE; Out = (Join-Path $pointEv 'tree-state-after-reinstall.json'); Label = 'after-direct-reinstall' } | Out-Null
  Invoke-Tool 'fingerprint.ps1' @{ Path = (Join-Path $TREE 'data'); Out = (Join-Path $pointEv 'target-data-after-reinstall.tsv') } | Out-Null
  Invoke-Tool 'compare-fingerprint.ps1' @{
    Before = (Join-Path $pointEv 'target-data-at-kill.tsv'); After = (Join-Path $pointEv 'target-data-after-reinstall.tsv');
    Out    = (Join-Path $pointEv 'target-data-reinstall-diff.json')
  } | Out-Null
  $after = Get-Content (Join-Path $pointEv 'tree-state-after-reinstall.json') -Raw | ConvertFrom-Json
  $dataDiff = Get-Content (Join-Path $pointEv 'target-data-reinstall-diff.json') -Raw | ConvertFrom-Json
  $probe = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $APP $TREE
  $probe | Set-Content -LiteralPath (Join-Path $pointEv 'marker-probe-after-reinstall.json') -Encoding UTF8

  $zeroWrites = ($after.inventoryDigest -eq $before.inventoryDigest) -and ($after.fileCount -eq $before.fileCount) -and
  ($after.exeSha256 -eq $before.exeSha256) -and ($after.manifestSha256 -eq $before.manifestSha256) -and
  ($after.installJsonSha256 -eq $before.installJsonSha256) -and ($after.bundleJsonSha256 -eq $before.bundleJsonSha256)

  Write-Json (Join-Path $pointEv 'reinstall-attempt.json') ([ordered]@{
      step = 'reinstall'; point = $Point; setup = $RC6; setupSha256 = $RC6_SHA
      run = $run
      treeBefore = $before; treeAfter = $after
      inventoryDigestEqual = ($after.inventoryDigest -eq $before.inventoryDigest)
      zeroWrites = $zeroWrites
      dataDiff = $dataDiff
      markerProbeAfter = ($probe | ConvertFrom-Json)
      verdict = [ordered]@{
        exitCodeNonZero = ($run.exitCode -ne 0)
        exitCode = $run.exitCode
        zeroWrites = $zeroWrites
        dataUntouched = ($dataDiff.differenceCount -eq 0)
        refusedBecauseNotAnInstall = (@($run.keyLines | Where-Object { $_ -match '不是空目录|没有安装标记' }).Count -gt 0)
      }
    })
  Write-Output "direct reinstall: exit=$($run.exitCode) elapsed=$($run.elapsedSeconds)s zeroWrites=$zeroWrites dataDiff=$($dataDiff.differenceCount)"
}

function Step-Recovery {
  Assert-WindowFree 'recovery'
  Assert-NoForeignInstaller 'recovery'
  $pointEv = Join-Path $EV $Point
  New-Item -ItemType Directory -Force -Path $HOLD | Out-Null
  $moved = [ordered]@{}

  # 1) both data channels out of the way
  if (Test-Path (Join-Path $TREE 'data')) {
    if (Test-Path (Join-Path $HOLD 'target-data')) { Remove-Tree (Join-Path $HOLD 'target-data') | Out-Null }
    Move-Item -LiteralPath (Join-Path $TREE 'data') -Destination (Join-Path $HOLD 'target-data') -Force
    $moved.targetData = 'moved'
  }
  if (Test-Path $LA_PRODUCT) {
    if (Test-Path (Join-Path $HOLD 'la-product')) { Remove-Tree (Join-Path $HOLD 'la-product') | Out-Null }
    Move-Item -LiteralPath $LA_PRODUCT -Destination (Join-Path $HOLD 'la-product') -Force
    $moved.laProduct = 'moved'
  }
  $treeDataMoved = (-not (Test-Path (Join-Path $TREE 'data')))
  $laMoved = (-not (Test-Path $LA_PRODUCT))
  Write-Output "moved out: $($moved | ConvertTo-Json -Compress) treeDataMoved=$treeDataMoved laMoved=$laMoved"

  # 2) delete the half-new tree
  $entriesBefore = @(Get-ChildItem -LiteralPath $TREE -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  $removed = Remove-Tree $TREE
  Write-Output "tree removed=$removed entriesWere=$($entriesBefore -join ',')"

  # 3) clean rc.6 install into the now-empty target
  $run = Invoke-SetupWait $RC6 $TREE (Join-Path $pointEv 'recovery-clean-install.log') (Join-Path $pointEv 'recovery-clean-install-key-lines.txt')
  Invoke-Tool 'tree-state.ps1' @{ Root = $TREE; Out = (Join-Path $pointEv 'tree-state-after-clean-install.json'); Label = 'after-clean-install' } | Out-Null

  # 4) data back
  if (Test-Path (Join-Path $HOLD 'target-data')) { Move-Item -LiteralPath (Join-Path $HOLD 'target-data') -Destination (Join-Path $TREE 'data') -Force }
  if (Test-Path (Join-Path $HOLD 'la-product')) { Move-Item -LiteralPath (Join-Path $HOLD 'la-product') -Destination $LA_PRODUCT -Force }
  Write-Output 'data moved back'

  # 5) byte-identity + the product can still open the store
  Invoke-Tool 'fingerprint.ps1' @{ Path = (Join-Path $TREE 'data'); Out = (Join-Path $pointEv 'target-data-after-restore.tsv') } | Out-Null
  Invoke-Tool 'compare-fingerprint.ps1' @{
    Before = (Join-Path $pointEv 'target-data-before.tsv'); After = (Join-Path $pointEv 'target-data-after-restore.tsv');
    Out    = (Join-Path $pointEv 'target-data-restore-diff.json')
  } | Out-Null
  # Second data channel: the product's %LOCALAPPDATA% data. Recorded separately and with its
  # own error channel, because a missing comparison must never silently read as "0 diff".
  $laChannelError = $null
  if (-not (Test-Path $LA_PRODUCT)) {
    $laChannelError = 'local-appdata product directory missing after restore'
  } else {
    try {
      Invoke-Tool 'fingerprint.ps1' @{ Path = $LA_DATA; Out = (Join-Path $pointEv 'la-data-after-restore.tsv') } | Out-Null
      Invoke-Tool 'compare-fingerprint.ps1' @{
        Before = (Join-Path $EV 'host\la-data-before.tsv'); After = (Join-Path $pointEv 'la-data-after-restore.tsv');
        Out    = (Join-Path $pointEv 'la-data-restore-diff.json')
      } | Out-Null
    } catch {
      $laChannelError = "$($_.Exception.Message)"
    }
    if (-not (Test-Path (Join-Path $pointEv 'la-data-restore-diff.json'))) { $laChannelError = 'comparison file not produced' }
  }
  $dbPath = Join-Path $TREE 'data\store\aegis.db'
  $open = if (Test-Path $dbPath) { & node (Join-Path $TOOLS 'open-store.mjs') --db $dbPath } else { '{"opened":false,"error":"no db"}' }
  $open | Set-Content -LiteralPath (Join-Path $pointEv 'open-store-after-restore.json') -Encoding UTF8
  Write-Output "open-store: $open"
  $probe = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $APP $TREE
  $probe | Set-Content -LiteralPath (Join-Path $pointEv 'marker-probe-after-recovery.json') -Encoding UTF8

  $targetDiff = Get-Content (Join-Path $pointEv 'target-data-restore-diff.json') -Raw | ConvertFrom-Json
  $laDiff = if (Test-Path (Join-Path $pointEv 'la-data-restore-diff.json')) { Get-Content (Join-Path $pointEv 'la-data-restore-diff.json') -Raw | ConvertFrom-Json } else { $null }
  $openJson = $open | ConvertFrom-Json
  $state = Get-Content (Join-Path $pointEv 'tree-state-after-clean-install.json') -Raw | ConvertFrom-Json

  Write-Json (Join-Path $pointEv 'recovery.json') ([ordered]@{
      step = 'recovery'; point = $Point; setup = $RC6; setupSha256 = $RC6_SHA
      dataMovedOut = $moved
      treeRemoved = $removed
      deletedEntries = $entriesBefore
      cleanInstall = $run
      treeAfterCleanInstall = $state
      targetDataRestoreDiff = $targetDiff
      laDataRestoreDiff = $laDiff
      laDataChannelError = $laChannelError
      openStore = $openJson
      markerProbeAfterRecovery = ($probe | ConvertFrom-Json)
      verdict = [ordered]@{
        cleanInstallExitZero = ($run.exitCode -eq 0)
        installJsonVersionRc6 = ($state.installJsonVersion -eq '0.0.1-rc.6')
        installedAsFreshNotUpgrade = (-not $state.installJsonUpgradedFrom)
        targetDataZeroDiff = ($targetDiff.differenceCount -eq 0)
        laDataZeroDiff = ($null -ne $laDiff) -and ($laDiff.differenceCount -eq 0)
        storeOpened = ($openJson.opened -eq $true)
        auditChainHmacVerified = ($openJson.auditChain.hmacVerified -eq $true)
        markersSelfHealed = ($null -ne ($probe | ConvertFrom-Json).installMarker)
      }
    })
  Write-Output "recovery: exit=$($run.exitCode) $($run.elapsedSeconds)s targetDiff=$($targetDiff.differenceCount) laDiff=$($laDiff.differenceCount) opened=$($openJson.opened)"
}

function Step-Control {
  if ($Point -ne 'CONTROL') { throw 'control step requires -Point CONTROL' }
  Assert-WindowFree 'control'
  Assert-NoForeignInstaller 'control'
  $pointEv = Join-Path $EV 'CONTROL'
  $run = Invoke-SetupWait $RC6 $TREE (Join-Path $pointEv 'control-upgrade.log') (Join-Path $pointEv 'control-upgrade-key-lines.txt')
  Invoke-Tool 'tree-state.ps1' @{ Root = $TREE; Out = (Join-Path $pointEv 'tree-state-after-control.json'); Label = 'after-control-upgrade' } | Out-Null
  Invoke-Tool 'fingerprint.ps1' @{ Path = (Join-Path $TREE 'data'); Out = (Join-Path $pointEv 'target-data-after-control.tsv') } | Out-Null
  Invoke-Tool 'compare-fingerprint.ps1' @{
    Before = (Join-Path $pointEv 'target-data-before.tsv'); After = (Join-Path $pointEv 'target-data-after-control.tsv');
    Out    = (Join-Path $pointEv 'target-data-control-diff.json')
  } | Out-Null
  if (Test-Path $LA_DATA) {
    Invoke-Tool 'fingerprint.ps1' @{ Path = $LA_DATA; Out = (Join-Path $pointEv 'la-data-after-control.tsv') } | Out-Null
    Invoke-Tool 'compare-fingerprint.ps1' @{
      Before = (Join-Path $EV 'host\la-data-before.tsv'); After = (Join-Path $pointEv 'la-data-after-control.tsv');
      Out    = (Join-Path $pointEv 'la-data-control-diff.json')
    } | Out-Null
  }
  $dbPath = Join-Path $TREE 'data\store\aegis.db'
  $open = if (Test-Path $dbPath) { & node (Join-Path $TOOLS 'open-store.mjs') --db $dbPath } else { '{"opened":false}' }
  $open | Set-Content -LiteralPath (Join-Path $pointEv 'open-store-after-control.json') -Encoding UTF8
  $probe = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $APP $TREE
  $probe | Set-Content -LiteralPath (Join-Path $pointEv 'marker-probe-after-control.json') -Encoding UTF8
  $state = Get-Content (Join-Path $pointEv 'tree-state-after-control.json') -Raw | ConvertFrom-Json
  $targetDiff = Get-Content (Join-Path $pointEv 'target-data-control-diff.json') -Raw | ConvertFrom-Json
  $laDiff = if (Test-Path (Join-Path $pointEv 'la-data-control-diff.json')) { Get-Content (Join-Path $pointEv 'la-data-control-diff.json') -Raw | ConvertFrom-Json } else { $null }
  Write-Json (Join-Path $pointEv 'control-result.json') ([ordered]@{
      step = 'control'; setup = $RC6; setupSha256 = $RC6_SHA
      note = 'same base clone, same factory rc.6 Setup, same duration budget, NO kill'
      run = $run
      treeAfter = $state
      targetDataDiff = $targetDiff
      laDataDiff = $laDiff
      openStore = ($open | ConvertFrom-Json)
      markerProbe = ($probe | ConvertFrom-Json)
      verdict = [ordered]@{
        exitCodeZero = ($run.exitCode -eq 0)
        versionRc6 = ($state.installJsonVersion -eq '0.0.1-rc.6')
        upgradedFromRc5 = ($state.installJsonUpgradedFrom -eq '0.0.1-rc.5')
        manifestIsRc6 = ($state.manifestSha256 -eq $RC6_MANIFEST_SHA)
        targetDataZeroDiff = ($targetDiff.differenceCount -eq 0)
        laDataZeroDiff = ($null -ne $laDiff) -and ($laDiff.differenceCount -eq 0)
        storeOpened = (($open | ConvertFrom-Json).opened -eq $true)
        auditChainHmacVerified = (($open | ConvertFrom-Json).auditChain.hmacVerified -eq $true)
      }
    })
  Write-Output "control: exit=$($run.exitCode) $($run.elapsedSeconds)s version=$($state.installJsonVersion) upgradedFrom=$($state.installJsonUpgradedFrom) manifestIsRc6=$($state.manifestSha256 -eq $RC6_MANIFEST_SHA) targetDiff=$($targetDiff.differenceCount)"
}

function Step-Cleanup {
  $pointEv = Join-Path $EV 'cleanup'
  New-Item -ItemType Directory -Force -Path $pointEv | Out-Null
  Invoke-Tool 'host-snapshot.ps1' @{ Out = (Join-Path $pointEv 'host-before-cleanup.json'); Label = 'before-cleanup' } | Out-Null

  # 1) product uninstaller from OUTSIDE every tree (the shipped code path that works;
  #    the in-tree copy is the known N-017 self-kill case and is not used here).
  $uninstalls = @()
  $trees = @(Get-ExperimentTrees)
  Write-Output "trees to uninstall: $($trees -join ' | ')"
  foreach ($candidate in $trees) {
    if (-not (Test-Path (Join-Path $candidate 'install\install.json'))) { continue }
    $logsBefore = @(Get-SetupLogs)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $RC6 -ArgumentList @('/uninstall', "/DIR=$candidate", '/S') -PassThru
    $null = $p.Handle
    $null = $p.WaitForExit(900000)
    $sw.Stop()
    $log = @(Get-SetupLogs | Where-Object { $logsBefore -notcontains $_ } | Sort-Object { (Get-Item $_).LastWriteTime } -Descending | Select-Object -First 1)
    $copied = $null
    if ($log -and $log.Count -gt 0) {
      $newLog = @($log)[0]
      $copied = Join-Path $pointEv ("uninstall-" + (Split-Path -Leaf $candidate) + ".log")
      Copy-Item -LiteralPath $newLog -Destination $copied -Force
    }
    $uninstalls += [ordered]@{
      tree = $candidate; exitCode = $p.ExitCode; elapsedSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
      log = $copied; treeStillExists = (Test-Path $candidate)
      keyLines = if ($copied) { @(Get-LogKeyLines $copied $null) } else { @() }
    }
    Write-Output "uninstall $candidate exit=$($p.ExitCode) $([math]::Round($sw.Elapsed.TotalSeconds,1))s stillExists=$(Test-Path $candidate)"
  }

  # 2) force-remove every experiment tree (temp cache of this seat only)
  $removed = @()
  foreach ($candidate in @(Get-ExperimentTrees)) { $removed += [ordered]@{ path = $candidate; removed = (Remove-Tree $candidate) } }

  # 3) host seams: only AIDriven entries that point into this seat's temp root are ours
  $runValue = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $runRemoved = $false
  if (Test-Path $runValue) {
    $props = Get-ItemProperty $runValue -ErrorAction SilentlyContinue
    $value = [string]$props.AIDrivenNetDefense
    if ($value -and ($value -match [regex]::Escape($WORK))) {
      Remove-ItemProperty -Path $runValue -Name 'AIDrivenNetDefense' -Force -ErrorAction SilentlyContinue
      $runRemoved = $true
    }
  }
  $keysRemoved = @()
  foreach ($path in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AIDrivenNetDefense')) {
    if (Test-Path $path) {
      $loc = [string](Get-ItemProperty -Path $path -ErrorAction SilentlyContinue).InstallLocation
      if ($loc -match [regex]::Escape($WORK)) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
        $keysRemoved += $path
      }
    }
  }
  $shortcutsRemoved = @()
  foreach ($d in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\AIDriven NetDefense", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\AIDriven NetDefense")) {
    if (Test-Path $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue; $shortcutsRemoved += $d }
  }
  foreach ($lnk in @("$env:USERPROFILE\Desktop\AIDriven NetDefense.lnk")) {
    if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue; $shortcutsRemoved += $lnk }
  }

  # 4) payload extraction leftovers created during this seat's window
  $extraction = @()
  $seatStart = Get-SeatStart
  foreach ($d in @(Get-ChildItem $env:TEMP -Directory -Filter 'aidn-setup-*' -ErrorAction SilentlyContinue)) {
    if ($d.LastWriteTime -gt $seatStart) {
      $sizeMB = [math]::Round(((Get-ChildItem $d.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
      $ok = Remove-Tree $d.FullName
      $extraction += [ordered]@{ path = $d.FullName; lastWrite = $d.LastWriteTime.ToString('o'); sizeMB = $sizeMB; removed = $ok }
    }
  }

  # 5) restore %LOCALAPPDATA% product dir if restoring changed it
  $laRestored = $false
  $laDiff = Join-Path $pointEv 'la-data-vs-before-cleanup.json'
  if (Test-Path (Join-Path $EV 'host\la-data-before.tsv')) {
    if (Test-Path $LA_DATA) { Invoke-Tool 'fingerprint.ps1' @{ Path = $LA_DATA; Out = (Join-Path $pointEv 'la-data-current.tsv') } | Out-Null }
    Invoke-Tool 'compare-fingerprint.ps1' @{
      Before = (Join-Path $EV 'host\la-data-before.tsv'); After = (Join-Path $pointEv 'la-data-current.tsv'); Out = $laDiff
    } | Out-Null
    $diff = Get-Content $laDiff -Raw | ConvertFrom-Json
    if ($diff.differenceCount -ne 0 -and (Test-Path $LA_BACKUP)) {
      if (Test-Path $LA_PRODUCT) { Remove-Tree $LA_PRODUCT | Out-Null }
      & robocopy $LA_BACKUP $LA_PRODUCT /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
      $laRestored = $true
    }
  }

  Invoke-Tool 'host-snapshot.ps1' @{ Out = (Join-Path $EV 'host\after.json'); Label = 'after-r5' } | Out-Null
  $after = Get-Content (Join-Path $EV 'host\after.json') -Raw -Encoding UTF8 | ConvertFrom-Json

  Write-Json (Join-Path $pointEv 'cleanup-result.json') ([ordered]@{
      step = 'cleanup'; at = (Get-Date).ToString('o')
      uninstalls = $uninstalls
      treesRemoved = $removed
      runValueRemoved = $runRemoved
      uninstallKeysRemoved = $keysRemoved
      shortcutsRemoved = $shortcutsRemoved
      extractionLeftovers = $extraction
      localAppDataRestoredFromBackup = $laRestored
      localAppDataDiff = (Get-Content $laDiff -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json)
      hostAfter = $after
      hostEmpty = ($after.zero -eq $true)
    })
  Write-Output "cleanup done: hostEmpty=$($after.zero)"
}

# ------------------------------------------------------------------ dispatch
Write-Output "=== powercut5 step=$Step point=$Point started=$STARTED_AT"
switch ($Step) {
  'preflight' { Step-Preflight }
  'cold' { Step-Cold }
  'seed' { Step-Seed }
  'clone' { Step-Clone }
  'kill' { Step-Kill }
  'reinstall' { Step-Reinstall }
  'recovery' { Step-Recovery }
  'control' { Step-Control }
  'cleanup' { Step-Cleanup }
}
Write-Output "=== powercut5 step=$Step done $(Get-Date -Format o)"




