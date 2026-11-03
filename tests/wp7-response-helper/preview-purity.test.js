/**
 * Preview purity (P1-3): a preview is a plan, not a dispatch.
 *
 * The round-3 review measured the opposite. `dryRun` delegated to `prepare`, so a
 * preview:
 *
 *   - wrote a `phase: 'prepared'` recovery manifest into whatever durable store was
 *     injected (manifest 0 → 1), i.e. a recovery intent for an action nobody
 *     approved;
 *   - claimed the `execution_id` in the dedupe inbox, so the *real* dispatch that
 *     followed the preview came back `duplicate: true` and returned the preview's
 *     answer instead of a fresh verdict;
 *   - spent the grant nonce as a side effect of looking.
 *
 * Every assertion below is written so that re-introducing that delegation fails it:
 * the counts are asserted to be exactly zero, and the follow-up dispatch is asserted
 * to be a *first* dispatch rather than a replay.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryInbox, createMemoryManifestStore } from '../../apps/response-helper/index.js';
import {
  GRANT_NONCE,
  alertEnvelope,
  createDurableManifestStore,
  createHelper,
  envelopeFor,
  fileTarget,
  processTarget,
} from './helpers.js';

/** A store and an inbox whose state can be observed without any real I/O. */
function probePorts(options = {}) {
  const inbox = createMemoryInbox();
  const manifestStore = options.manifestDurable === false
    ? createMemoryManifestStore()
    : createDurableManifestStore();
  const recorded = [];
  const counting = {
    record(intent) {
      recorded.push(intent);
      return manifestStore.record(intent);
    },
    list: () => manifestStore.list(),
    size: () => manifestStore.size(),
  };
  const helper = createHelper({ ...options, inbox, manifestStore: counting });
  return { helper, inbox, manifestStore, recorded };
}

describe('preview purity: nothing is written', () => {
  it('records no recovery manifest while previewing a mutating action', () => {
    const target = processTarget();
    const seen = [];
    const manifestStore = {
      record(intent) {
        seen.push(intent);
        return { recovery_id: 'recovery-000001', phase: 'prepared', durable: true };
      },
      size: () => seen.length,
    };
    const helper = createHelper({ target, manifestStore });
    const response = helper.dryRun(envelopeFor({ target }));

    assert.equal(response.status, 'planned');
    assert.equal(seen.length, 0, 'dryRun must not call the manifest store');
    assert.equal(manifestStore.size(), 0);
    assert.equal(response.plan.manifest, null);
    // The step is still *described*: a preview that hid the manifest step would be
    // lying about what a dispatch would do.
    assert.ok(response.plan.steps.some((step) => step.kind === 'record_manifest'));
    assert.ok(response.plan.notes.includes('dry-run preview: no recovery manifest recorded'));
  });

  it('leaves the dedupe inbox completely untouched', () => {
    const target = processTarget();
    const { helper, inbox } = probePorts({ target });
    helper.dryRun(envelopeFor({ target }));

    assert.equal(inbox.size(), 0);
    assert.equal(inbox.lookup(envelopeFor({ target }).execution_id), null);
    assert.equal(inbox.hasNonce(GRANT_NONCE), false, 'a preview must not spend the grant nonce');
  });

  it('does not spend the grant nonce, so the real dispatch still binds it', () => {
    const target = processTarget();
    const { helper } = probePorts({ target });
    const previewed = envelopeFor({ target });
    helper.dryRun(previewed);
    assert.equal(helper.prepare(previewed).status, 'planned');
  });

  it('does not reserve the execution id: the dispatch after a preview is a first dispatch', () => {
    const target = processTarget();
    const { helper, manifestStore } = probePorts({ target });
    const envelope = envelopeFor({ target });

    const preview = helper.dryRun(envelope);
    assert.equal(preview.duplicate, false);

    const dispatched = helper.prepare(envelope);
    assert.equal(dispatched.duplicate, false, 'a preview must not make the dispatch look like a retry');
    assert.equal(dispatched.status, 'planned');
    assert.ok(dispatched.plan.manifest, 'the real dispatch is the one that records the intent');
    assert.equal(manifestStore.size(), 1);
    // Same envelope in, same plan identity out: the preview was not a different
    // dispatch, it just did not claim anything.
    assert.equal(dispatched.plan.plan_id, preview.plan.plan_id);
  });

  it('answers a preview identically even when the execution id is already claimed', () => {
    const target = processTarget();
    const { helper, inbox } = probePorts({ target });
    const envelope = envelopeFor({ target });
    assert.equal(helper.prepare(envelope).status, 'planned');
    assert.equal(inbox.size(), 1);

    const preview = helper.dryRun(envelope);
    assert.equal(preview.status, 'planned');
    assert.equal(preview.duplicate, false, 'a preview neither reads nor creates dedupe state');
    assert.equal(inbox.size(), 1, 'the preview must not add or remove an inbox entry');
  });

  it('repeats a preview without accumulating any state', () => {
    const target = processTarget();
    const { helper, inbox, manifestStore } = probePorts({ target });
    const envelope = envelopeFor({ target });
    const first = helper.dryRun(envelope);
    const second = helper.dryRun(envelope);

    assert.equal(first.plan.plan_id, second.plan.plan_id);
    assert.equal(inbox.size(), 0);
    assert.equal(manifestStore.size(), 0);
  });

  it('records nothing for an alert-only preview either', () => {
    const target = processTarget();
    const { helper, inbox } = probePorts({ target });
    const response = helper.dryRun(alertEnvelope(target));
    assert.equal(response.status, 'planned');
    assert.equal(response.plan.manifest, null);
    assert.equal(inbox.size(), 0);
  });

  it('still previews a blocked dispatch without writing its intent', () => {
    const target = processTarget();
    const seen = [];
    const helper = createHelper({
      target,
      capabilities: { process_control: 'denied' },
      manifestStore: {
        record(intent) {
          seen.push(intent);
          return { recovery_id: 'recovery-000001', phase: 'prepared', durable: true };
        },
      },
    });
    const response = helper.dryRun(envelopeFor({ target }));
    assert.equal(response.status, 'blocked');
    assert.equal(seen.length, 0);
    assert.equal(response.dry_run_plan.effects.would_mutate_target, true);
  });
});

describe('preview purity: the document says what it did not do', () => {
  it('declares all four non-effects explicitly', () => {
    const target = processTarget();
    const { helper } = probePorts({ target });
    const document = helper.dryRun(envelopeFor({ target })).dry_run_plan;

    assert.equal(document.side_effects_performed, false);
    assert.equal(document.reserves_execution_id, false);
    assert.equal(document.writes_recovery_manifest, false);
    assert.equal(document.consumes_grant_nonce, false);
    assert.equal(document.writes_outbox, false);
  });

  it('keeps the preview non-executable however clean the plan is', () => {
    const target = processTarget();
    const { helper } = probePorts({ target });
    const response = helper.dryRun(envelopeFor({ target }));
    assert.equal(response.executable, false);
    assert.equal(response.authorizes_execution, false);
    assert.equal(response.plan.executable, false);
    assert.equal(response.plan.authorizes_execution, false);
    assert.equal(response.summary.authorizes_execution, false);
  });

  it('previews a file quarantine without recording a relocation intent', () => {
    const target = fileTarget();
    const seen = [];
    const helper = createHelper({
      target,
      manifestStore: {
        record(intent) {
          seen.push(intent);
          return { recovery_id: 'recovery-000001', phase: 'prepared', durable: true };
        },
      },
    });
    const response = helper.dryRun(envelopeFor({ actionId: 'file.quarantine', target }));
    assert.equal(response.status, 'planned');
    assert.equal(seen.length, 0);
    assert.equal(JSON.stringify(response).includes('invoice.pdf'), false);
  });
});
