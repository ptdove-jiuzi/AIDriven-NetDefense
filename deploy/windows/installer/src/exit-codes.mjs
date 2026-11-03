/**
 * Exit codes — the stable contract of ADR-0009 §10.4.
 *
 * These numbers are a published API: once a release ships, a code may never change
 * meaning, and a new situation gets a new number rather than being folded into an
 * existing one. 24 / 25 / 26 are strictly mutually exclusive:
 *
 *   24 = we tried to roll back and failed        (human intervention needed)
 *   25 = we refused to roll back                 (precondition unmet, nothing done)
 *   26 = we rolled back during recovery and won  (the upgrade is void, service runs)
 *
 * Using 24 for a *successful* rollback is a contract violation, not a style issue.
 */

export const EXIT = Object.freeze({
  OK: 0,
  /** 参数或预检失败（含磁盘余量、架构、版本关系不成立、journal/version-floor 损坏） */
  PRECHECK: 10,
  /** 权限不足（需提升） */
  ELEVATION: 11,
  /** 载荷哈希校验失败 */
  MANIFEST: 12,
  /** 签名校验失败 */
  SIGNATURE: 13,
  /** 降级被阻断 E_DOWNGRADE_BLOCKED */
  DOWNGRADE_BLOCKED: 14,
  /** 已在运行，或存在进行中事务（journal 非终止态） */
  BUSY: 15,
  /** 服务停止失败 */
  SERVICE_STOP: 20,
  /** DB 快照失败（升级已中止，未改动任何已装文件） */
  DB_SNAPSHOT: 21,
  /** 迁移失败（已回滚） */
  MIGRATION: 22,
  /** 健康检查失败（已回滚） */
  HEALTH: 23,
  /** 回滚失败（需人工介入） */
  ROLLBACK_FAILED: 24,
  /** 回滚被拒绝（前置不满足，未执行任何动作） */
  ROLLBACK_REFUSED: 25,
  /** 中断恢复：已回滚到旧版（不是失败，但仍需告知用户） */
  ROLLED_BACK: 26,
  /** 卸载失败（服务未删或程序区未清空） */
  UNINSTALL_FAILED: 30,
  /** 清除失败（部分删除，路径已逐项列出） */
  PURGE_FAILED: 31,
});

/** Human-readable label for the log footer. Never use these as control flow. */
export const EXIT_LABELS = Object.freeze({
  0: 'OK',
  10: 'E_PRECHECK',
  11: 'E_ELEVATION_REQUIRED',
  12: 'E_MANIFEST_MISMATCH',
  13: 'E_SIGNATURE_INVALID',
  14: 'E_DOWNGRADE_BLOCKED',
  15: 'E_BUSY',
  20: 'E_SERVICE_STOP',
  21: 'E_DB_SNAPSHOT',
  22: 'E_MIGRATION_FAILED',
  23: 'E_HEALTH_FAILED',
  24: 'E_ROLLBACK_FAILED',
  25: 'E_ROLLBACK_REFUSED',
  26: 'E_ROLLED_BACK',
  30: 'E_UNINSTALL_FAILED',
  31: 'E_PURGE_FAILED',
});
