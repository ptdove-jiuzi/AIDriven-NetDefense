/**
 * progress.mjs — 长稳运行期的进展速读（每 6 小时检查点时用）。
 *
 * **只读**：只打开分片与状态文件，不碰 daemon、不加锁、不写任何被冻结的东西。
 * 它不判定任何结论——结论只由 `longrun.mjs` 结束时逐项判据给出。
 *
 * 用法：
 *   node tests/soak/progress.mjs --run-dir D:/AIUSE/_soak-run/2026-11-04-72h
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * 读分片里的采样与小时汇总。
 *
 * @param {string} logDir 日志目录。
 * @returns {{samples: object[], hours: object[]}} 内容。
 */
function readShards(logDir) {
  const samples = [];
  const hours = [];
  if (!fs.existsSync(logDir)) {
    return { samples, hours };
  }
  for (const name of fs.readdirSync(logDir).filter((item) => /^h\d{3}\.jsonl$/u.test(item)).sort()) {
    for (const line of fs.readFileSync(path.join(logDir, name), 'utf8').split('\n')) {
      if (line.length === 0) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (record.k === 's') {
          samples.push(record);
        } else if (record.k === 'h') {
          hours.push(record);
        }
      } catch {
        // 半行（崩溃残留）忽略：它不是结论，只是噪声。
      }
    }
  }
  samples.sort((left, right) => left.i - right.i);
  return { samples, hours };
}

/**
 * 中位数。
 *
 * @param {number[]} values 值。
 * @returns {number|null} 中位数。
 */
function median(values) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) {
    return null;
  }
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

/**
 * 主流程。
 *
 * @returns {number} 退出码（0 = 读到了；1 = 读不到）。
 */
function main() {
  const argv = process.argv.slice(2);
  let runDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run-dir') {
      runDir = argv[index + 1];
      index += 1;
    }
  }
  if (runDir === null) {
    process.stderr.write('progress: --run-dir is required\n');
    return 1;
  }
  const statePath = path.join(runDir, 'state', 'state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    process.stderr.write(`progress: cannot read ${statePath} (${error.message})\n`);
    return 1;
  }
  const { samples, hours } = readShards(path.join(runDir, 'logs'));
  const plan = state.plan;
  const now = Date.now();
  const elapsedMin = (now - plan.started_at_ms) / 60000;
  const plannedMin = plan.hours * 60;
  const last = samples.length === 0 ? null : samples[samples.length - 1];
  const recent = samples.slice(-60);
  const lastHour = hours.length === 0 ? null : hours[hours.length - 1];

  process.stdout.write(`run_id      ${state.run_id}\n`);
  process.stdout.write(`status      ${state.status}\n`);
  process.stdout.write(`elapsed     ${elapsedMin.toFixed(1)} min / ${plannedMin.toFixed(0)} min `
    + `(${(elapsedMin / plannedMin * 100).toFixed(2)}%)\n`);
  process.stdout.write(`remaining   ${(plannedMin - elapsedMin).toFixed(1)} min\n`);
  process.stdout.write(`shards      ${hours.length} closed / ${new Set(samples.map((s) => s.hour)).size} with samples\n`);
  process.stdout.write(`samples     ${samples.length}（最近 60 点中位 RSS ${median(recent.map((s) => s.rss_bytes)) === null
    ? '—' : (median(recent.map((s) => s.rss_bytes)) / 1048576).toFixed(2)} MiB）\n`);
  if (last !== null) {
    process.stdout.write(`last sample t=+${(last.elapsed_s / 3600).toFixed(2)}h `
      + `rss=${(last.rss_bytes / 1048576).toFixed(2)} MiB events=${last.adj_events_received} `
      + `polls=${last.adj_polls} probe=${last.probe_latency_ms} ms health=${last.health_status}\n`);
    process.stdout.write(`progress    ${((elapsedMin / plannedMin) * 100).toFixed(2)}% `
      + `| 目标 ${plan.target_ev_per_sec} ev/s，达成 ${(last.adj_events_received / (elapsedMin * 60)).toFixed(3)} ev/s\n`);
  }
  if (lastHour !== null) {
    process.stdout.write(`last hour   h${lastHour.hour} samples=${lastHour.samples} `
      + `rss_median=${(lastHour.rss_bytes_median / 1048576).toFixed(2)} MiB `
      + `libuv=${lastHour.libuv_handles} freeze_changed=${lastHour.freeze_changed}\n`);
  }
  const drifts = hours.map((hour) => `h${hour.hour}:${(hour.rss_bytes_median / 1048576).toFixed(1)}`);
  if (drifts.length > 0) {
    process.stdout.write(`hourly RSS  ${drifts.join(' ')}\n`);
  }
  return 0;
}

process.exitCode = main();
