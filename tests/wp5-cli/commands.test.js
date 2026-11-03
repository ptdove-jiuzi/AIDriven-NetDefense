/**
 * commands.test.js — projection of daemon payloads into stable views.
 *
 * The important properties here are about what the CLI refuses to do: it does not
 * render a partial status as if it were complete, it does not copy the CSRF token it
 * was handed, it does not turn "no such endpoint" into an empty alert list, and it does
 * not accept an identifier that could become a path segment.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_LIMIT,
  LIMIT_RANGE,
  assertAnalysisId,
  fetchAlerts,
  fetchAnalysis,
  fetchHealth,
  fetchStatus,
  parseLimit,
  projectStatus,
} from '../../apps/cli/src/commands.js';
import { CLI_CODES, CliError } from '../../apps/cli/src/errors.js';
import { createLoopbackClient } from '../../apps/cli/src/http-client.js';
import { TEST_TOKEN, respondJson, startMock } from './helpers.js';
import {
  ALERT_FIELDS,
  ALERT_ORDER,
  ANALYSIS_FIELDS,
  ANALYSIS_ORDER,
  alertRow,
  alertsPage,
  analysisPage,
  analysisRow,
} from './mock-transport.js';

/**
 * Build a client pointed at a mock port.
 *
 * @param {number} port Mock port.
 * @returns {object} Client.
 */
function clientFor(port) {
  return createLoopbackClient({
    endpoint: { host: '127.0.0.1', port },
    timeoutMs: 4000,
    maxResponseBytes: 65536,
  });
}

/**
 * Build a status payload shaped like the daemon's real one.
 *
 * @param {object} [overrides] Top-level overrides.
 * @returns {object} Payload.
 */
function statusPayload(overrides = {}) {
  return {
    schema_version: '1.0',
    version: '0.0.0',
    lifecycle: 'running',
    mode: 'mock',
    started_at: '2026-11-02T00:00:00.000Z',
    now: '2026-11-02T00:00:41.000Z',
    epoch: '3f7c1a9e-6b2d-4c8f-9a01-2b3c4d5e6f70',
    health: { status: 'degraded', ready: true, reasons: ['sources:none'] },
    scheduler: {
      sources: 1,
      polling: 1,
      stale: 0,
      degraded: 0,
      ok: 1,
      uptime_mono_ms: 41000,
      sources_detail: [],
    },
    pipeline: { events_received: 4, events_accepted: 4, detection: { fatal: null, events: 4 } },
    store: { kind: 'memory', open: true, events: 4, alerts: 1, findings: 1, analyses: 0 },
    counters: { polls: 2, events_received: 4 },
    uptime_ms: 41000,
    csrf_token: 'csrf-value-that-must-never-be-printed',
    ...overrides,
  };
}

/**
 * Assert that a thunk throws a CLI error with a specific code.
 *
 * @param {() => unknown} thunk Call.
 * @param {string} code Expected code.
 * @returns {CliError} The error.
 */
function expectCode(thunk, code) {
  try {
    thunk();
  } catch (error) {
    assert.ok(error instanceof CliError, `expected a CliError, got ${error?.name ?? typeof error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
}

describe('projectStatus', () => {
  it('projects the documented fields', () => {
    const payload = statusPayload({
      scheduler: {
        sources: [
          {
            id: 'windows.security.4688',
            kind: 'auth-log',
            lifecycle: 'ok',
            stale: false,
            polling: false,
            polls: 3,
            events: 12,
            accepted: 12,
            failures: 0,
            consecutive_failures: 0,
            dropped_events: 0,
            last_error_code: null,
            last_poll_at: '2026-11-02T00:00:40.000Z',
            last_success_at: '2026-11-02T00:00:40.000Z',
            unknown_field: 'dropped',
          },
        ],
        polling: 0,
        uptime_mono_ms: 41000,
      },
    });

    const view = projectStatus(payload);
    assert.equal(view.daemon.lifecycle, 'running');
    assert.equal(view.daemon.mode, 'mock');
    assert.equal(view.daemon.uptime_ms, 41000);
    assert.equal(view.health.status, 'degraded');
    assert.equal(view.health.ready, true);
    assert.deepEqual(view.health.reasons, ['sources:none']);
    assert.equal(view.scheduler.sources.length, 1);
    assert.equal(view.scheduler.sources[0].id, 'windows.security.4688');
    assert.equal(view.scheduler.sources[0].dropped_events, 0);
    assert.equal('unknown_field' in view.scheduler.sources[0], false, 'unknown fields are not copied');
    assert.equal(view.pipeline.events_received, 4);
    assert.equal(view.pipeline.detection.events, 4);
    assert.equal(view.store.kind, 'memory');
    assert.equal(view.store.open, true);
    assert.equal(view.store.counts.alerts, 1);
    assert.equal(view.counters.polls, 2);
  });

  it('never copies the CSRF token but reports that one was present', () => {
    const view = projectStatus(statusPayload());
    const rendered = JSON.stringify(view);
    assert.equal(rendered.includes('csrf-value-that-must-never-be-printed'), false);
    assert.equal(view.csrf_token_present, true);
  });

  it('rejects a payload that is not an object', () => {
    expectCode(() => projectStatus([]), CLI_CODES.BAD_RESPONSE);
    expectCode(() => projectStatus('running'), CLI_CODES.BAD_RESPONSE);
    expectCode(() => projectStatus(null), CLI_CODES.BAD_RESPONSE);
  });

  it('rejects a payload without a lifecycle instead of showing a blank one', () => {
    const error = expectCode(() => projectStatus({ version: '0.0.0' }), CLI_CODES.BAD_RESPONSE);
    assert.equal(error.details.field, 'lifecycle');
  });

  it('drops nested and unknown values from the free-form maps', () => {
    const view = projectStatus(statusPayload({
      counters: { polls: 2, nested: { a: 1 }, array: [1, 2], text: 'ok', bad: true },
    }));
    assert.deepEqual(view.counters, { bad: true, polls: 2, text: 'ok' });
  });

  it('emits counter keys in a deterministic order', () => {
    const first = projectStatus(statusPayload({ counters: { b: 1, a: 2, c: 3 } }));
    const second = projectStatus(statusPayload({ counters: { c: 3, a: 2, b: 1 } }));
    assert.equal(JSON.stringify(first.counters), JSON.stringify(second.counters));
    assert.deepEqual(Object.keys(first.counters), ['a', 'b', 'c']);
  });

  it('caps the source list so one payload cannot flood the terminal', () => {
    const sources = Array.from({ length: 260 }, (unused, index) => ({ id: `s${index}`, kind: 'k' }));
    const view = projectStatus(statusPayload({ scheduler: { sources } }));
    assert.equal(view.scheduler.sources.length, 200);
  });

  it('sanitizes strings that arrive from the payload', () => {
    const view = projectStatus(statusPayload({
      scheduler: { sources: [{ id: '\u001b[2Jpwned', kind: 'k', last_error_code: '\u202Eevil' }] },
      health: { status: 'ok', ready: true, reasons: ['a\u0007b'] },
    }));
    assert.equal(view.scheduler.sources[0].id, 'pwned');
    assert.equal(view.health.reasons[0], 'a b');
    assert.equal(JSON.stringify(view).includes('\u001b'), false);
    assert.equal(JSON.stringify(view).includes('\u202E'), false);
  });
});

describe('fetchStatus', () => {
  it('authenticates and projects a live response', async () => {
    const mock = await startMock((request, res) => {
      if (request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
        respondJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: 'no' } });
        return;
      }
      respondJson(res, 200, statusPayload());
    });
    try {
      const view = await fetchStatus(clientFor(mock.port), TEST_TOKEN);
      assert.equal(view.daemon.lifecycle, 'running');
      assert.equal(mock.requests[0].url, '/api/v1/status');
      assert.equal(mock.requests[0].method, 'GET');
    } finally {
      await mock.close();
    }
  });
});

describe('fetchHealth', () => {
  it('reports a ready daemon', async () => {
    const mock = await startMock((request, res) => {
      if (request.url === '/healthz') {
        respondJson(res, 200, { status: 'ok', version: '0.0.0' });
        return;
      }
      respondJson(res, 200, { ready: true, lifecycle: 'running', reasons: [] });
    });
    try {
      const view = await fetchHealth(clientFor(mock.port));
      assert.equal(view.ok, true);
      assert.equal(view.liveness.status, 'ok');
      assert.equal(view.readiness.ready, true);
      assert.deepEqual(view.readiness.reasons, []);
      assert.equal(mock.requests.length, 2);
      assert.equal(mock.requests[0].headers.authorization, undefined, 'probes must not send a token');
    } finally {
      await mock.close();
    }
  });

  it('reports an unready daemon without treating the probes as failures', async () => {
    const mock = await startMock((request, res) => {
      if (request.url === '/healthz') {
        respondJson(res, 503, { status: 'failed', version: '0.0.0' });
        return;
      }
      respondJson(res, 503, { ready: false, lifecycle: 'starting', reasons: ['lifecycle:starting'] });
    });
    try {
      const view = await fetchHealth(clientFor(mock.port));
      assert.equal(view.ok, false);
      assert.equal(view.liveness.http_status, 503);
      assert.equal(view.readiness.http_status, 503);
      assert.deepEqual(view.readiness.reasons, ['lifecycle:starting']);
    } finally {
      await mock.close();
    }
  });

  it('refuses a probe payload that lost its required field', async () => {
    // `{}` with HTTP 200 used to render as "liveness unknown" and still exit zero, which
    // would tell a service manager that a broken daemon is fine.
    const mock = await startMock((request, res) => {
      if (request.url === '/healthz') {
        respondJson(res, 200, {});
        return;
      }
      respondJson(res, 200, { ready: true, lifecycle: 'running', reasons: [] });
    });
    try {
      await assert.rejects(
        fetchHealth(clientFor(mock.port)),
        (error) => error.code === CLI_CODES.BAD_RESPONSE && error.details.field === 'status',
      );
    } finally {
      await mock.close();
    }
  });

  it('refuses a readiness payload without a boolean ready flag', async () => {
    const mock = await startMock((request, res) => {
      if (request.url === '/healthz') {
        respondJson(res, 200, { status: 'ok', version: '0.0.0' });
        return;
      }
      respondJson(res, 200, { lifecycle: 'running' });
    });
    try {
      await assert.rejects(
        fetchHealth(clientFor(mock.port)),
        (error) => error.code === CLI_CODES.BAD_RESPONSE && error.details.field === 'ready',
      );
    } finally {
      await mock.close();
    }
  });
});

describe('parseLimit', () => {
  it('accepts the documented range', () => {
    assert.equal(parseLimit('1'), LIMIT_RANGE.min);
    assert.equal(parseLimit(String(LIMIT_RANGE.max)), LIMIT_RANGE.max);
    assert.equal(parseLimit(10), 10);
  });

  it('rejects everything else, including numbers a coercion would "fix"', () => {
    // Contract §3: `limit` is canonically decimal. `007`, `1e2`, `+5`, ` 10` and `5.0`
    // all coerce to a legal integer, which is exactly why accepting them would be a quiet
    // lie about what the operator typed.
    for (const value of [
      '0',
      '101',
      '201',
      '-1',
      '1.5',
      '1e3',
      'abc',
      '',
      undefined,
      '007',
      '1e2',
      '+5',
      ' 10',
      '5.0',
    ]) {
      expectCode(() => parseLimit(value), CLI_CODES.USAGE);
    }
  });
});

describe('assertAnalysisId', () => {
  it('accepts a uuid and a dotted identifier', () => {
    assert.equal(assertAnalysisId('3f7c1a9e-6b2d-4c8f-9a01-2b3c4d5e6f70'), '3f7c1a9e-6b2d-4c8f-9a01-2b3c4d5e6f70');
    assert.equal(assertAnalysisId('job.2026-11-02_1'), 'job.2026-11-02_1');
  });

  it('rejects path separators, traversal and control characters', () => {
    for (const value of ['../etc', '..', '.', 'a/b', 'a\\b', 'a b', 'a\u0000b', '%2e%2e', '', '-leading']) {
      expectCode(() => assertAnalysisId(value), CLI_CODES.USAGE);
    }
  });

  it('rejects an over-long identifier', () => {
    expectCode(() => assertAnalysisId('a'.repeat(129)), CLI_CODES.USAGE);
  });
});

describe('fetchAlerts', () => {
  it('reads the contract envelope and projects the twelve whitelisted fields', async () => {
    const row = alertRow({ alert_id: 'a1', count: 3, evidence_count: 3, evidence_truncated: true });
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([row], { limit: 25 })));
    try {
      const view = await fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 25 });
      assert.equal(view.limit, 25);
      // `returned` is the daemon's count, not `items.length` computed here.
      assert.equal(view.returned, 1);
      assert.equal(view.has_more, false);
      assert.equal(view.byte_limited, false);
      assert.equal(view.order, ALERT_ORDER);
      // Contract §6.1 is a whitelist: exactly these twelve fields, no more.
      assert.deepEqual(Object.keys(view.items[0]).sort(), [...ALERT_FIELDS].sort());
      assert.equal(view.items[0].alert_id, 'a1');
      assert.equal(view.items[0].rule_version, '1.4.0');
      assert.equal(view.items[0].count, 3);
      assert.equal(view.items[0].evidence_count, 3);
      assert.equal(view.items[0].evidence_truncated, true);
      assert.equal(view.items[0].first_seen, '2026-11-02T10:00:00.000Z');
      assert.equal(view.items[0].window_start, '2026-11-02T10:00:00.000Z');
      assert.equal(mock.requests[0].url, '/api/v1/alerts?limit=25');
    } finally {
      await mock.close();
    }
  });

  it('does not copy the row\'s event_ids, and counts nothing from them', async () => {
    // Contract §7 forbids the evidence id array from leaving the daemon. A daemon that
    // (wrongly) sends one must not be able to make the CLI render it, and a client that
    // counted the array would print `evidence_count=3` while §6.1 says that number comes
    // from its own field.
    //
    // 5 and 3 are deliberately different: if they matched, an implementation that counted
    // `event_ids` would produce the same number as the honest one and this case could not
    // tell them apart. Do not "tidy" these two values back to equality.
    const row = { ...alertRow({ alert_id: 'a1', evidence_count: 5 }), event_ids: ['e1', 'e2', 'e3'] };
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([row], { limit: 5 })));
    try {
      const view = await fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 5 });
      assert.equal(Object.hasOwn(view.items[0], 'event_ids'), false);
      assert.equal(JSON.stringify(view).includes('e1'), false);
      // The field's own value, not the array's length (3).
      assert.equal(view.items[0].evidence_count, 5);
      assert.equal(view.items[0].evidence_count, row.evidence_count);
    } finally {
      await mock.close();
    }
  });

  it('reports a null evidence_count when the field is absent, rather than counting event_ids', async () => {
    // Contract §6.1 makes `evidence_count` a field of the row; §7 keeps `event_ids` from
    // leaving the daemon. A client written as `item.evidence_count ?? item.event_ids?.length`
    // passes every case where both numbers happen to agree, so this row carries the array
    // and no count at all: the honest projection is null, a counting one is 3.
    const { evidence_count: _omitted, ...base } = alertRow({ alert_id: 'a1' });
    const row = { ...base, event_ids: ['e1', 'e2', 'e3'] };
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([row], { limit: 5 })));
    try {
      const view = await fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 5 });
      assert.equal(Object.hasOwn(view.items[0], 'event_ids'), false);
      assert.equal(JSON.stringify(view).includes('e1'), false);
      assert.equal(view.items[0].evidence_count, null);
    } finally {
      await mock.close();
    }
  });

  it('projects page.next_cursor verbatim and never interprets it', async () => {
    // The cursor is opaque: the client copies it into the view and into the next request,
    // and that is the entire relationship. The fixture is deliberately a shape the CLI
    // must *not* understand — two base64url segments around a dot, one of which decodes
    // to plain text — so an implementation that decoded it (to read a timestamp, to check
    // a version, to re-sign it) would be visible here as a changed value.
    const cursor = 'djF.cGFnZS1wMg';
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage(
      [alertRow()],
      { next_cursor: cursor, has_more: true },
    )));
    try {
      const view = await fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 5 });
      assert.equal(view.next_cursor, cursor, 'the value must round-trip byte for byte');
      assert.equal(view.has_more, true);
      assert.equal(view.pages, 1, 'one request was made');
      assert.equal(view.truncated, false);
    } finally {
      await mock.close();
    }
  });

  it('refuses a page whose cursor and has_more contradict each other, in both directions', async () => {
    // Contract §4.1: `next_cursor` is non-null only while `has_more` is true. Each
    // direction is a different lie, and each one would mislead a different caller:
    //   - more data, no cursor  → `--all` reports a complete list it never finished;
    //   - no more data, cursor  → the walk follows a page that says it is the last one.
    const cases = [
      { label: 'has_more with no cursor', page: { has_more: true, next_cursor: null } },
      { label: 'has_more with an empty cursor', page: { has_more: true, next_cursor: '' } },
      { label: 'has_more with an unusable cursor', page: { has_more: true, next_cursor: 'not a cursor/../x' } },
      { label: 'no more data but a cursor', page: { has_more: false, next_cursor: 'djF.cGFnZS1wMg' } },
    ];
    let body = null;
    const mock = await startMock((request, res) => respondJson(res, 200, body));
    try {
      for (const testCase of cases) {
        body = alertsPage([alertRow()], testCase.page);
        await assert.rejects(
          fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 5 }),
          (error) => error.code === CLI_CODES.BAD_RESPONSE && error.details.field === 'page.next_cursor',
          testCase.label,
        );
      }
    } finally {
      await mock.close();
    }
  });

  it('rejects a bare array, which is not the contract envelope', async () => {
    // The pre-contract client accepted a bare array here. Contract §5/§11 fixes one
    // envelope, so a client that still guessed would read no rows and print "no alerts"
    // for a body that carries them.
    const mock = await startMock((request, res) => respondJson(res, 200, [alertRow({ alert_id: 'a1' })]));
    try {
      await assert.rejects(
        fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 5 }),
        (error) => error.code === CLI_CODES.BAD_RESPONSE && error.details.field === 'alerts',
      );
    } finally {
      await mock.close();
    }
  });

  it('rejects rows filed under a key the contract does not name', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, {
      items: [alertRow({ alert_id: 'a1' })],
      page: alertsPage([alertRow()]).page,
    }));
    try {
      await assert.rejects(
        fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 5 }),
        (error) => error.code === CLI_CODES.BAD_RESPONSE && error.details.field === 'alerts',
      );
    } finally {
      await mock.close();
    }
  });

  it('rejects every broken page with the field that broke it', async () => {
    const rows = [alertRow({ alert_id: 'a1' }), alertRow({ alert_id: 'a2' })];
    const cases = [
      { label: 'no page', body: { alerts: rows }, field: 'page' },
      { label: 'non-integer returned', body: { alerts: rows, page: { ...alertsPage(rows).page, returned: 2.5 } }, field: 'page.returned' },
      { label: 'non-boolean has_more', body: { alerts: rows, page: { ...alertsPage(rows).page, has_more: 'no' } }, field: 'page.has_more' },
      { label: 'returned disagrees with the rows', body: { alerts: rows, page: { ...alertsPage(rows).page, returned: 3 } }, field: 'page.returned' },
      // The daemon ignored the page size: two rows for a one-row request cannot both be
      // true, and printing either number would be inventing a page.
      { label: 'page larger than requested', body: alertsPage(rows, { limit: 2 }), field: 'page.returned', limit: 1 },
    ];
    let body = null;
    const mock = await startMock((request, res) => respondJson(res, 200, body));
    try {
      for (const testCase of cases) {
        body = testCase.body;
        await assert.rejects(
          fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: testCase.limit ?? 5 }),
          (error) => error.code === CLI_CODES.BAD_RESPONSE && error.details.field === testCase.field,
          testCase.label,
        );
      }
    } finally {
      await mock.close();
    }
  });

  it('reports a missing endpoint as unavailable, never as an empty list', async () => {
    const mock = await startMock((request, res) => respondJson(res, 404, {
      error: { code: 'NOT_FOUND', message: 'no such endpoint' },
    }));
    try {
      await assert.rejects(
        fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 5 }),
        (error) => error.code === CLI_CODES.ENDPOINT_UNAVAILABLE,
      );
    } finally {
      await mock.close();
    }
  });

  it('distinguishes a page with more from a page that is the whole set', async () => {
    const rows = Array.from({ length: 6 }, (unused, index) => alertRow({ alert_id: `a${index}` }));
    let body = null;
    const mock = await startMock((request, res) => respondJson(res, 200, body));
    try {
      body = alertsPage(rows.slice(0, 2), { limit: 2, has_more: true, next_cursor: 'opaque.1' });
      const partial = await fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 2 });
      assert.equal(partial.returned, 2);
      assert.equal(partial.items.length, 2);
      assert.equal(partial.has_more, true, 'a page with more must not look like the whole set');

      body = alertsPage(rows, { limit: 10 });
      const whole = await fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 10 });
      assert.equal(whole.returned, 6);
      assert.equal(whole.items.length, 6);
      assert.equal(whole.has_more, false);
    } finally {
      await mock.close();
    }
  });

  it('does not shorten identifiers in the machine-readable view', async () => {
    // 200 characters: above the old 64/128 caps, below the safety cap, and still a legal
    // id for the analysis route. Feeding a shortened id back in would query nothing.
    const id = `a${'b'.repeat(199)}`;
    const mock = await startMock((request, res) => respondJson(
      res,
      200,
      alertsPage([alertRow({ alert_id: id, rule_id: id })], { limit: 5 }),
    ));
    try {
      const view = await fetchAlerts(clientFor(mock.port), { token: TEST_TOKEN, limit: 5 });
      assert.equal(view.items[0].alert_id, id, 'a --json consumer must be able to feed the id back in');
      assert.equal(view.items[0].rule_id, id);
    } finally {
      await mock.close();
    }
  });
});

describe('fetchAnalysis', () => {
  it('reads an analysis list with the nine contract fields', async () => {
    const row = analysisRow({ analysis_id: 'j1', state: 'queued', budget_class: 'cheap', attempts: 0, completed_at: null, report_available: false });
    const mock = await startMock((request, res) => respondJson(res, 200, analysisPage([row])));
    try {
      const view = await fetchAnalysis(clientFor(mock.port), { token: TEST_TOKEN, limit: DEFAULT_LIMIT, id: null });
      assert.equal(view.returned, 1);
      assert.equal(view.order, ANALYSIS_ORDER);
      assert.deepEqual(Object.keys(view.items[0]).sort(), [...ANALYSIS_FIELDS].sort());
      assert.equal(view.items[0].analysis_id, 'j1');
      assert.equal(view.items[0].state, 'queued');
      assert.equal(view.items[0].budget_class, 'cheap');
      assert.equal(view.items[0].attempts, 0);
      assert.equal(view.items[0].completed_at, null);
      assert.equal(view.items[0].report_available, false);
      assert.equal(mock.requests[0].url, `/api/v1/analysis?limit=${DEFAULT_LIMIT}`);
    } finally {
      await mock.close();
    }
  });

  it('reads one job, unwrapping an envelope when present', async () => {
    const job = analysisRow({ analysis_id: 'j1', state: 'succeeded', attempts: 2, report_available: true });
    const mock = await startMock((request, res) => respondJson(res, 200, { analysis: job }));
    try {
      const view = await fetchAnalysis(clientFor(mock.port), { token: TEST_TOKEN, limit: 10, id: 'j1' });
      assert.equal(view.id, 'j1');
      assert.equal(view.item.analysis_id, 'j1');
      assert.equal(view.item.state, 'succeeded');
      assert.equal(view.item.attempts, 2);
      assert.equal(view.item.report_available, true);
      assert.equal(mock.requests[0].url, '/api/v1/analysis/j1');
    } finally {
      await mock.close();
    }
  });

  it('refuses a detail body that cannot name itself, even with an empty id', async () => {
    // Rendering `{}` or `{ analysis_id: "" }` would answer "does this job exist?" with a
    // blank row and exit 0 — i.e. with `yes`.
    const mock = await startMock((request, res) => respondJson(res, 200, { analysis_id: '' }));
    try {
      await assert.rejects(
        fetchAnalysis(clientFor(mock.port), { token: TEST_TOKEN, limit: 10, id: 'j1' }),
        (error) => error.code === CLI_CODES.BAD_RESPONSE && error.details.field === 'analysis_id',
      );
    } finally {
      await mock.close();
    }
  });

  it('refuses a traversal identifier before any request is made', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, {}));
    try {
      await assert.rejects(
        fetchAnalysis(clientFor(mock.port), { token: TEST_TOKEN, limit: 10, id: '../status' }),
        (error) => error.code === CLI_CODES.USAGE,
      );
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });

  it('passes a validated id through unescaped', async () => {
    // `a:b` is a legal id and a legal path segment. Escaping it would produce `%3A`,
    // which the route grammar refuses — the request must carry the id as written.
    const mock = await startMock((request, res) => respondJson(res, 200, { analysis_id: 'a:b' }));
    try {
      const view = await fetchAnalysis(clientFor(mock.port), { token: TEST_TOKEN, limit: 10, id: 'a:b' });
      assert.equal(view.id, 'a:b');
      assert.equal(view.item.analysis_id, 'a:b');
      assert.equal(mock.requests[0].url, '/api/v1/analysis/a:b');
    } finally {
      await mock.close();
    }
  });

  it('reports a missing endpoint as unavailable', async () => {
    const mock = await startMock((request, res) => respondJson(res, 405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: 'no' },
    }));
    try {
      await assert.rejects(
        fetchAnalysis(clientFor(mock.port), { token: TEST_TOKEN, limit: 10, id: null }),
        (error) => error.code === CLI_CODES.ENDPOINT_UNAVAILABLE,
      );
    } finally {
      await mock.close();
    }
  });
});
