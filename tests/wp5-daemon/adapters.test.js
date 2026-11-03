/**
 * adapters.test.js — the two injected fakes.
 *
 * The memory store is a **test double for T1**, so its semantics are asserted
 * explicitly: if the double and the real store disagree about idempotency or about
 * how an alert accumulates, every pipeline test above it becomes meaningless.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { createMemoryEventStoreAdapter } from '../../apps/daemon/src/adapters/event-store.js';
import { createScriptedSource } from '../../apps/daemon/src/adapters/collector.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { stableKeyOf as packageStableKeyOf } from '../../packages/event-store/src/index.js';
import { BASE_MS, makeEvent, TEST_EPOCH } from './helpers.js';

function makeAlert(overrides = {}) {
  return {
    alert_id: '11111111-1111-4111-8111-111111111111',
    rule_id: 'proc.suspicious-start',
    rule_version: '1.0.0',
    fingerprint: 'f'.repeat(64),
    severity: 'high',
    status: 'new',
    first_seen: '2026-11-02T00:00:00.000Z',
    last_seen: '2026-11-02T00:00:00.000Z',
    window_start: '2026-11-02T00:00:00.000Z',
    window_end: '2026-11-02T00:15:00.000Z',
    count: 1,
    event_ids: ['22222222-2222-4222-8222-222222222222'],
    event_ids_truncated: false,
    evidence_refs: [],
    ...overrides,
  };
}

function makeRequest(overrides = {}) {
  return {
    analysis_id: '33333333-3333-4333-8333-333333333331',
    alert_id: '11111111-1111-4111-8111-111111111111',
    idempotency_key: 'a'.repeat(43),
    epoch: TEST_EPOCH,
    ...overrides,
  };
}

describe('memory event store', () => {
  it('starts empty and reports an open handle', () => {
    const store = createMemoryEventStoreAdapter({ clock: createManualClock(BASE_MS) });
    store.open();
    assert.equal(store.kind, 'memory');
    assert.equal(store.isOpen(), true);
    assert.deepEqual(store.stats(), { events: 0, alerts: 0, findings: 0, analyses: 0 });
    assert.equal(store.hasEvent('nothing'), false);
  });

  it('stores an event and finds it by id', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    const event = makeEvent({ source_seq: 1 });
    store.ingest({ event });
    assert.equal(store.hasEvent(event.event_id), true);
    assert.equal(store.stats().events, 1);
    assert.equal(store.dump().events[0].event_id, event.event_id);
  });

  it('is idempotent by event id and by stable source key', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    const event = makeEvent({ source_seq: 7 });
    store.ingest({ event });
    const repeat = store.ingest({ event });
    assert.equal(repeat.duplicate, true);
    assert.equal(store.stats().events, 1);

    // Same stable key, different event id: still a duplicate, like the real store.
    const sameKey = { ...event, event_id: '44444444-4444-4444-8444-444444444444' };
    const byKey = store.ingest({ event: sameKey });
    assert.equal(byKey.duplicate, true);
    assert.equal(store.stats().events, 1);
  });

  it('accumulates alert count and unions event ids on repeated writes', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    const eventA = makeEvent({ source_seq: 1 });
    const eventB = makeEvent({ source_seq: 2 });
    store.ingest({ event: eventA, alerts: [makeAlert()] });
    const merged = store.ingest({
      event: eventB,
      alerts: [makeAlert({ event_ids: [eventB.event_id], last_seen: '2026-11-02T00:00:05.000Z' })],
    });
    assert.equal(merged.alerts[0].created, false);
    assert.equal(merged.alerts[0].count, 2);
    const alert = store.dump().alerts[0];
    assert.equal(alert.count, 2);
    assert.equal(alert.event_ids.length, 2);
    assert.equal(alert.last_seen, '2026-11-02T00:00:05.000Z');
  });

  it('raises alert severity but never lowers it', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    store.ingest({ event: makeEvent({ source_seq: 1 }), alerts: [makeAlert({ severity: 'critical' })] });
    store.ingest({ event: makeEvent({ source_seq: 2 }), alerts: [makeAlert({ severity: 'low' })] });
    assert.equal(store.dump().alerts[0].severity, 'critical');
  });

  it('refuses an analysis request that references an unknown alert', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    assert.throws(
      () => store.ingest({ event: makeEvent({ source_seq: 1 }), analysisRequest: makeRequest() }),
      (error) => {
        assert.equal(error.code, DAEMON_CODES.STORE_WRITE_FAILED);
        return true;
      },
    );
    assert.equal(store.stats().events, 0, 'a rejected write must not have stored the event');
  });

  it('enqueues an analysis request once per idempotency key', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    const event = makeEvent({ source_seq: 1 });
    const first = store.ingest({ event, alerts: [makeAlert()], analysisRequest: makeRequest() });
    assert.equal(first.analysis_id, makeRequest().analysis_id);
    const second = store.ingest({
      event: makeEvent({ source_seq: 2 }),
      alerts: [makeAlert()],
      analysisRequest: makeRequest({ analysis_id: '33333333-3333-4333-8333-333333333332' }),
    });
    assert.equal(second.analysis_id, makeRequest().analysis_id, 'the existing row wins');
    assert.equal(store.stats().analyses, 1);
    assert.equal(store.dump().analyses[0].state, 'queued');
  });

  it('can be made to fail writes, then recovers', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    store.setFailWrites(true);
    assert.throws(() => store.ingest({ event: makeEvent({ source_seq: 1 }) }), (error) => {
      assert.equal(error.code, DAEMON_CODES.STORE_WRITE_FAILED);
      return true;
    });
    store.setFailWrites(false);
    store.ingest({ event: makeEvent({ source_seq: 1 }) });
    assert.equal(store.stats().events, 1);
  });

  it('refuses ingest without an event, and after close', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    assert.throws(() => store.ingest({}), (error) => {
      assert.equal(error.code, DAEMON_CODES.STORE_WRITE_FAILED);
      return true;
    });
    store.close();
    assert.equal(store.isOpen(), false);
    assert.throws(() => store.ingest({ event: makeEvent({ source_seq: 1 }) }), (error) => {
      assert.equal(error.code, DAEMON_CODES.STORE_UNAVAILABLE);
      return true;
    });
  });

  it('hands out copies so a caller cannot mutate stored rows', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    const event = makeEvent({ source_seq: 1 });
    store.ingest({ event });
    const dumped = store.dump();
    dumped.events[0].payload.process_name = 'tampered';
    assert.equal(store.dump().events[0].payload.process_name, 'evil.exe');
  });
});

describe('scripted source', () => {
  it('walks the script and then idles', async () => {
    const source = createScriptedSource({
      id: 'synthetic.script',
      script: [[makeEvent({ source_seq: 1 })], []],
    });
    assert.equal(source.remaining(), 2);
    const ctx = { signal: new AbortController().signal };
    const first = await source.poll(ctx);
    assert.equal(first.events.length, 1);
    assert.deepEqual(first.cursor, { index: 1 });
    const second = await source.poll(ctx);
    assert.deepEqual(second.events, []);
    const third = await source.poll(ctx);
    assert.deepEqual(third.events, []);
    assert.equal(source.remaining(), 0);
  });

  it('throws a daemon-coded failure for an error step', async () => {
    const source = createScriptedSource({ id: 'synthetic.script', script: [{ error: 'adapter broke' }] });
    await assert.rejects(() => source.poll({ signal: new AbortController().signal }), (error) => {
      assert.equal(error.code, DAEMON_CODES.SOURCE_FAILED);
      assert.equal(error.details.step, 1);
      return true;
    });
  });

  it('stays pending until the abort signal fires', async () => {
    const source = createScriptedSource({ id: 'synthetic.script', script: [{ hang: true }] });
    const controller = new AbortController();
    const pending = source.poll({ signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error) => {
      assert.equal(error.code, DAEMON_CODES.SOURCE_TIMEOUT);
      return true;
    });
  });

  it('requires an id', () => {
    assert.throws(() => createScriptedSource({}), (error) => {
      assert.equal(error.code, DAEMON_CODES.SOURCE_INVALID);
      return true;
    });
  });
});

describe('stable key parity with @aegisharness/event-store (ADR-0006 §2.3)', () => {
  /**
   * The memory adapter cannot import the package (mock mode must not load `node:sqlite`),
   * so its key derivation is a second implementation. This test is the guard rail the ADR
   * promises: for every contract-valid shape, the double and the store must agree.
   */
  const corpus = [
    { source_seq: 1 },
    { source_seq: 2, native_record_id: 'r-2' },
    { source_seq: 3, native_record_id: '' },
    { source_seq: 4, source_generation: 2 },
    { source_seq: 5, source_generation: 2, native_record_id: 'r-5' },
    { source_seq: 9007199254740991 },
    { source_seq: 6, stable_source_id: 'linux.audit.execve' },
    { source_seq: 7, native_record_id: 'a b c' },
    { source_seq: 8, native_record_id: 'native:already-prefixed' },
    { source_seq: 9, native_record_id: 'ünïcode' },
    { source_seq: 10, source_generation: 0 },
  ];

  it('derives the same dedupe key for every contract-valid event shape', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    for (const overrides of corpus) {
      const event = makeEvent(overrides);
      const expected = packageStableKeyOf(event);
      const [actual] = store.stableKeysOf([event]);
      assert.equal(
        actual,
        `${expected.stable_source_id}\u0000${expected.source_generation}\u0000${expected.dedupe_key}`,
        `key drift for ${JSON.stringify(overrides)}`,
      );
    }
  });

  it('answers hasStableKeys exactly like the real store answers hasDedupeKeys', () => {
    const store = createMemoryEventStoreAdapter();
    store.open();
    const stored = corpus.map((overrides) => makeEvent(overrides));
    for (const event of stored) {
      store.ingest({ event });
    }
    // Same stable key, fresh event id: the store would call it a duplicate, so must we.
    const replays = corpus.map((overrides) => makeEvent(overrides));
    const flags = store.hasStableKeys(replays);
    assert.deepEqual(flags, replays.map(() => true));
    // A new generation is a different key.
    const nextGeneration = corpus.map((overrides) => makeEvent({ ...overrides, source_generation: 9 }));
    assert.deepEqual(store.hasStableKeys(nextGeneration), nextGeneration.map(() => false));
  });
});
