/**
 * longrun.mjs — 长稳 runner（G6 的 72 小时载体）。
 *
 * 为什么不是给 soak.mjs 加个参数：
 * `soak.mjs:105` 把 `--minutes` 硬编码在 1–10，注释写明「本任务不含 72h/7d」。
 * 短时浸泡与长稳的差别不只是时长：
 *   - 短时浸泡的采样、报告、临时目录生命周期都在一个进程里一次跑完；
 *   - 长稳必须能**崩溃后续跑**，必须**按小时切片留证**，必须把「运行期间源码是否变」
 *     换成「**冻结副本的字节是否变**」——因为活仓库里永远有别的写者。
 * 所以这是一个独立 runner，**不修改 soak.mjs**。
 *
 * 复用的口径（与 soak.mjs 一致，便于横向对照）：
 *   - 同一个真实 daemon（mock 模式 + 真实 SQLite 适配器 + 真实 detection 引擎）；
 *   - 同一条只读 status 探针（`/api/v1/status`），同一组计数器字段；
 *   - 同一套 RSS 统计口径：剔除预热 → 首段/末段中位数对比 → 线性趋势（R²<0.3 不报斜率）；
 *   - 同一套 poll 口径：有效间隔 = 采样间隔 / poll 增量，比较末段与首段漂移；
 *     并把 soak 明说「刻意不用 时长/tickMs 当基线」的那条**反过来**做成独立判据
 *     （`longrun.polls_match_tick`）——长跑里「调度器悄悄罢工」才是真风险。
 *
 * 新增能力（短时浸泡不需要、长稳必须有）：
 *   1. `--hours 72`：时长参数化，上限 720 小时；
 *   2. **每小时一个分片日志** `logs/h000.jsonl`…：每行一条采样，小时末追加一条汇总行；
 *      崩溃只损失当前小时里尚未落盘的部分，已关闭分片不受影响；
 *   3. **断点续跑**：`state/state.json` 记录累计计数、事件游标、已完成小时，重启后接着算。
 *      分析**永远从磁盘分片重新读**，所以续跑后的报告覆盖全程，不是只剩最后一段；
 *   4. **三项基线漂移**：内存（RSS）、句柄（libuv 句柄）、线程（OS 线程，需外部采样）；
 *   5. **退出码只有 0/1**：0 = 全部已评估的 blocker 判据通过；1 = 有失败或有致命错误。
 *      参数错误、daemon 起不来、分片损坏，一律 1，不引入第三态让人去猜。
 *
 * 判据纪律（照搬 M9 的教训）：
 *   - 每条判据都有 `expected` 与 `actual`，**能失败**；
 *   - **数据不足不许判 pass**：记 `deferred`（未评估），既不算通过也不算失败，
 *     并在报告「未测量」一节列名。这是对 soak `api_latency_stable` 用实测派生期望值
 *     那类「看着绿、其实恒真」的直接修正；
 *   - 阈值一律**常量**，不读本次实测派生。
 *
 * 用法：
 *   node tests/soak/longrun.mjs --run-dir $AIDN_HOME/_soak-run/2026-11-04 --hours 72 \
 *     --freeze-manifest $AIDN_HOME/_soak-freeze/2026-11-04/FREEZE.json
 *   node tests/soak/longrun.mjs --run-dir ... --resume          # 崩溃后接着算
 *   node tests/soak/longrun.mjs --run-dir ... --hours 0.05 --sample-ms 2000   # 冒烟
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createDaemon } from '../../apps/daemon/src/index.js';
import { createEventStoreAdapter } from '../../apps/daemon/src/adapters/event-store.js';
import { loadConfig } from '../../apps/daemon/src/config.js';
import { REPO_ROOT, captureEnv, codeDigest } from '../bench/lib/env.js';
import { makeBenchRulePack } from '../bench/lib/rulepack.js';
import { addCheck, evaluateChecks } from '../bench/lib/report.js';
import { elapsedMs, linearTrend, mib, nowNs, summarize, windowCompare } from '../bench/lib/stats.js';
import { createWorkload } from '../bench/lib/synthetic.js';
import { fileBytes } from '../bench/lib/tempdir.js';

/** 结果结构版本；字段语义变化时必须升。 */
export const RUN_SCHEMA = 'aegis.soak.longrun/1';

/** 一小时的毫秒数。 */
export const HOUR_MS = 3_600_000;

/** 分片 JSONL 的记录类型。 */
const KIND_SAMPLE = 's';
const KIND_HOUR = 'h';

/**
 * 会参与「跨段累加」的计数器。
 *
 * daemon 的这几个计数器是**跨重启持续累计**的（`state-store` 的设计目标就是
 * "reporting the same totals across a restart instead of resetting to zero"），
 * 所以正常重启后读到的值本来就接着上次数。
 * 但硬杀之后最后一次落盘的计数可能落后，也可能因为换个数据卷而真的从 0 开始——
 * 两种都可能。**判据不能假设其中一种**，所以这里用「计数器回退即认为是重置」的
 * 自适应偏移（见主循环）：正常累计不动偏移，真回退才把上一段的值补进来。
 * 早期版本无条件把上一段的总数当基数加一次，结果「已接受」被重复计数，
 * `longrun.events_persisted` 在续跑后假红——这是本 runner 的第一个真 bug。
 */
const COUNTER_KEYS = Object.freeze([
  'events_received',
  'events_accepted',
  'events_duplicate',
  'alerts_written',
  'findings_written',
  'polls',
]);

/**
 * 判据阈值：**全部是常量**。
 *
 * 与 soak.mjs 同名判据取同一数值，便于把 72h 结果与 6/8 分钟浸泡横向对照。
 * 例外是 `apiP90AbsMs` 与 `slopeMaxMibPerHour`：长稳必须新增绝对下限，
 * 因为短时浸泡的「相对首段 5 倍」在 72 小时里会被基线自身漂移带跑（M9 的 H-5）。
 */
export const LIMITS = Object.freeze({
  rssDeltaBytes: 64 * 1024 * 1024,
  rssRatio: 1.25,
  rssPeakRatio: 2,
  rssAbsoluteCapBytes: 512 * 1024 * 1024,
  trendMinR2: 0.3,
  slopeMaxMibPerHour: 2,
  walFactor: 3,
  walFallbackBytes: 256 * 1024 * 1024,
  pollIntervalDrift: 2,
  pollFloor: 0.8,
  rateFloor: 0.8,
  /**
   * 单飞调度器的效率常数。
   *
   * 调度器一次只跑一个 poll（`scheduler.js` 的 `inFlight`），并且「上一次完成后再等
   * intervalMs」——所以**有效间隔 = tick + 处理耗时**，实际速率必然低于 `batch/tick` 标称值。
   * 实测：tick=250 时 48.79/100 = 0.49（M9 的 6 分钟浸泡），tick=1000 时 6 次/9s = 0.66。
   *
   * 把这个常数写在这里，是为了让「目标速率」是**一个说出来的数**，而不是拿标称值假装可达：
   * 默认目标 = 标称 × 0.5；判据下限再打 0.8 折，即「实际 ≥ 0.4 × 标称」。
   * 标称与实测的差距**另有 warn 判据显式登记**（`longrun.rate_matches_nominal`），不静默。
   */
  efficiencyConstant: 0.5,
  /** 斜率判据需要的最短稳态时长（小时）：1 小时内的 RSS 斜率只是抖动的斜率。 */
  slopeMinSpanHours: 3,
  apiP90AbsMs: 250,
  apiP90Ratio: 5,
  sampleGapFactor: 3,
  baselineRssRatio: 1.25,
  baselineRssDeltaBytes: 64 * 1024 * 1024,
  baselineHandleRatio: 1.5,
  baselineHandleDelta: 64,
  baselineThreadRatio: 1.5,
  baselineThreadDelta: 8,
  diskFloorBytes: 2 * 1024 * 1024 * 1024,
  durationFloor: 0.99,
  /** 漂移判定至少需要几个小时基线。 */
  minHourBaselines: 3,
});

/** 单次 status 探针的请求级超时。多表 COUNT(*) 在大库上会变慢，但 5 s 足够。 */
const PROBE_TIMEOUT_MS = 5000;

/** 探针最多尝试次数；仍失败才让整轮 fatal。 */
const PROBE_ATTEMPTS = 3;

/** 探针重试间隔。 */
const PROBE_RETRY_MS = 500;

/** 默认参数。 */
const DEFAULTS = Object.freeze({
  hours: 72,
  sampleMs: 60_000,
  tickMs: 1000,
  batchSize: 1,
  seed: 20261102,
  port: 0,
  resume: false,
  gate: true,
  osSamples: null,
  freezeManifest: null,
  targetEvPerSec: null,
});

/**
 * 解析命令行。
 *
 * 所有数值做闭区间校验：越界**直接拒绝**，不做静默夹取——长稳跑 72 小时，
 * 起跑后才发现参数被夹成别的值，等于白跑。
 *
 * @param {string[]} argv 参数（不含 node 与脚本名）。
 * @returns {object} 选项。
 * @throws {Error} 参数非法。
 */
export function parseArgs(argv) {
  const options = { ...DEFAULTS, runDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    const takeNumber = (min, max, label) => {
      const value = Number(next);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${token} must be a number in [${min}, ${max}] (got ${JSON.stringify(next)}; ${label})`);
      }
      index += 1;
      return value;
    };
    const takeString = (label) => {
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error(`${token} requires a value (${label})`);
      }
      index += 1;
      return next;
    };
    switch (token) {
      case '--hours':
        options.hours = takeNumber(0.01, 720, 'long-run ceiling is 720h');
        break;
      case '--sample-ms':
        options.sampleMs = takeNumber(500, 3_600_000, '72h runs use >= 30000ms in practice');
        break;
      case '--tick-ms':
        options.tickMs = takeNumber(50, 600_000, 'scheduler tick');
        break;
      case '--batch-size':
        options.batchSize = takeNumber(1, 500, 'must stay <= maxBatchEvents(500)');
        break;
      case '--seed':
        options.seed = takeNumber(0, 2 ** 31 - 1, 'deterministic workload seed');
        break;
      case '--port':
        options.port = takeNumber(0, 65535, '0 = ephemeral, the safest "own port"');
        break;
      case '--run-dir':
        options.runDir = takeString('absolute path outside the repository');
        break;
      case '--os-samples':
        options.osSamples = takeString('JSONL of external OS samples ({t, handles, threads})');
        break;
      case '--freeze-manifest':
        options.freezeManifest = takeString('FREEZE.json written by tests/soak/freeze.mjs');
        break;
      case '--target-ev-per-sec':
        options.targetEvPerSec = takeNumber(0.01, 10_000, 'declared achievable rate (default: nominal × 0.5)');
        break;
      case '--resume':
        options.resume = true;
        break;
      case '--no-gate':
        options.gate = false;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  if (options.runDir === null) {
    throw new Error('--run-dir is required (e.g. --run-dir $AIDN_HOME/_soak-run/2026-11-04)');
  }
  if ((options.batchSize / options.tickMs) * 1000 < 0.01) {
    throw new Error('batch-size / tick-ms yields < 0.01 events/s; the soak would measure an idle daemon');
  }
  return options;
}

/**
 * 运行目录守卫。
 *
 * 72 小时的数据（库、分片、状态）必须落在一个**明确、独立、不在任何仓库里**的位置：
 *   - 不给默认值：默认值会在「忘了传参」时写进 cwd，而 cwd 可能就是仓库；
 *   - 拒绝仓库内路径（冻结副本与活仓库都不行）；
 *   - 拒绝盘符根与系统目录，避免 `--run-dir D:/` 一次写穿整块盘。
 *
 * 不用 `bench/lib/tempdir.js` 的 `assertHarmlessPath`：它要求路径**必须在系统临时目录下**，
 * 而长稳数据要跨进程、跨天存活，不能放在会被清理的临时目录里。
 *
 * @param {string} target 目标路径。
 * @param {string} label 报错标签。
 * @returns {string} 解析后的绝对路径。
 * @throws {Error} 路径不可用。
 */
export function assertRunPath(target, label = 'run path') {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error(`${label}: expected a non-empty path`);
  }
  if (path.isAbsolute(target) === false) {
    throw new Error(`${label}: must be an absolute path (got ${target})`);
  }
  const resolved = path.resolve(target);
  const lower = resolved.toLowerCase();
  const repoLower = path.resolve(REPO_ROOT).toLowerCase();
  if (lower === repoLower || lower.startsWith(`${repoLower}${path.sep}`)) {
    throw new Error(`${label}: refusing a path inside the repository being measured (${resolved})`);
  }
  const parsed = path.parse(resolved);
  if (parsed.root.toLowerCase().replace(/[\\/]+$/u, '') === lower.replace(/[\\/]+$/u, '')) {
    throw new Error(`${label}: refusing a drive root (${resolved})`);
  }
  const forbiddenRoots = [
    process.env.SystemRoot,
    process.env.windir,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => path.resolve(value).toLowerCase());
  for (const root of forbiddenRoots) {
    if (lower === root || lower.startsWith(`${root}${path.sep}`)) {
      throw new Error(`${label}: refusing a system directory (${resolved})`);
    }
  }
  return resolved;
}

/**
 * 原子写 JSON：先写 `.tmp` 再 rename。
 *
 * 72 小时里进程会被杀很多次（包括我们自己的 SIGINT）。半个 JSON 会让续跑直接失败，
 * 所以状态文件只能整份出现或整份不存在。
 *
 * @param {string} target 目标文件。
 * @param {unknown} value 值。
 * @returns {void}
 */
export function writeJsonAtomic(target, value) {
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
}

/**
 * 读 JSON；文件不存在返回 null，解析失败则抛出（损坏的状态文件不能被当成「首次运行」）。
 *
 * @param {string} target 文件。
 * @returns {object|null} 值。
 */
function readJsonIfPresent(target) {
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return JSON.parse(text);
}

/**
 * 分片日志路径：每小时一个文件。
 *
 * @param {string} logDir 日志目录。
 * @param {number} hour 小时序号。
 * @returns {string} 绝对路径。
 */
export function shardPath(logDir, hour) {
  return path.join(logDir, `h${String(hour).padStart(3, '0')}.jsonl`);
}

/**
 * 追加一行 JSONL。
 *
 * @param {string} file 文件。
 * @param {object} record 记录。
 * @returns {void}
 */
export function appendLine(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * 读出全部小时分片。
 *
 * 崩溃可能留下半行（append 未完整刷盘）。坏行**不静默丢弃**：计数后写进报告，
 * 否则「分片完整」这句话没有依据。
 *
 * @param {string} logDir 日志目录。
 * @returns {{samples: object[], hours: object[], badLines: number, shards: string[]}} 内容。
 */
export function readShards(logDir) {
  const shards = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((name) => /^h\d{3}\.jsonl$/u.test(name)).sort()
    : [];
  const samples = [];
  const hours = [];
  let badLines = 0;
  for (const name of shards) {
    const text = fs.readFileSync(path.join(logDir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        badLines += 1;
        continue;
      }
      if (record && record.k === KIND_SAMPLE) {
        samples.push(record);
      } else if (record && record.k === KIND_HOUR) {
        hours.push(record);
      }
    }
  }
  samples.sort((left, right) => left.i - right.i);
  hours.sort((left, right) => left.hour - right.hour);
  return { samples, hours, badLines, shards };
}

/**
 * 读一次 SQLite 的页大小与 autocheckpoint（与 soak 同口径）。
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
 * 发一个 GET 并解析 JSON（与 soak 同口径）。
 *
 * **必须有请求级超时**：`new http.Agent({timeout})` 只设 socket 超时，触发时 emit 一个
 * `timeout` 事件而**不会**自动销毁请求。72 小时里只要有一次探针挂住，`await` 就再也不返回，
 * 采样静默停止——而"没有新采样"在报告里看起来和"曲线平稳"一模一样。
 * 所以这里显式 `req.setTimeout(...)` 后 destroy，把挂起变成一次可重试的错误。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {string} pathname 路径。
 * @param {Record<string, string>} headers 请求头。
 * @param {number} [timeoutMs] 单请求超时。
 * @returns {Promise<{status: number, body: object|null, latency_ms: number}>} 结果。
 */
function getJson(agent, port, pathname, headers, timeoutMs = PROBE_TIMEOUT_MS) {
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
    req.setTimeout(timeoutMs, () => {
      const error = new Error(`probe timeout after ${timeoutMs} ms`);
      error.code = 'EPROBETIMEOUT';
      req.destroy(error);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 探针：传输层错误重试若干次，仍失败才抛。
 *
 * 72 小时里单次 ECONNRESET / 超时是噪声，不该让整轮作废（那会把"一次抖动"记成"长稳失败"）；
 * 但**重试次数必须被统计并写进报告**——"悄悄重试"会把真实的连接问题藏起来。
 *
 * @param {http.Agent} agent 连接池。
 * @param {number} port 端口。
 * @param {Record<string, string>} headers 请求头。
 * @param {{retries: number, failures: number}} counter 计数。
 * @param {number} [attempts] 最多尝试次数。
 * @returns {Promise<{status: number, body: object|null, latency_ms: number}>} 结果。
 */
async function probe(agent, port, headers, counter, attempts = PROBE_ATTEMPTS) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getJson(agent, port, '/api/v1/status', headers);
    } catch (error) {
      lastError = error;
      counter.failures = (counter.failures ?? 0) + 1;
      if (attempt < attempts - 1) {
        counter.retries = (counter.retries ?? 0) + 1;
        process.stdout.write(`longrun: probe attempt ${attempt + 1}/${attempts} failed `
          + `(${error?.code ?? error?.message ?? 'unknown'}); retrying in ${PROBE_RETRY_MS} ms\n`);
        await sleep(PROBE_RETRY_MS);
      }
    }
  }
  throw lastError ?? new Error('probe failed without an error');
}

/**
 * 创建一个持续产出的合成来源（与 soak 同一实现，多一个起始游标）。
 *
 * 起始游标必须能从状态恢复：否则续跑会把写过的事件再产一遍，事件被判重吞掉，
 * `events_accepted` 从此永远追不上 `events_received`——「落库 vs 已接受」这条判据
 * 在续跑后就会失效，而不是给出真信号。
 *
 * @param {{id: string, workload: object, batchSize: number, intervalMs: number, startIndex: number}} options 选项。
 * @returns {object} 来源。
 */
export function createSyntheticSource(options) {
  let cursor = options.startIndex;
  const start = cursor;
  return {
    id: options.id,
    kind: 'synthetic',
    intervalMs: options.intervalMs,
    cursor: () => cursor,
    produced: () => cursor - start,
    poll() {
      const events = new Array(options.batchSize);
      for (let offset = 0; offset < options.batchSize; offset += 1) {
        events[offset] = options.workload.event(cursor + offset);
      }
      cursor += options.batchSize;
      return Promise.resolve({ events, cursor: { index: cursor } });
    },
  };
}

/**
 * 一组数值的中位数；空集返回 null。
 *
 * @param {Array<number|null>} values 值。
 * @returns {number|null} 中位数。
 */
export function medianOf(values) {
  const clean = (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (clean.length === 0) {
    return null;
  }
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

/**
 * 取一小时采样序列的 RSS / 活动资源中位数。
 *
 * 为什么用「小时中位数」而不是单点：72 小时里 RSS 有 GC 锯齿（实测振幅约 17 MiB），
 * 单点比较会把锯齿当漂移；中位数对锯齿免疫，对「每小时涨 1 MiB」这种慢漂移敏感。
 *
 * @param {object[]} samples 该小时采样。
 * @param {number} warmupSamples 要剔除的头部点数（仅首小时非 0）。
 * @returns {{n: number, rss: number|null, active: number|null, api_p90: number|null}|null} 基线。
 */
export function hourBaseline(samples, warmupSamples) {
  const kept = samples.slice(Math.min(warmupSamples, Math.max(0, samples.length - 3)));
  if (kept.length < 1) {
    return null;
  }
  return {
    n: kept.length,
    rss: medianOf(kept.map((sample) => sample.rss_bytes)),
    active: medianOf(kept.map((sample) => sample.active_resources)),
    api_p90: summarize(kept.map((sample) => sample.probe_latency_ms)).p90,
  };
}

/**
 * 把外部 OS 采样（`--os-samples` 的 JSONL）按小时归并。
 *
 * 为什么线程数要外部采：win32 上纯 Node 拿不到 OS 线程总数（`process.report` 只有
 * `libuv` 与 `workers`，没有线程计数），而「线程数缓慢增长」恰恰是最难发现的泄漏形态。
 * 外部采样由操作者在检查点时写入，**来源写进报告**，不伪装成 runner 自带探针。
 * 没有这个文件时线程轴记「未测量」，**不判 pass**。
 *
 * @param {string|null} filePath JSONL 路径。
 * @param {number} startedAtMs 计划开始时刻。
 * @returns {{byHour: Map<number, {handles: number[], threads: number[]}>, count: number, source: string, error: string|null}} 归并结果。
 */
export function readExternalOsSamples(filePath, startedAtMs) {
  const byHour = new Map();
  if (filePath === null) {
    return { byHour, count: 0, source: null, error: null };
  }
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      byHour,
      count: 0,
      source: filePath,
      error: error && error.code === 'ENOENT' ? 'file-not-found' : String(error.message),
    };
  }
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof record.t === 'number' ? record.t : Date.parse(String(record.t));
    if (!Number.isFinite(at)) {
      continue;
    }
    const hour = Math.floor((at - startedAtMs) / HOUR_MS);
    if (hour < 0) {
      continue;
    }
    const bucket = byHour.get(hour) ?? { handles: [], threads: [] };
    if (Number.isFinite(record.handles)) {
      bucket.handles.push(Number(record.handles));
    }
    if (Number.isFinite(record.threads)) {
      bucket.threads.push(Number(record.threads));
    }
    byHour.set(hour, bucket);
    count += 1;
  }
  return { byHour, count, source: filePath, error: null };
}

/**
 * 把一条检查项加入列表；`deferred` 的项不算通过也不算失败。
 *
 * @param {object[]} sink 收集数组。
 * @param {object} definition 定义。
 * @returns {void}
 */
function pushCheck(sink, definition) {
  addCheck(sink, definition);
  if (definition.deferred === true) {
    sink[sink.length - 1].deferred = true;
    sink[sink.length - 1].note = definition.note ?? '数据不足，未评估';
  }
}

/**
 * 某条「小时基线」轴上的首末漂移。
 *
 * 只取该轴上有值的首个小时与末个小时——缺值的小时（比如崩溃导致没有小时汇总行）
 * 不应让整条判据变成 NaN，但也**不许**因此变成 pass：值的个数 < 2 时返回 null，
 * 调用方把判据记未评估。
 *
 * @param {object[]} rows 小时行。
 * @param {string} key 字段名。
 * @returns {{first: number, last: number, hour_first: number, hour_last: number,
 *   delta: number, ratio: number, n: number}|null} 漂移。
 */
export function axisDrift(rows, key) {
  const valid = rows.filter((row) => typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] > 0);
  if (valid.length < 2) {
    return null;
  }
  const first = valid[0];
  const last = valid[valid.length - 1];
  return {
    first: first[key],
    last: last[key],
    hour_first: first.hour,
    hour_last: last.hour,
    delta: Number((last[key] - first[key]).toFixed(4)),
    ratio: Number((last[key] / first[key]).toFixed(4)),
    n: valid.length,
  };
}

/**
 * 逐项判定。**这是本文件最该被审查的部分**：每条判据都要能失败。
 *
 * 输入全部来自「已落盘的证据」（分片里的采样与小时汇总），不含本次运行的内存态，
 * 所以同一份分片重放会得到同一份判定，续跑后的报告因此覆盖全程。
 *
 * @param {object} input 输入。
 * @returns {object} 判定。
 */
export function analyze(input) {
  const {
    samples, hours, plan, freeze, freezeNow, finalBody, storePragmas,
    diskFreeBytes, badLines, osProbe, endedAtMs, segments,
  } = input;
  const checks = [];
  const findings = [];

  const elapsedS = Number(((endedAtMs - plan.started_at_ms) / 1000).toFixed(1));
  const plannedS = plan.hours * 3600;

  // ---- 采样序列 ----
  // 预热剔除：首段前 10% 或 10 点取较大者，但不超过全部样本的 1/3。
  const warmupSamples = samples.length < 12
    ? 0
    : Math.min(Math.floor(samples.length / 3), Math.max(10, Math.floor(samples.length * 0.1)));
  const steady = samples.slice(warmupSamples);
  const rssWindow = windowCompare(steady.map((sample) => sample.rss_bytes));
  const rssTrend = linearTrend(steady.map((sample) => ({ t_ms: sample.t_ms, y: sample.rss_bytes })));
  const rssPeak = steady.length === 0 ? 0 : Math.max(...steady.map((sample) => sample.rss_bytes));
  const rssFirstSteady = steady.length === 0 ? null : steady[0].rss_bytes;
  const rssPeakRatio = rssFirstSteady === null || rssFirstSteady === 0
    ? null
    : Number((rssPeak / rssFirstSteady).toFixed(3));

  // 探针延迟：与 soak 一样剔除前两次（冷启动），但统计量用 p90 而不是 p99 ——
  // 72 小时里 n 很大，p99 就是最大值，一次 OS 停顿即可定生死（M9 的 H-5）。
  const probeSeries = samples.slice(2).map((sample) => sample.probe_latency_ms);
  const third = Math.max(1, Math.floor(probeSeries.length / 3));
  const apiFirst = summarize(probeSeries.slice(0, third));
  const apiLast = summarize(probeSeries.slice(probeSeries.length - third));

  // ---- poll 口径（与 soak 一致：有效间隔 = Σdt / Σdpolls）----
  const pollIntervals = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous.seg !== current.seg) {
      continue; // 跨重启的间隔没有意义：中间 daemon 是停的。
    }
    const deltaPolls = (current.adj_polls ?? 0) - (previous.adj_polls ?? 0);
    const deltaMs = current.t_ms - previous.t_ms;
    if (deltaPolls > 0 && deltaMs > 0) {
      pollIntervals.push(deltaMs / deltaPolls);
    }
  }
  const pollSummary = summarize(pollIntervals);
  const intervalThird = Math.max(1, Math.floor(pollIntervals.length / 3));
  const intervalFirst = summarize(pollIntervals.slice(0, intervalThird));
  const intervalLast = summarize(pollIntervals.slice(Math.max(0, pollIntervals.length - intervalThird)));
  const intervalDrift = intervalFirst.p50 === null || intervalFirst.p50 === 0 || intervalLast.p50 === null
    ? null
    : Number((intervalLast.p50 / intervalFirst.p50).toFixed(4));

  // 「按 tick 应有的 poll 次数」只用**段内活跃时长**：重启期间 daemon 是停的，
  // 把停机时间算进分母会把一次崩溃变成「调度器罢工」，那是错误归因。
  const activeMs = segments.reduce((sum, segment) => sum + (segment.active_ms ?? 0), 0);
  const lastSample = samples.length === 0 ? null : samples[samples.length - 1];
  const actualPolls = lastSample === null ? 0 : (lastSample.adj_polls ?? 0);

  // ---- 事件 ----
  const totalEvents = lastSample === null ? 0 : (lastSample.adj_events_received ?? 0);
  const acceptedTotal = lastSample === null ? 0 : (lastSample.adj_events_accepted ?? 0);
  const alertTotal = lastSample === null ? 0 : (lastSample.adj_alerts_written ?? 0);
  const droppedTotal = lastSample === null ? 0 : (lastSample.dropped_events ?? 0);
  const sourceFailures = lastSample === null ? 0 : (lastSample.source_failures ?? 0);
  const achievedRate = elapsedS > 0 ? Number((totalEvents / elapsedS).toFixed(3)) : null;
  const nominalRate = plan.nominal_ev_per_sec
    ?? Number(((plan.batch_size / plan.tick_ms) * 1000).toFixed(3));
  // 声明目标：起跑前写进计划，**不读本次实测**。缺省时按「标称 × 单飞效率常数」给出。
  const targetRate = plan.target_ev_per_sec
    ?? Number((nominalRate * LIMITS.efficiencyConstant).toFixed(3));
  let monotonic = true;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index].adj_events_received ?? 0) < (samples[index - 1].adj_events_received ?? 0)) {
      monotonic = false;
      break;
    }
  }

  // ---- 采样连续性（段内）----
  let maxGapMs = 0;
  let maxGapAt = null;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].seg !== samples[index - 1].seg) {
      continue;
    }
    const gap = samples[index].t_ms - samples[index - 1].t_ms;
    if (gap > maxGapMs) {
      maxGapMs = gap;
      maxGapAt = samples[index].elapsed_s;
    }
  }

  // ---- 小时基线（三项漂移的原始数据）----
  const buckets = new Map();
  for (const sample of samples) {
    const bucket = buckets.get(sample.hour) ?? [];
    bucket.push(sample);
    buckets.set(sample.hour, bucket);
  }
  const hourIndexes = [...buckets.keys()].sort((left, right) => left - right);
  const firstHourIndex = hourIndexes.length === 0 ? null : hourIndexes[0];
  const hourRows = [];
  for (const hour of hourIndexes) {
    const bucket = buckets.get(hour);
    const baseline = hourBaseline(bucket, hour === firstHourIndex ? warmupSamples : 0);
    const closeRecord = hours.find((record) => record.hour === hour) ?? null;
    const external = osProbe === null ? null : (osProbe.byHour.get(hour) ?? null);
    hourRows.push({
      hour,
      samples: bucket.length,
      closed: closeRecord !== null,
      rss_mib: baseline === null ? null : mib(baseline.rss),
      // 句柄与线程是「小时点位」：句柄在小时关闭时用 process.report 采一次（单次约 98 ms），
      // 线程来自外部采样。两者都不在采样热路径上。
      handles: closeRecord === null ? null : (closeRecord.libuv_handles ?? null),
      active_resources: baseline === null ? null : baseline.active,
      threads: medianOf(external === null ? null : external.threads),
      events: bucket.length === 0 ? null : bucket[bucket.length - 1].adj_events_received,
      api_p90_ms: baseline === null ? null : baseline.api_p90,
    });
  }
  const enoughHours = hourRows.length >= LIMITS.minHourBaselines;

  const walCeiling = storePragmas === null
    ? LIMITS.walFallbackBytes
    : storePragmas.wal_autocheckpoint * storePragmas.page_size * LIMITS.walFactor;
  const walPeak = samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.wal_bytes));

  // ================= 判据 =================
  // 1. 时长
  pushCheck(checks, {
    id: 'longrun.duration_completed',
    description: '实际时长达到计划时长的 99% 以上（没跑完的长稳不能叫长稳）',
    expected: `>= ${Number((plannedS * LIMITS.durationFloor).toFixed(0))} s (计划 ${plan.hours}h)`,
    actual: `${elapsedS} s`,
    passed: elapsedS >= plannedS * LIMITS.durationFloor,
  });
  // 2. 小时分片
  const expectedShards = Math.max(1, Math.ceil(plan.hours - 1e-9));
  const closedShards = hours.length;
  pushCheck(checks, {
    id: 'longrun.hour_shards_complete',
    description: '每小时一个分片，且每个分片都有小时汇总行（缺分片就无法逐小时取证）',
    expected: `${expectedShards} 个已关闭分片`,
    actual: `${closedShards} 个已关闭 / ${hourIndexes.length} 个有采样`,
    passed: closedShards >= expectedShards && hourIndexes.length === closedShards,
  });
  // 3. 采样连续性
  const gapLimitMs = plan.sample_ms * LIMITS.sampleGapFactor;
  pushCheck(checks, {
    id: 'longrun.sampling_continuity',
    description: '段内相邻采样间隔不超过 3 倍采样周期（采样被中断时「曲线平稳」是假的）',
    expected: `<= ${gapLimitMs} ms`,
    actual: `${maxGapMs} ms${maxGapAt === null ? '' : ` @${maxGapAt}s`}`,
    passed: samples.length >= 2 && maxGapMs > 0 && maxGapMs <= gapLimitMs,
  });
  // 4. 事件推进
  pushCheck(checks, {
    id: 'longrun.events_progressing',
    description: '事件计数单调不减且确实增长（否则「内存平稳」是因为根本没在工作）',
    expected: '> 0 且单调不减',
    actual: `${totalEvents} events, monotonic=${monotonic}`,
    passed: totalEvents > 0 && monotonic,
  });
  // 5. 落库
  const persistedFinal = finalBody?.store?.events ?? null;
  pushCheck(checks, {
    id: 'longrun.events_persisted',
    description: '落库事件数不少于已接受事件数（防止「接收了但没写进去」）',
    expected: `store.events >= accepted (${acceptedTotal})`,
    actual: persistedFinal,
    passed: typeof persistedFinal === 'number' && persistedFinal >= acceptedTotal,
  });
  // 6. 达成速率（把 M9 的 H-4 变成判据：标称 100 实测 49.88 的时候没人发现）
  pushCheck(checks, {
    id: 'longrun.rate_matches_target',
    description: '实际达成速率不低于**声明目标**的 80%（声明目标起跑前写进计划，不读本次实测）',
    expected: `>= ${Number((targetRate * LIMITS.rateFloor).toFixed(3))} events/s（声明目标 ${targetRate}）`,
    actual: achievedRate,
    passed: achievedRate !== null && achievedRate >= targetRate * LIMITS.rateFloor,
  });
  // 6b. 标称 vs 实测的差距：M9 的 H-4 本身**没修**，所以这里把它当成可见的警告，
  // 而不是拿它把整轮判红——那样会把「夹具效率不足」和「长稳退化」混成同一个结论。
  pushCheck(checks, {
    id: 'longrun.rate_matches_nominal',
    description: '实际达成速率不低于标称（batch/tick）的 80% —— 单飞语义下这条通常为红，即 M9 的 H-4',
    expected: `>= ${Number((nominalRate * LIMITS.rateFloor).toFixed(3))} events/s（标称 ${nominalRate}）`,
    actual: achievedRate === null ? null : `${achievedRate}（效率 ${Number((achievedRate / nominalRate).toFixed(3))}）`,
    passed: achievedRate !== null && achievedRate >= nominalRate * LIMITS.rateFloor,
    severity: 'warn',
    note: '红不代表系统退化：调度器一次只跑一个 poll，有效间隔 = tick + 处理耗时。'
      + 'H-4 未修时这条应收红，见 M9-PERF-FINAL §15.3。',
  });
  // 7. poll 次数对得上声明目标 —— **「判据能失败」的主锚点**：
  // 把 mock 的 intervalMs 调大 5 倍，达成速率与 poll 次数同步掉到 ~20%，本项转红。
  const expectedPolls = targetRate > 0 && plan.batch_size > 0
    ? (activeMs / 1000) * (targetRate / plan.batch_size)
    : 0;
  const pollRatio = expectedPolls === 0 ? null : Number((actualPolls / expectedPolls).toFixed(4));
  pushCheck(checks, {
    id: 'longrun.polls_match_target',
    description: '实际 poll 次数不低于「活跃时长 × 声明目标速率 / 每批条数」的 80%（调度器悄悄罢工时这条会红）',
    expected: `>= ${Number((expectedPolls * LIMITS.pollFloor).toFixed(1))} polls（应有 ${Number(expectedPolls.toFixed(1))}）`,
    actual: `${actualPolls} polls (ratio=${pollRatio})`,
    passed: pollRatio !== null && pollRatio >= LIMITS.pollFloor,
  });
  // 8. poll 间隔漂移
  pushCheck(checks, {
    id: 'longrun.poll_interval_stable',
    description: '有效 poll 间隔的末段中位数不超过首段的 2 倍（间隔增长即消费追不上产出）',
    expected: `<= ${LIMITS.pollIntervalDrift}`,
    actual: intervalDrift,
    passed: intervalDrift !== null && intervalDrift <= LIMITS.pollIntervalDrift,
  });
  // 9. RSS 首末段
  pushCheck(checks, {
    id: 'longrun.rss_bounded',
    description: 'RSS 末段中位数相对首段不超过 +64 MiB 且不超过 1.25 倍（与 soak 同口径）',
    expected: `delta <= ${mib(LIMITS.rssDeltaBytes)} MiB 且 ratio <= ${LIMITS.rssRatio}`,
    actual: `delta=${mib(rssWindow.delta)} MiB ratio=${rssWindow.ratio}`,
    passed: rssWindow.delta !== null
      && rssWindow.delta <= LIMITS.rssDeltaBytes
      && (rssWindow.ratio === null || rssWindow.ratio <= LIMITS.rssRatio),
  });
  // 10. RSS 先涨后平
  pushCheck(checks, {
    id: 'longrun.rss_peak_bounded',
    description: '全序列 RSS 峰值不超过首个稳态点的 2 倍（抓「先涨后平」）',
    expected: `<= ${LIMITS.rssPeakRatio}`,
    actual: rssPeakRatio,
    passed: rssPeakRatio !== null && rssPeakRatio <= LIMITS.rssPeakRatio,
  });
  // 11. RSS 绝对上限
  pushCheck(checks, {
    id: 'longrun.rss_absolute_cap',
    description: '全序列 RSS 峰值不超过 512 MiB（防止幅度不大但基数已经很高）',
    expected: `<= ${mib(LIMITS.rssAbsoluteCapBytes)} MiB`,
    actual: `${mib(rssPeak)} MiB`,
    passed: rssPeak > 0 && rssPeak <= LIMITS.rssAbsoluteCapBytes,
  });
  // 12. RSS 斜率：R² 不可解释、或稳态时长不足 3 小时时，**既不判 pass 也不判 fail**，记未评估。
  // 「1 小时内的斜率」只是抖动的斜率：36 秒的开发跑里 R² 就能到 0.7 并外推出几百 MiB/h。
  const slopeMibPerHour = rssTrend === null ? null : mib(rssTrend.slope_per_minute * 60);
  const steadySpanHours = steady.length < 2
    ? 0
    : (steady[steady.length - 1].t_ms - steady[0].t_ms) / HOUR_MS;
  const slopeLongEnough = steadySpanHours >= LIMITS.slopeMinSpanHours;
  const slopeJudged = rssTrend !== null && rssTrend.r2 >= LIMITS.trendMinR2 && slopeLongEnough;
  pushCheck(checks, {
    id: 'longrun.rss_slope_per_hour',
    description: `RSS 趋势可解释（R²>=${LIMITS.trendMinR2} 且稳态 >=${LIMITS.slopeMinSpanHours}h）时，每小时增长不超过 ${LIMITS.slopeMaxMibPerHour} MiB`,
    expected: `<= ${LIMITS.slopeMaxMibPerHour} MiB/h`,
    actual: slopeMibPerHour,
    passed: slopeJudged && slopeMibPerHour <= LIMITS.slopeMaxMibPerHour,
    deferred: slopeJudged === false,
    note: slopeLongEnough === false
      ? `稳态时长 ${Number(steadySpanHours.toFixed(2))}h < ${LIMITS.slopeMinSpanHours}h：短窗口的斜率不参与判定`
      : (rssTrend === null
        ? '样本不足'
        : `R²=${rssTrend.r2} ${rssTrend.r2 >= LIMITS.trendMinR2 ? '，趋势可解释' : ` < ${LIMITS.trendMinR2}：斜率是噪声，不参与判定（沿用 soak 口径）`}`),
  });
  // 13. WAL
  pushCheck(checks, {
    id: 'longrun.wal_bounded',
    description: 'WAL 峰值不超过 autocheckpoint 上限的 3 倍（自动 checkpoint 生效）',
    expected: `<= ${mib(walCeiling)} MiB 且 > 0`,
    actual: `${mib(walPeak)} MiB`,
    passed: walPeak > 0 && walPeak <= walCeiling,
  });
  // 14. API 延迟（常量阈值 + p90；期望值不读本次实测派生）
  pushCheck(checks, {
    id: 'longrun.api_latency_stable',
    description: `末段 status p90 不超过 ${LIMITS.apiP90AbsMs} ms，且不超过首段 p90 的 ${LIMITS.apiP90Ratio} 倍（统计量用 p90）`,
    expected: `<= ${LIMITS.apiP90AbsMs} ms 且 <= ${LIMITS.apiP90Ratio}x 首段`,
    actual: `${apiLast.p90} ms（首段 ${apiFirst.p90} ms）`,
    passed: apiLast.p90 !== null
      && apiLast.p90 <= LIMITS.apiP90AbsMs
      && apiFirst.p90 !== null
      && apiLast.p90 <= apiFirst.p90 * LIMITS.apiP90Ratio,
  });
  // 15/16/17. 三项基线漂移
  const driftEnabled = enoughHours;
  const rssDrift = axisDrift(hourRows, 'rss_mib');
  pushCheck(checks, {
    id: 'longrun.memory_baseline_drift',
    description: '逐小时 RSS 基线：末小时不超过首小时 +64 MiB 且不超过 1.25 倍',
    expected: `delta <= ${mib(LIMITS.baselineRssDeltaBytes)} MiB 且 ratio <= ${LIMITS.baselineRssRatio}`,
    actual: rssDrift === null
      ? `小时基线 ${hourRows.length} 个`
      : `h${rssDrift.hour_first}->h${rssDrift.hour_last} delta=${Number(mib(rssDrift.delta).toFixed(2))} MiB ratio=${rssDrift.ratio}`,
    passed: driftEnabled && rssDrift !== null
      && rssDrift.delta <= mib(LIMITS.baselineRssDeltaBytes)
      && rssDrift.ratio <= LIMITS.baselineRssRatio,
    deferred: driftEnabled === false || rssDrift === null,
    note: driftEnabled
      ? `基线取自 ${hourRows.length} 个小时的 RSS 中位数（首小时已剔预热）`
      : `小时基线 ${hourRows.length} 个 < ${LIMITS.minHourBaselines}，漂移不可判；不判 pass`,
  });

  const handleDrift = axisDrift(hourRows, 'handles');
  pushCheck(checks, {
    id: 'longrun.handle_baseline_drift',
    description: '逐小时 libuv 句柄基线：末小时不超过首小时 +64 个且不超过 1.5 倍',
    expected: `delta <= ${LIMITS.baselineHandleDelta} 且 ratio <= ${LIMITS.baselineHandleRatio}`,
    actual: handleDrift === null
      ? '无句柄基线'
      : `h${handleDrift.hour_first}->h${handleDrift.hour_last} ${handleDrift.first}->${handleDrift.last} delta=${handleDrift.delta} ratio=${handleDrift.ratio}`,
    passed: driftEnabled && handleDrift !== null
      && handleDrift.delta <= LIMITS.baselineHandleDelta
      && handleDrift.ratio <= LIMITS.baselineHandleRatio,
    deferred: driftEnabled === false || handleDrift === null,
    note: '句柄数取自 process.report(...).libuv.length，每小时关闭分片时采一次',
  });

  const threadDrift = axisDrift(hourRows, 'threads');
  pushCheck(checks, {
    id: 'longrun.thread_baseline_drift',
    description: '逐小时 OS 线程数基线：末小时不超过首小时 +8 且不超过 1.5 倍',
    expected: `delta <= ${LIMITS.baselineThreadDelta} 且 ratio <= ${LIMITS.baselineThreadRatio}`,
    actual: threadDrift === null
      ? '未测量'
      : `h${threadDrift.hour_first}->h${threadDrift.hour_last} ${threadDrift.first}->${threadDrift.last} delta=${threadDrift.delta} ratio=${threadDrift.ratio}`,
    passed: driftEnabled && threadDrift !== null
      && threadDrift.delta <= LIMITS.baselineThreadDelta
      && threadDrift.ratio <= LIMITS.baselineThreadRatio,
    deferred: driftEnabled === false || threadDrift === null,
    note: osProbe === null || osProbe.count === 0
      ? 'win32 纯 Node 读不到 OS 线程总数；外部采样缺失 ⇒ 该轴未测量，不判 pass'
      : `OS 线程取自外部采样 ${osProbe.count} 条（${osProbe.source}）`,
  });

  // 18. 冻结副本字节不变
  pushCheck(checks, {
    id: 'longrun.freeze_bytes_unchanged',
    description: '被冻结的那份字节在运行期内未改变（不是「仓库静止」——活仓库本来就有别的写者）',
    expected: freeze === null
      ? '未提供 --freeze-manifest'
      : `${freeze.file_count} 个文件 / code_digest ${String(freeze.code_digest).slice(0, 16)}`,
    actual: freezeNow === null
      ? '无法复核'
      : `changed=${freezeNow.changed_files.length} code_digest=${String(freezeNow.code_digest).slice(0, 16)}`,
    passed: freezeNow !== null
      && freezeNow.changed_files.length === 0
      && freezeNow.code_digest === freeze.code_digest,
    deferred: freeze === null,
    note: freeze === null ? '没有冻结清单就无法声明「跑的是哪份字节」；本项记未评估' : `冻结根：${freeze.root}`,
  });
  // 19. 冻结清单在运行期内没被改（清单被改，上面的比较就失去依据）
  pushCheck(checks, {
    id: 'longrun.freeze_manifest_intact',
    description: '冻结清单文件自身的 sha256 在运行期内未变（防止「改清单以迎合源码」）',
    expected: freeze === null ? '未提供' : String(freeze.manifest_sha256).slice(0, 16),
    actual: freezeNow === null ? '无法复核' : String(freezeNow.manifest_sha256).slice(0, 16),
    passed: freezeNow !== null && freezeNow.manifest_sha256 === freeze.manifest_sha256,
    deferred: freeze === null,
  });
  // 20. daemon 还活着
  pushCheck(checks, {
    id: 'longrun.daemon_still_running',
    description: '结束时 daemon 仍在 running 且健康状态不是 failed',
    expected: 'running / not failed',
    actual: `${finalBody?.lifecycle} / ${finalBody?.health?.status}`,
    passed: finalBody?.lifecycle === 'running' && finalBody?.health?.status !== 'failed',
  });
  // 21. 磁盘余量（72h 写库；写满盘会让下一次续跑直接失败）
  pushCheck(checks, {
    id: 'longrun.disk_headroom',
    description: `运行目录所在卷剩余空间不低于 ${mib(LIMITS.diskFloorBytes)} MiB`,
    expected: `>= ${mib(LIMITS.diskFloorBytes)} MiB`,
    actual: `${mib(diskFreeBytes)} MiB`,
    passed: typeof diskFreeBytes === 'number' && diskFreeBytes >= LIMITS.diskFloorBytes,
  });
  // 22–25. 观察项（warn，不改变退出码）
  pushCheck(checks, {
    id: 'longrun.dropped_events_zero',
    description: '批次截断为 0（每批远小于 maxBatchEvents，截断即代表背压）',
    expected: '= 0',
    actual: droppedTotal,
    passed: droppedTotal === 0,
    severity: 'warn',
  });
  pushCheck(checks, {
    id: 'longrun.source_failures_zero',
    description: '来源失败次数为 0',
    expected: '= 0',
    actual: sourceFailures,
    passed: sourceFailures === 0,
    severity: 'warn',
  });
  pushCheck(checks, {
    id: 'longrun.restart_count',
    description: '全程重启次数为 0（重启会让段内连续性出现真实空档）',
    expected: '= 0',
    actual: Math.max(0, segments.length - 1),
    passed: segments.length <= 1,
    severity: 'warn',
  });
  pushCheck(checks, {
    id: 'longrun.shard_integrity',
    description: '分片里没有无法解析的半行（崩溃时 append 未完成的残留）',
    expected: '= 0',
    actual: badLines,
    passed: badLines === 0,
    severity: 'warn',
  });

  const evaluated = checks.filter((item) => item.deferred !== true);
  const { failures, warnings } = evaluateChecks(evaluated);
  const deferred = checks.filter((item) => item.deferred === true).map((item) => item.id);

  for (const item of checks) {
    if (item.passed === false && item.deferred !== true) {
      findings.push({
        id: `LR-${findings.length + 1}`,
        severity: item.severity === 'warn' ? 'P2' : 'P1',
        title: item.description,
        detail: `期望 ${JSON.stringify(item.expected)}，实测 ${JSON.stringify(item.actual)}。`,
        source_check: item.id,
      });
    }
  }

  const metrics = [
    { name: '计划时长', value: plan.hours, unit: 'h' },
    { name: '实际时长', value: elapsedS, unit: 's' },
    { name: '采样点数', value: samples.length, unit: 'point' },
    { name: '采样周期', value: plan.sample_ms, unit: 'ms' },
    { name: '小时分片', value: `${closedShards}/${expectedShards}`, unit: '' },
    { name: '累计事件（跨段累加）', value: totalEvents, unit: 'event', note: `已接受 ${acceptedTotal}` },
    { name: '累计告警', value: alertTotal, unit: 'alert' },
    { name: '实际达成速率', value: achievedRate, unit: 'events/s', note: `标称 ${nominalRate} / 声明目标 ${targetRate}` },
    { name: '实际 poll 次数', value: actualPolls, unit: 'poll', note: `按声明目标应有 ${Number(expectedPolls.toFixed(0))}` },
    { name: '有效 poll 间隔 p50', value: pollSummary.p50, unit: 'ms', note: `tick ${plan.tick_ms}ms + 处理耗时` },
    { name: 'poll 间隔漂移（末/首）', value: intervalDrift, unit: '倍' },
    { name: 'RSS 首段中位数（剔预热）', value: mib(rssWindow.first_median), unit: 'MiB', note: `剔除前 ${warmupSamples} 点` },
    { name: 'RSS 末段中位数（剔预热）', value: mib(rssWindow.last_median), unit: 'MiB' },
    { name: 'RSS 峰值（稳态段）', value: mib(rssPeak), unit: 'MiB', note: `峰值/首稳态 = ${rssPeakRatio}` },
    { name: 'RSS 斜率', value: slopeJudged ? slopeMibPerHour : null, unit: 'MiB/h', note: rssTrend === null ? '样本不足' : `R²=${rssTrend.r2}` },
    { name: 'WAL 峰值', value: mib(walPeak), unit: 'MiB', note: `上限 ${mib(walCeiling)} MiB` },
    { name: '探针 p90（首段/末段）', value: `${apiFirst.p90} / ${apiLast.p90}`, unit: 'ms' },
    { name: '重启次数', value: Math.max(0, segments.length - 1), unit: 'segment' },
    { name: '最大采样间隔', value: maxGapMs, unit: 'ms' },
    { name: '探针重试 / 失败', value: `${input.probeRetries ?? 0} / ${input.probeFailures ?? 0}`, unit: 'req', note: '传输层重试，非服务端失败；重试计数不许静默' },
    { name: '磁盘余量', value: mib(diskFreeBytes), unit: 'MiB' },
  ];

  return {
    checks,
    metrics,
    hourRows,
    findings,
    deferred,
    failures,
    warnings,
    verdict: failures.length === 0 ? 'pass' : 'fail',
  };
}

/**
 * 判据 → Markdown 表格行。
 *
 * @param {object} item 检查项。
 * @returns {string} 行。
 */
function checkRow(item) {
  const state = item.deferred === true ? '未评估' : (item.passed ? 'PASS' : 'FAIL');
  const fmt = (value) => {
    if (value === null || value === undefined) {
      return '—';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };
  return `| \`${item.id}\` | ${item.description} | ${fmt(item.expected)} | ${fmt(item.actual)} | **${state}** | ${item.severity} |`;
}

/**
 * 渲染报告（Markdown 是可读投影，数字全部来自同一份内存结果，不手写）。
 *
 * @param {object} result 结果。
 * @returns {string} Markdown。
 */
export function renderReport(result) {
  const out = [];
  const fmt = (value) => (value === null || value === undefined ? '—' : String(value));
  out.push('# G6 长稳（72h）阶段报告');
  out.push('');
  out.push('- task_id: `SOAK-72H`');
  out.push(`- run_id: \`${result.run_id}\``);
  out.push(`- 结论: **${result.verdict.toUpperCase()}**`);
  out.push(`- 开始: ${result.plan.started_at_iso}　结束: ${result.ended_at_iso}`);
  out.push(`- 计划: ${result.plan.hours} h；采样 ${result.plan.sample_ms} ms；tick ${result.plan.tick_ms} ms；每批 ${result.plan.batch_size} 条`);
  out.push(`- 结果结构: \`${result.schema}\``);
  out.push('');

  out.push('## 被冻结的是哪份字节');
  out.push('');
  if (result.freeze === null) {
    out.push('**未提供冻结清单**。本报告因此**不能**声明「跑的是哪份字节」，'
      + '`longrun.freeze_bytes_unchanged` 记未评估。');
  } else {
    out.push('| 项 | 值 |');
    out.push('|---|---|');
    out.push(`| 冻结根（副本） | \`${result.freeze.root}\` |`);
    out.push(`| 冻结时间 | ${result.freeze.created_at} |`);
    out.push(`| 文件数 / 字节 | ${result.freeze.file_count} / ${result.freeze.total_bytes} |`);
    out.push(`| 清单文件 sha256 | \`${result.freeze.manifest_sha256}\` |`);
    out.push(`| 源码摘要 codeDigest | \`${result.freeze.code_digest}\`（${result.freeze.code_files} 文件 / ${result.freeze.code_bytes} 字节）|`);
    out.push(`| 运行期变化文件数 | ${result.freezeNow === null ? '—' : result.freezeNow.changed_files.length} |`);
    out.push('');
    out.push('> 判据比较的是**这份副本的字节**，不是「活仓库是否静止」。'
      + '活仓库里其他会话继续写文件不影响本结论；副本被改才会红。');
    if (result.freezeNow !== null && result.freezeNow.changed_files.length > 0) {
      out.push('');
      out.push('变化的文件（最多 20 个）：');
      out.push('');
      for (const relative of result.freezeNow.changed_files.slice(0, 20)) {
        out.push(`- \`${relative}\``);
      }
    }
  }
  out.push('');

  out.push('## 环境');
  out.push('');
  out.push('| 项 | 值 |');
  out.push('|---|---|');
  out.push(`| OS | ${fmt(result.env.platform.os)} ${fmt(result.env.platform.release)} (${fmt(result.env.platform.arch)}) |`);
  out.push(`| CPU | ${fmt(result.env.cpu.model)} / ${fmt(result.env.cpu.logical_cores)} 逻辑核 |`);
  out.push(`| 内存 | ${(result.env.memory.total_bytes / 1024 ** 3).toFixed(2)} GiB |`);
  out.push(`| Node | ${fmt(result.env.node.version)} |`);
  out.push(`| SQLite | ${fmt(result.env.sqlite_version)} |`);
  out.push(`| 端口 | ${fmt(result.port)}（0 = 临时端口，绑到即记录） |`);
  out.push(`| 运行目录 | \`${result.runDir}\` |`);
  out.push('');

  out.push('## 指标');
  out.push('');
  out.push('| 指标 | 值 | 单位 | 说明 |');
  out.push('|---|---|---|---|');
  for (const metric of result.metrics) {
    const value = metric.value === null || metric.value === undefined ? '—' : String(metric.value);
    out.push(`| ${metric.name} | ${value} | ${metric.unit ?? ''} | ${metric.note ?? ''} |`);
  }
  out.push('');

  out.push('## 逐小时基线（三项漂移的原始数据）');
  out.push('');
  out.push('| 小时 | 采样点 | 分片关闭 | RSS 中位 (MiB) | libuv 句柄 | 活动资源 | OS 线程 | 累计事件 | 探针 p90 (ms) |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of result.hourRows) {
    out.push(`| ${row.hour} | ${row.samples} | ${row.closed ? 'yes' : 'no'} | ${fmt(row.rss_mib)} | ${fmt(row.handles)} `
      + `| ${fmt(row.active_resources)} | ${fmt(row.threads)} | ${fmt(row.events)} | ${fmt(row.api_p90_ms)} |`);
  }
  out.push('');
  out.push(`> OS 线程列：${result.osProbe === null || result.osProbe.count === 0
    ? '**未测量**（win32 纯 Node 读不到线程总数，外部采样缺失）'
    : `来自外部采样 ${result.osProbe.count} 条（${result.osProbe.source}）`}。`);
  out.push('');

  out.push('## 判据逐项');
  out.push('');
  out.push('| id | 说明 | 期望 | 实测 | 结果 | 级别 |');
  out.push('|---|---|---|---|---|---|');
  for (const item of result.checks) {
    out.push(checkRow(item));
  }
  out.push('');
  if (result.failures.length > 0) {
    out.push(`失败项：${result.failures.map((id) => `\`${id}\``).join('、')}`);
    out.push('');
  }
  if (result.warnings.length > 0) {
    out.push(`警告项：${result.warnings.map((id) => `\`${id}\``).join('、')}`);
    out.push('');
  }
  if (result.deferred.length > 0) {
    out.push(`未测量（数据不足，**不判 pass**）：${result.deferred.map((id) => `\`${id}\``).join('、')}`);
    out.push('');
  }

  if (result.findings.length > 0) {
    out.push('## 发现（只报告，不改生产代码）');
    out.push('');
    out.push('| id | 级别 | 说明 | 来源检查 |');
    out.push('|---|---|---|---|');
    for (const finding of result.findings) {
      out.push(`| ${finding.id} | ${finding.severity} | ${finding.title} | \`${finding.source_check}\` |`);
    }
    out.push('');
  }

  out.push('## 已知限制');
  out.push('');
  for (const limitation of result.limitations) {
    out.push(`- ${limitation}`);
  }
  out.push('');
  out.push('## 复现');
  out.push('');
  out.push('```bash');
  out.push(result.reproduce);
  out.push('```');
  out.push('');
  out.push('---');
  out.push('');
  out.push('作者：PT-dove');
  out.push('');
  return out.join('\n');
}

/**
 * sha256 十六进制摘要。
 *
 * @param {Buffer|string} content 内容。
 * @returns {string} 摘要。
 */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 复核冻结清单：逐个文件重算 sha256。
 *
 * @param {object} manifest 冻结清单（`files` 为 相对路径 → sha256）。
 * @returns {{changed_files: string[], missing: number, code_digest: string,
 *   code_files: number, code_bytes: number, manifest_sha256: string}} 复核结果。
 */
export function verifyFreeze(manifest) {
  const changed = [];
  let missing = 0;
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const absolute = path.join(manifest.root, relative);
    let content;
    try {
      content = fs.readFileSync(absolute);
    } catch {
      missing += 1;
      changed.push(relative);
      continue;
    }
    if (sha256(content) !== expected) {
      changed.push(relative);
    }
  }
  let manifestSha = null;
  try {
    manifestSha = sha256(fs.readFileSync(manifest.manifest_path));
  } catch {
    manifestSha = null;
  }
  const code = codeDigest(manifest.root);
  return {
    changed_files: changed,
    missing,
    code_digest: code.digest,
    code_files: code.files,
    code_bytes: code.bytes,
    manifest_sha256: manifestSha,
  };
}

/**
 * 磁盘剩余字节。
 *
 * @param {string} target 路径。
 * @returns {number|null} 字节。
 */
export function freeBytesOf(target) {
  try {
    const stats = fs.statfsSync(target);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * 等待若干毫秒。
 *
 * @param {number} ms 毫秒。
 * @returns {Promise<void>} 完成。
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * 主流程。
 *
 * @returns {Promise<number>} 退出码（只有 0/1）。
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`longrun: ${error.message}\n`);
    return 1;
  }

  let runDir;
  try {
    runDir = assertRunPath(options.runDir, '--run-dir');
  } catch (error) {
    process.stderr.write(`longrun: ${error.message}\n`);
    return 1;
  }

  const dataDir = path.join(runDir, 'data');
  const stateDir = path.join(runDir, 'state');
  const logDir = path.join(runDir, 'logs');
  const reportDir = path.join(runDir, 'report');
  const statePath = path.join(stateDir, 'state.json');

  try {
    for (const dir of [runDir, dataDir, stateDir, logDir, reportDir]) {
      fs.mkdirSync(dir, { recursive: true });
      assertRunPath(dir, 'run subdir');
    }
  } catch (error) {
    process.stderr.write(`longrun: ${error.message}\n`);
    return 1;
  }

  let state;
  try {
    state = readJsonIfPresent(statePath);
  } catch (error) {
    process.stderr.write(`longrun: state file is unreadable (${error.message}); refusing to guess\n`);
    return 1;
  }

  if (state !== null && options.resume === false) {
    process.stderr.write('longrun: run dir already holds a state file; pass --resume to continue it, '
      + 'or pick a different --run-dir (refusing to overwrite evidence)\n');
    return 1;
  }

  // 冻结清单：起跑前读一次，整个运行期内不重读文件内容做比较，只复核哈希。
  let manifest = null;
  try {
    if (options.freezeManifest !== null) {
      manifest = JSON.parse(fs.readFileSync(options.freezeManifest, 'utf8'));
      manifest.manifest_path = path.resolve(options.freezeManifest);
      if (typeof manifest.root !== 'string' || typeof manifest.files !== 'object') {
        throw new Error('FREEZE.json lacks root/files');
      }
      if (path.resolve(manifest.root).toLowerCase() !== path.resolve(REPO_ROOT).toLowerCase()) {
        throw new Error(`FREEZE.json root (${manifest.root}) is not the repository this runner is loaded from `
          + `(${REPO_ROOT}); refusing to certify the wrong bytes`);
      }
    }
  } catch (error) {
    process.stderr.write(`longrun: freeze manifest: ${error.message}\n`);
    return 1;
  }

  const startedAtMs = state === null ? Date.now() : state.plan.started_at_ms;

  if (state === null) {
    let freeze = null;
    if (manifest !== null) {
      const verified = verifyFreeze(manifest);
      if (verified.changed_files.length > 0) {
        process.stderr.write(`longrun: freeze manifest does not match the copy on disk `
          + `(${verified.changed_files.length} files differ, e.g. ${verified.changed_files.slice(0, 3).join(', ')}); `
          + 're-freeze before starting\n');
        return 1;
      }
      freeze = {
        root: path.resolve(manifest.root),
        manifest_path: manifest.manifest_path,
        manifest_sha256: verified.manifest_sha256,
        created_at: manifest.created_at ?? null,
        file_count: manifest.file_count ?? Object.keys(manifest.files).length,
        total_bytes: manifest.total_bytes ?? null,
        code_digest: verified.code_digest,
        code_files: verified.code_files,
        code_bytes: verified.code_bytes,
      };
    }
    state = {
      schema: RUN_SCHEMA,
      run_id: `soak72-${new Date(startedAtMs).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '')}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: 'running',
      plan: {
        hours: options.hours,
        sample_ms: options.sampleMs,
        tick_ms: options.tickMs,
        batch_size: options.batchSize,
        seed: options.seed,
        port_requested: options.port,
        started_at_ms: startedAtMs,
        started_at_iso: new Date(startedAtMs).toISOString(),
        end_at_ms: startedAtMs + options.hours * HOUR_MS,
        // 标称（batch/tick）是夹具的「档位」，不是可达值：单飞调度器的有效间隔
        // 是 tick + 处理耗时。两个数都写进计划，报告里逐项对照，不混用。
        nominal_ev_per_sec: Number(((options.batchSize / options.tickMs) * 1000).toFixed(3)),
        target_ev_per_sec: Number((
          options.targetEvPerSec
          ?? ((options.batchSize / options.tickMs) * 1000 * LIMITS.efficiencyConstant)
        ).toFixed(3)),
      },
      freeze,
      segments: [],
      hours_closed: [],
      totals: {
        events_received: 0, events_accepted: 0, events_duplicate: 0,
        alerts_written: 0, findings_written: 0, polls: 0,
      },
      /** 计数器回退时累计的偏移；正常情况下恒为 0。 */
      counter_offset: Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])),
      /** 上一次读到的原始计数器，用来发现「回退」。 */
      last_raw_counters: Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])),
      next_event_index: 1,
      sample_index: 0,
      args: process.argv.slice(2),
    };
    writeJsonAtomic(statePath, state);
    process.stdout.write(`longrun: new run ${state.run_id} in ${runDir}\n`);
    if (freeze !== null) {
      process.stdout.write(`longrun: frozen bytes ${freeze.code_digest.slice(0, 16)} `
        + `(${freeze.code_files} files / ${freeze.code_bytes} B) from ${freeze.root}\n`);
    }
  } else {
    if (state.schema !== RUN_SCHEMA) {
      process.stderr.write(`longrun: state schema ${state.schema} != ${RUN_SCHEMA}\n`);
      return 1;
    }
    if (state.plan.hours !== options.hours || state.plan.sample_ms !== options.sampleMs
      || state.plan.tick_ms !== options.tickMs || state.plan.batch_size !== options.batchSize
      || (options.targetEvPerSec !== null && state.plan.target_ev_per_sec !== Number(options.targetEvPerSec.toFixed(3)))) {
      process.stderr.write('longrun: --resume must repeat the original plan '
        + `(hours=${state.plan.hours}, sample-ms=${state.plan.sample_ms}, tick-ms=${state.plan.tick_ms}, `
        + `batch-size=${state.plan.batch_size}, target=${state.plan.target_ev_per_sec}); got hours=${options.hours}, `
        + `sample-ms=${options.sampleMs}, tick-ms=${options.tickMs}, batch-size=${options.batchSize}, `
        + `target=${options.targetEvPerSec}\n`);
      return 1;
    }
    process.stdout.write(`longrun: resuming ${state.run_id} (${state.segments.length} 段, `
      + `${state.sample_index} 采样, ${state.hours_closed.length} 个已关闭分片)\n`);
  }

  const plan = state.plan;
  const deadline = plan.end_at_ms;
  const segmentIndex = state.segments.length;
  const segment = {
    index: segmentIndex,
    pid: process.pid,
    started_at: new Date().toISOString(),
    started_at_ms: Date.now(),
    ended_at: null,
    ended_at_ms: null,
    active_ms: 0,
    samples: 0,
    reason: null,
    counter_base: { ...state.totals },
    counter_final: { ...state.totals },
  };
  state.segments.push(segment);
  state.status = 'running';
  writeJsonAtomic(statePath, state);

  const token = `soak-token-${plan.seed}-0123456789abcdef`;
  const headers = { authorization: `Bearer ${token}` };
  const workload = createWorkload({ seed: plan.seed, label: 'soak' });
  const { pack } = makeBenchRulePack({ seed: plan.seed });

  const storePath = path.join(dataDir, 'aegis-soak.db');
  const config = loadConfig({
    dataDir,
    mode: 'mock',
    detection: { rulePack: pack },
    api: { port: options.port, token },
    scheduler: {
      tickMs: plan.tick_ms,
      // 批上限远大于每批产出：一旦截断就是真实的背压信号。
      maxBatchEvents: 500,
      staleAfterMs: 30_000,
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
    batchSize: plan.batch_size,
    intervalMs: plan.tick_ms,
    startIndex: state.next_event_index,
  });
  const daemon = createDaemon({ config, store, sources: [source] });

  const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 500, maxSockets: 4, timeout: 1000 });
  const probeCounter = { retries: 0 };
  let aborted = false;
  const onSignal = (signal) => {
    aborted = true;
    process.stdout.write(`longrun: ${signal} received; closing the current hour and writing a report\n`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // 关掉终端/父进程退出时是 SIGHUP；不接它就会静默死掉，什么证据都不留。
  process.on('SIGHUP', onSignal);

  const origin = plan.started_at_ms;
  const bucket = [];
  let hour = Math.floor((Date.now() - origin) / HOUR_MS);
  let port = null;
  let fatal = null;
  let finalBody = null;

  /**
   * 关闭一个小时分片：写汇总行、记状态。
   *
   * @param {number} hourIndex 小时序号。
   * @param {string} reason 关闭原因（`boundary` / `stop`）。
   * @returns {void}
   */
  const closeHour = (hourIndex, reason) => {
    if (state.hours_closed.includes(hourIndex) || bucket.length === 0) {
      return;
    }
    let libuvHandles = null;
    let workerThreads = null;
    try {
      // 每小时一次，单次约 98 ms；绝不放采样热路径。
      const report = process.report.getReport();
      libuvHandles = Array.isArray(report.libuv) ? report.libuv.length : null;
      workerThreads = Array.isArray(report.workers) ? report.workers.length : null;
    } catch {
      libuvHandles = null;
      workerThreads = null;
    }
    let freezeChanged = null;
    if (manifest !== null) {
      try {
        freezeChanged = verifyFreeze(manifest).changed_files.length;
      } catch {
        freezeChanged = null;
      }
    }
    const baseline = hourBaseline(bucket, 0);
    const last = bucket[bucket.length - 1];
    appendLine(shardPath(logDir, hourIndex), {
      k: KIND_HOUR,
      hour: hourIndex,
      closed_at: new Date().toISOString(),
      reason,
      samples: bucket.length,
      rss_bytes_median: baseline === null ? null : baseline.rss,
      active_resources_median: baseline === null ? null : baseline.active,
      libuv_handles: libuvHandles,
      worker_threads: workerThreads,
      freeze_changed: freezeChanged,
      adj_polls: last.adj_polls,
      adj_events_received: last.adj_events_received,
      store_events: last.store_events,
    });
    state.hours_closed.push(hourIndex);
    writeJsonAtomic(statePath, state);
    process.stdout.write(`longrun: hour ${hourIndex} closed (${bucket.length} samples, ${reason}, `
      + `handles=${libuvHandles}, rss=${baseline === null ? '—' : mib(baseline.rss)} MiB)\n`);
    bucket.length = 0;
  };

  try {
    const started = await daemon.start();
    port = started.address === null ? null : started.address.port;
    if (port === null) {
      throw new Error('daemon did not bind a control API port');
    }
    state.port = port;
    state.status = 'running';
    writeJsonAtomic(statePath, state);
    process.stdout.write(`longrun: listening on 127.0.0.1:${port}; ${plan.hours}h @ ${plan.sample_ms}ms `
      + `samples; tick ${plan.tick_ms}ms × ${plan.batch_size} events; deadline ${new Date(deadline).toISOString()}\n`);

    while (aborted === false && Date.now() < deadline) {
      const now = Date.now();
      const response = await probe(agent, port, headers, probeCounter);
      if (response.status !== 200 || response.body === null) {
        throw new Error(`status probe failed: HTTP ${response.status}`);
      }
      const body = response.body;
      const counters = body.counters ?? {};
      // 自适应跨段累加：只在计数器**回退**（= 真的被重启清零）时补偏移。
      // 正常重启时 daemon 会把计数器接着上次报，此时偏移保持 0，不会重复计数。
      if (state.counter_offset === undefined) {
        state.counter_offset = Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]));
      }
      if (state.last_raw_counters === undefined) {
        state.last_raw_counters = Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]));
      }
      const adjusted = {};
      for (const key of COUNTER_KEYS) {
        const raw = Number(counters[key] ?? 0);
        const last = Number(state.last_raw_counters[key] ?? 0);
        if (raw < last) {
          state.counter_offset[key] = Number(state.counter_offset[key] ?? 0) + last;
          process.stdout.write(`longrun: counter ${key} went backwards (${last} -> ${raw}); `
            + `offset is now ${state.counter_offset[key]} (daemon restarted with a fresh counter)\n`);
        }
        state.last_raw_counters[key] = raw;
        adjusted[key] = Number(state.counter_offset[key] ?? 0) + raw;
      }
      const sampleHour = Math.floor((now - origin) / HOUR_MS);
      const sample = {
        k: KIND_SAMPLE,
        i: state.sample_index,
        seg: segmentIndex,
        hour: sampleHour,
        t_ms: now - origin,
        elapsed_s: Number(((now - origin) / 1000).toFixed(2)),
        t_wall: new Date(now).toISOString(),
        rss_bytes: process.memoryUsage().rss,
        heap_used_bytes: process.memoryUsage().heapUsed,
        external_bytes: process.memoryUsage().external,
        array_buffers_bytes: process.memoryUsage().arrayBuffers,
        wal_bytes: fileBytes(`${storePath}-wal`),
        db_bytes: fileBytes(storePath),
        // 原始计数（daemon 报什么就是什么）与跨段累加值都留：排障靠前者，判据靠后者。
        events_received: counters.events_received ?? null,
        events_accepted: counters.events_accepted ?? null,
        events_duplicate: counters.events_duplicate ?? null,
        alerts_written: counters.alerts_written ?? null,
        findings_written: counters.findings_written ?? null,
        polls: counters.polls ?? null,
        source_failures: counters.source_failures ?? null,
        adj_events_received: adjusted.events_received,
        adj_events_accepted: adjusted.events_accepted,
        adj_alerts_written: adjusted.alerts_written,
        adj_polls: adjusted.polls,
        dropped_events: body.scheduler?.sources?.[0]?.dropped_events ?? null,
        source_lifecycle: body.scheduler?.sources?.[0]?.lifecycle ?? null,
        store_events: body.store?.events ?? null,
        store_db_bytes: body.store?.database_bytes ?? null,
        store_open: body.store?.open ?? null,
        health_status: body.health?.status ?? null,
        lifecycle: body.lifecycle ?? null,
        probe_latency_ms: response.latency_ms,
        // libuv 句柄每小时才采一次（见 closeHour）；这里只放便宜的活动资源数。
        active_resources: process.getActiveResourcesInfo().length,
        os_threads: null,
      };
      appendLine(shardPath(logDir, sampleHour), sample);
      bucket.push(sample);

      state.sample_index += 1;
      state.totals = {
        events_received: adjusted.events_received,
        events_accepted: adjusted.events_accepted,
        events_duplicate: adjusted.events_duplicate,
        alerts_written: adjusted.alerts_written,
        findings_written: adjusted.findings_written,
        polls: adjusted.polls,
      };
      state.next_event_index = source.cursor();
      segment.samples += 1;
      segment.counter_final = { ...state.totals };
      segment.active_ms = Date.now() - segment.started_at_ms;
      state.updated_at = new Date().toISOString();
      writeJsonAtomic(statePath, state);

      process.stdout.write(`longrun: h${sampleHour} t=+${(sample.elapsed_s / 3600).toFixed(2)}h `
        + `rss=${mib(sample.rss_bytes)}MiB handles?=${sample.active_resources} `
        + `events=${sample.adj_events_received} polls=${sample.adj_polls} `
        + `probe=${sample.probe_latency_ms}ms health=${sample.health_status}\n`);

      if (sampleHour !== hour) {
        closeHour(hour, 'boundary');
        hour = sampleHour;
      }
      await sleep(Math.min(plan.sample_ms, Math.max(0, deadline - Date.now())));
    }

    closeHour(hour, aborted ? 'stop-signal' : 'boundary');

    // 收尾：等一次完整 tick 让最后一批落库，再取终态。
    await sleep(Math.min(plan.tick_ms * 2, 2000));
    const finalStatus = await probe(agent, port, headers, probeCounter);
    finalBody = finalStatus.body;
  } catch (error) {
    fatal = error;
    process.stderr.write(`longrun: fatal: ${error && error.stack ? error.stack : String(error)}\n`);
    try {
      closeHour(hour, 'fatal');
    } catch {
      // 收尾失败不能掩盖真正的失败原因。
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    agent.destroy();
    try {
      await daemon.stop('longrun-done');
    } catch {
      // 停不下来不改变结论：结论来自已落盘的分片。
    }
    segment.ended_at = new Date().toISOString();
    segment.ended_at_ms = Date.now();
    segment.active_ms = segment.ended_at_ms - segment.started_at_ms;
    segment.reason = fatal !== null ? 'fatal' : (aborted ? 'signal' : 'completed');
    state.segments[state.segments.length - 1] = segment;
    state.updated_at = new Date().toISOString();
    state.status = fatal !== null ? 'fatal' : (aborted ? 'aborted' : 'completed');
    try {
      writeJsonAtomic(statePath, state);
    } catch {
      // 状态写不下去时，分片仍然是证据。
    }
  }

  // ---- 分析：永远从磁盘分片重算，续跑后的报告因此覆盖全程 ----
  let report;
  try {
    const shards = readShards(logDir);
    const freezeNow = manifest === null ? null : verifyFreeze(manifest);
    const storePragmas = readStorePragmas(storePath);
    const osProbe = readExternalOsSamples(options.osSamples, plan.started_at_ms);
    const analysis = analyze({
      samples: shards.samples,
      hours: shards.hours,
      segments: state.segments,
      plan,
      freeze: state.freeze,
      freezeNow,
      finalBody,
      storePragmas,
      diskFreeBytes: freeBytesOf(runDir),
      badLines: shards.badLines,
      osProbe,
      probeRetries: probeCounter.retries ?? 0,
      probeFailures: probeCounter.failures ?? 0,
      endedAtMs: Date.now(),
    });
    const env = captureEnv({ tempRoot: runDir });
    const endedAtIso = new Date().toISOString();
    report = {
      schema: RUN_SCHEMA,
      kind: 'longrun',
      task_id: 'SOAK-72H',
      author: 'PT-dove',
      run_id: state.run_id,
      generated_at: endedAtIso,
      runDir,
      port,
      env,
      plan,
      freeze: state.freeze,
      freezeNow,
      osProbe,
      segments: state.segments,
      ended_at_iso: endedAtIso,
      aborted: aborted || fatal !== null,
      fatal: fatal === null ? null : String(fatal.message ?? fatal),
      ...analysis,
      limitations: [
        '单机单进程、loopback 单客户端；不覆盖多客户端并发与网络抖动。',
        '未强制 GC（非 --expose-gc），RSS 锯齿受 V8 GC 时机影响，不能据此反推「已泄漏」或「已回收」。',
        '合成来源恒定速率，不模拟突发流量；告警写路径只被稀疏触发（合成进程名只有 5 种）。',
        'win32 纯 Node 读不到 OS 线程总数：线程轴依赖 --os-samples 的外部采样，缺失时该轴为「未测量」。',
        '每小时一次 process.report（约 98 ms）+ 一次冻结哈希复核会计入该小时的 CPU，量级可忽略但存在。',
        'RSS 曲线含 status 探针的成本：探针内有 4 次 COUNT(*)，大表上是全表扫描，长时间后它本身会变慢。',
        '判据只证明「在这些阈值下没被证伪」；阈值之外的慢漂移仍需更长窗口或更强观测。',
      ],
      reproduce: [
        `cd ${REPO_ROOT}`,
        `node tests/soak/longrun.mjs ${state.args.join(' ')}`,
        `# 续跑：把 --resume 加到上面，
        # 报告：node tests/soak/longrun.mjs --run-dir ${runDir} --hours ${plan.hours} --resume
        # （分析总是从 logs/*.jsonl 重算，所以只要分片在，报告就能重建）`,
      ].join('\n'),
    };
    const baseName = `longrun-${plan.hours}h-${endedAtIso.replace(/[-:]/gu, '').replace(/\.\d{3}/u, '')}`;
    fs.writeFileSync(path.join(reportDir, `${baseName}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(reportDir, `${baseName}.md`), renderReport(report), 'utf8');
    report.report_path = path.join(reportDir, `${baseName}.md`);
    process.stdout.write(`longrun: verdict=${report.verdict} checks=${report.checks.length} `
      + `failures=${report.failures.length} warnings=${report.warnings.length} deferred=${report.deferred.length}\n`);
    process.stdout.write(`longrun: report=${report.report_path}\n`);
    if (report.failures.length > 0) {
      process.stdout.write(`longrun: failing checks: ${report.failures.join(', ')}\n`);
    }
  } catch (error) {
    process.stderr.write(`longrun: report failed: ${error && error.stack ? error.stack : String(error)}\n`);
    return 1;
  }

  if (fatal !== null) {
    return 1;
  }
  if (options.gate === false) {
    return 0;
  }
  return report.verdict === 'pass' ? 0 : 1;
}

// 只在直接执行时跑主流程；被 selfcheck 导入时不要跑。
const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`longrun: fatal: ${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
