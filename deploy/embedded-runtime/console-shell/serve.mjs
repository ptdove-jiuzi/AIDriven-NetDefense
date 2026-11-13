#!/usr/bin/env node
/**
 * serve.mjs — the local console shell (author PT-dove).
 *
 * What it is: a loopback-only static server for the files next to it, plus a
 * narrow reverse proxy for the daemon's read-only surface
 * (`/healthz`, `/readyz`, `/api/v1/*`).
 *
 * What it is not: a product console, an authentication boundary, or a reason to
 * expose anything on a non-loopback interface. The daemon keeps its own token
 * check; this shell holds the token so the browser never does.
 *
 * Refusals that are deliberate:
 * - binds to 127.0.0.1/::1 only; `--host 0.0.0.0` is rejected, not silently
 *   downgraded, because a console on a LAN interface is a different product;
 * - GET and HEAD only;
 * - refuses to serve a WebUI v2 page (see `consoleGeneration()`): v2 needs writes and
 *   streaming, and this shell has neither, so staying up would render a page whose every
 *   save/chat/explain silently fails — the pin below is the only correct instruction;
 * - no directory listing, no dot files, no extension outside the allowlist;
 * - no redirect that could be pointed at another origin;
 * - it never opens a browser itself. Printing a URL is a message; launching a
 *   window the user did not ask for is not.
 *
 * usage:
 *   node console/serve.mjs --daemon http://127.0.0.1:7345 [--token <t>]
 *                          [--host 127.0.0.1] [--port 0]
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);
const PROXY_EXACT = new Set(['/healthz', '/readyz']);
const PROXY_PREFIXES = ['/api/v1/'];

function fail(message, code = 2) {
  process.stderr.write(`console-shell: ${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const options = {
  daemon: process.env.AEGIS_DAEMON_URL ?? 'http://127.0.0.1:7345',
  token: process.env.AEGIS_CONSOLE_TOKEN ?? '',
  host: '127.0.0.1',
  port: 0,
};
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (token === '--daemon') options.daemon = argv[++index];
  else if (token === '--token') options.token = argv[++index] ?? '';
  else if (token === '--host') options.host = argv[++index];
  else if (token === '--port') options.port = Number(argv[++index]);
  else if (token === '--help' || token === '-h') {
    process.stdout.write('usage: node console/serve.mjs --daemon <http://127.0.0.1:port> '
      + '[--token <token>] [--host 127.0.0.1] [--port 0]\n');
    process.exit(0);
  } else fail(`unknown argument: ${token}`);
}
if (!LOOPBACK.has(options.host)) fail(`refusing to bind ${options.host}: this shell is loopback-only`);
if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) fail('--port must be 0..65535');

let daemon;
try {
  daemon = new URL(options.daemon);
} catch {
  fail(`--daemon is not a URL: ${options.daemon}`);
}
if (daemon.protocol !== 'http:' && daemon.protocol !== 'https:') fail('--daemon must be http(s)');
if (!LOOPBACK.has(daemon.hostname)) fail(`refusing to proxy to a non-loopback daemon: ${daemon.hostname}`);
const daemonHost = daemon.hostname;
const daemonPort = Number(daemon.port === '' ? (daemon.protocol === 'https:' ? 443 : 80) : daemon.port);

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** Resolve a request path inside this directory, or `undefined` if it escapes. */
function staticTarget(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  if (decoded.split('/').some((segment) => segment.startsWith('.'))) return undefined;
  const relative = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^([/\\])+/, '');
  const absolute = resolve(join(HERE, relative));
  if (absolute !== HERE && !absolute.startsWith(HERE + sep)) return undefined;
  if (!existsSync(absolute)) return undefined;
  const info = statSync(absolute);
  if (!info.isFile()) return undefined;
  if (!TYPES.has(extname(absolute).toLowerCase())) return undefined;
  return absolute;
}

/** How many `data-route="..."` nav items the WebUI v2 index carries (contract §7.1). */
const V2_NAV_ROUTES = 6;

/**
 * Which console generation sits next to this file.
 *
 * This shell is the *packaging* baseline: it exists for the legacy product console
 * (`apps/console`), whose page only reads. WebUI v2 (`apps/console-next`) ships its own
 * `serve.mjs` because it needs the same-origin write path (PUT settings, POST
 * chat/explain, SSE) and the `x-console-v2` gate; none of that exists here. Detecting it
 * by the frozen page shape (six `data-route` nav items, contract §7.1) turns a silent
 * half-working install into a startup refusal that names the fix.
 *
 * @returns {{generation: 'legacy'|'v2'|'unknown', routes: number}}
 */
function consoleGeneration() {
  try {
    const entry = join(HERE, 'index.html');
    if (!existsSync(entry)) return { generation: 'unknown', routes: 0 };
    const html = readFileSync(entry, 'utf8');
    const routes = (html.match(/\bdata-route="/gu) ?? []).length;
    if (routes >= V2_NAV_ROUTES) return { generation: 'v2', routes };
    return { generation: 'legacy', routes };
  } catch {
    return { generation: 'unknown', routes: 0 };
  }
}

function proxy(req, res) {
  const headers = { accept: 'application/json', host: `${daemonHost}:${daemonPort}` };
  if (options.token !== '') headers.authorization = `Bearer ${options.token}`;
  const upstream = httpRequest({
    protocol: daemon.protocol,
    hostname: daemonHost,
    port: daemonPort,
    path: req.url,
    method: req.method,
    headers,
    timeout: 5000,
  }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, {
      'content-type': reply.headers['content-type'] ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    reply.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('daemon did not answer in 5s')));
  upstream.on('error', (error) => {
    if (!res.headersSent) send(res, 502, JSON.stringify({ error: { code: 'DAEMON_UNREACHABLE', message: error.message } }), 'application/json; charset=utf-8');
    else res.destroy();
  });
  req.pipe(upstream);
}

// Fail closed on a WebUI v2 page. The alternative — serving it and answering 405 to every
// write — produces a console that looks installed and loses every save, which is the
// failure mode this check exists to prevent. (Runs after `consoleGeneration` and its
// constants are initialized, so the check cannot trip over a temporal dead zone.)
const page = consoleGeneration();
if (page.generation === 'v2') {
  fail(`the page next to this shell is WebUI v2 (${page.routes} data-route nav items), but this `
    + 'packaging shell is GET/HEAD only: settings saves (PUT), credentials (PUT/DELETE), '
    + 'chat/explain (POST) and SSE would all fail after the page rendered. Stage the v2 console '
    + 'with its own server instead — build with --console-source apps/console-next so '
    + 'console/serve.mjs is console-next/serve.mjs — or launch that file directly instead of '
    + 'falling back to this one.', 3);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed');
    return;
  }
  const pathname = (req.url ?? '/').split('?')[0];
  if (PROXY_EXACT.has(pathname) || PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    proxy(req, res);
    return;
  }
  const target = staticTarget(pathname);
  if (target === undefined) {
    send(res, 404, 'not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES.get(extname(target).toLowerCase()),
    'content-length': statSync(target).size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
});

server.on('error', (error) => fail(`cannot listen: ${error.message}`, 1));
server.listen(options.port, options.host, () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({
    schemaVersion: '1.0',
    listening: `http://${options.host}:${address.port}/`,
    daemon: `${daemon.protocol}//${daemonHost}:${daemonPort}`,
    generation: page.generation,
    tokenInjected: options.token !== '',
    note: 'Open the printed URL yourself. This process never opens a browser and never polls.',
  }, null, 2)}\n`);
});
