/**
 * ai-chat-multiturn.test.js — AI-ENABLE L2：Agent 真对话（多轮上下文）的行为证明。
 *
 * 链路与 explain 相同，没有任何 stub：
 *
 *   daemon(createControlApi) ──broker-client──▶ 真 apps/model-broker/bin/console-host.js
 *     ──chat-transport──▶ 127.0.0.1 假 provider（tests/ai/fake-provider.mjs，真 HTTP/SSE）
 *
 * 判据：同一 session 连续两轮，**第二轮发给 provider 的请求体里必须含上一轮 assistant 的
 * 实际输出**（不是"接口存在"，是上下文真的带过去了），且模型名出现在假 provider 日志里。
 *
 * 零外联：provider 是 `127.0.0.1:0`；loopback 不需要凭据，测试里没有真实 key。
 *
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startFakeProvider } from '../ai/fake-provider.mjs';
import {
  createCaptureLogger,
  sessionIdFor,
  settingsDocument,
  startConsoleApi,
  waitFor,
} from './console-fixtures.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HOST_PATH = join(REPO_ROOT, 'apps', 'model-broker', 'bin', 'console-host.js');

const SSE_OPTIONS = Object.freeze({ idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 });
const MODEL_ID = 'fake-chat';

/**
 * One loopback provider + one watch-tier model, so the chat route has a legal target.
 *
 * @param {object} fake Fake provider handle.
 * @returns {object} Settings document.
 */
function chatSettings(fake) {
  return settingsDocument({
    models: {
      egressEnabled: true,
      providers: [{
        id: 'fake-provider',
        kind: 'openai-compatible',
        baseUrl: fake.baseUrl,
        enabled: true,
        allowLoopback: true,
        dailyInputTokens: 300_000,
        dailyOutputTokens: 60_000,
        pricing: null,
      }],
      models: [{
        id: MODEL_ID,
        providerId: 'fake-provider',
        tier: 'watch',
        maxInputTokens: 4096,
        maxOutputTokens: 512,
        costClass: 'free-local',
      }],
    },
  });
}

/**
 * Chat body for one round.
 *
 * @param {string} sessionId Session id.
 * @param {object[]} messages Conversation so far.
 * @returns {object} Body.
 */
function chatBody(sessionId, messages) {
  return { sessionId, modelId: MODEL_ID, messages };
}

/** Join the stream's `delta` frames into the assistant turn text. */
function assistantTextOf(response) {
  return response.events
    .filter((event) => event.event === 'delta')
    .map((event) => event.data.text)
    .join('');
}

describe('AI-ENABLE L2 · Agent 真对话（同 session 两轮）', () => {
  it('第二轮请求体含第一轮 assistant 的实际内容（真对话而非无状态）', async (t) => {
    const fake = await startFakeProvider({
      behaviors: { [MODEL_ID]: 'delta' },
      chunks: ['first-', 'turn-', 'answer'],
      gapMs: 30,
    });
    t.after(() => fake.close());
    const capture = createCaptureLogger();
    const harness = await startConsoleApi({
      hostPath: HOST_PATH,
      settings: chatSettings(fake),
      logger: capture.logger,
      sseOptions: SSE_OPTIONS,
    });
    t.after(() => harness.close());
    const sessionId = sessionIdFor('ai-multiturn');

    // ---- 第一轮 ---------------------------------------------------------
    const first = await harness.sse('/api/v1/agent/chat', chatBody(sessionId, [
      { role: 'user', content: '第一轮：这台主机为什么被判定为高危？' },
    ]));
    assert.equal(first.status, 200);
    assert.equal(first.events.at(-1).event, 'done');
    assert.equal(first.events.at(-1).data.sessionId, sessionId);
    assert.equal(first.events.at(-1).data.messageId.startsWith('m_'), true);
    const firstAnswer = assistantTextOf(first);
    assert.equal(firstAnswer, 'first-turn-answer', 'the delta text must be what the provider sent');

    // ---- 第二轮（把第一轮的 assistant 输出作为历史带上）------------------
    const secondQuestion = '第二轮：那么下一步该做什么？';
    const second = await harness.sse('/api/v1/agent/chat', chatBody(sessionId, [
      { role: 'user', content: '第一轮：这台主机为什么被判定为高危？' },
      { role: 'assistant', content: firstAnswer },
      { role: 'user', content: secondQuestion },
    ]));
    assert.equal(second.status, 200);
    assert.equal(second.events.at(-1).event, 'done');
    assert.equal(second.events.at(-1).data.sessionId, sessionId);
    assert.notEqual(second.events.at(-1).data.messageId, first.events.at(-1).data.messageId);

    // ---- 假 provider 侧：两轮请求都真的发出去了 -------------------------
    await fake.waitForRequests(2, 10_000);
    assert.equal(fake.requests.length, 2, 'two rounds must produce two provider requests');
    assert.deepEqual(fake.modelsSeen(), [MODEL_ID]);
    const [round1, round2] = fake.requests;
    assert.equal(round1.path, '/v1/chat/completions');
    assert.equal(round2.path, '/v1/chat/completions');
    assert.equal(round1.stream, true);
    assert.equal(round2.stream, true);
    assert.equal(round1.body.model, MODEL_ID);
    assert.equal(round2.body.model, MODEL_ID);

    // ---- 多轮上下文的核心断言 -------------------------------------------
    const round2Roles = round2.body.messages.map((message) => message.role);
    assert.deepEqual(round2Roles, ['system', 'user', 'assistant', 'user']);
    const carried = round2.body.messages[2];
    assert.equal(carried.content, firstAnswer, 'round 2 must carry round 1 assistant text verbatim');
    assert.equal(round2.body.messages[3].content, secondQuestion);
    assert.equal(round1.body.messages.length, 2, 'round 1 has only the system prompt + one user message');
    assert.equal(round1.body.messages.some((message) => message.role === 'assistant'), false);

    // 系统提示始终由 daemon 提供，客户端注入不了（role=system 会被 CHAT_INVALID 拒）。
    assert.equal(typeof round1.body.messages[0].content, 'string');
    assert.ok(round1.body.messages[0].content.length > 20);

    // ---- 无子进程泄漏 ---------------------------------------------------
    await waitFor(() => harness.broker.stats().live === 0, { timeoutMs: 3_000, label: 'broker children reaped' });
    assert.deepEqual(harness.broker.activePids(), []);
    t.diagnostic(`multiturn: requests=${fake.requests.length} models=${JSON.stringify(fake.modelsSeen())} round2Roles=${JSON.stringify(round2Roles)} carriedChars=${carried.content.length}`);
  });

  it('对照：第二轮若客户端不带上历史，provider 请求体就只有一条 user（daemon 不自造上下文）', async (t) => {
    const fake = await startFakeProvider({ behaviors: { [MODEL_ID]: 'delta' }, chunks: ['ok'], gapMs: 10 });
    t.after(() => fake.close());
    const harness = await startConsoleApi({
      hostPath: HOST_PATH,
      settings: chatSettings(fake),
      sseOptions: SSE_OPTIONS,
    });
    t.after(() => harness.close());
    const sessionId = sessionIdFor('ai-multiturn-control');

    await harness.sse('/api/v1/agent/chat', chatBody(sessionId, [{ role: 'user', content: '第一轮' }]));
    await harness.sse('/api/v1/agent/chat', chatBody(sessionId, [{ role: 'user', content: '第二轮（无历史）' }]));
    await fake.waitForRequests(2, 10_000);

    for (const request of fake.requests) {
      assert.deepEqual(request.body.messages.map((message) => message.role), ['system', 'user']);
    }
    // 显式写清口径：上下文由客户端提供并原样转发，daemon 不记忆对话。
    t.diagnostic('control: daemon is stateless; multi-turn context is the client-supplied messages array, forwarded verbatim');
  });
});
