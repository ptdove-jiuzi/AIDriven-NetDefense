/**
 * T5 分析完成事务（含 claim / 租约 / 迟到 attempt 拒绝）。
 *
 * 唯一的完成权威是 daemon 的这一条事务：broker 的 complete/fail 只是
 * **事务输入**，不是第二个状态权威。因此这里的一切都以
 * `analysis_id + attempt_id + owner + lease` 为条件更新前提；
 * 任何一个不匹配都直接拒绝，不做"尽力而为"的部分更新。
 *
 * 迟到 attempt（租约已过期）的结果一律拒绝：worker 第 91 秒交上来的结论
 * 和第 89 秒交上来的结论不能同等对待，否则 90 秒硬上限形同虚设。
 */

import { validateAnalysisReport, validateResponseProposal } from '../../contracts/src/index.js';

import { insertProposalRow } from './approval.js';
import { assertAnalysisCapabilityOpen } from './budget.js';
import { AUDIT_ACTIONS, appendAudit } from './audit.js';
import { STORE_CODES, StoreError } from './errors.js';
import { canonicalize, msFromIso, sha256Hex, uuid } from './util.js';

export const ANALYSIS_STATES = Object.freeze([
  'queued',
  'dispatched',
  'running',
  'succeeded',
  'degraded',
  'failed',
  'cancelled',
]);

export const TERMINAL_ANALYSIS_STATES = Object.freeze(['succeeded', 'degraded', 'failed', 'cancelled']);

export const DEFAULT_MAX_ANALYSIS_ATTEMPTS = 3;

function assertAnalysisEpoch(store, row) {
  if (String(row.epoch) !== store.epoch()) {
    throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'analysis epoch does not match the current epoch', {
      analysis_id: String(row.analysis_id),
      analysis_epoch: String(row.epoch),
      current: store.epoch(),
    });
  }
}

function loadAnalysis(store, analysisId) {
  const row = store.get('SELECT * FROM analysis_outbox WHERE analysis_id = ?', [analysisId]);
  if (row === null) {
    throw new StoreError(STORE_CODES.ERR_ANALYSIS_NOT_FOUND, `unknown analysis ${analysisId}`, {
      analysis_id: analysisId,
    });
  }
  return row;
}

/**
 * 原子 claim。
 *
 * `WHERE state = 'queued'` 的条件更新就是单消费者闸门：两个 broker 同时
 * claim 时，只有一个的 `changes` 会是 1，另一个拿到 `ERR_ANALYSIS_STATE`。
 */
export function claimAnalysis(store, input) {
  store.assertWritable('claimAnalysis');
  if (input === null || typeof input !== 'object' || typeof input.analysis_id !== 'string') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'claimAnalysis requires analysis_id');
  }
  return store.tx('T5-claim', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadAnalysis(store, input.analysis_id);
    const state = String(row.state);
    if (state !== 'queued') {
      throw new StoreError(
        STORE_CODES.ERR_ANALYSIS_STATE,
        `analysis is already ${state}; only a queued analysis can be claimed`,
        { analysis_id: input.analysis_id, state, owner: row.owner === null ? null : String(row.owner) },
      );
    }
    assertAnalysisEpoch(store, row);
    assertAnalysisCapabilityOpen(store);
    if (Number(row.attempt_seq) >= (Number.isInteger(input.max_attempts) ? input.max_attempts : DEFAULT_MAX_ANALYSIS_ATTEMPTS)) {
      throw new StoreError(STORE_CODES.ERR_ANALYSIS_STATE, 'attempt budget for this analysis is exhausted', {
        analysis_id: input.analysis_id,
        attempt_seq: Number(row.attempt_seq),
      });
    }
    const attemptId = typeof input.attempt_id === 'string' && input.attempt_id.length > 0 ? input.attempt_id : uuid();
    const leaseMs = Number.isInteger(input.lease_ms) ? input.lease_ms : 90000;
    const owner = typeof input.owner === 'string' && input.owner.length > 0 ? input.owner : 'aegis-broker';
    const updated = store.run(
      `UPDATE analysis_outbox
          SET state = 'dispatched', attempt_id = ?, attempt_seq = attempt_seq + 1, owner = ?,
              lease_expires_at_ms = ?, lease_expired = 0, claimed_at = ?, updated_at = ?
        WHERE analysis_id = ? AND state = 'queued'`,
      [attemptId, owner, msFromIso(now) + leaseMs, now, now, input.analysis_id],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_ANALYSIS_STATE, 'analysis was claimed concurrently', {
        analysis_id: input.analysis_id,
      });
    }
    appendAudit(store, {
      action: AUDIT_ACTIONS.ANALYSIS_CLAIM,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? owner,
      objectDigest: String(row.canonical_digest),
      payload: { analysis_id: input.analysis_id, attempt_id: attemptId, attempt_seq: Number(row.attempt_seq) + 1 },
      timestamp: now,
    });
    return Object.freeze({
      analysis_id: input.analysis_id,
      attempt_id: attemptId,
      attempt_seq: Number(row.attempt_seq) + 1,
      owner,
      lease_expires_at_ms: msFromIso(now) + leaseMs,
      state: 'dispatched',
    });
  });
}

/** dispatched → running，要带 attempt/owner/lease。 */
export function beginAnalysisRunning(store, input) {
  store.assertWritable('beginAnalysisRunning');
  return store.tx('T5-running', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadAnalysis(store, input.analysis_id);
    assertAnalysisEpoch(store, row);
    const state = String(row.state);
    if (state === 'running') {
      return Object.freeze({ analysis_id: input.analysis_id, state, duplicate: true });
    }
    if (state !== 'dispatched') {
      throw new StoreError(STORE_CODES.ERR_ANALYSIS_STATE, `cannot start running from ${state}`, {
        analysis_id: input.analysis_id,
        state,
      });
    }
    if (String(row.attempt_id) !== String(input.attempt_id) || String(row.owner) !== String(input.owner)) {
      throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'attempt/owner does not own this analysis', {
        analysis_id: input.analysis_id,
      });
    }
    if (row.lease_expires_at_ms === null || msFromIso(now) > Number(row.lease_expires_at_ms)) {
      throw new StoreError(STORE_CODES.ERR_LEASE_EXPIRED, 'analysis lease expired before running', {
        analysis_id: input.analysis_id,
      });
    }
    store.run(
      "UPDATE analysis_outbox SET state = 'running', updated_at = ? WHERE analysis_id = ? AND state = 'dispatched'",
      [now, input.analysis_id],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.ANALYSIS_RUNNING,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? String(input.owner),
      objectDigest: String(row.canonical_digest),
      payload: { analysis_id: input.analysis_id, attempt_id: String(input.attempt_id) },
      timestamp: now,
    });
    return Object.freeze({ analysis_id: input.analysis_id, state: 'running', duplicate: false });
  });
}

function assertAttemptOwnership(row, input, nowMs) {
  if (String(row.attempt_id ?? '') !== String(input.attempt_id ?? '')) {
    throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'late attempt: attempt_id mismatch', {
      analysis_id: String(row.analysis_id),
      expected_attempt: row.attempt_id === null ? null : String(row.attempt_id),
      actual_attempt: input.attempt_id ?? null,
    });
  }
  if (String(row.owner ?? '') !== String(input.owner ?? '')) {
    throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'late attempt: owner mismatch', {
      analysis_id: String(row.analysis_id),
    });
  }
  const lease = row.lease_expires_at_ms === null ? null : Number(row.lease_expires_at_ms);
  if (lease === null || nowMs > lease) {
    throw new StoreError(STORE_CODES.ERR_LEASE_EXPIRED, 'late attempt: lease already expired', {
      analysis_id: String(row.analysis_id),
      lease_expires_at_ms: lease,
      now_ms: nowMs,
    });
  }
}

/**
 * T5：报告（+ 可选 Proposal）+ 分析终态 + 审计，一个事务。
 *
 * @param {object} store
 * @param {{
 *   analysis_id: string, attempt_id: string, owner: string,
 *   report: object, proposal?: object|null, outcome?: 'succeeded'|'degraded',
 *   now?: string, actorId?: string, actorType?: string,
 * }} input
 */
export function completeAnalysis(store, input) {
  store.assertWritable('completeAnalysis');
  if (input === null || typeof input !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'completeAnalysis requires an input object');
  }
  // 合同校验放事务外：非法报告不该占用写锁。
  const reportRecord = validateAnalysisReport(input.report);
  const proposalRecord = input.proposal === undefined || input.proposal === null
    ? null
    : validateResponseProposal(input.proposal);
  const outcome = input.outcome ?? 'succeeded';
  if (outcome !== 'succeeded' && outcome !== 'degraded') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'outcome must be succeeded or degraded');
  }

  return store.tx('T5', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const nowMs = msFromIso(now);
    const row = loadAnalysis(store, input.analysis_id);
    assertAnalysisEpoch(store, row);
    const state = String(row.state);

    if (String(reportRecord.value.analysis_id) !== input.analysis_id) {
      throw new StoreError(
        STORE_CODES.ERR_BINDING_MISMATCH,
        'report.analysis_id does not match the analysis being completed',
        { expected: input.analysis_id, actual: String(reportRecord.value.analysis_id) },
      );
    }

    const existingReport = store.get('SELECT report_digest FROM analysis_report WHERE analysis_id = ?', [
      input.analysis_id,
    ]);
    if (existingReport !== null) {
      // 重复 complete：幂等确认，不覆盖已提交结果。
      return Object.freeze({
        analysis_id: input.analysis_id,
        state,
        duplicate: true,
        report_digest: String(existingReport.report_digest),
        proposal_id: null,
      });
    }
    if (TERMINAL_ANALYSIS_STATES.includes(state)) {
      return Object.freeze({
        analysis_id: input.analysis_id,
        state,
        duplicate: true,
        report_digest: null,
        proposal_id: null,
      });
    }
    assertAttemptOwnership(row, input, nowMs);

    store.run(
      `INSERT INTO analysis_report (analysis_id, report_json, report_digest, canonical_json, created_at, attempt_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.analysis_id,
        canonicalize(reportRecord.value),
        reportRecord.digest,
        canonicalize(reportRecord.value),
        now,
        String(input.attempt_id),
      ],
    );

    let proposalId = null;
    if (proposalRecord !== null) {
      if (proposalRecord.value.analysis_id !== input.analysis_id) {
        throw new StoreError(
          STORE_CODES.ERR_BINDING_MISMATCH,
          'proposal.analysis_id does not match the analysis being completed',
          { expected: input.analysis_id, actual: proposalRecord.value.analysis_id },
        );
      }
      const existingProposal = store.get('SELECT proposal_id FROM response_proposal WHERE proposal_id = ?', [
        proposalRecord.value.proposal_id,
      ]);
      if (existingProposal === null) {
        const inserted = insertProposalRow(store, proposalRecord, now);
        proposalId = inserted.proposal_id;
      } else {
        proposalId = String(existingProposal.proposal_id);
      }
    }

    const updated = store.run(
      `UPDATE analysis_outbox
          SET state = ?, completed_at = ?, report_digest = ?, lease_expired = 0, updated_at = ?
        WHERE analysis_id = ? AND attempt_id = ? AND owner = ? AND state IN ('dispatched','running')`,
      [outcome, now, reportRecord.digest, now, input.analysis_id, String(input.attempt_id), String(input.owner)],
    );
    if (Number(updated.changes) !== 1) {
      throw new StoreError(STORE_CODES.ERR_ANALYSIS_STATE, 'analysis state changed concurrently', {
        analysis_id: input.analysis_id,
      });
    }

    appendAudit(store, {
      action: AUDIT_ACTIONS.ANALYSIS_COMPLETE,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? String(input.owner),
      objectDigest: reportRecord.digest,
      payload: {
        analysis_id: input.analysis_id,
        attempt_id: input.attempt_id,
        outcome,
        proposal_id: proposalId,
      },
      timestamp: now,
    });

    return Object.freeze({
      analysis_id: input.analysis_id,
      state: outcome,
      duplicate: false,
      report_digest: reportRecord.digest,
      proposal_id: proposalId,
    });
  });
}

/**
 * 失败：`fail` 不得覆盖已提交结果。
 * 已终态时返回现状而不是报错——重复 fail 是幂等的运维事件，不是异常。
 */
export function failAnalysis(store, input) {
  store.assertWritable('failAnalysis');
  return store.tx('T5-fail', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadAnalysis(store, input.analysis_id);
    assertAnalysisEpoch(store, row);
    const state = String(row.state);
    if (TERMINAL_ANALYSIS_STATES.includes(state)) {
      return Object.freeze({ analysis_id: input.analysis_id, state, duplicate: true, applied: false });
    }
    if (String(row.attempt_id ?? '') !== String(input.attempt_id ?? '')) {
      throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'fail from a non-owning attempt is rejected', {
        analysis_id: input.analysis_id,
      });
    }
    // 与 complete 对齐：失败也要证明自己还持有租约，否则超时 worker 能把别人正在跑的分析打死。
    if (row.owner === null || String(row.owner) !== String(input.owner ?? '')) {
      throw new StoreError(STORE_CODES.ERR_STALE_OWNER, 'fail from a non-owning owner is rejected', {
        analysis_id: input.analysis_id,
      });
    }
    if (row.lease_expires_at_ms === null || msFromIso(now) > Number(row.lease_expires_at_ms)) {
      throw new StoreError(STORE_CODES.ERR_LEASE_EXPIRED, 'fail from an expired lease is rejected', {
        analysis_id: input.analysis_id,
      });
    }
    const updated = store.run(
      `UPDATE analysis_outbox
          SET state = 'failed', completed_at = ?, failure_reason = ?, updated_at = ?
        WHERE analysis_id = ? AND attempt_id = ? AND state IN ('dispatched','running')`,
      [now, input.reason ?? 'analysis_failed', now, input.analysis_id, String(input.attempt_id)],
    );
    if (Number(updated.changes) !== 1) {
      return Object.freeze({ analysis_id: input.analysis_id, state, duplicate: true, applied: false });
    }
    appendAudit(store, {
      action: AUDIT_ACTIONS.ANALYSIS_FAIL,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? 'aegis-broker',
      objectDigest: String(row.canonical_digest),
      payload: { analysis_id: input.analysis_id, attempt_id: input.attempt_id, reason: input.reason ?? 'analysis_failed' },
      timestamp: now,
    });
    return Object.freeze({ analysis_id: input.analysis_id, state: 'failed', duplicate: false, applied: true });
  });
}

/**
 * 租约过期扫描。
 *
 * 只标记 `lease_expired = 1` 并把候选交给操作员，**不**自动重排、**不**改状态。
 * 自动重排等于自动重试：一次超时的分析可能已经花掉了预算额度。
 */
export function sweepExpiredAnalysisLeases(store, options = {}) {
  store.assertWritable('sweepExpiredAnalysisLeases');
  return store.tx('T5-lease-sweep', () => {
    const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
    const nowMs = msFromIso(now);
    const candidates = store.all(
      `SELECT analysis_id, attempt_id, attempt_seq, owner, lease_expires_at_ms, state
         FROM analysis_outbox
        WHERE state IN ('dispatched','running')
          AND lease_expires_at_ms IS NOT NULL
          AND lease_expires_at_ms < ?
        ORDER BY lease_expires_at_ms`,
      [nowMs],
    );
    for (const candidate of candidates) {
      store.run(
        'UPDATE analysis_outbox SET lease_expired = 1, updated_at = ? WHERE analysis_id = ? AND state IN (\'dispatched\',\'running\')',
        [now, String(candidate.analysis_id)],
      );
      appendAudit(store, {
        action: AUDIT_ACTIONS.ANALYSIS_QUARANTINE,
        actorType: options.actorType ?? 'daemon',
        actorId: options.actorId ?? 'aegis-core',
        objectDigest: sha256Hex(String(candidate.analysis_id)),
        payload: {
          analysis_id: String(candidate.analysis_id),
          attempt_id: candidate.attempt_id === null ? null : String(candidate.attempt_id),
          phase: 'lease_expired',
          next_action: 'operator_review',
        },
        timestamp: now,
      });
    }
    return Object.freeze({
      scanned: candidates.length,
      candidates: Object.freeze(
        candidates.map((candidate) => Object.freeze({
          analysis_id: String(candidate.analysis_id),
          attempt_id: candidate.attempt_id === null ? null : String(candidate.attempt_id),
          attempt_seq: Number(candidate.attempt_seq),
          state: String(candidate.state),
          next_action: 'operator_review',
        })),
      ),
    });
  });
}

/**
 * 操作员显式重排：唯一能把过期分析放回队列的入口。
 *
 * 要求 `lease_expired = 1`（已由扫描确认）且 attempt 次数未耗尽；
 * 重排本身也要写审计，`attempt_seq` 在下次 claim 时递增。
 */
export function requeueAnalysis(store, input) {
  store.assertWritable('requeueAnalysis');
  return store.tx('T5-requeue', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadAnalysis(store, input.analysis_id);
    const state = String(row.state);
    if (state === 'queued') {
      return Object.freeze({ analysis_id: input.analysis_id, state, duplicate: true });
    }
    if (!['dispatched', 'running'].includes(state)) {
      throw new StoreError(STORE_CODES.ERR_ANALYSIS_STATE, `cannot requeue a ${state} analysis`, {
        analysis_id: input.analysis_id,
        state,
      });
    }
    if (Number(row.lease_expired) !== 1) {
      throw new StoreError(
        STORE_CODES.ERR_ANALYSIS_STATE,
        'requeue requires a leak-confirmed expired lease (run the sweep first)',
        { analysis_id: input.analysis_id },
      );
    }
    const maxAttempts = Number.isInteger(input.max_attempts) ? input.max_attempts : DEFAULT_MAX_ANALYSIS_ATTEMPTS;
    if (Number(row.attempt_seq) >= maxAttempts) {
      throw new StoreError(STORE_CODES.ERR_ANALYSIS_STATE, 'attempt budget exhausted; manual handling required', {
        analysis_id: input.analysis_id,
        attempt_seq: Number(row.attempt_seq),
        max_attempts: maxAttempts,
      });
    }
    store.run(
      `UPDATE analysis_outbox
          SET state = 'queued', attempt_id = NULL, owner = NULL, lease_expires_at_ms = NULL,
              lease_expired = 0, updated_at = ?
        WHERE analysis_id = ?`,
      [now, input.analysis_id],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.ANALYSIS_QUARANTINE,
      actorType: input.actorType ?? 'console',
      actorId: input.actorId ?? 'aegis-console',
      objectDigest: String(row.canonical_digest),
      payload: {
        analysis_id: input.analysis_id,
        from: state,
        to: 'queued',
        attempt_seq: Number(row.attempt_seq),
        reason: input.reason ?? 'operator_requeue',
      },
      timestamp: now,
    });
    return Object.freeze({ analysis_id: input.analysis_id, state: 'queued', duplicate: false });
  });
}

/**
 * 把旧 epoch 的排队分析显式纳入当前 epoch。
 *
 * 恢复之后，`queued` 且 epoch 落后的分析既不能 claim（epoch 不符）也不能 requeue
 * （只接受 dispatched/running），会成为永远不可处理的死账。这里给它一个
 * **显式、可审计**的接管入口，而不是让 claim 悄悄忽略 epoch。
 */
export function adoptAnalysisEpoch(store, input) {
  store.assertWritable('adoptAnalysisEpoch');
  return store.tx('T5-adopt', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadAnalysis(store, input.analysis_id);
    const state = String(row.state);
    if (state !== 'queued') {
      throw new StoreError(STORE_CODES.ERR_ANALYSIS_STATE, `only a queued analysis can be adopted, got ${state}`, {
        analysis_id: input.analysis_id,
        state,
      });
    }
    if (String(row.epoch) === store.epoch()) {
      return Object.freeze({ analysis_id: input.analysis_id, epoch: store.epoch(), duplicate: true });
    }
    store.run(
      "UPDATE analysis_outbox SET epoch = ?, updated_at = ? WHERE analysis_id = ? AND state = 'queued'",
      [store.epoch(), now, input.analysis_id],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.ANALYSIS_QUARANTINE,
      actorType: input.actorType ?? 'cli',
      actorId: input.actorId ?? 'aegis-cli',
      objectDigest: String(row.canonical_digest),
      payload: {
        analysis_id: input.analysis_id,
        phase: 'adopt_epoch',
        from_epoch: String(row.epoch),
        to_epoch: store.epoch(),
        reason: input.reason ?? 'post_restore_adoption',
      },
      timestamp: now,
    });
    return Object.freeze({ analysis_id: input.analysis_id, epoch: store.epoch(), duplicate: false });
  });
}

export function getAnalysis(store, analysisId) {
  return store.get('SELECT * FROM analysis_outbox WHERE analysis_id = ?', [analysisId]);
}

export function getAnalysisReport(store, analysisId) {
  return store.get('SELECT * FROM analysis_report WHERE analysis_id = ?', [analysisId]);
}

export function listAnalyses(store, options = {}) {
  if (typeof options.state === 'string') {
    return store.all('SELECT * FROM analysis_outbox WHERE state = ? ORDER BY created_at_ms', [options.state]);
  }
  return store.all('SELECT * FROM analysis_outbox ORDER BY created_at_ms');
}
