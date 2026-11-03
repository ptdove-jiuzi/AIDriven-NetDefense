/**
 * aggregation.test.js — fingerprint construction, 15 minute windows, alert
 * identity and event id capping.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestEngine, makeConditionRule, makeEvent } from './helpers.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const anyNameRule = makeConditionRule({ when: { field: 'process.name', operator: 'exists' } });

function namedEvent(eventId, observedAt, processName) {
  return makeEvent({
    eventId,
    observedAt,
    fields: { process: { name: processName, path: '/tmp/example/tool' } },
  });
}

describe('alert aggregation', () => {
  it('merges two observations of one fingerprint into one alert', () => {
    const engine = createTestEngine();
    const result = engine.ingest([namedEvent('evt-a1', 1000, 'example-process'), namedEvent('evt-a2', 2000, 'example-process')]);
    assert.equal(result.detections.length, 2);
    assert.equal(result.alerts.length, 1);
    const alert = result.alerts[0];
    assert.equal(alert.count, 2);
    assert.equal(alert.firstSeen, 1000);
    assert.equal(alert.lastSeen, 2000);
    assert.deepEqual(alert.eventIds, ['evt-a1', 'evt-a2']);
    assert.equal(alert.eventIdsTruncated, false);
    assert.equal(alert.windowStart, 0);
    assert.equal(alert.windowEnd, 900000);
    assert.equal(alert.closed, false);
    assert.equal(alert.status, 'new');
    assert.match(alert.alertId, UUID_V4);
    assert.match(alert.fingerprint, HEX64);
    assert.equal(engine.stats().alerts, 1);
    assert.equal(engine.stats().openFingerprints, 1);
  });

  it('keeps distinct fingerprints in distinct alerts with stable fingerprint and window keys', () => {
    const events = [namedEvent('evt-b1', 1000, 'example-process'), namedEvent('evt-b2', 2000, 'example-other')];
    const first = createTestEngine({ rules: [anyNameRule] }).ingest(events);
    const second = createTestEngine({ rules: [anyNameRule] }).ingest(events);
    assert.equal(first.alerts.length, 2);
    assert.notEqual(first.alerts[0].fingerprint, first.alerts[1].fingerprint);
    // 告警标识是随机 UUIDv4：各自合法、四条互不相同，且不跨引擎复现（不再是内容派生值）。
    for (const alert of [...first.alerts, ...second.alerts]) {
      assert.match(alert.alertId, UUID_V4);
    }
    assert.equal(new Set([...first.alerts, ...second.alerts].map((alert) => alert.alertId)).size, 4);
    assert.notDeepEqual(
      first.alerts.map((alert) => alert.alertId),
      second.alerts.map((alert) => alert.alertId),
    );
    // 幂等稳定性改由 (fingerprint, windowStart) 承担：两台引擎该组合逐项相等。
    const windowKeys = (result) => result.alerts.map((alert) => [alert.fingerprint, alert.windowStart]);
    assert.deepEqual(windowKeys(first), windowKeys(second));
  });

  it('rolls the window one millisecond across the boundary', () => {
    const engine = createTestEngine();
    const first = engine.ingest([namedEvent('evt-w1', 899999, 'example-process')]);
    assert.equal(first.alerts[0].windowStart, 0);
    const second = engine.ingest([namedEvent('evt-w2', 900000, 'example-process')]);
    assert.equal(second.alerts.length, 1);
    assert.equal(second.alerts[0].windowStart, 900000);
    assert.equal(second.alerts[0].count, 1);
    assert.equal(second.closedAlerts.length, 1);
    assert.equal(second.closedAlerts[0].windowStart, 0);
    assert.equal(second.closedAlerts[0].windowEnd, 900000);
    assert.equal(second.closedAlerts[0].closed, true);
    assert.equal(second.closedAlerts[0].count, 1);
    assert.equal(engine.stats().closedAlerts, 1);
    assert.equal(engine.stats().alerts, 2);
  });

  it('hashes the full value before truncating the preview', () => {
    const engine = createTestEngine({ rules: [anyNameRule] });
    const prefix = 'a'.repeat(299);
    const result = engine.ingest([
      namedEvent('evt-c1', 1000, `${prefix}X`),
      namedEvent('evt-c2', 2000, `${prefix}Y`),
    ]);
    const [left, right] = result.detections;
    assert.match(left.fingerprint, HEX64);
    assert.notEqual(left.fingerprint, right.fingerprint);
    assert.notEqual(left.fingerprintPreview[0].preview, undefined);
    assert.equal(left.fingerprintPreview[0].preview.length, 256);
    assert.equal(left.fingerprintPreview[0].preview, right.fingerprintPreview[0].preview);
    assert.equal(left.fingerprintPreview[0].path, 'process.name');
    assert.equal(result.alerts.length, 2);
  });

  it('caps stored event identifiers while keeping the count exact', () => {
    const engine = createTestEngine({ limits: { maxEventIdsPerAlert: 2 } });
    const events = [];
    for (let index = 0; index < 5; index += 1) {
      events.push(namedEvent(`evt-d${index}`, 1000 + index, 'example-process'));
    }
    const result = engine.ingest(events);
    const alert = result.alerts[0];
    assert.equal(alert.count, 5);
    assert.deepEqual(alert.eventIds, ['evt-d0', 'evt-d1']);
    assert.equal(alert.eventIdsTruncated, true);
  });

  it('keeps counting after suppression but stops requesting analysis', () => {
    const rule = makeConditionRule({
      severity: 'medium',
      severityFrom: 'severity',
      fields: ['process.name', 'severity'],
    });
    const engine = createTestEngine({ rules: [rule], limits: { escalationCooldownMs: 0 } });
    const first = engine.ingest([makeEvent({ eventId: 'evt-e1', observedAt: 1000, severity: 'high' })]);
    assert.equal(first.analysisRequests.length, 1);
    const alertId = first.alerts[0].alertId;
    assert.equal(engine.setAlertStatus(alertId, 'suppressed'), true);
    assert.equal(engine.setAlertStatus(alertId, 'acknowledged'), false);

    const second = engine.ingest([makeEvent({ eventId: 'evt-e2', observedAt: 2000, severity: 'critical' })]);
    assert.equal(second.alerts[0].count, 2);
    assert.equal(second.alerts[0].severity, 'critical');
    assert.equal(second.alerts[0].status, 'suppressed');
    assert.equal(second.analysisRequests.length, 0);
    assert.equal(second.analysisDenied.length, 0);
    assert.equal(engine.stats().analysisRequests, 1);
  });

  it('rejects status transitions that are not declared', () => {
    const engine = createTestEngine();
    const result = engine.ingest([namedEvent('evt-f1', 1000, 'example-process')]);
    const alertId = result.alerts[0].alertId;
    assert.equal(engine.setAlertStatus(alertId, 'resolved'), false);
    assert.equal(engine.getAlert(alertId).status, 'new');
    assert.equal(engine.setAlertStatus(alertId, 'acknowledged'), true);
    assert.equal(engine.setAlertStatus(alertId, 'resolved'), true);
    assert.equal(engine.getAlert(alertId).status, 'resolved');
    assert.equal(engine.setAlertStatus('0'.repeat(32), 'new'), false);
  });

  it('does not revive a closed window for a late event', () => {
    const engine = createTestEngine({ rules: [anyNameRule] });
    const first = engine.ingest([namedEvent('evt-late-1', 1000, 'example-process')]);
    const alertId = first.alerts[0].alertId;
    const closed = engine.advanceTo(900000);
    assert.equal(closed.closedAlerts.length, 1);
    assert.equal(closed.closedAlerts[0].alertId, alertId);
    assert.equal(closed.closedAlerts[0].closed, true);

    const beforeLate = engine.stats().detections;
    const late = engine.ingest([namedEvent('evt-late-2', 1500, 'example-process')]);
    assert.equal(late.alerts.length, 0);
    assert.equal(late.closedAlerts.length, 0);
    assert.equal(late.detections.length, 0);
    assert.equal(engine.stats().detections, beforeLate);
    assert.equal(late.analysisRequests.length, 0);
    assert.equal(late.decisions.length, 1);
    assert.deepEqual(late.decisions[0], { eventId: 'evt-late-2', outcome: 'late-window' });
    assert.equal(late.gaps.length, 1);
    assert.equal(late.gaps[0].kind, 'late-window');
    assert.equal(late.gaps[0].count, 1);
    assert.equal(engine.stats().gapsByKind['late-window'], 1);
    assert.equal(engine.getAlert(alertId), null);
    assert.equal(engine.stats().alerts, 1);
    assert.equal(engine.stats().openFingerprints, 1);

    const replay = engine.ingest([namedEvent('evt-late-2', 1500, 'example-process')]);
    assert.equal(replay.alerts.length, 0);
    assert.equal(replay.decisions[0].outcome, 'duplicate');
    assert.equal(engine.stats().gapsByKind['late-window'], 1);

    const forward = engine.ingest([namedEvent('evt-late-3', 900001, 'example-process')]);
    assert.equal(forward.alerts.length, 1);
    assert.equal(forward.alerts[0].windowStart, 900000);
    assert.equal(forward.alerts[0].count, 1);
    assert.notEqual(forward.alerts[0].alertId, alertId);
    assert.equal(forward.decisions[0].outcome, 'evaluated');
  });

  it('rejects a late event that belongs to a skipped middle window', () => {
    const engine = createTestEngine({ rules: [anyNameRule] });
    engine.ingest([namedEvent('evt-mid-1', 1000, 'example-process')]);
    const closed = engine.advanceTo(900000);
    assert.equal(closed.closedAlerts.length, 1);
    assert.equal(closed.closedAlerts[0].windowStart, 0);

    const advanced = engine.ingest([namedEvent('evt-mid-2', 1800001, 'example-process')]);
    assert.equal(advanced.alerts.length, 1);
    assert.equal(advanced.alerts[0].windowStart, 1800000);
    const openAlertId = advanced.alerts[0].alertId;

    const late = engine.ingest([namedEvent('evt-mid-3', 900001, 'example-process')]);
    assert.equal(late.alerts.length, 0);
    assert.equal(late.detections.length, 0);
    assert.equal(late.decisions.length, 1);
    assert.deepEqual(late.decisions[0], { eventId: 'evt-mid-3', outcome: 'late-window' });
    assert.equal(late.gaps.length, 1);
    assert.equal(late.gaps[0].kind, 'late-window');
    assert.equal(engine.stats().gapsByKind['late-window'], 1);

    const openAlert = engine.getAlert(openAlertId);
    assert.equal(openAlert.windowStart, 1800000);
    assert.equal(openAlert.firstSeen, 1800001);
    assert.equal(openAlert.count, 1);
    assert.equal(openAlert.firstSeen >= openAlert.windowStart, true);
  });

  it('returns closed windows only once', () => {
    const engine = createTestEngine();
    engine.ingest([namedEvent('evt-g1', 1000, 'example-process')]);
    const roll = engine.ingest([namedEvent('evt-g2', 900000, 'example-process')]);
    assert.equal(roll.closedAlerts.length, 1);
    const again = engine.ingest([namedEvent('evt-g3', 900001, 'example-process')]);
    assert.equal(again.closedAlerts.length, 0);
    assert.equal(again.alerts[0].count, 2);
  });
});
