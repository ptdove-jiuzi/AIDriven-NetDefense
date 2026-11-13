# Assemble RESULT.json for the round-5 power-cut seat from the per-step evidence JSONs.
#
# POST-SHIP-PATH / powercut-r5. Deliberately mechanical: every number in the result file is
# read back from a file a step wrote at the moment it did the work, so the summary cannot
# drift from the raw evidence. If a step file is missing the field is left absent and
# `unverified` names it instead of guessing.
#
# Author: PT-dove
param(
  [string]$Evidence = '',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'

$REPO = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
if (-not $Evidence) { $Evidence = Join-Path $REPO 'evidence\upgrade\powercut\r5' }
if (-not $Out) { $Out = Join-Path $Evidence 'RESULT.json' }

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

$result = [ordered]@{
  seat = 'powercut-r5'
  campaign = 'POST-SHIP-PATH round-5'
  generatedAt = (Get-Date).ToString('o')
  evidenceRoot = $Evidence
  movedWith = 'SIGKILL-equivalent: Stop-Process -Force on the whole installer process family (not a hardware power loss)'
  installArgs = @('/S', '/DIR=<tree>', '/NOREG', '/NOSHORTCUT')
  elevation = 'non-elevated; no UAC; %ProgramFiles% never touched'
  points = [ordered]@{}
  unverified = @()
}

$preflight = Read-Json (Join-Path $Evidence 'preflight.json')
if ($preflight) {
  $result.inputs = [ordered]@{
    rc5Setup = $preflight.rc5
    rc6Setup = $preflight.rc6
    rc5Manifest = $preflight.rc5Manifest
    rc6Manifest = $preflight.rc6Manifest
    diskFreeGB = $preflight.diskFreeGB
    windowLockPresentAtPreflight = $preflight.windowLockPresent
  }
} else { $result.unverified += 'preflight.json missing' }

$result.mechanism = Read-Json (Join-Path $Evidence 'manifests\MECHANISM-SNAPSHOT.json')
$result.host = [ordered]@{
  before = Read-Json (Join-Path $Evidence 'host\before.json')
  after = Read-Json (Join-Path $Evidence 'host\after.json')
}

foreach ($pointName in @('K1', 'K2')) {
  $dir = Join-Path $Evidence $pointName
  if (-not (Test-Path $dir)) { continue }
  $clone = Read-Json (Join-Path $dir 'clone-result.json')
  $kill = Read-Json (Join-Path $dir 'kill-result.json')
  $reinstall = Read-Json (Join-Path $dir 'reinstall-attempt.json')
  $recovery = Read-Json (Join-Path $dir 'recovery.json')
  $incident = Read-Json (Join-Path $dir 'incident-orphan-cleared.json')
  $pointEntry = [ordered]@{
    clone = if ($clone) { $clone.verdict } else { $null }
    cloneSource = if ($clone) { $clone.source } else { $null }
    kill = if ($kill) {
      [ordered]@{
        aborted = $kill.aborted
        trigger = $kill.trigger
        setupPid = $kill.setupPid
        copyElapsedMsAtKill = $kill.copyElapsedMsAtKill
        requestedDelayMs = $kill.requestedDelayMs
        killedProcessIds = $kill.killedProcessFamily.processIds
        killedProcessFamilyKillVerified = $kill.killedProcessFamily.killVerified
        killedProcessFamilyAliveAfter = $kill.killedProcessFamily.aliveAfter
        landedNew = $kill.manifestAuditAtKill.landedNew
        distinguishable = $kill.manifestAuditAtKill.distinguishableCount
        landedRatio = $kill.manifestAuditAtKill.landedRatioOfDistinguishable
        firstDataRow = $kill.manifestAuditAtKill.firstDataRow
        treeAtKill = [ordered]@{
          fileCount = $kill.treeAtKill.fileCount
          exeSha256 = $kill.treeAtKill.exeSha256
          manifestSha256 = $kill.treeAtKill.manifestSha256
          installJsonVersion = $kill.treeAtKill.installJsonVersion
          installJsonUpgradedFrom = $kill.treeAtKill.installJsonUpgradedFrom
          bundleJsonSha256 = $kill.treeAtKill.bundleJsonSha256
        }
        markerProbeAtKill = if ($kill.markerProbeAtKill) {
          [ordered]@{
            installMarker = $kill.markerProbeAtKill.installMarker
            upgradeMarker = $kill.markerProbeAtKill.upgradeMarker
            manifestHasRows = $kill.markerProbeAtKill.manifestHasRows
            hasAnyEntry = $kill.markerProbeAtKill.hasAnyEntry
            ownershipVerifyOk = $kill.markerProbeAtKill.ownershipVerifyOk
            ownershipVerifyReason = $kill.markerProbeAtKill.ownershipVerifyReason
          }
        } else { $null }
        verdict = $kill.verdict
      }
    } else { $null }
    directReinstall = if ($reinstall) {
      [ordered]@{
        exitCode = $reinstall.run.exitCode
        elapsedSeconds = $reinstall.run.elapsedSeconds
        zeroWrites = $reinstall.zeroWrites
        inventoryDigestEqual = $reinstall.inventoryDigestEqual
        treeBefore = $reinstall.treeBefore
        treeAfter = $reinstall.treeAfter
        dataDiff = $reinstall.dataDiff.differenceCount
        keyLines = $reinstall.run.keyLines
        verdict = $reinstall.verdict
      }
    } else { $null }
    recovery = if ($recovery) {
      [ordered]@{
        cleanInstallExitCode = $recovery.cleanInstall.exitCode
        cleanInstallSeconds = $recovery.cleanInstall.elapsedSeconds
        cleanInstallKeyLines = $recovery.cleanInstall.keyLines
        treeAfterCleanInstall = [ordered]@{
          version = $recovery.treeAfterCleanInstall.installJsonVersion
          upgradedFrom = $recovery.treeAfterCleanInstall.installJsonUpgradedFrom
          fileCount = $recovery.treeAfterCleanInstall.fileCount
          manifestSha256 = $recovery.treeAfterCleanInstall.manifestSha256
          exeSha256 = $recovery.treeAfterCleanInstall.exeSha256
        }
        targetDataDiff = $recovery.targetDataRestoreDiff
        laDataDiff = $recovery.laDataRestoreDiff
        openStore = $recovery.openStore
        markerProbeAfterRecovery = $recovery.markerProbeAfterRecovery
        verdict = $recovery.verdict
      }
    } else { $null }
    firstAttemptIncident = if ($incident) {
      [ordered]@{ note = 'first kill attempt aborted (installer log unreadable while running); orphan family killed; tree verified untouched'; processIds = $incident.processIds; killVerified = $incident.killVerified }
    } else { $null }
  }
  $result.points[$pointName] = $pointEntry
}

# CONTROL: not re-run by this seat (Lead scope decision at 17:07) - cite the upgrade seat's
# completed rc.5 -> rc.6 overwrite on the same factory bytes / same machine.
$controlSource = Join-Path $REPO 'evidence\upgrade\r5\sceneB\scene-facts-B.json'
$result.control = [ordered]@{
  kind = 'cross-seat control (upgrade seat, same factory bytes, same machine, no kill)'
  source = $controlSource
  facts = Read-Json $controlSource
  independentSelfRun = $false
}
if (-not (Test-Path $controlSource)) { $result.unverified += 'control citation missing (evidence/upgrade/r5/sceneB/scene-facts-B.json)' }

# verdict roll-up
$checks = [ordered]@{}
foreach ($name in @('K1', 'K2')) {
  $p = $result.points[$name]
  if (-not $p -or -not $p.kill -or $p.kill.aborted) {
    $result.unverified += "$name kill point not completed"
    continue
  }
  $checks["$name.killWindowDeterministic"] = $p.kill.verdict.entryExeIsRc6 -and $p.kill.verdict.manifestStillRc5
  $checks["$name.killVerifiedZeroAlive"] = $p.kill.killedProcessFamilyKillVerified -eq $true
  $checks["$name.markersBothNull"] = $p.kill.verdict.installMarkerNull -and $p.kill.verdict.upgradeMarkerNull
  if ($p.directReinstall) {
    $checks["$name.directReinstallRefused"] = $p.directReinstall.exitCode -ne 0
    $checks["$name.directReinstallZeroWrites"] = $p.directReinstall.zeroWrites -eq $true
    $checks["$name.directReinstallDataUntouched"] = $p.directReinstall.dataDiff -eq 0
  } else { $result.unverified += "$name direct reinstall not measured" }
  if ($p.recovery) {
    $checks["$name.recoveryCleanInstallExit0"] = $p.recovery.cleanInstallExitCode -eq 0
    $checks["$name.recoveryTargetDataZeroDiff"] = $p.recovery.targetDataDiff.differenceCount -eq 0
    $checks["$name.recoveryLaDataZeroDiff"] = ($null -ne $p.recovery.laDataDiff) -and ($p.recovery.laDataDiff.differenceCount -eq 0)
    $checks["$name.recoveryStoreOpensAndHmac"] = ($p.recovery.openStore.opened -eq $true) -and ($p.recovery.openStore.auditChain.hmacVerified -eq $true)
  } else { $result.unverified += "$name recovery path not measured" }
}
$result.checks = $checks
$result.allChecksPassed = (@($checks.Values | Where-Object { $_ -ne $true }).Count -eq 0) -and ($checks.Count -gt 0)

$result | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Output "wrote $Out"
Write-Output ("checks: " + ($checks.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', ')
if ($result.unverified.Count -gt 0) { Write-Output ("unverified: " + ($result.unverified -join '; ')) }
