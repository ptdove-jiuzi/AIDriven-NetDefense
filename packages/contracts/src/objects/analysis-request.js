import { canonicalSize } from '../canonical.js';
import { ContractError, ERROR_CODES } from '../errors.js';
import { boundedIdentifier, opaqueToken, rfc3339Utc, uuidV4 } from '../fields.js';
import { LIMITS } from '../limits.js';
import {
  assertClosedObject,
  assertNoHiddenKeys,
  buildContractRecord,
  deepFreeze,
  isPlainObject,
  normalizeScalarOrArray,
} from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { assertText } from '../unicode.js';
import { negotiateSchemaVersion } from '../version.js';

export const DATA_CLASSIFICATIONS = Object.freeze(['D0', 'D1', 'D2', 'D3']);

const DEFAULT_ALLOWED_CLASSIFICATIONS = Object.freeze(['D0', 'D1']);
const SUMMARY_FIELD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SUMMARY_DTO_KEYS = Object.freeze(['classification', 'fields']);

function fail(code, path, message, details) {
  throw new ContractError(code, path, message, details);
}

/** 必填判定只看自有属性，避免 Object.prototype 污染把字段补齐。 */
function readOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

/**
 * summary_dto 是可出域的白名单 DTO：
 * - classification 必须落在调用方允许的分级集合内（默认只允许 D0/D1）；
 * - fields 的每个键都必须显式出现在 allowedSummaryFields 中（默认空集 = 全部拒绝）。
 *
 * 两层都做"所有自有键"检查：非枚举键与 Symbol 键不再隐形（顶层有这道检查，
 * 嵌套层也必须对称），fields 还必须是普通对象（类实例 / 无原型对象一律拒绝）。
 */
function normalizeSummaryDto(value, path, options) {
  assertNoHiddenKeys(value, path, SUMMARY_DTO_KEYS);

  const classification = readOwn(value, 'classification');
  if (classification === undefined) {
    fail(ERROR_CODES.ERR_MISSING_FIELD, `${path}.classification`, 'Required field is missing');
  }
  if (typeof classification !== 'string') {
    fail(ERROR_CODES.ERR_FIELD_TYPE, `${path}.classification`, 'Expected a string');
  }
  assertText(classification, `${path}.classification`);
  if (!DATA_CLASSIFICATIONS.includes(classification)) {
    fail(ERROR_CODES.ERR_FIELD_ENUM, `${path}.classification`, 'Unknown data classification', {
      allowed: DATA_CLASSIFICATIONS,
    });
  }
  const allowedClassifications = options.allowClassification ?? DEFAULT_ALLOWED_CLASSIFICATIONS;
  if (!allowedClassifications.includes(classification)) {
    fail(
      ERROR_CODES.ERR_CLASSIFICATION_NOT_EXPORTABLE,
      `${path}.classification`,
      `Classification ${classification} is not exportable on this boundary`,
      { allowed: allowedClassifications },
    );
  }

  const fields = readOwn(value, 'fields');
  if (fields === undefined) {
    fail(ERROR_CODES.ERR_MISSING_FIELD, `${path}.fields`, 'Required field is missing');
  }
  // 只判 typeof/Array 会放过类实例（new Fields()）与 Object.create(null)：
  // 这里复用与 canonicalize / assertPlainObject 同一套普通对象语义。
  if (!isPlainObject(fields)) {
    fail(ERROR_CODES.ERR_FIELD_TYPE, `${path}.fields`, 'Expected a plain object');
  }
  assertNoHiddenKeys(fields, `${path}.fields`);
  const allowedFields = options.allowedSummaryFields ?? [];

  const fieldKeys = Object.getOwnPropertyNames(fields);
  // 先判键数再看内容：否则 129 个合法短键也能一路走到 allowlist 检查。
  if (fieldKeys.length > LIMITS.maxObjectKeys) {
    fail(
      ERROR_CODES.ERR_MAX_OBJECT_KEYS,
      `${path}.fields`,
      `Summary fields has more than ${LIMITS.maxObjectKeys} keys`,
    );
  }

  const normalizedFields = {};
  for (const key of fieldKeys) {
    const fieldPath = `${path}.fields.${key}`;
    if (!allowedFields.includes(key)) {
      fail(
        ERROR_CODES.ERR_SUMMARY_FIELD_NOT_ALLOWED,
        fieldPath,
        `Summary field "${key}" is not in the allowlist`,
        { allowed: allowedFields },
      );
    }
    if (!SUMMARY_FIELD_PATTERN.test(key)) {
      fail(ERROR_CODES.ERR_FIELD_PATTERN, fieldPath, 'Summary field name does not match the pattern');
    }
    Object.defineProperty(normalizedFields, key, {
      value: normalizeScalarOrArray(fields[key], fieldPath),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (canonicalSize(normalizedFields) > LIMITS.maxPayloadBytes) {
    fail(
      ERROR_CODES.ERR_OBJECT_TOO_LARGE,
      `${path}.fields`,
      `Summary fields exceed ${LIMITS.maxPayloadBytes} canonical bytes`,
    );
  }

  return deepFreeze({ classification, fields: normalizedFields });
}

const ANALYSIS_REQUEST_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  analysis_id: { ...uuidV4, required: true },
  alert_id: { ...uuidV4, required: true },
  budget_class: { ...boundedIdentifier, required: true },
  summary_dto: {
    required: true,
    type: 'object',
    normalize: (value, path, options) => normalizeSummaryDto(value, path, options),
  },
  created_at: { ...rfc3339Utc, required: true },
  idempotency_key: { ...opaqueToken, required: true },
  epoch: { ...uuidV4, required: true },
});

export function validateAnalysisRequest(value, options = {}) {
  const normalized = assertClosedObject(value, ANALYSIS_REQUEST_SPEC, '$', options);
  return buildContractRecord(normalized);
}

export function parseAnalysisRequest(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateAnalysisRequest(value, options);
}
