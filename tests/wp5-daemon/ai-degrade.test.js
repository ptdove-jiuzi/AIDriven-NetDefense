/**
 * ai-degrade.test.js — the degradation matrix for `POST /api/v1/alerts/:id/explain`.
 *
 * This file answers one question with numbers instead of prose: **when the AI path
 * cannot run, what does the API actually do?** Four cells, each with an explicit
 * `expected` vs `actual` record:
 *
 * | cell | trigger                                     | expected                      |
 * |------|---------------------------------------------|-------------------------------|
 * | a    | `models.egressEnabled = false`               | 409 `EGRESS_DISABLED`         |
 * | b    | `provider.enabled = false`                   | 409 `PROVIDER_DISABLED`       |
 * | c    | non-loopback provider, no credential stored  | 409 `CREDENTIAL_MISSING`      |
 * | d    | the only provider points at a closed port    | structured `UPSTREAM_*` code  |
 *
 * Every cell asserts the two properties that make a refusal a refusal rather than a
 * fake answer:
 *
 * 1. `deltaCount === 0` — no token ever reached the client, so the console cannot
 *    render an invented explanation;
 * 2. `status !== 500` — a deterministic local refusal is not a server fault.
 *
 * ## "Zero network" is measured, not assumed
 *
 * Cells a–c point their provider `baseUrl` at a **live** sentinel socket that counts
 * TCP connections *and* first-byte arrivals. A count of 0 after a refusal is
 * evidence only if the witness can count, so the same file runs a positive control:
 * one deliberate dial to the witness must move the counter to >= 1.
 *
 * Cell c uses `https://localhost.:<port>/v1`: the trailing dot keeps the hostname
 * out of `isLoopbackHostname` (so a credential is required) while still resolving to
 * loopback, which lets the sentinel witness a dial that must not happen.
 *
 * ## Why there is no real provider here
 *
 * Zero-egress is a hard constraint (ACTIVE-NOTICE N-036 §3): every URL in this file
 * is `127.0.0.1`/`::1`/`localhost.`. No credential is fabricated or read; the only
 * "key" strings in this repository's AI tests are `fixture-not-a-real-provider-key-*`
 * canaries, and this file does not need even that.
 *
 * Run: `node --test tests/wp5-daemon/ai-degrade.test.js`
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseSseText,
  settingsDocument,
  startConsoleApi,
  waitFor,
} from './console-fixtures.mjs';

/** The real console host (not the stub): the degradation path must be the product's. */
const REAL_CONSOLE_HOST = fileURLToPath(new URL('../../apps/model-broker/bin/console-host.js', import.meta.url));

/** The alert the explain route is asked about. Twelve public fields, nothing raw. */
const ALERT_ID = 'a_deg_00000001';

/** Upstream codes a total provider outage may legitimately surface (contract §2.1). */
const UPSTREAM_CODES = Object.freeze(['UPSTREAM_FAILED', 'UPSTREAM_TIMEOUT']);

/** Collected evidence rows; filled by the cells, asserted by the summary test. */
const MATRIX = [];

/** Cleanup tasks registered by the cells. */
const CLEANUP = [];

after(async () => {
  for (const run of CLEANUP.splice(0).reverse()) {
    try {
      await run();
    } catch {
      // A leaked handle on Windows must not turn a failed assertion into a timeout.
    }
  }
});

/**
 * The alert row the explain route looks up, in `projectAlertForPrompt`'s input shape.
 *
 * @returns {object} Alert row.
 */
function alertRow() {
  return {
    alert_id: ALERT_ID,
    rule_id: 'rule-net-0042',
    rule_version: '3',
    severity: 'high',
    status: 'open',
    count: 17,
    first_seen: '2026-11-04T11:00:00.000Z',
    last_seen: '2026-11-04T11:59:30.000Z',
    window_start: '2026-11-04T11:00:00.000Z',
    window_end: '2026-11-04T12:00:00.000Z',
    event_ids: ['e_1', 'e_2', 'e_3'],
    // Deliberately present and deliberately NOT projected: proof the prompt cannot
    // grow this test's token budget through a field the console never showed.
    canonical_json: '{"secret_pointer":"never leaves the daemon"}',
    hostname: 'win-endpoint-07',
  };
}

/**
 * Start a live witness socket that counts connections and first-byte arrivals.
 *
 * Binds 127.0.0.1 and (when available) ::1 on the same port, so a name like
 * `localhost.` cannot dodge the witness by resolving to the other family.
 *
 * @returns {Promise<{port: number, counters: {connections: number, requests: number, bytes: number}, close: () => Promise<void>}>}
 *   Witness handle.
 */
async function startSentinel() {
  const counters = { connections: 0, requests: 0, bytes: 0 };
  /** @type {import('node:net').Server[]} */
  const servers = [];

  function handler(socket) {
    counters.connections += 1;
    socket.on('error', () => {});
    socket.once('data', (chunk) => {
      counters.bytes += chunk.length;
      counters.requests += 1;
      socket.destroy();
    });
    // A connection that never sends a byte still counts: absence of a request body
    // must not be able to hide an egress attempt.
    const timer = setTimeout(() => socket.destroy(), 500);
    timer.unref?.();
  }

  const primary = net.createServer(handler);
  await new Promise((resolve, reject) => {
    primary.once('error', reject);
    primary.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(primary);
  const address = primary.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    const secondary = net.createServer(handler);
    await new Promise((resolve, reject) => {
      secondary.once('error', reject);
      secondary.listen(port, '::1', () => resolve());
    });
    servers.push(secondary);
  } catch {
    // IPv6 loopback is not universally available; 127.0.0.1 is the primary witness.
  }

  return {
    port,
    counters,
    close: async () => {
      for (const server of servers) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  };
}

/**
 * Deliberately dial the witness once (positive control for the counter).
 *
 * @param {number} port Witness port.
 * @returns {Promise<string>} The failure reason observed (TLS to a plain socket).
 */
async function probeWitness(port) {
  try {
    await fetch(`https://localhost.:${port}/v1/chat/completions`, { method: 'POST' });
    return 'CONNECTED';
  } catch (error) {
    return String(error?.cause?.code ?? error?.name ?? 'ERROR');
  }
}

/**
 * Reserve a port, then close it, so the provider URL provably refuses connections.
 *
 * @returns {Promise<number>} A port nothing listens on.
 */
async function reserveClosedPort() {
  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Report whether a closed port really refuses (so "unavailable" is a fact).
 *
 * @param {number} port Port.
 * @returns {Promise<string>} `ECONNREFUSED` when nothing listens.
 */
function assertPortClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve('CONNECTED');
    });
    socket.once('error', (error) => resolve(String(error?.code ?? 'ERROR')));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve('TIMEOUT');
    });
  });
}

/**
 * Build a settings document with one provider + one model bound to it.
 *
 * @param {{baseUrl: string, allowLoopback: boolean, enabled?: boolean, egressEnabled?: boolean, pricing?: object|null, providerId?: string}} options Options.
 * @returns {object} Settings overrides.
 */
function providerSettings(options) {
  const providerId = options.providerId ?? 'lab-local';
  return {
    models: {
      egressEnabled: options.egressEnabled ?? true,
      providers: [{
        id: providerId,
        kind: 'openai-compatible',
        baseUrl: options.baseUrl,
        enabled: options.enabled ?? true,
        allowLoopback: options.allowLoopback === true,
        dailyInputTokens: 30000,
        dailyOutputTokens: 6000,
        pricing: options.pricing ?? null,
      }],
      models: [{
        id: 'lab-chat',
        providerId,
        tier: 'triage',
        maxInputTokens: 4096,
        maxOutputTokens: 256,
        costClass: 'free-local',
      }],
      routing: { mode: 'tiered', uniformModelId: null, defaultTier: 'triage' },
    },
  };
}

/**
 * Start the console API on an ephemeral loopback port with the real console host.
 *
 * @param {object} settings Settings overrides.
 * @returns {Promise<{harness: object, effective: object}>} Harness plus the document it actually loaded.
 */
async function startHarness(settings) {
  const harness = await startConsoleApi({
    settings,
    alerts: [alertRow()],
    hostPath: REAL_CONSOLE_HOST,
    requestTimeoutMs: 30000,
  });
  CLEANUP.push(() => harness.close());
  const effective = harness.settingsStore.current();
  // A silently-repaired settings file would make every later assertion meaningless:
  // assert the daemon really loaded what this file wrote, not the defaults.
  assert.equal(
    effective.models.providers[0]?.baseUrl,
    settingsDocument(settings).models.providers[0].baseUrl,
    'the daemon must load the provider URL this test wrote (a corrupt document would fall back to defaults)',
  );
  return { harness, effective };
}

/**
 * POST one explain request and normalize the answer, JSON or SSE.
 *
 * @param {object} harness Harness.
 * @returns {Promise<object>} Normalized observation.
 */
async function explainOnce(harness) {
  const response = await harness.sse(`/api/v1/alerts/${ALERT_ID}/explain`, {});
  let json = null;
  if (response.events.length === 0) {
    try {
      json = JSON.parse(response.text);
    } catch {
      json = null;
    }
  }
  const events = response.events.length > 0 ? response.events : parseSseText(response.text).events;
  const counts = { delta: 0, usage: 0, done: 0, error: 0, tool: 0 };
  for (const event of events) {
    if (Object.hasOwn(counts, event.event)) {
      counts[event.event] += 1;
    }
  }
  const errorEvent = events.find((event) => event.event === 'error') ?? null;
  const jsonError = json !== null && typeof json === 'object' ? json.error ?? null : null;
  return {
    status: response.status,
    contentType: String(response.headers.get('content-type') ?? ''),
    deltaCount: counts.delta,
    usageCount: counts.usage,
    doneCount: counts.done,
    errorCount: counts.error,
    eventNames: [...new Set(events.map((event) => event.event))],
    json,
    jsonCode: typeof jsonError?.code === 'string' ? jsonError.code : null,
    jsonDetails: jsonError?.details ?? null,
    sseErrorCode: typeof errorEvent?.data?.code === 'string' ? errorEvent.data.code : null,
    sseErrorAction: typeof errorEvent?.data?.action === 'string' ? errorEvent.data.action : null,
    /** The stable field the UI reads, whichever envelope carried it. */
    code: typeof jsonError?.code === 'string' ? jsonError.code : (typeof errorEvent?.data?.code === 'string' ? errorEvent.data.code : null),
  };
}

/**
 * Assert the two invariants every degrade cell must hold.
 *
 * @param {string} cell Cell id.
 * @param {object} observation Normalized observation.
 * @returns {void}
 */
function assertNoFakeAnswer(cell, observation) {
  assert.equal(
    observation.deltaCount,
    0,
    `[${cell}] a refused explanation must not stream any delta frame (expected 0, actual ${observation.deltaCount})`,
  );
  assert.notEqual(
    observation.status,
    500,
    `[${cell}] a deterministic local refusal must never be reported as an HTTP 500 (actual ${observation.status})`,
  );
}

/**
 * Record one matrix row for the summary test and print it as machine-readable evidence.
 *
 * @param {object} row Row.
 * @returns {void}
 */
function record(row) {
  MATRIX.push(row);
  console.log(`DEGRADE_CELL ${JSON.stringify(row)}`);
}

test('cell a: egress disabled → 409 EGRESS_DISABLED, zero dials', async () => {
  const sentinel = await startSentinel();
  CLEANUP.push(() => sentinel.close());

  const { harness } = await startHarness(providerSettings({
    baseUrl: `http://127.0.0.1:${sentinel.port}/v1`,
    allowLoopback: true,
    egressEnabled: false,
  }));
  const observation = await explainOnce(harness);

  assertNoFakeAnswer('a', observation);
  assert.equal(observation.status, 409, `[a] expected 409, actual ${observation.status}`);
  assert.equal(observation.code, 'EGRESS_DISABLED', `[a] expected EGRESS_DISABLED, actual ${observation.code}`);
  // The refusal is local and pre-child: no spawn, no quota consumed, no socket.
  assert.equal(harness.broker.stats().spawned, 0, '[a] egress gate must refuse before any console-host child exists');
  assert.equal(harness.explainLimiter.stats().window_starts, 0, '[a] a refused request must not consume the per-minute budget');
  assert.equal(sentinel.counters.connections, 0, `[a] sentinel must see 0 connections, actual ${sentinel.counters.connections}`);
  assert.equal(sentinel.counters.requests, 0, `[a] sentinel must see 0 requests, actual ${sentinel.counters.requests}`);

  record({
    cell: 'a',
    trigger: 'models.egressEnabled=false',
    expected: { status: 409, code: 'EGRESS_DISABLED', deltaCount: 0 },
    actual: {
      status: observation.status,
      code: observation.code,
      deltaCount: observation.deltaCount,
      eventNames: observation.eventNames,
      childSpawns: harness.broker.stats().spawned,
      explainWindowStarts: harness.explainLimiter.stats().window_starts,
      sentinelConnections: sentinel.counters.connections,
      sentinelRequests: sentinel.counters.requests,
    },
  });
});

test('cell b: provider disabled → 409 PROVIDER_DISABLED, zero dials', async () => {
  const sentinel = await startSentinel();
  CLEANUP.push(() => sentinel.close());

  const { harness } = await startHarness(providerSettings({
    baseUrl: `http://127.0.0.1:${sentinel.port}/v1`,
    allowLoopback: true,
    enabled: false,
  }));
  const observation = await explainOnce(harness);

  assertNoFakeAnswer('b', observation);
  assert.equal(observation.status, 409, `[b] expected 409, actual ${observation.status}`);
  assert.equal(observation.code, 'PROVIDER_DISABLED', `[b] expected PROVIDER_DISABLED, actual ${observation.code}`);
  // The detail names the provider so the UI can open the right settings row.
  assert.equal(observation.jsonDetails?.providerId, 'lab-local', '[b] details.providerId must name the disabled provider');
  assert.equal(harness.broker.stats().spawned, 0, '[b] a disabled provider must refuse before any console-host child exists');
  assert.equal(harness.explainLimiter.stats().window_starts, 0, '[b] a refused request must not consume the per-minute budget');
  assert.equal(sentinel.counters.connections, 0, `[b] sentinel must see 0 connections, actual ${sentinel.counters.connections}`);
  assert.equal(sentinel.counters.requests, 0, `[b] sentinel must see 0 requests, actual ${sentinel.counters.requests}`);

  record({
    cell: 'b',
    trigger: 'provider.enabled=false',
    expected: { status: 409, code: 'PROVIDER_DISABLED', deltaCount: 0 },
    actual: {
      status: observation.status,
      code: observation.code,
      deltaCount: observation.deltaCount,
      eventNames: observation.eventNames,
      detailsProviderId: observation.jsonDetails?.providerId ?? null,
      childSpawns: harness.broker.stats().spawned,
      explainWindowStarts: harness.explainLimiter.stats().window_starts,
      sentinelConnections: sentinel.counters.connections,
      sentinelRequests: sentinel.counters.requests,
    },
  });
});

test('cell c: non-loopback provider without credential → 409 CREDENTIAL_MISSING, zero dials', async () => {
  const sentinel = await startSentinel();
  CLEANUP.push(() => sentinel.close());

  // `localhost.` (trailing dot) is not in the daemon's loopback set, so a credential
  // is required — yet it still resolves to loopback, so the witness can see a dial
  // that must not happen. Plain http is refused for such a host, so https it is.
  const baseUrl = `https://localhost.:${sentinel.port}/v1`;
  const { harness, effective } = await startHarness(providerSettings({
    baseUrl,
    allowLoopback: false,
  }));
  assert.equal(effective.models.providers[0].baseUrl, baseUrl, '[c] the non-loopback baseUrl must survive validation unchanged');

  const observation = await explainOnce(harness);

  assertNoFakeAnswer('c', observation);
  assert.equal(observation.status, 409, `[c] expected 409, actual ${observation.status}`);
  assert.equal(observation.code, 'CREDENTIAL_MISSING', `[c] expected CREDENTIAL_MISSING, actual ${observation.code}`);
  assert.equal(observation.jsonDetails?.providerId, 'lab-local', '[c] details.providerId must name the provider missing a credential');
  // One child exists (the credential pre-check runs inside it), but it dials nothing.
  assert.equal(harness.broker.stats().spawned, 1, `[c] the credential pre-check runs in exactly one child, actual ${harness.broker.stats().spawned}`);
  assert.equal(sentinel.counters.connections, 0, `[c] no TCP connection may reach the provider, actual ${sentinel.counters.connections}`);
  assert.equal(sentinel.counters.requests, 0, `[c] no request may reach the provider, actual ${sentinel.counters.requests}`);

  record({
    cell: 'c',
    trigger: 'non-loopback provider (https://localhost.:port) with no stored credential',
    expected: { status: 409, code: 'CREDENTIAL_MISSING', deltaCount: 0, sentinelConnections: 0 },
    actual: {
      status: observation.status,
      code: observation.code,
      deltaCount: observation.deltaCount,
      eventNames: observation.eventNames,
      detailsProviderId: observation.jsonDetails?.providerId ?? null,
      childSpawns: harness.broker.stats().spawned,
      sentinelConnections: sentinel.counters.connections,
      sentinelRequests: sentinel.counters.requests,
    },
  });

  // Positive control on a *separate* witness: prove the counter is live, so the 0
  // above means "nothing dialled" and not "the witness cannot count".
  const control = await startSentinel();
  CLEANUP.push(() => control.close());
  const dialError = await probeWitness(control.port);
  await waitFor(() => control.counters.connections >= 1, {
    timeoutMs: 4000,
    label: 'the positive control dial to reach the witness',
  });
  assert.ok(control.counters.connections >= 1, `[c-control] witness must count a deliberate dial, actual ${control.counters.connections}`);
  record({
    cell: 'c-control',
    trigger: `deliberate test dial to https://localhost.:${control.port}/v1 (liveness of the witness)`,
    expected: { sentinelConnections: '>=1' },
    actual: {
      sentinelConnections: control.counters.connections,
      sentinelRequests: control.counters.requests,
      dialError,
    },
  });
});

test('cell d: the only provider points at a closed port → structured UPSTREAM_* code, no 500', async () => {
  const closedPort = await reserveClosedPort();
  const closedProbe = await assertPortClosed(closedPort);
  assert.equal(closedProbe, 'ECONNREFUSED', `[d] the provider port must really be closed before the request, actual ${closedProbe}`);

  const { harness } = await startHarness(providerSettings({
    baseUrl: `http://127.0.0.1:${closedPort}/v1`,
    allowLoopback: true,
  }));

  const observation = await explainOnce(harness);

  assertNoFakeAnswer('d', observation);
  assert.ok(
    observation.code !== null && UPSTREAM_CODES.includes(observation.code),
    `[d] expected a structured upstream code in ${UPSTREAM_CODES.join('/')}, actual ${String(observation.code)}`,
  );
  assert.equal(observation.doneCount, 0, `[d] a failed provider must not emit a done frame, actual ${observation.doneCount}`);
  assert.equal(observation.usageCount, 0, `[d] a failed provider must not emit a usage frame, actual ${observation.usageCount}`);
  // Where the code arrived matters for the UI contract: a JSON 502/504 is what the
  // route promises *before* SSE headers; once headers are flushed the same code is
  // an `event: error` frame on a 200. Both are recorded below, neither is a 500.
  assert.ok(
    observation.jsonCode !== null || observation.sseErrorCode !== null,
    '[d] the failure must carry a stable code field in one of the two envelopes',
  );

  record({
    cell: 'd',
    trigger: `the only provider points at a closed loopback port (${closedPort})`,
    expected: { status: '502 or 504 (contract §2.1) OR an SSE error frame on 200', code: 'UPSTREAM_FAILED|UPSTREAM_TIMEOUT', deltaCount: 0 },
    actual: {
      status: observation.status,
      contentType: observation.contentType,
      envelope: observation.jsonCode !== null ? 'json' : 'sse-error-event',
      code: observation.code,
      sseErrorAction: observation.sseErrorAction,
      deltaCount: observation.deltaCount,
      doneCount: observation.doneCount,
      usageCount: observation.usageCount,
      eventNames: observation.eventNames,
      portWasClosedBefore: closedProbe,
    },
  });
});

test('summary: every gate-refused cell saw exactly zero provider requests', () => {
  const gated = MATRIX.filter((row) => ['a', 'b', 'c'].includes(row.cell));
  assert.equal(gated.length, 3, `expected 3 gate-refused cells, actual ${gated.length}`);
  for (const row of gated) {
    assert.equal(row.actual.sentinelConnections, 0, `[${row.cell}] expected 0 connections, actual ${row.actual.sentinelConnections}`);
    assert.equal(row.actual.sentinelRequests, 0, `[${row.cell}] expected 0 requests, actual ${row.actual.sentinelRequests}`);
  }
  const totalConnections = gated.reduce((sum, row) => sum + row.actual.sentinelConnections, 0);
  const totalRequests = gated.reduce((sum, row) => sum + row.actual.sentinelRequests, 0);
  assert.equal(totalConnections, 0, `gate-refused cells must total 0 connections, actual ${totalConnections}`);
  assert.equal(totalRequests, 0, `gate-refused cells must total 0 requests, actual ${totalRequests}`);

  const control = MATRIX.find((row) => row.cell === 'c-control');
  assert.ok(control !== undefined && control.actual.sentinelConnections >= 1, 'the witness liveness control must have counted a dial');

  console.log(`DEGRADE_SUMMARY ${JSON.stringify({
    gateRefusedCells: gated.map((row) => row.cell),
    totalConnections,
    totalRequests,
    witnessControlConnections: control?.actual?.sentinelConnections ?? null,
    cells: gated.map((row) => ({
      cell: row.cell,
      status: row.actual.status,
      code: row.actual.code,
      deltaCount: row.actual.deltaCount,
    })),
  })}`);
});

test('UI contract: a stable error code reaches the client for every refusal', () => {
  // The console needs one field to switch its copy on ("未配置模型" / "模型不可用"),
  // and it must not be a free-text message. Both envelopes carry `code`:
  //   JSON error:  {"error":{"code":"...","message":"...","details":{...}}}
  //   SSE error:   event: error / {"code":"...","message":"...","retryable":...,"action":"...","details":{...}}
  for (const row of MATRIX.filter((entry) => ['a', 'b', 'c', 'd'].includes(entry.cell))) {
    assert.ok(
      typeof row.actual.code === 'string' && /^[A-Z][A-Z_]+$/u.test(row.actual.code),
      `[${row.cell}] the client-visible code must be a stable SCREAMING_SNAKE token, actual ${String(row.actual.code)}`,
    );
  }
  const codes = MATRIX
    .filter((entry) => ['a', 'b', 'c', 'd'].includes(entry.cell))
    .map((entry) => entry.actual.code);
  // A console that receives one of these four codes can render "the AI path is off /
  // the model is unreachable" without parsing any English sentence, and the `action`
  // on the upstream failure cell names the settings page it should offer.
  assert.deepEqual(codes, ['EGRESS_DISABLED', 'PROVIDER_DISABLED', 'CREDENTIAL_MISSING', 'UPSTREAM_FAILED']);
  const failureAction = MATRIX.find((entry) => entry.cell === 'd')?.actual?.sseErrorAction ?? null;
  if (failureAction !== null) {
    assert.match(failureAction, /^[A-Z][A-Z_]+$/u, `[d] the upstream error action must be a stable enum, actual ${failureAction}`);
  }
  console.log(`DEGRADE_CODES ${JSON.stringify({ codes, upstreamAction: failureAction })}`);
});
