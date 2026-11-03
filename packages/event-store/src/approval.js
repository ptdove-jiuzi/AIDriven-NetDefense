/**
 * T3a / T3b / T3c：审批 → 授权/投递准备 → 交付/接受。
 *
 * 三个事务的分界线就是设计 §10.1 的三道闸：
 *
 * | 事务 | 语义 | 关键不变量 |
 * |---|---|---|
 * | T3a | pending → approved，创建 execution(approved) | 角色、5 分钟内再认证、策略版本、TTL、epoch 全部在同一事务内复核 |
 * | T3b | approved → consumed，execution → dispatch_pending，写 Grant + 持久 outbox | nonce **只在此事务消费一次** |
 * | T3c | outbox → dispatched，helper inbox 去重后 accepted | 同一 execution_id+attempt_id 幂等；旧 owner/lease 不能提交 |
 *
 * "外部副作用与 SQLite 不在同一事务" 是这里的前提：T3b 只写**意图**与
 * **持久 outbox**，真正投递由 outbox 重发同一条 Grant 完成，
 * 重发永远不会生成新的 execution_id 或新的动作。
 */

import {
  canonicalize,
  validateApproval,
  validateExecutionGrant,
  validateResponseProposal,
} from '../../contracts/src/index.js';

import { AUDIT_ACTIONS, appendAudit } from './audit.js';
import { assertResponseCapabilityOpen } from './maintenance.js';
import { STORE_CODES, StoreError } from './errors.js';
import { canonicalDigest, hmacBase64, isoFromMs, msFromIso, sha256Hex, uuid } from './util.js';

export const APPROVAL_REVERIFY_MS = 300000;

/** Grant 是短期凭据：即使审批 TTL 有 30 分钟，授权本身最多 5 分钟。 */
export const GRANT_MAX_TTL_MS = 300000;

/**
 * 同一条 Grant 的最大投递次数（含首发）。
 *
 * 没有上限时"重投"可以无限次：调用方循环 50 次就能把 attempts 推到 51，
 * 既不拒绝也不留痕。达到上限后执行转 `manual_required` 并写审计——
 * "送不到"必须变成人看得见的一件事，而不是一条静默增长的计数器。
 */
export const MAX_REDELIVER_ATTEMPTS = 5;

/**
 * 两次重投之间的最小间隔。
 *
 * 首发与**第一次**重投不受限制（第一次重投通常是对"确认丢了"的立即补偿）；
 * 从第二次重投开始必须满足间隔，否则一个紧循环就能把 attempts 撞到上限。
 */
export const MIN_REDELIVER_INTERVAL_MS = 5000;

/**
 * inbox 受理序号的上限。
 *
 * inbox 的主键是 `(execution_id, attempt_id, seq, kind)`，seq 由 helper 自报。
 * 没有上限时传 seq=2..20 就能一个事务一个事务地把 inbox 撑大 19 行——
 * 一条实际只受理了一次的执行，在库里留下 19 条"受理记录"。
 */
export const MAX_ACCEPT_SEQ = 8;

const PLACEHOLDER_SIGNING_KEY = 'aegis-grant-placeholder-key';

function signingKey(store) {
  return store.auditKey ?? PLACEHOLDER_SIGNING_KEY;
}

function grantSigningPayload(draft) {
  return canonicalize({
    schemaVersion: draft.schemaVersion,
    execution_id: draft.execution_id,
    approval_id: draft.approval_id,
    action_id: draft.action_id,
    action_digest: draft.action_digest,
    parameters_digest: draft.parameters_digest,
    target_digest: draft.target_digest,
    nonce: draft.nonce,
    not_before: draft.not_before,
    expires_at: draft.expires_at,
    epoch: draft.epoch,
  });
}

/** 目标摘要与动作摘要都由规范化 DTO 派生，不接受调用方自报。 */
function deriveDigests(proposalValue) {
  return {
    action_digest: canonicalDigest({ action_id: proposalValue.action_id }),
    // 合同里 Proposal 没有独立的 parameters 字段：参数语义全部包含在
    // normalized_target 内，因此 parameters_digest 绑定规范化目标而不是空对象。
    parameters_digest: canonicalDigest({ target: proposalValue.normalized_target }),
    target_digest: proposalValue.normalized_target.digest,
  };
}

function loadApproval(store, approvalId) {
  const row = store.get('SELECT * FROM approval WHERE approval_id = ?', [approvalId]);
  if (row === null) {
    throw new StoreError(STORE_CODES.ERR_APPROVAL_NOT_FOUND, `unknown approval ${approvalId}`, {
      approval_id: approvalId,
    });
  }
  return row;
}

function loadExecutionByApproval(store, approvalId) {
  const row = store.get('SELECT * FROM execution WHERE approval_id = ?', [approvalId]);
  if (row === null) {
    throw new StoreError(STORE_CODES.ERR_EXECUTION_NOT_FOUND, `no execution for approval ${approvalId}`, {
      approval_id: approvalId,
    });
  }
  return row;
}

function requireResponder(roles, context) {
  if (!Array.isArray(roles) || !roles.includes('responder')) {
    throw new StoreError(
      STORE_CODES.ERR_ROLE_NOT_PERMITTED,
      `${context} requires the responder role`,
      { roles: Array.isArray(roles) ? roles : [] },
    );
  }
}

/**
 * Proposal 行插入（不含幂等判断与审计）。
 *
 * 单独导出是因为 T5 完成事务也要在同一事务里落 Proposal——
 * "报告 + 可选提案 + 分析终态 + 审计"必须一次性提交，
 * 让 T5 去调用 `registerProposal` 会变成嵌套事务。
 *
 * @param {object} store 已在事务内。
 * @param {{ value: object, digest: string }} record `validateResponseProposal` 的返回值。
 * @param {string} now
 */
export function insertProposalRow(store, record, now) {
  const value = record.value;
  const analysis = store.get('SELECT analysis_id FROM analysis_outbox WHERE analysis_id = ?', [value.analysis_id]);
  if (analysis === null) {
    throw new StoreError(STORE_CODES.ERR_ANALYSIS_NOT_FOUND, `proposal references unknown analysis ${value.analysis_id}`);
  }
  store.run(
    `INSERT INTO response_proposal (
       proposal_id, analysis_id, action_id, normalized_target_json, target_digest,
       justification_json, risk, expires_at, expires_at_ms, canonical_json, canonical_digest, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      value.proposal_id,
      value.analysis_id,
      value.action_id,
      canonicalize(value.normalized_target),
      value.normalized_target.digest,
      JSON.stringify(value.justification_evidence),
      value.risk,
      value.expires_at,
      msFromIso(value.expires_at),
      canonicalize(value),
      record.digest,
      now,
    ],
  );
  return Object.freeze({ proposal_id: value.proposal_id, digest: record.digest, created: true });
}

/**
 * 登记 Proposal（只读对象，不含任何审批态）。
 * 幂等：同一 proposal_id 重复登记返回既有摘要，不覆盖。
 */
export function registerProposal(store, input) {
  store.assertWritable('registerProposal');
  assertResponseCapabilityOpen(store);
  const record = validateResponseProposal(input.proposal);
  const value = record.value;
  return store.tx('T3-proposal', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const existing = store.get('SELECT canonical_digest FROM response_proposal WHERE proposal_id = ?', [value.proposal_id]);
    if (existing !== null) {
      return Object.freeze({ proposal_id: value.proposal_id, digest: String(existing.canonical_digest), created: false });
    }
    const created = insertProposalRow(store, record, now);
    appendAudit(store, {
      action: AUDIT_ACTIONS.PROPOSAL_CREATE,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      objectDigest: record.digest,
      payload: { proposal_id: value.proposal_id, analysis_id: value.analysis_id, risk: value.risk },
      timestamp: now,
    });
    return created;
  });
}

/** 创建待审批（proposed → pending 在同一事务内完成，外部只看到 pending）。 */
export function createApproval(store, input) {
  store.assertWritable('createApproval');
  if (input === null || typeof input !== 'object' || typeof input.proposal_id !== 'string') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'createApproval requires proposal_id');
  }
  const draft = { ...input.approval, state: 'pending' };
  const record = validateApproval(draft);
  const value = record.value;

  return store.tx('T3a-pending', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const proposal = store.get('SELECT * FROM response_proposal WHERE proposal_id = ?', [input.proposal_id]);
    if (proposal === null) {
      throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `unknown proposal ${input.proposal_id}`);
    }
    if (String(proposal.canonical_digest) !== value.proposal_digest) {
      throw new StoreError(
        STORE_CODES.ERR_BINDING_MISMATCH,
        'approval.proposal_digest does not match the stored proposal',
        { expected: String(proposal.canonical_digest), actual: value.proposal_digest },
      );
    }
    if (String(proposal.target_digest) !== value.target_digest) {
      throw new StoreError(
        STORE_CODES.ERR_BINDING_MISMATCH,
        'approval.target_digest does not match the stored proposal target',
        { expected: String(proposal.target_digest), actual: value.target_digest },
      );
    }
    store.run(
      `INSERT INTO approval (
         approval_id, proposal_id, proposal_digest, policy_version, target_digest, approver_json,
         approver_account, nonce, issued_at, issued_at_ms, expires_at, expires_at_ms, epoch,
         state, consumed_at, created_at, updated_at, canonical_json, canonical_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?)`,
      [
        value.approval_id,
        input.proposal_id,
        value.proposal_digest,
        value.policy_version,
        value.target_digest,
        JSON.stringify(value.approver_identity),
        value.approver_identity.account_id,
        value.nonce,
        value.issued_at,
        msFromIso(value.issued_at),
        value.expires_at,
        msFromIso(value.expires_at),
        value.epoch,
        now,
        now,
        canonicalize(value),
        record.digest,
      ],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.APPROVAL_PENDING,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      objectDigest: record.digest,
      payload: { approval_id: value.approval_id, proposal_id: input.proposal_id, expires_at: value.expires_at },
      timestamp: now,
    });
    return Object.freeze({ approval_id: value.approval_id, state: 'pending', digest: record.digest });
  });
}

/**
 * T3a：pending → approved，并创建 execution(approved)。
 *
 * 角色、再认证时间、策略版本、TTL、epoch 在这里**重新检查一遍**——
 * 因为 pending 与 approved 之间可能隔了很久，期间角色可能被撤销。
 */
export function approveExecution(store, input) {
  store.assertWritable('approveExecution');
  if (input === null || typeof input !== 'object' || typeof input.approval_id !== 'string') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'approveExecution requires approval_id');
  }

  return store.tx('T3a', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const nowMs = msFromIso(now);
    const row = loadApproval(store, input.approval_id);
    const state = String(row.state);
    if (state === 'approved' || state === 'consumed') {
      const existing = store.get('SELECT execution_id, attempt_id, state FROM execution WHERE approval_id = ?', [
        input.approval_id,
      ]);
      if (existing !== null) {
        return Object.freeze({
          approval_id: input.approval_id,
          state,
          execution_id: String(existing.execution_id),
          attempt_id: String(existing.attempt_id),
          duplicate: true,
        });
      }
    }
    if (state !== 'pending') {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_STATE, `cannot approve a ${state} approval`, {
        approval_id: input.approval_id,
        state,
      });
    }
    if (nowMs >= Number(row.expires_at_ms)) {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_EXPIRED, 'approval TTL has expired', {
        approval_id: input.approval_id,
        expires_at: String(row.expires_at),
      });
    }
    if (String(row.epoch) !== store.epoch()) {
      throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'approval epoch does not match the current epoch', {
        approval_epoch: String(row.epoch),
        current: store.epoch(),
      });
    }
    if (String(row.policy_version) !== store.policyVersion()) {
      throw new StoreError(
        STORE_CODES.ERR_APPROVAL_POLICY_MISMATCH,
        'approval was issued under a different policy version',
        { approval_policy: String(row.policy_version), current: store.policyVersion() },
      );
    }
    requireResponder(input.roles, 'approval');
    const approver = JSON.parse(String(row.approver_json));
    // 审批把"谁批准的"钉死在 approver_identity 上；调用方自报的会话身份必须与之一致，
    // 否则任何持有 responder 角色的人都能替别人签名。
    if (typeof input.actorId !== 'string' || input.actorId.length === 0) {
      // 缺省即"匿名批准"：没有会话身份就无法核对该审批是谁按下的，直接拒绝。
      throw new StoreError(
        STORE_CODES.ERR_ROLE_NOT_PERMITTED,
        'approval requires the approving session identity (actorId)',
        { approval_id: input.approval_id },
      );
    }
    if (input.actorId !== String(approver.account_id)) {
      throw new StoreError(
        STORE_CODES.ERR_ROLE_NOT_PERMITTED,
        'approving session does not match the approver identity bound to this approval',
        { expected: String(approver.account_id), actual: input.actorId },
      );
    }
    const reauthenticatedMs = msFromIso(approver.reauthenticated_at);
    if (reauthenticatedMs > nowMs) {
      throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'reauthenticated_at must not be in the future');
    }
    if (nowMs - reauthenticatedMs > APPROVAL_REVERIFY_MS) {
      throw new StoreError(
        STORE_CODES.ERR_ROLE_NOT_PERMITTED,
        'reauthentication is older than 5 minutes at approval time',
        { reauthenticated_at: approver.reauthenticated_at, now },
      );
    }
    const proposal = store.get('SELECT * FROM response_proposal WHERE proposal_id = ?', [String(row.proposal_id)]);
    if (proposal === null) {
      throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'proposal disappeared between pending and approve');
    }
    if (Number(proposal.expires_at_ms) <= nowMs) {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_EXPIRED, 'proposal has expired', {
        proposal_id: String(row.proposal_id),
        expires_at: String(proposal.expires_at),
      });
    }

    const updated = store.run(
      "UPDATE approval SET state = 'approved', updated_at = ? WHERE approval_id = ? AND state = 'pending'",
      [now, input.approval_id],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_STATE, 'approval state changed concurrently', {
        approval_id: input.approval_id,
      });
    }

    const proposalValue = JSON.parse(String(proposal.canonical_json));
    const digests = deriveDigests(proposalValue);
    const executionId = typeof input.execution_id === 'string' && input.execution_id.length > 0
      ? input.execution_id
      : uuid();
    const attemptId = uuid();
    store.run(
      `INSERT INTO execution (
         execution_id, approval_id, proposal_id, attempt_id, attempt_seq, action_id, action_digest,
         parameters_digest, target_digest, proposal_digest, state, epoch, nonce, grant_json, grant_digest,
         not_before, expires_at, expires_at_ms, owner, lease_expires_at_ms, accepted_at, executing_at,
         settled_at, last_result_seq, need_reconcile, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'approved', ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?)`,
      [
        executionId,
        input.approval_id,
        String(row.proposal_id),
        attemptId,
        proposalValue.action_id,
        digests.action_digest,
        digests.parameters_digest,
        digests.target_digest,
        String(row.proposal_digest),
        store.epoch(),
        uuid(),
        String(row.expires_at),
        Number(row.expires_at_ms),
        now,
        now,
      ],
    );

    const executionRow = store.get('SELECT * FROM execution WHERE execution_id = ?', [executionId]);
    appendAudit(store, {
      action: AUDIT_ACTIONS.APPROVAL_APPROVE,
      actorType: input.actorType ?? 'console',
      actorId: input.actorId ?? approver.account_id,
      objectDigest: String(row.canonical_digest),
      payload: { approval_id: input.approval_id, proposal_id: String(row.proposal_id), execution_id: executionId },
      timestamp: now,
    });
    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_CREATE,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      // object_digest 必须是 64 位 hex 摘要，不能直接把 UUID 当摘要塞进去。
      objectDigest: sha256Hex(String(executionRow.execution_id)),
      payload: { execution_id: executionId, attempt_id: attemptId, action_id: proposalValue.action_id },
      timestamp: now,
    });

    return Object.freeze({
      approval_id: input.approval_id,
      state: 'approved',
      execution_id: executionId,
      attempt_id: attemptId,
      duplicate: false,
    });
  });
}

/**
 * T3b：approved → consumed，execution → dispatch_pending，写 Grant 与持久 outbox。
 *
 * nonce 的唯一消费点就在这里：`UPDATE ... WHERE state = 'approved'` 的
 * `changes` 必须为 1，否则说明已经被别人消费过，直接拒绝而不是"再签一份"。
 */
export function prepareDispatch(store, input) {
  store.assertWritable('prepareDispatch');
  if (input === null || typeof input !== 'object' || typeof input.approval_id !== 'string') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'prepareDispatch requires approval_id');
  }

  return store.tx('T3b', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const nowMs = msFromIso(now);
    const row = loadApproval(store, input.approval_id);
    const state = String(row.state);
    if (state === 'consumed') {
      throw new StoreError(STORE_CODES.ERR_NONCE_CONSUMED, 'approval nonce was already consumed', {
        approval_id: input.approval_id,
      });
    }
    if (state !== 'approved') {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_STATE, `cannot dispatch a ${state} approval`, {
        approval_id: input.approval_id,
        state,
      });
    }
    if (nowMs >= Number(row.expires_at_ms)) {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_EXPIRED, 'approval TTL expired before dispatch');
    }
    if (String(row.epoch) !== store.epoch()) {
      throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'approval epoch does not match the current epoch');
    }
    const execution = loadExecutionByApproval(store, input.approval_id);
    if (String(execution.state) !== 'approved') {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, `cannot prepare dispatch for a ${execution.state} execution`, {
        execution_id: String(execution.execution_id),
        state: String(execution.state),
      });
    }

    const consumed = store.run(
      "UPDATE approval SET state = 'consumed', consumed_at = ?, updated_at = ? WHERE approval_id = ? AND state = 'approved'",
      [now, now, input.approval_id],
    );
    if (Number(consumed.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_NONCE_CONSUMED, 'approval nonce was consumed concurrently', {
        approval_id: input.approval_id,
      });
    }

    const draft = {
      schemaVersion: '1.0',
      execution_id: String(execution.execution_id),
      approval_id: input.approval_id,
      action_id: String(execution.action_id),
      action_digest: String(execution.action_digest),
      parameters_digest: String(execution.parameters_digest),
      target_digest: String(execution.target_digest),
      nonce: String(execution.nonce),
      not_before: now,
      // 取审批 TTL 与"短期授权上限"的较小者：审批可以放 30 分钟，凭据不行。
      expires_at: isoFromMs(Math.min(Number(execution.expires_at_ms), msFromIso(now) + GRANT_MAX_TTL_MS)),
      epoch: String(execution.epoch),
    };
    draft.signature = hmacBase64(signingKey(store), grantSigningPayload(draft));
    const grantRecord = validateExecutionGrant(draft);

    // 把 Grant 的实际到期时间写回 execution：否则"5 分钟短期凭据"只在 JSON 里，
    // accept/beginExecuting 无从校验（它们读的是 execution.expires_at_ms）。
    const pending = store.run(
      `UPDATE execution
          SET state = 'dispatch_pending', grant_json = ?, grant_digest = ?, not_before = ?,
              expires_at = ?, expires_at_ms = ?, updated_at = ?
        WHERE execution_id = ? AND state = 'approved'`,
      [
        canonicalize(grantRecord.value),
        grantRecord.digest,
        now,
        grantRecord.value.expires_at,
        msFromIso(grantRecord.value.expires_at),
        now,
        String(execution.execution_id),
      ],
    );
    if (Number(pending.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution is not awaiting dispatch');
    }
    store.run(
      `INSERT INTO execution_outbox (outbox_id, execution_id, attempt_id, grant_digest, state, attempts, created_at, dispatched_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL)`,
      [uuid(), String(execution.execution_id), String(execution.attempt_id), grantRecord.digest, now],
    );

    appendAudit(store, {
      action: AUDIT_ACTIONS.APPROVAL_CONSUME,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      objectDigest: String(row.canonical_digest),
      payload: { approval_id: input.approval_id },
      timestamp: now,
    });
    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_DISPATCH,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      objectDigest: grantRecord.digest,
      payload: { execution_id: String(execution.execution_id), attempt_id: String(execution.attempt_id) },
      timestamp: now,
    });

    return Object.freeze({
      execution_id: String(execution.execution_id),
      attempt_id: String(execution.attempt_id),
      state: 'dispatch_pending',
      grant: grantRecord.value,
      grant_digest: grantRecord.digest,
    });
  });
}

/**
 * T3c 前半：outbox 标记 dispatched。
 *
 * 重复调用是幂等的（返回 `duplicate: true`），因为"投递确认丢了"和
 * "没投递"在外部看起来一样，重复标记本身没有副作用。
 */
export function markExecutionDispatched(store, input) {
  store.assertWritable('markExecutionDispatched');
  return store.tx('T3c-dispatched', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const outbox = store.get('SELECT * FROM execution_outbox WHERE execution_id = ? AND attempt_id = ?', [
      input.execution_id,
      input.attempt_id,
    ]);
    if (outbox === null) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_NOT_FOUND, 'no outbox row for this execution attempt', {
        execution_id: input.execution_id,
        attempt_id: input.attempt_id,
      });
    }
    const execution = store.get('SELECT epoch, state FROM execution WHERE execution_id = ?', [input.execution_id]);
    if (execution === null) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_NOT_FOUND, 'outbox row has no execution');
    }
    // 投递确认是"旧 Grant 真的被送出去"的最后一环；epoch 闸门必须在幂等短路**之前**，
    // 否则恢复后调用方会收到 duplicate:true 而误以为新 epoch 下确认成功。
    if (String(execution.epoch) !== store.epoch()) {
      throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'execution epoch does not match the current epoch', {
        execution_epoch: String(execution.epoch),
        current: store.epoch(),
      });
    }
    if (String(outbox.state) === 'dispatched' || String(outbox.state) === 'acked') {
      return Object.freeze({ execution_id: input.execution_id, state: String(outbox.state), duplicate: true });
    }
    const outboxUpdate = store.run(
      `UPDATE execution_outbox SET state = 'dispatched', dispatched_at = ?, attempts = attempts + 1
        WHERE execution_id = ? AND attempt_id = ? AND state = 'pending'`,
      [now, input.execution_id, input.attempt_id],
    );
    if (Number(outboxUpdate.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'outbox state changed concurrently');
    }
    const executionUpdate = store.run(
      `UPDATE execution SET state = 'dispatched', updated_at = ?
        WHERE execution_id = ? AND state = 'dispatch_pending'`,
      [now, input.execution_id],
    );
    if (Number(executionUpdate.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution is not awaiting dispatch');
    }
    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_DISPATCH,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      objectDigest: String(outbox.grant_digest),
      payload: {
        execution_id: input.execution_id,
        attempt_id: input.attempt_id,
        phase: 'dispatched',
      },
      timestamp: now,
    });
    return Object.freeze({ execution_id: input.execution_id, state: 'dispatched', duplicate: false });
  });
}

/**
 * 重投：只用**同一条** Grant 重发，绝不生成新的 execution/attempt/动作。
 *
 * 只有 dispatch_pending / dispatched 允许重投；进入 accepted 之后重投没有意义
 * （helper 已经受理），进入 executing 之后更是不能重发。
 *
 * 两道闸（P1-3）：
 * 1. **次数上限** `MAX_REDELIVER_ATTEMPTS`：达到后执行转 `manual_required`，
 *    并写一条 `execution.manual_required` 审计，然后才抛出拒绝——
 *    状态推进必须在**独立事务**里先提交，否则"抛异常"会把留痕一起回滚掉；
 * 2. **最小间隔** `MIN_REDELIVER_INTERVAL_MS`：用 outbox 的
 *    `last_redeliver_at`（没有则 `dispatched_at`）算距上次投递的时间。
 *    首发与第一次重投不受此限（需要立即补偿），从第二次重投开始生效。
 */
export function redeliverExecution(store, input) {
  store.assertWritable('redeliverExecution');
  const maxAttempts = Number.isInteger(input.max_attempts) ? input.max_attempts : MAX_REDELIVER_ATTEMPTS;
  const minIntervalMs = Number.isInteger(input.min_interval_ms)
    ? input.min_interval_ms
    : MIN_REDELIVER_INTERVAL_MS;
  const exhausted = redeliveryBudgetExhausted(store, input, maxAttempts);
  if (exhausted !== null) {
    // 先落库再拒绝：转人工与审计必须在同一个已提交的事务里。
    store.tx('T3c-redeliver-limit', () => {
      const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
      const moved = store.run(
        `UPDATE execution SET state = 'manual_required', updated_at = ?
          WHERE execution_id = ? AND state IN ('dispatch_pending','dispatched')`,
        [now, input.execution_id],
      );
      if (Number(moved.changes) !== 1) {
        throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution state changed while recording the redelivery limit', {
          execution_id: input.execution_id,
        });
      }
      appendAudit(store, {
        action: AUDIT_ACTIONS.EXECUTION_MANUAL,
        actorType: input.actorType ?? 'daemon',
        actorId: input.actorId ?? 'aegis-core',
        objectDigest: sha256Hex(`redeliver-limit:${input.execution_id}:${exhausted.attempts}`),
        payload: {
          execution_id: input.execution_id,
          attempt_id: exhausted.attempt_id,
          reason: 'redeliver_limit_exceeded',
          attempts: exhausted.attempts,
          max_attempts: maxAttempts,
        },
        timestamp: now,
      });
    });
    throw new StoreError(
      STORE_CODES.ERR_REDELIVER_LIMIT,
      `redelivery limit reached (${exhausted.attempts}/${maxAttempts}); execution moved to manual_required`,
      {
        execution_id: input.execution_id,
        attempts: exhausted.attempts,
        max_attempts: maxAttempts,
      },
    );
  }

  return store.tx('T3c-redeliver', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const nowMs = msFromIso(now);
    const execution = store.get('SELECT * FROM execution WHERE execution_id = ?', [input.execution_id]);
    if (execution === null) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_NOT_FOUND, `unknown execution ${input.execution_id}`);
    }
    if (String(execution.epoch) !== store.epoch()) {
      throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'execution epoch does not match the current epoch', {
        execution_epoch: String(execution.epoch),
        current: store.epoch(),
      });
    }
    const state = String(execution.state);
    if (state !== 'dispatch_pending' && state !== 'dispatched') {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, `cannot redeliver a ${state} execution`, {
        execution_id: input.execution_id,
        state,
      });
    }
    if (execution.grant_json === null) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution has no grant to redeliver');
    }
    const grant = JSON.parse(String(execution.grant_json));
    // TTL 是 Grant 的硬边界：过期凭据被"原样重投"，helper 收到的是已经作废的
    // 授权，而且从消息里看不出新旧。两个来源都查——execution 上回写的到期时间
    // （accept/beginExecuting 用的就是它）与 Grant 自身的 `expires_at`。
    const expiries = [];
    if (execution.expires_at_ms !== null) expiries.push(Number(execution.expires_at_ms));
    if (typeof grant.expires_at === 'string') {
      const grantExpiresMs = Date.parse(grant.expires_at);
      if (Number.isFinite(grantExpiresMs)) expiries.push(grantExpiresMs);
    }
    if (expiries.length > 0 && nowMs >= Math.min(...expiries)) {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_EXPIRED, 'execution grant expired; refusing to redeliver a stale grant', {
        execution_id: input.execution_id,
        expires_at: typeof grant.expires_at === 'string' ? grant.expires_at : null,
        now,
      });
    }
    const outboxRow = store.get(
      'SELECT attempts, dispatched_at, last_redeliver_at FROM execution_outbox WHERE execution_id = ? AND attempt_id = ?',
      [input.execution_id, String(execution.attempt_id)],
    );
    if (outboxRow === null) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_NOT_FOUND, 'no outbox row for this execution attempt', {
        execution_id: input.execution_id,
        attempt_id: String(execution.attempt_id),
      });
    }
    const previousAttempts = Number(outboxRow.attempts);
    const lastAt = outboxRow.last_redeliver_at ?? outboxRow.dispatched_at;
    if (previousAttempts >= 2 && lastAt !== null) {
      const elapsedMs = nowMs - msFromIso(String(lastAt));
      if (elapsedMs < minIntervalMs) {
        throw new StoreError(
          STORE_CODES.ERR_REDELIVER_TOO_SOON,
          `redelivery is throttled: ${elapsedMs}ms since last delivery, minimum is ${minIntervalMs}ms`,
          { execution_id: input.execution_id, elapsed_ms: elapsedMs, min_interval_ms: minIntervalMs },
        );
      }
    }
    store.run(
      `UPDATE execution_outbox
          SET attempts = attempts + 1, state = 'dispatched',
              dispatched_at = COALESCE(dispatched_at, ?), last_redeliver_at = ?
        WHERE execution_id = ? AND attempt_id = ?`,
      [now, now, input.execution_id, String(execution.attempt_id)],
    );
    // 回读真实 attempts，而不是把 UPDATE 的 changes（恒为 1）当成重投次数。
    const outbox = store.get('SELECT attempts FROM execution_outbox WHERE execution_id = ? AND attempt_id = ?', [
      input.execution_id,
      String(execution.attempt_id),
    ]);
    return Object.freeze({
      execution_id: String(execution.execution_id),
      attempt_id: String(execution.attempt_id),
      grant,
      grant_digest: String(execution.grant_digest),
      attempts: outbox === null ? 0 : Number(outbox.attempts),
      state,
      limit: { max_attempts: maxAttempts, min_interval_ms: minIntervalMs },
    });
  });
}

/**
 * 只读探测：这条 outbox 是否已经用完了重投预算。
 *
 * 探到超限时主流程必须**先提交**转人工与审计，再抛拒绝——因此探测与执行
 * 分成两步。单写者 + 同步 API，两步之间没有别人能插进来。
 */
function redeliveryBudgetExhausted(store, input, maxAttempts) {
  const execution = store.get('SELECT state, attempt_id FROM execution WHERE execution_id = ?', [input.execution_id]);
  if (execution === null) return null;
  const state = String(execution.state);
  if (state !== 'dispatch_pending' && state !== 'dispatched') return null;
  const outbox = store.get(
    'SELECT attempts FROM execution_outbox WHERE execution_id = ? AND attempt_id = ?',
    [input.execution_id, String(execution.attempt_id)],
  );
  if (outbox === null) return null;
  const attempts = Number(outbox.attempts);
  if (attempts < maxAttempts) return null;
  return { attempts, attempt_id: String(execution.attempt_id) };
}

/**
 * T3c 后半：helper 受理。
 *
 * inbox 以 `(execution_id, attempt_id, seq, kind)` 去重：同一条受理消息重复投递
 * 只会得到 `duplicate: true`，不会把状态再推一遍，也不会换 owner。
 */
export function acceptExecution(store, input) {
  store.assertWritable('acceptExecution');
  if (input === null || typeof input !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'acceptExecution requires an input object');
  }
  const seq = Number.isInteger(input.seq) ? input.seq : 1;
  // seq 由 helper 自报，而 inbox 的主键含 seq：不设上限就等于允许调用方
  // 用"随便报个大 seq"无限撑大 inbox（seq=2..20 → 19 行"受理记录"）。
  if (input.seq !== undefined && (!Number.isInteger(seq) || seq < 1 || seq > MAX_ACCEPT_SEQ)) {
    throw new StoreError(
      STORE_CODES.ERR_INBOX_SEQ_OUT_OF_RANGE,
      `accept seq must be an integer in [1, ${MAX_ACCEPT_SEQ}]`,
      { seq: input.seq, max_seq: MAX_ACCEPT_SEQ },
    );
  }
  return store.tx('T3c-accept', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const execution = store.get('SELECT * FROM execution WHERE execution_id = ?', [input.execution_id]);
    if (execution === null) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_NOT_FOUND, `unknown execution ${input.execution_id}`);
    }
    if (String(execution.attempt_id) !== String(input.attempt_id)) {
      throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'attempt_id does not belong to this execution', {
        execution_id: input.execution_id,
        attempt_id: input.attempt_id,
      });
    }
    // 恢复后旧 epoch 的授权不能被受理：AT-STORE-003。
    if (String(execution.epoch) !== store.epoch()) {
      throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'execution epoch does not match the current epoch', {
        execution_epoch: String(execution.epoch),
        current: store.epoch(),
      });
    }
    // 过期凭据不得被受理：TTL 写进 Grant 却没有校验点等于没写。
    if (execution.expires_at_ms !== null && msFromIso(now) >= Number(execution.expires_at_ms)) {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_EXPIRED, 'execution grant has expired', {
        execution_id: input.execution_id,
        expires_at: execution.expires_at === null ? null : String(execution.expires_at),
      });
    }
    assertResponseCapabilityOpen(store);

    const digest = canonicalDigest({ execution_id: input.execution_id, attempt_id: input.attempt_id, seq });
    const inbox = store.run(
      `INSERT INTO execution_inbox (execution_id, attempt_id, seq, kind, payload_digest, received_at)
       VALUES (?, ?, ?, 'accepted', ?, ?)
       ON CONFLICT (execution_id, attempt_id, seq, kind) DO NOTHING`,
      [input.execution_id, input.attempt_id, seq, digest, now],
    );

    const state = String(execution.state);
    if (Number(inbox.changes) === 0) {
      return Object.freeze({
        execution_id: String(execution.execution_id),
        state,
        duplicate: true,
        owner: execution.owner === null ? null : String(execution.owner),
      });
    }
    if (state !== 'dispatch_pending' && state !== 'dispatched') {
      // 受理消息到时执行已经推进（甚至已终态）：这是幂等确认，不是状态回退。
      return Object.freeze({
        execution_id: String(execution.execution_id),
        state,
        duplicate: true,
        owner: execution.owner === null ? null : String(execution.owner),
      });
    }

    const owner = typeof input.owner === 'string' && input.owner.length > 0 ? input.owner : 'aegis-helper';
    const leaseMs = Number.isInteger(input.lease_ms) ? input.lease_ms : 60000;
    const updated = store.run(
      `UPDATE execution SET state = 'accepted', owner = ?, lease_expires_at_ms = ?, accepted_at = ?, updated_at = ?
        WHERE execution_id = ? AND state IN ('dispatch_pending','dispatched')`,
      [owner, msFromIso(now) + leaseMs, now, now, input.execution_id],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution state changed concurrently');
    }
    const acked = store.run(
      "UPDATE execution_outbox SET state = 'acked' WHERE execution_id = ? AND attempt_id = ?",
      [input.execution_id, input.attempt_id],
    );
    if (Number(acked.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'outbox row vanished during accept');
    }
    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_ACCEPT,
      actorType: input.actorType ?? 'helper',
      actorId: input.actorId ?? owner,
      objectDigest: String(execution.grant_digest ?? digest),
      payload: { execution_id: input.execution_id, attempt_id: input.attempt_id, seq },
      timestamp: now,
    });
    return Object.freeze({
      execution_id: String(execution.execution_id),
      state: 'accepted',
      duplicate: false,
      owner,
    });
  });
}

export function getApproval(store, approvalId) {
  return store.get('SELECT * FROM approval WHERE approval_id = ?', [approvalId]);
}

export function getExecution(store, executionId) {
  return store.get('SELECT * FROM execution WHERE execution_id = ?', [executionId]);
}

export function getExecutionOutbox(store, executionId) {
  return store.all('SELECT * FROM execution_outbox WHERE execution_id = ? ORDER BY created_at', [executionId]);
}
