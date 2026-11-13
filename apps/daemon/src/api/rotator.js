/**
 * api/rotator.js — the `diagnostics.rotateToken` action.
 *
 * Owner: OPS-DIAG-COMMANDER (OPS-DIAG 战役); body implemented by the token-rotation
 * seat. The exported signature is the one `daemon.js` is wired against and must stay
 * stable:
 *
 *   createTokenRotation({ auth, tokenFile, dataDir, clock, logger })
 *     -> { rotate, lastRotatedAt }
 *
 *   rotate() -> { token, rotated_at, fingerprint, previous_fingerprint, audit }
 *   lastRotatedAt() -> string|null   (ISO timestamp of the last successful rotation)
 *
 * Ordering is fail-closed:
 *
 *   1. generate the replacement token (entropy failure = nothing changed);
 *   2. persist it atomically, 0600, temp + rename (`auth.writeTokenFile`);
 *   3. only then switch the live guard (`auth.rotateTo`);
 *   4. append one audit line.
 *
 * If step 2 fails the in-memory token is untouched and the old credential keeps
 * working — a rotation that half-succeeds is the one outcome that would lock the
 * operator out of their own daemon, since the response (the only place the new token
 * is ever shown) is exactly what they did not get.
 *
 * What is deliberately **not** written anywhere: the token itself, the CSRF proof and
 * the `Authorization` header. The audit line carries a 16-hex-character SHA-256
 * fingerprint instead, which is enough to correlate two rotations and useless as a
 * credential.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DaemonError, DAEMON_CODES } from '../errors.js';
import { generateToken, isUsableToken, writeTokenFile } from './auth.js';

/** Audit event name (stable: `docs/install/troubleshooting.md` greps for it). */
const AUDIT_EVENT = 'api.token.rotate';

/** Audit directory: private to the operator account. */
const AUDIT_DIR_MODE = 0o700;

/** Audit file: private to the operator account. POSIX only; Windows inherits the ACL. */
const AUDIT_FILE_MODE = 0o600;

/** Fingerprint length in hex characters (64-bit truncation of SHA-256). */
const FINGERPRINT_HEX_LENGTH = 16;

/**
 * Non-secret fingerprint of a token: first 16 hex characters of its SHA-256.
 *
 * @param {string} token Token.
 * @returns {string} Fingerprint.
 */
function fingerprintOf(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_LENGTH);
}

/**
 * Require a non-empty string option.
 *
 * @param {unknown} value Candidate.
 * @param {string} name Option name (for the error message).
 * @returns {string} The string.
 * @throws {DaemonError} `CONFIG_INVALID` when absent.
 */
function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `token rotation requires ${name}`);
  }
  return value;
}

/**
 * Create the token rotation handle.
 *
 * @param {{
 *   auth: {rotateTo: (nextToken: string) => void},
 *   tokenFile: string,
 *   dataDir: string,
 *   clock: {nowIso: () => string},
 *   logger?: {warn?: Function, info?: Function}
 * }} options Rotation options.
 * @returns {{rotate: Function, lastRotatedAt: Function}} Rotation handle.
 * @throws {DaemonError} `CONFIG_INVALID` when the options cannot support a rotation.
 */
export function createTokenRotation(options) {
  const auth = options?.auth;
  if (auth === null || typeof auth !== 'object' || typeof auth.rotateTo !== 'function') {
    throw new DaemonError(
      DAEMON_CODES.CONFIG_INVALID,
      'token rotation requires an auth guard exposing rotateTo()',
    );
  }
  const tokenFile = requireString(options?.tokenFile, 'tokenFile');
  const dataDir = requireString(options?.dataDir, 'dataDir');
  const clock = options?.clock;
  if (clock === null || typeof clock !== 'object' || typeof clock.nowIso !== 'function') {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'token rotation requires a clock exposing nowIso()');
  }
  const logger = options?.logger ?? null;

  const auditDir = path.join(dataDir, 'console');
  const auditPath = path.join(auditDir, 'audit.log');
  const tokenDir = path.dirname(tokenFile);
  let auditModeChecked = false;
  /** @type {string|null} */
  let lastRotated = null;

  /**
   * Append one JSONL record to the audit log.
   *
   * `mkdir` is 0700 and the file is opened 0600 *on creation*; a pre-existing file
   * keeps its own mode, so one `chmod` is attempted after the first append (ignored
   * on Windows, which has no POSIX bits).
   *
   * @param {object} record Record to append (must already be secret-free).
   * @returns {string} Audit path.
   */
  function appendAudit(record) {
    fs.mkdirSync(auditDir, { recursive: true, mode: AUDIT_DIR_MODE });
    const handle = fs.openSync(auditPath, 'a', AUDIT_FILE_MODE);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    if (!auditModeChecked) {
      auditModeChecked = true;
      try {
        fs.chmodSync(auditPath, AUDIT_FILE_MODE);
      } catch {
        // Windows has no POSIX mode bits; the ACL inherited from the data directory applies.
      }
    }
    return auditPath;
  }

  /**
   * Append an audit record without ever letting the audit trail break the rotation.
   *
   * The caller has already changed the credential by the time the success line is
   * written: throwing here would report "rotation failed" while the old token is
   * dead, which is the opposite of fail-closed. A failure line uses the same path, so
   * an unwritable audit directory cannot mask the original error either.
   *
   * @param {object} record Record.
   * @returns {string|null} Audit path, or `null` when the append failed.
   */
  function safeAudit(record) {
    try {
      return appendAudit(record);
    } catch (error) {
      logger?.warn?.('token rotation audit line could not be appended', {
        reason: error?.code ?? 'AUDIT_WRITE_FAILED',
      });
      return null;
    }
  }

  /**
   * Read the token currently on disk, for the `previous_fingerprint` field.
   *
   * The file is the durable credential a restart would pick up, so it is the right
   * "before" value. A daemon provisioned from inline configuration (`api.token`) has
   * no token file yet; the field is then `null` rather than a guess.
   *
   * @returns {string|null} Token text, or `null` when unreadable.
   */
  function readPreviousToken() {
    try {
      const text = fs.readFileSync(tokenFile, 'utf8').trim();
      return text.length === 0 ? null : text;
    } catch {
      return null;
    }
  }

  return {
    /**
     * Rotate the API token.
     *
     * @returns {{
     *   token: string,
     *   rotated_at: string,
     *   fingerprint: string,
     *   previous_fingerprint: string|null,
     *   audit: {path: string, appended: boolean}
     * }} Receipt. `token` is the only time the new credential is ever emitted.
     * @throws {DaemonError} When the token cannot be persisted; the live token is
     *   unchanged in that case.
     */
    rotate() {
      const nextToken = generateToken();
      if (!isUsableToken(nextToken)) {
        // Cannot happen with a 32-byte base64url token; refusing keeps the invariant
        // "the live guard never holds a credential the bearer grammar rejects".
        throw new DaemonError(DAEMON_CODES.INTERNAL, 'generated token is not a usable bearer credential');
      }
      const previousToken = readPreviousToken();
      const fingerprint = fingerprintOf(nextToken);
      const previousFingerprint = previousToken === null ? null : fingerprintOf(previousToken);
      const rotatedAt = clock.nowIso();
      const auditBase = {
        at: rotatedAt,
        event: AUDIT_EVENT,
        result: 'ok',
        fingerprint,
        previous_fingerprint: previousFingerprint,
        reason: null,
      };

      // 1. Persist first. A failure here leaves the guard (and the old file) alone.
      try {
        // `auth.writeTokenFile` creates the temp file *in the target directory* and
        // renames it into place; it does not create that directory. A daemon whose
        // token came from inline configuration (`api.token`) never runs
        // `provisionApiToken`'s mkdir branch, so `<dataDir>/secrets/` may not exist and
        // the rename fails with ENOENT — a rotation that cannot work on a real
        // deployment shape. Creating the directory here (0700) rather than inside
        // `writeTokenFile` keeps `provisionApiToken`'s existing semantics untouched.
        fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
        writeTokenFile(fs, tokenFile, nextToken);
      } catch (error) {
        safeAudit({
          ...auditBase,
          result: 'failed',
          reason: error?.code ?? 'WRITE_FAILED',
        });
        throw error;
      }

      // 2. Then switch the live guard. `rotateTo` re-validates the token and throws
      //    without mutating anything if it is not usable.
      try {
        auth.rotateTo(nextToken);
      } catch (error) {
        safeAudit({
          ...auditBase,
          result: 'failed',
          reason: error?.code ?? 'ROTATE_FAILED',
        });
        throw error;
      }

      // 3. Audit last. Failure to append is reported, not thrown: the credential has
      //    already changed, so "failed" would be a lie the operator could act on.
      const appendedPath = safeAudit(auditBase);
      lastRotated = rotatedAt;
      return {
        token: nextToken,
        rotated_at: rotatedAt,
        fingerprint,
        previous_fingerprint: previousFingerprint,
        audit: { path: auditPath, appended: appendedPath !== null },
      };
    },

    /**
     * @returns {string|null} ISO timestamp of the last successful rotation, or `null`.
     */
    lastRotatedAt() {
      return lastRotated;
    },
  };
}
