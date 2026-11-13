#!/usr/bin/env node
/**
 * run-stack.mjs — bring up the two UI2 runtime stacks from a cold start, with a gate
 * that fails closed (author PT-dove).
 *
 * Stacks (canonical ports, only the integrator/Lead may start them):
 *   data : daemon `apps/daemon/bin.js --config <qa>/daemon.json --collectors <qa>/collectors.json`
 *          (mode=full, SQLite, real Windows process collector) + console host on 17512
 *   mock : daemon `apps/daemon/bin.js --config <qa>/mock/daemon-mock.json`
 *          (mode=mock, in-memory store, zero events) + console host on 17522
 *
 * Properties this script is required to have:
 *   1. **Idempotent** — if a stack is already healthy and behaviourally correct, reuse it
 *      and say so (`reused: true`); never start a second copy. A port that is occupied by
 *      something unhealthy is a *conflict*, not a reason to kill anything.
 *   2. **Gated** — a stack only counts as up when: `/healthz` matches the expected mode,
 *      the bearer-token `/api/v1/status` proves the data state (events > 0 for data,
 *      exactly 0 for mock), the console host printed its listening URL, the host's
 *      `/healthz` matches the daemon's, and the host's *proxied* `/api/v1/status` counters
 *      equal the daemon's (i.e. the browser path really reaches this daemon).
 *   3. **Receipted** — writes JSON evidence plus a `.state` file that stop-stack.mjs uses
 *      to kill only PIDs this tool started.
 *
 * Usage:
 *   node tests/e2e/runtime/run-stack.mjs [--stacks data,mock] [--qa-root <dir>]
 *        [--json <path>] [--timeout-ms 60000] [--settle-events-ms 45000] [--quiet]
 *
 * Exit 0 only when every requested stack passes every gate. Never kills anything.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CANONICAL,
  DEFAULT_QA_ROOT,
  EVIDENCE_ROOT,
  NODE_EXE,
  NODE_VERSION,
  REPO_ROOT,
  computeBuildFingerprint,
  describePort,
  describeProcesses,
  displayPath,
  ensureDir,
  findListeningPid,
  fromRepo,
  httpGet,
  isAlive,
  nowIso,
  parseArgs,
  readJsonFile,
  readTokenFile,
  sleep,
  splitList,
  stateFileFor,
  writeJsonFile,
} from './lib/runtime.mjs';

/** Parse an optional integer CLI value; null when absent. */
function numberOrNull(value) {
  if (value === null || value === undefined || value === true) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Build the spec for one stack from the QA data root.
 *
 * `ports` lets a cold-start proof run on isolated ports (see `--provision`), so the
 * evidence can be produced without touching the canonical stacks the team shares.
 */
export function stackSpec(id, qaRoot, ports = {}) {
  if (id === 'data') {
    const daemonConfig = join(qaRoot, 'daemon.json');
    const daemonPort = configPort(daemonConfig) ?? ports.daemonPort ?? CANONICAL.data.daemonPort;
    const hostPort = ports.hostPort ?? CANONICAL.data.hostPort;
    return {
      id,
      label: 'data — real daemon (mode=full) + Windows process collector',
      daemonConfig,
      daemonArgs: [join(REPO_ROOT, 'apps', 'daemon', 'bin.js'), '--config', daemonConfig,
        '--collectors', join(qaRoot, 'collectors.json')],
      daemonPort,
      hostPort,
      tokenFile: join(qaRoot, 'secrets', 'api-token'),
      logDaemon: join(qaRoot, 'logs', `daemon-${daemonPort}.log`),
      logHost: join(qaRoot, 'logs', `console-host-${hostPort}.log`),
      expect: { healthz: ['ok'], dataState: 'has-events' },
    };
  }
  if (id === 'mock') {
    const daemonConfig = join(qaRoot, 'mock', 'daemon-mock.json');
    const daemonPort = configPort(daemonConfig) ?? ports.daemonPort ?? CANONICAL.mock.daemonPort;
    const hostPort = ports.hostPort ?? CANONICAL.mock.hostPort;
    return {
      id,
      label: 'mock — daemon (mode=mock, empty in-memory store)',
      daemonConfig,
      daemonArgs: [join(REPO_ROOT, 'apps', 'daemon', 'bin.js'), '--config', daemonConfig],
      daemonPort,
      hostPort,
      tokenFile: join(qaRoot, 'mock', 'secrets', 'api-token'),
      logDaemon: join(qaRoot, 'logs', `daemon-${daemonPort}.log`),
      logHost: join(qaRoot, 'logs', `console-host-${hostPort}.log`),
      expect: { healthz: ['degraded', 'ok'], dataState: 'empty' },
    };
  }
  throw new Error(`unknown stack: ${id}`);
}

/** Default rule pack for a provisioned QA root (same shape as the canonical live pack). */
const DEFAULT_RULES = Object.freeze({
  schemaVersion: '1.0',
  packId: 'ui2-runtime-provisioned',
  packVersion: '1.0.0',
  rules: [
    {
      ruleId: 'live.process.any',
      version: '1.0.0',
      type: 'condition',
      severity: 'medium',
      fields: ['name'],
      fingerprint: ['name'],
      when: { field: 'name', operator: 'exists' },
    },
    {
      ruleId: 'live.process.shell',
      version: '1.0.0',
      type: 'condition',
      severity: 'high',
      fields: ['name'],
      fingerprint: ['name'],
      when: { field: 'name', operator: 'in', value: ['node.exe', 'powershell.exe', 'msedge.exe', 'explorer.exe'] },
    },
  ],
});

/**
 * Create a complete, isolated QA root from nothing: daemon configs, rule pack, collector
 * spec, token files and log dirs. This is what makes "start from zero" testable without
 * reusing (or racing) the shared canonical stack.
 *
 * Existing files are left alone unless `force` is set.
 */
export function provisionQaRoot(qaRoot, ports, options = {}) {
  const force = options.force === true;
  const written = [];
  const preserved = [];
  const write = (path, value) => {
    if (!force && existsSync(path)) {
      preserved.push(path);
      return;
    }
    writeJsonFile(path, value);
    written.push(path);
  };
  const writeText = (path, text) => {
    if (!force && existsSync(path)) {
      preserved.push(path);
      return;
    }
    ensureDir(dirname(path));
    writeFileSync(path, text, 'utf8');
    written.push(path);
  };

  assertDir(qaRoot);
  ensureDir(join(qaRoot, 'logs'));
  ensureDir(join(qaRoot, 'store'));
  ensureDir(join(qaRoot, 'mock', 'logs'));
  ensureDir(join(qaRoot, 'secrets'));
  ensureDir(join(qaRoot, 'mock', 'secrets'));

  const dataDaemonPort = ports.daemonPort ?? CANONICAL.data.daemonPort;
  const mockDaemonPort = (ports.mock ?? {}).daemonPort ?? CANONICAL.mock.daemonPort;

  write(join(qaRoot, 'daemon.json'), {
    dataDir: qaRoot,
    mode: 'full',
    detection: { rulePackPath: 'rules.json' },
    api: { host: '127.0.0.1', port: dataDaemonPort },
    scheduler: { tickMs: 5000 },
    logging: { level: 'info' },
  });
  write(join(qaRoot, 'collectors.json'), {
    collectorModule: join(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'windows-collector-module.mjs'),
    commonModule: join(REPO_ROOT, 'packages', 'collectors', 'common', 'index.js'),
    createSources: 'createWindowsSources',
    attachSources: 'attachSourcesFlat',
    options: { include: ['processes'] },
  });
  write(join(qaRoot, 'rules.json'), DEFAULT_RULES);
  write(join(qaRoot, 'mock', 'daemon-mock.json'), {
    dataDir: join(qaRoot, 'mock'),
    mode: 'mock',
    detection: { rulePackPath: 'rules.json' },
    api: { host: '127.0.0.1', port: mockDaemonPort },
    scheduler: { tickMs: 60000 },
    logging: { level: 'info' },
  });
  write(join(qaRoot, 'mock', 'rules.json'), DEFAULT_RULES);
  // Tokens are generated per provisioned root; they never leave this machine and the
  // evidence only ever records the file path, never the value.
  const token = randomBytes(24).toString('hex');
  writeText(join(qaRoot, 'secrets', 'api-token'), `${token}\n`);
  writeText(join(qaRoot, 'mock', 'secrets', 'api-token'), `${randomBytes(24).toString('hex')}\n`);
  return { qaRoot, written, preserved };
}

function assertDir(dir) {
  ensureDir(dir);
  return dir;
}

/** Read `api.port` out of a daemon config (the daemon listens where the config says). */
function configPort(configPath) {
  const config = readJsonFile(configPath, null);
  const port = config?.api?.port;
  return typeof port === 'number' && Number.isInteger(port) ? port : null;
}

function logTail(path, bytes = 4000) {
  try {
    const size = statSync(path).size;
    const handle = readFileSync(path);
    return handle.subarray(Math.max(0, size - bytes)).toString('utf8');
  } catch {
    return '';
  }
}

/** Last console-host receipt line in a log file (the host prints one JSON line). */
function hostReceipt(logPath) {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  let receipt = null;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.listening === 'string' && parsed.schemaVersion !== undefined) {
        receipt = parsed;
      }
    } catch {
      /* not a receipt line */
    }
  }
  return receipt;
}

/** Append header lines to a log so the evidence shows what was started, when, and by whom. */
function appendLogHeader(logPath, lines) {
  ensureDir(dirname(logPath));
  const fd = openSync(logPath, 'a');
  try {
    for (const line of lines) writeFileSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Spawn a long-lived child detached from this CLI, logging to `logPath`. */
function spawnDetached(args, logPath) {
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(NODE_EXE, args, {
      cwd: REPO_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return { pid: child.pid, args };
  } finally {
    closeSync(fd);
  }
}

/** Wait until `probe()` returns a truthy value or the deadline passes. */
async function waitUntil(probe, { timeoutMs, intervalMs = 500, label }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    last = await probe();
    if (last !== null && last !== undefined && last !== false) {
      return { value: last, waitedMs: Date.now() - started };
    }
    await sleep(intervalMs);
  }
  return { value: null, waitedMs: Date.now() - started, timedOut: true, last, label };
}

/** Gate the daemon: healthz status, then the bearer-token status document. */
async function gateDaemon(spec, token, options) {
  const base = `http://127.0.0.1:${spec.daemonPort}`;
  const failures = [];
  const gate = { healthz: null, status: null, waitedMs: 0, failures };

  const health = await waitUntil(async () => {
    const response = await httpGet(`${base}/healthz`, { timeoutMs: 3000 });
    if (!response.ok || response.json === null) return false;
    return spec.expect.healthz.includes(response.json.status) ? response : false;
  }, { timeoutMs: options.timeoutMs, label: 'daemon /healthz' });
  if (health.value === null) {
    failures.push(`daemon /healthz did not reach ${spec.expect.healthz.join('|')} within ${options.timeoutMs}ms`
      + `${health.last === null ? '' : ` (last ok, unexpected status)`}`);
    return gate;
  }
  gate.healthz = { status: health.value.json.status, version: health.value.json.version ?? null, waitedMs: health.waitedMs };

  if (token === null) {
    failures.push('token file missing/empty — cannot gate /api/v1/status (data state unproven)');
    return gate;
  }
  const auth = { Authorization: `Bearer ${token}` };
  const statusProbe = spec.expect.dataState === 'empty'
    ? async () => {
      const response = await httpGet(`${base}/api/v1/status`, { headers: auth, timeoutMs: 5000 });
      if (!response.ok || response.json === null) return false;
      const counters = response.json.counters ?? {};
      return Number(counters.events_accepted) === 0 && Number(counters.events_received) === 0 ? response : false;
    }
    : async () => {
      const response = await httpGet(`${base}/api/v1/status`, { headers: auth, timeoutMs: 5000 });
      if (!response.ok || response.json === null) return false;
      const counters = response.json.counters ?? {};
      return Number(counters.events_accepted) > 0 ? response : false;
    };
  const status = await waitUntil(statusProbe, {
    timeoutMs: spec.expect.dataState === 'empty' ? options.timeoutMs : options.settleEventsMs,
    label: `daemon /api/v1/status (${spec.expect.dataState})`,
  });
  if (status.value === null) {
    failures.push(`daemon /api/v1/status did not prove ${spec.expect.dataState} within `
      + `${spec.expect.dataState === 'empty' ? options.timeoutMs : options.settleEventsMs}ms`);
    return gate;
  }
  const body = status.value.json;
  const counters = body.counters ?? {};
  // A second, token-free shape check: /api/v1/alerts must answer, and its count must agree
  // with the data state (data: > 0 is expected but only reported, mock: must be 0).
  const alerts = await httpGet(`${base}/api/v1/alerts?limit=5`, { headers: auth, timeoutMs: 5000 });
  const alertItems = Array.isArray(alerts.json?.items) ? alerts.json.items
    : Array.isArray(alerts.json?.alerts) ? alerts.json.alerts : null;
  gate.status = {
    mode: body.mode ?? null,
    version: body.version ?? null,
    healthStatus: body.health?.status ?? null,
    counters: {
      events_received: counters.events_received ?? null,
      events_accepted: counters.events_accepted ?? null,
      alerts_written: counters.alerts_written ?? null,
      polls: counters.polls ?? null,
    },
    alertsEndpoint: {
      status: alerts.status,
      bytes: alerts.bytes,
      count: alertItems === null ? null : alertItems.length,
      shape: alertItems === null ? null : (alerts.json?.items !== undefined ? 'items' : 'alerts'),
    },
    waitedMs: status.waitedMs,
  };
  if (spec.expect.dataState === 'empty' && alertItems !== null && alertItems.length !== 0) {
    failures.push(`mock stack /api/v1/alerts returned ${alertItems.length} items — expected an empty store`);
  }
  if (spec.expect.dataState === 'has-events' && alertItems !== null && alertItems.length === 0) {
    gate.status.alertsEndpointWarning = 'zero alerts although events were accepted (rules may not have flushed yet)';
  }
  return gate;
}

/**
 * Gate the console host: static asset, healthz parity, proxied counters, printed receipt.
 *
 * The counters check must tolerate the collector moving forward between two HTTP calls
 * (a `full` daemon accepts events every poll). So the daemon is read *before* and *after*
 * the host call, and the host's value must fall inside that monotonic window — that proves
 * the host talks to this daemon without being flaky under real telemetry.
 */
async function gateHost(spec, daemonGate, options, token = null) {
  const base = `http://127.0.0.1:${spec.hostPort}`;
  const failures = [];
  const gate = { listening: null, receipt: null, healthz: null, proxy: null, static: null, failures };

  const index = await waitUntil(async () => {
    const response = await httpGet(`${base}/`, { timeoutMs: 3000 });
    return response.ok && response.bytes > 5000 ? response : false;
  }, { timeoutMs: options.timeoutMs, label: 'console host /' });
  if (index.value === null) {
    failures.push(`console host / did not serve index.html (>5KB) within ${options.timeoutMs}ms`);
    return gate;
  }
  gate.static = { status: index.value.status, bytes: index.value.bytes, waitedMs: index.value.elapsedMs };

  const health = await httpGet(`${base}/healthz`, { timeoutMs: 5000 });
  gate.healthz = { status: health.status, body: health.json ?? null, bytes: health.bytes };
  const daemonHealth = daemonGate.healthz?.status ?? null;
  if (!health.ok || daemonHealth === null || health.json?.status !== daemonHealth) {
    failures.push(`console host /healthz (${health.status} ${JSON.stringify(health.json ?? health.error)})`
      + ` does not mirror daemon /healthz (${daemonHealth})`);
  }

  const proxy = await httpGet(`${base}/api/v1/status`, { timeoutMs: 8000 });
  const proxyCounters = proxy.json?.counters ?? null;
  const beforeCounters = daemonGate.status?.counters ?? null;
  const afterResponse = token === null
    ? null
    : await httpGet(`http://127.0.0.1:${spec.daemonPort}/api/v1/status`,
      { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 8000 });
  const afterCounters = afterResponse?.json?.counters ?? beforeCounters;
  const inWindow = (value, before, after) => {
    if (value === null || value === undefined || before === null || after === null) return false;
    const low = Math.min(Number(before), Number(after));
    const high = Math.max(Number(before), Number(after));
    return Number(value) >= low && Number(value) <= high;
  };
  const sameMode = proxyCounters !== null && beforeCounters !== null
    && proxy.json?.mode === daemonGate.status?.mode;
  const sameCounters = sameMode
    && inWindow(proxyCounters.events_accepted, beforeCounters.events_accepted, afterCounters?.events_accepted)
    && inWindow(proxyCounters.alerts_written, beforeCounters.alerts_written, afterCounters?.alerts_written);
  gate.proxy = {
    status: proxy.status,
    bytes: proxy.bytes,
    mode: proxy.json?.mode ?? null,
    counters: proxyCounters === null ? null : {
      events_accepted: proxyCounters.events_accepted ?? null,
      alerts_written: proxyCounters.alerts_written ?? null,
    },
    daemonWindow: beforeCounters === null ? null : {
      before: { events_accepted: beforeCounters.events_accepted, alerts_written: beforeCounters.alerts_written },
      after: afterCounters === null ? null : { events_accepted: afterCounters.events_accepted, alerts_written: afterCounters.alerts_written },
    },
    equalsDaemon: sameCounters,
  };
  if (!proxy.ok || !sameCounters) {
    failures.push(`console host /api/v1/status does not mirror the daemon`
      + ` (host=${proxy.status} ${JSON.stringify(gate.proxy.counters)},`
      + ` daemon window=${JSON.stringify(gate.proxy.daemonWindow)})`);
  }

  const receipt = hostReceipt(spec.logHost);
  const expectedListening = `http://127.0.0.1:${spec.hostPort}/`;
  gate.receipt = receipt === null ? null : {
    listening: receipt.listening,
    daemon: receipt.daemon ?? null,
    tokenInjected: receipt.tokenInjected ?? null,
    matchesPort: receipt.listening === expectedListening,
  };
  if (receipt === null) {
    failures.push(`console host printed no listening receipt in ${spec.logHost}`);
  } else if (receipt.listening !== expectedListening) {
    failures.push(`console host receipt listening=${receipt.listening} != ${expectedListening}`);
  }
  const expectedDaemonOrigin = `http://127.0.0.1:${spec.daemonPort}`;
  if (receipt !== null && receipt.daemon !== undefined && receipt.daemon !== expectedDaemonOrigin) {
    failures.push(`console host receipt daemon=${receipt.daemon} != ${expectedDaemonOrigin}`);
  }
  gate.listening = expectedListening;
  return gate;
}

/**
 * Decide whether an already-listening stack is *our* stack (reuse it) or a conflict.
 * Behaviour first (health + counters), identity second (command line), never guess.
 */
async function inspectExistingStack(spec, token, options) {
  const daemonPort = describePort(spec.daemonPort);
  const hostPort = describePort(spec.hostPort);
  const daemonUp = daemonPort.pid !== null;
  const hostUp = hostPort.pid !== null;
  if (!daemonUp && !hostUp) return { state: 'cold', daemonPort, hostPort };
  if (!daemonUp || !hostUp) {
    return {
      state: 'conflict',
      reason: !daemonUp
        ? `console host port ${spec.hostPort} is occupied but daemon port ${spec.daemonPort} is not listening`
        : `daemon port ${spec.daemonPort} is occupied but console host port ${spec.hostPort} is not listening`,
      daemonPort,
      hostPort,
    };
  }
  const daemonGate = await gateDaemon(spec, token, { ...options, settleEventsMs: 2000 });
  if (daemonGate.failures.length > 0) {
    return { state: 'conflict', reason: `ports occupied but daemon fails its gate: ${daemonGate.failures.join('; ')}`, daemonPort, hostPort, daemonGate };
  }
  const hostGate = await gateHost(spec, daemonGate, { ...options, timeoutMs: 5000 }, token);
  if (hostGate.failures.length > 0) {
    return { state: 'conflict', reason: `ports occupied but console host fails its gate: ${hostGate.failures.join('; ')}`, daemonPort, hostPort, daemonGate, hostGate };
  }
  return { state: 'warm', daemonPort, hostPort, daemonGate, hostGate };
}

/** Bring up one stack, reusing it when it is already healthy. */
async function ensureStack(spec, options) {
  const record = {
    id: spec.id,
    label: spec.label,
    daemonPort: spec.daemonPort,
    hostPort: spec.hostPort,
    daemonConfig: spec.daemonConfig,
    tokenFile: spec.tokenFile,
    reused: false,
    startedPids: [],
    failures: [],
  };
  const tokenInfo = readTokenFile(spec.tokenFile);
  record.token = { file: spec.tokenFile, available: tokenInfo.token !== null, error: tokenInfo.error };
  if (tokenInfo.token === null) {
    record.failures.push(`token file unusable: ${tokenInfo.error} (${spec.tokenFile})`);
    return { record, daemonPort: null, hostPort: null };
  }

  const existing = await inspectExistingStack(spec, tokenInfo.token, options);
  record.existing = {
    state: existing.state,
    reason: existing.reason ?? null,
    daemonPid: existing.daemonPort?.pid ?? null,
    daemonCommandLine: existing.daemonPort?.commandLine ?? null,
    hostPid: existing.hostPort?.pid ?? null,
    hostCommandLine: existing.hostPort?.commandLine ?? null,
  };
  if (existing.state === 'conflict') {
    record.failures.push(`REFUSING TO START: ${existing.reason}. This script never kills processes it did not start.`);
    return { record, daemonPort: existing.daemonPort, hostPort: existing.hostPort };
  }
  if (existing.state === 'warm') {
    record.reused = true;
    record.daemonGate = existing.daemonGate;
    record.hostGate = existing.hostGate;
    record.daemon = {
      pid: existing.daemonPort.pid,
      owned: previousOwned(spec.id, 'daemon', existing.daemonPort, options.qaRoot),
      commandLine: existing.daemonPort.commandLine,
      log: spec.logDaemon,
    };
    record.host = {
      pid: existing.hostPort.pid,
      owned: previousOwned(spec.id, 'host', existing.hostPort, options.qaRoot),
      commandLine: existing.hostPort.commandLine,
      log: spec.logHost,
    };
    return { record, daemonPort: existing.daemonPort, hostPort: existing.hostPort, daemonGate: existing.daemonGate, hostGate: existing.hostGate };
  }

  // Cold start. Daemon first.
  appendLogHeader(spec.logDaemon, [
    `# --- run-stack.mjs start ${nowIso()} node=${NODE_VERSION} cwd=${REPO_ROOT}`,
    `# argv: ${spec.daemonArgs.join(' ')}`,
  ]);
  const daemon = spawnDetached(spec.daemonArgs, spec.logDaemon);
  record.startedPids.push(daemon.pid);
  await sleep(300);
  if (!isAlive(daemon.pid)) {
    record.failures.push(`daemon exited immediately; log tail: ${logTail(spec.logDaemon, 1200)}`);
    return { record, daemonPort: null, hostPort: null };
  }
  const daemonLive = describeProcesses([daemon.pid]).get(daemon.pid);
  const daemonCmdline = daemonLive?.commandLine ?? daemon.args.join(' ');
  const daemonPort = { port: spec.daemonPort, pid: daemon.pid, commandLine: daemonCmdline, createdAt: daemonLive?.createdAt ?? null, name: daemonLive?.name ?? 'node.exe' };
  record.daemon = { pid: daemon.pid, owned: true, commandLine: daemonCmdline, argv: daemon.args, log: spec.logDaemon };
  const daemonGate = await gateDaemon(spec, tokenInfo.token, options);
  record.daemonGate = daemonGate;
  if (daemonGate.failures.length > 0) {
    record.failures.push(...daemonGate.failures.map((line) => `daemon: ${line}`));
    record.daemonLogTail = logTail(spec.logDaemon, 1500);
    return { record, daemonPort, hostPort: null };
  }
  const listenerPid = findListeningPid(spec.daemonPort);
  record.daemon.listeningPid = listenerPid;
  if (listenerPid !== null && listenerPid !== daemon.pid) {
    record.failures.push(`daemon: started pid ${daemon.pid} but port ${spec.daemonPort} is owned by pid ${listenerPid}`);
    return { record, daemonPort, hostPort: null };
  }

  // Console host second.
  const hostArgs = [
    join(REPO_ROOT, 'apps', 'console-next', 'serve.mjs'),
    '--daemon', `http://127.0.0.1:${spec.daemonPort}`,
    '--token-file', spec.tokenFile,
    '--port', String(spec.hostPort),
  ];
  appendLogHeader(spec.logHost, [
    `# --- run-stack.mjs start ${nowIso()} node=${NODE_VERSION} cwd=${REPO_ROOT}`,
    `# argv: ${hostArgs.join(' ')}`,
  ]);
  const host = spawnDetached(hostArgs, spec.logHost);
  record.startedPids.push(host.pid);
  await sleep(300);
  if (!isAlive(host.pid)) {
    record.failures.push(`console host exited immediately; log tail: ${logTail(spec.logHost, 1200)}`);
    return { record, daemonPort, hostPort: null };
  }
  const hostLive = describeProcesses([host.pid]).get(host.pid);
  const hostCmdline = hostLive?.commandLine ?? hostArgs.join(' ');
  const hostPort = { port: spec.hostPort, pid: host.pid, commandLine: hostCmdline, createdAt: hostLive?.createdAt ?? null, name: hostLive?.name ?? 'node.exe' };
  record.host = { pid: host.pid, owned: true, commandLine: hostCmdline, argv: hostArgs, log: spec.logHost };
  const hostGate = await gateHost(spec, daemonGate, options, tokenInfo.token);
  record.hostGate = hostGate;
  if (hostGate.failures.length > 0) {
    record.failures.push(...hostGate.failures.map((line) => `console host: ${line}`));
    record.hostLogTail = logTail(spec.logHost, 1500);
  }
  const hostListener = findListeningPid(spec.hostPort);
  record.host.listeningPid = hostListener;
  if (hostListener !== null && hostListener !== host.pid) {
    record.failures.push(`console host: started pid ${host.pid} but port ${spec.hostPort} is owned by pid ${hostListener}`);
  }
  return { record, daemonPort, hostPort, daemonGate, hostGate };
}

/**
 * Keep `owned: true` across an idempotent re-run only when the recorded pid *and*
 * command line still match what is listening now. Anything else is demoted to false,
 * so stop-stack.mjs can never kill a process this tool cannot prove it started.
 */
function previousOwned(stackId, role, observed, qaRoot) {
  const state = readJsonFile(stateFileFor(qaRoot), null);
  const previous = state?.stacks?.[stackId]?.[role];
  if (previous === undefined || previous === null) return false;
  const samePid = Number(previous.pid) === Number(observed.pid);
  const sameCmd = typeof previous.commandLine === 'string'
    && typeof observed.commandLine === 'string'
    && previous.commandLine.trim() === observed.commandLine.trim();
  return samePid && sameCmd;
}

/** Merge one stack into the state file (never clobbers another stack's ownership). */
function recordState(stackId, record, options) {
  const statePath = stateFileFor(options.qaRoot);
  const state = readJsonFile(statePath, { schemaVersion: '1.0', stacks: {} });
  const stacks = state.stacks ?? {};
  const entry = { recordedAt: nowIso(), qaRoot: options.qaRoot, reused: record.reused === true, stacks: {} };
  for (const role of ['daemon', 'host']) {
    const info = record[role];
    if (info === undefined) {
      if (stacks[stackId]?.[role] !== undefined && record.reused === false && record.startedPids.includes(stacks[stackId][role].pid)) {
        delete stacks[stackId][role];
      }
      continue;
    }
    entry.stacks[role] = {
      pid: info.pid,
      port: role === 'daemon' ? record.daemonPort : record.hostPort,
      owned: info.owned === true,
      commandLine: info.commandLine ?? null,
      log: info.log ?? null,
      recordedAt: nowIso(),
    };
  }
  stacks[stackId] = entry.stacks;
  writeJsonFile(statePath, {
    schemaVersion: '1.0',
    updatedAt: nowIso(),
    node: NODE_VERSION,
    qaRoot: options.qaRoot,
    stacks,
  });
  return entry.stacks;
}

function printReport(record) {
  const rows = [{ stack: record.id, daemon: '?', events: '?', alerts: '?', host: '?', mode: record.reused ? 'reused' : 'started' }];
  const daemonOk = record.daemonGate !== undefined && record.daemonGate.failures.length === 0;
  const hostOk = record.hostGate !== undefined && record.hostGate.failures.length === 0;
  rows[0].daemon = daemonOk ? `ok:${record.daemonGate.healthz.status}` : 'FAIL';
  rows[0].events = String(record.daemonGate?.status?.counters?.events_accepted ?? '?');
  rows[0].alerts = String(record.daemonGate?.status?.alertsEndpoint?.count ?? '?');
  rows[0].host = hostOk ? `ok:${record.hostGate.proxy?.equalsDaemon === true ? 'proxy-mirrors-daemon' : 'proxy?'}` : 'FAIL';
  for (const row of rows) {
    process.stdout.write(`[${row.stack}] daemon=${row.daemon} events=${row.events} alerts=${row.alerts} host=${row.host} (${row.mode})\n`);
  }
  for (const failure of record.failures) process.stdout.write(`  ! ${failure}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    stacks: 'data,mock',
    'qa-root': DEFAULT_QA_ROOT,
    json: null,
    'timeout-ms': 60000,
    'settle-events-ms': 45000,
    'data-port': null,
    'data-host-port': null,
    'mock-port': null,
    'mock-host-port': null,
    quiet: false,
  }, new Set(['quiet', 'help', 'provision', 'force-provision']));
  if (args.help === true) {
    process.stdout.write('usage: node tests/e2e/runtime/run-stack.mjs [--stacks data,mock] [--qa-root <dir>]'
      + ' [--json <path>] [--timeout-ms 60000] [--settle-events-ms 45000]\n'
      + '       [--data-port N] [--data-host-port N] [--mock-port N] [--mock-host-port N]\n'
      + '       [--provision [--force-provision]] [--quiet]\n'
      + '  --provision creates a complete QA root (configs, rule pack, collector spec, tokens)\n'
      + '  from nothing, so a cold start can be proven on isolated ports.\n');
    return 0;
  }
  const qaRoot = String(args['qa-root']);
  const ports = {
    data: { daemonPort: numberOrNull(args['data-port']), hostPort: numberOrNull(args['data-host-port']) },
    mock: { daemonPort: numberOrNull(args['mock-port']), hostPort: numberOrNull(args['mock-host-port']) },
  };
  let provisioned = null;
  if (args.provision === true) {
    provisioned = provisionQaRoot(qaRoot, {
      daemonPort: ports.data.daemonPort ?? CANONICAL.data.daemonPort,
      mock: { daemonPort: ports.mock.daemonPort ?? CANONICAL.mock.daemonPort },
    }, { force: args['force-provision'] === true });
    process.stdout.write(`provisioned QA root: ${qaRoot} (${provisioned.written.length} written,`
      + ` ${provisioned.preserved.length} preserved)\n`);
  }
  if (!existsSync(qaRoot)) {
    process.stderr.write(`run-stack: QA root does not exist: ${qaRoot}`
      + ' (pass --provision to create it from nothing)\n');
    return 2;
  }
  const stackIds = splitList(String(args.stacks));
  if (stackIds.length === 0) {
    process.stderr.write('run-stack: no stacks requested\n');
    return 2;
  }
  const options = {
    qaRoot,
    timeoutMs: Number(args['timeout-ms']),
    settleEventsMs: Number(args['settle-events-ms']),
    quiet: args.quiet === true,
  };

  const receipt = {
    schemaVersion: '1.0',
    generatedAt: nowIso(),
    tool: 'tests/e2e/runtime/run-stack.mjs',
    node: NODE_VERSION,
    nodeExe: NODE_EXE,
    repoRoot: REPO_ROOT,
    qaRoot,
    requested: stackIds,
    ports,
    provisioned: provisioned === null ? null : {
      written: provisioned.written.map((path) => displayPath(path)),
      preserved: provisioned.preserved.map((path) => displayPath(path)),
    },
    build: computeBuildFingerprint(join(REPO_ROOT, 'apps', 'console-next')),
    stacks: {},
    pass: false,
    failures: [],
  };
  process.stdout.write(`build: ${receipt.build.fileCount} files, sha256=${receipt.build.sha256.slice(0, 16)}…\n`);

  for (const stackId of stackIds) {
    const spec = stackSpec(stackId, qaRoot, { ...ports[stackId] });
    if (!options.quiet) process.stdout.write(`\n== stack ${stackId}: ${spec.label} (daemon:${spec.daemonPort} host:${spec.hostPort}) ==\n`);
    // eslint-disable-next-line no-await-in-loop
    const { record } = await ensureStack(spec, options);
    record.state = recordState(stackId, record, options);
    receipt.stacks[stackId] = record;
    for (const failure of record.failures) receipt.failures.push(`${stackId}: ${failure}`);
    if (!options.quiet) printReport(record);
  }

  receipt.pass = receipt.failures.length === 0;
  receipt.gates = {
    data: receipt.stacks.data === undefined ? null : {
      daemonPort: receipt.stacks.data.daemonPort,
      hostPort: receipt.stacks.data.hostPort,
      eventsAccepted: receipt.stacks.data.daemonGate?.status?.counters?.events_accepted ?? null,
      alerts: receipt.stacks.data.daemonGate?.status?.alertsEndpoint?.count ?? null,
      proxyMirrorsDaemon: receipt.stacks.data.hostGate?.proxy?.equalsDaemon ?? null,
    },
    mock: receipt.stacks.mock === undefined ? null : {
      daemonPort: receipt.stacks.mock.daemonPort,
      hostPort: receipt.stacks.mock.hostPort,
      eventsAccepted: receipt.stacks.mock.daemonGate?.status?.counters?.events_accepted ?? null,
      alerts: receipt.stacks.mock.daemonGate?.status?.alertsEndpoint?.count ?? null,
      proxyMirrorsDaemon: receipt.stacks.mock.hostGate?.proxy?.equalsDaemon ?? null,
    },
  };

  const receiptPath = args.json === null || args.json === true
    ? join(EVIDENCE_ROOT, 'stack-receipt.json')
    : fromRepo(String(args.json));
  writeJsonFile(receiptPath, receipt);
  const stamp = receipt.generatedAt.replace(/[:.]/gu, '-');
  writeJsonFile(join(EVIDENCE_ROOT, `stack-receipt-${stamp}.json`), receipt);
  const greenStacks = stackIds.filter((stackId) => (receipt.stacks[stackId]?.failures ?? []).length === 0).length;
  process.stdout.write(`\nreceipt: ${receiptPath}\n`);
  process.stdout.write(`result: ${receipt.pass ? 'PASS' : 'FAIL'}`
    + ` (${greenStacks}/${stackIds.length} stacks green, ${receipt.failures.length} gate failures)\n`);
  return receipt.pass ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`run-stack: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
