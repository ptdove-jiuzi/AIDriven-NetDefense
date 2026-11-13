/**
 * api/chat.js — `POST /api/v1/agent/chat` (SSE), `POST /api/v1/agent/approval`, and
 * the streaming core shared with `explain.js`.
 *
 * The chat route is where HTTP admission and a live model stream meet. Everything
 * that can be refused is refused before any SSE byte:
 *
 * 1. body shape and limits (§2.5): 1..40 messages, `user|assistant` only, 1..8000
 *    characters each, 32000 total, `sessionId` shape;
 * 2. model and provider existence (`MODEL_UNKNOWN` / `PROVIDER_UNKNOWN`);
 * 3. the zero-egress gate: `egressEnabled`, then provider `enabled`;
 * 4. engine availability (`ENGINE_UNAVAILABLE` with `details.tried`);
 * 5. concurrency (global 2, per session 1) → `CHAT_BUSY` + `retry-after`.
 *
 * Only then is a child spawned, and only after it acknowledged `chat/start` (which
 * includes the credential check for non-loopback providers) are the SSE headers
 * written. That ordering is what lets a 409/404/429 stay a JSON error body instead of
 * an `event: error` frame that a `fetch`-based reader cannot distinguish from a
 * truncated stream.
 *
 * ## Disconnect (§3.4)
 *
 * `res.on('close')` before a terminal event runs one cleanup path exactly once:
 * count the abort, release the quota, cancel pending approvals for the session, and
 * request `chat/cancel` — the broker client escalates to `SIGKILL` after 250 ms. The
 * log line carries ids and character counts only.
 *
 * ## Approval (§2.7)
 *
 * 0.0.1 has no executor. A `tool` event with `requiresApproval` is registered for at
 * most 120 s; the approval route only records the decision and answers
 * `executed:false, reason:EXECUTION_DISABLED`. An unanswered call auto-denies with
 * `APPROVAL_TIMEOUT`, so the console can never be stuck showing a pending action.
 */

import { randomBytes } from 'node:crypto';

import { CONSOLE_CODES, ConsoleError } from './console-errors.js';
import { systemPromptFor } from './chat-engine.js';
import { MODEL_ID_PATTERN, isLoopbackHostname } from './settings-schema.js';
import { APPROVAL_TIMEOUT_MS, createSseStream } from './sse.js';

/** `sessionId` grammar from contract §2.5. */
export const SESSION_ID_PATTERN = /^s_[0-9a-f]{32}$/u;

/** `callId` grammar: the broker's tool-call identifier. */
export const CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]{1,120}$/u;

/** Chat limits from contract §2.5. */
export const CHAT_LIMITS = Object.freeze({
  maxMessages: 40,
  maxContentChars: 8000,
  maxTotalChars: 32000,
  maxGlobalStreams: 2,
  maxPerSessionStreams: 1,
  retryAfterSeconds: 1,
});

/** Locales the API accepts for a chat turn. */
export const CHAT_LOCALES = Object.freeze(['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']);

/** Tool-call states from contract §3.2. */
const TOOL_STATES = Object.freeze(['proposed', 'approved', 'denied', 'result']);

/** Finish reasons from contract §3.2. */
const FINISH_REASONS = Object.freeze(['stop', 'length', 'tool_calls', 'cancelled']);

/**
 * Fixed English sentences for upstream failures.
 *
 * The broker is trusted, but an upstream body is not: a provider 500 can quote the
 * request (including our prompt). The client therefore sees a sentence chosen here
 * by code, never the upstream text.
 *
 * @param {string} code Upstream/error code.
 * @returns {string} Safe sentence.
 */
export function publicMessageFor(code) {
  switch (code) {
    case 'UPSTREAM_TIMEOUT':
      return 'the model provider did not answer in time';
    case 'UPSTREAM_REDIRECT':
      return 'the model provider tried to redirect the request';
    case 'CREDENTIAL_MISSING':
      return 'no credential is stored for this provider';
    case 'CREDENTIAL_INVALID':
      return 'the stored credential was rejected by the provider';
    case 'PROVIDER_DISABLED':
      return 'the provider is disabled';
    case 'EGRESS_DISABLED':
      return 'model egress is disabled';
    case 'UPSTREAM_FAILED':
      return 'the model provider failed';
    default:
      return 'the model request failed';
  }
}

/**
 * Count characters as code points, not UTF-16 units.
 *
 * @param {string} text Text.
 * @returns {number} Code-point length.
 */
export function charLength(text) {
  return [...text].length;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Throw `CHAT_INVALID` with an identifier-only detail.
 *
 * @param {string} field Field name or a fixed label.
 * @param {string} rule Short rule name.
 * @returns {never} Always throws.
 */
function chatInvalid(field, rule) {
  throw new ConsoleError(CONSOLE_CODES.CHAT_INVALID, 'chat request is not valid', { field, rule });
}

/**
 * Validate a chat request body against contract §2.5.
 *
 * @param {unknown} body Parsed JSON body.
 * @returns {{sessionId: string, modelId: string|null, locale: string|null, messages: {role: string, content: string}[]}}
 *   Validated request.
 */
export function parseChatBody(body) {
  if (!isPlainObject(body)) {
    chatInvalid('body', 'object');
  }
  const known = ['sessionId', 'modelId', 'locale', 'messages'];
  for (const key of Object.keys(body)) {
    if (!known.includes(key)) {
      chatInvalid(key.slice(0, 64), 'unknown_field');
    }
  }
  if (typeof body.sessionId !== 'string' || !SESSION_ID_PATTERN.test(body.sessionId)) {
    chatInvalid('sessionId', 'pattern');
  }
  let modelId = null;
  if (body.modelId !== undefined) {
    if (typeof body.modelId !== 'string' || !MODEL_ID_PATTERN.test(body.modelId)) {
      chatInvalid('modelId', 'pattern');
    }
    modelId = body.modelId;
  }
  let locale = null;
  if (body.locale !== undefined) {
    if (typeof body.locale !== 'string' || !CHAT_LOCALES.includes(body.locale)) {
      chatInvalid('locale', 'enum');
    }
    locale = body.locale;
  }
  if (!Array.isArray(body.messages)) {
    chatInvalid('messages', 'array');
  }
  if (body.messages.length < 1 || body.messages.length > CHAT_LIMITS.maxMessages) {
    chatInvalid('messages', 'length');
  }
  let total = 0;
  const messages = body.messages.map((entry, index) => {
    if (!isPlainObject(entry)) {
      chatInvalid(`messages[${index}]`, 'object');
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'role' && key !== 'content') {
        chatInvalid(`messages[${index}].${key.slice(0, 32)}`, 'unknown_field');
      }
    }
    // `system` is refused on purpose: the system prompt is a daemon constant. Accepting
    // one would let a browser redefine the model's instructions per request.
    if (entry.role !== 'user' && entry.role !== 'assistant') {
      chatInvalid(`messages[${index}].role`, 'enum');
    }
    if (typeof entry.content !== 'string' || entry.content.length === 0) {
      chatInvalid(`messages[${index}].content`, 'string');
    }
    const length = charLength(entry.content);
    if (length > CHAT_LIMITS.maxContentChars) {
      chatInvalid(`messages[${index}].content`, 'max_length');
    }
    total += length;
    return { role: entry.role, content: entry.content };
  });
  if (total > CHAT_LIMITS.maxTotalChars) {
    chatInvalid('messages', 'total_length');
  }
  return { sessionId: body.sessionId, modelId, locale, messages };
}

/**
 * Select the model and provider for a request.
 *
 * @param {object} settings Settings document.
 * @param {string|null} requestedId Optional explicit model id.
 * @returns {{model: object, provider: object}} Selection.
 * @throws {ConsoleError} `MODEL_UNKNOWN` / `PROVIDER_UNKNOWN`.
 */
export function selectModelAndProvider(settings, requestedId) {
  const models = settings.models.models;
  let model = null;
  if (requestedId !== null) {
    model = models.find((entry) => entry.id === requestedId) ?? null;
    if (model === null) {
      throw new ConsoleError(CONSOLE_CODES.MODEL_UNKNOWN, 'model is not registered', { modelId: requestedId });
    }
  } else if (settings.models.routing.mode === 'uniform') {
    const uniform = settings.models.routing.uniformModelId;
    model = uniform === null ? null : (models.find((entry) => entry.id === uniform) ?? null);
  } else {
    model = models.find((entry) => entry.tier === settings.models.routing.defaultTier) ?? models[0] ?? null;
  }
  if (model === null) {
    throw new ConsoleError(CONSOLE_CODES.MODEL_UNKNOWN, 'no model is configured for this route', {
      modelId: requestedId,
    });
  }
  const provider = settings.models.providers.find((entry) => entry.id === model.providerId) ?? null;
  if (provider === null) {
    throw new ConsoleError(CONSOLE_CODES.PROVIDER_UNKNOWN, 'provider is not registered', {
      providerId: model.providerId,
    });
  }
  return { model, provider };
}

/**
 * Create the chat concurrency quota.
 *
 * @param {{maxGlobal?: number, maxPerSession?: number}} [options] Limits (tests).
 * @returns {{acquire: Function, release: Function, stats: Function}} Quota.
 */
export function createChatQuota(options = {}) {
  const maxGlobal = options.maxGlobal ?? CHAT_LIMITS.maxGlobalStreams;
  const maxPerSession = options.maxPerSession ?? CHAT_LIMITS.maxPerSessionStreams;
  let global = 0;
  /** @type {Map<string, number>} */
  const sessions = new Map();
  let rejected = 0;

  return {
    /**
     * @param {string} sessionId Session id.
     * @returns {boolean} `true` when a slot was taken.
     */
    acquire(sessionId) {
      const current = sessions.get(sessionId) ?? 0;
      if (global >= maxGlobal || current >= maxPerSession) {
        rejected += 1;
        return false;
      }
      global += 1;
      sessions.set(sessionId, current + 1);
      return true;
    },

    /**
     * @param {string} sessionId Session id.
     * @returns {void}
     */
    release(sessionId) {
      const current = sessions.get(sessionId) ?? 0;
      if (current <= 0) {
        return;
      }
      global = Math.max(0, global - 1);
      if (current === 1) {
        sessions.delete(sessionId);
      } else {
        sessions.set(sessionId, current - 1);
      }
    },

    stats: () => ({ global, sessions: sessions.size, rejected }),
  };
}

/**
 * Create the approval registry (§2.7).
 *
 * @param {{clock?: object, timeoutMs?: number, logger?: object}} [options] Options.
 * @returns {object} Registry with `register`, `decide`, `cancelSession`, `close`, `size`.
 */
export function createApprovalRegistry(options = {}) {
  const clock = options.clock;
  const timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const logger = options.logger ?? null;
  /** @type {Map<string, object>} */
  const entries = new Map();

  function nowIso() {
    if (typeof clock?.nowIso === 'function') {
      return clock.nowIso();
    }
    if (typeof clock?.nowMs === 'function') {
      return new Date(clock.nowMs()).toISOString();
    }
    return new Date().toISOString();
  }

  function clear(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entries.delete(entry.callId);
  }

  function emitDecision(entry, state, reason) {
    if (entry.channel === null) {
      return;
    }
    entry.channel.send('tool', {
      callId: entry.callId,
      state,
      decidedAt: nowIso(),
      ...(reason === null ? {} : { reason }),
    });
  }

  return {
    /**
     * Register a proposed tool call awaiting approval.
     *
     * @param {{callId: string, sessionId: string, channel: object}} input Proposal.
     * @returns {boolean} `false` when the call id is already registered.
     */
    register(input) {
      if (entries.has(input.callId)) {
        return false;
      }
      const entry = {
        callId: input.callId,
        sessionId: input.sessionId,
        channel: input.channel ?? null,
        timer: null,
        createdAt: nowIso(),
      };
      entry.timer = setTimeout(() => {
        clear(entry);
        emitDecision(entry, 'denied', 'APPROVAL_TIMEOUT');
        logger?.info?.('approval expired', { callId: entry.callId });
      }, timeoutMs);
      entry.timer.unref?.();
      entries.set(entry.callId, entry);
      return true;
    },

    /**
     * Record a decision.
     *
     * @param {{callId: string, sessionId: string, decision: 'approve'|'deny'}} input Decision.
     * @returns {object|null} The registry entry, or `null` when unknown/expired/mismatched.
     */
    decide(input) {
      const entry = entries.get(input.callId);
      if (entry === undefined || entry.sessionId !== input.sessionId) {
        return null;
      }
      clear(entry);
      const state = input.decision === 'approve' ? 'approved' : 'denied';
      emitDecision(entry, state, state === 'denied' ? 'USER_DENIED' : null);
      return entry;
    },

    /**
     * Drop every pending approval of a session (stream ended or aborted).
     *
     * @param {string} sessionId Session id.
     * @returns {number} How many were dropped.
     */
    cancelSession(sessionId) {
      let count = 0;
      for (const entry of [...entries.values()]) {
        if (entry.sessionId !== sessionId) {
          continue;
        }
        clear(entry);
        emitDecision(entry, 'denied', 'STREAM_CLOSED');
        count += 1;
      }
      return count;
    },

    /** Clear every timer (daemon shutdown). */
    close() {
      for (const entry of [...entries.values()]) {
        clear(entry);
      }
    },

    size: () => entries.size,
  };
}

/**
 * Normalize one broker tool event to the contract's §3.2 field set.
 *
 * @param {object} event Broker event.
 * @returns {object|null} Normalized payload, or `null` when the state is unknown.
 */
function normalizeToolEvent(event) {
  if (!TOOL_STATES.includes(event.state)) {
    return null;
  }
  const payload = { state: event.state };
  if (typeof event.callId === 'string' && event.callId.length <= 128) {
    payload.callId = event.callId;
  }
  if (event.state === 'proposed') {
    if (typeof event.name === 'string') {
      payload.name = event.name.slice(0, 64);
    }
    payload.arguments = isPlainObject(event.arguments) ? event.arguments : {};
    payload.requiresApproval = event.requiresApproval === true;
  } else {
    if (typeof event.decidedAt === 'string') {
      payload.decidedAt = event.decidedAt.slice(0, 40);
    }
    if (event.state === 'denied' && typeof event.reason === 'string') {
      payload.reason = event.reason.slice(0, 64);
    }
    if (event.state === 'result') {
      payload.executed = event.executed === true;
      if (typeof event.reason === 'string') {
        payload.reason = event.reason.slice(0, 64);
      }
      payload.latencyMs = Number.isSafeInteger(event.latencyMs) ? event.latencyMs : 0;
    }
  }
  return payload;
}

/**
 * Normalize a `usage` event.
 *
 * The broker reports token counts only; provider/model/tier and the cost estimate are
 * daemon-side facts (the child does not read settings). `estimatedCostUsd` stays
 * `null` unless the provider has both prices configured — contract §6 forbids
 * inventing a price for a provider that has none.
 *
 * @param {object} event Broker event.
 * @param {{provider: object, model: object}} context Selected provider/model.
 * @returns {object} Usage payload.
 */
function normalizeUsageEvent(event, context) {
  const integer = (value) => (Number.isSafeInteger(value) ? value : 0);
  const pricing = context.provider.pricing;
  const promptTokens = integer(event.promptTokens);
  const completionTokens = integer(event.completionTokens);
  let estimatedCostUsd = null;
  if (pricing !== null && typeof pricing === 'object'
    && typeof pricing.inputUsdPerMTok === 'number' && typeof pricing.outputUsdPerMTok === 'number') {
    const cost = (promptTokens * pricing.inputUsdPerMTok + completionTokens * pricing.outputUsdPerMTok) / 1_000_000;
    estimatedCostUsd = Math.round(cost * 1_000_000) / 1_000_000;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: integer(event.totalTokens ?? (promptTokens + completionTokens)),
    estimatedCostUsd,
    providerId: context.provider.id,
    modelId: context.model.id,
    tier: context.model.tier,
  };
}

/**
 * Run one streaming turn: open the child stream, project broker events onto SSE, and
 * own the abort/terminal cleanup.
 *
 * Shared by `chat` and `explain` so the two streams cannot drift in framing, quota
 * release or abort semantics.
 *
 * @param {{
 *   ctx: object,
 *   engine: object,
 *   settings: object,
 *   model: object,
 *   provider: object,
 *   locale: string,
 *   messages: readonly object[],
 *   systemPrompt: string,
 *   approvals: object|null,
 *   sessionId: string|null,
 *   alertId: string|null,
 *   ensureQuota: () => boolean,
 *   releaseQuota: () => void,
 *   logFields: object,
 *   logger?: object,
 *   sseOptions?: object
 * }} turn Turn description.
 * @returns {Promise<void>} Resolves at a terminal state.
 */
export async function runStreamingTurn(turn) {
  const { ctx, engine, settings, model, provider, locale, messages, systemPrompt } = turn;
  const approvals = turn.approvals;
  const sessionId = turn.sessionId;
  const alertId = turn.alertId;
  const logger = turn.logger ?? null;
  const logFields = turn.logFields ?? {};

  let released = false;
  let accumulatedChars = 0;
  let streamHandle = null;
  /** @type {object[]} */
  const pendingEvents = [];
  let channelStarted = false;
  let finishing = false;
  let quotaTaken = false;

  const channel = createSseStream({
    res: ctx.res,
    securityHeaders: ctx.securityHeaders,
    ...(turn.sseOptions ?? {}),
    onAbort: () => {
      // Contract §3.4: count, release quota, drop approvals, cancel the child.
      logger?.info?.('chat.aborted', {
        ...logFields,
        events: channel.state().sentEvents,
        chars: accumulatedChars,
      });
      cleanup();
    },
  });

  function releaseQuota() {
    if (released) {
      return;
    }
    released = true;
    if (quotaTaken) {
      turn.releaseQuota();
    }
    if (approvals !== null && sessionId !== null) {
      approvals.cancelSession(sessionId);
    }
  }

  function cleanup() {
    releaseQuota();
    if (streamHandle !== null) {
      streamHandle.cancel().catch(() => {});
    }
  }

  function finishStream(finishReason) {
    if (finishing) {
      return;
    }
    finishing = true;
    releaseQuota();
    logger?.info?.('chat.completed', {
      ...logFields,
      events: channel.state().sentEvents,
      chars: accumulatedChars,
      finishReason: FINISH_REASONS.includes(finishReason) ? finishReason : 'stop',
    });
    if (streamHandle !== null) {
      streamHandle.finish().catch(() => {});
    }
  }

  function dispatchEvent(event) {
    if (!isPlainObject(event)) {
      return;
    }
    switch (event.type) {
      case 'delta': {
        const text = typeof event.text === 'string' ? event.text : '';
        if (text === '') {
          return;
        }
        accumulatedChars += charLength(text);
        channel.send('delta', { text });
        return;
      }
      case 'usage': {
        channel.send('usage', normalizeUsageEvent(event, { provider, model }));
        return;
      }
      case 'tool': {
        const payload = normalizeToolEvent(event);
        if (payload === null) {
          return;
        }
        channel.send('tool', payload);
        if (approvals !== null && sessionId !== null
          && payload.state === 'proposed' && payload.requiresApproval === true
          && typeof payload.callId === 'string') {
          approvals.register({ callId: payload.callId, sessionId, channel });
        }
        return;
      }
      case 'done': {
        const finishReason = FINISH_REASONS.includes(event.finishReason) ? event.finishReason : 'stop';
        channel.send('done', {
          finishReason,
          ...(sessionId === null ? {} : { sessionId }),
          ...(alertId === null ? {} : { alertId }),
          messageId: typeof event.messageId === 'string' ? event.messageId : `m_${randomHex(16)}`,
          totalTokens: Number.isSafeInteger(event.totalTokens) ? event.totalTokens : 0,
        });
        finishStream(finishReason);
        return;
      }
      case 'error': {
        const code = typeof event.code === 'string' ? event.code : 'UPSTREAM_FAILED';
        channel.fail(code, publicMessageFor(code), {
          retryable: event.retryable !== false,
          action: typeof event.action === 'string' ? event.action : 'RETRY_LATER',
          details: {},
        });
        finishStream('stop');
        return;
      }
      default:
        logger?.debug?.('chat event ignored', { type: String(event.type).slice(0, 32) });
    }
  }

  function onEvent(event) {
    if (!channelStarted) {
      pendingEvents.push(event);
      return;
    }
    dispatchEvent(event);
  }

  if (turn.ensureQuota() !== true) {
    // Refused before any header: the caller maps this to `CHAT_BUSY`.
    return { refused: true };
  }
  quotaTaken = true;

  const requestId = `str_${randomHex(16)}`;
  // Loopback providers may run without a key (local Ollama); every other provider must
  // have one, and the child checks that on the same connection before dialing, so the
  // refusal is still a JSON 409 rather than an SSE error frame.
  const loopback = isLoopbackHostname(safeHostname(provider.baseUrl));
  try {
    streamHandle = await engine.openStream({
      requestId,
      provider: {
        id: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        allowLoopback: provider.allowLoopback,
      },
      modelId: model.id,
      // Contract §1.1: prompt and locale are separate, daemon-owned fields; a `system`
      // message inside `messages` is refused by the child.
      systemPrompt,
      locale,
      temperature: settings.models.agent.temperature,
      maxOutputTokens: model.maxOutputTokens,
      messages,
    }, {
      requireCredential: !loopback,
      onEvent,
      onFault: (reason) => {
        if (channelStarted) {
          const code = 'UPSTREAM_FAILED';
          channel.fail(code, publicMessageFor(code), {
            retryable: true,
            action: 'RETRY_LATER',
            details: { reason: String(reason).slice(0, 32) },
          });
          finishStream('stop');
        }
      },
    });
  } catch (error) {
    releaseQuota();
    throw error;
  }

  // The server's 8 s header deadline may already have answered with JSON.
  if (ctx.deadline?.exceeded === true) {
    cleanup();
    return { refused: false };
  }
  if (!channel.start()) {
    cleanup();
    return { refused: false };
  }
  channelStarted = true;
  for (const event of pendingEvents.splice(0)) {
    dispatchEvent(event);
  }
  if (channel.isTerminal()) {
    return { refused: false };
  }
  await waitForTerminal(channel);
  if (!finishing) {
    // Timers/abort path: make sure the child is reaped and quota released.
    releaseQuota();
    if (streamHandle !== null) {
      streamHandle.cancel().catch(() => {});
    }
  }
  return { refused: false };
}

/**
 * Create the chat and approval handlers.
 *
 * @param {{
 *   settingsStore: object,
 *   engine: object,
 *   quota: object,
 *   approvals: object,
 *   clock: object,
 *   logger?: object,
 *   sseOptions?: object
 * }} options Options.
 * @returns {{chat: Function, approval: Function}} Handlers.
 */
export function createChatHandlers(options) {
  const settingsStore = options.settingsStore;
  const engine = options.engine;
  const quota = options.quota;
  const approvals = options.approvals;
  const clock = options.clock;
  const logger = options.logger ?? null;
  const sseOptions = options.sseOptions ?? {};

  /**
   * `POST /api/v1/agent/chat` — SSE stream.
   *
   * @param {object} ctx Request context.
   * @returns {Promise<void>} Resolves at a terminal state or after a JSON refusal.
   */
  async function chat(ctx) {
    const parsed = parseChatBody(ctx.body);
    const settings = settingsStore.current();
    const locale = parsed.locale ?? settings.ui.locale;
    const { model, provider } = selectModelAndProvider(settings, parsed.modelId);

    // Zero-egress gate, decided entirely locally (contract §2.5/§5). No child exists
    // for a refused request, so the provider port sees zero connections.
    if (settings.models.egressEnabled !== true) {
      throw new ConsoleError(CONSOLE_CODES.EGRESS_DISABLED, 'model egress is disabled', {});
    }
    if (provider.enabled !== true) {
      throw new ConsoleError(CONSOLE_CODES.PROVIDER_DISABLED, 'provider is disabled', { providerId: provider.id });
    }
    engine.requireEngine(settings.models.agent.engine);

    const outcome = await runStreamingTurn({
      ctx,
      engine,
      settings,
      model,
      provider,
      locale,
      messages: parsed.messages,
      systemPrompt: systemPromptFor(locale),
      approvals,
      sessionId: parsed.sessionId,
      alertId: null,
      ensureQuota: () => quota.acquire(parsed.sessionId),
      releaseQuota: () => quota.release(parsed.sessionId),
      logFields: { sessionId: parsed.sessionId },
      logger,
      sseOptions,
    });
    if (outcome.refused === true) {
      throw new ConsoleError(CONSOLE_CODES.CHAT_BUSY, 'too many concurrent chat streams', {
        sessionId: parsed.sessionId,
      }, { retryAfterSeconds: CHAT_LIMITS.retryAfterSeconds });
    }
  }

  /**
   * `POST /api/v1/agent/approval`.
   *
   * @param {{body: unknown}} ctx Request context.
   * @returns {Promise<object>} `{callId, decision, executed:false, reason}`.
   */
  async function approval(ctx) {
    if (!isPlainObject(ctx.body)) {
      throw new ConsoleError(CONSOLE_CODES.CHAT_INVALID, 'approval request is not valid', {
        field: 'body',
        rule: 'object',
      });
    }
    const known = ['sessionId', 'callId', 'decision'];
    for (const key of Object.keys(ctx.body)) {
      if (!known.includes(key)) {
        throw new ConsoleError(CONSOLE_CODES.CHAT_INVALID, 'approval request is not valid', {
          field: key.slice(0, 64),
          rule: 'unknown_field',
        });
      }
    }
    if (typeof ctx.body.sessionId !== 'string' || !SESSION_ID_PATTERN.test(ctx.body.sessionId)) {
      throw new ConsoleError(CONSOLE_CODES.CHAT_INVALID, 'approval request is not valid', {
        field: 'sessionId',
        rule: 'pattern',
      });
    }
    if (typeof ctx.body.callId !== 'string' || !CALL_ID_PATTERN.test(ctx.body.callId)) {
      throw new ConsoleError(CONSOLE_CODES.CHAT_INVALID, 'approval request is not valid', {
        field: 'callId',
        rule: 'pattern',
      });
    }
    if (ctx.body.decision !== 'approve' && ctx.body.decision !== 'deny') {
      throw new ConsoleError(CONSOLE_CODES.CHAT_INVALID, 'approval request is not valid', {
        field: 'decision',
        rule: 'enum',
      });
    }
    const entry = approvals.decide({
      callId: ctx.body.callId,
      sessionId: ctx.body.sessionId,
      decision: ctx.body.decision,
    });
    if (entry === null) {
      throw new ConsoleError(CONSOLE_CODES.CALL_UNKNOWN, 'approval call is unknown or expired', {
        callId: ctx.body.callId,
      });
    }
    // 0.0.1 has no executor: the decision is recorded, nothing runs (contract §2.7).
    logger?.info?.('approval recorded', { callId: entry.callId, decision: ctx.body.decision });
    return {
      callId: entry.callId,
      decision: ctx.body.decision,
      executed: false,
      reason: 'EXECUTION_DISABLED',
    };
  }

  return { chat, approval };
}

/**
 * Short hex string for ids (no secrets involved).
 *
 * @param {number} bytes Random bytes.
 * @returns {string} Hex string.
 */
function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Extract the hostname of a provider URL (used only to decide whether a credential is
 * required; loopback may run keyless).
 *
 * @param {string} baseUrl Provider base URL.
 * @returns {string} Hostname, or `''` when unparseable.
 */
function safeHostname(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Resolve once the SSE channel reaches a terminal state.
 *
 * Polling is deliberate: the terminal state is driven by response events (socket
 * close, timers, terminal frame) that are not promise-shaped, and threading a deferred
 * through every path is more state to get wrong. A 25 ms tick costs nothing on a token
 * stream that lives for seconds.
 *
 * @param {object} channel SSE channel.
 * @returns {Promise<void>} Resolves at termination.
 */
function waitForTerminal(channel) {
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (channel.isTerminal()) {
        clearInterval(tick);
        resolve();
      }
    }, 25);
    tick.unref?.();
  });
}
