#!/usr/bin/env node
/**
 * stub-approval-host.mjs — P1-CLOSE · agent-approval 席位的 broker host 测试替身。
 *
 * 为什么需要它：产品里唯一能产出 `tool` 帧的路径是测试替身 host（`apps/model-broker/bin/
 * console-host.js` 的真链路上 `chat-transport` 会把 `tool_calls` 静默丢掉，见 AGENT-001）。
 * 既有替身 `tests/wp5-daemon/console-stub-host.mjs` 的 tool 模式写死了 `read_alert`，无法
 * 表达"Agent 请求写 %TEMP% 文件"这一场景，也无法在同一次流里发两次相同 callId 的提案。
 * 本文件只补齐这两点，其余帧形状与既有替身逐字一致（同一套 contract §1.1 帧）。
 *
 * 不是产品文件；不写盘（除 argv 指定的 --data-dir 之外不碰任何用户数据）；不联网。
 *
 * 环境变量（由测试通过 broker-client 的 childEnv 注入）：
 *   P1_STUB_MODE=tool|tool-dup|tool-done   默认 tool
 *   P1_CALL_ID                             默认 call_p1_1（必须匹配 /^call_[A-Za-z0-9_-]{1,120}$/）
 *   P1_TOOL_NAME                           默认 write_file
 *   P1_CANARY_PATH                         tool 提案 arguments.path（写文件目标）
 *   P1_PROPOSAL_DELAY_MS                   默认 10
 *   P1_SPAWN_LOG                           追加本进程 pid（每行一个）
 *
 * @author PT-dove
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import process from 'node:process';

const env = process.env;
const mode = typeof env.P1_STUB_MODE === 'string' && env.P1_STUB_MODE !== '' ? env.P1_STUB_MODE : 'tool';
const callId = typeof env.P1_CALL_ID === 'string' && env.P1_CALL_ID !== '' ? env.P1_CALL_ID : 'call_p1_1';
const toolName = typeof env.P1_TOOL_NAME === 'string' && env.P1_TOOL_NAME !== '' ? env.P1_TOOL_NAME : 'write_file';
const canaryPath = typeof env.P1_CANARY_PATH === 'string' ? env.P1_CANARY_PATH : '';
const proposalDelayMs = Number.isInteger(Number.parseInt(env.P1_PROPOSAL_DELAY_MS ?? '', 10))
  ? Number.parseInt(env.P1_PROPOSAL_DELAY_MS, 10)
  : 10;

if (typeof env.P1_SPAWN_LOG === 'string' && env.P1_SPAWN_LOG !== '') {
  appendFileSync(env.P1_SPAWN_LOG, `${process.pid}\n`);
}

/** The proposal body: an agent asking to write a file under %TEMP%. */
function toolArguments() {
  return {
    path: canaryPath,
    content: 'P1-CLOSE-AGENT-CANARY: this file must only exist if a tool executor ran',
  };
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, reason) {
  writeFrame({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: 'stub approval host refused the request', data: { code, ...(reason === undefined ? {} : { reason }) } },
  });
}

function notify(requestId, event) {
  writeFrame({ jsonrpc: '2.0', method: 'chat/event', params: { requestId, event } });
}

function proposal() {
  return {
    type: 'tool',
    callId,
    name: toolName,
    arguments: toolArguments(),
    state: 'proposed',
    requiresApproval: true,
  };
}

function handleChatStart(id, params) {
  respond(id, { accepted: true, requestId: params.requestId });
  const requestId = params.requestId;
  if (mode === 'tool-done') {
    setTimeout(() => notify(requestId, proposal()), proposalDelayMs);
    setTimeout(() => {
      notify(requestId, { type: 'done', finishReason: 'tool_calls', totalTokens: 7, messageId: 'm_p1_stub' });
    }, proposalDelayMs + 40);
    return;
  }
  if (mode === 'tool-dup') {
    // Same callId twice: the registry must register exactly one entry.
    setTimeout(() => notify(requestId, proposal()), proposalDelayMs);
    setTimeout(() => notify(requestId, proposal()), proposalDelayMs + 25);
    return;
  }
  setTimeout(() => notify(requestId, proposal()), proposalDelayMs);
}

const handlers = Object.freeze({
  'host/hello'(id) {
    respond(id, {
      protocolVersion: '1.0',
      host: 'stub-p1-approval-host',
      pid: process.pid,
      node: process.versions.node,
      startedAt: new Date().toISOString(),
      store: { available: true },
      capabilities: ['credentials/put', 'credentials/delete', 'credentials/info', 'provider/test', 'chat/start', 'chat/cancel'],
      limits: {},
    });
  },
  'chat/start'(id, params) {
    handleChatStart(id, params);
  },
  'chat/cancel'(id) {
    respond(id, { ok: true, cancelled: true });
    setTimeout(() => process.exit(0), 20);
  },
  'credentials/info'(id, params) {
    const providerIds = Array.isArray(params?.providerIds) ? params.providerIds : [];
    respond(id, { items: providerIds.map((providerId) => ({ providerId, hasCredential: false, credential: null })) });
  },
  'provider/test'(id) {
    respond(id, { ok: true, latencyMs: 1, modelCount: 1, error: null, testedAt: new Date().toISOString() });
  },
  shutdown(id) {
    respond(id, { ok: true });
    setTimeout(() => process.exit(0), 20);
  },
});

let chain = Promise.resolve();

const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const text = line.trim();
  if (text === '') {
    return;
  }
  chain = chain.then(async () => {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      respondError(null, 'INTERNAL_ERROR', 'FRAME_NOT_JSON');
      return;
    }
    const handler = handlers[frame.method];
    if (handler === undefined) {
      respondError(frame.id, 'INTERNAL_ERROR', 'UNKNOWN_METHOD');
      return;
    }
    try {
      await handler(frame.id, frame.params ?? {});
    } catch (error) {
      respondError(frame.id, 'INTERNAL_ERROR', error instanceof Error ? 'HANDLER_FAILED' : 'HANDLER_FAILED');
    }
  });
});

reader.on('close', () => {
  setTimeout(() => process.exit(0), 20);
});
