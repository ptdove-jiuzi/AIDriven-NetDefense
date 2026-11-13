/**
 * defect-close-r4-001.test.js — 回归守卫：控制 API 绑 `::1` 时不得全部路由 404。
 *
 * 背景（BUG-LEDGER R4-001）：
 * `new URL('/healthz', 'http://::1')` 抛 `ERR_INVALID_URL`：裸 IPv6 字面量不是合法 authority，
 * 于是请求目标解析失败、**所有路由（含 `/healthz`）回 404**。修法是按地址族分支：
 *   - IPv6（含 `:`）→ `http://[::1]`
 *   - IPv4（`127.0.0.1`）→ `http://127.0.0.1`
 * 这条守卫同时抓两个方向：
 *   - 把 `urlBaseFor(host)` 改回 `http://${host}` → ::1 的 `/healthz` 变 404 → 第 1 组红；
 *   - 无条件加方括号（波次 2 的 M1 变异）→ IPv4 对照组红 → 第 2 组红。
 * 只加方括号不是修复——这正是 R4-001 台账里"变异验证未做"的原因。
 *
 * 变异证明用副本路径由 `DEFECT_CLOSE_SERVER_MODULE` 指定（缺省=仓库真实文件）。
 * 生成器：`docs/implementation/evidence/defect-close/R4-001/fix/mutate-server-urlbase.mjs`
 *
 * 运行：node --test tests/wp5-daemon/defect-close-r4-001.test.js
 *
 * 作者：PT-dove
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createAuthGuard } from '../../apps/daemon/src/api/auth.js';
import { BASE_MS, TEST_TOKEN, createManualClock } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SERVER_MODULE = process.env.DEFECT_CLOSE_SERVER_MODULE === undefined
  ? path.join(REPO_ROOT, 'apps', 'daemon', 'src', 'api', 'server.js')
  : path.resolve(process.env.DEFECT_CLOSE_SERVER_MODULE);

const { createControlApi } = await import(pathToFileURL(SERVER_MODULE).href);

const servers = new Set();

after(async () => {
  for (const api of servers) {
    await api.close();
  }
  servers.clear();
});

const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };

/** Start a real listener bound to one loopback literal, with stub handlers. */
async function startApi(host) {
  const auth = createAuthGuard({
    token: TEST_TOKEN,
    clock: createManualClock(BASE_MS),
    failureLimit: 10_000,
    failureWindowMs: 60_000,
  });
  const api = createControlApi({
    config: {
      host,
      port: 0,
      requestTimeoutMs: 2000,
      headersTimeoutMs: 2000,
      keepAliveTimeoutMs: 1000,
      maxBodyBytes: 65536,
    },
    auth,
    handlers: {
      health: () => ({ status: 'ok', version: 'defect-close-r4-001' }),
      ready: () => ({ ready: true, body: { ready: true, lifecycle: 'running', reasons: [] } }),
      status: () => ({ lifecycle: 'running', counters: { polls: 0 } }),
      pollSource: async (sourceId) => ({ id: sourceId }),
      listAlerts: async () => ({ alerts: [], next_cursor: null }),
      listAnalyses: async () => ({ analyses: [], next_cursor: null }),
    },
  });
  const address = await api.start();
  servers.add(api);
  return { api, address };
}

/** A URL valid for the given literal: IPv6 authorities must be bracketed. */
function urlFor(host, port, pathname) {
  const authority = host.includes(':') ? `[${host}]` : host;
  return `http://${authority}:${port}${pathname}`;
}

async function probe(host, port, pathname, headers = {}) {
  const response = await fetch(urlFor(host, port, pathname), { headers });
  const text = await response.text();
  let body = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

describe('R4-001：绑 ::1 时路由必须可达（回退到 http://localhost-形式会红）', () => {
  it('::1 上 /healthz 与带 token 的 /api/v1/* 都是 200，不是 404', async (t) => {
    let api;
    try {
      ({ api } = await startApi('::1'));
    } catch (error) {
      // No IPv6 stack: the assertion cannot be made, and it must not be faked.
      t.skip(`::1 is not bindable in this environment: ${error?.code ?? error}`);
      return;
    }
    const { host, port } = api.address();
    try {
      assert.equal(host, '::1', '监听器必须绑在 ::1 上');
      assert.equal(Number.isSafeInteger(port) && port > 0, true, '必须拿到真实端口');

      const health = await probe('::1', port, '/healthz');
      assert.equal(health.status, 200, 'GET /healthz 在 ::1 上必须 200（回退到 http://${host} 时这里是 404）');
      assert.equal(health.body?.status, 'ok');

      const status = await probe('::1', port, '/api/v1/status', BEARER);
      assert.equal(status.status, 200, '带 token 的 GET /api/v1/status 在 ::1 上必须 200');
      assert.equal(status.body?.lifecycle, 'running');

      const alerts = await probe('::1', port, '/api/v1/alerts', BEARER);
      assert.equal(alerts.status, 200, '带 token 的 GET /api/v1/alerts 在 ::1 上必须 200');

      // Route matching must actually happen: an unauthenticated call is 401, not "no such route" 404.
      const unauthenticated = await probe('::1', port, '/api/v1/status');
      assert.equal(unauthenticated.status, 401, '未带 token 的 /api/v1/status 必须是 401（404 说明路由根本没匹配上）');
    } finally {
      await api.close();
      servers.delete(api);
    }
  });

  it('IPv4 对照组 127.0.0.1 不回退：无条件加方括号会让这里红（波次 2 的 M1 变异）', async () => {
    const { api } = await startApi('127.0.0.1');
    const { host, port } = api.address();
    try {
      assert.equal(host, '127.0.0.1');
      assert.equal((await probe('127.0.0.1', port, '/healthz')).status, 200, 'GET /healthz');
      assert.equal((await probe('127.0.0.1', port, '/api/v1/status', BEARER)).status, 200, 'GET /api/v1/status');
      assert.equal((await probe('127.0.0.1', port, '/api/v1/alerts', BEARER)).status, 200, 'GET /api/v1/alerts');
      assert.equal((await probe('127.0.0.1', port, '/api/v1/status')).status, 401, '未带 token 必须是 401');
    } finally {
      await api.close();
      servers.delete(api);
    }
  });
});
