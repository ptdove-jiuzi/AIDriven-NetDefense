/**
 * ai-approval-negatives.test.js — P1-CLOSE · AGENT-001 审批链四条否定用例（0.0.1 无执行器）。
 *
 * 走的是"当前真可达路径"：真 daemon API（`server.js` + 真 `chat.js` 处理器 + 真
 * `createApprovalRegistry`）+ 测试替身 broker host（`tests/ai/p1-approval/stub-approval-host.mjs`）。
 * 替身只发 contract §3.2 的 `tool proposed` 帧，`arguments` 是"写 %TEMP% 文件"；因为
 * `apps/daemon/src/api/chat.js:829-836` 明确 `executed:false / EXECUTION_DISABLED`，
 * 三态（拒绝/批准/超时）都不应产生 canary 文件。
 *
 * 四条否定用例 + 两条注册表级守卫（STREAM_CLOSED / duplicate callId）。每条断言都对应
 * 产品里一个可被删掉的守卫，变异设计见 `evidence/p1-close/agent/REPORT.md §4`
 * （可执行变异证据见 `tests/ai/p1-approval/probe-mutation-cases.mjs`）。
 *
 * 只读产品代码、不联网、不写用户数据；canary 路径固定 `%TEMP%\p1-close\agent\`。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApprovalRegistry } from '../../apps/daemon/src/api/chat.js';
import {
  TEST_TOKEN,
  chatReadySettings,
  createCaptureLogger,
  openRawSse,
  parseSseText,
  sessionIdFor,
  startConsoleApi,
  waitFor,
} from './console-fixtures.mjs';

const STUB_HOST = fileURLToPath(new URL('../ai/p1-approval/stub-approval-host.mjs', import.meta.url));
const CANARY_DIR = join(process.env.TEMP ?? tmpdir(), 'p1-close', 'agent');
const CALL_ID = 'call_p1_1';

/** Chat body accepted by contract §2.5 (the stream is what carries the tool proposal). */
function chatBody(sessionId) {
  return {
    sessionId,
    modelId: 'local-chat',
    messages: [{ role: 'user', content: 'write the canary file' }],
  };
}

/** Count non-overlapping occurrences of a literal. */
function countOf(text, needle) {
  return String(text).split(needle).length - 1;
}

/**
 * Start the daemon console stack against the approval stub host.
 *
 * @param {object} t Node test context.
 * @param {{mode?: string, approvalTimeoutMs?: number, label: string}} options Options.
 * @returns {Promise<{harness: object, canary: string, capture: object}>} Fixture.
 */
async function startToolHarness(t, options) {
  const canary = join(CANARY_DIR, `canary-${options.label}-${process.pid}-${Date.now()}.txt`);
  rmSync(canary, { force: true });
  const capture = createCaptureLogger();
  const harness = await startConsoleApi({
    settings: chatReadySettings(1),
    hostPath: STUB_HOST,
    childEnv: {
      P1_STUB_MODE: options.mode ?? 'tool',
      P1_CALL_ID: CALL_ID,
      P1_CANARY_PATH: canary,
    },
    approvalTimeoutMs: options.approvalTimeoutMs,
    logger: capture.logger,
    sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
  });
  t.after(async () => {
    await harness.close();
    rmSync(canary, { force: true });
  });
  return { harness, canary, capture };
}

/**
 * Open the chat SSE and wait until the tool proposal reached the client.
 *
 * @param {object} t Node test context.
 * @param {object} harness Console harness.
 * @param {string} sessionId Session id.
 * @returns {Promise<object>} Raw stream handle.
 */
async function openProposalStream(t, harness, sessionId) {
  const stream = await openRawSse(
    harness.address.port,
    '/api/v1/agent/chat',
    chatBody(sessionId),
    { token: TEST_TOKEN, csrf: harness.csrfToken },
  );
  t.after(() => stream.request.destroy());
  await stream.onData((text) => text.includes('"state":"proposed"'));
  return stream;
}

/** Tool events of a buffered SSE text. */
function toolEvents(text) {
  return parseSseText(text).events.filter((event) => event.event === 'tool');
}

describe('AGENT-001 approval chain · negative cases (0.0.1 has no executor)', () => {
  it('case 1 — a proposal is not executed before any decision; closing the stream denies it and leaves no side effect', async (t) => {
    const { harness, canary, capture } = await startToolHarness(t, { label: 'case1' });
    const sessionId = sessionIdFor('p1-case1');
    const stream = await openProposalStream(t, harness, sessionId);

    const beforeDecision = toolEvents(stream.chunks());
    assert.equal(beforeDecision.length, 1, 'exactly one tool proposal frame');
    assert.equal(beforeDecision[0].data.state, 'proposed');
    assert.equal(beforeDecision[0].data.requiresApproval, true);
    assert.equal(beforeDecision[0].data.arguments.path, canary, 'the proposal targets the %TEMP% canary');
    assert.equal(stream.chunks().includes('"executed":true'), false, 'no execution claim before a decision');
    assert.equal(existsSync(canary), false, 'canary must not exist before any approval decision');
    assert.equal(harness.approvals.size(), 1, 'the proposal is registered, not executed');

    // A closed stream with no decision: cancelSession must drop it (denied/STREAM_CLOSED).
    stream.request.destroy();
    await waitFor(() => harness.approvals.size() === 0, { timeoutMs: 5000, label: 'pending approval dropped on close' });
    assert.equal(existsSync(canary), false, 'closing the stream must not execute anything');
    assert.equal(capture.lines().some((line) => line.includes('approval recorded')), false, 'no decision record without a decision');
  });

  it('case 1b — cancelSession emits denied/STREAM_CLOSED once and only for the matching session', () => {
    const sent = [];
    const channel = { send: (event, payload) => sent.push({ event, payload }) };
    const a = `s_${'a'.repeat(32)}`;
    const b = `s_${'b'.repeat(32)}`;
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    assert.equal(registry.register({ callId: 'call_p1_a', sessionId: a, channel }), true);
    assert.equal(registry.register({ callId: 'call_p1_b', sessionId: b, channel }), true);
    assert.equal(
      registry.register({ callId: 'call_p1_a', sessionId: a, channel }),
      false,
      'a duplicate callId must be refused (register() return value)',
    );
    assert.equal(registry.size(), 2, 'a duplicate callId must not add a second entry');
    assert.equal(registry.cancelSession(a), 1);
    assert.equal(registry.size(), 1, 'the other session keeps its pending approval');
    const toolSends = sent.filter((entry) => entry.event === 'tool');
    assert.equal(toolSends.length, 1);
    assert.deepEqual(Object.keys(toolSends[0].payload).sort(), ['callId', 'decidedAt', 'reason', 'state']);
    assert.equal(toolSends[0].payload.callId, 'call_p1_a');
    assert.equal(toolSends[0].payload.state, 'denied');
    assert.equal(toolSends[0].payload.reason, 'STREAM_CLOSED');
    assert.equal(registry.cancelSession(a), 0, 'cancelling twice must not double-decide');
    registry.close();
  });

  it('case 2 — deny is recorded without execution and leaves a locate-able log record; re-deciding is refused', async (t) => {
    const { harness, canary, capture } = await startToolHarness(t, { label: 'case2' });
    const sessionId = sessionIdFor('p1-case2');
    const stream = await openProposalStream(t, harness, sessionId);

    const denied = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: CALL_ID, decision: 'deny' },
    });
    assert.equal(denied.status, 200);
    assert.deepEqual(denied.body, {
      callId: CALL_ID,
      decision: 'deny',
      executed: false,
      reason: 'EXECUTION_DISABLED',
    });

    await stream.onData((text) => text.includes('"reason":"USER_DENIED"'));
    const states = toolEvents(stream.chunks()).map((event) => event.data.state);
    assert.deepEqual(states, ['proposed', 'denied'], 'one denial decision, no result frame');
    assert.equal(existsSync(canary), false, 'a denied tool call must not write the canary');

    // Audit trace: the decision is recorded as a structured log line with callId+decision.
    const auditLine = capture.lines().find((line) => line.includes('"msg":"approval recorded"'));
    assert.ok(auditLine, 'the decision must leave a locate-able record (logger.info "approval recorded")');
    const record = JSON.parse(auditLine);
    assert.equal(record.callId, CALL_ID);
    assert.equal(record.decision, 'deny');

    // Finding, asserted so it cannot silently change: there is no persistent audit channel
    // for approvals (only token rotation writes console/audit.log).
    assert.equal(
      readdirSync(join(harness.dataDir, 'console')).includes('audit.log'),
      false,
      'approval decisions are not written to a persistent audit log (recorded as a finding, not a pass)',
    );

    const again = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: CALL_ID, decision: 'deny' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'CALL_UNKNOWN');
    assert.equal(existsSync(canary), false);
  });

  it('case 3 — an unanswered approval expires (denied/APPROVAL_TIMEOUT) and a late approve is refused', async (t) => {
    const { harness, canary } = await startToolHarness(t, { label: 'case3', approvalTimeoutMs: 60 });
    const sessionId = sessionIdFor('p1-case3');
    const stream = await openProposalStream(t, harness, sessionId);

    await stream.onData((text) => text.includes('"reason":"APPROVAL_TIMEOUT"'));
    const denied = toolEvents(stream.chunks()).filter((event) => event.data.state === 'denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].data.reason, 'APPROVAL_TIMEOUT');
    assert.equal(harness.approvals.size(), 0, 'the expired entry is gone from the registry');
    assert.equal(existsSync(canary), false, 'an expired approval must not execute');

    const late = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: CALL_ID, decision: 'approve' },
    });
    assert.equal(late.status, 409, 'a late approve after expiry must be refused');
    assert.equal(late.body.error.code, 'CALL_UNKNOWN');
    assert.equal(JSON.stringify(late.body).includes('"executed":true'), false);
    assert.equal(existsSync(canary), false, 'the late approve must not execute');
  });

  it('case 4 — replaying one approval decides once: duplicate register, wrong session and repeat approve all do nothing', async (t) => {
    const { harness, canary } = await startToolHarness(t, { label: 'case4', mode: 'tool-dup' });
    const sessionId = sessionIdFor('p1-case4');
    const stream = await openProposalStream(t, harness, sessionId);
    await stream.onData((text) => countOf(text, '"state":"proposed"') >= 2);

    // Duplicate callId: two proposals, one registry entry.
    await waitFor(() => harness.approvals.size() === 1, { timeoutMs: 3000, label: 'single registry entry' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(harness.approvals.size(), 1, 'the duplicate-callId guard keeps exactly one entry');

    // Wrong session: refused, decision not consumed.
    const wrongSession = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId: sessionIdFor('p1-other'), callId: CALL_ID, decision: 'approve' },
    });
    assert.equal(wrongSession.status, 409);
    assert.equal(wrongSession.body.error.code, 'CALL_UNKNOWN');
    assert.equal(harness.approvals.size(), 1, 'a wrong-session decision must not consume the entry');

    // Correct decision: exactly one approved frame.
    const approved = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: CALL_ID, decision: 'approve' },
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.body, {
      callId: CALL_ID,
      decision: 'approve',
      executed: false,
      reason: 'EXECUTION_DISABLED',
    });
    await stream.onData((text) => text.includes('"state":"approved"'));
    await waitFor(() => harness.approvals.size() === 0, { timeoutMs: 3000, label: 'entry consumed by the decision' });
    assert.equal(
      toolEvents(stream.chunks()).filter((event) => event.data.state === 'approved').length,
      1,
      'replay/duplicate register must not produce a second decision frame',
    );

    // Replay: the second approve is unknown; no second side effect.
    const replay = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: CALL_ID, decision: 'approve' },
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'CALL_UNKNOWN');
    assert.equal(existsSync(canary), false, 'neither approve executed: 0.0.1 has no executor');
    assert.equal(stream.chunks().includes('"executed":true'), false);
  });
});
