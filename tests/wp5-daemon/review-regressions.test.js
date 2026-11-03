/**
 * review-regressions.test.js — cases added after the first independent review.
 *
 * Each case reproduces a defect the reviewer found (or a class of it) so it can
 * never come back silently. The three P0s in particular were all "alert quietly
 * lost while every counter looked healthy", which is exactly what a test must pin
 * down: not just that the code runs, but that the alert row exists afterwards.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';

import { LIMITS } from '../../packages/contracts/src/index.js';
import { MAX_ALERT_EVENT_IDS, buildWritePlan } from '../../apps/daemon/src/detection-bridge.js';
import { provisionApiToken } from '../../apps/daemon/src/api/auth.js';
import { createPipeline } from '../../apps/daemon/src/pipeline.js';
import { computeHealth } from '../../apps/daemon/src/health.js';
import { createScheduler } from '../../apps/daemon/src/scheduler.js';
import { createControlApi } from '../../apps/daemon/src/api/server.js';
import { createAuthGuard, isAllowedHost } from '../../apps/daemon/src/api/auth.js';
import { createDaemon } from '../../apps/daemon/src/daemon.js';
import * as errors from '../../apps/daemon/src/errors.js';
import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import {
  BASE_MS,
  TEST_EPOCH,
  TEST_TOKEN,
  createManualClock,
  httpRequest,
  makeConfig,
  makeEngine,
  makeEvent,
  makeTempDir,
  makeStore,
  settle,
  waitFor,
} from './helpers.js';

const PACK_LIMIT = LIMITS.maxArrayItems;

/** Events at `offsetMs` from BASE_MS, with a matching receive time. */
function eventAt(offsetMs, overrides = {}) {
  return makeEvent({
    ...overrides,
    observed_at: new Date(BASE_MS + offsetMs).toISOString(),
    received_at: new Date(BASE_MS + offsetMs + 1000).toISOString(),
  });
}

describe('P0-1: a batch that straddles an aggregation window keeps both alerts', () => {
  it('writes one contribution per window instead of dropping both', () => {
    const clock = createManualClock(BASE_MS + 2 * 3600 * 1000);
    const store = makeStore(clock);
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });

    // Window A = [00:00, 00:15), window B = [00:15, 00:30); one batch spans both.
    const before = eventAt(14 * 60 * 1000 + 30 * 1000, { source_seq: 1 });
    const after = eventAt(15 * 60 * 1000 + 30 * 1000, { source_seq: 2 });
    const summary = pipeline.ingestBatch([before, after]);

    assert.equal(summary.accepted, 2);
    assert.equal(summary.store_errors, 0);
    assert.equal(store.dump().events.length, 2);
    const alerts = store.dump().alerts;
    assert.equal(alerts.length, 2, 'each window must keep its own alert row');
    assert.deepEqual(alerts.map((alert) => alert.count).sort(), [1, 1]);
    // No observation may be counted in a window it does not belong to.
    for (const alert of alerts) {
      assert.ok(alert.first_seen >= alert.window_start);
      assert.ok(alert.last_seen <= alert.window_end);
    }
    assert.equal(pipeline.stats().alerts_dropped, 0);
  });
});

describe('P0-2: a contribution larger than the id cap keeps an exact count', () => {
  it('caps event_ids at the contract limit and marks truncation', () => {
    assert.equal(MAX_ALERT_EVENT_IDS, PACK_LIMIT, 'the local cap must match the contract');
    const clock = createManualClock(BASE_MS + 2 * 3600 * 1000);
    const store = makeStore(clock);
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count'],
      clock,
    });
    const batch = Array.from({ length: 300 }, (_unused, index) => eventAt(index * 10, { source_seq: index + 1 }));
    const summary = pipeline.ingestBatch(batch);

    assert.equal(summary.accepted, 300);
    assert.equal(summary.alerts, 1);
    const alerts = store.dump().alerts;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].count, 300, 'the count must stay exact even when ids are capped');
    assert.equal(alerts[0].event_ids.length, PACK_LIMIT);
    assert.equal(alerts[0].event_ids_truncated, true);
    assert.equal(pipeline.stats().alerts_truncated, 1);
    assert.equal(pipeline.stats().alerts_dropped, 0);
  });

  it('rejects a DTO whose truncation flag contradicts its count', () => {
    // Guards the guard: this is the invariant the cap exists to satisfy.
    const plan = buildWritePlan({
      result: {
        detections: [],
        alerts: [{
          alertId: '11111111-1111-4111-8111-111111111111',
          ruleId: 'proc.suspicious-start',
          ruleVersion: '1.0.0',
          fingerprint: 'f'.repeat(64),
          severity: 'high',
          status: 'new',
          firstSeen: BASE_MS,
          lastSeen: BASE_MS,
          windowStart: BASE_MS,
          windowEnd: BASE_MS + 900000,
          count: 1,
          eventIds: [],
          eventIdsTruncated: false,
        }],
        analysisRequests: [],
      },
      events: [eventAt(0, { source_seq: 1 })],
      epoch: TEST_EPOCH,
    });
    assert.equal(plan.counters.alerts, 0);
    assert.equal(plan.counters.skipped_no_new_observation, 1);
  });
});

describe('P0-3: a restart inside a live window does not abort the transaction', () => {
  /**
   * The escalation rule is what makes this reachable: an analysis request is only
   * emitted when an alert is created or escalates, and the idempotency key includes the
   * severity. After a restart the engine is empty, so the same window is "created"
   * again with the new severity — a different key, a different (freshly minted) alert
   * id, and a foreign key that only resolves if the request uses the stored id.
   */
  const ESCALATION_PACK = {
    schemaVersion: '1.0',
    packId: 'wp5-escalation',
    packVersion: '1.0.0',
    rules: [{
      ruleId: 'proc.suspicious-start',
      version: '1.0.0',
      type: 'condition',
      severity: 'high',
      severityFrom: 'meta.severity',
      fields: ['process_name', 'meta.severity'],
      fingerprint: ['process_name'],
      when: { field: 'process_name', operator: 'eq', value: 'evil.exe' },
    }],
  };

  async function bootOneShot(t, dir, events) {
    const queue = [...events];
    const daemon = createDaemon({
      config: makeConfig(dir, { rulePack: ESCALATION_PACK, top: { mode: 'full' } }),
      sources: [{
        id: 'synthetic.replay',
        kind: 'process',
        poll: () => ({ events: [queue.shift()].filter(Boolean), cursor: { offset: 1 } }),
      }],
      clock: createManualClock(BASE_MS + 3600 * 1000),
    });
    t.after(async () => {
      await daemon.shutdown('test');
    });
    await daemon.start();
    return daemon;
  }

  it('reuses the stored alert id when the severity escalates after a restart', async (t) => {
    const dir = makeTempDir();

    const a = await bootOneShot(t, dir, [eventAt(60 * 1000, { source_seq: 1, severity: 'high' })]);
    await waitFor(() => a.status().store.stats().events === 1, { label: 'first event stored' });
    assert.equal(a.status().store.stats().alerts, 1);
    assert.equal(a.status().store.stats().analyses, 1);
    await a.stop('restart');

    const b = await bootOneShot(t, dir, [eventAt(120 * 1000, { source_seq: 2, severity: 'critical' })]);
    await waitFor(() => b.status().store.stats().events === 2, { label: 'second event stored' });

    const stats = b.status().store.stats();
    assert.equal(stats.events, 2, 'the escalating event must be stored, not rolled back');
    assert.equal(stats.alerts, 1, 'one fingerprint keeps one alert row');
    assert.equal(b.status().pipeline.stats().store_errors, 0, 'T1 must not have rolled back');
    assert.equal(b.status().pipeline.stats().alerts_dropped, 0);
    assert.equal(stats.analyses, 2, 'the escalated request was queued against the stored alert');
    assert.equal(b.health().reasons.includes('store:write-errors'), false);
  });

  it('keeps one alert row and no rollback across the merge', async (t) => {
    const dir = makeTempDir();
    const first = await bootOneShot(t, dir, [eventAt(60 * 1000, { source_seq: 1, severity: 'high' })]);
    await waitFor(() => first.status().store.stats().events === 1, { label: 'first stored' });
    await first.stop('restart');

    const second = await bootOneShot(t, dir, [eventAt(120 * 1000, { source_seq: 2, severity: 'critical' })]);
    await waitFor(() => second.status().store.stats().events === 2, { label: 'second stored' });
    assert.equal(second.status().store.stats().alerts, 1);
    assert.equal(second.status().pipeline.stats().store_errors, 0);
    assert.equal(second.health().status, 'ok');
  });
});


describe('P1-1: a transient store failure does not mark the process degraded forever', () => {
  it('clears the health reason once a batch succeeds again', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      epoch: TEST_EPOCH,
      clock,
      allowedSummaryFields: ['alert_count'],
    });
    store.setFailWrites(true);
    pipeline.ingestBatch([makeEvent({ source_seq: 1 })]);
    assert.equal(pipeline.stats().store_errors, 1);
    assert.equal(pipeline.stats().store_errors_consecutive, 1);

    store.setFailWrites(false);
    pipeline.ingestBatch([makeEvent({ source_seq: 2 })]);
    assert.equal(pipeline.stats().store_errors, 1, 'the cumulative counter keeps the history');
    assert.equal(pipeline.stats().store_errors_consecutive, 0, 'health sees only the current state');
  });
});

describe('P1-2: closing the API before or during start does not leak the listener', () => {
  it('refuses to start once closed', async () => {
    const clock = createManualClock(BASE_MS);
    const auth = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 1000 });
    const api = createControlApi({
      config: {
        host: '127.0.0.1',
        port: 0,
        requestTimeoutMs: 1000,
        headersTimeoutMs: 1000,
        keepAliveTimeoutMs: 500,
        maxBodyBytes: 1024,
      },
      auth,
      handlers: {
        health: () => ({ status: 'ok', version: 'x' }),
        ready: () => ({ ready: true, body: {} }),
        status: () => ({}),
        pollSource: async () => ({}),
      },
    });
    await api.close();
    await assert.rejects(() => api.start(), (error) => {
      assert.equal(error.code, DAEMON_CODES.LIFECYCLE_NOT_RUNNING);
      return true;
    });
  });

  it('closes the socket when close() lands while the bind is in flight', async () => {
    const clock = createManualClock(BASE_MS);
    const auth = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 1000 });
    const api = createControlApi({
      config: {
        host: '127.0.0.1',
        port: 0,
        requestTimeoutMs: 1000,
        headersTimeoutMs: 1000,
        keepAliveTimeoutMs: 500,
        maxBodyBytes: 1024,
      },
      auth,
      handlers: {
        health: () => ({ status: 'ok', version: 'x' }),
        ready: () => ({ ready: true, body: {} }),
        status: () => ({}),
        pollSource: async () => ({}),
      },
    });
    const starting = api.start();
    await api.close();
    await assert.rejects(() => starting, (error) => {
      assert.equal(error.code, DAEMON_CODES.LIFECYCLE_NOT_RUNNING);
      return true;
    });
    // Nothing is listening on the configured address afterwards.
    assert.equal(api.address().port, null);
  });
});

describe('P1-3: the scheduler handle survives being destructured', () => {
  it('starts and polls without depending on `this`', async () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      epoch: TEST_EPOCH,
      clock,
      allowedSummaryFields: ['alert_count'],
    });
    const scheduler = createScheduler({
      sources: [{ id: 'synthetic.one', kind: 'synthetic', poll: () => ({ events: [makeEvent({ source_seq: 1 })] }) }],
      pipeline,
      clock,
      tickMs: 3600000,
      sourceTimeoutMs: 1000,
      maxBatchEvents: 10,
      staleAfterMs: 30000,
      maxSources: 4,
    });
    const { start, tick, stop } = scheduler;
    start();
    await settle();
    assert.equal(scheduler.sourceStatus('synthetic.one').accepted, 1);
    assert.equal(tick(), 0, 'not due yet, but callable when detached');
    await stop({ timeoutMs: 500 });
  });
});

describe('P1-4: the request tally cannot be grown by unknown paths', () => {
  it('counts unknown paths as a number instead of naming them', async () => {
    const clock = createManualClock(BASE_MS);
    const auth = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 1000 });
    const api = createControlApi({
      config: {
        host: '127.0.0.1',
        port: 0,
        requestTimeoutMs: 1000,
        headersTimeoutMs: 1000,
        keepAliveTimeoutMs: 500,
        maxBodyBytes: 1024,
      },
      auth,
      handlers: {
        health: () => ({ status: 'ok', version: 'x' }),
        ready: () => ({ ready: true, body: {} }),
        status: () => ({}),
        pollSource: async () => ({}),
      },
    });
    const { port } = await api.start();
    try {
      for (let index = 0; index < 5; index += 1) {
        await httpRequest(port, `/random-${index}`);
      }
      const stats = api.stats();
      assert.equal(stats.unknown_paths, 5);
      assert.deepEqual(Object.keys(stats.by_path), []);
    } finally {
      await api.close();
    }
  });
});

describe('P1-6: the lockout throttles guesses, not browser probes', () => {
  it('does not let unauthenticated cross-origin probes lock the operator out', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 2, failureWindowMs: 1000 });
    // Any web page can send a cross-origin simple GET to 127.0.0.1 without credentials.
    // Those must keep returning 401 and must never exhaust the operator's quota.
    for (let index = 0; index < 10; index += 1) {
      assert.equal(guard.authenticate(undefined, 'peer').code, DAEMON_CODES.AUTH_REQUIRED);
    }
    assert.equal(guard.authenticate('Bearer malformed', 'peer').code, DAEMON_CODES.AUTH_REQUIRED);
    assert.deepEqual(guard.authenticate(`Bearer ${TEST_TOKEN}`, 'peer'), { ok: true });
  });

  it('still throttles a peer that keeps presenting wrong tokens', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 2, failureWindowMs: 1000 });
    assert.equal(guard.authenticate(`Bearer ${'a'.repeat(43)}`, 'peer').code, DAEMON_CODES.AUTH_FAILED);
    assert.equal(guard.authenticate(`Bearer ${'b'.repeat(43)}`, 'peer').code, DAEMON_CODES.AUTH_FAILED);
    // The third *guess* is throttled ...
    assert.equal(guard.authenticate(`Bearer ${'c'.repeat(43)}`, 'peer').code, DAEMON_CODES.AUTH_RATE_LIMITED);
    // ... but the bucket only holds wrong guesses, so the real token is still served.
    assert.deepEqual(guard.authenticate(`Bearer ${TEST_TOKEN}`, 'peer'), { ok: true });
  });

  it('reports the configured lockout window as retry-after', async () => {
    const clock = createManualClock(BASE_MS);
    const auth = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 1, failureWindowMs: 5000 });
    const api = createControlApi({
      config: {
        host: '127.0.0.1',
        port: 0,
        requestTimeoutMs: 1000,
        headersTimeoutMs: 1000,
        keepAliveTimeoutMs: 500,
        maxBodyBytes: 1024,
        authFailureWindowMs: 5000,
      },
      auth,
      handlers: {
        health: () => ({ status: 'ok', version: 'x' }),
        ready: () => ({ ready: true, body: {} }),
        status: () => ({}),
        pollSource: async () => ({}),
      },
    });
    const { port } = await api.start();
    try {
      await httpRequest(port, '/api/v1/status', { headers: { authorization: `Bearer ${'c'.repeat(43)}` } });
      // The bucket holds guesses, so a second *wrong* token is what carries the 429.
      const limited = await httpRequest(port, '/api/v1/status', {
        headers: { authorization: `Bearer ${'d'.repeat(43)}` },
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '5');
      // A request that presents no bearer is not a guess: it stays `401 AUTH_REQUIRED`
      // even while the bucket is full, so the lockout cannot be used to make the
      // daemon's authentication behaviour indistinguishable from an unavailable one.
      const anonymous = await httpRequest(port, '/api/v1/status');
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.body.error.code, DAEMON_CODES.AUTH_REQUIRED);
    } finally {
      await api.close();
    }
  });
});

describe('P2: hardening details', () => {
  it('refuses Host headers that are not a literal loopback endpoint', () => {
    for (const host of [
      'evil.com@127.0.0.1:8080',
      '127.0.0.1:8080/evil',
      '127.0.0.1:8080?x=1',
      '127.0.0.1:',
      '0x7f000001:8080',
      '[::0001]:8080',
      '127.0.0.1.:8080',
    ]) {
      assert.equal(isAllowedHost(host, 8080), false, `${host} must be refused`);
    }
    assert.equal(isAllowedHost('127.0.0.1:8080', 8080), true);
    assert.equal(isAllowedHost('[::1]:8080', 8080), true);
  });

  it('carries the security headers on a malformed-request 400', async () => {
    const clock = createManualClock(BASE_MS);
    const auth = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 1000 });
    const api = createControlApi({
      config: {
        host: '127.0.0.1',
        port: 0,
        requestTimeoutMs: 1000,
        headersTimeoutMs: 1000,
        keepAliveTimeoutMs: 500,
        maxBodyBytes: 1024,
      },
      auth,
      handlers: {
        health: () => ({ status: 'ok', version: 'x' }),
        ready: () => ({ ready: true, body: {} }),
        status: () => ({}),
        pollSource: async () => ({}),
      },
    });
    const { port } = await api.start();
    try {
      const raw = await new Promise((resolve) => {
        const socket = netConnect({ host: '127.0.0.1', port }, () => {
          socket.write('GARBAGE / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        });
        let text = '';
        socket.on('data', (chunk) => {
          text += chunk.toString('utf8');
        });
        socket.on('error', () => resolve(text));
        socket.on('close', () => resolve(text));
        setTimeout(() => {
          socket.destroy();
          resolve(text);
        }, 500);
      });
      assert.match(raw, /400/u);
      assert.match(raw, /x-content-type-options: nosniff/iu);
      assert.match(raw, /content-security-policy/iu);
    } finally {
      await api.close();
    }
  });

  it('counts scheduler polls in the status counters', async (t) => {
    const dir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dir),
      sources: [{ id: 'synthetic.one', kind: 'synthetic', poll: () => ({ events: [] }) }],
      clock: createManualClock(BASE_MS),
    });
    t.after(async () => daemon.shutdown('test'));
    await daemon.start();
    await waitFor(() => daemon.status().counters.polls >= 1, { label: 'a scheduled poll was counted' });
    assert.ok(daemon.status().counters.polls >= 1);
  });

  it('does not fire a pending checkpoint write after shutdown', async (t) => {
    const dir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dir),
      sources: [{ id: 'synthetic.one', kind: 'synthetic', poll: () => ({ events: [makeEvent({ source_seq: 1 })] }) }],
      clock: createManualClock(BASE_MS),
    });
    t.after(async () => daemon.shutdown('test'));
    await daemon.start();
    await waitFor(() => daemon.status().store.stats().events === 1, { label: 'one event stored' });
    await daemon.stop('test');
    const before = readFileSync(join(dir, 'daemon-state.json'), 'utf8');
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    const after = readFileSync(join(dir, 'daemon-state.json'), 'utf8');
    assert.equal(after, before, 'the debounced write must be cancelled by shutdown');
  });
});

describe('NEW-1: an event exactly on a window boundary counts once', () => {
  it('treats the window as half-open', () => {
    const clock = createManualClock(BASE_MS + 2 * 3600 * 1000);
    const store = makeStore(clock);
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });
    // 14:59:59.000 belongs to W; 15:00:00.000 is exactly W's windowEnd and belongs to W+1.
    const before = eventAt(14 * 60 * 1000 + 59 * 1000, { source_seq: 1 });
    const seam = eventAt(15 * 60 * 1000, { source_seq: 2 });
    pipeline.ingestBatch([before, seam]);

    const alerts = store.dump().alerts;
    assert.equal(alerts.length, 2);
    assert.deepEqual(alerts.map((alert) => alert.count).sort(), [1, 1], 'two events must be counted twice, not three times');
    for (const alert of alerts) {
      assert.ok(alert.last_seen < alert.window_end, 'a contribution may not include the closing instant');
    }
  });
});

describe('NEW-2: a failed anchor write retains the alert contribution', () => {
  function failingStore(store, failOnCall) {
    let calls = 0;
    return {
      ...store,
      ingest(request) {
        calls += 1;
        if (calls === failOnCall) {
          const { DaemonError } = errors;
          throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure');
        }
        return store.ingest(request);
      },
    };
  }

  it('writes the contribution with the next batch instead of losing it', () => {
    const clock = createManualClock(BASE_MS);
    const inner = makeStore(clock);
    // The third ingest of the batch carries the alert contribution (it anchors on the
    // last contributing event), so failing exactly that call reproduces the defect.
    const store = failingStore(inner, 3);
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });

    const first = pipeline.ingestBatch([
      eventAt(1000, { source_seq: 1 }),
      eventAt(2000, { source_seq: 2 }),
      eventAt(3000, { source_seq: 3 }),
    ]);
    assert.equal(first.store_errors, 1);
    assert.equal(inner.dump().alerts.length, 0, 'the contribution did not land');
    assert.equal(pipeline.stats().contributions_pending, 1, 'but it is retained and visible');
    assert.equal(computeHealth({
      lifecycle: 'running',
      store: { open: true, errors: pipeline.stats().store_errors_consecutive },
      detection: { faults: 0, frozen: false },
      pipeline: { pendingContributions: pipeline.stats().contributions_pending },
      sources: [{ id: 's', lifecycle: 'ok', stale: false, consecutive_failures: 0 }],
    }).status, 'degraded');

    const second = pipeline.ingestBatch([eventAt(4000, { source_seq: 4 })]);
    assert.equal(second.store_errors, 0);
    assert.equal(pipeline.stats().contributions_retried, 1);
    // 第 8 轮 P1-5 之后：那条证据暂时核验不了的观测不再当场判死，而是**延后**等它自己的
    // 事件回来（多来源场景下，别的来源的批次会把队列排空，当场丢弃就是永久少计）。
    assert.ok(pipeline.stats().contributions_pending >= 1, '暂时不可核实的证据必须延后而不是丢弃');
    const alerts = inner.dump().alerts;
    assert.equal(alerts.length, 1);
    // 第 6 轮 P1-1 之后：保留的告警里那条**证据无法核实**的观测（它的事件行从未入库，
    // 也不在本批里）必须被扣掉。count 只统计真的能查到事件行的观测。
    assert.equal(alerts[0].count, 3, 'only observations with a stored event row are counted');
    assert.equal(inner.dump().events.length, 3);
    assert.equal(alerts[0].count, inner.dump().events.length);
    const storedIds = new Set(inner.dump().events.map((event) => event.event_id));
    for (const id of alerts[0].event_ids) {
      assert.ok(storedIds.has(id), `event_ids 中的 ${id} 必须能在事件表里查到`);
    }
    assert.equal(alerts[0].event_ids_truncated, false, 'count 与证据条数一致时不得标截断');

    // 该事件若永远不回来：重试预算耗尽后必须丢弃并计数，延后不是永久占用。
    const droppedBefore = pipeline.stats().contributions_dropped;
    for (let round = 0; round < 10; round += 1) {
      const summary = pipeline.ingestBatch([eventAt(60000 + round * 60000, { source_seq: 10 + round })]);
      assert.equal(summary.store_errors, 0);
    }
    assert.ok(
      pipeline.stats().contributions_dropped > droppedBefore,
      '重试预算耗尽后必须丢弃并计入 contributions_dropped',
    );
    assert.equal(pipeline.stats().contributions_pending, 0, '队列不得被一条永不回头的证据永久占用');
    const finalEvents = new Set(inner.dump().events.map((event) => event.event_id));
    for (const alert of inner.dump().alerts) {
      for (const id of alert.event_ids) {
        assert.ok(finalEvents.has(id), `event_ids 中的 ${id} 必须能在事件表里查到（不得悬空）`);
      }
      assert.equal(
        alert.event_ids_truncated,
        alert.count > alert.event_ids.length,
        'truncated 必须当且仅当 count 大于证据条数',
      );
    }
  });
});

describe('NEW-6: counters and route buckets stay exact', () => {
  it('does not count an on-demand poll twice', async (t) => {
    const dir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dir),
      sources: [{ id: 'synthetic.one', kind: 'synthetic', poll: () => ({ events: [] }) }],
      clock: createManualClock(BASE_MS),
    });
    t.after(async () => daemon.shutdown('test'));
    await daemon.start();
    await waitFor(() => daemon.status().counters.polls === 1, { label: 'the start-up poll' });
    await waitFor(() => daemon.status().scheduler.status().every((source) => !source.polling), { label: 'idle' });
    await daemon.pollSource('synthetic.one');
    assert.equal(daemon.status().counters.polls, 2, 'one start-up poll plus one on-demand poll');
  });

  it('buckets the parameterised poll route under a fixed key', async () => {
    const clock = createManualClock(BASE_MS);
    const auth = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 1000 });
    const api = createControlApi({
      config: {
        host: '127.0.0.1',
        port: 0,
        requestTimeoutMs: 1000,
        headersTimeoutMs: 1000,
        keepAliveTimeoutMs: 500,
        maxBodyBytes: 1024,
      },
      auth,
      handlers: {
        health: () => ({ status: 'ok', version: 'x' }),
        ready: () => ({ ready: true, body: {} }),
        status: () => ({}),
        pollSource: async () => ({}),
      },
    });
    const { port } = await api.start();
    try {
      for (let index = 0; index < 5; index += 1) {
        await httpRequest(port, `/api/v1/collectors/source-${index}/poll`, { method: 'GET' });
      }
      const stats = api.stats();
      assert.deepEqual(Object.keys(stats.by_path), ['/api/v1/collectors/:id/poll']);
      assert.equal(stats.by_path['/api/v1/collectors/:id/poll'], 5);
    } finally {
      await api.close();
    }
  });
});

describe('NEW-2b: a retained contribution survives an engine rebuild', () => {
  /**
   * The nastiest ordering: the retention happened under engine A (alert id X), then the
   * engine was rebuilt, so the retry's plan carries alert id Y. Writing both under two
   * ids would make the store keep one and reject the request naming the other — turning
   * a single lost alert into a permanently stalled source.
   */
  it('supersedes a retained contribution that this batch re-observes', () => {
    const clock = createManualClock(BASE_MS);
    const inner = makeStore(clock);
    let failNext = false;
    const store = {
      ...inner,
      ingest(request) {
        if (failNext) {
          failNext = false;
          throw new (errors.DaemonError)(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure');
        }
        return inner.ingest(request);
      },
    };
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });

    failNext = true;
    // Single event: its own group carries the alert, so the failure retains the alert and
    // its request.
    const failedEvent = eventAt(1000, { source_seq: 1 });
    const first = pipeline.ingestBatch([failedEvent]);
    assert.equal(first.store_errors, 1);
    assert.equal(pipeline.stats().contributions_pending, 1);

    // The engine is replaced, exactly as a detection fault would do; the collector then
    // replays the SAME event object (same event_id), so the new engine sees it as new.
    pipeline.replaceEngine(makeEngine(clock));
    const second = pipeline.ingestBatch([
      failedEvent,
      eventAt(3000, { source_seq: 3, payload: { process_name: 'other.exe', pid: 7 } }),
    ]);
    assert.equal(second.store_errors, 0, 'the retry must not abort T1');
    assert.equal(pipeline.stats().contributions_pending, 0);
    // 第 6 轮 P1-1 / P2-1 之后：本批已经重新观测到同一窗口，保留的那份必须让位，
    // 否则同一次观测会被计两遍（这正是 count=2 / ids=1 的来源）。
    assert.equal(pipeline.stats().contributions_superseded, 1, 'the retained copy is superseded, not added');

    const alerts = inner.dump().alerts;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].count, 1, 'one observation, counted once');
    assert.equal(alerts[0].event_ids_truncated, false, 'count 与证据条数一致时不得标截断');
    const storedIds = new Set(inner.dump().events.map((event) => event.event_id));
    for (const id of alerts[0].event_ids) {
      assert.ok(storedIds.has(id), 'no dangling evidence after the rebuild');
    }
    assert.equal(inner.dump().analyses.length >= 1, true, 'the request was queued');
    for (const analysis of inner.dump().analyses) {
      assert.equal(analysis.alert_id, alerts[0].alert_id, 'every request names the stored alert');
    }
  });

  it('keeps both requests: one row per idempotency key, nothing dropped', () => {
    const clock = createManualClock(BASE_MS);
    const inner = makeStore(clock);
    let failNext = false;
    const store = {
      ...inner,
      ingest(request) {
        if (failNext) {
          failNext = false;
          throw new (errors.DaemonError)(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure');
        }
        return inner.ingest(request);
      },
    };
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });
    failNext = true;
    const failedEvent = eventAt(1000, { source_seq: 1 });
    pipeline.ingestBatch([failedEvent]);
    assert.equal(pipeline.stats().contributions_pending, 1);

    // 同一事件对象被重投（同 event_id）：这样它的证据会在本批真的入库，保留的告警与
    // 请求才有资格被补写。换成"全新的事件"会让证据无法核实，按第 6 轮 P1-1 必须丢弃。
    const second = pipeline.ingestBatch([
      failedEvent,
      eventAt(3000, { source_seq: 3 }),
    ]);
    assert.equal(second.store_errors, 0);
    assert.equal(pipeline.stats().requests_dropped, 0, 'no request may be dropped');
    assert.equal(inner.dump().analyses.length, 1, 'one row per idempotency key');
    assert.equal(inner.dump().analyses[0].alert_id, inner.dump().alerts[0].alert_id);
  });
});

describe('NEW-5: the id list keeps the earliest ids of the contribution', () => {
  it('is consistent with the store, which appends only up to the cap', () => {
    const clock = createManualClock(BASE_MS + 2 * 3600 * 1000);
    const store = makeStore(clock);
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count'],
      clock,
    });
    const batch = Array.from({ length: 300 }, (_unused, index) => eventAt(index * 10, { source_seq: index + 1 }));
    pipeline.ingestBatch(batch);
    const alert = store.dump().alerts[0];
    assert.equal(alert.count, 300);
    assert.equal(alert.event_ids.length, MAX_ALERT_EVENT_IDS);
    // The first event of the batch is the first id kept: the store's own policy is
    // "keep what is already there, append nothing once full".
    assert.equal(alert.event_ids[0], batch[0].event_id);
    assert.equal(alert.event_ids.includes(batch[batch.length - 1].event_id), false);
  });
});

describe('NEW-3: the regenerated token file is private and complete', () => {
  it('replaces the file atomically and leaves no temporary behind', () => {
    const dir = makeTempDir();
    const tokenFile = join(dir, 'api-token');
    writeFileSync(tokenFile, 'garbage\n', 'utf8');
    const provisioned = provisionApiToken({ token: null, tokenFile });
    assert.equal(provisioned.source, 'regenerated');
    assert.equal(readFileSync(tokenFile, 'utf8'), `${provisioned.token}\n`);
    assert.deepEqual(readdirSync(dir), ['api-token']);
    if (process.platform !== 'win32') {
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    }
  });
});

describe('NEW-2c: retrying never switches itself off', () => {
  const TWO_RULES = {
    schemaVersion: '1.0',
    packId: 'wp5-two-rules',
    packVersion: '1.0.0',
    rules: [
      {
        ruleId: 'proc.rule-alpha',
        version: '1.0.0',
        type: 'condition',
        severity: 'high',
        fields: ['process_name'],
        fingerprint: ['process_name'],
        when: { field: 'process_name', operator: 'eq', value: 'evil.exe' },
      },
      {
        ruleId: 'proc.rule-beta',
        version: '1.0.0',
        type: 'condition',
        severity: 'medium',
        fields: ['process_name'],
        fingerprint: ['process_name'],
        when: { field: 'process_name', operator: 'eq', value: 'evil.exe' },
      },
    ],
  };

  it('keeps retrying after many transient failures', () => {
    const clock = createManualClock(BASE_MS);
    const inner = makeStore(clock);
    let failNext = false;
    const store = {
      ...inner,
      ingest(request) {
        if (failNext) {
          failNext = false;
          throw new (errors.DaemonError)(DAEMON_CODES.STORE_WRITE_FAILED, 'injected');
        }
        return inner.ingest(request);
      },
    };
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      // 失败的那条事件在下一批以**同一对象**重投，和真实采集器一致（游标不推进时重放同一批）。
      // 否则按第 6 轮 P1-1，保留的贡献因为证据无法核实在 attach 时被丢弃，测不到重试预算。
      const failedEvent = eventAt(1000 * (cycle * 2 + 1), { source_seq: cycle * 2 + 1 });
      failNext = true;
      pipeline.ingestBatch([failedEvent]);
      failNext = false;
      pipeline.ingestBatch([failedEvent, eventAt(1000 * (cycle * 2 + 2), { source_seq: cycle * 2 + 2 })]);
    }
    const stats = pipeline.stats();
    assert.equal(stats.contributions_dropped, 0, 'transient failures must not disable retrying');
    assert.equal(stats.contributions_pending, 0);
    // Each cycle stores two events (the failed one lands on the replay), and both
    // observations reach the alert: the retained contribution is attached, not lost.
    assert.equal(inner.dump().events.length, 20);
    assert.equal(inner.dump().alerts[0].count, 20, 'every observation must be accounted for');
    assert.equal(inner.dump().alerts[0].count, inner.dump().events.length);
    const storedIds = new Set(inner.dump().events.map((event) => event.event_id));
    for (const id of inner.dump().alerts[0].event_ids) {
      assert.ok(storedIds.has(id), 'retried evidence must all exist');
    }
  });

  it('drops a poison contribution after its own retry budget, without stalling others', () => {
    const clock = createManualClock(BASE_MS);
    const inner = makeStore(clock);
    let failAlerts = true;
    const store = {
      ...inner,
      ingest(request) {
        if (failAlerts && (request.alerts ?? []).length > 0) {
          throw new (errors.DaemonError)(DAEMON_CODES.STORE_WRITE_FAILED, 'injected');
        }
        return inner.ingest(request);
      },
    };
    const pipeline = createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });
    // Each batch has two events: the first carries only a finding (and is written), the
    // second carries the alert contribution and fails. So the collector keeps making
    // progress while one contribution keeps failing.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      pipeline.ingestBatch([
        eventAt(1000 * (cycle * 2 + 1), { source_seq: cycle * 2 + 1 }),
        eventAt(1000 * (cycle * 2 + 2), { source_seq: cycle * 2 + 2 }),
      ]);
    }
    assert.equal(inner.dump().events.length, 10, 'the non-anchor events kept being written');
    assert.ok(pipeline.stats().contributions_dropped >= 1, 'the poison contribution was given up on');

    // With the fault gone the next batch writes its own alert: the retry budget did not
    // disable the mechanism.
    failAlerts = false;
    const recovered = pipeline.ingestBatch([
      eventAt(30000, { source_seq: 98 }),
      eventAt(31000, { source_seq: 99 }),
    ]);
    assert.equal(recovered.store_errors, 0);
    assert.equal(inner.dump().alerts.length >= 1, true);
  });

  it('never places a request before the event that creates its alert', () => {
    const clock = createManualClock(BASE_MS);
    const inner = makeStore(clock);
    const pipeline = createPipeline({
      store: inner,
      detection: makeEngine(clock, TWO_RULES),
      createDetection: () => makeEngine(clock, TWO_RULES),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });
    // Two rules match the evil event, so it carries two alerts and two requests; the
    // surplus request must not be moved to the earlier (benign) event, whose T1 call runs
    // before the alert rows exist.
    const summary = pipeline.ingestBatch([
      eventAt(1000, { source_seq: 1, payload: { process_name: 'notepad.exe', pid: 1 } }),
      eventAt(2000, { source_seq: 2 }),
    ]);
    assert.equal(summary.store_errors, 0, 'the batch must not be rolled back');
    assert.equal(inner.dump().alerts.length, 2);
    assert.equal(pipeline.stats().requests_dropped, 1, 'the unanchorable request is counted, not hidden');
    for (const analysis of inner.dump().analyses) {
      assert.ok(inner.dump().alerts.some((alert) => alert.alert_id === analysis.alert_id));
    }
  });
});

describe('REV5-1: duplicate 重放不得把同一次观测计两次', () => {
  function makePipelineOn(store, clock) {
    return createPipeline({
      store,
      detection: makeEngine(clock),
      createDetection: () => makeEngine(clock),
      epoch: TEST_EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      clock,
    });
  }

  it('同一 source_seq、新 event_id 的重放在预过滤阶段就被拦下', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const pipeline = makePipelineOn(store, clock);

    const first = eventAt(1000, { source_seq: 1 });
    assert.equal(pipeline.ingestBatch([first]).accepted, 1);
    const requestsAfterFirst = pipeline.stats().analysis_requests;

    // ADR-0006：预过滤按稳定键判定，所以这次重放在**进入检测之前**就被丢掉，
    // 不会产生第二份观测，也不会第二次投递分析请求。
    const replay = eventAt(1000, { source_seq: 1 });
    const replayed = pipeline.ingestBatch([replay]);
    assert.equal(replayed.duplicate, 1, '稳定键相同必须判成重复');
    assert.equal(replayed.accepted, 0);
    assert.equal(store.dump().events.length, 1, '重放没有新增事件行');
    assert.equal(pipeline.stats().contributions_pending, 0, '已计过的观测不得被保留');
    assert.equal(pipeline.stats().alerts_dropped, 0, '预过滤拦下就不该再进保留分支');
    assert.equal(pipeline.stats().analysis_requests, requestsAfterFirst, '重放不得重复投递分析请求');

    pipeline.ingestBatch([eventAt(2000, { source_seq: 3 })]);

    const stored = store.dump().events;
    const alerts = store.dump().alerts;
    assert.equal(stored.length, 2, '真实入库事件只有两条');
    assert.equal(alerts.length, 1, '一个指纹一个窗口一行');
    // 核心断言：多贴一次保留贡献会得到 3，这里必须与真实入库条数一致。
    assert.equal(alerts[0].count, stored.length);
    assert.equal(alerts[0].count, 2);
    assert.equal(store.stats().events, 2);
  });

  it('竞态：探测报"不存在"但 T1 判重时，既不重复计数也不留悬空 id', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const pipeline = makePipelineOn(store, clock);
    pipeline.ingestBatch([eventAt(1000, { source_seq: 1 })]);

    // 模拟 ADR-0006 §5 的窗口：探测发生在写入之前，T1 在事务内才发现重复。
    store.hasStableKeys = (list) => list.map(() => false);
    const replay = eventAt(1000, { source_seq: 1 });
    const replayed = pipeline.ingestBatch([replay]);
    assert.equal(replayed.duplicate, 1, 'T1 必须把它判成重复');
    assert.equal(store.dump().events.length, 1, '重放没有新增事件行');
    assert.equal(pipeline.stats().contributions_pending, 0, '已计过的观测不得被保留');
    assert.equal(pipeline.stats().alerts_dropped, 1, '丢弃要计入既有计数器');

    pipeline.ingestBatch([eventAt(2000, { source_seq: 3 })]);

    const stored = store.dump().events;
    const alerts = store.dump().alerts;
    assert.equal(stored.length, 2);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].count, stored.length);
    const storedIds = new Set(stored.map((event) => event.event_id));
    for (const id of alerts[0].event_ids) {
      assert.ok(storedIds.has(id), `event_ids 中的 ${id} 必须能在事件表里查到`);
    }
  });

  it('告警的 event_ids 里没有悬空证据（重放被预过滤拦下）', () => {
    const clock = createManualClock(BASE_MS);
    const store = makeStore(clock);
    const pipeline = makePipelineOn(store, clock);

    pipeline.ingestBatch([eventAt(1000, { source_seq: 1 })]);
    const replay = eventAt(1000, { source_seq: 1 });
    pipeline.ingestBatch([replay]);
    pipeline.ingestBatch([eventAt(2000, { source_seq: 3 })]);

    const events = store.dump().events;
    const storedIds = new Set(events.map((event) => event.event_id));
    const alert = store.dump().alerts[0];
    assert.ok(alert.event_ids.length > 0, '告警必须带证据 id');
    for (const id of alert.event_ids) {
      assert.ok(storedIds.has(id), `event_ids 中的 ${id} 必须能在事件表里查到`);
    }
    // 未入库的 event_id 尤其不能出现。
    assert.equal(storedIds.has(replay.event_id), false);
    assert.equal(alert.event_ids.includes(replay.event_id), false);
  });

  it('竞态下库里确实没有该告警行时，duplicate 的贡献仍然被保留并在后续批次补齐', () => {
    const clock = createManualClock(BASE_MS);
    const inner = makeStore(clock);
    // 先只写入事件行、不写告警，于是同一个稳定键重放时 T1 判重、而 findAlertId 返回 null。
    const seeded = eventAt(1000, { source_seq: 1 });
    inner.ingest({ event: seeded });
    assert.equal(inner.stats().events, 1);
    assert.equal(inner.stats().alerts, 0);

    const pipeline = makePipelineOn(inner, clock);
    // 竞态形态：只有探测说谎时，事件才会走到 T1 的 duplicate 分支。
    inner.hasStableKeys = (list) => list.map(() => false);
    const replay = eventAt(1000, { source_seq: 1 });
    const replayed = pipeline.ingestBatch([replay]);
    assert.equal(replayed.duplicate, 1);
    // 反方向：库中无该行时必须保留，不能修成"一律不保留"。
    assert.equal(pipeline.stats().contributions_pending, 1);
    assert.equal(pipeline.stats().alerts_dropped, 0);

    pipeline.ingestBatch([eventAt(2000, { source_seq: 3 })]);

    // 第 6 轮 P1-1 之后：这份保留贡献的证据已被改写成**库里真实存在**的那个 id
    // （`verifiableEventIds` 把重复事件的 id 换成了命中的旧行 id），因此它是可核实的，
    // 保留并补齐是对的。这里的 count=2 对应 2 条真实入库事件。
    const alerts = inner.dump().alerts;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].count, 2, '保留的观测加上新观测');
    assert.equal(alerts[0].count, inner.dump().events.length);
    assert.equal(inner.stats().events, 2);
    assert.equal(pipeline.stats().contributions_pending, 0);
    const storedIds = new Set(inner.dump().events.map((event) => event.event_id));
    for (const id of alerts[0].event_ids) {
      assert.ok(storedIds.has(id), '不得留悬空证据');
    }
  });
});
