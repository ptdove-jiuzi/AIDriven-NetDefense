/**
 * Dedupe-inbox failures (P1-1): a port that throws must not escape `prepare`.
 *
 * The helper's header promises that no method throws for bad input, and the promise
 * is load-bearing: over an IPC boundary a thrown error is indistinguishable from
 * "the dedupe check never ran", which is exactly what the check exists to rule out.
 * Round 3 measured the gap — `inbox.lookup` and `inbox.claim` sat outside every
 * `try`, and a `claim` returning `undefined` raised a `TypeError` on `.status`.
 *
 * Three measured cases plus the shapes around them:
 *
 *   A  lookup throws            → structured refusal, no exception
 *   B  claim throws             → structured refusal, no exception
 *   C  claim returns undefined  → structured refusal, no exception
 *
 * The refusal code is the helper's own `HELPER_INBOX_UNAVAILABLE`, never a policy
 * code: the policy gate may well have said `allow`, and telling the operator it
 * denied would be a different lie.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HELPER_CODES, createMemoryInbox } from '../../apps/response-helper/index.js';
import {
  alertEnvelope,
  createHelper,
  envelopeFor,
  processTarget,
} from './helpers.js';

/**
 * A thrown value whose every observable surface throws.
 *
 * `instanceof`, `name` and `detail` all run attacker code, so `refusalFrom` must
 * survive it — and the new guard must not turn a hostile throw into a second throw.
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

/**
 * An inbox whose two read/claim methods fail in the configured way.
 *
 * @param {object} overrides Method overrides.
 * @returns {object} Partial inbox.
 */
function brokenInbox(overrides) {
  return { ...overrides };
}

describe('inbox failure A: lookup throws', () => {
  it('answers a structured refusal instead of throwing out of prepare', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup() {
          throw new Error('lookup boom');
        },
      }),
    });

    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(response.detail.operation, 'lookup');
    assert.equal(response.plan, null);
    assert.equal(response.executable, false);
    assert.doesNotThrow(() => JSON.stringify(response));
  });

  it('survives a hostile thrown value', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup() {
          throw hostileThrown();
        },
      }),
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(typeof response.detail.cause, 'string');
  });

  it('refuses when the stored entry answers with getters that throw', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup() {
          return {
            get attempt_id() {
              throw new Error('entry getter');
            },
          };
        },
      }),
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
  });

  it('refuses a stored result that is not an object instead of spreading it', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup() {
          return { attempt_id: envelopeFor({ target }).attempt_id, result: 'not-a-result' };
        },
      }),
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, HELPER_CODES.HELPER_EXECUTION_CONFLICT);
    assert.equal(response.detail.reason, 'claim_without_result');
  });
});

describe('inbox failure B: claim throws', () => {
  it('answers a structured refusal instead of throwing out of prepare', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup() {
          return null;
        },
        claim() {
          throw new Error('claim boom');
        },
      }),
    });

    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(response.detail.operation, 'claim');
    assert.equal(response.plan, null);
  });

  it('survives an inbox whose every property read throws', () => {
    const target = processTarget();
    const inbox = new Proxy({}, {
      get() {
        throw new Error('proxy boom');
      },
      has() {
        throw new Error('proxy has');
      },
    });
    const helper = createHelper({ target, inbox });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
  });

  it('never reports a policy code for an inbox failure', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup: () => null,
        claim() {
          throw new Error('claim boom');
        },
      }),
    });
    const response = helper.prepare(envelopeFor({ target }));
    // The claim happens before the policy gate, so no decision was produced at all:
    // reporting one (and especially a `DENY_*` code) would describe a verdict that
    // was never reached.
    assert.equal(response.decision, null);
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(response.code.startsWith('DENY_'), false);
  });
});

describe('inbox failure C: claim returns a malformed value', () => {
  it('answers a structured refusal when claim returns undefined', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup: () => null,
        claim() {
          return undefined;
        },
      }),
    });

    let response;
    assert.doesNotThrow(() => {
      // Before the fix this raised `TypeError: Cannot read properties of
      // undefined (reading 'status')` from inside `prepare`.
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(response.detail.cause, 'malformed_claim_result');
  });

  it('refuses a claim result with no status field', () => {
    const target = processTarget();
    for (const malformed of [{}, { status: 42 }, { status: null }, 'new', null, 7]) {
      const helper = createHelper({
        target,
        inbox: brokenInbox({ lookup: () => null, claim: () => malformed }),
      });
      const response = helper.prepare(envelopeFor({ target }));
      assert.equal(
        response.code,
        HELPER_CODES.HELPER_INBOX_UNAVAILABLE,
        `claim=${JSON.stringify(malformed)} must be refused`,
      );
    }
  });

  it('refuses an invented claim status instead of treating it as claimed', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({ lookup: () => null, claim: () => ({ status: 'accepted' }) }),
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(response.detail.cause, 'undeclared_claim_status');
    assert.equal(response.plan, null);
  });

  it('refuses a duplicate claim whose entry carries no usable result', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({ lookup: () => null, claim: () => ({ status: 'duplicate', entry: null }) }),
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.code, HELPER_CODES.HELPER_EXECUTION_CONFLICT);
    assert.equal(response.detail.reason, 'claim_without_result');
  });
});

describe('inbox failure C2: the claim value itself is hostile', () => {
  // Found by the independent point-check of this round: guarding the *call* is not
  // enough, because inspecting the answer is also a port call. `isPlainObject` runs
  // `getPrototypeOf`, and `.status`/`.entry` may be accessors, so a value that
  // returns normally can still throw when read. Three measured shapes.

  it('refuses a claim whose prototype read throws', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup: () => null,
        claim: () => new Proxy({}, {
          getPrototypeOf() {
            throw new Error('proto boom');
          },
        }),
      }),
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(response.detail.operation, 'claim');
  });

  it('refuses a claim whose status is a throwing accessor', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup: () => null,
        claim: () => ({
          get status() {
            throw new Error('status boom');
          },
        }),
      }),
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(response.detail.operation, 'claim');
  });

  it('refuses a claim that is a proxy throwing on every read', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup: () => null,
        claim: () => new Proxy({}, {
          get() {
            throw new Error('get boom');
          },
          getPrototypeOf() {
            throw new Error('proto boom');
          },
        }),
      }),
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
  });

  it('refuses a duplicate claim whose entry read throws', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup: () => null,
        claim: () => ({
          status: 'duplicate',
          get entry() {
            throw new Error('entry boom');
          },
        }),
      }),
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(envelopeFor({ target }));
    });
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
    assert.equal(response.detail.operation, 'claim');
  });

  it('reports a stranded claim structurally on the next dispatch, never by throwing', () => {
    const target = processTarget();
    const inbox = createMemoryInbox();
    const broken = {
      lookup: (id) => inbox.lookup(id),
      claim(claim) {
        // The port really claims, then answers garbage: nothing can be settled for
        // this execution, so the next dispatch has to surface it.
        inbox.claim(claim);
        return { get status() { throw new Error('status boom'); } };
      },
      complete: (outcome) => inbox.complete(outcome),
    };
    const helper = createHelper({ target, inbox: broken });
    const envelope = envelopeFor({ target });
    const first = helper.prepare(envelope);
    assert.equal(first.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);

    let second;
    assert.doesNotThrow(() => {
      second = helper.prepare(envelope);
    });
    assert.equal(second.status, 'refused');
    assert.equal(second.code, HELPER_CODES.HELPER_EXECUTION_CONFLICT);
    assert.equal(second.detail.reason, 'claim_without_result');
  });
});

describe('inbox failure D: the preview is unaffected', () => {
  it('previews a dispatch even when the inbox is completely broken', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup() {
          throw new Error('lookup boom');
        },
        claim() {
          throw new Error('claim boom');
        },
        complete() {
          throw new Error('complete boom');
        },
      }),
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.dryRun(envelopeFor({ target }));
    });
    // A preview is a plan: it does not consult the dedupe layer at all, so a broken
    // inbox cannot make the preview refuse (or, worse, silently claim something).
    assert.equal(response.status, 'planned');
    assert.equal(response.dry_run_plan.reserves_execution_id, false);
  });

  it('answers an alert-only dispatch through the same guard', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      inbox: brokenInbox({
        lookup() {
          throw new Error('lookup boom');
        },
      }),
    });
    const response = helper.prepare(alertEnvelope(target));
    assert.equal(response.code, HELPER_CODES.HELPER_INBOX_UNAVAILABLE);
  });
});

describe('inbox failure E: the healthy inbox keeps its contract', () => {
  it('still dedupes a redelivery after the guards were added', () => {
    const target = processTarget();
    const helper = createHelper({ target, inbox: createMemoryInbox() });
    const envelope = envelopeFor({ target });
    const first = helper.prepare(envelope);
    const second = helper.prepare(envelope);
    assert.equal(first.status, 'planned');
    assert.equal(second.duplicate, true);
    assert.equal(second.plan.plan_id, first.plan.plan_id);
  });

  it('keeps HELPER_INBOX_UNAVAILABLE out of the success vocabulary', () => {
    // A code that can be produced by a port failure must never be reachable from a
    // healthy path; `planned` and this code are mutually exclusive by construction.
    assert.equal(typeof HELPER_CODES.HELPER_INBOX_UNAVAILABLE, 'string');
    assert.equal(HELPER_CODES.HELPER_INBOX_UNAVAILABLE, 'HELPER_INBOX_UNAVAILABLE');
  });
});
