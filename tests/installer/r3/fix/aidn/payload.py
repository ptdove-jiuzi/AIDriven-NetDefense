"""Open the embedded payload archive and find the program to launch.

The executable is one file: ``payload.7z`` is appended as a PyInstaller data file and
lands in ``sys._MEIPASS`` at run time.  Nothing is downloaded, and no 7-Zip
installation is required on the target machine (``py7zr`` ships inside the exe).

Two rules the rest of the installer depends on:

1. The archive is unpacked to a **fresh** directory outside the target, never
   straight into it.  Extraction failures must not leave the install directory in
   a state that looks like a successful install.
2. The entry point is *resolved*, not assumed.  A payload built without the desktop
   shell still has console/daemon launchers, and an installer that refused to
   install it would be refusing our own release output.

Author: PT-dove
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from . import constants, paths


class PayloadError(Exception):
    """The payload is missing, unreadable, or does not contain an entry point."""


def archive_path() -> Path:
    """Location of ``payload.7z``: bundled next to the frozen modules, or in the source tree."""

    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        candidate = Path(bundle_dir) / constants.PAYLOAD_ARCHIVE
        if candidate.is_file():
            return candidate
        raise PayloadError(
            f"内置载荷缺失：{constants.PAYLOAD_ARCHIVE}。" "安装包可能未完整下载。/ Embedded payload missing."
        )
    # Running from source: allow a payload next to this file for local testing.
    local = Path(__file__).resolve().parent.parent / constants.PAYLOAD_ARCHIVE
    if local.is_file():
        return local
    raise PayloadError(
        f"内置载荷缺失：{constants.PAYLOAD_ARCHIVE}。请使用打包后的 Setup.exe。"
        " / No embedded payload; run the packaged executable."
    )


def describe(archive: Path) -> dict[str, object]:
    """Size of the archive and of what it unpacks to.

    The uncompressed figure is what the free-space check needs before extraction, and
    it comes from the archive header rather than from a guess, so a payload that grows
    (a new runtime, a bigger console) cannot outrun the check.
    """

    info: dict[str, object] = {"path": str(archive), "bytes": archive.stat().st_size}
    try:
        import py7zr

        with py7zr.SevenZipFile(archive, mode="r") as handle:
            info["uncompressedBytes"] = int(handle.archiveinfo().uncompressed or 0)
    except Exception:  # a header we cannot read is reported by extract() with context
        info["uncompressedBytes"] = 0
    return info


def extract(archive: Path, destination: Path, log) -> Path:
    """Unpack *archive* into *destination* (created if needed) and return it."""

    try:
        import py7zr
    except ImportError as error:  # pragma: no cover - packaging fault, not a user fault
        raise PayloadError(
            "安装包缺少解压组件（py7zr）。请重新下载。 / The executable was built without its extractor."
        ) from error

    if destination.exists():
        shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)

    log.step("正在解压程序文件（请稍候）… / Unpacking program files…")
    try:
        with py7zr.SevenZipFile(archive, mode="r") as archive_file:
            archive_file.extractall(path=str(destination))
    except Exception as error:  # py7zr raises several unrelated types
        raise PayloadError(
            f"解压失败：{error} / Failed to unpack the payload."
        ) from error

    if not (destination / "bundle.json").is_file():
        raise PayloadError(
            "解压后的载荷缺少 bundle.json，安装包可能损坏。 / Unpacked payload has no bundle.json."
        )
    return destination


def payload_facts(root: Path) -> dict[str, object]:
    """Identity fields copied into ``install.json`` for support and upgrades."""

    import json

    facts: dict[str, object] = {"payloadKind": None, "payloadBuiltAt": None, "payloadSchema": None}
    try:
        record = json.loads((root / "bundle.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return facts
    if isinstance(record, dict):
        facts["payloadKind"] = record.get("kind")
        facts["payloadBuiltAt"] = record.get("builtAt")
        facts["payloadSchema"] = record.get("schemaVersion")
    return facts


def resolve_entry(root: Path) -> tuple[str, str] | None:
    """``(relative_path, kind)`` of the first launchable candidate, or ``None``."""

    for relative, kind in constants.ENTRY_CANDIDATES:
        if (root / relative).is_file():
            return relative, kind
    return None


def declared_desktop(root: Path) -> dict | None:
    """The desktop shell the payload itself declares, or ``None``.

    A payload built with the ``desktop`` bundle profile records it under
    ``bundle.json.assets.desktop``: the path it was staged at, its byte count and its
    digest. That record is what makes "this payload is supposed to install a tray
    program" checkable, instead of inferred from which candidate happened to exist.
    """

    try:
        record = json.loads((root / "bundle.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    assets = record.get("assets")
    if not isinstance(assets, dict):
        return None
    desktop = assets.get("desktop")
    if not isinstance(desktop, dict) or not isinstance(desktop.get("target"), str):
        return None
    return desktop


def missing_desktop_reason(root: Path) -> str | None:
    """Why the declared shell is not installable, or ``None`` when everything checks out.

    Returning a reason rather than a bool is deliberate: the caller turns it into the
    message a user sees, and "the payload says app\\X.exe but that file is not there"
    is the difference between a five-second fix and a support thread.

    A payload that declares no desktop shell returns ``None``: the v13-shaped payloads
    are installable on purpose (they degrade to the console launcher), and turning that
    into a refusal would reject our own earlier release output.
    """

    desktop = declared_desktop(root)
    if desktop is None:
        return None
    relative = str(desktop["target"])
    path = root / relative.replace("/", "\\")
    if not path.is_file():
        return (
            f"载荷声明了桌面程序 {relative}，但安装包里没有这个文件，已中止安装。"
            f" / The payload declares the desktop entry {relative}, which is missing; "
            "installation aborted instead of falling back to a console launcher."
        )
    if path.stat().st_size == 0:
        return f"载荷里的桌面程序 {relative} 是空文件，已中止安装。 / The declared desktop entry is empty."
    declared = desktop.get("sha256")
    if isinstance(declared, str) and len(declared) == 64:
        actual = _sha256(path)
        if actual != declared:
            return (
                f"载荷里的桌面程序 {relative} 与清单不一致（{actual[:12]}… != {declared[:12]}…），已中止安装。"
                " / The desktop entry does not match the payload manifest."
            )
    return None


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def cleanup(directory: Path, log) -> None:
    """Remove the extraction tree; a leftover copy is both confusing and a disk hog."""

    if not directory.exists():
        return
    for _attempt in range(3):
        shutil.rmtree(directory, ignore_errors=True)
        if not directory.exists():
            return
        # Antivirus and the just-copied files can hold handles for a moment.
        import time

        time.sleep(0.4)
    log.write(f"WARN could not remove extraction directory: {directory}")


def require_free_space(target: Path, needed_bytes: int) -> str | None:
    """Refuse early when the target volume cannot hold the unpacked payload."""

    probe = target
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        free = shutil.disk_usage(probe).free
    except OSError:
        return None
    if free < needed_bytes:
        return (
            f"磁盘空间不足：需要 {needed_bytes // (1024 * 1024)} MiB，可用 {free // (1024 * 1024)} MiB。"
            " / Not enough free space on the target volume."
        )
    return None
