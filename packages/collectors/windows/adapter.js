/**
 * Bind one Windows source onto the platform-neutral collector pipeline (§5.1, §5.2).
 *
 * This module is the only place where the adapter meets `@aegishorness/collector-common`.
 * It owns the four obligations the common layer's INTEGRATION.md puts on a platform
 * adapter, and nothing else:
 *
 * 1. **read → publish → commit.** `publish` only mutates memory; `commit` is the single
 *    durable point. A failed `publish` therefore leaves the persisted cursor untouched and
 *    the next read replays the same range with identical stable keys.
 * 2. **generation advance before publish.** A source that reports `reset` (a cleared event
 *    log whose record ids restarted) must have its generation advanced *before* the new
 *    records are published, otherwise the new generation's ids collide with the old keys.
 * 3. **error → capability mapping.** A denied permission must latch the source as
 *    `unavailable`, never as "zero events". A timeout degrades it. A programming error is
 *    rethrown instead of being swallowed into a "healthy but empty" source.
 * 4. **subscription health.** Event-driven sources are judged only by an independent probe,
 *    because a quiet channel is not a broken one.
 *
 * The adapter never constructs a command line; it only hands a script to a source that
 * already validated its inputs.
 */

import {
  WINDOWS_ERROR_CODES,
  WindowsCollectorError,
  asWindowsCollectorError,
  remediationFor,
} from './errors.js';

/**
 * Capability codes that make a source `unavailable` (`permission_denied` is the only code
 * the common layer treats as fatal by itself; the rest are passed through as-is).
 */
export const FATAL_WINDOWS_CODES = Object.freeze([
  WINDOWS_ERROR_CODES.ACCESS_DENIED,
  WINDOWS_ERROR_CODES.CHANNEL_NOT_FOUND,
]);

/** Codes that are configuration or programming errors: the adapter must not degrade for them. */
export const PROGRAMMING_WINDOWS_CODES = Object.freeze([
  WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
  WINDOWS_ERROR_CODES.INVALID_CONFIG,
  WINDOWS_ERROR_CODES.INVALID_RECORD,
  WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED,
  WINDOWS_ERROR_CODES.EXECUTABLE_NOT_ALLOWED,
  WINDOWS_ERROR_CODES.SOURCE_LIMIT_EXCEEDED,
  WINDOWS_ERROR_CODES.SOURCE_UNKNOWN,
]);

/** `NO_EVENTS` is an empty read, not a failure. */
const NON_FATAL_EMPTY_CODES = new Set([WINDOWS_ERROR_CODES.NO_EVENTS]);

/**
 * Codes the common layer raises for bad input rather than for an unhealthy host. They must
 * surface as thrown errors even though they arrive wrapped in `COMMAND_FAILED`.
 */
const COMMON_PROGRAMMING_CODES = new Set([
  'INVALID_ARGUMENT',
  'INVALID_RECORD',
  'INVALID_SOURCE_ID',
  'INVALID_INSTANCE_ID',
  'EVENT_TOO_LARGE',
  'UNCOMMITTED_BATCH',
  'STALE_BATCH',
]);

/**
 * Translate a Windows adapter error into the shape `capability.recordError` expects.
 * `permission_denied` is the one code that latches a source as `unavailable`.
 *
 * A failure that came from the common layer (a cursor-store write, a queue refusal) carries
 * its own code. Rewriting it to `COMMAND_FAILED` would replace an actionable remediation
 * ("the disk is full") with a misleading one ("run the PowerShell command by hand"), so the
 * original code is preserved and the remediation falls back to a neutral sentence.
 */
export function classifyForCapability(error) {
  const normalized = asWindowsCollectorError(error);
  const code = normalized.code;
  if (programming(code)) {
    return { programming: true, error: normalized };
  }
  const originalCode = normalized.details?.originalCode ?? null;
  if (originalCode !== null && COMMON_PROGRAMMING_CODES.has(originalCode)) {
    return { programming: true, error: normalized };
  }
  const capabilityCode = originalCode !== null
    ? originalCode
    : (code === WINDOWS_ERROR_CODES.ACCESS_DENIED ? 'permission_denied' : code);
  return {
    programming: false,
    empty: NON_FATAL_EMPTY_CODES.has(code),
    fatal: FATAL_WINDOWS_CODES.includes(code),
    error: normalized,
    note: {
      code: capabilityCode,
      message: normalized.message,
      remediation: originalCode !== null
        ? 'Inspect the collector log for the recorded persistence or queue failure'
        : (normalized.remediation ?? remediationFor(capabilityCode)),
      fatal: FATAL_WINDOWS_CODES.includes(code),
    },
  };
}

function programming(code) {
  return PROGRAMMING_WINDOWS_CODES.includes(code);
}

function assertCollector(collector) {
  if (collector === null || typeof collector !== 'object') {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'a source collector is required');
  }
  for (const method of ['beginRead', 'publish', 'commit', 'noteError', 'snapshot']) {
    if (typeof collector[method] !== 'function') {
      throw new WindowsCollectorError(
        WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
        `collector.${method} must be a function`,
      );
    }
  }
}

/**
 * @param {object} options
 * @param {object} options.source      source object exposing `read()` and a `descriptor`
 * @param {object} options.collector   `createSourceCollector` / `runtime.addSource()` result
 * @param {() => number} [options.clock]
 *
 * The binding deliberately does not take the capability object: `runtime.addSource()` creates
 * it internally and does not expose it, so any update through a separate handle would simply
 * never run on the official assembly path. Everything the operator needs is written through
 * the collector itself (`noteError`, `probeSubscription`), which owns the same state.
 */
export function createSourceBinding({ source, collector, clock = Date.now } = {}) {
  if (source === null || typeof source !== 'object' || typeof source.read !== 'function') {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'source must expose read()',
    );
  }
  assertCollector(collector);
  if (typeof clock !== 'function') {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function');
  }

  const descriptor = source.descriptor;
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_CONFIG,
      'source must expose a validated descriptor',
    );
  }

  let busy = false;
  const totals = { reads: 0, failures: 0, resets: 0, truncated: 0, published: 0, duplicates: 0, dropped: 0 };

  function recordFailure(error) {
    const classified = classifyForCapability(error);
    if (classified.programming) {
      throw classified.error;
    }
    collector.noteError(classified.note);
    totals.failures += 1;
    return classified;
  }

  return Object.freeze({
    descriptor,
    sourceId: descriptor.stableSourceId,

    /**
     * One read cycle. Never throws for an operational failure: the failure is recorded on
     * the source's capability state and returned, because a collector loop that throws
     * would lose the failure instead of reporting it.
     */
    async poll() {
      if (busy) {
        return Object.freeze({ ok: false, skipped: true, reason: 'read_in_progress' });
      }
      busy = true;
      try {
        const state = collector.beginRead();
        totals.reads += 1;

        let collected;
        try {
          collected = await source.read({
            cursor: state.cursor,
            generation: state.generation,
          });
        } catch (error) {
          const classified = classifyForCapability(error);
          if (classified.programming) {
            throw classified.error;
          }
          if (classified.empty === true) {
            // "No events were found" is an empty read, not a degraded source. Publishing an
            // empty batch here would write `nextCursor: null` over the real event-log cursor,
            // so the read is reported as an empty success without touching the position.
            return Object.freeze({ ok: true, empty: true, published: 0, duplicates: 0, dropped: 0 });
          }
          collector.noteError(classified.note);
          totals.failures += 1;
          return Object.freeze({ ok: false, error: classified.error, code: classified.error.code });
        }

        if (collected === null || typeof collected !== 'object' || !Array.isArray(collected.records)) {
          // A source that does not honour its own contract is an adapter bug, not an
          // unhealthy host: throwing keeps it visible instead of degrading the source.
          throw new WindowsCollectorError(
            WINDOWS_ERROR_CODES.INVALID_RECORD,
            'source.read() must return an object with a records array',
          );
        }

        if (collected.reset !== null && collected.reset !== undefined) {
          try {
            // `cursor: null` on purpose. The advancement is persisted immediately, so storing
            // the new-generation position here would mean the next read starts *after* these
            // records; if `publish` then failed they would be skipped and only a count-0
            // generation gap would remain. With a null cursor a failed publish simply replays
            // the new generation from record 0, and the dedupe window absorbs the overlap.
            collector.advanceGeneration({
              reason: collected.reset.reason,
              cursor: null,
              gapStart: collected.reset.gapStart,
              gapEnd: collected.reset.gapEnd,
            });
            totals.resets += 1;
          } catch (error) {
            const classified = recordFailure(error);
            return Object.freeze({ ok: false, error: classified.error ?? error, code: error?.code ?? null });
          }
        }

        let published;
        try {
          published = collector.publish({
            records: collected.records,
            nextCursor: collected.nextCursor ?? null,
          });
        } catch (error) {
          const classified = recordFailure(error);
          return Object.freeze({ ok: false, error: classified.error ?? error, code: error?.code ?? null });
        }

        try {
          collector.commit(published);
        } catch (error) {
          // `commit` failure means the durable outcome is unknown; the common layer has
          // already realigned its in-memory identity with the store, so the adapter only
          // reports it and lets the next read decide from `beginRead()`.
          const classified = recordFailure(error);
          return Object.freeze({ ok: false, error: classified.error ?? error, code: error?.code ?? null });
        }

        const truncated = collected.truncated === true;
        if (truncated) {
          // A truncated read really did lose data, so the source must not keep reporting
          // itself as healthy. `noteError` is the only capability write the public collector
          // surface exposes; there is no `recordGap` on `createSourceCollector`, so the gap
          // ledger entry has to come from the daemon (see INTEGRATION §7).
          totals.truncated += 1;
          collector.noteError({
            code: 'source_truncated',
            message: `Read for ${descriptor.stableSourceId} hit a bound and lost data`,
            remediation: 'Reduce the declared scope (fewer roots, fewer entities) or raise the source bound; the truncated read did not report removals',
          });
        }
        // `degradedFields` is returned to the caller, not written to capability state.
        // `setPermissions({ missing: [] })` would un-latch a genuine `permission_denied`
        // (common/capability.js clears `fatalError` when `missing` is empty), turning an
        // unavailable source back into a healthy one on the strength of a partial read.

        totals.published += published.published;
        totals.duplicates += published.duplicates;
        totals.dropped += published.dropped;

        return Object.freeze({
          ok: true,
          generation: published.generation,
          published: published.published,
          duplicates: published.duplicates,
          dropped: published.dropped,
          gaps: published.gaps,
          items: published.items,
          snapshot: collected.snapshot === true,
          truncated,
          hasMore: collected.hasMore === true,
          // "Rows the source could not give an identity" (an event log record with an
          // unusable record id). Not an error, but it must not vanish either.
          skippedRows: Number.isSafeInteger(collected.skippedRows) ? collected.skippedRows : 0,
          degradedFields: collected.degradedFields ?? Object.freeze([]),
          stats: collected.stats ?? null,
        });
      } finally {
        busy = false;
      }
    },

    /** Independent subscription health probe for event-driven sources (§5.1). */
    async probe() {
      if (typeof source.probe !== 'function') {
        return Object.freeze({ ok: false, errorCode: WINDOWS_ERROR_CODES.SOURCE_UNKNOWN });
      }
      if (typeof collector.probeSubscription !== 'function') {
        throw new WindowsCollectorError(
          WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
          'collector.probeSubscription must be a function',
        );
      }
      const result = await source.probe();
      collector.probeSubscription({ ok: result.ok === true });
      return Object.freeze({ ok: result.ok === true, errorCode: result.errorCode ?? null });
    },

    stats() {
      return Object.freeze({ ...totals });
    },
  });
}
