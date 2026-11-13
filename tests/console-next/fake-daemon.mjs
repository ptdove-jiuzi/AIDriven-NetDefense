/**
 * UI2-B11 · 可控假 daemon（127.0.0.1:0）
 *
 * 两种用途：
 * 1. B3 `serve.mjs` 的上游：验证 token 注入 / CSRF 注入 / Origin 剥离 / SSE 透传 / 断连传播；
 * 2. B2 `sse.js` 的 SSE 源：验证 delta/usage/done/error、半截断流、取消。
 *
 * 所有数据都是合成夹具，不连接真实 daemon / provider。请求全部记账（含 headers/body/断开时间）。
 *
 * @author PT-dove
 */

import http from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

const DEFAULT_SSE_FRAMES = Object.freeze([
  { event: 'delta', data: { seq: 1, text: '先看' } },
  { event: 'delta', data: { seq: 2, text: '这条告警。' } },
  { event: 'usage', data: { seq: 3, promptTokens: 120, completionTokens: 45, totalTokens: 165, estimatedCostUsd: null } },
  { event: 'done', data: { seq: 4, finishReason: 'stop', sessionId: 's_test', messageId: 'm_1', totalTokens: 165 } },
]);

function serializeFrame(frame, id = null) {
  const eventName = frame.event ?? 'message';
  const payload = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
  const lines = [];
  if (frame.comment) lines.push(`: ${frame.comment}`);
  if (eventName !== 'message' || frame.forceEventName === true) lines.push(`event: ${eventName}`);
  lines.push(`data: ${payload}`);
  void id;
  return `${lines.join('\n')}\n\n`;
}

/**
 * 启动假 daemon。
 *
 * @param {import('node:test').TestContext|null} t 若传入，测试结束自动关闭。
 * @param {{
 *   sseFrames?: Array<{event?:string,data:any,comment?:string}>,
 *   sseDelayMs?: number,
 *   mode?: 'ok'|'json-error'|'sse-error'|'half'|'hang'|'slow',
 *   status?: object,
 *   models?: object,
 *   settings?: object,
 *   settingsSchema?: object,
 *   headers?: Record<string,string>,
 *   onRequest?: (record: object) => boolean|void,
 * }} [options]
 */
export async function startFakeDaemon(t, options = {}) {
  const state = {
    mode: options.mode ?? 'ok',
    sseFrames: options.sseFrames ?? DEFAULT_SSE_FRAMES,
    sseDelayMs: options.sseDelayMs ?? 0,
    status: options.status ?? { lifecycle: 'running', version: '0.0.0-test', uptimeSeconds: 42 },
    failStatus: null,
    models: options.models ?? defaultModels(),
    settings: options.settings ?? { schemaVersion: '1.0', updatedAt: '2026-11-04T00:00:00.000Z', settings: {}, warnings: [] },
    settingsSchema: options.settingsSchema ?? { schemaVersion: '1.0', groups: [], actions: [], actionCatalog: [] },
    headers: options.headers ?? {},
  };
  const requests = [];
  const sockets = new Set();

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
      const record = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        raw,
        body,
        abortedAt: null,
        closedAt: null,
        responseStatus: null,
      };
      requests.push(record);
      res.on('close', () => {
        record.closedAt = Date.now();
        if (!res.writableEnded) record.abortedAt = Date.now();
      });
      res.on('error', () => {});
      req.on('error', () => {});
      if (options.onRequest && options.onRequest(record, res) === false) return;
      handle(req, res, record);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  function sendJson(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...state.headers,
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendError(res, status, code, details = undefined) {
    const payload = { error: { code, message: `${code} synthetic`, ...(details === undefined ? {} : { details }) } };
    const body = JSON.stringify(payload);
    const headers = { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' };
    if (code === 'CHAT_BUSY') headers['retry-after'] = '1';
    res.writeHead(status, { ...state.headers, ...headers });
    res.end(body);
  }

  function sendSse(res, frames, mode) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...state.headers,
    });
    if (mode === 'sse-error') {
      for (const frame of frames) res.write(serializeFrame(frame));
      res.write(serializeFrame({
        event: 'error',
        data: {
          seq: frames.length + 1,
          code: 'UPSTREAM_FAILED',
          message: 'provider failed',
          retryable: true,
          action: 'CHECK_MODEL_SETTINGS',
          details: {},
        },
      }));
      res.end();
      return;
    }
    if (mode === 'half') {
      const first = frames[0] ?? { event: 'delta', data: { seq: 1, text: '半截' } };
      res.write(serializeFrame(first));
      // 发一帧后直接毁掉 socket：客户端应看到"未收终态就断流"（terminal=interrupted）。
      setTimeout(() => {
        try {
          res.destroy();
        } catch {
          /* 已断开 */
        }
      }, 20);
      return;
    }
    if (mode === 'hang') {
      res.write(': ping\n\n');
      return;
    }
    let index = 0;
    const writeNext = () => {
      if (index >= frames.length) {
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(serializeFrame(frames[index]));
      index += 1;
      if (state.sseDelayMs > 0) setTimeout(writeNext, state.sseDelayMs);
      else setImmediate(writeNext);
    };
    writeNext();
  }

  function handle(req, res, record) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method;
    record.responseStatus = 200;

    // 故障注入：所有 /api/v1/* 返回指定状态（shell 的"接口 500 不白屏"用）。
    if (state.failStatus && pathname.startsWith('/api/v1/')) {
      record.responseStatus = state.failStatus;
      return sendError(res, state.failStatus, 'INTERNAL');
    }

    if (pathname === '/healthz') return sendJson(res, 200, { status: 'ok', version: '0.0.0-test' });
    if (pathname === '/readyz') return sendJson(res, 200, { ready: true, lifecycle: 'running', reasons: [] });
    if (pathname === '/api/v1/status') return sendJson(res, 200, state.status);
    if (pathname === '/api/v1/models') return sendJson(res, 200, state.models);
    if (pathname === '/api/v1/settings' && method === 'GET') return sendJson(res, 200, state.settings);
    if (pathname === '/api/v1/settings' && method === 'PUT') return sendJson(res, 200, { settings: body?.settings ?? {}, updatedAt: '2026-11-04T00:00:00.000Z', appliedNow: [], restartRequired: [] });
    if (pathname === '/api/v1/settings/schema') return sendJson(res, 200, state.settingsSchema);
    if (pathname.startsWith('/api/v1/credentials/')) {
      if (method === 'PUT') {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (method === 'DELETE') {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      return sendError(res, 405, 'METHOD_NOT_ALLOWED');
    }
    if (pathname === '/api/v1/agent/chat' && method === 'POST') {
      if (state.mode === 'json-error') return sendError(res, 502, 'UPSTREAM_FAILED');
      if (state.mode === 'slow') return setTimeout(() => sendSse(res, state.sseFrames, 'ok'), 150);
      return sendSse(res, state.sseFrames, state.mode);
    }
    if (/^\/api\/v1\/alerts\/[^/]+\/explain$/u.test(pathname) && method === 'POST') {
      return sendSse(res, state.sseFrames, state.mode === 'hang' ? 'ok' : state.mode);
    }
    if (pathname === '/api/v1/agent/approval' && method === 'POST') {
      return sendJson(res, 200, { callId: body?.callId ?? 'call_1', decision: body?.decision ?? 'approve', executed: false, reason: 'EXECUTION_DISABLED' });
    }
    return sendError(res, 404, 'NOT_FOUND');
  }

  const api = {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    state,
    setMode(mode) {
      state.mode = mode;
    },
    setFrames(frames) {
      state.sseFrames = frames;
    },
    setStatus(status) {
      state.status = status;
    },
    setModels(models) {
      state.models = models;
    },
    /** 记录中最近一个匹配 url prefix 的请求。 */
    last(pathname) {
      for (let index = requests.length - 1; index >= 0; index -= 1) {
        if (requests[index].url === pathname || requests[index].url.startsWith(`${pathname}?`)) return requests[index];
      }
      return null;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  if (t) t.after(() => api.close());
  return api;
}

function defaultModels() {
  return {
    egressEnabled: true,
    routing: { mode: 'tiered', uniformModelId: null, defaultTier: 'watch' },
    providers: [
      {
        id: 'local',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        enabled: true,
        allowLoopback: true,
        hasCredential: true,
        credential: { masked: '••••cdef', fingerprint: 'a1b2c3d4', updatedAt: '2026-11-04T00:00:00.000Z', lengthBucket: '33-64' },
        healthy: null,
        lastError: null,
        lastCheckedAt: null,
        budget: { dailyInputTokens: 30000, dailyOutputTokens: 6000 },
      },
    ],
    models: [
      { id: 'local-chat', providerId: 'local', tier: 'triage', maxInputTokens: 4096, maxOutputTokens: 512, costClass: 'free-local' },
    ],
    usage: { available: false, reason: 'NO_LEDGER', byProvider: [], byTier: [], escalations: 0 },
    engine: { selected: 'broker-host', harness: { available: false, reason: 'PROFILE_NOT_STAGED' } },
  };
}
