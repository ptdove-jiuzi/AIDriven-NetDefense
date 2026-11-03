/**
 * acceptance.test.js — the M7 acceptance matrix for `alerts` and `analysis`.
 *
 * Every case runs the real CLI as a child process against a loopback mock built from
 * `helpers.js`, and the response bodies come from `mock-transport.js` — the one file that
 * holds the published shapes from `docs/implementation/M7_API_CONTRACT.md` §5/§6. The
 * assertions are about what an operator or a script observes: the exit status, the single
 * `--json` document, the exact request the client sent, and the bytes that did *not*
 * reach the terminal.
 *
 * Three habits worth naming, because they are what make these cases able to fail:
 *
 * 1. Every mock is asserted to have received the request count the case claims, so
 *    "refused before the network" cannot pass by accident on a case that meant to send.
 * 2. Terminal-safety cases assert the sanitised *value* (`proc.evil`, not just "output is
 *    non-empty") and then assert the raw control characters are absent from the captured
 *    string, in both output modes.
 * 3. Shape cases assert the exact key set. "The field is present" would still pass if a
 *    forbidden field (§7) or a dropped one (§6) slipped in.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLI_CODES, CLI_EXIT } from '../../apps/cli/src/errors.js';
import {
  ALERT_FIELDS,
  ALERT_ORDER,
  ALERT_ROWS,
  ANALYSIS_FIELDS,
  ANALYSIS_ORDER,
  ANALYSIS_ROWS,
  alertRow,
  alertsPage,
  analysisDetail,
  analysisPage,
  analysisRow,
  FORBIDDEN_CHARS,
  hostileAlertRow,
  oversizedAlertsPage,
  page,
} from './mock-transport.js';
import {
  findClosedPort,
  makeTempDir,
  parseJsonOutput,
  respondJson,
  respondRaw,
  runCli,
  startMock,
  writeClientConfig,
} from './helpers.js';

/** A detail id that exists in `ANALYSIS_ROWS`. */
const JOB_ID = ANALYSIS_ROWS[0].analysis_id;

/**
 * The exact keys of a list view.
 *
 * `next_cursor` is part of the view because the CLI can now send one back: it is the only
 * handle on the next page, so `--json` has to carry it or a script cannot continue a read
 * that the human renderer prints a command for. `pages` and `truncated` are the walk's own
 * accounting and are always present (1 and `false` for a single-page read) so a consumer
 * never has to distinguish "absent" from "not applicable".
 */
const LIST_VIEW_FIELDS = [
  'limit',
  'returned',
  'has_more',
  'byte_limited',
  'order',
  'pages',
  'truncated',
  'next_cursor',
  'items',
];

/**
 * Write a client configuration pointed at one mock.
 *
 * A fresh temporary directory per call keeps cases independent: a case that accidentally
 * wrote a file could not be hidden by the next case reusing the same directory.
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

/**
 * Assert a captured stream carries none of the sequences a terminal would act on.
 *
 * @param {string} text Captured stdout or stderr.
 * @param {string} label Which stream, for the failure message.
 * @returns {void}
 */
function assertNoControlChars(text, label) {
  for (const character of FORBIDDEN_CHARS) {
    assert.equal(
      text.includes(character),
      false,
      `${label} must not carry ${JSON.stringify(character)}; got ${JSON.stringify(text)}`,
    );
  }
}

describe('M7 acceptance: --json contract', () => {
  it('alerts --json emits exactly one document with the page counters and the whitelisted rows', async () => {
    // The first row carries an evidence id array (§7 says it must not leave the daemon)
    // whose length, 3, is deliberately *not* its `evidence_count`, 5. If the two agreed, a
    // client that counted the array would print the expected number and this case would
    // stay green. Do not "tidy" them back to equality.
    const poisonedFirst = { ...ALERT_ROWS[0], evidence_count: 5, event_ids: ['e1', 'e2', 'e3'] };
    const rows = [poisonedFirst, ALERT_ROWS[1]];
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage(rows, { limit: 10 })));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--limit', '10', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, true);
      assert.equal(document.command, 'alerts');
      assert.equal(document.schema_version, '1.0');

      // The view is the whole `page` accounting plus the rows. Nothing else.
      assert.deepEqual(Object.keys(document.data).sort(), [...LIST_VIEW_FIELDS].sort());
      // A single page is the whole walk, and the walk ended: `null` is the contract's
      // spelling of "no continuation", and the key is present so a consumer can read it
      // without an `in` check.
      assert.equal(Object.hasOwn(document.data, 'next_cursor'), true);
      assert.equal(document.data.next_cursor, null);
      assert.equal(document.data.pages, 1, 'one request is one page');
      assert.equal(document.data.truncated, false, 'nothing was cut by a page cap');
      assert.equal(result.stdout.includes('e1'), false, 'not even an evidence id from a row that sent one');
      assert.equal(document.data.limit, 10, 'limit is the daemon page limit, echoed as sent');
      assert.equal(document.data.returned, 2, 'returned comes from page.returned, not from items.length');
      assert.equal(document.data.has_more, false);
      assert.equal(document.data.byte_limited, false);
      assert.equal(document.data.order, ALERT_ORDER);
      assert.equal(document.data.items.length, 2);

      const [first, second] = document.data.items;
      // Contract §6.1 is a whitelist: exactly these twelve fields, no more.
      assert.deepEqual(Object.keys(first).sort(), [...ALERT_FIELDS].sort());
      assert.equal(Object.hasOwn(first, 'event_ids'), false, 'event_ids never leaves the daemon (§7)');
      assert.equal(first.alert_id, ALERT_ROWS[0].alert_id);
      assert.equal(first.rule_id, 'proc.suspicious-start');
      assert.equal(first.rule_version, '1.4.0');
      assert.equal(first.count, 3);
      // The row's own field, not event_ids.length (3): the two differ on purpose.
      assert.equal(first.evidence_count, 5);
      assert.equal(first.evidence_truncated, false);
      assert.equal(first.window_start, '2026-11-02T10:00:00.000Z');
      assert.equal(first.window_end, '2026-11-02T10:05:00.000Z');
      assert.equal(second.alert_id, ALERT_ROWS[1].alert_id);
      assert.equal(second.evidence_truncated, true);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });

  it('alerts --json keeps evidence_count null when the field is absent instead of counting event_ids', async () => {
    // `item.evidence_count ?? item.event_ids?.length` is invisible to every case where the
    // two numbers agree, so this row sends the array and no count: null is the honest
    // projection, 3 is what a client reading §7-forbidden ids would print.
    const { evidence_count: _omitted, ...base } = ALERT_ROWS[0];
    const row = { ...base, event_ids: ['e1', 'e2', 'e3'] };
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([row], { limit: 10 })));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--limit', '10', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.data.items.length, 1);
      assert.equal(document.data.items[0].evidence_count, null);
      assert.equal(result.stdout.includes('e1'), false);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });

  it('analysis --json emits exactly one document for the list', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, analysisPage(ANALYSIS_ROWS, { limit: 10 })));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['analysis', '--limit', '10', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, true);
      assert.equal(document.command, 'analysis');
      assert.equal(document.schema_version, '1.0');
      assert.deepEqual(Object.keys(document.data).sort(), [...LIST_VIEW_FIELDS].sort());
      assert.equal(document.data.limit, 10);
      assert.equal(document.data.returned, 2);
      assert.equal(document.data.order, ANALYSIS_ORDER);
      assert.equal(document.data.next_cursor, null, 'a complete list has no continuation');
      assert.equal(document.data.pages, 1);

      const [first, second] = document.data.items;
      assert.deepEqual(Object.keys(first).sort(), [...ANALYSIS_FIELDS].sort());
      assert.equal(first.analysis_id, ANALYSIS_ROWS[0].analysis_id);
      assert.equal(first.state, 'succeeded');
      assert.equal(first.budget_class, 'standard');
      assert.equal(first.attempts, 2);
      assert.equal(first.completed_at, '2026-11-02T10:07:30.000Z');
      assert.equal(first.report_available, true);
      assert.equal(second.analysis_id, ANALYSIS_ROWS[1].analysis_id);
      assert.equal(second.state, 'failed');
      assert.equal(second.budget_class, 'deep');
      assert.equal(second.completed_at, null, 'unknown completion time stays null, not a blank date');
      assert.equal(second.report_available, false);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });

  it('analysis <id> --json answers with the id that was asked for and the job body', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, analysisDetail()));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['analysis', JOB_ID, '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, true);
      assert.equal(document.command, 'analysis');
      assert.equal(document.data.id, JOB_ID);
      assert.equal(document.data.item.analysis_id, JOB_ID);
      assert.equal(document.data.item.state, 'succeeded');
      assert.equal(document.data.item.budget_class, 'standard');
      assert.equal(document.data.item.attempts, 2);
      assert.equal(document.data.item.report_available, true);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].url, `/api/v1/analysis/${JOB_ID}`);
    } finally {
      await mock.close();
    }
  });

  it('a 401 still produces exactly one JSON document, with the exit code inside it', async () => {
    const mock = await startMock((request, res) => respondJson(res, 401, {
      error: { code: 'AUTH_REQUIRED', message: 'token required' },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.AUTH);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.command, 'alerts');
      assert.equal(document.schema_version, '1.0');
      assert.equal(document.error.code, CLI_CODES.AUTH);
      assert.equal(document.error.exit_code, CLI_EXIT.AUTH);
      assert.equal(document.error.daemon_code, 'AUTH_REQUIRED');
      assert.equal(document.error.status, 401);
    } finally {
      await mock.close();
    }
  });
});

describe('M7 acceptance: page accounting', () => {
  it('refuses a list body with no page object instead of inventing the counters', async () => {
    // Contract §5: `page` is the only account of the page. A body without one is a
    // contract break, and rendering it as `returned=2 has_more=no` would invent both.
    const mock = await startMock((request, res) => respondJson(res, 200, { alerts: ALERT_ROWS }));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.code, CLI_CODES.BAD_RESPONSE);
      assert.equal(document.error.exit_code, CLI_EXIT.BAD_RESPONSE);
      assert.equal(document.error.field, 'page');
    } finally {
      await mock.close();
    }
  });

  it('refuses a non-integer page.returned', async () => {
    const mock = await startMock((request, res) => respondJson(
      res,
      200,
      alertsPage(ALERT_ROWS, { returned: 2.5 }),
    ));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.error.field, 'page.returned');
    } finally {
      await mock.close();
    }
  });

  it('refuses a non-boolean page.has_more', async () => {
    // `"yes"` is truthy, so a lenient reader would render `has_more=yes` from a daemon
    // that did not answer the question in the contract's type.
    const mock = await startMock((request, res) => respondJson(
      res,
      200,
      alertsPage(ALERT_ROWS, { has_more: 'yes' }),
    ));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.error.field, 'page.has_more');
    } finally {
      await mock.close();
    }
  });

  it('refuses a page.returned that disagrees with the rows it carries', async () => {
    const mock = await startMock((request, res) => respondJson(
      res,
      200,
      alertsPage(ALERT_ROWS, { returned: 3 }),
    ));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.error.field, 'page.returned');
      assert.equal(result.stdout.includes('"returned":3'), false, 'the false count must not be printed');
    } finally {
      await mock.close();
    }
  });

  it('applies the same page rules to the analysis list', async () => {
    // The two lists share one projection. One case here proves it is shared, so the four
    // alert cases above cannot pass while analysis quietly guesses.
    const mock = await startMock((request, res) => respondJson(res, 200, { analyses: ANALYSIS_ROWS }));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['analysis', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.error.field, 'page');
    } finally {
      await mock.close();
    }
  });
});

describe('M7 acceptance: stable exit codes', () => {
  it('alerts exits UNREACHABLE when nothing is listening', async () => {
    const port = await findClosedPort();
    const { configPath } = configFor({ port });
    const result = await runCli(['alerts', '--config', configPath]);
    assert.equal(result.code, CLI_EXIT.UNREACHABLE);
    assert.match(result.stderr, /UNREACHABLE/u);
    assert.equal(result.stdout, '');
  });

  it('analysis (list) exits UNREACHABLE when nothing is listening', async () => {
    const port = await findClosedPort();
    const { configPath } = configFor({ port });
    const result = await runCli(['analysis', '--config', configPath]);
    assert.equal(result.code, CLI_EXIT.UNREACHABLE);
    assert.match(result.stderr, /UNREACHABLE/u);
  });

  it('analysis <id> exits UNREACHABLE when nothing is listening', async () => {
    const port = await findClosedPort();
    const { configPath } = configFor({ port });
    const result = await runCli(['analysis', JOB_ID, '--config', configPath]);
    assert.equal(result.code, CLI_EXIT.UNREACHABLE);
    assert.match(result.stderr, /UNREACHABLE/u);
  });

  it('401 and 403 map to AUTH and FORBIDDEN on both lists and on the detail route', async () => {
    const cases = [
      { status: 401, exit: CLI_EXIT.AUTH, code: 'AUTH' },
      { status: 403, exit: CLI_EXIT.FORBIDDEN, code: 'FORBIDDEN' },
    ];
    const invocations = [['alerts'], ['analysis'], ['analysis', JOB_ID]];
    for (const expected of cases) {
      const mock = await startMock((request, res) => respondJson(res, expected.status, {
        error: { code: 'DENIED', message: 'refused' },
      }));
      try {
        const { configPath } = configFor(mock);
        for (const argv of invocations) {
          const result = await runCli([...argv, '--config', configPath]);
          assert.equal(
            result.code,
            expected.exit,
            `${argv.join(' ')} answered ${expected.status} must exit ${expected.exit}`,
          );
          assert.match(result.stderr, new RegExp(expected.code, 'u'));
          assert.equal(result.stdout, '');
        }
        assert.equal(mock.requests.length, 3);
      } finally {
        await mock.close();
      }
    }
  });

  it('500 maps to DAEMON_ERROR and 429 to RATE_LIMITED', async () => {
    const cases = [
      { status: 500, exit: CLI_EXIT.DAEMON_ERROR, code: 'DAEMON_ERROR' },
      { status: 429, exit: CLI_EXIT.RATE_LIMITED, code: 'RATE_LIMITED' },
    ];
    for (const expected of cases) {
      const mock = await startMock((request, res) => respondJson(res, expected.status, {
        error: { code: 'UPSTREAM' },
      }));
      try {
        const { configPath } = configFor(mock);
        for (const argv of [['alerts'], ['analysis']]) {
          const result = await runCli([...argv, '--config', configPath]);
          assert.equal(result.code, expected.exit, `${argv[0]} answered ${expected.status}`);
          assert.match(result.stderr, new RegExp(expected.code, 'u'));
        }
      } finally {
        await mock.close();
      }
    }
  });

  it('400 QUERY_INVALID is a bad response that keeps the daemon code', async () => {
    // Contract §3/§8: the query surface is closed, so a 400 here can only mean the page
    // size was refused. The CLI must not report "unexpected status 400" and drop the
    // daemon's own code — that is the one piece of information the operator can act on.
    const mock = await startMock((request, res) => respondJson(res, 400, {
      error: { code: 'QUERY_INVALID', message: 'query parameter is not accepted', details: { parameter: 'limit' } },
    }));
    const { configPath } = configFor(mock);
    try {
      const human = await runCli(['alerts', '--config', configPath]);
      assert.equal(human.code, CLI_EXIT.BAD_RESPONSE);
      assert.match(human.stderr, /BAD_RESPONSE/u);
      assert.equal(human.stdout, '');

      const json = await runCli(['alerts', '--json', '--config', configPath]);
      assert.equal(json.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(json.stdout);
      assert.equal(document.error.code, CLI_CODES.BAD_RESPONSE);
      assert.equal(document.error.exit_code, CLI_EXIT.BAD_RESPONSE);
      assert.equal(document.error.daemon_code, 'QUERY_INVALID');
      assert.equal(document.error.status, 400);
    } finally {
      await mock.close();
    }
  });

  it('503 STORE_UNAVAILABLE says the store is unavailable, not that there are no alerts', async () => {
    const mock = await startMock((request, res) => respondJson(res, 503, {
      error: { code: 'STORE_UNAVAILABLE', message: 'store is not open' },
    }));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.DAEMON_ERROR);
      assert.match(result.stderr, /DAEMON_ERROR/u);
      assert.match(result.stderr, /storage being unavailable does not mean there are no alerts/u);
      assert.equal(result.stdout, '', 'a storage failure must not render an empty page');
    } finally {
      await mock.close();
    }
  });

  it('404 and 405 are ENDPOINT_UNAVAILABLE, never an empty page with exit 0', async () => {
    const routes = [['alerts'], ['analysis'], ['analysis', JOB_ID]];
    for (const status of [404, 405]) {
      const mock = await startMock((request, res) => respondJson(res, status, { error: { code: 'NO_ROUTE' } }));
      try {
        const { configPath } = configFor(mock);
        for (const argv of routes) {
          const result = await runCli([...argv, '--config', configPath]);
          assert.equal(result.code, CLI_EXIT.UNSUPPORTED, `${argv.join(' ')} answered ${status}`);
          assert.match(result.stderr, /ENDPOINT_UNAVAILABLE/u);
          // The failure mode this guards: a fabricated `returned=0` page on stdout, which
          // is indistinguishable from "there is nothing to see".
          assert.equal(result.stdout, '', 'an unavailable endpoint must not render a page');
          assert.equal(result.stderr.includes('returned=0'), false);
        }
      } finally {
        await mock.close();
      }
    }
  });

  it('a detail body of {} is BAD_RESPONSE, not a job that cannot name itself', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, {}));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['analysis', JOB_ID, '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      assert.match(result.stderr, /BAD_RESPONSE/u);
      assert.equal(result.stdout, '');

      const json = await runCli(['analysis', JOB_ID, '--json', '--config', configPath]);
      assert.equal(json.code, CLI_EXIT.BAD_RESPONSE);
      const document = parseJsonOutput(json.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.code, CLI_CODES.BAD_RESPONSE);
      assert.equal(document.error.exit_code, CLI_EXIT.BAD_RESPONSE);
      assert.equal(document.error.field, 'analysis_id');
      // One refusal, one request: the identity check happens before projection.
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });
});

describe('M7 acceptance: deadline', () => {
  it('alerts times out against a socket that accepts and never answers', async () => {
    /** @type {import('node:http').ServerResponse|null} */
    let held = null;
    const mock = await startMock((request, res) => {
      held = res;
    });
    const { configPath } = configFor(mock, { timeoutMs: 150 });
    try {
      const started = Date.now();
      const result = await runCli(['alerts', '--config', configPath]);
      const elapsed = Date.now() - started;
      assert.equal(result.code, CLI_EXIT.TIMEOUT);
      assert.match(result.stderr, /TIMEOUT/u);
      // The configured deadline is 150 ms and the default is 5000 ms. A bound of 1500 ms
      // therefore distinguishes "the configuration was read" from "the default ran": the
      // old bound of 8000 ms passed even when `timeoutMs` was ignored entirely.
      assert.ok(elapsed < 1500, `expected the configured 150 ms deadline, waited ${elapsed} ms`);
      assert.equal(mock.requests.length, 1);
    } finally {
      held?.destroy();
      await mock.close();
    }
  });
});

describe('M7 acceptance: invalid page size', () => {
  it('alerts refuses every out-of-range or malformed --limit before it opens a connection', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage()));
    const { configPath } = configFor(mock);
    try {
      for (const value of ['0', '101', '-1', '1.5', 'abc', '']) {
        const result = await runCli(['alerts', '--limit', value, '--json', '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.USAGE, `--limit ${JSON.stringify(value)}`);
        const document = parseJsonOutput(result.stdout);
        assert.equal(document.ok, false);
        assert.equal(document.error.code, CLI_CODES.USAGE);
        assert.equal(document.error.exit_code, CLI_EXIT.USAGE);
      }
      assert.equal(mock.requests.length, 0, 'a rejected page size must not reach the daemon');
    } finally {
      await mock.close();
    }
  });

  it('refuses non-canonical decimal spellings of a legal page size', async () => {
    // Contract §3 names these explicitly: `007`, `1e2`, `+5`, ` 10`, `5.0`. Each one is a
    // number `Number()` would happily accept, so the CLI must refuse the spelling rather
    // than quietly answer a page size the operator did not type.
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage()));
    const { configPath } = configFor(mock);
    try {
      for (const value of ['007', '1e2', '+5', ' 10', '5.0']) {
        const result = await runCli(['alerts', '--limit', value, '--json', '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.USAGE, `--limit ${JSON.stringify(value)}`);
        const document = parseJsonOutput(result.stdout);
        assert.equal(document.error.code, CLI_CODES.USAGE);
        assert.equal(document.error.exit_code, CLI_EXIT.USAGE);
      }
      assert.equal(mock.requests.length, 0, 'a non-canonical page size must not reach the daemon');
    } finally {
      await mock.close();
    }
  });

  it('analysis refuses --limit 0 before it opens a connection', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, analysisPage()));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['analysis', '--limit', '0', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.USAGE);
      assert.match(result.stderr, /1\.\.100/u);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });

  it('detail mode rejects --limit instead of silently dropping it', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, analysisDetail()));
    const { configPath } = configFor(mock);
    try {
      const human = await runCli(['analysis', JOB_ID, '--limit', '5', '--config', configPath]);
      assert.equal(human.code, CLI_EXIT.USAGE);
      assert.match(human.stderr, /--limit/u);
      assert.match(human.stderr, /detail mode/u);

      const json = await runCli(['analysis', JOB_ID, '--limit', '5', '--json', '--config', configPath]);
      assert.equal(json.code, CLI_EXIT.USAGE);
      const document = parseJsonOutput(json.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.code, CLI_CODES.USAGE);
      assert.equal(mock.requests.length, 0, 'detail mode with --limit must not query the daemon');
    } finally {
      await mock.close();
    }
  });

  it('the range boundaries 1 and 100 are accepted and reach the query string', async () => {
    // Contract §9 caps the page at 100. The mock honours the requested size so the page is
    // self-consistent: a 1-row request answered with 2 rows would be refused as
    // `page.returned` mismatched, which is a different failure than the one under test.
    const mock = await startMock((request, res) => {
      const query = request.url.split('?')[1] ?? '';
      const limit = Number(new URLSearchParams(query).get('limit') ?? '50');
      if (request.url.startsWith('/api/v1/alerts')) {
        respondJson(res, 200, alertsPage(ALERT_ROWS.slice(0, limit), { limit }));
        return;
      }
      respondJson(res, 200, analysisPage(ANALYSIS_ROWS.slice(0, limit), { limit }));
    });
    const { configPath } = configFor(mock);
    try {
      for (const limit of ['1', '100']) {
        const alerts = await runCli(['alerts', '--limit', limit, '--config', configPath]);
        assert.equal(alerts.code, CLI_EXIT.OK, `alerts --limit ${limit}`);
        const analysis = await runCli(['analysis', '--limit', limit, '--config', configPath]);
        assert.equal(analysis.code, CLI_EXIT.OK, `analysis --limit ${limit}`);
      }
      assert.deepEqual(mock.requests.map((request) => request.url), [
        '/api/v1/alerts?limit=1',
        '/api/v1/analysis?limit=1',
        '/api/v1/alerts?limit=100',
        '/api/v1/analysis?limit=100',
      ]);
    } finally {
      await mock.close();
    }
  });

  it('101 is one past the contract ceiling and is refused before any request', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage()));
    const { configPath } = configFor(mock);
    try {
      const result = await runCli(['alerts', '--limit', '101', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.USAGE);
      assert.match(result.stderr, /1\.\.100/u);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });
});

describe('M7 acceptance: oversized responses', () => {
  it('a page that really is too big exits TOO_LARGE', async () => {
    const body = oversizedAlertsPage();
    assert.ok(body.length > 1024, `the fixture must exceed the configured cap, got ${body.length} bytes`);
    const mock = await startMock((request, res) => respondRaw(res, 200, body));
    const { configPath } = configFor(mock, { maxResponseBytes: 1024 });
    try {
      const result = await runCli(['alerts', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.TOO_LARGE);
      assert.match(result.stderr, /RESPONSE_TOO_LARGE/u);
      assert.equal(result.stdout, '');
    } finally {
      await mock.close();
    }
  });

  it('a declared Content-Length above the cap is honoured even if the bytes never arrive', async () => {
    // 100 real bytes, 60000 declared. The declaration is a claim, and the claim is enough
    // to abandon the response: buffering first and checking later is the bug this stops.
    const small = Buffer.from(JSON.stringify(alertsPage([alertRow()])), 'utf8');
    const mock = await startMock((request, res) => respondRaw(res, 200, small, { 'content-length': '60000' }));
    const { configPath } = configFor(mock, { maxResponseBytes: 1024 });
    try {
      const result = await runCli(['alerts', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.TOO_LARGE);
      assert.match(result.stderr, /RESPONSE_TOO_LARGE/u);
      assert.equal(result.stdout, '');
    } finally {
      await mock.close();
    }
  });

  it('an undeclared body that grows past the cap is abandoned mid-stream', async () => {
    // No Content-Length at all, so the only defence left is counting the bytes as they
    // arrive. A client that trusted the header alone would buffer the whole page here.
    const body = oversizedAlertsPage();
    const mock = await startMock((request, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    });
    const { configPath } = configFor(mock, { maxResponseBytes: 1024 });
    try {
      const result = await runCli(['alerts', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.TOO_LARGE);
      assert.match(result.stderr, /RESPONSE_TOO_LARGE/u);
      assert.equal(result.stdout, '');
    } finally {
      await mock.close();
    }
  });
});

describe('M7 acceptance: terminal safety', () => {
  it('control sequences in alert fields never reach stdout, in either output mode', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([
      hostileAlertRow(),
      ALERT_ROWS[1],
    ])));
    const { configPath } = configFor(mock);
    try {
      const human = await runCli(['alerts', '--config', configPath]);
      assert.equal(human.code, CLI_EXIT.OK);
      // The row did render — the absence below is not the absence of output.
      assert.match(human.stdout, /proc\.evil/u);
      assert.match(human.stdout, /returned=2/u);
      assertNoControlChars(human.stdout, 'human stdout');
      assertNoControlChars(human.stderr, 'human stderr');

      const json = await runCli(['alerts', '--json', '--config', configPath]);
      assert.equal(json.code, CLI_EXIT.OK);
      const document = parseJsonOutput(json.stdout);
      const item = document.data.items[0];
      // Exact sanitised values: the escape sequence is gone, the text around it is not.
      assert.equal(item.rule_id, 'proc.evil');
      assert.equal(item.severity, 'high');
      assert.equal(item.status, 'new');
      assert.equal(item.alert_id, 'alrt-hostile');
      assertNoControlChars(json.stdout, 'json stdout');
    } finally {
      await mock.close();
    }
  });

  it('a daemon error body is not echoed, in prose or in details', async () => {
    const secret = 'SECRET-SHOULD-NOT-BE-ECHOED';
    const mock = await startMock((request, res) => respondJson(res, 500, {
      error: {
        code: 'INTERNAL_FAILURE',
        message: `<html><body><h1>${secret}</h1></body></html>`,
        echo: { token_file: secret },
      },
    }));
    const { configPath } = configFor(mock);
    try {
      const human = await runCli(['alerts', '--config', configPath]);
      assert.equal(human.code, CLI_EXIT.DAEMON_ERROR);
      assert.match(human.stderr, /DAEMON_ERROR/u);
      assert.equal(human.stdout.includes(secret), false);
      assert.equal(human.stderr.includes(secret), false);
      assert.equal(human.stderr.includes('<html>'), false);

      const json = await runCli(['alerts', '--json', '--config', configPath]);
      assert.equal(json.code, CLI_EXIT.DAEMON_ERROR);
      const document = parseJsonOutput(json.stdout);
      assert.equal(document.ok, false);
      // `emitFailure` spreads the allowlisted details directly onto `error`, so that object
      // is the whole JSON path a leaked body could travel through.
      assert.equal(document.error.status, 500);
      assert.equal(document.error.daemon_code, 'INTERNAL_FAILURE');
      // The details survived — this is not a vacuous "nothing was rendered" check — and the
      // allowlist kept every unlisted key, including the body text, out of them.
      assert.equal(document.error.message.includes(secret), false);
      assert.equal(JSON.stringify(document.error).includes(secret), false);
      assert.equal(json.stdout.includes(secret), false);
      assert.equal(json.stdout.includes('<html>'), false);
    } finally {
      await mock.close();
    }
  });

  it('the bearer token appears in no stream, for any command', async () => {
    const mock = await startMock((request, res) => {
      if (request.url.startsWith('/api/v1/alerts')) {
        respondJson(res, 200, alertsPage());
        return;
      }
      if (request.url === `/api/v1/analysis/${JOB_ID}`) {
        respondJson(res, 200, analysisDetail());
        return;
      }
      respondJson(res, 200, analysisPage());
    });
    const { configPath, token } = configFor(mock);
    // A vacuity guard: `includes('')` is always true, so an empty token would make every
    // assertion below fail loudly rather than pass quietly.
    assert.equal(token.length > 0, true, 'the fixture must supply a real token');
    try {
      const runs = [
        ['alerts'],
        ['alerts', '--json'],
        ['analysis'],
        ['analysis', '--json'],
        ['analysis', JOB_ID, '--json'],
      ];
      for (const argv of runs) {
        const result = await runCli([...argv, '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.OK, argv.join(' '));
        for (const stream of [result.stdout, result.stderr]) {
          assert.equal(stream.includes(token), false, `${argv.join(' ')} printed the token`);
        }
      }
      // The token was actually sent, so "not printed" is not "never used".
      assert.equal(mock.requests[0].headers.authorization, `Bearer ${token}`);
    } finally {
      await mock.close();
    }
  });

  it('the bearer token is not printed on a failing path either', async () => {
    // The success-path case above proves nothing about the error printers. A 401 and a 500
    // both travel through `emitFailure`, which is where a token in `details` or in an echoed
    // daemon message would surface.
    const cases = [
      { status: 401, exit: CLI_EXIT.AUTH, code: 'AUTH_FAILED' },
      { status: 500, exit: CLI_EXIT.DAEMON_ERROR, code: 'INTERNAL' },
    ];
    for (const expected of cases) {
      const status = expected.status;
      const mock = await startMock((request, res) => respondJson(res, status, {
        error: { code: expected.code, message: `failed for ${request.headers.authorization}` },
      }));
      try {
        const { configPath, token } = configFor(mock);
        assert.equal(token.length > 0, true, 'the fixture must supply a real token');
        const human = await runCli(['alerts', '--config', configPath]);
        const json = await runCli(['alerts', '--json', '--config', configPath]);
        assert.equal(human.code, expected.exit, `HTTP ${status} must exit ${expected.exit}`);
        assert.equal(json.code, expected.exit, `HTTP ${status} must exit ${expected.exit}`);
        for (const output of [human.stdout, human.stderr, json.stdout, json.stderr]) {
          assert.equal(output.includes(token), false, `HTTP ${status} printed the token`);
        }
      } finally {
        await mock.close();
      }
    }
  });
});

describe('M7 acceptance: read-only request shape', () => {
  it('each command sends one GET, to the exact route, with no follow-up query', async () => {
    const mock = await startMock((request, res) => {
      if (request.url.startsWith('/api/v1/alerts')) {
        respondJson(res, 200, alertsPage(ALERT_ROWS.slice(0, 2), { limit: 5 }));
        return;
      }
      if (request.url === `/api/v1/analysis/${JOB_ID}`) {
        respondJson(res, 200, analysisDetail());
        return;
      }
      respondJson(res, 200, analysisPage(ANALYSIS_ROWS.slice(0, 2), { limit: 7 }));
    });
    const { configPath } = configFor(mock);
    const expected = [
      { argv: ['alerts', '--limit', '5'], url: '/api/v1/alerts?limit=5' },
      { argv: ['analysis', '--limit', '7'], url: '/api/v1/analysis?limit=7' },
      { argv: ['analysis', JOB_ID], url: `/api/v1/analysis/${JOB_ID}` },
    ];
    try {
      for (const step of expected) {
        const before = mock.requests.length;
        const result = await runCli([...step.argv, '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.OK, step.argv.join(' '));
        assert.equal(mock.requests.length, before + 1, `${step.argv.join(' ')} must send exactly one request`);
        const request = mock.requests[before];
        assert.equal(request.method, 'GET');
        assert.equal(request.url, step.url);
      }
    } finally {
      await mock.close();
    }
  });
});

describe('M7 acceptance: the envelope is closed (contract §5/§11)', () => {
  it('rejects an alerts body whose rows are not under the alerts key', async () => {
    // Contract §11 makes the array key part of the compatibility surface. The old
    // tolerance for `items`/`data`/bare arrays was a guess, and a guess that reads the
    // wrong key is worse than a refusal: it renders "no alerts" for a body full of them.
    let body = null;
    const mock = await startMock((request, res) => respondJson(res, 200, body));
    const { configPath } = configFor(mock);
    try {
      const bodies = [
        { items: ALERT_ROWS.map((row) => ({ ...row })), page: page(ALERT_ROWS) },
        { data: ALERT_ROWS.map((row) => ({ ...row })), page: page(ALERT_ROWS) },
        ALERT_ROWS.map((row) => ({ ...row })),
      ];
      for (const candidate of bodies) {
        body = candidate;
        const result = await runCli(['alerts', '--json', '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.BAD_RESPONSE, `body ${JSON.stringify(Object.keys(candidate))}`);
        const document = parseJsonOutput(result.stdout);
        assert.equal(document.error.code, CLI_CODES.BAD_RESPONSE);
        assert.equal(document.error.field, 'alerts');
        assert.equal(document.ok, false);
      }
      assert.equal(mock.requests.length, bodies.length);
    } finally {
      await mock.close();
    }
  });

  it('rejects an analysis body whose rows are not under the analyses key', async () => {
    let body = null;
    const mock = await startMock((request, res) => respondJson(res, 200, body));
    const { configPath } = configFor(mock);
    try {
      const bodies = [
        { analysis: ANALYSIS_ROWS.map((row) => ({ ...row })), page: page(ANALYSIS_ROWS) },
        { jobs: ANALYSIS_ROWS.map((row) => ({ ...row })), page: page(ANALYSIS_ROWS) },
        ANALYSIS_ROWS.map((row) => ({ ...row })),
      ];
      for (const candidate of bodies) {
        body = candidate;
        const result = await runCli(['analysis', '--json', '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.BAD_RESPONSE, `body ${JSON.stringify(Object.keys(candidate))}`);
        const document = parseJsonOutput(result.stdout);
        assert.equal(document.error.field, 'analyses');
      }
      assert.equal(mock.requests.length, bodies.length);
    } finally {
      await mock.close();
    }
  });

  it('analysis detail accepts a wrapped job and an unwrapped one, in contract field names', async () => {
    // Contract §1 says v0 serves no detail route; the CLI keeps the branch for forward
    // compatibility, and it accepts a body either wrapped or bare. Both spellings must
    // project the same §6.2 fields — including `state`, which replaced `status`.
    let body = null;
    const mock = await startMock((request, res) => respondJson(res, 200, body));
    const { configPath } = configFor(mock);
    const job = analysisRow({ analysis_id: 'job-aa11', state: 'queued', completed_at: null, report_available: false });
    try {
      for (const wrapped of [true, false]) {
        body = analysisDetail(job, { wrapped });
        const result = await runCli(['analysis', 'job-aa11', '--json', '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.OK, `wrapped=${wrapped}`);
        const document = parseJsonOutput(result.stdout);
        assert.equal(document.data.id, 'job-aa11');
        assert.equal(document.data.item.analysis_id, 'job-aa11');
        assert.equal(document.data.item.state, 'queued');
        assert.equal(document.data.item.completed_at, null);
        assert.equal(document.data.item.report_available, false);
      }
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });
});
