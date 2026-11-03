/**
 * interface.js — the narrow contract between the daemon and the response helper.
 *
 * Design §11 publishes exactly four execution-side exchanges between the daemon
 * and this helper:
 *
 *   dispatch   daemon → helper   (this module's envelope)
 *   accept     helper → daemon   (plan / refusal, never a side effect)
 *   result     helper → daemon   (post-effect evidence; not reachable in this build)
 *   reconcile  daemon → helper   (same execution/attempt, idempotent re-query)
 *
 * This build implements `dispatch` for **dry-run only**. The envelope is closed:
 * an undeclared key denies. That matters because the obvious bypass for a dry-run
 * helper is an extra field — `{ ..., execute: true }`, `{ ..., dryRun: false }`,
 * `{ ..., force: true }` — that a permissive parser would ignore while the audit
 * trail still records "dispatched as declared". Closed shape turns every such
 * attempt into `HELPER_ENVELOPE_INVALID`.
 *
 * The envelope deliberately carries **no** command, argv, shell, script, path list
 * or free-form text field. There is nowhere to put a command line, so there is no
 * command line to inject into.
 *
 * Validation also **snapshots** every nested value. Each caller property is read
 * exactly once, through a data descriptor, into a frozen plain copy. Without that
 * snapshot a getter could answer the policy gate with one grant and this helper
 * with another — a time-of-check/time-of-use hole in the one place where the
 * checked object *is* the thing being authorised.
 */

import { isNormalizedTarget } from '../../../packages/response-policy/index.js';
import { DRY_RUN_ONLY } from './build.js';
import { helperFail, HELPER_CODES } from './errors.js';

/** Interface version this build speaks. Exact match only. */
export const INTERFACE_VERSION = '1.0';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE = /^[A-Za-z0-9_-]{22,128}$/u;
/**
 * Deliberately identical to `packages/response-policy/src/time.js`: optional
 * `.mmm`, uppercase `Z`, no numeric offset. A looser pattern here would accept a
 * timestamp this helper parses and the gate rejects, i.e. two interpretations of
 * one field.
 */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_ACTION_ID = 96;
const MAX_ROLES = 5;

/** Bounds on the nested snapshot, so a dispatch cannot be an amplifier. */
const MAX_DEPTH = 8;
const MAX_KEYS_PER_OBJECT = 32;
const MAX_ARRAY_ITEMS = 64;
const MAX_NESTED_STRING = 2048;

/** Methods this helper publishes. Anything else is not callable. */
export const HELPER_METHODS = Object.freeze(['describe', 'prepare', 'dryRun', 'executeStub']);

/** The closed envelope key set. Order is documentation, not precedence. */
export const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'execution_id',
  'attempt_id',
  'lease_id',
  'sequence',
  'os',
  'policyVersion',
  'now',
  'actionId',
  'target',
  'parameters',
  'actorRoles',
  'epoch',
  'proposal',
  'approval',
  'grant',
  'replay',
]);

/**
 * Upper bound on envelope size, derived from the key list so the two cannot
 * disagree. A hand-written number here would silently reject the full envelope
 * the day a field is added — or, worse, accept a bag of extra fields.
 */
const MAX_KEYS = ENVELOPE_KEYS.length;

/**
 * Static, data-only description of the interface.
 *
 * Published as data so a test can assert the contract instead of trusting prose,
 * and so the daemon can negotiate without calling into probe or policy logic.
 */
export const HELPER_INTERFACE = Object.freeze({
  version: INTERFACE_VERSION,
  methods: HELPER_METHODS,
  envelopeKeys: ENVELOPE_KEYS,
  /** Derived from the build constant, never a second literal. */
  dryRunOnly: DRY_RUN_ONLY,
  /** Constant: a plan is never an authorisation. */
  authorizesExecution: false,
  /** Limits the daemon must respect before sending. */
  limits: Object.freeze({
    maxEnvelopeKeys: MAX_KEYS,
    maxActionIdLength: MAX_ACTION_ID,
    maxRoles: MAX_ROLES,
    maxNestedDepth: MAX_DEPTH,
  }),
  /** Fields that must never exist, listed so "absent by design" is testable. */
  forbiddenFields: Object.freeze([
    'command',
    'argv',
    'shell',
    'script',
    'exec',
    'spawn',
    'cwd',
    'env',
    'force',
    'dryRun',
    'allowReal',
    'skipApproval',
  ]),
  guarantees: Object.freeze([
    'an undeclared envelope field is refused, never ignored',
    'no method in this build performs a process, network or file side effect',
    'a preview writes no recovery manifest, reserves no execution id and spends no grant nonce',
    'a mutating action is never planned without a grant that was bound and verified',
    'the helper never re-decides risk, role or approval; it consumes the policy decision',
    'a plan carries digests only, never raw paths, addresses or parameter values',
    'every nested envelope value is copied once at the boundary, so a getter cannot answer twice',
  ]),
  notGuaranteed: Object.freeze([
    'signature verification without a configured trust root (fails closed instead)',
    'durable storage of the recovery manifest (this build has no writer that can fsync)',
    'object identity across a real race window: this build never takes the side effect',
    'durable nonce single-use (this build uses an in-memory inbox)',
    'planning an approval-free mutating action: the policy catalog lets `process.suspend` through without an approval, and this helper refuses to plan a mutation without a grant',
  ]),
});

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value, path, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'expected a bounded non-empty string', {
      field: path,
      type: typeof value,
    });
  }
  return value;
}

/**
 * Copy one nested value into a frozen plain-data snapshot.
 *
 * Only JSON data is accepted: strings, finite numbers, booleans, `null`, arrays and
 * plain objects. Anything else — a function, a class instance, a symbol key, a
 * sparse array, an accessor — is refused rather than coerced, because a coercion
 * is exactly where a value would change between the gate's read and this one.
 *
 * @param {unknown} value Candidate.
 * @param {string} path Dot path for the refusal.
 * @param {number} [depth] Recursion depth.
 * @returns {unknown} Frozen copy.
 * @throws {import('./errors.js').HelperError} On any non-data shape.
 */
function snapshotValue(value, path, depth = 0) {
  if (depth > MAX_DEPTH) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'nested value is too deep', { maxDepth: MAX_DEPTH });
  }
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'nested number must be finite');
    }
    return value;
  }
  if (type === 'string') {
    if (value.length > MAX_NESTED_STRING) {
      helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'nested string is too long');
    }
    return value;
  }
  if (type !== 'object') {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'only JSON data is accepted', { type });
  }
  if (Array.isArray(value)) {
    // One read of `length`, then a bounded loop. Reading `value.length` again in
    // the loop condition would let a Proxy answer "3" for the bound check and
    // "1e9" for the loop — the cap would exist only in the error message.
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'nested array has an invalid length');
    }
    if (length > MAX_ARRAY_ITEMS) {
      helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'nested array is too long', {
        maxItems: MAX_ARRAY_ITEMS,
      });
    }
    const out = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        helperFail(
          HELPER_CODES.HELPER_ENVELOPE_INVALID,
          `${path}[${index}]`,
          'nested array must be dense plain data',
        );
      }
      out.push(snapshotValue(descriptor.value, `${path}[${index}]`, depth + 1));
    }
    return Object.freeze(out);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'nested value must be a plain object');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'nested value must not carry symbol keys');
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length > MAX_KEYS_PER_OBJECT) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, path, 'nested object has too many keys', {
      maxKeys: MAX_KEYS_PER_OBJECT,
    });
  }
  const out = {};
  for (const name of names) {
    if (name === '__proto__') {
      // `out[name] = value` with this key would set the prototype instead of
      // creating an own property, so the "frozen copy" would not be a faithful
      // copy at all. Refuse it rather than special-case the assignment.
      helperFail(
        HELPER_CODES.HELPER_ENVELOPE_INVALID,
        `${path}.__proto__`,
        'an envelope value must not carry a __proto__ key',
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      helperFail(
        HELPER_CODES.HELPER_ENVELOPE_INVALID,
        `${path}.${name}`,
        'accessor properties are not accepted in an envelope',
      );
    }
    Object.defineProperty(out, name, {
      value: snapshotValue(descriptor.value, `${path}.${name}`, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(out);
}

/**
 * Snapshot a target, preserving an already-normalised one.
 *
 * A normalised target is branded through a `WeakSet` inside `response-policy`;
 * copying it would strip that membership and make `ensureNormalizedTarget` reject
 * the very object the policy gate just bound. It is frozen and issued by that
 * module, so keeping the reference is safe — unlike the raw form, which is caller
 * data and must be copied.
 *
 * @param {unknown} value Candidate target.
 * @returns {object} Snapshot or the branded normalised target.
 */
function snapshotTarget(value) {
  if (!isPlainObject(value)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.target', 'target must be a plain object');
  }
  if (isNormalizedTarget(value)) return value;
  return snapshotValue(value, '$.target');
}

/**
 * Validate one dispatch envelope.
 *
 * Only the *transport* shape is checked here. Risk, role, approval, target and
 * parameter semantics belong to `packages/response-policy`; re-implementing them
 * would create a second, quietly divergent decision maker.
 *
 * Every own property of the caller's object is read **once**; everything after that
 * operates on the frozen snapshot.
 *
 * @param {unknown} value Candidate envelope.
 * @returns {Readonly<object>} Shallow-frozen normalised envelope with frozen parts.
 * @throws {import('./errors.js').HelperError} On any shape violation.
 */
export function validateEnvelope(value) {
  if (!isPlainObject(value)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$', 'envelope must be a plain object');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$', 'envelope must not carry symbol keys');
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > MAX_KEYS) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$', 'envelope carries too many fields', {
      maxKeys: MAX_KEYS,
      keys: keys.length,
    });
  }
  for (const key of keys) {
    if (!ENVELOPE_KEYS.includes(key)) {
      helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, `$.${key}`, 'undeclared envelope field', {
        field: key,
      });
    }
  }

  // Single read per field, through a data descriptor. A getter that throws is a
  // refusal; a getter that answers differently the second time is impossible
  // because there is no second read.
  const field = (name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) return undefined;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      helperFail(
        HELPER_CODES.HELPER_ENVELOPE_INVALID,
        `$.${name}`,
        'accessor properties are not accepted in an envelope',
      );
    }
    return descriptor.value;
  };

  const schemaVersion = field('schemaVersion');
  const executionId = field('execution_id');
  const attemptId = field('attempt_id');
  const leaseId = field('lease_id');
  const sequence = field('sequence');
  const os = field('os');
  const policyVersion = field('policyVersion');
  const now = field('now');
  const actionId = field('actionId');
  const targetValue = field('target');
  const parametersValue = field('parameters');
  const actorRolesValue = field('actorRoles');
  const epoch = field('epoch');
  const proposalValue = field('proposal');
  const approvalValue = field('approval');
  const grantValue = field('grant');
  const replayValue = field('replay');

  if (schemaVersion !== INTERFACE_VERSION) {
    helperFail(HELPER_CODES.HELPER_VERSION_UNSUPPORTED, '$.schemaVersion', 'unsupported interface version', {
      supported: INTERFACE_VERSION,
    });
  }
  if (typeof executionId !== 'string' || !UUID_V4.test(executionId)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.execution_id', 'execution_id must be a UUIDv4');
  }
  if (typeof attemptId !== 'string' || !UUID_V4.test(attemptId)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.attempt_id', 'attempt_id must be a UUIDv4');
  }
  if (typeof leaseId !== 'string' || !OPAQUE.test(leaseId)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.lease_id', 'lease_id must be an opaque token');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.sequence', 'sequence must be a non-negative integer');
  }
  if (os !== 'linux' && os !== 'windows') {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.os', 'os must be linux or windows');
  }
  requireString(policyVersion, '$.policyVersion', 32);
  if (typeof now !== 'string' || !RFC3339_UTC.test(now)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.now', 'now must be strict RFC3339 UTC');
  }
  requireString(actionId, '$.actionId', MAX_ACTION_ID);
  if (typeof epoch !== 'string' || !UUID_V4.test(epoch)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.epoch', 'epoch must be a UUIDv4');
  }
  if (!isPlainObject(targetValue)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.target', 'target must be a plain object');
  }
  if (parametersValue !== undefined && parametersValue !== null && !isPlainObject(parametersValue)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.parameters', 'parameters must be a plain object');
  }
  if (!Array.isArray(actorRolesValue)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.actorRoles', 'actorRoles must be an array');
  }
  // Snapshot first, then judge the snapshot. `actorRoles` used to be read as a live
  // array (length here, `[...spread]` there), which let a Proxy answer "1" for the
  // bound check and hand back six roles — or an endless iterator that hung
  // `prepare`. Both are now impossible: the copy is made through data descriptors
  // with a single `length` read, and no `Symbol.iterator` is ever invoked.
  const actorRoles = snapshotValue(actorRolesValue, '$.actorRoles');
  if (actorRoles.length === 0 || actorRoles.length > MAX_ROLES) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.actorRoles', 'actorRoles must be a 1..5 element array', {
      maxRoles: MAX_ROLES,
      roles: actorRoles.length,
    });
  }
  for (const role of actorRoles) {
    if (typeof role !== 'string' || role.length === 0 || role.length > 32) {
      helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.actorRoles', 'actorRoles must contain short strings');
    }
  }
  for (const [name, candidate] of [
    ['proposal', proposalValue],
    ['approval', approvalValue],
    ['grant', grantValue],
    ['replay', replayValue],
  ]) {
    if (candidate !== undefined && candidate !== null && !isPlainObject(candidate)) {
      helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, `$.${name}`, `${name} must be an object when present`);
    }
  }

  return Object.freeze({
    schemaVersion: INTERFACE_VERSION,
    execution_id: executionId,
    attempt_id: attemptId,
    lease_id: leaseId,
    sequence,
    os,
    policyVersion,
    now,
    actionId,
    target: snapshotTarget(targetValue),
    parameters: parametersValue === undefined || parametersValue === null
      ? undefined
      : snapshotValue(parametersValue, '$.parameters'),
    actorRoles,
    epoch,
    proposal: proposalValue === undefined || proposalValue === null
      ? undefined
      : snapshotValue(proposalValue, '$.proposal'),
    approval: approvalValue === undefined || approvalValue === null
      ? undefined
      : snapshotValue(approvalValue, '$.approval'),
    grant: grantValue === undefined || grantValue === null
      ? undefined
      : snapshotValue(grantValue, '$.grant'),
    replay: replayValue === undefined || replayValue === null
      ? undefined
      : snapshotValue(replayValue, '$.replay'),
  });
}

/**
 * Optional-field helper reused by `describe`-driven callers and tests.
 *
 * @param {unknown} value Candidate.
 * @param {string} path Field path.
 * @returns {string | null} Bounded string or `null`.
 */
export function readOptionalIdentifier(value, path) {
  if (value === undefined || value === null) return null;
  return requireString(value, path, 128);
}
