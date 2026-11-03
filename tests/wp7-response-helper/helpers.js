/**
 * helpers.js — fixtures and mock ports for the wp7 response-helper tests.
 *
 * Everything here is synthetic and in-memory: fixed UUIDs, fixed timestamps, paths
 * under `C:\TestSandbox` / `/tmp/aegis-test`, and observations that describe
 * objects which do not exist. No test in this directory touches a real process,
 * socket or file — the helper only ever learns about the outside world through the
 * injected ports, and every port here is a static answer.
 *
 * The contract fixtures mirror `tests/wp7-response-policy/helpers.js` on purpose:
 * the helper must accept exactly the dispatch the policy gate would produce, and
 * duplicating the fixture is what makes a divergence show up as a failing test
 * instead of an integration surprise later.
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
import {
  createFixedClock,
  createMemoryManifestStore,
  createResponseHelper,
  createStaticCapabilityProbe,
  createStaticGrantVerifier,
  createStaticOsProbe,
  createStaticTargetProbe,
} from '../../apps/response-helper/index.js';

/** Literal backslash, kept out of template strings to survive shell quoting. */
export const BS = String.fromCharCode(92);

export const NOW = '2026-11-02T00:00:00Z';
export const EPOCH = '11111111-1111-4111-8111-111111111111';
export const OTHER_EPOCH = '99999999-9999-4999-8999-999999999999';
export const ANALYSIS_ID = '22222222-2222-4222-8222-222222222222';
export const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
export const APPROVAL_ID = '44444444-4444-4444-8444-444444444444';
export const EXECUTION_ID = '55555555-5555-4555-8555-555555555555';
export const OTHER_EXECUTION_ID = '77777777-7777-4777-8777-777777777777';
export const ATTEMPT_ID = '88888888-8888-4888-8888-888888888888';
export const OTHER_ATTEMPT_ID = '99999999-9999-4999-8999-999999999999';
export const EVIDENCE_ID = '66666666-6666-4666-8666-666666666666';
export const OBJECT_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
export const OTHER_OBJECT_ID = 'BBBBBBBBBBBBBBBBBBBBBB';
export const LEASE_ID = 'lease-0000000000000001';
export const APPROVAL_NONCE = 'approval-nonce-0000000001';
export const GRANT_NONCE = 'grant-nonce-000000000001';
export const SIGNATURE = 'A'.repeat(44);

export const WINDOWS_IMAGE_PATH = `C:${BS}TestSandbox${BS}sample.exe`;
export const WINDOWS_FILE_PATH = `C:${BS}TestSandbox${BS}invoice.pdf`;
export const WINDOWS_QUARANTINE_PATH = `C:${BS}ProgramData${BS}AegisHarness${BS}quarantine${BS}invoice.pdf`;
export const LINUX_IMAGE_PATH = '/tmp/aegis-test/sample';
export const LINUX_FILE_PATH = '/tmp/aegis-test/invoice.pdf';
export const LINUX_QUARANTINE_PATH = '/var/lib/aegisharness/quarantine/invoice.pdf';

const START_TIME = '2026-10-01T01:02:03Z';
const OTHER_START_TIME = '2026-10-02T04:05:06Z';

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised process target.
 */
export function processTarget(overrides = {}) {
  const os = overrides.os ?? 'windows';
  return normalizeTarget({
    os,
    kind: 'process',
    image_path: os === 'windows' ? WINDOWS_IMAGE_PATH : LINUX_IMAGE_PATH,
    start_time: START_TIME,
    object_id: OBJECT_ID,
    object_id_source: 'process_handle',
    pid: 4321,
    ...overrides,
  });
}

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised file target.
 */
export function fileTarget(overrides = {}) {
  const os = overrides.os ?? 'windows';
  return normalizeTarget({
    os,
    kind: 'file',
    path: os === 'windows' ? WINDOWS_FILE_PATH : LINUX_FILE_PATH,
    object_id: OBJECT_ID,
    object_id_source: 'file_handle',
    ...overrides,
  });
}

/**
 * @param {object} [overrides] Field overrides applied before normalisation.
 * @returns {object} Normalised network target.
 */
export function networkTarget(overrides = {}) {
  return normalizeTarget({
    os: overrides.os ?? 'windows',
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
 * @param {{target: object, actionId?: string, risk?: string, expiresAt?: string}} options Inputs.
 * @returns {{schemaVersion: string, digest: string, value: object}} Validated record.
 */
export function buildProposal(options) {
  const actionId = options.actionId ?? 'process.terminate';
  const action = getAction(actionId);
  return validateResponseProposal({
    schemaVersion: '1.0',
    proposal_id: PROPOSAL_ID,
    analysis_id: ANALYSIS_ID,
    action_id: actionId,
    normalized_target: {
      target_kind: options.target.kind,
      digest: options.target.digest,
      object_id: options.target.objectId,
    },
    justification_evidence: [EVIDENCE_ID],
    risk: options.risk ?? action.risk,
    expires_at: options.expiresAt ?? '2026-11-02T00:30:00Z',
  });
}

/**
 * Build a contracts-valid Approval record.
 *
 * @param {{proposalDigest: string, targetDigest: string, state?: string, roles?: string[], epoch?: string, expiresAt?: string, issuedAt?: string, nonce?: string}} options Inputs.
 * @returns {{schemaVersion: string, digest: string, value: object}} Validated record.
 */
export function buildApproval(options) {
  return validateApproval({
    schemaVersion: '1.0',
    approval_id: APPROVAL_ID,
    proposal_digest: options.proposalDigest,
    policy_version: '1.0',
    target_digest: options.targetDigest,
    approver_identity: {
      account_id: `CORP${BS}analyst07`,
      role_snapshot: options.roles ?? ['responder'],
      reauthenticated_at: '2026-11-01T23:56:00Z',
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
 * @param {{parametersDigest: string, targetDigest: string, actionId?: string, epoch?: string, notBefore?: string, expiresAt?: string, nonce?: string, executionId?: string}} options Inputs.
 * @returns {{schemaVersion: string, digest: string, value: object}} Validated record.
 */
export function buildGrant(options) {
  const actionId = options.actionId ?? 'process.terminate';
  return validateExecutionGrant({
    schemaVersion: '1.0',
    execution_id: options.executionId ?? EXECUTION_ID,
    approval_id: APPROVAL_ID,
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
 * An observation that reports the object the target describes, still present.
 *
 * @param {object} target Normalised target.
 * @param {object} [overrides] Observation overrides.
 * @returns {object} Observation for a static probe.
 */
export function observationFor(target, overrides = {}) {
  return {
    state: 'present',
    objectId: target.objectId,
    identity: target.identity,
    os: target.os,
    pid: target.pid,
    observedAt: NOW,
    ...overrides,
  };
}

/** Capability table where everything is granted. */
export const ALL_GRANTED = Object.freeze({
  process_control: 'granted',
  network_control: 'granted',
  file_control: 'granted',
});

/**
 * Build a dispatch envelope around a fully approved scenario.
 *
 * @param {{
 *   actionId?: string, target?: object, parameters?: object, os?: string,
 *   grant?: object, approval?: object, proposal?: object, now?: string,
 *   executionId?: string, attemptId?: string, actorRoles?: string[], epoch?: string,
 *   replay?: object
 * }} [options] Overrides.
 * @returns {object} Envelope ready for `prepare`.
 */
export function envelopeFor(options = {}) {
  const actionId = options.actionId ?? 'process.terminate';
  const os = options.os ?? 'windows';
  const target = options.target ?? processTarget({ os });
  // `parameters` may arrive already normalised (`{value, digest}`) or raw; the
  // grant needs the digest, so normalise the raw form here rather than silently
  // handing `undefined` to the contracts validator.
  const given = options.parameters;
  const parameters = given !== null
    && typeof given === 'object'
    && typeof given.digest === 'string'
    && typeof given.value === 'object'
    ? given
    : paramsFor(actionId, given ?? defaultParameters(actionId, os), os);
  const action = getAction(actionId);
  // A grant always claims to consume an approval (policy: DENY_GRANT_APPROVAL_MISMATCH
  // when it cannot find one), so an action that needs no approval must not carry
  // one. Building the triple unconditionally would make every ungated action look
  // like a replay attempt.
  const requiresApproval = action !== null && action.requiresApproval === true;
  let proposal = options.proposal ?? null;
  let approval = options.approval ?? null;
  let grant = options.grant ?? null;
  if (requiresApproval) {
    proposal = proposal ?? buildProposal({ target, actionId });
    approval = approval ?? buildApproval({
      proposalDigest: proposal.digest,
      targetDigest: target.digest,
    });
    grant = grant ?? buildGrant({
      actionId,
      parametersDigest: parameters.digest,
      targetDigest: target.digest,
      executionId: options.executionId ?? EXECUTION_ID,
    });
  }
  const envelope = {
    schemaVersion: '1.0',
    execution_id: options.executionId ?? EXECUTION_ID,
    attempt_id: options.attemptId ?? ATTEMPT_ID,
    lease_id: LEASE_ID,
    sequence: 0,
    os,
    policyVersion: '1.0',
    now: options.now ?? NOW,
    actionId,
    target,
    parameters: parameters.value,
    actorRoles: options.actorRoles ?? ['responder'],
    epoch: options.epoch ?? EPOCH,
    replay: options.replay,
  };
  if (proposal !== null) envelope.proposal = proposal;
  if (approval !== null) envelope.approval = approval;
  if (grant !== null) envelope.grant = grant;
  return envelope;
}

/**
 * Default raw parameters per action.
 *
 * @param {string} actionId Catalog action.
 * @param {string} os Target OS.
 * @returns {object | undefined} Raw parameters.
 */
export function defaultParameters(actionId, os = 'windows') {
  if (actionId === 'process.terminate') return { grace_period_ms: 5000 };
  if (actionId === 'network.block_connection' || actionId === 'network.isolate') {
    return { direction: 'outbound', duration_ms: 60000 };
  }
  if (actionId === 'file.quarantine') {
    return {
      quarantine_root: os === 'windows' ? WINDOWS_QUARANTINE_PATH : LINUX_QUARANTINE_PATH,
      preserve_metadata: true,
    };
  }
  return undefined;
}

/**
 * Alert-only dispatch: no proposal, no approval, no grant.
 *
 * `observe.record_alert` requires none of them, and sending them anyway would
 * exercise the "approval supplied for an action that does not require one" note
 * instead of the plain path.
 *
 * @param {object} target Normalised target.
 * @param {object} [overrides] Envelope overrides.
 * @returns {object} Envelope.
 */
export function alertEnvelope(target, overrides = {}) {
  const envelope = envelopeFor({
    actionId: 'observe.record_alert',
    target,
    actorRoles: ['viewer'],
    ...overrides,
  });
  delete envelope.proposal;
  delete envelope.approval;
  delete envelope.grant;
  delete envelope.parameters;
  return envelope;
}

/**
 * A manifest recorder that stands in for a real "write and fsync" writer.
 *
 * The packaged `createMemoryManifestStore` can never report `durable: true` — that
 * was a security-review finding, because a `Map` claiming durability would let the
 * design's crash boundary degrade into "the injected port said so". A durable
 * writer therefore has to be injected explicitly, and this is the test double that
 * does it.
 *
 * @returns {object} Manifest store reporting durable entries.
 */
export function createDurableManifestStore() {
  const entries = new Map();
  let counter = 0;
  return {
    record(intent) {
      counter += 1;
      const entry = Object.freeze({
        recovery_id: `recovery-${String(counter).padStart(6, '0')}`,
        ...intent,
        phase: 'prepared',
        durable: true,
      });
      entries.set(entry.recovery_id, entry);
      return entry;
    },
    get(recoveryId) {
      return entries.get(recoveryId) ?? null;
    },
    list() {
      return Object.freeze([...entries.values()]);
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * Create a helper wired to mock ports.
 *
 * Defaults are the "everything checks out" answers so a test only has to override
 * the one port it is about. The production defaults are the opposite (unknown /
 * unverifiable / no trust root), and a dedicated test asserts that.
 *
 * @param {object} [options] Port overrides plus `os`, `capabilities`, `observation`.
 * @returns {object} Helper.
 */
export function createHelper(options = {}) {
  const os = options.os ?? 'windows';
  const target = options.target;
  const observation = options.observation
    ?? (target === undefined ? { state: 'unverifiable', reason: 'no_target_supplied' } : observationFor(target));
  return createResponseHelper({
    osProbe: options.osProbe ?? createStaticOsProbe(os),
    capabilityProbe: options.capabilityProbe ?? createStaticCapabilityProbe(options.capabilities ?? ALL_GRANTED),
    targetProbe: options.targetProbe ?? createStaticTargetProbe(observation),
    grantVerifier: options.grantVerifier ?? createStaticGrantVerifier({ ok: true, keyId: 'test-root-1' }),
    inbox: options.inbox,
    // Default to a durable-looking writer so a test only overrides the port it is
    // about. `manifestDurable: false` selects the packaged in-memory store, whose
    // `durable: false` is what a real build has until a writer exists.
    manifestStore: options.manifestStore
      ?? (options.manifestDurable === false ? createMemoryManifestStore() : createDurableManifestStore()),
    // The dispatch `now` and the helper clock must agree, or the skew check fires
    // before any grant is looked at. Tests that move `now` move the clock too.
    clock: options.clock ?? createFixedClock(options.now ?? NOW),
  });
}
