/**
 * 独立审查指出的缺口对应的回归用例（第一轮 + 第二轮）。
 *
 * 这一组不是"新功能测试"，而是把审查里每条 P0/P1 的**反例**钉死：
 * 只要有人把对应校验删掉，这里就会变红。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  acceptExecution,
  adoptAnalysisEpoch,
  approveExecution,
  beginAnalysisRunning,
  beginExecuting,
  claimAnalysis,
  completeAnalysis,
  createApproval,
  createBackup,
  enforceCapacity,
  getAnalysis,
  getCapabilityState,
  ingestTelemetry,
  markExecutionDispatched,
  markModelRequestSent,
  markModelRequestUnknown,
  prepareDispatch,
  registerProposal,
  repairAuditMode,
  reserveModelRequest,
  restoreBackup,
  rotateEpoch,
  runRetention,
  setCapabilityState,
  settleExecution,
  settleModelRequest,
  sweepExpiredExecutionLeases,
  verifyAuditChainInStore,
  verifyBackupFile,
  writeRecoveryManifest,
} from '../../packages/event-store/src/index.js';

import {
  buildApprovedExecution,
  buildDispatchedExecution,
  buildExecutingExecution,
  countEvents,
  createTestClock,
  expectStoreError,
  isoFromMs,
  makeAlert,
  makeAnalysisRequest,
  makeApproval,
  makeEvent,
  makeProposal,
  makeReport,
  makeTempDir,
  msFromIso,
  openStore,
  openTestStore,
  sha256Hex,
  uuid,
} from './helpers.js';

function seedAnalysisLocal(store, clock) {
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`local-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: `local-${analysis.analysis_id}`, observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  return analysis.analysis_id;
}

const WINDOW = {
  window_start: '2026-11-01T00:00:00.000Z',
  window_end: '2026-11-01T00:15:00.000Z',
};
const MINUTE = 60000;
const DAY = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* P0-2：epoch 绑定必须覆盖 T3c / T4 / T5 / T2                          */
/* ------------------------------------------------------------------ */

test('epoch 轮换后，已投递的执行不能再被受理', (t) => {
  const { store } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  rotateEpoch(store, { now: store.clock.nowIso() });
  expectStoreError(
    () => acceptExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      now: store.clock.nowIso(),
    }),
    'ERR_EPOCH_MISMATCH',
  );
});

test('epoch 轮换后，已受理的执行不能进入 executing，也不能结算', (t) => {
  const { store } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    lease_ms: 5 * MINUTE,
    now: store.clock.nowIso(),
  });
  writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    object_identity: { pid: 1 },
    before_state: { running: true },
    after_state: { running: false },
    now: store.clock.nowIso(),
  });
  rotateEpoch(store, { now: store.clock.nowIso() });

  expectStoreError(
    () => beginExecuting(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      now: store.clock.nowIso(),
    }),
    'ERR_EPOCH_MISMATCH',
  );
  expectStoreError(
    () => settleExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      result_seq: 1,
      outcome: 'succeeded',
      result: {},
      now: store.clock.nowIso(),
    }),
    'ERR_EPOCH_MISMATCH',
  );
});

test('epoch 轮换后，已 claim 的分析不能提交报告', (t) => {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`rot-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'rot-1', observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now });
  rotateEpoch(store, { now });

  expectStoreError(
    () => completeAnalysis(store, {
      analysis_id: analysis.analysis_id,
      attempt_id: claim.attempt_id,
      owner: 'broker-1',
      report: makeReport({ analysis_id: analysis.analysis_id }),
      now,
    }),
    'ERR_EPOCH_MISMATCH',
  );
});

test('旧 epoch 的排空分析可以显式纳入当前 epoch（并留下审计）', (t) => {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`adopt-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'adopt-1', observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  rotateEpoch(store, { now });
  expectStoreError(() => claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now }), 'ERR_EPOCH_MISMATCH');

  const adopted = adoptAnalysisEpoch(store, { analysis_id: analysis.analysis_id, now });
  assert.equal(adopted.epoch, store.epoch());
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now });
  assert.equal(claim.attempt_seq, 1);
  const actions = store.all('SELECT action FROM audit_event').map((row) => String(row.action));
  assert.ok(actions.includes('analysis.quarantine'));
});

/* ------------------------------------------------------------------ */
/* P1：迟到结果必须先核对，不能直接落库                                  */
/* ------------------------------------------------------------------ */

test('扫描把 executing 转成 result_unknown 后，迟到结果不能直接结算', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildExecutingExecution(store, { lease_ms: 1000 });
  clock.advance(2 * MINUTE);
  sweepExpiredExecutionLeases(store, { now: clock.nowIso() });

  const error = expectStoreError(
    () => settleExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      result_seq: 1,
      outcome: 'succeeded',
      result: { stopped: true },
      now: clock.nowIso(),
    }),
    'ERR_EXECUTION_STATE',
  );
  assert.match(error.message, /reconcile/iu);
});

/* ------------------------------------------------------------------ */
/* P1：没有恢复清单就不允许结算（副作用前必须有意图）                    */
/* ------------------------------------------------------------------ */

test('dispatched 状态没有任何恢复清单时结算被拒', (t) => {
  const { store } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  expectStoreError(
    () => settleExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      result_seq: 1,
      outcome: 'succeeded',
      result: { stopped: true },
      now: store.clock.nowIso(),
    }),
    'ERR_RECOVERY_STATE',
  );
});

/* ------------------------------------------------------------------ */
/* P1：保留扫描不能被 outbox 外键打死                                    */
/* ------------------------------------------------------------------ */

test('被 analysis_outbox 引用的过期低危告警不会让保留事务失败', (t) => {
  const { store } = openTestStore(t);
  const old = '2026-01-01T00:00:00.000Z';
  const alert = makeAlert({
    ...WINDOW,
    fingerprint: sha256Hex('retention-fk'),
    severity: 'low',
    first_seen: old,
    last_seen: old,
    window_start: old,
    window_end: '2026-01-01T00:15:00.000Z',
  });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: old });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'fk-1', observed_at: old, received_at: old }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now: old,
  });
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM analysis_outbox').c), 1);

  const later = isoFromMs(msFromIso(old) + 400 * DAY);
  const sweep = runRetention(store, { now: later });
  // 告警被 outbox 引用 → 保留（不删），但扫描本身必须成功。
  assert.equal(sweep.alerts_deleted, 0);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM alert').c), 1);
  assert.equal(countEvents(store), 0, 'telemetry cleanup still runs in the same transaction');
});

/* ------------------------------------------------------------------ */
/* P1：审批会话身份必须与审批里绑定的身份一致                            */
/* ------------------------------------------------------------------ */

test('用另一个 responder 的身份批准被拒（不能替别人签名）', (t) => {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`id-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'id-1', observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now });
  const proposalValue = makeProposal({ analysis_id: analysis.analysis_id, expires_at: isoFromMs(msFromIso(now) + 3600000) });
  const proposal = registerProposal(store, { proposal: proposalValue, now });
  const approval = makeApproval({
    proposal_digest: proposal.digest,
    target_digest: proposalValue.normalized_target.digest,
    epoch: store.epoch(),
    issued_at: now,
    reauthenticated_at: now,
    expires_at: isoFromMs(msFromIso(now) + 30 * MINUTE),
    approver_identity: {
      account_id: 'AEGIS\\responder',
      role_snapshot: ['responder'],
      reauthenticated_at: now,
    },
  });
  createApproval(store, { approval, proposal_id: proposalValue.proposal_id, now });

  expectStoreError(
    () => approveExecution(store, {
      approval_id: approval.approval_id,
      roles: ['responder'],
      actorId: 'AEGIS\\someone-else',
      now,
    }),
    'ERR_ROLE_NOT_PERMITTED',
  );
  const ok = approveExecution(store, {
    approval_id: approval.approval_id,
    roles: ['responder'],
    actorId: 'AEGIS\\responder',
    now,
  });
  assert.equal(ok.state, 'approved');
});

/* ------------------------------------------------------------------ */
/* P2：审计链尾部截断与换钥                                             */
/* ------------------------------------------------------------------ */

test('删除审计尾部会被 meta 锚点抓住（链接检查看不出来）', (t) => {
  const { store } = openTestStore(t);
  for (let index = 0; index < 3; index += 1) {
    ingestTelemetry(store, {
      event: makeEvent({ native_record_id: `tail-${index}` }),
      now: '2026-11-01T00:00:02.000Z',
    });
  }
  assert.equal(verifyAuditChainInStore(store).length, 3);
  store.run('DELETE FROM audit_event WHERE sequence >= 3');
  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
});

test('换钥续写会被标记为 mixed 并拒绝追加审计', (t) => {
  const { store, dir } = openTestStore(t, { auditKey: 'key-one' });
  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'k1' }), now: '2026-11-01T00:00:02.000Z' });
  store.close();

  const reopened = openStore({ path: `${dir}/aegis-harness.db`, auditKey: 'key-two', clock: store.clock });
  t.after(() => reopened.close());
  assert.equal(reopened.getMeta('audit_hmac_mode'), 'mixed');
  expectStoreError(
    () => ingestTelemetry(reopened, { event: makeEvent({ native_record_id: 'k2' }), now: '2026-11-01T00:00:03.000Z' }),
    'ERR_NOT_SUPPORTED',
  );
  // 换钥后的旧链仍然可以被读出来（只是 hmac 无法验证）。
  assert.equal(Number(reopened.get('SELECT COUNT(*) AS c FROM audit_event').c), 1);
});

/* ------------------------------------------------------------------ */
/* P2：Grant 是短期凭据                                                 */
/* ------------------------------------------------------------------ */

test('Grant 的 TTL 不超过 5 分钟，即使审批 TTL 是 30 分钟', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildApprovedExecution(store, {});
  const dispatched = prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: clock.nowIso() });
  const notBefore = msFromIso(dispatched.grant.not_before);
  const expiresAt = msFromIso(dispatched.grant.expires_at);
  assert.ok(expiresAt - notBefore <= 5 * MINUTE + 1000, `grant ttl too long: ${expiresAt - notBefore}`);
  assert.ok(expiresAt - notBefore > 0);
});

/* ------------------------------------------------------------------ */
/* P2：崩溃/停机后不留下"半更新"的 capability 与 outbox                 */
/* ------------------------------------------------------------------ */

test('execution 与 outbox 在 dispatch 阶段保持同一 attempt', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  const dispatched = prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  markExecutionDispatched(store, {
    execution_id: dispatched.execution_id,
    attempt_id: dispatched.attempt_id,
    now: store.clock.nowIso(),
  });
  const execution = store.get('SELECT attempt_id, grant_digest FROM execution WHERE execution_id = ?', [dispatched.execution_id]);
  const outbox = store.get('SELECT attempt_id, grant_digest FROM execution_outbox WHERE execution_id = ?', [dispatched.execution_id]);
  assert.equal(String(execution.attempt_id), String(outbox.attempt_id));
  assert.equal(String(execution.grant_digest), String(outbox.grant_digest));
  assert.equal(String(execution.attempt_id), dispatched.attempt_id);
});

test('分析报告的 analysis_id 必须与被完成的分析一致', (t) => {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`bind-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'bind-1', observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  const claim = claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now });
  expectStoreError(
    () => completeAnalysis(store, {
      analysis_id: analysis.analysis_id,
      attempt_id: claim.attempt_id,
      owner: 'broker-1',
      report: makeReport({ analysis_id: uuid() }),
      now,
    }),
    'ERR_BINDING_MISMATCH',
  );
  assert.equal(getAnalysis(store, analysis.analysis_id).state, 'dispatched');
});

/* ================================================================== */
/* 第二轮审查（NO_GO）指出的必改项                                      */
/* ================================================================== */

test('epoch 轮换后，投递确认（markExecutionDispatched）被拒', (t) => {
  const { store } = openTestStore(t);
  // 只做到 T3b：execution 处于 dispatch_pending，outbox 处于 pending。
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  rotateEpoch(store, { now: store.clock.nowIso() });
  expectStoreError(
    () => markExecutionDispatched(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      now: store.clock.nowIso(),
    }),
    'ERR_EPOCH_MISMATCH',
  );
});

test('adoptAnalysisEpoch 只接受 queued，且 epoch 一致时是幂等的', (t) => {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`adopt2-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'adopt2-1', observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  // 已经是当前 epoch → 幂等
  const same = adoptAnalysisEpoch(store, { analysis_id: analysis.analysis_id, now });
  assert.equal(same.duplicate, true);

  claimAnalysis(store, { analysis_id: analysis.analysis_id, owner: 'broker-1', now });
  rotateEpoch(store, { now });
  // 已不是 queued → 拒绝（不能把在跑的分析"接管"过来）
  expectStoreError(
    () => adoptAnalysisEpoch(store, { analysis_id: analysis.analysis_id, now }),
    'ERR_ANALYSIS_STATE',
  );
});

test('not_required 清单在成功结算后仍然是 not_required（不被误标人工）', (t) => {
  const { store } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    lease_ms: 5 * MINUTE,
    now: store.clock.nowIso(),
  });
  writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    state: 'not_required',
    now: store.clock.nowIso(),
  });
  beginExecuting(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    now: store.clock.nowIso(),
  });
  const settled = settleExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 1,
    outcome: 'succeeded',
    result: { ok: true },
    now: store.clock.nowIso(),
  });
  assert.equal(settled.manifest_state, 'not_required');
});

test('Grant 过期后不能被受理，也不能进入 executing', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  // Grant TTL 上限是 5 分钟，推过 6 分钟必然过期。
  clock.advance(6 * MINUTE);
  expectStoreError(
    () => acceptExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      now: clock.nowIso(),
    }),
    'ERR_APPROVAL_EXPIRED',
  );
  const execution = store.get('SELECT state FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'dispatched');
});

test('审计表被整体清空时链校验必须失败', (t) => {
  const { store } = openTestStore(t);
  for (let index = 0; index < 2; index += 1) {
    ingestTelemetry(store, {
      event: makeEvent({ native_record_id: `wipe-${index}` }),
      now: '2026-11-01T00:00:02.000Z',
    });
  }
  store.run('DELETE FROM audit_event');
  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
});

test('空串提供方证据不算证据', (t) => {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`ev-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'ev-1', observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  const reserved = reserveModelRequest(store, {
    analysis_id: analysis.analysis_id,
    serialized_digest: sha256Hex('ev'),
    input_upper: 500,
    output_limit: 100,
    now,
  });
  markModelRequestSent(store, { request_id: reserved.request_id, now });
  markModelRequestUnknown(store, { request_id: reserved.request_id, now });
  expectStoreError(
    () => settleModelRequest(store, {
      request_id: reserved.request_id,
      usage: { input_tokens: 1, output_tokens: 1 },
      providerEvidence: '',
      now,
    }),
    'ERR_REQUEST_STATE',
  );
});

test('恢复到正被存活写者持有的库被拒绝（不会先删 WAL）', async (t) => {
  const { store, dir } = openTestStore(t);
  const backup = await createBackup(store, { directory: `${dir}/backups`, now: '2026-11-01T00:00:02.000Z' });
  // 目标库里写者仍在（就是 store 自己，但 pid 相同会被放行）——这里用另一个存活 pid 模拟。
  const target = `${dir}/held.db`;
  fs.copyFileSync(backup.path, target);
  fs.writeFileSync(`${target}.writer-lock`, JSON.stringify({ pid: process.ppid, file: target }), 'utf8');
  expectStoreError(
    () => restoreBackup({
      backupPath: backup.path,
      targetPath: target,
      overwrite: true,
      now: '2026-11-01T00:00:03.000Z',
      clock: store.clock,
      auditKey: store.auditKey,
    }),
    'ERR_STORE_LOCKED',
  );
});

test('水位回落后解除 blocked，而不是永久停摆', (t) => {
  const { store } = openTestStore(t);
  setCapabilityState(store, { capability: 'analysis', state: 'blocked', now: store.clock.nowIso() });
  setCapabilityState(store, { capability: 'response', state: 'blocked', now: store.clock.nowIso() });
  const released = enforceCapacity(store, { external: { databaseBytes: 1024 }, now: store.clock.nowIso() });
  assert.equal(released.level, 'ok');
  assert.ok(released.actions.includes('release_capability_blocks'));
  assert.equal(getCapabilityState(store, 'analysis').state, 'ok');
  assert.equal(getCapabilityState(store, 'response').state, 'ok');
});

test('repairAuditMode 需要显式确认，确认后可以继续写审计', (t) => {
  const { store, dir } = openTestStore(t, { auditKey: 'key-one' });
  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'rs-1' }), now: '2026-11-01T00:00:02.000Z' });
  store.close();

  const reopened = openStore({ path: dir + '/aegis-harness.db', auditKey: 'key-two', clock: store.clock });
  t.after(() => reopened.close());
  expectStoreError(() => repairAuditMode(reopened, { now: reopened.clock.nowIso() }), 'ERR_STORE_INPUT');
  const repaired = repairAuditMode(reopened, { acknowledge: true, now: reopened.clock.nowIso() });
  assert.equal(repaired.mode, 'hmac-sha256');
  const ingested = ingestTelemetry(reopened, { event: makeEvent({ native_record_id: 'rs-2' }), now: '2026-11-01T00:00:04.000Z' });
  assert.equal(ingested.duplicate, false);
});

test('迁移前会留下可验证的一致性快照', (t) => {
  const dir = makeTempDir(t);
  const filePath = `${dir}/migrate.db`;
  const first = openStore({ path: filePath, upTo: 1, clock: createTestClock() });
  first.close();

  const upgraded = openStore({ path: filePath, clock: createTestClock() });
  t.after(() => upgraded.close());
  const backupPath = upgraded.getMeta('last_pre_migration_backup');
  assert.ok(backupPath !== null && fs.existsSync(backupPath), 'pre-migration backup must exist');
  const verified = verifyBackupFile(backupPath);
  assert.equal(verified.schemaVersion, 1, 'snapshot must be the pre-migration schema');
});

/* ================================================================== */
/* 第三轮复核：为"改了但没锁住"的检查补反例                              */
/* ================================================================== */

test('Grant 过期后 beginExecuting 也必须拒绝（TTL 有两个强制点）', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    // 租约比 Grant TTL 长，确保拒绝来自 Grant 过期而不是租约过期。
    lease_ms: 30 * MINUTE,
    now: clock.nowIso(),
  });
  writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    object_identity: { pid: 7 },
    before_state: { running: true },
    after_state: { running: false },
    now: clock.nowIso(),
  });
  clock.advance(6 * MINUTE);
  expectStoreError(
    () => beginExecuting(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      now: clock.nowIso(),
    }),
    'ERR_APPROVAL_EXPIRED',
  );
  const execution = store.get('SELECT state FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'accepted');
});

test('response 能力被阻断时，登记提案与受理执行都被拒绝', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildApprovedExecution(store);
  setCapabilityState(store, { capability: 'response', state: 'blocked', now: clock.nowIso() });

  expectStoreError(
    () => registerProposal(store, {
      proposal: makeProposal({ analysis_id: context.analysis.analysis_id, expires_at: isoFromMs(msFromIso(clock.nowIso()) + 3600000) }),
      now: clock.nowIso(),
    }),
    'ERR_CAPACITY_CRITICAL',
  );
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: clock.nowIso() });
  expectStoreError(
    () => acceptExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      now: clock.nowIso(),
    }),
    'ERR_CAPACITY_CRITICAL',
  );
});

test('analysis 能力被阻断时，预算准入也被拒绝', (t) => {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`cap-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'cap-1', observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  setCapabilityState(store, { capability: 'analysis', state: 'blocked', now });
  expectStoreError(
    () => reserveModelRequest(store, {
      analysis_id: analysis.analysis_id,
      serialized_digest: sha256Hex('cap'),
      input_upper: 100,
      output_limit: 10,
      now,
    }),
    'ERR_CAPACITY_CRITICAL',
  );
});

test('显式传未来 now 也逃不过单调时钟校验（预算绕过已堵）', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysisLocal(store, clock);
  const future = isoFromMs(msFromIso(clock.nowIso()) + 24 * 60 * 60 * 1000);
  // 只传 now、不推进 mono：这正是"前跳一天重置日预算"的形态。
  expectStoreError(
    () => reserveModelRequest(store, {
      analysis_id: analysisId,
      serialized_digest: sha256Hex('future'),
      input_upper: 100,
      output_limit: 10,
      now: future,
    }),
    'ERR_BUDGET_TIME_UNTRUSTED',
  );
});

test('not_required 清单在库里也保持 not_required（不只是返回值）', (t) => {
  const { store } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    lease_ms: 5 * MINUTE,
    now: store.clock.nowIso(),
  });
  writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    state: 'not_required',
    now: store.clock.nowIso(),
  });
  beginExecuting(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    now: store.clock.nowIso(),
  });
  settleExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 1,
    outcome: 'succeeded',
    result: { ok: true },
    now: store.clock.nowIso(),
  });
  const manifest = store.get('SELECT state FROM recovery_manifest WHERE attempt_id = ?', [context.approved.attempt_id]);
  assert.equal(String(manifest.state), 'not_required');
});

test('placeholder 建库后注入密钥：链校验不抛，并如实报 partial', (t) => {
  const { store, dir } = openTestStore(t, { auditKey: null });
  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'ph-1' }), now: '2026-11-01T00:00:02.000Z' });
  store.close();

  const reopened = openStore({ path: `${dir}/aegis-harness.db`, auditKey: 'injected-key', clock: store.clock });
  t.after(() => reopened.close());
  const chain = verifyAuditChainInStore(reopened);
  assert.equal(chain.ok, true, 'upgrading from placeholder must not look like tampering');
  assert.equal(chain.hmacVerified, 'partial');
  const ingested = ingestTelemetry(reopened, { event: makeEvent({ native_record_id: 'ph-2' }), now: '2026-11-01T00:00:03.000Z' });
  assert.equal(ingested.duplicate, false);
  assert.equal(verifyAuditChainInStore(reopened).hmacVerified, 'partial');
});

test('repairAuditMode 会留下 audit.reseal 记录，且重开之后仍可用', (t) => {
  const { store, dir } = openTestStore(t, { auditKey: 'key-one' });
  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'rs2-1' }), now: '2026-11-01T00:00:02.000Z' });
  store.close();

  const reopened = openStore({ path: `${dir}/aegis-harness.db`, auditKey: 'key-two', clock: store.clock });
  repairAuditMode(reopened, { acknowledge: true, now: reopened.clock.nowIso() });
  const actions = reopened.all('SELECT action FROM audit_event ORDER BY sequence').map((row) => String(row.action));
  assert.ok(actions.includes('audit.reseal'));
  assert.equal(verifyAuditChainInStore(reopened).hmacVerified, 'partial');
  reopened.close();

  const third = openStore({ path: `${dir}/aegis-harness.db`, auditKey: 'key-two', clock: store.clock });
  t.after(() => third.close());
  assert.equal(third.getMeta('audit_hmac_mode'), 'hmac-sha256');
  const ingested = ingestTelemetry(third, { event: makeEvent({ native_record_id: 'rs2-2' }), now: '2026-11-01T00:00:05.000Z' });
  assert.equal(ingested.duplicate, false);
});
