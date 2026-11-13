/**
 * api-sse-prestart-abort.test.js — a disconnect before the first SSE byte is an abort.
 *
 * chat.js creates the channel and then awaits the engine (`openStream`) before calling
 * `start()`. A client that goes away inside that window used to be invisible: the
 * `close` listener was only registered inside `start()`, so `onAbort` never ran and the
 * quota / approval session / child process were held until the idle (90 s) or total
 * (300 s) timer — BUG-LEDGER R4-002. The assertion is behavioural: a real socket is
 * destroyed before `start()`, and the handler observes the abort.
 */

import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { createAuthGuard } from '../../apps/daemon/src/api/auth.js';
import { createControlApi } from '../../apps/daemon/src/api/server.js';
import { createSseStream } from '../../apps/daemon/src/api/sse.js';
import { BASE_MS, TEST_TOKEN, createManualClock } from './helpers.js';

const CHAT_PATH = '/api/v1/agent/chat';
const servers = new Set();

after(async () => {
  for (const api of servers) {
    await api.close();
  }
  servers.clear();
});

/**
 * Start a control API whose chat handler mirrors `chat.js`'s shape:
 * create the channel → await the engine (here a timer) → `start()`.
 */
async function startApi(observed) {
  const auth = createAuthGuard({
    token: TEST_TOKEN,
    clock: createManualClock(BASE_MS),
    failureLimit: 10_000,
    failureWindowMs: 60_000,
  });
  const api = createControlApi({
    config: {
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 2000,
      headersTimeoutMs: 2000,
      keepAliveTimeoutMs: 1000,
      maxBodyBytes: 65536,
    },
    auth,
    handlers: {
      health: () => ({ status: 'ok' }),
      ready: () => ({ ready: true, body: { ready: true } }),
      status: () => ({ lifecycle: 'running' }),
      pollSource: async (sourceId) => ({ id: sourceId }),
      async chat(ctx) {
        observed.active += 1;
        let channel = null;
        try {
          channel = createSseStream({
            res: ctx.res,
            securityHeaders: ctx.securityHeaders,
            onAbort: () => {
              observed.abortCallbacks += 1;
            },
          });
          // The real window: chat.js awaits `engine.openStream` here.
          await sleep(observed.openStreamMs);
          observed.startReturned = channel.start();
          if (observed.startReturned !== true) {
            return;
          }
          observed.started += 1;
          channel.send('delta', { text: 'late' });
          await sleep(observed.holdMs);
          channel.send('done', { finishReason: 'stop' });
        } finally {
          observed.active -= 1;
        }
      },
    },
  });
  const address = await api.start();
  servers.add(api);
  return { api, auth, port: address.port };
}

/** Open the chat route and destroy the whole socket after `abortAfterMs`. */
function openChatAndAbort(port, csrf, abortAfterMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ sessionId: 's1', messages: [], modelId: 'm1' });
    const events = [];
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: CHAT_PATH,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${TEST_TOKEN}`,
        'x-aegis-csrf': csrf,
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    });
    request.on('response', (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => events.push(chunk));
      response.on('error', () => {});
    });
    request.on('error', () => {});
    request.end(payload);
    setTimeout(() => {
      request.destroy();
      resolve({ events });
    }, abortAfterMs);
  });
}

function freshObserved(openStreamMs, holdMs = 60) {
  return { active: 0, abortCallbacks: 0, started: 0, startReturned: null, openStreamMs, holdMs };
}

describe('SSE abort before start() (R4-002)', () => {
  it('fires onAbort when the client disconnects before the stream starts', async () => {
    const observed = freshObserved(250);
    const { auth, port } = await startApi(observed);
    const client = await openChatAndAbort(port, auth.csrfToken, 40); // 40 ms << 250 ms
    // Wait until the handler has attempted `start()` on the dead response.
    const deadline = Date.now() + 3000;
    while (observed.startReturned === null && Date.now() < deadline) {
      await sleep(10);
    }
    assert.equal(observed.abortCallbacks, 1, 'onAbort must fire exactly once for a pre-start disconnect');
    assert.equal(observed.startReturned, false, 'start() must refuse to write headers on a dead response');
    assert.equal(observed.started, 0, 'no SSE event may be sent after the abort');
    assert.equal(client.events.join('').length, 0, 'the client must receive no SSE bytes');
    assert.equal(observed.active, 0, 'the handler must release its stream slot');
  });

  it('still fires onAbort exactly once for a mid-stream disconnect', async () => {
    const observed = freshObserved(0, 500); // stream stays open for 500 ms
    const { auth, port } = await startApi(observed);
    await openChatAndAbort(port, auth.csrfToken, 120); // the client leaves mid-stream
    const deadline = Date.now() + 3000;
    while (observed.active !== 0 && Date.now() < deadline) {
      await sleep(10);
    }
    assert.equal(observed.abortCallbacks, 1, 'a mid-stream disconnect must abort exactly once');
    assert.equal(observed.started, 1);
    assert.equal(observed.active, 0);
  });
});
