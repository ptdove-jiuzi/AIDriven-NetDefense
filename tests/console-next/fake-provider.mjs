/**
 * UI2-B11 · 假 provider（127.0.0.1:0，OpenAI-compatible）
 *
 * 供"真 daemon 路由 → 真 B9 console-host → provider"的端到端用例使用。
 * 不连接任何真实模型服务；请求/连接全部记账，便于断言 Bearer、stream 参数与零外联。
 *
 * 路由：
 *   GET  /v1/models             → 合同 §2.4 的 `{object:"list",data:[…]}`
 *   POST /v1/chat/completions   → SSE（默认）/ JSON / 500 / 302 / 挂起
 *
 * @author PT-dove
 */

import http from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * @param {import('node:test').TestContext|null} t
 * @param {{
 *   mode?: 'sse'|'json'|'error'|'redirect'|'hang'|'slow',
 *   modelCount?: number,
 *   deltas?: string[],
 *   finishReason?: string,
 *   usage?: {prompt_tokens:number, completion_tokens:number, total_tokens:number}|null,
 *   delayMs?: number,
 *   headers?: Record<string,string>,
 * }} [options]
 */
export async function startFakeProvider(t, options = {}) {
  const state = {
    mode: options.mode ?? 'sse',
    modelCount: options.modelCount ?? 3,
    deltas: options.deltas ?? ['先看', '这条告警。'],
    finishReason: options.finishReason ?? 'stop',
    usage: options.usage === undefined ? { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 } : options.usage,
    delayMs: options.delayMs ?? 10,
    headers: options.headers ?? {},
  };
  const requests = [];
  const sockets = new Set();
  let connections = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const record = { method: req.method, url: req.url, headers: { ...req.headers }, raw, body, abortedAt: null, closedAt: null };
      requests.push(record);
      res.on('close', () => {
        record.closedAt = Date.now();
        if (!res.writableEnded) record.abortedAt = Date.now();
      });
      res.on('error', () => {});
      req.on('error', () => {});
      handle(req, res, record);
    });
  });
  server.on('connection', (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  function handle(req, res) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/v1/models' && req.method === 'GET') {
      const payload = { object: 'list', data: Array.from({ length: state.modelCount }, (_, index) => ({ id: `local-model-${index}` })) };
      const body = JSON.stringify(payload);
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body), ...state.headers });
      res.end(body);
      return;
    }
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (state.mode === 'error') {
        const body = JSON.stringify({ error: { message: 'synthetic provider failure' } });
        res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (state.mode === 'redirect') {
        res.writeHead(302, { location: 'https://example.invalid/steal' });
        res.end();
        return;
      }
      if (state.mode === 'hang') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(sseFrame({ choices: [{ delta: { content: '挂起' } }] }));
        return;
      }
      if (state.mode === 'json') {
        const payload = {
          model: 'local-chat',
          choices: [{ message: { content: state.deltas.join('') }, finish_reason: state.finishReason }],
          ...(state.usage === null ? {} : { usage: state.usage }),
        };
        const body = JSON.stringify(payload);
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      let index = 0;
      const writeNext = () => {
        if (index < state.deltas.length) {
          res.write(sseFrame({ choices: [{ delta: { content: state.deltas[index] } }] }));
          index += 1;
          setTimeout(writeNext, state.delayMs);
          return;
        }
        const usageFrame = state.usage === null
          ? { choices: [{ delta: {}, finish_reason: state.finishReason }] }
          : { choices: [{ delta: {}, finish_reason: state.finishReason }], usage: state.usage };
        res.write(sseFrame(usageFrame));
        res.end();
      };
      writeNext();
      return;
    }
    res.writeHead(404, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  const api = {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    state,
    connections: () => connections,
    setMode(mode) {
      state.mode = mode;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  if (t) t.after(() => api.close());
  return api;
}
