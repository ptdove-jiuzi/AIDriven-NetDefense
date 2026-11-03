import { opaqueToken, rfc3339Utc, sha256Hex, summaryFieldName, uuidV4 } from '../fields.js';
import { LIMITS } from '../limits.js';
import { assertClosedObject, buildContractRecord } from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { negotiateSchemaVersion } from '../version.js';

/*
 * EvidenceRef 是"可被分析器读取的证据句柄"，不是证据本身：
 * - evidence_id 是高熵不透明令牌，不可遍历，猜不出来也走不通；
 * - allowed_fields 是**白名单**，只有列出的 summary 字段允许出域；
 * - expires_at + max_bytes 把一次读取的时效与体量都钉死。
 *
 * 本合同只描述句柄形状，不携带任何证据内容，也不提供"读取"入口。
 * evidence_id 刻意不用 boundedIdentifier：可读标识符天生可枚举，
 * 与"高熵不可遍历"的要求正好相反。
 */

const EVIDENCE_REF_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  evidence_id: { ...opaqueToken, required: true },
  analysis_id: { ...uuidV4, required: true },
  alert_id: { ...uuidV4, required: true },
  allowed_fields: {
    required: true,
    type: 'array',
    arrayOf: { ...summaryFieldName, required: true },
    minItems: 1,
    maxItems: LIMITS.maxEvidenceFields,
    unique: true,
  },
  expires_at: { ...rfc3339Utc, required: true },
  max_bytes: { required: true, type: 'integer', min: 1, max: LIMITS.maxToolResultBytes },
  digest: { ...sha256Hex, required: true },
});

/** allowed_fields 至少一项：空白名单等于"给了句柄却什么都读不到"，应当直接拒绝。 */
export function validateEvidenceRef(value, options = {}) {
  const normalized = assertClosedObject(value, EVIDENCE_REF_SPEC, '$', options);
  return buildContractRecord(normalized);
}

export function parseEvidenceRef(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateEvidenceRef(value, options);
}
