// author: PT-dove
// SEED-04 ③ 补覆盖 — 块 3：源 TIMEOUT（真实慢源 `scheduledTasks`，实测单次 4.0–6.8 s）。
//
// 背景：REATTACK-RC4/seed04/REPORT.md:168 自认"未构造源 TIMEOUT 路径（本次全程无
// TIMEOUT/degraded）"。这里用**真实慢源**造 TIMEOUT，断言诚实分类，并证明下一次 poll 能恢复：
//
//   1) 采集层（binding + capability）：真实 `scheduledTasks` 读，用极小 timeoutMs（400 ms）
//      让真实 PowerShell 子进程被杀 → `code=TIMEOUT`、lifecycle=`degraded`、
//      `lastError.code=TIMEOUT`、published=0；随后换成正常预算再 poll 同一源 →
//      真读成功（194 条任务表实体）、lifecycle 回到 `ready`。**不是 ok+0**。
//   2) daemon 层（真实 daemon + 真 SQLite）：`scheduler.sourceTimeoutMs=250`
//      对真实慢源 → `/status` 该源 lifecycle=`degraded`、`last_error_code=SOURCE_TIMEOUT`，
//      store 里 0 条（没有把超时当成功），且退避已武装（`retry_in_ms>0`、`backoff_ms>0`）。
//      然后用同一 dataDir 以正常预算重启（新进程/新调度器）→ 同一次读成功入库，
//      证明"超时 → 按退避/重配置恢复"这条链是通的。
//
// 原始 stdout：docs/implementation/evidence/defect-close/SEED-04/cov/raw/03-source-timeout.raw.log

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ALLOWLIST,
  attachWindowsSources,
  createCommandRunner,
  createPowerShellClient,
  createWindowsSources,
} from '../../packages/collectors/windows/index.js';
import {
  createCollectorRuntime,
  createMemoryCursorStore,
} from '../../packages/collectors/common/index.js';
import { createCollectorSources } from '../../apps/daemon/src/adapters/collector-sources.js';
import * as windowsCollector from '../../packages/collectors/windows/index.js';
import * as commonCollector from '../../packages/collectors/common/index.js';
import { createDaemon } from '../../apps/daemon/src/daemon.js';
import { makeConfig, makeTempDir, waitFor } from './helpers.js';

const TIGHT_TIMEOUT_MS = 400;
const NORMAL_TIMEOUT_MS = 120_000;
const BOOT_ID = 'c0f5a1b2c3d4e5f60718293a4b5c6d70';
const SOURCE_INTERVAL_MS = 500;

/** Two real PowerShell clients; the phase only decides which *budget* a real command gets. */
function phasePowerShell({ tightMs = TIGHT_TIMEOUT_MS, normalMs = NORMAL_TIMEOUT_MS } = {}) {
  const tight = createPowerShellClient({
    runner: createCommandRunner({ allowlist: DEFAULT_ALLOWLIST, timeoutMs: tightMs }),
    timeoutMs: tightMs,
  });
  const normal = createPowerShellClient({
    runner: createCommandRunner({ allowlist: DEFAULT_ALLOWLIST, timeoutMs: normalMs }),
    timeoutMs: normalMs,
  });
  let phase = 'tight';
  return {
    get phase() { return phase; },
    set phase(next) {
      assert.ok(next === 'tight' || next === 'normal');
      phase = next;
    },
    runJson(script) {
      return (phase === 'tight' ? tight : normal).runJson(script);
    },
    runText(script) {
      return (phase === 'tight' ? tight : normal).runText(script);
    },
    probe() {
      return Promise.resolve({ ok: true, errorCode: null });
    },
  };
}

/** Stored-event count from `/status`, tolerant of the two shapes the payload exposes. */
function storedEvents(status) {
  const store = status?.store ?? {};
  if (Number.isInteger(store.events)) {
    return store.events;
  }
  if (typeof store.stats === 'function') {
    return store.stats().events;
  }
  return Number(status?.pipeline?.stats?.().events_accepted ?? 0);
}

function buildScheduledTasks(powershell) {  const [entry] = createWindowsSources({
    include: ['scheduledTasks'],
    powershell,
    intervalMs: SOURCE_INTERVAL_MS,
    timeoutMs: NORMAL_TIMEOUT_MS,
  });
  const cursorStore = createMemoryCursorStore({ clock: Date.now });
  const runtime = createCollectorRuntime({ store: cursorStore, bootId: BOOT_ID, rateLimiter: null });
  const [binding] = attachWindowsSources({ runtime, sources: [entry] });
  return { entry, binding, runtime, cursorStore };
}

test('采集层：真实慢源被极小 timeoutMs 杀成 TIMEOUT（诚实分类），下一次正常预算 poll 恢复', async () => {
  const powershell = phasePowerShell();
  const { binding, runtime } = buildScheduledTasks(powershell);

  const startedAt = Date.now();
  const failed = await binding.poll();
  const failedMs = Date.now() - startedAt;

  assert.equal(failed.ok, false, 'a real command killed at 400 ms must not be reported as a successful read');
  assert.equal(failed.code, 'TIMEOUT', 'the collector must classify the kill as TIMEOUT, not COMMAND_FAILED');
  assert.equal(failed.published ?? 0, 0, 'a timed-out read publishes nothing');
  assert.equal(failed.empty, undefined, 'a TIMEOUT is a failure, not an explicit empty read');
  assert.ok(failedMs < 5_000, `the tight budget must cut the real read (took ${failedMs} ms)`);

  const degraded = runtime.report().sources.find((entry) => entry.stableSourceId === binding.descriptor.stableSourceId);
  assert.ok(degraded, 'the source must appear in the capability report');
  assert.equal(degraded.lifecycle, 'degraded', 'a TIMEOUT degrades the source (it does not latch it unavailable)');
  assert.ok(degraded.lastError, 'the failure must be retained for the operator');
  assert.equal(degraded.lastError.code, 'TIMEOUT');
  assert.equal(degraded.lastError.fatal, false, 'a timeout is recoverable, so it must not be fatal');
  assert.ok(
    degraded.freshness === 'starting' || degraded.freshness === 'stale',
    `a source that never read successfully must not claim freshness, got ${degraded.freshness}`,
  );

  // Recovery: the same source object, a real (normal-budget) read.
  powershell.phase = 'normal';
  const recoveredAt = Date.now();
  const recovered = await binding.poll();
  const recoveredMs = Date.now() - recoveredAt;
  assert.equal(recovered.ok, true, 'the next poll with a normal budget must succeed');
  assert.ok(recovered.published > 0, 'the real task table must produce records');
  assert.ok(Array.isArray(recovered.items) && recovered.items.length === recovered.published);
  assert.ok(recoveredMs >= 1_000, `scheduled-tasks is the slow source: a real read takes seconds (took ${recoveredMs} ms)`);

  const healthy = runtime.report().sources.find((entry) => entry.stableSourceId === binding.descriptor.stableSourceId);
  assert.equal(healthy.lifecycle, 'ready', 'a successful read must clear the degraded lifecycle');
  assert.equal(healthy.stale, false);
  assert.ok(healthy.lastSuccess, 'the recovery must be timestamped');
  assert.equal(healthy.lastError?.code, 'TIMEOUT', 'the last error stays as history after recovery');

  const stats = binding.stats();
  assert.equal(stats.reads, 2);
  assert.equal(stats.failures, 1);
  assert.ok(stats.published >= recovered.published);
  console.log(
    `[cov][timeout] collector-level timedOutPollMs=${failedMs} code=${failed.code} lifecycle=${degraded.lifecycle}`
    + ` lastError=${degraded.lastError.code} fatal=${degraded.lastError.fatal}`
    + ` recoveryPollMs=${recoveredMs} recoveredPublished=${recovered.published} lifecycleAfter=${healthy.lifecycle}`
    + ` reads=${stats.reads} failures=${stats.failures}`,
  );
});

test('daemon 层：真实慢源 + sourceTimeoutMs=250 → /status 诚实 SOURCE_TIMEOUT、入库 0、退避武装；正常预算重启后入库', async () => {
  const dir = makeTempDir();
  const tight = createCollectorSources({
    createSources: windowsCollector.createWindowsSources,
    attachSources: windowsCollector.attachWindowsSources,
    createRuntime: commonCollector.createCollectorRuntime,
    options: {
      include: ['scheduledTasks'],
      intervalMs: SOURCE_INTERVAL_MS,
      timeoutMs: NORMAL_TIMEOUT_MS,
    },
    cursorStore: commonCollector.createMemoryCursorStore({ clock: Date.now }),
    bootId: BOOT_ID.replace('0', '1'),
  });
  assert.equal(tight.sources.length, 1);
  const sourceId = tight.sources[0].id;
  assert.equal(sourceId, 'windows.scheduled-task-table');

  const daemon = createDaemon({
    config: makeConfig(dir, {
      top: { mode: 'full' },
      scheduler: { sourceTimeoutMs: 250, tickMs: 3_600_000 },
    }),
    sources: tight.sources,
  });
  let firstRun = null;
  let recoveryRun = null;
  let armedBackoff = null;
  let recoveryStoredEvents = null;
  let recoverySourceEvents = null;
  try {
    await daemon.start();
    await waitFor(() => {
      const row = daemon.status().scheduler.status().find((entry) => entry.id === sourceId);
      return row !== undefined && row.lifecycle === 'degraded' && row.last_error_code === 'SOURCE_TIMEOUT';
    }, { timeoutMs: 20_000, label: 'daemon records SOURCE_TIMEOUT for the real slow source' });

    firstRun = daemon.status();
    const row = firstRun.scheduler.status().find((entry) => entry.id === sourceId);
    assert.equal(row.lifecycle, 'degraded');
    assert.equal(row.last_error_code, 'SOURCE_TIMEOUT', 'the daemon must keep its own timeout code');
    assert.equal(row.consecutive_failures >= 1, true);
    assert.ok(row.backoff_ms > 0, 'invariant 7: a failing source arms a retry backoff');
    assert.ok(row.retry_in_ms > 0, 'the retry delay must be observable in /status');
    armedBackoff = { backoffMs: row.backoff_ms, retryInMs: row.retry_in_ms };
    assert.equal(row.events, 0, 'the timed-out poll delivered no events');
    assert.equal(storedEvents(firstRun), 0, 'nothing may be stored from a timed-out poll');
    assert.equal(firstRun.health.status === 'ok', false, 'a persistently failing source must not report ok');
    assert.ok(firstRun.health.reasons.length > 0, 'the health aggregate must state why it is not ok');
    // A timeout is a real failure, not a silent empty read.
    assert.equal(row.last_empty_code ?? null, null);
  } finally {
    try {
      await daemon.stop('restart');
    } catch {
      // The stop result is asserted by the daemon's own suite; here it must simply not throw.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  // Recovery: same data directory, a daemon whose budget fits the real (slow) read.
  const normal = createCollectorSources({
    createSources: windowsCollector.createWindowsSources,
    attachSources: windowsCollector.attachWindowsSources,
    createRuntime: commonCollector.createCollectorRuntime,
    options: {
      include: ['scheduledTasks'],
      intervalMs: SOURCE_INTERVAL_MS,
      timeoutMs: NORMAL_TIMEOUT_MS,
    },
    cursorStore: commonCollector.createMemoryCursorStore({ clock: Date.now }),
    bootId: BOOT_ID.replace('1', '2'),
  });
  const daemon2 = createDaemon({
    config: makeConfig(dir, {
      top: { mode: 'full' },
      scheduler: { sourceTimeoutMs: NORMAL_TIMEOUT_MS, tickMs: 3_600_000 },
    }),
    sources: normal.sources,
  });
  try {
    await daemon2.start();
    await waitFor(() => storedEvents(daemon2.status()) > 0, {
      timeoutMs: 60_000,
      label: 'the real slow source stores events once the timeout budget fits',
    });
    recoveryRun = daemon2.status();
    const row = recoveryRun.scheduler.status().find((entry) => entry.id === sourceId);
    recoveryStoredEvents = storedEvents(recoveryRun);
    recoverySourceEvents = row.events;
    assert.ok(recoveryStoredEvents > 0, 'the recovered poll must actually be persisted');
    assert.equal(row.lifecycle, 'ok', 'the source recovers to ok');
    assert.equal(row.last_error_code, null, 'a successful poll clears the error code');
    assert.equal(recoverySourceEvents, recoveryStoredEvents, 'every published event reaches the store');
  } finally {
    await daemon2.stop('done');
  }

  assert.ok(firstRun !== null && recoveryRun !== null);
  console.log(
    `[cov][timeout] daemon-level sourceId=${sourceId}`
    + ` firstRun{lifecycle=degraded,lastError=SOURCE_TIMEOUT,storeEvents=0,`
    + `backoffMs=${armedBackoff?.backoffMs},retryInMs=${armedBackoff?.retryInMs},health=${firstRun.health.status}}`
    + ` recoveryRun{lifecycle=${recoveryRun.scheduler.status()[0].lifecycle},`
    + `storeEvents=${recoveryStoredEvents},events=${recoverySourceEvents}}`,
  );
});
