/**
 * index.js — the single public entry point of the response helper.
 *
 * This package is a **dry-run planner**: it imports no `node:fs`, `node:net`,
 * `node:os` or `node:child_process`, and it performs no process, network or file
 * side effect. `tests/wp7-response-helper/isolation.test.js` scans the sources so
 * an accidental `import { spawn }` turns the suite red, and
 * `tests/wp7-response-helper/execute-stub.test.js` asserts that the one method
 * named `execute` cannot be talked into doing anything.
 *
 * Reading order for a new consumer:
 *   interface.js  → the closed dispatch envelope and the four methods
 *   ports.js      → the only OS-facing questions, all injected and mockable
 *   snapshot.js   → what "the same object" means, and how drift is named
 *   plan.js       → the structured plan, and why every step is static text
 *   helper.js     → the pipeline that ties them together
 */

export { HELPER_CODES, HelperError, isHelperCode, isHelperError } from './src/errors.js';

export { DRY_RUN_ONLY, EXECUTION_ENABLED } from './src/build.js';

export {
  ENVELOPE_KEYS,
  HELPER_INTERFACE,
  HELPER_METHODS,
  INTERFACE_VERSION,
  readOptionalIdentifier,
  validateEnvelope,
} from './src/interface.js';

export {
  CAPABILITIES,
  CAPABILITY_STATES,
  OBSERVATION_STATES,
  OS_FAMILIES,
  createFixedClock,
  createHostOsProbe,
  createMemoryInbox,
  createMemoryManifestStore,
  createNullCapabilityProbe,
  createNullGrantVerifier,
  createNullTargetProbe,
  createStaticCapabilityProbe,
  createStaticGrantVerifier,
  createStaticOsProbe,
  createStaticTargetProbe,
  createSystemClock,
  validateObservation,
} from './src/ports.js';

export {
  DRIFT_REASONS,
  EXPECTED_STATE,
  buildSnapshot,
  detectDrift,
  identityDigest,
  refusalCodeForDrift,
} from './src/snapshot.js';

/*
 * `buildPlan` is deliberately **not** exported here. A plan is only as trustworthy
 * as the verdict it summarises, and a public assembler would let any in-process
 * caller hand it a fabricated decision and obtain `status: 'planned'`. The plan is
 * produced by `prepare`/`dryRun` and by nothing else.
 */
export {
  ACTION_STEPS,
  REQUIRED_CAPABILITIES,
  STEP_KINDS,
  planSummary,
  requiredCapabilities,
  stepsFor,
} from './src/plan.js';

export {
  HELPER_ACTION_ALLOWLIST,
  MAX_CLOCK_SKEW_MS,
  createResponseHelper,
  isHelperAllowedAction,
} from './src/helper.js';
