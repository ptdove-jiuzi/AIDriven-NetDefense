/**
 * v15 payload contract: the desktop shell is in the payload, at the only path that works.
 *
 * v14 proved the payload has a daemon, a console and a rule pack. v15 adds one thing —
 * `AIDrivenNetDefense.exe` — and this suite is the regression test for *how* it is added,
 * because the path is load-bearing rather than cosmetic:
 *
 * - `aidn.paths.install_root()` returns the running executable's own directory, and the
 *   shell then looks for `apps/daemon/bin.js`, `runtime/node/node.exe` and `console/`
 *   beside it. The same binary staged under `app/` starts its tray and reports
 *   `DAEMON_OFFLINE` (measured: docs/implementation/evidence/rc3/layout-probe.json), so a
 *   future profile edit that moves it there must fail here with an explanation.
 * - `AIDrivenNetDefense.exe` must be the *first* entry of the installer's
 *   `ENTRY_CANDIDATES`; if it stopped matching, the installer would silently fall back to
 *   `launch/aegis-console.cmd` and the product would stop being a tray program.
 *
 * Bundle location: `dist/bundle/win32-x64-v15`, overridable with `M15_BUNDLE_DIR`.
 * Everything here is a file/hash check: no process is spawned.
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyManifestAgainstDisk } from './repro-compare.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BUNDLE_ROOT = resolve(process.env.M15_BUNDLE_DIR ?? join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v15'));
const EXE_NAME = 'AIDrivenNetDefense.exe';
const CONSTANTS = join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app', 'aidn', 'constants.py');

const bundleJson = () => JSON.parse(readFileSync(join(BUNDLE_ROOT, 'bundle.json'), 'utf8'));
const launchPlan = () => JSON.parse(readFileSync(join(BUNDLE_ROOT, 'launch', 'launch-plan.json'), 'utf8'));

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('v15 payload: desktop asset', () => {
  it('bundle.json records the shell with a digest', () => {
    const { assets } = bundleJson();
    assert.ok(assets !== undefined, 'bundle.json has no assets section: the shell was not staged');
    const desktop = assets.desktop;
    assert.ok(desktop !== undefined, 'bundle.json.assets.desktop is missing');
    assert.equal(desktop.target, EXE_NAME);
    assert.equal(desktop.sha256.length, 64);
    assert.ok(desktop.bytes > 1_000_000, `implausibly small shell: ${desktop.bytes} bytes`);
    assert.equal(desktop.sourcePath, 'dist/desktop/AIDrivenNetDefense.exe');
  });

  it('the recorded digest is the digest of the shipped bytes', () => {
    const desktop = bundleJson().assets.desktop;
    const path = join(BUNDLE_ROOT, EXE_NAME);
    assert.ok(existsSync(path), `missing from the payload root: ${EXE_NAME}`);
    assert.equal(statSync(path).size, desktop.bytes);
    assert.equal(sha256OfFile(path), desktop.sha256);
    // A PE, not a text stub with the right name.
    assert.equal(readFileSync(path).subarray(0, 2).toString('latin1'), 'MZ');
  });

  it('sits at the payload root, not under app/', () => {
    // The reason is behavioural (layout-probe: app/ => DAEMON_OFFLINE), but the
    // invariant is positional and can be checked without starting anything.
    assert.ok(existsSync(join(BUNDLE_ROOT, EXE_NAME)));
    assert.ok(!existsSync(join(BUNDLE_ROOT, 'app', EXE_NAME)),
      'the shell is under app/, where the shell cannot find apps/daemon/bin.js or runtime/node/node.exe');
    assert.ok(existsSync(join(BUNDLE_ROOT, 'apps', 'daemon', 'bin.js')));
    assert.ok(existsSync(join(BUNDLE_ROOT, 'runtime', 'node', 'node.exe')));
    assert.ok(existsSync(join(BUNDLE_ROOT, 'console', 'index.html')));
  });

  it('the installer resolves this payload to the shell, not to a .cmd', () => {
    const source = readFileSync(CONSTANTS, 'utf8');
    const block = source.slice(source.indexOf('ENTRY_CANDIDATES'));
    const first = /\(\s*"([^"]+\.exe)"\s*,\s*"exe"\s*\)/.exec(block);
    assert.ok(first !== null, 'ENTRY_CANDIDATES no longer starts with an .exe entry');
    assert.equal(first[1].replace(/\\\\/g, '/'), EXE_NAME,
      `the first installer candidate is ${first[1]}, so an install would not launch the tray shell`);
    assert.ok(existsSync(join(BUNDLE_ROOT, ...first[1].replace(/\\\\/g, '/').split('/'))));
  });

  it('manifests/files.sha256 covers the shell', () => {
    const manifest = readFileSync(join(BUNDLE_ROOT, 'manifests', 'files.sha256'), 'utf8');
    const row = manifest.split('\n').find((line) => line.endsWith(`  ${EXE_NAME}`));
    assert.ok(row !== undefined, `${EXE_NAME} is not in manifests/files.sha256`);
    assert.equal(row.slice(0, 64), bundleJson().assets.desktop.sha256);
    const result = verifyManifestAgainstDisk(BUNDLE_ROOT);
    assert.equal(result.mismatched.length, 0, `differing: ${result.mismatched.slice(0, 5).join(', ')}`);
    assert.equal(result.unlisted.length, 0, `on disk but unlisted: ${result.unlisted.slice(0, 5).join(', ')}`);
  });

  it('the launch plan names the shell it ships', () => {
    const plan = launchPlan();
    assert.ok(plan.desktop !== undefined, 'launch-plan.json has no desktop section');
    assert.equal(plan.desktop.executable, EXE_NAME);
    assert.equal(plan.desktop.sha256, bundleJson().assets.desktop.sha256);
    assert.ok(existsSync(join(BUNDLE_ROOT, ...plan.desktop.executable.split('/'))));
  });

  it('nonGoals describes this payload, not v14', () => {
    const { nonGoals } = bundleJson();
    assert.ok(Array.isArray(nonGoals) && nonGoals.length > 0);
    const joined = nonGoals.join(' | ');
    // v14's list said there is no installer and no updater. rc.3 ships an installer, so
    // copying that line forward would be a false statement about the delivered product.
    assert.ok(!/formal installer/i.test(joined),
      `nonGoals still claims there is no formal installer: ${joined}`);
    assert.ok(/code signing/i.test(joined), 'nonGoals stopped saying the build is unsigned');
    assert.ok(/four-OS/i.test(joined), 'nonGoals stopped saying this is win32-x64 only');
  });
});
