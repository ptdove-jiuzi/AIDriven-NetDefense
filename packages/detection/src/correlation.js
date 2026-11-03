/**
 * correlation.js — bounded, ordered step matching across events.
 *
 * One slot exists per group key. Slots expire when the chain exceeds `withinMs`
 * and the total number of slots is capped globally through a shared registry, so
 * a rule cannot allocate unbounded memory.
 */

import { evaluateExpression } from './expression.js';

/**
 * Create the shared slot registry that enforces a global slot budget.
 *
 * @param {number} maxSlots Maximum number of live slots across all rules.
 * @returns {{ maxSlots: number, used: () => number, hasRoom: () => boolean, acquire: () => void, release: () => void }} Registry.
 */
export function createSlotRegistry(maxSlots) {
  let used = 0;
  return {
    maxSlots,
    used() {
      return used;
    },
    hasRoom() {
      return used < maxSlots;
    },
    acquire() {
      used += 1;
    },
    release() {
      if (used > 0) {
        used -= 1;
      }
    },
  };
}

/**
 * Create the correlation state of one correlation rule.
 *
 * @param {{
 *   steps: readonly { name: string, when: object }[],
 *   withinMs: number,
 *   registry: { hasRoom: () => boolean, acquire: () => void, release: () => void }
 * }} options Rule parameters plus the shared slot registry.
 * @returns {{
 *   observe: (groupKey: string, event: object, at: number, counter: { steps: number }) => {
 *     fired: boolean, matchedSteps?: string[], slotLimited: boolean, expired: number
 *   },
 *   sweep: (at: number) => number,
 *   reset: () => void,
 *   slotCount: () => number
 * }} Correlation handle.
 */
export function createCorrelationState(options) {
  const { steps, withinMs, registry } = options;
  const slots = new Map();

  function observe(groupKey, event, at, counter) {
    let expired = 0;
    let slot = slots.get(groupKey);
    if (slot !== undefined && at - slot.startedAt > withinMs) {
      slots.delete(groupKey);
      registry.release();
      expired += 1;
      slot = undefined;
    }
    const expected = slot === undefined ? 0 : slot.index;
    if (evaluateExpression(steps[expected].when, event, counter)) {
      if (expected === 0) {
        if (slot === undefined) {
          if (!registry.hasRoom()) {
            return { fired: false, slotLimited: true, expired };
          }
          registry.acquire();
          slots.set(groupKey, { startedAt: at, index: 1, steps: [steps[0].name] });
        } else {
          slot.startedAt = at;
          slot.index = 1;
          slot.steps = [steps[0].name];
        }
        return { fired: false, slotLimited: false, expired };
      }
      slot.index += 1;
      slot.steps.push(steps[expected].name);
      if (slot.index === steps.length) {
        const matchedSteps = slot.steps.slice();
        slots.delete(groupKey);
        registry.release();
        return { fired: true, matchedSteps, slotLimited: false, expired };
      }
      return { fired: false, slotLimited: false, expired };
    }
    if (expected !== 0 && evaluateExpression(steps[0].when, event, counter)) {
      slot.startedAt = at;
      slot.index = 1;
      slot.steps = [steps[0].name];
    }
    return { fired: false, slotLimited: false, expired };
  }

  function sweep(at) {
    let expired = 0;
    for (const [groupKey, slot] of slots) {
      if (at - slot.startedAt > withinMs) {
        slots.delete(groupKey);
        registry.release();
        expired += 1;
      }
    }
    return expired;
  }

  function reset() {
    const count = slots.size;
    slots.clear();
    for (let index = 0; index < count; index += 1) {
      registry.release();
    }
  }

  return {
    observe,
    sweep,
    reset,
    slotCount() {
      return slots.size;
    },
  };
}
