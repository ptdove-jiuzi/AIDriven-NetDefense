/**
 * isolation.test.js — per-rule timeout and error isolation, recovery and
 * step-budget fallback (AT-DET-002).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createManualClock } from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent } from './helpers.js';

const ruleA = makeConditionRule({ ruleId: 'rule.a', severity: 'high' });
const ruleB = makeConditionRule({ ruleId: 'rule.b', severity: 'low', tags: ['secondary'] });

/**
 * Scripted CPU clock: the first value is consumed by construction validation,
 * then one value per call, repeating the last value afterwards.
 *
 * @param {number[]} values Call values, at least one entry.
 * @returns {{ now: () => number }} Fake CPU clock.
 */
function scriptedCpuClock(values) {
  let index = 0;
  return {
    now() {
      const value = index < values.length ? values[index] : values[values.length - 1];
      index += 1;
      return value;
    },
  };
}

/**
 * Clock that stays at 0 for the first rule of the batch and reports 1000 for the
 * second one, so exactly one rule exceeds a 50ms budget.
 *
 * @returns {{ now: () => number }} Fake CPU clock.
 */
function spikingCpuClock() {
  return scriptedCpuClock([0, 0, 1000]);
}

describe('rule isolation', () => {
  it('isolates a rule that exceeds the CPU budget and keeps the others running', () => {
    const engine = createTestEngine({
      rules: [ruleA, ruleB],
      clock: createManualClock(0),
      cpuClock: spikingCpuClock(),
    });
    const result = engine.ingest([makeEvent({ eventId: 'evt-iso-1' })]);
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].ruleId, 'rule.b');
    // 隔离记录必须带上实测消耗，否则运维无法区分"规则太慢"与"预算配太小"。
    assert.deepEqual(result.ruleIsolations, [
      { ruleId: 'rule.a', kind: 'timeout', reason: 'cpu-budget-exceeded', at: 0, cpuUsedMs: 1000, steps: 1 },
    ]);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].kind, 'rule-isolated');
    assert.equal(result.gaps[0].ruleId, 'rule.a');
    assert.equal(result.gaps[0].count, 1);
    assert.equal(engine.stats().rulesIsolated, 1);
    assert.equal(engine.stats().rulesEnabled, 1);
    assert.deepEqual(engine.ruleStates(), [
      {
        ruleId: 'rule.a',
        state: 'isolated',
        kind: 'timeout',
        reason: 'cpu-budget-exceeded',
        isolatedAt: 0,
        batchId: 'batch-1',
        cpuUsedMs: 1000,
        steps: 1,
      },
      {
        ruleId: 'rule.b',
        state: 'enabled',
        kind: null,
        reason: null,
        isolatedAt: null,
        batchId: null,
        cpuUsedMs: null,
        steps: null,
      },
    ]);

    const next = engine.ingest([makeEvent({ eventId: 'evt-iso-2', observedAt: 2000 })]);
    assert.equal(next.detections.length, 1);
    assert.equal(next.detections[0].ruleId, 'rule.b');
    assert.equal(next.ruleIsolations.length, 0);
    assert.equal(engine.stats().ruleIsolations, 1);
    assert.equal(engine.stats().gapsByKind['rule-isolated'], 1);
  });

  // DEF-11：字段读不出来（getter / Proxy 陷阱）是**数据**故障，不是规则代码 bug。
  // 旧行为是把规则永久隔离 —— 一条畸形事件就能让一条规则在后续所有批次里闭嘴。
  // 现在的契约是：本事件降级为不命中 + 记一条 unreadable-field 缺口，规则保持启用。
  it('downgrades an unreadable event field to a gap instead of isolating the rule', () => {
    const explosive = new Proxy(
      { name: 'example-process', code: 'example' },
      {
        get(target, key) {
          if (key === 'code') {
            throw new Error('synthetic field read failure');
          }
          return target[key];
        },
      },
    );
    const throwingRule = makeConditionRule({
      ruleId: 'rule.boom',
      fields: ['process.code', 'process.name'],
      fingerprint: ['process.name'],
      when: { field: 'process.code', operator: 'exists' },
    });
    const engine = createTestEngine({ rules: [throwingRule, ruleB], clock: createManualClock(0) });
    const event = {
      eventId: 'evt-iso-3',
      observedAt: 1000,
      type: 'process_start',
      source: '10.0.0.1',
      fields: { process: explosive },
    };
    let result;
    assert.doesNotThrow(() => {
      result = engine.ingest([event]);
    });
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].ruleId, 'rule.b');
    assert.equal(result.ruleIsolations.length, 0, 'a data failure must not isolate the rule');
    const gap = result.gaps.find((entry) => entry.kind === 'unreadable-field');
    assert.notEqual(gap, undefined, 'the degraded event is reported as a gap');
    assert.equal(gap.ruleId, 'rule.boom');
    assert.equal(gap.detail.path, 'process.code');
    assert.equal(gap.detail.reason, 'synthetic field read failure');
    assert.equal(engine.ruleStates().find((state) => state.ruleId === 'rule.boom').state, 'enabled');
    assert.equal(engine.stats().unreadableFields, 1);
    assert.equal(result.decisions[0].outcome, 'evaluated');
    assert.deepEqual(result.decisions[0].ruleIds, ['rule.b']);

    // 同一条规则在下一批里仍然被求值：这正是 DEF-11 要消灭的"粘性隔离"。
    const next = engine.ingest([makeEvent({ eventId: 'evt-iso-3b', observedAt: 2000 })]);
    assert.equal(next.ruleIsolations.length, 0);
    assert.equal(engine.ruleStates().find((state) => state.ruleId === 'rule.boom').state, 'enabled');
    assert.deepEqual(next.decisions[0].ruleIds, ['rule.b']);
  });

  it('isolates a rule that exceeds the step budget', () => {
    const wideRule = makeConditionRule({
      ruleId: 'rule.wide',
      when: {
        all: [
          { field: 'process.name', operator: 'eq', value: 'example-process' },
          { field: 'process.name', operator: 'exists' },
          { field: 'process.name', operator: 'ne', value: 'other-process' },
        ],
      },
    });
    const engine = createTestEngine({ rules: [wideRule], limits: { maxEvaluationsPerRulePerBatch: 2 } });
    const result = engine.ingest([makeEvent({ eventId: 'evt-iso-4' })]);
    assert.equal(result.detections.length, 0);
    assert.equal(result.ruleIsolations.length, 1);
    assert.equal(result.ruleIsolations[0].kind, 'timeout');
    assert.equal(result.ruleIsolations[0].reason, 'step-budget-exceeded');
    assert.equal(result.gaps[0].detail.reason, 'step-budget-exceeded');
  });

  it('rehabilitates an isolated rule and reports unknown identifiers', () => {
    const engine = createTestEngine({
      rules: [ruleA, ruleB],
      clock: createManualClock(0),
      cpuClock: spikingCpuClock(),
    });
    const first = engine.ingest([makeEvent({ eventId: 'evt-iso-5' })]);
    assert.equal(first.detections.length, 1);
    assert.equal(engine.rehabilitateRule('rule.a'), true);
    assert.equal(engine.rehabilitateRule('rule.unknown'), false);
    assert.equal(engine.stats().rulesIsolated, 0);
    const second = engine.ingest([makeEvent({ eventId: 'evt-iso-6', observedAt: 2000 })]);
    assert.equal(second.detections.length, 2);
    assert.deepEqual(
      second.detections.map((detection) => detection.ruleId),
      ['rule.a', 'rule.b'],
    );
    assert.equal(engine.ruleStates().find((state) => state.ruleId === 'rule.a').state, 'enabled');
  });

  it('degrades hostile property getters to invalid decisions', () => {
    const engine = createTestEngine({ rules: [ruleB] });
    const throwingId = makeEvent({ eventId: 'evt-hostile-1', observedAt: 1000 });
    Object.defineProperty(throwingId, 'eventId', {
      enumerable: true,
      get() {
        throw new Error('synthetic getter failure');
      },
    });
    const throwingFields = makeEvent({ eventId: 'evt-hostile-2', observedAt: 2000 });
    Object.defineProperty(throwingFields, 'fields', {
      enumerable: true,
      get() {
        throw new Error('synthetic fields failure');
      },
    });

    let result;
    assert.doesNotThrow(() => {
      result = engine.ingest([
        throwingId,
        throwingFields,
        makeEvent({ eventId: 'evt-hostile-3', observedAt: 3000 }),
      ]);
    });
    assert.equal(result.eventsProcessed, 3);
    assert.equal(result.decisions.length, 3);
    assert.equal(result.decisions[0].outcome, 'invalid');
    assert.equal(result.decisions[0].reason, 'unreadable-event');
    assert.equal('eventId' in result.decisions[0], false);
    assert.equal(result.decisions[1].outcome, 'invalid');
    assert.equal(result.decisions[1].eventId, 'evt-hostile-2');
    assert.equal(result.decisions[1].reason, 'unreadable-event');
    assert.equal(result.decisions[2].outcome, 'evaluated');
    assert.equal(result.detections.length, 1);
    assert.deepEqual(result.detections[0].eventIds, ['evt-hostile-3']);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].kind, 'invalid-event');
    assert.equal(result.gaps[0].count, 2);
    assert.equal(engine.stats().invalidEvents, 2);
    assert.equal(engine.stats().detections, 1);
  });

  it('skips rules disabled by the pack', () => {
    const disabled = makeConditionRule({ ruleId: 'rule.off', enabled: false });
    const engine = createTestEngine({ rules: [disabled, ruleB] });
    const result = engine.ingest([makeEvent({ eventId: 'evt-iso-7' })]);
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].ruleId, 'rule.b');
    assert.equal(engine.ruleStates().find((state) => state.ruleId === 'rule.off').state, 'disabled');
    assert.equal(engine.stats().rulesEnabled, 1);
  });

  it('a broken cpu clock is a wiring fault, not a rule fault: it freezes instead of isolating', () => {
    // 独立审查 P2-1：`cpuClock.now()` 原本在 evaluateRule 的 try 里，抛错会被
    // isolateRule 吞成 rule-isolated，把"时钟坏了"错误归因给规则。
    let calls = 0;
    const brokenCpuClock = {
      now() {
        calls += 1;
        if (calls > 1) {
          throw new Error('cpu clock offline');
        }
        return 0;
      },
    };
    const engine = createTestEngine({ rules: [ruleA], cpuClock: brokenCpuClock });
    assert.throws(
      () => engine.ingest([makeEvent({ eventId: 'evt-cpu-1' })]),
      (error) => error instanceof Error && /cpu clock offline/u.test(error.message),
    );
    const stats = engine.stats();
    assert.equal(stats.ruleIsolations, 0, 'a wiring fault must never be recorded as rule isolation');
    assert.equal(engine.ruleStates()[0].state, 'enabled', 'the rule itself is healthy');
    assert.equal(stats.fatal !== null, true, 'the batch is fatal, so the engine freezes');
    assert.match(stats.fatal.reason, /cpu clock offline/u);
  });
});
