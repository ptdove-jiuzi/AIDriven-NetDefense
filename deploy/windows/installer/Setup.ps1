#requires -Version 5.1
<#
  AIDriven NetDefense - Windows x64 test installer
  Author: PT-dove
  Licence: see repository LICENSE

  Test build only. Unsigned. Windows will show "unknown publisher" for the
  launcher folder; that is expected and accepted for this distribution model.
#>
# Arguments are parsed by hand so that Setup.cmd can forward %* verbatim:
#   /S            silent
#   /DIR=<path>   target directory
#   /NOREG        do not touch the uninstall registry key
#   /NOSHORTCUT   do not create Start Menu / desktop shortcuts
#   /AUTOSTART    register the optional HKCU Run autostart entry (off by default)
#   /uninstall    uninstall instead of install
$S = $false
$NOREG = $false
$NoShortcut = $false
$Uninstall = $false
$Autostart = $false
$DIR = $null
foreach ($a in $args) {
    if ($a -ieq '/S') { $S = $true; continue }
    if ($a -ieq '/NOREG') { $NOREG = $true; continue }
    if ($a -ieq '/NOSHORTCUT') { $NoShortcut = $true; continue }
    if ($a -ieq '/AUTOSTART') { $Autostart = $true; continue }
    if ($a -ieq '/uninstall') { $Uninstall = $true; continue }
    if ($a -imatch '^/DIR=(.+)$') { $DIR = $Matches[1].Trim('"'); continue }
}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:ProductName   = 'AIDriven NetDefense'
# SEED-05: single version source. `VERSION` next to this script is the only place the
# installer's own version is written down; build-dist.cmd, the PE version resource and
# the desktop build read the same file. The literal below is the reviewed fallback for
# the in-tree copy (<target>\installer\Setup.ps1) when VERSION was not packaged.
$script:ProductVer    = '0.0.1-rc.6'
$script:VersionFile   = Join-Path $PSScriptRoot 'VERSION'
if (Test-Path -LiteralPath $script:VersionFile -PathType Leaf) {
    $versionCandidate = (Get-Content -LiteralPath $script:VersionFile -Raw -ErrorAction SilentlyContinue)
    if ($versionCandidate) {
        $versionCandidate = $versionCandidate.Trim()
        if ($versionCandidate -match '^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*$') { $script:ProductVer = $versionCandidate }
    }
}
$script:RegKeyName    = 'AIDrivenNetDefense'
# The desktop entry point shipped by the v14 bundle (daemon + console).
# Shortcuts point at this file; 启动-自检.cmd is demoted to a 诊断 sub-menu.
$script:DesktopExeName = 'AIDrivenNetDefense.exe'
# Relative locations the exe may occupy inside the bundle / install root.
# Ordered: bundle root first, then the layouts used by the v14 tree.
$script:DesktopExeCandidates = @(
    'AIDrivenNetDefense.exe',
    'app\AIDrivenNetDefense.exe',
    'console\AIDrivenNetDefense.exe',
    'bin\AIDrivenNetDefense.exe',
    'app\console\AIDrivenNetDefense.exe',
    'app\bin\AIDrivenNetDefense.exe'
)
$script:RunKey         = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$script:RunValueName   = 'AIDrivenNetDefense'
# Test seam only: lets the acceptance run point the "default directory" at a
# temporary root instead of %ProgramFiles%. Unset in normal use.
if ($env:AIDN_SETUP_DEFAULT_DIR) {
    $script:DefaultDir = $env:AIDN_SETUP_DEFAULT_DIR
} else {
    $script:DefaultDir = Join-Path $env:ProgramFiles $script:ProductName
}
$script:PayloadDir    = Join-Path $PSScriptRoot 'payload'
$script:LogPath       = Join-Path $env:TEMP ('AIDriven-Setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

function Write-Log {
    param([string]$Message)
    $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $Message
    try { Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 } catch { }
}

function Get-InstallJson {
    param([string]$Root)
    $p = Join-Path $Root 'install\install.json'
    if (Test-Path -LiteralPath $p) {
        # RC5-N01 P2: 必须显式按 UTF-8 读。install.json 由 Python（json.dumps(ensure_ascii=False,
        # encoding='utf-8')）和本脚本（WriteAllText + UTF8Encoding($false)）写成**无 BOM** UTF-8；
        # 而 Windows PowerShell 5.1 的 `Get-Content` 在无 BOM 时按系统 ANSI 代码页（本机 CP936）
        # 解码 → 中文 installPath 变乱码 → 身份比对失败 → 真树被当成伪树拒删（中文路径必现）。
        # ReadAllText 带显式 Encoding.UTF8 时对「有 BOM / 无 BOM」两种写法都正确。
        try {
            $text = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
            return ($text | ConvertFrom-Json)
        } catch { return $null }
    }
    return $null
}

function Get-ExistingInstall {
    $keys = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$($script:RegKeyName)",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$($script:RegKeyName)",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$($script:RegKeyName)"
    )
    foreach ($k in $keys) {
        if (Test-Path $k) {
            $item = Get-ItemProperty -Path $k
            if ($item.InstallLocation -and (Test-Path -LiteralPath $item.InstallLocation)) {
                return [pscustomobject]@{
                    Path    = $item.InstallLocation
                    Version = $item.DisplayVersion
                    Source  = 'registry'
                }
            }
        }
    }
    $json = Get-InstallJson -Root $script:DefaultDir
    if ($json -and $json.installPath) {
        return [pscustomobject]@{
            Path    = $json.installPath
            Version = $json.version
            Source  = 'install.json'
        }
    }
    return $null
}

function Resolve-DesktopExe {
    param([string]$Root)
    foreach ($rel in $script:DesktopExeCandidates) {
        $p = Join-Path $Root $rel
        if (Test-Path -LiteralPath $p -PathType Leaf) { return $rel }
    }
    return $null
}

function Get-PayloadInfo {
    param([string]$Root)
    $bj = Join-Path $Root 'bundle.json'
    if (-not (Test-Path -LiteralPath $bj)) { return $null }
    try { return (Get-Content -LiteralPath $bj -Raw | ConvertFrom-Json) } catch { return $null }
}

function Assert-Payload {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) {
        throw "安装源缺失：$Root。请确认压缩包已完整解压，且 Setup.cmd 与 payload 目录在同一层。"
    }

    $info = Get-PayloadInfo -Root $Root
    if (-not $info) {
        throw "载荷清单缺失或损坏：$Root\bundle.json。压缩包可能没有完整解压。"
    }

    $exe = Resolve-DesktopExe -Root $Root
    if (-not $exe) {
        $where = ($script:DesktopExeCandidates -join ' / ')
        $kind = ''
        if ($info.kind) { $kind = "（bundle.json kind=$($info.kind)）" }
        throw ("载荷里找不到 $($script:DesktopExeName)$kind。安装器自 v2 起只接受 v14 桌面载荷" +
               "（含 daemon + console），v13 的 packaging-poc 载荷没有桌面入口。" +
               "已查找位置：$where。请改用 v14 bundle，或重新解压完整压缩包。")
    }

    return [pscustomobject]@{
        Kind      = $info.kind
        BuiltAt   = $info.builtAt
        Schema    = $info.schemaVersion
        DesktopExe = $exe
    }
}

# ---------------------------------------------------------------- 进程自家族（N-017）
# 为什么要有这一段：注册表 QuietUninstallString 指向**安装树内**的安装器副本，从那里
# 卸载时，本进程（及其 cmd/powershell 父进程、helper 子进程）的命令行/镜像也在
# `$Root` 之下。旧实现把它们一起 Stop-Process → 卸载器自杀、exit 非 0、一个文件都没删。
# 与 Python 侧 `procs._self_family` 同一判据：当前进程 + 祖先链 + 子孙，永不杀。
function Get-SelfFamilyIds {
    param($ProcessTable)
    $family = @{}
    $me = [int]$PID
    $family[$me] = $true
    $byId = @{}
    foreach ($proc in $ProcessTable) { $byId[[int]$proc.ProcessId] = $proc }
    $cursor = $me
    for ($guard = 0; $guard -lt 64; $guard++) {
        if (-not $byId.ContainsKey($cursor)) { break }
        $parent = [int]$byId[$cursor].ParentProcessId
        if ($parent -le 0 -or $parent -eq $cursor -or $family.ContainsKey($parent)) { break }
        $family[$parent] = $true
        $cursor = $parent
    }
    $children = @{}
    foreach ($proc in $ProcessTable) {
        $parent = [int]$proc.ParentProcessId
        if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.ArrayList }
        [void]$children[$parent].Add([int]$proc.ProcessId)
    }
    $stack = New-Object System.Collections.Stack
    $stack.Push($me)
    while ($stack.Count -gt 0) {
        $current = [int]$stack.Pop()
        if (-not $children.ContainsKey($current)) { continue }
        foreach ($child in $children[$current]) {
            if (-not $family.ContainsKey([int]$child)) {
                $family[[int]$child] = $true
                $stack.Push([int]$child)
            }
        }
    }
    return $family
}

# 选目标：镜像/命令行在 $Root 下、且**不属于自身家族**的进程，并按"子孙"闭包补齐。
# 独立成函数是为了可测：回归用例注入假进程表，断言自身/祖先/子孙不在选中集合里。
function Select-TargetProcesses {
    param([string]$Root, $ProcessTable)
    $prefix = $Root.TrimEnd('\') + '\'
    $family = Get-SelfFamilyIds -ProcessTable $ProcessTable
    $match = @{}
    foreach ($proc in $ProcessTable) {
        if ($family.ContainsKey([int]$proc.ProcessId)) { continue }
        $hit = $false
        $ep = $proc.ExecutablePath
        if ($ep -and $ep.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { $hit = $true }
        if (-not $hit) {
            $cl = $proc.CommandLine
            if ($cl -and $cl.IndexOf($prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $true }
        }
        if ($hit) { $match[[int]$proc.ProcessId] = $proc }
    }

    # Pull in descendants of anything already matched, until the set stops growing.
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($proc in $ProcessTable) {
            $pid2 = [int]$proc.ProcessId
            if ($match.ContainsKey($pid2) -or $family.ContainsKey($pid2)) { continue }
            if ($match.ContainsKey([int]$proc.ParentProcessId)) {
                $match[$pid2] = $proc
                $changed = $true
            }
        }
    }
    return $match
}

function Stop-TargetProcesses {
    # Kills every process whose executable lives under $Root, whose command line
    # references $Root (node daemons spawned with the install dir in their args),
    # and every descendant of those — children first, so a supervisor cannot
    # respawn the daemon while we are deleting files. The uninstaller's own family
    # is excluded (see Get-SelfFamilyIds): the in-tree copy must survive itself.
    param([string]$Root)
    $prefix = $Root.TrimEnd('\') + '\'
    $killed = 0
    try {
        $all = Get-CimInstance Win32_Process -ErrorAction Stop
    } catch {
        # CIM unavailable: fall back to the path-only match (self excluded by PID).
        try {
            Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
                if ([int]$_.Id -eq [int]$PID) { return }
                $p = $null
                try { $p = $_.Path } catch { $p = $null }
                if ($p -and $p.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                    try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; $killed++ } catch { }
                }
            }
        } catch { }
        if ($killed -gt 0) {
            Write-Log ("stopped {0} process(es) under target (path match only)" -f $killed)
            Start-Sleep -Milliseconds 400
        }
        return $killed
    }

    $match = Select-TargetProcesses -Root $Root -ProcessTable $all
    $selfFamily = Get-SelfFamilyIds -ProcessTable $all

    if ($match.Count -gt 0) {
        # Children first: deepest last, so order by descending depth.
        $depth = @{}
        function Get-Depth {
            param([int]$Id, [hashtable]$Map, [hashtable]$Cache)
            if ($Cache.ContainsKey($Id)) { return $Cache[$Id] }
            if (-not $Map.ContainsKey($Id)) { return 0 }
            $parent = [int]$Map[$Id].ParentProcessId
            $d = 1 + (Get-Depth -Id $parent -Map $Map -Cache $Cache)
            $Cache[$Id] = $d
            return $d
        }
        $cache = @{}
        foreach ($k in @($match.Keys)) { $depth[$k] = Get-Depth -Id ([int]$k) -Map $match -Cache $cache }
        foreach ($k in ($depth.Keys | Sort-Object { $depth[$_] } -Descending)) {
            try {
                Stop-Process -Id ([int]$k) -Force -ErrorAction Stop
                $killed++
                Write-Log ("stopped pid={0} name={1}" -f $k, $match[[int]$k].Name)
            } catch { Write-Log ("stop failed pid={0} :: {1}" -f $k, $_.Exception.Message) }
        }
        Start-Sleep -Milliseconds 600
    }

    # Second pass: anything still alive under the root (e.g. a child fast-respawned),
    # again excluding this process's own family.
    try {
        foreach ($proc in (Get-CimInstance Win32_Process -ErrorAction Stop)) {
            if ($selfFamily.ContainsKey([int]$proc.ProcessId)) { continue }
            $ep = $proc.ExecutablePath
            $cl = $proc.CommandLine
            $hit = ($ep -and $ep.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) -or
                   ($cl -and $cl.IndexOf($prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
            if ($hit) {
                try { Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop; $killed++ } catch { }
            }
        }
    } catch { }

    if ($killed -gt 0) { Start-Sleep -Milliseconds 300 }
    return $killed
}

function Test-TargetPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '安装路径不能为空。' }
    $full = $null
    try { $full = [System.IO.Path]::GetFullPath($Path) } catch { return '安装路径格式不合法。' }
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.TrimEnd('\') -eq $root.TrimEnd('\')) { return '不能直接安装到盘符根目录。' }
    $win = $env:SystemRoot
    if ($full.StartsWith($win, [System.StringComparison]::OrdinalIgnoreCase)) { return '不能安装到 Windows 目录内。' }
    if ($full.Length -gt 180) { return '路径过长，请换一个更短的目录。' }
    return $null
}

# ---------------------------------------------------------------- 卸载归属校验
# SEED-01（P0）：Uninstall-Target 之前唯一的守卫是 Test-Path，于是
# `Setup.ps1 /S /uninstall /DIR=<任意用户可写目录>` 会递归删光那个目录。
# RC5-N01（P1）：原来的判据是「目录里有没有长得像我们的文件」——全字段 install.json
# + 自洽的 manifests\files.sha256（3 个任意文件 + 真实哈希）就能骗过两个通道整树删除，
# 证明内容自证不是归属证明。现在改成安装器内置摘要锚定的凭据：
#   ① 路径合法（盘符根 / %SystemRoot% / 超长 → 拒）
#   ② 目标本身不是符号链接/联接（递归删会穿透链接）
#   ③ install\install.json 的全部身份字段一致，manifests 与磁盘一致
#   ④ install.json.ownership 合法，且用**即将被删的路径**重算 HMAC-SHA256 与记录相等
#      （常量时间比较），记录里的 payloadDigest 必须等于磁盘 manifests\files.sha256 的 sha256
# 载荷的 bundle.json + manifests 分支不再单独授权删除；没有 install.json 的非空目录一律
# 拒删并提示手工删除。空目录例外：没有数据可丢。
# 本机没有符号链接特权，所以链接面之外另有 junction 与"纯路径归属"两条兜底。
$script:ProductNames = @('AIDriven NetDefense', '网域智防')
$script:PayloadLayoutMarkers = @(
    'aidrivennetdefense.exe',
    'runtime/node/node.exe',
    'app/node_modules/@aegisharness/',
    'launch/aegis-',
    'dsh-home/profiles/aegis-analysis',
    'rules/defense-seed-pack.json'
)

# ---------------------------------------------------------------- 归属凭据（RC5-N01）
# install.json.ownership（只有安装器能写出来）：
#   scheme        = 'hmac-sha256-v1'
#   installId     = 32 位小写 hex（随机）
#   payloadDigest = <Root>\manifests\files.sha256 的 sha256（文件不存在则空串）
#   token         = HMAC-SHA256(key, message)，小写 hex
# message = UTF-8、LF(0x0A) 连接的 7 行（无结尾换行）：
#   aidn-ownership-v1 / product / channel / version / canonical target / installId / payloadDigest
# key 是 32 字节常量，必须与 app/aidn/ownership.py 的 KEY_HEX 逐字节一致；不从环境或
# 文件读取（能写目标目录的攻击者也能写这两处）。canonical target 与 Python 侧对齐：
# normcase(abspath(...)) 等价于 GetFullPath(...).ToLowerInvariant()，斜杠归一、去尾部反斜杠。
$script:OwnershipScheme = 'hmac-sha256-v1'
$script:OwnershipHeader = 'aidn-ownership-v1'
$script:OwnershipKeyHex = '150dbfb01ae656aef2cff09692e9441e47f7dd42b084f1e61ee67b54eaf5fc23'
$script:OwnershipKeyBytes = New-Object byte[] 32
for ($i = 0; $i -lt 32; $i++) {
    $script:OwnershipKeyBytes[$i] = [Convert]::ToByte($script:OwnershipKeyHex.Substring($i * 2, 2), 16)
}

function Get-CanonicalTargetPath {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.ToLowerInvariant().Replace('/', '\').TrimEnd('\')
}

function Get-PayloadManifestDigest {
    param([string]$Root)
    $manifest = Join-Path $Root 'manifests\files.sha256'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return '' }
    try { return (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() } catch { return '' }
}

function New-OwnershipMessage {
    param([string]$TargetPath, [string]$Channel, [string]$Version, [string]$InstallId, [string]$PayloadDigest)
    $lines = @(
        $script:OwnershipHeader,
        $script:ProductName,
        $Channel,
        $Version,
        (Get-CanonicalTargetPath -Path $TargetPath),
        $InstallId,
        $PayloadDigest
    )
    return ($lines -join "`n")
}

function New-OwnershipToken {
    param([string]$Message)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    try {
        $hmac.Key = $script:OwnershipKeyBytes
        $hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Message))
    } finally {
        $hmac.Dispose()
    }
    $builder = New-Object System.Text.StringBuilder
    foreach ($value in $hash) { [void]$builder.Append($value.ToString('x2')) }
    return $builder.ToString()
}

function Test-ConstantTimeEqual {
    param([string]$Left, [string]$Right)
    if ($null -eq $Left -or $null -eq $Right) { return $false }
    if ($Left.Length -ne $Right.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $Left.Length; $i++) {
        $diff = $diff -bor (([int][char]$Left[$i]) -bxor ([int][char]$Right[$i]))
    }
    return ($diff -eq 0)
}

function New-OwnershipBlock {
    param([string]$Root, [string]$Channel, [string]$Version, [string]$InstallId)
    if (-not $InstallId) { $InstallId = [Guid]::NewGuid().ToString('N').ToLowerInvariant() }
    $digest = Get-PayloadManifestDigest -Root $Root
    $token = New-OwnershipToken -Message (New-OwnershipMessage -TargetPath $Root -Channel $Channel `
        -Version $Version -InstallId $InstallId -PayloadDigest $digest)
    return [ordered]@{
        scheme        = $script:OwnershipScheme
        installId     = $InstallId
        payloadDigest = $digest
        token         = $token
    }
}

function Test-OwnershipProof {
    param([string]$Root)
    $record = Get-InstallJson -Root $Root
    if (-not $record) { return $false }
    $block = $record.ownership
    if (-not $block) { return $false }
    if ([string]$block.scheme -cne $script:OwnershipScheme) { return $false }
    $installId = [string]$block.installId
    if ($installId -cnotmatch '^[0-9a-f]{32}$') { return $false }
    $token = [string]$block.token
    if ($token -cnotmatch '^[0-9a-f]{64}$') { return $false }
    $recorded = [string]$block.payloadDigest
    if ($recorded -and $recorded -cnotmatch '^[0-9a-f]{64}$') { return $false }
    # 双绑：记录里的摘要必须就是磁盘上清单的摘要（换掉清单不能变成另一种通过方式）。
    $disk = Get-PayloadManifestDigest -Root $Root
    if ($recorded -cne $disk) { return $false }
    # 用即将被删的路径重算，而不是记录里的 installPath：否则复制走的树会带着授权。
    $message = New-OwnershipMessage -TargetPath $Root -Channel ([string]$record.channel) `
        -Version ([string]$record.version) -InstallId $installId -PayloadDigest $disk
    $expected = New-OwnershipToken -Message $message
    return (Test-ConstantTimeEqual -Left $expected -Right $token)
}

function Test-ManifestProof {
    param([string]$Root)
    $manifest = Join-Path $Root 'manifests\files.sha256'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($manifest)
        # 本流水线不写 BOM；带 BOM 的清单是伪造形态，直接拒。
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { return $false }
        $lines = [System.IO.File]::ReadAllLines($manifest, [System.Text.Encoding]::UTF8)
    } catch { return $false }
    $rows = New-Object System.Collections.ArrayList
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed -notmatch '^([0-9a-fA-F]{64})  (.+)$') { return $false }
        $rel = $Matches[2].Trim()
        if ($rel.StartsWith('/') -or $rel.StartsWith('\') -or $rel -match '^[A-Za-z]:') { return $false }
        foreach ($part in ($rel -split '[\\/]')) {
            if ($part -eq '..' -or $part -eq '' -or $part -eq '.') { return $false }
        }
        [void]$rows.Add([pscustomobject]@{ Hash = $Matches[1].ToLowerInvariant(); Rel = $rel })
    }
    if ($rows.Count -lt 3) { return $false }
    $indexes = @{}
    for ($i = 0; $i -lt 3 -and $i -lt $rows.Count; $i++) { $indexes[$i] = $true }
    for ($i = [Math]::Max(0, $rows.Count - 3); $i -lt $rows.Count; $i++) { $indexes[$i] = $true }
    $markerRows = 0
    for ($i = 0; $i -lt $rows.Count -and $markerRows -lt 32; $i++) {
        $norm = $rows[$i].Rel.Replace('\', '/').ToLowerInvariant()
        foreach ($marker in $script:PayloadLayoutMarkers) {
            if ($norm.Contains($marker)) { $indexes[$i] = $true; $markerRows += 1; break }
        }
    }
    $checked = 0
    foreach ($index in (($indexes.Keys | Sort-Object) | Select-Object -First 64)) {
        $row = $rows[$index]
        $path = Join-Path $Root $row.Rel.Replace('/', '\')
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $row.Hash) { return $false }
        $checked += 1
    }
    return ($checked -ge 3)
}

function Test-InstallRecordProof {
    param([string]$Root)
    $record = Get-InstallJson -Root $Root
    if (-not $record) { return $false }
    if ($script:ProductNames -notcontains [string]$record.product) { return $false }
    if (@('installed', 'portable', 'test') -notcontains [string]$record.channel) { return $false }
    if (-not ([string]$record.version -match '^[0-9]+\.[0-9]+\.[0-9]+')) { return $false }
    if (-not $record.installPath) { return $false }
    try {
        $recorded = [System.IO.Path]::GetFullPath([string]$record.installPath).TrimEnd('\')
        $actual = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
        if ($recorded -ne $actual) { return $false }
    } catch { return $false }
    if (-not (Test-ManifestProof -Root $Root)) { return $false }
    # RC5-N01: 身份字段与清单一致性只说明「内容自洽」；授权删除的是安装器签发的凭据。
    return (Test-OwnershipProof -Root $Root)
}

# RC5-N01: Test-BundleProof 已删除。载荷的 bundle.json + manifests\files.sha256 是
# 「目录自证」的一半伪造面：攻击者能写目标目录就能写这两份文件。它不再单独授权递归
# 删除；没有 install\install.json + 有效 ownership 凭据的非空目录一律拒删。

function Assert-UninstallOwnership {
    param([string]$Target)

    $pathError = Test-TargetPath -Path $Target
    if ($pathError) { throw "卸载被拒：$pathError / Refusing to uninstall: $pathError" }

    if (-not (Test-Path -LiteralPath $Target -PathType Container)) { throw "安装目录不存在：$Target" }
    $item = Get-Item -LiteralPath $Target -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        $linkMessage = "卸载被拒：$Target 是符号链接/联接（junction），删除会穿透链接删掉它指向的目录。已停止，什么都没有删除。 / Refusing to uninstall through a symlink/junction: nothing was deleted."
        throw $linkMessage
    }

    # RC5-N01: 只有 install\install.json + 有效 ownership 凭据能授权递归删除。
    if (Test-InstallRecordProof -Root $Target) {
        Write-Log "uninstall ownership: verified install tree $Target"
        return
    }

    $left = @(Get-ChildItem -LiteralPath $Target -Force -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
        Write-Log "uninstall ownership: empty directory, nothing to lose: $Target"
        return
    }
    $refusal = "卸载被拒：$Target 里没有可验证的安装器内置归属凭据（install\install.json 的全部身份字段 + install.json.ownership：HMAC-SHA256 绑定本路径与 manifests\files.sha256 摘要；载荷的 bundle.json + manifests 已不再单独授权删除）。为避免误删用户文件，已停止，什么都没有删除。 / Refusing to uninstall: the directory is not empty and does not carry a verifiable installer-built ownership credential (install.json.ownership) of this product. Nothing was deleted; remove it by hand if it really is a leftover."
    throw $refusal
}

# ---------------------------------------------------------------- 提权预检
# 为什么要有这一段：rc.3 的一次验收里，命令与参数逐字正确、窗口看着也正常，
# 结果先复制了 450 MiB 才死在 [WinError 5] 'C:\Program Files\AIDriven Net Defense'。
# 真正的问题只是「这个进程从来没提权」。所以：目标在受保护目录下、而当前未提权时，
# 在复制/解压之前就拒绝，退出码与 app/main.py 的 EXIT_NEEDS_ADMIN 一致（7）。
# 与 Python 安装器的 _PROTECTED_ENV_ROOTS 列表必须保持同一组根，否则两个入口行为分裂。
$script:ProtectedEnvRoots = @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SystemRoot')

function Test-ElevatedToken {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal $identity
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-ProtectedRootOf {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    foreach ($name in $script:ProtectedEnvRoots) {
        $root = [Environment]::GetEnvironmentVariable($name)
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
        if ($full -eq $rootFull -or $full.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            return "%$name%"
        }
    }
    return $null
}

function Assert-Elevation {
    param([string]$Path, [string]$Action)
    $root = Get-ProtectedRootOf -Path $Path
    if (-not $root) { return }
    if (Test-ElevatedToken) { return }
    $msg = "需要管理员权限才能$Action：$Path`n" +
           "该位置在受保护目录（$root）下，而当前进程没有提权。因此这里既没有解压、也没有复制任何文件就停止了。`n" +
           "请用管理员身份重新运行：右键安装程序 →「以管理员身份运行」，或使用 elevate-install.cmd。`n---`n" +
           "Administrator rights are required for this action on $Path (protected root $root): " +
           "nothing was unpacked or written. Re-run as administrator."
    Write-Log $msg
    [Console]::Error.WriteLine($msg)
    exit 7
}

function New-Shortcut {
    param([string]$LinkPath, [string]$TargetPath, [string]$WorkDir, [string]$Description)
    $dir = Split-Path -Parent $LinkPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($LinkPath)
    $lnk.TargetPath = $TargetPath
    $lnk.WorkingDirectory = $WorkDir
    $lnk.Description = $Description
    $lnk.WindowStyle = 1
    $lnk.Save()
}

function Get-StartMenuDir {
    # Test seam: the acceptance run redirects the menu root so it never touches
    # the real Start Menu of the machine.
    if ($env:AIDN_SETUP_STARTMENU_DIR) { return $env:AIDN_SETUP_STARTMENU_DIR }
    return (Join-Path $env:ProgramData ('Microsoft\Windows\Start Menu\Programs\' + $script:ProductName))
}

function Get-DesktopDir {
    if ($env:AIDN_SETUP_DESKTOP_DIR) { return $env:AIDN_SETUP_DESKTOP_DIR }
    return [Environment]::GetFolderPath('Desktop')
}

function Get-ShortcutNames {
    # Current name plus the v1 desktop shortcut name, so an upgrade or uninstall
    # never leaves the old 「… 自检」icon behind.
    return @($script:ProductName, ($script:ProductName + ' 自检'))
}

function New-InstallShortcuts {
    param([string]$Root, [string]$ExeRel, [bool]$Desktop)

    $exe = Join-Path $Root $ExeRel
    $startMenu = Get-StartMenuDir

    # Drop the v1 layout's top-level 「自检.lnk」 so the menu does not keep a
    # stale duplicate next to the new 诊断 entry.
    $legacy = @(
        (Join-Path $startMenu '自检.lnk'),
        (Join-Path (Get-DesktopDir) ($script:ProductName + ' 自检.lnk'))
    )
    foreach ($l in $legacy) {
        if (Test-Path -LiteralPath $l) { Remove-Item -LiteralPath $l -Force -ErrorAction SilentlyContinue }
    }

    # Primary entry: the desktop shell.
    New-Shortcut -LinkPath (Join-Path $startMenu ($script:ProductName + '.lnk')) `
        -TargetPath $exe -WorkDir $Root -Description $script:ProductName

    New-Shortcut -LinkPath (Join-Path $startMenu '安装目录.lnk') `
        -TargetPath $Root -WorkDir $Root -Description ($script:ProductName + ' 安装目录')

    # Diagnostics stay available, but one level down: <Product>\诊断\自检.lnk
    # 只有在自检脚本真的存在时才建，避免留下一个点了就报错的快捷方式。
    $selfCheckTarget = Join-Path $Root '启动-自检.cmd'
    if (Test-Path -LiteralPath $selfCheckTarget -PathType Leaf) {
        $diag = Join-Path $startMenu '诊断'
        New-Shortcut -LinkPath (Join-Path $diag '自检.lnk') `
            -TargetPath $selfCheckTarget -WorkDir $Root `
            -Description ($script:ProductName + ' 诊断 / 自检')
    }

    if ($Desktop) {
        New-Shortcut -LinkPath (Join-Path (Get-DesktopDir) ($script:ProductName + '.lnk')) `
            -TargetPath $exe -WorkDir $Root -Description $script:ProductName
    }
}

function Remove-Shortcuts {
    $startMenu = Get-StartMenuDir
    if (Test-Path -LiteralPath $startMenu) {
        Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "removed start menu folder: $startMenu"
    }
    $desk = Get-DesktopDir
    foreach ($n in (Get-ShortcutNames)) {
        $lnk = Join-Path $desk ($n + '.lnk')
        if (Test-Path -LiteralPath $lnk) {
            Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
            Write-Log "removed desktop shortcut: $lnk"
        }
    }
}

# ---------------------------------------------------------------- autostart
# The Run value is one global entry per user profile, so every write and delete below is
# scoped to the install tree that owns it.  Two defects this closes (measured on a real
# machine; see docs/implementation/evidence/rc5/signoff/runkey/):
#
#   1. an install without /AUTOSTART — and an uninstall of any directory — used to delete
#      the value blindly, erasing a correct entry that belonged to another, still
#      installed tree.  Deletion now happens only when the registered command launches
#      something inside the tree being installed/removed (Remove-Autostart -Target).
#   2. install.json recorded the *requested* state.  Set-Autostart now writes, reads the
#      value back and returns what the registry actually holds.
#
# An elevated setup may have been started with another administrator's credentials, in
# which case HKCU is that account's hive and the asking user would get nothing.  When
# elevated, the interactive session's owner is used instead (HKEY_USERS\<sid>).


function Get-InteractiveUserSid {
    # Owner of the interactive session (the account whose desktop will start the product).
    try {
        $userName = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).UserName
        if (-not $userName) { return $null }
        $account = New-Object System.Security.Principal.NTAccount($userName)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch { return $null }
}

function Get-AutostartUserSid {
    if (-not (Test-ElevatedToken)) { return $null }
    return Get-InteractiveUserSid
}

function Get-AutostartKeyPath {
    param([string]$UserSid)
    if ($UserSid) {
        return ('Registry::HKEY_USERS\{0}\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -f $UserSid)
    }
    return $script:RunKey
}

function Get-AutostartValue {
    param([string]$UserSid)
    $path = Get-AutostartKeyPath -UserSid $UserSid
    try {
        $item = Get-ItemProperty -Path $path -Name $script:RunValueName -ErrorAction Stop
        return [string]$item.$($script:RunValueName)
    } catch { return $null }
}

function Test-Autostart {
    param([string]$UserSid)
    return [bool](Get-AutostartValue -UserSid $UserSid)
}

function Test-AutostartPointsInto {
    # Does the registered command launch something inside $Target?  Only such a value is
    # ours to overwrite or delete.
    param([string]$Command, [string]$Target)
    if (-not $Command -or -not $Target) { return $false }
    $base = $Target.TrimEnd('\')
    $candidates = New-Object System.Collections.ArrayList
    foreach ($m in [regex]::Matches($Command, '"([^"]+)"')) { [void]$candidates.Add($m.Groups[1].Value) }
    foreach ($token in ($Command -split '\s+')) {
        $t = $token.Trim('"')
        if ($t -match '^[A-Za-z]:[\\/]') { [void]$candidates.Add($t) }
    }
    foreach ($candidate in $candidates) {
        $trimmed = $candidate.TrimEnd('\')
        if ($trimmed -ieq $base) { return $true }
        if ($trimmed.StartsWith(($base + '\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Test-AutostartPointsIntoTree {
    param([string]$Target, [string]$UserSid)
    return (Test-AutostartPointsInto -Command (Get-AutostartValue -UserSid $UserSid) -Target $Target)
}

function Set-Autostart {
    param([bool]$Enabled, [string]$ExePath, [string]$UserSid, [string]$Target)
    $path = Get-AutostartKeyPath -UserSid $UserSid
    if ($Enabled) {
        try {
            if (-not (Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null }
            Set-ItemProperty -Path $path -Name $script:RunValueName -Value ('"' + $ExePath + '"')
        } catch {
            # Best effort, all reported: the files are already installed, and install.json
            # must carry the state the registry really has (this function's return value).
            Write-Log ("autostart set failed: " + $_.Exception.Message)
        }
        $actual = [bool](Test-Autostart -UserSid $UserSid)
        Write-Log ("autostart on: {0} (readback={1})" -f $ExePath, $actual)
        return $actual
    }
    # Legacy call shape: without an explicit target, scope to the exe's own directory.
    $root = if ($Target) { $Target } else { Split-Path -Parent $ExePath }
    $outcome = Remove-Autostart -Target $root -UserSid $UserSid
    Write-Log ("autostart cleanup: {0}" -f $outcome)
    return [bool](Test-Autostart -UserSid $UserSid)
}

function Remove-Autostart {
    param([string]$Target, [string]$UserSid)
    $current = Get-AutostartValue -UserSid $UserSid
    if ($null -eq $current -or $current -eq '') { return 'absent' }
    if (-not (Test-AutostartPointsInto -Command $current -Target $Target)) {
        Write-Log ("autostart kept: the value launches a different installation ({0})" -f $current)
        return 'kept'
    }
    $path = Get-AutostartKeyPath -UserSid $UserSid
    try {
        Remove-ItemProperty -Path $path -Name $script:RunValueName -Force -ErrorAction Stop
        Write-Log "autostart removed: $($script:RunValueName)"
        return 'removed'
    } catch {
        Write-Log ("autostart remove failed: " + $_.Exception.Message)
        return 'kept'
    }
}
function Write-SelfCheckScript {
    param([string]$Root)
    # The worker refuses to start unless HOME/USERPROFILE/TMP/TEMP/DSH_HOME/
    # AEGIS_SESSION_ROOT/AEGIS_ANALYSIS_CWD are absolute and attempt-scoped,
    # and AEGIS_ANALYSIS_CWD must equal the process working directory exactly.
    $body = @'
@echo off
setlocal DisableDelayedExpansion
title AIDriven NetDefense - self check
cd /d "%~dp0"
"%~dp0runtime\node\node.exe" --version
echo.
"%~dp0runtime\node\node.exe" "%~dp0SelfCheck.mjs"
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%
'@
    $path = Join-Path $Root '启动-自检.cmd'
    Set-Content -LiteralPath $path -Value $body -Encoding Default
    return $path
}

function Install-Target {
    param([string]$Target, [bool]$DesktopShortcut, [bool]$SkipRegistry, [bool]$NoShortcut, [bool]$Autostart, [scriptblock]$OnStep)

    $err = Test-TargetPath -Path $Target
    if ($err) { throw $err }

    # Fail before touching the disk if this is not a v14 desktop payload.
    $payload = Assert-Payload -Root $script:PayloadDir

    $prev = Get-ExistingInstall
    $upgradeFrom = $null
    if ($prev -and $prev.Path) {
        $pj = Get-InstallJson -Root $prev.Path
        if ($pj -and $pj.version) { $upgradeFrom = $pj.version }
        elseif ($prev.Version) { $upgradeFrom = $prev.Version }
    }
    # /DIR may point at an existing install the registry never heard of (for
    # example a /NOREG test install): read the record from the target itself so
    # upgradedFrom is still truthful.
    if (-not $upgradeFrom) {
        $tj = Get-InstallJson -Root $Target
        if ($tj -and $tj.version) { $upgradeFrom = $tj.version }
    }

    if ($OnStep) { & $OnStep '停止正在运行的程序…' }
    Stop-TargetProcesses -Root $Target | Out-Null
    if ($prev -and $prev.Path -and ($prev.Path -ne $Target)) {
        Stop-TargetProcesses -Root $prev.Path | Out-Null
    }

    if ($OnStep) { & $OnStep '创建安装目录…' }
    if (-not (Test-Path -LiteralPath $Target)) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
    }

    # Upgrade must never touch user data: remember what exists before the copy,
    # then prove it is still there afterwards.
    $dataDir = Join-Path $Target 'data'
    $dataExisted = Test-Path -LiteralPath $dataDir
    $dataProbe = $null
    if ($dataExisted) {
        $probeFile = Get-ChildItem -LiteralPath $dataDir -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object Length -Descending | Select-Object -First 1
        if ($probeFile) { $dataProbe = [pscustomobject]@{ Path = $probeFile.FullName; Hash = (Get-FileHash -LiteralPath $probeFile.FullName -Algorithm SHA256).Hash } }
    }

    if ($OnStep) { & $OnStep '复制程序文件（请稍候）…' }
    Write-Log "robocopy $($script:PayloadDir) -> $Target"
    # /E only adds and overwrites: it never purges, so data\ survives an upgrade.
    $rc = Start-Process -FilePath 'robocopy.exe' `
        -ArgumentList @("`"$($script:PayloadDir)`"", "`"$Target`"", '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') `
        -Wait -PassThru -WindowStyle Hidden
    Write-Log "robocopy exit=$($rc.ExitCode)"
    if ($rc.ExitCode -ge 8) { throw "复制文件失败（robocopy 退出码 $($rc.ExitCode)）。详见日志：$($script:LogPath)" }

    $exeRel = Resolve-DesktopExe -Root $Target
    if (-not $exeRel) {
        throw "复制完成后安装目录里没有 $($script:DesktopExeName)，载荷与清单不一致，已中止。日志：$($script:LogPath)"
    }
    $exePath = Join-Path $Target $exeRel

    if ($dataExisted) {
        if (-not (Test-Path -LiteralPath $dataDir)) {
            throw "升级过程中数据目录丢失：$dataDir。已中止，请检查磁盘与权限。"
        }
        if ($dataProbe -and (Test-Path -LiteralPath $dataProbe.Path)) {
            $now = (Get-FileHash -LiteralPath $dataProbe.Path -Algorithm SHA256).Hash
            if ($now -ne $dataProbe.Hash) {
                throw "升级后数据文件被改动：$($dataProbe.Path)。已中止。"
            }
        }
        Write-Log "data preserved: $dataDir"
    }

    # Autostart is applied *before* the record is written: install.json.autostart must be
    # the state the registry actually ended up in, not the state that was requested.
    if ($OnStep) { & $OnStep '设置开机自启…' }
    if ($Autostart) {
        [void](Set-Autostart -Enabled $true -ExePath $exePath)
    } else {
        # Scoped: never delete the Run value of another (still installed) tree.
        $outcome = Remove-Autostart -Target $Target
        Write-Log ("autostart cleanup: {0}" -f $outcome)
    }
    $autostartActual = Test-AutostartPointsIntoTree -Target $Target
    Write-Log ("autostart state read back from the Run key: {0}" -f $autostartActual)
    if ($Autostart -and -not $autostartActual) {
        Write-Log 'WARN autostart was requested but the Run key does not point at this install; install.json records the real state (false)'
    }

    if ($OnStep) { & $OnStep '写入安装记录…' }
    $installDir = Join-Path $Target 'install'
    if (-not (Test-Path -LiteralPath $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }

    # RC5-N01: 卸载授权凭据。必须在 robocopy 之后算——payloadDigest 绑定的是目标树里的
    # manifests\files.sha256（复制前它还不存在）。与 app/aidn/ownership.py 同一消息格式。
    $ownership = New-OwnershipBlock -Root $Target -Channel 'test' -Version $script:ProductVer
    $record = [ordered]@{
        product        = $script:ProductName
        version        = $script:ProductVer
        installPath    = $Target
        installedAt    = (Get-Date).ToString('o')
        payloadBuiltAt = $payload.BuiltAt
        payloadKind    = $payload.Kind
        payloadSchema  = $payload.Schema
        desktopExe     = $exeRel
        autostart      = [bool]$autostartActual
        upgradedFrom   = $upgradeFrom
        channel        = 'test'
        ownership      = $ownership
    }
    # 跨通道：Python 卸载器用 encoding='utf-8' 读记录，而 PS 5.1 的
    # `Set-Content -Encoding UTF8` 会写 BOM，带 BOM 的 JSON 在 Python 侧解析失败 →
    # 记录被当成不存在。写无 BOM 的 UTF-8。
    $recordJson = ($record | ConvertTo-Json -Depth 4)
    [System.IO.File]::WriteAllText(
        (Join-Path $installDir 'install.json'),
        ($recordJson + "`n"),
        (New-Object System.Text.UTF8Encoding($false))
    )

    if ($OnStep) { & $OnStep '创建快捷方式（程序 / 诊断）…' }
    # 自检脚本属于旧测试通道载荷（payload 里有 launch/prepare-attempt.mjs）。
    # v14 桌面载荷不带它：缺了就当没有诊断入口，而不是让整次安装失败。
    $selfCheckSource = Join-Path $PSScriptRoot 'SelfCheck.mjs'
    if (Test-Path -LiteralPath $selfCheckSource -PathType Leaf) {
        Write-SelfCheckScript -Root $Target | Out-Null
        Copy-Item -LiteralPath $selfCheckSource -Destination (Join-Path $Target 'SelfCheck.mjs') -Force
    } else {
        Write-Log 'SelfCheck.mjs not bundled; skipping 启动-自检.cmd'
    }

    if (-not $NoShortcut) {
        New-InstallShortcuts -Root $Target -ExeRel $exeRel -Desktop $DesktopShortcut
    }

    if (-not $SkipRegistry) {
        if ($OnStep) { & $OnStep '登记卸载信息…' }
        $uninstallCmd = '"' + (Join-Path $Target 'installer\Setup.cmd') + '" /uninstall'
        $regRoot = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
        $admin = Test-ElevatedToken
        if (-not $admin) { $regRoot = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' }
        $key = Join-Path $regRoot $script:RegKeyName
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        Set-ItemProperty -Path $key -Name 'DisplayName'     -Value ($script:ProductName + '（测试版）')
        Set-ItemProperty -Path $key -Name 'DisplayVersion'  -Value $script:ProductVer
        Set-ItemProperty -Path $key -Name 'InstallLocation' -Value $Target
        Set-ItemProperty -Path $key -Name 'Publisher'       -Value 'PT-dove'
        Set-ItemProperty -Path $key -Name 'UninstallString' -Value $uninstallCmd
        Set-ItemProperty -Path $key -Name 'QuietUninstallString' -Value ($uninstallCmd + ' /S')
        Set-ItemProperty -Path $key -Name 'NoModify' -Value 1 -Type DWord
        Set-ItemProperty -Path $key -Name 'NoRepair' -Value 1 -Type DWord
    }

    # keep a copy of the installer so uninstall works from any location
    $inst = Join-Path $Target 'installer'
    if (-not (Test-Path -LiteralPath $inst)) { New-Item -ItemType Directory -Path $inst -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Setup.ps1') -Destination $inst -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Setup.cmd') -Destination $inst -Force

    Write-Log "install ok: $Target (upgradedFrom=$upgradeFrom)"
    return $upgradeFrom
}

function Uninstall-Target {
    param([string]$Target, [bool]$KeepData, [bool]$SkipRegistry, [scriptblock]$OnStep)

    if (-not (Test-Path -LiteralPath $Target)) { throw "安装目录不存在：$Target" }
    # SEED-01：卸载侧的归属/链接/路径校验。必须放在任何删除动作之前。
    Assert-UninstallOwnership -Target $Target

    if ($OnStep) { & $OnStep '停止正在运行的程序（含 daemon 子进程）…' }
    $stopped = Stop-TargetProcesses -Root $Target
    Write-Log ("uninstall stop: {0} process(es)" -f $stopped)

    if ($OnStep) { & $OnStep '移除快捷方式…' }
    Remove-Shortcuts

    if ($OnStep) { & $OnStep '清除开机自启项…' }
    # Scoped: only a value that launches this tree is removed.  The Run value is one global
    # entry per profile, so an uninstall of tree A must not silently disable tree B; a
    # value pointing into the tree being deleted *is* dangling and must go.
    $autostartOutcome = Remove-Autostart -Target $Target
    Write-Log ("autostart cleanup on uninstall: {0}" -f $autostartOutcome)

    if (-not $SkipRegistry) {
        if ($OnStep) { & $OnStep '清除卸载登记…' }
        $keys = @(
            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$($script:RegKeyName)",
            "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$($script:RegKeyName)",
            "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$($script:RegKeyName)"
        )
        foreach ($k in $keys) { if (Test-Path $k) { Remove-Item -Path $k -Recurse -Force -ErrorAction SilentlyContinue } }
    }

    if ($OnStep) { & $OnStep '删除程序文件…' }
    $keep = @()
    if ($KeepData) {
        # install\ holds install.json (upgrade bookkeeping) and the installer copy;
        # data\ is user data; dsh-home\ is user data left by the v13 layout.
        $keep = @('install', 'data', 'dsh-home')
    }
    Get-ChildItem -LiteralPath $Target -Force | ForEach-Object {
        if ($keep -contains $_.Name) { return }
        try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { Write-Log ("delete failed: " + $_.FullName + " :: " + $_.Exception.Message) }
    }

    if ($KeepData) {
        Write-Log "uninstall kept data in $Target"
    } else {
        try {
            $left = Get-ChildItem -LiteralPath $Target -Force -ErrorAction SilentlyContinue
            if (-not $left -or $left.Count -eq 0) { Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue }
        } catch { }
    }

    # Post-condition: nothing of ours may still be running from that tree.
    $still = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith(($Target.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
    if ($still.Count -gt 0) { Write-Log ("WARN {0} process(es) still alive after uninstall" -f $still.Count) }
    Write-Log "uninstall done: $Target (keepData=$KeepData, leftoverProcesses=$($still.Count))"
}

# ---------------------------------------------------------------- test seam
# Allows the acceptance harness to dot-source this file for its functions
# without launching the GUI. Never set in normal use.
if ($env:AIDN_SETUP_TEST_DOTSOURCE -eq '1') { return }

# ---------------------------------------------------------------- silent mode
if ($S -or $Uninstall) {
    # 提权门放在 try 之外、目标一解析出来就判：既不走 catch（那会把「未提权」说成
    # 一般的安装失败），也不等 Install-Target 里先去读载荷。
    $gateTarget = $DIR
    if (-not $gateTarget) {
        $gatePrev = Get-ExistingInstall
        if ($gatePrev) { $gateTarget = $gatePrev.Path } else { $gateTarget = $script:DefaultDir }
    }
    Assert-Elevation -Path $gateTarget -Action $(if ($Uninstall) { '卸载 / uninstall' } else { '安装 / install' })
    try {
        if ($Uninstall) {
            $target = $DIR
            if (-not $target) {
                $prev = Get-ExistingInstall
                if ($prev) { $target = $prev.Path }
            }
            if (-not $target) { throw '找不到已安装位置，请用 /DIR= 指定安装目录。' }
            Uninstall-Target -Target $target -KeepData $false -SkipRegistry:$NOREG -OnStep $null
            Write-Host "卸载完成：$target"
        } else {
            $target = $DIR
            if (-not $target) {
                $prev = Get-ExistingInstall
                if ($prev) { $target = $prev.Path } else { $target = $script:DefaultDir }
            }
            $from = Install-Target -Target $target -DesktopShortcut $true -SkipRegistry:$NOREG -NoShortcut:$NoShortcut -Autostart:$Autostart -OnStep $null
            if ($from) { Write-Host "升级完成：$from -> $($script:ProductVer)  路径：$target" }
            else { Write-Host "安装完成：$($script:ProductVer)  路径：$target" }
        }
        exit 0
    } catch {
        Write-Log ("silent failed: " + $_.Exception.Message)
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}

# ------------------------------------------------------------------ GUI mode
$prev = Get-ExistingInstall

$form = New-Object System.Windows.Forms.Form
$form.Text = "$($script:ProductName) 安装程序  $($script:ProductVer)  （测试版）"
$form.Size = New-Object System.Drawing.Size(660, 410)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$title = New-Object System.Windows.Forms.Label
$title.Text = "$($script:ProductName)"
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(24, 18)
$title.Size = New-Object System.Drawing.Size(420, 32)
$form.Controls.Add($title)

$sub = New-Object System.Windows.Forms.Label
$sub.Text = "版本 $($script:ProductVer) · Windows x64 · 测试版（未签名）"
$sub.ForeColor = [System.Drawing.Color]::DimGray
$sub.Location = New-Object System.Drawing.Point(26, 52)
$sub.Size = New-Object System.Drawing.Size(500, 20)
$form.Controls.Add($sub)

$detect = New-Object System.Windows.Forms.Label
$detect.Location = New-Object System.Drawing.Point(26, 82)
$detect.Size = New-Object System.Drawing.Size(600, 40)
if ($prev) {
    $detect.Text = "检测到已安装：$($prev.Version)（$($prev.Path)）`r`n将直接覆盖升级到 $($script:ProductVer)，原有数据目录保留。"
    $detect.ForeColor = [System.Drawing.Color]::FromArgb(0, 100, 0)
} else {
    $detect.Text = "未检测到已安装版本，将执行全新安装。"
    $detect.ForeColor = [System.Drawing.Color]::DimGray
}
$form.Controls.Add($detect)

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = '安装路径'
$lbl.Location = New-Object System.Drawing.Point(26, 134)
$lbl.Size = New-Object System.Drawing.Size(70, 22)
$form.Controls.Add($lbl)

$txt = New-Object System.Windows.Forms.TextBox
$txt.Location = New-Object System.Drawing.Point(100, 131)
$txt.Size = New-Object System.Drawing.Size(430, 24)
if ($prev) { $txt.Text = $prev.Path } else { $txt.Text = $script:DefaultDir }
$form.Controls.Add($txt)

$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = '浏览…'
$btnBrowse.Location = New-Object System.Drawing.Point(540, 129)
$btnBrowse.Size = New-Object System.Drawing.Size(80, 28)
$form.Controls.Add($btnBrowse)

$chkDesk = New-Object System.Windows.Forms.CheckBox
$chkDesk.Text = '创建桌面快捷方式'
$chkDesk.Location = New-Object System.Drawing.Point(100, 160)
$chkDesk.Size = New-Object System.Drawing.Size(200, 22)
$chkDesk.Checked = $true
$form.Controls.Add($chkDesk)

$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = '开机自动启动（可选，写入当前用户启动项）'
$chkAuto.Location = New-Object System.Drawing.Point(100, 182)
$chkAuto.Size = New-Object System.Drawing.Size(400, 22)
# Off by default on purpose: nothing starts itself unless the user ticks it.
$chkAuto.Checked = $false
$form.Controls.Add($chkAuto)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(26, 228)
$status.Size = New-Object System.Drawing.Size(600, 22)
$status.Text = '准备就绪。'
$form.Controls.Add($status)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(26, 254)
$bar.Size = New-Object System.Drawing.Size(594, 16)
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 0
$form.Controls.Add($bar)

$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Text = '开始安装'
$btnInstall.Location = New-Object System.Drawing.Point(430, 290)
$btnInstall.Size = New-Object System.Drawing.Size(100, 34)
$form.Controls.Add($btnInstall)

$btnUninst = New-Object System.Windows.Forms.Button
$btnUninst.Text = '卸载'
$btnUninst.Location = New-Object System.Drawing.Point(330, 290)
$btnUninst.Size = New-Object System.Drawing.Size(90, 34)
$btnUninst.Enabled = [bool]$prev
$form.Controls.Add($btnUninst)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '关闭'
$btnClose.Location = New-Object System.Drawing.Point(540, 262)
$btnClose.Size = New-Object System.Drawing.Size(80, 34)
$form.Controls.Add($btnClose)

$script:busy = $false

$setStep = {
    param([string]$Text)
    $status.Text = $Text
    [System.Windows.Forms.Application]::DoEvents()
}

$btnBrowse.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = '选择安装目录'
    $dlg.ShowNewFolderButton = $true
    if ($txt.Text) { $dlg.SelectedPath = $txt.Text }
    if ($dlg.ShowDialog() -eq 'OK') { $txt.Text = $dlg.SelectedPath }
})

$btnClose.Add_Click({ $form.Close() })

$btnInstall.Add_Click({
    if ($script:busy) { return }
    $script:busy = $true
    $btnInstall.Enabled = $false; $btnUninst.Enabled = $false; $btnBrowse.Enabled = $false
    $bar.MarqueeAnimationSpeed = 30
    try {
        $from = Install-Target -Target $txt.Text.Trim() -DesktopShortcut $chkDesk.Checked -SkipRegistry:$false -NoShortcut:$false -Autostart $chkAuto.Checked -OnStep $setStep
        $bar.MarqueeAnimationSpeed = 0
        if ($from) { $status.Text = "升级完成：$from → $($script:ProductVer)" }
        else { $status.Text = "安装完成：$($script:ProductVer)" }
        $msg = "安装完成。`r`n`r`n路径：$($txt.Text.Trim())`r`n`r`n启动：开始菜单 → $($script:ProductName)（或桌面快捷方式）`r`n诊断：开始菜单 → $($script:ProductName) → 诊断 → 自检`r`n日志：$($script:LogPath)"
        [System.Windows.Forms.MessageBox]::Show($msg, $script:ProductName, 'OK', 'Information') | Out-Null
        $script:prev = Get-ExistingInstall
        $btnUninst.Enabled = [bool]$script:prev
    } catch {
        $bar.MarqueeAnimationSpeed = 0
        $status.Text = '安装失败。'
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '安装失败', 'OK', 'Error') | Out-Null
    } finally {
        $script:busy = $false
        $btnInstall.Enabled = $true; $btnBrowse.Enabled = $true
    }
})

$btnUninst.Add_Click({
    if ($script:busy) { return }
    $target = $txt.Text.Trim()
    $ans = [System.Windows.Forms.MessageBox]::Show(
        "将卸载：$target`r`n`r`n是否保留数据目录（data\ 与 install\）？`r`n选「否」将全部删除。`r`n`r`n卸载会先结束该目录下正在运行的程序与 daemon 子进程。",
        '确认卸载', 'YesNoCancel', 'Warning')
    if ($ans -eq 'Cancel') { return }
    $keep = ($ans -eq 'Yes')
    $script:busy = $true
    $btnInstall.Enabled = $false; $btnUninst.Enabled = $false; $btnBrowse.Enabled = $false
    $bar.MarqueeAnimationSpeed = 30
    try {
        Uninstall-Target -Target $target -KeepData $keep -SkipRegistry:$false -OnStep $setStep
        $bar.MarqueeAnimationSpeed = 0
        $status.Text = '卸载完成。'
        [System.Windows.Forms.MessageBox]::Show("卸载完成。`r`n日志：$($script:LogPath)", $script:ProductName, 'OK', 'Information') | Out-Null
        $btnUninst.Enabled = $false
    } catch {
        $bar.MarqueeAnimationSpeed = 0
        $status.Text = '卸载失败。'
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '卸载失败', 'OK', 'Error') | Out-Null
    } finally {
        $script:busy = $false
        $btnInstall.Enabled = $true; $btnBrowse.Enabled = $true
    }
})

if ($prev) {
    Write-Log ("gui start; prev=" + $prev.Path + " / " + $prev.Version)
} else {
    Write-Log "gui start; prev=none"
}
[void]$form.ShowDialog()
