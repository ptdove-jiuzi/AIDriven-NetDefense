/**
 * model-routing.js — 模型路由判据（ADR-0010 §2.4 / §2.4.1 / §2.5 / §2.6 的实现切片）。
 *
 * 本模块只回答一个问题：**这一次分析该落到哪个 tier 的哪个模型上，或者根本不该发。**
 * 它不读文件、不发网络、不读 `process.env`、不取当前时间（时间由 `signal.at` 传入），
 * 也不做任何预算扣减 —— 预算是准入层的职责（`apps/model-broker/src/policy.js` 的
 * `BROKER_LIMITS`），这里只做判据。两者不能混：ADR-0010 §2.4.1 第 5 条要证明的正是
 * 「关掉分级 ≠ 关掉预算」，如果判据里藏了预算，"关闭分级"就会顺手关掉上限。
 *
 * 契约（B 会话按此对接，签名不得改）：
 *
 *   selectRoute(input)
 *     -> { ok: true, mode, tier, modelId, providerId, escalate, reason, fingerprint, escalatedFrom? }
 *      | { ok: false, code, detail }
 *
 * 返回的 `fingerprint` / `escalatedFrom` 就是 ADR-0010 §2.7 要求记进"每次请求记录"的字段：
 * 判据是它们的唯一权威来源，调用方（daemon → broker 日志）只负责搬运，不负责推导。
 * uniform 模式不产生 `escalatedFrom`（§2.4.1 第 6 条）。
 *
 * 三条不变量：
 *
 * 1. **纯**。同一份输入永远得到同一份输出（含字段顺序）。`recent` 是调用方给的升级历史，
 *    不是"现在几点"；把时钟塞进来会让判据无法复盘。
 * 2. **不抛**。任何畸形输入都退化成 `{ ok: false, code: 'E_MODE_INVALID' }`。判据函数抛异常
 *    会被调用方读成"检查没做完，先放行"，那是最坏的失败方式。
 * 3. **fail-closed 且不偷偷省钱**。tier 缺模型就报 `E_TIER_UNAVAILABLE`，绝不回落到 `watch`
 *    假装通过（那会把"没有强模型"记成"判过了"），也不跳到更贵的 tier（那会把配置错误变成账单）。
 *
 * 判据顺序固定，`code` 取第一个失败项（顺序 = ADR-0010 §2.5 的排列）：
 * 形态校验 → 模式分派 → [uniform] 解析模型 → [tiered] escalation.enabled → severity 门槛
 * → 结构化结论 + evidenceRef → 冷却 → 小时上限 → tier 解析。
 */

/** `routing.mode` 的两个合法取值（ADR-0010 §2.4.1）。 */
export const ROUTING_MODES = Object.freeze(['tiered', 'uniform']);

/** 三个 tier，按能力递增排列；顺序也用于"取最便宜"之外的稳定遍历。 */
export const TIERS = Object.freeze(['watch', 'triage', 'respond']);

/** severity 偏序。ADR-0010 §2.5 只按 `>= high` 与 `critical` 两档升级。 */
export const SEVERITY_RANK = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

/**
 * severity → 目标 tier（ADR-0010 §2.5 第 1 条）。
 *
 * 只有这两个键是契约定义过的。`low` / `medium` 不在此表：当管理员把 `minSeverity`
 * 下调到 `medium`，告警能过门槛，但 ADR 没有为它定义升级目标，因此不升级 ——
 * 见 `ROUTE_REASONS.BELOW_ESCALATION_TIER`。凭"能过门槛"就自己发明一个 tier，
 * 等于把判据写宽，比不升级更危险。
 */
export const ESCALATION_TIER_BY_SEVERITY = Object.freeze({
  high: 'triage',
  critical: 'respond',
});

/** 错误码闭集。契约固定的 8 个，一个不多一个不少。 */
export const ROUTE_CODES = Object.freeze({
  /** 输入形态或取值非法（mode/models/fingerprint/severity/时间戳…）。 */
  MODE_INVALID: 'E_MODE_INVALID',
  /** `uniform` 模式下没有可用的 uniform 模型（未指定，或指定了但不在 models[] 里）。 */
  NO_UNIFORM_MODEL: 'E_NO_UNIFORM_MODEL',
  /** 保留码：本模块当前无触发路径，见本文件末尾「未实现」注释。 */
  MODEL_NOT_FOUND: 'E_MODEL_NOT_FOUND',
  /** 目标 tier 在 `models[]` 里没有任何模型。 */
  TIER_UNAVAILABLE: 'E_TIER_UNAVAILABLE',
  /** severity 未达 `escalation.minSeverity`。 */
  SEVERITY_BELOW: 'E_SEVERITY_BELOW',
  /** `watch` 没有产出结构化结论（不是原始日志）。 */
  NO_STRUCTURED_CONCLUSION: 'E_NO_STRUCTURED_CONCLUSION',
  /** 同一 fingerprint 仍在冷却期内。 */
  COOLDOWN: 'E_COOLDOWN',
  /** 近 1 小时升级次数已达上限。 */
  HOURLY_CAP: 'E_HOURLY_CAP',
});

/** `reason` 取值。契约只固定了 `uniform-mode`，其余为本模块的稳定约定。 */
export const ROUTE_REASONS = Object.freeze({
  /** ADR-0010 §2.4.1：uniform 恒定路由，不做升级判断。 */
  UNIFORM: 'uniform-mode',
  /** 满足 §2.5 全部前置条件，按 severity 升到 triage/respond。 */
  ESCALATED: 'severity-escalation',
  /** 过了 severity 门槛，但 ADR 未为该 severity 定义升级目标，停在 defaultTier。 */
  BELOW_ESCALATION_TIER: 'below-escalation-tier',
  /** `escalation.enabled=false`：显式关闭升级，停在 defaultTier。 */
  ESCALATION_DISABLED: 'escalation-disabled',
});

/** 1 小时窗口（ADR-0010 §2.5 第 4 条）。 */
export const HOUR_MS = 60 * 60 * 1000;

const DEFAULT_TIER = 'watch';
const DETAIL_FINGERPRINT_MAX = 128;
/** `evidenceRef` 的长度上限：它是"指向证据的短指针"，不是证据本身。 */
const EVIDENCE_REF_MAX = 512;
/** 控制字符会破坏单行日志与审计记录，一律拒绝。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `evidenceRef` 的**形态**：非空上限 512、不含控制字符。
 *
 * 空串与纯空白**不算形态错误**——它们的意思是"没有证据"，由 5.3 归到
 * `E_NO_STRUCTURED_CONCLUSION`（`evidence_ref_missing`）。这里判成类型错会把
 * "配置/调用方没给证据"和"给了个非法值"混成一个码，运维读不出来。
 */
function isEvidenceRef(value) {
  if (typeof value !== 'string') return false;
  if (value.length > EVIDENCE_REF_MAX) return false;
  return !CONTROL_CHARS.test(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * 失败结果。
 *
 * `detail` 只放原始标量（不含整个输入对象）：调用方会把它写进审计与日志，
 * 整包回传等于把可能的敏感字段复制到另一个存储里。
 *
 * @param {string} code 闭集内的错误码。
 * @param {object} [detail] 结构化细节，只含标量。
 * @returns {{ ok: false, code: string, detail: object }} 冻结的失败结果。
 */
function deny(code, detail) {
  return Object.freeze({
    ok: false,
    code,
    detail: Object.freeze(detail === undefined ? {} : detail),
  });
}

/**
 * 成功结果。
 *
 * `fingerprint` 与 `escalatedFrom` 是**给日志与用量页用的**（ADR-0010 §2.7）：
 * 判据是这两个字段的唯一权威来源，调用方不该自己再推一遍。
 * uniform 模式**不产生** `escalatedFrom`（§2.4.1 第 6 条）——它是 `extra` 里没有这个键，
 * 不是 `null`：用量页按单一 tier 聚合，一张图里混两套口径就是错的。
 *
 * @param {string} mode `tiered` | `uniform`。
 * @param {string} tier 实际落地的 tier。
 * @param {{ id: string, providerId: string }} model 选中的模型。
 * @param {boolean} escalate 本次是否是升级（uniform 恒 false）。
 * @param {string} reason 稳定的原因串。
 * @param {{ fingerprint: string, escalatedFrom?: string|null }} extra 记录字段。
 * @returns {object} 冻结的成功结果。
 */
function allow(mode, tier, model, escalate, reason, extra) {
  return Object.freeze({
    ok: true,
    mode,
    tier,
    modelId: model.id,
    providerId: model.providerId,
    escalate,
    reason,
    ...extra,
  });
}

/**
 * 校验 `models[]` 的每一项。
 *
 * 校验是**严**的：一条坏记录会让整次判定返回 `E_MODE_INVALID`，而不是被静默跳过。
 * 跳过坏记录会让"配置里写错一个 id"表现为"这个 tier 没有模型"，两种故障混成一个，
 * 现场无法区分是配置写错还是故意留空。
 *
 * `maxInputTokens` / `maxOutputTokens` 是可选的：出现时必须为正整数，缺省不参与
 * 可路由判定（它们属于准入/预算层，见本文件末尾「未实现」）。
 *
 * @param {unknown} value 候选模型数组。
 * @returns {{ ok: true, models: object[] } | { ok: false, code: string, detail: object }} 校验结果。
 */
function validateModels(value) {
  if (!Array.isArray(value)) {
    return deny(ROUTE_CODES.MODE_INVALID, { field: 'models', reason: 'models must be an array' });
  }
  const models = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const field = `models[${index}]`;
    if (!isPlainObject(entry)) {
      return deny(ROUTE_CODES.MODE_INVALID, { field, reason: 'model must be a plain object' });
    }
    if (!isNonEmptyString(entry.id)) {
      return deny(ROUTE_CODES.MODE_INVALID, { field: `${field}.id`, reason: 'model id must be a non-empty string' });
    }
    if (!isNonEmptyString(entry.providerId)) {
      return deny(ROUTE_CODES.MODE_INVALID, {
        field: `${field}.providerId`,
        reason: 'providerId must be a non-empty string',
      });
    }
    if (!TIERS.includes(entry.tier)) {
      return deny(ROUTE_CODES.MODE_INVALID, {
        field: `${field}.tier`,
        value: typeof entry.tier === 'string' ? entry.tier.slice(0, 32) : typeof entry.tier,
        reason: 'tier must be watch, triage or respond',
      });
    }
    for (const key of ['maxInputTokens', 'maxOutputTokens']) {
      if (entry[key] === undefined) continue;
      if (!Number.isInteger(entry[key]) || entry[key] < 1) {
        return deny(ROUTE_CODES.MODE_INVALID, {
          field: `${field}.${key}`,
          reason: 'token ceiling must be a positive integer when present',
        });
      }
    }
    models.push(entry);
  }
  return { ok: true, models };
}

/**
 * 校验 `recent[]`（调用方给的升级历史）。
 *
 * 历史里混进一条坏记录同样整次拒绝：用它算冷却/小时上限时，静默丢弃坏记录等于
 * 把"读不懂"当成"没升级过"，正好是绕过限流的姿势。
 *
 * @param {unknown} value 候选历史数组。
 * @returns {{ ok: true, recent: {fingerprint: string, at: number}[] } | { ok: false, code: string, detail: object }} 校验结果。
 */
function validateRecent(value) {
  if (!Array.isArray(value)) {
    return deny(ROUTE_CODES.MODE_INVALID, { field: 'recent', reason: 'recent must be an array' });
  }
  const recent = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const field = `recent[${index}]`;
    if (!isPlainObject(entry)) {
      return deny(ROUTE_CODES.MODE_INVALID, { field, reason: 'recent entry must be a plain object' });
    }
    if (!isNonEmptyString(entry.fingerprint)) {
      return deny(ROUTE_CODES.MODE_INVALID, { field: `${field}.fingerprint`, reason: 'fingerprint must be a non-empty string' });
    }
    if (!isFiniteNumber(entry.at)) {
      return deny(ROUTE_CODES.MODE_INVALID, { field: `${field}.at`, reason: 'at must be a finite epoch-millisecond number' });
    }
    recent.push({ fingerprint: entry.fingerprint, at: entry.at });
  }
  return { ok: true, recent };
}

/**
 * 校验 tiered 分支才需要的那部分输入。
 *
 * 只在 tiered 分支调用：uniform 按 ADR-0010 §2.4.1 明确"不做升级判断"，
 * 因此 severity / 冷却 / 历史对它是无关字段，缺了也不该拦住一次合法路由。
 * `mode` / `models` / `fingerprint` 仍然两条分支都校验 —— 它们决定"这次能不能发"，
 * 而不只是"怎么升级"。
 *
 * @param {object} signal 信号。
 * @param {object} escalation 升级参数。
 * @param {unknown} recent 升级历史。
 * @returns {{ ok: true, signal: object, escalation: object, recent: object[] } | { ok: false, code: string, detail: object }} 校验结果。
 */
function validateTieredInputs(signal, escalation, recent) {
  if (!isPlainObject(signal)) {
    return deny(ROUTE_CODES.MODE_INVALID, { field: 'signal', reason: 'signal must be a plain object' });
  }
  if (!Object.prototype.hasOwnProperty.call(SEVERITY_RANK, signal.severity)) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'signal.severity',
      value: typeof signal.severity === 'string' ? signal.severity.slice(0, 32) : typeof signal.severity,
      reason: 'severity must be low, medium, high or critical',
    });
  }
  if (!isFiniteNumber(signal.at)) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'signal.at',
      reason: 'at must be a finite epoch-millisecond number; this module never reads the clock',
    });
  }
  if (typeof signal.hasStructuredConclusion !== 'boolean') {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'signal.hasStructuredConclusion',
      reason: 'hasStructuredConclusion must be a boolean',
    });
  }
  // 形态只查"给了的话是不是一个 ref"；"该不该有"由 5.3 判定（缺 ref 属于升级条件不满足，
  // 不是输入写错，两者的错误码必须能区分）。
  if (signal.evidenceRef !== undefined && signal.evidenceRef !== null && !isEvidenceRef(signal.evidenceRef)) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'signal.evidenceRef',
      reason: 'evidenceRef must be 1..512 characters without control characters',
    });
  }
  if (!isPlainObject(escalation)) {
    return deny(ROUTE_CODES.MODE_INVALID, { field: 'escalation', reason: 'escalation must be a plain object' });
  }
  if (typeof escalation.enabled !== 'boolean') {
    return deny(ROUTE_CODES.MODE_INVALID, { field: 'escalation.enabled', reason: 'enabled must be a boolean' });
  }
  if (!Object.prototype.hasOwnProperty.call(SEVERITY_RANK, escalation.minSeverity)) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'escalation.minSeverity',
      value: typeof escalation.minSeverity === 'string' ? escalation.minSeverity.slice(0, 32) : typeof escalation.minSeverity,
      reason: 'minSeverity must be low, medium, high or critical',
    });
  }
  if (!isFiniteNumber(escalation.cooldownSeconds) || escalation.cooldownSeconds < 0) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'escalation.cooldownSeconds',
      reason: 'cooldownSeconds must be a non-negative finite number',
    });
  }
  if (!isNonNegativeInteger(escalation.maxPerHour)) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'escalation.maxPerHour',
      reason: 'maxPerHour must be a non-negative integer',
    });
  }
  const recentResult = validateRecent(recent);
  if (!recentResult.ok) return recentResult;
  return {
    ok: true,
    signal,
    escalation,
    recent: recentResult.recent,
  };
}

/**
 * 在指定 tier 里取第一个模型。
 *
 * 取第一个而不是"取最便宜/最强"：`models[]` 数组顺序由配置决定，判据层不替管理员排序，
 * 否则同一个配置在不同实现里会路由到不同的模型，"确定性"就没了。想换模型就调顺序。
 *
 * @param {object[]} models 已校验的模型数组。
 * @param {string} tier 目标 tier。
 * @returns {object | null} 命中的模型，或 `null`。
 */
function firstModelAtTier(models, tier) {
  for (const model of models) {
    if (model.tier === tier) return model;
  }
  return null;
}

/**
 * 选路。
 *
 * @param {{
 *   mode: 'tiered' | 'uniform',
 *   uniformModelId: string | null,
 *   defaultTier?: 'watch' | 'triage' | 'respond',
 *   models: { id: string, providerId: string, tier: 'watch'|'triage'|'respond', maxInputTokens?: number, maxOutputTokens?: number }[],
 *   signal: { severity: 'low'|'medium'|'high'|'critical', hasStructuredConclusion: boolean,
 *     evidenceRef?: string, fingerprint: string, at: number },
 *   escalation: { enabled: boolean, minSeverity: string, cooldownSeconds: number, maxPerHour: number },
 *   recent: { fingerprint: string, at: number }[]
 * }} input 判定输入。不会被修改。
 * @returns {{ ok: true, mode: string, tier: string, modelId: string, providerId: string, escalate: boolean,
 *   reason: string, fingerprint: string, escalatedFrom?: string|null }
 *   | { ok: false, code: string, detail: object }} 冻结结果。永不抛异常。
 */
export function selectRoute(input) {
  try {
    return route(input);
  } catch (error) {
    // 带 getter 的普通对象能在两次读取之间改值（甚至抛错）。判据必须是输入的纯函数，
    // 所以一律按"无法验证"处理：失败结果，而不是往外扔。
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'input',
      reason: 'unreadable input',
      cause: readErrorName(error),
    });
  }
}

/**
 * 只读地取异常名，避免 catch 块自己再抛。
 *
 * @param {unknown} error 被抛出的值。
 * @returns {string} 异常名，或 `'unknown'`。
 */
function readErrorName(error) {
  try {
    const name = error !== null && typeof error === 'object' ? error.name : undefined;
    return typeof name === 'string' ? name.slice(0, 64) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 判据主体。`selectRoute` 只负责兜异常，其余逻辑都在这里，便于逐条对照 ADR。
 *
 * @param {unknown} input 判定输入。
 * @returns {object} 冻结结果。
 */
function route(input) {
  /* ---- 0. 入口形态 --------------------------------------------------- */
  if (!isPlainObject(input)) {
    return deny(ROUTE_CODES.MODE_INVALID, { field: 'input', reason: 'input must be a plain object' });
  }

  /* ---- 1. mode（ADR-0010 §2.4.1）------------------------------------ */
  // 非两值一律拒绝：不静默回落到 `tiered`。静默回落会让"我开了 uniform"与
  // "实际按 tiered 跑"在账单上表现一致、行为上相反。
  if (!ROUTING_MODES.includes(input.mode)) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'mode',
      value: typeof input.mode === 'string' ? input.mode.slice(0, 32) : typeof input.mode,
      reason: 'mode must be tiered or uniform',
    });
  }
  const mode = input.mode;

  /* ---- 2. models ----------------------------------------------------- */
  const modelsResult = validateModels(input.models);
  if (!modelsResult.ok) return modelsResult;
  const models = modelsResult.models;

  /* ---- 3. signal.fingerprint ----------------------------------------- */
  // 两条分支都要求 fingerprint：它是冷却、小时上限、结果复用（§2.6 同 fingerprint+rulesVersion）
  // 的唯一键。uniform 不用它做升级判断，但"没有指纹的告警"本身就不该进路由。
  if (!isPlainObject(input.signal) || !isNonEmptyString(input.signal.fingerprint)) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'signal.fingerprint',
      reason: 'fingerprint must be a non-empty string',
    });
  }

  /* ---- 4. uniform 分支（ADR-0010 §2.4.1 第 1、6 条）------------------ */
  if (mode === 'uniform') {
    // 4.1 必须显式给出 uniformModelId；缺失即拒绝，不回落 tiered（§2.4.1 第 1 条）。
    if (!isNonEmptyString(input.uniformModelId)) {
      return deny(ROUTE_CODES.NO_UNIFORM_MODEL, {
        field: 'uniformModelId',
        reason: 'uniform mode requires an explicit uniformModelId',
      });
    }
    // 4.2 该模型必须存在于 models[]。按契约固定用 E_NO_UNIFORM_MODEL，不用 E_MODEL_NOT_FOUND。
    let selected = null;
    for (const model of models) {
      if (model.id === input.uniformModelId) {
        selected = model;
        break;
      }
    }
    if (selected === null) {
      return deny(ROUTE_CODES.NO_UNIFORM_MODEL, {
        field: 'uniformModelId',
        uniformModelId: input.uniformModelId.slice(0, 128),
        reason: 'uniformModelId does not exist in models[]',
      });
    }
    // 4.3 忽略 severity 与冷却：任意告警都走同一个模型，escalate 恒为 false，
    //     且不产生 escalatedFrom（§2.4.1 第 6 条）—— 因此这里连 recent 都不读。
    return allow(mode, selected.tier, selected, false, ROUTE_REASONS.UNIFORM, {
      // 不产生 escalatedFrom（§2.4.1 第 6 条）：键不出现，而不是出现一个 null。
      fingerprint: input.signal.fingerprint,
    });
  }

  /* ---- 5. tiered 分支 ------------------------------------------------ */
  const tieredResult = validateTieredInputs(input.signal, input.escalation, input.recent);
  if (!tieredResult.ok) return tieredResult;
  const { signal, escalation, recent } = tieredResult;

  const defaultTier = input.defaultTier === undefined ? DEFAULT_TIER : input.defaultTier;
  if (!TIERS.includes(defaultTier)) {
    return deny(ROUTE_CODES.MODE_INVALID, {
      field: 'defaultTier',
      value: typeof defaultTier === 'string' ? defaultTier.slice(0, 32) : typeof defaultTier,
      reason: 'defaultTier must be watch, triage or respond',
    });
  }

  const stayAt = (reason) => {
    const model = firstModelAtTier(models, defaultTier);
    if (model === null) {
      // 连常态 tier 都没有模型：这不是"不用升级"，是配置缺失，必须报出来。
      return deny(ROUTE_CODES.TIER_UNAVAILABLE, {
        tier: defaultTier,
        severity: signal.severity,
        reason: 'no model declared for the default tier',
      });
    }
    return allow(mode, defaultTier, model, false, reason, {
      fingerprint: signal.fingerprint,
      // 明确写 null：日志里"没有升级"与"不知道有没有升级"是两件事。
      escalatedFrom: null,
    });
  };

  // 5.1 显式关闭升级：停在 defaultTier，不看 severity/冷却/上限。
  //     这正是产品文档 §9「只用本地 7B、respond 留空，系统永远不升级」的落地方式。
  if (escalation.enabled === false) {
    return stayAt(ROUTE_REASONS.ESCALATION_DISABLED);
  }

  // 5.2 §2.5 第 1 条：severity 必须达到门槛。
  if (SEVERITY_RANK[signal.severity] < SEVERITY_RANK[escalation.minSeverity]) {
    return deny(ROUTE_CODES.SEVERITY_BELOW, {
      severity: signal.severity,
      minSeverity: escalation.minSeverity,
    });
  }

  // 5.3 §2.5 第 2 条：watch 必须已产出结构化结论**并附带 evidenceRef**。缺它就不升级 ——
  //     把原始日志整包塞给大模型既贵又把敏感数据整包送出，是 ADR 明令禁止的升级方式。
  //     两个条件同属一条判据，因此共用 E_NO_STRUCTURED_CONCLUSION，靠 detail.reason 区分：
  //     `not_structured`（连结论都没有）与 `evidence_ref_missing`（有结论但拿不出证据）。
  if (signal.hasStructuredConclusion !== true) {
    return deny(ROUTE_CODES.NO_STRUCTURED_CONCLUSION, {
      fingerprint: signal.fingerprint.slice(0, DETAIL_FINGERPRINT_MAX),
      severity: signal.severity,
      reason: 'not_structured',
    });
  }
  if (signal.evidenceRef === undefined || signal.evidenceRef === null || signal.evidenceRef.trim() === '') {
    return deny(ROUTE_CODES.NO_STRUCTURED_CONCLUSION, {
      fingerprint: signal.fingerprint.slice(0, DETAIL_FINGERPRINT_MAX),
      severity: signal.severity,
      reason: 'evidence_ref_missing',
    });
  }

  // 5.4 §2.5 第 3 条：同 fingerprint 冷却。`signal.at - at < cooldownMs` 即视为仍在
  //     冷却内；未来时间戳（差为负）同样算冷却中 —— 时钟偏移不能成为绕过限流的口子。
  if (escalation.cooldownSeconds > 0) {
    const cooldownMs = escalation.cooldownSeconds * 1000;
    let latest = null;
    for (const record of recent) {
      if (record.fingerprint !== signal.fingerprint) continue;
      if (latest === null || record.at > latest) latest = record.at;
    }
    if (latest !== null && signal.at - latest < cooldownMs) {
      return deny(ROUTE_CODES.COOLDOWN, {
        fingerprint: signal.fingerprint.slice(0, DETAIL_FINGERPRINT_MAX),
        lastEscalatedAt: latest,
        cooldownSeconds: escalation.cooldownSeconds,
      });
    }
  }

  // 5.5 §2.5 第 4 条：近 1 小时升级数上限。窗口取半开区间 `(at - 1h, at]`，
  //     恰好 1 小时前的记录已出窗。未来时间戳同样计入（保守）。
  let recentEscalations = 0;
  for (const record of recent) {
    if (signal.at - record.at < HOUR_MS) recentEscalations += 1;
  }
  if (recentEscalations >= escalation.maxPerHour) {
    return deny(ROUTE_CODES.HOURLY_CAP, {
      recentEscalations,
      maxPerHour: escalation.maxPerHour,
    });
  }

  // 5.6 §2.5 第 1 条的映射：high → triage，critical → respond。
  //     其余 severity（仅在 minSeverity 被下调到 low/medium 时可能出现）没有定义过的
  //     升级目标：不升级、回 defaultTier，并给出可区分的原因串，而不是猜一个 tier。
  const escalationTier = ESCALATION_TIER_BY_SEVERITY[signal.severity];
  if (escalationTier === undefined) {
    return stayAt(ROUTE_REASONS.BELOW_ESCALATION_TIER);
  }

  // 5.7 目标 tier 必须真有模型。缺了就报 E_TIER_UNAVAILABLE：不回落 watch（那会把
  //     "没有强模型可用"记成"已判过"），也不跳到更贵的 tier（那会把配置错误变成账单）。
  const model = firstModelAtTier(models, escalationTier);
  if (model === null) {
    return deny(ROUTE_CODES.TIER_UNAVAILABLE, {
      tier: escalationTier,
      severity: signal.severity,
      reason: 'no model declared for the escalation tier',
    });
  }
  return allow(mode, escalationTier, model, true, ROUTE_REASONS.ESCALATED, {
    fingerprint: signal.fingerprint,
    escalatedFrom: defaultTier,
  });
}

/**
 * 本模块的已知边界（写进代码，避免下一个人当成 bug 再实现一遍）：
 *
 * 1. **不校验 token 上限是否够用**。`maxInputTokens` / `maxOutputTokens` 只做形态校验，
 *    不参与可路由判定。按 tier 的 4k/8k/12k 约束属于准入层（ADR-0010 §2.4 表格、
 *    §2.6「单分析 12k 输入 / 2k 输出」），在本模块里再判一次会出现两套口径。
 * 2. **不做预算判定**。§2.5 第 5 条「目标 provider 日预算仍有余额」需要预算快照，
 *    属 `apps/model-broker` 的 `budget-port.js`；本模块拿不到也不该拿。
 * 3. **不做结果复用**。§2.6「同 fingerprint + rulesVersion 命中缓存直接返回」是缓存层，
 *    它只需要 fingerprint，不需要选路。
 * 4. **`E_MODEL_NOT_FOUND` 当前无触发路径**。契约把"uniform 模型不存在"固定归到
 *    `E_NO_UNIFORM_MODEL`，tiered 分支按 tier 而非 id 选模型，因此这个码保留未用。
 *    不为了让码表"看起来都在用"而发明一条判据。
 * 5. **`evidenceRef` 只校验形态与存在性，不打开它**。ADR §2.5 第 2 条要求升级请求附带
 *    evidence bundle，judge 层只需确认"引用存在且可写进单行日志"；真正的证据读取、摘要化、
 *    "payload 不含原始事件全文"由组装升级请求的那一层保证（本模块不碰内容）。
 */
export const MODEL_ROUTING_NOTES = Object.freeze([
  'token ceilings are validated for shape only; per-tier 4k/8k/12k belongs to the admission layer',
  'provider daily budget is not evaluated here (needs a budget snapshot owned by apps/model-broker)',
  'result reuse by fingerprint + rulesVersion is a cache concern, not a routing decision',
  'E_MODEL_NOT_FOUND is reserved and currently unreachable by contract',
  'evidenceRef is validated for shape and presence only; escalation payload assembly owns the bundle',
]);
