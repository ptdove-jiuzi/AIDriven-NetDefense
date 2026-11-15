"""Cut a copy off half way, using the installer's own journal and copy code.

The defect's state cannot be produced by "run the installer and hit Ctrl-C at the
right millisecond" in a reproducible way, so this driver reproduces the *state*
with the real functions instead of re-implementing it:

1. ``install._write_journal(...)`` — the shipped (patched) function, with the real
   ``fromVersion`` / ``toVersion`` / payload-manifest digest / target;
2. ``install._copy_tree(<pruned payload>, target)`` — the shipped copy routine,
   given only the first few payload files (the "half copied" part).

After it returns, the target is exactly what a SIGKILL between those two lines
leaves: payload bytes newer than ``manifests/files.sha256``, ``install.json``
still at the old version, journal present.  Nothing is invented: the bytes are
copied by the product, the journal is the product's.

Usage:
    python r3_interrupt.py <app-dir> <target-dir> <payload-dir> <to-version> <n-files>

``n-files`` is how many leading manifest rows to copy before "power is lost"
(1..4 reproduces the observed interrupted state; row 1 is the executable).

Emits one JSON line.

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main(argv: list[str]) -> int:
    if len(argv) < 6:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: <app> <target> <payload> <to-version> <n-files>"}) + "\n")
        return 2

    app_dir = Path(argv[1]).resolve()
    target = Path(argv[2]).resolve()
    payload_dir = Path(argv[3]).resolve()
    to_version = argv[4]
    count = int(argv[5])

    sys.path.insert(0, str(app_dir))
    from aidn import install  # noqa: PLC0415 - after sys.path

    class Log:
        def __init__(self) -> None:
            self.lines: list[str] = []

        def write(self, message: object) -> None:
            self.lines.append(str(message))

        def step(self, message: object) -> None:
            self.lines.append(str(message))

        def error(self, message: object) -> None:
            self.lines.append(str(message))

    log = Log()

    record = install.read_install_record(target)
    if record is None:
        sys.stdout.write(json.dumps({"ok": False, "error": "no install.json in target"}) + "\n")
        return 1

    manifest = payload_dir / "manifests" / "files.sha256"
    rows = [line.split("  ", 1)[1] for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    staged = target.parent / (target.name + "-staged-partial")
    if staged.exists():
        shutil.rmtree(staged)
    for relative in rows[:count]:
        source = payload_dir / relative.replace("/", "\\")
        destination = staged / relative.replace("/", "\\")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    install._write_journal(
        target,
        from_version=str(record.get("version") or ""),
        to_version=to_version,
        payload_manifest_sha256=sha256(manifest),
        log=log,
    )
    install._copy_tree(staged, target)

    after = install.read_install_record(target)
    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "target": str(target),
                "copied": rows[:count],
                "journal": str(install._journal_path(target)),
                "journalExists": install._journal_path(target).is_file(),
                "recordVersion": (after or {}).get("version"),
                "installMarker": install._install_marker(target),
                "upgradeMarker": install._upgrade_marker(target),
                "manifestHasRows": install._manifest_has_rows(target),
                "resume": bool(install._resume_marker(target)),
                "logTail": log.lines[-3:],
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
