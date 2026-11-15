# Setup.exe — Python installer source

Author: PT-dove

Source of `AIDrivenNetDefense-Setup-<ver>.exe`: Python 3.13 + tkinter + PyInstaller
one-file, with `payload.7z` embedded (see `docs/implementation/DIST-DECISION.md` §2).

**Not signed.** Windows will show "unknown publisher", and SmartScreen will show
"Windows protected your PC" on a fresh download. That is expected for this
distribution model and is **not** worked around — see
`docs/implementation/status/RELEASE-PIPELINE.md` §5.

## Files

| File | Role |
|---|---|
| `main.py` | entry point; `/S` and `/uninstall` for automation, otherwise the window |
| `aidn/constants.py` | names shared with `Setup.ps1`: install layout, registry key, entry order |
| `aidn/paths.py` | every writable location + the test seams + target validation |
| `aidn/logs.py` | logging that survives `--noconsole` (no `sys.stdout`) |
| `aidn/selfinfo.py` | reads the version back out of this executable's resource |
| `aidn/payload.py` | opens the embedded 7z, resolves the launch entry, cleans up |
| `aidn/procs.py` | stops processes holding the install directory (children first) |
| `aidn/registry.py` | uninstall key (HKLM when writable, else HKCU) + optional autostart |
| `aidn/shortcuts.py` | Start Menu / desktop links via `WScript.Shell` |
| `aidn/install.py` | the install / upgrade / uninstall transactions |
| `aidn/ui.py` | the window |
| `build_setup.py` | builds the exe: payload → `payload.7z` → PyInstaller → version resource |
| `version_info.py` | the Windows version resource (Company `PT-dove`, bilingual FileDescription) |
| `requirements.txt` | pinned build dependencies |
| `_selfcheck.py` | pure-logic checks (version parsing, path validation, argument parsing) |

## Build

```bat
python -m pip install --only-binary :all: -r deploy\windows\installer\app\requirements.txt
python deploy\windows\installer\app\build_setup.py ^
  --payload <payload-dir> --version 0.0.1-rc.2 --out dist\release\0.0.1-rc.2
```

`--payload` must be a directory produced by `deploy/embedded-runtime/build.mjs`
(`bundle.json` + `manifests/files.sha256`). The build refuses:

* a payload with no launchable entry point (an installer that installs nothing is not
  a smaller installer, it is a broken one);
* an archive that `7z t` passes but `py7zr` cannot decode. This actually happened, twice:

  1. 7-Zip added an **ARM64 BCJ** filter on top of LZMA2 for one block. `7z t` said OK,
     the build machine's `py7zr` said OK (`pybcj` knew the filter), and the **frozen**
     `py7zr` inside Setup.exe died with `UnsupportedCompressionMethodError` — on the
     user's machine, after the download.
  2. `-m0=LZMA2` did not help: the filter is added *on top of* the chosen method.
     `-mf=off` does.

The archive is therefore created with `-m0=LZMA2 -mf=off` and three checks run before
PyInstaller sees it: `7z t`, "no BCJ/Delta in the method list", and a `py7zr` read.

## Behaviour

* Default target `%ProgramFiles%\AIDriven NetDefense`; existing installations (registry
  first, then `install\install.json`) pre-fill the path and are upgraded in place.
* Upgrade never touches `data\`, and proves it: the largest data file is hashed before
  and after the copy.
* Autostart is off unless the user ticks it. **Nothing starts by itself**: no
  auto-install, no auto-launch after install, no auto-opened browser.
* Shortcut target is whatever the payload actually provides, in order:
  `AIDrivenNetDefense.exe` (and its `app\` / `console\` / `bin\` variants) →
  `launch\aegis-console.cmd` → `start.cmd` → `launch\aegis-daemon.cmd`.
  The resolved path is recorded as `desktopExe` + `entryKind` in `install.json`.
* Uninstall stops the daemon, removes shortcuts, clears autostart, deletes the tree,
  and keeps `data\` + `install\` when asked to.

## Silent mode

```bat
Setup.exe /S /DIR="D:\tmp\aidn" /NOREG /NOSHORTCUT
Setup.exe /uninstall /S /DIR="D:\tmp\aidn" /NOREG
```

`/NOREG` avoids the uninstall registry key, `/NOSHORTCUT` avoids every shortcut; both
exist so a smoke test does not modify the machine it runs on. Exit codes are in
`aidn/constants.py` (1 error, 2 usage, 3 payload, 4 entry, 6 not installed).

Test seams (never set in normal use): `AIDN_SETUP_DEFAULT_DIR`,
`AIDN_SETUP_STARTMENU_DIR`, `AIDN_SETUP_DESKTOP_DIR`, `AIDN_SETUP_PROGRAMDATA_DIR`.

## Known limits

* Processes are matched by executable path and its descendants. A daemon started
  independently (a launcher inside the directory, started by hand) is not matched;
  deleting it then fails on locked files and the failure is logged, not hidden.
* Shortcut creation needs PowerShell (`WScript.Shell`); a machine with PowerShell
  removed installs without shortcuts and reports it in the result.
* No increment/delta update and no `adopt` (portable → installed) yet — that is D3 in
  `DIST-DECISION.md`, not this task.
