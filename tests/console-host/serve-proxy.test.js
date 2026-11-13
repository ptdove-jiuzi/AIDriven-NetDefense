/**
 * `apps/console-next/serve.mjs` proxy surface (author PT-dove).
 *
 * Drives a real fake daemon on `127.0.0.1:0` and asserts what the daemon
 * *received* as well as what the browser got back. The adversarial cases are the
 * point: a browser page on another origin must not be able to forge the write
 * gate, inject its own credential/CSRF header, or smuggle an Origin through, and
 * a failed upstream must not leak host paths or internals.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';

import {
  TEST_TOKEN,
  closedPort,
  jsonDaemon,
  portOf,
  rawRequest,
  startConsole,
  startFakeDaemon,
} from './helpers.mjs';

/** The value the daemon derives; recomputed here rather than imported. */
const EXPECTED_CSRF = createHash('sha256').update(`aegis-csrf:${TEST_TOKEN}`, 'utf8').digest('base64url');

const opened = [];
after(async () => {
  for (const entry of opened) {
    await entry.close().catch(() => {});
  }
});

/** Start a fake daemon + console host pair, run the body, then tear both down. */
async function withHost(run, options = {}) {
  const daemon = await startFakeDaemon(options.handler ?? jsonDaemon(() => ({ body: { ok: true } })));
  const host = await startConsole(['--daemon', daemon.url, '--token', TEST_TOKEN]);
  const pair = {
    daemon,
    host,
    port: portOf(host.url),
    close: async () => { await host.close(); await daemon.close(); },
  };
  opened.push(pair);
  try {
    await run(pair);
  } finally {
    await pair.close();
  }
}

function write(port, path, { method = 'POST', body, headers = {} } = {}) {
  return rawRequest({
    port,
    path,
    method,
    headers: {
      'x-console-v2': '1',
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('console host: credential injection', () => {
  it('injects the bearer token and a daemon-shaped Host, and answers from the daemon', async () => {
    await withHost(async ({ daemon, port }) => {
      const response = await rawRequest({ port, path: '/healthz' });
      assert.equal(response.status, 200);
      assert.equal(daemon.requests.length, 1);
      const seen = daemon.requests[0];
      assert.equal(seen.headers.authorization, `Bearer ${TEST_TOKEN}`);
      assert.equal(seen.headers.host, `127.0.0.1:${daemon.port}`);
      assert.equal(seen.method, 'GET');
      assert.deepEqual(JSON.parse(response.text), { ok: true });
      // The token belongs to the host, not to the wire toward the browser.
      assert.equal(response.text.includes(TEST_TOKEN), false);
      for (const [name, value] of Object.entries(response.headers)) {
        assert.equal(String(value).includes(TEST_TOKEN), false, `header ${name} leaked the token`);
      }
    });
  });

  it('replaces a browser-supplied Authorization header instead of forwarding it', async () => {
    await withHost(async ({ daemon, port }) => {
      await rawRequest({
        port,
        path: '/api/v1/models',
        headers: { authorization: 'Bearer attacker-supplied-value' },
      });
      assert.equal(daemon.requests[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
    });
  });

  it('does not add the CSRF header to reads and adds it to writes', async () => {
    await withHost(async ({ daemon, port }) => {
      await rawRequest({ port, path: '/api/v1/models' });
      assert.equal(daemon.requests[0].headers['x-aegis-csrf'], undefined);
      await write(port, '/api/v1/agent/approval', { body: { decision: 'deny' } });
      assert.equal(daemon.requests[1].headers['x-aegis-csrf'], EXPECTED_CSRF);
      assert.notEqual(daemon.requests[1].headers['x-aegis-csrf'], TEST_TOKEN);
    });
  });
});

describe('console host: write gate', () => {
  it('requires x-console-v2: 1 on POST/PUT/DELETE and never forwards it', async () => {
    await withHost(async ({ daemon, port }) => {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const refused = await rawRequest({
          port,
          path: '/api/v1/settings',
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'DELETE' ? undefined : '{}',
        });
        assert.equal(refused.status, 403, `${method} without the console header must be 403`);
        assert.equal(JSON.parse(refused.text).error.code, 'CONSOLE_HEADER_REQUIRED');
      }
      assert.equal(daemon.requests.length, 0, 'a gated write must never reach the daemon');

      const allowed = await write(port, '/api/v1/settings', { method: 'PUT', body: { settings: {} } });
      assert.equal(allowed.status, 200);
      assert.equal(daemon.requests[0].headers['x-console-v2'], undefined,
        'the console marker is validated here and must not be forwarded');
    });
  });

  it('does not require the console header on reads', async () => {
    await withHost(async ({ daemon, port }) => {
      const response = await rawRequest({ port, path: '/api/v1/alerts?limit=5' });
      assert.equal(response.status, 200);
      assert.equal(daemon.requests.length, 1);
    });
  });

  it('requires the marker value to be exactly "1"', async () => {
    await withHost(async ({ port }) => {
      const response = await rawRequest({
        port,
        path: '/api/v1/settings',
        method: 'POST',
        headers: { 'x-console-v2': 'true', 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403);
    });
  });
});

describe('console host: browser headers are not forwarded', () => {
  it('strips origin, referer and cookie from a write', async () => {
    await withHost(async ({ daemon, port }) => {
      const response = await write(port, '/api/v1/agent/approval', {
        body: { sessionId: 's_x', callId: 'c_1', decision: 'approve' },
        headers: {
          origin: 'http://evil.example',
          referer: 'http://evil.example/page',
          cookie: 'session=abc',
        },
      });
      assert.equal(response.status, 200);
      const seen = daemon.requests[0];
      assert.equal(seen.headers.origin, undefined, 'Origin must not reach the daemon');
      assert.equal(seen.headers.referer, undefined, 'Referer must not reach the daemon');
      assert.equal(seen.headers.cookie, undefined, 'Cookie must not reach the daemon');
    });
  });

  it('strips them from a read too, and forwards the query string verbatim', async () => {
    await withHost(async ({ daemon, port }) => {
      const query = '/api/v1/alerts?limit=5&cursor=abc%3D%3D&sort=last_seen%3Adesc';
      await rawRequest({
        port,
        path: query,
        headers: { origin: 'http://evil.example', cookie: 'a=b', referer: 'http://evil.example' },
      });
      const seen = daemon.requests[0];
      assert.equal(seen.url, query, 'the upstream URL must be forwarded with its query');
      assert.equal(seen.headers.origin, undefined);
      assert.equal(seen.headers.cookie, undefined);
      assert.equal(seen.headers.referer, undefined);
    });
  });
});

describe('console host: method and body passthrough', () => {
  it('forwards PUT and DELETE with their bodies', async () => {
    await withHost(async ({ daemon, port }) => {
      const putBody = { apiKey: '  test-key-for-put  ' };
      const put = await write(port, '/api/v1/credentials/deepseek', { method: 'PUT', body: putBody });
      assert.equal(put.status, 200);
      assert.equal(daemon.requests[0].method, 'PUT');
      assert.equal(daemon.requests[0].url, '/api/v1/credentials/deepseek');
      assert.deepEqual(JSON.parse(daemon.requests[0].body), putBody);

      const del = await write(port, '/api/v1/credentials/deepseek', { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.equal(daemon.requests[1].method, 'DELETE');
      assert.equal(daemon.requests[1].body, '');
    });
  });

  it('passes the upstream status, headers and body through unchanged', async () => {
    const handler = (req, res) => {
      const body = JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'token missing' } });
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-daemon-note': 'hello',
      });
      res.end(body);
    };
    await withHost(async ({ port }) => {
      const response = await rawRequest({ port, path: '/api/v1/models' });
      assert.equal(response.status, 401);
      assert.equal(response.headers['x-daemon-note'], 'hello');
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.deepEqual(JSON.parse(response.text), { error: { code: 'AUTH_REQUIRED', message: 'token missing' } });
    }, { handler });
  });

  it('passes a 204 with no body through', async () => {
    const handler = (req, res) => {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    };
    await withHost(async ({ port }) => {
      const response = await write(port, '/api/v1/credentials/deepseek', { method: 'DELETE' });
      assert.equal(response.status, 204);
      assert.equal(response.text, '');
    }, { handler });
  });

  it('answers 405 for methods the console proxy does not forward, with no CORS headers', async () => {
    await withHost(async ({ daemon, port }) => {
      for (const method of ['PATCH', 'OPTIONS']) {
        const response = await rawRequest({ port, path: '/api/v1/models', method });
        assert.equal(response.status, 405, method);
        assert.deepEqual(JSON.parse(response.text).error.code, 'METHOD_NOT_ALLOWED');
        assert.equal(response.headers.allow, 'GET, POST, PUT, DELETE');
        assert.equal(response.headers['access-control-allow-origin'], undefined);
        assert.equal(response.headers['access-control-allow-methods'], undefined);
      }
      assert.equal(daemon.requests.length, 0);
    });
  });
});

describe('console host: failure modes', () => {
  it('answers 502 DAEMON_UNREACHABLE without leaking internals', async () => {
    const port = await closedPort();
    const host = await startConsole(['--daemon', `http://127.0.0.1:${port}`, '--token', TEST_TOKEN]);
    const pair = { host, close: async () => host.close() };
    opened.push(pair);
    try {
      const response = await rawRequest({ port: portOf(host.url), path: '/healthz' });
      assert.equal(response.status, 502);
      const body = JSON.parse(response.text);
      assert.equal(body.error.code, 'DAEMON_UNREACHABLE');
      for (const forbidden of ['ECONNREFUSED', 'Error:', 'D:\\', 'apps', 'node_modules', 'serve.mjs']) {
        assert.equal(response.text.includes(forbidden), false, `leaked ${forbidden}`);
      }
    } finally {
      await pair.close();
    }
  });

  it('rejects a declared body above 1 MiB with 413 before contacting the daemon', async () => {
    await withHost(async ({ daemon, port }) => {
      const response = await rawRequest({
        port,
        path: '/api/v1/agent/approval',
        method: 'POST',
        headers: { 'x-console-v2': '1', 'content-type': 'application/json' },
        body: Buffer.alloc((1024 * 1024) + 1, 0x61),
      });
      assert.equal(response.status, 413);
      assert.equal(JSON.parse(response.text).error.code, 'BODY_TOO_LARGE');
      assert.equal(daemon.requests.length, 0);
    });
  });

  it('rejects a chunked body that crosses 1 MiB while streaming', async () => {
    // The daemon in this test only replies after it has read the whole body, so a
    // 200 could only mean the host forwarded an over-cap stream.
    const slowHandler = (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    };
    await withHost(async ({ daemon, port }) => {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const response = await rawRequest({
        port,
        path: '/api/v1/agent/approval',
        method: 'POST',
        headers: {
          'x-console-v2': '1',
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
        body: Buffer.concat(Array.from({ length: 17 }, () => chunk)),
      });
      assert.equal(response.status, 413, `expected 413, got ${response.status}: ${response.text}`);
      assert.equal(JSON.parse(response.text).error.code, 'BODY_TOO_LARGE');
      assert.equal(daemon.requests.length, 1);
      // The socket teardown is observed by the daemon asynchronously.
      const deadline = Date.now() + 2000;
      while (!daemon.requests[0].premature && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      assert.equal(daemon.requests[0].premature, true, 'the over-cap upstream request must be cut off');
    }, { handler: slowHandler });
  });

  it('answers 504 DAEMON_TIMEOUT after the 10s ordinary-request budget', async () => {
    const handler = () => { /* never reply */ };
    await withHost(async ({ port }) => {
      const startedAt = Date.now();
      const response = await rawRequest({ port, path: '/api/v1/models', timeoutMs: 20_000 });
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 504);
      assert.equal(JSON.parse(response.text).error.code, 'DAEMON_TIMEOUT');
      assert.ok(elapsed >= 9_000, `timed out after ${elapsed}ms, expected the 10s budget`);
      assert.ok(elapsed < 15_000, `timed out after ${elapsed}ms, later than the 10s budget`);
    }, { handler });
  });
});
