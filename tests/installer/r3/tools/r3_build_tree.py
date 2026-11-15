"""Build the rc.5 install tree with the SHIPPED installer transaction.

``aidn.install.install()`` is driven directly, so the record, the HMAC ownership
credential and the manifest are what the product writes — not hand-written files
that merely look right.  Only three things are stubbed, all of them machine-level
or transport-level:

* payload transport (``archive_path`` / ``describe`` / ``extract``) — "unpacking"
  is a copy of a prepared payload directory; py7zr is not needed to build a tree;
* process stop, shortcuts, registry — none of these may touch the build host;
* ``selfinfo.product_version`` — running from source reports the *interpreter's*
  version resource (``3.11.9``); the campaign needs the tree to say
  ``0.0.1-rc.5``, which is exactly what the rc.5 exe's resource says.

The credential is issued *after* the version override, so it verifies against the
record it is stored in (``ownership.verify`` → ``(True, "")``), which is the
property the whole reproduction rests on.

Usage:
    python r3_build_tree.py <app-dir> <target-dir> <payload-dir> <version> [--data]

``--data`` seeds ``<target>\\data`` with eight deterministic files (one 1 MiB) so
"data survived the upgrade" is a byte-level claim, not an assertion about a
directory that never had anything in it.

Emits one JSON line.

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) < 5:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: <app> <target> <payload> <version> [--data]"}) + "\n")
        return 2

    app_dir = Path(argv[1]).resolve()
    target = Path(argv[2]).resolve()
    payload_dir = Path(argv[3]).resolve()
    version = argv[4]
    seed_data = "--data" in argv

    sys.path.insert(0, str(app_dir))
    from aidn import constants, install as install_module, ownership, payload, procs, registry, shortcuts, selfinfo

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

    def fake_extract(archive, destination, logger):
        destination = Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copytree(payload_dir, destination, dirs_exist_ok=True)
        return destination

    selfinfo.product_version = lambda: version
    payload.archive_path = lambda: payload_dir / "payload.7z"
    payload.describe = lambda archive: {"path": str(payload_dir), "bytes": 0, "uncompressedBytes": 0}
    payload.extract = fake_extract
    procs.stop_under = lambda root, logger: 0
    shortcuts.install_shortcuts = lambda *a, **k: []
    registry.set_autostart = lambda *a, **k: None
    registry.remove_autostart_if_ours = lambda *a, **k: "absent"
    registry.autostart_points_into = lambda *a, **k: False
    registry.write_uninstall_entry = lambda *a, **k: "stubbed"
    registry.read_uninstall_entry = lambda: None

    options = install_module.Options(
        target=target,
        desktop_shortcut=False,
        create_shortcuts=False,
        autostart=False,
        write_registry=False,
        keep_data=False,
    )
    try:
        install_module.install(options, log)
    except Exception as error:  # noqa: BLE001 - reported verbatim
        sys.stdout.write(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}", "log": log.lines}) + "\n")
        return 1

    if seed_data:
        data = target / constants.DATA_DIR_NAME
        data.mkdir(parents=True, exist_ok=True)
        (data / "events.db").write_bytes(bytes(range(256)) * 4096)  # 1 MiB, largest file
        for index in range(1, 8):
            (data / f"seed-{index:02d}.json").write_text(
                json.dumps({"row": index, "installedAt": version}, ensure_ascii=False) + "\n", encoding="utf-8"
            )

    record = json.loads((target / "install" / "install.json").read_text(encoding="utf-8"))
    verified, reason = ownership.verify(record, target)
    sys.stdout.write(
        json.dumps(
            {
                "ok": verified,
                "verify": reason,
                "target": str(target),
                "version": record.get("version"),
                "upgradedFrom": record.get("upgradedFrom"),
                "installMarker": install_module._install_marker(target),
                "upgradeMarker": install_module._upgrade_marker(target),
                "manifestHasRows": install_module._manifest_has_rows(target),
                "dataFiles": len(list((target / "data").rglob("*"))) if seed_data else 0,
                "logTail": log.lines[-4:],
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    return 0 if verified else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
