/**
 * diagnostics-bundle.test.js — `diagnostics.exportBundle` (OPS-DIAG).
 *
 * 作者：PT-dove（OPS-DIAG 战役 · 席位 diag-bundle）
 *
 * The assertions are written against the two failure modes that matter for a file
 * that leaves the machine:
 *
 * 1. **A leak.** Every case that writes a secret-shaped string into a log, a status
 *    payload or a settings file then greps the *exported bytes* for it. A feature
 *    that renders a pretty bundle but copies one bearer token is worse than no
 *    feature, so the grep is the assertion — not a human read.
 * 2. **A crash.** A missing database (mock mode, or a store that was never created)
 *    and an oversized log are the two states support is most likely to export in.
 *    Both must answer with a bundle that says what it could not read, never a 500.
 *
 * The fixture is local on purpose (see the brief): it does not touch
 * `console-fixtures.mjs`'s harness, only borrows its token/CSRF constants and its
 * `httpJson` helper.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  LOG_FIELDS,
  MAX_BUNDLE_BYTES,
  MAX_LOG_FILE_BYTES,
  MAX_TEXT_CHARS,
  MAX_TOTAL_LINES,
  NON_JSON_POLICY,
  createDiagnosticsHandlers,
} from '../../apps/daemon/src/api/diagnostics.js';
import { createAuthGuard } from '../../apps/daemon/src/api/auth.js';
import { createControlApi } from '../../apps/daemon/src/api/server.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { DAEMON_VERSION } from '../../apps/daemon/src/daemon.js';
import { nullLogger } from '../../apps/daemon/src/log.js';
import {
  BASE_MS,
  CSRF_HEADER,
  TEST_TOKEN,
  httpJson,
} from './console-fixtures.mjs';

/** Fixed wall clock shared by every case (deterministic filename + log window). */
const NOW_MS = Date.UTC(2026, 10, 5, 10, 45, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();

/** An ISO instant inside the 24 h window. */
const RECENT_AT = new Date(NOW_MS - 60 * 60 * 1000).toISOString();

/** Probe strings that must never survive into the exported bytes. */
const SECRET_MARKERS = Object.freeze({
  skKey: 'sk-abc123456789ZZZ',
  bearerToken: 'xyzBEARERTOKEN123',
  email: 'alice@example.com',
  secondEmail: 'carol@example.com',
  windowsPath: 'C:\\Users\\alice\\app',
  windowsPathForward: 'C:/Users/alice/app',
  otherDrivePath: 'D:\\Users\\alice\\secret',
  posixHome: '/home/alice/bin',
  inlineToken: 'console-test-token-0123456789abcdefghij',
  settingsKey: 'sk-settings-file-must-not-appear',
  csrf: 'csrf-secret-value-must-not-appear',
  alertBody: 'RAW_ALERT_BODY_SHOULD_NOT_APPEAR',
  eventBody: 'RAW_EVENT_BODY_SHOULD_NOT_APPEAR',
  plainMarker: 'ALERT_BODY_MARKER_SHOULD_NOT_APPEAR',
  droppedField: 'drop-this-field-value',
});

const TEMP_ROOTS = new Set();

after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A leaked Windows handle must not fail an otherwise passing suite.
    }
  }
  TEMP_ROOTS.clear();
});

/**
 * Create an isolated root.
 *
 * The data directory is `<root>/data` rather than `<root>`, so the bundle's
 * "parent of dataDir / logs" candidate resolves to `<root>/logs` and not to the
 * machine's shared `%TEMP%/logs` (which belongs to other sessions).
 *
 * @returns {{root: string, dataDir: string}} Paths.
 */
function makeIsolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'aegis-diag-'));
  TEMP_ROOTS.add(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir };
}

/**
 * Write a log file, creating its directory.
 *
 * @param {string} filePath Path.
 * @param {string[]} lines Lines (joined with `\n`, trailing newline added).
 * @returns {void}
 */
function writeLog(filePath, lines) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${lines.join('\n')}\n`);
}

/**
 * Create a SQLite store shaped like the daemon's (schema_migration + tables).
 *
 * @param {string} filePath Database path.
 * @param {{schemaVersion?: number, userVersion?: number, withMigration?: boolean, tables?: Record<string, number>}} [options] Shape.
 * @returns {void}
 */
function createStore(filePath, options = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  try {
    const withMigration = options.withMigration !== false;
    if (withMigration) {
      database.exec('CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
      database
        .prepare('INSERT INTO schema_migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(options.schemaVersion ?? 7, 'fixture', 'deadbeef', NOW_ISO);
    }
    for (const [name, rows] of Object.entries(options.tables ?? { alpha: 2, beta: 0 })) {
      database.exec(`CREATE TABLE "${name}" (id INTEGER PRIMARY KEY)`);
      const insert = database.prepare(`INSERT INTO "${name}" (id) VALUES (?)`);
      for (let index = 1; index <= rows; index += 1) {
        insert.run(index);
      }
    }
    if (typeof options.userVersion === 'number') {
      database.exec(`PRAGMA user_version = ${options.userVersion}`);
    }
  } finally {
    database.close();
  }
}

/**
 * A resolved config with every field the bundle reads, including a token-shaped
 * inline value that must never be printed.
 *
 * @param {string} dataDir Data directory.
 * @param {string} storePath Store path.
 * @returns {object} Config.
 */
function baseConfig(dataDir, storePath) {
  return {
    dataDir,
    mode: 'full',
    store: { path: storePath, busyTimeoutMs: 5000 },
    state: { path: join(dataDir, 'state', 'state.json') },
    api: {
      enabled: true,
      host: '127.0.0.1',
      port: 17801,
      token: SECRET_MARKERS.inlineToken,
      tokenFile: join(dataDir, 'secrets', 'api-token'),
      requestTimeoutMs: 5000,
      headersTimeoutMs: 2000,
      keepAliveTimeoutMs: 1000,
      maxBodyBytes: 65536,
      maxHeaderBytes: 16384,
      authFailureLimit: 10,
      authFailureWindowMs: 60000,
    },
    scheduler: {
      tickMs: 1000,
      sourceTimeoutMs: 5000,
      maxBatchEvents: 100,
      staleAfterMs: 60000,
      maxSources: 32,
    },
    detection: {
      rulePack: null,
      rulePackPath: join(dataDir, 'rules', 'pack.json'),
      limits: { maxEventsPerBatch: 1000, maxEvents: 100 },
    },
    policy: {
      allowedSummaryFields: ['events', 'alerts'],
      budgetClass: 'local',
      alertStatus: 'new',
      epoch: null,
    },
    shutdown: { graceMs: 1000, drainMs: 2000 },
    logging: { level: 'info' },
  };
}

/**
 * Status payload with the counters, health, detection and a planted alert body.
 *
 * @param {string} dataDir Data directory.
 * @param {string} storePath Store path.
 * @returns {object} Status payload.
 */
function defaultStatus(dataDir, storePath) {
  return {
    version: DAEMON_VERSION,
    lifecycle: 'running',
    mode: 'full',
    epoch: '4b2a0f43-2b0f-4d5c-9a51-6f1c2d3e4f50',
    started_at: new Date(NOW_MS - 60_000).toISOString(),
    started_at_ms: NOW_MS - 60_000,
    // The bound endpoint, when the status payload carries it.
    api_host: '127.0.0.1',
    api_port: 17801,
    health: { status: 'degraded', ready: false, reasons: ['sources:none', 'detection:faults'] },
    scheduler: { sources: [], summary: { ok: 0, degraded: 1 } },
    pipeline: {
      events_received: 10,
      events_accepted: 9,
      detection: { faults: 2, frozen: false, fatal: null },
    },
    store: { path: storePath, events: 10 },
    counters: {
      polls: 4,
      events_received: 10,
      events_accepted: 9,
      source_failures: 3,
      rejected_by_store: 1,
      contributions_dropped: 2,
      store_reject_reason: 'BUSY',
    },
    clock: { nowMs: 1, nowIso: 'x', tick: () => 0 },
    // Planted content: a support bundle must omit these rather than print them.
    alerts: [
      {
        id: 'alert-1',
        body: SECRET_MARKERS.alertBody,
        payload: { detail: SECRET_MARKERS.eventBody },
        user_path: SECRET_MARKERS.windowsPath,
      },
    ],
    _data_dir_hint: dataDir,
  };
}

/**
 * Diagnostics payload with counters plus a planted CSRF value and a user path.
 *
 * @param {string} dataDir Data directory.
 * @returns {object} Diagnostics payload.
 */
function defaultDiagnostics(dataDir) {
  return {
    lifecycle_history: [{ at: NOW_ISO, from: 'starting', to: 'running' }],
    api: {
      requests: 5,
      rejected: 0,
      auth_denied: 0,
      timeouts: 0,
      too_large: 0,
      by_path: { '/api/v1/status': 5 },
      unknown_paths: 0,
      csrf_token: SECRET_MARKERS.csrf,
    },
    auth: { accepted: 3, rejected: 1, buckets: 0 },
    checkpoint: { path: join(dataDir, 'state', 'state.json'), corrupt_on_load: false, writes: 7 },
    console: { broker: { children: 0 }, chat: { active: 0 }, explain: {}, approvals: 0, settings: { saves: 1 } },
    detection_limits: { maxEventsPerBatch: 1000 },
  };
}

/**
 * Build handlers plus the option bag they were built from.
 *
 * @param {{
 *   store?: 'created'|'missing'|'none',
 *   logs?: boolean,
 *   status?: Function,
 *   diagnostics?: Function,
 *   clock?: object,
 *   onExported?: Function
 * }} [options] Case options.
 * @returns {{handlers: object, dataDir: string, root: string, storePath: string|null, exported: string[]}} Case.
 */
function makeCase(options = {}) {
  const { root, dataDir } = makeIsolatedRoot();
  const store = options.store ?? 'created';
  const storePath = store === 'none'
    ? null
    : join(dataDir, 'store', 'aegis.db');
  if (store === 'created') {
    createStore(storePath);
  }
  const exported = [];
  const handlers = createDiagnosticsHandlers({
    config: baseConfig(dataDir, storePath ?? join(dataDir, 'store', 'aegis.db')),
    status: options.status ?? (() => defaultStatus(dataDir, storePath)),
    diagnostics: options.diagnostics ?? (() => defaultDiagnostics(dataDir)),
    dataDir,
    storePath,
    clock: options.clock ?? { nowIso: () => NOW_ISO, nowMs: () => NOW_MS },
    logger: nullLogger,
    onExported: options.onExported ?? ((iso) => exported.push(iso)),
  });
  return { handlers, dataDir, root, storePath, exported };
}

/**
 * Walk every string of a parsed document (for the length-cap assertion).
 *
 * @param {unknown} value Value.
 * @param {string[]} [output] Accumulator.
 * @returns {string[]} Strings.
 */
function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return output;
  }
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectStrings(nested, output);
    }
  }
  return output;
}

describe('diagnostics bundle document', () => {
  it('carries every section and a summary that agrees with the body', async () => {
    const testCase = makeCase();
    writeLog(join(testCase.dataDir, 'shell', 'daemon.stderr.log'), [
      JSON.stringify({
        at: RECENT_AT,
        level: 'error',
        msg: 'source poll failed',
        code: 'SOURCE_TIMEOUT',
        source_id: 'win-svc',
        count: 2,
        host: '127.0.0.1',
        port: 17801,
        limit: 5000,
        pid: 1234,
        uptime_ms: 60000,
        // Not on the allowlist: dropped, never copied.
        extra_field: SECRET_MARKERS.droppedField,
      }),
    ]);

    const result = await testCase.handlers.exportDiagnosticsBundle({ method: 'POST' });

    assert.equal(result.contentType, 'application/json; charset=utf-8');
    assert.equal(typeof result.body, 'string');
    const bundle = JSON.parse(result.body);

    for (const section of [
      'bundle',
      'generated_at',
      'redaction',
      'limits',
      'version',
      'config',
      'status',
      'diagnostics',
      'tables',
      'process',
      'failures',
      'logs',
      'errors',
    ]) {
      assert.ok(Object.hasOwn(bundle, section), `bundle is missing section ${section}`);
    }
    assert.equal(bundle.bundle.schema, 'aegis-diagnostics-bundle/1');
    assert.equal(bundle.generated_at, NOW_ISO);

    // --- version / build ------------------------------------------------
    assert.equal(bundle.version.daemon_version, DAEMON_VERSION);
    assert.equal(bundle.version.package_name, '@aegisharness/daemon');
    assert.equal(bundle.version.package_version, '0.0.0');
    assert.equal(bundle.version.node, process.version);
    assert.equal(bundle.version.platform, process.platform);
    assert.equal(bundle.version.arch, process.arch);
    assert.equal(bundle.version.mode, 'full');
    assert.equal(bundle.version.epoch, '4b2a0f43-2b0f-4d5c-9a51-6f1c2d3e4f50');
    assert.equal(typeof bundle.version.process_versions.node, 'string');

    // --- redacted config -------------------------------------------------
    assert.equal(bundle.config.mode, 'full');
    assert.equal(bundle.config.api.host, '127.0.0.1');
    assert.equal(bundle.config.api.port, 17801);
    assert.equal(bundle.config.api.enabled, true);
    assert.equal(bundle.config.scheduler.tickMs, 1000);
    assert.equal(bundle.config.scheduler.maxBatchEvents, 100);
    assert.equal(bundle.config.detection.limits.maxEventsPerBatch, 1000);
    assert.equal(bundle.config.policy.allowed_summary_field_count, 2);
    assert.equal(bundle.config.store.busyTimeoutMs, 5000);
    assert.ok(bundle.config.api.token_file, 'config must name the token *file*');
    assert.equal(bundle.config.api.inline_token_present, true);
    // The inline token value itself must not be present (asserted as a string so a
    // future rename of the option cannot silently start printing it).
    assert.equal(result.body.includes(SECRET_MARKERS.inlineToken), false);

    // --- status snapshot -------------------------------------------------
    assert.equal(bundle.status.lifecycle, 'running');
    assert.equal(bundle.status.counters.source_failures, 3);
    assert.equal(bundle.status.health.status, 'degraded');
    // Functions in a status payload are dropped, not serialized; plain scalars stay.
    assert.equal(bundle.status.clock.nowMs, 1);
    assert.equal(Object.hasOwn(bundle.status.clock, 'tick'), false);

    // --- tables ----------------------------------------------------------
    assert.equal(bundle.tables.available, true);
    assert.equal(bundle.tables.schema_version, 7);
    assert.equal(bundle.tables.schema_version_source, 'schema_migration');
    const tableNames = bundle.tables.tables.map((table) => table.name);
    assert.deepEqual(tableNames, ['alpha', 'beta', 'schema_migration']);
    assert.equal(bundle.tables.tables.find((table) => table.name === 'alpha').rows, 2);
    assert.equal(bundle.tables.tables.find((table) => table.name === 'beta').rows, 0);
    assert.deepEqual(bundle.tables.errors, []);

    // --- process / port --------------------------------------------------
    assert.equal(bundle.process.pid, process.pid);
    assert.equal(bundle.process.ppid, process.ppid);
    assert.equal(bundle.process.started_at_ms, NOW_MS - 60_000);
    assert.equal(bundle.process.uptime_ms, 60_000);
    assert.ok(bundle.process.process_uptime_ms >= 0);
    const [port] = bundle.process.ports;
    assert.equal(port.name, 'api');
    assert.equal(port.configured_port, 17801);
    assert.equal(port.bound, 17801, 'status carried the bound port');

    // --- failures --------------------------------------------------------
    assert.equal(bundle.failures.counters.source_failures, 3);
    assert.equal(bundle.failures.counters.rejected_by_store, 1);
    assert.equal(bundle.failures.counters.contributions_dropped, 2);
    assert.equal(bundle.failures.counters.detection_faults, 2);
    assert.equal(bundle.failures.health.status, 'degraded');
    assert.deepEqual(bundle.failures.health.reasons, ['sources:none', 'detection:faults']);
    assert.equal(bundle.failures.detection.frozen, false);
    assert.equal(bundle.failures.api.requests, 5);
    assert.equal(bundle.failures.auth.accepted, 3);
    assert.equal(bundle.failures.checkpoint.writes, 7);

    // --- logs ------------------------------------------------------------
    assert.equal(bundle.logs.non_json_policy, NON_JSON_POLICY);
    assert.equal(bundle.logs.files.length, 1);
    assert.equal(bundle.logs.files[0].kind, 'shell_stderr');
    assert.equal(bundle.logs.files[0].parsed_lines, 1);
    assert.equal(bundle.logs.lines.length, 1);
    const [line] = bundle.logs.lines;
    assert.equal(line.code, 'SOURCE_TIMEOUT');
    assert.equal(line.source_id, 'win-svc');
    assert.equal(line.count, 2);
    assert.equal(line.uptime_ms, 60000);
    assert.equal(Object.hasOwn(line, 'extra_field'), false, 'non-allowlisted fields must be dropped');

    // The whitelist is part of the contract: the documented fields must be present.
    for (const field of ['at', 'level', 'msg', 'code', 'reason', 'state', 'source_id', 'count', 'host', 'port', 'limit', 'pid', 'uptime_ms']) {
      assert.ok(LOG_FIELDS.includes(field), `LOG_FIELDS lost ${field}`);
    }

    // --- summary self-consistency ---------------------------------------
    assert.equal(result.summary.filename, result.filename);
    assert.equal(result.summary.generated_at, bundle.generated_at);
    assert.equal(result.summary.bytes, Buffer.byteLength(result.body, 'utf8'));
    assert.equal(result.summary.logs.files, bundle.logs.files.length);
    assert.equal(result.summary.logs.lines, bundle.logs.lines.length);
    assert.equal(result.summary.tables.count, bundle.tables.tables.length);
    assert.equal(result.summary.tables.schema_version, 7);
    assert.equal(result.summary.tables.available, true);
    assert.equal(result.summary.redaction.total, bundle.redaction.total);
    assert.ok(result.summary.redaction.total > 0, 'redaction counts must be recorded');
    assert.equal(result.summary.errors, 0);
    assert.deepEqual(testCase.exported, [bundle.generated_at], 'onExported fires once, with the bundle timestamp');
    assert.equal(
      bundle.logs.lines.length,
      bundle.logs.totals.parsed_lines + bundle.logs.totals.non_json_dropped - bundle.logs.totals.skipped_old_lines,
    );
  });

  it('falls back to PRAGMA user_version when there is no migration table', async () => {
    const testCase = makeCase({ store: 'created' });
    // Replace the store with one that has no schema_migration table.
    rmSync(testCase.storePath, { force: true });
    createStore(testCase.storePath, { withMigration: false, userVersion: 5, tables: { gamma: 3 } });

    const result = await testCase.handlers.exportDiagnosticsBundle({});
    const bundle = JSON.parse(result.body);
    assert.equal(bundle.tables.available, true);
    assert.equal(bundle.tables.schema_version, 5);
    assert.equal(bundle.tables.schema_version_source, 'pragma_user_version');
    assert.deepEqual(bundle.tables.tables, [{ name: 'gamma', rows: 3 }]);
  });
});

describe('diagnostics bundle redaction', () => {
  it('leaks no key, bearer token, e-mail, user name or alert/event body', async () => {
    const testCase = makeCase();
    writeLog(join(testCase.dataDir, 'shell', 'daemon.stderr.log'), [
      JSON.stringify({
        at: RECENT_AT,
        level: 'error',
        msg: `auth failed with ${SECRET_MARKERS.skKey} and Bearer ${SECRET_MARKERS.bearerToken} `
          + `for ${SECRET_MARKERS.email} at ${SECRET_MARKERS.windowsPath}`,
        code: 'AUTH_FAILED',
        source_id: 'win-svc',
        // Secret-shaped *fields* are dropped by key, not by value shape.
        token: SECRET_MARKERS.inlineToken,
        // Payload-shaped fields are omitted entirely.
        payload: { event: SECRET_MARKERS.eventBody },
      }),
      JSON.stringify({
        at: RECENT_AT,
        level: 'info',
        msg: `home=${SECRET_MARKERS.posixHome} forward=${SECRET_MARKERS.windowsPathForward}`,
      }),
    ]);
    // A plain-text (non-JSON) line is exactly where free-form prose leaks.
    writeLog(join(testCase.dataDir, 'logs', 'desktop-20261105.log'), [
      `2026-11-05T10:00:00Z INFO desktop started user=alice ${SECRET_MARKERS.plainMarker} `
        + `${SECRET_MARKERS.windowsPath} ${SECRET_MARKERS.otherDrivePath} ${SECRET_MARKERS.secondEmail}`,
      JSON.stringify({ at: RECENT_AT, level: 'info', msg: 'rotation ok', source_id: 'win-svc' }),
    ]);
    // A settings file: the bundle must not read it, so its key must not appear.
    mkdirSync(join(testCase.dataDir, 'console'), { recursive: true });
    writeFileSync(
      join(testCase.dataDir, 'console', 'settings.json'),
      `${JSON.stringify({
        schemaVersion: '1.0',
        settings: { models: { providers: [{ id: 'p', apiKey: SECRET_MARKERS.settingsKey }] } },
      })}\n`,
    );

    const result = await testCase.handlers.exportDiagnosticsBundle({});
    const bundle = JSON.parse(result.body);

    // The grep is the assertion. Each pattern is applied to the exact returned bytes.
    assert.equal(/sk-[A-Za-z0-9]{8,}/u.test(result.body), false, 'an sk- key survived');
    assert.equal(/Bearer\s/u.test(result.body), false, 'a bearer scheme survived');
    assert.equal(/alice@example\.com/u.test(result.body), false, 'the e-mail survived');
    assert.equal(/carol@example\.com/u.test(result.body), false, 'the second e-mail survived');
    assert.equal(/C:\\Users\\alice/u.test(result.body), false, 'the Windows user path survived');
    assert.equal(/D:\\Users\\alice/u.test(result.body), false, 'the other-drive user path survived');
    assert.equal(/\/home\/alice/u.test(result.body), false, 'the POSIX home path survived');
    assert.equal(/alice/iu.test(result.body), false, 'the user name survived');
    assert.equal(/ALERT_BODY_MARKER/u.test(result.body), false, 'the plain-text marker survived');
    assert.equal(result.body.includes(SECRET_MARKERS.alertBody), false, 'the alert body survived');
    assert.equal(result.body.includes(SECRET_MARKERS.eventBody), false, 'the event body survived');
    assert.equal(result.body.includes(SECRET_MARKERS.settingsKey), false, 'the settings file was read');
    assert.equal(result.body.includes(SECRET_MARKERS.csrf), false, 'the CSRF value survived');
    assert.equal(result.body.includes(SECRET_MARKERS.inlineToken), false, 'the inline token survived');
    assert.equal(result.body.includes(SECRET_MARKERS.droppedField), false, 'a dropped field survived');

    // The counts are part of the product: support must be able to say what was masked.
    assert.ok(result.summary.redaction.total > 0);
    const counts = bundle.redaction.counts;
    assert.ok(counts.sk_secret >= 1, 'sk- rule did not fire');
    assert.ok((counts.bearer_token ?? 0) + (counts.bearer_scheme ?? 0) >= 1, 'bearer rule did not fire');
    assert.ok(counts.email >= 1);
    assert.ok(counts.windows_user_path >= 1);
    assert.ok(counts.secret_field >= 1, 'token-shaped fields must be redacted by key');
    assert.ok(counts.omitted_field >= 1, 'payload-shaped fields must be omitted');
    assert.equal(bundle.redaction.applied, true);
    assert.ok(bundle.redaction.rules.includes('windows_user_path'));

    // Non-JSON lines are counted, never quoted.
    const desktop = bundle.logs.files.find((file) => file.path.endsWith('desktop-20261105.log'));
    assert.ok(desktop, 'the desktop log must be listed');
    assert.ok(desktop.skipped_lines > 0, 'the plain-text line must be counted as skipped');
    assert.equal(desktop.non_json_policy, NON_JSON_POLICY);
    assert.ok(result.summary.logs.non_json_dropped > 0);
    assert.equal(result.body.includes('user=alice'), false);
    for (const entry of bundle.logs.lines) {
      assert.equal(Object.hasOwn(entry, 'text'), false, 'no free-form text line may be copied');
    }
  });

  it('caps a single text value at 4000 characters', async () => {
    const testCase = makeCase();
    const longMessage = `long ${'abc '.repeat(2000)}`;
    writeLog(join(testCase.dataDir, 'logs', 'big-msg.log'), [
      JSON.stringify({ at: RECENT_AT, level: 'warn', msg: longMessage }),
    ]);
    const result = await testCase.handlers.exportDiagnosticsBundle({});
    const bundle = JSON.parse(result.body);

    assert.equal(bundle.logs.lines.length, 1);
    const [line] = bundle.logs.lines;
    assert.ok(line.msg.length <= MAX_TEXT_CHARS, `msg is ${line.msg.length} chars`);
    assert.ok(line.msg.endsWith('[truncated]'));
    for (const text of collectStrings(bundle)) {
      assert.ok(text.length <= MAX_TEXT_CHARS, `a value exceeds ${MAX_TEXT_CHARS} chars`);
    }
    assert.ok((result.summary.limits_hit.text_truncated ?? 0) >= 1);
  });
});

describe('diagnostics bundle attachment safety', () => {
  it('uses a filename with no separators, no space and a safe disposition', async () => {
    const testCase = makeCase();
    const result = await testCase.handlers.exportDiagnosticsBundle({});

    assert.match(result.filename, /^diagnostics-bundle-\d{8}T\d{6}Z\.json$/u);
    assert.match(result.filename, /^[A-Za-z0-9._-]+$/u);
    assert.equal(result.filename.includes('/'), false);
    assert.equal(result.filename.includes('\\'), false);
    assert.equal(result.filename.includes(' '), false);
    assert.equal(result.filename.includes('..'), false);
    assert.equal(result.contentDisposition, `attachment; filename="${result.filename}"`);
    assert.equal(/[\r\n]/u.test(result.contentDisposition), false);
  });

  it('derives a safe filename even from a hostile clock string', async () => {
    const testCase = makeCase({
      clock: {
        nowIso: () => `2026-11-05T10:45:00Z"; filename=../evil path/inject.json`,
        nowMs: () => NOW_MS,
      },
    });
    const result = await testCase.handlers.exportDiagnosticsBundle({});
    assert.match(result.filename, /^[A-Za-z0-9._-]+$/u);
    assert.equal(result.filename.startsWith('diagnostics-bundle-'), true);
    assert.equal(result.filename.endsWith('.json'), true);
    assert.equal(result.filename.includes('..'), false);
    assert.equal(/[\r\n]/u.test(result.contentDisposition), false);
  });
});

describe('diagnostics bundle with an unreadable store', () => {
  it('reports available:false for a missing store path instead of failing', async () => {
    const testCase = makeCase({ store: 'missing' });
    const result = await testCase.handlers.exportDiagnosticsBundle({});
    const bundle = JSON.parse(result.body);

    assert.equal(bundle.tables.available, false);
    assert.equal(bundle.tables.reason, 'ENOENT');
    assert.deepEqual(bundle.tables.tables, []);
    assert.equal(bundle.tables.schema_version, null);
    assert.equal(result.summary.tables.available, false);
    // The rest of the bundle is still there.
    assert.equal(bundle.version.daemon_version, DAEMON_VERSION);
    assert.ok(bundle.logs);
  });

  it('reports available:false in mock mode (null storePath)', async () => {
    const testCase = makeCase({ store: 'none' });
    const result = await testCase.handlers.exportDiagnosticsBundle({});
    const bundle = JSON.parse(result.body);

    assert.equal(bundle.tables.available, false);
    assert.equal(bundle.tables.reason, 'NO_STORE_PATH');
    assert.equal(bundle.tables.path, null);
  });
});

describe('diagnostics bundle limits', () => {
  it('truncates a huge log, keeps the newest lines and stays under the bundle cap', async () => {
    const testCase = makeCase();
    const lines = [];
    for (let index = 0; index < 9000; index += 1) {
      lines.push(JSON.stringify({
        at: RECENT_AT,
        level: 'info',
        msg: `filler-${index} ${'x'.repeat(400)}`,
        count: index,
      }));
    }
    const newestMarker = 'NEWEST_LINE_MARKER_SHOULD_SURVIVE';
    lines.push(JSON.stringify({ at: RECENT_AT, level: 'warn', msg: newestMarker, code: 'LAST_LINE' }));
    writeLog(join(testCase.dataDir, 'logs', 'huge.log'), lines);

    const result = await testCase.handlers.exportDiagnosticsBundle({});
    const bundle = JSON.parse(result.body);

    assert.equal(bundle.logs.truncated, true, 'a truncated read must be reported');
    assert.equal(result.summary.truncated, true);
    assert.equal(Buffer.byteLength(result.body, 'utf8') <= MAX_BUNDLE_BYTES, true);
    assert.equal(result.summary.bytes <= MAX_BUNDLE_BYTES, true);
    assert.equal(bundle.logs.lines.length <= MAX_TOTAL_LINES, true);
    assert.equal(bundle.logs.files[0].head_truncated, true, 'the tail read must report the dropped head');
    assert.equal(bundle.logs.totals.bytes_read <= MAX_LOG_FILE_BYTES, true);
    // The newest line is what a support engineer needs first.
    assert.equal(result.body.includes(newestMarker), true);
    assert.ok((result.summary.limits_hit.log_bytes_capped ?? 0) >= 1);
  });
});

describe('POST /api/v1/diagnostics/bundle (real server)', () => {
  it('returns an attachment with 200 even when the store is absent', async () => {
    const { root, dataDir } = makeIsolatedRoot();
    assert.ok(root);
    writeLog(join(dataDir, 'logs', 'daemon.log'), [
      JSON.stringify({ at: RECENT_AT, level: 'info', msg: 'api started', code: 'STARTED' }),
    ]);
    const storePath = join(dataDir, 'store', 'absent.db');
    const exported = [];
    const diagnosticsHandlers = createDiagnosticsHandlers({
      config: baseConfig(dataDir, storePath),
      status: () => defaultStatus(dataDir, storePath),
      diagnostics: () => defaultDiagnostics(dataDir),
      dataDir,
      storePath,
      clock: { nowIso: () => NOW_ISO, nowMs: () => NOW_MS },
      logger: nullLogger,
      onExported: (iso) => exported.push(iso),
    });
    const clock = createManualClock(BASE_MS);
    const auth = createAuthGuard({
      token: TEST_TOKEN,
      clock,
      failureLimit: 1000,
      failureWindowMs: 60_000,
    });
    const api = createControlApi({
      config: {
        host: '127.0.0.1',
        port: 0,
        requestTimeoutMs: 30_000,
        headersTimeoutMs: 2000,
        keepAliveTimeoutMs: 1000,
        maxBodyBytes: 65_536,
        authFailureWindowMs: 60_000,
      },
      auth,
      logger: nullLogger,
      handlers: {
        health: () => ({ status: 'ok', version: DAEMON_VERSION }),
        ready: () => ({ ready: true, body: { ready: true, lifecycle: 'running', reasons: [] } }),
        status: () => ({ lifecycle: 'running' }),
        pollSource: async (sourceId) => ({ id: sourceId, lifecycle: 'ok' }),
        exportDiagnosticsBundle: diagnosticsHandlers.exportDiagnosticsBundle,
      },
    });
    try {
      const address = await api.start();
      const response = await httpJson(address.port, '/api/v1/diagnostics/bundle', {
        method: 'POST',
        token: TEST_TOKEN,
        csrf: auth.csrfToken,
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      const disposition = response.headers.get('content-disposition');
      assert.match(disposition, /^attachment; filename="[A-Za-z0-9._-]+"$/u);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

      const bundle = JSON.parse(response.text);
      for (const section of ['version', 'config', 'status', 'tables', 'process', 'failures', 'logs']) {
        assert.ok(Object.hasOwn(bundle, section), `HTTP bundle is missing ${section}`);
      }
      // Mock/ENOENT is a normal, supported export state — not a 500.
      assert.equal(bundle.tables.available, false);
      assert.equal(bundle.tables.reason, 'ENOENT');
      assert.equal(exported.length, 1, 'a successful export must advance exportBundleLastAt');

      // Missing CSRF proof: the route is a state-changing POST and must refuse.
      const denied = await httpJson(address.port, '/api/v1/diagnostics/bundle', {
        method: 'POST',
        token: TEST_TOKEN,
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error.code, 'CSRF_REQUIRED');
    } finally {
      await api.close();
    }
  });
});
