import { canonicalDigest } from '../canonical.js';
import { ContractError, ERROR_CODES } from '../errors.js';
import { timestampToEpochMs } from '../fields.js';
import { assertNoHiddenKeys } from '../schema.js';
import { validateApproval } from './approval.js';
import { validateExecutionGrant } from './execution-grant.js';
import { validateResponseProposal } from './response-proposal.js';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RECORD_KEYS = Object.freeze(['schemaVersion', 'digest', 'value']);

/**
 * 每个 label 对应的 DTO 校验器：记录里的 value 必须能重新过一遍对应校验器。
 * 这三个模块只依赖 schema / fields / canonical，不反向 import binding.js，无循环依赖。
 */
const RECORD_VALIDATORS = Object.freeze({
  proposal: validateResponseProposal,
  approval: validateApproval,
  grant: validateExecutionGrant,
});

function fail(reason, path, message) {
  throw new ContractError(ERROR_CODES.ERR_BINDING_MISMATCH, path, message, { reason });
}

function notObject(label, message) {
  throw new ContractError(ERROR_CODES.ERR_INPUT_NOT_OBJECT, '$', message, { label });
}

/**
 * 合同记录形状与完整性校验。
 *
 * 只校验 digest 的"形状"是不够的：调用方可以自己拼 `{ digest, value }` 让
 * proposal_digest 与 target_digest 全部对上。这里必须重算
 * canonicalDigest(value) 并与 record.digest 比对，摘要不匹配即 ERR_DIGEST_MISMATCH。
 *
 * 仅比对摘要仍不够：手工拼一份"摘要自洽但形状残缺"的 value（例如缺
 * normalized_target.target_kind）也能通过。因此按 label 重新跑一遍对应校验器，
 * 形状非法时原样上抛它的 ContractError（不会被折成 ERR_BINDING_MISMATCH）；
 * 重跑结果的 digest 还必须与 record.digest 相等。
 */
function assertRecord(record, label, path = '$') {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    notObject(label, `${label} must be a contract record { schemaVersion, digest, value }`);
  }
  if (Object.getPrototypeOf(record) !== Object.prototype) {
    notObject(label, `${label} must be a plain contract record`);
  }
  const keys = Object.keys(record);
  if (keys.length !== RECORD_KEYS.length || !RECORD_KEYS.every((key) => (
    Object.prototype.hasOwnProperty.call(record, key)
  ))) {
    notObject(label, `${label} must carry exactly schemaVersion, digest and value`);
  }
  // Object.keys 只数可枚举字符串键：非枚举自有键与 Symbol 键既不会被计数，也不在
  // canonicalDigest 的覆盖范围内，放行等于让记录携带"看不见又不进摘要"的旁路数据。
  // 这里用与包内其他模块（assertClosedObject / validatePayload）同一套隐藏键检查，
  // 并把形状类失败统一折成 ERR_INPUT_NOT_OBJECT + details.label。
  try {
    assertNoHiddenKeys(record, path, RECORD_KEYS);
  } catch {
    notObject(label, `${label} must carry exactly schemaVersion, digest and value`);
  }
  // 记录的 schemaVersion 必须与 value.schemaVersion 一致：两者都可以被调用方改写，
  // 只校验 value 内部版本会放过"记录声明 1.0、内容实际是别的版本"的错配记录。
  // （放在 value 形态检查之后，避免对非对象 value 取属性。）
  if (typeof record.digest !== 'string' || !DIGEST_PATTERN.test(record.digest)) {
    notObject(label, `${label} must carry a 64-hex digest`);
  }
  const { value } = record;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    notObject(label, `${label}.value must be a normalized DTO`);
  }
  if (record.schemaVersion !== value.schemaVersion) {
    notObject(label, `${label}.schemaVersion does not match ${label}.value.schemaVersion`);
  }
  const expected = canonicalDigest(value);
  if (record.digest !== expected) {
    throw new ContractError(
      ERROR_CODES.ERR_DIGEST_MISMATCH,
      `${path}.digest`,
      `${label}.digest does not match canonicalDigest(${label}.value)`,
      { expected, label },
    );
  }
  const revalidate = RECORD_VALIDATORS[label];
  if (typeof revalidate === 'function') {
    const rebuilt = revalidate(value);
    if (rebuilt.digest !== record.digest) {
      throw new ContractError(
        ERROR_CODES.ERR_DIGEST_MISMATCH,
        `${path}.digest`,
        `${label}.digest does not match the digest of the re-validated DTO`,
        { expected: rebuilt.digest, label },
      );
    }
  }
  return record;
}

/**
 * 提案 → 审批：审批里的 proposal_digest 必须等于提案记录的 digest，
 * target_digest 必须等于规范化目标摘要。
 */
export function verifyProposalApprovalBinding(proposal, approval) {
  assertRecord(proposal, 'proposal');
  assertRecord(approval, 'approval');
  const target = proposal.value.normalized_target;
  if (target === null || typeof target !== 'object') {
    throw new ContractError(
      ERROR_CODES.ERR_INPUT_NOT_OBJECT,
      '$.value.normalized_target',
      'proposal record does not carry a normalized_target',
    );
  }
  if (approval.value.proposal_digest !== proposal.digest) {
    fail('proposal_digest', '$.value.proposal_digest', 'approval.proposal_digest does not match proposal.digest');
  }
  if (approval.value.target_digest !== target.digest) {
    fail('target_digest', '$.value.target_digest', 'approval.target_digest does not match proposal target digest');
  }
  return true;
}

/**
 * 授权 → 审批：除标识、目标、epoch、nonce 与时间窗绑定外，
 * 只允许消费 state === 'approved' 的审批。
 *
 * 所有失败路径的 path 都指向被检查字段的真实位置（`$.value.<字段>`），
 * 而不是不含 value 的假路径，便于把错误直接映射回具体 DTO。
 */
export function verifyGrantApprovalBinding(grant, approval) {
  assertRecord(grant, 'grant');
  assertRecord(approval, 'approval');
  const grantValue = grant.value;
  const approvalValue = approval.value;

  if (grantValue.approval_id !== approvalValue.approval_id) {
    fail('approval_id', '$.value.approval_id', 'grant.approval_id does not match approval.approval_id');
  }
  if (grantValue.target_digest !== approvalValue.target_digest) {
    fail('target_digest', '$.value.target_digest', 'grant.target_digest does not match approval.target_digest');
  }
  if (grantValue.epoch !== approvalValue.epoch) {
    fail('epoch', '$.value.epoch', 'grant.epoch does not match approval.epoch');
  }
  if (approvalValue.state !== 'approved') {
    fail('approval_state', '$.value.state', 'only an approved approval can be consumed');
  }
  if (grantValue.nonce === approvalValue.nonce) {
    fail('nonce_reuse', '$.value.nonce', 'grant.nonce must differ from approval.nonce');
  }
  if (timestampToEpochMs(grantValue.not_before) < timestampToEpochMs(approvalValue.issued_at)) {
    fail('not_before', '$.value.not_before', 'grant.not_before must not precede approval.issued_at');
  }
  if (timestampToEpochMs(grantValue.expires_at) > timestampToEpochMs(approvalValue.expires_at)) {
    fail('expires_at', '$.value.expires_at', 'grant.expires_at must not exceed approval.expires_at');
  }
  return true;
}
