/**
 * mock-transport.js — the loopback response bodies the alerts/analysis acceptance tests
 * speak, kept in exactly one place.
 *
 * Field names here are copied **verbatim** from
 * `docs/implementation/M7_API_CONTRACT.md` §6 (the two field whitelists) and §5 (the
 * envelope and its `page` object). Contract §11 makes those names part of the
 * compatibility surface, so when the contract version changes, this is the single file
 * that changes and every acceptance test keeps asserting the same operator-visible
 * behaviour.
 *
 * Two things this file deliberately does *not* do:
 *
 * 1. It does not offer alternate envelope keys. Contract §5 fixes one array key per
 *    endpoint (`alerts` / `analyses`) plus one `page` object; the pre-contract tests
 *    tolerated `items`/`data`/`jobs`/bare arrays, and that tolerance is gone (§11).
 * 2. It does not invent cursor semantics. `next_cursor` is carried exactly as the
 *    contract describes it — an opaque string that is non-null only while `has_more` is
 *    true — and `cursorToken` below produces a *shape* (`<base64url>.<base64url>`) the
 *    daemon could plausibly emit. Nothing here decodes it, and no test asserts anything
 *    about its internals: the CLI must treat it as a string, so the fixtures must not
 *    teach a test to look inside one.
 *
 * This is a fixture, not a test file: no assertions live here, and the
 * `tests/wp5-cli/**\/*.test.js` glob does not pick it up.
 */

/**
 * Contract §6.1: the alert row is exactly these twelve fields, in this order.
 *
 * Exported so a test can assert the projected key set by *name* instead of trusting a
 * hand-copied list that drifts from this one.
 */
export const ALERT_FIELDS = Object.freeze([
  'alert_id',
  'rule_id',
  'rule_version',
  'severity',
  'status',
  'count',
  'first_seen',
  'last_seen',
  'window_start',
  'window_end',
  'evidence_count',
  'evidence_truncated',
]);

/** Contract §6.2: the analysis row is exactly these nine fields, in this order. */
export const ANALYSIS_FIELDS = Object.freeze([
  'analysis_id',
  'alert_id',
  'state',
  'budget_class',
  'attempts',
  'created_at',
  'updated_at',
  'completed_at',
  'report_available',
]);

/** Contract §5: the `page` object carries exactly these six keys. */
export const PAGE_FIELDS = Object.freeze([
  'limit',
  'returned',
  'has_more',
  'next_cursor',
  'order',
  'byte_limited',
]);

/** Contract §5: the sorting literal for `GET /api/v1/alerts`. */
export const ALERT_ORDER = 'last_seen_desc';

/** Contract §5: the sorting literal for `GET /api/v1/analysis`. */
export const ANALYSIS_ORDER = 'created_at_desc';

/**
 * Sequences that must never reach a terminal, whatever the daemon sent.
 *
 * `\u001b[2J` clears the screen, `\u001b]0;x\u0007` retitles the window, `\u202E` flips
 * the direction of everything after it (the `evilexe.png` trick) and a bare `\u0007`
 * rings the bell once per row.
 */
export const FORBIDDEN_CHARS = Object.freeze(['\u001b', '\u202E', '\u0007']);

/**
 * One legal alert row (contract §6.1).
 *
 * There is deliberately no `event_ids` here: contract §7 forbids the evidence id array
 * from leaving the daemon, and a fixture that carried it would quietly teach the tests
 * to read a field the contract says must not exist. `evidence_count` is the count of
 * those ids and is the only evidence detail allowed out.
 *
 * @param {Record<string, unknown>} [overrides] Fields to replace.
 * @returns {object} Alert row.
 */
export function alertRow(overrides = {}) {
  return {
    alert_id: 'alrt-0001',
    rule_id: 'proc.suspicious-start',
    rule_version: '1.4.0',
    severity: 'high',
    status: 'new',
    count: 3,
    first_seen: '2026-11-02T10:00:00.000Z',
    last_seen: '2026-11-02T10:05:00.000Z',
    window_start: '2026-11-02T10:00:00.000Z',
    window_end: '2026-11-02T10:05:00.000Z',
    evidence_count: 3,
    evidence_truncated: false,
    ...overrides,
  };
}

/**
 * One legal analysis row (contract §6.2).
 *
 * `state` is the published name; the old fixtures' `status`, `severity`,
 * `request_seq` and `failure_code` are not in the whitelist and must not come back.
 * `completed_at` may be `null` (unknown) and `report_available` is a boolean.
 *
 * @param {Record<string, unknown>} [overrides] Fields to replace.
 * @returns {object} Analysis row.
 */
export function analysisRow(overrides = {}) {
  return {
    analysis_id: 'job-7f3a',
    alert_id: 'alrt-0001',
    state: 'succeeded',
    budget_class: 'standard',
    attempts: 2,
    created_at: '2026-11-02T10:06:00.000Z',
    updated_at: '2026-11-02T10:07:30.000Z',
    completed_at: '2026-11-02T10:07:30.000Z',
    report_available: true,
    ...overrides,
  };
}

/** Two alert rows, so "the first item" is a claim with a witness. */
export const ALERT_ROWS = Object.freeze([
  alertRow(),
  alertRow({
    alert_id: 'alrt-0002',
    rule_id: 'net.beacon',
    rule_version: '2.0.1',
    severity: 'medium',
    status: 'acknowledged',
    count: 1,
    first_seen: '2026-11-02T09:00:00.000Z',
    last_seen: '2026-11-02T09:30:00.000Z',
    window_start: '2026-11-02T09:00:00.000Z',
    window_end: '2026-11-02T09:30:00.000Z',
    evidence_count: 1,
    evidence_truncated: true,
  }),
]);

/** Two analysis rows. */
export const ANALYSIS_ROWS = Object.freeze([
  analysisRow(),
  analysisRow({
    analysis_id: 'job-8c1b',
    alert_id: 'alrt-0002',
    state: 'failed',
    budget_class: 'deep',
    attempts: 3,
    created_at: '2026-11-02T09:10:00.000Z',
    updated_at: '2026-11-02T09:20:00.000Z',
    completed_at: null,
    report_available: false,
  }),
]);

/**
 * An opaque cursor of the shape contract §4.2 describes, with a distinguishable payload.
 *
 * Two base64url segments joined by one dot. The second segment is derived from `label`,
 * which is what makes `cursorToken('p2')` and `cursorToken('p3')` different strings — a
 * fixture set that reused one cursor for every page could not tell "the client followed
 * the cursor" from "the client asked for the same page again".
 *
 * The label is *not* meant to be readable by the code under test. It is readable by a
 * human debugging a failure, which is the only reason it is derived rather than random.
 *
 * @param {string|number} [label] Distinguishing label.
 * @returns {string} Opaque cursor.
 */
export function cursorToken(label = 'p1') {
  return `djF.${Buffer.from(`page-${label}`, 'utf8').toString('base64url')}`;
}

/**
 * Build a `page` object (contract §5).
 *
 * `returned` defaults to the number of rows handed in, because that is the only value a
 * daemon could truthfully report for those rows — and the CLI refuses a page where the
 * two disagree. `has_more`, `next_cursor` and `byte_limited` default to the "this is the
 * whole result" spelling; a case that wants a truncated page overrides them explicitly.
 *
 * `order` has no default of its own on purpose: it is a per-endpoint literal, so
 * `alertsPage` / `analysisPage` supply it. A single default here would let an analysis
 * fixture silently claim `last_seen_desc`.
 *
 * @param {readonly object[]} [rows] Rows the page describes.
 * @param {Record<string, unknown>} [overrides] Field overrides.
 * @returns {object} Page object.
 */
export function page(rows = [], overrides = {}) {
  return {
    limit: 50,
    returned: rows.length,
    has_more: false,
    next_cursor: null,
    order: ALERT_ORDER,
    byte_limited: false,
    ...overrides,
  };
}

/**
 * Build an alerts page body: `{ alerts, page }`.
 *
 * @param {readonly object[]} [rows] Rows to serve.
 * @param {Record<string, unknown>} [pageOverrides] `page` overrides.
 * @returns {{alerts: object[], page: object}} Response body.
 */
export function alertsPage(rows = ALERT_ROWS, pageOverrides = {}) {
  const copy = rows.map((row) => ({ ...row }));
  return { alerts: copy, page: page(copy, { order: ALERT_ORDER, ...pageOverrides }) };
}

/**
 * Build an analysis page body: `{ analyses, page }`.
 *
 * @param {readonly object[]} [rows] Rows to serve.
 * @param {Record<string, unknown>} [pageOverrides] `page` overrides.
 * @returns {{analyses: object[], page: object}} Response body.
 */
export function analysisPage(rows = ANALYSIS_ROWS, pageOverrides = {}) {
  const copy = rows.map((row) => ({ ...row }));
  return { analyses: copy, page: page(copy, { order: ANALYSIS_ORDER, ...pageOverrides }) };
}

/**
 * Build a single-job detail body.
 *
 * Contract §1 says v0 serves no detail route, so this body describes a response no v0
 * daemon sends. It exists because the CLI keeps a forward-compatible detail branch, and
 * a test of that branch needs a body in the contract's own field vocabulary.
 *
 * @param {object} [job] Job to serve.
 * @param {{wrapped?: boolean}} [options] `wrapped: false` returns the job unwrapped.
 * @returns {object} Response body.
 */
export function analysisDetail(job = ANALYSIS_ROWS[0], options = {}) {
  const wrapped = options.wrapped !== false;
  const copy = { ...job };
  return wrapped ? { analysis: copy } : copy;
}

/**
 * An alert row whose text fields carry terminal control sequences.
 *
 * Each field is a different class of attack so one passing case cannot hide behind
 * another: a CSI clear-screen, an OSC window title, a right-to-left override and a bare
 * bell. After sanitisation the three fields must read `proc.evil`, `high` and `new`.
 *
 * @returns {object} Hostile alert row.
 */
export function hostileAlertRow() {
  return alertRow({
    alert_id: 'alrt-hostile',
    rule_id: 'proc.\u001b[2Jevil',
    severity: 'hi\u001b]0;x\u0007gh',
    status: 'ne\u202Ew\u0007',
  });
}

/**
 * An alerts page big enough to blow any sane `maxResponseBytes`, built from real bytes
 * rather than a lie in the headers.
 *
 * This body is never parsed — the transport abandons it first — so its `page` is only
 * shaped so that a test which accidentally *does* parse it fails on size, not on a
 * confusing `BAD_RESPONSE`.
 *
 * @param {number} [targetBytes] Size the body must reach (or 100 rows, whichever first).
 * @returns {Buffer} Serialised body.
 */
export function oversizedAlertsPage(targetBytes = 4096) {
  const rows = [];
  let body = Buffer.from('{}', 'utf8');
  for (let index = 0; index < 100; index += 1) {
    rows.push(alertRow({
      alert_id: `alrt-pad-${index}`,
      rule_id: `proc.padding-rule-${String(index).padStart(3, '0')}-${'x'.repeat(80)}`,
    }));
    body = Buffer.from(JSON.stringify(alertsPage(rows, { limit: 100 })), 'utf8');
    if (body.length >= targetBytes) {
      return body;
    }
  }
  return body;
}
