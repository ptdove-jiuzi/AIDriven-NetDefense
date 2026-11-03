/**
 * Robustness: hostile inputs at the boundary, hostile values thrown *by* a port,
 * and the clock rules that make a time window mean something.
 *
 * These are the cases a security review looks for after the happy path is green:
 *
 *   - the envelope must be judged on a snapshot, so an array cannot lie about its
 *     length, an iterator cannot run inside validation, and `__proto__` cannot turn
 *     a copy into a prototype assignment;
 *   - a port may throw anything at all, and the helper must still answer with a
 *     refusal — never propagate the throw, and never strand its dedupe claim;
 *   - a dispatch timestamp far from this helper's clock is not a valid timestamp,
 *     whatever the grant says.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_CLOCK_SKEW_MS,
  createMemoryManifestStore,
  createResponseHelper,
  createStaticCapabilityProbe,
  createStaticGrantVerifier,
  createStaticOsProbe,
  createStaticTargetProbe,
  validateEnvelope,
} from '../../apps/response-helper/index.js';
import {
  ALL_GRANTED,
  NOW,
  createHelper,
  envelopeFor,
  observationFor,
  processTarget,
} from './helpers.js';

/**
 * A thrown value whose every observable surface throws.
 *
 * `instanceof`, `error.name`, `error.detail` and `String(error)` all run attacker
 * code, which is exactly what `refusalFrom` must survive.
 */
function hostileThrown() {
  return new Proxy({}, {
    get() {
      throw new Error('thrown.value');
    },
    getPrototypeOf() {
      throw new Error('thrown.prototype');
    },
    getOwnPropertyDescriptor() {
      throw new Error('thrown.descriptor');
    },
    has() {
      throw new Error('thrown.has');
    },
  });
}

describe('hostile envelope values', () => {
  it('does not read an array length twice, so a lying length cannot exceed the cap', () => {
    const target = processTarget();
    // Five distinct roles plus a sixth that must never be seen by the gate.
    const inner = ['responder', 'viewer', 'analyst', 'admin', 'budget-admin', 'responder'];
    let lengthReads = 0;
    const lying = new Proxy(inner, {
      get(object, key) {
        if (key === 'length') {
          lengthReads += 1;
          return 5;
        }
        return object[key];
      },
    });
    const response = createHelper({ target }).prepare({ ...envelopeFor({ target }), actorRoles: lying });
    assert.equal(lengthReads, 1);
    assert.equal(response.status, 'planned');
  });

  it('never runs a caller iterator: an endless iterator cannot hang validation', () => {
    const target = processTarget();
    const endless = new Proxy(['responder'], {
      get(object, key) {
        if (key === Symbol.iterator) {
          return function* generate() {
            while (true) yield 'viewer';
          };
        }
        return object[key];
      },
    });
    let response;
    assert.doesNotThrow(() => {
      response = createHelper({ target }).prepare({ ...envelopeFor({ target }), actorRoles: endless });
    });
    // Slicing via descriptors yields exactly the one real element, so this dispatch
    // survives; what matters is that the iterator was never invoked.
    assert.equal(response.status, 'planned');
  });

  it('refuses an array whose elements are accessors instead of data', () => {
    const target = processTarget();
    const weird = ['responder'];
    Object.defineProperty(weird, '0', {
      enumerable: true,
      get() {
        throw new Error('element getter');
      },
    });
    const response = createHelper({ target }).prepare({ ...envelopeFor({ target }), actorRoles: weird });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_ENVELOPE_INVALID');
  });

  it('refuses a __proto__ key instead of silently rewriting the copy prototype', () => {
    const target = processTarget();
    const envelope = envelopeFor({ target });
    const parameters = JSON.parse('{"__proto__": {"polluted": true}}');
    const response = createHelper({ target }).prepare({ ...envelope, parameters });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_ENVELOPE_INVALID');
    assert.equal({}.polluted, undefined);
  });

  it('keeps the copied roles frozen and independent of the caller array', () => {
    const target = processTarget();
    const roles = ['responder'];
    const validated = validateEnvelope({ ...envelopeFor({ target }), actorRoles: roles });
    roles.push('viewer');
    assert.deepEqual([...validated.actorRoles], ['responder']);
    assert.equal(Object.isFrozen(validated.actorRoles), true);
  });
});

describe('hostile values thrown by a port', () => {
  const cases = [
    {
      label: 'capability probe',
      build: (target) => createHelper({
        target,
        capabilityProbe: {
          source: 'hostile',
          capabilities() {
            throw hostileThrown();
          },
        },
      }),
      code: 'HELPER_PROBE_INVALID',
    },
    {
      label: 'target probe',
      build: (target) => createHelper({
        target,
        targetProbe: {
          source: 'hostile',
          observe() {
            throw hostileThrown();
          },
        },
      }),
      code: 'HELPER_TARGET_UNVERIFIABLE',
    },
    {
      label: 'grant verifier',
      build: (target) => createHelper({
        target,
        grantVerifier: {
          source: 'hostile',
          verify() {
            throw hostileThrown();
          },
        },
      }),
      code: 'HELPER_GRANT_UNVERIFIED',
    },
    {
      label: 'manifest store',
      build: (target) => createHelper({
        target,
        manifestStore: {
          record() {
            throw hostileThrown();
          },
        },
      }),
      code: 'HELPER_PROBE_INVALID',
    },
    {
      label: 'clock',
      build: (target) => createHelper({
        target,
        clock: {
          source: 'hostile',
          nowMs() {
            throw hostileThrown();
          },
        },
      }),
      code: 'HELPER_CLOCK_SKEW',
      // The freshness check runs before the inbox claim, so a dispatch that cannot
      // be dated never consumes dedupe state — and therefore is not a duplicate on
      // redelivery either.
      claims: false,
    },
  ];

  for (const entry of cases) {
    it(`answers a refusal when the ${entry.label} throws a hostile value`, () => {
      const target = processTarget();
      const helper = entry.build(target);
      const envelope = envelopeFor({ target });
      let response;
      assert.doesNotThrow(() => {
        response = helper.prepare(envelope);
      });
      assert.equal(response.status, entry.code === 'HELPER_GRANT_UNVERIFIED' ? 'blocked' : 'refused');
      assert.equal(response.code, entry.code);
      // The claim must be settled, so a redelivery reproduces the refusal instead
      // of hitting `claim_without_result`.
      const again = helper.prepare(envelope);
      assert.equal(again.code, entry.code);
      assert.equal(again.duplicate, entry.claims !== false);
    });
  }

  it('does not leak a hostile detail into the refusal', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      manifestStore: {
        record() {
          throw { name: 'Boom', detail: { get boom() { throw new Error('detail getter'); } } };
        },
      },
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.status, 'refused');
    assert.doesNotThrow(() => JSON.stringify(response));
  });
});

describe('clock freshness rules', () => {
  const withSkew = (milliseconds) => new Date(Date.parse(NOW) + milliseconds).toISOString();

  it('accepts exactly the declared bound and refuses one millisecond beyond it', () => {
    const target = processTarget();
    const atBound = createHelper({ target, now: withSkew(MAX_CLOCK_SKEW_MS) });
    assert.equal(atBound.prepare(envelopeFor({ target })).status, 'planned');

    const beyond = createHelper({ target, now: withSkew(MAX_CLOCK_SKEW_MS + 1) });
    const response = beyond.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_CLOCK_SKEW');
  });

  it('uses the real system clock when no clock is injected', () => {
    const target = processTarget();
    const helper = createResponseHelper({
      osProbe: createStaticOsProbe('windows'),
      capabilityProbe: createStaticCapabilityProbe(ALL_GRANTED),
      targetProbe: createStaticTargetProbe(observationFor(target)),
      grantVerifier: createStaticGrantVerifier({ ok: true }),
      manifestStore: createMemoryManifestStore(),
    });
    // A dispatch stamped "now" passes the freshness check; one stamped at the
    // fixture epoch does not, which is the whole point of having a real clock.
    const fresh = helper.prepare(envelopeFor({ target, now: new Date().toISOString() }));
    assert.notEqual(fresh.code, 'HELPER_CLOCK_SKEW');
    const stale = helper.prepare(envelopeFor({
      target,
      now: NOW,
      executionId: '99999999-9999-4999-8999-999999999999',
      attemptId: '99999999-9999-4999-8999-999999999998',
    }));
    assert.equal(stale.code, 'HELPER_CLOCK_SKEW');
    assert.equal(stale.detail.clock_source, 'system');
  });

  it('lets a redelivery through even after the timestamp has aged', () => {
    const target = processTarget();
    let current = Date.parse(NOW);
    const clock = { source: 'mutable', nowMs: () => current };
    const helper = createHelper({ target, clock });
    const envelope = envelopeFor({ target });
    assert.equal(helper.prepare(envelope).status, 'planned');
    // Ten minutes later, the same dispatch must still be the same answer — §10.1
    // idempotent redelivery outranks the freshness rule, or a retry storm would
    // turn into a wall of clock-skew refusals.
    current += 600_000;
    const redelivered = helper.prepare(envelope);
    assert.equal(redelivered.duplicate, true);
    assert.equal(redelivered.code, null);
  });
});
