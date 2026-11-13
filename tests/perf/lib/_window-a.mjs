/**
 * _window-a.mjs — Window A（术前基线）一次性驱动：3×10 min 顺序测量。
 *
 * 为什么用驱动脚本而不是手敲三条命令：三条之间不能有人为间隙（间隙里栈空转，
 * 三轮状态不可比），而 driver 让三轮首尾紧接、共用同一套配置与同一 job。
 *
 * 用法：node tests/perf/lib/_window-a.mjs [--out-dir <dir>]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const STACK = 'D:/AIUSE/_perf/PERF-CPU/pre/stack-pre.json';
const OUT_DIR = 'D:/AIUSE/网络防御/docs/implementation/evidence/perf/measure/pre';
const LABELS = ['pre-a1', 'pre-a2', 'pre-a3'];

mkdirSync(OUT_DIR, { recursive: true });

const KEEP = /^(JOB|UNION|machine|residual|samplerSelf|out=|label=)/u;
const results = [];

for (const label of LABELS) {
  const startedAt = new Date().toISOString();
  process.stdout.write(`\n=== ${label} start ${startedAt}\n`);
  const run = spawnSync(
    process.execPath,
    [
      'tests/perf/cpu-idle.mjs',
      '--seconds', '600',
      '--warmup-s', '0',
      '--stack-state', STACK,
      '--label', label,
      '--out', `${OUT_DIR}/${label}.json`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: 'D:/AIUSE/网络防御' },
  );
  const kiln = (run.stdout ?? '').split('\n').filter((line) => KEEP.test(line));
  process.stdout.write(`${kiln.join('\n')}\n`);
  if (run.status !== 0) {
    process.stdout.write(`!! ${label} FAILED status=${run.status}\n${(run.stderr ?? '').slice(-2000)}\n`);
  }
  results.push({ label, startedAt, endedAt: new Date().toISOString(), status: run.status });
}

process.stdout.write(`\n=== WINDOW-A DONE ${new Date().toISOString()}\n`);
for (const row of results) process.stdout.write(`${row.label} status=${row.status} ${row.startedAt} -> ${row.endedAt}\n`);
