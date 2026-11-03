/**
 * Packaging invariants for the portable archive (author PT-dove).
 *
 * These run against a *synthetic* payload, on purpose: the point is the packaging
 * rules, not the 451 MiB v13 tree. The rules being pinned:
 *
 *   * entry count is exactly payload files + added files, computed, never assumed;
 *   * a payload whose own manifest does not reconcile with its tree is refused;
 *   * the launcher artifacts carry no absolute path, so the package stays relocatable;
 *   * nothing in the package registers a service, writes the registry or installs
 *     into ProgramData;
 *   * the release label is a packaging label only — the product version stays 0.0.0.
 *
 * The real artifact is checked separately in `artifact.test.js`, which skips when
 * `dist/` has not been built.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ZipArchive } from '../../scripts/release/lib/zip-read.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK = join(REPO_ROOT, 'scripts', 'release', 'pack-portable.mjs');
const ASSETS = join(REPO_ROOT, 'scripts', 'release', 'assets');
const NODE = process.execPath;

const ROOT = mkdtempSync(join(tmpdir(), 'dist-pack-'));

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** A payload shaped like the real one, small enough to pack in milliseconds. */
function makePayload(name, { breakManifest = false } = {}) {
  const payload = join(ROOT, name);
  const files = [
    'bundle.json',
    'app/x.txt',
    'launch/aegis-harness-worker.cmd',
    'launch/launch-plan.json',
    'launch/prepare-attempt.mjs',
    'runtime/node/node.exe',
    'runtime/node/runtime.json',
  ];
  for (const relative of files) {
    const target = join(payload, ...relative.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `fixture ${relative}\n`);
  }
  const rows = files.map((relative) => `${createHash('sha256').update(readFileSync(join(payload, ...relative.split('/')))).digest('hex')}  ${relative}`);
  if (breakManifest) rows.push(`${'0'.repeat(64)}  ghost.txt`);
  mkdirSync(join(payload, 'manifests', 'licenses'), { recursive: true });
  writeFileSync(join(payload, 'manifests', 'files.sha256'), `${rows.join('\n')}\n`);
  writeFileSync(join(payload, 'manifests', 'licenses', 'l.txt'), 'license text\n');
  return payload;
}

/** Assets are copied so the pack run cannot rewrite the repository's copy. */
function makeAssets(name) {
  const assets = join(ROOT, name);
  cpSync(ASSETS, assets, { recursive: true });
  rmSync(join(assets, 'SHA256SUMS'), { force: true });
  return assets;
}

function pack({ payload, assets, out, extra = [] }) {
  return spawnSync(NODE, [PACK, '--payload', payload, '--assets', assets, '--out', out, ...extra], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

test('entry count is payload files plus added files, and SHA256SUMS verifies', () => {
  const payload = makePayload('payload-ok');
  const assets = makeAssets('assets-ok');
  const out = join(ROOT, 'out-ok.zip');
  const result = pack({ payload, assets, out, extra: ['--expect-payload-files', '0'] });
  assert.equal(result.status, 0, `pack failed:\n${result.stdout}\n${result.stderr}`);

  const payloadFiles = ['app/x.txt', 'bundle.json', 'launch/aegis-harness-worker.cmd', 'launch/launch-plan.json',
    'launch/prepare-attempt.mjs', 'manifests/files.sha256', 'manifests/licenses/l.txt',
    'runtime/node/node.exe', 'runtime/node/runtime.json'];
  const addedFiles = ['README-快速开始.txt', 'SHA256SUMS', 'launcher/aidnd-launch.mjs', 'launcher/aidnd-stop.mjs',
    'launcher/lib/attempt.mjs', 'launcher/lib/version.mjs', 'start.cmd', 'stop.cmd'];

  const archive = new ZipArchive(out);
  try {
    const names = archive.fileEntries().map((entry) => entry.name).sort();
    assert.equal(names.length, payloadFiles.length + addedFiles.length);
    for (const name of [...payloadFiles, ...addedFiles]) assert.ok(names.includes(name), `${name} must be in the archive`);

    const sums = archive.readFile(archive.entries.find((entry) => entry.name === 'SHA256SUMS')).toString('utf8')
      .split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('#'));
    const listed = new Set(sums.map((row) => row.slice(66)));
    for (const name of addedFiles.filter((name) => name !== 'SHA256SUMS')) {
      assert.ok(listed.has(name), `${name} must be listed in SHA256SUMS`);
    }
    for (const row of sums) {
      const entry = archive.entries.find((candidate) => candidate.name === row.slice(66));
      assert.ok(entry !== undefined, `SHA256SUMS lists ${row.slice(66)}, which is not shipped`);
      const actual = createHash('sha256').update(archive.readFile(entry)).digest('hex');
      assert.equal(actual, row.slice(0, 64), `${row.slice(66)} must hash to its recorded value`);
    }
  } finally {
    archive.close();
  }
});

test('a payload whose manifest does not reconcile with its tree is refused', () => {
  const payload = makePayload('payload-broken', { breakManifest: true });
  const assets = makeAssets('assets-broken');
  const out = join(ROOT, 'out-broken.zip');
  const result = pack({ payload, assets, out, extra: ['--expect-payload-files', '0'] });
  assert.notEqual(result.status, 0, 'packing must fail when the tree and the manifest disagree');
  assert.match(`${result.stdout}${result.stderr}`, /does not reconcile/);
});

test('the launcher artifacts contain no absolute path', () => {
  // Same predicate the portability suite uses: a drive letter or UNC prefix, but
  // not a URL scheme.
  const DRIVE_OR_UNC = /(?:^|[^A-Za-z])[A-Za-z]:[\\/]|^\\\\/;
  const files = ['start.cmd', 'stop.cmd', 'launcher/aidnd-launch.mjs', 'launcher/aidnd-stop.mjs',
    'launcher/lib/attempt.mjs', 'launcher/lib/version.mjs'];
  for (const relative of files) {
    const text = readFileSync(join(ASSETS, ...relative.split('/')), 'utf8');
    assert.equal(DRIVE_OR_UNC.test(text), false, `${relative} must not carry an absolute path`);
    assert.equal(text.includes('..\\'), false, `${relative} must not climb out with ..\\`);
  }
});

test('start.cmd and stop.cmd resolve the package root from their own location', () => {
  for (const name of ['start.cmd', 'stop.cmd']) {
    const text = readFileSync(join(ASSETS, name), 'utf8');
    assert.ok(text.includes('for %%I in ("%~dp0.") do set "AIDND_ROOT=%%~fI"'),
      `${name} must derive the root from %~dp0`);
    assert.ok(text.includes('runtime\\node\\node.exe'), `${name} must use the bundled runtime`);
  }
});

test('the package registers no service and writes no registry or ProgramData path', () => {
  const files = ['start.cmd', 'stop.cmd', 'launcher/aidnd-launch.mjs', 'launcher/aidnd-stop.mjs',
    'launcher/lib/attempt.mjs', 'launcher/lib/version.mjs'];
  for (const relative of files) {
    const text = readFileSync(join(ASSETS, ...relative.split('/')), 'utf8');
    for (const forbidden of [/reg\s+add/i, /RegCreateKey/i, /sc\s+create/i, /New-Service/i, /ProgramData\\AIDriven/i]) {
      assert.equal(forbidden.test(text), false, `${relative} must not contain ${forbidden}`);
    }
  }
});

test('the release label is packaging-only and the product version is still 0.0.0', () => {
  const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(rootPackage.version, '0.0.0', 'this task must not change the repository version');

  const versionModule = readFileSync(join(ASSETS, 'launcher', 'lib', 'version.mjs'), 'utf8');
  assert.match(versionModule, /PRODUCT_VERSION = '0\.0\.0'/);
  assert.match(versionModule, /RELEASE_LABEL = '0\.0\.1-rc\.1'/);
  assert.match(versionModule, /VERSION_FROZEN = false/);

  const readme = readFileSync(join(ASSETS, 'README-快速开始.txt'), 'utf8');
  assert.match(readme, /预发布/, 'the README must say the label is a pre-release');
  assert.match(readme, /不代表版本已冻结/, 'the README must say the version is not frozen');
  assert.match(readme, /0\.0\.0/, 'the README must state the unchanged product version');
});

test('the archive name follows the agreed pattern', async () => {
  const { DEFAULT_LABEL } = await import('../../scripts/release/pack-portable.mjs');
  const expected = `AIDriven-NetDefense-${DEFAULT_LABEL}-win-x64-portable.zip`;
  assert.match(expected, /^AIDriven-NetDefense-\d+\.\d+\.\d+-rc\.\d+-win-x64-portable\.zip$/);

  const distDir = join(REPO_ROOT, 'dist');
  if (!existsSync(distDir)) return; // dist/ is build output; absent on a clean checkout
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
    assert.equal(entry.name, expected, `unexpected archive name in dist/: ${entry.name}`);
  }
});
