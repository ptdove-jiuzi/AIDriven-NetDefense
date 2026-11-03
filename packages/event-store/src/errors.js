/**
 * 事件存储层的错误类型与错误码。
 *
 * 与 `packages/contracts` 的 `ContractError` 分工明确：
 * - 合同错误 = 输入 DTO 不合法（调用方给错了数据），存储层直接透传，不包装；
 * - 存储错误 = 状态机、事务、容量、锁、迁移层面的拒绝。
 *
 * 两种错误都带稳定的 `code`，测试按 code 断言而不是按错误文案断言，
 * 这样改文案不会静默让测试变成"看什么都不报错"。
 */

export const STORE_CODES = Object.freeze({
  /** 调用参数缺失或形态错误（存储层自身入口）。 */
  ERR_STORE_INPUT: 'ERR_STORE_INPUT',
  /** 同一进程内同一路径已有写连接。 */
  ERR_STORE_ALREADY_OPEN: 'ERR_STORE_ALREADY_OPEN',
  /** 跨进程写锁被存活进程持有。 */
  ERR_STORE_LOCKED: 'ERR_STORE_LOCKED',
  /** 只读连接上尝试写入。 */
  ERR_STORE_READ_ONLY: 'ERR_STORE_READ_ONLY',
  /** 数据库未初始化（文件不存在或 schema 落后于本二进制）。 */
  ERR_STORE_NOT_INITIALIZED: 'ERR_STORE_NOT_INITIALIZED',
  /** SQLite 约束冲突（唯一 / 外键 / CHECK）。 */
  ERR_STORE_CONSTRAINT: 'ERR_STORE_CONSTRAINT',
  /** 其他 SQLite 失败。 */
  ERR_STORE_SQL: 'ERR_STORE_SQL',
  /** 数据库 schema 版本高于本二进制可读版本。 */
  ERR_SCHEMA_TOO_NEW: 'ERR_SCHEMA_TOO_NEW',
  /** 迁移执行失败（已整体回滚）。 */
  ERR_MIGRATION_FAILED: 'ERR_MIGRATION_FAILED',
  /** 已应用迁移的校验和与代码不一致。 */
  ERR_MIGRATION_CHECKSUM_MISMATCH: 'ERR_MIGRATION_CHECKSUM_MISMATCH',
  /** 事务嵌套。 */
  ERR_TX_NESTED: 'ERR_TX_NESTED',
  /** `store.exec()` 收到事务控制语句（BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE）。 */
  ERR_TX_CONTROL: 'ERR_TX_CONTROL',
  /** 事务在 `tx()` 之外被提交或回滚：原子性已被击穿。 */
  ERR_TX_ESCAPED: 'ERR_TX_ESCAPED',
  /** 重投次数达到上限，执行转人工处理。 */
  ERR_REDELIVER_LIMIT: 'ERR_REDELIVER_LIMIT',
  /** 距上次投递不足最小重投间隔。 */
  ERR_REDELIVER_TOO_SOON: 'ERR_REDELIVER_TOO_SOON',
  /** inbox 序号越界（拒绝用大 seq 撑大 inbox）。 */
  ERR_INBOX_SEQ_OUT_OF_RANGE: 'ERR_INBOX_SEQ_OUT_OF_RANGE',
  /** 完整性检查失败（非 not-a-database 类的损坏）。 */
  ERR_DB_INTEGRITY: 'ERR_DB_INTEGRITY',
  /** 数据库文件不是有效 SQLite 库 / 已损坏。 */
  ERR_DB_CORRUPT: 'ERR_DB_CORRUPT',
  /** 数据库被其他连接占用（busy/locked）。 */
  ERR_DB_BUSY: 'ERR_DB_BUSY',
  /** 预算准入拒绝。 */
  ERR_BUDGET_EXCEEDED: 'ERR_BUDGET_EXCEEDED',
  /** 持久时间高水位不成立（回拨 / 不确定）。 */
  ERR_BUDGET_TIME_UNTRUSTED: 'ERR_BUDGET_TIME_UNTRUSTED',
  /** 模型请求状态迁移非法。 */
  ERR_REQUEST_STATE: 'ERR_REQUEST_STATE',
  /** 没有证明"未发送"就试图作废/重试。 */
  ERR_RETRY_NOT_PROVEN: 'ERR_RETRY_NOT_PROVEN',
  /** 分析请求不存在。 */
  ERR_ANALYSIS_NOT_FOUND: 'ERR_ANALYSIS_NOT_FOUND',
  /** 分析状态不允许该迁移。 */
  ERR_ANALYSIS_STATE: 'ERR_ANALYSIS_STATE',
  /** 审批不存在。 */
  ERR_APPROVAL_NOT_FOUND: 'ERR_APPROVAL_NOT_FOUND',
  /** 审批状态不允许该迁移。 */
  ERR_APPROVAL_STATE: 'ERR_APPROVAL_STATE',
  /** 审批超出 TTL。 */
  ERR_APPROVAL_EXPIRED: 'ERR_APPROVAL_EXPIRED',
  /** 审批绑定的策略版本与当前策略不一致。 */
  ERR_APPROVAL_POLICY_MISMATCH: 'ERR_APPROVAL_POLICY_MISMATCH',
  /** epoch 不匹配（恢复后旧授权失效）。 */
  ERR_EPOCH_MISMATCH: 'ERR_EPOCH_MISMATCH',
  /** 摘要/绑定关系不一致（proposal_digest、target_digest 等）。 */
  ERR_BINDING_MISMATCH: 'ERR_BINDING_MISMATCH',
  /** 当前角色不允许该动作（例如 analyst 审批响应）。 */
  ERR_ROLE_NOT_PERMITTED: 'ERR_ROLE_NOT_PERMITTED',
  /** 租约已过期：旧 owner 不能再推进状态。 */
  ERR_LEASE_EXPIRED: 'ERR_LEASE_EXPIRED',
  /** 提交方不是当前 owner / attempt（旧 owner、迟到 attempt）。 */
  ERR_STALE_OWNER: 'ERR_STALE_OWNER',
  /** nonce 已被消费。 */
  ERR_NONCE_CONSUMED: 'ERR_NONCE_CONSUMED',
  /** 执行状态不允许该迁移。 */
  ERR_EXECUTION_STATE: 'ERR_EXECUTION_STATE',
  /** 执行记录不存在。 */
  ERR_EXECUTION_NOT_FOUND: 'ERR_EXECUTION_NOT_FOUND',
  /** 恢复清单状态不允许该迁移。 */
  ERR_RECOVERY_STATE: 'ERR_RECOVERY_STATE',
  /** 保留策略拒绝删除（受保护数据）。 */
  ERR_RETENTION_GUARD: 'ERR_RETENTION_GUARD',
  /** 容量临界：拒绝新增高价值写入。 */
  ERR_CAPACITY_CRITICAL: 'ERR_CAPACITY_CRITICAL',
  /** 备份失败。 */
  ERR_BACKUP_FAILED: 'ERR_BACKUP_FAILED',
  /** 备份目标已存在。 */
  ERR_BACKUP_TARGET_EXISTS: 'ERR_BACKUP_TARGET_EXISTS',
  /**
   * 目标库带有非空且**无法合并**的 WAL（活跃读者 / WAL 已损坏）。
   *
   * 恢复会用备份整体替换目标库；此时 WAL 里"已提交但尚未并回主库"的事务
   * 会随库一起被换走。默认拒绝，只有调用方显式 `discardWal: true`
   * （并在恢复后的库里留审计）才允许继续。
   */
  ERR_RESTORE_WAL_UNSAFE: 'ERR_RESTORE_WAL_UNSAFE',
  /**
   * 备份的审计链无法自证（无链头 / 无密钥 / 链头是别的密钥签的 / 验签只覆盖一段）。
   *
   * 不能证明"备份没被改过"就不该拿它覆盖在线库；只有显式
   * `allowUnverifiedChain: true`（并在恢复后的库里留审计）才允许继续。
   */
  ERR_RESTORE_CHAIN_UNVERIFIED: 'ERR_RESTORE_CHAIN_UNVERIFIED',
  /**
   * 恢复失败**且**回滚也失败：目标库处于未知状态，必须人工处理。
   *
   * `details` 里带恢复前后的行数、`previous_copy` 与原始失败码，运维可以据此
   * 判断"已提交事务到底还在不在"，而不是对着一个静默成功的返回值猜。
   */
  ERR_RESTORE_ROLLBACK_FAILED: 'ERR_RESTORE_ROLLBACK_FAILED',
  /** 该操作在只读或当前上下文下不支持。 */
  ERR_NOT_SUPPORTED: 'ERR_NOT_SUPPORTED',
});

function freezeDetails(details) {
  if (details === undefined || details === null) return undefined;
  const copy = {};
  for (const key of Object.keys(details)) {
    const value = details[key];
    copy[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(copy);
}

export class StoreError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'StoreError';
    this.code = code;
    this.details = freezeDetails(details);
    if (Error.captureStackTrace) Error.captureStackTrace(this, StoreError);
  }
}

export function isStoreError(value) {
  return value instanceof StoreError;
}

/**
 * 把 node:sqlite 抛出的原始错误映射成稳定的存储错误码。
 *
 * 映射顺序很重要：先判"不是数据库"，再判锁，再判约束。
 * 反过来会把 "file is not a database" 之外的损坏误判成 busy。
 *
 * @param {unknown} error 原始错误。
 * @param {string} [fallbackCode] 无法归类时使用的错误码。
 * @returns {StoreError}
 */
export function mapSqliteError(error, fallbackCode = STORE_CODES.ERR_STORE_SQL) {
  if (error instanceof StoreError) return error;
  const message = String(error && error.message ? error.message : error);
  if (/not a database|file is encrypted|database disk image is malformed/iu.test(message)) {
    return new StoreError(STORE_CODES.ERR_DB_CORRUPT, message);
  }
  if (/database is locked|database table is locked|SQLITE_BUSY/iu.test(message)) {
    return new StoreError(STORE_CODES.ERR_DB_BUSY, message);
  }
  // "cannot store TEXT value in INTEGER column ..." 是 STRICT 表的类型约束，
  // 与 CHECK/UNIQUE 同属"写入被约束拒绝"，归到同一个码里便于上层统一处理。
  if (/constraint failed|UNIQUE constraint|FOREIGN KEY constraint|CHECK constraint|cannot store .+ value in/iu.test(message)) {
    return new StoreError(STORE_CODES.ERR_STORE_CONSTRAINT, message);
  }
  if (/readonly database|read-only database/iu.test(message)) {
    return new StoreError(STORE_CODES.ERR_STORE_READ_ONLY, message);
  }
  return new StoreError(fallbackCode, message);
}
