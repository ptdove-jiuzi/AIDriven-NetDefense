/**
 * probes/m9-recheck.mjs — M9-PERF-FINAL 复核探针（只读）。
 *
 * 用途：在**不改生产代码、不改基准判据**的前提下，单独复核 M9-PERF-TRIAGE 的三条结论
 * 是否仍然成立：
 *
 *   d1  认证失败限流放大：生产默认 60s 窗口下，5 个错误 token 是否仍能连带拒绝合法客户端；
 *       每窗口重发 5 个是否可无限维持（持续性）。
 *   d2  并发不扩展：c=32 与 c=2 的吞吐比值，多次重复取中位数（基准自身只测一次）；
 *       并用 Little 定律验证"延迟增长是排队还是处理变慢"。
 *   rss RSS 4.7×：同进程连跑两轮完整 event-store 场景，强制 GC 后 RSS 是否持平
 *       （持平 = 高水位/可回收垃圾，不是泄漏）。
 *
 * 与基准的关系：基准（`tests/bench/scenarios/*`）是**门禁**，本文件是**归因工具**。
 * 它不产出 PASS/FAIL 门禁，只产出数字与判定说明，供状态文件和审查报告引用。
 *
 * 数据安全：所有写入落在系统临时目录（`lib/tempdir.js` 的路径守卫），跑完即删；
 * 不读写任何真实数据库、日志或用户数据；报告里不落盘 token、Authorization 头或主机名。
 *
 * 用法：
 *   node tests/bench/probes/m9-recheck.mjs                    # 三个探针全跑
 *   node tests/bench/probes/m9-recheck.mjs --probe d1,d2      # 只跑指定探针
 *   node --expose-gc tests/bench/probes/m9-recheck.mjs --probe rss   # rss 需强制 GC
 *
 * 作者：PT-dove
 */

import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import process from 'node:process';

import { createDaemon } from '../../../apps/daemon/src/index.js';
import { createEventStoreAdapter } from '../../../apps/daemon/src/adapters/event-store.js';
import { loadConfig } from '../../../apps/daemon/src/config.js';
import { codeDigest } from '../lib/env.js';
import { makeBenchRulePack } from '../lib/rulepack.js';
import { runEventStoreScenario } from '../scenarios/event-store.js';
import { elapsedMs, mib, nowNs, summarize } from '../lib/stats.js';
import { assertHarmlessPath, createTempRoot } from '../lib/tempdir.js';

/** 默认种子与基准一致：换种子等于换一套负载，数字立刻不可比。 */
const DEFAULT_SEED = 20261102;

/** d2 的重复次数。基准只测 1 次；复核要报中位数与变异系数。 */
const D2_REPEATS = 5;

/** d2 每档请求数。基准用 200，c=32 时单档只有 20–50ms，窗口太短。 */
const D2_PER_LEVEL = 2000;

/** d2 档位。与基准一致（2/4/8/16/32），便于对照。 */
const D2_LEVELS = Object.freeze([2, 4, 8, 16, 32]);

/** d1 持续性验证用的窗口。缩短窗口只为让"多窗口"在探针里跑得完，默认值仍单独测。 */
const D1_LOOP_WINDOW_MS = 10000;

/** d1 默认窗口下取时间线的时点（毫秒）。 */
const D1_TIMELINE_MS = Object.freeze([0, 5000, 25000, 35000]);

/**
 * 探针自身的内容摘要。
 *
 * 没有 git 时，证据必须能回答"是哪个版本的探针跑出来的"。第一轮独立复核指出：
 * d1/d2 证据的 `generated_at` 早于探针源码的 mtime，而证据里没有任何字段能证明
 * 二者对应 —— 于是证据在磁盘上不可复现。这个摘要就是补丁：改了探针，新证据的摘要
 * 就与旧证据不同，无法冒充。
 *
 * @returns {string|null} sha256（读取自身失败时为 null）。
 */
function probeDigest() {
  try {
    return createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 发一个 GET 请求，返回状态码、JSON 体与关键响应头。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {string} pathname 路径。
 * @param {Record<string, string>} [headers] 请求头。
 * @returns {Promise<{status: number, body: object|null, retry_after: string|null}>} 结果。
 */
function get(agent, port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', agent, headers },
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
          resolve({
            status: res.statusCode ?? 0,
            body,
            retry_after: res.headers['retry-after'] ?? null,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 睡一会儿。
 *
 * @param {number} ms 毫秒。
 * @returns {Promise<void>} 完成。
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 在给定并发下顺序压一条路由（与基准 `measureConcurrent` 同构，便于对照）。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {string} pathname 路径。
 * @param {number} concurrency 并发数。
 * @param {number} total 目标请求数（会按并发度整除）。
 * @param {Record<string, string>} headers 请求头。
 * @returns {Promise<{requests: number, wall_ms: number, latencies: number[]}>} 结果。
 */
async function measureConcurrent(agent, port, pathname, concurrency, total, headers) {
  const perWorker = Math.floor(total / concurrency);
  const wallStart = nowNs();
  const workers = new Array(concurrency);
  for (let worker = 0; worker < concurrency; worker += 1) {
    workers[worker] = (async () => {
      const local = new Array(perWorker);
      for (let index = 0; index < perWorker; index += 1) {
        const start = nowNs();
        await get(agent, port, pathname, headers);
        local[index] = elapsedMs(start, nowNs());
      }
      return local;
    })();
  }
  const results = await Promise.all(workers);
  const wallMs = elapsedMs(wallStart, nowNs());
  const latencies = [];
  for (const local of results) {
    for (const value of local) {
      latencies.push(value);
    }
  }
  return { requests: latencies.length, wall_ms: Number(wallMs.toFixed(3)), latencies };
}

/**
 * 起一个临时 daemon（真实 SQLite 适配器 + 真实 detection 引擎，无调度写入）。
 *
 * @param {{tempRoot: object, name: string, seedEvents: number, seed: number,
 *   token: string, authFailureWindowMs?: number}} options 选项。
 * @returns {Promise<{port: number, stop: () => Promise<void>}>} 句柄。
 */
async function startDaemon(options) {
  const dataDir = assertHarmlessPath(options.tempRoot.dir(options.name), 'probe data dir');
  const storePath = assertHarmlessPath(options.tempRoot.dir(`${options.name}/aegis-probe.db`), 'probe store path');
  const { pack } = makeBenchRulePack({ seed: options.seed });
  const api = { port: 0, token: options.token, authFailureLimit: 5 };
  if (options.authFailureWindowMs !== undefined) {
    api.authFailureWindowMs = options.authFailureWindowMs;
  }
  const config = loadConfig({
    dataDir,
    mode: 'mock',
    detection: { rulePack: pack },
    api,
    // 调度器拉到一小时：本探针只测只读接口与鉴权路径，不引入写入干扰。
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
    await daemon.stop('probe-failure');
    throw new Error('probe daemon did not bind a port');
  }
  return {
    port: started.address.port,
    stop: async () => {
      await daemon.stop('probe-done');
    },
  };
}

/**
 * 探针 d1：认证失败限流放大。
 *
 * 三段：
 *   A. 生产默认窗口（60s）下的时间线：合法 200 → 5 个错误 token → 合法请求在
 *      +0/+5/+25/+35s 是否仍被拒，`retry-after` 是剩余时间还是窗口全长。
 *   B. 持续性：10s 窗口下连做 3 个窗口，每窗口只发 5 个错误 token，观察合法请求
 *      是否始终被拒、窗口间隙是否真的恢复（"到期自动恢复"是否构成有效缓解）。
 *   C. 不带 Authorization 的请求是否仍不计数（对照，防止把"任何请求都锁"误报成缺陷）。
 *
 * @param {{seed: number, tempRoot: object}} options 选项。
 * @returns {Promise<object>} 结果。
 */
async function probeD1(options) {
  const token = `probe-token-${options.seed}-0123456789abcdef`;
  const good = { authorization: `Bearer ${token}` };
  const bad = { authorization: 'Bearer probe-wrong-token-0000000000' };
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const out = { default_window: {}, loop: {}, control: {} };

  try {
    // --- A. 默认 60s 窗口 ---------------------------------------------------
    const first = await startDaemon({
      tempRoot: options.tempRoot,
      name: 'd1-default',
      seedEvents: 200,
      seed: options.seed,
      token,
    });
    try {
      out.default_window.baseline = (await get(agent, first.port, '/api/v1/status', good)).status;
      const badStatuses = [];
      for (let index = 0; index < 5; index += 1) {
        badStatuses.push((await get(agent, first.port, '/api/v1/status', bad)).status);
      }
      out.default_window.bad = badStatuses;
      const t0 = Date.now();
      const timeline = [];
      for (const at of D1_TIMELINE_MS) {
        const wait = at - (Date.now() - t0);
        if (wait > 0) {
          await sleep(wait);
        }
        const response = await get(agent, first.port, '/api/v1/status', good);
        timeline.push({
          at_s: Number(((Date.now() - t0) / 1000).toFixed(2)),
          status: response.status,
          retry_after: response.retry_after,
          // 剩余时间：窗口 60s 减去已经过去的时间；用来判断 retry-after 是否准确。
          remaining_s_expected: Math.max(0, 60 - Math.floor((Date.now() - t0) / 1000)),
        });
      }
      out.default_window.timeline = timeline;
      out.default_window.window_ms_declared = 60000;
    } finally {
      await first.stop();
    }

    // --- B. 持续性：3 个 10s 窗口，每窗口 5 个错 token ---------------------
    const second = await startDaemon({
      tempRoot: options.tempRoot,
      name: 'd1-loop',
      seedEvents: 200,
      seed: options.seed,
      token,
      authFailureWindowMs: D1_LOOP_WINDOW_MS,
    });
    try {
      const rounds = [];
      for (let round = 0; round < 3; round += 1) {
        const before = (await get(agent, second.port, '/api/v1/status', good)).status;
        const bads = [];
        for (let index = 0; index < 5; index += 1) {
          bads.push((await get(agent, second.port, '/api/v1/status', bad)).status);
        }
        const during = (await get(agent, second.port, '/api/v1/status', good)).status;
        rounds.push({ round, legit_before: before, bad: bads, legit_during_lockout: during });
        // 等到本窗口结束后再进下一轮：如果"到期恢复"有效，下一轮的 legit_before 应为 200。
        await sleep(D1_LOOP_WINDOW_MS);
        rounds[round].legit_after_window = (await get(agent, second.port, '/api/v1/status', good)).status;
      }
      out.loop.window_ms = D1_LOOP_WINDOW_MS;
      out.loop.rounds = rounds;
      out.loop.all_lockouts_held = rounds.every((entry) => entry.legit_during_lockout === 429);
      out.loop.all_recovered = rounds.every((entry) => entry.legit_after_window === 200);
    } finally {
      await second.stop();
    }

    // --- C. 对照：不带 Authorization 不计数 --------------------------------
    const third = await startDaemon({
      tempRoot: options.tempRoot,
      name: 'd1-control',
      seedEvents: 200,
      seed: options.seed,
      token,
    });
    try {
      const noHeaders = [];
      for (let index = 0; index < 20; index += 1) {
        noHeaders.push((await get(agent, third.port, '/api/v1/status')).status);
      }
      const after = await get(agent, third.port, '/api/v1/status', good);
      out.control.no_header_20x = noHeaders;
      out.control.legit_after_no_header = after.status;
    } finally {
      await third.stop();
    }
  } finally {
    agent.destroy();
  }
  return out;
}

/**
 * 探针 d2：并发不扩展 + Little 定律。
 *
 * @param {{seed: number, tempRoot: object}} options 选项。
 * @returns {Promise<object>} 结果。
 */
async function probeD2(options) {
  const token = `probe-token-${options.seed}-0123456789abcdef`;
  const headers = { authorization: `Bearer ${token}` };
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const daemon = await startDaemon({
    tempRoot: options.tempRoot,
    name: 'd2',
    seedEvents: 4000,
    seed: options.seed,
    token,
  });
  const rows = [];
  try {
    for (let index = 0; index < 30; index += 1) {
      await get(agent, daemon.port, '/api/v1/status', headers);
    }
    for (const level of D2_LEVELS) {
      const repeats = [];
      for (let repeat = 0; repeat < D2_REPEATS; repeat += 1) {
        const result = await measureConcurrent(agent, daemon.port, '/api/v1/status', level, D2_PER_LEVEL, headers);
        const summary = summarize(result.latencies);
        repeats.push({
          requests: result.requests,
          wall_ms: result.wall_ms,
          throughput_rps: Number(((result.requests / result.wall_ms) * 1000).toFixed(2)),
          p50: summary.p50,
          p99: summary.p99,
        });
      }
      const rps = repeats.map((entry) => entry.throughput_rps).sort((a, b) => a - b);
      const p50s = repeats.map((entry) => entry.p50).sort((a, b) => a - b);
      const median = rps[Math.floor(rps.length / 2)];
      const mean = rps.reduce((sum, value) => sum + value, 0) / rps.length;
      const variance = rps.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rps.length;
      const p50Median = p50s[Math.floor(p50s.length / 2)];
      rows.push({
        concurrency: level,
        repeats,
        throughput_median_rps: median,
        throughput_min_rps: rps[0],
        throughput_max_rps: rps[rps.length - 1],
        cv_percent: Number(((Math.sqrt(variance) / mean) * 100).toFixed(1)),
        p50_median_ms: p50Median,
        // Little 定律：并发 ≈ 吞吐 × 平均驻留时间。接近名义并发说明"已饱和、延迟=排队"。
        little_law_concurrency: Number(((median * p50Median) / 1000).toFixed(2)),
      });
    }
  } finally {
    agent.destroy();
    await daemon.stop();
  }
  const lowest = rows[0];
  const highest = rows[rows.length - 1];
  const best = rows.reduce((acc, entry) => (entry.throughput_median_rps > acc.throughput_median_rps ? entry : acc), rows[0]);
  return {
    repeats: D2_REPEATS,
    per_level_requests: D2_PER_LEVEL,
    levels: rows,
    ratio_c_max_over_c_min: Number((highest.throughput_median_rps / lowest.throughput_median_rps).toFixed(3)),
    peak_level: best.concurrency,
    peak_rps: best.throughput_median_rps,
    // 峰值相对 c=2 的提升倍数：接近 1 说明"最早一档就到天花板"。
    gain_over_c_min: Number((best.throughput_median_rps / lowest.throughput_median_rps).toFixed(3)),
  };
}

/**
 * 探针 rss：同进程连跑两轮完整 event-store 场景，比较强制 GC 后的 RSS。
 *
 * 若两轮 GC 后 RSS 持平，则"末态/起点 4.7 倍"是备份路径的可回收 external
 * 加分配器高水位，不是泄漏。
 *
 * @param {{seed: number, tempRoot: object}} options 选项。
 * @returns {Promise<object>} 结果。
 */
async function probeRss(options) {
  const gc = globalThis.gc;
  if (typeof gc !== 'function') {
    return { skipped: true, reason: '需要 node --expose-gc 才能做 GC 归因' };
  }
  const measure = () => {
    const usage = process.memoryUsage();
    return {
      rss_mib: mib(usage.rss),
      heap_total_mib: mib(usage.heapTotal),
      heap_used_mib: mib(usage.heapUsed),
      external_mib: mib(usage.external),
    };
  };
  const collect = async () => {
    for (let index = 0; index < 4; index += 1) {
      gc();
      await sleep(120);
    }
    await sleep(500);
    return measure();
  };

  const before = await collect();
  const rounds = [];
  for (let round = 0; round < 2; round += 1) {
    const snapshotBefore = measure();
    // **每轮必须用新的临时根**：场景的库文件名是固定的 `store/aegis-bench.db`，
    // 复用同一个根会让第二轮撞上第一轮留下的 analysis_outbox 行，
    // T2 的幂等键重复 → "analysis request was not enqueued"（夹具冲突，不是被测缺陷）。
    const roundRoot = createTempRoot('aegis-recheck-rss');
    let result;
    try {
      result = await runEventStoreScenario({
        seed: options.seed,
        profile: 'standard',
        tempRoot: roundRoot,
      });
    } finally {
      roundRoot.cleanup();
    }
    const afterRunNoGc = measure();
    const afterGc = await collect();
    rounds.push({
      round,
      before_run: snapshotBefore,
      after_run_no_gc: afterRunNoGc,
      after_gc: afterGc,
      ratio_no_gc: Number((afterRunNoGc.rss_mib / snapshotBefore.rss_mib).toFixed(2)),
      ratio_after_gc: Number((afterGc.rss_mib / before.rss_mib).toFixed(2)),
      // 只取用来归因的堆快照（聚合更新阶段是堆高位的来源），不把整份 raw 抄进探针结果。
      heap_after_update_phase: result.raw?.phases?.t1_aggregate_update?.memory_after ?? null,
    });
  }
  const gcRss = rounds.map((entry) => entry.after_gc.rss_mib);
  return {
    cross_round_baseline: before,
    rounds,
    gc_rss_spread_mib: Number((Math.max(...gcRss) - Math.min(...gcRss)).toFixed(2)),
  };
}

/**
 * 解析参数。
 *
 * @param {string[]} argv 参数。
 * @returns {{probes: string[], out: string|null}} 选项。
 */
function parseArgs(argv) {
  const options = { probes: ['d1', 'd2', 'rss'], out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--probe') {
      options.probes = String(next).split(',').map((entry) => entry.trim()).filter(Boolean);
      index += 1;
    } else if (token === '--out') {
      options.out = String(next);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  for (const name of options.probes) {
    if (!['d1', 'd2', 'rss'].includes(name)) {
      throw new Error(`unknown probe: ${name} (known: d1, d2, rss)`);
    }
  }
  return options;
}

/**
 * 主流程。
 *
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`m9-recheck: ${error.message}\n`);
    return 2;
  }
  const startedAt = new Date().toISOString();
  const digestBefore = codeDigest();
  const tempRoot = createTempRoot('aegis-recheck');
  const result = {
    kind: 'm9-recheck',
    author: 'PT-dove',
    generated_at: startedAt,
    node: process.version,
    gc_exposed: typeof globalThis.gc === 'function',
    probe_digest: probeDigest(),
    code_digest_before: digestBefore.digest,
    probes: options.probes,
  };
  try {
    for (const name of options.probes) {
      process.stdout.write(`m9-recheck: → ${name}\n`);
      const started = nowNs();
      if (name === 'd1') {
        result.d1 = await probeD1({ seed: DEFAULT_SEED, tempRoot });
      } else if (name === 'd2') {
        result.d2 = await probeD2({ seed: DEFAULT_SEED, tempRoot });
      } else {
        result.rss = await probeRss({ seed: DEFAULT_SEED, tempRoot });
      }
      process.stdout.write(`m9-recheck:   ← ${name} ${(elapsedMs(started, nowNs()) / 1000).toFixed(1)}s\n`);
    }
  } finally {
    tempRoot.cleanup();
  }
  result.code_digest_after = codeDigest().digest;
  result.code_stable = result.code_digest_after === result.code_digest_before;

  const text = JSON.stringify(result, null, 2);
  if (options.out === null) {
    process.stdout.write(`${text}\n`);
  } else {
    fs.writeFileSync(options.out, `${text}\n`, 'utf8');
    process.stdout.write(`m9-recheck: json=${options.out}\n`);
  }
  return result.code_stable ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`m9-recheck: fatal: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 2;
});
