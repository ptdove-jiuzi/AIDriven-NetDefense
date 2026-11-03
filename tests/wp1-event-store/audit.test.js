/**
 * 审计链：追加、结构验证、篡改检测、HMAC 模式。
 *
 * 要说清楚的是"它证明了什么"：`ok: true` 只证明**给定的这批记录彼此接得上**，
 * 不证明没有被整体重写。用例里既测它能抓到的篡改（改内容、删中间、换摘要），
 * 也测它抓不到的东西（用错误密钥时是 `hmacVerified: false` 之外的硬失败，
 * 而不是假装通过）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendAudit,
  auditHead,
  ingestTelemetry,
  verifyAuditChainInStore,
} from '../../packages/event-store/src/index.js';

import {
  expectStoreError,
  makeEvent,
  openStore,
  openTestStore,
  sha256Hex,
} from './helpers.js';

function ingestOne(store, index) {
  return ingestTelemetry(store, {
    event: makeEvent({ native_record_id: `audit-${index}` }),
    now: '2026-11-01T00:00:02.000Z',
  });
}

test('链从序号 1 开始，创世条目的 previous_digest 是 64 个 0', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  const row = store.get('SELECT * FROM audit_event WHERE sequence = 1');
  assert.equal(String(row.previous_digest), '0'.repeat(64));
  assert.equal(auditHead(store).sequence, 1);
});

test('连续追加时序号 +1 且前驱摘要相接', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  ingestOne(store, 3);
  const rows = store.all('SELECT sequence, previous_digest, record_digest FROM audit_event ORDER BY sequence');
  assert.deepEqual(rows.map((row) => Number(row.sequence)), [1, 2, 3]);
  assert.equal(String(rows[1].previous_digest), String(rows[0].record_digest));
  assert.equal(String(rows[2].previous_digest), String(rows[1].record_digest));
  const verification = verifyAuditChainInStore(store);
  assert.equal(verification.ok, true);
  assert.equal(verification.length, 3);
  assert.equal(verification.hmacVerified, true);
});

test('篡改条目内容会被摘要重算抓住', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  store.run(
    "UPDATE audit_event SET canonical_json = replace(canonical_json, 'telemetry.ingest', 'telemetry.ingest ') WHERE sequence = 2",
  );
  let caught = null;
  try {
    verifyAuditChainInStore(store);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, 'tampering must break the chain');
  assert.equal(caught.code, 'ERR_AUDIT_CHAIN_BROKEN');
  assert.equal(caught.name, 'ContractError');
});

test('删除中间条目会被序号缺口抓住', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  ingestOne(store, 3);
  store.run('DELETE FROM audit_event WHERE sequence = 2');
  let caught = null;
  try {
    verifyAuditChainInStore(store);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null);
  assert.equal(caught.code, 'ERR_AUDIT_CHAIN_BROKEN');
});

test('替换 record_digest 会被自洽性检查抓住', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  store.run('UPDATE audit_event SET record_digest = ? WHERE sequence = 1', [sha256Hex('fake')]);
  assert.throws(() => verifyAuditChainInStore(store), /ERR_AUDIT_CHAIN_BROKEN/u);
});

test('未注入密钥时标记为 placeholder，且 hmacVerified 为 null 而不是 true', (t) => {
  const { store } = openTestStore(t, { auditKey: null });
  ingestOne(store, 1);
  assert.equal(store.getMeta('audit_hmac_mode'), 'placeholder');
  const verification = verifyAuditChainInStore(store);
  assert.equal(verification.ok, true);
  assert.equal(verification.hmacVerified, null);
});

test('注入密钥时 HMAC 校验通过，meta 记录 hmac-sha256', (t) => {
  const { store } = openTestStore(t, { auditKey: 'unit-test-key-abc' });
  ingestOne(store, 1);
  assert.equal(store.getMeta('audit_hmac_mode'), 'hmac-sha256');
  assert.equal(verifyAuditChainInStore(store).hmacVerified, true);
});

test('换一把密钥重新校验会硬失败，而不是悄悄降级', (t) => {
  const { store, dir } = openTestStore(t, { auditKey: 'key-one' });
  ingestOne(store, 1);
  ingestOne(store, 2);
  store.close();

  const reopened = openStore({
    path: `${dir}/aegis-harness.db`,
    auditKey: 'key-two',
    clock: store.clock,
  });
  t.after(() => reopened.close());
  expectStoreError(() => verifyAuditChainInStore(reopened), 'ERR_DB_INTEGRITY');
});

test('appendAudit 必须在事务内调用', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => appendAudit(store, {
      action: 'telemetry.ingest',
      actorType: 'daemon',
      actorId: 'aegis-core',
      objectDigest: sha256Hex('x'),
    }),
    'ERR_NOT_SUPPORTED',
  );
});

test('审计只存摘要，不存 payload 原文', (t) => {
  const { store } = openTestStore(t);
  store.tx('manual', () => {
    appendAudit(store, {
      action: 'retention.sweep',
      actorType: 'daemon',
      actorId: 'aegis-core',
      objectDigest: sha256Hex('payload-digest'),
      payload: { secret: 'should-not-be-stored-verbatim' },
    });
  });
  const row = store.get('SELECT canonical_json FROM audit_event ORDER BY sequence DESC LIMIT 1');
  assert.equal(String(row.canonical_json).includes('should-not-be-stored-verbatim'), false);
});

test('verifyAuditChainInStore 支持从中间序号起校验', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  ingestOne(store, 3);
  const partial = verifyAuditChainInStore(store, { from: 2 });
  assert.equal(partial.length, 2);
  assert.equal(partial.from, 2);
  assert.equal(partial.to, 3);
});
