/**
 * api-read.test.js — the two read-only query endpoints, end to end.
 *
 * What is verified here is the *surface*, not the projection internals: admission,
 * the closed query grammar, cursor rejection, keyset pagination over real rows and
 * the redaction boundary as it is actually serialized on the wire. The projection
 * whitelist is asserted with `Object.keys().sort()` deep equality, because that is
 * the only form that fails when a field is added "just in case".
 *
 * Two shapes of system under test are used on purpose:
 *
 * - a stub in-memory store behind a real `createControlApi` on a real loopback
 *   socket, so admission, headers, status codes and query handling are exercised
 *   without a database;
 * - a real `createDaemon` in mock mode for the redaction tests, because the
 *   forbidden strings (`idempotency_key`, `summary_json`, lease columns, the data
 *   directory path) only exist once the pipeline has written actual rows.
 *
 * Every server binds `127.0.0.1:0` and is closed in a file-level hook.
 */

import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { API_CODES } from '../../apps/daemon/src/api/errors.js';
import { createAuthGuard } from '../../apps/daemon/src/api/auth.js';
import { createControlApi } from '../../apps/daemon/src/api/server.js';
import { createReadEndpoints } from '../../apps/daemon/src/api/read-endpoints.js';
import { createReadModel } from '../../apps/daemon/src/api/read-model.js';
import { CURSOR_KIND, createCursorCodec } from '../../apps/daemon/src/api/cursor.js';
import { createDaemon } from '../../apps/daemon/src/daemon.js';
import {
  BASE_MS,
  TEST_TOKEN,
  createManualClock,
  createScriptedSource,
  httpRequest,
  makeConfig,
  makeEvent,
  makeTempDir,
  waitFor,
} from './helpers.js';

const AUTH = Object.freeze({ authorization: `Bearer ${TEST_TOKEN}` });

/**
 * A second, equally well-formed token. Used only to prove that cursors are bound to
 * the token-derived key (contract §4.3), never as a fixture value in a response.
 */
const ROTATED_TOKEN = 'wp5-other-token-0123456789abcdefghij';

/** Contract §6.1: exactly these fields, nothing else. */
const ALERT_KEYS = Object.freeze([
  'alert_id',
  'count',
  'evidence_count',
  'evidence_truncated',
  'first_seen',
  'last_seen',
  'rule_id',
  'rule_version',
  'severity',
  'status',
  'window_end',
  'window_start',
].sort());

/** Contract §6.2: exactly these fields, nothing else. */
const ANALYSIS_KEYS = Object.freeze([
  'alert_id',
  'analysis_id',
  'attempts',
  'budget_class',
  'completed_at',
  'created_at',
  'report_available',
  'state',
  'updated_at',
].sort());

const servers = new Set();

after(async () => {
  for (const api of servers) {
    await api.close();
  }
  servers.clear();
});

/**
 * Build one stored alert row for the in-memory adapter.
 *
 * The row deliberately carries every column the read model must *not* echo
 * (`event_ids`, `evidence_refs`, `fingerprint`, `canonical_*`, `idempotency_key`,
 * `owner`, `failure_reason`, lease state). A whitelist projection drops them; a
 * spread-and-delete projection would let them through, and the key-set assertions
 * would catch it.
 *
 * @param {{id: string, lastSeenMs: number, evidence?: number, truncated?: boolean, count?: number}} spec Row spec.
 * @returns {object} Stored alert row.
 */
function alertRow(spec) {
  const iso = new Date(spec.lastSeenMs).toISOString();
  const evidence = spec.evidence ?? 1;
  return {
    alert_id: spec.id,
    rule_id: 'proc.suspicious-start',
    rule_version: '1.0.0',
    fingerprint: 'a'.repeat(64),
    severity: 'high',
    status: 'new',
    count: spec.count ?? evidence,
    first_seen: iso,
    last_seen: iso,
    window_start: iso,
    window_end: iso,
    event_ids: Array.from({ length: evidence }, (_, index) => `event-${spec.id}-${index}`),
    event_ids_truncated: spec.truncated === true,
    evidence_refs: [`ref-${spec.id}`],
    canonical_json: '{"internal":true}',
    canonical_digest: 'b'.repeat(64),
    summary_json: '{"analysis":"internal"}',
    idempotency_key: `idem-${spec.id}`,
    owner: 'worker-0',
    failure_reason: 'not-a-real-failure',
    lease_expires_at_ms: BASE_MS + 60_000,
    claimed_at: iso,
  };
}

/**
 * Build one stored analysis row for the in-memory adapter.
 *
 * @param {{id: string, createdAtMs: number}} spec Row spec.
 * @returns {object} Stored analysis row.
 */
function analysisRow(spec) {
  const iso = new Date(spec.createdAtMs).toISOString();
  return {
    analysis_id: spec.id,
    alert_id: `al-${spec.id}`,
    state: 'queued',
    budget_class: 'standard',
    attempt_seq: 1,
    created_at: iso,
    updated_at: iso,
    completed_at: null,
    report_available: false,
    // Internal columns the projection must drop.
    summary_json: '{"analysis":"internal"}',
    summary_digest: 'c'.repeat(64),
    idempotency_key: `idem-${spec.id}`,
  };
}

/**
 * Issue one GET through `node:http` so the `Host` header can be set verbatim.
 *
 * `fetch` always rewrites `Host`, which makes the admission check untestable through
 * the usual helper.
 *
 * @param {number} port Bound port.
 * @param {string} pathname Request target.
 * @param {Record<string, string>} headers Raw headers.
 * @returns {Promise<{status: number, headers: object, body: any, text: string}>} Response.
 */
function rawGet(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = text.length === 0 ? null : JSON.parse(text);
        } catch {
          body = null;
        }
        resolve({ status: response.statusCode, headers: response.headers, body, text });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * Start a control API whose read handlers are the real endpoints over a stub store.
 *
 * @param {{
 *   alerts?: object[],
 *   analyses?: object[],
 *   wireHandlers?: boolean,
 *   token?: string,
 *   readModel?: object
 * }} [options] Options.
 * @returns {Promise<{api: object, address: {host: string, port: number}, calls: object,
 *   auth: object, alerts: object[], analyses: object[]}>} Harness. The `alerts` and
 *   `analyses` arrays are the live fixtures: mutating one simulates a concurrent write.
 */
async function startReadApi(options = {}) {
  const clock = createManualClock(BASE_MS);
  // A high failure limit keeps the admission tests from turning into rate-limit
  // tests; the lockout has its own coverage in api-endpoints.test.js.
  const auth = createAuthGuard({
    token: options.token ?? TEST_TOKEN,
    clock,
    failureLimit: 10_000,
    failureWindowMs: 60_000,
  });
  const alerts = options.alerts ?? [];
  const analyses = options.analyses ?? [];
  const store = {
    kind: 'memory',
    isOpen: () => true,
    dump: () => ({ alerts: alerts.map((row) => ({ ...row })), analyses: analyses.map((row) => ({ ...row })) }),
  };
  const readModel = options.readModel ?? createReadModel({ store, storePath: join(makeTempDir(), 'unused.db'), clock });
  const endpoints = createReadEndpoints({ readModel, cursorKey: auth.cursorKey });

  const calls = { listAlerts: 0, listAnalyses: 0 };
  const baseHandlers = {
    health: () => ({ status: 'ok', version: 'test-1' }),
    ready: () => ({ ready: true, body: { ready: true, lifecycle: 'running', reasons: [] } }),
    status: () => ({ lifecycle: 'running', counters: {} }),
    pollSource: async (sourceId) => ({ id: sourceId, lifecycle: 'ok' }),
  };
  const handlers = options.wireHandlers === false
    ? baseHandlers
    : {
      ...baseHandlers,
      listAlerts: (searchParams) => {
        calls.listAlerts += 1;
        return endpoints.listAlerts(searchParams);
      },
      listAnalyses: (searchParams) => {
        calls.listAnalyses += 1;
        return endpoints.listAnalyses(searchParams);
      },
    };

  const api = createControlApi({
    config: {
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 2000,
      headersTimeoutMs: 2000,
      keepAliveTimeoutMs: 1000,
      maxBodyBytes: 1024,
      authFailureWindowMs: 60_000,
    },
    auth,
    handlers,
  });
  const address = await api.start();
  servers.add(api);
  return { api, address, calls, auth, alerts, analyses };
}

/**
 * Walk every page of one endpoint.
 *
 * @param {number} port Bound port.
 * @param {string} pathname Endpoint path.
 * @param {number} limit Page size.
 * @param {string} key Item array key (`alerts` / `analyses`).
 * @returns {Promise<object[]>} Pages in order.
 */
async function collectPages(port, pathname, limit, key) {
  const pages = [];
  let cursor = null;
  for (let hop = 0; hop < 10; hop += 1) {
    const query = cursor === null
      ? `?limit=${limit}`
      : `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
    const response = await httpRequest(port, `${pathname}${query}`, { headers: AUTH });
    assert.equal(response.status, 200, `${pathname} 第 ${pages.length + 1} 页必须 200`);
    assert.ok(Array.isArray(response.body[key]), '条目必须是数组');
    pages.push(response.body);
    const next = response.body.page.next_cursor;
    if (next === null) {
      return pages;
    }
    assert.equal(typeof next, 'string', '下一页游标必须是字符串');
    cursor = next;
  }
  assert.fail('分页没有终止：游标循环');
}

/**
 * Boot a real daemon in mock mode and wait until it has stored one alert.
 *
 * @param {object} t node:test context.
 * @returns {Promise<{daemon: object, dir: string, port: number}>} Booted daemon.
 */
async function bootMockDaemon(t) {
  const dir = makeTempDir();
  const daemon = createDaemon({
    config: makeConfig(dir),
    sources: [createScriptedSource({ id: 'synthetic.process', script: [[makeEvent({ source_seq: 1 })]] })],
    clock: createManualClock(BASE_MS),
  });
  t.after(async () => {
    await daemon.shutdown('test');
  });
  await daemon.start();
  await waitFor(() => daemon.status().store.stats().alerts === 1, { label: 'mock daemon stored one alert' });
  return { daemon, dir, port: daemon.address().port };
}

describe('read endpoint admission', () => {
  it('answers 401 AUTH_REQUIRED without a bearer on both endpoints, echoing no token', async () => {
    const { address } = await startReadApi();
    for (const pathname of ['/api/v1/alerts', '/api/v1/analysis']) {
      const response = await httpRequest(address.port, pathname);
      assert.equal(response.status, 401, `${pathname} 无 Bearer 必须 401`);
      assert.equal(response.body.error.code, DAEMON_CODES.AUTH_REQUIRED, `${pathname} 错误码`);
      assert.equal(response.text.includes(TEST_TOKEN), false, `${pathname} 不得回显 token`);
      assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer /u);
    }
  });

  it('answers 401 AUTH_FAILED for a wrong bearer on both endpoints', async () => {
    const { address } = await startReadApi();
    for (const pathname of ['/api/v1/alerts', '/api/v1/analysis']) {
      const response = await httpRequest(address.port, pathname, {
        headers: { authorization: `Bearer ${'z'.repeat(40)}` },
      });
      assert.equal(response.status, 401, `${pathname} 错误 Bearer 必须 401`);
      assert.equal(response.body.error.code, DAEMON_CODES.AUTH_FAILED, `${pathname} 错误码`);
      assert.equal(response.text.includes('z'.repeat(40)), false, `${pathname} 不得回显提交的 Bearer`);
    }
  });

  it('answers 405 METHOD_NOT_ALLOWED to POST on both endpoints without calling the handler', async () => {
    const { address, calls, auth } = await startReadApi({ alerts: [alertRow({ id: 'al-0', lastSeenMs: BASE_MS })] });
    for (const pathname of ['/api/v1/alerts', '/api/v1/analysis']) {
      const response = await httpRequest(address.port, pathname, {
        method: 'POST',
        headers: {
          ...AUTH,
          'x-aegis-csrf': auth.csrfToken,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(response.status, 405, `${pathname} 非 GET 必须 405`);
      assert.equal(response.body.error.code, DAEMON_CODES.METHOD_NOT_ALLOWED, `${pathname} 错误码`);
    }
    assert.equal(calls.listAlerts, 0, 'POST 不得调用 alerts 处理器');
    assert.equal(calls.listAnalyses, 0, 'POST 不得调用 analysis 处理器');
  });

  it('answers 500 INTERNAL when the query handlers were not wired, instead of crashing', async () => {
    const { address } = await startReadApi({ wireHandlers: false });
    for (const pathname of ['/api/v1/alerts', '/api/v1/analysis']) {
      const response = await httpRequest(address.port, pathname, { headers: AUTH });
      assert.equal(response.status, 500, `${pathname} 缺处理器必须 500`);
      assert.equal(response.body.error.code, DAEMON_CODES.INTERNAL, `${pathname} 错误码`);
      assert.equal(response.text.includes('TypeError'), false, `${pathname} 不得泄漏内部异常类型`);
    }
  });

  it('answers 500 INTERNAL when the read model returns a malformed page shape', async () => {
    // `{}` is neither a page nor an empty result. Rendering it as `200 []` would tell
    // the operator "there are no alerts", which is the one answer this endpoint must
    // never invent; it must surface as an unexpected fault instead.
    const readModel = {
      listAlerts: async () => ({}),
      listAnalyses: async () => ({}),
    };
    const { address } = await startReadApi({ readModel });

    for (const pathname of ['/api/v1/alerts', '/api/v1/analysis']) {
      const response = await httpRequest(address.port, pathname, { headers: AUTH });
      assert.equal(response.status, 500, `${pathname} 畸形页必须是 500`);
      assert.notEqual(response.status, 200, `${pathname} 不得降级成 200`);
      assert.equal(response.body.error.code, DAEMON_CODES.INTERNAL, `${pathname} 错误码必须是 INTERNAL`);
      assert.equal(response.text.includes('[]'), false, `${pathname} 不得把畸形页渲染成空数组`);

      // `details` is identifiers and short reasons only; a stack or a repository path
      // would turn a fault into a description of the deployment.
      for (const needle of ['网络防御', 'AIUSE', 'apps', 'packages', 'read-model.js', 'query.js', '\\']) {
        assert.equal(response.text.includes(needle), false, `${pathname} 响应体不得包含 ${needle}`);
      }
    }
  });

  it('answers 421 HOST_REJECTED on the alerts endpoint for a non-loopback or wrong-port Host', async () => {
    const { address } = await startReadApi({ alerts: [alertRow({ id: 'al-0', lastSeenMs: BASE_MS })] });
    const wrongPort = address.port >= 65_535 ? 1 : address.port + 1;
    const cases = [
      { host: 'evil.example', why: '非回环主机名' },
      { host: `127.0.0.1:${wrongPort}`, why: '回环地址但端口不是监听端口' },
    ];
    for (const item of cases) {
      // `fetch` rewrites `Host`, so this admission check is only reachable through
      // `node:http` with the header set explicitly.
      const response = await rawGet(address.port, '/api/v1/alerts', { host: item.host, ...AUTH });
      assert.equal(response.status, 421, `Host=${item.host}（${item.why}）必须 421`);
      assert.equal(response.body.error.code, DAEMON_CODES.HOST_REJECTED, `Host=${item.host} 错误码`);
      assert.equal(response.text.includes('al-0'), false, `Host=${item.host} 不得触达处理器，也就不得返回告警`);
      assert.equal(response.text.includes(item.host), false, `Host=${item.host} 不得被回显`);
    }
  });

  it('sets the hardened headers on both query responses', async () => {
    const { address } = await startReadApi({ alerts: [alertRow({ id: 'al-0', lastSeenMs: BASE_MS })] });
    for (const pathname of ['/api/v1/alerts', '/api/v1/analysis']) {
      const response = await httpRequest(address.port, pathname, { headers: AUTH });
      assert.equal(response.status, 200, `${pathname} 必须 200`);
      assert.equal(response.headers.get('cache-control'), 'no-store', `${pathname} cache-control`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${pathname} nosniff`);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${pathname} referrer-policy`);
      assert.equal(response.headers.get('x-frame-options'), 'DENY', `${pathname} x-frame-options`);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8', `${pathname} content-type`);

      // Contract §2 lists six fixed headers; the CSP was the one missing from this
      // assertion. Assert both the exact value and the part that actually blocks
      // resource loading, so a weakened policy cannot pass on the literal alone.
      const csp = response.headers.get('content-security-policy');
      assert.equal(
        csp,
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        `${pathname} content-security-policy 必须与契约逐字一致`,
      );
      assert.match(csp ?? '', /default-src 'none'/u, `${pathname} CSP 必须包含 default-src 'none'`);
    }
  });
});

describe('read endpoint envelope defaults', () => {
  it('returns the contract envelope for an empty alerts table', async () => {
    const { address } = await startReadApi();
    const response = await httpRequest(address.port, '/api/v1/alerts', { headers: AUTH });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.alerts, []);
    assert.deepEqual(response.body.page, {
      limit: 50,
      returned: 0,
      has_more: false,
      next_cursor: null,
      order: 'last_seen_desc',
      byte_limited: false,
    });
    assert.deepEqual(Object.keys(response.body).sort(), ['alerts', 'page']);
  });

  it('returns the contract envelope for an empty analysis table', async () => {
    const { address } = await startReadApi();
    const response = await httpRequest(address.port, '/api/v1/analysis', { headers: AUTH });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.analyses, []);
    assert.equal(response.body.page.order, 'created_at_desc');
    assert.deepEqual(response.body.page, {
      limit: 50,
      returned: 0,
      has_more: false,
      next_cursor: null,
      order: 'created_at_desc',
      byte_limited: false,
    });
    assert.deepEqual(Object.keys(response.body).sort(), ['analyses', 'page']);
  });
});

describe('read endpoint query surface', () => {
  const ALERTS = [
    alertRow({ id: 'al-0', lastSeenMs: BASE_MS + 4000 }),
    alertRow({ id: 'al-1', lastSeenMs: BASE_MS + 3000 }),
    alertRow({ id: 'al-2', lastSeenMs: BASE_MS + 2000 }),
  ];

  it('accepts the boundary values limit=1 and limit=100', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    const one = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    assert.equal(one.status, 200);
    assert.equal(one.body.page.limit, 1);
    assert.equal(one.body.alerts.length, 1);
    assert.equal(one.body.page.returned, 1);

    const hundred = await httpRequest(address.port, '/api/v1/alerts?limit=100', { headers: AUTH });
    assert.equal(hundred.status, 200);
    assert.equal(hundred.body.page.limit, 100);
    assert.equal(hundred.body.alerts.length, 3, '只有 3 条时 limit=100 必须返回全部');
    assert.equal(hundred.body.page.has_more, false);
  });

  it('rejects every non-integer or out-of-range limit with 400 QUERY_INVALID', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    const cases = [
      { raw: '0', why: '下界外' },
      { raw: '101', why: '上界外' },
      { raw: '-1', why: '负数' },
      { raw: '5.0', why: '小数写法' },
      { raw: '05', why: '前导零' },
      { raw: '1e2', why: '指数写法' },
      { raw: 'abc', why: '非数字' },
      { raw: '%205', why: '前导空格' },
    ];
    for (const item of cases) {
      const response = await httpRequest(address.port, `/api/v1/alerts?limit=${item.raw}`, { headers: AUTH });
      assert.equal(response.status, 400, `limit=${item.raw} (${item.why}) 必须 400`);
      assert.equal(response.body.error.code, API_CODES.QUERY_INVALID, `limit=${item.raw} (${item.why}) 错误码`);
      assert.equal(response.body.error.details.parameter, 'limit', `limit=${item.raw} 必须指向 limit`);
    }
  });

  it('rejects a duplicated limit and any unknown parameter with 400 QUERY_INVALID', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    const duplicated = await httpRequest(address.port, '/api/v1/alerts?limit=5&limit=6', { headers: AUTH });
    assert.equal(duplicated.status, 400);
    assert.equal(duplicated.body.error.code, API_CODES.QUERY_INVALID);
    assert.equal(duplicated.body.error.details.parameter, 'limit');

    const unknown = [
      { query: 'offset=10', parameter: 'offset' },
      { query: 'severity=high', parameter: 'severity' },
      { query: 'limit=5&offset=10', parameter: 'offset' },
    ];
    for (const item of unknown) {
      const response = await httpRequest(address.port, `/api/v1/alerts?${item.query}`, { headers: AUTH });
      assert.equal(response.status, 400, `?${item.query} 必须 400`);
      assert.equal(response.body.error.code, API_CODES.QUERY_INVALID, `?${item.query} 错误码`);
      assert.equal(response.body.error.details.parameter, item.parameter, `?${item.query} 必须指向首个违规参数`);
    }
  });

  it('reports limit_max in the details of an over-range limit', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    const response = await httpRequest(address.port, '/api/v1/analysis?limit=101', { headers: AUTH });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, API_CODES.QUERY_INVALID);
    assert.equal(response.body.error.details.limit_max, 100);
    assert.equal(response.body.error.details.parameter, 'limit');
  });

  it('rejects an empty limit or cursor value', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    for (const query of ['limit=', 'cursor=']) {
      const response = await httpRequest(address.port, `/api/v1/alerts?${query}`, { headers: AUTH });
      assert.equal(response.status, 400, `?${query} 必须 400`);
      assert.equal(response.body.error.code, API_CODES.QUERY_INVALID, `?${query} 错误码`);
      assert.equal(response.body.error.details.parameter, query.split('=')[0], `?${query} 参数名`);
    }
  });

  it('replaces a 3000-character unknown parameter name with <unknown> and keeps the body under 500 bytes', async () => {
    // Contract §8: `details.parameter` longer than 64 characters must not be echoed.
    // A 3000-character key would otherwise let one request decide the response size.
    const { address } = await startReadApi({ alerts: ALERTS });
    const longName = 'p'.repeat(3000);
    const response = await httpRequest(address.port, `/api/v1/alerts?${longName}=1`, { headers: AUTH });

    assert.equal(response.status, 400, '超长未知参数必须 400');
    assert.equal(response.body.error.code, API_CODES.QUERY_INVALID);
    assert.equal(response.body.error.details.parameter, '<unknown>', '超长参数名必须替换为 <unknown>');
    assert.equal(response.text.includes('p'.repeat(64)), false, '响应体不得回显任意长的参数名');
    const bytes = Buffer.byteLength(response.text, 'utf8');
    assert.ok(bytes < 500, `错误响应体必须小于 500 字节，实际 ${bytes}`);

    // Control: a short unknown name is still reported verbatim, so the cap is a cap
    // and not a blanket replacement of every parameter name.
    const control = await httpRequest(address.port, '/api/v1/alerts?offset=10', { headers: AUTH });
    assert.equal(control.status, 400);
    assert.equal(control.body.error.details.parameter, 'offset', '短参数名必须原样回报');
  });
});

describe('read endpoint cursor rejection', () => {
  const ALERTS = [
    alertRow({ id: 'al-0', lastSeenMs: BASE_MS + 4000 }),
    alertRow({ id: 'al-1', lastSeenMs: BASE_MS + 3000 }),
  ];

  it('rejects a garbage cursor and a three-segment cursor as malformed', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    for (const cursor of ['abc', 'a.b.c']) {
      const response = await httpRequest(address.port, `/api/v1/alerts?cursor=${cursor}`, { headers: AUTH });
      assert.equal(response.status, 400, `cursor=${cursor} 必须 400`);
      assert.equal(response.body.error.code, API_CODES.CURSOR_INVALID, `cursor=${cursor} 错误码`);
      // Exactly `malformed`: both inputs fail the segment-count check in the codec,
      // long before a MAC could be compared. Accepting `signature` here would let the
      // malformed branch disappear from the implementation while this stays green.
      assert.equal(
        response.body.error.details.reason,
        'malformed',
        `cursor=${cursor} 的 reason 必须是 malformed，实际 ${response.body.error.details.reason}`,
      );
    }
  });

  it('rejects a canonical 31-byte MAC segment as malformed, not signature', async () => {
    // Contract §4.4 draws the line on length: `signature` means "the MAC is 32 bytes
    // and does not match"; a MAC segment that decodes to any other length never had the
    // shape of a cursor this server issues, so it is `malformed`. Before this case the
    // branch had zero coverage and answered `signature`, contradicting the table.
    const { address } = await startReadApi({ alerts: ALERTS });
    const first = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    assert.equal(first.status, 200);
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string', '必须有真实 next_cursor');

    const [payloadSegment, macSegment] = cursor.split('.');
    assert.equal(typeof payloadSegment, 'string');
    assert.equal(typeof macSegment, 'string');
    const fullMac = Buffer.from(macSegment, 'base64url');
    assert.equal(fullMac.length, 32, '真实 cursor 的 MAC 必须是 32 字节');

    // Truncate by a whole byte rather than by a character: a one-character truncation
    // still decodes canonically only about 1 time in 16, which would make the fixture
    // itself flaky. 31 canonical bytes is the exact input the rule was written for.
    const shortMac = fullMac.subarray(0, 31).toString('base64url');
    assert.equal(Buffer.from(shortMac, 'base64url').length, 31);
    assert.equal(Buffer.from(shortMac, 'base64url').toString('base64url'), shortMac, 'MAC 段必须是规范 base64url');
    const truncated = `${payloadSegment}.${shortMac}`;
    assert.notEqual(truncated, cursor);
    assert.ok(truncated.length <= 512, 'fixture 必须落在长度上限内');

    const response = await httpRequest(address.port, `/api/v1/alerts?cursor=${encodeURIComponent(truncated)}`, {
      headers: AUTH,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, API_CODES.CURSOR_INVALID);
    assert.equal(
      response.body.error.details.reason,
      'malformed',
      `31 字节 MAC 必须是 malformed（不是 signature），实际 ${response.body.error.details.reason}`,
    );
    assert.equal(response.text.includes(truncated), false, '错误响应不得回显 cursor');
  });

  it('rejects non-canonical base64url segments as malformed', async () => {
    // Contract §4.4 lists "非规范 base64url" as `malformed` even when the numbers would
    // decode: Node accepts `=` padding and `+`/`/` aliases, so the canonical round trip
    // is the only thing that separates "a cursor we issued" from "an alias of one".
    const { address } = await startReadApi({ alerts: ALERTS });
    const first = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string');
    const [payloadSegment, macSegment] = cursor.split('.');

    const variants = {
      'padded payload': `${payloadSegment}=.${macSegment}`,
      'padded MAC': `${payloadSegment}.${macSegment}=`,
      'std-alphabet payload': `${payloadSegment.slice(0, -1)}+.${macSegment}`,
    };
    for (const [label, variant] of Object.entries(variants)) {
      assert.notEqual(variant, cursor, `${label} 必须与真实 cursor 不同`);
      assert.ok(variant.length <= 512, `${label} 必须落在长度上限内`);
      const response = await httpRequest(address.port, `/api/v1/alerts?cursor=${encodeURIComponent(variant)}`, {
        headers: AUTH,
      });
      assert.equal(response.status, 400, `${label} 必须 400`);
      assert.equal(response.body.error.code, API_CODES.CURSOR_INVALID, `${label} 错误码`);
      assert.equal(
        response.body.error.details.reason,
        'malformed',
        `${label} 必须是 malformed，实际 ${response.body.error.details.reason}`,
      );
    }

    // Control: the untouched cursor still continues the page, so the rejections above
    // are attributable to the encodings and not to a broken fixture.
    const control = await httpRequest(
      address.port,
      `/api/v1/alerts?limit=1&cursor=${encodeURIComponent(cursor)}`,
      { headers: AUTH },
    );
    assert.equal(control.status, 200, '原样 cursor 必须仍可用');
  });

  it('rejects a valid cursor whose payload was edited by one character', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    const first = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string');
    const index = 3;
    const replacement = cursor[index] === 'A' ? 'B' : 'A';
    const tampered = `${cursor.slice(0, index)}${replacement}${cursor.slice(index + 1)}`;
    assert.notEqual(tampered, cursor);

    const response = await httpRequest(address.port, `/api/v1/alerts?cursor=${encodeURIComponent(tampered)}`, {
      headers: AUTH,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, API_CODES.CURSOR_INVALID);
    // The edit lands in the payload segment (index 3 precedes the `.` separator), so
    // the MAC still has the right length and only the comparison can fail.
    assert.equal(
      response.body.error.details.reason,
      'signature',
      `reason 必须是 signature，实际 ${response.body.error.details.reason}`,
    );
    assert.equal(response.text.includes(tampered), false, '错误响应不得回显被篡改的 cursor');
    assert.equal(response.text.includes(cursor), false, '错误响应也不得回显签发过的原始 cursor');
  });

  it('does not echo a one-character edit of a real cursor, nor the cursor it came from', async () => {
    // The old assertion here used `cursor='abc'` and checked that `abc` was absent.
    // That only proves "the literal three letters are not echoed": an implementation
    // that echoed *other* cursor values stayed green. This uses a cursor the server
    // actually issued, edits exactly one character in the payload segment, and checks
    // both strings are absent — the tampered one and the original.
    const { address } = await startReadApi({ alerts: ALERTS });
    const first = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    assert.equal(first.status, 200);
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string', '必须有真实 next_cursor');
    assert.ok(cursor.length > 8, '真实 cursor 必须长到能安全改一位');

    const index = 2;
    const replacement = cursor[index] === 'A' ? 'B' : 'A';
    const tampered = `${cursor.slice(0, index)}${replacement}${cursor.slice(index + 1)}`;
    assert.equal(tampered.length, cursor.length, '篡改必须等长，只改一位');
    assert.notEqual(tampered, cursor);
    assert.equal(tampered.split('.').length, cursor.split('.').length, '篡改不得改变段结构');

    const response = await httpRequest(address.port, `/api/v1/alerts?cursor=${encodeURIComponent(tampered)}`, {
      headers: AUTH,
    });
    assert.equal(response.status, 400, '篡改一位的 cursor 必须 400');
    assert.equal(response.body.error.code, API_CODES.CURSOR_INVALID);
    assert.equal(response.text.includes(tampered), false, '响应体不得回显篡改后的 cursor');
    assert.equal(response.text.includes(cursor), false, '响应体不得回显原始 cursor');
  });

  it('rejects a cursor longer than 512 characters with reason too_long', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    const oversized = 'a'.repeat(513);
    const response = await httpRequest(address.port, `/api/v1/alerts?cursor=${oversized}`, { headers: AUTH });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, API_CODES.CURSOR_INVALID);
    assert.equal(response.body.error.details.reason, 'too_long');
  });

  it('treats 512 characters without a separator as malformed and keeps a real cursor continuable', async () => {
    const rows = [
      alertRow({ id: 'al-0', lastSeenMs: BASE_MS + 2000 }),
      alertRow({ id: 'al-1', lastSeenMs: BASE_MS + 1000 }),
    ];
    const { address } = await startReadApi({ alerts: rows });

    // Exactly at the cap: the length check is `> 512`, so this is not `too_long`. With
    // no `.` the codec stops at the segment count, which is the `malformed` reason.
    const atCap = 'A'.repeat(512);
    assert.equal(atCap.length, 512);
    const rejected = await httpRequest(address.port, `/api/v1/alerts?cursor=${atCap}`, { headers: AUTH });
    assert.equal(rejected.status, 400, '恰好 512 字符必须 400');
    assert.equal(rejected.body.error.code, API_CODES.CURSOR_INVALID);
    assert.equal(
      rejected.body.error.details.reason,
      'malformed',
      `512 字符无分隔点必须是 malformed（不是 too_long），实际 ${rejected.body.error.details.reason}`,
    );

    // The other side of the boundary: a cursor the server actually issued is well under
    // the cap and must continue the sequence.
    const first = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    assert.equal(first.status, 200);
    assert.equal(first.body.alerts.length, 1);
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string');
    assert.ok(cursor.length > 0 && cursor.length <= 512, `真实 cursor 长度必须 ≤ 512，实际 ${cursor.length}`);
    assert.ok(cursor.length < 512, '真实 cursor 必须严格小于上限，否则它自己就会被拒');

    const second = await httpRequest(address.port, `/api/v1/alerts?limit=1&cursor=${encodeURIComponent(cursor)}`, {
      headers: AUTH,
    });
    assert.equal(second.status, 200, '真实 cursor 必须可续页');
    assert.equal(second.body.alerts.length, 1);
    assert.equal(second.body.alerts[0].alert_id, 'al-1', '续页必须取到剩余那一条');
    assert.equal(second.body.page.next_cursor, null);
  });

  it('rejects a cursor issued under a rotated token with reason signature', async () => {
    const rows = [
      alertRow({ id: 'al-0', lastSeenMs: BASE_MS + 2000 }),
      alertRow({ id: 'al-1', lastSeenMs: BASE_MS + 1000 }),
    ];
    const original = await startReadApi({ alerts: rows });
    const rotated = await startReadApi({ alerts: rows, token: ROTATED_TOKEN });

    const first = await httpRequest(original.address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string');

    // Same cursor, same data, only the token (and therefore the derived MAC key)
    // differs. Contract §4.3: rotating the token invalidates outstanding cursors.
    const foreign = await httpRequest(
      rotated.address.port,
      `/api/v1/alerts?limit=1&cursor=${encodeURIComponent(cursor)}`,
      { headers: { authorization: `Bearer ${ROTATED_TOKEN}` } },
    );
    assert.equal(foreign.status, 400, '换 token 后的旧 cursor 必须 400');
    assert.equal(foreign.body.error.code, API_CODES.CURSOR_INVALID);
    assert.equal(
      foreign.body.error.details.reason,
      'signature',
      `换 key 必须是 signature，实际 ${foreign.body.error.details.reason}`,
    );

    // Control: the very same cursor still works against the issuer, so the rejection
    // is attributable to the key and not to the cursor being unusable.
    const same = await httpRequest(
      original.address.port,
      `/api/v1/alerts?limit=1&cursor=${encodeURIComponent(cursor)}`,
      { headers: AUTH },
    );
    assert.equal(same.status, 200, '同一 cursor 在原实例上必须仍然可用');
    assert.equal(same.body.alerts[0].alert_id, 'al-1');
  });

  it('rejects a structurally valid cursor signed with another key', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    const foreign = createCursorCodec('another-secret').encode({
      kind: CURSOR_KIND.alerts,
      ms: BASE_MS + 4000,
      id: 'al-0',
    });
    const response = await httpRequest(address.port, `/api/v1/alerts?cursor=${encodeURIComponent(foreign)}`, {
      headers: AUTH,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, API_CODES.CURSOR_INVALID);
    assert.equal(response.body.error.details.reason, 'signature');
  });

  it('rejects an alerts cursor replayed on the analysis endpoint with reason kind', async () => {
    const { address } = await startReadApi({ alerts: ALERTS });
    const first = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string');

    const response = await httpRequest(address.port, `/api/v1/analysis?cursor=${encodeURIComponent(cursor)}`, {
      headers: AUTH,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, API_CODES.CURSOR_INVALID);
    assert.equal(response.body.error.details.reason, 'kind');
  });
});

describe('read endpoint keyset pagination', () => {
  it('pages five alerts as 2/2/1 in strict last_seen descending order without gaps or repeats', async () => {
    const rows = [0, 1, 2, 3, 4].map((index) => alertRow({
      id: `al-${index}`,
      lastSeenMs: BASE_MS + index * 60_000,
      evidence: index + 1,
    }));
    const { address } = await startReadApi({ alerts: rows });

    const pages = await collectPages(address.port, '/api/v1/alerts', 2, 'alerts');
    assert.deepEqual(pages.map((page) => page.alerts.length), [2, 2, 1], '每页条数必须是 2/2/1');
    assert.deepEqual(pages.map((page) => page.page.has_more), [true, true, false], 'has_more 必须是 true/true/false');
    assert.deepEqual(pages.map((page) => page.page.returned), [2, 2, 1], 'returned 必须与条目数一致');
    assert.equal(pages[2].page.next_cursor, null, '末页 next_cursor 必须是 null');

    const ids = pages.flatMap((page) => page.alerts.map((alert) => alert.alert_id));
    assert.equal(ids.length, 5, '三页合计 5 条');
    assert.equal(new Set(ids).size, 5, '三页之间不得重复');
    assert.deepEqual([...ids].sort(), rows.map((row) => row.alert_id).sort(), 'id 并集必须恰好是全部 5 条');

    const seen = pages.flatMap((page) => page.alerts.map((alert) => Date.parse(alert.last_seen)));
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok(seen[index] < seen[index - 1], `第 ${index} 条必须严格早于前一条（last_seen 降序）`);
    }
  });

  it('breaks a last_seen tie by descending alert_id across pages', async () => {
    const sameMs = BASE_MS + 60_000;
    const rows = [
      alertRow({ id: 'al-b', lastSeenMs: sameMs }),
      alertRow({ id: 'al-a', lastSeenMs: sameMs }),
    ];
    const { address } = await startReadApi({ alerts: rows });

    const pages = await collectPages(address.port, '/api/v1/alerts', 1, 'alerts');
    assert.equal(pages.length, 2, '两条数据、limit=1 必须翻两页');
    const firstId = pages[0].alerts[0].alert_id;
    const secondId = pages[1].alerts[0].alert_id;
    assert.equal(firstId, 'al-b', '相同 last_seen 时 id 降序，al-b 在前');
    assert.equal(secondId, 'al-a');
    assert.ok(secondId < firstId, '第二页 id 必须按字典序小于第一页');
    assert.notEqual(firstId, secondId, '翻页不得重复');
    assert.equal(pages[1].page.has_more, false);
    assert.equal(pages[1].page.next_cursor, null);
  });

  it('offers a non-empty bounded next_cursor while more rows exist', async () => {
    const rows = [0, 1, 2].map((index) => alertRow({ id: `al-${index}`, lastSeenMs: BASE_MS + index * 60_000 }));
    const { address } = await startReadApi({ alerts: rows });
    const response = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    assert.equal(response.status, 200);
    assert.equal(response.body.page.has_more, true, '还有 2 条时 has_more 必须为 true');
    assert.equal(response.body.page.returned, 1);
    const cursor = response.body.page.next_cursor;
    assert.equal(typeof cursor, 'string');
    assert.ok(cursor.length > 0, 'next_cursor 必须非空');
    assert.ok(cursor.length <= 512, 'next_cursor 必须不超过 512 字符');
  });

  it('reports has_more false on the last page when the total divides the limit exactly', async () => {
    // Four rows, limit 2: the "fetch one more row" probe must not be mistaken for a
    // third page at the exact-division boundary.
    const rows = [0, 1, 2, 3].map((index) => alertRow({
      id: `al-${index}`,
      lastSeenMs: BASE_MS + (3 - index) * 60_000,
    }));
    const { address } = await startReadApi({ alerts: rows });

    const pages = await collectPages(address.port, '/api/v1/alerts', 2, 'alerts');
    assert.equal(pages.length, 2, '4 条、limit=2 必须恰好两页，不得多报一页');
    assert.deepEqual(pages.map((page) => page.alerts.length), [2, 2]);
    assert.deepEqual(pages.map((page) => page.page.has_more), [true, false], '整除边界上末页 has_more 必须为 false');
    assert.equal(pages[1].page.next_cursor, null, '整除边界上末页 next_cursor 必须为 null');
    const ids = pages.flatMap((page) => page.alerts.map((alert) => alert.alert_id));
    assert.deepEqual(ids, ['al-0', 'al-1', 'al-2', 'al-3']);
  });

  it('answers a replayed cursor with a byte-identical body, twice', async () => {
    const rows = [0, 1, 2].map((index) => alertRow({ id: `al-${index}`, lastSeenMs: BASE_MS + index * 60_000 }));
    const { address, calls } = await startReadApi({ alerts: rows });

    const first = await httpRequest(address.port, '/api/v1/alerts?limit=1', { headers: AUTH });
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string');
    const target = `/api/v1/alerts?limit=1&cursor=${encodeURIComponent(cursor)}`;

    const once = await httpRequest(address.port, target, { headers: AUTH });
    const twice = await httpRequest(address.port, target, { headers: AUTH });
    assert.equal(once.status, 200, '重放必须 200');
    assert.equal(twice.status, 200, '重放必须 200');
    assert.equal(calls.listAlerts, 3, '每次请求都必须经过处理器（读取不是副作用）');
    assert.equal(twice.text, once.text, '同一 cursor 重放的响应原文必须逐字节相同');
    assert.equal(JSON.stringify(twice.body), JSON.stringify(once.body), '重放响应体必须逐字节相同');
    assert.equal(once.body.alerts[0].alert_id, 'al-1');
    assert.equal(twice.body.alerts[0].alert_id, 'al-1');
  });

  it('documents the merge-drift limitation: a row raised past the cursor is skipped until reload', async () => {
    // Contract §10.1: `alert.last_seen` is a mutable sort key. A merge that raises it
    // between two page requests moves the row ahead of the cursor, so the rest of this
    // pagination sequence never returns it — it is not a duplicate and not a 4xx, it is
    // a documented, self-healing gap that a first-page reload closes. Pinned here so the
    // limitation cannot regress silently into "pagination is complete".
    const rows = [0, 1, 2, 3].map((index) => alertRow({
      id: `al-${index}`,
      lastSeenMs: BASE_MS + (3 - index) * 60_000,
    }));
    const { address, alerts } = await startReadApi({ alerts: rows });

    const firstPage = await httpRequest(address.port, '/api/v1/alerts?limit=2', { headers: AUTH });
    assert.deepEqual(firstPage.body.alerts.map((alert) => alert.alert_id), ['al-0', 'al-1']);
    const cursor = firstPage.body.page.next_cursor;
    assert.equal(typeof cursor, 'string');

    // Concurrent merge: `al-2` has not been returned yet and its `last_seen` jumps to
    // the newest position in the table.
    const raised = alerts.find((row) => row.alert_id === 'al-2');
    assert.ok(raised !== undefined, '夹具必须包含 al-2');
    raised.last_seen = new Date(BASE_MS + 30 * 60_000).toISOString();

    const secondPage = await httpRequest(
      address.port,
      `/api/v1/alerts?limit=2&cursor=${encodeURIComponent(cursor)}`,
      { headers: AUTH },
    );
    assert.equal(secondPage.status, 200);
    const union = [...firstPage.body.alerts, ...secondPage.body.alerts].map((alert) => alert.alert_id);
    assert.equal(union.includes('al-2'), false, '被抬升到游标之前的行不得出现在本次翻页序列里');
    assert.deepEqual(union, ['al-0', 'al-1', 'al-3'], '其余行的顺序不受影响');

    // Reload from the first screen: the row is visible again, now first.
    const reload = await httpRequest(address.port, '/api/v1/alerts?limit=2', { headers: AUTH });
    assert.equal(reload.body.alerts[0].alert_id, 'al-2', '从首屏重拉必须能看到漂移的行，且排在第一位');
    assert.equal(
      reload.body.alerts[0].last_seen,
      raised.last_seen,
      '重拉看到的必须是抬升后的 last_seen',
    );
  });
});

describe('read endpoint analysis keyset pagination', () => {
  it('pages three analyses as 1/1/1 with created_at descending and analysis_id tiebreak', async () => {
    // Two rows share a `created_at`, so the tiebreak is exercised across a page
    // boundary: `an-b` must come before `an-a` even though they are split by `limit=1`.
    const analyses = [
      analysisRow({ id: 'an-c', createdAtMs: BASE_MS + 3000 }),
      analysisRow({ id: 'an-b', createdAtMs: BASE_MS + 2000 }),
      analysisRow({ id: 'an-a', createdAtMs: BASE_MS + 2000 }),
    ];
    const { address } = await startReadApi({ analyses });

    const pages = await collectPages(address.port, '/api/v1/analysis', 1, 'analyses');
    assert.equal(pages.length, 3, '3 条、limit=1 必须翻三页');
    assert.deepEqual(pages.map((page) => page.analyses.length), [1, 1, 1], '每页条数必须是 1/1/1');
    assert.deepEqual(pages.map((page) => page.page.has_more), [true, true, false], 'has_more 必须是 true/true/false');
    assert.equal(pages[2].page.next_cursor, null, '末页 next_cursor 必须是 null');

    const ids = pages.flatMap((page) => page.analyses.map((analysis) => analysis.analysis_id));
    assert.deepEqual(ids, ['an-c', 'an-b', 'an-a'], '顺序必须是 created_at 降序、并列时 analysis_id 降序');
    assert.equal(new Set(ids).size, 3, '三页之间不得重复');

    const stamps = pages.flatMap((page) => page.analyses.map((analysis) => Date.parse(analysis.created_at)));
    for (let index = 1; index < stamps.length; index += 1) {
      assert.ok(stamps[index] <= stamps[index - 1], `第 ${index} 条不得晚于前一条（created_at 降序）`);
    }
  });
});

describe('read endpoint store failure', () => {
  it('answers 503 STORE_UNAVAILABLE instead of an empty alert list when the store cannot be opened', async () => {
    const clock = createManualClock(BASE_MS);
    const missing = join(makeTempDir(), 'missing.db');
    // `kind: 'sqlite'` makes the read model open a real read-only handle on first query;
    // the path does not exist, so the open fails.
    const readModel = createReadModel({ store: { kind: 'sqlite' }, storePath: missing, clock });
    const { address } = await startReadApi({ readModel });

    const response = await httpRequest(address.port, '/api/v1/alerts', { headers: AUTH });
    assert.equal(response.status, 503, '打不开存储必须 503，绝不能 200');
    assert.equal(response.body.error.code, DAEMON_CODES.STORE_UNAVAILABLE);
    // Contract §10: an empty list would read as "there are no alerts", the one wrong
    // answer this endpoint must never give.
    assert.equal('alerts' in response.body, false, '503 响应不得携带 alerts 键');
    assert.equal(response.text.includes('[]'), false, '响应不得含空数组，避免被读成"没有告警"');
    assert.equal(response.text.includes(missing), false, '响应不得回显库路径');
    assert.equal(existsSync(missing), false, '只读打开失败不得留下库文件');
    readModel.close();
  });
});

describe('read endpoint unrepresentable stored ids', () => {
  /**
   * Three rows so the second one is the page boundary *and* more data exists: a
   * cursor is only encoded for the last kept row when `has_more` is true.
   *
   * @param {string} boundaryId Id of the middle row.
   * @returns {object[]} Rows, newest first.
   */
  function rowsWithBoundary(boundaryId) {
    return [
      alertRow({ id: 'al-2', lastSeenMs: BASE_MS + 2000 }),
      alertRow({ id: boundaryId, lastSeenMs: BASE_MS + 1000 }),
      alertRow({ id: 'al-0', lastSeenMs: BASE_MS }),
    ];
  }

  it('answers 503 STORE_UNAVAILABLE UNREPRESENTABLE_ROW when the page boundary row id is non-ASCII', async () => {
    // Contract §4.4 (end): ids outside `^[\x20-\x7E]{1,128}$` cannot be encoded into a
    // cursor. That is a property of the stored row, not of the request, so it must be
    // reported as a store problem — never as a 4xx blaming the caller.
    const { address } = await startReadApi({ alerts: rowsWithBoundary('告警-1') });
    const response = await httpRequest(address.port, '/api/v1/alerts?limit=2', { headers: AUTH });

    assert.equal(response.status, 503, '页边界遇到非 ASCII id 必须 503');
    assert.equal(response.body.error.code, DAEMON_CODES.STORE_UNAVAILABLE);
    assert.equal(
      response.body.error.details.reason,
      'UNREPRESENTABLE_ROW',
      `details.reason 必须是 UNREPRESENTABLE_ROW，实际 ${response.body.error.details.reason}`,
    );
    assert.equal(response.text.includes('告警-1'), false, '响应体不得回显无法表示的存储 id');
    assert.equal('alerts' in response.body, false, '503 响应不得携带半个告警页');
    assert.equal(response.text.includes('[]'), false, '503 不得被读成"没有告警"');
  });

  it('keeps the same pagination working when that boundary id is ASCII', async () => {
    // Control for the case above: the 503 must come from the id, not from having two
    // rows at `limit=2`. With an ASCII id the same shape answers 200 and continues.
    const { address } = await startReadApi({ alerts: rowsWithBoundary('al-1') });
    const first = await httpRequest(address.port, '/api/v1/alerts?limit=2', { headers: AUTH });

    assert.equal(first.status, 200, '合法 ASCII id 必须 200');
    assert.deepEqual(first.body.alerts.map((alert) => alert.alert_id), ['al-2', 'al-1']);
    const cursor = first.body.page.next_cursor;
    assert.equal(typeof cursor, 'string', '还有一条时必须给出 next_cursor');
    assert.equal(first.body.page.has_more, true);

    const second = await httpRequest(
      address.port,
      `/api/v1/alerts?limit=2&cursor=${encodeURIComponent(cursor)}`,
      { headers: AUTH },
    );
    assert.equal(second.status, 200, '正常路径必须可续页');
    assert.deepEqual(second.body.alerts.map((alert) => alert.alert_id), ['al-0']);
    assert.equal(second.body.page.next_cursor, null);
  });
});

describe('read endpoint page envelope on non-empty pages', () => {
  it('emits exactly the six contracted page keys for both endpoints', async () => {
    const { address } = await startReadApi({
      alerts: [alertRow({ id: 'al-0', lastSeenMs: BASE_MS })],
      analyses: [analysisRow({ id: 'an-0', createdAtMs: BASE_MS })],
    });
    const expected = ['byte_limited', 'has_more', 'limit', 'next_cursor', 'order', 'returned'];

    const alerts = await httpRequest(address.port, '/api/v1/alerts', { headers: AUTH });
    assert.equal(alerts.status, 200);
    assert.equal(alerts.body.alerts.length, 1);
    assert.deepEqual(Object.keys(alerts.body.page).sort(), expected, '非空 alerts 页的 page 键集合必须恰好是契约 6 个');

    const analyses = await httpRequest(address.port, '/api/v1/analysis', { headers: AUTH });
    assert.equal(analyses.status, 200);
    assert.equal(analyses.body.analyses.length, 1);
    assert.deepEqual(Object.keys(analyses.body.page).sort(), expected, '非空 analysis 页的 page 键集合必须恰好是契约 6 个');
  });

  it('reports evidence_truncated true with count greater than evidence_count', async () => {
    // Contract §6.1: `count` is the aggregate and `evidence_count` the retained id count.
    // A truncated row is exactly where they legitimately differ.
    const { address } = await startReadApi({
      alerts: [alertRow({ id: 'al-trunc', lastSeenMs: BASE_MS, evidence: 1, truncated: true, count: 9 })],
    });
    const response = await httpRequest(address.port, '/api/v1/alerts', { headers: AUTH });
    assert.equal(response.status, 200);
    assert.equal(response.body.alerts.length, 1);

    const alert = response.body.alerts[0];
    assert.equal(alert.evidence_truncated, true, '被截断的行必须报 evidence_truncated:true');
    assert.equal(alert.count, 9, 'count 必须来自聚合列');
    assert.equal(alert.evidence_count, 1, 'evidence_count 必须是留存的事件 id 条数');
    assert.notEqual(alert.count, alert.evidence_count, '截断时两者不相等是对的');
  });
});

describe('read endpoints redaction on a live daemon', () => {
  it('serializes no internal column, path or token in the alerts response', async (t) => {
    const { daemon, dir, port } = await bootMockDaemon(t);
    const response = await httpRequest(port, '/api/v1/alerts', { headers: AUTH });
    assert.equal(response.status, 200);
    assert.equal(response.body.alerts.length, 1, '真跑 daemon 后必须有 1 条告警');

    const forbidden = [
      'event_ids',
      'evidence_refs',
      'fingerprint',
      'canonical_',
      'summary_',
      'idempotency',
      'owner',
      'failure_reason',
      'lease',
      'event_ids_json',
      'claimed_at',
      dir,
      TEST_TOKEN,
    ];
    for (const needle of forbidden) {
      assert.equal(response.text.includes(needle), false, `响应原文不得包含 ${needle}`);
    }

    const alert = response.body.alerts[0];
    assert.equal(Number.isInteger(alert.evidence_count), true, 'evidence_count 必须是整数');
    // Independent expectation: the fixture feeds exactly one event, which lands in one
    // 15-minute window, so both the aggregate count and the retained id list are 1.
    // Asserting that literal — instead of re-deriving it from the store — is what makes
    // a projection that counts something else fail.
    assert.equal(alert.evidence_count, 1, '单事件夹具的 evidence_count 必须恰好是 1');
    assert.equal(alert.count, 1, '单事件夹具的 count 必须恰好是 1');
    assert.equal(typeof alert.evidence_truncated, 'boolean', 'evidence_truncated 必须是布尔值');
    assert.equal(alert.evidence_truncated, false, '单条证据不可能被截断');
    assert.deepEqual(Object.keys(alert).sort(), ALERT_KEYS, 'alerts 条目必须恰好是契约那 12 个键');

    const stored = daemon.status().store.dump().alerts;
    assert.equal(stored.length, 1);
    assert.equal(alert.alert_id, stored[0].alert_id, '返回的 id 必须与存储中的告警一致');
    assert.equal(alert.rule_id, stored[0].rule_id);
    assert.equal(alert.severity, stored[0].severity);
  });

  it('serializes exactly the nine analysis fields, queued and without a report', async (t) => {
    const { port } = await bootMockDaemon(t);
    const response = await httpRequest(port, '/api/v1/analysis', { headers: AUTH });
    assert.equal(response.status, 200);
    assert.equal(response.body.analyses.length, 1, '真跑 daemon 后必须有 1 条分析请求');

    const entry = response.body.analyses[0];
    assert.deepEqual(Object.keys(entry).sort(), ANALYSIS_KEYS, 'analysis 条目必须恰好是契约那 9 个键');
    assert.equal(entry.state, 'queued');
    assert.equal(entry.report_available, false);
    assert.equal(entry.completed_at, null);
    assert.equal(entry.attempts, 0);
    assert.equal(response.text.includes('summary_json'), false, '响应原文不得包含 summary_json');
    assert.equal(response.text.includes('idempotency'), false, '响应原文不得包含 idempotency');
    assert.equal(response.text.includes(TEST_TOKEN), false, '响应原文不得包含 token');
  });
});
