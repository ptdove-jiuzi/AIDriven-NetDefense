/**
 * integration.js — the seam between this gate and the contracts DTOs.
 *
 * The three contracts involved (`ResponseProposal`, `Approval`, `ExecutionGrant`)
 * describe *data*. They do not, and must not, describe permission. This module
 * keeps that separation explicit:
 *
 *   - `toContractTarget` is the only place a normalised target is reduced to the
 *     three fields `ResponseProposal.normalized_target` declares;
 *   - `decisionSummary` produces an audit-safe, flat summary (no free text, no
 *     raw paths, no approver identity beyond the role snapshot);
 *   - `assertGateNeverAuthorizes` is a tripwire: any decision that claims to
 *     authorise execution is a defect and throws.
 *
 * Deliberately absent: any function that turns a decision into an
 * `ExecutionGrant`, or a grant into a decision of `allow` without re-evaluation.
 * Design §10.2 lets only T3b mint a grant, and only the helper consumes one.
 */

import { policyFail } from './errors.js';
import { REASON_CODES } from './reasons.js';
import { toContractTarget } from './target.js';

/**
 * Static description of what the gate consumes and produces.
 *
 * Kept as data so tests can assert the contract instead of trusting prose.
 */
export const POLICY_GATE_CONTRACT = Object.freeze({
  version: '1.0',
  policyVersion: '1.0',
  inputs: Object.freeze([
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
    'options.policyRoots',
  ]),
  outputs: Object.freeze([
    'outcome',
    'reasonCode',
    'detail',
    'actionId',
    'risk',
    'requiredRole',
    'requiresApproval',
    'policyVersion',
    'evaluatedAt',
    'targetDigest',
    'parametersDigest',
    'actionDigest',
    'authorizesExecution',
    'authorizationBoundary',
    'structuralValidationOnly',
    'helperVerificationRequired',
    'notes',
  ]),
  guarantees: Object.freeze([
    'unknown action, unknown OS and undeclared parameter deny instead of being ignored',
    'the decision is a pure function of its inputs, including the supplied now',
    'authorizesExecution is always false',
    'structural validation of proposal, approval and grant never short-circuits policy checks',
    'a human-approvable action is only evaluated together with the proposal its approval binds',
    'a root-bound path parameter stays inside the declared root',
  ]),
  notGuaranteed: Object.freeze([
    'cryptographic verification of an ExecutionGrant signature',
    'authenticity of the supplied Approval: this layer sees a record, not a signature or an issuer',
    'object identity at the moment of the side effect (helper must re-bind)',
    'durable single-use of nonces (daemon transaction or replay registry owns that)',
    'completeness of the replay view: an absent view means "no nonce is known to be spent"',
    'freshness of actorRoles: it is a caller snapshot, and T3a must re-check current roles',
    'that request.os equals the real host OS; the caller declares it',
    'parameter binding of an Approval: contracts carry no parameters_digest, so only a Grant binds parameters',
    'that policyRoots came from deployment config rather than from the request being judged',
    'which deny code a caught exception carries: a caller can forge any deny code, never an allow code',
  ]),
});

/**
 * Reduce a normalised target to the contracts DTO.
 *
 * @param {object} target Normalised target from `normalizeTarget`.
 * @returns {{target_kind: string, digest: string, object_id: string}} DTO.
 */
export function contractTarget(target) {
  return toContractTarget(target);
}

/**
 * Audit-safe flat summary of a decision.
 *
 * Field names are snake_case because this object is intended to be embedded in an
 * `AuditEvent` payload; `authorizes_execution` is included as a literal `false` so
 * a downstream reader cannot mistake the summary for a permission.
 *
 * @param {object} decision Result of `evaluateResponsePolicy`.
 * @returns {Readonly<Record<string, string | boolean | null>>} Frozen summary.
 */
export function decisionSummary(decision) {
  if (decision === null || typeof decision !== 'object') {
    policyFail(REASON_CODES.DENY_INPUT_INVALID, '$', 'decision must be an object');
  }
  return Object.freeze({
    outcome: decision.outcome ?? null,
    reason_code: decision.reasonCode ?? null,
    action_id: decision.actionId ?? null,
    risk: decision.risk ?? null,
    required_role: decision.requiredRole ?? null,
    requires_approval: decision.requiresApproval ?? null,
    policy_version: decision.policyVersion ?? null,
    evaluated_at: decision.evaluatedAt ?? null,
    target_digest: decision.targetDigest ?? null,
    parameters_digest: decision.parametersDigest ?? null,
    action_digest: decision.actionDigest ?? null,
    authorizes_execution: false,
  });
}

/**
 * Tripwire: a policy decision can never authorise execution.
 *
 * @param {object} decision Result of `evaluateResponsePolicy`.
 * @returns {true} True when the invariant holds.
 * @throws {import('./errors.js').PolicyError} When a decision claims authority.
 */
export function assertGateNeverAuthorizes(decision) {
  if (decision === null || typeof decision !== 'object' || decision.authorizesExecution !== false) {
    policyFail(
      REASON_CODES.DENY_INPUT_INVALID,
      '$.authorizesExecution',
      'policy gate decision must never authorise execution',
      { boundary: 'policy_gate_only_not_an_execution_authorization' },
    );
  }
  return true;
}
