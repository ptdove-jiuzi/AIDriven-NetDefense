"""settings —— 显示名与语言偏好。

* ``branding`` 显示名、窗口标题、托盘文案，以及**与语言无关的身份常量**；
* ``display``  偏好持久化（``shell/display.json``，独立于壳的 ``settings.json``）；
* ``shell_api`` 与桌面壳 ``(status, body)`` 契约一致的 HTTP 动作。

需求边界：切语言只改「看到的字」，不改文件名、卸载键、安装路径、数据目录。
``branding.IDENTITY`` 是这条边界的唯一表述，测试逐条钉住。
"""

from __future__ import annotations

from . import branding, display, shell_api
from .branding import (
    DEFAULT_LANGUAGE,
    DISPLAY_NAME_EN,
    DISPLAY_NAME_ZH,
    IDENTITY,
    LANGUAGES,
    display_name,
    normalize_language,
    tray_labels,
    window_title,
)
from .display import DisplaySettings

__all__ = [
    "DEFAULT_LANGUAGE",
    "DISPLAY_NAME_EN",
    "DISPLAY_NAME_ZH",
    "IDENTITY",
    "LANGUAGES",
    "DisplaySettings",
    "branding",
    "display",
    "display_name",
    "normalize_language",
    "shell_api",
    "tray_labels",
    "window_title",
]
