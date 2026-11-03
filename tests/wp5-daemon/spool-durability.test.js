/**
 * spool-durability.test.js — ADR-0007 的验收：留存证据必须跨进程活下来。
 *
 * 第 8–12 轮的四代修法都在"丢在谁身上"上打转（全局淘汰 / 拒收新条目 / 每来源配额），
 * 根因其实是**留存证据只在内存里**：写失败后游标不推进、批次会重放，可崩溃一次之后
 * 队列消失，而已入库的那条事件在同一进程内已被引擎见过、重启后又被稳定键预过滤挡在检测之外，
 * 于是它永远不会被 `count` 认领——`truncated=false` 却在少计（ADR-0007 §1.2 有当前树的实测）。
 *
 * 这里的每一条都用真 SQLite + 真检测引擎 + 真 scheduler，并且**崩溃就是关掉 store 再开一次**，
 * 不做任何"把内存队列搬过去"的取巧。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { createScheduler } from '../../apps/daemon/src/scheduler.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { createDaemon } from '../../apps/daemon/src/daemon.js';
import { computeHealth } from '../../apps/daemon/src/health.js';
import { DaemonError, DAEMON_CODES } from '../../apps/daemon/src/errors.js';

import {
  BASE_MS,
  assertCountsFollowEvidence,
  createScriptedSource,
  makeConfig,
  makeEvent,
  makeStore,
  makeTempDir,
  openRealPipeline,
  readEvidence,
  waitFor,
} from './helpers.js';

const SCHEDULER = { tickMs: 1000, sourceTimeoutMs: 5000, maxBatchEvents: 500, staleAfterMs: 30000, maxSources: 64 };

/** 分钟偏移 → RFC3339（基准 2026-11-02T00:00:00Z，告警窗口 15 分钟）。 */
function at(minute, second = 0) {
  return new Date(BASE_MS + minute * 60000 + second * 1000).toISOString();
}

/** 时间自洽的事件。 */
function event(source, minute, seq, extra = {}) {
  const observedAt = at(minute);
  return makeEvent({
    stable_source_id: source,
    source_seq: seq,
    observed_at: observedAt,
    received_at: new Date(Date.parse(observedAt) + 1000).toISOString(),
    ...extra,
  });
}

/** 一套 scheduler，绑定到某个 pipeline（重启用例要能换 pipeline 而不换库）。 */
function schedulerFor({ sources, pipeline, clock }) {
  return createScheduler({ sources, pipeline, clock, ...SCHEDULER });
}

/** 等所有 poll 落定。 */
async function drain(scheduler) {
  await waitFor(() => scheduler.status().every((entry) => entry.polling === false), {
    label: 'scheduler polls settle',
  });
}

/**
 * 一个事件同时命中两条规则（两个指纹）的规则包，用来验证"丢弃按观测计数"。
 *
 * @returns {object} 规则包。
 */
function twoRulePack() {
  return {
    schemaVersion: '1.0',
    packId: 'wp5-two-rules',
    packVersion: '1.0.0',
    rules: [
      {
        ruleId: 'proc.name',
        version: '1.0.0',
        type: 'condition',
        severity: 'high',
        fields: ['process_name'],
        fingerprint: ['process_name'],
        when: { field: 'process_name', operator: 'eq', value: 'evil.exe' },
      },
      {
        ruleId: 'proc.parent',
        version: '1.0.0',
        type: 'condition',
        severity: 'low',
        fields: ['parent_name'],
        fingerprint: ['parent_name'],
        when: { field: 'parent_name', operator: 'eq', value: 'evil-parent.exe' },
      },
    ],
  };
}

describe('ADR-0007：重启恢复（部分写成功 + 锚点失败）', () => {
  it('崩溃后重放必须把已入库但未认领的观测补回 count（本轮 P1 的正面证据）', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);

    const e1 = event('synthetic.a', 1, 101);
    const e2 = event('synthetic.a', 2, 102);
    const batch = [e1, e2];

    const first = await openRealPipeline(file, clock);
    const firstScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch, batch] })],
      pipeline: first.pipeline,
      clock,
    });
    // 锚点（后位）写失败：整条告警贡献留在队列里，而 e1 已经入库。
    first.injected.failSeqs.add(102);
    await firstScheduler.pollNow('synthetic.a');

    const partial = readEvidence(file, clock);
    assert.equal(partial.events.length, 1, '只有 e1 入库');
    assert.equal(partial.alerts.length, 0, '锚点失败时不得写出没有证据的行');
    assert.equal(first.pipeline.stats().contributions_pending, 1, '队列里必须有一条待补记');

    // 崩溃：内存队列消失，spool 行是唯一活下来的东西。
    first.store.close();

    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.equal(second.pipeline.stats().contributions_recovered, 1, '新进程必须从库里恢复这条待补记');

    const secondScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch] })],
      pipeline: second.pipeline,
      clock,
    });
    await secondScheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.events.length, 2, '重放把 e2 补上');
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 2, 'e1 的观测必须被补回 count（重启前这里是 1）');
    assertCountsFollowEvidence(snapshot, '重启恢复');
    assert.equal(second.pipeline.stats().contributions_pending, 0, '补记完成后队列必须清空');
    assert.equal(second.pipeline.stats().contributions_dropped, 0);
    assert.deepEqual(second.violations, [], '任何一次 T1 调用都不得引用尚未写入的事件');
  });
});

describe('ADR-0007：重启后的来源隔离', () => {
  it('B 的批次不得排空 A 从 spool 恢复的条目', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);

    const a1 = event('synthetic.a', 1, 201);
    const a2 = event('synthetic.a', 2, 202);
    const b1 = event('synthetic.b', 3, 301);
    const batchA = [a1, a2];

    const first = await openRealPipeline(file, clock);
    const firstScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batchA, batchA] })],
      pipeline: first.pipeline,
      clock,
    });
    first.injected.failSeqs.add(202);
    await firstScheduler.pollNow('synthetic.a');
    assert.equal(first.pipeline.stats().contributions_pending, 1);
    first.store.close();

    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.equal(second.pipeline.stats().contributions_recovered, 1);

    const bScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.b', script: [[b1]] })],
      pipeline: second.pipeline,
      clock,
    });
    await bScheduler.pollNow('synthetic.b');
    assert.equal(second.pipeline.stats().contributions_pending, 1, 'B 不得排空 A 的条目');
    assert.equal(second.pipeline.stats().contributions_attach_attempts, 0, 'B 不得消耗 A 的预算');
    assert.equal(second.pipeline.stats().contributions_dropped, 0);

    const aScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batchA] })],
      pipeline: second.pipeline,
      clock,
    });
    await aScheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.events.length, 3);
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 3, '三条可核实事件都必须被 count 认领');
    assertCountsFollowEvidence(snapshot, '重启后跨来源');
    assert.equal(second.pipeline.stats().contributions_pending, 0);
  });
});

describe('ADR-0007：大量积压不得按容量丢弃', () => {
  it('同来源 99 条全失败 + 重启：每个窗口都必须有告警行且 count 追平', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const burst = Array.from({ length: 99 }, (_unused, index) => event('synthetic.a', 10 + index * 15, 700 + index));

    const first = await openRealPipeline(file, clock);
    const firstScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [burst, burst] })],
      pipeline: first.pipeline,
      clock,
    });
    for (const item of burst) {
      first.injected.failSeqs.add(item.source_seq);
    }
    await firstScheduler.pollNow('synthetic.a');
    assert.equal(first.pipeline.stats().contributions_pending, 99, '99 条失败观测必须全部留下');
    assert.equal(first.pipeline.stats().contributions_dropped, 0, '不得按容量丢弃任何一条');
    assert.equal(first.pipeline.stats().contributions_spool_errors, 0);
    first.store.close();

    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.equal(second.pipeline.stats().contributions_recovered, 99, '99 条都必须从库里恢复');

    const secondScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [burst] })],
      pipeline: second.pipeline,
      clock,
    });
    await secondScheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.events.length, 99);
    assert.equal(snapshot.alerts.length, 99, '每个窗口都必须有告警行');
    for (const alert of snapshot.alerts) {
      assert.equal(alert.count, 1, `窗口 ${alert.window_start} 必须认领自己那一条事件`);
    }
    assertCountsFollowEvidence(snapshot, '99 条降级批次 + 重启');
    assert.equal(second.pipeline.stats().contributions_pending, 0);
    assert.equal(second.pipeline.stats().contributions_dropped, 0);
  });

  it('同来源 33 条积压 + 另一来源 1 条：两侧都不丢，重放后各自追平', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const a1 = event('synthetic.a', 1, 401);
    const backlog = Array.from({ length: 33 }, (_unused, index) => event('synthetic.b', 20 + index * 15, 500 + index));

    const env = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    const scheduler = schedulerFor({
      sources: [
        createScriptedSource({ id: 'synthetic.a', script: [[a1], [a1]] }),
        createScriptedSource({ id: 'synthetic.b', script: [backlog, backlog] }),
      ],
      pipeline: env.pipeline,
      clock,
    });

    env.injected.failSeqs.add(401);
    for (const item of backlog) {
      env.injected.failSeqs.add(item.source_seq);
    }
    await scheduler.pollNow('synthetic.a');
    await scheduler.pollNow('synthetic.b');
    assert.equal(env.pipeline.stats().contributions_pending, 34, '1 条 A + 33 条 B');
    assert.equal(env.pipeline.stats().contributions_dropped, 0);

    env.injected.failSeqs.clear();
    await scheduler.pollNow('synthetic.b');
    await scheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.events.length, 34);
    assert.equal(snapshot.alerts.length, 34, '34 个窗口各一行');
    assertCountsFollowEvidence(snapshot, '33 条积压');
    assert.equal(env.pipeline.stats().contributions_pending, 0);
    assert.deepEqual(env.violations, []);
  });
});

describe('ADR-0007：补记是幂等的', () => {
  it('写入成功后 spool 删除失败：残留行重启后不得把同一次观测再计一遍', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const e1 = event('synthetic.a', 1, 501);
    const e2 = event('synthetic.a', 2, 502);
    const e3 = event('synthetic.a', 3, 503);
    const batch = [e1, e2];

    const first = await openRealPipeline(file, clock);
    // 删除 spool 行失败：模拟"T1 提交成功、提交后立刻崩溃"的残留。
    first.store.deleteContributionSpool = () => {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected spool delete failure');
    };
    const firstScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch, batch] })],
      pipeline: first.pipeline,
      clock,
    });
    first.injected.failSeqs.add(502);
    await firstScheduler.pollNow('synthetic.a');
    assert.equal(first.pipeline.stats().contributions_pending, 1);

    first.injected.failSeqs.clear();
    await firstScheduler.pollNow('synthetic.a');
    const drained = readEvidence(file, clock);
    assert.equal(drained.alerts[0].count, 2, '重放后补记完成');
    assert.equal(first.pipeline.stats().contributions_pending, 0, '内存队列已排空');
    assert.equal(first.pipeline.stats().contributions_spool_errors, 1, '删除失败必须被计数');
    first.store.close();

    // 重启：残留行的证据都已被那一行认领 ⇒ 启动核对直接清掉它（第 13 轮 P2-15），
    // 既不会双计，也不会永久占位。
    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.equal(second.pipeline.stats().contributions_reconciled, 1, '已认领的残留行必须在启动时核对掉');
    assert.equal(second.pipeline.stats().contributions_recovered, 0);
    assert.equal(second.store.listContributionSpool().entries.length, 0);

    const secondScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [[e3]] })],
      pipeline: second.pipeline,
      clock,
    });
    await secondScheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.events.length, 3);
    assert.equal(snapshot.alerts[0].count, 3, '残留行不得把 e1/e2 再计一遍（否则是 5）');
    assertCountsFollowEvidence(snapshot, '残留 spool 行');
    assert.equal(second.pipeline.stats().contributions_pending, 0, '用不上的残留行必须被清掉');
  });

  it('残留旧行 + 部分提交：重启后重放不得把已被该行认领的那条再计一遍', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const e1 = event('synthetic.a', 1, 511);
    const e2 = event('synthetic.a', 2, 512);
    const e3 = event('synthetic.a', 20, 513);
    const batch = [e1, e2];

    const env = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    const scheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch, [e3], batch] })],
      pipeline: env.pipeline,
      clock,
    });

    // 1) 条目 [e1,e2] 落下；e1 已入库、e2 未入库。
    env.injected.failSeqs.add(512);
    await scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1);

    // 2) 另一窗口的 e3 成功：条目被"部分提交"（只有 e1 可核验），余量 [e2] 另存一份；
    //    旧行 [e1,e2] 的删除**失败**，于是它留在了库里 —— 这是崩溃窗口的等价格式。
    const del = env.store.deleteContributionSpool.bind(env.store);
    env.store.deleteContributionSpool = () => {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected spool delete failure');
    };
    await scheduler.pollNow('synthetic.a');
    env.store.deleteContributionSpool = del;
    const mid = readEvidence(file, clock);
    const early = mid.alerts.find((alert) => alert.window_start === '2026-11-02T00:00:00.000Z');
    assert.equal(early.count, 1, '部分提交只认领 e1');

    // 3) 重启 + 重放：e1 已被那一行认领，attach 不得把它再算一次（否则 count 会比库内事件数多 1）。
    env.store.close();
    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.ok(second.pipeline.stats().contributions_recovered >= 1, 'e2 还没入库，条目必须被保留');

    const secondScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch] })],
      pipeline: second.pipeline,
      clock,
    });
    await secondScheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.events.length, 3, 'e1 / e2 / e3 三条都在库里');
    const window0 = snapshot.alerts.find((alert) => alert.window_start === '2026-11-02T00:00:00.000Z');
    assert.equal(window0.count, 2, 'e1 已经计过，只能补 e2');
    assertCountsFollowEvidence(snapshot, '部分提交的残留行');
  });
});

describe('ADR-0007：spool 行只能删在提交之后', () => {
  it('T1 调用发生时该条目的 spool 行必须还在（第 13 轮 P1-9 的顺序断言）', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const e1 = event('synthetic.a', 1, 901);
    const e2 = event('synthetic.a', 2, 902);
    const batch = [e1, e2];

    const env = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    const scheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch, batch, batch] })],
      pipeline: env.pipeline,
      clock,
    });

    // 第一批：锚点失败，留下一条待补记（spool 行存在）。
    env.injected.failSeqs.add(902);
    await scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1);
    assert.equal(env.store.listContributionSpool().entries.length, 1, '失败后必须落盘');

    // 第二批：原样重放。这一批里条目的两个证据都可核验（e1 已入库、e2 在本批），所以它**没有**
    // remainder —— 若实现把 DELETE 放在计划阶段，此刻 ingest 会看到 0 行；崩在两者之间证据就没了。
    env.injected.failSeqs.clear();
    const seen = [];
    const innerIngest = env.store.ingest.bind(env.store);
    env.store.ingest = (request) => {
      seen.push({ seq: request.event.source_seq, rows: env.store.listContributionSpool().entries.length });
      return innerIngest(request);
    };
    await scheduler.pollNow('synthetic.a');
    env.store.ingest = innerIngest;

    assert.ok(seen.length > 0, '第二批必须真的发生了一次 T1 调用');
    assert.equal(seen[0].rows, 1, '提交之前不得删掉待补记的落盘行');
    assert.equal(env.store.listContributionSpool().entries.length, 0, '提交成功后落盘行必须消失');
    assert.equal(env.pipeline.stats().contributions_pending, 0);

    // 崩溃 + 重启：既不能少计，也不能因为残留而双计。
    env.store.close();
    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.equal(second.pipeline.stats().contributions_recovered, 0, '已提交的条目不得留下可恢复行');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.alerts[0].count, 2);
    assertCountsFollowEvidence(snapshot, '删除晚于提交');
  });

  it('写失败时该条目必须仍然落盘（不能"先删后存"）', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const e1 = event('synthetic.a', 1, 911);
    const e2 = event('synthetic.a', 2, 912);
    const e3 = event('synthetic.a', 3, 913);

    const env = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    const scheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [[e1, e2], [e3], [e3]] })],
      pipeline: env.pipeline,
      clock,
    });

    env.injected.failSeqs.add(912);
    await scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1);

    // 第二批成为它的锚点，但这一批的**写入也失败**：旧行不得在提交前被删掉。
    env.injected.failSeqs.add(913);
    await scheduler.pollNow('synthetic.a');
    assert.ok(
      env.store.listContributionSpool().entries.length >= 1,
      '写失败后待补记必须仍然落盘（否则崩溃即丢）',
    );

    env.injected.failSeqs.clear();
    env.store.close();
    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.ok(second.pipeline.stats().contributions_recovered >= 1, '重启必须能恢复这条待补记');

    const secondScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [[e1, e2], [e3]] })],
      pipeline: second.pipeline,
      clock,
    });
    await secondScheduler.pollNow('synthetic.a');
    await secondScheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assertCountsFollowEvidence(snapshot, '写失败仍落盘');
  });
  it('同内容重试再失败：替换副本会 UPSERT 同一行，不得把它删掉（第 13 轮 P1-10a）', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const e1 = event('synthetic.a', 1, 921);
    const e2 = event('synthetic.a', 2, 922);
    const batch = [e1, e2];

    const env = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    const scheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch, batch, batch] })],
      pipeline: env.pipeline,
      clock,
    });

    env.injected.failSeqs.add(922);
    await scheduler.pollNow('synthetic.a');
    assert.equal(env.store.listContributionSpool().entries.length, 1);

    // 同一批再失败一次：重保留的内容与旧条目**逐字节相同** ⇒ 同一个 spool_id（UPSERT）。
    // 老实现因为"重新保留过"就删旧行，等于把刚 UPSERT 的那一行删掉：证据归零。
    await scheduler.pollNow('synthetic.a');
    assert.equal(
      env.store.listContributionSpool().entries.length,
      1,
      '同内容重试后必须仍然恰好一行（既不能删空，也不能长出第二行）',
    );
    assert.equal(env.pipeline.stats().contributions_spool_errors, 0);

    env.store.close();
    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.ok(second.pipeline.stats().contributions_recovered >= 1, '重启必须仍能恢复这条待补记');

    const secondScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch] })],
      pipeline: second.pipeline,
      clock,
    });
    await secondScheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.alerts[0].count, 2);
    assertCountsFollowEvidence(snapshot, '同内容重试');
  });

  it('写失败且落盘也失败：旧行必须原样保留（第 13 轮 P1-10b）', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const e1 = event('synthetic.a', 1, 931);
    const e2 = event('synthetic.a', 2, 932);
    const batch = [e1, e2];

    const env = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    const scheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch, batch] })],
      pipeline: env.pipeline,
      clock,
    });

    env.injected.failSeqs.add(932);
    await scheduler.pollNow('synthetic.a');
    assert.equal(env.store.listContributionSpool().entries.length, 1);

    // 第二次失败，同时让 spool 写也失败：内存条目仍然会被返回（本进程要能重试），
    // 但**没有任何替换副本落盘**，旧行必须留着。
    const put = env.store.putContributionSpool.bind(env.store);
    env.store.putContributionSpool = () => {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected spool write failure');
    };
    await scheduler.pollNow('synthetic.a');
    env.store.putContributionSpool = put;

    assert.ok(env.pipeline.stats().contributions_spool_errors > 0, '落盘失败必须被计数');
    assert.equal(
      env.store.listContributionSpool().entries.length,
      1,
      '没有任何新副本落盘时，旧行不得被删除',
    );

    env.store.close();
    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.ok(second.pipeline.stats().contributions_recovered >= 1);

    env.injected.failSeqs.clear();
    const secondScheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch] })],
      pipeline: second.pipeline,
      clock,
    });
    await secondScheduler.pollNow('synthetic.a');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.alerts[0].count, 2);
    assertCountsFollowEvidence(snapshot, '落盘失败 + 写失败');
  });
  it('孤儿落盘行：重启时若证据已被该行全部认领，必须被清理掉（第 13 轮 P2-15）', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const e1 = event('synthetic.a', 1, 941);
    const e2 = event('synthetic.a', 2, 942);
    const batch = [e1, e2];

    const env = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    const scheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch, batch, batch] })],
      pipeline: env.pipeline,
      clock,
    });

    // 第一次失败：落盘一行。
    env.injected.failSeqs.add(942);
    await scheduler.pollNow('synthetic.a');
    assert.equal(env.store.listContributionSpool().entries.length, 1);

    // 第二次失败 + 落盘失败：旧行必须留着（P1-10b），但内存里的条目没有 spool_id。
    const put = env.store.putContributionSpool.bind(env.store);
    env.store.putContributionSpool = () => {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected spool write failure');
    };
    await scheduler.pollNow('synthetic.a');
    env.store.putContributionSpool = put;
    assert.equal(env.store.listContributionSpool().entries.length, 1);

    // 第三次成功：内存条目被排空，但那一行已经没有任何内存索引指向它 —— 孤儿。
    env.injected.failSeqs.clear();
    await scheduler.pollNow('synthetic.a');
    const committed = readEvidence(file, clock);
    assert.equal(committed.alerts[0].count, 2, '提交后 count 必须追平');
    assert.equal(env.pipeline.stats().contributions_pending, 0, '内存索引已空');
    assert.equal(env.store.listContributionSpool().entries.length, 1, '孤儿行此时还留在库里');

    // 重启：孤儿行的证据已被该行全部认领 ⇒ 贡献量为 0 ⇒ 必须被清理，而不是永久占位/永久 degraded。
    env.store.close();
    const second = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    assert.equal(second.pipeline.stats().contributions_reconciled, 1, '孤儿行必须在启动时被核对掉');
    assert.equal(second.pipeline.stats().contributions_pending, 0, '不得让已认领的孤儿永久占位');
    assert.equal(second.pipeline.stats().contributions_recovered, 0);
    assert.equal(second.store.listContributionSpool().entries.length, 0, '库里也必须清掉');

    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.alerts[0].count, 2, '清理孤儿行不得改变 count');
    assertCountsFollowEvidence(snapshot, '孤儿行核对');
  });
});

describe('ADR-0007：落盘失败必须可见', () => {
  it('spool 写失败：计数 + health 降级，但本进程内仍能补写成功', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const a1 = event('synthetic.a', 1, 601);
    const a2 = event('synthetic.a', 2, 602);
    const batch = [a1, a2];

    const env = await openRealPipeline(file, clock);
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    env.store.putContributionSpool = () => {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected spool write failure');
    };
    const scheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch, batch] })],
      pipeline: env.pipeline,
      clock,
    });

    env.injected.failSeqs.add(602);
    await scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_spool_errors, 1, '落盘失败必须被计数');
    assert.equal(env.pipeline.stats().contributions_pending, 1, '条目仍在内存里（本进程还能补）');

    const health = computeHealth({
      lifecycle: 'running',
      store: { open: true, errors: 0 },
      detection: { faults: 0, frozen: false },
      pipeline: {
        pendingContributions: env.pipeline.stats().contributions_pending,
        contributionsDropped: env.pipeline.stats().contributions_dropped,
        spoolErrors: env.pipeline.stats().contributions_spool_errors,
      },
      sources: [{ id: 'synthetic.a', lifecycle: 'running', stale: false, consecutive_failures: 0 }],
    });
    assert.equal(health.status, 'degraded');
    assert.ok(
      health.reasons.includes('pipeline:contributions-spool-degraded:1'),
      `health 必须报出落盘降级，实际 ${JSON.stringify(health.reasons)}`,
    );

    env.injected.failSeqs.clear();
    await scheduler.pollNow('synthetic.a');
    const snapshot = readEvidence(file, clock);
    assert.equal(snapshot.alerts[0].count, 2, '内存兜底必须仍然把观测补回来');
    assertCountsFollowEvidence(snapshot, '落盘失败后的内存兜底');
  });
});

describe('ADR-0007：丢弃按观测计数且必须降级', () => {
  it('同来源预算耗尽：一个条目带两条告警时 dropped 必须加 2', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);
    const payload = { process_name: 'evil.exe', pid: 4242, parent_name: 'evil-parent.exe' };
    const survivor = event('synthetic.a', 1, 701, { payload });
    const doomed = event('synthetic.a', 2, 702, { payload });
    const later = Array.from({ length: 9 }, (_unused, index) => [event('synthetic.a', 4 + index, 710 + index, { payload })]);

    const env = await openRealPipeline(file, clock, { pack: twoRulePack() });
    t.after(() => {
      try {
        env.store.close();
      } catch {
        // 已关过。
      }
    });
    const scheduler = schedulerFor({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [[survivor, doomed], ...later] })],
      pipeline: env.pipeline,
      clock,
    });

    // 锚点（后位）失败 ⇒ 两条告警贡献整组留在**一个**条目里，这正是"按观测计数"要覆盖的形态。
    env.injected.failSeqs.add(702);
    await scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1, '一个条目（带两条告警贡献）');

    for (let index = 0; index < later.length; index += 1) {
      await scheduler.pollNow('synthetic.a');
    }

    assert.equal(env.pipeline.stats().contributions_pending, 0, '预算耗尽后不得永久占用队列');
    assert.equal(
      env.pipeline.stats().contributions_dropped,
      2,
      '一个条目带两条告警 = 丢两条观测，必须按观测计数（第 11/12 轮 P3-20）',
    );

    const health = computeHealth({
      lifecycle: 'running',
      store: { open: true, errors: 0 },
      detection: { faults: 0, frozen: false },
      pipeline: {
        pendingContributions: env.pipeline.stats().contributions_pending,
        contributionsDropped: env.pipeline.stats().contributions_dropped,
        spoolErrors: env.pipeline.stats().contributions_spool_errors,
      },
      sources: [{ id: 'synthetic.a', lifecycle: 'running', stale: false, consecutive_failures: 0 }],
    });
    assert.equal(health.status, 'degraded');
    assert.ok(
      health.reasons.includes('pipeline:contributions-dropped:2'),
      `丢弃必须出现在 health 原因里，实际 ${JSON.stringify(health.reasons)}`,
    );

    const snapshot = readEvidence(file, clock);
    assertCountsFollowEvidence(snapshot, '预算耗尽');
  });

  it('daemon 级：丢弃后 /health 必须降级（计数器确实接进了 health）', async (t) => {
    const dir = makeTempDir();
    const clock = createManualClock(BASE_MS);
    const payload = { process_name: 'evil.exe', pid: 4242, parent_name: 'evil-parent.exe' };
    const survivor = event('synthetic.a', 1, 801, { payload });
    const doomed = event('synthetic.a', 2, 802, { payload });
    const later = Array.from({ length: 9 }, (_unused, index) => [event('synthetic.a', 4 + index, 810 + index, { payload })]);

    const store = makeStore(clock);
    // 写入失败必须在 daemon 启动前就装好：scheduler.start() 会立刻 poll 一次。
    const realIngest = store.ingest.bind(store);
    const failSeqs = new Set([802]);
    store.ingest = (request) => {
      if (failSeqs.has(request.event.source_seq)) {
        throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure');
      }
      return realIngest(request);
    };

    const daemon = createDaemon({
      config: makeConfig(dir, { rulePack: twoRulePack() }),
      sources: [createScriptedSource({ id: 'synthetic.a', script: [[survivor, doomed], ...later] })],
      store,
      clock,
    });
    await daemon.start();
    t.after(async () => {
      await daemon.stop('test');
    });
    // 首拍由 start() 触发，等它落定再手工驱动剩下的 9 批。
    await waitFor(() => daemon.status().scheduler.status().every((source) => source.polling === false), {
      label: 'first tick settles',
    });

    for (let index = 0; index < later.length; index += 1) {
      await daemon.pollSource('synthetic.a');
    }

    const status = daemon.status();
    assert.equal(status.counters.contributions_dropped, 2, '两个指纹各丢一次观测');
    const health = daemon.health();
    assert.equal(health.status, 'degraded');
    assert.ok(
      health.reasons.includes('pipeline:contributions-dropped:2'),
      `daemon.health() 必须把丢弃接进原因，实际 ${JSON.stringify(health.reasons)}`,
    );
  });
});
