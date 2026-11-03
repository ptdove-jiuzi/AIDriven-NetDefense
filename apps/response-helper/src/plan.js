/**
 * plan.js — the structured dry-run plan.
 *
 * A plan is what the helper would do, written down before anything happens. In
 * this build nothing ever happens: `EXECUTION_ENABLED` is `false`, so every plan
 * reports `executable: false` and `execution_disabled: true` regardless of how
 * clean the checks are.
 *
 * `ready_for_execution` is therefore **not** the same field. It answers "would
 * this plan be ready if execution existed in this build", which is what makes the
 * dry-run useful: an operator can see that a dispatch is blocked by a missing
 * privilege rather than by the build flag, without any risk of the flag being the
 * only thing between a plan and a `kill`.
 *
 * Step text is a **static table**, never interpolated with envelope or parameter
 * values. A plan is logged, shown in a console toast and quoted in an audit row;
 * building those strings from caller input is how a parameter becomes a rendering
 * or terminal-injection bug. The plan carries digests only.
 */

import { canonicalDigest } from '@aegisharness/contracts';
import { getAction, IRREVERSIBLE_ACTIONS } from '../../../packages/response-policy/index.js';
import { EXECUTION_ENABLED } from './build.js';
import { INTERFACE_VERSION } from './interface.js';

/**
 * Re-exported so a consumer that only reads `plan.js` still sees the single build
 * switch; the value and its documentation live in `build.js`.
 */
export { EXECUTION_ENABLED };

/** Step kinds the planner may emit. Closed. */
export const STEP_KINDS = Object.freeze([
  'bind_target',
  'record_manifest',
  'os_action',
  'observe_result',
  'record_result',
]);

/** OS capability each action needs before its `os_action` step could run. */
export const REQUIRED_CAPABILITIES = Object.freeze({
  'observe.record_alert': Object.freeze([]),
  'process.suspend': Object.freeze(['process_control']),
  'process.terminate': Object.freeze(['process_control']),
  'network.block_connection': Object.freeze(['network_control']),
  'network.isolate': Object.freeze(['network_control']),
  'file.quarantine': Object.freeze(['file_control']),
});

function step(kind, description, wouldMutate, requires = []) {
  return Object.freeze({
    step_id: `${kind}`,
    kind,
    description,
    would_mutate: wouldMutate,
    requires: Object.freeze([...requires]),
  });
}

/**
 * Static step templates, one list per catalog action.
 *
 * The wording is fixed on purpose: `bind_target` re-binds the OS object, the
 * manifest is recorded *before* `os_action` (design §10.2), and the result is read
 * back after. A plan that ordered the manifest after the action would describe a
 * crash window in which a change exists with no record of it.
 */
export const ACTION_STEPS = Object.freeze({
  'observe.record_alert': Object.freeze([
    step('record_result', 'record the alert-only outcome; the target is never touched', false),
  ]),
  'process.suspend': Object.freeze([
    step('bind_target', 're-bind the process object through its handle and creation time', false),
    step('record_manifest', 'record and flush the recovery intent before any side effect', false),
    step('os_action', 'suspend the bound process through its handle', true, ['process_control']),
    step('observe_result', 'read the process state back from the same handle', false),
    step('record_result', 'report the observed state as the attempt result', false),
  ]),
  'process.terminate': Object.freeze([
    step('bind_target', 're-bind the process object through its handle and creation time', false),
    step('record_manifest', 'record and flush the recovery intent before any side effect', false),
    step('os_action', 'terminate the bound process through its handle', true, ['process_control']),
    step('observe_result', 'confirm exit of the same bound process object', false),
    step('record_result', 'report the observed exit as the attempt result', false),
  ]),
  'network.block_connection': Object.freeze([
    step('bind_target', 're-read the rule carrying our own operation id', false),
    step('record_manifest', 'record and flush the recovery intent before any side effect', false),
    step('os_action', 'apply a block rule that carries our own operation id', true, ['network_control']),
    step('observe_result', 're-read the owned rule identity and effect', false),
    step('record_result', 'report the observed rule state as the attempt result', false),
  ]),
  'network.isolate': Object.freeze([
    step('bind_target', 're-read the rule carrying our own operation id', false),
    step('record_manifest', 'record and flush the recovery intent before any side effect', false),
    step('os_action', 'apply an isolation rule that carries our own operation id', true, ['network_control']),
    step('observe_result', 're-read the owned rule identity and effect', false),
    step('record_result', 'report the observed rule state as the attempt result', false),
  ]),
  'file.quarantine': Object.freeze([
    step('bind_target', 're-bind the file object through its secure file or parent-directory handle', false),
    step('record_manifest', 'record and flush the recovery intent before any side effect', false),
    step('os_action', 'relocate the bound file object into the declared quarantine root', true, ['file_control']),
    step('observe_result', 'verify the bound object now sits inside the quarantine root', false),
    step('record_result', 'report the observed location as the attempt result', false),
  ]),
});

/**
 * Numbered copy of the templates.
 *
 * @param {string} actionId Catalog action.
 * @returns {readonly object[]} Steps with a 1-based `index`.
 */
export function stepsFor(actionId) {
  const template = ACTION_STEPS[actionId] ?? Object.freeze([]);
  return Object.freeze(template.map((entry, index) => Object.freeze({ index: index + 1, ...entry })));
}

/**
 * @param {string} actionId Catalog action.
 * @returns {readonly string[]} Capabilities the action needs.
 */
export function requiredCapabilities(actionId) {
  return REQUIRED_CAPABILITIES[actionId] ?? Object.freeze([]);
}

/**
 * Assemble the frozen plan document.
 *
 * @param {object} context Already-verified parts. Nothing here is re-decided: the
 *   policy verdict arrives as data and is only summarised.
 * @returns {Readonly<object>} Frozen plan.
 */
export function buildPlan(context) {
  const {
    envelope,
    decision,
    target,
    parametersDigest,
    snapshot,
    drift,
    capabilities,
    grant,
    grantValid,
    manifest,
    blockedReasons,
    notes,
  } = context;

  const action = getAction(envelope.actionId);
  const steps = stepsFor(envelope.actionId);
  const wouldMutate = steps.some((entry) => entry.would_mutate);
  const reasons = Object.freeze([...(blockedReasons ?? [])]);
  const signedGrant = grantValid === true;
  // "Ready" means every precondition the helper can check is satisfied — it is a
  // statement about the dispatch, not about this build. `executable` is the build
  // statement, and it is false because `EXECUTION_ENABLED` is false.
  //
  // P1-4: a second, independent condition. An action that would change the object
  // is never ready on the strength of "no blocked reasons" alone; it needs a grant
  // that was present, bound, inside its window and verified. Without this, a policy
  // entry with `requiresApproval: false` (Linux `process.suspend`) produced
  // `planned` + `ready_for_execution: true` with no signature at all.
  const ready = reasons.length === 0 && (!wouldMutate || signedGrant);

  const planId = canonicalDigest({
    execution_id: envelope.execution_id,
    attempt_id: envelope.attempt_id,
    // The lease and its sequence are part of the identity. In practice an accepted
    // execution cannot change them (a redelivery returns the stored result), so the
    // inclusion is defensive: it stops a caller-supplied lease or sequence from
    // reusing a plan id it did not earn.
    lease_id: envelope.lease_id,
    sequence: envelope.sequence,
    epoch: envelope.epoch,
    action_id: envelope.actionId,
    os: envelope.os,
    policy_version: decision.policyVersion,
    reason_code: decision.reasonCode,
    action_digest: decision.actionDigest,
    parameters_digest: parametersDigest,
    target_digest: target.digest,
    observed_object_id: snapshot.observed_object_id,
    drift: drift.reasons.map((entry) => entry.code),
    blocked: reasons.map((entry) => entry.code),
  });

  return Object.freeze({
    plan_id: planId,
    interface_version: INTERFACE_VERSION,
    status: reasons.length === 0 ? 'planned' : 'blocked',
    dry_run: true,
    executable: EXECUTION_ENABLED,
    execution_disabled: !EXECUTION_ENABLED,
    ready_for_execution: ready,
    authorizes_execution: false,
    execution_id: envelope.execution_id,
    attempt_id: envelope.attempt_id,
    lease_id: envelope.lease_id,
    sequence: envelope.sequence,
    action_id: envelope.actionId,
    os: envelope.os,
    policy: Object.freeze({
      outcome: decision.outcome,
      reason_code: decision.reasonCode,
      policy_version: decision.policyVersion,
      evaluated_at: decision.evaluatedAt,
      action_digest: decision.actionDigest,
      parameters_digest: decision.parametersDigest,
      target_digest: decision.targetDigest,
      requires_approval: decision.requiresApproval,
      required_role: decision.requiredRole,
      risk: decision.risk,
    }),
    target: Object.freeze({
      kind: target.kind,
      digest: target.digest,
      object_id: target.objectId,
    }),
    snapshot,
    drift,
    capabilities,
    grant,
    steps,
    would_mutate_target: wouldMutate,
    irreversible: IRREVERSIBLE_ACTIONS.includes(envelope.actionId)
      || (action !== null && action.reversible === false),
    /** Whether the grant that accompanied this dispatch was present and verified. */
    grant_valid: signedGrant,
    manifest,
    blocked_reasons: reasons,
    notes: Object.freeze([...(notes ?? [])]),
  });
}

/**
 * Compact audit-safe view of a plan (no steps, no snapshot detail).
 *
 * @param {object} plan Frozen plan.
 * @returns {Readonly<Record<string, unknown>>} Flat summary.
 */
export function planSummary(plan) {
  return Object.freeze({
    plan_id: plan.plan_id,
    status: plan.status,
    action_id: plan.action_id,
    os: plan.os,
    dry_run: true,
    executable: false,
    authorizes_execution: false,
    reason_code: plan.policy.reason_code,
    target_digest: plan.target.digest,
    would_mutate_target: plan.would_mutate_target,
    blocked_codes: Object.freeze(plan.blocked_reasons.map((entry) => entry.code)),
  });
}
