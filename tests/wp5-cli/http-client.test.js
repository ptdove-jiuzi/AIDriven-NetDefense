/**
 * http-client.test.js — status mapping, deadlines, size caps and header hygiene.
 *
 * Every case runs against a loopback mock. Nothing here needs a daemon, a token file
 * or a database; what is under test is the client's behaviour when the thing on the
 * other end is missing, slow, lying about its body length, or answering with garbage.
 *
 * Two layers are exercised together on purpose: `get` owns the transport (deadline,
 * size cap, socket errors) and `readJson` owns acceptance (status, content type,
 * parse). A status-mapping case therefore goes through both, which is what a command
 * actually does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLI_CODES, CliError } from '../../apps/cli/src/errors.js';
import { createLoopbackClient, readJson } from '../../apps/cli/src/http-client.js';
import { isReadOnlyPath } from '../../apps/cli/src/routes.js';
import { TEST_TOKEN, findClosedPort, respondJson, respondRaw, startMock } from './helpers.js';

/**
 * Build a client pointed at a mock port.
 *
 * @param {number} port Mock port.
 * @param {{timeoutMs?: number, maxResponseBytes?: number}} [options] Options.
 * @returns {object} Client.
 */
function clientFor(port, options = {}) {
  return createLoopbackClient({
    endpoint: { host: '127.0.0.1', port },
    timeoutMs: options.timeoutMs ?? 4000,
    maxResponseBytes: options.maxResponseBytes ?? 65536,
  });
}

/**
 * Issue a request and decode it, the way a command does.
 *
 * @param {object} client Loopback client.
 * @param {string} path Request target.
 * @param {{token?: string|null, allow?: readonly number[]}} [options] Options.
 * @returns {Promise<{status: number, body: any}>} Decoded response.
 */
function requestJson(client, path, options = {}) {
  return client.get(path, { token: options.token })
    .then((response) => readJson(response, { allow: options.allow }));
}

/**
 * Assert that a promise rejects with a CLI error carrying a specific code.
 *
 * @param {Promise<unknown>} promise Request promise.
 * @param {string} code Expected code.
 * @returns {Promise<CliError>} The rejection.
 */
async function expectReject(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, `expected a CliError, got ${error?.name ?? typeof error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected the request to fail with ${code}`);
}

describe('loopback client: success path', () => {
  it('returns the decoded body for a 200 response', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, { lifecycle: 'running' }));
    try {
      const decoded = await requestJson(clientFor(mock.port), '/api/v1/status');
      assert.equal(decoded.status, 200);
      assert.equal(decoded.body.lifecycle, 'running');
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].method, 'GET');
    } finally {
      await mock.close();
    }
  });

  it('sends the bearer token only when one is provided', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, {}));
    try {
      const client = clientFor(mock.port);
      await client.get('/healthz');
      await client.get('/api/v1/status', { token: TEST_TOKEN });
      assert.equal(mock.requests[0].headers.authorization, undefined);
      assert.equal(mock.requests[1].headers.authorization, `Bearer ${TEST_TOKEN}`);
      assert.equal(mock.requests[1].method, 'GET');
    } finally {
      await mock.close();
    }
  });

  it('sends no cookies, no referer and no CSRF header', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, {}));
    try {
      await clientFor(mock.port).get('/api/v1/status', { token: TEST_TOKEN });
      const headers = mock.requests[0].headers;
      for (const forbidden of ['cookie', 'referer', 'origin', 'x-aegis-csrf', 'proxy-authorization']) {
        assert.equal(headers[forbidden], undefined, `${forbidden} must never be sent`);
      }
    } finally {
      await mock.close();
    }
  });
});

describe('loopback client: request shape', () => {
  it('refuses a path outside the read-only route table', async () => {
    const client = clientFor(1);
    await expectReject(client.get('/etc/passwd'), CLI_CODES.INTERNAL);
    await expectReject(client.get('api/v1/status'), CLI_CODES.INTERNAL);
  });

  it('refuses a path containing a traversal segment or whitespace', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, {}));
    try {
      const client = clientFor(mock.port);
      await expectReject(client.get('/api/v1/../secret'), CLI_CODES.INTERNAL);
      await expectReject(client.get('/api/v1/status\r\nX-Injected: 1'), CLI_CODES.INTERNAL);
      assert.equal(mock.requests.length, 0, 'nothing may reach the socket');
    } finally {
      await mock.close();
    }
  });

  it('refuses every state-changing route as a path, not just as a verb', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, {}));
    try {
      const client = clientFor(mock.port);
      for (const path of [
        '/api/v1/collectors/windows.security.4688/poll',
        '/api/v1/approvals/a1/approve',
        '/api/v1/analysis/job-1/execute',
        '/api/v1/rescue',
        '/api/v1/alerts/../../status',
      ]) {
        await expectReject(client.get(path), CLI_CODES.INTERNAL);
      }
      assert.equal(mock.requests.length, 0, 'the route set is closed, so nothing is sent');
    } finally {
      await mock.close();
    }
  });
});

describe('read-only route set', () => {
  it('admits the five read-only shapes and nothing else', () => {
    for (const path of [
      '/healthz',
      '/readyz',
      '/api/v1/status',
      '/api/v1/alerts?limit=1',
      // Contract §9: 100 is the ceiling and is reachable; the old route table admitted 200.
      '/api/v1/alerts?limit=100',
      '/api/v1/analysis?limit=50',
      '/api/v1/analysis?limit=100',
      '/api/v1/analysis/3f7c1a9e-6b2d-4c8f-9a01-2b3c4d5e6f70',
      '/api/v1/analysis/job.2026-11-02_1',
      '/api/v1/analysis/a:b',
    ]) {
      assert.equal(isReadOnlyPath(path), true, `${path} must be reachable`);
    }
    for (const path of [
      '/',
      '/api/v1',
      '/api/v1/alerts',
      '/api/v1/alerts?limit=0',
      '/api/v1/alerts?limit=101',
      '/api/v1/alerts?limit=200',
      '/api/v1/alerts?limit=999',
      '/api/v1/alerts?limit=1&offset=2',
      '/api/v1/analysis/..',
      '/api/v1/analysis/',
      '/api/v1/collectors/x/poll',
      '/api/v1/collectors/x/poll?limit=1',
      '/api/v1/status/../alerts?limit=1',
      '/healthz?probe=1',
      '//api/v1/status',
      '/api/v1/status#fragment',
    ]) {
      assert.equal(isReadOnlyPath(path), false, `${path} must be refused`);
    }
  });

  it('admits a colon inside an analysis id, because the id grammar allows it', async () => {
    // `encodeURIComponent('a:b')` is `a%3Ab`, and `%` is not in the route alphabet. The
    // identifier is validated and passed through unescaped for exactly this reason.
    const mock = await startMock((request, res) => respondJson(res, 200, { analysis_id: 'a:b' }));
    try {
      const client = clientFor(mock.port);
      const response = await client.get('/api/v1/analysis/a:b');
      assert.equal(response.status, 200);
      assert.equal(mock.requests[0].url, '/api/v1/analysis/a:b');
    } finally {
      await mock.close();
    }
  });
});

describe('loopback client: HTTP status mapping', () => {
  const cases = [
    // Contract §8: a closed query surface means a legal request can only draw
    // `QUERY_INVALID`/`CURSOR_INVALID` as a 400, and both are reported as a bad response.
    [400, CLI_CODES.BAD_RESPONSE, { error: { code: 'QUERY_INVALID', message: 'no' } }],
    [401, CLI_CODES.AUTH, { error: { code: 'AUTH_REQUIRED', message: 'authentication required' } }],
    [403, CLI_CODES.FORBIDDEN, { error: { code: 'HOST_REJECTED', message: 'no' } }],
    [404, CLI_CODES.ENDPOINT_UNAVAILABLE, { error: { code: 'NOT_FOUND', message: 'no' } }],
    [405, CLI_CODES.ENDPOINT_UNAVAILABLE, { error: { code: 'METHOD_NOT_ALLOWED', message: 'no' } }],
    [408, CLI_CODES.TIMEOUT, { error: { code: 'REQUEST_TIMEOUT', message: 'no' } }],
    [413, CLI_CODES.RESPONSE_TOO_LARGE, { error: { code: 'BODY_TOO_LARGE', message: 'no' } }],
    [415, CLI_CODES.BAD_RESPONSE, { error: { code: 'CONTENT_TYPE_REJECTED', message: 'no' } }],
    [421, CLI_CODES.FORBIDDEN, { error: { code: 'HOST_REJECTED', message: 'no' } }],
    [429, CLI_CODES.RATE_LIMITED, { error: { code: 'AUTH_RATE_LIMITED', message: 'no' } }],
    [500, CLI_CODES.DAEMON_ERROR, { error: { code: 'INTERNAL', message: 'no' } }],
    [503, CLI_CODES.DAEMON_ERROR, { error: { code: 'STORE_UNAVAILABLE', message: 'no' } }],
  ];

  for (const [status, code, body] of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const mock = await startMock((request, res) => respondJson(res, status, body));
      try {
        const error = await expectReject(requestJson(clientFor(mock.port), '/api/v1/status'), code);
        assert.equal(error.details.status, status);
      } finally {
        await mock.close();
      }
    });
  }

  it('names the store as the cause of a 503 rather than "no alerts"', async () => {
    const mock = await startMock((request, res) => respondJson(res, 503, {
      error: { code: 'STORE_UNAVAILABLE', message: 'store is not open' },
    }));
    try {
      const error = await expectReject(requestJson(clientFor(mock.port), '/api/v1/alerts?limit=5'), CLI_CODES.DAEMON_ERROR);
      assert.equal(error.details.daemon_code, 'STORE_UNAVAILABLE');
      assert.match(error.message, /storage being unavailable does not mean there are no alerts/u);
    } finally {
      await mock.close();
    }
  });

  it('reports a throttled request as rate limited', async () => {
    // Contract §2/§8: `AUTH_RATE_LIMITED` lives on 429, with `Retry-After`. The exit code
    // answers "slow down"; the message names failed authentication as the reason.
    const mock = await startMock((request, res) => respondJson(res, 429, {
      error: { code: 'AUTH_RATE_LIMITED', message: 'too many attempts' },
    }, { 'retry-after': '30' }));
    try {
      const error = await expectReject(
        requestJson(clientFor(mock.port), '/api/v1/status'),
        CLI_CODES.RATE_LIMITED,
      );
      assert.equal(error.details.daemon_code, 'AUTH_RATE_LIMITED');
      assert.equal(error.details.status, 429);
      assert.match(error.message, /throttled too many failed authentication attempts/u);
    } finally {
      await mock.close();
    }
  });

  it('keeps a 401 plain auth even when it carries the rate-limit code', async () => {
    // Contract §8 puts `AUTH_RATE_LIMITED` on 429. A daemon that sends it on 401 is
    // describing an authentication failure, and reporting "slow down" would send an
    // operator to wait for a token that will never work.
    const mock = await startMock((request, res) => respondJson(res, 401, {
      error: { code: 'AUTH_RATE_LIMITED', message: 'too many attempts' },
    }));
    try {
      const error = await expectReject(
        requestJson(clientFor(mock.port), '/api/v1/status'),
        CLI_CODES.AUTH,
      );
      assert.equal(error.details.status, 401);
      assert.equal(error.details.daemon_code, 'AUTH_RATE_LIMITED');
    } finally {
      await mock.close();
    }
  });

  it('refuses to follow a redirect', async () => {
    const mock = await startMock((request, res) => {
      res.writeHead(302, { location: 'http://192.0.2.10:9/steal' });
      res.end();
    });
    try {
      await expectReject(requestJson(clientFor(mock.port), '/api/v1/status'), CLI_CODES.BAD_RESPONSE);
      assert.equal(mock.requests.length, 1, 'a redirect must not produce a second request');
    } finally {
      await mock.close();
    }
  });
});

describe('loopback client: body handling', () => {
  it('rejects malformed JSON', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, '{"lifecycle": '));
    try {
      await expectReject(requestJson(clientFor(mock.port), '/api/v1/status'), CLI_CODES.BAD_RESPONSE);
    } finally {
      await mock.close();
    }
  });

  it('rejects an empty body', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, ''));
    try {
      await expectReject(requestJson(clientFor(mock.port), '/api/v1/status'), CLI_CODES.BAD_RESPONSE);
    } finally {
      await mock.close();
    }
  });

  it('rejects a non-JSON content type instead of guessing', async () => {
    const mock = await startMock((request, res) => respondRaw(res, 200, Buffer.from('<html>nope</html>'), {
      'content-type': 'text/html; charset=utf-8',
    }));
    try {
      await expectReject(requestJson(clientFor(mock.port), '/api/v1/status'), CLI_CODES.BAD_RESPONSE);
    } finally {
      await mock.close();
    }
  });

  it('tolerates 503 only when the caller asks for it', async () => {
    const mock = await startMock((request, res) => respondJson(res, 503, { ready: false }));
    try {
      const client = clientFor(mock.port);
      await expectReject(requestJson(client, '/readyz'), CLI_CODES.DAEMON_ERROR);
      const decoded = await requestJson(client, '/readyz', { allow: [503] });
      assert.equal(decoded.status, 503);
      assert.equal(decoded.body.ready, false);
    } finally {
      await mock.close();
    }
  });

  it('rejects a body whose declared length exceeds the cap', async () => {
    const payload = Buffer.from(JSON.stringify({ pad: 'x'.repeat(4096) }));
    const mock = await startMock((request, res) => respondRaw(res, 200, payload));
    try {
      const error = await expectReject(
        requestJson(clientFor(mock.port, { maxResponseBytes: 1024 }), '/api/v1/status'),
        CLI_CODES.RESPONSE_TOO_LARGE,
      );
      assert.equal(error.details.limit_bytes, 1024);
    } finally {
      await mock.close();
    }
  });

  it('abandons a chunked body that grows past the cap', async () => {
    const mock = await startMock((request, res) => {
      // No content-length: the only defence left is counting bytes as they arrive.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      const chunk = 'x'.repeat(512);
      for (let index = 0; index < 8; index += 1) {
        res.write(chunk);
      }
      res.end();
    });
    try {
      const error = await expectReject(
        requestJson(clientFor(mock.port, { maxResponseBytes: 1024 }), '/api/v1/status'),
        CLI_CODES.RESPONSE_TOO_LARGE,
      );
      assert.equal(error.details.limit_bytes, 1024);
    } finally {
      await mock.close();
    }
  });

  it('decodes invalid UTF-8 into replacement characters instead of throwing', async () => {
    const body = Buffer.concat([
      Buffer.from('{"lifecycle":"running","version":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}'),
    ]);
    const mock = await startMock((request, res) => respondRaw(res, 200, body));
    try {
      const decoded = await requestJson(clientFor(mock.port), '/api/v1/status');
      assert.equal(decoded.body.lifecycle, 'running');
      assert.equal(decoded.body.version.includes('\uFFFD'), true);
    } finally {
      await mock.close();
    }
  });
});

describe('loopback client: transport failure', () => {
  it('reports a closed port as unreachable', async () => {
    const port = await findClosedPort();
    await expectReject(clientFor(port).get('/healthz'), CLI_CODES.UNREACHABLE);
  });

  it('reports a mid-response reset as unreachable', async () => {
    const mock = await startMock((request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"lifecycle":');
      res.destroy();
    });
    try {
      await expectReject(requestJson(clientFor(mock.port), '/api/v1/status'), CLI_CODES.UNREACHABLE);
    } finally {
      await mock.close();
    }
  });

  it('times out when the daemon accepts the connection and never answers', async () => {
    /** @type {import('node:http').ServerResponse|null} */
    let held = null;
    const mock = await startMock((request, res) => {
      held = res;
    });
    try {
      const started = Date.now();
      const error = await expectReject(
        clientFor(mock.port, { timeoutMs: 150 }).get('/api/v1/status'),
        CLI_CODES.TIMEOUT,
      );
      assert.equal(error.details.timeout_ms, 150);
      assert.ok(Date.now() - started < 3000, 'the deadline must actually cut the request short');
    } finally {
      held?.destroy();
      await mock.close();
    }
  });
});

describe('loopback client: secret hygiene', () => {
  it('never puts the token or a header value into an error', async () => {
    const mock = await startMock((request, res) => respondJson(res, 500, {
      error: { code: 'INTERNAL', message: `failed for ${request.headers.authorization}` },
    }));
    try {
      let caught = null;
      try {
        await requestJson(clientFor(mock.port), '/api/v1/status', { token: TEST_TOKEN });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof CliError);
      const rendered = `${caught.message} ${JSON.stringify(caught.details)}`;
      assert.equal(rendered.includes(TEST_TOKEN), false, 'the token must never appear in an error');
      for (const key of Object.keys(caught.details)) {
        assert.ok(
          ['status', 'daemon_code', 'limit_bytes', 'received_bytes', 'timeout_ms', 'command', 'field', 'reason']
            .includes(key),
          `unexpected detail key ${key}`,
        );
      }
    } finally {
      await mock.close();
    }
  });

  it('drops a token even if a caller passes one as a detail', () => {
    const error = new CliError(CLI_CODES.AUTH, 'nope', {
      token: TEST_TOKEN,
      authorization: TEST_TOKEN,
      status: 401,
    });
    assert.deepEqual(error.details, { status: 401 });
    assert.equal(JSON.stringify(error).includes(TEST_TOKEN), false);
  });
});
