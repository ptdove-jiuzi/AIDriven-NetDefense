/**
 * _recompute-split.mjs — 归档后重算"PS 底噪/执行"拆分，改用**权威 spawn 数**。
 *
 * 为什么允许归档后重算：拆分只是把**已实测**的 `powershellTotalPct` 按一个模型常数分配比例，
 * 唯一改动的输入是 `spawnsSeen`（逐 PID 只能看到活着的进程 → 低估）。
 * 权威 spawn 数 = `jobAccounting.processesCreatedByImage['powershell.exe']`（job PID 列表新增计数），
 * 所以在拿不到"每源 spawn 详情"的情况下，用权威数才是正确口径。
 *
 * 重算时把两个输入都写回 JSON（`spawnsSeen` 保留原值、新增 `authoritativeSpawnCount`），
 * 并写 `recomputedAt` / `recomputeReason`，保证可审计、可复算。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv.includes('--dir')
  ? process.argv[process.argv.indexOf('--dir') + 1]
  : (process.env.PERF_OUT || 'evidence/perf/measure/pre');
const LABELS = ['pre-a1', 'pre-a2', 'pre-a3'];
const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

for (const label of LABELS) {
  const path = join(DIR, `${label}.json`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const byImage = data.jobAccounting?.processesCreatedByImage ?? {};
  const authoritative = byImage['powershell.exe'] ?? byImage.powershell ?? null;
  const totalPct = data.attribution?.powershellTotalPct;
  const ncpu = data.machineInfo?.logicalCpus ?? 12;
  const sustainedSec = data.sustainedSec ?? data.durationMin * 60;
  const modelSec = data.attribution?.powershellSplit?.modelSpawnCpuSec ?? 0.67969;
  if (!Number.isFinite(totalPct) || !Number.isFinite(authoritative) || !Number.isFinite(sustainedSec)) {
    process.stdout.write(`${label}: 跳过（缺少 powershellTotalPct / authoritativeSpawnCount / sustainedSec）\n`);
    continue;
  }
  const psCoreSec = (totalPct / 100) * ncpu * sustainedSec;
  const share = Math.min(1, (authoritative * modelSec) / psCoreSec);
  data.attribution.powershellSplit = {
    ...data.attribution.powershellSplit,
    authoritativeSpawnCount: authoritative,
    spawnCountUsedForModel: authoritative,
    modelSpawnCpuSec: modelSec,
    measuredPowershellCoreSec: round(psCoreSec, 3),
    noiseSharePct: round(share * 100, 2),
    noisePct: round(totalPct * share),
    cmdletPct: round(totalPct * (1 - share)),
    recomputeReason:
      '归档后重算：拆分比例的输入 spawn 数改用权威值 processesCreatedByImage["powershell.exe"]（逐 PID 只能看到活着的进程，会低估）；powershellTotalPct 与所有实测总量保持不变。',
  };
  data.attribution.recomputedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(
    `${label}: powershell=${authoritative} spawns, PS 总量 ${round(totalPct)}% = 底噪 ${round(totalPct * share)}% (${round(share * 100, 1)}%) + 执行 ${round(totalPct * (1 - share))}%\n`,
  );
}
