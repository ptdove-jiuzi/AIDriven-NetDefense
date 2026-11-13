/**
 * UI2-B11 · §11 红线 1/3/4：daemon console 路由 × 真实 B9 broker host × 假 provider
 *
 * 这是**跨进程端到端**验收：真实 `apps/daemon/src/api/**` 路由 → `spawn` 真实
 * `apps/model-broker/bin/console-host.js` → 127.0.0.1 假 provider（不连真实模型）。
 * 复用 B8 的 `tests/wp5-daemon/console-fixtures.mjs`（只读导入，不修改）。
 *
 * 断言：
 * - 凭据 canary：PUT→204 空 body；任何 HTTP 响应 / daemon 日志 / 非 secrets 落盘文件零明文；
 *   GET /models 只回 masked/fingerprint/updatedAt/lengthBucket；
 * - chat SSE 端到端：seq 单调、delta 累积、usage、done；provider 收到 Bearer + stream:true；
 * - 零外联：egressEnabled=false / provider.enabled=false / 无凭据 → 409 且 provider 连接数 0；
 * - 断开清理：客户端半途断开 → broker 子进程 3s 内被回收（pid 级断言）。
 *
 * 运行：`node --test tests/console-next/console-routes.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  chatReadySettings,
  loopbackProvider,
  openRawSse,
  processLiveness,
  sessionIdFor,
  settingsDocument,
  startConsoleApi,
  startProbeServer,
  TEST_TOKEN,
  waitFor,
} from '../wp5-daemon/console-fixtures.mjs';
import { startFakeProvider } from './fake-provider.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const REAL_HOST = path.join(REPO_ROOT, 'apps', 'model-broker', 'bin', 'console-host.js');

function canary(label = 'key') {
  return `sk-canary-b11-${label}-${crypto.randomBytes(12).toString('hex')}`;
}

/** 收集 dataDir 下除 secrets/providers 外的所有文件文本（用于"明文不得落盘到非密文位置"）。 */
function nonSecretDataDirText(dataDir) {
  const parts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'providers' || entry.name === 'secrets') {
          // secrets/providers 是唯一允许存明文的位置（B9 的凭据槽），跳过。
          continue;
        }
        walk(full);
        continue;
      }
      try {
        parts.push(fs.readFileSync(full, 'utf8'));
      } catch {
        // 二进制/锁定文件跳过。
      }
    }
  };
  walk(dataDir);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 红线 1：凭据 canary 零泄漏（真实 daemon + 真实 host）
// ---------------------------------------------------------------------------

test('canary：PUT 凭据 204 空 body；/models 只回掩码；响应/日志/非密文落盘零明文', async (t) => {
  const provider = await startFakeProvider(t);
  const capture = startCaptureLogger();
  const harness = await startConsoleApi({
    hostPath: REAL_HOST,
    settings: chatReadySettings(provider.port),
    logger: capture.logger,
  });
  t.after(() => harness.close());

  const key = canary('credentials');
  const put = await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: key } });
  assert.equal(put.status, 204);
  assert.equal(put.text, '', 'PUT /credentials must return an empty body');
  assert.ok(!put.text.includes(key));

  const models = await harness.request('/api/v1/models');
  assert.equal(models.status, 200);
  assert.ok(!models.text.includes(key), 'GET /models must never contain the plaintext key');
  const entry = models.body.providers.find((item) => item.id === 'ollama-local');
  assert.equal(entry.hasCredential, true);
  assert.equal(entry.credential.masked, `••••${key.slice(-4)}`);
  assert.equal(entry.credential.fingerprint, crypto.createHash('sha256').update(key).digest('hex').slice(0, 8));
  assert.ok(!Number.isNaN(Date.parse(entry.credential.updatedAt)));
  assert.ok(['<16', '16-32', '33-64', '>64'].includes(entry.credential.lengthBucket));
  assert.deepEqual(Object.keys(entry.credential).sort(), ['fingerprint', 'lengthBucket', 'masked', 'updatedAt']);

  // daemon 捕获日志（debug 级）零明文
  assert.ok(!capture.text().includes(key), 'daemon logs must not contain the plaintext key');
  // 非 secrets 落盘位置零明文
  assert.ok(!nonSecretDataDirText(harness.dataDir).includes(key), 'plaintext must stay in secrets/providers only');
  // §11 红线 2：全仓 grep canary 0 命中（排除 node_modules/.git/二进制）
  const repoHits = grepRepo(key);
  assert.deepEqual(repoHits, [], `canary must not appear anywhere in the repository: ${repoHits.join(', ')}`);
  t.diagnostic(`canary repo scan: 0 hits (key length ${key.length})`);
});

/** 递归扫描仓库（排除 node_modules/.git），返回命中 canary 的相对路径。 */
function grepRepo(needle) {
  const hits = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.mutants']);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length > 0) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > 2 * 1024 * 1024) continue; // 大二进制/归档跳过
      try {
        if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(path.relative(REPO_ROOT, full));
      } catch {
        // 非 UTF-8/锁定文件跳过
      }
    }
  };
  walk(REPO_ROOT);
  return hits;
}

// ---------------------------------------------------------------------------
// 红线 3：chat SSE 端到端（daemon → host → provider）
// ---------------------------------------------------------------------------

test('chat SSE 端到端：delta 累积 + usage + done；provider 收到 Bearer 与 stream:true', async (t) => {
  const provider = await startFakeProvider(t, {
    deltas: ['先看', '这条告警。'],
    usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
  });
  const harness = await startConsoleApi({
    hostPath: REAL_HOST,
    settings: chatReadySettings(provider.port),
  });
  t.after(() => harness.close());

  const key = canary('chat');
  const put = await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: key } });
  assert.equal(put.status, 204);

  const stream = await harness.sse('/api/v1/agent/chat', {
    sessionId: sessionIdFor('b11-chat'),
    modelId: 'local-chat',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: '这条告警说明什么？' }],
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/u);

  const names = stream.events.map((event) => event.event);
  assert.ok(names.includes('delta'));
  assert.equal(names.filter((name) => name === 'done').length, 1, 'exactly one terminal event');
  const seqs = stream.events.map((event) => event.data.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq must be monotonic per event');
  assert.equal(new Set(seqs).size, seqs.length, 'seq must be unique');

  const text = stream.events.filter((event) => event.event === 'delta').map((event) => event.data.text).join('');
  assert.equal(text, '先看这条告警。');
  const usage = stream.events.find((event) => event.event === 'usage');
  assert.ok(usage, 'usage event must be present when the provider sends it');
  assert.equal(usage.data.totalTokens, 165);
  const done = stream.events.find((event) => event.event === 'done');
  assert.equal(done.data.finishReason, 'stop');

  // provider 侧：Bearer + stream 参数 + 请求体确实来自服务端提示词拼接
  assert.equal(provider.requests.length, 1);
  const upstream = provider.requests[0];
  assert.equal(upstream.method, 'POST');
  assert.equal(upstream.body.stream, true);
  assert.equal(upstream.body.model, 'local-chat');
  assert.equal(upstream.headers.authorization, `Bearer ${key}`);
  assert.ok(Array.isArray(upstream.body.messages) && upstream.body.messages.length >= 2);
  assert.equal(upstream.body.messages[0].role, 'system', 'daemon-held system prompt must be prepended');
  assert.ok(upstream.body.messages.at(-1).content === '这条告警说明什么？');
  assert.ok(!JSON.stringify(upstream.body).includes(key), 'prompt body must not carry the credential');
});

test('chat 错误映射：provider 500 → SSE error(UPSTREAM_FAILED, retryable)，不回显上游正文', async (t) => {
  const provider = await startFakeProvider(t, { mode: 'error' });
  const harness = await startConsoleApi({ hostPath: REAL_HOST, settings: chatReadySettings(provider.port) });
  t.after(() => harness.close());
  await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: canary('err') } });

  const stream = await harness.sse('/api/v1/agent/chat', {
    sessionId: sessionIdFor('b11-error'),
    modelId: 'local-chat',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(stream.status, 200);
  const error = stream.events.find((event) => event.event === 'error');
  assert.ok(error, 'upstream failure must surface as an SSE error event');
  assert.equal(error.data.code, 'UPSTREAM_FAILED');
  assert.equal(error.data.retryable, true);
  assert.ok(!stream.text.includes('synthetic provider failure'), 'upstream body must not be echoed');
});

test('chat 错误映射：provider 302 → SSE error(UPSTREAM_REDIRECT, 不跟随)', async (t) => {
  const provider = await startFakeProvider(t, { mode: 'redirect' });
  const harness = await startConsoleApi({ hostPath: REAL_HOST, settings: chatReadySettings(provider.port) });
  t.after(() => harness.close());
  await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: canary('redir') } });

  const stream = await harness.sse('/api/v1/agent/chat', {
    sessionId: sessionIdFor('b11-redirect'),
    modelId: 'local-chat',
    messages: [{ role: 'user', content: 'hi' }],
  });
  const error = stream.events.find((event) => event.event === 'error');
  assert.ok(error);
  assert.equal(error.data.code, 'UPSTREAM_REDIRECT');
  assert.equal(provider.requests.length, 1, 'redirect target must never be followed');
});

test('provider/test 端到端：GET /v1/models，Bearer 由 host 注入', async (t) => {
  const provider = await startFakeProvider(t, { modelCount: 7 });
  const harness = await startConsoleApi({ hostPath: REAL_HOST, settings: chatReadySettings(provider.port) });
  t.after(() => harness.close());
  const key = canary('probe');
  await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: key } });

  const result = await harness.request('/api/v1/models/ollama-local/test', { method: 'POST', body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  assert.equal(result.body.modelCount, 7);
  assert.equal(result.body.error, null);
  assert.ok(!result.text.includes(key));
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].method, 'GET');
  assert.equal(provider.requests[0].url, '/v1/models');
  assert.equal(provider.requests[0].headers.authorization, `Bearer ${key}`);
});

// ---------------------------------------------------------------------------
// 红线 4（零外联）：三重前置在 spawn 前拒绝，provider 连接数 0
// ---------------------------------------------------------------------------

test('零外联：egressEnabled=false / provider.enabled=false / 无凭据 → 409 且 provider 连接数 0', async (t) => {
  const probe = await startProbeServer();
  t.after(() => probe.close());

  // 1) 全局关：EGRESS_DISABLED
  {
    const harness = await startConsoleApi({
      hostPath: REAL_HOST,
      settings: chatReadySettings(probe.port, { models: { egressEnabled: false } }),
    });
    t.after(() => harness.close());
    await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: canary('egress-off') } });
    const result = await harness.request('/api/v1/models/ollama-local/test', { method: 'POST', body: {} });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'EGRESS_DISABLED');
    assert.equal(probe.connections(), 0, 'closed egress must open zero provider connections');
  }

  // 2) provider 关：PROVIDER_DISABLED
  {
    const harness = await startConsoleApi({
      hostPath: REAL_HOST,
      settings: { models: { egressEnabled: true, providers: [loopbackProvider(probe.port, { enabled: false })], models: [] } },
    });
    t.after(() => harness.close());
    await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: canary('provider-off') } });
    const result = await harness.request('/api/v1/models/ollama-local/test', { method: 'POST', body: {} });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'PROVIDER_DISABLED');
    assert.equal(probe.connections(), 0);
  }

  // 3) 无凭据：CREDENTIAL_MISSING（非回环 provider；前置校验在 spawn/出站之前）
  //    注：当前实现对 loopback provider 允许无凭据（B8 的已知偏差，见 UI2-B11 状态文件），
  //    因此这里用 https 非回环 provider 断言合同 §2.4 的"无密钥即拒"。
  {
    const harness = await startConsoleApi({
      hostPath: REAL_HOST,
      settings: {
        models: {
          egressEnabled: true,
          providers: [{
            id: 'remote',
            kind: 'openai-compatible',
            baseUrl: 'https://provider.invalid/v1',
            enabled: true,
            allowLoopback: false,
            dailyInputTokens: 30000,
            dailyOutputTokens: 6000,
            pricing: null,
          }],
          models: [{
            id: 'remote-chat',
            providerId: 'remote',
            tier: 'triage',
            maxInputTokens: 4096,
            maxOutputTokens: 512,
            costClass: 'cheap',
          }],
        },
      },
    });
    t.after(() => harness.close());
    const result = await harness.request('/api/v1/models/remote/test', { method: 'POST', body: {} });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'CREDENTIAL_MISSING');
    assert.equal(probe.connections(), 0);
  }
});

// ---------------------------------------------------------------------------
// 红线 4（孤儿进程）：客户端断开 → broker 子进程 3s 内回收
// ---------------------------------------------------------------------------

test('断开清理：客户端半途断开 → broker 子进程 3s 内回收（pid 级证据）', async (t) => {
  const provider = await startFakeProvider(t, { mode: 'hang' });
  const harness = await startConsoleApi({ hostPath: REAL_HOST, settings: chatReadySettings(provider.port) });
  t.after(() => harness.close());
  await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: canary('disconnect') } });

  const raw = await openRawSse(harness.address.port, '/api/v1/agent/chat', {
    sessionId: sessionIdFor('b11-disconnect'),
    modelId: 'local-chat',
    messages: [{ role: 'user', content: 'hi' }],
  }, { token: harnessToken(harness), csrf: harness.csrfToken });

  // 等到确实有子进程在跑（最多 3s）
  let pids = [];
  await waitFor(() => {
    pids = harness.broker.activePids();
    return pids.length > 0;
  }, { timeoutMs: 3000, label: 'broker child spawn' });
  const pidEvidence = pids.map((pid) => processLiveness(pid));
  assert.ok(pids.length >= 1);

  // 半途切断客户端连接
  raw.request.destroy();
  const started = Date.now();
  await waitFor(() => harness.broker.activePids().length === 0, { timeoutMs: 3000, label: 'broker child reaped' });
  const elapsed = Date.now() - started;

  const afterEvidence = pidEvidence.map((item, index) => processLiveness(pids[index]));
  for (const item of afterEvidence) {
    assert.equal(item.alive, false, `orphan child still alive: ${item.evidence}`);
  }
  assert.ok(elapsed < 3000, `broker child must be reaped within 3s (took ${elapsed}ms)`);
  t.diagnostic(`pids=${pids.join(',')} reaped_in_ms=${elapsed} before=${pidEvidence.map((e) => e.evidence).join(' | ')}`);
  assert.equal(harness.chatQuota.stats().global, 0, 'chat quota must be released after disconnect');
});

// ---------------------------------------------------------------------------
// 路由形状（独立复核 B8 的合同面）
// ---------------------------------------------------------------------------

test('路由边界：GET /credentials/:id → 405；未知 explain 告警 → 404 JSON；chat body 非法 → 400', async (t) => {
  const provider = await startFakeProvider(t);
  const harness = await startConsoleApi({ hostPath: REAL_HOST, settings: chatReadySettings(provider.port) });
  t.after(() => harness.close());

  const getCredential = await harness.request('/api/v1/credentials/ollama-local');
  assert.equal(getCredential.status, 405, 'credentials are write-only: GET must be 405');
  assert.equal(getCredential.body.error.code, 'METHOD_NOT_ALLOWED');

  const missingAlert = await harness.request('/api/v1/alerts/a_missing/explain', { method: 'POST', body: {} });
  assert.equal(missingAlert.status, 404);
  assert.equal(missingAlert.body.error.code, 'ALERT_NOT_FOUND');
  assert.match(missingAlert.headers.get('content-type') ?? '', /application\/json/u, 'pre-validation errors are JSON, not SSE');

  const badChat = await harness.request('/api/v1/agent/chat', {
    method: 'POST',
    body: { sessionId: sessionIdFor('bad'), modelId: 'local-chat', messages: [{ role: 'system', content: 'hi' }] },
  });
  assert.equal(badChat.status, 400);
  assert.equal(badChat.body.error.code, 'CHAT_INVALID');
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 从 fixture harness 取 token：fixture 用固定 TEST_TOKEN 常量，这里只读 auth。 */
function harnessToken() {
  return TEST_TOKEN;
}

function startCaptureLogger() {
  const lines = [];
  const logger = {
    debug: (message, fields) => lines.push(JSON.stringify({ level: 'debug', message, fields })),
    info: (message, fields) => lines.push(JSON.stringify({ level: 'info', message, fields })),
    warn: (message, fields) => lines.push(JSON.stringify({ level: 'warn', message, fields })),
    error: (message, fields) => lines.push(JSON.stringify({ level: 'error', message, fields })),
    child() {
      return this;
    },
  };
  return { logger, text: () => lines.join('\n') };
}
