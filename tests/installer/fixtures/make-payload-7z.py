"""Build the tiny *real* payload.7z used by ``runkey-autostart.test.js``.

Why a payload at all: the autostart defect can only be reproduced through the real
``install()`` / ``uninstall()`` transaction — not by calling ``registry.set_autostart()``
directly.  The shipped payload is 486 MiB, which is far too big for a regression test, so
this fixture produces a **structurally valid miniature payload**: the same ``bundle.json``,
the same entry-point name, and a real ``manifests/files.sha256`` whose digests match the
bytes next to it (``install._manifest_has_rows`` verifies a sample of rows, and
``ownership.payload_digest`` signs the manifest file itself, so a fake manifest would turn
every uninstall into a refusal).

Nothing about the installer is stubbed: the test drives ``main.py /S /DIR=… /AUTOSTART``
and ``main.py /uninstall``, so collection of the record, the ownership credential, the
HKCU Run write and its scoped removal are all the shipped code path.

Usage:  python make-payload-7z.py <src-dir> <out.7z>

Prints one JSON line: ``{"ok": true, "files": [...], "archive": "..."}``.

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

EXE_NAME = "AIDrivenNetDefense.exe"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: make-payload-7z.py <src> <out.7z>"}) + "\n")
        return 2

    src = Path(argv[1]).resolve()
    out = Path(argv[2]).resolve()

    files: list[str] = []

    def put(relative: str, data: bytes) -> None:
        path = src / relative.replace("/", "\\")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        files.append(relative)

    put(EXE_NAME, b"MZ\x90\x00" + b"runkey-autostart-test-fixture" + bytes(range(256)))
    put(
        "bundle.json",
        (
            json.dumps(
                {
                    "kind": "v14-desktop",
                    "schemaVersion": "1.0",
                    "builtAt": "2026-11-05T00:00:00.000Z",
                    "note": "miniature payload built by tests/installer/fixtures/make-payload-7z.py",
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        ).encode("utf-8"),
    )
    put("console/index.html", b"<!doctype html><title>runkey fixture</title>\n")
    put("runtime/node/node.exe", b"node-fixture\n")

    # The manifest must verify against the bytes above; `_manifest_has_rows` rejects
    # anything shorter than three rows and any row whose digest does not match.
    rows = [f"{_sha256(src / name)}  {name}" for name in files]
    (src / "manifests").mkdir(parents=True, exist_ok=True)
    (src / "manifests" / "files.sha256").write_text("\n".join(rows) + "\n", encoding="utf-8")

    try:
        import py7zr
    except ImportError as error:  # pragma: no cover - environment fault, reported verbatim
        sys.stdout.write(json.dumps({"ok": False, "error": f"py7zr missing: {error}"}) + "\n")
        return 3

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    with py7zr.SevenZipFile(out, "w") as archive:
        for path in sorted(src.rglob("*")):
            if path.is_file():
                archive.write(path, arcname=str(path.relative_to(src)).replace("\\", "/"))

    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "archive": str(out),
                "bytes": out.stat().st_size,
                "files": files + ["manifests/files.sha256"],
            }
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
