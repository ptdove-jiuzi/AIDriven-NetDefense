/**
 * helpers.js — shared fixtures for the WP5 daemon tests.
 *
 * Discipline, same as the other work packages:
 *
 * 1. **One temporary directory per test**, removed once every handle is closed.
 *    Directory removal is registered at *file* level (`after`) rather than per
 *    test: `node:test` runs `t.after` hooks in registration order, and on Windows
 *    a directory removed before the SQLite handle closes fails with EPERM.
 * 2. **No real user data.** Every event is synthetic, every path is under the
 *    temporary directory, and no test reads `%USERPROFILE%`, an event log or a real
 *    database.
 * 3. **No sleeping for correctness.** Time is injected. The only real timers used
 *    are the ones the daemon itself owns (poll timeouts), and those tests assert on
 *    outcomes that are deliberately independent of exact scheduling.
 */

import assert from 'node:assert/strict';
import { after } from 'node:test';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalDigest } from '../../packages/contracts/src/index.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { createMemoryEventStoreAdapter, createEventStoreAdapter } from '../../apps/daemon/src/adapters/event-store.js';
import { createScriptedSource } from '../../apps/daemon/src/adapters/collector.js';
import { createPipeline } from '../../apps/daemon/src/pipeline.js';
import { createScheduler } from '../../apps/daemon/src/scheduler.js';
import { createDetectionEngine, validateRulePack } from '../../packages/detection/index.js';
import { loadConfig } from '../../apps/daemon/src/config.js';
import { openStore } from '../../packages/event-store/src/index.js';
import { DaemonError, DAEMON_CODES } from '../../apps/daemon/src/errors.js';

export const BASE_MS = Date.UTC(2026, 10, 2, 0, 0, 0);
export const BASE_ISO = '2026-11-02T00:00:00.000Z';
export const TEST_TOKEN = 'wp5-test-token-0123456789abcdefghij';
export const TEST_EPOCH = '3f7c1a9e-6b2d-4c8f-9a01-2b3c4d5e6f70';

const TEMP_DIRS = new Set();

/**
 * Create a temporary directory removed at the end of the test file.
 *
 * @returns {string} Absolute temporary directory.
 */
export function makeTempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'aegisharness-wp5-'));
  TEMP_DIRS.add(directory);
  return directory;
}

after(() => {
  for (const directory of TEMP_DIRS) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A leaked handle on Windows must not fail an otherwise passing suite; the
      // directory lives under the OS temp root and is cleaned by the OS.
    }
  }
  TEMP_DIRS.clear();
});

/**
 * Snapshot a directory tree (relative path → size + mtime) for "nothing changed"
 * assertions.
 *
 * @param {string} root Directory to snapshot.
 * @returns {Record<string, string>} Snapshot.
 */
export function snapshotTree(root) {
  const output = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        output[`${full}:dir`] = '';
        walk(full);
        continue;
      }
      const stats = statSync(full);
      output[full] = `${stats.size}:${stats.mtimeMs}`;
    }
  };
  walk(root);
  return output;
}

/**
 * Build a contract-valid telemetry event.
 *
 * @param {object} [overrides] Field overrides.
 * @returns {object} Telemetry event value.
 */
export function makeEvent(overrides = {}) {
  const payload = overrides.payload ?? { process_name: 'evil.exe', pid: 4242 };
  const sequence = overrides.source_seq ?? 1;
  return {
    schemaVersion: '1.0',
    event_id: overrides.event_id ?? randomUUID(),
    stable_source_id: overrides.stable_source_id ?? 'synthetic.process',
    collector_instance_id: overrides.collector_instance_id ?? randomUUID(),
    source_generation: overrides.source_generation ?? 1,
    boot_id: overrides.boot_id ?? 'a'.repeat(32),
    source_seq: sequence,
    observed_at: overrides.observed_at ?? BASE_ISO,
    received_at: overrides.received_at ?? new Date(BASE_MS + 1000).toISOString(),
    type: overrides.type ?? 'process.start',
    severity: overrides.severity ?? 'high',
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
    ...(overrides.native_record_id === undefined ? {} : { native_record_id: overrides.native_record_id }),
  };
}

/**
 * Build a rule pack whose single rule matches `process_name === 'evil.exe'`.
 *
 * @param {object} [overrides] Pack overrides.
 * @returns {object} Rule pack value (not yet compiled).
 */
export function makeRulePack(overrides = {}) {
  return {
    schemaVersion: '1.0',
    packId: 'wp5-test-pack',
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
    ...overrides,
  };
}

/**
 * Build a validated daemon configuration for a temporary directory.
 *
 * @param {string} dataDir Temporary data directory.
 * @param {object} [overrides] Configuration overrides (shallow merged by section).
 * @returns {object} Frozen configuration.
 */
export function makeConfig(dataDir, overrides = {}) {
  return loadConfig({
    dataDir,
    mode: 'mock',
    detection: { rulePack: overrides.rulePack ?? makeRulePack() },
    api: { port: 0, token: TEST_TOKEN, ...(overrides.api ?? {}) },
    scheduler: { tickMs: 3600000, ...(overrides.scheduler ?? {}) },
    logging: { level: 'silent' },
    ...(overrides.top ?? {}),
  });
}

/**
 * Build a detection engine over the test rule pack with a manual clock.
 *
 * @param {object} clock Manual clock.
 * @param {object} [pack] Rule pack.
 * @returns {object} Engine handle.
 */
export function makeEngine(clock, pack = makeRulePack()) {
  return createDetectionEngine({
    rulePack: validateRulePack(pack),
    clock: { now: () => clock.nowMs() },
    cpuClock: { now: () => 0 },
  });
}

/**
 * Build a memory store adapter with a manual clock.
 *
 * @param {object} clock Manual clock.
 * @returns {object} Store adapter.
 */
export function makeStore(clock) {
  const store = createMemoryEventStoreAdapter({ clock });
  store.open();
  return store;
}

/**
 * Assemble store + detection + pipeline without a daemon, for focused tests.
 *
 * @param {object} [options] Options.
 * @returns {{clock: object, store: object, pipeline: object, engine: object}} Parts.
 */
export function makePipelineParts(options = {}) {
  const clock = options.clock ?? createManualClock(BASE_MS);
  const store = options.store ?? makeStore(clock);
  const engine = options.engine ?? makeEngine(clock);
  const pipeline = createPipeline({
    store,
    detection: engine,
    createDetection: options.createDetection,
    epoch: options.epoch ?? TEST_EPOCH,
    allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
    budgetClass: 'standard',
    alertStatus: 'new',
    clock,
    logger: options.logger,
  });
  return { clock, store, pipeline, engine };
}

/**
 * Assemble a scheduler over a pipeline with scripted sources.
 *
 * @param {object} options Options.
 * @returns {{clock: object, store: object, pipeline: object, scheduler: object}} Parts.
 */
export function makeSchedulerParts(options) {
  const parts = makePipelineParts(options);
  const clock = parts.clock;
  const scheduler = createScheduler({
    sources: options.sources,
    pipeline: parts.pipeline,
    clock,
    tickMs: options.tickMs ?? 1000,
    sourceTimeoutMs: options.sourceTimeoutMs ?? 5000,
    maxBatchEvents: options.maxBatchEvents ?? 100,
    staleAfterMs: options.staleAfterMs ?? 30000,
    maxSources: 32,
    cursors: options.cursors,
    onCursor: options.onCursor,
    logger: options.logger,
  });
  return { ...parts, scheduler };
}

export { createScriptedSource, createManualClock, createMemoryEventStoreAdapter, loadConfig };

/**
 * Open a real SQLite store + pipeline on a file, with write-failure injection.
 *
 * Same shape as `makePipelineParts`, but the store is the real adapter (so the durable
 * contribution spool of ADR-0007 is exercised) and `store.ingest` is wrapped so a test can
 * make specific `source_seq` fail. Reopening the same file with a fresh call models a
 * process restart: the spool rows are the only thing that survives.
 *
 * @param {string} file Database path.
 * @param {object} clock Manual clock.
 * @param {{pack?: object, engineFactory?: () => object}} [options] Options.
 * @returns {Promise<{store: object, pipeline: object, injected: object, violations: object[], trace: number[]}>} Parts.
 */
export async function openRealPipeline(file, clock, options = {}) {
  const store = createEventStoreAdapter({
    path: file,
    clock,
    allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
  });
  await store.open();

  const pipeline = createPipeline({
    store,
    detection: makeEngine(clock, options.pack),
    createDetection: () => (options.engineFactory ?? makeEngine)(clock, options.pack),
    epoch: TEST_EPOCH,
    allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
    budgetClass: 'standard',
    alertStatus: 'new',
    clock,
  });

  const written = new Set();
  const violations = [];
  const trace = [];
  const injected = { failSeqs: new Set(), calls: 0 };
  const ingest = store.ingest.bind(store);
  store.ingest = (request) => {
    injected.calls += 1;
    trace.push(request.event.source_seq);
    // Every T1 call must only cite events that are already stored or are this call's own event.
    // "Already stored" is asked of the store, not of this process's bookkeeping: after a restart
    // the events written by the previous process are exactly the ones a retained contribution
    // legitimately cites.
    for (const alert of request.alerts ?? []) {
      for (const id of alert.event_ids ?? []) {
        if (id === request.event.event_id || written.has(id)) {
          continue;
        }
        let stored = false;
        try {
          stored = store.hasEvent(id) === true;
        } catch {
          stored = false;
        }
        if (!stored) {
          violations.push({ source_seq: request.event.source_seq, cited: id });
        }
      }
    }
    if (injected.failSeqs.has(request.event.source_seq)) {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure');
    }
    const result = ingest(request);
    if (result.duplicate !== true) {
      written.add(request.event.event_id);
    }
    return result;
  };

  return { store, pipeline, injected, violations, trace };
}

/**
 * Read events and alerts through a read-only handle (never the writer).
 *
 * @param {string} file Database path.
 * @param {object} clock Clock for the handle.
 * @returns {{events: object[], alerts: object[]}} Snapshot.
 */
export function readEvidence(file, clock) {
  const handle = openStore({ path: file, readOnly: true, clock });
  try {
    const events = handle.all('SELECT event_id, source_seq, observed_at FROM telemetry_event').map((row) => ({
      event_id: String(row.event_id),
      source_seq: Number(row.source_seq),
      observed_at: String(row.observed_at),
    }));
    const alerts = handle.all(
      'SELECT alert_id, fingerprint, window_start, window_end, count, event_ids_json, event_ids_truncated FROM alert ORDER BY window_start, fingerprint',
    ).map((row) => ({
      alert_id: String(row.alert_id),
      fingerprint: String(row.fingerprint),
      window_start: String(row.window_start),
      window_end: String(row.window_end),
      count: Number(row.count),
      truncated: Number(row.event_ids_truncated) === 1,
      event_ids: JSON.parse(String(row.event_ids_json)),
    }));
    return { events, alerts };
  } finally {
    handle.close();
  }
}

/**
 * The ADR-0007 invariants, checked against a snapshot.
 *
 * I1 `truncated=false ⇒ count == stored events in that window`
 * I2 every `event_id` resolves to a stored event
 * plus the derived rules: no duplicate ids, `truncated` iff `count > ids`.
 *
 * @param {{events: object[], alerts: object[]}} snapshot Snapshot.
 * @param {string} label Assertion prefix.
 * @returns {void}
 */
export function assertCountsFollowEvidence(snapshot, label) {
  const stored = new Set(snapshot.events.map((entry) => entry.event_id));
  for (const alert of snapshot.alerts) {
    assert.equal(
      new Set(alert.event_ids).size,
      alert.event_ids.length,
      `${label}: 告警 ${alert.window_start} 的证据 id 不得重复`,
    );
    for (const id of alert.event_ids) {
      assert.ok(stored.has(id), `${label}: 证据 ${id} 必须能在事件表里查到`);
    }
    assert.equal(
      alert.truncated,
      alert.count > alert.event_ids.length,
      `${label}: truncated 必须当且仅当 count 大于证据条数`,
    );
    if (alert.truncated === false) {
      assert.equal(alert.count, alert.event_ids.length, `${label}: 未截断时 count 必须等于证据条数`);
    }
    const inWindow = snapshot.events.filter(
      (entry) => entry.observed_at >= alert.window_start && entry.observed_at < alert.window_end,
    );
    assert.equal(
      alert.count,
      inWindow.length,
      `${label}: 窗口 ${alert.window_start} 的 count 必须等于该窗口已入库事件数`,
    );
  }
}

/**
 * Issue one HTTP request and decode a JSON body.
 *
 * @param {number} port Bound port.
 * @param {string} pathname Request path.
 * @param {{method?: string, headers?: Record<string, string>, body?: string}} [options] Request options.
 * @returns {Promise<{status: number, headers: Headers, body: any, text: string}>} Response.
 */
export async function httpRequest(port, pathname, options = {}) {
  const method = options.method ?? 'GET';
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: options.headers,
    body: options.body,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body, text };
}

/**
 * Poll `predicate` until it returns true or the budget expires.
 *
 * Used only to wait for work the daemon performs on its own timers. The predicate
 * is always an observable state, never a sleep-for-the-sake-of-it.
 *
 * @param {() => boolean} predicate Condition.
 * @param {{timeoutMs?: number, label?: string}} [options] Options.
 * @returns {Promise<void>} Resolves once the condition holds.
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  assert.fail(`timed out waiting for ${options.label ?? 'condition'}`);
}

/** Read a JSON file from the test data directory. */
export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Let pending microtasks and one macrotask run.
 *
 * Only for tests that need an already-started, non-blocking poll to finish before
 * they assert or stop the scheduler. It never substitutes for awaiting a promise
 * the code under test returns.
 *
 * @returns {Promise<void>} Resolves after the event loop turned once.
 */
export async function settle() {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}
