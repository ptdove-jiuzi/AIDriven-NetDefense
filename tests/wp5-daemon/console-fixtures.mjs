/**
 * console-fixtures.mjs — shared harness for the B8 console route tests.
 *
 * Each test file builds the *real* console stack (`server.js` + the ten route modules
 * + a real settings store) against a **stub broker host** and an ephemeral loopback
 * port. That keeps the assertions honest about the pieces the daemon owns (admission,
 * routing, SSE framing, quota, settings persistence) without depending on B9's host
 * file or on any network.
 *
 * Rules this harness follows, matching `tests/wp5-daemon/helpers.js`:
 * 1. one temporary directory per test, removed at file end;
 * 2. no real user data and no internet — provider URLs point at a local socket;
 * 3. no sleeping for correctness; `waitFor` polls observable state only.
 */

import assert from 'node:assert/strict';
import { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthGuard } from '../../apps/daemon/src/api/auth.js';
import { createApprovalRegistry, createChatHandlers, createChatQuota } from '../../apps/daemon/src/api/chat.js';
import { createChatEngine } from '../../apps/daemon/src/api/chat-engine.js';
import { createBrokerClient } from '../../apps/daemon/src/api/broker-client.js';
import { createCredentialHandlers } from '../../apps/daemon/src/api/credentials.js';
import { createAlertLookup, createExplainHandlers, createExplainLimiter } from '../../apps/daemon/src/api/explain.js';
import { createHealthCache, createModelsHandlers } from '../../apps/daemon/src/api/models.js';
import { createControlApi } from '../../apps/daemon/src/api/server.js';
import { createSettingsHandlers, createSettingsStore } from '../../apps/daemon/src/api/settings.js';
import {
  DEFAULT_SETTINGS,
  cloneJson,
  overlayReadOnly,
  stripReadOnly,
} from '../../apps/daemon/src/api/settings-schema.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { createLogger } from '../../apps/daemon/src/log.js';

/** The stub host script, addressed exactly as the daemon gate spawns it. */
export const STUB_HOST = fileURLToPath(new URL('./console-stub-host.mjs', import.meta.url));

/** Bearer token used by every console test. */
export const TEST_TOKEN = 'console-test-token-0123456789abcdefghij';

/** CSRF header name (mirrors `api/auth.js`). */
export const CSRF_HEADER = 'x-aegis-csrf';

/** Fixed wall clock so settings/approval timestamps are deterministic. */
export const BASE_MS = Date.UTC(2026, 10, 4, 12, 0, 0);

const TEMP_DIRS = new Set();

after(() => {
  for (const directory of TEMP_DIRS) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A leaked handle on Windows must not fail an otherwise passing suite.
    }
  }
  TEMP_DIRS.clear();
});

/**
 * Create a temporary data directory removed at the end of the test file.
 *
 * @param {string} [prefix] Directory prefix.
 * @returns {string} Absolute path.
 */
export function makeTempDir(prefix = 'aegis-console-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.add(directory);
  return directory;
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return cloneJson(patch);
  }
  const output = base !== null && typeof base === 'object' && !Array.isArray(base) ? base : {};
  for (const [key, value] of Object.entries(patch)) {
    output[key] = deepMerge(output[key], value);
  }
  return output;
}

/** Live values of the server-owned fields this harness exposes (see `readOnly` below). */
export const FIXTURE_READ_ONLY = Object.freeze({
  response: { executionEnabled: false },
  update: { lastCheckedAt: null, currentVersion: 'test-version' },
  diagnostics: { apiPort: null, exportBundleLastAt: null },
});

/**
 * Build a full settings document from defaults plus overrides (arrays replace).
 *
 * Read-only fields are overlaid with the harness's live values, so a document can be
 * PUT back exactly as `GET` would have returned it.
 *
 * @param {object} [overrides] Partial document.
 * @returns {object} Document.
 */
export function settingsDocument(overrides = {}) {
  return overlayReadOnly(deepMerge(cloneJson(DEFAULT_SETTINGS), overrides), FIXTURE_READ_ONLY);
}

/**
 * Persist a settings document into `<dataDir>/console/settings.json`.
 *
 * Read-only fields are stripped first, exactly as the real store's `save()` does: the
 * file must not claim to own a server field.
 *
 * @param {string} dataDir Data directory.
 * @param {object} document Settings document.
 * @returns {string} File path.
 */
export function writeSettingsFile(dataDir, document) {
  const directory = join(dataDir, 'console');
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, 'settings.json');
  writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: '1.0',
    updatedAt: '2026-11-04T00:00:00.000Z',
    settings: stripReadOnly(document),
  }, null, 2)}\n`);
  return filePath;
}

/**
 * Write an arbitrary (possibly corrupt) settings file body.
 *
 * @param {string} dataDir Data directory.
 * @param {string} text Raw file text.
 * @returns {string} File path.
 */
export function writeRawSettingsFile(dataDir, text) {
  const directory = join(dataDir, 'console');
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, 'settings.json');
  writeFileSync(filePath, text);
  return filePath;
}

/**
 * A loopback provider entry pointing at a local probe server.
 *
 * @param {number} port Probe server port.
 * @param {object} [overrides] Field overrides.
 * @returns {object} Provider entry.
 */
export function loopbackProvider(port, overrides = {}) {
  return {
    id: 'ollama-local',
    kind: 'ollama',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    enabled: true,
    allowLoopback: true,
    dailyInputTokens: 30000,
    dailyOutputTokens: 6000,
    pricing: null,
    ...overrides,
  };
}

/**
 * A model entry bound to {@link loopbackProvider}.
 *
 * @param {object} [overrides] Field overrides.
 * @returns {object} Model entry.
 */
export function loopbackModel(overrides = {}) {
  return {
    id: 'local-chat',
    providerId: 'ollama-local',
    tier: 'triage',
    maxInputTokens: 4096,
    maxOutputTokens: 512,
    costClass: 'free-local',
    ...overrides,
  };
}

/**
 * Settings with egress open for one loopback provider (the chat test baseline).
 *
 * @param {number} port Probe server port (unused by chat, but a legal URL is needed).
 * @param {object} [extra] Extra document overrides.
 * @returns {object} Overrides document.
 */
export function chatReadySettings(port, extra = {}) {
  return deepMerge({
    models: {
      egressEnabled: true,
      providers: [loopbackProvider(port)],
      models: [loopbackModel()],
    },
  }, extra);
}

/**
 * A logger that captures its lines so tests can assert nothing secret was logged.
 *
 * @returns {{logger: object, lines: () => string[], text: () => string}} Capture.
 */
export function createCaptureLogger() {
  const lines = [];
  const logger = createLogger({
    level: 'debug',
    clock: { nowIso: () => new Date(BASE_MS).toISOString() },
    stream: {
      write(chunk) {
        lines.push(String(chunk));
        return true;
      },
    },
  });
  return {
    logger,
    lines: () => [...lines],
    text: () => lines.join(''),
  };
}

/**
 * Start a real console API stack on an ephemeral loopback port.
 *
 * @param {{
 *   dataDir?: string,
 *   settings?: object,
 *   rawSettingsText?: string,
 *   childEnv?: object,
 *   hostPath?: string,
 *   alerts?: object[],
 *   alertLookup?: Function,
 *   logger?: object,
 *   chatLimits?: object,
 *   explainLimits?: object,
 *   approvalTimeoutMs?: number,
 *   sseOptions?: object,
 *   requestTimeoutMs?: number,
 *   failureLimit?: number
 * }} [options] Options.
 * @returns {Promise<object>} Harness with `address`, `request`, `sse`, `close`.
 */
export async function startConsoleApi(options = {}) {
  const dataDir = options.dataDir ?? makeTempDir();
  if (options.rawSettingsText === undefined) {
    writeSettingsFile(dataDir, settingsDocument(options.settings ?? {}));
  } else {
    writeRawSettingsFile(dataDir, options.rawSettingsText);
  }
  const clock = createManualClock(BASE_MS);
  const logger = options.logger ?? createCaptureLogger().logger;
  const settingsStore = createSettingsStore({
    filePath: join(dataDir, 'console', 'settings.json'),
    clock,
    logger,
  });
  const healthCache = createHealthCache({
    filePath: join(dataDir, 'console', 'model-health.json'),
    logger,
  });
  const broker = createBrokerClient({
    dataDir,
    hostPath: options.hostPath ?? STUB_HOST,
    childEnv: options.childEnv ?? {},
    logger,
  });
  const engine = createChatEngine({ broker, logger });
  const chatQuota = createChatQuota(options.chatLimits ?? {});
  const approvals = createApprovalRegistry({
    clock,
    logger,
    timeoutMs: options.approvalTimeoutMs,
  });
  const explainLimiter = createExplainLimiter({ clock, ...(options.explainLimits ?? {}) });
  const store = options.store ?? {
    kind: 'memory',
    dump: () => ({ alerts: options.alerts ?? [] }),
  };
  const modelsHandlers = createModelsHandlers({ settingsStore, broker, engine, healthCache, clock, logger });
  const consoleHandlers = {
    getModels: modelsHandlers.getModels,
    testProvider: modelsHandlers.testProvider,
    ...createCredentialHandlers({ settingsStore, broker, logger }),
    ...createChatHandlers({
      settingsStore,
      engine,
      quota: chatQuota,
      approvals,
      clock,
      logger,
      sseOptions: options.sseOptions ?? {},
    }),
    ...createExplainHandlers({
      settingsStore,
      engine,
      alertLookup: options.alertLookup ?? createAlertLookup({
        store,
        storePath: join(dataDir, 'store', 'aegis.db'),
        clock,
        logger,
      }),
      limiter: explainLimiter,
      clock,
      logger,
      sseOptions: options.sseOptions ?? {},
    }),
    ...createSettingsHandlers({
      store: settingsStore,
      broker,
      logger,
      readOnly: () => cloneJson(FIXTURE_READ_ONLY),
    }),
  };
  const auth = createAuthGuard({
    token: TEST_TOKEN,
    clock,
    failureLimit: options.failureLimit ?? 100,
    failureWindowMs: 60_000,
  });
  const api = createControlApi({
    config: {
      host: '127.0.0.1',
      port: 0,
      // Generous on purpose: the suite runs several files in parallel and each broker
      // operation forks a child process, so a 2 s deadline would measure machine load
      // rather than the handler. The SSE-exemption test passes its own small value to
      // prove the exemption itself.
      requestTimeoutMs: options.requestTimeoutMs ?? 30000,
      headersTimeoutMs: 2000,
      keepAliveTimeoutMs: 1000,
      maxBodyBytes: options.maxBodyBytes ?? 65536,
      authFailureWindowMs: 60_000,
    },
    auth,
    logger,
    handlers: {
      health: () => ({ status: 'ok', version: 'test' }),
      ready: () => ({ ready: true, body: { ready: true, lifecycle: 'running', reasons: [] } }),
      status: () => ({ lifecycle: 'running' }),
      pollSource: async (sourceId) => ({ id: sourceId, lifecycle: 'ok' }),
      ...consoleHandlers,
    },
  });
  const address = await api.start();
  const harness = {
    api,
    address,
    dataDir,
    auth,
    settingsStore,
    broker,
    approvals,
    chatQuota,
    explainLimiter,
    csrfToken: auth.csrfToken,
    /**
     * Issue one HTTP request as the console host would.
     *
     * @param {string} pathname Path.
     * @param {object} [requestOptions] Options.
     * @returns {Promise<object>} Response.
     */
    request: (pathname, requestOptions = {}) => httpJson(address.port, pathname, {
      token: TEST_TOKEN,
      csrf: auth.csrfToken,
      ...requestOptions,
    }),
    /**
     * Open an SSE POST and read the whole stream.
     *
     * @param {string} pathname Path.
     * @param {object} body Body.
     * @returns {Promise<object>} Response with parsed events.
     */
    sse: (pathname, body) => ssePost(address.port, pathname, body, {
      token: TEST_TOKEN,
      csrf: auth.csrfToken,
    }),
    close: async () => {
      await api.close();
      await broker.close();
      approvals.close();
    },
  };
  return harness;
}

/**
 * Issue one HTTP request and decode JSON.
 *
 * @param {number} port Bound port.
 * @param {string} pathname Path.
 * @param {{method?: string, token?: string, csrf?: string, body?: unknown, headers?: object}} [options] Options.
 * @returns {Promise<{status: number, headers: Headers, text: string, body: any}>} Response.
 */
export async function httpJson(port, pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (typeof options.token === 'string') {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (typeof options.csrf === 'string') {
    headers[CSRF_HEADER] = options.csrf;
  }
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

/**
 * POST a JSON body and read an SSE response to completion.
 *
 * @param {number} port Bound port.
 * @param {string} pathname Path.
 * @param {unknown} body Body.
 * @param {{token: string, csrf: string, timeoutMs?: number}} options Options.
 * @returns {Promise<{status: number, headers: Headers, text: string, events: object[], comments: string[]}>} Response.
 */
export async function ssePost(port, pathname, body, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  timer.unref?.();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        [CSRF_HEADER]: options.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseSseText(text);
    return { status: response.status, headers: response.headers, text, ...parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse an SSE payload into events and comments.
 *
 * @param {string} text Raw stream text.
 * @returns {{events: {event: string, data: any, raw: string}[], comments: string[]}} Parsed stream.
 */
export function parseSseText(text) {
  const events = [];
  const comments = [];
  for (const block of String(text).split('\n\n')) {
    if (block.trim() === '') {
      continue;
    }
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        comments.push(line);
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    const raw = dataLines.join('\n');
    events.push({ event: eventName, data: JSON.parse(raw), raw });
  }
  return { events, comments };
}

/**
 * Open a raw HTTP POST and expose the response stream so a test can cut the socket
 * mid-stream (the abort/cleanup case).
 *
 * @param {number} port Bound port.
 * @param {string} pathname Path.
 * @param {unknown} body Body.
 * @param {{token: string, csrf: string}} options Options.
 * @returns {Promise<{request: object, response: object, chunks: () => string, onData: Function}>} Stream handle.
 */
export async function openRawSse(port, pathname, body, options) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        [CSRF_HEADER]: options.csrf,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let buffer = '';
      /** @type {{predicate: Function, resolve: Function, reject: Function}[]} */
      const waiters = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        for (const waiter of [...waiters]) {
          if (waiter.predicate(buffer)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(buffer);
          }
        }
      });
      response.on('end', () => {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve(buffer);
        }
      });
      resolve({
        request,
        response,
        chunks: () => buffer,
        /**
         * Wait until the buffered stream satisfies `predicate`.
         *
         * @param {(text: string) => boolean} predicate Condition.
         * @param {number} [timeoutMs] Budget.
         * @returns {Promise<string>} Buffered text at match time.
         */
        onData(predicate, timeoutMs = 5000) {
          if (predicate(buffer)) {
            return Promise.resolve(buffer);
          }
          return new Promise((resolveWait, rejectWait) => {
            const waiter = {
              predicate,
              resolve: resolveWait,
              reject: rejectWait,
              timer: null,
            };
            waiter.timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              rejectWait(new Error(`timed out waiting for SSE data (buffered ${buffer.length} bytes)`));
            }, timeoutMs);
            waiter.timer.unref?.();
            waiters.push(waiter);
          });
        },
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

/**
 * Start a local HTTP server that counts TCP connections.
 *
 * Used to prove "zero egress": the provider URL points here, so any provider dial
 * increments the counter. The handler answers a valid `/models` list so the positive
 * control case succeeds.
 *
 * @returns {Promise<{port: number, connections: () => number, requests: () => number, close: () => Promise<void>}>} Server handle.
 */
export async function startProbeServer() {
  let connections = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    const body = JSON.stringify({ object: 'list', data: [{ id: 'stub-model-1' }, { id: 'stub-model-2' }, { id: 'stub-model-3' }] });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    connections: () => connections,
    requests: () => requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/**
 * Report whether a pid is alive, using `tasklist` on Windows (pid-exact) and signal 0
 * elsewhere. The output is returned as evidence for the status file.
 *
 * @param {number} pid Process id.
 * @returns {{alive: boolean, evidence: string}} Liveness plus raw command output.
 */
export function processLiveness(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { alive: false, evidence: 'no pid' };
  }
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
      // Localization-proof: a live process row contains the pid; the "no tasks" message
      // does not. Matching digits avoids depending on the OS language.
      const alive = new RegExp(`\\b${pid}\\b`, 'u').test(output);
      return { alive, evidence: output.trim() };
    } catch (error) {
      return { alive: false, evidence: `tasklist failed: ${error?.code ?? 'ERROR'}` };
    }
  }
  try {
    process.kill(pid, 0);
    return { alive: true, evidence: 'kill(pid, 0) succeeded' };
  } catch {
    return { alive: false, evidence: 'kill(pid, 0) failed' };
  }
}

/**
 * Poll `predicate` until it returns true or the budget expires.
 *
 * @param {() => boolean} predicate Condition.
 * @param {{timeoutMs?: number, label?: string}} [options] Options.
 * @returns {Promise<void>} Resolves once the condition holds.
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.fail(`timed out waiting for ${options.label ?? 'condition'}`);
}

/**
 * Read a JSON file, or `null` when it does not exist yet.
 *
 * @param {string} filePath Path.
 * @returns {any} Parsed value.
 */
export function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a text file, or `null` when it does not exist yet.
 *
 * @param {string} filePath Path.
 * @returns {string|null} Text.
 */
export function readTextIfPresent(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** A session id in the contract's shape, derived from a label. */
export function sessionIdFor(label) {
  let hex = '';
  for (const character of String(label)) {
    hex += character.charCodeAt(0).toString(16).padStart(2, '0');
  }
  return `s_${hex.padEnd(32, '0').slice(0, 32)}`;
}

/** Exposed for tests that build a bare API without the harness. */
export { net };
