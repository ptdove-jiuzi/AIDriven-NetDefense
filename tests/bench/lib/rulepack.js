/**
 * lib/rulepack.js — 生成用于基准的规则包。
 *
 * 规则包是 detection 的输入之一，它的形状直接决定吞吐：condition 规则单事件即判，
 * threshold 规则要维护窗口，correlation 规则要维护槽位。所以基准必须**分别**报告
 * 不同类型规则的量，而不是混成一个"events/s"。
 *
 * 这些规则只匹配 `example-*` / `synthetic-*` 假进程名，不含任何真实检测语义，
 * 也不宣称能检出任何真实威胁——它们只是负载。
 */

import { PROCESS_NAMES, USER_NAMES } from './synthetic.js';
import { createRng, deriveSeed } from './prng.js';

/**
 * 生成一个 condition 规则，匹配指定进程名。
 *
 * @param {number} ordinal 序号。
 * @param {string} processName 目标进程名。
 * @returns {object} 规则。
 */
function conditionRule(ordinal, processName) {
  const id = String(ordinal).padStart(2, '0');
  return {
    ruleId: `bench.condition.${id}`,
    version: '1.0.0',
    type: 'condition',
    severity: ordinal % 2 === 0 ? 'high' : 'medium',
    fields: ['process.name', 'user.name', 'process.path', 'network.remoteAddress'],
    fingerprint: ['process.name'],
    when: { field: 'process.name', operator: 'eq', value: processName },
  };
}

/**
 * 生成一个 threshold 规则：同名进程在窗口内出现 N 次即告警。
 *
 * @param {number} ordinal 序号。
 * @param {string} processName 目标进程名。
 * @param {{windowMs?: number, count?: number}} [options] 窗口与阈值。
 * @returns {object} 规则。
 */
function thresholdRule(ordinal, processName, options = {}) {
  const id = String(ordinal).padStart(2, '0');
  return {
    ruleId: `bench.threshold.${id}`,
    version: '1.0.0',
    type: 'threshold',
    severity: 'medium',
    fields: ['process.name'],
    groupBy: ['process.name'],
    count: { operator: 'gte', value: options.count ?? 3 },
    windowMs: options.windowMs ?? 60000,
  };
}

/**
 * 生成一个两步关联规则：同名进程后紧跟一次出网。
 *
 * @param {number} ordinal 序号。
 * @param {string} firstProcess 第一步匹配的进程名。
 * @param {string} secondProcess 第二步匹配的进程名。
 * @param {number} [withinMs] 关联窗口。
 * @returns {object} 规则。
 */
function correlationRule(ordinal, firstProcess, secondProcess, withinMs = 60000) {
  const id = String(ordinal).padStart(2, '0');
  return {
    ruleId: `bench.correlation.${id}`,
    version: '1.0.0',
    type: 'correlation',
    severity: 'high',
    fields: ['process.name', 'user.name'],
    groupBy: ['user.name'],
    withinMs,
    steps: [
      { name: 'spawn', when: { field: 'process.name', operator: 'eq', value: firstProcess } },
      { name: 'egress', when: { field: 'process.name', operator: 'eq', value: secondProcess } },
    ],
  };
}

/**
 * 构造基准规则包。
 *
 * @param {{seed: number, conditions?: number, thresholds?: number, correlations?: number}} options
 *   选项；默认 12 条 condition + 2 条 threshold + 1 条 correlation，接近小规则集的真实形态。
 * @returns {{pack: object, composition: {conditions: number, thresholds: number, correlations: number, total: number}}}
 *   规则包与构成统计（构成必须进报告，否则"60 条规则"无法解释吞吐差异）。
 */
export function makeBenchRulePack(options) {
  const rng = createRng(deriveSeed(options.seed, 'bench-rulepack'));
  const conditions = options.conditions ?? 12;
  const thresholds = options.thresholds ?? 2;
  const correlations = options.correlations ?? 1;
  const rules = [];

  for (let ordinal = 0; ordinal < conditions; ordinal += 1) {
    // 轮转假进程名，保证每条规则都能被负载命中，而不是造一堆永不匹配的死规则。
    rules.push(conditionRule(ordinal, PROCESS_NAMES[ordinal % PROCESS_NAMES.length]));
  }
  for (let ordinal = 0; ordinal < thresholds; ordinal += 1) {
    rules.push(thresholdRule(ordinal, PROCESS_NAMES[ordinal % PROCESS_NAMES.length], {
      windowMs: 60000,
      count: 3,
    }));
  }
  for (let ordinal = 0; ordinal < correlations; ordinal += 1) {
    rules.push(correlationRule(
      ordinal,
      PROCESS_NAMES[ordinal % PROCESS_NAMES.length],
      PROCESS_NAMES[(ordinal + 1) % PROCESS_NAMES.length],
    ));
  }

  // allowlist 留空：基准不测 allowlist 过期，空表路径固定，不会与规则评估相互干扰。
  // 用 rng 只为让"包内容由种子决定"这句话在代码里成立——本函数目前不需要随机性，
  // 但保留 seed 依赖，未来加随机规则序时不会改变既有标签语义。
  void rng;
  void USER_NAMES;

  return {
    pack: {
      schemaVersion: '1.0',
      packId: 'bench-pack',
      packVersion: '1.0.0',
      rules,
    },
    composition: {
      conditions,
      thresholds,
      correlations,
      total: rules.length,
    },
  };
}
