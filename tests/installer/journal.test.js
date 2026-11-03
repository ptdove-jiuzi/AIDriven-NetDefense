/**
 * The write-ahead journal.
 *
 * The property under test is not "it serialises JSON" but "the phase on disk never lags
 * the action it describes". Everything downstream — recovery, rollback, the resume path —
 * assumes that, so it gets its own assertions.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { loadJournal, beginJournal, PHASES, TERMINAL_PHASES } from '../../deploy/windows/installer/src/journal.mjs';
import { tempRoot } from './fixtures/payload.mjs';

function journalAt(root) {
  return beginJournal({
    path: join(root, 'install', 'journal.json'),
    op: 'install',
    fromVersion: null,
    toVersion: '0.0.1',
    paths: { app: join(root, 'app'), appPrev: join(root, 'app.prev'), staging: join(root, 'staging'), db: null, dbSnapshot: null },
    fromManifestDigest: null,
    toManifestDigest: 'f'.repeat(64),
  });
}

test('a new journal starts at IDLE and carries every field recovery needs', (t) => {
  const root = tempRoot(t);
  const journal = journalAt(root);
  const onDisk = JSON.parse(readFileSync(journal.path, 'utf8'));

  assert.equal(onDisk.phase, 'IDLE');
  assert.match(onDisk.txid, /^[0-9a-f-]{36}$/u);
  for (const key of ['op', 'paths', 'manifestRelPath', 'fromManifestDigest', 'toManifestDigest', 'steps']) {
    assert.ok(Object.prototype.hasOwnProperty.call(onDisk, key), `missing ${key}`);
  }
  assert.equal(onDisk.manifestRelPath, 'manifests/files.sha256');
  assert.equal(onDisk.fromManifestDigest, null, 'a fresh install has no previous manifest, but the key must exist');
  assert.deepEqual(onDisk.steps, []);
});

test('enter() flushes the phase before returning, so a crash cannot leave the journal behind', (t) => {
  const root = tempRoot(t);
  const journal = journalAt(root);
  journal.enter(PHASES.SWAP_B, 'staging → app');
  // Read from disk, not from the object: the object would pass even if persist() never ran.
  const onDisk = JSON.parse(readFileSync(journal.path, 'utf8'));
  assert.equal(onDisk.phase, 'SWAP_B');
  assert.equal(onDisk.steps.at(-1).phase, 'SWAP_B');
  assert.equal(onDisk.steps.at(-1).ok, null, 'the outcome is unknown until settle()');
});

test('settle() records the outcome on the phase it belongs to', (t) => {
  const root = tempRoot(t);
  const journal = journalAt(root);
  journal.enter(PHASES.STAGED, 'hash pass').settle(true, '12 条通过');
  const onDisk = JSON.parse(readFileSync(journal.path, 'utf8'));
  assert.equal(onDisk.steps.at(-1).ok, true);
  assert.equal(onDisk.steps.at(-1).detail, '12 条通过');
});

test('settle() with no pending phase appends instead of overwriting history', (t) => {
  const root = tempRoot(t);
  const journal = journalAt(root);
  journal.enter(PHASES.STAGED).settle(true);
  journal.settle(false, 'late note');
  const onDisk = JSON.parse(readFileSync(journal.path, 'utf8'));
  assert.equal(onDisk.steps.length, 2);
  assert.equal(onDisk.steps.at(-1).ok, false);
});

test('an unknown phase is refused rather than written', (t) => {
  const root = tempRoot(t);
  const journal = journalAt(root);
  assert.throws(() => journal.enter('MAKE_IT_WORK'), /unknown journal phase/u);
});

test('loadJournal reports absent when there is no journal', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(loadJournal(join(root, 'nope.json')), { state: 'absent' });
});

test('loadJournal declares corrupt JSON corrupt, not absent', (t) => {
  const root = tempRoot(t);
  const path = join(root, 'journal.json');
  writeFileSync(path, '{ not json');
  const loaded = loadJournal(path);
  assert.equal(loaded.state, 'corrupt');
  assert.match(loaded.reasons.join(' '), /不是合法 JSON/u);
});

test('loadJournal declares a journal without toManifestDigest corrupt (P1-6)', (t) => {
  const root = tempRoot(t);
  const journal = journalAt(root);
  const data = JSON.parse(readFileSync(journal.path, 'utf8'));
  delete data.toManifestDigest;
  writeFileSync(journal.path, JSON.stringify(data));
  const loaded = loadJournal(journal.path);
  assert.equal(loaded.state, 'corrupt');
  assert.match(loaded.reasons.join(' '), /toManifestDigest/u);
});

test('loadJournal rejects an unknown phase value', (t) => {
  const root = tempRoot(t);
  const journal = journalAt(root);
  const data = JSON.parse(readFileSync(journal.path, 'utf8'));
  data.phase = 'ALMOST_DONE';
  writeFileSync(journal.path, JSON.stringify(data));
  assert.equal(loadJournal(journal.path).state, 'corrupt');
});

test('loadJournal round-trips a valid journal into a usable object', (t) => {
  const root = tempRoot(t);
  const journal = journalAt(root);
  journal.enter(PHASES.STAGED).settle(true);
  const loaded = loadJournal(journal.path);
  assert.equal(loaded.state, 'ok');
  assert.equal(loaded.journal.phase, 'STAGED');
  assert.equal(loaded.journal.txid, journal.txid);
});

test('terminal phases are exactly the ones a new transaction may start from', () => {
  assert.equal(TERMINAL_PHASES.has(PHASES.COMMITTED), true);
  assert.equal(TERMINAL_PHASES.has(PHASES.ROLLED_BACK), true);
  assert.equal(TERMINAL_PHASES.has(PHASES.UNINSTALLED), true);
  for (const phase of [PHASES.STAGED, PHASES.SWAP_A, PHASES.SWAP_B, PHASES.ROLLING_BACK, PHASES.UNINSTALLING, PHASES.PURGING]) {
    assert.equal(TERMINAL_PHASES.has(phase), false, `${phase} must not be terminal`);
  }
});
