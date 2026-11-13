/**
 * The uninstaller must prove the target is *its own* install tree before deleting.
 *
 * The Python installer (`deploy/windows/installer/app`) is the shipped uninstaller; it
 * now reads `install/install.json` and `bundle.json` instead of merely checking that the
 * files exist, and it refuses symbol links / junctions. A regression in any of those
 * three gates means `/uninstall /DIR=<a typo>` wipes a directory that was never ours —
 * unrecoverable user-data loss — so this suite drives the real process
 * (`python main.py /uninstall /DIR=…`) against real directories and asserts, for every
 * refusal, that the sentinel file that lives next to the install-looking files is
 * **still there**.
 *
 * Interop note: the check reads the fields `install()` actually writes
 * (`product` / `version` / `installPath` / `channel`). There is no `appId`/`name` in a
 * real record. RC5-N01 additionally requires `install.json.ownership` — the
 * installer-issued HMAC credential bound to this canonical path and to the manifest
 * digest — so the fixture "genuine" tree now asks the shipped `aidn.ownership`
 * implementation for that credential instead of merely looking genuine.
 *
 * Everything runs under `os.tmpdir()`; the start-menu and desktop folders are redirected
 * with the installer's documented test seams, and `/NOREG` keeps the registry untouched.
 * Directory symlinks need SeCreateSymbolicLinkPrivilege on Windows, so the junction link
 * type is used when a symlink cannot be created; both are rejected by the same guard.
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const INSTALLER_APP = join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const EXIT_TARGET_INVALID = 5;

/** Interpreters to try, in order. `AIDN_PYTHON` wins so CI can pin one. */
const PYTHON_CANDIDATES = [process.env.AIDN_PYTHON, 'D:\\Python311\\python.exe', 'python'].filter(
  (value) => typeof value === 'string' && value.length > 0,
);

function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import json, sys; sys.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate;
  }
  return undefined;
}

const PYTHON = pickPython();

/** Skip (not fail) when no interpreter is available: such a machine proves nothing. */
const testWithPython = (name, fn) =>
  test(name, { skip: PYTHON === undefined ? 'no Python interpreter found' : false }, fn);

const SCRATCH = [];

function scratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), `aidn-${prefix}-`));
  SCRATCH.push(path);
  return path;
}

process.on('exit', () => {
  for (const path of SCRATCH) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp directory is not a test result.
    }
  }
});

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/**
 * SHA-256 of a fixture file, and a manifest whose rows match the bytes on disk.
 *
 * The uninstaller verifies `manifests/files.sha256` against the tree (R6-004), so a
 * fixture that only writes `install/install.json` no longer represents a real install.
 */
function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeRealManifest(target, relativePaths) {
  const rows = [
    '# AegisHarness embedded runtime bundle - SHA-256 manifest',
    '# fixture: digests computed from the files this test wrote',
    '',
    ...relativePaths.map((relative) => `${sha256Of(join(target, relative))}  ${relative}`),
    '',
  ];
  write(join(target, 'manifests', 'files.sha256'), rows.join('\n'));
}


/**
 * Run the real uninstaller against *target*.
 *
 * `TEMP`/`TMP` are redirected so the run's log file is deterministic to find: the
 * refusal message is part of what is being tested (it must name the resolved path for a
 * link, and it must say which marker failed), and main.py only writes it to the log.
 */
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
  const result = spawnSync(
    PYTHON,
    [join(INSTALLER_APP, 'main.py'), '/uninstall', `/DIR=${target}`, '/NOREG'],
    { encoding: 'utf8', timeout: 180_000, cwd: INSTALLER_APP, env },
  );
  const logs = readdirSync(logDir).filter((name) => name.startsWith('AIDriven-Setup-') && name.endsWith('.log'));
  const log = logs.length > 0 ? readFileSync(join(logDir, logs[0]), 'utf8') : '';
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', log };
}

/** A sentinel a refusal must leave untouched: it is the user's file, not ours. */
function plantSentinel(root, name = 'keep-me.txt') {
  const path = join(root, name);
  write(path, 'this file belongs to the user and must survive a refused uninstall\n');
  return path;
}

/** Write an `install/install.json` the way `install()` really writes it. */
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
    payloadKind: 'packaging-poc',
    payloadBuiltAt: '2026-11-04T11:32:56.343Z',
    payloadSchema: '1.0',
    ...overrides,
  };
  write(join(target, 'install', 'install.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** A tree that a normal install produced (program files + the install record + credential). */
function createGenuineInstallTree(target) {
  mkdirSync(join(target, 'runtime', 'node'), { recursive: true });
  write(join(target, 'runtime', 'node', 'node.exe'), 'fixture runtime placeholder\n');
  write(join(target, 'AIDrivenNetDefense.exe'), 'MZ fixture shell\n');
  write(join(target, 'console', 'index.html'), '<!doctype html><title>fixture</title>\n');
  writeRealManifest(target, ['AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html']);
  writeInstallRecord(target);
  // RC5-N01: the content-matching record is no longer enough to authorize a delete; the
  // installer-issued credential (bound to this canonical path) is. Issued by the shipped
  // implementation so this fixture cannot drift away from what install() really writes.
  withOwnership(target, { channel: 'installed', version: '0.0.1-rc.3' });
}

/**
 * A tree shaped like an unpacked payload (`bundle.json` + hash manifest, no record).
 *
 * `kind=packaging-poc` is the shape the rc.3 portable zip ships: no product/version
 * field, so the layout in `paths` and the manifest rows are the identity evidence.
 * `kind=v14-desktop` declares product/version and the shell under `assets.desktop`.
 */
function createBundleTree(target, { kind = 'packaging-poc', product, version, author = 'PT-dove', manifestRows } = {}) {
  mkdirSync(join(target, 'runtime', 'node'), { recursive: true });
  write(join(target, 'runtime', 'node', 'node.exe'), 'fixture runtime placeholder\n');
  write(join(target, 'AIDrivenNetDefense.exe'), 'MZ fixture shell\n');
  write(join(target, 'console', 'index.html'), '<!doctype html><title>fixture</title>\n');
  const bundle = {
    schemaVersion: '1.0',
    author,
    kind,
    builtAt: '2026-11-04T11:32:56.343Z',
  };
  if (kind === 'v14-desktop') {
    bundle.product = product ?? 'AIDriven NetDefense';
    bundle.version = version ?? '0.0.1-rc.1';
    bundle.assets = { desktop: { target: 'AIDrivenNetDefense.exe', bytes: 19 } };
  } else {
    bundle.paths = { node: 'runtime/node/node.exe', console: 'console/index.html' };
  }
  write(join(target, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  const rows = manifestRows ?? [
    '# AegisHarness embedded runtime bundle — SHA-256 manifest',
    '# fixture: digests computed from the files this test wrote',
    `${sha256Of(join(target, 'runtime/node/node.exe'))}  runtime/node/node.exe`,
    `${sha256Of(join(target, 'AIDrivenNetDefense.exe'))}  AIDrivenNetDefense.exe`,
    `${sha256Of(join(target, 'console/index.html'))}  console/index.html`,
    '',
  ];
  write(join(target, 'manifests', 'files.sha256'), rows.join('\n'));
}

/**
 * Create a link *at* `link` pointing at the directory `real`.
 *
 * Node's `'junction'` type works for unprivileged users; `'dir'` (a real symlink) needs
 * SeCreateSymbolicLinkPrivilege and is tried first so the symlink branch is exercised
 * wherever the machine allows it.
 */
function linkDirectory(real, link) {
  try {
    symlinkSync(real, link, 'dir');
    return 'symlink';
  } catch {
    symlinkSync(real, link, 'junction');
    return 'junction';
  }
}

/** Every file under *root*, relative and sorted — used to prove "not one file removed". */
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

// ------------------------------------------------------------------ control: accepted

testWithPython('a real install record is accepted: the tree is removed', () => {
  const target = join(scratch('accept-record'), 'AIDriven NetDefense');
  createGenuineInstallTree(target);

  const run = runUninstall(target);
  assert.equal(run.code, 0, `a genuine install must still uninstall: ${run.log}`);
  assert.equal(existsSync(target), false, 'the accepted install tree was not removed');
});

// RC5-N01: the two bundle-only cases below used to be control cases ("an unpacked
// payload tree is still uninstalled"). That assumption *was* half of the forgery
// surface — whoever can write the target can write bundle.json plus a self-consistent
// manifest — so it is now a refusal, not an acceptance. Payload trees can still be
// removed by upgrading in place (which writes the credential) or by hand.
testWithPython('the bundle.json branch no longer authorises a packaging-poc payload tree', () => {
  const target = join(scratch('accept-bundle-poc'), 'AIDriven NetDefense');
  createBundleTree(target);
  const before = filesUnder(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.match(run.log, /归属凭据|ownership/u, 'the refusal must name the installer-built credential');
  assert.equal(existsSync(target), true, 'a refused uninstall deleted the payload tree');
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

testWithPython('the bundle.json branch no longer authorises a v14-desktop payload tree', () => {
  const target = join(scratch('accept-bundle-desktop'), 'AIDriven NetDefense');
  createBundleTree(target, { kind: 'v14-desktop' });
  const before = filesUnder(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.match(run.log, /归属凭据|ownership/u, 'the refusal must name the installer-built credential');
  assert.equal(existsSync(target), true, 'a refused uninstall deleted the payload tree');
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

// ------------------------------------------------- (a) plain non-empty directory

testWithPython('(a) a random non-empty directory is refused and not one file is deleted', () => {
  const target = join(scratch('refuse-random'), 'my-notes');
  write(join(target, 'notes.txt'), 'irreplaceable notes\n');
  write(join(target, 'sub', 'draft.md'), 'a draft\n');
  const sentinel = plantSentinel(target);
  const before = filesUnder(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5 (UninstallRefused), got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
  assert.match(run.log, /卸载被拒/u, 'the refusal must be logged as a refusal');
});

// ------------------------------------------- (b) half-set trees / wrong product record

testWithPython('(b) a tree with install/ but no install.json is refused, sentinel survives', () => {
  const target = join(scratch('refuse-half'), 'AIDriven NetDefense');
  mkdirSync(join(target, 'install'), { recursive: true });
  write(join(target, 'install', 'uninstall.json'), '{"note":"no record here"}\n');
  write(join(target, 'AIDrivenNetDefense.exe'), 'MZ fixture shell\n');
  const sentinel = plantSentinel(target);
  const before = filesUnder(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

testWithPython('(b) an install.json whose product is not ours is refused, sentinel survives', () => {
  const target = join(scratch('refuse-foreign-record'), 'some-other-app');
  mkdirSync(join(target, 'install'), { recursive: true });
  // Every other field is plausible, including this exact path: the product name is what
  // makes the directory ours, so a foreign product must still refuse.
  write(
    join(target, 'install', 'install.json'),
    `${JSON.stringify({
      product: 'Some Other App',
      version: '9.9.9',
      installPath: target,
      channel: 'installed',
    }, null, 2)}\n`,
  );
  const sentinel = plantSentinel(target);
  const before = filesUnder(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
  assert.match(run.log, /install\\install\.json 存在/u, 'the log must say which marker was inspected');
});

testWithPython('(b) an install.json with only a product name is not enough identity', () => {
  const target = join(scratch('refuse-thin-record'), 'thin');
  mkdirSync(join(target, 'install'), { recursive: true });
  write(join(target, 'install', 'install.json'), `${JSON.stringify({ product: 'AIDriven NetDefense' })}\n`);
  const sentinel = plantSentinel(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
});

// ------------------------------------------------ (c) symlink / junction to a tree

testWithPython('(c) a symlink/junction pointing at an install tree is refused; the real tree survives', () => {
  const root = scratch('refuse-link');
  const real = join(root, 'real-install-tree');
  createGenuineInstallTree(real);
  const sentinel = plantSentinel(real);
  const before = filesUnder(real);

  const link = join(root, 'linked-install-tree');
  const linkKind = linkDirectory(real, link);
  assert.ok(existsSync(link), `could not create a directory link (${linkKind})`);

  const run = runUninstall(link);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5 for a ${linkKind}, got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the uninstaller deleted files through the link');
  assert.ok(existsSync(real), 'the uninstaller deleted the real directory behind the link');
  assert.deepEqual(filesUnder(real), before, 'a refused uninstall changed the target directory');
  // The refusal must name the path the user is about to delete, not just the link.
  assert.ok(
    run.log.toLowerCase().includes(real.toLowerCase()),
    `the refusal must log the resolved real path (${real}): ${run.log}`,
  );
});

// ------------------------------------- bundle.json bypass must also validate content

testWithPython('the bundle.json bypass refuses a foreign payload identity', () => {
  const target = join(scratch('refuse-bundle-foreign'), 'looks-like-a-payload');
  createBundleTree(target, { author: 'someone-else' });
  const sentinel = plantSentinel(target);
  const before = filesUnder(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
  assert.deepEqual(filesUnder(target), before, 'a refused uninstall changed the directory');
});

testWithPython('the bundle.json bypass refuses a foreign product name and version', () => {
  const target = join(scratch('refuse-bundle-product'), 'looks-like-a-desktop-payload');
  createBundleTree(target, { kind: 'v14-desktop', product: 'Another Product', version: '1.0.0' });
  const sentinel = plantSentinel(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
});

testWithPython('the bundle.json bypass refuses a bundle.json with an empty hash manifest', () => {
  const target = join(scratch('refuse-bundle-empty-manifest'), 'looks-like-a-payload');
  createBundleTree(target, { manifestRows: ['# manifest with a header and no rows', ''] });
  const sentinel = plantSentinel(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
});

testWithPython('a bundle.json that is not even valid JSON is refused', () => {
  const target = join(scratch('refuse-bundle-invalid'), 'looks-like-a-payload');
  write(join(target, 'bundle.json'), '{ this is not json\n');
  write(join(target, 'manifests', 'files.sha256'), `${'a'.repeat(64)}  runtime/node/node.exe\n`);
  const sentinel = plantSentinel(target);

  const run = runUninstall(target);
  assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit 5, got ${run.code}: ${run.log}`);
  assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
});
