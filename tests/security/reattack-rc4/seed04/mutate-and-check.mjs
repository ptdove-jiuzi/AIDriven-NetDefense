#!/usr/bin/env node
/**
 * mutate-and-check.mjs — SEED-04 part C: prove the criteria are not vacuous.
 *
 * Every mutation is applied to a **backup-protected** single line of the product source
 * (`apps/daemon/src/daemon.js`), run through the real daemon, and then reverted. The
 * three sha256 values (original / mutated / restored) are recorded, and the restored file
 * must be byte-identical to the original before this script reports success.
 *
 *   M1  daemon.js sourceStatusView: `return { ...row, lifecycle: outcome.state }`
 *       → `return row`  (projects the scheduler's stale `ok` for a zero-event poll:
 *       re-creates the old "0 条却 ok" defect). Criterion A3 must turn RED.
 *       Control: the same fixture **without** the mutation must be GREEN, which proves the
 *       red is caused by the removed projection, not by the fixture.
 *   M2  daemon.js observeStoreWrites: `rejection.count += 1` → `+= 0`
 *       (store rejections happen and are logged, but the counter stays 0).
 *       Criterion B1 must turn RED (kind=COUNTER_ZERO).
 *   M3  fixture-only (no product change): a source that stops emitting after two events.
 *       Criterion A1 (store.events must keep growing) must turn RED.
 *
 * Nothing may stay mutated: after every run the file is restored from the backup and the
 * sha256 is compared against the original.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const PYTHON = process.env.SEED04_PYTHON ?? 'D:\\Python311\\python.exe';
const PORT = 19512;
const DURATION_S = 45;

const args = { outdir: null, workdir: null, port: PORT, durationS: DURATION_S };
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  const next = () => process.argv[index + 1];
  if (token === '--outdir') { args.outdir = next(); index += 1; }
  else if (token === '--workdir') { args.workdir = next(); index += 1; }
  else if (token === '--port') { args.port = Number(next()); index += 1; }
  else if (token === '--duration-s') { args.durationS = Number(next()); index += 1; }
  else throw new Error(`unknown argument: ${token}`);
}
if (args.outdir === null || args.workdir === null) {
  throw new Error('--outdir and --workdir are required');
}

const TARGET = 'apps/daemon/src/daemon.js';
const targetPath = path.join(REPO, TARGET);
const backupDir = path.join(args.workdir, 'backup');
const backupPath = path.join(backupDir, 'daemon.js.orig');
const evidenceDir = path.resolve(args.outdir);
const rawDir = path.join(evidenceDir, 'MUTATIONS');
await fsp.mkdir(backupDir, { recursive: true });
await fsp.mkdir(rawDir, { recursive: true });

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runFixture({ mode, judge, label }) {
  const workdir = path.join(args.workdir, `run-${label}`);
  fs.rmSync(workdir, { recursive: true, force: true });
  const child = spawnSync(
    process.execPath,
    [
      path.join(HERE, 'run-fixture.mjs'),
      '--mode', mode,
      '--judge', judge,
      '--label', label,
      '--outdir', evidenceDir,
      '--workdir', workdir,
      '--port', String(args.port),
      '--duration-s', String(args.durationS),
      '--sample-interval-s', '5',
      '--note', `seed04 mutation/control run ${label}`,
    ],
    { encoding: 'utf8', timeout: (args.durationS + 180) * 1000, maxBuffer: 64 * 1024 * 1024 },
  );
  const rawLog = path.join(rawDir, `${label}.runner.log`);
  fs.writeFileSync(rawLog, `$ node run-fixture.mjs --mode ${mode} --judge ${judge} --label ${label}\nexit=${child.status}\n--- stdout ---\n${child.stdout ?? ''}\n--- stderr ---\n${child.stderr ?? ''}\n`, 'utf8');
  const resultPath = path.join(evidenceDir, `RESULT-${label}.json`);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  return { result, resultPath, runnerLog: rawLog, exit: child.status };
}

function criterionOf(result, criterionId) {
  const found = (result?.judge?.criteria ?? []).find((criterion) => criterion.id === criterionId);
  return found === null || found === undefined ? null : found;
}

function applyMutation({ find, replace }) {
  const original = fs.readFileSync(targetPath, 'utf8');
  const occurrences = original.split(find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`mutation target occurs ${occurrences} times, expected exactly 1: ${JSON.stringify(find)}`);
  }
  fs.writeFileSync(targetPath, original.replace(find, replace), 'utf8');
}

async function main() {
  const startedAt = new Date().toISOString();
  const originalHash = sha256(targetPath);
  fs.copyFileSync(targetPath, backupPath);
  const backupHash = sha256(backupPath);
  if (backupHash !== originalHash) {
    throw new Error(`backup hash mismatch: original=${originalHash} backup=${backupHash}`);
  }

  const mutations = [
    {
      id: 'M1',
      name: 'empty poll projected as ok (old "0 条却 ok" defect)',
      file: TARGET,
      find: '      return { ...row, lifecycle: outcome.state };',
      replace: '      return row; /* SEED04 M1 mutation: empty poll projects as scheduler ok */',
      run: { mode: 'legacy', judge: 'source', label: 'm1-empty-projected-ok' },
      expect: { criterion: 'A3.no_source_zero_events_but_ok', verdict: 'FAIL' },
    },
    {
      id: 'M2',
      name: 'store rejection counter frozen at 0',
      file: TARGET,
      find: '        rejection.count += 1;',
      replace: '        rejection.count += 0; /* SEED04 M2 mutation: counter never increments */',
      run: { mode: 'bubble', judge: 'b', label: 'm2-rejection-counter-off' },
      expect: { criterion: 'B1.rejected_by_store_counter', verdict: 'FAIL' },
    },
  ];

  const results = [];

  // Controls and fixture-only mutations (no product change needed).
  const controls = [
    {
      id: 'C1',
      name: 'control for M1: quiet source WITHOUT the mutation must be judged PASS',
      run: { mode: 'legacy', judge: 'source', label: 'c1-control-quiet-honest' },
      expect: { criterion: 'A3.no_source_zero_events_but_ok', verdict: 'PASS' },
    },
    {
      id: 'M3',
      name: 'fixture-only: event stream stalls, store.events stops growing',
      run: { mode: 'stall', judge: 'source', label: 'm3-stall-no-growth' },
      expect: { criterion: 'A1.store_events_monotonic_and_growing', verdict: 'FAIL' },
    },
  ];

  for (const entry of controls) {
    process.stdout.write(`\n=== ${entry.id} (no product mutation) ${entry.name}\n`);
    const execution = runFixture(entry.run);
    const criterion = criterionOf(execution.result, entry.expect.criterion);
    results.push({
      id: entry.id,
      kind: 'fixture-only',
      name: entry.name,
      run: entry.run,
      expected: entry.expect,
      actual: criterion === null ? null : { verdict: criterion.verdict, detail: criterion.detail },
      met: criterion !== null && criterion.verdict === entry.expect.verdict,
      result_file: path.basename(execution.resultPath),
      runner_log: path.relative(evidenceDir, execution.runnerLog),
      tree_unchanged: sha256(targetPath) === originalHash,
    });
    process.stdout.write(`    ${entry.expect.criterion}: expected ${entry.expect.verdict}, actual ${criterion?.verdict} -> ${results[results.length - 1].met ? 'OK' : 'MISMATCH'}\n`);
  }

  for (const mutation of mutations) {
    process.stdout.write(`\n=== ${mutation.id} ${mutation.name}\n`);
    const beforeHash = sha256(targetPath);
    applyMutation(mutation);
    const mutatedHash = sha256(targetPath);
    if (mutatedHash === beforeHash) {
      throw new Error(`${mutation.id}: mutation did not change the file hash`);
    }
    let execution = null;
    let failure = null;
    try {
      execution = runFixture(mutation.run);
    } catch (error) {
      failure = String(error?.stack ?? error);
    } finally {
      fs.copyFileSync(backupPath, targetPath);
    }
    const restoredHash = sha256(targetPath);
    const restored = restoredHash === originalHash;
    if (!restored) {
      throw new Error(`${mutation.id}: RESTORE FAILED (${restoredHash} != ${originalHash}) — stop and repair the tree`);
    }
    if (failure !== null) {
      throw new Error(`${mutation.id}: run failed: ${failure}`);
    }
    const criterion = criterionOf(execution.result, mutation.expect.criterion);
    results.push({
      id: mutation.id,
      kind: 'product-mutation',
      name: mutation.name,
      file: mutation.file,
      patch: { find: mutation.find, replace: mutation.replace },
      run: mutation.run,
      expected: mutation.expect,
      actual: criterion === null ? null : {
        verdict: criterion.verdict,
        detail: criterion.detail,
        kind: criterion.kind ?? null,
      },
      met: criterion !== null && criterion.verdict === mutation.expect.verdict,
      hashes: {
        original: originalHash,
        mutated: mutatedHash,
        restored: restoredHash,
        backup: backupHash,
        restored_byte_identical: restored,
      },
      result_file: path.basename(execution.resultPath),
      runner_log: path.relative(evidenceDir, execution.runnerLog),
    });
    process.stdout.write(`    restored=${restoredHash === originalHash} (${restoredHash})\n`);
    process.stdout.write(`    ${mutation.expect.criterion}: expected ${mutation.expect.verdict}, actual ${criterion?.verdict} -> ${results[results.length - 1].met ? 'OK' : 'MISMATCH'}\n`);
  }

  const finalHash = sha256(targetPath);
  const payload = {
    artifact: 'SEED-04/C mutation proof',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    target_file: TARGET,
    python: PYTHON,
    port: args.port,
    duration_s_per_run: args.durationS,
    original_sha256: originalHash,
    final_sha256: finalHash,
    tree_restored: finalHash === originalHash,
    backup_path: backupPath,
    backup_sha256: backupHash,
    all_expectations_met: results.every((entry) => entry.met && (entry.tree_unchanged !== false)),
    results,
  };
  fs.writeFileSync(path.join(evidenceDir, 'MUTATIONS.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nSEED04_MUTATIONS ${JSON.stringify({
    all_expectations_met: payload.all_expectations_met,
    tree_restored: payload.tree_restored,
    original_sha256: originalHash,
    final_sha256: finalHash,
    results: results.map((entry) => ({ id: entry.id, expected: entry.expected.verdict, actual: entry.actual?.verdict, met: entry.met })),
  })}\n`);
  return payload.all_expectations_met && payload.tree_restored ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`mutate-and-check failed: ${error?.stack ?? error}\n`);
  // Belt and braces: if anything escaped, try to restore from the backup before exiting.
  try {
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, targetPath);
      process.stderr.write(`restored ${TARGET} from backup as a safety net; sha256=${sha256(targetPath)}\n`);
    }
  } catch (restoreError) {
    process.stderr.write(`SAFETY RESTORE FAILED: ${restoreError?.message ?? restoreError}\n`);
  }
  process.exitCode = 3;
});
