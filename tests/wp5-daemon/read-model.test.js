/**
 * read-model.test.js — the read model over the real SQLite file and the parity
 * between its two backends.
 *
 * The two backends are the one place where "the same answer" can quietly stop being
 * true: the memory adapter sorts in JavaScript on `Date.parse(last_seen)`, the SQLite
 * one sorts on the stored `last_seen_ms` column with `alert_id DESC` as the tiebreak.
 * A drift between them is invisible until a console reads one and the CLI reads the
 * other, so it is asserted directly: the same five alerts are written into both
 * adapters and their `alert_id` sequences must be identical.
 *
 * Everything here runs on a real file under a per-test temporary directory, with the
 * read-only handle opened by the read model itself (never a second writer).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { createEventStoreAdapter, createMemoryEventStoreAdapter } from '../../apps/daemon/src/adapters/event-store.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { createReadModel } from '../../apps/daemon/src/api/read-model.js';
import { DAEMON_CODES, DaemonError } from '../../apps/daemon/src/errors.js';

import { BASE_MS, makeEvent, makeTempDir, openRealPipeline } from './helpers.js';

const ALLOWED_SUMMARY_FIELDS = ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'];

/** Detection aggregates into 15-minute windows; one event per window yields one alert. */
const WINDOW_MS = 900_000;

/**
 * Build a contract-valid telemetry event at a minute offset from the base time.
 *
 * @param {number} minute Minutes after {@link BASE_MS}.
 * @param {number} sequence Source sequence.
 * @returns {object} Telemetry event.
 */
function eventAt(minute, sequence) {
  const observedAt = new Date(BASE_MS + minute * 60_000).toISOString();
  return makeEvent({
    observed_at: observedAt,
    received_at: new Date(Date.parse(observedAt) + 1000).toISOString(),
    source_seq: sequence,
  });
}

/**
 * Build a contract-valid alert row keyed to a given instant.
 *
 * @param {{id: string, fingerprint: string, lastSeenMs: number, eventIds: string[]}} spec Spec.
 * @returns {object} Alert value.
 */
function alertAt(spec) {
  const iso = new Date(spec.lastSeenMs).toISOString();
  const windowStartMs = Math.floor(spec.lastSeenMs / WINDOW_MS) * WINDOW_MS;
  return {
    schemaVersion: '1.0',
    alert_id: spec.id,
    rule_id: 'proc.suspicious-start',
    rule_version: '1.0.0',
    fingerprint: spec.fingerprint,
    severity: 'high',
    status: 'new',
    first_seen: iso,
    last_seen: iso,
    window_start: new Date(windowStartMs).toISOString(),
    window_end: new Date(windowStartMs + WINDOW_MS).toISOString(),
    count: spec.eventIds.length,
    event_ids: spec.eventIds,
    event_ids_truncated: false,
    evidence_refs: [],
  };
}

describe('read model over SQLite', () => {
  it('returns alert rows newest first with the contracted evidence count', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis-harness.db');
    const clock = createManualClock(BASE_MS);
    const parts = await openRealPipeline(file, clock);
    let readModel = null;

    t.after(() => {
      readModel?.close();
      parts.store.close();
    });

    // One event per 15-minute window, so the pipeline writes four distinct alerts.
    const summary = parts.pipeline.ingestBatch([
      eventAt(1, 1),
      eventAt(16, 2),
      eventAt(31, 3),
      eventAt(46, 4),
    ]);
    assert.equal(summary.alerts, 4, '四条事件必须产生四条告警');
    assert.equal(parts.store.stats().alerts, 4);

    readModel = createReadModel({ store: parts.store, storePath: file, clock });
    const page = await readModel.listAlerts({ limit: 10, after: null });
    assert.equal(page.rows.length, 4, '四条告警必须全部返回');
    assert.equal(page.hasMore, false);

    for (let index = 1; index < page.rows.length; index += 1) {
      assert.ok(
        page.rows[index - 1].ms >= page.rows[index].ms,
        `第 ${index} 行的 last_seen_ms 必须不大于前一行（降序）`,
      );
    }

    // Independent expectation, not a re-run of the implementation's expression: the
    // fixture writes exactly one event per 15-minute window, so each stored alert row
    // can cite exactly one event id and is never truncated. Contract §6.1 defines
    // `evidence_count` as that retained id count (it may be smaller than `count`).
    assert.equal(page.rows[0].row.evidence_count, 1, '每个窗口只写 1 条事件，evidence_count 必须恰好是 1');
    assert.equal(Number.isInteger(page.rows[0].row.evidence_count), true, 'evidence_count 必须是整数');
    assert.equal(page.rows[0].row.count, 1, '单事件窗口的 count 必须恰好是 1');
    // The read model exposes the contracted column name on both backends: SQLite
    // aliases `event_ids_truncated` to `evidence_truncated` so the projection whitelist
    // has exactly one name to read. A single-evidence window can never be truncated.
    assert.equal(page.rows[0].row.evidence_truncated, 0, '单条证据不可能被截断');
    assert.equal(
      Object.prototype.hasOwnProperty.call(page.rows[0].row, 'event_ids_truncated'),
      false,
      '内部列名不得出现在读模型的输出行上',
    );

    // The read model asks the store for one row more than the page size; that extra
    // row is how `has_more` is answered without a second COUNT scan.
    const firstPage = await readModel.listAlerts({ limit: 2, after: null });
    assert.equal(firstPage.rows.length, 3, 'limit=2 时必须多取一行用于判定 has_more');
    assert.equal(firstPage.hasMore, true);
    const rest = firstPage.rows[1];
    const secondPage = await readModel.listAlerts({ limit: 2, after: { ms: rest.ms, id: rest.id } });
    assert.equal(secondPage.rows.length, 2, '续页必须取到剩下两条');
    assert.equal(secondPage.hasMore, false);

    const firstIds = firstPage.rows.slice(0, 2).map((entry) => entry.id);
    const secondIds = secondPage.rows.map((entry) => entry.id);
    for (const id of secondIds) {
      assert.equal(firstIds.includes(id), false, `续页不得重复首页的 ${id}`);
    }
    assert.deepEqual(
      [...firstIds, ...secondIds],
      page.rows.map((entry) => entry.id),
      '首页 + 续页必须按序拼回完整结果',
    );
  });

  it('fails closed with STORE_UNAVAILABLE after close()', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis-harness.db');
    const clock = createManualClock(BASE_MS);
    const store = createEventStoreAdapter({ path: file, clock, allowedSummaryFields: ALLOWED_SUMMARY_FIELDS });
    await store.open();
    t.after(() => store.close());

    const readModel = createReadModel({ store, storePath: file, clock });
    readModel.close();

    await assert.rejects(
      () => readModel.listAlerts({ limit: 1, after: null }),
      (error) => {
        assert.ok(error instanceof DaemonError, `必须抛 DaemonError，实际 ${error?.name}`);
        assert.equal(error.code, DAEMON_CODES.STORE_UNAVAILABLE);
        assert.equal(error.details.reason, 'CLOSED');
        return true;
      },
    );
    await assert.rejects(
      () => readModel.listAnalyses({ limit: 1, after: null }),
      (error) => error.code === DAEMON_CODES.STORE_UNAVAILABLE,
    );
    assert.equal(readModel.isOpen(), false);
  });
});

describe('read model backend parity', () => {
  it('returns the same alert_id sequence from SQLite and from the memory adapter', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis-parity.db');
    const clock = createManualClock(BASE_MS);

    // Distinct windows, plus one deliberate `last_seen` tie broken by `alert_id`
    // (…000b before …000a) so the tiebreak is compared too, not just the primary key.
    const alerts = [
      { id: '00000000-0000-4000-8000-00000000000b', minute: 61, fingerprint: 'd'.repeat(64) },
      { id: '00000000-0000-4000-8000-00000000000a', minute: 61, fingerprint: 'e'.repeat(64) },
      { id: '00000000-0000-4000-8000-00000000000c', minute: 46, fingerprint: 'c'.repeat(64) },
      { id: '00000000-0000-4000-8000-00000000000d', minute: 31, fingerprint: 'f'.repeat(64) },
      { id: '00000000-0000-4000-8000-00000000000e', minute: 16, fingerprint: 'a'.repeat(64) },
    ];

    const payloads = alerts.map((spec, index) => {
      const event = eventAt(spec.minute, index + 1);
      return {
        event,
        alerts: [alertAt({
          id: spec.id,
          fingerprint: spec.fingerprint,
          lastSeenMs: BASE_MS + spec.minute * 60_000,
          eventIds: [event.event_id],
        })],
      };
    });

    const sqlite = createEventStoreAdapter({ path: file, clock, allowedSummaryFields: ALLOWED_SUMMARY_FIELDS });
    const memory = createMemoryEventStoreAdapter({ clock });
    const sqliteModel = createReadModel({ store: sqlite, storePath: file, clock });
    const memoryModel = createReadModel({ store: memory, storePath: join(dir, 'unused.db'), clock });

    t.after(() => {
      sqliteModel.close();
      memoryModel.close();
      sqlite.close();
      memory.close();
    });

    await sqlite.open();
    memory.open();
    for (const payload of payloads) {
      sqlite.ingest(payload);
      memory.ingest(payload);
    }
    assert.equal(sqlite.stats().alerts, 5, 'SQLite 必须有 5 条告警');
    assert.equal(memory.stats().alerts, 5, '内存适配器必须有 5 条告警');

    const sqlitePage = await sqliteModel.listAlerts({ limit: 10, after: null });
    const memoryPage = await memoryModel.listAlerts({ limit: 10, after: null });
    const sqliteIds = sqlitePage.rows.map((entry) => entry.id);
    const memoryIds = memoryPage.rows.map((entry) => entry.id);

    const expected = [
      '00000000-0000-4000-8000-00000000000b',
      '00000000-0000-4000-8000-00000000000a',
      '00000000-0000-4000-8000-00000000000c',
      '00000000-0000-4000-8000-00000000000d',
      '00000000-0000-4000-8000-00000000000e',
    ];
    assert.deepEqual(sqliteIds, expected, 'SQLite 必须按 last_seen 降序、alert_id 降序排序');
    assert.deepEqual(memoryIds, sqliteIds, '两条后端不得漂移：alert_id 序列必须完全一致');
  });
});
