/**
 * lifecycle.js — an explicit, auditable process state machine.
 *
 * The daemon has exactly one of these states at a time, and every transition is
 * checked against a table. The point is not ceremony: "am I allowed to stop right
 * now?" must have one answer, shared by the signal handler, the CLI and the tests,
 * instead of each call site improvising with booleans.
 *
 * ```
 * created ──▶ starting ──▶ running ──▶ stopping ──▶ stopped
 *                 │            │            │
 *                 └──▶ failed ◀┘            └──▶ failed
 * ```
 *
 * Rules that matter in practice:
 *
 * - `stopped` is terminal. Nothing restarts this process object; a restart is a
 *   new process with a new lifecycle, which is exactly what the service manager
 *   does and what "restart recovery" must be tested against.
 * - `stop()` is idempotent through `stopping → stopping` and `stopped → stopped`
 *   being no-ops, so two signals, or a signal racing the API shutdown, converge.
 * - `failed` can still be stopped, because a failed start has to release the
 *   resources it already acquired.
 */

import { DaemonError, DAEMON_CODES } from './errors.js';

/** All lifecycle states. */
export const LIFECYCLE_STATES = Object.freeze([
  'created',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
]);

const TRANSITIONS = Object.freeze({
  // `created → stopped` is allowed: a daemon that never started has nothing to
  // release, and forcing it through `starting` would claim work that never happened.
  created: ['starting', 'stopping', 'stopped'],
  starting: ['running', 'failed', 'stopping'],
  running: ['stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  failed: ['stopping', 'stopped'],
  stopped: [],
});

/**
 * Create a lifecycle tracker.
 *
 * @param {{onChange?: (event: {from: string, to: string, at: string|null}) => void,
 *   clock?: {nowIso: () => string}}} [options] Options.
 * @returns {object} Lifecycle handle.
 */
export function createLifecycle(options = {}) {
  const clock = options.clock ?? { nowIso: () => new Date().toISOString() };
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  let state = 'created';
  let startedAt = null;
  let stoppedAt = null;
  const history = [{ from: null, to: 'created', at: null }];

  function transition(next) {
    if (!LIFECYCLE_STATES.includes(next)) {
      throw new DaemonError(DAEMON_CODES.LIFECYCLE_INVALID_TRANSITION, `unknown lifecycle state ${String(next)}`);
    }
    if (next === state) {
      return state;
    }
    const allowed = TRANSITIONS[state] ?? [];
    if (!allowed.includes(next)) {
      throw new DaemonError(
        DAEMON_CODES.LIFECYCLE_INVALID_TRANSITION,
        `cannot move the daemon from ${state} to ${next}`,
        { from: state, to: next },
      );
    }
    const from = state;
    const at = clock.nowIso();
    state = next;
    if (next === 'running') {
      startedAt = at;
    }
    if (next === 'stopped' || next === 'failed') {
      stoppedAt = at;
    }
    history.push({ from, to: next, at });
    onChange?.({ from, to: next, at });
    return state;
  }

  return Object.freeze({
    state: () => state,
    is: (...candidates) => candidates.includes(state),
    transition,
    startedAt: () => startedAt,
    stoppedAt: () => stoppedAt,
    history: () => history.map((entry) => ({ ...entry })),
    /** Terminal and accepting no further work. */
    isTerminal: () => state === 'stopped' || state === 'failed',
  });
}
