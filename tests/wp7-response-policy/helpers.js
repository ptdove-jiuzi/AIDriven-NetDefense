/**
 * helpers.js — shared fixtures for the wp7 response-policy tests.
 *
 * Everything here is synthetic and in-memory: fixed UUIDs, fixed timestamps and
 * obviously fake paths under `C:\TestSandbox` / `/tmp/aegis-test`. No real
 * process, file or rule is referenced, and nothing is written to disk.
 *
 * Timestamps are fixed so a decision is byte-for-byte reproducible; the policy
 * layer takes `now` as an input and never reads a clock, which is what makes this
 * possible.
 */

import {
  validateApproval,
  validateExecutionGrant,
  validateResponseProposal,
} from '@aegisharness/contracts';
import {
  actionDigest,
  getAction,
  normalizeParameters,
  normalizeTarget,
} from '../../packages/response-policy/index.js';

/** Literal backslash, kept out of template strings to survive shell quoting. */
export const BS = String.fromCharCode(92);

export const NOW = '2026-11-02T00:00:00Z';
export const EPOCH = '11111111-1111-4111-8111-111111111111';
export const OTHER_EPOCH = '99999999-9999-4999-8999-999999999999';
export const ANALYSIS_ID = '22222222-2222-4222-8222-222222222222';
export const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
export const APPROVAL_ID = '44444444-4444-4444-8444-444444444444';
export const EXECUTION_ID = '55555555-5555-4555-8555-555555555555';
export const EVIDENCE_ID = '66666666-6666-4666-8666-666666666666';
export const OBJECT_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
export const OTHER_OBJECT_ID = 'BBBBBBBBBBBBBBBBBBBBBB';
export const APPROVAL_NONCE = 'approval-nonce-0000000001';
export const GRANT_NONCE = 'grant-nonce-000000000001';
/** 44 chars of standard base64: the shortest legal signature length. */
export const SIGNATURE = 'A'.repeat(44);

/** `C:\TestSandbox\sample.exe`, built without escape sequences. */
export const WINDOWS_IMAGE_PATH = `C:${BS}TestSandbox${BS}sample.exe`;
export const WINDOWS_FILE_PATH = `C:${BS}TestSandbox${BS}invoice.pdf`;
export const LINUX_IMAGE_PATH = '/tmp/aegis-test/sample';
export const LINUX_FILE_PATH = '/tmp/aegis-test/invoice.pdf';

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised Windows process target.
 */
export function windowsProcessTarget(overrides = {}) {
  return normalizeTarget({
    os: 'windows',
    kind: 'process',
    image_path: WINDOWS_IMAGE_PATH,
    start_time: '2026-10-01T01:02:03Z',
    object_id: OBJECT_ID,
    object_id_source: 'process_handle',
    ...overrides,
  });
}

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised Linux process target.
 */
export function linuxProcessTarget(overrides = {}) {
  return normalizeTarget({
    os: 'linux',
    kind: 'process',
    image_path: LINUX_IMAGE_PATH,
    start_time: '2026-10-01T01:02:03Z',
    object_id: OBJECT_ID,
    object_id_source: 'process_handle',
    ...overrides,
  });
}

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised Windows file target.
 */
export function windowsFileTarget(overrides = {}) {
  return normalizeTarget({
    os: 'windows',
    kind: 'file',
    path: WINDOWS_FILE_PATH,
    object_id: OBJECT_ID,
    object_id_source: 'file_handle',
    ...overrides,
  });
}

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised Linux file target.
 */
export function linuxFileTarget(overrides = {}) {
  return normalizeTarget({
    os: 'linux',
    kind: 'file',
    path: LINUX_FILE_PATH,
    object_id: OBJECT_ID,
    object_id_source: 'parent_dir_handle',
    ...overrides,
  });
}

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised Windows network target.
 */
export function windowsNetworkTarget(overrides = {}) {
  return normalizeTarget({
    os: 'windows',
    kind: 'network',
    protocol: 'tcp',
    local_address: '10.0.0.5',
    local_port: 50123,
    remote_address: '203.0.113.9',
    remote_port: 443,
    operation_id: OBJECT_ID,
    ...overrides,
  });
}

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised Linux network target.
 */
export function linuxNetworkTarget(overrides = {}) {
  return normalizeTarget({
    os: 'linux',
    kind: 'network',
    protocol: 'tcp',
    local_address: '10.0.0.5',
    local_port: 50123,
    remote_address: '203.0.113.9',
    remote_port: 443,
    operation_id: OBJECT_ID,
    ...overrides,
  });
}

/**
 * Normalised parameters for an action, or the empty set when it needs none.
 *
 * @param {string} actionId Catalog action.
 * @param {object} [raw] Raw parameters.
 * @param {'linux' | 'windows'} [os] Target OS.
 * @returns {{value: object, digest: string}} Normalised parameters.
 */
export function paramsFor(actionId, raw, os = 'windows') {
  return normalizeParameters(getAction(actionId), raw, { os });
}

/**
 * Build a contracts-valid ResponseProposal record.
 *
 * @param {{target: object, actionId?: string, risk?: string, expiresAt?: string, actionIdOverride?: string}} options Inputs.
 * @returns {{schemaVersion: string, digest: string, value: object}} Validated record.
 */
export function buildProposal(options) {
  const { target } = options;
  const actionId = options.actionId ?? 'process.terminate';
  const action = getAction(actionId);
  return validateResponseProposal({
    schemaVersion: '1.0',
    proposal_id: PROPOSAL_ID,
    analysis_id: ANALYSIS_ID,
    action_id: options.actionIdOverride ?? actionId,
    normalized_target: {
      target_kind: target.kind,
      digest: target.digest,
      object_id: target.objectId,
    },
    justification_evidence: [EVIDENCE_ID],
    risk: options.risk ?? action.risk,
    expires_at: options.expiresAt ?? '2026-11-02T00:30:00Z',
  });
}

/**
 * Build a contracts-valid Approval record.
 *
 * @param {{proposalDigest: string, targetDigest: string, state?: string, policyVersion?: string, roles?: string[], issuedAt?: string, expiresAt?: string, reauthenticatedAt?: string, nonce?: string, epoch?: string}} options Inputs.
 * @returns {{schemaVersion: string, digest: string, value: object}} Validated record.
 */
export function buildApproval(options) {
  return validateApproval({
    schemaVersion: '1.0',
    approval_id: APPROVAL_ID,
    proposal_digest: options.proposalDigest,
    policy_version: options.policyVersion ?? '1.0',
    target_digest: options.targetDigest,
    approver_identity: {
      account_id: 'CORP\\analyst07',
      role_snapshot: options.roles ?? ['responder'],
      reauthenticated_at: options.reauthenticatedAt ?? '2026-11-01T23:56:00Z',
    },
    nonce: options.nonce ?? APPROVAL_NONCE,
    issued_at: options.issuedAt ?? '2026-11-01T23:58:00Z',
    expires_at: options.expiresAt ?? '2026-11-02T00:30:00Z',
    epoch: options.epoch ?? EPOCH,
    state: options.state ?? 'approved',
  });
}

/**
 * Build a contracts-valid ExecutionGrant record.
 *
 * `action_digest` always comes from the catalog, so a mismatch has to be
 * introduced deliberately by the caller.
 *
 * @param {{approvalId?: string, actionId?: string, parametersDigest: string, targetDigest: string, epoch?: string, notBefore?: string, expiresAt?: string, nonce?: string, executionId?: string}} options Inputs.
 * @returns {{schemaVersion: string, digest: string, value: object}} Validated record.
 */
export function buildGrant(options) {
  const actionId = options.actionId ?? 'process.terminate';
  return validateExecutionGrant({
    schemaVersion: '1.0',
    execution_id: options.executionId ?? EXECUTION_ID,
    approval_id: options.approvalId ?? APPROVAL_ID,
    action_id: actionId,
    action_digest: actionDigest(actionId),
    parameters_digest: options.parametersDigest,
    target_digest: options.targetDigest,
    nonce: options.nonce ?? GRANT_NONCE,
    not_before: options.notBefore ?? '2026-11-01T23:59:00Z',
    expires_at: options.expiresAt ?? '2026-11-02T00:10:00Z',
    epoch: options.epoch ?? EPOCH,
    signature: SIGNATURE,
  });
}

/**
 * Complete, fully approved `process.terminate` scenario on Windows.
 *
 * @param {object} [overrides] Per-part overrides: `{ target, parameters, approval, grant, request }`.
 * @returns {{
 *   target: object, parameters: {value: object, digest: string},
 *   proposal: object, approval: object, grant: object, request: object
 * }} Scenario parts plus a ready request.
 */
export function approvedTerminateScenario(overrides = {}) {
  const target = overrides.target ?? windowsProcessTarget();
  const parameters = overrides.parameters ?? paramsFor('process.terminate', { grace_period_ms: 5000 });
  const proposal = overrides.proposal ?? buildProposal({ target, actionId: 'process.terminate' });
  const approval = overrides.approval ?? buildApproval({
    proposalDigest: proposal.digest,
    targetDigest: target.digest,
  });
  const grant = overrides.grant ?? buildGrant({
    parametersDigest: parameters.digest,
    targetDigest: target.digest,
  });
  return {
    target,
    parameters,
    proposal,
    approval,
    grant,
    request: {
      os: 'windows',
      policyVersion: '1.0',
      now: NOW,
      actionId: 'process.terminate',
      target,
      parameters: parameters.value,
      actorRoles: ['responder'],
      epoch: EPOCH,
      proposal,
      approval,
      grant,
      ...overrides.request,
    },
  };
}

/**
 * Base request skeleton, ready for `evaluateResponsePolicy`.
 *
 * @param {object} [overrides] Field overrides.
 * @returns {object} Request object.
 */
export function baseRequest(overrides = {}) {
  return {
    os: 'windows',
    policyVersion: '1.0',
    now: NOW,
    actionId: 'observe.record_alert',
    target: windowsProcessTarget(),
    actorRoles: ['viewer'],
    epoch: EPOCH,
    ...overrides,
  };
}
