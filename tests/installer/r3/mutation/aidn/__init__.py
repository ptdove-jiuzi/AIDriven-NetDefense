"""Installer package for AIDriven NetDefense (Windows x64).

Modules, and why they are separate:

* ``constants``  names that must match the PowerShell prototype and the payload
* ``paths``      where files may be written, plus the test seams
* ``logs``       logging that survives a windowed executable
* ``selfinfo``   the version actually embedded in this binary
* ``payload``    opening the embedded 7z and resolving the entry point
* ``procs``      stopping processes that hold the target directory
* ``registry``   uninstall entry and the optional autostart value
* ``shortcuts``  Start Menu / desktop links
* ``install``    the install / upgrade / uninstall transactions
* ``ui``         the window

Author: PT-dove
"""

__all__ = [
    "constants",
    "install",
    "logs",
    "paths",
    "payload",
    "procs",
    "registry",
    "selfinfo",
    "shortcuts",
    "ui",
]
