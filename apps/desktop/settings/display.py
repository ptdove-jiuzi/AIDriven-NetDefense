"""display.py —— 显示偏好（语言/显示名）的持久化。

为什么不写进 ``shell/settings.json``：那份文件由桌面壳用「整份 dataclass 序列化」
的方式重写，任何它不认识的键都会在下一次保存时被抹掉。语言设置另存一个文件
（``shell/display.json``），两条写路径互不覆盖——这是「重启后仍保持」的实现基础。

读失败（损坏、只读）一律回落默认值并**保留原文件**：用户可能只是手改错了一个引号，
不该因此丢掉他选过的中文界面。
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from . import branding

#: 数据根的环境变量（与桌面壳 ``aidn.paths`` 同一契约，便于测试隔离）。
DATA_DIR_ENV = "AIDN_DATA_DIR"
BASE_DIR_ENV = "AIDN_BASE_DIR"

#: 文件相对数据根的位置。
DISPLAY_REL = Path("shell") / "display.json"


def default_data_dir() -> Path:
    """``%LOCALAPPDATA%\\AIDriven NetDefense\\data``（可用环境变量重定向）。"""
    override = os.environ.get(DATA_DIR_ENV, "").strip()
    if override:
        return Path(os.path.expandvars(override)).expanduser()
    base = os.environ.get(BASE_DIR_ENV, "").strip()
    if base:
        return Path(os.path.expandvars(base)).expanduser() / "data"
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / branding.IDENTITY["data_dir"] / "data"


@dataclass
class DisplaySettings:
    """目前只有一个字段；留成类是为了以后加「紧凑模式」之类不影响身份的偏好。"""

    language: str = branding.DEFAULT_LANGUAGE

    def normalized(self) -> "DisplaySettings":
        return DisplaySettings(language=branding.normalize_language(self.language))

    @property
    def display_name(self) -> str:
        return branding.display_name(self.language)

    def to_dict(self) -> dict:
        return asdict(self.normalized())


def path_for(data_dir: Path | None = None) -> Path:
    return Path(data_dir or default_data_dir()) / DISPLAY_REL


def load(data_dir: Path | None = None) -> tuple[DisplaySettings, str | None]:
    """读显示偏好，返回 ``(设置, 问题)``。文件不存在不是问题。"""
    target = path_for(data_dir)
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return DisplaySettings(), None
    except OSError as error:
        return DisplaySettings(), f"显示设置不可读：{error}"
    try:
        payload = json.loads(raw)
    except ValueError as error:
        return DisplaySettings(), f"显示设置不是合法 JSON（{error}），已使用默认值"
    if not isinstance(payload, dict):
        return DisplaySettings(), "显示设置的顶层不是对象，已使用默认值"
    return DisplaySettings(language=payload.get("language", branding.DEFAULT_LANGUAGE)).normalized(), None


def save(settings: DisplaySettings, data_dir: Path | None = None) -> Path:
    """原子写。返回实际写入的路径。"""
    target = path_for(data_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(settings.to_dict(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    handle, temp_name = tempfile.mkstemp(prefix=".display-", suffix=".tmp", dir=str(target.parent))
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


def set_language(language: object, data_dir: Path | None = None) -> DisplaySettings:
    """切换语言并落盘。非法值回落默认语言，不报错。"""
    settings = DisplaySettings(language=branding.normalize_language(language)).normalized()
    save(settings, data_dir)
    return settings


def current(language: str | None = None, data_dir: Path | None = None) -> DisplaySettings:
    """取当前设置：显式传入优先（壳缓存的值），否则读盘，再否则默认。"""
    if language:
        return DisplaySettings(language=branding.normalize_language(language))
    loaded, _problem = load(data_dir)
    return loaded
