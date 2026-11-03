/**
 * api-endpoints.test.js — the live control API over a real loopback socket.
 *
 * A real socket is used on purpose: most of what is being verified here (Host
 * admission, header limits, body caps, timeouts, connection reuse) does not exist
 * at the handler level and cannot be faked by calling `dispatch` directly.
 *
 * Every server binds `127.0.0.1` on an ephemeral port and is closed in a test hook.
 */

import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { connect as netConnect } from 'node:net';

import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { createAuthGuard } from '../../apps/daemon/src/api/auth.js';
import { createControlApi, isLoopbackPeer } from '../../apps/daemon/src/api/server.js';
import { BASE_MS, TEST_TOKEN, createManualClock, httpRequest } from './helpers.js';

const servers = new Set();

after(async () => {
  for (const api of servers) {
    await api.close();
  }
  servers.clear();
});

/**
 * Start a control API with stub handlers.
 *
 * @param {object} [options] Overrides.
 * @returns {Promise<object>} Harness.
 */
async function startApi(options = {}) {
  const clock = options.clock ?? createManualClock(BASE_MS);
  const auth = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 60_000 });
  const calls = { status: 0, health: 0, ready: 0, poll: [] };
  const handlers = {
    health: () => {
      calls.health += 1;
      return { status: 'ok', version: 'test-1' };
    },
    ready: () => {
      calls.ready += 1;
      return { ready: true, body: { ready: true, lifecycle: 'running', reasons: [] } };
    },
    status: () => {
      calls.status += 1;
      return { lifecycle: 'running', counters: { events_accepted: 3 } };
    },
    pollSource: async (sourceId) => {
      calls.poll.push(sourceId);
      return { id: sourceId, lifecycle: 'ok', events: 1 };
    },
    ...(options.handlers ?? {}),
  };
  const api = createControlApi({
    config: {
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: options.requestTimeoutMs ?? 2000,
      headersTimeoutMs: 2000,
      keepAliveTimeoutMs: 1000,
      maxBodyBytes: options.maxBodyBytes ?? 1024,
    },
    auth,
    handlers,
    logger: options.logger,
  });
  const address = await api.start();
  servers.add(api);
  return { api, address, auth, calls, clock };
}

/** POST helper that always sends the CSRF header and a JSON content type. */
function postHeaders(extra = {}) {
  return {
    authorization: `Bearer ${TEST_TOKEN}`,
    'x-aegis-csrf': 'placeholder',
    'content-type': 'application/json',
    ...extra,
  };
}

describe('control API admission', () => {
  it('binds the loopback address on an ephemeral port', async () => {
    const { api, address } = await startApi();
    assert.equal(address.host, '127.0.0.1');
    assert.ok(address.port > 0);
    assert.deepEqual(api.address(), { host: '127.0.0.1', port: address.port });
  });

  it('reports readiness without authentication but exposes nothing else', async () => {
    const { address, calls } = await startApi();
    const response = await httpRequest(address.port, '/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ok', version: 'test-1' });
    assert.equal(calls.health, 1);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
  });

  it('answers /readyz with 503 when the daemon is not ready', async () => {
    const { address } = await startApi({
      handlers: { ready: () => ({ ready: false, body: { ready: false, reasons: ['store:unavailable'] } }) },
    });
    const response = await httpRequest(address.port, '/readyz');
    assert.equal(response.status, 503);
    assert.equal(response.body.ready, false);
    assert.deepEqual(response.body.reasons, ['store:unavailable']);
  });

  it('rejects /healthz with a method other than GET', async () => {
    const { address } = await startApi();
    const response = await httpRequest(address.port, '/healthz', { method: 'POST' });
    assert.equal(response.status, 405);
  });

  it('requires a bearer token for /api/v1/status', async () => {
    const { address } = await startApi();
    const response = await httpRequest(address.port, '/api/v1/status');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, DAEMON_CODES.AUTH_REQUIRED);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer/u);
    assert.equal(response.text.includes(TEST_TOKEN), false);
  });

  it('accepts the bearer token and exposes a CSRF token, never the bearer', async () => {
    const { address, auth } = await startApi();
    const response = await httpRequest(address.port, '/api/v1/status', {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.csrf_token, auth.csrfToken);
    assert.notEqual(response.body.csrf_token, TEST_TOKEN);
    assert.equal(response.text.includes(TEST_TOKEN), false);
  });

  it('rejects a request whose Host header is not the loopback endpoint', async () => {
    const { address } = await startApi();
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/healthz',
        method: 'GET',
        headers: { host: 'evil.example' },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 421);
  });

  it('rejects a cross-origin state-changing request even with a valid token', async () => {
    const { address, auth } = await startApi();
    const response = await httpRequest(address.port, '/api/v1/collectors/x/poll', {
      method: 'POST',
      headers: postHeaders({
        'x-aegis-csrf': auth.csrfToken,
        origin: 'http://evil.example',
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, DAEMON_CODES.ORIGIN_REJECTED);
  });

  it('requires the CSRF header for a state-changing request', async () => {
    const { address, calls } = await startApi();
    const response = await httpRequest(address.port, '/api/v1/collectors/x/poll', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, DAEMON_CODES.CSRF_REQUIRED);
    assert.deepEqual(calls.poll, []);
  });

  it('accepts a same-origin state-changing request with the CSRF header', async () => {
    const { address, auth, calls } = await startApi();
    const response = await httpRequest(address.port, '/api/v1/collectors/synthetic.process/poll', {
      method: 'POST',
      headers: postHeaders({
        'x-aegis-csrf': auth.csrfToken,
        origin: `http://127.0.0.1:${address.port}`,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.source.id, 'synthetic.process');
    assert.deepEqual(calls.poll, ['synthetic.process']);
  });

  it('serves a valid token with 200 after five wrong ones from the same loopback peer', async () => {
    // Every local process shares 127.0.0.1, so the failure bucket is unavoidably
    // shared with anything else running on the machine (D-1). Five wrong tokens must
    // therefore not take the operator's own client down with them.
    const { address } = await startApi();
    const wrongStatuses = [];
    for (let index = 0; index < 5; index += 1) {
      const failed = await httpRequest(address.port, '/api/v1/status', {
        headers: { authorization: `Bearer ${'z'.repeat(40)}` },
      });
      wrongStatuses.push(failed.status);
    }
    // The harness allows three failures; the 4th and 5th guess are already throttled.
    assert.deepEqual(wrongStatuses, [401, 401, 401, 429, 429]);
    const allowed = await httpRequest(address.port, '/api/v1/status', {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(allowed.status, 200, '错误 token 不得连带拒绝持有合法 token 的客户端');
    assert.equal(allowed.body.lifecycle, 'running');
  });

  it('keeps rate-limiting a peer that rotates the wrong token', async () => {
    // One quota per peer, not per presented token: eight *different* wrong tokens must
    // not buy eight fresh quotas. A per-token bucket would never emit a 429 here.
    const { address } = await startApi();
    const statuses = [];
    for (let index = 0; index < 8; index += 1) {
      const response = await httpRequest(address.port, '/api/v1/status', {
        headers: { authorization: `Bearer ${String(index).padStart(2, '0')}${'z'.repeat(38)}` },
      });
      statuses.push(response.status);
      if (index >= 3) {
        assert.equal(response.body.error.code, DAEMON_CODES.AUTH_RATE_LIMITED, `第 ${index + 1} 次轮换 token 必须 429`);
        assert.equal(response.headers.get('retry-after'), '60');
      }
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429, 429, 429, 429]);
  });
});

describe('control API routing', () => {
  it('returns a JSON 404 with no endpoint for an unknown path', async () => {
    const { address } = await startApi();
    const authed = await httpRequest(address.port, '/nope', { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    assert.equal(authed.status, 404);
    assert.equal(authed.body.error.code, DAEMON_CODES.NOT_FOUND);
    const anonymous = await httpRequest(address.port, '/api/v1/nope');
    assert.equal(anonymous.status, 401, 'authentication is checked before routing');
  });

  it('returns 405 with no body echo for a wrong method on a known path', async () => {
    const { address, auth } = await startApi();
    const readPoll = await httpRequest(address.port, '/api/v1/collectors/x/poll', {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(readPoll.status, 405);
    const postStatus = await httpRequest(address.port, '/api/v1/status', {
      method: 'POST',
      headers: postHeaders({ 'x-aegis-csrf': auth.csrfToken }),
    });
    assert.equal(postStatus.status, 405);
  });

  it('maps a daemon error from a handler onto its status code', async () => {
    const { address, auth } = await startApi({
      handlers: {
        pollSource: async () => {
          const { DaemonError } = await import('../../apps/daemon/src/errors.js');
          throw new DaemonError(DAEMON_CODES.SOURCE_UNKNOWN, 'unknown collector source', { source_id: 'ghost' });
        },
      },
    });
    const response = await httpRequest(address.port, '/api/v1/collectors/ghost/poll', {
      method: 'POST',
      headers: postHeaders({ 'x-aegis-csrf': auth.csrfToken }),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, DAEMON_CODES.SOURCE_UNKNOWN);
  });

  it('turns an unexpected handler throw into a 500 without leaking internals', async () => {
    const { address } = await startApi({
      handlers: {
        status: () => {
          throw new Error('secret internal detail at C:/Users/someone/app.js');
        },
      },
    });
    const response = await httpRequest(address.port, '/api/v1/status', {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, DAEMON_CODES.INTERNAL);
    assert.equal(response.body.error.message, 'internal error');
    assert.equal(response.text.includes('C:/Users'), false);
    assert.equal(response.text.includes('stack'), false);
  });
});

describe('control API request limits', () => {
  it('rejects a declared body larger than the configured cap', async () => {
    const { address, auth } = await startApi({ maxBodyBytes: 64 });
    const response = await httpRequest(address.port, '/api/v1/collectors/x/poll', {
      method: 'POST',
      headers: postHeaders({ 'x-aegis-csrf': auth.csrfToken }),
      body: JSON.stringify({ padding: 'x'.repeat(500) }),
    });
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, DAEMON_CODES.BODY_TOO_LARGE);
  });

  it('rejects a chunked body that grows past the cap', async () => {
    const { address, auth } = await startApi({ maxBodyBytes: 64 });
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/api/v1/collectors/x/poll',
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'x-aegis-csrf': auth.csrfToken,
          'content-type': 'application/json',
        },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.write('{"padding":"');
      request.write('y'.repeat(200));
      request.end('"}');
    });
    assert.equal(status, 413);
  });

  it('rejects a body that is not declared as JSON', async () => {
    const { address, auth } = await startApi();
    const response = await httpRequest(address.port, '/api/v1/collectors/x/poll', {
      method: 'POST',
      headers: postHeaders({ 'x-aegis-csrf': auth.csrfToken, 'content-type': 'text/plain' }),
      body: 'hello',
    });
    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, DAEMON_CODES.CONTENT_TYPE_REJECTED);
  });

  it('answers 408 when a handler outstays its deadline', async () => {
    const { address, auth } = await startApi({
      requestTimeoutMs: 60,
      handlers: { pollSource: () => new Promise(() => {}) },
    });
    const response = await httpRequest(address.port, '/api/v1/collectors/slow/poll', {
      method: 'POST',
      headers: postHeaders({ 'x-aegis-csrf': auth.csrfToken }),
    });
    assert.equal(response.status, 408);
    assert.equal(response.body.error.code, DAEMON_CODES.REQUEST_TIMEOUT);
  });

  it('answers 400 to a malformed request line', async () => {
    const { address } = await startApi();
    const status = await new Promise((resolve, reject) => {
      const socket = netConnect({ host: '127.0.0.1', port: address.port }, () => {
        socket.write('GARBAGE / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      socket.on('end', () => resolve(data));
      socket.on('error', () => resolve(data));
      setTimeout(() => {
        socket.destroy();
        resolve(data);
      }, 500);
      socket.on('close', () => {
        if (data.length === 0) {
          reject(new Error('no response to a malformed request'));
        }
      });
    });
    assert.match(String(status), /400/u);
  });
});

describe('control API lifecycle', () => {
  it('refuses to start twice and closes idempotently', async () => {
    const { api } = await startApi();
    await assert.rejects(() => api.start(), (error) => {
      assert.equal(error.code, DAEMON_CODES.LIFECYCLE_ALREADY_STARTED);
      return true;
    });
    await api.close();
    await api.close();
    servers.delete(api);
  });

  it('counts requests and rejections for diagnostics', async () => {
    const { api, address } = await startApi();
    await httpRequest(address.port, '/healthz');
    await httpRequest(address.port, '/api/v1/status');
    const stats = api.stats();
    assert.equal(stats.requests, 2);
    assert.equal(stats.rejected, 1);
    assert.equal(stats.by_path['/healthz'], 1);
  });
});

describe('isLoopbackPeer', () => {
  it('accepts IPv4, IPv6 and dual-stack loopback peers only', () => {
    assert.equal(isLoopbackPeer('127.0.0.1'), true);
    assert.equal(isLoopbackPeer('::1'), true);
    assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackPeer('192.168.1.5'), false);
    assert.equal(isLoopbackPeer('127.0.0.2'), false);
    assert.equal(isLoopbackPeer(undefined), false);
  });
});
