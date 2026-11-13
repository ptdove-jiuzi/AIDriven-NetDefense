"""Turn a robocopy clone of an installed tree into the tree a real install at that path
would have produced (installPath + ownership credential re-issued for the clone path).

Round-5 powercut seat (POST-SHIP-PATH / powercut-r5).

Why this is needed, and what it does *not* hide:

* N-040 §3 says the power-cut seat may clone a real installed tree with robocopy instead of
  cold-installing a fresh tree per timepoint. That is the shape a user actually has: one
  installed tree, later upgraded.
* But the shipped ownership credential is **path-bound on purpose**
  (``aidn/ownership.py``: the token signs ``canonical_path(target)``), so a byte-copy at a
  new path fails ``ownership.verify`` and ``_install_marker`` is already ``None`` *before*
  any power-cut — round-4 recorded exactly that as N-042 §3. Measuring a power-cut on such
  a tree would confuse "the credential never matched this path" with "the interrupted copy
  destroyed the record".
* So this script re-issues the credential for the clone path, with the **key and message
  layout compiled into the shipped installer** (``aidn.ownership.issue``). The result is
  credential-equivalent to an install performed at that path: same payload bytes, same
  manifest digest, same version/channel/installId, only the signed path changes.
* Both states are recorded: ``before`` (clone as copied) and ``after`` (re-issued), so the
  evidence shows path-binding rather than papering over it.

Only ``install/install.json`` is written; no other file in the tree is touched.

Usage:
    python resign-clone.py --app <installer app dir> --tree <clone dir> --out <report.json>
                            [--dry-run]

Author: PT-dove
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv[1:])

    app = Path(args.app).resolve()
    tree = Path(args.tree).resolve()
    sys.path.insert(0, str(app))

    from aidn import constants, install, ownership  # noqa: PLC0415

    record = install.read_install_record(tree)
    if record is None:
        raise SystemExit(f"no install record under {tree}")
    normalised = Path(__import__("os").path.abspath(str(tree)))

    before = {
        "installMarker": install._install_marker(tree),
        "upgradeMarker": install._upgrade_marker(tree),
        "manifestHasRows": install._manifest_has_rows(tree),
        "bundleIsOurs": install._bundle_is_ours(tree),
        "recordInstallPath": record.get("installPath"),
        "recordIsOurs": install._record_is_ours(tree, record),
    }
    ok, reason = ownership.verify(record, tree)
    before["ownershipVerifyOk"] = bool(ok)
    before["ownershipVerifyReason"] = reason

    updated = copy.deepcopy(record)
    updated["installPath"] = str(normalised)
    channel = str(record.get("channel") or constants.CHANNEL_INSTALLED).strip()
    version = str(record.get("version") or "").strip()
    block = record.get("ownership") or {}
    updated["ownership"] = ownership.issue(
        normalised,
        channel=channel,
        version=version,
        product=constants.PRODUCT_NAME,
        install_id=block.get("installId") or None,
    )

    written = False
    if not args.dry_run:
        record_path = tree / constants.INSTALL_DIR_NAME / constants.INSTALL_RECORD_NAME
        record_path.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        written = True

    after_record = updated if written else updated
    after = {
        "installMarker": install._install_marker(tree) if written else None,
        "upgradeMarker": install._upgrade_marker(tree) if written else None,
        "manifestHasRows": install._manifest_has_rows(tree),
        "recordInstallPath": after_record.get("installPath"),
    }
    if written:
        ok2, reason2 = ownership.verify(after_record, tree)
        after["ownershipVerifyOk"] = bool(ok2)
        after["ownershipVerifyReason"] = reason2

    report = {
        "ok": True,
        "tree": str(tree),
        "written": written,
        "version": version,
        "channel": channel,
        "installId": updated["ownership"].get("installId"),
        "payloadDigest": updated["ownership"].get("payloadDigest"),
        "before": before,
        "after": after,
        "note": "credential re-issued with the shipped key/message layout; only install.json written",
    }
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(json.dumps({k: report[k] for k in ("ok", "written", "tree", "before", "after")}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
