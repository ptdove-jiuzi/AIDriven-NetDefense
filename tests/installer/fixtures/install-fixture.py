"""Build a real install tree by driving ``aidn.install.install()``.

RC5-N01 needs a tree that the *installer itself* produced (record + credential +
payload bytes), not a hand-written directory that merely looks like one.  Unpacking the
real 450 MiB payload is not an option for a unit test, so this fixture replaces only the
payload transport (``archive_path`` / ``describe`` / ``extract``) and the machine-level
side effects (process stop, shortcuts, registry, autostart) with stubs.  Everything that
writes the tree and the install record — ``_copy_tree``, ``payload.resolve_entry``,
``missing_desktop_reason``, ``_write_selfcheck``, ``_copy_installer`` and the record
itself, including the ownership credential — is the shipped code path.

Usage:  python install-fixture.py <installer-app-dir> <target-dir> <payload-dir>

Emits one JSON line on stdout:

    {"ok": true, "record": {...}}                     # tree created
    {"ok": false, "error": "ExceptionType: message"}   # installer refused

Author: PT-dove
"""

import json
import shutil
import sys
from pathlib import Path


def main(argv):
    if len(argv) != 4:
        sys.stdout.write(json.dumps({"ok": False, "error": "usage: install-fixture.py <app> <target> <payload>"}) + "\n")
        return 2

    app_dir = Path(argv[1]).resolve()
    target = Path(argv[2])
    payload_dir = Path(argv[3]).resolve()

    sys.path.insert(0, str(app_dir))
    from aidn import constants, install as install_module  # noqa: E402
    from aidn import payload, procs, registry, shortcuts  # noqa: E402

    class Log:
        """The installer only needs write()/step()/error(); keep the last lines."""

        def __init__(self):
            self.lines = []

        def write(self, message):
            self.lines.append(str(message))

        def step(self, message):
            self.lines.append(str(message))

        def error(self, message):
            self.lines.append(str(message))

    log = Log()

    # --- payload transport stub: "unpacking" is a copy of the fixture payload tree.
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

    # --- machine-level side effects: none of these may run on the build machine.
    procs.stop_under = lambda root, logger: 0
    shortcuts.install_shortcuts = lambda *args, **kwargs: []
    registry.set_autostart = lambda *args, **kwargs: None
    # The autostart value is the user's global Run entry: reading or (worse) deleting it
    # from a fixture install would be a real machine-level side effect.
    registry.remove_autostart_if_ours = lambda *args, **kwargs: "absent"
    registry.autostart_points_into = lambda *args, **kwargs: False
    registry.write_uninstall_entry = lambda *args, **kwargs: "HKCU (stubbed for the test)"
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
    except Exception as error:  # noqa: BLE001 - reported verbatim to the caller
        sys.stdout.write(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}) + "\n")
        return 1

    record_path = target / constants.INSTALL_DIR_NAME / constants.INSTALL_RECORD_NAME
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        sys.stdout.write(json.dumps({"ok": False, "error": f"record unreadable: {error}"}) + "\n")
        return 1

    sys.stdout.write(json.dumps({"ok": True, "record": record}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
