/**
 * rate-limit.test.js — per fingerprint hourly analysis budget, idempotency and
 * the global analysis gate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DetectionConfigError,
  createManualClock,
  createRateState,
  createSequenceIdFactory,
  hourStartFor,
  requestAnalysis,
} from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent } from './helpers.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

const fastLimits = {
  aggregationWindowMs: 60000,
  escalationCooldownMs: 0,
  downgradeDwellMs: 0,
  analysisMinSeverity: 'info',
};

describe('hourly analysis budget', () => {
  it('releases four requests per fingerprint per hour and denies the rest', () => {
    const engine = createTestEngine({ rules: [severityRule], limits: fastLimits });
    const requests = [];
    const denials = [];
    const steps = [
      ['evt-rl-1', 1000, 'info'],
      ['evt-rl-2', 2000, 'low'],
      ['evt-rl-3', 3000, 'medium'],
      ['evt-rl-4', 4000, 'high'],
      ['evt-rl-5', 5000, 'critical'],
      ['evt-rl-6', 60001, 'low'],
    ];
    for (const [eventId, observedAt, severity] of steps) {
      const result = engine.ingest([severityEvent(eventId, observedAt, severity)]);
      requests.push(...result.analysisRequests);
      denials.push(...result.analysisDenied);
    }
    assert.equal(requests.length, 4);
    assert.equal(denials.length, 2);
    assert.deepEqual(
      requests.map((request) => request.severity),
      ['info', 'low', 'medium', 'high'],
    );
    assert.deepEqual(
      requests.map((request) => request.sequenceInHour),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      requests.map((request) => request.hourStart),
      [0, 0, 0, 0],
    );
    assert.equal(requests[0].budgetClass, 'standard');
    assert.equal(requests[0].idempotencyKey, requests[0].requestKey);
    assert.match(requests[0].requestId, UUID_V4);
    assert.deepEqual(
      denials.map((denial) => denial.reason),
      ['fingerprint-hourly-limit', 'fingerprint-hourly-limit'],
    );
    assert.equal(denials[1].severity, 'critical');
    assert.equal(denials[1].hourStart, 0);
    const stats = engine.stats();
    assert.equal(stats.analysisRequests, 4);
    assert.equal(stats.analysisDenied, 2);
  });

  it('grants a fresh budget in the next hour', () => {
    const engine = createTestEngine({ rules: [severityRule], limits: fastLimits });
    for (const [eventId, observedAt, severity] of [
      ['evt-hr-1', 1000, 'info'],
      ['evt-hr-2', 2000, 'low'],
      ['evt-hr-3', 3000, 'medium'],
      ['evt-hr-4', 4000, 'high'],
    ]) {
      engine.ingest([severityEvent(eventId, observedAt, severity)]);
    }
    assert.equal(engine.stats().analysisRequests, 4);

    for (const [eventId, observedAt, severity] of [
      ['evt-hr-5', 60001, 'info'],
      ['evt-hr-6', 60002, 'info'],
      ['evt-hr-7', 60003, 'info'],
    ]) {
      const downgraded = engine.ingest([severityEvent(eventId, observedAt, severity)]);
      assert.equal(downgraded.analysisRequests.length, 0);
      assert.equal(downgraded.analysisDenied.length, 0);
    }

    const requests = [];
    for (const [eventId, observedAt, severity] of [
      ['evt-hr-8', 3600001, 'info'],
      ['evt-hr-9', 3600002, 'low'],
      ['evt-hr-10', 3600003, 'medium'],
      ['evt-hr-11', 3600004, 'high'],
      ['evt-hr-12', 3600005, 'critical'],
    ]) {
      const result = engine.ingest([severityEvent(eventId, observedAt, severity)]);
      requests.push(...result.analysisRequests);
    }
    assert.equal(requests.length, 4);
    assert.deepEqual(
      requests.map((request) => request.hourStart),
      [3600000, 3600000, 3600000, 3600000],
    );
    assert.deepEqual(
      requests.map((request) => request.severity),
      ['low', 'medium', 'high', 'critical'],
    );
    assert.deepEqual(
      requests.map((request) => request.sequenceInHour),
      [1, 2, 3, 4],
    );
    assert.equal(engine.stats().analysisRequests, 8);
    assert.equal(engine.stats().analysisDenied, 0);
  });

  it('treats a repeated request key as an idempotent replay', () => {
    const engine = createTestEngine({
      rules: [severityRule],
      limits: { ...fastLimits, analysisMinSeverity: 'high' },
    });
    const first = engine.ingest([severityEvent('evt-idem-1', 1000, 'high')]);
    assert.equal(first.analysisRequests.length, 1);
    const replay = engine.ingest([severityEvent('evt-idem-2', 60001, 'high')]);
    assert.equal(replay.analysisRequests.length, 0);
    assert.equal(replay.analysisDenied.length, 0);
    assert.equal(replay.alerts[0].analysisRequested, 0);
    assert.equal(engine.stats().analysisRequests, 1);
    assert.equal(engine.stats().analysisDenied, 0);
  });

  it('does not request analysis below the minimum severity', () => {
    const engine = createTestEngine({
      rules: [severityRule],
      limits: { ...fastLimits, analysisMinSeverity: 'critical' },
    });
    const result = engine.ingest([severityEvent('evt-min-1', 1000, 'medium')]);
    assert.equal(result.analysisRequests.length, 0);
    assert.equal(result.analysisDenied.length, 0);
    assert.equal(result.alerts.length, 1);
    assert.equal(engine.stats().analysisRequests, 0);
    assert.equal(engine.stats().analysisDenied, 0);
  });
});

describe('hourly buckets survive event time going backwards', () => {
  // 复核 P1-2 的单元级复现：limit=1/小时、同一指纹同一严重度，at = 770/775/790/778 分钟。
  // 旧实现把 778min（回退到 12 点）当成"新的一小时"重置了计数与去重集合，于是同一个
  // requestKey（de5e221d…）被第二次铸造，requestId 却不同。
  const MINUTE_MS = 60000;
  const alert = {
    alertId: 'abcdef01-2345-4678-9abc-def012345678',
    severity: 'high',
    status: 'open',
    count: 1,
    ruleType: 'condition',
  };

  function call(state, ids, minutes, candidate = alert) {
    return requestAnalysis({
      alert: candidate,
      alertView: { alertId: candidate.alertId },
      fingerprint: 'fp-hour-regression',
      ruleId: 'proc.example-start',
      at: minutes * MINUTE_MS,
      rateState: state,
      limits: { analysisPerFingerprintPerHour: 1, analysisMinSeverity: 'info' },
      nextId: ids.next,
    });
  }

  it('never re-mints a released requestKey when the hour rewinds', () => {
    const state = createRateState();
    const ids = createSequenceIdFactory(1);

    const first = call(state, ids, 770);
    assert.equal(first.status, 'released');
    assert.equal(first.request.hourStart, hourStartFor(770 * MINUTE_MS));
    assert.equal(first.request.sequenceInHour, 1);

    assert.equal(call(state, ids, 775).status, 'deduplicated');

    const nextHour = call(state, ids, 790);
    assert.equal(nextHour.status, 'released');
    assert.notEqual(nextHour.requestKey, first.requestKey);

    // 回退到 12 点：同 key 必须命中去重，而不是再次放行。
    const rewound = call(state, ids, 778);
    assert.equal(rewound.status, 'deduplicated');
    assert.equal(rewound.requestKey, first.requestKey);
    assert.equal(rewound.request, undefined);

    // 全生命周期里，同一个 idempotencyKey 只铸造过一次。
    assert.equal(state.minted.size, 2);
  });

  it('cannot exceed the hourly limit through a different key in a rewound hour', () => {
    const state = createRateState();
    const ids = createSequenceIdFactory(1);
    assert.equal(call(state, ids, 770).status, 'released');

    // 同一小时、不同严重度 → 不同 requestKey，但配额已用完：必须拒绝，不能因回退清零。
    const otherSeverity = { ...alert, severity: 'critical' };
    const denied = call(state, ids, 778, otherSeverity);
    assert.equal(denied.status, 'denied');
    assert.equal(denied.denial.reason, 'fingerprint-hourly-limit');
    assert.equal(denied.denial.hourStart, hourStartFor(778 * MINUTE_MS));
    assert.equal(state.buckets.get(hourStartFor(778 * MINUTE_MS)).count, 1);
  });

  it('engine level: a regression to an earlier hour never mints a second key for one request', () => {
    const severityRule = makeConditionRule({
      severity: 'info',
      severityFrom: 'severity',
      fields: ['process.name', 'severity'],
      fingerprint: ['process.name'],
    });
    const engine = createTestEngine({
      rules: [severityRule],
      clock: createManualClock(0),
      limits: {
        // 一整天一个窗口：回退的时间仍落在同一个告警窗口里，只考察小时配额。
        aggregationWindowMs: 86400000,
        escalationCooldownMs: 0,
        analysisPerFingerprintPerHour: 1,
        analysisMinSeverity: 'info',
      },
    });

    const requests = [];
    const at1310 = 13 * 3600000 + 10 * 60000;
    const at1205 = 12 * 3600000 + 5 * 60000;

    requests.push(...engine.ingest([severityEvent('evt-reg-1', at1310, 'medium')]).analysisRequests);
    requests.push(...engine.ingest([severityEvent('evt-reg-2', at1205, 'high')]).analysisRequests);
    const rewound = engine.ingest([severityEvent('evt-reg-3', at1310, 'critical')]);

    assert.deepEqual(rewound.analysisRequests, []);
    assert.deepEqual(rewound.alerts.map((entry) => entry.severity), ['critical']);
    // 聚合层对回退的 observedAt 是显式处理的：计数照常累加，firstSeen 取最小、lastSeen 取最大，
    // 只有"窗口回退"才是 late-window（这里是同一个 24h 窗口）。
    assert.deepEqual(
      rewound.alerts.map((entry) => [entry.count, entry.firstSeen, entry.lastSeen]),
      [[3, at1205, at1310]],
    );
    assert.deepEqual(rewound.gaps, []);
    assert.deepEqual(
      requests.map((request) => [request.hourStart, request.sequenceInHour]),
      [[hourStartFor(at1310), 1], [hourStartFor(at1205), 1]],
    );
    // 同一个 (fingerprint, hour, severity) 只会产生一个 idempotencyKey。
    assert.equal(new Set(requests.map((request) => request.idempotencyKey)).size, requests.length);
    assert.equal(engine.stats().analysisRequests, 2);
  });
});

describe('global analysis gate', () => {
  it('denies through the gate without consuming the hourly budget', () => {
    let allowed = false;
    const engine = createTestEngine({
      rules: [severityRule],
      limits: fastLimits,
      analysisGate: () => allowed,
    });
    const denied = engine.ingest([severityEvent('evt-gate-1', 1000, 'info')]);
    assert.equal(denied.analysisRequests.length, 0);
    assert.equal(denied.analysisDenied.length, 1);
    assert.equal(denied.analysisDenied[0].reason, 'global-budget');
    assert.equal(denied.analysisDenied[0].severity, 'info');

    allowed = true;
    let released = 0;
    let sequence = 0;
    for (const [eventId, observedAt, severity] of [
      ['evt-gate-2', 2000, 'low'],
      ['evt-gate-3', 3000, 'medium'],
      ['evt-gate-4', 4000, 'high'],
      ['evt-gate-5', 5000, 'critical'],
    ]) {
      const result = engine.ingest([severityEvent(eventId, observedAt, severity)]);
      released += result.analysisRequests.length;
      if (result.analysisRequests.length === 1) {
        sequence = result.analysisRequests[0].sequenceInHour;
      }
    }
    assert.equal(released, 4);
    assert.equal(sequence, 4);
    assert.equal(engine.stats().analysisRequests, 4);
    assert.equal(engine.stats().analysisDenied, 1);
  });

  it('treats a throwing gate as a denial', () => {
    const engine = createTestEngine({
      rules: [severityRule],
      limits: fastLimits,
      analysisGate: () => {
        throw new Error('synthetic budget failure');
      },
    });
    let result;
    assert.doesNotThrow(() => {
      result = engine.ingest([severityEvent('evt-gate-6', 1000, 'critical')]);
    });
    assert.equal(result.analysisDenied.length, 1);
    assert.equal(result.analysisDenied[0].reason, 'global-budget');
    assert.equal(engine.stats().analysisRequests, 0);
  });

  it('passes the alert view and request context to the gate', () => {
    const seen = [];
    const engine = createTestEngine({
      rules: [severityRule],
      clock: createManualClock(0),
      limits: fastLimits,
      analysisGate: (alert, context) => {
        seen.push({ alert, context });
        return true;
      },
    });
    engine.ingest([severityEvent('evt-gate-7', 1000, 'high')]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].alert.severity, 'high');
    assert.equal(seen[0].alert.count, 1);
    assert.equal(seen[0].context.at, 1000);
    assert.equal(seen[0].context.hourStart, 0);
    assert.equal(seen[0].context.ruleId, 'proc.example-start');
    assert.match(seen[0].context.requestKey, /^[0-9a-f]{32}$/u);
  });
});

describe('id minting happens before the budget is charged', () => {
  // 上一轮的 P1-2 修了"先记账后取号"的缺陷，但当时代价是：唯一的验证方式是在**新建**
  // 引擎上重试，而新引擎的 rateState 本来就是空的，所以那条断言恒真（本轮独立审查
  // 实测：把记账挪回取号之前，14 条测试仍然全绿）。要让它能失败，必须在**同一个**
  // rateState 上做前后对比。
  const alert = { alertId: 'abcdef01-2345-4678-9abc-def012345678', severity: 'high', status: 'open', count: 1, ruleType: 'condition' };

  function call(rateState, nextId) {
    return requestAnalysis({
      alert,
      alertView: { alertId: alert.alertId },
      fingerprint: 'fp-budget-proof',
      ruleId: 'proc.example-start',
      at: 1000,
      rateState,
      limits: { analysisPerFingerprintPerHour: 4, analysisMinSeverity: 'info' },
      nextId,
    });
  }

  it('a throwing factory leaves count and released untouched, so the same state can still release', () => {
    const rateState = createRateState();
    assert.throws(
      () => call(rateState, () => {
        throw new DetectionConfigError('id factory threw while minting an id', { path: 'ids' });
      }),
      (error) => error instanceof DetectionConfigError && error.path === 'ids',
    );
    // 这一条才是"配额没被吃掉"的可失败断言：若记账挪到取号之前，count 会是 1、released 会有一条。
    assert.equal(rateState.count, 0, 'a failed mint must not consume the hourly budget');
    assert.equal(rateState.hourStart, hourStartFor(1000), 'the bucket must still be initialised normally');
    assert.equal(rateState.released.size, 0, 'a failed mint must not enter the idempotency set');

    // 同一个 rateState 上用能工作的工厂重试：必须放行，且小时序号是 1（不是 2）。
    const retry = call(rateState, () => '00000001-0000-4000-8000-000000000000');
    assert.equal(retry.status, 'released');
    assert.equal(retry.request.sequenceInHour, 1, 'the failed attempt must not shift the hourly sequence');
    assert.equal(rateState.count, 1);
    assert.equal(rateState.released.size, 1);
  });

  it('a factory returning a non UUIDv4 also leaves the budget untouched', () => {
    const rateState = createRateState();
    assert.throws(() => call(rateState, () => 'not-a-uuid'), /canonical UUIDv4/u);
    assert.equal(rateState.count, 0);
    assert.equal(rateState.released.size, 0);
    const retry = call(rateState, () => '00000002-0000-4000-8000-000000000000');
    assert.equal(retry.request.sequenceInHour, 1);
  });

  it('the released summary reuses the shared D0 contract instead of a local literal', () => {
    const rateState = createRateState();
    const outcome = call(rateState, () => '00000003-0000-4000-8000-000000000000');
    assert.deepEqual(Object.keys(outcome.request.summaryDto), ['classification', 'fields']);
    assert.equal(outcome.request.summaryDto.classification, 'D0');
    assert.deepEqual(Object.keys(outcome.request.summaryDto.fields), [
      'sequence_in_hour',
      'severity_rank',
      'alert_count',
      'rule_type',
    ]);
  });
});
