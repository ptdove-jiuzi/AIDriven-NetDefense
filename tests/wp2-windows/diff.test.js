import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOWS_ERROR_CODES,
  assertEntityId,
  buildSnapshotRecord,
  canonicalize,
  createSnapshotDiffer,
  identityToken,
  stateDigest,
} from '../../packages/collectors/windows/index.js';

const BASE = 1_700_000_000_000;

function item(entityId, state) {
  return { entityId, digest: stateDigest({ state }), payload: { state } };
}

test('the first read is a snapshot and the second one only reports transitions', () => {
  const differ = createSnapshotDiffer();
  const first = differ.diff([item('1', 'a'), item('2', 'b')]);
  assert.equal(first.snapshot, true);
  assert.deepEqual(first.entries.map((entry) => entry.kind), ['snapshot', 'snapshot']);

  const second = differ.diff([item('1', 'a'), item('2', 'b')]);
  assert.equal(second.snapshot, false);
  assert.deepEqual(second.entries, []);
});

test('added, changed and removed are distinguished on one cycle', () => {
  const differ = createSnapshotDiffer();
  differ.diff([item('1', 'a'), item('2', 'b')]);
  const next = differ.diff([item('1', 'a'), item('2', 'c'), item('3', 'd')]);

  const byKind = Object.fromEntries(next.entries.map((entry) => [entry.entityId, entry.kind]));
  assert.deepEqual(byKind, { '2': 'changed', '3': 'added' });

  const removed = differ.diff([item('1', 'a')]);
  assert.deepEqual(
    removed.entries.map((entry) => [entry.entityId, entry.kind]),
    [['2', 'removed'], ['3', 'removed']],
  );
});

test('a removed entity keeps the digest of the state that was last observed', () => {
  const differ = createSnapshotDiffer();
  const before = item('9', 'alive');
  differ.diff([before]);
  const after = differ.diff([]);

  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].kind, 'removed');
  assert.equal(after.entries[0].digest, before.digest);
});

test('an invalid digest is rejected before the differ advances', () => {
  // Regression: `tracked` used to be replaced before the digest was validated, so a rejected
  // batch advanced the differ and the retry for the same table emitted nothing.
  const differ = createSnapshotDiffer();
  differ.diff([item('1', 'a')]);

  assert.throws(
    () => differ.diff([{ entityId: '1', digest: 'nothex!!', payload: {} }]),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
  );

  const retry = differ.diff([item('1', 'a')]);
  assert.deepEqual(retry.entries, [], 'the differ must still consider the entity unchanged after a rejected batch');
  assert.equal(differ.size(), 1);
});

test('a truncated read suppresses removals instead of reporting live objects as gone', () => {
  const differ = createSnapshotDiffer({ maxEntities: 2 });
  differ.diff([item('1', 'a'), item('2', 'b'), item('3', 'c')].slice(0, 2));
  const truncated = differ.diff([item('1', 'a'), item('2', 'b'), item('3', 'c')]);

  assert.equal(truncated.truncated, true);
  assert.equal(truncated.suppressedRemovals, 0);
  assert.deepEqual(truncated.entries, []);
  assert.equal(differ.stats().truncatedReads, 1);

  const withRemoval = createSnapshotDiffer({ maxEntities: 2 });
  withRemoval.diff([item('1', 'a'), item('2', 'b'), item('3', 'c')]);
  const read = withRemoval.diff([item('3', 'c'), item('4', 'd')]);
  assert.equal(read.truncated, false);
  const kinds = read.entries.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ['added', 'added', 'removed', 'removed']);
});

test('two rows claiming the same identity keep the first one and are counted', () => {
  const differ = createSnapshotDiffer();
  const result = differ.diff([item('1', 'first'), item('1', 'second')]);

  assert.equal(result.entries.length, 1);
  assert.equal(result.duplicateEntities, 1);
  assert.equal(result.entries[0].digest, stateDigest({ state: 'first' }));
  assert.equal(differ.stats().duplicateEntities, 1);
});

test('entity ids reject the two characters that delimit a stable key', () => {
  assert.throws(() => assertEntityId('a:b'), /delimit a stable key/u);
  assert.throws(() => assertEntityId('a#b'), /delimit a stable key/u);
  assert.throws(() => assertEntityId(''), /non-empty/u);
  assert.equal(assertEntityId('pid-1234'), 'pid-1234');
});

test('identityToken is injective for values that used to collapse into one token', () => {
  const ipv6 = identityToken('2001:db8::1');
  const lookalike = identityToken('2001-db8--1');

  assert.notEqual(ipv6, lookalike);
  assert.equal(ipv6.startsWith('h'), true);
  assert.equal(/[#:]/.test(ipv6), false);
  assert.equal(identityToken('Spooler'), 'Spooler');
});

test('canonicalize is order independent so a reordered provider does not look like a change', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
  assert.equal(canonicalize(undefined), 'null');
  assert.equal(canonicalize(Number.NaN), 'null');
});

test('buildSnapshotRecord normalizes the payload and appends the transition', () => {
  const record = buildSnapshotRecord({
    type: 'windows.process',
    entityId: 'pid-4',
    digest: stateDigest({ state: 'a' }),
    observedAt: BASE,
    change: 'added',
    payload: { pid: 4, command_line: null, image_path: 'C:\\x.exe' },
  });

  assert.equal(record.nativeRecordId.startsWith('pid-4-'), true);
  assert.equal(record.payload.change, 'added');
  // `=== undefined` cannot tell "omitted" from "present with an undefined value"; the key
  // must be absent, because the contract rejects a null/undefined field.
  assert.equal('command_line' in record.payload, false);
  assert.equal(record.type, 'windows.process');
  assert.equal(record.severity, 'info');
});

test('buildSnapshotRecord rejects a payload key the contract would reject', () => {
  assert.throws(
    () => buildSnapshotRecord({
      type: 'windows.process',
      entityId: 'pid-4',
      digest: stateDigest({ state: 'a' }),
      observedAt: BASE,
      change: 'added',
      payload: { pid: 4, imagePath: 'C:\\x.exe' },
    }),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_RECORD,
  );
});

test('diff rejects a non-array input and a non-object row', () => {
  const differ = createSnapshotDiffer();
  assert.throws(() => differ.diff(null), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT);
  assert.throws(() => differ.diff([null]), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT);
});

test('a removal keeps the last observed digest but gets a new revision', () => {
  // The digest still describes the state that disappeared (so the event is interpretable), but
  // the revision must advance: reusing it made the removal key identical to the present key and
  // the shared dedupe window dropped the removal permanently.
  const differ = createSnapshotDiffer();
  const before = item('5', 'alive');
  differ.diff([before]);
  const after = differ.diff([]);

  assert.equal(after.entries[0].digest, before.digest);
  assert.equal(after.entries[0].revision, 2);

  const present = buildSnapshotRecord({
    type: 'windows.process',
    entityId: '5',
    digest: before.digest,
    observedAt: BASE,
    change: 'snapshot',
    payload: { pid: 5 },
    revision: 1,
  });
  const removed = buildSnapshotRecord({
    type: 'windows.process',
    entityId: '5',
    digest: after.entries[0].digest,
    observedAt: BASE,
    change: 'removed',
    payload: { pid: 5, present: false },
    revision: after.entries[0].revision,
  });
  assert.notEqual(removed.nativeRecordId, present.nativeRecordId);
});

test('every transition of one entity gets a distinct revision, including a reverted one', () => {
  const differ = createSnapshotDiffer();
  const a = item('7', 'a');
  const b = item('7', 'b');

  assert.equal(differ.diff([a]).entries[0].revision, 1);
  assert.equal(differ.diff([b]).entries[0].revision, 2);
  const reverted = differ.diff([a]);
  assert.equal(reverted.entries[0].kind, 'changed');
  assert.equal(reverted.entries[0].revision, 3, 'a state seen before must still be a new transition');

  // An unchanged read emits nothing at all, so a revision never fires twice by accident.
  assert.deepEqual(differ.diff([a]).entries, []);
  assert.equal(differ.diff([]).entries[0].revision, 4, 'the removal continues the same counter');
  assert.equal(differ.diff([a]).entries[0].revision, 5, 'a re-created entity continues the counter');
});
