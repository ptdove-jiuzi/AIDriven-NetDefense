/**
 * restart-recovery.test.js — the property M5 is judged on.
 *
 * "Harness absent" is easy to demonstrate statically; "still correct after a
 * restart" is not. A second process must resume from the same epoch, must not
 * duplicate the telemetry or the alert a replay hands it again, and must keep the
 * cumulative counters moving forward instead of resetting to zero.
 *
 * These cases use the real SQLite event store in a temporary directory: an
 * in-memory double would prove nothing about durability, and the whole point is
 * that the data survives the process.
 *
 * The source polls once on start, so the assertions wait for the observable state
 * (`waitFor`) rather than assuming a particular number of event-loop turns.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDaemon } from '../../apps/daemon/src/daemon.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { BASE_MS, makeConfig, makeEvent, makeTempDir, waitFor } from './helpers.js';

const EPOCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * A source that always replays the same events, as a real adapter would after a
 * crash between read and commit.
 */
function replayingSource(events, observedCursors = []) {
  return {
    id: 'synthetic.replay',
    kind: 'process',
    poll(ctx) {
      observedCursors.push(ctx.cursor);
      return { events, cursor: { offset: events.length } };
    },
  };
}

async function boot(dir, source) {
  const daemon = createDaemon({
    config: makeConfig(dir, { top: { mode: 'full' } }),
    sources: [source],
    clock: createManualClock(BASE_MS),
  });
  await daemon.start();
  return daemon;
}

function statsOf(daemon) {
  try {
    return daemon.status().store.stats();
  } catch {
    return { events: 0, alerts: 0, findings: 0, analyses: 0 };
  }
}

describe('restart recovery', () => {
  it('keeps one epoch, does not duplicate telemetry and does not double the alert', async () => {
    const dir = makeTempDir();
    const events = [makeEvent({ source_seq: 1 }), makeEvent({ source_seq: 2 })];

    const first = await boot(dir, replayingSource(events));
    await waitFor(() => statsOf(first).events === 2, { label: 'first run ingested both events' });
    const firstEpoch = first.epoch();
    assert.equal(statsOf(first).alerts, 1);
    assert.equal(statsOf(first).analyses, 1);
    await first.stop('restart');

    const second = await boot(dir, replayingSource(events));
    assert.equal(second.epoch(), firstEpoch, 'the recovery epoch must survive the restart');
    await waitFor(() => second.status().pipeline.stats().events_duplicate === 2, {
      label: 'replayed events are recognised as duplicates',
    });
    const secondStats = statsOf(second);
    assert.equal(secondStats.events, 2, 'a replayed event must not be stored twice');
    assert.equal(secondStats.alerts, 1, 'a replayed event must not create a second alert');
    assert.equal(secondStats.analyses, 1, 'a replayed event must not enqueue a second analysis');
    const pipeline = second.status().pipeline.stats();
    assert.equal(pipeline.events_accepted, 0);
    assert.equal(pipeline.store_errors, 0);
    await second.stop('done');
  });

  it('carries cumulative counters across the restart', async () => {
    const dir = makeTempDir();
    const events = [makeEvent({ source_seq: 1 })];
    const first = await boot(dir, replayingSource(events));
    await waitFor(() => first.status().counters.events_received >= 1, { label: 'first run counted an event' });
    const before = first.status().counters;
    assert.equal(before.events_accepted, 1);
    await first.stop('restart');

    const checkpoint = JSON.parse(readFileSync(join(dir, 'daemon-state.json'), 'utf8'));
    assert.ok(checkpoint.counters.events_received >= 1);
    assert.match(checkpoint.epoch, EPOCH_UUID);

    const second = await boot(dir, replayingSource(events));
    await waitFor(() => second.status().pipeline.stats().events_duplicate >= 1, { label: 'replay observed' });
    const after = second.status().counters;
    assert.ok(after.events_received > before.events_received, 'the cumulative total must keep growing');
    assert.ok(after.events_accepted >= 1);
    await second.stop('done');
  });

  it('resumes from the persisted cursor instead of the beginning', async () => {
    const dir = makeTempDir();
    const events = [makeEvent({ source_seq: 1 })];
    const cursorsFirst = [];
    const first = await boot(dir, replayingSource(events, cursorsFirst));
    try {
      // Wait for the *ingest* to finish, not merely for the poll to be called. Stopping
      // while the poll is still in flight legitimately drops the cursor (scheduler: a
      // poll that settles after `stop()` must not advance it), which made this a test
      // race rather than a recovery defect — and the failure path below leaked the
      // second daemon's listener, so `node --test` never exited.
      await waitFor(() => statsOf(first).events === 1, { label: 'first run ingested the event' });
      assert.equal(cursorsFirst[0], null, 'the first run starts with no cursor');
    } finally {
      await first.stop('restart');
    }

    const cursorsSecond = [];
    const second = await boot(dir, replayingSource(events, cursorsSecond));
    try {
      await waitFor(() => cursorsSecond.length >= 1, { label: 'second run polled' });
      assert.deepEqual(cursorsSecond[0], { offset: 1 }, 'the second run must receive the persisted cursor');
    } finally {
      await second.stop('done');
    }
  });

  it('recovers from a corrupt checkpoint and keeps the stored telemetry', async () => {
    const dir = makeTempDir();
    const events = [makeEvent({ source_seq: 1 })];
    const first = await boot(dir, replayingSource(events));
    await waitFor(() => statsOf(first).events === 1, { label: 'first run ingested an event' });
    const epoch = first.epoch();
    await first.stop('restart');

    writeFileSync(join(dir, 'daemon-state.json'), 'not json at all', 'utf8');
    const second = await boot(dir, replayingSource(events));
    assert.equal(second.state(), 'running');
    assert.equal(second.diagnostics().checkpoint.corrupt_on_load, true);
    assert.notEqual(second.epoch(), epoch, 'a lost checkpoint means a new epoch');
    assert.match(second.epoch(), EPOCH_UUID);
    // Telemetry lives in the database, not the checkpoint, so it is still there.
    assert.equal(statsOf(second).events, 1);
    assert.equal(existsSync(join(dir, 'daemon-state.json')), true);
    await second.stop('done');
  });

  it('creates the database for a fresh data directory', async () => {
    const dir = makeTempDir();
    const empty = await boot(dir, replayingSource([]));
    assert.equal(statsOf(empty).events, 0);
    await empty.stop('done');
    assert.equal(existsSync(join(dir, 'store')), true);
  });
});
