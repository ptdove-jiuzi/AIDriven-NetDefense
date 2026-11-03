import { canonicalDigest } from '../canonical.js';
import { ContractError, ERROR_CODES } from '../errors.js';
import {
  base64Signature,
  boundedIdentifier,
  osAccountId,
  rfc3339Utc,
  sha256Hex,
} from '../fields.js';
import { LIMITS } from '../limits.js';
import { assertClosedObject, buildContractRecord } from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { negotiateSchemaVersion } from '../version.js';

/** 审计条目的行为主体类型。 */
export const AUDIT_ACTOR_TYPES = Object.freeze([
  'daemon',
  'broker',
  'worker',
  'console',
  'cli',
  'collector',
  'helper',
  'system',
]);

/*
 * AuditEvent 是哈希链上的一环，不是"日志行"：
 * 每条记录的 digest 覆盖其自身 value，previous_digest 指向前一条的 digest，
 * sequence 严格 +1，hmac 由签署方离线校验。从 1 开始的链，创世条目的
 * previous_digest 必须是 64 个 '0'，刻意不接受 null —— 空值会让"缺省即创世"
 * 成为可被利用的旁路。
 *
 * 本包只校验结构，不签发：不存在任何"补齐链"或"重算 HMAC"的入口。
 */

/** 创世约定里"没有前驱"的占位摘要。 */
const GENESIS_PREVIOUS_DIGEST = '0'.repeat(64);

/** 摘要的形态约束：64 位小写 hex，与 sha256Hex 字段一致。 */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

const AUDIT_ACTOR_SPEC = Object.freeze({
  type: { required: true, type: 'string', enum: AUDIT_ACTOR_TYPES },
  id: { ...osAccountId, required: true },
});

const AUDIT_EVENT_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  sequence: { required: true, type: 'integer', min: 1, max: LIMITS.maxSafeInteger },
  timestamp: { ...rfc3339Utc, required: true },
  actor: { required: true, type: 'object', fields: AUDIT_ACTOR_SPEC },
  action: { ...boundedIdentifier, required: true },
  object_digest: { ...sha256Hex, required: true },
  previous_digest: { ...sha256Hex, required: true },
  payload_digest: { ...sha256Hex, required: true },
  hmac: { ...base64Signature, required: true },
});

export function validateAuditEvent(value, options = {}) {
  const normalized = assertClosedObject(value, AUDIT_EVENT_SPEC, '$', options);
  return buildContractRecord(normalized);
}

export function parseAuditEvent(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateAuditEvent(value, options);
}

function isChainRecord(entry) {
  return entry !== null
    && typeof entry === 'object'
    && typeof entry.digest === 'string'
    && DIGEST_PATTERN.test(entry.digest)
    && entry.value !== null
    && typeof entry.value === 'object'
    && Number.isInteger(entry.value.sequence)
    && typeof entry.value.previous_digest === 'string';
}

/**
 * 校验一条审计哈希链的**结构自洽性**。
 *
 * 本函数验证三件事：
 * 1. 每条记录与其自身摘要自洽（`canonicalDigest(record.value) === record.digest`）；
 * 2. 序号相邻（后一条的 `sequence` 恰为前一条 + 1）；
 * 3. `previous_digest` 与前一条的 `digest` 相接。
 *
 * 本函数**不验证**：
 * - HMAC 签名——没有密钥，本包不做验签；
 * - 字段语义——那是 `validateAuditEvent` 的职责；
 * - 跨 epoch 的真实性——链只能证明"给定的这批记录彼此接得上"。
 *
 * 因此 `ok: true` 只证明链在结构上自洽，**不构成审计未被重写的证明**：
 * 拿到 `value` 的人可以改内容并用 `canonicalDigest` 重算 `digest`，
 * 再顺着改后续记录的 `previous_digest`，本函数无法发现。
 *
 * 首条的起始 sequence 任意（链可以从任意检查点开始校验）；只有明确从 1
 * 开始的链才受创世约定约束——那时 `previous_digest` 必须是 64 个 '0'。
 *
 * path 形如 `$.records[i].字段`：这里的根是**函数的数组入参**，不是 DTO 根。
 *
 * @param {readonly { digest: string, value: object }[]} records 审计链记录（形如 validateAuditEvent 的返回值）。
 * @returns {{ ok: true, length: number }} 冻结的校验结果。
 * @throws {ContractError} `ERR_INPUT_NOT_OBJECT` / `ERR_AUDIT_CHAIN_BROKEN`。
 */
export function verifyAuditChain(records) {
  if (!Array.isArray(records)) {
    throw new ContractError(
      ERROR_CODES.ERR_INPUT_NOT_OBJECT,
      '$',
      'verifyAuditChain expects an array of validated audit records',
    );
  }
  for (let index = 0; index < records.length; index += 1) {
    if (!isChainRecord(records[index])) {
      throw new ContractError(
        ERROR_CODES.ERR_INPUT_NOT_OBJECT,
        `$.records[${index}]`,
        'Audit chain entries must be records returned by validateAuditEvent',
      );
    }
  }
  // 自洽性先于链接：声称的 digest 必须等于对其自身 value 的重算结果，
  // 否则"改 value 不改 digest"的伪造记录会靠首尾相接骗过链接检查。
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const expected = canonicalDigest(record.value);
    if (record.digest !== expected) {
      throw new ContractError(
        ERROR_CODES.ERR_AUDIT_CHAIN_BROKEN,
        `$.records[${index}].digest`,
        'record digest must equal the canonical digest of its own value',
        { expected, actual: record.digest },
      );
    }
  }
  if (records.length > 0) {
    const first = records[0].value;
    if (first.sequence === 1 && first.previous_digest !== GENESIS_PREVIOUS_DIGEST) {
      throw new ContractError(
        ERROR_CODES.ERR_AUDIT_CHAIN_BROKEN,
        '$.records[0].previous_digest',
        'the first record of a chain starting at sequence 1 must use 64 zeros as previous_digest',
        { expected: GENESIS_PREVIOUS_DIGEST, actual: first.previous_digest },
      );
    }
  }
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    const expectedSequence = previous.value.sequence + 1;
    if (current.value.sequence !== expectedSequence) {
      throw new ContractError(
        ERROR_CODES.ERR_AUDIT_CHAIN_BROKEN,
        `$.records[${index}].sequence`,
        'Audit sequence must increase by exactly one',
        { expected: expectedSequence, actual: current.value.sequence },
      );
    }
    if (current.value.previous_digest !== previous.digest) {
      throw new ContractError(
        ERROR_CODES.ERR_AUDIT_CHAIN_BROKEN,
        `$.records[${index}].previous_digest`,
        'previous_digest must equal the digest of the preceding record',
        { expected: previous.digest, actual: current.value.previous_digest },
      );
    }
  }
  return Object.freeze({ ok: true, length: records.length });
}
