/**
 * pagination.test.js — the cursor walk: what the CLI sends, where it stops, and how it
 * refuses to spin.
 *
 * The feature has one shape and three hazards, so the cases are grouped that way:
 *
 * 1. **Shape.** A cursor is opaque. The only things asserted about one are that it is
 *    sent byte-for-byte, that it appears exactly once as `&cursor=`, and that it is never
 *    decoded, re-signed or "repaired". No case here inspects its internals, because the
 *    CLI must not either.
 * 2. **Termination.** Three ways a walk could fail to end, each with its own guard: a
 *    repeated cursor (loop), a page that claims more while returning nothing (no
 *    progress), and a list longer than the operator meant to read (page cap). The first
 *    two are `BAD_RESPONSE`; the third is a *successful* truncated read, because the data
 *    is real and the client simply stopped at a bound it was given.
 * 3. **Failure paths.** 401, 403, timeout and daemon-offline must behave the same on the
 *    second page of a walk as on the first, and a walk that fails halfway must not print
 *    the rows it already had as if the read had succeeded.
 *
 * Every mock is a real loopback server (`helpers.startMock`) and every body comes from
 * `mock-transport.js`, so no case can reach a daemon, a token or a database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLI_CODES, CLI_EXIT } from '../../apps/cli/src/errors.js';
import { CURSOR_MAX_LENGTH, isReadOnlyPath } from '../../apps/cli/src/routes.js';
import {
  alertRow,
  alertsPage,
  analysisPage,
  analysisRow,
  cursorToken,
} from './mock-transport.js';
import {
  findClosedPort,
  makeTempDir,
  parseJsonOutput,
  respondJson,
  runCli,
  runInProcess,
  startMock,
  writeClientConfig,
} from './helpers.js';

/** Cursors used across cases; each one names the page that follows it. */
const C2 = cursorToken('p2');
const C3 = cursorToken('p3');
const C4 = cursorToken('p4');

/**
 * Build alert rows with the given ids.
 *
 * @param {readonly string[]} ids Alert identifiers.
 * @returns {object[]} Alert rows.
 */
function alertRows(ids) {
  return ids.map((id) => alertRow({ alert_id: id }));
}

/**
 * Serve a list of pages keyed by the cursor that requests them.
 *
 * `start` is the key for a request with no cursor, so a plan reads like the chain a daemon
 * would actually produce: `start → C2 → C3`. An unknown cursor is answered with the
 * contract's `CURSOR_INVALID` rather than a page, which is what a real daemon does after a
 * token rotation — and it means a test that walks one page too far fails loudly instead of
 * receiving a duplicate body.
 *
 * @param {(rows: object[], page: object) => object} build Envelope builder.
 * @param {Record<string, {rows: object[], has_more?: boolean, next_cursor?: string|null, limit?: number}>} plan Pages.
 * @returns {(request: object, res: import('node:http').ServerResponse) => void} Handler.
 */
function pager(build, plan) {
  return (request, res) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const cursor = url.searchParams.get('cursor');
    const entry = plan[cursor === null ? 'start' : cursor];
    if (entry === undefined) {
      respondJson(res, 400, { error: { code: 'CURSOR_INVALID', message: 'unknown cursor' } });
      return;
    }
    // Echo the page size that was actually requested (contract §5: `page.limit` is "the
    // page size in force for this page", i.e. the request value). A fixture that always
    // reported its own row count would never exercise the echo, and would let a client
    // that mislabelled the page size pass every case here.
    const requested = Number(url.searchParams.get('limit') ?? '50');
    respondJson(res, 200, build(entry.rows, {
      limit: entry.limit ?? requested,
      has_more: entry.has_more === true,
      next_cursor: entry.next_cursor ?? null,
    }));
  };
}

/**
 * Write a client configuration pointing at one mock.
 *
 * @param {{port: number}} mock Mock handle.
 * @param {object} [overrides] Extra configuration values.
 * @returns {{configPath: string, token: string, directory: string}} Paths.
 */
function configFor(mock, overrides = {}) {
  const directory = makeTempDir();
  const written = writeClientConfig(directory, { port: mock.port, ...overrides });
  return { configPath: written.configPath, token: written.token, directory };
}

/** A three-page alerts plan: two rows, two rows, one row. */
const THREE_PAGES = Object.freeze({
  start: { rows: alertRows(['a1', 'a2']), has_more: true, next_cursor: C2 },
  [C2]: { rows: alertRows(['a3', 'a4']), has_more: true, next_cursor: C3 },
  [C3]: { rows: alertRows(['a5']), has_more: false, next_cursor: null },
});

describe('M7 pagination: the cursor is opaque and travels unchanged', () => {
  it('sends --cursor as one &cursor= parameter, byte for byte, after ?limit=', async () => {
    const mock = await startMock(pager(alertsPage, {
      [C2]: { rows: alertRows(['a3']), has_more: false },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--limit', '7', '--cursor', C2, '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.equal(mock.requests.length, 1);
      // Exact target: no percent-encoding (every cursor character is URL-unreserved), no
      // extra parameters, no reordering. A client that "normalised" the cursor here would
      // break the MAC on the daemon side and get CURSOR_INVALID for a cursor it was given.
      assert.equal(mock.requests[0].url, `/api/v1/alerts?limit=7&cursor=${C2}`);
      assert.equal(mock.requests[0].method, 'GET');
    } finally {
      await mock.close();
    }
  });

  it('accepts a cursor at exactly the 512-character ceiling and refuses 513', async () => {
    // The bound is the contract's, so both sides of it are worth pinning: an off-by-one
    // here rejects a legal cursor or sends one the daemon answers with 400.
    const longest = 'a'.repeat(512);
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([])));
    const { configPath } = configFor(mock);
    try {
      const accepted = await runInProcess(['alerts', '--cursor', longest, '--config', configPath]);
      assert.equal(accepted.code, CLI_EXIT.OK);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].url, `/api/v1/alerts?limit=50&cursor=${longest}`);

      const refused = await runInProcess(['alerts', '--cursor', `${longest}a`, '--config', configPath]);
      assert.equal(refused.code, CLI_EXIT.USAGE);
      assert.match(refused.stderr, /512/u);
      assert.equal(mock.requests.length, 1, 'a rejected cursor must not reach the daemon');
    } finally {
      await mock.close();
    }
  });

  it('accepts a cursor containing ".." instead of mistaking it for a traversal segment', async () => {
    // A cursor is opaque and its alphabet admits `.`, so `a..b` is a legal cursor. The
    // path-traversal guard runs on the path *before* the query for exactly this reason:
    // checking the whole target would refuse a cursor the daemon issued, and only for the
    // unlucky tokens that happen to contain a double dot.
    const cursor = 'a..b';
    const mock = await startMock(pager(alertsPage, {
      [cursor]: { rows: alertRows(['a9']), has_more: false },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--cursor', cursor, '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK, result.stderr);
      assert.equal(mock.requests[0].url, `/api/v1/alerts?limit=50&cursor=a..b`);
    } finally {
      await mock.close();
    }
  });

  it('refuses every malformed --cursor before it opens a connection', async () => {
    // Each value is wrong for a different reason: empty, whitespace, a path separator, a
    // query separator, a fragment, a percent-escape, non-ASCII, and one character too
    // long. All of them are `USAGE` and none of them may reach the daemon — the whole
    // point of validating locally is that a bad cursor costs exit 2, not a 400 and a
    // guess about which parameter the daemon disliked.
    const values = ['', 'a b', 'a/b', 'a?b=c', 'a#b', 'a%2Fb', '中文', 'a\nb', `${'z'.repeat(513)}`];
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([])));
    const { configPath } = configFor(mock);
    try {
      for (const value of values) {
        const result = await runInProcess(['alerts', '--cursor', value, '--json', '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.USAGE, `--cursor ${JSON.stringify(value)}`);
        const document = parseJsonOutput(result.stdout);
        assert.equal(document.ok, false);
        assert.equal(document.error.code, CLI_CODES.USAGE);
        assert.equal(document.error.exit_code, CLI_EXIT.USAGE);
      }
      assert.equal(mock.requests.length, 0, 'no rejected cursor may reach the daemon');
    } finally {
      await mock.close();
    }
  });
});

describe('M7 pagination: the route table admits exactly one cursor form', () => {
  it('accepts `?limit=N&cursor=C` and refuses every other arrangement', () => {
    // The route table is the boundary that makes a cursor safe to concatenate, so the
    // negative half matters more than the positive one: a form that slipped through here
    // would be a target the client can build with caller-influenced text in it.
    const accepted = [
      '/api/v1/alerts?limit=1&cursor=a',
      '/api/v1/analysis?limit=100&cursor=djF.cGFnZS1wMg',
      `/api/v1/alerts?limit=50&cursor=${'a'.repeat(CURSOR_MAX_LENGTH)}`,
      '/api/v1/alerts?limit=5&cursor=a..b',
    ];
    const refused = [
      '/api/v1/alerts?limit=5&cursor=',            // empty value
      '/api/v1/alerts?limit=5&cursor=a/b',         // path separator
      '/api/v1/alerts?limit=5&cursor=a%2Fb',       // percent-escape
      '/api/v1/alerts?limit=5&cursor=a b',         // whitespace
      '/api/v1/alerts?limit=5&cursor=a&x=1',       // a second parameter
      '/api/v1/alerts?limit=5&cursor=a&limit=6',   // a repeated parameter
      '/api/v1/alerts?cursor=a&limit=5',           // cursor before limit
      '/api/v1/alerts?limit=5&cursor',             // no `=`
      '/api/v1/alerts?limit=5&cursor=a#f',         // fragment
      `/api/v1/alerts?limit=5&cursor=${'a'.repeat(CURSOR_MAX_LENGTH + 1)}`,
      '/api/v1/status?limit=5&cursor=a',           // not a list route
    ];
    for (const path of accepted) {
      assert.equal(isReadOnlyPath(path), true, `expected to accept ${path.slice(0, 60)}`);
    }
    for (const path of refused) {
      assert.equal(isReadOnlyPath(path), false, `expected to refuse ${path.slice(0, 60)}`);
    }
  });
});

describe('M7 pagination: following next_cursor', () => {
  it('--all walks three pages into one view, in order, with one request per page', async () => {
    const mock = await startMock(pager(alertsPage, THREE_PAGES));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--limit', '2', '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, true);

      assert.deepEqual(
        mock.requests.map((request) => request.url),
        [
          '/api/v1/alerts?limit=2',
          `/api/v1/alerts?limit=2&cursor=${C2}`,
          `/api/v1/alerts?limit=2&cursor=${C3}`,
        ],
        'each page is fetched once, in the order the cursors chain',
      );

      assert.deepEqual(document.data.items.map((item) => item.alert_id), ['a1', 'a2', 'a3', 'a4', 'a5']);
      assert.equal(document.data.returned, 5, 'returned counts the whole walk, not the last page');
      assert.equal(document.data.pages, 3);
      assert.equal(document.data.has_more, false, 'the last page ends the list');
      assert.equal(document.data.next_cursor, null);
      assert.equal(document.data.truncated, false);
      assert.equal(document.data.limit, 2);
    } finally {
      await mock.close();
    }
  });

  it('--all continues from a --cursor that was printed by an earlier run', async () => {
    // The handoff that makes the printed note useful: page one is read by one invocation,
    // page two by the next one, and the result is the same two rows a single --all would
    // have produced. Only `pages` differs, because it counts this invocation's requests.
    const mock = await startMock(pager(alertsPage, {
      [C3]: { rows: alertRows(['a5']), has_more: false },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--cursor', C3, '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.deepEqual(document.data.items.map((item) => item.alert_id), ['a5']);
      assert.equal(document.data.pages, 1);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].url, `/api/v1/alerts?limit=50&cursor=${C3}`);
    } finally {
      await mock.close();
    }
  });

  it('--all sends one request when the first page is already the last', async () => {
    const mock = await startMock(pager(alertsPage, {
      start: { rows: alertRows(['a1']), has_more: false },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.data.pages, 1);
      assert.equal(document.data.has_more, false);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });

  it('walks the analysis list too, with its own envelope key and ordering literal', async () => {
    const mock = await startMock(pager(analysisPage, {
      start: { rows: [analysisRow({ analysis_id: 'j1' })], has_more: true, next_cursor: C2 },
      [C2]: { rows: [analysisRow({ analysis_id: 'j2' })], has_more: false, next_cursor: null },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['analysis', '--limit', '1', '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.deepEqual(document.data.items.map((item) => item.analysis_id), ['j1', 'j2']);
      assert.equal(document.data.order, 'created_at_desc');
      assert.equal(document.data.pages, 2);
      assert.deepEqual(mock.requests.map((request) => request.url), [
        '/api/v1/analysis?limit=1',
        `/api/v1/analysis?limit=1&cursor=${C2}`,
      ]);
    } finally {
      await mock.close();
    }
  });

  it('prints the cursor line for the analysis list too', async () => {
    // The two renderers share `moreRowsNote` but not their table, so a cursor line added to
    // one of them is invisible to a test of the other. This is the analysis half.
    const mock = await startMock(pager(analysisPage, {
      start: { rows: [analysisRow({ analysis_id: 'j1' })], has_more: true, next_cursor: C2 },
      [C2]: { rows: [analysisRow({ analysis_id: 'j2' })], has_more: false },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['analysis', '--limit', '1', '--all', '--max-pages', '1', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.match(result.stdout, /truncated=yes/u);
      assert.match(result.stdout, /continue with the same command plus --cursor/u);
      assert.match(result.stdout, new RegExp(`^cursor\\s+${C2.replace('.', '\\.')}$`, 'mu'));
      assert.equal(mock.requests.length, 1, '--max-pages 1 means one request');
    } finally {
      await mock.close();
    }
  });
});

describe('M7 pagination: the walk always terminates', () => {
  it('refuses a repeated cursor instead of looping, and stops after the repeat', async () => {
    // `C2` hands back `C2`: the daemon is asking to be asked the same question forever.
    // The bound matters as much as the error — a client that detected the loop only by a
    // page cap would still have sent maxPages requests first.
    const mock = await startMock(pager(alertsPage, {
      start: { rows: alertRows(['a1']), has_more: true, next_cursor: C2 },
      [C2]: { rows: alertRows(['a2']), has_more: true, next_cursor: C2 },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--all', '--max-pages', '50', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.code, CLI_CODES.BAD_RESPONSE);
      assert.equal(document.error.field, 'page.next_cursor');
      assert.equal(document.error.reason, 'PAGINATION_LOOP');
      assert.equal(mock.requests.length, 2, 'the repeat is detected on the page that repeats it');
    } finally {
      await mock.close();
    }
  });

  it('detects a two-cycle (A → B → A) as well as an immediate echo', async () => {
    // A set, not a "last cursor" comparison: `A → B → A` is just as infinite as `A → A`,
    // and a client that only compared against the previous cursor would never see it.
    const mock = await startMock(pager(alertsPage, {
      start: { rows: alertRows(['a1']), has_more: true, next_cursor: C2 },
      [C2]: { rows: alertRows(['a2']), has_more: true, next_cursor: C3 },
      [C3]: { rows: alertRows(['a3']), has_more: true, next_cursor: C2 },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--all', '--max-pages', '50', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      assert.equal(parseJsonOutput(result.stdout).error.reason, 'PAGINATION_LOOP');
      assert.equal(mock.requests.length, 3, 'start, C2, C3 — the fourth would repeat C2');
    } finally {
      await mock.close();
    }
  });

  it('reports a repeated cursor as a loop even when it happens on the last allowed page', async () => {
    // The verdict on a broken response must not depend on `--max-pages`. With the cap
    // checked first, this exact payload would read as a clean truncation at
    // `--max-pages 2` and as a loop at `--max-pages 3` — the same daemon, two answers.
    const mock = await startMock(pager(alertsPage, {
      start: { rows: alertRows(['a1']), has_more: true, next_cursor: C2 },
      [C2]: { rows: alertRows(['a2']), has_more: true, next_cursor: C2 },
    }));
    const { configPath } = configFor(mock);
    try {
      for (const cap of ['2', '3']) {
        const result = await runInProcess(['alerts', '--all', '--max-pages', cap, '--json', '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.BAD_RESPONSE, `--max-pages ${cap}`);
        assert.equal(parseJsonOutput(result.stdout).error.reason, 'PAGINATION_LOOP');
      }
      assert.equal(mock.requests.length, 4, 'two invocations, two requests each');
    } finally {
      await mock.close();
    }
  });

  it('refuses a page that claims more rows while returning none', async () => {
    // A zero-row page cannot advance anything but the cursor value, so following it is a
    // loop with extra steps. Contract §9 forbids the shape (a byte-limited page keeps at
    // least one row), so it is a broken response rather than a slow one.
    const mock = await startMock(pager(alertsPage, {
      start: { rows: alertRows(['a1']), has_more: true, next_cursor: C2 },
      [C2]: { rows: [], has_more: true, next_cursor: C3 },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.error.reason, 'PAGINATION_NO_PROGRESS');
      assert.equal(document.error.field, 'page.returned');
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });

  it('refuses a row id that appears on two pages, rather than double-counting it', async () => {
    // Contract §10.1: keyset paging can *skip* an alert that was merged during the walk,
    // but it can never return one twice. A duplicate therefore means the paging is broken,
    // and concatenating it would double every count derived from the output.
    const mock = await startMock(pager(alertsPage, {
      start: { rows: alertRows(['a1', 'a2']), has_more: true, next_cursor: C2 },
      [C2]: { rows: alertRows(['a2', 'a3']), has_more: true, next_cursor: C3 },
      [C3]: { rows: alertRows(['a4']), has_more: false },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.error.reason, 'PAGINATION_DUPLICATE');
      assert.equal(document.error.field, 'alert_id');
      assert.equal(mock.requests.length, 2, 'refused on the page that repeats the id');
    } finally {
      await mock.close();
    }
  });

  it('does not mistake two legal ids that sanitize alike for a duplicate row', async () => {
    // Contract §4.4 admits any printable ASCII as an id, and projection collapses runs of
    // whitespace, so `"a  b"` and `"a b"` are two different stored rows that render the
    // same. Comparing the *projected* ids would refuse this page pair as a duplicate and
    // reject perfectly valid data, so the guard compares the raw key.
    const mock = await startMock(pager(alertsPage, {
      start: { rows: alertRows(['a  b']), has_more: true, next_cursor: C2 },
      [C2]: { rows: alertRows(['a b']), has_more: false },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK, result.stdout);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.data.items.length, 2);
      assert.equal(document.data.pages, 2);
      // Both render as `a b`; the distinction lives in the raw key, which is the point.
      assert.deepEqual(document.data.items.map((item) => item.alert_id), ['a b', 'a b']);
    } finally {
      await mock.close();
    }
  });

  it('stops at --max-pages and reports the truncation instead of pretending the list ended', async () => {
    // A capped walk is not a failure: the rows are real and the operator asked for a
    // bound. But `has_more` stays true and the cursor is still handed over, because the
    // one thing this must never do is look like a complete read.
    const mock = await startMock(pager(alertsPage, THREE_PAGES));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess([
        'alerts', '--limit', '2', '--all', '--max-pages', '2', '--json', '--config', configPath,
      ]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.data.pages, 2);
      assert.equal(document.data.truncated, true, 'the walk stopped short of the end');
      assert.equal(document.data.has_more, true, 'the daemon still has more');
      assert.equal(document.data.next_cursor, C3, 'the cursor to resume from is handed over');
      assert.deepEqual(document.data.items.map((item) => item.alert_id), ['a1', 'a2', 'a3', 'a4']);
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });

  it('does not mark a walk truncated when the cap lands exactly on the last page', async () => {
    // `truncated` answers "was there more that I did not read", not "did I hit the cap".
    // A three-page list read with --max-pages 3 is complete, and calling it truncated
    // would send an operator chasing a cursor that does not exist.
    const mock = await startMock(pager(alertsPage, THREE_PAGES));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess([
        'alerts', '--limit', '2', '--all', '--max-pages', '3', '--json', '--config', configPath,
      ]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.data.pages, 3);
      assert.equal(document.data.truncated, false);
      assert.equal(document.data.has_more, false);
      assert.equal(document.data.next_cursor, null);
    } finally {
      await mock.close();
    }
  });

  it('hands over the cursor to resume from when the walk is cut short', async () => {
    const mock = await startMock(pager(alertsPage, THREE_PAGES));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli([
        'alerts', '--limit', '2', '--all', '--max-pages', '2', '--config', configPath,
      ]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.match(result.stdout, /truncated=yes/u);
      assert.match(result.stdout, /pages=2/u);
      assert.match(result.stdout, /--max-pages/u);
      // The advice is the *delta* — add `--cursor` to the command you just ran — and the
      // value gets its own line. A printed full command line would have to guess at
      // `--config`/`--timeout`, and a wrong guess is a paste that exits 3; the flag the
      // operator typed is already in their history, the cursor is the only thing missing.
      assert.match(result.stdout, /continue with the same command plus --cursor/u);
      assert.match(result.stdout, new RegExp(`^cursor\\s+${C3.replace('.', '\\.')}$`, 'mu'));
      // The value printed is the one the daemon sent, unchanged and complete.
      assert.ok(result.stdout.includes(C3), `expected the resume cursor ${C3} in:\n${result.stdout}`);
    } finally {
      await mock.close();
    }
  });
});

describe('M7 pagination: paging flags are refused where they mean nothing', () => {
  it('refuses --max-pages without --all, because there is no walk to bound', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([])));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--max-pages', '2', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.USAGE);
      const document = parseJsonOutput(result.stdout);
      assert.match(document.error.message, /--max-pages/u);
      assert.match(document.error.message, /--all/u);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });

  it('refuses an out-of-range or non-canonical --max-pages', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([])));
    const { configPath } = configFor(mock);
    try {
      for (const value of ['0', '101', '-1', '1e1', '2.0', '', 'abc']) {
        const result = await runInProcess(['alerts', '--all', '--max-pages', value, '--json', '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.USAGE, `--max-pages ${JSON.stringify(value)}`);
        assert.equal(parseJsonOutput(result.stdout).error.code, CLI_CODES.USAGE);
      }
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });

  it('refuses every paging flag in analysis detail mode, before loading a configuration', async () => {
    // Detail mode is one document with no page. A flag that is accepted and then dropped
    // is worse than one that is refused: the caller believes a bound was applied.
    const absent = makeTempDir();
    const cases = [
      ['--limit', '5'],
      ['--cursor', C2],
      ['--all'],
      ['--max-pages', '2'],
    ];
    for (const [flag, value] of cases) {
      const argv = value === undefined
        ? ['analysis', 'job-7f3a', flag, '--config', `${absent}/absent.json`]
        : ['analysis', 'job-7f3a', flag, value, '--config', `${absent}/absent.json`];
      const result = await runInProcess([...argv, '--json']);
      assert.equal(result.code, CLI_EXIT.USAGE, `${flag} in detail mode`);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.error.code, CLI_CODES.USAGE);
      assert.match(document.error.message, /detail mode/u);
      // Exit 2 rather than exit 3 proves the flag was refused before the config was read.
      assert.notEqual(result.code, CLI_EXIT.CONFIG);
    }
  });

  it('refuses paging flags on a command with no list', async () => {
    for (const argv of [
      ['status', '--cursor', C2],
      ['status', '--all'],
      ['health', '--max-pages', '2'],
      ['status', '--all', '--max-pages', '2'],
    ]) {
      const result = await runInProcess([...argv, '--json']);
      assert.equal(result.code, CLI_EXIT.USAGE, argv.join(' '));
      const document = parseJsonOutput(result.stdout);
      assert.match(document.error.message, /only accepted by alerts and analysis/u);
    }
  });
});

describe('M7 pagination: failures behave the same on page two', () => {
  it('keeps the daemon\'s offending parameter name in the error, and only as a name', async () => {
    // Contract §8 puts the first offending parameter in `details.parameter`. That name is
    // the whole diagnosis, so dropping it leaves "one of the two was refused". It is
    // still filtered: a name that is not a parameter-shaped identifier is discarded rather
    // than echoed, so a hostile envelope cannot put arbitrary text on the terminal. The
    // contract's own `"<unknown>"` sentinel is a fixed literal, not caller text, and is
    // admitted on purpose.
    const hostile = 'a'.repeat(200);
    let details = { parameter: 'offset' };
    const mock = await startMock((request, res) => respondJson(res, 400, {
      error: { code: 'QUERY_INVALID', message: 'query parameter is not accepted', details },
    }));
    const { configPath } = configFor(mock);
    try {
      const named = await runInProcess(['alerts', '--limit', '5', '--json', '--config', configPath]);
      assert.equal(named.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(named.stdout);
      assert.equal(document.error.parameter, 'offset');
      assert.match(document.error.message, /"offset"/u);
      assert.equal(document.error.daemon_code, 'QUERY_INVALID');

      // A value that is not a parameter name: dropped, not echoed.
      details = { parameter: hostile };
      const dropped = await runInProcess(['alerts', '--limit', '5', '--json', '--config', configPath]);
      assert.equal(dropped.code, CLI_EXIT.BAD_RESPONSE);
      const second = parseJsonOutput(dropped.stdout);
      assert.equal(Object.hasOwn(second.error, 'parameter'), false);
      assert.equal(dropped.stdout.includes(hostile), false);

      // The contract's sentinel for "your name was too long to echo" survives.
      details = { parameter: '<unknown>' };
      const sentinel = await runInProcess(['alerts', '--limit', '5', '--json', '--config', configPath]);
      assert.equal(sentinel.code, CLI_EXIT.BAD_RESPONSE);
      assert.equal(parseJsonOutput(sentinel.stdout).error.parameter, '<unknown>');
    } finally {
      await mock.close();
    }
  });

  it('maps a rejected cursor (400 CURSOR_INVALID) to a message that says to drop it', async () => {
    // Contract §4.3: the cursor MAC is derived from the token, so a rotated token
    // invalidates every cursor. The recovery is not "retry" — it is "start over".
    const mock = await startMock((request, res) => respondJson(res, 400, {
      error: { code: 'CURSOR_INVALID', message: 'cursor is not valid', details: { reason: 'signature' } },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--cursor', C2, '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.error.daemon_code, 'CURSOR_INVALID');
      assert.equal(document.error.status, 400);
      assert.match(document.error.message, /drop --cursor/u);
    } finally {
      await mock.close();
    }
  });

  it('a 401 on the second page exits 5 and prints no partial page', async () => {
    // The half-read rows must not be rendered as a result: a script that saw exit 0 and
    // four rows would believe it had the whole list.
    const mock = await startMock((request, res) => {
      const cursor = new URL(request.url, 'http://127.0.0.1').searchParams.get('cursor');
      if (cursor === null) {
        respondJson(res, 200, alertsPage(alertRows(['a1', 'a2']), {
          limit: 2,
          has_more: true,
          next_cursor: C2,
        }));
        return;
      }
      respondJson(res, 401, { error: { code: 'AUTH_FAILED', message: 'token rotated' } });
    });
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--limit', '2', '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.AUTH);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.data, undefined, 'no partial rows on a failed walk');
      assert.equal(document.error.code, CLI_CODES.AUTH);
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });

  it('a 403 on the second page exits 6 and prints no partial page', async () => {
    const mock = await startMock((request, res) => {
      const cursor = new URL(request.url, 'http://127.0.0.1').searchParams.get('cursor');
      if (cursor === null) {
        respondJson(res, 200, alertsPage(alertRows(['a1']), { limit: 1, has_more: true, next_cursor: C2 }));
        return;
      }
      respondJson(res, 403, { error: { code: 'PEER_REJECTED', message: 'not loopback' } });
    });
    const { configPath } = configFor(mock);
    try {
      const result = await runInProcess(['alerts', '--limit', '1', '--all', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.FORBIDDEN);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.data, undefined);
      assert.equal(document.error.daemon_code, 'PEER_REJECTED');
    } finally {
      await mock.close();
    }
  });

  it('a stalled second page hits the deadline and exits 7', async () => {
    let held = null;
    const mock = await startMock((request, res) => {
      const cursor = new URL(request.url, 'http://127.0.0.1').searchParams.get('cursor');
      if (cursor === null) {
        respondJson(res, 200, alertsPage(alertRows(['a1']), { limit: 1, has_more: true, next_cursor: C2 }));
        return;
      }
      held = res;
    });
    const { configPath } = configFor(mock, { timeoutMs: 150 });
    try {
      const started = Date.now();
      const result = await runInProcess(['alerts', '--limit', '1', '--all', '--json', '--config', configPath]);
      const elapsed = Date.now() - started;
      assert.equal(result.code, CLI_EXIT.TIMEOUT);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.data, undefined);
      // One deadline per request, not one for the whole walk: the first page answered
      // instantly, so a 150 ms ceiling on the walk would also have produced 7 — the bound
      // below is what separates "the second request timed out" from "the first one did".
      assert.ok(elapsed < 1500, `expected the configured 150 ms deadline, waited ${elapsed} ms`);
      assert.equal(mock.requests.length, 2);
    } finally {
      held?.destroy();
      await mock.close();
    }
  });

  it('--all against a closed port exits 4 without inventing an empty list', async () => {
    const port = await findClosedPort();
    const { configPath } = configFor({ port });
    const result = await runInProcess(['alerts', '--all', '--json', '--config', configPath]);
    assert.equal(result.code, CLI_EXIT.UNREACHABLE);
    const document = parseJsonOutput(result.stdout);
    assert.equal(document.ok, false);
    assert.equal(document.data, undefined);
    assert.equal(document.error.code, CLI_CODES.UNREACHABLE);
  });
});
