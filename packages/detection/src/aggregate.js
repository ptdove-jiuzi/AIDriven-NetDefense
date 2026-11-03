/**
 * aggregate.js — alert record lifecycle: 15 minute windows, severity hysteresis,
 * escalation cooling and alert status transitions.
 *
 * The module is a set of functions over one mutable alert record; it owns no
 * storage and reads no clock, so every transition is a pure consequence of the
 * observations passed in.
 */

import { createRandomIdFactory } from './ids.js';
import { maxSeverity, severityByRank, severityRank } from './severity.js';

/** Default aggregation window: 15 minutes. */
export const DEFAULT_AGGREGATION_WINDOW_MS = 900000;

/** Allowed alert statuses. @type {readonly string[]} */
export const ALERT_STATUSES = Object.freeze(['new', 'acknowledged', 'resolved', 'suppressed']);

const TRANSITIONS = Object.freeze({
  new: Object.freeze(['acknowledged', 'suppressed']),
  acknowledged: Object.freeze(['resolved', 'suppressed']),
  suppressed: Object.freeze(['new', 'resolved']),
  resolved: Object.freeze([]),
});

/**
 * Start of the aggregation window that contains an instant, aligned to UTC.
 *
 * @param {number} at Epoch milliseconds.
 * @param {number} windowMs Window length in milliseconds.
 * @returns {number} Window start in epoch milliseconds.
 */
export function windowStartFor(at, windowMs) {
  return Math.floor(at / windowMs) * windowMs;
}

/**
 * Build a fresh alert record.
 *
 * `inherited` carries the published severity and escalation bookkeeping from the
 * previous window of the same fingerprint, so a window roll never jumps straight
 * to the newest observed level.
 *
 * `nextId` is the injected id factory. Omitting it falls back to the CSPRNG
 * factory so direct callers keep working; the engine always passes one in.
 *
 * @param {{
 *   fingerprint: string,
 *   ruleId: string,
 *   ruleVersion: string,
 *   ruleType: string,
 *   windowStart: number,
 *   windowMs: number,
 *   inherited: null | { severity: string | null, lastEscalationAt: number | null, pendingEscalation: object | null },
 *   nextId?: (kind: string) => string
 * }} input Alert seed.
 * @returns {object} Mutable alert record.
 */
export function createAlert(input) {
  const inherited = input.inherited;
  const nextId = input.nextId === undefined ? createRandomIdFactory().next : input.nextId;
  return {
    alertId: nextId('alert'),
    fingerprint: input.fingerprint,
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    ruleType: input.ruleType,
    severity: inherited === null ? null : inherited.severity,
    peakSeverity: null,
    windowStart: input.windowStart,
    windowEnd: input.windowStart + input.windowMs,
    closed: false,
    firstSeen: null,
    lastSeen: null,
    count: 0,
    eventIds: [],
    eventIdsTruncated: false,
    status: 'new',
    escalations: [],
    downgrades: [],
    pendingEscalation: inherited === null ? null : inherited.pendingEscalation,
    analysisRequested: 0,
    lastEscalationAt: inherited === null ? null : inherited.lastEscalationAt,
    downgradeSince: null,
    lastObservedSeverity: inherited === null ? null : inherited.severity,
  };
}

/**
 * Record that an observation belongs to the alert's window.
 *
 * Count is always complete; `eventIds` is capped and flags truncation instead.
 *
 * `observedAt` may go backwards (store-and-forward pipelines deliver late
 * events, and nothing in the event shape forbids it). The alert therefore never
 * trusts the arrival order: `firstSeen` is a minimum and `lastSeen` a maximum,
 * and a regressed observation still counts, because dropping it would silently
 * lose an event. The only regression that is rejected is a *window* going
 * backwards, which `engine.aggregate()` records as a `late-window` gap; the
 * hourly analysis bucket is unaffected because it is keyed by its own hour
 * (`rate-limit.js`).
 *
 * @param {object} alert Alert record.
 * @param {{ observedAt: number, eventId: string, maxEventIds: number }} observation Observation to add.
 * @returns {void}
 */
export function addObservation(alert, observation) {
  alert.count += 1;
  alert.firstSeen = alert.firstSeen === null ? observation.observedAt : Math.min(alert.firstSeen, observation.observedAt);
  alert.lastSeen = alert.lastSeen === null ? observation.observedAt : Math.max(alert.lastSeen, observation.observedAt);
  if (alert.eventIds.length < observation.maxEventIds) {
    alert.eventIds.push(observation.eventId);
  } else {
    alert.eventIdsTruncated = true;
  }
}

/**
 * Apply one severity observation.
 *
 * Escalation requires a strictly higher rank, a rank delta of at least
 * `escalationStep`, and either no previous escalation or a diff of at least
 * `escalationCooldownMs`. A blocked escalation becomes `pendingEscalation` and is
 * finalised by {@link advanceAlert}. Downgrades are hysteretic: they are blocked
 * while the window peak is at or above the published severity, and each dwell
 * period lowers the severity by exactly one rank.
 *
 * @param {object} alert Alert record.
 * @param {string} observed Observed severity level.
 * @param {number} at Epoch milliseconds of the observation.
 * @param {{ escalationCooldownMs: number, escalationStep: number, downgradeDwellMs: number }} limits Severity limits.
 * @returns {{ established: boolean, escalated: boolean, deferred: boolean, downgraded: boolean, changed: boolean }} Transition summary.
 */
export function observeSeverity(alert, observed, at, limits) {
  const observedRank = severityRank(observed);
  const result = { established: false, escalated: false, deferred: false, downgraded: false, changed: false };
  if (alert.peakSeverity === null || observedRank > severityRank(alert.peakSeverity)) {
    alert.peakSeverity = observed;
    alert.downgradeSince = null;
  }
  alert.lastObservedSeverity = observed;
  if (alert.severity === null) {
    alert.severity = observed;
    result.established = true;
    result.changed = true;
    return result;
  }
  const delta = observedRank - severityRank(alert.severity);
  if (delta > 0) {
    if (delta < limits.escalationStep) {
      return result;
    }
    const cooldownElapsed =
      alert.lastEscalationAt === null || at - alert.lastEscalationAt >= limits.escalationCooldownMs;
    if (cooldownElapsed) {
      applyEscalation(alert, alert.severity, observed, at);
      result.escalated = true;
      result.changed = true;
      return result;
    }
    const pendingTarget = maxSeverity(alert.pendingEscalation === null ? null : alert.pendingEscalation.severity, observed);
    const duplicate = alert.escalations.some(
      (entry) => entry.from === alert.severity && entry.to === pendingTarget && entry.deferred === true,
    );
    if (!duplicate) {
      alert.escalations.push({ from: alert.severity, to: pendingTarget, at, deferred: true });
    }
    alert.pendingEscalation = {
      severity: pendingTarget,
      dueAt: alert.lastEscalationAt + limits.escalationCooldownMs,
    };
    result.deferred = true;
    return result;
  }
  if (delta < 0) {
    result.downgraded = tryDowngrade(alert, at, limits);
    result.changed = result.downgraded;
  }
  return result;
}

/**
 * Settle a due pending escalation.
 *
 * Called before every new observation of the same fingerprint and by
 * {@link advanceAlert}, so an observation that arrives exactly at the due time
 * finalises the deferred record instead of appending a second one.
 *
 * @param {object} alert Alert record.
 * @param {number} at Epoch milliseconds of the check.
 * @returns {{ escalated: boolean, changed: boolean }} Transition summary.
 */
export function settlePendingEscalation(alert, at) {
  const result = { escalated: false, changed: false };
  if (alert.pendingEscalation === null || at < alert.pendingEscalation.dueAt) {
    return result;
  }
  const target = alert.pendingEscalation.severity;
  const from = alert.severity;
  if (severityRank(target) > severityRank(from)) {
    alert.severity = target;
    alert.lastEscalationAt = at;
    alert.pendingEscalation = null;
    if (severityRank(target) > severityRank(alert.peakSeverity)) {
      alert.peakSeverity = target;
    }
    recordEscalation(alert, from, target, at, { deferred: false, appliedFromPending: true });
    result.escalated = true;
    result.changed = true;
    return result;
  }
  alert.pendingEscalation = null;
  return result;
}

/**
 * Apply time-driven transitions: a due pending escalation and a due downgrade
 * dwell period.
 *
 * @param {object} alert Alert record.
 * @param {number} at Epoch milliseconds of the advance.
 * @param {{ escalationCooldownMs: number, downgradeDwellMs: number }} limits Severity limits.
 * @returns {{ escalated: boolean, downgraded: boolean, changed: boolean }} Transition summary.
 */
export function advanceAlert(alert, at, limits) {
  const settled = settlePendingEscalation(alert, at);
  const result = { escalated: settled.escalated, downgraded: false, changed: settled.changed };
  if (alert.downgradeSince !== null && at - alert.downgradeSince >= limits.downgradeDwellMs) {
    result.downgraded = tryDowngrade(alert, at, limits);
    result.changed = result.changed || result.downgraded;
  }
  return result;
}

/**
 * Close a window.
 *
 * @param {object} alert Alert record.
 * @returns {object} The same record with `closed` set.
 */
export function closeAlert(alert) {
  alert.closed = true;
  return alert;
}

/**
 * Apply a status transition.
 *
 * @param {object} alert Alert record.
 * @param {string} status Target status.
 * @returns {boolean} `true` when the transition is allowed and applied.
 */
export function setAlertStatus(alert, status) {
  const allowed = TRANSITIONS[alert.status];
  if (allowed === undefined || !allowed.includes(status)) {
    return false;
  }
  alert.status = status;
  return true;
}

/**
 * Report whether a status transition is allowed.
 *
 * @param {string} from Current status.
 * @param {string} to Target status.
 * @returns {boolean} `true` when allowed.
 */
export function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/**
 * Build the public, JSON stable view of an alert.
 *
 * Internal bookkeeping (`lastEscalationAt`, `downgradeSince`, `lastObservedSeverity`)
 * is not part of the contract and is omitted.
 *
 * @param {object} alert Alert record.
 * @returns {object} Plain object with a fixed key order.
 */
export function alertView(alert) {
  return {
    alertId: alert.alertId,
    fingerprint: alert.fingerprint,
    ruleId: alert.ruleId,
    ruleVersion: alert.ruleVersion,
    severity: alert.severity,
    peakSeverity: alert.peakSeverity,
    windowStart: alert.windowStart,
    windowEnd: alert.windowEnd,
    closed: alert.closed,
    firstSeen: alert.firstSeen,
    lastSeen: alert.lastSeen,
    count: alert.count,
    eventIds: [...alert.eventIds],
    eventIdsTruncated: alert.eventIdsTruncated,
    status: alert.status,
    escalations: alert.escalations.map((entry) => ({ ...entry })),
    downgrades: alert.downgrades.map((entry) => ({ ...entry })),
    pendingEscalation: alert.pendingEscalation === null ? null : { ...alert.pendingEscalation },
    analysisRequested: alert.analysisRequested,
  };
}

function applyEscalation(alert, from, to, at) {
  alert.severity = to;
  alert.lastEscalationAt = at;
  alert.pendingEscalation = null;
  recordEscalation(alert, from, to, at, {});
}

/**
 * Append one escalation record, or finalise the deferred record of the same
 * `(from, to)` pair in place. A single severity change therefore never produces
 * two records, no matter whether the observation or the clock reaches the due
 * time first.
 *
 * @param {object} alert Alert record.
 * @param {string | null} from Previous published severity.
 * @param {string} to New published severity.
 * @param {number} at Epoch milliseconds the change became effective.
 * @param {object} extra Additional record fields for fresh records.
 * @returns {void}
 */
function recordEscalation(alert, from, to, at, extra) {
  for (let index = alert.escalations.length - 1; index >= 0; index -= 1) {
    const entry = alert.escalations[index];
    if (entry.from === from && entry.to === to && entry.deferred === true) {
      entry.deferredAt = entry.at;
      entry.at = at;
      entry.deferred = false;
      entry.appliedAt = at;
      entry.appliedFromPending = true;
      return;
    }
  }
  alert.escalations.push({ from, to, at, ...extra });
}

function tryDowngrade(alert, at, limits) {
  if (alert.severity === null) {
    return false;
  }
  const currentRank = severityRank(alert.severity);
  const peakRank = severityRank(alert.peakSeverity);
  const observedRank = severityRank(alert.lastObservedSeverity);
  const floor = Math.max(peakRank, observedRank);
  if (currentRank <= floor) {
    alert.downgradeSince = null;
    return false;
  }
  if (alert.downgradeSince === null) {
    alert.downgradeSince = at;
    return false;
  }
  if (at - alert.downgradeSince < limits.downgradeDwellMs) {
    return false;
  }
  const nextRank = Math.max(currentRank - 1, floor);
  const from = alert.severity;
  alert.severity = severityByRank(nextRank);
  alert.downgrades.push({ from, to: alert.severity, at });
  alert.downgradeSince = nextRank > floor ? at : null;
  return true;
}
