/**
 * commands.js — fetch a read-only resource, then project it into a stable view.
 *
 * Two separations matter here and both are load-bearing:
 *
 * 1. **Transport is not projection.** `readJson` decides whether a response is
 *    acceptable at all; `projectX` decides what the operator sees. A daemon that
 *    grows a new field does not change the CLI's `--json` contract, and a daemon that
 *    starts returning a huge nested object cannot flood the terminal.
 * 2. **Projection is an allowlist, not a filter.** Fields are picked by name. A
 *    `csrf_token` in the status payload — and the daemon does return one — is never
 *    copied, because it was never listed. That is the difference between "we delete
 *    the secret" (which fails the first time a field is renamed) and "we only copy
 *    what we meant to show".
 *
 * `alerts` and `analysis` are wired to the published v0 contract
 * (`docs/implementation/M7_API_CONTRACT.md`): one envelope key each (`alerts` /
 * `analyses`), a `page` object that is the only account of the page, and a whitelisted
 * field table. The client never fabricates a page — a missing or malformed envelope is
 * `BAD_RESPONSE`, never an empty list, because an empty list is indistinguishable from
 * "no alerts", which is exactly the wrong thing to tell an operator.
 *
 * **Cursors are opaque.** The CLI validates a cursor only as "a URL-safe token of at
 * most 512 characters" — it never splits, decodes, re-signs, ages out or repairs one.
 * Everything else about a cursor belongs to the daemon (contract §4.2–§4.4), including
 * the fact that rotating the token invalidates every cursor that was issued under it.
 * The one thing this layer *does* guarantee is that following a cursor terminates: a
 * repeated cursor, a page that claims more without returning a row, and a page cap all
 * end the walk in a defined state instead of looping.
 */

import { CliError, CLI_CODES } from './errors.js';
import { readJson } from './http-client.js';
import { sanitizeNullable, sanitizeText } from './format.js';
import { CURSOR_MAX_LENGTH, ROUTES, isCursorToken } from './routes.js';

// Re-exported so callers have one import for "the routes this CLI knows".
export { ROUTES };

/** Page size bounds for list commands (contract §9). */
export const LIMIT_RANGE = Object.freeze({ min: 1, max: 100 });

/** Default page size for list commands. */
export const DEFAULT_LIMIT = 50;

/**
 * Bounds for `--max-pages`, the page cap of a `--all` walk.
 *
 * The ceiling is what makes "no unbounded loop" a property of the code rather than of
 * the operator's patience: even `--max-pages 100` at `--limit 100` stops after 10,000
 * rows. It is deliberately not larger — a walk that needs more than that is a bulk
 * export, and contract §10.1 says paging is for browsing, not for export.
 */
export const MAX_PAGES_RANGE = Object.freeze({ min: 1, max: 100 });

/** Default page cap for `--all`. */
export const DEFAULT_MAX_PAGES = 10;

/** Alert/analysis identifiers: a conservative path-safe alphabet. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * The one spelling of an integer this CLI accepts for `--limit`.
 *
 * No sign, no exponent, no leading zero, no fraction, no surrounding whitespace. The
 * contract's query surface refuses those, so accepting them here would build a request
 * the daemon answers with `400` — and `Number()` would "fix" `007` and `1e2` into a page
 * size the operator never typed.
 */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

/**
 * Maximum number of collection items rendered from one response.
 *
 * Equal to `LIMIT_RANGE.max`: the contract guarantees a page holds at most `limit` rows,
 * so anything above that is a daemon that ignored the page size and the page accounting
 * cannot be trusted.
 */
const MAX_ITEMS = LIMIT_RANGE.max;

/**
 * Maximum number of scheduler sources rendered from a status payload.
 *
 * Deliberately a separate constant from `MAX_ITEMS`. The page cap moved to the contract's
 * `limit` ceiling (100), and reusing it here would have quietly halved the source list —
 * a rendering change with nothing to do with paging, in a command this round does not
 * touch.
 */
const MAX_SOURCES = 200;

/** Maximum number of keys copied out of a free-form counter map. */
const MAX_MAP_KEYS = 64;

/**
 * Width cap for an identifier in the machine-readable view.
 *
 * Deliberately far above every contract limit (128 characters for an analysis id, 36 for
 * a UUID): a valid identifier is therefore never shortened, so a `--json` consumer can
 * feed it straight back into `aegis-cli analysis <id>`. A cap still exists so a hostile
 * payload cannot make the terminal render a megabyte-long field.
 */
const IDENTIFIER_WIDTH = 512;

function badShape(subject, field) {
  return new CliError(
    CLI_CODES.BAD_RESPONSE,
    `daemon ${subject} payload is missing ${field}; refusing to render a partial view as if it were complete`,
    { field },
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a daemon-reported page size is one the contract admits (§9: `1..100`).
 *
 * Only used to decide whether an echoed `page.limit` may be printed; the page size the
 * CLI actually requests is validated by `parseLimit` before any request is sent.
 *
 * @param {unknown} value Candidate page size.
 * @returns {boolean} True when the value is an integer inside `LIMIT_RANGE`.
 */
function isLimitInRange(value) {
  return Number.isInteger(value) && value >= LIMIT_RANGE.min && value <= LIMIT_RANGE.max;
}

function text(value, maxWidth = 120) {
  return sanitizeText(value, maxWidth);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Sanitize an identifier for the machine-readable view without shortening it.
 *
 * @param {unknown} value Candidate identifier.
 * @returns {string} Sanitized identifier.
 */
function identifier(value) {
  return sanitizeText(value, IDENTIFIER_WIDTH);
}

function stringList(value, limit = 16) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, limit).map((entry) => text(entry, 80)).filter((entry) => entry.length > 0);
}

/**
 * Copy primitives out of a free-form map, sorted by key.
 *
 * Sorting makes `--json` output byte-identical across runs regardless of the order
 * the daemon happened to build its object in. Non-primitive values are dropped rather
 * than stringified: a nested object in a counter map is a daemon change the CLI has
 * not been taught about, and guessing at it would be worse than omitting it.
 *
 * @param {unknown} value Candidate map.
 * @param {{exclude?: readonly string[]}} [options] Options.
 * @returns {Record<string, string|number|boolean|null>} Sorted primitive map.
 */
function primitiveMap(value, options = {}) {
  if (!isPlainObject(value)) {
    return {};
  }
  const exclude = new Set(options.exclude ?? []);
  const output = {};
  const keys = Object.keys(value).filter((key) => !exclude.has(key) && /^[A-Za-z0-9_]{1,40}$/u.test(key)).sort();
  for (const key of keys.slice(0, MAX_MAP_KEYS)) {
    const entry = value[key];
    if (entry === null) {
      output[key] = null;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      output[key] = entry;
    } else if (typeof entry === 'boolean') {
      output[key] = entry;
    } else if (typeof entry === 'string') {
      output[key] = text(entry, 120);
    }
  }
  return output;
}

/**
 * Validate a `--limit` value.
 *
 * A string must already be the canonical decimal the daemon accepts; a number must
 * already be an integer in range. Anything else is a usage error, not something to
 * coerce: silently turning `007` into `7` or ` 10` into `10` answers a question the
 * operator did not ask, and `1e2` → `100` would hide a typo behind a legal page size.
 *
 * @param {unknown} value Raw argument.
 * @returns {number} Page size.
 * @throws {CliError} `USAGE` when out of range or not a canonical integer.
 */
export function parseLimit(value) {
  const limit = typeof value === 'number'
    ? value
    : typeof value === 'string' && CANONICAL_DECIMAL.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(limit) || limit < LIMIT_RANGE.min || limit > LIMIT_RANGE.max) {
    throw new CliError(
      CLI_CODES.USAGE,
      `--limit must be an integer in ${LIMIT_RANGE.min}..${LIMIT_RANGE.max}`,
      { command: 'limit' },
    );
  }
  return limit;
}

/**
 * Validate a `--cursor` value.
 *
 * The cursor is opaque, so this is the whole of the client's knowledge about it: it must
 * be a non-empty URL-safe token no longer than the contract's 512-character ceiling.
 * There is no attempt to decode it, to check a version byte, to verify a MAC or to
 * "repair" a truncated one — a client that did any of that would be a second, worse
 * implementation of a format it does not own, and the daemon would still be the one that
 * decides. A value that fails here is a usage error and never reaches the network, so a
 * malformed cursor costs one exit 2 instead of one `400` and a guess about why.
 *
 * The offending value is deliberately not echoed: a cursor is not a secret, but an
 * argument that fails validation is arbitrary caller text, and printing it back is how
 * a shell transcript ends up carrying something nobody meant to show.
 *
 * @param {unknown} value Raw argument.
 * @returns {string} Accepted cursor, unchanged.
 * @throws {CliError} `USAGE` when empty, too long or outside the URL-safe alphabet.
 */
export function parseCursor(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(
      CLI_CODES.USAGE,
      '--cursor must be a non-empty cursor; copy the one a previous run printed instead of building one',
      { command: 'cursor' },
    );
  }
  if (value.length > CURSOR_MAX_LENGTH) {
    throw new CliError(
      CLI_CODES.USAGE,
      `--cursor must be at most ${CURSOR_MAX_LENGTH} characters`,
      { command: 'cursor' },
    );
  }
  if (!isCursorToken(value)) {
    throw new CliError(
      CLI_CODES.USAGE,
      '--cursor contains characters a cursor never contains; pass the value the daemon returned, unmodified',
      { command: 'cursor' },
    );
  }
  return value;
}

/**
 * Validate a `--max-pages` value.
 *
 * Same canonical-decimal rule as `--limit`, for the same reason: `Number(' 3')` and
 * `Number('0x10')` both succeed, and neither is a page cap the operator typed.
 *
 * @param {unknown} value Raw argument.
 * @returns {number} Page cap.
 * @throws {CliError} `USAGE` when out of range or not a canonical integer.
 */
export function parseMaxPages(value) {
  const pages = typeof value === 'number'
    ? value
    : typeof value === 'string' && CANONICAL_DECIMAL.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(pages) || pages < MAX_PAGES_RANGE.min || pages > MAX_PAGES_RANGE.max) {
    throw new CliError(
      CLI_CODES.USAGE,
      `--max-pages must be an integer in ${MAX_PAGES_RANGE.min}..${MAX_PAGES_RANGE.max}`,
      { command: 'max-pages' },
    );
  }
  return pages;
}

/**
 * Validate an analysis identifier before it is placed in a path.
 *
 * The alphabet excludes `/`, `\`, whitespace, `%` and control characters, and the
 * dot-only forms are refused separately so `..` can never be a segment.
 *
 * @param {unknown} value Raw argument.
 * @returns {string} Accepted identifier.
 * @throws {CliError} `USAGE` when the identifier is not path-safe.
 */
export function assertAnalysisId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new CliError(CLI_CODES.USAGE, 'analysis id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}', {
      command: 'analysis',
    });
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new CliError(CLI_CODES.USAGE, 'analysis id must not contain a path traversal segment', {
      command: 'analysis',
    });
  }
  return value;
}

/**
 * Project the daemon status payload.
 *
 * @param {unknown} payload Decoded body.
 * @returns {object} Stable view.
 * @throws {CliError} `BAD_RESPONSE` when the payload is not a status document.
 */
export function projectStatus(payload) {
  if (!isPlainObject(payload)) {
    throw badShape('status', 'object');
  }
  if (typeof payload.lifecycle !== 'string') {
    throw badShape('status', 'lifecycle');
  }
  const health = isPlainObject(payload.health) ? payload.health : {};
  const scheduler = isPlainObject(payload.scheduler) ? payload.scheduler : {};
  const store = isPlainObject(payload.store) ? payload.store : {};
  const sources = Array.isArray(scheduler.sources) ? scheduler.sources.slice(0, MAX_SOURCES) : [];

  return {
    daemon: {
      schema_version: sanitizeNullable(payload.schema_version),
      version: text(payload.version, 40),
      lifecycle: text(payload.lifecycle, 40),
      mode: text(payload.mode, 20),
      started_at: sanitizeNullable(payload.started_at),
      now: sanitizeNullable(payload.now),
      epoch: sanitizeNullable(payload.epoch),
      uptime_ms: numberOrNull(payload.uptime_ms),
    },
    health: {
      status: text(health.status, 20) || 'unknown',
      ready: health.ready === true,
      reasons: stringList(health.reasons),
    },
    scheduler: {
      ...primitiveMap(scheduler, { exclude: ['sources'] }),
      sources: sources.filter(isPlainObject).map((source) => ({
        id: identifier(source.id),
        kind: text(source.kind, 40),
        lifecycle: text(source.lifecycle, 20),
        stale: source.stale === true,
        polling: source.polling === true,
        polls: numberOrNull(source.polls),
        events: numberOrNull(source.events),
        accepted: numberOrNull(source.accepted),
        failures: numberOrNull(source.failures),
        consecutive_failures: numberOrNull(source.consecutive_failures),
        dropped_events: numberOrNull(source.dropped_events),
        last_error_code: sanitizeNullable(source.last_error_code),
        last_poll_at: sanitizeNullable(source.last_poll_at),
        last_success_at: sanitizeNullable(source.last_success_at),
      })),
    },
    pipeline: {
      ...primitiveMap(payload.pipeline, { exclude: ['detection'] }),
      detection: isPlainObject(payload.pipeline) && isPlainObject(payload.pipeline.detection)
        ? primitiveMap(payload.pipeline.detection)
        : null,
    },
    store: {
      kind: text(store.kind, 40),
      open: store.open === true,
      counts: primitiveMap(store, { exclude: ['kind', 'open'] }),
    },
    counters: primitiveMap(payload.counters),
    // The daemon returns a CSRF proof in the status payload. The CLI has no use for
    // it (it never sends a state-changing request) and it is security material, so
    // only its presence is reported. The value is never copied.
    csrf_token_present: typeof payload.csrf_token === 'string',
  };
}

/**
 * Fetch and project `/api/v1/status`.
 *
 * @param {object} client Loopback client.
 * @param {string} token Bearer token.
 * @returns {Promise<object>} Stable view.
 */
export async function fetchStatus(client, token) {
  const response = readJson(await client.get(ROUTES.status, { token }));
  return projectStatus(response.body);
}

/**
 * Fetch liveness and readiness.
 *
 * Neither probe needs a token: the daemon answers them before authentication so a
 * service manager can tell "down" from "starting" without holding a credential.
 *
 * @param {object} client Loopback client.
 * @returns {Promise<object>} Stable view.
 */
export async function fetchHealth(client) {
  const liveness = readJson(await client.get(ROUTES.healthz), { allow: [503] });
  const readiness = readJson(await client.get(ROUTES.readyz), { allow: [503] });
  const livenessBody = isPlainObject(liveness.body) ? liveness.body : {};
  const readinessBody = isPlainObject(readiness.body) ? readiness.body : {};
  // Same strictness as the status projection: a probe payload without its one required
  // field is a contract break, not an "unknown" that still exits zero. Reporting
  // `ok: true` for `{}` would tell a service manager the daemon is fine.
  if (typeof livenessBody.status !== 'string') {
    throw badShape('healthz', 'status');
  }
  if (typeof readinessBody.ready !== 'boolean') {
    throw badShape('readyz', 'ready');
  }
  const livenessStatus = text(livenessBody.status, 20);
  const ready = readinessBody.ready === true;
  return {
    ok: ready && livenessStatus !== 'failed',
    liveness: {
      status: livenessStatus,
      version: text(livenessBody.version, 40),
      http_status: liveness.status,
    },
    readiness: {
      ready,
      lifecycle: text(readinessBody.lifecycle, 40),
      reasons: stringList(readinessBody.reasons),
      http_status: readiness.status,
    },
  };
}

/**
 * Read `page.next_cursor`, which is only meaningful together with `page.has_more`.
 *
 * Contract §4.1 makes the two fields one statement: `next_cursor` is non-null **only**
 * when there is more data, and `null` otherwise. So both directions are contract breaks,
 * and both are refused rather than smoothed over:
 *
 * - `has_more: true` with no cursor is a page the client cannot continue. Accepting it
 *   would print "there is more" with no way to reach it, and `--all` would silently
 *   return a truncated list while claiming to have finished.
 * - `has_more: false` *with* a cursor is a daemon contradicting itself. Following it
 *   would be following a page that says it is the last one.
 *
 * A cursor that is present but outside the URL-safe alphabet is refused here too: the
 * client could not place it in a request target, and `--all` would fail one page later
 * with a message about a path instead of about the payload. Checking at projection time
 * names `page.next_cursor`, which is the field that is actually wrong.
 *
 * @param {string} subject Endpoint name used in messages.
 * @param {object} page Validated `page` object.
 * @returns {string|null} Cursor to continue from, or `null` at the end of the list.
 * @throws {CliError} `BAD_RESPONSE` when `next_cursor` and `has_more` disagree.
 */
function projectCursor(subject, page) {
  const hasMore = page.has_more === true;
  const raw = page.next_cursor;
  if (!hasMore) {
    if (raw === null || raw === undefined) {
      return null;
    }
    throw new CliError(
      CLI_CODES.BAD_RESPONSE,
      `daemon ${subject} payload says page.has_more=false but carries a page.next_cursor; following it would mean continuing a page that claims to be the last one`,
      { field: 'page.next_cursor' },
    );
  }
  if (!isCursorToken(raw)) {
    throw new CliError(
      CLI_CODES.BAD_RESPONSE,
      `daemon ${subject} payload says page.has_more=true but its page.next_cursor is not a cursor this client can send back; refusing to report more rows it cannot reach`,
      { field: 'page.next_cursor' },
    );
  }
  return raw;
}

/**
 * Read the page envelope of a list response.
 *
 * The envelope is not a guess any more: contract §5 fixes one array key per endpoint and
 * one `page` object, and §11 makes both part of the compatibility surface. The four
 * required pieces — the array, `page`, an integer `page.returned` and a boolean
 * `page.has_more` — are checked by name, so a daemon that renames a key produces
 * `BAD_RESPONSE` with the offending field rather than a convincing empty page.
 *
 * `page.limit`, `page.order` and `page.byte_limited` are optional reads: when absent — or,
 * for `limit`, when outside the contract's `1..100` — the requested page size, `false` and
 * an empty literal stand in. `page.next_cursor` is checked against `has_more` (see
 * {@link projectCursor}) because the two fields are one statement in two halves.
 *
 * @param {string} subject Endpoint name used in messages (`alerts` / `analysis`).
 * @param {unknown} body Decoded body.
 * @param {string} key Envelope key that holds the rows.
 * @param {number} limit Page size that was requested.
 * @param {(item: object) => object} project Row projection.
 * @param {string} idField Name of the row's primary key, read raw for duplicate detection.
 * @returns {object} Stable list view.
 * @throws {CliError} `BAD_RESPONSE` when the envelope does not match the contract.
 */
function projectPage(subject, body, key, limit, project, idField) {
  const list = isPlainObject(body) ? body[key] : undefined;
  if (!Array.isArray(list)) {
    throw badShape(subject, key);
  }
  const page = isPlainObject(body) ? body.page : undefined;
  if (!isPlainObject(page)) {
    throw badShape(subject, 'page');
  }
  if (!Number.isInteger(page.returned)) {
    throw badShape(subject, 'page.returned');
  }
  if (typeof page.has_more !== 'boolean') {
    throw badShape(subject, 'page.has_more');
  }

  // Contract §5 says the item array is emitted in sort order, so every element is a row.
  // A `5` or a `null` sitting in that array is not "a row to skip" — it is the response
  // being broken — and filtering it away would let `page.returned` reconcile itself against
  // a list this client silently shortened, which is exactly the check below doing nothing.
  // Checked before projection, so the reported field names the array rather than a row.
  if (!list.every(isPlainObject)) {
    // A distinct message rather than `badShape`: "missing alerts[]" describes an absent
    // array, and this is the opposite problem — the array is here, one of its elements is
    // not a row. Reusing the wording would send an operator looking for a deleted key.
    throw new CliError(
      CLI_CODES.BAD_RESPONSE,
      `daemon ${subject} payload contains an element that is not an object; refusing to reconcile page.returned against a list this client would have shortened`,
      { field: `${subject}[]` },
    );
  }

  const items = list.map(project);
  // `returned` is the daemon's own count of this page. When it disagrees with the rows we
  // hold — including a page larger than the size we asked for — the two cannot both be
  // true, and printing either number would be inventing a page.
  if (page.returned !== items.length || items.length > Math.min(limit, MAX_ITEMS)) {
    throw badShape(subject, 'page.returned');
  }

  const nextCursor = projectCursor(subject, page);
  // A page that says "more" while returning no row makes no progress: the next request
  // would carry a fresh cursor and get another empty page, forever. Contract §9 forbids a
  // zero-row continuation (a byte-limited page keeps at least one row), so this is a
  // broken response and not a slow one. Refused at the page level, which means a single
  // `alerts` invocation fails the same way a `--all` walk does instead of only the walk.
  if (nextCursor !== null && page.returned === 0) {
    throw new CliError(
      CLI_CODES.BAD_RESPONSE,
      `daemon ${subject} payload reports page.has_more=true with zero rows returned; a page that returns nothing cannot advance, so following it would repeat forever`,
      { field: 'page.returned', reason: 'PAGINATION_NO_PROGRESS' },
    );
  }

  return {
    // `limit` is display metadata, not page truth: `returned` and `has_more` are the page's
    // own account and both are strictly checked above. A daemon echoing `limit: 9999`
    // (§9 caps it at 100) has broken a label only, so falling back to the size that was
    // actually requested keeps the header honest at the cost of one number. Refusing the
    // page over it would trade a cosmetic mismatch for the loss of every real row on it —
    // not a bargain worth making for a field nothing downstream reconciles.
    limit: isLimitInRange(page.limit) ? page.limit : limit,
    returned: page.returned,
    has_more: page.has_more,
    byte_limited: page.byte_limited === true,
    // A literal from the contract, echoed as sent: the CLI does not infer an ordering it
    // cannot verify, and an absent one stays empty for the renderer to show as `-`.
    order: typeof page.order === 'string' ? text(page.order, 40) : '',
    // Echoed unchanged. It is not a secret and it is not interpreted; it is the only
    // handle on the next page, so the renderer may print it and `--json` may carry it.
    next_cursor: nextCursor,
    items,
    // The *raw* primary keys, for the walk's duplicate check only — never projected.
    //
    // Deliberately not `items[i][idField]`: projection sanitizes (collapsing runs of
    // whitespace, blocking URI-looking values), and contract §4.4 admits any printable
    // ASCII as an id, so `"a  b"` and `"a b"` are two different legal rows that project to
    // the same string. Comparing projected ids would refuse that pair as a duplicate and
    // reject valid data. `null` marks an id that cannot be compared — absent, or longer
    // than any id the contract allows — and the caller skips those rather than guessing.
    ids: list.map((row) => {
      const raw = row[idField];
      return typeof raw === 'string' && raw.length > 0 && raw.length <= IDENTIFIER_WIDTH ? raw : null;
    }),
  };
}

/**
 * Project one alert row (contract §6.1).
 *
 * Identifiers are sanitized but not display-truncated: a `--json` consumer that feeds an
 * id back into `aegis-cli analysis <id>` must get the id the daemon sent, not a version
 * shortened to fit a terminal column. The table renderer imposes its own width limits at
 * print time, where shortening is visibly an ellipsis rather than silent data loss.
 *
 * `evidence_count` is read as a field of its own. The row's evidence *ids* are forbidden
 * out of the daemon (contract §7), so a client that counted them would be reading a field
 * that must not exist — and would show `-` the day the contract is honoured.
 *
 * @param {object} item Candidate alert.
 * @returns {object} Stable row.
 */
function projectAlert(item) {
  return {
    alert_id: identifier(item.alert_id),
    rule_id: identifier(item.rule_id),
    rule_version: text(item.rule_version, 40),
    severity: text(item.severity, 20),
    status: text(item.status, 20),
    count: numberOrNull(item.count),
    first_seen: sanitizeNullable(item.first_seen),
    last_seen: sanitizeNullable(item.last_seen),
    window_start: sanitizeNullable(item.window_start),
    window_end: sanitizeNullable(item.window_end),
    evidence_count: numberOrNull(item.evidence_count),
    evidence_truncated: item.evidence_truncated === true,
  };
}

/**
 * Walk one list endpoint, optionally following `next_cursor` to the end.
 *
 * This is the only place in the CLI that issues more than one request, so it is also the
 * only place that can loop. Four properties keep a walk finite and honest:
 *
 * 1. **A cursor is never reused.** Every cursor that has been *sent* is remembered, and a
 *    `next_cursor` already in that set ends the walk with `BAD_RESPONSE`
 *    (`PAGINATION_LOOP`). That covers the immediate echo (`next === cursor`, which would
 *    spin at full speed), the two-cycle (`A → B → A`) and the daemon that keeps handing
 *    back its first cursor while appending rows.
 * 2. **A page must make progress.** `has_more: true` with zero rows is refused by
 *    `projectPage` before the walk ever sees it: it cannot advance the cursor's meaning,
 *    only its value.
 * 3. **A page cap always applies.** `maxPages` is at least 1 and at most
 *    `MAX_PAGES_RANGE.max`, so the loop is bounded by a constant the caller cannot make
 *    unbounded. Hitting it is *not* a failure: the walk stops with `truncated: true`,
 *    `has_more: true` and the cursor it reached, which is the truth — there is more, and
 *    here is where to pick it up.
 * 4. **Rows are not duplicated.** `alert_id` / `analysis_id` are primary keys, and
 *    contract §10.1 says keyset paging can *skip* a merged alert but never repeat one.
 *    Seeing the same id twice therefore means the daemon's paging is broken, and a walk
 *    that silently concatenated it would double-count evidence in whatever reads the
 *    output. It is refused as `BAD_RESPONSE` (`PAGINATION_DUPLICATE`).
 *
 * Rows without an id are exempt from check 4 and are not deduplicated: `identifier()`
 * maps a missing id to the empty string, and collapsing every anonymous row into one
 * would be a much worse bug than the one the check exists to catch.
 *
 * @param {object} client Loopback client.
 * @param {{
 *   subject: string,
 *   route: string,
 *   key: string,
 *   idField: string,
 *   project: (item: object) => object,
 *   token: string,
 *   limit: number,
 *   cursor?: string|null,
 *   follow?: boolean,
 *   maxPages?: number
 * }} options Options.
 * @returns {Promise<object>} One merged view for the whole walk.
 * @throws {CliError} `USAGE` for a bad limit/cursor/page cap, `BAD_RESPONSE` for a
 *   broken page, and whatever the transport raises for the first failing page.
 */
async function fetchList(client, options) {
  // Validated here and not only in `main.js`: the route grammar refuses a bad `?limit=`,
  // but it refuses it as `INTERNAL` ("a path outside the read-only route table"), which
  // tells a direct caller nothing about the argument they got wrong.
  const pageSize = parseLimit(options.limit);
  const follow = options.follow === true;
  const maxPages = follow ? parseMaxPages(options.maxPages ?? DEFAULT_MAX_PAGES) : 1;
  let cursor = options.cursor === undefined || options.cursor === null ? null : parseCursor(options.cursor);

  const sent = new Set();
  if (cursor !== null) {
    sent.add(cursor);
  }
  const rows = [];
  const seenIds = new Set();
  let pageCount = 0;
  let byteLimited = false;
  let last = null;
  let truncated = false;

  for (;;) {
    const target = cursor === null
      ? `${options.route}?limit=${pageSize}`
      : `${options.route}?limit=${pageSize}&cursor=${cursor}`;
    const response = readJson(await client.get(target, { token: options.token }));
    const view = projectPage(
      options.subject,
      response.body,
      options.key,
      pageSize,
      options.project,
      options.idField,
    );
    pageCount += 1;
    byteLimited = byteLimited || view.byte_limited === true;

    for (let index = 0; index < view.items.length; index += 1) {
      const item = view.items[index];
      // Raw key when there is one, so two distinct stored ids that sanitize to the same
      // display string are not mistaken for a duplicate. `null` means "not comparable".
      const id = view.ids[index];
      if (id !== null) {
        if (seenIds.has(id)) {
          throw new CliError(
            CLI_CODES.BAD_RESPONSE,
            `daemon ${options.subject} pagination returned ${options.idField} "${sanitizeText(id, 64)}" on two pages; a keyset page can skip a concurrently merged row but never repeat one`,
            { field: options.idField, reason: 'PAGINATION_DUPLICATE' },
          );
        }
        seenIds.add(id);
      }
      rows.push(item);
    }
    last = view;

    if (view.has_more !== true) {
      break;
    }
    const next = view.next_cursor;
    // Checked before the page cap on purpose. A daemon that repeats a cursor has broken
    // the contract on *this* response, and that verdict must not depend on how many pages
    // the operator allowed: with the cap checked first, the same broken page would read as
    // a clean truncation at `--max-pages 2` and as a loop at `--max-pages 3`. `next` can
    // only be `null` here if `projectPage` stopped enforcing §4.1, so that half is
    // defence in depth rather than a state a legal daemon can produce.
    if (next === null || sent.has(next)) {
      throw new CliError(
        CLI_CODES.BAD_RESPONSE,
        `daemon ${options.subject} pagination repeated a cursor after ${pageCount} page(s); following it would loop forever`,
        { field: 'page.next_cursor', reason: 'PAGINATION_LOOP' },
      );
    }
    if (pageCount >= maxPages) {
      // Reaching the cap with more to read is a truncation, and only a `--all` walk has a
      // cap to reach: a single-page read is pinned to one page, so it reports `has_more`
      // and the cursor and nothing else.
      truncated = follow;
      break;
    }
    sent.add(next);
    cursor = next;
  }

  return {
    limit: last.limit,
    // The merged count, not the last page's `returned`: this view describes the whole walk.
    returned: rows.length,
    has_more: last.has_more === true,
    byte_limited: byteLimited,
    order: last.order,
    // How many requests this view cost. `1` means a single page, which is what the header
    // uses to decide whether the number is worth printing.
    pages: pageCount,
    // The walk stopped at the cap with rows still unread. Distinct from `has_more`, which
    // is about the daemon; this is about this invocation.
    truncated,
    next_cursor: last.next_cursor,
    items: rows,
  };
}

/**
 * Fetch the alerts list, or as many pages of it as were asked for.
 *
 * @param {object} client Loopback client.
 * @param {{token: string, limit: number, cursor?: string|null, follow?: boolean, maxPages?: number}} options Options.
 * @returns {Promise<object>} Stable view.
 */
export async function fetchAlerts(client, options) {
  return fetchList(client, {
    subject: 'alerts',
    route: ROUTES.alerts,
    key: 'alerts',
    idField: 'alert_id',
    project: projectAlert,
    token: options.token,
    limit: options.limit,
    cursor: options.cursor,
    follow: options.follow,
    maxPages: options.maxPages,
  });
}

/**
 * Project one analysis row (contract §6.2).
 *
 * The published whitelist has no `severity`, no `request_seq` and no `failure_code`;
 * `failure_reason` is a forbidden field (contract §7), so the row describes *outcome*
 * (`state`, `report_available`, `completed_at`) instead of the failure text.
 *
 * `attempts` is the out-of-daemon name for `attempt_seq`; the mapping happens in the
 * daemon, so the CLI reads the name the contract publishes.
 *
 * @param {object} item Candidate analysis.
 * @returns {object} Stable row.
 */
function projectAnalysis(item) {
  return {
    analysis_id: identifier(item.analysis_id),
    alert_id: identifier(item.alert_id),
    state: text(item.state, 24),
    budget_class: text(item.budget_class, 20),
    attempts: numberOrNull(item.attempts),
    created_at: sanitizeNullable(item.created_at),
    updated_at: sanitizeNullable(item.updated_at),
    completed_at: sanitizeNullable(item.completed_at),
    report_available: item.report_available === true,
  };
}

/**
 * Fetch analysis jobs, or a single job by id.
 *
 * The detail route is kept for forward compatibility only: contract §1 says v0 does not
 * serve `/api/v1/analysis/{id}`, so the daemon answers `404` and the request fails as
 * `ENDPOINT_UNAVAILABLE` with a message that points at the list instead. Keeping the
 * branch means one contract version later it starts working without a rewrite.
 *
 * @param {object} client Loopback client.
 * @param {{
 *   token: string,
 *   limit: number,
 *   id?: string|null,
 *   cursor?: string|null,
 *   follow?: boolean,
 *   maxPages?: number
 * }} options Options.
 * @returns {Promise<object>} Stable view.
 */
export async function fetchAnalysis(client, options) {
  if (typeof options.id === 'string') {
    const id = assertAnalysisId(options.id);
    // No `encodeURIComponent`: every character `assertAnalysisId` admits is a legal
    // `pchar` in a path segment, and encoding them would produce `%3A` for a colon,
    // which the closed route grammar (correctly) refuses. The identifier is validated,
    // not escaped; escaping would also mean two spellings of the same request.
    const response = readJson(await client.get(`${ROUTES.analysis}/${id}`, {
      token: options.token,
    }));
    const body = isPlainObject(response.body) && isPlainObject(response.body.analysis)
      ? response.body.analysis
      : response.body;
    if (!isPlainObject(body)) {
      throw badShape('analysis', 'object');
    }
    // A detail body that cannot name itself is not "a job with missing fields", it is a
    // broken contract: rendering it would answer the one question this branch exists to
    // answer — "does this job exist?" — with `-` and exit code 0, i.e. with `yes`.
    // Checked here, before projection, so the refusal costs no second request.
    //
    // Only `analysis_id` counts. It is the name the contract publishes, and accepting a
    // second spelling would make the check pass on a payload no version of the contract
    // describes.
    //
    // The list branch keeps accepting rows that lack it: `projectPage` already validates
    // the page as a whole, and refusing the entire page over one anonymous row would
    // trade a visible blank for the loss of the rows that were fine.
    if (typeof body.analysis_id !== 'string' || identifier(body.analysis_id) === '') {
      throw badShape('analysis', 'analysis_id');
    }
    return { id, item: projectAnalysis(body) };
  }
  return fetchList(client, {
    subject: 'analysis',
    route: ROUTES.analysis,
    key: 'analyses',
    idField: 'analysis_id',
    project: projectAnalysis,
    token: options.token,
    limit: options.limit,
    cursor: options.cursor,
    follow: options.follow,
    maxPages: options.maxPages,
  });
}
