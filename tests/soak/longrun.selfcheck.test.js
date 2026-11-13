/**
 * longrun.selfcheck.test.js — 证明 longrun 的判据**能失败**。
 *
 * 为什么必须有这个文件：
 * 1 小时冒烟与 3 分钟变异跑都凑不出 3 个小时基线，所以三项漂移判据在真实短跑里
 * 只会是「未评估」。如果只做真实跑，「漂移判据能不能红」就永远没人证明过——
 * 那正是 M9 反复出现的「判据看着绿、其实是恒真」。
 *
 * 这里把**合成采样序列**直接喂给 `analyze()`：先把一组平坦序列跑成 pass，
 * 再逐项注入一种退化，断言对应判据转红。每一步都断言「特定 id 出现在 failures 里」，
 * 而不是断言「整体不是 pass」——后者会被别的判据的噪声满足，等于没测。
 *
 * 运行：node --test tests/soak/longrun.selfcheck.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { HOUR_MS, analyze } from './longrun.mjs';

const MIB = 1024 * 1024;

/**
 * 造一组采样。
 *
 * 数据形态刻意贴近真实分片：字段名与 `longrun.mjs` 写出去的一致，
 * 这样自检覆盖的是**判据读的那些字段**，不是自造的另一种形状。
 *
 * @param {object} [options] 选项。
 * @returns {{result: object, samples: object[], hours: object[], osProbe: object|null, endedAtMs: number}} 输入与判定。
 */
function buildRun(options = {}) {
  const hoursCount = options.hours ?? 4;
  const sampleMs = options.sampleMs ?? 60_000;
  const tickMs = options.tickMs ?? 1000;
  const batchSize = options.batchSize ?? 1;
  const rssPerHourMib = options.rssPerHourMib ?? 0;
  const handleAt = options.handleAt ?? (() => 9);
  const threadAt = options.threadAt ?? null;
  const pollFactor = options.pollFactor ?? 1;
  const dropAt = options.dropAt ?? null;
  const missingHours = new Set(options.missingHours ?? []);
  const freezeChanged = options.freezeChanged ?? 0;
  const startedAtMs = Date.UTC(2026, 10, 4, 0, 0, 0);
  const perHour = Math.round(HOUR_MS / sampleMs);

  const samples = [];
  const hours = [];
  const threadBuckets = new Map();
  let index = 0;

  for (let hour = 0; hour < hoursCount; hour += 1) {
    if (missingHours.has(hour) === false) {
      const libuv = handleAt(hour);
      for (let slot = 0; slot < perHour; slot += 1) {
        if (dropAt !== null && hour === dropAt.hour && slot >= dropAt.from && slot < dropAt.to) {
          continue;
        }
        const tMs = hour * HOUR_MS + slot * sampleMs;
        // poll 与事件都按 tick 派生：1 次 poll 产 1 批。pollFactor<1 时两者同步缩水，
        // 这正是「调度器罢工」在数据里的样子。
        const polls = Math.floor((tMs / tickMs) * pollFactor);
        const events = polls * batchSize;
        samples.push({
          k: 's',
          i: index,
          seg: 0,
          hour,
          t_ms: tMs,
          elapsed_s: Number((tMs / 1000).toFixed(2)),
          rss_bytes: Math.round((100 + rssPerHourMib * hour) * MIB),
          active_resources: 4,
          wal_bytes: 4 * MIB,
          db_bytes: 60 * MIB,
          events_received: events,
          events_accepted: events,
          adj_events_received: events,
          adj_events_accepted: events,
          adj_alerts_written: 1,
          adj_polls: polls,
          dropped_events: 0,
          source_failures: 0,
          store_events: events,
          health_status: 'ok',
          lifecycle: 'running',
          // 2 ms ± 抖动：平坦序列，延迟判据应当通过。
          probe_latency_ms: Number((2 + ((index * 7) % 5) * 0.1).toFixed(3)),
          libuv_handles: libuv,
          os_threads: null,
        });
        index += 1;
      }
      hours.push({
        k: 'h',
        hour,
        closed_at: new Date(startedAtMs + (hour + 1) * HOUR_MS).toISOString(),
        reason: 'boundary',
        samples: perHour,
        libuv_handles: libuv,
        freeze_changed: 0,
        adj_polls: Math.floor(((hour + 1) * HOUR_MS / tickMs) * pollFactor),
        adj_events_received: index,
      });
    }
    if (threadAt !== null) {
      threadBuckets.set(hour, { handles: [handleAt(hour)], threads: [threadAt(hour)] });
    }
  }

  const osProbe = threadAt === null
    ? null
    : { byHour: threadBuckets, count: hoursCount, source: 'selfcheck-synthetic', error: null };

  const plan = {
    hours: hoursCount,
    sample_ms: sampleMs,
    tick_ms: tickMs,
    batch_size: batchSize,
    seed: 20261102,
    started_at_ms: startedAtMs,
    started_at_iso: new Date(startedAtMs).toISOString(),
    end_at_ms: startedAtMs + hoursCount * HOUR_MS,
  };
  const freeze = {
    root: 'D:/AIUSE/_soak-freeze/selfcheck',
    created_at: new Date(startedAtMs).toISOString(),
    file_count: 200,
    total_bytes: 4_000_000,
    manifest_sha256: 'a'.repeat(64),
    code_digest: 'b'.repeat(64),
    code_files: 55,
    code_bytes: 766_357,
  };
  const freezeNow = {
    changed_files: Array.from({ length: freezeChanged }, (unused, at) => `apps/daemon/src/f${at}.js`),
    missing: 0,
    code_digest: freezeChanged === 0 ? freeze.code_digest : 'c'.repeat(64),
    code_files: 55,
    code_bytes: 766_357,
    manifest_sha256: freeze.manifest_sha256,
  };
  const lastSample = samples[samples.length - 1];
  const endedAtMs = startedAtMs + hoursCount * HOUR_MS;

  const result = analyze({
    samples,
    hours,
    segments: [{ index: 0, active_ms: hoursCount * HOUR_MS, samples: samples.length }],
    plan,
    freeze,
    freezeNow,
    finalBody: {
      lifecycle: 'running',
      health: { status: 'ok' },
      store: { events: lastSample.adj_events_accepted },
    },
    storePragmas: { page_size: 4096, wal_autocheckpoint: 1000 },
    diskFreeBytes: 10 * 1024 * MIB,
    badLines: 0,
    osProbe,
    endedAtMs,
  });
  return { result, samples, hours, plan };
}

/**
 * 断言某条判据**在失败集里**。
 *
 * @param {object} result 判定。
 * @param {string} id 判据 id。
 * @returns {void}
 */
function assertFailed(result, id) {
  const item = result.checks.find((check) => check.id === id);
  assert.ok(item !== undefined, `${id} 不存在`);
  assert.equal(item.deferred, undefined, `${id} 被判为未评估，无法证明它能红`);
  assert.equal(item.passed, false, `${id} 没有转红（actual=${JSON.stringify(item.actual)}）`);
  assert.ok(result.failures.includes(id), `${id} 不在 failures 里`);
}

/**
 * 断言某条判据**未评估**（数据不足时的正确形态：既不是 pass 也不是 fail）。
 *
 * @param {object} result 判定。
 * @param {string} id 判据 id。
 * @returns {void}
 */
function assertDeferred(result, id) {
  const item = result.checks.find((check) => check.id === id);
  assert.ok(item !== undefined, `${id} 不存在`);
  assert.equal(item.deferred, true, `${id} 应当记未评估`);
  assert.ok(result.deferred.includes(id), `${id} 不在 deferred 里`);
  assert.ok(!result.failures.includes(id), `${id} 不应当计入失败`);
}

test('基线：平坦序列应当整体 pass（否则后面的「转红」没有意义）', () => {
  const { result } = buildRun();
  assert.deepEqual(result.failures, [], `基线不该有失败项：${result.failures.join(', ')}`);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.checks.length, 26, '判据条数变化时需要同步更新自检');
});

test('内存基线漂移：每小时 +30 MiB 必须红', () => {
  const { result } = buildRun({ rssPerHourMib: 30 });
  assertFailed(result, 'longrun.memory_baseline_drift');
  // 同一条退化也应当被「首末段中位数」那条抓到：两个口径互补，不是互相替代。
  assertFailed(result, 'longrun.rss_bounded');
});

test('句柄基线漂移：libuv 句柄 9 → 200 必须红', () => {
  const { result } = buildRun({ handleAt: (hour) => (hour === 0 ? 9 : 9 + hour * 60) });
  assertFailed(result, 'longrun.handle_baseline_drift');
});

test('线程基线漂移：OS 线程 12 → 40 必须红（走外部采样）', () => {
  const { result } = buildRun({ threadAt: (hour) => 12 + hour * 10 });
  assertFailed(result, 'longrun.thread_baseline_drift');
});

test('线程轴没有外部采样时必须记未评估，不许判 pass', () => {
  const { result } = buildRun({ threadAt: null });
  assertDeferred(result, 'longrun.thread_baseline_drift');
  assert.equal(result.verdict, 'pass', '未评估不应把整体判红，但它也绝不是 pass 的那一条');
});

test('poll 罢工：实际 poll 只有应有的 1/5 必须红（变异测试的判据锚点）', () => {
  const { result } = buildRun({ pollFactor: 0.2 });
  assertFailed(result, 'longrun.polls_match_target');
  assertFailed(result, 'longrun.rate_matches_target');
});

test('采样中断：丢掉 10 个连续采样点必须红', () => {
  const { result } = buildRun({ dropAt: { hour: 1, from: 10, to: 20 } });
  assertFailed(result, 'longrun.sampling_continuity');
});

test('分片缺失：少一个小时的分片必须红', () => {
  const { result } = buildRun({ missingHours: [2] });
  assertFailed(result, 'longrun.hour_shards_complete');
});

test('小时数不足：漂移判据记未评估而不是 pass', () => {
  const { result } = buildRun({ hours: 2 });
  assertDeferred(result, 'longrun.memory_baseline_drift');
  assertDeferred(result, 'longrun.handle_baseline_drift');
  assertDeferred(result, 'longrun.thread_baseline_drift');
});

test('冻结副本被改：必须红（这正是把「仓库静止」换成「副本字节不变」的那条）', () => {
  const { result } = buildRun({ freezeChanged: 2 });
  assertFailed(result, 'longrun.freeze_bytes_unchanged');
});

test('API 延迟退化：末段 p90 超过 250 ms 常量上限必须红', () => {
  const { result } = buildRun();
  // 手工把末段延迟顶上去，验证「常量阈值」而不是「首段 5 倍」在起作用。
  const samples = result;
  void samples;
  const shifted = buildRun();
  const tail = shifted.samples.slice(-Math.floor(shifted.samples.length / 3));
  for (const sample of tail) {
    sample.probe_latency_ms = 400;
  }
  const rerun = analyze({
    samples: shifted.samples,
    hours: shifted.hours,
    segments: [{ index: 0, active_ms: 4 * HOUR_MS, samples: shifted.samples.length }],
    plan: shifted.plan,
    freeze: {
      root: 'x', created_at: '', file_count: 1, total_bytes: 1,
      manifest_sha256: 'a'.repeat(64), code_digest: 'b'.repeat(64), code_files: 55, code_bytes: 1,
    },
    freezeNow: {
      changed_files: [], missing: 0, code_digest: 'b'.repeat(64),
      code_files: 55, code_bytes: 1, manifest_sha256: 'a'.repeat(64),
    },
    finalBody: { lifecycle: 'running', health: { status: 'ok' }, store: { events: 1e9 } },
    storePragmas: { page_size: 4096, wal_autocheckpoint: 1000 },
    diskFreeBytes: 10 * 1024 * MIB,
    badLines: 0,
    osProbe: null,
    endedAtMs: shifted.plan.started_at_ms + 4 * HOUR_MS,
  });
  assertFailed(rerun, 'longrun.api_latency_stable');
});
