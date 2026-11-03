/**
 * Linux collector runtime: the only layer that connects a Linux source to
 * `packages/collectors/common`.
 *
 * Division of labour, in one sentence: sources know how to read Linux and what they could
 * not read; this runtime knows what to do about it.
 *
 * The degradation rules it enforces (task requirement: "无权限必须显示降级，不能返回伪正常空结果"):
 *
 * - `denied`  → `capability.setPermissions({ missing })`, an unknown-count
 *               `permission_denied` gap, and **no** `publish`/`commit`. The cursor therefore
 *               does not advance and the source is `unavailable`, not `ready` with zero
 *               events. This is the case that must never look healthy.
 * - `partial` → publish whatever was readable, then `recordError` so the lifecycle is
 *               `degraded`; the gap reason depends on whether the partial read had denials
 *               (permission) or not (parse/truncation).
 * - `error`   → nothing published, `io_error` gap, lifecycle `degraded`.
 * - `rotated` → nothing published, `advanceGeneration({ reason })` so the replaced file/log
 *               starts a new generation instead of reusing old offsets.
 * - `ok`      → publish + commit; `setPermissions({ missing: [] })` unlatches a source that
 *               was previously unavailable for permission reasons, and commit's
 *               `recordSuccess` clears the degraded latch.
 *
 * Why this runtime creates its own `createCapability` instead of using
 * `createCollectorRuntime`: that helper keeps the capability private, and a permission
 * denial can only be *unlatched* through `capability.setPermissions({ missing: [] })`.
 * Without that handle a source that was once denied could never leave `unavailable`. This is
 * reported to the main controller as an integration item rather than patched into
 * `common`, which is out of scope for this task.
 */

import {
  LIMITS,
  createCapability,
  createCollectorInstanceId,
  createGapLedger,
  createSourceCollector,
  toIsoTimestamp,
} from '../common/index.js';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertNonEmptyString,
} from './errors.js';
import {
  DEGRADATION_POLICY,
  assertReadResult,
  gapReasonFor,
} from './sources/descriptor.js';

const REMEDIATION_BY_ERROR = Object.freeze({
  permission_denied: 'Grant this account read access (group membership or ACL) and restart the collector',
  partial_permission: 'Some paths are unreadable for this account; run as root or grant access to see them',
  invalid_cursor: 'The journal cursor is no longer valid; the source restarted its generation',
  io_error: 'Check that the source path exists and is readable, then restart the collector',
  empty_table: 'The source listed nothing at all, which usually means a permission or namespace problem',
});

function remediationFor(code) {
  return REMEDIATION_BY_ERROR[code] ?? 'Inspect last_error and denials for this source';
}

function summarizeDenials(denials) {
  if (!Array.isArray(denials) || denials.length === 0) {
    return null;
  }
  const distinct = new Map();
  for (const denial of denials) {
    const key = `${denial.outcome}\u0000${denial.code}`;
    distinct.set(key, (distinct.get(key) ?? 0) + 1);
  }
  return [...distinct.entries()].map(([key, count]) => {
    const [outcome, code] = key.split('\u0000');
    return `${count} path(s) ${outcome} (${code})`;
  }).join('; ').slice(0, 480);
}

export function createLinuxCollectorRuntime({
  store,
  clock = Date.now,
  bootId = null,
  queue = null,
  dedupe = null,
  gaps = null,
  rateLimiter = null,
  limits = LIMITS,
} = {}) {
  if (!store || typeof store.load !== 'function' || typeof store.commit !== 'function') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a cursor store exposing load/commit is required',
    );
  }
  if (typeof clock !== 'function') {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function');
  }

  const gapLedger = gaps ?? createGapLedger({
    maxPerSource: limits.gapMaxPerSource,
    maxTotal: limits.gapMaxTotal,
    mergeWindowMs: limits.gapMergeWindowMs,
    clock,
  });

  /** @type {Map<string, {collector: object, capability: object, adapter: object, descriptor: object, last: object|null}>} */
  const sources = new Map();

  function recordGap(stableSourceId, generation, reason, startMs, endMs, count) {
    // Map the source condition onto the shared closed reason set and write the *mapped*
    // value: validating the mapping but storing the raw string would let an unmapped
    // condition through to `gaps.record`, which would throw mid-batch.
    const sharedReason = gapReasonFor(reason === undefined ? 'io_error' : reason);
    return gapLedger.record({
      stableSourceId,
      generation,
      reason: sharedReason,
      start: startMs,
      end: endMs === undefined ? startMs : endMs,
      count: count === undefined ? 0 : count,
    });
  }

  return Object.freeze({
    /**
     * Register one adapter. The adapter must expose `descriptor` and `read({ cursor })`.
     * `probe` is required for `kind: 'event'` sources.
     */
    addSource({ adapter, stableSourceId = undefined } = {}) {
      if (adapter === null || typeof adapter !== 'object' || typeof adapter.read !== 'function') {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_ARGUMENT,
          'a source adapter exposing read() is required',
        );
      }
      const descriptor = adapter.descriptor ?? null;
      if (descriptor === null || typeof descriptor !== 'object') {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_ARGUMENT,
          'the adapter must expose its source descriptor',
        );
      }
      const id = stableSourceId === undefined ? descriptor.stableSourceId : assertNonEmptyString(
        'stableSourceId',
        stableSourceId,
      );
      if (sources.has(id)) {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_ARGUMENT,
          `source ${id} is already registered`,
          { stableSourceId: id },
        );
      }
      if (descriptor.kind === 'event' && typeof adapter.probe !== 'function') {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_ARGUMENT,
          `event source ${id} must expose probe()`,
          { stableSourceId: id },
        );
      }

      const capability = createCapability({
        stableSourceId: id,
        collectorInstanceId: createCollectorInstanceId(),
        kind: descriptor.kind,
        intervalMs: descriptor.intervalMs,
        subscriptionProbeIntervalMs: descriptor.subscriptionProbeIntervalMs ?? LIMITS.subscriptionProbeIntervalMs,
        clock,
      });
      const collector = createSourceCollector({
        source: {
          stableSourceId: id,
          kind: descriptor.kind,
          intervalMs: descriptor.intervalMs,
          subscriptionProbeIntervalMs: descriptor.subscriptionProbeIntervalMs
            ?? LIMITS.subscriptionProbeIntervalMs,
        },
        store,
        queue,
        dedupe,
        gaps: gapLedger,
        capability,
        rateLimiter,
        clock,
        bootId,
        limits,
      });

      sources.set(id, { collector, capability, adapter, descriptor, last: null });
      return collector;
    },

    has(stableSourceId) {
      return sources.has(stableSourceId);
    },

    ids() {
      return [...sources.keys()];
    },

    descriptorOf(stableSourceId) {
      const entry = sources.get(stableSourceId);
      return entry === undefined ? null : entry.descriptor;
    },

    /**
     * Read one source once and apply the degradation policy. Never throws for a source
     * failure: a broken collector must degrade, not take the daemon down.
     */
    async readSource(stableSourceId, { at = undefined } = {}) {
      const entry = sources.get(stableSourceId);
      if (entry === undefined) {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_ARGUMENT,
          `unknown source: ${String(stableSourceId)}`,
          { stableSourceId: String(stableSourceId) },
        );
      }
      const { collector, capability, adapter, descriptor } = entry;
      const state = collector.beginRead();
      const nowMs = at === undefined ? clock() : at;

      let result;
      try {
        result = await adapter.read({ cursor: state.cursor, generation: state.generation });
      } catch (error) {
        const code = error instanceof LinuxCollectorError ? error.code : 'READ_FAILED';
        const message = error instanceof Error ? error.message : String(error);
        capability.recordError({
          code: 'adapter_read_failed',
          message: message.slice(0, 480),
          remediation: remediationFor('io_error'),
          at: nowMs,
        });
        const gap = recordGap(stableSourceId, state.generation, 'io_error', nowMs, nowMs, 0);
        entry.last = Object.freeze({
          status: 'error',
          at: nowMs,
          code,
          message: message.slice(0, 480),
          denials: Object.freeze([]),
        });
        return Object.freeze({
          stableSourceId,
          status: 'error',
          committed: false,
          published: 0,
          duplicates: 0,
          dropped: 0,
          gaps: Object.freeze([gap]),
          lifecycle: capability.snapshot(nowMs).lifecycle,
          error: Object.freeze({ code, message: message.slice(0, 480) }),
        });
      }

      try {
        assertReadResult(result, { stableSourceId });
      } catch (error) {
        // A source returning a self-contradictory result (for example "ok" while admitting a
        // denial) is an adapter bug. It must degrade this one source, not reject out of the
        // daemon loop and take every other source down with it.
        const message = error instanceof Error ? error.message : String(error);
        capability.recordError({
          code: 'adapter_contract_violation',
          message: message.slice(0, 480),
          remediation: remediationFor('io_error'),
          at: nowMs,
        });
        const gap = recordGap(stableSourceId, state.generation, 'io_error', nowMs, nowMs, 0);
        entry.last = Object.freeze({
          status: 'error',
          at: nowMs,
          code: 'ADAPTER_CONTRACT_VIOLATION',
          message: message.slice(0, 480),
          denials: Object.freeze([]),
        });
        return Object.freeze({
          stableSourceId,
          status: 'error',
          committed: false,
          published: 0,
          duplicates: 0,
          dropped: 0,
          gaps: Object.freeze([gap]),
          lifecycle: capability.snapshot(nowMs).lifecycle,
          error: Object.freeze({ code: 'ADAPTER_CONTRACT_VIOLATION', message: message.slice(0, 480) }),
        });
      }
      const policy = DEGRADATION_POLICY[result.status];
      const denials = result.denials ?? [];
      const permissionDenials = denials.filter((denial) => denial.outcome === 'permission_denied');

      // ---- rotated: the backing store was replaced; the cursor is meaningless now ----
      if (result.status === 'rotated') {
        const reason = result.rotation.reason;
        const gaps = [];
        try {
          // `advanceGeneration` records the unknown-count gap in the shared ledger itself.
          collector.advanceGeneration({ reason, cursor: null });
          // Select by generation and reason: the ledger merges and folds entries, so "the
          // last row" is not guaranteed to be the rotation gap this call just produced.
          const generationAfter = collector.identity().generation;
          // Mirror the shared collector's generation-reason → gap-reason mapping
          // (common/source-collector.js): log_rotated and log_truncated keep their name, and
          // every other generation reason is folded into `generation_reset`.
          const expectedReason = reason === 'log_rotated' || reason === 'log_truncated'
            ? reason
            : 'generation_reset';
          const recorded = gapLedger.list()
            .filter((gap) => gap.stableSourceId === stableSourceId
              && gap.generation === generationAfter
              && gap.reason === expectedReason)
            .pop();
          if (recorded !== undefined) {
            gaps.push(recorded);
          }
        } catch (error) {
          capability.recordError({
            code: 'generation_advance_failed',
            message: error instanceof Error ? error.message : String(error),
            remediation: remediationFor('io_error'),
            at: nowMs,
          });
        }
        // An unknown number of records just became unreachable: the source must say so,
        // otherwise "healthy" would be reported for a source that silently lost a range.
        capability.recordError({
          code: 'log_rotated',
          message: `the backing store was replaced (${reason}); an unknown range may be lost`,
          remediation: 'Verify that the log rotation is configured to keep or forward the previous file',
          at: nowMs,
        });
        entry.last = Object.freeze({
          status: 'rotated',
          at: nowMs,
          reason,
          denials: Object.freeze(denials),
        });
        return Object.freeze({
          stableSourceId,
          status: 'rotated',
          reason,
          committed: false,
          published: 0,
          duplicates: 0,
          dropped: 0,
          gaps: Object.freeze(gaps),
          lifecycle: capability.snapshot(nowMs).lifecycle,
          error: null,
        });
      }

      // ---- denied / error: publish nothing, keep the cursor where it is ----
      if (!policy.publish) {
        if (result.status === 'denied') {
          capability.setPermissions({
            granted: result.permissions?.granted ?? [],
            missing: result.permissions?.missing ?? denials.map((denial) => denial.path),
          });
        }
        capability.recordError({
          code: result.status === 'denied' ? 'permission_denied' : (result.errorCode ?? 'read_failed'),
          message: summarizeDenials(denials) ?? result.error?.message ?? `${result.status} read`,
          remediation: remediationFor(result.status === 'denied' ? 'permission_denied' : 'io_error'),
          at: nowMs,
        });
        const gaps = [
          recordGap(stableSourceId, state.generation, policy.gapReason ?? 'io_error', nowMs, nowMs, 0),
        ];
        // A rejected journald cursor is an error status, but the position is still dead: the
        // generation has to advance or the next read would replay the same invalid cursor.
        if (result.resetCursor === true) {
          try {
            collector.advanceGeneration({ reason: 'adapter_reset', cursor: null });
            gaps.push(recordGap(stableSourceId, collector.identity().generation, 'cursor_reset', nowMs, nowMs, 0));
          } catch (error) {
            capability.recordError({
              code: 'generation_advance_failed',
              message: error instanceof Error ? error.message : String(error),
              remediation: remediationFor('io_error'),
              at: nowMs,
            });
          }
        }
        entry.last = Object.freeze({
          status: result.status,
          at: nowMs,
          code: result.errorCode ?? null,
          denials: Object.freeze(denials),
        });
        return Object.freeze({
          stableSourceId,
          status: result.status,
          committed: false,
          published: 0,
          duplicates: 0,
          dropped: 0,
          gaps: Object.freeze(gaps),
          lifecycle: capability.snapshot(nowMs).lifecycle,
          error: result.error ?? null,
          denials: Object.freeze(denials),
        });
      }

      // ---- ok / partial: publish and commit ----
      const published = collector.publish({
        records: result.records,
        nextCursor: result.nextCursor === undefined ? null : result.nextCursor,
      });
      const committed = collector.commit(published);

      // A completed read proves the permission problem is gone; unlatch it explicitly,
      // because only `setPermissions` can clear the fatal permission state.
      capability.setPermissions({ granted: result.permissions?.granted ?? [], missing: [] });

      const gaps = [...published.gaps];
      // A bounded or tail-anchored read loses records without failing. If that never reaches
      // the gap ledger, the ledger lies about a clean source.
      if (result.truncated === true) {
        gaps.push(recordGap(stableSourceId, state.generation, 'read_truncated', nowMs, nowMs, 0));
        capability.recordError({
          code: 'read_truncated',
          message: 'the read hit a size or entity cap; the remaining records were not observed',
          remediation: remediationFor('io_error'),
          at: nowMs,
        });
      }
      if (result.backlogRisk === true) {
        gaps.push(recordGap(stableSourceId, state.generation, 'backlog_skipped', nowMs, nowMs, 0));
        capability.recordError({
          code: 'backlog_skipped',
          message: 'the page was full, so the oldest records of the range were skipped',
          remediation: 'Reduce the polling interval or raise maxRecordsPerRead for this source',
          at: nowMs,
        });
      }
      if (result.status === 'partial') {
        const reason = permissionDenials.length > 0 ? 'permission_denied' : 'io_error';
        gaps.push(recordGap(stableSourceId, state.generation, reason, nowMs, nowMs, 0));
        capability.recordError({
          code: permissionDenials.length > 0 ? 'partial_permission' : 'partial_read',
          message: summarizeDenials(denials)
            ?? `read was structurally incomplete: ${JSON.stringify(result.stats ?? {})}`.slice(0, 480),
          remediation: remediationFor(permissionDenials.length > 0 ? 'partial_permission' : 'io_error'),
          at: nowMs,
        });
      }

      // journald rejects a vacuumed cursor: the generation must advance instead of silently
      // restarting from the head of the journal.
      if (result.resetCursor === true) {
        collector.advanceGeneration({ reason: 'adapter_reset', cursor: null });
      }

      entry.last = Object.freeze({
        status: result.status,
        at: nowMs,
        denials: Object.freeze(denials),
        records: result.records.length,
        published: published.published,
        duplicates: published.duplicates,
        hasMore: result.hasMore === true,
      });

      return Object.freeze({
        stableSourceId,
        status: result.status,
        committed: true,
        cursorState: committed,
        published: published.published,
        duplicates: published.duplicates,
        dropped: published.dropped,
        gaps: Object.freeze(gaps),
        lifecycle: capability.snapshot(nowMs).lifecycle,
        hasMore: result.hasMore === true,
        denials: Object.freeze(denials),
        error: null,
      });
    },

    /** Event sources: the independent 30 s liveness probe. */
    probeSource(stableSourceId, { at = undefined } = {}) {
      const entry = sources.get(stableSourceId);
      if (entry === undefined) {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_ARGUMENT,
          `unknown source: ${String(stableSourceId)}`,
        );
      }
      const { capability } = entry;
      if (typeof entry.adapter.probe !== 'function') {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_ARGUMENT,
          `source ${stableSourceId} is not an event source`,
        );
      }
      const nowMs = at === undefined ? clock() : at;
      return entry.adapter.probe({ at: nowMs }).then((probe) => {
        const snapshot = capability.recordSubscriptionProbe({ ok: probe.ok === true, at: nowMs });
        return Object.freeze({ stableSourceId, ...probe, lifecycle: snapshot.lifecycle });
      });
    },

    report(at = undefined) {
      const atMs = at === undefined ? clock() : at;
      const list = [];
      const degraded = [];
      const unavailable = [];
      const stale = [];
      for (const [id, entry] of sources) {
        const snapshot = entry.collector.snapshot(atMs);
        list.push(Object.freeze({
          ...snapshot,
          descriptor: Object.freeze({
            intervalMs: entry.descriptor.intervalMs,
            requiresRoot: entry.descriptor.requiresRoot,
            kind: entry.descriptor.kind,
          }),
          lastRead: entry.last,
        }));
        if (snapshot.lifecycle === 'unavailable') {
          unavailable.push(id);
        } else if (snapshot.lifecycle === 'degraded') {
          degraded.push(id);
        }
        if (snapshot.stale === true) {
          stale.push(id);
        }
      }
      return Object.freeze({
        generatedAt: toIsoTimestamp(atMs),
        sources: Object.freeze(list),
        degraded: Object.freeze(degraded),
        unavailable: Object.freeze(unavailable),
        stale: Object.freeze(stale),
        gaps: gapLedger.stats(),
      });
    },

    gaps: {
      list: () => gapLedger.list(),
      drain: () => gapLedger.drain(),
      stats: () => gapLedger.stats(),
    },

    close() {
      const ids = [...sources.keys()];
      for (const entry of sources.values()) {
        entry.capability.markStopped();
      }
      return Object.freeze(ids);
    },
  });
}
