import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  ERROR_CODES,
  createCursorStore,
} from '../../packages/collectors/common/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';

const SOURCE_ID = 'windows.security-log';
const FILE_NAME = 'collector-cursors.json';

function rejectsWithCode(code) {
  return (error) => error.name === 'CollectorError' && error.code === code;
}

function sandboxFor(t) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  return { sandbox, directory: join(sandbox.workRoot, 'state') };
}

test('commit survives a store restart with generation, cursor and sequence intact', (t) => {
  const { directory } = sandboxFor(t);
  let now = 1_700_000_000_000;

  const store = createCursorStore({ directory, clock: () => now });
  const committed = store.commit({
    stableSourceId: SOURCE_ID,
    generation: 2,
    cursor: 'cursor-42',
    sequence: 7,
    recentKeys: ['key-a', 'key-b'],
  });

  now += 5_000;
  const reopened = createCursorStore({ directory, clock: () => now });
  const loaded = reopened.load(SOURCE_ID);

  assert.notEqual(loaded, null);
  assert.equal(loaded.generation, 2);
  assert.equal(loaded.cursor, 'cursor-42');
  assert.equal(loaded.sequence, 7);
  assert.deepEqual(loaded.recentKeys, ['key-a', 'key-b']);
  assert.equal(loaded.stableSourceId, SOURCE_ID);
  assert.deepEqual(loaded, committed);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(reopened.load('linux.journald'), null);
});

test('writes are atomic: one JSON file, no temp leftovers, formatVersion 1', (t) => {
  const { directory } = sandboxFor(t);
  const now = 1_700_000_000_000;
  const store = createCursorStore({ directory, clock: () => now });

  store.commit({ stableSourceId: SOURCE_ID, generation: 0, cursor: 'c1', sequence: 0, recentKeys: ['k1'] });

  assert.deepEqual(readdirSync(directory), [FILE_NAME]);
  const parsed = JSON.parse(readFileSync(join(directory, FILE_NAME), 'utf8'));
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.updatedAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(Object.keys(parsed.sources), [SOURCE_ID]);
  assert.equal(parsed.sources[SOURCE_ID].cursor, 'c1');
  assert.deepEqual(parsed.sources[SOURCE_ID].recentKeys, ['k1']);
  assert.deepEqual(store.stats().sources, 1);
  assert.ok(store.stats().bytes > 0);
});

test('a corrupt file is quarantined, not deleted, and the store continues empty', (t) => {
  const { directory } = sandboxFor(t);
  let now = 1_700_000_000_000;
  const filePath = join(directory, FILE_NAME);

  createCursorStore({ directory, clock: () => now });
  writeFileSync(filePath, '{');

  now += 1_000;
  const store = createCursorStore({ directory, clock: () => now });
  assert.equal(store.load(SOURCE_ID), null);

  const quarantine = store.quarantine();
  assert.equal(quarantine.quarantined, true);
  assert.notEqual(quarantine.path, null);
  assert.ok(quarantine.path.startsWith(`${filePath}.corrupt-${now}-`), quarantine.path);
  assert.equal(readFileSync(quarantine.path, 'utf8'), '{');

  const committed = store.commit({ stableSourceId: SOURCE_ID, generation: 0, cursor: 'recovered', sequence: 0 });
  assert.equal(committed.cursor, 'recovered');
  assert.deepEqual(
    readdirSync(directory).sort(),
    [FILE_NAME, basename(quarantine.path)].sort(),
  );
});

test('a second quarantine in the same millisecond does not overwrite the first', (t) => {
  const { directory } = sandboxFor(t);
  const now = 1_700_000_000_000;
  const filePath = join(directory, FILE_NAME);

  createCursorStore({ directory, clock: () => now });
  writeFileSync(filePath, '{');
  const first = createCursorStore({ directory, clock: () => now });
  first.load(SOURCE_ID);

  writeFileSync(filePath, '{"formatVersion":99}');
  const second = createCursorStore({ directory, clock: () => now });
  second.load(SOURCE_ID);

  assert.notEqual(first.quarantine().path, second.quarantine().path);
  assert.equal(readFileSync(first.quarantine().path, 'utf8'), '{');
  assert.equal(readFileSync(second.quarantine().path, 'utf8'), '{"formatVersion":99}');
});

test('the persisted file is compact JSON that stays parseable after many commits', (t) => {
  const { directory } = sandboxFor(t);
  const now = 1_700_000_000_000;
  const store = createCursorStore({ directory, clock: () => now });

  store.commit({ stableSourceId: SOURCE_ID, generation: 0, cursor: 'c1', sequence: 0, recentKeys: ['k1'] });
  store.commit({ stableSourceId: SOURCE_ID, generation: 0, cursor: 'c2', sequence: 1, recentKeys: ['k2'] });

  const raw = readFileSync(join(directory, FILE_NAME), 'utf8');
  assert.equal(raw.includes('\n'), false, 'the cursor file must not be pretty printed');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.formatVersion, 1);
  assert.deepEqual(parsed.sources[SOURCE_ID].recentKeys, ['k1', 'k2']);
});

test('advanceGeneration resets the sequence, clears the cursor and the key ring', (t) => {
  const { directory } = sandboxFor(t);
  let now = 1_700_000_000_000;
  const store = createCursorStore({ directory, clock: () => now });

  store.commit({
    stableSourceId: SOURCE_ID,
    generation: 0,
    cursor: 'cursor-old',
    sequence: 4,
    recentKeys: ['k1', 'k2'],
  });
  const advanced = store.advanceGeneration({ stableSourceId: SOURCE_ID, reason: 'log_rotated' });

  assert.equal(advanced.generation, 1);
  assert.equal(advanced.sequence, -1);
  assert.equal(advanced.cursor, null);
  assert.deepEqual(advanced.recentKeys, []);
  assert.equal(advanced.generationReason, 'log_rotated');

  now += 2_000;
  const reopened = createCursorStore({ directory, clock: () => now });
  const loaded = reopened.load(SOURCE_ID);
  assert.equal(loaded.generation, 1);
  assert.equal(loaded.sequence, -1);
  assert.equal(loaded.cursor, null);
  assert.deepEqual(loaded.recentKeys, []);
  assert.equal(loaded.generationReason, 'log_rotated');
});

test('generation rollback and sequence rollback are rejected as conflicts', (t) => {
  const { directory } = sandboxFor(t);
  const now = 1_700_000_000_000;
  const store = createCursorStore({ directory, clock: () => now });

  store.commit({ stableSourceId: SOURCE_ID, generation: 1, cursor: 'c1', sequence: 5 });

  assert.throws(
    () => store.commit({ stableSourceId: SOURCE_ID, generation: 0, cursor: 'c0', sequence: 6 }),
    rejectsWithCode(ERROR_CODES.CURSOR_STORE_CONFLICT),
  );
  assert.throws(
    () => store.commit({ stableSourceId: SOURCE_ID, generation: 1, cursor: 'c0', sequence: 4 }),
    rejectsWithCode(ERROR_CODES.CURSOR_STORE_CONFLICT),
  );
  assert.throws(
    () => store.commit({ stableSourceId: SOURCE_ID, generation: 1, cursor: 'c2', sequence: 5, generationReason: 'nonsense' }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );

  const state = store.load(SOURCE_ID);
  assert.equal(state.generation, 1);
  assert.equal(state.sequence, 5);
  assert.equal(state.cursor, 'c1');
});

test('persistedKeyWindow keeps only the newest committed stable keys', (t) => {
  const { directory } = sandboxFor(t);
  const now = 1_700_000_000_000;
  const store = createCursorStore({ directory, persistedKeyWindow: 3, clock: () => now });

  store.commit({
    stableSourceId: SOURCE_ID,
    generation: 0,
    cursor: 'c1',
    sequence: 2,
    recentKeys: ['k1', 'k2', 'k3'],
  });
  const state = store.commit({
    stableSourceId: SOURCE_ID,
    generation: 0,
    cursor: 'c2',
    sequence: 4,
    recentKeys: ['k4', 'k5'],
  });

  assert.deepEqual(state.recentKeys, ['k3', 'k4', 'k5']);

  const reopened = createCursorStore({ directory, persistedKeyWindow: 3, clock: () => now });
  assert.deepEqual(reopened.load(SOURCE_ID).recentKeys, ['k3', 'k4', 'k5']);
});
