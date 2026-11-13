/**
 * rc.4 → rc.5 **overwrite upgrade**: the repeatable checks behind the real run.
 *
 * Two layers, deliberately separated:
 *
 *   A. **Replay** of the raw artifacts produced by the real installers on 2026-11-05
 *      (`evidence/upgrade/overwrite/t1-overwrite/**`).  Nothing is mocked and nothing is
 *      re-run: this file recomputes every claim from the bytes on disk, the way
 *      `install-cycle-verify.test.js` does for the runtime acceptance evidence.  It is
 *      skipped (not failed) when the artifacts are absent — a checkout without a local
 *      install run must stay green.
 *
 *   B. **Unit-level** checks of the upgrade guards, cheap and repeatable on any Windows
 *      box: `aidn.install._probe_data` / `_assert_data_intact` (the before/after hash of
 *      the largest file under `data\`) driven directly, including the two directions the
 *      real run cannot force on demand (file changed during the copy, file vanished), and
 *      the documented fact that a **non-largest** file is outside the guard's scope.
 *
 * What the real run proved (see `evidence/upgrade/overwrite/README.md`):
 *   install rc.4 → create data → install rc.5 over the same `/DIR` → data unchanged,
 *   `upgradedFrom=0.0.1-rc.4`, one uninstall key, one Run value, one Start Menu entry set.
 *
 * Run with:  node --test tests/installer/upgrade-path.test.js
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const EVIDENCE = join(REPO_ROOT, 'evidence', 'upgrade', 'overwrite');
const T1 = join(EVIDENCE, 't1-overwrite');
const GUARD_FIXTURE = join(HERE, 'fixtures', 'upgrade-path-guard.py');

const TARGET = process.env.AIDN_UPGRADE_TARGET
  ?? join(process.env.TEMP ?? tmpdir(), 'upgrade-path', 'overwrite');
const REAL_USER_DATA = join(process.env.LOCALAPPDATA ?? '', 'AIDriven NetDefense');

// ------------------------------------------------------------------ small readers

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const exists = (file) => existsSync(file);

/** `[{path, bytes, sha256}]` from a `data-fingerprint.ps1` TSV, or null when absent. */
function readFingerprint(file) {
  if (!exists(file)) return null;
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const [path, bytes, sha256] = line.split('\t');
    rows.push({ path, bytes: Number(bytes), sha256 });
  }
  return rows;
}

/** Compare two fingerprint tables; the verdict is what the upgrade must keep at zero. */
function compareFingerprints(before, after) {
  const byPath = (rows) => new Map(rows.map((row) => [row.path, row]));
  const a = byPath(before);
  const b = byPath(after);
  const added = [...b.keys()].filter((key) => !a.has(key)).sort();
  const removed = [...a.keys()].filter((key) => !b.has(key)).sort();
  const changed = [...a.keys()].filter((key) => b.has(key) && a.get(key).sha256 !== b.get(key).sha256).sort();
  const resized = [...a.keys()].filter((key) => b.has(key) && a.get(key).bytes !== b.get(key).bytes).sort();
  return {
    added,
    removed,
    changed,
    resized,
    differenceCount: added.length + removed.length + changed.length + resized.length,
    beforeCount: before.length,
    afterCount: after.length,
    beforeBytes: before.reduce((sum, row) => sum + row.bytes, 0),
    afterBytes: after.reduce((sum, row) => sum + row.bytes, 0),
  };
}

/** The snapshot JSON nests arrays one level per collection; flatten before asserting. */
const flatten = (value) => (Array.isArray(value) ? value.flat(Infinity) : []);

const fingerprintPair = (name) => ({
  before: readFingerprint(join(T1, `${name}-before.tsv`)),
  after: readFingerprint(join(T1, `${name}-after.tsv`)),
});

const rc4Record = readJson(join(T1, 'install-json-01-rc4.json'));
const rc5Record = readJson(join(T1, 'install-json-02-rc5.json'));
const run1 = readJson(join(T1, 'run-01-install-rc4.reconstructed.json'));
const run2 = readJson(join(T1, 'run-02-upgrade-rc5.json'));
const host1 = readJson(join(T1, 'host-01-after-rc4-install.json'));
const host2 = readJson(join(T1, 'host-02-after-rc5-upgrade.json'));
const binary1 = readJson(join(T1, 'binary-manifest-01-rc4.json'));
const binary2 = readJson(join(T1, 'binary-manifest-02-rc5.json'));
const probePresent = readJson(join(T1, 'probe-01-registry-present.json'));
const probeAbsent = readJson(join(T1, 'probe-02-registry-absent.json'));
const shortcuts2 = readJson(join(T1, 'shortcuts-02-after-rc5.json')) ?? [];

const RECORDED = Boolean(rc4Record && rc5Record && host2 && exists(join(T1, 'data-fingerprint-after.tsv')));
const RECORDED_REASON = 'no recorded overwrite-upgrade evidence on this machine (see evidence/upgrade/overwrite/README.md)';
const recorded = (name, fn) => test(name, { skip: RECORDED ? false : RECORDED_REASON }, fn);

// ------------------------------------------------------------------ A. replay: records

recorded('overwrite: the rc.4 install is a genuine first install', () => {
  assert.equal(rc4Record.product, 'AIDriven NetDefense');
  assert.equal(rc4Record.version, '0.0.1-rc.4');
  assert.equal(rc4Record.upgradedFrom, null, 'a first install must not claim an upgrade source');
  assert.equal(rc4Record.installPath, TARGET);
  assert.equal(rc4Record.autostart, true);
  assert.equal(rc4Record.channel, 'installed');
  assert.equal(rc4Record.ownership, undefined, 'an rc.4-era tree predates the ownership credential (RC5-N01)');
});

recorded('overwrite: the rc.5 install over the same directory records version + upgradedFrom', () => {
  assert.equal(rc5Record.version, '0.0.1-rc.5');
  assert.equal(rc5Record.upgradedFrom, '0.0.1-rc.4', 'the upgrade must name the version it replaced');
  assert.equal(rc5Record.installPath, TARGET, 'an upgrade must not move the tree');
  assert.equal(rc5Record.channel, 'installed');
  assert.equal(rc5Record.autostart, true);
  assert.ok(rc5Record.ownership, 'the upgrade writes the current ownership credential, which is what re-enables uninstall');
});

recorded('overwrite: both installs used the same silent arguments, declared as /AUTOSTART', () => {
  assert.equal(run2.exitCode, 0, `rc.5 install must exit 0, got ${run2.exitCode}`);
  assert.ok(run2.elapsedSeconds > 0);
  assert.match(run2.arguments, /^\/S \/DIR=.+ \/AUTOSTART$/);
  assert.equal(run2.autostart, true);
  // The rc.4 run record was reconstructed because its exit code was lost; only the
  // argv is comparable, and it has to be identical for the upgrade to be an upgrade.
  assert.equal(run1.source.includes('reconstructed'), true);
  assert.equal(run1.arguments, run2.arguments, 'the upgrade must repeat the exact argv of the original install');
  assert.equal(run1.exitCode, null, 'documented gap: the rc.4 exit code was not captured');
});

recorded('overwrite: the program files were replaced by the rc.5 payload', () => {
  const fileOf = (manifest) => new Map(manifest.files.map((row) => [row.rel, row]));
  const before = fileOf(binary1);
  const after = fileOf(binary2);

  // The entry binary is what the shortcut launches; it has to be the new build.
  assert.notEqual(before.get('AIDrivenNetDefense.exe').sha256, after.get('AIDrivenNetDefense.exe').sha256);
  assert.equal(after.get('AIDrivenNetDefense.exe').exists, true);
  // The payload manifest (50k rows) is the per-payload version fingerprint.
  assert.notEqual(before.get('manifests\\files.sha256').sha256, after.get('manifests\\files.sha256').sha256);
  assert.notEqual(before.get('bundle.json').sha256, after.get('bundle.json').sha256);
  // The binary self-declares the version it was built as; read it back from the copy in
  // the tree (the frozen Setup's own resource is what `selfinfo` reads).
  assert.equal(after.get('AIDrivenNetDefense.exe').productVersion, '0.0.1-rc.5');

  // The in-tree installer copy is what QuietUninstallString names: after the upgrade a
  // second copy exists (rc.5) next to the rc.4 one, because the copy is a merge too.
  const names = binary2.installerCopies.map((row) => row.name).sort();
  assert.ok(names.some((name) => name.includes('0.0.1-rc.5')), `rc.5 installer copy missing: ${names.join(', ')}`);
  // A merge copy never purges, so the rc.4 installer copy survives next to the rc.5 one:
  // ≈68 MB of dead weight per upgrade (real behaviour, recorded rather than blessed).
  assert.ok(names.some((name) => name.includes('0.0.1-rc.4')), `older in-tree installer copy expected to remain: ${names.join(', ')}`);
});

recorded('overwrite: one desktop shortcut, pointing at the tree', () => {
  const desktops = shortcuts2.filter(
    (row) => row.exists !== false && typeof row.name === 'string' && String(row.container).toLowerCase().endsWith('desktop'),
  );
  assert.equal(desktops.length, 1, 'the upgrade must not add a second desktop icon');
  assert.equal(desktops[0].name, 'AIDriven NetDefense.lnk');
  assert.equal(desktops[0].target, join(TARGET, 'AIDrivenNetDefense.exe'));
});

// ------------------------------------------------------------------ A. replay: data

recorded('overwrite: <target>\\data is byte-for-byte identical after the upgrade', () => {
  const { before, after } = fingerprintPair('data-fingerprint');
  const diff = compareFingerprints(before, after);
  assert.equal(diff.differenceCount, 0, `diff: ${JSON.stringify(diff)}`);
  assert.equal(diff.afterCount, diff.beforeCount);
  assert.equal(diff.afterBytes, diff.beforeBytes);
  // A real database has to be in the fixture, otherwise "unchanged" is trivial.
  assert.ok(before.some((row) => row.path === 'aegis.db' && row.bytes > 0));
});

recorded('overwrite: the real user-data tree in %LOCALAPPDATA% is identical', () => {
  const { before, after } = fingerprintPair('realuserdata-fingerprint');
  assert.ok(before.length > 0, 'the real user-data tree must have been fingerprinted');
  const diff = compareFingerprints(before, after);
  assert.equal(diff.differenceCount, 0, `diff: ${JSON.stringify(diff)}`);
  // Credentials are only ever hashed: the evidence must not contain the token itself.
  const token = before.find((row) => row.path === 'data\\secrets\\api-token');
  assert.ok(token, 'the token file must be part of the fingerprint');
  assert.equal(token.bytes, 44);
  assert.match(token.sha256, /^[0-9a-f]{64}$/);
});

recorded('overwrite: dsh-home (kept on uninstall) is not unexpectedly rewritten', () => {
  const before = readFingerprint(join(T1, 'dsh-home-fingerprint-01-rc4.tsv'));
  const after = readFingerprint(join(T1, 'dsh-home-fingerprint-02-rc5.tsv'));
  assert.ok(before && before.length > 0);
  const diff = compareFingerprints(before, after);
  assert.equal(diff.added.length, 0, `files appeared: ${diff.added.join(', ')}`);
  assert.equal(diff.removed.length, 0, `files vanished: ${diff.removed.join(', ')}`);
  // This is the "user data the payload also ships" blind spot tracked in the runbook:
  // `dsh-home/profiles/aegis-analysis/*` is present in the payload AND kept on uninstall
  // (`KEEP_ON_UNINSTALL`), so an upgrade *could* overwrite edits made there. The recorded
  // rc.4 -> rc.5 pair ships identical content for those 7 files, so the diff was empty —
  // asserted exactly, so a future payload that starts overwriting them turns this red.
  assert.deepEqual(diff.changed, [], 'no dsh-home content changed in the recorded rc.4 -> rc.5 pair');
});

// ------------------------------------------------------------------ A. replay: host entries

recorded('overwrite: exactly one uninstall entry, in HKCU, with the rc.5 version', () => {
  assert.equal(host2.uninstallEntryCount, 1, 'two installs must not leave two uninstall keys');
  assert.equal(host2.hkcuCount, 1);
  assert.equal(host2.hklmCount, 0, 'a non-elevated install must not write HKLM');
  const entry = host2.uninstallEntries[0];
  assert.equal(entry.keyName, 'AIDrivenNetDefense');
  assert.equal(entry.hive, 'HKEY_CURRENT_USER');
  assert.equal(entry.values.DisplayVersion, '0.0.1-rc.5');
  assert.equal(entry.values.InstallLocation, TARGET);
  assert.equal(entry.values.Publisher, 'PT-dove');
  // The recorded uninstaller must live inside the tree, or "Apps & features" keeps an
  // entry that cannot be removed after the download is gone.
  assert.match(entry.values.UninstallString, /installer\\AIDrivenNetDefense-Setup-0\.0\.1-rc\.5\.exe" \/uninstall /);
  assert.match(entry.values.QuietUninstallString, /\/uninstall .+ \/S$/);
  assert.ok(entry.values.QuietUninstallString.startsWith(entry.values.UninstallString));
});

recorded('overwrite: exactly one Run value, still pointing at this tree', () => {
  assert.equal(host2.runValue.exists, true, 'the /AUTOSTART value must survive the upgrade');
  const names = host2.runValue.allValueNames.filter((name) => name === 'AIDrivenNetDefense');
  assert.equal(names.length, 1, 'the value name is global: the upgrade must not duplicate or drop it');
  assert.equal(host2.runValueHKLM.exists, false, 'the installer never writes machine-wide autostart');
  const command = String(host2.runValue.value);
  assert.ok(command.startsWith(`"${TARGET}\\AIDrivenNetDefense.exe"`), `unexpected Run value: ${command}`);
  // Same value before and after: the tree path did not change, only its contents did.
  assert.equal(host1.runValue.value, host2.runValue.value);
});

recorded('overwrite: exactly one Start Menu entry set, whose shortcut targets the tree', () => {
  const productDirs = (snapshot) => flatten(snapshot.startMenu)
    .filter((entry) => entry && typeof entry === 'object' && Array.isArray(entry.productDirs))
    .flatMap((root) => root.productDirs);
  const before = productDirs(host1);
  const after = productDirs(host2);
  assert.equal(before.length, 1, 'rc.4 install must create one product folder');
  assert.equal(after.length, 1, 'the upgrade must not create a second rc.4/rc.5 folder');
  const linkNames = (dir) => dir.links.map((link) => link.path.split(/[\\/]/).pop()).sort();
  assert.deepEqual(linkNames(after[0]), linkNames(before[0]), 'the same shortcut set, not an accumulated one');
  const entry = after[0].links.find((link) => link.path.endsWith('AIDriven NetDefense.lnk'));
  assert.ok(entry, 'the main shortcut must exist');
  assert.equal(entry.target, join(TARGET, 'AIDrivenNetDefense.exe'));
  assert.equal(entry.workingDirectory, TARGET);
});

// ------------------------------------------------------------------ A. replay: upgrade source

recorded('overwrite: upgradedFrom came from the registry, and the install.json fallback exists', () => {
  assert.equal(probePresent.findExisting.source, 'registry');
  assert.equal(probePresent.findExisting.version, '0.0.1-rc.4');
  assert.equal(probeAbsent.findExisting, null, 'with the key deleted there is nothing to find');
  assert.equal(probeAbsent.registryEntry, null);
  // install.py:118-125 falls back to the target's own record; that is what makes the
  // upgrade still name rc.4 when the registry was cleaned by a debloat script.
  assert.equal(probeAbsent.readInstallRecord.version, '0.0.1-rc.4');
  assert.equal(probeAbsent.readInstallRecord.channel, 'installed');
});

// ------------------------------------------------------------------ B. unit: data guard

const PYTHON_CANDIDATES = [process.env.AIDN_PYTHON, 'D:\\Python311\\python.exe', 'python'].filter(
  (value) => typeof value === 'string' && value.length > 0,
);
function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate;
  }
  return undefined;
}
const PYTHON = pickPython();
const SKIP_GUARD = process.platform === 'win32'
  ? (PYTHON === undefined ? 'no Python interpreter found' : false)
  : 'the installer is Windows-only';
const guard = (name, fn) => test(name, { skip: SKIP_GUARD }, fn);

let guardReport = null;
test('upgrade data guard: probe of the real install.py on a throwaway tree', { skip: SKIP_GUARD }, () => {
  const work = mkdtempSync(join(tmpdir(), 'aidn-upgrade-guard-'));
  try {
    const run = spawnSync(PYTHON, [GUARD_FIXTURE, work], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(run.status, 0, `fixture failed: ${run.stderr}`);
    guardReport = JSON.parse(run.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const cases = guardReport.cases;
  assert.equal(cases.absentDataDirReturnsNone, true, 'a first install has no data to probe');
  assert.equal(cases.probePicksLargestFile, true);
  assert.equal(cases.probeDigestMatches, true);
  assert.equal(cases.unchangedDataPasses, true);
  assert.equal(cases.modifiedLargestFileRefused, true, 'a file changed during the copy must abort the upgrade');
  assert.match(cases.modifiedLargestFileMessage, /被改动/);
  assert.equal(cases.removedLargestFileRefused, true, 'a file that vanished during the copy must abort the upgrade');
  assert.match(cases.removedLargestFileMessage, /丢失/);
});

guard('upgrade data guard: a non-largest file is outside its scope (documented limitation)', () => {
  assert.ok(guardReport, 'the guard fixture must have produced a report');
  assert.equal(
    guardReport.cases.nonLargestFileMutationNotDetected,
    true,
    'the guard hashes only the largest file; per-file fingerprints are what cover the rest',
  );
});

