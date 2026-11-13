/**
 * ai-cost.test.js — what one alert explanation costs, measured end to end.
 *
 * The chain under test is the product's, not a mock:
 *
 *   POST /api/v1/alerts/:id/explain  (daemon)
 *     → broker-client → `apps/model-broker/bin/console-host.js` (real child)
 *       → chat-transport → fake OpenAI-compatible provider on 127.0.0.1
 *
 * The fake provider (`tests/ai/fake-provider.mjs`, owned by the fake-provider seat)
 * declares `usage: {prompt_tokens: 1234, completion_tokens: 456}`. The daemon turns
 * that into a `usage` SSE event with `totalTokens` and `estimatedCostUsd`; this file
 * recomputes both **from settings** and asserts the event agrees with the arithmetic.
 *
 * ## Where the price comes from
 *
 * `estimatedCostUsd` is computed by `api/chat.js::normalizeUsageEvent` (lines 450-470)
 * from `provider.pricing.{inputUsdPerMTok, outputUsdPerMTok}` — a value stored in the
 * operator's settings document (`apps/daemon/src/api/settings-schema.js`). This test
 * writes an **explicit, made-up fixture price table** (`0.5` / `1.5` USD per 1M
 * tokens). It is deliberately not any vendor's published price, and no real provider
 * price is fetched, embedded or implied anywhere in this file.
 *
 * The numbers below are pinned to a real measurement of this chain (Lead's
 * `evidence/ai/final/_probe-real-host.mjs`: real console host + fake provider):
 * `{promptTokens: 111, completionTokens: 22, totalTokens: 133, estimatedCostUsd:
 * 0.000089}`. The arithmetic is
 * `(111 × 0.5 + 22 × 1.5) / 1e6 = 88.5e-6`, rounded to six decimals → `0.000089`;
 * the test recomputes it rather than transcribing it, so a change in the formula
 * (`inputUsdPerMTok`/`outputUsdPerMTok` semantics, the `/1e6` scale, or the rounding)
 * turns this test red.
 *
 * With no price configured the contract says "null, never 0"; the second test proves
 * exactly that, because a `0` would render as "this was free" in the console.
 *
 * Run: `node --test tests/wp5-daemon/ai-cost.test.js`
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startFakeProvider } from '../ai/fake-provider.mjs';
import {
  EXPLAIN_FIELDS,
  buildExplainMessage,
  explainSystemPromptFor,
  projectAlertForPrompt,
} from '../../apps/daemon/src/api/explain.js';
import { parseSseText, startConsoleApi } from './console-fixtures.mjs';

/** The real console host: the cost must be measured on the shipping path. */
const REAL_CONSOLE_HOST = fileURLToPath(new URL('../../apps/model-broker/bin/console-host.js', import.meta.url));

/** The alert the explanation is generated from. */
const ALERT_ID = 'a_cost_00000001';

/** Provider id / model id used by the fixture settings (same ids as the Lead's probe). */
const PROVIDER_ID = 'ollama-local';
const MODEL_ID = 'local-chat';

/**
 * The fixture price table, in USD per 1,000,000 tokens.
 *
 * NOT a vendor price. It is the table the Lead's real-chain probe used, so the
 * expected value can be checked against a measurement that was taken independently
 * of this file: 111 × 0.5 + 22 × 1.5 = 88.5 micro-USD, rounded at six decimals.
 */
const FIXTURE_PRICING = Object.freeze({ inputUsdPerMTok: 0.5, outputUsdPerMTok: 1.5 });

/** The usage the fake provider declares (matches the Lead's probe). */
const FIXTURE_USAGE = Object.freeze({ prompt_tokens: 111, completion_tokens: 22 });

/** @type {(() => Promise<void>)[]} */
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
 * The alert row, including fields that must NOT reach the provider.
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
    evidence_truncated: false,
    // Containment canaries: none of these may appear in the outbound body.
    canonical_json: '{"secret_pointer":"never leaves the daemon"}',
    event_ids_json: '["e_1","e_2","e_3"]',
    hostname: 'win-endpoint-07',
    raw_log: 'RAW-LOG-LINE-MUST-NOT-LEAVE',
  };
}

/**
 * Settings with one loopback provider bound to a model, optionally priced.
 *
 * @param {string} baseUrl Fake provider base URL (`http://127.0.0.1:<port>/v1`).
 * @param {object|null} pricing Price table or `null`.
 * @returns {object} Settings overrides.
 */
function settingsFor(baseUrl, pricing) {
  return {
    models: {
      egressEnabled: true,
      providers: [{
        id: PROVIDER_ID,
        kind: 'openai-compatible',
        baseUrl,
        enabled: true,
        allowLoopback: true,
        dailyInputTokens: 30000,
        dailyOutputTokens: 6000,
        pricing,
      }],
      models: [{
        id: MODEL_ID,
        providerId: PROVIDER_ID,
        // `watch` matches the tier the Lead's probe reported for this configuration.
        tier: 'watch',
        maxInputTokens: 4096,
        maxOutputTokens: 256,
        // `costClass` is a closed enum in the schema (free-local|cheap|standard|
        // expensive); the pricing table, not this label, is what the estimate uses.
        costClass: 'standard',
      }],
      routing: { mode: 'tiered', uniformModelId: null, defaultTier: 'watch' },
    },
  };
}

/**
 * Start the console API against the real host and the fake provider.
 *
 * @param {string} baseUrl Provider base URL.
 * @param {object|null} pricing Price table.
 * @returns {Promise<object>} Harness.
 */
async function startHarness(baseUrl, pricing) {
  const harness = await startConsoleApi({
    settings: settingsFor(baseUrl, pricing),
    alerts: [alertRow()],
    hostPath: REAL_CONSOLE_HOST,
    requestTimeoutMs: 30000,
  });
  CLEANUP.push(() => harness.close());
  const effective = harness.settingsStore.current();
  assert.equal(effective.models.providers[0]?.baseUrl, baseUrl, 'the daemon must load the provider URL this test wrote');
  assert.deepEqual(effective.models.providers[0]?.pricing, pricing, 'the daemon must load the price table this test wrote');
  return harness;
}

/**
 * POST one explain request and parse the SSE stream.
 *
 * @param {object} harness Harness.
 * @returns {Promise<{status: number, events: object[], deltaCount: number}>} Observation.
 */
async function explain(harness) {
  const response = await harness.sse(`/api/v1/alerts/${ALERT_ID}/explain`, { locale: 'zh-CN' });
  const events = response.events.length > 0 ? response.events : parseSseText(response.text).events;
  return {
    status: response.status,
    events,
    deltaCount: events.filter((event) => event.event === 'delta').length,
    usage: events.filter((event) => event.event === 'usage'),
    done: events.filter((event) => event.event === 'done'),
    errors: events.filter((event) => event.event === 'error'),
  };
}

test('one explanation: provider usage → usage event totalTokens/estimatedCostUsd match our own arithmetic', async () => {
  const fake = await startFakeProvider({
    behaviors: { [MODEL_ID]: 'delta' },
    chunks: ['这条告警', '先看来源，再看窗口。'],
    gapMs: 0,
    usage: FIXTURE_USAGE,
  });
  CLEANUP.push(() => fake.close());

  const harness = await startHarness(fake.baseUrl, FIXTURE_PRICING);
  const promptTokens = FIXTURE_USAGE.prompt_tokens;
  const completionTokens = FIXTURE_USAGE.completion_tokens;
  const expectedTotal = promptTokens + completionTokens;
  const expectedCost = Math.round(
    ((promptTokens * FIXTURE_PRICING.inputUsdPerMTok) + (completionTokens * FIXTURE_PRICING.outputUsdPerMTok)) / 1_000_000 * 1_000_000,
  ) / 1_000_000;
  const formula = `(${promptTokens} × ${FIXTURE_PRICING.inputUsdPerMTok} + ${completionTokens} × ${FIXTURE_PRICING.outputUsdPerMTok}) / 1e6 = `
    + `${promptTokens * FIXTURE_PRICING.inputUsdPerMTok} + ${completionTokens * FIXTURE_PRICING.outputUsdPerMTok} = `
    + `${promptTokens * FIXTURE_PRICING.inputUsdPerMTok + completionTokens * FIXTURE_PRICING.outputUsdPerMTok} micro-USD → ${expectedCost} USD`;

  const observation = await explain(harness);

  // The request really left the daemon: the fake provider logged exactly one chat
  // completion, for the model this test configured. Without this, the numbers below
  // could be a locally fabricated envelope.
  assert.equal(observation.status, 200, `expected 200, actual ${observation.status}`);
  assert.equal(fake.count('/v1/chat/completions'), 1, `expected 1 provider request, actual ${fake.count('/v1/chat/completions')}`);
  assert.deepEqual(fake.modelsSeen(), [MODEL_ID], `expected the configured model to be dialled, actual ${JSON.stringify(fake.modelsSeen())}`);
  assert.equal(observation.deltaCount, 2, `expected 2 streamed deltas from the provider, actual ${observation.deltaCount}`);
  assert.equal(observation.errors.length, 0, 'the happy path must not carry an error frame');
  assert.equal(observation.usage.length, 1, `expected exactly one usage frame, actual ${observation.usage.length}`);
  assert.equal(observation.done.length, 1, `expected exactly one done frame, actual ${observation.done.length}`);

  const usage = observation.usage[0].data;
  assert.equal(usage.promptTokens, promptTokens, `expected promptTokens ${promptTokens}, actual ${usage.promptTokens}`);
  assert.equal(usage.completionTokens, completionTokens, `expected completionTokens ${completionTokens}, actual ${usage.completionTokens}`);
  assert.equal(
    usage.totalTokens,
    expectedTotal,
    `expected totalTokens ${promptTokens}+${completionTokens}=${expectedTotal}, actual ${usage.totalTokens}`,
  );
  assert.equal(
    usage.estimatedCostUsd,
    expectedCost,
    `estimatedCostUsd must equal the settings pricing arithmetic: ${formula} (actual ${usage.estimatedCostUsd})`,
  );
  // Guard against a float surprise: the value must also be the six-decimal literal a
  // reader (or the Lead's independent probe) can check by hand. 88.5e-6 rounds to 89e-6.
  assert.ok(
    Math.abs(usage.estimatedCostUsd - 0.000089) < 1e-12,
    `expected the rounded decimal 0.000089 USD, actual ${usage.estimatedCostUsd}`,
  );
  // Provider/model/tier are daemon-side facts the child never reports.
  assert.equal(usage.providerId, PROVIDER_ID, `expected providerId ${PROVIDER_ID}, actual ${usage.providerId}`);
  assert.equal(usage.modelId, MODEL_ID, `expected modelId ${MODEL_ID}, actual ${usage.modelId}`);
  assert.equal(usage.tier, 'watch', `expected tier watch (as the Lead's probe reported), actual ${usage.tier}`);
  assert.equal(observation.done[0].data.totalTokens, expectedTotal, `done.totalTokens must agree with usage: ${observation.done[0].data.totalTokens}`);

  // ---- the prompt that was actually sent (input-token source of truth) ----
  const record = fake.requests[0];
  assert.equal(typeof record.rawBody, 'string', 'the fake provider must have recorded the request body');
  const body = record.body;
  assert.ok(body !== null && typeof body === 'object', 'the outbound body must be JSON');
  assert.equal(body.model, MODEL_ID);
  assert.equal(body.stream, true, 'the explain route must request a stream');
  const messages = Array.isArray(body.messages) ? body.messages : [];
  assert.equal(messages.length, 2, `expected [system, user], actual ${messages.length}`);
  assert.equal(messages[0].role, 'system', 'the system prompt is a server constant and must lead the outbound messages');
  assert.equal(messages[1].role, 'user');

  // The user message must be exactly the twelve-field projection — no more, no less.
  const projection = projectAlertForPrompt(alertRow());
  assert.deepEqual(Object.keys(projection), [...EXPLAIN_FIELDS], 'the projection must carry exactly the twelve public fields');
  assert.equal(messages[1].content, buildExplainMessage(projection), 'the outbound user message must be the server-built 12-field projection');
  // The host appends its fixed language instruction to the daemon's system prompt
  // (console-host.js `normalizeChatRequest`); nothing else may be added.
  assert.equal(
    messages[0].content,
    `${explainSystemPromptFor('zh-CN')}\n\nReply in zh-CN.`,
    'the outbound system message must be the daemon constant plus the host\'s fixed locale instruction',
  );
  for (const canary of ['never leaves the daemon', 'RAW-LOG-LINE-MUST-NOT-LEAVE', 'win-endpoint-07']) {
    assert.equal(
      record.rawBody.includes(canary),
      false,
      `the outbound body must not carry the ${JSON.stringify(canary)} field (prompt containment)`,
    );
  }

  // ---- cost report, measured ----
  const promptChars = messages.reduce((sum, message) => sum + [...message.content].length, 0);
  const userChars = [...messages[1].content].length;
  const systemChars = [...messages[0].content].length;
  const report = {
    alertId: ALERT_ID,
    projectionFields: EXPLAIN_FIELDS.length,
    prompt: {
      systemChars,
      userChars,
      totalPromptChars: promptChars,
      // Order-of-magnitude only (a real tokenizer is provider-side); never used above.
      heuristicTokensAt4CharsPerToken: Math.ceil(promptChars / 4),
      providerDeclaredPromptTokens: usage.promptTokens,
    },
    output: {
      providerDeclaredCompletionTokens: usage.completionTokens,
      streamedDeltaFrames: observation.deltaCount,
      deltaText: observation.events.filter((event) => event.event === 'delta').map((event) => event.data.text).join(''),
    },
    totalTokens: usage.totalTokens,
    pricing: {
      source: 'settings.models.providers[].pricing (fixture value written by this test; NOT a vendor price)',
      inputUsdPerMTok: FIXTURE_PRICING.inputUsdPerMTok,
      outputUsdPerMTok: FIXTURE_PRICING.outputUsdPerMTok,
    },
    estimatedCostUsd: usage.estimatedCostUsd,
    formula,
    thousandExplanationsUsd: Math.round(usage.estimatedCostUsd * 1000 * 1_000_000) / 1_000_000,
    providerRequestCount: fake.count('/v1/chat/completions'),
  };
  console.log(`COST_EVIDENCE ${JSON.stringify(report)}`);
});

test('no pricing configured: estimatedCostUsd is null (never 0), tokens still reported', async () => {
  const fake = await startFakeProvider({
    behaviors: { [MODEL_ID]: 'delta' },
    chunks: ['unpriced'],
    gapMs: 0,
    usage: FIXTURE_USAGE,
  });
  CLEANUP.push(() => fake.close());

  const harness = await startHarness(fake.baseUrl, null);
  const observation = await explain(harness);

  assert.equal(observation.status, 200, `expected 200, actual ${observation.status}`);
  assert.equal(fake.count('/v1/chat/completions'), 1, `expected 1 provider request, actual ${fake.count('/v1/chat/completions')}`);
  assert.equal(observation.usage.length, 1, 'an unpriced provider must still report tokens');
  const usage = observation.usage[0].data;
  assert.equal(usage.promptTokens, FIXTURE_USAGE.prompt_tokens, `expected promptTokens ${FIXTURE_USAGE.prompt_tokens}, actual ${usage.promptTokens}`);
  assert.equal(
    usage.totalTokens,
    FIXTURE_USAGE.prompt_tokens + FIXTURE_USAGE.completion_tokens,
    'totalTokens must not depend on pricing',
  );
  // Contract §6: "no price" is unknown, not free. A 0 here would render as a lie in
  // the console's cost column.
  assert.equal(usage.estimatedCostUsd, null, `expected null (not 0) when pricing is absent, actual ${JSON.stringify(usage.estimatedCostUsd)}`);
  console.log(`COST_UNPRICED ${JSON.stringify({
    providerId: usage.providerId,
    modelId: usage.modelId,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
  })}`);
});
