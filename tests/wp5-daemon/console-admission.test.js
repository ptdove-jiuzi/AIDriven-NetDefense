/**
 * console-admission.test.js — the boundary around the ten console routes.
 *
 * Three groups:
 * 1. **Method gate**: PUT/DELETE exist only where the contract declares them; every
 *    other path keeps the original "GET or POST only" answer, before authentication.
 * 2. **Zero egress** (§5): with `egressEnabled=false` or provider `enabled=false` the
 *    daemon refuses *before spawning*, and a local provider socket sees **0**
 *    connections. A positive control proves the counter would see a real dial.
 * 3. **Counters**: `stats.auth_denied` is additive while `stats.rejected` keeps the
 *    meaning pinned by `api-endpoints.test.js:404`.
 *
 * The zero-egress assertions are the ones that must go red if the gate is removed:
 * deleting the `egressEnabled` check makes the stub dial and the connection count
 * becomes 1.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createDaemon } from '../../apps/daemon/src/daemon.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import {
  BASE_MS as HELPER_BASE_MS,
  TEST_TOKEN as DAEMON_TOKEN,
  httpRequest,
  makeConfig,
  makeTempDir,
  waitFor,
} from './helpers.js';
import {
  CSRF_HEADER,
  makeTempDir as makeConsoleTempDir,
  readTextIfPresent,
  settingsDocument,
  startConsoleApi,
  startProbeServer,
  TEST_TOKEN,
} from './console-fixtures.mjs';

const LOOPBACK_SETTINGS = (port, overrides = {}) => settingsDocument({
  models: {
    egressEnabled: true,
    providers: [{
      id: 'ollama-local',
      kind: 'ollama',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      enabled: true,
      allowLoopback: true,
      dailyInputTokens: 30000,
      dailyOutputTokens: 6000,
      pricing: null,
    }],
    models: [{
      id: 'local-chat',
      providerId: 'ollama-local',
      tier: 'triage',
      maxInputTokens: 4096,
      maxOutputTokens: 512,
      costClass: 'free-local',
    }],
    ...overrides,
  },
});

describe('method gate', () => {
  it('keeps the original 405 for verbs on the pre-existing routes', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    for (const method of ['PUT', 'DELETE']) {
      const response = await harness.request('/api/v1/status', { method, body: {} });
      assert.equal(response.status, 405, `${method} /api/v1/status`);
      assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED');
    }
    const postStatus = await harness.request('/api/v1/status', { method: 'POST', body: {} });
    assert.equal(postStatus.status, 405);
    const options = await harness.request('/api/v1/models', { method: 'OPTIONS' });
    assert.equal(options.status, 405);
    const putModels = await harness.request('/api/v1/models', { method: 'PUT', body: {} });
    assert.equal(putModels.status, 405);
    const postSettings = await harness.request('/api/v1/settings', { method: 'POST', body: {} });
    assert.equal(postSettings.status, 405);
    const deleteSettings = await harness.request('/api/v1/settings', { method: 'DELETE' });
    assert.equal(deleteSettings.status, 405);
    const getCredential = await harness.request('/api/v1/credentials/deepseek');
    assert.equal(getCredential.status, 405);
  });

  it('answers 404 for an unknown path once authenticated', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/nope');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    const telemetry = await harness.request('/api/v1/telemetry');
    assert.equal(telemetry.status, 404, 'no telemetry route may exist');
  });

  it('requires the bearer token and the CSRF header on the new write routes', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    // No token at all.
    const noToken = await fetch(`http://127.0.0.1:${harness.address.port}/api/v1/models`);
    assert.equal(noToken.status, 401);
    // Token but no CSRF header: a state-changing request is refused.
    const noCsrf = await fetch(`http://127.0.0.1:${harness.address.port}/api/v1/credentials/deepseek`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-body-canary-0123456789' }),
    });
    assert.equal(noCsrf.status, 403);
    const parsed = JSON.parse(await noCsrf.text());
    assert.equal(parsed.error.code, 'CSRF_REQUIRED');
  });
});

describe('request counters', () => {
  it('counts a 401 in auth_denied without changing rejected', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const unauthenticated = await fetch(`http://127.0.0.1:${harness.address.port}/api/v1/models`);
    assert.equal(unauthenticated.status, 401);
    const stats = harness.api.stats();
    assert.equal(stats.auth_denied, 1);
    // The pre-console meaning of `rejected` is pinned by api-endpoints.test.js:404.
    assert.equal(stats.rejected, 1);
    await harness.request('/api/v1/models');
    const after = harness.api.stats();
    assert.equal(after.auth_denied, 1);
    assert.equal(after.rejected, 1);
    assert.equal(after.by_path['/api/v1/models'], 2);
  });
});

describe('zero egress: egressEnabled / provider.enabled gates', () => {
  it('refuses with EGRESS_DISABLED and opens zero provider connections', async (t) => {
    const probe = await startProbeServer();
    t.after(() => probe.close());
    const dataDir = makeConsoleTempDir();
    const spawnLog = join(dataDir, 'spawns.log');
    const harness = await startConsoleApi({
      dataDir,
      settings: LOOPBACK_SETTINGS(probe.port, { egressEnabled: false }),
      childEnv: { STUB_SPAWN_LOG: spawnLog },
    });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/models/ollama-local/test', { method: 'POST', body: {} });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'EGRESS_DISABLED');
    assert.equal(probe.connections(), 0, 'egress off must not produce a single connection');
    assert.equal(readTextIfPresent(spawnLog), null, 'egress off must not spawn the broker');
  });

  it('refuses with PROVIDER_DISABLED and opens zero provider connections', async (t) => {
    const probe = await startProbeServer();
    t.after(() => probe.close());
    const dataDir = makeConsoleTempDir();
    const spawnLog = join(dataDir, 'spawns.log');
    const document = LOOPBACK_SETTINGS(probe.port);
    document.models.providers[0].enabled = false;
    const harness = await startConsoleApi({
      dataDir,
      settings: document,
      childEnv: { STUB_SPAWN_LOG: spawnLog },
    });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/models/ollama-local/test', { method: 'POST', body: {} });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'PROVIDER_DISABLED');
    assert.equal(probe.connections(), 0);
    assert.equal(readTextIfPresent(spawnLog), null, 'a disabled provider must not spawn the broker');
  });

  it('positive control: an allowed probe really dials the provider', async (t) => {
    const probe = await startProbeServer();
    t.after(() => probe.close());
    const harness = await startConsoleApi({ settings: LOOPBACK_SETTINGS(probe.port) });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/models/ollama-local/test', { method: 'POST', body: {} });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    assert.equal(response.body.modelCount, 3);
    assert.equal(response.body.error, null);
    assert.ok(response.body.latencyMs >= 0);
    assert.equal(probe.connections(), 1, 'the positive control must see exactly one dial');

    const models = await harness.request('/api/v1/models');
    const provider = models.body.providers.find((entry) => entry.id === 'ollama-local');
    assert.equal(provider.healthy, true);
    assert.equal(provider.lastError, null);
    assert.ok(typeof provider.lastCheckedAt === 'string');
    assert.equal(existsSync(join(harness.dataDir, 'console', 'model-health.json')), true);
  });

  it('reports a provider failure as HTTP 200 with ok:false and caches it', async (t) => {
    const probe = await startProbeServer();
    const port = probe.port;
    await probe.close();
    const harness = await startConsoleApi({ settings: LOOPBACK_SETTINGS(port) });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/models/ollama-local/test', { method: 'POST', body: {} });
    assert.equal(response.status, 200, 'a provider failure is a result, not an HTTP error');
    assert.equal(response.body.ok, false);
    assert.equal(response.body.modelCount, null);
    assert.equal(typeof response.body.error.code, 'string');
    assert.ok(['CHECK_BASE_URL_OR_NETWORK', 'RETRY_LATER'].includes(response.body.error.action));
    const models = await harness.request('/api/v1/models');
    const provider = models.body.providers.find((entry) => entry.id === 'ollama-local');
    assert.equal(provider.healthy, false);
    assert.equal(typeof provider.lastError.code, 'string');
  });

  it('refuses an unknown provider and a missing credential from the broker', async (t) => {
    const probe = await startProbeServer();
    t.after(() => probe.close());
    const document = settingsDocument({
      models: {
        egressEnabled: true,
        providers: [{
          id: 'remote',
          kind: 'openai-compatible',
          baseUrl: 'https://api.example.invalid/v1',
          enabled: true,
          allowLoopback: false,
          dailyInputTokens: 30000,
          dailyOutputTokens: 6000,
          pricing: null,
        }],
        models: [],
      },
    });
    const dataDir = makeConsoleTempDir();
    const egressLog = join(dataDir, 'egress.log');
    const harness = await startConsoleApi({
      dataDir,
      settings: document,
      childEnv: { STUB_EGRESS_LOG: egressLog },
    });
    t.after(() => harness.close());
    const unknown = await harness.request('/api/v1/models/missing/test', { method: 'POST', body: {} });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PROVIDER_UNKNOWN');

    const missingCredential = await harness.request('/api/v1/models/remote/test', { method: 'POST', body: {} });
    assert.equal(missingCredential.status, 409);
    assert.equal(missingCredential.body.error.code, 'CREDENTIAL_MISSING');
    assert.equal(readTextIfPresent(egressLog), null, 'the stub must refuse before dialing');
  });
});

describe('SSE timeout exemption', () => {
  it('does not apply requestTimeoutMs to a streaming route', async (t) => {
    const harness = await startConsoleApi({
      settings: LOOPBACK_SETTINGS(1),
      requestTimeoutMs: 40,
      childEnv: { STUB_CHAT_MODE: 'sleep' },
      sseOptions: { idleMs: 300, totalMs: 2000, heartbeatMs: 60 },
    });
    t.after(() => harness.close());
    const response = await harness.sse('/api/v1/agent/chat', {
      sessionId: 's_00000000000000000000000000000001',
      modelId: 'local-chat',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(response.status, 200);
    const last = response.events.at(-1);
    assert.equal(last.event, 'error');
    assert.equal(last.data.code, 'UPSTREAM_TIMEOUT', 'the SSE idle limit ends the stream, not the request deadline');
    assert.equal(last.data.details.kind, 'IDLE');
  });
});

describe('daemon wiring', () => {
  it('derives <dataDir>/console/settings.json and serves the console routes', async (t) => {
    const dataDir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dataDir),
      clock: createManualClock(HELPER_BASE_MS),
    });
    t.after(async () => daemon.stop('test'));
    await daemon.start();
    const port = daemon.address().port;

    const status = await httpRequest(port, '/api/v1/status', {
      headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    });
    assert.equal(status.status, 200);
    const csrf = status.body.csrf_token;
    const writeSettings = (body) => httpRequest(port, '/api/v1/settings', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${DAEMON_TOKEN}`,
        [CSRF_HEADER]: csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const settings = await httpRequest(port, '/api/v1/settings', {
      headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    });
    assert.equal(settings.status, 200);
    const document = settings.body.settings;
    document.ui.theme = 'dark';
    const saved = await writeSettings({ settings: document });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const settingsFile = join(dataDir, 'console', 'settings.json');
    assert.equal(existsSync(settingsFile), true, 'the daemon must derive the console path from dataDir');
    assert.equal(JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(settingsFile, 'utf8'))).settings.ui.theme, 'dark');

    const schema = await httpRequest(port, '/api/v1/settings/schema', {
      headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    });
    assert.equal(schema.status, 200);
    assert.equal(schema.body.schemaVersion, '1.0');

    const models = await httpRequest(port, '/api/v1/models', {
      headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    });
    assert.equal(models.status, 200);
    assert.equal(models.body.usage.available, false);

    assert.ok(daemon.diagnostics().console !== null);
    assert.equal(typeof daemon.diagnostics().console.broker.spawned, 'number');
    await waitFor(() => daemon.diagnostics().console !== null, { label: 'console diagnostics' });
  });
});
