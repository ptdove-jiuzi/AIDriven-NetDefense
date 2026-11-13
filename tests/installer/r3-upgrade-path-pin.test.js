/**
 * r3-upgrade-path-pin.test.js — pin the three upgrade-path behaviours measured in the
 * round-3 campaign (`status/UPGRADE-PATH.md` §round-3, `evidence/upgrade/r3/**`).
 *
 * The round-3 runs used the frozen rc.4 Setup + a source-built rc.6 candidate and took
 * ~25–35 minutes per install.  These tests reproduce the *decisive* part of each scenario
 * with the miniature but structurally complete payload (`fixtures/r3-make-payload.py`:
 * real `bundle.json`, real entry point, real `manifests/files.sha256` whose digests match
 * the bytes) driven through the shipped `main.py`, so the guards under test are the real
 * ones (`install._install_marker`, `_upgrade_marker`, `_manifest_has_rows`) and not a
 * re-implementation.
 *
 * Three facts are pinned, each of them a **measured behaviour**, including the two that
 * are defects:
 *
 *   1. **Overwrite upgrade keeps the data and names the source version** — the pair
 *      `install.json.version` / `upgradedFrom` is what the real rc.4 -> rc.6 run showed.
 *   2. **A downgrade is NOT refused** (P2).  The installer compares no version direction:
 *      an "older" installer overwrites a "newer" tree, exits 0, and records
 *      `version=<older> / upgradedFrom=<newer>`.  The store layer is the only fail-closed
 *      one (`ERR_SCHEMA_TOO_NEW`, pinned in tests/wp1-event-store/downgrade-refusal.test.js).
 *      If this assertion ever goes red because the installer started refusing older
 *      versions, that is the fix landing — re-measure `evidence/upgrade/r3/**` and update
 *      the report; do not delete the assertion silently.
 *   3. **An interrupted copy locks the tree** (P1).  When the payload files landed but the
 *      old `manifests/files.sha256` is still on disk, both guards answer `None`: the
 *      installer refuses before extracting (exit 1) and uninstall refuses and deletes
 *      nothing (exit 5).  The only recovery that works is the one the campaign verified:
 *      move `data\` out -> delete the tree -> clean install -> move `data\` back.
 *
 * No host side effects: every run is `/NOREG` (no uninstall key), `/NOSHORTCUT`, with
 * `TEMP`, Start Menu, Desktop, ProgramData and the default target redirected into the
 * test's scratch directory, and never touches `%ProgramFiles%`.
 *
 * Run with:  node --test tests/installer/r3-upgrade-path-pin.test.js
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const APP_DIR = process.env.AIDN_INSTALLER_APP
  ? resolve(process.env.AIDN_INSTALLER_APP)
  : join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const PAYLOAD_BUILDER = join(HERE, 'fixtures', 'r3-make-payload.py');
const MARKER_PROBE = join(HERE, 'fixtures', 'r3-marker-probe.py');
const INSTALL_PY = join(APP_DIR, 'aidn', 'install.py');
const REGISTRY_PY = join(APP_DIR, 'aidn', 'registry.py');

/** Version stamps given to the two copies; they only have to sort differently, because
 * the pin is that *nothing in the installer sorts them*. */
const VERSION_NEW = '0.0.1-rc.9-r3pin';
const VERSION_OLD = '0.0.1-rc.8-r3pin';

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
const SKIP = process.platform !== 'win32'
  ? 'the installer is Windows-only'
  : (PYTHON === undefined ? 'no Python with winreg+py7zr found' : false);
const WITH_PYTHON = (name, fn) => test(name, { skip: SKIP }, fn);

// ------------------------------------------------------------------ scratch helpers

const scratchPaths = [];
function scratch(name) {
  const path = mkdtempSync(join(tmpdir(), `aidn-r3-${name}-`));
  scratchPaths.push(path);
  return path;
}

after(() => {
  for (const path of scratchPaths) rmSync(path, { recursive: true, force: true });
});

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** `{relativePath: {bytes, sha256}}` for every file under `dir` ('' when absent). */
function fingerprint(dir) {
  const out = {};
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else out[rel] = { bytes: statSync(full).size, sha256: sha256File(full) };
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** `{relativePath: sha256}` for tree comparison without bytes noise. */
const digestTree = (dir) => Object.fromEntries(
  Object.entries(fingerprint(dir)).map(([rel, row]) => [rel, row.sha256]),
);

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

/** Run the shipped `main.py` with a redirected environment.  Returns the spawn result. */
function runInstaller(appDir, args, work) {
  const started = Date.now();
  const run = spawnSync(PYTHON, [join(appDir, 'main.py'), ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    env: pythonEnv(work),
  });
  return { ...run, seconds: (Date.now() - started) / 1000, args };
}

/** What the shipped guards say about a tree (see fixtures/r3-marker-probe.py). */
function probeMarkers(appDir, target) {
  const run = spawnSync(PYTHON, [MARKER_PROBE, appDir, target], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, `marker probe failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** Copy the installer app and give it a fixed version stamp (a copy: deploy/** is never edited). */
function prepareApp(destination, version) {
  cpSync(APP_DIR, destination, {
    recursive: true,
    filter: (source) => !source.includes('__pycache__'),
  });
  const constantsPath = join(destination, 'aidn', 'constants.py');
  const text = readFileSync(constantsPath, 'utf8');
  const patched = text.replace(/^DEV_VERSION = .*$/mu, `DEV_VERSION = ${JSON.stringify(version)}`);
  assert.notEqual(patched, text, 'constants.py must still declare DEV_VERSION for this fixture to stamp a version');
  writeFileSync(constantsPath, patched);
  const recorded = spawnSync(PYTHON, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from aidn import selfinfo; sys.stdout.write(selfinfo.product_version())', destination], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(recorded.status, 0, `version probe failed: ${recorded.stderr}`);
  assert.equal(recorded.stdout, version, 'the copy must report the stamped version');
}

// ------------------------------------------------------------------ scenario state

const WORK = scratch('pin');
let appNew;
let appOld;
let payloadSrcNew;
let payloadSrcOld;
let SKIP_REASON = SKIP;
const A = {}; // scenario A: downgrade
const B = {}; // scenario B: interrupted copy
const C = {}; // scenario C: recovery

/**
 * A live install elsewhere on the machine would make `find_existing()` treat our scratch
 * target as an upgrade of *that* tree (and `procs.stop_under` would then look at the
 * user's processes).  Same guard as runkey-autostart.test.js: refuse to measure on a
 * machine that is not clean.
 */
function liveInstallHives() {
  return ['HKLM', 'HKCU'].filter((hive) => {
    const query = spawnSync(
      'reg.exe',
      ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AIDrivenNetDefense`, '/v', 'InstallLocation'],
      { encoding: 'latin1', windowsHide: true },
    );
    const match = String(query.stdout ?? '').match(/InstallLocation\s+REG_SZ\s+(.*)/i);
    return match ? existsSync(match[1].trim()) : false;
  });
}

// The check runs at definition time on purpose: the "dirty host" case must contribute a
// SINGLE skip (see the DIRTY branch below), not one skip per scenario, because
// `test:installer` allows at most four skips before the floor gate refuses the run.
const dirtyHives = SKIP ? [] : liveInstallHives();
const DIRTY = dirtyHives.length > 0;
if (DIRTY) {
  SKIP_REASON = `a real AIDriven NetDefense installation is present (${dirtyHives.join(', ')}); this fixture would treat it as an upgrade source`;
}

before(() => {
  if (SKIP_REASON) return;

  // --- two installer copies that differ only in the version they stamp
  appNew = join(WORK, 'app-new');
  appOld = join(WORK, 'app-old');
  prepareApp(appNew, VERSION_NEW);
  prepareApp(appOld, VERSION_OLD);

  // --- miniature payloads (the "new" one differs from the "old" one byte for byte)
  payloadSrcNew = join(WORK, 'payload-new');
  payloadSrcOld = join(WORK, 'payload-old');
  mkdirSync(payloadSrcNew, { recursive: true });
  mkdirSync(payloadSrcOld, { recursive: true });
  for (const [source, app, tag] of [
    [payloadSrcNew, appNew, 'payload-new-r3'],
    [payloadSrcOld, appOld, 'payload-old-r3'],
  ]) {
    const built = spawnSync(PYTHON, [PAYLOAD_BUILDER, source, join(app, 'payload.7z'), tag], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    assert.equal(built.status, 0, `payload builder failed: ${built.stdout}${built.stderr}`);
    assert.equal(existsSync(join(app, 'payload.7z')), true, 'payload.7z was not produced');
  }

  // ---------------------------------------------------------------- A: downgrade
  A.tree = join(WORK, 'tree-downgrade');
  A.installNew = runInstaller(appNew, ['/S', `/DIR=${A.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('a-new'));
  A.recordAfterNew = readJson(join(A.tree, 'install', 'install.json'));
  A.exeAfterNew = sha256File(join(A.tree, 'AIDrivenNetDefense.exe'));

  A.installOld = runInstaller(appOld, ['/S', `/DIR=${A.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('a-old'));
  A.recordAfterOld = readJson(join(A.tree, 'install', 'install.json'));
  A.exeAfterOld = sha256File(join(A.tree, 'AIDrivenNetDefense.exe'));
  A.oldPayloadExe = sha256File(join(payloadSrcOld, 'AIDrivenNetDefense.exe'));
  A.newPayloadExe = sha256File(join(payloadSrcNew, 'AIDrivenNetDefense.exe'));

  // ---------------------------------------------------------------- B: interrupted copy
  B.tree = join(WORK, 'tree-half');
  B.installOld = runInstaller(appOld, ['/S', `/DIR=${B.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('b-old'));
  // user data that must survive everything
  const dataDir = join(B.tree, 'data');
  mkdirSync(join(dataDir, 'store'), { recursive: true });
  writeFileSync(join(dataDir, 'seed.txt'), 'r3 pin: synthetic user data\n');
  writeFileSync(join(dataDir, 'store', 'seed.db'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 251)));
  B.dataBefore = digestTree(dataDir);
  B.manifestBeforeInstallAttempt = sha256File(join(B.tree, 'manifests', 'files.sha256'));
  B.recordBeforeInstallAttempt = readJson(join(B.tree, 'install', 'install.json'));

  // The shape the real run left behind: the payload's files already landed (the exe and
  // bundle.json are the new bytes) while `install.json` and `manifests/files.sha256` are
  // still the old ones.  `_manifest_has_rows` samples the first three rows, and the first
  // data row of the manifest is the entry exe, so this state is deterministic, not lucky.
  cpSync(join(payloadSrcNew, 'AIDrivenNetDefense.exe'), join(B.tree, 'AIDrivenNetDefense.exe'));
  cpSync(join(payloadSrcNew, 'bundle.json'), join(B.tree, 'bundle.json'));
  B.treeBeforeAttempt = digestTree(B.tree);
  B.markers = probeMarkers(appNew, B.tree);

  B.reinstall = runInstaller(appNew, ['/S', `/DIR=${B.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('b-reinstall'));
  B.treeAfterReinstallAttempt = digestTree(B.tree);

  B.uninstall = runInstaller(appNew, ['/uninstall', `/DIR=${B.tree}`, '/NOREG', '/S', '/KEEPDATA'], scratch('b-uninstall'));
  B.treeAfterUninstallAttempt = digestTree(B.tree);
  B.dataAfterUninstallAttempt = digestTree(join(B.tree, 'data'));

  // ---------------------------------------------------------------- C: the recovery path
  C.dataOut = join(WORK, 'data-out');
  renameSync(join(B.tree, 'data'), C.dataOut);
  rmSync(B.tree, { recursive: true, force: true });
  C.cleanInstall = runInstaller(appNew, ['/S', `/DIR=${B.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('c-install'));
  C.markersAfterCleanInstall = probeMarkers(appNew, B.tree);
  C.recordAfterCleanInstall = readJson(join(B.tree, 'install', 'install.json'));
  renameSync(C.dataOut, join(B.tree, 'data'));
  C.dataAfterRestore = digestTree(join(B.tree, 'data'));
  C.markersAfterRestore = probeMarkers(appNew, B.tree);
  C.finalUninstall = runInstaller(appNew, ['/uninstall', `/DIR=${B.tree}`, '/NOREG', '/S'], scratch('c-uninstall'));
  C.treeExistsAfterFinalUninstall = existsSync(B.tree);
});

if (DIRTY) {
  test('round-3 upgrade path: skipped because the host already carries a real installation', { skip: true }, () => {});
} else {
const scenario = (name, fn) => test(name, { skip: SKIP_REASON }, fn);

// ------------------------------------------------------------------ 1. overwrite keeps data + records the source

scenario('overwrite: a newer install records its own version with upgradedFrom=null', () => {
  assert.equal(A.installNew.status, 0, `new install failed: ${A.installNew.stdout}${A.installNew.stderr}`);
  assert.equal(A.recordAfterNew.version, VERSION_NEW);
  assert.equal(A.recordAfterNew.upgradedFrom, null, 'a first install must not claim an upgrade source');
  assert.equal(A.exeAfterNew, A.newPayloadExe, 'the tree must carry the new payload bytes');
});

scenario('overwrite: installing over the tree keeps the tree and names the version it replaced', () => {
  assert.equal(A.installOld.status, 0, `overwrite failed: ${A.installOld.stdout}${A.installOld.stderr}`);
  assert.equal(A.recordAfterOld.upgradedFrom, VERSION_NEW, 'the record must name the version it replaced');
  assert.equal(A.recordAfterOld.installPath, A.tree, 'an overwrite must not move the tree');
});

// ------------------------------------------------------------------ 2. downgrade is NOT refused (P2)

scenario('downgrade: an older installer overwrites a newer tree — the installer has no version-direction check', () => {
  // This is the measured P2 from the round-3 real run (rc.4 Setup over an rc.6 tree:
  // exit 0, `升级完成: 0.0.1-rc.6 → 0.0.1-rc.4`, install.json went backwards). The store
  // layer is the only fail-closed half (`ERR_SCHEMA_TOO_NEW`).
  assert.equal(A.recordAfterNew.version, VERSION_NEW);
  assert.equal(
    A.installOld.status,
    0,
    'the older installer exited non-zero — if that is a new version-direction guard, the P2 is fixed: '
      + 're-measure evidence/upgrade/r3 and update status/UPGRADE-PATH.md instead of deleting this assertion',
  );
  assert.equal(A.recordAfterOld.version, VERSION_OLD, 'the tree now claims the OLDER version');
  assert.equal(A.recordAfterOld.upgradedFrom, VERSION_NEW, 'and records the newer version as its source');
  assert.equal(A.exeAfterOld, A.oldPayloadExe, 'the program binary was rolled back to the older payload');
});

// ------------------------------------------------------------------ 3. interrupted copy: guards say no

scenario('interrupted copy: both the upgrade gate and the delete gate refuse the half-updated tree', () => {
  assert.equal(B.installOld.status, 0, `baseline install failed: ${B.installOld.stdout}${B.installOld.stderr}`);
  assert.equal(
    B.markers.manifestHasRows,
    false,
    'the manifest sample must fail once the payload files no longer match it (first row = the entry exe)',
  );
  assert.equal(B.markers.hasAnyEntry, true, 'the tree is not empty, so the gates cannot be skipped as "empty target"');
  assert.equal(B.markers.upgradeMarker, null, 'the upgrade gate must not authorize merging into a half-updated tree');
  assert.equal(B.markers.installMarker, null, 'the delete gate must not authorize deleting a half-updated tree');
  assert.equal(B.markers.recordVersion, VERSION_OLD, 'install.json is still the pre-upgrade record');
  assert.match(B.markers.ownershipProblem, /manifests\\files\.sha256/u);
});

scenario('interrupted copy: reinstalling is refused and the tree is left untouched', () => {
  assert.equal(
    B.reinstall.status,
    1,
    `the reinstall must be refused with the generic install error (exit 1), got ${B.reinstall.status}`,
  );
  const text = `${B.reinstall.stdout ?? ''}${B.reinstall.stderr ?? ''}`;
  assert.match(text, /不是空目录，也没有安装标记/u, 'the refusal must be the documented "not an install tree" message');
  assert.deepEqual(
    B.treeAfterReinstallAttempt,
    B.treeBeforeAttempt,
    'a refused install writes nothing — not one byte of the tree may change',
  );
});

scenario('interrupted copy: uninstall is refused (exit 5) and deletes nothing', () => {
  assert.equal(
    B.uninstall.status,
    5,
    `uninstall must be refused with EXIT_TARGET_INVALID=5, got ${B.uninstall.status}: ${B.uninstall.stdout}${B.uninstall.stderr}`,
  );
  assert.match(`${B.uninstall.stdout ?? ''}${B.uninstall.stderr ?? ''}`, /卸载被拒/u, 'the refusal text must be the ownership refusal');
  assert.deepEqual(B.treeAfterUninstallAttempt, B.treeBeforeAttempt, 'the refused uninstall deleted something');
  assert.deepEqual(B.dataAfterUninstallAttempt, B.dataBefore, 'user data under <target>\\data must be byte-identical');
});

scenario('interrupted copy: the only verified recovery works — move data out, delete the tree, clean install, move data back', () => {
  assert.equal(C.cleanInstall.status, 0, `clean install failed: ${C.cleanInstall.stdout}${C.cleanInstall.stderr}`);
  assert.equal(C.recordAfterCleanInstall.version, VERSION_NEW);
  assert.deepEqual(C.dataAfterRestore, B.dataBefore, 'the restored data must be byte-identical to the pre-powercut data');
  // Marker self-heals: after a clean install the tree is deletable again, which is what
  // ends the "can neither install nor uninstall" state.
  assert.match(String(C.markersAfterCleanInstall.installMarker), /^install\/install\.json\+ownership/u);
  assert.equal(C.markersAfterRestore.upgradeMarker, 'install/install.json', 'the upgraded tree stays upgradable');
  assert.equal(C.finalUninstall.status, 0, `final uninstall failed: ${C.finalUninstall.stdout}${C.finalUninstall.stderr}`);
  assert.equal(C.treeExistsAfterFinalUninstall, false, 'the recovered tree must be removable again');
});

// ------------------------------------------------------------------ 4. static pins for the mechanisms

scenario('the delete authorization still comes from install.json + the ownership credential', () => {
  const source = readFileSync(INSTALL_PY, 'utf8');
  const start = source.indexOf('def _install_marker(');
  assert.notEqual(start, -1, 'install.py must still define _install_marker()');
  const body = source.slice(start, start + 2000);
  assert.match(body, /ownership\.verify\(/u, 'the delete gate must verify the credential (RC5-N01)');
  assert.match(body, /_manifest_has_rows\(/u, 'the delete gate must verify the payload bytes on disk');
});

scenario('the uninstall registry entry removal is still host-global (P2 open, N-028 §7)', () => {
  // This is deliberately pinned as-is: `remove_uninstall_entry()` takes no target, so an
  // uninstall of ANY directory deletes the single global uninstall key.  If this starts
  // failing, the removal was scoped to the tree — update the P2 row in
  // evidence/upgrade/r3 and status/UPGRADE-PATH.md.
  const source = readFileSync(REGISTRY_PY, 'utf8');
  const start = source.indexOf('def remove_uninstall_entry(');
  assert.notEqual(start, -1, 'registry.py must still define remove_uninstall_entry()');
  assert.match(source.slice(start, start + 80), /def remove_uninstall_entry\(\)/u, 'the removal must still take no target argument');
});

scenario('the manifest sample checks the first three rows, which is what makes the exe row decisive', () => {
  const source = readFileSync(INSTALL_PY, 'utf8');
  const start = source.indexOf('def _manifest_has_rows(');
  assert.notEqual(start, -1, 'install.py must still define _manifest_has_rows()');
  const body = source.slice(start, start + 4000);
  assert.match(body, /range\(min\(3, len\(rows\)\)\)/u, 'the first three rows are always sampled');
  assert.match(body, /_PAYLOAD_LAYOUT_MARKERS/u, 'plus the payload-layout rows, up to the sample cap');
});

// ------------------------------------------------------------------ 5. the frozen installer the campaign measured

test('the frozen rc.4 Setup the round-3 campaign installed is the one SHA256SUMS records', (t) => {
  const releaseDir = join(REPO_ROOT, 'dist', 'release', '0.0.1-rc.4');
  const sums = join(releaseDir, 'SHA256SUMS.txt');
  if (!existsSync(sums)) {
    t.diagnostic('dist/release/0.0.1-rc.4/SHA256SUMS.txt not present in this checkout');
    return;
  }
  const expected = 'e2ac23ac4033181b5c588feb7a0bacc64a74002b4ac46a80f2886deb3eb338a2';
  const line = readFileSync(sums, 'utf8')
    .split(/\r?\n/u)
    .find((row) => row.includes('AIDrivenNetDefense-Setup-0.0.1-rc.4.exe'));
  assert.ok(line, 'SHA256SUMS.txt must list the rc.4 Setup.exe');
  assert.equal(line.toUpperCase().includes(expected.toUpperCase()), true, 'the measured rc.4 installer must be the frozen one');
});
}
