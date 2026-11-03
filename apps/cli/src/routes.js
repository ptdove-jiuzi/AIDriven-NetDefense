/**
 * routes.js — the closed set of request targets the CLI is allowed to build.
 *
 * This is a closed set, not a prefix. An earlier version admitted anything starting
 * with `/api/v1/`, which meant the daemon's collector-poll route was reachable; only the
 * hard-coded `GET` verb made it harmless. A whitelist that admits a state-changing route
 * and relies on the verb to save it is one refactor away from being a state-changing
 * client, so the path itself is the boundary.
 *
 * The two list routes carry a validated integer query plus, optionally, one opaque
 * cursor, and the analysis item route carries one identifier from the same alphabet
 * `assertAnalysisId` accepts. There is no generic `/api/v1/:anything` form on purpose.
 */

/** Fixed route templates, shared by the client and the projection layer. */
export const ROUTES = Object.freeze({
  healthz: '/healthz',
  readyz: '/readyz',
  status: '/api/v1/status',
  alerts: '/api/v1/alerts',
  analysis: '/api/v1/analysis',
});

/**
 * Maximum cursor length the contract admits (contract §3/§9).
 *
 * Mirrored here because the route grammar, the argument parser and the response
 * projection all have to agree on it: a client that accepts a longer `--cursor` than the
 * daemon will take builds a request the daemon answers with `400`, and a client that
 * accepts a longer cursor from a *response* builds the same broken follow-up.
 */
export const CURSOR_MAX_LENGTH = 512;

/**
 * The character class a cursor is allowed to use, and nothing about its meaning.
 *
 * This is a **transport** constraint, not a format: every character here is an RFC 3986
 * unreserved character, so a cursor built from them needs no percent-encoding and cannot
 * alter the request target. The client never inspects the segments, the separator, the
 * version byte or the MAC — those are the daemon's business, and a client that decoded
 * them would be inventing a second implementation of a format the contract calls opaque.
 *
 * It happens to be a superset of `base64url` plus the `.` separator, which is what
 * contract §4.2 emits; that is a consequence of choosing "URL-safe", not a dependency on
 * the encoding.
 */
const CURSOR_ALPHABET = '[A-Za-z0-9._~-]';

/**
 * The same rule as a matcher.
 *
 * Built from {@link CURSOR_MAX_LENGTH} rather than written out, because the length is
 * asserted in three places — the argument parser, the route grammar and the response
 * projection — and a hand-copied `{1,512}` in any of them is a future off-by-one: raise
 * the ceiling in one place and a legal cursor would be accepted by the parser and then
 * refused by the route table as `INTERNAL`, which is the one exit code that says "client
 * bug" while pointing at the operator.
 */
const CURSOR_TOKEN = new RegExp(`^${CURSOR_ALPHABET}{1,${CURSOR_MAX_LENGTH}}$`, 'u');

/**
 * Whether a value may be placed in a request target as a cursor.
 *
 * Purely a safety and length check. No structure is read, validated or assumed.
 *
 * @param {unknown} value Candidate cursor.
 * @returns {boolean} `true` when the value is safe to send as `?cursor=`.
 */
export function isCursorToken(value) {
  return typeof value === 'string' && CURSOR_TOKEN.test(value);
}

/**
 * `?limit=N` and `?limit=N&cursor=C` forms of the two list routes.
 *
 * The bound mirrors `LIMIT_RANGE` (1..100) and the query surface is canonical: the
 * contract refuses `05`, `+5`, `1e2` and `5.0`, so the route grammar refuses the same
 * spellings rather than admitting a target the daemon would reject as `QUERY_INVALID`.
 * Both ends are exact — 100 is reachable, 101 is not — because a route set that admits
 * `?limit=999` while the command layer refuses to build it is a set with a hole, and a
 * future direct caller would fall into it.
 *
 * `cursor` is optional and always last, which is the only order the CLI builds. The
 * value is restricted to {@link isCursorToken}'s alphabet, so a cursor can never inject
 * a second parameter (`&limit=`), a fragment, or a path traversal into the target.
 */
const LIST_PATH = new RegExp(
  `^/api/v1/(?:alerts|analysis)\\?limit=(?:[1-9]|[1-9]\\d|100)(?:&cursor=${CURSOR_ALPHABET}{1,${CURSOR_MAX_LENGTH}})?$`,
  'u',
);

/**
 * One analysis item.
 *
 * The first character is alphanumeric, so `.` and `..` are not identifiers and cannot
 * become path segments even before `encodeURIComponent` runs.
 */
const ANALYSIS_ITEM_PATH = /^\/api\/v1\/analysis\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Report whether a request target is one the read-only client may build.
 *
 * @param {unknown} path Candidate target.
 * @returns {boolean} `true` for an allowed route.
 */
export function isReadOnlyPath(path) {
  if (typeof path !== 'string') {
    return false;
  }
  if (path === ROUTES.healthz || path === ROUTES.readyz || path === ROUTES.status) {
    return true;
  }
  return LIST_PATH.test(path) || ANALYSIS_ITEM_PATH.test(path);
}
