/**
 * powercut-recovery.test.js — pin the crash-safety contract of the *shipped* installer
 * channel (the Python one inside Setup.exe), as far as it can be pinned without running a
 * 30-minute install.
 *
 * Where these assertions come from: the powercut experiment (task-4,
 * `evidence/upgrade/powercut/**`) kills Setup.exe mid-copy and then asks two separate
 * questions — "is the user's data intact?" and "can the user recover by themselves?".
 * Both answers depend on ordering inside `deploy/windows/installer/app/aidn/install.py`,
 * and an ordering property is exactly the kind of thing that silently drifts during a
 * refactor. These tests are the tripwire:
 *
 * 1. a rejected target is refused **before** the payload is touched (refusal costs
 *    nothing, and a half-installed tree never appears because of a bad path);
 * 2. `install.json` is written **after** the files are copied, which is why an interrupted
 *    upgrade leaves a tree with no record (install.py:16-18 says this in prose);
 * 3. the upgrade gate (`_upgrade_marker`) is deliberately weaker than the delete gate
 *    (`_install_marker`): the latter requires the ownership credential, the former must not,
 *    because every rc.4-and-earlier user has no credential and would otherwise be unable to
 *    upgrade;
 * 4. the data probe is taken **before** the copy and re-checked **after** it;
 * 5. the write-ahead journal that would make an interrupted copy recoverable exists only in
 *    the *other*, non-shipped channel (`src/journal.mjs`); the shipped `aidn` package has no
 *    journal module at all. A P1 fix for "half-copied tree cannot be reinstalled" would have
 *    to change this file's expectations, which is the point of writing them down here.
 *
 * These are contract pins, not a reproduction of the experiment: reproducing it needs the
 * frozen Setup.exe and ~90 minutes of wall time (see `evidence/upgrade/powercut/PLAN.md`).
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const INSTALL_PY = path.join(APP_DIR, 'aidn', 'install.py');
const SRC_DIR = path.join(REPO_ROOT, 'deploy', 'windows', 'installer', 'src');

const source = readFileSync(INSTALL_PY, 'utf8');

/**
 * Body of a top-level `def name(...)` in a Python source file.
 *
 * Deliberately a text scan, not an AST: these assertions are about the *arrangement* of
 * statements inside one function, and three branches of tests/installer already parse
 * Setup.ps1 the same way. A real parser would be a dependency for six assertions.
 *
 * @param {string} name Function name.
 * @returns {string} Source text from `def name` up to the next top-level `def`/class.
 */
function functionBody(name) {
  const startMarker = `def ${name}(`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `install.py must still define ${name}()`);
  const rest = source.slice(start + startMarker.length);
  const nextDef = rest.search(/\n(?:def |async def |@|class )/u);
  return nextDef === -1 ? rest : rest.slice(0, nextDef);
}

/** First index of `needle` in `text`, or -1. */
function indexOfOrDie(text, needle, context) {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `${context}: expected to find ${JSON.stringify(needle)}`);
  return index;
}

test('a non-empty target without an install marker is refused before the payload is touched', () => {
  const install = functionBody('install');
  const guard = indexOfOrDie(install, '不是空目录，也没有安装标记', 'install()');
  const extract = indexOfOrDie(install, 'payload.extract(', 'install()');
  assert.ok(
    guard < extract,
    'the target gate must run before payload.extract: a rejected path has to cost nothing, '
      + 'and no extraction tree may be created for a target that is going to be refused',
  );

  // The gate itself is "non-empty and no upgrade marker", not "non-empty".
  const gate = install.slice(Math.max(0, guard - 700), guard + 200);
  assert.match(gate, /_has_any_entry\(/u, 'the gate must be about a non-empty target');
  assert.match(gate, /_upgrade_marker\(/u, 'the gate must use the upgrade marker, not a stricter one');
});

test('install.json is written after the tree is copied, so an interrupted copy has no record', () => {
  const install = functionBody('install');
  const copy = indexOfOrDie(install, '_copy_tree(', 'install()');
  const probe = indexOfOrDie(install, '_probe_data(', 'install()');
  const assertIntact = indexOfOrDie(install, '_assert_data_intact(', 'install()');
  const writeRecord = indexOfOrDie(install, 'INSTALL_RECORD_NAME', 'install()');

  assert.ok(probe < copy, 'the data fingerprint must be taken before the copy starts');
  assert.ok(copy < assertIntact, 'the data fingerprint must be re-checked after the copy');
  assert.ok(
    copy < writeRecord,
    'install.json must be written only after the copy: that is why a half-copied tree is '
      + 'recognisable as "no record", and moving the write earlier would let a broken tree '
      + 'pass the next upgrade gate',
  );
});

test('the upgrade gate is weaker than the delete gate on purpose', () => {
  const upgrade = functionBody('_upgrade_marker');
  const installMarker = functionBody('_install_marker');

  assert.match(
    upgrade,
    /_bundle_is_ours\(/u,
    'the upgrade gate accepts a payload tree by its bundle.json + manifests/files.sha256',
  );
  assert.doesNotMatch(
    upgrade,
    /ownership\./u,
    'the upgrade gate must not require the ownership credential: rc.4 and older trees were '
      + 'installed before it existed, and requiring it would strand every existing user',
  );
  assert.match(
    installMarker,
    /ownership\./u,
    'the delete gate must require the ownership credential (RC5-N01)',
  );
});

test('the shipped Python channel has no journal covering the copy phase', () => {
  assert.equal(
    existsSync(path.join(APP_DIR, 'aidn', 'journal.py')),
    false,
    'if a journal module appears in the shipped channel, the powercut conclusion '
      + '("a half-copied tree cannot be recovered by re-running the installer") must be '
      + 're-measured, and evidence/upgrade/powercut/PLAN.md updated',
  );

  // The write-ahead journal does exist — in the other channel, which the frozen rc.4/rc.5
  // Setup.exe does not ship. Recording that here keeps the two from being confused.
  const journalMjs = path.join(SRC_DIR, 'journal.mjs');
  assert.equal(existsSync(journalMjs), true, 'src/journal.mjs documents the crash-safe design');
  const journalSource = readFileSync(journalMjs, 'utf8');
  for (const phase of ['STAGED', 'SWAP_A', 'SWAP_B']) {
    assert.ok(journalSource.includes(`'${phase}'`), `journal.mjs must still declare the ${phase} phase`);
  }
});

test('the rc.5 factory installer that the powercut experiment measured is the frozen one', (t) => {
  const releaseDir = path.join(REPO_ROOT, 'dist', 'release', '0.0.1-rc.5');
  const sums = path.join(releaseDir, 'SHA256SUMS.txt');
  if (!existsSync(sums)) {
    // dist/ is release output and is not present in every checkout. The assertion below
    // still guards the source contract; this one only binds it to the frozen bytes.
    t.diagnostic('dist/release/0.0.1-rc.5/SHA256SUMS.txt not present in this checkout');
    return;
  }
  const expected = 'ca0297d0f4e8e7941ba1c3c2910e02380f01df5ae70289b2bcb91f9c6070884a';
  const line = readFileSync(sums, 'utf8')
    .split(/\r?\n/u)
    .find((row) => row.includes('AIDrivenNetDefense-Setup-0.0.1-rc.5.exe'));
  assert.ok(line, 'SHA256SUMS.txt must list the rc.5 Setup.exe');
  assert.equal(
    line.toUpperCase().includes(expected.toUpperCase()),
    true,
    'the measured installer must be the frozen rc.5 Setup (sha256 ca0297d0…); if the release '
      + 'was rebuilt, evidence/upgrade/powercut/** describes a different binary',
  );
});
