/**
 * build.js — the one place this build says whether execution exists.
 *
 * It lives in its own module because two other modules need it and neither should
 * import the other: `interface.js` publishes it as `dryRunOnly`, `plan.js` uses it
 * to fill `executable`. A literal `true` typed in two places is how a "dry-run
 * only" claim and a "not dry-run" flag end up disagreeing.
 *
 * The value is a frozen export, not a setting. No envelope field, environment
 * variable, constructor option or port can change it: to enable execution you
 * change this constant, which is a source change and therefore reviewable.
 */

/** Real execution is not implemented in this build. */
export const EXECUTION_ENABLED = false;

/** True whenever {@link EXECUTION_ENABLED} is false; the helper's public mode. */
export const DRY_RUN_ONLY = !EXECUTION_ENABLED;
