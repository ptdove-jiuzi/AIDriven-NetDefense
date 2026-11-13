/**
 * AI-ENABLE · fake-provider 证据生成器（真实运行，不写"应该通过"）
 *
 * 做两件事：
 *   1. 用 native fetch 客户端真跑五种行为 + 模型映射 + 客户端 abort，记录「期望 vs 实际」；
 *   2. 真跑 `node --test tests/ai/fake-provider.test.js`（tap 报告器），解析真实 pass/fail 数。
 * 产物：evidence/ai/fake-provider/RESULT.json 与 test-run.log。
 *
 * 跑法：node tests/ai/emit-evidence.mjs
 * 注意：本文件有 main 守卫，被 node --test 当作普通模块 import 时不会执行任何副作用。
 *
 * @author PT-dove
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BEHAVIORS, startFakeProvider } from './fake-provider.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'evidence', 'ai', 'fake-provider');
const TEST_FILE = 'tests/ai/fake-provider.test.js';

const CANARY = 'fixture-not-a-real-provider-key-0001';
const TIMEOUT_HEADER_WINDOW_MS = 150;
const ABORT_THRESHOLD_MS = 3_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function collectStream(response) {
  const reader = response.body.getReader();
  let text = '';
  let error = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) text += Buffer.from(value).toString('utf8');
    }
  } catch (caught) {
    error = caught;
  }
  return { text, error };
}

function parseSse(text) {
  const payloads = [];
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice('data: '.length);
    if (raw === '[DONE]') {
      done = true;
      continue;
    }
    payloads.push(JSON.parse(raw));
  }
  const contents = payloads.flatMap((payload) =>
    (payload.choices ?? [])
      .map((choice) => choice?.delta?.content)
      .filter((value) => typeof value === 'string'));
  return { payloads, done, contents };
}

function postChat(provider, body, init = {}) {
  return fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CANARY}`,
      'x-fixture-source': 'tests/ai/emit-evidence.mjs',
    },
    body: JSON.stringify(body),
    ...init,
  });
}

async function scenarioDelta() {
  const chunks = ['alpha-', 'beta-', 'gamma'];
  const usage = { prompt_tokens: 7, completion_tokens: 11 };
  const provider = await startFakeProvider({ behaviors: { 'fixture-delta': 'delta' }, chunks, gapMs: 2, usage });
  try {
    const response = await postChat(provider, { model: 'fixture-delta', stream: true });
    const text = await response.text();
    const sse = parseSse(text);
    const usageFrame = sse.payloads.find((payload) => payload.usage !== undefined);
    const actual = {
      status: response.status,
      contentType: response.headers.get('content-type'),
      receivedText: sse.contents.join(''),
      expectedText: chunks.join(''),
      deltaFrameCount: sse.contents.length,
      usage: usageFrame?.usage ?? null,
      finishReason: sse.payloads.at(-1)?.choices?.[0]?.finish_reason ?? null,
      doneFramePresent: sse.done,
      requestCount: provider.count('/v1/chat/completions'),
      recordModel: provider.requests[0]?.model ?? null,
      recordStream: provider.requests[0]?.stream ?? null,
      recordStatusWritten: provider.requests[0]?.statusWritten ?? null,
      recordResponseEnded: provider.requests[0]?.responseEnded ?? null,
    };
    actual.pass = actual.status === 200
      && /^text\/event-stream/.test(actual.contentType ?? '')
      && actual.receivedText === actual.expectedText
      && actual.doneFramePresent === true
      && actual.usage !== null
      && actual.requestCount === 1;
    return actual;
  } finally {
    await provider.close();
  }
}

async function scenarioToolCall() {
  const toolCall = { name: 'lookup_alert', arguments: '{"alertId":"al-42","why":"explain"}' };
  const provider = await startFakeProvider({ behaviors: { 'fixture-tool': 'tool-call' }, toolCall });
  try {
    const response = await postChat(provider, { model: 'fixture-tool', stream: true });
    const sse = parseSse(await response.text());
    const toolFrame = sse.payloads.find((payload) => payload.choices?.[0]?.delta?.tool_calls !== undefined);
    const call = toolFrame?.choices?.[0]?.delta?.tool_calls?.[0] ?? null;
    const actual = {
      status: response.status,
      contentType: response.headers.get('content-type'),
      toolName: call?.function?.name ?? null,
      arguments: call?.function?.arguments ?? null,
      finishReason: sse.payloads.at(-1)?.choices?.[0]?.finish_reason ?? null,
      doneFramePresent: sse.done,
      requestCount: provider.count('/v1/chat/completions'),
      recordBehavior: provider.requests[0]?.behavior ?? null,
    };
    actual.pass = actual.status === 200
      && actual.toolName === toolCall.name
      && actual.arguments === toolCall.arguments
      && actual.finishReason === 'tool_calls'
      && actual.doneFramePresent === true
      && actual.requestCount === 1;
    return actual;
  } finally {
    await provider.close();
  }
}

async function scenarioRateLimit() {
  const provider = await startFakeProvider({ behaviors: { 'fixture-rate-limit': 'rate-limit' } });
  try {
    const response = await postChat(provider, { model: 'fixture-rate-limit', stream: true });
    const payload = await response.json();
    const actual = {
      status: response.status,
      contentType: response.headers.get('content-type'),
      errorType: payload?.error?.type ?? null,
      errorMessage: payload?.error?.message ?? null,
      requestCount: provider.count('/v1/chat/completions'),
      recordStatusWritten: provider.requests[0]?.statusWritten ?? null,
      recordResponseEnded: provider.requests[0]?.responseEnded ?? null,
    };
    actual.pass = actual.status === 429
      && /^application\/json/.test(actual.contentType ?? '')
      && actual.errorType === 'rate_limit_error'
      && actual.errorMessage === 'synthetic rate limit'
      && actual.requestCount === 1;
    return actual;
  } finally {
    await provider.close();
  }
}

async function scenarioTimeout() {
  const hangMs = 400;
  const provider = await startFakeProvider({ behaviors: { 'fixture-timeout': 'timeout' }, hangMs });
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(new Error('evidence guard fired')), 5_000);
  try {
    const startedAt = Date.now();
    const settled = postChat(provider, { model: 'fixture-timeout', stream: true }, { signal: controller.signal })
      .then((response) => ({ response }), (error) => ({ error }));

    const first = await Promise.race([
      settled.then(() => 'headers'),
      delay(TIMEOUT_HEADER_WINDOW_MS).then(() => 'no-headers'),
    ]);
    const outcome = await settled;
    const clientElapsedMs = Date.now() - startedAt;
    const record = await provider.waitForAbort(2_000);

    const actual = {
      headersWithinWindow: first === 'headers',
      headerWindowMs: TIMEOUT_HEADER_WINDOW_MS,
      clientFetchError: outcome.error?.name ?? null,
      clientElapsedMs,
      hangMs,
      recordStatusWritten: record.statusWritten,
      recordResponseEnded: record.responseEnded,
      recordClosedAfterMs: record.closedAfterMs,
      recordAbortedAtIsNull: record.abortedAt === null,
      requestCount: provider.count('/v1/chat/completions'),
    };
    actual.pass = actual.headersWithinWindow === false
      && outcome.error instanceof Error
      && actual.clientElapsedMs >= hangMs - 50
      && actual.recordStatusWritten === false
      && actual.recordResponseEnded === false
      && actual.recordAbortedAtIsNull === false
      && actual.requestCount === 1;
    return actual;
  } finally {
    clearTimeout(guard);
    controller.abort();
    await provider.close();
  }
}

async function scenarioTruncated() {
  const chunks = ['t1', 't2', 't3', 't4'];
  const provider = await startFakeProvider({
    behaviors: { 'fixture-truncated': 'truncated' },
    chunks,
    truncateAfterChunks: 2,
    gapMs: 2,
  });
  try {
    const response = await postChat(provider, { model: 'fixture-truncated', stream: true });
    const { text, error } = await collectStream(response);
    const sse = parseSse(text);
    const record = await provider.waitForAbort(2_000);

    const actual = {
      status: response.status,
      contentType: response.headers.get('content-type'),
      framesReceived: sse.payloads.length,
      firstFrameContent: sse.contents[0] ?? null,
      doneFramePresent: sse.done,
      readError: error === null ? null : (error.name ?? 'Error'),
      readErrorMatches: /terminated|aborted|ECONNRESET|socket/i.test(String(error?.message ?? '')),
      recordStatusWritten: record.statusWritten,
      recordResponseEnded: record.responseEnded,
      recordAbortedAtIsNull: record.abortedAt === null,
      requestCount: provider.count('/v1/chat/completions'),
    };
    actual.pass = actual.status === 200
      && actual.doneFramePresent === false
      && actual.framesReceived >= 1
      && actual.framesReceived <= 2
      && actual.readError !== null
      && actual.recordResponseEnded === false
      && actual.recordAbortedAtIsNull === false
      && actual.requestCount === 1;
    return actual;
  } finally {
    await provider.close();
  }
}

async function scenarioModelMapping() {
  const provider = await startFakeProvider({
    behaviors: { 'fixture-model-delta': 'delta', 'fixture-model-limit': 'rate-limit' },
    chunks: ['m1', 'm2'],
    defaultBehavior: 'delta',
  });
  try {
    const deltaResponse = await postChat(provider, { model: 'fixture-model-delta', stream: true });
    const deltaSse = parseSse(await deltaResponse.text());
    const limitResponse = await postChat(provider, { model: 'fixture-model-limit', stream: true });
    const limitBody = await limitResponse.json();
    const unknownResponse = await postChat(provider, { model: 'fixture-unregistered-model', stream: true });
    await unknownResponse.text();

    const actual = {
      modelA: 'fixture-model-delta',
      modelAStatus: deltaResponse.status,
      modelADone: deltaSse.done,
      modelAText: deltaSse.contents.join(''),
      modelB: 'fixture-model-limit',
      modelBStatus: limitResponse.status,
      modelBErrorType: limitBody?.error?.type ?? null,
      unregisteredModelStatus: unknownResponse.status,
      unregisteredBehavior: provider.requests[2]?.behavior ?? null,
      modelsSeen: provider.modelsSeen(),
      recordModels: provider.requests.map((record) => record.model),
      recordBehaviors: provider.requests.map((record) => record.behavior),
      requestCount: provider.count('/v1/chat/completions'),
    };
    actual.pass = actual.modelAStatus === 200
      && actual.modelADone === true
      && actual.modelAText === 'm1m2'
      && actual.modelBStatus === 429
      && actual.modelBErrorType === 'rate_limit_error'
      && actual.unregisteredBehavior === 'delta'
      && JSON.stringify(actual.modelsSeen) === JSON.stringify(['fixture-model-delta', 'fixture-model-limit', 'fixture-unregistered-model'])
      && JSON.stringify(actual.recordBehaviors) === JSON.stringify(['delta', 'rate-limit', 'delta'])
      && actual.requestCount === 3;
    return actual;
  } finally {
    await provider.close();
  }
}

async function scenarioSequential() {
  // Lead 报告的回归面：同一个 provider 实例连续打五种行为，truncated/timeout 之后
  // 同 origin 的下一条请求必须照常可用（不得出现 fetch failed / SocketError: other side closed）。
  const provider = await startFakeProvider({
    behaviors: {
      'seq-delta': 'delta',
      'seq-rate-limit': 'rate-limit',
      'seq-tool': 'tool-call',
      'seq-truncated': 'truncated',
      'seq-timeout': 'timeout',
    },
    chunks: ['s1-', 's2', 's3'],
    gapMs: 2,
    hangMs: 250,
    toolCall: { name: 'seq_lookup', arguments: '{"id":"a-1"}' },
  });
  const connectionErrors = [];
  const steps = [];
  try {
    const cleanPost = async (model) => {
      try {
        return await postChat(provider, { model, stream: true });
      } catch (error) {
        connectionErrors.push(`${model}: ${error?.name}: ${error?.message}`);
        return null;
      }
    };

    const deltaResponse = await cleanPost('seq-delta');
    const deltaSse = deltaResponse === null ? null : parseSse(await deltaResponse.text());
    steps.push({ step: 'delta', status: deltaResponse?.status ?? null });

    const truncatedResponse = await cleanPost('seq-truncated');
    let truncatedReadError = null;
    if (truncatedResponse !== null) {
      const read = await collectStream(truncatedResponse);
      truncatedReadError = read.error?.name ?? null;
      if (parseSse(read.text).done !== false) connectionErrors.push('truncated 出现了 [DONE]');
    }
    steps.push({ step: 'truncated', status: truncatedResponse?.status ?? null, readError: truncatedReadError });

    const afterTruncated = await cleanPost('seq-delta');
    const afterTruncatedSse = afterTruncated === null ? null : parseSse(await afterTruncated.text());
    steps.push({ step: 'delta-after-truncated', status: afterTruncated?.status ?? null, done: afterTruncatedSse?.done ?? null });

    const timeoutSettled = postChat(provider, { model: 'seq-timeout', stream: true }).then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
    const first = await Promise.race([
      timeoutSettled.then(() => 'headers'),
      delay(TIMEOUT_HEADER_WINDOW_MS).then(() => 'no-headers'),
    ]);
    const timeoutOutcome = await timeoutSettled;
    steps.push({
      step: 'timeout',
      headersWithinWindow: first === 'headers',
      fetchError: timeoutOutcome.error?.name ?? null,
    });

    const afterTimeout = await cleanPost('seq-delta');
    const afterTimeoutSse = afterTimeout === null ? null : parseSse(await afterTimeout.text());
    steps.push({ step: 'delta-after-timeout', status: afterTimeout?.status ?? null, done: afterTimeoutSse?.done ?? null });

    const limitedResponse = await cleanPost('seq-rate-limit');
    const limitedPayload = limitedResponse === null ? null : await limitedResponse.json();
    steps.push({ step: 'rate-limit', status: limitedResponse?.status ?? null, errorType: limitedPayload?.error?.type ?? null });

    const toolResponse = await cleanPost('seq-tool');
    const toolSse = toolResponse === null ? null : parseSse(await toolResponse.text());
    const toolName = toolSse?.payloads
      ?.find((payload) => payload.choices?.[0]?.delta?.tool_calls !== undefined)
      ?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name ?? null;
    steps.push({ step: 'tool-call', status: toolResponse?.status ?? null, toolName });

    const actual = {
      sequence: ['delta', 'truncated', 'delta', 'timeout', 'delta', 'rate-limit', 'tool-call'],
      steps,
      connectionErrors,
      requestCount: provider.count('/v1/chat/completions'),
      recordBehaviors: provider.requests.map((record) => record.behavior),
      modelsSeen: provider.modelsSeen(),
    };
    actual.pass = actual.connectionErrors.length === 0
      && actual.requestCount === 7
      && actual.steps[0].status === 200
      && actual.steps[1].status === 200
      && actual.steps[1].readError !== null
      && actual.steps[2].status === 200
      && actual.steps[2].done === true
      && actual.steps[3].headersWithinWindow === false
      && actual.steps[4].status === 200
      && actual.steps[4].done === true
      && actual.steps[5].status === 429
      && actual.steps[6].status === 200
      && actual.steps[6].toolName === 'seq_lookup';
    return actual;
  } finally {
    await provider.close();
  }
}

async function scenarioAbort() {
  const chunks = Array.from({ length: 20 }, (_, index) => `chunk-${index}-`);
  const provider = await startFakeProvider({ behaviors: { 'fixture-abort': 'delta' }, chunks, gapMs: 50 });
  try {
    const controller = new AbortController();
    const response = await postChat(provider, { model: 'fixture-abort', stream: true }, { signal: controller.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    const abortAt = Date.now();
    controller.abort();
    const aborted = await provider.waitForAbort(ABORT_THRESHOLD_MS);
    const measuredMs = Date.now() - abortAt;
    const rest = await reader.read().then((value) => ({ value }), (error) => ({ error }));

    const actual = {
      firstFrameBeforeAbort: first.done === false,
      waitForAbortThresholdMs: ABORT_THRESHOLD_MS,
      measuredMs,
      withinThreshold: measuredMs < ABORT_THRESHOLD_MS,
      abortedAtIsNull: aborted.abortedAt === null,
      responseEnded: aborted.responseEnded,
      statusWritten: aborted.statusWritten,
      recordModel: aborted.model,
      requestCount: provider.count('/v1/chat/completions'),
      restOfStreamErroredOrEnded: rest.error instanceof Error || rest.value?.done === true,
    };
    actual.pass = actual.firstFrameBeforeAbort === true
      && actual.withinThreshold === true
      && actual.abortedAtIsNull === false
      && actual.responseEnded === false
      && actual.statusWritten === true
      && actual.restOfStreamErroredOrEnded === true
      && actual.requestCount === 1;
    return actual;
  } finally {
    await provider.close();
  }
}

async function scenarioPortsAndKeys() {
  const provider = await startFakeProvider();
  try {
    const response = await postChat(provider, { model: 'any-fixture-model', stream: true });
    await response.text();
    const sourcePath = path.join(HERE, 'fake-provider.mjs');
    const source = await readFile(sourcePath, 'utf8');
    const actual = {
      port: provider.port,
      origin: provider.origin,
      baseUrl: provider.baseUrl,
      hostIsLoopback: new URL(provider.origin).hostname === '127.0.0.1',
      portAvoidedPerfRange: provider.port < 17_900 || provider.port > 17_999,
      authorizationSeenByServer: provider.requests[0]?.headers?.authorization ?? null,
      canaryShape: /^fixture-not-a-real-provider-key-/.test(CANARY),
      moduleHasSkShape: /sk-[A-Za-z0-9]{16,}/.test(source),
      moduleHasExternalProviderHost: /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/.test(source),
    };
    actual.pass = actual.hostIsLoopback === true
      && actual.portAvoidedPerfRange === true
      && actual.baseUrl === `${actual.origin}/v1`
      && actual.authorizationSeenByServer === `Bearer ${CANARY}`
      && actual.canaryShape === true
      && actual.moduleHasSkShape === false
      && actual.moduleHasExternalProviderHost === false;
    return actual;
  } finally {
    await provider.close();
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hashFiles(relativePaths) {
  const result = {};
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    const buffer = await readFile(absolutePath);
    result[relativePath] = { sha256: sha256(buffer), bytes: buffer.byteLength };
  }
  return result;
}

function runTestSuite() {
  const command = `node --test --test-reporter=tap ${TEST_FILE}`;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', TEST_FILE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.status === null ? -1 : result.status;

  const counts = { tests: null, pass: null, fail: null, skipped: null, duration_ms: null };
  for (const match of stdout.matchAll(/^# (tests|pass|fail|skipped|duration_ms) (\d+(?:\.\d+)?)$/gm)) {
    const key = match[1];
    counts[key] = key === 'duration_ms' ? Number(match[2]) : Number(match[2]);
  }

  const log = [
    `$ ${command}`,
    `cwd: ${REPO_ROOT}`,
    `started_at: ${nowIso()}`,
    '',
    '--- stdout ---',
    stdout,
    '--- stderr ---',
    stderr,
    `--- exit_code: ${exitCode} ---`,
    '',
  ].join('\n');

  return { command, exitCode, counts, log, spawnError: result.error ? String(result.error.message) : null };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const behaviors = [];
  behaviors.push({
    behavior: 'delta',
    expected: '200 text/event-stream；data 帧增量拼接 === chunks.join(\'\')；末帧带 usage；最后 data: [DONE]',
    actual: await scenarioDelta(),
  });
  behaviors.push({
    behavior: 'tool-call',
    expected: '200 SSE；出现 delta.tool_calls[0].function.name/arguments；finish_reason=tool_calls；最后 [DONE]',
    actual: await scenarioToolCall(),
  });
  behaviors.push({
    behavior: 'rate-limit',
    expected: '429 application/json；error.type=rate_limit_error；error.message=synthetic rate limit',
    actual: await scenarioRateLimit(),
  });
  behaviors.push({
    behavior: 'timeout',
    expected: `150 ms 内拿不到响应头；hangMs 到点后连接被 destroy；statusWritten=false、responseEnded=false`,
    actual: await scenarioTimeout(),
  });
  behaviors.push({
    behavior: 'truncated',
    expected: '200 SSE；写 truncateAfterChunks(=2) 帧后 destroy；无 [DONE]；客户端读流报错；responseEnded=false',
    actual: await scenarioTruncated(),
  });

  const modelMapping = await scenarioModelMapping();
  const sequentialSameInstance = await scenarioSequential();
  const abort = await scenarioAbort();
  const zeroEgress = await scenarioPortsAndKeys();

  const behaviorRows = behaviors.map(({ behavior, expected, actual }) => ({
    behavior,
    expected,
    actual,
    requestCount: actual.requestCount,
    pass: actual.pass === true,
  }));

  const suite = runTestSuite();
  await writeFile(path.join(OUT_DIR, 'test-run.log'), suite.log, 'utf8');

  const files = await hashFiles([
    'tests/ai/fake-provider.mjs',
    'tests/ai/fake-provider.test.js',
    'tests/ai/README.md',
    'tests/ai/emit-evidence.mjs',
  ]);

  const allBehaviorsDistinguishable = behaviorRows.every((row) => row.pass === true);
  const verdict = {
    allFiveBehaviorsClientDistinguishable: allBehaviorsDistinguishable,
    modelToBehaviorMappingIndependent: modelMapping.pass === true,
    sequentialSameInstanceNoConnectionError: sequentialSameInstance.pass === true,
    abortWithinThreshold: abort.pass === true,
    abortMeasuredMs: abort.measuredMs,
    portIsLoopbackEphemeral: zeroEgress.pass === true,
    noRealKeyOrExternalHost: zeroEgress.pass === true,
    testSuiteGreen: suite.exitCode === 0 && suite.counts.fail === 0 && (suite.counts.tests ?? 0) > 0,
  };

  const result = {
    task_id: 'AI-ENABLE',
    seat: 'fake-provider',
    contract_version: 'v1',
    author: 'PT-dove',
    generated_at: nowIso(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cwd: REPO_ROOT,
    },
    contract: {
      behaviors: [...BEHAVIORS],
      module: 'tests/ai/fake-provider.mjs',
      entrypoints: ['POST /v1/chat/completions', 'GET /v1/models'],
    },
    files,
    command: {
      text: suite.command,
      cwd: REPO_ROOT,
      exit_code: suite.exitCode,
      spawn_error: suite.spawnError,
      tests: suite.counts.tests,
      pass: suite.counts.pass,
      fail: suite.counts.fail,
      skipped: suite.counts.skipped,
      duration_ms: suite.counts.duration_ms,
      log: 'evidence/ai/fake-provider/test-run.log',
    },
    behaviors: behaviorRows,
    modelMapping: {
      expected: '同一服务器 model=A→delta、model=B→rate-limit 各自独立；未登记 model 用 defaultBehavior',
      actual: modelMapping,
      pass: modelMapping.pass === true,
    },
    sequentialSameInstance: {
      expected: '同一 provider 实例连续打五种行为可区分；truncated/timeout 之后同 origin 下一条请求照常可用，无 fetch failed / SocketError',
      actual: sequentialSameInstance,
      pass: sequentialSameInstance.pass === true,
    },
    abort: {
      expected: '客户端 abort 后 waitForAbort() 在 3000 ms 内返回；abortedAt 非空、responseEnded=false',
      actual: abort,
      pass: abort.pass === true,
    },
    zeroEgress: {
      expected: '端口 127.0.0.1:0（不在 17900–17999）；测试/模块内无真实 key、无外部 provider 主机名',
      actual: zeroEgress,
      pass: zeroEgress.pass === true,
    },
    verdict,
    unverified: [
      'Lead 报告的「truncated 后同 origin timeout 直接 fetch failed」未能在本机复现：关掉 connection: close 后，仍试过四种客户端退出方式（不读响应体 / 读一帧后 cancel / 读到错误 / 读一帧后不 cancel），均未出现连接级失败。修复按防御性口径落地（不可复用的连接显式 connection: close），并用 7 步同实例序列回归覆盖；若 Lead 有更具体的失败脚本，以那份为准复核。',
      '只在 Windows / 本机回环 127.0.0.1 上验证；未在 Linux/macOS 复跑（本席写域只到 tests/ai/**）。',
      '未验证任何真实 provider（零外联硬约束，测试永不使用真 key）；真实 provider 的行为差异不在本证据范围内。',
      '未验证 HTTP/2、TLS、代理链路：假端点只提供 HTTP/1.1 回环。',
      '非流式分支（stream:false 的 delta/tool-call → 完整 JSON）是契约扩展，目前没有下游消费者覆盖。',
      '时间相关断言使用 hangMs=250/400、gapMs=2/50 等本机实测参数；未在极端负载机器上做抖动统计（已连续复跑全绿）。',
    ],
    replay: [
      'node --test tests/ai/fake-provider.test.js',
      'node tests/ai/emit-evidence.mjs',
    ],
  };

  await writeFile(path.join(OUT_DIR, 'RESULT.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`[fake-provider] tests=${suite.counts.tests} pass=${suite.counts.pass} fail=${suite.counts.fail} skipped=${suite.counts.skipped} exit=${suite.exitCode}`);
  for (const row of behaviorRows) {
    console.log(`[fake-provider] ${row.behavior}: ${row.pass ? 'PASS' : 'FAIL'} (requests=${row.requestCount})`);
  }
  console.log(`[fake-provider] modelMapping=${modelMapping.pass ? 'PASS' : 'FAIL'} sequential=${sequentialSameInstance.pass ? 'PASS' : 'FAIL'} abort=${abort.pass ? 'PASS' : 'FAIL'} abortMs=${abort.measuredMs} zeroEgress=${zeroEgress.pass ? 'PASS' : 'FAIL'}`);
  console.log(`[fake-provider] RESULT -> ${path.join(OUT_DIR, 'RESULT.json')}`);

  if (!verdict.testSuiteGreen || !verdict.allFiveBehaviorsClientDistinguishable || !verdict.modelToBehaviorMappingIndependent || !verdict.sequentialSameInstanceNoConnectionError || !verdict.abortWithinThreshold || !verdict.portIsLoopbackEphemeral) {
    process.exitCode = 1;
  }
}

// 只在"人手动执行"时跑；被 node --test（NODE_TEST_CONTEXT=child-v8）当普通文件装载时不产生副作用。
const isDirectRun = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && process.env.NODE_TEST_CONTEXT === undefined;

if (isDirectRun) {
  main().catch((error) => {
    console.error('[fake-provider] evidence failed:', error);
    process.exitCode = 1;
  });
}
