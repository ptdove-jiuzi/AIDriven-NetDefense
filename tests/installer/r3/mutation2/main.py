"""Entry point of the AIDriven NetDefense installer.

Two modes, one binary:

* no arguments — the window (double-click);
* ``/S`` or ``/uninstall`` — silent, for automation and for the uninstall entry that
  Windows stores in the registry.

Arguments mirror ``deploy/windows/installer/Setup.cmd`` exactly (``/DIR=``, ``/NOREG``,
``/NOSHORTCUT``, ``/AUTOSTART``, ``/KEEPDATA``), and the long ``--`` spellings are
accepted because a Python tool being called from a shell should not require the
slash convention.  Unknown arguments are a usage error, not something to ignore:
a typo in ``/DIR`` must not silently install into ``%ProgramFiles%``.

Exit codes are in ``aidn/constants.py``; automation asserts on them.

Author: PT-dove
"""

from __future__ import annotations

import datetime
import os
import sys
import tempfile
from pathlib import Path

# Allow `python main.py` from the source tree without installing the package.
if __package__ in (None, ""):  # pragma: no cover - exercised by the dev workflow
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from aidn import constants, install, logs, paths, selfinfo  # noqa: E402

USAGE = """AIDriven NetDefense Setup

  Setup.exe                          install (window)
  Setup.exe /S [/DIR=<path>]         install silently
            [/NOREG] [/NOSHORTCUT] [/AUTOSTART] [/KEEPDATA]
  Setup.exe /uninstall [/DIR=<path>] remove; /KEEPDATA keeps data\\ and install\\
  Setup.exe /help

  --silent, --uninstall, --dir=<path>, --no-registry, --no-shortcuts,
  --autostart, --keep-data are accepted as synonyms.
"""


class Args:
    def __init__(self) -> None:
        self.silent = False
        self.uninstall = False
        self.help = False
        self.target: str | None = None
        self.write_registry = True
        self.create_shortcuts = True
        self.autostart = False
        self.keep_data = False


def parse(argv: list[str]) -> Args:
    args = Args()
    for raw in argv:
        item = raw.strip()
        lowered = item.lower()
        if lowered in ("/s", "--silent", "-s"):
            args.silent = True
        elif lowered in ("/uninstall", "--uninstall"):
            args.uninstall = True
        elif lowered in ("/noreg", "--no-registry"):
            args.write_registry = False
        elif lowered in ("/noshortcut", "--no-shortcuts"):
            args.create_shortcuts = False
        elif lowered in ("/autostart", "--autostart"):
            args.autostart = True
        elif lowered in ("/keepdata", "--keep-data"):
            args.keep_data = True
        elif lowered in ("/?", "/help", "--help", "-h"):
            args.help = True
        elif lowered.startswith("/dir=") or lowered.startswith("--dir="):
            value = item.split("=", 1)[1].strip().strip('"')
            if not value:
                raise ValueError("空路径：/DIR= 后面必须给一个目录。/ /DIR= needs a path.")
            args.target = value
        else:
            raise ValueError(f"未知参数 / unknown argument: {raw}")
    return args


def _enable_dpi_awareness() -> None:
    """Crisp text on scaled displays; harmless when the API is unavailable."""

    try:
        import ctypes

        # PROCESS_PER_MONITOR_DPI_AWARE = 2 (Shcore), fall back to system-aware.
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except (AttributeError, OSError):
            ctypes.windll.user32.SetProcessDPIAware()
    except (AttributeError, OSError):
        pass


#: argv tokens that mean "no human is watching".  A message box in this situation is not a
#: message, it is a hang: the 0.0.1-rc.3 acceptance run that hit ``/S`` with a malformed
#: argument sat on a modal MessageBox for **293 seconds** until somebody closed it.  The
#: decision therefore has to be made from the raw argv, before (and even without) a
#: successful ``parse()``.
_SILENT_TOKENS = ("/s", "/silent", "--silent", "-s", "/uninstall", "--uninstall")


def _wants_silent(argv: list[str]) -> bool:
    """True when the command line itself says "automation is driving this"."""

    return any(item.strip().lower() in _SILENT_TOKENS for item in argv)


def _usage_fallback_log() -> Path:
    return Path(tempfile.gettempdir()) / "AIDriven-Setup-usage-error.log"


def _emit(text: str, *, silent: bool = False) -> None:
    """Write to the console when there is one, otherwise show a message box.

    A ``--noconsole`` build has ``sys.stdout is None``: ``print()`` raises, and an
    installer that dies while explaining its own usage is the worst possible reply to
    ``/help``.  When there is no console the text goes to a message box instead of
    being silently dropped — **except** in silent mode (``/S``, ``/uninstall``), where a
    modal dialog blocks the automation that asked for no UI.  In that case the text is
    appended to ``%TEMP%\\AIDriven-Setup-usage-error.log`` and the process exits with its
    own code immediately.
    """

    if sys.stdout is not None:
        print(text)
        return
    if silent:
        # No console and no human: persist the text where automation can read it instead
        # of blocking on a dialog.  The file is named for the case it was created for (an
        # unusable command line) but also carries any other console-less silent message,
        # e.g. the administrator-rights refusal.
        try:
            with _usage_fallback_log().open("a", encoding="utf-8", newline="\n") as handle:
                stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                handle.write(f"{stamp}  {text}\n")
        except OSError:
            pass
        return
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, f"{constants.PRODUCT_NAME} Setup", 0x40)
    except (AttributeError, OSError):
        pass


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    silent_intent = _wants_silent(argv)
    try:
        args = parse(argv)
    except ValueError as error:
        _emit(f"{error}\n\n{USAGE}", silent=silent_intent)
        return constants.EXIT_BAD_USAGE

    if args.help:
        _emit(USAGE, silent=silent_intent)
        return constants.EXIT_OK

    log = logs.Logger(paths.log_path())
    try:
        log.write(f"start: {selfinfo.product_version()} argv={argv}")
        try:
            if args.silent or args.uninstall:
                return _run_silent(args, log)
            _enable_dpi_awareness()
            from aidn import ui

            return ui.run_window(log)
        except Exception as error:
            # Last line of defence.  A windowed executable has no console, so an
            # escaping traceback used to leave the process alive with nothing on
            # screen and nothing but a pipe write to explain itself.  Every failure
            # becomes a log line, a visible message and a non-zero exit code.
            log.error(f"{type(error).__name__}: {error}")
            _emit(
                f"安装未完成 / installation did not complete:\n\n{error}\n\n日志 / log: {log.path}",
                silent=args.silent or args.uninstall,
            )
            return constants.EXIT_ERROR
    finally:
        log.close()


# ---------------------------------------------------------------- elevation gate
#: Environment roots whose children only an elevated token can create.  ``%ProgramFiles%``
#: is the default target, so the most common failure is an ordinary (UAC-filtered) shell
#: being asked to install into the default folder.  That used to unpack the ~450 MiB
#: payload first and die with ``[WinError 5]`` five minutes later; this gate refuses in
#: milliseconds, before the archive is opened, and says what to do instead.
_PROTECTED_ENV_ROOTS = ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "SystemRoot")


def _protected_root(target: Path) -> str | None:
    """The protected root *target* sits under, or ``None`` when it is user-writable."""

    for name in _PROTECTED_ENV_ROOTS:
        root = os.environ.get(name)
        if not root:
            continue
        try:
            target.relative_to(paths.normalise(root))
        except ValueError:
            continue
        return f"%{name}%"
    # A directory directly under a drive root (``C:\Something``) is volume-ACL protected
    # too: "just under C:" is never a per-user location.
    if target.anchor and target.parent == Path(target.anchor):
        return target.anchor
    return None


def _elevation_refusal(target: Path, log, *, uninstall: bool) -> str | None:
    """Bilingual refusal when *target* needs an elevated token that this process lacks.

    Returns ``None`` when the target is fine or the process already is elevated, so the
    caller can keep the two cases apart: "not elevated" is a user-fixable precondition,
    not a payload or disk failure, and it must not be reported as one.
    """

    root = _protected_root(target)
    if root is None:
        return None
    if paths.is_admin():
        log.write(f"elevation: target is under {root}; this process is elevated — continuing")
        return None
    verb = "卸载 / uninstall" if uninstall else "安装 / install"
    english_verb = "uninstall" if uninstall else "install"
    return (
        f"需要管理员权限才能{verb}：{target}\n"
        f"该位置在受保护目录（{root}）下，而当前进程没有提权。因此这里既没有解压载荷、"
        f"也没有写入任何文件就停止了。\n"
        f"请用管理员身份重新运行：右键安装程序 →「以管理员身份运行」，或使用随包提供的"
        f"提权启动文件（deploy\\windows\\installer\\elevate-install.cmd）。\n"
        f"---\n"
        f"Administrator rights are required to {english_verb} into {target}:\n"
        f"that location is under the protected root {root} and this process is not elevated, "
        f"so nothing was unpacked and nothing was written.\n"
        f"Re-run as administrator (right-click → Run as administrator) or use the elevated "
        f"launcher shipped with the package."
    )


def _run_silent(args: Args, log) -> int:
    target = args.target
    if not target:
        existing = install.find_existing()
        if existing:
            target = str(existing[0])
        elif not args.uninstall:
            target = str(paths.default_target())
        else:
            log.error("找不到已安装位置，请用 /DIR= 指定安装目录。/ No installation found; pass /DIR=.")
            return constants.EXIT_NOT_INSTALLED

    options = install.Options(
        target=paths.normalise(target),
        desktop_shortcut=args.create_shortcuts,
        create_shortcuts=args.create_shortcuts,
        autostart=args.autostart,
        write_registry=args.write_registry,
        keep_data=args.keep_data,
    )
    # Elevation gate: the very first thing after the target is known, before the payload
    # archive is even opened.  A silent run has no console, so the refusal goes to the log
    # (always) and to stdout when a stream exists; it does *not* raise a modal box, because
    # a `/S` run is driven by automation and a dialog would block it.
    refusal = _elevation_refusal(options.target, log, uninstall=args.uninstall)
    if refusal:
        log.error(refusal)
        _emit(refusal, silent=True)
        return constants.EXIT_NEEDS_ADMIN
    try:
        result = install.uninstall(options, log) if args.uninstall else install.install(options, log)
    except install.EntryError as error:
        log.error(str(error))
        return constants.EXIT_NO_ENTRY
    except install.UninstallRefused as error:
        # 「你指错了目录」不是「载荷坏了」：退出码要能让自动化区分这两件事。
        log.error(str(error))
        return constants.EXIT_TARGET_INVALID
    except install.InstallError as error:
        log.error(str(error))
        return constants.EXIT_PAYLOAD_MISSING if "载荷" in str(error) else constants.EXIT_ERROR
    except OSError as error:
        log.error(f"{error}")
        return constants.EXIT_ERROR
    log.write(result.message)
    for problem in result.shortcut_problems:
        log.write(f"WARN {problem}")
    if sys.stdout is not None:
        print(result.message)
    # X-04 (N-011 §3): an uninstall that left files behind must not exit 0.  The
    # message already says "卸载未完成 / Uninstall incomplete"; the exit code is what
    # automation and the user's "应用和功能" flow actually see.
    if not result.ok:
        log.error(result.message)
        _emit(result.message, silent=args.silent or args.uninstall)
        return constants.EXIT_ERROR
    return constants.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
