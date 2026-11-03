/**
 * self-check.test.js — 基准工具自身的自检。
 *
 * 为什么需要这个文件：一个测错的基准比没有基准更糟，因为它会给出"通过"。
 * 这里只验证**工具**的可证伪性，不验证被测代码：
 *
 * 1. 种子可复现（同种子同序列、异种子异序列、子流互不干扰）；
 * 2. 分位数是精确秩，不是分桶（用能区分两种实现的样本）；
 * 3. 趋势拟合在已知直线上给出已知斜率（否则浸泡的"泄漏"结论没有意义）；
 * 4. 路径守卫真的拒绝仓库路径（这是最危险的一条：写错就会动真实数据）；
 * 5. 负载生成器产出的对象能通过契约校验，且 id 不重复；
 * 6. 门禁判定能被失败触发（warn 不阻断、blocker 阻断）；
 * 7. 并发判据"可证伪且期望恒定"：重复采样取中位数/方差、比值边界、缺档必判失败，
 *    以及**回归用例**——期望文本不得随实测值变化（旧实现用 `Math.max(...sweep)` 派生
 *    expected，刹车后判据静默换了度量对象）。这一组用例不需要启动 daemon。
 * 8. 认证限流判据"回退必红"（H-1）：先把合成样本喂给纯函数（旧行为 429×4 必须失败、
 *    缺时点必须失败），再用**真实 HTTP + 真实 `createAuthGuard`** 跑一遍正常顺序（必须绿）、
 *    跑一遍复刻的旧顺序（必须红）、跑一遍"删掉限流"（必须红）。最后两条是防"断言本身
 *    假通过"的关键：没有它们，判据可以写成恒真而测试照样全绿。
 *
 * 运行：`node --test tests/bench/self-check.test.js`
 * 未挂进 `npm test`：根 `package.json` 不在本任务可改范围。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createAuthGuard, readBearer, safeEqual } from '../../apps/daemon/src/api/auth.js';
import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { validateTelemetryEvent } from '../../packages/contracts/src/index.js';
import {
  LOCKOUT_PROBE_OFFSETS_MS,
  LOCKOUT_PROBE_SPAN_MS,
  LOCKOUT_PROBE_WRONG_BURST,
  MIN_THROTTLE_OBSERVATIONS,
  evaluateAuthDefaults,
  evaluateAuthLockoutProbe,
  evaluateGuessThrottle,
  evaluateRotatingTokenQuota,
  lockoutProbeExpectation,
  runAuthLockoutProbe,
  runRotatingTokenProbe,
} from './lib/auth-lockout.js';
import {
  CONCURRENCY_LEVELS,
  MIN_PER_WORKER,
  REPEATS,
  aggregateRepeatSamples,
  evaluateMeasurementStability,
  evaluateScaling,
  perLevelRequests,
  runConcurrencySweep,
  scalingExpectation,
} from './lib/concurrency.js';
import { REPO_ROOT } from './lib/env.js';
import { createRng, deriveSeed } from './lib/prng.js';
import { addCheck, evaluateChecks, RESULT_SCHEMA } from './lib/report.js';
import { linearTrend, median, percentile, sortedCopy, summarize, windowCompare } from './lib/stats.js';
import { createWorkload, workloadDigest } from './lib/synthetic.js';
import { assertHarmlessPath, createTempRoot, isInside, realpathLoose } from './lib/tempdir.js';

describe('prng', () => {
  it('same seed produces the same sequence', () => {
    const first = createRng(12345);
    const second = createRng(12345);
    const left = Array.from({ length: 64 }, () => first.next());
    const right = Array.from({ length: 64 }, () => second.next());
    assert.deepEqual(left, right);
  });

  it('different seeds produce different sequences', () => {
    const first = createRng(1);
    const second = createRng(2);
    const left = Array.from({ length: 32 }, () => first.next());
    const right = Array.from({ length: 32 }, () => second.next());
    assert.notDeepEqual(left, right);
  });

  it('derived sub-streams are independent of each other', () => {
    const seed = 424242;
    const a = createRng(deriveSeed(seed, 'event-store'));
    const b = createRng(deriveSeed(seed, 'detection'));
    const left = Array.from({ length: 16 }, () => a.next());
    const right = Array.from({ length: 16 }, () => b.next());
    assert.notDeepEqual(left, right, 'sub-streams must not be identical');
    // 有内容的两条性质：同一标签在不同基准种子下不同；标签末尾多一个空格也不同。
    assert.notEqual(deriveSeed(1, 'detection'), deriveSeed(2, 'detection'));
    assert.notEqual(deriveSeed(seed, 'detection'), deriveSeed(seed, 'detection '));
  });

  it('uuid() returns canonical v4 shape and stays unique', () => {
    const rng = createRng(7);
    const seen = new Set();
    for (let index = 0; index < 500; index += 1) {
      const value = rng.uuid();
      assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      seen.add(value);
    }
    assert.equal(seen.size, 500);
  });
});

describe('stats', () => {
  it('percentile is exact rank, not histogram buckets', () => {
    // 100 个样本：1..99 都是 1，最后一个 1000。分桶实现会把 p99 抹成 1。
    const values = [...Array.from({ length: 99 }, () => 1), 1000];
    const sorted = sortedCopy(values);
    assert.equal(percentile(sorted, 50), 1);
    assert.equal(percentile(sorted, 99), 1);
    assert.equal(percentile(sorted, 100), 1000);
    assert.equal(summarize(values).max, 1000);
    assert.equal(summarize(values).p99, 1, 'p99 of 100 samples with one outlier is the 99th value');
  });

  it('summarize reports null (not zero) for an empty sample', () => {
    const summary = summarize([]);
    assert.equal(summary.count, 0);
    assert.equal(summary.p99, null);
    assert.equal(summary.mean, null);
    assert.equal(summary.max, null);
  });

  it('median handles even and odd lengths', () => {
    assert.equal(median(sortedCopy([3, 1, 2])), 2);
    assert.equal(median(sortedCopy([4, 1, 3, 2])), 2.5);
  });

  it('linearTrend recovers a known slope', () => {
    // y = 2x + 10，x 以分钟计。
    const points = [0, 1, 2, 3, 4].map((minute) => ({ t_ms: minute * 60000, y: 2 * minute + 10 }));
    const trend = linearTrend(points);
    assert.ok(trend !== null);
    assert.equal(trend.slope_per_minute, 2);
    assert.equal(trend.r2, 1);
    assert.equal(trend.n, 5);
  });

  it('windowCompare detects growth and rejects short series', () => {
    const flat = windowCompare([10, 10, 10, 10, 10, 10, 10, 10, 10]);
    assert.equal(flat.delta, 0);
    const growing = windowCompare([10, 10, 10, 20, 20, 20, 30, 30, 30]);
    assert.ok(growing.delta > 0);
    assert.equal(windowCompare([1, 2]).first_median, null);
  });

  it('windowCompare misses "grow then plateau" — the soak has to cover it separately', () => {
    // 这正是"首末段对比"的盲区：涨完之后的点才进首段，所以 delta ≈ 0。
    // 记录成用例，是为了让"soak.rss_peak_bounded 必须存在"这条设计不被后人删掉。
    const growThenFlat = [10, 40, 40, 40, 40, 40, 40, 40, 40];
    const compared = windowCompare(growThenFlat);
    assert.equal(compared.delta, 0);
    assert.equal(compared.ratio, 1);
    assert.equal(Math.max(...growThenFlat) / growThenFlat[1], 1);
    // 峰值/首稳态 = 4 倍 —— soak 的 rss_peak_bounded 就是抓这个信号的。
    assert.equal(Math.max(...growThenFlat) / growThenFlat[0], 4);
  });
});

describe('tempdir guard', () => {
  it('refuses paths inside the repository', () => {
    const insideRepo = path.join(REPO_ROOT, 'tests', 'bench', 'should-not-exist.db');
    assert.throws(() => assertHarmlessPath(insideRepo, 'probe'), /inside the repository/u);
    assert.equal(isInside(insideRepo, REPO_ROOT), true);
  });

  it('refuses paths outside the OS temp directory', () => {
    // 仓库之外、但也不在临时目录里的路径同样要拒。
    const outside = path.parse(REPO_ROOT).root;
    assert.throws(() => assertHarmlessPath(outside, 'probe'), /outside the OS temporary directory/u);
  });

  it('accepts a temp root, really creates it, and really removes it', () => {
    const root = createTempRoot('self-check');
    // 断言目录真的存在：只断言"路径字符串非空"的话，把 mkdtempSync 删掉也照样通过。
    assert.equal(fs.existsSync(root.root), true, 'temp root must exist on disk');
    const child = root.dir('nested/file.db');
    assert.ok(isInside(realpathLoose(child), realpathLoose(root.root)));
    root.cleanup();
    assert.equal(fs.existsSync(root.root), false, 'cleanup must actually remove the directory');
  });
});

describe('synthetic workload', () => {
  it('produces contract-valid events that are unique', () => {
    const workload = createWorkload({ seed: 99, label: 'self-check' });
    const ids = new Set();
    for (let index = 0; index < 200; index += 1) {
      const event = workload.event(index);
      // 走真实契约校验：生成器造出非法事件会让基准在计时区里抛错，那是噪声。
      assert.equal(validateTelemetryEvent(event).value.event_id, event.event_id);
      ids.add(event.event_id);
    }
    assert.equal(ids.size, 200, 'event ids must be unique or T1 will report duplicates');
  });

  it('is reproducible for the same seed and different across seeds', () => {
    const a = createWorkload({ seed: 5, label: 'x' });
    const b = createWorkload({ seed: 5, label: 'x' });
    const c = createWorkload({ seed: 6, label: 'x' });
    assert.deepEqual(a.event(1), b.event(1));
    assert.notDeepEqual(a.event(1), c.event(1));
  });

  it('workload digest is stable per seed and differs across seeds', () => {
    const build = (seed) => {
      const workload = createWorkload({ seed, label: 'digest' });
      return workloadDigest(Array.from({ length: 32 }, (_unused, index) => workload.event(index + 1)));
    };
    const first = build(7);
    const second = build(7);
    const other = build(8);
    assert.equal(first.digest, second.digest, 'same seed must produce the same workload digest');
    assert.notEqual(first.digest, other.digest, 'different seed must produce a different digest');
    assert.equal(first.count, 32);
  });

  it('orders observed_at before received_at', () => {
    const workload = createWorkload({ seed: 5, label: 'x' });
    const event = workload.event(0);
    assert.ok(Date.parse(event.observed_at) <= Date.parse(event.received_at));
  });
});

describe('report gate', () => {
  it('a failing blocker makes the verdict fail, a failing warn does not', () => {
    const checks = [];
    addCheck(checks, { id: 'a', description: 'ok', expected: 1, actual: 1, passed: true });
    addCheck(checks, { id: 'b', description: 'warn', expected: 1, actual: 2, passed: false, severity: 'warn' });
    const soft = evaluateChecks(checks);
    assert.equal(soft.verdict, 'pass');
    assert.deepEqual(soft.warnings, ['b']);

    addCheck(checks, { id: 'c', description: 'blocker', expected: 1, actual: 2, passed: false });
    const hard = evaluateChecks(checks);
    assert.equal(hard.verdict, 'fail');
    assert.deepEqual(hard.failures, ['c']);
  });

  it('exposes a stable result schema id', () => {
    assert.equal(RESULT_SCHEMA, 'aegis.bench/1');
  });
});

describe('concurrency sampling', () => {
  it('perLevelRequests keeps every level a whole multiple of the concurrency', () => {
    for (const level of CONCURRENCY_LEVELS) {
      const total = perLevelRequests(level, 200);
      // 不整除就会丢余数：旧口径 c=16/32 都只发了 192 次，两档甚至不是同一工作量。
      assert.equal(total % level, 0, `c=${level} 的每轮请求数必须能被并发度整除`);
      assert.ok(total >= level * MIN_PER_WORKER, `c=${level} 的每 worker 请求数必须 >= ${MIN_PER_WORKER}`);
      assert.ok(total >= 200, `c=${level} 不得低于档位下限`);
    }
    assert.equal(perLevelRequests(16, 200) / 16, MIN_PER_WORKER);
    assert.equal(perLevelRequests(32, 200) / 32, MIN_PER_WORKER);
    assert.equal(perLevelRequests(2, 200), 200);
    assert.throws(() => perLevelRequests(0, 200), /positive integer/u);
    assert.throws(() => perLevelRequests(2, 0), /positive integer/u);
  });

  it('aggregateRepeatSamples reports median and variance, not one lucky sample', () => {
    const spread = aggregateRepeatSamples([50, 100, 150]);
    assert.equal(spread.count, 3);
    assert.equal(spread.median, 100);
    assert.equal(spread.stdev, 50);
    assert.equal(spread.cv, 0.5);

    const flat = aggregateRepeatSamples([100, 100, 100]);
    assert.equal(flat.median, 100);
    assert.equal(flat.cv, 0);

    const single = aggregateRepeatSamples([42]);
    assert.equal(single.count, 1);
    assert.equal(single.stdev, 0);
    // 缺样本时必须给 null，不能给 0 —— 0 会被读成"测到零吞吐"。
    assert.equal(aggregateRepeatSamples([]).median, null);
    assert.equal(aggregateRepeatSamples([]).cv, null);
    // 非数值样本不能混进中位数。
    assert.equal(aggregateRepeatSamples([100, null, 200]).count, 2);
  });

  it('runConcurrencySweep takes REPEATS samples per level and flags a crushed level', async () => {
    const calls = [];
    const flatMeasure = async ({ concurrency, total }) => {
      calls.push({ concurrency, total });
      return {
        latencies: new Array(total).fill(1),
        failures: 0,
        statuses: { 200: total },
        wall_ms: total / 5,
      };
    };

    const ok = await runConcurrencySweep({ measure: flatMeasure, perLevel: 200 });
    assert.equal(ok.complete, true);
    assert.equal(ok.sweep.length, CONCURRENCY_LEVELS.length);
    assert.equal(ok.repeats, REPEATS);
    // 每档真的跑满 3 轮：档数 × 重复次数，少一轮"中位数"就退化成单次观测。
    assert.equal(calls.length, CONCURRENCY_LEVELS.length * REPEATS);
    for (const entry of ok.sweep) {
      assert.equal(entry.throughput_rps_samples.length, REPEATS);
      assert.equal(entry.latency_p99_samples.length, REPEATS);
      assert.equal(entry.throughput_rps, entry.throughput_rps_samples[0]);
      assert.equal(entry.requests_per_repeat, perLevelRequests(entry.concurrency, 200));
      assert.equal(entry.requests_total, entry.requests_per_repeat * REPEATS);
    }

    // 刹车用常量绝对上限：p99 中位数 500ms > 100ms 才算"控制台已不可用"。
    const crushed = await runConcurrencySweep({
      perLevel: 200,
      measure: async ({ concurrency, total }) => {
        const latencies = new Array(total).fill(1);
        if (concurrency >= 8) {
          // 200 个样本的 p99 大约落在第 198 名，只放 2 个离群值改不动它。
          for (let index = 1; index <= 5; index += 1) {
            latencies[latencies.length - index] = 500;
          }
        }
        return { latencies, failures: 0, statuses: { 200: total }, wall_ms: 100 };
      },
    });
    assert.equal(crushed.abortedAt, 8);
    assert.equal(crushed.sweep.length, 3);
    assert.equal(crushed.complete, false, '刹车提前终止的轮次不能算"跑全"');

    // 回归用例：合法的排队延迟（c=32 的 p99 实测 12–13 ms）不得触发刹车。
    // 旧实现用"20 × 顺序基线 p99"（约 9.6 ms），正常排队就会把扫描截断在 c=8。
    const queued = await runConcurrencySweep({
      perLevel: 200,
      measure: async ({ concurrency, total }) => {
        const latencies = new Array(total).fill(1);
        for (let index = 1; index <= 10; index += 1) {
          latencies[latencies.length - index] = concurrency * 0.4;
        }
        return { latencies, failures: 0, statuses: { 200: total }, wall_ms: total / 5 };
      },
    });
    assert.equal(queued.abortedAt, null);
    assert.equal(queued.complete, true, 'c=32 的正常排队不能把扫描截断');
    assert.equal(queued.sweep.length, CONCURRENCY_LEVELS.length);
    // 先证明这条用例真的把 p99 推到了 12.8ms 并超过旧刹车线（9.6ms），否则它是空断言。
    assert.equal(queued.sweep[queued.sweep.length - 1].latency_p99_median, 12.8);
    assert.ok(queued.sweep[queued.sweep.length - 1].latency_p99_median > 9.6);

    await assert.rejects(
      () => runConcurrencySweep({ measure: flatMeasure, perLevel: 200, repeats: 1 }),
      /repeats must be an integer >= 3/u,
    );
    await assert.rejects(() => runConcurrencySweep({ perLevel: 200 }), /measure function/u);
  });

  it('scaling expectation is a constant, never derived from the measurements', () => {
    // 回归用例：旧实现的 expected 里写着 `c=${maxConcurrency}`，于是"只跑 3 档"的那轮
    // 判据就从 `c=32 >= c=2` 变成了 `c=8 >= c=2`，报告上看不出来。
    const fast = [
      { concurrency: 2, throughput_rps: 1000, repeats: 3 },
      { concurrency: 32, throughput_rps: 1200, repeats: 3 },
    ];
    const slow = [
      { concurrency: 2, throughput_rps: 8000, repeats: 3 },
      { concurrency: 32, throughput_rps: 100, repeats: 3 },
    ];
    const left = evaluateScaling({ sweep: fast });
    const right = evaluateScaling({ sweep: slow });
    assert.equal(left.expected, right.expected, '两组完全不同的测量必须得到同一个 expected');
    assert.equal(left.expected, scalingExpectation());
    assert.equal(left.expected.includes('1000'), false);
    assert.equal(right.expected.includes('8000'), false);
    assert.equal(left.passed, true);
    assert.equal(right.passed, false);
  });

  it('scaling boundary is inclusive at the ratio floor and a missing level never passes', () => {
    const entry = (concurrency, throughput_rps) => ({ concurrency, throughput_rps, repeats: REPEATS });
    assert.equal(evaluateScaling({ sweep: [entry(2, 1000), entry(32, 900)] }).passed, true);
    assert.equal(evaluateScaling({ sweep: [entry(2, 1000), entry(32, 899)] }).passed, false);

    const missingTop = evaluateScaling({ sweep: [entry(2, 1000), entry(8, 1500)] });
    assert.equal(missingTop.comparable, false);
    assert.equal(missingTop.passed, false, '缺 c=32 必须判失败，不能默认通过');
    assert.deepEqual(missingTop.missing_levels, [32]);
    assert.equal(evaluateScaling({ sweep: [] }).passed, false);
  });

  it('one lucky repeat cannot flip the verdict (median, not mean)', () => {
    const base = aggregateRepeatSamples([1000, 1000, 1000]);
    const top = aggregateRepeatSamples([700, 700, 3000]);
    assert.equal(top.median, 700);
    assert.ok(top.mean > 1000, '用均值会得出"通过"，这正是要拦的读法');
    const verdict = evaluateScaling({
      sweep: [
        { concurrency: 2, throughput_rps: base.median, repeats: REPEATS },
        { concurrency: 32, throughput_rps: top.median, repeats: REPEATS },
      ],
    });
    assert.equal(verdict.ratio, 0.7);
    assert.equal(verdict.passed, false);
  });

  it('measurement stability flags a CV that makes the median untrustworthy', () => {
    const stable = evaluateMeasurementStability({
      sweep: [{ concurrency: 2, throughput_rps_cv: 0.1 }, { concurrency: 32, throughput_rps_cv: 0.3 }],
    });
    assert.equal(stable.passed, true);
    assert.equal(stable.worst.level, 32);
    const noisy = evaluateMeasurementStability({
      sweep: [{ concurrency: 2, throughput_rps_cv: 0.2 }, { concurrency: 32, throughput_rps_cv: 0.8 }],
    });
    assert.equal(noisy.passed, false);
    assert.equal(evaluateMeasurementStability({ sweep: [] }).passed, false);
  });
});

/**
 * 起一个只做认证判定的最小 HTTP 服务，用来证明探针在**真实 HTTP 层**能变红。
 *
 * 三种模式刻意并列，因为"判据能失败"这件事必须有两种相反的失败方向才算证明完整：
 *
 * - `current`：直接调用被测实现 `createAuthGuard`（先验凭据、后查桶）。
 * - `legacy`：复刻 P1 修复**之前**的顺序（先查桶、后验凭据）——故意的故障注入。
 * - `per-token`：把失败桶按 **presented token** 记账（而不是按 peer）——另一种退化：
 *   轮换 token 就能无限猜，而"同一个 token 连发"的判据看不出来。
 * - `no-limit`：错 token 恒 401、不记账 —— 证明"把限流删掉"也会被另一条判据抓住。
 *
 * @param {'current'|'legacy'|'per-token'|'no-limit'} mode 模式。
 * @returns {Promise<{port: number, close: () => Promise<void>, token: string}>} 句柄。
 */
async function startAuthProbeServer(mode) {
  const token = 'self-check-token-0123456789abcdef';
  const windowMs = 60000;
  const limit = 5;
  const guard = createAuthGuard({
    token,
    clock: { nowMs: () => Date.now() },
    failureLimit: limit,
    failureWindowMs: windowMs,
  });
  // 旧顺序的失败桶（只在本文件里复刻，仓库源码不动）。
  const legacyFailures = new Map();

  /** @returns {number} HTTP 状态码。 */
  function legacyDecide(header) {
    const presented = readBearer(header);
    if (presented === null) {
      return 401;
    }
    const now = Date.now();
    const entry = legacyFailures.get('peer');
    if (entry !== undefined && now - entry.first <= windowMs && entry.count >= limit) {
      return 429; // 先查桶：合法 token 也在这里被拦下
    }
    if (safeEqual(presented, token)) {
      return 200;
    }
    if (entry === undefined) {
      legacyFailures.set('peer', { count: 1, first: now });
    } else {
      entry.count += 1;
    }
    return 401;
  }

  /** @returns {number} HTTP 状态码。 */
  function noLimitDecide(header) {
    const presented = readBearer(header);
    if (presented !== null && safeEqual(presented, token)) {
      return 200;
    }
    return 401;
  }

  // 退化版：桶按 presented token 记账。每个 token 各有一份配额，轮换即可续。
  const tokenBuckets = new Map();

  /** @returns {number} HTTP 状态码。 */
  function perTokenDecide(header) {
    const presented = readBearer(header);
    if (presented === null) {
      return 401;
    }
    const now = Date.now();
    const entry = tokenBuckets.get(presented);
    if (entry !== undefined && now - entry.first <= windowMs && entry.count >= limit) {
      return 429;
    }
    if (safeEqual(presented, token)) {
      return 200;
    }
    if (entry === undefined) {
      tokenBuckets.set(presented, { count: 1, first: now });
    } else {
      entry.count += 1;
    }
    return 401;
  }

  // 退化版：桶键取自客户端可控的 `X-Forwarded-For`。轮换该头即可无限猜。
  const headerBuckets = new Map();

  /** @returns {number} HTTP 状态码。 */
  function perHeaderDecide(header, forwardedFor) {
    const presented = readBearer(header);
    if (presented === null) {
      return 401;
    }
    const key = typeof forwardedFor === 'string' && forwardedFor.length > 0 ? forwardedFor : 'peer';
    const now = Date.now();
    const entry = headerBuckets.get(key);
    if (entry !== undefined && now - entry.first <= windowMs && entry.count >= limit) {
      return 429;
    }
    if (safeEqual(presented, token)) {
      return 200;
    }
    if (entry === undefined) {
      headerBuckets.set(key, { count: 1, first: now });
    } else {
      entry.count += 1;
    }
    return 401;
  }

  const server = http.createServer((req, res) => {
    let status;
    if (mode === 'current') {
      const decision = guard.authenticate(req.headers.authorization, '127.0.0.1');
      status = decision.ok
        ? 200
        : (decision.code === DAEMON_CODES.AUTH_RATE_LIMITED ? 429 : 401);
    } else if (mode === 'legacy') {
      status = legacyDecide(req.headers.authorization);
    } else if (mode === 'per-token') {
      status = perTokenDecide(req.headers.authorization);
    } else if (mode === 'per-header') {
      status = perHeaderDecide(req.headers.authorization, req.headers['x-forwarded-for']);
    } else {
      status = noLimitDecide(req.headers.authorization);
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? '{"ok":true}' : '{"ok":false}');
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    token,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.close(resolve);
    }),
  };
}

/**
 * 对某个服务跑一次探针（压缩时标，总耗时约 200 ms）。
 *
 * @param {{port: number, token: string}} server 服务句柄。
 * @param {readonly number[]} offsets 压缩后的采样时点。
 * @returns {Promise<object>} 探针原始结果。
 */
async function probeAgainst(server, offsets) {
  return runAuthLockoutProbe({
    offsets,
    request: (headers) => new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server.port, path: '/', method: 'GET', headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    }),
    legitimateHeaders: { authorization: `Bearer ${server.token}` },
    wrongHeaders: { authorization: 'Bearer self-check-wrong-token-0000000000' },
  });
}

describe('auth lockout probe', () => {
  it('expectation text is a constant and names all four production offsets', () => {
    // 常量断言：offset 表被改动时这里必须红，否则"四点"会静默变成别的时点。
    assert.deepEqual([...LOCKOUT_PROBE_OFFSETS_MS], [0, 5000, 25000, 35000]);
    assert.equal(lockoutProbeExpectation(), '+0/+5/+25/+35 s 四点合法请求全部 200');
  });

  it('four 200s pass, and the actual string carries every sample', () => {
    const samples = [0, 5000, 25000, 35000].map((offset_ms) => ({ offset_ms, status: 200 }));
    const verdict = evaluateAuthLockoutProbe({ samples });
    assert.equal(verdict.passed, true);
    assert.equal(verdict.actual, '+0s=200 +5s=200 +25s=200 +35s=200');
    assert.deepEqual(verdict.rejected_offsets, []);
  });

  it('the pre-fix behaviour (429 at all four points) fails hard', () => {
    // 这就是 H-1 要拦的那一版：修复前 `M9-PERF-FINAL` §7 表里四点全是 429。
    const samples = [0, 5000, 25000, 35000].map((offset_ms) => ({ offset_ms, status: 429 }));
    const verdict = evaluateAuthLockoutProbe({ samples });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejected_offsets.length, 4);
    assert.deepEqual(verdict.rejected_offsets.map((entry) => entry.offset_ms), [0, 5000, 25000, 35000]);
  });

  it('a single rejected point is enough to fail — no averaging away a regression', () => {
    const samples = [
      { offset_ms: 0, status: 200 },
      { offset_ms: 5000, status: 200 },
      { offset_ms: 25000, status: 429 },
      { offset_ms: 35000, status: 200 },
    ];
    const verdict = evaluateAuthLockoutProbe({ samples });
    assert.equal(verdict.passed, false);
    assert.deepEqual(verdict.rejected_offsets, [{ offset_ms: 25000, status: 429 }]);
  });

  it('missing a time point fails instead of passing on partial evidence', () => {
    const samples = [
      { offset_ms: 0, status: 200 },
      { offset_ms: 5000, status: 200 },
      { offset_ms: 25000, status: 200 },
    ];
    const verdict = evaluateAuthLockoutProbe({ samples });
    assert.equal(verdict.passed, false, '只测到三点就通过，等于把"没测"当成"通过"');
    assert.deepEqual(verdict.missing_offsets, [35000]);
    assert.equal(evaluateAuthLockoutProbe({ samples: [] }).passed, false);
    // 未约定的时点同样不能蒙混：否则采样点被换成 +0 一个点也能绿。
    const offPlan = [
      { offset_ms: 0, status: 200 },
      { offset_ms: 1000, status: 200 },
      { offset_ms: 5000, status: 200 },
      { offset_ms: 25000, status: 200 },
      { offset_ms: 35000, status: 200 },
    ];
    assert.equal(evaluateAuthLockoutProbe({ samples: offPlan }).passed, false);
  });

  it('guess throttling needs at least two observations and rejects any non-429', () => {
    const ok = evaluateGuessThrottle({
      throttle: [{ after_offset_ms: 0, status: 429 }, { after_offset_ms: 35000, status: 429 }],
    });
    assert.equal(ok.passed, true);
    assert.equal(ok.actual, '+0s 后=429 +35s 后=429');
    assert.equal(evaluateGuessThrottle({ throttle: [] }).passed, false);
    // 只有一次观测 = 空断言的门槛，必须判失败。
    assert.equal(evaluateGuessThrottle({ throttle: [{ after_offset_ms: 0, status: 429 }] }).passed, false);
    assert.ok(MIN_THROTTLE_OBSERVATIONS >= 2);
    // 限流被删掉后错 token 变 401 —— 这一条必须红。
    const removed = evaluateGuessThrottle({
      throttle: [{ after_offset_ms: 0, status: 401 }, { after_offset_ms: 35000, status: 401 }],
    });
    assert.equal(removed.passed, false);
    assert.deepEqual(removed.leaks, [401, 401]);
  });

  it('the shipped implementation passes the probe over real HTTP', async () => {
    const offsets = [0, 40, 90, 150];
    const server = await startAuthProbeServer('current');
    try {
      const result = await probeAgainst(server, offsets);
      assert.deepEqual(result.burst_statuses, [401, 401, 401, 401, 401]);
      assert.deepEqual(result.samples.map((sample) => sample.status), [200, 200, 200, 200]);
      const legit = evaluateAuthLockoutProbe({ samples: result.samples, offsets });
      const throttle = evaluateGuessThrottle({ throttle: result.throttle });
      assert.equal(legit.passed, true);
      assert.equal(throttle.passed, true, '成功不得清桶：合法请求之后仍是 429');
    } finally {
      await server.close();
    }
  });

  it('REGRESSION GUARD: reverting the check order really turns the gate red', async () => {
    // 这是整个文件里最重要的一条：把 auth 判定临时换回旧顺序，判据必须变红。
    // 只用合成样本不够——那条路径证明不了"探针真的能从 HTTP 层读到 429"。
    const offsets = [0, 40, 90, 150];
    const server = await startAuthProbeServer('legacy');
    try {
      const result = await probeAgainst(server, offsets);
      assert.deepEqual(
        result.samples.map((sample) => sample.status),
        [429, 429, 429, 429],
        '旧顺序下四点必须全部 429，否则这条用例本身是空断言',
      );
      const legit = evaluateAuthLockoutProbe({ samples: result.samples, offsets });
      assert.equal(legit.passed, false, '回退 auth 顺序后判据必须变红');
      assert.equal(legit.rejected_offsets.length, 4);
      // 而"限流仍生效"那条在旧顺序下依然绿 —— 这正是它们必须成对存在的原因：
      // 单看防爆破，回退是看不出来的。
      assert.equal(evaluateGuessThrottle({ throttle: result.throttle }).passed, true);
    } finally {
      await server.close();
    }
  });

  it('REGRESSION GUARD: deleting the limiter also turns the gate red', async () => {
    // 反向的作弊路径：把限流整段删掉，"合法请求 200"会满足，但防爆破归零。
    const offsets = [0, 40, 90, 150];
    const server = await startAuthProbeServer('no-limit');
    try {
      const result = await probeAgainst(server, offsets);
      const legit = evaluateAuthLockoutProbe({ samples: result.samples, offsets });
      assert.equal(legit.passed, true, '删掉限流后"合法请求"当然全 200 —— 所以单靠它不够');
      const throttle = evaluateGuessThrottle({ throttle: result.throttle });
      assert.equal(throttle.passed, false, '删掉限流必须被"仍须 429"那条抓住');
      assert.deepEqual(throttle.leaks, [401, 401]);
    } finally {
      await server.close();
    }
  });

  it('quota judge: peer accounting passes, per-token accounting fails', async () => {
    // 假绿通道之二：把失败桶按 presented token 记账。上面三条判据都用**同一个**错
    // token 连发，所以那种退化下它们照样全绿 —— 而攻击者轮换 token 就能无限猜。
    const server = await startAuthProbeServer('current');
    const degraded = await startAuthProbeServer('per-token');
    const perHeader = await startAuthProbeServer('per-header');
    try {
      const keys = Array.from(
        { length: LOCKOUT_PROBE_WRONG_BURST },
        (_unused, index) => ({
          authorization: `Bearer self-check-rotating-${index}-0000000`,
          // 同时轮换一个客户端可控头：桶键不得由它派生。
          'x-forwarded-for': `203.0.113.${index + 1}`,
        }),
      );
      const quotaHeaders = {
        authorization: 'Bearer self-check-rotating-final-0000000',
        'x-forwarded-for': '203.0.113.250',
      };
      const run = (target) => new Promise((resolve, reject) => {
        const request = (headers) => new Promise((innerResolve, innerReject) => {
          const req = http.request(
            { host: '127.0.0.1', port: target.port, path: '/', method: 'GET', headers },
            (res) => {
              res.resume();
              res.on('end', () => innerResolve({ status: res.statusCode ?? 0 }));
            },
          );
          req.on('error', innerReject);
          req.end();
        });
        runRotatingTokenProbe({
          request,
          wrongHeaders: keys,
          quotaHeaders,
          legitimateHeaders: { authorization: `Bearer ${target.token}` },
        }).then(resolve, reject);
      });

      const good = await run(server);
      assert.deepEqual(good.wrong_statuses, [401, 401, 401, 401, 401]);
      assert.equal(good.quota_probe_status, 429);
      assert.equal(good.legitimate_status, 200);
      assert.equal(evaluateRotatingTokenQuota(good).passed, true);

      const bad = await run(degraded);
      assert.deepEqual(bad.wrong_statuses, [401, 401, 401, 401, 401], '按 token 记账时每个 token 都是首次猜测');
      assert.equal(bad.quota_probe_status, 401, '新 token 拿到全新配额 —— 正是要拦的退化');
      assert.equal(bad.legitimate_status, 200);
      const verdict = evaluateRotatingTokenQuota(bad);
      assert.equal(verdict.passed, false, '按 token 记账必须判红');
      assert.equal(verdict.reasons.length, 1);

      // 第三条：桶键取自客户端可控的 X-Forwarded-For —— 轮换该头同样能无限猜。
      const byHeader = await run(perHeader);
      assert.deepEqual(byHeader.wrong_statuses, [401, 401, 401, 401, 401]);
      assert.equal(byHeader.quota_probe_status, 401, '每个新 XFF 拿到全新配额 —— 也必须判红');
      assert.equal(evaluateRotatingTokenQuota(byHeader).passed, false);
    } finally {
      await server.close();
      await degraded.close();
      await perHeader.close();
    }
  });

  it('quota judge rejects a premature 429 and a legitimate token that is refused', () => {
    const good = {
      wrong_statuses: [401, 401, 401, 401, 401],
      quota_probe_status: 429,
      legitimate_status: 200,
    };
    assert.equal(evaluateRotatingTokenQuota(good).passed, true);
    // 前 5 个里有 429：说明限流过早生效（会把正常客户端也拒掉）。
    assert.equal(evaluateRotatingTokenQuota({ ...good, wrong_statuses: [401, 401, 429, 429, 429] }).passed, false);
    // 合法 token 被拒：P1 回归。
    assert.equal(evaluateRotatingTokenQuota({ ...good, legitimate_status: 429 }).passed, false);
    // 只发了 3 个：证据不完整，不能通过。
    assert.equal(evaluateRotatingTokenQuota({
      wrong_statuses: [401, 401, 401],
      quota_probe_status: 429,
      legitimate_status: 200,
    }).passed, false);
    assert.equal(evaluateRotatingTokenQuota({}).passed, false);
  });

  it('defaults judge allows tightening but rejects weakening', () => {
    assert.equal(LOCKOUT_PROBE_SPAN_MS, 36000);
    assert.equal(evaluateAuthDefaults({ limit: 5, windowMs: 60000 }).passed, true);
    // 收紧：更小的 limit、更长的 window —— 更安全，必须通过。
    assert.equal(evaluateAuthDefaults({ limit: 3, windowMs: 120000 }).passed, true);
    // 弱化：真实复核里就是把默认值改成 1000 / 1 s，四条 auth 判据全绿而防爆破失效。
    assert.equal(evaluateAuthDefaults({ limit: 1000, windowMs: 1000 }).passed, false);
    assert.equal(evaluateAuthDefaults({ limit: 5, windowMs: 1000 }).passed, false);
    assert.equal(evaluateAuthDefaults({ limit: 1000, windowMs: 60000 }).passed, false);
    assert.equal(evaluateAuthDefaults({ limit: null, windowMs: null }).passed, false);
  });
});

