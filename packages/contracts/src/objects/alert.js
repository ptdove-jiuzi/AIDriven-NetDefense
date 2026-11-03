import { ContractError, ERROR_CODES } from '../errors.js';
import {
  assertTimestampOrder,
  boundedIdentifier,
  opaqueToken,
  rfc3339Utc,
  semanticVersion,
  sha256Hex,
  uuidV4,
} from '../fields.js';
import { LIMITS } from '../limits.js';
import { assertClosedObject, buildContractRecord } from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { negotiateSchemaVersion } from '../version.js';
import { SEVERITY_LEVELS } from './telemetry-event.js';

/** 告警状态词汇：全仓唯一一套，finding 也复用这里。 */
export const ALERT_STATUSES = Object.freeze(['new', 'acknowledged', 'resolved', 'suppressed']);

/*
 * window_start / window_end 是必备字段，不是装饰：
 * 去掉内容派生 ID 之后，告警的唯一 upsert 键是 (fingerprint, window_start)。
 * 这个键必须能在 DTO 内表达出来，否则 event-store 无法幂等写入——
 * 只能靠外部推断窗口起点就等于把幂等性交给了调用方。
 */

const ALERT_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  alert_id: { ...uuidV4, required: true },
  rule_id: { ...boundedIdentifier, required: true },
  rule_version: { ...semanticVersion, required: true },
  fingerprint: { ...sha256Hex, required: true },
  severity: { required: true, type: 'string', enum: SEVERITY_LEVELS },
  status: { required: true, type: 'string', enum: ALERT_STATUSES },
  first_seen: { ...rfc3339Utc, required: true },
  last_seen: { ...rfc3339Utc, required: true },
  window_start: { ...rfc3339Utc, required: true },
  window_end: { ...rfc3339Utc, required: true },
  count: { required: true, type: 'integer', min: 1, max: LIMITS.maxSafeInteger },
  event_ids: {
    required: true,
    type: 'array',
    arrayOf: { ...uuidV4, required: true },
    minItems: 1,
    maxItems: LIMITS.maxArrayItems,
    unique: true,
  },
  event_ids_truncated: { required: true, type: 'boolean' },
  evidence_refs: {
    required: true,
    type: 'array',
    arrayOf: { ...opaqueToken, required: true },
    minItems: 0,
    maxItems: LIMITS.maxArrayItems,
    unique: true,
  },
});

/**
 * 跨字段校验顺序固定：先窗口自身，再观测区间，最后才谈计数口径。
 * 顺序固定意味着同一份坏数据永远报同一个错误码与 path，不会因字段声明顺序漂移。
 */
export function validateAlert(value, options = {}) {
  const normalized = assertClosedObject(value, ALERT_SPEC, '$', options);
  assertTimestampOrder(
    normalized.window_start,
    normalized.window_end,
    '$.window_end',
    'window_start must not be after window_end',
  );
  assertTimestampOrder(
    normalized.first_seen,
    normalized.last_seen,
    '$.last_seen',
    'first_seen must not be after last_seen',
  );
  assertTimestampOrder(
    normalized.window_start,
    normalized.first_seen,
    '$.first_seen',
    'first_seen must not be before window_start',
  );
  assertTimestampOrder(
    normalized.last_seen,
    normalized.window_end,
    '$.last_seen',
    'last_seen must not be after window_end',
  );
  if (normalized.count < normalized.event_ids.length) {
    throw new ContractError(
      ERROR_CODES.ERR_BINDING_MISMATCH,
      '$.count',
      'count must be at least the number of event_ids carried by the alert',
      { count: normalized.count, eventIds: normalized.event_ids.length },
    );
  }
  // 截断标志必须与计数口径自洽：声称截断却一条也没丢，是自相矛盾的 DTO。
  if (normalized.event_ids_truncated === true && normalized.count <= normalized.event_ids.length) {
    throw new ContractError(
      ERROR_CODES.ERR_BINDING_MISMATCH,
      '$.event_ids_truncated',
      'event_ids_truncated requires count to exceed the number of carried event_ids',
      { count: normalized.count, eventIds: normalized.event_ids.length },
    );
  }
  return buildContractRecord(normalized);
}

export function parseAlert(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateAlert(value, options);
}
