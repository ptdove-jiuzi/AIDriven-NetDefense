import { ContractError, ERROR_CODES } from './errors.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOT_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BOUNDED_IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/;
const DOTTED_IDENTIFIER = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*){1,3}$/;
const POLICY_VERSION = /^[0-9]+(?:\.[0-9]+){1,2}$/;
const OS_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._@\\-]{0,127}$/;
const NATIVE_RECORD_ID = /^[!-~]{1,256}$/;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const SEMANTIC_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]{1,32})?$/;
// 必须与 analysis-request.js 里的 SUMMARY_FIELD_PATTERN 完全等价：同一个键名形态，
// 在对象内部用正则、在合同字段层用字段类型，两处不能漂移。
const SUMMARY_FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** 规范小写 UUIDv4。 */
export const uuidV4 = Object.freeze({
  type: 'string',
  maxBytes: 36,
  pattern: UUID_V4,
  doc: '规范小写 UUIDv4',
});

/** 32 位小写 hex 或 UUIDv4。 */
export const bootId = Object.freeze({
  type: 'string',
  maxBytes: 36,
  pattern: BOOT_ID,
  doc: '启动标识：32 位小写 hex 或 UUIDv4',
});

/** RFC3339 UTC 时间戳，只接受大写 Z，不允许数字偏移。 */
export const rfc3339Utc = Object.freeze({
  type: 'string',
  maxBytes: 32,
  validator: (value, path) => {
    timestampToEpochMs(value, path);
  },
  doc: 'RFC3339 UTC 时间戳（大写 Z）',
});

export const sha256Hex = Object.freeze({
  type: 'string',
  maxBytes: 64,
  pattern: SHA256_HEX,
  doc: '64 位小写 hex 摘要',
});

export const opaqueToken = Object.freeze({
  type: 'string',
  maxBytes: 128,
  pattern: OPAQUE_TOKEN,
  doc: '高熵不透明令牌（nonce / idempotency_key / object_id）',
});

/** 标准 base64 签名，长度 44..688 且为 4 的倍数。 */
export const base64Signature = Object.freeze({
  type: 'string',
  maxBytes: 688,
  pattern: BASE64,
  validator: (value, path) => {
    if (value.length < 44 || value.length > 688 || value.length % 4 !== 0) {
      throw new ContractError(
        ERROR_CODES.ERR_FIELD_PATTERN,
        path,
        'Signature must be standard base64 with length 44..688 and a multiple of 4',
      );
    }
  },
  doc: '标准 base64 签名',
});

export const boundedIdentifier = Object.freeze({
  type: 'string',
  maxBytes: 96,
  pattern: BOUNDED_IDENTIFIER,
  doc: '受限标识符：小写开头，最多 8 段，<= 96 字节',
});

export const dottedIdentifier = Object.freeze({
  type: 'string',
  maxBytes: 96,
  pattern: DOTTED_IDENTIFIER,
  doc: '点分标识符：至少两段，<= 96 字节',
});

export const policyVersion = Object.freeze({
  type: 'string',
  maxBytes: 32,
  pattern: POLICY_VERSION,
  doc: '策略版本：1 到 3 段十进制',
});

export const osAccountId = Object.freeze({
  type: 'string',
  maxBytes: 128,
  pattern: OS_ACCOUNT_ID,
  doc: '操作系统账户标识',
});

export const nativeRecordId = Object.freeze({
  type: 'string',
  maxBytes: 256,
  pattern: NATIVE_RECORD_ID,
  doc: '来源系统原生记录标识（可打印 ASCII）',
});

/** 严格 semver（major.minor.patch，可选预发布后缀），禁止数值前导零。 */
export const semanticVersion = Object.freeze({
  type: 'string',
  maxBytes: 64,
  pattern: SEMANTIC_VERSION,
  doc: '严格 semver（禁止数值前导零）',
});

/** summary_dto.fields 的键名形态。 */
export const summaryFieldName = Object.freeze({
  type: 'string',
  maxBytes: 64,
  pattern: SUMMARY_FIELD_NAME,
  doc: 'summary_dto.fields 键名形态',
});

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * 严格解析 RFC3339 UTC 时间戳并返回 epoch 毫秒。
 * 除了正则，还要做真实日历校验（闰年、月长、时分秒范围）；24 时拒绝。
 */
export function timestampToEpochMs(value, path = '$') {
  if (typeof value !== 'string') {
    throw new ContractError(ERROR_CODES.ERR_TIMESTAMP_FORMAT, path, 'Timestamp must be a string');
  }
  const match = RFC3339_UTC.exec(value);
  if (!match) {
    throw new ContractError(
      ERROR_CODES.ERR_TIMESTAMP_FORMAT,
      path,
      'Timestamp must be YYYY-MM-DDTHH:MM:SS(.mmm)?Z',
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milli = match[7] === undefined ? 0 : Number(match[7]);
  if (month < 1 || month > 12) {
    throw new ContractError(ERROR_CODES.ERR_TIMESTAMP_FORMAT, path, 'Month is out of range');
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new ContractError(ERROR_CODES.ERR_TIMESTAMP_FORMAT, path, 'Day does not exist in that month');
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new ContractError(ERROR_CODES.ERR_TIMESTAMP_FORMAT, path, 'Time of day is out of range');
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milli);
  return date.getTime();
}

/** 按解析后的瞬时比较，绝不退化为字符串比较。 */
export function compareTimestamps(left, right) {
  return timestampToEpochMs(left) - timestampToEpochMs(right);
}

export function assertTimestampOrder(earlier, later, path = '$', message = 'Timestamp order is invalid') {
  if (timestampToEpochMs(earlier) > timestampToEpochMs(later)) {
    throw new ContractError(ERROR_CODES.ERR_TIMESTAMP_ORDER, path, message);
  }
}
