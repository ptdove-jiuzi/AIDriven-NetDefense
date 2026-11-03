/**
 * Broker 错误类型与稳定错误码。
 *
 * 三条纪律：
 * 1. `code` 稳定，测试按 code 断言而不是按文案断言；改文案不该让测试静默变绿。
 * 2. `details` 只允许放 id、计数、字节数、枚举值——**禁止放请求/响应正文、
 *    凭据、header 或任何可能被回显的原文**。错误对象会被写日志、被打到控制台、
 *    被上层包装成 IPC 响应，它是最容易泄漏凭据的通道之一。
 * 3. 每个 code 对应"失败关闭"语义，不存在"警告后继续"。
 */

export const BROKER_CODES = Object.freeze({
  /** 调用方给错了结构（缺字段、类型不对、空消息）。 */
  ERR_BROKER_INPUT: 'ERR_BROKER_INPUT',
  /** 超出条数/字节/深度上限。 */
  ERR_BROKER_LIMIT: 'ERR_BROKER_LIMIT',
  /** 出域字段不在 allowlist 内。 */
  ERR_BROKER_ALLOWLIST: 'ERR_BROKER_ALLOWLIST',
  /** 数据分级不允许出域（D2/D3），或分级声明与字段不符。 */
  ERR_BROKER_CLASSIFICATION: 'ERR_BROKER_CLASSIFICATION',
  /** 脱敏后仍检出秘密：无法证明 DTO 合规，禁止外发。 */
  ERR_BROKER_REDACTION_FAILED: 'ERR_BROKER_REDACTION_FAILED',
  /** 预算准入拒绝（不足/时间不可信/epa 不符/能力关闭）。 */
  ERR_BROKER_BUDGET: 'ERR_BROKER_BUDGET',
  /** 队列已满：有界排队后停止新分析。 */
  ERR_BROKER_QUEUE_FULL: 'ERR_BROKER_QUEUE_FULL',
  /** 客户端取消。 */
  ERR_BROKER_CANCELLED: 'ERR_BROKER_CANCELLED',
  /** 墙钟超时。 */
  ERR_BROKER_TIMEOUT: 'ERR_BROKER_TIMEOUT',
  /** 提供方/端点/模型配置不合法。 */
  ERR_BROKER_ENDPOINT: 'ERR_BROKER_ENDPOINT',
  /** 缺少或无法读取提供方凭据。 */
  ERR_BROKER_CREDENTIAL: 'ERR_BROKER_CREDENTIAL',
  /** 提供方返回错误（状态码/协议/超大响应）。 */
  ERR_BROKER_PROVIDER: 'ERR_BROKER_PROVIDER',
  /** 结果未知：请求可能已到达提供方，债务按上界保留。 */
  ERR_BROKER_UNKNOWN: 'ERR_BROKER_UNKNOWN',
  /** 熔断打开，禁止新请求。 */
  ERR_BROKER_CIRCUIT_OPEN: 'ERR_BROKER_CIRCUIT_OPEN',
  /** analysis/attempt 身份或模型路由不匹配。 */
  ERR_BROKER_ROUTE: 'ERR_BROKER_ROUTE',
  /** 预算适配器违约（接口缺失或返回了不认识的结构）。 */
  ERR_BROKER_ADAPTER: 'ERR_BROKER_ADAPTER',
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

export class BrokerError extends Error {
  /**
   * @param {string} code `BROKER_CODES` 中的稳定码。
   * @param {string} message 人类可读描述；不得包含载荷原文或凭据。
   * @param {object} [details] 仅结构化元数据（id/计数/字节数）。
   */
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'BrokerError';
    this.code = code;
    this.details = freezeDetails(details);
    if (Error.captureStackTrace) Error.captureStackTrace(this, BrokerError);
  }
}

export function isBrokerError(value) {
  return value instanceof BrokerError;
}

/**
 * 把任意异常收敛成 `BrokerError`，并且**丢弃原始 message**。
 *
 * 底层异常（fetch、JSON、socket）的 message 里可能带 URL、header、响应片段；
 * 只保留错误类型名与 code，用于诊断而不泄漏内容。
 */
export function asBrokerError(error, fallbackCode, message, details) {
  if (error instanceof BrokerError) return error;
  const merged = { ...(details ?? {}) };
  if (error && typeof error === 'object') {
    if (typeof error.name === 'string') merged.cause_name = error.name;
    if (typeof error.code === 'string') merged.cause_code = error.code;
    if (typeof error.status === 'number') merged.cause_status = error.status;
  }
  return new BrokerError(fallbackCode, message, merged);
}
