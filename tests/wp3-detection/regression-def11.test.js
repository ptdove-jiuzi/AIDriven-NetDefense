/**
 * DEF-11 回归用例（M9 P2 修复）。
 *
 * 缺陷：`resolveField` 在事件的 `fields` 上触发 getter / Proxy 陷阱时，异常被
 * `evaluateRule` 的同一个 catch 捕获 → `isolateRule` → 规则进入**粘性隔离**，
 * 只有 `rehabilitateRule` 才恢复。
 *
 * 后果是数据驱动的检测 DoS：一条恶意（或仅仅畸形）事件足以让一条规则在后续
 * 所有批次里闭嘴，而文件头承诺的是"处理数据时永不抛错"。
 *
 * 修复后的契约：
 * - 规则代码异常 → 仍然是隔离（这是配方错误，值得隔离）；
 * - 事件字段不可读（getter / Proxy / 描述符陷阱）→ 只降级**本事件**：
 *   不命中、记一条 `unreadable-field` 缺口、规则保持启用。
 *
 * 修复前这些用例会红：`ruleIsolations.length` 是 1 而不是 0，
 * `gap.kind` 是 `rule-isolated` 而不是 `unreadable-field`。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createManualClock } from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent } from './helpers.js';

describe('DEF-11 unreadable event fields (data) versus rule failures (code)', () => {
  it('a Proxy that throws on every trap degrades the event, never the rule', () => {
    const proxy = new Proxy({}, {
      get() {
        throw new TypeError('hostile get');
      },
      has() {
        throw new TypeError('hostile has');
      },
      getOwnPropertyDescriptor() {
        throw new TypeError('hostile descriptor');
      },
    });
    const readingRule = makeConditionRule({
      ruleId: 'rule.reads',
      fields: ['process.name'],
      when: { field: 'process.name', operator: 'exists' },
    });
    const engine = createTestEngine({
      rules: [readingRule],
      clock: createManualClock(0),
    });

    const result = engine.ingest([makeEvent({ eventId: 'evt-def11-1', fields: { process: proxy } })]);

    // 1) 规则没有被隔离：这是本缺陷的核心断言。
    assert.equal(result.ruleIsolations.length, 0);
    assert.equal(engine.stats().ruleIsolations, 0);
    assert.equal(engine.stats().gapsByKind['rule-isolated'], 0);
    assert.equal(
      engine.ruleStates().find((state) => state.ruleId === 'rule.reads').state,
      'enabled',
    );

    // 2) 数据故障被记成缺口，并带上读不出的路径。
    assert.equal(engine.stats().gapsByKind['unreadable-field'], 1);
    assert.equal(engine.stats().unreadableFields, 1);
    const gap = result.gaps.find((entry) => entry.kind === 'unreadable-field');
    assert.notEqual(gap, undefined);
    assert.equal(gap.ruleId, 'rule.reads');
    assert.equal(gap.detail.path, 'process.name');
    assert.equal(gap.count, 1);

    // 3) 事件没有被整条判成 invalid：字段读不出来不等于事件本身非法。
    assert.equal(engine.stats().invalidEvents, 0);
    assert.equal(result.detections.length, 0);
  });

  it('a throwing getter on one field does not blind the rules that read other fields', () => {
    const fields = { user: { name: 'example-user' } };
    Object.defineProperty(fields, 'process', {
      enumerable: true,
      configurable: true,
      get() {
        throw new RangeError('hostile getter');
      },
    });
    const engine = createTestEngine({
      rules: [
        makeConditionRule({
          ruleId: 'rule.blind',
          fields: ['process.name'],
          fingerprint: ['process.name'],
          when: { field: 'process.name', operator: 'exists' },
        }),
        makeConditionRule({
          ruleId: 'rule.sees',
          fields: ['user.name'],
          fingerprint: ['user.name'],
          when: { field: 'user.name', operator: 'eq', value: 'example-user' },
        }),
      ],
      clock: createManualClock(0),
    });

    const result = engine.ingest([makeEvent({ eventId: 'evt-def11-2', fields })]);
    assert.equal(result.ruleIsolations.length, 0);
    assert.deepEqual(result.decisions[0].ruleIds, ['rule.sees'], 'the blast radius is one rule, not the batch');
    assert.equal(result.gaps.find((gap) => gap.kind === 'unreadable-field').detail.path, 'process.name');
    assert.equal(engine.ruleStates().every((state) => state.state === 'enabled'), true);
  });

  it('the same rule keeps working on the next, well-formed event', () => {
    const fields = {};
    Object.defineProperty(fields, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        throw new RangeError('hostile getter');
      },
    });
    const engine = createTestEngine({
      rules: [makeConditionRule({
        ruleId: 'rule.getter',
        fields: ['process.name'],
        when: { field: 'process.name', operator: 'exists' },
      })],
      clock: createManualClock(0),
    });

    const first = engine.ingest([makeEvent({ eventId: 'evt-def11-3', fields: { process: fields } })]);
    assert.equal(first.ruleIsolations.length, 0);
    assert.equal(first.gaps.find((gap) => gap.kind === 'unreadable-field').detail.path, 'process.name');

    // 关键：下一批仍然是"读到就命中"，而不是"永久闭嘴"。
    const second = engine.ingest([makeEvent({ eventId: 'evt-def11-4', observedAt: 2000 })]);
    assert.equal(second.ruleIsolations.length, 0);
    assert.equal(second.detections.length, 1, 'the rule still runs after the malformed event');
    assert.equal(second.detections[0].ruleId, 'rule.getter');
  });

  it('a field value that cannot be converted to text is data too, not a rule bug', () => {
    // DEF-11 的验收面不止"属性访问"：`String(value)` 同样会对字段值求值，
    // `Object.create(null)` 没有原型、无法转成原始值，于是指纹归一化会抛错。
    // 这仍然是**数据**故障：旧实现把它算到规则头上 → 规则永久隔离。
    const engine = createTestEngine({
      rules: [makeConditionRule({
        ruleId: 'rule.text',
        fields: ['process.name'],
        fingerprint: ['process.name'],
        when: { field: 'process.name', operator: 'exists' },
      })],
      clock: createManualClock(0),
    });

    const event = makeEvent({
      eventId: 'evt-def11-5',
      fields: { process: { name: Object.create(null) } },
    });
    const result = engine.ingest([event]);

    assert.equal(result.ruleIsolations.length, 0, 'an unconvertible value must not isolate the rule');
    const gap = result.gaps.find((entry) => entry.kind === 'unreadable-field');
    assert.notEqual(gap, undefined);
    assert.equal(gap.ruleId, 'rule.text');
    assert.equal(gap.detail.path, 'process.name');
    assert.equal(engine.ruleStates().find((state) => state.ruleId === 'rule.text').state, 'enabled');
  });

  it('a Proxy array field read by "contains" degrades the event, never isolates the rule', () => {
    // 第 2 轮独立审查发现的逃逸口：`contains` 的数组分支调用 `field.some(...)`，
    // 那个方法读取不在 `normalizeText` 的 try 里，Proxy 陷阱抛出的异常会落到
    // `evaluateRule` 的兜底分支 → 规则被永久隔离。
    const hostileArray = new Proxy([], {
      get() {
        throw new TypeError('hostile array get some');
      },
    });
    const engine = createTestEngine({
      rules: [makeConditionRule({
        ruleId: 'rule.arr',
        fields: ['process.name'],
        fingerprint: ['process.name'],
        when: { field: 'process.name', operator: 'contains', value: 'needle' },
      })],
      clock: createManualClock(0),
    });

    const first = engine.ingest([
      makeEvent({ eventId: 'evt-def11-arr-1', fields: { process: { name: hostileArray } } }),
    ]);
    assert.equal(first.ruleIsolations.length, 0, 'a Proxy array field must not isolate the rule');
    assert.equal(engine.ruleStates()[0].state, 'enabled');
    const gap = first.gaps.find((entry) => entry.kind === 'unreadable-field');
    assert.notEqual(gap, undefined);
    assert.equal(gap.detail.path, 'process.name', 'the gap points at the field that could not be read');
    assert.equal(gap.detail.reason, 'hostile array get some');

    // 同一规则在下一批正常事件上照常命中。
    const second = engine.ingest([
      makeEvent({ eventId: 'evt-def11-arr-2', observedAt: 2000, fields: { process: { name: 'has needle' } } }),
    ]);
    assert.equal(second.detections.length, 1);
    assert.equal(second.detections[0].ruleId, 'rule.arr');
  });

  it('a rule that really fails in code is still isolated (the distinction is preserved)', () => {
    // 预算耗尽不是数据故障，依旧走隔离路径 —— 证明修复没有把"隔离"整条逻辑废掉。
    const engine = createTestEngine({
      rules: [makeConditionRule({
        ruleId: 'rule.slow',
        when: {
          all: [
            { field: 'process.name', operator: 'eq', value: 'example-process' },
            { field: 'process.name', operator: 'exists' },
            { field: 'process.name', operator: 'ne', value: 'other' },
          ],
        },
      })],
      limits: { maxEvaluationsPerRulePerBatch: 1 },
      clock: createManualClock(0),
    });

    const result = engine.ingest([makeEvent({ eventId: 'evt-def11-4' })]);
    assert.equal(result.ruleIsolations.length, 1);
    assert.equal(result.ruleIsolations[0].kind, 'timeout');
    assert.equal(engine.stats().gapsByKind['unreadable-field'], 0);
  });
});
