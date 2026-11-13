# P1-CLOSE / T2 downgrade-verifier — Setup 调用的唯一入口（argv 自建 + hang guard + 取证）。
#
# 为什么要有这个文件（T1 2026-11-13 事故的硬教训，见 evidence/p1-close/upgrade/tools/run-setup.ps1 头注）：
# 从命令行接收 `-SetupArgs '/S',"/DIR=…"` 时，PowerShell 会把引号当**字面字符**绑进来，
# 安装器于是看到 `'/S'`（带引号），无法解析成静默模式；它没有控制台，就弹 MessageBoxW ——
# 实测挂 205 s、什么都没写。所以：
#   1. argv **只由本文件的 switch 拼**，调用方拿不到"往 argv 里塞字符串"的能力；
#   2. 带空格的 /DIR= 整体加引号（N-012 §4 的 argv 拆分事故）；
#   3. 静默安装器必须在 LogWaitSeconds 内写出自己的日志；没写 = 在等模态框 → 杀掉并如实记录；
#   4. 用 Win32_Process.CommandLine 取**真实命令行**落盘，证明 argv 没被引号污染。
#
# Author: PT-dove
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
  构造 Setup.exe 的 argv。只允许 switch，不接受调用方传入的字符串数组。
#>
function New-SetupArgumentList {
  param(
    [Parameter(Mandatory = $true)][string]$Target,
    [switch]$Uninstall,
    [switch]$KeepData,
    [switch]$Autostart,
    [switch]$NoRegistry,
    [switch]$NoShortcut
  )
  $argv = @('/S')
  if ($Uninstall) { $argv += '/uninstall' }
  # /DIR= 只在这里拼。目标含空格时不加引号会被拆成多个 argv（N-012 §4）。
  $dirArg = if ($Target -match '\s') { '/DIR="' + $Target + '"' } else { '/DIR=' + $Target }
  $argv += $dirArg
  if ($Autostart) { $argv += '/AUTOSTART' }
  if ($KeepData) { $argv += '/KEEPDATA' }
  if ($NoRegistry) { $argv += '/NOREG' }
  if ($NoShortcut) { $argv += '/NOSHORTCUT' }
  return , $argv
}

<#
.SYNOPSIS
  跑一次 Setup 并返回可落盘的运行记录（不写 RESULT，不持锁——锁由调用方持有）。
#>
function Invoke-SetupGuarded {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ArgumentList,
    [int]$TimeoutMinutes = 40,
    [int]$LogWaitSeconds = 45
  )
  $logsBefore = Get-SetupLogSet
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $Exe -ArgumentList $ArgumentList -PassThru -WindowStyle Hidden

  # 取证：真实的命令行（不是我们以为传进去的）。
  Start-Sleep -Milliseconds 1200
  $actualCommandLine = $null
  try {
    $cim = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=$($proc.Id)") -ErrorAction SilentlyContinue
    if ($null -ne $cim) { $actualCommandLine = $cim.CommandLine }
  } catch { }

  # hang guard：静默安装器会立刻建日志。没建 = 在等模态框（引号/参数解析失败），杀掉而不是等 40 min。
  $logSeen = $false
  $guard = [System.Diagnostics.Stopwatch]::StartNew()
  while ($guard.Elapsed.TotalSeconds -lt $LogWaitSeconds) {
    Start-Sleep -Milliseconds 700
    if (@(Get-NewSetupLogs -Before $logsBefore -After (Get-SetupLogSet)).Count -gt 0) { $logSeen = $true; break }
    if ($proc.HasExited) { break }
  }
  $hangGuardKilled = $false
  if (-not $logSeen -and -not $proc.HasExited) {
    $hangGuardKilled = $true
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
    # PyInstaller onefile 的 bootloader 与 Python 子进程同名不同 pid，一起收掉。
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessName -eq $proc.ProcessName -and $_.Id -ne $PID } |
      ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { } }
  }

  $exited = $proc.WaitForExit([int]($TimeoutMinutes * 60 * 1000))
  $stopwatch.Stop()
  $exitCode = $null
  if ($exited) {
    $exitCode = $proc.ExitCode
  } else {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
  }
  Start-Sleep -Milliseconds 800

  return [ordered]@{
    argv = @($ArgumentList)
    argvJoined = ($ArgumentList -join ' ')
    pid = $proc.Id
    actualCommandLine = $actualCommandLine
    commandLineMatchesArgv = ($null -ne $actualCommandLine -and $actualCommandLine -notmatch "'/S'")
    exitCode = $exitCode
    timedOut = (-not $exited)
    hangGuardKilled = $hangGuardKilled
    logSeenWithinGuard = $logSeen
    elapsedMs = [long]$stopwatch.ElapsedMilliseconds
    elapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 2)
    newLogs = @(Get-NewSetupLogs -Before $logsBefore -After (Get-SetupLogSet))
  }
}
