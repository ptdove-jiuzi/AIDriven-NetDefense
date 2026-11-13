/**
 * probe-real-chain-toolcall.mjs — P1-CLOSER round-2 · T2（agent-approval-r2）真链路复现 AGENT-001 ①。
 *
 * 链路（真字节，无替身）：
 *   daemon `createControlApi` → broker-client → **真** `apps/model-broker/bin/console-host.js`
 *   → `apps/model-broker/src/chat-transport.js` → `127.0.0.1:<ephemeral>` 假 provider
 *   （`tests/ai/fake-provider.mjs`，真 HTTP，零外联、无 key）。
 *
 * 判据（AGENT-001 ① 的原文期望 vs 实际）：provider 只发标准 OpenAI `tool_calls` 时，
 *   期望：daemon 的 SSE 至少 1 个 `tool` 帧，或（若明确不支持）非 200 / `error` 帧；
 *   实际：HTTP 200 + `frames=[usage,done]` + `finishReason=tool_calls` + **0 delta / 0 tool**、
 *        审批注册表 size 恒 0（提案根本没进 daemon）、canary 不存在 ⇒ **静默"成功"**。
 *
 * 附加场景（secondary，标注）：provider 忽略 `stream:true` 回整包 JSON 时，
 *   `chat-transport.js:489-493` 的兜底分支同样只取正文 → 同样 0 tool 帧。
 *
 * 上一轮入口 `tests/ai/p1-approval/probe-real-chain-toolcall.mjs` 只作只读参考；
 * 本文件是本轮独立实现并落本轮原始证据。
 *
 * 用法：node tests/ai/r2/probe-real-chain-toolcall.mjs
 * 产物：`evidence/p1-close-2/agent/raw/real-chain-toolcall.json`
 *
 * @author PT-dove
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

import { startFakeProvider } from '../fake-provider.mjs';
import {
  CANARY_DIR,
  RAW_DIR,
  REPO,
  createCaptureLogger,
  ensureCanaryDir,
  sha256File,
  startConsoleApi,
} from './lib/harness.mjs';
import { settingsDocument } from '../../wp5-daemon/console-fixtures.mjs';

mkdirSync(RAW_DIR, { recursive: true });
const canaryControl = ensureCanaryDir();

const STAMP = new Date().toISOString().replace(/[:.]/gu, '-');
const CANARY = join(CANARY_DIR, `canary-realchain-${STAMP}.txt`);
rmSync(CANARY, { force: true });

const REAL_HOST = join(REPO, 'apps', 'model-broker', 'bin', 'console-host.js');
const FINDING_MARKER = 'P1-CLOSE-2-AGENT-CANARY';

/**
 * Settings with one loopback OpenAI-compatible provider pointing at `baseUrl`.
 *
 * @param {string} baseUrl Provider base URL.
 * @returns {object} Settings overrides.
 */
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

/**
 * Reduce an SSE response to the fields AGENT-001 talks about.
 *
 * @param {string} label Scenario label.
 * @param {object} response `ssePost` result.
 * @param {object} [extra] Extra fields.
 * @returns {object} Summary row.
 */
function summarize(label, response, extra = {}) {
  const events = response?.events ?? [];
  return {
    label,
    httpStatus: response?.status ?? null,
    contentType: response?.headers?.get?.('content-type') ?? null,
    frameCount: events.length,
    eventNames: events.map((event) => event.event),
    frames: events.map((event) => ({ event: event.event, finishReason: event.data?.finishReason ?? null, code: event.data?.code ?? null })),
    deltaFrames: events.filter((event) => event.event === 'delta').length,
    toolFrames: events.filter((event) => event.event === 'tool').length,
    usageFrames: events.filter((event) => event.event === 'usage').length,
    doneFinishReason: events.find((event) => event.event === 'done')?.data?.finishReason ?? null,
    errorCode: events.find((event) => event.event === 'error')?.data?.code ?? null,
    canaryExistsAfter: existsSync(CANARY),
    ...extra,
  };
}

/** The exact tool proposal the provider emits: "write this file". */
const WRITE_FILE_TOOL_CALL = {
  name: 'write_file',
  arguments: JSON.stringify({ path: CANARY, content: FINDING_MARKER }),
};

const results = {
  probe: 'real-chain-toolcall',
  seat: 'agent-approval-r2',
  task: 'task-2',
  stamp: STAMP,
  canaryPath: CANARY,
  canaryControl,
  productBytes: {
    'apps/model-broker/src/chat-transport.js': sha256File(join(REPO, 'apps', 'model-broker', 'src', 'chat-transport.js')),
    'apps/model-broker/bin/console-host.js': sha256File(REAL_HOST),
    'apps/daemon/src/api/chat.js': sha256File(join(REPO, 'apps', 'daemon', 'src', 'api', 'chat.js')),
  },
  scenarios: [],
  expectations: [],
};

/**
 * Record an expectation row.
 *
 * @param {string} id Row id.
 * @param {unknown} expected Expected value.
 * @param {unknown} actual Actual value.
 */
function expectRow(id, expected, actual) {
  results.expectations.push({ id, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) });
}

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
    sessionId: `s_${'a'.repeat(32)}`,
    modelId: 'fake-tool-call',
    messages: [{ role: 'user', content: `write ${CANARY}` }],
  });
  const providerRequest = fake.requests[0] ?? null;
  results.scenarios.push(summarize('real-chain/fake-provider(tool-call)', response, {
    elapsedMs: Date.now() - startedMs,
    providerOrigin: fake.origin,
    providerSawModel: providerRequest?.body?.model ?? null,
    providerRequestedStream: providerRequest?.body?.stream ?? null,
    providerBehavior: providerRequest?.behavior ?? null,
    providerRequestCount: fake.requests.length,
    approvalsSize: harness.approvals.size(),
    approvalAuditLines: capture.lines().filter((line) => line.includes('approval recorded')).length,
    pendingApprovalLogLines: capture.lines().filter((line) => line.includes('approval')).length,
  }));
  results.primary = {
    chain: 'daemon createControlApi -> broker-client -> real console-host.js -> chat-transport -> fake-provider(127.0.0.1)',
    hostPath: REAL_HOST,
    providerOrigin: fake.origin,
    expectedByAgent001: 'frames must include >=1 tool (or a non-200/error); actual must not be 200+done(tool_calls)+0 delta+0 tool',
  };
} finally {
  await harness.close();
  await fake.close();
}

// ------------------------------------------------ secondary: provider that ignores stream:true
/** A provider that always answers the whole completions JSON, even for `stream:true`. */
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
    sessionId: `s_${'b'.repeat(32)}`,
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

// ------------------------------------------------------------------ expectations (AGENT-001 ①)
const primary = results.scenarios[0];
expectRow('REAL.httpStatus', 200, primary.httpStatus);
expectRow('REAL.frames', ['usage', 'done'], primary.eventNames);
expectRow('REAL.deltaFrames', 0, primary.deltaFrames);
expectRow('REAL.toolFrames', 0, primary.toolFrames);
expectRow('REAL.finishReason', 'tool_calls', primary.doneFinishReason);
expectRow('REAL.errorCode', null, primary.errorCode);
expectRow('REAL.approvalsSize', 0, primary.approvalsSize);
expectRow('REAL.approvalLogLines', 0, primary.approvalAuditLines);
expectRow('REAL.canaryAbsent', false, primary.canaryExistsAfter);
expectRow('REAL.providerRequestedStream', true, primary.providerRequestedStream);
expectRow('REAL.providerBehavior', 'tool-call', primary.providerBehavior);
const secondary = results.scenarios[1];
expectRow('JSONFALLBACK.httpStatus', 200, secondary.httpStatus);
expectRow('JSONFALLBACK.toolFrames', 0, secondary.toolFrames);
expectRow('JSONFALLBACK.deltaFrames', 0, secondary.deltaFrames);
expectRow('JSONFALLBACK.finishReason', 'tool_calls', secondary.doneFinishReason);
expectRow('JSONFALLBACK.canaryAbsent', false, secondary.canaryExistsAfter);

results.totals = {
  scenarios: results.scenarios.length,
  expectations: results.expectations.length,
  pass: results.expectations.filter((row) => row.pass === true).length,
  fail: results.expectations.filter((row) => row.pass !== true).length,
};
results.verdict = {
  agent001Reproduced: primary.toolFrames === 0
    && primary.deltaFrames === 0
    && primary.doneFinishReason === 'tool_calls'
    && primary.httpStatus === 200
    && primary.approvalsSize === 0
    && existsSync(CANARY) === false,
  silentSuccess: primary.httpStatus === 200 && primary.toolFrames === 0 && primary.errorCode === null,
  approvalChainReachableOnRealChain: false,
  why: 'daemon 审批注册表在真链路上 size 恒 0：tool_calls 在 chat-transport 就被丢弃，提案从未到达 chat.js dispatchEvent(tool)。',
};
results.canaryAtEnd = existsSync(CANARY);
rmSync(CANARY, { force: true });

const outFile = join(RAW_DIR, 'real-chain-toolcall.json');
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  verdict: results.verdict,
  primary: {
    httpStatus: primary.httpStatus,
    frames: primary.eventNames,
    deltaFrames: primary.deltaFrames,
    toolFrames: primary.toolFrames,
    finishReason: primary.doneFinishReason,
    approvalsSize: primary.approvalsSize,
    canaryExistsAfter: primary.canaryExistsAfter,
  },
  secondary: { httpStatus: secondary.httpStatus, frames: secondary.eventNames, toolFrames: secondary.toolFrames, finishReason: secondary.doneFinishReason },
  totals: results.totals,
  rawFile: outFile,
}, null, 2));
process.exitCode = results.totals.fail === 0 ? 0 : 1;
