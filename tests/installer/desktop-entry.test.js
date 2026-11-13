/**
 * A payload that declares a desktop shell but does not contain it must be refused.
 *
 * The Python installer (`deploy/windows/installer/app`) resolves its entry point from a
 * candidate list that ends with `launch\aegis-console.cmd`. That order is deliberate —
 * a v13-shaped payload still has to be installable — but it means "no shell" degrades
 * into "installs as a console launcher" unless something asks for the shell by name.
 * `bundle.json.assets.desktop` is that something, and this suite is its regression test.
 *
 * The installer is exercised as a real process (`python main.py /S …`) against a real
 * `payload.7z`, because the defect being guarded lives in the extraction path, not in a
 * pure function: a unit test of `missing_desktop_reason()` alone would still pass if the
 * installer stopped calling it.
 *
 * Self-proof: the last case deletes the guard from a copy of the tree and asserts the
 * refusing case then succeeds. Without it, a green run here would only mean "the bad
 * payload happened to fail for some other reason".
 *
 * Requirements: a Python with `py7zr` (the installer's own decoder). Skipped, not failed,
 * when none is available — a machine without the build interpreter proves nothing.
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const INSTALLER_APP = join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const EXE = 'AIDrivenNetDefense.exe';

/** Interpreters to try, in order. `AIDN_PYTHON` wins so CI can pin one. */
const PYTHON_CANDIDATES = [
  process.env.AIDN_PYTHON,
  'D:\\Python311\\python.exe',
  'python',
].filter((value) => typeof value === 'string' && value.length > 0);

function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import py7zr, sys; sys.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate;
  }
  return undefined;
}

const PYTHON = pickPython();
const SCRATCH = [];

function scratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), `aidn-${prefix}-`));
  SCRATCH.push(path);
  return path;
}

process.on('exit', () => {
  for (const path of SCRATCH) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not a test result.
    }
  }
});

/**
 * Recursive copy by hand rather than `cpSync`.
 *
 * `cpSync`'s native fast path is not reliable under the file-access broker this suite can
 * run under (it fails with ESRCH for file→file and has been seen to abort the process for
 * directory→directory), and a test that dies in its own setup proves nothing.
 */
function copyTree(source, target) {
  if (statSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

/** Copy the installer sources somewhere writable; `payload.7z` is expected beside main.py. */
function copyInstaller(target) {
  for (const name of ['main.py', 'version_info.py', '_selfcheck.py', 'adopt.py']) {
    const source = join(INSTALLER_APP, name);
    if (existsSync(source)) copyFileSync(source, join(target, name));
  }
  copyTree(join(INSTALLER_APP, 'aidn'), join(target, 'aidn'));
}

/**
 * Write a payload and pack it as `payload.7z` next to the copied installer.
 *
 * `withShell=false` keeps the declaration and drops the file — the exact shape of a
 * payload whose shell was lost between build and packaging.
 */
function packPayload(appDir, { withShell = true, corruptDigest = false } = {}) {
  const payload = scratch('payload');
  mkdirSync(join(payload, 'launch'), { recursive: true });
  writeFileSync(join(payload, 'launch', 'aegis-console.cmd'), '@echo off\r\nexit /b 0\r\n');
  writeFileSync(join(payload, 'README-BUNDLE.md'), '# stub payload for the installer test\n');
  // Something a launcher could be resolved to, so a payload without the shell still has
  // a candidate: that is what makes the fallback silent instead of fatal.
  mkdirSync(join(payload, 'rules'), { recursive: true });
  writeFileSync(join(payload, 'rules', 'defense-seed-pack.json'), '{}\n');

  const exeBytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 0x5a)]);
  const digest = createHash('sha256').update(exeBytes).digest('hex');
  if (withShell) writeFileSync(join(payload, EXE), exeBytes);

  writeFileSync(join(payload, 'bundle.json'), `${JSON.stringify({
    schemaVersion: '1.0',
    author: 'PT-dove',
    kind: 'packaging-poc',
    builtAt: '2026-11-04T00:00:00.000Z',
    assets: {
      desktop: {
        target: EXE,
        bytes: exeBytes.length,
        sha256: corruptDigest ? 'f'.repeat(64) : digest,
      },
    },
  }, null, 2)}\n`);

  const archive = join(appDir, 'payload.7z');
  // Entries are named explicitly rather than with `writeall(root, '.')`: the latter
  // stores a "." entry, which py7zr refuses to extract ("Specified path is bad: ."),
  // and the real payload.7z (7-Zip, `cwd=payload`, `.`) has no such entry either.
  const pack = `
import os, sys, py7zr
root = sys.argv[2]
with py7zr.SevenZipFile(sys.argv[1], 'w') as archive:
    for directory, _, names in os.walk(root):
        for name in sorted(names):
            full = os.path.join(directory, name)
            archive.write(full, os.path.relpath(full, root).replace(os.sep, '/'))
`;
  const result = spawnSync(PYTHON, ['-c', pack, archive, payload], { encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.status, 0, `packing the payload failed: ${result.stderr}`);
  return archive;
}

function runInstaller(appDir, target) {
  const result = spawnSync(
    PYTHON,
    [join(appDir, 'main.py'), '/S', `/DIR=${target}`, '/NOREG', '/NOSHORTCUT'],
    { encoding: 'utf8', timeout: 300_000, cwd: appDir },
  );
  const record = join(target, 'install', 'install.json');
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    record: existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : undefined,
  };
}

/** Prepare an app copy with a payload packed beside it. */
function stage(options) {
  const appDir = scratch('app');
  copyInstaller(appDir);
  packPayload(appDir, options);
  return appDir;
}

describe('installer rejects a payload that declares a shell and lacks it', { skip: PYTHON === undefined }, () => {
  it('installs the declared shell when it is present (control)', () => {
    const appDir = stage({});
    const target = join(scratch('target'), 'AIDriven NetDefense');
    const run = runInstaller(appDir, target);
    assert.equal(run.code, 0, `expected success, got ${run.code}: ${run.stdout}${run.stderr}`);
    assert.ok(run.record !== undefined, 'no install/install.json was written');
    assert.equal(run.record.desktopExe, EXE);
    assert.equal(run.record.entryKind, 'exe');
    assert.ok(existsSync(join(target, EXE)));
  });

  it('refuses, and creates nothing, when the declared shell is missing', () => {
    const appDir = stage({ withShell: false });
    const target = join(scratch('target'), 'AIDriven NetDefense');
    const run = runInstaller(appDir, target);
    // 4 = EXIT_NO_ENTRY: "this payload is wrong", not "this machine failed".
    assert.equal(run.code, 4, `expected exit 4, got ${run.code}: ${run.stdout}${run.stderr}`);
    assert.equal(run.record, undefined, 'the installer wrote an install.json for a payload it should have refused');
    assert.ok(!existsSync(join(target, 'launch', 'aegis-console.cmd')),
      'the installer fell back to the console launcher instead of refusing');
  });

  it('refuses a shell whose bytes do not match the declared digest', () => {
    const appDir = stage({ corruptDigest: true });
    const target = join(scratch('target'), 'AIDriven NetDefense');
    const run = runInstaller(appDir, target);
    assert.equal(run.code, 4, `expected exit 4, got ${run.code}: ${run.stdout}${run.stderr}`);
    assert.equal(run.record, undefined);
  });

  it('the guard is what refuses: removing it makes the refusing case succeed', () => {
    const appDir = stage({ withShell: false });
    const payloadModule = join(appDir, 'aidn', 'payload.py');
    const text = readFileSync(payloadModule, 'utf8');
    const marker = 'def missing_desktop_reason(root: Path) -> str | None:';
    assert.ok(text.includes(marker), 'payload.py no longer defines missing_desktop_reason as expected');
    writeFileSync(
      payloadModule,
      text.replace(marker, `${marker}\n    return None  # mutation: guard removed for this case`),
    );
    const target = join(scratch('target'), 'AIDriven NetDefense');
    const run = runInstaller(appDir, target);
    assert.equal(run.code, 0,
      'with the guard removed the install still failed, so the refusal above proves nothing about the guard');
    assert.ok(run.record !== undefined, 'the mutated installer produced no install.json');
    assert.equal(run.record.entryKind, 'cmd', 'the mutated installer did not fall back to the console launcher');
  });
});
