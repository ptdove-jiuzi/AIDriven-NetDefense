/**
 * api/models.js — `GET /api/v1/models` and `POST /api/v1/models/:providerId/test`.
 *
 * Two very different operations share this file because they share one projection:
 *
 * - **`GET` is a pure read of local state.** It never spawns a provider request and
 *   never touches the network. The credential *metadata* has to come from the
 *   broker child (only it can see the secret), so a missing broker degrades to
 *   `hasCredential:false` + a logged warning instead of failing the page.
 * - **`POST …/test` is the one route that reaches the internet**, and it does so
 *   entirely inside the broker child. The daemon's job here is the triple gate of
 *   contract §2.4 — `egressEnabled`, provider `enabled`, credential present — and it
 *   refuses before spawning when the first two fail. That is what makes the
 *   "zero connections while egress is off" assertion true by construction rather
 *   than by hoping the child behaves.
 *
 * The health cache (`<dataDir>/console/model-health.json`) is written *only* by the
 * test route, exactly as contract §2.2 says. `healthy: null` means "never tested",
 * which is a distinct value from "healthy": the UI must not paint null green.
 */

import { randomBytes } from 'node:crypto';
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

import { CONSOLE_CODES, ConsoleError } from './console-errors.js';
import { isLoopbackHostname } from './settings-schema.js';

/** Health-cache schema version. */
const HEALTH_SCHEMA_VERSION = '1.0';

/** Longest health-cache file accepted. */
const MAX_HEALTH_BYTES = 256 * 1024;

/**
 * Create the model-health cache.
 *
 * Corrupt or missing files are not an error: the projection simply reports
 * `healthy: null` ("never tested") for everything, which is the truthful value.
 *
 * @param {{filePath: string, logger?: object, fsModule?: object}} options Options.
 * @returns {{read: () => Map<string, object>, write: (providerId: string, entry: object) => object, filePath: string}}
 *   Cache handle.
 */
export function createHealthCache(options) {
  const filePath = options.filePath;
  const logger = options.logger ?? null;
  const fs = options.fsModule ?? {
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
  /** @type {Map<string, object>} */
  let entries = new Map();
  let loaded = false;

  function read() {
    if (loaded) {
      return new Map(entries);
    }
    loaded = true;
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.('model health cache is not readable; treating it as empty', {
          reason: error?.code ?? 'UNREADABLE',
        });
      }
      entries = new Map();
      return new Map(entries);
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_HEALTH_BYTES) {
      entries = new Map();
      return new Map(entries);
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== HEALTH_SCHEMA_VERSION) {
        entries = new Map();
        return new Map(entries);
      }
      const next = new Map();
      for (const [providerId, value] of Object.entries(parsed.providers ?? {})) {
        if (value === null || typeof value !== 'object') {
          continue;
        }
        next.set(providerId, {
          healthy: value.healthy === true ? true : (value.healthy === false ? false : null),
          lastCheckedAt: typeof value.lastCheckedAt === 'string' ? value.lastCheckedAt : null,
          lastError: normalizeError(value.lastError),
        });
      }
      entries = next;
      return new Map(entries);
    } catch {
      logger?.warn?.('model health cache is not valid json; treating it as empty', {});
      entries = new Map();
      return new Map(entries);
    }
  }

  function write(providerId, entry) {
    read();
    entries.set(providerId, {
      healthy: entry.healthy === true ? true : (entry.healthy === false ? false : null),
      lastCheckedAt: typeof entry.lastCheckedAt === 'string' ? entry.lastCheckedAt : null,
      lastError: normalizeError(entry.lastError),
    });
    const payload = {
      schemaVersion: HEALTH_SCHEMA_VERSION,
      providers: Object.fromEntries(entries),
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const directory = dirname(filePath);
    const temporary = join(directory, `.model-health.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
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
        // Windows has no POSIX mode bits.
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
        // Harmless leftover; the next write uses a unique name.
      }
      // The health cache is diagnostic state: a failed write must not fail the probe
      // that already produced an answer for the operator.
      logger?.warn?.('model health cache write failed', { reason: error?.code ?? 'WRITE_FAILED' });
    }
    return new Map(entries);
  }

  return { read, write, filePath };
}

/**
 * Reduce a stored/test error to identifier + enum fields.
 *
 * The upstream message is deliberately dropped: contract §2.1 says `details` and
 * error bodies never carry the upstream body, and a cached error is re-served to
 * every later `GET /models`.
 *
 * @param {unknown} value Candidate error.
 * @returns {{code: string, action: string|null}|null} Normalized error.
 */
function normalizeError(value) {
  if (value === null || typeof value !== 'object' || typeof value.code !== 'string') {
    return null;
  }
  return {
    code: value.code.slice(0, 64),
    action: typeof value.action === 'string' ? value.action.slice(0, 64) : null,
  };
}

/**
 * Build the `GET /api/v1/models` projection.
 *
 * @param {{
 *   settings: object,
 *   credentialInfo: Map<string, object>,
 *   health: Map<string, object>,
 *   engine: {selected: string|null, harness: object}
 * }} input Projection input.
 * @returns {object} Response body.
 */
export function buildModelsProjection(input) {
  const settings = input.settings;
  const credentialInfo = input.credentialInfo;
  const health = input.health;
  const modelEntries = settings.models.models;
  return {
    egressEnabled: settings.models.egressEnabled,
    routing: {
      mode: settings.models.routing.mode,
      uniformModelId: settings.models.routing.uniformModelId,
      defaultTier: settings.models.routing.defaultTier,
    },
    providers: settings.models.providers.map((provider) => {
      const credential = credentialInfo.get(provider.id) ?? {
        hasCredential: false,
        masked: null,
        fingerprint: null,
        updatedAt: null,
        lengthBucket: null,
      };
      const cached = health.get(provider.id) ?? null;
      return {
        id: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        allowLoopback: provider.allowLoopback,
        hasCredential: credential.hasCredential,
        credential: {
          masked: credential.masked,
          fingerprint: credential.fingerprint,
          updatedAt: credential.updatedAt,
          lengthBucket: credential.lengthBucket,
        },
        healthy: cached === null ? null : cached.healthy,
        lastError: cached === null ? null : cached.lastError,
        lastCheckedAt: cached === null ? null : cached.lastCheckedAt,
        budget: {
          dailyInputTokens: provider.dailyInputTokens,
          dailyOutputTokens: provider.dailyOutputTokens,
        },
      };
    }),
    models: modelEntries.map((model) => ({
      id: model.id,
      providerId: model.providerId,
      tier: model.tier,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      costClass: model.costClass,
    })),
    // No ledger writer exists in 0.0.1 (contract §12.1 item 5). An honest "no data"
    // is required here: a zero would read as "you spent nothing", which is a claim.
    usage: {
      available: false,
      reason: 'NO_LEDGER',
      byProvider: [],
      byTier: [],
      escalations: 0,
    },
    engine: {
      selected: settings.models.agent.engine === 'harness'
        ? (input.engine.selected === 'harness' ? 'harness' : null)
        : input.engine.selected,
      harness: { ...input.engine.harness },
    },
  };
}

/**
 * Find a provider by id.
 *
 * @param {object} settings Settings document.
 * @param {string} providerId Provider id.
 * @returns {object|null} Provider entry.
 */
function findProvider(settings, providerId) {
  return settings.models.providers.find((provider) => provider.id === providerId) ?? null;
}

/**
 * Create the models handlers.
 *
 * @param {{
 *   settingsStore: object,
 *   broker: object,
 *   engine: object,
 *   healthCache: object,
 *   readOnly?: () => object,
 *   clock: object,
 *   logger?: object
 * }} options Options.
 * @returns {{getModels: Function, testProvider: Function}} Handlers.
 */
export function createModelsHandlers(options) {
  const settingsStore = options.settingsStore;
  const broker = options.broker;
  const engine = options.engine;
  const healthCache = options.healthCache;
  const clock = options.clock;
  const logger = options.logger ?? null;

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
   * `GET /api/v1/models` — read-only runtime projection, no egress.
   *
   * @returns {Promise<object>} Projection.
   */
  async function getModels() {
    const settings = settingsStore.current();
    const providerIds = settings.models.providers.map((provider) => provider.id);
    let credentialInfo = new Map();
    if (providerIds.length > 0) {
      try {
        credentialInfo = await broker.describeCredentials(providerIds);
      } catch (error) {
        // The page must still render. Every provider shows "no credential", which is
        // the same thing the UI can verify by trying to save one, and the reason is
        // logged rather than silently swallowed.
        if (error instanceof ConsoleError) {
          logger?.warn?.('credential metadata unavailable; projecting as absent', {
            code: error.code,
          });
        } else {
          logger?.warn?.('credential metadata unavailable; projecting as absent', { code: 'UNEXPECTED' });
        }
        credentialInfo = new Map();
      }
    }
    return buildModelsProjection({
      settings,
      credentialInfo,
      health: healthCache.read(),
      engine: engine.describe(),
    });
  }

  /**
   * `POST /api/v1/models/:providerId/test`.
   *
   * @param {{params: {providerId: string}}} ctx Request context.
   * @returns {Promise<object>} `{ok, latencyMs, modelCount, error, testedAt}`.
   */
  async function testProvider(ctx) {
    const providerId = ctx.params.providerId;
    const settings = settingsStore.current();
    const provider = findProvider(settings, providerId);
    if (provider === null) {
      throw new ConsoleError(CONSOLE_CODES.PROVIDER_UNKNOWN, 'provider is not registered', {
        providerId: String(providerId).slice(0, 64),
      });
    }
    // Triple gate, in this order (contract §2.4). The first two are decided here, so
    // no child process exists yet and the provider port sees zero connections.
    if (settings.models.egressEnabled !== true) {
      throw new ConsoleError(CONSOLE_CODES.EGRESS_DISABLED, 'model egress is disabled', {});
    }
    if (provider.enabled !== true) {
      throw new ConsoleError(CONSOLE_CODES.PROVIDER_DISABLED, 'provider is disabled', { providerId: provider.id });
    }
    const startedMs = typeof clock?.nowMs === 'function' ? clock.nowMs() : Date.now();
    // Loopback providers may run keyless (local Ollama); every other provider must have
    // a credential, and the child checks that on the same connection before dialing, so
    // a missing credential is a 409 with zero egress rather than an `ok:false` 200.
    const loopback = isLoopbackHostname(safeHost(provider.baseUrl) ?? '');
    let result;
    try {
      result = await broker.testProvider({
        provider: {
          id: provider.id,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          allowLoopback: provider.allowLoopback,
        },
        requireCredential: !loopback,
        timeoutMs: 8000,
      });
    } catch (error) {
      // A broker that cannot start or a credential that is missing is a gate failure,
      // not a provider failure: the contract renders these as JSON errors, not as
      // `ok:false` on a 200.
      if (error instanceof ConsoleError) {
        logger?.info?.('egress', {
          kind: 'test',
          providerId: provider.id,
          host: safeHost(provider.baseUrl),
          outcome: error.code,
          latencyMs: typeof clock?.nowMs === 'function' ? clock.nowMs() - startedMs : 0,
        });
        throw error;
      }
      throw new ConsoleError(CONSOLE_CODES.UPSTREAM_FAILED, 'provider probe failed', {
        reason: 'BROKER_FAULT',
      });
    }
    const testedAt = nowIso();
    const ok = result?.ok === true;
    const error = ok ? null : normalizeError(result?.error) ?? { code: 'UPSTREAM_FAILED', action: 'RETRY_LATER' };
    const latencyMs = Number.isSafeInteger(result?.latencyMs) ? result.latencyMs : null;
    const modelCount = Number.isSafeInteger(result?.modelCount) ? result.modelCount : null;
    healthCache.write(provider.id, {
      healthy: ok,
      lastCheckedAt: testedAt,
      lastError: error,
    });
    // One structured egress line per probe. Host and latency only; never a body or a key.
    logger?.info?.('egress', {
      kind: 'test',
      providerId: provider.id,
      host: safeHost(provider.baseUrl),
      outcome: ok ? 'ok' : (error?.code ?? 'UPSTREAM_FAILED'),
      latencyMs: latencyMs ?? 0,
    });
    return {
      ok,
      latencyMs,
      modelCount,
      error,
      testedAt,
    };
  }

  return { getModels, testProvider };
}

/**
 * Extract the host of a provider URL for a log line.
 *
 * @param {string} baseUrl Provider base URL.
 * @returns {string|null} Host, or `null` when unparseable.
 */
function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
}
