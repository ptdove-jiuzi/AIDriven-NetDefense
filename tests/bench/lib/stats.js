/**
 * lib/stats.js — 统计工具。
 *
 * 纪律：
 * 1. **分位数用精确秩，不用直方图**。直方图分桶会把 p99 抹平成分桶边界，
 *    看起来"很稳"，实际上把尾延迟的退化藏了。这里保存全部原始样本再排序。
 * 2. **只报均值是不够的**。所有对外数字同时给 count/p50/p90/p99/max，
 *    因为"平均 2ms、p99 800ms"和"平均 2ms、p99 3ms"是完全不同的系统。
 * 3. **分位数方法写进结果**，让读者能复算。nearest-rank 的定义写在
 *    {@link percentile} 里，输出的 `method` 字段会带出去。
 */

/** 对外声明使用的分位数方法，避免读者猜。 */
export const PERCENTILE_METHOD = 'nearest-rank(sort-asc, rank=ceil(p/100*n), 1-based)';

/**
 * 升序排序副本。
 *
 * @param {ArrayLike<number>} values 数值样本。
 * @returns {number[]} 排序后的新数组。
 */
export function sortedCopy(values) {
  const output = Array.from(values);
  output.sort((left, right) => left - right);
  return output;
}

/**
 * 精确秩分位数（nearest-rank）。
 *
 * @param {number[]} sorted 已升序排序的样本。
 * @param {number} p 百分位，0–100。
 * @returns {number} 分位数值。
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.max(1, Math.ceil((clamped / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

/**
 * 中位数。
 *
 * @param {number[]} sorted 已升序排序的样本。
 * @returns {number} 中位数。
 */
export function median(sorted) {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 汇总一组数值样本。
 *
 * @param {ArrayLike<number>} values 样本。
 * @param {{digits?: number}} [options] 保留小数位。
 * @returns {{
 *   count: number, min: number|null, max: number|null, mean: number|null,
 *   stdev: number|null, p50: number|null, p90: number|null, p95: number|null,
 *   p99: number|null, p999: number|null, sum: number, method: string
 * }} 汇总。
 */
export function summarize(values, options = {}) {
  const digits = options.digits ?? 4;
  const count = values.length;
  if (count === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      stdev: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
      p999: null,
      sum: 0,
      method: PERCENTILE_METHOD,
    };
  }
  const sorted = sortedCopy(values);
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    sum += sorted[index];
  }
  const mean = sum / count;
  let variance = 0;
  for (let index = 0; index < count; index += 1) {
    const delta = sorted[index] - mean;
    variance += delta * delta;
  }
  // 样本标准差（n-1）；count === 1 时为 0，不是 NaN。
  const stdev = count > 1 ? Math.sqrt(variance / (count - 1)) : 0;
  const round = (value) => Number(value.toFixed(digits));
  return {
    count,
    min: round(sorted[0]),
    max: round(sorted[count - 1]),
    mean: round(mean),
    stdev: round(stdev),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    p999: round(percentile(sorted, 99.9)),
    sum: round(sum),
    method: PERCENTILE_METHOD,
  };
}

/**
 * 最小二乘斜率，单位：`y_unit / 分钟`。
 *
 * 用于浸泡期间的内存趋势。斜率只是证据之一：RSS 的锯齿来自 GC 与 SQLite 页缓存，
 * 必须和"首段/末段中位数对比"一起看，不能单凭斜率判定泄漏。
 *
 * @param {Array<{t_ms: number, y: number}>} points 采样点。
 * @returns {{slope_per_minute: number, intercept: number, r2: number, n: number}|null} 拟合结果。
 */
export function linearTrend(points) {
  const n = points.length;
  if (n < 3) {
    return null;
  }
  const origin = points[0].t_ms;
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += (point.t_ms - origin) / 60000;
    sumY += point.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const point of points) {
    const x = (point.t_ms - origin) / 60000 - meanX;
    const y = point.y - meanY;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  if (sxx === 0) {
    return null;
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return {
    slope_per_minute: Number(slope.toFixed(4)),
    intercept: Number(intercept.toFixed(4)),
    r2: Number(r2.toFixed(4)),
    n,
  };
}

/**
 * 对比首段与末段的中位数，用于"是否存在持续增长"的判断。
 *
 * 取首/末各三分之一，避免用单点极值下结论。
 *
 * @param {number[]} values 按时间顺序排列的样本。
 * @returns {{first_median: number|null, last_median: number|null,
 *   delta: number|null, ratio: number|null, n_first: number, n_last: number}} 对比。
 */
export function windowCompare(values) {
  if (values.length < 6) {
    return { first_median: null, last_median: null, delta: null, ratio: null, n_first: 0, n_last: 0 };
  }
  const third = Math.max(2, Math.floor(values.length / 3));
  const first = median(sortedCopy(values.slice(0, third)));
  const last = median(sortedCopy(values.slice(values.length - third)));
  return {
    first_median: Number(first.toFixed(2)),
    last_median: Number(last.toFixed(2)),
    delta: Number((last - first).toFixed(2)),
    ratio: first === 0 ? null : Number((last / first).toFixed(4)),
    n_first: third,
    n_last: third,
  };
}

/**
 * 单调纳秒时钟读数转毫秒。
 *
 * `process.hrtime.bigint()` 不受系统时间调整影响，是唯一该用于计时的源；
 * `Date.now()` 会在 NTP 校准时跳变。
 *
 * @returns {bigint} 纳秒。
 */
export function nowNs() {
  return process.hrtime.bigint();
}

/**
 * 两个纳秒读数之差，单位毫秒（保留 6 位小数，即纳秒级精度）。
 *
 * @param {bigint} startNs 起点。
 * @param {bigint} endNs 终点。
 * @returns {number} 毫秒。
 */
export function elapsedMs(startNs, endNs) {
  return Number(endNs - startNs) / 1e6;
}

/**
 * 安全除法：分母为 0 时返回 null 而不是 Infinity，避免 JSON 里出现 `null` 之外的假数。
 *
 * @param {number} numerator 分子。
 * @param {number} denominator 分母。
 * @param {number} [digits] 小数位。
 * @returns {number|null} 比值。
 */
export function ratio(numerator, denominator, digits = 4) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return Number((numerator / denominator).toFixed(digits));
}

/**
 * 字节数转 MiB，保留 2 位。
 *
 * @param {number|null|undefined} bytes 字节。
 * @returns {number|null} MiB。
 */
export function mib(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    return null;
  }
  return Number((bytes / (1024 * 1024)).toFixed(2));
}
