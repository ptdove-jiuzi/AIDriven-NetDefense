/**
 * SEED-01 (P0) regression: the PowerShell uninstaller must not delete a directory
 * that is not provably ours.
 *
 * The defect: `Setup.ps1 /S /uninstall /DIR=<any user-writable directory>` used to
 * have exactly one guard — `Test-Path` — and then `Remove-Item -Recurse -Force` on
 * every child. `tests/installer/fixtures/ps1-uninstall-guard.ps1` dot-sources the real
 * Setup.ps1 through its test seam, stubs the side effects, and drives `Uninstall-Target`
 * against forged / genuine / linked / protected directories under a temp work dir.
 *
 * The suite also mutates the guard away (a temp copy, the repository file is never
 * touched) and asserts the forged cases then get deleted — i.e. the assertions above
 * are not vacuous.
 *
 * RC5-N01: "genuine" now includes the installer-issued `install.json.ownership`
 * credential (the fixture asks the shipped Setup.ps1 for it), and the former
 * `genuine-bundle` acceptance case moved to the refusal list — a payload tree with
 * bundle.json + manifest but no record is exactly the forgeable shape.
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'ps1-uninstall-guard.ps1');
const SETUP_PS1 = process.env.AIDN_SETUP_PS1
  ? path.resolve(process.env.AIDN_SETUP_PS1)
  : path.join(REPO_ROOT, 'deploy', 'windows', 'installer', 'Setup.ps1');

/** Windows PowerShell 5.1 is what Setup.cmd uses; pwsh is the fallback. */
function pickPowerShell() {
  const candidates = [
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    'pwsh',
  ];
  for (const candidate of candidates) {
    if (candidate.includes('\\') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status === 0) return { exe: candidate, major: String(probe.stdout).trim() };
  }
  return undefined;
}

const POWERSHELL = process.platform === 'win32' ? pickPowerShell() : undefined;
const skip = process.platform !== 'win32'
  ? 'the PowerShell installer is Windows-only'
  : (POWERSHELL ? false : 'no PowerShell interpreter found');

/** Cases that must be refused: forged records, forged manifests, uncredentialed trees, links, protected roots. */
const MUST_REFUSE = [
  'forged-record-two-fields',
  'forged-record-product-channel',
  'forged-record-all-fields',
  'forged-bundle-fake-digest',
  'forged-bundle-crlf-bom',
  'forged-bundle-traversal',
  'forged-bundle-absurd-path',
  // RC5-N01: a payload tree with no install.json + credential no longer authorises a
  // recursive delete (it was half of the forgery surface).
  'genuine-bundle',
  'missing-dir',
  'junction-link',
];
const MUST_ACCEPT = ['genuine-record', 'empty-dir'];

const SCRATCH = [];
function scratch(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), `aidn-ps1-${prefix}-`));
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

/** Run the fixture against *setupPath* and return the parsed per-case verdicts. */
function runGuardFixture(setupPath, prefix) {
  const work = scratch(prefix);
  const childEnvironment = { ...process.env, AIDN_SETUP_TEST_DOTSOURCE: '1' };
  // A PS 7 parent exports a PS 7 PSModulePath; handing that to Windows PowerShell
  // 5.1 hides its own modules (Get-FileHash would be "not recognized"). Let the
  // child derive its own module path.
  delete childEnvironment.PSModulePath;
  const result = spawnSync(POWERSHELL.exe, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', FIXTURE,
    '-SetupPath', setupPath,
    '-WorkDir', work,
  ], {
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
    env: childEnvironment,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const marker = output.split(/\r?\n/u).filter((line) => line.startsWith('AIDN_PS1_GUARD_JSON:')).pop();
  assert.ok(marker, `the fixture produced no verdicts (exit ${result.status}):\n${output}`);
  const cases = JSON.parse(marker.slice('AIDN_PS1_GUARD_JSON:'.length));
  return { cases: new Map(cases.map((entry) => [entry.name, entry])), output, work };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();
}

test('the PowerShell uninstaller refuses every non-install directory and deletes nothing', { skip }, () => {
  const before = sha256(SETUP_PS1);
  const { cases, output } = runGuardFixture(SETUP_PS1, 'green');
  for (const name of MUST_REFUSE) {
    const entry = cases.get(name);
    assert.ok(entry, `case ${name} missing from fixture output:\n${output}`);
    assert.equal(entry.refused, true, `${name} was not refused (message=${entry.message})`);
    assert.equal(entry.deleted, false, `${name} directory was deleted by a refused uninstall`);
    assert.equal(entry.sentinelAlive, true, `${name} user sentinel was deleted`);
    if (name === 'junction-link') {
      assert.equal(entry.realTreeAlive, true, 'the tree behind the junction was deleted');
    }
  }
  for (const name of MUST_ACCEPT) {
    const entry = cases.get(name);
    assert.ok(entry, `case ${name} missing from fixture output:\n${output}`);
    assert.equal(entry.refused, false, `a genuine ${name} tree was refused: ${entry.message}`);
    assert.equal(entry.deleted, true, `a genuine ${name} tree was not removed`);
  }
  assert.equal(sha256(SETUP_PS1), before, 'the guard fixture must not modify the repository Setup.ps1');
});

test('mutation: deleting the ownership guard makes the forged cases deletable (assertions are load-bearing)', { skip }, () => {
  const original = readFileSync(SETUP_PS1, 'utf8');
  const guardCall = /^.*Assert-UninstallOwnership -Target \$Target.*\r?\n/gmu;
  assert.ok(guardCall.test(original), 'the guard call line is not in Setup.ps1; update this mutation');
  const mutated = original.replace(guardCall, '# MUTATION: ownership guard removed by the regression test\n');

  const mutantPath = path.join(scratch('mutant'), 'Setup.ps1');
  writeFileSync(mutantPath, mutated, 'utf8');
  const { cases } = runGuardFixture(mutantPath, 'mutant');

  const deletedForged = MUST_REFUSE.filter((name) => {
    const entry = cases.get(name);
    return entry && entry.refused === false && entry.deleted === true;
  });
  // A mutation that still refuses everything would mean the guard is not what stops
  // the deletion (i.e. the assertions are not proving what they claim).
  assert.ok(
    deletedForged.length >= 6,
    `mutation did not flip the forged cases red enough (deleted: ${deletedForged.join(', ')}); `
      + 'the ownership guard may not be the load-bearing check',
  );
  assert.ok(deletedForged.includes('forged-record-two-fields'), 'bypass A case did not flip under mutation');
  assert.ok(deletedForged.includes('forged-bundle-fake-digest'), 'bypass B case did not flip under mutation');
});
