/**
 * AI-ENABLE · 本机 OpenAI 兼容假 provider（127.0.0.1:0，零外联）
 *
 * 用途：给 explain-chain / tier / cost-degrade 三席提供「请求真的发出去了」的可断言证据。
 * 只用 node stdlib（node:http），不连接任何真实模型服务，不读环境变量或配置文件里的 key。
 *
 * 契约（跨席，签名不得随意改；要改先报 Lead）：
 *   export const BEHAVIORS = Object.freeze(['delta','tool-call','rate-limit','timeout','truncated']);
 *   export async function startFakeProvider(options = {}) -> Promise<FakeProvider>
 *   options: { behaviors, defaultBehavior, chunks, gapMs, usage, toolCall, hangMs,
 *              truncateAfterChunks, delayFirstByteMs }
 *   FakeProvider: { port, origin, baseUrl, requests, modelsSeen(), count(pathSub),
 *                   reset(), waitForRequests(n, timeoutMs), waitForAbort(timeoutMs), close() }
 *
 * 行为语义见 tests/ai/README.md 与 docs/implementation/ACTIVE-NOTICE.md N-036。
 *
 * @author PT-dove
 */

import http from 'node:http';

/** 五种行为，顺序即契约顺序。 */
export const BEHAVIORS = Object.freeze(['delta', 'tool-call', 'rate-limit', 'timeout', 'truncated']);

const JSON_TYPE = 'application/json; charset=utf-8';
const SSE_TYPE = 'text/event-stream; charset=utf-8';

/** 未配置 behaviors 时 GET /v1/models 暴露的模型 id（按行为命名，便于其他席位直接使用）。 */
const DEFAULT_MODEL_IDS = Object.freeze([
  'fake-delta',
  'fake-tool-call',
  'fake-rate-limit',
  'fake-timeout',
  'fake-truncated',
]);

const DEFAULT_CHUNKS = Object.freeze(['fake-delta-1', 'fake-delta-2']);
const DEFAULT_USAGE = Object.freeze({ prompt_tokens: 12, completion_tokens: 34 });
const DEFAULT_TOOL_CALL = Object.freeze({
  name: 'get_alert_detail',
  arguments: '{"alertId":"alert-fixture-0001"}',
});

/** truncated 行为在 destroy 前给客户端留出收帧时间（毫秒）。 */
const TRUNCATE_FLUSH_MS = 20;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`startFakeProvider: ${name} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

function normalizeUsage(usage) {
  if (usage === null) return null;
  if (usage === undefined) usage = DEFAULT_USAGE;
  if (!isPlainObject(usage)) {
    throw new TypeError('startFakeProvider: usage must be an object {prompt_tokens, completion_tokens} or null');
  }
  const promptTokens = assertNonNegativeInteger('usage.prompt_tokens', usage.prompt_tokens);
  const completionTokens = assertNonNegativeInteger('usage.completion_tokens', usage.completion_tokens);
  const totalTokens = usage.total_tokens === undefined
    ? promptTokens + completionTokens
    : assertNonNegativeInteger('usage.total_tokens', usage.total_tokens);
  return Object.freeze({ prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens });
}

function normalizeToolCall(toolCall) {
  if (toolCall === undefined) toolCall = DEFAULT_TOOL_CALL;
  if (!isPlainObject(toolCall) || typeof toolCall.name !== 'string' || toolCall.name.length === 0) {
    throw new TypeError('startFakeProvider: toolCall must be {name: string, arguments: string}');
  }
  if (typeof toolCall.arguments !== 'string') {
    throw new TypeError('startFakeProvider: toolCall.arguments must be a JSON string');
  }
  return Object.freeze({ name: toolCall.name, arguments: toolCall.arguments });
}

function normalizeOptions(options) {
  if (!isPlainObject(options)) {
    throw new TypeError('startFakeProvider: options must be an object');
  }

  const behaviors = options.behaviors ?? {};
  if (!isPlainObject(behaviors)) {
    throw new TypeError('startFakeProvider: behaviors must be an object mapping modelId -> behavior');
  }
  for (const [modelId, behavior] of Object.entries(behaviors)) {
    if (!BEHAVIORS.includes(behavior)) {
      throw new TypeError(
        `startFakeProvider: behaviors[${JSON.stringify(modelId)}] must be one of ${BEHAVIORS.join(' | ')} (got ${JSON.stringify(behavior)})`,
      );
    }
  }

  const defaultBehavior = options.defaultBehavior ?? 'delta';
  if (!BEHAVIORS.includes(defaultBehavior)) {
    throw new TypeError(`startFakeProvider: defaultBehavior must be one of ${BEHAVIORS.join(' | ')} (got ${JSON.stringify(defaultBehavior)})`);
  }

  const chunks = options.chunks ?? DEFAULT_CHUNKS;
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.some((chunk) => typeof chunk !== 'string')) {
    throw new TypeError('startFakeProvider: chunks must be a non-empty array of strings');
  }

  return Object.freeze({
    behaviors: Object.freeze({ ...behaviors }),
    defaultBehavior,
    chunks: Object.freeze([...chunks]),
    gapMs: assertNonNegativeInteger('gapMs', options.gapMs ?? 0),
    usage: normalizeUsage(options.usage),
    toolCall: normalizeToolCall(options.toolCall),
    hangMs: assertNonNegativeInteger('hangMs', options.hangMs ?? 30_000),
    truncateAfterChunks: assertNonNegativeInteger(
      'truncateAfterChunks',
      options.truncateAfterChunks ?? 2,
    ),
    delayFirstByteMs: assertNonNegativeInteger('delayFirstByteMs', options.delayFirstByteMs ?? 0),
  });
}

function parseJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function alive(res) {
  return res.destroyed !== true && res.writableEnded !== true;
}

/**
 * 启动假 provider。
 *
 * @param {{
 *   behaviors?: Record<string, 'delta'|'tool-call'|'rate-limit'|'timeout'|'truncated'>,
 *   defaultBehavior?: 'delta'|'tool-call'|'rate-limit'|'timeout'|'truncated',
 *   chunks?: string[],
 *   gapMs?: number,
 *   usage?: {prompt_tokens:number,completion_tokens:number,total_tokens?:number}|null,
 *   toolCall?: {name:string,arguments:string},
 *   hangMs?: number,
 *   truncateAfterChunks?: number,
 *   delayFirstByteMs?: number,
 * }} [options]
 * @returns {Promise<import('./fake-provider.mjs').FakeProvider>}
 */
export async function startFakeProvider(options = {}) {
  const config = normalizeOptions(options);

  /** @type {Array<object>} 请求记录，按到达顺序（index 单调递增）。 */
  const requests = [];
  const sockets = new Set();
  /** @type {Set<{timer: NodeJS.Timeout, onCancel: (() => void)|null}>} */
  const pending = new Set();
  /** @type {Set<{check: () => void, fail: (error: Error) => void}>} */
  const waiters = new Set();

  let closed = false;
  let nextIndex = 0;
  let origin = '';

  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // 客户端提前断开属预期路径（abort 用例），不能让它变成未捕获异常。
  server.on('clientError', (_error, socket) => {
    try {
      socket.destroy();
    } catch {
      /* noop */
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  const port = address.port;
  origin = `http://127.0.0.1:${port}`;

  // ---------------------------------------------------------------- 定时器

  function schedule(ms, fn) {
    const entry = { timer: null, onCancel: null };
    entry.timer = setTimeout(() => {
      pending.delete(entry);
      fn();
    }, ms);
    pending.add(entry);
    return entry;
  }

  function cancelSchedule(entry) {
    if (entry === null || entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(entry);
    if (typeof entry.onCancel === 'function') {
      const cancel = entry.onCancel;
      entry.onCancel = null;
      cancel();
    }
  }

  /** 可取消的 sleep：close()/reset() 时立刻放行，让等待中的协程自行退出。 */
  function sleep(ms) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = schedule(ms, resolve);
      entry.onCancel = resolve;
    });
  }

  function clearAllTimers() {
    for (const entry of [...pending]) cancelSchedule(entry);
  }

  // ---------------------------------------------------------------- 等待器

  function notify() {
    for (const waiter of [...waiters]) waiter.check();
  }

  function waitFor(label, predicate, timeoutMs, describe) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(Object.assign(new Error(`[fake-provider] ${label}: provider is closed`), { code: 'ECLOSED' }));
        return;
      }
      let entry = null;
      const waiter = { check: null, fail: null };
      const cleanup = () => {
        waiters.delete(waiter);
        if (entry !== null) {
          cancelSchedule(entry);
          entry = null;
        }
      };
      waiter.check = () => {
        let result;
        try {
          result = predicate();
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (result === false || result === null || result === undefined) return;
        cleanup();
        resolve(result);
      };
      waiter.fail = (error) => {
        cleanup();
        reject(error);
      };
      entry = schedule(timeoutMs, () => {
        cleanup();
        reject(
          Object.assign(
            new Error(`[fake-provider] ${label}: timed out after ${timeoutMs}ms (${describe()})`),
            { code: 'ETIMEOUT' },
          ),
        );
      });
      waiters.add(waiter);
      waiter.check();
    });
  }

  // ---------------------------------------------------------------- 请求处理

  function handleRequestBody(req, res, record) {
    const bodyChunks = [];
    req.on('data', (chunk) => bodyChunks.push(chunk));
    req.on('end', () => {
      record.rawBody = Buffer.concat(bodyChunks).toString('utf8');
      record.body = parseJson(record.rawBody);
      record.model = typeof record.body?.model === 'string' ? record.body.model : null;
      record.stream = record.body?.stream === true;
      record.bodyReady = true;
      notify();
      void runBehavior(record, res);
    });
  }

  function handleRequest(req, res) {
    const rawUrl = req.url ?? '/';
    const record = {
      index: nextIndex,
      method: req.method ?? '',
      path: '/',
      url: rawUrl,
      headers: { ...req.headers },
      at: Date.now(),
      body: null,
      rawBody: '',
      model: null,
      stream: false,
      statusWritten: false,
      responseEnded: false,
      closedAt: null,
      abortedAt: null,
      closedAfterMs: null,
      // 契约之外的附加字段（便于证据与排障，其他席位可读但不得依赖其存在）：
      behavior: null,
      bodyReady: false,
    };
    nextIndex += 1;

    try {
      record.path = new URL(rawUrl, origin).pathname;
    } catch {
      record.path = rawUrl;
    }

    requests.push(record);

    res.on('error', () => {});
    req.on('error', () => {});
    res.on('close', () => {
      record.closedAt = Date.now();
      record.closedAfterMs = record.closedAt - record.at;
      if (record.responseEnded !== true && record.abortedAt === null) {
        record.abortedAt = record.closedAt;
      }
      notify();
    });

    handleRequestBody(req, res, record);
  }

  function resolveBehavior(model) {
    if (typeof model === 'string' && Object.prototype.hasOwnProperty.call(config.behaviors, model)) {
      return config.behaviors[model];
    }
    return config.defaultBehavior;
  }

  async function runBehavior(record, res) {
    if (closed) {
      destroyQuietly(res);
      return;
    }

    if (record.path === '/v1/models' && record.method === 'GET') {
      sendModels(record, res);
      return;
    }
    if (record.path !== '/v1/chat/completions') {
      sendJson(record, res, 404, { error: { message: 'not found', type: 'not_found_error' } });
      return;
    }
    if (record.method !== 'POST') {
      sendJson(record, res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error' } });
      return;
    }

    const behavior = resolveBehavior(record.model);
    record.behavior = behavior;

    switch (behavior) {
      case 'delta':
        await respondStream(record, res, { toolCall: false });
        return;
      case 'tool-call':
        await respondStream(record, res, { toolCall: true });
        return;
      case 'rate-limit':
        sendJson(record, res, 429, {
          error: { message: 'synthetic rate limit', type: 'rate_limit_error' },
        });
        return;
      case 'timeout':
        hang(record, res);
        return;
      case 'truncated':
        await respondTruncated(record, res);
        return;
      default:
        sendJson(record, res, 500, { error: { message: 'unknown behavior', type: 'server_error' } });
    }
  }

  // ---------------------------------------------------------------- 响应实现

  function sendJson(record, res, status, payload) {
    if (!alive(res)) return;
    const body = JSON.stringify(payload);
    record.statusWritten = true;
    record.responseEnded = true;
    try {
      res.writeHead(status, {
        'content-type': JSON_TYPE,
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      /* 客户端已断开 */
    }
  }

  function sendModels(record, res) {
    const configured = Object.keys(config.behaviors);
    const ids = configured.length > 0 ? configured : DEFAULT_MODEL_IDS;
    sendJson(record, res, 200, {
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake-provider' })),
    });
  }

  function writeSseHead(record, res, { connectionClose = false } = {}) {
    record.statusWritten = true;
    try {
      if (connectionClose) {
        // 截断行为写完之后连接必然不可复用。显式声明 connection: close（并关掉本响应的
        // keep-alive），否则客户端连接池（undici fetch）会把这条"半截连接"放回池子，
        // 同一 origin 的下一条请求就会报 `TypeError: fetch failed / SocketError: other side closed`。
        res.shouldKeepAlive = false;
        res.setHeader('connection', 'close');
      }
      res.writeHead(200, {
        'content-type': SSE_TYPE,
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
    } catch {
      /* 客户端已断开 */
    }
  }

  function writeSse(res, payload) {
    if (!alive(res)) return;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    try {
      res.write(`data: ${text}\n\n`);
    } catch {
      /* 客户端已断开 */
    }
  }

  function finish(record, res) {
    if (!alive(res)) return;
    record.responseEnded = true;
    try {
      res.end();
    } catch {
      /* 客户端已断开 */
    }
  }

  function destroyQuietly(res) {
    try {
      res.destroy();
    } catch {
      /* noop */
    }
  }

  function chunkEnvelope(record) {
    return {
      id: `chatcmpl-fake-${record.index}`,
      object: 'chat.completion.chunk',
      created: Math.floor(record.at / 1000),
      model: record.model ?? 'fake-model',
    };
  }

  function usageField() {
    return config.usage === null ? {} : { usage: config.usage };
  }

  function respondJsonCompletion(record, res, { toolCall }) {
    const content = config.chunks.join('');
    const message = toolCall
      ? {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_fake_${record.index}`,
            type: 'function',
            function: { name: config.toolCall.name, arguments: config.toolCall.arguments },
          },
        ],
      }
      : { role: 'assistant', content };
    sendJson(record, res, 200, {
      id: `chatcmpl-fake-${record.index}`,
      object: 'chat.completion',
      created: Math.floor(record.at / 1000),
      model: record.model ?? 'fake-model',
      choices: [{ index: 0, message, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
      ...usageField(),
    });
  }

  async function respondStream(record, res, { toolCall }) {
    if (record.stream !== true) {
      respondJsonCompletion(record, res, { toolCall });
      return;
    }
    if (config.delayFirstByteMs > 0) {
      await sleep(config.delayFirstByteMs);
      if (!alive(res)) return;
    }

    writeSseHead(record, res);
    if (!alive(res)) return;
    const envelope = chunkEnvelope(record);

    if (toolCall) {
      writeSse(res, {
        ...envelope,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_fake_${record.index}`,
                  type: 'function',
                  function: { name: config.toolCall.name, arguments: config.toolCall.arguments },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      await sleep(config.gapMs);
      if (!alive(res)) return;
      writeSse(res, {
        ...envelope,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        ...usageField(),
      });
      writeSse(res, '[DONE]');
      finish(record, res);
      return;
    }

    for (const chunk of config.chunks) {
      if (!alive(res)) return;
      writeSse(res, {
        ...envelope,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      });
      await sleep(config.gapMs);
    }
    if (!alive(res)) return;
    writeSse(res, {
      ...envelope,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...usageField(),
    });
    writeSse(res, '[DONE]');
    finish(record, res);
  }

  async function respondTruncated(record, res) {
    if (record.stream !== true) {
      // truncated 是"流到一半断"，非流式请求也走同一个半截语义：先给 SSE 头再断，
      // 保证任何客户端都拿不到完整响应。调用方不该用非流式请求搭 truncated。
      record.stream = true;
    }
    if (config.delayFirstByteMs > 0) {
      await sleep(config.delayFirstByteMs);
      if (!alive(res)) return;
    }

    writeSseHead(record, res, { connectionClose: true });
    if (!alive(res)) return;
    const envelope = chunkEnvelope(record);

    for (let index = 0; index < config.truncateAfterChunks; index += 1) {
      if (!alive(res)) return;
      writeSse(res, {
        ...envelope,
        choices: [
          {
            index: 0,
            delta: { content: config.chunks[index % config.chunks.length] },
            finish_reason: null,
          },
        ],
      });
      await sleep(config.gapMs);
    }
    if (!alive(res)) return;

    // 让已写出的帧先落到客户端，再断连；没有 [DONE]、不 end。
    await sleep(Math.max(config.gapMs, TRUNCATE_FLUSH_MS));
    if (res.destroyed === true || res.writableEnded === true) return;
    destroyQuietly(res);
  }

  function hang(record, res) {
    const entry = schedule(config.hangMs, () => {
      if (!res.destroyed) destroyQuietly(res);
    });
    res.once('close', () => cancelSchedule(entry));
    void record;
  }

  // ---------------------------------------------------------------- 对外 API

  function waitForRequests(count, timeoutMs = 2_000) {
    if (!Number.isInteger(count) || count < 1) {
      return Promise.reject(new TypeError('waitForRequests: count must be a positive integer'));
    }
    assertNonNegativeInteger('waitForRequests.timeoutMs', timeoutMs);
    return waitFor(
      'waitForRequests',
      () => {
        if (requests.length < count) return false;
        // 记录先入数组、请求体随后解析；等前 count 条都定稿再解析，避免 model 还是 null 的竞态。
        const ready = requests.slice(0, count).every((record) => record.bodyReady === true || record.abortedAt !== null);
        return ready ? requests.slice() : false;
      },
      timeoutMs,
      () => `${requests.length}/${count} requests`,
    );
  }

  function waitForAbort(timeoutMs = 3_000) {
    assertNonNegativeInteger('waitForAbort.timeoutMs', timeoutMs);
    return waitFor(
      'waitForAbort',
      () => {
        const aborted = requests.find((record) => record.abortedAt !== null);
        return aborted === undefined ? false : aborted;
      },
      timeoutMs,
      () => `no aborted request among ${requests.length}`,
    );
  }

  const api = {
    port,
    origin,
    baseUrl: `${origin}/v1`,
    /** 请求记录（按到达顺序；index 单调递增，reset() 不回退）。 */
    requests,
    /** 归一化后的配置快照（只读，附加字段）。 */
    config,
    get closed() {
      return closed;
    },
    /** 出现过的 model 名（首次出现顺序、去重）。 */
    modelsSeen() {
      const seen = [];
      for (const record of requests) {
        if (typeof record.model === 'string' && record.model.length > 0 && !seen.includes(record.model)) {
          seen.push(record.model);
        }
      }
      return seen;
    },
    /** path 片段计数；不传则返回全部请求数。 */
    count(pathSub) {
      if (pathSub === undefined || pathSub === null) return requests.length;
      const needle = typeof pathSub === 'string' ? pathSub : String(pathSub);
      return requests.filter((record) => record.path.includes(needle) || record.url.includes(needle)).length;
    },
    /** 清空请求记录（等待中的 waitFor 会以 ERESET 拒绝）。 */
    reset() {
      if (closed) return;
      for (const waiter of [...waiters]) {
        waiter.fail(Object.assign(new Error('[fake-provider] reset: pending wait cancelled'), { code: 'ERESET' }));
      }
      requests.length = 0;
    },
    waitForRequests,
    waitForAbort,
    /** 幂等；关闭后所有等待立即拒绝，socket 与定时器全部清理。 */
    async close() {
      if (closed) return;
      closed = true;
      const error = Object.assign(new Error('[fake-provider] closed'), { code: 'ECLOSED' });
      for (const waiter of [...waiters]) waiter.fail(error);
      clearAllTimers();
      for (const socket of [...sockets]) {
        try {
          socket.destroy();
        } catch {
          /* noop */
        }
      }
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    },
  };

  return api;
}
