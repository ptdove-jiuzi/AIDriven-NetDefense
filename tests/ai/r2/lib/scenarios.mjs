/**
 * scenarios.mjs — P1-CLOSER round-2 · T2（agent-approval-r2）四条否定用例 + 三态 canary 的**唯一**场景实现。
 *
 * 为什么单独抽出来：同一份场景既要给 node:test 门禁用（`tests/wp5-daemon/ai-r2-negatives.test.js`），
 * 又要给取证探针用（`tests/ai/r2/probe-negatives.mjs`、`probe-three-state-canary.mjs`）。
 * 两处共用同一实现 ⇒ 证据里的数字与门禁断言不会漂移。
 *
 * 每个场景的返回值都含 `expectations: [{id, expected, actual, pass}]`；测试只对 `pass` 断言，
 * 变异分析（`probe-mutations.mjs`）可以逐条指出"哪条 expectation 会因为删掉哪个守卫而变 false"。
 *
 * **前置条件（每个 observation 都带 `stubToolFrame: true`）**：
 *   被测对象 = 真 daemon API（server.js 路由）+ 真 `apps/daemon/src/api/chat.js` 处理器 + 真审批注册表；
 *   触发源   = 本席位的测试替身 host（真链路上 `tool_calls` 被 chat-transport 丢弃，见 AGENT-001 ①）。
 *   ⇒ 这些结论证明的是"**审批链在收到 tool 提案后的行为**"，不是"真 provider 链路能产出审批"。
 *
 * @author PT-dove
 */

import { existsSync, rmSync } from 'node:fs';

import { createApprovalRegistry } from '../../../../apps/daemon/src/api/chat.js';
import { waitFor } from '../../../wp5-daemon/console-fixtures.mjs';
import {
  CANARY_DIR,
  countOf,
  ensureCanaryDir,
  findPersistentRecords,
  observeCancelSession,
  openProposalStream,
  sleep,
  startToolHarness,
  toolEvents,
} from './harness.mjs';

/** The callId every stub proposal uses unless a scenario overrides it. */
export const CALL_ID = 'call_r2_1';

/**
 * Build an expectation row.
 *
 * @param {string} id Stable id (mutations cite it).
 * @param {unknown} expected Expected value (JSON-comparable).
 * @param {unknown} actual Observed value.
 * @returns {{id: string, expected: unknown, actual: unknown, pass: boolean}} Row.
 */
function expectRow(id, expected, actual) {
  return { id, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) };
}

/**
 * `approval recorded` log lines of a capture logger, parsed.
 *
 * @param {{lines: () => string[]}} capture Capture logger.
 * @returns {{raw: string, record: object|null}[]} Parsed lines.
 */
function approvalRecordLines(capture) {
  return capture.lines()
    .filter((line) => line.includes('"msg":"approval recorded"'))
    .map((line) => {
      try {
        return { raw: line.trim(), record: JSON.parse(line) };
      } catch {
        return { raw: line.trim(), record: null };
      }
    });
}

/**
 * N1 — 未审批执行被拒且**无副作用**。
 *
 * @returns {Promise<object>} Observation with expectations.
 */
export async function runN1() {
  const canaryPositiveControl = ensureCanaryDir();
  const fixture = await startToolHarness({ label: 'n1', mode: 'tool', callId: CALL_ID });
  const observation = {
    id: 'N1',
    title: '未审批执行被拒且无副作用（决策前 registry size / canary；流关闭→cancelSession denied/STREAM_CLOSED）',
    stubToolFrame: true,
    canaryPath: fixture.canary,
    canaryPositiveControl,
    sessionId: fixture.sessionId,
  };
  let stream = null;
  const startedMs = Date.now();
  try {
    stream = await openProposalStream(fixture.harness, fixture.sessionId);
    const proposals = toolEvents(stream.chunks());
    observation.proposalFrames = proposals.length;
    observation.proposal = proposals[0] ?? null;
    observation.registrySizeBeforeDecision = fixture.harness.approvals.size();
    observation.canaryBeforeDecision = existsSync(fixture.canary);
    observation.executedClaimBeforeDecision = stream.chunks().includes('"executed":true');
    observation.resultStateFramesBeforeDecision = proposals.filter((entry) => entry.state === 'result').length;

    // A call id that was never registered cannot be "approved": the handler must refuse it.
    const unknown = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: fixture.sessionId, callId: 'call_r2_unknown', decision: 'approve' },
    });
    observation.unknownCallApprove = {
      httpStatus: unknown.status,
      errorCode: unknown.body?.error?.code ?? null,
      body: unknown.body,
      executedClaim: JSON.stringify(unknown.body ?? {}).includes('"executed":true'),
    };

    // Close the stream with no decision: the pending approval must be dropped, observably.
    stream.request.destroy();
    stream = null;
    await waitFor(() => fixture.harness.approvals.size() === 0, { timeoutMs: 5000, label: 'N1 pending approval dropped on stream close' });
    await sleep(80);
    observation.registrySizeAfterClose = fixture.harness.approvals.size();
    observation.canaryAfterClose = existsSync(fixture.canary);
    observation.cancelSessionObservation = observeCancelSession(createApprovalRegistry);
    observation.approvalLogLines = approvalRecordLines(fixture.capture).length;
    observation.elapsedMs = Date.now() - startedMs;

    observation.expectations = [
      expectRow('N1.proposalFrames', 1, observation.proposalFrames),
      expectRow('N1.proposalState', 'proposed', observation.proposal?.state ?? null),
      expectRow('N1.proposalRequiresApproval', true, observation.proposal?.requiresApproval ?? null),
      expectRow('N1.proposalTargetsCanary', fixture.canary, observation.proposal?.arguments?.path ?? null),
      expectRow('N1.registrySizeBeforeDecision', 1, observation.registrySizeBeforeDecision),
      expectRow('N1.canaryBeforeDecision', false, observation.canaryBeforeDecision),
      expectRow('N1.executedClaimBeforeDecision', false, observation.executedClaimBeforeDecision),
      expectRow('N1.resultStateFramesBeforeDecision', 0, observation.resultStateFramesBeforeDecision),
      expectRow('N1.unknownCallHttpStatus', 409, observation.unknownCallApprove.httpStatus),
      expectRow('N1.unknownCallErrorCode', 'CALL_UNKNOWN', observation.unknownCallApprove.errorCode),
      expectRow('N1.unknownCallExecutedClaim', false, observation.unknownCallApprove.executedClaim),
      expectRow('N1.registrySizeAfterClose', 0, observation.registrySizeAfterClose),
      expectRow('N1.canaryAfterClose', false, observation.canaryAfterClose),
      expectRow('N1.cancelSessionCancelled', 1, observation.cancelSessionObservation.cancelled),
      expectRow('N1.cancelSessionDeniedState', 'denied', observation.cancelSessionObservation.deniedFrame?.state ?? null),
      expectRow('N1.cancelSessionDeniedReason', 'STREAM_CLOSED', observation.cancelSessionObservation.deniedFrame?.reason ?? null),
      expectRow('N1.cancelSessionSecondCancel', 0, observation.cancelSessionObservation.secondCancel),
      expectRow('N1.cancelSessionOtherSessionKept', 1, observation.cancelSessionObservation.sizeAfterSecondCancel),
      expectRow('N1.noApprovalLogWithoutDecision', 0, observation.approvalLogLines),
      expectRow('N1.canaryPositiveControlDetected', true, canaryPositiveControl.controlDetected),
      expectRow('N1.canaryPositiveControlRemoved', true, canaryPositiveControl.controlRemoved),
    ];
  } finally {
    if (stream !== null) {
      stream.request.destroy();
    }
    await fixture.close();
    observation.canaryAtEnd = existsSync(fixture.canary);
    observation.expectations = [...(observation.expectations ?? []), expectRow('N1.canaryAtEnd', false, observation.canaryAtEnd)];
  }
  return observation;
}

/**
 * N2 — 拒绝后**不执行**且**留痕**（日志级 / 持久审计级分开判定）。
 *
 * @returns {Promise<object>} Observation with expectations.
 */
export async function runN2() {
  const fixture = await startToolHarness({ label: 'n2', mode: 'tool', callId: CALL_ID });
  const observation = {
    id: 'N2',
    title: '拒绝后不执行且留痕（日志级成立 / 持久 audit.log·审计链不成立）',
    stubToolFrame: true,
    canaryPath: fixture.canary,
    sessionId: fixture.sessionId,
  };
  let stream = null;
  try {
    stream = await openProposalStream(fixture.harness, fixture.sessionId);
    observation.registrySizeBeforeDecision = fixture.harness.approvals.size();

    const denied = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: fixture.sessionId, callId: CALL_ID, decision: 'deny' },
    });
    observation.denyResponse = { httpStatus: denied.status, body: denied.body };
    await stream.onData((text) => text.includes('"reason":"USER_DENIED"'));
    await waitFor(() => fixture.harness.approvals.size() === 0, { timeoutMs: 3000, label: 'N2 entry consumed by deny' });

    const events = toolEvents(stream.chunks());
    observation.toolStates = events.map((entry) => entry.state);
    observation.deniedFrame = events.find((entry) => entry.state === 'denied') ?? null;
    observation.executedClaimInStream = stream.chunks().includes('"executed":true');
    observation.resultStateFrames = events.filter((entry) => entry.state === 'result').length;
    observation.registrySizeAfterDeny = fixture.harness.approvals.size();
    observation.canaryAfterDeny = existsSync(fixture.canary);

    // Trace, level 1 (log-level): structured logger line, in-process only.
    observation.logRecords = approvalRecordLines(fixture.capture);
    // Trace, level 2 (persistent audit): any file under the data dir carrying the callId.
    observation.persistent = findPersistentRecords(fixture.harness.dataDir, CALL_ID);
    observation.logLevelTrace = observation.logRecords.length === 1;
    observation.persistentAuditTrace = observation.persistent.hits.length > 0;

    const replayDeny = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: fixture.sessionId, callId: CALL_ID, decision: 'deny' },
    });
    observation.replayDeny = { httpStatus: replayDeny.status, errorCode: replayDeny.body?.error?.code ?? null };
    observation.canaryAfterReplay = existsSync(fixture.canary);

    observation.expectations = [
      expectRow('N2.registrySizeBeforeDecision', 1, observation.registrySizeBeforeDecision),
      expectRow('N2.denyHttpStatus', 200, observation.denyResponse.httpStatus),
      expectRow('N2.denyDecision', 'deny', observation.denyResponse.body?.decision ?? null),
      expectRow('N2.denyExecuted', false, observation.denyResponse.body?.executed ?? null),
      expectRow('N2.denyReason', 'EXECUTION_DISABLED', observation.denyResponse.body?.reason ?? null),
      expectRow('N2.toolStates', ['proposed', 'denied'], observation.toolStates),
      expectRow('N2.deniedFrameReason', 'USER_DENIED', observation.deniedFrame?.reason ?? null),
      expectRow('N2.executedClaimInStream', false, observation.executedClaimInStream),
      expectRow('N2.resultStateFrames', 0, observation.resultStateFrames),
      expectRow('N2.registrySizeAfterDeny', 0, observation.registrySizeAfterDeny),
      expectRow('N2.canaryAfterDeny', false, observation.canaryAfterDeny),
      expectRow('N2.logLevelTraceLines', 1, observation.logRecords.length),
      expectRow('N2.logLevelTraceCallId', CALL_ID, observation.logRecords[0]?.record?.callId ?? null),
      expectRow('N2.logLevelTraceDecision', 'deny', observation.logRecords[0]?.record?.decision ?? null),
      // 严格口径：产品**没有** approval 的持久审计通道 → 期望 false，并把它当结论登记而不是当通过。
      expectRow('N2.persistentAuditHits', 0, observation.persistent.hits.length),
      expectRow('N2.auditLogExists', false, observation.persistent.auditLogExists),
      expectRow('N2.replayDenyHttpStatus', 409, observation.replayDeny.httpStatus),
      expectRow('N2.replayDenyErrorCode', 'CALL_UNKNOWN', observation.replayDeny.errorCode),
      expectRow('N2.canaryAfterReplay', false, observation.canaryAfterReplay),
    ];
    observation.auditVerdict = observation.logLevelTrace === true
      ? '日志级留痕成立（logger.info "approval recorded" 带 callId+decision）；持久审计级留痕不成立（无 approval 审计通道，data 目录 0 命中、无 console/audit.log）'
      : '日志级留痕也不成立（见 expectations）';
  } finally {
    if (stream !== null) {
      stream.request.destroy();
    }
    await fixture.close();
    observation.canaryAtEnd = existsSync(fixture.canary);
    observation.expectations = [...(observation.expectations ?? []), expectRow('N2.canaryAtEnd', false, observation.canaryAtEnd)];
  }
  return observation;
}

/**
 * N3 — 审批**超时自动作废**（60 ms → denied/APPROVAL_TIMEOUT；超时后 approve → 409 CALL_UNKNOWN）。
 *
 * @returns {Promise<object>} Observation with expectations.
 */
export async function runN3() {
  const timeoutMs = 60;
  const fixture = await startToolHarness({ label: 'n3', mode: 'tool', callId: CALL_ID, approvalTimeoutMs: timeoutMs });
  const observation = {
    id: 'N3',
    title: '审批超时自动作废（denied/APPROVAL_TIMEOUT；超时后 approve → 409 CALL_UNKNOWN）',
    stubToolFrame: true,
    approvalTimeoutMs: timeoutMs,
    canaryPath: fixture.canary,
    sessionId: fixture.sessionId,
  };
  let stream = null;
  const startedMs = Date.now();
  try {
    stream = await openProposalStream(fixture.harness, fixture.sessionId);
    observation.registrySizeAtProposal = fixture.harness.approvals.size();
    observation.canaryAtProposal = existsSync(fixture.canary);
    await stream.onData((text) => text.includes('"reason":"APPROVAL_TIMEOUT"'), 10_000);
    observation.elapsedToTimeoutMs = Date.now() - startedMs;

    const events = toolEvents(stream.chunks());
    observation.toolStates = events.map((entry) => entry.state);
    observation.timeoutFrames = events.filter((entry) => entry.state === 'denied' && entry.reason === 'APPROVAL_TIMEOUT').length;
    observation.registrySizeAfterTimeout = fixture.harness.approvals.size();
    observation.canaryAfterTimeout = existsSync(fixture.canary);
    observation.expiredLogLines = fixture.capture.lines()
      .filter((line) => line.includes('"msg":"approval expired"'))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line.trim() };
        }
      });

    // A late approve must be refused — the expired entry is gone, not "still approvable".
    const late = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: fixture.sessionId, callId: CALL_ID, decision: 'approve' },
    });
    observation.lateApprove = {
      httpStatus: late.status,
      errorCode: late.body?.error?.code ?? null,
      body: late.body,
      executedClaim: JSON.stringify(late.body ?? {}).includes('"executed":true'),
    };
    await sleep(80);
    observation.registrySizeAfterLateApprove = fixture.harness.approvals.size();
    observation.canaryAfterLateApprove = existsSync(fixture.canary);
    observation.approvalRecordedLines = approvalRecordLines(fixture.capture).length;
    observation.elapsedMs = Date.now() - startedMs;

    observation.expectations = [
      expectRow('N3.registrySizeAtProposal', 1, observation.registrySizeAtProposal),
      expectRow('N3.canaryAtProposal', false, observation.canaryAtProposal),
      expectRow('N3.timeoutFrames', 1, observation.timeoutFrames),
      expectRow('N3.toolStates', ['proposed', 'denied'], observation.toolStates),
      expectRow('N3.registrySizeAfterTimeout', 0, observation.registrySizeAfterTimeout),
      expectRow('N3.canaryAfterTimeout', false, observation.canaryAfterTimeout),
      expectRow('N3.expiredLogLines', 1, observation.expiredLogLines.length),
      expectRow('N3.expiredLogCallId', CALL_ID, observation.expiredLogLines[0]?.callId ?? null),
      expectRow('N3.lateApproveHttpStatus', 409, observation.lateApprove.httpStatus),
      expectRow('N3.lateApproveErrorCode', 'CALL_UNKNOWN', observation.lateApprove.errorCode),
      expectRow('N3.lateApproveExecutedClaim', false, observation.lateApprove.executedClaim),
      expectRow('N3.registrySizeAfterLateApprove', 0, observation.registrySizeAfterLateApprove),
      expectRow('N3.canaryAfterLateApprove', false, observation.canaryAfterLateApprove),
      expectRow('N3.noApprovalRecordedForLateApprove', 0, observation.approvalRecordedLines),
    ];
  } finally {
    if (stream !== null) {
      stream.request.destroy();
    }
    await fixture.close();
    observation.canaryAtEnd = existsSync(fixture.canary);
    observation.expectations = [...(observation.expectations ?? []), expectRow('N3.canaryAtEnd', false, observation.canaryAtEnd)];
  }
  return observation;
}

/**
 * N4 — 同一次审批**重放只执行一次**（重复 register size 不增、错 session 409 不消费、
 * 正确 approve 仅 1 条 approved 帧、再 approve 409）。
 *
 * @returns {Promise<object>} Observation with expectations.
 */
export async function runN4() {
  const fixture = await startToolHarness({ label: 'n4', mode: 'tool-dup', callId: CALL_ID });
  const observation = {
    id: 'N4',
    title: '同一次审批重放只执行一次（去重 / 错 session / 二次 approve）',
    stubToolFrame: true,
    canaryPath: fixture.canary,
    sessionId: fixture.sessionId,
  };
  let stream = null;
  try {
    stream = await openProposalStream(fixture.harness, fixture.sessionId);
    await stream.onData((text) => countOf(text, '"state":"proposed"') >= 2);
    await waitFor(() => fixture.harness.approvals.size() === 1, { timeoutMs: 3000, label: 'N4 single registry entry' });
    await sleep(100);
    observation.proposalFrames = countOf(stream.chunks(), '"state":"proposed"');
    observation.registrySizeAfterDuplicateProposals = fixture.harness.approvals.size();

    // Deterministic registry-level duplicate guard (same product factory).
    {
      const sent = [];
      const channel = { send: (event, payload) => sent.push({ event, payload }) };
      const sessionA = `s_${'a'.repeat(32)}`;
      const registry = createApprovalRegistry({ timeoutMs: 60_000 });
      try {
        const first = registry.register({ callId: 'call_r2_dup', sessionId: sessionA, channel });
        const second = registry.register({ callId: 'call_r2_dup', sessionId: sessionA, channel });
        observation.duplicateRegister = { registerReturns: [first, second], size: registry.size(), decisionEvents: sent.length };
      } finally {
        registry.close();
      }
    }

    // Wrong session: refused and must NOT consume the pending entry.
    const wrongSession = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: `s_${'c'.repeat(32)}`, callId: CALL_ID, decision: 'approve' },
    });
    observation.wrongSession = {
      httpStatus: wrongSession.status,
      errorCode: wrongSession.body?.error?.code ?? null,
      registrySizeAfterWrongSession: fixture.harness.approvals.size(),
      canaryAfterWrongSession: existsSync(fixture.canary),
    };

    // Correct decision: exactly one approved frame.
    const approved = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: fixture.sessionId, callId: CALL_ID, decision: 'approve' },
    });
    observation.approveResponse = { httpStatus: approved.status, body: approved.body };
    await stream.onData((text) => text.includes('"state":"approved"'));
    await waitFor(() => fixture.harness.approvals.size() === 0, { timeoutMs: 3000, label: 'N4 entry consumed by approve' });
    const approvedFramesNow = toolEvents(stream.chunks()).filter((entry) => entry.state === 'approved').length;

    // Replay the same approval: refused, and no second decision frame appears afterwards.
    const replay = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: fixture.sessionId, callId: CALL_ID, decision: 'approve' },
    });
    await sleep(150);
    const eventsAfterReplay = toolEvents(stream.chunks());
    observation.replay = {
      httpStatus: replay.status,
      errorCode: replay.body?.error?.code ?? null,
      executedClaim: JSON.stringify(replay.body ?? {}).includes('"executed":true'),
    };
    observation.approvedFrames = approvedFramesNow;
    observation.approvedFramesAfterReplay = eventsAfterReplay.filter((entry) => entry.state === 'approved').length;
    observation.decisionFramesTotal = eventsAfterReplay.filter((entry) => entry.state === 'approved' || entry.state === 'denied').length;
    observation.registrySizeAtEnd = fixture.harness.approvals.size();
    observation.executedClaimInStream = stream.chunks().includes('"executed":true');
    observation.canaryAtEndOfScenario = existsSync(fixture.canary);
    observation.logRecords = approvalRecordLines(fixture.capture);

    observation.expectations = [
      expectRow('N4.proposalFrames', 2, observation.proposalFrames),
      expectRow('N4.registrySizeAfterDuplicateProposals', 1, observation.registrySizeAfterDuplicateProposals),
      expectRow('N4.duplicateRegisterReturns', [true, false], observation.duplicateRegister.registerReturns),
      expectRow('N4.duplicateRegisterSize', 1, observation.duplicateRegister.size),
      expectRow('N4.duplicateRegisterDecisionEvents', 0, observation.duplicateRegister.decisionEvents),
      expectRow('N4.wrongSessionHttpStatus', 409, observation.wrongSession.httpStatus),
      expectRow('N4.wrongSessionErrorCode', 'CALL_UNKNOWN', observation.wrongSession.errorCode),
      expectRow('N4.registrySizeAfterWrongSession', 1, observation.wrongSession.registrySizeAfterWrongSession),
      expectRow('N4.canaryAfterWrongSession', false, observation.wrongSession.canaryAfterWrongSession),
      expectRow('N4.approveHttpStatus', 200, observation.approveResponse.httpStatus),
      expectRow('N4.approveExecuted', false, observation.approveResponse.body?.executed ?? null),
      expectRow('N4.approveReason', 'EXECUTION_DISABLED', observation.approveResponse.body?.reason ?? null),
      expectRow('N4.approvedFrames', 1, observation.approvedFrames),
      expectRow('N4.approvedFramesAfterReplay', 1, observation.approvedFramesAfterReplay),
      expectRow('N4.decisionFramesTotal', 1, observation.decisionFramesTotal),
      expectRow('N4.replayHttpStatus', 409, observation.replay.httpStatus),
      expectRow('N4.replayErrorCode', 'CALL_UNKNOWN', observation.replay.errorCode),
      expectRow('N4.replayExecutedClaim', false, observation.replay.executedClaim),
      expectRow('N4.registrySizeAtEnd', 0, observation.registrySizeAtEnd),
      expectRow('N4.executedClaimInStream', false, observation.executedClaimInStream),
      expectRow('N4.canaryAtEndOfScenario', false, observation.canaryAtEndOfScenario),
      expectRow('N4.logLevelTraceLines', 1, observation.logRecords.length),
    ];
  } finally {
    if (stream !== null) {
      stream.request.destroy();
    }
    await fixture.close();
    observation.canaryAtEnd = existsSync(fixture.canary);
    observation.expectations = [...(observation.expectations ?? []), expectRow('N4.canaryAtEnd', false, observation.canaryAtEnd)];
  }
  return observation;
}

/**
 * One of the three `%TEMP%` canary states: deny / approve / timeout.
 *
 * @param {'deny'|'approve'|'timeout'} state State.
 * @returns {Promise<object>} Observation with expectations.
 */
export async function runCanaryState(state) {
  const canaryPositiveControl = ensureCanaryDir();
  const canary = `${CANARY_DIR}\\canary-${state}.txt`;
  rmSync(canary, { force: true });
  const fixture = await startToolHarness({
    label: `state-${state}`,
    mode: 'tool',
    callId: CALL_ID,
    canaryPath: canary,
    approvalTimeoutMs: state === 'timeout' ? 60 : undefined,
  });
  const observation = {
    state,
    stubToolFrame: true,
    canaryPath: canary,
    canaryPositiveControl,
    sessionId: fixture.sessionId,
    canaryExists: { beforeOpen: existsSync(canary) },
    registrySize: {},
  };
  let stream = null;
  try {
    stream = await openProposalStream(fixture.harness, fixture.sessionId);
    observation.canaryExists.afterProposal = existsSync(canary);
    observation.registrySize.afterProposal = fixture.harness.approvals.size();
    observation.proposal = toolEvents(stream.chunks())[0] ?? null;

    if (state === 'timeout') {
      await stream.onData((text) => text.includes('"reason":"APPROVAL_TIMEOUT"'));
      observation.approvalResponse = null;
    } else {
      const decision = state === 'deny' ? 'deny' : 'approve';
      const response = await fixture.harness.request('/api/v1/agent/approval', {
        method: 'POST',
        body: { sessionId: fixture.sessionId, callId: CALL_ID, decision },
      });
      observation.approvalResponse = { httpStatus: response.status, body: response.body, decision };
      if (state === 'deny') {
        await stream.onData((text) => text.includes('"reason":"USER_DENIED"'));
      } else {
        await stream.onData((text) => text.includes('"state":"approved"'));
      }
    }
    await sleep(120);
    observation.canaryExists.afterDecision = existsSync(canary);
    observation.registrySize.afterDecision = fixture.harness.approvals.size();
    observation.toolEvents = toolEvents(stream.chunks());
    observation.toolStates = observation.toolEvents.map((entry) => entry.state);
    observation.executedClaimInStream = stream.chunks().includes('"executed":true');
    observation.persistent = findPersistentRecords(fixture.harness.dataDir, CALL_ID);
    observation.logRecords = approvalRecordLines(fixture.capture);
    observation.expiredLogLines = fixture.capture.lines()
      .filter((line) => line.includes('"msg":"approval expired"'))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line.trim() };
        }
      });

    observation.expectations = [
      expectRow(`CANARY.${state}.canaryBeforeOpen`, false, observation.canaryExists.beforeOpen),
      expectRow(`CANARY.${state}.canaryAfterProposal`, false, observation.canaryExists.afterProposal),
      expectRow(`CANARY.${state}.canaryAfterDecision`, false, observation.canaryExists.afterDecision),
      expectRow(`CANARY.${state}.executedClaimInStream`, false, observation.executedClaimInStream),
      expectRow(`CANARY.${state}.canaryPositiveControlDetected`, true, canaryPositiveControl.controlDetected),
      expectRow(`CANARY.${state}.canaryPositiveControlRemoved`, true, canaryPositiveControl.controlRemoved),
    ];
    if (state === 'timeout') {
      observation.expectations.push(
        expectRow(`CANARY.${state}.toolStates`, ['proposed', 'denied'], observation.toolStates),
        expectRow(`CANARY.${state}.deniedReason`, 'APPROVAL_TIMEOUT', observation.toolEvents[1]?.reason ?? null),
        expectRow(`CANARY.${state}.registrySizeAfterDecision`, 0, observation.registrySize.afterDecision),
        expectRow(`CANARY.${state}.expiredLogLines`, 1, observation.expiredLogLines.length),
        expectRow(`CANARY.${state}.expiredLogCallId`, CALL_ID, observation.expiredLogLines[0]?.callId ?? null),
        expectRow(`CANARY.${state}.noApprovalRecorded`, 0, observation.logRecords.length),
      );
    } else {
      observation.expectations.push(
        expectRow(`CANARY.${state}.registrySizeAfterDecision`, 0, observation.registrySize.afterDecision),
        expectRow(`CANARY.${state}.approvalExecuted`, false, observation.approvalResponse?.body?.executed ?? null),
        expectRow(`CANARY.${state}.approvalReason`, 'EXECUTION_DISABLED', observation.approvalResponse?.body?.reason ?? null),
        expectRow(`CANARY.${state}.logLevelTraceLines`, 1, observation.logRecords.length),
        expectRow(`CANARY.${state}.expiredLogLines`, 0, observation.expiredLogLines.length),
      );
    }
  } finally {
    if (stream !== null) {
      stream.request.destroy();
    }
    await fixture.close();
    observation.canaryExists.atEnd = existsSync(canary);
    observation.expectations = [...(observation.expectations ?? []), expectRow(`CANARY.${state}.canaryAtEnd`, false, observation.canaryExists.atEnd)];
    rmSync(canary, { force: true });
  }
  observation.canaryDirExists = existsSync(CANARY_DIR);
  return observation;
}

/**
 * N5 — `requiresApproval:false` 的提案**不得**进入审批注册表（chat.js:592-596 的审批门）。
 *
 * 这一条是为 round-1 再攻击席点名的"删 requiresApproval 判定 → 0 红（覆盖缺口）"补的断言：
 * 门被删掉（无条件 register）时，`N5.registrySizeAfterNoApprovalProposal` 会从 0 变 1。
 * 例外说明：该 gate 的**变异执行**（把产品 chat.js 换成本席复制件）不在本文件——见
 * `probe-mutations.mjs` 的 M8（用 `%TEMP%` 的 fixture 副本把整条真 daemon 栈指向变异 chat.js）。
 *
 * @returns {Promise<object>} Observation with expectations.
 */
export async function runN5() {
  const canaryPositiveControl = ensureCanaryDir();
  const fixture = await startToolHarness({ label: 'n5', mode: 'tool-noapproval', callId: CALL_ID });
  const observation = {
    id: 'N5',
    title: 'requiresApproval:false 的提案不进审批注册表（chat.js:592-596 审批门）',
    stubToolFrame: true,
    canaryPath: fixture.canary,
    canaryPositiveControl,
    sessionId: fixture.sessionId,
  };
  let stream = null;
  try {
    stream = await openProposalStream(fixture.harness, fixture.sessionId);
    await sleep(120);
    const events = toolEvents(stream.chunks());
    observation.proposal = events[0] ?? null;
    observation.toolStates = events.map((entry) => entry.state);
    observation.registrySizeAfterNoApprovalProposal = fixture.harness.approvals.size();
    observation.canaryAfterProposal = existsSync(fixture.canary);

    // Nothing was registered, so there is nothing an approval could decide.
    const approved = await fixture.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: fixture.sessionId, callId: CALL_ID, decision: 'approve' },
    });
    observation.approveNoApprovalProposal = {
      httpStatus: approved.status,
      errorCode: approved.body?.error?.code ?? null,
      executedClaim: JSON.stringify(approved.body ?? {}).includes('"executed":true'),
    };
    await sleep(80);
    observation.registrySizeAfterApprove = fixture.harness.approvals.size();
    observation.canaryAtEndOfScenario = existsSync(fixture.canary);

    observation.expectations = [
      expectRow('N5.proposalFrames', 1, events.length),
      expectRow('N5.proposalRequiresApproval', false, observation.proposal?.requiresApproval ?? null),
      expectRow('N5.toolStates', ['proposed'], observation.toolStates),
      expectRow('N5.registrySizeAfterNoApprovalProposal', 0, observation.registrySizeAfterNoApprovalProposal),
      expectRow('N5.canaryAfterProposal', false, observation.canaryAfterProposal),
      expectRow('N5.approveHttpStatus', 409, observation.approveNoApprovalProposal.httpStatus),
      expectRow('N5.approveErrorCode', 'CALL_UNKNOWN', observation.approveNoApprovalProposal.errorCode),
      expectRow('N5.approveExecutedClaim', false, observation.approveNoApprovalProposal.executedClaim),
      expectRow('N5.registrySizeAfterApprove', 0, observation.registrySizeAfterApprove),
      expectRow('N5.canaryAtEndOfScenario', false, observation.canaryAtEndOfScenario),
      expectRow('N5.canaryPositiveControlDetected', true, canaryPositiveControl.controlDetected),
    ];
  } finally {
    if (stream !== null) {
      stream.request.destroy();
    }
    await fixture.close();
    observation.canaryAtEnd = existsSync(fixture.canary);
    observation.expectations = [...(observation.expectations ?? []), expectRow('N5.canaryAtEnd', false, observation.canaryAtEnd)];
  }
  return observation;
}

/** All four negative cases, serial (one daemon stack at a time). */
export const NEGATIVE_CASES = Object.freeze([
  { id: 'N1', run: runN1 },
  { id: 'N2', run: runN2 },
  { id: 'N3', run: runN3 },
  { id: 'N4', run: runN4 },
  { id: 'N5', run: runN5 },
]);
