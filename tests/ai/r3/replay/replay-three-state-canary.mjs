/**
 * replay-three-state-canary.mjs — P1-RECOVERY-2 · agent-fix-r3 复跑三态 canary。
 *
 * 与 R2 `tests/ai/r2/probe-three-state-canary.mjs` **同一份场景实现**（`runCanaryState`），
 * 差别只有产物目录。canary 目录仍是 `%TEMP%\p1-close-2\agent\`（R2 同一路径，便于逐位对照）。
 *
 * 用法：node tests/ai/r3/replay/replay-three-state-canary.mjs
 *
 * @author PT-dove
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CANARY_DIR, REPO, sha256File } from '../../r2/lib/harness.mjs';
import { runCanaryState } from '../../r2/lib/scenarios.mjs';
import { RAW_DIR } from './raw-dir.mjs';

mkdirSync(RAW_DIR, { recursive: true });

/**
 * Every remaining `canary*` file in the canary directory.
 *
 * @returns {string[]} File names.
 */
function canaryFiles() {
  try {
    return readdirSync(CANARY_DIR).filter((name) => name.startsWith('canary'));
  } catch {
    return [];
  }
}

const results = {
  probe: 'three-state-canary',
  seat: 'agent-fix-r3',
  task: 'P1-RECOVERY-2 · A',
  stamp: new Date().toISOString(),
  provenance: {
    scenarioImplementation: 'tests/ai/r2/lib/scenarios.mjs#runCanaryState（原样引用，未改）',
    originalEntry: 'tests/ai/r2/probe-three-state-canary.mjs',
    onlyChange: 'RAW_DIR → evidence/p1-recovery/40-agent/raw',
  },
  canaryDir: CANARY_DIR,
  canaryFilesBefore: canaryFiles(),
  stubToolFrame: true,
  chatJsSha256: sha256File(join(REPO, 'apps', 'daemon', 'src', 'api', 'chat.js')),
  states: [],
};

for (const state of /** @type {const} */ (['deny', 'approve', 'timeout'])) {
  // Serial on purpose: one daemon stack at a time.
  // eslint-disable-next-line no-await-in-loop
  const observation = await runCanaryState(state);
  results.states.push({
    state: observation.state,
    canaryPath: observation.canaryPath,
    canaryPositiveControl: observation.canaryPositiveControl,
    canaryExists: observation.canaryExists,
    registrySize: observation.registrySize,
    approvalResponse: observation.approvalResponse,
    toolStates: observation.toolStates,
    toolEvents: observation.toolEvents,
    executedClaimInStream: observation.executedClaimInStream,
    logRecords: observation.logRecords,
    expiredLogLines: observation.expiredLogLines,
    persistent: observation.persistent,
    expectations: observation.expectations,
    canaryFilesAfter: canaryFiles(),
  });
  const failed = observation.expectations.filter((row) => row.pass !== true);
  console.log(`[${state}] ${observation.expectations.length - failed.length}/${observation.expectations.length} expectations pass${failed.length === 0 ? '' : ` — FAILED: ${failed.map((row) => row.id).join(', ')}`}`);
}

const byState = Object.fromEntries(results.states.map((entry) => [entry.state, entry]));
results.verdict = {
  denyCanaryCreated: byState.deny.canaryExists.atEnd,
  approveCanaryCreated: byState.approve.canaryExists.atEnd,
  timeoutCanaryCreated: byState.timeout.canaryExists.atEnd,
  allThreeCanariesAbsent: !byState.deny.canaryExists.atEnd && !byState.approve.canaryExists.atEnd && !byState.timeout.canaryExists.atEnd,
  denyExecuted: byState.deny.approvalResponse?.body?.executed ?? null,
  approveExecuted: byState.approve.approvalResponse?.body?.executed ?? null,
  approveReason: byState.approve.approvalResponse?.body?.reason ?? null,
  timeoutToolStates: byState.timeout.toolStates,
  pendingAfterDeny: byState.deny.registrySize.afterDecision,
  pendingAfterApprove: byState.approve.registrySize.afterDecision,
  pendingAfterTimeout: byState.timeout.registrySize.afterDecision,
  logLevelTraceLines: {
    deny: byState.deny.logRecords.length,
    approve: byState.approve.logRecords.length,
    timeout: byState.timeout.logRecords.length,
  },
  persistentAuditHits: {
    deny: byState.deny.persistent.hits.length,
    approve: byState.approve.persistent.hits.length,
    timeout: byState.timeout.persistent.hits.length,
  },
};
results.positiveLeg = {
  established: false,
  why: '0.0.1 无执行器：批准后 approval 响应 executed:false / reason:EXECUTION_DISABLED（chat.js:829-836，合同 §2.7），因此没有“批准→写 canary”的正向腿可验；本探针只能证明三态都不写文件、且审批链本身按状态正确终止。',
  evidenceAnchor: 'apps/daemon/src/api/chat.js:829-836',
};
results.totals = {
  states: results.states.length,
  expectations: results.states.reduce((sum, entry) => sum + entry.expectations.length, 0),
  pass: results.states.reduce((sum, entry) => sum + entry.expectations.filter((row) => row.pass === true).length, 0),
  fail: results.states.reduce((sum, entry) => sum + entry.expectations.filter((row) => row.pass !== true).length, 0),
};

const outFile = join(RAW_DIR, 'three-state-canary.json');
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ verdict: results.verdict, positiveLeg: results.positiveLeg.established, totals: results.totals, rawFile: outFile }, null, 2));
process.exitCode = results.totals.fail === 0 ? 0 : 1;
