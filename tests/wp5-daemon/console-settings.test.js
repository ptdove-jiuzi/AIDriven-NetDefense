/**
 * console-settings.test.js — contract §2.8 / §6: the closed settings document, the
 * atomic store, and `GET/PUT /api/v1/settings` + `GET /api/v1/settings/schema`.
 *
 * These tests are written to fail if the feature is removed: deleting the unknown-key
 * check, the schema/default table link, the `discardCredential` gate or the corrupt-file
 * warning each turns at least one case red (mutation notes are in the status file).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_SETTINGS,
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
  SETTINGS_SCHEMA_VERSION,
  describeSettingsSchema,
  readPath,
  validateSettingsDocument,
} from '../../apps/daemon/src/api/settings-schema.js';
import { mergeWithDefaults } from '../../apps/daemon/src/api/settings.js';
import {
  makeTempDir,
  settingsDocument,
  startConsoleApi,
  writeRawSettingsFile,
} from './console-fixtures.mjs';

const SETTINGS_FILE = (dataDir) => join(dataDir, 'console', 'settings.json');

describe('settings schema table', () => {
  it('describes every stored field and its default matches the defaults table', () => {
    const schema = describeSettingsSchema();
    assert.equal(schema.schemaVersion, SETTINGS_SCHEMA_VERSION);
    assert.deepEqual(schema.groups.map((group) => group.id), [...SETTINGS_GROUPS, 'about']);

    let checked = 0;
    for (const group of schema.groups) {
      for (const item of group.items) {
        assert.equal(typeof item.path, 'string');
        assert.equal(typeof item.labelKey, 'string');
        // Contract §8.3 key grammar: lower-case, dot separated.
        assert.match(item.labelKey, /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/u);
        if (item.path.startsWith('about.')) {
          // The `about` group is injected (schema + /status), never stored.
          continue;
        }
        const expected = readPath(DEFAULT_SETTINGS, item.path);
        assert.equal(expected.found, true, `${item.path} must exist in DEFAULT_SETTINGS`);
        assert.deepEqual(item.default, expected.value, `${item.path} descriptor default must equal the settings default`);
        checked += 1;
      }
    }
    assert.ok(checked > 40, `expected a full settings table, checked ${checked}`);
  });

  it('publishes the wired diagnostics actions and the remaining unwired ones', () => {
    const schema = describeSettingsSchema();
    const actionIds = schema.actions.map((action) => action.id);
    assert.deepEqual(actionIds, [
      'diagnostics.exportBundle',
      'diagnostics.rotateToken',
      'update.checkNow',
      'update.rollback',
      'response.runAction',
    ]);
    // OPS-DIAG: the two diagnostics actions are wired (real routes mounted by
    // `daemon.js`); the remaining three still answer 501 and must say so.
    const wired = schema.actions.filter((action) => action.available === true);
    assert.deepEqual(wired.map((action) => action.id), ['diagnostics.exportBundle', 'diagnostics.rotateToken']);
    for (const action of wired) {
      assert.equal(action.reason, null, `${action.id} must not advertise a reason once wired`);
      assert.match(action.endpoint, /^\/api\/v1\/diagnostics\//u);
    }
    const unwired = schema.actions.filter((action) => action.available !== true);
    assert.deepEqual(unwired.map((action) => action.id), ['update.checkNow', 'update.rollback', 'response.runAction']);
    for (const action of unwired) {
      assert.equal(action.reason, 'NOT_IMPLEMENTED_0_0_1');
    }
    assert.ok(schema.actionCatalog.length >= 5);
    for (const action of schema.actionCatalog) {
      assert.ok(['allow', 'needs_approval', 'deny'].includes(action.decision));
    }
    // `wired:false` must be explicit so the UI can label it "saved, not in effect".
    const unwiredItems = schema.groups.flatMap((group) => group.items).filter((item) => item.wired === false);
    assert.deepEqual(unwiredItems.map((item) => item.path).sort(), [
      'ui.autostart',
      'ui.trayBehavior',
      'update.autoCheck',
    ]);
  });

  it('rejects unknown keys with a schema path', () => {
    assert.throws(
      () => validateSettingsDocument({ models: { egressEnabled: true, surprise: 1 } }),
      (error) => error.code === 'SETTINGS_INVALID'
        && error.details.path === 'models.surprise'
        && error.details.rule === 'unknown',
    );
    assert.throws(
      () => validateSettingsDocument({ typoGroup: {} }),
      (error) => error.code === 'SETTINGS_INVALID' && error.details.path === 'typoGroup',
    );
  });

  it('rejects bad types, ranges and enums with the field path', () => {
    assert.throws(
      () => validateSettingsDocument({ ui: { theme: 'neon' } }),
      (error) => error.details.path === 'ui.theme' && error.details.rule === 'enum',
    );
    assert.throws(
      () => validateSettingsDocument({ collection: { pollIntervalMs: 10 } }),
      (error) => error.details.path === 'collection.pollIntervalMs' && error.details.rule === 'integer',
    );
    assert.throws(
      () => validateSettingsDocument({ models: { agent: { temperature: 9 } } }),
      (error) => error.details.path === 'models.agent.temperature',
    );
  });

  it('refuses uniform routing without a registered uniform model', () => {
    assert.throws(
      () => validateSettingsDocument({
        models: {
          routing: { mode: 'uniform', uniformModelId: null },
        },
      }),
      (error) => error.code === 'SETTINGS_INVALID'
        && error.details.path === 'models.routing.uniformModelId'
        && error.details.rule === 'uniform_model_required',
    );
    assert.throws(
      () => validateSettingsDocument({
        models: {
          routing: { mode: 'uniform', uniformModelId: 'missing-model' },
        },
      }),
      (error) => error.details.path === 'models.routing.uniformModelId'
        && error.details.rule === 'model_unknown',
    );
  });

  it('applies ADR-0010 URL rules: https, no userinfo/query, loopback only over http', () => {
    const base = settingsDocument();
    const withProvider = (provider) => ({
      models: {
        providers: [provider],
        models: [{ ...base.models.models[0], providerId: 'p1' }],
      },
    });
    const valid = { id: 'p1', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', enabled: false, allowLoopback: false, dailyInputTokens: 1, dailyOutputTokens: 1, pricing: null };
    assert.doesNotThrow(() => validateSettingsDocument(withProvider(valid)));
    for (const baseUrl of [
      'http://api.example.com/v1',
      'https://user:pass@api.example.com/v1',
      'https://api.example.com/v1?x=1',
      'https://api.example.com/v1#frag',
      'ftp://api.example.com/v1',
      'https://api.example.com',
    ]) {
      assert.throws(
        () => validateSettingsDocument(withProvider({ ...valid, baseUrl })),
        (error) => error.code === 'PROVIDER_INVALID',
        `expected ${baseUrl} to be refused`,
      );
    }
    // Plain http is allowed only for a literal loopback host with allowLoopback.
    assert.doesNotThrow(() => validateSettingsDocument(withProvider({
      ...valid,
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      allowLoopback: true,
    })));
    assert.throws(
      () => validateSettingsDocument(withProvider({
        ...valid,
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        allowLoopback: false,
      })),
      (error) => error.code === 'PROVIDER_INVALID',
    );
  });

  it('refuses more than eight providers and a read-only field change', () => {
    const base = settingsDocument();
    const providers = Array.from({ length: 9 }, (_, index) => ({
      id: `p${index}`,
      kind: 'openai-compatible',
      baseUrl: `https://api${index}.example.com/v1`,
      enabled: false,
      allowLoopback: false,
      dailyInputTokens: 1,
      dailyOutputTokens: 1,
      pricing: null,
    }));
    assert.throws(
      () => validateSettingsDocument({ models: { providers, models: [] } }),
      (error) => error.code === 'PROVIDER_LIMIT',
    );
    assert.throws(
      () => validateSettingsDocument({ response: { executionEnabled: true } }),
      (error) => error.details.path === 'response.executionEnabled' && error.details.rule === 'read_only',
    );
    assert.equal(base.response.executionEnabled, false);
  });
});

describe('GET/PUT /api/v1/settings', () => {
  it('returns the defaults with live read-only fields', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/settings');
    assert.equal(response.status, 200);
    assert.equal(response.body.schemaVersion, '1.0');
    assert.ok(Array.isArray(response.body.warnings));
    assert.deepEqual(response.body.warnings, []);
    assert.equal(response.body.settings.models.egressEnabled, false);
    assert.equal(response.body.settings.response.executionEnabled, false);
    assert.equal(response.body.settings.update.currentVersion, 'test-version');
    assert.equal(response.body.settings.diagnostics.apiPort, null);
    // The defaults themselves are still closed: no about group in the stored document.
    assert.equal(Object.hasOwn(response.body.settings, 'about'), false);
  });

  it('saves a valid document, atomically and with the expected classifications', async (t) => {
    const dataDir = makeTempDir();
    const harness = await startConsoleApi({ dataDir });
    t.after(() => harness.close());
    const document = settingsDocument({
      ui: { theme: 'dark' },
      collection: { retention: { eventDays: 14 } },
    });
    document.ui.autostart = true;
    const response = await harness.request('/api/v1/settings', { method: 'PUT', body: { settings: document } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.appliedNow.includes('ui.theme'), true);
    assert.equal(response.body.appliedNow.includes('ui.autostart'), true);
    assert.equal(response.body.restartRequired.includes('collection.retention.eventDays'), true);
    assert.equal(response.body.warnings.includes('NOT_WIRED:ui.autostart'), true);
    assert.equal(response.body.updatedAt, '2026-11-04T12:00:00.000Z');

    const stored = JSON.parse(readFileSync(SETTINGS_FILE(dataDir), 'utf8'));
    assert.equal(stored.schemaVersion, '1.0');
    assert.equal(stored.settings.ui.theme, 'dark');
    assert.equal(stored.settings.collection.retention.eventDays, 14);
    // Read-only fields are never persisted.
    assert.equal(Object.hasOwn(stored.settings.update, 'currentVersion'), false);
    assert.equal(Object.hasOwn(stored.settings.diagnostics, 'apiPort'), false);
    // No temp file left behind.
    assert.deepEqual(readdirSync(join(dataDir, 'console')).filter((name) => name.endsWith('.tmp')), []);

    const reread = await harness.request('/api/v1/settings');
    assert.equal(reread.body.settings.ui.theme, 'dark');
  });

  it('dryRun validates and classifies without writing', async (t) => {
    const dataDir = makeTempDir();
    const harness = await startConsoleApi({ dataDir });
    t.after(() => harness.close());
    const before = readFileSync(SETTINGS_FILE(dataDir), 'utf8');
    const document = settingsDocument({ ui: { theme: 'light' } });
    const response = await harness.request('/api/v1/settings', {
      method: 'PUT',
      body: { settings: document, dryRun: true },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.settings.ui.theme, 'light');
    assert.deepEqual(response.body.appliedNow, ['ui.theme']);
    assert.equal(readFileSync(SETTINGS_FILE(dataDir), 'utf8'), before);
    const reread = await harness.request('/api/v1/settings');
    assert.equal(reread.body.settings.ui.theme, 'system');
  });

  it('rejects an unknown key/body field with SETTINGS_INVALID and a path', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const invalid = await harness.request('/api/v1/settings', {
      method: 'PUT',
      body: { settings: settingsDocument({ ui: { nope: true } }) },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'SETTINGS_INVALID');
    assert.equal(invalid.body.error.details.path, 'ui.nope');
    const invalidBody = await harness.request('/api/v1/settings', {
      method: 'PUT',
      body: { settings: settingsDocument(), merge: true },
    });
    assert.equal(invalidBody.status, 400);
    assert.equal(invalidBody.body.error.details.rule, 'unknown_key');
  });

  it('reports a corrupt file as defaults + warning and does not overwrite it', async (t) => {
    const dataDir = makeTempDir();
    const raw = '{ definitely not json';
    const harness = await startConsoleApi({ dataDir, rawSettingsText: raw });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/settings');
    assert.equal(response.status, 200);
    assert.match(response.body.warnings[0], /^SETTINGS_CORRUPT:[0-9a-f]{8}$/u);
    assert.equal(response.body.settings.models.egressEnabled, false);
    assert.equal(readFileSync(SETTINGS_FILE(dataDir), 'utf8'), raw);
  });

  it('locks a provider removal that still has a credential, then discards on request', async (t) => {
    const dataDir = makeTempDir();
    const harness = await startConsoleApi({ dataDir });
    t.after(() => harness.close());
    await harness.broker.putCredential({ providerId: 'deepseek', apiKey: 'sk-stub-canary-0123456789' });
    assert.equal((await harness.broker.credentialInfo('deepseek')).hasCredential, true);

    const withoutProvider = settingsDocument({ models: { providers: [], models: [] } });
    const locked = await harness.request('/api/v1/settings', { method: 'PUT', body: { settings: withoutProvider } });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, 'SETTINGS_LOCKED');
    assert.equal(locked.body.error.details.providerId, 'deepseek');

    const discarded = await harness.request('/api/v1/settings', {
      method: 'PUT',
      body: { settings: withoutProvider, discardCredential: true },
    });
    assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
    assert.equal((await harness.broker.credentialInfo('deepseek')).hasCredential, false);
    const settings = await harness.request('/api/v1/settings');
    assert.deepEqual(settings.body.settings.models.providers, []);
  });

  it('answers GET /api/v1/settings/schema with the render description', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/settings/schema');
    assert.equal(response.status, 200);
    assert.equal(response.body.schemaVersion, '1.0');
    const models = response.body.groups.find((group) => group.id === 'models');
    const egress = models.items.find((item) => item.path === 'models.egressEnabled');
    assert.equal(egress.dangerous, true);
    assert.equal(egress.labelKey, 'settings.models.egress.label');
    assert.equal(response.body.actions.length, 5);
    assert.ok(response.body.actionCatalog.some((action) => action.id === 'network.isolate'));
  });
});

describe('partial stored document must be normalized by the API (rework)', () => {
  const PARTIAL = {
    models: {
      egressEnabled: true,
      providers: [],
      models: [],
    },
    ui: { theme: 'dark' },
  };

  function partialFileText() {
    return `${JSON.stringify({
      schemaVersion: '1.0',
      updatedAt: '2026-11-04T00:00:00.000Z',
      settings: PARTIAL,
    }, null, 2)}\n`;
  }

  it('mergeWithDefaults completes a partial document (objects merge, arrays replace)', () => {
    const merged = mergeWithDefaults(PARTIAL);
    assert.deepEqual(Object.keys(merged).sort(), SETTINGS_GROUPS.slice().sort());
    assert.deepEqual(merged.models.providers, []);
    assert.deepEqual(merged.models.models, []);
    assert.equal(merged.models.egressEnabled, true);
    assert.equal(merged.ui.theme, 'dark');
    // Groups absent from the stored document come from the defaults, leaf by leaf.
    assert.equal(merged.response.approvalMode, DEFAULT_SETTINGS.response.approvalMode);
    assert.deepEqual(merged.response.actionMatrix, DEFAULT_SETTINGS.response.actionMatrix);
    assert.equal(merged.update.checkIntervalHours, DEFAULT_SETTINGS.update.checkIntervalHours);
    assert.equal(merged.detection.thresholds.count, DEFAULT_SETTINGS.detection.thresholds.count);
    assert.equal(merged.collection.pollIntervalMs, DEFAULT_SETTINGS.collection.pollIntervalMs);
    assert.equal(merged.diagnostics.logLevel, DEFAULT_SETTINGS.diagnostics.logLevel);
    // The default document itself is not mutated by the merge.
    assert.deepEqual(DEFAULT_SETTINGS.models.providers.length, 1);
  });

  it('GET returns the complete document with no warnings for a partial file', async (t) => {
    const dataDir = makeTempDir();
    writeRawSettingsFile(dataDir, partialFileText());
    const harness = await startConsoleApi({ dataDir, rawSettingsText: partialFileText() });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/settings');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.warnings, []);
    const settings = response.body.settings;
    assert.deepEqual(Object.keys(settings).sort(), SETTINGS_GROUPS.slice().sort());
    // Stored values survive…
    assert.equal(settings.models.egressEnabled, true);
    assert.equal(settings.ui.theme, 'dark');
    assert.deepEqual(settings.models.providers, []);
    // …and every leaf of the groups the file never mentioned is present.
    for (const group of SETTINGS_GROUPS) {
      for (const item of SETTINGS_ITEMS.filter((entry) => entry.path.startsWith(`${group}.`))) {
        assert.equal(readPath(settings, item.path).found, true, `${item.path} must be present in GET`);
      }
    }
    assert.equal(settings.response.approvalMode, 'high-only');
    assert.equal(settings.response.executionEnabled, false);
    assert.equal(settings.update.channel, 'stable');
    assert.equal(settings.update.currentVersion, 'test-version');
    assert.equal(settings.diagnostics.apiPort, null);
  });

  it('PUT persists a change inside a group that also holds a read-only field', async (t) => {
    const harness = await startConsoleApi();
    t.after(() => harness.close());
    const current = await harness.request('/api/v1/settings');
    const next = current.body.settings;
    // A change in `response` (alongside the read-only `executionEnabled`) and one in
    // `update` (alongside two read-only fields): a destructive group overlay would drop
    // these and leave only the read-only leaves behind.
    next.response.approvalMode = 'always';
    next.response.actionMatrix['process.terminate'] = 'deny';
    next.update.channel = 'beta';
    const saved = await harness.request('/api/v1/settings', { method: 'PUT', body: { settings: next } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const reread = (await harness.request('/api/v1/settings')).body.settings;
    assert.equal(reread.response.approvalMode, 'always');
    assert.equal(reread.response.actionMatrix['process.terminate'], 'deny');
    assert.equal(reread.update.channel, 'beta');
    assert.equal(reread.response.executionEnabled, false);
    assert.equal(reread.update.currentVersion, 'test-version');
    assert.ok(Object.keys(reread.response).length >= 5, 'the response group must not collapse to one leaf');
    assert.ok(Object.keys(reread.update).length >= 5, 'the update group must not collapse to one leaf');

    const readOnlyChange = JSON.parse(JSON.stringify(next));
    readOnlyChange.response.executionEnabled = true;
    const refused = await harness.request('/api/v1/settings', { method: 'PUT', body: { settings: readOnlyChange } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'SETTINGS_INVALID');
    assert.equal(refused.body.error.details.path, 'response.executionEnabled');
    assert.equal(refused.body.error.details.rule, 'read_only');
  });

  it('PUT still rejects unknown keys when the stored document was partial, and round-trips', async (t) => {
    const dataDir = makeTempDir();
    writeRawSettingsFile(dataDir, partialFileText());
    const harness = await startConsoleApi({ dataDir, rawSettingsText: partialFileText() });
    t.after(() => harness.close());
    const invalid = await harness.request('/api/v1/settings', {
      method: 'PUT',
      body: { settings: { ...PARTIAL, injected: {} } },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'SETTINGS_INVALID');
    assert.equal(invalid.body.error.details.path, 'injected');

    const current = await harness.request('/api/v1/settings');
    const next = current.body.settings;
    next.ui.theme = 'light';
    next.models.egressEnabled = false;
    const saved = await harness.request('/api/v1/settings', { method: 'PUT', body: { settings: next } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const reread = await harness.request('/api/v1/settings');
    assert.equal(reread.body.settings.ui.theme, 'light');
    assert.equal(reread.body.settings.models.egressEnabled, false);
    assert.deepEqual(Object.keys(reread.body.settings).sort(), SETTINGS_GROUPS.slice().sort());
    const stored = JSON.parse(readFileSync(join(dataDir, 'console', 'settings.json'), 'utf8'));
    // The persisted document is complete as well: a later GET cannot become partial.
    assert.deepEqual(Object.keys(stored.settings).sort(), SETTINGS_GROUPS.slice().sort());
  });
});
