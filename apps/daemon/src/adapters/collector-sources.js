/**
 * adapters/collector-sources.js — the missing seam between a platform collector and the
 * daemon scheduler (COLLECTOR-LIVE §4 CL-2, A2-SHAPE §5/§6).
 *
 * The two sides disagree on shape, and neither is wrong:
 *
 * | platform collector (`createWindowsSources`)   | daemon scheduler (`assertSource`)       |
 * |-----------------------------------------------|----------------------------------------|
 * | `{ name, source }`                             | `{ id, kind, poll }`                    |
 * | identity is `source.descriptor.stableSourceId` | `id` must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` |
 * | `binding.poll()` → `{ok, items[], published}`  | `poll(ctx)` → `{events[], cursor?}`     |
 *
 * Passing the collector's list to `createDaemon` therefore fails at construction with
 * `SOURCE_INVALID`. This module is the single place that maps one onto the other, and it
 * is shared by every host entry point (`apps/service-host/src/sources.mjs`,
 * `apps/daemon/bin.js`) so the mapping cannot drift between them.
 *
 * Rules this module obeys (A2-SHAPE):
 *
 * - **Shape only.** `binding.poll()` already produced contract-valid events
 *   (snake_case envelope, `integrity` computed, `boot_id` set). They are forwarded
 *   verbatim; nothing is re-marshalled here.
 * - **An empty read must say why.** `events: []` is returned together with
 *   `empty: {code, reason}` so the daemon can report `empty` instead of `ok`
 *   (A2-SHAPE §6: "0 条却 ok" must not exist any more).
 * - **A failure is an error, not an empty batch.** `{ok: false}` and thrown collector
 *   errors become `SOURCE_FAILED` with the collector code, reason and remediation in
 *   `details`, so the scheduler marks the source `unavailable` and `last_error_code`
 *   carries something an operator can act on.
 * - **Cursors are the daemon's.** The collector runtime gets an in-memory cursor store
 *   (the daemon checkpoint is already durable) seeded from `ctx.cursor` on the first
 *   poll, so a restart resumes instead of replaying the whole table.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DaemonError, DAEMON_CODES } from '../errors.js';

/**
 * `source.descriptor.type` → the daemon's informational `kind` (closed set from
 * `adapters/collector.js`). Unknown types fall back to a name-based guess and, if that
 * fails too, to `synthetic` — never to a wrong real category.
 */
export const COLLECTOR_KIND_BY_TYPE = Object.freeze({
  'windows.process': 'process',
  'windows.connection': 'network',
  'windows.service': 'service',
  'windows.event_log': 'auth-log',
  'windows.run_key': 'persistence',
  'windows.scheduled_task': 'persistence',
  'windows.file_metadata': 'file',
  'linux.procfs-processes': 'process',
  'linux.procfs-connections': 'network',
  'linux.systemd-units': 'service',
  'linux.auth-log': 'auth-log',
  'linux.journald': 'auth-log',
  'linux.cron': 'persistence',
  'linux.declared-directories': 'file',
});

/** Ordered fallback for platform types this build does not know yet. */
const KIND_PATTERNS = Object.freeze([
  [/auth|log|journal/u, 'auth-log'],
  [/connection|network|socket/u, 'network'],
  [/process|procfs/u, 'process'],
  [/service|unit|daemon/u, 'service'],
  [/cron|run|task|persist|autostart/u, 'persistence'],
  [/file|dir|path/u, 'file'],
]);

/** Reason codes for a poll that legitimately returned zero events (A2-SHAPE §6). */
export const EMPTY_REASONS = Object.freeze({
  NO_EVENTS: 'NO_EVENTS',
  NO_NEW_RECORDS: 'NO_NEW_RECORDS',
  SNAPSHOT_NO_CHANGES: 'SNAPSHOT_NO_CHANGES',
  FILTERED_ALL: 'FILTERED_ALL',
  READ_IN_PROGRESS: 'READ_IN_PROGRESS',
  UNSPECIFIED_EMPTY: 'UNSPECIFIED_EMPTY',
});

/**
 * Derive the daemon `kind` for a collector descriptor.
 *
 * @param {{type?: string, stableSourceId?: string, kind?: string}} descriptor Descriptor.
 * @returns {string} One of the daemon's `SOURCE_KINDS`.
 */
export function daemonKindFor(descriptor) {
  const type = typeof descriptor?.type === 'string' ? descriptor.type : '';
  const direct = COLLECTOR_KIND_BY_TYPE[type];
  if (direct !== undefined) {
    return direct;
  }
  const probe = `${type} ${typeof descriptor?.stableSourceId === 'string' ? descriptor.stableSourceId : ''}`;
  for (const [pattern, kind] of KIND_PATTERNS) {
    if (pattern.test(probe)) {
      return kind;
    }
  }
  return 'synthetic';
}

/**
 * `boot_id` for every event this host produces (A2-SHAPE §8).
 *
 * Derived from the machine's boot instant (wall clock minus process uptime), truncated to
 * whole seconds, so it is **stable across restarts within one boot** and changes after a
 * reboot. `boot_id` is `NOT NULL` in `telemetry_event`; passing `null` is what made every
 * event fail with `ERR_NULL_NOT_ALLOWED` (CL-3).
 *
 * @param {{nowMs?: number, uptimeSeconds?: number}} [options] Clock inputs (injectable for tests).
 * @returns {string} 32 lower-case hex characters (contract `BOOT_ID`).
 */
export function createBootId({ nowMs = Date.now(), uptimeSeconds = process.uptime() } = {}) {
  const bootSeconds = Math.round((nowMs - uptimeSeconds * 1000) / 1000);
  return createHash('sha256').update(`boot:${bootSeconds}`).digest('hex').slice(0, 32);
}

/**
 * Normalize a collector error (or a `{ok:false}` poll result) into a daemon error that
 * carries the collector code where an operator can read it.
 *
 * @param {unknown} error Collector error.
 * @param {{id: string}} source Source id.
 * @returns {DaemonError} `SOURCE_FAILED` with `details.collector_code` / `reason` / `remediation`.
 */
function sourceFailure(error, source) {
  const code = typeof error?.code === 'string' && error.code.length > 0
    ? error.code
    : 'SOURCE_FAILED';
  const reason = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : 'the collector source failed without a message';
  const failure = new DaemonError(
    DAEMON_CODES.SOURCE_FAILED,
    `collector source ${source.id} failed: ${reason}`,
    {
      source_id: source.id,
      collector_code: code,
      reason,
      remediation: typeof error?.remediation === 'string' ? error.remediation : null,
    },
  );
  // The scheduler records `error.code`, which the registry maps to SOURCE_FAILED. The
  // precise collector code is kept here so the daemon's honest status view can surface it
  // as `last_error_code` instead of a generic wrapper.
  failure.collectorCode = code;
  return failure;
}

/**
 * Explain a zero-event successful poll (A2-SHAPE §6).
 *
 * @param {object} result `binding.poll()` result.
 * @returns {{code: string, reason: string}} Empty classification.
 */
export function emptyReasonFor(result) {
  if (result.empty === true) {
    return {
      code: EMPTY_REASONS.NO_EVENTS,
      reason: 'the read matched no records (the collector classified it as an empty read, not a failure)',
    };
  }
  if (Number(result.published ?? 0) === 0 && Number(result.duplicates ?? 0) > 0) {
    return {
      code: EMPTY_REASONS.NO_NEW_RECORDS,
      reason: `${result.duplicates} record(s) were already delivered; nothing new since the last read`,
    };
  }
  if (Number(result.published ?? 0) === 0 && Number(result.dropped ?? 0) > 0) {
    return {
      code: EMPTY_REASONS.FILTERED_ALL,
      reason: `${result.dropped} record(s) were read but dropped by the collector bounds (size, rate or queue)`,
    };
  }
  if (Number(result.skippedRows ?? 0) > 0 && Number(result.published ?? 0) === 0) {
    return {
      code: EMPTY_REASONS.FILTERED_ALL,
      reason: `${result.skippedRows} row(s) had no usable identity and were skipped`,
    };
  }
  if (result.snapshot === true) {
    return {
      code: EMPTY_REASONS.SNAPSHOT_NO_CHANGES,
      reason: 'the snapshot read succeeded and no entity changed since the previous snapshot',
    };
  }
  return {
    code: EMPTY_REASONS.NO_NEW_RECORDS,
    reason: 'the read succeeded and produced no new records',
  };
}

/**
 * Turn one collector binding into a daemon source descriptor.
 *
 * @param {{descriptor: object, poll: Function, collector?: object}} binding Collector binding.
 * @param {{
 *   cursorStore?: object,
 *   logger?: object,
 *   clock?: () => number
 * }} [deps] Dependencies.
 * @returns {{id: string, kind: string, intervalMs: number|null, poll: Function, stats: Function}}
 */
export function createCollectorDaemonSource(binding, deps = {}) {
  if (binding === null || typeof binding !== 'object' || typeof binding.poll !== 'function') {
    throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, 'a collector binding exposing poll() is required');
  }
  const descriptor = binding.descriptor;
  if (descriptor === null || typeof descriptor !== 'object' || typeof descriptor.stableSourceId !== 'string') {
    throw new DaemonError(
      DAEMON_CODES.SOURCE_INVALID,
      'the collector binding has no descriptor.stableSourceId to use as the source id',
    );
  }
  const cursorStore = deps.cursorStore ?? null;
  const logger = deps.logger ?? null;
  // `attachXSources` returns the collector next to the binding; a bare binding may carry
  // its own collector instead. Both are accepted so the identity (cursor) is reachable.
  const collector = deps.collector ?? binding.collector ?? null;
  const source = {
    id: descriptor.stableSourceId,
    // The collector's own name (`processes`, `eventLog:Security`, …) is kept as a
    // diagnostic label: hosts print it in their dry-run report and the daemon ignores it
    // (`assertSource` keeps only id/kind/intervalMs/poll).
    name: typeof deps.name === 'string' && deps.name.length > 0 ? deps.name : null,
    kind: daemonKindFor(descriptor),
    intervalMs: Number.isInteger(descriptor.intervalMs) && descriptor.intervalMs > 0
      ? descriptor.intervalMs
      : null,
  };
  let polls = 0;
  let emptyPolls = 0;
  let failures = 0;
  // PERF-CPU N-034: a poll skipped by the collector's own read gate (`READ_IN_PROGRESS`) is not a
  // failure and not news — the previous read simply has not finished. It used to be a `warn` line
  // on every occurrence (`windows.process-table` produced 11 of them in the smoke run), which is
  // both log noise and CPU. It is now a counter plus one debug line per streak.
  let skippedPolls = 0;
  let skipStreak = 0;
  let failureStreak = 0;
  let seeded = cursorStore === null || typeof cursorStore.seed !== 'function';
  let lastEmpty = null;
  let lastFailure = null;

  function identityCursor() {
    if (typeof collector?.identity !== 'function') {
      return null;
    }
    try {
      const identity = collector.identity();
      return {
        cursor: identity.cursor ?? null,
        generation: Number.isSafeInteger(identity.generation) ? identity.generation : 0,
        sequence: Number.isSafeInteger(identity.sequence) ? identity.sequence : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Restore the collector position from the daemon checkpoint on the first poll.
   * The daemon already persisted `{cursor, generation, sequence}` (see the `cursor`
   * member this adapter returns), so a restart resumes instead of replaying everything.
   *
   * @param {object} ctx Poll context.
   * @returns {void}
   */
  function seedFromCheckpoint(ctx) {
    if (seeded || ctx === null || typeof ctx !== 'object') {
      return;
    }
    seeded = true;
    const restored = ctx.cursor;
    if (restored === null || typeof restored !== 'object' || !Number.isSafeInteger(restored.generation)) {
      return;
    }
    try {
      cursorStore.seed({
        stableSourceId: source.id,
        generation: restored.generation,
        cursor: restored.cursor ?? null,
        sequence: Number.isSafeInteger(restored.sequence) ? restored.sequence : -1,
      });
    } catch {
      // A refused seed is not fatal: the worst outcome is a replay that the store absorbs
      // through its stable-key idempotency.
    }
  }

  /**
   * Report a collector failure once per streak.
   *
   * The scheduler now backs off a failing source (invariant 7), so this line is already much
   * rarer than it was; keeping it at `warn` only for the first failure of a streak means a dead
   * channel that never recovers cannot fill the log (or spend CPU formatting it) on every retry.
   *
   * @returns {void}
   */
  function logUnavailable() {
    const fields = {
      source_id: source.id,
      collector_code: lastFailure.details?.collector_code ?? null,
      reason: lastFailure.details?.reason ?? null,
      remediation: lastFailure.details?.remediation ?? null,
      failure_streak: failureStreak,
      polls,
    };
    if (failureStreak === 1) {
      logger?.warn?.('collector source unavailable', fields);
    } else {
      logger?.debug?.('collector source still unavailable', fields);
    }
  }

  async function poll(ctx) {
    polls += 1;
    seedFromCheckpoint(ctx);
    let result;
    try {
      result = await binding.poll();
    } catch (error) {
      failures += 1;
      failureStreak += 1;
      lastFailure = sourceFailure(error, source);
      logUnavailable();
      throw lastFailure;
    }

    if (result === null || typeof result !== 'object') {
      throw new DaemonError(DAEMON_CODES.SOURCE_FAILED, `collector source ${source.id} returned no result`, {
        source_id: source.id,
        collector_code: 'INVALID_RESULT',
      });
    }
    if (result.skipped === true) {
      emptyPolls += 1;
      skippedPolls += 1;
      skipStreak += 1;
      lastEmpty = {
        code: EMPTY_REASONS.READ_IN_PROGRESS,
        reason: `the previous read of this source has not finished (${String(result.reason ?? 'busy')})`,
      };
      // Debug, not warn: the source is not broken, it is busy with its own previous read. The
      // streak length is in the counter and in `/status` (`stats().skippedPolls`) instead.
      logger?.debug?.('collector source skipped a poll', {
        source_id: source.id,
        reason: lastEmpty.reason,
        skipped_polls: skippedPolls,
        skip_streak: skipStreak,
        polls,
      });
      return { events: [], empty: lastEmpty, ...(identityCursor() ?? {}) };
    }
    skipStreak = 0;
    if (result.ok !== true) {
      failures += 1;
      failureStreak += 1;
      lastFailure = sourceFailure(result.error ?? { code: result.code, message: result.code }, source);
      logUnavailable();
      throw lastFailure;
    }
    failureStreak = 0;

    const published = [];
    for (const item of result.items ?? []) {
      if (item?.outcome === 'published' && item.event !== null && item.event !== undefined) {
        published.push(item.event);
      }
    }
    const identity = identityCursor();
    const cursorFields = identity === null
      ? {}
      : { cursor: identity, generation: identity.generation, sequence: identity.sequence };

    if (published.length === 0) {
      emptyPolls += 1;
      lastEmpty = emptyReasonFor(result);
      // The first empty poll of a streak and every 12th afterwards: enough to answer
      // "why is this source quiet" from the log without flooding a 10-minute run.
      if (emptyPolls === 1 || emptyPolls % 12 === 0) {
        logger?.info?.('collector source empty', {
          source_id: source.id,
          code: lastEmpty.code,
          reason: lastEmpty.reason,
          empty_polls: emptyPolls,
          polls,
        });
      }
      return { events: [], empty: lastEmpty, ...cursorFields };
    }

    if (Number(result.dropped ?? 0) > 0) {
      // Whatever still gets dropped (oversize event, queue capacity) is a real loss and is
      // recorded in the collector's gap ledger; log it here so it is not only visible to a
      // reader of the ledger.
      logger?.warn?.('collector source dropped records', {
        source_id: source.id,
        dropped: result.dropped,
        duplicates: result.duplicates ?? 0,
        gap_reasons: [...new Set((result.gaps ?? []).map((gap) => gap.reason))].slice(0, 4),
      });
    }
    if (emptyPolls > 0) {
      logger?.info?.('collector source recovered', {
        source_id: source.id,
        events: published.length,
        empty_polls_before: emptyPolls,
        polls,
      });
      emptyPolls = 0;
      lastEmpty = null;
    }
    lastFailure = null;
    return { events: published, ...cursorFields };
  }

  source.poll = poll;
  source.stats = () => Object.freeze({ polls, emptyPolls, failures, skippedPolls, lastEmpty, lastFailure: lastFailure === null ? null : {
    collector_code: lastFailure.details?.collector_code ?? null,
    reason: lastFailure.details?.reason ?? null,
  } });
  return source;
}

/**
 * Build the daemon's `sources` array from a platform collector module.
 *
 * The caller supplies the three functions so this module never imports a collector
 * package: the daemon's module graph stays free of platform collectors, and a host can
 * wire any platform that exposes `createXSources` / `attachXSources`.
 *
 * @param {{
 *   createSources: (options: object) => readonly {name: string, source: object}[],
 *   attachSources: (args: {runtime: object, sources: readonly object[]}) => readonly object[],
 *   createRuntime: (options: object) => object,
 *   options?: object,
 *   runtimeOptions?: object,
 *   cursorStore: object,
 *   bootId: string,
 *   clock?: () => number,
 *   logger?: object
 * }} args Wiring inputs.
 * @returns {{runtime: object, bindings: readonly object[], sources: readonly object[], cursorStore: object, bootId: string}}
 */
export function createCollectorSources({
  createSources,
  attachSources,
  createRuntime,
  options = {},
  runtimeOptions = {},
  cursorStore,
  bootId,
  clock = Date.now,
  logger = null,
} = {}) {
  for (const [name, value] of Object.entries({ createSources, attachSources, createRuntime })) {
    if (typeof value !== 'function') {
      throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `createCollectorSources requires ${name}()`);
    }
  }
  if (cursorStore === null || typeof cursorStore !== 'object') {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'createCollectorSources requires a cursor store');
  }
  if (typeof bootId !== 'string' || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.test(bootId)) {
    throw new DaemonError(
      DAEMON_CODES.CONFIG_INVALID,
      'bootId must be 32 lower-case hex characters or a UUIDv4: boot_id is NOT NULL and a null one rejects every event',
    );
  }

  const declared = createSources(options);
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'the collector module declared no sources');
  }

  const runtime = createRuntime({
    store: cursorStore,
    clock,
    bootId,
    // **No internal rate limiting on this seam.** The collector's token bucket is a
    // steady-state admission limiter for a streaming consumer (100 events/s per source,
    // bucket capacity = 100). A poll, by contrast, is a *bounded snapshot*: the first
    // process-table read is ~562 rows and the first directory snapshot is capped at
    // 20 000 — with the bucket on, 462 and 19 900 of them were dropped as
    // `rate_limited` gaps on every single poll, i.e. permanent loss reported only to the
    // gap ledger. On this seam the daemon scheduler owns cadence *and* batch size
    // (`scheduler.maxBatchEvents`), so throttling belongs there.
    rateLimiter: null,
    ...runtimeOptions,
  });
  const attached = attachSources({ runtime, sources: declared });
  if (!Array.isArray(attached) || attached.length === 0) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'the collector runtime produced no bindings');
  }
  // `attachWindowsSources` returns `{name, descriptor, collector, binding}` while a bare
  // `createSourceBinding` returns the binding itself. Accept both: the wiring layer must
  // not force one platform's assembly helper shape on another.
  //
  // The flat branch also carries the collector's `name` when the assembly kept it next to
  // the binding's own `poll()` (the D3 shape: `{name, ...binding, descriptor, collector,
  // binding}`). Dropping it here made `service-host --dry-run` report `sources:[null ×9]`
  // — R3-003's shape regression. A bare binding has no name and must stay `null`.
  const entries = attached.map((entry) => {
    if (entry !== null && typeof entry === 'object' && typeof entry.poll !== 'function' && entry.binding !== undefined) {
      return {
        name: typeof entry.name === 'string' ? entry.name : null,
        binding: entry.binding,
        collector: entry.collector ?? null,
      };
    }
    return {
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : null,
      binding: entry,
      collector: entry?.collector ?? null,
    };
  });
  const sources = entries.map(({ name, binding, collector }) => {
    const source = createCollectorDaemonSource(binding, { cursorStore, logger, clock, collector, name });
    logger?.info?.('collector source wired', {
      source_id: source.id,
      kind: source.kind,
      interval_ms: source.intervalMs,
      name,
    });
    return source;
  });
  return Object.freeze({
    runtime,
    bindings: Object.freeze(attached),
    sources: Object.freeze(sources),
    cursorStore,
    bootId,
  });
}

/** Keys a collector spec file may declare. A closed set, like the daemon config. */
export const COLLECTOR_SPEC_KEYS = Object.freeze([
  'collectorModule',
  'commonModule',
  'createSources',
  'attachSources',
  'createRuntime',
  'options',
  'bootId',
]);

function specFail(message, details) {
  throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `collector spec: ${message}`, details);
}

/**
 * Validate a `--collectors <path>` document (A2-SHAPE §5).
 *
 * The document names the platform module and the wiring entry points:
 *
 * ```json
 * {
 *   "collectorModule": "packages/collectors/windows/index.js",
 *   "commonModule": "packages/collectors/common/index.js",
 *   "createSources": "createWindowsSources",
 *   "attachSources": "attachWindowsSources",
 *   "options": { "include": ["processes"], "roots": [] },
 *   "bootId": null
 * }
 * ```
 *
 * Relative module paths resolve against the spec file's directory, so a spec can live in
 * the data directory without hard-coding an absolute repository path.
 *
 * @param {object} raw Parsed JSON document.
 * @param {{baseDir?: string}} [context] Resolution base.
 * @returns {object} Frozen, resolved spec.
 */
export function parseCollectorSpec(raw, { baseDir = process.cwd() } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    specFail('the document must be a JSON object');
  }
  for (const key of Object.keys(raw)) {
    if (!COLLECTOR_SPEC_KEYS.includes(key)) {
      specFail(`unknown key "${key}"`, { allowed: COLLECTOR_SPEC_KEYS });
    }
  }
  const resolveModule = (label, value) => {
    if (typeof value !== 'string' || value.length === 0) {
      specFail(`${label} must be a non-empty path`);
    }
    return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
  };
  const collectorModule = resolveModule('collectorModule', raw.collectorModule);
  const commonModule = resolveModule('commonModule', raw.commonModule);
  const createSources = raw.createSources ?? 'createWindowsSources';
  const attachSources = raw.attachSources ?? 'attachWindowsSources';
  const createRuntime = raw.createRuntime ?? 'createCollectorRuntime';
  for (const [label, value] of Object.entries({ createSources, attachSources, createRuntime })) {
    if (typeof value !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)) {
      specFail(`${label} must be an exported function name`, { value: typeof value });
    }
  }
  const options = raw.options ?? {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    specFail('options must be an object');
  }
  const bootId = raw.bootId ?? null;
  if (bootId !== null && (typeof bootId !== 'string' || bootId.length === 0)) {
    specFail('bootId must be null or a non-empty string');
  }
  return Object.freeze({
    collectorModule,
    commonModule,
    createSources,
    attachSources,
    createRuntime,
    options: Object.freeze({ ...options }),
    bootId,
  });
}

/**
 * Read and validate a collector spec file.
 *
 * @param {string} filePath Absolute path.
 * @returns {object} Parsed spec.
 */
export function loadCollectorSpec(filePath) {
  const absolute = resolve(filePath);
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new DaemonError(
      DAEMON_CODES.CONFIG_NOT_FOUND,
      `collector spec is not readable: ${absolute}`,
      { reason: error?.code ?? 'UNREADABLE' },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `collector spec is not valid JSON: ${absolute}`);
  }
  return parseCollectorSpec(parsed, { baseDir: dirname(absolute) });
}

/**
 * Load the modules a spec names and build the daemon sources from them.
 *
 * The import is dynamic and the module path comes from the spec: this is the
 * "operator/host supplies the collector" path, which is why the daemon package has no
 * static import of any collector package.
 *
 * @param {object} spec Result of {@link loadCollectorSpec}/{@link parseCollectorSpec}.
 * @param {{logger?: object, clock?: () => number}} [deps] Dependencies.
 * @returns {Promise<ReturnType<typeof createCollectorSources>>} Wiring result.
 */
export async function buildSourcesFromSpec(spec, { logger = null, clock = Date.now } = {}) {
  const platform = await import(pathToFileURL(spec.collectorModule).href).catch((error) => {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `collector module could not be imported: ${spec.collectorModule}`, {
      reason: error?.code ?? 'IMPORT_FAILED',
    });
  });
  const common = await import(pathToFileURL(spec.commonModule).href).catch((error) => {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `collector-common could not be imported: ${spec.commonModule}`, {
      reason: error?.code ?? 'IMPORT_FAILED',
    });
  });
  for (const [label, module, name] of [
    ['collectorModule', platform, spec.createSources],
    ['collectorModule', platform, spec.attachSources],
    ['commonModule', common, spec.createRuntime],
  ]) {
    if (typeof module[name] !== 'function') {
      throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `${label} does not export ${name}()`, { module: label });
    }
  }
  const cursorStore = common.createMemoryCursorStore({ clock });
  const bootId = spec.bootId ?? createBootId();
  return createCollectorSources({
    createSources: platform[spec.createSources],
    attachSources: platform[spec.attachSources],
    createRuntime: common[spec.createRuntime],
    options: spec.options,
    cursorStore,
    bootId,
    clock,
    logger,
  });
}
