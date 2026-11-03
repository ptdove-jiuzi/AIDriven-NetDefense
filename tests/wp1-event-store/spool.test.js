/**
 * spool.test.js —— ADR-0007 的落盘表：迁移 v5、内容主键、载荷校验、幂等删除。
 *
 * 这张表是"daemon 写不出去的告警贡献"的唯一跨进程副本，所以这里的断言集中在三件事：
 * 1. **它真的在库里**（迁移 v5 建表，旧库升级后表存在且原有行数不变）；
 * 2. **同一份证据只占一行**（内容主键 + UPSERT，重试多少次都不涨）；
 * 3. **坏载荷进不去、坏行读不出来也不拖垮整表**（fail-closed 到单行，不是整表）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  CONTRIBUTION_SPOOL_TABLE,
  MAX_SPOOL_PAYLOAD_BYTES,
  contributionSpoolId,
  countContributionSpool,
  deleteContributionSpool,
  listContributionSpool,
  normalizeSpoolEntry,
  putContributionSpool,
} from '../../packages/event-store/src/index.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../packages/event-store/src/schema.js';
import { STORE_CODES } from '../../packages/event-store/src/errors.js';
import { openStore } from '../../packages/event-store/src/db.js';

import { expectStoreError, makeTempDir, openTestStore } from './helpers.js';

const NOW = '2026-11-02T00:00:00.000Z';

/** 一条形状正确的告警贡献（只含 spool 会读的字段）。 */
function alert(overrides = {}) {
  return {
    schemaVersion: '1.0',
    alert_id: 'alert-1',
    rule_id: 'proc.suspicious-start',
    rule_version: '1.0.0',
    fingerprint: 'process_name=evil.exe',
    severity: 'high',
    status: 'new',
    first_seen: NOW,
    last_seen: NOW,
    window_start: '2026-11-02T00:00:00.000Z',
    window_end: '2026-11-02T00:15:00.000Z',
    count: 2,
    event_ids: ['evt-a', 'evt-b'],
    event_ids_truncated: false,
    evidence_refs: [],
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    source_id: 'synthetic.a',
    attempts: 0,
    alerts: [alert()],
    requests: [],
    ...overrides,
  };
}

test('迁移 v5 建立落盘表，版本列表连续', (t) => {
  const { store } = openTestStore(t);
  const versions = store.all('SELECT version FROM schema_migration ORDER BY version').map((row) => Number(row.version));
  assert.deepEqual(versions, MIGRATIONS.map((item) => item.version));
  assert.equal(CURRENT_SCHEMA_VERSION, Math.max(...MIGRATIONS.map((item) => item.version)));
  assert.ok(versions.includes(5), '迁移 v5 必须出现在版本列表里');
  const table = store.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [CONTRIBUTION_SPOOL_TABLE],
  );
  assert.notEqual(table, null);
  assert.equal(countContributionSpool(store), 0);
});

test('v4 旧库升级到 v5：表被建出来，原有行不受影响', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'v4.db');
  const old = openStore({ path: filePath, upTo: 4 });
  const before = Number(old.get('SELECT COUNT(*) AS c FROM telemetry_event').c);
  old.close();

  const upgraded = openStore({ path: filePath });
  t.after(() => upgraded.close());
  assert.equal(Number(upgraded.getMeta('schema_version')), CURRENT_SCHEMA_VERSION);
  assert.notEqual(
    upgraded.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [CONTRIBUTION_SPOOL_TABLE]),
    null,
  );
  assert.equal(Number(upgraded.get('SELECT COUNT(*) AS c FROM telemetry_event').c), before);
});

test('内容主键：同一份证据重复写入只占一行，attempts 被更新', (t) => {
  const { store } = openTestStore(t);
  const first = putContributionSpool(store, entry(), NOW);
  assert.equal(first.created, true);
  const second = putContributionSpool(store, entry({ attempts: 3 }), NOW);
  assert.equal(second.created, false);
  assert.equal(second.spool_id, first.spool_id);
  assert.equal(countContributionSpool(store), 1);
  const listed = listContributionSpool(store);
  assert.equal(listed.skipped, 0);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].attempts, 3);
  assert.equal(listed.entries[0].source_id, 'synthetic.a');
  assert.deepEqual(listed.entries[0].alerts[0].event_ids, ['evt-a', 'evt-b']);
});

test('内容主键忽略 DTO 的时间与严重度：同证据不同快照仍是同一行', (t) => {
  const { store } = openTestStore(t);
  putContributionSpool(store, entry(), NOW);
  putContributionSpool(store, entry({
    alerts: [alert({ severity: 'critical', last_seen: '2026-11-02T00:05:00.000Z' })],
  }), NOW);
  assert.equal(countContributionSpool(store), 1, '同来源 + 同窗口 + 同证据 ⇒ 同一行');
  const listed = listContributionSpool(store);
  assert.equal(listed.entries[0].alerts[0].severity, 'critical', 'UPSERT 用最新快照覆盖');
});

test('不同来源 / 不同窗口 / 不同证据 ⇒ 不同行', (t) => {
  const { store } = openTestStore(t);
  putContributionSpool(store, entry(), NOW);
  putContributionSpool(store, entry({ source_id: 'synthetic.b' }), NOW);
  putContributionSpool(store, entry({
    alerts: [alert({ window_start: '2026-11-02T00:15:00.000Z' })],
  }), NOW);
  putContributionSpool(store, entry({ alerts: [alert({ event_ids: ['evt-a', 'evt-b', 'evt-c'] })] }), NOW);
  assert.equal(countContributionSpool(store), 4);
  assert.notEqual(
    contributionSpoolId(normalizeSpoolEntry(entry())),
    contributionSpoolId(normalizeSpoolEntry(entry({ source_id: null }))),
    '未知来源自成作用域',
  );
});

test('载荷非法：拒绝且不写入', (t) => {
  const { store } = openTestStore(t);
  const cases = [
    { label: '非对象', value: 'nope', field: 'entry' },
    { label: '缺 alerts', value: { source_id: 's', requests: [] }, field: 'alerts' },
    { label: 'alerts 元素不是对象', value: { source_id: 's', alerts: [null], requests: [] }, field: 'alerts[]' },
    { label: '缺指纹', value: { source_id: 's', alerts: [{ ...alert(), fingerprint: '' }], requests: [] }, field: 'alerts[].fingerprint' },
    { label: 'count 非整数', value: { source_id: 's', alerts: [{ ...alert(), count: 1.5 }], requests: [] }, field: 'alerts[].count' },
    { label: 'event_ids 含非字符串', value: { source_id: 's', alerts: [{ ...alert(), event_ids: [1] }], requests: [] }, field: 'alerts[].event_ids' },
    { label: 'attempts 为负', value: { attempts: -1, source_id: 's', alerts: [alert()], requests: [] }, field: 'attempts' },
    { label: 'source_id 非字符串', value: { source_id: 7, alerts: [alert()], requests: [] }, field: 'source_id' },
  ];
  for (const item of cases) {
    const error = expectStoreError(() => putContributionSpool(store, item.value, NOW), STORE_CODES.ERR_STORE_INPUT, item.label);
    assert.deepEqual(Object.keys(error.details ?? {}).filter((key) => key === 'field'), ['field'], 'details 只暴露字段名');
  }
  assert.equal(countContributionSpool(store), 0, '被拒绝的载荷不得留下任何行');
});

test('超大载荷被拒绝（不把一条坏条目变成写放大）', (t) => {
  const { store } = openTestStore(t);
  // 用大量合法 id 撑到上限以上：既不走 JSON 序列化错误，也不触发别的校验。
  const many = Array.from({ length: 120_000 }, (_unused, index) => `evt-${index}`);
  const payload = entry({ alerts: [alert({ event_ids: many })] });
  expectStoreError(() => putContributionSpool(store, payload, NOW), STORE_CODES.ERR_STORE_INPUT, '超大载荷');
  assert.equal(countContributionSpool(store), 0);
  assert.ok(MAX_SPOOL_PAYLOAD_BYTES > 0);
});

test('删除幂等：删两次都安全，第二次返回 false', (t) => {
  const { store } = openTestStore(t);
  const { spool_id: spoolId } = putContributionSpool(store, entry(), NOW);
  assert.equal(deleteContributionSpool(store, spoolId), true);
  assert.equal(deleteContributionSpool(store, spoolId), false);
  assert.equal(countContributionSpool(store), 0);
  expectStoreError(() => deleteContributionSpool(store, ''), STORE_CODES.ERR_STORE_INPUT, '空 id');
});

test('单行坏数据只跳过该行，不影响其余条目', (t) => {
  const { store } = openTestStore(t);
  putContributionSpool(store, entry(), NOW);
  // 直接写一条 payload 错误的行：模拟磁盘损坏 / 旧版本残留。
  store.run(
    `INSERT INTO ${CONTRIBUTION_SPOOL_TABLE} (spool_id, source_id, windows_json, attempts, created_at, updated_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['broken-row', 'synthetic.a', '[]', 0, NOW, NOW, '{"alerts": "not-an-array"}'],
  );
  const listed = listContributionSpool(store);
  assert.equal(listed.skipped, 1);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].spool_id.startsWith('broken-row'), false);
});

test('只读句柄不能写 spool（与 T1 同级约束）', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ro.db');
  const writable = openStore({ path: filePath });
  putContributionSpool(writable, entry(), NOW);
  writable.close();

  const readOnly = openStore({ path: filePath, readOnly: true });
  t.after(() => readOnly.close());
  expectStoreError(() => putContributionSpool(readOnly, entry(), NOW), STORE_CODES.ERR_STORE_READ_ONLY, '只读句柄');
  assert.equal(countContributionSpool(readOnly), 1, '只读句柄仍能读');
});
