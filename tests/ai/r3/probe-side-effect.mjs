/**
 * probe-side-effect.mjs — P1-RECOVERY-2 · agent-fix-r3 · B（副作用三组对照）。
 *
 * 场景：假 provider 的 `tool_calls` 里带**会写文件**的参数
 * （`{"path": "%TEMP%\\p1r2-side\\canary.txt", "content": "..."}`），
 * 走真 daemon API + 真审批注册表 + R2 替身 host（真链路红态下 tool 帧为 0，见 A 组与 RESULT.red_green）。
 *
 * 三组：
 *   C1 未审批/拒绝 → 文件**不存在**（负向）
 *   C2 批准        → 文件**仍不存在**（结构性：0.0.1 无执行器，approval 回 executed:false /
 *                    EXECUTION_DISABLED；这不是"审批门挡住了执行"的证据）
 *   C3 阳性对照    → 把 C1/C2 拿到的**同一份** tool_call 参数喂给 `tests/ai/r3/fake-executor.mjs`，
 *                    文件**必须出现**（证明 canary 有牙）
 *
 * 每组都留"前/后文件存在性 + 内容 sha256"。C3 写完取指纹后删除，避免污染下一次 C1。
 *
 * 用法：node tests/ai/r3/probe-side-effect.mjs
 * 产物：`evidence/p1-recovery/40-agent/raw/side-effect.json`
 *
 * @author PT-dove
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApprovalRegistry } from '../../../apps/daemon/src/api/chat.js';
import { openProposalStream, startToolHarness, toolEvents } from '../r2/lib/harness.mjs';
import { parseSseText } from '../../wp5-daemon/console-fixtures.mjs';
import { executeToolCall, SANDBOX_DIR } from './fake-executor.mjs';
import { RAW_DIR, REPO } from './replay/raw-dir.mjs';
import { sha256File } from '../r2/lib/harness.mjs';

mkdirSync(RAW_DIR, { recursive: true });

/** The one canary every group talks about. */
const CANARY = join(SANDBOX_DIR, 'canary.txt');
const MARKER = 'P1-RECOVERY-2-SIDE-EFFECT-CANARY';

/**
 * The first `tool` frame's **full** payload (name/arguments/requiresApproval included).
 *
 * @param {string} text Raw SSE text.
 * @returns {object|null} Payload.
 */
function firstToolPayload(text) {
  const event = parseSseText(text).events.find((entry) => entry.event === 'tool');
  return event === undefined ? null : event.data;
}

/**
 * Fingerprint of the canary file.
 *
 * @returns {{exists: boolean, sha256: string|null, bytes: number|null, content: string|null}} Fingerprint.
 */
function fingerprint() {
  if (!existsSync(CANARY)) {
    return { exists: false, sha256: null, bytes: null, content: null };
  }
  const bytes = readFileSync(CANARY);
  return {
    exists: true,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    content: bytes.toString('utf8').slice(0, 200),
  };
}

const staleAtStart = fingerprint();
// 上一次运行留下的 canary 会让 C1 变成假阴性：开始时先清干净（保留指纹作为登记）。
rmSync(CANARY, { force: true });
mkdirSync(SANDBOX_DIR, { recursive: true });

const results = {
  probe: 'side-effect',
  seat: 'agent-fix-r3',
  task: 'P1-RECOVERY-2 · B',
  stamp: new Date().toISOString(),
  canaryPath: CANARY,
  marker: MARKER,
  staleAtStart,
  precondition: {
    stack: '真 daemon API（server.js 路由）+ 真 chat.js 处理器 + 真 createApprovalRegistry',
    toolFrameSource: 'tests/ai/r2/stub-approval-host.mjs（测试替身；真链路红态 tool 帧为 0）',
    executor: '0.0.1 无执行器（chat.js:829-836 executed:false / EXECUTION_DISABLED，合同 §2.7）',
    chatJsSha256: sha256File(join(REPO, 'apps', 'daemon', 'src', 'api', 'chat.js')),
  },
  groups: {},
};

/**
 * Run one decision group (C1 deny / C2 approve).
 *
 * @param {'deny'|'approve'} decision Decision to send.
 * @param {string} label Group label.
 * @returns {Promise<object>} Group observation.
 */
async function runGroup(decision, label) {
  const before = fingerprint();
  const fixture = await startToolHarness({ label, mode: 'tool', callId: `call_${label}_1`, canaryPath: CANARY });
  const group = { label, decision, before, after: null, proposal: null, registry: {}, approval: null, toolStates: [] };
  let stream = null;
  try {
    stream = await openProposalStream(fixture.harness, fixture.sessionId);
    group.proposal = firstToolPayload(stream.chunks());
    group.proposalStates = toolEvents(stream.chunks());
    group.registry.beforeDecision = fixture.harness.approvals.size();
    group.afterProposal = fingerprint();

    const response = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: fixture.sessionId, callId: `call_${label}_1`, decision },
    });
    group.approval = {
      httpStatus: response.status,
      executed: response.body?.executed ?? null,
      reason: response.body?.reason ?? null,
      errorCode: response.body?.error?.code ?? null,
    };
    await stream.onData(
      (text) => text.includes(decision === 'deny' ? '"reason":"USER_DENIED"' : '"state":"approved"'),
      10_000,
    ).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    group.registry.afterDecision = fixture.harness.approvals.size();
    group.toolStates = toolEvents(stream.chunks()).map((entry) => entry.state);
    group.executedClaimInStream = stream.chunks().includes('"executed":true');
  } finally {
    if (stream !== null) stream.request.destroy();
    await fixture.close();
    group.after = fingerprint();
  }
  group.expectations = [
    { id: `${label}.beforeAbsent`, expected: false, actual: group.before.exists, pass: group.before.exists === false },
    { id: `${label}.afterAbsent`, expected: false, actual: group.after.exists, pass: group.after.exists === false },
    { id: `${label}.afterSha256`, expected: null, actual: group.after.sha256, pass: group.after.sha256 === null },
    { id: `${label}.proposalPath`, expected: CANARY, actual: group.proposal?.arguments?.path ?? null, pass: (group.proposal?.arguments?.path ?? null) === CANARY },
    { id: `${label}.registryBeforeDecision`, expected: 1, actual: group.registry.beforeDecision, pass: group.registry.beforeDecision === 1 },
    { id: `${label}.registryAfterDecision`, expected: 0, actual: group.registry.afterDecision, pass: group.registry.afterDecision === 0 },
    { id: `${label}.approvalHttpStatus`, expected: 200, actual: group.approval.httpStatus, pass: group.approval.httpStatus === 200 },
    { id: `${label}.approvalExecuted`, expected: false, actual: group.approval.executed, pass: group.approval.executed === false },
    { id: `${label}.approvalReason`, expected: 'EXECUTION_DISABLED', actual: group.approval.reason, pass: group.approval.reason === 'EXECUTION_DISABLED' },
    { id: `${label}.noExecutedClaim`, expected: false, actual: group.executedClaimInStream, pass: group.executedClaimInStream === false },
  ];
  return group;
}

// ------------------------------------------------------------------ C1 / C2
const c1 = await runGroup('deny', 'c1');
results.groups.c1 = c1;
const c2 = await runGroup('approve', 'c2');
results.groups.c2 = c2;

// ------------------------------------------------------------------ C3 positive control
// 用 C2（批准态）拿到的**同一份** tool_call 参数：`name` 与 `arguments` 逐字段原样交给假执行器。
const sameCall = c2.proposal === null
  ? null
  : { name: c2.proposal.name ?? null, arguments: c2.proposal.arguments ?? {} };
const expectedContent = typeof sameCall?.arguments?.content === 'string' ? sameCall.arguments.content : MARKER;
const c3Before = fingerprint();
const executed = sameCall === null
  ? { executed: false, path: null, exists: false, sha256: null, reason: 'NO_PROPOSAL_CAPTURED' }
  : executeToolCall(sameCall);
const c3After = fingerprint();
const c3 = {
  label: 'c3',
  note: '假执行器（tests/ai/r3/fake-executor.mjs）**测试替身**，不证明产品有执行器',
  sameToolCallArguments: sameCall,
  expectedContent,
  before: c3Before,
  executorResult: executed,
  after: c3After,
  expectations: [
    { id: 'c3.beforeAbsent', expected: false, actual: c3Before.exists, pass: c3Before.exists === false },
    { id: 'c3.fileAppeared', expected: true, actual: c3After.exists, pass: c3After.exists === true },
    { id: 'c3.sha256Recorded', expected: true, actual: typeof c3After.sha256 === 'string', pass: typeof c3After.sha256 === 'string' },
    { id: 'c3.contentMatchesProposal', expected: expectedContent, actual: (c3After.content ?? '').slice(0, expectedContent.length), pass: (c3After.content ?? '').startsWith(expectedContent) },
    { id: 'c3.samePathAsProposal', expected: CANARY, actual: executed.path ?? null, pass: (executed.path ?? '').toLowerCase() === CANARY.toLowerCase() },
  ],
};
results.groups.c3 = c3;

// 阳性对照仅用于证明"有牙"：留指纹后删文件，避免下一次 C1 被污染。
rmSync(CANARY, { force: true });
c3.afterCleanup = fingerprint();
c3.expectations.push({
  id: 'c3.cleanupRemoved', expected: false, actual: c3.afterCleanup.exists, pass: c3.afterCleanup.exists === false,
});

// ------------------------------------------------------------------ 汇总
const allRows = Object.values(results.groups).flatMap((group) => group.expectations);
results.totals = {
  groups: Object.keys(results.groups).length,
  expectations: allRows.length,
  pass: allRows.filter((row) => row.pass === true).length,
  fail: allRows.filter((row) => row.pass !== true).length,
};
results.verdict = {
  c1NotApprovedNoFile: c1.after.exists === false,
  c2ApprovedStillNoFile: c2.after.exists === false,
  c2Why: '0.0.1 无执行器：approval 只记录决策，回 executed:false / EXECUTION_DISABLED（结构性，不是审批门挡住的）',
  c3PositiveControlWroteFile: c3.after.exists === true,
  canaryHasTeeth: c3.after.exists === true && c1.after.exists === false,
  executorIsTestDoubleOnly: true,
};
// 审批注册表工厂在本文件里被真实引用一次，确保"真注册表"不是转述。
results.registryFactoryReferenced = typeof createApprovalRegistry === 'function';

const outFile = join(RAW_DIR, 'side-effect.json');
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  canary: CANARY,
  c1: { fileExists: c1.after.exists, sha256: c1.after.sha256, decision: c1.approval },
  c2: { fileExists: c2.after.exists, sha256: c2.after.sha256, decision: c2.approval },
  c3: { fileExists: c3.after.exists, sha256: c3.after.sha256, bytes: c3.after.bytes, cleanedUp: c3.afterCleanup.exists === false },
  totals: results.totals,
  verdict: results.verdict,
  rawFile: outFile,
}, null, 2));
process.exitCode = results.totals.fail === 0 ? 0 : 1;
