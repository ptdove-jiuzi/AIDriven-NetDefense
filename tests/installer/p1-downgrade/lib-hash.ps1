# P1-CLOSE / T2 downgrade-verifier — 数据面哈希与日志工具（只读；被 run-*.ps1 dot-source）。
# 纪律：本文件不删任何东西；只算 sha256、写 TSV/JSON（UTF-8 无 BOM）。
# Author: PT-dove
$ErrorActionPreference = 'Stop'

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

<#
.SYNOPSIS
  逐文件指纹：相对路径 / 字节数 / sha256 / mtime(o)。目录不存在返回 @()（调用方自己记录 missing）。
#>
function Get-TreeFingerprint {
  param([Parameter(Mandatory = $true)][string]$Root)
  $rows = @()
  if (-not (Test-Path -LiteralPath $Root)) { return $rows }
  $rootFull = (Get-Item -LiteralPath $Root).FullName
  foreach ($file in Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force -ErrorAction SilentlyContinue) {
    $rel = $file.FullName.Substring($rootFull.Length).TrimStart('\')
    $rows += [ordered]@{
      path = $rel
      bytes = $file.Length
      sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      mtime = $file.LastWriteTime.ToString('o')
    }
  }
  return @($rows | Sort-Object { $_.path })
}

function Write-FingerprintTsv {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Rows,
    [Parameter(Mandatory = $true)][string]$Out
  )
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine("path`tbytes`tsha256`tmtime")
  foreach ($row in $Rows) {
    [void]$sb.AppendLine(("{0}`t{1}`t{2}`t{3}" -f $row.path, $row.bytes, $row.sha256, $row.mtime))
  }
  [System.IO.File]::WriteAllText($Out, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
}

<#
.SYNOPSIS
  两个指纹集合的差异（按相对路径 + sha256）。返回 added/removed/changed/sameCount。
#>
function Compare-Fingerprint {
  param(
    [AllowEmptyCollection()][object[]]$Before = @(),
    [AllowEmptyCollection()][object[]]$After = @(),
    # WAL 的 -wal/-shm 是 SQLite 记账文件：正常开关库会让它出现/消失，不代表"数据被改"。
    # 判"data 是否逐字节不变"时默认忽略它们，另在 sidecarOnly 里如实列出。
    [switch]$IgnoreSidecars
  )
  $isSidecar = { param($p) $p -match '-(wal|shm)$' }
  $rawBefore = @($Before)
  $rawAfter = @($After)
  if ($IgnoreSidecars) {
    $Before = @($Before | Where-Object { -not (& $isSidecar $_.path) })
    $After = @($After | Where-Object { -not (& $isSidecar $_.path) })
  }
  $beforeMap = @{}
  foreach ($row in $Before) { $beforeMap[$row.path] = $row }
  $afterMap = @{}
  foreach ($row in $After) { $afterMap[$row.path] = $row }
  $added = @($afterMap.Keys | Where-Object { -not $beforeMap.ContainsKey($_) } | Sort-Object)
  $removed = @($beforeMap.Keys | Where-Object { -not $afterMap.ContainsKey($_) } | Sort-Object)
  $changed = @($afterMap.Keys | Where-Object {
      $beforeMap.ContainsKey($_) -and $beforeMap[$_].sha256 -ne $afterMap[$_].sha256
    } | Sort-Object)
  $same = @($afterMap.Keys | Where-Object {
      $beforeMap.ContainsKey($_) -and $beforeMap[$_].sha256 -eq $afterMap[$_].sha256
    }).Count
  $sidecarBefore = @($rawBefore | Where-Object { & $isSidecar $_.path } | ForEach-Object { $_.path })
  $sidecarAfter = @($rawAfter | Where-Object { & $isSidecar $_.path } | ForEach-Object { $_.path })
  return [ordered]@{
    added = $added
    removed = $removed
    changed = $changed
    sameCount = $same
    beforeCount = $Before.Count
    afterCount = $After.Count
    ignoredSidecars = [ordered]@{ before = $sidecarBefore; after = $sidecarAfter }
    identical = ($added.Count -eq 0 -and $removed.Count -eq 0 -and $changed.Count -eq 0)
  }
}

<#
.SYNOPSIS
  把 Setup 写的日志按"UTF-8 严格解码失败则按 CP936(GBK)"读成文本，并原样复制一份字节到证据目录。
  返回 { source, copy, text }。
#>
function Copy-SetupLogSmart {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$DestDir
  )
  if (-not (Test-Path -LiteralPath $Source)) { return $null }
  if (-not (Test-Path -LiteralPath $DestDir)) { New-Item -ItemType Directory -Path $DestDir -Force | Out-Null }
  $copy = Join-Path $DestDir (Split-Path -Leaf $Source)
  Copy-Item -LiteralPath $Source -Destination $copy -Force

  $bytes = [System.IO.File]::ReadAllBytes($Source)
  $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
  try {
    $text = $strictUtf8.GetString($bytes)
    $encoding = 'utf-8'
  } catch {
    $text = [System.Text.Encoding]::GetEncoding(936).GetString($bytes)
    $encoding = 'cp936'
  }
  $txt = Join-Path $DestDir ((Split-Path -Leaf $Source) + '.utf8.txt')
  [System.IO.File]::WriteAllText($txt, $text, [System.Text.UTF8Encoding]::new($false))
  return [ordered]@{ source = $Source; copy = $copy; text = $txt; encoding = $encoding; bytes = $bytes.Length }
}

<#
.SYNOPSIS
  Setup 进程启动前的 %TEMP%\AIDriven-Setup-*.log 集合快照，用来在运行后精确取到"本次"日志。
#>
function Get-SetupLogSet {
  return @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'AIDriven-Setup-*.log' -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName })
}

function Get-NewSetupLogs {
  param(
    [AllowEmptyCollection()][string[]]$Before = @(),
    [AllowEmptyCollection()][string[]]$After = @()
  )
  $beforeSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$Before)
  return @($After | Where-Object { -not $beforeSet.Contains($_) } | Sort-Object)
}

<#
.SYNOPSIS
  取一棵安装树里 install\install.json 的关键字段（不存在返回 $null）。
#>
function Get-InstallRecord {
  param([Parameter(Mandatory = $true)][string]$Root)
  $record = Join-Path $Root 'install\install.json'
  if (-not (Test-Path -LiteralPath $record)) { return $null }
  try {
    $json = Get-Content -LiteralPath $record -Raw -Encoding utf8 | ConvertFrom-Json
    $ownership = $null
    if ($null -ne $json.PSObject.Properties['ownership']) {
      $ownership = [ordered]@{
        scheme = $json.ownership.scheme
        # 凭据本体不落证据，只记长度与是否绑定路径。
        hmacLength = ([string]$json.ownership.hmac).Length
        boundPath = [string]$json.ownership.installPath
      }
    }
    return [ordered]@{
      path = $record
      bytes = (Get-Item -LiteralPath $record).Length
      sha256 = Get-FileSha256 $record
      product = [string]$json.product
      version = [string]$json.version
      channel = [string]$json.channel
      installPath = [string]$json.installPath
      upgradedFrom = [string]$json.upgradedFrom
      autostart = $json.autostart
      hasOwnership = ($null -ne $ownership)
      ownership = $ownership
    }
  } catch {
    return [ordered]@{ path = $record; error = $_.Exception.Message }
  }
}

<#
.SYNOPSIS
  安装树顶层构成（kept/deleted 判定用）与关键标记是否存在。
#>
function Get-TreeShape {
  param([Parameter(Mandatory = $true)][string]$Root)
  $result = [ordered]@{
    exists = (Test-Path -LiteralPath $Root)
    children = @()
    installJson = (Test-Path -LiteralPath (Join-Path $Root 'install\install.json'))
    bundleJson = (Test-Path -LiteralPath (Join-Path $Root 'bundle.json'))
    manifests = (Test-Path -LiteralPath (Join-Path $Root 'manifests\files.sha256'))
    installerCopy = @()
    dataDir = (Test-Path -LiteralPath (Join-Path $Root 'data'))
    dshHome = (Test-Path -LiteralPath (Join-Path $Root 'dsh-home'))
    fileCount = 0
    bytes = 0
  }
  if (-not $result.exists) { return $result }
  foreach ($child in Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue) {
    $isDir = $child.PSIsContainer
    $size = 0
    $count = 0
    if ($isDir) {
      $files = @(Get-ChildItem -LiteralPath $child.FullName -Recurse -File -Force -ErrorAction SilentlyContinue)
      $count = $files.Count
      $size = ($files | Measure-Object -Property Length -Sum).Sum
    } else {
      $count = 1
      $size = $child.Length
    }
    $result.children += [ordered]@{ name = $child.Name; isDir = $isDir; files = $count; bytes = [long]$size }
    $result.fileCount += $count
    $result.bytes += [long]$size
  }
  $installerDir = Join-Path $Root 'installer'
  if (Test-Path -LiteralPath $installerDir) {
    $result.installerCopy = @(Get-ChildItem -LiteralPath $installerDir -File -ErrorAction SilentlyContinue | ForEach-Object {
        [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = Get-FileSha256 $_.FullName }
      })
  }
  return $result
}
