/**
 * state-store.test.js — the durable checkpoint.
 *
 * The property under test is narrow and non-negotiable: a checkpoint is either the
 * previous complete file or the new complete file. A half-written file, a wrong
 * schema and an oversized file are all treated as "untrusted" — quarantined by
 * rename, never deleted, and never half-applied.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import {
  STATE_SCHEMA_VERSION,
  atomicWriteJson,
  createEmptyState,
  createStateFile,
  normalizeState,
} from '../../apps/daemon/src/state-store.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { BASE_MS, makeTempDir, TEST_EPOCH } from './helpers.js';

describe('createEmptyState', () => {
  it('is a versioned record with zeroed counters', () => {
    const state = createEmptyState('epoch-1');
    assert.equal(state.schema_version, STATE_SCHEMA_VERSION);
    assert.equal(state.epoch, 'epoch-1');
    assert.deepEqual(state.sources, {});
    assert.equal(state.counters.events_received, 0);
    assert.equal(state.updated_at, null);
  });
});

describe('atomicWriteJson', () => {
  it('creates parent directories and leaves no temporary file behind', () => {
    const dir = makeTempDir();
    const target = join(dir, 'nested', 'state.json');
    atomicWriteJson(target, { hello: 'world' });
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).hello, 'world');
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['state.json']);
  });

  it('replaces an existing file in one step', () => {
    const dir = makeTempDir();
    const target = join(dir, 'state.json');
    atomicWriteJson(target, { generation: 1 });
    atomicWriteJson(target, { generation: 2 });
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).generation, 2);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
  });
});

describe('normalizeState', () => {
  it('rejects a foreign schema version', () => {
    assert.throws(() => normalizeState({ schema_version: 99, epoch: TEST_EPOCH }), /unsupported state schema/u);
  });

  it('rejects a missing epoch and a non-object sources map', () => {
    assert.throws(() => normalizeState({ schema_version: 1, epoch: '' }), /epoch/u);
    assert.throws(() => normalizeState({ schema_version: 1, epoch: 'not-a-uuid' }), /UUIDv4/u);
    assert.throws(() => normalizeState({ schema_version: 1, epoch: TEST_EPOCH, sources: [] }), /sources/u);
  });

  it('repairs counter types instead of trusting them', () => {
    const state = normalizeState({
      schema_version: 1,
      epoch: TEST_EPOCH,
      counters: { events: 'lots', polls: -3, alerts: 7 },
    });
    assert.equal(state.counters.events, 0);
    assert.equal(state.counters.polls, 0);
    assert.equal(state.counters.alerts, 7);
  });
});

describe('createStateFile', () => {
  it('reports a missing checkpoint without treating it as corruption', () => {
    const dir = makeTempDir();
    const clock = createManualClock(BASE_MS);
    const file = createStateFile({ path: join(dir, 'daemon-state.json'), clock });
    const loaded = file.load();
    assert.deepEqual(loaded, { state: null, corrupt: false, restored_from: null });
  });

  it('round-trips cursors, epoch and counters', () => {
    const dir = makeTempDir();
    const clock = createManualClock(BASE_MS);
    const path = join(dir, 'daemon-state.json');
    const file = createStateFile({ path, clock });
    const state = createEmptyState(TEST_EPOCH);
    state.sources = { 'synthetic.process': { cursor: { offset: 42 }, generation: 2, sequence: 7, last_success_at: 'x', events: 9 } };
    state.counters.events_received = 11;
    file.save(state);

    const reloaded = createStateFile({ path, clock }).load();
    assert.equal(reloaded.corrupt, false);
    assert.equal(reloaded.state.epoch, TEST_EPOCH);
    assert.deepEqual(reloaded.state.sources['synthetic.process'].cursor, { offset: 42 });
    assert.equal(reloaded.state.sources['synthetic.process'].sequence, 7);
    assert.equal(reloaded.state.counters.events_received, 11);
    assert.equal(reloaded.state.updated_at, '2026-11-02T00:00:00.000Z');
  });

  it('quarantines invalid JSON instead of deleting it', () => {
    const dir = makeTempDir();
    const clock = createManualClock(BASE_MS);
    const path = join(dir, 'daemon-state.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    const file = createStateFile({ path, clock });
    const loaded = file.load();
    assert.equal(loaded.corrupt, true);
    assert.equal(loaded.state, null);
    assert.ok(loaded.restored_from !== null);
    assert.equal(existsSync(path), false, 'the original path must be freed for a fresh write');
    assert.equal(existsSync(loaded.restored_from), true, 'the corrupt file must be preserved');
    assert.match(readFileSync(loaded.restored_from, 'utf8'), /not json/u);
    assert.equal(file.counters().quarantines, 1);
  });

  it('quarantines an oversized checkpoint', () => {
    const dir = makeTempDir();
    const clock = createManualClock(BASE_MS);
    const path = join(dir, 'daemon-state.json');
    writeFileSync(path, 'x'.repeat(600 * 1024), 'utf8');
    const loaded = createStateFile({ path, clock }).load();
    assert.equal(loaded.corrupt, true);
    assert.equal(loaded.state, null);
  });

  it('quarantines a checkpoint with the wrong schema', () => {
    const dir = makeTempDir();
    const clock = createManualClock(BASE_MS);
    const path = join(dir, 'daemon-state.json');
    writeFileSync(path, JSON.stringify({ schema_version: 0, epoch: 'old' }), 'utf8');
    const loaded = createStateFile({ path, clock }).load();
    assert.equal(loaded.corrupt, true);
  });

  it('refuses to save after close', () => {
    const dir = makeTempDir();
    const file = createStateFile({ path: join(dir, 's.json'), clock: createManualClock(BASE_MS) });
    file.close();
    assert.throws(() => file.save(createEmptyState(TEST_EPOCH)), (error) => {
      assert.equal(error.code, DAEMON_CODES.STATE_WRITE_FAILED);
      return true;
    });
  });

  it('writes a private file mode on POSIX and a readable file on Windows', (t) => {
    const dir = makeTempDir();
    const path = join(dir, 'daemon-state.json');
    const file = createStateFile({ path, clock: createManualClock(BASE_MS) });
    file.save(createEmptyState(TEST_EPOCH));
    const stats = statSync(path);
    assert.ok(stats.size > 0);
    if (process.platform !== 'win32') {
      assert.equal(stats.mode & 0o777, 0o600);
    } else {
      t.diagnostic('Windows does not expose POSIX mode bits; size asserted only');
    }
  });

  it('counts writes for diagnostics', () => {
    const dir = makeTempDir();
    const file = createStateFile({ path: join(dir, 's.json'), clock: createManualClock(BASE_MS) });
    file.save(createEmptyState(TEST_EPOCH));
    file.save(createEmptyState(TEST_EPOCH));
    assert.deepEqual(file.counters(), { writes: 2, quarantines: 0 });
  });

  it('creates the data directory that holds the checkpoint', () => {
    const dir = makeTempDir();
    const nested = join(dir, 'a', 'b');
    mkdirSync(dir, { recursive: true });
    const file = createStateFile({ path: join(nested, 's.json'), clock: createManualClock(BASE_MS) });
    file.save(createEmptyState(TEST_EPOCH));
    assert.equal(existsSync(join(nested, 's.json')), true);
  });
});
