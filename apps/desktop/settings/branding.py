"""branding.py —— 显示名：默认英文，可切中文，且只改「看到的字」。

需求边界写死在代码里，因为这里最容易越界：

* **只影响** UI 文案（品牌字样、关于页、托盘菜单、窗口标题）；
* **不改变** 可执行文件名、卸载注册表键、开机自启值名、安装目录名、数据目录名、
  互斥体名。这些是「身份」，改了就等于换了一个产品：快捷方式失效、卸载残留、
  用户数据看起来丢了。它们被钉在 ``IDENTITY`` 里，任何语言都读同一份。

默认语言是英文（``en``）：发布名 ``AIDriven NetDefense`` 是给外人看的，
``网域智防`` 是中文语境下的显示名，两者是同一个产品。
"""

from __future__ import annotations

#: 发布名（默认显示）。
DISPLAY_NAME_EN = "AIDriven NetDefense"

#: 中文显示名。
DISPLAY_NAME_ZH = "网域智防"

#: 默认语言。英文优先：文件名、日志、GitHub 页面都是英文，界面跟着走少一层翻译。
DEFAULT_LANGUAGE = "en"

#: 支持的语言。顺序即设置页的展示顺序。
LANGUAGES = ("en", "zh")

#: 语言的自称，用于设置页按钮。
LANGUAGE_LABELS = {"en": "English", "zh": "中文"}

#: 身份常量：**与语言无关**，任何切换都不许动。测试会逐条钉住。
IDENTITY = {
    # 可执行文件名（发布资产、快捷方式、进程名都用它）
    "exe": "AIDrivenNetDefense.exe",
    # HKCU\...\Run 值名（开机自启）
    "run_value": "AIDrivenNetDefense",
    # 卸载注册表键名
    "uninstall_key": "AIDrivenNetDefense",
    # 安装目录的默认名
    "install_dir": "AIDriven NetDefense",
    # 数据目录（%LOCALAPPDATA% 下）
    "data_dir": "AIDriven NetDefense",
    # 单实例互斥体
    "mutex": "Local\\AIDrivenNetDefense.Desktop.Shell",
    # 壳写接口要求的自定义头
    "shell_header": "x-aidn-shell",
}

#: 托盘菜单文案。``check_update`` 只在自动更新打开时出现，由调用方决定。
_TRAY = {
    "en": {
        "show": "Open Window",
        "browser": "Open in Browser",
        "settings": "Settings",
        "check_update": "Check for Updates",
        "quit": "Quit",
    },
    "zh": {
        "show": "打开界面",
        "browser": "在浏览器中打开",
        "settings": "设置",
        "check_update": "检查更新",
        "quit": "退出",
    },
}

#: 窗口标题的后缀说明（内测期用；正式发布时可以留空）。
_TITLE_SUFFIX = {"en": "", "zh": ""}


def normalize_language(value: object) -> str:
    """把任意输入收敛到 ``LANGUAGES`` 里的一个值，非法输入回落默认。"""
    if isinstance(value, str):
        text = value.strip().lower().replace("_", "-")
        if text in LANGUAGES:
            return text
        # 允许 "zh-cn" / "zh-hans" 这类带地区的写法
        base = text.split("-", 1)[0]
        if base in LANGUAGES:
            return base
    return DEFAULT_LANGUAGE


def display_name(language: object = DEFAULT_LANGUAGE) -> str:
    """当前语言下的产品显示名。"""
    return DISPLAY_NAME_ZH if normalize_language(language) == "zh" else DISPLAY_NAME_EN


def other_name(language: object = DEFAULT_LANGUAGE) -> str:
    """另一种语言的名字，用于「英文名 / 中文名」并列展示。"""
    return DISPLAY_NAME_EN if normalize_language(language) == "zh" else DISPLAY_NAME_ZH


def window_title(language: object = DEFAULT_LANGUAGE, version: str = "") -> str:
    """窗口标题。带版本时用 ``·`` 分隔，不带就只是显示名。"""
    name = display_name(language)
    suffix = _TITLE_SUFFIX[normalize_language(language)]
    parts = [name]
    if suffix:
        parts.append(suffix)
    if version:
        parts.append(version)
    return parts[0] if len(parts) == 1 else f"{parts[0]} · " + " · ".join(parts[1:])


def tray_labels(language: object = DEFAULT_LANGUAGE, *, include_update: bool = False) -> dict:
    """托盘菜单文案。``include_update`` 由 ``AUTO_UPDATE_ENABLED`` 决定。"""
    labels = dict(_TRAY[normalize_language(language)])
    if not include_update:
        labels.pop("check_update", None)
    return labels


def tray_tooltip(language: object = DEFAULT_LANGUAGE, version: str = "") -> str:
    """托盘悬停提示，最长 127 字符（Shell_NotifyIcon 的硬限制）。"""
    name = display_name(language)
    return f"{name} · {version}"[:127] if version else name[:127]


def about_rows(language: object = DEFAULT_LANGUAGE) -> list[tuple[str, str]]:
    """关于页的「产品」一行：两种名字都给，避免用户以为装了两个东西。"""
    lang = normalize_language(language)
    name = display_name(lang)
    paired = f"{name} / {other_name(lang)}"
    return [("产品", paired) if lang == "zh" else ("Product", paired)]
