/**
 * UI2-B11 · B3 `serve.mjs` 独立验收（同源静态 + 回环代理 + SSE 透传）
 *
 * 以**外部进程**方式启动 `node apps/console-next/serve.mjs`，上游是可记账的假 daemon：
 * - 静态白名单 / 路径穿越 / 点文件 / MIME / 安全头；
 * - Bearer + CSRF 注入、Origin/Referer/Cookie 剥离、写请求 `x-console-v2: 1` 闸门；
 * - SSE 不缓冲（首帧 <1s、无 content-length）与客户端断开向 upstream 传播；
 * - token 不出现在 announce/stdout/stderr/响应里。
 *
 * 运行：`node --test tests/console-next/serve.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startFakeDaemon } from './fake-daemon.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const SERVE = path.join(REPO_ROOT, 'apps', 'console-next', 'serve.mjs');
const INDEX_PATH = path.join(REPO_ROOT, 'apps', 'console-next', 'index.html');

const TOKEN = 'b11-console-token-0123456789abcdef';

function csrfFor(token) {
  return crypto.createHash('sha256').update(`aegis-csrf:${token}`).digest('base64url');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 3000, label = 'condition') {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/**
 * 启动 console host CLI，等待单行 JSON announce。
 */
async function startConsole(t, options = {}) {
  const args = [SERVE, '--daemon', options.daemonUrl ?? 'http://127.0.0.1:1', '--token', options.token ?? TOKEN, '--port', '0', '--host', '127.0.0.1'];
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  t.after(async () => {
    if (exited === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
  const announce = await waitUntil(() => {
    const text = stdout.join('');
    const line = text.split(/\r?\n/u).find((entry) => entry.trim().startsWith('{'));
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }, 5000, 'console host announce');
  return {
    child,
    url: announce.listening.replace(/\/$/u, ''),
    announce,
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
    async waitExit(timeoutMs = 3000) {
      const started = Date.now();
      while (exited === null) {
        if (Date.now() - started > timeoutMs) throw new Error('console host did not exit');
        await sleep(10);
      }
      return exited;
    },
  };
}

test('CLI：单行 JSON announce 含 listening URL，token 不出现在输出里', async (t) => {
  const daemon = await startFakeDaemon(t);
  const console = await startConsole(t, { daemonUrl: daemon.url });
  assert.match(console.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(console.announce.tokenInjected, true);
  assert.equal(console.announce.daemon, daemon.url);
  assert.ok(!JSON.stringify(console.announce).includes(TOKEN), 'token must never be announced');
  assert.ok(!console.stdout().includes(TOKEN));
  assert.ok(!console.stderr().includes(TOKEN));
  assert.ok(!JSON.stringify(console.announce).includes('csrf'), 'csrf value must not be announced');
});

test('CLI：非回环 --host 拒绝（exit 2，stderr 含 loopback-only）', async (t) => {
  const child = spawn(process.execPath, [SERVE, '--daemon', 'http://127.0.0.1:1', '--token', TOKEN, '--host', '0.0.0.0', '--port', '0'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exit = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(() => child.kill('SIGKILL'));
  assert.equal(exit, 2);
  assert.match(stderr.join(''), /loopback-only/u);
});

test('静态：index.html 与磁盘逐字节一致、MIME 正确、安全头齐全', async (t) => {
  const daemon = await startFakeDaemon(t);
  const console = await startConsole(t, { daemonUrl: daemon.url });

  const response = await fetch(`${console.url}/index.html`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body, fs.readFileSync(INDEX_PATH, 'utf8'), 'index.html must be served byte-for-byte');
  assert.match(response.headers.get('content-type') ?? '', /text\/html/u);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-security-policy'));
  assert.ok(response.headers.get('referrer-policy'));
  assert.equal(response.headers.get('cache-control'), 'no-store');

  for (const [asset, type] of [
    ['/styles/tokens.css', /text\/css/u],
    ['/assets/mark.svg', /image\/svg\+xml/u],
    ['/js/app.js', /javascript/u],
  ]) {
    const assetResponse = await fetch(`${console.url}${asset}`);
    assert.equal(assetResponse.status, 200, `${asset} must be served`);
    assert.match(assetResponse.headers.get('content-type') ?? '', type);
  }
});

test('静态：扩展名白名单/点文件/目录列表/路径穿越全部 404', async (t) => {
  const daemon = await startFakeDaemon(t);
  const console = await startConsole(t, { daemonUrl: daemon.url });
  for (const probe of [
    '/serve.mjs',
    '/package.json',
    '/.env',
    '/.git/config',
    '/styles/',
    '/js/',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/styles/%2e%2e/%2e%2e/package.json',
  ]) {
    const response = await fetch(`${console.url}${probe}`, { redirect: 'manual' });
    assert.equal(response.status, 404, `${probe} must not be served (got ${response.status})`);
  }
});

test('代理：注入 Bearer、剥离 Origin/Referer/Cookie，响应不含 token/csrf', async (t) => {
  const daemon = await startFakeDaemon(t);
  const console = await startConsole(t, { daemonUrl: daemon.url });
  const response = await fetch(`${console.url}/api/v1/status`, {
    headers: {
      origin: 'http://evil.example',
      referer: 'http://evil.example/page',
      cookie: 'session=secret',
      'x-aegis-csrf': 'browser-cannot-set-this',
    },
  });
  assert.equal(response.status, 200);
  const record = daemon.last('/api/v1/status');
  assert.ok(record, 'upstream must receive the status request');
  assert.equal(record.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(record.headers.origin, undefined);
  assert.equal(record.headers.referer, undefined);
  assert.equal(record.headers.cookie, undefined);
  assert.equal(record.headers['x-aegis-csrf'], undefined, 'GET must not carry CSRF');
  const text = await response.text();
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(csrfFor(TOKEN)));
});

test('写请求闸门：缺 x-console-v2:1 → 403 CONSOLE_HEADER_REQUIRED 且不到 daemon；带上后注入 csrf 并透传', async (t) => {
  const daemon = await startFakeDaemon(t);
  const console = await startConsole(t, { daemonUrl: daemon.url });

  const blocked = await fetch(`${console.url}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:1' },
    body: '{}',
  });
  assert.equal(blocked.status, 403);
  assert.match(await blocked.text(), /CONSOLE_HEADER_REQUIRED/u);
  assert.equal(daemon.requests.length, 0, 'blocked write must not reach the daemon');

  const allowed = await fetch(`${console.url}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-v2': '1', origin: 'http://127.0.0.1:1' },
    body: JSON.stringify({ sessionId: 's_test', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(allowed.status, 200);
  // 把流读完，避免悬挂连接
  await allowed.text();
  const record = daemon.last('/api/v1/agent/chat');
  assert.ok(record);
  assert.equal(record.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(record.headers['x-aegis-csrf'], csrfFor(TOKEN), 'host must inject the derived CSRF token');
  assert.equal(record.headers['x-console-v2'], undefined, 'browser-side marker must not be forwarded');
  assert.equal(record.headers.origin, undefined);
});

test('SSE 透传：首帧 <1s、无 content-length、事件原样到达', async (t) => {
  const daemon = await startFakeDaemon(t, {
    sseDelayMs: 20,
    sseFrames: [
      { event: 'delta', data: { seq: 1, text: '首帧' } },
      { event: 'delta', data: { seq: 2, text: '第二帧' } },
      { event: 'done', data: { seq: 3, finishReason: 'stop', totalTokens: null } },
    ],
  });
  const console = await startConsole(t, { daemonUrl: daemon.url });
  const started = Date.now();
  const controller = new AbortController();
  const response = await fetch(`${console.url}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-v2': '1' },
    body: '{}',
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
  assert.equal(response.headers.get('content-length'), null, 'SSE must not be buffered with content-length');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const firstChunkAt = await (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      received += decoder.decode(value, { stream: true });
      if (received.includes('data:')) return Date.now();
    }
  })();
  assert.ok(firstChunkAt !== null, 'SSE must emit at least one frame');
  assert.ok(firstChunkAt - started < 1000, `first SSE byte must arrive <1s (got ${firstChunkAt - started}ms)`);
  while (!received.includes('event: done')) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  assert.match(received, /"seq":1/u);
  assert.match(received, /event: done/u);
  controller.abort();
});

test('SSE 断连传播：客户端 abort → 上游请求在 2s 内被 destroy', async (t) => {
  const daemon = await startFakeDaemon(t, {
    sseDelayMs: 100,
    sseFrames: [
      { event: 'delta', data: { seq: 1, text: 'A' } },
      { event: 'delta', data: { seq: 2, text: 'B' } },
      { event: 'delta', data: { seq: 3, text: 'C' } },
    ],
  });
  const console = await startConsole(t, { daemonUrl: daemon.url });
  const controller = new AbortController();
  const response = await fetch(`${console.url}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-v2': '1' },
    body: '{}',
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value && first.value.byteLength > 0);
  controller.abort();
  await waitUntil(() => daemon.requests[0]?.abortedAt !== null, 2000, 'upstream socket destroyed after client abort');
  assert.ok(daemon.requests[0].abortedAt >= 0);
});
