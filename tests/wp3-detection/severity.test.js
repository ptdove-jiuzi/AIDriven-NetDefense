/**
 * severity.test.js — severity oscillation, escalation cooling, hysteretic
 * downgrade and window roll behaviour (AT-DET-001).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createManualClock, createSequenceIdFactory } from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent } from './helpers.js';

const severityRule = makeConditionRule({
  severity: 'info',
  severityFrom: 'severity',
  fields: ['process.name', 'severity'],
  fingerprint: ['process.name'],
});

function severityEvent(eventId, observedAt, severity) {
  return makeEvent({
    eventId,
    observedAt,
    severity,
    fields: { process: { name: 'example-process' } },
  });
}

function lastAlert(result) {
  return result.alerts[result.alerts.length - 1];
}

describe('severity hysteresis', () => {
  it('converges instead of oscillating across twenty observations', () => {
    const engine = createTestEngine({ rules: [severityRule] });
    const events = [];
    for (let index = 0; index < 20; index += 1) {
      events.push(severityEvent(`evt-osc-${index}`, 1000 + index * 1000, index % 2 === 0 ? 'low' : 'high'));
    }
    const result = engine.ingest(events);
    assert.equal(result.alerts.length, 1);
    const alert = result.alerts[0];
    assert.equal(alert.count, 20);
    assert.equal(alert.severity, 'high');
    assert.equal(alert.peakSeverity, 'high');
    assert.equal(alert.escalations.length, 1);
    assert.deepEqual(alert.escalations[0], { from: 'low', to: 'high', at: 2000 });
    assert.equal(alert.downgrades.length, 0);
    assert.equal(engine.stats().alerts, 1);
  });

  it('escalates immediately, defers inside the cooldown and applies when due', () => {
    const clock = createManualClock(0);
    const engine = createTestEngine({ rules: [severityRule], clock });
    engine.ingest([severityEvent('evt-cool-1', 1000, 'low')]);

    const escalated = engine.ingest([severityEvent('evt-cool-2', 61000, 'high')]);
    assert.equal(lastAlert(escalated).severity, 'high');
    assert.equal(lastAlert(escalated).escalations.length, 1);

    const deferred = engine.ingest([severityEvent('evt-cool-3', 121000, 'critical')]);
    const deferredAlert = lastAlert(deferred);
    assert.equal(deferredAlert.severity, 'high');
    assert.deepEqual(deferredAlert.pendingEscalation, { severity: 'critical', dueAt: 361000 });
    assert.equal(deferredAlert.escalations.length, 2);
    assert.equal(deferredAlert.escalations[1].deferred, true);
    assert.equal(deferredAlert.escalations[1].at, 121000);

    const applied = engine.advanceTo(361000);
    const appliedAlert = lastAlert(applied);
    assert.equal(appliedAlert.severity, 'critical');
    assert.equal(appliedAlert.pendingEscalation, null);
    assert.equal(appliedAlert.escalations.length, 2);
    assert.deepEqual(appliedAlert.escalations[1], {
      from: 'high',
      to: 'critical',
      at: 361000,
      deferred: false,
      deferredAt: 121000,
      appliedAt: 361000,
      appliedFromPending: true,
    });
  });

  it('lowers severity one rank per dwell period', () => {
    const engine = createTestEngine({
      rules: [severityRule],
      limits: { aggregationWindowMs: 600000, downgradeDwellMs: 60000 },
    });
    engine.ingest([severityEvent('evt-down-1', 1000, 'high')]);

    const rolled = engine.ingest([severityEvent('evt-down-2', 600001, 'low')]);
    assert.equal(lastAlert(rolled).severity, 'high');
    assert.equal(lastAlert(rolled).downgrades.length, 0);
    assert.equal(rolled.closedAlerts[0].severity, 'high');

    const tooEarly = engine.ingest([severityEvent('evt-down-3', 630001, 'low')]);
    assert.equal(lastAlert(tooEarly).severity, 'high');
    assert.equal(lastAlert(tooEarly).downgrades.length, 0);

    const firstStep = engine.ingest([severityEvent('evt-down-4', 660001, 'low')]);
    assert.equal(lastAlert(firstStep).severity, 'medium');
    assert.equal(lastAlert(firstStep).downgrades.length, 1);
    assert.deepEqual(lastAlert(firstStep).downgrades[0], { from: 'high', to: 'medium', at: 660001 });

    const secondStep = engine.ingest([severityEvent('evt-down-5', 720001, 'low')]);
    assert.equal(lastAlert(secondStep).severity, 'low');
    assert.equal(lastAlert(secondStep).downgrades.length, 2);
    assert.equal(lastAlert(secondStep).count, 4);
  });

  it('blocks downgrades while the window peak is at the current level', () => {
    const engine = createTestEngine({ rules: [severityRule], limits: { downgradeDwellMs: 0 } });
    const created = engine.ingest([severityEvent('evt-peak-1', 1000, 'critical')]);
    const alertId = created.alerts[0].alertId;
    const lowered = engine.ingest([severityEvent('evt-peak-2', 2000, 'low')]);
    assert.equal(lastAlert(lowered).severity, 'critical');
    assert.equal(lastAlert(lowered).peakSeverity, 'critical');
    const repeated = engine.ingest([
      severityEvent('evt-peak-3', 3000, 'low'),
      severityEvent('evt-peak-4', 4000, 'low'),
    ]);
    assert.equal(lastAlert(repeated).severity, 'critical');
    const advanced = engine.advanceTo(500000);
    assert.equal(advanced.alerts.length, 0);
    assert.equal(engine.getAlert(alertId).severity, 'critical');
    assert.equal(engine.getAlert(alertId).downgrades.length, 0);
    assert.equal(engine.getAlert(alertId).count, 4);
  });

  it('never jumps to the lowest level when the window rolls', () => {
    const engine = createTestEngine({
      rules: [severityRule],
      limits: { aggregationWindowMs: 600000, downgradeDwellMs: 60000 },
    });
    engine.ingest([severityEvent('evt-roll-1', 1000, 'critical')]);
    const rolled = engine.ingest([severityEvent('evt-roll-2', 600001, 'low')]);
    assert.equal(lastAlert(rolled).severity, 'critical');
    assert.equal(lastAlert(rolled).peakSeverity, 'low');
    assert.equal(lastAlert(rolled).downgrades.length, 0);
    const stepped = engine.advanceTo(660001);
    assert.equal(lastAlert(stepped).severity, 'high');
    assert.deepEqual(lastAlert(stepped).downgrades[0], { from: 'critical', to: 'high', at: 660001 });
  });

  const pendingRecord = {
    from: 'high',
    to: 'critical',
    at: 361000,
    deferredAt: 121000,
    deferred: false,
    appliedAt: 361000,
    appliedFromPending: true,
  };

  function deferCritical(engine, prefix) {
    engine.ingest([severityEvent(`${prefix}-1`, 1000, 'low')]);
    engine.ingest([severityEvent(`${prefix}-2`, 61000, 'high')]);
    return engine.ingest([severityEvent(`${prefix}-3`, 121000, 'critical')]);
  }

  it('finalises a due pending escalation when the clock reaches the due time', () => {
    const clock = createManualClock(0);
    const engine = createTestEngine({ rules: [severityRule], clock });
    const deferred = deferCritical(engine, 'evt-pend');
    assert.deepEqual(lastAlert(deferred).pendingEscalation, { severity: 'critical', dueAt: 361000 });

    clock.set(361000);
    const applied = engine.ingest([severityEvent('evt-pend-4', 361000, 'low')]);
    const alert = lastAlert(applied);
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.peakSeverity, 'critical');
    assert.equal(alert.escalations.length, 2);
    assert.equal(alert.escalations.filter((entry) => entry.deferred === true).length, 0);
    assert.deepEqual(alert.escalations[1], pendingRecord);
    assert.equal(alert.pendingEscalation, null);
  });

  it('finalises a due pending escalation when only the event time is due', () => {
    const engine = createTestEngine({ rules: [severityRule], clock: createManualClock(0) });
    deferCritical(engine, 'evt-eventdue');

    const applied = engine.ingest([severityEvent('evt-eventdue-4', 361000, 'low')]);
    const alert = lastAlert(applied);
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.pendingEscalation, null);
    assert.equal(alert.escalations.length, 2);
    assert.equal(alert.escalations.filter((entry) => entry.deferred === true).length, 0);
    assert.deepEqual(alert.escalations[1], pendingRecord);
  });

  it('releases exactly one analysis request when the clock settles a pending escalation', () => {
    // 复核 P2：删掉 advanceEntry 里的 releaseAnalysis 后全量仍然全绿——纯时间驱动的
    // 升级分支此前没有任何用例覆盖它发出的分析请求。
    const clock = createManualClock(0);
    const engine = createTestEngine({ rules: [severityRule], clock });
    deferCritical(engine, 'evt-pendrel');
    assert.equal(engine.stats().analysisRequests, 1);

    const settled = engine.advanceTo(361000);
    assert.equal(settled.analysisRequests.length, 1);
    assert.equal(settled.analysisRequests[0].severity, 'critical');
    assert.equal(settled.analysisRequests[0].sequenceInHour, 2);
    assert.equal(settled.analysisRequests[0].idempotencyKey, settled.analysisRequests[0].requestKey);
    assert.deepEqual(settled.alerts.map((entry) => entry.severity), ['critical']);
    assert.equal(engine.stats().analysisRequests, 2);

    // 同一次升级不会被第二条路径重复放行。
    const again = engine.advanceTo(361001);
    assert.deepEqual(again.analysisRequests, []);
    assert.equal(engine.stats().analysisRequests, 2);
  });

  it('carries severity across a closed window on every call path', () => {
    const limits = { aggregationWindowMs: 600000, downgradeDwellMs: 600000 };
    // 两台引擎各自新建确定性工厂：告警标识不再由内容派生，视图逐字段相等只能靠注入固定序列。
    const build = () => createTestEngine({
      rules: [severityRule],
      clock: createManualClock(0),
      limits,
      ids: createSequenceIdFactory(1),
    });

    const rolledByClock = build();
    rolledByClock.ingest([severityEvent('evt-path-1', 1000, 'critical')]);
    const closed = rolledByClock.advanceTo(600000);
    assert.equal(closed.closedAlerts.length, 1);
    assert.equal(closed.closedAlerts[0].severity, 'critical');
    const pathA = rolledByClock.ingest([severityEvent('evt-path-2', 600001, 'low')]).alerts[0];

    const rolledByEvent = build();
    rolledByEvent.ingest([severityEvent('evt-path-1', 1000, 'critical')]);
    const pathB = rolledByEvent.ingest([severityEvent('evt-path-2', 600001, 'low')]).alerts[0];

    assert.deepEqual(pathA, pathB);
    assert.equal(pathA.severity, 'critical');
    assert.equal(pathA.peakSeverity, 'low');
    assert.equal(pathA.windowStart, 600000);
    assert.equal(pathA.count, 1);
    assert.equal(pathA.downgrades.length, 0);
  });

  it('still requires a full dwell after the window roll', () => {
    const engine = createTestEngine({
      rules: [severityRule],
      clock: createManualClock(0),
      limits: { aggregationWindowMs: 600000, downgradeDwellMs: 300000 },
    });
    engine.ingest([severityEvent('evt-dwell-1', 1000, 'critical')]);
    engine.advanceTo(600000);
    const first = engine.ingest([severityEvent('evt-dwell-2', 600001, 'low')]);
    assert.equal(lastAlert(first).severity, 'critical');
    assert.equal(lastAlert(first).downgrades.length, 0);
    const early = engine.ingest([severityEvent('evt-dwell-3', 899999, 'low')]);
    assert.equal(lastAlert(early).severity, 'critical');
    const due = engine.ingest([severityEvent('evt-dwell-4', 900001, 'low')]);
    assert.equal(lastAlert(due).severity, 'high');
    assert.deepEqual(lastAlert(due).downgrades, [{ from: 'critical', to: 'high', at: 900001 }]);
  });

  it('keeps the highest observed level as the window peak', () => {
    const engine = createTestEngine({ rules: [severityRule], limits: { escalationCooldownMs: 0 } });
    const result = engine.ingest([
      severityEvent('evt-peakv-1', 1000, 'low'),
      severityEvent('evt-peakv-2', 2000, 'critical'),
      severityEvent('evt-peakv-3', 3000, 'medium'),
    ]);
    const alert = result.alerts[0];
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.peakSeverity, 'critical');
    assert.equal(alert.downgrades.length, 0);
    assert.deepEqual(alert.escalations, [
      { from: 'low', to: 'critical', at: 2000 },
    ]);
  });
});
