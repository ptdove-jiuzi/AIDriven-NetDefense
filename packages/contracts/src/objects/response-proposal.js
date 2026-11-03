import { canonicalSize } from '../canonical.js';
import { ContractError, ERROR_CODES } from '../errors.js';
import { dottedIdentifier, opaqueToken, rfc3339Utc, sha256Hex, uuidV4 } from '../fields.js';
import { LIMITS } from '../limits.js';
import { assertClosedObject, buildContractRecord } from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { negotiateSchemaVersion } from '../version.js';

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const TARGET_KINDS = Object.freeze(['process', 'network', 'file']);

/**
 * normalized_target 只承载平台适配器解析后的规范化目标身份。
 * 原始路径 / 原始命令只允许本地展示，不得进入 DTO：出现即 ERR_UNKNOWN_FIELD。
 */
const NORMALIZED_TARGET_SPEC = Object.freeze({
  target_kind: { required: true, type: 'string', enum: TARGET_KINDS },
  digest: { ...sha256Hex, required: true },
  object_id: { ...opaqueToken, required: true },
});

const RESPONSE_PROPOSAL_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  proposal_id: { ...uuidV4, required: true },
  analysis_id: { ...uuidV4, required: true },
  action_id: { ...dottedIdentifier, required: true },
  normalized_target: { required: true, type: 'object', fields: NORMALIZED_TARGET_SPEC },
  justification_evidence: {
    required: true,
    type: 'array',
    arrayOf: { ...uuidV4, required: true },
    minItems: 1,
    maxItems: LIMITS.maxArrayItems,
    unique: true,
  },
  risk: { required: true, type: 'string', enum: RISK_LEVELS },
  expires_at: { ...rfc3339Utc, required: true },
});

/** 仅待审批：不含任何审批态、签名或授权字段。 */
export function validateResponseProposal(value, options = {}) {
  const normalized = assertClosedObject(value, RESPONSE_PROPOSAL_SPEC, '$', options);
  if (canonicalSize(normalized) > LIMITS.maxPayloadBytes) {
    throw new ContractError(
      ERROR_CODES.ERR_OBJECT_TOO_LARGE,
      '$',
      `Proposal exceeds ${LIMITS.maxPayloadBytes} canonical bytes`,
    );
  }
  return buildContractRecord(normalized);
}

export function parseResponseProposal(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateResponseProposal(value, options);
}
