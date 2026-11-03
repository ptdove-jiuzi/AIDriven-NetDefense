/**
 * WP1 事件存储测试夹具。
 *
 * 两条纪律：
 * 1. 每个用例一个独立临时目录，用例结束递归删除；绝不碰真实数据库路径。
 * 2. 时间由注入时钟推进，不用 sleep：崩溃点与租约过期的用例必须是确定性的。
 */

import assert from 'node:assert/strict';
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest, validateAlert, validateApproval, validateFinding, validateResponseProposal } from '../../packages/contracts/src/index.js';

import {
  acceptExecution,
  approveExecution,
  beginExecuting,
  claimAnalysis,
  createApproval,
  ingestTelemetry,
  markExecutionDispatched,
  prepareDispatch,
  registerProposal,
  writeRecoveryManifest,
} from '../../packages/event-store/src/index.js';
import { openStore } from '../../packages/event-store/src/db.js';
import { isoFromMs, msFromIso, opaqueToken, sha256Hex, uuid } from '../../packages/event-store/src/util.js';

export const BASE_ISO = '2026-11-01T00:00:00.000Z';

export { canonicalDigest, isoFromMs, msFromIso, opaqueToken, sha256Hex, uuid };
export { openStore, writerLockPath } from '../../packages/event-store/src/db.js';
export { CURRENT_SCHEMA_VERSION } from '../../packages/event-store/src/schema.js';
export { countEvents } from '../../packages/event-store/src/ingest.js';

export function createTestClock(startIso = BASE_ISO) {
  let wall = msFromIso(startIso);
  const monoOrigin = msFromIso(startIso);
  let mono = monoOrigin;
  return {
    nowIso: () => isoFromMs(wall),
    nowMs: () => wall,
    monoMs: () => mono,
    /** wall 与 mono 一起前进：正常的"时间流逝"。 */
    advance(deltaMs) {
      wall += deltaMs;
      mono += deltaMs;
      return isoFromMs(wall);
    },
    /** 只推 wall、不动 mono：模拟系统时间被调整 / NTP 跳变。 */
    advanceWallOnly(deltaMs) {
      wall += deltaMs;
      return isoFromMs(wall);
    },
    /** 只推 mono、不动 wall：模拟休眠唤醒（wall 未变但单调时钟走了）。 */
    advanceMonoOnly(deltaMs) {
      mono += deltaMs;
      return isoFromMs(wall);
    },
    set(iso) {
      wall = msFromIso(iso);
      return isoFromMs(wall);
    },
  };
}

/**
 * 临时目录登记表 + 文件级清理。
 *
 * 不能把"删目录"注册成每个用例的 `t.after`：node:test 按注册顺序执行 after 钩子，
 * 先注册的删目录会跑在"关闭数据库句柄"之前，Windows 上直接 EPERM。
 * 所以删目录统一挪到文件级 `after`——那时所有用例的句柄都已关闭。
 */
const TEMP_DIRS = new Set();

function safeRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  } catch {
    // 临时目录残留不该让测试变红；真实断言失败另有报错。
  }
}

after(() => {
  for (const dir of TEMP_DIRS) safeRemove(dir);
  TEMP_DIRS.clear();
});

export function makeTempDir(t, label = 'wp1-store') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  TEMP_DIRS.add(dir);
  void t;
  return dir;
}

/**
 * 打开一个测试用的可写存储。
 *
 * `auditKey` 默认给出，这样审计链会走真实 HMAC 分支；
 * 需要验证 `placeholder` 分支的用例显式传 `auditKey: null`。
 */
export function openTestStore(t, options = {}) {
  const dir = options.directory ?? makeTempDir(t);
  // 句柄关闭注册在用例级：文件级 after 删目录时一定已经关过了。
  const clock = options.clock ?? createTestClock();
  const store = openStore({
    path: path.join(dir, options.fileName ?? 'aegis-harness.db'),
    clock,
    auditKey: options.auditKey === undefined ? 'test-audit-key-0123456789abcdef' : (options.auditKey ?? undefined),
    policyVersion: options.policyVersion,
  });
  t.after(() => {
    try {
      store.close();
    } catch {
      // 用例里可能已经手动关闭。
    }
  });
  return { store, dir, clock };
}

export function expectStoreError(fn, code, message) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, `${message ?? 'expected a StoreError'}: nothing was thrown`);
  assert.equal(caught.name, 'StoreError', `expected StoreError, got ${caught.name}: ${caught.message}`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

export function expectContractError(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, 'expected a ContractError: nothing was thrown');
  assert.equal(caught.name, 'ContractError', `expected ContractError, got ${caught.name}: ${caught.message}`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

let eventSeq = 0;

export function makeEvent(overrides = {}) {
  eventSeq += 1;
  const payload = overrides.payload ?? { process_name: 'demo.exe', pid: 4000 + eventSeq };
  const event = {
    schemaVersion: '1.0',
    event_id: overrides.event_id ?? uuid(),
    stable_source_id: overrides.stable_source_id ?? 'windows.security.4688',
    collector_instance_id: overrides.collector_instance_id ?? uuid(),
    source_generation: overrides.source_generation ?? 1,
    boot_id: overrides.boot_id ?? 'a'.repeat(32),
    source_seq: overrides.source_seq ?? eventSeq,
    observed_at: overrides.observed_at ?? '2026-11-01T00:00:00.000Z',
    received_at: overrides.received_at ?? '2026-11-01T00:00:01.000Z',
    type: overrides.type ?? 'process.start',
    severity: overrides.severity ?? 'high',
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
  };
  if (overrides.native_record_id !== undefined) {
    event.native_record_id = overrides.native_record_id;
  }
  return event;
}

export function makeFinding(overrides = {}) {
  const eventIds = overrides.event_ids ?? [uuid()];
  return validateFinding({
    schemaVersion: '1.0',
    finding_id: overrides.finding_id ?? uuid(),
    rule_id: overrides.rule_id ?? 'proc_persist',
    rule_version: overrides.rule_version ?? '1.0.0',
    event_ids: eventIds,
    fingerprint: overrides.fingerprint ?? sha256Hex(`finding-${eventIds.join(',')}`),
    severity: overrides.severity ?? 'high',
    status: overrides.status ?? 'new',
    first_seen: overrides.first_seen ?? '2026-11-01T00:00:00.000Z',
    last_seen: overrides.last_seen ?? '2026-11-01T00:00:01.000Z',
    count: overrides.count ?? eventIds.length,
    evidence_refs: overrides.evidence_refs ?? [],
  }).value;
}

export function makeAlert(overrides = {}) {
  const eventIds = overrides.event_ids ?? [uuid()];
  return validateAlert({
    schemaVersion: '1.0',
    alert_id: overrides.alert_id ?? uuid(),
    rule_id: overrides.rule_id ?? 'proc_persist',
    rule_version: overrides.rule_version ?? '1.0.0',
    fingerprint: overrides.fingerprint ?? sha256Hex('alert-fp-default'),
    severity: overrides.severity ?? 'high',
    status: overrides.status ?? 'new',
    first_seen: overrides.first_seen ?? '2026-11-01T00:00:00.000Z',
    last_seen: overrides.last_seen ?? '2026-11-01T00:00:01.000Z',
    window_start: overrides.window_start ?? '2026-11-01T00:00:00.000Z',
    window_end: overrides.window_end ?? '2026-11-01T00:15:00.000Z',
    count: overrides.count ?? eventIds.length,
    event_ids: eventIds,
    event_ids_truncated: overrides.event_ids_truncated ?? false,
    evidence_refs: overrides.evidence_refs ?? [],
  }).value;
}

export function makeAnalysisRequest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    analysis_id: overrides.analysis_id ?? uuid(),
    alert_id: overrides.alert_id,
    budget_class: overrides.budget_class ?? 'standard',
    summary_dto: overrides.summary_dto ?? { classification: 'D1', fields: { process_name: 'demo.exe' } },
    created_at: overrides.created_at ?? '2026-11-01T00:00:02.000Z',
    idempotency_key: overrides.idempotency_key ?? opaqueToken(),
    epoch: overrides.epoch,
  };
}

export function analysisRequestOptions() {
  // summary_dto 的字段必须在 allowlist 里，否则 contracts 会拒绝（ERR_SUMMARY_FIELD_NOT_ALLOWED）。
  return { allowedSummaryFields: ['process_name', 'rule_id'] };
}

export function makeProposal(overrides = {}) {
  const target = overrides.normalized_target ?? {
    target_kind: 'process',
    digest: sha256Hex('target-process-1'),
    object_id: opaqueToken(),
  };
  return validateResponseProposal({
    schemaVersion: '1.0',
    proposal_id: overrides.proposal_id ?? uuid(),
    analysis_id: overrides.analysis_id,
    action_id: overrides.action_id ?? 'process.terminate',
    normalized_target: target,
    justification_evidence: overrides.justification_evidence ?? [uuid()],
    risk: overrides.risk ?? 'high',
    expires_at: overrides.expires_at ?? '2026-11-01T01:00:00.000Z',
  }).value;
}

export function makeApproval(overrides = {}) {
  return validateApproval({
    schemaVersion: '1.0',
    approval_id: overrides.approval_id ?? uuid(),
    proposal_digest: overrides.proposal_digest,
    policy_version: overrides.policy_version ?? '1.0',
    target_digest: overrides.target_digest,
    approver_identity: overrides.approver_identity ?? {
      account_id: 'AEGIS\\responder',
      role_snapshot: ['responder'],
      reauthenticated_at: overrides.reauthenticated_at ?? '2026-11-01T00:00:10.000Z',
    },
    nonce: overrides.nonce ?? opaqueToken(),
    issued_at: overrides.issued_at ?? '2026-11-01T00:00:20.000Z',
    expires_at: overrides.expires_at ?? '2026-11-01T00:30:00.000Z',
    epoch: overrides.epoch,
    state: overrides.state ?? 'pending',
  }).value;
}

export function makeReport(overrides = {}) {
  return {
    schemaVersion: '1.0',
    analysis_id: overrides.analysis_id,
    summary: overrides.summary ?? 'Synthetic process persistence observed; summary only.',
    confidence: overrides.confidence ?? 0.5,
    evidence_ids: overrides.evidence_ids ?? [],
    limitations: overrides.limitations ?? ['synthetic fixture'],
    model_meta: overrides.model_meta ?? {
      provider_id: 'deepseek',
      model_id: 'deepseek-v4-flash',
      request_ids: overrides.request_ids ?? [],
    },
  };
}

/** 建一条 alert 并返回它的 alert_id，供 T1/T2/T5 用例复用。 */
export function seedAlert(store, { ingestTelemetry }, overrides = {}) {
  const alert = makeAlert(overrides);
  const result = ingestTelemetry(store, {
    event: makeEvent({ received_at: overrides.received_at ?? '2026-11-01T00:00:01.000Z' }),
    alerts: [alert],
  });
  assert.equal(result.duplicate, false);
  return result.alerts[0].alert_id;
}

/**
 * 极简"竞态计数器"：用来证明同一个键只会被成功占用一次。
 *
 * 这里刻意不用 `Promise.all` 造并发——单写者是同步 API，"并发"在测试里
 * 必须表现为**交错调用**，否则测的只是 Promise 调度而不是事务语义。
 */
export function makeRaceProbe() {
  let attempts = 0;
  let wins = 0;
  return {
    attempt(outcome) {
      attempts += 1;
      if (outcome) wins += 1;
      return outcome;
    },
    get summary() {
      return { attempts, wins };
    },
  };
}


/**
 * 建一条"已审批"的执行上下文：alert → analysis → claim → proposal → pending → approved。
 *
 * 时间全部取自注入时钟，用例只负责 `clock.advance()` 把时间推到想要的位置。
 */
export function buildApprovedExecution(store, options = {}) {
  const now = store.clock.nowIso();
  const alert = makeAlert(options.alert ?? {});
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  const ingest = ingestTelemetry(store, {
    event: makeEvent({ observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  const claim = claimAnalysis(store, {
    analysis_id: analysis.analysis_id,
    owner: options.owner ?? 'broker-1',
    now,
  });
  const proposalValue = makeProposal({ analysis_id: analysis.analysis_id, expires_at: isoFromMs(msFromIso(now) + 3600000) });
  const proposal = registerProposal(store, { proposal: proposalValue, now });
  const approvalValue = makeApproval({
    proposal_digest: proposal.digest,
    target_digest: proposalValue.normalized_target.digest,
    epoch: store.epoch(),
    issued_at: now,
    reauthenticated_at: now,
    expires_at: isoFromMs(msFromIso(now) + 1800000),
  });
  createApproval(store, { approval: approvalValue, proposal_id: proposalValue.proposal_id, now });
  const approved = approveExecution(store, {
    approval_id: approvalValue.approval_id,
    roles: options.roles ?? ['responder'],
    // T3a 要求会话身份与审批里绑定的 approver 一致，测试里显式给出。
    actorId: options.actorId ?? approvalValue.approver_identity.account_id,
    now,
  });
  return { alert, analysis, ingest, claim, proposalValue, proposal, approvalValue, approved, now };
}

/** 在上面的基础上把 T3b/T3c 前半做完：Grant + outbox + dispatched。 */
export function buildDispatchedExecution(store, options = {}) {
  const context = buildApprovedExecution(store, options);
  const dispatch = prepareDispatch(store, {
    approval_id: context.approvalValue.approval_id,
    now: store.clock.nowIso(),
  });
  const dispatched = markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  return { ...context, dispatch, dispatched };
}

/** 再往前一步：helper 受理 + 恢复清单 + 进入 executing。 */
export function buildExecutingExecution(store, options = {}) {
  const context = buildDispatchedExecution(store, options);
  const accepted = acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: options.helperOwner ?? 'helper-1',
    lease_ms: options.lease_ms ?? 60000,
    now: store.clock.nowIso(),
  });
  const manifest = writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    object_identity: { pid: 4242, started_at: '2026-10-31T00:00:00.000Z' },
    before_state: { running: true },
    after_state: { running: false },
    now: store.clock.nowIso(),
  });
  const executing = beginExecuting(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: options.helperOwner ?? 'helper-1',
    now: store.clock.nowIso(),
  });
  return { ...context, accepted, manifest, executing };
}
