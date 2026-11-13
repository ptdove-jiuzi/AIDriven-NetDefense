#!/usr/bin/env python3
"""Unit-level probe of the upgrade data guard (`aidn/install.py:340/360`).

The real installers call ``_probe_data(<target>\\data)`` before copying and
``_assert_data_intact(probe)`` after it; this fixture drives those two functions
directly against throwaway directories so the guard is measured instead of inferred --
and so the suite does not need a 67 MB Setup.exe and 30 minutes of disk I/O.

It also pins the guard's **scope**: it hashes only the largest file.  Mutating any
other file under `data\\` is not detected by the installer; the per-file fingerprint
table in the evidence directory (and the replay test that consumes it) is what covers
the rest.

Usage: upgrade-path-guard.py <workdir>   -> prints one JSON object

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[3]
APP = REPO / "deploy" / "windows" / "installer" / "app"
sys.path.insert(0, str(APP))

from aidn import install  # noqa: E402


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    # The installer's refusals are bilingual; on a Chinese Windows the console code page
    # would mangle the JSON the parent process reads. Emit UTF-8 regardless of the host.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:  # pragma: no cover - Python < 3.7
        pass
    work = Path(sys.argv[1]).resolve()
    data = work / "data"
    (data / "nested").mkdir(parents=True, exist_ok=True)

    largest = data / "largest.bin"
    largest.write_bytes(b"L" * 4096)
    other = data / "nested" / "other.txt"
    other.write_bytes(b"other-file")

    report: dict[str, object] = {
        "appDir": str(APP),
        "workDir": str(work),
        "cases": {},
    }
    cases: dict[str, object] = {}

    # 1) no data directory at all -> no probe (first install path)
    cases["absentDataDirReturnsNone"] = install._probe_data(work / "no-such-data") is None

    # 2) probe returns (largest file, sha256)
    probe = install._probe_data(data)
    cases["probePicksLargestFile"] = probe is not None and Path(probe[0]).name == "largest.bin"
    cases["probeDigestMatches"] = probe is not None and probe[1] == digest(largest)

    # 3) untouched tree -> the post-copy assertion must stay silent
    silent = True
    try:
        install._assert_data_intact(probe)
    except install.InstallError:
        silent = False
    cases["unchangedDataPasses"] = silent

    # 4) largest file modified -> InstallError naming the change
    largest.write_bytes(b"L" * 4095 + b"X")
    changed_error = None
    try:
        install._assert_data_intact(probe)
    except install.InstallError as error:
        changed_error = str(error)
    cases["modifiedLargestFileRefused"] = changed_error is not None and "被改动" in changed_error
    cases["modifiedLargestFileMessage"] = changed_error
    largest.write_bytes(b"L" * 4096)  # restore for the next case

    # 5) largest file removed -> InstallError naming the loss
    largest.unlink()
    missing_error = None
    try:
        install._assert_data_intact(probe)
    except install.InstallError as error:
        missing_error = str(error)
    cases["removedLargestFileRefused"] = missing_error is not None and "丢失" in missing_error
    cases["removedLargestFileMessage"] = missing_error
    largest.write_bytes(b"L" * 4096)

    # 6) a NON-largest file modified -> guard does not notice (documented limitation)
    other.write_bytes(b"tampered-non-largest-file")
    unnoticed = True
    try:
        install._assert_data_intact(probe)
    except install.InstallError:
        unnoticed = False
    cases["nonLargestFileMutationNotDetected"] = unnoticed

    report["cases"] = cases
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
