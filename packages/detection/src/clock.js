/**
 * clock.js — injectable time sources.
 *
 * Two independent clocks exist, and they answer two different questions:
 *
 * | clock | question | determinism |
 * |---|---|---|
 * | event clock (`clock`) | "what time is it in the event stream?" | caller owned, usually a `createManualClock` |
 * | budget clock (`cpuClock`) | "how much evaluation work has this rule done?" | deterministic by default, see below |
 *
 * ## The budget clock is deterministic by default
 *
 * The per-rule CPU budget used to be metered with `process.hrtime`, which made
 * the set of isolated rules — and therefore the detections, alerts, analysis
 * requests and gaps of a batch — depend on how fast the host happened to run.
 * Replaying the same events on a slower machine produced different output and
 * could permanently isolate every rule (`cpu-budget-exceeded`), which violates
 * the engine's "identical event sequences produce byte-identical results"
 * contract and silently loses detections.
 *
 * The default is now {@link createStepClock}: a clock that advances a fixed
 * quantum per `now()` call, so the budget is metered in *calls* (one `now()`
 * per rule per evaluated event) instead of wall time. The same input therefore
 * always produces the same metering, on any host.
 *
 * Callers that genuinely want wall-clock metering must ask for it twice: build
 * the clock with {@link createRealtimeClock} **and** pass
 * `allowNondeterministicBudget: true` to the engine. The engine refuses a
 * bounded realtime clock on its own (fail-closed), because accepting it silently
 * is exactly the bug this file documents.
 */

import { DetectionConfigError } from './errors.js';

/**
 * Default quantum of the deterministic budget clock, in virtual milliseconds.
 *
 * Chosen so that a rule evaluated against a full default batch
 * (`maxEventsPerIngest: 1000`) is charged 10 ms — comfortably inside the 50 ms
 * default `ruleCpuBudgetMs` — while a genuinely runaway rule still trips the
 * budget: `ruleCpuBudgetMs: 1` is reached after ~100 evaluated events.
 *
 * @type {number}
 */
export const DEFAULT_BUDGET_QUANTUM_MS = 0.01;

/**
 * Brand attached to {@link createRealtimeClock} results.
 *
 * Only branded clocks are rejected without `allowNondeterministicBudget`, which
 * keeps arbitrary injected test clocks (scripted, frozen, stepping) usable. The
 * brand is not a security boundary: it is a way for the engine to recognise the
 * one wall clock the package itself ships.
 */
const REALTIME_CLOCK_BRAND = Symbol('aegisharness.detection.realtimeClock');

/**
 * Create a manual clock advanced only by the owner of the object.
 *
 * @param {number} [startAt] Initial epoch milliseconds, default `0`.
 * @returns {{ now: () => number, advance: (deltaMs: number) => number, set: (at: number) => number }}
 *   Clock handle. `now()` returns the current value, `advance()` adds a
 *   non-negative integer and returns the new value, `set()` jumps forward to an
 *   absolute value and returns it.
 * @throws {DetectionConfigError} When `startAt` is not a finite integer.
 */
export function createManualClock(startAt = 0) {
  assertMilliseconds(startAt, 'startAt');
  let current = startAt;
  return {
    now() {
      return current;
    },
    advance(deltaMs) {
      assertMilliseconds(deltaMs, 'deltaMs');
      if (deltaMs < 0) {
        throw new DetectionConfigError('manual clock cannot move backwards', { path: 'deltaMs' });
      }
      current += deltaMs;
      return current;
    },
    set(at) {
      assertMilliseconds(at, 'at');
      current = at;
      return current;
    },
  };
}

/**
 * Create a wall clock for CPU budget measurement.
 *
 * The origin is arbitrary; only differences are meaningful. Values are
 * fractional milliseconds, which is why the budget clock is validated as a
 * finite number rather than as an integer (unlike the event clock).
 *
 * **This clock destroys replay determinism.** The engine accepts it only with
 * `allowNondeterministicBudget: true`; see the file header.
 *
 * @returns {{ now: () => number }} Clock returning elapsed milliseconds since creation.
 */
export function createRealtimeClock() {
  const origin = process.hrtime.bigint();
  const clock = {
    now() {
      return Number(process.hrtime.bigint() - origin) / 1e6;
    },
  };
  Object.defineProperty(clock, REALTIME_CLOCK_BRAND, { value: true, enumerable: false });
  return clock;
}

/**
 * Monotonic wall clock, kept for compatibility.
 *
 * @deprecated Use {@link createRealtimeClock} so that the intent (and the
 *   `allowNondeterministicBudget` requirement) is visible at the call site.
 * @returns {{ now: () => number }} Clock returning elapsed milliseconds since creation.
 */
export function createMonotonicClock() {
  return createRealtimeClock();
}

/**
 * Report whether a clock was produced by {@link createRealtimeClock}.
 *
 * @param {unknown} clock Candidate clock.
 * @returns {boolean} `true` for a branded wall clock.
 */
export function isRealtimeClock(clock) {
  return clock !== null && typeof clock === 'object' && clock[REALTIME_CLOCK_BRAND] === true;
}

/**
 * Create the default, deterministic budget clock.
 *
 * Every `now()` returns the current virtual time and then advances it by
 * `quantumMs`, so `n` calls span `(n - 1) * quantumMs`. The elapsed value is a
 * pure function of the number of calls, never of how long a call took.
 *
 * @param {{ quantumMs?: number }} [options] Clock options.
 * @returns {{ now: () => number, quantumMs: number, steps: () => number }} Clock
 *   handle. `steps()` reports how many times `now()` was called, which is the
 *   meter the budget is really built on.
 * @throws {DetectionConfigError} When `quantumMs` is not a finite number > 0.
 */
export function createStepClock(options = {}) {
  const source = options === null || options === undefined ? {} : options;
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new DetectionConfigError('step clock options must be an object', { path: 'options' });
  }
  const quantumMs = source.quantumMs === undefined ? DEFAULT_BUDGET_QUANTUM_MS : source.quantumMs;
  if (typeof quantumMs !== 'number' || !Number.isFinite(quantumMs) || quantumMs <= 0) {
    throw new DetectionConfigError('quantumMs must be a finite number greater than 0', { path: 'quantumMs' });
  }
  let elapsed = 0;
  let calls = 0;
  return {
    quantumMs,
    now() {
      const value = elapsed;
      elapsed += quantumMs;
      calls += 1;
      return value;
    },
    steps() {
      return calls;
    },
  };
}

/**
 * Validate a clock-like object that supplies **event** time.
 *
 * Event time is used for `advanceTo`/`flush`, for the result `at` and for the
 * allowlist expiry check, all of which require integer milliseconds. The check
 * therefore rejects a clock that can return `1500.5`: without it, `ingest`
 * would succeed and the next `flush()` would throw and freeze a healthy engine.
 *
 * @param {unknown} clock Candidate clock.
 * @param {string} [label] Field name used in the error message, default `clock`.
 * @returns {{ now: () => number }} The validated clock.
 * @throws {DetectionConfigError} When the value is not an object with a `now`
 *   function, or when `now()` does not return a finite integer.
 */
export function assertClock(clock, label = 'clock') {
  const probe = probeClock(clock, label);
  if (!Number.isInteger(probe)) {
    throw new DetectionConfigError(
      `${label}.now() must return an integer number of milliseconds, received ${probe}`,
      { path: label, detail: { value: probe } },
    );
  }
  return clock;
}

/**
 * Validate a clock-like object that supplies **budget** time.
 *
 * Fractional values are allowed here: wall clocks return them, and the budget
 * only compares differences.
 *
 * @param {unknown} clock Candidate clock.
 * @param {string} [label] Field name used in the error message, default `cpuClock`.
 * @returns {{ now: () => number }} The validated clock.
 * @throws {DetectionConfigError} When the value is not an object with a `now`
 *   function, or when `now()` does not return a finite number.
 */
export function assertBudgetClock(clock, label = 'cpuClock') {
  probeClock(clock, label);
  return clock;
}

function probeClock(clock, label) {
  if (clock === null || typeof clock !== 'object' || typeof clock.now !== 'function') {
    throw new DetectionConfigError(`${label} must be an object with a now() function`, { path: label });
  }
  let probe;
  try {
    probe = clock.now();
  } catch (error) {
    throw new DetectionConfigError(`${label}.now() threw: ${describe(error)}`, { path: label });
  }
  if (typeof probe !== 'number' || !Number.isFinite(probe)) {
    throw new DetectionConfigError(`${label}.now() must return a finite number`, { path: label });
  }
  return probe;
}

function assertMilliseconds(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw new DetectionConfigError(`${label} must be an integer number of milliseconds`, { path: label });
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
