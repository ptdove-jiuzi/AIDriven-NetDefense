/**
 * lib/auth-lockout.js — 认证限流"误伤合法客户端"的判据与探针。
 *
 * 为什么单独成文件（H-1，`status/M9-PERF-FINAL.md` §8）：
 *
 * 认证限流 P1 修复（`apps/daemon/src/api/auth.js` 先验凭据、后查失败桶）在基准里
 * **完全没有守护**。回退到旧顺序后：
 *
 * - `daemon.backpressure_rejects` 的 `actual` 逐字节相同（都是 `{"401":5,"429":7}`）——
 *   它只证明"错 token 仍被限流"，对"限流是否误伤合法客户端"零鉴别力；
 * - `daemon.auth_lockout_expires`（blocker）在修复前后**恒真**；
 * - 唯一会变的那条是 `warn`，而 `evaluateChecks` 只看 `blocker` → 仍然是 `verdict=pass`。
 *
 * 实测（2026-11-03 19:22，临时副本回退 auth 顺序、判据未改）：
 * `verdict=pass checks=29 failures=0 warnings=1` —— 门禁空转，被证实。
 *
 * 因此这里给出**能失败**的判据，按四个时点采样（生产默认 60 s 失败窗口）：
 *
 * - `+0 / +5 / +25 / +35 s`：连发 5 个错 token 之后，带**真 token** 的请求必须全部 200。
 *   旧顺序下这四点全部 429（`M9-PERF-FINAL` §7 的"修复前"列）。
 * - 每次合法请求之后立刻再发一个错 token：必须仍是 429。这一条防的是"把限流删掉"
 *   也能让上一条变绿——那会把 P1 修复换成 P0 退化。
 *
 * 判据与采样分开：`runAuthLockoutProbe()` 只负责按时点发请求（可注入 `request` / `sleep`），
 * `evaluate*()` 是纯函数，`self-check.test.js` 用假样本驱动它们，证明断言不是恒真。
 *
 * 安全：本模块只接受"已构造好的请求头"，不读 token、不记录任何请求头或响应体。
 */

/** 采样时点（相对"错 token 连发结束"的毫秒偏移）。生产默认窗口 60 s，四点全在窗口内。 */
export const LOCKOUT_PROBE_OFFSETS_MS = Object.freeze([0, 5000, 25000, 35000]);

/** 连发的错 token 数，等于生产默认 `api.authFailureLimit`。 */
export const LOCKOUT_PROBE_WRONG_BURST = 5;

/** "限流仍然生效"至少要几次观测才不算空断言（一次可能是巧合）。 */
export const MIN_THROTTLE_OBSERVATIONS = 2;

/**
 * 探针从"连发结束"到最后一个采样点的名义跨度（+1 s 余量）。
 *
 * 生产默认失败窗口必须装得下它，否则四点里靠后的那几个早就过期放行，
 * 探针对"误伤合法客户端"的鉴别力会消失。
 */
export const LOCKOUT_PROBE_SPAN_MS = LOCKOUT_PROBE_OFFSETS_MS[LOCKOUT_PROBE_OFFSETS_MS.length - 1] + 1000;

/**
 * 期望文本（纯常量，不读任何实测值）。
 *
 * @param {readonly number[]} [offsets] 采样时点。
 * @returns {string} 例如 `+0/+5/+25/+35 s 四点合法请求全部 200`。
 */
export function lockoutProbeExpectation(offsets = LOCKOUT_PROBE_OFFSETS_MS) {
  return `${offsets.map((ms) => `+${ms / 1000}`).join('/')} s 四点合法请求全部 200`;
}

/**
 * 睡到指定墙钟时刻。
 *
 * 用绝对截止时刻而不是"每次都 sleep(5000)"：后者会把每次请求的耗时累加进时点，
 * 35 s 的采样点可能漂到 38 s，判据名义上测 +35 s、实际测的是别的时刻。
 *
 * @param {number} deadline 截止时刻（`Date.now()` 口径）。
 * @param {(ms: number) => Promise<void>} [sleep] 可注入的睡眠实现（自检用压缩时标）。
 * @returns {Promise<void>} 完成。
 */
async function sleepUntil(deadline, sleep) {
  const remaining = deadline - Date.now();
  if (remaining > 0) {
    await sleep(remaining);
  }
}

/**
 * 按时点驱动一次探针。
 *
 * @param {{
 *   request: (headers: Record<string, string>) => Promise<{status: number}>,
 *   legitimateHeaders: Record<string, string>,
 *   wrongHeaders: Record<string, string>,
 *   offsets?: readonly number[],
 *   burst?: number,
 *   sleep?: (ms: number) => Promise<void>
 * }} options 选项。
 * @returns {Promise<{
 *   burst_statuses: number[],
 *   samples: Array<{offset_ms: number, elapsed_ms: number, since_burst_ms: number, status: number}>,
 *   throttle: Array<{after_offset_ms: number, since_burst_ms: number, status: number}>,
 *   nominal_window_ms: number|null
 * }>} 采样结果。
 */
export async function runAuthLockoutProbe(options) {
  if (typeof options?.request !== 'function') {
    throw new Error('runAuthLockoutProbe requires a request function');
  }
  const offsets = options.offsets ?? LOCKOUT_PROBE_OFFSETS_MS;
  const burst = options.burst ?? LOCKOUT_PROBE_WRONG_BURST;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));

  const burstStatuses = [];
  for (let index = 0; index < burst; index += 1) {
    const response = await options.request(options.wrongHeaders);
    burstStatuses.push(response.status);
  }
  const burstEnded = Date.now();
  const firstOffset = offsets[0];
  const lastOffset = offsets[offsets.length - 1];

  const samples = [];
  const throttle = [];
  for (const offset of offsets) {
    await sleepUntil(burstEnded + offset, sleep);
    const response = await options.request(options.legitimateHeaders);
    samples.push({
      offset_ms: offset,
      elapsed_ms: Date.now() - burstEnded,
      since_burst_ms: Date.now() - burstEnded,
      status: response.status,
    });
    // 只在首末两点各补一次"合法请求之后的错 token"：既覆盖"紧接着成功之后"，
    // 也覆盖"三次成功、22 秒之后仍在同一窗口内"，两点都不需要额外等待。
    if (offset === firstOffset || offset === lastOffset) {
      const wrong = await options.request(options.wrongHeaders);
      throttle.push({
        after_offset_ms: offset,
        since_burst_ms: Date.now() - burstEnded,
        status: wrong.status,
      });
    }
  }

  return {
    burst_statuses: burstStatuses,
    samples,
    throttle,
    nominal_window_ms: options.windowMs ?? null,
  };
}

/**
 * 判定"合法客户端在锁定期内未被误伤"。
 *
 * 缺时点必须判失败：只测到 +0 的轮次不能因为"那一点是 200"就通过 —— 那正是旧实现
 * 用单点观测冒充结论的机制。
 *
 * @param {{
 *   samples: Array<{offset_ms: number, status: number}>,
 *   offsets?: readonly number[],
 *   session?: {burst_statuses?: number[], window_ms?: number|null}
 * }} options 参数。
 * @returns {{passed: boolean, expected: string, actual: string,
 *   missing_offsets: number[], rejected_offsets: Array<{offset_ms: number, status: number}>}} 判定。
 */
export function evaluateAuthLockoutProbe(options) {
  const offsets = options?.offsets ?? LOCKOUT_PROBE_OFFSETS_MS;
  const samples = Array.isArray(options?.samples) ? options.samples : [];
  const byOffset = new Map();
  for (const sample of samples) {
    if (typeof sample?.offset_ms === 'number') {
      byOffset.set(sample.offset_ms, sample);
    }
  }
  const missing = offsets.filter((offset) => !byOffset.has(offset));
  const rejected = [];
  for (const offset of offsets) {
    const sample = byOffset.get(offset);
    if (sample !== undefined && sample.status !== 200) {
      rejected.push({ offset_ms: offset, status: sample.status });
    }
  }
  const unexpected = samples
    .filter((sample) => !offsets.includes(sample?.offset_ms))
    .map((sample) => sample?.offset_ms ?? null);

  const description = offsets.map((offset) => {
    const sample = byOffset.get(offset);
    return `+${offset / 1000}s=${sample === undefined ? '—' : sample.status}`;
  }).join(' ');

  return {
    passed: missing.length === 0 && rejected.length === 0 && unexpected.length === 0,
    expected: lockoutProbeExpectation(offsets),
    actual: unexpected.length === 0
      ? description
      : `${description}（多出未约定时点 ${unexpected.join('/')}）`,
    missing_offsets: missing,
    rejected_offsets: rejected,
  };
}

/**
 * 判定"限流仍然生效"：合法请求之后的错 token 必须仍是 429。
 *
 * 这一条不是可选项：只断言"合法请求 200"的话，把限流整段删掉同样会绿 ——
 * 那就把 P1 修复换成了 P0 退化（防爆破能力归零）。
 *
 * @param {{throttle: Array<{after_offset_ms: number, status: number}>}} options 参数。
 * @returns {{passed: boolean, expected: string, actual: string, leaks: number[]}} 判定。
 */
export function evaluateGuessThrottle(options) {
  const observed = Array.isArray(options?.throttle)
    ? options.throttle.filter((entry) => typeof entry?.status === 'number')
    : [];
  const leaks = observed.filter((entry) => entry.status !== 429).map((entry) => entry.status);
  return {
    passed: observed.length >= MIN_THROTTLE_OBSERVATIONS && leaks.length === 0,
    expected: `合法请求之后的错误 token 仍返回 429（至少 ${MIN_THROTTLE_OBSERVATIONS} 次观测）`,
    actual: observed.length === 0
      ? '无观测'
      : observed.map((entry) => `+${entry.after_offset_ms / 1000}s 后=${entry.status}`).join(' '),
    leaks,
  };
}

/**
 * 轮换错 token 的探针：5 个**互不相同**的错 token，再来第 6 个也必须是 429。
 *
 * 这条堵的是独立复核发现的第二条假绿通道：把失败桶改成**按 token 记账**。
 * 那样每个 token 各有一个全新配额，攻击者轮换 token 就能无限猜；而上面两条判据
 * 都用同一个错 token 连发，看到的是"5 次 + 第 6 次仍 429"，照样全绿。
 * 被测实现的注释明确写着桶按 peer 记账、不许由 token 派生（否则轮换即可续配额），
 * 所以这条不是推测出来的需求，是代码已声明的性质。
 *
 * 不等待：6 个请求在同一瞬间发完，全部落在任何合理窗口内。
 *
 * @param {{
 *   request: (headers: Record<string, string>) => Promise<{status: number}>,
 *   wrongHeaders: Array<Record<string, string>>,
 *   legitimateHeaders: Record<string, string>
 * }} options 选项。
 * @returns {Promise<{wrong_statuses: number[], quota_probe_status: number|null,
 *   legitimate_status: number|null}>} 采样。
 */
export async function runRotatingTokenProbe(options) {
  if (typeof options?.request !== 'function') {
    throw new Error('runRotatingTokenProbe requires a request function');
  }
  const wrong = Array.isArray(options.wrongHeaders) ? options.wrongHeaders : [];
  if (wrong.length !== LOCKOUT_PROBE_WRONG_BURST) {
    throw new Error(`runRotatingTokenProbe requires exactly ${LOCKOUT_PROBE_WRONG_BURST} distinct wrong tokens`);
  }
  if (options.quotaHeaders === undefined) {
    // 复用同一个 token 就测不出"按 token 记账"——那等于什么都没测。
    throw new Error('runRotatingTokenProbe requires a quotaHeaders entry distinct from wrongHeaders');
  }
  const wrongStatuses = [];
  for (const headers of wrong) {
    const response = await options.request(headers);
    wrongStatuses.push(response.status);
  }
  // 第 6 个，且是一个**新的**错 token：如果桶按 token 记账，这个 token 的桶是空的 → 401（假绿）。
  const quota = await options.request(options.quotaHeaders);
  const legitimate = await options.request(options.legitimateHeaders);
  return {
    wrong_statuses: wrongStatuses,
    quota_probe_status: quota.status,
    legitimate_status: legitimate.status,
  };
}

/**
 * 判定"轮换错 token 不能续配额"。
 *
 * @param {{wrong_statuses: number[], quota_probe_status: number|null,
 *   legitimate_status: number|null}} result 采样。
 * @returns {{passed: boolean, expected: string, actual: string, reasons: string[]}} 判定。
 */
export function evaluateRotatingTokenQuota(result) {
  const wrong = Array.isArray(result?.wrong_statuses) ? result.wrong_statuses : [];
  const quota = result?.quota_probe_status ?? null;
  const legitimate = result?.legitimate_status ?? null;
  const reasons = [];
  if (wrong.length < LOCKOUT_PROBE_WRONG_BURST) {
    reasons.push(`只有 ${wrong.length} 个错 token，不足以打满配额`);
  }
  if (wrong.some((status) => status !== 401)) {
    reasons.push(`前 ${LOCKOUT_PROBE_WRONG_BURST} 个不同错 token 必须都是 401，实测 ${JSON.stringify(wrong)}`);
  }
  if (quota !== 429) {
    reasons.push(`第 ${wrong.length + 1} 个（又一个新 token）必须是 429，实测 ${quota}`);
  }
  if (legitimate !== 200) {
    reasons.push(`合法 token 必须仍是 200，实测 ${legitimate}`);
  }
  return {
    passed: reasons.length === 0,
    expected: `${LOCKOUT_PROBE_WRONG_BURST} 个不同错 token（并轮换 X-Forwarded-For）后，再换一组新值仍须 429（桶键不由客户端输入派生）`,
    actual: `错 token=${JSON.stringify(wrong)} 新 token=${quota} 合法=${legitimate}`,
    reasons,
  };
}

/**
 * 判定认证限流的生产默认值没有被弱化。
 *
 * 独立复核发现的另一条假绿通道：把 `config.js` 的 `authFailureLimit` 调到 1000、
 * `authFailureWindowMs` 调到 1 s，探针实例仍用显式传入的 5/60 s，因此四条 auth 判据
 * 全部照绿 —— 但那等于把防爆破关掉了。这里直接断言生效默认值。
 *
 * 允许**收紧**（更小的 limit、更长的 window），只拦**弱化**。
 *
 * @param {{limit: number|null, windowMs: number|null, minWindowMs?: number}} options 参数。
 * @returns {{passed: boolean, expected: string, actual: string}} 判定。
 */
export function evaluateAuthDefaults(options) {
  const limit = typeof options?.limit === 'number' ? options.limit : null;
  const windowMs = typeof options?.windowMs === 'number' ? options.windowMs : null;
  const minWindowMs = options?.minWindowMs ?? LOCKOUT_PROBE_SPAN_MS;
  const limitOk = limit !== null && limit <= LOCKOUT_PROBE_WRONG_BURST;
  const windowOk = windowMs !== null && windowMs >= minWindowMs;
  return {
    passed: limitOk && windowOk,
    expected: `默认 authFailureLimit <= ${LOCKOUT_PROBE_WRONG_BURST} 且 authFailureWindowMs >= ${minWindowMs}`,
    actual: `limit=${limit} window_ms=${windowMs}`,
  };
}
