/**
 * 每端点日预算端口（ADR-0010 §2.1、§2.5 第 5 条、§6 第 2 项）。
 *
 * 为什么需要它：区域预算（全局日预算、单分析预算）回答不了"**这个 provider** 今天还能花多少"。
 * 只有全局预算时，管理员在 provider 上写的 `dailyInputTokens` 无处落地——那正是审查 P1-1 的
 * fail-open：配置写了上限，代码不报错也不执行。
 *
 * 分工（与 `budget-port.js` 保持一致的心智模型）：
 * - `read` 只用于**定尺寸与快速失败**，它不是准入判定；
 * - `reserve` 是唯一权威准入，且必须在任何网络动作之前；
 * - 预留之后只可能有三种结局：`settle`（有真实用量）、`settleUnknownAtUpperBound`（结果未知）、
 *   `voidReservation`（能证明没发出去）。**不存在"发失败了就退额度"**——那等于允许无限免费重发。
 *
 * 记账口径是"预留 / 已花"两段求和（与设计 §9.1 的 reserved/sent/unknown 上界口径同构）：
 *   已用 = 已花 + 预留
 * 这样并发时不会因为"还没结算"而多放额度。
 *
 * 本地模型（回环）**没有**自动豁免：`endpoint.js` 在注册期只把"缺省 / null"归一成 `null`
 * （不设端点级上限），用户显式写的数字（含 `0`）原样冻结。因此"回环 + 数字上限"这个组合
 * 是存在的，而且必须存在——ADR §2.6 的「回环调用不计费」讲的是账单，不是上限可以被忽略。
 * 注意 `deploy/config/model-routing.example.json` 给 `ollama-local` 写了
 * `dailyInputTokens: 0`，按本语义等于"本地模型零额度"，是该配置文件自身的缺陷
 * （`deploy/**` 不在本任务写权限内，已登记在 `docs/implementation/status/MODEL-ROUTING-FIX2.md`）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { BrokerError, BROKER_CODES } from './errors.js';

/** 端口必须实现的 6 个操作（缺一个就不要启动）。 */
export const PROVIDER_BUDGET_OPERATIONS = Object.freeze([
  'register',
  'read',
  'reserve',
  'settle',
  'settleUnknownAtUpperBound',
  'voidReservation',
]);

/** 一天。日预算按 UTC 日切分（与设计 §9.1 的 UTC 日预算一致）。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 启动期校验端口形状：缺操作立刻失败，而不是等到发送路径上才发现。
 *
 * @param {unknown} port 候选端口。
 * @returns {object} 原端口（便于链式使用）。
 */
export function assertProviderBudgetPort(port) {
  if (port === null || typeof port !== 'object') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'provider budget port is required');
  }
  for (const operation of PROVIDER_BUDGET_OPERATIONS) {
    if (typeof port[operation] !== 'function') {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'provider budget port is missing an operation', {
        operation,
      });
    }
  }
  return port;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function utcDay(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function emptyBucket() {
  return { input_spent: 0, output_spent: 0, input_reserved: 0, output_reserved: 0 };
}

function adapterError(message, details) {
  return new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, message, details);
}

/**
 * 进程内账本（默认实现）。
 *
 * 生产上若需要跨进程重启保留，注入一个同形状的持久化端口即可；本实现不假装能持久化。
 *
 * @param {{ now?: () => number, keepDays?: number }} [options]
 */
export function createProviderBudgetLedger(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const keepDays = Number.isInteger(options.keepDays) && options.keepDays >= 1 ? options.keepDays : 2;

  /** @type {Map<string, {dailyInputTokens: number|null, dailyOutputTokens: number|null}>} */
  const limits = new Map();
  /** @type {Map<string, ReturnType<typeof emptyBucket>>} key = `${day}|${providerId}` */
  const buckets = new Map();
  /** @type {Map<string, {provider_id: string, day: string, input_upper: number, output_limit: number}>} */
  const rows = new Map();

  /**
   * R5-006：可选的文件快照。不给 `filePath` 时行为与旧版完全一致（纯进程内），
   * 但返回值里的 `persistent:false` 把"重启即归零"从隐含事实变成可断言的降级声称。
   * 给了 `filePath` 时，每次变更同步落盘、构造时恢复，重启后仍强制执行日预算。
   */
  const filePath = typeof options.filePath === 'string' && options.filePath.trim() !== ''
    ? path.resolve(options.filePath.trim())
    : null;

  function loadSnapshot() {
    if (filePath === null) return;
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw adapterError('provider budget snapshot could not be read', { step: 'load' });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 损坏的快照不能静默当成"没有预算"（那等于额度全量放开）→ fail-closed 拒绝启动。
      throw adapterError('provider budget snapshot is not valid JSON', { step: 'load' });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw adapterError('provider budget snapshot has an unknown shape', { step: 'load' });
    }
    for (const entry of Array.isArray(parsed.limits) ? parsed.limits : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [providerId, limit] = entry;
      if (typeof providerId !== 'string' || limit === null || typeof limit !== 'object') continue;
      const input = limit.dailyInputTokens ?? null;
      const output = limit.dailyOutputTokens ?? null;
      if (input !== null && !isNonNegativeInteger(input)) continue;
      if (output !== null && !isNonNegativeInteger(output)) continue;
      limits.set(providerId, { dailyInputTokens: input, dailyOutputTokens: output });
    }
    for (const entry of Array.isArray(parsed.buckets) ? parsed.buckets : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, bucket] = entry;
      if (typeof key !== 'string' || bucket === null || typeof bucket !== 'object') continue;
      const restored = emptyBucket();
      let valid = true;
      for (const field of Object.keys(restored)) {
        if (!isNonNegativeInteger(bucket[field])) {
          valid = false;
          break;
        }
        restored[field] = bucket[field];
      }
      if (valid) buckets.set(key, restored);
    }
    for (const entry of Array.isArray(parsed.rows) ? parsed.rows : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [requestId, row] = entry;
      if (typeof requestId !== 'string' || row === null || typeof row !== 'object') continue;
      if (typeof row.provider_id !== 'string' || typeof row.day !== 'string') continue;
      if (!isNonNegativeInteger(row.input_upper) || !isNonNegativeInteger(row.output_limit)) continue;
      rows.set(requestId, {
        provider_id: row.provider_id,
        day: row.day,
        input_upper: row.input_upper,
        output_limit: row.output_limit,
      });
    }
  }

  function saveSnapshot() {
    if (filePath === null) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        limits: [...limits.entries()],
        buckets: [...buckets.entries()],
        rows: [...rows.entries()],
      }), { mode: 0o600 });
    } catch {
      // 落盘失败 = 无法证明预算会被跨重启执行 → fail-closed，不让请求继续。
      throw adapterError('provider budget snapshot could not be written', { step: 'save' });
    }
  }

  function bucketOf(day, providerId) {
    const key = `${day}|${providerId}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = emptyBucket();
      buckets.set(key, bucket);
    }
    return bucket;
  }

  /** 丢掉过期日桶：账本不能因为"跑了很多天"而变成内存泄漏。 */
  function prune(today) {
    if (buckets.size <= keepDays * 8) return;
    const keep = new Set();
    for (let offset = 0; offset < keepDays; offset += 1) keep.add(utcDay(now() - offset * DAY_MS));
    for (const key of buckets.keys()) {
      const day = key.slice(0, 10);
      if (!keep.has(day) && day !== today) buckets.delete(key);
    }
  }

  /**
   * R5-011：释放一笔预留时不得把 `*_reserved` 减成负数。
   *
   * 正常路径上桶一定存在且 reserved >= 该笔预留；但 `prune()` 会删掉过期日桶，
   * 之后结清一笔旧日预留时 `bucketOf()` 会**重建**一个空桶（reserved=0），
   * 直接减就留下 `input_reserved=-400` 的脏记账。净额虽为零（spent 同步 +400），
   * 但"预留为负"会让任何按 reserved 求和的审计口径失真，因此在此钳到 0。
   */
  function releaseReserved(bucket, row) {
    bucket.input_reserved = Math.max(0, bucket.input_reserved - row.input_upper);
    bucket.output_reserved = Math.max(0, bucket.output_reserved - row.output_limit);
  }

  function limitsOf(providerId) {
    const entry = limits.get(providerId);
    if (entry === undefined) {
      throw adapterError('provider budget was not registered for this provider', { provider_id: providerId });
    }
    return entry;
  }

  loadSnapshot();

  return Object.freeze({
    /** R5-006：persistent:false = 重启即归零的明确降级声称；给了 filePath 才是 true。 */
    persistent: filePath !== null,
    storage: filePath === null ? 'memory' : 'file',

    /**
     * 登记某 provider 的上限。由 broker 在**构造期**用它读到的 brand 调用，
     * 因此运行期不存在"请求体里改上限"的路径。
     */
    register(providerId, limit) {
      if (typeof providerId !== 'string' || providerId === '') {
        throw adapterError('provider id must be a non-empty string', { field: 'provider_id' });
      }
      const input = limit?.dailyInputTokens ?? null;
      const output = limit?.dailyOutputTokens ?? null;
      for (const [field, value] of [['dailyInputTokens', input], ['dailyOutputTokens', output]]) {
        if (value !== null && !isNonNegativeInteger(value)) {
          throw adapterError('provider daily budget must be null or a non-negative integer', { field });
        }
      }
      limits.set(providerId, { dailyInputTokens: input, dailyOutputTokens: output });
      saveSnapshot();
      return this;
    },

    /** 余额快照。`*_remaining` 为 `null` 表示该 provider 没有端点级上限（继承全局）。 */
    read(providerId) {
      const limit = limitsOf(providerId);
      const day = utcDay(now());
      const bucket = bucketOf(day, providerId);
      const remaining = (cap, spent, reserved) => (cap === null ? null : Math.max(0, cap - spent - reserved));
      return Object.freeze({
        day,
        input_limit: limit.dailyInputTokens,
        output_limit: limit.dailyOutputTokens,
        input_spent: bucket.input_spent,
        output_spent: bucket.output_spent,
        input_reserved: bucket.input_reserved,
        output_reserved: bucket.output_reserved,
        input_remaining: remaining(limit.dailyInputTokens, bucket.input_spent, bucket.input_reserved),
        output_remaining: remaining(limit.dailyOutputTokens, bucket.output_spent, bucket.output_reserved),
      });
    },

    /** 权威准入：不足即抛 `ERR_BROKER_BUDGET`，调用方必须在任何网络动作之前调用它。 */
    reserve(input) {
      const providerId = input?.provider_id;
      const requestId = input?.request_id;
      const limit = limitsOf(providerId);
      if (typeof requestId !== 'string' || requestId === '') {
        throw adapterError('provider reservation requires a request id', { field: 'request_id' });
      }
      if (rows.has(requestId)) {
        throw adapterError('provider reservation request id is reused', { request_id: requestId });
      }
      if (!isNonNegativeInteger(input.input_upper) || !isNonNegativeInteger(input.output_limit)) {
        throw adapterError('provider reservation requires integer ceilings', { request_id: requestId });
      }
      const day = utcDay(now());
      const bucket = bucketOf(day, providerId);
      const check = (cap, spent, reserved, requested, reason) => {
        if (cap === null) return;
        if (spent + reserved + requested > cap) {
          throw new BrokerError(BROKER_CODES.ERR_BROKER_BUDGET, 'provider daily token budget is exhausted', {
            reason,
            provider_id: providerId,
            remaining: Math.max(0, cap - spent - reserved),
            requested,
            day,
          });
        }
      };
      check(limit.dailyInputTokens, bucket.input_spent, bucket.input_reserved, input.input_upper, 'provider_daily_input');
      check(limit.dailyOutputTokens, bucket.output_spent, bucket.output_reserved, input.output_limit, 'provider_daily_output');
      bucket.input_reserved += input.input_upper;
      bucket.output_reserved += input.output_limit;
      rows.set(requestId, {
        provider_id: providerId,
        day,
        input_upper: input.input_upper,
        output_limit: input.output_limit,
      });
      prune(day);
      saveSnapshot();
      return Object.freeze({ provider_id: providerId, day });
    },

    /** 真实用量结算：预留转已花。用量可能超过预留（提供方少报/多报），多出的部分照样计入。 */
    settle(input) {
      const row = rows.get(input?.request_id);
      if (row === undefined) {
        throw adapterError('no provider reservation for this request', { request_id: input?.request_id ?? null });
      }
      const usage = input.usage ?? {};
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens;
      if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens)) {
        throw adapterError('provider usage must be non-negative integers', { request_id: input.request_id });
      }
      const bucket = bucketOf(row.day, row.provider_id);
      releaseReserved(bucket, row);
      bucket.input_spent += inputTokens;
      bucket.output_spent += outputTokens;
      rows.delete(input.request_id);
      saveSnapshot();
      return Object.freeze({ provider_id: row.provider_id, day: row.day });
    },

    /** 结果未知：按预留上界结清（宁可多扣，不可少扣）。 */
    settleUnknownAtUpperBound(input) {
      const row = rows.get(input?.request_id);
      if (row === undefined) {
        throw adapterError('no provider reservation for this request', { request_id: input?.request_id ?? null });
      }
      const bucket = bucketOf(row.day, row.provider_id);
      releaseReserved(bucket, row);
      bucket.input_spent += row.input_upper;
      bucket.output_spent += row.output_limit;
      rows.delete(input.request_id);
      saveSnapshot();
      return Object.freeze({ provider_id: row.provider_id, day: row.day });
    },

    /** 能证明没发出去：释放预留（不是"退款"，预留从未变成已花）。 */
    voidReservation(input) {
      const row = rows.get(input?.request_id);
      if (row === undefined) {
        throw adapterError('no provider reservation for this request', { request_id: input?.request_id ?? null });
      }
      const bucket = bucketOf(row.day, row.provider_id);
      releaseReserved(bucket, row);
      rows.delete(input.request_id);
      saveSnapshot();
      return Object.freeze({ provider_id: row.provider_id, day: row.day });
    },
  });
}
