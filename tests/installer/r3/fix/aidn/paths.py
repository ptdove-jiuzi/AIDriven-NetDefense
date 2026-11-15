"""Where things go on disk.

Every path is computed from environment variables and shell folders, never from a
hard-coded drive letter: the same exe has to work for a user whose system drive is
``C:``, whose profile is redirected to a network share, and whose Start Menu lives
in a different language folder.

The four environment overrides below exist so the acceptance harness can redirect
each location at a temporary directory instead of polluting the machine that runs
it.  They are documented and unset in normal use.

Author: PT-dove
"""

from __future__ import annotations

import datetime
import os
import tempfile
import uuid
from pathlib import Path

from . import constants

#: Test seams.  Prefixed rather than short-named so they cannot collide with a
#: real user variable.
ENV_DEFAULT_DIR = "AIDN_SETUP_DEFAULT_DIR"
ENV_STARTMENU_DIR = "AIDN_SETUP_STARTMENU_DIR"
ENV_DESKTOP_DIR = "AIDN_SETUP_DESKTOP_DIR"
ENV_PROGRAMDATA = "AIDN_SETUP_PROGRAMDATA_DIR"


def program_files() -> Path:
    """``%ProgramFiles%``; the installer's default root on 64-bit Windows."""

    value = os.environ.get("ProgramFiles")
    if value:
        return Path(value)
    return Path(os.environ.get("SystemDrive", "C:") + "\\Program Files")


def default_target() -> Path:
    override = os.environ.get(ENV_DEFAULT_DIR)
    if override:
        return Path(override)
    return program_files() / constants.PRODUCT_NAME


def start_menu_folder() -> Path:
    """``<Start Menu>\\Programs\\AIDriven NetDefense``."""

    override = os.environ.get(ENV_STARTMENU_DIR)
    if override:
        return Path(override)
    program_data = os.environ.get(ENV_PROGRAMDATA) or os.environ.get("ProgramData")
    if not program_data:
        program_data = os.environ.get("SystemDrive", "C:") + "\\ProgramData"
    return Path(program_data) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / constants.PRODUCT_NAME


def desktop_folder() -> Path:
    override = os.environ.get(ENV_DESKTOP_DIR)
    if override:
        return Path(override)
    # The shell API follows folder redirection; the plain %USERPROFILE%\Desktop
    # does not, and would drop shortcuts somewhere the user never looks.
    try:
        import ctypes
        from ctypes import wintypes

        buffer = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        # CSIDL_DESKTOPDIRECTORY = 0x0010
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x0010, None, 0, buffer) == 0:
            if buffer.value:
                return Path(buffer.value)
    except (AttributeError, OSError):
        pass
    return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"


def log_path() -> Path:
    """One log file per run, in the user's temp directory."""

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    return Path(tempfile.gettempdir()) / f"AIDriven-Setup-{stamp}.log"


def extraction_root() -> Path:
    """Unique directory the payload is unpacked into.

    Unique per run and per user: two installers started at once must not share an
    extraction tree, because the second one would delete the first one's files
    while it is still copying them.
    """

    token = uuid.uuid4().hex[:12]
    return Path(tempfile.gettempdir()) / f"aidn-setup-{os.getpid()}-{token}"


def normalise(value: str) -> Path:
    """Absolute path without a trailing separator, resolved lexically.

    Deliberately not ``Path.resolve()``: resolving follows junctions, and a target
    that is a junction into Program Files must be reported as the path the user
    typed, not as its target.
    """

    return Path(os.path.abspath(value.rstrip("\\/") or value))


def validate_target(value: str) -> str | None:
    """Return a user-facing reason the target is unusable, or ``None``.

    Checks, in order of how confusing they are to hit late:
      * empty / whitespace,
      * syntax the OS rejects,
      * a drive root (``D:``): uninstall would have to delete the whole drive,
      * anywhere under ``%SystemRoot%``: deleting a program there breaks Windows,
      * too long: the bundled runtime and Node's path handling start failing.
    """

    if not value or not value.strip():
        return "安装路径不能为空。 / The install path cannot be empty."

    # A bare drive ("D:") means "the current directory on D:" to the Windows path
    # APIs, so without this check the installer would silently target whatever
    # directory the user happened to be in.  Reject it before normalising.
    import re

    if re.fullmatch(r"[A-Za-z]:[\\/]*", value.strip()):
        return "不能直接安装到盘符根目录。 / Refusing to install into a drive root."

    try:
        full = normalise(value.strip())
    except (OSError, ValueError):
        return "安装路径格式不合法。 / The install path is not a valid path."

    anchor = Path(full.anchor) if full.anchor else None
    if anchor is not None and str(full).lower() == str(anchor).lower():
        return "不能直接安装到盘符根目录。 / Refusing to install into a drive root."

    system_root = os.environ.get("SystemRoot", "C:\\Windows")
    try:
        full.relative_to(normalise(system_root))
        return "不能安装到 Windows 目录内。 / Refusing to install inside the Windows directory."
    except ValueError:
        pass

    if len(str(full)) > constants.MAX_TARGET_PATH:
        return (
            f"路径过长（{len(str(full))} > {constants.MAX_TARGET_PATH} 字符），请换一个更短的目录。"
            " / Path too long, choose a shorter directory."
        )
    return None


def is_admin() -> bool:
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False
