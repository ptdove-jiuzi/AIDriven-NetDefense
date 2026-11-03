/**
 * analysis-read.test.js — the analysis read path over a *real* SQLite file.
 *
 * `ANALYSES_FIRST_SQL` / `ANALYSES_AFTER_SQL` had no end-to-end coverage before
 * this file: the endpoint suites use the in-memory adapter, and the SQLite suite
 * only exercised `ALERTS_*_SQL`. That left the one query shape production actually
 * runs — `EXISTS(...)` for `report_available`, `attempt_seq` for `attempts`, the
 * `created_at_ms` keyset and its tiebreak — asserted only by reading the SQL.
 *
 * The rows are written on an independent file with a writable `openStore` and then
 * read back through the read model's own read-only handle, which is the same split
 * production uses (writer owns the file, console opens a second read-only handle).
 * Nothing under `packages/**` or `apps/**` is modified: the fixture uses only the
 * store package's public exports.
 *
 * Every test gets its own `makeTempDir()`; the writable handle is closed before the
 * read model opens, and the read model is closed in a `t.after` hook so the
 * directory can be removed on Windows.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { openStore } from '../../packages/event-store/src/index.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { createReadModel } from '../../apps/daemon/src/api/read-model.js';
import { projectAlert, projectAnalysis } from '../../apps/daemon/src/api/query.js';

import { BASE_MS, TEST_EPOCH, makeTempDir } from './helpers.js';

/** Detection aggregates into 15-minute windows; the alert schema wants window bounds. */
const WINDOW_MS = 900_000;

/** Contract §6.2: exactly these nine fields, nothing else. */
const ANALYSIS_KEYS = Object.freeze([
  'alert_id',
  'analysis_id',
  'attempts',
  'budget_class',
  'completed_at',
  'created_at',
  'report_available',
  'state',
  'updated_at',
].sort());

/**
 * Render epoch milliseconds the way the store writes timestamps.
 *
 * @param {number} ms Epoch milliseconds.
 * @returns {string} RFC3339 UTC text.
 */
function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Insert one alert row directly. The analysis outbox has a foreign key on `alert`,
 * so the analyses below need real anchors; writing them by hand avoids depending on
 * the detection rate limiter (one release per fingerprint per hour) to produce
 * three rows.
 *
 * @param {object} store Writable store handle.
 * @param {{id: string, lastSeenMs: number, count?: number, eventIds?: string[],
 *   truncated?: boolean}} spec Row spec.
 * @returns {void}
 */
function insertAlert(store, spec) {
  const stamp = iso(spec.lastSeenMs);
  const windowStartMs = Math.floor(spec.lastSeenMs / WINDOW_MS) * WINDOW_MS;
  const eventIds = spec.eventIds ?? [`event-${spec.id}`];
  store.run(
    `INSERT INTO alert (
       alert_id, rule_id, rule_version, fingerprint, severity, status,
       first_seen, last_seen, window_start, window_end,
       first_seen_ms, last_seen_ms, window_start_ms, window_end_ms,
       count, event_ids_json, event_ids_truncated, evidence_refs_json,
       canonical_json, canonical_digest, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      spec.id,
      'proc.suspicious-start',
      '1.0.0',
      `fingerprint-${spec.id}`,
      'high',
      'new',
      stamp,
      stamp,
      iso(windowStartMs),
      iso(windowStartMs + WINDOW_MS),
      spec.lastSeenMs,
      spec.lastSeenMs,
      windowStartMs,
      windowStartMs + WINDOW_MS,
      spec.count ?? eventIds.length,
      JSON.stringify(eventIds),
      spec.truncated === true ? 1 : 0,
      '[]',
      '{}',
      'a'.repeat(64),
      stamp,
      stamp,
    ],
  );
}

/**
 * Insert one `analysis_outbox` row directly.
 *
 * @param {object} store Writable store handle.
 * @param {{id: string, alertId: string, createdAtMs: number, attempts?: number,
 *   completedAt?: string|null, state?: string}} spec Row spec.
 * @returns {void}
 */
function insertAnalysis(store, spec) {
  const stamp = iso(spec.createdAtMs);
  store.run(
    `INSERT INTO analysis_outbox (
       analysis_id, alert_id, budget_class, summary_json, summary_digest,
       created_at, created_at_ms, idempotency_key, epoch, state,
       attempt_id, attempt_seq, owner, lease_expires_at_ms, claimed_at,
       completed_at, report_digest, failure_reason, canonical_json, canonical_digest, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?)`,
    [
      spec.id,
      spec.alertId,
      'standard',
      '{}',
      'b'.repeat(64),
      stamp,
      spec.createdAtMs,
      `idem-${spec.id}`,
      TEST_EPOCH,
      spec.state ?? 'queued',
      spec.attempts ?? 0,
      spec.completedAt ?? null,
      '{}',
      'c'.repeat(64),
      stamp,
    ],
  );
}

/**
 * Insert one `analysis_report` row for an existing analysis.
 *
 * @param {object} store Writable store handle.
 * @param {{analysisId: string, createdAtMs: number}} spec Row spec.
 * @returns {void}
 */
function insertReport(store, spec) {
  store.run(
    `INSERT INTO analysis_report (analysis_id, report_json, report_digest, canonical_json, created_at, attempt_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [spec.analysisId, '{}', 'd'.repeat(64), '{}', iso(spec.createdAtMs), 'attempt-1'],
  );
}

describe('analysis read model over SQLite', () => {
  it('pages real analysis_outbox rows on created_at_ms with report_available and attempt_seq', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis-analysis.db');
    const clock = createManualClock(BASE_MS);

    const alerts = [
      { id: 'al-anchor-1', lastSeenMs: BASE_MS + 60_000 },
      { id: 'al-anchor-2', lastSeenMs: BASE_MS + 120_000 },
      { id: 'al-anchor-3', lastSeenMs: BASE_MS + 180_000 },
      { id: 'al-anchor-4', lastSeenMs: BASE_MS + 240_000 },
    ];
    // Two rows share `created_at_ms` (BASE+3000) so the `analysis_id DESC` tiebreak
    // is exercised *across the page boundary*: limit=2 splits the tie.
    const analyses = [
      { id: 'an-0002', alertId: 'al-anchor-2', createdAtMs: BASE_MS + 3000, attempts: 2 },
      { id: 'an-0001', alertId: 'al-anchor-1', createdAtMs: BASE_MS + 3000, attempts: 0 },
      { id: 'an-0003', alertId: 'al-anchor-3', createdAtMs: BASE_MS + 2000, attempts: 3 },
      { id: 'an-0004', alertId: 'al-anchor-4', createdAtMs: BASE_MS + 1000, attempts: 1 },
    ];
    const completedAt = iso(BASE_MS + 5000);

    const writer = openStore({ path: file, clock });
    try {
      for (const alert of alerts) {
        insertAlert(writer, alert);
      }
      for (const analysis of analyses) {
        insertAnalysis(writer, {
          ...analysis,
          completedAt: analysis.id === 'an-0004' ? completedAt : null,
        });
      }
      // Exactly one row has a report; the other three must answer false.
      insertReport(writer, { analysisId: 'an-0003', createdAtMs: BASE_MS + 6000 });
      assert.equal(writer.all('SELECT analysis_id FROM analysis_outbox').length, 4);
      assert.equal(writer.all('SELECT analysis_id FROM analysis_report').length, 1);
    } finally {
      writer.close();
    }

    const readModel = createReadModel({ store: { kind: 'sqlite' }, storePath: file, clock });
    t.after(() => readModel.close());

    const home = await readModel.listAnalyses({ limit: 2, after: null });
    // The model fetches limit+1 rows; the extra one is how `has_more` is answered.
    assert.equal(home.rows.length, 3, 'limit=2 时必须多取一行用于判定 has_more');
    assert.equal(home.hasMore, true, '共 4 条时首页必须报 has_more');

    const homeIds = home.rows.map((entry) => entry.id);
    assert.deepEqual(homeIds, ['an-0002', 'an-0001', 'an-0003'], '必须按 created_at_ms 降序、并列时 analysis_id 降序');
    assert.equal(home.rows[0].ms, BASE_MS + 3000, '首选行必须是最新的 created_at_ms');
    assert.equal(home.rows[1].ms, BASE_MS + 3000, '并列行的毫秒必须相同');

    const homeItems = home.rows.map((entry) => projectAnalysis(entry.row));
    assert.deepEqual(
      homeItems.map((item) => item.analysis_id),
      ['an-0002', 'an-0001', 'an-0003'],
    );
    // created_at 是投影字段，也必须按降序出现（不能只靠 ms 列排对了、投影错位）。
    for (let index = 1; index < homeItems.length; index += 1) {
      assert.ok(
        Date.parse(homeItems[index].created_at) <= Date.parse(homeItems[index - 1].created_at),
        `第 ${index} 条的 created_at 不得晚于前一条`,
      );
    }

    // `attempts` comes from `attempt_seq` and must be an integer, not a string or
    // a missing column. The values are literal, not re-read from the store.
    assert.deepEqual(homeItems.map((item) => item.attempts), [2, 0, 3], 'attempts 必须取自 attempt_seq');
    for (const item of homeItems) {
      assert.equal(Number.isInteger(item.attempts), true, 'attempts 必须是整数');
    }

    // Only `an-0003` has an `analysis_report` row; SQLite returns EXISTS() as 0/1
    // and the projection must turn that into a real boolean.
    assert.deepEqual(
      homeItems.map((item) => item.report_available),
      [false, false, true],
      'report_available 必须恰好对有报告的行为 true',
    );
    for (const item of homeItems) {
      assert.equal(typeof item.report_available, 'boolean', 'report_available 必须是布尔值');
    }

    // The continuation starts strictly after the last row *of the page*, which sits
    // inside the tie. No repeat, no gap.
    const lastOfPage = home.rows[1];
    const next = await readModel.listAnalyses({ limit: 2, after: { ms: lastOfPage.ms, id: lastOfPage.id } });
    assert.equal(next.rows.length, 2, '续页必须取到剩下两条');
    assert.equal(next.hasMore, false, '末页 has_more 必须为 false');
    const nextIds = next.rows.map((entry) => entry.id);
    assert.deepEqual(nextIds, ['an-0003', 'an-0004'], '续页必须接着页边界之后');

    const union = [...homeIds.slice(0, 2), ...nextIds];
    assert.equal(new Set(union).size, 4, '首页 + 续页不得重复');
    assert.deepEqual(union, ['an-0002', 'an-0001', 'an-0003', 'an-0004'], '首页 + 续页必须按序拼回完整序列');

    const nextItems = next.rows.map((entry) => projectAnalysis(entry.row));
    assert.deepEqual(nextItems.map((item) => item.attempts), [3, 1], '续页的 attempts 也必须来自 attempt_seq');
    assert.deepEqual(nextItems.map((item) => item.report_available), [true, false], '续页的 report_available 口径一致');
    assert.equal(nextItems[1].completed_at, completedAt, 'completed_at 必须原样来自存储');
    assert.equal(nextItems[0].completed_at, null, '未完成的行 completed_at 必须是 null');

    // Contract §6.2: exactly nine keys after projection, on the real SQLite path too.
    for (const item of [...homeItems, ...nextItems]) {
      assert.deepEqual(Object.keys(item).sort(), ANALYSIS_KEYS, 'analysis 条目必须恰好是契约那 9 个键');
    }
  });
});

describe('alert flag conversion over SQLite', () => {
  // Regression: the SQL used to select the stored column as `event_ids_truncated`
  // while `projectAlert` reads `evidence_truncated`, so on the SQLite backend
  // `evidence_truncated` was always `false`. The memory backend renamed the field
  // first, which is why only a real database exposes the defect — this fixture keeps
  // that path covered.
  it('turns event_ids_truncated=1 into evidence_truncated:true while evidence_count counts retained ids', async (t) => {
    const dir = makeTempDir();
    const file = join(dir, 'aegis-flag.db');
    const clock = createManualClock(BASE_MS);

    const writer = openStore({ path: file, clock });
    try {
      insertAlert(writer, {
        id: 'al-truncated',
        lastSeenMs: BASE_MS + 60_000,
        count: 9,
        eventIds: ['event-only-one'],
        truncated: true,
      });
      // Pin the stored representation: SQLite keeps the flag as 0/1, and the id
      // array really has one entry while `count` is 9.
      const raw = writer.get(
        `SELECT event_ids_truncated, json_array_length(event_ids_json) AS retained, count
           FROM alert WHERE alert_id = ?`,
        ['al-truncated'],
      );
      assert.equal(Number(raw.event_ids_truncated), 1, '存储层必须把截断标志写成整数 1');
      assert.equal(Number(raw.retained), 1, 'event_ids_json 必须只含 1 个 id');
      assert.equal(Number(raw.count), 9, '聚合 count 必须是 9');
    } finally {
      writer.close();
    }

    const readModel = createReadModel({ store: { kind: 'sqlite' }, storePath: file, clock });
    t.after(() => readModel.close());

    const page = await readModel.listAlerts({ limit: 10, after: null });
    assert.equal(page.rows.length, 1);
    const item = projectAlert(page.rows[0].row);

    // The memory adapter already had coverage for `true`; this is the evidence that
    // the SQLite integer goes through the same `flag()` conversion.
    assert.equal(item.evidence_truncated, true, 'SQLite 的 1 必须投影为布尔 true');
    assert.equal(typeof item.evidence_truncated, 'boolean', 'evidence_truncated 必须是布尔值，不能是 1');
    assert.equal(item.evidence_count, 1, 'evidence_count 必须来自 event_ids_json 的长度');
    assert.equal(item.count, 9, 'count 必须来自聚合列，且与 evidence_count 不等');
    assert.notEqual(item.count, item.evidence_count, '截断时 count 与 evidence_count 必须不同');
  });
});
