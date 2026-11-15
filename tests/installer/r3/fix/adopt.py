"""adopt.py —— ``Setup.exe /adopt "<现有目录>"``：把便携版就地升成安装版。

DIST-DECISION §3 的原话是「不复制第二份载荷，避免磁盘翻倍」。所以这里做的是
**搬运**而不是复制：

1. 认出 ``channel=portable`` 的目录（没有 ``install.json`` 时退一步看 ``bundle.json``）；
2. 建 ``versions\\<version>\\``，把载荷目录里的东西**移**进去；
3. ``data\\``、``install\\``、``installer\\``、``updates\\`` 留在原地，一个字节都不动；
4. 写回 ``install.json``（``schema=2``、``activeVersion``、``channel=installed``）；
5. 补卸载键与快捷方式（两项都可以用参数跳过，测试与 ``/NOREG`` 场景需要）。

安全性按「可能断电」设计：每移动一项就往 ``install\\adopt.journal.json`` 追加一条，
中途失败按逆序搬回去；搬不回去就明确报错并保留日志，绝不留下「一半在旧位置一半在
新位置」的目录。数据目录在搬运前后各算一次逐文件 sha256，不一致立即中止。

退出码（与 ``Setup.exe`` 的约定，稳定不改）：

====  ==========================================
0     成功，或已经是安装版（幂等，不做第二次）
2     不是便携版 / 版本号无法确定
3     找不到桌面入口（载荷不完整）
4     搬运失败（已回滚）
5     数据目录在搬运前后不一致（已回滚）
6     目标版本目录已存在内容（拒绝覆盖）
7     目录不可写 / 权限不足
====  ==========================================
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

#: 产品身份（与 apps/desktop/settings/branding.py 的 IDENTITY 同源；此处内联，
#: 让 adopt.py 能作为单文件被 PyInstaller 打进 Setup.exe，不依赖桌面壳的包）。
PRODUCT_NAME = "AIDriven NetDefense"
UNINSTALL_KEY = "AIDrivenNetDefense"
RUN_VALUE = "AIDrivenNetDefense"
DESKTOP_EXE = "AIDrivenNetDefense.exe"

#: 载荷里桌面入口可能出现的位置（与 Setup.ps1 / archive.py 一致）。
EXE_CANDIDATES = (
    "AIDrivenNetDefense.exe",
    "app/AIDrivenNetDefense.exe",
    "console/AIDrivenNetDefense.exe",
    "bin/AIDrivenNetDefense.exe",
    "app/bin/AIDrivenNetDefense.exe",
)

#: 这些目录/文件不属于「某个版本的载荷」：留在原地。
RESERVED = {"data", "install", "installer", "versions", "current", "updates"}

#: 迁移日志（写在 install\ 下，属于 install 的保留区）。
JOURNAL_REL = Path("install") / "adopt.journal.json"

EXIT_OK = 0
EXIT_NOT_PORTABLE = 2
EXIT_PAYLOAD_MISSING = 3
EXIT_MOVE_FAILED = 4
EXIT_DATA_CHANGED = 5
EXIT_VERSION_EXISTS = 6
EXIT_NOT_WRITABLE = 7

#: 卸载键的两个可能根（管理员写 HKLM，否则 HKCU）。
UNINSTALL_ROOTS = {
    "hkcu": r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    "hklm": r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
}


# --------------------------------------------------------------------- 结果类型


@dataclass
class AdoptResult:
    ok: bool
    code: int
    message: str
    root: str = ""
    version: str = ""
    channel_before: str = ""
    channel_after: str = ""
    moved: list[str] = field(default_factory=list)
    data_files: int = 0
    data_unchanged: bool = True
    registry: str = ""
    shortcuts: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "code": self.code,
            "message": self.message,
            "root": self.root,
            "version": self.version,
            "channel_before": self.channel_before,
            "channel_after": self.channel_after,
            "moved": self.moved,
            "data_files": self.data_files,
            "data_unchanged": self.data_unchanged,
            "registry": self.registry,
            "shortcuts": self.shortcuts,
            "warnings": self.warnings,
        }


# --------------------------------------------------------------------- 小工具


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())


def _read_json(path: Path) -> dict:
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def _looks_semver(text: str) -> bool:
    parts = str(text).strip().split("-")[0].split(".")
    if len(parts) != 3:
        return False
    return all(part.isdigit() for part in parts if part != "") and all(part != "" for part in parts)


def record_path(root: Path) -> Path:
    """``install\\install.json``（老布局可能直接在根上）。"""
    nested = root / "install" / "install.json"
    if nested.is_file():
        return nested
    flat = root / "install.json"
    return flat if flat.is_file() else nested


def find_desktop_exe(root: Path) -> str:
    for relative in EXE_CANDIDATES:
        if (root / relative).is_file():
            return relative
    return ""


def hash_tree(path: Path) -> dict[str, str]:
    """逐文件 sha256。目录不存在返回空表。"""
    result: dict[str, str] = {}
    if not path.is_dir():
        return result
    for item in sorted(path.rglob("*")):
        if not item.is_file():
            continue
        digest = hashlib.sha256()
        try:
            with open(item, "rb") as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
        except OSError:
            continue
        result[str(item.relative_to(path)).replace("\\", "/")] = digest.hexdigest()
    return result


def _is_writable(directory: Path) -> bool:
    probe = directory / ".adopt-probe"
    try:
        probe.write_text("x", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


# ----------------------------------------------------------------- 识别安装形态


@dataclass
class Target:
    root: Path
    version: str
    channel: str
    desktop_exe: str
    record: dict
    already_installed: bool = False


def detect(root: Path) -> Target:
    """读记录并判定这是不是可采纳的便携版。失败抛 ``AdoptError``。"""
    if not root.is_dir():
        raise AdoptError(EXIT_NOT_PORTABLE, f"目录不存在：{root}")
    record = _read_json(record_path(root))
    channel = str(record.get("channel") or "")
    version = str(record.get("version") or record.get("versionName") or "")

    if not record:
        # 裸解压的便携包可能没有 install.json；退一步看 bundle.json。
        bundle = _read_json(root / "bundle.json")
        version = str(bundle.get("version") or "")
        channel = "portable" if bundle else ""

    if channel == "installed" and str(record.get("activeVersion") or "") and (root / "versions").is_dir():
        desktop = str(record.get("desktopExe") or "") or find_desktop_exe(root)
        return Target(root, str(record.get("activeVersion") or version), channel, desktop, record, True)

    if channel != "portable":
        raise AdoptError(
            EXIT_NOT_PORTABLE,
            f"这个目录不是便携版（channel={channel or '缺失'}），不执行 adopt。"
            "只有 channel=portable 的目录才能就地转为安装版。",
        )
    if not _looks_semver(version):
        raise AdoptError(EXIT_NOT_PORTABLE, f"无法确定版本号（读到 {version!r}），无法建立 versions 结构")

    desktop = str(record.get("desktopExe") or "") or find_desktop_exe(root)
    if not desktop or not (root / desktop).is_file():
        raise AdoptError(EXIT_PAYLOAD_MISSING, f"载荷里找不到 {DESKTOP_EXE}，这不是完整安装目录")
    return Target(root, version, channel, desktop, record, False)


class AdoptError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------ 注册表后端


class _NoRegistry:
    def write(self, _record: dict) -> str:
        return "skipped"


class _FileRegistry:
    """把「要写的注册表内容」落到一个 JSON 文件。测试与 ``/NOREG`` 用。

    它不是模拟注册表，而是把**将要写入的值**导出，这样验收能断言字段，又不必
    在两个会话共用的机器上写真实的卸载键。
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def write(self, record: dict) -> str:
        _write_json(self.path, record)
        return str(self.path)


class _WinRegistry:
    """真实写入：管理员写 HKLM，否则 HKCU（与 Setup.ps1 一致）。"""

    def write(self, record: dict) -> str:
        import winreg  # type: ignore[import-not-found]

        hive = winreg.HKEY_CURRENT_USER
        hive_name = "hkcu"
        try:
            import ctypes

            if ctypes.windll.shell32.IsUserAnAdmin():
                hive, hive_name = winreg.HKEY_LOCAL_MACHINE, "hklm"
        except Exception:  # noqa: BLE001
            pass

        key_path = f"{UNINSTALL_ROOTS[hive_name]}\\{UNINSTALL_KEY}"
        with winreg.CreateKeyEx(hive, key_path, 0, winreg.KEY_WRITE) as key:
            for name, value in record.items():
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, str(value))
        return f"{hive_name}:\\{key_path}"


def uninstall_record(root: Path, version: str, desktop_exe: str) -> dict:
    """卸载键的内容。字段名沿用 Windows 的约定，中文只出现在 DisplayName。"""
    exe = root / "versions" / version / desktop_exe
    uninstaller = root / "installer" / "Setup.cmd"
    return {
        "DisplayName": PRODUCT_NAME,
        "DisplayVersion": version,
        "Publisher": "PT-dove",
        "InstallLocation": str(root),
        "DisplayIcon": str(exe),
        "UninstallString": f'"{uninstaller}" /uninstall',
        "QuietUninstallString": f'"{uninstaller}" /S /uninstall',
        "EstimatedSize": str(_dir_size_kb(root / "versions" / version)),
        "Channel": "installed",
        "AdoptedFrom": "portable",
    }


def _dir_size_kb(path: Path) -> int:
    total = 0
    try:
        for item in path.rglob("*"):
            if item.is_file():
                total += item.stat().st_size
    except OSError:
        return 0
    return total // 1024


# -------------------------------------------------------------------- 快捷方式


def shortcut_specs(
    root: Path,
    version: str,
    desktop_exe: str,
    *,
    desktop_dir: Path | None = None,
    start_menu_dir: Path | None = None,
) -> list[tuple[Path, Path]]:
    """要建的快捷方式：``[(lnk 路径, 目标 exe), ...]``。

    只建两个（桌面 + 开始菜单一级），文件名固定英文——中文文件名在部分环境里
    会因代码页问题变成乱码，而这是用户唯一会点的入口。
    """
    target = root / "versions" / version / desktop_exe
    desktop = Path(desktop_dir) if desktop_dir else Path(os.path.expanduser("~/Desktop"))
    start_menu = (
        Path(start_menu_dir)
        if start_menu_dir
        else Path(os.environ.get("APPDATA", os.path.expanduser("~"))) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    )
    return [
        (desktop / "AIDriven NetDefense.lnk", target),
        (start_menu / "AIDriven NetDefense" / "AIDriven NetDefense.lnk", target),
    ]


def create_shortcut(link: Path, target: Path, *, workdir: Path | None = None) -> bool:
    """用 WScript.Shell 建 .lnk。失败返回 False（缺快捷方式不是坏安装）。"""
    link.parent.mkdir(parents=True, exist_ok=True)
    script = (
        "$ws = New-Object -ComObject WScript.Shell; "
        f"$s = $ws.CreateShortcut('{link}'); "
        f"$s.TargetPath = '{target}'; "
        f"$s.WorkingDirectory = '{workdir or target.parent}'; "
        f"$s.IconLocation = '{target},0'; "
        "$s.Save()"
    )
    try:
        result = subprocess.run(  # noqa: S603,S607 - 固定命令，参数来自本函数
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            check=False,
            timeout=30,
        )
        return result.returncode == 0 and link.is_file()
    except (OSError, subprocess.SubprocessError):
        return False


# ---------------------------------------------------------------------- 主流程


@dataclass
class AdoptOptions:
    root: Path
    registry: str = "auto"          # auto | file | none
    registry_store: Path | None = None
    shortcuts: bool = True
    dry_run: bool = False
    desktop_dir: Path | None = None
    start_menu_dir: Path | None = None


def adopt(options: AdoptOptions) -> AdoptResult:
    """执行采纳。任何失败都返回结果对象，不抛（``main`` 只负责翻译成退出码）。"""
    root = Path(options.root).expanduser().resolve()
    result = AdoptResult(ok=False, code=EXIT_OK, message="", root=str(root))

    try:
        target = detect(root)
    except AdoptError as error:
        result.code = error.code
        result.message = error.message
        return result

    result.version = target.version
    result.channel_before = target.channel
    if target.already_installed:
        result.ok = True
        result.code = EXIT_OK
        result.channel_after = "installed"
        result.message = "已经是安装版，adopt 无事可做（幂等）"
        return result

    if not _is_writable(root):
        result.code = EXIT_NOT_WRITABLE
        result.message = f"目录不可写，无法就地采纳：{root}"
        return result

    version_dir = root / "versions" / target.version
    if version_dir.is_dir() and any(version_dir.iterdir()):
        result.code = EXIT_VERSION_EXISTS
        result.message = f"目标版本目录已有内容，拒绝覆盖：{version_dir}"
        return result

    data_before = hash_tree(root / "data")
    result.data_files = len(data_before)

    plan = [
        entry.name
        for entry in sorted(root.iterdir(), key=lambda p: p.name.lower())
        if entry.name.lower() not in RESERVED
    ]
    if not plan:
        result.code = EXIT_PAYLOAD_MISSING
        result.message = "安装目录里没有可搬运的载荷（只剩 data/install 等保留目录）"
        return result

    if options.dry_run:
        result.ok = True
        result.code = EXIT_OK
        result.message = f"演练：将把 {len(plan)} 项搬进 versions\\{target.version}\\，不写盘"
        result.moved = plan
        return result

    journal_path = root / JOURNAL_REL
    journal = {"from": "portable", "to": "installed", "version": target.version,
               "startedAt": _now_iso(), "moved": []}
    moved: list[str] = []

    try:
        version_dir.mkdir(parents=True, exist_ok=True)
        _write_json(journal_path, journal)
        for name in plan:
            source = root / name
            destination = version_dir / name
            if destination.exists():
                raise AdoptError(EXIT_VERSION_EXISTS, f"目标已存在，拒绝覆盖：{destination}")
            try:
                os.replace(str(source), str(destination))
            except OSError:
                # 跨卷（或目标被占用）时退回复制+删除；仍是「搬」不是「多留一份」。
                if source.is_dir():
                    shutil.move(str(source), str(destination))
                else:
                    shutil.copy2(str(source), str(destination))
                    source.unlink()
            moved.append(name)
            journal["moved"] = moved
            _write_json(journal_path, journal)
    except (AdoptError, OSError) as error:
        code = error.code if isinstance(error, AdoptError) else EXIT_MOVE_FAILED
        _undo_moves(root, version_dir, moved)
        result.code = code
        result.message = f"搬运失败，已回滚：{error}"
        return result

    # 搬运后必须还能找到入口，否则说明载荷本来就不完整 —— 立刻搬回去。
    if not (version_dir / target.desktop_exe).is_file():
        _undo_moves(root, version_dir, moved)
        result.code = EXIT_PAYLOAD_MISSING
        result.message = "搬运后找不到桌面入口，已回滚（载荷不完整）"
        return result

    data_after = hash_tree(root / "data")
    result.data_unchanged = data_before == data_after
    if not result.data_unchanged:
        _undo_moves(root, version_dir, moved)
        result.code = EXIT_DATA_CHANGED
        result.message = "数据目录在搬运前后不一致，已回滚；请检查是否有程序正在写 data\\"
        return result

    _write_install_record(root, target, version_dir)
    if not _point_current(root, target.version):
        result.warnings.append("current 目录联接未建立（不影响启动，activeVersion 为准）")

    result.moved = moved
    result.channel_after = "installed"

    if options.registry != "none":
        result.registry = _write_registry(root, target.version, target.desktop_exe, options)

    if options.shortcuts:
        specs = shortcut_specs(
            root,
            target.version,
            target.desktop_exe,
            desktop_dir=options.desktop_dir,
            start_menu_dir=options.start_menu_dir,
        )
        for link, exe in specs:
            if create_shortcut(link, exe):
                result.shortcuts.append(str(link))
            else:
                result.warnings.append(f"快捷方式未创建：{link}")

    try:
        journal_path.unlink(missing_ok=True)
    except OSError:
        pass

    if not (root / "installer" / "Setup.cmd").is_file():
        result.warnings.append("卸载入口 installer\\Setup.cmd 不存在，卸载键指向的路径需要安装器补齐")

    result.ok = True
    result.code = EXIT_OK
    result.message = (
        f"已转为安装版：{len(moved)} 项移入 versions\\{target.version}\\，"
        f"data 目录 {result.data_files} 个文件哈希不变"
    )
    return result


def _undo_moves(root: Path, version_dir: Path, moved: list[str]) -> None:
    """逆序搬回去。搬不动的保持原样并在日志里留痕，绝不静默丢弃。"""
    for name in reversed(moved):
        source = version_dir / name
        destination = root / name
        if not source.exists():
            continue
        try:
            if destination.exists():
                continue
            os.replace(str(source), str(destination))
        except OSError:
            try:
                shutil.move(str(source), str(destination))
            except OSError:
                pass
    try:
        if version_dir.is_dir() and not any(version_dir.iterdir()):
            version_dir.rmdir()
        if version_dir.parent.is_dir() and not any(version_dir.parent.iterdir()):
            version_dir.parent.rmdir()
    except OSError:
        pass


def _write_install_record(root: Path, target: Target, version_dir: Path) -> None:
    record = dict(target.record)
    record.update(
        {
            "schema": 2,
            "product": record.get("product") or PRODUCT_NAME,
            "version": target.version,
            "activeVersion": target.version,
            "channel": "installed",
            "previousChannel": target.channel,
            "installPath": str(root),
            "desktopExe": target.desktop_exe,
            "versions": [target.version],
            "adoptedAt": _now_iso(),
        }
    )
    record.setdefault("installedAt", _now_iso())
    _write_json(record_path(root), record)


def _point_current(root: Path, version: str) -> bool:
    link = root / "current"
    target = root / "versions" / version
    if not target.is_dir():
        return False
    try:
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            os.rmdir(str(link))
    except OSError:
        return False
    try:
        os.symlink(str(target), str(link), target_is_directory=True)
        return True
    except (OSError, NotImplementedError, AttributeError):
        pass
    try:
        result = subprocess.run(  # noqa: S603,S607
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    except OSError:
        return False


def _write_registry(root: Path, version: str, desktop_exe: str, options: AdoptOptions) -> str:
    record = uninstall_record(root, version, desktop_exe)
    backend = (options.registry or "auto").lower()
    try:
        if backend == "none":
            return _NoRegistry().write(record)
        if backend == "file":
            if options.registry_store is None:
                return "skipped (file backend without store path)"
            return _FileRegistry(Path(options.registry_store)).write(record)
        if os.name != "nt":
            return "skipped (not windows)"
        return _WinRegistry().write(record)
    except Exception as error:  # noqa: BLE001 - 卸载键失败不该毁掉整个采纳
        return f"failed: {error}"


# -------------------------------------------------------------------------- CLI


def parse_args(argv: list[str]) -> tuple[AdoptOptions, bool]:
    """极简参数解析：``Setup.exe /adopt "<dir>" [--no-registry] ...``。

    不用 argparse 的 ``--`` 前缀语法，是为了让 Setup.exe 的调用方两种写法都认：
    ``/adopt D:\\x`` 与 ``--adopt D:\\x``。
    """
    root: Path | None = None
    registry = "auto"
    registry_store: Path | None = None
    shortcuts = True
    dry_run = False
    as_json = False

    args = list(argv)
    index = 0
    while index < len(args):
        token = args[index]
        lowered = token.lower()
        if lowered in ("/adopt", "--adopt", "-a"):
            index += 1
            if index >= len(args):
                raise SystemExit(EXIT_NOT_PORTABLE)
            root = Path(args[index])
        elif lowered in ("/noreg", "--no-registry"):
            registry = "none"
        elif lowered == "--registry-file":
            index += 1
            if index >= len(args):
                raise SystemExit(EXIT_NOT_PORTABLE)
            registry, registry_store = "file", Path(args[index])
        elif lowered in ("/noshortcut", "--no-shortcuts"):
            shortcuts = False
        elif lowered in ("--dry-run", "/dryrun"):
            dry_run = True
        elif lowered in ("--json",):
            as_json = True
        elif not token.startswith(("/", "--")) and root is None:
            root = Path(token)
        index += 1

    if root is None:
        raise SystemExit(EXIT_NOT_PORTABLE)
    return (
        AdoptOptions(
            root=root,
            registry=registry,
            registry_store=registry_store,
            shortcuts=shortcuts,
            dry_run=dry_run,
        ),
        as_json,
    )


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    try:
        options, as_json = parse_args(arguments)
    except SystemExit as exit_signal:
        return int(exit_signal.code or EXIT_NOT_PORTABLE)

    result = adopt(options)
    if as_json:
        sys.stdout.write(json.dumps(result.to_dict(), ensure_ascii=False) + "\n")
    else:
        stream = sys.stdout if result.ok else sys.stderr
        stream.write(result.message + "\n")
        for warning in result.warnings:
            stream.write(f"  ! {warning}\n")
    return result.code


if __name__ == "__main__":
    raise SystemExit(main())
