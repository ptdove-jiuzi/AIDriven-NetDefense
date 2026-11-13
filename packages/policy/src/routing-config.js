/**
 * 配置面 → 判据面 的**唯一**映射（P1-5）。
 *
 * 审查事实（逐字段 grep 的结果）：
 *
 * | 字段 | 出现在 |
 * |---|---|
 * | `maxPerHour` | `model-routing.js`、其测试 |
 * | `maxEscalationsPerHour` | **仅** `deploy/config/model-routing.example.json` |
 * | `requireStructuredConclusion` | **仅** 示例配置（判据用 `signal.hasStructuredConclusion`，且不可关闭） |
 * | `sendRawEvents` | **仅** 示例配置，无任何消费者 |
 *
 * 直传示例配置 → `E_MODE_INVALID`；装载器"猜一个默认值补上" → 管理员配的 20 次/小时静默变成别的数；
 * `requireStructuredConclusion: false` → 看起来能关掉证据要求，实际关不掉。三种都不可接受。
 *
 * 因此本模块做三件事，缺一不可：
 *
 * 1. **别名归一**：`maxEscalationsPerHour` → `maxPerHour`（两种拼法同时出现视为歧义，直接拒绝）；
 * 2. **不可实现的开关一律报错**：关证据要求、一次分析多次升级、发原始事件——不是"接受后忽略"；
 * 3. **未知字段一律报错**：拼错一个键就是配置事故，不能静默失效（与 P1-1 同一条规则）。
 *
 * 本模块只吃 `routing` 与 `models` 两段：`providers`/`budget`/`cache` 属于别的装载器，
 * 这里不读也不改，避免"一个函数什么都管"。
 */

import { ROUTE_CODES, ROUTING_MODES, SEVERITY_RANK, TIERS } from './model-routing.js';

/** 映射层自己的错误码（与判据码分开：前者是配置事故，后者是路由结论）。 */
export const ROUTING_CONFIG_CODES = Object.freeze({
  /** 配置写错/写歧义（未知字段、类型不对、两种拼法并存）。 */
  CONFIG_INVALID: 'E_CONFIG_INVALID',
  /** 配置里有一个"实现不了"的开关（关证据要求、多次升级、原始事件）。 */
  CONFIG_UNSUPPORTED: 'E_CONFIG_UNSUPPORTED',
});

/** `routing` 段允许出现的键。`_modeComment` 是示例配置的注释字段，允许存在但不参与判定。 */
const ROUTING_KEYS = new Set(['_modeComment', 'mode', 'uniformModelId', 'defaultTier', 'escalation']);

/** `routing.escalation` 段允许出现的键。 */
const ESCALATION_KEYS = new Set([
  'enabled',
  'minSeverity',
  'requireStructuredConclusion',
  'cooldownSeconds',
  'maxPerHour',
  'maxEscalationsPerHour',
  'maxEscalationsPerAnalysis',
  'sendRawEvents',
]);

/** 模型条目允许出现的键。`costClass` 是展示字段（用量页配色），不进判据。 */
const MODEL_KEYS = new Set(['id', 'providerId', 'tier', 'maxInputTokens', 'maxOutputTokens', 'costClass']);

/** ADR-0010 §2.5 明写的默认值（不是猜的）：冷却 5 分钟、小时上限 20 次。 */
const DEFAULT_COOLDOWN_SECONDS = 300;
const DEFAULT_MAX_PER_HOUR = 20;

/** ADR-0010 §2.4：「默认路由 = watch」。 */
const DEFAULT_TIER = 'watch';

/** 一次分析只允许一次升级（ADR §2.5 反例清单）。 */
const MAX_ESCALATIONS_PER_ANALYSIS = 1;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function deny(code, detail) {
  return Object.freeze({ ok: false, code, detail: Object.freeze(detail) });
}

function invalid(field, reason) {
  return deny(ROUTING_CONFIG_CODES.CONFIG_INVALID, { field, reason });
}

function unsupported(field, reason) {
  return deny(ROUTING_CONFIG_CODES.CONFIG_UNSUPPORTED, { field, reason });
}

/** 把 `models[]` 收成契约字段；未知键报错而不是略过。 */
function normalizeModels(value) {
  if (!Array.isArray(value)) {
    return invalid('models', 'models must be an array');
  }
  const models = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const field = `models[${index}]`;
    if (!isPlainObject(entry)) return invalid(field, 'model must be a plain object');
    for (const key of Object.keys(entry)) {
      if (!MODEL_KEYS.has(key)) return invalid(`${field}.${key}`, 'unknown model field');
    }
    if (!isNonEmptyString(entry.id)) return invalid(`${field}.id`, 'model id must be a non-empty string');
    if (!isNonEmptyString(entry.providerId)) {
      return invalid(`${field}.providerId`, 'providerId must be a non-empty string');
    }
    if (!TIERS.includes(entry.tier)) return invalid(`${field}.tier`, 'tier must be watch, triage or respond');
    const model = { id: entry.id, providerId: entry.providerId, tier: entry.tier };
    for (const key of ['maxInputTokens', 'maxOutputTokens']) {
      if (entry[key] === undefined) continue;
      if (!Number.isInteger(entry[key]) || entry[key] < 1) {
        return invalid(`${field}.${key}`, 'token ceiling must be a positive integer when present');
      }
      model[key] = entry[key];
    }
    models.push(Object.freeze(model));
  }
  return Object.freeze({ ok: true, models: Object.freeze(models) });
}

/** 归一 `routing.escalation`。别名冲突、不可实现开关、未知键都在这里失败。 */
function normalizeEscalation(value) {
  if (!isPlainObject(value)) return invalid('routing.escalation', 'escalation must be a plain object');
  for (const key of Object.keys(value)) {
    if (!ESCALATION_KEYS.has(key)) return invalid(`routing.escalation.${key}`, 'unknown escalation field');
  }
  if (typeof value.enabled !== 'boolean') {
    return invalid('routing.escalation.enabled', 'enabled must be a boolean');
  }
  if (!Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value.minSeverity)) {
    return invalid('routing.escalation.minSeverity', 'minSeverity must be low, medium, high or critical');
  }
  // 证据要求不可关闭：ADR §2.5 第 2 条是升级的必要条件，不是可选项。
  // 这里接受 `undefined` 与 `true`，其余任何取值（含 false、'true'、0）都当"想关掉"处理。
  if (value.requireStructuredConclusion !== undefined && value.requireStructuredConclusion !== true) {
    return unsupported(
      'routing.escalation.requireStructuredConclusion',
      'the evidence requirement cannot be disabled (ADR-0010 §2.5 第 2 条)',
    );
  }
  if (value.sendRawEvents !== undefined && value.sendRawEvents !== false) {
    return unsupported(
      'routing.escalation.sendRawEvents',
      'raw events must never be sent on the escalation path (ADR-0010 §2.5 反例)',
    );
  }
  if (value.maxEscalationsPerAnalysis !== undefined && value.maxEscalationsPerAnalysis !== MAX_ESCALATIONS_PER_ANALYSIS) {
    return unsupported(
      'routing.escalation.maxEscalationsPerAnalysis',
      'at most one escalation per analysis is allowed; use escalation.enabled=false to disable escalation',
    );
  }
  // 两种拼法同时出现 → 无法判定管理员想要哪一个，拒绝而不是挑一个。
  if (value.maxEscalationsPerHour !== undefined && value.maxPerHour !== undefined) {
    return invalid('routing.escalation.maxPerHour', 'maxPerHour and maxEscalationsPerHour are aliases; keep only one');
  }
  const rawMaxPerHour = value.maxEscalationsPerHour ?? value.maxPerHour;
  const maxPerHour = rawMaxPerHour === undefined ? DEFAULT_MAX_PER_HOUR : rawMaxPerHour;
  if (!Number.isInteger(maxPerHour) || maxPerHour < 0) {
    return invalid(
      value.maxEscalationsPerHour === undefined ? 'routing.escalation.maxPerHour' : 'routing.escalation.maxEscalationsPerHour',
      'hourly escalation cap must be a non-negative integer',
    );
  }
  const cooldownSeconds = value.cooldownSeconds === undefined ? DEFAULT_COOLDOWN_SECONDS : value.cooldownSeconds;
  if (typeof cooldownSeconds !== 'number' || !Number.isFinite(cooldownSeconds) || cooldownSeconds < 0) {
    return invalid('routing.escalation.cooldownSeconds', 'cooldownSeconds must be a non-negative finite number');
  }
  return Object.freeze({
    ok: true,
    escalation: Object.freeze({
      enabled: value.enabled,
      minSeverity: value.minSeverity,
      cooldownSeconds,
      maxPerHour,
    }),
  });
}

/**
 * 把配置文档归一成 `selectRoute` 的入参（不含 `signal` / `recent`：那两个属于运行期）。
 *
 * @param {unknown} document `{ routing, models }`（示例配置的整份文档也可以直接传入）。
 * @returns {{ ok: true, input: object } | { ok: false, code: string, detail: object }} 冻结结果，永不抛。
 */
export function normalizeRoutingInput(document) {
  if (!isPlainObject(document)) return invalid('config', 'configuration document must be a plain object');
  const routing = document.routing;
  if (!isPlainObject(routing)) return invalid('routing', 'routing must be a plain object');
  for (const key of Object.keys(routing)) {
    if (!ROUTING_KEYS.has(key)) return invalid(`routing.${key}`, 'unknown routing field');
  }
  if (!ROUTING_MODES.includes(routing.mode)) {
    return invalid('routing.mode', 'mode must be tiered or uniform');
  }
  const defaultTier = routing.defaultTier === undefined ? DEFAULT_TIER : routing.defaultTier;
  if (!TIERS.includes(defaultTier)) return invalid('routing.defaultTier', 'defaultTier must be watch, triage or respond');

  let uniformModelId = routing.uniformModelId ?? null;
  if (uniformModelId !== null && typeof uniformModelId !== 'string') {
    return invalid('routing.uniformModelId', 'uniformModelId must be a non-empty string or null');
  }
  if (typeof uniformModelId === 'string' && uniformModelId.trim() === '') {
    // uniform 模式下空串就是"没给"——按 §4-12 归到 E_NO_UNIFORM_MODEL，而不是类型错。
    if (routing.mode !== 'uniform') {
      return invalid('routing.uniformModelId', 'uniformModelId must be a non-empty string or null');
    }
    uniformModelId = null;
  } else if (typeof uniformModelId === 'string') {
    uniformModelId = uniformModelId.trim();
  }

  const modelsResult = normalizeModels(document.models);
  if (!modelsResult.ok) return modelsResult;
  const models = modelsResult.models;

  const escalationResult = normalizeEscalation(routing.escalation);
  if (!escalationResult.ok) return escalationResult;

  // R5-004：空 models[] 是不可执行的配置——装载成功、运行期却必然 E_TIER_UNAVAILABLE
  // （"配置保存成功、每次分析都失败"）。ADR §4-12 的口径是保存被拒绝，不是运行期才报。
  if (models.length === 0) {
    return invalid('models', 'models must declare at least one model');
  }
  // R5-004：tiered 模式下 defaultTier 必须有模型，否则常态路径（不升级）也在运行期必然失败。
  // uniform 模式不读 defaultTier（走 uniformModelId），因此只对 tiered 判。
  if (routing.mode === 'tiered' && !models.some((model) => model.tier === defaultTier)) {
    return deny(ROUTING_CONFIG_CODES.CONFIG_INVALID, {
      field: 'routing.defaultTier',
      tier: defaultTier,
      reason: 'defaultTier has no model in models[]',
    });
  }

  // uniform 的校验必须在装载期完成（ADR §4-12「保存被拒绝」），不能只在运行期返回
  // E_NO_UNIFORM_MODEL——那时配置已经存进去了。
  if (routing.mode === 'uniform') {
    if (uniformModelId === null) {
      return deny(ROUTE_CODES.NO_UNIFORM_MODEL, {
        field: 'routing.uniformModelId',
        reason: 'uniform mode requires an explicit uniformModelId',
      });
    }
    if (!models.some((model) => model.id === uniformModelId)) {
      return deny(ROUTE_CODES.NO_UNIFORM_MODEL, {
        field: 'routing.uniformModelId',
        uniformModelId,
        reason: 'uniformModelId does not exist in models[]',
      });
    }
  }

  return Object.freeze({
    ok: true,
    input: Object.freeze({
      mode: routing.mode,
      uniformModelId,
      defaultTier,
      models,
      escalation: escalationResult.escalation,
    }),
  });
}
