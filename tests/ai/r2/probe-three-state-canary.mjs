/**
 * probe-three-state-canary.mjs — P1-CLOSER round-2 · T2（agent-approval-r2）三态 canary 取证探针。
 *
 * 场景：Agent 请求"写 `%TEMP%\p1-close-2\agent\canary-*.txt`"，分别走 **拒绝 / 批准 / 超时** 三态。
 * 每态记录：canary 是否存在（开流前 / 提案后 / 决策后 / 收尾）、审批响应体的 `executed`/`reason`、
 * 审批注册表 size（提案后 / 决策后）、SSE tool 帧序列、日志级留痕行、持久化扫描命中。
 *
 * 前置条件：真 daemon API + 真审批注册表 + 本席位测试替身 host（真链路无 tool 帧，见 AGENT-001 ①）。
 * 正向腿（批准→真的执行写文件）在 0.0.1 **结构上不可能**：`apps/daemon/src/api/chat.js:829-836`
 * 明确 `executed:false reason:EXECUTION_DISABLED`（合同 §2.7 无执行器）。因此"批准也不写文件"
 * 是**结论**而不是用例失败；本探针把它写成 `positiveLeg: established=false`。
 *
 * 用法：node tests/ai/r2/probe-three-state-canary.mjs
 * 产物：`evidence/p1-close-2/agent/raw/three-state-canary.json`
 *
 * @author PT-dove
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CANARY_DIR, RAW_DIR, REPO, sha256File } from './lib/harness.mjs';
import { runCanaryState } from './lib/scenarios.mjs';

mkdirSync(RAW_DIR, { recursive: true });

/**
 * Every remaining `canary*` file in the canary directory (the control file is removed by the
 * harness, so a non-empty list here means something actually wrote a canary).
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
  seat: 'agent-approval-r2',
  task: 'task-2',
  stamp: new Date().toISOString(),
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
  why: '0.0.1 无执行器：批准后 approval 响应 executed:false / reason:EXECUTION_DISABLED（chat.js:829-836，合同 §2.7），因此没有"批准→写 canary"的正向腿可验；本探针只能证明三态都不写文件、且审批链本身按状态正确终止。',
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
