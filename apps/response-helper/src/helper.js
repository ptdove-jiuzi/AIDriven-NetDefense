/**
 * helper.js — the response helper itself: four methods, zero side effects.
 *
 * Division of labour, deliberately asymmetric:
 *
 *   packages/response-policy   decides whether the action may be requested
 *   this helper                decides whether *this dispatch* can be turned
 *                              into a plan for *this object*, right now
 *
 * The helper never re-decides risk, role or approval. It calls the policy gate
 * once and treats its verdict as data. What it does add on top — because design
 * §10.2 requires the helper to verify independently — is: its own action
 * allowlist, grant-to-dispatch rebinding, time window, nonce single-use, host OS
 * family, OS capability, and object identity at probe time.
 *
 * Every method returns a result object; none of them throws for bad input. A
 * thrown error over an IPC boundary is indistinguishable from "the check never
 * ran", so a refusal is always a value with a code.
 *
 * `executeStub` does not read its argument at all. That is intentional: an
 * implementation that parsed the envelope before refusing would still run caller
 * getters and would still leave a code path between the argument and the refusal.
 */

import {
  ACTION_OS_MATRIX,
  decisionSummary,
  ensureNormalizedTarget,
  evaluateResponsePolicy,
  getAction,
  isPolicyError,
  parseUtcMs,
} from '../../../packages/response-policy/index.js';
import { HELPER_CODES, HelperError, isHelperError } from './errors.js';
import { HELPER_INTERFACE, INTERFACE_VERSION, validateEnvelope } from './interface.js';
import {
  CAPABILITIES,
  CAPABILITY_STATES,
  OS_FAMILIES,
  createHostOsProbe,
  createMemoryInbox,
  createMemoryManifestStore,
  createNullCapabilityProbe,
  createNullGrantVerifier,
  createNullTargetProbe,
  createSystemClock,
} from './ports.js';
import { EXPECTED_STATE, buildSnapshot, detectDrift, refusalCodeForDrift } from './snapshot.js';
import { EXECUTION_ENABLED, buildPlan, planSummary, requiredCapabilities, stepsFor } from './plan.js';

/**
 * The helper's own allowlist.
 *
 * Kept as a literal instead of "whatever the catalog exports" so that a change to
 * `response-policy` cannot silently widen what this process is willing to plan. A
 * test asserts the two sets are equal, so drift between them is a red test rather
 * than a runtime surprise.
 */
export const HELPER_ACTION_ALLOWLIST = Object.freeze([
  'observe.record_alert',
  'process.suspend',
  'process.terminate',
  'network.block_connection',
  'network.isolate',
  'file.quarantine',
]);

/**
 * @param {unknown} actionId Candidate.
 * @returns {boolean} True when the helper is willing to plan this action at all.
 */
export function isHelperAllowedAction(actionId) {
  return typeof actionId === 'string' && HELPER_ACTION_ALLOWLIST.includes(actionId);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Read a contracts record `{ schemaVersion, digest, value }` or a bare DTO.
 *
 * The daemon may forward either form — the policy gate accepts both — so the
 * helper must too, otherwise the same dispatch would be accepted by policy and
 * then refused here for a shape the policy already blessed. The unwrap is shallow
 * and deliberately dumb: `readContractEnvelope` in the policy layer is what
 * verifies that `digest` matches `value`, and it has already run by this point.
 *
 * @param {object} record Record or DTO.
 * @returns {object} The DTO.
 */
function unwrapContract(record) {
  if (isPlainObject(record) && isPlainObject(record.value) && typeof record.digest === 'string') {
    return record.value;
  }
  return record;
}

/**
 * Maximum tolerated difference between the dispatch's `now` and this helper's own
 * clock, in milliseconds.
 *
 * Design §10.2 requires the helper to verify the time window independently, and a
 * window checked against the caller's own timestamp is not independent: a stale
 * grant with a valid signature would pass simply by declaring an earlier `now`.
 * The skew bound is what makes "expired" mean expired. 30s matches the design's
 * short-lived grant TTL scale and tolerates ordinary NTP drift between two
 * processes on one host.
 */
export const MAX_CLOCK_SKEW_MS = 30_000;

/**
 * One result shape for every method.
 *
 * `status` is one of `planned`, `blocked`, `refused` or `dry_run_only`:
 *
 *   planned      policy allowed, every helper check passed: only the build flag
 *                stands between the plan and an execution
 *   blocked      policy allowed and a plan exists, but an environmental
 *                precondition is unmet (missing privilege, unverifiable
 *                signature, a manifest that is not durable)
 *   refused      no plan: the dispatch itself is not acceptable
 *   dry_run_only the answer of `executeStub`, always
 */
function result(fields) {
  return Object.freeze({
    status: fields.status,
    code: fields.code ?? null,
    detail: fields.detail ?? null,
    dry_run: true,
    executable: false,
    authorizes_execution: false,
    /** No method in this build performs anything; stated once, in the shared shape. */
    performed: false,
    duplicate: fields.duplicate === true,
    // The raw policy decision carries a `detail` that may quote the path or address
    // it rejected. That is fine inside the gate, but this result is what gets logged
    // and shown, so only the audit-safe summary crosses the boundary.
    decision: fields.decision === undefined || fields.decision === null
      ? null
      : decisionSummary(fields.decision),
    plan: fields.plan ?? null,
  });
}

/**
 * @param {string} code Helper refusal code.
 * @param {object | null} [detail] Bounded detail.
 * @param {object | null} [decision] Policy decision, when one was produced.
 * @returns {Readonly<object>} Refusal result.
 */
function refusal(code, detail = null, decision = null) {
  return result({ status: 'refused', code, detail, decision });
}

/**
 * Flatten a thrown value's `detail` to bounded plain data.
 *
 * A port may throw anything, including a `HelperError` it constructed itself with a
 * `detail` object whose getters run when a logger serialises it. The detail is
 * therefore round-tripped through JSON — which drops getters and functions — and
 * anything that will not survive that round-trip becomes `null`.
 *
 * @param {unknown} detail Candidate detail.
 * @returns {object | null} Plain detail or `null`.
 */
function sanitizeThrownDetail(detail) {
  if (detail === undefined || detail === null) return null;
  try {
    const text = JSON.stringify(detail);
    if (typeof text !== 'string' || text.length > 2048) return null;
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Turn a thrown helper/policy error into a refusal without trusting it.
 *
 * Only a declared code survives, and **this function never throws**: it is called
 * from the catch that is supposed to guarantee the inbox is settled, so an
 * exception here would leave a claim stranded forever. Every read of the thrown
 * value is guarded, `instanceof` included — a Proxy can lie about its prototype.
 *
 * @param {unknown} error Whatever was thrown.
 * @returns {Readonly<object>} Refusal result.
 */
function refusalFrom(error) {
  try {
    if (isHelperError(error)) {
      return refusal(error.code, sanitizeThrownDetail(error.detail));
    }
    if (isPolicyError(error)) {
      // A policy normalisation failure (bad target/parameters) is a refusal, not a
      // plan: the policy layer owns that vocabulary and its code is the audited one.
      return refusal(error.code, null);
    }
  } catch {
    // Fall through to the generic refusal below.
  }
  let name = 'unknown';
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'name');
      if (descriptor !== undefined
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && typeof descriptor.value === 'string') {
        name = descriptor.value.slice(0, 64);
      }
    }
  } catch {
    name = 'unknown';
  }
  return refusal(HELPER_CODES.HELPER_PROBE_INVALID, { cause: name });
}

/**
 * Refusal for a dedupe inbox that threw or answered something undeclared.
 *
 * The inbox is a port like any other, but its failures used to be the one hole in
 * the "none of them throws" promise: `lookup`/`claim` sat outside any try, so a
 * port error (or a `claim` returning `undefined`, whose `.status` read raises a
 * `TypeError`) escaped the whole method. Over IPC that is indistinguishable from
 * "the dedupe check never ran" — the exact ambiguity the check exists to remove.
 *
 * @param {unknown} error Whatever the port threw.
 * @param {string} operation `lookup` or `claim`.
 * @returns {Readonly<object>} Refusal with a declared code.
 */
function inboxRefusal(error, operation) {
  const fromPort = refusalFrom(error);
  return refusal(HELPER_CODES.HELPER_INBOX_UNAVAILABLE, {
    operation,
    // The generic refusal already reduced the thrown value to a bounded name; only
    // the fixed operation label is added, never the thrown text itself.
    cause: fromPort.detail === null ? 'unknown' : fromPort.detail.cause ?? 'unknown',
  });
}

/**
 * Read the host OS family from the probe, without trusting it.
 *
 * @param {object} probe OS probe.
 * @returns {string} A member of {@link OS_FAMILIES} or `'unsupported'`.
 */
function readOsFamily(probe) {
  try {
    const family = probe.osFamily();
    return OS_FAMILIES.includes(family) ? family : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/**
 * Read and validate the capability table for one action.
 *
 * @param {object} probe Capability probe.
 * @param {{ os: string, actionId: string, target: object }} request Probe request.
 * @param {readonly string[]} required Capabilities the action needs.
 * @returns {{ table: object, missing: readonly object[] }} Observed table and gaps.
 */
function readCapabilities(probe, request, required) {
  const raw = probe.capabilities(request);
  if (!isPlainObject(raw)) {
    throw new HelperError(
      HELPER_CODES.HELPER_PROBE_INVALID,
      '$.capabilities',
      'capability probe must return an object',
    );
  }
  const table = {};
  for (const name of CAPABILITIES) {
    const value = raw[name];
    if (value === undefined) continue;
    if (!CAPABILITY_STATES.includes(value)) {
      throw new HelperError(
        HELPER_CODES.HELPER_PROBE_INVALID,
        `$.capabilities.${name}`,
        'capability state must be granted, denied or unknown',
      );
    }
    table[name] = value;
  }
  const missing = [];
  for (const name of required) {
    const state = table[name];
    if (state === 'granted') continue;
    missing.push(Object.freeze({
      code: state === 'denied' ? HELPER_CODES.HELPER_CAPABILITY_DENIED : HELPER_CODES.HELPER_CAPABILITY_UNKNOWN,
      path: `$.capabilities.${name}`,
      detail: Object.freeze({ capability: name, state: state ?? 'unknown' }),
    }));
  }
  return { table: Object.freeze(table), missing: Object.freeze(missing) };
}

/**
 * Verify the grant against this dispatch's own binding.
 *
 * The policy gate already compared the grant with the request it evaluated. This
 * is the second, independent comparison design §10.2 demands, done against the
 * helper's *own* normalised target and the decision's digests — so a decision
 * produced for a different target, or a grant spliced in afterwards, is caught
 * here even if the policy call was somehow fed a doctored request.
 *
 * @param {{ envelope: object, grant: object, target: object, decision: object }} input Parts.
 * @returns {{ code: string, field: string } | null} Mismatch, or `null` when bound.
 */
function verifyGrantBinding(input) {
  const { envelope, grant, target, decision } = input;
  const now = parseUtcMs(envelope.now);
  if (now === null) return { code: HELPER_CODES.HELPER_ENVELOPE_INVALID, field: 'now' };
  if (grant.action_id !== envelope.actionId) {
    return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'action_id' };
  }
  if (grant.action_digest !== decision.actionDigest) {
    return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'action_digest' };
  }
  if (grant.parameters_digest !== decision.parametersDigest) {
    return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'parameters_digest' };
  }
  if (grant.target_digest !== target.digest) {
    return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'target_digest' };
  }
  if (grant.execution_id !== envelope.execution_id) {
    return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'execution_id' };
  }
  if (grant.epoch !== envelope.epoch) return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'epoch' };
  const notBefore = parseUtcMs(grant.not_before);
  if (notBefore === null || notBefore > now) {
    return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'not_before' };
  }
  const expiresAt = parseUtcMs(grant.expires_at);
  if (expiresAt === null || expiresAt <= now) {
    return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'expires_at' };
  }
  const approvalNonce = isPlainObject(envelope.approval)
    ? unwrapContract(envelope.approval).nonce
    : undefined;
  if (typeof approvalNonce === 'string' && approvalNonce === grant.nonce) {
    return { code: HELPER_CODES.HELPER_BINDING_MISMATCH, field: 'nonce' };
  }
  return null;
}

/**
 * Create a response helper.
 *
 * All OS knowledge arrives through the injected ports. The defaults are the
 * fail-closed ones: a host OS probe (a runtime constant, not a probe of any
 * object), and null capability/target/verifier ports that answer "unknown" /
 * "unverifiable" / "no trust root". A helper built with no options can therefore
 * only ever produce blocked plans — never a runnable one.
 *
 * @param {{
 *   osProbe?: object,
 *   capabilityProbe?: object,
 *   targetProbe?: object,
 *   grantVerifier?: object,
 *   inbox?: object,
 *   manifestStore?: object,
 *   clock?: object
 * }} [options] Injected ports.
 * @returns {Readonly<{describe: Function, prepare: Function, dryRun: Function, executeStub: Function}>} Helper.
 */
export function createResponseHelper(options = {}) {
  const osProbe = options.osProbe ?? createHostOsProbe();
  const capabilityProbe = options.capabilityProbe ?? createNullCapabilityProbe();
  const targetProbe = options.targetProbe ?? createNullTargetProbe();
  const grantVerifier = options.grantVerifier ?? createNullGrantVerifier();
  const inbox = options.inbox ?? createMemoryInbox();
  const manifestStore = options.manifestStore ?? createMemoryManifestStore();
  const clock = options.clock ?? createSystemClock();

  /**
   * Everything after the inbox claim: decide, probe, bind, plan.
   *
   * Kept separate from `prepare` so exactly one place settles the inbox, and no
   * early return can leave a claim without a stored outcome.
   *
   * @param {object} envelope Validated envelope.
   * @param {{ recordManifest?: boolean }} [options] Pipeline switches. `dryRun`
   *   passes `recordManifest: false` so a preview never writes a recovery intent.
   * @returns {Readonly<object>} Result.
   */
  function attempt(envelope, options = {}) {
    const recordManifest = options.recordManifest !== false;
    const decision = evaluateResponsePolicy({
      os: envelope.os,
      policyVersion: envelope.policyVersion,
      now: envelope.now,
      actionId: envelope.actionId,
      target: envelope.target,
      parameters: envelope.parameters,
      actorRoles: envelope.actorRoles,
      epoch: envelope.epoch,
      proposal: envelope.proposal,
      approval: envelope.approval,
      grant: envelope.grant,
      replay: envelope.replay,
    });

    // The policy verdict is consumed, not re-derived. `needs_approval` is as much
    // a stop as `deny`: nothing may be planned for an unapproved action.
    if (decision.outcome !== 'allow') {
      return refusal(decision.reasonCode, { outcome: decision.outcome }, decision);
    }

    if (!isHelperAllowedAction(envelope.actionId)) {
      return refusal(HELPER_CODES.HELPER_ACTION_NOT_ALLOWED, { actionId: envelope.actionId }, decision);
    }

    let target;
    try {
      // Accepts either a raw target or one the policy layer already normalised:
      // the daemon legitimately forwards the normalised object it bound, and
      // re-normalising it would reject the brand symbol as an undeclared field.
      target = ensureNormalizedTarget(envelope.target);
    } catch (error) {
      const fromPolicy = refusalFrom(error);
      return Object.freeze({ ...fromPolicy, decision: decisionSummary(decision) });
    }
    if (target.digest !== decision.targetDigest) {
      // The decision must describe the object this helper just re-normalised;
      // otherwise a verdict for one target is being applied to another.
      return refusal(HELPER_CODES.HELPER_BINDING_MISMATCH, { field: 'target_digest' }, decision);
    }

    // Read the requirement from the decision, not from the catalog: the decision is
    // the verdict that was actually issued, and a second source for the same fact
    // is a second thing that can drift.
    const requiresApproval = decision.requiresApproval === true;
    if (requiresApproval && !isPlainObject(envelope.grant)) {
      return refusal(HELPER_CODES.HELPER_GRANT_MISSING, { actionId: envelope.actionId }, decision);
    }

    const wouldMutate = stepsFor(envelope.actionId).some((entry) => entry.would_mutate);
    if (wouldMutate && !isPlainObject(envelope.grant)) {
      // P1-4. `decision.requiresApproval` is the *policy's* statement about the
      // action, and the catalog marks some mutating actions approval-free — Linux
      // `process.suspend` is one. Trusting that alone produced a `planned` dispatch
      // with `ready_for_execution: true`, no grant, no signature, no nonce: of the
      // six bindings design §10.2 requires, only allowlist and target were checked.
      //
      // The helper therefore applies its own rule, not a second risk judgement:
      // **a plan that would change the object needs a grant**. Without one the
      // dispatch is refused as approval-required. Nothing here re-decides whether
      // the action is safe; it refuses to shape a side effect that nothing signed.
      return refusal(HELPER_CODES.HELPER_GRANT_MISSING, {
        actionId: envelope.actionId,
        reason: 'mutating_action_requires_a_grant',
      }, decision);
    }

    const blockedReasons = [];
    const notes = [];
    let grantView = null;
    /** A grant counts only when present, bound, inside its window and signed. */
    let grantValid = false;

    if (isPlainObject(envelope.grant)) {
      const grant = unwrapContract(envelope.grant);
      const mismatch = verifyGrantBinding({ envelope, grant, target, decision });
      if (mismatch !== null) return refusal(mismatch.code, { field: mismatch.field }, decision);
      let verified;
      try {
        verified = grantVerifier.verify(grant);
      } catch {
        verified = { ok: false, reason: 'verifier_failed' };
      }
      const signatureVerified = isPlainObject(verified) && verified.ok === true;
      grantValid = signatureVerified;
      const nonceConsumed = typeof grant.nonce === 'string';
      grantView = Object.freeze({
        present: true,
        execution_id: grant.execution_id,
        not_before: grant.not_before,
        expires_at: grant.expires_at,
        // The inbox claim above has already spent the nonce; saying `false` here
        // would make the plan state a fact that is no longer true.
        nonce_consumed: nonceConsumed,
        signature_verified: signatureVerified,
        signature_source: typeof grantVerifier.source === 'string' ? grantVerifier.source : 'unknown',
      });
      if (!signatureVerified) {
        // No configured trust root ⇒ "cannot verify". Design §10.2 makes that a
        // stop, not a warning: an unverified signature is not a weaker grant.
        blockedReasons.push(Object.freeze({
          code: HELPER_CODES.HELPER_GRANT_UNVERIFIED,
          path: '$.grant.signature',
          detail: Object.freeze({ reason: isPlainObject(verified) ? verified.reason ?? null : null }),
        }));
      }
    } else {
      grantView = Object.freeze({
        present: false,
        execution_id: null,
        not_before: null,
        expires_at: null,
        nonce_consumed: false,
        signature_verified: false,
        signature_source: 'none',
      });
      notes.push('no grant supplied; this action never changes the target');
    }

    const required = requiredCapabilities(envelope.actionId);
    let capabilityView;
    try {
      // The probe gets a bounded context, not the target object: it needs to know
      // which OS surface to check, not where the file lives. Handing a probe the
      // raw identity would spread the local path across another component for no
      // reason.
      const { table, missing } = readCapabilities(capabilityProbe, {
        os: envelope.os,
        actionId: envelope.actionId,
        target: { kind: target.kind, digest: target.digest },
      }, required);
      capabilityView = Object.freeze({
        required,
        observed: table,
        satisfied: missing.length === 0,
        missing: Object.freeze(missing.map((entry) => entry.detail.capability)),
      });
      for (const entry of missing) blockedReasons.push(entry);
    } catch (error) {
      return refusalFrom(error);
    }

    let observation;
    try {
      observation = targetProbe.observe({ os: envelope.os, kind: target.kind, target });
    } catch {
      observation = { state: 'unverifiable', reason: 'probe_threw' };
    }

    let snapshot;
    let drift;
    try {
      snapshot = buildSnapshot({ target, observation, capturedAt: envelope.now });
      drift = detectDrift({ target, snapshot });
    } catch (error) {
      return refusalFrom(error);
    }

    if (drift.status !== 'clean') {
      if (wouldMutate) {
        return refusal(refusalCodeForDrift(drift), {
          drift: drift.reasons.map((entry) => entry.code),
        }, decision);
      }
      // Alert-only: the target is never touched, so a missing object cannot make
      // recording the alert wrong. Say so instead of blocking a harmless action.
      notes.push('target drift observed, but this action never touches the target');
    }

    let manifest = null;
    if (!wouldMutate) {
      // Alert-only actions have no recovery intent to record.
    } else if (!recordManifest) {
      // P1-3. A preview is a plan, not a dispatch. Writing a recovery intent from
      // `dryRun` put a `phase: 'prepared'` row into a real durable store for an
      // action nobody approved, and left `manual_required` noise behind. The
      // manifest step stays visible in `plan.steps` — the preview describes it —
      // but nothing is written.
      notes.push('dry-run preview: no recovery manifest recorded');
    } else if (blockedReasons.length === 0) {
      // Only record an intent for a dispatch that could actually proceed. Writing a
      // recovery intent for something already blocked by a missing privilege or an
      // unverified signature would leave permanent `manual_required` noise in a
      // real durable store, for an action that was never going to run.
      try {
        manifest = manifestStore.record({
          execution_id: envelope.execution_id,
          attempt_id: envelope.attempt_id,
          operation_id: target.objectId,
          action_id: envelope.actionId,
          target_digest: target.digest,
          object_identity: {
            kind: target.kind,
            object_id: target.objectId,
            identity_digest: snapshot.observed_identity_digest,
          },
          prior_state: {
            state: snapshot.state,
            observed_os: snapshot.observed_os,
            observed_pid: snapshot.observed_pid,
            observed_at: snapshot.observed_at,
            captured_at: snapshot.captured_at,
          },
          expected_state: EXPECTED_STATE[envelope.actionId] ?? 'unknown',
        });
      } catch (error) {
        return refusalFrom(error);
      }
      if (manifest.durable !== true) {
        // Design §10.2: no side effect before a flushed manifest. A recorder that
        // only holds the intent in memory cannot satisfy that, so the plan is
        // blocked — the honest state for a dry-run build.
        blockedReasons.push(Object.freeze({
          code: HELPER_CODES.HELPER_MANIFEST_UNAVAILABLE,
          path: '$.manifest.durable',
          detail: Object.freeze({ durable: manifest.durable }),
        }));
      }
    } else {
      notes.push('recovery manifest not recorded: the dispatch is already blocked');
    }

    const plan = buildPlan({
      envelope,
      decision,
      target,
      parametersDigest: decision.parametersDigest,
      snapshot,
      drift,
      capabilities: capabilityView,
      grant: grantView,
      grantValid,
      manifest,
      blockedReasons,
      notes,
    });

    return result({
      status: plan.status,
      code: plan.blocked_reasons[0]?.code ?? null,
      detail: plan.blocked_reasons.length > 0
        ? { blocked: plan.blocked_reasons.map((entry) => entry.code) }
        : null,
      decision,
      plan,
    });
  }

  /**
   * Difference between a dispatch timestamp and this helper's own clock.
   *
   * @param {string} timestamp Envelope `now`.
   * @returns {number | null} Milliseconds (declared − now), or `null` when either
   *   side cannot be read.
   */
  function readClockSkew(timestamp) {
    const declared = parseUtcMs(timestamp);
    if (declared === null || !Number.isFinite(declared)) return null;
    let current;
    try {
      current = clock.nowMs();
    } catch {
      return null;
    }
    if (typeof current !== 'number' || !Number.isFinite(current)) return null;
    return declared - current;
  }

  /**
   * Transport and host gates shared by `prepare` and `dryRun`.
   *
   * A preview that accepted an envelope the dispatch would refuse — or the reverse
   * — would be a preview of some other dispatch, so both entry points run exactly
   * this check and neither re-implements it.
   *
   * @param {unknown} rawEnvelope Candidate envelope.
   * @returns {{ envelope: object, refusal: null } | { envelope: null, refusal: object }} Parts.
   */
  function preflight(rawEnvelope) {
    let envelope;
    try {
      envelope = validateEnvelope(rawEnvelope);
    } catch (error) {
      return { envelope: null, refusal: refusalFrom(error) };
    }
    const hostFamily = readOsFamily(osProbe);
    if (!OS_FAMILIES.includes(hostFamily)) {
      return { envelope: null, refusal: refusal(HELPER_CODES.HELPER_OS_UNKNOWN, { host: hostFamily }) };
    }
    if (hostFamily !== envelope.os) {
      // A plan for another OS family is not a plan this process could ever carry
      // out, and silently planning it is how a cross-OS dispatch looks accepted.
      return {
        envelope: null,
        refusal: refusal(HELPER_CODES.HELPER_OS_MISMATCH, { declared: envelope.os, host: hostFamily }),
      };
    }
    return { envelope, refusal: null };
  }

  /**
   * Freshness gate: the dispatch's `now` must be near this helper's own clock.
   *
   * @param {object} envelope Validated envelope.
   * @returns {Readonly<object> | null} Refusal, or `null` when the timestamp is
   *   close enough to be judged against a grant window.
   */
  function skewRefusal(envelope) {
    const skew = readClockSkew(envelope.now);
    if (skew !== null && Number.isFinite(skew) && Math.abs(skew) <= MAX_CLOCK_SKEW_MS) return null;
    // A dispatch whose `now` is far from this helper's clock cannot be checked
    // against a time window: an expired grant would pass by declaring an earlier
    // `now`. Refusing is the only honest answer, and it keeps `expired` meaning
    // expired.
    return refusal(HELPER_CODES.HELPER_CLOCK_SKEW, {
      max_skew_ms: MAX_CLOCK_SKEW_MS,
      skew_ms: Number.isFinite(skew) ? skew : null,
      clock_source: typeof clock.source === 'string' ? clock.source : 'unknown',
    });
  }

  /**
   * Validate a dispatch and build a plan. Never performs a side effect.
   *
   * @param {unknown} rawEnvelope Dispatch envelope.
   * @returns {Readonly<object>} Result.
   */
  function prepare(rawEnvelope) {
    const { envelope, refusal: refused } = preflight(rawEnvelope);
    if (refused !== null) return refused;

    // Redelivery wins over freshness. Design §10.1 says a retried dispatch returns
    // the original outcome; a retry forty seconds later is still a retry, so the
    // duplicate lookup happens before the timestamp is judged. Only a *new*
    // execution has to prove its `now` is fresh.
    //
    // P1-1: the lookup is a port call, so it is guarded like every other one. An
    // inbox that throws — or that answers a value whose fields throw when read —
    // must produce a declared refusal, not an exception that leaves `prepare` and
    // is indistinguishable from "dedupe never ran".
    let prior;
    try {
      prior = inbox.lookup(envelope.execution_id);
    } catch (error) {
      return inboxRefusal(error, 'lookup');
    }
    if (prior !== null && prior !== undefined) {
      try {
        if (prior.attempt_id !== envelope.attempt_id) {
          return refusal(HELPER_CODES.HELPER_EXECUTION_CONFLICT, { reason: 'attempt_id_mismatch' });
        }
        if (prior.result === null || prior.result === undefined || !isPlainObject(prior.result)) {
          // A stored result that is not an object cannot be a result this helper
          // produced; spreading a string would fabricate a result shape.
          return refusal(HELPER_CODES.HELPER_EXECUTION_CONFLICT, { reason: 'claim_without_result' });
        }
        return Object.freeze({ ...prior.result, duplicate: true });
      } catch (error) {
        return inboxRefusal(error, 'lookup');
      }
    }

    const notFresh = skewRefusal(envelope);
    if (notFresh !== null) return notFresh;

    const grantNonce = isPlainObject(envelope.grant) && typeof unwrapContract(envelope.grant).nonce === 'string'
      ? unwrapContract(envelope.grant).nonce
      : undefined;
    // P1-1: the claim is the second unguarded port call. A throw here (or a
    // `undefined` return, whose `.status` read raises a `TypeError`) used to escape
    // `prepare` itself — including through `dryRun`, which shared the path.
    let claim;
    try {
      claim = inbox.claim({
        execution_id: envelope.execution_id,
        attempt_id: envelope.attempt_id,
        nonce: grantNonce,
      });
    } catch (error) {
      return inboxRefusal(error, 'claim');
    }

    // Inspecting the answer is itself a port call. `isPlainObject` runs
    // `getPrototypeOf`, and `.status` / `.entry` may be accessors, so a hostile
    // claim value can throw on *inspection* even though the call returned. The
    // whole read therefore stays inside a guard, and each field is read exactly
    // once: a second read would be a time-of-check/time-of-use window in the one
    // place where "which branch do I take" decides whether a dispatch is planned.
    let claimStatus;
    let claimEntry;
    try {
      if (!isPlainObject(claim)) {
        return refusal(HELPER_CODES.HELPER_INBOX_UNAVAILABLE, {
          operation: 'claim',
          cause: 'malformed_claim_result',
        });
      }
      claimStatus = claim.status;
      claimEntry = claim.entry;
    } catch (error) {
      return inboxRefusal(error, 'claim');
    }
    if (typeof claimStatus !== 'string') {
      // A claim that answered garbage cannot be settled. Calling `complete` here
      // would have to guess whether the port claimed at all, and on the `duplicate`
      // path it could overwrite a legitimate stored outcome with this refusal. The
      // entry is therefore left as it is; the next dispatch reports
      // `claim_without_result`, which is visible in an audit row, and reclaiming the
      // slot is a daemon TTL concern (the in-memory inbox has none).
      return refusal(HELPER_CODES.HELPER_INBOX_UNAVAILABLE, {
        operation: 'claim',
        cause: 'malformed_claim_result',
      });
    }
    if (claimStatus === 'duplicate') {
      // Defensive: the lookup above already answered duplicates. If an inbox port
      // reports one here, answer it the same way rather than planning twice.
      try {
        const stored = claimEntry === null || claimEntry === undefined ? null : claimEntry.result;
        if (stored === null || stored === undefined || !isPlainObject(stored)) {
          return refusal(HELPER_CODES.HELPER_EXECUTION_CONFLICT, { reason: 'claim_without_result' });
        }
        return Object.freeze({ ...stored, duplicate: true });
      } catch (error) {
        return inboxRefusal(error, 'claim');
      }
    }
    if (claimStatus === 'conflict') {
      return refusal(HELPER_CODES.HELPER_EXECUTION_CONFLICT, { reason: 'attempt_id_mismatch' });
    }
    if (claimStatus === 'nonce_replay') {
      return refusal(HELPER_CODES.HELPER_NONCE_REPLAY, { field: 'nonce' });
    }
    if (claimStatus === 'capacity') {
      return refusal(HELPER_CODES.HELPER_INBOX_FULL, { reason: 'dedupe_capacity_exhausted' });
    }
    if (claimStatus !== 'new') {
      // An inbox that invents a status must not be read as "claimed" by default:
      // the only status that permits planning is the one the interface declares.
      return refusal(HELPER_CODES.HELPER_INBOX_UNAVAILABLE, {
        operation: 'claim',
        cause: 'undeclared_claim_status',
      });
    }

    // `attempt` is written not to throw, but the inbox claim has already happened:
    // if anything did escape, the entry would stay `claimed` forever and every
    // redelivery would fail with `claim_without_result`. Both statements below are
    // individually guarded, and `refusalFrom` itself never throws, so no value
    // thrown from a port can strand the claim or escape this method.
    let settled = refusal(HELPER_CODES.HELPER_PROBE_INVALID);
    try {
      settled = attempt(envelope);
    } catch (error) {
      settled = refusalFrom(error);
    }
    try {
      inbox.complete({
        execution_id: envelope.execution_id,
        attempt_id: envelope.attempt_id,
        plan_id: settled.plan?.plan_id ?? null,
        state: settled.status,
        result: settled,
      });
    } catch {
      // A failing inbox port must not replace the result we already computed: the
      // refusal is still the honest answer, and the stranded claim is a port bug
      // that the next dispatch will surface as `claim_without_result`.
    }
    return settled;
  }

  /**
   * Build the dry-run document from a **pure** plan. Still no side effect.
   *
   * P1-3. This used to call `prepare`, which meant a preview took a dedupe claim
   * (occupying the `execution_id` so the real dispatch afterwards answered
   * `duplicate`) and wrote a `phase: 'prepared'` recovery manifest into whatever
   * store was injected. Both are side effects of a dispatch, and a preview is not a
   * dispatch. The preview therefore:
   *
   *   - runs the same transport/host/freshness gates as `prepare`;
   *   - runs the same decision, binding, capability, probe and drift pipeline;
   *   - never calls `inbox.lookup`/`claim`/`complete`, so no execution id, attempt
   *     or grant nonce is reserved;
   *   - passes `recordManifest: false`, so no recovery intent is written;
   *   - queues nothing (there is no outbox in this build, and none is created).
   *
   * @param {unknown} rawEnvelope Dispatch envelope.
   * @returns {Readonly<object>} Result plus `dry_run_plan` and `summary`.
   */
  function dryRun(rawEnvelope) {
    const { envelope, refusal: refused } = preflight(rawEnvelope);
    if (refused !== null) {
      return Object.freeze({ ...refused, dry_run_plan: null, summary: null });
    }
    const notFresh = skewRefusal(envelope);
    if (notFresh !== null) {
      return Object.freeze({ ...notFresh, dry_run_plan: null, summary: null });
    }

    let previewed = refusal(HELPER_CODES.HELPER_PROBE_INVALID);
    try {
      previewed = attempt(envelope, { recordManifest: false });
    } catch (error) {
      previewed = refusalFrom(error);
    }

    const plan = previewed.plan;
    if (plan === null) {
      return Object.freeze({ ...previewed, dry_run_plan: null, summary: null });
    }
    const needs = requiredCapabilities(plan.action_id);
    const dryRunPlan = Object.freeze({
      plan_id: plan.plan_id,
      action_id: plan.action_id,
      os: plan.os,
      steps: plan.steps,
      effects: Object.freeze({
        would_mutate_target: plan.would_mutate_target,
        irreversible: plan.irreversible,
        touches_process: needs.includes('process_control'),
        touches_network: needs.includes('network_control'),
        touches_file: needs.includes('file_control'),
      }),
      simulated_state_before: plan.snapshot.state,
      simulated_state_after: plan.would_mutate_target
        ? EXPECTED_STATE[plan.action_id] ?? null
        : plan.snapshot.state,
      side_effects_performed: false,
      /** The four facts that separate a preview from a dispatch. */
      reserves_execution_id: false,
      writes_recovery_manifest: false,
      consumes_grant_nonce: false,
      writes_outbox: false,
    });
    return Object.freeze({
      // A preview never inherits dispatch state, so `duplicate` is always false:
      // it neither observes nor creates a dedupe entry.
      ...previewed,
      duplicate: false,
      dry_run_plan: dryRunPlan,
      summary: planSummary(plan),
    });
  }

  /**
   * The execute entry point of this build.
   *
   * The argument is **not read**: not validated, not normalised, not even checked
   * for a getter. There is no branch that could be made to reach an OS call,
   * because there is no OS call and no code between the argument and this return.
   *
   * @returns {Readonly<object>} `dry_run_only`, always.
   */
  function executeStub() {
    return Object.freeze({
      status: 'dry_run_only',
      code: HELPER_CODES.HELPER_EXECUTION_DISABLED,
      detail: Object.freeze({ execution_enabled: EXECUTION_ENABLED }),
      performed: false,
      dry_run: true,
      executable: false,
      authorizes_execution: false,
      duplicate: false,
      decision: null,
      plan: null,
    });
  }

  /**
   * Static description of what this helper is and is not.
   *
   * @returns {Readonly<object>} Description.
   */
  function describe() {
    const hostFamily = readOsFamily(osProbe);
    return Object.freeze({
      interface: HELPER_INTERFACE,
      build: Object.freeze({
        execution_enabled: EXECUTION_ENABLED,
        dry_run_only: !EXECUTION_ENABLED,
        mode: EXECUTION_ENABLED ? 'execution' : 'dry_run_only',
      }),
      host: Object.freeze({
        os_family: hostFamily,
        source: typeof osProbe.source === 'string' ? osProbe.source : 'unknown',
      }),
      actions: Object.freeze(HELPER_ACTION_ALLOWLIST.map((actionId) => {
        const action = getAction(actionId);
        return Object.freeze({
          action_id: actionId,
          os_support: ACTION_OS_MATRIX[actionId],
          required_capabilities: requiredCapabilities(actionId),
          irreversible: action !== null && action.reversible === false,
          requires_approval: action !== null && action.requiresApproval === true,
          would_mutate_target: stepsFor(actionId).some((entry) => entry.would_mutate),
        });
      })),
      capabilities: CAPABILITIES,
      interface_version: INTERFACE_VERSION,
    });
  }

  return Object.freeze({ describe, prepare, dryRun, executeStub });
}
