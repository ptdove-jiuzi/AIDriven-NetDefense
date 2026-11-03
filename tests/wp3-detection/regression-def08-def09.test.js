/**
 * DEF-08 / DEF-09 回归用例（M9 P3 修复）。
 *
 * DEF-08：指纹对非标量值的类型强制碰撞。`normalizeText` 用 `String(value)`，
 * 于是任意两个不同对象都变成 `"[object Object]"`、任意数组都变成逗号拼接
 * （`[1,2]` 与 `"1,2"` 同指纹，嵌套数组被拍平）。恶意样本可以用一个对象把任意不同的
 * 观测合并成一个告警，或把一个告警拆开。
 *
 * 修复后的契约：非标量值按"类型标签 + 规范 JSON"进入指纹输入，标量编码逐字节不变。
 *
 * DEF-09：`readEventShape` 只快照顶层，`fields` 仍是调用方对象的引用，`resolveField`
 * 每次求值都重新进 getter —— 实测一个事件里 getter 被读 ≥2 次：条件在 `v1` 上命中，
 * 同一条检测的指纹却是用 `v2` 算出来的。
 *
 * 修复后的契约：同一事件内每个属性只读一次，条件 / 分组键 / 指纹看到同一个值。
 *
 * 修复前这些用例必然变红：对象指纹彼此相同、getter 计数是 2。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFingerprintInput,
  buildFingerprintKeys,
  buildGroupKey,
  computeFingerprint,
  createManualClock,
  resolveField,
  sha256Hex,
} from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent } from './helpers.js';

const SPEC = Object.freeze([Object.freeze({ path: 'process.name', transform: 'none' })]);

function fingerprintOf(value) {
  return computeFingerprint({
    ruleId: 'corpus.condition',
    ruleVersion: '1.0.0',
    specification: SPEC,
    event: { fields: { process: { name: value } } },
    maxPreviewLength: 256,
  });
}

describe('DEF-08 non-scalar fingerprint identity', () => {
  it('两个不同的对象不再共享同一个指纹', () => {
    assert.notEqual(fingerprintOf({ a: 1 }).fingerprint, fingerprintOf({ b: 2 }).fingerprint);
    assert.notEqual(fingerprintOf({ a: 1 }).fingerprint, fingerprintOf({ a: 2 }).fingerprint);
  });

  it('对象不再与字面字符串 "[object Object]" 撞指纹', () => {
    assert.notEqual(
      fingerprintOf({ a: 1 }).fingerprint,
      fingerprintOf('[object Object]').fingerprint,
    );
  });

  it('数组不再与逗号拼接的文本撞指纹，嵌套数组也不再被拍平', () => {
    assert.notEqual(fingerprintOf([1, 2]).fingerprint, fingerprintOf('1,2').fingerprint);
    assert.notEqual(fingerprintOf([1, [2, 3]]).fingerprint, fingerprintOf('1,2,3').fingerprint);
    assert.notEqual(fingerprintOf([1, [2, 3]]).fingerprint, fingerprintOf([1, 2, 3]).fingerprint);
    // 数组与对象也必须是不同的身份（旧实现里一个是 "1,2"、一个是 "[object Object]"，
    // 这里钉的是"类型参与身份"这一性质本身）。
    assert.notEqual(fingerprintOf([]).fingerprint, fingerprintOf({}).fingerprint);
  });

  it('结构相同、键序不同的对象仍然给出同一个指纹（确定性没有被削弱）', () => {
    assert.equal(fingerprintOf({ a: 1, b: 2 }).fingerprint, fingerprintOf({ b: 2, a: 1 }).fingerprint);
    assert.equal(fingerprintOf([1, 2, 3]).fingerprint, fingerprintOf([1, 2, 3]).fingerprint);
  });

  it('标量的指纹编码逐字节不变（形状仍是二元组）', () => {
    // 用公开的 buildFingerprintInput 手工构造旧形状的输入，摘要必须完全相同。
    const expected = sha256Hex(
      buildFingerprintInput('corpus.condition', '1.0.0', [['process.name', 'example-process']]),
    );
    assert.equal(fingerprintOf('example-process').fingerprint, expected);

    // 数字与布尔仍然走文本路径（本次只改非标量）。
    assert.equal(
      fingerprintOf(7).fingerprint,
      sha256Hex(buildFingerprintInput('corpus.condition', '1.0.0', [['process.name', '7']])),
    );
  });

  it('非标量的身份项带类型标签，且预览是可打印文本', () => {
    const keys = buildFingerprintKeys(SPEC, { fields: { process: { name: { a: 1 } } } });
    assert.equal(keys.length, 1);
    assert.equal(keys[0].length, 3, 'a non-scalar entry carries [path, text, tag]');
    assert.equal(keys[0][0], 'process.name');
    assert.equal(keys[0][1], '{"a":1}');
    assert.equal(keys[0][2], 'object');

    const arrayKeys = buildFingerprintKeys(SPEC, { fields: { process: { name: [1, 2] } } });
    assert.equal(arrayKeys[0][2], 'array');

    // 预览里不能出现控制字符：检测记录会被下游 DTO 校验拒绝。
    const preview = fingerprintOf({ a: '\u0001\u001b' }).preview[0].preview;
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(preview), false, `preview=${JSON.stringify(preview)}`);
  });

  it('阈值分组键同样区分非标量（同一份值在分组与指纹两层解释一致）', () => {
    const objectKey = buildGroupKey(['process.name'], { fields: { process: { name: { a: 1 } } } });
    const stringKey = buildGroupKey(['process.name'], { fields: { process: { name: '{"a":1}' } } });
    assert.notEqual(objectKey, stringKey);
    assert.notEqual(
      buildGroupKey(['process.name'], { fields: { process: { name: { a: 1 } } } }),
      buildGroupKey(['process.name'], { fields: { process: { name: { b: 2 } } } }),
    );
  });

  it('非 JSON 形状的对象保留旧的文本身份，不会因为改用规范 JSON 而退化成互相碰撞', () => {
    // 第 1 轮独立审查指出的风险：`Date` / `Map` / 类实例没有自有可枚举键，
    // 规范 JSON 会把它们都变成 `{}`——那会把"两个不同的 Date"从"不同"变成"相同"，
    // 比旧实现更差。所以只对纯 JSON 对象与数组用规范 JSON。
    assert.notEqual(fingerprintOf(new Date(0)).fingerprint, fingerprintOf(new Date(1000)).fingerprint);
    assert.notEqual(
      fingerprintOf(new Date(0)).fingerprint,
      fingerprintOf(new Date(0).toISOString()).fingerprint,
      'a Date must not collide with its own text form',
    );
  });

  it('预览里的 DEL / C1 被转义（检测记录要过拒绝控制符的 DTO 校验）', () => {
    // `JSON.stringify` 只转义 C0；U+007F–U+009F 会原样出现在规范 JSON 里，
    // 而这段文本会进入 `fingerprintPreview`。
    const preview = fingerprintOf({ note: 'a\u007fb\u0085c\u009fd' }).preview[0].preview;
    assert.equal(
      /[\u0000-\u001f\u007f-\u009f]/u.test(preview),
      false,
      `preview must not carry control characters: ${JSON.stringify(preview)}`,
    );
    assert.match(preview, /\\u007f/u, 'DEL is escaped, not dropped');
    assert.match(preview, /\\u0085/u, 'C1 is escaped, not dropped');
  });
});

describe('DEF-09 one read per field inside one event', () => {
  it('同一事件里 getter 只被读一次，条件与指纹看到同一个值', () => {
    const values = ['v1', 'v2', 'v3'];
    let reads = 0;
    const fields = { process: {} };
    Object.defineProperty(fields.process, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        const value = values[Math.min(reads, values.length - 1)];
        reads += 1;
        return value;
      },
    });

    const engine = createTestEngine({
      rules: [makeConditionRule({
        ruleId: 'rule.read-once',
        fields: ['process.name'],
        fingerprint: ['process.name'],
        // 条件用 starts_with，命中 v1；旧实现随后为指纹再读一次，拿到 v2。
        when: { field: 'process.name', operator: 'starts_with', value: 'v' },
      })],
      clock: createManualClock(0),
    });

    const result = engine.ingest([makeEvent({ eventId: 'evt-def09-1', fields })]);

    assert.equal(reads, 1, `the getter must be read exactly once, was read ${reads} times`);
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].fingerprintPreview[0].preview, 'v1', 'the fingerprint must use the value the condition saw');
  });

  it('两条规则读同一个字段时，getter 在一次事件里仍然只读一次', () => {
    let reads = 0;
    const fields = { process: {} };
    Object.defineProperty(fields.process, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return 'example-process';
      },
    });

    const engine = createTestEngine({
      rules: [
        makeConditionRule({ ruleId: 'rule.a', fingerprint: ['process.name'] }),
        makeConditionRule({ ruleId: 'rule.b', fingerprint: ['process.name'] }),
      ],
      clock: createManualClock(0),
    });

    const result = engine.ingest([makeEvent({ eventId: 'evt-def09-2', fields })]);
    assert.equal(result.detections.length, 2);
    assert.equal(reads, 1, `two rules must not re-enter the getter, was read ${reads} times`);
  });

  it('抛错的 getter 仍然降级本事件（DEF-11 语义不变），且只读一次', () => {
    let reads = 0;
    const fields = { process: {} };
    Object.defineProperty(fields.process, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new RangeError('hostile getter');
      },
    });

    const engine = createTestEngine({
      rules: [
        makeConditionRule({ ruleId: 'rule.x', fields: ['process.name'], fingerprint: ['process.name'] }),
        makeConditionRule({ ruleId: 'rule.y', fields: ['process.name'], fingerprint: ['process.name'] }),
      ],
      clock: createManualClock(0),
    });

    const result = engine.ingest([makeEvent({ eventId: 'evt-def09-3', fields })]);

    assert.equal(result.ruleIsolations.length, 0, 'a data fault must never isolate a rule');
    assert.equal(engine.stats().gapsByKind['unreadable-field'], 2, 'each rule reports one gap');
    assert.equal(reads, 1, `the failing getter must be entered once per event, was ${reads} times`);
    assert.equal(result.gaps.every((gap) => gap.detail.path === 'process.name'), true);
  });

  it('没有读取缓存的事件（直接调用 resolveField）行为不变', () => {
    // 对照：缓存只挂在引擎的事件快照上，公开的 resolveField 语义没有被改宽。
    let reads = 0;
    const fields = {};
    Object.defineProperty(fields, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return `v${reads}`;
      },
    });
    assert.equal(resolveField({ fields }, 'name'), 'v1');
    assert.equal(resolveField({ fields }, 'name'), 'v2');
    assert.equal(reads, 2);
  });
});

describe('DEF-09 非标量值：同一事件内只序列化一次', () => {
  /**
   * 计数口径：每次"序列化"会遍历对象若干次（读属性次数取决于编码器实现），
   * 所以断言不写死绝对次数，而是比较**引擎路径**与**无缓存基线**的比值——
   * 基线是"分组键 + 指纹各序列化一次"，引擎路径应当只序列化一次（读数为基线的一半）。
   * 这样断言钉的是"共不共用一次序列化"，不会因为编码器内部读几次而误报。
   */
  function countingKey() {
    const state = { reads: 0 };
    const key = {};
    Object.defineProperty(key, 'value', {
      enumerable: true,
      configurable: true,
      get() {
        state.reads += 1;
        return state.reads;
      },
    });
    return { key, state };
  }

  /** 无缓存基线：两层各序列化一次，返回读数（= 两次序列化）。 */
  function baselineReads() {
    const { key, state } = countingKey();
    const event = { fields: { process: { name: key } } };
    buildGroupKey(['process.name'], event);
    buildFingerprintKeys(SPEC, event);
    return state.reads;
  }

  const RULE = {
    ruleId: 'rule.nested-read-once',
    version: '1.0.0',
    type: 'threshold',
    severity: 'medium',
    fields: ['process.name'],
    groupBy: ['process.name'],
    fingerprint: ['process.name'],
    count: { operator: 'gte', value: 2 },
    windowMs: 60000,
  };

  it('无缓存基线：分组键与指纹各序列化一次（读数 = 两次序列化）', () => {
    const baseline = baselineReads();
    assert.equal(baseline > 0, true, 'the getter must actually be read');
    assert.equal(baseline % 2, 0, `two identical serializations must read the same number of times: ${baseline}`);
  });

  it('引擎路径：分组键与指纹共用一次序列化（读数减半）', () => {
    // 必须用"首个事件即触发"的阈值（gte 1）：只有 `outcome.fired` 才会算指纹
    // （engine.js 的 threshold 分支），gte 2 的首个事件只算分组键，这条用例就打不到
    // "分组键与指纹共享一次序列化"这个点上。
    const baseline = baselineReads();
    const { key, state } = countingKey();
    const engine = createTestEngine({
      rules: [{ ...RULE, ruleId: 'rule.nested-read-once-immediate', count: { operator: 'gte', value: 1 } }],
      clock: createManualClock(0),
    });
    const result = engine.ingest([
      makeEvent({ eventId: 'evt-nested-1', fields: { process: { name: key } } }),
    ]);

    assert.equal(result.detections.length, 1, 'gte 1 fires on the first event, so the fingerprint is computed');
    // 旧实现是两次序列化（分组键一次、指纹一次）；缓存后只序列化一次。
    assert.equal(
      state.reads,
      baseline / 2,
      `the value must be serialized once, not twice (baseline ${baseline}, actual ${state.reads})`,
    );
  });

  it('同一事件里两次命中阈值时，第二个事件仍然只序列化一次', () => {
    // 这里必须用**稳定**的 getter：上面那个自增 getter 每次序列化都给出不同的值，
    // 分组键因此不同，阈值永远不会到 2 —— 那会把"缓存生效"和"计数没到"混在一起。
    let reads = 0;
    const key = {};
    Object.defineProperty(key, 'value', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return 'stable';
      },
    });

    const engine = createTestEngine({ rules: [RULE], clock: createManualClock(0) });
    const result = engine.ingest([
      makeEvent({ eventId: 'evt-nested-a', fields: { process: { name: key } } }),
      makeEvent({ eventId: 'evt-nested-b', fields: { process: { name: key } } }),
    ]);

    assert.equal(result.detections.length, 1, 'the second hit fires the threshold');
    // 两个事件各自序列化一次（缓存按事件隔离），所以是基线的一次完整量。
    assert.equal(reads, baselineReads(), `two events must serialize once each, was ${reads} reads`);
  });
});

describe('DEF-09 非纯 JSON 对象（类实例 / Date）的文本身份', () => {
  it('状态型 toString 在引擎路径下只执行一次，分组键与指纹看到同一个值', () => {
    class Weird {
      constructor() {
        this.calls = 0;
      }

      toString() {
        this.calls += 1;
        return `v${this.calls}`;
      }
    }

    const value = new Weird();
    const engine = createTestEngine({
      rules: [{
        ruleId: 'rule.class-read-once',
        version: '1.0.0',
        type: 'threshold',
        severity: 'medium',
        fields: ['process.name'],
        groupBy: ['process.name'],
        fingerprint: ['process.name'],
        count: { operator: 'gte', value: 1 },
        windowMs: 60000,
      }],
      clock: createManualClock(0),
    });

    const result = engine.ingest([makeEvent({ eventId: 'evt-class-1', fields: { process: { name: value } } })]);

    assert.equal(result.detections.length, 1);
    assert.equal(value.calls, 1, `toString must run once per event, ran ${value.calls} times`);
    // 修复前：分组键拿到 v1、指纹拿到 v2 —— 同一个观测被拆成两个身份。
    assert.equal(result.detections[0].fingerprintPreview[0].preview, 'v1');
  });

  it('对照：无缓存时两层各求值一次（这正是缺陷形状）', () => {
    class Weird {
      constructor() {
        this.calls = 0;
      }

      toString() {
        this.calls += 1;
        return `v${this.calls}`;
      }
    }

    const value = new Weird();
    const event = { fields: { process: { name: value } } };
    buildGroupKey(['process.name'], event);
    const keys = buildFingerprintKeys(SPEC, event);

    assert.equal(value.calls, 2, 'without a cache the two layers disagree');
    assert.equal(keys[0][1], 'v2');
  });
});
