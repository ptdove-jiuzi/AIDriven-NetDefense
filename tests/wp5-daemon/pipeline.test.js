/**
 * pipeline.test.js — collect → detect → persist orchestration.
 *
 * The recurring theme: the daemon must add *nothing* to what the store and the
 * detection engine already guarantee, and must not lose anything when one of them
 * fails. So the assertions are about counts and observable state, not about how
 * the code got there.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPipeline } from '../../apps/daemon/src/pipeline.js';
import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import {
  BASE_MS,
  createManualClock,
  makeEngine,
  makeEvent,
  makePipelineParts,
  makeRulePack,
  makeStore,
  TEST_EPOCH,
} from './helpers.js';

describe('pipeline ingest', () => {
  it('persists a matching event with its finding, alert and analysis request', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    const summary = parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 })], { source_id: 'synthetic.process' });

    assert.equal(summary.received, 1);
    assert.equal(summary.accepted, 1);
    assert.equal(summary.alerts, 1);
    assert.equal(summary.findings, 1);
    assert.equal(summary.analysis_requests, 1);
    assert.equal(summary.store_errors, 0);

    const dumped = store.dump();
    assert.equal(dumped.events.length, 1);
    assert.equal(dumped.findings.length, 1);
    assert.equal(dumped.alerts.length, 1);
    assert.equal(dumped.analyses.length, 1);
    assert.equal(dumped.alerts[0].severity, 'high');
    assert.equal(dumped.alerts[0].status, 'new');
    assert.equal(dumped.alerts[0].rule_id, 'proc.suspicious-start');
    assert.equal(dumped.analyses[0].epoch, TEST_EPOCH);
    assert.equal(dumped.analyses[0].state, 'queued');
  });

  it('stores a non-matching event without inventing an alert', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    const innocent = makeEvent({ source_seq: 1, payload: { process_name: 'notepad.exe', pid: 1 } });
    const summary = parts.pipeline.ingestBatch([innocent]);
    assert.equal(summary.accepted, 1);
    assert.equal(summary.alerts, 0);
    assert.equal(store.dump().events.length, 1);
    assert.equal(store.dump().alerts.length, 0);
  });

  it('treats a replayed event as a duplicate and does not re-alert', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    const event = makeEvent({ source_seq: 1 });
    parts.pipeline.ingestBatch([event]);
    const second = parts.pipeline.ingestBatch([event]);
    assert.equal(second.duplicate, 1);
    assert.equal(second.accepted, 0);
    assert.equal(second.alerts, 0);
    assert.equal(store.dump().alerts.length, 1, 'a replay must not create a second alert row');
    assert.equal(store.dump().events.length, 1);
  });

  it('accumulates an aggregate alert across two events of one batch', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    const batch = [
      makeEvent({ source_seq: 1 }),
      makeEvent({ source_seq: 2 }),
    ];
    const summary = parts.pipeline.ingestBatch(batch);
    assert.equal(summary.accepted, 2);
    assert.equal(summary.alerts, 1, 'one fingerprint aggregates into one alert');
    assert.equal(store.dump().alerts[0].count, 2);
  });

  it('does nothing for an empty batch', () => {
    const parts = makePipelineParts();
    const summary = parts.pipeline.ingestBatch([]);
    assert.equal(summary.received, 0);
    assert.equal(parts.pipeline.stats().batches, 1);
  });

  it('rejects a non-array batch', () => {
    const parts = makePipelineParts();
    assert.throws(() => parts.pipeline.ingestBatch('nope'), (error) => {
      assert.equal(error.code, DAEMON_CODES.BATCH_INVALID);
      return true;
    });
  });

  it('counts a store write failure and keeps processing the rest of the batch', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    store.setFailWrites(true);
    const summary = parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 }), makeEvent({ source_seq: 2 })]);
    assert.equal(summary.accepted, 0);
    assert.equal(summary.store_errors, 2);
    assert.equal(summary.dropped, 2);
    assert.equal(parts.pipeline.stats().store_errors, 2);
  });

  it('survives a store read failure without accepting unverified events', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    store.hasStableKeys = () => {
      throw Object.assign(new Error('read boom'), { code: 'ERR_READ' });
    };
    const summary = parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    assert.equal(summary.accepted, 0);
    assert.equal(summary.store_errors, 1);
    assert.equal(summary.dropped, 1);
    assert.equal(store.dump().events.length, 0);
  });

  it('survives a store read failure on the legacy event_id fallback', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    // 没有 hasStableKeys 的替身走逐事件 hasEvent：失败同样必须整批不写。
    store.hasStableKeys = undefined;
    const parts = makePipelineParts({ clock, store });
    store.hasEvent = () => {
      throw Object.assign(new Error('read boom'), { code: 'ERR_READ' });
    };
    const summary = parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    assert.equal(summary.accepted, 0);
    assert.equal(summary.store_errors, 1);
    assert.equal(store.dump().events.length, 0);
  });

  it('refuses to write when the store returns a malformed duplicate report', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    store.hasStableKeys = () => [false]; // 长度与批次不符：不能猜
    const summary = parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 }), makeEvent({ source_seq: 2 })]);
    assert.equal(summary.accepted, 0);
    assert.equal(summary.store_errors, 1);
    assert.equal(store.dump().events.length, 0);
  });
});

describe('pipeline detection faults', () => {
  it('persists the batch and rebuilds the engine when detection throws', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    let rebuilt = 0;
    const brokenEngine = {
      ingest() {
        throw Object.assign(new Error('rule exploded'), { code: 'RULE_FAULT' });
      },
      advanceTo() {
        return { alerts: [], detections: [], analysisRequests: [] };
      },
      stats: () => ({ fatal: null }),
    };
    const pipeline = createPipeline({
      store,
      detection: brokenEngine,
      createDetection: () => {
        rebuilt += 1;
        return makeEngine(clock);
      },
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count'],
      clock,
    });
    const summary = pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    assert.equal(summary.detection_ok, false);
    assert.equal(summary.accepted, 1, 'telemetry must still be persisted');
    assert.equal(summary.alerts, 0);
    assert.equal(rebuilt, 1);
    const stats = pipeline.stats();
    assert.equal(stats.detection_faults, 1);
    assert.equal(stats.detection_rebuilds, 1);
    assert.equal(store.dump().events.length, 1);
  });

  it('keeps serving batches after the rebuild', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    let calls = 0;
    const flakyEngine = {
      ingest() {
        calls += 1;
        if (calls === 1) {
          throw new Error('first batch fails');
        }
        return { alerts: [], detections: [], analysisRequests: [] };
      },
      stats: () => ({ fatal: null }),
    };
    const pipeline = createPipeline({
      store,
      detection: flakyEngine,
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      clock,
    });
    pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    const second = pipeline.ingestBatch([makeEvent({ source_seq: 2 })]);
    assert.equal(second.detection_ok, true);
    assert.equal(second.accepted, 1);
  });

  it('reports a failed rebuild without throwing', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const pipeline = createPipeline({
      store,
      detection: { ingest: () => { throw new Error('boom'); }, stats: () => ({ fatal: null }) },
      createDetection: () => { throw new Error('rebuild failed'); },
      epoch: TEST_EPOCH,
      clock,
    });
    const summary = pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    assert.equal(summary.detection_ok, false);
    assert.equal(summary.accepted, 1);
    assert.equal(pipeline.stats().detection_rebuilds, 0);
    assert.equal(pipeline.stats().detection_faults, 1);
  });
});

describe('pipeline advance', () => {
  it('closes an alert window without writing a second observation', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    assert.equal(store.dump().alerts[0].count, 1);

    // Jump past the aggregation window and advance detection without new events.
    clock.advance(20 * 60 * 1000);
    const advanced = parts.pipeline.advance();
    assert.equal(advanced.ok, true);
    // The closed window is already reflected in the stored total; re-writing the
    // view would double it, so nothing is written.
    assert.equal(advanced.alerts, 0);
    assert.equal(store.dump().alerts.length, 1);
    assert.equal(store.dump().alerts[0].count, 1);
  });

  it('adds only the new contribution when a second batch lands in the same window', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    clock.advance(1000);
    parts.pipeline.ingestBatch([makeEvent({ source_seq: 2 })]);

    const alerts = store.dump().alerts;
    assert.equal(alerts.length, 1, 'one fingerprint keeps one alert row');
    // Cumulative engine count is 2, and the stored total must also be 2. Handing the
    // cumulative view to an additive upsert twice would have produced 1 + 2 = 3.
    assert.equal(alerts[0].count, 2);
    assert.equal(alerts[0].event_ids.length, 2);
  });

  it('reports the closed window count when advancing', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const parts = makePipelineParts({ clock, store });
    parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    clock.advance(20 * 60 * 1000);
    const advanced = parts.pipeline.advance();
    assert.equal(advanced.closed_alerts, 1);
    assert.equal(advanced.alerts, 0);
  });
});

describe('pipeline construction', () => {
  it('requires an epoch, a store and an engine', () => {
    const store = makeStore(createManualClock(BASE_MS));
    assert.throws(() => createPipeline({ store, detection: {}, epoch: '' }), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
      return true;
    });
    assert.throws(() => createPipeline({ store: {}, detection: {}, epoch: 'e' }), (error) => {
      assert.equal(error.code, DAEMON_CODES.STORE_REQUIRED);
      return true;
    });
    assert.throws(() => createPipeline({ store, detection: {}, epoch: 'e' }), (error) => {
      assert.equal(error.code, DAEMON_CODES.DETECTION_UNAVAILABLE);
      return true;
    });
  });

  it('reports detection statistics through stats()', () => {
    const parts = makePipelineParts();
    parts.pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    const stats = parts.pipeline.stats();
    assert.equal(stats.events_received, 1);
    assert.equal(stats.events_accepted, 1);
    assert.equal(stats.alerts_written, 1);
    assert.equal(stats.detection.fatal, null);
  });

  it('runs with a rule pack that matches nothing', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      epoch: 'e',
      clock,
      allowedSummaryFields: ['alert_count'],
    });
    const summary = pipeline.ingestBatch([makeEvent({ payload: { process_name: 'calc.exe', pid: 9 } })]);
    assert.equal(summary.accepted, 1);
    assert.equal(summary.alerts, 0);
  });
});
