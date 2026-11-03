/**
 * budget-clock.test.js — the budget clock decides which rules get isolated, so
 * it must be deterministic by default (review P1-1).
 *
 * The reproduction that motivated these cases: 60 rules × 1000 events with the
 * default configuration returned 4337 / 6224 / 5734 detections on three
 * consecutive runs and permanently isolated all 60 rules with
 * `cpu-budget-exceeded`, because the meter read `process.hrtime` and the 50ms
 * per-rule budget was compared against wall time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_BUDGET_QUANTUM_MS,
  DetectionConfigError,
  assertClock,
  createDetectionEngine,
  createManualClock,
  createRealtimeClock,
  createSequenceIdFactory,
  createStepClock,
  isRealtimeClock,
} from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent, makePack } from './helpers.js';

const RULE_COUNT = 60;
const EVENT_COUNT = 1000;

/**
 * Build the review's probe pack: `RULE_COUNT` condition rules that all match one
 * process name, so every event produces one detection per rule.
 *
 * @returns {object} Rule pack.
 */
function probePack() {
  const rules = [];
  for (let index = 0; index < RULE_COUNT; index += 1) {
    rules.push(
      makeConditionRule({
        ruleId: `probe.rule-${String(index).padStart(2, '0')}`,
        fields: ['process.name'],
        fingerprint: ['process.name'],
        when: { field: 'process.name', operator: 'eq', value: 'example-process' },
      }),
    );
  }
  return makePack(rules);
}

/**
 * Build the probe events: one process name, distinct ids and increasing times.
 *
 * @returns {object[]} Events.
 */
function probeEvents() {
  const events = [];
  for (let index = 0; index < EVENT_COUNT; index += 1) {
    events.push(
      makeEvent({
        eventId: `evt-probe-${index}`,
        observedAt: 1000 + index,
        fields: { process: { name: 'example-process', path: '/tmp/example/tool' } },
      }),
    );
  }
  return events;
}

/**
 * Run the probe once with a replayable id factory.
 *
 * @param {object} [options] Extra engine options.
 * @returns {{ output: object[], stats: object, rules: object[] }} Observable state.
 */
function runProbe(options = {}) {
  const engine = createDetectionEngine({
    rulePack: probePack(),
    clock: createManualClock(0),
    ids: createSequenceIdFactory(1),
    ...options,
  });
  const result = engine.ingest(probeEvents());
  return { output: [result], stats: engine.stats(), rules: engine.ruleStates() };
}

describe('deterministic budget metering', () => {
  it('60 rules × 1000 events: two default runs are byte identical and isolate nothing', () => {
    const first = runProbe();
    const second = runProbe();

    // 默认预算下 60000 条检测一条都不能丢——旧实现会在这里永久隔离全部 60 条规则。
    assert.equal(first.output[0].detections.length, RULE_COUNT * EVENT_COUNT);
    assert.equal(first.output[0].alerts.length, RULE_COUNT);
    assert.equal(first.output[0].ruleIsolations.length, 0);
    assert.equal(first.stats.rulesIsolated, 0);
    assert.equal(first.stats.rulesEnabled, RULE_COUNT);
    assert.equal(first.stats.analysisRequests > 0, true);

    // 复核脚本的判定：同一输入序列 + 同一输入时钟，结果必须逐字节相同。
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.stats.budgetClock, 'step');
    assert.equal(first.stats.budgetQuantumMs, DEFAULT_BUDGET_QUANTUM_MS);
    assert.equal(first.stats.nondeterministicBudget, false);
  });

  it('the budget guard still isolates rules that exceed it', () => {
    const outcome = runProbe({ limits: { ruleCpuBudgetMs: 1 } });
    const result = outcome.output[0];
    assert.equal(outcome.stats.rulesIsolated, RULE_COUNT);
    assert.equal(result.ruleIsolations.length, RULE_COUNT);
    for (const isolation of result.ruleIsolations) {
      assert.equal(isolation.kind, 'timeout');
      assert.equal(isolation.reason, 'cpu-budget-exceeded');
      // 隔离记录保留实测消耗，而不是像旧实现那样丢掉。
      assert.equal(isolation.cpuUsedMs > 1, true);
      assert.equal(typeof isolation.steps, 'number');
    }
    // 超预算发生在批次中途：既不是"一条都没跑"（守卫生效前就先死了），也不是全量放行。
    assert.equal(result.detections.length > 0, true);
    assert.equal(result.detections.length < RULE_COUNT * EVENT_COUNT, true);
    // 同一输入重复跑，隔离集合必须完全一致。
    assert.equal(JSON.stringify(outcome), JSON.stringify(runProbe({ limits: { ruleCpuBudgetMs: 1 } })));
  });

  it('honours budgetQuantumMs instead of hard coding the quantum', () => {
    // 量子 1ms × 1000 次采样 = 1000ms，默认 50ms 预算必然超；量子是 0.01 时不会超。
    const coarse = runProbe({ budgetQuantumMs: 1 });
    assert.equal(coarse.stats.rulesIsolated, RULE_COUNT);
    assert.equal(coarse.stats.budgetQuantumMs, 1);
    assert.equal(runProbe().stats.rulesIsolated, 0);
  });

  it('rejects a wall clock unless the caller accepts losing replay determinism', () => {
    const configuration = {
      rulePack: probePack(),
      clock: createManualClock(0),
      ids: createSequenceIdFactory(1),
    };
    assert.equal(isRealtimeClock(createRealtimeClock()), true);

    assert.throws(
      () => createDetectionEngine({ ...configuration, cpuClock: createRealtimeClock() }),
      (error) => error instanceof DetectionConfigError
        && error.code === 'NONDETERMINISTIC_BUDGET'
        && error.path === 'cpuClock',
    );

    const accepted = createDetectionEngine({
      ...configuration,
      cpuClock: createRealtimeClock(),
      allowNondeterministicBudget: true,
    });
    const stats = accepted.stats();
    assert.equal(stats.budgetClock, 'realtime');
    assert.equal(stats.nondeterministicBudget, true);
    assert.equal(stats.budgetQuantumMs, null);

    // 非布尔值的"承认"不算承认：fail-closed。
    assert.throws(
      () => createDetectionEngine({
        ...configuration,
        cpuClock: createRealtimeClock(),
        allowNondeterministicBudget: 'yes',
      }),
      (error) => error instanceof DetectionConfigError && error.path === 'allowNondeterministicBudget',
    );
  });

  it('validates budgetQuantumMs', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1001, '1']) {
      assert.throws(
        () => createDetectionEngine({
          rulePack: probePack(),
          clock: createManualClock(0),
          budgetQuantumMs: value,
        }),
        (error) => error instanceof DetectionConfigError && error.path === 'budgetQuantumMs',
        `budgetQuantumMs ${String(value)} must be rejected`,
      );
    }
  });

  it('the step clock advances a fixed quantum per call and counts calls', () => {
    const clock = createStepClock({ quantumMs: 2 });
    assert.equal(clock.quantumMs, 2);
    assert.deepEqual([clock.now(), clock.now(), clock.now()], [0, 2, 4]);
    assert.equal(clock.steps(), 3);
    assert.equal(createStepClock().quantumMs, DEFAULT_BUDGET_QUANTUM_MS);
    for (const quantumMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createStepClock({ quantumMs }),
        (error) => error instanceof DetectionConfigError && error.path === 'quantumMs',
      );
    }
  });
});

describe('event clock must agree with advanceTo', () => {
  it('rejects a fractional clock at construction instead of failing later in flush()', () => {
    // 旧行为：assertClock 只查 finite，构造通过；随后 flush() → advanceTo(1500.5)
    // 抛错并冻结一个本来健康的引擎（审查 P2：clock.js 与 engine.js 的校验不一致）。
    assert.throws(
      () => assertClock({ now: () => 1500.5 }),
      (error) => error instanceof DetectionConfigError && error.path === 'clock',
    );
    assert.throws(
      () => createDetectionEngine({
        rulePack: probePack(),
        clock: { now: () => 1500.5 },
        ids: createSequenceIdFactory(1),
      }),
      (error) => error instanceof DetectionConfigError && error.path === 'clock',
    );
    const integerClock = { now: () => 1500 };
    assert.equal(assertClock(integerClock).now(), 1500);
  });

  it('flush() advances to the current clock value and closes due windows', () => {
    const clock = createManualClock(0);
    const engine = createTestEngine({ rules: [makeConditionRule()], clock });
    engine.ingest([makeEvent({ eventId: 'evt-flush-1', observedAt: 1000 })]);

    clock.set(900000);
    const first = engine.flush();
    assert.equal(first.at, 900000);
    assert.equal(first.eventsProcessed, 0);
    assert.equal(first.closedAlerts.length, 1);
    assert.equal(first.closedAlerts[0].windowStart, 0);
    assert.equal(engine.stats().closedAlerts, 1);

    // 第二次 flush 同值：不得重复关闭，也不得抛错。
    const second = engine.flush();
    assert.equal(second.at, 900000);
    assert.equal(second.closedAlerts.length, 0);
    assert.equal(engine.stats().fatal, null);
  });
});
