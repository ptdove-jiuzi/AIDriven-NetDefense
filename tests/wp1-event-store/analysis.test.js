/**
 * T5 分析完成事务（claim / running / complete / fail / 租约 / 重排）。
 *
 * 三条底线：
 * - 单消费者：`queued` 只能被 claim 一次，第二次必须失败（双消费闸门）；
 * - 迟到 attempt 拒绝：租约过期后交上来的报告不能覆盖任何状态；
 * - fail 不覆盖已提交结果：先到的报告是权威。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginAnalysisRunning,
  claimAnalysis,
  completeAnalysis,
  failAnalysis,
  getAnalysis,
  getAnalysisReport,
  ingestTelemetry,
  requeueAnalysis,
  sweepExpiredAnalysisLeases,
} from '../../packages/event-store/src/index.js';

import {
  expectContractError,
  expectStoreError,
  makeAlert,
  makeAnalysisRequest,
  makeEvent,
  makeProposal,
  makeReport,
  openTestStore,
  sha256Hex,
  uuid,
} from './helpers.js';

const WINDOW = {
  window_start: '2026-11-01T00:00:00.000Z',
  window_end: '2026-11-01T00:15:00.000Z',
};

const SECOND = 1000;
const MINUTE = 60000;

function seed(t, options = {}) {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`an-${uuid()}`) });
  const analysis = makeAnalysisRequest({
    alert_id: alert.alert_id,
    epoch: options.epoch ?? store.epoch(),
    created_at: now,
  });
  ingestTelemetry(store, {
    event: makeEvent({ observed_at: now, received_at: now, native_record_id: `n-${analysis.analysis_id}` }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  return { store, clock, alert, analysis };
}

test('claim 把 queued 推进到 dispatched，并分配 attempt 与租约', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', lease_ms: MINUTE, now: clock.nowIso() });
  assert.equal(claim.state, 'dispatched');
  assert.equal(claim.attempt_seq, 1);
  assert.match(claim.attempt_id, /^[0-9a-f-]{36}$/u);
  assert.ok(claim.lease_expires_at_ms > clock.nowMs());
});

test('第二次 claim 被拒（单消费者，双消费不可能发生）', (t) => {
  const { store, clock, analysis } = seed(t);
  const first = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  const error = expectStoreError(
    () => claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-2', now: clock.nowIso() }),
    'ERR_ANALYSIS_STATE',
  );
  assert.equal(error.details.state, 'dispatched');
  assert.equal(error.details.owner, 'broker-1');
  const row = getAnalysis(store, analysis.analysis_id);
  assert.equal(String(row.attempt_id), first.attempt_id);
  assert.equal(String(row.owner), 'broker-1');
});

test('beginAnalysisRunning 需要正确 attempt 与 owner', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  const running = beginAnalysisRunning(store, {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    now: clock.nowIso(),
  });
  assert.equal(running.state, 'running');

  const other = seed(t);
  const otherClaim = claimAnalysis(other.store, {
    analysis_id: other.analysis.analysis_id,
    owner: 'broker-1',
    now: other.clock.nowIso(),
  });
  expectStoreError(
    () => beginAnalysisRunning(other.store, {
      analysis_id: other.analysis.analysis_id,
      attempt_id: otherClaim.attempt_id,
      owner: 'broker-9',
      now: other.clock.nowIso(),
    }),
    'ERR_STALE_OWNER',
  );
});

test('complete 写入报告、终态与审计', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  const completed = completeAnalysis(store, {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    report: makeReport({ analysis_id: analysis.analysis_id }),
    now: clock.nowIso(),
  });
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.duplicate, false);
  const row = getAnalysis(store, analysis.analysis_id);
  assert.equal(String(row.state), 'succeeded');
  assert.equal(String(row.report_digest), completed.report_digest);
  assert.ok(getAnalysisReport(store, analysis.analysis_id) !== null);
  const actions = store.all('SELECT action FROM audit_event').map((entry) => String(entry.action));
  assert.ok(actions.includes('analysis.complete'));
});

test('重复 complete 是幂等确认，报告不被覆盖', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  const input = {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    report: makeReport({ analysis_id: analysis.analysis_id }),
    now: clock.nowIso(),
  };
  const first = completeAnalysis(store, input);
  const second = completeAnalysis(store, { ...input, report: makeReport({ analysis_id: analysis.analysis_id, summary: 'second' }) });
  assert.equal(second.duplicate, true);
  assert.equal(second.report_digest, first.report_digest);
  const report = getAnalysisReport(store, analysis.analysis_id);
  assert.equal(String(report.report_digest), first.report_digest);
});

test('使用别人的 attempt 提交报告被拒', (t) => {
  const { store, clock, analysis } = seed(t);
  claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  expectStoreError(
    () => completeAnalysis(store, {
      analysis_id: analysis.analysis_id,
      attempt_id: uuid(),
      owner: 'broker-1',
      report: makeReport({ analysis_id: analysis.analysis_id }),
      now: clock.nowIso(),
    }),
    'ERR_STALE_OWNER',
  );
});

test('迟到的报告（租约过期）被拒绝', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', lease_ms: 30000, now: clock.nowIso() });
  clock.advance(2 * MINUTE);
  expectStoreError(
    () => completeAnalysis(store, {
      analysis_id: analysis.analysis_id,
      attempt_id: claim.attempt_id,
      owner: 'broker-1',
      report: makeReport({ analysis_id: analysis.analysis_id }),
      now: clock.nowIso(),
    }),
    'ERR_LEASE_EXPIRED',
  );
  const row = getAnalysis(store, analysis.analysis_id);
  assert.equal(String(row.state), 'dispatched');
});

test('fail 落为 failed 并记原因', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  const failed = failAnalysis(store, {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    reason: 'worker_timeout',
    now: clock.nowIso(),
  });
  assert.equal(failed.state, 'failed');
  const row = getAnalysis(store, analysis.analysis_id);
  assert.equal(String(row.failure_reason), 'worker_timeout');
});

test('fail 不得覆盖已提交的结果', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  completeAnalysis(store, {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    report: makeReport({ analysis_id: analysis.analysis_id }),
    now: clock.nowIso(),
  });
  const later = failAnalysis(store, {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    reason: 'late_failure',
    now: clock.nowIso(),
  });
  assert.equal(later.applied, false);
  assert.equal(later.state, 'succeeded');
  assert.ok(getAnalysisReport(store, analysis.analysis_id) !== null);
});

test('complete 可在同一事务内落 Proposal（仅展示、待审批）', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  const proposal = makeProposal({ analysis_id: analysis.analysis_id, expires_at: '2026-11-01T01:00:00.000Z' });
  const completed = completeAnalysis(store, {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    report: makeReport({ analysis_id: analysis.analysis_id }),
    proposal,
    now: clock.nowIso(),
  });
  assert.equal(completed.proposal_id, proposal.proposal_id);
  const row = store.get('SELECT * FROM response_proposal WHERE proposal_id = ?', [proposal.proposal_id]);
  assert.equal(String(row.analysis_id), analysis.analysis_id);
  assert.equal(String(row.action_id), proposal.action_id);
});

test('Proposal 的 analysis_id 与分析不符时整体回滚', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  expectStoreError(
    () => completeAnalysis(store, {
      analysis_id: analysis.analysis_id,
      attempt_id: claim.attempt_id,
      owner: 'broker-1',
      report: makeReport({ analysis_id: analysis.analysis_id }),
      proposal: makeProposal({ analysis_id: uuid(), expires_at: '2026-11-01T01:00:00.000Z' }),
      now: clock.nowIso(),
    }),
    'ERR_BINDING_MISMATCH',
  );
  assert.equal(getAnalysisReport(store, analysis.analysis_id), null);
  const row = getAnalysis(store, analysis.analysis_id);
  assert.equal(String(row.state), 'dispatched');
});

test('report 的 analysis_id 与分析不符时合同层拒绝', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  // 这里只校验合同形状：completeAnalysis 不比对 report.analysis_id（那是 broker 的职责），
  // 但非法 DTO（缺字段）必须在入口被拒。
  expectContractError(
    () => completeAnalysis(store, {
      analysis_id: analysis.analysis_id,
      attempt_id: claim.attempt_id,
      owner: 'broker-1',
      report: { schemaVersion: '1.0' },
      now: clock.nowIso(),
    }),
    'ERR_MISSING_FIELD',
  );
});

test('epoch 不匹配的分析无法 claim（恢复后旧 outbox 失效）', (t) => {
  const { store, clock, analysis } = seed(t, { epoch: uuid() });
  expectStoreError(
    () => claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() }),
    'ERR_EPOCH_MISMATCH',
  );
});

test('租约扫描只标记 lease_expired，不改状态、不自动重排', (t) => {
  const { store, clock, analysis } = seed(t);
  claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', lease_ms: SECOND, now: clock.nowIso() });
  clock.advance(5 * SECOND);
  const sweep = sweepExpiredAnalysisLeases(store, { now: clock.nowIso() });
  assert.equal(sweep.scanned, 1);
  assert.equal(sweep.candidates[0].next_action, 'operator_review');
  const row = getAnalysis(store, analysis.analysis_id);
  assert.equal(String(row.state), 'dispatched');
  assert.equal(Number(row.lease_expired), 1);
});

test('未经扫描确认的重排被拒绝（不能绕过核对直接重试）', (t) => {
  const { store, clock, analysis } = seed(t);
  claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', lease_ms: SECOND, now: clock.nowIso() });
  clock.advance(5 * SECOND);
  expectStoreError(
    () => requeueAnalysis(store, { analysis_id: analysis.analysis_id, now: clock.nowIso() }),
    'ERR_ANALYSIS_STATE',
  );
});

test('操作员重排后分析回到 queued，可再次 claim（attempt_seq 递增）', (t) => {
  const { store, clock, analysis } = seed(t);
  claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', lease_ms: SECOND, now: clock.nowIso() });
  clock.advance(5 * SECOND);
  sweepExpiredAnalysisLeases(store, { now: clock.nowIso() });
  const requeued = requeueAnalysis(store, { analysis_id: analysis.analysis_id, now: clock.nowIso() });
  assert.equal(requeued.state, 'queued');
  assert.equal(getAnalysis(store, analysis.analysis_id).attempt_id, null);

  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-2', now: clock.nowIso() });
  assert.equal(claim.attempt_seq, 2);
});

test('attempt 次数上限生效，超过后必须人工处理', (t) => {
  const { store, clock, analysis } = seed(t);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: `broker-${attempt}`, lease_ms: SECOND, now: clock.nowIso() });
    clock.advance(5 * SECOND);
    sweepExpiredAnalysisLeases(store, { now: clock.nowIso() });
    if (attempt < 3) {
      requeueAnalysis(store, { analysis_id: analysis.analysis_id, now: clock.nowIso() });
    }
  }
  expectStoreError(
    () => claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-x', now: clock.nowIso() }),
    'ERR_ANALYSIS_STATE',
  );
});

test('未知分析 claim / complete 都报 ERR_ANALYSIS_NOT_FOUND', (t) => {
  const { store, clock } = openTestStore(t);
  expectStoreError(() => claimAnalysis(store, { analysis_id: uuid(), now: clock.nowIso() }), 'ERR_ANALYSIS_NOT_FOUND');
  expectStoreError(
    () => completeAnalysis(store, {
      analysis_id: uuid(),
      attempt_id: uuid(),
      owner: 'b',
      report: makeReport({ analysis_id: uuid() }),
      now: clock.nowIso(),
    }),
    'ERR_ANALYSIS_NOT_FOUND',
  );
});

test('degraded 终态也被识别为终态（不允许再 complete）', (t) => {
  const { store, clock, analysis } = seed(t);
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now: clock.nowIso() });
  const first = completeAnalysis(store, {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    outcome: 'degraded',
    report: makeReport({ analysis_id: analysis.analysis_id }),
    now: clock.nowIso(),
  });
  assert.equal(first.state, 'degraded');
  const second = completeAnalysis(store, {
    analysis_id: analysis.analysis_id,
    attempt_id: claim.attempt_id,
    owner: 'broker-1',
    report: makeReport({ analysis_id: analysis.analysis_id, summary: 'other' }),
    now: clock.nowIso(),
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.state, 'degraded');
});
