/**
 * soak.mjs — 5–10 分钟短时浸泡。
 *
 * 用法：
 *   node tests/soak/soak.mjs                     # 默认 6 分钟
 *   node tests/soak/soak.mjs --minutes 8         # 上限建议 10
 *   node tests/soak/soak.mjs --minutes 5 --sample-ms 3000
 *
 * 浸泡跑的是**真实的 daemon**：真实 SQLite 存储适配器 + 真实 detection 引擎 +
 * 真实的 loopback 控制 API，由调度器按 tick 拉一个合成来源。这样内存、WAL、队列和
 * API 延迟是同一个进程里互相影响的真实数字，而不是四条独立曲线的拼贴。
 *
 * "队列"在本架构里**不会无限增长**：调度器一次只跑一个 poll，来源返回的批次超过
 * `maxBatchEvents` 会被截断并计入 `dropped_events`。所以这里看的不是"队列长度"，
 * 而是两件能证伪的事：
 *   1. `dropped_events` 是否开始增长（说明来源产出超过单批上限）；
 *   2. 实际 poll 次数是否明显少于此间应有的次数（说明调度器追不上 tick）。
 * 把"队列长度恒为 0"当成"没有背压问题"是自欺——那只是架构决定的。
 *
 * 明确不做：72h / 7d 长稳。短时浸泡只能发现快速泄漏，不能证明长期稳定。
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import process from 'node:process';

import { createDaemon } from '../../apps/daemon/src/index.js';
import { createEventStoreAdapter } from '../../apps/daemon/src/adapters/event-store.js';
import { loadConfig } from '../../apps/daemon/src/config.js';
import { captureEnv, codeDigest } from '../bench/lib/env.js';
import { makeBenchRulePack } from '../bench/lib/rulepack.js';
import {
  RESULT_SCHEMA,
  addCheck,
  evaluateChecks,
  renderMarkdown,
  stampOf,
  writeArtifacts,
} from '../bench/lib/report.js';
import { elapsedMs, linearTrend, mib, nowNs, summarize, windowCompare } from '../bench/lib/stats.js';
import { createWorkload } from '../bench/lib/synthetic.js';
import { assertHarmlessPath, createTempRoot, fileBytes } from '../bench/lib/tempdir.js';

/** 默认浸泡时长（分钟）。任务范围是 5–10 分钟。 */
const DEFAULT_MINUTES = 6;

/** 默认采样间隔。5 秒一次在 6 分钟里采 72 点，够做趋势又不至于把采样成本变成负载。 */
const DEFAULT_SAMPLE_MS = 5000;

/** 浸泡期间的合成产出速率：每 tick 一批，每批这么多条。 */
const BATCH_SIZE = 25;

/** 调度器 tick。100 条/秒的产出对这台机器（T1 约 370 ops/s）留有充足余量。 */
const TICK_MS = 250;

/** RSS 首末段允许的增长上限。 */
const RSS_DELTA_LIMIT_BYTES = 64 * 1024 * 1024;

/** RSS 首末段允许的增长比例。 */
const RSS_RATIO_LIMIT = 1.25;

/** WAL 允许的峰值（仅在读不到 autocheckpoint 时的兜底值）。 */
const WAL_LIMIT_BYTES = 256 * 1024 * 1024;

/** RSS 的绝对上限；与"增长比例"互补，防止基数已经很高时比例仍然好看。 */
const RSS_ABSOLUTE_CAP_BYTES = 512 * 1024 * 1024;

/** RSS 趋势的最小可解释 R²；低于它就不报斜率，只报"无趋势"。 */
const TREND_MIN_R2 = 0.3;

/** 末段 API p99 允许退化的倍数。 */
const API_DEGRADATION_LIMIT = 5;

/**
 * 解析参数。
 *
 * @param {string[]} argv 参数。
 * @returns {{minutes: number, sampleMs: number, out: string|null, gate: boolean, seed: number}} 选项。
 */
function parseArgs(argv) {
  const options = { minutes: DEFAULT_MINUTES, sampleMs: DEFAULT_SAMPLE_MS, out: null, gate: true, seed: 20261102 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--minutes') {
      options.minutes = Number(next);
      index += 1;
    } else if (token === '--sample-ms') {
      options.sampleMs = Number(next);
      index += 1;
    } else if (token === '--out') {
      options.out = String(next);
      index += 1;
    } else if (token === '--seed') {
      options.seed = Number(next);
      index += 1;
    } else if (token === '--no-gate') {
      options.gate = false;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!Number.isFinite(options.minutes) || options.minutes < 1 || options.minutes > 10) {
    // 上限写死 10：超过就不是"短时浸泡"了，需要单独排期和更严格的机器隔离。
    throw new Error('--minutes must be between 1 and 10 (this task explicitly excludes 72h/7d runs)');
  }
  if (!Number.isFinite(options.sampleMs) || options.sampleMs < 500) {
    throw new Error('--sample-ms must be >= 500');
  }
  return options;
}

/**
 * 发一个 GET 请求并解析 JSON。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {string} pathname 路径。
 * @param {Record<string, string>} headers 请求头。
 * @returns {Promise<{status: number, body: object|null, latency_ms: number}>} 结果。
 */
function getJson(agent, port, pathname, headers) {
  const start = nowNs();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', agent, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const latency = elapsedMs(start, nowNs());
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = text.length === 0 ? null : JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body, latency_ms: Number(latency.toFixed(4)) });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 只读地读一次 SQLite 的页大小与 autocheckpoint。
 *
 * 用 `readOnly: true` 打开：既不会创建缺失的文件，也不会与 daemon 的写句柄冲突。
 * 读不到就返回 null，调用方回落到保守的兜底阈值。
 *
 * @param {string} storePath 库文件。
 * @returns {{page_size: number, wal_autocheckpoint: number}|null} 参数。
 */
function readStorePragmas(storePath) {
  let database = null;
  try {
    database = new DatabaseSync(storePath, { readOnly: true });
    return {
      page_size: Number(database.prepare('PRAGMA page_size').get()?.page_size ?? 0),
      wal_autocheckpoint: Number(database.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint ?? 0),
    };
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // 读参数失败不该影响浸泡本身。
    }
  }
}

/**
 * 创建一个持续产出的合成来源。
 *
 * 与 `createScriptedSource` 的区别：脚本源是有限的，浸泡需要跑几分钟，
 * 无限产出更贴近真实采集器。
 *
 * @param {{id: string, workload: object, batchSize: number, intervalMs: number}} options 选项。
 * @returns {{id: string, kind: string, intervalMs: number, poll: (ctx: object) => Promise<object>}} 来源。
 */
function createSyntheticSource(options) {
  let cursor = 1;
  return {
    id: options.id,
    kind: 'synthetic',
    intervalMs: options.intervalMs,
    poll() {
      const events = new Array(options.batchSize);
      for (let offset = 0; offset < options.batchSize; offset += 1) {
        events[offset] = options.workload.event(cursor + offset);
      }
      cursor += options.batchSize;
      // 显式给 cursor：调度器会持久化它，这是真实采集器的形态。
      return Promise.resolve({ events, cursor: { index: cursor } });
    },
  };
}

/**
 * 带一次重试的探针。
 *
 * 连接池复用到已被服务端关闭的 socket 时会抛 ECONNRESET；这是客户端的时序问题，
 * 不该被记成"服务端失败"。但**也不能静默吞掉**：重试次数会被统计并写进报告，
 * 因为"悄悄重试"会把真实的连接问题藏起来。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {string} pathname 路径。
 * @param {Record<string, string>} headers 请求头。
 * @param {{retries: number}} counter 重试计数器。
 * @returns {Promise<{status: number, body: object|null, latency_ms: number}>} 结果。
 */
async function probe(agent, port, pathname, headers, counter) {
  try {
    return await getJson(agent, port, pathname, headers);
  } catch (error) {
    const code = error === null || error === undefined ? '' : String(error.code ?? '');
    if (code !== 'ECONNRESET' && code !== 'EPIPE') {
      throw error;
    }
    counter.retries += 1;
    return getJson(agent, port, pathname, headers);
  }
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
    process.stderr.write(`soak: ${error.message}\n`);
    return 2;
  }

  const runStart = nowNs();
  const generatedAt = new Date().toISOString();
  const tempRoot = createTempRoot('aegis-soak');
  const env = captureEnv({ tempRoot: tempRoot.root });
  const token = `soak-token-${options.seed}-0123456789abcdef`;
  const headers = { authorization: `Bearer ${token}` };
  const workload = createWorkload({ seed: options.seed, label: 'soak' });
  const { pack } = makeBenchRulePack({ seed: options.seed });

  const storePath = assertHarmlessPath(tempRoot.dir('soak/aegis-soak.db'), 'soak store path');
  const dataDir = assertHarmlessPath(tempRoot.dir('soak'), 'soak data dir');
  const config = loadConfig({
    dataDir,
    mode: 'mock',
    detection: { rulePack: pack },
    api: { port: 0, token },
    scheduler: {
      tickMs: TICK_MS,
      // 批上限远大于每批产出，正常情况不该出现截断；一旦截断就是真实的背压信号。
      maxBatchEvents: 500,
      staleAfterMs: 30000,
    },
    logging: { level: 'silent' },
  });

  const store = createEventStoreAdapter({
    path: storePath,
    allowedSummaryFields: ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'],
  });
  const source = createSyntheticSource({
    id: 'synthetic.stream',
    workload,
    batchSize: BATCH_SIZE,
    intervalMs: TICK_MS,
  });
  const daemon = createDaemon({ config, store, sources: [source] });

  // keepAliveMsecs 与 timeout 必须**短于** daemon 的 keepAliveTimeoutMs（默认 2000ms）：
  // 否则服务端先关连接、客户端还在复用，就会出现 ECONNRESET。这不是被测系统的问题，
  // 而是客户端池的时序问题，所以要在这里对齐，而不是把它记成一次失败。
  const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 500, maxSockets: 4, timeout: 1000 });
  const samples = [];
  const probeLatencies = [];
  let port = null;
  let aborted = false;
  const probeCounter = { retries: 0 };

  const onSigint = () => {
    aborted = true;
  };
  process.on('SIGINT', onSigint);

  try {
    const started = await daemon.start();
    port = started.address === null ? null : started.address.port;
    if (port === null) {
      throw new Error('daemon did not bind a control API port');
    }
    process.stdout.write(`soak: listening on 127.0.0.1:${port}; ${options.minutes} min @ ${options.sampleMs}ms samples\n`);

    const deadline = Date.now() + options.minutes * 60_000;
    const origin = Date.now();
    while (Date.now() < deadline && aborted === false) {
      const response = await probe(agent, port, '/api/v1/status', headers, probeCounter);
      probeLatencies.push(response.latency_ms);
      if (response.status !== 200 || response.body === null) {
        throw new Error(`status probe failed: HTTP ${response.status}`);
      }
      const body = response.body;
      const walPath = `${storePath}-wal`;
      samples.push({
        t_ms: Date.now() - origin,
        elapsed_s: Number(((Date.now() - origin) / 1000).toFixed(2)),
        rss_bytes: process.memoryUsage().rss,
        heap_used_bytes: process.memoryUsage().heapUsed,
        external_bytes: process.memoryUsage().external,
        wal_bytes: fileBytes(walPath),
        db_bytes: fileBytes(storePath),
        events_received: body.counters?.events_received ?? null,
        events_accepted: body.counters?.events_accepted ?? null,
        events_duplicate: body.counters?.events_duplicate ?? null,
        alerts_written: body.counters?.alerts_written ?? null,
        findings_written: body.counters?.findings_written ?? null,
        polls: body.counters?.polls ?? null,
        source_failures: body.counters?.source_failures ?? null,
        dropped_events: body.scheduler?.sources?.[0]?.dropped_events ?? null,
        source_lifecycle: body.scheduler?.sources?.[0]?.lifecycle ?? null,
        store_events: body.store?.events ?? null,
        store_db_bytes: body.store?.database_bytes ?? null,
        store_open: body.store?.open ?? null,
        health_status: body.health?.status ?? null,
        lifecycle: body.lifecycle ?? null,
        probe_latency_ms: response.latency_ms,
      });
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(options.sampleMs, remaining));
      });
    }

    // 读一次 SQLite 的页大小与 autocheckpoint，好把 WAL 阈值挂到**配置**上。
    // 写死 256 MiB 时，58 MiB 的库物理上到不了阈值，那条"WAL 有界"永远为真。
    const storePragmas = readStorePragmas(storePath);

    // 收尾：等一次完整 tick，让最后的批次落库，避免"末态"取到一个半落地的瞬间。
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(TICK_MS * 2, 1000));
    });
    const finalStatus = await probe(agent, port, '/api/v1/status', headers, probeCounter);
    const finalBody = finalStatus.body;
    const durationMs = Number(elapsedMs(runStart, nowNs()).toFixed(3));

    // --- 分析 -------------------------------------------------------------
    // **必须剔除预热段**。进程启动后的前几十秒里 RSS 从 ~59 MiB 爬到 ~85 MiB，
    // 那是 JIT、模块加载、SQLite 页缓存与 V8 堆扩张，不是泄漏。把预热算进趋势，
    // 会得到"300+ MiB/min 的斜率"这种看着吓人、实际毫无意义的数字。
    const warmupIndex = Math.min(
      Math.max(0, samples.length - 2),
      Math.max(2, Math.floor(samples.length * 0.2)),
    );
    const steady = samples.slice(warmupIndex);
    const rssSeries = steady.map((sample) => sample.rss_bytes);
    const rssTrend = linearTrend(steady.map((sample) => ({ t_ms: sample.t_ms, y: sample.rss_bytes })));
    const rssWindow = windowCompare(rssSeries);
    const walSeries = samples.map((sample) => sample.wal_bytes);
    const dbSeries = samples.map((sample) => sample.db_bytes);

    // 探针也剔除前两次：第一次请求要付冷启动成本（实测 p99 可到 90ms），
    // 把它算进"首段"会让"末段是否退化"这个判断变得过于宽松。
    const probeSteady = probeLatencies.slice(2);
    const third = Math.max(1, Math.floor(probeSteady.length / 3));
    const apiFirst = summarize(probeSteady.slice(0, third));
    const apiLast = summarize(probeSteady.slice(probeSteady.length - third));

    const eventsSeries = samples.map((sample) => sample.events_received ?? 0);
    const totalEvents = eventsSeries.length === 0 ? 0 : eventsSeries[eventsSeries.length - 1];
    const actualPolls = samples.length === 0 ? 0 : (samples[samples.length - 1].polls ?? 0);
    const droppedEvents = samples.length === 0 ? 0 : (samples[samples.length - 1].dropped_events ?? 0);
    const sourceFailures = samples.length === 0 ? 0 : (samples[samples.length - 1].source_failures ?? 0);
    const monotonic = isNonDecreasing(eventsSeries);

    // **有效 poll 间隔**：本架构里调度器是"上一次 poll 完成后等 tickMs 再下一次"，
    // 所以有效间隔 = tickMs + 一次批次的处理耗时，必然大于 tickMs。
    // 用 `时长 / tickMs` 当"应有次数"再把差额叫"追不上"，是自欺式指标——那会把
    // 正常行为判成缺陷（实测 60s 内 tickMs=250 只跑出 115 次 poll，恰好是
    // 250ms + ~270ms 处理时间的正常结果）。真正能证伪的是**间隔是否随时间增长**。
    const pollIntervals = [];
    for (let index = 1; index < samples.length; index += 1) {
      const deltaPolls = (samples[index].polls ?? 0) - (samples[index - 1].polls ?? 0);
      const deltaMs = samples[index].t_ms - samples[index - 1].t_ms;
      if (deltaPolls > 0 && deltaMs > 0) {
        pollIntervals.push(deltaMs / deltaPolls);
      }
    }
    const pollIntervalSummary = summarize(pollIntervals);
    const intervalThird = Math.max(1, Math.floor(pollIntervals.length / 3));
    const intervalFirst = summarize(pollIntervals.slice(0, intervalThird));
    const intervalLast = summarize(pollIntervals.slice(pollIntervals.length - intervalThird));
    const intervalDrift = intervalFirst.p50 === null || intervalFirst.p50 === 0 || intervalLast.p50 === null
      ? null
      : Number((intervalLast.p50 / intervalFirst.p50).toFixed(4));

    // 全序列峰值与"首个稳态点"的比值：用来抓"先涨后平"——那种增长会被
    // "首段/末段中位数"完全漏掉（首段取的已经在涨完之后）。
    const rssPeakAll = samples.length === 0 ? 0 : Math.max(...rssSeries.concat(samples.map((x) => x.rss_bytes)));
    const rssFirstSteady = rssSeries.length === 0 ? null : rssSeries[0];
    const rssPeakRatio = rssFirstSteady === null || rssFirstSteady === 0
      ? null
      : Number((rssPeakAll / rssFirstSteady).toFixed(3));
    const durationSeconds = Number((durationMs / 1000).toFixed(1));
    const achievedEventsPerSecond = durationSeconds > 0 ? Number((totalEvents / durationSeconds).toFixed(2)) : null;
    const acceptedFinal = finalBody?.counters?.events_accepted ?? null;
    const persistedFinal = finalBody?.store?.events ?? null;
    const walCeilingBytes = storePragmas === null
      ? WAL_LIMIT_BYTES
      : storePragmas.wal_autocheckpoint * storePragmas.page_size * 3;

    const checks = [];
    addCheck(checks, {
      id: 'soak.events_progressing',
      description: '事件计数单调不减且确实在增长（否则"内存平稳"是因为根本没在工作）',
      expected: '> 0 且单调不减',
      actual: `${totalEvents} events, monotonic=${monotonic}`,
      passed: totalEvents > 0 && monotonic,
    });
    addCheck(checks, {
      id: 'soak.rss_bounded',
      description: 'RSS 末段中位数相对首段不超过 +64 MiB 且不超过 1.25 倍',
      expected: `delta <= ${mib(RSS_DELTA_LIMIT_BYTES)} MiB 且 ratio <= ${RSS_RATIO_LIMIT}`,
      actual: `delta=${mib(rssWindow.delta)} MiB ratio=${rssWindow.ratio}`,
      passed: rssWindow.delta !== null
        && rssWindow.delta <= RSS_DELTA_LIMIT_BYTES
        && (rssWindow.ratio === null || rssWindow.ratio <= RSS_RATIO_LIMIT),
    });
    // 阈值与 autocheckpoint 挂钩（见上文 walCeilingBytes 的说明）。
    addCheck(checks, {
      id: 'soak.wal_bounded',
      description: 'WAL 峰值不超过 autocheckpoint 上限的 3 倍（自动 checkpoint 生效）',
      expected: `<= ${mib(walCeilingBytes)} MiB 且 > 0`,
      actual: `${mib(walSeries.length === 0 ? 0 : Math.max(...walSeries))} MiB`,
      passed: walSeries.length > 0
        && Math.max(...walSeries) > 0
        && Math.max(...walSeries) <= walCeilingBytes,
    });
    // 只对账 `events_received` 的单调性不够：适配器吞掉写入错误时，接收计数照样涨。
    addCheck(checks, {
      id: 'soak.events_persisted',
      description: '落库事件数不少于已接受事件数（防止"接收了但没写进去"）',
      expected: `store.events >= accepted (${acceptedFinal})`,
      actual: persistedFinal,
      passed: typeof persistedFinal === 'number'
        && typeof acceptedFinal === 'number'
        && persistedFinal >= acceptedFinal,
    });
    // "首段/末段中位数"抓不到"先涨后平"：涨完之后的点才进首段。用全序列峰值再兜一层。
    addCheck(checks, {
      id: 'soak.rss_peak_bounded',
      description: '全序列 RSS 峰值不超过首个稳态点的 2 倍（抓"先涨后平"）',
      expected: '<= 2.0 倍',
      actual: rssPeakRatio,
      passed: rssPeakRatio !== null && rssPeakRatio <= 2,
    });
    addCheck(checks, {
      id: 'soak.rss_absolute_cap',
      description: '全序列 RSS 峰值不超过 512 MiB（绝对上限，防止"幅度不大但基数已经很高"）',
      expected: `<= ${mib(RSS_ABSOLUTE_CAP_BYTES)} MiB`,
      actual: `${mib(rssPeakAll)} MiB`,
      passed: rssPeakAll > 0 && rssPeakAll <= RSS_ABSOLUTE_CAP_BYTES,
    });
    addCheck(checks, {
      id: 'soak.poll_interval_stable',
      description: '有效 poll 间隔的末段中位数不超过首段的 2 倍（间隔增长即代表消费追不上产出）',
      expected: '<= 2.0 倍',
      actual: intervalDrift,
      passed: intervalDrift !== null && intervalDrift <= 2,
    });
    addCheck(checks, {
      id: 'soak.api_latency_stable',
      description: '末段 status p99 不超过首段的 5 倍',
      expected: `<= ${apiFirst.p99 === null ? '—' : Number((apiFirst.p99 * API_DEGRADATION_LIMIT).toFixed(3))} ms`,
      actual: apiLast.p99,
      passed: apiFirst.p99 !== null && apiLast.p99 !== null && apiLast.p99 <= apiFirst.p99 * API_DEGRADATION_LIMIT,
      severity: 'warn',
    });
    addCheck(checks, {
      id: 'soak.daemon_still_running',
      description: '结束时 daemon 仍在 running 且健康状态不是 failed',
      expected: 'running / not failed',
      actual: `${finalBody?.lifecycle} / ${finalBody?.health?.status}`,
      passed: finalBody?.lifecycle === 'running' && finalBody?.health?.status !== 'failed',
    });

    // 与 run-bench 同款：运行结束时复算源码摘要，抓"跑的过程中被测代码被改"。
    const codeAfter = codeDigest();
    const codeStable = codeAfter.digest === env.code_digest.digest;
    addCheck(checks, {
      id: 'soak.code_stable_during_run',
      description: '被测量源码在浸泡期间未被修改',
      expected: env.code_digest.digest.slice(0, 16),
      actual: codeAfter.digest.slice(0, 16),
      passed: codeStable,
    });

    const { verdict, failures, warnings } = evaluateChecks(checks);

    const scenario = {
      id: 'soak',
      title: `短时浸泡（${options.minutes} 分钟）`,
      summary: `真实 daemon（mock 模式 + 真实 SQLite 适配器 + 真实 detection 引擎），`
        + `合成来源每 ${TICK_MS}ms 产出 ${BATCH_SIZE} 条（约 ${Math.round((BATCH_SIZE / TICK_MS) * 1000)} 条/秒）；`
        + `每 ${options.sampleMs}ms 采一次样，同时打一条只读 status 请求作为延迟探针。`
        + `${aborted ? '（收到中断，提前结束，结论只覆盖已跑时段）' : ''}`,
      parameters: {
        minutes: options.minutes,
        sample_ms: options.sampleMs,
        tick_ms: TICK_MS,
        batch_size: BATCH_SIZE,
        target_events_per_second: Math.round((BATCH_SIZE / TICK_MS) * 1000),
        max_batch_events: 500,
        seed: options.seed,
        samples: samples.length,
      },
      metrics: [
        { name: '实际时长', value: durationSeconds, unit: 's' },
        { name: '采样点数', value: samples.length, unit: 'point' },
        { name: '累计事件', value: totalEvents, unit: 'event' },
        {
          name: '实际达成速率',
          value: achievedEventsPerSecond,
          unit: 'events/s',
          note: `标称 ${Math.round((BATCH_SIZE / TICK_MS) * 1000)} ev/s；实际受 tick+处理耗时限制，必须报实测值`,
        },
        { name: '累计告警', value: finalBody?.counters?.alerts_written ?? null, unit: 'alert' },
        { name: '实际 poll 次数', value: actualPolls, unit: 'poll' },
        { name: '有效 poll 间隔 p50', value: pollIntervalSummary.p50, unit: 'ms', note: `tick ${TICK_MS}ms + 处理耗时` },
        { name: 'poll 间隔漂移（末/首）', value: intervalDrift, unit: '倍' },
        { name: '被截断事件', value: droppedEvents, unit: 'event' },
        { name: 'RSS 首段中位数（剔除预热）', value: mib(rssWindow.first_median), unit: 'MiB' },
        { name: 'RSS 末段中位数（剔除预热）', value: mib(rssWindow.last_median), unit: 'MiB' },
        // 斜率只在趋势**可解释**时才报数字。R² 很低时把斜率外推成 MiB/h 是典型的误导性指标：
        // 本次实测 R²=0.015 却外推出 24 MiB/h，读起来像"每小时涨 24 MiB"，其实是噪声的斜率。
        {
          name: 'RSS 斜率',
          value: rssTrend === null || rssTrend.r2 < TREND_MIN_R2
            ? null
            : mib(rssTrend.slope_per_minute * 60),
          unit: 'MiB/h',
          note: rssTrend === null
            ? '样本不足'
            : `R²=${rssTrend.r2}；低于 ${TREND_MIN_R2} 视为无趋势，不报斜率`,
        },
        { name: 'RSS 趋势可解释性 R²', value: rssTrend === null ? null : rssTrend.r2, unit: '', note: `阈值 ${TREND_MIN_R2}` },
        { name: 'WAL 峰值（全序列，含预热）', value: mib(walSeries.length === 0 ? 0 : Math.max(...walSeries)), unit: 'MiB' },
        { name: 'RSS 峰值（全序列）', value: mib(rssPeakAll), unit: 'MiB', note: `峰值/首稳态 = ${rssPeakRatio}` },
        { name: '库文件大小（末态）', value: mib(dbSeries.length === 0 ? 0 : dbSeries[dbSeries.length - 1]), unit: 'MiB' },
        { name: '探针 p50（首段）', value: apiFirst.p50, unit: 'ms' },
        { name: '探针 p99（首段）', value: apiFirst.p99, unit: 'ms' },
        { name: '探针 p50（末段）', value: apiLast.p50, unit: 'ms' },
        { name: '探针 p99（末段）', value: apiLast.p99, unit: 'ms' },
        { name: '末态健康', value: finalBody?.health?.status ?? null, unit: '' },
        { name: '探针重试次数', value: probeCounter.retries, unit: 'req', note: 'ECONNRESET/EPIPE 重试，非服务端失败' },
      ],
      tables: [
        {
          title: '采样序列抽样（首 / 中 / 末）',
          rows: pickSamples(samples).map((sample) => ({
            name: `t=${sample.elapsed_s}s`,
            value: `RSS ${mib(sample.rss_bytes)} MiB · WAL ${mib(sample.wal_bytes)} MiB · events ${sample.events_received} · `
              + `probe ${sample.probe_latency_ms} ms`,
            unit: '',
            note: `polls=${sample.polls} dropped=${sample.dropped_events} health=${sample.health_status}`,
          })),
        },
      ],
      observations: [
        `事件从 0 涨到 ${totalEvents}，单调性 ${monotonic ? '保持' : '被破坏'}——`
          + '这是"内存与 WAL 曲线有意义的先决条件"：没有写入的平坦曲线什么都不能证明。',
        `剔除预热（前 ${warmupIndex} 个采样点）后，RSS 首段中位数 ${mib(rssWindow.first_median)} MiB → `
          + `末段 ${mib(rssWindow.last_median)} MiB（Δ ${mib(rssWindow.delta)} MiB，比值 ${rssWindow.ratio}）；`
          + (rssTrend === null
            ? '样本不足以拟合趋势。'
            : `线性拟合 R²=${rssTrend.r2}：${rssTrend.r2 >= TREND_MIN_R2
              ? `趋势可解释，斜率 ${mib(rssTrend.slope_per_minute * 60)} MiB/h。`
              : `低于 ${TREND_MIN_R2}，说明这条线基本是噪声，**不报斜率**——`
                + '把一个 R²≈0 的拟合外推成 MiB/h，会凭空造出一个"每小时涨几十 MiB"的假结论。'}`),
        `WAL 峰值 ${mib(walSeries.length === 0 ? 0 : Math.max(...walSeries))} MiB，`
          + `库文件末态 ${mib(dbSeries.length === 0 ? 0 : dbSeries[dbSeries.length - 1])} MiB。`,
        `调度器实际 poll ${actualPolls} 次；有效 poll 间隔 p50 ${pollIntervalSummary.p50} ms`
          + `（tick ${TICK_MS}ms + 批次处理耗时，所以必然大于 tick），末段/首段漂移 ${intervalDrift} 倍；`
          + `批次截断 ${droppedEvents} 条、来源失败 ${sourceFailures} 次（每批 ${BATCH_SIZE} 条 vs 上限 500，`
          + '恒为 0 是架构决定的，故只作为观测、不作为门禁）。'
          + '本架构里调度器一次只跑一个 poll，"队列深度"不会增长——能证伪的是批次截断与间隔持续变长这两件事。'
          + '刻意不用"时长 / tickMs = 应有次数"当基线：那个算法把正常的处理耗时算成缺陷。',
        `告警写入只有 ${finalBody?.counters?.alerts_written ?? 0} 条：合成来源的进程名只有 5 种，`
          + '聚合之后几乎全部落进同几条告警。所以本次浸泡**没有对告警写路径形成压力**，'
          + '它验证的是事件写入 + 聚合 + 只读 API 的稳定性，不是"告警风暴"下的稳定性。',
        aborted ? '本次运行被中断，结论只覆盖已完成的时段。' : '本次运行按计划跑完。',
      ],
    };

    const result = {
      schema: RESULT_SCHEMA,
      kind: 'soak',
      task_id: 'M9-BENCH-SOAK',
      author: 'PT-dove',
      generated_at: generatedAt,
      seed: options.seed,
      profile: `${options.minutes}min`,
      duration_ms: durationMs,
      aborted,
      env,
      code_digest_after: codeAfter,
      scenarios: [scenario],
      checks,
      verdict,
      failures,
      warnings,
      findings: checks.filter((check) => check.passed === false).map((check, index) => ({
        id: `F-${index + 1}`,
        severity: check.severity === 'warn' ? 'P2' : 'P1',
        title: check.description,
        detail: `期望 ${JSON.stringify(check.expected)}，实测 ${JSON.stringify(check.actual)}。`,
        source_check: check.id,
        scope: 'observed-only',
      })),
      notes: [
        '所有数据在系统临时目录内，跑完即删；未触碰任何真实数据库或日志。',
        '浸泡只跑 5–10 分钟：能发现快速泄漏，不能证明长期稳定；72h/7d 长稳不在本任务范围。',
        '采样本身有成本（每条采样一次 status 请求 + 两次 statSync），已计入探针延迟。',
      ],
      limitations: [
        '单机单进程；本机空闲内存约 1.8 GiB，长时间高负载可能被系统换页影响。',
        '未强制 GC，RSS 锯齿受 V8 GC 时机影响，不能据此反推"已泄漏"或"已回收"。',
        '合成来源是恒定速率，不模拟突发流量；突发场景需要单独的注入测试。',
        '只观察 daemon 暴露的只读状态，引擎内部的指纹表/窗口状态没有直接读数。',
        '合成来源只有 5 个进程名，聚合后告警数量很少；本次浸泡未覆盖"告警风暴 / 高频告警写入"场景。',
        '每条 status 探针内含 4 次 `COUNT(*)`（telemetry_event/finding/alert/analysis_outbox），'
          + '在大表上是全表扫描；5 秒一次的频率下它同时让页缓存保持热，RSS 曲线因此偏乐观。',
        '**泄漏检测下限**：6 分钟窗口内、幅度小于 64 MiB 且比例低于 1.25 的持续增长不可分辨；'
          + 'RSS 锯齿振幅（本次约 17 MiB）以内的泄漏会被噪声淹没。短时浸泡不能证明长期稳定。',
      ],
      samples,
      raw: { final_status_shape: finalBody === null ? null : {
        lifecycle: finalBody.lifecycle,
        health: finalBody.health,
        counters: finalBody.counters,
        store: { kind: finalBody.store?.kind, open: finalBody.store?.open, events: finalBody.store?.events },
      } },
    };

    const baseName = `soak-${options.minutes}min-${stampOf(generatedAt)}`;
    const markdown = renderMarkdown(result);
    const paths = writeArtifacts({ outDir: options.out ?? undefined, baseName, result, markdown });
    result.artifacts = paths;
    writeArtifacts({ outDir: options.out ?? undefined, baseName, result, markdown });

    process.stdout.write(`soak: verdict=${verdict} checks=${checks.length} failures=${failures.length} warnings=${warnings.length}\n`);
    process.stdout.write(`soak: json=${paths.json_path}\n`);
    process.stdout.write(`soak: markdown=${paths.markdown_path}\n`);
    if (failures.length > 0) {
      process.stdout.write(`soak: failing checks: ${failures.join(', ')}\n`);
    }
    if (options.gate === false) {
      return 0;
    }
    return verdict === 'pass' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`soak: fatal: ${error && error.stack ? error.stack : String(error)}\n`);
    return 2;
  } finally {
    process.removeListener('SIGINT', onSigint);
    agent.destroy();
    try {
      await daemon.stop('soak-done');
    } catch {
      // 停止失败不能掩盖真正的失败原因。
    }
    tempRoot.cleanup();
  }
}

/**
 * 判断序列是否单调不减。
 *
 * @param {number[]} values 序列。
 * @returns {boolean} 是否单调不减。
 */
function isNonDecreasing(values) {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < values[index - 1]) {
      return false;
    }
  }
  return true;
}

/**
 * 从采样序列里取首/中/末三点，避免报告里贴几十行。
 *
 * @param {object[]} samples 采样。
 * @returns {object[]} 抽样。
 */
function pickSamples(samples) {
  if (samples.length <= 3) {
    return samples;
  }
  return [samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]];
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`soak: fatal: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 2;
});
