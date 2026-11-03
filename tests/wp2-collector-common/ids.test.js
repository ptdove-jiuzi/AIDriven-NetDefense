import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_CODES,
  assertStableSourceId,
  buildSourceIdentity,
  buildStableKey,
  createCollectorInstanceId,
  isValidStableSourceId,
  parseStableKey,
} from '../../packages/collectors/common/index.js';

const INSTANCE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const INSTANCE_B = '7a1b2c3d-4e5f-4a6b-9c8d-1f2e3d4c5b6a';

function rejectsWithCode(code) {
  return (error) => error.name === 'CollectorError' && error.code === code;
}

test('stable source ids accept dotted lowercase segments and reject everything else', () => {
  for (const value of ['windows.security-log', 'linux.journald', 'windows.file.config-path']) {
    assert.equal(isValidStableSourceId(value), true);
    assert.equal(assertStableSourceId(value), value);
  }

  const rejected = [
    'Windows.Security-Log',
    'journald',
    '',
    'windows. security-log',
    'windows.security log',
    'windows.',
    'a.b.c.d.e.f',
    `windows.${'x'.repeat(120)}`,
  ];

  for (const value of rejected) {
    assert.equal(isValidStableSourceId(value), false, `expected ${JSON.stringify(value)} to be rejected`);
    assert.throws(
      () => assertStableSourceId(value),
      rejectsWithCode(ERROR_CODES.INVALID_SOURCE_ID),
      `expected ${JSON.stringify(value)} to raise INVALID_SOURCE_ID`,
    );
  }
});

test('collector instance id never participates in the stable key', () => {
  const stableSourceId = 'windows.security-log';
  const keyFromA = buildStableKey({ stableSourceId, generation: 0, nativeRecordId: 4624 });
  const keyFromB = buildStableKey({ stableSourceId, generation: 0, nativeRecordId: 4624 });

  assert.equal(keyFromA, keyFromB);
  assert.equal(keyFromA, 'windows.security-log#g0:n4624');
  assert.equal(keyFromA.includes(INSTANCE_A), false);
  assert.equal(keyFromA.includes(INSTANCE_B), false);

  const identityA = buildSourceIdentity({ stableSourceId, collectorInstanceId: INSTANCE_A, startedAt: 1_700_000_000_000 });
  const identityB = buildSourceIdentity({ stableSourceId, collectorInstanceId: INSTANCE_B, startedAt: 1_700_000_000_000 });
  assert.equal(identityA.stableSourceId, identityB.stableSourceId);
  assert.notEqual(identityA.collectorInstanceId, identityB.collectorInstanceId);
  assert.equal(identityA.startedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(Object.isFrozen(identityA), true);

  const generated = createCollectorInstanceId();
  assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('native record keys and sequence keys are distinct and round-trip through parseStableKey', () => {
  const stableSourceId = 'linux.journald';
  const nativeKey = buildStableKey({ stableSourceId, generation: 2, nativeRecordId: 'abc123' });
  const sequenceKey = buildStableKey({ stableSourceId, generation: 2, sequence: 0 });

  assert.notEqual(nativeKey, sequenceKey);
  assert.equal(nativeKey, 'linux.journald#g2:nabc123');
  assert.equal(sequenceKey, 'linux.journald#g2:s0');

  assert.deepEqual(parseStableKey(nativeKey), {
    stableSourceId,
    generation: 2,
    kind: 'native',
    value: 'abc123',
  });
  assert.deepEqual(parseStableKey(sequenceKey), {
    stableSourceId,
    generation: 2,
    kind: 'sequence',
    value: 0,
  });

  assert.equal(buildStableKey({ stableSourceId, generation: 2, sequence: 0 }), sequenceKey);
});

test('the same native record id in a new generation never collides', () => {
  const stableSourceId = 'windows.security-log';
  const before = buildStableKey({ stableSourceId, generation: 0, nativeRecordId: 1 });
  const after = buildStableKey({ stableSourceId, generation: 1, nativeRecordId: 1 });

  assert.notEqual(before, after);
  assert.equal(before, 'windows.security-log#g0:n1');
  assert.equal(after, 'windows.security-log#g1:n1');
  assert.equal(parseStableKey(before).generation, 0);
  assert.equal(parseStableKey(after).generation, 1);
});

test('native record ids are trimmed so padding cannot create a second identity', () => {
  const stableSourceId = 'windows.security-log';
  const plain = buildStableKey({ stableSourceId, generation: 0, nativeRecordId: 'abc' });
  const padded = buildStableKey({ stableSourceId, generation: 0, nativeRecordId: '  abc \t' });

  assert.equal(plain, 'windows.security-log#g0:nabc');
  assert.equal(padded, plain);
  assert.equal(parseStableKey(padded).value, 'abc');

  assert.throws(
    () => buildStableKey({ stableSourceId, generation: 0, nativeRecordId: '   ' }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
});

test('invalid generations, sequences and keys are rejected', () => {
  const stableSourceId = 'windows.security-log';

  assert.throws(
    () => buildStableKey({ stableSourceId, generation: -1, sequence: 0 }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(
    () => buildStableKey({ stableSourceId, generation: 1.5, sequence: 0 }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(
    () => buildStableKey({ stableSourceId, generation: 0, sequence: -1 }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(
    () => buildStableKey({ stableSourceId, generation: 0, sequence: 1.25 }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(
    () => buildStableKey({ stableSourceId, generation: 0, nativeRecordId: 'bad#id' }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(
    () => buildStableKey({ stableSourceId: 'NotAStableSource', generation: 0, sequence: 0 }),
    rejectsWithCode(ERROR_CODES.INVALID_SOURCE_ID),
  );

  assert.throws(() => parseStableKey('windows.security-log#x0:n1'), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => parseStableKey('windows.security-log#g0:q1'), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => parseStableKey('windows.security-log#g0:s-1'), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => parseStableKey('UPPER.CASE#g0:s1'), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => parseStableKey(''), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
});
