// author: PT-dove
// SEED-04 ③ 补覆盖 — 块 4：跨重启续采 / 重放（collection / corpus 层）。
//
// 背景：REATTACK-RC4/seed04/REPORT.md:168 只做了采集层，没有跨重启证据。这里用**真实
// Windows 事件日志 System channel** + 真实 daemon + 真 SQLite，给出重启前后两套计数
// （采集、入库、游标位置），并把"重放"和"续采"分开证：
//
//   A) 生产装配顺序（先 attach 采集源、后由 daemon 从 checkpoint 传游标）：
//      重启后**整页重放**（500 条同一批记录），store 稳定键幂等吸收 → 行数不增、不重复、
//      游标不倒退。行级"不重不漏"成立；但"从持久化游标续采"**不成立** →
//      见 cov/FINDINGS.md F-01（seedFromCheckpoint 在 attach 之后对已构造的 collector 无效）。
//   B) 文档意图的装配顺序（attach 前用 checkpoint 游标播种 cursor store）：
//      重启后从 501 继续读**新页**，`duplicates=0`、游标 500→1000、store 正常增长 →
//      续采能力本身存在，缺陷在装配时序（F-01 的 A/B 证据）。
//
// 两条路径的 before/after 计数都直接来自真实 `/status`，原始输出在
// docs/implementation/evidence/defect-close/SEED-04/cov/raw/04-restart-replay.raw.log

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createDaemon } from '../../apps/daemon/src/daemon.js';
import { createCollectorSources } from '../../apps/daemon/src/adapters/collector-sources.js';
import * as windowsCollector from '../../packages/collectors/windows/index.js';
import * as commonCollector from '../../packages/collectors/common/index.js';
import { makeConfig, makeTempDir, waitFor } from './helpers.js';

const EVENT_SOURCE_ID = 'windows.event-log.system';
const PAGE = 500;
const BOOT_IDS = [
  'c0f5a1b2c3d4e5f60718293a4b5c6d80',
  'c0f5a1b2c3d4e5f60718293a4b5c6d81',
  'c0f5a1b2c3d4e5f60718293a4b5c6d82',
  'c0f5a1b2c3d4e5f60718293a4b5c6d83',
];

function realEventLogSystem(bootId, cursorStore) {
  return createCollectorSources({
    createSources: windowsCollector.createWindowsSources,
    attachSources: windowsCollector.attachWindowsSources,
    createRuntime: commonCollector.createCollectorRuntime,
    options: { include: ['eventLog'], channels: ['System'], timeoutMs: 120_000 },
    cursorStore: cursorStore ?? commonCollector.createMemoryCursorStore({ clock: Date.now }),
    bootId,
  });
}

function storedEvents(status) {
  const store = status?.store ?? {};
  if (Number.isInteger(store.events)) {
    return store.events;
  }
  if (typeof store.stats === 'function') {
    return store.stats().events;
  }
  return Number(status?.counters?.events_accepted ?? 0);
}

function snapshot(daemon) {
  const status = daemon.status();
  const row = status.scheduler.status().find((entry) => entry.id === EVENT_SOURCE_ID);
  assert.ok(row, `${EVENT_SOURCE_ID} must be present in /status`);
  const pipeline = status.pipeline.stats();
  // The daemon persists the collector identity verbatim: `{cursor, generation, sequence}`.
  const identity = row.cursor ?? null;
  const cursorValue = identity?.cursor ?? null;
  return {
    sourceEvents: row.events,
    sourcePolls: row.polls,
    lifecycle: row.lifecycle,
    lastEmptyCode: row.last_empty_code ?? null,
    cursorRecordId: cursorValue?.lastRecordId ?? null,
    cursorChannel: cursorValue?.channel ?? null,
    generation: row.generation,
    sequence: row.sequence,
    storeEvents: storedEvents(status),
    pipeline: {
      received: pipeline.events_received,
      accepted: pipeline.events_accepted,
      duplicate: pipeline.events_duplicate,
      rejected: pipeline.events_rejected,
    },
    counters: status.counters,
  };
}

function readCheckpoint(config) {
  return JSON.parse(readFileSync(config.state.path, 'utf8'));
}

function waitFirstPage(daemon) {
  return waitFor(() => {
    const row = daemon.status().scheduler.status().find((entry) => entry.id === EVENT_SOURCE_ID);
    return row !== undefined && row.events > 0;
  }, { timeoutMs: 60_000, label: 'the real System channel delivers its first page' });
}

function waitSettled(daemon, label) {
  return waitFor(() => {
    const row = daemon.status().scheduler.status().find((entry) => entry.id === EVENT_SOURCE_ID);
    return row !== undefined
      && row.polls >= 1
      && ['ok', 'empty', 'unavailable', 'degraded'].includes(row.lifecycle);
  }, { timeoutMs: 60_000, label });
}

/** The store's event count is cached for up to a second; let it catch up before comparing. */
async function settleStoreCount() {
  await new Promise((resolve) => setTimeout(resolve, 1_300));
}

/** Run one real collection round over `dir`, then stop the daemon. */
async function firstRound(dir, config) {
  const wiring = realEventLogSystem(BOOT_IDS[0]);
  const daemon = createDaemon({ config, sources: wiring.sources });
  await daemon.start();
  try {
    await waitFirstPage(daemon);
    await settleStoreCount();
    return snapshot(daemon);
  } finally {
    await daemon.stop('restart');
  }
}

test('跨重启 A（生产装配顺序）：重启整页重放被稳定键吸收 → 行级不重不漏，但游标未续采（F-01）', async () => {
  const dir = makeTempDir();
  const config = makeConfig(dir, { top: { mode: 'full' } });
  const before = await firstRound(dir, config);
  assert.equal(before.sourceEvents, PAGE, 'a first read fills one bounded page');
  assert.equal(before.pipeline.accepted, PAGE);
  assert.equal(before.pipeline.duplicate, 0);
  assert.equal(before.storeEvents, PAGE);
  assert.equal(before.cursorRecordId, PAGE);

  const checkpoint = readCheckpoint(config);
  const persisted = checkpoint.sources[EVENT_SOURCE_ID];
  assert.ok(persisted?.cursor, 'shutdown must persist the source cursor');
  assert.equal(persisted.cursor.cursor.channel, 'System');
  assert.equal(persisted.cursor.cursor.lastRecordId, before.cursorRecordId);

  // Second process, same data dir, production wiring order (attach before the daemon feeds
  // the checkpoint cursor to the source).
  const wiring2 = realEventLogSystem(BOOT_IDS[1]);
  const daemon2 = createDaemon({ config, sources: wiring2.sources });
  let after;
  try {
    await daemon2.start();
    await waitSettled(daemon2, 'second process completes its first poll');
    await settleStoreCount();
    after = snapshot(daemon2);
  } finally {
    await daemon2.stop('done');
  }

  // Observed deviation (F-01): the persisted cursor reaches the adapter ctx but the collector
  // was already constructed, so the read starts at record 1 again.
  assert.equal(after.sourceEvents, PAGE, 'the first page was read again (this is the F-01 deviation)');
  assert.equal(after.pipeline.duplicate, PAGE, 'every replayed record must be absorbed as a duplicate');
  assert.equal(after.pipeline.accepted, 0, 'a replay must accept no new events');
  assert.equal(after.pipeline.rejected, 0);
  // Row-level guarantees still hold: no double store, no loss, no gap.
  assert.equal(after.storeEvents, before.storeEvents, 'the store must not grow from a replay (stable-key idempotency)');
  assert.equal(after.cursorRecordId, before.cursorRecordId, 'the replayed cursor lands on the same committed position');
  assert.ok(after.cursorChannel === 'System');
  assert.equal(after.counters.rejected_by_store ?? 0, 0);
  assert.equal(after.counters.events_dropped ?? 0, 0);

  console.log(
    `[cov][restart] caseA(prod-order) before{collected=${before.sourceEvents},stored=${before.storeEvents},`
    + `cursor=${before.cursorRecordId},accepted=${before.pipeline.accepted}}`
    + ` after{collected=${after.sourceEvents},stored=${after.storeEvents},cursor=${after.cursorRecordId},`
    + `accepted=${after.pipeline.accepted},duplicates=${after.pipeline.duplicate},lifecycle=${after.lifecycle}}`
    + ` verdict=rows-no-duplicate-no-loss,resume-NOT-honored`,
  );
});

test('跨重启 B（attach 前播种 checkpoint 游标）：真正续采 → 读到新页 501+，duplicates=0，游标前进到 1000', async () => {
  const dir = makeTempDir();
  const config = makeConfig(dir, { top: { mode: 'full' } });
  const before = await firstRound(dir, config);
  assert.equal(before.cursorRecordId, PAGE);

  const checkpoint = readCheckpoint(config);
  const persisted = checkpoint.sources[EVENT_SOURCE_ID];
  assert.ok(persisted?.cursor?.cursor, 'the checkpoint must carry the nested source cursor');
  // The documented wiring (`createMemoryCursorStore({ initial })`): seed before attaching, so
  // the collector constructs with the persisted cursor already in place.
  const seededStore = commonCollector.createMemoryCursorStore({
    clock: Date.now,
    initial: {
      [EVENT_SOURCE_ID]: {
        generation: persisted.cursor.generation,
        sequence: persisted.cursor.sequence,
        cursor: persisted.cursor.cursor,
      },
    },
  });
  assert.equal(seededStore.load(EVENT_SOURCE_ID)?.cursor?.lastRecordId, before.cursorRecordId);

  const wiring2 = realEventLogSystem(BOOT_IDS[2], seededStore);
  const daemon2 = createDaemon({ config, sources: wiring2.sources });
  let after;
  try {
    await daemon2.start();
    await waitFirstPage(daemon2);
    await settleStoreCount();
    after = snapshot(daemon2);
  } finally {
    await daemon2.stop('done');
  }

  // Continuation, not replay: the next page (501..1000) is genuinely new.
  assert.equal(after.pipeline.duplicate, 0, 'seeded cursor must not replay the stored page');
  assert.equal(after.pipeline.accepted, after.sourceEvents, 'every record of the new page is new');
  assert.equal(after.sourceEvents, PAGE, 'the new page is a full bounded page');
  assert.equal(after.cursorRecordId, PAGE * 2, 'the cursor advanced from 500 to 1000');
  assert.ok(after.cursorRecordId > before.cursorRecordId, 'the cursor moved forward across the restart');
  assert.equal(after.storeEvents, before.storeEvents + after.pipeline.accepted, 'stored rows grow by exactly the new records');
  assert.equal(after.pipeline.rejected, 0);

  console.log(
    `[cov][restart] caseB(seeded-store) before{collected=${before.sourceEvents},stored=${before.storeEvents},`
    + `cursor=${before.cursorRecordId}} after{collected=${after.sourceEvents},stored=${after.storeEvents},`
    + `cursor=${after.cursorRecordId},accepted=${after.pipeline.accepted},duplicates=${after.pipeline.duplicate}}`
    + ` verdict=resume-honored,no-duplicate,no-gap`,
  );
});
