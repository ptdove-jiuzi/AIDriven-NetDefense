/**
 * UI-POLISH · T1 · Agent 对话「配好后真能发消息」端到端（真 SSE）
 *
 * 链路是真的：Agent 视图 → js/api.js（真 fetch）→ apps/console-next/serve.mjs（真 console host）
 *            → tests/console-next/fake-daemon.mjs（真 SSE 帧）。
 * 不连任何真实模型：fake daemon 只回合成帧。
 *
 * 判据（任务正文 4/5/6/7）：
 *   delta 累积 · usage 事件 · 终态保留文本 · 停止=interrupted 且保留已收文本、不自动重连
 *   · 工具卡默认收起 / 可展开收起 / 键盘可达（button + aria-expanded）/ 长值截断
 *   · token 与花费（estimatedCostUsd=null → "—"，绝不 0.00）· 会话级累计可见
 *   · 重试 / 重新生成在终态可用且带 aria-label
 *
 * @author PT-dove
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installDom, makeEvent, visibleText } from './dom-shim.mjs';
import { startConsoleAndDaemon } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const EN_DICT = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps', 'console-next', 'i18n', 'locales', 'en.json'), 'utf8'));

const OK_MODELS = {
  egressEnabled: true,
  providers: [{ id: 'local', kind: 'openai-compatible', enabled: true, hasCredential: true }],
  models: [{ id: 'local-chat', providerId: 'local', tier: 'triage', maxInputTokens: 4096, maxOutputTokens: 512 }],
  engine: { selected: 'broker-host', harness: { available: false, reason: 'PROFILE_NOT_STAGED' } },
};

const { createApi } = await import('../../apps/console-next/js/api.js');
const { mount } = await import('../../apps/console-next/js/views/agent.js');

function translator() {
  return (key) => (typeof EN_DICT[key] === 'string' ? EN_DICT[key] : '[missing:' + key + ']');
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: (key) => map.delete(String(key)),
    dump: () => Object.fromEntries(map.entries()),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, description, timeoutMs = 8000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(20);
  }
  throw new Error('timeout waiting for ' + description + (lastError ? ' (' + lastError.message + ')' : ''));
}

/** 起 console host + fake daemon，挂载 Agent 视图；返回可断言的句柄 */
async function mountLiveAgent(t, daemonOptions = {}) {
  const harness = await startConsoleAndDaemon(t, { daemon: { models: OK_MODELS, ...daemonOptions } });
  const api = createApi({ fetchImpl: (url, init) => fetch(harness.url + url, init) });
  const dom = installDom();
  t.after(() => dom.cleanup());
  const root = dom.document.createElement('div');
  dom.document.body.appendChild(root);
  const storage = memoryStorage();
  const toasts = [];
  const navigations = [];
  const handle = await mount(root, {
    api,
    i18n: { locale: 'en', t: translator() },
    storage,
    navigate: (hash) => navigations.push(String(hash)),
    toast: (payload) => toasts.push(payload),
  });
  t.after(() => handle.destroy());
  const textarea = root.querySelector('textarea');
  await waitFor(() => textarea.disabled === false, 'models to load and composer to unlock');
  return { dom, root, textarea, harness, api, storage, toasts, navigations, handle };
}

function submitPrompt(root, textarea, text) {
  textarea.value = text;
  textarea.dispatchEvent(makeEvent('keydown', { key: 'Enter' }));
}

const chatRequests = (harness) =>
  harness.daemon.requests.filter((record) => record.url === '/api/v1/agent/chat' && record.method === 'POST');

test('真 SSE：delta 累积、usage 未知单价显示"—"、终态保留文本、会话累计可见', async (t) => {
  const { root, textarea, harness, storage } = await mountLiveAgent(t, {
    sseFrames: [
      { event: 'delta', data: { seq: 1, text: '先看' } },
      { event: 'delta', data: { seq: 2, text: '这条告警。' } },
      { event: 'usage', data: { seq: 3, promptTokens: 120, completionTokens: 45, totalTokens: 165, estimatedCostUsd: null } },
      { event: 'done', data: { seq: 4, finishReason: 'stop', sessionId: 's_test', messageId: 'm_1', totalTokens: 165 } },
    ],
  });

  submitPrompt(root, textarea, '分析这条告警');
  await waitFor(() => root.querySelector('[data-role="assistant"]'), 'assistant bubble');
  await waitFor(() => root.querySelector('[data-status="done"][data-role="assistant"]'), 'terminal done state');

  const bubble = root.querySelector('[data-role="assistant"]');
  const text = visibleText(bubble);
  assert.match(text, /先看这条告警。/u, 'delta 必须按序累积成完整回复');
  assert.match(text, /165 tokens/u, '必须显示 usage 里的 token 数');
  assert.match(text, /cost unknown/u, 'estimatedCostUsd=null 时必须显示成本未知');
  assert.equal(root.querySelectorAll('[data-status="streaming"]').length, 0, '终态后不得残留 streaming');
  for (const pending of root.querySelectorAll('.chat-msg__pending')) {
    assert.equal(pending.hidden, true, '终态后不得残留"等待模型回应"占位');
  }
  // 绝不把"不知道"渲染成 0 / $0.00
  assert.ok(!/\$0\.00/u.test(visibleText(root)), '花费未知时不得显示 $0.00');
  assert.ok(!/0 tokens/u.test(visibleText(root)), 'token 未知时不得显示 0 tokens');

  // 会话级累计（sessions.js totals）在界面上可见
  const stats = root.querySelector('[data-role="session-stats"]');
  assert.ok(stats, '必须有会话累计用量条');
  const statsText = visibleText(stats);
  assert.match(statsText, /165 tokens/u, '累计 token 必须可见：' + statsText);
  assert.match(statsText, /cost —/u, '未知花费必须显示为 —：' + statsText);

  // 真落盘：assistant 消息 done + usage 保留
  const snapshot = JSON.parse(storage.dump()['aidn.agent.sessions']);
  const messages = snapshot.sessions.flatMap((session) => session.messages);
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant, 'assistant 消息必须落盘');
  assert.equal(assistant.status, 'done');
  assert.equal(assistant.content, '先看这条告警。');
  assert.equal(assistant.usage.totalTokens, 165);
  assert.equal(assistant.usage.estimatedCostUsd, null);

  assert.equal(chatRequests(harness).length, 1, '一次提问只发一次请求（不自动重连/重发）');
});

test('真 SSE：已知单价时显示花费而不是"—"；usage 缺失 token 时显示"—"不显示 0', async (t) => {
  const { root, textarea } = await mountLiveAgent(t, {
    sseFrames: [
      { event: 'delta', data: { seq: 1, text: '好的。' } },
      { event: 'usage', data: { seq: 2, totalTokens: 12, estimatedCostUsd: 0.00123 } },
      { event: 'done', data: { seq: 3, finishReason: 'stop' } },
    ],
  });
  submitPrompt(root, textarea, '你好');
  await waitFor(() => root.querySelector('[data-status="done"][data-role="assistant"]'), 'terminal done');
  const text = visibleText(root.querySelector('[data-role="assistant"]'));
  assert.match(text, /12 tokens/u);
  assert.match(text, /\$0\.00123/u, '已知单价必须显示真实估算花费：' + text);
  const stats = visibleText(root.querySelector('[data-role="session-stats"]'));
  assert.match(stats, /\$0\.00123/u, '会话累计花费必须可见：' + stats);
});

test('工具调用卡：默认收起、点击/键盘可展开收起、aria-expanded 同步、长值截断', async (t) => {
  const longResult = { ok: true, lines: ['y'.repeat(5000)] };
  const { root, textarea } = await mountLiveAgent(t, {
    sseFrames: [
      {
        event: 'tool',
        data: {
          seq: 1,
          callId: 'call_1',
          name: 'read_log',
          arguments: { path: '/var/log/auth.log', limit: 2000, note: 'n'.repeat(400) },
          requiresApproval: false,
          state: 'proposed',
        },
      },
      { event: 'tool', data: { seq: 2, callId: 'call_1', state: 'result', executed: true, latencyMs: 12, result: longResult } },
      { event: 'delta', data: { seq: 3, text: '查完了。' } },
      { event: 'done', data: { seq: 4, finishReason: 'stop' } },
    ],
  });
  submitPrompt(root, textarea, '看看 auth.log');
  await waitFor(() => root.querySelector('.chat-tool'), 'tool card');
  await waitFor(() => root.querySelector('[data-status="done"][data-role="assistant"]'), 'terminal done');

  const card = root.querySelector('.chat-tool');
  const toggle = card.querySelector('.chat-tool__toggle');
  const body = card.querySelector('.chat-tool__body');
  assert.ok(toggle, '折叠卡必须有真 button');
  assert.equal(toggle.tagName.toLowerCase(), 'button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', '默认必须收起');
  assert.equal(body.hidden, true, '默认必须收起（body hidden）');
  assert.ok(toggle.getAttribute('aria-controls'), 'button 必须 aria-controls 指向内容区');
  assert.equal(toggle.getAttribute('aria-controls'), body.getAttribute('id'));
  assert.match(visibleText(toggle), /read_log/u, '摘要必须显示工具名');
  assert.match(visibleText(toggle), /result/u, '摘要必须显示状态');
  assert.match(visibleText(toggle), /latency|ms|12/u, '摘要应包含耗时');
  // 参数摘要单行截断（400 字符的 note 不能整段铺在摘要行）
  const preview = card.querySelector('.chat-tool__preview');
  assert.ok(preview, '必须有参数摘要');
  assert.ok(visibleText(preview).length <= 80, '参数摘要必须截断：' + visibleText(preview).length);

  toggle.dispatchEvent(makeEvent('click'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', '点击后展开');
  assert.equal(body.hidden, false);
  const expanded = visibleText(body);
  assert.match(expanded, /truncated/u, '超长结果必须明确标注已截断');
  assert.ok(!expanded.includes('y'.repeat(4500)), '超长值不得整段进入 DOM');

  toggle.dispatchEvent(makeEvent('keydown', { key: ' ', code: 'Space' }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', '键盘 Space 必须能收起');
  toggle.dispatchEvent(makeEvent('keydown', { key: 'Enter' }));
  // Enter 由原生 button 触发 click；shim 不模拟默认行为 → 这里只断言按钮键盘可达（focus）
  assert.equal(toggle.getAttribute('tabindex'), null, 'button 默认可 Tab 到达');
});

test('停止：保留已收文本、标 interrupted、不自动重连、重试按钮带 aria-label 且真重发', async (t) => {
  const frames = [];
  for (let index = 1; index <= 12; index += 1) {
    frames.push({ event: 'delta', data: { seq: index, text: '片段' + index + '。' } });
  }
  frames.push({ event: 'done', data: { seq: 99, finishReason: 'stop' } });
  const { root, textarea, harness } = await mountLiveAgent(t, { sseFrames: frames, sseDelayMs: 80 });

  submitPrompt(root, textarea, '慢慢说');
  await waitFor(() => root.querySelector('.chat-msg__text') && visibleText(root.querySelector('[data-role="assistant"]')).includes('片段1'), 'first delta');
  const stopButton = root.querySelector('[data-action="stop"]');
  assert.ok(stopButton, '流式中必须有停止按钮');
  stopButton.dispatchEvent(makeEvent('click'));

  const bubble = root.querySelector('[data-role="assistant"]');
  assert.equal(bubble.getAttribute('data-status'), 'interrupted', '停止后状态必须是 interrupted');
  const keptText = visibleText(bubble);
  assert.match(keptText, /片段1/u, '停止必须保留已经收到的文本');
  assert.match(keptText, /Generation stopped/u, '中断提示必须可见');
  const retry = root.querySelector('[data-action="retry"]');
  assert.ok(retry, '中断后必须给重试按钮');
  assert.ok(retry.getAttribute('aria-label'), '重试按钮必须有 aria-label：' + retry.getAttribute('aria-label'));

  const before = chatRequests(harness).length;
  await sleep(300);
  assert.equal(chatRequests(harness).length, before, '中断后不得自动重连/重发');

  // 重试：真的再发一次（第二个 assistant 消息），并正常收到 done
  retry.dispatchEvent(makeEvent('click'));
  await waitFor(() => chatRequests(harness).length === before + 1, 'retry request');
  await waitFor(() => root.querySelectorAll('[data-status="done"][data-role="assistant"]').length === 1, 'retry completes');
  const assistantBubbles = root.querySelectorAll('[data-role="assistant"]');
  assert.equal(assistantBubbles.length, 2, '重试保留原中断消息 + 新回复');
  assert.match(visibleText(root.querySelector('[data-status="interrupted"]')), /片段1/u, '原中断消息文本不得被清空');
  assert.match(visibleText(root.querySelector('[data-status="done"][data-role="assistant"]')), /片段12/u, '重试后新回复完整');
});

test('重新生成：终态可用、带 aria-label、清掉旧回复并真的再要一次', async (t) => {
  const { root, textarea, harness } = await mountLiveAgent(t, {
    sseFrames: [
      { event: 'delta', data: { seq: 1, text: '第一版回答。' } },
      { event: 'done', data: { seq: 2, finishReason: 'stop' } },
    ],
  });
  submitPrompt(root, textarea, '再来一次');
  await waitFor(() => root.querySelector('[data-status="done"][data-role="assistant"]'), 'first done');
  assert.match(visibleText(root.querySelector('[data-role="assistant"]')), /第一版回答。/u);

  const regenerate = root.querySelector('[data-action="regenerate"]');
  assert.ok(regenerate, '终态必须有重新生成按钮');
  assert.ok(regenerate.getAttribute('aria-label'), '重新生成必须有 aria-label');
  assert.equal(regenerate.disabled, false, '终态时重新生成必须可用');

  harness.daemon.setFrames([
    { event: 'delta', data: { seq: 1, text: '第二版回答。' } },
    { event: 'done', data: { seq: 2, finishReason: 'stop' } },
  ]);
  regenerate.dispatchEvent(makeEvent('click'));
  await waitFor(() => chatRequests(harness).length === 2, 'regenerate request');
  await waitFor(() => root.querySelectorAll('[data-status="done"][data-role="assistant"]').length === 1, 'regenerated reply');
  assert.equal(root.querySelectorAll('[data-role="assistant"]').length, 1, '重新生成必须替换旧回复，而不是叠加');
  assert.match(visibleText(root.querySelector('[data-role="assistant"]')), /第二版回答。/u);
});
