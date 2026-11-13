/**
 * console-chat-sse.test.js — contract §2.5/§2.6/§3: streaming, framing, timeouts,
 * concurrency, disconnect cleanup and the approval route.
 *
 * These tests are written to fail if a mechanism is removed: dropping `seq`
 * allocation, the idle timer, the abort→cancel path, the prompt containment, or the
 * approval registry each turns at least one case red (mutation notes in the status
 * file). The disconnect case asserts a *pid*: the stub host ignores `chat/cancel`, so
 * only the 250 ms `SIGKILL` can satisfy it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import {
  createCaptureLogger,
  makeTempDir,
  openRawSse,
  parseSseText,
  processLiveness,
  readJsonIfPresent,
  readTextIfPresent,
  sessionIdFor,
  settingsDocument,
  startConsoleApi,
  waitFor,
  TEST_TOKEN,
} from './console-fixtures.mjs';

const SETTINGS_READY = (port, extra = {}) => settingsDocument({
  models: {
    egressEnabled: true,
    providers: [{
      id: 'ollama-local',
      kind: 'ollama',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      enabled: true,
      allowLoopback: true,
      dailyInputTokens: 30000,
      dailyOutputTokens: 6000,
      pricing: null,
    }],
    models: [{
      id: 'local-chat',
      providerId: 'ollama-local',
      tier: 'triage',
      maxInputTokens: 4096,
      maxOutputTokens: 512,
      costClass: 'free-local',
    }],
  },
  ...extra,
});

/** A minimal legal chat body. */
function chatBody(sessionId, overrides = {}) {
  return {
    sessionId,
    modelId: 'local-chat',
    messages: [{ role: 'user', content: 'what happened?' }],
    ...overrides,
  };
}

describe('POST /api/v1/agent/chat stream', () => {
  it('streams delta/usage/done with monotonic seq and SSE headers', async (t) => {
    const harness = await startConsoleApi({ settings: SETTINGS_READY(1) });
    t.after(() => harness.close());
    const response = await harness.sse('/api/v1/agent/chat', chatBody(sessionIdFor('seq')));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const names = response.events.map((event) => event.event);
    assert.deepEqual(names, ['delta', 'delta', 'usage', 'done']);
    const seqs = response.events.map((event) => event.data.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4]);
    assert.equal(response.events[0].data.text, 'hello ');
    assert.equal(response.events[1].data.text, 'world');
    assert.equal(response.events[2].data.totalTokens, 15);
    assert.equal(response.events[2].data.providerId, 'ollama-local');
    assert.equal(response.events[2].data.modelId, 'local-chat');
    assert.equal(response.events[2].data.tier, 'triage');
    assert.equal(response.events[2].data.estimatedCostUsd, null, 'no pricing means null, never 0');
    assert.equal(response.events[3].data.sessionId, sessionIdFor('seq'));
    assert.match(response.events[3].data.messageId, /^m_/u);
    assert.equal(response.events[3].data.finishReason, 'stop');
    // Every data line is a single-line JSON object.
    for (const event of response.events) {
      assert.equal(event.raw.includes('\n'), false);
    }
  });

  it('sends the daemon system prompt as a field and never as a client message', async (t) => {
    const dataDir = makeTempDir();
    const recordFile = join(dataDir, 'chat-start.json');
    const harness = await startConsoleApi({
      dataDir,
      settings: SETTINGS_READY(1),
      childEnv: { STUB_RECORD_FILE: recordFile },
    });
    t.after(() => harness.close());
    const response = await harness.sse('/api/v1/agent/chat', chatBody(sessionIdFor('prompt'), {
      locale: 'zh-CN',
    }));
    assert.equal(response.status, 200);
    await waitFor(() => readJsonIfPresent(recordFile) !== null, { label: 'chat/start recorded' });
    const recorded = readJsonIfPresent(recordFile);
    assert.equal(typeof recorded.systemPrompt, 'string');
    assert.ok(recorded.systemPrompt.length > 20);
    assert.equal(recorded.locale, 'zh-CN');
    assert.equal(recorded.messages.length, 1);
    assert.equal(recorded.messages[0].role, 'user');
    assert.equal(recorded.messages.every((message) => message.role !== 'system'), true);
  });

  it('refuses bad bodies with JSON CHAT_INVALID before any SSE byte', async (t) => {
    const harness = await startConsoleApi({ settings: SETTINGS_READY(1) });
    t.after(() => harness.close());
    const cases = [
      { sessionId: 'nope', messages: [{ role: 'user', content: 'x' }] },
      { sessionId: sessionIdFor('bad'), messages: [{ role: 'system', content: 'x' }] },
      { sessionId: sessionIdFor('bad'), messages: [] },
      { sessionId: sessionIdFor('bad'), messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })) },
      { sessionId: sessionIdFor('bad'), messages: [{ role: 'user', content: 'x'.repeat(8001) }] },
      { sessionId: sessionIdFor('bad'), unexpected: true, messages: [{ role: 'user', content: 'x' }] },
    ];
    for (const body of cases) {
      const response = await harness.request('/api/v1/agent/chat', { method: 'POST', body });
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 120));
      assert.match(response.headers.get('content-type') ?? '', /application\/json/u);
      assert.equal(response.body.error.code, 'CHAT_INVALID');
    }
  });

  it('refuses egress-disabled requests without spawning a child', async (t) => {
    const dataDir = makeTempDir();
    const spawnLog = join(dataDir, 'spawns.log');
    const settings = SETTINGS_READY(1);
    settings.models.egressEnabled = false;
    const harness = await startConsoleApi({
      dataDir,
      settings,
      childEnv: { STUB_SPAWN_LOG: spawnLog },
    });
    t.after(() => harness.close());
    const refused = await harness.request('/api/v1/agent/chat', {
      method: 'POST',
      body: chatBody(sessionIdFor('egress')),
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'EGRESS_DISABLED');
    assert.match(refused.headers.get('content-type') ?? '', /application\/json/u);
    assert.equal(readTextIfPresent(spawnLog), null, 'egress off must not spawn the broker');
  });

  it('refuses a disabled provider with PROVIDER_DISABLED', async (t) => {
    const settings = settingsDocument({
      models: {
        egressEnabled: true,
        providers: [{
          id: 'ollama-local',
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:9/v1',
          enabled: false,
          allowLoopback: true,
          dailyInputTokens: 30000,
          dailyOutputTokens: 6000,
          pricing: null,
        }],
        models: [{
          id: 'local-chat',
          providerId: 'ollama-local',
          tier: 'triage',
          maxInputTokens: 4096,
          maxOutputTokens: 512,
          costClass: 'free-local',
        }],
      },
    });
    const harness = await startConsoleApi({ settings });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/agent/chat', {
      method: 'POST',
      body: chatBody(sessionIdFor('disabled')),
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'PROVIDER_DISABLED');
  });

  it('refuses an unavailable engine and a missing model', async (t) => {
    const settings = SETTINGS_READY(1);
    settings.models.agent.engine = 'harness';
    const harness = await startConsoleApi({ settings });
    t.after(() => harness.close());
    const noEngine = await harness.request('/api/v1/agent/chat', {
      method: 'POST',
      body: chatBody(sessionIdFor('engine')),
    });
    assert.equal(noEngine.status, 503);
    assert.equal(noEngine.body.error.code, 'ENGINE_UNAVAILABLE');
    assert.deepEqual(noEngine.body.error.details.tried, ['harness']);

    const unknownModel = await harness.request('/api/v1/agent/chat', {
      method: 'POST',
      body: chatBody(sessionIdFor('model'), { modelId: 'not-a-model' }),
    });
    assert.equal(unknownModel.status, 404);
    assert.equal(unknownModel.body.error.code, 'MODEL_UNKNOWN');
  });

  it('answers 503 ENGINE_UNAVAILABLE when the broker host is absent', async (t) => {
    const dataDir = makeTempDir();
    const harness = await startConsoleApi({
      dataDir,
      settings: SETTINGS_READY(1),
      hostPath: join(dataDir, 'missing-host.js'),
    });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/agent/chat', {
      method: 'POST',
      body: chatBody(sessionIdFor('nohost')),
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'ENGINE_UNAVAILABLE');
  });

  it('requires a credential for a non-loopback provider, before any SSE header', async (t) => {
    const settings = settingsDocument({
      models: {
        egressEnabled: true,
        providers: [{
          id: 'remote',
          kind: 'openai-compatible',
          baseUrl: 'https://api.example.invalid/v1',
          enabled: true,
          allowLoopback: false,
          dailyInputTokens: 30000,
          dailyOutputTokens: 6000,
          pricing: null,
        }],
        models: [{
          id: 'remote-chat',
          providerId: 'remote',
          tier: 'triage',
          maxInputTokens: 4096,
          maxOutputTokens: 512,
          costClass: 'standard',
        }],
      },
    });
    const harness = await startConsoleApi({ settings });
    t.after(() => harness.close());
    const response = await harness.request('/api/v1/agent/chat', {
      method: 'POST',
      body: chatBody(sessionIdFor('cred'), { modelId: 'remote-chat' }),
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'CREDENTIAL_MISSING');
    assert.match(response.headers.get('content-type') ?? '', /application\/json/u);
  });

  it('enforces global and per-session concurrency with CHAT_BUSY', async (t) => {
    const harness = await startConsoleApi({
      settings: SETTINGS_READY(1),
      childEnv: { STUB_CHAT_MODE: 'sleep' },
      sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
    });
    t.after(() => harness.close());
    const first = await openRawSse(
      harness.address.port,
      '/api/v1/agent/chat',
      chatBody(sessionIdFor('busy-a')),
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    const second = await openRawSse(
      harness.address.port,
      '/api/v1/agent/chat',
      chatBody(sessionIdFor('busy-b')),
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    t.after(() => {
      first.request.destroy();
      second.request.destroy();
    });
    await first.onData((text) => text.includes('partial'));
    await second.onData((text) => text.includes('partial'));
    assert.equal(harness.chatQuota.stats().global, 2);

    const third = await harness.request('/api/v1/agent/chat', {
      method: 'POST',
      body: chatBody(sessionIdFor('busy-c')),
    });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'CHAT_BUSY');
    assert.equal(third.headers.get('retry-after'), '1');

    // Same session twice: the per-session limit applies even though a global slot is free
    // (release one first by cutting a stream).
    first.request.destroy();
    await waitFor(() => harness.chatQuota.stats().global === 1, { label: 'one slot released' });
    const sameSession = await harness.request('/api/v1/agent/chat', {
      method: 'POST',
      body: chatBody(sessionIdFor('busy-b')),
    });
    assert.equal(sameSession.status, 429);
    assert.equal(sameSession.body.error.code, 'CHAT_BUSY');
  });

  it('aborts, cancels and kills the child within 3s of a disconnect', async (t) => {
    const dataDir = makeTempDir();
    const pidFile = join(dataDir, 'child.pid');
    const capture = createCaptureLogger();
    const harness = await startConsoleApi({
      dataDir,
      settings: SETTINGS_READY(1),
      childEnv: { STUB_CHAT_MODE: 'sleep', STUB_PID_FILE: pidFile },
      logger: capture.logger,
      sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
    });
    t.after(() => harness.close());
    const sessionId = sessionIdFor('abort');
    const stream = await openRawSse(
      harness.address.port,
      '/api/v1/agent/chat',
      chatBody(sessionId),
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    await stream.onData((text) => text.includes('partial'));
    await waitFor(() => readTextIfPresent(pidFile) !== null, { label: 'stub pid recorded' });
    const pid = Number(readTextIfPresent(pidFile).trim());
    assert.ok(pid > 0);
    assert.equal(processLiveness(pid).alive, true);

    stream.request.destroy();
    // Assert cleanup within the contract's 3 s window (cancel + 250 ms SIGKILL + reap).
    const startedMs = Date.now();
    await waitFor(() => processLiveness(pid).alive === false, { timeoutMs: 3000, label: 'orphan child reaped' });
    const elapsed = Date.now() - startedMs;
    assert.ok(elapsed < 3000, `child survived ${elapsed}ms`);
    assert.equal(harness.chatQuota.stats().global, 0, 'quota must be released on abort');
    assert.equal(capture.text().includes('partial'), false, 'the abort log must not contain response text');
    assert.ok(capture.text().includes('chat.aborted'));

    // The daemon is still healthy: the API answers and the quota is free again.
    const models = await harness.request('/api/v1/models');
    assert.equal(models.status, 200);
    assert.equal(harness.chatQuota.stats().global, 0);
  });
});

describe('SSE framing details', () => {
  it('emits comment-only heartbeats and ends a stalled stream with UPSTREAM_TIMEOUT', async (t) => {
    const harness = await startConsoleApi({
      settings: SETTINGS_READY(1),
      childEnv: { STUB_CHAT_MODE: 'sleep' },
      sseOptions: { idleMs: 120, totalMs: 5000, heartbeatMs: 40 },
    });
    t.after(() => harness.close());
    const response = await harness.sse('/api/v1/agent/chat', chatBody(sessionIdFor('idle')));
    assert.equal(response.status, 200);
    assert.ok(response.comments.some((line) => line.trim() === ': ping'), 'heartbeat must be a comment');
    const last = response.events.at(-1);
    assert.equal(last.event, 'error');
    assert.equal(last.data.code, 'UPSTREAM_TIMEOUT');
    assert.equal(last.data.details.kind, 'IDLE');
    assert.equal(last.data.retryable, true);
    // The heartbeat never consumed a seq: only real events are numbered.
    const seqs = response.events.map((event) => event.data.seq);
    assert.deepEqual(seqs, seqs.map((_, index) => index + 1));
  });
});

describe('POST /api/v1/agent/approval', () => {
  it('records an approval for a proposed tool call without executing it', async (t) => {
    const harness = await startConsoleApi({
      settings: SETTINGS_READY(1),
      childEnv: { STUB_CHAT_MODE: 'tool' },
      sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
    });
    t.after(() => harness.close());
    const sessionId = sessionIdFor('approve');
    const stream = await openRawSse(
      harness.address.port,
      '/api/v1/agent/chat',
      chatBody(sessionId),
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    t.after(() => stream.request.destroy());
    await stream.onData((text) => text.includes('"state":"proposed"'));

    const approved = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: 'call_stub_1', decision: 'approve' },
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.body, {
      callId: 'call_stub_1',
      decision: 'approve',
      executed: false,
      reason: 'EXECUTION_DISABLED',
    });
    await stream.onData((text) => text.includes('"state":"approved"'));
    const events = parseSseText(stream.chunks()).events;
    const toolStates = events.filter((event) => event.event === 'tool').map((event) => event.data.state);
    assert.deepEqual(toolStates, ['proposed', 'approved']);

    const unknown = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: 'call_unknown', decision: 'approve' },
    });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.error.code, 'CALL_UNKNOWN');

    const badDecision = await harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: 'call_stub_1', decision: 'maybe' },
    });
    assert.equal(badDecision.status, 400);
    assert.equal(badDecision.body.error.code, 'CHAT_INVALID');
  });

  it('auto-denies a proposal that is never answered', async (t) => {
    const harness = await startConsoleApi({
      settings: SETTINGS_READY(1),
      childEnv: { STUB_CHAT_MODE: 'tool' },
      approvalTimeoutMs: 80,
      sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
    });
    t.after(() => harness.close());
    const stream = await openRawSse(
      harness.address.port,
      '/api/v1/agent/chat',
      chatBody(sessionIdFor('expire')),
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    t.after(() => stream.request.destroy());
    await stream.onData((text) => text.includes('"reason":"APPROVAL_TIMEOUT"'));
    const events = parseSseText(stream.chunks()).events;
    const denied = events.filter((event) => event.event === 'tool' && event.data.state === 'denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].data.reason, 'APPROVAL_TIMEOUT');
  });
});

describe('POST /api/v1/alerts/:id/explain', () => {
  const ALERT = {
    alert_id: 'a_explain_1',
    rule_id: 'proc.suspicious-start',
    rule_version: '1.0.0',
    severity: 'high',
    status: 'new',
    count: 3,
    first_seen: '2026-11-04T00:00:00.000Z',
    last_seen: '2026-11-04T00:05:00.000Z',
    window_start: '2026-11-04T00:00:00.000Z',
    window_end: '2026-11-04T00:15:00.000Z',
    event_ids: ['evt-secret-1', 'evt-secret-2'],
    event_ids_truncated: false,
    canonical_json: '{"raw":"must not travel"}',
  };

  it('streams an explanation whose prompt contains only projected fields', async (t) => {
    const dataDir = makeTempDir();
    const recordFile = join(dataDir, 'explain-start.json');
    const harness = await startConsoleApi({
      dataDir,
      settings: SETTINGS_READY(1),
      alerts: [ALERT],
      childEnv: { STUB_RECORD_FILE: recordFile },
    });
    t.after(() => harness.close());
    const response = await harness.sse('/api/v1/alerts/a_explain_1/explain', { locale: 'zh-CN' });
    assert.equal(response.status, 200);
    assert.equal(response.events.at(-1).event, 'done');
    assert.equal(response.events.at(-1).data.alertId, 'a_explain_1');

    await waitFor(() => readJsonIfPresent(recordFile) !== null, { label: 'explain prompt recorded' });
    const recorded = readJsonIfPresent(recordFile);
    assert.ok(recorded.systemPrompt.length > 20);
    assert.equal(recorded.messages.length, 1);
    const content = recorded.messages[0].content;
    for (const field of ['alert_id', 'severity', 'count', 'evidence_count', 'evidence_truncated']) {
      assert.ok(content.includes(`${field}:`), `prompt must carry ${field}`);
    }
    // The containment assertions: no event ids, no raw bodies, no canonical_json.
    assert.equal(content.includes('event_ids'), false);
    assert.equal(content.includes('evt-secret'), false);
    assert.equal(content.includes('canonical_json'), false);
    assert.equal(content.includes('must not travel'), false);
    assert.equal(content.includes('"a_explain_1"'), true);
  });

  it('answers 404 ALERT_NOT_FOUND as JSON and enforces the per-alert limit', async (t) => {
    const harness = await startConsoleApi({
      dataDir: makeTempDir(),
      settings: SETTINGS_READY(1),
      alerts: [ALERT],
      childEnv: { STUB_CHAT_MODE: 'sleep' },
      explainLimits: { perAlert: 1, perMinute: 20 },
      sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
    });
    t.after(() => harness.close());
    const missing = await harness.request('/api/v1/alerts/a_missing/explain', { method: 'POST', body: {} });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'ALERT_NOT_FOUND');
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/u);

    const first = await openRawSse(
      harness.address.port,
      '/api/v1/alerts/a_explain_1/explain',
      {},
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    t.after(() => first.request.destroy());
    await first.onData((text) => text.includes('partial'));
    const second = await harness.request('/api/v1/alerts/a_explain_1/explain', { method: 'POST', body: {} });
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, 'CHAT_BUSY');
    assert.equal(second.body.error.details.reason, 'ALERT_BUSY');
    first.request.destroy();
    await waitFor(() => harness.explainLimiter.stats().active === 0, { label: 'explain slot released' });
  });

  it('enforces the process-wide per-minute explain budget', async (t) => {
    const harness = await startConsoleApi({
      dataDir: makeTempDir(),
      settings: SETTINGS_READY(1),
      alerts: [ALERT],
      explainLimits: { perAlert: 1, perMinute: 2 },
    });
    t.after(() => harness.close());
    // Two complete explanations consume the rolling budget.
    const first = await harness.sse('/api/v1/alerts/a_explain_1/explain', {});
    assert.equal(first.events.at(-1).event, 'done');
    const second = await harness.sse('/api/v1/alerts/a_explain_1/explain', {});
    assert.equal(second.events.at(-1).event, 'done');
    const third = await harness.request('/api/v1/alerts/a_explain_1/explain', { method: 'POST', body: {} });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'CHAT_BUSY');
    assert.equal(third.body.error.details.reason, 'MINUTE_BUDGET');
  });
});
