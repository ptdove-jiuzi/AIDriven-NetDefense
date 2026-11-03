// author: PT-dove
// M9 对抗语料 —— detection 引擎的运行期负向行为。
//
// 引擎的承诺是"处理数据时永不抛错，只有调用方的接线错误才抛"。本文件逐条把这句话
// 变成可失败的断言：恶意事件要么被计入 invalid-event 缺口，要么让**单条规则**被隔离，
// 绝不能冻结整个引擎、污染原型、或在同一批里产出不确定的结果。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DetectionConfigError,
  computeFingerprint,
  createDetectionEngine,
  createManualClock,
  createSequenceIdFactory,
  resolveField,
} from '../../packages/detection/index.js';
import { structureText } from './support/harness.js';
import { detectionEvent, rulePack } from './support/fixtures.js';

const BASE = 1_700_000_000_000;

/** 只要求字段存在，用来把"事件是否被处理"与"条件是否命中"解耦。 */
function matchAllRule(overrides = {}) {
  return {
    ...rulePack().rules[0],
    when: { field: 'process.name', operator: 'exists' },
    ...overrides,
  };
}

/** 第二条规则：读 process.path，作为"另一条规则仍继续工作"的证人。 */
function secondRule(overrides = {}) {
  return {
    ruleId: 'corpus.second',
    version: '1.0.0',
    type: 'condition',
    severity: 'medium',
    fields: ['process.path'],
    fingerprint: ['process.path'],
    when: { field: 'process.path', operator: 'starts_with', value: '/opt/' },
    ...overrides,
  };
}

/**
 * 建引擎：固定时钟 + 序号 id 工厂，保证任何输出（含 detection id）都是确定的。
 *
 * @param {{ rules?: object[], matchAll?: boolean, limits?: object, maxEventsPerIngest?: number }} [options] 覆盖项。
 * @returns {object} 引擎句柄。
 */
function engineFor(options = {}) {
  const pack = rulePack();
  const rules = options.rules ?? (options.matchAll === true ? [matchAllRule()] : pack.rules);
  return createDetectionEngine({
    rulePack: { ...pack, rules },
    clock: createManualClock(BASE),
    ids: createSequenceIdFactory(1),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.maxEventsPerIngest === undefined ? {} : { maxEventsPerIngest: options.maxEventsPerIngest }),
  });
}

test('畸形事件被计为 invalid-event，引擎继续工作', () => {
  const engine = engineFor();
  const result = engine.ingest([
    null,
    [],
    'string',
    42,
    detectionEvent({ eventId: '' }),
    detectionEvent({ eventId: 'x'.repeat(257) }),
    detectionEvent({ observedAt: -1 }),
    detectionEvent({ observedAt: 1.5 }),
    detectionEvent({ type: '' }),
    detectionEvent({ type: 'x'.repeat(129) }),
    detectionEvent({ source: '' }),
    detectionEvent({ severity: 'apocalyptic' }),
    detectionEvent({ fields: [] }),
    detectionEvent({ fields: null }),
  ]);

  assert.equal(result.eventsProcessed, 14);
  assert.equal(result.detections.length, 0, 'no malformed event may produce a detection');
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].kind, 'invalid-event');
  assert.equal(result.gaps[0].count, 14);
  for (const decision of result.decisions) {
    assert.equal(decision.outcome, 'invalid');
    assert.equal(typeof decision.reason, 'string');
  }
  assert.equal(engine.stats().fatal, null, 'a malformed event must not freeze the engine');
});

test('fields 里的 getter 抛错：只降级本事件，不隔离规则（DEF-11 修复后）', () => {
  const engine = engineFor({ rules: [rulePack().rules[0], secondRule()] });
  const hostile = {
    process: {
      get name() {
        throw new Error('hostile getter');
      },
      path: '/opt/example/tool',
    },
  };
  const result = engine.ingest([detectionEvent({ fields: hostile })]);

  // 修复前：数据故障被当成规则故障 → isolateRule → 规则**粘性隔离**（数据驱动的检测 DoS）。
  // 修复后：只降级本事件 + 记一条 unreadable-field 缺口，规则保持启用。
  assert.deepEqual(result.ruleIsolations, [], 'a data fault must not isolate the rule');
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].kind, 'unreadable-field');
  assert.equal(result.gaps[0].ruleId, 'corpus.condition');
  assert.equal(result.gaps[0].detail.path, 'process.name', 'the gap must name the field that could not be read');
  assert.equal(result.gaps[0].detail.reason, 'hostile getter');
  assert.equal(engine.stats().unreadableFields, 1);
  assert.equal(engine.stats().rulesIsolated, 0);
  assert.equal(engine.ruleStates()[0].state, 'enabled');
  assert.equal(result.detections.length, 1, 'the healthy rule must still fire');
  assert.equal(result.detections[0].ruleId, 'corpus.second');
  assert.equal(engine.stats().fatal, null);

  // 不粘：下一条正常事件里这条规则重新参与求值并命中。
  const next = engine.ingest([
    detectionEvent({ eventId: 'evt-0002', fields: { process: { name: 'example-process', path: '/opt/x' } } }),
  ]);
  assert.deepEqual(next.ruleIsolations, []);
  assert.equal(
    next.decisions[0].ruleIds.includes('corpus.condition'),
    true,
    'the rule must be evaluated again instead of staying isolated',
  );
  assert.equal(next.detections.some((entry) => entry.ruleId === 'corpus.condition'), true);
});

test('被隔离的规则可以显式恢复，恢复后重新参与求值（隔离改由规则故障触发）', () => {
  // DEF-11 修复后，**数据故障不再产生隔离**，所以本用例改用仍然存在的规则故障路径：
  // 单规则步数预算耗尽（kind: 'timeout'）。恢复语义本身没有变化。
  const engine = engineFor({
    rules: [rulePack().rules[0], secondRule()],
    limits: { maxEvaluationsPerRulePerBatch: 1 },
  });
  engine.ingest([
    detectionEvent({ eventId: 'evt-1', fields: { process: { name: 'example-process', path: '/opt/x' } } }),
    detectionEvent({ eventId: 'evt-2', observedAt: BASE + 1, fields: { process: { name: 'example-process', path: '/opt/y' } } }),
  ]);
  assert.deepEqual(
    engine.ruleStates().map((entry) => entry.state),
    ['isolated', 'isolated'],
    'budget exhaustion isolates both rules (a rule fault, not a data fault)',
  );

  // 只恢复被点名的那一条，另一条保持隔离。
  assert.equal(engine.rehabilitateRule('corpus.condition'), true);
  assert.deepEqual(engine.ruleStates().map((entry) => entry.state), ['enabled', 'isolated']);
  assert.equal(engine.rehabilitateRule('no.such.rule'), false);

  // 恢复后重新参与求值并产出检测（单事件 1 步，不超过恢复后的预算）。
  const after = engine.ingest([
    detectionEvent({ eventId: 'evt-0009', observedAt: BASE + 2, fields: { process: { name: 'example-process', path: '/opt/z' } } }),
  ]);
  assert.deepEqual(after.ruleIsolations, []);
  assert.equal(after.detections.length, 1);
  assert.equal(after.detections[0].ruleId, 'corpus.condition');
});

test('fields 是 Proxy 时不会命中、不会污染原型，也不会隔离规则（DEF-11 修复后）', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  // 陷阱一律抛错：任何一次解引用都会变成异常。
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
  const engine = engineFor();
  const result = engine.ingest([detectionEvent({ fields: proxy })]);
  assert.equal(result.detections.length, 0);
  assert.equal(result.eventsProcessed, 1);
  assert.equal(engine.stats().fatal, null);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(','), before);

  // 修复前：`resolveField` 的 `hasOwnProperty` 触发陷阱，异常被 evaluateRule 的 try 捕获
  // → 规则被**永久**隔离（一条恶意事件足以让一条规则在后续所有批次里闭嘴）。
  // 修复后：数据故障只降级本事件，规则保持 enabled。
  assert.deepEqual(result.ruleIsolations, [], 'a hostile Proxy is a data fault, not a rule bug');
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].kind, 'unreadable-field');
  assert.equal(result.gaps[0].ruleId, 'corpus.condition');
  assert.equal(result.gaps[0].detail.reason, 'hostile descriptor');
  assert.equal(engine.ruleStates()[0].state, 'enabled');
  assert.equal(engine.stats().rulesIsolated, 0);
  assert.equal(engine.stats().unreadableFields, 1);

  // 对照：下一批正常事件里这条规则照常求值（不粘）。
  const next = engine.ingest([detectionEvent({ eventId: 'evt-0002' })]);
  assert.equal(next.detections.length, 1);
  assert.deepEqual(next.decisions[0].ruleIds, ['corpus.condition']);
});

test('fields 携带 __proto__ 自有键：规则读不到它，也不会污染 Object.prototype', () => {
  const fields = JSON.parse('{"__proto__":{"polluted":true},"process":{"name":"example-process"}}');
  const engine = engineFor();
  const result = engine.ingest([detectionEvent({ fields })]);
  assert.equal(result.detections.length, 1, 'the legitimate sibling field is still readable');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('高基数：maxFingerprints=2 时旧条目被驱逐并计入 fingerprint-limit', () => {
  const engine = engineFor({ matchAll: true, limits: { maxFingerprints: 2 } });
  const events = ['a', 'b', 'c', 'd', 'e'].map((name, index) => detectionEvent({
    eventId: `evt-${index}`,
    fields: { process: { name } },
  }));
  const result = engine.ingest(events);

  assert.equal(result.detections.length, 5);
  const evictions = result.gaps.filter((gap) => gap.kind === 'fingerprint-limit');
  // 每次驱逐带着被驱逐的指纹做 detail，所以按指纹各成一条记录，而不是合并成一条。
  assert.equal(evictions.length, 3, 'each evicted fingerprint gets its own gap record');
  assert.equal(evictions.reduce((total, gap) => total + gap.count, 0), 3);
  for (const gap of evictions) {
    assert.match(gap.detail.fingerprint, /^[0-9a-f]{64}$/u, 'the gap names the fingerprint that was dropped');
  }
  assert.ok(engine.stats().openFingerprints <= 2, 'the state store stays inside its bound');
});

test('阈值窗口超限：超出 maxEventsPerThresholdWindow 的观测被计入缺口而不是无限增长', () => {
  const threshold = {
    ruleId: 'corpus.threshold',
    version: '1.0.0',
    type: 'threshold',
    severity: 'medium',
    fields: ['process.name'],
    fingerprint: ['process.name'],
    groupBy: ['process.name'],
    count: { operator: 'gte', value: 1000 },
    windowMs: 60_000,
    maxEvents: 3,
  };
  const engine = engineFor({ rules: [threshold] });
  const result = engine.ingest(Array.from({ length: 10 }, (_, index) => detectionEvent({
    eventId: `evt-${index}`,
    observedAt: BASE + index,
    fields: { process: { name: 'same' } },
  })));

  assert.equal(result.detections.length, 0, 'the threshold was never reached');
  const overflow = result.gaps.filter((gap) => gap.kind === 'threshold-window-overflow');
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].count, 7);
});

test('预算耗尽：单规则步数超限被隔离，另一条规则照常产出', () => {
  const engine = engineFor({
    rules: [rulePack().rules[0], secondRule()],
    limits: { maxEvaluationsPerRulePerBatch: 1 },
  });
  const result = engine.ingest([
    detectionEvent({ eventId: 'evt-1', fields: { process: { name: 'example-process', path: '/opt/x' } } }),
    detectionEvent({ eventId: 'evt-2', observedAt: BASE + 1, fields: { process: { name: 'example-process', path: '/opt/y' } } }),
  ]);

  const timeouts = result.ruleIsolations.filter((entry) => entry.kind === 'timeout');
  assert.equal(timeouts.length, 2, 'both rules exhaust their step budget');
  assert.equal(timeouts[0].reason, 'step-budget-exceeded');
  assert.equal(result.gaps.filter((gap) => gap.kind === 'rule-isolated').length, 2);
  assert.equal(engine.stats().fatal, null, 'budget exhaustion is a rule fault, not an engine fault');
  assert.equal(engine.stats().rulesIsolated, 2);
});

test('超长字段：1 MiB 字段被处理，指纹预览被截断但摘要覆盖全文', () => {
  const engine = engineFor({ matchAll: true, limits: { maxFingerprintValueLength: 64 } });
  const longA = `x${'A'.repeat(1024 * 1024)}`;
  const longB = `x${'A'.repeat(1024 * 1024 - 1)}B`;
  const result = engine.ingest([
    detectionEvent({ eventId: 'evt-a', fields: { process: { name: longA } } }),
    detectionEvent({ eventId: 'evt-b', observedAt: BASE + 1, fields: { process: { name: longB } } }),
  ]);

  assert.equal(result.detections.length, 2);
  const [first, second] = result.detections;
  assert.equal([...first.fingerprintPreview[0].preview].length, 64, 'preview respects the limit in code points');
  assert.notEqual(first.fingerprint, second.fingerprint, 'values differing past the preview still hash differently');
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/u);
});

test('高基数（阈值分组）：maxThresholdGroups=2 时多余分组被驱逐并计入缺口', () => {
  const threshold = {
    ruleId: 'corpus.threshold',
    version: '1.0.0',
    type: 'threshold',
    severity: 'medium',
    fields: ['process.name'],
    fingerprint: ['process.name'],
    groupBy: ['process.name'],
    count: { operator: 'gte', value: 1000 },
    windowMs: 60_000,
  };
  const engine = engineFor({ rules: [threshold], limits: { maxThresholdGroups: 2 } });
  const result = engine.ingest(Array.from({ length: 6 }, (_, index) => detectionEvent({
    eventId: `evt-${index}`,
    observedAt: BASE + index,
    fields: { process: { name: `group-${index}` } },
  })));

  const gaps = result.gaps.filter((gap) => gap.kind === 'threshold-group-limit');
  assert.equal(gaps.length >= 1, true, 'evicting a threshold group must be visible as a gap');
  assert.equal(gaps.reduce((total, gap) => total + gap.count, 0), 4, 'six distinct groups, two retained');
  assert.ok(engine.stats().thresholdGroups <= 2, 'the group table stays inside its bound');
});

test('高基数（关联槽位）：maxCorrelationSlots=2 时多余槽位被拒并计入缺口', () => {
  const correlation = {
    ruleId: 'corpus.correlation',
    version: '1.0.0',
    type: 'correlation',
    severity: 'high',
    fields: ['process.name'],
    fingerprint: ['process.name'],
    groupBy: ['process.name'],
    withinMs: 60_000,
    steps: [
      { name: 'first', when: { field: 'process.name', operator: 'exists' } },
      { name: 'second', when: { field: 'process.name', operator: 'exists' } },
    ],
  };
  const engine = engineFor({ rules: [correlation], limits: { maxCorrelationSlots: 2 } });
  const result = engine.ingest(Array.from({ length: 6 }, (_, index) => detectionEvent({
    eventId: `evt-${index}`,
    observedAt: BASE + index,
    fields: { process: { name: `slot-${index}` } },
  })));

  const gaps = result.gaps.filter((gap) => gap.kind === 'correlation-slot-limit');
  assert.equal(gaps.length >= 1, true, 'a refused correlation slot must be visible as a gap');
  assert.ok(engine.stats().correlationSlots <= 2, 'the slot registry stays inside its bound');
  assert.equal(result.detections.length, 0, 'no step pair was completed');
});

test('指纹碰撞面：null / 缺字段 / undefined 归一到同一个空串指纹', () => {
  // 指纹先用 normalizeText 把值转成文本：null 与 undefined 都变成 ''，
  // 于是"字段是 null"和"字段不存在"在指纹层不可区分。这是聚合语义的一部分，
  // 但意味着样本可以用 null 把两条不同来源的观测聚成一个告警。
  const specification = Object.freeze([Object.freeze({ path: 'process.name', transform: 'none' })]);
  const fingerprintOf = (fields) => computeFingerprint({
    ruleId: 'corpus.condition',
    ruleVersion: '1.0.0',
    specification,
    event: { fields },
    maxPreviewLength: 256,
  }).fingerprint;

  const withNull = fingerprintOf({ process: { name: null } });
  assert.equal(withNull, fingerprintOf({ process: {} }), 'null and a missing field share one fingerprint');
  assert.equal(withNull, fingerprintOf({ process: { name: undefined } }));

  // 对照：字符串 "null" 是真实文本，不能与缺失合并。
  assert.notEqual(fingerprintOf({ process: { name: 'null' } }), withNull);
  // 对照：NaN 被 String() 转成 "NaN"，因此与字面字符串 "NaN" 撞指纹（数值字段不该是 NaN）。
  assert.equal(fingerprintOf({ process: { name: Number.NaN } }), fingerprintOf({ process: { name: 'NaN' } }));
});

test('★ 缺陷 DEF-08 已修复：非标量身份按类型 + 规范 JSON 区分，不再归一到 "[object Object]"', () => {
  // 旧断言（修复前）：`normalizeText` 用 `String(value)`，于是每个对象都是 "[object Object]"、
  // 每个数组都是逗号拼接。任何非标量字段值都与"另一个完全不同的对象"共享指纹——甚至与
  // 字面字符串 "[object Object]" 撞。实测旧行为：`{a:1}` 与 `{b:2}` 指纹相同。
  // 修复后：非标量返回 `[path, 规范JSON文本, 类型标签]` 三元组；规范 JSON 里不可能出现三元组，
  // 所以字符串值无法伪造非标量身份（不依赖"前缀字符不会出现在数据里"这种假设）。
  const specification = Object.freeze([Object.freeze({ path: 'process.name', transform: 'none' })]);
  const fingerprintOf = (value) => computeFingerprint({
    ruleId: 'corpus.condition',
    ruleVersion: '1.0.0',
    specification,
    event: { fields: { process: { name: value } } },
    maxPreviewLength: 256,
  });

  const objectA = fingerprintOf({ a: 1 });
  const objectB = fingerprintOf({ b: 2 });
  assert.notEqual(objectA.fingerprint, objectB.fingerprint, 'two different objects must not share one fingerprint');
  assert.notEqual(objectA.preview[0].preview, '[object Object]', 'the preview must show the value, not its default toString');
  assert.match(objectA.preview[0].preview, /"a"/u, 'the preview must carry the object content');
  assert.match(objectB.preview[0].preview, /"b"/u);

  // 四种旧碰撞，逐条反向断言。
  assert.notEqual(
    objectA.fingerprint,
    fingerprintOf('[object Object]').fingerprint,
    'an object must not collide with the literal string "[object Object]"',
  );
  assert.notEqual(
    fingerprintOf([1, 2]).fingerprint,
    fingerprintOf('1,2').fingerprint,
    'an array must not collide with its comma-joined text',
  );
  assert.notEqual(
    fingerprintOf([1, [2, 3]]).fingerprint,
    fingerprintOf('1,2,3').fingerprint,
    'a nested array must not flatten into the same text as a flat one',
  );
  assert.notEqual(
    fingerprintOf({ 0: 1 }).fingerprint,
    fingerprintOf([1]).fingerprint,
    'an array is not the object that happens to have the same index keys',
  );
  // 数组里的非 JSON 叶子也要保留各自身份，不能都退化成 "{}"。
  assert.notEqual(
    fingerprintOf([new Date(0)]).fingerprint,
    fingerprintOf([new Date(1000)]).fingerprint,
    'non-JSON leaves inside an array must stay distinguishable',
  );

  // 负向对照：分不清"两个不同的值"和"同一个值"会让指纹失去意义，所以这些必须仍然相等。
  assert.equal(
    fingerprintOf({ a: 1 }).fingerprint,
    fingerprintOf({ a: 1 }).fingerprint,
    'the same value must still produce the same fingerprint',
  );
  assert.equal(
    fingerprintOf({ a: 1, b: 2 }).fingerprint,
    fingerprintOf({ b: 2, a: 1 }).fingerprint,
    'key order must not define identity',
  );
  // 负向对照：标量行为不受影响（修复只针对非标量）。
  assert.notEqual(fingerprintOf('x').fingerprint, fingerprintOf('y').fingerprint);
  assert.equal(fingerprintOf('x').fingerprint, fingerprintOf('x').fingerprint);
});

test('指纹变换是显式的：(lower) 折叠大小写、(path) 折叠分隔符与盘符', () => {
  const fingerprintOf = (specification, fields) => computeFingerprint({
    ruleId: 'corpus.condition',
    ruleVersion: '1.0.0',
    specification,
    event: { fields },
    maxPreviewLength: 256,
  }).fingerprint;

  const folded = Object.freeze([
    Object.freeze({ path: 'process.path', transform: 'path' }),
    Object.freeze({ path: 'process.name', transform: 'lower' }),
  ]);
  const winStyle = fingerprintOf(folded, { process: { path: 'C:\\Temp\\Tool.EXE', name: 'Shell' } });
  const posixStyle = fingerprintOf(folded, { process: { path: 'c:/Temp//Tool.EXE/', name: 'shell' } });
  assert.equal(winStyle, posixStyle, 'declared transforms, not raw bytes, define the identity');

  // 注意：`path` 变换只统一分隔符、折叠重复斜杠、去掉尾随斜杠、折叠盘符大小写，
  // **不**折叠路径其余部分的大小写——所以上面对照里两边的目录大小写必须一致。
  assert.notEqual(
    fingerprintOf(folded, { process: { path: 'c:/temp/tool.exe', name: 'shell' } }),
    winStyle,
    'the rest of the path keeps its case; only the drive letter is folded',
  );

  // 未声明 lower 时大小写必须保持区分。
  const plain = Object.freeze([Object.freeze({ path: 'process.name', transform: 'none' })]);
  assert.notEqual(
    fingerprintOf(plain, { process: { name: 'Shell' } }),
    fingerprintOf(plain, { process: { name: 'shell' } }),
  );
});

test('指纹不能靠标点伪造：值里带 JSON 结构字符不会与"两个字段"撞指纹', () => {
  const forged = engineFor({ matchAll: true }).ingest([
    detectionEvent({ eventId: 'evt-1', fields: { process: { name: 'x","path":"/opt/y' } } }),
  ]);

  const twoField = createDetectionEngine({
    rulePack: {
      ...rulePack(),
      rules: [{
        ruleId: 'corpus.condition',
        version: '1.0.0',
        type: 'condition',
        severity: 'high',
        fields: ['process.name', 'process.path'],
        fingerprint: ['process.name', 'process.path'],
        when: { field: 'process.name', operator: 'exists' },
      }],
    },
    clock: createManualClock(BASE),
    ids: createSequenceIdFactory(1),
  });
  const genuine = twoField.ingest([
    detectionEvent({ eventId: 'evt-1', fields: { process: { name: 'x', path: '/opt/y' } } }),
  ]);

  assert.notEqual(forged.detections[0].fingerprint, genuine.detections[0].fingerprint);
});

test('NFKC 等价的值合成同一指纹（这是设计意图，不是缺陷）', () => {
  const engine = engineFor();
  const result = engine.ingest([
    detectionEvent({ eventId: 'evt-1', fields: { process: { name: 'ｅｘａｍｐｌｅ-process' } } }),
    detectionEvent({ eventId: 'evt-2', observedAt: BASE + 1, fields: { process: { name: 'example-process' } } }),
  ]);
  assert.equal(result.detections[0].fingerprint, result.detections[1].fingerprint);
  assert.equal(result.alerts.length, 1, 'both observations aggregate into one alert');
  assert.equal(result.alerts[0].count, 2);
});

test('重复 eventId 不重复产出检测（幂等），并计入 duplicate 决策', () => {
  const engine = engineFor();
  engine.ingest([detectionEvent({ eventId: 'evt-1' })]);
  const again = engine.ingest([detectionEvent({ eventId: 'evt-1' })]);
  assert.equal(again.detections.length, 0);
  assert.equal(again.decisions[0].outcome, 'duplicate');
  assert.equal(again.decisions[0].eventId, 'evt-1');
  // 重复不是缺口：缺口表示"数据丢了"，重复表示"数据来了两次"，两者不能混为一谈。
  assert.deepEqual(again.gaps, []);
  assert.equal(engine.stats().duplicateEvents, 1);
});

test('seenEventIds 有界：超出 maxSeenEventIds 后最早的 id 被遗忘（重放会再次求值）', () => {
  const engine = engineFor({ limits: { maxSeenEventIds: 2 } });
  engine.ingest([
    detectionEvent({ eventId: 'evt-1' }),
    detectionEvent({ eventId: 'evt-2', observedAt: BASE + 1 }),
    detectionEvent({ eventId: 'evt-3', observedAt: BASE + 2 }),
  ]);
  const replay = engine.ingest([detectionEvent({ eventId: 'evt-1', observedAt: BASE + 3 })]);
  assert.equal(replay.decisions[0].outcome, 'evaluated', 'the oldest id was evicted, so the replay is treated as new');
});

test('ingest 超过 maxEventsPerIngest 时报缺口，不静默丢弃', () => {
  const engine = engineFor({ maxEventsPerIngest: 2 });
  const result = engine.ingest([
    detectionEvent({ eventId: 'evt-1' }),
    detectionEvent({ eventId: 'evt-2', observedAt: BASE + 1 }),
    detectionEvent({ eventId: 'evt-3', observedAt: BASE + 2 }),
  ]);
  assert.equal(result.eventsProcessed, 2);
  const gap = result.gaps.find((entry) => entry.kind === 'ingest-batch-limit');
  assert.notEqual(gap, undefined);
  assert.equal(gap.count, 1);
});

test('调用方接线错误（非数组 ingest / 负时间）不冻结引擎', () => {
  const engine = engineFor();
  assert.throws(() => engine.ingest('not-an-array'), DetectionConfigError);
  assert.throws(() => engine.advanceTo(-1), DetectionConfigError);
  assert.equal(engine.stats().fatal, null);
  const result = engine.ingest([detectionEvent()]);
  assert.equal(result.detections.length, 1);
});

test('同一批事件在两个引擎上产出逐字节相同的结果（确定性）', () => {
  const events = [
    detectionEvent({ eventId: 'evt-1' }),
    detectionEvent({ eventId: 'evt-2', observedAt: BASE + 1, fields: { process: { name: 'other' } } }),
    detectionEvent({ eventId: 'evt-3', observedAt: BASE + 2, severity: 'high' }),
  ];
  const first = engineFor().ingest(events);
  const second = engineFor().ingest(events);
  assert.equal(structureText(first), structureText(second));
});

test('★ 缺陷 DEF-09 已修复：同一事件里每个字段只读一次，条件与指纹看到同一个值', () => {
  // 旧断言（修复前）：`readEventShape` 只快照顶层字段，`fields` 仍是调用方对象的引用，
  // 于是每次求值都重新进一次 getter。实测 getter 被读 2 次以上，指纹拿到的是 `v2` ——
  // "为什么告警"（条件在 v1 上命中）和"告警是谁"（指纹由 v2 算出）对不上。
  // 修复后：事件快照上挂 `(对象, 属性)` 读取缓存，同一事件内每个属性只读一次；
  // 条件、分组键、指纹看到的是同一个值。
  let calls = 0;
  const fields = { process: {} };
  Object.defineProperty(fields.process, 'name', {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      return `v${calls}`;
    },
  });

  const engine = engineFor({ matchAll: true });
  const first = engine.ingest([detectionEvent({ eventId: 'evt-1', fields })]);
  assert.equal(first.detections.length, 1);
  assert.equal(calls, 1, `the getter ran ${calls} times for a single event; it must run exactly once`);
  // 指纹预览必须是**第一次**读取的结果；拿到 v2 就说明还是有第二次读取。
  assert.equal(first.detections[0].fingerprintPreview[0].preview, 'v1', 'the fingerprint must see the value the condition saw');

  // 负向对照 1：缓存的生命周期是"一个事件"，不是进程级。第二个事件必须重新求值，
  // 且拿到的是新值（v2）——否则缓存会把观测冻结在第一次读到的内容上，那是更糟的错。
  const second = engine.ingest([detectionEvent({ eventId: 'evt-2', observedAt: BASE + 1, fields })]);
  assert.equal(second.detections.length, 1);
  assert.equal(calls, 2, 'the cache must be scoped to one event, not shared across events');
  assert.equal(second.detections[0].fingerprintPreview[0].preview, 'v2');
  assert.notEqual(
    second.detections[0].fingerprint,
    first.detections[0].fingerprint,
    'a changed field value must change the fingerprint, even for the same rule and path',
  );

  // 负向对照 2：缓存没有把 getter 关掉。不挂缓存的对象上连续读两次，仍然看到两个不同的值；
  // 所以上面 `calls === 1` 是"缓存生效"的证据，而不是"没人读"。
  let uncachedCalls = 0;
  const uncached = {};
  Object.defineProperty(uncached, 'name', {
    enumerable: true,
    configurable: true,
    get() {
      uncachedCalls += 1;
      return `r${uncachedCalls}`;
    },
  });
  const firstRead = resolveField(uncached, 'name');
  const secondRead = resolveField(uncached, 'name');
  assert.equal(uncachedCalls, 2);
  assert.notEqual(firstRead, secondRead, 'without the event cache the getter still yields a fresh value each read');
});

test('指纹 digest 与预览是两件事：预览被截断不影响 digest 的长度与格式', () => {
  const engine = engineFor({ matchAll: true });
  const result = engine.ingest([detectionEvent({ fields: { process: { name: 'a'.repeat(4096) } } })]);
  const detection = result.detections[0];
  assert.match(detection.fingerprint, /^[0-9a-f]{64}$/u);
  assert.ok(detection.fingerprintPreview[0].preview.length <= 256);
  assert.ok(detection.fingerprintPreview[0].preview.endsWith('…'), 'the preview marks its own truncation');
});
