/**
 * Shared harness for `tests/console-host/**` (author PT-dove).
 *
 * Every suite here drives the *real* `apps/console-next/serve.mjs` as a child
 * process and a real `node:http` fake daemon on `127.0.0.1:0`. Nothing is
 * stubbed inside the host: the point of these suites is that the bytes a browser
 * would see are produced by the shipped file, and the headers the daemon would
 * see are produced by the shipped proxy.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const SERVE_PATH = join(REPO_ROOT, 'apps', 'console-next', 'serve.mjs');
export const NODE_EXE = process.execPath;
export const CONSOLE_PAGE = join(REPO_ROOT, 'apps', 'console-next', 'index.html');

/** A token with the daemon's bearer grammar, distinctive enough to grep for. */
export const TEST_TOKEN = 'console-host-test-token-0123456789ABCDEF';

/** Resolve once the server is listening; return the bound port. */
export function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise(address.port);
    });
  });
}

/** Close a server and swallow the "not running" error. */
export function closeServer(server) {
  return new Promise((resolvePromise) => {
    if (server === undefined || server === null || !server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}

/**
 * A fake daemon that records everything it is sent.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *   record: object) => void} handler Per-request behaviour.
 * @returns {Promise<{port: number, url: string, requests: object[], server: object,
 *   close: () => Promise<void>}>} Running daemon.
 */
export async function startFakeDaemon(handler) {
  /** @type {object[]} */
  const requests = [];
  const server = createServer((req, res) => {
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: '',
      /** True when the daemon saw the connection go away before it finished replying. */
      premature: false,
      responseEnded: false,
    };
    requests.push(record);
    req.on('data', (chunk) => { record.body += chunk.toString('utf8'); });
    res.on('close', () => {
      record.responseEnded = res.writableEnded;
      record.premature = !res.writableEnded;
    });
    handler(req, res, record);
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    server,
    close: () => closeServer(server),
  };
}

/** Default fake daemon: a JSON acknowledgement that echoes the request identity. */
export function jsonDaemon(responder) {
  return (req, res, record) => {
    const outcome = responder === undefined ? { ok: true } : responder(req, record);
    const body = JSON.stringify(outcome.body ?? {
      method: req.method,
      url: req.url,
      authorization: record.headers.authorization ?? null,
    });
    res.writeHead(outcome.status ?? 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...(outcome.headers ?? {}),
    });
    res.end(body);
  };
}

/** Resolve a free loopback port and close it again: a reliably unreachable port. */
export async function closedPort() {
  const probe = createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

/**
 * Start the console host and wait for its one-line announcement.
 *
 * @param {string[]} args CLI arguments.
 * @param {{cwd?: string, env?: Record<string, string>, scriptPath?: string}} [options]
 *   Spawn options. `scriptPath` defaults to the product file; the static-refusal
 *   suites point it at a byte-identical copy that sits among their fixtures,
 *   because the static root is always "the directory of the running file".
 * @returns {Promise<{child: object, announcement: object, url: string,
 *   stdout: () => string, stderr: () => string, close: () => Promise<void>}>}
 */
export async function startConsole(args, options = {}) {
  const scriptPath = options.scriptPath ?? SERVE_PATH;
  const child = spawn(NODE_EXE, [scriptPath, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  const announcement = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      void stopChild(child);
      reject(new Error(`console host did not announce within 15s; stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    const inspect = () => {
      const trimmed = stdout.trim();
      if (trimmed === '') return;
      try {
        const value = JSON.parse(trimmed);
        if (typeof value?.listening === 'string') {
          clearTimeout(timer);
          resolvePromise(value);
        }
      } catch {
        // The announcement may still be arriving; wait for more bytes.
      }
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; inspect(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`console host exited with ${code} before announcing; stderr=${stderr}`));
    });
  });
  return {
    child,
    announcement,
    url: announcement.listening,
    stdout: () => stdout,
    stderr: () => stderr,
    close: () => stopChild(child),
  };
}

/** Terminate a child and wait for it, escalating to SIGKILL. */
export function stopChild(child, timeoutMs = 5000) {
  return new Promise((resolvePromise) => {
    if (child === undefined || child === null) {
      resolvePromise();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill();
  });
}

/** Run the host to completion (CLI refusal cases) and return its exit result. */
export function runConsole(args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(NODE_EXE, [SERVE_PATH, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

/**
 * A raw HTTP request, used where `fetch` would normalise the path away
 * (traversal probes) or where an exact header set matters.
 *
 * @param {{port: number, path: string, method?: string, headers?: object, body?: string|Buffer,
 *   timeoutMs?: number}} request Request description.
 * @returns {Promise<{status: number, headers: object, body: Buffer, text: string}>}
 */
export function rawRequest(request) {
  return new Promise((resolvePromise, reject) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port: request.port,
      path: request.path,
      method: request.method ?? 'GET',
      headers: request.headers ?? {},
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
      });
      res.on('error', reject);
    });
    client.on('error', reject);
    client.setTimeout(request.timeoutMs ?? 15_000, () => client.destroy(new Error('client timeout')));
    if (request.body !== undefined) client.end(request.body);
    else client.end();
  });
}

/** Port from a console announcement URL. */
export function portOf(url) {
  return Number(new URL(url).port);
}

/**
 * Copy `serve.mjs` into a scratch directory and place fixture files around it.
 *
 * The static rules (extension allowlist, dotfiles, directories, traversal) have
 * to be tested against files that really exist in the served directory; the
 * product directory is not ours to fill with fixtures, so a byte-identical copy
 * of the shipped file is used instead.
 *
 * @returns {{root: string, site: string, cleanup: () => void}} Fixture layout.
 */
export function makeStaticFixture() {
  const root = mkdtempSync(join(tmpdir(), 'aidn-console-host-'));
  const site = join(root, 'site');
  mkdirSync(site, { recursive: true });
  copyFileSync(SERVE_PATH, join(site, 'serve.mjs'));
  writeFileSync(join(site, 'index.html'), '<!doctype html>\n<title>fixture</title>\n');
  writeFileSync(join(site, 'app.js'), 'export const ok = true;\n');
  writeFileSync(join(site, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(site, '.env'), 'FIXTURE_SECRET=1\n');
  writeFileSync(join(site, 'secret.mjs'), 'export const never = 1;\n');
  writeFileSync(join(site, 'notes.md'), '# not an allowed extension\n');
  mkdirSync(join(site, 'sub'), { recursive: true });
  writeFileSync(join(site, 'sub', 'child.txt'), 'child\n');
  // One level above the served directory: the traversal probes aim at this file.
  writeFileSync(join(root, 'outside.txt'), 'outside\n');
  return {
    root,
    site,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
