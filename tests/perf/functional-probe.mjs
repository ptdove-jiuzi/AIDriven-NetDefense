#!/usr/bin/env node
/**
 * functional-probe.mjs — PERF-CPU 的"产品还活着吗"功能基线探针（perf-measure 席位）。
 *
 * 只回答三个数（外加把它们钉死的上下文）：
 *   ① N 分钟内真采集到多少条事件、按类型分布、每分钟速率；
 *   ② 落地多少条告警（按规则/severity），以及"事件→告警"的命中比例；
 *   ③ 事件到告警**落库**的真实 P50/P95 时延 = `alert.created_at`（ISO）− `alert.first_seen_ms`，
 *      全部逐条实测，不做任何估算。
 *
 * 数据来源：daemon 的 SQLite 存储（只读打开，绝不写）＋ `/api/v1/status` 两次快照。
 * 二快照同时给出"当次运行的源超时/失败增量"（sourcesDegraded / timeoutStorm），
 * 这样才能解释术前"超时风暴"与术后"正常出数"之间的 CPU 差到底有多少是"少做无用功"。
 *
 * 用法：
 *   node tests/perf/functional-probe.mjs --minutes 5 --stack-state <stack.json> --out <json>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseArgs(argv) {
  const out = { minutes: 5, seconds: null, stackState: null, out: null, label: null, quiet: false, note: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (token === '--minutes') out.minutes = Number(next());
    else if (token === '--seconds') out.seconds = Number(next());
    else if (token === '--stack-state') out.stackState = next();
    else if (token === '--out') out.out = next();
    else if (token === '--label') out.label = next();
    else if (token === '--note') out.note = next();
    else if (token === '--quiet') out.quiet = true;
  }
  if (out.seconds === null) out.seconds = out.minutes * 60;
  return out;
}

function loadStack(path) {
  if (path === null || !existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return data;
}

function tokenFrom(state) {
  const file = state?.tokenFile ?? null;
  if (file === null || !existsSync(file)) return null;
  return readFileSync(file, 'utf8').trim();
}

async function statusSnapshot(state, token) {
  const port = state?.ports?.daemonPort ?? state?.daemonPort ?? null;
  if (port === null) return { ok: false, error: 'no daemon port in stack state' };
  const headers = token === null ? {} : { authorization: `Bearer ${token}` };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { headers });
    if (!response.ok) return { ok: false, httpStatus: response.status };
    const body = await response.json();
    const sources = Array.isArray(body?.scheduler?.sources) ? body.scheduler.sources : [];
    return {
      ok: true,
      capturedAtMs: Date.now(),
      health: body.health ?? null,
      lifecycle: body.lifecycle ?? null,
      mode: body.mode ?? null,
      sources: sources.map((source) => ({
        id: source.id,
        lifecycle: source.lifecycle,
        polls: source.polls ?? 0,
        events: source.events ?? 0,
        accepted: source.accepted ?? 0,
        failures: source.failures ?? 0,
        consecutive_failures: source.consecutive_failures ?? 0,
        last_error_code: source.last_error_code ?? null,
        dropped_events: source.dropped_events ?? 0,
      })),
      pipeline: body.pipeline ?? null,
      store: body.store ?? null,
      counters: body.counters ?? null,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 两次快照之间的逐源增量：polls/failures/events，以及"哪些源在超时"。 */
function sourceDeltas(before, after) {
  if (before?.ok !== true || after?.ok !== true) return null;
  const byId = new Map();
  for (const source of before.sources) byId.set(source.id, { id: source.id, polls: 0, events: 0, failures: 0, lastErrorCodeBefore: source.last_error_code, lifecycleBefore: source.lifecycle });
  const rows = [];
  for (const source of after.sources) {
    const previous = byId.get(source.id) ?? { polls: 0, events: 0, failures: 0, lastErrorCodeBefore: null, lifecycleBefore: null };
    rows.push({
      id: source.id,
      lifecycle: source.lifecycle,
      lifecycleBefore: previous.lifecycleBefore,
      pollsDelta: source.polls - previous.polls,
      eventsDelta: source.events - previous.events,
      failuresDelta: source.failures - previous.failures,
      lastErrorCode: source.last_error_code,
      consecutiveFailures: source.consecutive_failures,
    });
  }
  const failuresDelta = rows.reduce((acc, row) => acc + Math.max(0, row.failuresDelta), 0);
  return {
    perSource: rows,
    pollsDelta: rows.reduce((acc, row) => acc + Math.max(0, row.pollsDelta), 0),
    eventsDelta: rows.reduce((acc, row) => acc + Math.max(0, row.eventsDelta), 0),
    failuresDelta,
    sourcesTimedOut: rows.filter((row) => row.lastErrorCode === 'SOURCE_TIMEOUT').map((row) => row.id),
    sourcesUnavailable: rows.filter((row) => row.lifecycle === 'unavailable' || row.lifecycle === 'degraded').map((row) => row.id),
  };
}

/** 只读打开 store；WAL 下并发读写是安全的。 */
function openStore(path) {
  if (path === null || !existsSync(path)) return { db: null, error: `store not found: ${path}` };
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return { db, error: null };
  } catch (error) {
    return { db: null, error: String(error?.message ?? error) };
  }
}

function stats(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return { n: 0, mean: null, median: null, p50: null, p95: null, max: null, min: null };
  const pick = (q) => finite[Math.min(finite.length - 1, Math.max(0, Math.ceil(q * finite.length) - 1))];
  const sum = finite.reduce((acc, value) => acc + value, 0);
  return { n: finite.length, mean: sum / finite.length, median: pick(0.5), p50: pick(0.5), p95: pick(0.95), max: finite[finite.length - 1], min: finite[0] };
}

const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : value);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stack = loadStack(args.stackState);
  const token = tokenFrom(stack);
  const sinceMs = Date.now();
  const sinceIso = new Date(sinceMs).toISOString();
  const windowSec = args.seconds;

  const before = await statusSnapshot(stack, token);
  if (!args.quiet) {
    process.stdout.write(`functional-probe: window ${windowSec}s from ${sinceIso} (status ${before.ok ? 'ok' : 'FAIL'})\n`);
    if (before.ok !== true) process.stdout.write(`  status start unavailable: ${before.error ?? before.httpStatus}\n`);
  }

  await new Promise((done) => setTimeout(done, windowSec * 1000));

  const endedMs = Date.now();
  const endedIso = new Date(endedMs).toISOString();
  const after = await statusSnapshot(stack, token);

  const storePath = stack?.storePath ?? null;
  const { db, error: storeError } = openStore(storePath);
  const result = {
    schema: 'perf.functional-probe/1',
    label: args.label ?? null,
    note: args.note ?? null,
    window: { startedAt: new Date(sinceMs).toISOString(), endedAt: endedIso, seconds: round((endedMs - sinceMs) / 1000, 1) },
    stack: stack === null ? null : { tag: stack.tag ?? null, root: stack.root ?? null, jobName: stack.jobName ?? null, daemonPort: stack.ports?.daemonPort ?? null },
    events: null,
    alerts: null,
    findings: null,
    latency: null,
    sources: null,
    sourcesDegraded: null,
    timeoutStorm: null,
    stateFingerprint: { start: before, end: after },
    store: { path: storePath, error: storeError },
    errors: [],
  };

  if (db !== null) {
    try {
      const events = db.prepare('SELECT type, COUNT(*) AS n FROM telemetry_event WHERE received_at_ms >= ? GROUP BY type ORDER BY n DESC').all(sinceMs);
      const eventTotal = events.reduce((acc, row) => acc + Number(row.n), 0);
      const observedOnly = db.prepare('SELECT COUNT(*) AS n FROM telemetry_event WHERE observed_at_ms >= ?').get(sinceMs);
      const eventsAll = db.prepare('SELECT COUNT(*) AS n FROM telemetry_event').get();
      result.events = {
        total: eventTotal,
        byType: events.map((row) => ({ type: row.type, count: Number(row.n) })),
        perMinute: round((eventTotal / windowSec) * 60, 2),
        observedInWindow: Number(observedOnly.n),
        storeTotalAllTime: Number(eventsAll.n),
        note: 'total 用 received_at_ms（落库时间）落在窗口内；observedInWindow 用 observed_at_ms（采集时间）',
      };

      const alertRows = db.prepare('SELECT alert_id, rule_id, severity, first_seen_ms, created_at, status FROM alert WHERE created_at >= ?').all(sinceIso);
      const alertsAll = db.prepare('SELECT COUNT(*) AS n FROM alert').get();
      const latencies = [];
      const perAlert = [];
      for (const row of alertRows) {
        const createdMs = Date.parse(row.created_at);
        const latencyMs = Number.isFinite(createdMs) ? createdMs - Number(row.first_seen_ms) : null;
        if (latencyMs !== null) latencies.push(latencyMs);
        perAlert.push({
          alertId: row.alert_id,
          ruleId: row.rule_id,
          severity: row.severity,
          status: row.status,
          firstSeenMs: Number(row.first_seen_ms),
          createdAt: row.created_at,
          latencyMs,
        });
      }
      const byRule = new Map();
      const bySeverity = new Map();
      for (const row of alertRows) {
        byRule.set(row.rule_id, (byRule.get(row.rule_id) ?? 0) + 1);
        bySeverity.set(row.severity, (bySeverity.get(row.severity) ?? 0) + 1);
      }
      result.alerts = {
        total: alertRows.length,
        byRule: [...byRule.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count),
        bySeverity: [...bySeverity.entries()].map(([severity, count]) => ({ severity, count })),
        storeTotalAllTime: Number(alertsAll.n),
        perMinute: round((alertRows.length / windowSec) * 60, 2),
        alertsPer1000Events: eventTotal > 0 ? round((alertRows.length / eventTotal) * 1000, 2) : null,
      };
      const latencyStats = stats(latencies);
      result.latency = {
        n: latencyStats.n,
        p50Ms: round(latencyStats.p50, 1),
        p95Ms: round(latencyStats.p95, 1),
        meanMs: round(latencyStats.mean, 1),
        maxMs: round(latencyStats.max, 1),
        minMs: round(latencyStats.min, 1),
        formula: 'P95 = nearest-rank over (Date.parse(alert.created_at) - alert.first_seen_ms) for alerts written inside the window',
        samples: perAlert.slice(0, 50),
        allAlertLatencies: perAlert.map((entry) => entry.latencyMs).filter((value) => Number.isFinite(value)),
      };

      // 全量时延（不只窗口内）：pre 代码在 10 min 内可能一条告警都不写，
      // 三数里的 P95 若只有 0 个样本毫无意义，所以额外给"仓库里所有告警"的实测分布。
      const allAlertRows = db.prepare('SELECT alert_id, rule_id, severity, first_seen_ms, created_at FROM alert').all();
      const allLatencies = [];
      for (const row of allAlertRows) {
        const createdMs = Date.parse(row.created_at);
        if (Number.isFinite(createdMs)) allLatencies.push(createdMs - Number(row.first_seen_ms));
      }
      const allLatencyStats = stats(allLatencies);
      result.latencyAllTime = {
        alertCount: allAlertRows.length,
        n: allLatencyStats.n,
        p50Ms: round(allLatencyStats.p50, 1),
        p95Ms: round(allLatencyStats.p95, 1),
        maxMs: round(allLatencyStats.max, 1),
        minMs: round(allLatencyStats.min, 1),
        note: 'store 里**所有**告警的实测时延（不按窗口过滤）。Window A 若 10 min 内 0 告警，用这个当功能基线，并在报告里说明窗口内告警数为 0 的事实。',
      };
      const stackStartMs = stack?.startedAt ? Date.parse(stack.startedAt) : null;
      result.alertsSinceStackStart = Number.isFinite(stackStartMs)
        ? db.prepare('SELECT COUNT(*) AS n FROM alert WHERE created_at >= ?').get(new Date(stackStartMs).toISOString()).n
        : null;
      result.p95Algorithm = {
        name: 'nearest-rank',
        sampleCount: allLatencyStats.n,
        dropPolicy: 'created_at 无法解析(Number.isFinite=false)的告警丢弃并计数；同一告警只取一次；不做插值、不剔除长尾',
        definition: 'latency = Date.parse(alert.created_at) - alert.first_seen_ms（落库时刻 − 事件首次出现时刻）',
        rankFormula: 'p95 取升序第 ceil(0.95*n) 个（最小 1）；p50 同法',
      };

      const findings = db.prepare('SELECT COUNT(*) AS n FROM finding WHERE created_at >= ?').get(sinceIso);
      result.findings = { inWindow: Number(findings.n), note: 'findings 只作旁证，不是三个必报数字之一' };
    } catch (error) {
      result.errors.push(`store query failed: ${String(error?.message ?? error)}`);
    } finally {
      db.close();
    }
  } else {
    result.errors.push(storeError);
  }

  const deltas = sourceDeltas(before, after);
  if (deltas !== null) {
    const windowMin = (endedMs - sinceMs) / 60000;
    result.sources = { perSource: deltas.perSource, pollsDelta: deltas.pollsDelta, eventsDelta: deltas.eventsDelta };
    result.sourcesDegraded = {
      timedOut: deltas.sourcesTimedOut,
      notOk: deltas.sourcesUnavailable,
      degradedHealthReasons: after.health?.reasons ?? null,
    };
    result.timeoutStorm = {
      sourcesTimedOut: deltas.sourcesTimedOut,
      failuresDeltaTotal: deltas.failuresDelta,
      failuresPerMinute: windowMin > 0 ? round(deltas.failuresDelta / windowMin, 2) : null,
      pollsDelta: deltas.pollsDelta,
      note: 'failuresDelta 是两次 /api/v1/status 快照之间的失败增量；这是"超时风暴"的量化口径。',
    };
  } else {
    result.errors.push('status before/after unavailable; source deltas not computed');
  }

  if (args.out !== null) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  if (!args.quiet) {
    const fmt = (value) => (value === null || value === undefined ? 'n/a' : String(value));
    process.stdout.write([
      `events   total=${fmt(result.events?.total)} /min=${fmt(result.events?.perMinute)} types=${result.events?.byType?.map((row) => `${row.type}:${row.count}`).join(' ') ?? 'n/a'}`,
      `alerts   total=${fmt(result.alerts?.total)} byRule=${result.alerts?.byRule?.map((row) => `${row.ruleId}:${row.count}`).join(' ') ?? 'n/a'}`,
      `latency  n=${fmt(result.latency?.n)} p50=${fmt(result.latency?.p50Ms)}ms p95=${fmt(result.latency?.p95Ms)}ms max=${fmt(result.latency?.maxMs)}ms`,
      `sources  polls+=${fmt(result.sources?.pollsDelta)} failures+=${fmt(result.timeoutStorm?.failuresDeltaTotal)} timedOut=[${result.timeoutStorm?.sourcesTimedOut?.join(',') ?? ''}]`,
      `out=${args.out === null ? '(not written)' : resolve(args.out)}`,
    ].join('\n') + '\n');
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`functional-probe: ${error?.stack ?? error}\n`);
  process.exit(1);
});
