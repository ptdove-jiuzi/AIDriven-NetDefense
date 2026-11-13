/**
 * r5-upgrade-path-pin.test.js — pin what round 5 actually measured on the **real release pair**
 * (`status/UPGRADE-PATH.md` §10, raw evidence under `evidence/upgrade/r5/**`).
 *
 * Round 4 pinning (`r4-upgrade-path-pin.test.js`) drives miniature payloads through the shipped
 * `main.py`; this file pins the *real-device* run so a future change to the numbers cannot pass
 * silently.  Everything asserted here is a byte or a host reading taken by the round-5 seats:
 *
 *   1. the two release Setup.exe files still are the frozen rc.5 / rc.6 bytes;
 *   2. scene A — rc.5 cold install: exit 0, `version=0.0.1-rc.5`, `upgradedFrom=null`, one HKCU
 *      uninstall key, no Run value (the round used no `/AUTOSTART`), one Start-Menu folder and
 *      one desktop link;
 *   3. scene B — rc.6 overwrite: the four acceptance criteria of the round
 *      ① `<target>\data` and `%LOCALAPPDATA%\AIDriven NetDefense\data` are byte-identical
 *      ② `install.json.upgradedFrom === "0.0.1-rc.5"`
 *      ③ exactly one uninstall entry (HKCU 1 / HKLM 0 / WOW 0)
 *      ④ shortcut counts did not grow against the rc.5 time point (1 folder + 1 link, 1 desktop)
 *      plus the `升级完成：0.0.1-rc.5 → 0.0.1-rc.6` log line;
 *   4. scene C — a DOWNGRADE IS NOT REFUSED (open defect): rc.5 over an rc.6 tree exits 0 and
 *      writes `version=0.0.1-rc.5 / upgradedFrom=0.0.1-rc.6`, rolling the program bytes back;
 *   5. the mechanism, read out of the **shipped** Setup bytes (not just the repo source): the
 *      frozen `aidn.install` module has `_install_marker`/`_upgrade_marker` and its
 *      `_upgrade_marker` references only ownership/manifest checks — no version-direction helper
 *      exists anywhere in that module, and the installer app never imports the event-store
 *      schema guard (`ERR_SCHEMA_TOO_NEW`) that is the only fail-closed half of the product;
 *   6. the host was returned to the round's starting state (all counts zero).
 *
 * If an assertion here goes red because the defect got fixed (downgrade refused, version
 * comparison added), that is the fix landing: re-measure `evidence/upgrade/r5/**`, update
 * `status/UPGRADE-PATH.md` §10 and this file — do not delete the assertion.
 *
 * Read-only: no installer run, no host writes, no `dist/**` write; pure file + byte assertions.
 * When `dist/release/**` is not present the artefact tests skip (one skip in total).
 *
 * Run with:  node --test tests/installer/r5-upgrade-path-pin.test.js
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const EVIDENCE = join(REPO_ROOT, 'evidence', 'upgrade', 'r5');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const exists = (path) => existsSync(path);

// ---------------------------------------------------------------- pinned release artefacts

const SETUP_RC5 = join(REPO_ROOT, 'dist', 'release', '0.0.1-rc.5', 'AIDrivenNetDefense-Setup-0.0.1-rc.5.exe');
const SETUP_RC6 = join(REPO_ROOT, 'dist', 'release', '0.0.1-rc.6', 'AIDrivenNetDefense-Setup-0.0.1-rc.6.exe');
const SETUP_RC5_BYTES = 67_860_347;
const SETUP_RC5_SHA = 'ca0297d0f4e8e7941ba1c3c2910e02380f01df5ae70289b2bcb91f9c6070884a';
const SETUP_RC6_BYTES = 67_967_689;
const SETUP_RC6_SHA = '9bc1b3a79378abda1df14bb110e594ed9f1b099f08e400f42bbfff38a789057b';

/** The desktop shell each payload carries at the install root — the payload's identity byte. */
const PAYLOAD_EXE_RC5 = 'f8a584c24d8f01861084e01acb40d8d087a652807986ae71218928aa21b355d1';
const PAYLOAD_EXE_RC6 = '48716d63f0e22be78647bceafcf8bd5eca56f19753a841b0a2a697fb3fa56021';
/** `manifests/files.sha256` — rc.5's payload digest and rc.6's. */
const MANIFEST_RC5 = '33c9ff45305de4ae5d9098a6872a61d70c5cf889db830260472e8e96a555e27b';
const MANIFEST_RC6 = '6ec4051c166119196fe9696e599ba8a84ea384b72335b69364284b9136324d0c';

const ARTEFACTS_PRESENT = exists(SETUP_RC5) && exists(SETUP_RC6);
const artefactTest = (name, fn) => test(name, { skip: ARTEFACTS_PRESENT ? false : 'dist/release/** is not present in this checkout' }, fn);

// ---------------------------------------------------------------- A. release bytes

artefactTest('round 5 used the frozen rc.5 / rc.6 Setup bytes (bytes + sha256)', () => {
  assert.equal(statSync(SETUP_RC5).size, SETUP_RC5_BYTES, 'rc.5 Setup size changed — the round-5 run no longer reproduces');
  assert.equal(sha256File(SETUP_RC5), SETUP_RC5_SHA, 'rc.5 Setup sha256 changed — re-measure and update evidence/upgrade/r5');
  assert.equal(statSync(SETUP_RC6).size, SETUP_RC6_BYTES, 'rc.6 Setup size changed');
  assert.equal(sha256File(SETUP_RC6), SETUP_RC6_SHA, 'rc.6 Setup sha256 changed');
});

// ---------------------------------------------------------------- B. scene A: rc.5 cold install

test('scene A: rc.5 cold install exits 0, records version=0.0.1-rc.5 and upgradedFrom=null', () => {
  const run = readJson(join(EVIDENCE, 'sceneA', 'install-rc5-1-result.json'));
  const facts = readJson(join(EVIDENCE, 'sceneA', 'scene-facts-A.json'));
  assert.equal(run.exitCode, 0, 'the rc.5 cold install must exit 0');
  assert.equal(run.mode, 'install');
  assert.deepEqual(run.argv.slice(0, 2), ['/S', `/DIR=${run.target}`], 'the round used a plain /S /DIR= run (no /NOREG /NOSHORTCUT)');
  assert.equal(facts.version, '0.0.1-rc.5');
  assert.equal(facts.upgradedFrom, null, 'a first install must not claim an upgrade source');
  assert.equal(facts.installPath, run.target);
  assert.equal(facts.exeSha256, PAYLOAD_EXE_RC5, 'the tree must carry the rc.5 payload bytes');
  assert.equal(facts.manifestSha256, MANIFEST_RC5);
  assert.equal(facts.hasOwnership, true, 'rc.5 writes the ownership credential');
  assert.ok(facts.fileCount > 50_000, `expected a full payload tree, got ${facts.fileCount} files`);
});

test('scene A: exactly one HKCU uninstall key, no HKLM/WOW key, no Run value, 1 Start-Menu folder (2 .lnk) + 1 desktop link', () => {
  const host = readJson(join(EVIDENCE, 'host', 'after-sceneA.json'));
  assert.equal(host.counts.uninstallHKCU, 1, 'HKCU uninstall key must be exactly one');
  assert.equal(host.counts.uninstallHKLM, 0);
  assert.equal(host.counts.uninstallHKLM_WOW, 0);
  assert.equal(
    host.counts.hkcuRun,
    0,
    'the round passed no /AUTOSTART, so no Run value must exist — a value here means someone else wrote it',
  );
  assert.equal(host.counts.startMenuDirectories, 1, 'one product folder in the (per-user, WinError 5 fallback) Start Menu');
  // The folder holds the program link and 安装目录.lnk by design (shortcuts.py:124-127); the
  // 诊断/自检 link is skipped because the payload carries no SelfCheck.mjs (installer log).
  assert.equal(host.counts.startMenuLinks, 2, 'the folder must hold exactly the two designed .lnk files');
  assert.equal(host.counts.desktop, 1);
  assert.equal(host.counts.programFiles, 0, 'the round never touched %ProgramFiles%');
  assert.equal(host.counts.processes, 0);
});

// ---------------------------------------------------------------- C. scene B: rc.6 overwrite

test('scene B: rc.6 overwrite exits 0 and records version=0.0.1-rc.6 / upgradedFrom=0.0.1-rc.5', () => {
  const run = readJson(join(EVIDENCE, 'sceneB', 'upgrade-rc6-1-result.json'));
  const facts = readJson(join(EVIDENCE, 'sceneB', 'scene-facts-B.json'));
  assert.equal(run.exitCode, 0);
  assert.equal(facts.version, '0.0.1-rc.6');
  assert.equal(facts.upgradedFrom, '0.0.1-rc.5', 'criterion ②: upgradedFrom must name rc.5');
  assert.equal(facts.installPath, run.target, 'an overwrite must not move the tree');
  assert.equal(facts.exeSha256, PAYLOAD_EXE_RC6, 'the program binary must be the rc.6 payload');
  assert.equal(facts.manifestSha256, MANIFEST_RC6);
  assert.deepEqual(
    facts.installerCopies,
    ['AIDrivenNetDefense-Setup-0.0.1-rc.5.exe', 'AIDrivenNetDefense-Setup-0.0.1-rc.6.exe'],
    'the merge-only copy leaves both installer copies behind (known retention, not a criterion failure)',
  );
});

test('criterion ①: <target>\\data is byte-identical across the rc.5 -> rc.6 overwrite', () => {
  const diff = readJson(join(EVIDENCE, 'sceneB', 'target-data-diff-B.json'));
  assert.equal(diff.beforeCount, 8, 'the seeded data tree must still hold 8 files before the upgrade');
  assert.equal(diff.afterCount, 8, 'and 8 files after it — no file may disappear');
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.resized, []);
  assert.equal(diff.differenceCount, 0, 'criterion ① failed: the overwrite changed user data');
});

test('criterion ①: %LOCALAPPDATA%\\AIDriven NetDefense\\data is untouched by the installer (and by the whole round)', () => {
  const afterA = readJson(join(EVIDENCE, 'sceneA', 'la-data-diff-after-A.json'));
  assert.equal(afterA.differenceCount, 0, 'the rc.5 cold install must not write the real user data root');
  const afterB = readJson(join(EVIDENCE, 'sceneB', 'la-data-diff-B.json'));
  assert.equal(afterB.beforeCount, 8);
  assert.equal(afterB.afterCount, 8);
  assert.equal(afterB.differenceCount, 0, 'criterion ① failed: the overwrite changed the real user data root');
});

test('criterion ③: the upgrade leaves exactly one uninstall entry (HKCU 1 / HKLM 0 / WOW 0)', () => {
  const host = readJson(join(EVIDENCE, 'host', 'after-sceneB.json'));
  assert.equal(host.counts.uninstallHKCU, 1, 'the upgrade must refresh, not duplicate, the HKCU key');
  assert.equal(host.counts.uninstallHKLM, 0);
  assert.equal(host.counts.uninstallHKLM_WOW, 0);
  const entry = host.uninstallHKCU[0];
  assert.match(entry.displayVersion, /0\.0\.1-rc\.6/, 'the entry must show the new version');
  assert.match(entry.quietUninstallString ?? '', /0\.0\.1-rc\.6/, 'the quiet uninstall string must point at the rc.6 copy');
  assert.equal(host.counts.hkcuRun, 0, 'no Run value is expected in this round');
});

test('criterion ④: shortcut counts did not grow against the rc.5 time point', () => {
  const before = readJson(join(EVIDENCE, 'host', 'after-sceneA.json'));
  const after = readJson(join(EVIDENCE, 'host', 'after-sceneB.json'));
  assert.equal(after.counts.startMenuDirectories, before.counts.startMenuDirectories, 'a second Start-Menu folder appeared');
  assert.equal(after.counts.startMenuLinks, before.counts.startMenuLinks, 'a second Start-Menu .lnk appeared');
  assert.equal(after.counts.desktop, before.counts.desktop, 'a second desktop shortcut appeared');
  assert.equal(after.counts.startMenuDirectories, 1);
  assert.equal(after.counts.startMenuLinks, 2);
  assert.equal(after.counts.desktop, 1);
});

test('scene B: the installer log carries 升级完成：0.0.1-rc.5 → 0.0.1-rc.6 (twice — known double logging)', () => {
  const lines = readFileSync(join(EVIDENCE, 'sceneB', 'log-upgrade-lines-B.txt'), 'utf8');
  const upgradeLines = lines.split(/\r?\n/).filter((line) => line.includes('升级完成：0.0.1-rc.5 → 0.0.1-rc.6'));
  assert.equal(upgradeLines.length, 2, 'P3 known behaviour: install.py and main.py both write the completion line');
});

// ---------------------------------------------------------------- D. scene C: downgrade is not refused

test('downgrade (scene C): the rc.5 installer overwrites the newer rc.6 tree — current defect, not a pass', () => {
  const run = readJson(join(EVIDENCE, 'sceneC', 'downgrade-rc5-1-result.json'));
  const facts = readJson(join(EVIDENCE, 'sceneC', 'scene-facts-C.json'));
  assert.equal(
    run.exitCode,
    0,
    'the older installer exited non-zero — if that is a new version-direction guard, the defect is fixed: '
      + 're-measure evidence/upgrade/r5 scene C and update status/UPGRADE-PATH.md §10 instead of deleting this assertion',
  );
  assert.equal(facts.version, '0.0.1-rc.5', 'the tree now claims the OLDER version');
  assert.equal(facts.upgradedFrom, '0.0.1-rc.6', 'and records the newer version as its upgrade source');
  assert.equal(facts.exeSha256, PAYLOAD_EXE_RC5, 'the program binary was rolled back to rc.5');
  assert.equal(facts.manifestSha256, MANIFEST_RC5);
  assert.notEqual(facts.exeSha256, PAYLOAD_EXE_RC6);
});

test('downgrade (scene C): data is untouched and the log says 升级完成 (no refusal line)', () => {
  const targetDiff = readJson(join(EVIDENCE, 'sceneC', 'target-data-diff-C.json'));
  assert.equal(targetDiff.differenceCount, 0, 'the downgrade must not touch <target>\\data either');
  const laDiff = readJson(join(EVIDENCE, 'sceneC', 'la-data-diff-C.json'));
  assert.equal(laDiff.differenceCount, 0);
  const log = readFileSync(join(EVIDENCE, 'sceneC', 'log-upgrade-lines-C.txt'), 'utf8');
  assert.match(log, /升级完成：0\.0\.1-rc\.6 → 0\.0\.1-rc\.5/, 'the downgrade is recorded as a normal "upgrade"');
  for (const refusal of ['安装被拒', '卸载被拒', 'Refusing', 'EXIT_TARGET_INVALID', '版本方向']) {
    assert.equal(log.includes(refusal), false, `unexpected refusal marker in the downgrade log: ${refusal}`);
  }
});

// ---------------------------------------------------------------- E. mechanism (shipped bytes)

test('mechanism: shipped rc.5/rc.6 aidn.install has both markers and no version-direction comparison', () => {
  for (const [label, file, sha] of [
    ['rc.5', 'AIDrivenNetDefense-Setup-0.0.1-rc.5-embedded-modules.json', SETUP_RC5_SHA],
    ['rc.6', 'AIDrivenNetDefense-Setup-0.0.1-rc.6-embedded-modules.json', SETUP_RC6_SHA],
  ]) {
    const probe = readJson(join(EVIDENCE, file));
    assert.equal(probe.setupSha256, sha, `${label}: the extraction must be of the frozen release bytes`);
    const verdict = probe.verdict;
    assert.equal(verdict.shippedHasInstallMarker, true, `${label}: _install_marker must ship`);
    assert.equal(verdict.shippedHasUpgradeMarker, true, `${label}: _upgrade_marker must ship`);
    assert.deepEqual(
      verdict.upgradeMarkerNames.slice().sort(),
      [
        'INSTALL_DIR_NAME',
        'INSTALL_RECORD_NAME',
        '_bundle_is_ours',
        '_manifest_has_rows',
        '_record_is_ours',
        'constants',
        'read_install_record',
      ].sort(),
      `${label}: _upgrade_marker may only consult ownership + manifest shape — a new name here could be a version check`,
    );
    assert.deepEqual(verdict.versionComparisonTokenHits, [], `${label}: no version-comparison helper exists in the shipped module`);
  }
});

test('mechanism: the installer app never imports the event-store schema guard that is the only fail-closed half', () => {
  const appDir = join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.py')) files.push(full);
    }
  };
  walk(appDir);
  assert.ok(files.length > 5, `expected the installer sources, found ${files.length} python files`);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const token of ['event-store', 'ERR_SCHEMA_TOO_NEW', 'assertSchemaReadable']) {
      if (text.includes(token)) hits.push(`${relative(REPO_ROOT, file)}: ${token}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    'the installer app is plain Python: it copies payload files and never opens the SQLite store, so the '
      + 'store-level ERR_SCHEMA_TOO_NEW (packages/event-store/src/db.js:461-472) cannot fire at install time',
  );
});

// ---------------------------------------------------------------- F. host cleanup

test('host cleanup: the out-of-tree rc.6 uninstaller ran and the host is back to all-zero', () => {
  const cleanup = readJson(join(EVIDENCE, 'host', 'cleanup-result.json'));
  assert.match(cleanup.uninstallerExe, /dist[\\/]release[\\/]0\.0\.1-rc\.6[\\/]/, 'the uninstaller must be the out-of-tree release copy');
  assert.equal(cleanup.uninstall.exitCode, 0, 'the product uninstall must succeed');
  assert.equal(cleanup.hostEmpty, true, 'the host must be back to the round-start state');
  const after = readJson(join(EVIDENCE, 'host', 'after-r5.json'));
  assert.deepEqual(
    {
      run: after.counts.hkcuRun,
      hkcu: after.counts.uninstallHKCU,
      hklm: after.counts.uninstallHKLM,
      wow: after.counts.uninstallHKLM_WOW,
      startMenu: after.counts.startMenu,
      desktop: after.counts.desktop,
      processes: after.counts.processes,
    },
    { run: 0, hkcu: 0, hklm: 0, wow: 0, startMenu: 0, desktop: 0, processes: 0 },
  );
  assert.equal(after.programFilesInstallExists, false);
});
