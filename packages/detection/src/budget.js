/**
 * budget.js — per-rule, per-batch CPU and step metering.
 *
 * Metering is deliberately coarse: one counter pair per rule per ingestion
 * batch. Exceeding either bound is converted by the engine into a rule
 * isolation record instead of an exception to the caller.
 *
 * The meter never reads a clock itself: the engine hands it the value of that
 * rule's own budget clock (`begin`) before the batch and after every evaluation
 * (`exceeded`). Determinism therefore lives entirely in the clock — see
 * `clock.js` — and one meter per rule means one clock per rule, so a slow
 * neighbouring rule cannot spend this rule's budget.
 */

/**
 * Create the budget meter of a single rule.
 *
 * @param {{ cpuBudgetMs: number, maxSteps: number }} options Budget bounds.
 * @returns {{
 *   begin: (cpuNow: number) => void,
 *   addSteps: (steps: number) => void,
 *   exceeded: (cpuNow: number) => null | { kind: 'timeout', reason: string, cpuUsedMs: number, steps: number }
 * }} Meter handle. `exceeded()` returns `null` while inside budget.
 */
export function createRuleBudget(options) {
  const { cpuBudgetMs, maxSteps } = options;
  let startedAt = 0;
  let steps = 0;

  return {
    begin(cpuNow) {
      startedAt = cpuNow;
      steps = 0;
    },
    addSteps(count) {
      steps += count;
    },
    exceeded(cpuNow) {
      const cpuUsedMs = cpuNow - startedAt;
      if (cpuUsedMs > cpuBudgetMs) {
        return { kind: 'timeout', reason: 'cpu-budget-exceeded', cpuUsedMs, steps };
      }
      if (steps > maxSteps) {
        return { kind: 'timeout', reason: 'step-budget-exceeded', cpuUsedMs, steps };
      }
      return null;
    },
  };
}
