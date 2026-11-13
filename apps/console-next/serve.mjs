#!/usr/bin/env node
/**
 * serve.mjs — the AIDriven NetDefense console host (author PT-dove).
 *
 * What it is: the same-origin half of the WebUI v2 topology. It serves the
 * console files that sit next to it and forwards `/healthz`, `/readyz` and
 * `/api/v1/*` to the daemon. The browser never sees a credential: this process
 * holds the daemon token, injects `authorization: Bearer <token>` and the CSRF
 * proof derived from it, and strips anything the browser could use to confuse
 * the daemon's own admission rules (`origin`, `referer`, `cookie`, and the
 * console marker header it validated itself).
 *
 * Why it exists instead of the daemon serving the files: the daemon's token
 * must not be readable by page scripts, and a static file server inside the
 * control API would be a much larger surface than a 400-line host with an
 * extension allowlist.
 *
 * Refusals that are deliberate:
 * - binds a loopback literal only; a non-loopback `--host` is refused with exit
 *   code 2 (the packaging contract `tests/packaging/v14-bundle.test.js` pins
 *   that code and the phrase "loopback-only"), never silently downgraded;
 * - every accepted connection must come from a loopback peer;
 * - static paths are decoded, must stay inside this directory, may not contain
 *   a dot segment (dotfiles and `..`), must name a regular file inside the
 *   extension allowlist, and directories are 404 rather than listed;
 * - `.mjs` is not in the allowlist, so this file cannot serve itself;
 * - `HEAD` is answered for static files only; proxy methods are
 *   GET/POST/PUT/DELETE, everything else is 405 (no OPTIONS, no CORS);
 * - it never opens a browser itself. Printing a URL is a message; launching a
 *   window the user did not ask for is not.
 *
 * Browser-side write protection: a cross-origin HTML form can issue a simple
 * POST to a loopback server, but it cannot add a custom header. Every
 * POST/PUT/DELETE on a proxied route must therefore carry `x-console-v2: 1`,
 * which is validated here and *not* forwarded upstream.
 *
 * Streaming: `/api/v1/agent/chat` and `/api/v1/alerts/:id/explain` are proxied
 * without a body timeout, without buffering, without `content-length`, and with
 * the upstream content type passed through; when the client goes away the
 * upstream request is destroyed so the daemon sees the abort (contract §3.4).
 *
 * usage:
 *   node console-next/serve.mjs --daemon http://127.0.0.1:7345
 *        [--token <t> | --token-file <path>] [--host 127.0.0.1] [--port 0]
 *        [--verbose]
 *
 * Nothing in this file logs, prints or returns the daemon token.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Directory holding this file; also the static root. */
export const HERE = dirname(fileURLToPath(import.meta.url));

/** Loopback hostnames this host may bind or proxy to. */
export const LOOPBACK_HOSTNAMES = Object.freeze(['127.0.0.1', '::1', 'localhost']);

/** Content types for the static extension allowlist (`.mjs` is deliberately absent). */
export const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/**
 * Response headers applied to every answer (static, proxy, error and stream).
 *
 * The CSP is the contract's §7.9/§7.1 shape: modules come from the same origin
 * (`script-src 'self'` is enough for `<script type="module" src="js/app.js">`),
 * styles may be inline because the design system sets CSS variables, and the
 * frame/object/base/form directives are closed so a compromised page cannot
 * navigate or submit anywhere.
 */
export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
    + "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

/** Maximum request body forwarded to the daemon (contract §2.1 conversation truth is smaller). */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/** Timeout for ordinary proxied requests. SSE routes are explicitly exempt (contract §3.5). */
export const PROXY_TIMEOUT_MS = 10_000;

/** Browser-side write marker. A cross-origin form cannot set this header. */
export const CONSOLE_HEADER = 'x-console-v2';
export const CONSOLE_HEADER_VALUE = '1';

/** CSRF header the daemon expects on state-changing requests. */
export const CSRF_HEADER = 'x-aegis-csrf';

/** Methods forwarded to the daemon. */
export const PROXY_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'DELETE']);
export const WRITE_METHODS = Object.freeze(['POST', 'PUT', 'DELETE']);

/** Exact proxy paths and the prefix that covers the versioned API. */
export const PROXY_EXACT = Object.freeze(['/healthz', '/readyz']);
export const API_PREFIX = '/api/v1/';

/** The two streaming routes (contract §2.5, §2.6). */
export const STREAM_ROUTE_PATTERNS = Object.freeze([
  /^\/api\/v1\/agent\/chat$/u,
  /^\/api\/v1\/alerts\/[^/]+\/explain$/u,
]);

/** Hop-by-hop headers that must not be copied across the proxy boundary. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * Request headers the browser may send but the daemon must not hear.
 *
 * `origin`/`referer`/`cookie` are removed because the daemon's origin rule is
 * written for a browser that talks to it directly; a console page on
 * `http://127.0.0.1:<consolePort>` is a *different* origin from the daemon and
 * would be refused. The host satisfies the daemon's "missing Origin is fine,
 * non-loopback Origin is not" rule by making it missing.
 *
 * `authorization`/`x-aegis-csrf` are removed so a page cannot inject its own —
 * the values below are the only ones that reach the daemon. `x-console-v2` is
 * the host's own marker and stops here.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'cookie', 'authorization', 'x-aegis-csrf', 'x-console-v2',
  ...HOP_BY_HOP, 'expect', 'proxy-connection',
]);

const USAGE = 'usage: node console-next/serve.mjs --daemon <http://127.0.0.1:port>\n'
  + '       [--token <token> | --token-file <path>] [--host 127.0.0.1] [--port 0] [--verbose]\n'
  + '\n'
  + 'Serves the files next to this script on loopback and proxies /healthz, /readyz and\n'
  + '/api/v1/* to the daemon, injecting the bearer token and the CSRF proof. It never\n'
  + 'opens a browser and never prints the token.\n';

/**
 * Whether a socket peer address is a loopback address.
 *
 * Dual-stack sockets report IPv4 peers as `::ffff:127.0.0.1`, which is still the
 * loopback interface and must be accepted.
 *
 * @param {string|undefined} address `socket.remoteAddress`.
 * @returns {boolean} `true` for 127.0.0.1 and ::1, in either spelling.
 */
export function isLoopbackPeer(address) {
  if (typeof address !== 'string') return false;
  const bare = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  return bare === '127.0.0.1' || bare === '::1';
}

/**
 * Whether a hostname is one this process is allowed to bind or dial.
 *
 * @param {string|undefined} hostname Host without brackets.
 * @returns {boolean} `true` for the three loopback spellings.
 */
export function isLoopbackHostname(hostname) {
  return typeof hostname === 'string' && LOOPBACK_HOSTNAMES.includes(hostname);
}

/**
 * The CSRF value the daemon derives from its token.
 *
 * Kept as a function (not a constant) so the derivation lives in exactly one
 * place and matches `apps/daemon/src/api/auth.js` `createAuthGuard()`:
 * `base64url(sha256("aegis-csrf:" + token))`.
 *
 * @param {string} token Provisioned daemon token.
 * @returns {string} CSRF proof.
 */
export function csrfFor(token) {
  return createHash('sha256').update(`aegis-csrf:${token}`, 'utf8').digest('base64url');
}

/**
 * Resolve a request path to a servable file inside `root`.
 *
 * @param {string} root Static root (this file's directory).
 * @param {string} pathname Raw `req.url` path component.
 * @returns {{file: string, size: number, type: string}|undefined} Target, or
 *   `undefined` when the request must be answered with 404.
 */
export function staticTargetFor(root, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return undefined;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  // A NUL would truncate a path inside libuv; a backslash is a separator on
  // Windows and could smuggle a traversal past the POSIX-style split below.
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const segments = decoded.split('/').filter((segment) => segment !== '');
  // `..` is a dot segment; every dotfile is refused by the same rule.
  if (segments.some((segment) => segment.startsWith('.'))) return undefined;
  const relative = segments.length === 0 ? 'index.html' : segments.join('/');
  const absolute = resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + sep)) return undefined;
  if (!existsSync(absolute)) return undefined;
  const info = statSync(absolute);
  // Directories are not listed and not indexed; anything but a regular file is 404.
  if (!info.isFile()) return undefined;
  const type = STATIC_TYPES.get(extname(absolute).toLowerCase());
  if (type === undefined) return undefined;
  return { file: absolute, size: info.size, type };
}

/**
 * Parse and validate the command line.
 *
 * @param {string[]} argv Arguments after the script path.
 * @param {Record<string, string|undefined>} env Environment (for the packaging-compatible fallbacks).
 * @returns {{help?: boolean, daemon: object, token: string, tokenFile?: string, host: string,
 *   port: number, verbose: boolean}} Parsed options, or `{help: true}`.
 * @throws {Error} On any invalid or unsafe option.
 */
export function parseOptions(argv, env = {}) {
  const options = {
    daemon: env.AEGIS_DAEMON_URL ?? 'http://127.0.0.1:7345',
    token: env.AEGIS_CONSOLE_TOKEN ?? '',
    tokenFile: undefined,
    tokenFromCli: false,
    host: '127.0.0.1',
    port: 0,
    verbose: false,
    help: false,
  };
  const value = (index, flag) => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--daemon') options.daemon = value(++index, '--daemon');
    else if (argument === '--token') {
      options.token = value(++index, '--token');
      options.tokenFromCli = true;
    } else if (argument === '--token-file') options.tokenFile = value(++index, '--token-file');
    else if (argument === '--host') options.host = value(++index, '--host');
    else if (argument === '--port') options.port = Number(value(++index, '--port'));
    else if (argument === '--verbose') options.verbose = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!isLoopbackHostname(options.host)) {
    throw new Error(`refusing to bind ${options.host}: this console host is loopback-only`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('--port must be an integer 0..65535');
  }
  // An explicit --token-file replaces an ambient AEGIS_CONSOLE_TOKEN; only two
  // command-line credentials are contradictory.
  if (options.tokenFromCli && options.tokenFile !== undefined) {
    throw new Error('use either --token or --token-file, not both');
  }
  if (options.tokenFile !== undefined) options.token = '';
  if (options.token !== '') assertHeaderSafeToken(options.token, '--token');
  options.daemon = parseDaemon(options.daemon);
  return options;
}

/**
 * Validate `--daemon` into an endpoint description.
 *
 * @param {string} raw Daemon origin.
 * @returns {{protocol: string, hostname: string, port: number, origin: string, hostHeader: string,
 *   url: URL}} Endpoint.
 * @throws {Error} When the URL is malformed, non-http(s), non-loopback, or carries a path/query.
 */
export function parseDaemon(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--daemon is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--daemon must be http(s)');
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (!isLoopbackHostname(hostname)) throw new Error(`refusing to proxy to a non-loopback daemon: ${hostname}`);
  if (url.username !== '' || url.password !== '') throw new Error('--daemon must not carry credentials');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('--daemon must be an origin, not a path');
  if (url.search !== '' || url.hash !== '') throw new Error('--daemon must be an origin, not a query');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  // The daemon accepts a Host header naming a loopback *literal* and its own
  // port (auth.js `isAllowedHost`). `localhost` is a legal --daemon spelling but
  // not a legal Host value, so it is sent as 127.0.0.1.
  const literal = hostname === '::1' ? '[::1]' : (hostname === 'localhost' ? '127.0.0.1' : hostname);
  return {
    protocol: url.protocol,
    hostname,
    port,
    origin: `${url.protocol}//${literal}:${port}`,
    hostHeader: `${literal}:${port}`,
    url,
  };
}

/**
 * Read and trim a token file written by the daemon (mode 0600 on POSIX).
 *
 * @param {string} file Path to the token file.
 * @returns {string} Trimmed token.
 * @throws {Error} When unreadable, empty, or not representable as a header value.
 */
export function readTokenFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`--token-file is not readable: ${file} (${error?.code ?? 'UNREADABLE'})`);
  }
  const token = text.trim();
  if (token === '') throw new Error(`--token-file is empty: ${file}`);
  assertHeaderSafeToken(token, '--token-file');
  return token;
}

/**
 * Reject a token that cannot be sent as a single header value.
 *
 * @param {string} token Candidate token.
 * @param {string} source Option name, for the message only.
 * @returns {void}
 * @throws {Error} When the token could inject a header or is implausibly long.
 */
function assertHeaderSafeToken(token, source) {
  if (token.length > 512 || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new Error(`${source} contains characters that cannot be sent in a header`);
  }
}

/** Stop the process with a one-line diagnostic on stderr. */
function fail(message, code) {
  process.stderr.write(`console-host: ${message}\n`);
  process.exit(code);
}

/**
 * Answer with the contract's JSON error envelope and the security headers.
 *
 * @param {import('node:http').ServerResponse} res Response.
 * @param {number} status HTTP status.
 * @param {string} code Stable code.
 * @param {string} message English, path-free message.
 * @param {Record<string, string>} [extra] Additional headers.
 * @returns {void}
 */
function sendJson(res, status, code, message, extra = {}) {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Request headers for the upstream daemon.
 *
 * @param {import('node:http').IncomingMessage} req Browser request.
 * @param {object} config Resolved host configuration.
 * @param {boolean} streaming Whether this is a streaming route.
 * @returns {Record<string, string|string[]>} Upstream headers.
 */
function upstreamHeaders(req, config, streaming) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  headers.host = config.daemon.hostHeader;
  if (config.token !== '') headers.authorization = `Bearer ${config.token}`;
  if (config.token !== '' && WRITE_METHODS.includes(req.method)) headers[CSRF_HEADER] = config.csrf;
  if (streaming) {
    // A compressed stream is a buffered stream at some intermediary; byte-for-byte
    // SSE is only safe uncompressed.
    headers['accept-encoding'] = 'identity';
  }
  return headers;
}

/**
 * Response headers for the browser.
 *
 * @param {import('node:http').IncomingMessage} reply Upstream response.
 * @param {boolean} streaming Whether this is a streaming route.
 * @returns {Record<string, string|string[]>} Browser headers.
 */
function responseHeaders(reply, streaming) {
  const headers = {};
  for (const [name, value] of Object.entries(reply.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (streaming && name === 'content-length') continue;
    headers[name] = value;
  }
  if (headers['content-type'] === undefined) {
    headers['content-type'] = streaming
      ? 'text/event-stream; charset=utf-8'
      : 'application/json; charset=utf-8';
  }
  // Applied last: the console's own security posture is not negotiable by an
  // upstream header.
  return { ...headers, ...SECURITY_HEADERS };
}

/**
 * Whether the pathname is one of the two streaming routes.
 *
 * @param {string} pathname Request path without query.
 * @returns {boolean} `true` for chat/explain.
 */
function isStreamRoute(pathname) {
  if (typeof pathname !== 'string') return false;
  return STREAM_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

/**
 * Proxy one request to the daemon.
 *
 * @param {import('node:http').IncomingMessage} req Browser request.
 * @param {import('node:http').ServerResponse} res Browser response.
 * @param {object} config Resolved host configuration.
 * @returns {void}
 */
function proxy(req, res, config) {
  const streaming = isStreamRoute(pathnameOf(req.url));
  let reply = null;
  let settled = false;
  let timedOut = false;

  /** Fail once, before any header has been written. */
  const failOnce = (status, code, message, extra = {}) => {
    if (settled || res.headersSent) return;
    settled = true;
    sendJson(res, status, code, message, extra);
  };

  const upstream = httpRequest({
    protocol: config.daemon.protocol,
    hostname: config.daemon.hostname,
    port: config.daemon.port,
    path: req.url,
    method: req.method,
    headers: upstreamHeaders(req, config, streaming),
    agent: false,
    ...(streaming ? {} : { timeout: config.proxyTimeoutMs }),
  }, (upstreamReply) => {
    reply = upstreamReply;
    res.writeHead(upstreamReply.statusCode ?? 502, responseHeaders(upstreamReply, streaming));
    if (streaming) {
      // Contract §3.5: no buffering, no length, no idle timeout. The socket keeps
      // its default timeout off so a quiet model turn is not mistaken for a hang;
      // the daemon owns SSE_IDLE_MS/SSE_TOTAL_MS.
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      res.socket?.setTimeout(0);
      res.setTimeout(0);
    }
    upstreamReply.on('error', () => res.destroy());
    upstreamReply.on('aborted', () => res.destroy());
    upstreamReply.pipe(res);
  });

  if (!streaming) {
    upstream.on('timeout', () => {
      timedOut = true;
      upstream.destroy(new Error('daemon timeout'));
    });
  }
  upstream.on('error', () => {
    if (reply !== null) {
      // Headers already went out; the only honest signal left is a torn stream.
      res.destroy();
      return;
    }
    if (timedOut) failOnce(504, 'DAEMON_TIMEOUT', 'daemon did not answer in time');
    else failOnce(502, 'DAEMON_UNREACHABLE', 'daemon is not reachable');
  });

  // The browser can abandon a request while we wait for headers, or mid-stream.
  // Either way the upstream request must be destroyed: the daemon turns that into
  // `chat.aborted` and releases the quota (contract §3.4).
  res.on('close', () => {
    if (res.writableEnded) return;
    if (reply !== null) reply.destroy();
    upstream.destroy();
  });
  // An aborted browser connection can surface as an error on either stream. Left
  // unhandled it would take the whole host down, which is exactly what an
  // unattended console must not do.
  req.on('error', () => { upstream.destroy(); });
  res.on('error', () => {
    if (reply !== null) reply.destroy();
    upstream.destroy();
  });

  // Body handling: `content-length` is checked eagerly, chunked bodies are counted
  // while they stream, and forwarding stops the moment the cap is crossed. The
  // leftovers are drained rather than the socket being torn down, so the client
  // actually reads the 413 instead of an RST.
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > config.bodyLimitBytes) {
    failOnce(413, 'BODY_TOO_LARGE', 'request body exceeds the console host limit', { connection: 'close' });
    upstream.destroy();
    req.resume();
    return;
  }
  let received = 0;
  req.on('data', (chunk) => {
    if (settled) return;
    received += chunk.length;
    if (received > config.bodyLimitBytes) {
      failOnce(413, 'BODY_TOO_LARGE', 'request body exceeds the console host limit', { connection: 'close' });
      req.unpipe(upstream);
      upstream.destroy();
      req.resume();
    }
  });
  req.pipe(upstream);
}

/**
 * Serve one static file.
 *
 * @param {import('node:http').IncomingMessage} req Browser request.
 * @param {import('node:http').ServerResponse} res Browser response.
 * @param {object} config Resolved host configuration.
 * @param {string} pathname Request path without query.
 * @returns {void}
 */
function serveStatic(req, res, config, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, 'METHOD_NOT_ALLOWED', 'static resources are GET/HEAD only', { allow: 'GET, HEAD' });
    return;
  }
  const target = staticTargetFor(config.staticRoot, pathname);
  if (target === undefined) {
    sendJson(res, 404, 'NOT_FOUND', 'not found');
    return;
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': target.type,
    'content-length': target.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(target.file);
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, 'READ_FAILED', 'file could not be read');
    else res.destroy();
  });
  // A client that leaves mid-file must not leave a descriptor open.
  res.on('close', () => stream.destroy());
  res.on('error', () => stream.destroy());
  stream.pipe(res);
}

/** Extract the pathname from a request target, rejecting non-origin-form targets. */
function pathnameOf(requestUrl) {
  if (typeof requestUrl !== 'string' || !requestUrl.startsWith('/')) return undefined;
  const query = requestUrl.indexOf('?');
  return query === -1 ? requestUrl : requestUrl.slice(0, query);
}

/**
 * Build the HTTP server (no listening side effects).
 *
 * @param {{daemon: object, token: string, csrf: string, staticRoot: string, verbose: boolean,
 *   bodyLimitBytes: number, proxyTimeoutMs: number, log?: (line: string) => void}} config
 *   Resolved configuration.
 * @returns {import('node:http').Server} Unlistened server.
 */
export function createConsoleHost(config) {
  const resolved = {
    ...config,
    bodyLimitBytes: config.bodyLimitBytes ?? BODY_LIMIT_BYTES,
    proxyTimeoutMs: config.proxyTimeoutMs ?? PROXY_TIMEOUT_MS,
    csrf: config.token === '' ? '' : csrfFor(config.token),
    log: config.log ?? (() => {}),
  };
  const server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    const pathname = pathnameOf(req.url);
    res.on('close', () => {
      if (!resolved.verbose) return;
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      // Method/path/status/duration only. The query is dropped and no header value
      // is ever formatted, so a token cannot reach a log line by accident.
      resolved.log(`${req.method ?? '-'} ${pathname ?? '-'} ${res.statusCode} ${elapsedMs.toFixed(1)}ms`);
    });
    if (pathname === undefined) {
      sendJson(res, 400, 'BAD_REQUEST', 'malformed request target');
      return;
    }
    const isProxy = PROXY_EXACT.includes(pathname) || pathname.startsWith(API_PREFIX);
    if (isProxy) {
      if (!PROXY_METHODS.includes(req.method)) {
        sendJson(res, 405, 'METHOD_NOT_ALLOWED', 'the console proxy forwards GET/POST/PUT/DELETE only', {
          allow: PROXY_METHODS.join(', '),
        });
        return;
      }
      if (WRITE_METHODS.includes(req.method) && req.headers[CONSOLE_HEADER] !== CONSOLE_HEADER_VALUE) {
        // A cross-origin form can reach this branch but cannot set a custom
        // header, so a 403 here is the CSRF gate the browser cannot pass.
        sendJson(res, 403, 'CONSOLE_HEADER_REQUIRED',
          'write requests must carry the console header: x-console-v2: 1');
        return;
      }
      proxy(req, res, resolved);
      return;
    }
    serveStatic(req, res, resolved, pathname);
  });
  // Only loopback peers. Binding a loopback literal already makes this true, but
  // the check is cheap and keeps the property when a future change widens --host.
  server.on('connection', (socket) => {
    if (!isLoopbackPeer(socket.remoteAddress)) socket.destroy();
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

/**
 * Start the host: parse the CLI, validate, listen, and announce on stdout.
 *
 * @param {string[]} [argv] Arguments (defaults to `process.argv.slice(2)`).
 * @param {Record<string, string|undefined>} [env] Environment.
 * @returns {import('node:http').Server|undefined} The listening server.
 */
export function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    fail(error.message, 2);
    return undefined;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return undefined;
  }
  let token = options.token;
  if (options.tokenFile !== undefined) {
    try {
      token = readTokenFile(options.tokenFile);
    } catch (error) {
      fail(error.message, 2);
      return undefined;
    }
  }
  const server = createConsoleHost({
    daemon: options.daemon,
    token,
    staticRoot: HERE,
    verbose: options.verbose,
    log: (line) => process.stderr.write(`console-host: ${line}\n`),
  });
  server.on('error', (error) => fail(`cannot listen: ${error.message}`, 1));
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;
    const boundHost = options.host.includes(':') ? `[${options.host}]` : options.host;
    process.stdout.write(`${JSON.stringify({
      schemaVersion: '1.0',
      listening: `http://${boundHost}:${boundPort}/`,
      daemon: options.daemon.origin,
      tokenInjected: token !== '',
      note: 'Open the printed URL yourself. This process never opens a browser and never polls.',
    })}\n`);
  });
  return server;
}

/** Run only when executed directly, so tests can import the pure helpers. */
const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main();
