"""Registry work: uninstall entry, autostart value, and "is it already installed?".

Only two locations are ever touched:

* ``...\\CurrentVersion\\Uninstall\\AIDrivenNetDefense`` — so the product appears in
  Apps & features and can be removed from there.  HKLM when elevated, HKCU when not;
  writing HKLM without rights fails silently in some shells, which is why the
  prototype learned to fall back.
* ``HKCU\\...\\Run\\AIDrivenNetDefense`` — the optional autostart entry, off by
  default.  Nothing here starts by itself unless the user ticked the box.  It is one
  global value per user profile, so every write and delete is scoped to the install tree
  that owns it (see the ``autostart`` section below).

No other key is created, read or deleted; in particular the installer never writes
``HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run`` (machine-wide autostart
for a per-user application is a policy decision this installer does not take).

Author: PT-dove
"""

from __future__ import annotations

import os
import re
import winreg
from pathlib import Path

from . import constants


def _uninstall_roots() -> list[tuple[int, str]]:
    """``(hive, subkey)`` pairs to probe, machine-wide first."""

    pairs: list[tuple[int, str]] = []
    for subkey in constants.UNINSTALL_REG_SUBKEYS:
        pairs.append((winreg.HKEY_LOCAL_MACHINE, subkey))
    pairs.append((winreg.HKEY_CURRENT_USER, constants.UNINSTALL_REG_SUBKEYS[0]))
    return pairs


def read_uninstall_entry() -> dict[str, str] | None:
    """The existing install record from the registry, if any."""

    for hive, subkey in _uninstall_roots():
        path = f"{subkey}\\{constants.REG_KEY_NAME}"
        try:
            with winreg.OpenKey(hive, path) as key:
                values = {}
                for name in ("DisplayName", "DisplayVersion", "InstallLocation", "Publisher"):
                    try:
                        values[name] = str(winreg.QueryValueEx(key, name)[0])
                    except FileNotFoundError:
                        values[name] = ""
                if values.get("InstallLocation"):
                    return values
        except FileNotFoundError:
            continue
        except OSError:
            continue
    return None


def write_uninstall_entry(target: Path, version: str, uninstall_command: str, quiet_command: str) -> str:
    """Create or refresh the uninstall key.  Returns ``"HKLM"`` or ``"HKCU"``."""

    hive_kind, hive = _pick_writable_hive()
    # Both hives use the same relative path; only the root differs (WOW6432Node is
    # a read-side alias, never written by this installer).
    subkey = constants.UNINSTALL_REG_SUBKEYS[0]
    path = f"{subkey}\\{constants.REG_KEY_NAME}"
    with winreg.CreateKeyEx(hive, path, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, constants.PRODUCT_NAME)
        winreg.SetValueEx(key, "DisplayVersion", 0, winreg.REG_SZ, version)
        winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, str(target))
        winreg.SetValueEx(key, "Publisher", 0, winreg.REG_SZ, constants.COMPANY)
        winreg.SetValueEx(key, "UninstallString", 0, winreg.REG_SZ, uninstall_command)
        winreg.SetValueEx(key, "QuietUninstallString", 0, winreg.REG_SZ, quiet_command)
        winreg.SetValueEx(key, "DisplayIcon", 0, winreg.REG_SZ, str(target / "AIDrivenNetDefense.exe"))
        winreg.SetValueEx(key, "NoModify", 0, winreg.REG_DWORD, 1)
        winreg.SetValueEx(key, "NoRepair", 0, winreg.REG_DWORD, 1)
    return hive_kind


def remove_uninstall_entry() -> int:
    """Delete the key from every hive it might live in.  Returns how many were removed."""

    removed = 0
    for hive, subkey in _uninstall_roots():
        path = f"{subkey}\\{constants.REG_KEY_NAME}"
        try:
            winreg.DeleteKey(hive, path)
            removed += 1
        except FileNotFoundError:
            continue
        except OSError:
            # A key with values that cannot be deleted is a real failure; report it
            # by counting nothing and letting the caller log the discrepancy.
            continue
    return removed


def _pick_writable_hive() -> tuple[str, int]:
    """HKLM when elevated, HKCU otherwise.

    Probing by *opening* HKLM for writing is what decides it — checking admin rights
    alone is wrong under UAC filtering where the token is elevated but the key ACL
    still refuses.
    """

    subkey = f"{constants.UNINSTALL_REG_SUBKEYS[0]}\\{constants.REG_KEY_NAME}"
    try:
        with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, subkey, 0, winreg.KEY_SET_VALUE):
            return "HKLM", winreg.HKEY_LOCAL_MACHINE
    except OSError:
        return "HKCU", winreg.HKEY_CURRENT_USER


# ---------------------------------------------------------------- autostart
#
# The Run value is *the user's* setting, not the installer's: exactly one value name is
# global to the profile, so every operation here has to answer "does this belong to the
# tree I am handling?" before it writes or deletes anything.
#
# Two defects this section closes (both measured on a real machine; see
# docs/implementation/evidence/rc5/signoff/runkey/):
#
#   1. an install *without* /AUTOSTART — and an uninstall of *any* directory — used to do
#      a blind `set_autostart(False, "")`, deleting the one global value even when it
#      named another, still-installed tree.  Two installer processes racing (the rc.4
#      acceptance window) therefore erased each other's entry 15 s after it was written,
#      which is the `[FAIL] T4 HKCU Run value written` in the rc.4 transcript.
#      Deletion is now scoped: :func:`remove_autostart_if_ours` only deletes a value whose
#      executable lives inside the tree being installed/uninstalled.
#
#   2. the caller recorded the *requested* state, not the real one.  :func:`set_autostart`
#      now writes and then reads back, and returns what the registry actually contains.
#
# ``user_sid`` selects whose Run key is used.  An elevated installer may be running as a
# *different* administrator than the one who started it (UAC credential prompt); then
# ``HKEY_CURRENT_USER`` is that other account's hive and the person who asked for autostart
# gets nothing.  In that case the caller passes the **interactive** user's SID
# (:func:`interactive_user_sid`) and the value is written under ``HKEY_USERS\<sid>``.
# Non-elevated the two hives are the same key, so the default (``None``) keeps the old
# behaviour byte for byte.

RUN_SUBKEY = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run"

#: Value type/access constants from the Win32 API (kept local so this module imports on
#: non-Windows only far enough to fail loudly in `winreg`'s absence).
_TOKEN_QUERY = 0x0008
_TOKEN_USER = 1
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def _run_target(user_sid: str | None = None) -> tuple[int, str]:
    """``(hive, subkey)`` of the Run key to use for *user_sid* (``None`` = current user)."""

    if user_sid:
        return winreg.HKEY_USERS, f"{user_sid}\\{RUN_SUBKEY}"
    return winreg.HKEY_CURRENT_USER, RUN_SUBKEY


def _token_user_sid(token) -> str | None:
    """SID string of an access token, or ``None``."""

    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.GetTokenInformation.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL

    size = wintypes.DWORD(0)
    advapi32.GetTokenInformation(token, _TOKEN_USER, None, 0, ctypes.byref(size))
    if not size.value:
        return None
    buffer = ctypes.create_string_buffer(size.value)
    if not advapi32.GetTokenInformation(token, _TOKEN_USER, buffer, size.value, ctypes.byref(size)):
        return None
    # TOKEN_USER is { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } } — the first
    # pointer-sized field is the SID.
    sid_pointer = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
    string_sid = wintypes.LPWSTR()
    if not advapi32.ConvertSidToStringSidW(sid_pointer, ctypes.byref(string_sid)):
        return None
    try:
        return string_sid.value
    finally:
        kernel32.LocalFree(string_sid)


def interactive_user_sid() -> str | None:
    """SID of the user who owns the interactive desktop, or ``None``.

    Used only when the installer is elevated: elevating as another administrator account
    leaves this process in that account's ``HKCU``, but the person who clicked install is
    the user whose desktop session must start the product.  The shell window belongs to
    that user, so its process token names the right SID.

    Returns ``None`` when there is no shell window (a service / headless session) or the
    token cannot be read; callers then fall back to the current user's hive.
    """

    import ctypes
    from ctypes import wintypes

    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    except OSError:  # pragma: no cover - non-Windows
        return None

    user32.GetShellWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.OpenProcessToken.restype = wintypes.BOOL

    hwnd = user32.GetShellWindow()
    if not hwnd:
        return None
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return None
    process = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not process:
        return None
    token = wintypes.HANDLE()
    try:
        if not advapi32.OpenProcessToken(process, _TOKEN_QUERY, ctypes.byref(token)):
            return None
        try:
            return _token_user_sid(token)
        finally:
            kernel32.CloseHandle(token)
    finally:
        kernel32.CloseHandle(process)


def autostart_command(user_sid: str | None = None) -> str | None:
    """The raw command currently registered, or ``None`` when the value is absent."""

    hive, subkey = _run_target(user_sid)
    try:
        with winreg.OpenKey(hive, subkey, 0, winreg.KEY_READ) as key:
            value, _kind = winreg.QueryValueEx(key, constants.RUN_VALUE_NAME)
            return str(value)
    except FileNotFoundError:
        return None
    except OSError:
        return None


def autostart_enabled(user_sid: str | None = None) -> bool:
    """Is *any* command registered for this product?  (Read-only.)"""

    return bool(autostart_command(user_sid))


def _candidate_paths(command: str) -> list[str]:
    """Absolute paths named in an autostart command line, quotes removed.

    Handles both shapes this installer produces: ``"<root>\\AIDrivenNetDefense.exe"`` and
    ``"<comspec>" /c ""<root>\\launch\\aegis-console.cmd""``.
    """

    found = [match.group(1) for match in re.finditer(r'"([^"]+)"', command)]
    for token in re.split(r"\s+", command):
        token = token.strip('"')
        if re.match(r"^[A-Za-z]:[\\/]", token):
            found.append(token)
    return found


def command_points_into(command: str | None, root: Path) -> bool:
    """Does *command* launch something inside *root*?

    This is the whole authorisation for touching a value that may belong to another
    installation: only a value whose executable lives in the tree being installed or
    removed is ours to overwrite or delete.
    """

    if not command:
        return False
    try:
        base = os.path.normcase(os.path.normpath(str(root)))
    except (OSError, ValueError):
        return False
    for candidate in _candidate_paths(command):
        try:
            normalised = os.path.normcase(os.path.normpath(candidate))
        except (OSError, ValueError):
            continue
        if normalised == base or normalised.startswith(base + os.sep):
            return True
    return False


def autostart_points_into(root: Path, user_sid: str | None = None) -> bool:
    """Is the value currently registered one of *root*'s entry points?"""

    return command_points_into(autostart_command(user_sid), root)


def set_autostart(enabled: bool, command: str, user_sid: str | None = None) -> bool:
    """Register (or clear) the autostart value and return the state read back.

    The return value is what the registry contains **after** the write, never what was
    asked for: the install record has to be evidence, not an intention.  A failed write
    raises ``OSError`` (the caller records the state it can still read and reports it).
    """

    hive, subkey = _run_target(user_sid)
    if enabled:
        if not command or not command.strip():
            raise ValueError("autostart command must not be empty")
        with winreg.CreateKeyEx(hive, subkey, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, constants.RUN_VALUE_NAME, 0, winreg.REG_SZ, command)
        actual = autostart_command(user_sid)
        return actual is not None and actual == command
    try:
        with winreg.OpenKey(hive, subkey, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, constants.RUN_VALUE_NAME)
    except FileNotFoundError:
        pass
    return autostart_command(user_sid) is None


def remove_autostart_if_ours(root: Path, user_sid: str | None = None) -> str:
    """Delete the autostart value **only if it launches something inside *root***.

    Returns ``"absent"`` (nothing registered), ``"removed"``, or ``"kept"`` (the value
    belongs to a different tree — dropping it would silently disable an autostart entry
    the user still wants).
    """

    current = autostart_command(user_sid)
    if current is None:
        return "absent"
    if not command_points_into(current, root):
        return "kept"
    hive, subkey = _run_target(user_sid)
    try:
        with winreg.OpenKey(hive, subkey, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, constants.RUN_VALUE_NAME)
    except FileNotFoundError:
        return "absent"
    return "removed"

