# Enumerate (and optionally kill) the whole process family of an installer run, then
# prove the family is actually gone.
#
# Round-5 powercut seat (POST-SHIP-PATH / powercut-r5).
#
# Why a *family*: the factory Setup is a PyInstaller one-file executable, so one run is
# two processes with the *same image path* — the bootloader (parent) and the Python
# application (child). Killing only the parent leaves the child copying files, and the
# experiment silently stops being a power-cut (round-3/round-4 both had to enumerate the
# family; see status/UPGRADE-PATH.md §8.4 / §9.4).
#
# Selection is the union of:
#   * every process whose ExecutablePath equals -ImagePath (catches both PyInstaller sides),
#   * -RootPid (the pid Start-Process returned) plus all transitive descendants
#     (catches a child that re-execs something else).
#
# `killVerified` is the point of the record: after Stop-Process the script polls
# `Get-Process -Id` until every pid is gone (max -VerifySeconds), and only then reports
# aliveAfter=0. A power-cut claim with a live pid in it is not a claim.
#
# Author: PT-dove
param(
  [string]$ImagePath = '',
  [int]$RootPid = 0,
  [switch]$Kill,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Label = '',
  [int]$VerifySeconds = 20
)
$ErrorActionPreference = 'Stop'

function Get-Snapshot {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $byId = @{}
  foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }

  $selected = New-Object System.Collections.Generic.HashSet[int]
  if ($ImagePath) {
    $want = [System.IO.Path]::GetFullPath($ImagePath)
    foreach ($p in $all) {
      if ($p.ExecutablePath -and ([System.IO.Path]::GetFullPath($p.ExecutablePath) -ieq $want)) {
        [void]$selected.Add([int]$p.ProcessId)
      }
    }
  }
  if ($RootPid -gt 0) {
    [void]$selected.Add($RootPid)
    # transitive descendants, bounded rounds: the family tree here is at most a few deep
    for ($round = 0; $round -lt 8; $round++) {
      $added = 0
      foreach ($p in $all) {
        if ($selected.Contains([int]$p.ProcessId)) { continue }
        if ($selected.Contains([int]$p.ParentProcessId)) {
          [void]$selected.Add([int]$p.ProcessId)
          $added++
        }
      }
      if ($added -eq 0) { break }
    }
  }
  # depth from the family roots (parent outside the selection => depth 0)
  $depth = @{}
  foreach ($id in $selected) { $depth[$id] = 0 }
  for ($round = 0; $round -lt 8; $round++) {
    $changed = $false
    foreach ($id in @($selected)) {
      $p = $byId[$id]
      if ($null -eq $p) { continue }
      $parent = [int]$p.ParentProcessId
      if ($selected.Contains($parent)) {
        $candidate = $depth[$parent] + 1
        if ($candidate -gt $depth[$id]) { $depth[$id] = $candidate; $changed = $true }
      }
    }
    if (-not $changed) { break }
  }

  $rows = @()
  foreach ($id in @($selected | Sort-Object)) {
    $p = $byId[$id]
    if ($null -eq $p) {
      $rows += [ordered]@{ processId = $id; note = 'not found in this snapshot (already exited)' }
      continue
    }
    $rows += [ordered]@{
      processId       = [int]$p.ProcessId
      parentProcessId = [int]$p.ParentProcessId
      name            = $p.Name
      executablePath  = $p.ExecutablePath
      commandLine     = $p.CommandLine
      creationDate    = if ($p.CreationDate) { ([datetime]$p.CreationDate).ToString('o') } else { $null }
      depth           = $depth[$id]
    }
  }
  return $rows
}

$killedAt = $null
$family = Get-Snapshot
$killed = @()
if ($Kill) {
  $killedAt = (Get-Date).ToString('o')
  # deepest first: killing a parent first can orphan the child, and an orphan keeps copying
  foreach ($row in @($family | Sort-Object -Property @{ Expression = { $_.depth }; Descending = $true })) {
    if ($row.Contains('processId')) {
      try { Stop-Process -Id $row.processId -Force -ErrorAction Stop; $killed += $row.processId } catch { }
    }
  }
}

$deadline = (Get-Date).AddSeconds($VerifySeconds)
$alive = @()
if ($Kill) {
  do {
    $alive = @()
    foreach ($row in $family) {
      if (-not $row.Contains('processId')) { continue }
      if (Get-Process -Id $row.processId -ErrorAction SilentlyContinue) { $alive += $row.processId }
    }
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
}

$report = [ordered]@{
  label                 = $Label
  capturedAt            = (Get-Date).ToString('o')
  imagePathFilter       = if ($ImagePath) { [System.IO.Path]::GetFullPath($ImagePath) } else { $null }
  rootPid               = if ($RootPid -gt 0) { $RootPid } else { $null }
  killRequested         = [bool]$Kill
  killedAt              = $killedAt
  family                = @($family)
  processIds            = @($family | Where-Object { $_.Contains('processId') } | ForEach-Object { $_.processId })
  stopProcessRequested  = @($killed)
  aliveAfter            = @($alive)
  aliveAfterCount       = $alive.Count
  killVerified          = if ($Kill) { ($alive.Count -eq 0) } else { $null }
  verifyWindowSeconds   = $VerifySeconds
}
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$report | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Output ("process-family[{0}] -> {1}  pids=[{2}] kill={3} aliveAfter=[{4}] verified={5}" -f `
    $Label, $Out, ($report.processIds -join ','), $report.killRequested, ($alive -join ','), $report.killVerified)
