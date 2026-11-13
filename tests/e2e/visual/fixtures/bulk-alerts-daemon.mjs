/**
 * bulk-alerts-daemon.mjs — an independent, throwaway fixture stack for the 5000-row
 * visual/a11y work (author PT-dove).
 *
 * Why: the canonical console (17512) proxies a real daemon that only holds ~100 alerts,
 * which is below the table's virtual-scroll threshold (200). To exercise *the real
 * alerts view* with a full work set we need a daemon that really stores hundreds of
 * alerts. This fixture boots the real daemon in `mock` mode (in-memory event store, no
 * SQLite file), feeds it synthetic events through the real `--collectors` seam, and
 * starts a real `console-next/serve.mjs` in front of it on an ephemeral port.
 *
 * Write-domain discipline: nothing under apps/** is modified. We only import the
 * daemon's public exports and spawn the console host as a child process.
 *
 * Usage (standalone smoke):  node tests/e2e/visual/fixtures/bulk-alerts-daemon.mjs
 * Programmatic:              import { startBulkAlertFixture } from './bulk-alerts-daemon.mjs'
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDaemon } from '../../../../apps/daemon/src/daemon.js';
import { createScriptedSource } from '../../../../apps/daemon/src/adapters/collector.js';
import { canonicalDigest } from '../../../../packages/contracts/src/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const CONSOLE_HOST = join(REPO, 'apps', 'console-next', 'serve.mjs');

/** 32..512 chars of [A-Za-z0-9_-] (daemon config TOKEN_PATTERN). */
export const FIXTURE_TOKEN = 'visual-fixture-token-0123456789abcdef';

/** One rule that matches every fixture event and fingerprints it by `name`, so each
 *  distinct process name becomes its own alert row (this is what makes 600 rows). */
export const FIXTURE_RULE_PACK = Object.freeze({
  schemaVersion: '1.0',
  packId: 'visual-fixture-pack',
  packVersion: '1.0.0',
  rules: [
    {
      ruleId: 'fixture.name.any',
      version: '1.0.0',
      type: 'condition',
      severity: 'medium',
      fields: ['name'],
      fingerprint: ['name'],
      when: { field: 'name', operator: 'exists' },
    },
  ],
});

/**
 * Build one contract-valid event with a unique fingerprint field.
 *
 * @param {number} index 0-based event index.
 * @param {string} observedAt ISO timestamp.
 * @returns {object} Telemetry event.
 */
export function makeFixtureEvent(index, observedAt) {
  const payload = { name: `fixture-proc-${String(index).padStart(4, '0')}.exe`, pid: 4000 + index };
  return {
    schemaVersion: '1.0',
    event_id: randomUUID(),
    stable_source_id: 'visual.fixture.process',
    collector_instance_id: 'visual-fixture-instance',
    source_generation: 1,
    boot_id: 'b'.repeat(32),
    source_seq: index + 1,
    observed_at: observedAt,
    received_at: observedAt,
    type: 'process.start',
    severity: 'medium',
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST an on-demand poll so the fixture does not depend on scheduler ticks. */
async function pollSource(port, sourceId) {
  const auth = { authorization: `Bearer ${FIXTURE_TOKEN}` };
  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { headers: auth });
  const status = await statusResponse.json();
  const csrf = status?.csrf_token;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/collectors/${sourceId}/poll`, {
    method: 'POST',
    headers: { ...auth, ...(csrf === undefined ? {} : { 'x-aegis-csrf': csrf }) },
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`fixture poll failed: ${response.status} ${text.slice(0, 300)}`);
  return text.length === 0 ? null : JSON.parse(text);
}

/**
 * Boot the fixture stack: in-process daemon (mock mode) + child console host.
 *
 * @param {{total?: number, batch?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{consoleUrl: string, daemonPort: number, consolePort: number,
 *   token: string, status: () => Promise<object>, alertsCount: () => Promise<number>,
 *   close: () => Promise<void>}>}
 */
export async function startBulkAlertFixture(options = {}) {
  const total = Number.isInteger(options.total) ? options.total : 600;
  const batch = Number.isInteger(options.batch) ? options.batch : 100;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 30_000;
  const dataDir = mkdtempSync(join(tmpdir(), 'aegis-visual-fixture-'));
  const steps = [];
  for (let start = 0; start < total; start += batch) {
    const observedAt = new Date(Date.now() - (total - start) * 1000).toISOString();
    const chunk = [];
    for (let index = start; index < Math.min(total, start + batch); index += 1) {
      chunk.push(makeFixtureEvent(index, observedAt));
    }
    steps.push(chunk);
  }
  const sourceId = 'visual.fixture.process';
  const daemon = createDaemon({
    config: {
      dataDir,
      mode: 'mock',
      detection: { rulePack: FIXTURE_RULE_PACK },
      api: { host: '127.0.0.1', port: 0, token: FIXTURE_TOKEN },
      scheduler: { tickMs: 3_600_000, maxBatchEvents: 1000 },
      logging: { level: 'error' },
    },
    sources: [createScriptedSource({ id: sourceId, script: steps })],
  });
  await daemon.start();
  const daemonPort = daemon.address().port;

  // Drain every scripted step through the real on-demand poll route.
  for (let index = 0; index < steps.length; index += 1) {
    await pollSource(daemonPort, sourceId);
  }
  const deadline = Date.now() + timeoutMs;
  let alerts = 0;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/alerts?limit=100`, {
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
    });
    const body = await response.json();
    alerts = Array.isArray(body.alerts) ? body.alerts.length : 0;
    const counters = (await (await fetch(`http://127.0.0.1:${daemonPort}/api/v1/status`, {
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
    })).json())?.counters ?? {};
    if ((counters.alerts_written ?? 0) >= total && alerts > 0) break;
    await sleep(100);
  }

  const consoleHost = spawn(process.execPath, [
    CONSOLE_HOST,
    '--daemon', `http://127.0.0.1:${daemonPort}`,
    '--token', FIXTURE_TOKEN,
    '--port', '0',
    '--host', '127.0.0.1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const startup = await new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('fixture console host did not announce a URL in 20s')), 20_000);
    consoleHost.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      const line = buffered.split(/\r?\n/u).find((entry) => entry.trim().startsWith('{'));
      if (line === undefined) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    consoleHost.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture console host exited early with code ${code}`));
    });
  });
  const consoleUrl = String(startup.listening).replace(/\/$/u, '');

  return {
    consoleUrl,
    daemonPort,
    consolePort: Number(new URL(consoleUrl).port),
    token: FIXTURE_TOKEN,
    dataDir,
    async status() {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/status`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      });
      return response.json();
    },
    async alertsCount(pageSize = 100) {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/alerts?limit=${pageSize}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      });
      const body = await response.json();
      return Array.isArray(body.alerts) ? body.alerts.length : 0;
    },
    async close() {
      try {
        consoleHost.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => {
        consoleHost.once('exit', resolve);
        setTimeout(resolve, 3000);
      });
      try {
        await daemon.stop();
      } catch {
        /* best effort */
      }
      await sleep(150);
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* Windows may still hold a handle; OS temp cleanup is acceptable */
      }
    },
  };
}

// Standalone smoke: boot, print counts, exit non-zero when the fixture did not fill.
const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const fixture = await startBulkAlertFixture({ total: 600 });
  try {
    const status = await fixture.status();
    const alerts = await fixture.alertsCount();
    process.stdout.write(`${JSON.stringify({
      consoleUrl: fixture.consoleUrl,
      daemonPort: fixture.daemonPort,
      alertsOnFirstPage: alerts,
      counters: status.counters,
    }, null, 2)}\n`);
    process.exitCode = (status.counters?.alerts_written ?? 0) >= 600 ? 0 : 1;
  } finally {
    await fixture.close();
  }
}
