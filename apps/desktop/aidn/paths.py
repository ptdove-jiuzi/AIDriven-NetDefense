"""paths.py —— 所有「文件在哪」的判断集中在这里。

刻意不做的事：不创建目录、不猜默认值之外的东西、不读配置内容。
调用方拿到 path 之后自己决定存在性与创建顺序，这样启动阶段的失败点只有一个。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_DIR_NAME = "AIDriven NetDefense"

#: 用户在设置里指定的日志目录。为 None 时按 `AIDN_LOG_DIR` → 默认目录解析。
_LOG_DIR_OVERRIDE: Path | None = None


def set_log_dir_override(path: "Path | str | None") -> None:
    """由 app 在读到设置后写入；空值表示回到默认目录。"""
    global _LOG_DIR_OVERRIDE
    _LOG_DIR_OVERRIDE = None if path in (None, "") else Path(path).expanduser().resolve()


def _frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def resource_root() -> Path:
    """打包后是 PyInstaller 的解包目录，开发时是 apps/desktop。"""
    if _frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def install_root() -> Path:
    """exe 所在目录（打包后）或仓库根（开发时：apps/desktop/aidn/paths.py → 上三级）。"""
    if _frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[3]


def base_dir() -> Path:
    """%LOCALAPPDATA%\\AIDriven NetDefense —— 数据与日志的共同根。"""
    override = os.environ.get("AIDN_BASE_DIR")
    if override:
        return Path(override).expanduser().resolve()
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        local = str(Path.home() / "AppData" / "Local")
    return Path(local) / APP_DIR_NAME


def data_dir() -> Path:
    override = os.environ.get("AIDN_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return base_dir() / "data"


def log_dir() -> Path:
    if _LOG_DIR_OVERRIDE is not None:
        return _LOG_DIR_OVERRIDE
    override = os.environ.get("AIDN_LOG_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return base_dir() / "logs"


def default_log_dir() -> Path:
    """设置里「恢复默认」用的目录，不受当前覆盖值影响。"""
    return base_dir() / "logs"


def shell_dir() -> Path:
    return data_dir() / "shell"


def settings_path() -> Path:
    return shell_dir() / "settings.json"


def runtime_state_path() -> Path:
    return shell_dir() / "runtime.json"


def daemon_conf_path() -> Path:
    return shell_dir() / "daemon.conf.json"


def daemon_log_path() -> Path:
    return shell_dir() / "daemon.stderr.log"


def token_path() -> Path:
    """daemon 自己生成的 bearer token 文件（apps/daemon/src/api/auth.js）。"""
    return data_dir() / "secrets" / "api-token"


def rules_path() -> Path:
    """数据目录内的规则包副本：daemon 的 resolveInside 只接受 dataDir 内的路径。"""
    return data_dir() / "rules" / "builtin-rules.json"


def rules_source() -> Path:
    return resource_root() / "assets" / "rules" / "builtin-rules.json"


def icon_path() -> Path:
    return resource_root() / "assets" / "app.ico"


def webui_dir() -> Path:
    """内置最小页。"""
    return resource_root() / "webui"


def console_dir() -> Path:
    """外部控制台目录（apps/console 的发布物），存在时优先于内置页。"""
    candidate = install_root() / "console"
    return candidate


def daemon_entry_candidates() -> list[Path]:
    """daemon 入口的搜索顺序：显式环境变量 → 安装树 → 仓库开发树。"""
    found: list[Path] = []
    explicit = os.environ.get("AIDN_DAEMON_ENTRY")
    if explicit:
        found.append(Path(explicit).expanduser())
    root = install_root()
    found.append(root / "daemon" / "apps" / "daemon" / "bin.js")
    found.append(root / "apps" / "daemon" / "bin.js")
    found.append(root.parent / "daemon" / "apps" / "daemon" / "bin.js")
    return found


def node_candidates() -> list[Path]:
    found: list[Path] = []
    explicit = os.environ.get("AIDN_NODE")
    if explicit:
        found.append(Path(explicit).expanduser())
    root = install_root()
    found.append(root / "runtime" / "node" / "node.exe")
    found.append(root / "node" / "node.exe")
    found.append(Path("C:/Program Files/nodejs/node.exe"))
    found.append(Path("C:/Program Files (x86)/nodejs/node.exe"))
    return found


def ensure_runtime_dirs() -> None:
    for directory in (data_dir(), log_dir(), shell_dir(), rules_path().parent):
        directory.mkdir(parents=True, exist_ok=True)
