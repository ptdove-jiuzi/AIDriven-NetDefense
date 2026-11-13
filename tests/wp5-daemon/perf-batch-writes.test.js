/**
 * perf-batch-writes.test.js — PERF-CPU N-034: the batched write path.
 *
 * The daemon used to call the store once per event. With `synchronous=FULL` that is one `fsync`
 * per event: 2009 transactions in the 330 s measured window, and the first 385-event snapshot held
 * the event loop for ~45 s. The fix is not "batch everything" — the per-event loop has an ordering
 * refinement ("a failed write removes that event's observation from every *later* alert of the same
 * batch") that only a sequential write can honour. So the assertion here is a *boundary*:
 *
 * - a run of events that write no alert/request/retained contribution is written in ONE store call,
 * - an event that produces an alert is still written one at a time,
 * - a store without `ingestBatch()` keeps working (per-event fallback),
 * - a partially rejected run stops batching instead of silently degrading.
 *
 * The transaction count itself is observable in production through
 * `pipeline.stats().store_calls` / `store_batch_calls`, which is what the A/B run measures.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPipeline } from '../../apps/daemon/src/pipeline.js';
import { BASE_MS, createManualClock, makeEngine, makeEvent, makeStore, TEST_EPOCH } from './helpers.js';

/** A store double that counts both write entry points and can fail selected events. */
function makeCountingStore(clock, { batch = true, failAt = [] } = {}) {
  const base = makeStore(clock);
  const calls = { ingest: 0, batches: [], batchSizes: [], written: [] };
  const store = {
    ...base,
    ingest(request) {
      calls.ingest += 1;
      calls.written.push(request.event.event_id);
      return base.ingest(request);
    },
  };
  if (batch) {
    store.ingestBatch = (requests) => {
      calls.batches.push(requests.length);
      const results = [];
      let accepted = 0;
      let duplicates = 0;
      let failed = 0;
      for (let index = 0; index < requests.length; index += 1) {
        if (failAt.includes(index)) {
          failed += 1;
          results.push({ ok: false, error: new Error('injected batch failure') });
          continue;
        }
        try {
          const value = base.ingest(requests[index]);
          if (value.duplicate === true) duplicates += 1;
          else accepted += 1;
          results.push({ ok: true, value });
        } catch (error) {
          failed += 1;
          results.push({ ok: false, error });
        }
      }
      return { received: requests.length, accepted, duplicates, failed, results };
    };
  }
  return { store, calls };
}

function makePipeline(store, clock, extra = {}) {
  return createPipeline({
    store,
    detection: makeEngine(clock),
    epoch: TEST_EPOCH,
    allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
    budgetClass: 'standard',
    alertStatus: 'new',
    clock,
    ...extra,
  });
}

/** An event that matches no rule: no finding, no alert, no request. */
function quietEvent(seq) {
  return makeEvent({ source_seq: seq, payload: { process_name: 'notepad.exe', pid: 1000 + seq } });
}

describe('PERF-CPU N-034 batched event-store writes', () => {
  it('writes a run of findings-only events in ONE store call', () => {
    const clock = createManualClock(BASE_MS);
    const { store, calls } = makeCountingStore(clock);
    const pipeline = makePipeline(store, clock, { batchWrites: true });
    const events = [1, 2, 3, 4, 5].map(quietEvent);

    const summary = pipeline.ingestBatch(events, { source_id: 'synthetic.process' });

    assert.equal(summary.accepted, 5);
    assert.equal(summary.store_errors, 0);
    assert.equal(calls.batches.length, 1, 'one T1 transaction for the whole run');
    assert.equal(calls.batches[0], 5);
    assert.equal(calls.ingest, 0, 'no per-event write inside a batch-safe run');
    assert.equal(store.dump().events.length, 5, 'every event still landed');
    const stats = pipeline.stats();
    assert.equal(stats.store_batch_calls, 1);
    assert.equal(stats.store_calls, 1);
    assert.equal(stats.events_accepted, 5);
  });

  it('never batches an event that produces an alert (ordering refinement stays sequential)', () => {
    const clock = createManualClock(BASE_MS);
    const { store, calls } = makeCountingStore(clock);
    const pipeline = makePipeline(store, clock, { batchWrites: true });

    const summary = pipeline.ingestBatch([1, 2, 3].map((seq) => makeEvent({ source_seq: seq })));

    assert.ok(summary.alerts >= 1);
    const batched = calls.batches.reduce((total, size) => total + size, 0);
    assert.ok(calls.ingest >= 1, 'the event that produces the alert is written on its own');
    assert.equal(batched + calls.ingest, 3, 'every event went through exactly one write path');
  });

  it('falls back to one write per event when the store has no batch entry point', () => {
    const clock = createManualClock(BASE_MS);
    const { store, calls } = makeCountingStore(clock, { batch: false });
    const pipeline = makePipeline(store, clock, { batchWrites: true });

    const summary = pipeline.ingestBatch([1, 2, 3].map(quietEvent));

    assert.equal(summary.accepted, 3);
    assert.equal(calls.ingest, 3);
    assert.equal(store.dump().events.length, 3);
    assert.equal(pipeline.stats().store_batch_calls, 0);
  });

  it('stops batching after a partially rejected run and reports it', () => {
    const clock = createManualClock(BASE_MS);
    const { store, calls } = makeCountingStore(clock, { failAt: [1] });
    const pipeline = makePipeline(store, clock, { batchWrites: true });

    const first = pipeline.ingestBatch([1, 2, 3].map(quietEvent), { source_id: 'synthetic.process' });
    assert.equal(first.store_errors, 1, 'the injected per-item failure is a store error, not silence');
    assert.equal(pipeline.stats().batch_partial_failures, 1);

    // The valve is closed: the next batch goes one-by-one, so a failure cannot skip an ordering step.
    const second = pipeline.ingestBatch([4, 5].map(quietEvent), { source_id: 'synthetic.process' });
    assert.equal(second.accepted, 2);
    assert.equal(calls.batches.length, 1, 'only the first run was batched');
    assert.equal(calls.ingest, 2, 'the second run used the per-event path');
  });
});
