/**
 * console-credentials.test.js — contract §2.3 / §4: the write-only credential route.
 *
 * The red line under test is "the daemon never sees, stores or echoes a secret".
 * These cases fail if that is broken: the 204 body is empty, the mask is produced by
 * the child, the logger capture never contains the canary, and an unknown provider is
 * refused before any child is asked to write.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  TEST_TOKEN,
  createCaptureLogger,
  makeTempDir,
  settingsDocument,
  startConsoleApi,
} from './console-fixtures.mjs';

const CANARY = 'sk-console-canary-0123456789abcdef';

describe('PUT /api/v1/credentials/:providerId', () => {
  it('answers 204 with no body and stores only inside the broker', async (t) => {
    const capture = createCaptureLogger();
    const harness = await startConsoleApi({ logger: capture.logger });
    t.after(() => harness.close());

    const response = await harness.request('/api/v1/credentials/deepseek', {
      method: 'PUT',
      body: { apiKey: CANARY },
    });
    assert.equal(response.status, 204);
    assert.equal(response.text, '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.text.includes(CANARY), false);
    assert.equal(capture.text().includes(CANARY), false, 'the plaintext must never be logged');

    const info = await harness.broker.credentialInfo('deepseek');
    assert.equal(info.hasCredential, true);
    assert.equal(info.masked, `••••${CANARY.slice(-4)}`);
    assert.equal(info.masked.includes(CANARY), false);
    assert.equal(info.lengthBucket, '16-32');

    const models = await harness.request('/api/v1/models');
    assert.equal(models.status, 200);
    const provider = models.body.providers.find((entry) => entry.id === 'deepseek');
    assert.equal(provider.hasCredential, true);
    assert.equal(provider.credential.masked, `••••${CANARY.slice(-4)}`);
    assert.equal(models.text.includes(CANARY), false, 'no route may echo the plaintext');
  });

  it('rejects a malformed secret with a contracted reason and no echo', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const cases = [
      { body: { apiKey: 'short' }, reason: 'TOO_SHORT' },
      { body: { apiKey: 'x'.repeat(600) }, reason: 'TOO_LONG' },
      { body: { apiKey: 'line-one\nline-two' }, reason: 'MULTILINE' },
      { body: { apiKey: '   ' }, reason: 'EMPTY' },
      { body: {}, reason: 'EMPTY' },
    ];
    for (const { body, reason } of cases) {
      const response = await harness.request('/api/v1/credentials/deepseek', { method: 'PUT', body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, 'CREDENTIAL_INVALID');
      assert.equal(response.body.error.details.reason, reason);
      assert.equal(response.text.includes('line-one'), false);
    }
    const unknownField = await harness.request('/api/v1/credentials/deepseek', {
      method: 'PUT',
      body: { apiKey: CANARY, extra: 'x' },
    });
    assert.equal(unknownField.status, 400);
    assert.equal(unknownField.body.error.details.reason, 'FIELD');
    // Nothing was written by any of the refusals.
    assert.equal((await harness.broker.credentialInfo('deepseek')).hasCredential, false);
  });

  it('refuses an unknown provider before writing, and a bad-shaped id', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const unknown = await harness.request('/api/v1/credentials/not-registered', {
      method: 'PUT',
      body: { apiKey: CANARY },
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PROVIDER_UNKNOWN');
    const badShape = await harness.request(`/api/v1/credentials/${encodeURIComponent('Bad_ID')}`, {
      method: 'PUT',
      body: { apiKey: CANARY },
    });
    assert.equal(badShape.status, 400);
    assert.equal(badShape.body.error.code, 'PROVIDER_INVALID');
    assert.equal(badShape.text.includes(CANARY), false);
  });

  it('rejects a non-json body and an oversized body', async (t) => {
    const harness = await startConsoleApi({ maxBodyBytes: 256 });
    t.after(() => harness.close());
    const response = await fetch(`http://127.0.0.1:${harness.address.port}/api/v1/credentials/deepseek`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'x-aegis-csrf': harness.csrfToken,
        'content-type': 'application/json',
      },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const parsed = JSON.parse(await response.text());
    assert.equal(parsed.error.code, 'CREDENTIAL_INVALID');

    const oversized = await harness.request('/api/v1/credentials/deepseek', {
      method: 'PUT',
      body: { apiKey: 'x'.repeat(2000) },
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, 'BODY_TOO_LARGE');
  });

  it('answers 503 when the broker host is absent (fail closed, no crash)', async (t) => {
    const dataDir = makeTempDir();
    const harness = await startConsoleApi({
      dataDir,
      hostPath: join(dataDir, 'missing-console-host.js'),
    });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/credentials/deepseek', {
      method: 'PUT',
      body: { apiKey: CANARY },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'CREDENTIAL_STORE_UNAVAILABLE');
    // The daemon still runs: the settings route answers normally.
    assert.equal((await harness.request('/api/v1/settings')).status, 200);
    assert.equal(existsSync(join(dataDir, 'secrets')), false);
  });
});

describe('DELETE /api/v1/credentials/:providerId', () => {
  it('deletes idempotently and removes the mask from the projection', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    await harness.request('/api/v1/credentials/deepseek', { method: 'PUT', body: { apiKey: CANARY } });
    const first = await harness.request('/api/v1/credentials/deepseek', { method: 'DELETE' });
    assert.equal(first.status, 204);
    assert.equal(first.text, '');
    assert.equal((await harness.broker.credentialInfo('deepseek')).hasCredential, false);
    const second = await harness.request('/api/v1/credentials/deepseek', { method: 'DELETE' });
    assert.equal(second.status, 204);
    const models = await harness.request('/api/v1/models');
    const provider = models.body.providers.find((entry) => entry.id === 'deepseek');
    assert.equal(provider.hasCredential, false);
    assert.equal(provider.credential.masked, null);
  });

  it('has no read route: GET is 405, and an unknown provider is 404', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const read = await harness.request('/api/v1/credentials/deepseek');
    assert.equal(read.status, 405);
    assert.equal(read.body.error.code, 'METHOD_NOT_ALLOWED');
    const unknown = await harness.request('/api/v1/credentials/nope-provider', { method: 'DELETE' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PROVIDER_UNKNOWN');
  });
});

describe('credential metadata projection', () => {
  it('reports healthy:null and no credential for every provider by default', async (t) => {
    const harness = await startConsoleApi({ settings: settingsDocument() });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/models');
    assert.equal(response.status, 200);
    assert.equal(response.body.usage.available, false);
    assert.equal(response.body.usage.reason, 'NO_LEDGER');
    for (const provider of response.body.providers) {
      assert.equal(provider.healthy, null, 'null means "never tested", never green');
      assert.equal(provider.lastCheckedAt, null);
      assert.deepEqual(provider.credential, { masked: null, fingerprint: null, updatedAt: null, lengthBucket: null });
    }
    assert.equal(response.body.engine.harness.available, false);
    assert.equal(response.body.engine.harness.reason, 'PROFILE_NOT_STAGED');
  });
});
