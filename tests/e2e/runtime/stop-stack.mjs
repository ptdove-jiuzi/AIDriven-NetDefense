#!/usr/bin/env node
/**
 * stop-stack.mjs — stop only the processes run-stack.mjs started (author PT-dove).
 *
 * The whole point of this file is the negative space: what it *refuses* to kill.
 *
 *   1. It reads `tests/e2e/runtime/.state/stack-state.json`; a process is a candidate only
 *      if the record says `owned: true`. A stack that run-stack.mjs merely *reused* is
 *      never touched (it belongs to whoever started it).
 *   2. PID 21980 is hard-denied by number (ACTIVE-NOTICE N-002: the 72h soak run).
 *      Separately, any command line matching longrun/soak patterns is hard-denied, so the
 *      protection survives the soak being restarted under a new PID.
 *   3. The recorded command line must still match the live one exactly. A recycled PID
 *      (same number, different program) is skipped, not killed.
 *   4. Every action is written to JSON evidence, including the refusals and why.
 *
 * Usage:
 *   node tests/e2e/runtime/stop-stack.mjs [--stacks data,mock] [--dry-run] [--json <path>]
 *
 * Exit 0 when every owned process is gone (or was never there). Exit 1 when a process we
 * own survived the stop, or when a stop was skipped for a suspicious reason.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import {
  DEFAULT_QA_ROOT,
  EVIDENCE_ROOT,
  PROTECTED_CMDLINE,
  PROTECTED_PIDS,
  describeProcesses,
  findListeningPid,
  fromRepo,
  isAlive,
  nowIso,
  parseArgs,
  readJsonFile,
  sleep,
  splitList,
  stateFileFor,
  writeJsonFile,
} from './lib/runtime.mjs';

function taskkill(pid) {
  const run = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  return {
    exitCode: run.status,
    stdout: (run.stdout ?? '').trim(),
    stderr: (run.stderr ?? '').trim(),
  };
}

/** Why a recorded PID must not be killed, or null when it is a legitimate target. */
function refusal(role, entry) {
  const pid = Number(entry.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { code: 'INVALID_PID', detail: String(entry.pid) };
  if (PROTECTED_PIDS.includes(pid)) return { code: 'PROTECTED_PID', detail: `PID ${pid} is on the hard-deny list (N-002 72h soak)` };
  const info = describeProcesses([pid]).get(pid);
  if (info === undefined) return { code: 'ALREADY_GONE', detail: `PID ${pid} is not running` };
  const commandLine = info.commandLine ?? '';
  if (PROTECTED_CMDLINE.test(commandLine)) {
    return { code: 'PROTECTED_CMDLINE', detail: `PID ${pid} looks like long-running evidence work: ${commandLine.slice(0, 160)}` };
  }
  const recorded = typeof entry.commandLine === 'string' ? entry.commandLine.trim() : '';
  if (recorded === '' || commandLine.trim() !== recorded) {
    return {
      code: 'IDENTITY_MISMATCH',
      detail: `PID ${pid} command line does not match the recorded one`
        + ` (recorded=${recorded.slice(0, 120) || '<none>'}, live=${commandLine.slice(0, 120)})`,
    };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    stacks: 'data,mock',
    json: null,
    'qa-root': DEFAULT_QA_ROOT,
    'dry-run': false,
    timeoutMs: 15000,
  }, new Set(['dry-run', 'help']));
  if (args.help === true) {
    process.stdout.write('usage: node tests/e2e/runtime/stop-stack.mjs [--stacks data,mock] [--qa-root <dir>]'
      + ' [--dry-run] [--json <path>]\n');
    return 0;
  }
  const dryRun = args['dry-run'] === true;
  const stackIds = splitList(String(args.stacks));
  const statePath = stateFileFor(String(args['qa-root']));
  const receipt = {
    schemaVersion: '1.0',
    generatedAt: nowIso(),
    tool: 'tests/e2e/runtime/stop-stack.mjs',
    dryRun,
    qaRoot: String(args['qa-root']),
    stateFile: statePath,
    requested: stackIds,
    stopped: [],
    refused: [],
    ports: {},
    pass: false,
    failures: [],
  };

  const state = readJsonFile(statePath, null);
  if (state === null || typeof state.stacks !== 'object' || state.stacks === null) {
    receipt.pass = true;
    receipt.note = `no runtime state file at ${statePath} — nothing to stop`;
    process.stdout.write(`stop-stack: no runtime state (${statePath}), nothing to stop\n`);
    writeJsonFile(join(EVIDENCE_ROOT, 'stop-receipt.json'), receipt);
    return 0;
  }

  const remaining = { ...state.stacks };
  for (const stackId of stackIds) {
    const entry = state.stacks[stackId];
    if (entry === undefined || entry === null) {
      receipt.note = `${receipt.note ?? ''} ${stackId}: not recorded;`.trim();
      continue;
    }
    remaining[stackId] = { ...entry };
    for (const role of ['daemon', 'host']) {
      const processRecord = entry[role];
      if (processRecord === undefined || processRecord === null) continue;
      const subject = { stack: stackId, role, pid: Number(processRecord.pid), port: processRecord.port ?? null };
      if (processRecord.owned !== true) {
        receipt.refused.push({ ...subject, code: 'NOT_OWNED', detail: 'run-stack.mjs reused this process; it is not ours to kill' });
        continue;
      }
      const blocked = refusal(role, processRecord);
      if (blocked !== null) {
        receipt.refused.push({ ...subject, code: blocked.code, detail: blocked.detail });
        if (blocked.code === 'ALREADY_GONE') delete remaining[stackId][role];
        continue;
      }
      if (dryRun) {
        receipt.stopped.push({ ...subject, dryRun: true, commandLine: processRecord.commandLine ?? null });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const kill = taskkill(subject.pid);
      // eslint-disable-next-line no-await-in-loop
      const gone = await new Promise((resolvePromise) => {
        const started = Date.now();
        const tick = () => {
          if (!isAlive(subject.pid)) return resolvePromise(true);
          if (Date.now() - started > Number(args.timeoutMs)) return resolvePromise(false);
          setTimeout(tick, 200);
        };
        tick();
      });
      receipt.stopped.push({
        ...subject,
        commandLine: processRecord.commandLine ?? null,
        taskkill: kill,
        gone,
      });
      if (!gone) receipt.failures.push(`${stackId}.${role}: PID ${subject.pid} survived taskkill`);
      else delete remaining[stackId][role];
    }
    // Verify the ports this stack owned are actually free again.
    for (const role of ['daemon', 'host']) {
      const port = entry[role]?.port;
      if (port === undefined || port === null) continue;
      // eslint-disable-next-line no-await-in-loop
      const stillListening = findListeningPid(port);
      receipt.ports[`${stackId}.${role}`] = { port, listeningPid: stillListening };
      if (stillListening !== null && !dryRun) {
        receipt.failures.push(`${stackId}.${role}: port ${port} still has a listener (pid ${stillListening})`);
      }
    }
    if (Object.keys(remaining[stackId]).length === 0) delete remaining[stackId];
  }

  if (!dryRun) {
    writeJsonFile(statePath, {
      schemaVersion: '1.0',
      updatedAt: nowIso(),
      node: state.node ?? null,
      qaRoot: state.qaRoot ?? null,
      stacks: remaining,
    });
  }
  receipt.pass = receipt.failures.length === 0;
  const jsonPath = args.json === null || args.json === true
    ? join(EVIDENCE_ROOT, 'stop-receipt.json')
    : fromRepo(String(args.json));
  writeJsonFile(jsonPath, receipt);
  const stamp = receipt.generatedAt.replace(/[:.]/gu, '-');
  writeJsonFile(join(EVIDENCE_ROOT, `stop-receipt-${stamp}.json`), receipt);

  for (const item of receipt.stopped) {
    process.stdout.write(`${dryRun ? 'would stop' : 'stopped'} ${item.stack}.${item.role} pid=${item.pid} port=${item.port}\n`);
  }
  for (const item of receipt.refused) {
    process.stdout.write(`refused ${item.stack}.${item.role} pid=${item.pid} [${item.code}] ${item.detail}\n`);
  }
  process.stdout.write(`receipt: ${jsonPath}\nresult: ${receipt.pass ? 'PASS' : 'FAIL'}\n`);
  return receipt.pass ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`stop-stack: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
