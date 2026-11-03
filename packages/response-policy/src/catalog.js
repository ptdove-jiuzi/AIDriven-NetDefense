/**
 * catalog.js — the closed action catalog and the action × OS support matrix.
 *
 * Two properties matter more than the table contents:
 *
 * 1. **Closed.** The catalog is a frozen allowlist. An identifier that is not in
 *    `ACTION_CATALOG` is denied, and *known but banned* identifiers (`shell.exec`,
 *    `file.delete`, …) are denied with a distinct code so an operator can tell
 *    "you typo'd" from "this will never be a response action".
 * 2. **Self-describing.** Every action declares its risk floor, the role required
 *    to request it, whether human approval is mandatory, which target kinds it
 *    accepts, which OS families publish it, and the fail-closed conditions that
 *    must hold before the platform adapter may touch the object.
 *
 * `process.suspend` is deliberately unsupported on Windows: the platform has no
 * supported public API for suspending an arbitrary process, and design §10.2 says
 * an action × OS pair that cannot guarantee object identity is **not published**
 * rather than shipped on an undocumented call.
 */

import { canonicalDigest } from '@aegisharness/contracts';

/** Raised when the catalog contradicts itself. A programming error, not input. */
export class CatalogError extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.name = 'CatalogError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** OS families the policy layer knows about. Anything else is `DENY_OS_UNKNOWN`. */
export const SUPPORTED_OS = Object.freeze(['linux', 'windows']);

/** Policy versions this build can evaluate. Exact match only. */
export const SUPPORTED_POLICY_VERSIONS = Object.freeze(['1.0']);
export const CURRENT_POLICY_VERSION = SUPPORTED_POLICY_VERSIONS[0];

/** Risk floor ordering; an approval may raise it but never lower it. */
export const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

/**
 * Capabilities per role — deliberately **not** a total order.
 *
 * Design §10.2 enumerates duties: `viewer` reads, `analyst` requests analysis but
 * cannot approve, `responder` approves response, `budget-admin` only adjusts
 * budgets, `admin` manages local authorisation. It also says installation must
 * not add every administrator to the responder group.
 *
 * A rank-based model (`admin: 3 > responder: 2`) quietly breaks that mitigation:
 * any local administrator would inherit the right to approve response actions.
 * So `admin` here has `view`, `analyze` and `authorize` but **not** `respond`;
 * approving or requesting a response action needs the responder group
 * explicitly, which matches `contracts`' own rule that an approval snapshot must
 * contain `responder`.
 *
 * `authorize` is intentionally unused by this catalog: "manage local
 * authorisation" is a console/daemon duty, not a response action, so no action
 * declares `requiredRole: 'admin'`. The capability stays on the table so the
 * console can reuse one role definition; `verifyCatalog`-adjacent tests assert
 * that no action requires `admin`, which keeps the table honest.
 */
export const ROLE_CAPABILITIES = Object.freeze({
  viewer: Object.freeze(['view']),
  analyst: Object.freeze(['view', 'analyze']),
  responder: Object.freeze(['view', 'analyze', 'respond']),
  'budget-admin': Object.freeze(['budget']),
  admin: Object.freeze(['view', 'analyze', 'authorize']),
});

/** Roles that may be declared on an action or a session, in display order. */
export const ROLE_NAMES = Object.freeze(Object.keys(ROLE_CAPABILITIES));

/** Capability an action's `requiredRole` stands for. */
const CAPABILITY_BY_ACTION_ROLE = Object.freeze({
  viewer: 'view',
  analyst: 'analyze',
  responder: 'respond',
  admin: 'authorize',
});

/**
 * @param {string} role Action role.
 * @returns {string | null} Capability that role requires, or `null` when unknown.
 */
export function capabilityForRole(role) {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_BY_ACTION_ROLE, role)
    ? CAPABILITY_BY_ACTION_ROLE[role]
    : null;
}

/**
 * Actions whose effect cannot be undone, independent of what the table says.
 *
 * Kept as a separate constant on purpose: when "irreversible ⇒ approval" is
 * checked against the same two booleans it is supposed to constrain, flipping
 * `reversible` to `true` satisfies the check. Anchoring the list here means the
 * table cannot talk itself out of approval.
 */
export const IRREVERSIBLE_ACTIONS = Object.freeze(['process.terminate']);

/**
 * Product-owned directories a path parameter may point into, per OS.
 *
 * `file.quarantine` takes a destination; without a bound, "quarantine" is
 * indistinguishable from "move this file anywhere, including a startup folder".
 * Roots come from deployment configuration passed to
 * `evaluateResponsePolicy(request, { policyRoots })` — never from the request
 * being judged — and each supplied root is itself canonicalised and bounded.
 */
export const DEFAULT_PARAMETER_ROOTS = Object.freeze({
  linux: Object.freeze({ quarantine: Object.freeze(['/var/lib/aegisharness/quarantine']) }),
  windows: Object.freeze({
    quarantine: Object.freeze([`C:${String.fromCharCode(92)}ProgramData${String.fromCharCode(92)}AegisHarness${String.fromCharCode(92)}quarantine`]),
  }),
});

/** How many override roots one parameter may accept. */
export const MAX_PARAMETER_ROOTS = 4;

/** Names a parameter spec may use. Scalars only — no nested objects or arrays. */
export const PARAMETER_SPEC_TYPES = Object.freeze(['integer', 'boolean', 'enum', 'path', 'string']);

export const MAX_PARAMETER_KEYS = 16;
export const MAX_PARAMETER_BYTES = 4096;
export const MAX_PARAMETER_STRING_BYTES = 1024;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

const BOTH_OS = Object.freeze({
  linux: Object.freeze({ status: 'supported', reason: null }),
  windows: Object.freeze({ status: 'supported', reason: null }),
});

const LINUX_ONLY_SUSPEND = Object.freeze({
  linux: Object.freeze({ status: 'supported', reason: null }),
  windows: Object.freeze({
    status: 'unsupported',
    reason: 'no supported public API to suspend an arbitrary process; publishing would require an undocumented call',
  }),
});

/**
 * Action identifiers that are recognisably response-shaped but permanently
 * outside the catalog. Denied with `DENY_ACTION_FORBIDDEN`, never with
 * `DENY_UNKNOWN_ACTION`, so the audit trail records an explicit refusal.
 */
export const FORBIDDEN_ACTIONS = Object.freeze({
  'shell.exec': 'free-form command execution is not a response action',
  'file.delete': 'irreversible deletion is outside the closed catalog',
  'process.terminate_all': 'mass termination cannot bind a single object identity',
  'network.flush_rules': 'flushing every rule cannot be scoped to our own operation_id',
});

/** @type {readonly object[]} */
const ACTIONS = Object.freeze([
  {
    actionId: 'observe.record_alert',
    summary: 'Record an alert-only outcome; the target is never touched.',
    risk: 'low',
    requiredRole: 'viewer',
    requiresApproval: false,
    reversible: true,
    targetKinds: Object.freeze(['process', 'network', 'file']),
    parameters: Object.freeze({}),
    osSupport: BOTH_OS,
    failClosed: Object.freeze(['alert-only path must never mutate the target object']),
  },
  {
    actionId: 'process.suspend',
    summary: 'Suspend one process, reversible, no host-side approval.',
    risk: 'medium',
    requiredRole: 'responder',
    requiresApproval: false,
    reversible: true,
    targetKinds: Object.freeze(['process']),
    parameters: Object.freeze({}),
    osSupport: LINUX_ONLY_SUSPEND,
    failClosed: Object.freeze([
      'process identity must be bound by OS handle plus creation time, never a bare PID',
      'windows is unsupported: no public suspend API, so the pair is not published',
    ]),
  },
  {
    actionId: 'process.terminate',
    summary: 'Terminate one process. Irreversible.',
    risk: 'critical',
    requiredRole: 'responder',
    requiresApproval: true,
    reversible: false,
    targetKinds: Object.freeze(['process']),
    parameters: Object.freeze({
      grace_period_ms: Object.freeze({ type: 'integer', required: false, min: 0, max: 60000 }),
    }),
    osSupport: BOTH_OS,
    failClosed: Object.freeze([
      'a bare PID is not an identity; handle + creation time binding is mandatory',
      'if the handle cannot be re-bound immediately before termination, deny',
      'irreversible: the console must warn and re-confirm independently of this decision',
    ]),
  },
  {
    actionId: 'network.block_connection',
    summary: 'Block one owned connection tuple.',
    risk: 'high',
    requiredRole: 'responder',
    requiresApproval: true,
    reversible: true,
    targetKinds: Object.freeze(['network']),
    parameters: Object.freeze({
      direction: Object.freeze({
        type: 'enum',
        required: true,
        values: Object.freeze(['inbound', 'outbound', 'both']),
      }),
      duration_ms: Object.freeze({ type: 'integer', required: false, min: 1000, max: 86400000 }),
    }),
    osSupport: BOTH_OS,
    failClosed: Object.freeze([
      'rule ownership must be provable through our own operation_id',
      'if the rule identity cannot be re-read before the side effect, deny',
    ]),
  },
  {
    actionId: 'network.isolate',
    summary: 'Isolate the host network path owned by one operation_id.',
    risk: 'critical',
    requiredRole: 'responder',
    requiresApproval: true,
    reversible: true,
    targetKinds: Object.freeze(['network']),
    parameters: Object.freeze({
      direction: Object.freeze({
        type: 'enum',
        required: true,
        values: Object.freeze(['inbound', 'outbound', 'both']),
      }),
      duration_ms: Object.freeze({ type: 'integer', required: false, min: 1000, max: 86400000 }),
    }),
    osSupport: BOTH_OS,
    failClosed: Object.freeze([
      'isolation applies only to rules carrying our own operation_id',
      'rescue must be able to restore the exact prior rule state',
    ]),
  },
  {
    actionId: 'file.quarantine',
    summary: 'Move one file object into the quarantine root.',
    risk: 'high',
    requiredRole: 'responder',
    requiresApproval: true,
    reversible: true,
    targetKinds: Object.freeze(['file']),
    parameters: Object.freeze({
      quarantine_root: Object.freeze({ type: 'path', required: true, root: 'quarantine' }),
      preserve_metadata: Object.freeze({ type: 'boolean', required: false }),
    }),
    osSupport: BOTH_OS,
    failClosed: Object.freeze([
      'object identity must come from a secure file or parent-directory handle',
      'unresolved link, reparse point, alternate data stream or mount alias means deny',
      'recovery manifest must be written and fsynced before the side effect',
    ]),
  },
]);

function bindingView(action) {
  const parameterNames = Object.keys(action.parameters).sort();
  return {
    action_id: action.actionId,
    requires_approval: action.requiresApproval,
    required_role: action.requiredRole,
    reversible: action.reversible,
    risk: action.risk,
    target_kinds: [...action.targetKinds].sort(),
    parameters: Object.fromEntries(parameterNames.map((name) => [name, action.parameters[name]])),
    os_support: Object.fromEntries(
      SUPPORTED_OS.map((os) => [os, action.osSupport[os]?.status ?? 'unsupported']),
    ),
  };
}

/** @type {Readonly<Record<string, object>>} */
export const ACTION_CATALOG = deepFreeze(
  Object.fromEntries(ACTIONS.map((action) => [action.actionId, action])),
);

/** Ordered identifiers, useful for UI enumeration and tests. */
export const ACTION_IDS = Object.freeze(ACTIONS.map((action) => action.actionId));

/**
 * action × OS matrix, flattened to `matrix[actionId][os]`.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, {status: string, reason: string | null}>>>>}
 */
export const ACTION_OS_MATRIX = deepFreeze(
  Object.fromEntries(
    ACTIONS.map((action) => [
      action.actionId,
      Object.fromEntries(SUPPORTED_OS.map((os) => {
        const entry = action.osSupport[os];
        return [os, entry === undefined
          ? { status: 'unsupported', reason: 'not declared for this OS' }
          : entry];
      })),
    ]),
  ),
);

/**
 * Digest of the immutable parts of an action descriptor.
 *
 * `ExecutionGrant.action_digest` must equal this value, which is what stops a
 * grant issued for one action (or for a lower risk floor of the same action)
 * from being replayed against a mutated catalog entry.
 *
 * @param {string} actionId Catalog identifier.
 * @returns {string} 64-hex digest, or `''` for an unknown action.
 */
const DIGEST_CACHE = new Map();

export function actionDigest(actionId) {
  const cached = DIGEST_CACHE.get(actionId);
  if (cached !== undefined) return cached;
  const action = ACTION_CATALOG[actionId];
  if (action === undefined) return '';
  const digest = canonicalDigest(bindingView(action));
  DIGEST_CACHE.set(actionId, digest);
  return digest;
}

/**
 * @param {unknown} actionId Candidate identifier.
 * @returns {boolean} True when the identifier is a published catalog action.
 */
export function isCatalogAction(actionId) {
  return typeof actionId === 'string'
    && Object.prototype.hasOwnProperty.call(ACTION_CATALOG, actionId);
}

/**
 * @param {unknown} actionId Candidate identifier.
 * @returns {boolean} True when the identifier is explicitly banned.
 */
export function isForbiddenAction(actionId) {
  return typeof actionId === 'string'
    && Object.prototype.hasOwnProperty.call(FORBIDDEN_ACTIONS, actionId);
}

/**
 * @param {unknown} actionId Catalog identifier.
 * @returns {object | null} Frozen descriptor, or `null`.
 */
export function getAction(actionId) {
  return isCatalogAction(actionId) ? ACTION_CATALOG[actionId] : null;
}

/**
 * @param {unknown} os Candidate OS family.
 * @returns {boolean} True for a supported OS family.
 */
export function isSupportedOs(os) {
  return typeof os === 'string' && SUPPORTED_OS.includes(os);
}

/**
 * @param {string} os Supported OS family.
 * @param {string} actionId Catalog identifier.
 * @returns {{status: string, reason: string | null}} Matrix entry.
 */
export function osSupportFor(os, actionId) {
  return ACTION_OS_MATRIX[actionId]?.[os] ?? { status: 'unsupported', reason: 'unknown action' };
}

/**
 * Validates the catalog against its own invariants.
 *
 * Called by the test suite rather than at import time: a self-contradicting table
 * should fail the build loudly in CI, but a module that throws on import turns a
 * typo into an unimportable security module.
 *
 * @returns {true} True when every invariant holds.
 * @throws {CatalogError} On the first violated invariant.
 */
export function verifyCatalog() {
  if (ACTION_IDS.length === 0) {
    throw new CatalogError('CATALOG_EMPTY', 'the action catalog must not be empty');
  }
  const seen = new Set();
  for (const action of ACTIONS) {
    const id = action.actionId;
    if (seen.has(id)) {
      throw new CatalogError('CATALOG_DUPLICATE', `duplicate action id ${id}`, { actionId: id });
    }
    seen.add(id);
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){1,3}$/u.test(id)) {
      throw new CatalogError('CATALOG_ID_SHAPE', `action id ${id} is not a dotted lower-case identifier`, {
        actionId: id,
      });
    }
    if (Object.prototype.hasOwnProperty.call(FORBIDDEN_ACTIONS, id)) {
      throw new CatalogError('CATALOG_FORBIDDEN_CONFLICT', `${id} is both published and forbidden`, {
        actionId: id,
      });
    }
    if (RISK_RANK[action.risk] === undefined) {
      throw new CatalogError('CATALOG_RISK', `${id} declares unknown risk ${String(action.risk)}`, {
        actionId: id,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, action.requiredRole)
      || capabilityForRole(action.requiredRole) === null) {
      throw new CatalogError('CATALOG_ROLE', `${id} requires an invalid role ${action.requiredRole}`, {
        actionId: id,
      });
    }
    if (action.requiredRole === 'budget-admin') {
      throw new CatalogError('CATALOG_ROLE', `${id} must not require budget-admin`, { actionId: id });
    }
    // 不可逆性由常量表锚定，而不是由动作自己声明的 reversible 决定：
    // 否则把 reversible 改成 true 就能同时满足下面的“不可逆必须审批”检查。
    if (action.reversible !== !IRREVERSIBLE_ACTIONS.includes(id)) {
      throw new CatalogError('CATALOG_REVERSIBILITY_DRIFT', `${id} reversible flag disagrees with IRREVERSIBLE_ACTIONS`, {
        actionId: id,
      });
    }
    if (action.targetKinds.length === 0) {
      throw new CatalogError('CATALOG_TARGET_KINDS', `${id} declares no target kinds`, { actionId: id });
    }
    if (action.failClosed.length === 0) {
      throw new CatalogError('CATALOG_FAIL_CLOSED', `${id} declares no fail-closed condition`, {
        actionId: id,
      });
    }
    // 不可逆动作必须人工审批：这是设计 §10.2 的硬约束，不允许通过调表绕过。
    if (IRREVERSIBLE_ACTIONS.includes(id) && action.requiresApproval !== true) {
      throw new CatalogError('CATALOG_IRREVERSIBLE_WITHOUT_APPROVAL', `${id} is irreversible but skips approval`, {
        actionId: id,
      });
    }
    if (action.risk === 'critical' && action.requiresApproval !== true) {
      throw new CatalogError('CATALOG_CRITICAL_WITHOUT_APPROVAL', `${id} is critical but skips approval`, {
        actionId: id,
      });
    }
    for (const os of SUPPORTED_OS) {
      const entry = action.osSupport[os];
      if (entry === undefined) {
        throw new CatalogError('CATALOG_OS_MISSING', `${id} does not declare support for ${os}`, {
          actionId: id,
          os,
        });
      }
      if (entry.status !== 'supported' && entry.status !== 'unsupported') {
        throw new CatalogError('CATALOG_OS_STATUS', `${id}/${os} has invalid status ${entry.status}`, {
          actionId: id,
          os,
        });
      }
      if (entry.status === 'unsupported' && (entry.reason === null || entry.reason.length === 0)) {
        throw new CatalogError('CATALOG_OS_REASON', `${id}/${os} is unsupported without a reason`, {
          actionId: id,
          os,
        });
      }
    }
    for (const [name, spec] of Object.entries(action.parameters)) {
      if (!PARAMETER_SPEC_TYPES.includes(spec.type)) {
        throw new CatalogError('CATALOG_PARAM_TYPE', `${id}.${name} has unknown type ${spec.type}`, {
          actionId: id,
          name,
        });
      }
      if (spec.type === 'enum' && (!Array.isArray(spec.values) || spec.values.length === 0)) {
        throw new CatalogError('CATALOG_PARAM_ENUM', `${id}.${name} is an enum without values`, {
          actionId: id,
          name,
        });
      }
      if (spec.type === 'integer' && !(Number.isSafeInteger(spec.min) && Number.isSafeInteger(spec.max))) {
        throw new CatalogError('CATALOG_PARAM_RANGE', `${id}.${name} needs safe integer min/max`, {
          actionId: id,
          name,
        });
      }
      if (spec.root !== undefined) {
        if (spec.type !== 'path') {
          throw new CatalogError('CATALOG_PARAM_ROOT', `${id}.${name} declares a root on a non-path parameter`, {
            actionId: id,
            name,
          });
        }
        for (const os of SUPPORTED_OS) {
          const roots = DEFAULT_PARAMETER_ROOTS[os]?.[spec.root];
          if (!Array.isArray(roots) || roots.length === 0) {
            throw new CatalogError('CATALOG_PARAM_ROOT', `${id}.${name} root ${spec.root} has no default for ${os}`, {
              actionId: id,
              name,
              os,
            });
          }
        }
      }
    }
  }
  for (const forbidden of Object.keys(FORBIDDEN_ACTIONS)) {
    if (seen.has(forbidden)) {
      throw new CatalogError('CATALOG_FORBIDDEN_CONFLICT', `${forbidden} is published and forbidden`);
    }
  }
  for (const irreversible of IRREVERSIBLE_ACTIONS) {
    if (!seen.has(irreversible)) {
      throw new CatalogError('CATALOG_IRREVERSIBLE_UNKNOWN', `${irreversible} is listed as irreversible but not published`);
    }
  }
  if (actionDigest(ACTION_IDS[0]).length !== 64) {
    throw new CatalogError('CATALOG_DIGEST', 'action digest must be 64 hex characters');
  }
  return true;
}
