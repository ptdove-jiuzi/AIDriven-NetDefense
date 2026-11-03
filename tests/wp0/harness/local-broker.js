import { createServer } from 'node:http';

/** Harmless loopback-only Messages endpoint with deterministic failure modes. */
export async function startLocalBroker(mode) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = text.length === 0 ? null : JSON.parse(text);
      } catch {
        body = { invalidJson: true };
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      if (request.method !== 'POST' || request.url !== '/anthropic/v1/messages') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'not_found', message: 'unexpected WP0 endpoint' } }));
        return;
      }
      if (mode === 'transport') {
        request.socket.destroy();
        return;
      }
      response.writeHead(400, {
        'content-type': 'application/json',
        'request-id': 'wp0-context-overflow',
      });
      response.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'context_window_exceeded',
          message: 'context window exceeded by synthetic WP0 input',
        },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    requests,
    baseURL: `http://127.0.0.1:${address.port}/anthropic`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
