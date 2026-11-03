/**
 * state-limits.test.js — hard capacity bounds: fingerprint eviction, TTL sweeps,
 * threshold window overflow and the seen event id window.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createManualClock } from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent } from './helpers.js';

const anyNameRule = makeConditionRule({ when: { field: 'process.name', operator: 'exists' } });

const criticalRule = makeConditionRule({
  ruleId: 'proc.critical',
  severity: 'critical',
  when: { field: 'process.name', operator: 'eq', value: 'example-critical' },
});

const infoRule = makeConditionRule({
  ruleId: 'proc.info',
  severity: 'info',
  when: { field: 'process.name', operator: 'starts_with', value: 'example-info-' },
});

function nameEvent(eventId, observedAt, processName) {
  return makeEvent({ eventId, observedAt, fields: { process: { name: processName } } });
}

describe('fingerprint capacity', () => {
  it('never exceeds the configured capacity and accounts for every eviction', () => {
    const engine = createTestEngine({ rules: [anyNameRule], limits: { maxFingerprints: 3 } });
    const events = [];
    for (let index = 0; index < 10; index += 1) {
      events.push(nameEvent(`evt-cap-${index}`, 1000 + index, `example-${index}`));
    }
    const result = engine.ingest(events);
    assert.equal(result.detections.length, 10);
    const stats = engine.stats();
    assert.equal(stats.openFingerprints, 3);
    assert.equal(stats.evictions, 7);
    assert.equal(stats.gapsByKind['fingerprint-limit'], 7);
    assert.equal(result.gaps.filter((gap) => gap.kind === 'fingerprint-limit').length, 7);
    assert.match(result.gaps[0].detail.fingerprint, /^[0-9a-f]{64}$/u);
  });

  it('evicts the lowest severity first and keeps a critical fingerprint', () => {
    const engine = createTestEngine({ rules: [criticalRule, infoRule], limits: { maxFingerprints: 4 } });
    const result = engine.ingest([
      nameEvent('evt-pri-1', 1000, 'example-info-a'),
      nameEvent('evt-pri-2', 2000, 'example-info-b'),
      nameEvent('evt-pri-3', 3000, 'example-info-c'),
      nameEvent('evt-pri-4', 4000, 'example-critical'),
      nameEvent('evt-pri-5', 5000, 'example-info-d'),
    ]);
    const firstFingerprint = result.detections[0].fingerprint;
    const criticalFingerprint = result.detections[3].fingerprint;
    assert.equal(engine.stats().evictions, 1);
    const limitGap = result.gaps.find((gap) => gap.kind === 'fingerprint-limit');
    assert.equal(limitGap.count, 1);
    assert.equal(limitGap.detail.fingerprint, firstFingerprint);
    assert.notEqual(limitGap.detail.fingerprint, criticalFingerprint);
    assert.equal(engine.stats().openFingerprints, 4);
  });

  it('keeps a just closed high severity window when choosing a victim', () => {
    const inheritedRule = makeConditionRule({
      ruleId: 'proc.severity-inherit',
      severity: 'info',
      severityFrom: 'severity',
      fields: ['process.name', 'severity'],
      fingerprint: ['process.name'],
      when: { field: 'process.name', operator: 'exists' },
    });
    const severityNameEvent = (eventId, observedAt, processName, severity) =>
      makeEvent({ eventId, observedAt, severity, fields: { process: { name: processName } } });

    const engine = createTestEngine({ rules: [inheritedRule], limits: { maxFingerprints: 2 } });
    engine.ingest([severityNameEvent('evt-inh-1', 1000, 'example-keep', 'critical')]);
    const closed = engine.advanceTo(900000);
    assert.equal(closed.closedAlerts.length, 1);
    assert.equal(closed.closedAlerts[0].severity, 'critical');

    const second = engine.ingest([severityNameEvent('evt-inh-2', 900001, 'example-drop', 'info')]);
    const droppedFingerprint = second.detections[0].fingerprint;
    const third = engine.ingest([severityNameEvent('evt-inh-3', 900002, 'example-new', 'info')]);
    assert.equal(third.gaps.length, 1);
    assert.equal(third.gaps[0].kind, 'fingerprint-limit');
    assert.equal(third.gaps[0].detail.fingerprint, droppedFingerprint);
    assert.equal(engine.stats().evictions, 1);

    const survivor = engine.ingest([severityNameEvent('evt-inh-4', 900003, 'example-keep', 'low')]);
    assert.equal(survivor.alerts.length, 1);
    assert.equal(survivor.alerts[0].severity, 'critical');
    assert.equal(survivor.alerts[0].windowStart, 900000);
    assert.equal(survivor.alerts[0].count, 1);
    assert.equal(engine.stats().evictions, 1);
  });

  it('drops an evicted fingerprint alert from the batch output', () => {
    const engine = createTestEngine({ rules: [anyNameRule], limits: { maxFingerprints: 1 } });
    const result = engine.ingest([
      nameEvent('evt-evict-1', 1000, 'example-aaa'),
      nameEvent('evt-evict-2', 2000, 'example-aaa'),
      nameEvent('evt-evict-3', 3000, 'example-bbb'),
    ]);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts.length, engine.stats().openFingerprints);
    assert.equal(result.alerts[0].fingerprint, result.detections[2].fingerprint);
    assert.notEqual(result.alerts[0].fingerprint, result.detections[0].fingerprint);
    assert.equal(result.alerts[0].count, 1);
    assert.equal(engine.stats().evictions, 1);
    assert.equal(result.gaps.filter((gap) => gap.kind === 'fingerprint-limit').length, 1);
  });
});

describe('state TTL', () => {
  it('expires idle fingerprints in bounded batches', () => {
    const clock = createManualClock(0);
    const engine = createTestEngine({
      rules: [anyNameRule],
      clock,
      limits: { stateTtlMs: 3600000, maxSweepPerCall: 1 },
    });
    engine.ingest([
      nameEvent('evt-ttl-1', 1000, 'example-a'),
      nameEvent('evt-ttl-2', 1000, 'example-b'),
      nameEvent('evt-ttl-3', 1000, 'example-c'),
    ]);
    assert.equal(engine.stats().openFingerprints, 3);

    const first = engine.advanceTo(7200000);
    assert.equal(first.gaps.length, 1);
    assert.equal(first.gaps[0].kind, 'state-expired');
    assert.equal(first.gaps[0].count, 1);
    assert.equal(engine.stats().openFingerprints, 2);

    engine.advanceTo(7200000);
    assert.equal(engine.stats().openFingerprints, 1);
    engine.advanceTo(7200000);
    assert.equal(engine.stats().openFingerprints, 0);
    assert.equal(engine.stats().expiredStates, 3);
    assert.equal(engine.stats().gapsByKind['state-expired'], 3);
  });

  it('evicts the oldest lastSeen first even when insertion order is the reverse', () => {
    // 复核 P2：`expired.sort(compareByAge)` 此前零覆盖——插入顺序恰好等于年龄顺序时，
    // 删掉排序也全绿。这里让插入顺序（3000,2000,1000）与年龄顺序相反，锁定"先淘汰最旧"。
    // 一天一个窗口，避免 advanceTo 关闭窗口后无法区分条目是过期还是滚动。
    const engine = createTestEngine({
      rules: [anyNameRule],
      limits: { aggregationWindowMs: 86400000, stateTtlMs: 1000, maxSweepPerCall: 1 },
    });
    const ingested = engine.ingest([
      nameEvent('evt-age-1', 3000, 'example-oldest-inserted'),
      nameEvent('evt-age-2', 2000, 'example-middle'),
      nameEvent('evt-age-3', 1000, 'example-newest-inserted'),
    ]);
    assert.equal(engine.stats().openFingerprints, 3);
    const alertIdByFingerprint = new Map(ingested.alerts.map((alert) => [alert.fingerprint, alert.alertId]));
    // detections 按 observedAt 升序：[1000 最新插入, 2000 中间, 3000 最先插入]。
    const fingerprintsByAge = ingested.detections.map((detection) => detection.fingerprint);
    assert.equal(fingerprintsByAge.length, 3);

    const swept = engine.advanceTo(5000);
    assert.equal(swept.gaps.length, 1);
    assert.equal(swept.gaps[0].kind, 'state-expired');
    assert.equal(swept.gaps[0].count, 1);
    assert.equal(engine.stats().expiredStates, 1);
    assert.equal(engine.stats().openFingerprints, 2);

    // 被淘汰的必须是 lastSeen 最小的那条（1000），而不是最先插入的那条（3000）。
    const survived = fingerprintsByAge.map((fingerprint) => engine.getAlert(alertIdByFingerprint.get(fingerprint)) !== null);
    assert.deepEqual(survived, [false, true, true]);
  });

  it('does not expire a fingerprint because its events are old', () => {
    const clock = createManualClock(7200000);
    const engine = createTestEngine({ rules: [anyNameRule], clock, limits: { stateTtlMs: 3600000 } });
    engine.ingest([nameEvent('evt-backfill-1', 1000, 'example-a')]);
    assert.equal(engine.stats().openFingerprints, 1);
    const second = engine.ingest([nameEvent('evt-backfill-2', 1000, 'example-b')]);
    assert.equal(second.gaps.length, 0);
    assert.equal(engine.stats().openFingerprints, 2);
    assert.equal(engine.stats().expiredStates, 0);
    const later = engine.advanceTo(10800000);
    assert.equal(later.gaps[0].kind, 'state-expired');
    assert.equal(engine.stats().openFingerprints, 0);
    assert.equal(engine.stats().expiredStates, 2);
  });

  it('ignores clock regressions', () => {
    const clock = createManualClock(7200000);
    const engine = createTestEngine({ rules: [anyNameRule], clock });
    engine.ingest([nameEvent('evt-reg-1', 1000, 'example-a')]);
    const backwards = engine.advanceTo(1000);
    assert.equal(backwards.at, 7200000);
    assert.equal(backwards.eventsProcessed, 0);
    assert.equal(engine.stats().openFingerprints, 1);
  });
});

describe('threshold window capacity', () => {
  it('drops the oldest timestamps and reports the overflow', () => {
    const rule = {
      ruleId: 'proc.overflow',
      version: '1.0.0',
      type: 'threshold',
      severity: 'medium',
      fields: ['process.name'],
      groupBy: ['process.name'],
      count: { operator: 'gte', value: 3 },
      windowMs: 60000,
      maxEvents: 2,
    };
    const engine = createTestEngine({ rules: [rule] });
    const events = [];
    for (let index = 0; index < 5; index += 1) {
      events.push(nameEvent(`evt-ovf-${index}`, 1000 + index, 'example-process'));
    }
    const result = engine.ingest(events);
    assert.equal(result.detections.length, 0);
    assert.equal(engine.stats().gapsByKind['threshold-window-overflow'], 3);
    const overflow = result.gaps.find((gap) => gap.kind === 'threshold-window-overflow');
    assert.equal(overflow.count, 3);
    assert.equal(overflow.ruleId, 'proc.overflow');
    assert.equal(overflow.detail.dropped, 3);
  });

  it('keeps the retained count exact when the bound equals the threshold', () => {
    const rule = {
      ruleId: 'proc.bounded',
      version: '1.0.0',
      type: 'threshold',
      severity: 'medium',
      fields: ['process.name'],
      groupBy: ['process.name'],
      count: { operator: 'gte', value: 2 },
      windowMs: 60000,
      maxEvents: 2,
    };
    const engine = createTestEngine({ rules: [rule] });
    const events = [];
    for (let index = 0; index < 5; index += 1) {
      events.push(nameEvent(`evt-bnd-${index}`, 1000 + index, 'example-process'));
    }
    const result = engine.ingest(events);
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].observations, 2);
    assert.equal(engine.stats().gapsByKind['threshold-window-overflow'], 3);
  });
});

describe('threshold group capacity', () => {
  const groupedRule = {
    ruleId: 'proc.groups',
    version: '1.0.0',
    type: 'threshold',
    severity: 'medium',
    fields: ['process.name'],
    groupBy: ['process.name'],
    count: { operator: 'gte', value: 3 },
    windowMs: 600000,
  };

  it('bounds the group table and keeps the most recently hit groups', () => {
    const engine = createTestEngine({ rules: [groupedRule], limits: { maxThresholdGroups: 8 } });
    const events = [];
    for (let index = 0; index < 50; index += 1) {
      events.push(nameEvent(`evt-grp-${index}`, 1000 + index, `example-group-${index}`));
    }
    const result = engine.ingest(events);
    assert.equal(result.detections.length, 0);
    assert.equal(engine.stats().thresholdGroups, 8);
    assert.equal(engine.stats().gapsByKind['threshold-group-limit'], 42);
    const groupGaps = result.gaps.filter((gap) => gap.kind === 'threshold-group-limit');
    assert.equal(groupGaps.length, 1);
    assert.equal(groupGaps[0].count, 42);
    assert.equal(groupGaps[0].ruleId, 'proc.groups');

    const kept = engine.ingest([
      nameEvent('evt-grp-keep-1', 51000, 'example-group-49'),
      nameEvent('evt-grp-keep-2', 52000, 'example-group-49'),
    ]);
    assert.equal(kept.detections.length, 1);
    assert.equal(kept.detections[0].observations, 3);

    const dropped = engine.ingest([
      nameEvent('evt-grp-drop-1', 53000, 'example-group-0'),
      nameEvent('evt-grp-drop-2', 54000, 'example-group-0'),
    ]);
    assert.equal(dropped.detections.length, 0);
    assert.equal(engine.stats().thresholdGroups, 8);
  });
});

describe('seen event id window', () => {
  it('reprocesses the oldest identifier once it leaves the window', () => {
    const engine = createTestEngine({ rules: [anyNameRule], limits: { maxSeenEventIds: 2 } });
    engine.ingest([
      nameEvent('evt-seen-1', 1000, 'example-a'),
      nameEvent('evt-seen-2', 2000, 'example-a'),
      nameEvent('evt-seen-3', 3000, 'example-a'),
    ]);
    assert.equal(engine.stats().duplicateEvents, 0);
    const replay = engine.ingest([nameEvent('evt-seen-1', 4000, 'example-a')]);
    assert.equal(replay.detections.length, 1);
    assert.equal(replay.decisions[0].outcome, 'evaluated');
    assert.equal(engine.stats().duplicateEvents, 0);
    const duplicate = engine.ingest([nameEvent('evt-seen-1', 5000, 'example-a')]);
    assert.equal(duplicate.detections.length, 0);
    assert.equal(duplicate.decisions[0].outcome, 'duplicate');
    assert.equal(engine.stats().duplicateEvents, 1);
  });

  it('caps the ingest batch and reports the skipped remainder', () => {
    const engine = createTestEngine({ rules: [anyNameRule], maxEventsPerIngest: 2 });
    const result = engine.ingest([
      nameEvent('evt-batch-1', 1000, 'example-a'),
      nameEvent('evt-batch-2', 2000, 'example-a'),
      nameEvent('evt-batch-3', 3000, 'example-a'),
    ]);
    assert.equal(result.eventsProcessed, 2);
    assert.equal(result.detections.length, 2);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].kind, 'ingest-batch-limit');
    assert.equal(result.gaps[0].count, 1);
    assert.equal(engine.stats().gapsByKind['ingest-batch-limit'], 1);
  });
});
