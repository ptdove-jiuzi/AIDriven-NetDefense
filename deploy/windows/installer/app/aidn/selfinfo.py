"""Read the version this executable was built with.

Why read it back from the binary instead of generating a Python constant: the
version resource is what Explorer, the uninstall entry and the user all see.  If
the installer quoted a separately generated string, a mistyped build would produce
an exe that claims one version in Properties and writes another into
``install.json``.  Reading the resource makes that impossible by construction.

Falls back to ``constants.DEV_VERSION`` when running from source bytes (no
resource, or running on a non-Windows host).

Author: PT-dove
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

from . import constants


def _resource_strings(path: str) -> dict[str, str]:
    """Return the ``StringFileInfo`` block of *path*'s version resource."""

    version = ctypes.WinDLL("version", use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    version.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    version.GetFileVersionInfoW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
    ]
    version.GetFileVersionInfoW.restype = wintypes.BOOL
    version.VerQueryValueW.argtypes = [
        ctypes.c_void_p,
        wintypes.LPCWSTR,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.UINT),
    ]
    version.VerQueryValueW.restype = wintypes.BOOL

    size = version.GetFileVersionInfoSizeW(wintypes.LPCWSTR(path), None)
    if not size:
        return {}

    buffer = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(wintypes.LPCWSTR(path), 0, size, buffer):
        return {}

    pointer = ctypes.c_void_p()
    length = wintypes.UINT()
    # 0x040904B0 = US English / Unicode; the block shipped by the version resource
    # template used in build_setup.py.  A different table simply yields no strings,
    # and the caller falls back to the development version.
    if not version.VerQueryValueW(
        buffer, "\\StringFileInfo\\040904B0\\ProductVersion", ctypes.byref(pointer), ctypes.byref(length)
    ):
        return {}

    strings: dict[str, str] = {}
    for key in ("FileVersion", "ProductVersion", "ProductName", "CompanyName", "FileDescription"):
        pointer = ctypes.c_void_p()
        length = wintypes.UINT()
        sub = f"\\StringFileInfo\\040904B0\\{key}"
        if version.VerQueryValueW(buffer, sub, ctypes.byref(pointer), ctypes.byref(length)) and pointer.value:
            strings[key] = ctypes.wstring_at(pointer.value, length.value).rstrip("\x00")
    return strings


def product_version() -> str:
    """Version string to record in ``install.json`` and show in the UI."""

    if sys.platform != "win32":
        return constants.DEV_VERSION
    try:
        strings = _resource_strings(sys.executable)
    except OSError:
        return constants.DEV_VERSION
    for key in ("ProductVersion", "FileVersion"):
        value = strings.get(key, "").strip()
        if value and value != "0.0.0.0":
            return value
    return constants.DEV_VERSION
