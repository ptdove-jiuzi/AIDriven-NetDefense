/**
 * api/auth.js — token provisioning, bearer authentication, CSRF and host/origin
 * admission for the loopback control API.
 *
 * Threat model this closes, in order of likelihood on a single-user workstation:
 *
 * 1. **Anything on the loopback that is not the operator.** A browser tab, a local
 *    script, another user's process. Closed by a high-entropy bearer token that is
 *    only readable through a 0600 file in the data directory.
 * 2. **A web page in the operator's browser.** Browsers cannot read the token, but
 *    they *can* send a cross-origin request, and a form POST can hit a JSON-less
 *    endpoint. Closed by Host/Origin admission plus a CSRF header that is only
 *    obtainable from an authenticated, same-origin status response.
 * 3. **DNS rebinding.** An attacker-controlled name that resolves to 127.0.0.1.
 *    Closed by requiring an exact loopback `Host` header — the rebinding request
 *    carries the attacker's hostname, not `127.0.0.1`.
 * 4. **Brute force from a local process.** Closed by a per-address failure window
 *    that throttles *wrong guesses*. A request that presents the real token is never
 *    refused because of another process's failures: on a loopback deployment every
 *    local process shares one address, so keying the lockout on "who is asking"
 *    while applying it to "everyone at that address" let any local process lock the
 *    operator out of their own daemon with five wrong tokens a minute. The bucket is
 *    still keyed by address rather than by token, so rotating the presented token to
 *    obtain a fresh quota buys nothing — it is one quota per peer either way.
 *
 * The token is never logged, never returned by any endpoint except the 0600 file,
 * and never placed in a URL.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DaemonError, DAEMON_CODES } from '../errors.js';

/** Minimum accepted token length in characters. */
export const MIN_TOKEN_LENGTH = 32;

/**
 * The exact bearer grammar.
 *
 * Configuration validates the token against the same expression `readBearer` uses. A
 * token that is accepted at startup but cannot be presented is the worst outcome: the
 * daemon runs, reports a provisioned token, and every request is rejected — which also
 * trips the lockout and locks out the real operator.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;

/**
 * Report whether a value can be used as an API token.
 *
 * @param {unknown} value Candidate.
 * @returns {boolean} `true` when configurable and presentable.
 */
export function isUsableToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** Header carrying the CSRF proof for state-changing requests. */
export const CSRF_HEADER = 'x-aegis-csrf';

/** Loopback hostnames accepted in the `Host` header. */
const LOOPBACK_HOSTNAMES = Object.freeze(['127.0.0.1', '[::1]']);

/**
 * Closed grammar for the `Host` header: a literal loopback address and an optional
 * port, nothing else.
 *
 * Parsing with `new URL` alone would accept `evil.com@127.0.0.1:8080` (userinfo),
 * `127.0.0.1:8080/evil` (path), `127.0.0.1:` (empty port) and alternate spellings
 * such as `0x7f000001`. None of them is a rebinding bypass on its own, but a header
 * we cannot fully describe is a header we should not act on.
 */
const HOST_LITERAL = /^(127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/u;

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time string comparison.
 *
 * Both sides are hashed first so the comparison length never depends on the input,
 * and an attacker cannot learn the token length from timing.
 *
 * @param {string} left Candidate.
 * @param {string} right Expected value.
 * @returns {boolean} `true` when equal.
 */
export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  return timingSafeEqual(digest(left), digest(right));
}

/**
 * Generate a token of cryptographic strength.
 *
 * @param {number} [bytes] Entropy bytes.
 * @returns {string} base64url token, 43 characters for the default 32 bytes.
 */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Provision the API token.
 *
 * Order: inline configuration (tests and supervised installs) → existing token
 * file → freshly generated token persisted with mode 0600.
 *
 * @param {{
 *   token: string|null,
 *   tokenFile: string,
 *   fsModule?: typeof fs
 * }} config Token configuration.
 * @returns {{token: string, source: 'config'|'file'|'generated', token_file: string}} Provisioned token.
 */
export function provisionApiToken(config) {
  const fsModule = config.fsModule ?? fs;
  if (typeof config.token === 'string') {
    if (!isUsableToken(config.token)) {
      throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'api.token does not match the bearer grammar (base64url, 32..512)');
    }
    return { token: config.token, source: 'config', token_file: config.tokenFile };
  }
  try {
    const existing = fsModule.readFileSync(config.tokenFile, 'utf8').trim();
    if (isUsableToken(existing)) {
      return { token: existing, source: 'file', token_file: config.tokenFile };
    }
    // An unusable token file cannot authenticate anyone, so it is replaced instead of
    // being preserved as a permanent lockout.
    const replacement = generateToken();
    writeTokenFile(fsModule, config.tokenFile, replacement);
    return { token: replacement, source: 'regenerated', token_file: config.tokenFile };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'api token file is not readable', {
        reason: error?.code ?? 'UNREADABLE',
      });
    }
  }
  const token = generateToken();
  fsModule.mkdirSync(path.dirname(config.tokenFile), { recursive: true });
  // `wx` fails if the file appeared between the read and the write: two daemons
  // starting at once must not silently agree on two different tokens.
  let handle;
  try {
    handle = fsModule.openSync(config.tokenFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = fsModule.readFileSync(config.tokenFile, 'utf8').trim();
      if (isUsableToken(raced)) {
        return { token: raced, source: 'file', token_file: config.tokenFile };
      }
    }
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'api token file could not be created', {
      reason: error?.code ?? 'WRITE_FAILED',
    });
  }
  try {
    fsModule.writeFileSync(handle, `${token}\n`);
    fsModule.fsyncSync(handle);
  } finally {
    fsModule.closeSync(handle);
  }
  return { token, source: 'generated', token_file: config.tokenFile };
}

/**
 * Parse the `Host` header and decide whether it names the loopback endpoint.
 *
 * @param {string|undefined} hostHeader Raw header.
 * @param {number} port Port the server actually bound.
 * @returns {boolean} `true` when the header names 127.0.0.1 / [::1] and, if it
 *   carries a port, that port.
 */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) {
    return false;
  }
  const match = HOST_LITERAL.exec(hostHeader);
  if (match === null) {
    return false;
  }
  const headerPort = match[2] === undefined ? null : Number(match[2]);
  if (headerPort === null) {
    return true;
  }
  return headerPort === port;
}

/**
 * Decide whether an `Origin` header is acceptable for a state-changing request.
 *
 * A missing `Origin` is accepted: non-browser clients (curl, the CLI) do not send
 * one, and they already need the bearer token. A present `Origin` must name the
 * loopback endpoint exactly, so a page on another origin is refused even if it
 * somehow obtained the token.
 *
 * @param {string|undefined} originHeader Raw header.
 * @param {number} port Bound port.
 * @returns {boolean} `true` when acceptable.
 */
export function isAllowedOrigin(originHeader, port) {
  if (originHeader === undefined || originHeader === null || originHeader === '') {
    return true;
  }
  for (const hostname of ['127.0.0.1', '[::1]']) {
    if (originHeader === `http://${hostname}:${port}` || (port === 80 && originHeader === `http://${hostname}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract a bearer token from an `Authorization` header.
 *
 * The scheme is case-insensitive (RFC 9110 §11.1: auth-scheme is a token matched
 * case-insensitively), so `bearer <token>` is as valid as `Bearer <token>`. The token
 * itself is still matched exactly: `[A-Za-z0-9_-]` is already both cases, so the `i`
 * flag changes nothing about the credential.
 *
 * @param {string|undefined} header Raw header value.
 * @returns {string|null} Token, or `null` when the header is absent or malformed.
 */
export function readBearer(header) {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{16,512})$/iu.exec(header.trim());
  return match === null ? null : match[1];
}

/**
 * Replace a token file atomically with mode 0600.
 *
 * `writeFileSync(path, text, { mode })` only applies the mode when it *creates* the
 * file: replacing a pre-existing 0644 file would keep the loose permissions, which
 * defeats the whole "readable only through a private file" model. The temp-file +
 * rename form also means two daemons starting at once cannot interleave their writes
 * and leave one of them holding a token that is not in the file.
 *
 * Exported so `api/rotator.js` reuses this exact atomic form instead of growing a
 * second, subtly different writer: the rotation must persist the new token before the
 * live guard switches to it, and both paths must agree on what "persisted" means.
 *
 * @param {typeof fs} fsModule Filesystem module.
 * @param {string} tokenFile Destination path.
 * @param {string} token Token to persist.
 * @returns {void}
 */
export function writeTokenFile(fsModule, tokenFile, token) {
  const directory = path.dirname(tokenFile);
  const temporary = path.join(directory, `.${path.basename(tokenFile)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle = null;
  try {
    handle = fsModule.openSync(temporary, 'wx', 0o600);
    fsModule.writeFileSync(handle, `${token}\n`);
    fsModule.fsyncSync(handle);
    fsModule.closeSync(handle);
    handle = null;
    fsModule.renameSync(temporary, tokenFile);
    try {
      fsModule.chmodSync(tokenFile, 0o600);
    } catch {
      // Windows has no POSIX mode bits; the ACL inherited from the data directory applies.
    }
  } catch (error) {
    if (handle !== null) {
      try {
        fsModule.closeSync(handle);
      } catch {
        // Nothing left to close.
      }
    }
    try {
      fsModule.rmSync(temporary, { force: true });
    } catch {
      // A leftover temp file is harmless; the next attempt uses a unique name.
    }
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'api token file could not be replaced', {
      reason: error?.code ?? 'WRITE_FAILED',
    });
  }
}

/**
 * Create the authentication guard.
 *
 * @param {{
 *   token: string,
 *   clock: {nowMs: () => number},
 *   failureLimit: number,
 *   failureWindowMs: number,
 *   csrfToken?: string
 * }} options Guard options.
 * @returns {object} Guard with `authenticate`, `authorize`, `rotateTo`, `csrfToken`,
 *   `cursorKey` and `stats`. `csrfToken` and `cursorKey` are getters over the *current*
 *   token so a rotation is observable on the next read.
 */
export function createAuthGuard(options) {
  // `let`, not `const`: `rotateTo()` replaces the credential in place. Everything
  // derived from it is computed on read, so there is exactly one source of truth.
  let token = options.token;
  if (!isUsableToken(token)) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'auth guard requires a provisioned token');
  }
  const clock = options.clock;
  const failureLimit = options.failureLimit;
  const failureWindowMs = options.failureWindowMs;
  // The CSRF value is derived from the token, not independent: it therefore cannot
  // be guessed without the token, and it stays stable across a restart so an
  // operator's saved client keeps working. It is derived on *read* (getter, below)
  // rather than frozen at construction, so the first `/status` after a rotation hands
  // out the new proof. An explicit `csrfToken` option (tests) still wins.
  const csrfOverride = options.csrfToken ?? null;
  const currentCsrfToken = () => csrfOverride ?? createHash('sha256')
    .update(`aegis-csrf:${token}`, 'utf8')
    .digest('base64url');
  // Pagination cursors are MAC'd with a key derived one way from the token. It is
  // not the token: a cursor plus its key reveal nothing that leads back to the
  // bearer credential, and a leaked cursor is worthless as a credential. The
  // consequence is intentional — rotating the token invalidates every outstanding
  // cursor at once, and clients answer that with `CURSOR_INVALID` by restarting
  // from the first page. This value is never logged, never returned and never
  // written to disk. Derived on read, for the same reason as the CSRF proof; a
  // consumer that captures it once (the daemon does, at assembly time) keeps the
  // old key until it re-reads the guard.
  const deriveCursorKey = (value) => createHmac('sha256', 'aegis-api-cursor-v1').update(value, 'utf8').digest();
  /** @type {Map<string, {count: number, first: number}>} */
  const failures = new Map();
  let rejected = 0;
  let accepted = 0;

  function prune(now) {
    for (const [key, entry] of failures.entries()) {
      if (now - entry.first > failureWindowMs) {
        failures.delete(key);
      }
    }
  }

  function recordFailure(key, now) {
    const entry = failures.get(key);
    if (entry === undefined) {
      failures.set(key, { count: 1, first: now });
      return;
    }
    entry.count += 1;
  }

  function rateLimited(key, now) {
    const entry = failures.get(key);
    if (entry === undefined) {
      return false;
    }
    if (now - entry.first > failureWindowMs) {
      failures.delete(key);
      return false;
    }
    return entry.count >= failureLimit;
  }

  return {
    /** CSRF proof derived from the token that is current *now*. */
    get csrfToken() {
      return currentCsrfToken();
    },
    /** Cursor MAC key derived from the token that is current *now*. */
    get cursorKey() {
      return deriveCursorKey(token);
    },
    /**
     * Verify the bearer token.
     *
     * @param {string|undefined} header `Authorization` header.
     * @param {string} peerKey Failure-bucket key (peer address). It throttles wrong
     *   guesses only; it is never consulted for a request that presents the real
     *   token, and it is deliberately not derived from the presented token so that
     *   rotating tokens cannot mint new quota.
     * @returns {{ok: boolean, code?: string}} Decision.
     */
    authenticate(header, peerKey) {
      const now = clock.nowMs();
      prune(now);
      const presented = readBearer(header);
      if (presented === null) {
        // A request without a bearer is NOT counted toward the lockout. Any web page
        // the operator visits can send a cross-origin simple GET to 127.0.0.1 (the
        // Host is legitimate, no preflight is required, the response is unreadable but
        // the request arrives). If those counted, a single page could lock the operator
        // out of their own daemon. A 256-bit token cannot be brute forced, so only an
        // actual wrong-token guess is worth throttling.
        rejected += 1;
        return { ok: false, code: DAEMON_CODES.AUTH_REQUIRED };
      }
      // The credential is verified *before* the bucket is consulted. A correct token
      // is proof that this is the operator's own client, and no third process's
      // guesses may deny it service. The previous order let five wrong tokens from
      // any local process turn every `/api/v1/*` request on the machine into a 429
      // for a whole window — including the operator's, who had done nothing wrong —
      // while `/healthz` stayed 200, so the daemon looked healthy and unusable at the
      // same time.
      if (safeEqual(presented, token)) {
        accepted += 1;
        return { ok: true };
      }
      // A wrong guess. The counter is deliberately *not* cleared by a later success:
      // successes and failures from the same machine share one address, so clearing
      // on success would let any ordinary legitimate request hand the attacker a
      // fresh quota of guesses inside the same window. Keeping the count is safe for
      // the operator precisely because a valid token never consults it.
      if (rateLimited(peerKey, now)) {
        rejected += 1;
        return { ok: false, code: DAEMON_CODES.AUTH_RATE_LIMITED };
      }
      rejected += 1;
      recordFailure(peerKey, now);
      return { ok: false, code: DAEMON_CODES.AUTH_FAILED };
    },
    /**
     * Verify the CSRF proof for a state-changing request.
     *
     * @param {string|undefined} header Raw CSRF header.
     * @returns {{ok: boolean, code?: string}} Decision.
     */
    authorize(header) {
      if (typeof header !== 'string' || !safeEqual(header, currentCsrfToken())) {
        return { ok: false, code: DAEMON_CODES.CSRF_REQUIRED };
      }
      return { ok: true };
    },
    /**
     * Switch the bearer credential to a new token, in place and synchronously.
     *
     * `api/rotator.js` calls this only after the new token is durably on disk: the
     * order is fail-closed, because switching first would hand out a credential no
     * client can read. The token is re-validated against the same bearer grammar the
     * configuration path uses — a rotation must never install a token the daemon
     * would refuse to present.
     *
     * The failure buckets are cleared: their counts describe guesses against the
     * *old* credential, and keeping them would leave a peer throttled after a
     * rotation it never attacked. Clearing cannot be used to buy quota by rotating,
     * because possessing the token is already required to rotate.
     *
     * @param {unknown} nextToken Replacement token.
     * @returns {void}
     * @throws {DaemonError} `CONFIG_INVALID` when the value is not a usable token;
     *   the current credential is left untouched in that case.
     */
    rotateTo(nextToken) {
      if (!isUsableToken(nextToken)) {
        throw new DaemonError(
          DAEMON_CODES.CONFIG_INVALID,
          'rotated token does not match the bearer grammar (base64url, 32..512)',
        );
      }
      token = nextToken;
      failures.clear();
    },
    stats() {
      return { accepted, rejected, buckets: failures.size };
    },
  };
}
