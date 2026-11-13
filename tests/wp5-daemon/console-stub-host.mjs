#!/usr/bin/env node
/**
 * console-stub-host.mjs — the B8 test double for `apps/model-broker/bin/console-host.js`.
 *
 * It speaks the **canonical** frames of contract §1.1 (the same table B9 implemented)
 * over newline-delimited JSON-RPC, and nothing else. It exists so the daemon's console
 * routes can be tested without depending on B9's file, and so test cases can force the
 * behaviours the daemon must handle: a stream that ends normally, a stream that ignores
 * `chat/cancel` (to prove the 250 ms `SIGKILL`), a provider probe that fails, and a
 * missing credential.
 *
 * Not a product file. Behaviour is selected with environment variables so one script
 * covers every case:
 *
 * | env | meaning |
 * |---|---|
 * | `STUB_SPAWN_LOG` | append this child's pid, one per line (spawn-count evidence) |
 * | `STUB_PID_FILE` | overwrite with this child's pid (orphan-check evidence) |
 * | `STUB_RECORD_FILE` | write the `chat/start` params (prompt containment evidence) |
 * | `STUB_EGRESS_LOG` | append one line when the stub is about to dial a provider |
 * | `STUB_CHAT_MODE` | `stream` (default) · `sleep` (ignores cancel) · `error` · `exit` |
 * | `STUB_TEST_MODE` | `refuse_credential` → `provider/test` fails with `CREDENTIAL_MISSING` |
 *
 * The credential slot is a JSON file under `<dataDir>` so it survives the daemon's
 * one-child-per-operation lifecycle. It stores a *stub* secret, never a real one.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import http from 'node:http';
import process from 'node:process';

const args = process.argv.slice(2);
let dataDir = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--data-dir' && typeof args[index + 1] === 'string') {
    dataDir = args[index + 1];
    index += 1;
  }
}
dataDir = dataDir ?? process.env.AEGIS_DATA_DIR ?? null;

const env = process.env;

if (typeof env.STUB_SPAWN_LOG === 'string' && env.STUB_SPAWN_LOG !== '') {
  appendFileSync(env.STUB_SPAWN_LOG, `${process.pid}\n`);
}
if (typeof env.STUB_PID_FILE === 'string' && env.STUB_PID_FILE !== '') {
  writeFileSync(env.STUB_PID_FILE, `${process.pid}\n`);
}

const secretsFile = dataDir === null ? null : join(dataDir, 'stub-secrets.json');

function loadSecrets() {
  if (secretsFile === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(secretsFile, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSecrets(value) {
  if (secretsFile === null) {
    return;
  }
  mkdirSync(dirname(secretsFile), { recursive: true });
  writeFileSync(secretsFile, `${JSON.stringify(value)}\n`);
}

const secrets = loadSecrets();

/** Set once a `sleep` stream has been started; makes `chat/cancel` a no-op on purpose. */
let ignoreCancel = false;

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, reason) {
  writeFrame({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: 'stub host refused the request', data: { code, ...(reason === undefined ? {} : { reason }) } },
  });
}

function notify(requestId, event) {
  writeFrame({ jsonrpc: '2.0', method: 'chat/event', params: { requestId, event } });
}

function fail(error) {
  writeFrame({
    jsonrpc: '2.0',
    id: error.id ?? null,
    error: {
      code: -32000,
      message: 'stub host failed',
      data: { code: error.code ?? 'UPSTREAM_FAILED', reason: error.reason ?? 'STUB_FAILED' },
    },
  });
}

function egressAttempt(kind, target) {
  if (typeof env.STUB_EGRESS_LOG !== 'string' || env.STUB_EGRESS_LOG === '') {
    return;
  }
  appendFileSync(env.STUB_EGRESS_LOG, `${kind} ${target}\n`);
}

function probeModels(baseUrl) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(`${baseUrl.replace(/\/+$/u, '')}/models`);
    } catch {
      resolve({ ok: false, code: 'UPSTREAM_FAILED' });
      return;
    }
    if (target.protocol !== 'http:') {
      // The stub never opens a real TLS connection: tests must not touch the internet.
      resolve({ ok: false, code: 'UPSTREAM_FAILED' });
      return;
    }
    egressAttempt('probe', target.href);
    const startedAtMs = Date.now();
    const request = http.get(target, { headers: {} }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve({ ok: false, code: 'UPSTREAM_FAILED', latencyMs: Date.now() - startedAtMs });
          return;
        }
        let modelCount = 0;
        try {
          const body = JSON.parse(response.setEncoding === undefined ? '{}' : '{}');
          modelCount = Array.isArray(body?.data) ? body.data.length : 0;
        } catch {
          modelCount = 0;
        }
        resolve({ ok: true, latencyMs: Date.now() - startedAtMs, modelCount: modelCount || 3 });
      });
    });
    request.on('error', () => {
      resolve({ ok: false, code: 'UPSTREAM_FAILED', latencyMs: Date.now() - startedAtMs });
    });
    request.setTimeout(2000, () => {
      request.destroy();
      resolve({ ok: false, code: 'UPSTREAM_TIMEOUT', latencyMs: Date.now() - startedAtMs });
    });
  });
}

function credentialInfo(providerId) {
  const secret = typeof secrets[providerId] === 'string' ? secrets[providerId] : null;
  if (secret === null) {
    return { providerId, hasCredential: false, credential: null };
  }
  return {
    providerId,
    hasCredential: true,
    credential: {
      masked: `••••${secret.slice(-4)}`,
      fingerprint: 'stub-fingerprint',
      updatedAt: '2026-11-04T12:00:00.000Z',
      lengthBucket: '16-32',
    },
  };
}

function sameOrigin(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function handleChatStart(id, params) {
  const recordFile = env.STUB_RECORD_FILE;
  if (typeof recordFile === 'string' && recordFile !== '') {
    writeFileSync(recordFile, `${JSON.stringify({
      provider: params.provider ?? null,
      modelId: params.modelId ?? null,
      systemPrompt: params.systemPrompt ?? null,
      locale: params.locale ?? null,
      messages: params.messages ?? null,
    })}\n`);
  }
  const provider = params.provider ?? {};
  const loopback = sameOrigin(provider.baseUrl);
  if (!loopback && typeof secrets[provider.id] !== 'string') {
    respondError(id, 'CREDENTIAL_MISSING', 'NO_SECRET');
    return;
  }
  respond(id, { accepted: true, requestId: params.requestId });
  const requestId = params.requestId;
  const mode = typeof env.STUB_CHAT_MODE === 'string' && env.STUB_CHAT_MODE !== '' ? env.STUB_CHAT_MODE : 'stream';
  if (mode === 'exit') {
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (mode === 'tool') {
    // A proposed tool call that requires approval; the daemon must register it and let
    // the approval route decide. No terminal event: the test controls the end.
    setTimeout(() => {
      notify(requestId, {
        type: 'tool',
        callId: 'call_stub_1',
        name: 'read_alert',
        arguments: { alert_id: 'a_stub' },
        state: 'proposed',
        requiresApproval: true,
      });
    }, 10);
    return;
  }
  if (mode === 'error') {
    setTimeout(() => {
      notify(requestId, { type: 'error', code: 'UPSTREAM_FAILED', message: 'upstream exploded', retryable: true, action: 'RETRY_LATER', details: {} });
    }, 10);
    return;
  }
  if (mode === 'sleep') {
    // Emits one delta, then never ends on its own and ignores `chat/cancel`: this is
    // the case that forces the daemon's 250 ms `SIGKILL`.
    ignoreCancel = true;
    setTimeout(() => {
      notify(requestId, { type: 'delta', text: 'partial' });
    }, 10);
    return;
  }
  setTimeout(() => {
    notify(requestId, { type: 'delta', text: 'hello ' });
  }, 5);
  setTimeout(() => {
    notify(requestId, { type: 'delta', text: 'world' });
  }, 15);
  setTimeout(() => {
    notify(requestId, { type: 'usage', promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  }, 20);
  setTimeout(() => {
    notify(requestId, { type: 'done', finishReason: 'stop', totalTokens: 15, messageId: 'm_stub' });
  }, 25);
}

const handlers = Object.freeze({
  'host/hello'(id) {
    respond(id, {
      protocolVersion: '1.0',
      host: 'stub-console-host',
      pid: process.pid,
      node: process.versions.node,
      startedAt: new Date().toISOString(),
      store: { available: true },
      capabilities: ['credentials/put', 'credentials/delete', 'credentials/info', 'provider/test', 'chat/start', 'chat/cancel'],
      limits: {},
    });
  },
  'credentials/put'(id, params) {
    if (params === null || typeof params !== 'object' || typeof params.providerId !== 'string') {
      respondError(id, 'CREDENTIAL_INVALID', 'PROVIDER_ID');
      return;
    }
    const secret = Object.hasOwn(params, 'apiKey') ? params.apiKey : undefined;
    if (typeof secret !== 'string') {
      respondError(id, 'CREDENTIAL_INVALID', 'SECRET');
      return;
    }
    secrets[params.providerId] = secret;
    saveSecrets(secrets);
    respond(id, { ok: true });
  },
  'credentials/delete'(id, params) {
    const existed = typeof params?.providerId === 'string' && Object.hasOwn(secrets, params.providerId);
    if (typeof params?.providerId === 'string') {
      delete secrets[params.providerId];
      saveSecrets(secrets);
    }
    respond(id, { ok: true, deleted: existed });
  },
  'credentials/info'(id, params) {
    const providerIds = Array.isArray(params?.providerIds) ? params.providerIds : [];
    respond(id, { items: providerIds.map(credentialInfo) });
  },
  async 'provider/test'(id, params) {
    const provider = params?.provider ?? {};
    if (env.STUB_TEST_MODE === 'refuse_credential') {
      respondError(id, 'CREDENTIAL_MISSING', 'NO_SECRET');
      return;
    }
    const probe = await probeModels(String(provider.baseUrl ?? ''));
    const testedAt = new Date().toISOString();
    if (probe.ok === true) {
      respond(id, { ok: true, latencyMs: probe.latencyMs ?? 1, modelCount: probe.modelCount ?? 3, error: null, testedAt });
      return;
    }
    respond(id, {
      ok: false,
      latencyMs: probe.latencyMs ?? 1,
      modelCount: null,
      error: {
        code: probe.code ?? 'UPSTREAM_FAILED',
        message: 'provider probe failed',
        action: probe.code === 'UPSTREAM_TIMEOUT' ? 'CHECK_BASE_URL_OR_NETWORK' : 'RETRY_LATER',
      },
      testedAt,
    });
  },
  'chat/start'(id, params) {
    handleChatStart(id, params);
  },
  'chat/cancel'(id, params) {
    respond(id, { ok: true, cancelled: true });
    if (ignoreCancel !== true) {
      setTimeout(() => process.exit(0), 25);
    }
  },
  shutdown(id) {
    respond(id, { ok: true });
    setTimeout(() => process.exit(0), 20);
  },
});

/** Serialized frame processing: a handler may be async, order must stay intact. */
let chain = Promise.resolve();

const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const text = line.trim();
  if (text === '') {
    return;
  }
  chain = chain.then(async () => {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      fail({ reason: 'FRAME_NOT_JSON' });
      return;
    }
    const handler = handlers[frame.method];
    if (handler === undefined) {
      respondError(frame.id, 'INTERNAL_ERROR', 'UNKNOWN_METHOD');
      return;
    }
    try {
      await handler(frame.id, frame.params ?? {});
    } catch (error) {
      fail({ id: frame.id, reason: typeof error?.message === 'string' ? 'HANDLER_FAILED' : 'HANDLER_FAILED' });
    }
  });
});

reader.on('close', () => {
  // stdin EOF: exit like the real host does when idle.
  setTimeout(() => process.exit(0), 20);
});
