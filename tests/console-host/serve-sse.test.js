/**
 * `apps/console-next/serve.mjs` streaming surface (author PT-dove).
 *
 * Contract §2.5/§2.6/§3.4/§3.5: the two SSE routes are proxied byte-for-byte —
 * no `content-length`, no buffering (`flushHeaders`), no proxy-side 5s timeout —
 * and a browser that goes away must tear the upstream request down so the daemon
 * can cancel the model turn and release its quota.
 *
 * The fake daemon here is deliberately slow (5.5s between frames) in one test:
 * the console host's ordinary 10s budget must not leak into the streaming path,
 * and the old packaging shell's 5s timeout would cut that stream in half.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  TEST_TOKEN,
  jsonDaemon,
  portOf,
  rawRequest,
  startConsole,
  startFakeDaemon,
} from './helpers.mjs';

const opened = [];
after(async () => {
  for (const entry of opened) await entry.close().catch(() => {});
});

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function withHost(handler, run) {
  const daemon = await startFakeDaemon(handler);
  const host = await startConsole(['--daemon', daemon.url, '--token', TEST_TOKEN]);
  const pair = {
    daemon,
    host,
    url: host.url,
    async close() { await host.close(); await daemon.close(); },
  };
  opened.push(pair);
  try {
    await run(pair);
  } finally {
    await pair.close();
  }
}

/** A daemon that opens an SSE stream, writes one frame, and stays open. */
function streamingDaemon(frame, { keepOpen = true } = {}) {
  return (req, res) => {
    // Health must not stream: the "host survived the abort" probe goes through it.
    if (!req.url.startsWith('/api/v1/')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    res.write(frame);
    if (!keepOpen) res.end();
  };
}

function chatBody() {
  return JSON.stringify({
    sessionId: `s_${'a'.repeat(32)}`,
    modelId: 'deepseek-chat',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: 'explain the alert' }],
  });
}

function ssePost(url, path, body, signal) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'x-console-v2': '1', 'content-type': 'application/json' },
    body,
    signal,
  });
}

describe('console host: SSE streaming', () => {
  it('streams the first frame in under a second with no content-length', async () => {
    const frame = 'event: delta\ndata: {"seq":1,"text":"hello"}\n\n';
    await withHost(streamingDaemon(frame), async ({ daemon, url }) => {
      const controller = new AbortController();
      const startedAt = performance.now();
      const response = await ssePost(url, 'api/v1/agent/chat', chatBody(), controller.signal);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), null,
        'a streamed response must not announce a length');
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store');

      const reader = response.body.getReader();
      const first = await reader.read();
      const firstFrameMs = performance.now() - startedAt;
      const text = new TextDecoder().decode(first.value);
      assert.match(text, /event: delta/u);
      assert.match(text, /"seq":1/u);
      assert.ok(firstFrameMs < 1000, `first frame took ${firstFrameMs.toFixed(0)}ms`);

      // The daemon saw the write marker and a CSRF proof, but not the marker itself.
      const seen = daemon.requests[0];
      assert.equal(seen.method, 'POST');
      assert.equal(seen.headers['x-console-v2'], undefined);
      assert.match(seen.headers['x-aegis-csrf'] ?? '', /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(seen.headers['accept-encoding'], 'identity');
      assert.equal(seen.headers.authorization, `Bearer ${TEST_TOKEN}`);

      // Cleanly abandon the stream: this is the contract §3.4 observable.
      controller.abort();
      await reader.cancel().catch(() => {});
    });
  });

  it('destroys the upstream request when the browser disconnects', async () => {
    const frame = 'event: delta\ndata: {"seq":1,"text":"first"}\n\n';
    await withHost(streamingDaemon(frame), async ({ daemon, url }) => {
      const controller = new AbortController();
      const response = await ssePost(url, 'api/v1/agent/chat', chatBody(), controller.signal);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /first/u);
      assert.equal(daemon.requests[0].premature, false, 'the upstream stream must still be open');

      controller.abort();
      await reader.cancel().catch(() => {});
      await waitFor(() => daemon.requests[0].premature, 3000,
        'the daemon to see its socket closed after the browser aborted');

      // The console host must survive the abort and keep serving.
      const health = await rawRequest({ port: portOf(url), path: '/healthz' });
      assert.equal(health.status, 200);
    });
  });

  it('streams the alert explain route with the upstream headers passed through', async () => {
    const frame = 'event: delta\ndata: {"seq":1,"text":"because"}\n\n';
    await withHost(streamingDaemon(frame, { keepOpen: false }), async ({ daemon, url }) => {
      const response = await ssePost(url, 'api/v1/alerts/alert-1/explain',
        JSON.stringify({ locale: 'zh-CN' }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      assert.equal(response.headers.get('content-length'), null);
      assert.match(await response.text(), /because/u);
      assert.equal(daemon.requests[0].url, '/api/v1/alerts/alert-1/explain');
      assert.equal(daemon.requests[0].method, 'POST');
    });
  });

  it('applies no 5s proxy timeout: a 5.5s-quiet stream still delivers both frames', async () => {
    const handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.flushHeaders();
      res.write('event: delta\ndata: {"seq":1,"text":"first"}\n\n');
      setTimeout(() => {
        res.write('event: done\ndata: {"seq":2,"finishReason":"stop"}\n\n');
        res.end();
      }, 5500);
    };
    await withHost(handler, async ({ url }) => {
      const startedAt = Date.now();
      const response = await ssePost(url, 'api/v1/agent/chat', chatBody());
      const body = await response.text();
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 200);
      assert.match(body, /"seq":1/u);
      assert.match(body, /event: done/u, `the second frame never arrived: ${body}`);
      assert.ok(elapsed >= 5000, `stream finished in ${elapsed}ms, so it was cut short`);
    });
  });

  it('keeps content-length on ordinary (non-streaming) proxy responses', async () => {
    const handler = jsonDaemon(() => ({ body: { ok: true } }));
    await withHost(handler, async ({ url }) => {
      const response = await fetch(`${url}api/v1/models`);
      assert.equal(response.status, 200);
      assert.ok(Number(response.headers.get('content-length')) > 0,
        'ordinary responses keep their length; only streams drop it');
    });
  });
});
