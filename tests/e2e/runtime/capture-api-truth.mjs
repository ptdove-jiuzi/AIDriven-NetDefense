#!/usr/bin/env node
/**
 * capture-api-truth.mjs — prove the six views talk to a *real* daemon, and record the
 * response shapes as de-identified evidence (author PT-dove).
 *
 * For both stacks it calls the same five endpoints twice:
 *   1. directly against the daemon, with the Bearer token read from the QA secrets file;
 *   2. through the console host, which is exactly what the browser can reach (no token in
 *      the browser at any point, contract §1).
 *
 * The evidence keeps structure and drops secrets: every JSON value under a key matching
 * token/csrf/secret/apiKey is replaced by `<redacted:length>`, long strings are truncated,
 * arrays are capped, and the raw bodies are only represented by byte length + sha256.
 * As a final guard the serialized report is scanned for the live token; a hit fails the
 * run instead of writing a leak.
 *
 * Usage:
 *   node tests/e2e/runtime/capture-api-truth.mjs [--stacks data,mock] [--qa-root <dir>]
 *        [--json <path>] [--quiet]
 *
 * Exit 0 when every endpoint on every stack answered as expected. Exit 1 otherwise.
 */

import { join } from 'node:path';

import {
  DEFAULT_QA_ROOT,
  EVIDENCE_ROOT,
  REPO_ROOT,
  computeBuildFingerprint,
  describePort,
  httpGet,
  keysOf,
  nowIso,
  parseArgs,
  readJsonFile,
  readTokenFile,
  redact,
  sha256,
  scrubString,
  splitList,
  writeJsonFile,
} from './lib/runtime.mjs';

/** The five endpoints the acceptance run has to prove. */
export const ENDPOINTS = Object.freeze([
  { path: '/healthz', auth: false, expectStatus: [200], key: 'healthz' },
  { path: '/api/v1/status', auth: true, expectStatus: [200], key: 'status' },
  { path: '/api/v1/alerts?limit=5', auth: true, expectStatus: [200], key: 'alerts' },
  { path: '/api/v1/models', auth: true, expectStatus: [200], key: 'models' },
  { path: '/api/v1/settings/schema', auth: true, expectStatus: [200], key: 'settingsSchema' },
]);

/** Stack descriptor: daemon port/config and token file, read from the QA root. */
function stackSpec(stackId, qaRoot) {
  if (stackId === 'data') {
    const config = readJsonFile(join(qaRoot, 'daemon.json'), {});
    return {
      id: stackId,
      daemonPort: config?.api?.port ?? 17511,
      hostPort: 17512,
      tokenFile: join(qaRoot, 'secrets', 'api-token'),
      expectData: 'has-events',
    };
  }
  if (stackId === 'mock') {
    const config = readJsonFile(join(qaRoot, 'mock', 'daemon-mock.json'), {});
    return {
      id: stackId,
      daemonPort: config?.api?.port ?? 17521,
      hostPort: 17522,
      tokenFile: join(qaRoot, 'mock', 'secrets', 'api-token'),
      expectData: 'empty',
    };
  }
  throw new Error(`unknown stack: ${stackId}`);
}

/** Per-endpoint de-identified summary. This is the part a reviewer reads. */
function summarize(key, json) {
  if (json === null || typeof json !== 'object') return { shape: typeof json };
  if (key === 'healthz') {
    return { status: json.status ?? null, version: json.version ?? null };
  }
  if (key === 'status') {
    return {
      topKeys: keysOf(json),
      mode: json.mode ?? null,
      version: json.version ?? null,
      lifecycle: json.lifecycle ?? null,
      healthStatus: json.health?.status ?? null,
      healthReady: json.health?.ready ?? null,
      counters: json.counters ?? null,
      scheduler: json.scheduler ?? null,
      pipeline: json.pipeline ?? null,
      store: json.store ?? null,
      uptimeMs: json.uptime_ms ?? null,
      csrf: {
        present: Object.prototype.hasOwnProperty.call(json, 'csrf_token'),
        redacted: true,
        note: 'contract §12.1: known existing field; the browser reads but never uses it',
      },
      secrets: {
        tokenLikeFields: keysOf(json).filter((name) => /token|secret|key/iu.test(name)),
      },
    };
  }
  if (key === 'alerts') {
    const items = Array.isArray(json.alerts) ? json.alerts : Array.isArray(json.items) ? json.items : [];
    return {
      container: Array.isArray(json.alerts) ? 'alerts' : Array.isArray(json.items) ? 'items' : 'none',
      count: items.length,
      nextCursor: json.next_cursor ?? json.nextCursor ?? null,
      projection: items.slice(0, 2).map((alert) => ({
        alert_id: alert.alert_id ?? alert.id ?? null,
        rule_id: alert.rule_id ?? null,
        rule_version: alert.rule_version ?? null,
        severity: alert.severity ?? null,
        status: alert.status ?? null,
        count: alert.count ?? null,
        first_seen: alert.first_seen ?? null,
        last_seen: alert.last_seen ?? null,
        evidence_count: alert.evidence_count ?? null,
        evidence_truncated: alert.evidence_truncated ?? null,
        hasHostField: Object.prototype.hasOwnProperty.call(alert, 'host'),
      })),
      severityHistogram: items.reduce((acc, alert) => {
        const key2 = String(alert.severity ?? 'unknown');
        acc[key2] = (acc[key2] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }
  if (key === 'models') {
    const providers = Array.isArray(json.providers) ? json.providers : [];
    const models = Array.isArray(json.models) ? json.models : [];
    return {
      egressEnabled: json.egressEnabled ?? null,
      routing: json.routing ?? null,
      providerCount: providers.length,
      providers: providers.slice(0, 8).map((provider) => ({
        id: provider.id ?? null,
        kind: provider.kind ?? null,
        baseUrl: provider.baseUrl ?? null,
        enabled: provider.enabled ?? null,
        allowLoopback: provider.allowLoopback ?? null,
        hasCredential: provider.hasCredential ?? null,
        credential: provider.credential === undefined || provider.credential === null
          ? null
          : { masked: provider.credential.masked ?? null, fingerprint: provider.credential.fingerprint ?? null, lengthBucket: provider.credential.lengthBucket ?? null },
        healthy: provider.healthy ?? null,
        budget: provider.budget ?? null,
      })),
      modelCount: models.length,
      models: models.slice(0, 8),
      usage: json.usage ?? null,
      engine: json.engine ?? null,
    };
  }
  if (key === 'settingsSchema') {
    const groups = Array.isArray(json.groups) ? json.groups : [];
    const actions = Array.isArray(json.actions) ? json.actions : [];
    return {
      schemaVersion: json.schemaVersion ?? null,
      groupCount: groups.length,
      groups: groups.map((group) => ({
        id: group.id ?? null,
        appliesAt: group.appliesAt ?? null,
        dangerous: group.dangerous ?? null,
        itemCount: Array.isArray(group.items) ? group.items.length : null,
        wiredFalse: Array.isArray(group.items) ? group.items.filter((item) => item.wired === false).length : null,
      })),
      actionCount: actions.length,
      actions: actions.map((action) => ({
        id: action.id ?? null,
        method: action.method ?? null,
        available: action.available ?? null,
        reason: action.reason ?? null,
      })),
      actionCatalogCount: Array.isArray(json.actionCatalog) ? json.actionCatalog.length : null,
    };
  }
  return { topKeys: keysOf(json) };
}

async function probeEndpoint(base, endpoint, token) {
  const headers = endpoint.auth && token !== null ? { Authorization: `Bearer ${token}` } : {};
  const started = Date.now();
  const response = await httpGet(`${base}${endpoint.path}`, { headers, timeoutMs: 10_000 });
  const raw = response.text ?? '';
  return {
    url: `${base}${endpoint.path}`,
    authenticated: endpoint.auth && token !== null,
    status: response.status,
    ok: response.ok,
    bytes: response.bytes,
    sha256: raw === '' ? null : sha256(raw),
    cacheControl: response.headers['cache-control'] ?? null,
    contentType: response.headers['content-type'] ?? null,
    elapsedMs: Date.now() - started,
    error: response.error,
    summary: redact(summarize(endpoint.key, response.json)),
  };
}

/** Compare the two paths for the same endpoint (structure that must not drift). */
function comparePaths(direct, viaHost) {
  const differences = [];
  if (direct.status !== viaHost.status) differences.push(`status ${direct.status} != ${viaHost.status}`);
  const left = direct.summary ?? {};
  const right = viaHost.summary ?? {};
  const directPath = direct.url.replace(/^http:\/\/127\.0\.0\.1:\d+/u, '');
  const hostPath = viaHost.url.replace(/^http:\/\/127\.0\.0\.1:\d+/u, '');
  if (directPath !== hostPath) differences.push(`path ${directPath} != ${hostPath}`);
  // Only fields that cannot change between two back-to-back calls are compared.
  for (const key of ['mode', 'version', 'healthStatus', 'container', 'count', 'egressEnabled',
    'providerCount', 'modelCount', 'schemaVersion', 'groupCount', 'actionCount', 'status',
    'selected', 'reason']) {
    if (left[key] !== undefined && right[key] !== undefined && JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      differences.push(`${key}: ${JSON.stringify(left[key])} != ${JSON.stringify(right[key])}`);
    }
  }
  return differences;
}

async function captureStack(stackId, qaRoot, options) {
  const spec = stackSpec(stackId, qaRoot);
  const tokenInfo = readTokenFile(spec.tokenFile);
  const daemonPortInfo = describePort(spec.daemonPort);
  const hostPortInfo = describePort(spec.hostPort);
  const record = {
    id: spec.id,
    daemonPort: spec.daemonPort,
    hostPort: spec.hostPort,
    tokenAvailable: tokenInfo.token !== null,
    tokenFile: spec.tokenFile,
    listeners: {
      daemon: daemonPortInfo.pid === null ? null : {
        pid: daemonPortInfo.pid,
        commandLine: daemonPortInfo.commandLine,
      },
      host: hostPortInfo.pid === null ? null : {
        pid: hostPortInfo.pid,
        commandLine: hostPortInfo.commandLine,
      },
    },
    daemon: {},
    viaConsoleHost: {},
    comparisons: {},
    failures: [],
  };
  if (tokenInfo.token === null) {
    record.failures.push(`token unusable: ${tokenInfo.error}`);
    return record;
  }
  for (const endpoint of ENDPOINTS) {
    // eslint-disable-next-line no-await-in-loop
    record.daemon[endpoint.key] = await probeEndpoint(`http://127.0.0.1:${spec.daemonPort}`, endpoint, tokenInfo.token);
    // eslint-disable-next-line no-await-in-loop
    record.viaConsoleHost[endpoint.key] = await probeEndpoint(`http://127.0.0.1:${spec.hostPort}`, endpoint, null);
    const direct = record.daemon[endpoint.key];
    const proxied = record.viaConsoleHost[endpoint.key];
    const expected = endpoint.expectStatus.includes(direct.status);
    if (!expected) record.failures.push(`daemon ${endpoint.path}: expected ${endpoint.expectStatus.join('/')}, got ${direct.status ?? direct.error}`);
    if (!proxied.ok) record.failures.push(`console host ${endpoint.path}: ${proxied.status ?? proxied.error}`);
    const differences = comparePaths(direct, proxied);
    if (differences.length > 0) record.failures.push(`console host ${endpoint.path} differs from daemon: ${differences.join(', ')}`);
    record.comparisons[endpoint.key] = { differences };
  }

  // The whole point: do these numbers prove real telemetry (data) or a truly empty store (mock)?
  const statusSummary = record.daemon.status.summary;
  const events = statusSummary?.counters?.events_accepted ?? null;
  const alertsCount = record.daemon.alerts.summary?.count ?? null;
  const modelsSummary = record.daemon.models.summary;
  const schemaSummary = record.daemon.settingsSchema.summary;
  record.proof = {
    dataState: spec.expectData,
    mode: statusSummary?.mode ?? null,
    healthStatus: statusSummary?.healthStatus ?? null,
    eventsAccepted: events,
    alertsInFirstPage: alertsCount,
    egressEnabled: modelsSummary?.egressEnabled ?? null,
    providers: modelsSummary?.providerCount ?? null,
    models: modelsSummary?.modelCount ?? null,
    settingsGroups: schemaSummary?.groupCount ?? null,
    settingsActions: schemaSummary?.actionCount ?? null,
    schemaVersion: schemaSummary?.schemaVersion ?? null,
  };
  if (spec.expectData === 'has-events') {
    if (!(Number(events) > 0)) record.failures.push(`expected real telemetry, events_accepted=${events}`);
    if (!(Number(alertsCount) > 0)) record.failures.push(`expected real alerts, first page count=${alertsCount}`);
  } else {
    if (Number(events) !== 0) record.failures.push(`expected an empty store, events_accepted=${events}`);
    if (Number(alertsCount) !== 0) record.failures.push(`expected an empty store, alerts count=${alertsCount}`);
  }
  if (!options.quiet) {
    process.stdout.write(`[${stackId}] mode=${record.proof.mode} events=${events} alerts=${alertsCount}`
      + ` providers=${record.proof.providers} models=${record.proof.models} schemaGroups=${record.proof.settingsGroups}\n`);
    for (const failure of record.failures) process.stdout.write(`  ! ${failure}\n`);
  }
  return record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    stacks: 'data,mock',
    'qa-root': DEFAULT_QA_ROOT,
    json: null,
    quiet: false,
  }, new Set(['quiet', 'help']));
  if (args.help === true) {
    process.stdout.write('usage: node tests/e2e/runtime/capture-api-truth.mjs [--stacks data,mock]'
      + ' [--qa-root <dir>] [--json <path>] [--quiet]\n');
    return 0;
  }
  const qaRoot = String(args['qa-root']);
  const stackIds = splitList(String(args.stacks));
  const report = {
    schemaVersion: '1.0',
    generatedAt: nowIso(),
    tool: 'tests/e2e/runtime/capture-api-truth.mjs',
    node: process.version,
    build: computeBuildFingerprint(join(REPO_ROOT, 'apps', 'console-next')),
    qaRoot,
    endpoints: ENDPOINTS.map((endpoint) => endpoint.path),
    notes: [
      'Token values never appear: values under token/csrf/secret/apiKey keys are replaced by <redacted:length>.',
      'Raw bodies are represented only by byte length and sha256; the summaries keep names, types and counts.',
      'Each endpoint is called twice: direct to the daemon (Bearer) and through the console host (browser path, no token).',
    ],
    stacks: {},
    failures: [],
    pass: false,
  };
  const secrets = [];
  for (const stackId of stackIds) {
    const spec = stackSpec(stackId, qaRoot);
    const tokenInfo = readTokenFile(spec.tokenFile);
    if (tokenInfo.token !== null) secrets.push(tokenInfo.token);
    // eslint-disable-next-line no-await-in-loop
    const record = await captureStack(stackId, qaRoot, { quiet: args.quiet === true });
    report.stacks[stackId] = record;
    for (const failure of record.failures) report.failures.push(`${stackId}: ${failure}`);
  }

  // Leak guard: if the live token appears anywhere in the evidence, refuse to write it.
  let serialized = JSON.stringify(report, null, 2);
  let leakHits = 0;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    const hits = serialized.split(secret).length - 1;
    leakHits += hits;
    if (hits > 0) serialized = scrubString(serialized, [secret]);
  }
  report.tokenLeakCheck = { checkedAt: nowIso(), secretsScanned: secrets.length, hits: leakHits };
  if (leakHits > 0) {
    report.failures.push(`token leak guard tripped (${leakHits} occurrences) — evidence was scrubbed`);
  }
  report.pass = report.failures.length === 0;
  // Re-serialize *after* pass/tokenLeakCheck are set, and scrub once more as a belt-and-braces
  // step (the guard fields themselves only contain numbers and paths).
  serialized = scrubString(JSON.stringify(report, null, 2), secrets);
  const finalReport = JSON.parse(serialized);
  const jsonPath = args.json === null || args.json === true ? join(EVIDENCE_ROOT, 'api-truth.json') : args.json;
  writeJsonFile(jsonPath, finalReport);
  const stamp = report.generatedAt.replace(/[:.]/gu, '-');
  writeJsonFile(join(EVIDENCE_ROOT, `api-truth-${stamp}.json`), finalReport);
  process.stdout.write(`\nreceipt: ${jsonPath}\ntoken leak hits: ${leakHits}\nresult: ${report.pass ? 'PASS' : 'FAIL'}\n`);
  return report.pass ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`capture-api-truth: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
