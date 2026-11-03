/**
 * cli.test.js — the contract an operator and a script actually see.
 *
 * Everything here starts a real process against a loopback mock: exit codes, the
 * one-document `--json` output, byte-level encoding, and the promise that a run does
 * not modify a byte of the directory it was pointed at.
 *
 * The cases mirror the failure list in the task: daemon offline, 401, 403, timeout,
 * malformed JSON, oversized response, output encoding, unknown command.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_CODES, CLI_EXIT } from '../../apps/cli/src/errors.js';
import {
  findClosedPort,
  makeTempDir,
  parseJsonOutput,
  respondJson,
  respondRaw,
  runCli,
  runInProcess,
  snapshotTree,
  startMock,
  writeClientConfig,
} from './helpers.js';
import {
  ALERT_ROWS,
  alertRow,
  alertsPage,
  analysisDetail,
  cursorToken,
} from './mock-transport.js';

/** A detail id that exists in the mock rows. */
const JOB_ID = 'job-7f3a';

/**
 * Build a payload shaped like the daemon's status document.
 *
 * @param {object} [overrides] Overrides.
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
    health: { status: 'ok', ready: true, reasons: [] },
    scheduler: {
      sources: [{ id: 'windows.security.4688', kind: 'auth-log', lifecycle: 'ok', stale: false, polls: 1, events: 2 }],
      polling: 0,
    },
    pipeline: { events_received: 2 },
    store: { kind: 'memory', open: true, events: 2, alerts: 0 },
    counters: { polls: 1, events_received: 2 },
    uptime_ms: 41000,
    csrf_token: 'csrf-must-not-be-printed',
    ...overrides,
  };
}

describe('aegis-cli: argument surface', () => {
  it('prints usage for --help and exits zero', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, CLI_EXIT.OK);
    assert.match(result.stdout, /aegis-cli/u);
    assert.match(result.stdout, /Exit codes/u);
    assert.match(result.stdout, /read-only/u);
  });

  it('prints usage for the help command', async () => {
    const result = await runCli(['help']);
    assert.equal(result.code, CLI_EXIT.OK);
    assert.match(result.stdout, /Commands:/u);
  });

  it('wraps usage in a JSON document when --json is requested', async () => {
    const result = await runCli(['help', '--json']);
    assert.equal(result.code, CLI_EXIT.OK);
    const document = parseJsonOutput(result.stdout);
    assert.equal(document.ok, true);
    assert.equal(document.command, 'help');
    assert.match(document.data.usage, /Exit codes/u);
  });

  it('keeps the JSON contract even when the flag is malformed', async () => {
    const result = await runCli(['status', '--json=true']);
    assert.equal(result.code, CLI_EXIT.USAGE);
    const document = parseJsonOutput(result.stdout);
    assert.equal(document.ok, false);
    assert.equal(document.error.code, CLI_CODES.USAGE);
    assert.match(document.error.message, /does not take a value/u);
  });

  it('rejects an unsafe analysis id as a usage error even without a configuration', async () => {
    // The same input must produce the same exit code whether or not a config file happens
    // to exist; a script cannot branch on "it depends".
    const result = await runInProcess(['analysis', '../x'], { env: {} });
    assert.equal(result.code, CLI_EXIT.USAGE);
    assert.match(result.stderr, /USAGE/u);
  });

  it('rejects --limit in detail mode before it loads a configuration', async () => {
    // Detail mode has no page size, so `--limit` is a usage error — and it must be
    // reported as one even when the named configuration file does not exist. If argument
    // validation ran after `loadCliConfig`, this case would exit 3 (CONFIG_NOT_FOUND) and
    // a script could not tell a bad flag from a bad machine.
    const result = await runCli(['analysis', JOB_ID, '--limit', '5', '--config', join(makeTempDir(), 'absent.json')]);
    assert.equal(result.code, CLI_EXIT.USAGE, `expected the usage error, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /USAGE/u);
    assert.match(result.stderr, /detail mode/u);
  });

  it('exits 2 when no command is given', async () => {
    const result = await runCli([]);
    assert.equal(result.code, CLI_EXIT.USAGE);
    assert.match(result.stderr, /USAGE/u);
    assert.match(result.stderr, /no command given/u);
  });

  it('rejects an unknown command without touching the network', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, statusPayload()));
    try {
      const result = await runCli(['frobnicate', '--config', join(makeTempDir(), 'absent.json')]);
      assert.equal(result.code, CLI_EXIT.USAGE);
      assert.match(result.stderr, /unknown command/u);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });

  it('rejects an unknown option', async () => {
    const result = await runCli(['status', '--force']);
    assert.equal(result.code, CLI_EXIT.USAGE);
    assert.match(result.stderr, /unknown option/u);
  });

  it('rejects an option that is missing its value', async () => {
    const result = await runCli(['status', '--config']);
    assert.equal(result.code, CLI_EXIT.USAGE);
    assert.match(result.stderr, /requires a value/u);
  });

  it('rejects an out-of-range timeout', async () => {
    const result = await runCli(['status', '--timeout', '5']);
    assert.equal(result.code, CLI_EXIT.USAGE);
    assert.match(result.stderr, /--timeout/u);
  });

  it('rejects --limit for a command that has no page size', async () => {
    const result = await runCli(['status', '--limit', '5']);
    assert.equal(result.code, CLI_EXIT.USAGE);
    assert.match(result.stderr, /--limit/u);
  });

  it('exits 3 when no configuration can be found', async () => {
    const result = await runInProcess(['status'], { env: {} });
    assert.equal(result.code, CLI_EXIT.CONFIG);
    assert.match(result.stderr, /CONFIG_NOT_FOUND/u);
  });
});

describe('aegis-cli: status', () => {
  it('renders a human summary', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, statusPayload()));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.match(result.stdout, /lifecycle=running/u);
      assert.match(result.stdout, /health\s+ok/u);
      assert.match(result.stdout, /windows\.security\.4688/u);
      assert.equal(result.stdout.includes('csrf-must-not-be-printed'), false);
      assert.equal(result.stderr, '');
    } finally {
      await mock.close();
    }
  });

  it('emits one stable JSON document with --json', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, statusPayload()));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['status', '--json', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      const document = parseJsonOutput(result.stdout);
      assert.equal(document.schema_version, '1.0');
      assert.equal(document.ok, true);
      assert.equal(document.command, 'status');
      assert.equal(document.data.daemon.lifecycle, 'running');
      assert.equal(document.data.csrf_token_present, true);
      assert.deepEqual(Object.keys(document.data.counters), ['events_received', 'polls']);
      assert.equal(result.stdout.includes('csrf-must-not-be-printed'), false);
    } finally {
      await mock.close();
    }
  });

  it('exits 5 on 401 and never prints the token', async () => {
    const mock = await startMock((request, res) => respondJson(res, 401, {
      error: { code: 'AUTH_FAILED', message: 'authentication required' },
    }));
    const directory = makeTempDir();
    const { configPath, token } = writeClientConfig(directory, { port: mock.port });
    try {
      const human = await runCli(['status', '--config', configPath]);
      assert.equal(human.code, CLI_EXIT.AUTH);
      assert.match(human.stderr, /AUTH/u);
      const json = await runCli(['status', '--json', '--config', configPath]);
      assert.equal(json.code, CLI_EXIT.AUTH);
      const document = parseJsonOutput(json.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.code, CLI_CODES.AUTH);
      assert.equal(document.error.exit_code, CLI_EXIT.AUTH);
      assert.equal(document.error.daemon_code, 'AUTH_FAILED');
      for (const output of [human.stdout, human.stderr, json.stdout, json.stderr]) {
        assert.equal(output.includes(token), false, 'the bearer token must never be printed');
      }
    } finally {
      await mock.close();
    }
  });

  it('exits 6 on 403', async () => {
    const mock = await startMock((request, res) => respondJson(res, 403, {
      error: { code: 'HOST_REJECTED', message: 'Host header is not the loopback endpoint' },
    }));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.FORBIDDEN);
      assert.match(result.stderr, /FORBIDDEN/u);
    } finally {
      await mock.close();
    }
  });
});

describe('aegis-cli: failure modes from the acceptance list', () => {
  it('exits 4 when no daemon is listening', async () => {
    // A port that was never bound, rather than one released a millisecond ago: reusing a
    // just-closed port invites a race with whatever the OS hands it to next.
    const port = await findClosedPort();
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port });
    const result = await runCli(['status', '--config', configPath]);
    assert.equal(result.code, CLI_EXIT.UNREACHABLE);
    assert.match(result.stderr, /UNREACHABLE/u);
    assert.match(result.stderr, /no daemon is listening/u);
  });

  it('exits 7 when the daemon never answers', async () => {
    /** @type {import('node:http').ServerResponse|null} */
    let held = null;
    const mock = await startMock((request, res) => {
      held = res;
    });
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port, timeoutMs: 150 });
    try {
      const started = Date.now();
      const result = await runCli(['status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.TIMEOUT);
      assert.match(result.stderr, /TIMEOUT/u);
      assert.ok(Date.now() - started < 8000);
    } finally {
      held?.destroy();
      await mock.close();
    }
  });

  it('exits 8 on malformed JSON', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, '{"lifecycle": "running", '));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      assert.match(result.stderr, /BAD_RESPONSE/u);
    } finally {
      await mock.close();
    }
  });

  it('exits 9 on an oversized response', async () => {
    const payload = Buffer.from(JSON.stringify({ ...statusPayload(), pad: 'x'.repeat(4096) }));
    const mock = await startMock((request, res) => respondRaw(res, 200, payload));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port, maxResponseBytes: 1024 });
    try {
      const result = await runCli(['status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.TOO_LARGE);
      assert.match(result.stderr, /RESPONSE_TOO_LARGE/u);
    } finally {
      await mock.close();
    }
  });

  it('exits 10 when the daemon has no read-only alerts endpoint', async () => {
    const mock = await startMock((request, res) => respondJson(res, 404, {
      error: { code: 'NOT_FOUND', message: 'no such endpoint' },
    }));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['alerts', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.UNSUPPORTED);
      assert.match(result.stderr, /ENDPOINT_UNAVAILABLE/u);
      assert.match(result.stderr, /read-only endpoint/u);
    } finally {
      await mock.close();
    }
  });

  it('refuses an unsafe analysis id before any request', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, {}));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['analysis', '../status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.USAGE);
      assert.match(result.stderr, /path traversal|must match/u);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });

  it('rejects an out-of-range --limit', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, { alerts: [] }));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['alerts', '--limit', '0', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.USAGE);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });

  it('exits 3 when the token file is missing', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, statusPayload()));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, {
      port: mock.port,
      tokenFile: join(directory, 'secrets', 'absent-token'),
    });
    try {
      const result = await runCli(['status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.CONFIG);
      assert.match(result.stderr, /CONFIG_NOT_FOUND/u);
      assert.equal(mock.requests.length, 0, 'a missing token must not produce a request');
    } finally {
      await mock.close();
    }
  });

  it('reads the configuration from AEGIS_CLI_CONFIG', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, statusPayload()));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['status'], { env: { AEGIS_CLI_CONFIG: configPath } });
      assert.equal(result.code, CLI_EXIT.OK);
    } finally {
      await mock.close();
    }
  });
});

describe('aegis-cli: health', () => {
  it('exits 0 when the daemon is ready', async () => {
    const mock = await startMock((request, res) => {
      if (request.url === '/healthz') {
        respondJson(res, 200, { status: 'ok', version: '0.0.0' });
        return;
      }
      respondJson(res, 200, { ready: true, lifecycle: 'running', reasons: [] });
    });
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['health', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.match(result.stdout, /readiness\s+ready=yes/u);
      assert.equal(mock.requests[0].headers.authorization, undefined);
    } finally {
      await mock.close();
    }
  });

  it('exits 13 when the daemon answers but is not ready', async () => {
    const mock = await startMock((request, res) => {
      if (request.url === '/healthz') {
        respondJson(res, 200, { status: 'degraded', version: '0.0.0' });
        return;
      }
      respondJson(res, 503, { ready: false, lifecycle: 'starting', reasons: ['lifecycle:starting'] });
    });
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const human = await runCli(['health', '--config', configPath]);
      assert.equal(human.code, CLI_EXIT.UNHEALTHY);
      assert.match(human.stderr, /UNHEALTHY/u);
      assert.match(human.stderr, /lifecycle:starting/u);

      const json = await runCli(['health', '--json', '--config', configPath]);
      assert.equal(json.code, CLI_EXIT.UNHEALTHY);
      const document = parseJsonOutput(json.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.code, CLI_CODES.UNHEALTHY);
      assert.equal(document.data.readiness.ready, false);
    } finally {
      await mock.close();
    }
  });
});

describe('aegis-cli: output encoding', () => {
  it('writes UTF-8 and preserves non-ASCII text end to end', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, statusPayload({
      scheduler: {
        sources: [{ id: '来源：中文日志', kind: 'auth-log', lifecycle: 'ok' }],
      },
    })));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.match(result.stdout, /来源：中文日志/u);
      // The bytes on the wire must be valid UTF-8 with no BOM.
      const roundTrip = new TextDecoder('utf-8', { fatal: true }).decode(result.stdoutBytes);
      assert.equal(roundTrip, result.stdout);
      assert.notEqual(result.stdoutBytes.toString('hex').slice(0, 6), 'efbbbf');
      const json = await runCli(['status', '--json', '--config', configPath]);
      const document = parseJsonOutput(json.stdout);
      assert.equal(document.data.scheduler.sources[0].id, '来源：中文日志');
    } finally {
      await mock.close();
    }
  });

  it('survives invalid UTF-8 in the response without corrupting the terminal', async () => {
    const body = Buffer.concat([
      Buffer.from('{"schema_version":"1.0","lifecycle":"running","version":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('","health":{"status":"ok","ready":true,"reasons":[]},"scheduler":{"sources":[]},"pipeline":{},"store":{"kind":"memory","open":true},"counters":{}}'),
    ]);
    const mock = await startMock((request, res) => respondRaw(res, 200, body));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['status', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.equal(result.stdout.includes('\uFFFD'), true);
    } finally {
      await mock.close();
    }
  });

  it('does not write anything into the configuration directory', async () => {
    const mock = await startMock((request, res) => {
      if (request.url === '/healthz') {
        respondJson(res, 200, { status: 'ok', version: '0.0.0' });
        return;
      }
      if (request.url === '/readyz') {
        respondJson(res, 200, { ready: true, lifecycle: 'running', reasons: [] });
        return;
      }
      respondJson(res, 200, statusPayload());
    });
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    const before = snapshotTree(directory);
    try {
      for (const command of ['status', 'health', 'status']) {
        const result = await runCli([command, '--config', configPath]);
        assert.equal(result.code, CLI_EXIT.OK);
      }
      assert.deepEqual(snapshotTree(directory), before, 'a read-only client must not touch the filesystem');
    } finally {
      await mock.close();
    }
  });
});

describe('aegis-cli: analysis and alerts happy paths', () => {
  it('renders a single analysis job', async () => {
    // Contract §6.2 field names: `state` (not `status`), plus `budget_class`,
    // `completed_at` and a boolean `report_available`.
    const mock = await startMock((request, res) => respondJson(res, 200, analysisDetail()));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['analysis', JOB_ID, '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.match(result.stdout, new RegExp(JOB_ID, 'u'));
      assert.match(result.stdout, /state\s+succeeded/u);
      assert.match(result.stdout, /budget_class\s+standard/u);
      assert.match(result.stdout, /report_available\s+yes/u);
      assert.equal(mock.requests[0].url, `/api/v1/analysis/${JOB_ID}`);
    } finally {
      await mock.close();
    }
  });

  it('renders an alert table', async () => {
    const rows = [
      alertRow({ alert_id: 'a1', rule_id: 'proc.suspicious-start', severity: 'high', status: 'new', count: 2 }),
      alertRow({ alert_id: 'a2', rule_id: 'net.beacon', severity: 'medium', status: 'new', count: 1 }),
    ];
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage(rows, { limit: 10 })));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['alerts', '--limit', '10', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.match(result.stdout, /returned=2/u);
      assert.match(result.stdout, /limit=10/u);
      assert.match(result.stdout, /proc\.suspicious-start/u);
      assert.match(result.stdout, /net\.beacon/u);
      assert.equal(mock.requests[0].url, '/api/v1/alerts?limit=10');
    } finally {
      await mock.close();
    }
  });

  it('prints a placeholder rather than an empty table', async () => {
    const mock = await startMock((request, res) => respondJson(res, 200, alertsPage([])));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['alerts', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.OK);
      assert.match(result.stdout, /no alerts returned/u);
      assert.match(result.stdout, /returned=0/u);
    } finally {
      await mock.close();
    }
  });

  it('refuses an empty list that has no page, because that is a broken body not an empty result', async () => {
    // `{ alerts: [] }` and a contract empty page both render nothing; only the second one
    // is allowed to exit 0. A client that accepted the first would report "no alerts" for
    // whatever reason the daemon failed to send a page — the exact confusion §5 exists to
    // prevent.
    const mock = await startMock((request, res) => respondJson(res, 200, { alerts: [] }));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      const result = await runCli(['alerts', '--config', configPath]);
      assert.equal(result.code, CLI_EXIT.BAD_RESPONSE);
      assert.match(result.stderr, /BAD_RESPONSE/u);
      assert.equal(result.stdout, '', 'a bad page must not render "no alerts returned"');
    } finally {
      await mock.close();
    }
  });

  it('says so when a page has more rows or was cut to fit the byte cap', async () => {
    // Contract §5: `has_more` and `byte_limited` are the page's own account. Deriving
    // "more" from `rows.length === limit` would miss a byte-limited page, which has fewer
    // rows *and* more data.
    let body = null;
    const mock = await startMock((request, res) => respondJson(res, 200, body));
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: mock.port });
    try {
      // `has_more` and a cursor are one statement in two halves (contract §4.1), so a page
      // that says "more" must carry one — otherwise the CLI refuses the page as a broken
      // body and this case would be testing the refusal instead of the note.
      body = alertsPage(ALERT_ROWS.slice(0, 1), { limit: 1, has_more: true, next_cursor: cursorToken('p2') });
      const more = await runCli(['alerts', '--limit', '1', '--config', configPath]);
      assert.equal(more.code, CLI_EXIT.OK);
      assert.match(more.stdout, /returned=1/u);
      assert.match(more.stdout, /has_more=yes/u);
      assert.match(more.stdout, /more rows are available/u);
      // The continuation is the *delta* plus the value on its own line, so an operator
      // adds one flag to the command they already ran instead of pasting a line that
      // would have to guess at --config/--timeout.
      assert.match(more.stdout, /continue with the same command plus --cursor/u);
      assert.match(more.stdout, /cursor\s+djF\./u);
      assert.equal(more.stdout.includes('byte_limited'), false, 'a full page is not byte limited');

      body = alertsPage(ALERT_ROWS.slice(0, 1), {
        limit: 2,
        has_more: true,
        next_cursor: cursorToken('p3'),
        byte_limited: true,
      });
      const capped = await runCli(['alerts', '--limit', '2', '--config', configPath]);
      assert.equal(capped.code, CLI_EXIT.OK);
      assert.match(capped.stdout, /byte_limited=yes/u);
      assert.match(capped.stdout, /has_more=yes/u);
    } finally {
      await mock.close();
    }
  });
});

describe('aegis-cli: configuration file handling', () => {
  it('reports invalid JSON in the configuration as exit 3', async () => {
    const directory = makeTempDir();
    const configPath = join(directory, 'broken.json');
    writeFileSync(configPath, '{ nope', 'utf8');
    const result = await runCli(['status', '--config', configPath]);
    assert.equal(result.code, CLI_EXIT.CONFIG);
    assert.match(result.stderr, /CONFIG_INVALID/u);
  });

  it('refuses a non-loopback endpoint as exit 3', async () => {
    const directory = makeTempDir();
    const configPath = join(directory, 'remote.json');
    writeFileSync(configPath, JSON.stringify({ endpoint: 'http://192.0.2.10:8443', tokenFile: 'x' }), 'utf8');
    const result = await runCli(['status', '--config', configPath]);
    assert.equal(result.code, CLI_EXIT.CONFIG);
    assert.match(result.stderr, /ENDPOINT_REJECTED/u);
  });
});
