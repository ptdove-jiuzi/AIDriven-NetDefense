"""settings.py —— 壳自己的用户设置，以及「开机自启」这一条注册表副作用。

设计取舍：

- 设置是**壳**的状态，不放进 daemon 配置。daemon 的 config.js 是封闭对象，
  多一个键就会被拒绝启动，所以两者绝不混写。
- 写盘用「临时文件 + 原子替换」，避免半截 JSON 让下一次启动直接判成损坏。
- 读取时任何异常都回落到默认值并保留原文件（改名成 .bad），不静默吞掉用户的设置。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass, asdict
from pathlib import Path

log = logging.getLogger("aidn.settings")

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "AIDrivenNetDefense"

DEFAULT_UI_PORT = 17801
DEFAULT_DAEMON_PORT = 17802


@dataclass
class Settings:
    open_mode: str = "embedded"          # embedded | browser
    ui_port: int = DEFAULT_UI_PORT       # 0 表示每次启动随机
    daemon_port: int = DEFAULT_DAEMON_PORT  # 被占用时按 +1 递增；0 表示随机
    autostart: bool = False
    log_dir: str = ""                    # 空 = %LOCALAPPDATA%\AIDriven NetDefense\logs
    window_width: int = 1180
    window_height: int = 780

    def normalized(self) -> "Settings":
        mode = self.open_mode if self.open_mode in ("embedded", "browser") else "embedded"
        return Settings(
            open_mode=mode,
            ui_port=_port(self.ui_port, DEFAULT_UI_PORT),
            daemon_port=_port(self.daemon_port, DEFAULT_DAEMON_PORT),
            autostart=bool(self.autostart),
            log_dir=_log_dir(self.log_dir),
            window_width=_clamp(self.window_width, 960, 3840, 1180),
            window_height=_clamp(self.window_height, 640, 2160, 780),
        )


def _port(value: object, fallback: int) -> int:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return number if 0 <= number <= 65535 else fallback


def _clamp(value: object, low: int, high: int, fallback: int) -> int:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def _log_dir(value: object) -> str:
    """日志目录只接受空串或绝对路径；相对路径会被拒绝而不是相对某个未知 cwd 解析。"""
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text:
        return ""
    if not os.path.isabs(text):
        return ""
    return text


def load(path: Path) -> Settings:
    if not path.exists():
        settings = Settings().normalized()
        save(path, settings)
        return settings
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("settings.json 的顶层不是对象")
        settings = Settings(
            open_mode=raw.get("open_mode", "embedded"),
            ui_port=raw.get("ui_port", DEFAULT_UI_PORT),
            daemon_port=raw.get("daemon_port", DEFAULT_DAEMON_PORT),
            autostart=raw.get("autostart", False),
            log_dir=raw.get("log_dir", ""),
            window_width=raw.get("window_width", 1180),
            window_height=raw.get("window_height", 780),
        ).normalized()
        return settings
    except Exception as error:  # noqa: BLE001 - 设置损坏必须可恢复
        log.warning("设置文件不可用（%s），已改名为 .bad 并使用默认值", error)
        try:
            broken = path.with_suffix(path.suffix + ".bad")
            path.replace(broken)
            log.warning("原文件保留在 %s", broken)
        except OSError:
            pass
        settings = Settings().normalized()
        save(path, settings)
        return settings


def save(path: Path, settings: Settings) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(asdict(settings), ensure_ascii=False, indent=2) + "\n"
    handle, temp_name = tempfile.mkstemp(prefix=".settings-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _executable_command() -> str:
    import sys

    if getattr(sys, "frozen", False):
        return f'"{Path(sys.executable).resolve()}" --background'
    entry = Path(__file__).resolve().parent.parent / "main.py"
    python = Path(sys.executable).resolve()
    return f'"{python}" "{entry}" --background'


def _run_target() -> tuple[str, str]:
    """开机自启写在哪。

    默认固定为 HKCU 的真实 Run 键。`AIDN_RUN_KEY` / `AIDN_RUN_VALUE` 是给自动化
    测试用的隔离点：验证「写入/删除/读回」这条链路时不能去改用户真实的开机自启
    项，否则一次跑测试就会替用户决定下次开机启动什么。
    """
    key = os.environ.get("AIDN_RUN_KEY") or RUN_KEY
    value = os.environ.get("AIDN_RUN_VALUE") or RUN_VALUE
    return (key, value)


def autostart_state() -> tuple[bool, str | None]:
    """返回 (是否已登记, 当前登记的完整命令)。没有 winreg 时返回 False。"""
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:
        return (False, None)
    key_path, value_name = _run_target()
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, value_name)
            return (True, str(value))
    except FileNotFoundError:
        return (False, None)
    except OSError as error:
        log.warning("读取开机自启项失败：%s", error)
        return (False, None)


def set_autostart(enabled: bool) -> bool:
    """写入/删除 HKCU Run 项。返回操作后的真实状态。"""
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:
        log.error("当前环境不支持 winreg，开机自启不可用")
        return False
    key_path, value_name = _run_target()
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                winreg.SetValueEx(key, value_name, 0, winreg.REG_SZ, _executable_command())
                log.info("已登记开机自启：%s", _executable_command())
            else:
                try:
                    winreg.DeleteValue(key, value_name)
                    log.info("已移除开机自启登记")
                except FileNotFoundError:
                    pass
    except OSError as error:
        log.error("写入开机自启失败：%s", error)
        return autostart_state()[0]
    return autostart_state()[0]
