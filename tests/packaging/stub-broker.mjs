/**
 * Loopback stub broker for the M8 `session/prompt` smoke (author PT-dove).
 *
 * The bundle ships one provider, `deepseek-official`, whose `baseURL` comes from
 * `AEGIS_BROKER_BASE_URL` and whose credential comes from `AEGIS_BROKER_TOKEN`.
 * There is no real credential and no permitted egress in this verification, so
 * the only way to exercise the prompt path is a local stand-in that speaks the
 * same wire protocol the provider really uses:
 *
 *   POST <baseURL>/v1/messages   (Messages API, `text/event-stream`)
 *
 * It records every request so the test can prove the worker actually went
 * through the transport instead of short-circuiting, and it replies with one
 * fixed assistant turn. It binds `127.0.0.1` on an ephemeral port and never
 * accepts a connection from anywhere else.
 *
 * What this does NOT prove: that a real broker or a real model behaves this way.
 * It proves the *bundled client stack* resolves, connects, serialises a prompt
 * and consumes a streamed answer without loading a package the trim removed.
 */

import { createServer } from 'node:http';

const REPLY_TEXT = 'stub-broker-reply: no model was called';

function event(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The smallest well-formed Messages stream that the provider's translator
 * accepts: message_start, one text block, a stop reason, message_stop.
 */
function bodyFor(model) {
  return [
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stub_0001',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 17, output_tokens: 0 },
      },
    }),
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: REPLY_TEXT },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
}

/**
 * Start the stub. Resolves once it is listening.
 * @returns {Promise<{url: string, port: number, requests: object[], replyText: string, close: () => Promise<void>}>}
 */
export async function startStubBroker({ replyText = REPLY_TEXT } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        rawBytes: Buffer.byteLength(raw),
      });
      if (request.method !== 'POST' || !(request.url ?? '').endsWith('/messages')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'stub broker: unexpected route' } }));
        return;
      }
      const model = typeof body?.model === 'string' ? body.model : 'unknown';
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.end(bodyFor(model).replace(REPLY_TEXT, replyText));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/anthropic`,
    port,
    requests,
    replyText,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
