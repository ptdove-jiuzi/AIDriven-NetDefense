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
import { ALERT_STATUSES } from './alert.js';

/*
 * Finding 是"一条规则在一次聚合窗口内的判定结果"，Alert 是它的聚合视图。
 *
 * 两者共用同一套 severity 与 status 词汇：severity 直接复用 telemetry-event.js
 * 的 SEVERITY_LEVELS，status 直接复用 alert.js 的 ALERT_STATUSES。这里刻意不建
 * 第二套枚举——两套同义枚举一旦漂移，聚合层就会把 finding 静默丢出告警。
 */

const FINDING_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  finding_id: { ...uuidV4, required: true },
  rule_id: { ...boundedIdentifier, required: true },
  rule_version: { ...semanticVersion, required: true },
  event_ids: {
    required: true,
    type: 'array',
    arrayOf: { ...uuidV4, required: true },
    minItems: 1,
    maxItems: LIMITS.maxArrayItems,
    unique: true,
  },
  fingerprint: { ...sha256Hex, required: true },
  severity: { required: true, type: 'string', enum: SEVERITY_LEVELS },
  status: { required: true, type: 'string', enum: ALERT_STATUSES },
  first_seen: { ...rfc3339Utc, required: true },
  last_seen: { ...rfc3339Utc, required: true },
  count: { required: true, type: 'integer', min: 1, max: LIMITS.maxSafeInteger },
  evidence_refs: {
    required: true,
    type: 'array',
    arrayOf: { ...opaqueToken, required: true },
    minItems: 0,
    maxItems: LIMITS.maxArrayItems,
    unique: true,
  },
});

export function validateFinding(value, options = {}) {
  const normalized = assertClosedObject(value, FINDING_SPEC, '$', options);
  assertTimestampOrder(
    normalized.first_seen,
    normalized.last_seen,
    '$.last_seen',
    'first_seen must not be after last_seen',
  );
  // event_ids 允许被截断，但截断后的条数不得多于 count：否则 DTO 自相矛盾。
  if (normalized.count < normalized.event_ids.length) {
    throw new ContractError(
      ERROR_CODES.ERR_BINDING_MISMATCH,
      '$.count',
      'count must be at least the number of event_ids carried by the finding',
      { count: normalized.count, eventIds: normalized.event_ids.length },
    );
  }
  return buildContractRecord(normalized);
}

export function parseFinding(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateFinding(value, options);
}
