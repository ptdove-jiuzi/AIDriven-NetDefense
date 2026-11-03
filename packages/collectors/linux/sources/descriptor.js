/**
 * Source declaration contract (§5.1 "每源保存 lifecycle、last_success、last_event、last_error、
 * last_gap、权限说明").
 *
 * Every Linux source must publish, *in data*, and not only in prose comments:
 *
 *   permissions   what a non-root collector needs, what it can only get as root, and which
 *                 fields disappear without it;
 *   intervalMs    the polling cadence the design matrix prescribes (5 s process/net,
 *                 60 s persistence), so a runtime cannot silently poll faster;
 *   fields        per-field completeness, so a detector can refuse to reason about a field
 *                 it may not have;
 *   blindSpots    what polling structurally cannot see (short-lived processes/connections);
 *   rotation      how a changed/rotated/truncated backing store is detected;
 *   gapSemantics  which gap reasons this source can emit and what "empty" means;
 *   degradation   what happens without permission — and the hard rule that a denied read is
 *                 never reported as an empty-but-healthy result.
 *
 * `assertSourceDescriptor` makes that machine-checkable: a source that forgets one of the
 * seven cannot be constructed, and the test suite asserts it for every registered source.
 */

import { GAP_REASONS } from '../../common/index.js';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertNonEmptyString,
  assertPositiveInteger,
  assertVirtualPath,
  isLinuxCollectorError,
} from '../errors.js';

export const FIELD_COMPLETENESS = Object.freeze(['always', 'admin', 'best_effort', 'opt_in']);
export const SENSITIVITY_LEVELS = Object.freeze(['D1', 'D2', 'D3']);
export const READ_STATUSES = Object.freeze(['ok', 'partial', 'denied', 'error', 'rotated']);

/**
 * Read outcome → runtime decision.
 *
 * - `ok`       publish and commit; the source may return to `ready`.
 * - `partial`  publish what was read but stay degraded: something was structurally
 *              invisible (a denied path, a malformed line, a missing table).
 * - `denied`   publish nothing and do NOT advance the cursor. The source becomes
 *              `unavailable` with the missing permission named; this is the case the task
 *              forbids from being reported as an empty-but-healthy result.
 * - `error`    publish nothing, stay `degraded`, record an io_error gap.
 * - `rotated`  the backing store was replaced or truncated; publish nothing, advance the
 *              generation (the caller supplies the reason) and let the next read start from
 *              the head of the new generation.
 *
 * `gapReason: null` means "derive it from the read result" (a partial read with denials is a
 * permission gap; a partial read without denials is an io_error/parse gap).
 */
export const DEGRADATION_POLICY = Object.freeze({
  ok: Object.freeze({ publish: true, lifecycle: 'ready', gapReason: null }),
  partial: Object.freeze({ publish: true, lifecycle: 'degraded', gapReason: null }),
  denied: Object.freeze({ publish: false, lifecycle: 'unavailable', gapReason: 'permission_denied' }),
  error: Object.freeze({ publish: false, lifecycle: 'degraded', gapReason: 'io_error' }),
  rotated: Object.freeze({ publish: false, lifecycle: 'degraded', gapReason: null }),
});

/**
 * Source-specific condition → shared gap reason. The shared ledger has a closed reason set
 * (`common/gap-ledger.js`), so every adapter condition has to be mapped explicitly instead
 * of inventing new strings.
 */
export const GAP_REASON_BY_CONDITION = Object.freeze({
  permission_denied: 'permission_denied',
  partial_permission: 'permission_denied',
  rotated: 'log_rotated',
  truncated: 'log_truncated',
  cleared: 'log_cleared_reset',
  generation_reset: 'generation_reset',
  cursor_reset: 'cursor_reset',
  read_truncated: 'io_error',
  backlog_skipped: 'read_overlap_skipped',
  io_error: 'io_error',
  subscription_failed: 'subscription_failed',
});

// `log_cleared` is a generation reason, not a gap reason; it is folded into
// `generation_reset` by the shared collector. Keep the mapping honest about that.
const NORMALIZED_CONDITION_TO_GAP_REASON = Object.freeze({
  ...GAP_REASON_BY_CONDITION,
  cleared: 'generation_reset',
});

const GAP_REASON_SET = new Set(GAP_REASONS);

export function gapReasonFor(condition) {
  const mapped = NORMALIZED_CONDITION_TO_GAP_REASON[condition];
  if (mapped === undefined) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `No gap reason mapping for condition: ${String(condition)}`,
      { condition: typeof condition === 'string' ? condition : null },
    );
  }
  if (!GAP_REASON_SET.has(mapped)) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `Mapped gap reason is not part of the shared ledger: ${mapped}`,
      { condition, reason: mapped },
    );
  }
  return mapped;
}

export function assertGapReason(reason) {
  if (typeof reason !== 'string' || !GAP_REASON_SET.has(reason)) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `Unknown shared gap reason: ${String(reason)}`,
      { reason: typeof reason === 'string' ? reason : null },
    );
  }
  return reason;
}

function assertStringArray(name, value, { allowEmpty = false, minLength = 1 } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be ${allowEmpty ? 'an' : 'a non-empty'} array`,
      { name },
    );
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length < minLength) {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        `${name} must contain non-empty strings`,
        { name, entry: entry === undefined ? null : String(entry) },
      );
    }
  }
  return Object.freeze([...value]);
}

function assertFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'fields must be a non-empty array');
  }
  const seen = new Set();
  const normalized = fields.map((field) => {
    if (field === null || typeof field !== 'object') {
      throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'every field must be an object');
    }
    assertNonEmptyString('field.name', field.name);
    if (seen.has(field.name)) {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        `duplicate field declaration: ${field.name}`,
        { field: field.name },
      );
    }
    seen.add(field.name);
    assertNonEmptyString('field.type', field.type);
    if (!FIELD_COMPLETENESS.includes(field.completeness)) {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        `field ${field.name} has an unknown completeness: ${String(field.completeness)}`,
        { field: field.name, completeness: String(field.completeness) },
      );
    }
    if (!SENSITIVITY_LEVELS.includes(field.sensitivity)) {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        `field ${field.name} has an unknown sensitivity: ${String(field.sensitivity)}`,
        { field: field.name, sensitivity: String(field.sensitivity) },
      );
    }
    return Object.freeze({
      name: field.name,
      type: field.type,
      completeness: field.completeness,
      sensitivity: field.sensitivity,
    });
  });
  return Object.freeze(normalized);
}

function assertPermissions(permissions) {
  if (permissions === null || typeof permissions !== 'object') {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'permissions must be an object');
  }
  const required = assertStringArray('permissions.required', permissions.required);
  const optional = assertStringArray('permissions.optional', permissions.optional, { allowEmpty: true });
  const degradedWithout = assertStringArray(
    'permissions.degradedWithout',
    permissions.degradedWithout,
    { allowEmpty: true },
  );
  return Object.freeze({ required, optional, degradedWithout });
}

function assertDegradation(degradation) {
  if (degradation === null || typeof degradation !== 'object') {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'degradation must be an object');
  }
  if (degradation.neverHealthyWhenEmpty !== true) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'degradation.neverHealthyWhenEmpty must be true: a denied read may not look like a healthy empty result',
    );
  }
  assertNonEmptyString('degradation.onDenied', degradation.onDenied);
  assertNonEmptyString('degradation.onPartial', degradation.onPartial);
  assertNonEmptyString('degradation.onEmptyTable', degradation.onEmptyTable);
  return Object.freeze({
    onDenied: degradation.onDenied,
    onPartial: degradation.onPartial,
    onEmptyTable: degradation.onEmptyTable,
    neverHealthyWhenEmpty: true,
  });
}

/**
 * Validate and freeze a source descriptor. Throws when any of the seven required
 * declarations is missing or malformed, or when a declared gap reason is not part of the
 * shared ledger.
 */
export function assertSourceDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'descriptor must be an object');
  }
  assertNonEmptyString('descriptor.stableSourceId', descriptor.stableSourceId);
  if (descriptor.kind !== 'poll' && descriptor.kind !== 'event') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      "descriptor.kind must be 'poll' or 'event'",
      { kind: String(descriptor.kind) },
    );
  }
  assertPositiveInteger('descriptor.intervalMs', descriptor.intervalMs);
  if (descriptor.kind === 'event') {
    assertPositiveInteger('descriptor.subscriptionProbeIntervalMs', descriptor.subscriptionProbeIntervalMs);
  }

  const permissions = assertPermissions(descriptor.permissions);
  const fields = assertFields(descriptor.fields);
  const blindSpots = assertStringArray('blindSpots', descriptor.blindSpots);
  assertNonEmptyString('rotation', descriptor.rotation);
  const gapSemantics = assertStringArray('gapSemantics', descriptor.gapSemantics);
  const degradation = assertDegradation(descriptor.degradation);
  const emits = assertStringArray('emits', descriptor.emits, { allowEmpty: false });
  const emittedGapReasons = assertStringArray(
    'emittedGapReasons',
    descriptor.emittedGapReasons,
    { allowEmpty: false },
  );
  for (const reason of emittedGapReasons) {
    assertGapReason(reason);
  }
  const paths = assertStringArray('declaredPaths', descriptor.declaredPaths, { allowEmpty: false });
  for (const path of paths) {
    assertVirtualPath('declaredPaths', path.replace(/\*$/, '').replace(/\/$/, '') || '/');
  }

  return Object.freeze({
    stableSourceId: descriptor.stableSourceId,
    platform: 'linux',
    kind: descriptor.kind,
    intervalMs: descriptor.intervalMs,
    subscriptionProbeIntervalMs: descriptor.subscriptionProbeIntervalMs ?? null,
    requiresRoot: descriptor.requiresRoot === true,
    departments: descriptor.departments ?? null,
    permissions,
    fields,
    blindSpots,
    rotation: descriptor.rotation,
    gapSemantics,
    degradation,
    emits: Object.freeze([...emits]),
    emittedGapReasons: Object.freeze([...emittedGapReasons]),
    declaredPaths: Object.freeze([...paths]),
  });
}

/**
 * Validate the value every adapter `read()` returns. The runtime relies on this shape to
 * decide publish/degrade, so a malformed read result must fail loudly instead of turning
 * into a silent "no records" success.
 */
export function assertReadResult(result, { stableSourceId } = {}) {
  if (result === null || typeof result !== 'object') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `read() must return an object${stableSourceId === undefined ? '' : ` (${stableSourceId})`}`,
    );
  }
  if (!READ_STATUSES.includes(result.status)) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `read() status must be one of ${READ_STATUSES.join('/')}, got ${String(result.status)}`,
    );
  }
  if (!Array.isArray(result.records)) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'read() must return a records array');
  }
  const denials = result.denials === undefined ? [] : result.denials;
  if (!Array.isArray(denials)) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'read() denials must be an array');
  }
  for (const denial of denials) {
    if (denial === null || typeof denial !== 'object' || typeof denial.path !== 'string') {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        'every denial must be an object with a path',
      );
    }
  }
  const permissions = result.permissions ?? { granted: [], missing: [] };
  if (!Array.isArray(permissions.missing)) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'read() permissions.missing must be an array',
    );
  }
  // The invariant the whole task hinges on: a read that could not see its data must not be
  // dressed up as a successful empty read. Read the normalized `denials` above, not
  // `result.denials`: an omitted field is a legal "no denials" and `.length` on it threw a
  // TypeError, which turned a valid `{status:'ok', records:[]}` into a crash.
  if (result.status === 'ok' && denials.length > 0) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a read with denials must report status partial or denied, never ok',
    );
  }
  if (result.status === 'denied' && result.records.length > 0) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a denied read must not carry records',
    );
  }
  if (result.status === 'denied' && permissions.missing.length === 0) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a denied read must name at least one missing permission or path',
    );
  }
  if (result.status === 'rotated') {
    if (result.records.length > 0) {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        'a rotated read must not carry records from the previous generation',
      );
    }
    const reason = result.rotation === null || typeof result.rotation !== 'object'
      ? null
      : result.rotation.reason;
    if (reason !== 'log_rotated' && reason !== 'log_truncated' && reason !== 'log_cleared') {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        'a rotated read must name log_rotated, log_truncated or log_cleared',
        { reason: reason === null ? null : String(reason) },
      );
    }
  }
  return result;
}

export function isLinuxError(value) {
  return isLinuxCollectorError(value);
}
