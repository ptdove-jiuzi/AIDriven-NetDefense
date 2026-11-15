"""Build a miniature but structurally complete rc.5 / rc.6 payload tree.

Why: the P1 defect (``UPGRADE-001``) is reachable only on a tree that (a) was
installed by this installer — so it carries a real ``install.json.ownership``
credential — and (b) has payload bytes newer than ``manifests/files.sha256``.
Reproducing that on a 50,834-file real tree costs 258 s per install plus a
multi-minute SIGKILL window; on this 33-file tree the same *predicates* run on
the same shipped code in under a second.

The tree is not a mock of the checks: it is built by ``aidn.install.install()``
(see ``r3_build_tree.py``), so ``install.json``, the HMAC credential and
``manifests/files.sha256`` are exactly what the installer writes.  Row order
matters and mirrors the shipped payload: the executable is row 1, which is what
``install._manifest_has_rows`` samples first.

Usage:
    python make_mini_payload.py <out-dir> <tag> [--real-exe <path>]

Prints one JSON line: ``{"ok": true, "files": N, "rows": [...], "exeSha256": …}``.

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

EXE_NAME = "AIDrivenNetDefense.exe"

#: Fillers exist to push the tree past the 20-file floor of the campaign's
#: "small tree" definition and past ``_manifest_has_rows``'s three-row minimum.
FILLERS = [f"docs/reference-{index:02d}.txt" for index in range(1, 25)]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: <out-dir> <tag> [--real-exe <path>]"}) + "\n")
        return 2

    out = Path(argv[1]).resolve()
    tag = argv[2]
    real_exe = None
    if "--real-exe" in argv:
        real_exe = Path(argv[argv.index("--real-exe") + 1]).resolve()

    if out.exists():
        # Only the fixture's own staging directory is ever removed here.
        for child in sorted(out.rglob("*"), reverse=True):
            child.unlink() if child.is_file() else child.rmdir()
        out.rmdir()
    out.mkdir(parents=True)

    order: list[str] = []

    def put(relative: str, data: bytes) -> None:
        path = out / relative.replace("/", "\\")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        order.append(relative)

    if real_exe is not None:
        # The real rc.6 desktop binary out of the portable zip: the "new bytes"
        # of an interrupted overwrite are then genuinely rc.6 bytes, not a tag.
        (out / EXE_NAME).write_bytes(real_exe.read_bytes())
        order.append(EXE_NAME)
    else:
        put(EXE_NAME, b"MZ\x90\x00" + tag.encode("utf-8") + bytes(range(256)) * 16)

    put(
        "bundle.json",
        (
            json.dumps(
                {
                    "schemaVersion": "1.0",
                    "kind": "v14-desktop",
                    "author": "PT-dove",
                    "builtAt": "2026-11-05T00:00:00.000Z",
                    "variant": tag,
                    "note": "miniature payload from tests/installer/r3/tools/make_mini_payload.py",
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        ).encode("utf-8"),
    )
    put("console/index.html", f"<!doctype html><meta charset=utf-8><title>{tag}</title>\n".encode("utf-8"))
    put("launch/aegis-console.cmd", f"@echo off\r\nrem {tag}\r\n".encode("utf-8"))
    put("runtime/node/node.exe", f"node-fixture-{tag}\n".encode("utf-8"))
    put("rules/defense-seed-pack.json", (json.dumps({"tag": tag, "rules": 3}) + "\n").encode("utf-8"))
    put(
        "app/node_modules/@aegisharness/harness-adapter/index.js",
        f"export const variant = {json.dumps(tag)};\n".encode("utf-8"),
    )
    put(
        "dsh-home/profiles/aegis-analysis/config.json",
        (json.dumps({"profile": "aegis-analysis", "variant": tag}) + "\n").encode("utf-8"),
    )
    for relative in FILLERS:
        put(relative, f"{tag} reference document {relative}\n".encode("utf-8"))

    rows = [f"{sha256(out / name.replace('/', chr(92)))}  {name}" for name in order]
    (out / "manifests").mkdir(parents=True, exist_ok=True)
    (out / "manifests" / "files.sha256").write_text("\n".join(rows) + "\n", encoding="utf-8", newline="\n")

    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "tag": tag,
                "out": str(out),
                "files": len(list(out.rglob("*"))),
                "rows": len(rows),
                "firstRows": rows[:3],
                "exeSha256": sha256(out / EXE_NAME),
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
