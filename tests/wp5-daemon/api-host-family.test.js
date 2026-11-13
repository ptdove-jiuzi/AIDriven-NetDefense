/**
 * api-host-family.test.js — the control API on both supported loopback literals.
 *
 * `config.js` accepts `127.0.0.1` and `::1`. The request target used to be parsed
 * against `http://${host}`; a bare IPv6 literal is not a legal authority, so
 * `new URL()` threw `ERR_INVALID_URL` and every route — including `/healthz` — answered
 * 404 while the daemon was bound to `::1` (BUG-LEDGER R4-001). The fix has to follow the
 * address family: bracketing unconditionally makes `::1` work but breaks the IPv4
 * endpoint (the wave-2 M1 mutation proved that), so both endpoints are asserted here.
 */

import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';

import { createAuthGuard } from '../../apps/daemon/src/api/auth.js';
import { createControlApi } from '../../apps/daemon/src/api/server.js';
import { BASE_MS, TEST_TOKEN, createManualClock } from './helpers.js';

const servers = new Set();

after(async () => {
  for (const api of servers) {
    await api.close();
  }
  servers.clear();
});

/** Start a control API bound to one loopback literal, with stub handlers. */
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
      health: () => ({ status: 'ok', version: 'test-host-family' }),
      ready: () => ({ ready: true, body: { ready: true, lifecycle: 'running', reasons: [] } }),
      status: () => ({ lifecycle: 'running', counters: {} }),
      pollSource: async (sourceId) => ({ id: sourceId }),
      listAlerts: async () => ({ alerts: [], next_cursor: null }),
      listAnalyses: async () => ({ analyses: [], next_cursor: null }),
    },
  });
  const address = await api.start();
  servers.add(api);
  return { api, address, auth };
}

/** A URL that is valid for the given literal (IPv6 authorities must be bracketed). */
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
  return { status: response.status, body };
}

const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };

describe('control API address families (R4-001)', () => {
  it('serves /healthz and the authenticated /api/v1 routes when bound to ::1', async (t) => {
    let api;
    try {
      ({ api } = await startApi('::1'));
    } catch (error) {
      // No IPv6 on this host: the assertion cannot be made, but it must not be faked.
      t.skip(`::1 is not bindable in this environment: ${error?.code ?? error}`);
      return;
    }
    const { port } = api.address();
    assert.equal(api.address().host, '::1');

    const health = await probe('::1', port, '/healthz');
    assert.equal(health.status, 200, 'GET /healthz must be reachable on ::1');
    assert.equal(health.body?.status, 'ok');

    const status = await probe('::1', port, '/api/v1/status', BEARER);
    assert.equal(status.status, 200, 'authenticated GET /api/v1/status must be reachable on ::1');
    assert.equal(status.body?.lifecycle, 'running');

    const alerts = await probe('::1', port, '/api/v1/alerts', BEARER);
    assert.equal(alerts.status, 200, 'authenticated GET /api/v1/alerts must be reachable on ::1');
  });

  it('keeps the 127.0.0.1 endpoint working (the address-family branch must not bracket it)', async () => {
    const { api } = await startApi('127.0.0.1');
    const { port } = api.address();
    assert.equal((await probe('127.0.0.1', port, '/healthz')).status, 200);
    assert.equal((await probe('127.0.0.1', port, '/api/v1/status', BEARER)).status, 200);
    assert.equal((await probe('127.0.0.1', port, '/api/v1/alerts', BEARER)).status, 200);
  });
});
