/**
 * @aegisharness/event-store —— 单写者 SQLite 事务存储层公共出口。
 *
 * 定位（设计 §3 / §7）：它只是 **daemon 内部的持久化组件**。
 * 本包不启动进程、不开端口、不渲染界面、不执行任何响应动作；
 * 它把"一次事务应该原子地做什么"写成不可绕过的函数。
 *
 * 读这个出口的顺序建议：
 *   1. `openStore` / `migrate` / `quarantineCorruptDatabase` —— 生命周期；
 *   2. `ingestTelemetry`（T1）→ `reserveModelRequest`（T2）→
 *      `createApproval` / `approveExecution`（T3a）→ `prepareDispatch`（T3b）→
 *      `acceptExecution` / `beginExecuting`（T3c）→ `settleExecution`（T4）、
 *      `claimAnalysis` / `completeAnalysis`（T5）；
 *   3. `createBackup` / `restoreBackup` / `runRetention` / `assessCapacity` /
 *      `recordDataGap` —— 运维面。
 *
 * 所有写函数都要求可写句柄；所有事务函数都是同步的（`DatabaseSync`），
 * 唯一的例外是 `createBackup`，它 await SQLite 的在线备份。
 */

export { STORE_CODES, StoreError, isStoreError, mapSqliteError } from './errors.js';

export {
  CURRENT_SCHEMA_VERSION,
  MIN_READABLE_SCHEMA_VERSION,
  MIGRATIONS,
  schemaChecksum,
} from './schema.js';

export {
  openStore,
  migrate,
  assertSchemaReadable,
  assertNoTransactionControl,
  canonicalStorePath,
  findTransactionControl,
  quarantineCorruptDatabase,
  storeFileKey,
  writerLockPath,
} from './db.js';

export {
  AUDIT_ACTIONS,
  AUDIT_CHAIN_HEAD_SCHEMA_MIGRATION,
  AUDIT_CHAIN_HEAD_TABLE,
  PLACEHOLDER_AUDIT_KEY,
  appendAudit,
  auditChainHeadTableExists,
  auditHead,
  auditKeyId,
  ensureAuditChainHead,
  readAuditChainHead,
  repairAuditMode,
  resolveAuditMode,
  verifyAuditChainInStore,
} from './audit.js';

export {
  countEvents,
  getAlertById,
  getEvent,
  ingestTelemetry,
  ingestTelemetryBatch,
} from './ingest.js';

export {
  CONTRIBUTION_SPOOL_TABLE,
  MAX_SPOOL_PAYLOAD_BYTES,
  contributionSpoolId,
  countContributionSpool,
  deleteContributionSpool,
  listContributionSpool,
  normalizeSpoolEntry,
  putContributionSpool,
} from './spool.js';

export {
  dedupeKeyOf,
  hasDedupeKeys,
  isDedupeKey,
  stableKeyOf,
} from './dedupe.js';

export {
  DEFAULT_BUDGET_POLICY,
  MAX_CLOCK_SKEW_MS,
  assertAnalysisCapabilityOpen,
  listRequests,
  markModelRequestSent,
  markModelRequestUnknown,
  reserveModelRequest,
  rotateEpoch,
  settleModelRequest,
  settleUnknownAtUpperBound,
  summarizeBudget,
  voidModelRequest,
} from './budget.js';

export {
  APPROVAL_REVERIFY_MS,
  GRANT_MAX_TTL_MS,
  MAX_ACCEPT_SEQ,
  MAX_REDELIVER_ATTEMPTS,
  MIN_REDELIVER_INTERVAL_MS,
  acceptExecution,
  approveExecution,
  createApproval,
  getApproval,
  getExecution,
  getExecutionOutbox,
  insertProposalRow,
  markExecutionDispatched,
  prepareDispatch,
  redeliverExecution,
  registerProposal,
} from './approval.js';

export {
  EXECUTION_STATES,
  RECOVERY_TRANSITIONS,
  TERMINAL_EXECUTION_STATES,
  beginExecuting,
  getExecutionResults,
  getRecoveryManifestByAttempt,
  listExecutions,
  markManualRequired,
  markResultUnknown,
  requestReconcile,
  settleExecution,
  sweepExpiredExecutionLeases,
  transitionRecovery,
  writeRecoveryManifest,
} from './execution.js';

export {
  ANALYSIS_STATES,
  DEFAULT_MAX_ANALYSIS_ATTEMPTS,
  TERMINAL_ANALYSIS_STATES,
  adoptAnalysisEpoch,
  beginAnalysisRunning,
  claimAnalysis,
  completeAnalysis,
  failAnalysis,
  getAnalysis,
  getAnalysisReport,
  listAnalyses,
  requeueAnalysis,
  sweepExpiredAnalysisLeases,
} from './analysis.js';

export {
  CAPABILITIES,
  DEFAULT_CAPACITY_LIMITS,
  DEFAULT_RETENTION_POLICY,
  assessCapacity,
  enforceCapacity,
  assertResponseCapabilityOpen,
  getCapabilityState,
  listDataGaps,
  purgeAlerts,
  recordDataGap,
  runRetention,
  setCapabilityState,
  summarizeDataGaps,
} from './maintenance.js';

export { createBackup, restoreBackup, verifyBackupAuditChain, verifyBackupFile } from './backup.js';

export {
  GENESIS_DIGEST,
  canonicalDigest,
  canonicalize,
  createClock,
  hmacBase64,
  isoFromMs,
  msFromIso,
  opaqueToken,
  sha256Hex,
  utcDayOf,
  uuid,
} from './util.js';
