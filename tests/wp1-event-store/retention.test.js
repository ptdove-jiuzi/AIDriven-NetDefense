/**
 * 保留、容量水位、数据缺口与降级。
 *
 * 这些用例守的是"磁盘满的时候谁先死"：清理顺序必须固定，高严重度告警与
 * 审计链不能被顺手删掉，临界水位必须变成**显式降级**而不是悄悄变慢。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessCapacity,
  enforceCapacity,
  getCapabilityState,
  ingestTelemetry,
  listDataGaps,
  purgeAlerts,
  recordDataGap,
  runRetention,
  summarizeDataGaps,
  verifyAuditChainInStore,
} from '../../packages/event-store/src/index.js';

import {
  countEvents,
  expectStoreError,
  isoFromMs,
  makeAlert,
  makeEvent,
  msFromIso,
  openTestStore,
  sha256Hex,
  uuid,
} from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const GIB = 1024 * 1024 * 1024;
const BASE = '2026-11-01T00:00:00.000Z';

function ingestAt(store, receivedAt, overrides = {}) {
  const event = makeEvent({
    native_record_id: `r-${uuid()}`,
    observed_at: receivedAt,
    received_at: receivedAt,
    ...overrides,
  });
  const result = ingestTelemetry(store, { event, now: receivedAt });
  return { event, result };
}

test('保留扫描删除超过 30 天的普通事件', (t) => {
  const { store } = openTestStore(t);
  ingestAt(store, BASE);
  ingestAt(store, BASE);
  const later = isoFromMs(msFromIso(BASE) + 31 * DAY);
  const sweep = runRetention(store, { now: later });
  assert.equal(sweep.telemetry_deleted, 2);
  assert.equal(countEvents(store), 0);
});

test('保留扫描不删未过期事件', (t) => {
  const { store } = openTestStore(t);
  ingestAt(store, BASE);
  const later = isoFromMs(msFromIso(BASE) + 10 * DAY);
  const sweep = runRetention(store, { now: later });
  assert.equal(sweep.telemetry_deleted, 0);
  assert.equal(countEvents(store), 1);
});

test('高严重度告警引用的事件不会被清掉（证据跟着告警走）', (t) => {
  const { store } = openTestStore(t);
  const first = makeEvent({ native_record_id: 'protected', observed_at: BASE, received_at: BASE });
  const alert = makeAlert({
    fingerprint: sha256Hex('critical-fp'),
    severity: 'critical',
    status: 'new',
    event_ids: [first.event_id],
    count: 1,
    first_seen: BASE,
    last_seen: BASE,
    window_start: BASE,
    window_end: isoFromMs(msFromIso(BASE) + 15 * 60000),
  });
  ingestTelemetry(store, { event: first, alerts: [alert], now: BASE });
  ingestAt(store, BASE);

  const later = isoFromMs(msFromIso(BASE) + 31 * DAY);
  const sweep = runRetention(store, { now: later });
  assert.equal(sweep.telemetry_deleted, 1, 'only the unprotected event may go');
  assert.equal(countEvents(store), 1);
});

test('保留扫描只删低严重度告警，高严重度告警保留', (t) => {
  const { store } = openTestStore(t);
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'a1', observed_at: BASE, received_at: BASE }),
    alerts: [makeAlert({
      fingerprint: sha256Hex('low'),
      severity: 'low',
      first_seen: BASE,
      last_seen: BASE,
      window_start: BASE,
      window_end: isoFromMs(msFromIso(BASE) + 900000),
    })],
    now: BASE,
  });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'a2', observed_at: BASE, received_at: BASE }),
    alerts: [makeAlert({
      fingerprint: sha256Hex('critical'),
      severity: 'critical',
      first_seen: BASE,
      last_seen: BASE,
      window_start: BASE,
      window_end: isoFromMs(msFromIso(BASE) + 900000),
    })],
    now: BASE,
  });

  const later = isoFromMs(msFromIso(BASE) + 200 * DAY);
  const sweep = runRetention(store, { now: later });
  assert.equal(sweep.alerts_deleted, 1);
  const remaining = store.all('SELECT severity FROM alert');
  assert.deepEqual(remaining.map((row) => String(row.severity)), ['critical']);
});

test('审计链不参与保留删除，扫描后仍然自洽', (t) => {
  const { store } = openTestStore(t);
  ingestAt(store, BASE);
  const before = Number(store.get('SELECT COUNT(*) AS c FROM audit_event').c);
  const later = isoFromMs(msFromIso(BASE) + 400 * DAY);
  const sweep = runRetention(store, { now: later });
  assert.equal(sweep.audit_deleted, 0);
  const after = Number(store.get('SELECT COUNT(*) AS c FROM audit_event').c);
  assert.equal(after, before + 1, 'only the retention sweep entry is appended');
  assert.equal(verifyAuditChainInStore(store).ok, true);
});

test('水位判定：ok / high / critical 三级', (t) => {
  const { store } = openTestStore(t);
  assert.equal(assessCapacity(store, { external: { databaseBytes: 10 } }).level, 'ok');
  assert.equal(assessCapacity(store, { external: { databaseBytes: 1.7 * GIB } }).level, 'high');
  assert.equal(assessCapacity(store, { external: { databaseBytes: 1.9 * GIB } }).level, 'critical');
  assert.equal(assessCapacity(store, { external: { walBytes: 0.85 * GIB } }).level, 'high');
});

test('磁盘剩余低于 8GiB 直接按临界处理', (t) => {
  const { store } = openTestStore(t);
  const assessment = assessCapacity(store, { external: { diskFreeBytes: 6 * GIB } });
  assert.equal(assessment.level, 'critical');
  assert.deepEqual([...assessment.plan].slice(-3), ['block_new_analysis', 'block_new_response', 'emergency_notify']);
});

test('高水位清理顺序固定：先低价值遥测，再分析索引，最后低级别事件', (t) => {
  const { store } = openTestStore(t);
  const assessment = assessCapacity(store, { external: { databaseBytes: 1.75 * GIB } });
  assert.deepEqual(
    [...assessment.plan],
    ['purge_low_value_telemetry', 'drop_expired_analysis_index', 'purge_aggregated_low_severity'],
  );
});

test('高水位执行清理，不会删高严重度告警', (t) => {
  const { store } = openTestStore(t);
  const old = isoFromMs(msFromIso(BASE) - 20 * DAY);
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'protect-me', observed_at: old, received_at: old }),
    alerts: [makeAlert({
      fingerprint: sha256Hex('cap-critical'),
      severity: 'critical',
      first_seen: old,
      last_seen: old,
      window_start: old,
      window_end: isoFromMs(msFromIso(old) + 900000),
    })],
    now: old,
  });
  // 让 critical 告警引用这条事件，避免它被当作低价值遥测清掉。
  const eventId = String(store.get('SELECT event_id FROM telemetry_event').event_id);
  store.run('UPDATE alert SET event_ids_json = ? WHERE severity = ?', [JSON.stringify([eventId]), 'critical']);

  const result = enforceCapacity(store, {
    external: { databaseBytes: 1.75 * GIB },
    now: BASE,
  });
  assert.equal(result.level, 'high');
  assert.ok(result.actions.includes('purge_low_value_telemetry'));
  assert.equal(countEvents(store), 1, 'event referenced by a critical alert survives');
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM alert').c), 1);
});

test('临界水位把分析/响应置为 blocked', (t) => {
  const { store } = openTestStore(t);
  const result = enforceCapacity(store, {
    external: { databaseBytes: 1.95 * GIB },
    now: BASE,
  });
  assert.equal(result.level, 'critical');
  assert.equal(getCapabilityState(store, 'analysis').state, 'blocked');
  assert.equal(getCapabilityState(store, 'response').state, 'blocked');
});

test('水位正常时 enforceCapacity 不做任何事', (t) => {
  const { store } = openTestStore(t);
  const result = enforceCapacity(store, { external: { databaseBytes: 1024 } });
  assert.equal(result.level, 'ok');
  assert.equal(result.actions.length, 0);
  assert.equal(getCapabilityState(store, 'analysis').state, 'ok');
});

test('purgeAlerts 拒绝删除高严重度告警', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => purgeAlerts(store, { severityAllowlist: ['low', 'critical'], now: BASE }),
    'ERR_RETENTION_GUARD',
  );
});

test('purgeAlerts 只能删白名单内的低严重度告警', (t) => {
  const { store } = openTestStore(t);
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'pl1', observed_at: BASE, received_at: BASE }),
    alerts: [makeAlert({ fingerprint: sha256Hex('pl-low'), severity: 'low', first_seen: BASE, last_seen: BASE })],
    now: BASE,
  });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'pl2', observed_at: BASE, received_at: BASE }),
    alerts: [makeAlert({ fingerprint: sha256Hex('pl-high'), severity: 'high', first_seen: BASE, last_seen: BASE })],
    now: BASE,
  });
  const result = purgeAlerts(store, { severityAllowlist: ['low'], now: BASE });
  assert.equal(result.deleted, 1);
  const remaining = store.all('SELECT severity FROM alert').map((row) => String(row.severity));
  assert.deepEqual(remaining, ['high']);
});

test('数据缺口记录来源、区间、原因与条数', (t) => {
  const { store } = openTestStore(t);
  const gap = recordDataGap(store, {
    stable_source_id: 'linux.journald',
    collector_instance_id: uuid(),
    reason: 'queue_overflow',
    range_start: BASE,
    range_end: isoFromMs(msFromIso(BASE) + 60000),
    dropped_count: 42,
    detail: { queue_depth: 100000 },
    now: BASE,
  });
  assert.equal(gap.dropped_count, 42);
  const gaps = listDataGaps(store, { stable_source_id: 'linux.journald' });
  assert.equal(gaps.length, 1);
  assert.equal(String(gaps[0].reason), 'queue_overflow');
});

test('缺口汇总按来源累计', (t) => {
  const { store } = openTestStore(t);
  for (const count of [1, 2, 3]) {
    recordDataGap(store, {
      stable_source_id: 'windows.security.4688',
      reason: 'dedupe_cap',
      range_start: BASE,
      range_end: isoFromMs(msFromIso(BASE) + 60000),
      dropped_count: count,
      now: BASE,
    });
  }
  const summary = summarizeDataGaps(store);
  assert.equal(summary.gaps, 3);
  assert.equal(summary.dropped, 6);
  assert.equal(summary.by_source[0].stable_source_id, 'windows.security.4688');
});

test('缺口区间反向时拒绝（区间必须成立）', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => recordDataGap(store, {
      stable_source_id: 'src',
      reason: 'bad',
      range_start: isoFromMs(msFromIso(BASE) + 60000),
      range_end: BASE,
      dropped_count: 1,
      now: BASE,
    }),
    'ERR_STORE_INPUT',
  );
});

test('缺口的 dropped_count 必须是非负整数', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => recordDataGap(store, {
      stable_source_id: 'src',
      reason: 'bad',
      range_start: BASE,
      range_end: BASE,
      dropped_count: -1,
      now: BASE,
    }),
    'ERR_STORE_INPUT',
  );
});

test('保留策略参数非法时拒绝（不做静默钳制）', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(() => runRetention(store, { policy: { telemetryDays: -1 }, now: BASE }), 'ERR_STORE_INPUT');
  expectStoreError(() => assessCapacity(store, { limits: { highWatermark: 0.95, criticalWatermark: 0.9 } }), 'ERR_STORE_INPUT');
});
