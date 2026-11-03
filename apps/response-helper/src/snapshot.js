/**
 * snapshot.js — target snapshot and drift detection.
 *
 * Design §10.2 is blunt about this: a bare PID is not a process identity, a path
 * string is not a file identity, and a rule that is not ours is not a network
 * target. So the helper takes a snapshot of the *object* the policy decision bound
 * to, and re-checks it against the object that exists now, immediately before it
 * would act. This module is the "immediately before" half; the side effect itself
 * is compiled out of this build.
 *
 * Two properties are deliberate:
 *
 * 1. **Digests, not values.** A snapshot carries the observed identity as a
 *    canonical digest plus the observed object id. Raw paths and addresses stay
 *    local: the plan document may be logged or shipped to the console, and design
 *    §4 keeps local display data out of anything wire-shaped.
 * 2. **Drift is a first-class value, not an exception.** Every mismatch produces
 *    one or more typed reasons so the refusal an operator reads says *why* — PID
 *    reused, path replaced, object unverifiable — instead of a generic "target
 *    changed".
 */

import { canonicalDigest } from '@aegisharness/contracts';
import { helperFail, HELPER_CODES } from './errors.js';
import { validateObservation } from './ports.js';

/**
 * Identity fields that take part in the comparison, per target kind.
 *
 * A probe may report more than this (a pid, a start time it could not resolve);
 * only the declared fields are digested, so a chatty probe cannot change the
 * comparison result by attaching extra keys.
 */
const IDENTITY_FIELDS = Object.freeze({
  file: Object.freeze(['path']),
  process: Object.freeze(['image_path', 'start_time']),
  network: Object.freeze(['protocol', 'local_address', 'local_port', 'remote_address', 'remote_port']),
});

/** Drift reason codes. Closed; each maps to exactly one helper refusal code. */
export const DRIFT_REASONS = Object.freeze({
  /** Nothing exists at the target's coordinates. */
  TARGET_MISSING: 'TARGET_MISSING',
  /** Existence could not be established; must never be read as "gone". */
  TARGET_UNVERIFIABLE: 'TARGET_UNVERIFIABLE',
  /** The object lives on a different OS family than the dispatch declared. */
  OS_MISMATCH: 'OS_MISMATCH',
  /** Same pid, different object: the classic PID-reuse race. */
  PID_REUSE: 'PID_REUSE',
  /** The path now resolves to a different file object. */
  PATH_REPLACED: 'PATH_REPLACED',
  /** Same kind of object, different identity anchor. */
  OBJECT_ID_MISMATCH: 'OBJECT_ID_MISMATCH',
  /** Same object id, different identity: moved, re-created or re-bound. */
  IDENTITY_DRIFT: 'IDENTITY_DRIFT',
});

/** Drift reason → helper refusal code. */
const CODE_FOR_DRIFT = Object.freeze({
  TARGET_MISSING: HELPER_CODES.HELPER_TARGET_MISSING,
  TARGET_UNVERIFIABLE: HELPER_CODES.HELPER_TARGET_UNVERIFIABLE,
  OS_MISMATCH: HELPER_CODES.HELPER_OS_MISMATCH,
  PID_REUSE: HELPER_CODES.HELPER_TARGET_DRIFT,
  PATH_REPLACED: HELPER_CODES.HELPER_TARGET_DRIFT,
  OBJECT_ID_MISMATCH: HELPER_CODES.HELPER_TARGET_DRIFT,
  IDENTITY_DRIFT: HELPER_CODES.HELPER_TARGET_DRIFT,
});

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/**
 * Project an identity object onto the declared comparison fields.
 *
 * @param {string} kind Target kind.
 * @param {object} identity Identity bag.
 * @returns {object} Only the declared fields that are present.
 */
function pickIdentity(kind, identity) {
  const fields = IDENTITY_FIELDS[kind];
  const picked = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(identity, field)) picked[field] = identity[field];
  }
  return picked;
}

/**
 * @param {string} kind Target kind.
 * @param {object} identity Identity bag.
 * @returns {string} Canonical digest of the declared identity fields.
 */
export function identityDigest(kind, identity) {
  return canonicalDigest(pickIdentity(kind, identity));
}

/**
 * Capture one snapshot of a normalised target.
 *
 * @param {{ target: object, observation: unknown, capturedAt: string }} input Parts.
 * @returns {Readonly<object>} Frozen snapshot.
 * @throws {import('./errors.js').HelperError} When the timestamp is not RFC3339 UTC.
 */
export function buildSnapshot(input) {
  const target = input.target;
  if (target === null || typeof target !== 'object' || typeof target.kind !== 'string') {
    helperFail(HELPER_CODES.HELPER_PROBE_INVALID, '$.target', 'snapshot needs a normalised target');
  }
  if (typeof input.capturedAt !== 'string' || !RFC3339_UTC.test(input.capturedAt)) {
    helperFail(HELPER_CODES.HELPER_ENVELOPE_INVALID, '$.capturedAt', 'capturedAt must be RFC3339 UTC');
  }
  const observation = validateObservation(input.observation);
  const present = observation.state === 'present';

  return Object.freeze({
    kind: target.kind,
    os: target.os,
    state: observation.state,
    reason: observation.reason,
    target_digest: target.digest,
    target_object_id: target.objectId,
    observed_object_id: present ? observation.objectId : null,
    observed_identity_digest: present ? identityDigest(target.kind, observation.identity) : null,
    observed_os: present ? observation.os : null,
    observed_pid: present ? observation.pid : null,
    identity_matches: present
      ? identityDigest(target.kind, observation.identity) === identityDigest(target.kind, target.identity)
      : null,
    /** When the probe says it looked; `null` when the probe did not report it. */
    observed_at: observation.observedAt,
    /** When the helper captured the snapshot — the dispatch's own `now`. */
    captured_at: input.capturedAt,
  });
}

/**
 * Compare a snapshot with the target the decision bound to.
 *
 * @param {{ target: object, snapshot: object }} input Normalised target and snapshot.
 * @returns {Readonly<{status: 'clean' | 'drifted', reasons: readonly object[]}>} Drift result.
 */
export function detectDrift(input) {
  const target = input.target;
  const snapshot = input.snapshot;
  const reasons = [];

  if (snapshot.state === 'absent') {
    reasons.push(Object.freeze({ code: DRIFT_REASONS.TARGET_MISSING, detail: { reason: snapshot.reason } }));
  } else if (snapshot.state === 'unverifiable') {
    reasons.push(Object.freeze({
      code: DRIFT_REASONS.TARGET_UNVERIFIABLE,
      detail: { reason: snapshot.reason },
    }));
  } else {
    if (snapshot.observed_os !== null && snapshot.observed_os !== target.os) {
      reasons.push(Object.freeze({
        code: DRIFT_REASONS.OS_MISMATCH,
        detail: { declared: target.os, observed: snapshot.observed_os },
      }));
    }
    if (snapshot.observed_object_id !== target.objectId) {
      // Which *kind* of mismatch this is decides the operator-facing reason, and
      // the reason is what makes the race diagnosable: "same pid, new object" is
      // a PID reuse, "same path, new file" is a replacement, neither is "unknown".
      if (target.kind === 'process' && snapshot.observed_pid !== null && snapshot.observed_pid === target.pid) {
        reasons.push(Object.freeze({
          code: DRIFT_REASONS.PID_REUSE,
          detail: { pid: target.pid },
        }));
      } else if (target.kind === 'file') {
        reasons.push(Object.freeze({ code: DRIFT_REASONS.PATH_REPLACED, detail: { kind: 'file' } }));
      } else {
        reasons.push(Object.freeze({
          code: DRIFT_REASONS.OBJECT_ID_MISMATCH,
          detail: { kind: target.kind },
        }));
      }
    } else if (snapshot.identity_matches === false) {
      reasons.push(Object.freeze({
        code: DRIFT_REASONS.IDENTITY_DRIFT,
        detail: { kind: target.kind },
      }));
    }
  }

  return Object.freeze({
    status: reasons.length === 0 ? 'clean' : 'drifted',
    reasons: Object.freeze(reasons),
  });
}

/**
 * Map a drift result to the first helper refusal code.
 *
 * @param {{reasons: readonly object[]}} drift Drift result.
 * @returns {string | null} Helper code, or `null` when clean.
 */
export function refusalCodeForDrift(drift) {
  const first = drift.reasons[0];
  if (first === undefined) return null;
  return CODE_FOR_DRIFT[first.code] ?? HELPER_CODES.HELPER_TARGET_DRIFT;
}

/**
 * Static, per-action post-state description used by the recovery manifest.
 *
 * A manifest that says "expected_state: done" is useless during a rescue; these
 * strings name the object state a rescue would look for.
 */
export const EXPECTED_STATE = Object.freeze({
  'observe.record_alert': 'unchanged',
  'process.suspend': 'suspended',
  'process.terminate': 'terminated',
  'network.block_connection': 'rule_present_owned',
  'network.isolate': 'isolated_owned',
  'file.quarantine': 'relocated_to_quarantine',
});
