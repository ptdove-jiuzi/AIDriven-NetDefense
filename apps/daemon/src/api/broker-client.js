/**
 * api/broker-client.js — the single audited gate between the daemon and the model broker.
 *
 * Contract §1 rule 2 forbids importing the model-broker package (its manifest is
 * frozen and the packaging closure is derived from declared dependencies), so the
 * crossing is a child process plus newline-delimited JSON-RPC on stdio. That also
 * makes §4 rule 1 structural: a plaintext secret is handed to the child and never
 * comes back; this process can only ask whether a credential exists and what its
 * mask/fingerprint/bucket are.
 *
 * ## Canonical frames (contract §1.1, frozen with B9's console-host)
 *
 * One JSON object per line, both directions. `stdout` carries frames only; the
 * child's `stderr` is structured logging and is never parsed or printed here.
 *
 * | method              | direction   | params / result |
 * |---------------------|-------------|-----------------|
 * | `host/hello`        | request     | `{}` → `{protocolVersion, …, store:{available,reason?}, capabilities[], limits{}}` |
 * | `credentials/put`   | request     | `{providerId, <credential field>}` → `{ok:true}` |
 * | `credentials/delete`| request     | `{providerId}` → `{ok:true, deleted}` |
 * | `credentials/info`  | request     | `{providerIds:[…]}` → `{items:[{providerId, hasCredential, credential, error?}]}` |
 * | `provider/test`     | request     | `{provider:{id,kind,baseUrl,allowLoopback}}` → §2.4 result |
 * | `chat/start`        | request     | `{requestId, provider, modelId, messages, systemPrompt?, locale?, temperature?, maxOutputTokens?}` → `{accepted:true, requestId}` |
 * | `chat/event`        | notification←| `{requestId, event:{type:"delta|usage|done|error", …}}` |
 * | `chat/cancel`       | request     | `{requestId}` → `{ok:true, cancelled}` |
 * | `shutdown`          | request     | `{}` → `{ok:true}` then exit 0 |
 *
 * The child is launched as `node <repo>/apps/model-broker/bin/console-host.js
 * --data-dir <dataDir>`. Absence of the script is **not** a crash: every operation
 * turns it into `CREDENTIAL_STORE_UNAVAILABLE` / `ENGINE_UNAVAILABLE` (503).
 *
 * ## Lifecycle
 *
 * One short-lived child per operation; a chat stream keeps its child for the whole
 * stream. Cancel = request `chat/cancel`, then EOF + wait; if the child has not
 * exited **250 ms** later it is sent `SIGKILL` (contract §3.4). A normal exit after
 * cancel is expected and never reported as a failure (B9: the host exits 0 once no
 * chat is in flight). Every child is registered so a daemon shutdown can send
 * `shutdown` and reap all of them.
 *
 * This is the only file in `apps/daemon` allowed to name `node:child_process`; the
 * gate must spawn `console-host.js` specifically and may never use a shell
 * (contract §1.2, `harness-absence.test.js`).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONSOLE_CODES, ConsoleError, upstreamCodeToConsole } from './console-errors.js';

/** Environment variable overriding the console-host script path (tests/support). */
export const CONSOLE_HOST_ENV = 'AEGIS_CONSOLE_HOST';

/** Default per-request deadline for control frames. */
export const DEFAULT_RPC_TIMEOUT_MS = 15000;

/** `chat/start` deadline: happens before SSE headers (contract §3.5). */
export const CHAT_START_TIMEOUT_MS = 8000;

/** Provider probe deadline the host enforces; daemon only waits for it. */
export const MODEL_TEST_TIMEOUT_MS = 8000;

/** Cancel grace before `SIGKILL` (contract §3.4). */
export const CANCEL_GRACE_MS = 250;

/** Longest accepted protocol line. */
const MAX_LINE_BYTES = 1024 * 1024;

/** Env names removed before spawning (contract §5: proxies are ignored). */
const PROXY_ENV_NAMES = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

/** The console-host script name; the spawn gate may only start this program. */
const HOST_SCRIPT_NAME = 'console-host.js';

/**
 * Resolve the console-host script path.
 *
 * Order: `AEGIS_CONSOLE_HOST` → `<repo>/apps/model-broker/bin/console-host.js`.
 *
 * @param {{env?: object, defaultPath?: string}} [options] Options.
 * @returns {{path: string, source: 'env'|'module', exists: boolean}} Resolution.
 */
export function resolveConsoleHost(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env?.[CONSOLE_HOST_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const path = fromEnv.trim();
    return { path, source: 'env', exists: existsSync(path) };
  }
  const defaultPath = options.defaultPath
    ?? fileURLToPath(new URL('../../../model-broker/bin/console-host.js', import.meta.url));
  return { path: defaultPath, source: 'module', exists: existsSync(defaultPath) };
}

/**
 * Build the child environment: the parent's minus proxy variables, plus overrides.
 *
 * The environment carries no secret: a credential travels inside a request frame
 * and nowhere else.
 *
 * @param {object} [env] Parent environment.
 * @param {object} [extra] Extra entries.
 * @returns {object} Child environment.
 */
export function childEnvironment(env = process.env, extra = {}) {
  const output = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (PROXY_ENV_NAMES.includes(key)) {
      continue;
    }
    output[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    output[key] = value;
  }
  return output;
}

/**
 * Read newline-delimited JSON from the child's stdout.
 *
 * A malformed line is a protocol fault, never something to resynchronize past:
 * silently skipping it would turn a broken host into "no events ever", i.e. a hung
 * stream, which the operator cannot diagnose.
 *
 * @param {object} stream Readable stream.
 * @param {(frame: object) => void} onFrame Frame sink.
 * @param {(reason: string) => void} onFault Fault sink.
 * @returns {{buffered: () => number}} Reader handle.
 */
function createLineReader(stream, onFrame, onFault) {
  let buffer = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = '';
      onFault('LINE_TOO_LONG');
      return;
    }
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') {
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          onFault('FRAME_NOT_JSON');
          return;
        }
        if (frame === null || typeof frame !== 'object') {
          onFault('FRAME_NOT_OBJECT');
          return;
        }
        onFrame(frame);
      }
      index = buffer.indexOf('\n');
    }
  });
  stream.on('error', () => onFault('STDOUT_ERROR'));
  return { buffered: () => buffer.length };
}

/**
 * Create the broker client.
 *
 * @param {{
 *   dataDir?: string,
 *   env?: object,
 *   hostPath?: string,
 *   nodePath?: string,
 *   logger?: object,
 *   clock?: object
 * }} [options] Options. `hostPath` overrides resolution (tests inject a stub host);
 *   `dataDir` is passed as `--data-dir`.
 * @returns {object} Client.
 */
export function createBrokerClient(options = {}) {
  const logger = options.logger ?? null;
  const env = options.env ?? process.env;
  const nodePath = options.nodePath ?? process.execPath;
  const dataDir = typeof options.dataDir === 'string' && options.dataDir !== '' ? options.dataDir : null;
  const resolution = options.hostPath === undefined
    ? resolveConsoleHost({ env })
    : { path: options.hostPath, source: 'injected', exists: existsSync(options.hostPath) };

  /** @type {Set<object>} */
  const children = new Set();
  const stats = { spawned: 0, completed: 0, killed: 0, faults: 0 };

  /**
   * @returns {boolean} `true` when the host script exists on disk.
   */
  function isAvailable() {
    return resolution.exists;
  }

  /**
   * Spawn one child and wire its protocol plumbing.
   *
   * @param {{onNotification?: (method: string, params: object) => void}} [plumbing] Hooks.
   * @returns {Promise<object>} Child handle.
   */
  async function spawnChild(plumbing = {}) {
    if (!isAvailable()) {
      throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'model broker host is not available', {
        source: resolution.source,
      });
    }
    const args = [resolution.path];
    if (dataDir !== null) {
      args.push('--data-dir', dataDir);
    }
    const child = spawn(nodePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Never a shell: the arguments above are the only command this gate can run.
      shell: false,
      env: childEnvironment(env, options.childEnv ?? {}),
    });
    stats.spawned += 1;
    const handle = {
      pid: typeof child.pid === 'number' ? child.pid : null,
      child,
      nextId: 0,
      /** @type {Map<number, {resolve: Function, reject: Function, timer: object}>} */
      pending: new Map(),
      /** @type {((reason: string) => void)|null} */
      onFault: null,
      /** @type {((method: string, params: object) => void)|null} */
      onNotification: plumbing.onNotification ?? null,
      exited: false,
      exitCode: null,
      /** @type {Promise<void>|null} */
      exitPromise: null,
    };
    // Registered before `spawn` can fail so `close()` always sees the handle.
    children.add(handle);
    handle.exitPromise = new Promise((resolve) => {
      child.once('exit', (code) => {
        handle.exited = true;
        handle.exitCode = code ?? null;
        children.delete(handle);
        const reason = `CHILD_EXIT_${code === null ? 'null' : code}`;
        for (const [, entry] of handle.pending) {
          entry.reject(new ConsoleError(CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'model broker host exited', {
            reason,
          }));
        }
        handle.pending.clear();
        resolve();
      });
    });
    child.on('error', () => {
      stats.faults += 1;
      for (const [, entry] of handle.pending) {
        entry.reject(new ConsoleError(CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'model broker host failed', {
          reason: 'CHILD_ERROR',
        }));
      }
      handle.pending.clear();
    });
    // The child's stderr is structured logging that may quote upstream text; only its
    // size is ever recorded here.
    let stderrBytes = 0;
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length;
    });
    child.stderr?.on('error', () => {});
    handle.stderrBytes = () => stderrBytes;
    createLineReader(child.stdout, (frame) => {
      if (typeof frame.id === 'number' && handle.pending.has(frame.id)) {
        const entry = handle.pending.get(frame.id);
        handle.pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error !== undefined && frame.error !== null) {
          entry.reject(toConsoleError(frame.error));
          return;
        }
        entry.resolve(frame.result);
        return;
      }
      if (typeof frame.method === 'string') {
        if (handle.onNotification !== null) {
          handle.onNotification(frame.method, frame.params ?? {});
        }
        return;
      }
      handle.onFault?.('UNEXPECTED_FRAME');
    }, (reason) => {
      stats.faults += 1;
      handle.onFault?.(reason);
      for (const [, entry] of handle.pending) {
        entry.reject(new ConsoleError(CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'model broker protocol fault', {
          reason,
        }));
      }
      handle.pending.clear();
      stopChild(handle, 0).catch(() => {});
    });
    return handle;
  }

  /**
   * Translate a JSON-RPC error frame into a `ConsoleError`.
   *
   * Domain codes arrive in `error.data.code` (contract §1.1); a frame without one is
   * a transport/internal fault and must not be reported as a caller error.
   *
   * @param {object} error Error frame body.
   * @returns {ConsoleError} Console error.
   */
  function toConsoleError(error) {
    const data = error !== null && typeof error === 'object' && error.data !== null && typeof error.data === 'object'
      ? error.data
      : {};
    const upstream = typeof data.code === 'string' ? data.code : null;
    if (upstream === null) {
      return new ConsoleError(CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'model broker reported an internal failure', {
        reason: 'INTERNAL_ERROR',
        rpc_code: typeof error?.code === 'number' ? error.code : null,
      });
    }
    const code = upstreamCodeToConsole(upstream);
    const details = { upstream };
    if (typeof data.reason === 'string') {
      details.reason = data.reason.slice(0, 64);
    }
    return new ConsoleError(code, 'model broker reported a failure', details);
  }

  /**
   * Send one frame.
   *
   * @param {object} handle Child handle.
   * @param {object} frame Frame body.
   * @returns {boolean} `true` when written.
   */
  function writeFrame(handle, frame) {
    if (handle.exited || handle.child.stdin?.destroyed === true || handle.child.stdin?.writable === false) {
      return false;
    }
    try {
      handle.child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Issue one request and await its result.
   *
   * @param {object} handle Child handle.
   * @param {string} method RPC method.
   * @param {object} params Parameters.
   * @param {{timeoutMs?: number, unavailableCode?: string}} [requestOptions] Options.
   * @returns {Promise<object>} Result object.
   */
  function request(handle, method, params, requestOptions = {}) {
    const timeoutMs = requestOptions.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const unavailableCode = requestOptions.unavailableCode ?? CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE;
    handle.nextId += 1;
    const id = handle.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.pending.delete(id);
        reject(new ConsoleError(unavailableCode, 'model broker did not answer in time', {
          reason: 'RPC_TIMEOUT',
          method,
          timeout_ms: timeoutMs,
        }));
        stopChild(handle, 0).catch(() => {});
      }, timeoutMs);
      timer.unref?.();
      handle.pending.set(id, { resolve, reject, timer });
      if (!writeFrame(handle, {
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      })) {
        clearTimeout(timer);
        handle.pending.delete(id);
        reject(new ConsoleError(unavailableCode, 'model broker host is not running', { reason: 'WRITE_FAILED' }));
      }
    });
  }

  /**
   * Stop a child: EOF on stdin (the host exits 0 when idle), then `SIGKILL` after
   * the grace period. A normal exit is not an error; the promise resolves either way.
   *
   * @param {object} handle Child handle.
   * @param {number} [graceMs] Grace before SIGKILL.
   * @returns {Promise<boolean>} `true` when the process is gone.
   */
  async function stopChild(handle, graceMs = CANCEL_GRACE_MS) {
    if (handle.exited) {
      children.delete(handle);
      return true;
    }
    try {
      handle.child.stdin?.end();
    } catch {
      // Already closed.
    }
    const exited = await Promise.race([
      handle.exitPromise.then(() => true),
      new Promise((resolve) => {
        setTimeout(() => resolve(false), graceMs).unref?.();
      }),
    ]);
    if (exited) {
      children.delete(handle);
      return true;
    }
    stats.killed += 1;
    try {
      handle.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    await Promise.race([
      handle.exitPromise,
      new Promise((resolve) => {
        setTimeout(resolve, 50).unref?.();
      }),
    ]);
    children.delete(handle);
    return handle.exited;
  }

  /**
   * Run one short operation in its own child, then reap it.
   *
   * @param {string} method RPC method.
   * @param {object} params Parameters.
   * @param {{timeoutMs?: number, unavailableCode?: string, onNotification?: Function}} [callOptions] Options.
   * @returns {Promise<object>} Result object.
   */
  async function oneShot(method, params, callOptions = {}) {
    const handle = await spawnChild({ onNotification: callOptions.onNotification });
    try {
      const result = await request(handle, method, params, callOptions);
      stats.completed += 1;
      return result;
    } finally {
      stopChild(handle, CANCEL_GRACE_MS).catch(() => {});
    }
  }

  /**
   * Ask the child for credential metadata for several providers, in one child.
   *
   * @param {string[]} providerIds Provider ids (≤64).
   * @returns {Promise<Map<string, object>>} Metadata per id.
   * @throws {ConsoleError} `CREDENTIAL_STORE_UNAVAILABLE` on transport failure.
   */
  async function describeCredentials(providerIds) {
    const result = await oneShot('credentials/info', { providerIds }, {
      unavailableCode: CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    });
    const output = new Map();
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const item of items) {
      if (item === null || typeof item !== 'object' || typeof item.providerId !== 'string') {
        continue;
      }
      output.set(item.providerId, normalizeCredentialItem(item));
    }
    // A provider the child did not answer for is "no credential": the projection must
    // still render, and silently omitting the field is not an option.
    for (const providerId of providerIds) {
      if (!output.has(providerId)) {
        output.set(providerId, normalizeCredentialItem({ providerId, hasCredential: false }));
      }
    }
    return output;
  }

  /**
   * Open one streaming chat turn.
   *
   * @param {object} params `chat/start` parameters (`requestId`, `provider`, `modelId`, `messages`, `systemPrompt`, `locale`, `temperature`, `maxOutputTokens`).
   * @param {{
   *   onEvent: (event: object) => void,
   *   onFault?: (reason: string) => void,
   *   requireCredential?: boolean
   * }} handlers Hooks. `requireCredential` performs the `credentials/info` pre-check
   *   on the same child, so a missing credential is a JSON 409 *before* any SSE header.
   * @returns {Promise<{requestId: string, pid: number|null, cancel: () => Promise<void>, finish: () => Promise<boolean>}>}
   *   Stream handle.
   */
  async function openChat(params, handlers) {
    const requestId = params.requestId;
    const handle = await spawnChild({
      onNotification: (method, notificationParams) => {
        if (method === 'chat/event' && notificationParams.requestId === requestId) {
          handlers.onEvent(notificationParams.event ?? {});
        }
      },
    });
    handle.onFault = (reason) => {
      handlers.onFault?.(reason);
    };
    try {
      if (handlers.requireCredential === true) {
        const info = await request(handle, 'credentials/info', { providerIds: [params.provider.id] }, {
          unavailableCode: CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
        });
        const item = Array.isArray(info?.items) ? info.items[0] : null;
        if (item === null || item === undefined || item.hasCredential !== true) {
          throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_MISSING, 'no credential is stored for this provider', {
            providerId: params.provider.id,
          });
        }
      }
      await request(handle, 'chat/start', params, {
        timeoutMs: CHAT_START_TIMEOUT_MS,
        unavailableCode: CONSOLE_CODES.ENGINE_UNAVAILABLE,
      });
    } catch (error) {
      await stopChild(handle, 0).catch(() => {});
      throw error;
    }
    let closed = false;
    return {
      requestId,
      pid: handle.pid,
      /**
       * Cancel-on-disconnect path (contract §3.4): request `chat/cancel`, then EOF,
       * then `SIGKILL` if the child outlives the 250 ms grace.
       *
       * @returns {Promise<void>} Resolves once the child is gone (or killing failed).
       */
      async cancel() {
        if (closed) {
          return;
        }
        closed = true;
        try {
          await request(handle, 'chat/cancel', { requestId }, { timeoutMs: CANCEL_GRACE_MS });
        } catch {
          // A host that is already gone cannot acknowledge the cancel; the kill below
          // is what matters.
        }
        await stopChild(handle, CANCEL_GRACE_MS);
      },
      /**
       * Normal completion: end stdin and let the idle host exit by itself.
       *
       * @returns {Promise<boolean>} `true` when the child is gone.
       */
      async finish() {
        if (closed) {
          return true;
        }
        closed = true;
        return stopChild(handle, CANCEL_GRACE_MS);
      },
    };
  }

  return {
    isAvailable,
    resolution: () => ({ ...resolution }),
    activePids: () => [...children].map((handle) => handle.pid).filter((pid) => pid !== null),
    stats: () => ({ ...stats, live: children.size }),

    /**
     * `host/hello` — protocol and store availability of a fresh child.
     *
     * @returns {Promise<object>} Hello result.
     */
    async hello() {
      return oneShot('host/hello', {}, { timeoutMs: DEFAULT_RPC_TIMEOUT_MS });
    },

    /**
     * `credentials/put` — hand a secret to the child. The caller builds the params so
     * the credential field name exists in exactly one daemon file (contract §1.2).
     *
     * @param {{providerId: string, [field: string]: string}} params Put parameters.
     * @returns {Promise<void>} Resolves once the child confirmed the write.
     */
    async putCredential(params) {
      await oneShot('credentials/put', params, {
        unavailableCode: CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
      });
    },

    /**
     * `credentials/delete` — idempotent.
     *
     * @param {string} providerId Provider id.
     * @returns {Promise<{deleted: boolean}>} Delete receipt.
     */
    async deleteCredential(providerId) {
      const result = await oneShot('credentials/delete', { providerId }, {
        unavailableCode: CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
      });
      return { deleted: result?.deleted === true };
    },

    describeCredentials,

    /**
     * Read credential metadata for one provider.
     *
     * @param {string} providerId Provider id.
     * @returns {Promise<object>} Metadata.
     */
    async credentialInfo(providerId) {
      const map = await describeCredentials([providerId]);
      return map.get(providerId) ?? normalizeCredentialItem({ providerId, hasCredential: false });
    },

    /**
     * `provider/test` — one provider probe, run entirely inside the child.
     *
     * When `requireCredential` is set, the credential presence is checked on the *same*
     * child before the probe request is sent, so a missing credential is a JSON 409 and
     * the provider socket sees zero connections.
     *
     * @param {{provider: {id: string, kind: string, baseUrl: string, allowLoopback: boolean}, requireCredential?: boolean, timeoutMs?: number}} params Probe parameters.
     * @returns {Promise<object>} §2.4 result (a provider failure is a *result*, not a frame error).
     */
    async testProvider(params) {
      const timeoutMs = Math.max(MODEL_TEST_TIMEOUT_MS, (params?.timeoutMs ?? MODEL_TEST_TIMEOUT_MS) + 2000);
      if (params.requireCredential !== true) {
        return oneShot('provider/test', {
          provider: params.provider,
          ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        }, {
          timeoutMs,
          unavailableCode: CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
        });
      }
      const handle = await spawnChild();
      try {
        const info = await request(handle, 'credentials/info', { providerIds: [params.provider.id] }, {
          unavailableCode: CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
        });
        const item = Array.isArray(info?.items) ? info.items[0] : null;
        if (item === null || item === undefined || item.hasCredential !== true) {
          throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_MISSING, 'no credential is stored for this provider', {
            providerId: params.provider.id,
          });
        }
        return await request(handle, 'provider/test', {
          provider: params.provider,
          ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        }, {
          timeoutMs,
          unavailableCode: CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
        });
      } finally {
        stopChild(handle, CANCEL_GRACE_MS).catch(() => {});
      }
    },

    openChat,

    /**
     * Politely shut every live child down and reap it; `SIGKILL` is the last resort.
     *
     * @returns {Promise<void>} Resolves once all children are gone.
     */
    async close() {
      const live = [...children];
      await Promise.all(live.map(async (handle) => {
        try {
          await request(handle, 'shutdown', {}, { timeoutMs: CANCEL_GRACE_MS });
        } catch {
          // Not answering `shutdown` is not a reason to leave it running.
        }
        await stopChild(handle, CANCEL_GRACE_MS).catch(() => false);
      }));
      children.clear();
    },
  };
}

/**
 * Normalize one `credentials/info` item to the four contract fields.
 *
 * Extra members the child might add are dropped rather than forwarded: the console
 * must only ever see mask metadata.
 *
 * @param {object} item Child item.
 * @returns {{hasCredential: boolean, masked: string|null, fingerprint: string|null, updatedAt: string|null, lengthBucket: string|null}}
 *   Metadata.
 */
function normalizeCredentialItem(item) {
  const credential = item?.credential !== null && typeof item?.credential === 'object' ? item.credential : {};
  const hasCredential = item?.hasCredential === true;
  if (!hasCredential) {
    return { hasCredential: false, masked: null, fingerprint: null, updatedAt: null, lengthBucket: null };
  }
  const text = (candidate) => (typeof candidate === 'string' ? candidate : null);
  const lengthBucket = ['<16', '16-32', '33-64', '>64'].includes(credential.lengthBucket)
    ? credential.lengthBucket
    : null;
  return {
    hasCredential: true,
    masked: text(credential.masked),
    fingerprint: text(credential.fingerprint),
    updatedAt: text(credential.updatedAt),
    lengthBucket,
  };
}
