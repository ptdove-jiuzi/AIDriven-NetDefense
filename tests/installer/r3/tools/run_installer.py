"""Run the installer app (patched copy or a mutated one) with two test seams set.

Why a runner instead of calling ``main.py`` directly:

* the version recorded in ``install.json`` comes from the *interpreter's* version
  resource when the app runs from source (``3.11.9``).  The shipped rc.6 exe
  reports ``0.0.1-rc.6``; the runner supplies exactly that string, so the record
  this harness produces is the record the real exe would produce;
* ``payload.archive_path()`` looks for ``payload.7z`` next to the app package.
  The archive itself is built in the scratch area, so the path is pointed there.
  Extraction is the real ``py7zr`` path — only the *lookup* is redirected.

Everything else — argument parsing, the elevation gate, the upgrade gate, the
copy, the record, the ownership credential, the journal, the exit codes — is the
patched copy's own code, unmodified.

Usage:
    python run_installer.py <app-dir> <payload.7z> <version> <installer-args...>

Exit status is the installer's.
"""

from __future__ import annotations

import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        sys.stdout.write("usage: run_installer.py <app-dir> <payload.7z> <version> [args...]\n")
        return 2
    app_dir = Path(argv[1]).resolve()
    archive = Path(argv[2]).resolve()
    version = argv[3]
    args = argv[4:]

    sys.path.insert(0, str(app_dir))
    from aidn import payload, selfinfo  # noqa: PLC0415 - after sys.path

    selfinfo.product_version = lambda: version
    payload.archive_path = lambda: archive

    import main as entry  # noqa: PLC0415

    return int(entry.main(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
