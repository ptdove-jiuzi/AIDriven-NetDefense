/**
 * lib/concurrency.js — 并发扫描的采样口径与判据。
 *
 * 为什么单独成文件：原判据在场景里"边测边判"，于是有三个结构性问题，
 * 独立复核（`reviews/m9-perf-triage.md` D-2/D-4、`status/M9-PERF-FINAL.md` F-3）都有实测：
 *
 * 1. **期望值由实测派生**。`expected` 里写的是 `throughput(c=${maxConcurrency})`，而
 *    `maxConcurrency = Math.max(...sweep)`。刹车在 c=8 提前终止时，期望文本就悄悄变成
 *    `c=8 >= c=2` —— 同一个检查在不同轮次里度量的对象不同，历史数字失去可比性，
 *    而报告上完全看不出来（`bench-standard-20261102T203142Z.json` 就是这样）。
 * 2. **单次测量**。每档只跑一次，机器噪声直接当结论；实测轮间 CV 9.7%–34.8%，
 *    要在 95% 置信下判定 19% 的差异每组需要约 19 次重复 —— 单次等于抛硬币。
 * 3. **没有"跑全"的断言**。只跑了 3/5 档的轮次照样 `pass`，"最高档"于是退化成中间档。
 *
 * 另有一个相关缺陷：刹车阈值也是实测派生的（`p99 > 20 × 顺序基线 p99`），而合法排队
 * 在 c=32 本来就有 25–27 倍 —— 刹车会在正常排队时触发，缺档因此不是偶发。
 * 现在刹车改用常量上限（见 {@link ABORT_P99_BUDGET_MS}）。
 *
 * 因此这里把采样与判定拆成纯函数：
 *
 * - `perLevelRequests()`：每档请求数取整到并发度的整数倍，避免 `floor(total/concurrency)`
 *   丢余数（旧口径 c=16/32 实际只发了 192 次而不是 200 次）；
 * - `runConcurrencySweep()`：每档**固定重复 `REPEATS` 次**，取中位数与变异系数；
 * - `scalingExpectation()`：**只吃常量参数**，不接触任何实测值 —— 期望文本跨轮恒定；
 * - `evaluateScaling()` / `evaluateMeasurementStability()`：纯判定，可被 self-check
 *   用假测量驱动。判据必须能在不启动 daemon 的情况下被证伪，否则它只是一段自述。
 */

import { summarize } from './stats.js';

/** 并发档位。到 32 就停：本机 12 逻辑核，再高只是在测排队长度。 */
export const CONCURRENCY_LEVELS = Object.freeze([2, 4, 8, 16, 32]);

/** 基线档位（判据的比较基准，常量，不随实测变化）。 */
export const BASE_LEVEL = CONCURRENCY_LEVELS[0];

/** 最高档位（延迟预算与扩展性判据的观察对象，常量，不随实测变化）。 */
export const TOP_LEVEL = CONCURRENCY_LEVELS[CONCURRENCY_LEVELS.length - 1];

/**
 * 每档重复次数。下限 3 是硬约束：
 * 2 次的中位数就是均值，方差也只剩一个自由度，等于换了个说法的单次测量。
 */
export const REPEATS = 3;

/**
 * 每个 worker 的最少请求数。
 *
 * 旧口径每档固定 200 次，`c=32` 时 `perWorker = floor(200/32) = 6`，单档墙钟只有
 * 20–50 ms —— 这个窗口里 JIT 首次优化、连接池填充、一次 GC 抖动都能主导结果。
 * 取 24 让 `c=32` 的每档工作量涨到 768 次，墙钟约 80–100 ms，量级才够。
 */
export const MIN_PER_WORKER = 24;

/**
 * 一次扫描的刹车：某一档的 p99 中位数超过这个绝对上限就不再升并发。
 *
 * 为什么不用"基线的 N 倍"（旧实现是 `p99 > 20 × 顺序基线 p99`）：
 *
 * - 那个阈值是**由实测派生**的，属于本仓库明令禁止的写法（README 反模式 #13）；
 * - 更糟的是它**低于合法排队水平**。按 Little 定律 p99 大致随并发线性增长，
 *   实测 c=32 的 p99 是 12.0–12.7 ms，而顺序基线 p99 只有 0.43–0.48 ms ——
 *   比值 25–27 倍，本来就超过 20 倍的刹车线。于是刹车会在**正常排队**时触发，
 *   R3 就是这样在 c=8 被截断、"最高档"退化成 c=8 的。
 *
 * 改用与延迟预算同一个常量：超过 100 ms 才是"控制台已经不可用"，与"排队变慢"
 * 区分得开。刹车不是门禁，但它决定证据是否完整，所以阈值必须是常量。
 */
export const ABORT_P99_BUDGET_MS = 100;

/**
 * 最高并发档位（c=32）的 p99 绝对上限。
 *
 * 100 ms 是"本地控制台还能用"的宽松界线：它拦得住"已经排队排到不可用"，
 * 又不会把 12 核机器上的正常调度抖动判成退化。
 */
export const ABSOLUTE_P99_BUDGET_MS = 100;

/**
 * 扩展性判据：最高档中位吞吐至少是基线档中位吞吐的这个倍数。
 *
 * 0.9 的含义是**只拦真退化**：并发从 2 提到 32，允许中位吞吐下降 10%（噪声与
 * 排队成本），但不能比基线还低 —— "加并发反而更慢"才是要拦的信号。
 * 独立扩测的实测比值在 1.08–1.33，`0.81` 是单次测量的产物，落在噪声带内。
 */
export const SCALE_MIN_RATIO = 0.9;

/**
 * 可接受的档内变异系数上限。超过它说明中位数不可信，结论强度不足，
 * 应当增加重复次数而不是把检查调红 —— 所以它是 warn，不是产品门禁。
 */
export const MAX_MEDIAN_CV = 0.5;

/**
 * 计算某一档的每轮请求数。
 *
 * @param {number} concurrency 并发数。
 * @param {number} perLevel 每档目标请求数（下限）。
 * @returns {number} 实际每轮请求数（一定是 `concurrency` 的整数倍）。
 */
export function perLevelRequests(concurrency, perLevel) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, received ${concurrency}`);
  }
  if (!Number.isInteger(perLevel) || perLevel < 1) {
    throw new Error(`perLevel must be a positive integer, received ${perLevel}`);
  }
  const floor = concurrency * MIN_PER_WORKER;
  const target = Math.max(perLevel, floor);
  // 向上取整到并发度的整数倍：`measureConcurrent` 里 `perWorker = floor(total/concurrency)`，
  // 不取整就会丢余数（旧口径 c=16 与 c=32 都只发 192 次，两档甚至不是同一工作量）。
  return Math.ceil(target / concurrency) * concurrency;
}

/**
 * 汇总一组重复采样：给中位数、标准差与变异系数。
 *
 * 中位数而不是均值：均值会被一次 GC 抖动或外部负载尖峰拉走，而门禁要判的是
 * "这个档位的常态水平"。标准差同时报出来，让读者能自己判断中位数有多可信。
 *
 * @param {number[]} samples 每轮一个样本。
 * @returns {{count: number, min: number|null, max: number|null, median: number|null,
 *   mean: number|null, stdev: number|null, cv: number|null}} 汇总。
 */
export function aggregateRepeatSamples(samples) {
  const clean = Array.isArray(samples)
    ? samples.filter((value) => typeof value === 'number' && Number.isFinite(value))
    : [];
  if (clean.length === 0) {
    return { count: 0, min: null, max: null, median: null, mean: null, stdev: null, cv: null };
  }
  const summary = summarize(clean);
  const cv = summary.mean !== null && summary.mean > 0 && summary.stdev !== null
    ? Number((summary.stdev / summary.mean).toFixed(4))
    : null;
  return {
    count: clean.length,
    min: summary.min,
    max: summary.max,
    // summarize 的 p50 就是中位数（精确秩，偶数个取中间两值平均）。
    median: summary.p50,
    mean: summary.mean,
    stdev: summary.stdev,
    cv,
  };
}

/**
 * 执行一次并发的重复采样扫描。
 *
 * @param {{
 *   measure: (request: {concurrency: number, total: number}) => Promise<{
 *     latencies: number[], failures: number, statuses: object, wall_ms: number}>,
 *   perLevel: number, levels?: readonly number[], repeats?: number,
 *   abortP99Ms?: number
 * }} options 选项。
 * @returns {Promise<{sweep: object[], abortedAt: number|null, complete: boolean,
 *   levels: number[], repeats: number}>} 扫描结果。
 */
export async function runConcurrencySweep(options) {
  const measure = options?.measure;
  if (typeof measure !== 'function') {
    throw new Error('runConcurrencySweep requires a measure function');
  }
  const levels = options.levels ?? CONCURRENCY_LEVELS;
  const repeats = options.repeats ?? REPEATS;
  if (!Number.isInteger(repeats) || repeats < 3) {
    // 少于 3 次就没有方差可言，"中位数"退化成单次观测 —— 那正是要修掉的缺陷。
    throw new Error(`repeats must be an integer >= 3, received ${repeats}`);
  }
  const abortP99Ms = typeof options.abortP99Ms === 'number' && Number.isFinite(options.abortP99Ms)
    ? options.abortP99Ms
    : ABORT_P99_BUDGET_MS;

  const sweep = [];
  let abortedAt = null;

  for (const level of levels) {
    const target = perLevelRequests(level, options.perLevel);
    const runs = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const result = await measure({ concurrency: level, total: target });
      const summary = summarize(result.latencies);
      runs.push({
        requests: result.latencies.length,
        failures: result.failures,
        statuses: result.statuses,
        wall_ms: result.wall_ms,
        throughput_rps: typeof result.wall_ms === 'number' && result.wall_ms > 0
          ? Number(((result.latencies.length / result.wall_ms) * 1000).toFixed(2))
          : null,
        latency_ms: summary,
        latencies: result.latencies,
      });
    }

    const throughput = aggregateRepeatSamples(runs.map((run) => run.throughput_rps));
    const p99 = aggregateRepeatSamples(runs.map((run) => run.latency_ms.p99));

    const statuses = {};
    let failures = 0;
    let requestsTotal = 0;
    let wallTotal = 0;
    for (const run of runs) {
      failures += run.failures;
      requestsTotal += run.requests;
      wallTotal += typeof run.wall_ms === 'number' ? run.wall_ms : 0;
      for (const [status, count] of Object.entries(run.statuses ?? {})) {
        statuses[status] = (statuses[status] ?? 0) + count;
      }
    }

    sweep.push({
      concurrency: level,
      repeats,
      target_requests_per_repeat: target,
      requests_per_repeat: runs[0].requests,
      requests_total: requestsTotal,
      failures,
      statuses,
      wall_ms_total: Number(wallTotal.toFixed(3)),
      // 采样明细必须留在证据里：只给中位数等于让人无从复核方差。
      throughput_rps_samples: runs.map((run) => run.throughput_rps),
      throughput_rps: throughput.median,
      throughput_rps_mean: throughput.mean,
      throughput_rps_stdev: throughput.stdev,
      throughput_rps_cv: throughput.cv,
      // 池化分位数只用于描述延迟形状；判据用逐轮 p99 的中位数（见下）。
      latency_ms: summarize(runs.flatMap((run) => run.latencies)),
      latency_p99_samples: runs.map((run) => run.latency_ms.p99),
      latency_p99_median: p99.median,
      latency_p99_stdev: p99.stdev,
      latency_p99_cv: p99.cv,
    });

    // 刹车判据用 p99 中位数 + 常量上限：单次值容易被一次调度抖动顶穿，
    // 而"基线的 N 倍"会把正常排队判成压垮（见 ABORT_P99_BUDGET_MS 的注释）。
    if (typeof p99.median === 'number' && p99.median > abortP99Ms) {
      abortedAt = level;
      break;
    }
  }

  const complete = abortedAt === null
    && sweep.length === levels.length
    && sweep.every((entry, index) => entry.concurrency === levels[index]);

  return { sweep, abortedAt, complete, levels: [...levels], repeats };
}

/**
 * 扩展性判据的**期望文本**。
 *
 * 刻意只吃常量：一旦它读到实测值（旧实现读 `Math.max(...sweep)`），同一检查在不同
 * 轮次里就会度量不同的对象，证据之间不再可比。`self-check.test.js` 有一条用例
 * 专门断言"两组完全不同的测量得到同一个 expected 字符串"。
 *
 * @param {{baseLevel?: number, topLevel?: number, minRatio?: number}} [options] 参数。
 * @returns {string} 期望文本。
 */
export function scalingExpectation(options = {}) {
  const baseLevel = options.baseLevel ?? BASE_LEVEL;
  const topLevel = options.topLevel ?? TOP_LEVEL;
  const minRatio = options.minRatio ?? SCALE_MIN_RATIO;
  return `median_throughput(c=${topLevel}) >= ${minRatio} × median_throughput(c=${baseLevel})`;
}

/**
 * 判定扩展性：最高档的中位吞吐是否仍有基线档的 `minRatio` 倍。
 *
 * 缺档时**必须判失败**，不能因为"没测到"就默认通过 —— 那正是旧实现让只跑 3 档的
 * 轮次 "pass" 的机制。
 *
 * @param {{sweep: object[], baseLevel?: number, topLevel?: number, minRatio?: number}} options 参数。
 * @returns {{comparable: boolean, ratio: number|null, passed: boolean, expected: string,
 *   actual: string, missing_levels: number[]}} 判定。
 */
export function evaluateScaling(options) {
  const sweep = Array.isArray(options?.sweep) ? options.sweep : [];
  const baseLevel = options.baseLevel ?? BASE_LEVEL;
  const topLevel = options.topLevel ?? TOP_LEVEL;
  const minRatio = options.minRatio ?? SCALE_MIN_RATIO;
  const base = sweep.find((entry) => entry.concurrency === baseLevel) ?? null;
  const top = sweep.find((entry) => entry.concurrency === topLevel) ?? null;
  const baseValue = base?.throughput_rps ?? null;
  const topValue = top?.throughput_rps ?? null;
  const comparable = typeof baseValue === 'number' && Number.isFinite(baseValue) && baseValue > 0
    && typeof topValue === 'number' && Number.isFinite(topValue);
  const ratio = comparable ? Number((topValue / baseValue).toFixed(4)) : null;
  const missing = [];
  if (base === null) {
    missing.push(baseLevel);
  }
  if (top === null) {
    missing.push(topLevel);
  }
  return {
    comparable,
    ratio,
    passed: comparable && ratio >= minRatio,
    expected: scalingExpectation({ baseLevel, topLevel, minRatio }),
    actual: comparable
      ? `median(c=${topLevel})=${topValue} / median(c=${baseLevel})=${baseValue} = ${ratio}`
      : `不可比：缺 c=${missing.join('、c=')}`,
    missing_levels: missing,
  };
}

/**
 * 判定"测量本身是否可信"：最差档位的吞吐 CV 不得超过 `MAX_MEDIAN_CV`。
 *
 * 这不是产品门禁，而是给结论强度加一条可见的红线：CV 过高时中位数比值说明不了
 * 问题（该增加重复次数或独占机器），而报告里必须能看出来。
 *
 * @param {{sweep: object[], maxCv?: number}} options 参数。
 * @returns {{passed: boolean, worst: {level: number, cv: number}|null, expected: string,
 *   actual: string}} 判定。
 */
export function evaluateMeasurementStability(options) {
  const sweep = Array.isArray(options?.sweep) ? options.sweep : [];
  const maxCv = options?.maxCv ?? MAX_MEDIAN_CV;
  let worst = null;
  for (const entry of sweep) {
    const cv = entry?.throughput_rps_cv;
    if (typeof cv !== 'number' || !Number.isFinite(cv)) {
      continue;
    }
    if (worst === null || cv > worst.cv) {
      worst = { level: entry.concurrency, cv };
    }
  }
  return {
    passed: worst !== null && worst.cv <= maxCv,
    worst,
    expected: `每个档位的吞吐 CV <= ${maxCv}`,
    actual: worst === null ? '无可用样本' : `最差 c=${worst.level} CV=${worst.cv}`,
  };
}
