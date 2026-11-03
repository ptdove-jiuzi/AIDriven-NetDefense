/**
 * `executeStub` — the only method with a name that suggests doing something.
 *
 * This file exists because "we did not implement execution" is a claim that has to
 * be enforced, not documented. The assertions are deliberately paranoid:
 *
 *   - the argument is not read at all (a Proxy whose every trap throws still gets
 *     the same answer), so there is no caller-controlled code path;
 *   - no environment variable changes the answer, so an operator cannot flip the
 *     build into execution mode with a stray `export`;
 *   - a dispatch that passes every check still reports `executable: false`, so
 *     "ready" can never be mistaken for "allowed to run".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXECUTION_ENABLED,
  createMemoryInbox,
  createResponseHelper,
} from '../../apps/response-helper/index.js';
import {
  EXECUTION_ID,
  createHelper,
  envelopeFor,
  processTarget,
} from './helpers.js';

const DRY_RUN_ONLY_KEYS = Object.freeze([
  'authorizes_execution',
  'code',
  'decision',
  'detail',
  'dry_run',
  'duplicate',
  'executable',
  'performed',
  'plan',
  'status',
]);

describe('execute stub: always refuses to execute', () => {
  it('answers dry_run_only for a perfectly valid, fully approved dispatch', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const response = helper.executeStub(envelopeFor({ target }));
    assert.equal(response.status, 'dry_run_only');
    assert.equal(response.code, 'HELPER_EXECUTION_DISABLED');
    assert.equal(response.performed, false);
    assert.equal(response.executable, false);
    assert.equal(response.authorizes_execution, false);
    assert.equal(response.plan, null);
    assert.equal(Object.isFrozen(response), true);
    assert.deepEqual(Object.keys(response).sort(), [...DRY_RUN_ONLY_KEYS].sort());
  });

  it('answers identically for garbage, so the input cannot influence the outcome', () => {
    const helper = createHelper({ target: processTarget() });
    const baseline = JSON.stringify(helper.executeStub(undefined));
    const inputs = [
      null,
      'terminate everything',
      42,
      true,
      [],
      {},
      () => 'boom',
      { schemaVersion: '1.0', execution_id: EXECUTION_ID, force: true },
    ];
    for (const input of inputs) {
      assert.equal(JSON.stringify(helper.executeStub(input)), baseline, `input ${String(input)}`);
    }
  });

  it('never reads the argument: a proxy whose every trap throws is still fine', () => {
    const helper = createHelper({ target: processTarget() });
    const hostile = new Proxy({}, {
      get() {
        throw new Error('argument was read');
      },
      has() {
        throw new Error('argument was probed');
      },
      ownKeys() {
        throw new Error('argument was enumerated');
      },
      getOwnPropertyDescriptor() {
        throw new Error('argument was inspected');
      },
      getPrototypeOf() {
        throw new Error('argument prototype was read');
      },
    });
    assert.doesNotThrow(() => helper.executeStub(hostile));
    assert.equal(helper.executeStub(hostile).status, 'dry_run_only');
  });

  it('leaves the dedupe inbox untouched, proving it takes no path through the pipeline', () => {
    const target = processTarget();
    const inbox = createMemoryInbox();
    const helper = createHelper({ target, inbox });
    helper.executeStub(envelopeFor({ target }));
    helper.executeStub(envelopeFor({ target }));
    assert.equal(inbox.size(), 0);
    assert.equal(inbox.lookup(EXECUTION_ID), null);
  });

  it('cannot be switched on by an environment variable', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const names = [
      'AEGIS_HELPER_ALLOW_EXECUTE',
      'AEGIS_HELPER_EXECUTION',
      'AEGIS_EXECUTION_ENABLED',
      'ALLOW_REAL_EXECUTION',
      'NODE_ENV',
    ];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = '1';
      const response = helper.executeStub(envelopeFor({ target }));
      assert.equal(response.status, 'dry_run_only');
      assert.equal(response.performed, false);
      assert.equal(helper.describe().build.execution_enabled, false);
      assert.equal(EXECUTION_ENABLED, false);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('keeps a fully green plan non-executable', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'planned');
    assert.equal(response.plan.ready_for_execution, true);
    assert.equal(response.plan.executable, false);
    assert.equal(response.plan.execution_disabled, true);
    assert.equal(response.plan.authorizes_execution, false);
    assert.equal(response.executable, false);
  });

  it('exposes no execution method beyond the stub', () => {
    const helper = createResponseHelper();
    const names = Object.keys(helper);
    assert.deepEqual(names.sort(), ['describe', 'dryRun', 'executeStub', 'prepare']);
    for (const name of names) {
      assert.equal(typeof helper[name], 'function');
      assert.notEqual(name, 'execute');
      assert.notEqual(name, 'run');
      assert.notEqual(name, 'apply');
    }
  });
});
