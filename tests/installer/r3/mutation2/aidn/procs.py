"""Stop the programs that live inside an install directory.

Why this is not just ``taskkill /IM AIDrivenNetDefense.exe``: an installation also
spawns a bundled ``node.exe`` daemon and, on upgrade, the *old* copy of the shell.
Deleting files under a running process leaves the tree half-removed and the process
still serving from memory, which is the state users report as "the installer hung".

The matcher is the executable path, and the match set is closed under "descendant
of a matched process" — the daemon is started by the shell, so its parent chain is
enough.  A daemon started independently (the user double-clicked a launcher inside
the directory) is *not* matched; that limitation is stated in the README rather
than papered over with a command-line scan, which would require reading another
process's PEB.

Children are terminated before their parents, so a supervisor cannot respawn the
daemon while the uninstaller is deleting it.

Author: PT-dove
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import time
from ctypes import wintypes
from pathlib import Path

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
MAX_PATH = 260
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * MAX_PATH),
    ]


def _snapshot() -> list[tuple[int, int, str]]:
    """``(pid, parent_pid, exe_path)`` for every process we are allowed to open."""

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    # Without these, a 64-bit process handle is truncated to 32 bits and every
    # OpenProcess call below fails with an "invalid handle".
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]

    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snapshot or snapshot == wintypes.HANDLE(INVALID_HANDLE_VALUE).value:
        return []

    rows: list[tuple[int, int, str]] = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return []
        while True:
            pid = int(entry.th32ProcessID)
            parent = int(entry.th32ParentProcessID)
            rows.append((pid, parent, _image_path(kernel32, pid)))
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return rows


def _image_path(kernel32, pid: int) -> str:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buffer))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return ""
    finally:
        kernel32.CloseHandle(handle)


def _self_family(rows: list[tuple[int, int, str]]) -> set[int]:
    """PIDs that must never be killed: this process, its ancestors and its descendants.

    Why this exists (DEFECT-self-uninstall, P1): the uninstaller is itself shipped
    *inside* the install tree (``<target>\\installer\\AIDrivenNetDefense-Setup-*.exe``)
    and the registry ``UninstallString`` points at that in-tree copy.  A PyInstaller
    onefile build is two processes whose image is that very file — the bootloader
    parent and the Python child — so matching "image under root" without excluding
    ourselves adds the uninstaller to the kill list and it ``taskkill /F``s itself:
    exit 1, tree intact, nothing removed.  Excluding the family keeps the uninstaller
    alive; the residual locked image is handled by the caller.
    """

    parent_of = {pid: parent for pid, parent, _image in rows}
    me = os.getpid()
    family = {me}

    # Ancestors: a launcher/cmd that started us from the same tree is not a target.
    cursor = me
    guard = 0
    while cursor in parent_of and parent_of[cursor] != cursor and guard < 64:
        cursor = parent_of[cursor]
        family.add(cursor)
        guard += 1

    # Descendants: helpers this process spawned (taskkill children, log writers).
    children: dict[int, list[int]] = {}
    for pid, parent, _image in rows:
        children.setdefault(parent, []).append(pid)
    stack = [me]
    while stack:
        current = stack.pop()
        for child in children.get(current, []):
            if child not in family:
                family.add(child)
                stack.append(child)
    return family


def stop_under(root: Path, log=None) -> int:
    """Terminate every process whose image lives under *root*.  Returns the count."""

    prefix = str(root).rstrip("\\") + "\\"
    try:
        rows = _snapshot()
    except (AttributeError, OSError) as error:
        if log is not None:
            log.write(f"process scan unavailable: {error}")
        return 0

    excluded = _self_family(rows)
    matched: dict[int, str] = {}
    for pid, _parent, image in rows:
        if pid in excluded:
            continue
        if image and image.lower().startswith(prefix.lower()):
            matched[pid] = image
    if not matched:
        return 0

    # Close the set under "descendant of a matched process", until it stops growing.
    children: dict[int, list[int]] = {}
    for pid, parent, _image in rows:
        children.setdefault(parent, []).append(pid)
    queue = list(matched)
    while queue:
        current = queue.pop()
        for child in children.get(current, []):
            if child not in matched:
                matched[child] = ""
                queue.append(child)

    # A process that started *us* from the same tree is an ancestor, not a target;
    # remove the family again in case the descendant closure re-added it.
    matched = {pid: image for pid, image in matched.items() if pid not in excluded}

    # Depth, so children die first.
    parent_of = {pid: parent for pid, parent, _image in rows}
    depth: dict[int, int] = {}

    def depth_of(pid: int, guard: int = 0) -> int:
        if pid in depth:
            return depth[pid]
        if guard > 64 or pid not in parent_of or parent_of[pid] == pid:
            depth[pid] = 0
            return 0
        depth[pid] = 1 + depth_of(parent_of[pid], guard + 1)
        return depth[pid]

    killed = 0
    for pid in sorted(matched, key=lambda item: depth_of(item), reverse=True):
        if _terminate(pid):
            killed += 1
            if log is not None:
                log.write(f"stopped pid={pid} image={matched[pid] or '(child)'}")
    if killed:
        time.sleep(0.6)
    return killed


def _terminate(pid: int) -> bool:
    """``taskkill`` rather than ``TerminateProcess``: it also collects orphans."""

    try:
        result = subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=15,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
