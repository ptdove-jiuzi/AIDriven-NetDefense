/**
 * A2 collector wiring: the seam between a platform collector and the daemon scheduler.
 *
 * What is proven here (see `docs/implementation/status/A2-SHAPE.md` §5/§6):
 *  - the `{name, source}` list is mapped to the daemon's `{id, kind, poll}` shape;
 *  - `binding.poll()` events are forwarded verbatim (no re-marshalling);
 *  - a zero-event poll carries an explicit `empty` reason, and a failure carries the
 *    collector's own code instead of a generic wrapper;
 *  - the daemon reports `empty` / `unavailable` per source instead of `ok`, and a store
 *    rejection becomes `counters.rejected_by_store` plus a log line naming the reason;
 *  - a `--collectors` spec is validated as a closed object.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DAEMON_CODES, DaemonError, createDaemon } from '../../apps/daemon/src/index.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import {
  EMPTY_REASONS,
  createBootId,
  createCollectorDaemonSource,
  createCollectorSources,
  daemonKindFor,
  emptyReasonFor,
  loadCollectorSpec,
  parseCollectorSpec,
} from '../../apps/daemon/src/adapters/collector-sources.js';
import { createEventFactory } from '../../packages/collectors/common/index.js';
import { validateTelemetryEvent } from '../../packages/contracts/src/index.js';
import { createMemoryEventStoreAdapter } from '../../apps/daemon/src/adapters/event-store.js';
import { loadConfig } from '../../apps/daemon/src/config.js';
import { createMemoryCursorStore } from '../../packages/collectors/common/memory-cursor-store.js';

const BOOT_ID = '0123456789abcdef0123456789abcdef';
const SOURCE_ID = 'windows.process-table';
const BASE_MS = 1_700_000_000_000;


/** A contract-valid event produced by the *collector* factory (integrity included). */
function makeCollectorEvent({ idFactory = () => '5f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' } = {}) {
  const factory = createEventFactory({ clock: () => BASE_MS, idFactory, bootId: BOOT_ID });
  return factory.create({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    generation: 0,
    sequence: 1,
    type: 'windows.process',
    severity: 'info',
    payload: { process_name: 'demo.exe', pid: 4242 },
    observedAt: BASE_MS,
  });
}

/** A binding-shaped double: `attachXSources` returns `{name, descriptor, collector, binding}`. */
function makeBinding({ descriptor, poll }) {
  const collector = {
    identity: () => ({ cursor: { last: 7 }, generation: 0, sequence: 9 }),
  };
  return { name: 'demo', descriptor, collector, binding: { descriptor, poll } };
}

function makeWiring({ bindings, cursorStore = createMemoryCursorStore({}), logger = null }) {
  return createCollectorSources({
    createSources: () => bindings.map((entry) => ({ name: entry.name, source: { descriptor: entry.descriptor } })),
    attachSources: () => bindings,
    createRuntime: () => ({}),
    options: {},
    cursorStore,
    bootId: BOOT_ID,
    clock: () => BASE_MS,
    logger,
  });
}

function makeLogger() {
  const entries = [];
  const push = (level) => (message, fields) => entries.push({ level, message, ...fields });
  return { entries, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

const PROCESS_DESCRIPTOR = Object.freeze({
  stableSourceId: SOURCE_ID,
  type: 'windows.process',
  kind: 'poll',
  intervalMs: 5_000,
});

test('a collector binding becomes a daemon source with id/kind/poll/intervalMs', () => {
  const event = makeCollectorEvent();
  const wiring = makeWiring({
    bindings: [makeBinding({ descriptor: PROCESS_DESCRIPTOR, poll: async () => ({ ok: true, items: [{ outcome: 'published', event }] }) })],
  });

  assert.equal(wiring.sources.length, 1);
  const [source] = wiring.sources;
  assert.equal(source.id, SOURCE_ID);
  assert.equal(source.kind, 'process');
  assert.equal(source.intervalMs, 5_000);
  assert.equal(typeof source.poll, 'function');
});

test('poll forwards the collector events verbatim and reports the collector cursor', async () => {
  const event = makeCollectorEvent();
  const wiring = makeWiring({
    bindings: [makeBinding({ descriptor: PROCESS_DESCRIPTOR, poll: async () => ({ ok: true, items: [{ outcome: 'published', event }] }) })],
  });
  const result = await wiring.sources[0].poll({ cursor: null, poll_index: 1 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0], event, 'the event object is forwarded by reference, never rebuilt');
  assert.deepEqual(result.cursor, { cursor: { last: 7 }, generation: 0, sequence: 9 });
  assert.equal(result.generation, 0);
  assert.equal(result.sequence, 9);
  assert.doesNotThrow(() => validateTelemetryEvent(result.events[0]), 'the forwarded event must already satisfy the contract');
});

test('duplicate-only items are not forwarded as events', async () => {
  const event = makeCollectorEvent();
  const wiring = makeWiring({
    bindings: [makeBinding({
      descriptor: PROCESS_DESCRIPTOR,
      poll: async () => ({ ok: true, published: 0, duplicates: 1, items: [{ outcome: 'duplicate', event: null }] }),
    })],
  });
  const result = await wiring.sources[0].poll({ cursor: null, poll_index: 1 });
  assert.equal(result.events.length, 0);
  assert.equal(result.empty.code, EMPTY_REASONS.NO_NEW_RECORDS);
  assert.match(result.empty.reason, /already delivered/u);
});

test('every distinct zero-event cause gets its own empty reason', () => {
  assert.equal(emptyReasonFor({ empty: true }).code, EMPTY_REASONS.NO_EVENTS);
  assert.equal(emptyReasonFor({ published: 0, duplicates: 2 }).code, EMPTY_REASONS.NO_NEW_RECORDS);
  assert.equal(emptyReasonFor({ published: 0, dropped: 3 }).code, EMPTY_REASONS.FILTERED_ALL);
  assert.equal(emptyReasonFor({ published: 0, snapshot: true }).code, EMPTY_REASONS.SNAPSHOT_NO_CHANGES);
  assert.equal(emptyReasonFor({ published: 0 }).code, EMPTY_REASONS.NO_NEW_RECORDS);
});

test('a failing collector becomes SOURCE_FAILED carrying the collector code and reason', async () => {
  const wiring = makeWiring({
    bindings: [makeBinding({
      descriptor: PROCESS_DESCRIPTOR,
      poll: async () => {
        throw Object.assign(new Error('Access is denied'), {
          code: 'ACCESS_DENIED',
          details: { stderr: 'UnauthorizedAccessException' },
          remediation: 'Grant Event Log Readers',
        });
      },
    })],
  });
  await assert.rejects(
    () => wiring.sources[0].poll({ cursor: null, poll_index: 1 }),
    (error) => {
      assert.equal(error.code, DAEMON_CODES.SOURCE_FAILED);
      assert.equal(error.details.collector_code, 'ACCESS_DENIED');
      assert.equal(error.details.reason, 'Access is denied');
      assert.equal(error.details.remediation, 'Grant Event Log Readers');
      assert.equal(error.collectorCode, 'ACCESS_DENIED');
      return true;
    },
  );
});

test('a {ok:false} poll result is a failure, not a silent empty batch', async () => {
  const wiring = makeWiring({
    bindings: [makeBinding({
      descriptor: PROCESS_DESCRIPTOR,
      poll: async () => ({ ok: false, code: 'TIMEOUT', error: { code: 'TIMEOUT', message: 'timed out' } }),
    })],
  });
  await assert.rejects(
    () => wiring.sources[0].poll({ cursor: null, poll_index: 1 }),
    (error) => error.code === DAEMON_CODES.SOURCE_FAILED && error.details.collector_code === 'TIMEOUT',
  );
});

test('the first poll seeds the collector cursor from the daemon checkpoint', async () => {
  const cursorStore = createMemoryCursorStore({});
  const wiring = makeWiring({
    bindings: [makeBinding({ descriptor: PROCESS_DESCRIPTOR, poll: async () => ({ ok: true, items: [] }) })],
    cursorStore,
  });
  const seeded = { cursor: { last: 41 }, generation: 2, sequence: 41 };
  await wiring.sources[0].poll({ cursor: seeded, poll_index: 1 });
  assert.deepEqual(cursorStore.load(SOURCE_ID).cursor, seeded.cursor);
  assert.equal(cursorStore.load(SOURCE_ID).generation, 2);
});

test('boot_id is stable across restarts within one boot and changes after a reboot', () => {
  const first = createBootId({ nowMs: 1_700_000_100_000, uptimeSeconds: 100 });
  const same = createBootId({ nowMs: 1_700_000_200_000, uptimeSeconds: 200 });
  const rebooted = createBootId({ nowMs: 1_700_100_000_000, uptimeSeconds: 5 });
  assert.match(first, /^[0-9a-f]{32}$/u);
  assert.equal(first, same);
  assert.notEqual(first, rebooted);
});

test('kind mapping covers the Windows matrix and never guesses a real category from nothing', () => {
  assert.equal(daemonKindFor({ type: 'windows.process' }), 'process');
  assert.equal(daemonKindFor({ type: 'windows.connection' }), 'network');
  assert.equal(daemonKindFor({ type: 'windows.service' }), 'service');
  assert.equal(daemonKindFor({ type: 'windows.event_log' }), 'auth-log');
  assert.equal(daemonKindFor({ type: 'windows.run_key' }), 'persistence');
  assert.equal(daemonKindFor({ type: 'windows.scheduled_task' }), 'persistence');
  assert.equal(daemonKindFor({ type: 'windows.file_metadata' }), 'file');
  assert.equal(daemonKindFor({ type: 'future.mystery', stableSourceId: 'future.x' }), 'synthetic');
});

test('createCollectorDaemonSource refuses a binding without a stable source id', () => {
  assert.throws(
    () => createCollectorDaemonSource({ poll: async () => ({ events: [] }) }),
    (error) => error.code === DAEMON_CODES.SOURCE_INVALID,
  );
});

// ---------------------------------------------------------------------------
// The daemon side: honest per-source state and observable store rejections.
// ---------------------------------------------------------------------------

function makeDaemonConfig(dataDir, overrides = {}) {
  return loadConfig({
    dataDir,
    mode: 'mock',
    detection: {
      rulePack: {
        schemaVersion: '1.0',
        packId: 'a2-wiring-pack',
        packVersion: '1.0.0',
        rules: [
          {
            ruleId: 'proc.suspicious-start',
            version: '1.0.0',
            type: 'condition',
            severity: 'high',
            fields: ['process_name'],
            fingerprint: ['process_name'],
            when: { field: 'process_name', operator: 'eq', value: 'evil.exe' },
          },
        ],
      },
    },
    api: { enabled: false },
    ...overrides,
  });
}

async function waitFor(predicate, { label = 'condition', timeoutMs = 10_000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a quiet source is reported as empty with its reason, never as ok', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'a2-wiring-empty-'));
  const clock = createManualClock(BASE_MS);
  const emptyDescriptor = Object.freeze({ stableSourceId: 'windows.run-key', type: 'windows.run_key', kind: 'poll', intervalMs: 60_000 });
  const logger = makeLogger();
  const wiring = makeWiring({
    bindings: [makeBinding({
      descriptor: emptyDescriptor,
      poll: async () => ({ ok: true, published: 0, snapshot: true, items: [] }),
    })],
    logger,
  });
  const daemon = createDaemon({ config: makeDaemonConfig(dir), sources: [...wiring.sources], logger, clock });
  t.after(async () => daemon.shutdown('test'));
  await daemon.start();
  await waitFor(() => daemon.status().scheduler.status()[0]?.polls > 0, { label: 'first poll' });
  await waitFor(
    () => daemon.status().scheduler.status()[0]?.lifecycle === 'empty',
    { label: 'empty lifecycle' },
  );

  const status = daemon.status();
  const row = status.scheduler.status()[0];
  assert.equal(row.lifecycle, 'empty');
  assert.equal(row.last_empty_code, EMPTY_REASONS.SNAPSHOT_NO_CHANGES);
  assert.match(row.last_empty_reason, /no entity changed/u);
  assert.equal(status.counters.sources_empty, 1);
  // A quiet source is not a degradation; the reason is what matters.
  assert.equal(daemon.health().status, 'ok');
  assert.ok(logger.entries.some((entry) => entry.message === 'collector source empty' && entry.source_id === 'windows.run-key'));
});

test('a failing source is reported as unavailable with the collector code', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'a2-wiring-unavailable-'));
  const clock = createManualClock(BASE_MS);
  const descriptor = Object.freeze({ stableSourceId: 'windows.event-log.security', type: 'windows.event_log', kind: 'event', intervalMs: 30_000 });
  const logger = makeLogger();
  const wiring = makeWiring({
    bindings: [makeBinding({
      descriptor,
      poll: async () => {
        throw Object.assign(new Error('Attempted to perform an unauthorized operation'), { code: 'ACCESS_DENIED' });
      },
    })],
    logger,
  });
  const daemon = createDaemon({ config: makeDaemonConfig(dir), sources: [...wiring.sources], logger, clock });
  t.after(async () => daemon.shutdown('test'));
  await daemon.start();
  await waitFor(() => daemon.status().scheduler.status()[0]?.lifecycle === 'unavailable', { label: 'unavailable lifecycle' });

  const status = daemon.status();
  const row = status.scheduler.status()[0];
  assert.equal(row.lifecycle, 'unavailable');
  assert.equal(row.last_error_code, 'ACCESS_DENIED', 'the collector code is not hidden behind SOURCE_FAILED');
  assert.equal(status.counters.sources_unavailable, 1);
  assert.equal(daemon.health().status, 'degraded', 'a denied channel degrades health (design §5.1)');
  assert.ok(logger.entries.some((entry) => entry.message === 'collector source unavailable'));
});

test('a store rejection is counted and its reason is logged', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'a2-wiring-store-'));
  const clock = createManualClock(BASE_MS);
  const memory = createMemoryEventStoreAdapter({ clock });
  memory.open();
  const rejecting = Object.create(memory);
  Object.defineProperty(rejecting, 'ingest', {
    value: () => {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'event store ingest failed', { reason: 'ERR_NULL_NOT_ALLOWED' });
    },
    enumerable: false,
  });

  const logger = makeLogger();
  const wiring = makeWiring({
    bindings: [makeBinding({
      descriptor: PROCESS_DESCRIPTOR,
      poll: async () => ({ ok: true, items: [{ outcome: 'published', event: makeCollectorEvent() }] }),
    })],
    logger,
  });
  const daemon = createDaemon({ config: makeDaemonConfig(dir), sources: [...wiring.sources], store: rejecting, logger, clock });
  t.after(async () => daemon.shutdown('test'));
  await daemon.start();
  await waitFor(() => daemon.status().counters.rejected_by_store >= 1, { label: 'a rejected write' });

  const status = daemon.status();
  assert.ok(status.counters.rejected_by_store >= 1);
  const rejection = logger.entries.find((entry) => entry.message === 'event store rejected a write');
  assert.ok(rejection, 'the rejection must be logged');
  assert.equal(rejection.reason, 'ERR_NULL_NOT_ALLOWED');
  assert.equal(rejection.code, 'STORE_WRITE_FAILED');
});

test('a healthy wired source stores events and keeps health ok', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'a2-wiring-healthy-'));
  const clock = createManualClock(BASE_MS);
  const wiring = makeWiring({
    bindings: [makeBinding({
      descriptor: PROCESS_DESCRIPTOR,
      poll: async () => ({ ok: true, items: [{ outcome: 'published', event: makeCollectorEvent() }] }),
    })],
  });
  const daemon = createDaemon({ config: makeDaemonConfig(dir), sources: [...wiring.sources], logger: makeLogger(), clock });
  t.after(async () => daemon.shutdown('test'));
  await daemon.start();
  await waitFor(() => daemon.status().store.stats().events > 0, { label: 'one stored event' });

  const status = daemon.status();
  assert.equal(status.counters.rejected_by_store, 0);
  assert.ok(status.store.stats().events > 0);
  assert.equal(status.health.status, 'ok');
  assert.equal(status.scheduler.status()[0].lifecycle, 'ok');
  assert.equal(status.counters.rejected_by_store, 0);
});

// ---------------------------------------------------------------------------
// --collectors spec validation.
// ---------------------------------------------------------------------------

test('a collector spec is a closed document with resolved module paths', () => {
  const spec = parseCollectorSpec({
    collectorModule: 'packages/collectors/windows/index.js',
    commonModule: 'packages/collectors/common/index.js',
    options: { include: ['processes'] },
  }, { baseDir: 'C:\\repo' });
  assert.equal(spec.collectorModule, 'C:\\repo\\packages\\collectors\\windows\\index.js');
  assert.equal(spec.createSources, 'createWindowsSources');
  assert.equal(spec.attachSources, 'attachWindowsSources');
  assert.equal(spec.createRuntime, 'createCollectorRuntime');
  assert.deepEqual(spec.options, { include: ['processes'] });
  assert.equal(spec.bootId, null);

  assert.throws(
    () => parseCollectorSpec({ collectorModule: 'a.js', commonModule: 'b.js', extra: true }),
    (error) => error.code === DAEMON_CODES.CONFIG_INVALID,
  );
  assert.throws(
    () => parseCollectorSpec({ collectorModule: 'a.js' }),
    (error) => error.code === DAEMON_CODES.CONFIG_INVALID,
  );
  assert.throws(
    () => parseCollectorSpec({ collectorModule: 'a.js', commonModule: 'b.js', createSources: 'not a name' }),
    (error) => error.code === DAEMON_CODES.CONFIG_INVALID,
  );
});

test('a collector spec file is read from disk and resolves relative to itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2-wiring-spec-'));
  const file = join(dir, 'collectors.json');
  writeFileSync(file, JSON.stringify({
    collectorModule: './platform/index.js',
    commonModule: './common/index.js',
    bootId: '0123456789abcdef0123456789abcdef',
  }));
  const spec = loadCollectorSpec(file);
  assert.equal(spec.collectorModule, join(dir, 'platform', 'index.js'));
  assert.equal(spec.bootId, '0123456789abcdef0123456789abcdef');
});

test('createCollectorSources refuses to start without a boot id', () => {
  assert.throws(
    () => createCollectorSources({
      createSources: () => [],
      attachSources: () => [],
      createRuntime: () => ({}),
      cursorStore: createMemoryCursorStore({}),
      bootId: null,
    }),
    (error) => error.code === DAEMON_CODES.CONFIG_INVALID,
  );
});





