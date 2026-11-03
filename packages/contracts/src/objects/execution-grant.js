import { ContractError, ERROR_CODES } from '../errors.js';
import {
  base64Signature,
  dottedIdentifier,
  opaqueToken,
  rfc3339Utc,
  sha256Hex,
  timestampToEpochMs,
  uuidV4,
} from '../fields.js';
import { LIMITS } from '../limits.js';
import { assertClosedObject, buildContractRecord } from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { negotiateSchemaVersion } from '../version.js';

/*
 * 关于 action_id 的解释性决策：
 *
 * 设计 §4.2 用「action / parameters / target digest」的简写描述授权绑定关系。
 * 但执行前必须校验「动作 allowlist」（见 §10.2），而单凭 action_digest 无法完成
 * 这项校验——摘要是不可逆的，策略层拿不到动作名就无法判断该动作是否被允许。
 * 因此本合同同时携带 action_id（可读、可校验的动作标识）与 action_digest（用于
 * 绑定完整性），二者都必须出现在授权里，缺一不可。action_digest 不替代 action_id。
 */

const EXECUTION_GRANT_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  execution_id: { ...uuidV4, required: true },
  approval_id: { ...uuidV4, required: true },
  action_id: { ...dottedIdentifier, required: true },
  action_digest: { ...sha256Hex, required: true },
  parameters_digest: { ...sha256Hex, required: true },
  target_digest: { ...sha256Hex, required: true },
  nonce: { ...opaqueToken, required: true },
  not_before: { ...rfc3339Utc, required: true },
  expires_at: { ...rfc3339Utc, required: true },
  epoch: { ...uuidV4, required: true },
  signature: { ...base64Signature, required: true },
});

/**
 * 执行授权是唯一带签名的副作用凭据。
 * 字符串形式的自由文本 / Markdown / 普通 JSON 都不可能是 Grant：
 * parse 路径一律走严格 JSON 解析，validate 路径要求普通对象输入。
 */
export function validateExecutionGrant(value, options = {}) {
  const normalized = assertClosedObject(value, EXECUTION_GRANT_SPEC, '$', options);
  const notBefore = timestampToEpochMs(normalized.not_before);
  const expiresAt = timestampToEpochMs(normalized.expires_at);
  if (expiresAt <= notBefore) {
    throw new ContractError(
      ERROR_CODES.ERR_TIMESTAMP_ORDER,
      '$.expires_at',
      'expires_at must be strictly after not_before',
    );
  }
  return buildContractRecord(normalized);
}

export function parseExecutionGrant(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateExecutionGrant(value, options);
}
