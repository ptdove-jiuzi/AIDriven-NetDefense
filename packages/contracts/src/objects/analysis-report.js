import { canonicalSize } from '../canonical.js';
import { ContractError, ERROR_CODES } from '../errors.js';
import { boundedIdentifier, uuidV4 } from '../fields.js';
import { LIMITS } from '../limits.js';
import { assertClosedObject, buildContractRecord } from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { negotiateSchemaVersion } from '../version.js';

const MODEL_META_SPEC = Object.freeze({
  provider_id: { ...boundedIdentifier, required: true },
  model_id: { ...boundedIdentifier, required: true },
  request_ids: {
    required: true,
    type: 'array',
    arrayOf: { ...uuidV4, required: true },
    minItems: 0,
    maxItems: LIMITS.maxRequestIds,
    unique: true,
  },
});

const ANALYSIS_REPORT_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  analysis_id: { ...uuidV4, required: true },
  summary: { required: true, type: 'string', maxBytes: LIMITS.maxStringBytes },
  confidence: { required: true, type: 'number', min: 0, max: 1 },
  evidence_ids: {
    required: true,
    type: 'array',
    arrayOf: { ...uuidV4, required: true },
    minItems: 0,
    maxItems: LIMITS.maxArrayItems,
    unique: true,
  },
  limitations: {
    required: true,
    type: 'array',
    arrayOf: { required: true, type: 'string', maxBytes: 4096 },
    minItems: 0,
    maxItems: 32,
  },
  model_meta: { required: true, type: 'object', fields: MODEL_META_SPEC },
});

export function validateAnalysisReport(value, options = {}) {
  const normalized = assertClosedObject(value, ANALYSIS_REPORT_SPEC, '$', options);
  if (canonicalSize(normalized) > LIMITS.maxReportBytes) {
    throw new ContractError(
      ERROR_CODES.ERR_OBJECT_TOO_LARGE,
      '$',
      `Report exceeds ${LIMITS.maxReportBytes} canonical bytes`,
    );
  }
  return buildContractRecord(normalized);
}

export function parseAnalysisReport(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateAnalysisReport(value, options);
}

// 仅展示：报告里出现任何审批/执行字段都会天然落到 ERR_UNKNOWN_FIELD。
