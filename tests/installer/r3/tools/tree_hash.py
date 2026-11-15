"""Hash a directory tree: per-file SHA-256, counts, and one aggregate digest.

Used as the "the tree did not change" witness for the red run (a refused install
must not touch one byte) and as the ``data\\`` witness before/after an uninstall
(``--subtree data``).

Usage:  python tree_hash.py <root> [--subtree <relative>] [--out <json>]

Prints one JSON line; with ``--out`` also writes it there.

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def walk(root: Path) -> dict[str, object]:
    files: dict[str, str] = {}
    total = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        files[path.relative_to(root).as_posix()] = sha256(path)
        total += path.stat().st_size
    aggregate = hashlib.sha256()
    for name in sorted(files):
        aggregate.update(name.encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(files[name].encode("ascii"))
        aggregate.update(b"\n")
    return {"root": str(root), "files": len(files), "bytes": total, "treeSha256": aggregate.hexdigest(), "perFile": files}


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: <root> [--subtree rel] [--out json]"}) + "\n")
        return 2
    root = Path(argv[1]).resolve()
    if "--subtree" in argv:
        root = root / argv[argv.index("--subtree") + 1]
    if not root.is_dir():
        sys.stdout.write(json.dumps({"ok": False, "error": f"not a directory: {root}"}) + "\n")
        return 1
    report = {"ok": True, **walk(root)}
    text = json.dumps(report, ensure_ascii=False)
    if "--out" in argv:
        Path(argv[argv.index("--out") + 1]).write_text(text + "\n", encoding="utf-8")
    sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
