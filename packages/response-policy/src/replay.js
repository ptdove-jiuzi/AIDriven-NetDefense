/**
 * replay.js — caller-owned nonce / execution-id bookkeeping.
 *
 * The decision function is pure: it reads a replay *view* and never mutates it.
 * A daemon that wants "nonce can only be consumed once" has to hold that state
 * somewhere, and that somewhere is this registry.
 *
 * Why not fold it into the decision? Because a pure function that silently
 * mutates hidden state is no longer reproducible: replaying the same request
 * would return `deny` the second time with no input difference. Keeping the
 * mutation in an explicit object lets tests assert both halves — the first
 * consumption is visible, and a second *decision* with the consumed view denies.
 *
 * The registry is memory-only on purpose. Durable replay protection belongs to
 * the daemon's event-store transaction (design §10.1 T3a/T3b); this object is the
 * in-process mirror used by tests and by callers that have no store.
 */

/**
 * @typedef {{
 *   consumeApproval: (nonce: unknown) => boolean,
 *   consumeGrant: (nonce: unknown, executionId: unknown) => boolean,
 *   hasApproval: (nonce: unknown) => boolean,
 *   hasGrant: (nonce: unknown) => boolean,
 *   hasExecution: (executionId: unknown) => boolean,
 *   view: () => { approvalNonces: string[], grantNonces: string[], executionIds: string[] },
 *   size: () => number
 * }} ReplayRegistry
 */

/**
 * @param {string} value Candidate key.
 * @returns {boolean} True for a non-empty string key.
 */
function usable(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Create an in-memory replay registry.
 *
 * @returns {ReplayRegistry} Registry handle.
 */
export function createReplayRegistry() {
  /** @type {Set<string>} */
  const approvalNonces = new Set();
  /** @type {Set<string>} */
  const grantNonces = new Set();
  /** @type {Set<string>} */
  const executionIds = new Set();

  return {
    consumeApproval(nonce) {
      if (!usable(nonce) || approvalNonces.has(nonce)) return false;
      approvalNonces.add(nonce);
      return true;
    },
    consumeGrant(nonce, executionId) {
      if (!usable(nonce) || !usable(executionId)) return false;
      if (grantNonces.has(nonce) || executionIds.has(executionId)) return false;
      grantNonces.add(nonce);
      executionIds.add(executionId);
      return true;
    },
    hasApproval(nonce) {
      return usable(nonce) && approvalNonces.has(nonce);
    },
    hasGrant(nonce) {
      return usable(nonce) && grantNonces.has(nonce);
    },
    hasExecution(executionId) {
      return usable(executionId) && executionIds.has(executionId);
    },
    view() {
      return {
        approvalNonces: [...approvalNonces],
        grantNonces: [...grantNonces],
        executionIds: [...executionIds],
      };
    },
    size() {
      return approvalNonces.size + grantNonces.size + executionIds.size;
    },
  };
}
