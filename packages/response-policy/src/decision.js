/**
 * decision.js — the pure decision function.
 *
 * `evaluateResponsePolicy(request)` returns one of:
 *
 *   allow            the gate permits the caller to continue
 *   needs_approval   a human approval is mandatory and none was supplied
 *   deny             anything else, with a stable reason code
 *
 * Three invariants make this usable as a security boundary:
 *
 * 1. **Pure.** No clock, no filesystem, no environment, no randomness. `now` is a
 *    caller-supplied timestamp; two identical requests always produce identical
 *    results, including field order and digest values.
 * 2. **Fail-closed.** Every missing or unverifiable input is a denial, not a
 *    skipped check: absent `actorRoles` or `epoch` denies instead of "unchecked",
 *    a malformed `replay` view denies instead of reading as "nothing spent", and a
 *    human-approvable action without its `proposal` denies because the approval's
 *    only action binding lives in `proposal_digest`.
 * 3. **Never an authorisation.** `authorizesExecution` is a constant `false`.
 *    Passing this gate — even with a structurally perfect `ExecutionGrant` — is
 *    *not* permission for any helper to act. Design §10.2 requires the helper to
 *    verify the signature, the action allowlist, parameters, target, time, epoch
 *    and nonce independently, and the result says so explicitly in
 *    `helperVerificationRequired`.
 *
 * Check order is fixed and documented below, because the *first* failure becomes
 * `reasonCode`. Order: environment → action → OS → target → parameters → risk →
 * role → epoch → proposal → replay view → approval → grant.
 */

import {
  canonicalDigest,
  validateApproval,
  validateExecutionGrant,
  validateResponseProposal,
} from '@aegisharness/contracts';
import {
  CURRENT_POLICY_VERSION,
  FORBIDDEN_ACTIONS,
  RISK_RANK,
  ROLE_CAPABILITIES,
  SUPPORTED_POLICY_VERSIONS,
  actionDigest,
  capabilityForRole,
  getAction,
  isForbiddenAction,
  isSupportedOs,
  osSupportFor,
} from './catalog.js';
import { isPolicyError, policyFail } from './errors.js';
import { normalizeParameters } from './parameters.js';
import { OUTCOMES, REASON_CODES, REASON_OUTCOMES, isReasonCode } from './reasons.js';
import { ensureNormalizedTarget } from './target.js';
import { parseUtcMs } from './time.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_ROLES = 5;

const HELPER_BASELINE = Object.freeze([
  'helper_action_allowlist',
  'helper_target_rebinding',
  'helper_recovery_manifest',
]);

const HELPER_GRANT = Object.freeze([
  'grant_signature',
  'grant_nonce_single_use',
  'grant_epoch',
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * 找出请求里第一个访问器属性（getter/setter），没有则返回 `null`。
 *
 * 只读判定要能被称为"纯函数"，前提是同一份输入每次读出同样的值。带 getter 的**普通对象**
 * 能通过 `isPlainObject`，却能在两次读取之间改值——判定读到唯一受支持的策略版本、而审计
 * 记下另一个动作，这类自相矛盾的行会直接破坏审批绑定的可信度。
 *
 * 递归一层：`proposal` / `approval` / `grant` 是合同 DTO，它们的字段也会被读多次。
 * 只用数据描述符读取（`Object.getOwnPropertyDescriptor`），不触发 getter，任何异常都按
 * "无法证明干净"处理，返回当前路径。
 *
 * @param {unknown} value 待检查的值。
 * @param {number} depth 还要往下走几层。
 * @param {string} [prefix] 路径前缀。
 * @returns {string|null} 访问器属性的路径，或 `null`。
 */
function findAccessorProperty(value, depth, prefix = '') {
  if (value === null || typeof value !== 'object') return null;
  let names;
  try {
    names = Object.getOwnPropertyNames(value);
  } catch {
    return prefix.length > 0 ? prefix : 'request';
  }
  for (const name of names) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
    } catch {
      return prefix.length > 0 ? prefix : 'request';
    }
    if (descriptor === undefined) continue;
    const path = prefix.length === 0 ? name : `${prefix}.${name}`;
    if ('get' in descriptor || 'set' in descriptor) {
      return path;
    }
    if (depth > 0 && !Array.isArray(value)) {
      const nested = findAccessorProperty(descriptor.value, depth - 1, path);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Capability check.
 *
 * Roles are capability sets, not a total order: `admin` can view, analyse and
 * manage local authorisation, but it is **not** a responder. Design §10.2 keeps
 * `aegis-admins` and `aegis-responders` separate and explicitly says installing
 * the product must not put every administrator into the responder group; a rank
 * model would undo that.
 *
 * @param {readonly string[]} roles Role snapshot.
 * @param {string} required Required action role (`viewer`, `responder`, …).
 * @returns {boolean} True when one role carries the needed capability.
 */
export function roleSatisfies(roles, required) {
  if (!Array.isArray(roles) || roles.length === 0) return false;
  const capability = capabilityForRole(required);
  if (capability === null) return false;
  return roles.some((role) => {
    const capabilities = ROLE_CAPABILITIES[role];
    return Array.isArray(capabilities) && capabilities.includes(capability);
  });
}

/**
 * Validate a role snapshot: 1..5 unique declared roles.
 *
 * @param {unknown} roles Candidate.
 * @returns {readonly string[] | null} Normalised roles, or `null` when malformed.
 */
function readRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > MAX_ROLES) return null;
  const seen = new Set();
  for (const role of roles) {
    if (typeof role !== 'string' || !Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role)) return null;
    if (seen.has(role)) return null;
    seen.add(role);
  }
  return Object.freeze([...roles]);
}

/**
 * Read a contracts record `{ schemaVersion, digest, value }` or a bare DTO.
 *
 * Record form is verified against `canonicalDigest(value)`: a caller cannot hand
 * us a record whose declared digest disagrees with its content, because that is
 * the same digest the approval and grant bind to.
 *
 * @param {unknown} input Record or DTO.
 * @param {string} code Reason code raised on a malformed record envelope.
 * @param {string} label Field name for error paths.
 * @returns {{ dto: unknown, envelopeDigest: string | null }} Unwrapped parts.
 */
function readContractEnvelope(input, code, label) {
  if (!isPlainObject(input)) {
    policyFail(code, `$.${label}`, `${label} must be an object`);
  }
  const keys = Object.getOwnPropertyNames(input);
  if (!keys.includes('value')) {
    return { dto: input, envelopeDigest: null };
  }
  if (keys.length !== 3 || !keys.includes('schemaVersion') || !keys.includes('digest')) {
    policyFail(code, `$.${label}`, `${label} record must carry exactly schemaVersion, digest and value`);
  }
  if (!isPlainObject(input.value)) {
    policyFail(code, `$.${label}.value`, `${label}.value must be a contract DTO`);
  }
  if (typeof input.digest !== 'string' || !HEX64.test(input.digest)) {
    policyFail(code, `$.${label}.digest`, `${label}.digest must be a 64-hex digest`);
  }
  if (canonicalDigest(input.value) !== input.digest) {
    policyFail(code, `$.${label}.digest`, `${label}.digest does not match its content`);
  }
  return { dto: input.value, envelopeDigest: input.digest };
}

/**
 * Run a contracts validator, mapping a structural failure to a policy reason.
 *
 * Structural success is **not** authorisation: the caller still has to pass every
 * binding, time, role, epoch and replay check below, and the final result still
 * reports `authorizesExecution === false`.
 *
 * @param {unknown} input Record or DTO.
 * @param {string} code Reason code raised when the structure is invalid.
 * @param {string} label Field name for error paths.
 * @param {(value: unknown) => {digest: string, value: object}} validator Contracts validator.
 * @returns {{ digest: string, value: object }} Validated record.
 */
function validateStructurally(input, code, label, validator) {
  const { dto, envelopeDigest } = readContractEnvelope(input, code, label);
  let record;
  try {
    record = validator(dto);
  } catch (error) {
    policyFail(code, `$.${label}`, `${label} failed structural validation`, {
      contractCode: typeof error?.code === 'string' ? error.code : 'CONTRACT_INVALID',
    });
  }
  if (envelopeDigest !== null && envelopeDigest !== record.digest) {
    policyFail(code, `$.${label}.digest`, `${label}.digest disagrees with the re-validated DTO`);
  }
  return record;
}

/**
 * Collect the caller-owned replay view.
 *
 * A missing view is legitimate — it means the caller has no spent-nonce state, and
 * the durable check belongs to the daemon transaction anyway. A **malformed** view
 * is not: silently reading it as empty would switch replay protection off while
 * the audit trail still says every check ran. Malformed therefore denies.
 *
 * @param {unknown} replay Candidate `{ approvalNonces, grantNonces, executionIds }`.
 * @returns {{ approvalNonces: Set<string>, grantNonces: Set<string>, executionIds: Set<string> }} Sets.
 * @throws {import('./errors.js').PolicyError} When the view is present but not a string array per field.
 */
function readReplayView(replay) {
  const sets = { approvalNonces: new Set(), grantNonces: new Set(), executionIds: new Set() };
  if (replay === undefined || replay === null) return sets;
  if (!isPlainObject(replay)) {
    policyFail(REASON_CODES.DENY_INPUT_INVALID, '$.replay', 'replay must be a plain object', {
      field: 'replay',
    });
  }
  for (const field of ['approvalNonces', 'grantNonces', 'executionIds']) {
    const value = replay[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      policyFail(REASON_CODES.DENY_INPUT_INVALID, `$.replay.${field}`, `replay.${field} must be an array`, {
        field,
      });
    }
    for (const item of value) {
      if (typeof item !== 'string' || item.length === 0) {
        policyFail(
          REASON_CODES.DENY_INPUT_INVALID,
          `$.replay.${field}`,
          `replay.${field} must contain non-empty strings`,
          { field },
        );
      }
      sets[field].add(item);
    }
  }
  const extra = Object.keys(replay).filter((key) => !['approvalNonces', 'grantNonces', 'executionIds'].includes(key));
  if (extra.length > 0) {
    policyFail(REASON_CODES.DENY_INPUT_INVALID, `$.replay.${extra[0]}`, 'replay carries an undeclared field', {
      field: extra[0],
      key: extra[0],
    });
  }
  return sets;
}

/**
 * Fields a request may carry. Anything else denies.
 *
 * A typo such as `proposol` would otherwise be silently ignored, which is exactly
 * how `DENY_PROPOSAL_REQUIRED` could be bypassed by "sending it under the wrong
 * key". Closed request shape makes the typo a denial instead.
 */
const REQUEST_KEYS = Object.freeze([
  'os',
  'policyVersion',
  'now',
  'actionId',
  'target',
  'parameters',
  'declaredRisk',
  'actorRoles',
  'epoch',
  'proposal',
  'approval',
  'grant',
  'replay',
]);

/**
 * Last-resort decision used when something outside the audited checks throws.
 *
 * Same shape as a normal decision so callers never see two different objects, and
 * always a deny: an exception means "could not verify", which must never look
 * like "verified and allowed".
 *
 * @param {string} code Reason code.
 * @param {object | null} detail Structured detail.
 * @returns {object} Frozen denial.
 */
function fatalDecision(code, detail) {
  return deepFreeze({
    outcome: OUTCOMES.DENY,
    reasonCode: code,
    detail,
    actionId: null,
    risk: null,
    requiredRole: null,
    requiresApproval: null,
    policyVersion: CURRENT_POLICY_VERSION,
    evaluatedAt: null,
    targetDigest: null,
    parametersDigest: null,
    actionDigest: null,
    authorizesExecution: false,
    authorizationBoundary: 'policy_gate_only_not_an_execution_authorization',
    structuralValidationOnly: true,
    helperVerificationRequired: Object.freeze([...HELPER_BASELINE]),
    notes: Object.freeze([]),
  });
}

/**
 * Evaluate one response request.
 *
 * @param {object} request Decision input; see {@link decide}.
 * @param {{ policyRoots?: Record<string, readonly string[]> }} [options] Deployment
 *   configuration, deliberately a **separate argument**: `policyRoots` must come
 *   from the installer/daemon configuration, never from the request that is being
 *   judged. A request that tries to carry `policyRoots` is rejected as an
 *   undeclared field.
 * @returns {object} Frozen decision. Never throws.
 */
export function evaluateResponsePolicy(request, options) {
  try {
    return decide(request, options);
  } catch (error) {
    return fatalFromThrown(error);
  }
}

/**
 * True only for a declared reason code that means "deny".
 *
 * Checking `isReasonCode` alone is not enough: a caller-forged `PolicyError` could
 * quote `ALLOWED` or `APPROVAL_REQUIRED`, producing a deny decision whose
 * `reasonCode` says "allow" — `outcomeFor(code)` would then disagree with
 * `outcome`, and `decisionSummary` would write `reason_code: "ALLOWED"` into the
 * audit row. A denial may only carry a denial code.
 *
 * @param {unknown} code Candidate code.
 * @returns {boolean} True when `code` is a declared deny code.
 */
function isDenyCode(code) {
  return isReasonCode(code) && REASON_OUTCOMES[code] === OUTCOMES.DENY;
}

/**
 * Turn an arbitrary thrown value into a decision without touching it unsafely.
 *
 * The catch block is itself part of the attack surface: a caller can throw a
 * crafted object whose `name` or `code` getter throws, or whose `detail` is
 * cyclic, and a naive `error.name` / `deepFreeze(error.detail)` would then throw
 * *or* let the request dictate the audited `reasonCode`. So the thrown value is
 * only read through data descriptors, the code must be one of the declared reason
 * codes, and the detail is flattened to bounded primitives.
 *
 * @param {unknown} error Whatever was thrown.
 * @returns {object} Frozen denial. Never throws.
 */
function fatalFromThrown(error) {
  let code = REASON_CODES.DENY_INPUT_INVALID;
  let detail = null;
  try {
    if (isPolicyError(error) && typeof error.code === 'string' && isDenyCode(error.code)) {
      code = error.code;
      detail = sanitizeDetail(error.detail);
    } else {
      detail = { cause: readDataProperty(error, 'name', 64) ?? 'unknown' };
    }
  } catch {
    code = REASON_CODES.DENY_INPUT_INVALID;
    detail = null;
  }
  return fatalDecision(code, detail);
}

/**
 * Turn a caught value into `{ code, detail }` for a per-stage denial.
 *
 * A stage catch keeps the context already accumulated (action, risk, digests), so
 * it stays inside `decide` — but it must not trust the thrown value either: a
 * forged `PolicyError` thrown from a caller getter would otherwise be able to
 * choose the audited `reasonCode` or smuggle a cyclic `detail`.
 *
 * @param {unknown} error Whatever was thrown.
 * @param {string} fallbackCode Reason code to use when the error is not ours.
 * @returns {{ code: string, detail: object | null }} Sanitised parts.
 */
function denialFrom(error, fallbackCode, fallbackDetail = null) {
  if (!isPolicyError(error) || typeof error.code !== 'string' || !isDenyCode(error.code)) {
    return { code: fallbackCode, detail: fallbackDetail };
  }
  return { code: error.code, detail: sanitizeDetail(error.detail) };
}

/**
 * Read one own data property without invoking getters.
 *
 * @param {unknown} value Candidate object.
 * @param {string} key Property name.
 * @param {number} maxLength Maximum string length kept.
 * @returns {string | null} The value, or `null` when absent/not a string.
 */
function readDataProperty(value, key, maxLength) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  const raw = descriptor.value;
  return typeof raw === 'string' ? raw.slice(0, maxLength) : null;
}

/**
 * Flatten a detail object to bounded primitives.
 *
 * Only data properties are read (a getter would run attacker code), arrays are
 * reduced to a bounded list of strings (which also breaks cycles), and the result
 * is capped so a hostile payload cannot inflate the audit row.
 *
 * @param {unknown} value Candidate detail.
 * @returns {object | null} Frozen flat detail, or `null`.
 */
function sanitizeDetail(value) {
  try {
    if (value === null || typeof value !== 'object') return null;
    const out = {};
    let keys = 0;
    for (const key of Object.getOwnPropertyNames(value)) {
      if (keys >= 16) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
      const item = descriptor.value;
      if (item === null || typeof item === 'boolean') out[key] = item;
      else if (typeof item === 'string') out[key] = item.slice(0, 200);
      else if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
      else if (Array.isArray(item)) {
        out[key] = item
          .filter((entry) => typeof entry === 'string')
          .slice(0, 16)
          .map((entry) => entry.slice(0, 120));
      } else continue;
      keys += 1;
    }
    return Object.keys(out).length > 0 ? Object.freeze(out) : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   os: 'linux' | 'windows',
 *   policyVersion: string,
 *   now: string,
 *   actionId: string,
 *   target: object,
 *   parameters?: object,
 *   declaredRisk?: string,
 *   actorRoles: readonly string[],
 *   epoch: string,
 *   proposal?: object,
 *   approval?: object,
 *   grant?: object,
 *   replay?: { approvalNonces?: readonly string[], grantNonces?: readonly string[], executionIds?: readonly string[] }
 * }} request Decision input. Nothing is mutated. `actorRoles`, `epoch` and — for
 *   any action with `requiresApproval` — `proposal` are mandatory: omitting them
 *   denies, it does not skip a check. There is deliberately **no** `policyRoots`
 *   field here: deployment roots arrive through the second argument.
 * @param {{ policyRoots?: Record<string, readonly string[]> }} [options] Deployment config.
 * @returns {object} Frozen decision.
 */
function decide(request, options) {
  const state = {
    actionId: null,
    risk: null,
    requiredRole: null,
    requiresApproval: null,
    targetDigest: null,
    parametersDigest: null,
    actionDigestValue: null,
    policyVersion: CURRENT_POLICY_VERSION,
    evaluatedAt: null,
    notes: [],
    helper: [...HELPER_BASELINE],
  };

  const finish = (outcome, reasonCode, detail = null) => deepFreeze({
    outcome,
    reasonCode,
    detail,
    actionId: state.actionId,
    risk: state.risk,
    requiredRole: state.requiredRole,
    requiresApproval: state.requiresApproval,
    policyVersion: state.policyVersion,
    evaluatedAt: state.evaluatedAt,
    targetDigest: state.targetDigest,
    parametersDigest: state.parametersDigest,
    actionDigest: state.actionDigestValue,
    authorizesExecution: false,
    authorizationBoundary: 'policy_gate_only_not_an_execution_authorization',
    structuralValidationOnly: true,
    helperVerificationRequired: Object.freeze([...new Set(state.helper)]),
    notes: Object.freeze([...state.notes]),
  });

  const deny = (code, detail = null) => finish(OUTCOMES.DENY, code, detail);

  /* ---- 1. environment ------------------------------------------------ */
  if (!isPlainObject(request)) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_INPUT_INVALID, { field: 'request' });
  }
  for (const key of Object.getOwnPropertyNames(request)) {
    if (!REQUEST_KEYS.includes(key)) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_INPUT_INVALID, {
        field: key,
        reason: 'undeclared request field',
      });
    }
  }
  if (Object.getOwnPropertySymbols(request).length > 0) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_INPUT_INVALID, {
      field: 'request',
      reason: 'request must not carry symbol keys',
    });
  }
  // 带 getter 的普通对象能骗过 `isPlainObject`，并在两次读取之间改变字段值：判定读到
  // "支持中的策略版本"、审计写入另一个动作，或让同一次判定得出互相矛盾的结论。
  // 决策必须是其输入的纯函数，所以访问器属性一律拒绝——JSON/IPC 反序列化产不出它们，
  // 拒绝不会影响真实调用方。检查覆盖一层嵌套（proposal / approval / grant 都是合同 DTO）。
  const accessor = findAccessorProperty(request, 1);
  if (accessor !== null) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_INPUT_INVALID, {
      field: accessor,
      reason: 'accessor properties are not accepted',
    });
  }
  const now = parseUtcMs(request.now);
  if (now === null) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_INPUT_INVALID, { field: 'now' });
  }
  state.evaluatedAt = request.now;

  if (typeof request.policyVersion !== 'string' || request.policyVersion.length === 0) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_POLICY_VERSION_UNSUPPORTED, {
      field: 'policyVersion',
      supported: [...SUPPORTED_POLICY_VERSIONS],
    });
  }
  if (!SUPPORTED_POLICY_VERSIONS.includes(request.policyVersion)) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_POLICY_VERSION_UNSUPPORTED, {
      policyVersion: request.policyVersion.slice(0, 32),
      supported: [...SUPPORTED_POLICY_VERSIONS],
    });
  }
  state.policyVersion = request.policyVersion;

  if (!isSupportedOs(request.os)) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_OS_UNKNOWN, {
      os: typeof request.os === 'string' ? request.os.slice(0, 16) : typeof request.os,
    });
  }
  const os = request.os;

  /* ---- 2. action ----------------------------------------------------- */
  if (typeof request.actionId !== 'string' || request.actionId.length === 0) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_UNKNOWN_ACTION, { actionId: null });
  }
  state.actionId = request.actionId;

  if (isForbiddenAction(request.actionId)) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_ACTION_FORBIDDEN, {
      actionId: request.actionId,
      reason: FORBIDDEN_ACTIONS[request.actionId],
    });
  }
  const action = getAction(request.actionId);
  if (action === null) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_UNKNOWN_ACTION, {
      actionId: request.actionId.length > 96 ? request.actionId.slice(0, 96) : request.actionId,
    });
  }
  state.risk = action.risk;
  state.requiredRole = action.requiredRole;
  state.requiresApproval = action.requiresApproval;
  state.actionDigestValue = actionDigest(action.actionId);

  /* ---- 3. action × OS ------------------------------------------------ */
  const support = osSupportFor(os, action.actionId);
  if (support.status !== 'supported') {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_OS_UNSUPPORTED, {
      actionId: action.actionId,
      os,
      reason: support.reason,
    });
  }

  /* ---- 4. target ----------------------------------------------------- */
  let target;
  try {
    target = ensureNormalizedTarget(request.target);
  } catch (error) {
    // 任何异常（例如调用方对象上的 getter 抛错）都是"无法验证"，必须 deny。
    // 让异常冒出去等于把"检查没做完"暴露成一个可捕获的信号，调用方很容易把它当成
    // "gate 崩了，先放行"。detail 也不信任被抛对象，统一走 denialFrom 展平。
    const denial = denialFrom(error, REASON_CODES.DENY_INPUT_INVALID, { field: 'target' });
    return finish(OUTCOMES.DENY, denial.code, denial.detail);
  }
  state.targetDigest = target.digest;
  if (target.os !== os) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_TARGET_OS_MISMATCH, {
      targetOs: target.os,
      requestOs: os,
    });
  }
  if (!action.targetKinds.includes(target.kind)) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_TARGET_KIND_MISMATCH, {
      actionId: action.actionId,
      targetKind: target.kind,
      accepted: [...action.targetKinds],
    });
  }

  /* ---- 5. parameters ------------------------------------------------- */
  let parameters;
  try {
    parameters = normalizeParameters(action, request.parameters, {
      os,
      // 部署配置，来自 options 而不是 request：把根交给被判定方，等于让
      // `quarantine_root` 自己声明"我可以落到 C:\Windows"。
      policyRoots: options?.policyRoots,
    });
  } catch (error) {
    const denial = denialFrom(error, REASON_CODES.DENY_INPUT_INVALID, { field: 'parameters' });
    return finish(OUTCOMES.DENY, denial.code, denial.detail);
  }
  state.parametersDigest = parameters.digest;

  /* ---- 6. declared risk ---------------------------------------------- */
  if (request.declaredRisk !== undefined) {
    if (typeof request.declaredRisk !== 'string' || RISK_RANK[request.declaredRisk] === undefined) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_INPUT_INVALID, {
        field: 'declaredRisk',
      });
    }
    if (RISK_RANK[request.declaredRisk] < RISK_RANK[action.risk]) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_RISK_UNDERSTATED, {
        declared: request.declaredRisk,
        floor: action.risk,
      });
    }
  }

  /* ---- 7. requesting role -------------------------------------------- */
  const actorRoles = readRoles(request.actorRoles);
  if (actorRoles === null) {
    // 输入畸形与"权限不足"分开报：把 JSON 形状错误记成越权，会让审计里
    // 出现假的越权事件，也会让真正的越权被噪声淹没。
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_INPUT_INVALID, {
      field: 'actorRoles',
      reason: 'actorRoles must be 1..5 unique declared roles',
    });
  }
  if (!roleSatisfies(actorRoles, action.requiredRole)) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_ROLE_INSUFFICIENT, {
      required: action.requiredRole,
      actorRoles: [...actorRoles],
    });
  }

  /* ---- 7b. epoch ----------------------------------------------------- */
  // epoch 必须对所有请求可见，而不是只在需要审批的分支里比对：否则快照恢复后
  // 的陈旧计划可以在无审批动作（例如 process.suspend）上绕过它。
  if (typeof request.epoch !== 'string' || request.epoch.length === 0) {
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_EPOCH_REQUIRED, {
      field: 'epoch',
      reason: 'epoch must be supplied so a stale snapshot can be distinguished from a fresh one',
    });
  }
  const epoch = request.epoch;

  /* ---- 8. proposal --------------------------------------------------- */
  let proposalDigest = null;
  if ((request.proposal === undefined || request.proposal === null) && action.requiresApproval) {
    // Approval 里唯一能表达"这是哪个动作的审批"的字段是 proposal_digest。
    // 允许省略 proposal 等于跳过这条绑定：一份 network.block_connection 的审批
    // 就能放行同一目标上的 network.isolate。必须要求 proposal 在场。
    return finish(OUTCOMES.DENY, REASON_CODES.DENY_PROPOSAL_REQUIRED, {
      actionId: action.actionId,
      reason: 'a human-approvable action must be evaluated together with the proposal its approval binds',
    });
  }
  if (request.proposal !== undefined && request.proposal !== null) {
    let proposal;
    try {
      proposal = validateStructurally(
        request.proposal,
        REASON_CODES.DENY_PROPOSAL_INVALID,
        'proposal',
        validateResponseProposal,
      );
    } catch (error) {
      const denial = denialFrom(error, REASON_CODES.DENY_PROPOSAL_INVALID, { field: 'proposal' });
      return finish(OUTCOMES.DENY, denial.code, denial.detail);
    }
    const value = proposal.value;
    if (value.action_id !== action.actionId) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_PROPOSAL_MISMATCH, {
        field: 'action_id',
        proposalAction: value.action_id,
      });
    }
    if (value.normalized_target.target_kind !== target.kind) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_TARGET_KIND_MISMATCH, {
        field: 'normalized_target.target_kind',
        proposalKind: value.normalized_target.target_kind,
      });
    }
    if (value.normalized_target.digest !== target.digest
      || value.normalized_target.object_id !== target.objectId) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_TARGET_DRIFT, {
        field: 'normalized_target',
        reason: 'proposal target does not match the target being evaluated',
      });
    }
    if (RISK_RANK[value.risk] < RISK_RANK[action.risk]) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_RISK_UNDERSTATED, {
        source: 'proposal',
        declared: value.risk,
        floor: action.risk,
      });
    }
    const proposalExpiry = parseUtcMs(value.expires_at);
    if (proposalExpiry === null || proposalExpiry <= now) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_PROPOSAL_EXPIRED, {
        expiresAt: value.expires_at,
      });
    }
    proposalDigest = proposal.digest;
  }

  /* ---- 9. approval --------------------------------------------------- */
  let replay;
  try {
    replay = readReplayView(request.replay);
  } catch (error) {
    const denial = denialFrom(error, REASON_CODES.DENY_INPUT_INVALID, { field: 'replay' });
    return finish(OUTCOMES.DENY, denial.code, denial.detail);
  }
  let approvalRecord = null;

  if (action.requiresApproval) {
    if ((request.approval === undefined || request.approval === null)
      && request.grant !== undefined && request.grant !== null) {
      // A grant always claims to consume an approval. Presenting one without that
      // approval is either a replay attempt or a confused caller; both deny.
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_APPROVAL_MISMATCH, {
        reason: 'a grant was supplied without the approval it claims to consume',
      });
    }
    if (request.approval === undefined || request.approval === null) {
      return finish(OUTCOMES.NEEDS_APPROVAL, REASON_CODES.APPROVAL_REQUIRED, {
        actionId: action.actionId,
        requiredRole: action.requiredRole,
      });
    }
    try {
      approvalRecord = validateStructurally(
        request.approval,
        REASON_CODES.DENY_APPROVAL_INVALID,
        'approval',
        validateApproval,
      );
    } catch (error) {
      const denial = denialFrom(error, REASON_CODES.DENY_APPROVAL_INVALID, { field: 'approval' });
      return finish(OUTCOMES.DENY, denial.code, denial.detail);
    }
    const approval = approvalRecord.value;

    if (approval.state !== 'approved') {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_APPROVAL_STATE, { state: approval.state });
    }
    if (approval.policy_version !== state.policyVersion) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_POLICY_VERSION_STALE, {
        approvalPolicyVersion: approval.policy_version,
        currentPolicyVersion: state.policyVersion,
      });
    }
    if (!roleSatisfies(approval.approver_identity.role_snapshot, action.requiredRole)) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_APPROVAL_ROLE, {
        required: action.requiredRole,
        approverRoles: [...approval.approver_identity.role_snapshot],
      });
    }
    const approvalExpiry = parseUtcMs(approval.expires_at);
    if (approvalExpiry === null || approvalExpiry <= now) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_APPROVAL_EXPIRED, {
        expiresAt: approval.expires_at,
      });
    }
    const approvalIssued = parseUtcMs(approval.issued_at);
    if (approvalIssued === null || approvalIssued > now) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_APPROVAL_NOT_YET_VALID, {
        issuedAt: approval.issued_at,
      });
    }
    if (approval.target_digest !== target.digest) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_APPROVAL_TARGET_DRIFT, {
        field: 'target_digest',
      });
    }
    if (proposalDigest !== null && approval.proposal_digest !== proposalDigest) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_APPROVAL_PROPOSAL_MISMATCH, {
        field: 'proposal_digest',
      });
    }
    if (approval.epoch !== epoch) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_APPROVAL_EPOCH, {
        field: 'epoch',
      });
    }
    if (replay.approvalNonces.has(approval.nonce)) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_APPROVAL_NONCE_REPLAY, {
        field: 'nonce',
      });
    }
  } else if (request.approval !== undefined && request.approval !== null) {
    state.notes.push('approval supplied for an action that does not require one; it was not consulted');
  }

  if ((request.grant === undefined || request.grant === null) && action.requiresApproval) {
    // 合同里 Approval 没有参数摘要：审批人看到的是 Proposal，而 Proposal 也不带参数。
    // 因此"审批覆盖参数"这件事在本层无法成立，只有 Grant 的 parameters_digest 能绑定。
    // 明写出来，避免下游把 allow 当成"这组参数也被批过"。
    state.notes.push('approval does not bind parameters; only a grant parameters_digest does');
  }

  /* ---- 10. execution grant ------------------------------------------- */
  if (request.grant !== undefined && request.grant !== null) {
    if (approvalRecord === null) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_APPROVAL_MISMATCH, {
        reason: 'a grant requires the approval it claims to consume',
      });
    }
    let grant;
    try {
      grant = validateStructurally(
        request.grant,
        REASON_CODES.DENY_GRANT_INVALID,
        'grant',
        validateExecutionGrant,
      );
    } catch (error) {
      const denial = denialFrom(error, REASON_CODES.DENY_GRANT_INVALID, { field: 'grant' });
      return finish(OUTCOMES.DENY, denial.code, denial.detail);
    }
    const value = grant.value;
    state.notes.push('grant structure validated; signature is verified by the helper, not here');
    state.helper.push(...HELPER_GRANT);

    if (value.action_id !== action.actionId || value.action_digest !== actionDigest(action.actionId)) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_ACTION_MISMATCH, {
        field: 'action_id',
      });
    }
    if (value.parameters_digest !== parameters.digest) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_PARAMETERS_DRIFT, {
        field: 'parameters_digest',
      });
    }
    if (value.target_digest !== target.digest) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_TARGET_DRIFT, {
        field: 'target_digest',
      });
    }
    if (value.approval_id !== approvalRecord.value.approval_id) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_APPROVAL_MISMATCH, {
        field: 'approval_id',
      });
    }
    // 与 contracts.verifyGrantApprovalBinding 对齐：nonce 不得复用审批的。
    // 缺了它，同一对记录在 contracts 层非法、在本层合法，两个安全边界会分歧。
    if (value.nonce === approvalRecord.value.nonce) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_APPROVAL_MISMATCH, {
        field: 'nonce',
        reason: 'grant.nonce must differ from approval.nonce',
      });
    }
    if (value.epoch !== epoch || value.epoch !== approvalRecord.value.epoch) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_EPOCH, { field: 'epoch' });
    }
    const notBefore = parseUtcMs(value.not_before);
    if (notBefore === null || notBefore > now) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_NOT_YET_VALID, {
        notBefore: value.not_before,
      });
    }
    const grantExpiry = parseUtcMs(value.expires_at);
    if (grantExpiry === null || grantExpiry <= now) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_EXPIRED, {
        expiresAt: value.expires_at,
      });
    }
    // 时间窗不得宽于审批的（contracts.verifyGrantApprovalBinding 同样要求）。
    const approvalIssuedMs = parseUtcMs(approvalRecord.value.issued_at);
    if (approvalIssuedMs !== null && notBefore < approvalIssuedMs) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_NOT_YET_VALID, {
        field: 'not_before',
        reason: 'grant.not_before must not precede approval.issued_at',
      });
    }
    const approvalExpiresMs = parseUtcMs(approvalRecord.value.expires_at);
    if (approvalExpiresMs !== null && grantExpiry > approvalExpiresMs) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_APPROVAL_MISMATCH, {
        field: 'expires_at',
        reason: 'grant.expires_at must not exceed approval.expires_at',
      });
    }
    if (replay.grantNonces.has(value.nonce)) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_NONCE_REPLAY, { field: 'nonce' });
    }
    if (replay.executionIds.has(value.execution_id)) {
      return finish(OUTCOMES.DENY, REASON_CODES.DENY_GRANT_EXECUTION_REPLAY, {
        field: 'execution_id',
      });
    }
  }

  /* ---- 11. allow ----------------------------------------------------- */
  return finish(OUTCOMES.ALLOW, REASON_CODES.ALLOWED);
}

/**
 * Convenience: the policy version this build evaluates.
 *
 * @returns {string} `1.0`.
 */
export function currentPolicyVersion() {
  return CURRENT_POLICY_VERSION;
}
