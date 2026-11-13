# r2-mutations.ps1 — falsifiability checks for the *evidence chain* used by round-2 T1.
#
#   *** THIS IS NOT THE LEDGER ④. ***
#   The ledger's ④ means "break the FIX line and the assertion turns red".  UPGRADE-001 has
#   no fix line in this round (② is structurally impossible: deploy/** is a forbidden write
#   domain), so no ledger-④ mutation exists.  What is mutated here is the *probe/判断* itself:
#   if the judgement still passes after the check is gutted, the evidence proves nothing.
#   Both mutations are applied to COPIES under this evidence root, never to the shipped
#   scripts or product code, and the copies are restored and sha256-verified afterwards.
#
#   M1  marker probe forced true      -> a half-copied tree must flip from "not ours /
#                                        reinstall refused" to "ours / reinstall allowed".
#   M2  data comparison degraded to   -> a one-byte change in the user's data must flip from
#       path-name only                   "differences" to a false "0 differences".
#
#   pwsh -NoProfile -File r2-mutations.ps1 -Which M2
#   pwsh -NoProfile -File r2-mutations.ps1 -Which M1 -Tree <half-copied tree>
#   pwsh -NoProfile -File r2-mutations.ps1 -Which BOTH -Tree <tree>
#
# Author: PT-dove
param(
  [ValidateSet('M1', 'M2', 'BOTH')][string]$Which = 'BOTH',
  [string]$Tree = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'r2-lib.ps1')

$root = Join-Path $env:R2Ev 'mutations'
New-Item -ItemType Directory -Path $root -Force | Out-Null
$report = [ordered]@{
  at = (Get-Date).ToString('o')
  warning = 'NOT the ledger ④: UPGRADE-001 has no fix line in this round (deploy/** forbidden write domain); these mutations break the PROBE, and are labelled as such.'
  mutations = @()
}

# ------------------------------------------------------------------ M2
function Invoke-M2DataCompareDegradation {
  $dir = Join-Path $root 'M2'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $original = Join-Path $PSScriptRoot 'compare-fingerprint.ps1'
  $mutated = Join-Path $dir 'compare-names-only.ps1'
  Copy-Item -LiteralPath $original -Destination $mutated -Force
  $originalSha = Get-R2Sha $original
  $copyShaBefore = Get-R2Sha $mutated
  # degrade: keep the path set comparison, drop the per-file sha256/byte comparison entirely
  $text = [System.IO.File]::ReadAllText($mutated)
  $needle = 'differenceCount = $added.Count + $removed.Count + $changed.Count + $resized.Count'
  if (-not $text.Contains($needle)) { throw 'M2 patch anchor not found in compare-fingerprint.ps1' }
  $text = $text.Replace($needle, 'differenceCount = $added.Count + $removed.Count  # M2 MUTATION: per-file content comparison removed on purpose')
  [System.IO.File]::WriteAllText($mutated, $text, [System.Text.UTF8Encoding]::new($false))
  $mutatedSha = Get-R2Sha $mutated

  # a real seeded data tree (product's own event-store), then a one-file content change
  $dataDir = Join-Path $dir 'data'
  if (Test-Path -LiteralPath $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force }
  $seed = & $env:R2Node (Join-Path $PSScriptRoot 'seed-data.mjs') --data-dir $dataDir --events 10 2>&1
  $beforeTsv = Join-Path $dir 'before.tsv'
  $beforeJson = Join-Path $dir 'before.json'
  [void](Get-R2DataFingerprint -Root $dataDir -OutTsv $beforeTsv -OutJson $beforeJson)

  $victim = Join-Path $dataDir 'notes\升级前说明.txt'
  $pristine = [System.IO.File]::ReadAllBytes($victim)
  [System.IO.File]::AppendAllText($victim, "`nM2-TAMPER: one byte of user data changed`n", [System.Text.UTF8Encoding]::new($false))
  $afterTsv = Join-Path $dir 'after-tampered.tsv'
  $afterJson = Join-Path $dir 'after-tampered.json'
  [void](Get-R2DataFingerprint -Root $dataDir -OutTsv $afterTsv -OutJson $afterJson)

  $honestOut = & pwsh -NoProfile -File $original -Before $beforeTsv -After $afterTsv -Out (Join-Path $dir 'diff-honest.json') 2>&1
  $honest = Get-R2JsonFile (Join-Path $dir 'diff-honest.json')
  $mutantOut = & pwsh -NoProfile -File $mutated -Before $beforeTsv -After $afterTsv -Out (Join-Path $dir 'diff-mutant.json') 2>&1
  $mutant = Get-R2JsonFile (Join-Path $dir 'diff-mutant.json')

  # restore the victim bytes and prove the honest comparison is 0 again
  [System.IO.File]::WriteAllBytes($victim, $pristine)
  $restoredTsv = Join-Path $dir 'after-restored.tsv'
  [void](Get-R2DataFingerprint -Root $dataDir -OutTsv $restoredTsv -OutJson (Join-Path $dir 'after-restored.json'))
  $restoreOut = & pwsh -NoProfile -File $original -Before $beforeTsv -After $restoredTsv -Out (Join-Path $dir 'diff-restored.json') 2>&1
  $restored = Get-R2JsonFile (Join-Path $dir 'diff-restored.json')

  # restore the mutated copy back to the shipped script and prove sha256 equality
  Copy-Item -LiteralPath $original -Destination $mutated -Force
  $copyShaAfterRestore = Get-R2Sha $mutated

  $entry = [ordered]@{
    id = 'M2-data-compare-degraded-to-path-name'
    what = 'compare-fingerprint.ps1 copy patched to ignore per-file sha256/bytes (path-set only)'
    honestDifferenceCount = $honest.differenceCount
    mutantDifferenceCount = $mutant.differenceCount
    flippedToFalseZero = [bool](($honest.differenceCount -gt 0) -and ($mutant.differenceCount -eq 0))
    honestOutput = ($honestOut -join "`n")
    mutantOutput = ($mutantOut -join "`n")
    restoredDifferenceCount = $restored.differenceCount
    restoredOutput = ($restoreOut -join "`n")
    originalSha256 = $originalSha
    copyShaBefore = $copyShaBefore
    mutatedCopySha256 = $mutatedSha
    restoredCopySha256 = $copyShaAfterRestore
    copyRestoredExactly = ($copyShaAfterRestore -eq $originalSha)
    seedOutput = ($seed -join "`n")
  }
  Save-R2Json $entry (Join-Path $dir 'mutation.json')
  Write-Output ("M2 honestDiff={0} mutantDiff={1} flipped={2} restoredDiff={3} copyRestoredExactly={4}" -f `
      $entry.honestDifferenceCount, $entry.mutantDifferenceCount, $entry.flippedToFalseZero, $entry.restoredDifferenceCount, $entry.copyRestoredExactly)
  return $entry
}

# ------------------------------------------------------------------ M1
function Invoke-M1MarkerForcedTrue {
  param([string]$TargetTree)
  if (-not $TargetTree) { throw 'M1 requires -Tree <half-copied tree>' }
  $dir = Join-Path $root 'M1'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $original = Join-Path $PSScriptRoot 'marker-probe.py'
  $mutated = Join-Path $dir 'marker-probe-forced-true.py'
  Copy-Item -LiteralPath $original -Destination $mutated -Force
  $originalSha = Get-R2Sha $original
  $copyShaBefore = Get-R2Sha $mutated
  $text = [System.IO.File]::ReadAllText($mutated)
  $needle = '    sys.stdout.write(json.dumps(report, ensure_ascii=False) + "\n")'
  if (-not $text.Contains($needle)) { throw 'M1 patch anchor not found in marker-probe.py' }
  $patched = $text.Replace($needle, "    report[`"installMarker`"] = `"forced-true-M1`"`r`n    report[`"upgradeMarker`"] = `"forced-true-M1`"`r`n" + $needle)
  [System.IO.File]::WriteAllText($mutated, $patched, [System.Text.UTF8Encoding]::new($false))
  $mutatedSha = Get-R2Sha $mutated

  $honestRaw = & $env:R2Python $original $env:R2App $TargetTree 2>&1
  $honest = @($honestRaw | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1) | ConvertFrom-Json
  $mutantRaw = & $env:R2Python $mutated $env:R2App $TargetTree 2>&1
  $mutant = @($mutantRaw | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1) | ConvertFrom-Json
  Set-Content -LiteralPath (Join-Path $dir 'honest-probe.txt') -Value ($honestRaw -join "`n") -Encoding utf8
  Set-Content -LiteralPath (Join-Path $dir 'mutant-probe.txt') -Value ($mutantRaw -join "`n") -Encoding utf8

  # the judgement under test: "does the normal (non-recovery) path treat this tree as ours?"
  $honestVerdict = [bool]($honest.installMarker -and $honest.upgradeMarker)
  $mutantVerdict = [bool]($mutant.installMarker -and $mutant.upgradeMarker)

  Copy-Item -LiteralPath $original -Destination $mutated -Force
  $copyShaAfterRestore = Get-R2Sha $mutated
  $honestAgainRaw = & $env:R2Python $original $env:R2App $TargetTree 2>&1
  $honestAgain = @($honestAgainRaw | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1) | ConvertFrom-Json

  $entry = [ordered]@{
    id = 'M1-marker-probe-forced-true'
    what = 'marker-probe.py copy patched to report non-null install/upgrade markers unconditionally'
    tree = $TargetTree
    honestInstallMarker = $honest.installMarker
    honestUpgradeMarker = $honest.upgradeMarker
    mutantInstallMarker = $mutant.installMarker
    mutantUpgradeMarker = $mutant.upgradeMarker
    honestVerdictOurs = $honestVerdict
    mutantVerdictOurs = $mutantVerdict
    flipped = ($honestVerdict -ne $mutantVerdict)
    treeFacts = Get-R2TreeFacts $TargetTree
    originalSha256 = $originalSha
    copyShaBefore = $copyShaBefore
    mutatedCopySha256 = $mutatedSha
    restoredCopySha256 = $copyShaAfterRestore
    copyRestoredExactly = ($copyShaAfterRestore -eq $originalSha)
    honestRepeatInstallMarker = $honestAgain.installMarker
  }
  Save-R2Json $entry (Join-Path $dir 'mutation.json')
  Write-Output ("M1 honestVerdict={0} mutantVerdict={1} flipped={2} copyRestoredExactly={3}" -f $entry.honestVerdictOurs, $entry.mutantVerdictOurs, $entry.flipped, $entry.copyRestoredExactly)
  return $entry
}

if ($Which -eq 'M2' -or $Which -eq 'BOTH') { $report.mutations += (Invoke-M2DataCompareDegradation) }
if ($Which -eq 'M1' -or $Which -eq 'BOTH') { $report.mutations += (Invoke-M1MarkerForcedTrue -TargetTree $Tree) }
$report.allFlipped = (@($report.mutations | Where-Object { $_.flipped -eq $true -or $_.flippedToFalseZero -eq $true }).Count -eq $report.mutations.Count)
Save-R2Json $report (Join-Path $root 'MUTATIONS.json')
Write-Output ("-> {0}" -f (Join-Path $root 'MUTATIONS.json'))
