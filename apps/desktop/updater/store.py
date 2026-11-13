"""store.py —— 安装布局与「当前版本」指针。

布局（ADR-0011 §4）::

    <root>\\
      install\\install.json      ← 唯一事实来源：channel / activeVersion / desktopExe
      versions\\<ver>\\            ← 每个版本一个目录，切换只换指针
      current                    ← 目录联接（能建就建，建不了不影响正确性）
      data\\                      ← 用户数据，更新过程一个字节都不动
      updates\\                   ← 下载临时区、检查缓存、pending.json

两条铁律：

1. **``install.json`` 是唯一事实来源**，目录联接只是给人看的便利。联接建不出来
   （非管理员 + 未开开发者模式）时功能照常，不因此报错。
2. **写 ``install.json`` 必须原子**（临时文件 + ``os.replace``）。半截 JSON 会让
   下一次启动既回不到旧版也认不出新版。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import constants

#: 安装记录的相对路径。
INSTALL_RECORD_REL = Path("install") / "install.json"

#: 这些目录不属于「某个版本的载荷」，切换/采纳时必须留在原地。
RESERVED_DIRS = {"data", "install", "versions", "current", "updates"}

#: 记录 schema 版本。1 = 老安装器（Setup.ps1）写的裸记录。
RECORD_SCHEMA = 2


# --------------------------------------------------------------------- 基础读取


def versions_dir(root: Path) -> Path:
    return root / "versions"


def updates_dir(root: Path) -> Path:
    return root / "updates"


def data_dir(root: Path) -> Path:
    return root / "data"


def record_path(root: Path) -> Path:
    return root / INSTALL_RECORD_REL


def pending_path(root: Path) -> Path:
    return updates_dir(root) / "pending.json"


def cache_path(root: Path) -> Path:
    return updates_dir(root) / "check.json"


def default_install_root() -> Path:
    """推断安装根目录。

    打包后是 exe 所在目录；开发树里是仓库根（``apps/desktop/updater/store.py``
    往上四级），与桌面壳 ``aidn.paths.install_root()`` 保持同一口径。
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[3]


def read_record(root: Path) -> dict:
    """读安装记录。缺失或损坏都返回 ``{}``，由调用方判「这不是安装版」。"""
    try:
        raw = record_path(root).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def write_record(root: Path, record: dict) -> Path:
    """原子写安装记录。"""
    target = record_path(root)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    handle, temp_name = tempfile.mkstemp(prefix=".install-", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, target)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
    return target


def channel(root: Path) -> str:
    return str(read_record(root).get("channel") or "")


def active_version(root: Path) -> str:
    """当前生效的版本号。老记录只有 ``version`` 字段。"""
    record = read_record(root)
    return str(record.get("activeVersion") or record.get("version") or "")


@dataclass
class InstallState:
    """给 UI / 引擎看的安装态快照。"""

    root: Path
    channel: str = ""
    version: str = ""
    desktop_exe: str = ""
    versions: list[str] = field(default_factory=list)
    installed: bool = False

    @property
    def has_versions_layout(self) -> bool:
        return bool(self.versions)

    def to_dict(self) -> dict:
        return {
            "root": str(self.root),
            "channel": self.channel,
            "version": self.version,
            "desktop_exe": self.desktop_exe,
            "versions": list(self.versions),
            "installed": self.installed,
            "layout": "versions" if self.has_versions_layout else "flat",
        }


def inspect(root: Path) -> InstallState:
    record = read_record(root)
    return InstallState(
        root=root,
        channel=str(record.get("channel") or ""),
        version=active_version(root),
        desktop_exe=str(record.get("desktopExe") or ""),
        versions=installed_versions(root),
        installed=bool(record),
    )


def installed_versions(root: Path) -> list[str]:
    """``versions\\`` 下的版本目录，按版本号从旧到新排序。"""
    from .manifest import compare_versions, parse_version

    base = versions_dir(root)
    if not base.is_dir():
        return []
    found: list[str] = []
    for entry in base.iterdir():
        if not entry.is_dir():
            continue
        try:
            parse_version(entry.name)
        except Exception:  # noqa: BLE001 - 非版本目录（如 .partial）直接忽略
            continue
        found.append(entry.name)
    found.sort(key=lambda v: parse_version(v))
    return found


def version_dir(root: Path, version: str) -> Path:
    return versions_dir(root) / version


def desktop_exe_path(root: Path, version: str | None = None) -> Path:
    """当前版本的可执行文件绝对路径。"""
    record = read_record(root)
    relative = str(record.get("desktopExe") or "")
    target_version = version or active_version(root)
    if not relative:
        return Path()
    if target_version and version_dir(root, target_version).is_dir():
        return version_dir(root, target_version) / relative
    return root / relative


# ------------------------------------------------------------------ 指针切换


def activate(root: Path, version: str, *, desktop_exe: str | None = None) -> str:
    """把 ``activeVersion`` 切到 *version*，返回切换前的版本。

    顺序：先写记录（原子），再更新目录联接（尽力）。即使联接更新失败，启动路径
    依旧按记录走，所以切换本身是原子的。
    """
    record = read_record(root)
    previous = active_version(root)
    record.update(
        {
            "schema": RECORD_SCHEMA,
            "activeVersion": version,
            "version": version,
            "versions": installed_versions(root),
        }
    )
    if desktop_exe:
        record["desktopExe"] = desktop_exe
    record.setdefault("channel", "installed")
    record["updatedAt"] = _now_iso()
    write_record(root, record)
    point_current(root, version)
    return previous


def point_current(root: Path, version: str) -> bool:
    """维护 ``<root>\\current`` 目录联接。失败不抛：它只是给人和第三方工具看的。"""
    link = root / "current"
    target = version_dir(root, version)
    if not target.is_dir():
        return False
    try:
        if link.exists() or link.is_symlink():
            _remove_link(link)
        try:
            os.symlink(str(target), str(link), target_is_directory=True)
            return True
        except (OSError, NotImplementedError, AttributeError):
            pass
        # 非管理员 + 未开开发者模式时 os.symlink 会被拒；退到 mklink /J（目录联接
        # 不需要特权）。仍然失败就放弃，不影响正确性。
        # 注意：cmd 的输出是控制台代码页（GBK），不能按 UTF-8 解——只取返回码。
        result = subprocess.run(  # noqa: S603,S607 - 固定命令，参数由本函数拼
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    except OSError:
        return False


def _remove_link(link: Path) -> None:
    try:
        if link.is_symlink():
            link.unlink()
            return
        # 目录联接在 Windows 上 is_symlink() 为 False，用 rmdir 移除不会删到目标内容。
        os.rmdir(str(link))
    except OSError:
        try:
            link.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- pending 记录


@dataclass
class Pending:
    """一次「已切换、待确认」的更新。"""

    from_version: str
    to_version: str
    activated_at: float
    attempts: int = 1
    reason: str = ""

    @property
    def deadline(self) -> float:
        return self.activated_at + constants.HEALTH_TIMEOUT_S

    def expired(self, now: float) -> bool:
        return now >= self.deadline

    def to_dict(self) -> dict:
        return {
            "from": self.from_version,
            "to": self.to_version,
            "activated_at": self.activated_at,
            "deadline": self.deadline,
            "attempts": self.attempts,
            "reason": self.reason,
        }


def read_pending(root: Path) -> Pending | None:
    try:
        raw = json.loads(pending_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    try:
        return Pending(
            from_version=str(raw.get("from") or ""),
            to_version=str(raw.get("to") or ""),
            activated_at=float(raw.get("activated_at") or 0.0),
            attempts=int(raw.get("attempts") or 1),
            reason=str(raw.get("reason") or ""),
        )
    except (TypeError, ValueError):
        return None


def write_pending(root: Path, pending: Pending) -> Path:
    target = pending_path(root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(pending.to_dict(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return target


def clear_pending(root: Path) -> None:
    try:
        pending_path(root).unlink(missing_ok=True)
    except OSError:
        pass


# --------------------------------------------------------------------- 清理


def prune(root: Path, *, keep: int = constants.KEEP_VERSIONS, active: str = "") -> list[str]:
    """删掉多余版本目录，保留 ``active`` 与最新的 ``keep - 1`` 个。返回删掉的版本。"""
    active = active or active_version(root)
    ordered = installed_versions(root)
    removable = [v for v in ordered if v != active]
    # 从最旧的开始删，凑够 keep 就不再动（留下的那个就是回滚目标）。
    budget = max(0, keep - 1)
    protected = set(removable[-budget:]) if budget else set()
    removed: list[str] = []
    for candidate in removable:
        if candidate in protected:
            continue
        target = version_dir(root, candidate)
        try:
            shutil.rmtree(target)
            removed.append(candidate)
        except OSError:
            continue
    return removed


def ensure_layout(root: Path) -> None:
    """建出更新器需要的目录。已存在则不动。"""
    for directory in (versions_dir(root), updates_dir(root), root / "install"):
        directory.mkdir(parents=True, exist_ok=True)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())
