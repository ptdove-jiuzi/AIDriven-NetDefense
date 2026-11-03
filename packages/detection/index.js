/**
 * index.js — the single public entry point of the detection package.
 *
 * Everything below is re-exported for consumers; nothing else in the package is
 * part of the supported surface.
 */

export { createDetectionEngine, DEFAULT_LIMITS, GAP_KINDS, resolveLimits } from './src/engine.js';
export { loadRulePack, validateRulePack, SUPPORTED_SCHEMA_VERSION } from './src/rule-pack.js';
export {
  DEFAULT_BUDGET_QUANTUM_MS,
  assertBudgetClock,
  assertClock,
  createManualClock,
  createMonotonicClock,
  createRealtimeClock,
  createStepClock,
  isRealtimeClock,
} from './src/clock.js';
export {
  ALERT_STATUSES,
  DEFAULT_AGGREGATION_WINDOW_MS,
  alertView,
  canTransition,
  closeAlert,
  createAlert,
  windowStartFor,
} from './src/aggregate.js';
export {
  SEVERITY_LEVELS,
  compareSeverity,
  isSeverity,
  maxSeverity,
  parseSeverity,
  severityByRank,
  severityRank,
} from './src/severity.js';
export { DetectionConfigError, RuleDefinitionError } from './src/errors.js';
export { SHA256_HEX_LENGTH, canonicalStringify, sha256Hex, shortHash, truncatePreview } from './src/canonical.js';
export {
  FINGERPRINT_TRANSFORMS,
  FORBIDDEN_PATH_SEGMENTS,
  applyTransform,
  attachFieldReadCache,
  buildFingerprintInput,
  buildFingerprintKeys,
  buildGroupKey,
  computeFingerprint,
  isMissingValue,
  isValidPath,
  normalizePathValue,
  normalizeText,
  resolveField,
  splitPath,
} from './src/normalize.js';
export { OPERATOR_NAMES, evaluateOperator, isOperatorName, validateOperatorValue } from './src/operators.js';
export {
  MAX_BRANCH_WIDTH,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_NODES,
  compileExpression,
  evaluateExpression,
} from './src/expression.js';
export {
  HOUR_MS,
  RATE_BUCKETS_RETAINED,
  RATE_KEYS_RETAINED,
  createRateState,
  hourStartFor,
  requestAnalysis,
} from './src/rate-limit.js';
export {
  ID_KINDS,
  createCustomIdFactory,
  createRandomIdFactory,
  createSequenceIdFactory,
  isUuidV4,
} from './src/ids.js';
export {
  DEFAULT_SUMMARY_FIELDS,
  SUMMARY_CLASSIFICATION,
  buildSummaryDto,
  formatRfc3339Utc,
  toAlert,
  toAnalysisRequest,
  toEvidenceRef,
  toFinding,
} from './src/contracts-adapter.js';
