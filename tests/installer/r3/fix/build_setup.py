"""Build `AIDrivenNetDefense-Setup-<ver>.exe` from a payload directory.

The payload is a directory produced by ``deploy/embedded-runtime/build.mjs``.  This
script turns it into one executable:

    payload/  --(7z -mx=N)-->  payload.7z  --(PyInstaller --onefile)-->  Setup.exe

Design rules:

1. **The archive is made here, then verified** with ``7z t`` before PyInstaller sees
   it.  A truncated archive would otherwise become an installer that fails only on a
   user's machine, after the download.
2. **Nothing is written inside the payload.**  It is opened read-only; the archive
   lives in a temp directory that is removed unless ``--keep-temp`` is given.
3. **The version comes from ``--version``**, and is stamped into the resource *and*
   the file name from the same value, so the two cannot drift.
4. **No signing, no network.**  See ``docs/implementation/status/RELEASE-PIPELINE.md``
   for why SmartScreen will warn and why that is not worked around.

usage:
  python build_setup.py --payload <dir> --version <ver> --out <dir>
                        [--sevenzip <7z.exe>] [--level 1-9] [--icon <ico>]
                        [--keep-temp] [--no-clean]
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import version_info  # noqa: E402  (local module, path added above)

SEVEN_ZIP_CANDIDATES = (
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
)

EXCLUDES = (
    "PyQt5", "PyQt6", "PySide2", "PySide6", "PySide",
    "gi", "matplotlib", "numpy", "scipy", "pandas",
    "IPython", "pytest", "pip", "wheel", "setuptools",
    # The installer has no browser and no image pipeline; webview/cef only bloat it.
    "webview", "cefpython3",
)

#: py7zr's decoders are compiled extensions loaded by name at decompression time.
HIDDEN_IMPORTS = ("py7zr", "pyppmd", "pyzstd", "pybcj", "inflate64", "multivolumefile", "texttable")


def find_seven_zip(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit)
        if path.is_file():
            return path
        raise SystemExit(f"build_setup: 7-Zip not found at {path}")
    from shutil import which

    for candidate in (which("7z"), which("7za"), *SEVEN_ZIP_CANDIDATES):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise SystemExit(
        "build_setup: 7-Zip 未找到 / not found. Install it or pass --sevenzip <path>. "
        "The runner image ships it at C:\\Program Files\\7-Zip\\7z.exe."
    )


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_payload(payload: Path) -> dict[str, str]:
    """Refuse a payload that the installer would reject at run time, before packing it."""

    if not (payload / "bundle.json").is_file():
        raise SystemExit(f"build_setup: not a payload directory (bundle.json missing): {payload}")
    manifest = payload / "manifests" / "files.sha256"
    if not manifest.is_file():
        raise SystemExit(f"build_setup: payload has no manifests/files.sha256: {payload}")

    import json

    record = json.loads((payload / "bundle.json").read_text(encoding="utf-8"))
    facts = {
        "kind": str(record.get("kind", "")),
        "builtAt": str(record.get("builtAt", "")),
        "schema": str(record.get("schemaVersion", "")),
    }

    # The entry point matters: an executable that installs nothing launchable is a
    # broken download, not a design choice.
    sys.path.insert(0, str(HERE))
    from aidn import payload as payload_module

    entry = payload_module.resolve_entry(payload)
    if entry is None:
        raise SystemExit(
            "build_setup: payload 内没有可启动入口 / no launchable entry point; "
            "refusing to build an installer that installs nothing."
        )
    facts["entry"] = entry[0]

    # The same refusal the installer performs, moved to build time. A payload that
    # declares a desktop shell but does not contain it would install as a console
    # launcher, so it must not become an installer in the first place. This is also
    # what a reviewer can run to prove the negative case without installing anything.
    reason = payload_module.missing_desktop_reason(payload)
    if reason:
        raise SystemExit(f"build_setup: {reason}")
    desktop = payload_module.declared_desktop(payload)
    if desktop is not None:
        facts["desktop"] = str(desktop.get("target"))
    return facts


def make_archive(payload: Path, archive: Path, seven_zip: Path, level: int) -> None:
    """Create the 7z with paths relative to the payload root, then verify it *twice*.

    ``-mf=off`` is explicit for a reason, and it is the second attempt at this problem.
    Left to itself, 7-Zip adds a branch filter to any block whose content looks like
    executable code.  On this payload it chose **ARM64 BCJ** (method id 0x0A) for one
    block, and:
      * ``7z t`` validates the archive happily,
      * the build interpreter's ``py7zr`` also validated it (its ``pybcj`` knew the
        filter),
      * the **frozen** ``py7zr`` inside Setup.exe did not, and died with
        ``UnsupportedCompressionMethodError: Archive is compressed by an unsupported
        compression algorithm`` — on the user's machine, after the download.
    ``-m0=LZMA2`` alone does *not* prevent that: the filter is added on top of the
    chosen method.  ``-mf=off`` does.  ``assert_plain_lzma2`` below then makes the
    property checkable in one line of output instead of being a comment.
    """

    archive.parent.mkdir(parents=True, exist_ok=True)
    if archive.exists():
        archive.unlink()

    command = [
        str(seven_zip), "a", "-t7z", "-m0=LZMA2", "-mf=off", f"-mx={level}", "-ms=on",
        "-bd", "-y", str(archive), ".",
    ]
    started = time.time()
    result = subprocess.run(command, cwd=str(payload), capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"build_setup: 7z failed ({result.returncode})\n{result.stdout}\n{result.stderr}")
    print(f"  archive {archive.name}: {archive.stat().st_size / 1024 / 1024:.1f} MiB in {time.time() - started:.1f}s")

    check = subprocess.run(
        [str(seven_zip), "t", "-bd", str(archive)], capture_output=True, text=True
    )
    if check.returncode != 0:
        raise SystemExit(f"build_setup: archive failed its own integrity test\n{check.stdout}")
    print("  archive integrity (7z t): OK")

    assert_plain_lzma2(archive, seven_zip)
    verify_with_py7zr(archive)


def assert_plain_lzma2(archive: Path, seven_zip: Path) -> None:
    """Refuse an archive that carries a branch/delta filter.

    The decoder shipped in the installer is only expected to handle plain LZMA2; a
    filter that "works on this machine" is exactly the kind of difference that turns
    into a support ticket.  Failing here costs one build; failing later costs a release.
    """

    listing = subprocess.run(
        [str(seven_zip), "l", "-slt", str(archive)], capture_output=True, text=True
    )
    if listing.returncode != 0:
        raise SystemExit(f"build_setup: cannot list the archive\n{listing.stderr}")
    methods = sorted({line.split("=", 1)[1].strip() for line in listing.stdout.splitlines() if line.startswith("Method =")})
    methods = [method for method in methods if method]
    print(f"  archive methods: {', '.join(methods) or '(none)'}")
    banned = [method for method in methods if "BCJ" in method.upper() or "DELTA" in method.upper()]
    if banned:
        raise SystemExit(
            "build_setup: archive carries a filter the installer's decoder is not relied on to support: "
            + ", ".join(banned)
            + "\n  the payload must be plain LZMA2 (-mf=off)."
        )


def verify_with_py7zr(archive: Path) -> None:
    """Prove the *installer's* decoder can open the archive before it is embedded."""

    try:
        import py7zr
    except ImportError as error:  # pragma: no cover - build environment fault
        raise SystemExit("build_setup: py7zr is not installed, cannot verify the payload archive") from error

    try:
        with py7zr.SevenZipFile(archive, mode="r") as handle:
            names = handle.getnames()
            if not names:
                raise SystemExit("build_setup: archive has no entries")
            info = handle.archiveinfo()
            # `test()` walks every coder; a compression method the decoder cannot
            # handle fails here instead of on a user's machine.
            handle.test()
    except SystemExit:
        raise
    except Exception as error:
        raise SystemExit(
            "build_setup: the archive cannot be read by py7zr (the decoder inside Setup.exe): "
            f"{error}\n  entries={len(names) if 'names' in dir() else '?'}"
        ) from error
    print(f"  archive decoder check (py7zr): OK, {len(names)} entries, {info.uncompressed} bytes uncompressed")


def build(payload: Path, version: str, out_dir: Path, seven_zip: Path, level: int,
          icon: Path | None, keep_temp: bool, clean: bool) -> Path:
    facts = validate_payload(payload)
    print(f"payload: {payload}")
    print(f"  kind={facts['kind']} builtAt={facts['builtAt']} entry={facts['entry']}"
          + (f" desktop={facts['desktop']}" if 'desktop' in facts else " desktop=(none declared)"))

    name = f"AIDrivenNetDefense-Setup-{version}"
    out_dir.mkdir(parents=True, exist_ok=True)
    temp_root = Path(tempfile.mkdtemp(prefix="aidn-setup-build-"))
    try:
        archive = temp_root / "payload.7z"
        make_archive(payload, archive, seven_zip, level)

        version_file = temp_root / "version_info.txt"
        version_file.write_text(version_info.render(version, internal_name=name), encoding="utf-8")

        command = [
            sys.executable, "-m", "PyInstaller",
            str(HERE / "main.py"),
            "--name", name,
            "--onefile",
            "--noconsole",
            "--noconfirm",
            f"--distpath={out_dir}",
            f"--workpath={temp_root / 'build'}",
            f"--specpath={temp_root / 'spec'}",
            f"--add-data={archive}{os.pathsep}.",
            f"--version-file={version_file}",
            # The `aidn` package lives next to main.py; make the import path explicit
            # instead of relying on PyInstaller inferring it from the script location.
            f"--paths={HERE}",
        ]
        if clean:
            command.append("--clean")
        if icon is not None and icon.is_file():
            command.append(f"--icon={icon}")
        for module in EXCLUDES:
            command.append(f"--exclude-module={module}")
        for module in HIDDEN_IMPORTS:
            command.append(f"--hidden-import={module}")

        print("running PyInstaller…")
        started = time.time()
        result = subprocess.run(command, capture_output=True, text=True, cwd=str(temp_root))
        if result.returncode != 0:
            tail = (result.stdout or "")[-4000:] + (result.stderr or "")[-2000:]
            raise SystemExit(f"build_setup: PyInstaller failed ({result.returncode})\n{tail}")
        print(f"  PyInstaller finished in {time.time() - started:.1f}s")

        produced = out_dir / f"{name}.exe"
        if not produced.is_file():
            raise SystemExit(f"build_setup: expected {produced} was not produced")
        size = produced.stat().st_size
        print(f"setup: {produced}")
        print(f"  bytes {size}")
        print(f"  sha256 {sha256_of(produced)}")
        return produced
    finally:
        if keep_temp:
            print(f"  temp kept: {temp_root}")
        else:
            shutil.rmtree(temp_root, ignore_errors=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the AIDriven NetDefense Windows installer.")
    parser.add_argument("--payload", required=True, help="payload directory (bundle.json inside)")
    parser.add_argument("--version", required=True, help="release version, e.g. 0.0.1-rc.1")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--sevenzip", default=None, help="path to 7z.exe")
    parser.add_argument("--level", type=int, default=5, help="7z compression level (1-9)")
    parser.add_argument("--icon", default=None, help="optional .ico for the executable")
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--no-clean", action="store_true", help="skip PyInstaller --clean")
    args = parser.parse_args(argv)

    if not 1 <= args.level <= 9:
        raise SystemExit("build_setup: --level must be 1-9")

    payload = Path(args.payload).resolve()
    out_dir = Path(args.out).resolve()
    if str(out_dir).lower().startswith(str(payload).lower()):
        raise SystemExit("build_setup: refusing to write the installer inside the payload")

    build(
        payload=payload,
        version=args.version,
        out_dir=out_dir,
        seven_zip=find_seven_zip(args.sevenzip),
        level=args.level,
        icon=Path(args.icon) if args.icon else (HERE.parents[3] / "apps" / "desktop" / "assets" / "app.ico"),
        keep_temp=args.keep_temp,
        clean=not args.no_clean,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
