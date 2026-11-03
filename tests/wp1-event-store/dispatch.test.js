/**
 * T3b / T3c：授权与投递准备、交付与接受。
 *
 * 核心不变量：
 * - nonce **只消费一次**（第二次 prepareDispatch 必须失败，而不是再签一份）；
 * - 重投只用同一条 Grant、同一个 execution_id/attempt_id，绝不生成新动作；
 * - helper 的受理消息按 `(execution_id, attempt_id, seq)` 去重；
 * - 进入 accepted/executing 之后，重投与旧 attempt 都不能推进状态。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateExecutionGrant } from '../../packages/contracts/src/index.js';

import {
  acceptExecution,
  markExecutionDispatched,
  prepareDispatch,
  redeliverExecution,
  rotateEpoch,
} from '../../packages/event-store/src/index.js';

import {
  buildApprovedExecution,
  expectStoreError,
  openTestStore,
  uuid,
} from './helpers.js';

test('T3b 生成 Grant：审批转 consumed、execution 转 dispatch_pending、outbox 落 pending', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  const dispatched = prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });

  assert.equal(dispatched.state, 'dispatch_pending');
  assert.equal(dispatched.execution_id, context.approved.execution_id);
  assert.equal(dispatched.attempt_id, context.approved.attempt_id);

  const approval = store.get('SELECT state, consumed_at FROM approval WHERE approval_id = ?', [context.approvalValue.approval_id]);
  assert.equal(String(approval.state), 'consumed');
  assert.ok(approval.consumed_at !== null);
  const execution = store.get('SELECT state, grant_json, grant_digest FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'dispatch_pending');
  assert.ok(String(execution.grant_json).length > 0);
  const outbox = store.get('SELECT * FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(outbox.state), 'pending');
  assert.equal(Number(outbox.attempts), 0);
});

test('Grant 结构合法、nonce 与 execution 绑定、epoch 一致', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  const dispatched = prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });

  // 用合同层的校验器再验一遍：存储层签出来的 Grant 必须能被合同接受。
  const record = validateExecutionGrant(dispatched.grant);
  assert.equal(record.value.execution_id, context.approved.execution_id);
  assert.equal(record.value.approval_id, context.approvalValue.approval_id);
  assert.equal(record.value.epoch, store.epoch());

  const execution = store.get('SELECT nonce, target_digest FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(record.value.nonce, String(execution.nonce));
  assert.equal(record.value.target_digest, String(execution.target_digest));
});

test('nonce 只能消费一次：第二次 prepareDispatch 报 ERR_NONCE_CONSUMED', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  expectStoreError(
    () => prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() }),
    'ERR_NONCE_CONSUMED',
  );
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM execution').c), 1);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM execution_outbox').c), 1);
});

test('epoch 轮换后旧审批无法再投递', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  rotateEpoch(store, { now: store.clock.nowIso() });
  expectStoreError(
    () => prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() }),
    'ERR_EPOCH_MISMATCH',
  );
});

test('未被批准的审批不能投递', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  store.run("UPDATE approval SET state = 'pending' WHERE approval_id = ?", [context.approvalValue.approval_id]);
  expectStoreError(
    () => prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() }),
    'ERR_APPROVAL_STATE',
  );
});

test('T3c：outbox 标记 dispatched，attempts 只加一次', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });

  const first = markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  const second = markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const outbox = store.get('SELECT * FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(outbox.state), 'dispatched');
  assert.equal(Number(outbox.attempts), 1);
  const execution = store.get('SELECT state FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'dispatched');
});

test('重投使用同一条 Grant 与同一个 attempt，只增加计数', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  const dispatch = prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });

  const redelivered = redeliverExecution(store, { execution_id: context.approved.execution_id });
  assert.equal(redelivered.grant.nonce, dispatch.grant.nonce);
  assert.equal(redelivered.attempt_id, context.approved.attempt_id);
  assert.equal(redelivered.attempts, 1);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM execution').c), 1);

  const again = redeliverExecution(store, { execution_id: context.approved.execution_id });
  assert.equal(again.attempts, 2);
});

test('helper 受理后写入 accepted、owner 与租约，outbox 转 acked', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });

  const accepted = acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    lease_ms: 60000,
    now: store.clock.nowIso(),
  });
  assert.equal(accepted.state, 'accepted');
  const execution = store.get('SELECT * FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'accepted');
  assert.equal(String(execution.owner), 'helper-1');
  // 租约必须真的从"现在"起算 60 秒，而不是随便一个正数。
  const nowMs = store.clock.nowMs();
  assert.ok(
    Math.abs(Number(execution.lease_expires_at_ms) - (nowMs + 60000)) <= 1,
    `lease must end at now+60000, got ${execution.lease_expires_at_ms} vs ${nowMs + 60000}`,
  );
  const outbox = store.get('SELECT state FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(outbox.state), 'acked');
});

test('重复受理消息按 inbox 去重，不重复推进状态', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  const input = {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    now: store.clock.nowIso(),
  };
  const first = acceptExecution(store, input);
  const second = acceptExecution(store, input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.owner, 'helper-1');
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM execution_inbox').c), 1);
});

test('attempt_id 不属于该 execution 时拒绝（旧 owner 不能提交）', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  expectStoreError(
    () => acceptExecution(store, {
      execution_id: context.approved.execution_id,
      attempt_id: uuid(),
      owner: 'helper-1',
      now: store.clock.nowIso(),
    }),
    'ERR_STALE_OWNER',
  );
});

test('受理之后不允许再重投（不生成新动作）', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    now: store.clock.nowIso(),
  });
  expectStoreError(
    () => redeliverExecution(store, { execution_id: context.approved.execution_id }),
    'ERR_EXECUTION_STATE',
  );
});

test('已受理后再次受理（新 seq）只做幂等确认，不回退状态', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    seq: 1,
    now: store.clock.nowIso(),
  });
  const later = acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    seq: 2,
    now: store.clock.nowIso(),
  });
  assert.equal(later.duplicate, true);
  assert.equal(later.state, 'accepted');
  const execution = store.get('SELECT state, owner FROM execution WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(String(execution.state), 'accepted');
  assert.equal(String(execution.owner), 'helper-1');
});

test('未知 execution 无法受理', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => acceptExecution(store, { execution_id: uuid(), attempt_id: uuid(), owner: 'helper-1', now: store.clock.nowIso() }),
    'ERR_EXECUTION_NOT_FOUND',
  );
});

test('没有 outbox 行时无法标记 dispatched', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  expectStoreError(
    () => markExecutionDispatched(store, {
      execution_id: context.approved.execution_id,
      attempt_id: uuid(),
      now: store.clock.nowIso(),
    }),
    'ERR_EXECUTION_NOT_FOUND',
  );
});
