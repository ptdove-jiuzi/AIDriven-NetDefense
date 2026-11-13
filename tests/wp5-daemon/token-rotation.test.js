/**
 * token-rotation.test.js — `diagnostics.rotateToken` (POST
 * /api/v1/diagnostics/token-rotate), OPS-DIAG 战役.
 *
 * What is real here:
 * 1. the **guard** (`api/auth.js`) and the **rotator** (`api/rotator.js`) are the
 *    production modules — no test double;
 * 2. every *externally observable* effect is asserted over **real HTTP** against a
 *    real `createControlApi` listener on an ephemeral loopback port: the old token
 *    gets `401` + `WWW-Authenticate`, the new token gets `200`, the CSRF proof the
 *    console re-reads has changed, the stale proof is refused with `CSRF_REQUIRED`;
 * 3. the audit file and the token file are the real ones under a temporary data
 *    directory, and the "no secret leaked" checks grep the real bytes.
 *
 * Every rotation in the "live control API" block goes through the real route in
 * `api/server.js` — `POST /api/v1/diagnostics/token-rotate` → `rotateApiToken` →
 * `rotator.rotate()` — including its admission order: bearer first, then CSRF. A tree
 * where that route has been dropped turns this file red on purpose: the route is part
 * of the deliverable, not an optional transport.
 *
 * Two cases start the rotation through the module instead:
 * - the concurrency case, because `rotate()` is synchronous and issuing the requests
 *   plus rotating in the same turn guarantees every request is authenticated against
 *   the *new* guard state (a second HTTP request would race the scheduler, not the
 *   guard);
 * - the fail-closed case, which has to plant a directory on the credential path first.
 *
 * Fixtures are self-contained on purpose (`console-fixtures.mjs` belongs to another
 * seat and is not edited here): one temporary directory per test, removed at file
 * end, no real user data, no network beyond 127.0.0.1.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createAuthGuard, generateToken, isUsableToken } from '../../apps/daemon/src/api/auth.js';
import { createControlApi } from '../../apps/daemon/src/api/server.js';
import { createTokenRotation } from '../../apps/daemon/src/api/rotator.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { DaemonError, DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { createLogger } from '../../apps/daemon/src/log.js';

/** Fixed wall clock so `rotated_at` and the audit `at` are deterministic. */
const BASE_MS = Date.UTC(2026, 10, 5, 10, 0, 0);

/** The credential provisioned before the test starts (a file-sourced token). */
const SEED_TOKEN = 'ops-diag-rotation-seed-token-0123456789ab';

/** CSRF header name (mirrors `api/auth.js`). */
const CSRF_HEADER = 'x-aegis-csrf';

/** Route under test. */
const ROTATE_PATH = '/api/v1/diagnostics/token-rotate';

/** A state-changing route that exists today, used as the "real write" probe. */
const WRITE_PATH = '/api/v1/collectors/rotation-probe/poll';

/** Temporary directories, removed once the file finishes. */
const TEMP_DIRS = new Set();

after(() => {
  for (const directory of TEMP_DIRS) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A leaked handle on Windows must not fail an otherwise passing suite.
    }
  }
  TEMP_DIRS.clear();
});

/**
 * Create a temporary data directory removed at the end of the test file.
 *
 * @returns {string} Absolute path.
 */
function makeTempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-token-rotation-'));
  TEMP_DIRS.add(directory);
  return directory;
}

/**
 * First 16 hex characters of a token's SHA-256 — the audited fingerprint.
 *
 * @param {string} token Token.
 * @returns {string} Fingerprint.
 */
function fingerprintOf(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Issue one HTTP request and decode a JSON body.
 *
 * @param {number} port Bound port.
 * @param {string} pathname Request path.
 * @param {{method?: string, token?: string, csrf?: string, body?: unknown}} [options] Options.
 * @returns {Promise<{status: number, headers: Headers, text: string, body: any}>} Response.
 */
async function httpJson(port, pathname, options = {}) {
  const headers = {};
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.csrf !== undefined) {
    headers[CSRF_HEADER] = options.csrf;
  }
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

/**
 * Start the real auth guard, rotator and control API on an ephemeral loopback port.
 *
 * @param {{failureLimit?: number, persistToken?: boolean}} [options] Options.
 *   `persistToken: false` models a daemon whose token came from inline configuration:
 *   `<dataDir>/secrets/` and the token file do not exist yet.
 * @returns {Promise<object>} Fixture.
 */
async function startFixture(options = {}) {
  const dataDir = makeTempDir();
  const secretsDir = join(dataDir, 'secrets');
  const tokenFile = join(secretsDir, 'api-token');
  if (options.persistToken !== false) {
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(tokenFile, `${SEED_TOKEN}\n`, { mode: 0o600 });
  }

  const clock = createManualClock(BASE_MS);
  const lines = [];
  const logger = createLogger({
    level: 'debug',
    clock: { nowIso: () => new Date(BASE_MS).toISOString() },
    stream: {
      write(chunk) {
        lines.push(String(chunk));
        return true;
      },
    },
  });
  const auth = createAuthGuard({
    token: SEED_TOKEN,
    clock,
    failureLimit: options.failureLimit ?? 1000,
    failureWindowMs: 60_000,
  });
  const rotation = createTokenRotation({ auth, tokenFile, dataDir, clock, logger });
  const api = createControlApi({
    config: {
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 30000,
      headersTimeoutMs: 2000,
      keepAliveTimeoutMs: 1000,
      maxBodyBytes: 65536,
      authFailureWindowMs: 60_000,
    },
    auth,
    logger,
    handlers: {
      health: () => ({ status: 'ok', version: 'test' }),
      ready: () => ({ ready: true, body: { ready: true, lifecycle: 'running', reasons: [] } }),
      status: () => ({ lifecycle: 'running' }),
      pollSource: async (sourceId) => ({ id: sourceId, lifecycle: 'ok' }),
      // The name the Lead's route invokes; present from the start so the route works
      // the moment `server.js` grows it, with no test edit.
      rotateApiToken: async () => rotation.rotate(),
    },
  });
  const address = await api.start();
  return {
    api,
    auth,
    rotation,
    dataDir,
    tokenFile,
    port: address.port,
    currentToken: SEED_TOKEN,
    loggerText: () => lines.join(''),
    close: async () => {
      await api.close();
    },
  };
}

/**
 * Rotate once through the real `POST /api/v1/diagnostics/token-rotate` route.
 *
 * @param {object} fixture Fixture.
 * @returns {Promise<{status: number, text: string, receipt: object}>} Rotation receipt.
 */
async function rotateOnce(fixture) {
  const status = await httpJson(fixture.port, '/api/v1/status', { token: fixture.currentToken });
  assert.equal(status.status, 200, 'the current token must still be valid before rotating');
  const csrf = status.body.csrf_token;
  const response = await httpJson(fixture.port, ROTATE_PATH, {
    method: 'POST',
    token: fixture.currentToken,
    csrf,
    body: {},
  });
  assert.equal(
    response.status,
    200,
    `token-rotate must answer 200, got ${response.status} (is POST ${ROTATE_PATH} still wired?): ${response.text}`,
  );
  assert.equal(typeof response.body?.token, 'string', `token-rotate body: ${response.text}`);
  fixture.currentToken = response.body.token;
  return { status: response.status, text: response.text, receipt: response.body };
}

/**
 * Read the audit log as JSONL records.
 *
 * @param {string} dataDir Data directory.
 * @returns {{path: string, text: string, records: object[]}} Audit log.
 */
function readAudit(dataDir) {
  const path = join(dataDir, 'console', 'audit.log');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const records = text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  return { path, text, records };
}

describe('rotateTo (auth guard)', () => {
  it('rejects an unusable token without touching the live credential', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: SEED_TOKEN, clock, failureLimit: 5, failureWindowMs: 60_000 });
    const csrfBefore = guard.csrfToken;
    const cursorBefore = guard.cursorKey;

    assert.throws(() => guard.rotateTo('too-short'), (error) => {
      assert.ok(error instanceof DaemonError);
      assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
      return true;
    });
    assert.deepEqual(guard.authenticate(`Bearer ${SEED_TOKEN}`, '127.0.0.1'), { ok: true });
    assert.equal(guard.csrfToken, csrfBefore);
    assert.deepEqual(guard.cursorKey, cursorBefore);
  });

  it('swaps the credential, and derives a new CSRF proof and cursor key', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: SEED_TOKEN, clock, failureLimit: 5, failureWindowMs: 60_000 });
    const csrfBefore = guard.csrfToken;
    const cursorBefore = guard.cursorKey;
    const next = generateToken();

    assert.equal(guard.rotateTo(next), undefined);
    assert.deepEqual(guard.authenticate(`Bearer ${next}`, '127.0.0.1'), { ok: true });
    assert.equal(guard.authenticate(`Bearer ${SEED_TOKEN}`, '127.0.0.1').ok, false);
    assert.notEqual(guard.csrfToken, csrfBefore);
    assert.notDeepEqual(guard.cursorKey, cursorBefore);
    // The derivation constants are unchanged: only the token they are keyed on moved.
    assert.equal(
      guard.csrfToken,
      createHash('sha256').update(`aegis-csrf:${next}`, 'utf8').digest('base64url'),
    );
  });

  it('clears the failure buckets so a stale lockout does not outlive the rotation', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: SEED_TOKEN, clock, failureLimit: 2, failureWindowMs: 60_000 });
    assert.equal(guard.authenticate('Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'peer-a').code, DAEMON_CODES.AUTH_FAILED);
    assert.equal(guard.authenticate('Bearer bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'peer-a').code, DAEMON_CODES.AUTH_FAILED);
    // Quota exhausted: a further guess is throttled.
    assert.equal(guard.authenticate('Bearer cccccccccccccccccccccccccccc', 'peer-a').code, DAEMON_CODES.AUTH_RATE_LIMITED);
    assert.equal(guard.stats().buckets, 1);

    guard.rotateTo(generateToken());
    assert.equal(guard.stats().buckets, 0);
    // A guess after the rotation is a plain failure, not a leftover lockout.
    assert.equal(guard.authenticate('Bearer dddddddddddddddddddddddddddd', 'peer-a').code, DAEMON_CODES.AUTH_FAILED);
  });
});

describe('token rotation over the live control API', () => {
  it('answers with a fresh 43-character token that is exactly what the token file now holds', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    assert.equal(readFileSync(fixture.tokenFile, 'utf8').trim(), SEED_TOKEN);

    const rotation = await rotateOnce(fixture);
    assert.equal(rotation.status, 200);
    const receipt = rotation.receipt;
    assert.equal(typeof receipt.token, 'string');
    assert.equal(receipt.token.length, 43);
    assert.match(receipt.token, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(isUsableToken(receipt.token), true);
    assert.notEqual(receipt.token, SEED_TOKEN);
    assert.equal(readFileSync(fixture.tokenFile, 'utf8').trim(), receipt.token);
    assert.equal(receipt.fingerprint, fingerprintOf(receipt.token));
    assert.equal(receipt.previous_fingerprint, fingerprintOf(SEED_TOKEN));
    assert.equal(receipt.audit.appended, true);
    assert.equal(receipt.audit.path, join(fixture.dataDir, 'console', 'audit.log'));
    assert.equal(typeof receipt.rotated_at, 'string');
    assert.equal(fixture.rotation.lastRotatedAt(), receipt.rotated_at);
    // The old credential must not survive anywhere in the rotation response.
    assert.equal(rotation.text.includes(SEED_TOKEN), false, 'the response must not echo the old token');
    assert.equal(rotation.text.toLowerCase().includes('csrf'), false, 'the response must not carry the CSRF proof');
  });

  it('rejects the old token immediately with 401 + WWW-Authenticate and serves the new one', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const rotation = await rotateOnce(fixture);
    const newToken = rotation.receipt.token;

    const stale = await httpJson(fixture.port, '/api/v1/status', { token: SEED_TOKEN });
    assert.equal(stale.status, 401);
    assert.match(stale.headers.get('www-authenticate') ?? '', /^Bearer\b/u);
    assert.equal(stale.body.error.code, 'AUTH_FAILED');

    const fresh = await httpJson(fixture.port, '/api/v1/status', { token: newToken });
    assert.equal(fresh.status, 200);
    assert.equal(typeof fresh.body.csrf_token, 'string');

    // ... and the old token is refused on a read-only query route too, not just /status.
    const staleAlerts = await httpJson(fixture.port, '/api/v1/alerts', { token: SEED_TOKEN });
    assert.equal(staleAlerts.status, 401);
  });

  it('moves the CSRF proof with the token: the stale proof is refused, the new one writes', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const before = await httpJson(fixture.port, '/api/v1/status', { token: SEED_TOKEN });
    const staleCsrf = before.body.csrf_token;

    const rotation = await rotateOnce(fixture);
    const newToken = rotation.receipt.token;
    const afterRotation = await httpJson(fixture.port, '/api/v1/status', { token: newToken });
    const newCsrf = afterRotation.body.csrf_token;
    assert.notEqual(newCsrf, staleCsrf, 'the CSRF proof must change when the token rotates');

    const staleWrite = await httpJson(fixture.port, WRITE_PATH, {
      method: 'POST',
      token: newToken,
      csrf: staleCsrf,
      body: {},
    });
    assert.equal(staleWrite.status, 403);
    assert.equal(staleWrite.body.error.code, 'CSRF_REQUIRED');

    const acceptedWrite = await httpJson(fixture.port, WRITE_PATH, {
      method: 'POST',
      token: newToken,
      csrf: newCsrf,
      body: {},
    });
    assert.equal(acceptedWrite.status, 200, JSON.stringify(acceptedWrite.body));
    assert.equal(acceptedWrite.body.source.id, 'rotation-probe');
  });

  it('admits no request carrying the old token once a concurrent rotation lands', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const staleCsrf = fixture.auth.csrfToken;

    const pending = [];
    for (let index = 0; index < 5; index += 1) {
      pending.push(httpJson(fixture.port, '/api/v1/status', { token: SEED_TOKEN }));
    }
    for (let index = 0; index < 5; index += 1) {
      pending.push(httpJson(fixture.port, WRITE_PATH, {
        method: 'POST',
        token: SEED_TOKEN,
        csrf: staleCsrf,
        body: {},
      }));
    }
    // Started in the same turn as the requests above: `rotate()` is synchronous, so the
    // guard has already switched by the time the listener can accept a connection. The
    // "in flight" window is therefore closed on the strict side, which is the property
    // under test ("no request may be admitted on the old credential").
    const receipt = fixture.rotation.rotate();
    const responses = await Promise.all(pending);

    assert.equal(responses.length, 10);
    const statuses = responses.map((response) => response.status);
    assert.deepEqual(statuses, new Array(10).fill(401), `concurrent answers: ${statuses.join(',')}`);
    assert.equal(statuses.filter((status) => status === 200).length, 0, 'a rotation must not leak a 200');
    for (const response of responses) {
      assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer\b/u);
    }

    const afterRotation = await httpJson(fixture.port, '/api/v1/status', { token: receipt.token });
    assert.equal(afterRotation.status, 200, 'the new token must work right after the concurrent window');
  });

  it('audits one secret-free line and keeps the token file and audit file private', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const rotation = await rotateOnce(fixture);
    const newToken = rotation.receipt.token;

    const audit = readAudit(fixture.dataDir);
    assert.equal(existsSync(audit.path), true);
    assert.equal(audit.text.includes(newToken), false, 'the audit log must never contain the new token');
    assert.equal(audit.text.includes(SEED_TOKEN), false, 'the audit log must never contain the old token');
    assert.match(audit.text, /"event":"api\.token\.rotate"/u);
    assert.equal(audit.records.length, 1);
    assert.deepEqual(
      Object.keys(audit.records[0]).sort(),
      ['at', 'event', 'fingerprint', 'previous_fingerprint', 'reason', 'result'],
      'the audit record must not grow fields that could carry a secret',
    );
    assert.equal(audit.records[0].event, 'api.token.rotate');
    assert.equal(audit.records[0].result, 'ok');
    assert.equal(audit.records[0].fingerprint, fingerprintOf(newToken));
    assert.equal(audit.records[0].previous_fingerprint, fingerprintOf(SEED_TOKEN));
    assert.equal(audit.records[0].reason, null);

    // Neither the daemon log nor the guard's own stats carry the credential.
    assert.equal(fixture.loggerText().includes(newToken), false);
    assert.equal(fixture.loggerText().includes(SEED_TOKEN), false);

    if (process.platform !== 'win32') {
      assert.equal(statSync(fixture.tokenFile).mode & 0o777, 0o600, 'the token file must stay 0600');
      assert.equal(statSync(audit.path).mode & 0o777, 0o600, 'the audit file must be 0600');
      assert.equal(statSync(join(fixture.dataDir, 'console')).mode & 0o777, 0o700, 'the audit directory must be 0700');
    }
  });

  it('keeps three consecutive rotations distinct, each predecessor rejected', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const seen = new Set();
    let current = SEED_TOKEN;
    for (let round = 0; round < 3; round += 1) {
      const rotation = await rotateOnce(fixture);
      const next = rotation.receipt.token;
      assert.equal(seen.has(next), false, 'every rotation must mint a fresh token');
      assert.notEqual(next, current);
      seen.add(next);
      assert.equal(readFileSync(fixture.tokenFile, 'utf8').trim(), next);
      assert.equal(rotation.receipt.previous_fingerprint, fingerprintOf(current));

      const stale = await httpJson(fixture.port, '/api/v1/status', { token: current });
      assert.equal(stale.status, 401, `round ${round}: the previous token must be refused`);
      const fresh = await httpJson(fixture.port, '/api/v1/status', { token: next });
      assert.equal(fresh.status, 200, `round ${round}: the current token must be served`);
      current = next;
    }
    assert.equal(seen.size, 3);
    assert.equal(readAudit(fixture.dataDir).records.filter((record) => record.result === 'ok').length, 3);
  });

  it('creates a missing token directory: rotation must work when the token came from config', async (t) => {
    // Regression (Lead, real daemon, 2026-11-05): with `api.token` supplied by the
    // configuration, `provisionApiToken` never runs its mkdir branch, so
    // `<dataDir>/secrets/` does not exist and the atomic rename failed with
    // `500 CONFIG_INVALID / reason: ENOENT`. The rotation now creates the directory.
    const fixture = await startFixture({ persistToken: false });
    t.after(() => fixture.close());
    assert.equal(existsSync(join(fixture.dataDir, 'secrets')), false, 'precondition: no token directory');

    const rotation = await rotateOnce(fixture);
    assert.equal(existsSync(join(fixture.dataDir, 'secrets')), true, 'the token directory must be created');
    assert.equal(readFileSync(fixture.tokenFile, 'utf8').trim(), rotation.receipt.token);
    assert.equal(rotation.receipt.previous_fingerprint, null, 'no token file existed before the rotation');

    const stale = await httpJson(fixture.port, '/api/v1/status', { token: SEED_TOKEN });
    assert.equal(stale.status, 401, 'the configured token must stop working immediately');
    const fresh = await httpJson(fixture.port, '/api/v1/status', { token: rotation.receipt.token });
    assert.equal(fresh.status, 200);

    if (process.platform !== 'win32') {
      assert.equal(statSync(fixture.tokenFile).mode & 0o777, 0o600, 'the created token file must be 0600');
      assert.equal(
        statSync(join(fixture.dataDir, 'secrets')).mode & 0o777,
        0o700,
        'the created token directory must be 0700',
      );
    }
  });

  it('fails closed when the token file cannot be replaced, and the old token keeps working', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    // A directory occupying the credential path makes the atomic rename fail on every
    // platform (POSIX EISDIR, Windows EPERM/EEXIST) without needing a read-only ACL.
    rmSync(fixture.tokenFile, { force: true });
    mkdirSync(fixture.tokenFile);
    const csrfBefore = fixture.auth.csrfToken;

    assert.throws(() => fixture.rotation.rotate(), (error) => {
      assert.ok(error instanceof DaemonError, `expected a DaemonError, got ${error?.name ?? typeof error}`);
      assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
      return true;
    });
    assert.equal(fixture.rotation.lastRotatedAt(), null, 'a failed rotation must not be recorded as done');
    assert.equal(fixture.auth.csrfToken, csrfBefore, 'the in-memory credential must be unchanged');

    const stillValid = await httpJson(fixture.port, '/api/v1/status', { token: SEED_TOKEN });
    assert.equal(stillValid.status, 200, 'the old token must remain the live credential');

    // The failure is logged, still without the credential, and no temp file is left.
    const audit = readAudit(fixture.dataDir);
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0].result, 'failed');
    assert.equal(audit.records[0].reason, DAEMON_CODES.CONFIG_INVALID);
    assert.equal(audit.text.includes(SEED_TOKEN), false);
    assert.deepEqual(readdirSync(join(fixture.dataDir, 'secrets')), ['api-token']);
  });
});
