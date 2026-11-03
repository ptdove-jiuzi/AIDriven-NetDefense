/**
 * id-factory.test.js — identifier factories, UUIDv4 shape rules and the wiring
 * that keeps engine identifiers random while idempotency keys stay derived.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ID_KINDS,
  DetectionConfigError,
  createCustomIdFactory,
  createDetectionEngine,
  createManualClock,
  createRandomIdFactory,
  createSequenceIdFactory,
  isUuidV4,
} from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent, makePack } from './helpers.js';

/** Event identifiers must be UUIDv4 once they reach the contracts layer. */
const EVENT_ID_A = '11111111-1111-4111-8111-111111111111';
const EVENT_ID_B = '22222222-2222-4222-8222-222222222222';
const UUID_SAMPLE = 'abcdef01-2345-4678-9abc-def012345678';

function expectConfigError(fn, label, expectedCode = 'DETECTION_CONFIG_INVALID') {
  let captured;
  assert.throws(() => {
    try {
      fn();
    } catch (error) {
      captured = error;
      throw error;
    }
  }, (thrown) => {
    assert.ok(
      thrown instanceof DetectionConfigError,
      `${label}：期望 DetectionConfigError，实际 ${thrown?.constructor?.name}: ${thrown?.message}`,
    );
    assert.equal(thrown.code, expectedCode, `${label}：错误码不符`);
    return true;
  });
  return captured;
}

function buildEngineWith(ids) {
  return createDetectionEngine({
    rulePack: makePack([makeConditionRule()]),
    clock: createManualClock(0),
    ids,
  });
}

describe('identifier factories', () => {
  it('createRandomIdFactory 每次产出互不相同的规范 UUIDv4', () => {
    const factory = createRandomIdFactory();
    const first = factory.next('detection');
    const second = factory.next('detection');
    assert.equal(isUuidV4(first), true);
    assert.equal(isUuidV4(second), true);
    assert.notEqual(first, second);
  });

  it('createSequenceIdFactory(1) 前三次是互不相同的 UUIDv4，同参新建工厂可重放', () => {
    const factory = createSequenceIdFactory(1);
    const first = [factory.next('detection'), factory.next('alert'), factory.next('analysis-request')];
    for (const value of first) {
      assert.equal(isUuidV4(value), true, `${value} 不是规范 UUIDv4`);
    }
    assert.equal(new Set(first).size, 3);
    const replay = createSequenceIdFactory(1);
    assert.deepEqual(
      [replay.next('detection'), replay.next('alert'), replay.next('analysis-request')],
      first,
    );
  });

  it('isUuidV4 只接受规范小写 UUIDv4', () => {
    assert.equal(isUuidV4(UUID_SAMPLE), true);
    assert.equal(isUuidV4('a'.repeat(32)), false);
    assert.equal(isUuidV4(UUID_SAMPLE.toUpperCase()), false);
    // version 位必须是 4
    assert.equal(isUuidV4('abcdef01-2345-3678-9abc-def012345678'), false);
    // variant 位只接受 8/9/a/b
    for (const variant of ['c', 'd', 'e', 'f']) {
      assert.equal(isUuidV4(`abcdef01-2345-4678-${variant}abc-def012345678`), false);
    }
    assert.equal(isUuidV4(''), false);
    assert.equal(isUuidV4(null), false);
  });

  it('引擎拒绝任何不是由 ids.js 创建的工厂', () => {
    const cases = [
      ['裸对象', {}],
      ['无品牌的 next', { next: () => UUID_SAMPLE }],
      ['null', null],
    ];
    for (const [label, ids] of cases) {
      const error = expectConfigError(() => buildEngineWith(ids), label);
      assert.equal(error.path, 'ids');
    }
  });

  it('createCustomIdFactory 在创建期就拒绝坏生成器', () => {
    expectConfigError(() => createCustomIdFactory(() => 'x'), '短返回值');
    expectConfigError(() => createCustomIdFactory(() => 42), '非字符串返回值');
    expectConfigError(() => createCustomIdFactory(() => {
      throw new Error('boom');
    }), '抛错的生成器');
  });

  it('合法 custom 工厂可用，未知 kind 被拒', () => {
    const factory = createCustomIdFactory(() => UUID_SAMPLE);
    for (const kind of ID_KINDS) {
      assert.equal(factory.next(kind), UUID_SAMPLE);
    }
    expectConfigError(() => factory.next('unknown-kind'), '未知 kind');
  });
});

describe('id factory failure is a wiring fault, not a rule fault', () => {
  it('检测号失败：ingest 抛出 DetectionConfigError，且规则不被记为 isolated', () => {
    let calls = 0;
    const factory = createCustomIdFactory(() => {
      calls += 1;
      // 第一次调用是构造期探针，必须成功；之后（真正的 detection 号）失败。
      if (calls === 1) {
        return UUID_SAMPLE;
      }
      throw new Error('detection id source offline');
    });
    assert.equal(calls, 1);
    const engine = buildEngineWith(factory);
    const error = expectConfigError(
      () => engine.ingest([makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 })]),
      '检测号失败',
    );
    assert.equal(error.path, 'ids');
    // 关键：工厂故障不得被吞成 ruleIsolations/rule-isolated。
    assert.equal(engine.stats().ruleIsolations, 0);
    assert.equal(engine.stats().detections, 0);
    assert.deepEqual(engine.ruleStates().map((state) => state.state), ['enabled']);
  });

  it('请求号失败：ingest 抛出并冻结引擎，配额未被吃掉，重建引擎后同小时可放行', () => {
    let failRequests = true;
    const factory = createCustomIdFactory((kind) => {
      if (kind === 'analysis-request' && failRequests) {
        throw new Error('request id source offline');
      }
      return UUID_SAMPLE;
    });
    const engine = createTestEngine({ ids: factory, limits: { aggregationWindowMs: 1000 } });
    const error = expectConfigError(
      () => engine.ingest([makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 })]),
      '请求号失败',
    );
    assert.equal(error.path, 'ids');
    assert.match(error.message, /threw while minting an id/u);
    assert.equal(engine.stats().analysisRequests, 0);
    assert.equal(engine.stats().analysisDenied, 0);
    assert.equal(engine.stats().ruleIsolations, 0);

    // 批次不是原子的：失败前已处理的告警已经落地，因此引擎必须冻结，
    // 而不是让调用方以为"重试就能补发"。
    const frozen = engine.stats().fatal;
    assert.equal(frozen !== null, true, 'a failed batch must be recorded as fatal');
    assert.equal(frozen.batch, 1);
    assert.match(frozen.reason, /threw while minting an id/u);
    assert.equal(engine.stats().alerts, 1, 'the alert created before the failure was applied');

    // 冻结后任何一批都必须被拒绝：既不能假装成功，也不能把已落地的告警再投递一次。
    failRequests = false;
    const frozenError = expectConfigError(
      () => engine.ingest([makeEvent({ eventId: EVENT_ID_B, observedAt: 2500 })]),
      '冻结后继续 ingest',
      'ENGINE_FROZEN',
    );
    assert.equal(frozenError.detail.batch, 1);
    expectConfigError(() => engine.advanceTo(5000), '冻结后 advanceTo', 'ENGINE_FROZEN');

    // 恢复方式是重建引擎并从耐久位点重放；失败那次没有吃掉配额，所以同指纹同小时仍能放行。
    const rebuilt = createTestEngine({ ids: factory, limits: { aggregationWindowMs: 1000 } });
    const retry = rebuilt.ingest([makeEvent({ eventId: EVENT_ID_B, observedAt: 2500 })]);
    assert.equal(retry.analysisRequests.length, 1, '失败的那次不得吃掉配额或写入去重集合');
    assert.equal(retry.analysisDenied.length, 0);
    assert.equal(isUuidV4(retry.analysisRequests[0].requestId), true);
  });

  it('参数错误不冻结引擎：非数组 ingest 与非法 advanceTo 都在变更前被拒', () => {
    const engine = createTestEngine({ ids: createSequenceIdFactory(1) });
    expectConfigError(() => engine.ingest('not-an-array'), '非数组 ingest');
    expectConfigError(() => engine.advanceTo(-1), '负数 advanceTo');
    expectConfigError(() => engine.advanceTo(1.5), '非整数 advanceTo');
    assert.equal(engine.stats().fatal, null, 'a typo in a call must not freeze a healthy engine');
    const result = engine.ingest([makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 })]);
    assert.equal(result.detections.length, 1);
  });

  it('冻结后连状态变更入口也拒绝：setAlertStatus / rehabilitateRule 抛 ENGINE_FROZEN', () => {
    // 第二轮复核只能用外部探针证明这条行为，仓库里没有会变红的用例。
    // 冻结意味着"丢弃并重建"，因此任何会改状态的方法都必须一起关掉。
    let minted = 0;
    const factory = createCustomIdFactory(() => {
      minted += 1;
      // 构造期探针占 1；第一个事件用 2/3/4（检测/告警/请求），第 5 个号在第二个事件失败。
      if (minted === 5) {
        throw new Error('adapter ran out of ids');
      }
      return `0000000${minted.toString(16)}-0000-4000-8000-000000000000`;
    });
    const engine = createTestEngine({ ids: factory, limits: { aggregationWindowMs: 1000 } });
    const result = engine.ingest([makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 })]);
    assert.equal(result.alerts.length, 1);
    const alertId = result.alerts[0].alertId;
    // 健康状态：状态流转正常，规则可康复。
    assert.equal(engine.setAlertStatus(alertId, 'acknowledged'), true);
    assert.equal(engine.getAlert(alertId).status, 'acknowledged');

    expectConfigError(
      () => engine.ingest([makeEvent({ eventId: EVENT_ID_B, observedAt: 1500 })]),
      '触发冻结',
    );
    expectConfigError(() => engine.setAlertStatus(alertId, 'resolved'), '冻结后改告警状态', 'ENGINE_FROZEN');
    expectConfigError(() => engine.rehabilitateRule('proc.example-start'), '冻结后康复规则', 'ENGINE_FROZEN');
    // 只读入口不受影响：排障时仍然要能看。
    assert.equal(engine.stats().fatal !== null, true);
    assert.equal(engine.getAlert(alertId).status, 'acknowledged', '状态没有被改掉');
    assert.equal(engine.ruleStates().length, 1);
  });

  it('批次中途失败：失败前的事件已生效，引擎冻结并拒绝后续批次', () => {
    // 构造期探针消耗第 1 个号；第 1 个事件用掉 2/3/4；第 2 个事件的检测号（第 5 个）失败。
    // 因此 3 条事件的批次只落地 2 条检测——这正是"不可回滚"的真实形态。
    let minted = 0;
    const factory = createCustomIdFactory(() => {
      minted += 1;
      if (minted === 5) {
        throw new Error('adapter ran out of ids');
      }
      return `0000000${minted.toString(16)}-0000-4000-8000-000000000000`;
    });
    const engine = createTestEngine({ ids: factory, limits: { aggregationWindowMs: 1000 } });
    const events = [1000, 1100, 1200].map((observedAt, index) => makeEvent({
      eventId: `33333333-3333-4333-8333-33333333333${index}`,
      observedAt,
      source: `10.0.0.${index + 1}`,
    }));
    expectConfigError(() => engine.ingest(events), '批次中途工厂失败');
    const stats = engine.stats();
    // 第 1 个事件完整走完（检测号 #2、告警号 #3、请求号 #4），第 2 个事件在检测号 #5 失败：
    // 事件计数 2、检测计数 1，第 3 个事件根本没被看到。这就是"批次非原子"的可观测形态。
    assert.equal(stats.events, 2, 'the event that failed was already counted as seen');
    assert.equal(stats.detections, 1, 'only the event before the failure was applied');
    assert.equal(stats.alerts, 1);
    assert.equal(stats.analysisRequests, 1);
    assert.equal(stats.fatal !== null, true);
    assert.equal(stats.fatal.batch, 1);
    expectConfigError(() => engine.ingest([events[0]]), '冻结后重放同一批', 'ENGINE_FROZEN');
  });

  it('正常工厂下行为不变（回归）', () => {
    const engine = createTestEngine({ ids: createSequenceIdFactory(1) });
    const result = engine.ingest([makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 })]);
    assert.equal(result.detections.length, 1);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.analysisRequests.length, 1);
    assert.equal(result.ruleIsolations.length, 0);
    assert.equal(engine.stats().ruleIsolations, 0);
  });
});

describe('engine identifier wiring', () => {
  it('引擎产出的 detectionId / alertId / requestId 都是合法 UUIDv4 且互不相同', () => {
    const engine = createTestEngine({ ids: createRandomIdFactory() });
    const result = engine.ingest([makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 })]);
    assert.equal(result.detections.length, 1);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.analysisRequests.length, 1);
    const detectionId = result.detections[0].detectionId;
    const alertId = result.alerts[0].alertId;
    const requestId = result.analysisRequests[0].requestId;
    for (const [label, value] of [['detectionId', detectionId], ['alertId', alertId], ['requestId', requestId]]) {
      assert.equal(isUuidV4(value), true, `${label} 不是规范 UUIDv4: ${value}`);
    }
    assert.equal(new Set([detectionId, alertId, requestId]).size, 3);
  });

  it('两台随机工厂引擎处理同一批事件：ID 互异，幂等键相同', () => {
    const engineA = createTestEngine({ ids: createRandomIdFactory() });
    const engineB = createTestEngine({ ids: createRandomIdFactory() });
    const eventsA = [makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 })];
    const eventsB = [makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 })];
    const resultA = engineA.ingest(eventsA);
    const resultB = engineB.ingest(eventsB);
    const alertA = resultA.alerts[0];
    const alertB = resultB.alerts[0];
    const requestA = resultA.analysisRequests[0];
    const requestB = resultB.analysisRequests[0];
    assert.equal(isUuidV4(alertA.alertId), true);
    assert.equal(isUuidV4(alertB.alertId), true);
    assert.notEqual(alertA.alertId, alertB.alertId);
    assert.notEqual(requestA.requestId, requestB.requestId);
    // 幂等键与 ID 解耦：内容派生的键必须跨引擎一致，否则重放会重复放行。
    assert.equal(requestA.requestKey, requestB.requestKey);
    assert.equal(requestA.idempotencyKey, requestB.idempotencyKey);
    assert.equal(requestA.requestKey, requestA.idempotencyKey);
  });

  it('两台各自注入 createSequenceIdFactory(1) 的引擎独立计数且 ID 合法', () => {
    const engineA = createTestEngine({ ids: createSequenceIdFactory(1) });
    const engineB = createTestEngine({ ids: createSequenceIdFactory(1) });
    const eventsFor = () => [
      makeEvent({ eventId: EVENT_ID_A, observedAt: 1000 }),
      makeEvent({ eventId: EVENT_ID_B, observedAt: 2000 }),
    ];
    const resultA = engineA.ingest(eventsFor());
    const resultB = engineB.ingest(eventsFor());
    const detectionIdsA = resultA.detections.map((detection) => detection.detectionId);
    const detectionIdsB = resultB.detections.map((detection) => detection.detectionId);
    assert.equal(detectionIdsA.length, 2);
    assert.equal(detectionIdsB.length, 2);
    for (const value of [...detectionIdsA, ...detectionIdsB]) {
      assert.equal(isUuidV4(value), true, `${value} 不是规范 UUIDv4`);
    }
    // 每台引擎内部序号独立推进
    assert.notEqual(detectionIdsA[0], detectionIdsA[1]);
    assert.notEqual(detectionIdsB[0], detectionIdsB[1]);
    // 同参工厂从同一序号起步，因此两台引擎的首个 ID 相同（重放语义）
    assert.deepEqual(detectionIdsB, detectionIdsA);
    assert.equal(isUuidV4(resultA.alerts[0].alertId), true);
    assert.equal(isUuidV4(resultB.alerts[0].alertId), true);
  });
});
