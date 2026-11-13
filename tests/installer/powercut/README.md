# `tests/installer/powercut/**` — round-5 power-cut seat (POST-SHIP-PATH)

Owner: teammate `powercut-r5` (Lead `lead`). Scope of this directory: **scripts only**
(`*.ps1`, `*.py`, `*.mjs`, docs). Evidence goes to `evidence/upgrade/powercut/r5/**`;
scratch trees live in `%TEMP%\upgrade-path\r5\powercut\**`.

## What this seat proves

A user starts an **rc.5 → rc.6 overwrite upgrade** and the machine loses power *while the
program files are being copied*. Three questions have to be answered with real evidence,
not with reasoning:

1. **Can the directory be recovered?** (immediate direct reinstall: expected refusal with
   zero writes)
2. **Can it be reinstalled at all?** (documented recovery path: move data out → delete the
   half-new tree → clean rc.6 install → move data back)
3. **Is the user data damaged?** (`<target>\data` and `%LOCALAPPDATA%\AIDriven NetDefense\data`
   per-file sha256 zero diff, and the restored database still opens with its audit chain
   intact)

Plus a **control**: the same cloned base tree, same factory rc.6 Setup, no kill → the
upgrade completes, which is what proves the failure was caused by the kill and not by the
environment.

## Serial protocol (hard, per ACTIVE-NOTICE N-028 §7 / N-040 §3 / N-042)

The product's uninstall cleanup is **not isolated by `/DIR=`**, so two sessions installing
or uninstalling at the same time delete each other's global Run value / uninstall keys /
start-menu folder. Therefore:

* this seat only runs after the upgrade seat (`upgrade-r5`) has removed
  `%TEMP%\upgrade-path\r5\WINDOW.lock`;
* `powercut5.ps1` refuses (`Assert-WindowFree` / `Assert-NoForeignInstaller`) when the lock
  file exists or another `AIDrivenNetDefense-Setup` / `AIDrivenNetDefense` process is alive;
* every step is a separate process, so a tool-call timeout can never leave a partially
  realised step unrecorded.

## Files

| file | purpose |
|---|---|
| `powercut5.ps1` | the only entry point; `-Step preflight\|cold\|seed\|clone\|kill\|reinstall\|recovery\|control\|cleanup`, `-Point K1\|K2\|CONTROL` |
| `tools/host-snapshot.ps1` | Run value / HKCU+HKLM+WOW uninstall keys / start menu / desktop / `%ProgramFiles%` / product processes / `%LOCALAPPDATA%` data, plus a `zero` verdict |
| `tools/tree-state.ps1` | file count, tree entries, key-file sha256 (entry exe, `manifests\files.sha256`, `install\install.json`, `bundle.json`), and an `inventoryDigest` over sorted `path\tbytes` (cheap "did anything get written" proof) |
| `tools/fingerprint.ps1` / `tools/compare-fingerprint.ps1` | per-file sha256 TSV and an added/removed/changed/resized diff |
| `tools/process-family.ps1` | enumerate the whole installer family (same image path — PyInstaller parent + child — plus all descendants), kill deepest-first, then poll until `aliveAfter = 0` |
| `tools/manifest-audit.py` | two-generation manifest comparison: which 47 rows differ, which of them landed on disk, the first data row, and the shipped `_manifest_has_rows` sampling window evaluated against each generation |
| `tools/marker-probe.py` | what the **shipped** `aidn/install.py` guards say about a tree (`_install_marker` / `_upgrade_marker` / `_manifest_has_rows` / ownership verify) — not a re-implementation |
| `tools/resign-clone.py` | re-issue the path-bound ownership credential for a robocopy clone, so the clone is credential-equivalent to an install performed at that path (N-042 §3 records the as-copied `installMarker=null` state) |
| `tools/seed-data.mjs` | real product data tree via `packages/event-store` (`ingestTelemetry`), not a hand-written SQLite file |
| `tools/open-store.mjs` | open the restored database with the product's own store and verify the audit chain (`hmacVerified`) |
| `tools/selfcheck.ps1` | **no-host-side-effect** self-test of all of the above on miniature payloads (`tests/installer/fixtures/r3-make-payload.py`), TEMP/start-menu/desktop/ProgramData redirected, `/NOREG /NOSHORTCUT` |

## Running it

```pwsh
# 0) only after WINDOW.lock is gone and the Lead said GO
pwsh -NoProfile -File tests/installer/powercut/tools/selfcheck.ps1      # exit 0 = tools OK
pwsh -NoProfile -File tests/installer/powercut/powercut5.ps1 -Step preflight
pwsh -NoProfile -File tests/installer/powercut/powercut5.ps1 -Step cold     # ~300-360 s
pwsh -NoProfile -File tests/installer/powercut/powercut5.ps1 -Step seed
pwsh -NoProfile -File tests/installer/powercut/powercut5.ps1 -Step clone -Point K1
pwsh -NoProfile -File tests/installer/powercut/powercut5.ps1 -Step kill  -Point K1   # kill in copy phase
pwsh -NoProfile -File tests/installer/powercut/powercut5.ps1 -Step reinstall -Point K1
pwsh -NoProfile -File tests/installer/powercut/powercut5.ps1 -Step recovery  -Point K1
# ... same for K2 and CONTROL (control = clone + upgrade to completion, no kill)
pwsh -NoProfile -File tests/installer/powercut/powercut5.ps1 -Step cleanup
```

`-InstallArgs` defaults to `/NOREG /NOSHORTCUT`: no uninstall key, no shortcuts, no
autostart, so no criterion in this seat depends on the registry. Every install still writes
the install record, the payload manifest and the ownership credential inside the target
tree, which is exactly what the criteria read.

## Kill-point definition (content, not a stopwatch)

The kill is triggered by the state the shipped guards look at:

```
<tree>\AIDrivenNetDefense.exe        == rc.6 bytes   (48716D63…)
<tree>\manifests\files.sha256        == rc.5 file     (33C9FF45…)
```

`-KillAfterMs` is measured from the moment the installer log prints `复制程序文件`. K1 uses
1.5 s (early in the copy), K2 uses 75 s (mid/late copy). If the installer finishes before
the delay the step **refuses to kill** and records `installer-exited-before-kill` instead of
inventing a power-cut.
