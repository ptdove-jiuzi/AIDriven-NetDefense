/**
 * api/settings-schema.js — the closed settings document (contract §6) and the
 * machine-readable description the settings page renders from (contract §2.8).
 *
 * One table, three consumers, so they cannot drift:
 *
 * 1. `DEFAULT_SETTINGS` — what a fresh install runs with: egress off, every provider
 *    disabled, no credential, no response execution.
 * 2. `validateSettingsDocument()` — the closed schema: unknown keys, wrong types,
 *    out-of-range numbers, over-long lists and provider URLs that fail ADR-0010
 *    are refused with `{path, rule}` so the UI can point at the field.
 * 3. `describeSettingsSchema()` — `GET /api/v1/settings/schema`, the only render
 *    source for the settings page. `wired:false` items are visible but must be
 *    labelled "saved, not in effect (0.0.1)" by the UI.
 *
 * ## Provider URL rules (ADR-0010 §2.2)
 *
 * The algorithm is the same one `apps/model-broker/src/endpoint.js` freezes with,
 * reimplemented here on purpose: the daemon **must not import** the model-broker
 * package (contract §1 rule 2 — its manifest is frozen and the packaging closure is
 * derived from declared dependencies). The rules kept verbatim:
 *
 * - absolute URL, `https:` always; `http:` only for a literal loopback host with
 *   `allowLoopback=true` and a non-`deepseek` kind;
 * - no userinfo, no query, no fragment;
 * - a non-empty path prefix (that is what makes `baseUrl` a prefix, not an origin);
 * - `userinfo`/`query`/`hash` rejection is what stops `baseUrl` from becoming "any
 *   upstream on every request", which is the reason the single-endpoint rule
 *   existed before ADR-0010 widened it.
 *
 * Any future change to endpoint.js's rules must be mirrored here; the shared
 * invariant is recorded in the status file at
 * `docs/implementation/status/UI2-B8.md` (deviation D3).
 */

import { ConsoleError, CONSOLE_CODES } from './console-errors.js';

/** Version of the settings document shape. Required in the file. */
export const SETTINGS_SCHEMA_VERSION = '1.0';

/** Provider registry capacity (ADR-0010 §2.1: more than eight is a gateway). */
export const MAX_PROVIDERS = 8;

/** Model registry capacity: bounded so the settings page stays renderable. */
export const MAX_MODELS = 32;

/** `providerId` grammar (ADR-0010 §2.1). */
export const PROVIDER_ID_PATTERN = /^[a-z0-9-]{2,32}$/u;

/** `modelId` grammar (contract §6). */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

/** Alert severities, shared by detection mapping and escalation thresholds. */
export const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

/** Routing tiers (ADR-0010 §2.4). */
export const TIERS = Object.freeze(['watch', 'triage', 'respond']);

/**
 * Action identifiers of the response catalog.
 *
 * Copied from `packages/response-policy/src/catalog.js` (`ACTION_IDS`) rather than
 * imported: the daemon's manifest does not declare that package, and inventing a
 * second vocabulary inside `actionMatrix` would make the settings page disagree
 * with the executor about which actions exist. `decision` is the catalog's own
 * approval requirement mapped onto the three-value policy.
 */
export const ACTION_CATALOG = Object.freeze([
  Object.freeze({ id: 'observe.record_alert', decision: 'allow' }),
  Object.freeze({ id: 'process.suspend', decision: 'allow' }),
  Object.freeze({ id: 'process.terminate', decision: 'needs_approval' }),
  Object.freeze({ id: 'network.block_connection', decision: 'needs_approval' }),
  Object.freeze({ id: 'network.isolate', decision: 'needs_approval' }),
  Object.freeze({ id: 'file.quarantine', decision: 'needs_approval' }),
]);

/** Decision values for `response.actionMatrix`. */
export const ACTION_DECISIONS = Object.freeze(['allow', 'needs_approval', 'deny']);

/**
 * Actions that are **wired** in this build (OPS-DIAG, contract §2.1 diagnostics).
 *
 * Until 0.0.1 these two answered `501 NOT_IMPLEMENTED`. They are now real routes:
 * `POST /api/v1/diagnostics/bundle` (support bundle, redacted) and
 * `POST /api/v1/diagnostics/token-rotate` (rotates the bearer token and returns
 * the new one exactly once). `available: true` is only ever set here when the
 * daemon actually mounted the handler — a schema that advertises a button the
 * daemon does not serve is worse than a 501.
 */
export const WIRED_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'diagnostics.exportBundle',
    path: 'diagnostics.exportBundle',
    method: 'POST',
    endpoint: '/api/v1/diagnostics/bundle',
    available: true,
    reason: null,
    requiresConfirm: true,
  }),
  Object.freeze({
    id: 'diagnostics.rotateToken',
    path: 'diagnostics.rotateToken',
    method: 'POST',
    endpoint: '/api/v1/diagnostics/token-rotate',
    available: true,
    reason: null,
    requiresConfirm: true,
  }),
]);

/**
 * Actions that exist in the product but are **not wired in 0.0.1**.
 *
 * They must be visible in `GET /settings/schema#actions` and, when invoked, answer
 * `501 NOT_IMPLEMENTED` — never a fake success (contract §6 end).
 */
export const UNWIRED_ACTIONS = Object.freeze([
  Object.freeze({ id: 'update.checkNow', path: 'update.checkNow', method: 'POST', available: false, reason: 'NOT_IMPLEMENTED_0_0_1', requiresConfirm: false }),
  Object.freeze({ id: 'update.rollback', path: 'update.rollback', method: 'POST', available: false, reason: 'NOT_IMPLEMENTED_0_0_1', requiresConfirm: true }),
  Object.freeze({ id: 'response.runAction', path: 'response.runAction', method: 'POST', available: false, reason: 'NOT_IMPLEMENTED_0_0_1', requiresConfirm: true }),
]);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

/**
 * Clone a JSON-shaped value.
 *
 * @param {unknown} value Value to clone.
 * @returns {unknown} Deep copy.
 */
export function cloneJson(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

const DEFAULT_ACTION_MATRIX = Object.freeze(Object.fromEntries(
  ACTION_CATALOG.map((action) => [action.id, action.decision]),
));

/** Default document. Every danger defaults off; see contract §5. */
export const DEFAULT_SETTINGS = deepFreeze(cloneJson({
  models: {
    egressEnabled: false,
    providers: [
      {
        id: 'deepseek',
        kind: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        enabled: false,
        allowLoopback: false,
        dailyInputTokens: 30000,
        dailyOutputTokens: 6000,
        pricing: null,
      },
    ],
    models: [
      {
        id: 'deepseek-chat',
        providerId: 'deepseek',
        tier: 'triage',
        maxInputTokens: 8192,
        maxOutputTokens: 1024,
        costClass: 'cheap',
      },
    ],
    routing: {
      mode: 'tiered',
      uniformModelId: null,
      defaultTier: 'watch',
      escalation: {
        enabled: true,
        minSeverity: 'high',
        cooldownSeconds: 300,
        maxEscalationsPerHour: 20,
      },
    },
    budget: {
      perAnalysis: { inputTokens: 12000, outputTokens: 2000, maxRequests: 3 },
      daily: { inputTokens: 30000, outputTokens: 6000 },
      maxConcurrentAnalyses: 2,
    },
    agent: {
      engine: 'auto',
      maxHistoryMessages: 20,
      temperature: 0.2,
      showTokenUsage: true,
    },
  },
  collection: {
    channels: ['security'],
    registryPaths: [],
    services: [],
    pollIntervalMs: 10000,
    retention: { eventDays: 7, alertDays: 30, maxDbBytes: 1073741824 },
  },
  detection: {
    enabledRulePacks: [],
    severityMapping: { info: 'info', low: 'low', medium: 'medium', high: 'high', critical: 'critical' },
    allowlist: [],
    thresholds: { count: 5, windowMs: 60000 },
    hysteresis: { enabled: true, steps: 1 },
  },
  response: {
    approvalMode: 'high-only',
    actionMatrix: { ...DEFAULT_ACTION_MATRIX },
    cooldownSeconds: 300,
    escalationPolicy: 'suggest-only',
    executionEnabled: false,
  },
  ui: {
    theme: 'system',
    density: 'comfortable',
    locale: 'zh-CN',
    startView: 'overview',
    autoRefreshMs: 10000,
    trayBehavior: 'show',
    autostart: false,
  },
  update: {
    autoCheck: false,
    channel: 'stable',
    checkIntervalHours: 24,
    lastCheckedAt: null,
    currentVersion: null,
  },
  diagnostics: {
    logLevel: 'info',
    healthCheckIntervalMs: 30000,
    apiPort: null,
    exportBundleLastAt: null,
  },
}));

/** Keys of a legal settings document. `about` is read-only and never stored. */
export const SETTINGS_GROUPS = Object.freeze([
  'models',
  'collection',
  'detection',
  'response',
  'ui',
  'update',
  'diagnostics',
]);

/**
 * Fields the server owns. A `PUT` may echo them back unchanged (the settings page
 * renders a full document) but may never change them.
 */
export const READ_ONLY_PATHS = Object.freeze([
  'response.executionEnabled',
  'update.lastCheckedAt',
  'update.currentVersion',
  'diagnostics.apiPort',
  'diagnostics.exportBundleLastAt',
]);

const READ_ONLY_SET = new Set(READ_ONLY_PATHS);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Throw a `SETTINGS_INVALID` with the contract's `{path, rule}` details.
 *
 * `path` is a fixed schema path from this file, never caller input, so it cannot
 * be used to inflate a response body.
 *
 * @param {string} path Schema path.
 * @param {string} rule Short stable rule name.
 * @param {object} [extra] Extra enumeration/counter detail.
 * @returns {never} Always throws.
 */
function invalid(path, rule, extra = undefined) {
  throw new ConsoleError(
    CONSOLE_CODES.SETTINGS_INVALID,
    'settings document is not valid',
    extra === undefined ? { path, rule } : { path, rule, ...extra },
  );
}

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, path) {
  if (!isPlainObject(value)) {
    invalid(path, 'object');
  }
  return value;
}

function assertKnownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      invalid(path === '$' ? key : `${path}.${key}`, 'unknown');
    }
  }
}

function readBoolean(value, path) {
  if (typeof value !== 'boolean') {
    invalid(path, 'boolean');
  }
  return value;
}

function readInteger(value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    invalid(path, 'integer', { min, max });
  }
  return value;
}

function readNumber(value, path, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(path, 'number', { min, max });
  }
  return value;
}

function readString(value, path, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    invalid(path, 'string', { max_length: maxLength });
  }
  return value;
}

function readStringOrNull(value, path, maxLength = 128) {
  if (value === null) {
    return null;
  }
  return readString(value, path, maxLength);
}

function readEnum(value, path, values) {
  if (typeof value !== 'string' || !values.includes(value)) {
    invalid(path, 'enum', { values: [...values] });
  }
  return value;
}

function readStringArray(value, path, options) {
  if (!Array.isArray(value)) {
    invalid(path, 'string[]');
  }
  if (value.length > options.maxItems) {
    invalid(path, 'max_items', { max_items: options.maxItems });
  }
  const seen = new Set();
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (options.values !== undefined) {
      output.push(readEnum(item, `${path}[${index}]`, options.values));
    } else {
      output.push(readString(item, `${path}[${index}]`, options.maxLength ?? 256));
    }
    if (seen.has(item)) {
      invalid(`${path}[${index}]`, 'duplicate');
    }
    seen.add(item);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Provider URLs (ADR-0010 §2.2, mirrored from apps/model-broker/src/endpoint.js)
// ---------------------------------------------------------------------------

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

/**
 * Report whether a hostname is a loopback name.
 *
 * Mirrors `isLoopbackHost` in `apps/model-broker/src/endpoint.js` (including the
 * `localhost` spelling, which only the *allowLoopback* check may accept).
 *
 * @param {string} hostname Lower-case hostname.
 * @returns {boolean} `true` for loopback.
 */
export function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]' || value === '127.0.0.1') {
    return true;
  }
  if (!LOOPBACK_V4.test(value)) {
    return false;
  }
  return value.split('.').every((part) => Number(part) <= 255);
}

/**
 * Report whether a hostname is a *literal* loopback address.
 *
 * `localhost` is deliberately excluded: the plaintext-http allowance must not
 * depend on a resolver, exactly as in `endpoint.js::isLiteralLoopback`.
 *
 * @param {string} hostname Hostname.
 * @returns {boolean} `true` for a literal loopback address.
 */
export function isLiteralLoopbackHostname(hostname) {
  const value = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/gu, '');
  return value === '::1' || LOOPBACK_V4.test(value);
}

/**
 * Validate a `baseUrl` against ADR-0010 §2.2 and freeze its parts.
 *
 * @param {unknown} raw Caller-supplied URL.
 * @param {{allowLoopback?: boolean, kind?: string}} [options] Provider context.
 * @returns {{baseUrl: string, scheme: string, host: string, port: string, pathPrefix: string, loopback: boolean}}
 *   Normalized description; the `baseUrl` member is the trimmed string to store.
 * @throws {ConsoleError} `PROVIDER_INVALID` when any rule fails.
 */
export function validateProviderUrl(raw, options = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_INVALID, 'provider baseUrl is required', { field: 'baseUrl' });
  }
  const trimmed = raw.trim();
  if (trimmed.length > 2048) {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_INVALID, 'provider baseUrl is too long', { field: 'baseUrl' });
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_INVALID, 'provider baseUrl is not an absolute url', { field: 'baseUrl' });
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_INVALID, 'provider baseUrl must not carry userinfo', { field: 'baseUrl' });
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_INVALID, 'provider baseUrl must not carry query or fragment', { field: 'baseUrl' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_INVALID, 'provider baseUrl must be http or https', { field: 'baseUrl' });
  }
  const pathPrefix = url.pathname.replace(/\/+$/u, '');
  if (pathPrefix === '') {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_INVALID, 'provider baseUrl must name a path prefix', { field: 'baseUrl' });
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === 'http:') {
    const allowed = options.allowLoopback === true
      && options.kind !== 'deepseek'
      && isLiteralLoopbackHostname(url.hostname);
    if (!allowed) {
      throw new ConsoleError(
        CONSOLE_CODES.PROVIDER_INVALID,
        'plaintext provider endpoints require a literal loopback host and allowLoopback',
        { field: 'baseUrl', reason: 'INSECURE_NOT_ALLOWED' },
      );
    }
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return Object.freeze({
    baseUrl: trimmed,
    scheme: url.protocol.slice(0, -1),
    host: url.hostname.toLowerCase(),
    port,
    pathPrefix,
    loopback,
  });
}

// ---------------------------------------------------------------------------
// Group validators
// ---------------------------------------------------------------------------

function validateProvider(raw, index, path) {
  const provider = assertObject(raw, `${path}[${index}]`);
  assertKnownKeys(provider, ['id', 'kind', 'baseUrl', 'enabled', 'allowLoopback', 'dailyInputTokens', 'dailyOutputTokens', 'pricing'], `${path}[${index}]`);
  const id = readString(provider.id, `${path}[${index}].id`, 32);
  if (!PROVIDER_ID_PATTERN.test(id)) {
    invalid(`${path}[${index}].id`, 'pattern');
  }
  const kind = readEnum(provider.kind, `${path}[${index}].kind`, ['openai-compatible', 'deepseek', 'ollama']);
  const allowLoopback = readBoolean(provider.allowLoopback, `${path}[${index}].allowLoopback`);
  const url = validateProviderUrl(provider.baseUrl, { allowLoopback, kind });
  const enabled = readBoolean(provider.enabled, `${path}[${index}].enabled`);
  const dailyInputTokens = readInteger(provider.dailyInputTokens, `${path}[${index}].dailyInputTokens`, 0, 1_000_000_000);
  const dailyOutputTokens = readInteger(provider.dailyOutputTokens, `${path}[${index}].dailyOutputTokens`, 0, 1_000_000_000);
  let pricing = null;
  if (provider.pricing !== null) {
    const price = assertObject(provider.pricing, `${path}[${index}].pricing`);
    assertKnownKeys(price, ['inputUsdPerMTok', 'outputUsdPerMTok'], `${path}[${index}].pricing`);
    pricing = {
      inputUsdPerMTok: readNumber(price.inputUsdPerMTok, `${path}[${index}].pricing.inputUsdPerMTok`, 0, 1_000_000),
      outputUsdPerMTok: readNumber(price.outputUsdPerMTok, `${path}[${index}].pricing.outputUsdPerMTok`, 0, 1_000_000),
    };
  }
  return { id, kind, baseUrl: url.baseUrl, enabled, allowLoopback, dailyInputTokens, dailyOutputTokens, pricing };
}

function validateProviders(raw) {
  if (!Array.isArray(raw)) {
    invalid('models.providers', 'object[]');
  }
  if (raw.length > MAX_PROVIDERS) {
    // A ninth provider is not a malformed document, it is a product-shape refusal;
    // the dedicated 409 exists so the UI can say "8 is the limit" without a field path.
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_LIMIT, 'provider registry is full', { limit: MAX_PROVIDERS });
  }
  const providers = raw.map((entry, index) => validateProvider(entry, index, 'models.providers'));
  const seen = new Set();
  for (let index = 0; index < providers.length; index += 1) {
    if (seen.has(providers[index].id)) {
      invalid(`models.providers[${index}].id`, 'duplicate');
    }
    seen.add(providers[index].id);
  }
  return providers;
}

function validateModels(raw, providers) {
  if (!Array.isArray(raw)) {
    invalid('models.models', 'object[]');
  }
  if (raw.length > MAX_MODELS) {
    invalid('models.models', 'max_items', { max_items: MAX_MODELS });
  }
  const providerIds = new Set(providers.map((provider) => provider.id));
  const seen = new Set();
  return raw.map((entry, index) => {
    const path = `models.models[${index}]`;
    const model = assertObject(entry, path);
    assertKnownKeys(model, ['id', 'providerId', 'tier', 'maxInputTokens', 'maxOutputTokens', 'costClass'], path);
    const id = readString(model.id, `${path}.id`, 64);
    if (!MODEL_ID_PATTERN.test(id)) {
      invalid(`${path}.id`, 'pattern');
    }
    if (seen.has(id)) {
      invalid(`${path}.id`, 'duplicate');
    }
    seen.add(id);
    const providerId = readString(model.providerId, `${path}.providerId`, 32);
    if (!providerIds.has(providerId)) {
      invalid(`${path}.providerId`, 'provider_unknown');
    }
    return {
      id,
      providerId,
      tier: readEnum(model.tier, `${path}.tier`, TIERS),
      maxInputTokens: readInteger(model.maxInputTokens, `${path}.maxInputTokens`, 1, 1_000_000),
      maxOutputTokens: readInteger(model.maxOutputTokens, `${path}.maxOutputTokens`, 1, 1_000_000),
      costClass: readEnum(model.costClass, `${path}.costClass`, ['free-local', 'cheap', 'standard', 'expensive']),
    };
  });
}

function validateModelsGroup(raw) {
  const group = assertObject(raw, 'models');
  assertKnownKeys(group, ['egressEnabled', 'providers', 'models', 'routing', 'budget', 'agent'], 'models');
  const providers = validateProviders(group.providers);
  const models = validateModels(group.models, providers);

  const routingRaw = assertObject(group.routing, 'models.routing');
  assertKnownKeys(routingRaw, ['mode', 'uniformModelId', 'defaultTier', 'escalation'], 'models.routing');
  const mode = readEnum(routingRaw.mode, 'models.routing.mode', ['tiered', 'uniform']);
  const uniformModelId = readStringOrNull(routingRaw.uniformModelId, 'models.routing.uniformModelId', 64);
  const modelIds = new Set(models.map((model) => model.id));
  if (mode === 'uniform') {
    if (uniformModelId === null) {
      invalid('models.routing.uniformModelId', 'uniform_model_required');
    }
    if (!modelIds.has(uniformModelId)) {
      invalid('models.routing.uniformModelId', 'model_unknown');
    }
  } else if (uniformModelId !== null && !modelIds.has(uniformModelId)) {
    invalid('models.routing.uniformModelId', 'model_unknown');
  }
  const escalationRaw = assertObject(routingRaw.escalation, 'models.routing.escalation');
  assertKnownKeys(escalationRaw, ['enabled', 'minSeverity', 'cooldownSeconds', 'maxEscalationsPerHour'], 'models.routing.escalation');
  const routing = {
    mode,
    uniformModelId,
    defaultTier: readEnum(routingRaw.defaultTier, 'models.routing.defaultTier', TIERS),
    escalation: {
      enabled: readBoolean(escalationRaw.enabled, 'models.routing.escalation.enabled'),
      minSeverity: readEnum(escalationRaw.minSeverity, 'models.routing.escalation.minSeverity', SEVERITIES),
      cooldownSeconds: readInteger(escalationRaw.cooldownSeconds, 'models.routing.escalation.cooldownSeconds', 0, 86400),
      maxEscalationsPerHour: readInteger(escalationRaw.maxEscalationsPerHour, 'models.routing.escalation.maxEscalationsPerHour', 0, 10000),
    },
  };

  const budgetRaw = assertObject(group.budget, 'models.budget');
  assertKnownKeys(budgetRaw, ['perAnalysis', 'daily', 'maxConcurrentAnalyses'], 'models.budget');
  const perAnalysisRaw = assertObject(budgetRaw.perAnalysis, 'models.budget.perAnalysis');
  assertKnownKeys(perAnalysisRaw, ['inputTokens', 'outputTokens', 'maxRequests'], 'models.budget.perAnalysis');
  const dailyRaw = assertObject(budgetRaw.daily, 'models.budget.daily');
  assertKnownKeys(dailyRaw, ['inputTokens', 'outputTokens'], 'models.budget.daily');
  const budget = {
    perAnalysis: {
      inputTokens: readInteger(perAnalysisRaw.inputTokens, 'models.budget.perAnalysis.inputTokens', 1, 1_000_000),
      outputTokens: readInteger(perAnalysisRaw.outputTokens, 'models.budget.perAnalysis.outputTokens', 1, 1_000_000),
      maxRequests: readInteger(perAnalysisRaw.maxRequests, 'models.budget.perAnalysis.maxRequests', 1, 10),
    },
    daily: {
      inputTokens: readInteger(dailyRaw.inputTokens, 'models.budget.daily.inputTokens', 0, 1_000_000_000),
      outputTokens: readInteger(dailyRaw.outputTokens, 'models.budget.daily.outputTokens', 0, 1_000_000_000),
    },
    maxConcurrentAnalyses: readInteger(budgetRaw.maxConcurrentAnalyses, 'models.budget.maxConcurrentAnalyses', 1, 8),
  };

  const agentRaw = assertObject(group.agent, 'models.agent');
  assertKnownKeys(agentRaw, ['engine', 'maxHistoryMessages', 'temperature', 'showTokenUsage'], 'models.agent');
  const agent = {
    engine: readEnum(agentRaw.engine, 'models.agent.engine', ['auto', 'broker-host', 'harness']),
    maxHistoryMessages: readInteger(agentRaw.maxHistoryMessages, 'models.agent.maxHistoryMessages', 1, 100),
    // A sampling temperature is fractional by nature (default 0.2) while contract
    // §2.8's `type` enum has no `number`; see deviation D3 in the status file.
    temperature: readNumber(agentRaw.temperature, 'models.agent.temperature', 0, 2),
    showTokenUsage: readBoolean(agentRaw.showTokenUsage, 'models.agent.showTokenUsage'),
  };

  return {
    egressEnabled: readBoolean(group.egressEnabled, 'models.egressEnabled'),
    providers,
    models,
    routing,
    budget,
    agent,
  };
}

function validateCollectionGroup(raw) {
  const group = assertObject(raw, 'collection');
  assertKnownKeys(group, ['channels', 'registryPaths', 'services', 'pollIntervalMs', 'retention'], 'collection');
  const retentionRaw = assertObject(group.retention, 'collection.retention');
  assertKnownKeys(retentionRaw, ['eventDays', 'alertDays', 'maxDbBytes'], 'collection.retention');
  return {
    channels: readStringArray(group.channels, 'collection.channels', {
      maxItems: 4,
      values: ['security', 'system', 'application', 'powershell'],
    }),
    registryPaths: readStringArray(group.registryPaths, 'collection.registryPaths', { maxItems: 32, maxLength: 512 }),
    services: readStringArray(group.services, 'collection.services', { maxItems: 64, maxLength: 256 }),
    pollIntervalMs: readInteger(group.pollIntervalMs, 'collection.pollIntervalMs', 1000, 600000),
    retention: {
      eventDays: readInteger(retentionRaw.eventDays, 'collection.retention.eventDays', 1, 3650),
      alertDays: readInteger(retentionRaw.alertDays, 'collection.retention.alertDays', 1, 3650),
      maxDbBytes: readInteger(retentionRaw.maxDbBytes, 'collection.retention.maxDbBytes', 1_048_576, 1_000_000_000_000),
    },
  };
}

function validateDetectionGroup(raw) {
  const group = assertObject(raw, 'detection');
  assertKnownKeys(group, ['enabledRulePacks', 'severityMapping', 'allowlist', 'thresholds', 'hysteresis'], 'detection');
  const mappingRaw = assertObject(group.severityMapping, 'detection.severityMapping');
  assertKnownKeys(mappingRaw, SEVERITIES, 'detection.severityMapping');
  const severityMapping = {};
  for (const severity of SEVERITIES) {
    severityMapping[severity] = readEnum(mappingRaw[severity], `detection.severityMapping.${severity}`, SEVERITIES);
  }
  if (!Array.isArray(group.allowlist)) {
    invalid('detection.allowlist', 'object[]');
  }
  if (group.allowlist.length > 200) {
    invalid('detection.allowlist', 'max_items', { max_items: 200 });
  }
  const allowlist = group.allowlist.map((entry, index) => {
    const path = `detection.allowlist[${index}]`;
    const row = assertObject(entry, path);
    assertKnownKeys(row, ['id', 'kind', 'pattern', 'note'], path);
    return {
      id: readString(row.id, `${path}.id`, 64),
      kind: readEnum(row.kind, `${path}.kind`, ['rule', 'host', 'user']),
      pattern: readString(row.pattern, `${path}.pattern`, 512),
      note: row.note === undefined || row.note === '' ? '' : readString(row.note, `${path}.note`, 200),
    };
  });
  const thresholdsRaw = assertObject(group.thresholds, 'detection.thresholds');
  assertKnownKeys(thresholdsRaw, ['count', 'windowMs'], 'detection.thresholds');
  const hysteresisRaw = assertObject(group.hysteresis, 'detection.hysteresis');
  assertKnownKeys(hysteresisRaw, ['enabled', 'steps'], 'detection.hysteresis');
  return {
    enabledRulePacks: readStringArray(group.enabledRulePacks, 'detection.enabledRulePacks', { maxItems: 64, maxLength: 128 }),
    severityMapping,
    allowlist,
    thresholds: {
      count: readInteger(thresholdsRaw.count, 'detection.thresholds.count', 1, 1_000_000),
      windowMs: readInteger(thresholdsRaw.windowMs, 'detection.thresholds.windowMs', 1000, 86_400_000),
    },
    hysteresis: {
      enabled: readBoolean(hysteresisRaw.enabled, 'detection.hysteresis.enabled'),
      steps: readInteger(hysteresisRaw.steps, 'detection.hysteresis.steps', 0, 10),
    },
  };
}

function validateResponseGroup(raw) {
  const group = assertObject(raw, 'response');
  assertKnownKeys(group, ['approvalMode', 'actionMatrix', 'cooldownSeconds', 'escalationPolicy', 'executionEnabled'], 'response');
  const matrixRaw = assertObject(group.actionMatrix, 'response.actionMatrix');
  const knownActions = ACTION_CATALOG.map((action) => action.id);
  assertKnownKeys(matrixRaw, knownActions, 'response.actionMatrix');
  const actionMatrix = {};
  for (const action of knownActions) {
    const value = matrixRaw[action];
    actionMatrix[action] = value === undefined
      ? DEFAULT_ACTION_MATRIX[action]
      : readEnum(value, `response.actionMatrix.${action}`, ACTION_DECISIONS);
  }
  // `executionEnabled` is read-only: the value is validated for shape and then the
  // caller compares it with the effective value (settings.js). It is never a knob.
  const executionEnabled = readBoolean(group.executionEnabled, 'response.executionEnabled');
  return {
    approvalMode: readEnum(group.approvalMode, 'response.approvalMode', ['always', 'high-only', 'never']),
    actionMatrix,
    cooldownSeconds: readInteger(group.cooldownSeconds, 'response.cooldownSeconds', 0, 86400),
    escalationPolicy: readEnum(group.escalationPolicy, 'response.escalationPolicy', ['suggest-only', 'manual']),
    executionEnabled,
  };
}

function validateUiGroup(raw) {
  const group = assertObject(raw, 'ui');
  assertKnownKeys(group, ['theme', 'density', 'locale', 'startView', 'autoRefreshMs', 'trayBehavior', 'autostart'], 'ui');
  return {
    theme: readEnum(group.theme, 'ui.theme', ['system', 'dark', 'light']),
    density: readEnum(group.density, 'ui.density', ['comfortable', 'compact']),
    locale: readEnum(group.locale, 'ui.locale', ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']),
    startView: readEnum(group.startView, 'ui.startView', ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings']),
    autoRefreshMs: readInteger(group.autoRefreshMs, 'ui.autoRefreshMs', 0, 3_600_000),
    trayBehavior: readEnum(group.trayBehavior, 'ui.trayBehavior', ['show', 'minimize', 'quit']),
    autostart: readBoolean(group.autostart, 'ui.autostart'),
  };
}

function validateUpdateGroup(raw) {
  const group = assertObject(raw, 'update');
  assertKnownKeys(group, ['autoCheck', 'channel', 'checkIntervalHours', 'lastCheckedAt', 'currentVersion'], 'update');
  return {
    autoCheck: readBoolean(group.autoCheck, 'update.autoCheck'),
    channel: readEnum(group.channel, 'update.channel', ['stable', 'beta']),
    checkIntervalHours: readInteger(group.checkIntervalHours, 'update.checkIntervalHours', 1, 168),
    lastCheckedAt: readStringOrNull(group.lastCheckedAt, 'update.lastCheckedAt', 40),
    currentVersion: readStringOrNull(group.currentVersion, 'update.currentVersion', 32),
  };
}

function validateDiagnosticsGroup(raw) {
  const group = assertObject(raw, 'diagnostics');
  assertKnownKeys(group, ['logLevel', 'healthCheckIntervalMs', 'apiPort', 'exportBundleLastAt'], 'diagnostics');
  let apiPort = null;
  if (group.apiPort !== null) {
    apiPort = readInteger(group.apiPort, 'diagnostics.apiPort', 0, 65535);
  }
  return {
    logLevel: readEnum(group.logLevel, 'diagnostics.logLevel', ['error', 'warn', 'info', 'debug']),
    healthCheckIntervalMs: readInteger(group.healthCheckIntervalMs, 'diagnostics.healthCheckIntervalMs', 1000, 3_600_000),
    apiPort,
    exportBundleLastAt: readStringOrNull(group.exportBundleLastAt, 'diagnostics.exportBundleLastAt', 40),
  };
}

const GROUP_VALIDATORS = Object.freeze({
  models: validateModelsGroup,
  collection: validateCollectionGroup,
  detection: validateDetectionGroup,
  response: validateResponseGroup,
  ui: validateUiGroup,
  update: validateUpdateGroup,
  diagnostics: validateDiagnosticsGroup,
});

// ---------------------------------------------------------------------------
// Merge / path helpers
// ---------------------------------------------------------------------------

/**
 * Deep-merge a partial document over the defaults. Objects merge, arrays replace.
 *
 * Arrays replace because "the providers list I just sent" is the whole list: a
 * merge would make removing a provider impossible.
 *
 * @param {object} base Defaults (not mutated).
 * @param {object} patch Caller document.
 * @returns {object} Merged copy.
 */
function deepMerge(base, patch) {
  const output = cloneJson(base);
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    if (isPlainObject(next) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], next);
    } else {
      output[key] = cloneJson(next);
    }
  }
  return output;
}

/**
 * Read a dotted path from a value.
 *
 * @param {object} document Document.
 * @param {string} path Dotted path.
 * @returns {{found: boolean, value: unknown}} Lookup result.
 */
export function readPath(document, path) {
  let current = document;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

/**
 * Apply the live values of read-only fields onto a document (returns a copy).
 *
 * @param {object} document Settings document.
 * @param {object} readOnly Map of dotted path → live value.
 * @returns {object} Document with read-only fields overlaid.
 */
export function overlayReadOnly(document, readOnly = {}) {
  const output = cloneJson(document);
  for (const [path, value] of Object.entries(readOnly)) {
    const segments = path.split('.');
    let current = output;
    for (const segment of segments.slice(0, -1)) {
      current = current[segment];
    }
    current[segments[segments.length - 1]] = cloneJson(value);
  }
  return output;
}

/**
 * Remove read-only fields before persisting: the server owns them, so a stored
 * `apiPort` would go stale on the next boot.
 *
 * @param {object} document Settings document.
 * @returns {object} Document without read-only fields.
 */
export function stripReadOnly(document) {
  const output = cloneJson(document);
  for (const path of READ_ONLY_PATHS) {
    const segments = path.split('.');
    let current = output;
    for (const segment of segments.slice(0, -1)) {
      if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
        current = null;
        break;
      }
      current = current[segment];
    }
    if (current !== null && isPlainObject(current)) {
      delete current[segments[segments.length - 1]];
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Document validation
// ---------------------------------------------------------------------------

/**
 * Validate (and normalize) a settings document.
 *
 * A partial document is merged over {@link DEFAULT_SETTINGS}: objects merge, arrays
 * replace. Unknown keys are refused before any merge, so a typo cannot silently
 * borrow a default. Read-only fields may be echoed back unchanged; changing one is
 * `SETTINGS_INVALID` with `rule: "read_only"` and the field path.
 *
 * @param {unknown} input Caller document.
 * @param {{readOnly?: Record<string, unknown>}} [options] Effective read-only values.
 * @returns {object} Frozen normalized document.
 * @throws {ConsoleError} `SETTINGS_INVALID` / `PROVIDER_LIMIT` / `PROVIDER_INVALID`.
 */
export function validateSettingsDocument(input, options = {}) {
  assertObject(input, '$');
  assertKnownKeys(input, SETTINGS_GROUPS, '$');

  const readOnly = options.readOnly ?? {};
  for (const path of READ_ONLY_PATHS) {
    const supplied = readPath(input, path);
    if (!supplied.found) {
      continue;
    }
    const effective = readPath(readOnly, path);
    const expected = effective.found ? effective.value : readPath(DEFAULT_SETTINGS, path).value;
    const same = JSON.stringify(supplied.value) === JSON.stringify(expected);
    if (!same) {
      invalid(path, 'read_only');
    }
  }

  const merged = deepMerge(DEFAULT_SETTINGS, input);
  const output = {};
  for (const group of SETTINGS_GROUPS) {
    output[group] = GROUP_VALIDATORS[group](merged[group]);
  }
  // Re-apply the effective read-only values: the merged defaults may be stale for
  // fields the server owns (port, version, last update check).
  return deepFreeze(overlayReadOnly(output, readOnly));
}

// ---------------------------------------------------------------------------
// Machine-readable description (GET /api/v1/settings/schema)
// ---------------------------------------------------------------------------

/**
 * Derive an i18n key from a schema path.
 *
 * Contract §8.3 keys are lower-case dot-separated, so camelCase segments are split
 * (`egressEnabled` → `egress.enabled`). Namespaced under `settings.`.
 *
 * @param {string} path Schema path.
 * @returns {string} `settings.<segments>.label` form.
 */
function labelKeyFor(path) {
  const segments = path.split('.').flatMap((segment) => segment
    .replace(/([a-z0-9])([A-Z])/gu, '$1.$2')
    .toLowerCase()
    .split('.'));
  return `settings.${segments.join('.')}.label`;
}

function hintKeyFor(path) {
  return labelKeyFor(path).replace(/\.label$/u, '.hint');
}

/**
 * Describe one schema item.
 *
 * @param {string} path Document path.
 * @param {string} type One of boolean|integer|number|string|enum|string[]|object[]|secret.
 * @param {unknown} defaultValue Default value (must match DEFAULT_SETTINGS).
 * @param {object} [extra] Additional descriptor fields.
 * @returns {object} Frozen descriptor.
 */
function item(path, type, defaultValue, extra = {}) {
  return Object.freeze({
    path,
    type,
    default: cloneJson(defaultValue),
    appliesAt: extra.appliesAt ?? 'immediate',
    dangerous: extra.dangerous ?? false,
    wired: extra.wired ?? true,
    readOnly: READ_ONLY_SET.has(path) || extra.readOnly === true,
    labelKey: extra.labelKey ?? labelKeyFor(path),
    hintKey: extra.hintKey ?? hintKeyFor(path),
    ...(extra.values === undefined ? {} : { values: [...extra.values] }),
    ...(extra.min === undefined ? {} : { min: extra.min }),
    ...(extra.max === undefined ? {} : { max: extra.max }),
    ...(extra.maxItems === undefined ? {} : { maxItems: extra.maxItems }),
    ...(extra.fields === undefined ? {} : { fields: extra.fields }),
  });
}

/**
 * Item descriptors, grouped exactly as contract §6 lists them.
 *
 * Declared after the defaults so the descriptor can quote the default value; a test
 * asserts every descriptor's `default` equals the value in {@link DEFAULT_SETTINGS},
 * which is what keeps the two tables from drifting.
 */
const GROUP_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'models',
    appliesAt: 'immediate',
    dangerous: false,
    items: Object.freeze([
      item('models.egressEnabled', 'boolean', false, {
        dangerous: true,
        // The contract's one worked key example; kept verbatim.
        labelKey: 'settings.models.egress.label',
        hintKey: 'settings.models.egress.hint',
      }),
      item('models.providers', 'object[]', DEFAULT_SETTINGS.models.providers, {
        dangerous: true,
        maxItems: MAX_PROVIDERS,
        fields: Object.freeze([
          Object.freeze({ name: 'id', type: 'string', required: true, pattern: '^[a-z0-9-]{2,32}$' }),
          Object.freeze({ name: 'kind', type: 'enum', required: true, values: Object.freeze(['openai-compatible', 'deepseek', 'ollama']) }),
          Object.freeze({ name: 'baseUrl', type: 'string', required: true }),
          Object.freeze({ name: 'enabled', type: 'boolean', required: true, default: false }),
          Object.freeze({ name: 'allowLoopback', type: 'boolean', required: true, default: false }),
          Object.freeze({ name: 'dailyInputTokens', type: 'integer', required: true, default: 30000 }),
          Object.freeze({ name: 'dailyOutputTokens', type: 'integer', required: true, default: 6000 }),
          Object.freeze({ name: 'pricing', type: 'secret', required: false, default: null }),
        ]),
      }),
      item('models.models', 'object[]', DEFAULT_SETTINGS.models.models, {
        maxItems: MAX_MODELS,
        fields: Object.freeze([
          Object.freeze({ name: 'id', type: 'string', required: true, pattern: '^[A-Za-z0-9._:-]{1,64}$' }),
          Object.freeze({ name: 'providerId', type: 'string', required: true }),
          Object.freeze({ name: 'tier', type: 'enum', required: true, values: TIERS }),
          Object.freeze({ name: 'maxInputTokens', type: 'integer', required: true }),
          Object.freeze({ name: 'maxOutputTokens', type: 'integer', required: true }),
          Object.freeze({ name: 'costClass', type: 'enum', required: true, values: Object.freeze(['free-local', 'cheap', 'standard', 'expensive']) }),
        ]),
      }),
      item('models.routing.mode', 'enum', 'tiered', { values: ['tiered', 'uniform'] }),
      item('models.routing.uniformModelId', 'string', null),
      item('models.routing.defaultTier', 'enum', 'watch', { values: TIERS }),
      item('models.routing.escalation.enabled', 'boolean', true),
      item('models.routing.escalation.minSeverity', 'enum', 'high', { values: SEVERITIES }),
      item('models.routing.escalation.cooldownSeconds', 'integer', 300, { min: 0, max: 86400 }),
      item('models.routing.escalation.maxEscalationsPerHour', 'integer', 20, { min: 0, max: 10000 }),
      item('models.budget.perAnalysis.inputTokens', 'integer', 12000, { min: 1, max: 1_000_000 }),
      item('models.budget.perAnalysis.outputTokens', 'integer', 2000, { min: 1, max: 1_000_000 }),
      item('models.budget.perAnalysis.maxRequests', 'integer', 3, { min: 1, max: 10 }),
      item('models.budget.daily.inputTokens', 'integer', 30000, { min: 0, max: 1_000_000_000 }),
      item('models.budget.daily.outputTokens', 'integer', 6000, { min: 0, max: 1_000_000_000 }),
      item('models.budget.maxConcurrentAnalyses', 'integer', 2, { min: 1, max: 8 }),
      item('models.agent.engine', 'enum', 'auto', { values: ['auto', 'broker-host', 'harness'] }),
      item('models.agent.maxHistoryMessages', 'integer', 20, { min: 1, max: 100 }),
      // `number` is absent from contract §2.8's type enum; see deviation D3.
      item('models.agent.temperature', 'number', 0.2, { min: 0, max: 2 }),
      item('models.agent.showTokenUsage', 'boolean', true),
    ]),
  }),
  Object.freeze({
    id: 'collection',
    appliesAt: 'next-collection',
    dangerous: false,
    items: Object.freeze([
      item('collection.channels', 'string[]', ['security'], {
        values: ['security', 'system', 'application', 'powershell'],
        maxItems: 4,
      }),
      item('collection.registryPaths', 'string[]', [], { maxItems: 32 }),
      item('collection.services', 'string[]', [], { maxItems: 64 }),
      item('collection.pollIntervalMs', 'integer', 10000, { min: 1000, max: 600000 }),
      item('collection.retention.eventDays', 'integer', 7, { min: 1, max: 3650, appliesAt: 'restart' }),
      item('collection.retention.alertDays', 'integer', 30, { min: 1, max: 3650, appliesAt: 'restart' }),
      item('collection.retention.maxDbBytes', 'integer', 1073741824, { min: 1_048_576, max: 1_000_000_000_000, appliesAt: 'restart' }),
    ]),
  }),
  Object.freeze({
    id: 'detection',
    appliesAt: 'next-collection',
    dangerous: false,
    items: Object.freeze([
      item('detection.enabledRulePacks', 'string[]', [], { maxItems: 64 }),
      item('detection.severityMapping', 'object[]', DEFAULT_SETTINGS.detection.severityMapping),
      item('detection.allowlist', 'object[]', [], {
        maxItems: 200,
        fields: Object.freeze([
          Object.freeze({ name: 'id', type: 'string', required: true }),
          Object.freeze({ name: 'kind', type: 'enum', required: true, values: Object.freeze(['rule', 'host', 'user']) }),
          Object.freeze({ name: 'pattern', type: 'string', required: true }),
          Object.freeze({ name: 'note', type: 'string', required: false, default: '' }),
        ]),
      }),
      item('detection.thresholds.count', 'integer', 5, { min: 1, max: 1_000_000 }),
      item('detection.thresholds.windowMs', 'integer', 60000, { min: 1000, max: 86_400_000 }),
      item('detection.hysteresis.enabled', 'boolean', true),
      item('detection.hysteresis.steps', 'integer', 1, { min: 0, max: 10 }),
    ]),
  }),
  Object.freeze({
    id: 'response',
    appliesAt: 'immediate',
    dangerous: true,
    items: Object.freeze([
      item('response.approvalMode', 'enum', 'high-only', { values: ['always', 'high-only', 'never'] }),
      item('response.actionMatrix', 'object[]', DEFAULT_SETTINGS.response.actionMatrix),
      item('response.cooldownSeconds', 'integer', 300, { min: 0, max: 86400 }),
      item('response.escalationPolicy', 'enum', 'suggest-only', { values: ['suggest-only', 'manual'] }),
      item('response.executionEnabled', 'boolean', false, { readOnly: true, dangerous: true }),
    ]),
  }),
  Object.freeze({
    id: 'ui',
    appliesAt: 'immediate',
    dangerous: false,
    items: Object.freeze([
      item('ui.theme', 'enum', 'system', { values: ['system', 'dark', 'light'] }),
      item('ui.density', 'enum', 'comfortable', { values: ['comfortable', 'compact'] }),
      item('ui.locale', 'enum', 'zh-CN', { values: ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th'] }),
      item('ui.startView', 'enum', 'overview', { values: ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings'] }),
      item('ui.autoRefreshMs', 'integer', 10000, { min: 0, max: 3_600_000 }),
      item('ui.trayBehavior', 'enum', 'show', { values: ['show', 'minimize', 'quit'], wired: false, appliesAt: 'external' }),
      item('ui.autostart', 'boolean', false, { wired: false, appliesAt: 'external' }),
    ]),
  }),
  Object.freeze({
    id: 'update',
    appliesAt: 'restart',
    dangerous: false,
    items: Object.freeze([
      item('update.autoCheck', 'boolean', false, { wired: false, appliesAt: 'external' }),
      item('update.channel', 'enum', 'stable', { values: ['stable', 'beta'] }),
      item('update.checkIntervalHours', 'integer', 24, { min: 1, max: 168 }),
      item('update.lastCheckedAt', 'string', null, { readOnly: true }),
      item('update.currentVersion', 'string', null, { readOnly: true }),
    ]),
  }),
  Object.freeze({
    id: 'diagnostics',
    appliesAt: 'immediate',
    dangerous: false,
    items: Object.freeze([
      item('diagnostics.logLevel', 'enum', 'info', { values: ['error', 'warn', 'info', 'debug'], appliesAt: 'restart' }),
      item('diagnostics.healthCheckIntervalMs', 'integer', 30000, { min: 1000, max: 3_600_000 }),
      item('diagnostics.apiPort', 'integer', null, { readOnly: true }),
      item('diagnostics.exportBundleLastAt', 'string', null, { readOnly: true }),
    ]),
  }),
  Object.freeze({
    id: 'about',
    appliesAt: 'immediate',
    dangerous: false,
    // Read-only group described by the schema and `/status`; never part of the
    // settings file (contract §6 last row).
    injected: true,
    items: Object.freeze([
      item('about.version', 'string', '0.0.0', { readOnly: true, injected: true }),
      item('about.license', 'string', 'Apache-2.0', { readOnly: true, injected: true }),
      item('about.changelog', 'string[]', [], { readOnly: true, injected: true }),
      item('about.privacy', 'string', 'LOCAL_ONLY_NO_TELEMETRY', { readOnly: true, injected: true }),
    ]),
  }),
]);

/** Every descriptor, flattened. Used by tests and by the diff helper. */
export const SETTINGS_ITEMS = Object.freeze(GROUP_DESCRIPTORS.flatMap((group) => group.items));

/**
 * Describe one item for the settings page.
 *
 * @param {object} descriptor Item descriptor.
 * @returns {object} Plain JSON item.
 */
function describeItem(descriptor) {
  const output = {
    path: descriptor.path,
    type: descriptor.type,
    default: descriptor.default,
    appliesAt: descriptor.appliesAt,
    dangerous: descriptor.dangerous,
    wired: descriptor.wired,
    readOnly: descriptor.readOnly,
    labelKey: descriptor.labelKey,
    hintKey: descriptor.hintKey,
  };
  for (const key of ['values', 'min', 'max', 'maxItems', 'fields']) {
    if (descriptor[key] !== undefined) {
      output[key] = descriptor[key];
    }
  }
  return output;
}

/**
 * Build the `GET /api/v1/settings/schema` payload.
 *
 * @returns {object} Machine-readable description.
 */
export function describeSettingsSchema() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    groups: GROUP_DESCRIPTORS.map((group) => ({
      id: group.id,
      appliesAt: group.appliesAt,
      dangerous: group.dangerous,
      ...(group.injected === true ? { injected: true } : {}),
      items: group.items.map(describeItem),
    })),
    actions: [...WIRED_ACTIONS, ...UNWIRED_ACTIONS].map((action) => ({ ...action })),
    actionCatalog: ACTION_CATALOG.map((action) => ({ ...action })),
  };
}

/**
 * Collect the paths whose value differs between two documents.
 *
 * Computed from the leaf descriptors, so "what changed" and "what the schema
 * promises about appliesAt" cannot disagree.
 *
 * @param {object} previous Previous document.
 * @param {object} next Next document.
 * @returns {string[]} Changed descriptor paths.
 */
export function changedPaths(previous, next) {
  const changed = [];
  for (const descriptor of SETTINGS_ITEMS) {
    const before = readPath(previous, descriptor.path);
    const after = readPath(next, descriptor.path);
    if (JSON.stringify(before.value) !== JSON.stringify(after.value)) {
      changed.push(descriptor.path);
    }
  }
  return changed;
}

/**
 * Map changed paths onto `appliedNow` / `restartRequired` / warnings.
 *
 * `appliesAt: "external"` fields are saved but not in effect in 0.0.1; they are
 * reported in `appliedNow` (the write did happen) **and** as a `NOT_WIRED:<path>`
 * warning, so the UI cannot present them as working.
 *
 * @param {string[]} paths Changed paths.
 * @returns {{appliedNow: string[], restartRequired: string[], warnings: string[]}} Classification.
 */
export function classifyChanges(paths) {
  const byPath = new Map(SETTINGS_ITEMS.map((descriptor) => [descriptor.path, descriptor]));
  const appliedNow = [];
  const restartRequired = [];
  const warnings = [];
  for (const path of paths) {
    const descriptor = byPath.get(path);
    if (descriptor === undefined) {
      appliedNow.push(path);
      continue;
    }
    if (descriptor.readOnly) {
      // Read-only fields only reach here when the effective overlay changed (port
      // after a restart), which is not a settings change at all.
      restartRequired.push(path);
      continue;
    }
    if (descriptor.appliesAt === 'restart') {
      restartRequired.push(path);
      continue;
    }
    appliedNow.push(path);
    if (descriptor.wired === false) {
      warnings.push(`NOT_WIRED:${path}`);
    }
  }
  return { appliedNow, restartRequired, warnings };
}
