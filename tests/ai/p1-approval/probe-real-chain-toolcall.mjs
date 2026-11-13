/**
 * probe-real-chain-toolcall.mjs — P1-CLOSE · agent-approval 席位 B1 取证探针。
 *
 * 链路（真字节，不是 stub）：
 *   daemon createControlApi → broker-client → **真** apps/model-broker/bin/console-host.js
 *   → chat-transport → 127.0.0.1 假 provider（tests/ai/fake-provider.mjs，真 HTTP，零外联）。
 *
 * 目的：自己复跑 AGENT-001 ①，记录 frames / HTTP 状态 / finishReason / tool 帧数，
 * 以及"Agent 要求写 %TEMP% 文件"的 canary 文件是否出现。不采信旧日志。
 *
 * 附加场景（标注为 secondary）：provider 忽略 `stream:true` 返回整包 JSON 时，
 * chat-transport 的 `:489-493` 兜底分支同样只取正文（这条分支用 fake-provider 走不到，
 * 因为 fake-provider 对 `stream:true` 一律回 SSE）。用一个只回 JSON 的本地 provider 证明它
 * 也丢弃 tool_calls。
 *
 * 用法：node tests/ai/p1-approval/probe-real-chain-toolcall.mjs
 * 输出：stdout 一份 JSON + evidence/p1-close/agent/raw/real-chain-toolcall.json
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeProvider } from '../fake-provider.mjs';
import {
  createCaptureLogger,
  parseSseText,
  sessionIdFor,
  settingsDocument,
  startConsoleApi,
} from '../../wp5-daemon/console-fixtures.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const REAL_HOST = fileURLToPath(new URL('../../../apps/model-broker/bin/console-host.js', import.meta.url));
const EVIDENCE_DIR = join(REPO, 'evidence', 'p1-close', 'agent');
const RAW_DIR = join(EVIDENCE_DIR, 'raw');
const CANARY_DIR = join(process.env.TEMP ?? tmpdir(), 'p1-close', 'agent');
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-');

const CANARY = join(CANARY_DIR, `canary-realchain-${STAMP}.txt`);
rmSync(CANARY, { force: true });
mkdirSync(RAW_DIR, { recursive: true });

const FINDING_MARKER = 'P1-CLOSE-AGENT-CANARY';

/** Settings with one loopback OpenAI-compatible provider pointing at `baseUrl`. */
function settingsFor(baseUrl) {
  return settingsDocument({
    models: {
      egressEnabled: true,
      providers: [{
        id: 'fake-provider',
        kind: 'openai-compatible',
        baseUrl,
        enabled: true,
        allowLoopback: true,
        dailyInputTokens: 300000,
        dailyOutputTokens: 60000,
        pricing: null,
      }],
      models: [{
        id: 'fake-tool-call',
        providerId: 'fake-provider',
        tier: 'watch',
        maxInputTokens: 4096,
        maxOutputTokens: 512,
        costClass: 'free-local',
      }],
    },
  });
}

/** Frames of an SSE response, reduced to the fields that matter for AGENT-001. */
function summarize(label, response, extra = {}) {
  const events = response?.events ?? [];
  return {
    label,
    httpStatus: response?.status ?? null,
    contentType: response?.headers?.get?.('content-type') ?? null,
    frameCount: events.length,
    eventNames: events.map((event) => event.event),
    deltaFrames: events.filter((event) => event.event === 'delta').length,
    toolFrames: events.filter((event) => event.event === 'tool').length,
    usageFrames: events.filter((event) => event.event === 'usage').length,
    doneFinishReason: events.find((event) => event.event === 'done')?.data?.finishReason ?? null,
    errorCode: events.find((event) => event.event === 'error')?.data?.code ?? null,
    canaryExistsAfter: existsSync(CANARY),
    ...extra,
  };
}

/** The exact tool proposal both providers emit: "write this file". */
const WRITE_FILE_TOOL_CALL = {
  name: 'write_file',
  arguments: JSON.stringify({ path: CANARY, content: FINDING_MARKER }),
};

const results = { probe: 'real-chain-toolcall', stamp: STAMP, canaryPath: CANARY, scenarios: [] };

// ------------------------------------------------------------------ primary: fake-provider
const fake = await startFakeProvider({
  behaviors: { 'fake-tool-call': 'tool-call' },
  toolCall: WRITE_FILE_TOOL_CALL,
  gapMs: 10,
});
const capture = createCaptureLogger();
const harness = await startConsoleApi({
  hostPath: REAL_HOST,
  settings: settingsFor(fake.baseUrl),
  logger: capture.logger,
  sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
});
try {
  const startedMs = Date.now();
  const response = await harness.sse('/api/v1/agent/chat', {
    sessionId: sessionIdFor('p1-realchain'),
    modelId: 'fake-tool-call',
    messages: [{ role: 'user', content: `write ${CANARY}` }],
  });
  const providerRequest = fake.requests[0] ?? null;
  results.scenarios.push(summarize('real-chain/fake-provider(tool-call)', response, {
    elapsedMs: Date.now() - startedMs,
    providerRequestedStream: providerRequest?.body?.stream ?? null,
    providerBehavior: providerRequest?.behavior ?? null,
    providerSawModel: providerRequest?.body?.model ?? null,
    providerRequestCount: fake.requests.length,
    approvalsSize: harness.approvals.size(),
    approvalAuditLines: capture.lines().filter((line) => line.includes('approval recorded')).length,
  }));
  results.primary = {
    chain: 'daemon createControlApi -> broker-client -> real console-host.js -> chat-transport -> fake-provider(127.0.0.1)',
    hostPath: REAL_HOST,
    providerOrigin: fake.origin,
    expectedByAgent001: 'frames=usage+done, finishReason=tool_calls, 0 delta, 0 tool, canary absent',
  };
} finally {
  await harness.close();
  await fake.close();
}

// ------------------------------------------------ secondary: provider that ignores stream:true
/** A provider that always answers the whole completions JSON, even for stream:true. */
const jsonProvider = await new Promise((resolve) => {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let model = 'json-fallback-model';
      try {
        model = JSON.parse(body)?.model ?? model;
      } catch {
        // keep default
      }
      const payload = JSON.stringify({
        id: 'chatcmpl-json-fallback',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_json_fallback_1',
              type: 'function',
              function: { name: WRITE_FILE_TOOL_CALL.name, arguments: WRITE_FILE_TOOL_CALL.arguments },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((done) => server.close(() => done())),
  }));
});
const capture2 = createCaptureLogger();
const harness2 = await startConsoleApi({
  hostPath: REAL_HOST,
  settings: settingsFor(jsonProvider.baseUrl),
  logger: capture2.logger,
  sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
});
try {
  const startedMs = Date.now();
  const response = await harness2.sse('/api/v1/agent/chat', {
    sessionId: sessionIdFor('p1-jsonfallback'),
    modelId: 'fake-tool-call',
    messages: [{ role: 'user', content: `write ${CANARY}` }],
  });
  results.scenarios.push(summarize('secondary/non-SSE JSON fallback (chat-transport :489-493)', response, {
    elapsedMs: Date.now() - startedMs,
    providerOrigin: jsonProvider.baseUrl,
    approvalsSize: harness2.approvals.size(),
  }));
  results.secondary = {
    note: 'provider ignores stream:true and answers one JSON body with tool_calls; this is the only way to reach chat-transport :489-493',
  };
} finally {
  await harness2.close();
  await jsonProvider.close();
}

results.verdict = {
  realChainToolFrames: results.scenarios[0].toolFrames,
  realChainDeltaFrames: results.scenarios[0].deltaFrames,
  realChainFinishReason: results.scenarios[0].doneFinishReason,
  canaryEverCreated: existsSync(CANARY),
  agent001Reproduced: results.scenarios[0].toolFrames === 0
    && results.scenarios[0].doneFinishReason === 'tool_calls'
    && existsSync(CANARY) === false,
  jsonFallbackToolFrames: results.scenarios[1].toolFrames,
  jsonFallbackFinishReason: results.scenarios[1].doneFinishReason,
};

const outFile = join(RAW_DIR, 'real-chain-toolcall.json');
mkdirSync(RAW_DIR, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
results.rawFile = outFile;
console.log(JSON.stringify(results, null, 2));
