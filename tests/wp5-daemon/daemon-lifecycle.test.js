/**
 * daemon-lifecycle.test.js — starting, stopping and failing closed.
 *
 * The daemon is the only writer, so "started but broken" is the worst outcome. Each
 * case here asserts either that it refuses to start (and says why) or that a stop
 * releases everything, in order, exactly once.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DAEMON_CODES, DaemonError } from '../../apps/daemon/src/errors.js';
import { createDaemon, DAEMON_VERSION } from '../../apps/daemon/src/daemon.js';
import { createScriptedSource } from '../../apps/daemon/src/adapters/collector.js';
import {
  BASE_MS,
  createManualClock,
  makeConfig,
  makeEvent,
  makeTempDir,
  settle,
  TEST_EPOCH,
  TEST_TOKEN,
} from './helpers.js';

const EPOCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function startDaemon(t, options = {}) {
  const dir = options.dir ?? makeTempDir();
  const clock = options.clock ?? createManualClock(BASE_MS);
  const daemon = createDaemon({
    config: makeConfig(dir, options.config),
    sources: options.sources ?? [createScriptedSource({
      id: 'synthetic.process',
      kind: 'process',
      script: options.script ?? [[makeEvent({ source_seq: 1 })]],
    })],
    clock,
    ...(options.extra ?? {}),
  });
  t.after(async () => {
    await daemon.shutdown('test');
  });
  const started = await daemon.start();
  return { daemon, dir, clock, started };
}

describe('daemon start', () => {
  it('reaches running, mints an epoch and binds the control API', async (t) => {
    const { daemon, dir, started } = await startDaemon(t);
    assert.equal(daemon.state(), 'running');
    assert.match(started.epoch, EPOCH_UUID);
    assert.equal(started.address.host, '127.0.0.1');
    assert.ok(started.address.port > 0);
    assert.equal(existsSync(join(dir, 'daemon-state.json')), true);
    assert.equal(existsSync(join(dir, 'secrets', 'api-token')), false, 'an inline token must not be persisted');
    assert.equal(daemon.status().version, DAEMON_VERSION);
  });

  it('honours an epoch supplied by configuration', async (t) => {
    const { started } = await startDaemon(t, {
      config: { top: { policy: { epoch: TEST_EPOCH } } },
    });
    assert.equal(started.epoch, TEST_EPOCH);
  });

  it('reports not-started state before start()', () => {
    const dir = makeTempDir();
    const daemon = createDaemon({ config: makeConfig(dir), clock: createManualClock(BASE_MS) });
    assert.equal(daemon.state(), 'created');
    const status = daemon.status();
    assert.equal(status.lifecycle, 'created');
    assert.equal(status.health.ready, false);
    assert.deepEqual(status.health.reasons, ['not-started']);
  });

  it('runs with the API disabled', async (t) => {
    const { daemon, started } = await startDaemon(t, { config: { api: { enabled: false } } });
    assert.equal(started.address, null);
    assert.equal(daemon.address(), null);
    assert.equal(daemon.csrfToken(), null);
    assert.equal(daemon.state(), 'running');
  });

  it('starts in mock mode with no sources and reports degraded, not failed', async (t) => {
    const dir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dir),
      sources: [],
      clock: createManualClock(BASE_MS),
    });
    t.after(async () => daemon.shutdown('test'));
    await daemon.start();
    const health = daemon.health();
    assert.equal(health.status, 'degraded');
    assert.ok(health.reasons.includes('sources:none'));
    assert.equal(health.ready, true, 'no collectors configured is a degradation, not unreadiness');
  });

  it('refuses to start in full mode without a collector source', async (t) => {
    const dir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dir, { top: { mode: 'full' } }),
      sources: [],
      clock: createManualClock(BASE_MS),
    });
    await assert.rejects(() => daemon.start(), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
      assert.match(error.message, /at least one collector source/u);
      return true;
    });
    assert.equal(daemon.state(), 'failed');
  });

  it('fails closed when the store cannot be opened', async (t) => {
    const dir = makeTempDir();
    const brokenStore = {
      kind: 'broken',
      open() {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'cannot open');
      },
      hasEvent: () => false,
      ingest: () => {
        throw new Error('never');
      },
      stats: () => ({ events: 0, alerts: 0, findings: 0, analyses: 0 }),
      isOpen: () => false,
      close() {},
    };
    const daemon = createDaemon({
      config: makeConfig(dir),
      sources: [createScriptedSource({ id: 'synthetic.process', script: [[]] })],
      store: brokenStore,
      clock: createManualClock(BASE_MS),
    });
    await assert.rejects(() => daemon.start(), (error) => {
      assert.equal(error.code, DAEMON_CODES.STORE_UNAVAILABLE);
      return true;
    });
    assert.equal(daemon.state(), 'failed');
    assert.equal(daemon.address(), null);
  });

  it('starts over a corrupt checkpoint and preserves the corrupt file', async (t) => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'daemon-state.json'), '{ nope', 'utf8');
    const { daemon } = await startDaemon(t, { dir });
    assert.equal(daemon.state(), 'running');
    assert.equal(daemon.diagnostics().checkpoint.corrupt_on_load, true);
    assert.equal(daemon.diagnostics().checkpoint.quarantines, 1);
    const quarantined = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.equal(readFileSync(join(dir, quarantined[0]), 'utf8'), '{ nope');
  });
});

describe('daemon stop', () => {
  it('stops cleanly, persists the checkpoint and is idempotent', async (t) => {
    const { daemon, dir } = await startDaemon(t);
    await settle();
    const first = await daemon.stop('test');
    assert.equal(first.stopped, true);
    assert.equal(daemon.state(), 'stopped');

    const checkpoint = JSON.parse(readFileSync(join(dir, 'daemon-state.json'), 'utf8'));
    assert.match(checkpoint.epoch, EPOCH_UUID);
    assert.ok(checkpoint.counters.events_received >= 1);
    assert.ok(checkpoint.sources['synthetic.process'] !== undefined);

    const second = await daemon.stop('again');
    assert.equal(second.stopped, true);
    assert.deepEqual(second.errors, []);
  });

  it('stops a daemon that was never started without acquiring anything', async () => {
    const dir = makeTempDir();
    const daemon = createDaemon({ config: makeConfig(dir), clock: createManualClock(BASE_MS) });
    const result = await daemon.stop('early');
    assert.equal(result.stopped, true);
    assert.equal(daemon.state(), 'stopped');
  });

  it('drains an in-flight poll or abandons it within the drain budget', async (t) => {
    const dir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dir, { top: { shutdown: { drainMs: 100, graceMs: 100 } } }),
      sources: [createScriptedSource({ id: 'synthetic.hung', script: [{ hang: true }] })],
      clock: createManualClock(BASE_MS),
    });
    await daemon.start();
    const started = Date.now();
    const result = await daemon.shutdown('test');
    const elapsed = Date.now() - started;
    assert.equal(result.stopped, true);
    assert.ok(elapsed < 2000, `shutdown took ${elapsed}ms and must not wait for the hung source`);
    assert.equal(daemon.state(), 'stopped');
  });

  it('exposes shutdown() as a never-throwing wrapper', async (t) => {
    const { daemon } = await startDaemon(t);
    const result = await daemon.shutdown('signal');
    assert.equal(result.stopped, true);
    const again = await daemon.shutdown('signal-again');
    assert.equal(again.stopped, true);
  });

  it('reports degraded health for a source that failed', async (t) => {
    const { daemon } = await startDaemon(t, {
      script: [{ error: 'boom' }],
    });
    await settle();
    const health = daemon.health();
    assert.equal(health.status, 'degraded');
    assert.ok(health.reasons.some((reason) => reason.startsWith('sources:degraded')));
    assert.equal(health.ready, true);
  });
});

describe('daemon diagnostics', () => {
  it('reports API and auth counters without secrets', async (t) => {
    const { daemon } = await startDaemon(t);
    const diagnostics = daemon.diagnostics();
    assert.equal(diagnostics.api.rejected, 0);
    assert.equal(diagnostics.auth.accepted, 0);
    assert.match(diagnostics.checkpoint.path, /daemon-state\.json$/u);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes(TEST_TOKEN), false);
  });

  it('reports the effective configuration without the token', async (t) => {
    const { daemon, dir } = await startDaemon(t);
    const config = daemon.config();
    assert.equal(config.dataDir, dir);
    assert.equal(config.api_host, '127.0.0.1');
    assert.equal(JSON.stringify(config).includes(TEST_TOKEN), false);
  });
});

