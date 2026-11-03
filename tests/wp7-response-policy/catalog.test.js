/**
 * The closed action catalog and the action × OS matrix.
 *
 * These tests are deliberately about *shape*, not about individual actions: they
 * stay green when an action is added with correct metadata and go red when one is
 * added without a risk floor, a role, an approval flag, a fail-closed condition or
 * an OS declaration. That is the property the task actually needs — a catalog
 * that cannot grow an unclassified entry.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTION_CATALOG,
  ACTION_IDS,
  ACTION_OS_MATRIX,
  CURRENT_POLICY_VERSION,
  FORBIDDEN_ACTIONS,
  IRREVERSIBLE_ACTIONS,
  PARAMETER_SPEC_TYPES,
  RISK_RANK,
  ROLE_CAPABILITIES,
  SUPPORTED_OS,
  SUPPORTED_POLICY_VERSIONS,
  actionDigest,
  capabilityForRole,
  evaluateResponsePolicy,
  getAction,
  isCatalogAction,
  isForbiddenAction,
  osSupportFor,
  verifyCatalog,
} from '../../packages/response-policy/index.js';
import { baseRequest } from './helpers.js';

describe('action catalog', () => {
  it('satisfies every catalog invariant', () => {
    assert.equal(verifyCatalog(), true);
  });

  it('publishes exactly the declared identifiers and nothing else', () => {
    assert.ok(ACTION_IDS.length >= 6, `expected at least 6 actions, found ${ACTION_IDS.length}`);
    assert.deepEqual([...Object.keys(ACTION_CATALOG)].sort(), [...ACTION_IDS].sort());
    for (const id of ACTION_IDS) {
      assert.match(id, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){1,3}$/u);
    }
  });

  it('declares risk, role, approval, target kinds and fail-closed conditions for every action', () => {
    for (const id of ACTION_IDS) {
      const action = ACTION_CATALOG[id];
      assert.ok(Object.prototype.hasOwnProperty.call(RISK_RANK, action.risk), `${id}.risk`);
      assert.ok(Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, action.requiredRole), `${id}.requiredRole`);
      assert.notEqual(action.requiredRole, 'budget-admin', `${id} must not require budget-admin`);
      assert.equal(typeof action.requiresApproval, 'boolean', `${id}.requiresApproval`);
      assert.ok(action.targetKinds.length > 0, `${id}.targetKinds`);
      assert.ok(action.failClosed.length > 0, `${id}.failClosed`);
      assert.equal(typeof action.reversible, 'boolean', `${id}.reversible`);
      for (const kind of action.targetKinds) {
        assert.ok(['process', 'network', 'file'].includes(kind), `${id} target kind ${kind}`);
      }
    }
  });

  it('anchors irreversibility on a constant table, not on the flag it constrains', () => {
    assert.deepEqual([...IRREVERSIBLE_ACTIONS], ['process.terminate']);
    for (const id of IRREVERSIBLE_ACTIONS) {
      assert.equal(ACTION_CATALOG[id].requiresApproval, true, `${id} must require approval`);
      assert.equal(ACTION_CATALOG[id].reversible, false, `${id} must be marked irreversible`);
    }
    for (const id of ACTION_IDS) {
      assert.equal(
        ACTION_CATALOG[id].reversible,
        !IRREVERSIBLE_ACTIONS.includes(id),
        `${id}.reversible disagrees with IRREVERSIBLE_ACTIONS`,
      );
    }
  });

  it('separates admin from responder instead of ranking roles', () => {
    assert.deepEqual([...ROLE_CAPABILITIES.admin], ['view', 'analyze', 'authorize']);
    assert.equal(ROLE_CAPABILITIES.admin.includes('respond'), false);
    assert.equal(ROLE_CAPABILITIES.responder.includes('respond'), true);
    assert.deepEqual([...ROLE_CAPABILITIES['budget-admin']], ['budget']);
    assert.equal(capabilityForRole('responder'), 'respond');
    assert.equal(capabilityForRole('nobody'), null);
    // `authorize` 在本目录中没有对应动作：本地授权管理不是响应动作。
    // 这条断言让"保留但未使用"保持显式，而不是悄悄给某个动作提权。
    for (const id of ACTION_IDS) {
      assert.notEqual(ACTION_CATALOG[id].requiredRole, 'admin', `${id} must not require admin`);
    }
  });

  it('covers every action × OS pair in the support matrix', () => {
    for (const id of ACTION_IDS) {
      for (const os of SUPPORTED_OS) {
        const entry = ACTION_OS_MATRIX[id][os];
        assert.ok(entry !== undefined, `${id}/${os} missing from matrix`);
        assert.ok(['supported', 'unsupported'].includes(entry.status), `${id}/${os} status`);
        if (entry.status === 'unsupported') {
          assert.equal(typeof entry.reason, 'string', `${id}/${os} needs a reason`);
          assert.ok(entry.reason.length > 0, `${id}/${os} reason must not be empty`);
        }
      }
    }
    assert.equal(osSupportFor('linux', 'process.suspend').status, 'supported');
    assert.equal(osSupportFor('windows', 'process.suspend').status, 'unsupported');
    assert.deepEqual(osSupportFor('darwin', 'process.terminate'), {
      status: 'unsupported',
      reason: 'unknown action',
    });
  });

  it('never requires approval for nothing but demands it for irreversible or critical actions', () => {
    for (const id of ACTION_IDS) {
      const action = ACTION_CATALOG[id];
      if (action.reversible === false || action.risk === 'critical') {
        assert.equal(action.requiresApproval, true, `${id} must require approval`);
      }
    }
  });

  it('keeps forbidden identifiers out of the catalog and reports them distinctly', () => {
    const forbidden = Object.keys(FORBIDDEN_ACTIONS);
    assert.ok(forbidden.length >= 3);
    for (const id of forbidden) {
      assert.equal(isForbiddenAction(id), true, `${id} must be recognised as forbidden`);
      assert.equal(isCatalogAction(id), false, `${id} must not be published`);
    }
    assert.equal(isForbiddenAction('process.terminate'), false);
    assert.equal(isForbiddenAction(42), false);
  });

  it('freezes the catalog and the matrix against mutation', () => {
    assert.equal(Object.isFrozen(ACTION_CATALOG), true);
    assert.equal(Object.isFrozen(ACTION_IDS), true);
    assert.equal(Object.isFrozen(ACTION_OS_MATRIX), true);
    for (const id of ACTION_IDS) {
      assert.equal(Object.isFrozen(ACTION_CATALOG[id]), true, `${id} must be frozen`);
      assert.equal(Object.isFrozen(ACTION_CATALOG[id].targetKinds), true, `${id}.targetKinds`);
      assert.equal(Object.isFrozen(ACTION_CATALOG[id].failClosed), true, `${id}.failClosed`);
      assert.equal(Object.isFrozen(ACTION_OS_MATRIX[id]), true, `${id} matrix row`);
    }
    assert.throws(() => {
      ACTION_CATALOG['shell.exec'] = ACTION_CATALOG['process.terminate'];
    }, TypeError);
  });

  it('binds a stable, distinct action digest to every action', () => {
    const digests = new Set();
    for (const id of ACTION_IDS) {
      const digest = actionDigest(id);
      assert.match(digest, /^[0-9a-f]{64}$/u, `${id} digest`);
      assert.equal(digest, actionDigest(id), `${id} digest must be stable`);
      digests.add(digest);
    }
    assert.equal(digests.size, ACTION_IDS.length, 'action digests must be unique');
    assert.equal(actionDigest('does.not.exist'), '');
  });

  it('resolves only published identifiers', () => {
    assert.equal(getAction('process.terminate')?.actionId, 'process.terminate');
    assert.equal(getAction('Process.Terminate'), null);
    assert.equal(getAction('shell.exec'), null);
    assert.equal(getAction(undefined), null);
    assert.equal(isCatalogAction(null), false);
  });

  it('declares only scalar parameter types', () => {
    for (const id of ACTION_IDS) {
      for (const [name, spec] of Object.entries(ACTION_CATALOG[id].parameters)) {
        assert.ok(PARAMETER_SPEC_TYPES.includes(spec.type), `${id}.${name} type ${spec.type}`);
        assert.equal(typeof spec.required, 'boolean', `${id}.${name}.required`);
      }
    }
  });

  it('pins one supported policy version', () => {
    assert.deepEqual([...SUPPORTED_POLICY_VERSIONS], ['1.0']);
    assert.equal(CURRENT_POLICY_VERSION, '1.0');
  });

  it('denies an identifier that is absent from the catalog', () => {
    const decision = evaluateResponsePolicy(baseRequest({ actionId: 'registry.disable_key' }));
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCode, 'DENY_UNKNOWN_ACTION');
  });
});
