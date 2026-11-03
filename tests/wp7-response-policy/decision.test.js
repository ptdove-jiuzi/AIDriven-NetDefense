/**
 * The decision function: allow / needs_approval / deny, and the precedence that
 * makes `reasonCode` stable.
 *
 * Two things are asserted here that a "happy path" test would miss:
 *
 *   - every malformed request **denies without throwing**, because a thrown error
 *     in a security gate is indistinguishable from "check skipped" at the call
 *     site;
 *   - `authorizesExecution` is `false` on every path, including `allow`. Passing
 *     this gate is not permission to act.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EPOCH,
  NOW,
  baseRequest,
  buildProposal,
  linuxFileTarget,
  windowsFileTarget,
  windowsProcessTarget,
} from './helpers.js';
import {
  OUTCOMES,
  PolicyError,
  REASON_CODES,
  REASON_OUTCOMES,
  evaluateResponsePolicy,
  isReasonCode,
  outcomeFor,
  roleSatisfies,
} from '../../packages/response-policy/index.js';

const DECISION_KEYS = Object.freeze([
  'actionDigest',
  'actionId',
  'authorizationBoundary',
  'authorizesExecution',
  'detail',
  'evaluatedAt',
  'helperVerificationRequired',
  'notes',
  'outcome',
  'parametersDigest',
  'policyVersion',
  'reasonCode',
  'requiredRole',
  'requiresApproval',
  'risk',
  'structuralValidationOnly',
  'targetDigest',
].sort());

describe('policy decision', () => {
  it('allows an alert-only action requested by a viewer', () => {
    const decision = evaluateResponsePolicy(baseRequest());
    assert.equal(decision.outcome, OUTCOMES.ALLOW);
    assert.equal(decision.reasonCode, REASON_CODES.ALLOWED);
    assert.equal(decision.risk, 'low');
    assert.equal(decision.requiredRole, 'viewer');
    assert.equal(decision.requiresApproval, false);
    assert.equal(decision.authorizesExecution, false);
    assert.equal(decision.authorizationBoundary, 'policy_gate_only_not_an_execution_authorization');
  });

  it('returns the same decision shape on every outcome', () => {
    const allowed = evaluateResponsePolicy(baseRequest());
    const terminateTarget = windowsProcessTarget();
    const needsApproval = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target: terminateTarget,
      actorRoles: ['responder'],
      parameters: { grace_period_ms: 1000 },
      proposal: buildProposal({ target: terminateTarget, actionId: 'process.terminate' }),
      epoch: '11111111-1111-4111-8111-111111111111',
    }));
    const denied = evaluateResponsePolicy(baseRequest({ actionId: 'evil.action' }));
    for (const decision of [allowed, needsApproval, denied]) {
      assert.deepEqual(Object.keys(decision).sort(), DECISION_KEYS);
      assert.equal(decision.authorizesExecution, false);
      assert.equal(Object.isFrozen(decision), true);
      assert.ok(isReasonCode(decision.reasonCode), decision.reasonCode);
      assert.equal(REASON_OUTCOMES[decision.reasonCode], decision.outcome);
    }
    assert.equal(needsApproval.outcome, OUTCOMES.NEEDS_APPROVAL);
    assert.equal(needsApproval.reasonCode, REASON_CODES.APPROVAL_REQUIRED);
    assert.equal(denied.outcome, OUTCOMES.DENY);
  });

  it('denies an unknown action', () => {
    const decision = evaluateResponsePolicy(baseRequest({ actionId: 'process.pause' }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_UNKNOWN_ACTION);
    assert.equal(decision.risk, null);
  });

  it('denies a known-but-forbidden action with an explicit reason', () => {
    const decision = evaluateResponsePolicy(baseRequest({ actionId: 'shell.exec' }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_ACTION_FORBIDDEN);
    assert.equal(decision.detail.actionId, 'shell.exec');
    assert.match(decision.detail.reason, /command execution/u);
  });

  it('denies an OS family the policy does not know', () => {
    const decision = evaluateResponsePolicy(baseRequest({ os: 'darwin' }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_OS_UNKNOWN);
    assert.equal(decision.detail.os, 'darwin');
  });

  it('denies an action that is not published on the requested OS', () => {
    const decision = evaluateResponsePolicy(baseRequest({
      os: 'windows',
      actionId: 'process.suspend',
      target: windowsProcessTarget(),
      actorRoles: ['responder'],
    }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_OS_UNSUPPORTED);
    assert.equal(decision.detail.os, 'windows');
    assert.match(decision.detail.reason, /public API/u);

    const linux = evaluateResponsePolicy(baseRequest({
      os: 'linux',
      actionId: 'process.suspend',
      target: windowsProcessTarget({ os: 'linux', image_path: '/usr/bin/thing' }),
      actorRoles: ['responder'],
    }));
    assert.equal(linux.reasonCode, REASON_CODES.ALLOWED);
  });

  it('denies a plan whose target was normalised on another OS', () => {
    const decision = evaluateResponsePolicy(baseRequest({
      os: 'windows',
      actionId: 'file.quarantine',
      target: linuxFileTarget(),
      parameters: { quarantine_root: '/var/quarantine' },
      actorRoles: ['responder'],
      epoch: '11111111-1111-4111-8111-111111111111',
    }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_TARGET_OS_MISMATCH);
    assert.equal(decision.detail.targetOs, 'linux');
    assert.equal(decision.detail.requestOs, 'windows');
  });

  it('denies a target kind the action does not accept', () => {
    const decision = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target: windowsFileTarget(),
      actorRoles: ['responder'],
      epoch: '11111111-1111-4111-8111-111111111111',
    }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_TARGET_KIND_MISMATCH);
    assert.deepEqual(decision.detail.accepted, ['process']);
  });

  it('denies a risk level declared below the catalog floor', () => {
    const target = windowsProcessTarget();
    const proposal = buildProposal({ target, actionId: 'process.terminate' });
    const decision = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target,
      actorRoles: ['responder'],
      declaredRisk: 'low',
      proposal,
      epoch: '11111111-1111-4111-8111-111111111111',
    }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_RISK_UNDERSTATED);
    assert.equal(decision.detail.floor, 'critical');

    const honest = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target,
      actorRoles: ['responder'],
      declaredRisk: 'critical',
      proposal,
      epoch: '11111111-1111-4111-8111-111111111111',
    }));
    assert.equal(honest.reasonCode, REASON_CODES.APPROVAL_REQUIRED);
  });

  it('denies an undeclared risk level', () => {
    const decision = evaluateResponsePolicy(baseRequest({ declaredRisk: 'severe' }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_INPUT_INVALID);
    assert.equal(decision.detail.field, 'declaredRisk');
  });

  it('denies insufficient requesting roles and reports malformed role input separately', () => {
    const viewer = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target: windowsProcessTarget(),
      actorRoles: ['viewer'],
    }));
    assert.equal(viewer.reasonCode, REASON_CODES.DENY_ROLE_INSUFFICIENT);
    assert.deepEqual(viewer.detail.actorRoles, ['viewer']);

    for (const malformed of [undefined, [], ['superuser'], ['viewer', 'viewer'], 'responder', ['responder', 'viewer', 'admin', 'analyst', 'budget-admin', 'nope']]) {
      const decision = evaluateResponsePolicy(baseRequest({ actorRoles: malformed }));
      assert.equal(decision.reasonCode, REASON_CODES.DENY_INPUT_INVALID, JSON.stringify(malformed));
      assert.equal(decision.detail.field, 'actorRoles');
    }
  });

  it('treats budget-admin as a separate duty and admin as not-a-responder', () => {
    assert.equal(roleSatisfies(['budget-admin'], 'responder'), false);
    assert.equal(roleSatisfies(['budget-admin'], 'viewer'), false);
    assert.equal(roleSatisfies(['admin'], 'responder'), false);
    assert.equal(roleSatisfies(['admin'], 'viewer'), true);
    assert.equal(roleSatisfies(['responder'], 'viewer'), true);
    assert.equal(roleSatisfies(['analyst'], 'responder'), false);
    assert.equal(roleSatisfies([], 'viewer'), false);
    assert.equal(roleSatisfies(['viewer'], 'unknown-role'), false);

    const byBudget = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target: windowsProcessTarget(),
      actorRoles: ['budget-admin'],
    }));
    assert.equal(byBudget.reasonCode, REASON_CODES.DENY_ROLE_INSUFFICIENT);

    // §10.2: `aegis-admins` is not a responder group, so a local administrator
    // alone must not be able to request a response action.
    const byAdmin = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target: windowsProcessTarget(),
      actorRoles: ['admin'],
    }));
    assert.equal(byAdmin.reasonCode, REASON_CODES.DENY_ROLE_INSUFFICIENT);
    assert.equal(byAdmin.detail.required, 'responder');
  });

  it('denies an unsupported or missing policy version', () => {
    for (const policyVersion of ['0.9', '2.0', '1.0.0', '1', '']) {
      const decision = evaluateResponsePolicy(baseRequest({ policyVersion }));
      assert.equal(decision.reasonCode, REASON_CODES.DENY_POLICY_VERSION_UNSUPPORTED, policyVersion);
    }
    const missing = evaluateResponsePolicy(baseRequest({ policyVersion: undefined }));
    assert.equal(missing.reasonCode, REASON_CODES.DENY_POLICY_VERSION_UNSUPPORTED);
  });

  it('asks for approval instead of allowing a high-risk action', () => {
    const target = windowsProcessTarget();
    const decision = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target,
      actorRoles: ['responder'],
      parameters: { grace_period_ms: 1000 },
      proposal: buildProposal({ target, actionId: 'process.terminate' }),
      epoch: '11111111-1111-4111-8111-111111111111',
    }));
    assert.equal(decision.outcome, OUTCOMES.NEEDS_APPROVAL);
    assert.equal(decision.reasonCode, REASON_CODES.APPROVAL_REQUIRED);
    assert.equal(decision.detail.requiredRole, 'responder');
    assert.equal(decision.authorizesExecution, false);
  });

  it('requires the proposal for any action that needs approval', () => {
    const target = windowsProcessTarget();
    const decision = evaluateResponsePolicy(baseRequest({
      actionId: 'process.terminate',
      target,
      actorRoles: ['responder'],
      proposal: undefined,
    }));
    assert.equal(decision.reasonCode, REASON_CODES.DENY_PROPOSAL_REQUIRED);
    assert.equal(decision.detail.actionId, 'process.terminate');
  });

  it('requires an epoch even when the action needs no approval', () => {
    const withoutEpoch = evaluateResponsePolicy(baseRequest({
      os: 'linux',
      actionId: 'process.suspend',
      target: windowsProcessTarget({ os: 'linux', image_path: '/usr/bin/thing' }),
      actorRoles: ['responder'],
      epoch: undefined,
    }));
    assert.equal(withoutEpoch.reasonCode, REASON_CODES.DENY_EPOCH_REQUIRED);
    assert.equal(withoutEpoch.detail.field, 'epoch');
  });

  it('evaluates the environment before the action, so precedence is stable', () => {
    const both = evaluateResponsePolicy(baseRequest({ policyVersion: '9.9', actionId: 'evil.action' }));
    assert.equal(both.reasonCode, REASON_CODES.DENY_POLICY_VERSION_UNSUPPORTED);

    const actionBeforeOs = evaluateResponsePolicy(baseRequest({ os: 'darwin', actionId: 'evil.action' }));
    assert.equal(actionBeforeOs.reasonCode, REASON_CODES.DENY_OS_UNKNOWN);
  });

  it('never throws on a malformed request', () => {
    const hostileTarget = baseRequest();
    Object.defineProperty(hostileTarget, 'target', {
      enumerable: true,
      get() {
        throw new Error('boom-target');
      },
    });
    const hostileNow = baseRequest();
    Object.defineProperty(hostileNow, 'now', {
      enumerable: true,
      get() {
        throw new Error('boom-now');
      },
    });
    const hostileAction = baseRequest();
    Object.defineProperty(hostileAction, 'actionId', {
      enumerable: true,
      get() {
        throw new Error('boom-action');
      },
    });
    const hostileProposal = baseRequest();
    Object.defineProperty(hostileProposal, 'proposal', {
      enumerable: true,
      get() {
        throw new Error('boom-proposal');
      },
    });
    const inputs = [
      ['undefined', undefined],
      ['null', null],
      ['empty object', {}],
      ['array', []],
      ['string', 'deny please'],
      ['number', 42],
      ['bad now', { now: 'yesterday' }],
      ['offset timestamp', baseRequest({ now: '2026-11-02T00:00:00+08:00' })],
      ['null target', baseRequest({ target: null })],
      ['partial target', baseRequest({ target: { os: 'windows' } })],
      ['role string', baseRequest({ target: windowsProcessTarget(), actorRoles: 'responder' })],
      ['string parameters', baseRequest({ parameters: 'none' })],
      ['numeric action', baseRequest({ actionId: 42 })],
      ['throwing target getter', hostileTarget],
      ['throwing now getter', hostileNow],
      ['throwing actionId getter', hostileAction],
      ['throwing proposal getter', hostileProposal],
    ];
    for (const [label, input] of inputs) {
      const decision = evaluateResponsePolicy(input);
      assert.equal(decision.outcome, OUTCOMES.DENY, label);
      assert.ok(isReasonCode(decision.reasonCode), `${label}: ${String(decision.reasonCode)}`);
      assert.equal(decision.authorizesExecution, false, label);
      assert.deepEqual(Object.keys(decision).sort(), DECISION_KEYS, label);
    }
  });

  it('cannot be made to throw or to dictate the reason code by a hostile thrown value', () => {
    const cyclic = { name: 'loop' };
    cyclic.self = cyclic;
    const forgedNoCode = Object.create(PolicyError.prototype);
    const forgedBogusCode = new PolicyError('DENY_TOTALLY_MADE_UP', '$', 'forged');
    const forgedCyclic = new PolicyError('DENY_TARGET_SHAPE', '$', 'cyclic');
    forgedCyclic.detail = cyclic;
    const hostileName = {
      get name() {
        throw new Error('name getter');
      },
    };
    const throwingPolicyError = new PolicyError('DENY_TARGET_SHAPE', '$', 'detail');
    Object.defineProperty(throwingPolicyError, 'detail', {
      get() {
        throw new Error('detail getter');
      },
    });

    const thrown = [
      ['plain error', new Error('boom')],
      ['string', 'boom'],
      ['undefined', undefined],
      ['hostile name getter', hostileName],
      ['forged without code', forgedNoCode],
      ['forged bogus code', forgedBogusCode],
      ['forged cyclic detail', forgedCyclic],
      ['forged detail getter', throwingPolicyError],
      // 关键：伪造一个"允许"或"需审批"的码，会让 deny 决策带着 allow 的 reasonCode，
      // 审计按 code 分支时被读成放行。deny 只能配 deny 码。
      ['forged ALLOWED code', new PolicyError('ALLOWED', '$', 'forged')],
      ['forged APPROVAL_REQUIRED code', new PolicyError('APPROVAL_REQUIRED', '$', 'forged')],
    ];
    for (const [label, value] of thrown) {
      const request = baseRequest();
      Object.defineProperty(request, 'target', {
        enumerable: true,
        get() {
          throw value;
        },
      });
      const decision = evaluateResponsePolicy(request);
      assert.equal(decision.outcome, OUTCOMES.DENY, label);
      assert.ok(isReasonCode(decision.reasonCode), `${label}: ${String(decision.reasonCode)}`);
      assert.notEqual(decision.reasonCode, 'DENY_TOTALLY_MADE_UP', label);
      // 不变量：reasonCode 蕴含的 outcome 必须与真实 outcome 一致。
      assert.equal(REASON_OUTCOMES[decision.reasonCode], decision.outcome, label);
      assert.notEqual(decision.reasonCode, REASON_CODES.ALLOWED, label);
      assert.notEqual(decision.reasonCode, REASON_CODES.APPROVAL_REQUIRED, label);
      assert.deepEqual(Object.keys(decision).sort(), DECISION_KEYS, label);
      assert.equal(Object.isFrozen(decision), true, label);
    }

    // A proxy that throws on reflection is the same class of threat.
    const proxied = new Proxy({}, {
      ownKeys() {
        throw new Error('ownKeys');
      },
      get() {
        throw new Error('get');
      },
    });
    const decision = evaluateResponsePolicy(proxied);
    assert.equal(decision.outcome, OUTCOMES.DENY);
    assert.equal(decision.reasonCode, REASON_CODES.DENY_INPUT_INVALID);
  });

  it('denies an undeclared request field instead of silently ignoring it', () => {
    for (const extra of [{ notes: undefined }, { proposol: {} }, { policyRoots: { quarantine: ['/'] } }]) {
      const [field] = Object.keys(extra);
      const decision = evaluateResponsePolicy({ ...baseRequest(), ...extra });
      assert.equal(decision.reasonCode, REASON_CODES.DENY_INPUT_INVALID, field);
      assert.equal(decision.detail.field, field);
    }
  });

  it('denies a malformed replay view instead of reading it as empty', () => {
    const cases = [
      'nonce-1',
      42,
      [],
      { approvalNonces: 'approval-nonce-0000000001' },
      { approvalNonces: [1, 2] },
      { approvalNonces: [''] },
      { grantNonces: {}, executionIds: [] },
      { unexpected: [] },
    ];
    for (const replay of cases) {
      const decision = evaluateResponsePolicy(baseRequest({ replay }));
      assert.equal(decision.reasonCode, REASON_CODES.DENY_INPUT_INVALID, String(replay));
      assert.equal(typeof decision.detail.field, 'string', String(replay));
    }
    // Absent or null simply means the caller keeps no spent-nonce state.
    assert.equal(evaluateResponsePolicy(baseRequest({ replay: undefined })).reasonCode, REASON_CODES.ALLOWED);
    assert.equal(evaluateResponsePolicy(baseRequest({ replay: null })).reasonCode, REASON_CODES.ALLOWED);
  });

  it('takes quarantine roots from deployment options, never from the request', () => {
    const target = windowsFileTarget();
    const proposal = buildProposal({ target, actionId: 'file.quarantine' });
    const base = {
      os: 'windows',
      policyVersion: '1.0',
      now: NOW,
      actionId: 'file.quarantine',
      target,
      actorRoles: ['responder'],
      epoch: EPOCH,
      proposal,
    };
    // 请求自带 policyRoots 属于未声明字段：把根交给被判定方，等于让它自己声明
    // "我可以落到 C:\Windows"。
    const viaRequest = evaluateResponsePolicy({
      ...base,
      parameters: { quarantine_root: 'C:\\Windows\\System32' },
      policyRoots: { quarantine: ['C:\\Windows'] },
    });
    assert.equal(viaRequest.reasonCode, REASON_CODES.DENY_INPUT_INVALID);
    assert.equal(viaRequest.detail.field, 'policyRoots');

    // 默认根仍然挡住系统目录。
    assert.equal(
      evaluateResponsePolicy({ ...base, parameters: { quarantine_root: 'C:\\Windows\\System32' } }).reasonCode,
      REASON_CODES.DENY_PARAMETER_OUTSIDE_ROOT,
    );

    // 受信任的部署配置可以放宽根；这一步不能再由请求影响。
    const widened = evaluateResponsePolicy(
      { ...base, parameters: { quarantine_root: 'C:\\Quarantine\\run1' } },
      { policyRoots: { quarantine: ['C:\\Quarantine'] } },
    );
    assert.equal(widened.reasonCode, REASON_CODES.APPROVAL_REQUIRED);
  });

  it('declares an outcome for every reason code and refuses unknown ones', () => {
    for (const code of Object.values(REASON_CODES)) {
      assert.equal(outcomeFor(code), REASON_OUTCOMES[code]);
    }
    assert.throws(() => outcomeFor('DENY_SOMETHING_NEW'), TypeError);
    assert.equal(isReasonCode('ALLOWED'), true);
    assert.equal(isReasonCode('allowed'), false);
    assert.equal(isReasonCode(undefined), false);
  });
});
