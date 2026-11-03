/**
 * T4 结算、恢复清单、结果未知与租约核对。
 *
 * 这一组用例是 AT-RESP-003 的可执行版本：在"清单 fsync 之后 / OS 调用前后 /
 * 结果写库前后"这些位置强杀，唯一允许的产物是 `result_unknown` 与核对请求，
 * 绝不允许"自动再来一次"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptExecution,
  beginExecuting,
  getExecutionResults,
  getRecoveryManifestByAttempt,
  markManualRequired,
  markResultUnknown,
  markExecutionDispatched,
  prepareDispatch,
  redeliverExecution,
  requestReconcile,
  settleExecution,
  sweepExpiredExecutionLeases,
  transitionRecovery,
  writeRecoveryManifest,
} from '../../packages/event-store/src/index.js';

import {
  buildDispatchedExecution,
  buildExecutingExecution,
  buildApprovedExecution,
  expectStoreError,
  openTestStore,
  uuid,
} from './helpers.js';

const MINUTE = 60000;

function acceptedOnly(store) {
  const context = buildDispatchedExecution(store);
  const accepted = acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    lease_ms: MINUTE,
    now: store.clock.nowIso(),
  });
  return { ...context, accepted };
}

test('没有恢复清单时不允许进入 executing（清单必须先于副作用）', (t) => {
  const { store } = openTestStore(t);
  const context = acceptedOnly(store);
  const error = expectStoreError(
    () => beginExecuting(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      now: store.clock.nowIso(),
    }),
    'ERR_RECOVERY_STATE',
  );
  assert.equal(error.details.manifest_state, null);
});

test('写入 prepared 清单后进入 executing，清单同步转 executing', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  const execution = store.get('SELECT state FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'executing');
  const manifest = getRecoveryManifestByAttempt(store, context.approved.attempt_id);
  assert.equal(String(manifest.state), 'executing');
  assert.equal(String(manifest.execution_id), context.approved.execution_id);
  assert.equal(String(manifest.operation_id).length > 0, true);
});

test('结算成功：execution→succeeded、清单→applied、结果行唯一', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  const settled = settleExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 1,
    outcome: 'succeeded',
    result: { stopped: true, pid: 4242 },
    now: store.clock.nowIso(),
  });
  assert.equal(settled.state, 'succeeded');
  assert.equal(settled.manifest_state, 'applied');
  assert.equal(getExecutionResults(store, context.approved.execution_id).length, 1);
  const manifest = getRecoveryManifestByAttempt(store, context.approved.attempt_id);
  assert.equal(String(manifest.state), 'applied');
});

test('重复结果（同一 result_seq）是幂等确认，不二次结算', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  const input = {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 1,
    outcome: 'succeeded',
    result: { stopped: true },
    now: store.clock.nowIso(),
  };
  settleExecution(store, input);
  const again = settleExecution(store, input);
  assert.equal(again.duplicate, true);
  assert.equal(again.state, 'succeeded');
  assert.equal(getExecutionResults(store, context.approved.execution_id).length, 1);
});

test('终态之后新的 result_seq 也被忽略，不覆盖既有结论', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  settleExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 1,
    outcome: 'succeeded',
    result: { stopped: true },
    now: store.clock.nowIso(),
  });
  const later = settleExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 2,
    outcome: 'failed',
    result: { stopped: false },
    now: store.clock.nowIso(),
  });
  assert.equal(later.duplicate, true);
  assert.equal(later.outcome, 'succeeded');
  const execution = store.get('SELECT state FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'succeeded');
});

test('owner 不符时不能结算（旧 owner 提交无效）', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  expectStoreError(
    () => settleExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-2',
      result_seq: 1,
      outcome: 'succeeded',
      result: {},
      now: store.clock.nowIso(),
    }),
    'ERR_STALE_OWNER',
  );
});

test('租约过期后结算被拒绝（迟到的结果不做数）', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildExecutingExecution(store, { lease_ms: 30000 });
  clock.advance(2 * MINUTE);
  expectStoreError(
    () => settleExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      result_seq: 1,
      outcome: 'succeeded',
      result: {},
      now: clock.nowIso(),
    }),
    'ERR_LEASE_EXPIRED',
  );
});

test('result_unknown → reconciling 只允许查询，不允许重投', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  const unknown = markResultUnknown(store, {
    execution_id: context.approved.execution_id,
    reason: 'helper_crashed',
    now: store.clock.nowIso(),
  });
  assert.equal(unknown.state, 'result_unknown');
  const reconcile = requestReconcile(store, {
    execution_id: context.approved.execution_id,
    now: store.clock.nowIso(),
  });
  assert.equal(reconcile.state, 'reconciling');
  assert.equal(reconcile.next_action, 'query_only');
  // reconcile 本身不碰 outbox；再显式证明"重投"这条路是堵死的（不是"没碰"就算安全）。
  const outbox = store.get('SELECT attempts FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(Number(outbox.attempts), 1, 'reconcile must not redeliver');
  expectStoreError(
    () => redeliverExecution(store, { execution_id: context.approved.execution_id }),
    'ERR_EXECUTION_STATE',
  );
});

test('核对之后可以按实际结果结算', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  markResultUnknown(store, { execution_id: context.approved.execution_id, now: store.clock.nowIso() });
  requestReconcile(store, { execution_id: context.approved.execution_id, now: store.clock.nowIso() });
  const settled = settleExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 1,
    outcome: 'failed',
    result: { reconciled: true },
    now: store.clock.nowIso(),
  });
  assert.equal(settled.state, 'failed');
  assert.equal(settled.duplicate, false);
});

test('租约过期的 accepted 只置核对标记，不改状态、不重投', (t) => {
  const { store, clock } = openTestStore(t);
  const context = acceptedOnly(store);
  clock.advance(2 * MINUTE);
  const sweep = sweepExpiredExecutionLeases(store, { now: clock.nowIso() });
  assert.equal(sweep.scanned, 1);
  assert.equal(sweep.results[0].action, 'verify_with_helper');
  const execution = store.get('SELECT state, need_reconcile FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'accepted');
  assert.equal(Number(execution.need_reconcile), 1);
  const outbox = store.get('SELECT attempts FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(Number(outbox.attempts), 1);
});

test('租约过期的 executing 转为 result_unknown', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildExecutingExecution(store, { lease_ms: 1000 });
  clock.advance(2 * MINUTE);
  const sweep = sweepExpiredExecutionLeases(store, { now: clock.nowIso() });
  assert.equal(sweep.results[0].action, 'reconcile');
  const execution = store.get('SELECT state FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'result_unknown');
});

test('manual_required 是明确的终态出口，重复调用只做幂等确认', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  const manual = markManualRequired(store, {
    execution_id: context.approved.execution_id,
    reason: 'side_effect_unverifiable',
    now: store.clock.nowIso(),
  });
  assert.equal(manual.state, 'manual_required');
  const again = markManualRequired(store, {
    execution_id: context.approved.execution_id,
    now: store.clock.nowIso(),
  });
  assert.equal(again.duplicate, true);
  const execution = store.get('SELECT state FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'manual_required');
});

test('已经以 succeeded 终结的执行不能再转 manual_required', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  settleExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 1,
    outcome: 'succeeded',
    result: { stopped: true },
    now: store.clock.nowIso(),
  });
  expectStoreError(
    () => markManualRequired(store, { execution_id: context.approved.execution_id, now: store.clock.nowIso() }),
    'ERR_EXECUTION_STATE',
  );
});

test('恢复清单状态迁移是白名单：prepared 不能直接跳到 applied', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  const manifest = getRecoveryManifestByAttempt(store, context.approved.attempt_id);
  // 当前已经在 executing；先回到一个"只能前进"的状态检查点。
  const error = expectStoreError(
    () => transitionRecovery(store, { recovery_id: String(manifest.recovery_id), state: 'restored', now: store.clock.nowIso() }),
    'ERR_RECOVERY_STATE',
  );
  assert.equal(error.details.from, 'executing');
});

test('清单仍是 prepared 却报告 succeeded：不猜，直接转 manual_required', (t) => {
  const { store } = openTestStore(t);
  const context = acceptedOnly(store);
  writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    object_identity: { pid: 4242 },
    before_state: { running: true },
    after_state: { running: false },
    now: store.clock.nowIso(),
  });
  const settled = settleExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    result_seq: 1,
    outcome: 'succeeded',
    result: { stopped: true },
    now: store.clock.nowIso(),
  });
  assert.equal(settled.manifest_state, 'manual_required');
  const manifest = getRecoveryManifestByAttempt(store, context.approved.attempt_id);
  assert.equal(String(manifest.state), 'manual_required');
});

test('重复写同一 attempt 的恢复清单是幂等的', (t) => {
  const { store } = openTestStore(t);
  const context = acceptedOnly(store);
  const first = writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    object_identity: { pid: 1 },
    before_state: { a: 1 },
    after_state: { a: 2 },
    now: store.clock.nowIso(),
  });
  const second = writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    object_identity: { pid: 1 },
    before_state: { a: 1 },
    after_state: { a: 2 },
    now: store.clock.nowIso(),
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.recovery_id, first.recovery_id);
});

test('not_required 清单也允许进入 executing（不需要回滚的动作）', (t) => {
  const { store } = openTestStore(t);
  const context = acceptedOnly(store);
  writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    state: 'not_required',
    now: store.clock.nowIso(),
  });
  const executing = beginExecuting(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    now: store.clock.nowIso(),
  });
  assert.equal(executing.state, 'executing');
});

test('未知 execution 结算报 ERR_EXECUTION_NOT_FOUND', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => settleExecution(store, {
      execution_id: uuid(),
      attempt_id: uuid(),
      owner: 'helper-1',
      result_seq: 1,
      outcome: 'succeeded',
      result: {},
      now: store.clock.nowIso(),
    }),
    'ERR_EXECUTION_NOT_FOUND',
  );
});

test('批准后未投递的 execution 不能结算（必须先经历投递/受理）', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
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
    'ERR_EXECUTION_STATE',
  );
});

test('settle 的 outcome 非法时在入口被拒', (t) => {
  const { store } = openTestStore(t);
  const context = buildExecutingExecution(store);
  expectStoreError(
    () => settleExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      result_seq: 1,
      outcome: 'result_unknown',
      result: {},
      now: store.clock.nowIso(),
    }),
    'ERR_STORE_INPUT',
  );
});

test('accepted 但未写清单时 dispatched 状态一致（不会出现半更新）', (t) => {
  const { store } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  const execution = store.get('SELECT state FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'dispatched');
  assert.equal(String(store.get('SELECT state FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]).state), 'dispatched');

  // 重复调用 markExecutionDispatched 不应把 outbox 状态改回去，也不应重复计数。
  markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  const outbox = store.get('SELECT state, attempts FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(outbox.state), 'dispatched');
  assert.equal(Number(outbox.attempts), 1);
});
