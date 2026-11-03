/**
 * http-client.js — the only network code in the CLI.
 *
 * Properties that are enforced by construction, not by convention:
 *
 * 1. **GET only.** The method is a literal in one request builder; there is no
 *    `method` option for a caller to fill in. A read-only client that accepts a verb
 *    from its caller is one refactor away from being something else, and the daemon's
 *    state-changing routes require CSRF proof this client never obtains.
 * 2. **No redirects.** `http.request` does not follow them, and a 3xx is reported as
 *    a bad response. Following a redirect would let the daemon (or whatever is
 *    listening) move the request — and the `Authorization` header — elsewhere.
 * 3. **No proxy.** `http.request` with explicit `host`/`port` never consults
 *    `HTTP_PROXY`; the connection is pinned to the configured loopback address.
 * 4. **A total deadline.** Sockets that accept a connection and then stall are the
 *    common failure for a local service that is starting up or wedged; a per-chunk
 *    idle timeout is not enough, so one deadline covers connect plus body.
 * 5. **A byte cap on the body.** The cap is checked against the declared
 *    `Content-Length` and against the bytes actually received, because the declared
 *    length is a claim, not a guarantee. Nothing past the cap is buffered.
 * 6. **No header echo.** Errors carry a status, a size and a daemon *code* — never a
 *    header value, and never the `Authorization` header this client sent.
 */

import http from 'node:http';

import { CliError, CLI_CODES, isParameterName } from './errors.js';
import { isReadOnlyPath } from './routes.js';

/** Response statuses that mean "the daemon did not implement this route". */
const UNSUPPORTED_STATUSES = new Set([404, 405]);

/**
 * Daemon code for "too many failed authentication attempts".
 *
 * The contract puts it on `429` (`401` is a plain auth failure), so it is recognised in
 * the 429 branch. Both spellings of 429 stay `RATE_LIMITED`; the code only decides which
 * sentence explains it.
 */
const AUTH_RATE_LIMITED = 'AUTH_RATE_LIMITED';

/** Daemon code for "the read path could not reach the store". */
const STORE_UNAVAILABLE = 'STORE_UNAVAILABLE';

/** Daemon code for "the cursor could not be decoded or verified" (contract §4.4). */
const CURSOR_INVALID = 'CURSOR_INVALID';

/** Daemon code for "the request line or headers could not be parsed" (contract §8). */
const MALFORMED_REQUEST = 'MALFORMED_REQUEST';

/**
 * Build a CLI error for a non-success HTTP status.
 *
 * @param {number} status HTTP status.
 * @param {string} text Raw body (read only to recover the daemon code and the rejected
 *   parameter name; it is never echoed).
 * @returns {CliError} Mapped error.
 */
function httpError(status, text) {
  // Parsed once for the whole function: the 400 branch needs both fields, and every other
  // branch needs only the code. Parsing per-branch would decode the same body twice.
  const { code: daemonCode, parameter } = daemonEnvelopeOf(text);
  if (status === 400) {
    // The query surface is closed (contract §3), so a `400` from a legal request has three
    // possible causes and they need different next steps: a rejected page size, a rejected
    // cursor, or a request the HTTP layer refused before routing. Reporting all three as
    // "unexpected status 400" would drop the daemon's own code and tell an operator
    // nothing they can act on.
    let message;
    if (daemonCode === CURSOR_INVALID) {
      // Contract §4.3: the cursor MAC is derived from the token, so a rotated token
      // invalidates every cursor issued under the old one. The recovery is always the
      // same, and it is not "try again" — it is "start over without the cursor".
      message = 'the daemon rejected the cursor (HTTP 400); a cursor is bound to one endpoint and to the current token, so drop --cursor and start again from the first page';
    } else if (daemonCode === MALFORMED_REQUEST) {
      message = 'the daemon refused the request line or headers (HTTP 400); retry without --cursor, or with a smaller --limit';
    } else if (parameter !== null) {
      // Contract §8 names the offending parameter; that name is the whole diagnosis, so it
      // is quoted rather than replaced by a list of the two this client can send.
      message = `the daemon rejected the "${parameter}" query parameter (HTTP 400); this client sends only limit and an opaque cursor`;
    } else {
      message = 'the daemon rejected the query parameters (HTTP 400); this client sends only limit in 1..100 plus an opaque cursor, so one of the two was refused';
    }
    return new CliError(CLI_CODES.BAD_RESPONSE, message, {
      status,
      daemon_code: daemonCode,
      ...(parameter === null ? {} : { parameter }),
    });
  }
  if (status === 401) {
    return new CliError(
      CLI_CODES.AUTH,
      'the daemon rejected the bearer token (HTTP 401); check that tokenFile points at the daemon\'s current token',
      { status, daemon_code: daemonCode },
    );
  }
  if (status === 403) {
    return new CliError(
      CLI_CODES.FORBIDDEN,
      'the daemon refused the request (HTTP 403); a loopback Host header is required and state-changing routes need CSRF',
      { status, daemon_code: daemonCode },
    );
  }
  if (status === 421) {
    // The daemon answers 421 when the `Host` header is not the literal address it bound.
    // That is an endpoint/configuration problem, and it is reported with the same exit
    // code as a refusal so a script can treat both as "written to the wrong place".
    return new CliError(
      CLI_CODES.FORBIDDEN,
      'the daemon rejected the Host header (HTTP 421); the configured endpoint must be the literal loopback address it bound',
      { status, daemon_code: daemonCode },
    );
  }
  if (UNSUPPORTED_STATUSES.has(status)) {
    // Contract §1: v0 serves exactly two list routes and no single-item detail route, so
    // a 404 here is about the route, not about the item. Saying which list to use instead
    // turns an exit-10 dead end into a next step.
    const detail = status === 404
      ? '; the v0 contract has no single-item detail route, so list the rows with `analysis --limit 100` instead of asking for one id'
      : '';
    return new CliError(
      CLI_CODES.ENDPOINT_UNAVAILABLE,
      `the running daemon does not expose this read-only endpoint (HTTP ${status})${detail}`,
      { status, daemon_code: daemonCode },
    );
  }
  if (status === 408) {
    return new CliError(CLI_CODES.TIMEOUT, 'the daemon abandoned the request as too slow (HTTP 408)', {
      status,
      daemon_code: daemonCode,
    });
  }
  if (status === 413) {
    return new CliError(CLI_CODES.RESPONSE_TOO_LARGE, 'the daemon refused the request body size (HTTP 413)', {
      status,
      daemon_code: daemonCode,
    });
  }
  if (status === 415) {
    return new CliError(
      CLI_CODES.BAD_RESPONSE,
      'the daemon rejected the request content type (HTTP 415); this client sends no body, so the endpoint expects something else',
      { status, daemon_code: daemonCode },
    );
  }
  if (status === 429) {
    // Contract §2: a peer that failed authentication too often is throttled with 429, not
    // 401. Both are `RATE_LIMITED` here — the exit code answers "slow down", the sentence
    // answers "why".
    const message = daemonCode === AUTH_RATE_LIMITED
      ? 'the daemon has throttled too many failed authentication attempts from this address (HTTP 429); wait before retrying'
      : 'the daemon is rate limiting this client (HTTP 429)';
    return new CliError(CLI_CODES.RATE_LIMITED, message, { status, daemon_code: daemonCode });
  }
  if (status >= 500) {
    // Contract §10: an unreachable store is not an empty result. Naming that out loud
    // keeps an exit-12 answer from reading as "there were no alerts".
    const message = daemonCode === STORE_UNAVAILABLE
      ? `the daemon could not reach its store (HTTP ${status}); storage being unavailable does not mean there are no alerts`
      : `the daemon reported an internal failure (HTTP ${status}); it may be degraded, not down`;
    return new CliError(CLI_CODES.DAEMON_ERROR, message, { status, daemon_code: daemonCode });
  }
  if (status >= 300 && status < 400) {
    return new CliError(
      CLI_CODES.BAD_RESPONSE,
      `the daemon answered with a redirect (HTTP ${status}); this client never follows one`,
      { status },
    );
  }
  return new CliError(CLI_CODES.BAD_RESPONSE, `unexpected HTTP status ${status} from the daemon`, { status });
}

/**
 * Parse a daemon error envelope once, keeping only what is safe to reuse.
 *
 * @param {string} text Raw body.
 * @returns {{code: string|null, parameter: string|null}} Extracted identifiers.
 */
function daemonEnvelopeOf(text) {
  const empty = { code: null, parameter: null };
  if (text.length === 0 || text.length > 65536) {
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  const code = parsed?.error?.code;
  const parameter = parsed?.error?.details?.parameter;
  return {
    code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null,
    // A parameter name, shape-checked with the same predicate `errors.js` applies on the way
    // out: this value is interpolated into a message, so it must never be able to carry a
    // quote, a newline or a control sequence into prose. The contract's own `"<unknown>"`
    // sentinel is admitted by that predicate — it is a fixed literal, not caller text.
    parameter: isParameterName(parameter) ? parameter : null,
  };
}

/**
 * Map a socket-level failure onto a CLI error.
 *
 * @param {NodeJS.ErrnoException} error Socket error.
 * @returns {CliError} Mapped error.
 */
function socketError(error) {
  const reason = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(error.code) ? error.code : 'SOCKET';
  if (reason === 'ECONNREFUSED' || reason === 'ENOENT') {
    return new CliError(
      CLI_CODES.UNREACHABLE,
      'no daemon is listening on the configured loopback endpoint; is the service running?',
      { reason },
    );
  }
  if (reason === 'ECONNRESET' || reason === 'EPIPE') {
    return new CliError(CLI_CODES.UNREACHABLE, 'the daemon closed the connection before answering', { reason });
  }
  return new CliError(CLI_CODES.UNREACHABLE, 'the daemon endpoint could not be reached', { reason });
}

/**
 * Reject a request target the CLI did not build itself.
 *
 * Membership is checked against the closed route set in `routes.js`; the second check
 * is belt-and-braces against a target that somehow contains whitespace or a traversal
 * segment (a `Host`-style header injection needs a space or a CRLF, and the route set
 * alone would not catch a build-up from a future caller).
 *
 * @param {string} path Request target.
 * @returns {string} The accepted path.
 */
function assertRequestPath(path) {
  if (!isReadOnlyPath(path)) {
    throw new CliError(CLI_CODES.INTERNAL, 'refusing to request a path outside the read-only route table');
  }
  // Traversal is checked on the path *before* the query, not on the whole target: a cursor
  // is opaque and its alphabet admits `.`, so `..` can legitimately appear inside one.
  // Rejecting the whole target would refuse a cursor the daemon issued and the route
  // grammar already accepted — a client bug that only shows up on one unlucky token. The
  // query string cannot reach the filesystem or change the route, so it needs no check
  // beyond the alphabet the route grammar enforces.
  const pathname = path.split('?')[0];
  if (/[\u0000-\u0020\u007f]/u.test(path) || pathname.includes('..')) {
    throw new CliError(CLI_CODES.INTERNAL, 'refusing to request a malformed path');
  }
  return path;
}

/**
 * Create a loopback client bound to one endpoint.
 *
 * @param {{
 *   endpoint: {host: string, port: number},
 *   timeoutMs: number,
 *   maxResponseBytes: number
 * }} options Options.
 * @returns {{get: (path: string, options?: {token?: string|null}) => Promise<{status: number, headers: object, text: string}>}} Client.
 */
export function createLoopbackClient(options) {
  const endpoint = options.endpoint;
  const timeoutMs = options.timeoutMs;
  const maxResponseBytes = options.maxResponseBytes;

  return {
    /**
     * Issue one authenticated-or-anonymous GET.
     *
     * `async` on purpose: a rejected path is reported as a rejected promise like every
     * other failure, so a caller has exactly one error path to handle.
     *
     * @param {string} path Absolute request target.
     * @param {{token?: string|null}} [requestOptions] Options.
     * @returns {Promise<{status: number, headers: object, text: string}>} Response.
     */
    async get(path, requestOptions = {}) {
      const target = assertRequestPath(path);
      const token = typeof requestOptions.token === 'string' ? requestOptions.token : null;
      return new Promise((resolve, reject) => {
        let settled = false;
        let deadline = null;
        const settle = (settleWith, value) => {
          if (settled) {
            return;
          }
          settled = true;
          if (deadline !== null) {
            clearTimeout(deadline);
            deadline = null;
          }
          settleWith(value);
        };

        const headers = {
          accept: 'application/json',
          'user-agent': 'aegis-cli',
        };
        if (token !== null) {
          headers.authorization = `Bearer ${token}`;
        }

        const request = http.request({
          host: endpoint.host,
          port: endpoint.port,
          path: target,
          method: 'GET',
          headers,
          agent: false,
        }, (response) => {
          const status = response.statusCode ?? 0;

          const declaredLength = Number(response.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
            response.destroy();
            settle(reject, new CliError(
              CLI_CODES.RESPONSE_TOO_LARGE,
              'the daemon response declares a size above the configured limit; nothing was buffered',
              { status, limit_bytes: maxResponseBytes, received_bytes: declaredLength },
            ));
            return;
          }

          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              response.destroy();
              settle(reject, new CliError(
                CLI_CODES.RESPONSE_TOO_LARGE,
                'the daemon response exceeded the configured limit; the request was abandoned',
                { status, limit_bytes: maxResponseBytes, received_bytes: size },
              ));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            settle(resolve, {
              status,
              headers: response.headers,
              text: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)),
            });
          });
          response.on('error', (error) => settle(reject, socketError(error)));
        });

        // One deadline for connect plus body. `unref` keeps a finished CLI from being
        // held open by this timer if a promise is abandoned during teardown.
        deadline = setTimeout(() => {
          request.destroy();
          settle(reject, new CliError(
            CLI_CODES.TIMEOUT,
            `the daemon did not answer within ${timeoutMs} ms`,
            { timeout_ms: timeoutMs },
          ));
        }, timeoutMs);
        deadline.unref?.();

        request.on('error', (error) => settle(reject, socketError(error)));
        request.end();
      });
    },
  };
}

/**
 * Accept only an `application/json`-family content type.
 *
 * A substring test for `json` also matches `text/html; profile=json` and
 * `text/plain; note=json`, which is not what "the daemon speaks JSON" means. The suffix is
 * anchored on a parameter boundary so `application/jsonx` is not a JSON media type either.
 */
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]*\+)?json\s*(?:;|$)/u;

/**
 * Decode a response body as a JSON object.
 *
 * Statuses outside 2xx throw unless explicitly tolerated — `/healthz` and `/readyz`
 * answer 503 for "present but unhealthy", which is information, not a transport
 * failure. Any other tolerated status is a caller decision and must be listed.
 *
 * @param {{status: number, headers: object, text: string}} response Transport response.
 * @param {{allow?: readonly number[]}} [options] Tolerated statuses.
 * @returns {{status: number, body: any}} Decoded body.
 * @throws {CliError} For a non-tolerated status, a non-JSON content type, an empty
 *   body or malformed JSON.
 */
export function readJson(response, options = {}) {
  const allowed = options.allow ?? [];
  const tolerated = allowed.includes(response.status);
  if (!tolerated && (response.status < 200 || response.status >= 300)) {
    throw httpError(response.status, response.text);
  }
  const contentType = typeof response.headers['content-type'] === 'string'
    ? response.headers['content-type'].trim().toLowerCase()
    : '';
  if (contentType.length > 0 && !JSON_CONTENT_TYPE.test(contentType)) {
    throw new CliError(
      CLI_CODES.BAD_RESPONSE,
      'the daemon answered with a non-JSON content type; refusing to interpret it',
      { status: response.status },
    );
  }
  const text = response.text.trim();
  if (text.length === 0) {
    throw new CliError(CLI_CODES.BAD_RESPONSE, 'the daemon returned an empty body', { status: response.status });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CliError(
      CLI_CODES.BAD_RESPONSE,
      'the daemon returned malformed JSON; the body was not reinterpreted or truncated into something parseable',
      { status: response.status },
    );
  }
  return { status: response.status, body };
}
