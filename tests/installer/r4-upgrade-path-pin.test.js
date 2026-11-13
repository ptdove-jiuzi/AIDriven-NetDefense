/**
 * r4-upgrade-path-pin.test.js — pin the round-4 upgrade-path behaviours, including the
 * **rc.5 -> rc.6** pair the user asked for (`status/UPGRADE-PATH.md` §9, `evidence/upgrade/r4/**`).
 *
 * What is pinned, and why each one is a test rather than a paragraph:
 *
 *   1. **rc.5 cold install** — `version=0.0.1-rc.5`, `upgradedFrom=null` (a first install must
 *      not claim an upgrade source).
 *   2. **rc.6 overwrite of an rc.5 tree** — `upgradedFrom=0.0.1-rc.5`, the tree keeps its bytes,
 *      and `<target>\data` survives byte-identically.
 *   3. **A DOWNGRADE IS NOT REFUSED** (open defect) — the rc.5 installer happily overwrites a
 *      newer rc.6 tree, exits 0, and writes `version=0.0.1-rc.5 / upgradedFrom=0.0.1-rc.6`.
 *      Round-4 measured exactly this on the real pair (scene C = EXPLICIT FAILURE).  This test
 *      pins the *current* behaviour; if it ever goes red because the installer started refusing
 *      older versions, that is the fix landing — re-measure `evidence/upgrade/r4/**` and update
 *      the report instead of deleting the assertion.
 *   4. **Interrupted copy locks the tree** — with the payload's files landed but the old
 *      `manifests/files.sha256` still on disk, both shipped guards answer `None`: a direct
 *      reinstall exits 1 and writes nothing, uninstall exits 5 and deletes nothing.
 *   5. **The recovery path works** — move `data\` out, delete the half-new tree, clean rc.6
 *      install (exit 0), move `data\` back: the data is byte-identical and the tree is
 *      installable/uninstallable again.  (Round 3 could not verify (d); round 4 did it on the
 *      rc.5 -> rc.6 pair and this test keeps it from regressing.)
 *
 * The decisive mechanics are reproduced with the same structurally complete miniature payload
 * used by round 3 (`fixtures/r3-make-payload.py`: real bundle.json, real entry point, real
 * `manifests/files.sha256` whose digests match the bytes) driven through the shipped
 * `main.py`, so the guards under test are the real ones, not a re-implementation.
 *
 * No host side effects: every run is `/NOREG` (no uninstall key), `/NOSHORTCUT`, with TEMP,
 * Start Menu, Desktop, ProgramData and the default target redirected into the test scratch
 * directory; `%ProgramFiles%` is never touched.  When a real installation is present on the
 * host the whole file contributes a SINGLE skip (the `test:installer` floor allows maxSkip=4).
 *
 * Run with:  node --test tests/installer/r4-upgrade-path-pin.test.js
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
const EVIDENCE = join(REPO_ROOT, 'evidence', 'upgrade', 'r4');

/** The real release pair this round installed: rc.5 first, rc.6 over it. */
const VERSION_OLD = '0.0.1-rc.5';
const VERSION_NEW = '0.0.1-rc.6';

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

// ------------------------------------------------------------------ scratch helpers

const scratchPaths = [];
function scratch(name) {
  const path = mkdtempSync(join(tmpdir(), `aidn-r4-${name}-`));
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

/** `{relativePath: sha256}` for tree comparison without bytes noise. */
const digestTree = (dir) => Object.fromEntries(
  Object.entries(fingerprint(dir)).map(([rel, row]) => [rel, row.sha256]),
);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

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

/** Run the shipped `main.py` with a redirected environment. */
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
  const recorded = spawnSync(
    PYTHON,
    ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from aidn import selfinfo; sys.stdout.write(selfinfo.product_version())', destination],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
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
const A = {}; // rc.5 install -> rc.6 overwrite (the user-requested main chain)
const B = {}; // interrupted copy -> direct reinstall/uninstall refuse -> recovery path
const C = {}; // downgrade: rc.5 over the rc.6 tree

/**
 * A live install elsewhere on the machine would make `find_existing()` treat our scratch
 * target as an upgrade of *that* tree.  Same guard as round 3 / runkey-autostart.test.js.
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

  // --- miniature payloads (the rc.6 one differs from the rc.5 one byte for byte)
  payloadSrcNew = join(WORK, 'payload-new');
  payloadSrcOld = join(WORK, 'payload-old');
  mkdirSync(payloadSrcNew, { recursive: true });
  mkdirSync(payloadSrcOld, { recursive: true });
  for (const [source, app, tag] of [
    [payloadSrcNew, appNew, 'payload-rc6-r4'],
    [payloadSrcOld, appOld, 'payload-rc5-r4'],
  ]) {
    const built = spawnSync(PYTHON, [PAYLOAD_BUILDER, source, join(app, 'payload.7z'), tag], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    assert.equal(built.status, 0, `payload builder failed: ${built.stdout}${built.stderr}`);
    assert.equal(existsSync(join(app, 'payload.7z')), true, 'payload.7z was not produced');
  }

  // ------------------------------------------------ A: rc.5 install -> rc.6 overwrite
  A.tree = join(WORK, 'tree-rc5-rc6');
  A.installOld = runInstaller(appOld, ['/S', `/DIR=${A.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('a-old'));
  A.recordAfterOld = readJson(join(A.tree, 'install', 'install.json'));
  A.exeAfterOld = sha256File(join(A.tree, 'AIDrivenNetDefense.exe'));
  A.oldPayloadExe = sha256File(join(payloadSrcOld, 'AIDrivenNetDefense.exe'));
  A.newPayloadExe = sha256File(join(payloadSrcNew, 'AIDrivenNetDefense.exe'));

  // user data written while rc.5 is installed; the rc.6 overwrite must not touch it
  const dataDir = join(A.tree, 'data');
  mkdirSync(join(dataDir, 'store'), { recursive: true });
  writeFileSync(join(dataDir, 'seed.txt'), 'r4 pin: synthetic user data written by rc.5\n');
  writeFileSync(join(dataDir, 'store', 'seed.db'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 251)));
  A.dataBeforeUpgrade = digestTree(dataDir);
  A.recordBeforeUpgrade = readJson(join(A.tree, 'install', 'install.json'));

  A.installNew = runInstaller(appNew, ['/S', `/DIR=${A.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('a-new'));
  A.recordAfterNew = readJson(join(A.tree, 'install', 'install.json'));
  A.exeAfterNew = sha256File(join(A.tree, 'AIDrivenNetDefense.exe'));
  A.dataAfterUpgrade = digestTree(dataDir);

  // ------------------------------------------------ B: interrupted copy + recovery path
  B.tree = join(WORK, 'tree-half');
  B.installOld = runInstaller(appOld, ['/S', `/DIR=${B.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('b-old'));
  const bData = join(B.tree, 'data');
  mkdirSync(join(bData, 'store'), { recursive: true });
  writeFileSync(join(bData, 'seed.txt'), 'r4 pin: synthetic data that must survive a powercut\n');
  writeFileSync(join(bData, 'store', 'seed.db'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 53 + 7) % 251)));
  B.dataBefore = digestTree(bData);
  B.recordBeforeAttempt = readJson(join(B.tree, 'install', 'install.json'));

  // The shape the real kill left behind (scene D, `kill-result.json`): the payload's files
  // already landed (new exe + bundle.json) while install.json + manifests/files.sha256 are
  // still the old ones.  `_manifest_has_rows` samples the first three rows and the first data
  // row is the entry exe, so this state is deterministic, not lucky.
  cpSync(join(payloadSrcNew, 'AIDrivenNetDefense.exe'), join(B.tree, 'AIDrivenNetDefense.exe'));
  cpSync(join(payloadSrcNew, 'bundle.json'), join(B.tree, 'bundle.json'));
  B.treeBeforeAttempt = digestTree(B.tree);
  B.markers = probeMarkers(appNew, B.tree);

  B.reinstall = runInstaller(appNew, ['/S', `/DIR=${B.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('b-reinstall'));
  B.treeAfterReinstallAttempt = digestTree(B.tree);

  B.uninstall = runInstaller(appNew, ['/uninstall', `/DIR=${B.tree}`, '/NOREG', '/S', '/KEEPDATA'], scratch('b-uninstall'));
  B.treeAfterUninstallAttempt = digestTree(B.tree);
  B.dataAfterUninstallAttempt = digestTree(join(B.tree, 'data'));

  // recovery: move data out -> delete the half-new tree -> clean rc.6 install -> move data back
  B.dataOut = join(WORK, 'data-out');
  renameSync(join(B.tree, 'data'), B.dataOut);
  rmSync(B.tree, { recursive: true, force: true });
  B.cleanInstall = runInstaller(appNew, ['/S', `/DIR=${B.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('b-clean'));
  B.recordAfterCleanInstall = readJson(join(B.tree, 'install', 'install.json'));
  B.markersAfterCleanInstall = probeMarkers(appNew, B.tree);
  renameSync(B.dataOut, join(B.tree, 'data'));
  B.dataAfterRestore = digestTree(join(B.tree, 'data'));
  B.markersAfterRestore = probeMarkers(appNew, B.tree);
  B.finalUninstall = runInstaller(appNew, ['/uninstall', `/DIR=${B.tree}`, '/NOREG', '/S'], scratch('b-final-uninstall'));
  B.treeExistsAfterFinalUninstall = existsSync(B.tree);

  // ------------------------------------------------ C: downgrade (rc.5 over an rc.6 tree)
  C.tree = join(WORK, 'tree-downgrade');
  C.installNew = runInstaller(appNew, ['/S', `/DIR=${C.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('c-new'));
  C.recordAfterNew = readJson(join(C.tree, 'install', 'install.json'));
  C.exeAfterNew = sha256File(join(C.tree, 'AIDrivenNetDefense.exe'));
  C.installOld = runInstaller(appOld, ['/S', `/DIR=${C.tree}`, '/NOREG', '/NOSHORTCUT'], scratch('c-old'));
  C.recordAfterOld = readJson(join(C.tree, 'install', 'install.json'));
  C.exeAfterOld = sha256File(join(C.tree, 'AIDrivenNetDefense.exe'));
});

if (DIRTY) {
  test('round-4 upgrade path: skipped because the host already carries a real installation', { skip: true }, () => {});
} else {
const scenario = (name, fn) => test(name, { skip: SKIP_REASON }, fn);

// ------------------------------------------------------------------ 1. rc.5 cold install

scenario('rc.5 cold install: version=0.0.1-rc.5, upgradedFrom=null, the tree carries the rc.5 bytes', () => {
  assert.equal(A.installOld.status, 0, `rc.5 install failed: ${A.installOld.stdout}${A.installOld.stderr}`);
  assert.equal(A.recordAfterOld.version, VERSION_OLD);
  assert.equal(A.recordAfterOld.upgradedFrom, null, 'a first install must not claim an upgrade source');
  assert.equal(A.recordAfterOld.installPath, A.tree);
  assert.equal(A.exeAfterOld, A.oldPayloadExe, 'the tree must carry the rc.5 payload bytes');
});

// ------------------------------------------------------------------ 2. rc.6 overwrite keeps data + names rc.5

scenario('rc.6 overwrite of the rc.5 tree: upgradedFrom=0.0.1-rc.5 and the tree keeps its path', () => {
  assert.equal(A.installNew.status, 0, `rc.6 overwrite failed: ${A.installNew.stdout}${A.installNew.stderr}`);
  assert.equal(A.recordAfterNew.version, VERSION_NEW, 'the tree must now claim rc.6');
  assert.equal(A.recordAfterNew.upgradedFrom, VERSION_OLD, 'the record must name the rc.5 version it replaced');
  assert.equal(A.recordAfterNew.installPath, A.tree, 'an overwrite must not move the tree');
  assert.equal(A.exeAfterNew, A.newPayloadExe, 'the program binary must be the rc.6 payload');
});

scenario('rc.6 overwrite of the rc.5 tree: user data under <target>\\data survives byte-identically', () => {
  assert.deepEqual(A.dataAfterUpgrade, A.dataBeforeUpgrade, 'the overwrite changed user data bytes');
  assert.equal(A.recordBeforeUpgrade.version, VERSION_OLD);
  assert.equal(Object.keys(A.dataAfterUpgrade).length, 2, 'the seeded data tree must still hold both files');
});

// ------------------------------------------------------------------ 3. downgrade is NOT refused (open defect)

scenario('downgrade: the rc.5 installer overwrites the newer rc.6 tree (no version-direction check) — current defect', () => {
  // Round-4 scene C measured exactly this on the real pair: exit 0, log line
  // `升级完成：0.0.1-rc.6 → 0.0.1-rc.5`, install.json went backwards.  The store layer is the
  // only fail-closed half (`ERR_SCHEMA_TOO_NEW`).
  assert.equal(C.installNew.status, 0, `baseline rc.6 install failed: ${C.installNew.stdout}${C.installNew.stderr}`);
  assert.equal(C.recordAfterNew.version, VERSION_NEW);
  assert.equal(
    C.installOld.status,
    0,
    'the older installer exited non-zero — if that is a new version-direction guard, the defect is fixed: '
      + 're-measure evidence/upgrade/r4 scene C and update status/UPGRADE-PATH.md instead of deleting this assertion',
  );
  assert.equal(C.recordAfterOld.version, VERSION_OLD, 'the tree now claims the OLDER version');
  assert.equal(C.recordAfterOld.upgradedFrom, VERSION_NEW, 'and records the newer version as its source');
  assert.equal(C.exeAfterOld, sha256File(join(payloadSrcOld, 'AIDrivenNetDefense.exe')), 'the program binary was rolled back');
  assert.notEqual(C.exeAfterOld, C.exeAfterNew);
});

// ------------------------------------------------------------------ 4. interrupted copy: guards say no

scenario('interrupted copy: the upgrade gate and the delete gate both refuse the half-updated tree', () => {
  assert.equal(B.installOld.status, 0, `baseline rc.5 install failed: ${B.installOld.stdout}${B.installOld.stderr}`);
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

scenario('interrupted copy: a direct reinstall is refused (exit 1) and writes nothing', () => {
  assert.equal(
    B.reinstall.status,
    1,
    `the reinstall must be refused with the generic install error (exit 1), got ${B.reinstall.status}`,
  );
  assert.match(`${B.reinstall.stdout ?? ''}${B.reinstall.stderr ?? ''}`, /不是空目录，也没有安装标记/u);
  assert.deepEqual(B.treeAfterReinstallAttempt, B.treeBeforeAttempt, 'a refused install writes nothing');
});

scenario('interrupted copy: uninstall is refused (exit 5) and deletes nothing', () => {
  assert.equal(B.uninstall.status, 5, `uninstall must be refused with EXIT_TARGET_INVALID=5, got ${B.uninstall.status}`);
  assert.match(`${B.uninstall.stdout ?? ''}${B.uninstall.stderr ?? ''}`, /卸载被拒/u);
  assert.deepEqual(B.treeAfterUninstallAttempt, B.treeBeforeAttempt, 'the refused uninstall deleted something');
  assert.deepEqual(B.dataAfterUninstallAttempt, B.dataBefore, 'user data must be byte-identical');
});

// ------------------------------------------------------------------ 5. recovery path works

scenario('recovery: move data out -> delete the tree -> clean rc.6 install -> move data back restores byte-identical data', () => {
  assert.equal(B.cleanInstall.status, 0, `clean install failed: ${B.cleanInstall.stdout}${B.cleanInstall.stderr}`);
  assert.equal(B.recordAfterCleanInstall.version, VERSION_NEW);
  assert.equal(B.recordAfterCleanInstall.upgradedFrom, null, 'a clean install after the tree was removed is not an upgrade');
  assert.deepEqual(B.dataAfterRestore, B.dataBefore, 'the restored data must be byte-identical to the pre-kill data');
  // The marker self-heals: the recovered tree is deletable again, which ends the "can neither
  // install nor uninstall" state.
  assert.match(String(B.markersAfterCleanInstall.installMarker), /^install\/install\.json\+ownership/u);
  assert.equal(B.markersAfterRestore.upgradeMarker, 'install/install.json', 'the recovered tree stays upgradable');
  assert.equal(B.finalUninstall.status, 0, `final uninstall failed: ${B.finalUninstall.stdout}${B.finalUninstall.stderr}`);
  assert.equal(B.treeExistsAfterFinalUninstall, false, 'the recovered tree must be removable again');
});

// ------------------------------------------------------------------ 6. static pins for the mechanism

scenario('the installer still has no version-direction comparison (the mechanism behind scene C)', () => {
  const source = readFileSync(INSTALL_PY, 'utf8');
  for (const pattern of [/LooseVersion/u, /parse_version/u, /packaging\.version/u, /compare_versions?\(/u]) {
    assert.equal(pattern.test(source), false, `install.py now contains ${pattern}; re-measure the downgrade verdict`);
  }
  const start = source.indexOf('def _upgrade_marker(');
  assert.notEqual(start, -1, 'install.py must still define _upgrade_marker()');
  const body = source.slice(start, start + 1600);
  assert.match(body, /_record_is_ours\(/u, 'the upgrade gate must check the product identity of install.json');
  assert.match(body, /_manifest_has_rows\(/u, 'the upgrade gate must check the payload bytes on disk');
  assert.equal(/upgradedFrom/u.test(body), false, 'the upgrade gate must not compare versions');
});

scenario('the manifest sample still checks the first three rows, which makes the exe row decisive', () => {
  const source = readFileSync(INSTALL_PY, 'utf8');
  const start = source.indexOf('def _manifest_has_rows(');
  assert.notEqual(start, -1, 'install.py must still define _manifest_has_rows()');
  const body = source.slice(start, start + 4000);
  assert.match(body, /range\(min\(3, len\(rows\)\)\)/u);
  assert.match(body, /_PAYLOAD_LAYOUT_MARKERS/u);
});

// ------------------------------------------------------------------ 7. the frozen installers this round measured

function setupShaFromSums(version) {
  const releaseDir = join(REPO_ROOT, 'dist', 'release', `0.0.1-${version}`);
  const sums = join(releaseDir, 'SHA256SUMS.txt');
  if (!existsSync(sums)) return undefined;
  const line = readFileSync(sums, 'utf8')
    .split(/\r?\n/u)
    .find((row) => row.includes(`AIDrivenNetDefense-Setup-0.0.1-${version}.exe`));
  if (!line) return undefined;
  return (line.match(/^([0-9a-fA-F]{64})/u) ?? [])[1];
}

test('the frozen rc.5 Setup the round-4 campaign installed is the one SHA256SUMS records', (t) => {
  const expected = setupShaFromSums('rc.5');
  if (!expected) {
    t.diagnostic('dist/release/0.0.1-rc.5/SHA256SUMS.txt not present in this checkout');
    return;
  }
  assert.equal(
    expected.toUpperCase(),
    'CA0297D0F4E8E7941BA1C3C2910E02380F01DF5AE70289B2BCB91F9C6070884A',
    'the rc.5 installer the report names must be the frozen one',
  );
});

test('the frozen rc.6 Setup the round-4 campaign installed is the one SHA256SUMS records', (t) => {
  const expected = setupShaFromSums('rc.6');
  if (!expected) {
    t.diagnostic('dist/release/0.0.1-rc.6/SHA256SUMS.txt not present in this checkout');
    return;
  }
  assert.equal(
    expected.toUpperCase(),
    '9BC1B3A79378ABDA1DF14BB110E594ED9F1B099F08E400F42BBFFF38A789057B',
    'the rc.6 installer the report names must be the frozen one',
  );
});

// ------------------------------------------------------------------ 8. the real-run evidence this round produced

test('round-4 scene A (real rc.5 install) recorded version=0.0.1-rc.5 / upgradedFrom=null', (t) => {
  const file = join(EVIDENCE, 'sceneA', 'result.json');
  if (!existsSync(file)) {
    t.diagnostic('evidence/upgrade/r4/sceneA/result.json not present in this checkout');
    return;
  }
  const result = readJson(file);
  assert.equal(result.exitCode, 0, 'the real rc.5 install must have exited 0');
  assert.equal(result.version, '0.0.1-rc.5');
  assert.equal(result.upgradedFrom, null);
  assert.equal(result.uninstallKeys.hkcu, 1, 'exactly one HKCU uninstall key');
  assert.equal(result.uninstallKeys.hklm, 0);
  assert.equal(result.runValueCount, 1);
});

test('round-4 scene B (real rc.6 overwrite) recorded upgradedFrom=0.0.1-rc.5 and 0 data difference', (t) => {
  const file = join(EVIDENCE, 'sceneB', 'result.json');
  if (!existsSync(file)) {
    t.diagnostic('evidence/upgrade/r4/sceneB/result.json not present in this checkout');
    return;
  }
  const result = readJson(file);
  assert.equal(result.exitCode, 0, 'the real rc.6 overwrite must have exited 0');
  assert.equal(result.version, '0.0.1-rc.6');
  assert.equal(result.upgradedFrom, '0.0.1-rc.5', 'the record must name the rc.5 version the run replaced');
  assert.equal(result.targetDataDiff.differenceCount, 0, '<target>\\data changed during the overwrite');
  assert.equal(result.laDataDiff.differenceCount, 0, '%LOCALAPPDATA% data changed during the overwrite');
  assert.equal(result.uninstallKeys.hkcu, 1, 'exactly one uninstall key, no duplicate');
  assert.equal(result.uninstallKeys.hklm, 0);
  assert.equal(result.runValueCount, 1);
  assert.ok(
    (result.upgradeLogLines ?? []).some((line) => line.includes('0.0.1-rc.5') && line.includes('0.0.1-rc.6')),
    'the installer log must carry the "升级完成：0.0.1-rc.5 → 0.0.1-rc.6" line',
  );
});

test('round-4 scene C (real downgrade attempt) is recorded as a silent downgrade, not a refusal', (t) => {
  const file = join(EVIDENCE, 'sceneC', 'result.json');
  if (!existsSync(file)) {
    t.diagnostic('evidence/upgrade/r4/sceneC/result.json not present in this checkout');
    return;
  }
  const result = readJson(file);
  // This pins the measured EXPLICIT FAILURE: the acceptance criterion wants a refusal, the
  // product installs anyway.  If this starts failing because scene C got a non-zero exit, the
  // defect was fixed — update the report, do not weaken the assertion.
  assert.equal(result.exitCode, 0, 'scene C: the older installer did NOT refuse (current defect)');
  assert.equal(result.version, '0.0.1-rc.5', 'scene C: the tree went backwards to rc.5');
  assert.equal(result.upgradedFrom, '0.0.1-rc.6', 'scene C: and recorded rc.6 as its source');
});

test('round-4 scene D (real kill + recovery) is recorded: direct reinstall refused, recovery install succeeded', (t) => {
  const killFile = join(EVIDENCE, 'sceneD', 'kill-result.json');
  const recoveryFile = join(EVIDENCE, 'sceneD', 'recovery-result.json');
  if (!existsSync(killFile) || !existsSync(recoveryFile)) {
    t.diagnostic('evidence/upgrade/r4/sceneD/{kill,recovery}-result.json not present in this checkout');
    return;
  }
  const kill = readJson(killFile);
  const recovery = readJson(recoveryFile);
  assert.equal(kill.trigger, 'exe-changed-manifest-old', 'the kill must happen in the half-copied state');
  assert.equal(kill.markerProbe.installMarker, null);
  assert.equal(kill.markerProbe.upgradeMarker, null);
  assert.equal(recovery.d1_directReinstall.exitCode, 1, 'a direct reinstall of the half-new tree must still be refused');
  assert.equal(recovery.d1_directReinstall.treeUnchanged, true, 'the refused reinstall must write nothing');
  assert.equal(recovery.d2_recovery.cleanInstall.exitCode, 0, 'the recovery-path clean install must succeed');
  assert.equal(recovery.d2_recovery.targetDataRestoreDiff.differenceCount, 0, 'restored <target>\\data must be byte-identical');
  assert.equal(recovery.d2_recovery.laDataRestoreDiff.differenceCount, 0, 'restored %LOCALAPPDATA% data must be byte-identical');
  assert.equal(recovery.d2_recovery.storeOpens, true, 'the restored event store must open');
});
}
