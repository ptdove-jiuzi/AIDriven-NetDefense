"""Build one *variant* of the miniature payload used by ``r3-upgrade-path-pin.test.js``.

Same structure as ``make-payload-7z.py`` (real ``bundle.json``, real entry point, real
``manifests/files.sha256``), but every file carries a ``variant`` tag so two payloads can
be told apart by content — which is what makes the "the files landed, the manifest did
not" state of an interrupted copy reproducible on purpose instead of by timing.

Row order matters and is deliberate: the first data row of the manifest is
``AIDrivenNetDefense.exe``, exactly like the shipped payload
(``install._manifest_has_rows`` samples the first three rows, which is why that row is
what a half-copied tree always trips).

Usage:  python r3-make-payload.py <src-dir> <out.7z> <variant-tag>

Prints one JSON line: ``{"ok": true, "variant": ..., "archive": ..., "rows": [...],
"exeSha256": ...}``.

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
    if len(argv) != 4:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: r3-make-payload.py <src> <out.7z> <tag>"}) + "\n")
        return 2

    src = Path(argv[1]).resolve()
    out = Path(argv[2]).resolve()
    tag = argv[3]

    order: list[str] = []

    def put(relative: str, data: bytes) -> None:
        path = src / relative.replace("/", "\\")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        order.append(relative)

    # The entry point comes first on purpose: it is the row a half-copied tree trips.
    put(EXE_NAME, b"MZ\x90\x00" + tag.encode("utf-8") + bytes(range(256)))
    put(
        "bundle.json",
        (
            json.dumps(
                {
                    "kind": "v14-desktop",
                    "schemaVersion": "1.0",
                    "builtAt": "2026-11-05T00:00:00.000Z",
                    "variant": tag,
                    "note": "miniature payload built by tests/installer/fixtures/r3-make-payload.py",
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        ).encode("utf-8"),
    )
    put("console/index.html", f"<!doctype html><title>{tag}</title>\n".encode("utf-8"))
    put("runtime/node/node.exe", f"node-fixture-{tag}\n".encode("utf-8"))

    rows = [f"{_sha256(src / name)}  {name}" for name in order]
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
                "variant": tag,
                "archive": str(out),
                "bytes": out.stat().st_size,
                "rows": rows,
                "exeSha256": _sha256(src / EXE_NAME),
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
