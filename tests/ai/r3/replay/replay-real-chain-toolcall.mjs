/**
 * replay-real-chain-toolcall.mjs — P1-RECOVERY-2 · agent-fix-r3 真链路 tool_calls 探针。
 *
 * 链路与 R2 `tests/ai/r2/probe-real-chain-toolcall.mjs` 相同（真 daemon `createControlApi` →
 * broker-client → **真** `console-host.js` → `chat-transport.js` → `127.0.0.1` 假 provider），
 * 差别只有三处：
 *   1. host 路径可由 `R3_BROKER_HOST` 覆盖（默认仓库内真 host；修复/变异跑的是副本）；
 *   2. 产物写到 `evidence/p1-recovery/40-agent/raw/`（R2 原路径在本席禁写域）；
 *   3. 支持两套期望：`R3_EXPECT=red`（缺陷态，16 条，与 R2 原 16 条 id 一致）与
 *      `R3_EXPECT=green`（修复态，tool 帧必须出现且审批注册表必须被触达）。
 *
 * 绿态为什么要 `gapMs=2000`：假 provider 发完 tool_calls delta 后停 2 s 才发 finish/[DONE]，
 * 这段时间里流还开着，才能稳定观察到"提案已在真审批注册表里待批"并真的发一次 approval 决策。
 * 红态用 `gapMs=10`（与 R2 一致，越快越能证明"没有任何 tool 帧"）。
 *
 * 零外联：假 provider 只 listen(0,'127.0.0.1')；不读任何 API key 环境变量。
 *
 * 用法：
 *   node tests/ai/r3/replay/replay-real-chain-toolcall.mjs                 # red（仓库真 host）
 *   R3_EXPECT=green R3_BROKER_HOST=<copy>/bin/console-host.js node …       # green（副本）
 *
 * @author PT-dove
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startFakeProvider } from '../../fake-provider.mjs';
import { CANARY_DIR, REPO, createCaptureLogger, ensureCanaryDir, sha256File, startConsoleApi } from '../../r2/lib/harness.mjs';
import { TEST_TOKEN, openRawSse, parseSseText, settingsDocument } from '../../../wp5-daemon/console-fixtures.mjs';
import { RAW_DIR } from './raw-dir.mjs';

const MODE = process.env.R3_EXPECT === 'green' ? 'green' : 'red';
const BROKER_HOST = process.env.R3_BROKER_HOST ?? join(REPO, 'apps', 'model-broker', 'bin', 'console-host.js');
const GAP_MS = MODE === 'green' ? 2000 : 10;
/** 本席第二套副作用目录（写文件 canary），见 tests/ai/r3/side-effect.mjs。 */
const SIDE_DIR = join(process.env.TEMP ?? 'C:\\Users\\user\\AppData\\Local\\Temp', 'p1r2-side');
const SIDE_CANARY = join(SIDE_DIR, 'canary.txt');

mkdirSync(RAW_DIR, { recursive: true });
const canaryControl = ensureCanaryDir();
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-');
const CANARY = join(CANARY_DIR, `canary-realchain-r3-${STAMP}.txt`);
rmSync(CANARY, { force: true });

const FINDING_MARKER = 'P1-RECOVERY-2-AGENT-CANARY';

/**
 * sha256 of a file, or null when absent.
 *
 * @param {string} filePath Path.
 * @returns {string|null} Digest.
 */
function shaOrNull(filePath) {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

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
 * Reduce an SSE text to the fields AGENT-001 talks about.
 *
 * @param {string} text Raw SSE text.
 * @returns {object} Summary.
 */
function summarise(text) {
  const events = parseSseText(text).events;
  const tools = events.filter((event) => event.event === 'tool');
  return {
    frameCount: events.length,
    eventNames: events.map((event) => event.event),
    deltaFrames: events.filter((event) => event.event === 'delta').length,
    toolFrames: tools.length,
    usageFrames: events.filter((event) => event.event === 'usage').length,
    toolPayloads: tools.map((event) => event.data),
    doneFinishReason: events.find((event) => event.event === 'done')?.data?.finishReason ?? null,
    errorCode: events.find((event) => event.event === 'error')?.data?.code ?? null,
  };
}

const PROFILE = {
  name: 'fake-tool-call',
  toolCall: {
    name: 'write_file',
    arguments: JSON.stringify({ path: CANARY, content: FINDING_MARKER }),
  },
};

const results = {
  probe: 'real-chain-toolcall',
  seat: 'agent-fix-r3',
  task: 'P1-RECOVERY-2 · A/C/D',
  mode: MODE,
  stamp: STAMP,
  chain: 'daemon createControlApi -> broker-client -> console-host.js -> chat-transport -> fake-provider(127.0.0.1)',
  brokerHost: BROKER_HOST,
  brokerHostIsRepoBytes: BROKER_HOST === join(REPO, 'apps', 'model-broker', 'bin', 'console-host.js'),
  canaryPath: CANARY,
  sideCanaryPath: SIDE_CANARY,
  canaryControl,
  productBytes: {
    'apps/model-broker/src/chat-transport.js': sha256File(join(REPO, 'apps', 'model-broker', 'src', 'chat-transport.js')),
    'apps/model-broker/bin/console-host.js': sha256File(join(REPO, 'apps', 'model-broker', 'bin', 'console-host.js')),
    'apps/daemon/src/api/chat.js': sha256File(join(REPO, 'apps', 'daemon', 'src', 'api', 'chat.js')),
  },
  brokerCopyBytes: {
    'bin/console-host.js': existsSync(BROKER_HOST) ? sha256File(BROKER_HOST) : null,
    'src/chat-transport.js': existsSync(join(BROKER_HOST, '..', '..', 'src', 'chat-transport.js'))
      ? sha256File(join(BROKER_HOST, '..', '..', 'src', 'chat-transport.js'))
      : null,
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

// ------------------------------------------------------------------ primary: SSE tool_calls
const fake = await startFakeProvider({
  behaviors: { 'fake-tool-call': 'tool-call' },
  toolCall: PROFILE.toolCall,
  gapMs: GAP_MS,
});
const capture = createCaptureLogger();
const harness = await startConsoleApi({
  hostPath: BROKER_HOST,
  settings: settingsFor(fake.baseUrl),
  logger: capture.logger,
  sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
});
let primary;
try {
  const startedMs = Date.now();
  // 用原始 SSE（不 buffer 到 end）才能在流未结束时观察注册表。
  const stream = await openRawSse(
    harness.address.port,
    '/api/v1/agent/chat',
    {
      sessionId: `s_${'a'.repeat(32)}`,
      modelId: 'fake-tool-call',
      messages: [{ role: 'user', content: `write ${CANARY}` }],
    },
    { token: TEST_TOKEN, csrf: harness.csrfToken },
  );
  const sawTool = await stream.onData((text) => text.includes('"state":"proposed"'), 10_000).then(
    () => true,
    () => false,
  );
  const observation = {
    sawToolFrameWithin10s: sawTool,
    approvalsSizeAtToolFrame: harness.approvals.size(),
    canaryAfterToolFrame: existsSync(CANARY),
    sideCanaryAfterToolFrame: existsSync(SIDE_CANARY),
  };
  // 绿态：在流还开着时真的发一次 approval 决策（红态注册表为空 → 必然 409）。
  const toolPayload = summarise(stream.chunks()).toolPayloads[0] ?? null;
  const callId = typeof toolPayload?.callId === 'string' ? toolPayload.callId : 'call_r3_probe';
  const approvalAt = Date.now();
  const registryBeforeDecision = harness.approvals.size();
  const decision = await harness.request('/api/v1/agent/approval', {
    method: 'POST',
    body: { sessionId: `s_${'a'.repeat(32)}`, callId, decision: 'approve' },
  });
  observation.approval = {
    httpStatus: decision.status,
    callId,
    registryBeforeDecision,
    registryAfterDecision: harness.approvals.size(),
    responseBody: decision.body ?? null,
    executed: decision.body?.executed ?? null,
    reason: decision.body?.reason ?? null,
    errorCode: decision.body?.error?.code ?? null,
    latencyMs: Date.now() - approvalAt,
  };
  // 等 done（绿态要等 provider 的 2 s 尾巴；红态 done 立刻到）。
  await stream.onData((text) => text.includes('event: done'), 20_000).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 120));
  const summary = summarise(stream.chunks());
  primary = {
    label: `real-chain/fake-provider(tool-call) · ${MODE}`,
    httpStatus: stream.response.statusCode,
    contentType: stream.response.headers['content-type'] ?? null,
    ...summary,
    elapsedMs: Date.now() - startedMs,
    providerOrigin: fake.origin,
    providerSawModel: fake.requests[0]?.body?.model ?? null,
    providerRequestedStream: fake.requests[0]?.body?.stream ?? null,
    providerBehavior: fake.requests[0]?.behavior ?? null,
    providerRequestCount: fake.requests.length,
    approvalsSizeAtToolFrame: observation.approvalsSizeAtToolFrame,
    approvalsSizeAfterDone: harness.approvals.size(),
    approval: observation.approval,
    canaryAfterToolFrame: observation.canaryAfterToolFrame,
    canaryExistsAfter: existsSync(CANARY),
    sideCanaryExistsAfter: existsSync(SIDE_CANARY),
    executedClaims: (stream.chunks().match(/"executed":true/gu) ?? []).length,
    approvalAuditLines: capture.lines().filter((line) => line.includes('approval recorded')).length,
  };
  stream.request.destroy();
  results.scenarios.push(primary);
  results.primary = {
    hostPath: BROKER_HOST,
    providerOrigin: fake.origin,
    gapMs: GAP_MS,
    expectedByAgent001: 'frames must include >=1 tool (or a non-200/error); must not be 200+done(tool_calls)+0 delta+0 tool',
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
              function: { name: PROFILE.toolCall.name, arguments: PROFILE.toolCall.arguments },
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
  hostPath: BROKER_HOST,
  settings: settingsFor(jsonProvider.baseUrl),
  logger: capture2.logger,
  sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
});
let secondary;
try {
  // 非流式兜底分支：整个响应一次给完，`done` 紧接着 tool 帧；注册表在 done 之后会被
  // releaseQuota→cancelSession 清掉（既有 daemon 行为），因此这里只断言 tool 帧本身。
  const response = await harness2.sse('/api/v1/agent/chat', {
    sessionId: `s_${'b'.repeat(32)}`,
    modelId: 'fake-tool-call',
    messages: [{ role: 'user', content: `write ${CANARY}` }],
  });
  secondary = {
    label: 'secondary/non-SSE JSON fallback (chat-transport :489-493)',
    httpStatus: response.status,
    ...summarise(response.text ?? ''),
    canaryExistsAfter: existsSync(CANARY),
    sideCanaryExistsAfter: existsSync(SIDE_CANARY),
  };
  results.scenarios.push(secondary);
} finally {
  await harness2.close();
  await jsonProvider.close();
}

// ------------------------------------------------------------------ expectations
if (MODE === 'red') {
  expectRow('REAL.httpStatus', 200, primary.httpStatus);
  expectRow('REAL.frames', ['usage', 'done'], primary.eventNames);
  expectRow('REAL.deltaFrames', 0, primary.deltaFrames);
  expectRow('REAL.toolFrames', 0, primary.toolFrames);
  expectRow('REAL.finishReason', 'tool_calls', primary.doneFinishReason);
  expectRow('REAL.errorCode', null, primary.errorCode);
  expectRow('REAL.approvalsSize', 0, primary.approvalsSizeAtToolFrame);
  expectRow('REAL.approvalLogLines', 0, primary.approvalAuditLines);
  expectRow('REAL.canaryAbsent', false, primary.canaryExistsAfter);
  expectRow('REAL.providerRequestedStream', true, primary.providerRequestedStream);
  expectRow('REAL.providerBehavior', 'tool-call', primary.providerBehavior);
  expectRow('JSONFALLBACK.httpStatus', 200, secondary.httpStatus);
  expectRow('JSONFALLBACK.toolFrames', 0, secondary.toolFrames);
  expectRow('JSONFALLBACK.deltaFrames', 0, secondary.deltaFrames);
  expectRow('JSONFALLBACK.finishReason', 'tool_calls', secondary.doneFinishReason);
  expectRow('JSONFALLBACK.canaryAbsent', false, secondary.canaryExistsAfter);
} else {
  const first = primary.toolPayloads[0] ?? null;
  expectRow('REAL.httpStatus', 200, primary.httpStatus);
  expectRow('REAL.toolFramesAtLeast1', true, primary.toolFrames >= 1);
  expectRow('REAL.framesIncludeTool', true, primary.eventNames.includes('tool'));
  expectRow('REAL.deltaFrames', 0, primary.deltaFrames);
  expectRow('REAL.finishReason', 'tool_calls', primary.doneFinishReason);
  expectRow('REAL.errorCode', null, primary.errorCode);
  expectRow('REAL.toolState', 'proposed', first?.state ?? null);
  expectRow('REAL.toolRequiresApproval', true, first?.requiresApproval ?? null);
  expectRow('REAL.toolArgumentsPath', CANARY, first?.arguments?.path ?? null);
  expectRow('REAL.toolCallIdGrammar', true, /^call_[A-Za-z0-9_-]{1,120}$/u.test(first?.callId ?? ''));
  expectRow('REAL.approvalsSizeAtToolFrame', 1, primary.approvalsSizeAtToolFrame);
  expectRow('REAL.approveHttpStatus', 200, primary.approval.httpStatus);
  expectRow('REAL.approveExecuted', false, primary.approval.executed);
  expectRow('REAL.approveReason', 'EXECUTION_DISABLED', primary.approval.reason);
  expectRow('REAL.approvalLogLines', 1, primary.approvalAuditLines);
  expectRow('REAL.executedClaims', 0, primary.executedClaims);
  expectRow('REAL.canaryAbsent', false, primary.canaryExistsAfter);
  expectRow('REAL.sideCanaryAbsent', false, primary.sideCanaryExistsAfter);
  expectRow('REAL.providerBehavior', 'tool-call', primary.providerBehavior);
  expectRow('JSONFALLBACK.httpStatus', 200, secondary.httpStatus);
  expectRow('JSONFALLBACK.toolFrames', 1, secondary.toolFrames);
  expectRow('JSONFALLBACK.finishReason', 'tool_calls', secondary.doneFinishReason);
  expectRow('JSONFALLBACK.canaryAbsent', false, secondary.canaryExistsAfter);
}

// 零外联自证：设置里唯一的 provider baseUrl 必须是 loopback，进程内不出现其它 host。
const hosts = [new URL(fake.baseUrl).hostname, new URL(jsonProvider.baseUrl).hostname];
results.outbound = {
  providerHosts: hosts,
  nonLoopback: hosts.filter((host) => !['127.0.0.1', 'localhost', '::1'].includes(host)).length,
  apiKeyEnvRead: false,
};

results.totals = {
  scenarios: results.scenarios.length,
  expectations: results.expectations.length,
  pass: results.expectations.filter((row) => row.pass === true).length,
  fail: results.expectations.filter((row) => row.pass !== true).length,
};
results.verdict = {
  mode: MODE,
  toolFrameReachableOnRealChain: primary.toolFrames >= 1,
  approvalChainReachableOnRealChain: primary.approvalsSizeAtToolFrame >= 1,
  silentSuccess: primary.httpStatus === 200 && primary.toolFrames === 0 && primary.errorCode === null,
  canaryAbsentAtEnd: existsSync(CANARY) === false,
};

results.canaryAtEnd = existsSync(CANARY);
rmSync(CANARY, { force: true });

const outFile = join(RAW_DIR, `real-chain-toolcall.${process.env.R3_RAW_TAG ?? MODE}.json`);
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  mode: MODE,
  brokerHost: BROKER_HOST,
  verdict: results.verdict,
  primary: {
    httpStatus: primary.httpStatus,
    frames: primary.eventNames,
    deltaFrames: primary.deltaFrames,
    toolFrames: primary.toolFrames,
    finishReason: primary.doneFinishReason,
    approvalsSizeAtToolFrame: primary.approvalsSizeAtToolFrame,
    approval: primary.approval,
    canaryExistsAfter: primary.canaryExistsAfter,
    sideCanaryExistsAfter: primary.sideCanaryExistsAfter,
  },
  secondary: { httpStatus: secondary.httpStatus, frames: secondary.eventNames, toolFrames: secondary.toolFrames },
  totals: results.totals,
  rawFile: outFile,
}, null, 2));
process.exitCode = results.totals.fail === 0 ? 0 : 1;
