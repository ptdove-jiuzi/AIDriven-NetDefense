/**
 * Determinism and purity.
 *
 * The policy layer is used as a gate in front of irreversible actions, so an
 * answer that changes between two identical calls is a defect even if both
 * answers are "safe". Two kinds of evidence here:
 *
 *   1. behavioural — same input, same output, independent of key order;
 *   2. static — the sources contain no clock, randomness or environment read, so
 *      the behaviour cannot regress into "it depends".
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { approvedTerminateScenario, baseRequest, windowsNetworkTarget } from './helpers.js';
import { evaluateResponsePolicy } from '../../packages/response-policy/index.js';

const PACKAGE_ROOT = 'packages/response-policy';

/**
 * @returns {string[]} Every JavaScript source file in the package.
 */
function sourceFiles() {
  const files = [join(PACKAGE_ROOT, 'index.js')];
  for (const name of readdirSync(join(PACKAGE_ROOT, 'src'))) {
    if (name.endsWith('.js')) files.push(join(PACKAGE_ROOT, 'src', name));
  }
  return files;
}

describe('determinism', () => {
  it('returns an identical decision for an identical request', () => {
    const scenario = approvedTerminateScenario();
    const first = evaluateResponsePolicy(scenario.request);
    const second = evaluateResponsePolicy(scenario.request);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.targetDigest, scenario.target.digest);
    assert.equal(first.parametersDigest, scenario.parameters.digest);
  });

  it('is stable across many repetitions', () => {
    const request = baseRequest({ actionId: 'network.isolate', target: windowsNetworkTarget() });
    const outcomes = new Set();
    for (let index = 0; index < 100; index += 1) {
      outcomes.add(evaluateResponsePolicy(request).reasonCode);
    }
    assert.equal(outcomes.size, 1, [...outcomes].join(','));
  });

  it('does not depend on the insertion order of request keys', () => {
    const scenario = approvedTerminateScenario();
    const reordered = {
      now: scenario.request.now,
      actionId: scenario.request.actionId,
      target: scenario.request.target,
      actorRoles: scenario.request.actorRoles,
      parameters: scenario.request.parameters,
      epoch: scenario.request.epoch,
      approval: scenario.request.approval,
      proposal: scenario.request.proposal,
      grant: scenario.request.grant,
      policyVersion: scenario.request.policyVersion,
      os: scenario.request.os,
    };
    assert.equal(JSON.stringify(evaluateResponsePolicy(reordered)), JSON.stringify(evaluateResponsePolicy(scenario.request)));
  });

  it('only depends on the supplied now, never on the host clock', () => {
    const scenario = approvedTerminateScenario();
    const early = evaluateResponsePolicy({ ...scenario.request, now: '2026-11-01T00:00:00Z' });
    const late = evaluateResponsePolicy({ ...scenario.request, now: '2026-11-03T00:00:00Z' });
    // Same records, two different `now` values. At the early instant the approval
    // has not been issued yet; at the late one even the proposal has expired. The
    // records never change — only the supplied instant does.
    assert.equal(early.reasonCode, 'DENY_APPROVAL_NOT_YET_VALID');
    assert.equal(late.reasonCode, 'DENY_PROPOSAL_EXPIRED');
    assert.equal(scenario.proposal.value.expires_at, '2026-11-02T00:30:00Z');
  });

  it('freezes the whole result, including nested collections', () => {
    const decision = evaluateResponsePolicy(approvedTerminateScenario().request);
    assert.equal(Object.isFrozen(decision), true);
    assert.equal(Object.isFrozen(decision.helperVerificationRequired), true);
    assert.equal(Object.isFrozen(decision.notes), true);
    assert.throws(() => {
      decision.outcome = 'deny';
    }, TypeError);
    assert.throws(() => {
      decision.helperVerificationRequired.push('skip_everything');
    }, TypeError);
  });

  it('contains no clock, randomness or environment reads in its sources', () => {
    const forbidden = [
      /Date\.now/u,
      /new Date\(\s*\)/u,
      /Math\.random/u,
      /performance\.now/u,
      /process\.env/u,
      /process\.hrtime/u,
      /crypto\.random/u,
    ];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(source), false, `${file} matches ${pattern}`);
      }
    }
    // `new Date(0)` is allowed and only used to turn a parsed timestamp into epoch
    // milliseconds; it reads no clock.
    assert.ok(readFileSync(join(PACKAGE_ROOT, 'src/time.js'), 'utf8').includes('new Date(0)'));
  });

  it('never writes to a global', () => {
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      assert.equal(/globalThis\s*[.[]/u.test(source), false, `${file} touches globalThis`);
      assert.equal(/\bglobal\s*[.[]/u.test(source), false, `${file} touches global`);
    }
  });
});
