/**
 * 预算端口（窄适配器契约）。
 *
 * 设计不变量 4 与任务边界：broker **不复制数据库事务**。它只依赖这 7 个操作，
 * 每个操作对应 event-store 里一个已有的原子函数；
 * 余额公式、epoch 保留、时间高水位、request_seq 唯一性全部留在存储侧。
 *
 * 记住这条分工：`preview` 只用于**给这次调用定尺寸**（算 output_limit），
 * 它不是准入判定。真正的准入是 `reserve` 那一次事务，而且必须在任何网络动作之前。
 * 任何"先 preview 判断够不够、再自己决定发不发"的写法都把原子性退回成 TOCTOU。
 */

import { BrokerError, BROKER_CODES } from './errors.js';

export const BUDGET_PORT_OPERATIONS = Object.freeze([
  'preview',
  'reserve',
  'markSent',
  'settle',
  'markUnknown',
  'settleUnknownAtUpperBound',
  'voidReservation',
]);

/** 启动时校验适配器形状：缺一个操作就不要启动，而不是等到发送路径上才发现。 */
export function assertBudgetPort(port) {
  if (port === null || typeof port !== 'object') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'budget port is required');
  }
  for (const operation of BUDGET_PORT_OPERATIONS) {
    if (typeof port[operation] !== 'function') {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'budget port is missing an operation', { operation });
    }
  }
  return port;
}

/** 校验 preview 的返回形状：适配器违约时立即失败关闭，不带着 NaN 去算预算。 */
export function readPreview(port, analysisId) {
  const preview = port.preview({ analysis_id: analysisId });
  if (preview === null || typeof preview !== 'object') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'budget preview returned no object');
  }
  const fields = [
    'analysis_input_remaining',
    'analysis_output_remaining',
    'daily_input_remaining',
    'daily_output_remaining',
    'requests_used',
    'requests_remaining',
  ];
  const normalized = {};
  for (const field of fields) {
    const value = preview[field];
    if (!Number.isInteger(value)) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'budget preview field is not an integer', { field });
    }
    normalized[field] = value;
  }
  return Object.freeze(normalized);
}
