"""settings.shell_api —— 显示名/语言接进桌面壳的三个接口。

和 ``aidn/server.py`` 的 ``dispatch_post`` 同契约：``(status, body)``。
壳侧接入只有三处（见文件末尾），不存在「改一堆文案」的扩散。

窗口标题的更新走 ``apply_to_window``：pywebview 不同版本对 ``set_title`` 的支持
不一致，拿不到就退回 ``evaluate_js`` 改 ``document.title``，都失败就只记日志——
标题不是功能，不该让切换语言这个动作失败。
"""

from __future__ import annotations

import logging
from pathlib import Path

from . import branding, display

log = logging.getLogger("aidn.settings.shell_api")


def state_block(
    *,
    language: str | None = None,
    data_dir: Path | None = None,
    version: str = "",
    include_update_label: bool = False,
) -> dict:
    """给 ``/shell/api/state`` 的块。前端靠它渲染语言按钮与标题。"""
    settings = display.current(language, data_dir)
    language = settings.language
    return {
        "language": language,
        "language_label": branding.LANGUAGE_LABELS[language],
        "display_name": branding.display_name(language),
        "paired_name": f"{branding.display_name(language)} / {branding.other_name(language)}",
        "window_title": branding.window_title(language, version),
        "languages": [
            {
                "code": code,
                "label": branding.LANGUAGE_LABELS[code],
                "display_name": branding.display_name(code),
            }
            for code in branding.LANGUAGES
        ],
        "tray": branding.tray_labels(language, include_update=include_update_label),
        # 身份常量原样返回：前端不该显示、也不该改它，留在这里是为了让
        # 「切语言没动文件名/注册表键/安装路径」这件事可被自动化断言。
        "identity": dict(branding.IDENTITY),
    }


def handle(payload: dict | None = None, *, data_dir: Path | None = None) -> tuple[int, dict]:
    """处理 ``POST /shell/api/display {language}``。"""
    payload = payload or {}
    if "language" not in payload:
        return (400, {"ok": False, "error": "缺少 language"})
    requested = payload.get("language")
    if not isinstance(requested, str):
        return (400, {"ok": False, "error": "language 必须是字符串"})
    settings = display.set_language(requested, data_dir)
    block = state_block(language=settings.language, data_dir=data_dir)
    return (200, {"ok": True, "display": block, "changed": f"language={settings.language}"})


def apply_to_window(window, language: str, version: str = "") -> str:
    """把窗口标题切成当前语言，返回实际生效的标题。"""
    title = branding.window_title(language, version)
    if window is None:
        return title
    try:
        window.set_title(title)
        return title
    except Exception:  # noqa: BLE001 - 老版本 pywebview 没有 set_title
        pass
    try:
        window.evaluate_js(f"document.title = {title!r};")
    except Exception:  # noqa: BLE001
        log.warning("窗口标题更新失败（不影响功能）：%s", title)
    return title


def apply_to_tray(tray, language: str, *, include_update: bool = False) -> bool:
    """把托盘菜单文案换成当前语言。托盘没起来就返回 False。"""
    if tray is None:
        return False
    labels = branding.tray_labels(language, include_update=include_update)
    setter = getattr(tray, "set_labels", None)
    if callable(setter):
        try:
            setter(labels)
            return True
        except Exception:  # noqa: BLE001
            log.warning("托盘文案更新失败")
            return False
    return False


#: 壳侧接入（``aidn/server.py`` 的 ``dispatch_post``）::
#:
#:     "/shell/api/display": lambda: settings_api.handle(payload),
#:
#: ``ShellController.state()`` 里加一行::
#:
#:     "display": settings_api.state_block(language=self.settings.ui_language,
#:                                        version=SHELL_VERSION,
#:                                        include_update_label=updater.constants.auto_update_enabled()),
#:
#: 切换语言后立即生效（``ShellController.update_settings`` 内）::
#:
#:     settings_api.apply_to_window(self._window, lang, SHELL_VERSION)
#:     settings_api.apply_to_tray(self._tray, lang)
