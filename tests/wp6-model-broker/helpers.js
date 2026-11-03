/**
 * WP6 model-broker 测试夹具。
 *
 * 三条纪律：
 * 1. 每个用例一个独立临时目录，用例结束递归删除；绝不碰真实数据库路径。
 * 2. 所有出网流量都打到 `127.0.0.1` 的动态端口 mock provider，**不发真实模型请求**。
 * 3. 时间与并发用真实定时器/事件循环，但用例自身的判断只依赖可观察状态
 *    （账本行、provider 收到的请求数、熔断状态），不依赖 sleep 的时长。
 */

import assert from 'node:assert/strict';
import { after } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest, validateAlert } from '../../packages/contracts/src/index.js';
import {
  claimAnalysis,
  ingestTelemetry,
  listRequests,
  openStore,
  summarizeBudget,
} from '../../packages/event-store/src/index.js';

import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import { createModelBroker } from '../../apps/model-broker/src/broker.js';
import { ProviderCredential } from '../../apps/model-broker/src/credentials.js';
import { buildOutboundPayload, estimateInputUpper, finalizeOutbound } from '../../apps/model-broker/src/redaction.js';
import { resolveFixedEndpoint } from '../../apps/model-broker/src/endpoint.js';
import { createHttpTransport } from '../../apps/model-broker/src/transport.js';
import { resolveLimits } from '../../apps/model-broker/src/policy.js';
import { sha256Hex, uuid } from '../../apps/model-broker/src/util.js';

/**
 * 测试用假凭据。
 *
 * 它不是任何真实服务的凭据，只用来验证"Authorization 确实带上、且不出现在
 * 日志/错误/审计里"。真实凭据永远不写进仓库。
 */
export const TEST_FIXTURE_KEY = 'fixture-not-a-real-provider-key-0123456789';

const TEMP_DIRS = new Set();

function safeRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  } catch {
    // 临时目录残留不该让测试变红；真实断言失败另有报错。
  }
}

after(() => {
  for (const dir of TEMP_DIRS) safeRemove(dir);
  TEMP_DIRS.clear();
});

export function makeTempDir(t, label = 'wp6-broker') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  TEMP_DIRS.add(dir);
  void t;
  return dir;
}

/** 打开可写存储。句柄在用例级关闭，目录在文件级删除（Windows 上顺序不能反）。 */
export function openTestStore(t, options = {}) {
  const dir = options.directory ?? makeTempDir(t);
  const store = openStore({
    path: path.join(dir, 'aegis-harness.db'),
    auditKey: 'wp6-broker-audit-key-0123456789',
  });
  t.after(() => {
    try {
      store.close();
    } catch {
      // 用例可能已手动关闭。
    }
  });
  return { store, dir };
}

let seq = 0;

export function makeEvent(overrides = {}) {
  seq += 1;
  const payload = overrides.payload ?? { process_name: 'demo.exe', pid: 4000 + seq };
  return {
    schemaVersion: '1.0',
    event_id: uuid(),
    stable_source_id: 'windows.security.4688',
    collector_instance_id: uuid(),
    source_generation: 1,
    boot_id: 'a'.repeat(32),
    source_seq: seq,
    observed_at: '2026-11-01T00:00:00.000Z',
    received_at: '2026-11-01T00:00:01.000Z',
    type: 'process.start',
    severity: 'high',
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
  };
}

function makeAlert(overrides = {}) {
  const alertId = overrides.alert_id ?? uuid();
  return validateAlert({
    schemaVersion: '1.0',
    alert_id: alertId,
    rule_id: 'proc_persist',
    rule_version: '1.0.0',
    // 指纹必须唯一：否则第二条 alert 会被 T1 去重掉，分析请求就会指向不存在的告警。
    fingerprint: overrides.fingerprint ?? sha256Hex(`alert-${alertId}`),
    severity: 'high',
    status: 'new',
    first_seen: '2026-11-01T00:00:00.000Z',
    last_seen: '2026-11-01T00:00:01.000Z',
    window_start: '2026-11-01T00:00:00.000Z',
    window_end: '2026-11-01T00:15:00.000Z',
    count: 1,
    event_ids: [uuid()],
    event_ids_truncated: false,
    evidence_refs: [],
  }).value;
}

/**
 * 在存储里造一个 `queued` 分析（T1）并 claim（T5 claim），
 * 这样 `reserveModelRequest` 的 analysis 存在性/epoch 校验走得是真实路径。
 */
export function seedAnalysis(store, overrides = {}) {
  const alert = makeAlert();
  const analysisId = overrides.analysis_id ?? uuid();
  const result = ingestTelemetry(store, {
    event: makeEvent(),
    alerts: [alert],
    analysisRequest: {
      schemaVersion: '1.0',
      analysis_id: analysisId,
      alert_id: alert.alert_id,
      budget_class: 'standard',
      summary_dto: { classification: 'D1', fields: { process_name: 'demo.exe' } },
      created_at: '2026-11-01T00:00:02.000Z',
      idempotency_key: `${analysisId}-idem`,
      epoch: store.epoch(),
    },
    allowedSummaryFields: ['process_name'],
  });
  assert.equal(result.duplicate, false);
  const claim = claimAnalysis(store, { analysis_id: analysisId, owner: 'broker-test' });
  return { analysis_id: analysisId, attempt_id: claim.attempt_id, alert_id: alert.alert_id };
}

/**
 * mock provider。
 *
 * `handler({req, res, record})` 决定这一次怎么回应；收到的每个请求都记进
 * `requests`，用来断言"到底发了几次、发了什么"。
 */
export async function startMockProvider(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const record = { method: req.method, url: req.url, headers: req.headers, raw, body };
      requests.push(record);
      handler({ req, res, record });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1/messages`,
    port,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 标准成功响应。 */
export function okHandler(options = {}) {
  const usage = options.usage === undefined
    ? { input_tokens: 12, output_tokens: 5 }
    : options.usage;
  const content = options.content ?? '{"summary":"synthetic"}';
  return ({ res }) => {
    const payload = { model: 'deepseek-chat', choices: [{ message: { content } }] };
    if (usage !== null) payload.usage = usage;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

/** 永不响应：用于超时与取消。 */
export function hangHandler() {
  return ({ req, res }) => {
    // 故意不写任何东西，也不主动关闭；由客户端 abort 断开。
    void req;
    void res;
  };
}

/** 收到请求后立刻毁掉 socket：模拟"发出去了但结果未知"。 */
export function destroyHandler() {
  return ({ req }) => {
    req.socket.destroy();
  };
}

/** 固定状态码错误响应。 */
export function statusHandler(status) {
  return ({ res }) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'synthetic provider error' } }));
  };
}

/** 收集 broker 日志事件（结构化，不含正文）。 */
export function createLogSink() {
  const events = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
    asJson() {
      return JSON.stringify(events);
    },
  };
}

export function makeIntent(analysisId, overrides = {}) {
  const fields = overrides.fields ?? { process_name: 'demo.exe', rule_id: 'proc_persist', count: 1 };
  const message = {
    role: overrides.role ?? 'user',
    content: {
      classification: overrides.classification ?? 'D1',
      fields,
    },
  };
  const prefix = overrides.prefix === undefined
    ? [{ role: 'system', content: { classification: 'D0', fields: { rule_id: 'proc_persist', policy_version: '1.0' } } }]
    : overrides.prefix;
  void fields;
  return {
    analysis_id: analysisId,
    attempt_id: overrides.attempt_id ?? null,
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    messages: [...prefix, message],
  };
}

/** 预估一次意图会占用的 input 上界（按最终报文计算，和 broker 的口径一致）。 */
export function inputUpperOf(intent, options = {}) {
  const payload = buildOutboundPayload(intent, { limits: options.limits });
  const wire = finalizeOutbound(payload, {
    model: options.model ?? 'deepseek-chat',
    maxTokens: options.maxTokens ?? 2000,
    limits: options.limits,
  });
  return estimateInputUpper(wire.body, payload.messages.length);
}

/** 测试用身份解析器：模拟"IPC 层已从单次 token 推导出身份"这一层。 */
export function identityFromIntent({ intent }) {
  return { analysis_id: intent.analysis_id, attempt_id: intent.attempt_id ?? null };
}

/**
 * 组装一套可用的 broker：真实 event-store + 真实适配器 + 真实 HTTP 传输 + mock provider。
 *
 * 唯一被替换的是"端点指向本地 mock"，其余全是生产路径。
 */
export function createHarness(t, options = {}) {
  const store = options.store ?? openTestStore(t).store;
  const provider = options.provider ?? null;
  const logs = options.logs ?? createLogSink();
  const credential = options.credential === undefined
    ? new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' })
    : options.credential;
  const port = options.port
    ?? createEventStoreBudgetPort(store, { policy: options.policy });
  const endpoint = resolveFixedEndpoint(
    { url: options.endpointUrl ?? provider.url, model: 'deepseek-chat' },
    { allowInsecureLoopback: true },
  );
  const limits = resolveLimits(options.limits);
  const transport = options.transport ?? createHttpTransport({
    endpoint,
    credential,
    limits,
  });
  // 先登记关闭：即使 broker 构造失败，mock server 也必须被关掉，否则进程挂住。
  if (provider) t.after(() => provider.close());
  const broker = createModelBroker({
    budgetPort: port,
    resolveIdentity: options.resolveIdentity ?? identityFromIntent,
    endpoint,
    credential,
    transport,
    limits,
    timeoutMs: options.timeoutMs,
    logger: logs,
    circuitStatePort: options.circuitStatePort,
    now: options.now,
  });
  return { store, provider, port, broker, logs, endpoint, credential };
}

export function ledgerRows(store, analysisId) {
  return listRequests(store, analysisId === undefined ? {} : { analysis_id: analysisId });
}

export function budgetSummary(store, policy) {
  return summarizeBudget(store, { policy });
}

export async function expectBrokerErrorAsync(promise, code) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, `expected ${code}: nothing was thrown`);
  assert.equal(caught.name, 'BrokerError', `expected BrokerError, got ${caught.name}: ${caught.message}`);
  if (code !== undefined) assert.equal(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

/** 让事件循环前进若干轮：让 mock provider 与 broker 的异步链路跑完。 */
export function tick(times = 1) {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
