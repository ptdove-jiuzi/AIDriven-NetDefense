/**
 * ai-explain-chain.test.js — AI-ENABLE L1/L3：告警 → 讲解的**行为**证明（真链路）。
 *
 * 链路（没有任何 stub）：
 *
 *   daemon(createControlApi) ──broker-client──▶ 真 apps/model-broker/bin/console-host.js
 *     ──chat-transport──▶ 127.0.0.1 假 provider（tests/ai/fake-provider.mjs，真 HTTP/SSE）
 *
 * 因此"请求真的发出去了"由假 provider 的请求日志证明，而不是由 daemon 的返回值自证。
 * 零外联：provider 一律是 `127.0.0.1:0`；测试里没有真实 key（loopback 不需要凭据）。
 *
 * 覆盖：成功链路（含逐 delta 到达时间）/ prompt 围栏 / 五类 provider 响应 / 取消断连 /
 *       severity 三档真切换 + 超限不静默升档 / selectExplainRoute 判据单测。
 *
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startFakeProvider } from '../ai/fake-provider.mjs';
import {
  CSRF_HEADER,
  TEST_TOKEN,
  createCaptureLogger,
  makeTempDir,
  parseSseText,
  processLiveness,
  settingsDocument,
  startConsoleApi,
  waitFor,
} from './console-fixtures.mjs';
import {
  createAlertLookup,
  createEscalationHistory,
  createExplainHandlers,
  createExplainLimiter,
  routingJudgeStatus,
  selectExplainRoute,
} from '../../apps/daemon/src/api/explain.js';
import { createBrokerClient } from '../../apps/daemon/src/api/broker-client.js';
import { createChatEngine } from '../../apps/daemon/src/api/chat-engine.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The real broker host: the chain must not be short-circuited by the stub. */
const HOST_PATH = join(REPO_ROOT, 'apps', 'model-broker', 'bin', 'console-host.js');

/** Generous SSE budget: a real child process spawns per turn on a busy machine. */
const SSE_OPTIONS = Object.freeze({ idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 });

/** Resolve the fake-provider model id per behaviour (all on one loopback server). */
const MODEL_IDS = Object.freeze({
  watch: 'fake-watch',
  triage: 'fake-triage',
  respond: 'fake-respond',
  toolCall: 'fake-tool-call',
  rateLimit: 'fake-rate-limit',
  timeout: 'fake-timeout',
  truncated: 'fake-truncated',
});

/**
 * Alert row carrying **canaries** in every field the projection must drop.
 *
 * `event_ids` / `canonical_json` / `raw` are exactly what §2.6 forbids from travelling;
 * the values are unique strings so "0 hits in the outbound body" is a real assertion.
 */
const ALERT = Object.freeze({
  alert_id: 'a_ai_explain_1',
  rule_id: 'proc.suspicious-start',
  rule_version: '1.0.0',
  severity: 'high',
  status: 'new',
  count: 3,
  first_seen: '2026-11-04T00:00:00.000Z',
  last_seen: '2026-11-04T00:05:00.000Z',
  window_start: '2026-11-04T00:00:00.000Z',
  window_end: '2026-11-04T00:15:00.000Z',
  event_ids: ['evt-canary-4c1f9a', 'evt-canary-77b2e0'],
  event_ids_truncated: false,
  canonical_json: '{"canary":"canonical-canary-5d3b"}',
  raw: 'raw-body-canary-9e8d7c',
});

/** The strings that must never appear in an outbound provider request. */
const CANARIES = Object.freeze([
  'evt-canary-4c1f9a',
  'evt-canary-77b2e0',
  'event_ids',
  'canonical-canary-5d3b',
  'canonical_json',
  'raw-body-canary-9e8d7c',
]);

function alertWith(overrides) {
  return { ...ALERT, ...overrides };
}

/**
 * Settings document pointing every model id at the fake provider.
 *
 * `defaultTier: watch` mirrors the shipped defaults; escalation is left enabled so the
 * judge has something to decide.
 *
 * @param {object} fake Fake provider handle.
 * @param {{escalation?: object, routing?: object}} [overrides] Routing overrides.
 * @returns {object} Settings document.
 */
function aiSettings(fake, overrides = {}) {
  const model = (id, tier) => ({
    id,
    providerId: 'fake-provider',
    tier,
    maxInputTokens: 4096,
    maxOutputTokens: 512,
    costClass: 'free-local',
  });
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
      models: [
        model(MODEL_IDS.watch, 'watch'),
        model(MODEL_IDS.triage, 'triage'),
        model(MODEL_IDS.respond, 'respond'),
        model(MODEL_IDS.toolCall, 'watch'),
        model(MODEL_IDS.rateLimit, 'watch'),
        model(MODEL_IDS.timeout, 'watch'),
        model(MODEL_IDS.truncated, 'watch'),
      ],
      routing: {
        mode: 'tiered',
        uniformModelId: null,
        defaultTier: 'watch',
        escalation: {
          enabled: true,
          minSeverity: 'high',
          cooldownSeconds: 300,
          maxEscalationsPerHour: 20,
          ...(overrides.escalation ?? {}),
        },
        ...(overrides.routing ?? {}),
      },
    },
  });
}

/**
 * Start the real console stack against the real host and the fake provider.
 *
 * @param {object} fake Fake provider.
 * @param {{alerts?: object[], settings?: object, logger?: object, explainLimits?: object}} [options] Options.
 * @returns {Promise<object>} Harness.
 */
function startChain(fake, options = {}) {
  return startConsoleApi({
    hostPath: HOST_PATH,
    settings: options.settings ?? aiSettings(fake),
    alerts: options.alerts ?? [ALERT],
    logger: options.logger,
    explainLimits: options.explainLimits ?? { perAlert: 1, perMinute: 50 },
    sseOptions: SSE_OPTIONS,
    approvalTimeoutMs: 5_000,
  });
}

/**
 * Open an SSE POST and record **(arrival time, buffer)** for every TCP chunk.
 *
 * The timestamps are what makes "逐字上屏" a measurement rather than a claim: if the
 * provider's deltas were buffered into one write, every delta would share one arrival time.
 *
 * @param {number} port Bound daemon port.
 * @param {string} pathname Path.
 * @param {object} body JSON body.
 * @param {{token: string, csrf: string}} auth Auth.
 * @returns {Promise<object>} Timed stream handle.
 */
function openTimedSse(port, pathname, body, auth) {
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.token}`,
        [CSRF_HEADER]: auth.csrf,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      /** @type {{at: number, text: string}[]} */
      const samples = [];
      let buffer = '';
      /** @type {{check: Function}[]} */
      const waiters = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        samples.push({ at: Date.now(), text: buffer });
        for (const waiter of [...waiters]) {
          waiter.check();
        }
      });
      response.on('end', () => {
        for (const waiter of [...waiters]) {
          waiter.check();
        }
      });
      resolve({
        request,
        response,
        status: () => response.statusCode,
        headers: () => response.headers,
        samples: () => samples,
        text: () => buffer,
        events: () => parseSseText(buffer).events,
        comments: () => parseSseText(buffer).comments,
        /**
         * Wait until `predicate(buffer)` holds (or the stream ended).
         *
         * @param {(text: string) => boolean} predicate Condition.
         * @param {number} [timeoutMs] Budget.
         * @param {string} [label] Failure label.
         * @returns {Promise<string>} Buffer at match time.
         */
        waitFor(predicate, timeoutMs = 15_000, label = 'sse data') {
          if (predicate(buffer)) {
            return Promise.resolve(buffer);
          }
          return new Promise((resolveWait, rejectWait) => {
            const waiter = { check: null };
            const timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              rejectWait(new Error(`timed out waiting for ${label} (buffered ${buffer.length} bytes)`));
            }, timeoutMs);
            timer.unref?.();
            waiter.check = () => {
              if (predicate(buffer) !== true) {
                return;
              }
              clearTimeout(timer);
              waiters.splice(waiters.indexOf(waiter), 1);
              resolveWait(buffer);
            };
            waiters.push(waiter);
          });
        },
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

/**
 * Arrival time of each complete `event: delta` frame.
 *
 * @param {{at: number, text: string}[]} samples Chunk samples in arrival order.
 * @returns {number[]} Epoch-ms per delta frame, ascending.
 */
function deltaArrivals(samples) {
  const times = [];
  for (const sample of samples) {
    const seen = (sample.text.match(/event: delta/gu) ?? []).length;
    while (times.length < seen) {
      times.push(sample.at);
    }
  }
  return times;
}

/** Behaviour map for one fake provider covering all five contract behaviours. */
function allBehaviours() {
  return {
    [MODEL_IDS.watch]: 'delta',
    [MODEL_IDS.triage]: 'delta',
    [MODEL_IDS.respond]: 'delta',
    [MODEL_IDS.toolCall]: 'tool-call',
    [MODEL_IDS.rateLimit]: 'rate-limit',
    [MODEL_IDS.timeout]: 'timeout',
    [MODEL_IDS.truncated]: 'truncated',
  };
}

describe('AI-ENABLE L1 · 告警 → 讲解（真 console-host + 假 provider）', () => {
  it('成功链路：alert id → 取告警 → 组 prompt → ≥2 个 delta 逐帧到达 → done', async (t) => {
    const fake = await startFakeProvider({
      behaviors: { [MODEL_IDS.triage]: 'delta' },
      chunks: ['Al', 'ert ', 'expla', 'ined ', 'ok.'],
      gapMs: 90,
    });
    t.after(() => fake.close());
    const capture = createCaptureLogger();
    const harness = await startChain(fake, { logger: capture.logger });
    t.after(() => harness.close());

    const stream = await openTimedSse(
      harness.address.port,
      '/api/v1/alerts/a_ai_explain_1/explain',
      {},
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    t.after(() => stream.request.destroy());
    await stream.waitFor((text) => text.includes('event: done'), 20_000, 'done frame');

    // ---- HTTP + framing -------------------------------------------------
    assert.equal(stream.status(), 200);
    assert.match(String(stream.headers()['content-type']), /text\/event-stream/u);
    const events = stream.events();
    const names = events.map((event) => event.event);
    assert.ok(names.filter((name) => name === 'delta').length >= 2, `expected >=2 deltas, got ${JSON.stringify(names)}`);
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.alertId, 'a_ai_explain_1');
    assert.equal(events.at(-1).data.finishReason, 'stop');
    // "逐字上屏": every data line is one single-line JSON object.
    for (const event of events) {
      assert.equal(event.raw.includes('\n'), false, `frame is not single-line: ${event.raw.slice(0, 80)}`);
    }
    const deltaTexts = events.filter((event) => event.event === 'delta').map((event) => event.data.text);
    assert.equal(deltaTexts.join(''), 'Alert explained ok.');

    // ---- 逐帧到达时间序列（不是一次性吐完）-------------------------------
    const arrivals = deltaArrivals(stream.samples());
    assert.ok(arrivals.length >= 2, `delta arrivals: ${JSON.stringify(arrivals)}`);
    const spread = arrivals.at(-1) - arrivals[0];
    assert.ok(spread >= 150, `deltas must arrive incrementally (spread ${spread}ms over ${arrivals.length} frames)`);

    // ---- 假 provider 侧：请求真的发出去了 --------------------------------
    await fake.waitForRequests(1, 5_000);
    assert.equal(fake.requests.length, 1, 'exactly one provider request for one explanation');
    const request = fake.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.stream, true);
    assert.equal(request.model, MODEL_IDS.triage, 'severity=high must route to the triage model');
    assert.deepEqual(fake.modelsSeen(), [MODEL_IDS.triage]);

    // ---- prompt 内容：规则 / 严重度 / 窗口 / 证据计数 ---------------------
    const messages = request.body.messages;
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user']);
    const prompt = messages[1].content;
    for (const needle of [
      'rule_id: "proc.suspicious-start"',
      'severity: "high"',
      'window_start: "2026-11-04T00:00:00.000Z"',
      'window_end: "2026-11-04T00:15:00.000Z"',
      'evidence_count: 2',
    ]) {
      assert.ok(prompt.includes(needle), `prompt must carry ${needle}; got:\n${prompt}`);
    }

    // ---- 分级证据：tier/model 真的到了 provider --------------------------
    const routeLines = capture.lines().filter((line) => line.includes('explain.route'));
    assert.equal(routeLines.length, 1);
    const route = JSON.parse(routeLines[0]);
    assert.equal(route.tier, 'triage');
    assert.equal(route.modelId, MODEL_IDS.triage);
    assert.equal(route.source, 'selectRoute');
    assert.equal(route.escalate, true);
    assert.equal(route.reason, 'severity-escalation');

    // ---- 到达时间序列落进断言消息，供证据引用 ----------------------------
    t.diagnostic(`delta arrival offsets(ms)=${JSON.stringify(arrivals.map((at) => at - arrivals[0]))}`);
  });

  it('prompt 围栏：event_ids / canonical_json / raw 原文在 provider 请求体命中 0 次', async (t) => {
    const fake = await startFakeProvider({ behaviors: { [MODEL_IDS.triage]: 'delta' }, chunks: ['ok'], gapMs: 10 });
    t.after(() => fake.close());
    const harness = await startChain(fake);
    t.after(() => harness.close());

    const response = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', {});
    assert.equal(response.status, 200);
    await fake.waitForRequests(1, 5_000);
    const outbound = fake.requests[0].rawBody;

    // 期望 vs 实际：每个 canary 的命中数必须是 0。
    const hits = Object.fromEntries(CANARIES.map((needle) => [needle, outbound.split(needle).length - 1]));
    for (const needle of CANARIES) {
      assert.equal(hits[needle], 0, `expected 0 hits, got ${hits[needle]} for ${JSON.stringify(needle)} in the outbound body`);
    }
    // 正向对照：投影字段确实发出了（否则"0 命中"可能只是没发东西）。
    assert.ok(outbound.includes('proc.suspicious-start'));
    assert.ok(outbound.includes('a_ai_explain_1'));
    assert.ok(outbound.includes('evidence_count: 2'));
    t.diagnostic(`canary hits=${JSON.stringify(hits)}`);
  });
});

describe('AI-ENABLE L1 · 五类 provider 响应各跑一次', () => {
  it('delta：2 个 delta + usage + done(stop)', async (t) => {
    const fake = await startFakeProvider({
      behaviors: { [MODEL_IDS.triage]: 'delta' },
      chunks: ['chunk-1', 'chunk-2'],
      gapMs: 20,
    });
    t.after(() => fake.close());
    const harness = await startChain(fake);
    t.after(() => harness.close());

    const response = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', {});
    assert.equal(response.status, 200);
    const names = response.events.map((event) => event.event);
    assert.deepEqual(names, ['delta', 'delta', 'usage', 'done']);
    assert.equal(response.events[2].data.totalTokens, 46);
    assert.equal(response.events.at(-1).data.finishReason, 'stop');
    t.diagnostic(`delta: http=${response.status} frames=${JSON.stringify(names)}`);
  });

  it('tool-call：provider 只发 tool_calls 时不伪造正文；done.finishReason=tool_calls（无 tool 帧）', async (t) => {
    const fake = await startFakeProvider({ behaviors: { [MODEL_IDS.toolCall]: 'tool-call' } });
    t.after(() => fake.close());
    const harness = await startChain(fake);
    t.after(() => harness.close());

    const response = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', { modelId: MODEL_IDS.toolCall });
    assert.equal(response.status, 200);
    const names = response.events.map((event) => event.event);
    // 实测（本文件段末的"未闭环"说明）：chat-transport 只翻译 delta.content，
    // 真实 provider 的 tool_calls 不会变成 daemon 的 `tool` 帧。
    assert.equal(names.includes('tool'), false, 'real transport does not surface tool frames');
    assert.equal(names.filter((name) => name === 'delta').length, 0, 'no text may be invented for a tool call');
    assert.equal(response.events.at(-1).event, 'done');
    assert.equal(response.events.at(-1).data.finishReason, 'tool_calls');
    assert.deepEqual(fake.modelsSeen(), [MODEL_IDS.toolCall]);
    t.diagnostic(`tool-call: http=${response.status} frames=${JSON.stringify(names)} finishReason=${response.events.at(-1).data.finishReason}`);
  });

  it('rate-limit：provider 429 → SSE error UPSTREAM_FAILED（无 done）', async (t) => {
    const fake = await startFakeProvider({ behaviors: { [MODEL_IDS.rateLimit]: 'rate-limit' } });
    t.after(() => fake.close());
    const harness = await startChain(fake);
    t.after(() => harness.close());

    const response = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', { modelId: MODEL_IDS.rateLimit });
    assert.equal(response.status, 200, 'the SSE header is already sent when the provider answers');
    const events = response.events;
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.code, 'UPSTREAM_FAILED');
    assert.equal(events.at(-1).data.retryable, true);
    assert.equal(events.some((event) => event.event === 'done'), false);
    assert.equal(fake.requests[0].behavior, 'rate-limit');
    t.diagnostic(`rate-limit: providerBehavior=${fake.requests[0].behavior} http=${response.status} sseCode=${events.at(-1).data.code}`);
  });

  it('timeout：provider 不回话 → SSE error UPSTREAM_TIMEOUT（实测 ~8s 头超时）', async (t) => {
    const fake = await startFakeProvider({
      behaviors: { [MODEL_IDS.timeout]: 'timeout' },
      hangMs: 15_000,
    });
    t.after(() => fake.close());
    const harness = await startChain(fake);
    t.after(() => harness.close());

    const startedMs = Date.now();
    // The daemon's chat SSE helper caps at 10s and the transport's header deadline is 8s,
    // so the timed reader is used to keep the measurement honest.
    const stream = await openTimedSse(
      harness.address.port,
      '/api/v1/alerts/a_ai_explain_1/explain',
      { modelId: MODEL_IDS.timeout },
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    t.after(() => stream.request.destroy());
    await stream.waitFor((text) => text.includes('event: error'), 20_000, 'timeout error frame');
    const elapsedMs = Date.now() - startedMs;
    assert.equal(stream.status(), 200);
    const events = stream.events();
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.code, 'UPSTREAM_TIMEOUT');
    assert.equal(events.some((event) => event.event === 'done'), false);
    assert.equal(fake.requests[0].behavior, 'timeout');
    t.diagnostic(`timeout: http=${stream.status()} sseCode=${events.at(-1).data.code} elapsedMs=${elapsedMs}`);
  });

  it('truncated：半截断流不得被当成功（不得出现 done 帧）', async (t) => {
    const fake = await startFakeProvider({
      behaviors: { [MODEL_IDS.truncated]: 'truncated' },
      chunks: ['half-1', 'half-2'],
      gapMs: 20,
      truncateAfterChunks: 2,
    });
    t.after(() => fake.close());
    const harness = await startChain(fake);
    t.after(() => harness.close());

    const response = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', { modelId: MODEL_IDS.truncated });
    assert.equal(response.status, 200);
    const events = response.events;
    const names = events.map((event) => event.event);
    assert.equal(names.filter((name) => name === 'delta').length, 2, `two half frames, got ${JSON.stringify(names)}`);
    assert.equal(events.some((event) => event.event === 'done'), false, 'a truncated stream must never be reported as done');
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.code, 'UPSTREAM_FAILED');
    assert.equal(response.text.includes('event: done'), false);
    t.diagnostic(`truncated: http=${response.status} frames=${JSON.stringify(names)} sseCode=${events.at(-1).data.code}`);
  });
});

describe('AI-ENABLE L1 · 取消（客户端 abort）', () => {
  it('读到首个 delta 后 abort → 假 provider 3000ms 内记录 abortedAt，且无 broker 子进程泄漏', async (t) => {
    const fake = await startFakeProvider({
      behaviors: { [MODEL_IDS.triage]: 'delta' },
      chunks: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
      gapMs: 250,
    });
    t.after(() => fake.close());
    const harness = await startChain(fake);
    t.after(() => harness.close());

    const stream = await openTimedSse(
      harness.address.port,
      '/api/v1/alerts/a_ai_explain_1/explain',
      {},
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    t.after(() => stream.request.destroy());
    await stream.waitFor((text) => text.includes('event: delta'), 15_000, 'first delta');
    await fake.waitForRequests(1, 5_000);

    // The broker child is alive while the stream is open (so its absence later is meaningful).
    const pidsWhileStreaming = harness.broker.activePids();
    assert.equal(pidsWhileStreaming.length, 1, 'exactly one broker child per streaming turn');
    const childPid = pidsWhileStreaming[0];
    assert.equal(processLiveness(childPid).alive, true);

    const abortAtMs = Date.now();
    stream.request.destroy();

    // 1) provider 侧必须观察到连接被切断（≤3000ms）。
    const aborted = await fake.waitForAbort(3_000);
    const abortedAfterMs = Date.now() - abortAtMs;
    assert.ok(aborted.abortedAt !== null, 'provider must record abortedAt');
    assert.ok(abortedAfterMs <= 3_000, `provider abort observed after ${abortedAfterMs}ms`);

    // 2) 子进程不得泄漏：broker 的活句柄归零，且 pid 不再存活。
    await waitFor(() => harness.broker.stats().live === 0, { timeoutMs: 3_000, label: 'broker children reaped' });
    await waitFor(() => processLiveness(childPid).alive === false, { timeoutMs: 3_000, label: 'broker pid gone' });
    assert.deepEqual(harness.broker.activePids(), []);
    assert.equal(harness.broker.stats().live, 0);
    // 3) explain 配额必须被释放（否则下一次讲解会 429）。
    await waitFor(() => harness.explainLimiter.stats().active === 0, { timeoutMs: 3_000, label: 'explain slot released' });
    t.diagnostic(`abort: providerAbortedAfterMs=${abortedAfterMs} childPid=${childPid} liveChildrenAfter=${harness.broker.stats().live}`);
  });
});

describe('AI-ENABLE L3 · 分级真切换（severity → tier → provider 请求体）', () => {
  it('low/medium 停 watch、high→triage、critical→respond，模型名出现在 provider 请求体', async (t) => {
    const fake = await startFakeProvider({
      behaviors: {
        [MODEL_IDS.watch]: 'delta',
        [MODEL_IDS.triage]: 'delta',
        [MODEL_IDS.respond]: 'delta',
      },
      chunks: ['ok'],
      gapMs: 5,
    });
    t.after(() => fake.close());
    const capture = createCaptureLogger();
    const harness = await startChain(fake, {
      logger: capture.logger,
      alerts: [
        alertWith({ alert_id: 'a_sev_low', severity: 'low' }),
        alertWith({ alert_id: 'a_sev_medium', severity: 'medium' }),
        alertWith({ alert_id: 'a_sev_high', severity: 'high' }),
        alertWith({ alert_id: 'a_sev_critical', severity: 'critical' }),
      ],
    });
    t.after(() => harness.close());

    const expectations = [
      ['a_sev_low', MODEL_IDS.watch],
      ['a_sev_medium', MODEL_IDS.watch],
      ['a_sev_high', MODEL_IDS.triage],
      ['a_sev_critical', MODEL_IDS.respond],
    ];
    for (const [alertId, expectedModel] of expectations) {
      const response = await harness.sse(`/api/v1/alerts/${alertId}/explain`, {});
      assert.equal(response.status, 200);
      assert.equal(response.events.at(-1).event, 'done', `${alertId} must still stream`);
    }
    await fake.waitForRequests(4, 10_000);
    const observedModels = fake.requests.map((record) => record.model);
    assert.deepEqual(observedModels, expectations.map(([, expected]) => expected));

    const routes = capture.lines()
      .filter((line) => line.includes('explain.route'))
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      routes.map((route) => [route.alertId, route.tier, route.source]),
      [
        ['a_sev_low', 'watch', 'fallback'],
        ['a_sev_medium', 'watch', 'fallback'],
        ['a_sev_high', 'triage', 'selectRoute'],
        ['a_sev_critical', 'respond', 'selectRoute'],
      ],
    );
    t.diagnostic(`tier: providerModels=${JSON.stringify(observedModels)} routes=${JSON.stringify(routes.map((route) => `${route.alertId}:${route.tier}`))}`);
  });

  it('超限不得静默升档：maxEscalationsPerHour=1 → 第二次 high 停在 watch 且记录 E_HOURLY_CAP', async (t) => {
    const fake = await startFakeProvider({
      behaviors: { [MODEL_IDS.watch]: 'delta', [MODEL_IDS.triage]: 'delta' },
      chunks: ['ok'],
      gapMs: 5,
    });
    t.after(() => fake.close());
    const capture = createCaptureLogger();
    const harness = await startChain(fake, {
      logger: capture.logger,
      settings: aiSettings(fake, { escalation: { cooldownSeconds: 0, maxEscalationsPerHour: 1 } }),
    });
    t.after(() => harness.close());

    const first = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', {});
    assert.equal(first.events.at(-1).event, 'done');
    const second = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', {});
    assert.equal(second.events.at(-1).event, 'done', 'a refusal to escalate must not become an error');

    await fake.waitForRequests(2, 10_000);
    assert.deepEqual(fake.requests.map((record) => record.model), [MODEL_IDS.triage, MODEL_IDS.watch]);

    const routes = capture.lines()
      .filter((line) => line.includes('explain.route'))
      .map((line) => JSON.parse(line));
    assert.equal(routes.length, 2);
    assert.equal(routes[0].source, 'selectRoute');
    assert.equal(routes[0].escalate, true);
    assert.equal(routes[1].source, 'fallback');
    assert.equal(routes[1].deniedCode, 'E_HOURLY_CAP', 'the refusal reason must stay observable');
    assert.equal(routes[1].tier, 'watch');
    t.diagnostic(`cap: firstModel=${fake.requests[0].model} secondModel=${fake.requests[1].model} deniedCode=${routes[1].deniedCode}`);
  });
  it('冷却生效：同一告警在 cooldownSeconds 内第二次不升档（E_COOLDOWN），且仍然流式成功', async (t) => {
    const fake = await startFakeProvider({
      behaviors: { [MODEL_IDS.watch]: 'delta', [MODEL_IDS.triage]: 'delta' },
      chunks: ['ok'],
      gapMs: 5,
    });
    t.after(() => fake.close());
    const capture = createCaptureLogger();
    // The console fixture uses a manual clock, so the two requests share one instant and
    // the 300 s cooldown is guaranteed to still be open.
    const harness = await startChain(fake, {
      logger: capture.logger,
      settings: aiSettings(fake, { escalation: { cooldownSeconds: 300, maxEscalationsPerHour: 20 } }),
    });
    t.after(() => harness.close());

    const first = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', {});
    assert.equal(first.events.at(-1).event, 'done');
    const second = await harness.sse('/api/v1/alerts/a_ai_explain_1/explain', {});
    assert.equal(second.events.at(-1).event, 'done');

    await fake.waitForRequests(2, 10_000);
    assert.deepEqual(fake.requests.map((record) => record.model), [MODEL_IDS.triage, MODEL_IDS.watch]);
    const routes = capture.lines()
      .filter((line) => line.includes('explain.route'))
      .map((line) => JSON.parse(line));
    assert.equal(routes[1].deniedCode, 'E_COOLDOWN');
    assert.equal(routes[1].source, 'fallback');
    assert.equal(routes[1].tier, 'watch');
    t.diagnostic(`cooldown: firstModel=${fake.requests[0].model} secondModel=${fake.requests[1].model} deniedCode=${routes[1].deniedCode}`);
  });
});

describe('AI-ENABLE L3 · selectExplainRoute 判据单测（无网络）', () => {
  const NOW = 1_700_000_000_000;
  const nowMs = () => NOW;

  function routingSettings(escalation = {}) {
    const model = (id, tier) => ({
      id,
      providerId: 'fake-provider',
      tier,
      maxInputTokens: 4096,
      maxOutputTokens: 512,
      costClass: 'free-local',
    });
    return {
      models: {
        egressEnabled: true,
        providers: [{ id: 'fake-provider', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', enabled: true, allowLoopback: true }],
        models: [model('w', 'watch'), model('t', 'triage'), model('r', 'respond')],
        routing: {
          mode: 'tiered',
          uniformModelId: null,
          defaultTier: 'watch',
          escalation: {
            enabled: true,
            minSeverity: 'high',
            cooldownSeconds: 300,
            maxEscalationsPerHour: 20,
            ...escalation,
          },
        },
      },
    };
  }

  function route(severity, history = null, escalation = {}, alertId = 'a1') {
    return selectExplainRoute({
      settings: routingSettings(escalation),
      alert: { alert_id: alertId, severity },
      history,
      nowMs,
    });
  }

  it('severity → tier：low/medium 停 watch（记录 E_SEVERITY_BELOW），high→triage，critical→respond', () => {
    assert.deepEqual(
      ['low', 'medium', 'high', 'critical'].map((severity) => {
        const decision = route(severity);
        return [severity, decision.tier, decision.model.id, decision.escalate, decision.deniedCode];
      }),
      [
        ['low', 'watch', 'w', false, 'E_SEVERITY_BELOW'],
        ['medium', 'watch', 'w', false, 'E_SEVERITY_BELOW'],
        ['high', 'triage', 't', true, null],
        ['critical', 'respond', 'r', true, null],
      ],
    );
  });

  it('冷却与小时上限会拒升级（返回 fallback 且带 code），关闭升级停默认 tier', () => {
    const history = createEscalationHistory({ clock: { nowMs } });
    const first = route('high', history);
    assert.equal(first.tier, 'triage');
    history.record(first.fingerprint);
    const cooled = route('high', history);
    assert.equal(cooled.tier, 'watch');
    assert.equal(cooled.deniedCode, 'E_COOLDOWN');

    const capped = createEscalationHistory({ clock: { nowMs } });
    const allowed = route('critical', capped, { cooldownSeconds: 0, maxEscalationsPerHour: 1 });
    assert.equal(allowed.tier, 'respond');
    capped.record(allowed.fingerprint);
    const denied = route('critical', capped, { cooldownSeconds: 0, maxEscalationsPerHour: 1 });
    assert.equal(denied.tier, 'watch');
    assert.equal(denied.deniedCode, 'E_HOURLY_CAP');

    const disabled = route('critical', null, { enabled: false });
    assert.equal(disabled.tier, 'watch');
    assert.equal(disabled.source, 'selectRoute');
    assert.equal(disabled.reason, 'escalation-disabled');
  });

  it('显式 modelId 与畸形 severity 都不会变成 4xx（回落到旧选择）', () => {
    const explicit = selectExplainRoute({
      settings: routingSettings(),
      alert: { alert_id: 'a1', severity: 'critical' },
      requestedModelId: 'w',
      history: null,
      nowMs,
    });
    assert.equal(explicit.model.id, 'w');
    assert.equal(explicit.source, 'fallback');

    const malformed = route('info');
    assert.equal(malformed.tier, 'watch');
    assert.equal(malformed.deniedCode, 'E_MODE_INVALID');
  });
});

describe('AI-ENABLE L3 · 判据不可用时的降级（发布包布局防崩）', () => {
  it('selectExplainRoute({routingModule:null}) 回落到默认 tier，并记录 E_ROUTING_UNAVAILABLE', () => {
    const settings = {
      models: {
        egressEnabled: true,
        providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', enabled: true, allowLoopback: true }],
        models: [
          { id: 'w', providerId: 'p', tier: 'watch', maxInputTokens: 4096, maxOutputTokens: 512, costClass: 'free-local' },
          { id: 't', providerId: 'p', tier: 'triage', maxInputTokens: 4096, maxOutputTokens: 512, costClass: 'free-local' },
        ],
        routing: {
          mode: 'tiered',
          uniformModelId: null,
          defaultTier: 'watch',
          escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxEscalationsPerHour: 20 },
        },
      },
    };
    // `critical` would escalate to `triage` when the judge is present; without it the
    // decision must degrade to the default tier and say so.
    const degraded = selectExplainRoute({
      settings,
      alert: { alert_id: 'a1', severity: 'critical' },
      history: null,
      nowMs: () => 1,
      routingModule: null,
    });
    assert.equal(degraded.model.id, 'w');
    assert.equal(degraded.tier, 'watch');
    assert.equal(degraded.source, 'fallback');
    assert.equal(degraded.escalate, false);
    assert.equal(degraded.deniedCode, 'E_ROUTING_UNAVAILABLE');
    assert.equal(degraded.deniedField, 'routingModule');
    assert.match(degraded.reason, /^routing-unavailable/u);

    // A judge-shaped object without `selectRoute` is just as unusable.
    const wrongShape = selectExplainRoute({
      settings,
      alert: { alert_id: 'a1', severity: 'critical' },
      history: null,
      nowMs: () => 1,
      routingModule: {},
    });
    assert.equal(wrongShape.deniedCode, 'E_ROUTING_UNAVAILABLE');

    // The repository layout still has a working judge (this is the "before" state).
    assert.equal(routingJudgeStatus().available, true);
  });

  it('真链路降级：judge 缺失时 explain 仍 200 + 流式 + 用默认 tier 模型，且拒绝原因可查', async (t) => {
    const fake = await startFakeProvider({ behaviors: { [MODEL_IDS.watch]: 'delta' }, chunks: ['degraded', '-ok'], gapMs: 20 });
    t.after(() => fake.close());
    const dataDir = makeTempDir();
    const capture = createCaptureLogger();
    const settings = aiSettings(fake);
    const clock = {
      nowMs: () => Date.parse('2026-11-04T12:00:00.000Z'),
      nowIso: () => '2026-11-04T12:00:00.000Z',
    };
    const broker = createBrokerClient({ dataDir, hostPath: HOST_PATH, childEnv: {}, logger: null });
    const handlers = createExplainHandlers({
      settingsStore: { current: () => settings },
      engine: createChatEngine({ broker }),
      alertLookup: createAlertLookup({
        store: { kind: 'memory', dump: () => ({ alerts: [alertWith({ alert_id: 'a_ai_explain_1', severity: 'critical' })] }) },
        storePath: join(dataDir, 'store', 'aegis.db'),
        clock,
      }),
      limiter: createExplainLimiter({ clock }),
      clock,
      logger: capture.logger,
      sseOptions: SSE_OPTIONS,
      routingModule: null,
    });
    assert.deepEqual(handlers.routing.judge(), { available: false, error: 'E_INJECTED_UNAVAILABLE' });

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        } catch {
          body = null;
        }
        handlers.explain({
          params: { id: 'a_ai_explain_1' },
          body,
          res,
          securityHeaders: {},
        }).catch(() => {
          try {
            if (!res.headersSent) {
              res.writeHead(500);
            }
            res.end();
          } catch {
            // The client may already be gone.
          }
        });
      });
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
      await broker.close();
    });

    const stream = await openTimedSse(server.address().port, '/api/v1/alerts/a_ai_explain_1/explain', {}, {
      token: TEST_TOKEN,
      csrf: 'not-checked-by-this-bare-server',
    });
    t.after(() => stream.request.destroy());
    await stream.waitFor((text) => text.includes('event: done'), 20_000, 'degraded done frame');

    assert.equal(stream.status(), 200, 'a missing judge must not become a 4xx/5xx');
    const events = stream.events();
    assert.deepEqual(events.map((event) => event.event), ['delta', 'delta', 'usage', 'done']);
    assert.equal(events.at(-1).data.alertId, 'a_ai_explain_1');

    // 默认 tier 的模型真的被用了（不是升档到 triage/respond）。
    await fake.waitForRequests(1, 5_000);
    assert.equal(fake.requests[0].model, MODEL_IDS.watch);
    // 拒绝原因必须可查，不许假装"分级正常"。
    const routeLines = capture.lines().filter((line) => line.includes('explain.route')).map((line) => JSON.parse(line));
    assert.equal(routeLines.length, 1);
    assert.equal(routeLines[0].source, 'fallback');
    assert.equal(routeLines[0].tier, 'watch');
    assert.equal(routeLines[0].deniedCode, 'E_ROUTING_UNAVAILABLE');
    assert.match(routeLines[0].reason, /^routing-unavailable/u);
    await waitFor(() => broker.stats().live === 0, { timeoutMs: 3_000, label: 'broker child reaped' });
    t.diagnostic(`degraded: http=${stream.status()} providerModel=${fake.requests[0].model} frames=${JSON.stringify(events.map((event) => event.event))} deniedCode=${routeLines[0].deniedCode} reason=${routeLines[0].reason}`);
  });
});
