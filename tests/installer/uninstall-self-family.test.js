/**
 * N-017 (P1): the in-tree uninstaller must not kill itself.
 *
 * DEFECT-self-uninstall (RUNTIME, 3 real reproductions): the registry
 * `QuietUninstallString` points at `<install>\installer\AIDrivenNetDefense-Setup-*.exe`.
 * A PyInstaller onefile build is two processes whose image is that very file — the
 * bootloader parent and the Python child. `procs.stop_under()` matched "image under
 * root" and `taskkill /F`ed both, so uninstalling through the user-facing path exited
 * 1, deleted nothing, and left the tree (and registry key) in place.
 *
 * The fix excludes the current process, its ancestors and its descendants
 * (`procs._self_family`). This file proves it twice:
 *   1. unit level: a mocked process snapshot puts the current process, its parent and
 *      a child *inside* the tree, plus one unrelated in-tree process — only the
 *      unrelated one may be terminated;
 *   2. real level: a copy of the installer app *inside* the install tree uninstalls
 *      that same tree (the exact user path), exits 0 and leaves zero residue.
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  const directory = mkdtempSync(join(tmpdir(), `aidn-selffam-${prefix}-`));
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

/** Inline program: patch the process snapshot, then see who stop_under() would kill. */
const SELF_FAMILY_PROGRAM = String.raw`
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ["AIDN_INSTALLER_APP"])
from aidn import procs

root = Path(os.environ["AIDN_TEST_ROOT"])
me = os.getpid()
parent = os.getppid()
image = str(root / "installer" / "AIDrivenNetDefense-Setup-0.0.1-rc.3.exe")
rows = [
    (me, parent, image),                                              # this process
    (parent, 1, image),                                               # its bootloader parent
    (424242, me, str(root / "runtime" / "node" / "node.exe")),        # our child
    (434343, 1, str(root / "app" / "AIDrivenNetDefense.exe")),        # unrelated, must die
    (444444, 1, r"C:\Windows\System32\notepad.exe"),                  # outside the tree
]
procs._snapshot = lambda: rows
killed = []


def fake_terminate(pid):
    killed.append(pid)
    return True


procs._terminate = fake_terminate


class Log:
    def __init__(self):
        self.lines = []

    def write(self, line):
        self.lines.append(str(line))


log = Log()
count = procs.stop_under(root, log)
print(json.dumps({"me": me, "parent": parent, "killed": killed, "count": count, "log": log.lines}))
`;

testWithPython('the current process, its parent and its children are never killed, even when their image is in the tree', () => {
  const root = join(scratch('mock-root'), 'AIDriven NetDefense');
  mkdirSync(join(root, 'installer'), { recursive: true });
  const env = { ...process.env, AIDN_INSTALLER_APP: INSTALLER_APP, AIDN_TEST_ROOT: root };
  const run = spawnSync(PYTHON, ['-c', SELF_FAMILY_PROGRAM], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  assert.equal(run.status, 0, `the probe failed: ${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(String(run.stdout).trim().split(/\r?\n/u).pop());
  const killed = result.killed.map(Number);
  assert.deepEqual(
    killed,
    [434343],
    `stop_under must terminate only the unrelated in-tree process; killed=${JSON.stringify(killed)}`,
  );
  assert.equal(result.count, 1, 'the reported kill count must match the one unrelated process');
});

testWithPython('a tree-internal copy of the installer uninstalls its own tree: exit 0, zero residue', () => {
  const target = join(scratch('tree'), 'AIDriven NetDefense');
  // A minimal but genuine install tree: payload files + a manifest that matches them.
  const payloadFiles = [
    ['AIDrivenNetDefense.exe', 'MZ fixture shell\n'],
    ['runtime/node/node.exe', 'fixture runtime placeholder\n'],
    ['console/index.html', '<!doctype html><title>fixture</title>\n'],
  ];
  for (const [relative, contents] of payloadFiles) write(join(target, relative), contents);
  write(join(target, 'manifests', 'files.sha256'), [
    '# AegisHarness embedded runtime bundle - SHA-256 manifest',
    '',
    ...payloadFiles.map(([relative]) => `${sha256(join(target, relative))}  ${relative}`),
    '',
  ].join('\n'));
  write(join(target, 'install', 'install.json'), `${JSON.stringify({
    product: 'AIDriven NetDefense',
    version: '0.0.1-rc.3',
    installPath: target,
    installedAt: '2026-11-04T20:00:00+08:00',
    desktopExe: 'AIDrivenNetDefense.exe',
    entryKind: 'exe',
    autostart: false,
    upgradedFrom: null,
    channel: 'installed',
  }, null, 2)}\n`);
  // RC5-N01: the tree is only uninstallable if it carries the installer-issued
  // credential for this path; issue it through the shipped implementation.
  withOwnership(target, { channel: 'installed', version: '0.0.1-rc.3' });

  // This is the user path: the installer copy inside the tree performs the uninstall.
  const inTreeApp = join(target, 'installer', 'app');
  cpSync(INSTALLER_APP, inTreeApp, { recursive: true });
  assert.ok(existsSync(join(inTreeApp, 'main.py')), 'the in-tree copy was not created');

  const work = scratch('tree-run');
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
  const run = spawnSync(
    PYTHON,
    [join(inTreeApp, 'main.py'), '/uninstall', `/DIR=${target}`, '/NOREG'],
    { encoding: 'utf8', timeout: 180_000, cwd: work, env },
  );
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  assert.equal(run.status, 0, `the in-tree uninstaller must exit 0 (N-017):\n${output}`);
  assert.equal(existsSync(target), false, `the install tree was not fully removed:\n${output}`);
});
