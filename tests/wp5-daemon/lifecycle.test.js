/**
 * lifecycle.test.js — the process state machine.
 *
 * The cases that matter operationally: a second Ctrl-C during shutdown, a stop
 * that arrives while the daemon is still starting, and a failed start that must
 * still be able to release what it acquired.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { LIFECYCLE_STATES, createLifecycle } from '../../apps/daemon/src/lifecycle.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { BASE_MS } from './helpers.js';

describe('createLifecycle', () => {
  it('starts in created with an empty wall-clock history', () => {
    const lifecycle = createLifecycle();
    assert.equal(lifecycle.state(), 'created');
    assert.equal(lifecycle.is('created'), true);
    assert.equal(lifecycle.startedAt(), null);
    assert.deepEqual(lifecycle.history(), [{ from: null, to: 'created', at: null }]);
  });

  it('walks the happy path and records monotonically increasing timestamps', () => {
    const clock = createManualClock(BASE_MS);
    const lifecycle = createLifecycle({ clock });
    lifecycle.transition('starting');
    clock.advance(5);
    lifecycle.transition('running');
    clock.advance(5);
    lifecycle.transition('stopping');
    clock.advance(5);
    lifecycle.transition('stopped');
    assert.equal(lifecycle.state(), 'stopped');
    assert.equal(lifecycle.startedAt(), '2026-11-02T00:00:00.005Z');
    assert.equal(lifecycle.stoppedAt(), '2026-11-02T00:00:00.015Z');
    assert.deepEqual(lifecycle.history().map((entry) => entry.to), ['created', 'starting', 'running', 'stopping', 'stopped']);
  });

  it('treats a repeated transition as a no-op so double stop is safe', () => {
    const lifecycle = createLifecycle();
    lifecycle.transition('starting');
    lifecycle.transition('running');
    lifecycle.transition('stopping');
    lifecycle.transition('stopping');
    lifecycle.transition('stopped');
    lifecycle.transition('stopped');
    assert.equal(lifecycle.state(), 'stopped');
    assert.equal(lifecycle.history().length, 5);
  });

  it('refuses an impossible transition and names both states', () => {
    const lifecycle = createLifecycle();
    assert.throws(() => lifecycle.transition('running'), (error) => {
      assert.equal(error.code, DAEMON_CODES.LIFECYCLE_INVALID_TRANSITION);
      assert.deepEqual(error.details, { from: 'created', to: 'running' });
      return true;
    });
    assert.equal(lifecycle.state(), 'created');
  });

  it('refuses an unknown state name', () => {
    const lifecycle = createLifecycle();
    assert.throws(() => lifecycle.transition('zombie'), (error) => {
      assert.equal(error.code, DAEMON_CODES.LIFECYCLE_INVALID_TRANSITION);
      return true;
    });
  });

  it('cannot leave stopped', () => {
    const lifecycle = createLifecycle();
    lifecycle.transition('stopping');
    lifecycle.transition('stopped');
    assert.equal(lifecycle.isTerminal(), true);
    for (const next of LIFECYCLE_STATES) {
      if (next === 'stopped') {
        continue;
      }
      assert.throws(() => lifecycle.transition(next), (error) => {
        assert.equal(error.code, DAEMON_CODES.LIFECYCLE_INVALID_TRANSITION);
        return true;
      }, `stopped → ${next} must be refused`);
    }
  });

  it('lets a failed start be stopped so resources are released', () => {
    const lifecycle = createLifecycle();
    lifecycle.transition('starting');
    lifecycle.transition('failed');
    assert.equal(lifecycle.isTerminal(), true);
    lifecycle.transition('stopping');
    lifecycle.transition('stopped');
    assert.equal(lifecycle.state(), 'stopped');
  });

  it('allows a stop signal to arrive while starting', () => {
    const lifecycle = createLifecycle();
    lifecycle.transition('starting');
    lifecycle.transition('stopping');
    assert.equal(lifecycle.state(), 'stopping');
    lifecycle.transition('stopped');
    // A late start resume after the stop completed must be refused, not revive it.
    assert.throws(() => lifecycle.transition('running'), (error) => {
      assert.equal(error.code, DAEMON_CODES.LIFECYCLE_INVALID_TRANSITION);
      return true;
    });
    assert.equal(lifecycle.state(), 'stopped');
  });

  it('notifies an observer of every accepted change only', () => {
    const seen = [];
    const lifecycle = createLifecycle({ onChange: (event) => seen.push(event.to) });
    lifecycle.transition('starting');
    lifecycle.transition('starting');
    lifecycle.transition('running');
    assert.deepEqual(seen, ['starting', 'running']);
  });
});
