/**
 * Broker 硬上限。全部冻结：运行期没有任何"临时放宽"通道。
 *
 * 这些值是**本地准入上限**，不是提供方账户账单上限（设计 §9.1 末段）。
 * 改动它们的唯一合法途径是管理员配置 + 重新跑门禁。
 */

export const BROKER_LIMITS = Object.freeze({
  /** 单次请求最多几条消息（system + user 足够；tool 结果应折叠进 user）。 */
  maxMessages: 8,
  /** 单条消息内容最多几条 DTO 字段。 */
  maxFields: 64,
  /** 单个字段名最大长度。 */
  maxFieldKeyLength: 128,
  /** 单个字符串值最大 UTF-8 字节数（设计 §4.1：单字符串 16KiB）。 */
  maxValueBytes: 16384,
  /** 序列化后请求体最大字节数（设计 §8.2 第 4 条：出域检查 64KiB）。 */
  maxRequestBytes: 65536,
  /** 提供方响应体最大字节数（设计 §9.2：分析输出 1MiB 硬上限）。 */
  maxResponseBytes: 1048576,
  /** 单次请求 max_tokens 硬上限（设计 §9.1：output_limit <= 2000）。 */
  maxOutputTokens: 2000,
  /** 单请求墙钟上限。 */
  defaultTimeoutMs: 30000,
  /** 排队等待上限：排队时间也计入"一次分析 90 秒"的预算感，不能无界。 */
  queueTimeoutMs: 60000,
  /** 有界排队条数。0 表示完全不排队（满员即拒）。 */
  maxQueueDepth: 32,
  /** 同时进行的真实 provider 请求数（设计 §9.1：最多 2 个分析并发）。 */
  maxConcurrentRequests: 2,
  /** 同一分析同时只允许一个真实请求：worker 是单线程的，出现两个就是调用方出错了。 */
  maxInFlightPerAnalysis: 1,
  /** 每个分析的请求次数上限（设计 §9.1：3 请求）。存储层还有一份独立判定。 */
  maxRequestsPerAnalysis: 3,
  /** 自动重试次数恒为 0：不存在"重试一次"的配置项。 */
  maxRetries: 0,
});

/** 熔断阈值：连续可重试失败次数与打开时长（设计 §9.2）。 */
export const CIRCUIT_POLICY = Object.freeze({
  retryableFailureThreshold: 5,
  openMs: 15 * 60 * 1000,
});

/** 校验调用方传入的上限覆盖：只允许收紧，不允许放宽硬上限。 */
export function resolveLimits(override) {
  if (override === undefined || override === null) return BROKER_LIMITS;
  if (typeof override !== 'object') {
    throw new TypeError('limits override must be an object');
  }
  const merged = { ...BROKER_LIMITS };
  for (const key of Object.keys(override)) {
    if (!Object.hasOwn(BROKER_LIMITS, key)) {
      throw new TypeError(`unknown limit ${key}`);
    }
    const value = override[key];
    // maxRetries 恒为 0：它不是可配置项，任何非 0 值都当配置错误。
    if (key === 'maxRetries') {
      if (value !== 0) throw new TypeError('maxRetries cannot be raised; automatic retry is forbidden');
      continue;
    }
    // maxQueueDepth 允许 0（满员即拒，不排队），其余上限必须为正。
    const minimum = key === 'maxQueueDepth' ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new TypeError(`limit ${key} must be an integer >= ${minimum}`);
    }
    // 收紧合法（测试用极小队列/超时），放宽一律拒绝。
    merged[key] = Math.min(value, BROKER_LIMITS[key]);
  }
  merged.maxRetries = 0;
  return Object.freeze(merged);
}
