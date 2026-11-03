import { ContractError, ERROR_CODES } from '../errors.js';
import { rfc3339Utc, sha256Hex, uuidV4 } from '../fields.js';
import { LIMITS } from '../limits.js';
import { assertClosedObject, buildContractRecord } from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { negotiateSchemaVersion } from '../version.js';

/** 模型请求的生命周期状态：预占 → 发送 → 结算，另有未知与作废两个终态。 */
export const MODEL_REQUEST_STATES = Object.freeze(['reserved', 'sent', 'settled', 'unknown', 'void']);

/*
 * ModelRequest 是"预算已预占的一次模型调用"，不是调用结果。
 *
 * usage 与 state 必须自洽：reserved 还没花掉预算、void 已经退回预算，
 * 这两种状态带 usage 都是账目造假；settled 是唯一必须带 usage 的状态。
 * 这条约束放在合同层，是为了让下游账本不必自己去猜 state 的可信度。
 */

const USAGE_SPEC = Object.freeze({
  input_tokens: { required: true, type: 'integer', min: 0, max: LIMITS.maxSafeInteger },
  output_tokens: { required: true, type: 'integer', min: 0, max: LIMITS.maxSafeInteger },
});

const MODEL_REQUEST_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  request_id: { ...uuidV4, required: true },
  analysis_id: { ...uuidV4, required: true },
  request_seq: { required: true, type: 'integer', min: 1, max: LIMITS.maxRequestIds },
  serialized_digest: { ...sha256Hex, required: true },
  input_upper: { required: true, type: 'integer', min: 1, max: LIMITS.maxInputUpperTokens },
  output_limit: { required: true, type: 'integer', min: 1, max: LIMITS.maxOutputLimitTokens },
  reserved_at: { ...rfc3339Utc, required: true },
  state: { required: true, type: 'string', enum: MODEL_REQUEST_STATES },
  usage: { required: false, nullable: true, type: 'object', fields: USAGE_SPEC },
});

function usageMismatch(path, message, details) {
  throw new ContractError(ERROR_CODES.ERR_USAGE_STATE_MISMATCH, path, message, details);
}

export function validateModelRequest(value, options = {}) {
  const normalized = assertClosedObject(value, MODEL_REQUEST_SPEC, '$', options);
  const hasUsage = normalized.usage !== undefined && normalized.usage !== null;
  if (normalized.state === 'settled' && !hasUsage) {
    usageMismatch('$.usage', 'settled requests must carry usage', { state: normalized.state });
  }
  if (normalized.state === 'reserved' && hasUsage) {
    usageMismatch('$.usage', 'reserved requests must not carry usage', { state: normalized.state });
  }
  if (normalized.state === 'void' && hasUsage) {
    usageMismatch('$.usage', 'void requests must not carry usage', { state: normalized.state });
  }
  return buildContractRecord(normalized);
}

export function parseModelRequest(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateModelRequest(value, options);
}
