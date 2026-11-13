"""Probe the install / upgrade / delete markers of an installed tree with the SHIPPED code.

Used by ``tests/installer/r3-upgrade-path-pin.test.js``: after the miniature installer run
(and after the tree has been doctored into the "copy interrupted" shape) this prints one
JSON line with what the shipped guards actually say about that tree, so the test can pin
the verdicts instead of re-implementing them.

Read-only: every function called here only reads files under ``target``.

Usage:  python r3-marker-probe.py <installer-app-dir> <target-dir>

Author: PT-dove
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: r3-marker-probe.py <app> <target>"}) + "\n")
        return 2

    app = Path(argv[1]).resolve()
    target = Path(argv[2]).resolve()
    sys.path.insert(0, str(app))

    from aidn import install  # noqa: PLC0415  (import after the path is set)

    record = install.read_install_record(target)
    report = {
        "ok": True,
        "installMarker": install._install_marker(target),
        "upgradeMarker": install._upgrade_marker(target),
        "manifestHasRows": install._manifest_has_rows(target),
        "hasAnyEntry": install._has_any_entry(target),
        "recordVersion": (record or {}).get("version"),
        "recordUpgradedFrom": (record or {}).get("upgradedFrom"),
        "recordHasOwnership": bool((record or {}).get("ownership")),
        "ownershipProblem": install._ownership_problem(target),
    }
    sys.stdout.write(json.dumps(report, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
