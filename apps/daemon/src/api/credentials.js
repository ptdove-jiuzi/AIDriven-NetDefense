/**
 * api/credentials.js — `PUT` / `DELETE /api/v1/credentials/:providerId` (§2.3).
 *
 * The red line this file implements (contract §4): **the daemon never sees a stored
 * secret**. A `PUT` carries one in, hands it to the broker child and returns `204`
 * with no body — no mask, no fingerprint, no echo of any fragment. There is
 * deliberately no `GET`: the only readable form of a credential is
 * `GET /api/v1/models#providers[].credential`, which is mask + fingerprint + length
 * bucket and is produced inside the child.
 *
 * Validation order is fixed by the contract and is what makes the errors
 * unambiguous: shape of `providerId` → provider exists → secret shape → persist.
 * A bad-shaped secret therefore cannot be used to probe whether a provider exists,
 * and a provider that does not exist is never written to.
 *
 * The secret shape rules: `8..512` bytes, single line, non-empty after trimming.
 * Each failure carries one of the four contracted reason words and — this is the
 * point — *nothing from the input*: not a length, not a prefix, not a hash.
 */

import { CONSOLE_CODES, ConsoleError } from './console-errors.js';
import { PROVIDER_ID_PATTERN } from './settings-schema.js';

/** Minimum accepted secret length in bytes (contract §2.3). */
export const MIN_SECRET_BYTES = 8;

/** Maximum accepted secret length in bytes. */
export const MAX_SECRET_BYTES = 512;

/**
 * Bucket a secret length for logging (contract §4 rule 2: never the exact length).
 *
 * @param {number} bytes Length in bytes.
 * @returns {'<16'|'16-32'|'33-64'|'>64'} Bucket name.
 */
export function lengthBucketFor(bytes) {
  if (bytes < 16) {
    return '<16';
  }
  if (bytes <= 32) {
    return '16-32';
  }
  if (bytes <= 64) {
    return '33-64';
  }
  return '>64';
}

/**
 * Validate the provider id from the path.
 *
 * @param {unknown} providerId Path segment.
 * @returns {string} Valid provider id.
 * @throws {ConsoleError} `PROVIDER_INVALID` when the shape is wrong.
 */
export function assertProviderIdShape(providerId) {
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_INVALID, 'providerId must match [a-z0-9-]{2,32}', {
      field: 'providerId',
    });
  }
  return providerId;
}

/**
 * Validate the secret shape.
 *
 * The returned value is what gets persisted: the trimmed single-line string. A
 * caller cannot smuggle whitespace-only content past the length rule because the
 * trim happens first.
 *
 * @param {unknown} value Candidate secret.
 * @returns {string} Trimmed secret.
 * @throws {ConsoleError} `CREDENTIAL_INVALID` with a contracted `reason`.
 */
export function assertSecretShape(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_INVALID, 'credential is empty', { reason: 'EMPTY' });
  }
  if (/[\r\n\u2028\u2029]/u.test(value)) {
    // Reported before the length rules: a pasted multi-line file is the common
    // mistake, and "too long" would be a misleading answer for it.
    throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_INVALID, 'credential must be a single line', {
      reason: 'MULTILINE',
    });
  }
  const trimmed = value.trim();
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (bytes < MIN_SECRET_BYTES) {
    throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_INVALID, 'credential is too short', {
      reason: 'TOO_SHORT',
      min_bytes: MIN_SECRET_BYTES,
    });
  }
  if (bytes > MAX_SECRET_BYTES) {
    throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_INVALID, 'credential is too long', {
      reason: 'TOO_LONG',
      max_bytes: MAX_SECRET_BYTES,
    });
  }
  return trimmed;
}

/**
 * Create the credential handlers.
 *
 * @param {{
 *   settingsStore: object,
 *   broker: object,
 *   logger?: object
 * }} options Options.
 * @returns {{putCredential: Function, deleteCredential: Function}} Handlers, both
 *   returning `null` so the server answers `204` with no body.
 */
export function createCredentialHandlers(options) {
  const settingsStore = options.settingsStore;
  const broker = options.broker;
  const logger = options.logger ?? null;

  /**
   * @param {string} providerId Valid provider id.
   * @returns {object} Provider entry.
   * @throws {ConsoleError} `PROVIDER_UNKNOWN` when it is not registered.
   */
  function requireProvider(providerId) {
    const settings = settingsStore.current();
    const provider = settings.models.providers.find((entry) => entry.id === providerId);
    if (provider === undefined) {
      throw new ConsoleError(CONSOLE_CODES.PROVIDER_UNKNOWN, 'provider is not registered', { providerId });
    }
    return provider;
  }

  /**
   * `PUT /api/v1/credentials/:providerId`.
   *
   * @param {{params: {providerId: string}, body: unknown}} ctx Request context.
   * @returns {Promise<null>} `null` ⇒ `204` with no body.
   */
  async function putCredential(ctx) {
    const providerId = assertProviderIdShape(ctx.params.providerId);
    if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) {
      throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_INVALID, 'credential body must be a json object', {
        reason: 'EMPTY',
      });
    }
    for (const key of Object.keys(ctx.body)) {
      if (key !== 'apiKey') {
        // The contract's reason enum describes *secret shape* failures; an unknown
        // body field is a body-shape failure and is named as such (deviation D4).
        throw new ConsoleError(CONSOLE_CODES.CREDENTIAL_INVALID, 'credential body has an unknown field', {
          reason: 'FIELD',
        });
      }
    }
    requireProvider(providerId);
    const secret = assertSecretShape(ctx.body.apiKey);
    // The only place the plaintext exists in this process is this local binding; it is
    // handed straight to the child and never logged, never returned, never cached.
    // The parameter object is built here so the wire field name (contract §2.3, §1.1)
    // exists in exactly one daemon file (contract §1.2).
    await broker.putCredential({ providerId, apiKey: secret });
    logger?.info?.('credential stored', {
      providerId,
      lengthBucket: lengthBucketFor(Buffer.byteLength(secret, 'utf8')),
    });
    return null;
  }

  /**
   * `DELETE /api/v1/credentials/:providerId`. Idempotent: deleting a credential
   * that is already gone still answers `204`.
   *
   * @param {{params: {providerId: string}}} ctx Request context.
   * @returns {Promise<null>} `null` ⇒ `204` with no body.
   */
  async function deleteCredential(ctx) {
    const providerId = assertProviderIdShape(ctx.params.providerId);
    requireProvider(providerId);
    await broker.deleteCredential(providerId);
    logger?.info?.('credential removed', { providerId });
    return null;
  }

  return { putCredential, deleteCredential };
}
