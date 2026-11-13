#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * cpu-idle.mjs — PERF-CPU 的整机口径空闲 CPU 测量器（perf-measure 席位，纯 node，无 npm 依赖）。
 *
 * 口径（写进每一个输出 JSON，所有数字可复算）：
 *
 *   整机总量  纯 PDH `\Processor(_Total)\% Processor Time`，1 s 采样一次（见 fixtures/sampler.ps1）。
 *   产品组    **残差归属**：product = total − Σ(非产品活进程) − 采样器自身。
 *             短命 powershell 子进程的 CPU 一定落在"没被任何一次进程采样抓到"的那部分里，
 *             而它按定义属于产品，正好归对。前提是非产品短命进程可忽略——这个前提不靠断言，
 *             靠 `--baseline`（栈收起）的地板实验量化，写进证据分析。
 *   逐进程拆分 同一采样进程每 400 ms 取一次 Toolhelp 快照 + GetProcessTimes，
 *             按「首次见到全额归属」累加：进程构建时间晚于运行起点则 baseline=0，
 *             所以只被看到一次的 200–600 ms powershell 也拿到全额 CPU，不会被两点差分吃掉。
 *   覆盖误差  coverageError = |Σ(所有活进程 core-seconds) − PDH 忙时 core-seconds| / PDH 忙时。
 *             这是两条独立通路（PDH 计数器 vs 逐进程累计）的实测偏差，不是恒等式。
 *             另有 GetSystemTimes 作为整机总量的第三条通路一并记录。
 *
 * 产品进程发现（不把浏览器/别家 WebView2 算进来）：
 *   - `AIDrivenNetDefense.exe` 全部；
 *   - `node.exe` 的 cmdline 含本仓库 `apps/daemon/`、`apps/desktop/`、安装目录或本战役数据根；
 *   - `msedgewebview2.exe` 仅当其父链（ppid 递归）可达壳/产品 node；
 *   - `powershell.exe`/`pwsh.exe` 父链可达产品 node → 产品；父链已知且不是产品 → 非产品；
 *     父链未知（快照里查不到，多半是刚生刚灭）→ 记 `unknown`，**不**计入非产品
 *     （否则会把产品的短命 PS 记成别家），它的 CPU 由残差兜住。
 *
 * 用法：
 *   node tests/perf/cpu-idle.mjs --minutes 10 --out <json> [--label pre]
 *   node tests/perf/cpu-idle.mjs --seconds 60 --out <json>      # 链路/稳定性调通用
 *   node tests/perf/cpu-idle.mjs --baseline --seconds 60 --out <json>     # 栈收起时的空载地板
 *   node tests/perf/cpu-idle.mjs --minutes 10 --out x.json --stack-state <stack-state.json>
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
const SAMPLER = join(HERE, 'fixtures', 'sampler.ps1');
const PS_EXE = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** 产品路径特征：仓库开发树、安装树、本战役数据根。命中即"这个进程是产品的"。 */
const PRODUCT_CMD = [
  /apps[\\/]daemon[\\/](?:bin\.js|src[\\/])/iu,
  /apps[\\/]desktop[\\/](?:main\.py|aidn[\\/])/iu,
  /AIDriven Net Defense/iu,
  /[\\/]_perf[\\/]PERF-CPU[\\/]/iu,
];

const PRODUCT_ROLES = new Set(['shell', 'daemon', 'webview', 'powershell', 'conhost', 'other-product']);

/** 安装器/卸载器：不是产品运行态，必须在报告里单列，绝不计入产品组。 */
const CONTAMINANT_NAME = /setup|installer|uninstall|update-|patch-/iu;

function parseArgs(argv) {
  const out = {
    minutes: null,
    seconds: null,
    out: null,
    label: null,
    intervalMs: 400,
    pdhEveryMs: 1000,
    cimEveryMs: 15000,
    warmupS: null,
    stackState: null,
    baseline: false,
    productPid: null,
    jobName: null,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (token === '--minutes') out.minutes = Number(next());
    else if (token === '--seconds') out.seconds = Number(next());
    else if (token === '--out') out.out = next();
    else if (token === '--label') out.label = next();
    else if (token === '--interval-ms') out.intervalMs = Number(next());
    else if (token === '--pdh-every-ms') out.pdhEveryMs = Number(next());
    else if (token === '--cim-every-ms') out.cimEveryMs = Number(next());
    else if (token === '--warmup-s') out.warmupS = Number(next());
    else if (token === '--stack-state') out.stackState = next();
    else if (token === '--product-pid') out.productPid = next();
    else if (token === '--job-name') out.jobName = next();
    else if (token === '--baseline') out.baseline = true;
    else if (token === '--quiet') out.quiet = true;
    else if (token === '--help' || token === '-h') out.help = true;
  }
  if (out.minutes !== null && out.seconds === null) out.seconds = out.minutes * 60;
  return out;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function nowIso() {
  return new Date().toISOString();
}

/** mean / median / p95（nearest-rank）。 */
export function stats(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { n: 0, mean: null, median: null, p95: null, min: null, max: null };
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  const mid = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[(sorted.length - 1) / 2];
  return { n: sorted.length, mean: sum / sorted.length, median: mid, p95: sorted[rank], min: sorted[0], max: sorted[sorted.length - 1] };
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

const roundStats = (entry) => {
  const out = {};
  for (const [key, value] of Object.entries(entry)) out[key] = typeof value === 'number' && key !== 'n' ? round(value) : value;
  return out;
};

/** 读 stack-state.json：壳/daemon 的 PID 与端口、token 文件（token 值永不落盘）。 */
function loadStackState(path) {
  const state = { path: path === null ? null : resolve(path), roots: [], tokenFile: null, daemonPort: null, uiPort: null, jobName: null, root: null, tag: null, paths: {} };
  if (state.path === null || !existsSync(state.path)) return state;
  let data = null;
  try {
    data = JSON.parse(readFileSync(state.path, 'utf8'));
  } catch {
    return state;
  }
  state.root = typeof data?.root === 'string' ? data.root : null;
  state.tag = typeof data?.tag === 'string' ? data.tag : null;
  state.daemonPid = Number.isInteger(data?.daemonPid) ? data.daemonPid : null;
  state.shellPid = Number.isInteger(data?.shellPid) ? data.shellPid : null;
  state.paths = (data?.paths !== null && typeof data?.paths === 'object') ? data.paths : {};
  for (const key of ['shellPid', 'daemonPid', 'uiHostPid']) {
    if (Number.isInteger(data?.[key])) state.roots.push(data[key]);
  }
  for (const record of data?.processes ?? []) {
    if (Number.isInteger(record?.pid)) state.roots.push(record.pid);
  }
  state.roots = [...new Set(state.roots)];
  state.tokenFile = typeof data?.tokenFile === 'string' ? data.tokenFile : null;
  state.daemonPort = Number.isInteger(data?.ports?.daemonPort)
    ? data.ports.daemonPort
    : (Number.isInteger(data?.daemonPort) ? data.daemonPort : null);
  state.uiPort = Number.isInteger(data?.ports?.uiPort)
    ? data.ports.uiPort
    : (Number.isInteger(data?.uiPort) ? data.uiPort : null);
  state.jobName = typeof data?.jobName === 'string' ? data.jobName : null;
  state.configFingerprint = (data?.configFingerprint !== null && typeof data?.configFingerprint === 'object') ? data.configFingerprint : null;
  return state;
}

/** 从产品代码现读默认 tickMs（证明"daemon.json 不写 scheduler 块"时真的走这个值）。 */
/**
 * 从**当前 --root 那棵树**的 apps/daemon/src/config.js 现读调度默认值。
 * 为什么必须现读：pre/post 两份 daemon.json 都没有 scheduler 块（hash 完全一致），
 * 但两棵树的代码默认值不同（fix-daemon 把 sourceTimeoutMs 5000→20000），
 * 所以"配置可比"只能靠点这份 defaults 来证明，不能靠 JSON 相同。
 */
function readEffectiveDefaults(root) {
  const result = { tickMs: null, sourceTimeoutMs: null, maxBatchEvents: null, staleAfterMs: null, source: null, sha256: null };
  if (typeof root !== "string" || root === "") return result;
  const file = join(root, "apps", "daemon", "src", "config.js");
  result.source = file;
  if (!existsSync(file)) return result;
  try {
    const raw = readFileSync(file);
    const text = raw.toString("utf8");
    result.sha256 = createHash("sha256").update(raw).digest("hex");
    const block = /scheduler:\s*\{([\s\S]*?)\}/u.exec(text);
    const body = block === null ? text : block[1];
    for (const key of ["tickMs", "sourceTimeoutMs", "maxBatchEvents", "staleAfterMs"]) {
      const match = new RegExp(`${key}:\\s*(\\d+)`, "u").exec(body);
      result[key] = match === null ? null : Number(match[1]);
    }
  } catch {
    return result;
  }
  return result;
}

async function httpJson(url, { headers = {}, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'manual' });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, error: null };
  } catch (error) {
    return { status: null, json: null, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** /healthz 全文 + /api/v1/status 的源计数（token/csrf 永不落盘）。 */
async function stateFingerprint(stack) {
  const fingerprint = { capturedAt: nowIso(), healthz: null, status: null, errors: [] };
  if (stack.daemonPort === null) {
    fingerprint.errors.push('no daemonPort in stack state');
    return fingerprint;
  }
  const base = `http://127.0.0.1:${stack.daemonPort}`;
  const health = await httpJson(`${base}/healthz`);
  fingerprint.healthz = { httpStatus: health.status, body: health.json, error: health.error };

  let token = null;
  if (stack.tokenFile !== null && existsSync(stack.tokenFile)) {
    try {
      token = readFileSync(stack.tokenFile, 'utf8').trim();
    } catch {
      token = null;
    }
  }
  if (token === null) {
    fingerprint.errors.push('api token unavailable; /api/v1/status not read');
    return fingerprint;
  }
  const status = await httpJson(`${base}/api/v1/status`, { headers: { authorization: `Bearer ${token}` } });
  if (status.json === null) {
    fingerprint.errors.push(`status read failed: ${status.error ?? status.status}`);
    return fingerprint;
  }
  const body = status.json;
  fingerprint.status = {
    lifecycle: body.lifecycle ?? null,
    mode: body.mode ?? null,
    health: body.health ?? null,
    store: body.store ?? null,
    counters: body.counters ?? null,
    pipeline: body.pipeline === undefined || body.pipeline === null ? null : {
      events_received: body.pipeline.events_received ?? null,
      events_accepted: body.pipeline.events_accepted ?? null,
      events_rejected: body.pipeline.events_rejected ?? null,
      events_dropped: body.pipeline.events_dropped ?? null,
      alerts_written: body.pipeline.alerts_written ?? null,
      findings_written: body.pipeline.findings_written ?? null,
      contributions_dropped: body.pipeline.contributions_dropped ?? null,
      store_errors: body.pipeline.store_errors ?? null,
      batches: body.pipeline.batches ?? null,
      events_duplicate: body.pipeline.events_duplicate ?? null,
      detection_faults: body.pipeline.detection_faults ?? null,
    },
    sources: Array.isArray(body.scheduler?.sources)
      ? body.scheduler.sources.map((source) => ({
        id: source.id,
        lifecycle: source.lifecycle,
        polls: source.polls,
        events: source.events,
        failures: source.failures ?? null,
        consecutive_failures: source.consecutive_failures ?? null,
        dropped_events: source.dropped_events ?? null,
        last_error_code: source.last_error_code ?? null,
      }))
      : null,
  };
  return fingerprint;
}

/**
 * 分类器：把 PID 归到 shell/daemon/webview/powershell/other-product/nonproduct/unknown。
 * 两份材料：最近一次全拍快照（含全部进程的 ppid/name/createdMs）与最近一次 C 行的 cmdline。
 * 只有"能判死"的结论才进缓存；unknown 每拍重算，等 cmdline 到了自然转正。
 */
function createClassifier({ roots, samplerPid, selfPid, stack = null }) {
  const cache = new Map(); // pid -> { role, createdMs }
  const cmdlines = new Map(); // pid -> string

  /**
   * 产品路径匹配。**必须按本栈的绝对路径前缀做，不能用"含 _perf 就算"**：
   * 术前/术后两套栈并存，验收席位跑 post 栈时它的 cmdline 里也有 `_perf\PERF-CPU`；
   * 宽匹配会把对方进程算成我方产品（我已踩过：把别的栈的 WebView2 当自己的）。
   */
  const productPrefixes = [];
  if (typeof stack?.root === 'string') productPrefixes.push(stack.root);
  for (const value of Object.values(stack?.paths ?? {})) {
    if (typeof value === 'string' && value.length > 3) productPrefixes.push(value);
  }
  const loweredPrefixes = productPrefixes.map((value) => value.toLowerCase());
  const stackTag = typeof stack?.tag === 'string' ? stack.tag.toLowerCase() : null;

  const cmdMatches = (cmd) => {
    if (typeof cmd !== 'string' || cmd === '') return false;
    const other = /[\\/]_perf[\\/]PERF-CPU[\\/](pre|post)[\\/]/iu.exec(cmd);
    if (other !== null && stackTag !== null && other[1].toLowerCase() !== stackTag) return false;
    if (loweredPrefixes.length > 0) {
      const lowered = cmd.toLowerCase();
      return loweredPrefixes.some((prefix) => lowered.includes(prefix));
    }
    return PRODUCT_CMD.some((pattern) => pattern.test(cmd));
  };

  /** 这个 pid 本身能否直接被判成产品（不看它的祖先）。 */
  function isProductPid(pid, snapshot) {
    if (pid === samplerPid || pid === selfPid) return false;
    if (roots.has(pid)) return true;
    const entry = snapshot.get(pid);
    if (entry === undefined) return false;
    if (entry.name === 'AIDrivenNetDefense') return true;
    const cmd = cmdlines.get(pid) ?? null;
    if (cmdMatches(cmd)) return true;
    const cached = cache.get(pid);
    if (cached !== undefined && cached.createdMs === entry.createdMs && PRODUCT_ROLES.has(cached.role)) return true;
    return false;
  }

  /** 从 pid 的父链往上找产品节点。unresolved=父链断在快照外（多半是刚生刚灭）。 */
  function chainFrom(pid, snapshot) {
    let current = Number(snapshot.get(pid)?.ppid ?? 0);
    const seen = new Set();
    for (let depth = 0; depth < 16; depth += 1) {
      if (current === 0 || !Number.isInteger(current) || seen.has(current)) return { reached: false, resolved: true };
      seen.add(current);
      if (isProductPid(current, snapshot)) return { reached: true, resolved: true };
      const entry = snapshot.get(current);
      if (entry === undefined) return { reached: false, resolved: false };
      current = Number(entry.ppid ?? 0);
    }
    return { reached: false, resolved: false };
  }

  function classify(pid, entry, snapshot) {
    if (pid === samplerPid) return { role: 'sampler', resolved: true };
    if (pid === selfPid) return { role: 'sampler', resolved: true };
    const name = entry?.name ?? '';
    const cached = cache.get(pid);
    if (cached !== undefined && cached.createdMs === entry?.createdMs && cached.role !== 'unknown') {
      return { role: cached.role, resolved: true };
    }

    const remember = (role) => {
      cache.set(pid, { role, createdMs: entry?.createdMs ?? 0 });
      return { role, resolved: role !== 'unknown' };
    };

    if (roots.has(pid)) return remember(name === 'AIDrivenNetDefense' ? 'shell' : 'other-product');
    if (name === 'AIDrivenNetDefense') return remember('shell');

    if (name === 'node') {
      const cmd = cmdlines.get(pid) ?? null;
      if (cmd === null) return remember('unknown');
      if (cmdMatches(cmd)) return remember(/apps[\\/]daemon/iu.test(cmd) ? 'daemon' : 'other-product');
      const chain = chainFrom(pid, snapshot);
      if (chain.reached) return remember('daemon');
      return remember(chain.resolved ? 'nonproduct' : 'unknown');
    }

    if (name === 'python' || name === 'pythonw' || name === 'python3') {
      const cmd = cmdlines.get(pid) ?? null;
      if (cmd !== null && cmdMatches(cmd)) return remember('shell');
      const chain = chainFrom(pid, snapshot);
      if (chain.reached) return remember('other-product');
      return remember(chain.resolved ? 'nonproduct' : 'unknown');
    }

    if (name === 'msedgewebview2') {
      const chain = chainFrom(pid, snapshot);
      if (chain.reached) return remember('webview');
      return remember(chain.resolved ? 'nonproduct' : 'unknown');
    }

    if (name === 'powershell' || name === 'pwsh') {
      const chain = chainFrom(pid, snapshot);
      if (chain.reached) return remember('powershell');
      // 父链拿不到 → 不记成别家（会把产品短命 PS 记错），交给残差。
      return remember(chain.resolved ? 'nonproduct' : 'unknown');
    }

    const chain = chainFrom(pid, snapshot);
    if (chain.reached) return remember('other-product');
    return remember(chain.resolved ? 'nonproduct' : 'unknown');
  }

  return {
    classify,
    cmdlines,
    cache,
    isProductRole: (role) => PRODUCT_ROLES.has(role),
    isProductCmdline: (pid) => cmdMatches(cmdlines.get(pid) ?? null),
    setCmdline(pid, cmd) {
      cmdlines.set(pid, cmd);
      cache.delete(pid);
    },
  };
}

function parseProcList(raw) {
  const entries = new Map();
  if (typeof raw !== 'string' || raw === '') return entries;
  for (const record of raw.split(',')) {
    if (record === '') continue;
    const parts = record.split(':');
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const cpu = Number(parts[3]);
    const createdMs = Number(parts[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    entries.set(pid, {
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      name: parts[2],
      cpu: Number.isFinite(cpu) ? cpu : -1,
      createdMs: Number.isFinite(createdMs) ? createdMs : 0,
    });
  }
  return entries;
}

/** `P|epoch|pid:perCorePct,...` → Map(pid -> perCorePct)。per-core 口径：一个核满载 = 100。 */
function parsePdhProcs(raw) {
  const entries = new Map();
  if (typeof raw !== 'string' || raw === '') return entries;
  for (const record of raw.split(',')) {
    if (record === '') continue;
    const separator = record.lastIndexOf(':');
    if (separator <= 0) continue;
    const pid = Number(record.slice(0, separator));
    const value = Number(record.slice(separator + 1));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isFinite(value)) continue;
    entries.set(pid, value);
  }
  return entries;
}

function runSampler({ durationMs, intervalMs, pdhEveryMs, cimEveryMs, onLine, onSpawn }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(PS_EXE, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SAMPLER,
      '-DurationMs', String(durationMs),
      '-IntervalMs', String(intervalMs),
      '-PdhEveryMs', String(pdhEveryMs),
      '-CimEveryMs', String(cimEveryMs),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (typeof onSpawn === 'function') onSpawn(child.pid);
    const stderrChunks = [];
    child.stderr.on('data', (chunk) => {
      if (stderrChunks.length < 400) stderrChunks.push(chunk.toString('utf8'));
    });
    createInterface({ input: child.stdout }).on('line', (line) => onLine(line));
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stderr: stderrChunks.join('').slice(-4000), pid: child.pid }));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write('usage: node tests/perf/cpu-idle.mjs --minutes 10 --out <json> [--label pre] [--seconds N] [--stack-state <json>] [--baseline] [--warmup-s N]\n');
    return 0;
  }
  if (args.seconds === null || !Number.isFinite(args.seconds) || args.seconds <= 0) {
    process.stderr.write('cpu-idle: --seconds N or --minutes N is required\n');
    return 2;
  }
  if (args.out === null) {
    process.stderr.write('cpu-idle: --out <json path> is required\n');
    return 2;
  }

  const durationMs = Math.round(args.seconds * 1000);
  const warmupS = args.warmupS !== null
    ? args.warmupS
    : (args.seconds >= 300 ? 120 : Math.min(30, Math.floor(args.seconds * 0.25)));
  const ncpu = cpus().length;

  const stack = loadStackState(args.stackState);
  const extraRoots = (args.productPid ?? '').split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
  const roots = new Set([...stack.roots, ...extraRoots]);
  const selfPid = process.pid;

  // ---- Job Object 会计（主口径）------------------------------------------------
  // 内核按 job 记账，包含已退出的子进程 → 产品那几十次/分钟的短命 powershell 一个不漏，
  // 且完全不受机器上别的负载影响。没有 job（或非 Windows）时退回逐 PID 口径。
  const jobName = args.jobName ?? stack.jobName ?? null;
  let jobCtx = null;
  if (jobName !== null) {
    try {
      const { jobApi } = await import('./lib/jobobj.mjs');
      const api = jobApi();
      const job = api.openJob(jobName);
      if (job === null) {
        process.stderr.write(`cpu-idle: job ${jobName} not found; falling back to per-PID only\n`);
      } else {
        jobCtx = { api, job, name: jobName, last: null, series: [], createdSeries: [], terminatedSeries: [], activeSeries: [], pidListSeen: new Set(), createdByImage: new Map(), createdUnattributed: 0 };
      }
    } catch (error) {
      process.stderr.write(`cpu-idle: job accounting unavailable: ${error?.message ?? error}\n`);
    }
  }

  /** 只刷 job 的 pid 列表（快、无会计），用于 400 ms 快拍上抓短命子进程的镜像名。 */
  function refreshJobPids() {
    if (jobCtx === null || jobCtx.job === null) return;
    try {
      const pidList = jobCtx.api.queryProcessIdList(jobCtx.job);
      for (const pid of pidList.pids) {
        if (jobCtx.pidListSeen.has(pid)) continue;
        jobCtx.pidListSeen.add(pid);
        const imageName = pidNames.get(pid) ?? snapshot.get(pid)?.name ?? states.get(pid)?.name ?? null;
        if (imageName === null) jobCtx.createdUnattributed += 1;
        else jobCtx.createdByImage.set(imageName, (jobCtx.createdByImage.get(imageName) ?? 0) + 1);
      }
      jobCtx.lastPidList = pidList.pids;
    } catch (error) {
      jobCtx.error = String(error?.message ?? error);
    }
  }

  function sampleJob(epochMs, intervalMs) {
    if (jobCtx === null) return null;
    try {
      const accounting = jobCtx.api.queryAccounting(jobCtx.job);
      const pidList = jobCtx.api.queryProcessIdList(jobCtx.job);
      for (const pid of pidList.pids) {
        if (jobCtx.pidListSeen.has(pid)) continue;
        jobCtx.pidListSeen.add(pid);
        // 新 pid 按镜像名归类：这是"powershell 到底起了几次"的权威拆分（ΔTotalProcesses 里 conhost 掺水）。
        const imageName = pidNames.get(pid) ?? snapshot.get(pid)?.name ?? states.get(pid)?.name ?? null;
        if (imageName === null) jobCtx.createdUnattributed += 1;
        else jobCtx.createdByImage.set(imageName, (jobCtx.createdByImage.get(imageName) ?? 0) + 1);
      }
      const reading = { epochMs, accounting, pids: pidList.pids };
      let pct = null;
      if (jobCtx.last !== null) {
        const deltaSec = reading.accounting.totalSec - jobCtx.last.accounting.totalSec;
        const deltaMs = epochMs - jobCtx.last.epochMs;
        if (deltaMs > 0 && Number.isFinite(deltaSec)) pct = (deltaSec / (deltaMs / 1000) / ncpu) * 100;
        jobCtx.createdSeries.push(Math.max(0, reading.accounting.totalProcesses - jobCtx.last.accounting.totalProcesses));
        jobCtx.terminatedSeries.push(Math.max(0, (reading.accounting.totalTerminated ?? 0) - (jobCtx.last.accounting.totalTerminated ?? 0)));
      }
      jobCtx.activeSeries.push(accounting.activeProcesses);
      jobCtx.series.push(pct);
      reading.pct = pct;
      jobCtx.last = reading;
      void intervalMs;
      return reading;
    } catch (error) {
      jobCtx.error = String(error?.message ?? error);
      return null;
    }
  }

  const fingerprintStart = await stateFingerprint(stack);

  const startedWallMs = Date.now();
  let samplerPid = null;
  let classifier = createClassifier({ roots, samplerPid, selfPid, stack });
  const states = new Map(); // pid -> {name, createdMs, baseline, last, book, role}
  const perPid = new Map(); // key=pid:createdMs -> {name, role, firstSeenMs, series:[], totalSec}
  const pidNames = new Map(); // pid -> image name（来自 Toolhelp 快拍，用于"新 pid 按镜像名归类"）
  let snapshot = new Map();
  let lastSample = null;
  let jobPidSet = null;
  const contaminantSeen = new Map();
  const samples = [];
  const raw = { s: 0, t: 0, c: 0, x: [], stderr: null, exitCode: null, selfBookSec: 0 };
  const discovered = { product: new Set(), nonProduct: new Set() };
  const unknownSeen = new Set();
  let sampleIndex = 0;
  const pendingCmdlines = [];

  const selfCpuStart = process.cpuUsage();

  function upsertState(entry, runStartMs) {
    let state = states.get(entry.pid);
    if (state !== undefined && state.createdMs === entry.createdMs) {
      state.last = entry.cpu;
      return state;
    }
    let baseline = entry.cpu;
    if (Number.isFinite(entry.createdMs) && entry.createdMs > runStartMs - 1000) baseline = 0;
    state = { name: entry.name, createdMs: entry.createdMs, baseline, last: entry.cpu, book: 0, role: null };
    states.set(entry.pid, state);
    if (Number.isFinite(entry.createdMs) && entry.createdMs > runStartMs) {
      const { role } = classifier.classify(entry.pid, entry, snapshot.size > 0 ? snapshot : new Map([[entry.pid, entry]]));
      if (PRODUCT_ROLES.has(role)) discovered.product.add(entry.pid);
      else if (role === 'nonproduct') discovered.nonProduct.add(entry.pid);
    }
    return state;
  }

  let pendingPdh = new Map();
  const pdhDiagnostics = new Set();

  function handleLine(line) {
    if (line === '') return;
    const kind = line[0];
    if (kind === 'S') {
      raw.s += 1;
      const fields = line.split('|');
      const epoch = Number(fields[1]);
      const totalPct = Number(fields[2]);
      const sysPct = Number(fields[3]);
      const procs = parseProcList(fields[4]);
      if (procs.size > 0) snapshot = procs;
      handleFullTick({ epoch, procs, totalPct, sysPct, pdhProc: pendingPdh });
      pendingPdh = new Map();
    } else if (kind === 'P') {
      raw.p += 1;
      const fields = line.split('|');
      pendingPdh = parsePdhProcs(fields[2]);
    } else if (kind === 'T') {
      raw.t += 1;
      const fields = line.split('|');
      const procs = parseProcList(fields[2]);
      for (const entry of procs.values()) pidNames.set(entry.pid, entry.name);
      for (const entry of procs.values()) {
        if (entry.cpu < 0) continue;
        upsertState(entry, startedWallMs);
      }
      // 400 ms 快拍也刷一次 job pid 列表：短命 powershell/conhost 常在 1 s 全量采样之间就没了。
      refreshJobPids();
    } else if (kind === 'C') {
      raw.c += 1;
      const parts = line.split('|');
      const pid = Number(parts[2]);
      const cmd = parts.slice(3).join('|');
      if (Number.isInteger(pid)) {
        if (classifier === null) pendingCmdlines.push([pid, cmd]);
        else classifier.setCmdline(pid, cmd);
      }
    } else if (kind === 'X') {
      raw.x.push(line);
      if (line.startsWith('X|pdh|')) pdhDiagnostics.add(line);
    } else if (kind === 'E') {
      raw.endedAtMs = Number(line.split('|')[1]);
    }
  }

  function handleFullTick({ epoch, procs, totalPct, sysPct, pdhProc }) {
    for (const entry of procs.values()) pidNames.set(entry.pid, entry.name);
    for (const entry of procs.values()) {
      if (entry.cpu < 0) continue;
      upsertState(entry, startedWallMs);
    }
    const prev = lastSample;
    // Job 会员资格 = 权威产品集合（内核说的），优先于命令行启发式。
    const jobReading = sampleJob(epoch, prev === null ? 0 : epoch - prev.nowMs);
    if (jobReading !== null) jobPidSet = new Set(jobReading.pids);
    lastSample = { nowMs: epoch, totalPct, sysPct };
    if (prev === null) return;
    const intervalMs = epoch - prev.nowMs;
    if (intervalMs <= 0) return;
    sampleIndex += 1;
    const intervalSec = intervalMs / 1000;
    const toPct = (sec) => (sec / intervalSec / ncpu) * 100;

    const buckets = {
      shell: 0, daemon: 0, webview: 0, powershell: 0, otherProduct: 0,
      nonProduct: 0, unknown: 0, sampler: 0, contaminant: 0, conhost: 0,
    };
    // 角色名 → 桶名（角色用连字符，输出桶用驼峰；这里显式映射，避免静默 NaN）
    const BUCKET_OF = {
      shell: 'shell',
      daemon: 'daemon',
      webview: 'webview',
      powershell: 'powershell',
      'other-product': 'otherProduct',
      nonproduct: 'nonProduct',
      contaminant: 'contaminant',
      conhost: 'conhost',
      sampler: 'sampler',
      unknown: 'unknown',
    };
    const addBucket = (role, pct) => {
      const key = BUCKET_OF[role] ?? 'unknown';
      buckets[key] += pct;
    };
    let accountedPct = 0;
    const deltas = [];

    let escapedProductPct = 0;
    /** 产品 CPU 落在 job 外 = WebView2 breakaway 或拉起的独立进程；并集口径要把它加回去。 */
    const isEscaped = (pid) => jobPidSet !== null && !jobPidSet.has(pid);
    // 归因用的分量：真源 daemon 与壳自带的 mock daemon 必须分开（壳会起一个零源 daemon）。
    let realDaemonPct = 0;
    let mockDaemonPct = 0;
    // (1) 能直接读到 CPU 的进程：用累计差分，精确、且能抓到 400 ms 快拍里的短命子进程。
    for (const [pid, state] of states) {
      const cumulative = state.last - state.baseline;
      const delta = cumulative - state.book;
      if (delta === 0) continue;
      state.book = cumulative;
      const sec = delta > 0 ? delta : 0;
      const pct = toPct(sec);
      const role = roleFor(pid, state, procs);
      addBucket(role, pct);
      accountedPct += pct;
      const escaped = PRODUCT_ROLES.has(role) && isEscaped(pid);
      if (role === 'daemon') {
        if (pid === stack.daemonPid) realDaemonPct += pct;
        else mockDaemonPct += pct;
      }
      if (escaped) escapedProductPct += pct;
      deltas.push({ pid, name: state.name, role, pct, createdMs: state.createdMs, escaped });
    }

    // (2) 读不到 CPU 的进程（SYSTEM / 受保护）：用 PDH 逐进程计数器补上，
    //     否则它们的 CPU 会被残差误记成产品。它们都是长命实例，PDH 对它们不漏。
    for (const [pid, perCorePct] of pdhProc) {
      if (states.has(pid)) continue;
      if (pid === samplerPid || pid === selfPid) continue;
      const entry = snapshot.get(pid) ?? procs.get(pid);
      const role = roleFor(pid, entry ?? { pid, ppid: 0, name: '?', createdMs: 0 }, procs, true);
      const pct = perCorePct / ncpu;
      addBucket(role, pct);
      accountedPct += pct;
      if (PRODUCT_ROLES.has(role)) {
        const escaped = isEscaped(pid);
        if (escaped) escapedProductPct += pct;
        deltas.push({ pid, name: entry?.name ?? '?', role, pct, createdMs: entry?.createdMs ?? 0, escaped });
      }
    }

    // (3) 采样器自身（node 侧）也要算进来并排除。
    const selfUsage = process.cpuUsage(selfCpuStart);
    const selfSec = (selfUsage.user + selfUsage.system) / 1e6;
    const selfDelta = Math.max(0, selfSec - raw.selfBookSec);
    raw.selfBookSec = selfSec;
    const selfPct = toPct(selfDelta);
    buckets.sampler += selfPct;
    accountedPct += selfPct;

    // 只作上下文：整机上谁在吃 CPU（含读不到 CPU 的系统进程，用 PDH 逐进程值）
    const pdhByName = new Map();
    for (const [pid, perCore] of pdhProc) {
      const name = snapshot.get(pid)?.name ?? procs.get(pid)?.name ?? `pid-${pid}`;
      pdhByName.set(name, (pdhByName.get(name) ?? 0) + perCore / ncpu);
    }

    // 污染源登记：安装器/卸载器不是产品运行态，但必须在报告里单列（"数字在什么环境下测的"）。
    for (const [pid, perCore] of pdhProc) {
      const name = snapshot.get(pid)?.name ?? '';
      if (!/setup|install|uninstall/i.test(name)) continue;
      if (jobPidSet !== null && jobPidSet.has(pid)) continue;
      const key = `${pid}:${name}`;
      const record = contaminantSeen.get(key) ?? { pid, name, maxPct: 0, samples: 0 };
      record.maxPct = Math.max(record.maxPct, perCore / ncpu);
      record.samples += 1;
      contaminantSeen.set(key, record);
    }

    const machineCoreSec = (totalPct / 100) * ncpu * intervalSec;
    const productPct = totalPct - buckets.nonProduct - buckets.contaminant - buckets.sampler;
    const trackedProductPct = buckets.shell + buckets.daemon + buckets.webview + buckets.powershell + buckets.otherProduct;
    const residualPct = totalPct - accountedPct;

    samples.push({
      index: sampleIndex,
      epochMs: epoch,
      intervalMs,
      totalPct,
      sysPct,
      machineCoreSec,
      accountedCoreSec: (accountedPct / 100) * ncpu * intervalSec,
      productPct,
      productTrackedPct: trackedProductPct,
      residualPct,
      nonProductPct: buckets.nonProduct,
      samplerPct: buckets.sampler,
      unknownPct: buckets.unknown,
      shellPct: buckets.shell,
      daemonPct: buckets.daemon,
      webviewPct: buckets.webview,
      powershellPct: buckets.powershell,
      otherProductPct: buckets.otherProduct,
      contaminantPct: buckets.contaminant,
      conhostPct: buckets.conhost,
      realDaemonPct,
      mockDaemonPct,
      pdhOnlyPids: Math.max(0, pdhProc.size - [...pdhProc.keys()].filter((pid) => states.has(pid)).length),
      jobPct: jobReading === null ? null : jobReading.pct,
      escapedProductPct,
      unionPct: jobReading === null ? null : jobReading.pct + escapedProductPct,
      unionCoreSec: jobReading === null ? null : (jobReading.pct + escapedProductPct) / 100 * ncpu * intervalSec,
      jobActive: jobReading === null ? null : jobReading.accounting.activeProcesses,
      jobTotalProcesses: jobReading === null ? null : jobReading.accounting.totalProcesses,
      jobPids: jobReading === null ? null : jobReading.pids.length,
      productCoreSec: (productPct / 100) * ncpu * intervalSec,
      trackedProductCoreSec: (trackedProductPct / 100) * ncpu * intervalSec,
      pdhByName,
    });

    for (const { pid, name, role, pct, createdMs, escaped } of deltas) {
      const key = [pid, createdMs ?? 0].join(":");
      let record = perPid.get(key);
      if (record === undefined) {
        record = { pid, name, role, firstSeenMs: epoch, series: [], totalSec: 0, escaped: escaped === true };
        perPid.set(key, record);
      }
      record.series.push(pct);
      record.totalSec += (pct / 100) * ncpu * intervalSec;
      record.role = role;
      if (escaped === true) record.escaped = true;
    }
    raw.lastEscapedPct = escapedProductPct;
    raw.escapedCoreSec += (escapedProductPct / 100) * ncpu * intervalSec;
  }

  /**
   * 角色解析。**有 job 时以 job 会员资格为唯一权威**：内核按 job 记账，会员资格不会骗人；
   * 逐 PID 只用来回答"谁吃了多少"，分类错了也不影响主口径（Job ΔCPU）。
   * 没有 job 时才退回命令行/父链启发式，并且 unknown 一律保守归产品。
   */
  function roleFor(pid, entry, procs, pdhOnly = false) {
    if (pid === samplerPid || pid === selfPid) return 'sampler';
    const name = entry?.name ?? states.get(pid)?.name ?? '';
    if (CONTAMINANT_NAME.test(name)) return 'contaminant';

    if (jobPidSet !== null) {
      const state = states.get(pid);
      if (jobPidSet.has(pid)) {
        const role = roleFromName(name);
        if (state !== undefined) state.role = role;
        return role;
      }
      // 不在 job 里：只有命令行明确指向产品树（例如 breakaway 出去的子进程）才算产品。
      if (classifier.isProductCmdline(pid)) {
        if (state !== undefined) state.role = 'other-product';
        return 'other-product';
      }
      if (state !== undefined) state.role = 'nonproduct';
      return 'nonproduct';
    }

    void pdhOnly;
    void procs;
    const state = states.get(pid);
    if (state === undefined) return 'unknown';
    if (state.role !== null) return state.role;
    const result = classifier.classify(pid, entry, snapshot);
    if (result.resolved) state.role = result.role;
    return result.role;
  }

  /** 已知是 job 会员、按镜像名给角色（只影响"谁吃了多少"的标签，不影响主口径）。 */
  function roleFromName(name) {
    if (name === 'node') return 'daemon';
    if (name === 'python' || name === 'pythonw' || name === 'python3') return 'shell';
    if (name === 'msedgewebview2') return 'webview';
    if (name === 'powershell' || name === 'pwsh') return 'powershell';
    if (name === 'conhost') return 'conhost';
    if (name === 'AIDrivenNetDefense') return 'shell';
    return 'other-product';
  }

  if (!args.quiet) {
    process.stdout.write(`cpu-idle: ${args.seconds}s window, warmup ${warmupS}s, interval ${args.intervalMs}ms, ncpu=${ncpu}, roots=[${[...roots].join(',')}]\n`);
  }

  const samplerResult = await runSampler({
    durationMs,
    intervalMs: args.intervalMs,
    pdhEveryMs: args.pdhEveryMs,
    cimEveryMs: args.cimEveryMs,
    onLine: handleLine,
    onSpawn: (pid) => {
      samplerPid = pid;
      classifier = createClassifier({ roots, samplerPid, selfPid, stack });
      for (const [pendingPid, cmd] of pendingCmdlines) classifier.setCmdline(pendingPid, cmd);
      pendingCmdlines.length = 0;
    },
  });
  raw.exitCode = samplerResult.code;
  raw.stderr = samplerResult.stderr;
  const endedWallMs = Date.now();

  const fingerprintEnd = await stateFingerprint(stack);

  const sustainFromMs = startedWallMs + warmupS * 1000;
  const sustained = samples.filter((sample) => sample.epochMs >= sustainFromMs);
  const usable = sustained.length > 0 ? sustained : samples;
  const machineStats = stats(usable.map((sample) => sample.totalPct));
  const productStats = stats(usable.map((sample) => sample.productPct));
  const productTrackedStats = stats(usable.map((sample) => sample.productTrackedPct));
  const residualStats = stats(usable.map((sample) => sample.residualPct));
  const samplerStats = stats(usable.map((sample) => sample.samplerPct));
  const nonProductStats = stats(usable.map((sample) => sample.nonProductPct));
  const unknownStats = stats(usable.map((sample) => sample.unknownPct));
  const sysStats = stats(usable.map((sample) => sample.sysPct).filter((value) => value >= 0));

  const sumPdhCoreSec = usable.reduce((acc, sample) => acc + sample.machineCoreSec, 0);
  const sumAccountedCoreSec = usable.reduce((acc, sample) => acc + sample.accountedCoreSec, 0);
  const usableSec = usable.reduce((acc, sample) => acc + sample.intervalMs / 1000, 0);

  // ---- 主口径聚合：Job 会计 ----
  const jobPctSeries = usable.map((sample) => sample.jobPct).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const jobStats = stats(jobPctSeries);
  const jobPidSeries = usable.map((sample) => sample.jobPids).filter((value) => typeof value === 'number');
  const jobActiveSeries = usable.map((sample) => sample.jobActive).filter((value) => typeof value === 'number');
  const sumJobCoreSec = jobPctSeries.reduce((acc, pct, index) => acc + (pct / 100) * ncpu * (usable[index]?.intervalMs ?? 1000) / 1000, 0);
  const sumProductCoreSec = usable.reduce((acc, sample) => acc + sample.productCoreSec, 0);
  const sumTrackedProductCoreSec = usable.reduce((acc, sample) => acc + sample.trackedProductCoreSec, 0);
  // 交叉校验：JobΔCPU 与"逐 PID ΔCPU 之和"的偏差。WebView2 breakaway / 版本差异都会体现在这里。
  // 并集口径：Job 会计 + 落在 job 外的产品进程（WebView2 breakaway 等）。
  const unionSeries = usable.map((sample) => sample.unionPct).filter((value) => typeof value === "number" && Number.isFinite(value));
  const unionStats = stats(unionSeries);
  const escapedSeries = usable.map((sample) => sample.escapedProductPct).filter((value) => typeof value === "number" && Number.isFinite(value));
  const escapedStats = stats(escapedSeries);
  const sumEscapedCoreSec = usable.reduce((acc, sample) => acc + (sample.escapedProductPct / 100) * ncpu * (sample.intervalMs / 1000), 0);
  const sumUnionCoreSec = sumJobCoreSec + sumEscapedCoreSec;

  // ---- 四行归因：**以实测总量为锚**，分量也全部实测 ----
  // 旧做法是"模型总量 = 各分量相加"，与实测对不上（模型高估 1.3–1.9 pp）。
  // 现在反过来：PS 总量 = 实测 Job 总量 − 实测 daemon − 实测 mock daemon − 实测壳/WebView2，
  // 保证四行之和恒等于实测量；未归因量若为负，说明某个分量测大了，如实报。
  const meanOf = (selector) => stats(usable.map(selector)).mean;
  const realDaemonMean = meanOf((sample) => sample.realDaemonPct);
  const mockDaemonMean = meanOf((sample) => sample.mockDaemonPct);
  const shellMeanPct = meanOf((sample) => sample.shellPct);
  const webviewMeanPct = meanOf((sample) => sample.webviewPct);
  const powershellMeanPct = meanOf((sample) => sample.powershellPct);
  const conhostMeanPct = meanOf((sample) => sample.conhostPct);
  const jobMeanPct = jobStats.mean;
  const psTotalMeanPct = jobMeanPct === null ? null : jobMeanPct - (realDaemonMean + mockDaemonMean + shellMeanPct + webviewMeanPct);
  const psUnattributedPct = psTotalMeanPct === null ? null : psTotalMeanPct - powershellMeanPct - conhostMeanPct;
  const psRecords = [...perPid.values()].filter((record) => record.role === "powershell");
  const psMeasuredCoreSec = psRecords.reduce((acc, record) => acc + record.totalSec, 0);
  const psTotalCoreSec = (psTotalMeanPct === null) ? null : (psTotalMeanPct / 100) * ncpu * usableSec;
  const MODEL_SPAWN_CPU_SEC = 0.67969; // 单次 powershell 冷启动 CPU（前序实测常数，仅作拆分模型）
  // 权威 spawn 数 = job PID 列表里新出现的 powershell.exe 个数（逐 PID 只能看到活着的那些，会低估）。
  const psAuthoritativeSpawns = jobCtx === null ? null : (jobCtx.createdByImage.get("powershell.exe") ?? null);
  const psSpawnCountForModel = psAuthoritativeSpawns ?? psRecords.length;
  const psNoiseSharePct = (psTotalCoreSec === null || psTotalCoreSec <= 0) ? null : Math.min(1, (psSpawnCountForModel * MODEL_SPAWN_CPU_SEC) / psTotalCoreSec) * 100;
  const attribution = {
    anchor: "job.mean（实测量）",
    measured: {
      jobTotalPct: round(jobMeanPct),
      realDaemonPct: round(realDaemonMean),
      mockDaemonPct: round(mockDaemonMean),
      shellPct: round(shellMeanPct),
      webviewPct: round(webviewMeanPct),
      powershellPct: round(powershellMeanPct),
      conhostPct: round(conhostMeanPct),
    },
    powershellTotalPct: round(psTotalMeanPct),
    powershellSplit: {
      spawnsSeen: psRecords.length,
      authoritativeSpawnCount: psAuthoritativeSpawns,
      spawnCountUsedForModel: psSpawnCountForModel,
      measuredPowershellCoreSec: round(psMeasuredCoreSec, 3),
      modelSpawnCpuSec: MODEL_SPAWN_CPU_SEC,
      noiseSharePct: psNoiseSharePct === null ? null : round(psNoiseSharePct, 2),
      noisePct: psNoiseSharePct === null ? null : round((psTotalMeanPct * psNoiseSharePct) / 100),
      cmdletPct: psNoiseSharePct === null ? null : round(psTotalMeanPct * (1 - psNoiseSharePct / 100)),
    },
    unattributedPct: round(psUnattributedPct),
    note: "PS 总量是从实测 Job 总量里减出来的（所以四行之和 = 实测量）；powershell 的底噪/执行拆分用 modelSpawnCpuSec × 观测到的 spawn 数，模型只用于拆分比例，不用于总量。unattributed 为负 = 某分量测大了，需如实报。",
  };
  const jobCoverageErrorPct = sumJobCoreSec > 0
    ? (Math.abs(sumTrackedProductCoreSec - sumJobCoreSec) / sumJobCoreSec) * 100
    : null;
  const shortLivedSharePct = sumJobCoreSec > 0
    ? (Math.max(0, sumJobCoreSec - sumTrackedProductCoreSec) / sumJobCoreSec) * 100
    : null;
  const breakawaySuspectedPct = sumJobCoreSec > 0
    ? (Math.max(0, sumTrackedProductCoreSec - sumJobCoreSec) / sumJobCoreSec) * 100
    : null;
  // 残差法（旧主口径，现降级为校验）：逐进程覆盖与整机总量的偏差。
  const coverageError = sumPdhCoreSec > 0 ? Math.abs(sumAccountedCoreSec - sumPdhCoreSec) / sumPdhCoreSec : null;

  const terminatedDeltas = jobCtx === null ? [] : jobCtx.terminatedSeries.filter((value) => Number.isFinite(value));
  const createdDeltas = jobCtx === null ? [] : jobCtx.createdSeries.filter((value) => Number.isFinite(value));
  const jobAccountingSummary = jobCtx === null ? null : {
    lastName: jobCtx.name,
    samples: jobPctSeries.length,
    activeProcesses: stats(jobActiveSeries),
    totalProcessesCreatedDelta: createdDeltas.reduce((acc, value) => acc + value, 0),
    processesCreatedPerMinute: usableSec > 0 ? round((createdDeltas.reduce((acc, value) => acc + value, 0) / usableSec) * 60, 2) : null,
    totalTerminatedDelta: terminatedDeltas.reduce((acc, value) => acc + value, 0),
    processesCreatedByImage: jobCtx === null ? null : Object.fromEntries([...jobCtx.createdByImage.entries()].sort((a, b) => b[1] - a[1])),
    processesCreatedUnattributed: jobCtx === null ? null : jobCtx.createdUnattributed,
    processesCreatedByImageNote: "按 job PID 列表里**新出现的 pid** 的镜像名归类（400 ms 快拍 + 1 s 全量采样都会刷）。ΔTotalProcesses 里 conhost 占很多，这一项才是\"powershell 到底起了几次\"。",
    createdPerSampleMin: createdDeltas.length > 0 ? Math.min(...createdDeltas) : null,
    createdPerSampleMax: createdDeltas.length > 0 ? Math.max(...createdDeltas) : null,
    note: 'TotalTerminatedProcesses 只统计"因 job 限额被杀"的进程，自然退出不计；新进程数用 TotalProcesses 增量（这是权威的短命子进程计数）。',
    error: jobCtx.error ?? null,
    lastAccounting: jobCtx.last === null ? null : jobCtx.last.accounting,
    distinctPidsSeenInJob: jobCtx.pidListSeen.size,
  };

  // ---- tick 配置：必须用**产品默认**（不写 scheduler 块），并实测佐证 ----
  // batches 是 daemon 每 tick 递增一次的计数器，所以 Δwindow/Δbatches 就是"实测 tickMs"。
  const batchesStart = fingerprintStart.status?.pipeline?.batches ?? null;
  const batchesEnd = fingerprintEnd.status?.pipeline?.batches ?? null;
  const batchDelta = (batchesStart !== null && batchesEnd !== null) ? batchesEnd - batchesStart : null;
  const tickWindowSec = (endedWallMs - startedWallMs) / 1000;
  const effectiveTickMs = (batchDelta !== null && batchDelta > 0) ? round((tickWindowSec * 1000) / batchDelta, 1) : null;
  const effectiveDefaults = readEffectiveDefaults(stack.root ?? REPO_ROOT);
  // 实测轮询节奏：polls 是每源真实轮询次数，`windowSec*1000/Δpolls` 才是"每源实际轮询间隔"。
  // 它与 tickMs 不等（源有独立 intervalMs、且上一轮没跑完会跳过），所以两个都报，标清口径。
  const pollsStartMap = new Map((fingerprintStart.status?.sources ?? []).map((source) => [source.id, source.polls]));
  const perSourcePollIntervalMs = [];
  let pollsDeltaTotal = 0;
  for (const source of (fingerprintEnd.status?.sources ?? [])) {
    const before = pollsStartMap.get(source.id);
    if (before === undefined || typeof source.polls !== "number") continue;
    const delta = source.polls - before;
    pollsDeltaTotal += delta;
    if (delta > 0) perSourcePollIntervalMs.push({ id: source.id, pollsDelta: delta, intervalMs: round((tickWindowSec * 1000) / delta, 1) });
  }
  const pollIntervals = perSourcePollIntervalMs.map((entry) => entry.intervalMs).sort((a, b) => a - b);
  const measuredPollIntervalMsMedian = pollIntervals.length === 0 ? null : pollIntervals[Math.floor(pollIntervals.length / 2)];
  const schedulerReport = {
    defaultTickMsFromCode: effectiveDefaults.tickMs,
    effectiveDefaults,
    configuredSchedulerBlock: stack.configFingerprint?.schedulerBlock ?? null,
    measuredPollIntervalMsMedian,
    secondsPerBatch: (batchDelta !== null && batchDelta > 0) ? round(tickWindowSec / batchDelta, 2) : null,
    batchesDelta: batchDelta,
    pollsDelta: pollsDeltaTotal,
    perSourcePollIntervalMs,
    windowSec: round(tickWindowSec, 1),
    note: "defaultTickMsFromCode 从 apps/daemon/src/config.js 现读（证明不写 scheduler 块时真的走默认）；measuredPollIntervalMsMedian 是逐源实测轮询间隔 = windowSec*1000/Δpolls（不是假设）；secondsPerBatch = windowSec/Δpipeline.batches（batches 只在真有新数据时计数，故 > 轮询间隔）。",
  };
  // ---- 机器负载上下文：整机 100% 饱和时，绝对数字没有可比性 ----
  const pdhTop = new Map();
  for (const sample of usable) {
    const pcts = sample.pdhByName;
    if (pcts === undefined) continue;
    for (const [name, pct] of pcts) {
      const record = pdhTop.get(name) ?? { sum: 0, n: 0 };
      record.sum += pct;
      record.n += 1;
      pdhTop.set(name, record);
    }
  }
  const topConsumers = [...pdhTop.entries()]
    .map(([name, record]) => ({ name, meanPct: round(record.sum / record.n, 3) }))
    .sort((left, right) => right.meanPct - left.meanPct)
    .slice(0, 5);

  const perProcess = [...perPid.values()]
    .filter((record) => PRODUCT_ROLES.has(record.role) || record.role === 'sampler')
    .map((record) => {
      const entry = stats(record.series);
      return {
        name: record.name,
        pid: record.pid,
        role: record.role,
        meanPct: round(entry.mean ?? 0),
        medianPct: round(entry.median ?? 0),
        p95Pct: round(entry.p95 ?? 0),
        maxPct: round(entry.max ?? 0),
        cpuSec: round(record.totalSec, 3),
        observedSamples: record.series.length,
      };
    })
    .sort((left, right) => right.cpuSec - left.cpuSec);

  const productPs = [...perPid.values()].filter((record) => record.role === 'powershell');
  const nonProductPs = [...perPid.values()].filter((record) => record.role === 'nonproduct' && /^(?:powershell|pwsh)$/u.test(record.name));

  const output = {
    schema: 'perf.cpu-idle/1',
    label: args.label ?? null,
    startedAt: new Date(startedWallMs).toISOString(),
    endedAt: new Date(endedWallMs).toISOString(),
    durationMin: round((endedWallMs - startedWallMs) / 60000, 3),
    samples: usable.length,
    samplesTotal: samples.length,
    warmupSec: warmupS,
    sustainedSec: round(usableSec, 1),
    machine: {
      mean: round(machineStats.mean),
      median: round(machineStats.median),
      p95: round(machineStats.p95),
      min: round(machineStats.min),
      max: round(machineStats.max),
      source: 'pdh \\Processor(_Total)\\% Processor Time, 1 s',
      sysTimesMean: round(sysStats.mean),
      sysTimesMedian: round(sysStats.median),
    },
    product: {
      mean: round(productStats.mean),
      median: round(productStats.median),
      p95: round(productStats.p95),
      min: round(productStats.min),
      max: round(productStats.max),
      rule: 'product = machine_total - sum(non_product_live) - sampler_self',
      trackedMean: round(productTrackedStats.mean),
      trackedMedian: round(productTrackedStats.median),
    },
    perProcess,
    job: {
      name: jobName,
      mean: round(jobStats.mean),
      median: round(jobStats.median),
      p95: round(jobStats.p95),
      min: round(jobStats.min),
      max: round(jobStats.max),
      samples: jobStats.n,
      rule: 'job 口径 = QueryInformationJobObject(BasicAccounting) 的 (TotalUserTime+TotalKernelTime) 增量 / Δt / ncpu；含已退出子进程，负载无关',
      source: 'Windows Job Object 会计',
      coreSeconds: round(sumJobCoreSec, 3),
      trackedCoreSeconds: round(sumTrackedProductCoreSec, 3),
      coverageErrorPct: jobCoverageErrorPct === null ? null : round(jobCoverageErrorPct, 2),
      shortLivedSharePct: shortLivedSharePct === null ? null : round(shortLivedSharePct, 2),
      breakawaySuspectedPct: breakawaySuspectedPct === null ? null : round(breakawaySuspectedPct, 2),
      coverageNote: 'shortLivedShare = (Job - 逐PID)/Job，短到抓不到的短命子进程占比；breakawaySuspected = (逐PID - Job)/Job，逐PID 有而 job 没有（breakaway/误分类）。',
      pidsInJobMean: jobPidSeries.length > 0 ? round(jobPidSeries.reduce((a, b) => a + b, 0) / jobPidSeries.length) : null,
      union: {
        mean: round(unionStats.mean),
        median: round(unionStats.median),
        p95: round(unionStats.p95),
        samples: unionStats.n,
        escapedMeanPct: round(escapedStats.mean),
        escapedMedianPct: round(escapedStats.median),
        escapedSharePct: sumUnionCoreSec > 0 ? round((sumEscapedCoreSec / sumUnionCoreSec) * 100, 2) : null,
        coreSeconds: round(sumUnionCoreSec, 3),
        rule: "并集口径 = Job 会计 + Σ(产品进程但不在 job 内)；WebView2 breakaway、被 CREATE_BREAKAWAY 搬出 job 的子进程都在这一层被补回。",
      },
    },
    jobAccounting: jobAccountingSummary,
    machineLoad: {
      meanPct: round(machineStats.mean),
      p95Pct: round(machineStats.p95),
      maxPct: round(machineStats.max),
      topConsumers,
      warned: machineStats.mean !== null && machineStats.mean > 40,
      note: '整机口径，仅作上下文。>40% 说明这台机器正被别的负载占用，绝对数字不可比，只能比"测法一致性"。',
    },
    residualPct: round(residualStats.mean),
    residualMedianPct: round(residualStats.median),
    unattributedPct: round((productStats.mean ?? 0) - (productTrackedStats.mean ?? 0)),
    samplerSelfPct: round(samplerStats.mean),
    coverageError: coverageError === null ? null : round(coverageError * 100, 2),
    coverageErrorUnit: 'percent: |sum(tracked process core-seconds) - pdh busy core-seconds| / pdh busy core-seconds',
    crossChecks: {
      pdhMean: round(machineStats.mean),
      sysTimesMean: round(sysStats.mean),
      sysTimesVsPdhRelPct: machineStats.mean !== null && sysStats.mean !== null && machineStats.mean > 0
        ? round((Math.abs(sysStats.mean - machineStats.mean) / machineStats.mean) * 100, 2)
        : null,
      accountedSumMeanPct: usableSec > 0 ? round((sumAccountedCoreSec / usableSec / ncpu) * 100) : null,
      accountedCoreSeconds: round(sumAccountedCoreSec, 3),
      pdhCoreSeconds: round(sumPdhCoreSec, 3),
      jobVsTracked: {
        jobCoreSeconds: round(sumJobCoreSec, 3),
        trackedProductCoreSeconds: round(sumTrackedProductCoreSec, 3),
        relDiffPct: jobCoverageErrorPct === null ? null : round(jobCoverageErrorPct, 2),
      },
    },
    attribution,
    breakdown: {
      nonProductMean: round(nonProductStats.mean),
      unknownMean: round(unknownStats.mean),
      shellMean: round(stats(usable.map((sample) => sample.shellPct)).mean),
      daemonMean: round(stats(usable.map((sample) => sample.daemonPct)).mean),
      webviewMean: round(stats(usable.map((sample) => sample.webviewPct)).mean),
      powershellMean: round(stats(usable.map((sample) => sample.powershellPct)).mean),
      otherProductMean: round(stats(usable.map((sample) => sample.otherProductPct)).mean),
      contaminantMean: round(stats(usable.map((sample) => sample.contaminantPct)).mean),
      conhostMean: round(stats(usable.map((sample) => sample.conhostPct)).mean),
    },
    processDiscovery: {
      declaredRoots: [...roots],
      productProcessesSeen: discovered.product.size,
      nonProductProcessesSeen: discovered.nonProduct.size,
      productPowershellSeen: productPs.length,
      productPowershellSpawnLowerBound: productPs.length,
      nonProductPowershellSeen: nonProductPs.length,
      unknownRoles: [...unknownSeen].slice(0, 20),
    },
    scheduler: schedulerReport,
    configFingerprint: stack.configFingerprint === null ? { effectiveDefaults } : { ...stack.configFingerprint, effectiveDefaults },
    stateFingerprint: { start: fingerprintStart, end: fingerprintEnd },
    sampler: {
      script: 'tests/perf/fixtures/sampler.ps1',
      pid: samplerPid,
      intervalMs: args.intervalMs,
      pdhEveryMs: args.pdhEveryMs,
      cimEveryMs: args.cimEveryMs,
      lines: { s: raw.s, t: raw.t, c: raw.c },
      diagnostics: raw.x,
      exitCode: raw.exitCode,
      stderrTail: raw.stderr === null ? null : raw.stderr.slice(-2000),
    },
    machineInfo: { logicalCpus: ncpu, node: process.version, platform: process.platform },
    notes: [
      'product 使用残差归属；residualPct 是两条通路对不齐的量子（未被任何一次进程采样抓到的短命进程），按定义归产品。',
      'unattributedPct = product.mean − product.trackedMean，即产品里没被逐进程表解释掉的部分（含短命 powershell）。',
      'coverageError 是两条独立通路的实测偏差，不是恒等式；<10% 才视为测法有效。',
      '非产品短命进程的地板用 --baseline（栈收起）另跑一次量出来，写进证据分析与状态文件。',
    ],
    contaminants: [...contaminantSeen.values()].map((record) => ({ pid: record.pid, name: record.name, maxPct: round(record.maxPct, 3), samplesSeen: record.samples })).sort((a, b) => b.maxPct - a.maxPct).slice(0, 10),
    contended: contaminantSeen.size > 0,
    baselineRun: args.baseline,
  };

  ensureDir(dirname(resolve(args.out)));
  writeFileSync(resolve(args.out), `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  if (!args.quiet) {
    const pct = (value) => (value === null || value === undefined ? 'n/a' : `${value.toFixed(2)}%`);
    process.stdout.write([
      `label=${output.label ?? '-'} samples=${output.samples}/${output.samplesTotal} warmup=${warmupS}s sustained=${output.sustainedSec}s`,
      `JOB      mean=${pct(output.job.mean)} median=${pct(output.job.median)} p95=${pct(output.job.p95)} coverageErr=${output.job.coverageErrorPct}%`,
        "UNION    mean=" + pct(output.job.union.mean) + " median=" + pct(output.job.union.median) + " p95=" + pct(output.job.union.p95) + " escaped=" + pct(output.job.union.escapedMeanPct) + " (" + output.job.union.escapedSharePct + "% of product)",
      `machine  mean=${pct(output.machine.mean)} median=${pct(output.machine.median)} p95=${pct(output.machine.p95)} (sysTimes ${pct(output.machine.sysTimesMean)})`,
      `residual product mean=${pct(output.product.mean)} tracked=${pct(output.product.trackedMean)} residual=${pct(output.residualPct)}`,
      `samplerSelf=${pct(output.samplerSelfPct)} accountedCoverageErr=${output.coverageError}% contended=${output.contended}`,
      `out=${resolve(args.out)}`,
    ].join('\n') + '\n');
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`cpu-idle: fatal: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}

export { main, parseArgs, parseProcList };
