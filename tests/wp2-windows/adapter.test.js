import assert from 'node:assert/strict';
import test from 'node:test';

import { WINDOWS_ERROR_CODES, WindowsCollectorError, createSourceBinding } from '../../packages/collectors/windows/index.js';
import { createEventLogSource, createProcessSource, PROCESS_DESCRIPTOR } from '../../packages/collectors/windows/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';
import { createClock, createScriptedPowerShell, createTestCollector } from './helpers.js';

const BASE = 1_700_000_000_000;

function record(nativeRecordId, payload = { pid: 1 }) {
  return {
    nativeRecordId,
    type: 'windows.process',
    severity: 'info',
    observedAt: BASE,
    payload: { ...payload, change: 'snapshot' },
  };
}

/** A source stub whose read result the test controls. */
function stubSource({ read, descriptor = PROCESS_DESCRIPTOR, probe = null }) {
  return {
    descriptor,
    ...(probe === null ? {} : { probe }),
    read,
  };
}

function sandboxFor(t) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-adapter-' });
  t.after(sandbox.cleanup);
  return sandbox;
}

test('a successful poll publishes, commits and leaves the source ready', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability, store } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  const binding = createSourceBinding({
    source: stubSource({ read: async () => ({ records: [record('pid-1')], nextCursor: null, identity: null, reset: null, snapshot: true, truncated: false }) }),
    collector,
    clock,
  });

  const result = await binding.poll();

  assert.equal(result.ok, true);
  assert.equal(result.published, 1);
  assert.equal(result.snapshot, true);
  assert.equal(capability.snapshot().lifecycle, 'ready');
  assert.notEqual(store.load('windows.process-table'), null, 'the cursor must be durable after a commit');
});

test('publishing is not enough: nothing is durable until commit, and a poll always commits', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, store } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  const commits = [];
  const wrapped = {
    ...collector,
    commit(result) {
      commits.push(result.published);
      return collector.commit(result);
    },
  };
  const binding = createSourceBinding({
    source: stubSource({ read: async () => ({ records: [record('pid-2')], nextCursor: null, identity: null, reset: null, snapshot: true, truncated: false }) }),
    collector: wrapped,
    clock,
  });

  await binding.poll();
  assert.deepEqual(commits, [1]);
  assert.notEqual(store.load('windows.process-table'), null);
});

test('a denied permission latches the source as unavailable instead of reporting zero events', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });
  const denied = new WindowsCollectorError(WINDOWS_ERROR_CODES.ACCESS_DENIED, 'Access is denied');

  const binding = createSourceBinding({
    source: stubSource({ read: async () => { throw denied; } }),
    collector,
    clock,
  });

  const result = await binding.poll();

  assert.equal(result.ok, false);
  assert.equal(result.code, WINDOWS_ERROR_CODES.ACCESS_DENIED);
  const snapshot = capability.snapshot();
  assert.equal(snapshot.lifecycle, 'unavailable');
  assert.equal(snapshot.lastError.code, 'permission_denied');
  assert.match(snapshot.lastError.remediation, /Event Log Readers|read access/u);
});

test('a timeout degrades the source without latching it unavailable', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  const binding = createSourceBinding({
    source: stubSource({ read: async () => { throw new WindowsCollectorError(WINDOWS_ERROR_CODES.TIMEOUT, 'timed out'); } }),
    collector,
    clock,
  });

  const result = await binding.poll();
  assert.equal(result.ok, false);
  const snapshot = capability.snapshot();
  assert.equal(snapshot.declaredLifecycle, 'degraded');
  assert.equal(snapshot.lastError.code, WINDOWS_ERROR_CODES.TIMEOUT);
});

test('a programming error is rethrown so a bug cannot be mistaken for an unhealthy host', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  const binding = createSourceBinding({
    source: stubSource({ read: async () => { throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'bug'); } }),
    collector,
    clock,
  });

  await assert.rejects(() => binding.poll(), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT);
});

test('a log_cleared reset advances the generation before the new records are published', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.event-log.security', kind: 'event', intervalMs: 30_000 },
    clock,
  });

  const powershell = createScriptedPowerShell({
    'event-log': (script) => {
      const after = Number(/\$after = (\d+)/u.exec(script)[1]);
      if (after === 500) {
        return { newestRecordId: 2, events: [] };
      }
      return {
        newestRecordId: 2,
        events: [
          { recordId: 1, timeCreated: `/Date(${BASE})/`, eventId: 1, level: 2, provider: 'p', message: 'm' },
          { recordId: 2, timeCreated: `/Date(${BASE + 1})/`, eventId: 1, level: 2, provider: 'p', message: 'm' },
        ],
      };
    },
  });
  const source = createEventLogSource({ powershell, channel: 'Security', clock });

  // Seed the persisted cursor at record 500 in generation 0.
  const seeded = collector.publish({
    records: [{
      nativeRecordId: '500',
      type: 'windows.event_log',
      severity: 'info',
      observedAt: BASE,
      payload: { channel: 'Security', record_id: 500, change: 'snapshot' },
    }],
    nextCursor: { channel: 'Security', lastRecordId: 500, generation: 0, lastObservedAt: BASE },
  });
  collector.commit(seeded);
  assert.equal(collector.identity().generation, 0);

  const binding = createSourceBinding({ source, collector, clock });
  const result = await binding.poll();

  assert.equal(result.ok, true);
  assert.equal(result.generation, 1, 'the batch must be published under the new generation');
  assert.equal(collector.identity().generation, 1);
  assert.equal(collector.identity().cursor.generation, 1);
  assert.deepEqual(result.items.map((entry) => entry.event.source_generation), [1, 1]);
  assert.equal(collector.snapshot().lastGap.reason, 'generation_reset');
});

test('a commit failure is reported and the source is degraded, not silently healthy', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const store = {
    load: () => null,
    commit: () => { throw Object.assign(new Error('disk full'), { code: 'CURSOR_STORE_IO' }); },
  };
  const collector = (await import('../../packages/collectors/common/index.js')).createSourceCollector({
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    store,
    clock,
    bootId: '00112233445566778899aabbccddeeff',
  });

  const binding = createSourceBinding({
    source: stubSource({ read: async () => ({ records: [record('pid-3')], nextCursor: null, identity: null, reset: null, snapshot: true, truncated: false }) }),
    collector,
    clock,
  });

  const result = await binding.poll();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CURSOR_STORE_IO');
  assert.equal(collector.snapshot().lifecycle, 'degraded');
});

test('a second poll while the first is still reading is skipped instead of double reading', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const binding = createSourceBinding({
    source: stubSource({
      read: async () => {
        reads += 1;
        await gate;
        return { records: [], nextCursor: null, identity: null, reset: null, snapshot: true, truncated: false };
      },
    }),
    collector,
    clock,
  });

  const first = binding.poll();
  const second = await binding.poll();
  release();
  await first;

  assert.equal(second.skipped, true);
  assert.equal(reads, 1);
});

test('an empty event channel is a healthy empty read and never overwrites the cursor', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.event-log.security', kind: 'event', intervalMs: 30_000 },
    clock,
  });

  // Seed a real persisted cursor first. Without it `identity().cursor` is null before the poll
  // and stays null whatever the empty-read path does — the assertion below used to be vacuously
  // true and could not fail even if the empty read wrote `nextCursor: null`.
  const seeded = collector.publish({
    records: [{
      nativeRecordId: '500',
      type: 'windows.event_log',
      severity: 'info',
      observedAt: BASE,
      payload: { channel: 'Security', record_id: 500, change: 'snapshot' },
    }],
    nextCursor: { channel: 'Security', lastRecordId: 500, generation: 0, lastObservedAt: BASE },
  });
  collector.commit(seeded);
  assert.equal(collector.identity().cursor.lastRecordId, 500);

  const binding = createSourceBinding({
    source: stubSource({
      descriptor: (await import('../../packages/collectors/windows/index.js')).describeEventLog('Security'),
      read: async () => { throw new WindowsCollectorError(WINDOWS_ERROR_CODES.NO_EVENTS, 'no events were found'); },
    }),
    collector,
    clock,
  });

  const result = await binding.poll();
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.deepEqual(
    collector.identity().cursor,
    { channel: 'Security', lastRecordId: 500, generation: 0, lastObservedAt: BASE },
    'an empty read must not clear a persisted cursor',
  );
  assert.equal(capability.snapshot().lastError, null, 'an idle channel is not an error');
});

test('the subscription probe drives freshness for an event source', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.event-log.security', kind: 'event', intervalMs: 30_000 },
    clock,
  });

  const descriptor = (await import('../../packages/collectors/windows/index.js')).describeEventLog('Security');
  const binding = createSourceBinding({
    source: stubSource({ descriptor, read: async () => ({ records: [], nextCursor: null, identity: null, reset: null, snapshot: false, truncated: false }), probe: async () => ({ ok: true, errorCode: null }) }),
    collector,
    clock,
  });

  const probe = await binding.probe();
  assert.equal(probe.ok, true);
  assert.equal(capability.snapshot().freshness, 'fresh');
});

test('a truncated read is degraded and visible, not reported as healthy', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  const binding = createSourceBinding({
    source: stubSource({
      read: async () => ({
        records: [record('pid-4')],
        nextCursor: null,
        identity: null,
        reset: null,
        snapshot: false,
        truncated: true,
      }),
    }),
    collector,
    clock,
  });

  const result = await binding.poll();

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  const snapshot = capability.snapshot();
  assert.equal(snapshot.declaredLifecycle, 'degraded');
  assert.equal(snapshot.lastError.code, 'source_truncated');
  assert.equal(binding.stats().truncated, 1);
});

test('a partial read never un-latches a real permission denial', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  let mode = 'denied';
  const binding = createSourceBinding({
    source: stubSource({
      read: async () => {
        if (mode === 'denied') {
          throw new WindowsCollectorError(WINDOWS_ERROR_CODES.ACCESS_DENIED, 'Access is denied');
        }
        return {
          records: [record('pid-5')],
          nextCursor: null,
          identity: null,
          reset: null,
          snapshot: false,
          truncated: false,
          degradedFields: ['image_path'],
        };
      },
    }),
    collector,
    clock,
  });

  await binding.poll();
  assert.equal(capability.snapshot().lifecycle, 'unavailable');

  mode = 'partial';
  const second = await binding.poll();
  assert.equal(second.ok, true);
  assert.deepEqual([...second.degradedFields], ['image_path']);
  // The earlier implementation called setPermissions({missing: []}) here, and the common
  // layer clears `fatalError` when `missing` is empty — a partial read would have promoted an
  // unavailable source back to healthy.
  assert.equal(capability.snapshot().lifecycle, 'unavailable', 'a partial read must not clear a permission latch');
});

test('a failed publish after a generation advance leaves the cursor replayable', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const store = {
    // Seeded at generation 0 with a live cursor, which is the realistic state of a source that
    // has already been read at least once (a fresh store's first advance stays at 0).
    state: {
      stableSourceId: 'windows.event-log.security',
      generation: 0,
      cursor: { channel: 'Security', lastRecordId: 500, generation: 0, lastObservedAt: BASE },
      sequence: 500,
      recentKeys: [],
    },
    load() { return this.state; },
    commit(entry) { this.state = { ...entry, recentKeys: [] }; return this.state; },
    advanceGeneration({ stableSourceId, reason, cursor = null }) {
      // The cursor argument must be honoured, otherwise this regression test cannot fail when
      // the adapter goes back to persisting the new-generation position before publishing.
      this.state = {
        stableSourceId,
        generation: this.state.generation + 1,
        cursor,
        sequence: -1,
        reason,
        recentKeys: [],
      };
      return this.state;
    },
  };
  const common = await import('../../packages/collectors/common/index.js');
  // A queue that refuses every record makes `publish` throw ADAPTER_DEGRADED, which is an
  // operational failure (not a programming error) and therefore the case the adapter must
  // survive without leaving a half-committed generation behind.
  const collector = common.createSourceCollector({
    source: { stableSourceId: 'windows.event-log.security', kind: 'event', intervalMs: 30_000 },
    store,
    queue: { admit() { throw new Error('queue unavailable'); }, stats: () => ({}) },
    clock,
    bootId: '00112233445566778899aabbccddeeff',
  });

  const binding = createSourceBinding({
    source: stubSource({
      descriptor: (await import('../../packages/collectors/windows/index.js')).describeEventLog('Security'),
      read: async () => ({
        records: [{
          nativeRecordId: '2',
          type: 'windows.event_log',
          severity: 'info',
          observedAt: BASE,
          payload: { channel: 'Security', record_id: 2 },
        }],
        nextCursor: { channel: 'Security', lastRecordId: 2, generation: 1, lastObservedAt: BASE },
        identity: null,
        reset: { reason: 'log_cleared', gapStart: BASE, gapEnd: BASE + 1 },
        snapshot: false,
        truncated: false,
      }),
    }),
    collector,
    clock,
  });

  const result = await binding.poll();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADAPTER_DEGRADED');
  assert.equal(collector.identity().generation, 1);
  assert.equal(store.state.cursor, null, 'the cursor must stay replayable when the batch was never published');
});

test('attachWindowsSources registers every source with the runtime', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { createCollectorRuntime } = await import('../../packages/collectors/common/index.js');
  const { createCursorStore } = await import('../../packages/collectors/common/index.js');
  const windows = await import('../../packages/collectors/windows/index.js');

  const runtime = createCollectorRuntime({
    store: createCursorStore({ directory: sandbox.workRoot, clock }),
    clock,
  });
  const sources = windows.createWindowsSources({
    include: ['processes', 'services', 'runKeys'],
    powershell: {
      async runJson(script) {
        if (script.includes('aegis-source:processes')) return [];
        if (script.includes('aegis-source:services')) return [];
        return [];
      },
    },
    clock,
  });

  const bindings = windows.attachWindowsSources({ runtime, sources });
  assert.equal(bindings.length, 3);
  assert.deepEqual(
    bindings.map((entry) => entry.descriptor.stableSourceId).sort(),
    ['windows.process-table', 'windows.run-key', 'windows.service-table'],
  );

  for (const binding of bindings) {
    const result = await binding.binding.poll();
    assert.equal(result.ok, true, binding.name);
  }

  const report = runtime.report();
  assert.equal(report.sources.length, 3);
  assert.deepEqual([...report.degraded], []);
});

test('a successful batch after a reset persists the new-generation cursor', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const store = {
    state: {
      stableSourceId: 'windows.event-log.security',
      generation: 0,
      cursor: { channel: 'Security', lastRecordId: 500, generation: 0, lastObservedAt: BASE },
      sequence: 500,
      recentKeys: [],
    },
    load() { return this.state; },
    commit(entry) { this.state = { ...entry, recentKeys: [] }; return this.state; },
    advanceGeneration({ stableSourceId, reason, cursor = null }) {
      this.state = {
        stableSourceId,
        generation: this.state.generation + 1,
        cursor,
        sequence: -1,
        reason,
        recentKeys: [],
      };
      return this.state;
    },
  };
  const common = await import('../../packages/collectors/common/index.js');
  const collector = common.createSourceCollector({
    source: { stableSourceId: 'windows.event-log.security', kind: 'event', intervalMs: 30_000 },
    store,
    clock,
    bootId: '00112233445566778899aabbccddeeff',
  });

  const binding = createSourceBinding({
    source: stubSource({
      descriptor: (await import('../../packages/collectors/windows/index.js')).describeEventLog('Security'),
      read: async () => ({
        records: [{
          nativeRecordId: '1',
          type: 'windows.event_log',
          severity: 'info',
          observedAt: BASE,
          payload: { channel: 'Security', record_id: 1 },
        }],
        nextCursor: { channel: 'Security', lastRecordId: 1, generation: 1, lastObservedAt: BASE },
        identity: null,
        reset: { reason: 'log_cleared', gapStart: BASE, gapEnd: BASE + 1 },
        snapshot: false,
        truncated: false,
      }),
    }),
    collector,
    clock,
  });

  const result = await binding.poll();

  assert.equal(result.ok, true);
  assert.equal(store.state.generation, 1);
  // The cursor written by `commit` must come from `nextCursor`, which is what makes the
  // null-on-advance design safe: the position is only persisted together with the batch.
  assert.equal(store.state.cursor.generation, 1);
  assert.equal(store.state.cursor.lastRecordId, 1);
});

test('a source that returns a non-object is a bug and never reaches publish', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability, store } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  const binding = createSourceBinding({
    source: stubSource({ read: async () => null }),
    collector,
    clock,
  });

  await assert.rejects(() => binding.poll(), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_RECORD);
  assert.equal(store.load('windows.process-table'), null);
});

test('a real process source can be bound end to end with a synthetic table', async (t) => {
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  const powershell = createScriptedPowerShell({
    processes: [{
      ProcessId: 4,
      ParentProcessId: 0,
      Name: 'System',
      ExecutablePath: null,
      CommandLine: null,
      CreationDate: `/Date(${BASE})/`,
    }],
  });
  const source = createProcessSource({ powershell, clock });
  const binding = createSourceBinding({ source, collector, clock });

  const result = await binding.poll();

  assert.equal(result.ok, true);
  assert.equal(result.published, 1);
  const event = result.items[0].event;
  assert.equal(event.type, 'windows.process');
  assert.equal(event.payload.pid, 4);
  assert.equal(event.payload.present, true);
  assert.deepEqual([...result.degradedFields], ['image_path', 'command_line']);
});

test('rows the source could not identify are surfaced as skippedRows instead of vanishing', async (t) => {
  // `adapter.js` has always mapped `collected.skippedRows` onto the poll result, but nothing
  // asserted it: an event-log record with an unusable record id could disappear from every
  // counter without a single test noticing.
  const sandbox = sandboxFor(t);
  const clock = createClock(BASE);
  const { collector } = createTestCollector({
    sandbox,
    source: { stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 },
    clock,
  });

  const binding = createSourceBinding({
    source: stubSource({
      read: async () => ({
        records: [record('pid-7')],
        nextCursor: null,
        identity: null,
        reset: null,
        snapshot: false,
        truncated: false,
        skippedRows: 3,
      }),
    }),
    collector,
    clock,
  });

  const result = await binding.poll();
  assert.equal(result.ok, true);
  assert.equal(result.published, 1);
  assert.equal(result.skippedRows, 3);

  // A non-integer count is not a number the adapter can trust; it degrades to 0 instead of
  // leaking `NaN` or a string into the caller's counters.
  const loose = createSourceBinding({
    source: stubSource({
      read: async () => ({ records: [], nextCursor: null, identity: null, reset: null, snapshot: false, skippedRows: 2.5 }),
    }),
    collector,
    clock,
  });
  const second = await loose.poll();
  assert.equal(second.skippedRows, 0);
});
