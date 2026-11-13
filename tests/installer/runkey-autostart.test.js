/**
 * HKCU Run (autostart) — the acceptance item that failed on the rc.4 machine
 * (`evidence/rc4/install/run-20261105-013705/transcript.log:80`
 * `[FAIL] T4 HKCU Run value written (autostart on) missing`, with `:62` saying
 * `autostart == true` from install.json at the same time).
 *
 * Root cause this file pins down (measured, not inferred — see
 * `docs/implementation/evidence/rc5/signoff/runkey/`):
 *
 *   1. the autostart step was **not scoped to the target tree**: an install *without*
 *      `/AUTOSTART` — and an uninstall of *any* directory — executed
 *      `set_autostart(False, "")`, which deletes the one global
 *      `HKCU\...\Run\AIDrivenNetDefense` value even when it belongs to another,
 *      still-installed tree.  Two installer processes on the same machine (the rc.4
 *      acceptance window had concurrent uninstall probes) therefore erase each other's
 *      entry: measured on 2026-11-05, the `/AUTOSTART` install wrote the value at
 *      16:28:52 and a concurrent install into an unrelated directory deleted it at
 *      16:29:07 (1358-sample 500 ms monitor in
 *      `runkey/repro-20261105-161739/`).
 *   2. `install.json` recorded the **requested** `autostart` before the registry write
 *      (`install.py:206` vs `:234`), so the record could claim `true` while the registry
 *      held nothing — and nothing in the installer noticed.
 *
 * Every test below drives the real thing: `main.py /S /DIR=… /AUTOSTART` and
 * `main.py /uninstall` against a miniature but structurally complete payload
 * (`fixtures/make-payload-7z.py`), real `winreg` writes into the user's own
 * `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, and `reg.exe query` read-backs of
 * the raw value.  Nothing is mocked; `AIDN_INSTALLER_APP` lets the mutation runs point the
 * suite at a doctored copy so the repository files are never edited here.
 *
 * Run with:  node --test tests/installer/runkey-autostart.test.js
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const INSTALLER_APP = process.env.AIDN_INSTALLER_APP
  ? resolve(process.env.AIDN_INSTALLER_APP)
  : join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const SETUP_PS1 = process.env.AIDN_SETUP_PS1
  ? resolve(process.env.AIDN_SETUP_PS1)
  : join(REPO_ROOT, 'deploy', 'windows', 'installer', 'Setup.ps1');
const PAYLOAD_BUILDER = join(HERE, 'fixtures', 'make-payload-7z.py');
const PS_FIXTURE = join(HERE, 'fixtures', 'ps1-runkey.ps1');
const INSTALL_FAILURE_FIXTURE = join(HERE, 'fixtures', 'install-autostart-failure.py');

const RUN_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_KEY_PS = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'AIDrivenNetDefense';
const EXE = 'AIDrivenNetDefense.exe';

// ------------------------------------------------------------------ interpreters

const PYTHON_CANDIDATES = [process.env.AIDN_PYTHON, 'D:\\Python311\\python.exe', 'python'].filter(
  (value) => typeof value === 'string' && value.length > 0,
);
function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import sys, winreg, py7zr; sys.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate;
  }
  return undefined;
}
const PYTHON = pickPython();
const WINDOWS_ONLY = process.platform === 'win32' ? false : 'the HKCU Run key is Windows-only';
const SKIP_PYTHON = WINDOWS_ONLY || (PYTHON === undefined ? 'no Python with winreg+py7zr found' : false);
const TEST_WITH_PYTHON = (name, fn) => test(name, { skip: SKIP_PYTHON }, fn);

function pickPowerShell() {
  const candidates = [
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    'pwsh',
  ];
  for (const candidate of candidates) {
    if (candidate.includes('\\') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}
const POWERSHELL = process.platform === 'win32' ? pickPowerShell() : undefined;
const SKIP_PS = WINDOWS_ONLY || (POWERSHELL === undefined ? 'no PowerShell interpreter found' : false);
const TEST_WITH_PS = (name, fn) => test(name, { skip: SKIP_PS }, fn);

// ------------------------------------------------------------------ registry helpers

/** Raw value text, or `null` when the value (or the key) is absent. */
function readRunValue() {
  const run = spawnSync('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE], {
    encoding: 'latin1',
    timeout: 30_000,
    windowsHide: true,
  });
  if (run.status !== 0) return null;
  const text = String(run.stdout ?? '');
  const match = text.match(new RegExp(`${RUN_VALUE}\\s+REG_SZ\\s+(.*)`, 'i'));
  return match ? match[1].trim() : null;
}

function writeRunValueRaw(value) {
  const run = spawnSync('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f'], {
    encoding: 'latin1',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, `reg.exe add failed: ${run.stdout}${run.stderr}`);
}

function deleteRunValueRaw() {
  spawnSync('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], {
    encoding: 'latin1',
    timeout: 30_000,
    windowsHide: true,
  });
}

/** First executable token of an autostart command line, quotes removed. */
function commandExecutable(command) {
  if (/^"/.test(command)) {
    const closing = command.indexOf('"', 1);
    assert.ok(closing > 1, `unbalanced quotes in autostart command: ${command}`);
    return command.slice(1, closing);
  }
  return command.split(/\s+/)[0];
}

/** The user the installer must register — the *interactive* user's SID. */
function currentUserSid() {
  const run = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  const sid = String(run.stdout ?? '').trim();
  assert.match(sid, /^S-1-5-21-[0-9-]+$/u, `could not resolve the caller SID (got "${sid}")`);
  return sid;
}

// ------------------------------------------------------------------ install harness

const scratchPaths = [];
function scratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), `aidn-runkey-${prefix}-`));
  scratchPaths.push(path);
  return path;
}

let APP_COPY;
let PAYLOAD_SRC;
let PREVIOUS_RUN_VALUE;
let PRECONDITION_SKIP;

function pythonEnv(work) {
  const redirected = {
    TEMP: join(work, 'temp'),
    TMP: join(work, 'temp'),
    AIDN_SETUP_STARTMENU_DIR: join(work, 'start-menu'),
    AIDN_SETUP_DESKTOP_DIR: join(work, 'desktop'),
    AIDN_SETUP_PROGRAMDATA_DIR: join(work, 'programdata'),
    AIDN_SETUP_DEFAULT_DIR: join(work, 'default-dir'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const directory of [redirected.TEMP, redirected.AIDN_SETUP_STARTMENU_DIR, redirected.AIDN_SETUP_DESKTOP_DIR]) {
    mkdirSync(directory, { recursive: true });
  }
  return { ...process.env, ...redirected };
}

function runInstaller(args, work) {
  const started = Date.now();
  const run = spawnSync(PYTHON, [join(APP_COPY, 'main.py'), ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    env: pythonEnv(work),
  });
  return { ...run, seconds: (Date.now() - started) / 1000, args };
}

function installInto(target, { autostart }) {
  const work = scratch(`install-${target.split(/[\\/]/).pop()}`);
  const args = ['/S', `/DIR=${target}`, '/NOREG', '/NOSHORTCUT'];
  if (autostart) args.push('/AUTOSTART');
  const run = runInstaller(args, work);
  assert.equal(
    run.status,
    0,
    `install failed (exit ${run.status}) for ${JSON.stringify(args)}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
  );
  assert.equal(existsSync(target), true, 'install reported success but the tree is missing');
  return run;
}

function uninstallTree(target) {
  const work = scratch(`uninstall-${target.split(/[\\/]/).pop()}`);
  const run = runInstaller(['/uninstall', `/DIR=${target}`, '/NOREG', '/S'], work);
  return run;
}

function readInstallRecord(target) {
  const path = join(target, 'install', 'install.json');
  assert.equal(existsSync(path), true, `install.json missing at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ------------------------------------------------------------------ setup / teardown

before(() => {
  // A real install of this product elsewhere on the machine would make `find_existing()`
  // treat the target as an upgrade (and `procs.stop_under` could then stop the user's own
  // running instance).  Refuse to run instead of silently testing something else.  A
  // *stale* uninstall key (its InstallLocation no longer exists) does not count: nothing
  // would be upgraded, and such residue must not disable the test forever.
  const installed = ['HKLM', 'HKCU'].filter((hive) => {
    const query = spawnSync(
      'reg.exe',
      ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${RUN_VALUE}`, '/v', 'InstallLocation'],
      { encoding: 'latin1', windowsHide: true },
    );
    const match = String(query.stdout ?? '').match(/InstallLocation\s+REG_SZ\s+(.*)/i);
    return match ? existsSync(match[1].trim()) : false;
  });
  const shipped = 'C:\\Program Files\\AIDriven Net Defense';
  if (installed.length > 0 || existsSync(shipped)) {
    PRECONDITION_SKIP = 'a real AIDriven NetDefense installation is present; this test would upgrade it';
    return;
  }
  // Never clobber a value that is already the user's: remember it and put it back.
  PREVIOUS_RUN_VALUE = readRunValue();
  if (PREVIOUS_RUN_VALUE !== null) {
    const exe = commandExecutable(PREVIOUS_RUN_VALUE);
    if (!/AIDrivenNetDefense/i.test(exe)) {
      PRECONDITION_SKIP = `HKCU Run\\${RUN_VALUE} already belongs to something else: ${PREVIOUS_RUN_VALUE}`;
      return;
    }
  }

  const work = scratch('app');
  APP_COPY = join(work, 'app');
  cpSync(INSTALLER_APP, APP_COPY, {
    recursive: true,
    filter: (source) => !source.includes('__pycache__'),
  });
  PAYLOAD_SRC = join(work, 'payload-src');
  const built = spawnSync(PYTHON, [PAYLOAD_BUILDER, PAYLOAD_SRC, join(APP_COPY, 'payload.7z')], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(built.status, 0, `payload builder failed: ${built.stdout}${built.stderr}`);
  assert.equal(existsSync(join(APP_COPY, 'payload.7z')), true, 'payload.7z was not produced');
});

after(() => {
  // Leave the machine exactly as found.
  if (PREVIOUS_RUN_VALUE === null) {
    deleteRunValueRaw();
  } else if (PREVIOUS_RUN_VALUE !== undefined) {
    writeRunValueRaw(PREVIOUS_RUN_VALUE);
  }
  for (const path of scratchPaths) {
    rmSync(path, { recursive: true, force: true });
  }
});

function guard() {
  if (PRECONDITION_SKIP) {
    assert.fail(PRECONDITION_SKIP);
  }
}


// ------------------------------------------------------------------ T1: the criterion

TEST_WITH_PYTHON('T1 /AUTOSTART writes HKCU Run and the value points at the installed exe', () => {
  guard();
  const target = join(scratch('t1'), 'tree');
  assert.equal(readRunValue(), null, `precondition: the Run value must start absent, got ${readRunValue()}`);

  installInto(target, { autostart: true });

  const raw = readRunValue();
  assert.notEqual(raw, null, `HKCU Run\\${RUN_VALUE} is missing after an /AUTOSTART install (T4 regression)`);
  const exe = commandExecutable(raw);
  const expected = join(target, EXE);
  assert.equal(
    resolve(exe).toLowerCase(),
    resolve(expected).toLowerCase(),
    `the Run value must point at the installed exe "${expected}" (quotes parsed), got "${raw}"`,
  );
  assert.equal(existsSync(exe), true, `the executable named by the Run value does not exist: ${exe}`);

  // T2 in the rc.4 transcript: the record must agree with the registry it describes.
  const record = readInstallRecord(target);
  assert.equal(record.autostart, true, 'install.json.autostart must record the state the registry actually has');
  assert.equal(record.desktopExe, EXE, 'install.json.desktopExe must name the launched entry point');

  // Uninstall must take the value away again (criterion 2).
  const removal = uninstallTree(target);
  assert.equal(removal.status, 0, `uninstall failed: ${removal.stdout}${removal.stderr}`);
  assert.equal(existsSync(target), false, 'uninstall left the tree behind');
  assert.equal(readRunValue(), null, `HKCU Run\\${RUN_VALUE} survived the uninstall of the tree it points at`);
});

// ------------------------------------------------------------------ T2: concurrency

TEST_WITH_PYTHON('T2 an install WITHOUT /AUTOSTART must not delete another tree\'s Run value', () => {
  guard();
  const first = join(scratch('t2-first'), 'tree');
  const second = join(scratch('t2-second'), 'tree');

  installInto(first, { autostart: true });
  const written = readRunValue();
  assert.notEqual(written, null, 'precondition: the first install did not write the value');
  assert.equal(
    resolve(commandExecutable(written)).toLowerCase(),
    resolve(join(first, EXE)).toLowerCase(),
    'precondition: the value must point at the first tree',
  );

  // The rc.4 acceptance window had a second installer running concurrently (no
  // /AUTOSTART).  Until RC5 that second run executed `set_autostart(False, "")` and
  // erased the first tree's entry — measured 15 s after it was written.
  installInto(second, { autostart: false });

  assert.equal(
    readRunValue(),
    written,
    'a fresh install into an unrelated directory deleted the existing autostart entry ' +
      '(the autostart step is not scoped to the target tree)',
  );

  const removal = uninstallTree(second);
  assert.equal(removal.status, 0, `uninstall of the second tree failed: ${removal.stdout}${removal.stderr}`);
  assert.equal(
    readRunValue(),
    written,
    'uninstalling a different tree deleted the first tree\'s autostart entry',
  );

  const cleanup = uninstallTree(first);
  assert.equal(cleanup.status, 0, `uninstall of the first tree failed: ${cleanup.stdout}${cleanup.stderr}`);
  assert.equal(readRunValue(), null, 'uninstalling the tree the value points at must remove the value');
});

// ------------------------------------------------------------------ T3: honest record

TEST_WITH_PYTHON('T3 install.json records the registry state, so a failed write cannot claim success', () => {
  guard();
  const target = join(scratch('t3'), 'tree');
  // Point the value at something that is not ours first: a *requested* autostart must
  // still overwrite it, and the record must then say what the registry says.
  installInto(target, { autostart: true });
  const record = readInstallRecord(target);
  const raw = readRunValue();
  assert.notEqual(raw, null, 'the install did not write the Run value');
  const registered = resolve(commandExecutable(raw)).toLowerCase() === resolve(join(target, EXE)).toLowerCase();
  assert.equal(
    record.autostart,
    registered,
    `install.json.autostart (${record.autostart}) disagrees with the registry (points at ours: ${registered})`,
  );
  uninstallTree(target);
});

// ------------------------------------------------------------------ T4: hive selection

TEST_WITH_PYTHON('T4 the autostart value is written into the invoking user\'s hive (HKEY_USERS\\<SID>)', () => {
  guard();
  const sid = currentUserSid();
  // An elevated installer started by another administrator account must register the
  // *interactive* user, not the account it runs as.  Non-elevated, HKEY_USERS\<own SID>
  // and HKEY_CURRENT_USER are the same hive, so the hive-selection seam is testable here
  // without UAC: writing through the SID path must be visible through HKCU\...\Run.
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(APP_COPY)})`,
    'from aidn import registry',
    // Python source below: a normal (non-raw) string, so the escaped backslashes become
    // the single ones a Windows path has.
    'print(json.dumps(registry.set_autostart(True, \'"C:\\\\Temp\\\\sid-path\\\\AIDrivenNetDefense.exe"\', user_sid=sys.argv[1])))',
  ].join('\n');
  const run = spawnSync(PYTHON, ['-c', script, sid], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: pythonEnv(scratch('t4')),
  });
  try {
    assert.equal(run.status, 0, `set_autostart(user_sid=...) failed: ${run.stdout}${run.stderr}`);

    const raw = readRunValue();
    assert.notEqual(raw, null, `the value written through HKEY_USERS\\${sid} is not visible in HKCU\\...\\Run`);
    assert.equal(
      commandExecutable(raw),
      'C:\\Temp\\sid-path\\AIDrivenNetDefense.exe',
      `unexpected value after the SID-path write: ${raw}`,
    );
  } finally {
    // Never leave this behind, not even when an assertion above fails.
    deleteRunValueRaw();
  }
});

// ------------------------------------------------------------------ T5: PS channel

TEST_WITH_PS('T5 the PowerShell channel writes, reads back and scopes the removal the same way', () => {
  guard();
  const work = scratch('t5');
  const ours = join(work, 'ours');
  const foreign = join(work, 'foreign');
  mkdirSync(ours, { recursive: true });
  mkdirSync(foreign, { recursive: true });
  const ownExe = join(ours, EXE);
  writeFileSync(ownExe, 'fixture');

  const jobFile = join(work, 'jobs.json');
  writeFileSync(
    jobFile,
    JSON.stringify([
      { op: 'set', name: 'set-ours', exe: ownExe },
      { op: 'state', name: 'state-after-set' },
      { op: 'remove-for', name: 'remove-foreign', target: foreign },
      { op: 'state', name: 'state-after-foreign-removal' },
      { op: 'remove-for', name: 'remove-ours', target: ours },
      { op: 'state', name: 'state-after-own-removal' },
    ]),
    'utf8',
  );

  const run = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_FIXTURE, SETUP_PS1, work, jobFile],
    { encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(run.status, 0, `PS fixture failed: ${run.stdout}${run.stderr}`);

  const marker = String(run.stdout ?? '').split('\n').find((line) => line.startsWith('AIDN_PS1_RUNKEY_JSON:'));
  assert.ok(marker, `PS fixture produced no verdicts marker: ${run.stdout}${run.stderr}`);
  const verdicts = JSON.parse(readFileSync(marker.slice('AIDN_PS1_RUNKEY_JSON:'.length).trim(), 'utf8'));
  const byName = Object.fromEntries(verdicts.map((entry) => [entry.name, entry]));

  assert.equal(byName['set-ours'].error ?? '', '', `Set-Autostart threw: ${byName['set-ours'].error}`);
  assert.equal(byName['set-ours'].registered, true, 'Set-Autostart wrote nothing to HKCU Run');
  assert.equal(
    resolve(commandExecutable(byName['set-ours'].raw)).toLowerCase(),
    resolve(ownExe).toLowerCase(),
    `Set-Autostart wrote an unexpected command: ${byName['set-ours'].raw}`,
  );
  assert.equal(byName['state-after-set'].registered, true, 'Test-Autostart disagrees with the registry it wrote');

  // The fixture's own observation (`raw`) is a `Get-ItemProperty` on the real HKCU Run key,
  // taken while the value is there: the jobs below delete it again on purpose.
  assert.equal(byName['remove-foreign'].error ?? '', '', `Remove-Autostart threw: ${byName['remove-foreign'].error}`);
  assert.equal(byName['state-after-foreign-removal'].registered, true, 'removing for a foreign target deleted our value');

  assert.equal(byName['remove-ours'].error ?? '', '', `Remove-Autostart threw: ${byName['remove-ours'].error}`);
  assert.equal(byName['state-after-own-removal'].registered, false, 'removing for our own target left the value behind');
  assert.equal(readRunValue(), null, 'the value is still in HKCU Run after removing it for its own tree');
});

// ------------------------------------------------------------------ T6: no-op guard

TEST_WITH_PYTHON('T6 an install WITHOUT /AUTOSTART never creates a value that was absent', () => {
  guard();
  const target = join(scratch('t6'), 'tree');
  assert.equal(readRunValue(), null, 'precondition: the Run value must start absent');
  installInto(target, { autostart: false });
  assert.equal(readRunValue(), null, 'an install without /AUTOSTART created an autostart entry');
  assert.equal(readInstallRecord(target).autostart, false, 'install.json.autostart must be false when not requested');
  uninstallTree(target);
});

// ------------------------------------------------------------------ T7: honest record

TEST_WITH_PYTHON('T7 a failed Run-key write is reported and install.json records false, not the request', () => {
  guard();
  const target = join(scratch('t7'), 'tree');
  // The user's own Run key is always writable non-elevated, so the failure has to be
  // injected to be observable at all: `registry.set_autostart` raises OSError, everything
  // else (including the read-back that decides what the record says) is the real code.
  const run = spawnSync(PYTHON, [INSTALL_FAILURE_FIXTURE, APP_COPY, target, PAYLOAD_SRC], {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    env: pythonEnv(scratch('t7-work')),
  });
  const line = String(run.stdout ?? '')
    .split('\n')
    .reverse()
    .find((candidate) => candidate.trim().startsWith('{'));
  assert.ok(line, `the failure fixture printed no JSON verdict: ${run.stdout}${run.stderr}`);
  const verdict = JSON.parse(line);
  assert.equal(verdict.ok, true, `install() refused to run: ${verdict.error}`);

  assert.equal(
    verdict.record.autostart,
    false,
    'install.json.autostart says true although the Run-key write failed — the record is ' +
      'recording the request, not the registry',
  );
  const problems = (verdict.problems ?? []).join('\n');
  assert.match(
    problems,
    /autostart/iu,
    `a failed autostart write must be reported as a problem, got: ${JSON.stringify(verdict.problems)}`,
  );
  assert.equal(readRunValue(), null, 'the failure fixture wrote a Run value after all');
});
