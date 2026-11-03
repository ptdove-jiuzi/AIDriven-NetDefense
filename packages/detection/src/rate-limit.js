/**
 * rate-limit.js — per-fingerprint hourly analysis request budget.
 *
 * Decision order is fixed: severity gate, idempotency, global gate, hourly
 * counter. Only released requests consume the hourly budget, so a denial can be
 * retried inside the same hour without silently losing the attempt.
 *
 * ## One bucket per hour, and a bucket is never reset backwards
 *
 * The first implementation kept a single `{ hourStart, count, released }` triple
 * and reset it whenever `hourStartFor(at)` differed from the stored value. That
 * looks equivalent to bucketing until `at` moves backwards: an event at 13:10,
 * then 13:05, then 13:10 again reset the counters twice, and the third event
 * re-minted an idempotency key that had already been released in hour 13 (with a
 * fresh `requestId` — the same key, two requests). Late events and clock
 * regressions are normal in a store-and-forward pipeline, so the state is now a
 * bounded map of hour buckets: going back to a spent hour reaches that hour's
 * own counter, and a released key is remembered globally so it can never be
 * minted twice.
 */

import { shortHash } from './canonical.js';
import { DetectionConfigError } from './errors.js';
import { createRandomIdFactory, isUuidV4 } from './ids.js';
import { severityRank } from './severity.js';
import { DEFAULT_SUMMARY_FIELDS, SUMMARY_CLASSIFICATION } from './summary-contract.js';

/** Length of one rate limit bucket in milliseconds. */
export const HOUR_MS = 3600000;

/**
 * Hour buckets retained per fingerprint, least recently used first.
 *
 * Six hours covers the aggregation window plus late events without letting the
 * per-fingerprint state grow with uptime.
 *
 * @type {number}
 */
export const RATE_BUCKETS_RETAINED = 6;

/**
 * Released request keys remembered per fingerprint, oldest evicted first.
 *
 * This is the backstop for a bucket that fell out of {@link RATE_BUCKETS_RETAINED}:
 * with at most 1000 releases per hour (`analysisPerFingerprintPerHour` ceiling)
 * the set covers several hours of full-rate traffic, so the same key cannot be
 * minted twice in practice.
 *
 * @type {number}
 */
export const RATE_KEYS_RETAINED = 4096;

/**
 * Start of the hour bucket that contains an instant, aligned to UTC.
 *
 * @param {number} at Epoch milliseconds.
 * @returns {number} Bucket start in epoch milliseconds.
 */
export function hourStartFor(at) {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/**
 * Create an empty per-fingerprint rate state.
 *
 * `hourStart`/`count`/`released` mirror the bucket touched last, so callers and
 * tests can inspect "the current hour" without reaching into `buckets`.
 *
 * @returns {{
 *   hourStart: number | null,
 *   count: number,
 *   released: Set<string>,
 *   buckets: Map<number, { count: number, released: Set<string> }>,
 *   minted: Set<string>
 * }} Mutable rate state.
 */
export function createRateState() {
  return {
    hourStart: null,
    count: 0,
    released: new Set(),
    buckets: new Map(),
    minted: new Set(),
  };
}

/**
 * Resolve (and create) the bucket of one hour, keeping the map bounded.
 *
 * Recency is tracked by Map insertion order: a touched bucket is moved to the
 * end, and eviction removes from the front. Touching an old hour therefore never
 * evicts a newer one.
 *
 * @param {object} state Rate state from {@link createRateState}.
 * @param {number} hourStart Bucket key.
 * @returns {{ count: number, released: Set<string> }} Bucket record.
 */
function bucketFor(state, hourStart) {
  if (!(state.buckets instanceof Map)) {
    state.buckets = new Map();
  }
  if (!(state.minted instanceof Set)) {
    state.minted = new Set();
  }
  let bucket = state.buckets.get(hourStart);
  if (bucket === undefined) {
    bucket = { count: 0, released: new Set() };
  } else {
    state.buckets.delete(hourStart);
  }
  state.buckets.set(hourStart, bucket);
  while (state.buckets.size > RATE_BUCKETS_RETAINED) {
    state.buckets.delete(state.buckets.keys().next().value);
  }
  state.hourStart = hourStart;
  state.count = bucket.count;
  state.released = bucket.released;
  return bucket;
}

/**
 * Attempt to release one analysis request for an alert.
 *
 * @param {{
 *   alert: object,
 *   alertView: object,
 *   fingerprint: string,
 *   ruleId: string,
 *   at: number,
 *   rateState: object,
 *   limits: { analysisPerFingerprintPerHour: number, analysisMinSeverity: string },
 *   gate?: (alert: object, context: object) => boolean,
 *   nextId?: (kind: string) => string
 * }} input Request context.
 * @returns {{
 *   status: 'skipped' | 'deduplicated' | 'denied' | 'released',
 *   reason?: string,
 *   requestKey?: string,
 *   request?: object,
 *   denial?: object
 * }} Decision. `denial` matches the `analysisDenied` entry shape.
 */
export function requestAnalysis(input) {
  const { alert, alertView: view, fingerprint, ruleId, at, rateState, limits, gate } = input;
  if (severityRank(alert.severity) < severityRank(limits.analysisMinSeverity)) {
    return { status: 'skipped', reason: 'below-min-severity' };
  }
  if (alert.status === 'suppressed') {
    return { status: 'skipped', reason: 'alert-suppressed' };
  }
  // 记账按目标小时取桶：回退到已经花掉配额的小时，读到的是那个小时的计数，
  // 而不是一个被清零的新桶（审查 P1-2 的实测复现）。
  const hourStart = hourStartFor(at);
  const bucket = bucketFor(rateState, hourStart);
  const requestKey = shortHash(`${fingerprint}|${hourStart}|${alert.severity}`, 32);
  if (bucket.released.has(requestKey) || rateState.minted.has(requestKey)) {
    return { status: 'deduplicated', requestKey };
  }
  if (gate !== undefined) {
    let allowed = false;
    try {
      allowed = gate(view, { at, fingerprint, ruleId, requestKey, hourStart }) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return {
        status: 'denied',
        requestKey,
        denial: { fingerprint, hourStart, severity: alert.severity, reason: 'global-budget', at },
      };
    }
  }
  if (bucket.count >= limits.analysisPerFingerprintPerHour) {
    return {
      status: 'denied',
      requestKey,
      denial: { fingerprint, hourStart, severity: alert.severity, reason: 'fingerprint-hourly-limit', at },
    };
  }
  // 先把所有可能失败的步骤做完，再一次性提交：取号、形状校验、summary 字段装配
  // 都可能抛错，而 count / released 一旦加进去就是不可逆的。
  const nextId = input.nextId === undefined ? createRandomIdFactory().next : input.nextId;
  const requestId = nextId('analysis-request');
  // requestAnalysis 是导出 API，调用方可以直接塞一个裸 nextId；这里补一次形状校验，
  // 避免不合规的 id 一路走到 DTO 才在契约校验处失败（错误归因会更远）。
  if (!isUuidV4(requestId)) {
    throw new DetectionConfigError('id factory must return a canonical UUIDv4', {
      path: 'ids',
      detail: { kind: 'analysis-request' },
    });
  }
  const sequenceInHour = bucket.count + 1;
  // summaryDto 只在这里构造一次：分类与字段名都取自 summary-contract 的常量，
  // 避免两处硬编码各自漂移（审查 P2-4）。字段值必须为每个已声明字段都提供，
  // 缺一个就抛错而不是静默丢弃——否则 DEFAULT_SUMMARY_FIELDS 增键时会悄悄少字段（P2-6）。
  // 这段刻意放在记账之前：它也会抛错，放在后面就会"吃掉配额又没发出请求"。
  const summaryValues = {
    sequence_in_hour: sequenceInHour,
    severity_rank: severityRank(alert.severity),
    alert_count: alert.count,
    rule_type: alert.ruleType,
  };
  const summaryFields = {};
  for (const name of DEFAULT_SUMMARY_FIELDS) {
    if (summaryValues[name] === undefined) {
      throw new DetectionConfigError(
        `summary field ${name} has no value provider in rate-limit.js`,
        { path: 'summaryDto.fields', detail: { field: name } },
      );
    }
    summaryFields[name] = summaryValues[name];
  }
  // 到这里不会再失败，才提交配额与去重集合。去重集合同时记进全局 minted：
  // 小时桶被 LRU 淘汰后，同一 key 也不会被重新铸造（审查 P1-2 的第二条目标）。
  bucket.count = sequenceInHour;
  bucket.released.add(requestKey);
  rateState.count = sequenceInHour;
  rateState.minted.add(requestKey);
  while (rateState.minted.size > RATE_KEYS_RETAINED) {
    rateState.minted.delete(rateState.minted.values().next().value);
  }
  return {
    status: 'released',
    requestKey,
    request: {
      requestId,
      requestKey,
      alertId: alert.alertId,
      fingerprint,
      ruleId,
      severity: alert.severity,
      hourStart,
      createdAt: at,
      budgetClass: 'standard',
      sequenceInHour,
      idempotencyKey: requestKey,
      summaryDto: {
        classification: SUMMARY_CLASSIFICATION,
        fields: summaryFields,
      },
    },
  };
}
