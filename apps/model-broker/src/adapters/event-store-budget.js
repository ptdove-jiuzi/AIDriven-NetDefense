/**
 * 预算端口 → event-store 公共接口的适配器。
 *
 * 这里**只做转接和错误归类**：不写 SQL、不开事务、不自己算余额。
 * 每个方法一行调用对应的 event-store 函数，语义完全由存储层决定。
 *
 * 为什么 preview 要遍历 `listRequests`：broker 需要"这次调用还能给多少
 * output_limit"，而每个分析级别的余额只有存储层知道。用公共的
 * `listRequests` + `summarizeBudget` 组合读取，比在 broker 里复刻
 * `SUM(...) WHERE state IN ('reserved','sent','unknown')` 安全得多——
 * 复刻的版本一旦与存储层规则漂移，就是一个静默的预算绕过。
 *
 * 注意：preview 的结果只用于定尺寸和快速失败；**权威判定仍是 reserve**。
 */

import {
  listRequests,
  markModelRequestSent,
  markModelRequestUnknown,
  reserveModelRequest,
  settleModelRequest,
  settleUnknownAtUpperBound,
  summarizeBudget,
  voidModelRequest,
} from '@aegisharness/event-store';

import { BrokerError, BROKER_CODES } from '../errors.js';

/** 这些存储码表示"准入被拒绝"，映射为 broker 的预算拒绝。 */
const BUDGET_STORE_CODES = new Set([
  'ERR_BUDGET_EXCEEDED',
  'ERR_BUDGET_TIME_UNTRUSTED',
  'ERR_CAPACITY_CRITICAL',
  'ERR_EPOCH_MISMATCH',
]);

/** 这些存储码表示"身份/路由不对"，不能混成预算问题。 */
const ROUTE_STORE_CODES = new Set(['ERR_ANALYSIS_NOT_FOUND']);

function mapStoreError(error, operation) {
  if (error instanceof BrokerError) return error;
  const storeCode = error?.name === 'StoreError' && typeof error.code === 'string' ? error.code : null;
  if (storeCode !== null && BUDGET_STORE_CODES.has(storeCode)) {
    return new BrokerError(BROKER_CODES.ERR_BROKER_BUDGET, 'budget admission rejected', {
      store_code: storeCode,
      operation,
    });
  }
  if (storeCode !== null && ROUTE_STORE_CODES.has(storeCode)) {
    return new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'analysis identity is not known to the store', {
      store_code: storeCode,
      operation,
    });
  }
  return new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'budget adapter call failed', {
    store_code: storeCode,
    operation,
    cause_name: typeof error?.name === 'string' ? error.name : null,
  });
}

function call(operation, fn) {
  try {
    return fn();
  } catch (error) {
    throw mapStoreError(error, operation);
  }
}

/**
 * @param {object} store event-store 可写句柄。
 * @param {{ now?: string, actorId?: string, policy?: object }} [options]
 *   `policy` 由 daemon 侧注入（预算上限属策略层，不属 broker）。broker 自身
 *   从不传 policy，因此不存在"worker 通过请求体放宽预算"的路径。
 */
export function createEventStoreBudgetPort(store, options = {}) {
  if (store === null || typeof store !== 'object') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'event-store handle is required');
  }
  const extra = {};
  if (typeof options.now === 'string') extra.now = options.now;
  if (typeof options.actorId === 'string') extra.actorId = options.actorId;
  if (options.policy !== undefined && options.policy !== null) extra.policy = options.policy;

  return Object.freeze({
    preview({ analysis_id: analysisId }) {
      const summary = call('summarizeBudget', () => summarizeBudget(store, extra));
      const policy = summary.policy;
      const rows = call('listRequests', () => listRequests(store, { analysis_id: analysisId }));

      let analysisInflightInput = 0;
      let analysisInflightOutput = 0;
      let analysisSettledInput = 0;
      let analysisSettledOutput = 0;
      for (const row of rows) {
        const state = String(row.state);
        if (state === 'settled') {
          analysisSettledInput += Number(row.settled_input ?? 0);
          analysisSettledOutput += Number(row.settled_output ?? 0);
          continue;
        }
        if (state === 'reserved' || state === 'sent' || state === 'unknown') {
          analysisInflightInput += Number(row.input_upper ?? 0);
          analysisInflightOutput += Number(row.output_limit ?? 0);
        }
      }

      return Object.freeze({
        analysis_input_remaining: policy.perAnalysisInputTokens - analysisSettledInput - analysisInflightInput,
        analysis_output_remaining: policy.perAnalysisOutputTokens - analysisSettledOutput - analysisInflightOutput,
        daily_input_remaining: summary.daily.remaining_input,
        daily_output_remaining: summary.daily.remaining_output,
        requests_used: rows.length,
        requests_remaining: Math.max(0, policy.perAnalysisRequests - rows.length),
      });
    },

    reserve(input) {
      return call('reserveModelRequest', () => reserveModelRequest(store, { ...extra, ...input }));
    },

    markSent(input) {
      return call('markModelRequestSent', () => markModelRequestSent(store, { ...extra, ...input }));
    },

    settle(input) {
      return call('settleModelRequest', () => settleModelRequest(store, { ...extra, ...input }));
    },

    markUnknown(input) {
      return call('markModelRequestUnknown', () => markModelRequestUnknown(store, { ...extra, ...input }));
    },

    settleUnknownAtUpperBound(input) {
      return call('settleUnknownAtUpperBound', () => settleUnknownAtUpperBound(store, { ...extra, ...input }));
    },

    voidReservation(input) {
      // `provedNotSent` 必须由 broker 显式给出；这里不做默认值填充。
      return call('voidModelRequest', () => voidModelRequest(store, { ...extra, ...input }));
    },
  });
}
