/**
 * Per-source capability and freshness state (§5.1).
 *
 * Liveness and freshness are separate: a collector process can be alive while its data
 * is stale, and that must never be reported as healthy. Poll sources go stale when no
 * read succeeded for `staleAfterCycles` intervals. Event-driven sources are judged only
 * by the independent subscription health probe, because a long period with zero business
 * events is not a fault and a business event is not proof that the subscription is still
 * healthy.
 *
 * Time: an optional `monotonic` clock supplies elapsed durations (wall clock stays for
 * display). Without it the wall clock is used, and a negative elapsed time is reported as
 * `stale` with `staleReason: 'clock_regression'` rather than as fresh.
 */

import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  assertTimestamp,
  toIsoTimestamp,
} from './errors.js';
import { assertCollectorInstanceId, assertStableSourceId } from './ids.js';
import { LIMITS } from './limits.js';

export const LIFECYCLES = Object.freeze(['starting', 'ready', 'degraded', 'unavailable', 'stopping', 'stopped']);
export const FRESHNESS = Object.freeze(['starting', 'fresh', 'stale', 'unavailable', 'stopped']);

export const STALE_REASONS = Object.freeze(['no_progress', 'subscription_probe_overdue', 'clock_regression']);

export const COLLECTOR_KINDS = Object.freeze(['poll', 'event']);

export const DEFAULT_SUBSCRIPTION_REMEDIATION = 'Verify read permission for the log subscription and restart the collector';

const TERMINAL_LIFECYCLES = new Set(['stopping', 'stopped']);
const PERMISSION_CODES = new Set(['permission_denied']);

function isoOrNull(value) {
  return value === null ? null : toIsoTimestamp(value);
}

export function createCapability({
  stableSourceId,
  collectorInstanceId,
  kind = 'poll',
  intervalMs = 5_000,
  subscriptionProbeIntervalMs = LIMITS.subscriptionProbeIntervalMs,
  staleAfterCycles = LIMITS.pollStaleCycles,
  staleAfterProbes = LIMITS.subscriptionStaleProbes,
  clock = Date.now,
  monotonic = null,
} = {}) {
  assertStableSourceId(stableSourceId);
  assertCollectorInstanceId(collectorInstanceId);
  if (!COLLECTOR_KINDS.includes(kind)) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      `Unknown collector kind: ${String(kind)}`,
      { kind: typeof kind === 'string' ? kind : null },
    );
  }
  assertInteger('intervalMs', intervalMs, { min: 1 });
  assertInteger('subscriptionProbeIntervalMs', subscriptionProbeIntervalMs, { min: 1 });
  assertInteger('staleAfterCycles', staleAfterCycles, { min: 1 });
  assertInteger('staleAfterProbes', staleAfterProbes, { min: 1 });
  if (typeof clock !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function returning epoch milliseconds');
  }
  if (monotonic !== null && typeof monotonic !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'monotonic must be null or a function');
  }

  const startedAtMs = Math.trunc(assertTimestamp('capability clock', clock()));
  const startedAt = toIsoTimestamp(startedAtMs);

  function readMono() {
    if (monotonic === null) {
      return null;
    }
    const value = monotonic();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'monotonic clock must return a finite number');
    }
    return Math.trunc(value);
  }

  const startedMono = readMono();

  let declaredLifecycle = 'starting';
  let lastSuccessMs = null;
  let lastSuccessMono = null;
  let lastEventMs = null;
  let lastValidSubscriptionMs = null;
  let lastValidSubscriptionMono = null;
  let recoveredAt = null;
  let lastError = null;
  let lastGap = null;
  let remediation = null;
  let permissions = Object.freeze({ granted: Object.freeze([]), missing: Object.freeze([]) });
  let fatalError = false;
  let fatalCause = null;
  let permissionMissing = false;
  let errorDegraded = false;
  let subscriptionFailed = false;
  let hasProgress = false;

  function readClock() {
    return Math.trunc(assertTimestamp('capability clock', clock()));
  }

  function applyLifecycle() {
    if (TERMINAL_LIFECYCLES.has(declaredLifecycle)) {
      return;
    }
    if (fatalError || permissionMissing) {
      declaredLifecycle = 'unavailable';
      return;
    }
    if (errorDegraded || subscriptionFailed) {
      declaredLifecycle = 'degraded';
      return;
    }
    declaredLifecycle = hasProgress ? 'ready' : 'starting';
  }

  function snapshotAt(at) {
    const nowMs = at === undefined || at === null
      ? readClock()
      : Math.trunc(assertTimestamp('snapshot at', at));

    let freshness;
    let stale = false;
    let staleReason = null;
    let staleForMs = 0;

    if (TERMINAL_LIFECYCLES.has(declaredLifecycle)) {
      freshness = 'stopped';
    } else if (declaredLifecycle === 'unavailable') {
      freshness = 'unavailable';
    } else {
      // Event sources are judged exclusively by the subscription probe; `lastEvent` is
      // display only, so zero business events can never fake a healthy subscription.
      const progressWallMs = kind === 'poll' ? lastSuccessMs : lastValidSubscriptionMs;
      const progressMono = kind === 'poll' ? lastSuccessMono : lastValidSubscriptionMono;
      const thresholdMs = kind === 'poll'
        ? staleAfterCycles * intervalMs
        : staleAfterProbes * subscriptionProbeIntervalMs;

      let elapsedMs;
      if (monotonic === null) {
        const referenceMs = progressWallMs ?? startedAtMs;
        elapsedMs = nowMs - referenceMs;
      } else {
        const referenceMono = progressMono ?? startedMono;
        elapsedMs = readMono() - referenceMono;
      }

      if (elapsedMs < 0) {
        stale = true;
        staleReason = 'clock_regression';
        staleForMs = Math.abs(elapsedMs);
        freshness = 'stale';
      } else if (elapsedMs > thresholdMs) {
        stale = true;
        staleReason = kind === 'poll' ? 'no_progress' : 'subscription_probe_overdue';
        staleForMs = elapsedMs;
        freshness = 'stale';
      } else if (progressWallMs === null) {
        freshness = 'starting';
      } else {
        freshness = 'fresh';
      }
    }

    let lifecycle = declaredLifecycle;
    if (stale && (lifecycle === 'ready' || lifecycle === 'starting' || lifecycle === 'degraded')) {
      lifecycle = 'degraded';
    }

    return Object.freeze({
      stableSourceId,
      collectorInstanceId,
      kind,
      intervalMs,
      lifecycle,
      declaredLifecycle,
      freshness,
      stale,
      staleReason,
      staleForMs,
      lastSuccess: isoOrNull(lastSuccessMs),
      lastEvent: isoOrNull(lastEventMs),
      lastError,
      lastGap,
      lastValidSubscription: isoOrNull(lastValidSubscriptionMs),
      permissions,
      remediation,
      startedAt,
      recoveredAt,
    });
  }

  return Object.freeze({
    recordSuccess(at = undefined) {
      const atMs = at === undefined ? readClock() : Math.trunc(assertTimestamp('recordSuccess at', at));
      lastSuccessMs = atMs;
      lastSuccessMono = readMono();
      hasProgress = true;
      if (errorDegraded && !fatalError) {
        errorDegraded = false;
        recoveredAt = toIsoTimestamp(readClock());
      }
      if (!fatalError && !permissionMissing && !errorDegraded && !subscriptionFailed) {
        remediation = null;
      }
      applyLifecycle();
      return snapshotAt();
    },

    recordEvent(at = undefined) {
      lastEventMs = at === undefined ? readClock() : Math.trunc(assertTimestamp('recordEvent at', at));
      return snapshotAt();
    },

    recordError({
      code,
      message = '',
      remediation: remediationText,
      fatal = false,
      at = undefined,
    } = {}) {
      if (typeof code !== 'string' || code.length === 0) {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'error code must be a non-empty string');
      }
      if (typeof remediationText !== 'string' || remediationText.trim().length === 0) {
        throw new CollectorError(
          ERROR_CODES.INVALID_ARGUMENT,
          'recordError requires a non-empty remediation text',
          { code },
        );
      }
      if (typeof message !== 'string') {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'error message must be a string');
      }

      const atMs = at === undefined ? readClock() : Math.trunc(assertTimestamp('recordError at', at));
      const isFatal = fatal === true || PERMISSION_CODES.has(code);
      lastError = Object.freeze({
        code,
        message,
        remediation: remediationText,
        fatal: isFatal,
        at: toIsoTimestamp(atMs),
      });
      remediation = remediationText;
      hasProgress = true;

      if (isFatal) {
        fatalError = true;
        fatalCause = PERMISSION_CODES.has(code) ? 'permission_denied' : 'collector_error';
      } else {
        errorDegraded = true;
      }
      applyLifecycle();
      return snapshotAt();
    },

    recordGap(gap = {}) {
      if (typeof gap.reason !== 'string' || gap.reason.length === 0) {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'gap reason must be a non-empty string');
      }
      const count = gap.count === undefined ? 1 : assertInteger('gap count', gap.count, { min: 0 });
      lastGap = Object.freeze({
        reason: gap.reason,
        start: toIsoTimestamp(assertTimestamp('gap start', gap.start)),
        end: toIsoTimestamp(assertTimestamp('gap end', gap.end === undefined ? gap.start : gap.end)),
        count,
      });
      return snapshotAt();
    },

    recordSubscriptionProbe({ ok, at = undefined } = {}) {
      if (typeof ok !== 'boolean') {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'subscription probe result must be a boolean');
      }
      const atMs = at === undefined ? readClock() : Math.trunc(assertTimestamp('probe at', at));

      if (ok) {
        lastValidSubscriptionMs = atMs;
        lastValidSubscriptionMono = readMono();
        hasProgress = true;
        subscriptionFailed = false;
        if (lastError !== null && lastError.code === 'subscription_probe_failed') {
          lastError = null;
        }
        if (!errorDegraded) {
          remediation = null;
        }
      } else {
        subscriptionFailed = true;
        hasProgress = true;
        lastError = Object.freeze({
          code: 'subscription_probe_failed',
          message: 'Subscription health probe did not succeed',
          remediation: DEFAULT_SUBSCRIPTION_REMEDIATION,
          fatal: false,
          at: toIsoTimestamp(atMs),
        });
        remediation = DEFAULT_SUBSCRIPTION_REMEDIATION;
      }

      applyLifecycle();
      return snapshotAt(atMs);
    },

    setPermissions({ granted = [], missing = [] } = {}) {
      if (!Array.isArray(granted) || granted.some((item) => typeof item !== 'string' || item.length === 0)) {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'granted permissions must be non-empty strings');
      }
      if (!Array.isArray(missing) || missing.some((item) => typeof item !== 'string' || item.length === 0)) {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'missing permissions must be non-empty strings');
      }

      permissions = Object.freeze({
        granted: Object.freeze([...granted]),
        missing: Object.freeze([...missing]),
      });

      if (missing.length > 0) {
        permissionMissing = true;
        fatalError = true;
        fatalCause = 'permission_denied';
        const text = `Missing required permissions: ${missing.join(', ')}`;
        remediation = text;
        lastError = Object.freeze({
          code: 'permission_denied',
          message: `Access to ${missing.join(', ')} was denied`,
          remediation: text,
          fatal: true,
          at: toIsoTimestamp(readClock()),
        });
      } else {
        permissionMissing = false;
        if (fatalError && fatalCause === 'permission_denied') {
          // The denied permission is the whole reason the source was unavailable, so a
          // successful re-check must unlatch it. `lastError` stays as history.
          fatalError = false;
          fatalCause = null;
          remediation = null;
          recoveredAt = toIsoTimestamp(readClock());
        }
      }

      applyLifecycle();
      return snapshotAt();
    },

    markStopping() {
      declaredLifecycle = 'stopping';
      return snapshotAt();
    },

    markStopped() {
      declaredLifecycle = 'stopped';
      return snapshotAt();
    },

    snapshot(at = undefined) {
      return snapshotAt(at);
    },
  });
}
