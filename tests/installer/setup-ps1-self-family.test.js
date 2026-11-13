/**
 * N-017 (PowerShell channel): the in-tree uninstaller must not kill its own family.
 *
 * RC4-CLOSE-COMMANDER's independent review (ACTIVE-NOTICE N-024 §7) found the PowerShell
 * `Stop-TargetProcesses` had no self-family exclusion: the registry QuietUninstallString
 * points at `<install>\installer\Setup.ps1`, so running that copy puts the install root
 * in the uninstaller's own command line (and in its cmd/powershell parent's). The old
 * matcher `Stop-Process`ed them → exit non-zero, tree intact — the same P1 as N-017 in
 * the Python channel.
 *
 * Two proofs:
 *   1. unit: `Select-TargetProcesses` (the testable core) is fed a synthetic process
 *      table; only the unrelated in-tree process may be selected, never self/parent/child;
 *   2. real: a genuine install tree whose `installer\Setup.ps1` copy uninstalls that same
 *      tree → exit 0 and zero residue (the in-tree copy survives itself).
 *
 * Mutation: delete the exclusion lines from a temp copy → self is selected again and the
 * unit assertions go red (proves they are load-bearing).
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { withOwnership } from './fixtures/ownership.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'ps1-stop-family.ps1');
const SETUP_PS1 = process.env.AIDN_SETUP_PS1
  ? path.resolve(process.env.AIDN_SETUP_PS1)
  : path.join(REPO_ROOT, 'deploy', 'windows', 'installer', 'Setup.ps1');
const VERSION_FILE = path.join(REPO_ROOT, 'deploy', 'windows', 'installer', 'VERSION');

function pickPowerShell() {
  const candidates = [
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    'pwsh',
  ];
  for (const candidate of candidates) {
    if (candidate.includes('\\') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8', timeout: 60_000, windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}
const POWERSHELL = process.platform === 'win32' ? pickPowerShell() : undefined;
const skip = process.platform !== 'win32'
  ? 'the PowerShell installer is Windows-only'
  : (POWERSHELL ? false : 'no PowerShell interpreter found');

const SCRATCH = [];
function scratch(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), `aidn-psfamily-${prefix}-`));
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

function write(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Run the selection fixture against *setupPath* and return its JSON payload. */
function runFamilyFixture(setupPath) {
  const root = path.join(scratch('root'), 'AIDriven NetDefense');
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, AIDN_SETUP_TEST_DOTSOURCE: '1' };
  delete env.PSModulePath;
  const result = spawnSync(POWERSHELL, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', FIXTURE,
    '-SetupPath', setupPath,
    '-Root', root,
  ], { encoding: 'utf8', timeout: 180_000, windowsHide: true, env });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const marker = output.split(/\r?\n/u).filter((line) => line.startsWith('AIDN_PS1_FAMILY_JSON:')).pop();
  assert.ok(marker, `the fixture produced no selection (exit ${result.status}):\n${output}`);
  return JSON.parse(marker.slice('AIDN_PS1_FAMILY_JSON:'.length));
}

/** A genuine install tree: payload files + matching manifest + record, and the in-tree Setup.ps1. */
function createInstallTree() {
  const target = path.join(scratch('tree'), 'AIDriven NetDefense');
  const payloadFiles = [
    ['AIDrivenNetDefense.exe', 'MZ fixture shell\n'],
    ['runtime/node/node.exe', 'fixture runtime placeholder\n'],
    ['console/index.html', '<!doctype html><title>fixture</title>\n'],
  ];
  for (const [relative, contents] of payloadFiles) write(path.join(target, relative), contents);
  write(path.join(target, 'manifests', 'files.sha256'), [
    '# AegisHarness embedded runtime bundle - SHA-256 manifest',
    '',
    ...payloadFiles.map(([relative]) => `${sha256(path.join(target, relative))}  ${relative}`),
    '',
  ].join('\n'));
  write(path.join(target, 'install', 'install.json'), `${JSON.stringify({
    product: 'AIDriven NetDefense',
    version: '0.0.1-rc.4',
    installPath: target,
    installedAt: '2026-11-04T20:00:00+08:00',
    desktopExe: 'AIDrivenNetDefense.exe',
    entryKind: 'exe',
    autostart: false,
    upgradedFrom: null,
    channel: 'test',
  }, null, 2)}\n`);
  // RC5-N01: the in-tree copy may only delete the tree with the installer-issued
  // credential in place. Issued by the shipped Python implementation, which is also the
  // cross-channel claim: both channels must agree byte-for-byte on the message.
  withOwnership(target, { channel: 'test', version: '0.0.1-rc.4' });
  // The user path: the installer copy lives inside the tree and is what gets executed.
  mkdirSync(path.join(target, 'installer'), { recursive: true });
  cpSync(SETUP_PS1, path.join(target, 'installer', 'Setup.ps1'));
  if (existsSync(VERSION_FILE)) cpSync(VERSION_FILE, path.join(target, 'installer', 'VERSION'));
  return target;
}

function runInTreeUninstall(setupPath) {
  const target = createInstallTree();
  const work = scratch('run');
  const logDir = path.join(work, 'temp');
  mkdirSync(logDir, { recursive: true });
  const env = {
    ...process.env,
    TEMP: logDir,
    TMP: logDir,
    AIDN_SETUP_STARTMENU_DIR: path.join(work, 'start-menu'),
    AIDN_SETUP_DESKTOP_DIR: path.join(work, 'desktop'),
    AIDN_SETUP_DEFAULT_DIR: path.join(work, 'default-dir'),
  };
  delete env.PSModulePath;
  const result = spawnSync(POWERSHELL, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(target, 'installer', 'Setup.ps1'),
    '/S', '/uninstall', `/DIR=${target}`, '/NOREG',
  ], { encoding: 'utf8', timeout: 240_000, windowsHide: true, cwd: work, env });
  const logs = readdirSync(logDir).filter((name) => name.startsWith('AIDriven-Setup-') && name.endsWith('.log'));
  const log = logs.length > 0 ? readFileSync(path.join(logDir, logs[0]), 'utf8') : '';
  return { code: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${log}`, target };
}

test('the selection excludes this process, its ancestors and its descendants', { skip }, () => {
  const before = sha256(SETUP_PS1);
  const result = runFamilyFixture(SETUP_PS1);
  assert.deepEqual(
    result.selected,
    [result.unrelatedPid],
    `only the unrelated in-tree process may be selected; got ${JSON.stringify(result.selected)}`,
  );
  for (const key of ['selfPid', 'parentPid', 'childPid']) {
    assert.ok(
      result.family.includes(result[key]),
      `${key}=${result[key]} must be in the excluded family (family=${JSON.stringify(result.family)})`,
    );
  }
  assert.equal(sha256(SETUP_PS1), before, 'the fixture must not modify the repository Setup.ps1');
});

test('the in-tree PowerShell copy uninstalls its own tree: exit 0, zero residue', { skip }, () => {
  const run = runInTreeUninstall(SETUP_PS1);
  assert.equal(run.code, 0, `the in-tree uninstaller must survive itself (N-017 PS):\n${run.output}`);
  assert.equal(existsSync(run.target), false, `the install tree was not fully removed:\n${run.output}`);
});

test('mutation: deleting the family exclusion makes the uninstaller select itself (assertions are load-bearing)', { skip }, () => {
  const original = readFileSync(SETUP_PS1, 'utf8');
  let mutated = original.replace(
    '        if ($family.ContainsKey([int]$proc.ProcessId)) { continue }\n',
    '',
  );
  mutated = mutated.replace(
    '            if ($match.ContainsKey($pid2) -or $family.ContainsKey($pid2)) { continue }',
    '            if ($match.ContainsKey($pid2)) { continue }',
  );
  mutated = mutated.replace(
    '            if ($selfFamily.ContainsKey([int]$proc.ProcessId)) { continue }\n',
    '',
  );
  assert.notEqual(mutated, original, 'the mutation did not change Setup.ps1; update this mutation');
  const mutantPath = path.join(scratch('mutant'), 'Setup.ps1');
  writeFileSync(mutantPath, mutated, 'utf8');

  const result = runFamilyFixture(mutantPath);
  assert.ok(
    result.selected.includes(result.selfPid),
    `mutation should make the uninstaller select itself; selected=${JSON.stringify(result.selected)}`,
  );
  assert.ok(
    result.selected.includes(result.parentPid),
    `mutation should make the uninstaller select its parent; selected=${JSON.stringify(result.selected)}`,
  );
});
