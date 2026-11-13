/**
 * api-auth.test.js — token provisioning, bearer checks, CSRF, host and origin.
 *
 * These are the checks that stand between "a web page in the operator's browser"
 * and "the daemon's control plane". Each one is tested for the negative case first.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import {
  CSRF_HEADER,
  MIN_TOKEN_LENGTH,
  createAuthGuard,
  generateToken,
  isAllowedHost,
  isAllowedOrigin,
  isUsableToken,
  provisionApiToken,
  readBearer,
  safeEqual,
} from '../../apps/daemon/src/api/auth.js';
import { BASE_MS, createManualClock, makeTempDir, TEST_TOKEN } from './helpers.js';

describe('generateToken', () => {
  it('produces a distinct 43-character base64url token', () => {
    const first = generateToken();
    const second = generateToken();
    assert.equal(first.length, 43);
    assert.match(first, /^[A-Za-z0-9_-]+$/u);
    assert.notEqual(first, second);
    assert.ok(first.length >= MIN_TOKEN_LENGTH);
  });
});

describe('provisionApiToken', () => {
  it('uses an inline token when one is configured', () => {
    const dir = makeTempDir();
    const provisioned = provisionApiToken({ token: TEST_TOKEN, tokenFile: join(dir, 'token') });
    assert.equal(provisioned.source, 'config');
    assert.equal(provisioned.token, TEST_TOKEN);
    assert.equal(existsSync(join(dir, 'token')), false, 'an inline token must not be written to disk');
  });

  it('rejects an inline token below the minimum length', () => {
    const dir = makeTempDir();
    assert.throws(
      () => provisionApiToken({ token: 'too-short', tokenFile: join(dir, 'token') }),
      (error) => {
        assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
        return true;
      },
    );
  });

  it('generates and persists a token, then reuses it on the next start', () => {
    const dir = makeTempDir();
    const tokenFile = join(dir, 'secrets', 'api-token');
    const first = provisionApiToken({ token: null, tokenFile });
    assert.equal(first.source, 'generated');
    assert.ok(existsSync(tokenFile));
    assert.equal(readFileSync(tokenFile, 'utf8').trim(), first.token);
    if (process.platform !== 'win32') {
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    }

    const second = provisionApiToken({ token: null, tokenFile });
    assert.equal(second.source, 'file');
    assert.equal(second.token, first.token);
  });

  it('replaces an unusable token file instead of locking the operator out forever', () => {
    const dir = makeTempDir();
    const tokenFile = join(dir, 'api-token');
    mkdirSync(dir, { recursive: true });
    // A token the bearer grammar cannot express would be rejected on every request.
    writeFileSync(tokenFile, 'short\n', 'utf8');
    const provisioned = provisionApiToken({ token: null, tokenFile });
    assert.equal(provisioned.source, 'regenerated');
    assert.equal(readFileSync(tokenFile, 'utf8').trim(), provisioned.token);
    assert.equal(isUsableToken(provisioned.token), true);
    assert.deepEqual(readdirSync(dir), ['api-token'], 'no stray token file may be left behind');
  });

  it('refuses a configured token that the bearer grammar cannot express', () => {
    const dir = makeTempDir();
    assert.throws(
      () => provisionApiToken({ token: 'not base64url! must be rejected!!!!!!', tokenFile: join(dir, 't') }),
      (error) => {
        assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
        return true;
      },
    );
  });
});

describe('safeEqual', () => {
  it('compares in constant time and refuses mismatched lengths', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual(null, 'abc'), false);
  });
});

describe('readBearer', () => {
  it('accepts the bearer form and matches the auth-scheme case-insensitively', () => {
    assert.equal(readBearer(`Bearer ${TEST_TOKEN}`), TEST_TOKEN);
    // RFC 9110 §11.1: `auth-scheme` is a token compared case-insensitively, so a client
    // that sends `bearer` must not be refused (BUG-LEDGER R4-003).
    assert.equal(readBearer(`bearer ${TEST_TOKEN}`), TEST_TOKEN);
    assert.equal(readBearer(`BEARER ${TEST_TOKEN}`), TEST_TOKEN);
    assert.equal(readBearer(`BeArEr ${TEST_TOKEN}`), TEST_TOKEN);
    assert.equal(readBearer(TEST_TOKEN), null);
    assert.equal(readBearer('Bearer '), null);
    assert.equal(readBearer(undefined), null);
    assert.equal(readBearer('Bearer short'), null);
    // Other schemes are still refused: only the bearer grammar is accepted.
    assert.equal(readBearer(`Basic ${TEST_TOKEN}`), null);
  });
});

describe('isAllowedHost', () => {
  it('accepts the loopback endpoint and nothing else', () => {
    assert.equal(isAllowedHost('127.0.0.1:8080', 8080), true);
    assert.equal(isAllowedHost('127.0.0.1', 8080), true);
    assert.equal(isAllowedHost('[::1]:8080', 8080), true);
    assert.equal(isAllowedHost('127.0.0.1:9999', 8080), false);
    assert.equal(isAllowedHost('evil.example:8080', 8080), false);
    assert.equal(isAllowedHost('localhost:8080', 8080), false);
    assert.equal(isAllowedHost('', 8080), false);
    assert.equal(isAllowedHost(undefined, 8080), false);
  });
});

describe('isAllowedOrigin', () => {
  it('accepts a missing origin and the exact loopback origin', () => {
    assert.equal(isAllowedOrigin(undefined, 8080), true);
    assert.equal(isAllowedOrigin('', 8080), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:8080', 8080), true);
    assert.equal(isAllowedOrigin('http://[::1]:8080', 8080), true);
  });

  it('refuses any other origin, including a lookalike port', () => {
    assert.equal(isAllowedOrigin('http://127.0.0.1:9999', 8080), false);
    assert.equal(isAllowedOrigin('http://evil.example', 8080), false);
    assert.equal(isAllowedOrigin('https://127.0.0.1:8080', 8080), false);
    assert.equal(isAllowedOrigin('null', 8080), false);
  });
});

describe('createAuthGuard', () => {
  it('accepts the provisioned token and rejects everything else', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 1000 });
    assert.deepEqual(guard.authenticate(`Bearer ${TEST_TOKEN}`, '127.0.0.1'), { ok: true });
    assert.equal(guard.authenticate(undefined, '127.0.0.1').code, DAEMON_CODES.AUTH_REQUIRED);
    assert.equal(guard.authenticate('Bearer wrong-token-wrong-token-wrong', '127.0.0.1').code, DAEMON_CODES.AUTH_FAILED);
  });

  it('derives a stable CSRF token that is not the bearer token', () => {
    const clock = createManualClock(BASE_MS);
    const first = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 1000 });
    const second = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 3, failureWindowMs: 1000 });
    assert.equal(first.csrfToken, second.csrfToken);
    assert.notEqual(first.csrfToken, TEST_TOKEN);
    assert.deepEqual(first.authorize(first.csrfToken), { ok: true });
    assert.equal(first.authorize(undefined).code, DAEMON_CODES.CSRF_REQUIRED);
    assert.equal(first.authorize('nope').code, DAEMON_CODES.CSRF_REQUIRED);
    assert.equal(first.authorize(TEST_TOKEN).code, DAEMON_CODES.CSRF_REQUIRED);
  });

  it('throttles a peer that keeps guessing and reopens after the window', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 2, failureWindowMs: 1000 });
    assert.equal(guard.authenticate('Bearer aaaaaaaaaaaaaaaaaaaaaa', 'peer-a').code, DAEMON_CODES.AUTH_FAILED);
    assert.equal(guard.authenticate('Bearer bbbbbbbbbbbbbbbbbbbbbb', 'peer-a').code, DAEMON_CODES.AUTH_FAILED);
    // The lockout is for guesses. The real token is not a guess, so it is served even
    // though this peer has exhausted its quota — otherwise any local process could
    // deny the operator's own client with two wrong tokens.
    assert.deepEqual(guard.authenticate(`Bearer ${TEST_TOKEN}`, 'peer-a'), { ok: true });
    // A further *guess* is throttled, so the brute-force limit still exists.
    assert.equal(guard.authenticate('Bearer cccccccccccccccccccccc', 'peer-a').code, DAEMON_CODES.AUTH_RATE_LIMITED);
    // The bucket is per peer, so another local process is unaffected.
    assert.deepEqual(guard.authenticate(`Bearer ${TEST_TOKEN}`, 'peer-b'), { ok: true });
    clock.advance(1001);
    assert.equal(guard.authenticate('Bearer cccccccccccccccccccccc', 'peer-a').code, DAEMON_CODES.AUTH_FAILED);
  });

  it('does not hand an attacker a fresh quota when a valid token is served', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 2, failureWindowMs: 1000 });
    assert.equal(guard.authenticate('Bearer aaaaaaaaaaaaaaaaaaaaaa', 'peer-a').code, DAEMON_CODES.AUTH_FAILED);
    // A legitimate request interleaved with the guessing must not reset the counter:
    // successes and failures share one peer key, so clearing on success would give the
    // attacker two fresh guesses every time the operator's client polled.
    assert.deepEqual(guard.authenticate(`Bearer ${TEST_TOKEN}`, 'peer-a'), { ok: true });
    assert.equal(guard.authenticate('Bearer bbbbbbbbbbbbbbbbbbbbbb', 'peer-a').code, DAEMON_CODES.AUTH_FAILED);
    assert.equal(guard.authenticate('Bearer cccccccccccccccccccccc', 'peer-a').code, DAEMON_CODES.AUTH_RATE_LIMITED);
    // ... and the operator keeps being served throughout.
    assert.deepEqual(guard.authenticate(`Bearer ${TEST_TOKEN}`, 'peer-a'), { ok: true });
  });

  it('requires a usable token at construction', () => {
    const clock = createManualClock(BASE_MS);
    assert.throws(() => createAuthGuard({ token: 'short', clock, failureLimit: 1, failureWindowMs: 1000 }), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
      return true;
    });
  });

  it('reports accepted and rejected counts', () => {
    const clock = createManualClock(BASE_MS);
    const guard = createAuthGuard({ token: TEST_TOKEN, clock, failureLimit: 5, failureWindowMs: 1000 });
    guard.authenticate(`Bearer ${TEST_TOKEN}`, 'peer');
    guard.authenticate('Bearer nope-nope-nope-nope-nope', 'peer');
    assert.deepEqual(guard.stats(), { accepted: 1, rejected: 1, buckets: 1 });
  });

  it('uses the documented CSRF header name', () => {
    assert.equal(CSRF_HEADER, 'x-aegis-csrf');
  });
});
