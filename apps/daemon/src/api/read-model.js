/**
 * api/read-model.js — the read side of the store, behind one small async interface.
 *
 * Two backends, one ordering, one failure mode:
 *
 * - **memory** (`mock` mode, and the daemon's own tests) reads the adapter's
 *   read-only introspection (`dump()`) and applies the same keyset order and filter
 *   in JavaScript. Mock mode must stay importable without `node:sqlite`, so the real
 *   store package is never loaded there.
 * - **sqlite** opens a *second, read-only* handle. That is explicitly supported by
 *   the store package: a console or a verification process has to be able to read
 *   while the daemon writes. This module never opens a second **writer**, never
 *   migrates and never checkpoints — those belong to the single writable handle the
 *   daemon already owns.
 *
 * Failures are never softened into "no rows". A read model that answered `[]` when
 * the database was busy would tell the operator "no alerts" — the one wrong answer
 * this endpoint must never give. Every import, open and query failure becomes
 * `STORE_UNAVAILABLE`, and after `close()` every read fails closed, matching the
 * adapter's own behaviour.
 *
 * The query returns one row more than asked. That extra row is the only honest way
 * to answer `has_more`: `COUNT(*)` would scan the table a second time, and "the page
 * was full" does not imply more rows exist.
 */

import { DaemonError, DAEMON_CODES, isDaemonError } from '../errors.js';

/** Bounded wait on a busy store: a console read must not block the writer for long. */
const READ_BUSY_TIMEOUT_MS = 1000;

/**
 * Alerts, newest `last_seen` first, `alert_id` descending as the tiebreak.
 *
 * Two statements, not one. A single statement with a `(? IS NULL) OR (...)` guard
 * — `after` bound as `NULL` on the first page — reads the same for every request,
 * but SQLite cannot turn it into a range seek: the leading `? IS NULL` disjunct
 * makes the whole predicate non-sargable, so `EXPLAIN QUERY PLAN` shows
 * `SCAN alert USING INDEX alert_last_seen_idx` plus
 * `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` on *both* the first page and every
 * continuation. The index is scanned in full and the tiebreak re-sorted for each
 * page, which defeats the point of keyset pagination. Splitting the first page out
 * at least keeps the unfiltered statement honest about doing an ordered scan, and
 * lets the continuation carry an index-seekable bound (see `ALERTS_AFTER_SQL`) —
 * the bare disjunction alone is still not sargable, so removing it is not enough
 * on its own.
 */
const ALERTS_FIRST_SQL = `
  SELECT alert_id, rule_id, rule_version, severity, status, count,
         first_seen, last_seen, window_start, window_end,
         event_ids_truncated AS evidence_truncated,
         json_array_length(event_ids_json) AS evidence_count,
         last_seen_ms
  FROM alert
  ORDER BY last_seen_ms DESC, alert_id DESC
  LIMIT ?`;

/**
 * Continuation page: strictly *after* the cursor's `(last_seen_ms, alert_id)`
 * pair. Same rows, same order, same projection as the first page — only the
 * starting point differs.
 *
 * `last_seen_ms <= ?` is redundant: the disjunction below already implies it. It
 * is here because SQLite will not derive an index range constraint from a bare
 * `a < ? OR (a = ? AND b < ?)` — measured on the real schema the plan stays
 * `SCAN alert USING INDEX alert_last_seen_idx`, i.e. the whole index is walked
 * from the top on every continuation page. With the leading bound present the
 * planner emits `SEARCH alert USING INDEX alert_last_seen_idx (last_seen_ms<?)`
 * and only has to partially sort ties. The bound is bound from the same cursor
 * value as the first disjunct, so the two can never disagree; 900 cursor/limit
 * combinations over a 300-row table returned byte-identical pages to the
 * unanchored spelling.
 */
const ALERTS_AFTER_SQL = `
  SELECT alert_id, rule_id, rule_version, severity, status, count,
         first_seen, last_seen, window_start, window_end,
         event_ids_truncated AS evidence_truncated,
         json_array_length(event_ids_json) AS evidence_count,
         last_seen_ms
  FROM alert
  WHERE last_seen_ms <= ? AND (last_seen_ms < ? OR (last_seen_ms = ? AND alert_id < ?))
  ORDER BY last_seen_ms DESC, alert_id DESC
  LIMIT ?`;

/**
 * Analyses, newest `created_at` first, `analysis_id` descending as the tiebreak.
 * Split from {@link ANALYSES_AFTER_SQL} for the same reason as the alerts pair.
 */
const ANALYSES_FIRST_SQL = `
  SELECT a.analysis_id, a.alert_id, a.state, a.budget_class, a.attempt_seq,
         a.created_at, a.updated_at, a.completed_at, a.created_at_ms,
         EXISTS (SELECT 1 FROM analysis_report r WHERE r.analysis_id = a.analysis_id) AS report_available
  FROM analysis_outbox a
  ORDER BY a.created_at_ms DESC, a.analysis_id DESC
  LIMIT ?`;

/**
 * Continuation page for analyses: strictly after the cursor's `(ms, id)` pair,
 * with the same redundant leading bound as {@link ALERTS_AFTER_SQL}.
 *
 * It buys nothing yet: `analysis_outbox` has no index whose first column is
 * `created_at_ms` (the only time index, `analysis_outbox_state_idx`, leads with
 * `state`), so the planner still reads the table and sorts. The split and the
 * bound are kept anyway so both endpoints answer a continuation page through one
 * shape — a continuation that silently degenerates to a full scan is exactly the
 * defect this pair of statements exists to avoid.
 */
const ANALYSES_AFTER_SQL = `
  SELECT a.analysis_id, a.alert_id, a.state, a.budget_class, a.attempt_seq,
         a.created_at, a.updated_at, a.completed_at, a.created_at_ms,
         EXISTS (SELECT 1 FROM analysis_report r WHERE r.analysis_id = a.analysis_id) AS report_available
  FROM analysis_outbox a
  WHERE a.created_at_ms <= ? AND (a.created_at_ms < ? OR (a.created_at_ms = ? AND a.analysis_id < ?))
  ORDER BY a.created_at_ms DESC, a.analysis_id DESC
  LIMIT ?`;

/**
 * Normalize any backend failure into the one code the API renders as `503`.
 *
 * @param {unknown} error Thrown value.
 * @returns {DaemonError} Fixed-message error carrying only a short reason.
 */
function unavailable(error) {
  const reason = isDaemonError(error)
    ? error.code
    : (error?.code ?? error?.name ?? 'UNKNOWN');
  return new DaemonError(
    DAEMON_CODES.STORE_UNAVAILABLE,
    'analysis/alert read model is unavailable',
    { reason },
  );
}

/**
 * @param {unknown} value Stored timestamp text.
 * @returns {number} Sort milliseconds, or `0` when unparseable so ordering stays total.
 */
function sortMs(value) {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {{ms: number, id: string}} after Cursor position.
 * @param {number} ms Row sort milliseconds.
 * @param {string} id Row id.
 * @returns {boolean} `true` when the row sorts strictly after the cursor.
 */
function isAfter(after, ms, id) {
  if (ms < after.ms) {
    return true;
  }
  return ms === after.ms && id < after.id;
}

/**
 * @param {{ms: number, id: string}} left Left entry.
 * @param {{ms: number, id: string}} right Right entry.
 * @returns {number} Descending comparator: newest first, then largest id first.
 */
function descending(left, right) {
  if (left.ms !== right.ms) {
    return right.ms - left.ms;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
}

/**
 * Create the read model.
 *
 * Construction touches nothing: the read-only handle is opened on the first query
 * and cached. That keeps `start()` no more expensive than before, and means the
 * daemon can run for a long time without a reader handle at all.
 *
 * @param {{
 *   store: object,
 *   storePath: string,
 *   clock: object,
 *   logger?: object
 * }} options Options. `store` is the already-open daemon adapter.
 * @returns {{
 *   listAlerts: (page: {limit: number, after: null|{ms: number, id: string}}) => Promise<{rows: object[], hasMore: boolean}>,
 *   listAnalyses: (page: {limit: number, after: null|{ms: number, id: string}}) => Promise<{rows: object[], hasMore: boolean}>,
 *   close: () => void,
 *   isOpen: () => boolean
 * }} Read model. Each returned row is `{ms, id, row}`: `row` is the raw stored
 *   record for projection, `ms`/`id` are the cursor key so the endpoint never has
 *   to re-derive it from a field the projection is required to drop.
 */
export function createReadModel(options) {
  const store = options.store;
  const storePath = options.storePath;
  const clock = options.clock;
  const logger = options.logger ?? null;

  let closed = false;
  /** @type {{api: object, db: object}|null} */
  let binding = null;
  /** @type {Promise<{api: object, db: object}>|null} */
  let opening = null;

  function assertOpen() {
    if (closed) {
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'analysis/alert read model is unavailable', {
        reason: 'CLOSED',
      });
    }
  }

  /**
   * Open the read-only handle, once.
   *
   * A `close()` that lands while the import is in flight closes the fresh handle
   * instead of caching it, so shutdown cannot leave an unreachable reader behind.
   *
   * @returns {Promise<{api: object, db: object}>} Cached binding.
   */
  async function openReadOnly() {
    let api;
    try {
      api = await import('@aegisharness/event-store');
    } catch (error) {
      throw unavailable(error);
    }
    let db;
    try {
      db = api.openStore({
        path: storePath,
        readOnly: true,
        clock,
        busyTimeoutMs: READ_BUSY_TIMEOUT_MS,
      });
    } catch (error) {
      throw unavailable(error);
    }
    if (closed) {
      try {
        db.close();
      } catch {
        // The handle never became reachable from outside this function.
      }
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'analysis/alert read model is unavailable', {
        reason: 'CLOSED',
      });
    }
    return { api, db };
  }

  async function bindingForSqlite() {
    assertOpen();
    if (binding !== null) {
      return binding;
    }
    if (opening === null) {
      opening = openReadOnly();
    }
    try {
      binding = await opening;
      return binding;
    } finally {
      opening = null;
    }
  }

  /**
   * @returns {{alerts: object[], analyses: object[]}} Introspection snapshot.
   */
  function dump() {
    if (typeof store?.dump !== 'function') {
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'analysis/alert read model is unavailable', {
        reason: 'NO_INTROSPECTION',
      });
    }
    try {
      return store.dump();
    } catch (error) {
      throw unavailable(error);
    }
  }

  function memoryAlerts(page) {
    const alerts = dump().alerts ?? [];
    const entries = alerts.map((alert) => ({
      ms: sortMs(alert.last_seen),
      id: typeof alert.alert_id === 'string' ? alert.alert_id : '',
      row: {
        ...alert,
        // The in-memory adapter stores the id array; only its length may leave.
        evidence_count: Array.isArray(alert.event_ids) ? alert.event_ids.length : 0,
        evidence_truncated: alert.event_ids_truncated === true,
      },
    }));
    return pageOf(entries, page);
  }

  function memoryAnalyses(page) {
    const analyses = dump().analyses ?? [];
    const entries = analyses.map((analysis) => ({
      ms: sortMs(analysis.created_at),
      id: typeof analysis.analysis_id === 'string' ? analysis.analysis_id : '',
      row: {
        ...analysis,
        // The real table defaults `attempt_seq` to 0 and always has `updated_at`;
        // mirroring that keeps mock-mode responses shaped like production ones.
        attempt_seq: analysis.attempt_seq ?? 0,
        updated_at: analysis.updated_at ?? analysis.created_at ?? null,
        completed_at: analysis.completed_at ?? null,
        report_available: analysis.report_available === true,
      },
    }));
    return pageOf(entries, page);
  }

  /**
   * Apply the keyset order and filter in JavaScript for the in-memory adapter.
   *
   * @param {{ms: number, id: string, row: object}[]} entries Candidate entries.
   * @param {{limit: number, after: null|{ms: number, id: string}}} page Page request.
   * @returns {{rows: object[], hasMore: boolean}} One row more than `limit` when available.
   */
  function pageOf(entries, page) {
    const after = page.after ?? null;
    const filtered = after === null
      ? entries
      : entries.filter((entry) => isAfter(after, entry.ms, entry.id));
    const ordered = [...filtered].sort(descending);
    const take = page.limit + 1;
    return {
      rows: ordered.slice(0, take),
      hasMore: ordered.length > take - 1,
    };
  }

  async function sqliteAlerts(page) {
    const { db } = await bindingForSqlite();
    const after = page.after ?? null;
    // One row more than the limit; the extra row is what sets `hasMore`.
    const take = page.limit + 1;
    let rows;
    try {
      rows = after === null
        ? db.all(ALERTS_FIRST_SQL, [take])
        : db.all(ALERTS_AFTER_SQL, [after.ms, after.ms, after.ms, after.id, take]);
    } catch (error) {
      throw unavailable(error);
    }
    return {
      rows: rows.map((row) => ({
        ms: Number(row.last_seen_ms),
        id: String(row.alert_id),
        row,
      })),
      hasMore: rows.length > page.limit,
    };
  }

  async function sqliteAnalyses(page) {
    const { db } = await bindingForSqlite();
    const after = page.after ?? null;
    // One row more than the limit; the extra row is what sets `hasMore`.
    const take = page.limit + 1;
    let rows;
    try {
      rows = after === null
        ? db.all(ANALYSES_FIRST_SQL, [take])
        : db.all(ANALYSES_AFTER_SQL, [after.ms, after.ms, after.ms, after.id, take]);
    } catch (error) {
      throw unavailable(error);
    }
    return {
      rows: rows.map((row) => ({
        ms: Number(row.created_at_ms),
        id: String(row.analysis_id),
        row,
      })),
      hasMore: rows.length > page.limit,
    };
  }

  /**
   * Dispatch on the adapter kind, failing closed on anything else.
   *
   * An unknown kind is not "no rows": it means this process cannot see the store at
   * all, which is exactly what `503` is for.
   *
   * @param {'memory'|'sqlite'} kind Adapter kind.
   * @param {{limit: number, after: object|null}} page Page request.
   * @param {Function} memory Memory implementation.
   * @param {Function} sqlite SQLite implementation.
   * @returns {Promise<{rows: object[], hasMore: boolean}>} Page.
   */
  async function list(kind, page, memory, sqlite) {
    assertOpen();
    if (page === null || typeof page !== 'object' || !Number.isSafeInteger(page.limit) || page.limit < 1) {
      // Unreachable through the endpoint (the query parser validates first); kept as
      // a hard failure so a wiring fault cannot silently return an empty page.
      throw new DaemonError(DAEMON_CODES.INTERNAL, 'read model requires a validated page request');
    }
    if (kind === 'memory') {
      return memory(page);
    }
    if (kind === 'sqlite') {
      return sqlite(page);
    }
    throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'analysis/alert read model is unavailable', {
      reason: 'UNSUPPORTED_STORE_KIND',
    });
  }

  return {
    /**
     * @param {{limit: number, after: null|{ms: number, id: string}}} page Page request.
     * @returns {Promise<{rows: object[], hasMore: boolean}>} Page.
     */
    listAlerts(page) {
      return list(store?.kind, page, memoryAlerts, sqliteAlerts);
    },

    /**
     * @param {{limit: number, after: null|{ms: number, id: string}}} page Page request.
     * @returns {Promise<{rows: object[], hasMore: boolean}>} Page.
     */
    listAnalyses(page) {
      return list(store?.kind, page, memoryAnalyses, sqliteAnalyses);
    },

    /**
     * Release the read-only handle. After this every read fails closed, so a query
     * that raced the shutdown gets `503` rather than a half-closed database.
     */
    close() {
      closed = true;
      const current = binding;
      binding = null;
      opening = null;
      if (current === null) {
        return;
      }
      try {
        current.db.close();
      } catch (error) {
        logger?.warn?.('read model could not close its read-only handle', { reason: error?.code ?? 'CLOSE_FAILED' });
        throw unavailable(error);
      }
    },

    isOpen() {
      if (closed) {
        return false;
      }
      if (binding !== null) {
        return true;
      }
      return typeof store?.isOpen === 'function' ? store.isOpen() === true : false;
    },
  };
}
