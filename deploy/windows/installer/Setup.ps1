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
$script:ProductVer    = '0.0.1-rc.1'
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
        try { return (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json) } catch { return $null }
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

function Stop-TargetProcesses {
    # Kills every process whose executable lives under $Root, whose command line
    # references $Root (node daemons spawned with the install dir in their args),
    # and every descendant of those — children first, so a supervisor cannot
    # respawn the daemon while we are deleting files.
    param([string]$Root)
    $prefix = $Root.TrimEnd('\') + '\'
    $killed = 0
    try {
        $all = Get-CimInstance Win32_Process -ErrorAction Stop
    } catch {
        # CIM unavailable: fall back to the path-only match.
        try {
            Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
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

    $match = @{}
    foreach ($proc in $all) {
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
        foreach ($proc in $all) {
            $pid2 = [int]$proc.ProcessId
            if ($match.ContainsKey($pid2)) { continue }
            if ($match.ContainsKey([int]$proc.ParentProcessId)) {
                $match[$pid2] = $proc
                $changed = $true
            }
        }
    }

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

    # Second pass: anything still alive under the root (e.g. a child fast-respawned).
    try {
        foreach ($proc in (Get-CimInstance Win32_Process -ErrorAction Stop)) {
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
    $diag = Join-Path $startMenu '诊断'
    New-Shortcut -LinkPath (Join-Path $diag '自检.lnk') `
        -TargetPath (Join-Path $Root '启动-自检.cmd') -WorkDir $Root `
        -Description ($script:ProductName + ' 诊断 / 自检')

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

function Set-Autostart {
    param([bool]$Enabled, [string]$ExePath)
    try {
        if ($Enabled) {
            if (-not (Test-Path $script:RunKey)) { New-Item -Path $script:RunKey -Force | Out-Null }
            Set-ItemProperty -Path $script:RunKey -Name $script:RunValueName -Value ('"' + $ExePath + '"')
            Write-Log "autostart on: $ExePath"
        } else {
            Remove-Autostart
        }
    } catch {
        Write-Log ("autostart set failed: " + $_.Exception.Message)
        throw "写入开机自启项失败：$($_.Exception.Message)"
    }
}

function Remove-Autostart {
    try {
        if (Test-Path $script:RunKey) {
            $cur = Get-ItemProperty -Path $script:RunKey -Name $script:RunValueName -ErrorAction SilentlyContinue
            if ($cur) {
                Remove-ItemProperty -Path $script:RunKey -Name $script:RunValueName -Force -ErrorAction Stop
                Write-Log "autostart removed: $($script:RunValueName)"
            }
        }
    } catch {
        Write-Log ("autostart remove failed: " + $_.Exception.Message)
        throw "清除开机自启项失败：$($_.Exception.Message)"
    }
}

function Test-Autostart {
    try {
        if (-not (Test-Path $script:RunKey)) { return $false }
        $cur = Get-ItemProperty -Path $script:RunKey -Name $script:RunValueName -ErrorAction SilentlyContinue
        return [bool]$cur
    } catch { return $false }
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

    if ($OnStep) { & $OnStep '写入安装记录…' }
    $installDir = Join-Path $Target 'install'
    if (-not (Test-Path -LiteralPath $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }

    $record = [ordered]@{
        product        = $script:ProductName
        version        = $script:ProductVer
        installPath    = $Target
        installedAt    = (Get-Date).ToString('o')
        payloadBuiltAt = $payload.BuiltAt
        payloadKind    = $payload.Kind
        payloadSchema  = $payload.Schema
        desktopExe     = $exeRel
        autostart      = [bool]$Autostart
        upgradedFrom   = $upgradeFrom
        channel        = 'test'
    }
    ($record | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath (Join-Path $installDir 'install.json') -Encoding UTF8

    if ($OnStep) { & $OnStep '创建快捷方式（程序 / 诊断）…' }
    Write-SelfCheckScript -Root $Target | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'SelfCheck.mjs') -Destination (Join-Path $Target 'SelfCheck.mjs') -Force

    if (-not $NoShortcut) {
        New-InstallShortcuts -Root $Target -ExeRel $exeRel -Desktop $DesktopShortcut
    }

    if ($OnStep) { & $OnStep '设置开机自启…' }
    Set-Autostart -Enabled ([bool]$Autostart) -ExePath $exePath

    if (-not $SkipRegistry) {
        if ($OnStep) { & $OnStep '登记卸载信息…' }
        $uninstallCmd = '"' + (Join-Path $Target 'installer\Setup.cmd') + '" /uninstall'
        $regRoot = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
        $admin = $false
        try {
            $id = [Security.Principal.WindowsIdentity]::GetCurrent()
            $pr = New-Object Security.Principal.WindowsPrincipal($id)
            $admin = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        } catch { $admin = $false }
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

    if ($OnStep) { & $OnStep '停止正在运行的程序（含 daemon 子进程）…' }
    $stopped = Stop-TargetProcesses -Root $Target
    Write-Log ("uninstall stop: {0} process(es)" -f $stopped)

    if ($OnStep) { & $OnStep '移除快捷方式…' }
    Remove-Shortcuts

    if ($OnStep) { & $OnStep '清除开机自启项…' }
    # Always cleared: a dangling Run entry would point at a deleted exe.
    Remove-Autostart

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
