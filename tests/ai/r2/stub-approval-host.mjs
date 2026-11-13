#!/usr/bin/env node
/**
 * stub-approval-host.mjs — P1-CLOSER round-2 · T2（agent-approval-r2）的 broker host 测试替身。
 *
 * **显式标注（本席位结论的前置条件）**：AGENT-001 的① 是「真链路 `tool_calls` 被
 * `apps/model-broker/src/chat-transport.js` 静默丢弃」。因此**真产品链路上没有任何 `tool` 帧**，
 * 审批注册表 `apps/daemon/src/api/chat.js#createApprovalRegistry` 在真链路里**永远收不到提案**。
 * 本文件是"唯一可达 tool 帧"的测试替身：它只负责按 contract §3.2 的帧形状发 `tool proposed`，
 * 让**真 daemon API（server.js 路由）+ 真 chat.js 处理器 + 真审批注册表**这条路径可被驱动。
 * ⇒ 本席位的 N1–N4 四条否定用例，其**被测对象（审批链）是真的**，其**触发源（tool 帧）是替身**。
 *    报告与 RESULT.json 里每一个 N* 结论都必须带这个前提，不得写成"真 provider 链路已验审批"。
 *
 * 本文件不是产品文件：不联网（仅 stdio）、不写用户数据（除 R2_SPAWN_LOG 追加 pid 外不碰盘）。
 *
 * 环境变量（由测试/探针通过 broker-client 的 childEnv 注入）：
 *   R2_STUB_MODE=tool|tool-dup|tool-noapproval|tool-done   默认 tool
 *   R2_CALL_ID                                              默认 call_r2_1（须匹配 /^call_[A-Za-z0-9_-]{1,120}$/）
 *   R2_TOOL_NAME                                            默认 write_file
 *   R2_CANARY_PATH                                          proposal.arguments.path（写文件目标）
 *   R2_PROPOSAL_DELAY_MS                                    默认 10
 *   R2_SPAWN_LOG                                            每行追加本进程 pid
 *
 * 帧形状与 contract §3.2 / 既有替身一致（`tests/wp5-daemon/console-stub-host.mjs`）。
 *
 * @author PT-dove
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import process from 'node:process';

const env = process.env;
const mode = typeof env.R2_STUB_MODE === 'string' && env.R2_STUB_MODE !== '' ? env.R2_STUB_MODE : 'tool';
const callId = typeof env.R2_CALL_ID === 'string' && env.R2_CALL_ID !== '' ? env.R2_CALL_ID : 'call_r2_1';
const toolName = typeof env.R2_TOOL_NAME === 'string' && env.R2_TOOL_NAME !== '' ? env.R2_TOOL_NAME : 'write_file';
const canaryPath = typeof env.R2_CANARY_PATH === 'string' ? env.R2_CANARY_PATH : '';
const parsedDelay = Number.parseInt(env.R2_PROPOSAL_DELAY_MS ?? '', 10);
const proposalDelayMs = Number.isInteger(parsedDelay) ? parsedDelay : 10;

if (typeof env.R2_SPAWN_LOG === 'string' && env.R2_SPAWN_LOG !== '') {
  try {
    appendFileSync(env.R2_SPAWN_LOG, `${process.pid}\n`);
  } catch {
    // A spawn log is diagnostic only: never let it take the host down (the suite must not
    // depend on the log directory existing).
  }
}

/** The proposal body: an agent asking to write a file under %TEMP%. */
function toolArguments() {
  return {
    path: canaryPath,
    content: 'P1-CLOSE-2-AGENT-CANARY: this file must only exist if a tool executor ran',
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

/**
 * One `tool proposed` frame.
 *
 * @param {boolean} requiresApproval Contract §3.2 flag (mode `tool-noapproval` sets it false).
 * @returns {object} Frame event.
 */
function proposal(requiresApproval) {
  return {
    type: 'tool',
    callId,
    name: toolName,
    arguments: toolArguments(),
    state: 'proposed',
    requiresApproval,
  };
}

function handleChatStart(id, params) {
  respond(id, { accepted: true, requestId: params.requestId });
  const requestId = params.requestId;
  if (mode === 'tool-done') {
    setTimeout(() => notify(requestId, proposal(true)), proposalDelayMs);
    setTimeout(() => {
      notify(requestId, { type: 'done', finishReason: 'tool_calls', totalTokens: 7, messageId: 'm_r2_stub' });
    }, proposalDelayMs + 40);
    return;
  }
  if (mode === 'tool-dup') {
    // Same callId twice: the registry must register exactly one entry.
    setTimeout(() => notify(requestId, proposal(true)), proposalDelayMs);
    setTimeout(() => notify(requestId, proposal(true)), proposalDelayMs + 25);
    return;
  }
  if (mode === 'tool-noapproval') {
    // `requiresApproval:false`: the approval registry must NOT be touched (chat.js:592-596 gate).
    setTimeout(() => notify(requestId, proposal(false)), proposalDelayMs);
    return;
  }
  setTimeout(() => notify(requestId, proposal(true)), proposalDelayMs);
}

const handlers = Object.freeze({
  'host/hello'(id) {
    respond(id, {
      protocolVersion: '1.0',
      host: 'stub-r2-approval-host',
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
    } catch {
      respondError(frame.id, 'INTERNAL_ERROR', 'HANDLER_FAILED');
    }
  });
});

reader.on('close', () => {
  setTimeout(() => process.exit(0), 20);
});
