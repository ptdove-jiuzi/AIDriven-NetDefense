# P1-CLOSE / T2 downgrade-verifier — 场景 A 第 1 步：对真实 rc.6 树做 `/S /uninstall /DIR=<t> /KEEPDATA`。
#
# 只做一件事：**保数据卸载**，并把"删了什么/留了什么/两处 data 有没有变/卸载键与 Run 项去哪了"落盘。
# 本脚本**不** claim task-2、**不**写别人状态文件；所有装/卸动作都在主机锁内（README §3）。
#
# 用法（仓库根）：
#   pwsh -NoProfile -File tests/installer/p1-downgrade/run-uninstall-keepdata.ps1 `
#        -Target "$env:TEMP\upgrade-path\r4\t1" `
#        -OutDir "evidence\p1-close\downgrade\a-uninstall-keepdata"
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$SetupPath = '',
  [string]$LocalAppDataData = '',
  [int]$MaxWaitMinutes = 20,
  [string]$Owner = 'downgrade-verifier'
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
. (Join-Path $PSScriptRoot 'lib-hash.ps1')
. (Join-Path $PSScriptRoot 'lib-setup.ps1')
$lockScript = Join-Path $repoRoot 'evidence\p1-close\tools\host-lock.ps1'
$snapshotScript = Join-Path $repoRoot 'evidence\p1-close\tools\host-snapshot.ps1'
. $lockScript

$target = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
if (-not (Test-Path -LiteralPath $target)) { throw "target does not exist: $target" }
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

$result = [ordered]@{
  scenario = 'A1-uninstall-keepdata'
  startedAt = (Get-Date -Format 'o')
  owner = $Owner
  target = $target
  hostLock = $null
  installer = $null
  before = [ordered]@{}
  run = [ordered]@{}
  after = [ordered]@{}
  dataComparison = [ordered]@{}
  notes = @()
}

# 两处 data：①安装树内 data\ ②用户级 %LOCALAPPDATA%\AIDriven NetDefense\data（产品目录名无空格）。
$localAppDataDataPath = if ($LocalAppDataData -ne '') { $LocalAppDataData } else { Join-Path $env:LOCALAPPDATA 'AIDriven NetDefense\data' }
$targetDataPath = Join-Path $target 'data'
$result.localAppDataData = $localAppDataDataPath
$result.targetData = $targetDataPath

# ---------------------------------------------------------------- 求解卸载器（真实用户路径 = 树内副本）
$installer = $null
if ($SetupPath -ne '') {
  $installer = [ordered]@{ path = (Resolve-Path -LiteralPath $SetupPath).Path; source = 'explicit-parameter' }
} else {
  $internal = @()
  $installerDir = Join-Path $target 'installer'
  if (Test-Path -LiteralPath $installerDir) {
    $internal = @(Get-ChildItem -LiteralPath $installerDir -Filter '*.exe' -File -ErrorAction SilentlyContinue)
  }
  if ($internal.Count -gt 0) {
    $chosen = $internal | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $installer = [ordered]@{ path = $chosen.FullName; source = 'tree-internal-copy (registry UninstallString 指向的真实路径)' }
  } else {
    # 退路：外部 rc.6 Setup。必须如实记录这不是用户真实路径（N-017 的自匹配只在树内副本触发）。
    $fallback = Join-Path $repoRoot 'dist\release\0.0.1-rc.6\AIDrivenNetDefense-Setup-0.0.1-rc.6.exe'
    if (-not (Test-Path -LiteralPath $fallback)) { throw 'no tree-internal installer copy and no external rc.6 Setup' }
    $installer = [ordered]@{ path = $fallback; source = 'external-rc6-setup (FALLBACK: not the registry path)' }
    $result.notes += '树内没有 installer 副本，改用外部 rc.6 Setup；这不等于用户从"应用和功能"卸载的真实路径。'
  }
}
$installer.sha256 = Get-FileSha256 $installer.path
$installer.bytes = (Get-Item -LiteralPath $installer.path).Length
$result.installer = $installer
Write-RunLog ("installer: {0} ({1}) sha256={2}" -f $installer.path, $installer.source, $installer.sha256)

# ---------------------------------------------------------------- 前置快照 + 指纹
Write-RunLog 'host snapshot before'
& $snapshotScript -Out (Join-Path $out 'host-before.json') -Label 'before-uninstall-keepdata' | ForEach-Object { Write-RunLog $_ }

$beforeTargetData = @(Get-TreeFingerprint -Root $targetDataPath)
$beforeLaData = @(Get-TreeFingerprint -Root $localAppDataDataPath)
Write-FingerprintTsv -Rows $beforeTargetData -Out (Join-Path $out 'data-target-before.tsv')
Write-FingerprintTsv -Rows $beforeLaData -Out (Join-Path $out 'data-localappdata-before.tsv')
$beforeShape = Get-TreeShape -Root $target
$beforeRecord = Get-InstallRecord -Root $target
$result.before = [ordered]@{
  treeShape = $beforeShape
  installRecord = $beforeRecord
  targetData = [ordered]@{ path = $targetDataPath; exists = (Test-Path -LiteralPath $targetDataPath); files = $beforeTargetData.Count }
  localAppDataData = [ordered]@{ path = $localAppDataDataPath; exists = (Test-Path -LiteralPath $localAppDataDataPath); files = $beforeLaData.Count }
}
Save-Json (Join-Path $out 'tree-shape-before.json') $beforeShape
Write-RunLog ("before: tree files={0} bytes={1}; install.json version={2}; target data files={3}; LA data files={4}" -f `
    $beforeShape.fileCount, $beforeShape.bytes, ($beforeRecord.version), $beforeTargetData.Count, $beforeLaData.Count)

# ---------------------------------------------------------------- 主机锁内执行卸载
$lock = Acquire-HostLock -Owner $Owner -MaxWaitMinutes 180
$result.hostLock = [ordered]@{ acquired = $lock; owner = $Owner; at = (Get-Date -Format 'o') }
if (-not $lock) { throw 'could not acquire host lock; refusing to run Setup' }

try {
  # argv 只由 New-SetupArgumentList 的 switch 拼，调用方无法把引号当字面量塞进 argv。
  $arguments = New-SetupArgumentList -Target $target -Uninstall -KeepData
  Write-RunLog ("run: {0} {1}" -f $installer.path, ($arguments -join ' '))
  $result.run = Invoke-SetupGuarded -Exe $installer.path -ArgumentList $arguments -TimeoutMinutes $MaxWaitMinutes
  Write-RunLog ("uninstall exit={0} elapsed={1}s hangGuardKilled={2} logSeen={3} actualCmd={4}" -f `
      $result.run.exitCode, $result.run.elapsedSeconds, $result.run.hangGuardKilled, $result.run.logSeenWithinGuard, $result.run.actualCommandLine)
} finally {
  Release-HostLock
}

# ---------------------------------------------------------------- 本次日志
$newLogs = @($result.run.newLogs)
$result.logs = @()
$logDir = Join-Path $out 'logs'
foreach ($log in $newLogs) {
  $copied = Copy-SetupLogSmart -Source $log -DestDir $logDir
  if ($null -ne $copied) {
    $result.logs += $copied
    Write-RunLog ("log: {0} -> {1} ({2} bytes, {3})" -f $copied.source, $copied.copy, $copied.bytes, $copied.encoding)
  }
}
if ($newLogs.Count -eq 0) { $result.notes += '没有观测到新的 %TEMP%\\AIDriven-Setup-*.log（安装器可能未写日志）；结果只依据退出码与磁盘状态。' }

# ---------------------------------------------------------------- 后置状态
Write-RunLog 'host snapshot after'
& $snapshotScript -Out (Join-Path $out 'host-after.json') -Label 'after-uninstall-keepdata' | ForEach-Object { Write-RunLog $_ }

$afterTargetData = @(Get-TreeFingerprint -Root $targetDataPath)
$afterLaData = @(Get-TreeFingerprint -Root $localAppDataDataPath)
Write-FingerprintTsv -Rows $afterTargetData -Out (Join-Path $out 'data-target-after.tsv')
Write-FingerprintTsv -Rows $afterLaData -Out (Join-Path $out 'data-localappdata-after.tsv')
$afterShape = Get-TreeShape -Root $target
$afterRecord = Get-InstallRecord -Root $target
Save-Json (Join-Path $out 'tree-shape-after.json') $afterShape
$result.after = [ordered]@{
  treeShape = $afterShape
  installRecord = $afterRecord
  targetData = [ordered]@{ exists = (Test-Path -LiteralPath $targetDataPath); files = $afterTargetData.Count }
  localAppDataData = [ordered]@{ exists = (Test-Path -LiteralPath $localAppDataDataPath); files = $afterLaData.Count }
}
$result.dataComparison = [ordered]@{
  target = (Compare-Fingerprint -Before $beforeTargetData -After $afterTargetData -IgnoreSidecars)
  localAppData = (Compare-Fingerprint -Before $beforeLaData -After $afterLaData -IgnoreSidecars)
}
Save-Json (Join-Path $out 'data-comparison.json') $result.dataComparison
Write-RunLog ("data target identical={0}; LA identical={1}" -f `
    $result.dataComparison.target.identical, $result.dataComparison.localAppData.identical)

# ---------------------------------------------------------------- 收尾
$result.finishedAt = (Get-Date -Format 'o')
Save-Json (Join-Path $out 'RESULT.json') $result
[System.IO.File]::WriteAllText((Join-Path $out 'run.log'), ($logLines -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
Write-Output ("[A1] -> {0}" -f (Join-Path $out 'RESULT.json'))
if ($null -ne $result.run.exitCode -and $result.run.exitCode -ne 0) {
  Write-Output ("[A1] uninstall exited {0} (kept as-is; not retried)" -f $result.run.exitCode)
}
