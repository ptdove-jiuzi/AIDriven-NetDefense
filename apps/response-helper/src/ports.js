/**
 * ports.js — the only way this helper learns anything about the outside world.
 *
 * Every OS-facing question is asked through one of five injected ports:
 *
 *   osProbe.osFamily()          which OS family is this helper running on?
 *   capabilityProbe.capabilities()  does this service identity hold the privilege?
 *   targetProbe.observe()       is the object still there, and still the same one?
 *   grantVerifier.verify()      does the signature chain back to a trust root?
 *   inbox / manifestStore       dedupe and recovery-intent recording
 *
 * The module itself imports **no** `node:fs`, `node:net`, `node:os` or
 * `node:child_process`; `tests/wp7-response-helper/isolation.test.js` scans the
 * sources and fails if one appears. Tests inject static probes, so the whole suite
 * runs without touching a real process, socket or file.
 *
 * The default implementations are deliberately useless (fail closed): the null
 * probes answer "unknown", the null verifier answers "no trust root". A helper
 * created with no ports therefore produces blocked plans, never a runnable one.
 * That is the correct default for a build where execution is compiled out.
 */

import { helperFail, HELPER_CODES } from './errors.js';

/** Capability names the helper asks about. One per OS surface it would touch. */
export const CAPABILITIES = Object.freeze([
  'process_control',
  'network_control',
  'file_control',
]);

/** Tri-state capability answers. Only `granted` is usable; the rest fail closed. */
export const CAPABILITY_STATES = Object.freeze(['granted', 'denied', 'unknown']);

/** OS families this helper can plan for. */
export const OS_FAMILIES = Object.freeze(['windows', 'linux']);

/** Observation outcomes for a target probe. */
export const OBSERVATION_STATES = Object.freeze(['present', 'absent', 'unverifiable']);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * OS family probe driven by an explicit declaration.
 *
 * Used by tests and by any caller that already resolved the platform; it touches
 * nothing.
 *
 * @param {string} family `windows` or `linux`.
 * @returns {{ osFamily: () => string, source: string }} Probe.
 */
export function createStaticOsProbe(family) {
  return {
    source: 'static',
    osFamily() {
      return OS_FAMILIES.includes(family) ? family : 'unsupported';
    },
  };
}

/**
 * OS family probe for the real host.
 *
 * Reads `process.platform`, which is a constant recorded by the runtime at start
 * up — not a probe of any object, and not something a target can influence. The
 * *target's* OS is never inferred from here: design §10.2 requires the dispatch to
 * declare it, and `response-policy` denies a target whose `os` disagrees.
 *
 * @returns {{ osFamily: () => string, source: string }} Probe.
 */
export function createHostOsProbe() {
  return {
    source: 'host',
    osFamily() {
      const platform = typeof process === 'object' && process !== null ? process.platform : '';
      if (platform === 'win32') return 'windows';
      if (platform === 'linux') return 'linux';
      return 'unsupported';
    },
  };
}

/**
 * Clock port answering from the real system clock.
 *
 * The policy layer deliberately never reads a clock — a decision must be
 * reproducible from its inputs. The helper is the opposite case: design §10.2
 * requires it to verify the time window *independently*, and an independent check
 * that trusts the caller's `now` is not independent at all. So the helper has a
 * clock, and it compares the dispatch's `now` against it.
 *
 * Reading `Date.now()` touches no process, socket or file.
 *
 * @returns {{ nowMs: () => number, source: string }} Clock.
 */
export function createSystemClock() {
  return {
    source: 'system',
    nowMs() {
      return Date.now();
    },
  };
}

/**
 * Clock port frozen at one instant. Used by tests and by replay tooling.
 *
 * @param {string} timestamp Strict RFC3339 UTC.
 * @returns {{ nowMs: () => number, source: string }} Clock.
 */
export function createFixedClock(timestamp) {
  const fixed = Date.parse(timestamp);
  return {
    source: 'fixed',
    nowMs() {
      return Number.isFinite(fixed) ? fixed : Number.NaN;
    },
  };
}

/**
 * Capability probe that answers from a fixed table.
 *
 * @param {Record<string, string>} table Capability → state.
 * @returns {{ capabilities: (request: object) => object, source: string }} Probe.
 */
export function createStaticCapabilityProbe(table) {
  const frozen = Object.freeze({ ...table });
  return {
    source: 'static',
    capabilities() {
      return frozen;
    },
  };
}

/**
 * Capability probe that answers "unknown" for everything.
 *
 * The correct default: an unconfigured helper must not claim a privilege it never
 * checked, and `unknown` is treated as denied by the planner.
 *
 * @returns {{ capabilities: () => object, source: string }} Probe.
 */
export function createNullCapabilityProbe() {
  const unknown = Object.freeze({
    process_control: 'unknown',
    network_control: 'unknown',
    file_control: 'unknown',
  });
  return {
    source: 'null',
    capabilities() {
      return unknown;
    },
  };
}

/**
 * Validate one observation returned by a target probe.
 *
 * A probe is a port, so its answer is untrusted input like any other: a malformed
 * observation must be a refusal, not a `TypeError` deep inside the drift check.
 *
 * @param {unknown} value Candidate observation.
 * @returns {Readonly<object>} Frozen normalised observation.
 * @throws {import('./errors.js').HelperError} When the shape is not declared.
 */
export function validateObservation(value) {
  if (!isPlainObject(value)) {
    helperFail(HELPER_CODES.HELPER_PROBE_INVALID, '$.observation', 'observation must be a plain object');
  }
  const state = value.state;
  if (!OBSERVATION_STATES.includes(state)) {
    helperFail(HELPER_CODES.HELPER_PROBE_INVALID, '$.observation.state', 'undeclared observation state');
  }
  if (state !== 'present') {
    return Object.freeze({
      state,
      reason: typeof value.reason === 'string' ? value.reason.slice(0, 64) : null,
      observedAt: typeof value.observedAt === 'string' ? value.observedAt : null,
    });
  }
  if (typeof value.objectId !== 'string' || value.objectId.length === 0 || value.objectId.length > 128) {
    helperFail(
      HELPER_CODES.HELPER_PROBE_INVALID,
      '$.observation.objectId',
      'a present observation must carry the observed object id',
    );
  }
  if (!isPlainObject(value.identity)) {
    helperFail(HELPER_CODES.HELPER_PROBE_INVALID, '$.observation.identity', 'identity must be a plain object');
  }
  if (value.os !== undefined && !OS_FAMILIES.includes(value.os)) {
    helperFail(HELPER_CODES.HELPER_PROBE_INVALID, '$.observation.os', 'observation os must be linux or windows');
  }
  if (value.pid !== undefined && value.pid !== null && !Number.isSafeInteger(value.pid)) {
    helperFail(HELPER_CODES.HELPER_PROBE_INVALID, '$.observation.pid', 'pid must be an integer when present');
  }
  return Object.freeze({
    state,
    objectId: value.objectId,
    identity: Object.freeze({ ...value.identity }),
    os: value.os ?? null,
    pid: value.pid ?? null,
    observedAt: typeof value.observedAt === 'string' ? value.observedAt : null,
  });
}

/**
 * Target probe that can never find anything.
 *
 * @returns {{ observe: () => object, source: string }} Probe.
 */
export function createNullTargetProbe() {
  return {
    source: 'null',
    observe() {
      return { state: 'unverifiable', reason: 'probe_not_configured' };
    },
  };
}

/**
 * Target probe answering from a fixed observation (or a function producing one).
 *
 * @param {object | (() => object)} observation Fixed observation or factory.
 * @returns {{ observe: (request: object) => object, source: string }} Probe.
 */
export function createStaticTargetProbe(observation) {
  return {
    source: 'static',
    observe() {
      return typeof observation === 'function' ? observation() : observation;
    },
  };
}

/**
 * Grant verifier that refuses everything.
 *
 * This build has no configured trust root, so the honest answer is "cannot
 * verify". The planner turns that into a blocked plan rather than assuming a
 * signature it never checked.
 *
 * @returns {{ verify: () => object, source: string }} Verifier.
 */
export function createNullGrantVerifier() {
  return {
    source: 'null',
    verify() {
      return { ok: false, reason: 'no_trust_root_configured' };
    },
  };
}

/**
 * Grant verifier answering from a fixed result.
 *
 * @param {{ok: boolean, keyId?: string, reason?: string}} result Fixed answer.
 * @returns {{ verify: () => object, source: string }} Verifier.
 */
export function createStaticGrantVerifier(result) {
  const frozen = Object.freeze({ ...result });
  return {
    source: 'static',
    verify() {
      return frozen;
    },
  };
}

/**
 * In-memory inbox implementing dispatch dedupe.
 *
 * Design §10.1: `dispatch_pending` may resend the same grant, and the helper inbox
 * dedupes so a retry never becomes a second action. The same `execution_id` with a
 * **different** `attempt_id` is not a retry — it is an ambiguous claim on an
 * execution already accepted, so it conflicts instead of silently forking.
 *
 * This is an in-memory structure: it proves the interface and the semantics, and
 * it is explicitly **not** durable across restarts. Durability belongs to the
 * daemon transaction / a persisted inbox, which is out of this round's scope.
 *
 * Capacity is **fail-closed**. An earlier draft evicted the oldest entry, which
 * silently turned the 257th dispatch into a fresh one: the same execution could be
 * re-planned, and a different attempt on an accepted execution stopped conflicting.
 * A full inbox now refuses the claim instead, so the failure is visible in an audit
 * row rather than in a duplicate response action.
 *
 * @param {{ maxEntries?: number }} [options] Bounded size.
 * @returns {object} Inbox.
 */
export function createMemoryInbox(options = {}) {
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : 256;
  /** @type {Map<string, object>} */
  const byExecution = new Map();
  /** @type {Set<string>} */
  const nonces = new Set();

  return {
    /**
     * Reserve an execution/attempt pair before doing any work.
     *
     * @param {{execution_id: string, attempt_id: string, nonce?: string}} claim Claim.
     * @returns {{
     *   status: 'new' | 'duplicate' | 'conflict' | 'nonce_replay' | 'capacity',
     *   entry: object | null
     * }} Outcome.
     */
    claim(claim) {
      const executionId = claim.execution_id;
      const existing = byExecution.get(executionId);
      if (existing !== undefined) {
        return {
          status: existing.attempt_id === claim.attempt_id ? 'duplicate' : 'conflict',
          entry: existing,
        };
      }
      if (typeof claim.nonce === 'string' && nonces.has(claim.nonce)) {
        return { status: 'nonce_replay', entry: null };
      }
      // Refuse rather than evict: dropping a tombstone would silently disable both
      // redelivery idempotence and attempt conflict detection for that execution.
      if (byExecution.size >= maxEntries) {
        return { status: 'capacity', entry: null };
      }
      if (typeof claim.nonce === 'string') {
        if (nonces.size >= maxEntries) return { status: 'capacity', entry: null };
        nonces.add(claim.nonce);
      }
      const entry = Object.freeze({
        execution_id: executionId,
        attempt_id: claim.attempt_id,
        nonce: claim.nonce ?? null,
        state: 'claimed',
        plan_id: null,
      });
      byExecution.set(executionId, entry);
      return { status: 'new', entry };
    },

    /**
     * Record the accepted outcome for an already claimed pair.
     *
     * The whole result is retained, not just its plan id: design §10.1 says a
     * redelivered dispatch returns the original outcome, so a retry must be able
     * to answer "already refused / already planned" without recomputing — a
     * recomputation could reach a different verdict after a clock tick and turn an
     * idempotent retry into a second decision.
     *
     * @param {{execution_id: string, attempt_id: string, plan_id: string | null, state?: string, result?: object}} outcome Outcome.
     * @returns {object | null} Stored entry, or `null` when the claim is unknown.
     */
    complete(outcome) {
      const existing = byExecution.get(outcome.execution_id);
      if (existing === undefined || existing.attempt_id !== outcome.attempt_id) return null;
      const entry = Object.freeze({
        ...existing,
        state: outcome.state ?? 'accepted',
        plan_id: outcome.plan_id ?? null,
        result: outcome.result ?? null,
      });
      byExecution.set(outcome.execution_id, entry);
      return entry;
    },

    /**
     * @param {string} executionId Execution id.
     * @returns {object | null} Stored entry.
     */
    lookup(executionId) {
      return byExecution.get(executionId) ?? null;
    },

    /**
     * @param {string} nonce Grant nonce.
     * @returns {boolean} True when already spent.
     */
    hasNonce(nonce) {
      return typeof nonce === 'string' && nonces.has(nonce);
    },

    /** @returns {number} Number of tracked executions. */
    size() {
      return byExecution.size;
    },

    /** Test hook: forget everything. */
    clear() {
      byExecution.clear();
      nonces.clear();
    },
  };
}

const MANIFEST_FIELDS = Object.freeze([
  'execution_id',
  'attempt_id',
  'operation_id',
  'action_id',
  'target_digest',
  'object_identity',
  'prior_state',
  'expected_state',
]);

/**
 * In-memory recovery-manifest recorder.
 *
 * Design §10.2 requires a manifest to be written and fsynced **before** any side
 * effect, so a crash can never leave an unknown change. This build never takes a
 * side effect, so the recorder only models the interface: it validates the shape,
 * assigns a `recovery_id`, and marks every entry `durable: false`.
 *
 * `durable` has no switch on purpose. An earlier draft accepted
 * `{ durable: true }`, which let a `Map` claim it had reached stable storage and
 * turned the design's crash boundary into "the injected port said so". A caller
 * that needs durable behaviour must supply a store that really writes and fsyncs;
 * this one never reports it, so every mutating plan stays `blocked` here.
 *
 * @returns {object} Manifest store.
 */
export function createMemoryManifestStore() {
  /** @type {Map<string, object>} */
  const entries = new Map();
  let counter = 0;

  return {
    /**
     * @param {object} intent Manifest intent.
     * @returns {Readonly<object>} Recorded manifest.
     */
    record(intent) {
      if (!isPlainObject(intent)) {
        helperFail(HELPER_CODES.HELPER_MANIFEST_UNAVAILABLE, '$.manifest', 'manifest intent must be an object');
      }
      for (const field of MANIFEST_FIELDS) {
        const value = intent[field];
        const ok = field === 'prior_state' || field === 'object_identity'
          ? isPlainObject(value)
          : typeof value === 'string' && value.length > 0 && value.length <= 128;
        if (!ok) {
          helperFail(
            HELPER_CODES.HELPER_MANIFEST_UNAVAILABLE,
            `$.manifest.${field}`,
            'manifest intent field is missing or malformed',
            { field },
          );
        }
      }
      counter += 1;
      const recoveryId = `recovery-${String(counter).padStart(6, '0')}`;
      const entry = Object.freeze({
        recovery_id: recoveryId,
        execution_id: intent.execution_id,
        attempt_id: intent.attempt_id,
        operation_id: intent.operation_id,
        action_id: intent.action_id,
        target_digest: intent.target_digest,
        object_identity: Object.freeze({ ...intent.object_identity }),
        prior_state: Object.freeze({ ...intent.prior_state }),
        expected_state: intent.expected_state,
        phase: 'prepared',
        /** This store holds the intent in memory only; it can never claim otherwise. */
        durable: false,
      });
      entries.set(recoveryId, entry);
      return entry;
    },

    /**
     * @param {string} recoveryId Recovery id.
     * @returns {object | null} Recorded manifest.
     */
    get(recoveryId) {
      return entries.get(recoveryId) ?? null;
    },

    /** @returns {readonly object[]} All manifests in insertion order. */
    list() {
      return Object.freeze([...entries.values()]);
    },

    /** @returns {number} Entry count. */
    size() {
      return entries.size;
    },
  };
}
