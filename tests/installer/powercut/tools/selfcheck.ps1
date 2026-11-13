# Self-test of the round-5 power-cut tool chain, on miniature fixtures, with no host
# side effects.
#
# POST-SHIP-PATH / powercut-r5. Purpose: before the real (host-touching) experiment, prove
# that every tool this seat relies on does what its evidence will later claim:
#
#   * tree-state / fingerprint / compare-fingerprint read a tree correctly,
#   * a robocopy clone of an installed tree is credential-bound to its path
#     (installMarker = null as copied, non-null after resign-clone) — the N-042 §3 state,
#   * a half-copied tree (new entry exe + old manifest) makes BOTH shipped markers null
#     and makes a direct reinstall refuse with exit 1 and zero writes,
#   * the recovery path (move data out -> delete tree -> clean install -> move data back)
#     restores the data byte-identically and heals the markers,
#   * process-family really enumerates a parent+child family and really kills it
#     (aliveAfter = 0),
#   * host-snapshot produces a parseable record.
#
# Everything runs against `deploy/windows/installer/app` copied into a scratch dir with a
# stamped version (deploy/** is never written), a 4-file miniature payload built by
# `tests/installer/fixtures/r3-make-payload.py` (reused read-only), TEMP/start-menu/desktop/
# ProgramData redirected into the scratch dir, and `/NOREG /NOSHORTCUT` on every install.
#
# Usage: pwsh -NoProfile -File tests/installer/powercut/tools/selfcheck.ps1 [-KeepWork]
# Exit code 0 = every check passed.
#
# Author: PT-dove
param([switch]$KeepWork)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONDONTWRITEBYTECODE = '1'

$TOOLS = $PSScriptRoot
$POWERCUT = Split-Path -Parent $PSScriptRoot
$REPO = (Resolve-Path (Join-Path $POWERCUT '..\..\..')).Path
$EV = Join-Path $REPO 'evidence\upgrade\powercut\r5\selfcheck'
$STAMP = Get-Date -Format 'yyyyMMdd-HHmmss'
$WORK = Join-Path $env:TEMP "powercut-selfcheck-$STAMP"
$APP_SRC = Join-Path $REPO 'deploy\windows\installer\app'
$PAYLOAD_BUILDER = Join-Path $REPO 'tests\installer\fixtures\r3-make-payload.py'
$PYTHON = 'D:\Python311\python.exe'
if (-not (Test-Path $PYTHON)) { $PYTHON = (Get-Command python -ErrorAction SilentlyContinue).Source }

New-Item -ItemType Directory -Force -Path $EV, $WORK | Out-Null
$checks = New-Object System.Collections.Generic.List[object]
function Add-Check([string]$Name, [bool]$Passed, $Detail) {
  $checks.Add([ordered]@{ name = $Name; passed = [bool]$Passed; detail = $Detail })
  $tag = if ($Passed) { 'PASS' } else { 'FAIL' }
  Write-Output ("[{0}] {1}  {2}" -f $tag, $Name, ($Detail | ConvertTo-Json -Compress -Depth 4))
}

# ------------------------------------------------------------------ redirected environment
$redirect = [ordered]@{
  TEMP                          = Join-Path $WORK 'env\temp'
  TMP                           = Join-Path $WORK 'env\temp'
  AIDN_SETUP_STARTMENU_DIR      = Join-Path $WORK 'env\start-menu'
  AIDN_SETUP_DESKTOP_DIR        = Join-Path $WORK 'env\desktop'
  AIDN_SETUP_PROGRAMDATA_DIR    = Join-Path $WORK 'env\programdata'
  AIDN_SETUP_DEFAULT_DIR        = Join-Path $WORK 'env\default-dir'
}
foreach ($d in $redirect.Values) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
foreach ($key in $redirect.Keys) { Set-Item -Path "env:$key" -Value $redirect[$key] }

function Invoke-MiniInstaller([string]$AppDir, [string[]]$Arguments) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out = & $PYTHON (Join-Path $AppDir 'main.py') @Arguments 2>&1
  $sw.Stop()
  return [ordered]@{ exitCode = $LASTEXITCODE; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2); output = @($out | ForEach-Object { "$_" }) }
}

function New-AppCopy([string]$Name, [string]$Version) {
  $destination = Join-Path $WORK "app\$Name"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $APP_SRC -Destination $destination -Recurse -Force
  Get-ChildItem $destination -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $constants = Join-Path $destination 'aidn\constants.py'
  $text = [System.IO.File]::ReadAllText($constants, [System.Text.Encoding]::UTF8)
  $patched = $text -replace '(?m)^DEV_VERSION = .*$', "DEV_VERSION = `"$Version`""
  if ($patched -eq $text) { throw 'constants.py has no DEV_VERSION line to stamp' }
  [System.IO.File]::WriteAllText($constants, $patched, (New-Object System.Text.UTF8Encoding($false)))
  return $destination
}

$summary = [ordered]@{
  ok = $false
  stamp = $STAMP
  work = $WORK
  repo = $REPO
  checks = @()
  startedAt = (Get-Date).ToString('o')
}

try {
  # ---------------------------------------------------------------- inputs
  if (-not (Test-Path (Join-Path $APP_SRC 'aidn\install.py'))) { throw "installer app not found: $APP_SRC" }
  if (-not (Test-Path $PAYLOAD_BUILDER)) { throw "payload builder not found: $PAYLOAD_BUILDER" }
  Add-Check 'inputs.present' $true ([ordered]@{ app = $APP_SRC; payloadBuilder = $PAYLOAD_BUILDER; python = $PYTHON })

  $appOld = New-AppCopy 'old' '0.0.1-rc.5'
  $appNew = New-AppCopy 'new' '0.0.1-rc.6'
  Add-Check 'apps.versionStamped' $true ([ordered]@{ old = '0.0.1-rc.5'; new = '0.0.1-rc.6' })

  # ---------------------------------------------------------------- miniature payloads
  $srcOld = Join-Path $WORK 'payload-old'
  $srcNew = Join-Path $WORK 'payload-new'
  New-Item -ItemType Directory -Force -Path $srcOld, $srcNew | Out-Null
  foreach ($pair in @(@{ src = $srcOld; app = $appOld; tag = 'selfcheck-old' }, @{ src = $srcNew; app = $appNew; tag = 'selfcheck-new' })) {
    $built = & $PYTHON $PAYLOAD_BUILDER $pair.src (Join-Path $pair.app 'payload.7z') $pair.tag 2>&1
    if ($LASTEXITCODE -ne 0) { throw "payload builder failed: $built" }
    $built | Set-Content -LiteralPath (Join-Path $EV "payload-$($pair.tag).json") -Encoding UTF8
  }
  $oldManifest = Join-Path $srcOld 'manifests\files.sha256'
  $newManifest = Join-Path $srcNew 'manifests\files.sha256'
  Add-Check 'payloads.built' ((Test-Path (Join-Path $appOld 'payload.7z')) -and (Test-Path (Join-Path $appNew 'payload.7z'))) ([ordered]@{
      oldRows = @([System.IO.File]::ReadAllLines($oldManifest)).Count
      newRows = @([System.IO.File]::ReadAllLines($newManifest)).Count
    })

  # ---------------------------------------------------------------- A: install rc.5-like
  $tree = Join-Path $WORK 'tree-A'
  $installOld = Invoke-MiniInstaller $appOld @('/S', "/DIR=$tree", '/NOREG', '/NOSHORTCUT')
  $stateOld = & (Join-Path $TOOLS 'tree-state.ps1') -Root $tree -Out (Join-Path $EV 'A-tree-state.json') -Label 'A-mini-rc5' | Out-Null
  $state = Get-Content (Join-Path $EV 'A-tree-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Add-Check 'A.installOld.exit0' ($installOld.exitCode -eq 0) $installOld.exitCode
  Add-Check 'A.installOld.version' ($state.installJsonVersion -eq '0.0.1-rc.5') $state.installJsonVersion
  Add-Check 'A.installOld.manifestIsOldPayload' ($state.manifestSha256 -eq (Get-FileHash $oldManifest -Algorithm SHA256).Hash.ToLower()) $state.manifestSha256

  # user data (must survive everything below)
  $dataDir = Join-Path $tree 'data'
  New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'store') | Out-Null
  Set-Content -LiteralPath (Join-Path $dataDir 'SENTINEL-旧数据.txt') -Value 'selfcheck sentinel: must survive byte-identically' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $dataDir 'store\seed.db') -Value ('x' * 4096) -Encoding UTF8
  & (Join-Path $TOOLS 'fingerprint.ps1') -Path $dataDir -Out (Join-Path $EV 'A-data-before.tsv') | Out-Null

  # ---------------------------------------------------------------- B: clone + path binding
  $clone = Join-Path $WORK 'tree-B-clone'
  & robocopy $tree $clone /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy clone failed: $LASTEXITCODE" }
  $probeCopied = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $appOld $clone | ConvertFrom-Json
  $probeCopied | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EV 'B-probe-as-copied.json') -Encoding UTF8
  Add-Check 'B.clone.installMarkerNullAsCopied' ($null -eq $probeCopied.installMarker) ([ordered]@{ reason = $probeCopied.ownershipVerifyReason })
  $resign = & $PYTHON (Join-Path $TOOLS 'resign-clone.py') --app $appOld --tree $clone --out (Join-Path $EV 'B-resign-clone.json') | ConvertFrom-Json
  $probeResigned = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $appOld $clone | ConvertFrom-Json
  $probeResigned | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EV 'B-probe-after-resign.json') -Encoding UTF8
  Add-Check 'B.resign.written' ($resign.written -eq $true) $resign.written
  Add-Check 'B.resign.installMarkerNonNil' ($null -ne $probeResigned.installMarker) $probeResigned.installMarker
  Add-Check 'B.resign.upgradeMarkerNonNil' ($null -ne $probeResigned.upgradeMarker) $probeResigned.upgradeMarker

  # ---------------------------------------------------------------- C: half-copy shape
  # new entry exe bytes, old manifest still in place -- exactly the kill window the real
  # experiment uses as its trigger
  Copy-Item -LiteralPath (Join-Path $srcNew 'AIDrivenNetDefense.exe') -Destination (Join-Path $clone 'AIDrivenNetDefense.exe') -Force
  $auditRaw = & $PYTHON (Join-Path $TOOLS 'manifest-audit.py') --old $oldManifest --new $newManifest --tree $clone --out (Join-Path $EV 'C-manifest-audit.json') --app $appOld
  $audit = Get-Content (Join-Path $EV 'C-manifest-audit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Add-Check 'C.audit.distinguishableRows' ($audit.distinguishableCount -ge 3) $audit.distinguishableCount
  Add-Check 'C.audit.firstDataRowIsEntryExeAndNew' (($audit.firstDataRow.path -match 'AIDrivenNetDefense\.exe$') -and ($audit.firstDataRow.state -eq 'new')) $audit.firstDataRow
  Add-Check 'C.audit.shippedRuleWouldFail' ($audit.shippedSamplingWindow.old.manifestHasRowsByShippedRule -eq $false) ([ordered]@{
      rowsChecked = $audit.shippedSamplingWindow.old.rowsChecked
      rowsMismatched = $audit.shippedSamplingWindow.old.rowsMismatched
    })

  $probeHalf = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $appNew $clone | ConvertFrom-Json
  $probeHalf | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EV 'C-probe-half-copy.json') -Encoding UTF8
  Add-Check 'C.halfCopy.installMarkerNull' ($null -eq $probeHalf.installMarker) $probeHalf.installMarker
  Add-Check 'C.halfCopy.upgradeMarkerNull' ($null -eq $probeHalf.upgradeMarker) $probeHalf.upgradeMarker
  Add-Check 'C.halfCopy.manifestHasRowsFalse' ($probeHalf.manifestHasRows -eq $false) $probeHalf.manifestHasRows
  Add-Check 'C.halfCopy.hasAnyEntryTrue' ($probeHalf.hasAnyEntry -eq $true) $probeHalf.hasAnyEntry

  # ---------------------------------------------------------------- D: direct reinstall refuses
  & (Join-Path $TOOLS 'tree-state.ps1') -Root $clone -Out (Join-Path $EV 'D-tree-before-reinstall.json') -Label 'before' | Out-Null
  $reinstall = Invoke-MiniInstaller $appNew @('/S', "/DIR=$clone", '/NOREG', '/NOSHORTCUT')
  & (Join-Path $TOOLS 'tree-state.ps1') -Root $clone -Out (Join-Path $EV 'D-tree-after-reinstall.json') -Label 'after' | Out-Null
  $before = Get-Content (Join-Path $EV 'D-tree-before-reinstall.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $after = Get-Content (Join-Path $EV 'D-tree-after-reinstall.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $zeroWrites = ($before.inventoryDigest -eq $after.inventoryDigest) -and ($before.fileCount -eq $after.fileCount)
  Add-Check 'D.reinstall.exitNonZero' ($reinstall.exitCode -ne 0) $reinstall.exitCode
  Add-Check 'D.reinstall.zeroWrites' $zeroWrites ([ordered]@{ before = $before.inventoryDigest; after = $after.inventoryDigest; files = $after.fileCount })
  Add-Check 'D.reinstall.refusalText' (@($reinstall.output | Where-Object { $_ -match '不是空目录|没有安装标记' }).Count -gt 0) (@($reinstall.output | Select-Object -Last 3))
  $reinstall | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $EV 'D-reinstall.json') -Encoding UTF8
  & (Join-Path $TOOLS 'fingerprint.ps1') -Path (Join-Path $clone 'data') -Out (Join-Path $EV 'D-data-after-reinstall.tsv') | Out-Null
  & (Join-Path $TOOLS 'compare-fingerprint.ps1') -Before (Join-Path $EV 'A-data-before.tsv') -After (Join-Path $EV 'D-data-after-reinstall.tsv') -Out (Join-Path $EV 'D-data-diff.json') | Out-Null
  $dataDiff = Get-Content (Join-Path $EV 'D-data-diff.json') -Raw | ConvertFrom-Json
  Add-Check 'D.reinstall.dataUntouched' ($dataDiff.differenceCount -eq 0) $dataDiff.differenceCount

  # ---------------------------------------------------------------- E: recovery path
  $holding = Join-Path $WORK 'holding'
  New-Item -ItemType Directory -Force -Path $holding | Out-Null
  Move-Item -LiteralPath (Join-Path $clone 'data') -Destination (Join-Path $holding 'target-data') -Force
  & cmd.exe /c "rd /s /q `"$clone`"" 2>&1 | Out-Null
  $treeGone = -not (Test-Path $clone)
  $clean = Invoke-MiniInstaller $appNew @('/S', "/DIR=$clone", '/NOREG', '/NOSHORTCUT')
  Move-Item -LiteralPath (Join-Path $holding 'target-data') -Destination (Join-Path $clone 'data') -Force
  & (Join-Path $TOOLS 'tree-state.ps1') -Root $clone -Out (Join-Path $EV 'E-tree-after-recovery.json') -Label 'after-recovery' | Out-Null
  & (Join-Path $TOOLS 'fingerprint.ps1') -Path (Join-Path $clone 'data') -Out (Join-Path $EV 'E-data-after-restore.tsv') | Out-Null
  & (Join-Path $TOOLS 'compare-fingerprint.ps1') -Before (Join-Path $EV 'A-data-before.tsv') -After (Join-Path $EV 'E-data-after-restore.tsv') -Out (Join-Path $EV 'E-data-diff.json') | Out-Null
  $restoreState = Get-Content (Join-Path $EV 'E-tree-after-recovery.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $restoreDiff = Get-Content (Join-Path $EV 'E-data-diff.json') -Raw | ConvertFrom-Json
  $probeRecovered = & $PYTHON (Join-Path $TOOLS 'marker-probe.py') $appNew $clone | ConvertFrom-Json
  $probeRecovered | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EV 'E-probe-after-recovery.json') -Encoding UTF8
  Add-Check 'E.recovery.treeRemoved' $treeGone $treeGone
  Add-Check 'E.recovery.cleanInstallExit0' ($clean.exitCode -eq 0) $clean.exitCode
  Add-Check 'E.recovery.versionIsNew' ($restoreState.installJsonVersion -eq '0.0.1-rc.6') $restoreState.installJsonVersion
  Add-Check 'E.recovery.installedAsFresh' (-not $restoreState.installJsonUpgradedFrom) $restoreState.installJsonUpgradedFrom
  Add-Check 'E.recovery.dataZeroDiff' ($restoreDiff.differenceCount -eq 0) $restoreDiff.differenceCount
  Add-Check 'E.recovery.markersHealed' (($null -ne $probeRecovered.installMarker) -and ($null -ne $probeRecovered.upgradeMarker)) ([ordered]@{ installMarker = $probeRecovered.installMarker; upgradeMarker = $probeRecovered.upgradeMarker })

  # ---------------------------------------------------------------- F: process-family kills parent+child
  $dummy = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', 'timeout /t 120 >nul') -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 800
  & (Join-Path $TOOLS 'process-family.ps1') -RootPid $dummy.Id -Kill -Out (Join-Path $EV 'F-process-family.json') -Label 'selfcheck-dummy' -VerifySeconds 10 | Out-Null
  $family = Get-Content (Join-Path $EV 'F-process-family.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Add-Check 'F.family.enumerated' ($family.processIds.Count -ge 1) $family.processIds
  Add-Check 'F.family.killVerified' ($family.killVerified -eq $true) ([ordered]@{ aliveAfter = $family.aliveAfter })

  # ---------------------------------------------------------------- G: host snapshot parses
  & (Join-Path $TOOLS 'host-snapshot.ps1') -Out (Join-Path $EV 'G-host-snapshot.json') -Label 'selfcheck' | Out-Null
  $snapshot = Get-Content (Join-Path $EV 'G-host-snapshot.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Add-Check 'G.hostSnapshot.parses' ($null -ne $snapshot.capturedAt) ([ordered]@{
      run = $snapshot.hkcuRunAidriven.Count; hkcu = $snapshot.uninstallHKCU.Count; sm = $snapshot.startMenu.Count
      # NOT asserted zero here: another seat may legitimately be installing while this self-test runs.
    })

  # ---------------------------------------------------------------- H: baseline fingerprint comparison is not vacuous
  Copy-Item -LiteralPath (Join-Path $EV 'A-data-before.tsv') -Destination (Join-Path $EV 'H-data-copy.tsv') -Force
  & (Join-Path $TOOLS 'fingerprint.ps1') -Path (Join-Path $clone 'data') -Out (Join-Path $EV 'H-data-restored.tsv') | Out-Null
  Add-Check 'H.fingerprint.identicalComparedFiles' ($restoreDiff.beforeCount -ge 2 -and $restoreDiff.afterCount -ge 2) ([ordered]@{ before = $restoreDiff.beforeCount; after = $restoreDiff.afterCount })
}
catch {
  Add-Check 'selfcheck.exception' $false $_.Exception.Message
}
finally {
  $failed = @($checks | Where-Object { -not $_.passed })
  $summary.ok = ($failed.Count -eq 0)
  $summary.checks = $checks.ToArray()
  $summary.failed = $failed.Count
  $summary.passed = $checks.Count - $failed.Count
  $summary.finishedAt = (Get-Date).ToString('o')
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $EV "selfcheck-$STAMP.json") -Encoding UTF8
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $EV 'selfcheck-latest.json') -Encoding UTF8
  foreach ($key in $redirect.Keys) { Remove-Item -Path "env:$key" -ErrorAction SilentlyContinue }
  if (-not $KeepWork) {
    & cmd.exe /c "rd /s /q `"$WORK`"" 2>&1 | Out-Null
  }
  Write-Output ("=== selfcheck {0}: {1} passed / {2} failed -> ok={3}" -f $STAMP, $summary.passed, $summary.failed, $summary.ok)
  Write-Output ("evidence: {0}" -f (Join-Path $EV 'selfcheck-latest.json'))
}

if (-not $summary.ok) { exit 1 }
exit 0

