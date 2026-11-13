/**
 * _window-a-report.mjs — 把 Window A 的三份 JSON + 功能探针 JSON 汇总成回执（含硬门判定）。
 *
 * 硬门（Lead 裁定）：
 *   1. 三次 `processesCreatedDelta` 偏差 ≤20%，否则判"三次不是同一状态"，必须重跑；
 *   2. 三次 `job.median` 偏差 ≤15%（辅助门，仅提示不判死）。
 *
 * 用法：node tests/perf/lib/_window-a-report.mjs [--dir <evidence-dir>]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv.includes('--dir')
  ? process.argv[process.argv.indexOf('--dir') + 1]
  : 'D:/AIUSE/网络防御/docs/implementation/evidence/perf/measure/pre';

const LABELS = ['pre-a1', 'pre-a2', 'pre-a3'];
const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const spreadPct = (values) => {
  const usable = values.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length < 2) return null;
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  return ((max - min) / min) * 100;
};

const rows = [];
for (const label of LABELS) {
  const path = join(DIR, `${label}.json`);
  if (!existsSync(path)) {
    rows.push({ label, missing: true, path });
    continue;
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  rows.push({
    label,
    path,
    minutes: Number.isFinite(data.sustainedSec) ? data.sustainedSec / 60 : (data.durationMin ?? null),
    job: data.job ?? null,
    union: data.job?.union ?? null,
    accounting: data.jobAccounting ?? null,
    machine: data.machineLoad ?? null,
    breakdown: data.breakdown ?? null,
    attribution: data.attribution ?? null,
    scheduler: data.scheduler ?? null,
    coverageErrorPct: data.job?.coverageErrorPct ?? null,
    contaminants: data.contaminants ?? [],
    contended: data.contended ?? null,
    sourcesDegraded: (data.stateFingerprint?.end?.status?.sources ?? []).filter((source) => ['unavailable', 'degraded', 'error', 'failed'].includes(source.lifecycle)),
    configFingerprint: data.configFingerprint ?? null,
    escapedProductPct: data.job?.union?.escapedMeanPct ?? null,
  });
}

const complete = rows.filter((row) => row.missing !== true);
const createdSeries = complete.map((row) => row.accounting?.totalProcessesCreatedDelta ?? null);
const medianSeries = complete.map((row) => row.job?.median ?? null);
const createdSpread = spreadPct(createdSeries);
const medianSpread = spreadPct(medianSeries);

const line = (row) => {
  if (row.missing === true) return `| ${row.label} | 缺失 | - | - | - | - | - | - | - |`;
  const job = row.job ?? {};
  const acct = row.accounting ?? {};
  const machine = row.machine ?? {};
  return [
    `| ${row.label}`,
    `${round(job.mean)}%`,
    `${round(job.median)}%`,
    `${round(job.p95)}%`,
    `${round(row.union?.mean)}%`,
    `${round(acct.processesCreatedPerMinute, 1)}/min`,
    `${acct.totalProcessesCreatedDelta ?? '-'}`,
    `${round(machine.meanPct)}%`,
    `${round(row.coverageErrorPct, 1)}% |`,
  ].join(' | ');
};

const out = [];
out.push('## Window A 汇总（术前冻结树，默认 tick，Job 会计口径）');
out.push('');
out.push('| 轮次 | job mean | job median | job p95 | union mean | 新建进程/分 | 新建进程总数 | 机器负载 | Job 覆盖误差 |');
out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) out.push(line(row));
out.push('');
out.push(`**硬门（ΔTotalProcesses 三轮偏差 ≤20%）**：实测偏差 **${createdSpread === null ? 'n/a' : `${round(createdSpread, 1)}%`}** → ${createdSpread === null ? '样本不足' : (createdSpread <= 20 ? '通过 ✅' : '不通过 ❌ 需重跑')}`);
out.push(`**辅助门（job.median 三轮偏差 ≤15%）**：实测偏差 **${medianSpread === null ? 'n/a' : `${round(medianSpread, 1)}%`}** → ${medianSpread === null ? '样本不足' : (medianSpread <= 15 ? '通过 ✅' : '超限（仅提示，非硬门）⚠️')}`);
out.push('');
for (const row of complete) {
  const acct = row.accounting ?? {};
  const byImage = acct.processesCreatedByImage ?? {};
  const powershell = byImage['powershell.exe'] ?? byImage.powershell ?? null;
  const conhost = byImage['conhost.exe'] ?? byImage.conhost ?? null;
  out.push(`### ${row.label}（${round(row.minutes, 1)} min 可用窗口）`);
  out.push(`- job：mean **${round(row.job?.mean)}%** / median **${round(row.job?.median)}%** / p95 **${round(row.job?.p95)}%** / max ${round(row.job?.max)}%`);
  out.push(`- union（并集兜底）：mean ${round(row.union?.mean)}% / median ${round(row.union?.median)}% / escaped ${round(row.escapedProductPct)}%`);
  out.push(`- 新建进程：**${round(acct.processesCreatedPerMinute, 1)}/min**（${acct.totalProcessesCreatedDelta ?? '-'} 个），按镜像名 \`${JSON.stringify(byImage)}\``);
  out.push(`  - **powershell ${powershell ?? '未测到'} 次**（这才是"起了几次"；conhost ${conhost ?? 0} 个是伴生控制台宿主，不计入 spawn）`);
  out.push(`- 机器负载：mean ${round(row.machine?.meanPct)}% / p95 ${round(row.machine?.p95Pct)}%；top：${(row.machine?.topConsumers ?? []).slice(0, 3).map((item) => `${item.name} ${round(item.meanPct)}%`).join("、") || "-"}`);
  out.push(`- 污染：contended=${row.contended}，contaminants=${row.contaminants.length} 个${row.contaminants.length === 0 ? '' : `（${row.contaminants.map((item) => `${item.name}#${item.pid} 峰值${round(item.maxPct)}%`).join('；')}）`}`);
  out.push(`- Job 覆盖误差：${round(row.coverageErrorPct, 1)}%（= 逐 PID 抓不到的短命子进程占比，Job 口径正是为它而生）`);
  const polls = row.scheduler?.perSourcePollIntervalMs ?? [];
  if (polls.length > 0) {
    out.push(`- 逐源实测轮询间隔：${polls.map((item) => `${item.id.replace('windows.', '')} ${round(item.intervalMs / 1000, 2)}s`).join('、')}`);
  }
  const degraded = (row.sourcesDegraded ?? []).map((item) => `${item.id}=${item.lifecycle}${item.last_error_code === undefined ? '' : `(${item.last_error_code})`}`);
  out.push(`- 降级源：${degraded.length === 0 ? '无' : degraded.join('、')}`);
  out.push(`- 配置指纹：schedulerBlock=\`${row.configFingerprint?.schedulerBlock}\`，effectiveDefaults=\`${JSON.stringify(row.configFingerprint?.effectiveDefaults ?? null)}\`，rulesSha256=\`${String(row.configFingerprint?.rulesSha256 ?? '').slice(0, 16)}\``);
  const attribution = row.attribution ?? {};
  const measured = attribution.measured ?? {};
  out.push(`- 归因（实测锚定）：daemon ${round(measured.realDaemonPct)}% + mock daemon ${round(measured.mockDaemonPct)}% + 壳 ${round(measured.shellPct)}% + WebView2 ${round(measured.webviewPct)}% + PS 总量 **${round(attribution.powershellTotalPct)}%** = ${round(measured.jobTotalPct)}%（实测总量）`);
  const split = attribution.powershellSplit ?? {};
  out.push(`  - PS 拆分：权威 spawn ${split.authoritativeSpawnCount ?? split.spawnsSeen} 个（逐 PID 只见 ${split.spawnsSeen} 个），底噪 **${round(split.noisePct)}%**（占 PS 总量 ${round(split.noiseSharePct)}%，模型常数 ${split.modelSpawnCpuSec}s/spawn）+ cmdlet/执行 **${round(split.cmdletPct)}%**；未归因 ${round(attribution.unattributedPct)}%`);
  out.push('');
}

const probePath = join(DIR, 'pre-func-window-a.json');
if (existsSync(probePath)) {
  const probe = JSON.parse(readFileSync(probePath, 'utf8'));
  out.push('## 功能三数（同窗口，只读 SQLite）');
  out.push(`- 事件：**${probe.events?.total ?? "-"} 条 / ${round(probe.events?.perMinute, 1)} 条每分**（${(probe.events?.byType ?? []).map((item) => `${item.type} ${item.count}`).join("、")}）`);
  out.push(`- 告警：**${probe.alerts?.total ?? "-"} 条**（按规则：${JSON.stringify(probe.alerts?.byRule ?? null)}）`);
  out.push(`- 事件→告警时延（窗口内）：n=${probe.latency?.n ?? 0}，p50 ${round(probe.latency?.p50Ms, 1)}ms / **p95 ${round(probe.latency?.p95Ms, 1)}ms** / max ${round(probe.latency?.maxMs, 1)}ms`);
  out.push(`- 事件→告警时延（全历史，样本更大）：n=${probe.latencyAllTime?.n ?? 0}，p50 ${round(probe.latencyAllTime?.p50Ms, 1)}ms / **p95 ${round(probe.latencyAllTime?.p95Ms, 1)}ms** / max ${round(probe.latencyAllTime?.maxMs, 1)}ms`);
  out.push(`- P95 算法：\`${probe.p95Algorithm?.name}\`，样本数 ${probe.p95Algorithm?.sampleCount}，丢点策略：${probe.p95Algorithm?.dropPolicy}`);
  out.push('');
}

process.stdout.write(`${out.join('\n')}\n`);
