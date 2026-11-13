/**
 * run-all.mjs — one command that reproduces the whole INT-4 visual/a11y evidence set
 * (author PT-dove).
 *
 * It waits for the console build to stop moving (`apps/console-next/**` is edited by
 * parallel sessions while this suite runs), then runs the four measurements in order,
 * records the build fingerprint before/after, and writes `results/run-all.json`.
 *
 * Usage:
 *   node tests/e2e/visual/run-all.mjs [--wait-stable 60] [--stable-timeout 600]
 *
 * Every number in `evidence/ui2/visual/STATUS.md` is produced by this command.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESULTS,
  buildFingerprint,
  ensureDir,
  fingerprintDelta,
  parseArgs,
  recordBuild,
  sleep,
  writeJson,
} from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), { 'wait-stable': '60', 'stable-timeout': '600' });
const stableSeconds = Number(args['wait-stable']) || 60;
const stableTimeoutSeconds = Number(args['stable-timeout']) || 600;
const LOGS = ensureDir(join(RESULTS, 'logs'));

/** Wait until the build fingerprint has not changed for `stableSeconds`. */
async function waitForStableBuild() {
  const deadline = Date.now() + stableTimeoutSeconds * 1000;
  let previous = buildFingerprint();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(5000);
    const current = buildFingerprint();
    if (current.aggregate !== previous.aggregate) {
      previous = current;
      stableSince = Date.now();
      continue;
    }
    if ((Date.now() - stableSince) / 1000 >= stableSeconds) {
      return { build: current, waitedSeconds: Math.round((Date.now() - stableSince) / 1000) };
    }
  }
  return { build: buildFingerprint(), waitedSeconds: -1 };
}

const wait = await waitForStableBuild();
recordBuild(wait.build, 'run-all-stable');

const scripts = ['01-shots.mjs', '02-keyboard.mjs', '03-contrast.mjs', '04-table-5000.mjs'];
const runs = [];
for (const script of scripts) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [join(HERE, script)], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  const logPath = join(LOGS, script.replace(/\.mjs$/u, '.log'));
  writeFileSync(logPath, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  runs.push({
    script,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal ?? null,
    log: logPath,
    stdout: (result.stdout ?? '').slice(-4000),
    stderr: (result.stderr ?? '').slice(-4000),
  });
  process.stdout.write(`[run-all] ${script} exit=${result.status}\n`);
}

const buildAtEnd = buildFingerprint();
const delta = fingerprintDelta(wait.build, buildAtEnd);
const report = {
  task: 'INT-4 visual + a11y full run',
  author: 'PT-dove',
  startedAt: new Date().toISOString(),
  waitForStableBuild: { waitedSeconds: wait.waitedSeconds, build16: wait.build.aggregate16, fileCount: wait.build.fileCount },
  buildAtEnd: { aggregate16: buildAtEnd.aggregate16, fileCount: buildAtEnd.fileCount, maxMtimeIso: buildAtEnd.maxMtimeIso },
  buildMovedDuringRun: !delta.same,
  movedFiles: delta.changedFiles,
  runs,
};
writeJson(join(RESULTS, 'run-all.json'), report);

process.stdout.write(`${JSON.stringify({
  build16: wait.build.aggregate16,
  buildFileCount: wait.build.fileCount,
  buildMovedDuringRun: report.buildMovedDuringRun,
  movedFiles: report.movedFiles,
  runs: runs.map((entry) => ({ script: entry.script, exit: entry.status })),
  out: join(RESULTS, 'run-all.json'),
}, null, 2)}\n`);
