/**
 * T4 结算、恢复清单与租约核对。
 *
 * 三条不可让步的规则：
 *
 * 1. **副作用前先写意图**：`beginExecuting` 要求该 attempt 已经有一条
 *    `prepared`（或 `not_required`）的恢复清单。没有清单就进入 executing 会被拒绝——
 *    这是"清单先于副作用"在存储层的硬约束，而不是调用方的自觉。
 * 2. **结果唯一**：`(execution_id, result_seq)` 唯一。重复结果返回幂等确认，
 *    不会二次执行，也不会覆盖已终态。
 * 3. **租约过期只核对**：`sweepExpiredExecutionLeases` 只置 `need_reconcile`
 *    （executing 状态按设计转 `result_unknown`），**不会**重投、不会重置 owner。
 *    任何"再来一次"都必须由人显式发起。
 */

import { LIMITS, canonicalize, canonicalSize } from '../../contracts/src/index.js';

import { AUDIT_ACTIONS, appendAudit } from './audit.js';
import { STORE_CODES, StoreError } from './errors.js';
import { canonicalDigest, msFromIso, sha256Hex, uuid } from './util.js';

export const EXECUTION_STATES = Object.freeze([
  'approved',
  'dispatch_pending',
  'dispatched',
  'accepted',
  'executing',
  'succeeded',
  'failed',
  'result_unknown',
  'reconciling',
  'manual_required',
  'cancelled',
]);

export const TERMINAL_EXECUTION_STATES = Object.freeze(['succeeded', 'failed', 'manual_required', 'cancelled']);

/** 恢复/回滚清单的状态迁移表：白名单式，未列出的一律拒绝。 */
export const RECOVERY_TRANSITIONS = Object.freeze({
  not_required: Object.freeze([]),
  pending: Object.freeze(['prepared', 'executing', 'not_required']),
  prepared: Object.freeze(['executing', 'manual_required']),
  executing: Object.freeze(['applied', 'manual_required']),
  applied: Object.freeze(['restoring', 'succeeded', 'failed', 'manual_required']),
  restoring: Object.freeze(['restored', 'manual_required']),
  restored: Object.freeze([]),
  succeeded: Object.freeze(['pending', 'manual_required']),
  failed: Object.freeze(['pending', 'manual_required']),
  manual_required: Object.freeze(['pending', 'restored']),
});

function loadExecution(store, executionId) {
  const row = store.get('SELECT * FROM execution WHERE execution_id = ?', [executionId]);
  if (row === null) {
    throw new StoreError(STORE_CODES.ERR_EXECUTION_NOT_FOUND, `unknown execution ${executionId}`, {
      execution_id: executionId,
    });
  }
  return row;
}

/** 恢复后旧 epoch 的记录一律不推进：审批、授权、租约、结果全部绑定 epoch。 */
function assertExecutionEpoch(store, row) {
  if (String(row.epoch) !== store.epoch()) {
    throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'execution epoch does not match the current epoch', {
      execution_id: String(row.execution_id),
      execution_epoch: String(row.epoch),
      current: store.epoch(),
    });
  }
}

function assertOwnerLease(row, input, nowMs) {
  if (row.owner === null || String(row.owner) !== String(input.owner)) {
    throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'owner does not hold this execution', {
      execution_id: String(row.execution_id),
      expected: row.owner === null ? null : String(row.owner),
      actual: input.owner ?? null,
    });
  }
  const lease = row.lease_expires_at_ms === null ? null : Number(row.lease_expires_at_ms);
  if (lease === null || nowMs > lease) {
    throw new StoreError(STORE_CODES.ERR_LEASE_EXPIRED, 'lease has expired; only reconciliation is allowed', {
      execution_id: String(row.execution_id),
      lease_expires_at_ms: lease,
      now_ms: nowMs,
    });
  }
}

/** 恢复清单的创建。`state` 只允许 prepared / not_required（由动作是否需要回滚决定）。 */
export function writeRecoveryManifest(store, input) {
  store.assertWritable('writeRecoveryManifest');
  if (input === null || typeof input !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'writeRecoveryManifest requires an input object');
  }
  return store.tx('T4-manifest', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const execution = loadExecution(store, input.execution_id);
    if (String(execution.attempt_id) !== String(input.attempt_id)) {
      throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'attempt_id does not belong to this execution');
    }
    const existing = store.get('SELECT recovery_id, state FROM recovery_manifest WHERE attempt_id = ?', [input.attempt_id]);
    if (existing !== null) {
      return Object.freeze({
        recovery_id: String(existing.recovery_id),
        state: String(existing.state),
        duplicate: true,
      });
    }
    const state = input.state === 'not_required' ? 'not_required' : 'prepared';
    const recoveryId = typeof input.recovery_id === 'string' && input.recovery_id.length > 0 ? input.recovery_id : uuid();
    const operationId = typeof input.operation_id === 'string' && input.operation_id.length > 0 ? input.operation_id : uuid();
    store.run(
      `INSERT INTO recovery_manifest (
         recovery_id, execution_id, attempt_id, operation_id, action_id, target_digest,
         object_identity_json, before_state_json, after_state_json, state, prepared_at, updated_at, seq
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        recoveryId,
        input.execution_id,
        input.attempt_id,
        operationId,
        String(execution.action_id),
        String(execution.target_digest),
        canonicalize(input.object_identity ?? {}),
        canonicalize(input.before_state ?? {}),
        canonicalize(input.after_state ?? {}),
        state,
        now,
        now,
      ],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.RECOVERY_TRANSITION,
      actorType: input.actorType ?? 'helper',
      actorId: input.actorId ?? 'aegis-helper',
      objectDigest: String(execution.target_digest),
      payload: { recovery_id: recoveryId, execution_id: input.execution_id, state, phase: 'prepared' },
      timestamp: now,
    });
    return Object.freeze({ recovery_id: recoveryId, state, duplicate: false, operation_id: operationId });
  });
}

/** 恢复清单状态迁移（白名单 + 条件更新，防止并发下两个方向同时推进）。 */
export function transitionRecovery(store, input) {
  store.assertWritable('transitionRecovery');
  return store.tx('T4-recovery', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = store.get('SELECT * FROM recovery_manifest WHERE recovery_id = ?', [input.recovery_id]);
    if (row === null) {
      throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `unknown recovery manifest ${input.recovery_id}`);
    }
    const from = String(row.state);
    if (from === input.state) {
      return Object.freeze({ recovery_id: input.recovery_id, state: from, duplicate: true });
    }
    const allowed = RECOVERY_TRANSITIONS[from] ?? [];
    if (!allowed.includes(input.state)) {
      throw new StoreError(
        STORE_CODES.ERR_RECOVERY_STATE,
        `recovery manifest cannot move ${from} -> ${input.state}`,
        { recovery_id: input.recovery_id, from, to: input.state, allowed },
      );
    }
    const updated = store.run(
      'UPDATE recovery_manifest SET state = ?, updated_at = ?, seq = seq + 1 WHERE recovery_id = ? AND state = ?',
      [input.state, now, input.recovery_id, from],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_RECOVERY_STATE, 'recovery manifest state changed concurrently');
    }
    appendAudit(store, {
      action: AUDIT_ACTIONS.RECOVERY_TRANSITION,
      actorType: input.actorType ?? 'helper',
      actorId: input.actorId ?? 'aegis-helper',
      objectDigest: String(row.target_digest),
      payload: { recovery_id: input.recovery_id, from, to: input.state },
      timestamp: now,
    });
    return Object.freeze({ recovery_id: input.recovery_id, state: input.state, duplicate: false });
  });
}

/**
 * accepted → executing。
 *
 * 前置：该 attempt 的恢复清单必须已 prepared（或 not_required）。
 * 缺清单就是"还没写意图就要动手"，直接拒绝——这条约束不能被调用方绕过。
 */
export function beginExecuting(store, input) {
  store.assertWritable('beginExecuting');
  return store.tx('T4-executing', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadExecution(store, input.execution_id);
    assertExecutionEpoch(store, row);
    const state = String(row.state);
    if (state === 'executing') {
      return Object.freeze({ execution_id: String(row.execution_id), state, duplicate: true });
    }
    if (state !== 'accepted') {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, `cannot start executing from ${state}`, {
        execution_id: input.execution_id,
        state,
      });
    }
    assertOwnerLease(row, input, msFromIso(now));
    const manifest = store.get('SELECT state FROM recovery_manifest WHERE attempt_id = ?', [String(row.attempt_id)]);
    if (manifest === null || (String(manifest.state) !== 'prepared' && String(manifest.state) !== 'not_required')) {
      throw new StoreError(
        STORE_CODES.ERR_RECOVERY_STATE,
        'a prepared recovery manifest must exist before any side effect',
        { execution_id: input.execution_id, manifest_state: manifest === null ? null : String(manifest.state) },
      );
    }
    const updated = store.run(
      `UPDATE execution SET state = 'executing', executing_at = ?, updated_at = ?
        WHERE execution_id = ? AND state = 'accepted'`,
      [now, now, input.execution_id],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution state changed concurrently');
    }
    // "5 分钟短期凭据"必须有强制点：进入执行前再核对一次授权 TTL。
    if (row.expires_at_ms !== null && msFromIso(now) >= Number(row.expires_at_ms)) {
      throw new StoreError(STORE_CODES.ERR_APPROVAL_EXPIRED, 'execution grant has expired', {
        execution_id: input.execution_id,
        expires_at: row.expires_at === null ? null : String(row.expires_at),
      });
    }
    if (String(manifest.state) === 'prepared') {
      // 清单与执行同一步推进：开始动手 = 清单进入 executing。
      // 只把 execution 推进而把清单留在 prepared，会让结算阶段无法判定实际状态。
      store.run(
        "UPDATE recovery_manifest SET state = 'executing', updated_at = ?, seq = seq + 1 WHERE attempt_id = ? AND state = 'prepared'",
        [now, String(row.attempt_id)],
      );
    }
    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_EXECUTING,
      actorType: input.actorType ?? 'helper',
      actorId: input.actorId ?? String(row.owner),
      objectDigest: String(row.grant_digest ?? row.target_digest),
      payload: { execution_id: input.execution_id, attempt_id: String(row.attempt_id) },
      timestamp: now,
    });
    return Object.freeze({ execution_id: String(row.execution_id), state: 'executing', duplicate: false });
  });
}

/**
 * executing（或已核对中的 result_unknown）→ result_unknown。
 *
 * 这一步是"失去结果"的唯一合法落点：不猜成功、不猜失败、不重试。
 */
export function markResultUnknown(store, input) {
  store.assertWritable('markResultUnknown');
  return store.tx('T4-unknown', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadExecution(store, input.execution_id);
    assertExecutionEpoch(store, row);
    const state = String(row.state);
    if (state === 'result_unknown') {
      return Object.freeze({ execution_id: String(row.execution_id), state, duplicate: true });
    }
    if (!['dispatched', 'accepted', 'executing'].includes(state)) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, `cannot mark a ${state} execution as result_unknown`, {
        execution_id: input.execution_id,
        state,
      });
    }
    const updated = store.run(
      `UPDATE execution SET state = 'result_unknown', need_reconcile = 1, updated_at = ?
        WHERE execution_id = ? AND state IN ('dispatched','accepted','executing')`,
      [now, input.execution_id],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution state changed concurrently');
    }
    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_UNKNOWN,
      actorType: input.actorType ?? 'helper',
      actorId: input.actorId ?? 'aegis-helper',
      objectDigest: String(row.grant_digest ?? row.target_digest),
      payload: { execution_id: input.execution_id, reason: input.reason ?? 'result_lost' },
      timestamp: now,
    });
    return Object.freeze({ execution_id: String(row.execution_id), state: 'result_unknown', duplicate: false });
  });
}

/**
 * result_unknown → reconciling。
 *
 * 返回 `next_action` 恒为 `query_only`：核对只允许向 helper 查询同一 attempt
 * 的实际状态，**不允许**重新投递、不允许生成新的动作。
 */
export function requestReconcile(store, input) {
  store.assertWritable('requestReconcile');
  return store.tx('T4-reconcile', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadExecution(store, input.execution_id);
    assertExecutionEpoch(store, row);
    const state = String(row.state);
    if (state === 'reconciling') {
      return Object.freeze({
        execution_id: String(row.execution_id),
        state,
        duplicate: true,
        next_action: 'query_only',
      });
    }
    if (state !== 'result_unknown') {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, `cannot reconcile a ${state} execution`, {
        execution_id: input.execution_id,
        state,
      });
    }
    const updated = store.run(
      "UPDATE execution SET state = 'reconciling', need_reconcile = 1, updated_at = ? WHERE execution_id = ? AND state = 'result_unknown'",
      [now, input.execution_id],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution state changed concurrently');
    }
    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_RECONCILE,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      objectDigest: String(row.grant_digest ?? row.target_digest),
      payload: { execution_id: input.execution_id, attempt_id: String(row.attempt_id) },
      timestamp: now,
    });
    return Object.freeze({
      execution_id: String(row.execution_id),
      state: 'reconciling',
      duplicate: false,
      next_action: 'query_only',
    });
  });
}

/**
 * T4：结算。
 *
 * 幂等键是 `(execution_id, result_seq)`。重复结果 = 幂等确认，
 * 既不二次执行，也不把已经终态的执行改回去。
 */
export function settleExecution(store, input) {
  store.assertWritable('settleExecution');
  if (input === null || typeof input !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'settleExecution requires an input object');
  }
  if (!['succeeded', 'failed'].includes(input.outcome)) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'outcome must be succeeded or failed');
  }
  const resultSeq = input.result_seq;
  if (!Number.isInteger(resultSeq) || resultSeq < 1) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'result_seq must be a positive integer');
  }

  return store.tx('T4', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadExecution(store, input.execution_id);
    if (String(row.attempt_id) !== String(input.attempt_id)) {
      throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'attempt_id does not belong to this execution', {
        execution_id: input.execution_id,
      });
    }
    // 恢复后旧 epoch 的执行不得继续结算：AT-STORE-003 要求旧授权/尝试失效。
    if (String(row.epoch) !== store.epoch()) {
      throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'execution epoch does not match the current epoch', {
        execution_epoch: String(row.epoch),
        current: store.epoch(),
      });
    }
    const state = String(row.state);

    const existingResult = store.get(
      'SELECT outcome, result_digest FROM execution_result WHERE execution_id = ? AND result_seq = ?',
      [input.execution_id, resultSeq],
    );
    if (existingResult !== null) {
      return Object.freeze({
        execution_id: String(row.execution_id),
        state,
        outcome: String(existingResult.outcome),
        duplicate: true,
        result_seq: resultSeq,
      });
    }
    if (TERMINAL_EXECUTION_STATES.includes(state)) {
      return Object.freeze({
        execution_id: String(row.execution_id),
        state,
        outcome: state === 'succeeded' || state === 'failed' ? state : null,
        duplicate: true,
        result_seq: resultSeq,
      });
    }
    // `result_unknown` 必须先经 requestReconcile 进入 reconciling 才能结算：
    // 否则"租约过期后 91 秒交上来的结果"会在这里被静默接受，90 秒硬上限形同虚设。
    if (!['dispatched', 'accepted', 'executing', 'reconciling'].includes(state)) {
      throw new StoreError(
        STORE_CODES.ERR_EXECUTION_STATE,
        state === 'result_unknown'
          ? 'result_unknown must be reconciled before settlement'
          : `cannot settle a ${state} execution`,
        { execution_id: input.execution_id, state },
      );
    }
    if (state === 'executing' || state === 'accepted') {
      assertOwnerLease(row, input, msFromIso(now));
    }
    // 任何真实副作用都必须先写恢复清单；没有清单就报告成功 = 无法核对来源的副作用。
    const manifestBefore = store.get('SELECT recovery_id, state FROM recovery_manifest WHERE attempt_id = ?', [
      String(row.attempt_id),
    ]);
    if (manifestBefore === null) {
      throw new StoreError(
        STORE_CODES.ERR_RECOVERY_STATE,
        'settlement requires a recovery manifest written before the side effect',
        { execution_id: input.execution_id, attempt_id: String(row.attempt_id) },
      );
    }

    const payload = input.result ?? {};
    if (canonicalSize(payload) > LIMITS.maxToolResultBytes) {
      throw new StoreError(
        STORE_CODES.ERR_STORE_INPUT,
        `execution result exceeds ${LIMITS.maxToolResultBytes} canonical bytes`,
        { execution_id: input.execution_id },
      );
    }
    const resultDigest = canonicalDigest(payload);
    store.run(
      `INSERT INTO execution_result (execution_id, result_seq, attempt_id, owner, outcome, result_json, result_digest, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.execution_id,
        resultSeq,
        input.attempt_id,
        String(input.owner ?? row.owner ?? 'unknown'),
        input.outcome,
        canonicalize(payload),
        resultDigest,
        now,
      ],
    );
    const updated = store.run(
      `UPDATE execution
          SET state = ?, settled_at = ?, last_result_seq = ?, need_reconcile = 0, updated_at = ?
        WHERE execution_id = ? AND state = ?`,
      [input.outcome, now, resultSeq, now, input.execution_id, state],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, 'execution state changed concurrently');
    }

    const manifest = manifestBefore;
    let manifestState = null;
    if (manifest !== null) {
      const current = String(manifest.state);
      const target = input.outcome === 'succeeded' ? 'applied' : 'failed';
      const allowed = RECOVERY_TRANSITIONS[current] ?? [];
      if (current === 'not_required') {
        // "无需回滚"的动作本来就没有状态要推进；把它改写成 manual_required 是**误报**，
        // 会让每一个无回滚动作都留下一条待人工清单。
        manifestState = 'not_required';
      } else if (current === target) {
        manifestState = current;
      } else if (allowed.includes(target)) {
        store.run('UPDATE recovery_manifest SET state = ?, updated_at = ?, seq = seq + 1 WHERE recovery_id = ?', [
          target,
          now,
          String(manifest.recovery_id),
        ]);
        manifestState = target;
      } else {
        // 清单状态与执行结论冲突（例如清单还在 prepared 却报告 succeeded）：
        // 不修正、不猜测，直接要求人工核对。
        store.run(
          "UPDATE recovery_manifest SET state = 'manual_required', updated_at = ?, seq = seq + 1 WHERE recovery_id = ?",
          [now, String(manifest.recovery_id)],
        );
        manifestState = 'manual_required';
      }
    }

    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_SETTLE,
      actorType: input.actorType ?? 'helper',
      actorId: input.actorId ?? 'aegis-helper',
      objectDigest: String(row.grant_digest ?? row.target_digest),
      payload: {
        execution_id: input.execution_id,
        attempt_id: input.attempt_id,
        result_seq: resultSeq,
        outcome: input.outcome,
        manifest_state: manifestState,
      },
      timestamp: now,
    });

    return Object.freeze({
      execution_id: String(row.execution_id),
      state: input.outcome,
      outcome: input.outcome,
      duplicate: false,
      result_seq: resultSeq,
      manifest_state: manifestState,
    });
  });
}

/** 任何非终态 → manual_required：唯一的"交给人"的出口。 */
export function markManualRequired(store, input) {
  store.assertWritable('markManualRequired');
  return store.tx('T4-manual', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadExecution(store, input.execution_id);
    assertExecutionEpoch(store, row);
    const state = String(row.state);
    if (state === 'manual_required') {
      return Object.freeze({ execution_id: String(row.execution_id), state, duplicate: true });
    }
    if (TERMINAL_EXECUTION_STATES.includes(state)) {
      throw new StoreError(STORE_CODES.ERR_EXECUTION_STATE, `a ${state} execution is already terminal`, {
        execution_id: input.execution_id,
        state,
      });
    }
    store.run(
      "UPDATE execution SET state = 'manual_required', need_reconcile = 1, updated_at = ? WHERE execution_id = ?",
      [now, input.execution_id],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.EXECUTION_MANUAL,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      objectDigest: String(row.grant_digest ?? row.target_digest),
      payload: { execution_id: input.execution_id, from: state, reason: input.reason ?? 'operator_required' },
      timestamp: now,
    });
    return Object.freeze({ execution_id: String(row.execution_id), state: 'manual_required', duplicate: false });
  });
}

/**
 * 租约过期扫描。
 *
 * 只产出"待核对"清单；`executing` 按设计转 `result_unknown`。
 * 不重投、不重置 owner、不新增 attempt——这些都需要操作员显式动作。
 */
export function sweepExpiredExecutionLeases(store, options = {}) {
  store.assertWritable('sweepExpiredExecutionLeases');
  return store.tx('T4-lease-sweep', () => {
    const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
    const nowMs = msFromIso(now);
    const candidates = store.all(
      `SELECT execution_id, attempt_id, state, owner, lease_expires_at_ms
         FROM execution
        WHERE state IN ('dispatched','accepted','executing')
          AND lease_expires_at_ms IS NOT NULL
          AND lease_expires_at_ms < ?
        ORDER BY lease_expires_at_ms`,
      [nowMs],
    );
    const results = [];
    for (const candidate of candidates) {
      const state = String(candidate.state);
      if (state === 'executing') {
        store.run(
          "UPDATE execution SET state = 'result_unknown', need_reconcile = 1, updated_at = ? WHERE execution_id = ? AND state = 'executing'",
          [now, String(candidate.execution_id)],
        );
        appendAudit(store, {
          action: AUDIT_ACTIONS.EXECUTION_UNKNOWN,
          actorType: options.actorType ?? 'daemon',
          actorId: options.actorId ?? 'aegis-core',
          objectDigest: sha256Hex(String(candidate.execution_id)),
          payload: { execution_id: String(candidate.execution_id), reason: 'lease_expired_while_executing' },
          timestamp: now,
        });
        results.push(Object.freeze({ execution_id: String(candidate.execution_id), state: 'result_unknown', action: 'reconcile' }));
      } else {
        store.run('UPDATE execution SET need_reconcile = 1, updated_at = ? WHERE execution_id = ?', [
          now,
          String(candidate.execution_id),
        ]);
        results.push(Object.freeze({ execution_id: String(candidate.execution_id), state, action: 'verify_with_helper' }));
      }
    }
    return Object.freeze({ scanned: candidates.length, results: Object.freeze(results) });
  });
}

export function getRecoveryManifestByAttempt(store, attemptId) {
  return store.get('SELECT * FROM recovery_manifest WHERE attempt_id = ?', [attemptId]);
}

export function getExecutionResults(store, executionId) {
  return store.all('SELECT * FROM execution_result WHERE execution_id = ? ORDER BY result_seq', [executionId]);
}

export function listExecutions(store, options = {}) {
  if (typeof options.state === 'string') {
    return store.all('SELECT * FROM execution WHERE state = ? ORDER BY created_at', [options.state]);
  }
  return store.all('SELECT * FROM execution ORDER BY created_at');
}
