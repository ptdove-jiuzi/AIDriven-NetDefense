/**
 * perf-backoff.test.js — PERF-CPU N-034: the two scheduling savings must be provable.
 *
 * 1. **Failure backoff** (`scheduler.js` invariant 7). A source that keeps failing used to be
 *    retried at its normal cadence forever: `windows.network-table` failed every 10 s for the
 *    whole 330 s measured window (evidence/perf/prof-daemon/out/real-idle-tick5000.analysis.json)
 *    and every retry is a PowerShell cold start that produces nothing. The retry delay must be
 *    derived from **that source's own intervalMs**, double per consecutive failure, stop at the
 *    60 s ceiling, and reset on the first success. It must not lose data: the collector is
 *    cursor/probe based, so a deferred retry re-reads the same records.
 *
 * 2. **Quiet-period cadence** (`scheduler.js` invariant 8). `tickMs` stays the base cadence; the
 *    periodic pass widens the delay while nothing is being produced and snaps back to the base
 *    the moment a source produces events.
 *
 * 3. **Log volume**. A dead source must not emit a warning line per retry, and a poll the
 *    collector skipped for `READ_IN_PROGRESS` is not a warning at all.
 *
 * These are behavioural assertions on counters that `/status` exposes, so the claim "we do less
 * work" is checkable from the same numbers the daemon reports at runtime.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { createSystemClock } from '../../apps/daemon/src/clock.js';
import {
  createScheduler,
  IDLE_TICK_DEFAULTS,
  MAX_FAILURE_BACKOFF_MS,
} from '../../apps/daemon/src/scheduler.js';
import { createCollectorDaemonSource } from '../../apps/daemon/src/adapters/collector-sources.js';
import {
  BASE_MS,
  createManualClock,
  createScriptedSource,
  makeEvent,
  makePipelineParts,
  settle,
} from './helpers.js';

/** Build a scheduler over the real pipeline, with the backoff knobs under test injected. */
function makeScheduler({ sources, clock = createManualClock(BASE_MS), tickMs = 1000, ...extra }) {
  const parts = makePipelineParts({ clock });
  const scheduler = createScheduler({
    sources,
    pipeline: parts.pipeline,
    clock,
    tickMs,
    sourceTimeoutMs: extra.sourceTimeoutMs ?? 1000,
    maxBatchEvents: 100,
    staleAfterMs: 30000,
    maxSources: 32,
    ...extra,
  });
  return { ...parts, scheduler };
}

/** Wait for the current scheduling pass and its poll to settle. */
async function drain() {
  await settle();
  await new Promise((resolve) => setImmediate(resolve));
}

describe('failure backoff (invariant 7)', () => {
  it('waits longer after each consecutive failure, derived from the source intervalMs', async () => {
    const clock = createManualClock(BASE_MS);
    const { scheduler } = makeScheduler({
      clock,
      tickMs: 10,
      sources: [createScriptedSource({
        id: 'synthetic.flaky',
        intervalMs: 100,
        script: [{ error: 'boom' }, { error: 'boom' }, { error: 'boom' }],
      })],
    });

    assert.equal(scheduler.tick(), 1, 'first pass polls immediately');
    await drain();
    let status = scheduler.sourceStatus('synthetic.flaky');
    assert.equal(status.consecutive_failures, 1);
    assert.equal(status.backoff_ms, 100, 'first retry still happens at the source cadence (1x)');

    // Retry #2: due after 100 ms (1x interval), then the delay doubles to 200 ms.
    clock.advance(99);
    assert.equal(scheduler.tick(), 0, 'not yet due inside the backoff window');
    assert.ok(scheduler.sourceStatus('synthetic.flaky').backoff_skips >= 1);
    clock.advance(1);
    assert.equal(scheduler.tick(), 1);
    await drain();
    status = scheduler.sourceStatus('synthetic.flaky');
    assert.equal(status.consecutive_failures, 2);
    assert.equal(status.backoff_ms, 200, 'second failure doubles the delay (2x)');

    // Retry #3: 200 ms, then 400 ms.
    clock.advance(199);
    assert.equal(scheduler.tick(), 0);
    clock.advance(1);
    assert.equal(scheduler.tick(), 1);
    await drain();
    status = scheduler.sourceStatus('synthetic.flaky');
    assert.equal(status.consecutive_failures, 3);
    assert.equal(status.backoff_ms, 400, 'third failure doubles again (4x)');

    // `retry_in_ms` is what `/status` shows an operator; it must be positive while backing off.
    assert.equal(status.retry_in_ms, 400);
  });

  it('stops growing at the 60 s ceiling', async () => {
    const clock = createManualClock(BASE_MS);
    const { scheduler } = makeScheduler({
      clock,
      tickMs: 10,
      sources: [createScriptedSource({
        id: 'synthetic.dead',
        intervalMs: 30_000,
        script: Array.from({ length: 8 }, () => ({ error: 'TIMEOUT' })),
      })],
    });
    for (let index = 0; index < 8; index += 1) {
      clock.advance(MAX_FAILURE_BACKOFF_MS);
      scheduler.tick();
      await drain();
      scheduler.tick(); // immediately again: inside the (capped) backoff window
    }
    const status = scheduler.sourceStatus('synthetic.dead');
    assert.equal(status.consecutive_failures, 8);
    assert.equal(status.backoff_ms, MAX_FAILURE_BACKOFF_MS, 'capped at 60 s, never 30 s * 2^7');
    assert.ok(status.backoff_skips > 0);
    assert.equal(MAX_FAILURE_BACKOFF_MS, 60_000);
  });

  it('resets the streak and the delay on the next success, and the deferred records are not lost', async () => {
    const clock = createManualClock(BASE_MS);
    const record = makeEvent({ source_seq: 42 });
    const { scheduler, pipeline } = makeScheduler({
      clock,
      tickMs: 10,
      sources: [createScriptedSource({
        id: 'synthetic.recover',
        intervalMs: 100,
        script: [{ error: 'TIMEOUT' }, { error: 'TIMEOUT' }, [record]],
      })],
    });

    scheduler.tick();
    await drain();
    clock.advance(100);
    scheduler.tick();
    await drain();
    assert.equal(scheduler.sourceStatus('synthetic.recover').consecutive_failures, 2);
    assert.equal(scheduler.sourceStatus('synthetic.recover').backoff_ms, 200);

    // The third attempt succeeds: the delay must be gone immediately (not after the backoff).
    clock.advance(200);
    assert.equal(scheduler.tick(), 1);
    await drain();
    const status = scheduler.sourceStatus('synthetic.recover');
    assert.equal(status.consecutive_failures, 0);
    assert.equal(status.backoff_ms, 0, 'a success resets the backoff at once');
    assert.equal(status.retry_in_ms, 0);
    assert.equal(status.backoff_skips, 0);

    // No data was skipped: the record the source held during the failure streak is committed.
    assert.equal(status.events, 1);
    assert.equal(pipeline.stats().events_accepted, 1);
    assert.deepEqual(status.cursor, { index: 3 });

    // And the cadence is back to the source interval, not the doubled one.
    clock.advance(99);
    assert.equal(scheduler.tick(), 0);
    clock.advance(1);
    assert.equal(scheduler.tick(), 1);
  });

  it('backs off only the failing source; a healthy one keeps its cadence', async () => {
    const clock = createManualClock(BASE_MS);
    const { scheduler } = makeScheduler({
      clock,
      tickMs: 10,
      sources: [
        createScriptedSource({ id: 'synthetic.bad', intervalMs: 100, script: [{ error: 'boom' }, { error: 'boom' }] }),
        createScriptedSource({ id: 'synthetic.good', intervalMs: 100, script: [[], [], [], []] }),
      ],
    });
    scheduler.tick();
    await drain();
    assert.equal(scheduler.sourceStatus('synthetic.bad').backoff_ms, 100, '1x after the first failure');

    // Second failure: the failing source's delay becomes 200 ms while the healthy one stays at 100.
    clock.advance(100);
    assert.equal(scheduler.tick(), 2, 'both were due at the 1x delay');
    await drain();
    assert.equal(scheduler.sourceStatus('synthetic.bad').backoff_ms, 200);
    const goodPolls = scheduler.sourceStatus('synthetic.good').polls;

    clock.advance(100);
    assert.equal(scheduler.tick(), 1, 'only the healthy source is due now');
    await drain();
    assert.equal(scheduler.sourceStatus('synthetic.good').polls, goodPolls + 1);
    assert.equal(scheduler.sourceStatus('synthetic.bad').polls, 2, 'the failing source waited');
  });

  it('a failure streak logs one warning, not one per retry', async () => {
    const clock = createManualClock(BASE_MS);
    const entries = [];
    const logger = {
      debug: (message, fields) => entries.push({ level: 'debug', message, ...fields }),
      info: () => {},
      warn: (message, fields) => entries.push({ level: 'warn', message, ...fields }),
      error: () => {},
    };
    const { scheduler } = makeScheduler({
      clock,
      tickMs: 10,
      logger,
      sources: [createScriptedSource({
        id: 'synthetic.noisy',
        intervalMs: 100,
        script: [{ error: 'TIMEOUT' }, { error: 'TIMEOUT' }, { error: 'TIMEOUT' }],
      })],
    });
    // Fail, then retry at 1x (100 ms), then at 2x (200 ms) — the third attempt is the last one that
    // runs; every pass in between is a suppressed retry and must be counted as such.
    for (const step of [0, 100, 200]) {
      if (step > 0) {
        clock.advance(step);
      }
      scheduler.tick();
      await drain();
      scheduler.tick(); // immediately again: inside the fresh backoff window
      assert.ok(scheduler.sourceStatus('synthetic.noisy').backoff_skips > 0);
    }
    const degraded = entries.filter((entry) => entry.message === 'collector source degraded');
    const still = entries.filter((entry) => entry.message === 'collector source still degraded');
    assert.equal(degraded.length, 1, 'the first failure of the streak is the warning');
    assert.equal(still.length, 2, 'every later failure is debug');
    assert.equal(degraded[0].consecutive_failures, 1);
    assert.ok(still.every((entry) => entry.level === 'debug'));
    assert.ok(still[1].retry_in_ms >= 400, 'the debug line carries the retry delay');

    const summary = scheduler.summary();
    assert.ok(summary.backoff_skips > 0, 'suppressed retries are counted');
    assert.equal(summary.backoff_sources, 1);
  });

  it('a manual pollNow bypasses the backoff (the operator can always try now)', async () => {
    const clock = createManualClock(BASE_MS);
    const { scheduler } = makeScheduler({
      clock,
      tickMs: 10,
      sources: [createScriptedSource({
        id: 'synthetic.manual',
        intervalMs: 60000,
        script: [{ error: 'TIMEOUT' }, [makeEvent({ source_seq: 1 })]],
      })],
    });
    scheduler.tick();
    await drain();
    assert.equal(scheduler.sourceStatus('synthetic.manual').backoff_ms, 60_000);
    assert.equal(scheduler.tick(), 0, 'the timer path respects the backoff');
    const after = await scheduler.pollNow('synthetic.manual');
    assert.equal(after.events, 1);
    assert.equal(after.backoff_ms, 0);
    assert.equal(after.consecutive_failures, 0);
  });
});

describe('quiet-period cadence (invariant 8)', () => {
  it('widens the periodic delay while nothing is produced and reports it', async () => {
    // Real timers and a real clock: the periodic pass is a self-arming setTimeout, so the elapsed
    // time it measures must be wall time, not a frozen manual clock.
    const clock = createSystemClock();
    const { scheduler } = makeScheduler({
      clock,
      tickMs: 10,
      sources: [createScriptedSource({ id: 'synthetic.quiet', intervalMs: 1, script: [] })],
      idleTick: { quietAfterMs: 25, maxFactor: 4 },
    });
    scheduler.start();
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    const cadence = scheduler.cadence();
    const summary = scheduler.summary();
    await scheduler.stop({ timeoutMs: 500 });

    assert.equal(cadence.enabled, true);
    assert.equal(cadence.tick_ms, 10);
    assert.equal(cadence.max_factor, 4);
    assert.ok(cadence.idle_level >= 2, `expected the delay to widen, got level ${cadence.idle_level}`);
    assert.equal(cadence.delay_ms, 40, 'delay settles at tickMs * maxFactor');

    // The point of the exercise: far fewer wake-ups than one every 10 ms over 300 ms.
    const withoutBackoff = Math.floor(300 / 10);
    assert.ok(
      summary.ticks <= withoutBackoff * 0.6,
      `expected >=40% fewer passes than ${withoutBackoff}, got ${summary.ticks}`,
    );
    assert.ok(summary.ticks > 0);
  });

  it('snaps back to the base cadence as soon as a source produces events', async () => {
    // The source answers empty for the first passes, then publishes one event on every pass:
    // activity has to keep the cadence at the base tick.
    const script = [];
    for (let index = 0; index < 8; index += 1) {
      script.push([]);
    }
    for (let index = 0; index < 40; index += 1) {
      script.push([makeEvent({ source_seq: index + 1 })]);
    }
    const clock = createSystemClock();
    const { scheduler } = makeScheduler({
      clock,
      tickMs: 10,
      sources: [createScriptedSource({ id: 'synthetic.late', intervalMs: 1, script })],
      idleTick: { quietAfterMs: 20, maxFactor: 4 },
    });
    scheduler.start();
    // Wait for the *work*, not for a wall-clock duration: under a loaded suite run a fixed sleep
    // is not a tick count (Timers get coalesced), which made this test flaky at 517/518.
    const deadline = Date.now() + 5_000;
    while (scheduler.summary().ticks < 14 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    const cadence = scheduler.cadence();
    const summary = scheduler.summary();
    await scheduler.stop({ timeoutMs: 500 });

    assert.ok(summary.ticks > 12, `the scripted source kept being polled, got ${summary.ticks} passes`);
    assert.equal(cadence.idle_level, 0, 'activity dropped the delay back to the base tick');
    assert.equal(cadence.delay_ms, 10);
  });

  it('can be disabled: the delay then stays at tickMs', async () => {
    const clock = createSystemClock();
    const { scheduler } = makeScheduler({
      clock,
      tickMs: 10,
      sources: [createScriptedSource({ id: 'synthetic.off', intervalMs: 1, script: [] })],
      idleTick: { enabled: false, quietAfterMs: 10, maxFactor: 4 },
    });
    scheduler.start();
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    const cadence = scheduler.cadence();
    await scheduler.stop({ timeoutMs: 500 });
    assert.equal(cadence.enabled, false);
    assert.equal(cadence.idle_level, 0);
    assert.equal(cadence.delay_ms, 10);
    assert.equal(IDLE_TICK_DEFAULTS.maxFactor, 4);
  });
});

describe('collector-source log volume', () => {
  it('reports a READ_IN_PROGRESS skip as debug + a counter, not as a warning', async () => {
    const entries = [];
    const logger = {
      debug: (message, fields) => entries.push({ level: 'debug', message, ...fields }),
      info: () => {},
      warn: (message, fields) => entries.push({ level: 'warn', message, ...fields }),
      error: () => {},
    };
    const binding = { descriptor: { stableSourceId: 'windows.process-table', type: 'windows.process' } };
    let calls = 0;
    binding.poll = () => {
      calls += 1;
      return calls <= 2 ? { skipped: true, reason: 'read_in_progress' } : { ok: true, items: [] };
    };
    const source = createCollectorDaemonSource(binding, { logger });

    for (let index = 0; index < 3; index += 1) {
      const result = await source.poll({ cursor: null });
      if (index < 2) {
        assert.equal(result.empty.code, 'READ_IN_PROGRESS');
      }
    }
    assert.equal(entries.filter((entry) => entry.level === 'warn').length, 0, 'no warn lines for a busy read');
    assert.equal(entries.filter((entry) => entry.message === 'collector source skipped a poll').length, 2);
    assert.equal(source.stats().skippedPolls, 2, 'the skip is still visible, as a counter');
    assert.equal(source.stats().polls, 3);
  });

  it('keeps the first collector failure at warn and demotes the rest of the streak', async () => {
    const entries = [];
    const logger = {
      debug: (message, fields) => entries.push({ level: 'debug', message, ...fields }),
      info: () => {},
      warn: (message, fields) => entries.push({ level: 'warn', message, ...fields }),
      error: () => {},
    };
    const binding = {
      descriptor: { stableSourceId: 'windows.network-table', type: 'windows.connection' },
      poll: () => ({ ok: false, code: 'TIMEOUT' }),
    };
    const source = createCollectorDaemonSource(binding, { logger });
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(() => source.poll({ cursor: null }), (error) => error.code === DAEMON_CODES.SOURCE_FAILED);
    }
    assert.equal(entries.filter((entry) => entry.level === 'warn').length, 1);
    assert.equal(entries.filter((entry) => entry.message === 'collector source still unavailable').length, 2);
    assert.equal(source.stats().failures, 3);
  });
});
