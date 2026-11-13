"""Which payload rows of a half-copied upgrade actually landed on disk?

Round-5 powercut seat (POST-SHIP-PATH / powercut-r5).

The kill window is defined by content, not by a stopwatch: the entry executable is already
the new generation's bytes while ``manifests\\files.sha256`` is still the old generation's
file. This script turns that state into numbers:

* how many manifest rows differ between the two generations at all (``distinguishable``),
* for each of them, whether the file on disk carries the old bytes, the new bytes, or
  something else (a file being written when the kill landed),
* the **first data row** of the old manifest — the row ``install._manifest_has_rows``
  samples first, and the reason a half-copied tree always trips that gate,
* an emulation of the shipped sampling window (first 3 rows + last 3 rows + payload-layout
  rows, at most 64, see ``install.py::_manifest_has_rows``) run against the old manifest,
  so "the gate must fail here" is a computed statement rather than a hand-wave.

Usage:
    python manifest-audit.py --old <manifest-old> --new <manifest-new> --tree <dir>
                             --out <report.json> [--app <installer app dir>]

The optional ``--app`` makes the script import the *shipped* constants
(``_PAYLOAD_LAYOUT_MARKERS`` / ``_MANIFEST_ROW_RE``) and refuse to run if its local copies
have drifted from them.

Author: PT-dove
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

#: Same tuple as ``aidn.install._PAYLOAD_LAYOUT_MARKERS``; --app cross-checks it.
LAYOUT_MARKERS = (
    "aidrivennetdefense.exe",
    "runtime/node/node.exe",
    "app/node_modules/@aegisharness/",
    "launch/aegis-",
    "dsh-home/profiles/aegis-analysis",
    "rules/defense-seed-pack.json",
)

ROW_RE = re.compile(r"([0-9a-fA-F]{64})  (?P<path>.+)")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_manifest(path: Path) -> list[tuple[str, str]]:
    """[(digest_lower, relative_path)] in file order, skipping blank/# lines."""

    rows: list[tuple[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = ROW_RE.fullmatch(line)
        if match is None:
            raise SystemExit(f"unparseable manifest row in {path}: {line[:120]!r}")
        rows.append((match.group(1).lower(), match.group("path").strip()))
    return rows


def sampling_indexes(rows: list[tuple[str, str]]) -> list[int]:
    """The indexes ``install._manifest_has_rows`` checks (shipped rule)."""

    indexes: set[int] = set(range(min(3, len(rows))))
    indexes.update(range(max(0, len(rows) - 3), len(rows)))
    marker_rows = 0
    for index, (_digest, relative) in enumerate(rows):
        normalised = relative.replace("\\", "/").lower()
        if any(marker in normalised for marker in LAYOUT_MARKERS):
            indexes.add(index)
            marker_rows += 1
            if marker_rows >= 32:
                break
    return sorted(indexes)[:64]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old", required=True)
    parser.add_argument("--new", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--app", default=None)
    args = parser.parse_args(argv[1:])

    app = Path(args.app).resolve() if args.app else None
    if app is not None:
        sys.path.insert(0, str(app))
        from aidn import install  # noqa: PLC0415

        if tuple(install._PAYLOAD_LAYOUT_MARKERS) != LAYOUT_MARKERS:
            raise SystemExit("layout markers drifted from the shipped aidn.install — update this audit")
        if install._MANIFEST_ROW_RE.pattern != ROW_RE.pattern:
            raise SystemExit("manifest row regex drifted from the shipped aidn.install — update this audit")

    old_path = Path(args.old).resolve()
    new_path = Path(args.new).resolve()
    tree = Path(args.tree).resolve()
    out = Path(args.out).resolve()

    old_rows = read_manifest(old_path)
    new_rows = read_manifest(new_path)
    # path -> digest (read_manifest yields (digest, path), so the dict is built explicitly:
    # a plain dict(rows) would key on the digest and every comparison below would silently
    # come out empty)
    old_map = {path: digest for digest, path in old_rows}
    new_map = {path: digest for digest, path in new_rows}

    only_old = sorted(set(old_map) - set(new_map))
    only_new = sorted(set(new_map) - set(old_map))
    differing = sorted(key for key in set(old_map) & set(new_map) if old_map[key] != new_map[key])

    details = []
    landed_new = still_old = missing = other = 0
    for relative in differing:
        path = tree / relative.replace("\\", "/")
        disk = None
        if path.is_file():
            try:
                disk = sha256_file(path)
            except OSError:
                disk = None
        if disk is None:
            state = "missing"
            missing += 1
        elif disk == new_map[relative]:
            state = "new"
            landed_new += 1
        elif disk == old_map[relative]:
            state = "old"
            still_old += 1
        else:
            state = "other"
            other += 1
        details.append(
            {
                "path": relative,
                "oldSha256": old_map[relative],
                "newSha256": new_map[relative],
                "diskSha256": disk,
                "state": state,
                "oldLine": next(i + 1 for i, (d, p) in enumerate(old_rows) if p == relative),
            }
        )

    # the shipped sampling window, evaluated against each generation
    def evaluate(rows: list[tuple[str, str]], label: str) -> dict:
        checked = []
        mismatched = []
        for index in sampling_indexes(rows):
            digest, relative = rows[index]
            path = tree / relative.replace("\\", "/")
            disk = None
            if path.is_file():
                try:
                    disk = sha256_file(path)
                except OSError:
                    disk = None
            match = disk == digest
            checked.append({"line": index + 1, "path": relative, "expected": digest, "disk": disk, "match": match})
            if not match:
                mismatched.append({"line": index + 1, "path": relative, "disk": disk, "expected": digest})
        return {
            "manifest": label,
            "rowsChecked": len(checked),
            "rowsMismatched": len(mismatched),
            "manifestHasRowsByShippedRule": (len(mismatched) == 0 and len(checked) >= 3),
            "firstCheckedRows": checked[:6],
            "mismatched": mismatched[:24],
        }

    first_row = {
        "line": 1,
        "path": old_rows[0][1],
        "oldSha256": old_rows[0][0],
        "newSha256": new_map.get(old_rows[0][1]),
        "diskSha256": details[0]["diskSha256"] if details else None,
        "state": details[0]["state"] if details else None,
    }
    # details are sorted by path, not by manifest order: recompute the first row's disk state
    first_path = tree / old_rows[0][1].replace("\\", "/")
    first_disk = sha256_file(first_path) if first_path.is_file() else None
    first_state = (
        "new" if first_disk == new_map.get(old_rows[0][1]) else ("old" if first_disk == old_rows[0][0] else ("missing" if first_disk is None else "other"))
    )
    first_row["diskSha256"] = first_disk
    first_row["state"] = first_state

    report = {
        "tree": str(tree),
        "oldManifest": {"path": str(old_path), "sha256": sha256_file(old_path), "rows": len(old_rows)},
        "newManifest": {"path": str(new_path), "sha256": sha256_file(new_path), "rows": len(new_rows)},
        "onlyInOld": only_old,
        "onlyInNew": only_new,
        "distinguishableCount": len(differing),
        "landedNew": landed_new,
        "stillOld": still_old,
        "missing": missing,
        "other": other,
        "landedRatioOfDistinguishable": round(landed_new / len(differing), 4) if differing else 0.0,
        "firstDataRow": first_row,
        "details": details,
        "headOldLines": [{"line": i + 1, "path": old_rows[i][1], "sha256": old_rows[i][0]} for i in range(min(5, len(old_rows)))],
        "headNewLines": [{"line": i + 1, "path": new_rows[i][1], "sha256": new_rows[i][0]} for i in range(min(5, len(new_rows)))],
        "shippedSamplingWindow": {
            "old": evaluate(old_rows, "old"),
            "new": evaluate(new_rows, "new"),
        },
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "distinguishable": len(differing),
                "landedNew": landed_new,
                "stillOld": still_old,
                "missing": missing,
                "other": other,
                "firstDataRow": first_row,
                "manifestHasRowsOnDiskRule": {
                    "old": report["shippedSamplingWindow"]["old"]["manifestHasRowsByShippedRule"],
                    "new": report["shippedSamplingWindow"]["new"]["manifestHasRowsByShippedRule"],
                },
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
