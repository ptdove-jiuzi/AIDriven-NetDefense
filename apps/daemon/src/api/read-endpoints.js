/**
 * api/read-endpoints.js — the two read handlers, in the exact order the contract
 * fixes: parse the query → verify the cursor → read one page more than asked →
 * project → assemble the envelope.
 *
 * The order matters because every step can only reject what it owns. Parsing
 * rejects unknown parameters; the codec rejects a forged, truncated or
 * cross-endpoint cursor; only a request that passed both reaches the store. A
 * caller who sends a bad cursor therefore learns nothing about the data set — not
 * even whether it is empty.
 *
 * The projection and the cursor key never travel together: a cursor is built from
 * the row's sort position, while the response item is a whitelist that deliberately
 * omits that position's timestamp columns. The endpoint keeps them apart with a
 * side map from item to position, so `buildPage` can stay a plain "rows in, envelope
 * out" helper and no ordinal field ever appears in a response body.
 */

import { createCursorCodec, CURSOR_KIND } from './cursor.js';
import { buildPage, MAX_RESPONSE_BYTES, parsePageQuery, projectAlert, projectAnalysis } from './query.js';
import { API_CODES, ApiError, isApiError } from './errors.js';
import { DaemonError, DAEMON_CODES } from '../errors.js';

/** Ordering literal reported for `/api/v1/alerts`. */
const ORDER_ALERTS = 'last_seen_desc';

/** Ordering literal reported for `/api/v1/analysis`. */
const ORDER_ANALYSES = 'created_at_desc';

/**
 * Create the read endpoint handlers.
 *
 * @param {{
 *   readModel: {listAlerts: Function, listAnalyses: Function},
 *   cursorKey: Buffer|string
 * }} options Options. `cursorKey` is the derived MAC key, not the API token.
 * @returns {{
 *   listAlerts: (searchParams: URLSearchParams) => Promise<object>,
 *   listAnalyses: (searchParams: URLSearchParams) => Promise<object>
 * }} Handlers.
 */
export function createReadEndpoints(options) {
  const readModel = options.readModel;
  const codec = createCursorCodec(options.cursorKey);

  /**
   * Shared body of both handlers.
   *
   * @param {URLSearchParams} searchParams Query string.
   * @param {{
   *   kind: number,
   *   order: string,
   *   key: 'alerts'|'analyses',
   *   project: (row: object) => object,
   *   read: (page: {limit: number, after: object|null}) => Promise<{rows: object[], hasMore: boolean}>
   * }} spec Endpoint description.
   * @returns {Promise<object>} Response body.
   */
  async function run(searchParams, spec) {
    const query = parsePageQuery(searchParams);
    const after = query.cursor === null ? null : codec.decode(query.cursor, { kind: spec.kind });

    const page = await spec.read({ limit: query.limit, after });
    // A page that is not a `{rows: [...]}` object is a broken read model, not an
    // empty result. Rendering it as `[]` would be exactly the "empty list stands in
    // for no alerts" failure the contract forbids, so it is reported as INTERNAL.
    if (page === null || typeof page !== 'object' || !Array.isArray(page.rows)) {
      throw new DaemonError(DAEMON_CODES.INTERNAL, 'read model returned an unexpected page shape');
    }
    const rows = page.rows;
    // The read model asks for `limit + 1`; the extra row only proves more data
    // exists. Both signals are kept so a model that forgot the extra row still
    // reports `has_more` honestly.
    const hasMore = page?.hasMore === true || rows.length > query.limit;
    const kept = rows.slice(0, query.limit);

    const positions = new Map();
    const items = kept.map((entry) => {
      const item = spec.project(entry.row);
      positions.set(item, entry);
      return item;
    });

    const assembled = buildPage({
      rows: items,
      limit: query.limit,
      hasMore,
      order: spec.order,
      byteCap: MAX_RESPONSE_BYTES,
      encodeNext: (item) => {
        const position = positions.get(item);
        if (position === undefined) {
          // Only reachable if `buildPage` were handed a row this handler never
          // projected, which is a wiring fault rather than caller input.
          throw new ApiError(API_CODES.QUERY_INVALID, 'page row has no cursor position', { reason: 'row' });
        }
        try {
          return codec.encode({ kind: spec.kind, ms: position.ms, id: position.id });
        } catch (error) {
          // A stored id outside the cursor id grammar (non-ASCII, or longer than
          // 128 bytes) cannot be represented as a cursor. That is a property of the
          // stored row, not of the request, so it must not be dressed up as a 400.
          if (isApiError(error)) {
            throw new DaemonError(
              DAEMON_CODES.STORE_UNAVAILABLE,
              'stored row cannot be represented as a cursor',
              { reason: 'UNREPRESENTABLE_ROW' },
            );
          }
          throw error;
        }
      },
    });

    return { [spec.key]: assembled.items, page: assembled.page };
  }

  return {
    /**
     * `GET /api/v1/alerts`.
     *
     * @param {URLSearchParams} searchParams Query string.
     * @returns {Promise<object>} Body with `alerts` and `page`.
     */
    listAlerts(searchParams) {
      return run(searchParams, {
        kind: CURSOR_KIND.alerts,
        order: ORDER_ALERTS,
        key: 'alerts',
        project: projectAlert,
        read: (page) => readModel.listAlerts(page),
      });
    },

    /**
     * `GET /api/v1/analysis`.
     *
     * @param {URLSearchParams} searchParams Query string.
     * @returns {Promise<object>} Body with `analyses` and `page`.
     */
    listAnalyses(searchParams) {
      return run(searchParams, {
        kind: CURSOR_KIND.analysis,
        order: ORDER_ANALYSES,
        key: 'analyses',
        project: projectAnalysis,
        read: (page) => readModel.listAnalyses(page),
      });
    },
  };
}
