/**
 * scheduler.test.js — cadence, isolation and back-pressure.
 *
 * Each case maps to a failure mode the design calls out explicitly:
 *
 * - one slow source must not stall another (AT-COL-001/003);
 * - a hung adapter must be abandoned, not awaited (AT-SVC-001);
 * - a failing source must degrade only itself (design §12);
 * - a batch must be bounded, and what was dropped must be counted, not silent
 *   (AT-COL-003);
 * - a cursor must not advance past data that was not persisted (AT-COL-004).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { createScheduler } from '../../apps/daemon/src/scheduler.js';
import { assertSources, createScriptedSource } from '../../apps/daemon/src/adapters/collector.js';
import {
  BASE_MS,
  createManualClock,
  makeEvent,
  makeSchedulerParts,
  makeStore,
  makePipelineParts,
  settle,
} from './helpers.js';

describe('assertSources', () => {
  it('rejects duplicate ids, unknown kinds and a missing poll', () => {
    assert.throws(
      () => assertSources([
        createScriptedSource({ id: 'a', script: [] }),
        createScriptedSource({ id: 'a', script: [] }),
      ], 8),
      (error) => {
        assert.equal(error.code, DAEMON_CODES.SOURCE_INVALID);
        assert.match(error.message, /unique/u);
        return true;
      },
    );
    assert.throws(() => assertSources([{ id: 'a', kind: 'magic', poll: () => ({}) }], 8), /kind must be one of/u);
    assert.throws(() => assertSources([{ id: 'a', kind: 'process' }], 8), /poll/u);
    assert.throws(() => assertSources([{ id: 'bad id!', kind: 'process', poll: () => ({}) }], 8), /id must match/u);
  });

  it('bounds the number of sources', () => {
    const sources = Array.from({ length: 3 }, (_unused, index) => createScriptedSource({ id: `s${index}`, script: [] }));
    assert.throws(() => assertSources(sources, 2), /at most 2/u);
  });
});

describe('scheduler polling', () => {
  it('polls a due source once and does not overlap the next tick', async () => {
    const parts = makeSchedulerParts({
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[makeEvent({ source_seq: 1 })]] })],
      tickMs: 1000,
    });
    assert.equal(parts.scheduler.tick(), 1);
    // The poll is in flight; a second pass must not start another one.
    assert.equal(parts.scheduler.tick(), 0);
    await new Promise((resolve) => setImmediate(resolve));
    const status = parts.scheduler.sourceStatus('synthetic.process');
    assert.equal(status.polls, 1);
    assert.equal(status.lifecycle, 'ok');
    assert.equal(status.events, 1);
    assert.equal(status.accepted, 1);
    assert.equal(parts.pipeline.stats().events_accepted, 1);
  });

  it('waits for the per-source interval before polling again', async () => {
    const clock = createManualClock(BASE_MS);
    const parts = makeSchedulerParts({
      clock,
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[], []] })],
      tickMs: 1000,
    });
    parts.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parts.scheduler.tick(), 0, 'not due yet');
    clock.advance(1000);
    assert.equal(parts.scheduler.tick(), 1, 'due after one interval');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parts.scheduler.sourceStatus('synthetic.process').polls, 2);
  });

  it('polls two sources independently in one pass', async () => {
    const parts = makeSchedulerParts({
      sources: [
        createScriptedSource({ id: 'synthetic.one', script: [[makeEvent({ source_seq: 1 })]] }),
        createScriptedSource({ id: 'synthetic.two', script: [[makeEvent({ source_seq: 2, stable_source_id: 'synthetic.two' })]] }),
      ],
      tickMs: 1000,
    });
    assert.equal(parts.scheduler.tick(), 2);
    await settle();
    await parts.scheduler.stop({ timeoutMs: 1000 });
    assert.equal(parts.scheduler.sourceStatus('synthetic.one').accepted, 1);
    assert.equal(parts.scheduler.sourceStatus('synthetic.two').accepted, 1);
  });

  it('degrades only the failing source', async () => {
    const parts = makeSchedulerParts({
      sources: [
        createScriptedSource({ id: 'synthetic.bad', script: [{ error: 'adapter exploded' }] }),
        createScriptedSource({ id: 'synthetic.good', script: [[makeEvent({ source_seq: 1 })]] }),
      ],
      tickMs: 1000,
    });
    parts.scheduler.tick();
    await settle();
    await parts.scheduler.stop({ timeoutMs: 1000 });
    const bad = parts.scheduler.sourceStatus('synthetic.bad');
    const good = parts.scheduler.sourceStatus('synthetic.good');
    assert.equal(bad.lifecycle, 'degraded');
    assert.equal(bad.failures, 1);
    assert.equal(bad.last_error_code, DAEMON_CODES.SOURCE_FAILED);
    assert.equal(good.lifecycle, 'ok');
    assert.equal(good.accepted, 1);
  });

  it('abandons a hung adapter after the source timeout and keeps the others running', async () => {
    const parts = makeSchedulerParts({
      sources: [
        createScriptedSource({ id: 'synthetic.hung', script: [{ hang: true }] }),
        createScriptedSource({ id: 'synthetic.good', script: [[makeEvent({ source_seq: 1 })]] }),
      ],
      tickMs: 1000,
      sourceTimeoutMs: 40,
    });
    parts.scheduler.tick();
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    const hung = parts.scheduler.sourceStatus('synthetic.hung');
    assert.equal(hung.lifecycle, 'degraded');
    assert.equal(hung.last_error_code, DAEMON_CODES.SOURCE_TIMEOUT);
    assert.equal(hung.polling, false);
    assert.equal(parts.scheduler.sourceStatus('synthetic.good').accepted, 1);
    await parts.scheduler.stop({ timeoutMs: 500 });
  });

  it('treats a malformed poll result as a degraded source', async () => {
    const parts = makeSchedulerParts({
      sources: [{ id: 'synthetic.shape', kind: 'synthetic', poll: () => ({ events: 'nope' }) }],
      tickMs: 1000,
    });
    parts.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const status = parts.scheduler.sourceStatus('synthetic.shape');
    assert.equal(status.lifecycle, 'degraded');
    assert.equal(status.last_error_code, DAEMON_CODES.BATCH_INVALID);
  });

  it('does not let a poll that settles after stop write anything', async () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    const scheduler = createScheduler({
      sources: [{
        id: 'synthetic.late',
        kind: 'synthetic',
        poll: async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 30);
          });
          return { events: [makeEvent({ source_seq: 1 })], cursor: { late: true } };
        },
      }],
      pipeline: parts.pipeline,
      clock,
      tickMs: 1000,
      sourceTimeoutMs: 1000,
      maxBatchEvents: 100,
      staleAfterMs: 30000,
      maxSources: 8,
    });
    scheduler.tick();
    const stopped = await scheduler.stop({ timeoutMs: 500 });
    assert.equal(stopped.aborted, 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    assert.equal(store.stats().events, 0, 'a post-shutdown poll must not reach the store');
    assert.equal(parts.pipeline.stats().events_accepted, 0);
  });
});

describe('scheduler back-pressure', () => {
  it('truncates an oversized batch and counts the dropped events', async () => {
    const events = Array.from({ length: 5 }, (_unused, index) => makeEvent({ source_seq: index + 1 }));
    const parts = makeSchedulerParts({
      sources: [createScriptedSource({ id: 'synthetic.bulk', script: [events] })],
      tickMs: 1000,
      maxBatchEvents: 2,
    });
    parts.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const status = parts.scheduler.sourceStatus('synthetic.bulk');
    assert.equal(status.events, 2);
    assert.equal(status.dropped_events, 3);
    assert.equal(parts.pipeline.stats().events_received, 2);
  });

  it('does not advance the cursor when the store fails, so the batch replays', async () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    store.setFailWrites(true);
    const parts = makeSchedulerParts({
      clock,
      store,
      sources: [createScriptedSource({
        id: 'synthetic.process',
        script: [[{ ...makeEvent({ source_seq: 1 }) }]],
      })],
      tickMs: 1000,
    });
    const seenCursors = [];
    // Rebuild with an onCursor spy by using a second scheduler over the same parts.
    const scheduler = createScheduler({
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[makeEvent({ source_seq: 1 })]] })],
      pipeline: parts.pipeline,
      clock,
      tickMs: 1000,
      sourceTimeoutMs: 1000,
      maxBatchEvents: 100,
      staleAfterMs: 30000,
      maxSources: 8,
      onCursor: (id, record) => seenCursors.push({ id, record }),
    });
    scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const status = scheduler.sourceStatus('synthetic.process');
    assert.equal(status.lifecycle, 'degraded');
    assert.equal(status.last_error_code, DAEMON_CODES.STORE_WRITE_FAILED);
    assert.equal(status.cursor, null);
    assert.deepEqual(seenCursors, []);
    assert.equal(parts.pipeline.stats().store_errors, 1);
  });

  it('advances the cursor and reports it after a committed batch', async () => {
    const reported = [];
    const parts = makeSchedulerParts({
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[makeEvent({ source_seq: 1 })]] })],
      tickMs: 1000,
      onCursor: (id, record) => reported.push({ id, record }),
    });
    parts.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reported.length, 1);
    assert.equal(reported[0].id, 'synthetic.process');
    assert.deepEqual(reported[0].record.cursor, { index: 1 });
    assert.equal(parts.scheduler.cursors()['synthetic.process'].events, 1);
  });
});

describe('scheduler status', () => {
  it('marks a silent source stale on the monotonic clock, not the wall clock', () => {
    const clock = createManualClock(BASE_MS);
    const parts = makeSchedulerParts({
      clock,
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[]] })],
      tickMs: 1000,
      staleAfterMs: 5000,
    });
    assert.equal(parts.scheduler.sourceStatus('synthetic.process').stale, false);
    // A wall clock step alone must not make a dead source look fresh or stale.
    clock.advanceWall(10 * 60 * 1000);
    assert.equal(parts.scheduler.sourceStatus('synthetic.process').stale, false);
    clock.advanceMono(6000);
    assert.equal(parts.scheduler.sourceStatus('synthetic.process').stale, true);
  });

  it('summarizes sources for the status payload', () => {
    const parts = makeSchedulerParts({
      sources: [
        createScriptedSource({ id: 'synthetic.one', script: [[]] }),
        createScriptedSource({ id: 'synthetic.two', script: [[]] }),
      ],
      tickMs: 1000,
    });
    const summary = parts.scheduler.summary();
    assert.equal(summary.sources, 2);
    assert.equal(summary.polling, 0);
    assert.equal(summary.stale, 0);
    assert.deepEqual(parts.scheduler.sourceIds(), ['synthetic.one', 'synthetic.two']);
  });

  it('throws SOURCE_UNKNOWN for an unknown source', async () => {
    const parts = makeSchedulerParts({ sources: [], tickMs: 1000 });
    await assert.rejects(() => parts.scheduler.pollNow('nope'), (error) => {
      assert.equal(error.code, DAEMON_CODES.SOURCE_UNKNOWN);
      return true;
    });
  });

  it('refuses a second concurrent poll of the same source', async () => {
    const parts = makeSchedulerParts({
      sources: [createScriptedSource({ id: 'synthetic.hung', script: [{ hang: true }] })],
      tickMs: 1000,
      sourceTimeoutMs: 200,
    });
    const first = parts.scheduler.pollNow('synthetic.hung');
    await assert.rejects(() => parts.scheduler.pollNow('synthetic.hung'), (error) => {
      assert.equal(error.code, DAEMON_CODES.SOURCE_BUSY);
      return true;
    });
    await first;
    await parts.scheduler.stop({ timeoutMs: 500 });
  });
});
