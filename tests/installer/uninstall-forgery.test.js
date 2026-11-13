/**
 * R6-004 (P1): the Python uninstaller's ownership criterion must not be forgeable.
 *
 * Wave-5 re-attack (REV-CMD-E §1.1/§1.2) bypassed A1's gate with:
 *   A. `install/install.json` carrying only two plausible fields — `{product, version}`
 *      or `{product, channel}` — in a directory that was never ours;
 *   B. a handwritten `bundle.json` + a one-line `manifests/files.sha256` whose digest
 *      was never checked against the file (also accepted CRLF+BOM and `../../` paths).
 * Both ended with exit 0 and the directory deleted.
 *
 * The fix makes the criterion content, not shape: the record must match on **all**
 * four identity fields AND the payload manifest's digests must match the files on
 * disk; a manifest row may not be absolute or traverse out of the tree. This suite
 * drives the real uninstaller (`python main.py /uninstall /DIR=… /NOREG`) against
 * purpose-built directories and, for every refusal, asserts the sentinel and the full
 * file list are untouched.
 *
 * It also covers X-04 (N-011 §3): a child that cannot be deleted must make the
 * uninstall fail (non-zero exit, "卸载未完成") instead of reporting success.
 *
 * RC5-N01 changed what a "genuine" fixture *is*: the gate no longer trusts a
 * self-consistent record + manifest (re-attack RC4 forged exactly that and both channels
 * deleted the tree). A genuine tree now carries the `install.json.ownership` credential
 * the installer issues for its canonical path; `createGenuineTree` obtains it from the
 * shipped `aidn.ownership` implementation. The former control case "an unpacked payload
 * tree (bundle.json + manifest) is still uninstalled" became a refusal, because that
 * branch was half of the forgery surface.
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { withOwnership } from './fixtures/ownership.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const INSTALLER_APP = process.env.AIDN_INSTALLER_APP
  ? resolve(process.env.AIDN_INSTALLER_APP)
  : join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const EXIT_TARGET_INVALID = 5;
const EXIT_OK = 0;

const PYTHON_CANDIDATES = [process.env.AIDN_PYTHON, 'D:\\Python311\\python.exe', 'python'].filter(
  (value) => typeof value === 'string' && value.length > 0,
);
function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate;
  }
  return undefined;
}
const PYTHON = pickPython();
const testWithPython = (name, fn) =>
  test(name, { skip: PYTHON === undefined ? 'no Python interpreter found' : false }, fn);

const SCRATCH = [];
function scratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), `aidn-forge-${prefix}-`));
  SCRATCH.push(directory);
  return directory;
}
process.on('exit', () => {
  for (const directory of SCRATCH) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Leftover temp is not a test result.
    }
  }
});

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function filesUnder(root) {
  const out = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else out.push(relative);
    }
  };
  walk(root, '');
  return out.sort();
}

function runUninstall(target) {
  const work = scratch('run');
  const logDir = join(work, 'temp');
  mkdirSync(logDir, { recursive: true });
  const env = {
    ...process.env,
    TEMP: logDir,
    TMP: logDir,
    PYTHONIOENCODING: 'utf-8',
    AIDN_SETUP_STARTMENU_DIR: join(work, 'start-menu'),
    AIDN_SETUP_DESKTOP_DIR: join(work, 'desktop'),
  };
  delete env.PSModulePath;
  const result = spawnSync(
    PYTHON,
    [join(INSTALLER_APP, 'main.py'), '/uninstall', `/DIR=${target}`, '/NOREG'],
    { encoding: 'utf8', timeout: 180_000, cwd: work, env },
  );
  const logs = readdirSync(logDir).filter((name) => name.startsWith('AIDriven-Setup-') && name.endsWith('.log'));
  const log = logs.length > 0 ? readFileSync(join(logDir, logs[0]), 'utf8') : '';
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', log };
}

/** Payload-shaped files every tree carries so a real manifest can be generated. */
const PAYLOAD_FILES = [
  ['AIDrivenNetDefense.exe', 'MZ fixture shell\n'],
  ['runtime/node/node.exe', 'fixture runtime placeholder\n'],
  ['console/index.html', '<!doctype html><title>fixture</title>\n'],
];
function createPayloadFiles(target) {
  for (const [relative, contents] of PAYLOAD_FILES) write(join(target, relative), contents);
}

function writeRealManifest(target) {
  const lines = [
    '# AegisHarness embedded runtime bundle - SHA-256 manifest',
    '# fixture: digests computed from the files this case wrote',
    '',
    ...PAYLOAD_FILES.map(([relative]) => `${sha256(join(target, relative))}  ${relative}`),
    '',
  ];
  write(join(target, 'manifests', 'files.sha256'), lines.join('\n'));
}

function writeInstallRecord(target, overrides = {}) {
  const record = {
    product: 'AIDriven NetDefense',
    version: '0.0.1-rc.3',
    installPath: target,
    installedAt: '2026-11-04T20:00:00+08:00',
    desktopExe: 'AIDrivenNetDefense.exe',
    entryKind: 'exe',
    autostart: false,
    upgradedFrom: null,
    channel: 'installed',
    ...overrides,
  };
  write(join(target, 'install', 'install.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function createGenuineTree(target) {
  createPayloadFiles(target);
  writeRealManifest(target);
  writeInstallRecord(target);
  // RC5-N01: a record whose content merely agrees with itself is no longer accepted —
  // the delete needs the credential the installer issues for *this* canonical path.
  // Issued here by the shipped implementation (aidn.ownership.issue), not re-invented;
  // channel/version are taken from the record so the two cannot disagree.
  withOwnership(target);
}

function createBundleTree(target) {
  createPayloadFiles(target);
  writeRealManifest(target);
  write(join(target, 'bundle.json'), `${JSON.stringify({
    schemaVersion: '1.0',
    author: 'PT-dove',
    kind: 'packaging-poc',
    paths: { node: 'runtime/node/node.exe', console: 'console/index.html' },
  }, null, 2)}\n`);
}

function plantSentinel(target, name = 'thesis.docx') {
  const sentinel = join(target, 'notes', name);
  write(sentinel, 'irreplaceable user document\n');
  return sentinel;
}

/** Assert a refused run: exit 5, sentinel alive, and not one file changed. */
function assertRefused(target, run) {
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5 (UninstallRefused), got ${run.code}: ${run.log}`);
  assert.match(run.log, /卸载被拒/u, 'the refusal must be logged as a refusal');
  assert.equal(existsSync(target), true, 'the target directory was deleted by a refused uninstall');
}

// ---------------------------------------------------------------- forged records

testWithPython('(a1) install.json with only product+version is refused; nothing is deleted', () => {
  const target = join(scratch('forged-version'), 'my-notes');
  plantSentinel(target);
  write(join(target, 'install', 'install.json'), `${JSON.stringify({ product: 'AIDriven NetDefense', version: '1.2.3' })}\n`);
  const before = filesUnder(target);
  const run = runUninstall(target);
  assertRefused(target, run);
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

testWithPython('(a2) install.json with only product+channel is refused', () => {
  const target = join(scratch('forged-channel'), 'my-notes');
  plantSentinel(target);
  write(join(target, 'install', 'install.json'), `${JSON.stringify({ product: 'AIDriven NetDefense', channel: 'portable' })}\n`);
  const before = filesUnder(target);
  const run = runUninstall(target);
  assertRefused(target, run);
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

testWithPython('(a3) install.json with all four fields but no payload bytes is refused', () => {
  const target = join(scratch('forged-all-fields'), 'my-notes');
  plantSentinel(target);
  writeInstallRecord(target);
  const before = filesUnder(target);
  const run = runUninstall(target);
  assertRefused(target, run);
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

// ---------------------------------------------------------------- forged payload manifests

testWithPython('(b1) bundle.json + handwritten digest rows are refused (digest not verified by shape)', () => {
  const target = join(scratch('forged-bundle'), 'looks-like-a-payload');
  plantSentinel(target);
  createPayloadFiles(target);
  write(join(target, 'bundle.json'), `${JSON.stringify({
    schemaVersion: '1.0', author: 'PT-dove', kind: 'packaging-poc',
    paths: { node: 'runtime/node/node.exe' },
  })}\n`);
  write(join(target, 'manifests', 'files.sha256'), [
    `${'a'.repeat(64)}  runtime/node/node.exe`,
    `${'b'.repeat(64)}  AIDrivenNetDefense.exe`,
    `${'c'.repeat(64)}  console/index.html`,
    '',
  ].join('\n'));
  const before = filesUnder(target);
  const run = runUninstall(target);
  assertRefused(target, run);
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

testWithPython('(b2) the same forgery with CRLF + UTF-8 BOM is refused', () => {
  const target = join(scratch('forged-bom'), 'looks-like-a-payload');
  plantSentinel(target);
  createPayloadFiles(target);
  write(join(target, 'bundle.json'), `${JSON.stringify({
    schemaVersion: '1.0', author: 'PT-dove', kind: 'packaging-poc',
    paths: { node: 'runtime/node/node.exe' },
  })}\r\n`);
  const rows = [
    `${'a'.repeat(64)}  runtime/node/node.exe`,
    `${'b'.repeat(64)}  AIDrivenNetDefense.exe`,
    `${'c'.repeat(64)}  console/index.html`,
    '',
  ].join('\r\n');
  mkdirSync(join(target, 'manifests'), { recursive: true });
  writeFileSync(join(target, 'manifests', 'files.sha256'), `\uFEFF${rows}`, 'utf8');
  const before = filesUnder(target);
  const run = runUninstall(target);
  assertRefused(target, run);
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

testWithPython('(b3) a manifest row with ../ traversal is refused', () => {
  const target = join(scratch('forged-traversal'), 'looks-like-a-payload');
  plantSentinel(target);
  createPayloadFiles(target);
  write(join(target, 'bundle.json'), `${JSON.stringify({
    schemaVersion: '1.0', author: 'PT-dove', kind: 'packaging-poc',
    paths: { node: 'runtime/node/node.exe' },
  })}\n`);
  write(join(target, 'manifests', 'files.sha256'), [
    `${'a'.repeat(64)}  ../../../victim.txt`,
    `${'b'.repeat(64)}  runtime/node/node.exe`,
    `${'c'.repeat(64)}  AIDrivenNetDefense.exe`,
    '',
  ].join('\n'));
  const before = filesUnder(target);
  const run = runUninstall(target);
  assertRefused(target, run);
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

testWithPython('(b4) a manifest row with an absolute path is refused', () => {
  const target = join(scratch('forged-absurd'), 'looks-like-a-payload');
  plantSentinel(target);
  createPayloadFiles(target);
  write(join(target, 'bundle.json'), `${JSON.stringify({
    schemaVersion: '1.0', author: 'PT-dove', kind: 'packaging-poc',
    paths: { node: 'runtime/node/node.exe' },
  })}\n`);
  write(join(target, 'manifests', 'files.sha256'), [
    `${'a'.repeat(64)}  C:\\Windows\\System32\\cmd.exe`,
    `${'b'.repeat(64)}  runtime/node/node.exe`,
    `${'c'.repeat(64)}  AIDrivenNetDefense.exe`,
    '',
  ].join('\n'));
  const before = filesUnder(target);
  const run = runUninstall(target);
  assertRefused(target, run);
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

// ---------------------------------------------------------------- genuine trees still work

testWithPython('a genuine install tree (record + manifest matching disk + credential) is still uninstalled', () => {
  const target = join(scratch('genuine-record'), 'AIDriven NetDefense');
  createGenuineTree(target);
  const run = runUninstall(target);
  assert.equal(run.code, EXIT_OK, `a genuine install must uninstall: ${run.log}`);
  assert.equal(existsSync(target), false, 'the accepted install tree was not removed');
});

// RC5-N01: this used to be a control case ("the payload tree is still uninstalled").
// That assumption *was* half of the forgery surface: an attacker who can write the
// target directory can also write bundle.json + a self-consistent manifest. A payload
// tree without install.json + an installer-issued credential is now refused; it can
// still be upgraded in place (which writes the credential), or removed by hand.
testWithPython('a payload tree without install.json (bundle.json + matching manifest) is refused', () => {
  const target = join(scratch('genuine-bundle'), 'AIDriven NetDefense');
  createBundleTree(target);
  const before = filesUnder(target);
  const run = runUninstall(target);
  assertRefused(target, run);
  assert.match(run.log, /归属凭据|ownership/u, 'the refusal must name the installer-built credential');
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

// ---------------------------------------------------------------- X-04: residue is a failure

testWithPython('X-04: an undeletable child makes the uninstall fail instead of reporting success', () => {
  const target = join(scratch('residue'), 'AIDriven NetDefense');
  createGenuineTree(target);
  const victim = join(scratch('residue-victim'), 'real-dir');
  mkdirSync(victim, { recursive: true });
  write(join(victim, 'keep.txt'), 'victim data\n');
  // A junction child is not walked by shutil.rmtree (Python refuses), so it stays.
  symlinkSync(victim, join(target, 'stuck-junction'), 'junction');
  const run = runUninstall(target);
  assert.notEqual(run.code, EXIT_OK, `an uninstall with residue must not exit 0: ${run.log}`);
  assert.match(`${run.stdout}${run.stderr}${run.log}`, /卸载未完成/u, 'the failure must be reported, not swallowed');
  assert.equal(existsSync(join(target, 'stuck-junction')), true, 'the residue was expected to remain');
});
