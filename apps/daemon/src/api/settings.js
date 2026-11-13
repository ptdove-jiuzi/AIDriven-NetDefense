/**
 * api/settings.js — the settings document store and the three settings handlers.
 *
 * Where the document lives: `<dataDir>/console/settings.json` (derived by
 * `daemon.js` from `config.dataDir`; this module never guesses a path).
 *
 * Three rules this module exists to keep:
 *
 * 1. **A corrupt file is reported, never repaired in place.** `GET` answers the
 *    defaults plus `SETTINGS_CORRUPT:<sha256 前 8 位>` and leaves the bytes alone,
 *    so an operator can still recover whatever was in there. Only an explicit `PUT`
 *    replaces it.
 * 2. **A write is atomic and private.** Temp file + `rename`, mode 0600 (POSIX;
 *    on Windows the data directory's ACL applies, as with the token file).
 * 3. **Removing a provider is a two-step decision.** A provider that still holds a
 *    credential cannot disappear because a document omitted it: the request must
 *    declare `discardCredential: true`, the credential is deleted *first*, and only
 *    then is the document written. Deleting first means a failed credential delete
 *    leaves the provider listed (the safe direction); the other order would leave an
 *    orphan secret on disk for a provider the console no longer shows.
 *
 * `appliedNow` / `restartRequired` are derived from the schema descriptors rather
 * than hand-written per field, so "what changed" and "what the schema promises
 * about `appliesAt`" cannot disagree.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { DaemonError, DAEMON_CODES } from '../errors.js';
import { CONSOLE_CODES, ConsoleError } from './console-errors.js';
import {
  SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  changedPaths,
  classifyChanges,
  cloneJson,
  describeSettingsSchema,
  overlayReadOnly,
  readPath,
  stripReadOnly,
  validateSettingsDocument,
} from './settings-schema.js';

/** Longest settings file accepted; a bigger one is corruption, not configuration. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/** Prefix of the corrupt-file warning (contract §2.8). */
export const SETTINGS_CORRUPT_PREFIX = 'SETTINGS_CORRUPT:';

/**
 * Deep-merge a stored document over {@link DEFAULT_SETTINGS}.
 *
 * Contract §2.8 promises `GET /api/v1/settings` returns a *normalized* document: every
 * group and every leaf the schema describes. A file written by an earlier build (or by
 * a partial writer) can legitimately contain only some groups, and the API must not
 * hand that half-document to the console — a client that has to fill in defaults itself
 * is a client that can disagree with the server about them.
 *
 * Semantics: objects merge recursively; arrays and scalars from the stored document
 * replace the default (an array is a whole value — a provider list must be replaceable,
 * not mergeable). Read-only fields are stripped before this runs, so they cannot be
 * resurrected from the file.
 *
 * This is deliberately explicit even though `validateSettingsDocument` also merges: the
 * guarantee then does not depend on the validator's internals, and a future change to
 * validation cannot silently make `GET` partial again.
 *
 * @param {object} document Stored settings document (may be partial).
 * @returns {object} Complete document with every schema group present.
 */
export function mergeWithDefaults(document) {
  const source = document !== null && typeof document === 'object' && !Array.isArray(document) ? document : {};
  return deepMergeOverDefaults(cloneJson(DEFAULT_SETTINGS), source);
}

/**
 * @param {object} base Defaults (a mutable copy).
 * @param {object} patch Stored document.
 * @returns {object} Merged object.
 */
function deepMergeOverDefaults(base, patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    const baseValue = base[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)) {
      base[key] = deepMergeOverDefaults({ ...baseValue }, value);
      continue;
    }
    base[key] = cloneJson(value);
  }
  return base;
}

/**
 * Flatten a nested `{group: {field: value}}` read-only map into dotted paths.
 *
 * `overlayReadOnly` in `settings-schema.js` takes **dotted paths** (`"update.currentVersion"`).
 * Handing it a nested map makes it treat the group name as a path and *replace the whole
 * group* with that one field — which is exactly the "GET returns a partial document"
 * defect observed on the real stack (`response.*` and `update.*` collapsed to one leaf
 * each). The nesting is the interface the daemon uses (`readOnly: () => ({...})`), so it
 * is flattened here rather than changing the schema module's contract.
 *
 * @param {object} values Nested read-only values.
 * @param {string} [prefix] Current path prefix.
 * @param {object} [output] Accumulator.
 * @returns {Record<string, unknown>} Dotted path → value.
 */
export function flattenReadOnlyValues(values, prefix = '', output = {}) {
  for (const [key, value] of Object.entries(values ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenReadOnlyValues(value, path, output);
      continue;
    }
    output[path] = value;
  }
  return output;
}

/**
 * Overlay the live server-owned values onto a complete document.
 *
 * @param {object} document Settings document.
 * @param {object} values Nested read-only values.
 * @returns {object} Document with only the read-only leaves replaced.
 */
export function applyReadOnlyValues(document, values) {
  return overlayReadOnly(document, flattenReadOnlyValues(values));
}

/**
 * Refuse a request that tries to change a server-owned field.
 *
 * The comparison is against the *effective* value (e.g. the version currently running),
 * so echoing the value back unchanged stays legal while a real change is named by path.
 *
 * @param {object} supplied Caller document.
 * @param {object} effective Nested read-only values.
 * @returns {void}
 * @throws {ConsoleError} `SETTINGS_INVALID` with `rule: "read_only"`.
 */
function assertReadOnlyUnchanged(supplied, effective) {
  const flat = flattenReadOnlyValues(effective);
  for (const [path, expected] of Object.entries(flat)) {
    const found = readPath(supplied, path);
    if (!found.found) {
      continue;
    }
    if (JSON.stringify(found.value) !== JSON.stringify(expected)) {
      throw new ConsoleError(CONSOLE_CODES.SETTINGS_INVALID, 'settings document is not valid', {
        path,
        rule: 'read_only',
      });
    }
  }
}

/**
 * Compute the short digest used in a corrupt-file warning.
 *
 * @param {string} text Raw file text.
 * @returns {string} First eight hex characters of sha256.
 */
function shortDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Create the settings store.
 *
 * Construction is side-effect free: nothing is read or created until `load()` /
 * `current()` is called, and nothing is created until `save()` runs.
 *
 * @param {{
 *   filePath: string,
 *   clock: {nowIso?: () => string, nowMs?: () => number},
 *   logger?: object,
 *   fsModule?: object
 * }} options Options.
 * @returns {object} Store with `current`, `load`, `save`, `filePath`, `warnings`.
 */
export function createSettingsStore(options) {
  const filePath = options.filePath;
  const clock = options.clock;
  const logger = options.logger ?? null;
  const fsModule = options.fsModule ?? null;

  const fs = fsModule ?? {
    readFileSync,
    mkdirSync,
    openSync,
    writeFileSync,
    fsyncSync,
    closeSync,
    renameSync,
    chmodSync,
    rmSync,
  };

  let loaded = false;
  /** @type {object|null} */
  let settings = null;
  let updatedAt = null;
  /** @type {string[]} */
  let warnings = [];
  let corrupt = false;
  let corruptDigest = null;

  function nowIso() {
    if (typeof clock?.nowIso === 'function') {
      return clock.nowIso();
    }
    if (typeof clock?.nowMs === 'function') {
      return new Date(clock.nowMs()).toISOString();
    }
    return new Date().toISOString();
  }

  /**
   * Load the file once and cache the validated document.
   *
   * @returns {{settings: object, updatedAt: string|null, warnings: string[], corrupt: boolean}} Snapshot.
   */
  function load() {
    if (loaded) {
      return { settings, updatedAt, warnings: [...warnings], corrupt };
    }
    loaded = true;
    let text = null;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        settings = cloneJson(DEFAULT_SETTINGS);
        updatedAt = null;
        warnings = [];
        corrupt = false;
        return { settings, updatedAt, warnings: [], corrupt: false };
      }
      // Unreadable is not "empty": report it the same way as corrupt so the console
      // says why it is showing defaults, and leave the file untouched.
      corrupt = true;
      corruptDigest = shortDigest(`${error?.code ?? 'UNREADABLE'}:${filePath}`);
      warnings = [`${SETTINGS_CORRUPT_PREFIX}${corruptDigest}`];
      settings = cloneJson(DEFAULT_SETTINGS);
      updatedAt = null;
      logger?.warn?.('settings file is not readable; serving defaults', { reason: error?.code ?? 'UNREADABLE' });
      return { settings, updatedAt, warnings: [...warnings], corrupt };
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) {
      corrupt = true;
      corruptDigest = shortDigest(typeof text === 'string' ? text : '');
      warnings = [`${SETTINGS_CORRUPT_PREFIX}${corruptDigest}`];
      settings = cloneJson(DEFAULT_SETTINGS);
      updatedAt = null;
      logger?.warn?.('settings file is too large; serving defaults', {});
      return { settings, updatedAt, warnings: [...warnings], corrupt };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      corrupt = true;
      corruptDigest = shortDigest(text);
      warnings = [`${SETTINGS_CORRUPT_PREFIX}${corruptDigest}`];
      settings = cloneJson(DEFAULT_SETTINGS);
      updatedAt = null;
      logger?.warn?.('settings file is not valid json; serving defaults', { digest: corruptDigest });
      return { settings, updatedAt, warnings: [...warnings], corrupt };
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      corrupt = true;
      corruptDigest = shortDigest(text);
      warnings = [`${SETTINGS_CORRUPT_PREFIX}${corruptDigest}`];
      settings = cloneJson(DEFAULT_SETTINGS);
      updatedAt = null;
      logger?.warn?.('settings file has an unexpected schema version; serving defaults', {
        reason: 'SCHEMA_VERSION',
      });
      return { settings, updatedAt, warnings: [...warnings], corrupt };
    }
    let validated;
    try {
      // The stored document has the server-owned fields stripped (see `save()`), so
      // validation runs without a read-only overlay: `overlayReadOnly` at read time
      // supplies the live values.
      validated = validateSettingsDocument(parsed.settings ?? {});
    } catch (error) {
      corrupt = true;
      corruptDigest = shortDigest(text);
      warnings = [`${SETTINGS_CORRUPT_PREFIX}${corruptDigest}`];
      settings = cloneJson(DEFAULT_SETTINGS);
      updatedAt = null;
      logger?.warn?.('settings file failed schema validation; serving defaults', {
        path: error?.details?.path ?? null,
        rule: error?.details?.rule ?? null,
      });
      return { settings, updatedAt, warnings: [...warnings], corrupt };
    }
    // Explicit normalization (contract §2.8): a document written by an earlier build may
    // carry only some groups, and the API promises a complete one. `validateSettingsDocument`
    // merges today, but the guarantee must not depend on that.
    settings = mergeWithDefaults(validated);
    updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
    warnings = [];
    corrupt = false;
    return { settings, updatedAt, warnings: [], corrupt: false };
  }

  /**
   * Current validated document (read-only; callers overlay the live read-only fields).
   *
   * @returns {object} Frozen settings document.
   */
  function current() {
    return load().settings;
  }

  /**
   * Atomically persist a validated document.
   *
   * @param {object} document Validated settings document (read-only fields are stripped here).
   * @returns {{updatedAt: string, filePath: string}} Write receipt.
   * @throws {DaemonError} `INTERNAL` when the file cannot be written; the caller's
   *   document is then unchanged on disk.
   */
  function save(document) {
    const at = nowIso();
    const payload = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      updatedAt: at,
      settings: stripReadOnly(document),
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const directory = dirname(filePath);
    const temporary = join(directory, `.settings.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    let handle = null;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      handle = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(handle, text);
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;
      fs.renameSync(temporary, filePath);
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Windows has no POSIX mode bits; the data directory ACL applies.
      }
    } catch (error) {
      if (handle !== null) {
        try {
          fs.closeSync(handle);
        } catch {
          // Nothing left to close.
        }
      }
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // A leftover temp file is harmless; the next write uses a unique name.
      }
      logger?.error?.('settings write failed', { reason: error?.code ?? 'WRITE_FAILED' });
      throw new DaemonError(DAEMON_CODES.INTERNAL, 'settings could not be persisted', {
        reason: error?.code ?? 'WRITE_FAILED',
      });
    }
    settings = document;
    updatedAt = at;
    warnings = [];
    corrupt = false;
    corruptDigest = null;
    loaded = true;
    return { updatedAt: at, filePath };
  }

  return {
    filePath,
    load,
    current,
    save,
    /** Diagnostics only: never the document body. */
    stats() {
      return {
        path: filePath,
        loaded,
        corrupt,
        corrupt_digest: corruptDigest,
        warning_count: warnings.length,
        updated_at: updatedAt,
      };
    },
  };
}

/**
 * Parse a JSON request body into a plain object.
 *
 * @param {unknown} value Parsed body.
 * @param {string} code Error code to use for a malformed shape.
 * @param {string} label Endpoint label used in the message.
 * @returns {object} Plain object body.
 */
function requireObjectBody(value, code, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConsoleError(code, `${label} requires a json object body`);
  }
  return value;
}

/**
 * Create the settings handlers.
 *
 * @param {{
 *   store: object,
 *   broker: object,
 *   readOnly: () => object,
 *   logger?: object,
 *   clock?: object
 * }} options Options. `readOnly` returns the live server-owned values
 *   (`apiPort`, `currentVersion`, …).
 * @returns {{getSettings: Function, putSettings: Function, getSettingsSchema: Function}} Handlers.
 */
export function createSettingsHandlers(options) {
  const store = options.store;
  const broker = options.broker;
  const readOnly = options.readOnly;
  const logger = options.logger ?? null;

  /**
   * `GET /api/v1/settings`.
   *
   * @returns {object} `{schemaVersion, updatedAt, settings, warnings}`.
   */
  function getSettings() {
    const snapshot = store.load();
    // Belt and braces with `load()`: even a store implementation that hands back a
    // partial document (or a test double) cannot make this response partial.
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      updatedAt: snapshot.updatedAt,
      settings: applyReadOnlyValues(mergeWithDefaults(snapshot.settings), readOnly()),
      warnings: [...snapshot.warnings],
    };
  }

  /**
   * `GET /api/v1/settings/schema`.
   *
   * @returns {object} Machine-readable description.
   */
  function getSettingsSchema() {
    return describeSettingsSchema();
  }

  /**
   * Ask the broker which providers still hold a credential.
   *
   * @param {string[]} providerIds Provider ids.
   * @returns {Promise<Map<string, boolean>>} `hasCredential` per id.
   * @throws {ConsoleError} `CREDENTIAL_STORE_UNAVAILABLE` when the broker cannot start.
   */
  async function credentialPresence(providerIds) {
    if (providerIds.length === 0) {
      return new Map();
    }
    const described = await broker.describeCredentials(providerIds);
    const presence = new Map();
    for (const providerId of providerIds) {
      presence.set(providerId, described.get(providerId)?.hasCredential === true);
    }
    return presence;
  }

  /**
   * `PUT /api/v1/settings`.
   *
   * @param {{body: unknown}} ctx Request context.
   * @returns {Promise<object>} `{settings, updatedAt, appliedNow, restartRequired, warnings}`.
   */
  async function putSettings(ctx) {
    const body = requireObjectBody(ctx.body, CONSOLE_CODES.SETTINGS_INVALID, 'settings update');
    for (const key of Object.keys(body)) {
      if (key !== 'settings' && key !== 'dryRun' && key !== 'discardCredential') {
        throw new ConsoleError(CONSOLE_CODES.SETTINGS_INVALID, 'settings update has an unknown field', {
          path: '$',
          rule: 'unknown_key',
          key: key.slice(0, 64),
        });
      }
    }
    if (body.settings === null || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      throw new ConsoleError(CONSOLE_CODES.SETTINGS_INVALID, 'settings update requires a settings object', {
        path: '$',
        rule: 'object',
      });
    }
    const dryRun = body.dryRun === true;
    const discardCredential = body.discardCredential === true;

    const snapshot = store.load();
    const liveReadOnly = readOnly();
    // Both sides of the diff are complete documents: a partial stored file must not make
    // `appliedNow`/`restartRequired` compare against missing leaves.
    const previous = applyReadOnlyValues(mergeWithDefaults(snapshot.settings), liveReadOnly);
    // Read-only fields are checked here and stripped before validation, so the
    // validator never has to overlay them (its overlay takes dotted paths and would
    // otherwise replace whole groups). Echoing the effective value back stays legal.
    assertReadOnlyUnchanged(body.settings, liveReadOnly);
    const validated = validateSettingsDocument(stripReadOnly(body.settings));
    const next = applyReadOnlyValues(validated, liveReadOnly);

    const previousIds = previous.models.providers.map((provider) => provider.id);
    const nextIds = new Set(next.models.providers.map((provider) => provider.id));
    const removed = previousIds.filter((id) => !nextIds.has(id));

    if (removed.length > 0) {
      const presence = await credentialPresence(removed);
      const locked = removed.filter((id) => presence.get(id) === true);
      if (locked.length > 0 && !discardCredential) {
        throw new ConsoleError(CONSOLE_CODES.SETTINGS_LOCKED, 'a removed provider still holds a credential', {
          providerId: locked[0],
          providers: locked,
        });
      }
      if (!dryRun) {
        // Delete first: a failed delete must leave the provider listed rather than
        // orphaning a secret on disk for a provider the console no longer shows.
        for (const providerId of locked) {
          await broker.deleteCredential(providerId);
        }
      }
    }

    const changed = changedPaths(previous, next);
    const classified = classifyChanges(changed);
    if (dryRun) {
      return {
        settings: next,
        updatedAt: snapshot.updatedAt,
        appliedNow: classified.appliedNow,
        restartRequired: classified.restartRequired,
        warnings: classified.warnings,
      };
    }

    const write = store.save(next);
    if (changed.length > 0) {
      // Paths and counts only: a settings value can be a hostname or a path list, and
      // a log line is not the place for either.
      logger?.info?.('settings updated', {
        changed_count: changed.length,
        restart_count: classified.restartRequired.length,
        not_wired_count: classified.warnings.length,
      });
    }
    return {
      settings: next,
      updatedAt: write.updatedAt,
      appliedNow: classified.appliedNow,
      restartRequired: classified.restartRequired,
      warnings: classified.warnings,
    };
  }

  return { getSettings, putSettings, getSettingsSchema };
}

/**
 * Read the effective value of a schema path from a document (test/diagnostic aid).
 *
 * @param {object} document Settings document.
 * @param {string} path Dotted path.
 * @returns {unknown} Value, or `undefined` when absent.
 */
export function settingsValue(document, path) {
  return readPath(document, path).value;
}
