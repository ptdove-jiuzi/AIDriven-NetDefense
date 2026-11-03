/**
 * detection-bridge.js — the seam between the wire contracts and the detection engine.
 *
 * Two incompatible shapes meet here, and only here:
 *
 * - **Contracts** (`packages/contracts`): `TelemetryEvent` with `event_id`,
 *   `stable_source_id`, `observed_at` as RFC3339 text, and a flat scalar `payload`.
 * - **Detection** (`packages/detection`): an event view with `eventId`,
 *   `observedAt` as epoch milliseconds and a nested `fields` object that rules
 *   address by dotted path.
 *
 * ## Why alerts are written as deltas
 *
 * T1 upserts an alert by **adding** `count` to the stored row and unioning
 * `event_ids` (see `event-store/src/ingest.js#upsertAlert`). Alert views that come
 * out of the detection engine carry the **cumulative** count of their window. Handing
 * a cumulative view to an additive merge would count every observation again on
 * every batch: a second matching event would store 1 + 2 = 3 observations.
 *
 * So this bridge converts a cumulative view into the **contribution of this batch**:
 * `count` becomes the number of detections in this batch that fall inside the
 * alert's window, and `event_ids` becomes exactly those event ids. The store's
 * addition then reconstructs the true total, and the daemon never has to keep its
 * own aggregate state — which is the whole point of not duplicating the transaction
 * logic.
 *
 * Three details decide whether that arithmetic stays correct:
 *
 * 1. **The window is part of the key.** A batch can straddle an aggregation-window
 *    boundary, so two alerts with the same `(rule_id, fingerprint)` but different
 *    windows can both be live. Bucketing by rule+fingerprint alone would hand each
 *    alert the other's events — and the DTO would then fail validation
 *    (`first_seen` before `window_start`, `last_seen` after `window_end`), silently
 *    dropping the alert. Detections are therefore filtered by `observedAt` against
 *    the alert's own `[windowStart, windowEnd]`.
 * 2. **`event_ids` is capped, `count` is not.** The contract allows at most 256
 *    ids per alert and requires `event_ids_truncated` exactly when `count` exceeds
 *    the ids carried. A flood batch of 300 matching events must still record
 *    `count: 300` with 256 ids and the truncation flag, not be dropped.
 * 3. **The stored alert id wins.** `upsertAlert` keys on
 *    `(fingerprint, window_start)` and keeps the *existing* row's `alert_id`. After a
 *    restart the engine mints a fresh alert id for a window that already has a row,
 *    so a request built from the engine's id would reference a non-existent alert
 *    and abort the whole T1 transaction. The caller supplies
 *    `resolveAlertId(fingerprint, windowStartIso)` reading the store, and the
 *    request is built against the id that actually exists.
 *
 * A batch that contains no new observation for an alert (the window closed, or a
 * severity-only change happened) therefore has nothing to write for that alert.
 * The stored row already holds the correct total; re-writing it would double it.
 *
 * ## Anchoring
 *
 * T1 is per event, so every derived object is attached to one *anchor* event from
 * the same batch — the most recent event of the batch that contributed to it.
 */

import { toAlert, toAnalysisRequest, toFinding } from '@aegisharness/detection';

import { toIso, fromIso } from './clock.js';

/**
 * Maximum `event_ids` an alert DTO may carry.
 *
 * Mirrors `LIMITS.maxArrayItems` in `packages/contracts`, which the alert
 * validator enforces. Kept local so the bridge does not reach into the contracts
 * package for one integer; the numbers are asserted equal in the tests.
 */
export const MAX_ALERT_EVENT_IDS = 256;

/**
 * Convert one contract telemetry event into the detection engine's event view.
 *
 * @param {object} event Validated `TelemetryEvent` value.
 * @returns {{eventId: string, observedAt: number, type: string, source: string,
 *   severity: string, fields: object}} Detection event view.
 */
export function toDetectionEvent(event) {
  const fields = { ...event.payload };
  // `meta` keeps envelope facts addressable by rules without flattening them into
  // the payload namespace, which belongs to the collector.
  fields.meta = {
    type: event.type,
    severity: event.severity,
    stable_source_id: event.stable_source_id,
    source_generation: event.source_generation,
    collector_instance_id: event.collector_instance_id,
  };
  if (typeof event.native_record_id === 'string') {
    fields.meta.native_record_id = event.native_record_id;
  }
  return {
    eventId: event.event_id,
    observedAt: fromIso(event.observed_at),
    type: event.type,
    source: event.stable_source_id,
    severity: event.severity,
    fields,
  };
}

/**
 * Convert a batch of contract events for the engine, skipping unusable ones.
 *
 * @param {readonly object[]} events Contract events.
 * @returns {{view: object[], rejected: number}} Detection views and reject count.
 */
export function toDetectionBatch(events) {
  const view = [];
  let rejected = 0;
  for (const event of events) {
    try {
      view.push(toDetectionEvent(event));
    } catch {
      rejected += 1;
    }
  }
  return { view, rejected };
}

function groupOf(groups, eventId) {
  let group = groups.get(eventId);
  if (group === undefined) {
    group = { findings: [], alerts: [], requests: [] };
    groups.set(eventId, group);
  }
  return group;
}

/**
 * Index this batch's detections by the rule and fingerprint that identify an alert.
 *
 * @param {readonly object[]} detections Detection entries.
 * @param {Set<string>} batchEventIds Event ids present in this batch.
 * @returns {Map<string, {eventId: string, observedAt: number}[]>} Observations per key.
 */
function indexDetections(detections, batchEventIds) {
  const index = new Map();
  for (const detection of detections) {
    const eventId = (detection.eventIds ?? []).find((id) => batchEventIds.has(id));
    if (eventId === undefined) {
      continue;
    }
    const key = `${detection.ruleId}\u0000${detection.fingerprint}`;
    const list = index.get(key) ?? [];
    list.push({ eventId, observedAt: detection.observedAt });
    index.set(key, list);
  }
  return index;
}

/**
 * Build the per-anchor write plan for one detection batch result.
 *
 * @param {{
 *   result: object,
 *   events: readonly object[],
 *   epoch: string,
 *   allowedSummaryFields: readonly string[],
 *   budgetClass?: string,
 *   alertStatus?: string,
 *   resolveAlertId?: (fingerprint: string, windowStartIso: string) => string|null
 * }} input Batch result plus conversion policy.
 * @returns {{
 *   groups: Map<string, {findings: object[], alerts: object[], requests: object[]}>,
 *   counters: object
 * }} Write plan.
 */
export function buildWritePlan(input) {
  const { result, events } = input;
  const epoch = input.epoch;
  if (typeof epoch !== 'string' || epoch.length === 0) {
    throw new TypeError('buildWritePlan requires a non-empty epoch');
  }
  const allowedSummaryFields = input.allowedSummaryFields ?? [];
  const budgetClass = input.budgetClass ?? 'standard';
  const alertStatus = input.alertStatus ?? 'new';
  const resolveAlertId = typeof input.resolveAlertId === 'function' ? input.resolveAlertId : null;

  const batchEventIds = new Set();
  /** Write order, for anchor selection: T1 calls run in this order, not in event time. */
  const batchPosition = new Map();
  events.forEach((event, index) => {
    batchEventIds.add(event.event_id);
    if (!batchPosition.has(event.event_id)) {
      batchPosition.set(event.event_id, index);
    }
  });

  const groups = new Map();
  const counters = {
    findings: 0,
    alerts: 0,
    requests: 0,
    rejected: 0,
    /** Alerts with no new observation in this batch: nothing to add. */
    skipped_no_new_observation: 0,
    /** Alerts dropped because their derived DTO failed validation (a real bug). */
    dropped_alerts: 0,
    /** Contributions whose `event_ids` had to be capped (count kept exact). */
    truncated_alerts: 0,
    /** Requests rewritten to the alert id already present in the store. */
    resolved_alert_ids: 0,
  };

  // Findings: one per detection, anchored on that detection's own event.
  for (const detection of result.detections ?? []) {
    const eventId = (detection.eventIds ?? []).find((id) => batchEventIds.has(id));
    if (eventId === undefined) {
      counters.skipped_no_new_observation += 1;
      continue;
    }
    try {
      groupOf(groups, eventId).findings.push(toFinding(detection, { status: 'new' }));
      counters.findings += 1;
    } catch {
      counters.rejected += 1;
    }
  }

  const observations = indexDetections(result.detections ?? [], batchEventIds);
  const anchorByAlert = new Map();
  /** @type {Map<string, object>} */
  const alertViews = new Map();
  for (const view of [...(result.alerts ?? []), ...(result.closedAlerts ?? [])]) {
    if (!alertViews.has(view.alertId)) {
      alertViews.set(view.alertId, view);
    }
  }

  for (const view of alertViews.values()) {
    const key = `${view.ruleId}\u0000${view.fingerprint}`;
    const candidates = observations.get(key) ?? [];
    // The window is part of the identity: a batch can straddle two windows. The
    // interval is half-open — the engine floors an observation into its window — so an
    // event exactly on `windowEnd` belongs to the NEXT window. Using `<=` here would
    // count it in both and double the totals of both rows.
    const contributing = candidates
      .filter((entry) => entry.observedAt >= view.windowStart && entry.observedAt < view.windowEnd)
      .sort((left, right) => left.observedAt - right.observedAt);
    if (contributing.length === 0) {
      counters.skipped_no_new_observation += 1;
      continue;
    }

    const uniqueIds = [...new Set(contributing.map((entry) => entry.eventId))];
    const count = uniqueIds.length;
    // The store keeps the FIRST ids it is given and stops appending once the row
    // holds the cap, so the batch contributes its earliest ids to stay consistent
    // with that policy. `count` remains exact either way; the id list is evidence,
    // not a tally.
    const cappedIds = uniqueIds.length > MAX_ALERT_EVENT_IDS
      ? uniqueIds.slice(0, MAX_ALERT_EVENT_IDS)
      : uniqueIds;
    if (cappedIds.length !== uniqueIds.length) {
      counters.truncated_alerts += 1;
    }
    // The anchor is the *latest written* contributing event, not the latest observed one.
    // `ingestBatch` walks the batch in array order, and a T1 call writes its own event
    // before its alerts, so an alert anchored on an earlier array slot would commit a row
    // citing events that have not been written yet — and if one of those writes then
    // fails, the citation is dangling forever. A batch whose `observed_at` order differs
    // from its array order (late-arriving records, clock skew between collectors) is
    // exactly where those two orders diverge; detection sorts by time, so the anchor must
    // be chosen by write order instead.
    let anchor = cappedIds[0];
    let anchorPosition = -1;
    for (const id of uniqueIds) {
      const position = batchPosition.get(id);
      if (position !== undefined && position > anchorPosition) {
        anchorPosition = position;
        anchor = id;
      }
    }
    const firstSeen = contributing[0].observedAt;
    const lastSeen = contributing[contributing.length - 1].observedAt;

    let alertId = view.alertId;
    if (resolveAlertId !== null) {
      try {
        const existing = resolveAlertId(view.fingerprint, toIso(view.windowStart));
        if (typeof existing === 'string' && existing.length > 0) {
          alertId = existing;
          counters.resolved_alert_ids += 1;
        }
      } catch {
        // A failed lookup is not fatal: the write below either succeeds with the
        // engine id (new row) or fails the T1 transaction, which is counted.
      }
    }

    try {
      const contribution = toAlert({
        ...view,
        alertId,
        count,
        eventIds: cappedIds,
        eventIdsTruncated: count > cappedIds.length,
        firstSeen,
        lastSeen,
      }, { status: alertStatus });
      groupOf(groups, anchor).alerts.push(contribution);
      anchorByAlert.set(view.alertId, { anchor, alertId });
      counters.alerts += 1;
    } catch {
      counters.rejected += 1;
      counters.dropped_alerts += 1;
    }
  }

  // Analysis requests: the outbox row has a foreign key on the alert, so a request
  // is only written in the same T1 call as the alert contribution that created it.
  for (const request of result.analysisRequests ?? []) {
    const target = anchorByAlert.get(request.alertId) ?? null;
    const view = alertViews.get(request.alertId);
    if (target === null || view === undefined) {
      counters.rejected += 1;
      continue;
    }
    try {
      const dto = toAnalysisRequest({ ...request, alertId: target.alertId }, view, {
        epoch,
        allowedSummaryFields: [...allowedSummaryFields],
        budgetClass,
      });
      groupOf(groups, target.anchor).requests.push(dto);
      counters.requests += 1;
    } catch {
      counters.rejected += 1;
    }
  }

  return { groups, counters };
}
