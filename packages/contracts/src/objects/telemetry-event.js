import { canonicalDigest, canonicalSize } from '../canonical.js';
import { ContractError, ERROR_CODES } from '../errors.js';
import {
  assertTimestampOrder,
  bootId,
  boundedIdentifier,
  dottedIdentifier,
  nativeRecordId,
  rfc3339Utc,
  sha256Hex,
  uuidV4,
} from '../fields.js';
import { LIMITS } from '../limits.js';
import {
  assertClosedObject,
  assertNoHiddenKeys,
  assertPlainObject,
  buildContractRecord,
  deepFreeze,
  normalizeScalarOrArray,
} from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { RAW_EVIDENCE_CONTROLS } from '../unicode.js';
import { negotiateSchemaVersion } from '../version.js';

export const SEVERITY_LEVELS = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

const PAYLOAD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RAW_EVIDENCE_KEY = 'raw_evidence';

const RAW_EVIDENCE_SPEC = Object.freeze({
  encoding: { required: true, type: 'string', enum: ['utf-8'] },
  // 原始证据是唯一放行 \t / \n / \r 的字段：真实日志天然多行。
  // 其余 C0/C1（含 ESC 0x1B）仍然拒绝，避免 ANSI 转义序列入库。
  text: {
    required: true,
    type: 'string',
    maxBytes: LIMITS.maxRawEvidenceStringBytes,
    allowControls: RAW_EVIDENCE_CONTROLS,
  },
});

function fail(code, path, message, details) {
  throw new ContractError(code, path, message, details);
}

/**
 * payload 校验：键名固定形态，值只能是标量或同类型标量数组。
 * 嵌套对象被明确拒绝（ERR_FIELD_TYPE，path 指向该键）。
 *
 * payload 的键集合由内容决定（没有静态 spec），因此这里用
 * assertNoHiddenKeys(payload, path) 拒绝隐藏键与非枚举键：可枚举的未知键仍按
 * 键名形态落到 ERR_FIELD_PATTERN，非枚举 / Symbol 键则落到 ERR_UNKNOWN_FIELD。
 */
export function validatePayload(payload, path = '$.payload') {
  assertPlainObject(payload, path);
  assertNoHiddenKeys(payload, path);
  const keys = Object.getOwnPropertyNames(payload);
  if (keys.length > LIMITS.maxObjectKeys) {
    fail(ERROR_CODES.ERR_MAX_OBJECT_KEYS, path, `Payload has more than ${LIMITS.maxObjectKeys} keys`);
  }
  const normalized = {};
  for (const key of keys) {
    const keyPath = `${path}.${key}`;
    if (!PAYLOAD_KEY_PATTERN.test(key)) {
      fail(
        ERROR_CODES.ERR_FIELD_PATTERN,
        keyPath,
        `Payload key "${key}" does not match the required pattern`,
      );
    }
    const value = payload[key];
    const normalizedValue = key === RAW_EVIDENCE_KEY
      ? assertClosedObject(value, RAW_EVIDENCE_SPEC, keyPath, {})
      : normalizeScalarOrArray(value, keyPath);
    Object.defineProperty(normalized, key, {
      value: normalizedValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const hasRawEvidence = Object.prototype.hasOwnProperty.call(normalized, RAW_EVIDENCE_KEY);
  // 边界说明（设计数值的算术结果，不是缺陷）：
  // LIMITS.maxRawEvidenceStringBytes 是"单个字符串"的上限（262144 字节），
  // 而 LIMITS.maxEventBytes / 这里的 payload 总限同样是 262144。单个事件的总字节
  // 必然还包含信封开销（键名、引号、冒号，以及 raw_evidence 的 encoding 等），
  // 因此 raw_evidence.text 的可用文本上限略小于 262144：恰好 262144 字节的文本
  // 加上容器开销一定先撞总限并报 ERR_OBJECT_TOO_LARGE，260000 字节则仍可入库。
  // 这两个常量刻意保持与设计文档一致，不要为了让"单字符串拿满 256KiB"而调大。
  const sizeLimit = hasRawEvidence ? LIMITS.maxRawEvidenceStringBytes : LIMITS.maxPayloadBytes;
  if (canonicalSize(normalized) > sizeLimit) {
    fail(ERROR_CODES.ERR_OBJECT_TOO_LARGE, path, `Payload exceeds ${sizeLimit} canonical bytes`);
  }
  return deepFreeze(normalized);
}

const TELEMETRY_EVENT_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  event_id: { ...uuidV4, required: true },
  stable_source_id: { ...boundedIdentifier, required: true },
  collector_instance_id: { ...uuidV4, required: true },
  source_generation: { required: true, type: 'integer', min: 0, max: LIMITS.maxSafeInteger },
  boot_id: { ...bootId, required: true },
  native_record_id: { ...nativeRecordId, required: false },
  source_seq: { required: true, type: 'integer', min: 0, max: LIMITS.maxSafeInteger },
  observed_at: { ...rfc3339Utc, required: true },
  received_at: { ...rfc3339Utc, required: true },
  type: { ...dottedIdentifier, required: true },
  severity: { required: true, type: 'string', enum: SEVERITY_LEVELS },
  payload: {
    required: true,
    type: 'object',
    normalize: (value, path) => validatePayload(value, path),
  },
  integrity: {
    required: true,
    type: 'object',
    fields: {
      algorithm: { required: true, type: 'string', enum: ['sha256'] },
      digest: { ...sha256Hex, required: true },
    },
  },
});

export function validateTelemetryEvent(value, options = {}) {
  const normalized = assertClosedObject(value, TELEMETRY_EVENT_SPEC, '$', options);
  assertTimestampOrder(
    normalized.observed_at,
    normalized.received_at,
    '$.received_at',
    'observed_at must not be after received_at',
  );
  const recomputed = canonicalDigest(normalized.payload);
  if (recomputed !== normalized.integrity.digest) {
    fail(
      ERROR_CODES.ERR_INTEGRITY_DIGEST_MISMATCH,
      '$.integrity.digest',
      'integrity.digest does not match canonicalDigest(payload)',
      { expected: recomputed },
    );
  }
  if (canonicalSize(normalized) > LIMITS.maxEventBytes) {
    fail(
      ERROR_CODES.ERR_OBJECT_TOO_LARGE,
      '$',
      `Event exceeds ${LIMITS.maxEventBytes} canonical bytes`,
    );
  }
  return buildContractRecord(normalized);
}

/**
 * 解析路径必须放行 \t / \n / \r：恶意构造的多行文本不能借解析器拒绝，
 * 否则真实日志的原始证据永远无法入库。解析器只放行这三种行结构字符，
 * 字段级仍然由 RAW_EVIDENCE_SPEC 限定在 payload.raw_evidence.text 之内——
 * 别的字段出现换行会在 validateTelemetryEvent 阶段被拒。
 */
export function parseTelemetryEvent(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, {
      maxStringBytes: options.maxStringBytes ?? LIMITS.maxRawEvidenceStringBytes,
      allowControls: RAW_EVIDENCE_CONTROLS,
    })
    : source;
  return validateTelemetryEvent(value, options);
}
