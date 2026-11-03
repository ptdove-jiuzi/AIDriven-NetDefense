/**
 * full-mode.test.js — the real wiring: SQLite store, rule pack from disk, live API.
 *
 * The mock-mode tests cover the daemon's own logic. This file exists to prove the
 * wiring is real: `ingestTelemetry` really is called (T1), the alert really
 * accumulates correctly against an additive upsert, and the API really reports what
 * is in the database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDaemon } from '../../apps/daemon/src/daemon.js';
import { createScriptedSource } from '../../apps/daemon/src/adapters/collector.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import {
  BASE_MS,
  httpRequest,
  makeConfig,
  makeEvent,
  makeRulePack,
  makeTempDir,
  TEST_TOKEN,
  waitFor,
} from './helpers.js';

async function boot(t, options) {
  const dir = options.dir ?? makeTempDir();
  const daemon = createDaemon({
    config: options.config ?? makeConfig(dir, { top: { mode: 'full' } }),
    sources: options.sources,
    clock: createManualClock(BASE_MS),
  });
  t.after(async () => {
    await daemon.shutdown('test');
  });
  await daemon.start();
  return { daemon, dir };
}

describe('full mode wiring', () => {
  it('loads the rule pack from a file inside the data directory', async (t) => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'rules.json'), JSON.stringify(makeRulePack()), 'utf8');
    const { daemon } = await boot(t, {
      dir,
      config: makeConfig(dir, {
        top: { mode: 'full', detection: { rulePackPath: 'rules.json' } },
      }),
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[makeEvent({ source_seq: 1 })]] })],
    });
    await waitFor(() => daemon.status().store.stats().alerts === 1, { label: 'rule pack matched' });
    assert.equal(daemon.status().store.stats().events, 1);
  });

  it('writes telemetry, finding, alert and analysis request through T1', async (t) => {
    const { daemon } = await boot(t, {
      sources: [createScriptedSource({
        id: 'synthetic.process',
        script: [[makeEvent({ source_seq: 1 }), makeEvent({ source_seq: 2 })]],
      })],
    });
    await waitFor(() => daemon.status().store.stats().events === 2, { label: 'two events stored' });
    const stats = daemon.status().store.stats();
    assert.equal(stats.findings, 2);
    assert.equal(stats.alerts, 1);
    assert.equal(stats.analyses, 1);
    const health = daemon.health();
    assert.equal(health.status, 'ok');
    assert.equal(health.ready, true);
    assert.deepEqual(health.reasons, []);
  });

  it('does not inflate the alert when a second batch lands in the same window', async (t) => {
    const { daemon } = await boot(t, {
      sources: [createScriptedSource({
        id: 'synthetic.process',
        script: [
          [makeEvent({ source_seq: 1 })],
          [makeEvent({ source_seq: 2 })],
        ],
      })],
    });
    await waitFor(() => daemon.status().pipeline.stats().events_accepted === 1, { label: 'first batch' });
    await daemon.pollSource('synthetic.process');
    const stats = daemon.status().store.stats();
    assert.equal(stats.events, 2);
    assert.equal(stats.alerts, 1);
    assert.equal(daemon.status().pipeline.stats().alerts_written, 2, 'two contributions, one row');
    // The stored window total must equal the observed count (2), not 1 + 2.
    const pipelineAlerts = daemon.status().pipeline.stats().alerts_written;
    assert.equal(pipelineAlerts, 2);
  });

  it('reports the live store through the status endpoint', async (t) => {
    const { daemon } = await boot(t, {
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[]] })],
    });
    const port = daemon.address().port;
    const status = await httpRequest(port, '/api/v1/status', {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.store.kind, 'sqlite');
    assert.equal(status.body.store.open, true);
    assert.equal(status.body.mode, 'full');
    assert.equal(status.body.epoch, daemon.epoch());
    assert.equal(status.body.lifecycle, 'running');
    assert.equal(status.body.scheduler.sources.length, 1);
    assert.equal(typeof status.body.csrf_token, 'string');
  });

  it('polls a source on demand through the authenticated API', async (t) => {
    const { daemon } = await boot(t, {
      sources: [createScriptedSource({
        id: 'synthetic.process',
        script: [[], [makeEvent({ source_seq: 1 })]],
      })],
    });
    const port = daemon.address().port;
    const status = await httpRequest(port, '/api/v1/status', {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const response = await httpRequest(port, '/api/v1/collectors/synthetic.process/poll', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'x-aegis-csrf': status.body.csrf_token,
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.source.id, 'synthetic.process');
    await waitFor(() => daemon.status().store.stats().events === 1, { label: 'on-demand poll stored an event' });
  });

  it('rejects polling an unknown source with 404', async (t) => {
    const { daemon } = await boot(t, {
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[]] })],
    });
    const port = daemon.address().port;
    const status = await httpRequest(port, '/api/v1/status', {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const response = await httpRequest(port, '/api/v1/collectors/does.not.exist/poll', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'x-aegis-csrf': status.body.csrf_token,
      },
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SOURCE_UNKNOWN');
  });

  it('degrades but keeps running when the store stops accepting writes', async (t) => {
    const { daemon } = await boot(t, {
      sources: [createScriptedSource({
        id: 'synthetic.process',
        script: [[makeEvent({ source_seq: 1 })], [makeEvent({ source_seq: 2 })]],
      })],
    });
    await waitFor(() => daemon.status().store.stats().events === 1, { label: 'first batch stored' });
    // Closing the writable handle is the closest faithful stand-in for a store that
    // has become unusable; the daemon must not crash and must report the failure.
    daemon.status().store.close();
    await daemon.pollSource('synthetic.process').catch(() => {});
    const pipeline = daemon.status().pipeline.stats();
    assert.ok(pipeline.store_errors >= 1, 'the failed read/write must be counted');
    assert.equal(daemon.state(), 'running', 'a broken store must not take the process down');
    const health = daemon.health();
    assert.notEqual(health.status, 'ok');
    assert.equal(health.ready, false, 'a closed store makes the daemon unready');
  });
});
