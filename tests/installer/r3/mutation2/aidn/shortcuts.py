"""Start Menu and desktop shortcuts.

Shortcuts are created through ``WScript.Shell`` (COM), executed by PowerShell.  The
alternative — talking to ``IShellLink`` with ``ctypes`` — is several hundred lines of
COM plumbing for the same five properties, and pulling in ``pywin32`` would add a
compiled dependency to an installer whose whole point is not needing one.

Shortcut creation is **best effort**: a locked Start Menu (roaming profile, group
policy) must not abort an install that has already copied 450 MiB of files.  Failures
are logged and surfaced in the result, not thrown.

Author: PT-dove
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from . import constants

_LEGACY_NAMES = ("自检",)


def _ps(command: str) -> tuple[int, str]:
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            capture_output=True,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=60,
        )
        return result.returncode, (result.stdout or "") + (result.stderr or "")
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)


def _quote(value: Path | str) -> str:
    """PowerShell single-quoted literal; embedded quotes are doubled."""

    return "'" + str(value).replace("'", "''") + "'"


def create_shortcut(link: Path, target: Path, arguments: str, workdir: Path, description: str) -> str | None:
    """Create one ``.lnk``.  Returns an error string, or ``None`` on success."""

    # Creating the parent directory is the first place a machine-wide Start Menu
    # refuses a non-elevated install (WinError 5). It used to raise straight out of
    # an install that had already copied 450 MiB, turning a cosmetic shortcut into a
    # failed installation — see install_shortcuts for the per-user fallback.
    try:
        link.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return f"cannot create {link.parent}: {error}"
    script = (
        "$ErrorActionPreference='Stop';"
        "$s=New-Object -ComObject WScript.Shell;"
        f"$l=$s.CreateShortcut({_quote(link)});"
        f"$l.TargetPath={_quote(target)};"
        f"$l.Arguments={_quote(arguments)};"
        f"$l.WorkingDirectory={_quote(workdir)};"
        f"$l.Description={_quote(description)};"
        "$l.WindowStyle=1;"
        "$l.Save();"
    )
    code, output = _ps(script)
    if code != 0 or not link.exists():
        return output.strip() or f"shortcut not created: {link}"
    return None


def _launch_spec(root: Path, relative: str, kind: str) -> tuple[Path, str]:
    """Turn a payload entry into ``(target, arguments)`` for a shortcut."""

    entry = root / relative
    if kind == "cmd":
        # A .cmd needs a shell; the shortcut must name cmd.exe explicitly, otherwise
        # Windows opens it in Notepad for some associations.
        comspec = Path(os.environ.get("COMSPEC", "C:\\Windows\\System32\\cmd.exe"))
        return comspec, f'/c ""{entry}""'
    return entry, ""


def install_shortcuts(root: Path, relative: str, kind: str, desktop: bool, log) -> list[str]:
    """Create the start-menu set (program / install dir / diagnostics) and the desktop icon."""

    problems: list[str] = []
    target, arguments = _launch_spec(root, relative, kind)

    # The machine-wide Start Menu needs elevation; a per-user install into e.g.
    # ``C:\AIDN-RC3`` has none, and ``%ProgramData%\\...\\Programs`` then answers
    # ``WinError 5``. Falling back to the current user's Start Menu keeps the entry
    # where the user will actually look, instead of failing the whole install.
    start_menu: Path | None = None
    for candidate in start_menu_candidates():
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            start_menu = candidate
            break
        except OSError as error:
            problems.append(f"{candidate}: {error}")
            log.write(f"WARN start menu not writable, trying the next one: {candidate} :: {error}")

    # The v1 layout left a top-level 「自检.lnk」 behind; drop it so upgrades do not
    # accumulate two entries that mean different things.
    for base in start_menu_candidates():
        for legacy in (base / "自检.lnk",):
            try:
                if legacy.exists():
                    legacy.unlink()
            except OSError:
                pass
    try:
        stale = paths_desktop() / f"{constants.PRODUCT_NAME} 自检.lnk"
        if stale.exists():
            stale.unlink()
    except OSError:
        pass

    jobs = []
    if start_menu is not None:
        jobs.extend([
            (start_menu / f"{constants.PRODUCT_NAME}.lnk", target, arguments, root, constants.PRODUCT_NAME),
            (start_menu / "安装目录.lnk", root, "", root, f"{constants.PRODUCT_NAME} 安装目录"),
        ])
        # 自检快捷方式只在自检脚本真的被写出来时才建：载荷没带 SelfCheck.mjs 时
        # 安装器不会写那个 .cmd（见 install._write_selfcheck），此时再挂一个快捷方式
        # 就是给用户一个点了必然报错的入口。
        selfcheck = root / constants.SELFCHECK_SCRIPT_NAME
        if selfcheck.is_file():
            jobs.append((
                start_menu / "诊断" / "自检.lnk",
                selfcheck,
                "",
                root,
                f"{constants.PRODUCT_NAME} 诊断 / 自检",
            ))
        else:
            log.write("self-check shortcut skipped: the payload carries no SelfCheck.mjs")
    if desktop:
        jobs.append((paths_desktop() / f"{constants.PRODUCT_NAME}.lnk", target, arguments, root, constants.PRODUCT_NAME))

    for link, link_target, link_args, workdir, description in jobs:
        error = create_shortcut(link, link_target, link_args, workdir, description)
        if error:
            problems.append(f"{link.name}: {error}")
            log.write(f"WARN shortcut failed: {link} :: {error}")
    return problems


def start_menu_candidates() -> list[Path]:
    """机器级 Start Menu 优先，其次是当前用户的（非管理员安装时只有后者可写）。"""

    primary = paths_start_menu()
    candidates = [primary]
    appdata = os.environ.get("APPDATA")
    if appdata:
        per_user = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / constants.PRODUCT_NAME
        if per_user != primary:
            candidates.append(per_user)
    return candidates


def remove_shortcuts(log) -> None:
    """Delete the Start Menu folder and every desktop icon any version may have made."""

    # Both candidate folders, not just the one this run would have chosen: an install
    # made with elevation leaves its entry machine-wide, and removing only the user's
    # copy would leave the old shortcut pointing at a deleted executable.
    for start_menu in start_menu_candidates():
        if start_menu.exists():
            _ps(f"Remove-Item -LiteralPath {_quote(start_menu)} -Recurse -Force -ErrorAction SilentlyContinue")

    desktop = paths_desktop()
    for name in (constants.PRODUCT_NAME, constants.PRODUCT_NAME + " 自检", *_LEGACY_NAMES):
        link = desktop / f"{name}.lnk"
        if link.exists():
            try:
                link.unlink()
            except OSError as error:
                log.write(f"WARN could not remove {link}: {error}")


# Imported late: paths imports constants only, but keeping the import inside the
# module body here makes the test seam (environment overrides) take effect after
# the harness has set the variables.
def paths_start_menu() -> Path:
    from . import paths

    return paths.start_menu_folder()


def paths_desktop() -> Path:
    from . import paths

    return paths.desktop_folder()
