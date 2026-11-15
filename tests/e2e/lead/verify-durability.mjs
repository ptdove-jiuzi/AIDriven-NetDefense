/**
 * verify-durability.mjs — "no data loss" across a daemon restart, proven on a throwaway
 * stack so the canonical acceptance stack is never disturbed.
 *
 * It boots a real `apps/daemon/bin.js` in full mode with the real Windows process collector
 * on an isolated port and data directory, waits for telemetry, saves a setting, stops the
 * daemon *and* restarts it, then asks the new process what it knows: the SQLite event count
 * must survive, and the settings document must still hold the value.
 *
 * usage: node tests/e2e/lead/verify-durability.mjs [--out <dir>]
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Checker, parseArgs, writeEvidence } from './common.mjs';

const REPO = process.cwd();
const NODE = process.execPath;
const QA_ROOT = process.env.AIDN_QA_RESTART || 'qa-int/restart-test';
const PORT = 17611;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 300, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* keep waiting */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

async function getJson(path, token) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

async function putJson(path, token, body) {
  const csrf = createHash('sha256').update(`aegis-csrf:${token}`).digest('base64url');
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'x-aegis-csrf': csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

/** Write the throwaway stack's configuration files. */
function provision() {
  mkdirSync(QA_ROOT, { recursive: true });
  const rules = {
    schemaVersion: '1.0',
    packId: 'durability-pack',
    packVersion: '1.0.0',
    rules: [{
      ruleId: 'durability.process.any', version: '1.0.0', type: 'condition', severity: 'low',
      fields: ['name'], fingerprint: ['name'],
      when: { field: 'name', operator: 'exists' },
    }],
  };
  writeFileSync(join(QA_ROOT, 'rules.json'), JSON.stringify(rules, null, 2), 'utf8');
  writeFileSync(join(QA_ROOT, 'daemon.json'), JSON.stringify({
    dataDir: QA_ROOT,
    mode: 'full',
    detection: { rulePackPath: 'rules.json' },
    api: { host: '127.0.0.1', port: PORT },
    scheduler: { tickMs: 3000 },
    logging: { level: 'warn' },
  }, null, 2), 'utf8');
  writeFileSync(join(QA_ROOT, 'collectors.json'), JSON.stringify({
    collectorModule: join(REPO, 'tests', 'e2e', 'fixtures', 'windows-collector-module.mjs'),
    commonModule: join(REPO, 'packages', 'collectors', 'common', 'index.js'),
    createSources: 'createWindowsSources',
    attachSources: 'attachSourcesFlat',
    options: { include: ['processes'] },
  }, null, 2), 'utf8');
}

/** Start the daemon as a detached child and wait until its health endpoint answers. */
function startDaemon(tag) {
  const child = spawn(NODE, [
    join(REPO, 'apps', 'daemon', 'bin.js'),
    '--config', join(QA_ROOT, 'daemon.json'),
    '--collectors', join(QA_ROOT, 'collectors.json'),
  ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.logTag = tag;
  child.collected = () => output;
  return child;
}

/** SIGTERM and wait for the process to really exit. */
async function stopDaemon(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const winner = await Promise.race([exited, sleep(15_000).then(() => 'timeout')]);
  if (winner === 'timeout') child.kill('SIGKILL');
  await sleep(800);
  return winner;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checker = new Checker('telemetry and settings survive a daemon restart');
  const runs = {};
  provision();
  let daemonA = null;
  let daemonB = null;
  try {
    daemonA = startDaemon('A');
    await waitFor(async () => (await getJson('/healthz')).status === 200, { label: 'first daemon healthz' });
    const token = readFileSync(join(QA_ROOT, 'secrets', 'api-token'), 'utf8').trim();
    runs.tokenLength = token.length;

    // Collect some real telemetry before the restart.
    const statusA = await waitFor(async () => {
      const status = await getJson('/api/v1/status', token);
      return status.body?.pipeline?.events_accepted >= 5 ? status.body : false;
    }, { label: 'telemetry accepted' });
    runs.before = {
      events: statusA.pipeline.events_accepted,
      alerts: statusA.health?.status,
      health: statusA.health?.status,
    };
    checker.ok(statusA.pipeline.events_accepted >= 5, 'real telemetry is accepted before the restart', runs.before.events);

    // Persist a harmless setting.
    const settings = await getJson('/api/v1/settings', token);
    const document = settings.body.settings;
    const target = document.ui.density === 'compact' ? 'comfortable' : 'compact';
    document.ui = { ...document.ui, density: target };
    const write = await putJson('/api/v1/settings', token, { settings: document });
    checker.equal(write.status, 200, 'a setting is saved before the restart');
    runs.setting = { target, status: write.status };

    // Restart.
    const stopResult = await stopDaemon(daemonA);
    daemonA = null;
    runs.stop = stopResult;
    checker.equal(stopResult !== 'timeout', true, 'the daemon shuts down cleanly on SIGTERM', stopResult);

    daemonB = startDaemon('B');
    await waitFor(async () => (await getJson('/healthz')).status === 200, { label: 'second daemon healthz' });

    const statusB = await getJson('/api/v1/status', token);
    runs.after = {
      // `pipeline.*` are per-process counters and legitimately restart at zero; the durable
      // numbers are the store's row counts.
      processEvents: statusB.body?.pipeline?.events_accepted ?? null,
      storeEvents: statusB.body?.store?.events ?? null,
      storeAlerts: statusB.body?.store?.alerts ?? null,
      health: statusB.body?.health?.status ?? null,
      startedAt: statusB.body?.started_at ?? null,
      epoch: statusB.body?.epoch ?? null,
    };
    checker.ok((runs.after.storeEvents ?? 0) >= 5, 'the SQLite event count survives the restart', runs.after);
    checker.ok((runs.after.storeAlerts ?? 0) >= 1, 'the derived alerts survive the restart', runs.after.storeAlerts);
    // The recovery epoch is persisted on purpose: the restarted process must resume the same
    // logical instance, not invent a new identity (that is what makes restart-recovery safe).
    checker.equal(runs.after.epoch, statusA.epoch, 'the recovery epoch is stable across the restart', {
      before: statusA.epoch, after: runs.after.epoch,
    });
    checker.ok(runs.after.startedAt !== statusA.started_at, 'the restarted daemon reports a new start time', {
      before: statusA.started_at, after: runs.after.startedAt,
    });

    const settingsB = await getJson('/api/v1/settings', token);
    const restartedDensity = settingsB.body?.settings?.ui?.density ?? null;
    runs.after.setting = restartedDensity;
    checker.equal(restartedDensity, target, 'the saved setting survives the restart (settings.json)', restartedDensity);

    // Put it back so the throwaway directory is left as it was found.
    document.ui = { ...document.ui, density: restartedDensity === 'compact' ? 'comfortable' : 'compact' };
    await putJson('/api/v1/settings', token, { settings: document });
  } finally {
    if (daemonA !== null) await stopDaemon(daemonA);
    if (daemonB !== null) await stopDaemon(daemonB);
  }

  const summary = checker.summary();
  const evidence = writeEvidence(args.out, 'durability.json', {
    at: new Date().toISOString(), port: PORT, qaRoot: QA_ROOT, runs, summary,
  });
  process.stdout.write(`${JSON.stringify({ summary, evidence }, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verify-durability: ${error?.stack ?? error}\n`);
  process.exit(1);
});

