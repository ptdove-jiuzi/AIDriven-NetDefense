/**
 * api/server.js — the loopback-only control API.
 *
 * Two surfaces live here and are kept deliberately distinct:
 *
 * 1. **The original four routes** — health, readiness, status, the two read-only
 *    queries and "poll this source now". Their admission order and their semantics
 *    are frozen; they have not changed since the console-v2 work started.
 * 2. **The console v2 routes** (contract §2): models, credentials, chat/explain SSE,
 *    approval and settings. They are additive: same admission order, same security
 *    headers, plus a route-scoped method allowance and the SSE timeout exemption.
 *
 * Admission order (only the method gate learned about new routes):
 *
 * ```
 * peer is loopback → Host is the loopback endpoint → method is allowed for this
 * route → bearer token → (state-changing) Origin + CSRF → body size/type → handler
 * ```
 *
 * The method gate is route-aware on purpose. Widening it globally to
 * `GET/POST/PUT/DELETE` would have changed the answer for, say, `PUT /api/v1/status`
 * from `405` to `401`, and "the daemon refuses unknown verbs before it reveals whether
 * a token is needed" is part of the original boundary. So `PUT`/`DELETE` are accepted
 * only on a route that declares them, and every other path keeps the old 405.
 *
 * `401` accounting: `stats.rejected` keeps its existing meaning (a request that
 * produced an error response), which `tests/wp5-daemon/api-endpoints.test.js:404`
 * pins; `stats.auth_denied` is a second, additive counter so the console can tell
 * "authentication was refused" from "the daemon rejected the request for another
 * reason" without redefining the old bucket.
 *
 * SSE routes (§3.5) are exempt from `requestTimeoutMs` and instead get an 8 s header
 * deadline: if the handler cannot flush SSE headers in time, the client gets a JSON
 * `503` (a stream that never starts must not look like a hung request), and the idle
 * / total limits are enforced inside `sse.js` once the stream is open.
 */

import http from 'node:http';

import { DaemonError, DAEMON_CODES, isDaemonError } from '../errors.js';
import { CSRF_HEADER, isAllowedHost, isAllowedOrigin } from './auth.js';
import { CONSOLE_STATUS_BY_CODE, ConsoleError, isConsoleError } from './console-errors.js';
import { API_STATUS_BY_CODE, isApiError } from './errors.js';
import { SSE_HEADER_DEADLINE_MS } from './sse.js';

/**
 * Status code for each code the API can surface.
 *
 * The API and console vocabularies are merged into the daemon's table rather than
 * kept in parallel lookups: one table means the renderer cannot accidentally treat a
 * caller fault as a server fault.
 */
const STATUS_BY_CODE = Object.freeze({
  ...API_STATUS_BY_CODE,
  ...CONSOLE_STATUS_BY_CODE,
  [DAEMON_CODES.AUTH_REQUIRED]: 401,
  [DAEMON_CODES.AUTH_FAILED]: 401,
  [DAEMON_CODES.AUTH_RATE_LIMITED]: 429,
  [DAEMON_CODES.CSRF_REQUIRED]: 403,
  [DAEMON_CODES.ORIGIN_REJECTED]: 403,
  [DAEMON_CODES.PEER_REJECTED]: 403,
  [DAEMON_CODES.HOST_REJECTED]: 421,
  [DAEMON_CODES.BODY_TOO_LARGE]: 413,
  [DAEMON_CODES.CONTENT_TYPE_REJECTED]: 415,
  [DAEMON_CODES.REQUEST_TIMEOUT]: 408,
  [DAEMON_CODES.METHOD_NOT_ALLOWED]: 405,
  [DAEMON_CODES.NOT_FOUND]: 404,
  [DAEMON_CODES.SOURCE_UNKNOWN]: 404,
  [DAEMON_CODES.SOURCE_BUSY]: 409,
  [DAEMON_CODES.LIFECYCLE_NOT_RUNNING]: 409,
  [DAEMON_CODES.STORE_UNAVAILABLE]: 503,
  [DAEMON_CODES.INTERNAL]: 500,
});

/** Routes that get a named bucket in the request tally (fixed strings only). */
const KNOWN_ROUTES = new Set([
  '/healthz',
  '/readyz',
  '/api/v1/status',
  '/api/v1/alerts',
  '/api/v1/analysis',
  '/api/v1/models',
  '/api/v1/settings',
  '/api/v1/settings/schema',
  '/api/v1/agent/chat',
  '/api/v1/agent/approval',
]);

/** The only parameterised collector route. */
const POLL_PATH = /^\/api\/v1\/collectors\/[A-Za-z0-9._:-]{1,128}\/poll$/u;

/** Bucket name for the parameterised route: the id is caller-controlled, the key is not. */
const POLL_ROUTE_KEY = '/api/v1/collectors/:id/poll';

/**
 * Console v2 route table (contract §2).
 *
 * `patterns` are anchored and bounded so a caller-supplied path cannot inflate a
 * bucket key or a captured parameter. `methods` is the full set the route answers;
 * anything else on that path is a 405 (e.g. `GET /api/v1/credentials/x`).
 */
const CONSOLE_ROUTES = Object.freeze([
  Object.freeze({
    key: '/api/v1/models',
    pattern: /^\/api\/v1\/models$/u,
    methods: Object.freeze(['GET']),
    sse: false,
  }),
  Object.freeze({
    key: '/api/v1/models/:providerId/test',
    pattern: /^\/api\/v1\/models\/([^/]{1,128})\/test$/u,
    methods: Object.freeze(['POST']),
    sse: false,
    params: ['providerId'],
  }),
  Object.freeze({
    key: '/api/v1/credentials/:providerId',
    pattern: /^\/api\/v1\/credentials\/([^/]{1,128})$/u,
    methods: Object.freeze(['PUT', 'DELETE']),
    sse: false,
    params: ['providerId'],
  }),
  Object.freeze({
    key: '/api/v1/agent/chat',
    pattern: /^\/api\/v1\/agent\/chat$/u,
    methods: Object.freeze(['POST']),
    sse: true,
  }),
  Object.freeze({
    key: '/api/v1/alerts/:id/explain',
    pattern: /^\/api\/v1\/alerts\/([^/]{1,128})\/explain$/u,
    methods: Object.freeze(['POST']),
    sse: true,
    params: ['id'],
  }),
  Object.freeze({
    key: '/api/v1/agent/approval',
    pattern: /^\/api\/v1\/agent\/approval$/u,
    methods: Object.freeze(['POST']),
    sse: false,
  }),
  Object.freeze({
    key: '/api/v1/settings',
    pattern: /^\/api\/v1\/settings$/u,
    methods: Object.freeze(['GET', 'PUT']),
    sse: false,
  }),
  Object.freeze({
    key: '/api/v1/settings/schema',
    pattern: /^\/api\/v1\/settings\/schema$/u,
    methods: Object.freeze(['GET']),
    sse: false,
  }),
  // OPS-DIAG (contract §2.1 diagnostics actions). Both are state-changing POSTs:
  // they take the same admission as every other console write (Origin + CSRF),
  // and the bundle route answers with a file attachment instead of JSON.
  Object.freeze({
    key: '/api/v1/diagnostics/bundle',
    pattern: /^\/api\/v1\/diagnostics\/bundle$/u,
    methods: Object.freeze(['POST']),
    sse: false,
  }),
  Object.freeze({
    key: '/api/v1/diagnostics/token-rotate',
    pattern: /^\/api\/v1\/diagnostics\/token-rotate$/u,
    methods: Object.freeze(['POST']),
    sse: false,
  }),
]);

/** Security headers on every response, including SSE. */
export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
});

/**
 * Match one console route, extracting its named parameters.
 *
 * @param {string} pathname Request path.
 * @returns {{route: object, params: object}|null} Match, or `null`.
 */
export function matchConsoleRoute(pathname) {
  if (typeof pathname !== 'string') {
    return null;
  }
  for (const route of CONSOLE_ROUTES) {
    const match = route.pattern.exec(pathname);
    if (match === null) {
      continue;
    }
    const params = {};
    for (let index = 0; index < (route.params?.length ?? 0); index += 1) {
      params[route.params[index]] = match[index + 1];
    }
    return { route, params };
  }
  return null;
}

/**
 * Report whether a socket peer address is a loopback address.
 *
 * `::ffff:127.0.0.1` is how an IPv4 connection looks on a dual-stack listener, so it
 * is accepted explicitly rather than by string prefix matching.
 *
 * @param {string|undefined} address Socket peer address.
 * @returns {boolean} `true` for a loopback peer.
 */
export function isLoopbackPeer(address) {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

/**
 * Build the URL base used to parse a request target.
 *
 * `new URL('/healthz', 'http://::1')` throws `ERR_INVALID_URL`: a bare IPv6 literal is
 * not a legal authority, it has to be bracketed. Bracketing unconditionally is not the
 * fix either — `http://[127.0.0.1]` parses, but the parsed hostname then differs from
 * the configured IPv4 endpoint (the wave-2 M1 mutation proved the IPv4 path breaks).
 * The form therefore follows the address family of the bound host.
 *
 * @param {string} host Bound loopback host (`127.0.0.1` or `::1`).
 * @returns {string} `http://<authority>` usable as a URL base.
 */
function urlBaseFor(host) {
  const literal = host.startsWith('[') ? host : (host.includes(':') ? `[${host}]` : host);
  return `http://${literal}`;
}

function statusFor(code) {
  return STATUS_BY_CODE[code] ?? 500;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.headersSent) {
    return;
  }
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function sendNoContent(res) {
  if (res.writableEnded || res.headersSent) {
    return;
  }
  res.writeHead(204, { ...SECURITY_HEADERS });
  res.end();
}

/**
 * Reduce a handler-supplied download name to a safe attachment filename.
 *
 * The name is derived from a timestamp, but the route must never reflect an
 * arbitrary string into a header: anything outside `[A-Za-z0-9._-]` becomes `_`,
 * and a name that carries no usable characters falls back to a fixed one.
 *
 * @param {unknown} value Candidate filename.
 * @returns {string} Safe filename.
 */
export function safeAttachmentFilename(value) {
  const base = String(value ?? '').replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 128);
  if (base === '' || base === '.' || base === '..') {
    return 'diagnostics-bundle.json';
  }
  return base;
}

/**
 * Write a handler-produced file download.
 *
 * The bundle is generated in memory (it is capped, see `api/diagnostics.js`) and
 * written with `attachment` disposition so a browser saves it instead of trying
 * to render support JSON in a tab. Security headers still apply: the response is
 * `no-store` and must never be cacheable or frameable.
 *
 * @param {import('node:http').ServerResponse} res Response.
 * @param {{filename?: string, contentType?: string, body?: string|Buffer}} result Download.
 * @returns {void}
 */
function sendAttachment(res, result) {
  if (res.writableEnded || res.headersSent) {
    return;
  }
  const payload = result ?? {};
  const body = Buffer.isBuffer(payload.body)
    ? payload.body
    : Buffer.from(typeof payload.body === 'string' ? payload.body : '', 'utf8');
  res.writeHead(200, {
    'content-type': typeof payload.contentType === 'string' && payload.contentType !== ''
      ? payload.contentType
      : 'application/octet-stream',
    'content-length': body.length,
    'content-disposition': `attachment; filename="${safeAttachmentFilename(payload.filename)}"`,
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function sendError(res, code, message, details, retryAfterSeconds) {
  const status = statusFor(code);
  const headers = code === DAEMON_CODES.AUTH_REQUIRED || code === DAEMON_CODES.AUTH_FAILED
    ? { 'www-authenticate': 'Bearer realm="aegis-daemon"' }
    : {};
  if (retryAfterSeconds !== undefined && retryAfterSeconds !== null) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  }
  const payload = { error: { code, message } };
  if (details !== undefined) {
    payload.error.details = details;
  }
  sendJson(res, status, payload, headers);
}

/**
 * Read a request body with a hard byte cap.
 *
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {number} limit Maximum bytes.
 * @returns {Promise<Buffer>} Body bytes.
 * @throws {DaemonError} When the body exceeds the cap or the stream fails.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        // Reject at the moment the cap is crossed, but keep consuming and
        // discarding: pausing would leave the client's write blocked and the
        // response unable to flush. Nothing beyond `limit` is ever buffered.
        finish(reject, new DaemonError(DAEMON_CODES.BODY_TOO_LARGE, 'request body exceeds the configured limit', {
          limit_bytes: limit,
        }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', () => finish(reject, new DaemonError(DAEMON_CODES.REQUEST_TIMEOUT, 'request stream failed')));
  });
}

/**
 * Parse an already-read JSON body.
 *
 * The error code is per-route so the client sees the vocabulary of the endpoint it
 * called (`SETTINGS_INVALID` for settings, `CHAT_INVALID` for chat, …), not a generic
 * "bad request" that the console would have to re-classify.
 *
 * @param {Buffer|null} buffer Request body bytes.
 * @param {{code: string, label: string, optional?: boolean}} spec Parse context.
 * @returns {unknown} Parsed body (`undefined` when optional and absent).
 */
function parseJsonBody(buffer, spec) {
  if (buffer === null || buffer.length === 0) {
    if (spec.optional === true) {
      return undefined;
    }
    throw new ConsoleError(spec.code, `${spec.label} requires a json body`, { field: 'body', rule: 'required' });
  }
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ConsoleError(spec.code, `${spec.label} body is not valid json`, { field: 'body', rule: 'json' });
  }
}

/**
 * Create the control API.
 *
 * @param {{
 *   config: object,
 *   auth: object,
 *   handlers: {
 *     health: () => object,
 *     ready: () => {ready: boolean, body: object},
 *     status: () => object,
 *     pollSource: (sourceId: string) => Promise<object>,
 *     listAlerts?: (searchParams: URLSearchParams) => Promise<object>,
 *     listAnalyses?: (searchParams: URLSearchParams) => Promise<object>,
 *     getModels?: Function,
 *     testProvider?: Function,
 *     putCredential?: Function,
 *     deleteCredential?: Function,
 *     chat?: Function,
 *     explain?: Function,
 *     approval?: Function,
 *     getSettings?: Function,
 *     putSettings?: Function,
 *     getSettingsSchema?: Function,
 *     exportDiagnosticsBundle?: Function,
 *     rotateApiToken?: Function
 *   },
 *   logger?: object
 * }} options Options.
 * @returns {object} Server handle.
 */
export function createControlApi(options) {
  const config = options.config;
  const auth = options.auth;
  const handlers = options.handlers;
  const logger = options.logger ?? null;
  const { host, port: configuredPort } = config;
  // Parsed once: the request-target base depends on the bound address family, not on
  // the request (see `urlBaseFor`).
  const urlBase = urlBaseFor(host);
  const requestTimeoutMs = config.requestTimeoutMs;
  const maxBodyBytes = config.maxBodyBytes;

  const stats = {
    requests: 0,
    rejected: 0,
    // Additive (contract §2.1): 401s are counted here as well as in `rejected`, whose
    // meaning is pinned by tests/wp5-daemon/api-endpoints.test.js:404.
    auth_denied: 0,
    timeouts: 0,
    too_large: 0,
    by_path: {},
    unknown_paths: 0,
  };
  const authFailureWindowMs = config.authFailureWindowMs ?? 60000;
  let server = null;
  let boundPort = null;
  let closed = false;
  /** @type {Promise<{host: string, port: number}>|null} */
  let startPromise = null;

  function reject(res, code, message, details) {
    stats.rejected += 1;
    sendError(res, code, message, details);
  }

  /**
   * Resolve the tally bucket for a path: a fixed key or `null` (unknown path).
   *
   * @param {string} pathname Request path.
   * @returns {string|null} Bucket key.
   */
  function bucketFor(pathname) {
    if (KNOWN_ROUTES.has(pathname)) {
      return pathname;
    }
    if (POLL_PATH.test(pathname)) {
      return POLL_ROUTE_KEY;
    }
    const matched = matchConsoleRoute(pathname);
    return matched === null ? null : matched.route.key;
  }

  /**
   * Call a console handler by name, failing closed if the daemon was assembled
   * without it (a caller composing the API with only the original handlers).
   *
   * @param {string} name Handler name.
   * @param {object} ctx Request context.
   * @returns {Promise<unknown>} Handler result.
   */
  function invoke(name, ctx) {
    const handler = handlers[name];
    if (typeof handler !== 'function') {
      throw new DaemonError(DAEMON_CODES.INTERNAL, 'console endpoint is not wired');
    }
    return handler(ctx);
  }

  /**
   * Dispatch one console route. Method mismatches are 405 (not 404): the path exists
   * and the console needs to know which verbs it supports.
   *
   * @param {{route: object, params: object}} matched Route match.
   * @param {{req: object, res: object, method: string, bodyBuffer: Buffer|null, deadline: object|null}} ctx Request context.
   * @returns {Promise<void>} Resolves once the response was written or handed to an SSE handler.
   */
  async function dispatchConsole(matched, ctx) {
    const { route, params } = matched;
    const { method, res } = ctx;
    if (!route.methods.includes(method)) {
      return reject(res, DAEMON_CODES.METHOD_NOT_ALLOWED, 'method is not supported for this endpoint');
    }
    const base = {
      method,
      res,
      req: ctx.req,
      params,
      securityHeaders: SECURITY_HEADERS,
      deadline: ctx.deadline,
    };
    switch (route.key) {
      case '/api/v1/models': {
        return sendJson(res, 200, await invoke('getModels', base));
      }
      case '/api/v1/models/:providerId/test': {
        return sendJson(res, 200, await invoke('testProvider', base));
      }
      case '/api/v1/credentials/:providerId': {
        if (method === 'PUT') {
          const body = parseJsonBody(ctx.bodyBuffer, {
            code: 'CREDENTIAL_INVALID',
            label: 'credential update',
          });
          const result = await invoke('putCredential', { ...base, body });
          return result === null ? sendNoContent(res) : sendJson(res, 200, result);
        }
        const result = await invoke('deleteCredential', base);
        return result === null ? sendNoContent(res) : sendJson(res, 200, result);
      }
      case '/api/v1/agent/chat': {
        const body = parseJsonBody(ctx.bodyBuffer, { code: 'CHAT_INVALID', label: 'chat request' });
        await invoke('chat', { ...base, body });
        return undefined;
      }
      case '/api/v1/agent/approval': {
        const body = parseJsonBody(ctx.bodyBuffer, { code: 'CHAT_INVALID', label: 'approval request' });
        return sendJson(res, 200, await invoke('approval', { ...base, body }));
      }
      case '/api/v1/alerts/:id/explain': {
        const body = parseJsonBody(ctx.bodyBuffer, {
          code: 'CHAT_INVALID',
          label: 'explain request',
          optional: true,
        });
        await invoke('explain', { ...base, body });
        return undefined;
      }
      case '/api/v1/settings': {
        if (method === 'GET') {
          return sendJson(res, 200, await invoke('getSettings', base));
        }
        const body = parseJsonBody(ctx.bodyBuffer, { code: 'SETTINGS_INVALID', label: 'settings update' });
        return sendJson(res, 200, await invoke('putSettings', { ...base, body }));
      }
      case '/api/v1/settings/schema': {
        return sendJson(res, 200, await invoke('getSettingsSchema', base));
      }
      case '/api/v1/diagnostics/bundle': {
        // The body is optional and never trusted: the handler reads the daemon's own
        // state. A malformed body is still a caller fault (400), not a quiet success.
        parseJsonBody(ctx.bodyBuffer, {
          code: 'DIAGNOSTICS_INVALID',
          label: 'diagnostics export',
          optional: true,
        });
        return sendAttachment(res, await invoke('exportDiagnosticsBundle', base));
      }
      case '/api/v1/diagnostics/token-rotate': {
        parseJsonBody(ctx.bodyBuffer, {
          code: 'DIAGNOSTICS_INVALID',
          label: 'token rotation',
          optional: true,
        });
        // The new token appears in this response and nowhere else: it is not logged,
        // not written to /status and not cached (all responses are `no-store`).
        return sendJson(res, 200, await invoke('rotateApiToken', base));
      }
      default: {
        return reject(res, DAEMON_CODES.NOT_FOUND, 'no such endpoint');
      }
    }
  }

  async function dispatch(req, res) {
    const peer = req.socket?.remoteAddress;
    if (!isLoopbackPeer(peer)) {
      return reject(res, DAEMON_CODES.PEER_REJECTED, 'peer is not a loopback address');
    }
    if (boundPort === null) {
      return reject(res, DAEMON_CODES.INTERNAL, 'server is not listening');
    }
    if (!isAllowedHost(req.headers.host, boundPort)) {
      return reject(res, DAEMON_CODES.HOST_REJECTED, 'Host header is not the loopback endpoint');
    }

    const method = req.method ?? 'GET';
    let url;
    try {
      url = new URL(req.url ?? '/', urlBase);
    } catch {
      return reject(res, DAEMON_CODES.NOT_FOUND, 'malformed request target');
    }
    const pathname = url.pathname;
    // Only known routes get a named bucket. An unknown path is attacker-controlled
    // text; keeping a map keyed by it would let any local process grow the map
    // without bound before authentication ever runs.
    const bucket = bucketFor(pathname);
    if (bucket === null) {
      stats.unknown_paths += 1;
    } else {
      stats.by_path[bucket] = (stats.by_path[bucket] ?? 0) + 1;
    }

    const matched = matchConsoleRoute(pathname);
    // The gate accepts PUT/DELETE only where a console route declares them; every
    // other path keeps the original "GET or POST only" rule, before authentication.
    const routeAllowsMethod = matched !== null && matched.route.methods.includes(method);
    if (method !== 'GET' && method !== 'POST') {
      if (!routeAllowsMethod) {
        return reject(res, DAEMON_CODES.METHOD_NOT_ALLOWED, 'method is not supported');
      }
    }

    // Public liveness/readiness: no counters, no identifiers, no auth material.
    if (pathname === '/healthz') {
      if (method !== 'GET') {
        return reject(res, DAEMON_CODES.METHOD_NOT_ALLOWED, 'healthz is read-only');
      }
      const health = handlers.health();
      return sendJson(res, health.status === 'failed' ? 503 : 200, {
        status: health.status,
        version: health.version,
      });
    }
    if (pathname === '/readyz') {
      if (method !== 'GET') {
        return reject(res, DAEMON_CODES.METHOD_NOT_ALLOWED, 'readyz is read-only');
      }
      const ready = handlers.ready();
      return sendJson(res, ready.ready ? 200 : 503, ready.body);
    }

    if (!pathname.startsWith('/api/v1/')) {
      return reject(res, DAEMON_CODES.NOT_FOUND, 'no such endpoint');
    }

    const decision = auth.authenticate(req.headers.authorization, peer ?? 'unknown');
    if (!decision.ok) {
      const code = decision.code ?? DAEMON_CODES.AUTH_FAILED;
      stats.rejected += 1;
      stats.auth_denied += 1;
      return sendError(res, code, 'authentication required', undefined, authFailureWindowMs / 1000);
    }

    const stateChanging = method !== 'GET';
    let bodyBuffer = null;
    if (stateChanging) {
      if (!isAllowedOrigin(req.headers.origin, boundPort)) {
        return reject(res, DAEMON_CODES.ORIGIN_REJECTED, 'Origin is not the loopback endpoint');
      }
      const csrf = auth.authorize(req.headers[CSRF_HEADER]);
      if (!csrf.ok) {
        return reject(res, csrf.code ?? DAEMON_CODES.CSRF_REQUIRED, `header ${CSRF_HEADER} is required`);
      }
      const declared = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        stats.too_large += 1;
        // The body will not be read to the end, so this connection cannot be reused.
        res.shouldKeepAlive = false;
        return reject(res, DAEMON_CODES.BODY_TOO_LARGE, 'request body exceeds the configured limit', {
          limit_bytes: maxBodyBytes,
        });
      }
      const contentType = req.headers['content-type'];
      if (declared > 0 && (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json'))) {
        return reject(res, DAEMON_CODES.CONTENT_TYPE_REJECTED, 'request body must be application/json');
      }
      try {
        bodyBuffer = await readBody(req, maxBodyBytes);
      } catch (error) {
        if (isDaemonError(error) && error.code === DAEMON_CODES.BODY_TOO_LARGE) {
          stats.too_large += 1;
          res.shouldKeepAlive = false;
        }
        throw error;
      }
    }

    if (pathname === '/api/v1/status') {
      if (method !== 'GET') {
        return reject(res, DAEMON_CODES.METHOD_NOT_ALLOWED, 'status is read-only');
      }
      const payload = handlers.status();
      return sendJson(res, 200, { ...payload, csrf_token: auth.csrfToken });
    }

    // Read-only query endpoints. They are listed explicitly instead of being matched
    // by a shared prefix so a future write route cannot inherit their admission.
    if (pathname === '/api/v1/alerts' || pathname === '/api/v1/analysis') {
      if (method !== 'GET') {
        return reject(res, DAEMON_CODES.METHOD_NOT_ALLOWED, 'query endpoints are read-only');
      }
      const handler = pathname === '/api/v1/alerts' ? handlers.listAlerts : handlers.listAnalyses;
      // A caller composing the API with only the original handlers must get a
      // refusal, not a TypeError that the outer catch would report as a fault.
      if (typeof handler !== 'function') {
        return reject(res, DAEMON_CODES.INTERNAL, 'query endpoint is not wired');
      }
      const payload = await handler(url.searchParams);
      return sendJson(res, 200, payload);
    }

    const poll = /^\/api\/v1\/collectors\/([A-Za-z0-9._:-]{1,128})\/poll$/u.exec(pathname);
    if (poll !== null) {
      if (method !== 'POST') {
        return reject(res, DAEMON_CODES.METHOD_NOT_ALLOWED, 'poll requires POST');
      }
      const result = await handlers.pollSource(poll[1]);
      return sendJson(res, 200, { source: result });
    }

    if (matched !== null) {
      // SSE routes own their own timers (§3.5); this context lets the handler see a
      // header-deadline expiry that happened while it was awaiting the child.
      const deadline = matched.route.sse === true ? { exceeded: false } : null;
      if (deadline !== null) {
        installSseHeaderDeadline(res, deadline);
      }
      return dispatchConsole(matched, {
        req,
        res,
        method,
        bodyBuffer,
        deadline,
      });
    }

    return reject(res, DAEMON_CODES.NOT_FOUND, 'no such endpoint');
  }

  async function startBound() {
    const instance = http.createServer((req, res) => {
      stats.requests += 1;
      let isSse = false;
      try {
        const matchedOnStart = matchConsoleRoute(new URL(req.url ?? '/', urlBase).pathname);
        isSse = matchedOnStart !== null && matchedOnStart.route.sse === true;
      } catch {
        // A malformed target is refused by `dispatch` with a JSON 404; the request
        // deadline applies because no SSE stream can start from it.
        isSse = false;
      }
      // SSE routes are exempt from the plain request deadline (contract §3.5): they
      // run for minutes by design. Their header deadline is installed by `dispatch`
      // below, and their idle/total limits live in sse.js.
      const deadline = isSse ? null : setTimeout(() => {
        if (res.writableEnded) {
          return;
        }
        stats.timeouts += 1;
        sendError(res, DAEMON_CODES.REQUEST_TIMEOUT, 'request handling exceeded its deadline');
        res.destroy();
      }, requestTimeoutMs);
      deadline?.unref?.();
      if (deadline !== null) {
        res.on('close', () => clearTimeout(deadline));
        res.on('finish', () => clearTimeout(deadline));
      }

      dispatch(req, res).catch((error) => {
        // API-layer errors are caller faults with their own vocabulary; they must
        // not reach the `isDaemonError` branch (which owns daemon codes) nor the
        // 500 fallback, which would report a bad `?limit=` as a server fault.
        if (isConsoleError(error)) {
          // Direct render (not `reject`) so a retry-after can be set *before* the
          // headers are written: `reject` has no slot for it.
          stats.rejected += 1;
          sendError(res, error.code, error.message, error.details, error.retryAfterSeconds);
          return;
        }
        if (isApiError(error)) {
          reject(res, error.code, error.message, error.details);
          return;
        }
        if (isDaemonError(error)) {
          reject(res, error.code, error.message, error.details);
          return;
        }
        logger?.error?.('control API handler fault', { reason: error?.code ?? 'UNHANDLED' });
        sendError(res, DAEMON_CODES.INTERNAL, 'internal error');
      });
    });

    instance.headersTimeout = config.headersTimeoutMs;
    instance.requestTimeout = config.requestTimeoutMs;
    instance.keepAliveTimeout = config.keepAliveTimeoutMs;
    instance.maxHeadersCount = 64;

    instance.on('clientError', (error, socket) => {
      if (!socket.writable) {
        socket.destroy();
        return;
      }
      const body = `${JSON.stringify({ error: { code: 'MALFORMED_REQUEST', message: 'malformed request' } })}\n`;
      const headerLines = Object.entries(SECURITY_HEADERS)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
      socket.end(
        `HTTP/1.1 400 Bad Request\r\ncontent-type: application/json; charset=utf-8\r\n`
        + `content-length: ${Buffer.byteLength(body)}\r\n${headerLines}connection: close\r\n\r\n${body}`,
      );
      logger?.warn?.('control API client error', { reason: error?.code ?? 'CLIENT_ERROR' });
    });

    await new Promise((resolve, reject) => {
      instance.once('error', (error) => {
        reject(new DaemonError(DAEMON_CODES.INTERNAL, 'control API could not bind', {
          reason: error?.code ?? 'BIND_FAILED',
        }));
      });
      instance.listen(configuredPort, host, () => resolve());
    });

    const address = instance.address();
    boundPort = typeof address === 'object' && address !== null ? address.port : configuredPort;
    // A listener that resolved to something other than the configured loopback
    // address is not the endpoint we promised to expose.
    if (typeof address === 'object' && address !== null && address.address !== host) {
      instance.close();
      boundPort = null;
      throw new DaemonError(DAEMON_CODES.CONFIG_NOT_LOOPBACK, 'control API bound an unexpected address', {
        address: address.address,
      });
    }
    if (closed) {
      // `close()` ran while the bind was in flight: nothing will ever close this
      // listener again, so close it here instead of leaking a socket that keeps the
      // process alive after a reported clean shutdown.
      boundPort = null;
      await new Promise((resolve) => {
        instance.close(() => resolve());
        instance.closeAllConnections?.();
      });
      throw new DaemonError(DAEMON_CODES.LIFECYCLE_NOT_RUNNING, 'control API was closed while starting');
    }
    server = instance;
    return { host, port: boundPort };
  }

  /**
   * Install the 8 s SSE header deadline for a stream route.
   *
   * The handler may be waiting on the child; if it cannot start the stream in time,
   * the client gets a JSON 503 rather than a request that looks hung. The context
   * flag lets the handler notice and abandon its own work.
   *
   * @param {object} res Response.
   * @param {{exceeded: boolean}} context Deadline context owned by the handler.
   * @returns {{clear: () => void}} Timer handle.
   */
  function installSseHeaderDeadline(res, context) {
    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) {
        return;
      }
      context.exceeded = true;
      res.shouldKeepAlive = false;
      sendError(res, 'ENGINE_UNAVAILABLE', 'model stream did not start in time', {
        reason: 'SSE_HEADER_DEADLINE',
        deadline_ms: SSE_HEADER_DEADLINE_MS,
      });
    }, SSE_HEADER_DEADLINE_MS);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    res.on('close', clear);
    res.on('finish', clear);
    return { clear };
  }

  const handle = {
    /** Bind and start listening. */
    async start() {
      if (closed) {
        throw new DaemonError(DAEMON_CODES.LIFECYCLE_NOT_RUNNING, 'control API was closed before it started');
      }
      if (server !== null) {
        throw new DaemonError(DAEMON_CODES.LIFECYCLE_ALREADY_STARTED, 'control API is already listening');
      }
      if (startPromise !== null) {
        // A concurrent caller shares the in-flight bind instead of binding a second
        // listener that close() could never reach. Once listening, the check above wins
        // so a double start still fails loudly.
        return startPromise;
      }
      startPromise = startBound().catch((error) => {
        startPromise = null;
        throw error;
      });
      return startPromise;
    },

    /** Stop accepting connections and drain. */
    async close() {
      closed = true;
      if (server === null) {
        return;
      }
      const instance = server;
      server = null;
      boundPort = null;
      await new Promise((resolve) => {
        instance.close(() => resolve());
        instance.closeAllConnections?.();
      });
    },

    address() {
      return { host, port: boundPort };
    },

    stats: () => ({ ...stats, by_path: { ...stats.by_path } }),

    /** Test/diagnostic hook: install the SSE header deadline on a response. */
    installSseHeaderDeadline,
  };
  return handle;
}
