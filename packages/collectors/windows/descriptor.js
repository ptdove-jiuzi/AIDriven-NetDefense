/**
 * Source descriptor: the declaration the design (§5.1) requires for every source.
 *
 * §5.1 does not only ask for records; it asks each source to declare, up front, what it
 * can and cannot see:
 * - the required and optional permissions, and **what degrades** without them,
 * - the poll interval (or the subscription probe interval for event-driven sources),
 * - per-field completeness (`always` / `admin` / `best_effort`),
 * - the blind spots that polling cannot closed (short-lived objects),
 * - the rotation semantics (whether a generation ever needs to advance).
 *
 * A descriptor that is missing any of these cannot be published to the daemon because the
 * operator would have no way to read "partially blind" as anything other than "broken".
 * That is why this module validates instead of merely tagging along.
 */

import { WINDOWS_ERROR_CODES, WindowsCollectorError } from './errors.js';
import { assertStableSourceId } from '../common/index.js';

export const COMPLETENESS = Object.freeze(['always', 'admin', 'best_effort']);
export const SOURCE_KINDS = Object.freeze(['poll', 'event']);
export const SENSITIVITIES = Object.freeze(['D0', 'D1', 'D2', 'D3']);

// Field names are the *payload* keys, so they must satisfy the same contract pattern as
// the emitted event. Keeping one spelling avoids a translation layer that silently drifts.
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function invalid(message, details) {
  return new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_CONFIG, message, { details });
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function assertStringList(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) {
    throw invalid(`${label} must be an array of strings`);
  }
  if (!allowEmpty && value.length === 0) {
    throw invalid(`${label} must not be empty`);
  }
  for (const entry of value) {
    assertNonEmptyString(entry, `${label} entry`);
  }
  return Object.freeze([...value]);
}

function assertFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw invalid('fields must be a non-empty array');
  }
  const seen = new Set();
  const normalized = fields.map((field) => {
    if (field === null || typeof field !== 'object') {
      throw invalid('every field declaration must be an object');
    }
    if (!FIELD_NAME_PATTERN.test(field.name ?? '')) {
      throw invalid('field name must be a snake_case payload key', { name: field.name ?? null });
    }
    if (seen.has(field.name)) {
      throw invalid('duplicate field declaration', { name: field.name });
    }
    seen.add(field.name);
    if (!COMPLETENESS.includes(field.completeness)) {
      throw invalid('field completeness must be one of always, admin, best_effort', {
        name: field.name,
        completeness: field.completeness ?? null,
      });
    }
    if (!SENSITIVITIES.includes(field.sensitivity)) {
      throw invalid('field sensitivity must be one of D0..D3', {
        name: field.name,
        sensitivity: field.sensitivity ?? null,
      });
    }
    assertNonEmptyString(field.type, `field ${field.name} type`);
    return Object.freeze({
      name: field.name,
      type: field.type,
      completeness: field.completeness,
      sensitivity: field.sensitivity,
    });
  });
  return Object.freeze(normalized);
}

/**
 * @param {object} config
 * @param {string} config.stableSourceId          stable, restart-invariant logical identity
 * @param {'poll'|'event'} config.kind
 * @param {number} config.intervalMs              poll interval, or subscription probe interval
 * @param {object} config.permissions             { required, optional, degradedWithout }
 * @param {Array} config.fields
 * @param {string[]} config.blindSpots
 * @param {string[]} config.gapSemantics
 * @param {string} config.rotation
 * @param {string} config.type                    telemetry event `type`
 */
export function createSourceDescriptor(config = {}) {
  if (config === null || typeof config !== 'object') {
    throw invalid('descriptor configuration must be an object');
  }
  const stableSourceId = assertStableSourceId(config.stableSourceId);
  if (!SOURCE_KINDS.includes(config.kind)) {
    throw invalid('kind must be poll or event', { kind: config.kind ?? null });
  }
  if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1) {
    throw invalid('intervalMs must be a positive integer', { intervalMs: config.intervalMs ?? null });
  }
  assertNonEmptyString(config.type, 'type');
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*){1,3}$/.test(config.type)) {
    throw invalid('type must be a dotted lowercase identifier with 2 to 4 segments', { type: config.type });
  }

  const permissions = config.permissions;
  if (permissions === null || typeof permissions !== 'object') {
    throw invalid('permissions must be declared');
  }
  const required = assertStringList(permissions.required, 'permissions.required', { allowEmpty: false });
  const optional = assertStringList(permissions.optional ?? [], 'permissions.optional');
  const degradedWithout = assertStringList(permissions.degradedWithout ?? [], 'permissions.degradedWithout');

  const blindSpots = assertStringList(config.blindSpots, 'blindSpots', { allowEmpty: false });
  const gapSemantics = assertStringList(config.gapSemantics, 'gapSemantics', { allowEmpty: false });
  const rotation = assertNonEmptyString(config.rotation, 'rotation');
  const fields = assertFields(config.fields);

  return Object.freeze({
    stableSourceId,
    kind: config.kind,
    intervalMs: config.intervalMs,
    type: config.type,
    permissions: Object.freeze({
      required,
      optional,
      degradedWithout,
    }),
    fields,
    blindSpots,
    gapSemantics,
    rotation,
    // Declared up front so the daemon never has to guess whether an `identity` return
    // value means "a log that can rotate" or "a point-in-time table".
    generationAware: config.kind === 'event',
    sensitivity: highestSensitivity(fields),
  });
}

function highestSensitivity(fields) {
  let highest = 'D0';
  for (const field of fields) {
    if (SENSITIVITIES.indexOf(field.sensitivity) > SENSITIVITIES.indexOf(highest)) {
      highest = field.sensitivity;
    }
  }
  return highest;
}

/**
 * Fields that stop being reliable when a permission is missing.
 * Returns `[]` when the source is fully privileged, so callers can branch on emptiness
 * instead of on a boolean that hides *which* fields were lost.
 */
export function degradedFields(descriptor, { elevated = false } = {}) {
  if (elevated) {
    return Object.freeze([]);
  }
  const lost = descriptor.fields
    .filter((field) => field.completeness === 'admin')
    .map((field) => field.name);
  return Object.freeze(lost);
}

/**
 * Compare the permissions the collector actually holds against the declaration.
 * The daemon uses `missing` to latch the source as `unavailable` (never as an empty
 * result), and `degraded` to keep feeding partial records while reporting the loss.
 */
export function assessPermissions(descriptor, heldPermissions = []) {
  const held = new Set(heldPermissions);
  const missing = descriptor.permissions.required.filter((entry) => !held.has(entry));
  const degraded = missing.length === 0
    ? degradedFields(descriptor, { elevated: true })
    : degradedFields(descriptor, { elevated: false });
  return Object.freeze({
    missing: Object.freeze(missing),
    degraded,
    available: missing.length === 0,
  });
}
