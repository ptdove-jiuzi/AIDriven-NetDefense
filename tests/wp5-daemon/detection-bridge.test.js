/**
 * detection-bridge.test.js — the two-shape seam.
 *
 * The cases worth locking down are the ones that are easy to get subtly wrong:
 * the millisecond conversion, the delta arithmetic against a capped `event_ids`
 * list, and the rule that an analysis request can only be written together with
 * the alert it references.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWritePlan, toDetectionBatch, toDetectionEvent } from '../../apps/daemon/src/detection-bridge.js';
import { buildSummaryDto } from '@aegisharness/detection';
import { BASE_ISO, TEST_EPOCH, makeEvent } from './helpers.js';

const EPOCH = TEST_EPOCH;

function makeAlertView(overrides = {}) {
  return {
    alertId: '11111111-1111-4111-8111-111111111111',
    ruleId: 'proc.suspicious-start',
    ruleVersion: '1.0.0',
    fingerprint: 'f'.repeat(64),
    severity: 'high',
    status: 'new',
    firstSeen: 1793577600000,
    lastSeen: 1793577600000,
    windowStart: 1793577600000,
    windowEnd: 1793578500000,
    count: 1,
    eventIds: [],
    eventIdsTruncated: false,
    ...overrides,
  };
}

function makeDetection(eventId, overrides = {}) {
  return {
    detectionId: '22222222-2222-4222-8222-222222222222',
    ruleId: 'proc.suspicious-start',
    ruleVersion: '1.0.0',
    fingerprint: 'f'.repeat(64),
    severity: 'high',
    observedAt: 1793577600000,
    eventIds: [eventId],
    ...overrides,
  };
}

describe('toDetectionEvent', () => {
  it('maps the contract envelope into the engine shape', () => {
    const event = makeEvent({ source_seq: 4, native_record_id: 'rec-9' });
    const view = toDetectionEvent(event);
    assert.equal(view.eventId, event.event_id);
    assert.equal(view.type, 'process.start');
    assert.equal(view.source, 'synthetic.process');
    assert.equal(view.severity, 'high');
    assert.equal(view.observedAt, Date.parse(BASE_ISO));
    assert.equal(view.fields.process_name, 'evil.exe');
    assert.equal(view.fields.meta.type, 'process.start');
    assert.equal(view.fields.meta.native_record_id, 'rec-9');
    assert.equal(view.fields.meta.source_generation, 1);
  });

  it('refuses a timestamp the contracts would not have accepted', () => {
    const event = makeEvent();
    assert.throws(() => toDetectionEvent({ ...event, observed_at: '2026-11-02T00:00:00Z' }), (error) => {
      assert.equal(error.code, 'BATCH_INVALID');
      return true;
    });
  });

  it('counts unusable events instead of guessing a time', () => {
    const good = makeEvent({ source_seq: 1 });
    const bad = { ...makeEvent({ source_seq: 2 }), observed_at: 'yesterday' };
    const batch = toDetectionBatch([good, bad]);
    assert.equal(batch.view.length, 1);
    assert.equal(batch.rejected, 1);
  });
});

describe('buildWritePlan', () => {
  it('requires an epoch', () => {
    assert.throws(() => buildWritePlan({ result: {}, events: [], epoch: '' }), TypeError);
  });

  it('anchors each finding on its own event', () => {
    const events = [makeEvent({ source_seq: 1 }), makeEvent({ source_seq: 2 })];
    const plan = buildWritePlan({
      result: {
        detections: [makeDetection(events[0].event_id), makeDetection(events[1].event_id)],
        alerts: [],
        analysisRequests: [],
      },
      events,
      epoch: EPOCH,
    });
    assert.equal(plan.counters.findings, 2);
    assert.equal(plan.groups.get(events[0].event_id).findings.length, 1);
    assert.equal(plan.groups.get(events[1].event_id).findings.length, 1);
  });

  it('writes the batch contribution, not the cumulative window total', () => {
    const event = makeEvent({ source_seq: 1 });
    const plan = buildWritePlan({
      result: {
        detections: [makeDetection(event.event_id)],
        // The engine reports 7 observations so far; only one is from this batch.
        alerts: [makeAlertView({ count: 7, eventIds: [event.event_id, 'older-1', 'older-2'] })],
        analysisRequests: [],
      },
      events: [event],
      epoch: EPOCH,
    });
    const group = plan.groups.get(event.event_id);
    assert.equal(group.alerts.length, 1);
    assert.equal(group.alerts[0].count, 1);
    assert.deepEqual(group.alerts[0].event_ids, [event.event_id]);
  });

  it('counts a contribution beyond the 32-event id cap of the view', () => {
    const events = Array.from({ length: 40 }, (_unused, index) => makeEvent({ source_seq: index + 1 }));
    const detections = events.map((event) => makeDetection(event.event_id));
    const plan = buildWritePlan({
      result: {
        detections,
        // The engine caps `eventIds` at 32 but keeps `count` complete.
        alerts: [makeAlertView({ count: 40, eventIds: events.slice(0, 32).map((event) => event.event_id) })],
        analysisRequests: [],
      },
      events,
      epoch: EPOCH,
    });
    let total = 0;
    for (const group of plan.groups.values()) {
      total += group.alerts.reduce((sum, alert) => sum + alert.count, 0);
    }
    // Deltas are distributed per anchor; the SUM must be the true observation count.
    assert.equal(total, 40);
  });

  it('skips an alert whose window changed with no new observation', () => {
    const event = makeEvent({ source_seq: 1 });
    const plan = buildWritePlan({
      result: {
        detections: [],
        alerts: [makeAlertView({ count: 3 })],
        closedAlerts: [makeAlertView({ count: 3 })],
        analysisRequests: [],
      },
      events: [event],
      epoch: EPOCH,
    });
    assert.equal(plan.counters.alerts, 0);
    assert.equal(plan.counters.skipped_no_new_observation, 1);
    assert.equal(plan.groups.size, 0);
  });

  it('writes an analysis request only next to its alert', () => {
    const event = makeEvent({ source_seq: 1 });
    const alert = makeAlertView({ eventIds: [event.event_id] });
    const summaryDto = buildSummaryDto({ alertId: alert.alertId, sequenceInHour: 1 }, alert, {});
    const plan = buildWritePlan({
      result: {
        detections: [makeDetection(event.event_id)],
        alerts: [alert],
        analysisRequests: [{
          requestId: '33333333-3333-4333-8333-333333333331',
          alertId: alert.alertId,
          budgetClass: 'standard',
          createdAt: 1793577600000,
          idempotencyKey: 'a'.repeat(43),
          sequenceInHour: 1,
          summaryDto,
        }],
      },
      events: [event],
      epoch: EPOCH,
      allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
      budgetClass: 'standard',
    });
    const group = plan.groups.get(event.event_id);
    assert.equal(group.requests.length, 1);
    assert.equal(group.requests[0].epoch, EPOCH);
    assert.equal(group.alerts.length, 1);
  });

  it('rejects an analysis request whose alert was not written in this batch', () => {
    const event = makeEvent({ source_seq: 1 });
    const plan = buildWritePlan({
      result: {
        detections: [],
        alerts: [],
        analysisRequests: [{
          requestId: '33333333-3333-4333-8333-333333333332',
          alertId: 'ghost-alert',
          budgetClass: 'standard',
          createdAt: 1793577600000,
          idempotencyKey: 'b'.repeat(43),
          sequenceInHour: 1,
        }],
      },
      events: [event],
      epoch: EPOCH,
    });
    assert.equal(plan.counters.requests, 0);
    assert.equal(plan.counters.rejected, 1);
  });

  it('rejects a detection that references no event of the batch', () => {
    const event = makeEvent({ source_seq: 1 });
    const plan = buildWritePlan({
      result: {
        detections: [makeDetection('not-in-batch')],
        alerts: [],
        analysisRequests: [],
      },
      events: [event],
      epoch: EPOCH,
    });
    assert.equal(plan.counters.findings, 0);
    assert.equal(plan.counters.skipped_no_new_observation, 1);
  });
});
