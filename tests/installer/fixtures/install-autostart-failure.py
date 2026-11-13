"""Drive ``aidn.install.install()`` with a *failing* autostart write.

The install record has to be evidence, not an intention: when the Run key cannot be
written (locked-down policy hive, redirected profile, another account's hive), the record
must say ``autostart: false`` and the run must report a problem.  That failure is not
reachable from a normal non-elevated test — the user's own Run key is always writable — so
this fixture injects exactly one failure: ``registry.set_autostart`` raises ``OSError``.

Nothing else is faked beyond the payload transport and the other machine-level side
effects (the same stubs ``install-fixture.py`` uses): ``_copy_tree``, the record writer,
``ownership.issue`` and — importantly — the read-back ``autostart_points_into`` (the real
function, reading the real ``HKCU\\...\\Run``) are the shipped code paths.

Usage:  python install-autostart-failure.py <installer-app-dir> <target-dir> <payload-dir>

Emits one JSON line on stdout:

    {"ok": true, "record": {...}, "problems": [...], "log": [...]}
    {"ok": false, "error": "ExceptionType: message"}

Author: PT-dove
"""

import json
import shutil
import sys
from pathlib import Path


def main(argv):
    if len(argv) != 4:
        sys.stdout.write(
            json.dumps({"ok": False, "error": "usage: install-autostart-failure.py <app> <target> <payload>"}) + "\n"
        )
        return 2

    app_dir = Path(argv[1]).resolve()
    target = Path(argv[2])
    payload_dir = Path(argv[3]).resolve()

    sys.path.insert(0, str(app_dir))
    from aidn import constants, install as install_module  # noqa: E402
    from aidn import payload, procs, registry, shortcuts  # noqa: E402

    class Log:
        def __init__(self):
            self.lines = []

        def write(self, message):
            self.lines.append(str(message))

        def step(self, message):
            self.lines.append(str(message))

        def error(self, message):
            self.lines.append(str(message))

    log = Log()

    def fake_extract(archive, destination, logger):
        destination = Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copytree(payload_dir, destination, dirs_exist_ok=True)
        return destination

    payload.archive_path = lambda: payload_dir / "payload.7z"
    payload.describe = lambda archive: {
        "path": str(payload_dir / "payload.7z"),
        "bytes": 0,
        "uncompressedBytes": 0,
    }
    payload.extract = fake_extract

    procs.stop_under = lambda root, logger: 0
    shortcuts.install_shortcuts = lambda *args, **kwargs: []
    registry.write_uninstall_entry = lambda *args, **kwargs: "HKCU (stubbed for the test)"
    registry.read_uninstall_entry = lambda: None
    # Do not touch the user's real Run value from a fixture (removal is a side effect).
    registry.remove_autostart_if_ours = lambda *args, **kwargs: "absent"
    # registry.autostart_points_into deliberately left real: it is the read-back under test.

    def refusing_set_autostart(*args, **kwargs):
        raise OSError("simulated: access denied writing HKCU Run")

    registry.set_autostart = refusing_set_autostart

    options = install_module.Options(
        target=target,
        desktop_shortcut=False,
        create_shortcuts=False,
        autostart=True,
        write_registry=False,
        keep_data=False,
    )

    try:
        result = install_module.install(options, log)
    except Exception as error:  # noqa: BLE001 - reported verbatim to the caller
        sys.stdout.write(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}) + "\n")
        return 1

    record_path = target / constants.INSTALL_DIR_NAME / constants.INSTALL_RECORD_NAME
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        sys.stdout.write(json.dumps({"ok": False, "error": f"record unreadable: {error}"}) + "\n")
        return 1

    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "record": record,
                "problems": list(getattr(result, "shortcut_problems", [])),
                "log": log.lines,
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
