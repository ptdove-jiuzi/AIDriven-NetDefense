/**
 * tests/console/mock-server.mjs — 控制台人工自测用的最小 mock。
 *
 * 它同时扮演两个角色，对应两种真实部署形态：
 *   1. 静态服务器：按 `apps/console/` 的真实文件返回 index.html / app.js / styles.css。
 *   2. 同源 API 代理：把 `/api/v1/status|alerts|analysis` 映射到 `fixtures/*.json`。
 *
 * 故意复刻 daemon 的三件事，否则自测会得出错误结论：
 *   - 查询面封闭：未知/重复/空值参数 → 400 QUERY_INVALID（不是忽略）。
 *   - 错误体形状：`{ error: { code, message, details } }`。
 *   - 只读端点的安全响应头；HTML 不带 CSP（daemon 不提供 HTML）。
 *
 * 用法：
 *   node tests/console/mock-server.mjs 8788
 *   node tests/console/mock-server.mjs 8788 --sim=401
 *   --sim: none | 401 | 429 | 503 | 500 | html   （故障演示用）
 *
 * 作者：PT-dove
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CONSOLE_DIR = path.join(REPO, 'apps', 'console');
const FIXTURES = path.join(HERE, 'fixtures');

const portArgument = process.argv[2];
const port = Number.isFinite(Number(portArgument)) && Number(portArgument) > 0 ? Number(portArgument) : 8788;
const simArgument = process.argv.slice(3).find((entry) => entry.startsWith('--sim='));
const sim = simArgument === undefined ? 'none' : simArgument.slice('--sim='.length);
const SIM_MODES = new Set(['none', '401', '429', '503', '500', 'html']);
if (!SIM_MODES.has(sim)) {
  console.error(`mock-server: unknown --sim value "${sim}"`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const API_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
});

const ERROR_STATUS = {
  QUERY_INVALID: 400,
  CURSOR_INVALID: 400,
  AUTH_REQUIRED: 401,
  AUTH_FAILED: 401,
  AUTH_RATE_LIMITED: 429,
  STORE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...API_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, code, message, details) {
  const payload = { error: { code, message } };
  if (details !== undefined) {
    payload.error.details = details;
  }
  const extra = {};
  if (status === 401) extra['www-authenticate'] = 'Bearer realm="aegis-daemon"';
  if (status === 429) extra['retry-after'] = '60';
  sendJson(res, status, payload, extra);
}

/** 复刻 parsePageQuery 的拒收规则：只认 limit / cursor，重复与空值都拒。 */
function parsePageQuery(searchParams) {
  let limit = 50;
  let cursor = null;
  const seen = new Set();
  for (const [key, value] of searchParams) {
    if (key !== 'limit' && key !== 'cursor') {
      return { error: { parameter: key } };
    }
    if (seen.has(key) || value === '') {
      return { error: { parameter: key } };
    }
    seen.add(key);
    if (key === 'limit') {
      if (!/^(?:[1-9]\d{0,2})$/u.test(value) || Number(value) > 100) {
        return { error: { parameter: 'limit', limit_max: 100 } };
      }
      limit = Number(value);
    } else {
      cursor = value;
    }
  }
  return { limit, cursor };
}

function pageOf(envelopeKey, fixture, limit, cursor) {
  const items = fixture[envelopeKey];
  // 第二页故意为空：用来验证「翻到末页后 has_more=false 且不产生空页推进」。
  if (cursor !== null) {
    return {
      [envelopeKey]: [],
      page: {
        limit,
        returned: 0,
        has_more: false,
        next_cursor: null,
        order: fixture.page.order,
        byte_limited: false,
      },
    };
  }
  const kept = items.slice(0, limit);
  const hasMore = items.length > kept.length || fixture.page.has_more === true;
  return {
    [envelopeKey]: kept,
    page: {
      limit,
      returned: kept.length,
      has_more: hasMore,
      next_cursor: hasMore ? fixture.page.next_cursor : null,
      order: fixture.page.order,
      byte_limited: false,
    },
  };
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/u, '');
  const target = path.resolve(CONSOLE_DIR, relative);
  if (!target.startsWith(CONSOLE_DIR)) {
    sendError(res, 404, 'NOT_FOUND', 'no such endpoint');
    return;
  }
  fs.readFile(target, (error, buffer) => {
    if (error !== null) {
      sendError(res, 404, 'NOT_FOUND', 'no such endpoint');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': buffer.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(buffer);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const stamp = new Date().toISOString().slice(11, 19);

  const finish = (label) => {
    console.log(`${stamp} ${req.method} ${pathname}${url.search} → ${label}`);
  };

  if (req.method !== 'GET') {
    finish('405');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'method is not supported');
    return;
  }

  if (!pathname.startsWith('/api/v1/')) {
    finish('200 static');
    serveStatic(res, pathname);
    return;
  }

  if (sim === '401') {
    finish('401 sim');
    sendError(res, 401, 'AUTH_REQUIRED', 'authentication required');
    return;
  }
  if (sim === '429') {
    finish('429 sim');
    sendError(res, 429, 'AUTH_RATE_LIMITED', 'authentication required');
    return;
  }
  if (sim === '503') {
    finish('503 sim');
    sendError(res, 503, 'STORE_UNAVAILABLE', 'store is not available');
    return;
  }
  if (sim === '500') {
    finish('500 sim');
    sendError(res, 500, 'INTERNAL', 'internal error');
    return;
  }
  if (sim === 'html') {
    finish('200 html sim');
    const body = '<!DOCTYPE html><title>proxy</title><h1>not json</h1>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  const query = parsePageQuery(url.searchParams);
  if (query.error !== undefined) {
    finish('400 query');
    sendError(res, 400, 'QUERY_INVALID', 'query parameter is not accepted', query.error);
    return;
  }

  if (pathname === '/api/v1/status') {
    finish('200 status');
    const body = readFixture('status.json');
    sendJson(res, 200, { ...body, csrf_token: body.csrf_token ?? 'FIXTURE-CSRF-NOT-A-CREDENTIAL' });
    return;
  }
  if (pathname === '/api/v1/alerts') {
    finish('200 alerts');
    sendJson(res, 200, pageOf('alerts', readFixture('alerts.json'), query.limit, query.cursor));
    return;
  }
  if (pathname === '/api/v1/analysis') {
    finish('200 analysis');
    sendJson(res, 200, pageOf('analyses', readFixture('analysis.json'), query.limit, query.cursor));
    return;
  }

  finish('404');
  sendError(res, 404, 'NOT_FOUND', 'no such endpoint');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-console listening on http://127.0.0.1:${port}/  (sim=${sim})`);
  console.log(`  static root : ${CONSOLE_DIR}`);
  console.log(`  fixtures    : ${FIXTURES}`);
  console.log(`  ERROR_STATUS: ${Object.keys(ERROR_STATUS).join(', ')}`);
});
