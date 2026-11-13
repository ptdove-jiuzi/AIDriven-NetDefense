#!/usr/bin/env python3
"""Independent direct SQLite probe for the daemon event store (read-only).

Deliberately does NOT use the product's own driver or adapter: it opens the SQLite
file with `mode=ro` through the standard library so the row count in the evidence is
not produced by the same code path that wrote it.

Usage:  python db-probe.py <path-to-aegis.db>
Output: one line of JSON on stdout.
"""
import json
import sqlite3
import sys


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else ""
    out = {"ok": False, "db_path": path, "error": None}
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
        try:
            cur = con.cursor()
            out["count"] = int(cur.execute("SELECT COUNT(*) FROM telemetry_event").fetchone()[0])
            out["null_boot"] = int(
                cur.execute("SELECT COUNT(*) FROM telemetry_event WHERE boot_id IS NULL").fetchone()[0]
            )
            out["null_integrity"] = int(
                cur.execute(
                    "SELECT COUNT(*) FROM telemetry_event WHERE integrity_digest IS NULL"
                ).fetchone()[0]
            )
            row = cur.execute(
                "SELECT MIN(ingest_seq), MAX(ingest_seq) FROM telemetry_event"
            ).fetchone()
            out["min_ingest_seq"] = None if row is None or row[0] is None else int(row[0])
            out["max_ingest_seq"] = None if row is None or row[1] is None else int(row[1])
            out["distinct_boot_ids"] = int(
                cur.execute("SELECT COUNT(DISTINCT boot_id) FROM telemetry_event").fetchone()[0]
            )
            out["alerts"] = int(cur.execute("SELECT COUNT(*) FROM alert").fetchone()[0])
            out["journal_mode"] = str(
                cur.execute("PRAGMA journal_mode").fetchone()[0]
            )
            out["ok"] = True
        finally:
            con.close()
    except Exception as exc:  # noqa: BLE001 - probe must never crash the sampler
        out["error"] = f"{type(exc).__name__}: {exc}"
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
