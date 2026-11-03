/**
 * api/server.js — the loopback-only control API.
 *
 * Scope, deliberately narrow: health, readiness, status, two read-only queries
 * (`/api/v1/alerts`, `/api/v1/analysis`) and an explicit "poll this source now"
 * command. There is no endpoint to read telemetry, approve anything, dispatch a
 * response, change policy or run a command. Those belong to other components with
 * their own authority; adding one here would make the daemon a second policy gate.
 *
 * Admission order matters and is fixed:
 *
 * ```
 * peer is loopback → Host is the loopback endpoint → method is allowed →
 * bearer token → (state-changing) Origin + CSRF → body size/type → handler
 * ```
 *
 * Each step can only reject; none of them can be skipped by a later one. The body
 * limit is enforced twice (declared `Content-Length` and streamed bytes) because a
 * declared length is a lie an attacker controls.
 *
 * Every rejection is a JSON object with a stable `code`, no stack trace and no
 * host path. Unknown methods and paths are refused the same way — there is no
 * directory listing, no HTML, and no reflection of the request into the response.
 */

import http from 'node:http';

import { DaemonError, DAEMON_CODES, isDaemonError } from '../errors.js';
import { CSRF_HEADER, isAllowedHost, isAllowedOrigin } from './auth.js';
import { API_STATUS_BY_CODE, isApiError } from './errors.js';

/**
 * Status code for each daemon code the API can surface.
 *
 * The API layer's own 400s are merged in rather than kept in a second lookup: one
 * table means the error renderer cannot accidentally treat a caller fault as a
 * server fault.
 */
const STATUS_BY_CODE = Object.freeze({
  ...API_STATUS_BY_CODE,
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

/** Routes that get a named bucket in the request tally. */
const KNOWN_ROUTES = new Set(['/healthz', '/readyz', '/api/v1/status', '/api/v1/alerts', '/api/v1/analysis']);

/** The only parameterised route. */
const POLL_PATH = /^\/api\/v1\/collectors\/[A-Za-z0-9._:-]{1,128}\/poll$/u;

/** Bucket name for the parameterised route: the id is caller-controlled, the key is not. */
const POLL_ROUTE_KEY = '/api/v1/collectors/:id/poll';

const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
});

/**
 * Report whether a socket peer address is a loopback address.
 *
 * `::ffff:127.0.0.1` is how an IPv4 connection looks on a dual-stack listener, so
 * it is accepted explicitly rather than by string prefix matching.
 *
 * @param {string|undefined} address Socket peer address.
 * @returns {boolean} `true` for a loopback peer.
 */
export function isLoopbackPeer(address) {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
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

function sendError(res, code, message, details, retryAfterSeconds) {
  const status = statusFor(code);
  const headers = code === DAEMON_CODES.AUTH_REQUIRED || code === DAEMON_CODES.AUTH_FAILED
    ? { 'www-authenticate': 'Bearer realm="aegis-daemon"' }
    : {};
  if (code === DAEMON_CODES.AUTH_RATE_LIMITED) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSeconds ?? 60)));
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
 *     listAnalyses?: (searchParams: URLSearchParams) => Promise<object>
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
  const requestTimeoutMs = config.requestTimeoutMs;
  const maxBodyBytes = config.maxBodyBytes;

  const stats = { requests: 0, rejected: 0, timeouts: 0, too_large: 0, by_path: {}, unknown_paths: 0 };
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
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      return reject(res, DAEMON_CODES.NOT_FOUND, 'malformed request target');
    }
    const pathname = url.pathname;
    // Only known routes get a named bucket. An unknown path is attacker-controlled
    // text; keeping a map keyed by it would let any local process grow the map
    // without bound before authentication ever runs.
    const bucket = KNOWN_ROUTES.has(pathname) ? pathname : (POLL_PATH.test(pathname) ? POLL_ROUTE_KEY : null);
    if (bucket === null) {
      stats.unknown_paths += 1;
    } else {
      stats.by_path[bucket] = (stats.by_path[bucket] ?? 0) + 1;
    }

    if (method !== 'GET' && method !== 'POST') {
      return reject(res, DAEMON_CODES.METHOD_NOT_ALLOWED, 'method is not supported');
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
      return sendError(res, code, 'authentication required', undefined, authFailureWindowMs / 1000);
    }

    const stateChanging = method !== 'GET';
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
        await readBody(req, maxBodyBytes);
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

    return reject(res, DAEMON_CODES.NOT_FOUND, 'no such endpoint');
  }

  async function startBound() {
      const instance = http.createServer((req, res) => {
        stats.requests += 1;
        const deadline = setTimeout(() => {
          if (res.writableEnded) {
            return;
          }
          stats.timeouts += 1;
          sendError(res, DAEMON_CODES.REQUEST_TIMEOUT, 'request handling exceeded its deadline');
          res.destroy();
        }, requestTimeoutMs);
        deadline.unref?.();
        res.on('close', () => clearTimeout(deadline));
        res.on('finish', () => clearTimeout(deadline));

        dispatch(req, res).catch((error) => {
          // API-layer errors are caller faults with their own vocabulary; they must
          // not reach the `isDaemonError` branch (which owns daemon codes) nor the
          // 500 fallback, which would report a bad `?limit=` as a server fault.
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
  };
  return handle;
}
