/**
 * scenarios/daemon-api.js — daemon 只读健康/状态接口的延迟、并发与背压。
 *
 * 只测三条**只读**路由：`/healthz`、`/readyz`、`/api/v1/status`。不测 poll 等
 * 会改状态的端点——那属于写路径，且会让"延迟"混进采集耗时。
 *
 * 三个刻意的设计：
 *
 * 1. **keep-alive 连接池**。每条请求新建 TCP 连接会把握手成本算进延迟，
 *    而本机 console 实际是复用连接的。用与并发度相同的 `maxSockets` 池。
 * 2. **分位数而非均值**。均值会把"1% 的请求慢了 100 倍"藏起来。
 * 3. **背压用真实的准入拒绝来验证**，不是靠"请求变慢了"来推断：
 *    用错误 token 打满 `authFailureLimit`，观察 daemon 是否返回 429 而不是继续放行，
 *    并验证拒绝之后**正常请求仍然成功**（拒绝不能变成自伤）。
 * 4. **并发每档重复 3 次取中位数**。单次测量的轮间 CV 实测 9.7%–34.8%，用它当门禁
 *    等于用一次抛硬币决定构建颜色。采样与判据都在 `lib/concurrency.js`，
 *    期望文本是常量（不读实测值），缺档必须判失败。详见该文件头。
 *
 * 安全：`/api/v1/status` 的响应里带 `csrf_token`。本文件只挑选需要的字段入报告，
 * **不落盘任何 token、Authorization 头或完整响应体**。
 */

import http from 'node:http';

import { ingestTelemetry, migrate, openStore } from '../../../packages/event-store/src/index.js';
import { createDaemon } from '../../../apps/daemon/src/index.js';
import { createEventStoreAdapter } from '../../../apps/daemon/src/adapters/event-store.js';
import { loadConfig } from '../../../apps/daemon/src/config.js';
import {
  LOCKOUT_PROBE_OFFSETS_MS,
  LOCKOUT_PROBE_SPAN_MS,
  LOCKOUT_PROBE_WRONG_BURST,
  evaluateAuthDefaults,
  evaluateAuthLockoutProbe,
  evaluateGuessThrottle,
  evaluateRotatingTokenQuota,
  runAuthLockoutProbe,
  runRotatingTokenProbe,
} from '../lib/auth-lockout.js';
import {
  ABORT_P99_BUDGET_MS,
  ABSOLUTE_P99_BUDGET_MS,
  BASE_LEVEL,
  CONCURRENCY_LEVELS,
  MAX_MEDIAN_CV,
  MIN_PER_WORKER,
  REPEATS,
  SCALE_MIN_RATIO,
  TOP_LEVEL,
  evaluateMeasurementStability,
  evaluateScaling,
  perLevelRequests,
  runConcurrencySweep,
} from '../lib/concurrency.js';
import { makeBenchRulePack } from '../lib/rulepack.js';
import { elapsedMs, nowNs, summarize } from '../lib/stats.js';
import { createBenchClock, createWorkload } from '../lib/synthetic.js';
import { assertHarmlessPath } from '../lib/tempdir.js';

/** 每个档位的规模。并发上限 32：本机 12 逻辑核，再高只是在测排队长度。 */
const SCALE = Object.freeze({
  quick: { seedEvents: 1500, sequentialPerRoute: 120, perLevel: 120 },
  standard: { seedEvents: 4000, sequentialPerRoute: 250, perLevel: 200 },
});

/** 只读路由。 */
const ROUTES = Object.freeze(['/healthz', '/readyz', '/api/v1/status']);

/**
 * 认证限流探针实例的失败窗口：**生产默认值**（`config.js` 的 60000）。
 *
 * 四点采样（+0/+5/+25/+35 s）必须全部落在同一个窗口内，探针才有鉴别力：
 * 窗口若缩到 2 s，旧顺序只在 +0 一个点返回 429，其余三点早就过期放行。
 */
const PROBE_AUTH_FAILURE_WINDOW_MS = 60000;

/** 探针实例的库内事件数：它不检查库内容，只需要一个能正常应答的真实库。 */
const PROBE_SEED_EVENTS = 100;

/**
 * 发一个 HTTP 请求。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {string} pathname 路径。
 * @param {{headers?: Record<string, string>}} [options] 选项。
 * @returns {Promise<{status: number, body: object|null, bytes: number}>} 结果。
 */
function request(agent, port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', agent, headers: options.headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = text.length === 0 ? null : JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body, bytes: Buffer.byteLength(text) });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 顺序测量一条路由。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {string} pathname 路径。
 * @param {number} count 次数。
 * @param {Record<string, string>} headers 请求头。
 * @returns {Promise<{latencies: number[], failures: number, statuses: Record<string, number>,
 *   bodies: object[], bytes: number[]}>} 结果。
 */
async function measureSequential(agent, port, pathname, count, headers) {
  const latencies = new Array(count);
  const bodies = new Array(count);
  const bytes = new Array(count);
  const statuses = {};
  let failures = 0;
  for (let index = 0; index < count; index += 1) {
    const start = nowNs();
    const response = await request(agent, port, pathname, { headers });
    latencies[index] = elapsedMs(start, nowNs());
    statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    if (response.status !== 200) {
      failures += 1;
    }
    bodies[index] = response.body;
    bytes[index] = response.bytes;
  }
  return { latencies, failures, statuses, bodies, bytes };
}

/**
 * 在给定并发下测量一条路由。
 *
 * 用固定数量的 worker 平分请求，而不是"每次发 N 个 Promise"：后者会在一瞬间把
 * 全部请求塞进 socket 队列，测到的是 Node 的队列深度，不是服务端并发能力。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {string} pathname 路径。
 * @param {number} concurrency 并发数。
 * @param {number} total 总请求数。
 * @param {Record<string, string>} headers 请求头。
 * @returns {Promise<{latencies: number[], failures: number, statuses: Record<string, number>,
 *   wall_ms: number}>} 结果。
 */
async function measureConcurrent(agent, port, pathname, concurrency, total, headers) {
  const latencies = [];
  const statuses = {};
  let failures = 0;
  const wallStart = nowNs();
  const perWorker = Math.floor(total / concurrency);
  const workers = new Array(concurrency);
  for (let worker = 0; worker < concurrency; worker += 1) {
    workers[worker] = (async () => {
      const local = new Array(perWorker);
      for (let index = 0; index < perWorker; index += 1) {
        const start = nowNs();
        const response = await request(agent, port, pathname, { headers });
        local[index] = elapsedMs(start, nowNs());
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status !== 200) {
          failures += 1;
        }
      }
      return local;
    })();
  }
  const results = await Promise.all(workers);
  const wallMs = elapsedMs(wallStart, nowNs());
  for (const local of results) {
    for (const value of local) {
      latencies.push(value);
    }
  }
  return { latencies, failures, statuses, wall_ms: Number(wallMs.toFixed(3)) };
}

/**
 * 校验 status 响应体的关键字段。
 *
 * 只看"HTTP 200"是不够的：一个返回空对象的 200 和真实状态负载在延迟上没有区别，
 * 但后者才是被测的东西。
 *
 * @param {object|null} body 响应体。
 * @returns {{valid: boolean, reasons: string[]}} 校验结果。
 */
function validateStatusBody(body) {
  const reasons = [];
  if (body === null || typeof body !== 'object') {
    return { valid: false, reasons: ['body is not an object'] };
  }
  if (body.schema_version !== '1.0') {
    reasons.push('schema_version missing');
  }
  if (typeof body.lifecycle !== 'string') {
    reasons.push('lifecycle missing');
  }
  if (body.health === null || typeof body.health !== 'object' || typeof body.health.status !== 'string') {
    reasons.push('health.status missing');
  }
  if (body.store === null || typeof body.store !== 'object' || body.store.kind !== 'sqlite') {
    reasons.push('store.kind is not sqlite');
  }
  if (body.counters === null || typeof body.counters !== 'object'
    || typeof body.counters.events_received !== 'number') {
    reasons.push('counters.events_received missing');
  }
  if (body.pipeline === null || typeof body.pipeline !== 'object') {
    reasons.push('pipeline missing');
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * 准备一个带真实 SQLite 存储的临时 daemon。
 *
 * 先直接用 event-store 灌入合成事件再关库，然后让 daemon 打开同一个文件：
 * 这样 `/api/v1/status` 里的 `store` 段是真实行数与真实文件大小，
 * 而不是"空库 + 零计数"——后者无论实现多慢都会显得很快。
 *
 * @param {{tempRoot: object, name: string, seedEvents: number, seed: number, token: string,
 *   authFailureWindowMs?: number, authFailureLimit?: number}} options 选项。
 * @returns {Promise<{daemon: object, port: number, storePath: string, cleanup: () => Promise<void>}>} 句柄。
 */
async function prepareDaemon(options) {
  const storePath = assertHarmlessPath(options.tempRoot.dir(`${options.name}/aegis-bench.db`), 'daemon store path');
  const clock = createBenchClock();
  const workload = createWorkload({ seed: options.seed, label: `daemon-api/${options.name}` });

  // 刻意不传 auditKey：daemon 的 `createEventStoreAdapter` 打开时也不传，
  // 两边都不传才会落在同一个审计模式（结构校验）上。如果这里给了 key、daemon 没给，
  // 库里会变成 `mixed` 模式——那是夹具自己制造的错位，不是被测行为。
  const seedStore = openStore({ path: storePath, clock });
  try {
    migrate(seedStore);
    for (let index = 1; index <= options.seedEvents; index += 1) {
      ingestTelemetry(seedStore, { event: workload.event(index) });
    }
  } finally {
    seedStore.close();
  }

  const { pack } = makeBenchRulePack({ seed: options.seed });
  const failureLimit = options.authFailureLimit ?? 5;
  const config = loadConfig({
    dataDir: assertHarmlessPath(options.tempRoot.dir(options.name), 'daemon data dir'),
    mode: 'mock',
    detection: { rulePack: pack },
    // 两个实例，窗口不同，各有各的理由：
    //
    // - 主实例用 2 s：它要同时验证"打满后必须 429"和"窗口过期后恢复 200"。
    //   窗口 60 s 时这两件事在测试里互斥——第一条要求 429、第二条要求 200，
    //   基准就会永久红（那是把两种策略取向写成两个互斥的 blocker）。
    // - 探针实例用生产默认 60 s（见 `runAuthLockoutProbe`）：它只在窗口内采样，
    //   四点（+0/+5/+25/+35 s）必须全落在同一个窗口里，否则旧顺序在 +5 s 之后
    //   就已经过期，探针失去鉴别力。
    api: {
      port: 0,
      token: options.token,
      authFailureLimit: failureLimit,
      authFailureWindowMs: options.authFailureWindowMs ?? 2000,
    },
    // tickMs 拉长到一小时：本场景只测只读接口，不引入调度器写入干扰。
    scheduler: { tickMs: 3600000 },
    logging: { level: 'silent' },
  });
  const store = createEventStoreAdapter({
    path: storePath,
    allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
  });
  const daemon = createDaemon({ config, store, sources: [] });
  const started = await daemon.start();
  if (started.address === null) {
    await daemon.stop('bench-failure');
    throw new Error('daemon did not bind a control API port');
  }
  return {
    daemon,
    port: started.address.port,
    storePath,
    cleanup: async () => {
      await daemon.stop('bench-done');
    },
  };
}

/**
 * 运行 daemon API 场景。
 *
 * @param {{seed: number, profile: 'quick'|'standard', tempRoot: object}} options 选项。
 * @returns {Promise<{scenario: object, checks: object[], raw: object}>} 场景结果。
 */
export async function runDaemonApiScenario(options) {
  const scale = SCALE[options.profile] ?? SCALE.quick;
  // token 只在内存里用，长度满足 MIN_TOKEN_LENGTH；绝不写进报告。
  const token = `bench-token-${options.seed}-0123456789abcdef`;
  const headers = { authorization: `Bearer ${token}` };
  const checks = [];
  const observations = [];
  const raw = {};

  const prepared = await prepareDaemon({
    tempRoot: options.tempRoot,
    name: 'quiet',
    seedEvents: scale.seedEvents,
    seed: options.seed,
    token,
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  /** 认证限流探针专用的第二个 daemon（生产默认 60 s 窗口）。 */
  let probePrepared = null;
  /** 轮换错 token 探针的第三个 daemon（必须是干净桶，不能与上一个共享失败计数）。 */
  let quotaPrepared = null;
  try {
    // --- 预热：JIT、SQLite 页缓存、连接池都要先热起来 ---------------------
    for (let index = 0; index < 30; index += 1) {
      await request(agent, prepared.port, '/api/v1/status', { headers });
    }

    // --- 顺序基线 ---------------------------------------------------------
    const sequential = {};
    for (const route of ROUTES) {
      sequential[route] = await measureSequential(
        agent,
        prepared.port,
        route,
        scale.sequentialPerRoute,
        route.startsWith('/api/v1') ? headers : {},
      );
    }
    const statusBodies = sequential['/api/v1/status'].bodies;
    const bodyValidations = statusBodies.map((body) => validateStatusBody(body));
    const invalidBodies = bodyValidations.filter((entry) => entry.valid === false);
    const statusBody = statusBodies[statusBodies.length - 1];

    // --- 并发扫描（每档重复 REPEATS 次，取中位数与变异系数） ---------------
    const baselineP99 = summarize(sequential['/api/v1/status'].latencies).p99;
    const sweepResult = await runConcurrencySweep({
      levels: CONCURRENCY_LEVELS,
      repeats: REPEATS,
      perLevel: scale.perLevel,
      // 刹车用常量绝对上限，不用"顺序基线的 N 倍"：后者低于合法排队水平。
      abortP99Ms: ABORT_P99_BUDGET_MS,
      measure: ({ concurrency, total }) => measureConcurrent(
        agent,
        prepared.port,
        '/api/v1/status',
        concurrency,
        total,
        headers,
      ),
    });
    const sweep = sweepResult.sweep;
    const abortedAt = sweepResult.abortedAt;

    // --- 背压：准入拒绝必须真的拒绝，且不能自伤 ---------------------------
    const badTokenResults = [];
    for (let index = 0; index < 12; index += 1) {
      const response = await request(agent, prepared.port, '/api/v1/status', {
        headers: { authorization: 'Bearer bench-wrong-token-000000000000' },
      });
      badTokenResults.push(response.status);
    }
    const badStatuses = {};
    for (const status of badTokenResults) {
      badStatuses[status] = (badStatuses[status] ?? 0) + 1;
    }
    // 锁定期内：合法请求会被一并拒绝（这是被测实现的真实行为，作为观察记录）。
    const duringLockout = await request(agent, prepared.port, '/api/v1/status', { headers });
    // 等窗口过期后再试一次：这一步是**可满足**的断言，用来验证"锁定会恢复"。
    await new Promise((resolve) => {
      setTimeout(resolve, 2200);
    });
    const afterWindow = await request(agent, prepared.port, '/api/v1/status', { headers });

    const finalStatus = await request(agent, prepared.port, '/api/v1/status', { headers });

    // --- 认证限流探针：合法客户端在锁定期内不得被误伤 ---------------------
    // 这是 H-1 的硬门禁。它必须用**独立实例 + 生产默认 60 s 窗口**：
    // 主实例的窗口缩到 2 s 是为了验证"会过期"，而这里的四点
    // （+0/+5/+25/+35 s）必须落在同一个窗口内，旧顺序才会在四点全部 429。
    // 放在所有延迟/并发测量之后，35 s 的等待不会污染上面的数字。
    probePrepared = await prepareDaemon({
      tempRoot: options.tempRoot,
      name: 'lockout-probe',
      seedEvents: PROBE_SEED_EVENTS,
      seed: options.seed,
      token,
      authFailureLimit: LOCKOUT_PROBE_WRONG_BURST,
      authFailureWindowMs: PROBE_AUTH_FAILURE_WINDOW_MS,
    });
    const probeAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    let lockoutProbe;
    try {
      lockoutProbe = await runAuthLockoutProbe({
        request: (probeHeaders) => request(
          probeAgent,
          probePrepared.port,
          '/api/v1/status',
          { headers: probeHeaders },
        ),
        legitimateHeaders: headers,
        wrongHeaders: { authorization: 'Bearer bench-wrong-token-000000000000' },
        windowMs: PROBE_AUTH_FAILURE_WINDOW_MS,
      });
    } finally {
      probeAgent.destroy();
    }
    const lockoutLegit = evaluateAuthLockoutProbe({ samples: lockoutProbe.samples });
    const lockoutThrottle = evaluateGuessThrottle({ throttle: lockoutProbe.throttle });

    // --- 轮换错 token：桶必须按 peer 记账，不能按 token 记账 -----------------
    // 上面两条判据都用**同一个**错 token 连发，所以"把桶改成按 token 记账"这种退化
    // 它们看不见（每个 token 各有一个新配额 → 第 6 个恰好是同一个 token 时仍 429，
    // 而攻击者轮换 token 就能无限猜）。这里用 5 个互不相同的错 token 再换第 6 个新的：
    // 按 peer 记账 → 429；按 token 记账 → 401。
    quotaPrepared = await prepareDaemon({
      tempRoot: options.tempRoot,
      name: 'quota-probe',
      seedEvents: PROBE_SEED_EVENTS,
      seed: options.seed,
      token,
      authFailureLimit: LOCKOUT_PROBE_WRONG_BURST,
      authFailureWindowMs: PROBE_AUTH_FAILURE_WINDOW_MS,
    });
    const quotaAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    let quotaProbe;
    try {
      quotaProbe = await runRotatingTokenProbe({
        request: (probeHeaders) => request(
          quotaAgent,
          quotaPrepared.port,
          '/api/v1/status',
          { headers: probeHeaders },
        ),
        // 5 个互不相同 + 第 6 个又是新的；只用占位串，不含真实凭据。
        // 每个请求再带一个**互不相同**的 `X-Forwarded-For`：这条同时守住"桶键不得由
        // 任何客户端可控输入派生"。独立复核实测：把桶键换成 XFF 后，轮换该头即可做到
        // 20 次猜测全 401（一次 429 都没有），而只轮换 token 的探针看不出来。
        wrongHeaders: Array.from({ length: LOCKOUT_PROBE_WRONG_BURST }, (_unused, index) => ({
          authorization: `Bearer bench-rotating-wrong-${index}-000000000000`,
          'x-forwarded-for': `203.0.113.${index + 1}`,
        })),
        quotaHeaders: {
          authorization: 'Bearer bench-rotating-wrong-final-000000000000',
          'x-forwarded-for': '203.0.113.250',
        },
        legitimateHeaders: headers,
      });
    } finally {
      quotaAgent.destroy();
    }
    const quotaVerdict = evaluateRotatingTokenQuota(quotaProbe);

    // --- 生产默认值：探针实例用的是显式 5 / 60 s，因此"把默认值改弱"它看不见 ----
    // 只读一条默认配置：mode=mock 是为了不触发"full 模式必须给规则包"的校验，
    // api 段的默认值与 mode 无关。
    const effectiveDefaults = loadConfig({
      dataDir: assertHarmlessPath(options.tempRoot.dir('defaults-probe'), 'defaults probe dir'),
      mode: 'mock',
      detection: { rulePack: makeBenchRulePack({ seed: options.seed }).pack },
      logging: { level: 'silent' },
    });
    const defaultsVerdict = evaluateAuthDefaults({
      limit: effectiveDefaults.api?.authFailureLimit ?? null,
      windowMs: effectiveDefaults.api?.authFailureWindowMs ?? null,
    });

    const seqStatus = summarize(sequential['/api/v1/status'].latencies);
    const seqHealth = summarize(sequential['/healthz'].latencies);
    const seqReady = summarize(sequential['/readyz'].latencies);
    const totalMeasured = ROUTES.reduce((sum, route) => sum + sequential[route].latencies.length, 0)
      + sweep.reduce((sum, entry) => sum + entry.requests_total, 0);
    const totalFailures = ROUTES.reduce((sum, route) => sum + sequential[route].failures, 0)
      + sweep.reduce((sum, entry) => sum + entry.failures, 0);
    // "最高档"是常量（c=32），不是"实测到的最后一档"。旧实现用后者，
    // 刹车在 c=8 提前终止时延迟预算的观察对象就悄悄从中变成了 c=8。
    const topEntry = sweep.find((entry) => entry.concurrency === TOP_LEVEL) ?? null;
    const baseEntry = sweep.find((entry) => entry.concurrency === BASE_LEVEL) ?? null;
    const measuredLevels = sweep.map((entry) => entry.concurrency);
    const scaling = evaluateScaling({ sweep });
    const stability = evaluateMeasurementStability({ sweep });

    raw.sequential = Object.fromEntries(ROUTES.map((route) => [route, {
      latency_ms: summarize(sequential[route].latencies),
      statuses: sequential[route].statuses,
      bytes_p50: summarize(sequential[route].bytes).p50,
    }]));
    raw.sweep = sweep;
    raw.backpressure = {
      wrong_token_statuses: badStatuses,
      during_lockout_status: duringLockout.status,
      after_window_status: afterWindow.status,
      auth_failure_limit: 5,
      auth_failure_window_ms: 2000,
    };
    raw.auth_lockout_probe = {
      window_ms: PROBE_AUTH_FAILURE_WINDOW_MS,
      wrong_burst: LOCKOUT_PROBE_WRONG_BURST,
      burst_statuses: lockoutProbe.burst_statuses,
      offsets_ms: [...LOCKOUT_PROBE_OFFSETS_MS],
      samples: lockoutProbe.samples,
      throttle: lockoutProbe.throttle,
      verdict: { legitimate_spared: lockoutLegit.passed, guesses_still_throttled: lockoutThrottle.passed },
    };
    raw.auth_quota_probe = {
      window_ms: PROBE_AUTH_FAILURE_WINDOW_MS,
      wrong_statuses: quotaProbe.wrong_statuses,
      quota_probe_status: quotaProbe.quota_probe_status,
      legitimate_status: quotaProbe.legitimate_status,
      verdict: quotaVerdict.passed,
    };
    raw.auth_defaults = {
      auth_failure_limit: effectiveDefaults.api?.authFailureLimit ?? null,
      auth_failure_window_ms: effectiveDefaults.api?.authFailureWindowMs ?? null,
      verdict: defaultsVerdict.passed,
    };
    raw.status_payload_shape = statusBody === null ? null : {
      schema_version: statusBody.schema_version,
      lifecycle: statusBody.lifecycle,
      health_status: statusBody.health?.status,
      store_kind: statusBody.store?.kind,
      store_open: statusBody.store?.open,
      store_events: statusBody.store?.events ?? null,
      store_db_bytes: statusBody.store?.database_bytes ?? null,
      counters: statusBody.counters ?? null,
      uptime_ms: statusBody.uptime_ms ?? null,
    };

    const metrics = [
      { name: 'status 顺序 p50', value: seqStatus.p50, unit: 'ms' },
      { name: 'status 顺序 p99', value: seqStatus.p99, unit: 'ms' },
      { name: 'healthz 顺序 p99', value: seqHealth.p99, unit: 'ms' },
      { name: 'readyz 顺序 p99', value: seqReady.p99, unit: 'ms' },
      { name: '目标最高并发档位', value: TOP_LEVEL, unit: 'conn' },
      {
        name: `status 并发 p99（c=${TOP_LEVEL}，${REPEATS} 次中位数）`,
        value: topEntry?.latency_p99_median ?? null,
        unit: 'ms',
      },
      {
        name: `status 并发吞吐（c=${TOP_LEVEL}，${REPEATS} 次中位数）`,
        value: topEntry?.throughput_rps ?? null,
        unit: 'req/s',
      },
      { name: `status 并发吞吐 CV（c=${TOP_LEVEL}）`, value: topEntry?.throughput_rps_cv ?? null, unit: 'ratio' },
      {
        name: '实测档位 / 计划档位',
        value: `${measuredLevels.length}/${CONCURRENCY_LEVELS.length}`,
        unit: '',
      },
      { name: '测量请求总数', value: totalMeasured, unit: 'req' },
      { name: '失败请求数', value: totalFailures, unit: 'req' },
      { name: 'status 响应体大小 p50', value: summarize(sequential['/api/v1/status'].bytes).p50, unit: 'byte' },
      { name: '错误 token 得到的 429 数', value: badStatuses[429] ?? 0, unit: 'req' },
      { name: '锁定期内合法请求状态', value: duringLockout.status, unit: 'HTTP' },
      { name: '窗口过期后合法请求状态', value: afterWindow.status, unit: 'HTTP' },
      { name: '库内事件数（status 报告）', value: statusBody?.store?.events ?? null, unit: 'row' },
      {
        name: `限流探针合法请求（${LOCKOUT_PROBE_OFFSETS_MS.map((ms) => `+${ms / 1000}s`).join('/')}）`,
        value: lockoutLegit.actual,
        unit: 'HTTP',
        note: `窗口 ${PROBE_AUTH_FAILURE_WINDOW_MS / 1000}s；错 token 连发 ${LOCKOUT_PROBE_WRONG_BURST} 次`,
      },
      { name: '限流探针：合法请求之后的错 token', value: lockoutThrottle.actual, unit: 'HTTP' },
      { name: '轮换错 token：第 6 个新 token', value: quotaProbe.quota_probe_status, unit: 'HTTP' },
      { name: '生效默认值（limit / window）', value: `${effectiveDefaults.api?.authFailureLimit} / ${effectiveDefaults.api?.authFailureWindowMs} ms`, unit: '' },
    ];

    const tables = [
      {
        title: `并发扫描（/api/v1/status，每档 ${REPEATS} 次取中位数）`,
        rows: sweep.map((entry) => ({
          name: `c=${entry.concurrency}`,
          value: `中位 ${entry.throughput_rps} req/s（CV ${entry.throughput_rps_cv}）`
            + ` · p99 中位 ${entry.latency_p99_median} ms（CV ${entry.latency_p99_cv}）`,
          unit: '',
          note: `${entry.repeats} 轮 × ${entry.requests_per_repeat} 次；`
            + `吞吐样本 ${JSON.stringify(entry.throughput_rps_samples)}；`
            + `failures=${entry.failures} statuses=${JSON.stringify(entry.statuses)}`,
        })),
      },
      {
        title: '背压观测',
        rows: [
          { name: '错误 token 状态分布', value: JSON.stringify(badStatuses), unit: 'HTTP', note: 'authFailureLimit=5' },
          { name: '锁定期内合法请求', value: duringLockout.status, unit: 'HTTP' },
          { name: '窗口 2.2s 后合法请求', value: afterWindow.status, unit: 'HTTP' },
          { name: '实际测完的并发档位', value: measuredLevels.join('/'), unit: 'conn' },
          { name: '是否提前终止升并发', value: abortedAt === null ? 'no' : `yes @ c=${abortedAt}`, unit: '' },
        ],
      },
      {
        title: `认证限流探针（独立实例，窗口 ${PROBE_AUTH_FAILURE_WINDOW_MS / 1000}s，` +
          `${LOCKOUT_PROBE_WRONG_BURST} 个错 token 之后）`,
        rows: [
          {
            name: '错 token 连发的状态',
            value: JSON.stringify(lockoutProbe.burst_statuses),
            unit: 'HTTP',
            note: '第 5 个仍是 401：rateLimited 在 recordFailure 之前判 count>=5',
          },
          ...lockoutProbe.samples.map((sample) => ({
            name: `+${sample.offset_ms / 1000}s 合法 token`,
            value: sample.status,
            unit: 'HTTP',
            note: `实际 +${(sample.since_burst_ms / 1000).toFixed(2)}s`,
          })),
          ...lockoutProbe.throttle.map((entry) => ({
            name: `+${entry.after_offset_ms / 1000}s 合法请求之后的错 token`,
            value: entry.status,
            unit: 'HTTP',
            note: `实际 +${(entry.since_burst_ms / 1000).toFixed(2)}s；必须 429（成功不清桶）`,
          })),
        ],
      },
    ];

    observations.push(
      `顺序基线：/api/v1/status p50 ${seqStatus.p50} ms、p99 ${seqStatus.p99} ms；`
        + `/healthz p99 ${seqHealth.p99} ms；/readyz p99 ${seqReady.p99} ms。`,
      `并发扫描 ${sweep.length}/${CONCURRENCY_LEVELS.length} 档`
        + `（${measuredLevels.join('/') || '—'}），每档 ${REPEATS} 次重复取中位数；`
        + `c=${TOP_LEVEL} 的中位吞吐 ${topEntry?.throughput_rps ?? '—'} req/s`
        + `（CV ${topEntry?.throughput_rps_cv ?? '—'}）、p99 中位 ${topEntry?.latency_p99_median ?? '—'} ms；`
        + `基线 c=${BASE_LEVEL} 中位吞吐 ${baseEntry?.throughput_rps ?? '—'} req/s；`
        + `共 ${totalMeasured} 次请求、${totalFailures} 次失败。`
        + (abortedAt === null
          ? ''
          : `**缺档警告**：c=${abortedAt} 的 p99 中位数超过 ${ABORT_P99_BUDGET_MS} ms 的绝对上限，`
            + '扫描提前终止 —— 该轮证据不可用于扩展性结论。'),
      `扩展性判据：${scaling.expected}；实测 ${scaling.actual}。`
        + `测量稳定性：${stability.actual}（上限 CV ${MAX_MEDIAN_CV}）。`
        + `排队参照：c=${TOP_LEVEL} 的 p99 中位数是顺序基线（${baselineP99} ms）的`
        + `${topEntry === null || typeof baselineP99 !== 'number' || baselineP99 <= 0
          ? '—'
          : `${Number((topEntry.latency_p99_median / baselineP99).toFixed(1))} 倍`}`
        + ' —— 并发提高后延迟上升主要是排队（Little 定律复核一致），不是单请求处理变慢。'
        + '**量级限定**：负载生成器与被测 daemon 仍在同一进程、同一事件循环（D-3 未修），'
        + '所以这里的吞吐是 inline 天花板，不是服务端独立进程的容量。',
      `背压：12 次错误 token 得到 ${JSON.stringify(badStatuses)}；锁定期内合法请求返回 ${duringLockout.status}，`
        + `窗口（2s）过期后返回 ${afterWindow.status}。`
        + (duringLockout.status === 429
          ? '**发现**：认证失败计数按 peer 记账（`apps/daemon/src/api/auth.js` 的 `peerKey`），'
            + '且在验 token 之前就判定限流，而本机全部客户端共享 127.0.0.1 —— '
            + '任意本地进程连发 5 次错误 token 即可在窗口内连带拒绝合法客户端。'
            + '窗口到期后自动恢复。本基准只报告，不改生产代码。'
          : ''),
      `限流探针（独立实例，生产默认窗口 ${PROBE_AUTH_FAILURE_WINDOW_MS / 1000}s）：`
        + `${LOCKOUT_PROBE_WRONG_BURST} 个错 token 得到 ${JSON.stringify(lockoutProbe.burst_statuses)}；`
        + `随后 ${LOCKOUT_PROBE_OFFSETS_MS.map((ms) => `+${ms / 1000}s`).join('/')} 四点合法请求为 `
        + `${lockoutLegit.actual}（期望 ${lockoutLegit.expected}）；`
        + `合法请求之后的错 token 为 ${lockoutThrottle.actual}（期望 ${lockoutThrottle.expected}）。`
        + '这两条同为 blocker：只断言"合法请求 200"的话，把限流整段删掉同样会绿 ——'
        + '那就把 P1 修复（误伤合法客户端）换成了 P0 退化（防爆破归零）。',
      `轮换错 token：${LOCKOUT_PROBE_WRONG_BURST} 个不同错 token 得到 ${JSON.stringify(quotaProbe.wrong_statuses)}，`
        + `再换一个新 token 得到 ${quotaProbe.quota_probe_status}（期望 429），合法 token ${quotaProbe.legitimate_status}。`
        + '这一条专治"把桶按 token 记账"：那种退化下每个 token 都有新配额，攻击者轮换即可无限猜，'
        + '而用同一个 token 连发的判据看不出来。',
      `生效默认值：authFailureLimit=${effectiveDefaults.api?.authFailureLimit}、`
        + `authFailureWindowMs=${effectiveDefaults.api?.authFailureWindowMs}（探针要求窗口 >= ${LOCKOUT_PROBE_SPAN_MS} ms）。`
        + '探针实例显式传了 5 / 60 s，所以"把默认值改弱"不会被探针发现，必须单独断言。',
      `status 响应体 p50 ${summarize(sequential['/api/v1/status'].bytes).p50} 字节；`
        + '响应体里带 `csrf_token`，本报告只保留字段形状，不落盘任何 token。',
    );

    checks.push({
      id: 'daemon.read_routes_all_200',
      description: '所有被测量的只读请求都返回 200',
      expected: 0,
      actual: totalFailures,
      passed: totalFailures === 0,
    });
    checks.push({
      id: 'daemon.status_body_valid',
      description: 'status 响应体形状正确（不是"200 但空壳"）',
      expected: '0 invalid',
      actual: `${invalidBodies.length} invalid`,
      passed: invalidBodies.length === 0,
      note: invalidBodies.length === 0 ? undefined : invalidBodies[0].reasons.join('; '),
    });
    checks.push({
      id: 'daemon.store_is_real',
      description: 'status 报告的是真实 SQLite 库与真实行数',
      expected: `kind=sqlite 且 events >= ${scale.seedEvents}`,
      actual: `kind=${statusBody?.store?.kind} events=${statusBody?.store?.events}`,
      passed: statusBody?.store?.kind === 'sqlite' && (statusBody?.store?.events ?? 0) >= scale.seedEvents,
    });
    // 100ms 对本地只读接口太宽：实测 0.78ms，余量 127 倍，涨到 78ms 也照样通过。
    // 收到 20ms（余量约 25 倍）—— 这仍是"绝对 SLO"而非拟合值：本地 loopback 只读
    // 接口超过 20ms 对操作员已经是可感知的卡顿。同时把"并发 p99"降为 warn。
    checks.push({
      id: 'daemon.p99_budget',
      description: '顺序 status p99 不超过 20ms（本地只读 SLO）',
      expected: '<= 20 ms',
      actual: seqStatus.p99,
      passed: typeof seqStatus.p99 === 'number' && seqStatus.p99 <= 20,
    });
    checks.push({
      id: 'daemon.backpressure_rejects',
      description: '错误 token 连续打满后必须出现 429，且不返回 200',
      expected: '429 出现且 200 不出现',
      actual: JSON.stringify(badStatuses),
      passed: (badStatuses[429] ?? 0) > 0 && (badStatuses[200] ?? 0) === 0,
    });
    // 主实例（2s 窗口）内的同一件事：**观察项**，与下面对 +0/+5/+25/+35 s 的硬断言互补。
    // 判据方向已按 P1 修复反转（旧文案写"会被一并拒绝"，却要求 passed=200，字面与判据相反）：
    // 现在它记录的是"锁定期内合法请求是否被放行"，2s 窗口只覆盖"紧接着连发之后"这一刻。
    checks.push({
      id: 'daemon.auth_lockout_blocks_legitimate_client',
      description: '锁定期内同一 loopback peer 的合法请求仍被放行（2s 窗口实例内观察，非门禁）',
      expected: '200',
      actual: duringLockout.status,
      passed: duringLockout.status === 200,
      severity: 'warn',
      note: duringLockout.status === 429
        ? '失败计数按 peer 记账且在验 token 之前判定，本机所有客户端共享 127.0.0.1，'
          + '因此任意本地进程连发 5 次错误 token 即可在窗口内拒绝合法客户端。'
          + '硬门禁在 `daemon.auth_lockout_spares_legitimate_client`（60s 窗口、四点采样），'
          + '本条只是同一现象在 2s 窗口实例内的即时观察。'
        : undefined,
    });
    checks.push({
      id: 'daemon.auth_lockout_expires',
      description: '认证失败窗口过期后，合法请求必须恢复 200',
      expected: 200,
      actual: afterWindow.status,
      passed: afterWindow.status === 200,
    });
    // --- H-1：把 P1 修复变成真正的门禁 -------------------------------------
    // 旧状态：修复前后 `daemon.backpressure_rejects` 的 actual 逐字节相同
    // （都是 {"401":5,"429":7}），唯一会变的是一条 warn，而 evaluateChecks 只看
    // blocker —— 回退 auth 顺序后 verdict 仍然是 pass。实测见
    // `status/M9-GATE-HARDEN.md` §2（回退副本 29 项、0 失败、1 警告、verdict=pass）。
    //
    // 现在：独立实例 + 生产默认 60s 窗口，连发 5 个错 token 之后在 +0/+5/+25/+35 s
    // 四个时点带真 token 请求。旧顺序下四点全部 429（`M9-PERF-FINAL` §7 "修复前"列）。
    // 任一点非 200 即 blocker 失败 —— 不再降级为 warn。
    checks.push({
      id: 'daemon.auth_lockout_spares_legitimate_client',
      description: '连发 5 个错 token 后，合法请求在 +0/+5/+25/+35 s 四点必须全部 200',
      expected: lockoutLegit.expected,
      actual: lockoutLegit.actual,
      passed: lockoutLegit.passed,
      note: lockoutLegit.passed
        ? `60s 窗口、${LOCKOUT_PROBE_WRONG_BURST} 个错 token 连发；四点全部落在同一窗口内。`
        : `被拒时点：${lockoutLegit.rejected_offsets.map((entry) => `+${entry.offset_ms / 1000}s=${entry.status}`).join('、') || '—'}；`
          + `缺失时点：${lockoutLegit.missing_offsets.map((ms) => `+${ms / 1000}s`).join('、') || '—'}。`
          + '429 说明失败桶在验凭据之前就被查询（P1 回归）；缺时点说明证据不完整，同样不能通过。',
    });
    // 与上一条**成对**的守卫：只断言"合法请求 200"是不够的 —— 把限流整段删掉、
    // 或让认证恒真，上一条也会绿，而那已经是 P0 退化（防爆破归零）。
    checks.push({
      id: 'daemon.auth_lockout_still_throttles_guesses',
      description: '合法请求之后紧接着的错 token 仍必须是 429（成功不得重置失败计数）',
      expected: lockoutThrottle.expected,
      actual: lockoutThrottle.actual,
      passed: lockoutThrottle.passed,
      note: lockoutThrottle.passed
        ? '「成功不清桶」在运行态被覆盖：合法请求之后 22 秒内第 2 个错 token 仍是 429。'
        : '出现非 429 的错 token：要么限流被删除/绕过（P0），要么成功路径清了桶（P1 回归）。'
          + '单测只覆盖前者的一半，本条覆盖运行态。',
    });
    // 第三条（假绿通道之二）：桶必须按 peer 记账，不能按 token 记账。
    checks.push({
      id: 'daemon.auth_lockout_quota_not_per_token',
      description: '轮换错 token 不能获得新配额：第 6 个（不同的）错 token 仍必须是 429',
      expected: quotaVerdict.expected,
      actual: quotaVerdict.actual,
      passed: quotaVerdict.passed,
      note: quotaVerdict.passed
        ? '独立实例、干净失败桶；5 个互不相同 + 第 6 个又是新的，全部同一瞬间发出。'
        : `原因：${quotaVerdict.reasons.join('；')}。`
          + '按 token 记账时每个 token 各得一份配额，攻击者轮换 token 即可无限猜 —— '
          + '这是被测实现注释明确声明要避免的（桶按 peer，不由 token 派生）。',
    });
    // 第四条（假绿通道之一）：生产默认值不得被弱化。
    checks.push({
      id: 'daemon.auth_failure_defaults_intact',
      description: '认证限流的生效默认值未被弱化（更小 limit / 更长 window 允许，反向不允许）',
      expected: defaultsVerdict.expected,
      actual: defaultsVerdict.actual,
      passed: defaultsVerdict.passed,
      note: '探针实例显式传 5 / 60 s，因此本场景的其余 auth 判据对"改 config 默认值"免疫 —— '
        + '若不加这一条，把 limit 调到 1000、window 调到 1 s 会让四条 auth 判据全绿，而防爆破已经失效。',
    });
    // --- 并发相关的四条检查 ------------------------------------------------
    // 1) 结构完整性：档位必须跑全。这是 blocker —— 缺档轮次里"最高档"会退化成
    //    中间档，判据的度量对象随之改变（旧实现在 c=8 刹车后把 expected 写成
    //    `c=8 >= c=2` 并照样 pass），这种证据不能用，必须重跑。
    checks.push({
      id: 'daemon.concurrency_sweep_complete',
      description: `${CONCURRENCY_LEVELS.length} 个并发档位必须全部测完（缺档的轮次不能算通过）`,
      expected: `${CONCURRENCY_LEVELS.length} 档：${CONCURRENCY_LEVELS.join('/')}`,
      actual: `${measuredLevels.length} 档：${measuredLevels.join('/') || '—'}`
        + (abortedAt === null ? '' : `（c=${abortedAt} 触发退化刹车）`),
      passed: sweepResult.complete,
      note: sweepResult.complete
        ? undefined
        : '刹车提前终止后，"最高并发档位"的观察对象就不再是 c=32，扩展性与延迟预算两条判据'
          + '会静默地度量别的东西。缺档轮次应视为证据无效并重跑。',
    });
    // 2) 延迟预算：观察对象固定为 c=32（常量），不再是"实测到的最后一档"。
    //    并发 p99 与顺序 p99 差一个数量级主要是排队而非处理变慢（Little 定律复核一致），
    //    所以这一档仍是 warn，真正的 blocker 放在顺序 SLO 上。
    checks.push({
      id: 'daemon.concurrency_latency_bounded',
      description: `最高档（c=${TOP_LEVEL}）的 p99 中位数不超过 ${ABSOLUTE_P99_BUDGET_MS}ms 绝对上限`,
      expected: `<= ${ABSOLUTE_P99_BUDGET_MS} ms`,
      actual: topEntry?.latency_p99_median ?? null,
      passed: typeof topEntry?.latency_p99_median === 'number'
        && topEntry.latency_p99_median <= ABSOLUTE_P99_BUDGET_MS,
      severity: 'warn',
      note: topEntry === null
        ? `未测到 c=${TOP_LEVEL}，无法判定（见 daemon.concurrency_sweep_complete）。`
        : `每档 ${REPEATS} 次重复的 p99 中位数；CV ${topEntry.latency_p99_cv}。`,
    });
    // 3) 扩展性：中位吞吐比值 >= 0.9，期望文本是常量。
    checks.push({
      id: 'daemon.concurrency_scales',
      description: `并发提高后中位吞吐不得低于基线档的 ${SCALE_MIN_RATIO} 倍（否则加并发只是排队）`,
      expected: scaling.expected,
      actual: scaling.actual,
      passed: scaling.passed,
      severity: 'warn',
      note: scaling.comparable
        ? `每档 ${REPEATS} 次取中位数；差值为负时先看 CV，再看是否被外部负载压过。`
        : '缺档导致不可比。缺档轮次的旧实现会把这个检查改写成"最高实测档 >= 基线档"并照样通过。',
    });
    // 4) 测量可信度：CV 过高时上面的中位数比值说明不了问题，必须让读者看到。
    //    这不是产品门禁 —— 它拦的是"用噪声下结论"，所以是 warn。
    checks.push({
      id: 'daemon.concurrency_measurement_stable',
      description: `各档吞吐的重复采样 CV 不超过 ${MAX_MEDIAN_CV}（超过则中位数不可信，应增加重复次数）`,
      expected: stability.expected,
      actual: stability.actual,
      passed: stability.passed,
      severity: 'warn',
      note: '测量质量指标，不是产品指标：红了说明需要独占机器或更多重复，'
        + '而不是说产品吞吐退化。',
    });

    const scenario = {
      id: 'daemon-api',
      title: 'daemon 只读 API（延迟 / 并发 / 背压）',
      summary: `真实 daemon（mode=mock + 真实 SQLite 适配器），库内预置 ${scale.seedEvents} 条合成事件；`
        + `顺序测量每路由 ${scale.sequentialPerRoute} 次；并发档位 ${CONCURRENCY_LEVELS.join('/')}，`
        + `每档重复 ${REPEATS} 次取中位数与 CV（每轮请求数 = max(${scale.perLevel}, c×${MIN_PER_WORKER})`
        + ` 并取整到 c 的整数倍，实际次数见下表）。`
        + '连接复用 keep-alive 池，延迟用单调时钟测，分位数取精确秩。',
      parameters: {
        profile: options.profile,
        seed_events: scale.seedEvents,
        sequential_per_route: scale.sequentialPerRoute,
        per_level_floor: scale.perLevel,
        requests_per_level: Object.fromEntries(
          CONCURRENCY_LEVELS.map((level) => [level, perLevelRequests(level, scale.perLevel)]),
        ),
        concurrency_levels: CONCURRENCY_LEVELS,
        concurrency_repeats: REPEATS,
        min_requests_per_worker: MIN_PER_WORKER,
        scale_min_ratio: SCALE_MIN_RATIO,
        max_median_cv: MAX_MEDIAN_CV,
        absolute_p99_budget_ms: ABSOLUTE_P99_BUDGET_MS,
        auth_failure_limit: 5,
        auth_probe_failure_window_ms: PROBE_AUTH_FAILURE_WINDOW_MS,
        auth_probe_offsets_ms: [...LOCKOUT_PROBE_OFFSETS_MS],
        auth_probe_wrong_burst: LOCKOUT_PROBE_WRONG_BURST,
        auth_probe_required_window_ms: LOCKOUT_PROBE_SPAN_MS,
        abort_p99_budget_ms: ABORT_P99_BUDGET_MS,
      },
      metrics,
      tables,
      observations,
    };
    return { scenario, checks, raw };
  } finally {
    agent.destroy();
    if (quotaPrepared !== null) {
      await quotaPrepared.cleanup();
    }
    if (probePrepared !== null) {
      await probePrepared.cleanup();
    }
    await prepared.cleanup();
  }
}
