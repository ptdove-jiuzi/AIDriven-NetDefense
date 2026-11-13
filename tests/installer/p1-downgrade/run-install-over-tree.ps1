# P1-CLOSE / T2 downgrade-verifier — 对一个已有安装树跑一次 Setup（参数化：可用于
#   A2「/KEEPDATA 残留树上重装」与 C「不先卸载、直接用 rc.5 Setup 覆盖 rc.6 树」）。
#
# 只记录真实退出码、日志原文、install.json/bundle 前后值、两处 data 逐文件 sha256；
# **不做版本方向判断的模拟**（那正是被测对象），也不改任何产品代码。
# 装/卸动作全部在主机锁内；不传 /AUTOSTART（避免给主机写 Run 值，降级判据不需要它）。
#
# 用法：
#   pwsh -NoProfile -File tests/installer/p1-downgrade/run-install-over-tree.ps1 `
#        -Setup "dist\release\0.0.1-rc.5\AIDrivenNetDefense-Setup-0.0.1-rc.5.exe" `
#        -Target "$env:TEMP\upgrade-path\r4\t1" `
#        -OutDir "evidence\p1-close\downgrade\a2-install-rc5-over-keepdata-residue" `
#        -Label "A2 rc.5 over keepdata residue"
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$LocalAppDataData = '',
  [int]$MaxWaitMinutes = 40,
  [string]$Owner = 'downgrade-verifier'
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
. (Join-Path $PSScriptRoot 'lib-hash.ps1')
. (Join-Path $PSScriptRoot 'lib-setup.ps1')
. (Join-Path $repoRoot 'evidence\p1-close\tools\host-lock.ps1')
$snapshotScript = Join-Path $repoRoot 'evidence\p1-close\tools\host-snapshot.ps1'

$setupPath = (Resolve-Path -LiteralPath $Setup).Path
$target = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$out = (Resolve-Path -LiteralPath $OutDir).Path
$logLines = [System.Collections.Generic.List[string]]::new()
function Write-RunLog([string]$Line) {
  $stamped = '{0} {1}' -f (Get-Date -Format 'o'), $Line
  $logLines.Add($stamped)
  Write-Output $stamped
}
function Save-Json([string]$Path, $Value) {
  [System.IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 12) + "`n"), [System.Text.UTF8Encoding]::new($false))
}

$localAppDataDataPath = if ($LocalAppDataData -ne '') { $LocalAppDataData } else { Join-Path $env:LOCALAPPDATA 'AIDriven Net Defense\data' }
$targetDataPath = Join-Path $target 'data'

$result = [ordered]@{
  scenario = 'install-over-existing-tree'
  label = $Label
  startedAt = (Get-Date -Format 'o')
  owner = $Owner
  setup = [ordered]@{ path = $setupPath; bytes = (Get-Item -LiteralPath $setupPath).Length; sha256 = Get-FileSha256 $setupPath }
  target = $target
  before = [ordered]@{}
  run = [ordered]@{}
  after = [ordered]@{}
  dataComparison = [ordered]@{}
  refusal = [ordered]@{ detected = $false; lines = @() }
  notes = @()
}
Write-RunLog ("label: {0}" -f $Label)
Write-RunLog ("setup: {0} sha256={1}" -f $setupPath, $result.setup.sha256)

# ---------------------------------------------------------------- 前置
& $snapshotScript -Out (Join-Path $out 'host-before.json') -Label ("before-" + $Label) | ForEach-Object { Write-RunLog $_ }
$beforeTargetData = @(Get-TreeFingerprint -Root $targetDataPath)
$beforeLaData = @(Get-TreeFingerprint -Root $localAppDataDataPath)
Write-FingerprintTsv -Rows $beforeTargetData -Out (Join-Path $out 'data-target-before.tsv')
Write-FingerprintTsv -Rows $beforeLaData -Out (Join-Path $out 'data-localappdata-before.tsv')
$beforeShape = Get-TreeShape -Root $target
$beforeRecord = Get-InstallRecord -Root $target
$beforeBundle = $null
$bundleFile = Join-Path $target 'bundle.json'
if (Test-Path -LiteralPath $bundleFile) {
  $beforeBundle = [ordered]@{ path = $bundleFile; bytes = (Get-Item -LiteralPath $bundleFile).Length; sha256 = Get-FileSha256 $bundleFile }
  try { $beforeBundle.version = [string]((Get-Content -LiteralPath $bundleFile -Raw -Encoding utf8 | ConvertFrom-Json).version) } catch { }
}
$desktopExe = Join-Path $target 'AIDrivenNetDefense.exe'
$beforeDesktop = if (Test-Path -LiteralPath $desktopExe) { [ordered]@{ path = $desktopExe; bytes = (Get-Item -LiteralPath $desktopExe).Length; sha256 = Get-FileSha256 $desktopExe } } else { $null }
$result.before = [ordered]@{
  treeShape = $beforeShape
  installRecord = $beforeRecord
  bundle = $beforeBundle
  desktopExe = $beforeDesktop
  targetData = [ordered]@{ exists = (Test-Path -LiteralPath $targetDataPath); files = $beforeTargetData.Count }
  localAppDataData = [ordered]@{ exists = (Test-Path -LiteralPath $localAppDataDataPath); files = $beforeLaData.Count }
}
Save-Json (Join-Path $out 'tree-shape-before.json') $beforeShape
Write-RunLog ("before: install.json version={0} upgradedFrom={1}; bundle={2}; desktopExe sha={3}; tree files={4}" -f `
    $beforeRecord.version, $beforeRecord.upgradedFrom, $beforeBundle.sha256, $beforeDesktop.sha256, $beforeShape.fileCount)

# ---------------------------------------------------------------- 主机锁内执行 Setup
$lock = Acquire-HostLock -Owner $Owner -MaxWaitMinutes 180
$result.hostLock = [ordered]@{ acquired = $lock; owner = $Owner; at = (Get-Date -Format 'o') }
if (-not $lock) { throw 'could not acquire host lock; refusing to run Setup' }
try {
  # argv 只由 New-SetupArgumentList 的 switch 拼；不传 /AUTOSTART（本步不需要 Run 值，少一个主机副作用）。
  $arguments = New-SetupArgumentList -Target $target
  Write-RunLog ("run: {0} {1}" -f $setupPath, ($arguments -join ' '))
  $result.run = Invoke-SetupGuarded -Exe $setupPath -ArgumentList $arguments -TimeoutMinutes $MaxWaitMinutes
  Write-RunLog ("install exit={0} elapsed={1}s hangGuardKilled={2} logSeen={3} actualCmd={4}" -f `
      $result.run.exitCode, $result.run.elapsedSeconds, $result.run.hangGuardKilled, $result.run.logSeenWithinGuard, $result.run.actualCommandLine)
} finally {
  Release-HostLock
}

# ---------------------------------------------------------------- 日志原文
$newLogs = @($result.run.newLogs)
$result.logs = @()
$logDir = Join-Path $out 'logs'
foreach ($log in $newLogs) {
  $copied = Copy-SetupLogSmart -Source $log -DestDir $logDir
  if ($null -ne $copied) {
    $result.logs += $copied
    Write-RunLog ("log: {0} ({1} bytes, {2})" -f $copied.copy, $copied.bytes, $copied.encoding)
    $text = [System.IO.File]::ReadAllText($copied.text, [System.Text.Encoding]::UTF8)
    $hits = @($text -split "`r?`n" | Where-Object {
        $_ -match '安装被拒|Refusing to install|ERROR|WARN|upgradedFrom|版本|version:|不匹配|没有安装标记|目标'
      })
    if ($hits.Count -gt 0) {
      $result.refusal.lines = @($result.refusal.lines + $hits)
    }
  }
}
$refusalFile = Join-Path $out 'refusal-lines.txt'
[System.IO.File]::WriteAllText($refusalFile, (($result.refusal.lines -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
$result.refusal.detected = @($result.refusal.lines | Where-Object { $_ -match '安装被拒|Refusing to install|没有安装标记|不匹配' }).Count -gt 0
if ($newLogs.Count -eq 0) { $result.notes += '没有观测到新的 %TEMP%\\AIDriven-Setup-*.log；判据只依据退出码与磁盘状态。' }

# ---------------------------------------------------------------- 后置
& $snapshotScript -Out (Join-Path $out 'host-after.json') -Label ("after-" + $Label) | ForEach-Object { Write-RunLog $_ }
$afterTargetData = @(Get-TreeFingerprint -Root $targetDataPath)
$afterLaData = @(Get-TreeFingerprint -Root $localAppDataDataPath)
Write-FingerprintTsv -Rows $afterTargetData -Out (Join-Path $out 'data-target-after.tsv')
Write-FingerprintTsv -Rows $afterLaData -Out (Join-Path $out 'data-localappdata-after.tsv')
$afterShape = Get-TreeShape -Root $target
$afterRecord = Get-InstallRecord -Root $target
$afterBundle = $null
if (Test-Path -LiteralPath $bundleFile) {
  $afterBundle = [ordered]@{ path = $bundleFile; bytes = (Get-Item -LiteralPath $bundleFile).Length; sha256 = Get-FileSha256 $bundleFile }
  try { $afterBundle.version = [string]((Get-Content -LiteralPath $bundleFile -Raw -Encoding utf8 | ConvertFrom-Json).version) } catch { }
}
$afterDesktop = if (Test-Path -LiteralPath $desktopExe) { [ordered]@{ path = $desktopExe; bytes = (Get-Item -LiteralPath $desktopExe).Length; sha256 = Get-FileSha256 $desktopExe } } else { $null }
$result.after = [ordered]@{
  treeShape = $afterShape
  installRecord = $afterRecord
  bundle = $afterBundle
  desktopExe = $afterDesktop
  targetData = [ordered]@{ exists = (Test-Path -LiteralPath $targetDataPath); files = $afterTargetData.Count }
  localAppDataData = [ordered]@{ exists = (Test-Path -LiteralPath $localAppDataDataPath); files = $afterLaData.Count }
}
$result.dataComparison = [ordered]@{
  target = (Compare-Fingerprint -Before $beforeTargetData -After $afterTargetData -IgnoreSidecars)
  localAppData = (Compare-Fingerprint -Before $beforeLaData -After $afterLaData -IgnoreSidecars)
}
Save-Json (Join-Path $out 'tree-shape-after.json') $afterShape
Save-Json (Join-Path $out 'data-comparison.json') $result.dataComparison
Write-RunLog ("after: install.json version={0} upgradedFrom={1}; bundle={2}; desktopExe sha={3}; tree files={4}" -f `
    $afterRecord.version, $afterRecord.upgradedFrom, $afterBundle.sha256, $afterDesktop.sha256, $afterShape.fileCount)
Write-RunLog ("data target identical={0}; LA identical={1}; refusalDetected={2}" -f `
    $result.dataComparison.target.identical, $result.dataComparison.localAppData.identical, $result.refusal.detected)

# 版本方向是否被判断：只看真实结果（退出码 0 + install.json 里 version/upgradedFrom 的实际值）。
$result.interpretation = [ordered]@{
  exitCode = $result.run.exitCode
  installerWroteRecord = ($null -ne $afterRecord -and -not [string]::IsNullOrWhiteSpace([string]$afterRecord.version))
  versionBefore = $beforeRecord.version
  versionAfter = $afterRecord.version
  upgradedFromAfter = $afterRecord.upgradedFrom
  binariesReplaced = ($null -ne $beforeDesktop -and $null -ne $afterDesktop -and $beforeDesktop.sha256 -ne $afterDesktop.sha256)
  refusedWithMessage = $result.refusal.detected
}

$result.finishedAt = (Get-Date -Format 'o')
Save-Json (Join-Path $out 'RESULT.json') $result
[System.IO.File]::WriteAllText((Join-Path $out 'run.log'), ($logLines -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
Write-Output ("[install-over-tree] -> {0}" -f (Join-Path $out 'RESULT.json'))
