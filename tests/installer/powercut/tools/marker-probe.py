"""Probe the install / upgrade / delete markers of a tree with the SHIPPED installer code.

Round-5 powercut seat (POST-SHIP-PATH / powercut-r5).

This is the question the whole experiment turns on: after a half-copied upgrade, what do
the product's *own* gates say about the directory? Re-implementing the rules in a probe
would let the probe and the installer disagree, which is exactly the kind of evidence that
looks convincing and proves nothing. So every value below comes from
``aidn/install.py`` (``_install_marker`` / ``_upgrade_marker`` / ``_manifest_has_rows`` /
``_has_any_entry`` / ``_ownership_problem`` / ``_record_is_ours`` / ``_bundle_is_ours``)
and ``aidn/ownership.py`` (``verify`` / ``payload_digest``).

Read-only: every shipped function called here only reads files under ``target``.

Usage:  python marker-probe.py <installer-app-dir> <target-dir>
Prints one JSON line.

Author: PT-dove
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: marker-probe.py <app> <target>"}) + "\n")
        return 2

    app = Path(argv[1]).resolve()
    target = Path(argv[2]).resolve()
    sys.path.insert(0, str(app))

    from aidn import install, ownership  # noqa: PLC0415  (import after sys.path is set)

    report: dict = {"ok": True, "app": str(app), "target": str(target)}
    try:
        record = install.read_install_record(target)
        report.update(
            {
                "installMarker": install._install_marker(target),
                "upgradeMarker": install._upgrade_marker(target),
                "manifestHasRows": install._manifest_has_rows(target),
                "hasAnyEntry": install._has_any_entry(target),
                "recordPresent": record is not None,
                "recordVersion": (record or {}).get("version"),
                "recordUpgradedFrom": (record or {}).get("upgradedFrom"),
                "recordInstallPath": (record or {}).get("installPath"),
                "recordChannel": (record or {}).get("channel"),
                "recordHasOwnership": bool((record or {}).get("ownership")),
                "ownershipProblem": install._ownership_problem(target),
                "bundleIsOurs": install._bundle_is_ours(target),
                "payloadDigestOnDisk": ownership.payload_digest(target),
                "canonicalTargetPath": ownership.canonical_path(target),
            }
        )
        if record is not None:
            report["recordIsOurs"] = install._record_is_ours(target, record)
            ok, reason = ownership.verify(record, target)
            report["ownershipVerifyOk"] = bool(ok)
            report["ownershipVerifyReason"] = reason
            block = record.get("ownership") or {}
            report["recordedPayloadDigest"] = block.get("payloadDigest")
            report["recordedInstallId"] = block.get("installId")
        else:
            report["recordIsOurs"] = False
            report["ownershipVerifyOk"] = False
            report["ownershipVerifyReason"] = "no-record"
    except Exception as error:  # a probe that dies silently is worse than a red line
        report["ok"] = False
        report["error"] = f"{type(error).__name__}: {error}"

    sys.stdout.write(json.dumps(report, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
