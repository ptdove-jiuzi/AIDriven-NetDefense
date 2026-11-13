"""aidn —— AIDriven NetDefense 桌面壳（作者 PT-dove）。

包内模块按职责分层，互不反向依赖：

- ``paths``    只回答「文件在哪」，不做 IO；
- ``settings`` 只读写 ``shell/settings.json``；
- ``daemon``   只管 daemon 子进程的生命周期；
- ``server``   只提供本地静态页 + 同源代理 + 少量壳管理接口；
- ``tray``     只负责通知区图标与菜单；
- ``app``      把上面拼起来，是唯一知道全部模块的类。
"""

__all__ = ["paths", "settings", "daemon", "server", "tray", "app"]

import sys as _sys

PRODUCT_NAME = "AIDriven NetDefense"
PRODUCT_NAME_CN = "网域智防"
AUTHOR = "PT-dove"

#: 读不到自身 PE 版本资源时用的兜底值（只在开发态或资源损坏时出现）。
SHELL_VERSION_FALLBACK = "0.0.0-dev"


def _version_from_own_resource() -> str | None:
    """从**自己这个 exe** 的版本资源取 `FileVersion` 字符串。

    为什么不在源码里写死版本号：写死了就必然和 `assets/version_info.txt` 各漂各的
    （rc.3 的安装包里显示 rc.1 就是这么来的）。构建时 `build.py --version` 把版本
    烙进 PE 资源，运行时读回来，就只有一个真相源。

    只在**冻结后**读：开发态 `sys.executable` 是 python.exe，读出来的是 Python 的版本。
    """

    if not getattr(_sys, "frozen", False):  # 开发态：没有自己的资源可读
        return None
    try:
        import ctypes
        from ctypes import wintypes

        path = _sys.executable
        version_dll = ctypes.WinDLL("version")
        version_dll.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
        version_dll.GetFileVersionInfoSizeW.restype = wintypes.DWORD
        version_dll.GetFileVersionInfoW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        ]
        version_dll.GetFileVersionInfoW.restype = wintypes.BOOL
        version_dll.VerQueryValueW.argtypes = [
            ctypes.c_void_p, wintypes.LPCWSTR,
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT),
        ]
        version_dll.VerQueryValueW.restype = wintypes.BOOL

        ignored = wintypes.DWORD()
        size = version_dll.GetFileVersionInfoSizeW(path, ctypes.byref(ignored))
        if not size:
            return None
        buffer = ctypes.create_string_buffer(size)
        if not version_dll.GetFileVersionInfoW(path, 0, size, buffer):
            return None

        pointer = ctypes.c_void_p()
        length = wintypes.UINT()
        # 0x0804 = zh-CN，0x0409 = en-US；模板写的是 080404b0，两种都试一次更稳。
        for translation in ("080404b0", "040904b0"):
            if version_dll.VerQueryValueW(
                buffer, f"\\StringFileInfo\\{translation}\\FileVersion",
                ctypes.byref(pointer), ctypes.byref(length),
            ) and pointer.value and length.value:
                text = ctypes.wstring_at(pointer.value, length.value).strip().rstrip("\x00")
                if text:
                    return text
        return None
    except Exception:  # noqa: BLE001 —— 版本号不该让壳起不来
        return None


SHELL_VERSION = _version_from_own_resource() or SHELL_VERSION_FALLBACK

