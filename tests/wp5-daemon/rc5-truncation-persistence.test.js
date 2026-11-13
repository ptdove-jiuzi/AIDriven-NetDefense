/**
 * rc5-truncation-persistence.test.js — RC4-N02 回归：批量截断不得永久丢数据，且必须如实上报。
 *
 * RC4 再攻击（`reviews/REATTACK-RC4.md` §3.4）的现场：默认 `maxBatchEvents=500`，本机首次目录快照
 * 20,000 条 → 只入库 500 条，19,500 条（97.5%）**永久丢失**，`health.status` 21/21 采样全是 `ok`。
 * 代码级根因两条：
 *
 * 1. `scheduler.js` 把批次 `slice(0, maxBatchEvents)` 之后仍然 `state.cursor = outcome.cursor`，
 *    被截掉的尾部再也不会被重读；
 * 2. `health.js` 的 `computeHealth()` 完全不看逐源 `dropped_events`，把"明知有数据没读"报成健康。
 *
 * 本文件的判据（三条都必须先红后绿）：
 *
 * - **T1 不永久丢**：真实 SQLite store（`createEventStoreAdapter`，WAL + synchronous=FULL，与 full 模式
 *   同一条路径），源每轮返回整个 20,000 条快照 → 反复轮询后 `store.stats().events === 20000`，
 *   且过程中"已接受"与"已入库"始终相等、游标在排空前不前进；
 * - **T2 health 诚实**：截断时 `computeHealth()` 必须是 `degraded` 且带稳定 reason
 *   `sources:dropped-events:<总数>`，`/status`（`buildStatusPayload`）能读到 reasons 与逐源条数；
 *   排空后 `dropped_events` 归零、health 自愈回 `ok`（否则这个 reason 会永久钉住，等于另一种不诚实）；
 * - **T3 日志级别**：截断必须是 `logger.error`（一条，含 `source_id` / 本轮被截条数 /
 *   `max_batch_events` / 待重读条数），不是 `warn`。
 *
 * 数据全部是合成事件，路径全部在临时目录内；不读真实事件日志、不写 `%USERPROFILE%`。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { createScheduler } from '../../apps/daemon/src/scheduler.js';
import { buildStatusPayload, computeHealth } from '../../apps/daemon/src/health.js';
import { createScriptedSource } from '../../apps/daemon/src/adapters/collector.js';
import {
  BASE_ISO,
  BASE_MS,
  TEST_EPOCH,
  createManualClock,
  makeEvent,
  makeTempDir,
  openRealPipeline,
  readEvidence,
  settle,
  makeSchedulerParts,
} from './helpers.js';

/** RC4 现场的规模：首次目录快照 20,000 条。 */
const SNAPSHOT_SIZE = 20000;
/** `apps/daemon/src/config.js` 的默认值（`DEFAULTS.scheduler.maxBatchEvents`），不是测试自造口径。 */
const MAX_BATCH_EVENTS = 500;

/** 测试自己的静默 logger：避免 T1/T2 的 40 条 error 行污染套件输出。 */
const SILENT_LOGGER = Object.freeze({
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return SILENT_LOGGER;
  },
});

/**
 * 模拟"快照位置"语义的采集源：游标空 = 从快照头读；游标在尾部 = 没有新记录。
 *
 * 每次 poll 都返回**同一份** 20,000 条快照（这正是 RC4 现场：首次目录快照一次读全），
 * 因此"截断后冻结游标、下一轮从旧游标重读"的每一轮都会重新看到同一批事件，
 * 只能靠"已入库多少条"决定这一轮该摄入哪一段窗口，靠稳定键去重吸收重叠。
 *
 * @returns {{id: string, kind: string, intervalMs: null, reads: number[], poll: Function}} Source.
 */
function makeSnapshotSource() {
  const snapshot = Array.from({ length: SNAPSHOT_SIZE }, (_unused, index) => makeEvent({
    source_seq: index + 1,
    payload: { process_name: 'svchost.exe', pid: 1000 + index },
    native_record_id: `file-${index + 1}`,
  }));
  const reads = [];
  return {
    id: 'synthetic.snapshot',
    kind: 'synthetic',
    intervalMs: null,
    reads,
    poll(ctx) {
      const offset = Number.isSafeInteger(ctx?.cursor?.offset) ? ctx.cursor.offset : 0;
      reads.push(offset);
      return { events: snapshot.slice(offset), cursor: { offset: snapshot.length } };
    },
  };
}

/**
 * `computeHealth` 的健康输入骨架：除了 sources 之外全部健康。
 *
 * @param {readonly object[]} sources 逐源状态行（`scheduler.status()` 的形状）。
 * @returns {object} computeHealth 入参。
 */
function healthInputFor(sources) {
  return {
    lifecycle: 'running',
    store: { open: true, errors: 0 },
    detection: { faults: 0, frozen: false },
    sources,
  };
}

describe('RC5-N02 · 截断不得永久丢数据（T1）', () => {
  it('re-reads a truncated 20,000-record snapshot until every record is persisted', async (t) => {
    const clock = createManualClock(BASE_MS);
    const file = join(makeTempDir(), 'rc5-n02.sqlite');
    // 真实 store：与 full 模式同一条 `createEventStoreAdapter` 路径（真 SQLite、真 T1 事务、真稳定键）。
    const parts = await openRealPipeline(file, clock);
    const source = makeSnapshotSource();
    const scheduler = createScheduler({
      sources: [source],
      pipeline: parts.pipeline,
      clock,
      tickMs: 1000,
      sourceTimeoutMs: 30000,
      maxBatchEvents: MAX_BATCH_EVENTS,
      staleAfterMs: 30000,
      maxSources: 4,
      logger: SILENT_LOGGER,
    });

    let rounds = 0;
    let previousStored = 0;
    try {
      while (parts.store.stats().events < SNAPSHOT_SIZE && rounds < 80) {
        await scheduler.pollNow(source.id);
        rounds += 1;
        const status = scheduler.sourceStatus(source.id);
        const stored = parts.store.stats().events;
        // 不变量 A：本轮"摄入了多少"必须等于"库里多了多少"，不允许"接受了但没入库"的缺口。
        assert.equal(
          status.events,
          stored,
          `round ${rounds}: ${status.events} event(s) ingested but ${stored} stored (accepted-but-not-persisted gap)`,
        );
        // 不变量 B：已入库数只能上升。
        assert.ok(stored >= previousStored, `round ${rounds}: store.events went backwards (${previousStored} -> ${stored})`);
        // 不变量 C：还没摄入的条数必须是"源说有、库里还没有"的差额；这个数字就是 health 的依据。
        if (stored < SNAPSHOT_SIZE) {
          assert.equal(
            status.dropped_events,
            SNAPSHOT_SIZE - stored,
            `round ${rounds}: dropped_events must name the records still waiting (source had ${SNAPSHOT_SIZE}, store ${stored})`,
          );
          // 不变量 D：只要还有尾部没读，游标就不得前进（否则那段数据再也读不到）。
          assert.equal(
            status.cursor,
            null,
            `round ${rounds}: cursor advanced to ${JSON.stringify(status.cursor)} while `
              + `${SNAPSHOT_SIZE - stored} of ${SNAPSHOT_SIZE} records were still unread (store has ${stored})`,
          );
        }
        previousStored = stored;
      }

      // 尾部排空后，游标才允许落到快照位置；再 poll 一次只会拿到空批次。
      await scheduler.pollNow(source.id);
      const status = scheduler.sourceStatus(source.id);
      const finalStored = parts.store.stats().events;
      assert.equal(
        finalStored,
        SNAPSHOT_SIZE,
        `all ${SNAPSHOT_SIZE} records must eventually be stored, got ${finalStored} (RC4-N02 lost 19,500 of them permanently)`,
      );
      assert.ok(rounds <= 80, `draining must converge in bounded rounds, took ${rounds}`);
      assert.equal(status.events, SNAPSHOT_SIZE);
      assert.equal(status.dropped_events, 0, 'nothing may stay marked as dropped once the tail has been read');
      assert.deepEqual(status.cursor, { offset: SNAPSHOT_SIZE }, 'the cursor finally advances to the snapshot position');

      // 断言的另一半：条数相等还不够，序号必须完整（没有"数量对、内容缺"的缺口）。
      parts.store.close();
      const snapshotRows = readEvidence(file, clock).events;
      assert.equal(snapshotRows.length, SNAPSHOT_SIZE);
      const sequences = snapshotRows.map((row) => row.source_seq).sort((left, right) => left - right);
      assert.equal(sequences[0], 1);
      assert.equal(sequences[sequences.length - 1], SNAPSHOT_SIZE);
      assert.equal(new Set(sequences).size, SNAPSHOT_SIZE, 'every source_seq must be present exactly once');

      t.diagnostic(`T1: ${SNAPSHOT_SIZE} records / max_batch ${MAX_BATCH_EVENTS} -> ${rounds} poll(s) to drain, store.events=${finalStored}`);
    } finally {
      await scheduler.stop({ timeoutMs: 2000 });
      try {
        parts.store.close();
      } catch {
        // 已在断言前 close 过；Windows 上重复 close 不得掩盖真正的断言失败。
      }
    }
  });
});

describe('RC5-N02 · health 必须如实降级（T2）', () => {
  it('turns a truncated batch into degraded + a stable reason that /status can be read from', async () => {
    const events = Array.from({ length: 5 }, (_unused, index) => makeEvent({ source_seq: index + 1 }));
    const parts = makeSchedulerParts({
      sources: [createScriptedSource({ id: 'synthetic.bulk', script: [events] })],
      tickMs: 1000,
      maxBatchEvents: 2,
      logger: SILENT_LOGGER,
    });
    parts.scheduler.tick();
    await settle();

    const sources = parts.scheduler.status();
    assert.equal(sources[0].dropped_events, 3, 'fixture: 5 events with max_batch 2 leaves 3 unread');

    const health = computeHealth(healthInputFor(sources));
    assert.equal(health.status, 'degraded', 'a knowingly unread tail must not be reported as healthy');
    assert.ok(
      health.reasons.includes('sources:dropped-events:3'),
      `health.reasons must carry the stable "sources:dropped-events:<total>" entry, got ${JSON.stringify(health.reasons)}`,
    );

    const payload = buildStatusPayload({
      version: 'test',
      lifecycle: 'running',
      startedAt: BASE_ISO,
      startedAtMs: BASE_MS,
      clock: parts.clock,
      epoch: TEST_EPOCH,
      mode: 'mock',
      scheduler: parts.scheduler,
      pipeline: parts.pipeline,
      store: {
        kind: 'memory',
        isOpen: () => true,
        stats: () => parts.store.stats(),
      },
      health,
      counters: {},
    });
    assert.equal(payload.health.status, 'degraded');
    assert.ok(payload.health.reasons.includes('sources:dropped-events:3'));
    assert.equal(payload.scheduler.sources[0].dropped_events, 3, '/status must keep the per-source count');
    assert.equal(payload.scheduler.dropped_events, 3, '/status.scheduler must aggregate the drop');
    assert.equal(payload.scheduler.degraded_by_drop, 1, '/status.scheduler must count the sources behind it');

    await parts.scheduler.stop({ timeoutMs: 1000 });
  });

  it('clears the reason once a poll is no longer truncated, so health can heal itself', async () => {
    const parts = makeSchedulerParts({
      sources: [createScriptedSource({
        id: 'synthetic.bulk',
        script: [
          Array.from({ length: 5 }, (_unused, index) => makeEvent({ source_seq: index + 1 })),
          [makeEvent({ source_seq: 99 })],
        ],
      })],
      tickMs: 1000,
      maxBatchEvents: 2,
      logger: SILENT_LOGGER,
    });
    parts.scheduler.tick();
    await settle();
    assert.equal(parts.scheduler.sourceStatus('synthetic.bulk').dropped_events, 3);
    assert.equal(computeHealth(healthInputFor(parts.scheduler.status())).status, 'degraded');

    parts.clock.advance(1000);
    parts.scheduler.tick();
    await settle();
    const source = parts.scheduler.sourceStatus('synthetic.bulk');
    assert.equal(source.dropped_events, 0, 'a poll that is not truncated must clear the pending count');
    const healed = computeHealth(healthInputFor(parts.scheduler.status()));
    assert.equal(healed.status, 'ok', 'health must return to ok instead of pinning the daemon degraded forever');
    assert.deepEqual(healed.reasons, []);

    await parts.scheduler.stop({ timeoutMs: 1000 });
  });
});

describe('RC5-N02 · 截断必须记 ERROR（T3）', () => {
  it('logs exactly one error-level line naming the source and the unread counts', async () => {
    const calls = [];
    const logger = {
      level: 'debug',
      debug() {},
      info() {},
      warn(message, fields) {
        calls.push({ level: 'warn', message, fields });
      },
      error(message, fields) {
        calls.push({ level: 'error', message, fields });
      },
      child() {
        return this;
      },
    };
    const events = Array.from({ length: 5 }, (_unused, index) => makeEvent({ source_seq: index + 1 }));
    const parts = makeSchedulerParts({
      sources: [createScriptedSource({ id: 'synthetic.bulk', script: [events] })],
      tickMs: 1000,
      maxBatchEvents: 2,
      logger,
    });
    parts.scheduler.tick();
    await settle();
    await parts.scheduler.stop({ timeoutMs: 1000 });

    const errors = calls.filter((call) => call.level === 'error');
    assert.equal(errors.length, 1, `truncation must be one error line, got ${JSON.stringify(calls.map((call) => call.level))}`);
    const [entry] = errors;
    assert.equal(entry.fields.source_id, 'synthetic.bulk');
    assert.equal(entry.fields.max_batch_events, 2);
    assert.equal(entry.fields.dropped, 3, 'the line must carry this round’s dropped count');
    assert.equal(entry.fields.pending_events, 3, 'the line must carry what still has to be re-read');
    assert.equal(entry.fields.batch_events, 5);
    assert.equal(entry.fields.dropped_this_round, 3);
    assert.equal(
      calls.filter((call) => call.level === 'warn').length,
      0,
      'a silent data-loss condition must not be filed at warn level',
    );
  });
});
