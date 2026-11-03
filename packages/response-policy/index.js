/**
 * index.js — the single public entry point of the response-policy package.
 *
 * Everything below is re-exported for consumers; nothing else is supported
 * surface. The package is a **decision layer only**: it imports no process, net,
 * fs or child_process module, opens no socket, spawns nothing and writes nothing.
 * `tests/wp7-response-policy/isolation.test.js` enforces that by scanning the
 * sources, so an accidental `import { spawn }` turns the suite red.
 *
 * Reading order for a new consumer:
 *   reasons.js    → the closed outcome / reason-code vocabulary
 *   catalog.js    → what may be requested, on which OS, at what risk
 *   target.js     → what identity a request must bind to
 *   parameters.js → what parameters are legal
 *   decision.js   → the pure allow / needs_approval / deny gate
 *   integration.js→ how a decision is summarised, never how it is executed
 */

export { PolicyError, isPolicyError } from './src/errors.js';
export {
  OUTCOMES,
  REASON_CODES,
  REASON_OUTCOMES,
  isReasonCode,
  outcomeFor,
} from './src/reasons.js';
export {
  ACTION_CATALOG,
  ACTION_IDS,
  ACTION_OS_MATRIX,
  CatalogError,
  CURRENT_POLICY_VERSION,
  DEFAULT_PARAMETER_ROOTS,
  FORBIDDEN_ACTIONS,
  IRREVERSIBLE_ACTIONS,
  MAX_PARAMETER_BYTES,
  MAX_PARAMETER_KEYS,
  MAX_PARAMETER_ROOTS,
  MAX_PARAMETER_STRING_BYTES,
  PARAMETER_SPEC_TYPES,
  RISK_RANK,
  ROLE_CAPABILITIES,
  ROLE_NAMES,
  SUPPORTED_OS,
  SUPPORTED_POLICY_VERSIONS,
  actionDigest,
  capabilityForRole,
  getAction,
  isCatalogAction,
  isForbiddenAction,
  isSupportedOs,
  osSupportFor,
  verifyCatalog,
} from './src/catalog.js';
export {
  MAX_PATH_BYTES,
  PARAMETER_PATH_CODES,
  TARGET_PATH_CODES,
  normalizeCanonicalPath,
} from './src/paths.js';
export {
  OBJECT_ID_SOURCES,
  TARGET_KINDS,
  compareContractTarget,
  ensureNormalizedTarget,
  isNormalizedTarget,
  normalizeTarget,
  targetDigest,
  toContractTarget,
} from './src/target.js';
export { normalizeParameters, parametersDigest } from './src/parameters.js';
export { isUtcTimestamp, parseUtcMs } from './src/time.js';
export { currentPolicyVersion, evaluateResponsePolicy, roleSatisfies } from './src/decision.js';
export { createReplayRegistry } from './src/replay.js';
export {
  POLICY_GATE_CONTRACT,
  assertGateNeverAuthorizes,
  contractTarget,
  decisionSummary,
} from './src/integration.js';
