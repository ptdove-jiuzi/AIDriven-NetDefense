/**
 * summary-contract.js — the two constants that describe the exportable summary
 * DTO, in a module with **no imports at all**.
 *
 * Why this file exists: `rate-limit.js` must build the same `{ classification,
 * fields }` shape the adapter validates, but the engine core is required to stay
 * a dependency-free calculator (see the header of `contracts-adapter.js`). Putting
 * the constants in the adapter and importing them from `rate-limit.js` would have
 * dragged `@aegisharness/contracts` into the module graph of `engine.js` through
 * the back door — a transitive dependency that the per-file import gate in
 * `tests/wp3-detection/determinism.test.js` cannot see.
 *
 * So the constants live here, the adapter re-exports them (the public surface is
 * unchanged), and neither side owns the other.
 */

/** Only D0 summaries may leave the detection boundary. */
export const SUMMARY_CLASSIFICATION = 'D0';

/** Summary fields the detection engine produces, in fixed key order. */
export const DEFAULT_SUMMARY_FIELDS = Object.freeze([
  'sequence_in_hour',
  'severity_rank',
  'alert_count',
  'rule_type',
]);
