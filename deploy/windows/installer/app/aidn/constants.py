"""Fixed names, paths and limits shared by every part of the installer.

Values mirror ``deploy/windows/installer/Setup.ps1`` (the reference implementation):

* the install layout (``install/install.json``, ``data/``, ``installer/``),
* the uninstall registry key (``AIDrivenNetDefense``) and its value names,
* the desktop entry point resolution order.

They must stay identical, because an installation produced by one entry point has
to be upgradable and removable by the other.  Changing a name here without
changing it there silently splits the two into different products.

Author: PT-dove
"""

from __future__ import annotations

# ---------------------------------------------------------------- product identity
PRODUCT_NAME = "AIDriven NetDefense"
PRODUCT_NAME_ZH = "网域智防"
COMPANY = "PT-dove"

#: Uninstall key name under ``...\\CurrentVersion\\Uninstall``.
REG_KEY_NAME = "AIDrivenNetDefense"
#: ``HKCU\\...\\Run`` value used for the optional autostart entry.
RUN_VALUE_NAME = "AIDrivenNetDefense"

#: Exit codes.  Distinct values matter: the CI smoke test asserts on them.
EXIT_OK = 0
EXIT_ERROR = 1
EXIT_BAD_USAGE = 2
EXIT_PAYLOAD_MISSING = 3
EXIT_NO_ENTRY = 4
EXIT_TARGET_INVALID = 5
EXIT_NOT_INSTALLED = 6
EXIT_NEEDS_ADMIN = 7
EXIT_CANCELLED = 8

# ---------------------------------------------------------------- install layout
#: Directory (inside the install root) holding upgrade bookkeeping.
INSTALL_DIR_NAME = "install"
INSTALL_RECORD_NAME = "install.json"
#: User data.  An upgrade never touches it; an uninstall keeps it on request.
DATA_DIR_NAME = "data"
#: Copy of this installer, so uninstall works after the original download is gone.
INSTALLER_COPY_DIR = "installer"

#: Channels written into ``install.json``.  ``portable`` belongs to the zip, which
#: is adopted later (see DIST-DECISION §3); this installer always writes ``installed``.
CHANNEL_INSTALLED = "installed"
CHANNEL_PORTABLE = "portable"

# ---------------------------------------------------------------- entry resolution
#: The desktop shell ships only when the payload was built with it.  A payload
#: built from ``deploy/embedded-runtime`` alone carries launchers instead, so the
#: order below degrades to the console launcher rather than refusing to install.
#:
#: Every candidate is relative to the install root; the first existing one wins and
#: is recorded in ``install.json`` as ``desktopExe`` (field name kept from the
#: PowerShell prototype so both installers agree on the record).
ENTRY_CANDIDATES: tuple[tuple[str, str], ...] = (
    ("AIDrivenNetDefense.exe", "exe"),
    ("app\\AIDrivenNetDefense.exe", "exe"),
    ("console\\AIDrivenNetDefense.exe", "exe"),
    ("bin\\AIDrivenNetDefense.exe", "exe"),
    ("app\\console\\AIDrivenNetDefense.exe", "exe"),
    ("app\\bin\\AIDrivenNetDefense.exe", "exe"),
    ("launch\\aegis-console.cmd", "cmd"),
    ("start.cmd", "cmd"),
    ("launch\\aegis-daemon.cmd", "cmd"),
)

#: Diagnostic entry point written by the installer (satisfies the worker's
#: per-attempt environment preconditions, same body as the PowerShell prototype).
SELFCHECK_SCRIPT_NAME = "启动-自检.cmd"
#: What that script runs.  Not every payload carries it (v15 does not), so the
#: installer only writes the .cmd when this file is actually there.
SELFCHECK_MJS_NAME = "SelfCheck.mjs"

# ---------------------------------------------------------------- limits
#: Longest accepted target path.  Windows itself allows more with long paths
#: enabled, but the bundled runtime and several Node APIs still misbehave, and a
#: pre-release installer should refuse early instead of half-installing.
MAX_TARGET_PATH = 180

#: Files the installer refuses to delete during an uninstall that keeps data.
KEEP_ON_UNINSTALL = ("install", "data", "dsh-home")

#: Registry locations probed for an existing installation, most specific first.
UNINSTALL_REG_SUBKEYS = (
    "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
)

#: Embedded archive name inside the one-file executable (``sys._MEIPASS``).
PAYLOAD_ARCHIVE = "payload.7z"

#: Product version used when the executable carries no version resource (running
#: from source).  The build stamps the real one; see ``aidn/selfinfo.py``.
DEV_VERSION = "0.0.0-dev"
