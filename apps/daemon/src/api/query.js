/**
 * api/query.js — the closed query surface, the projection whitelist and the page
 * assembler shared by both read endpoints.
 *
 * Three rules that this module exists to enforce in one place:
 *
 * 1. **The query surface is closed.** Exactly `limit` and `cursor`. Anything else —
 *    an unknown key, a repeated key, an empty value — is refused instead of being
 *    ignored, because an ignored parameter looks honoured to the caller: `?limit=10
 *    &offset=200` would silently return the first ten rows and the caller would
 *    believe it read the third page.
 * 2. **Projection is a whitelist, never `...row` with deletions.** The stored row
 *    carries `event_ids_json`, `evidence_refs_json`, `canonical_json`,
 *    `idempotency_key`, lease columns and more. Deleting known-bad fields means the
 *    next column a schema migration adds is exposed automatically; naming the
 *    allowed ones means it is not. This is the whole redaction boundary, so it is written
 *    as an explicit list rather than as a filter.
 * 3. **A page is capped by bytes, not only by rows.** One alert row can carry a
 *    large id set; a hundred of them can exceed the 256 KiB response budget. The
 *    cap trims rows and reports `byte_limited`, and the resulting `next_cursor`
 *    points at the trim point so pagination still loses nothing.
 */

import { API_CODES, ApiError } from './errors.js';

/** Page size when the caller does not ask for one. */
export const LIMIT_DEFAULT = 50;

/** Largest page a caller may ask for. */
export const LIMIT_MAX = 100;

/** Response byte budget. Trimming happens instead of failing the request. */
export const MAX_RESPONSE_BYTES = 262144;

/** Only these two parameters exist. */
const ALLOWED_PARAMETERS = new Set(['limit', 'cursor']);

/**
 * `limit` grammar: a decimal integer with no sign, no exponent, no leading zero and
 * no surrounding space. `Number(' 5 ')`, `Number('5.0')` and `parseInt('5abc')` all
 * succeed where this pattern fails, and each of those acceptance paths would make
 * the documented `1..100` range mean something different from what it says.
 */
const LIMIT_PATTERN = /^(?:[1-9]\d{0,2})$/u;

/** Ordering literals. Part of the response contract, so they are not computed. */
const ORDER_ALERTS = 'last_seen_desc';
const ORDER_ANALYSES = 'created_at_desc';
const ORDERS = new Set([ORDER_ALERTS, ORDER_ANALYSES]);

/** Bytes taken by `[` and `]` around the item array. */
const ARRAY_BYTES = 2;

/** Bytes taken by the envelope around the item array plus the `page` object keys. */
const ENVELOPE_BYTES = 96;

/** Longest parameter name echoed back; anything longer becomes {@link UNKNOWN_PARAMETER}. */
const PARAMETER_NAME_MAX = 64;

/** Literal reported instead of an over-long caller-supplied parameter name. */
const UNKNOWN_PARAMETER = '<unknown>';

/**
 * Build a `QUERY_INVALID` error.
 *
 * The parameter name is caller-controlled, so echoing it verbatim would let a
 * single request decide how large the response body is (`?<3000 chars>=1`). Names
 * beyond the cap are replaced by a fixed literal rather than truncated: a truncated
 * name would still look like a real parameter name to a reader.
 *
 * @param {string} parameter Offending parameter name.
 * @param {object} [extra] Additional identifier-only details.
 * @returns {ApiError} Caller-facing error.
 */
function queryInvalid(parameter, extra = undefined) {
  const name = typeof parameter === 'string' && parameter.length <= PARAMETER_NAME_MAX
    ? parameter
    : UNKNOWN_PARAMETER;
  return new ApiError(
    API_CODES.QUERY_INVALID,
    'query parameter is not accepted',
    extra === undefined ? { parameter: name } : { parameter: name, ...extra },
  );
}

/**
 * Parse and validate the page query.
 *
 * Iteration is over every entry rather than `get()`: a duplicated key is invisible
 * to `get` (it returns the first), and "the caller said two different things" must
 * be refused, not resolved by precedence.
 *
 * @param {URLSearchParams} searchParams Query string.
 * @returns {{limit: number, cursor: string|null}} Validated page request.
 */
export function parsePageQuery(searchParams) {
  if (searchParams === null || searchParams === undefined || typeof searchParams[Symbol.iterator] !== 'function') {
    throw queryInvalid('query');
  }
  let limit = LIMIT_DEFAULT;
  let cursor = null;
  const seen = new Set();
  for (const [key, value] of searchParams) {
    if (!ALLOWED_PARAMETERS.has(key)) {
      throw queryInvalid(key);
    }
    if (seen.has(key)) {
      throw queryInvalid(key);
    }
    seen.add(key);
    if (value === '') {
      throw queryInvalid(key);
    }
    if (key === 'limit') {
      if (!LIMIT_PATTERN.test(value)) {
        throw queryInvalid('limit');
      }
      const parsed = Number(value);
      if (parsed > LIMIT_MAX) {
        throw queryInvalid('limit', { limit_max: LIMIT_MAX });
      }
      limit = parsed;
      continue;
    }
    // Cursor length is a codec concern (`too_long` is a CURSOR_INVALID reason), so
    // the string is passed through untouched here.
    cursor = value;
  }
  return { limit, cursor };
}

/**
 * @param {unknown} value Stored column value.
 * @returns {string|null} Text, or `null` when the column is absent.
 */
function text(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * @param {unknown} value Stored column value.
 * @returns {number|null} Integer, or `null` when the column is absent.
 */
function integer(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * @param {unknown} value Stored flag (`0`/`1` from SQLite, boolean in memory).
 * @param {boolean} fallback Value used when the column is absent.
 * @returns {boolean} Flag.
 */
function flag(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    return Number(value) !== 0;
  }
  return fallback;
}

/**
 * Project an alert row onto the public field list.
 *
 * The input may be a SQLite row or the in-memory row; the read model normalizes
 * both to the same field names before calling this, so the whitelist has exactly
 * one list to keep current.
 *
 * @param {object} row Stored alert row.
 * @returns {object} Response item with exactly the contracted fields.
 */
export function projectAlert(row) {
  const source = row ?? {};
  return {
    alert_id: text(source.alert_id),
    rule_id: text(source.rule_id),
    rule_version: text(source.rule_version),
    severity: text(source.severity),
    status: text(source.status),
    count: integer(source.count),
    first_seen: text(source.first_seen),
    last_seen: text(source.last_seen),
    window_start: text(source.window_start),
    window_end: text(source.window_end),
    evidence_count: integer(source.evidence_count),
    evidence_truncated: flag(source.evidence_truncated, false),
  };
}

/**
 * Project an analysis row onto the public field list.
 *
 * The stored column is `attempt_seq` and the public name is `attempts`; both are
 * accepted here so the read model can pass a SQLite row or an in-memory row without
 * renaming it first. The internal millisecond columns are simply never named, so
 * they cannot leak by being forgotten.
 *
 * @param {object} row Stored analysis row.
 * @returns {object} Response item with exactly the contracted fields.
 */
export function projectAnalysis(row) {
  const source = row ?? {};
  return {
    analysis_id: text(source.analysis_id),
    alert_id: text(source.alert_id),
    state: text(source.state),
    budget_class: text(source.budget_class),
    attempts: integer(source.attempts ?? source.attempt_seq),
    created_at: text(source.created_at),
    updated_at: text(source.updated_at),
    completed_at: text(source.completed_at),
    report_available: flag(source.report_available, false),
  };
}

/**
 * Bytes of a JSON item array, brackets and separators included.
 *
 * @param {readonly object[]} items Items.
 * @returns {number} Byte count.
 */
function arrayBytes(items) {
  let total = ARRAY_BYTES;
  for (let index = 0; index < items.length; index += 1) {
    total += Buffer.byteLength(JSON.stringify(items[index]), 'utf8');
    if (index > 0) {
      total += 1;
    }
  }
  return total;
}

/**
 * Assemble a page envelope, trimming rows until the response fits the byte budget.
 *
 * Trimming is measured on the serialized page rather than estimated: the cursor is
 * only known once the last kept row is known, and a cursor can be a couple of
 * hundred characters. The loop therefore recomputes the envelope after each drop,
 * which keeps the guarantee exact and costs at most `limit` iterations.
 *
 * At least one row is always kept: a single projected row cannot approach the
 * budget, and returning an empty page with `has_more: true` would be a page the
 * client can never advance past.
 *
 * @param {{
 *   rows: readonly object[],
 *   limit: number,
 *   hasMore: boolean,
 *   encodeNext: (lastKeptRow: object) => string,
 *   byteCap?: number,
 *   order?: 'last_seen_desc'|'created_at_desc'
 * }} options Page inputs. `rows` must already be projected items.
 * @returns {{items: object[], page: {limit: number, returned: number, has_more: boolean,
 *   next_cursor: string|null, order: string, byte_limited: boolean}}} Page.
 */
export function buildPage(options) {
  const limit = Number.isSafeInteger(options?.limit) && options.limit > 0 ? options.limit : LIMIT_DEFAULT;
  const byteCap = Number.isSafeInteger(options?.byteCap) && options.byteCap > 0 ? options.byteCap : MAX_RESPONSE_BYTES;
  const order = ORDERS.has(options?.order) ? options.order : ORDER_ALERTS;
  const encodeNext = options?.encodeNext;
  if (typeof encodeNext !== 'function') {
    throw new ApiError(API_CODES.QUERY_INVALID, 'page assembly requires a cursor encoder', { reason: 'encode' });
  }

  const supplied = Array.isArray(options?.rows) ? options.rows : [];
  const overflow = supplied.length > limit;
  const candidates = overflow ? supplied.slice(0, limit) : supplied;
  const moreRows = options?.hasMore === true || overflow;

  const kept = [...candidates];
  let items = arrayBytes(kept);
  let page;
  for (;;) {
    const more = moreRows || kept.length < candidates.length;
    const nextCursor = more && kept.length > 0 ? encodeNext(kept[kept.length - 1]) : null;
    page = {
      limit,
      returned: kept.length,
      has_more: more,
      next_cursor: nextCursor,
      order,
      // A byte trim always means later rows exist, so this flag and `has_more`
      // move together; `has_more` cannot be false while rows were dropped.
      byte_limited: kept.length < candidates.length,
    };
    const total = items + ENVELOPE_BYTES + Buffer.byteLength(JSON.stringify(page), 'utf8');
    if (total <= byteCap || kept.length <= 1) {
      break;
    }
    kept.pop();
    items = arrayBytes(kept);
  }
  return { items: kept, page };
}
