"""Pack a payload directory into the ``payload.7z`` a frozen installer would carry.

The shipped Setup.exe embeds a 7z; the patched copy run from source looks for one
next to the app (see ``aidn.payload.archive_path``).  This is the same container
format, so ``aidn.payload.extract`` takes the real ``py7zr`` path in the harness —
only the archive is smaller.

Usage:  python make_archive.py <payload-dir> <out.7z>
Prints one JSON line: ``{"ok": true, "archive": ..., "bytes": ...}``.

Author: PT-dove
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: <payload-dir> <out.7z>"}) + "\n")
        return 2
    try:
        import py7zr
    except ImportError as error:
        sys.stdout.write(json.dumps({"ok": False, "error": f"py7zr missing: {error} (use D:\\Python311)"}) + "\n")
        return 3

    source = Path(argv[1]).resolve()
    out = Path(argv[2]).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    with py7zr.SevenZipFile(out, "w") as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                archive.write(path, arcname=str(path.relative_to(source)).replace("\\", "/"))
    sys.stdout.write(json.dumps({"ok": True, "archive": str(out), "bytes": out.stat().st_size}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
