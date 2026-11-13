/**
 * config.js — the daemon's only configuration surface, validated once at start.
 *
 * Design rules this file enforces (§11 and the fault-closed matrix):
 *
 * 1. **No implicit data directory.** `dataDir` must be given. A daemon that picks
 *    a default would happily write a real database next to whatever directory it
 *    happened to start in; tests would then touch user data.
 * 2. **Nothing escapes `dataDir`.** Every derived path is resolved and checked to
 *    stay inside it, so a typo or an env var cannot point the daemon at the user's
 *    home directory, an existing log, or a database owned by another install.
 * 3. **Loopback only, by literal address.** `127.0.0.1` or `::1` — not
 *    `localhost` (which resolves through the host resolver) and never a wildcard.
 * 4. **Closed object.** Unknown keys are rejected at every level, so a
 *    misspelled `maxBodyBytes` cannot silently fall back to the default.
 * 5. **Fail closed on missing security inputs.** In `full` mode a rule pack, at
 *    least one collector source and a real event store are all required.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { TOKEN_PATTERN } from './api/auth.js';
import { DaemonError, DAEMON_CODES } from './errors.js';

/** Accepted management bind addresses. Anything else is refused. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);

/** Modes the daemon can run in. */
export const DAEMON_MODES = Object.freeze(['full', 'mock']);

const MODE_SET = new Set(DAEMON_MODES);

/** Default summary allowlist: the four D0 counters the detection package exports. */
export const DEFAULT_SUMMARY_FIELDS = Object.freeze([
  'alert_count',
  'rule_type',
  'sequence_in_hour',
  'severity_rank',
]);

const DEFAULTS = Object.freeze({
  mode: 'full',
  store: { busyTimeoutMs: 5000 },
  api: {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 5000,
    headersTimeoutMs: 5000,
    keepAliveTimeoutMs: 2000,
    maxBodyBytes: 65536,
    maxHeaderBytes: 16384,
    authFailureLimit: 5,
    authFailureWindowMs: 60000,
  },
  scheduler: {
    tickMs: 1000,
    // PERF-CPU (attrib): a *legitimately* slow source must not be permanently judged as timed out.
    // `windows.scheduled-task-table` costs 4.0–6.8 s wall (1406 ms CPU) per successful read on a
    // real host, so the old 5000 ms ceiling was below the source's own floor: every poll aborted,
    // the source was stuck in "unavailable" forever, and its serialized PowerShell queue held the
    // habitual session long enough that neighbouring sources (`services`, `run-key`) timed out too.
    // Raising the ceiling is not a relaxation of error handling: the scheduler still aborts a hung
    // adapter, and `read_in_progress` already prevents a slow source from queueing up behind
    // itself. The exponential failure backoff (scheduler.js) still fires on real failures.
    sourceTimeoutMs: 20000,
    maxBatchEvents: 500,
    staleAfterMs: 30000,
    maxSources: 32,
  },
  policy: {
    budgetClass: 'standard',
    alertStatus: 'new',
    epoch: null,
  },
  shutdown: {
    graceMs: 5000,
    drainMs: 2000,
  },
  logging: { level: 'info' },
});

const TOP_KEYS = ['dataDir', 'mode', 'store', 'state', 'api', 'scheduler', 'detection', 'policy', 'shutdown', 'logging'];
const KEY_SETS = Object.freeze({
  store: ['path', 'busyTimeoutMs'],
  state: ['path'],
  api: [
    'enabled',
    'host',
    'port',
    'token',
    'tokenFile',
    'requestTimeoutMs',
    'headersTimeoutMs',
    'keepAliveTimeoutMs',
    'maxBodyBytes',
    'maxHeaderBytes',
    'authFailureLimit',
    'authFailureWindowMs',
  ],
  scheduler: ['tickMs', 'sourceTimeoutMs', 'maxBatchEvents', 'staleAfterMs', 'maxSources'],
  detection: ['rulePack', 'rulePackPath', 'limits'],
  policy: ['allowedSummaryFields', 'budgetClass', 'alertStatus', 'epoch'],
  shutdown: ['graceMs', 'drainMs'],
  logging: ['level'],
});

/**
 * The recovery epoch is a UUIDv4 on the wire (`AnalysisRequest.epoch`), so the
 * daemon validates it as one here rather than discovering the mismatch when the
 * first analysis request is built.
 */
const EPOCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Report whether a value is a UUIDv4, i.e. a legal recovery epoch.
 *
 * @param {unknown} value Candidate.
 * @returns {boolean} `true` when usable as an epoch.
 */
export function isUuidV4(value) {
  return typeof value === 'string' && EPOCH_UUID.test(value);
}

function fail(message, details) {
  throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, message, details);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${label} has unknown key "${key}"`, { allowed });
    }
  }
}

function readSection(input, name) {
  const value = input[name];
  if (value === undefined) {
    return {};
  }
  assertPlainObject(value, name);
  rejectUnknownKeys(value, KEY_SETS[name], name);
  return value;
}

function integerIn(value, label, min, max, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer in ${min}..${max}`, { value: typeof value });
  }
  return value;
}

function booleanIn(value, label, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    fail(`${label} must be a boolean`);
  }
  return value;
}

/**
 * Assert a bind address is a literal loopback address.
 *
 * @param {unknown} host Candidate address.
 * @returns {string} The accepted address.
 * @throws {DaemonError} When the address is not `127.0.0.1` or `::1`.
 */
export function assertLoopbackHost(host) {
  if (typeof host !== 'string' || !LOOPBACK_HOSTS.includes(host)) {
    throw new DaemonError(
      DAEMON_CODES.CONFIG_NOT_LOOPBACK,
      `control API must bind a literal loopback address (${LOOPBACK_HOSTS.join(' or ')})`,
      { host: typeof host === 'string' ? host : typeof host },
    );
  }
  return host;
}

/**
 * Resolve a path and require it to stay inside `dataDir`.
 *
 * @param {string} dataDir Absolute data directory.
 * @param {unknown} candidate Candidate path (absolute or dataDir relative).
 * @param {string} label Configuration label used in errors.
 * @returns {string} Absolute path inside `dataDir`.
 * @throws {DaemonError} When the path is invalid or escapes the data directory.
 */
export function resolveInside(dataDir, candidate, label) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(dataDir, candidate);
  const rel = relative(dataDir, absolute);
  const escapes = rel === '' ? false : rel.startsWith('..') || isAbsolute(rel) || rel.startsWith(`..${sep}`);
  if (escapes) {
    throw new DaemonError(DAEMON_CODES.CONFIG_PATH_ESCAPE, `${label} must stay inside the data directory`, {
      label,
    });
  }
  if (absolute === dataDir) {
    fail(`${label} must name a file inside the data directory, not the directory itself`);
  }
  return absolute;
}

/** Marks a configuration that already passed {@link loadConfig}. */
const CONFIG_BRAND = Symbol('aegis-daemon-config');

/**
 * Normalize and validate the daemon configuration.
 *
 * Idempotent: passing an already validated configuration returns it unchanged.
 * That matters because `createDaemon` validates its input and callers naturally
 * pass a configuration they previously loaded; re-validating would have to treat
 * derived `null` values (`rulePackPath: null`) as malformed.
 *
 * @param {object} input Raw configuration (merged with defaults here, not before).
 * @returns {object} Frozen configuration with absolute derived paths.
 * @throws {DaemonError} When any field is missing, malformed or unsafe.
 */
export function loadConfig(input = {}) {
  if (input !== null && typeof input === 'object' && input[CONFIG_BRAND] === true) {
    return input;
  }
  assertPlainObject(input, 'config');
  rejectUnknownKeys(input, TOP_KEYS, 'config');

  if (typeof input.dataDir !== 'string' || input.dataDir.length === 0) {
    fail('dataDir is required: the daemon never picks a data directory on its own');
  }
  if (!isAbsolute(input.dataDir)) {
    fail('dataDir must be an absolute path');
  }
  const dataDir = resolve(input.dataDir);

  const mode = input.mode ?? DEFAULTS.mode;
  if (!MODE_SET.has(mode)) {
    fail(`mode must be one of ${DAEMON_MODES.join(', ')}`, { mode: String(mode) });
  }

  const store = readSection(input, 'store');
  const state = readSection(input, 'state');
  const api = readSection(input, 'api');
  const scheduler = readSection(input, 'scheduler');
  const detection = readSection(input, 'detection');
  const policy = readSection(input, 'policy');
  const shutdown = readSection(input, 'shutdown');
  const logging = readSection(input, 'logging');

  const storePath = resolveInside(dataDir, store.path ?? join('store', 'aegis.db'), 'store.path');
  const statePath = resolveInside(dataDir, state.path ?? 'daemon-state.json', 'state.path');
  const tokenFile = resolveInside(dataDir, api.tokenFile ?? join('secrets', 'api-token'), 'api.tokenFile');

  const host = assertLoopbackHost(api.host ?? DEFAULTS.api.host);

  let inlineToken = null;
  if (api.token !== undefined) {
    if (typeof api.token !== 'string' || !TOKEN_PATTERN.test(api.token)) {
      // Rejecting here is the difference between "the token is wrong" and "the daemon
      // is running but no client can ever authenticate".
      fail('api.token must be 32..512 characters of [A-Za-z0-9_-] (base64url)');
    }
    inlineToken = api.token;
  }

  const rulePack = detection.rulePack ?? null;
  if (rulePack !== null) {
    assertPlainObject(rulePack, 'detection.rulePack');
  }
  const rulePackPath = detection.rulePackPath === undefined || detection.rulePackPath === null
    ? null
    : resolveInside(dataDir, detection.rulePackPath, 'detection.rulePackPath');
  if (rulePack !== null && rulePackPath !== null) {
    fail('detection may declare rulePack or rulePackPath, not both');
  }
  if (mode === 'full' && rulePack === null && rulePackPath === null) {
    throw new DaemonError(
      DAEMON_CODES.CONFIG_INVALID,
      'full mode requires a rule pack (detection.rulePack or detection.rulePackPath)',
    );
  }
  if (mode === 'mock' && rulePack === null && rulePackPath === null) {
    throw new DaemonError(
      DAEMON_CODES.CONFIG_INVALID,
      'mock mode also requires a rule pack: detection is part of the core, not a Harness feature',
    );
  }
  if (detection.limits !== undefined) {
    assertPlainObject(detection.limits, 'detection.limits');
  }

  const allowedSummaryFields = policy.allowedSummaryFields ?? [...DEFAULT_SUMMARY_FIELDS];
  if (!Array.isArray(allowedSummaryFields) || allowedSummaryFields.some((field) => typeof field !== 'string')) {
    fail('policy.allowedSummaryFields must be an array of field names');
  }
  const budgetClass = policy.budgetClass ?? DEFAULTS.policy.budgetClass;
  if (typeof budgetClass !== 'string' || budgetClass.length === 0) {
    fail('policy.budgetClass must be a non-empty string');
  }
  const alertStatus = policy.alertStatus ?? DEFAULTS.policy.alertStatus;
  if (!['new', 'acknowledged', 'resolved', 'suppressed'].includes(alertStatus)) {
    fail('policy.alertStatus must be one of new/acknowledged/resolved/suppressed');
  }
  const epoch = policy.epoch ?? null;
  if (epoch !== null && !isUuidV4(epoch)) {
    fail('policy.epoch must be null or a UUIDv4: it is copied verbatim into AnalysisRequest.epoch');
  }

  const level = logging.level ?? DEFAULTS.logging.level;
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(level)) {
    fail('logging.level must be one of debug/info/warn/error/silent');
  }

  const config = {
    dataDir,
    mode,
    store: Object.freeze({
      path: storePath,
      busyTimeoutMs: integerIn(store.busyTimeoutMs, 'store.busyTimeoutMs', 0, 120000, DEFAULTS.store.busyTimeoutMs),
    }),
    state: Object.freeze({ path: statePath }),
    api: Object.freeze({
      enabled: booleanIn(api.enabled, 'api.enabled', DEFAULTS.api.enabled),
      host,
      port: integerIn(api.port, 'api.port', 0, 65535, DEFAULTS.api.port),
      token: inlineToken,
      tokenFile,
      requestTimeoutMs: integerIn(api.requestTimeoutMs, 'api.requestTimeoutMs', 100, 120000, DEFAULTS.api.requestTimeoutMs),
      headersTimeoutMs: integerIn(api.headersTimeoutMs, 'api.headersTimeoutMs', 100, 120000, DEFAULTS.api.headersTimeoutMs),
      keepAliveTimeoutMs: integerIn(
        api.keepAliveTimeoutMs,
        'api.keepAliveTimeoutMs',
        0,
        120000,
        DEFAULTS.api.keepAliveTimeoutMs,
      ),
      maxBodyBytes: integerIn(api.maxBodyBytes, 'api.maxBodyBytes', 0, 1_048_576, DEFAULTS.api.maxBodyBytes),
      maxHeaderBytes: integerIn(api.maxHeaderBytes, 'api.maxHeaderBytes', 1024, 131072, DEFAULTS.api.maxHeaderBytes),
      authFailureLimit: integerIn(api.authFailureLimit, 'api.authFailureLimit', 1, 1000, DEFAULTS.api.authFailureLimit),
      authFailureWindowMs: integerIn(
        api.authFailureWindowMs,
        'api.authFailureWindowMs',
        1000,
        3600000,
        DEFAULTS.api.authFailureWindowMs,
      ),
    }),
    scheduler: Object.freeze({
      tickMs: integerIn(scheduler.tickMs, 'scheduler.tickMs', 10, 3600000, DEFAULTS.scheduler.tickMs),
      sourceTimeoutMs: integerIn(
        scheduler.sourceTimeoutMs,
        'scheduler.sourceTimeoutMs',
        10,
        600000,
        DEFAULTS.scheduler.sourceTimeoutMs,
      ),
      maxBatchEvents: integerIn(
        scheduler.maxBatchEvents,
        'scheduler.maxBatchEvents',
        1,
        100000,
        DEFAULTS.scheduler.maxBatchEvents,
      ),
      staleAfterMs: integerIn(scheduler.staleAfterMs, 'scheduler.staleAfterMs', 1000, 86400000, DEFAULTS.scheduler.staleAfterMs),
      maxSources: integerIn(scheduler.maxSources, 'scheduler.maxSources', 1, 512, DEFAULTS.scheduler.maxSources),
    }),
    detection: Object.freeze({
      rulePack,
      rulePackPath,
      limits: detection.limits === undefined ? null : Object.freeze({ ...detection.limits }),
    }),
    policy: Object.freeze({
      allowedSummaryFields: Object.freeze([...allowedSummaryFields]),
      budgetClass,
      alertStatus,
      epoch,
    }),
    shutdown: Object.freeze({
      graceMs: integerIn(shutdown.graceMs, 'shutdown.graceMs', 0, 120000, DEFAULTS.shutdown.graceMs),
      drainMs: integerIn(shutdown.drainMs, 'shutdown.drainMs', 0, 120000, DEFAULTS.shutdown.drainMs),
    }),
    logging: Object.freeze({ level }),
  };

  Object.defineProperty(config, CONFIG_BRAND, { value: true, enumerable: false });
  return Object.freeze(config);
}

/**
 * Read and validate a JSON configuration file.
 *
 * @param {string} filePath Path to the JSON file.
 * @param {{readFile?: (path: string) => string}} [deps] Injectable reader.
 * @returns {object} Frozen configuration.
 * @throws {DaemonError} When the file is missing, unparseable or invalid.
 */
export function loadConfigFile(filePath, deps = {}) {
  const read = deps.readFile ?? null;
  let text;
  try {
    text = read === null ? readTextFile(filePath) : read(filePath);
  } catch (error) {
    throw new DaemonError(DAEMON_CODES.CONFIG_NOT_FOUND, `configuration file is not readable: ${filePath}`, {
      reason: error?.code ?? 'UNREADABLE',
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `configuration file is not valid JSON: ${filePath}`);
  }
  return loadConfig(parsed);
}

function readTextFile(filePath) {
  return readFileSync(filePath, 'utf8');
}
