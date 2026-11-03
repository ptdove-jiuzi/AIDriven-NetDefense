/**
 * helpers.js — fixtures for the WP5 CLI tests.
 *
 * Discipline, same as the rest of the repository:
 *
 * 1. **A real loopback HTTP server, never the real daemon.** Every case binds
 *    `127.0.0.1:0` inside the test process and closes it afterwards, so the suite
 *    cannot reach a developer's running service, cannot read a real token and cannot
 *    touch real alert data.
 * 2. **One temporary directory per case**, removed at file teardown. The CLI is a
 *    read-only client, so the interesting assertion is often that the directory is
 *    byte-identical afterwards — `snapshotTree` exists for exactly that.
 * 3. **No sleeping for correctness.** Timeouts are exercised with a handler that never
 *    answers and a short deadline, not with a sleep-and-hope.
 */

import assert from 'node:assert/strict';
import { after } from 'node:test';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../../apps/cli/src/main.js';

/** Repository root, derived from this file rather than from the caller's cwd. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Path to the executable under test. */
export const CLI_BIN = join(REPO_ROOT, 'apps', 'cli', 'bin.js');

/** A token that satisfies the daemon's bearer grammar (43 base64url characters). */
export const TEST_TOKEN = 'wp5-cli-test-token-0123456789abcdefghij';

/** A second, deliberately wrong token of the same shape. */
export const WRONG_TOKEN = 'wp5-cli-wrong-token-0123456789abcdefghij';

const TEMP_DIRS = new Set();

/**
 * Create a temporary directory removed at the end of the test file.
 *
 * @param {string} [label] Suffix used in the directory name.
 * @returns {string} Absolute temporary directory.
 */
export function makeTempDir(label = 'wp5-cli') {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  TEMP_DIRS.add(directory);
  return directory;
}

after(() => {
  for (const directory of TEMP_DIRS) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A leftover handle on Windows must not fail an otherwise passing suite; the
      // directory lives under the OS temp root and is reclaimed by the OS.
    }
  }
  TEMP_DIRS.clear();
});

/**
 * Snapshot a directory tree (path → size + mtime) for "nothing changed" assertions.
 *
 * @param {string} root Directory to snapshot.
 * @returns {Record<string, string>} Snapshot.
 */
export function snapshotTree(root) {
  const output = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        output[`${full}:dir`] = '';
        walk(full);
        continue;
      }
      const stats = statSync(full);
      output[full] = `${stats.size}:${stats.mtimeMs}`;
    }
  };
  walk(root);
  return output;
}

/**
 * Start a loopback mock server.
 *
 * The handler receives the recorded request and the response object; it decides
 * everything else (status, body, whether to answer at all). Requests are recorded so a
 * test can assert what the CLI did *not* send as easily as what it did.
 *
 * @param {(request: {method: string, url: string, headers: Record<string, string>}, res: http.ServerResponse) => void} handler Request handler.
 * @returns {Promise<{
 *   port: number,
 *   url: string,
 *   requests: {method: string, url: string, headers: Record<string, string>}[],
 *   close: () => Promise<void>
 * }>} Server handle.
 */
export async function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const record = {
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
    };
    requests.push(record);
    // Drain the body: the CLI sends none, but a stuck request would hold the socket.
    req.resume();
    Promise.resolve()
      .then(() => handler(record, res))
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end('{"error":{"code":"MOCK_FAILED"}}');
      });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address.port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/**
 * Send a JSON response.
 *
 * @param {http.ServerResponse} res Response.
 * @param {number} status Status code.
 * @param {unknown} body Body (objects are serialised).
 * @param {Record<string, string>} [extraHeaders] Extra headers.
 * @returns {void}
 */
export function respondJson(res, status, body, extraHeaders = {}) {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/**
 * Send raw bytes with an explicit content type.
 *
 * @param {http.ServerResponse} res Response.
 * @param {number} status Status code.
 * @param {Buffer} buffer Body bytes.
 * @param {Record<string, string>} [extraHeaders] Extra headers.
 * @returns {void}
 */
export function respondRaw(res, status, buffer, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buffer.length,
    ...extraHeaders,
  });
  res.end(buffer);
}

/**
 * Write a token file and a client configuration pointing at a mock port.
 *
 * @param {string} directory Temporary directory.
 * @param {{port: number, token?: string, timeoutMs?: number, maxResponseBytes?: number, endpoint?: string, tokenFile?: string|null}} options Options.
 * @returns {{configPath: string, tokenPath: string, token: string}} Paths.
 */
export function writeClientConfig(directory, options) {
  const secrets = join(directory, 'secrets');
  mkdirSync(secrets, { recursive: true });
  const tokenPath = join(secrets, 'api-token');
  const token = options.token ?? TEST_TOKEN;
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Windows has no POSIX mode bits; the ACL inherited from the temp directory applies.
  }

  const config = {
    endpoint: options.endpoint ?? `http://127.0.0.1:${options.port}`,
  };
  if (options.tokenFile !== null) {
    config.tokenFile = options.tokenFile ?? tokenPath;
  }
  if (options.timeoutMs !== undefined) {
    config.timeoutMs = options.timeoutMs;
  }
  if (options.maxResponseBytes !== undefined) {
    config.maxResponseBytes = options.maxResponseBytes;
  }
  const configPath = join(directory, 'aegis-cli.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { configPath, tokenPath, token };
}

/**
 * Run the CLI in-process.
 *
 * Faster than spawning and it exposes the exact exit status without a shell. Output is
 * captured as text so the encoding assertions are made on the same sink an operator
 * would see.
 *
 * @param {readonly string[]} argv Arguments.
 * @param {{env?: Record<string, string|undefined>}} [options] Options.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Result.
 */
export async function runInProcess(argv, options = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    env: options.env ?? {},
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/**
 * Run the CLI as a child process.
 *
 * Argument handling, the process exit status and byte-level output are only real when
 * a process is really started, so at least the contract cases use this path.
 *
 * @param {readonly string[]} argv Arguments.
 * @param {{env?: Record<string, string>, timeoutMs?: number}} [options] Options.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, stdoutBytes: Buffer}>} Result.
 */
export function runCli(argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...argv], {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 20000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const stdoutBytes = Buffer.concat(stdout);
      resolve({
        code,
        stdout: stdoutBytes.toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdoutBytes,
      });
    });
  });
}

/**
 * Parse a `--json` document and assert it is exactly one document.
 *
 * @param {string} text Captured stdout.
 * @returns {any} Parsed document.
 */
export function parseJsonOutput(text) {
  const trimmed = text.trim();
  assert.notEqual(trimmed.length, 0, 'expected a JSON document on stdout');
  assert.equal(trimmed.includes('\n'), false, `expected exactly one line of JSON, got:\n${trimmed}`);
  return JSON.parse(trimmed);
}

/**
 * Find a port that nothing is listening on.
 *
 * Binds an ephemeral port, reads it, closes the listener. The window before a later
 * connection attempt is microseconds and the alternative — a hard-coded port — would
 * collide with whatever else the machine runs.
 *
 * @returns {Promise<number>} A port that is (almost certainly) closed.
 */
export function findClosedPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Read a file as UTF-8.
 *
 * @param {string} filePath Path.
 * @returns {string} Contents.
 */
export function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}
