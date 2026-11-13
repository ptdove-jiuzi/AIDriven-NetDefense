/**
 * api/sse.js — the server half of the console SSE contract (§3).
 *
 * The rules that are *not* negotiable, and where they are enforced:
 *
 * - **Framing** (§3.1): every event is `event: <name>\n` + `data: <one-line JSON>\n\n`.
 *   `JSON.stringify` escapes newlines, so "one line" is structural rather than a
 *   convention.
 * - **Sequence** (§3.1): `seq` starts at 1 and increments by exactly one per event.
 *   The allocator lives here so no handler can forget it or reuse a number; the
 *   comment-only heartbeat never consumes a `seq`.
 * - **Heartbeat**: `: ping\n\n` every 15 s, which is a comment, not an event — a
 *   client that "counts events" must not count it.
 * - **Timeouts** (§3.5, constants in code, not config): idle 90 s and total 300 s
 *   both end the stream with an `error` event (`UPSTREAM_TIMEOUT`); the header
 *   deadline (8 s) lives in `server.js` because it must answer with *JSON* before
 *   any SSE header exists.
 * - **Abort**: a `close` before a terminal event invokes `onAbort` exactly once;
 *   that callback is where quota release and `chat/cancel` live (§3.4).
 *
 * A failed write (socket gone, peer reset) is treated as an abort, never as a
 * thrown error: the route handler is already unwinding.
 */

/** Header deadline: request → `flushHeaders()`, then a JSON 503 (contract §3.5). */
export const SSE_HEADER_DEADLINE_MS = 8000;

/** Longest allowed silence between two events. */
export const SSE_IDLE_MS = 90000;

/** Longest allowed lifetime of one stream. */
export const SSE_TOTAL_MS = 300000;

/** How long a `tool.proposed` may wait for an approval decision. */
export const APPROVAL_TIMEOUT_MS = 120000;

/** Comment-only keepalive interval. */
export const SSE_HEARTBEAT_MS = 15000;

/** Event names the server may emit (contract §3.2). */
export const SSE_EVENTS = Object.freeze(['delta', 'tool', 'usage', 'done', 'error']);

/** Default action attached to a timeout error event. */
const TIMEOUT_ACTION = 'RETRY_LATER';

/**
 * Create the SSE channel for one response.
 *
 * @param {{
 *   res: import('node:http').ServerResponse,
 *   securityHeaders?: object,
 *   onAbort?: () => void,
 *   heartbeatMs?: number,
 *   idleMs?: number,
 *   totalMs?: number
 * }} options Options. The timeout overrides exist for tests only; production paths
 *   use the §3.5 constants.
 * @returns {object} Channel with `start`, `send`, `fail`, `end`, `isTerminal`, `state`.
 */
export function createSseStream(options) {
  const res = options.res;
  const securityHeaders = options.securityHeaders ?? {};
  const onAbort = typeof options.onAbort === 'function' ? options.onAbort : null;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const idleMs = options.idleMs ?? SSE_IDLE_MS;
  const totalMs = options.totalMs ?? SSE_TOTAL_MS;

  let seq = 0;
  let sentEvents = 0;
  let started = false;
  let finished = false;
  /** @type {'done'|'error'|'aborted'|null} */
  let terminalEvent = null;
  let heartbeatTimer = null;
  let idleTimer = null;
  let totalTimer = null;

  // A client may disconnect **before** `start()`: chat.js creates the channel, then
  // awaits the engine (`openStream`) for as long as the child takes, and only then
  // flushes the SSE headers. Registering the `close` listener inside `start()` left
  // that whole window unobserved — the socket was already gone, `start()` later
  // "succeeded" on a dead response, and the quota/approval/child were only released
  // by the idle (90 s) / total (300 s) timers. Attaching the listeners at creation
  // makes a pre-start disconnect an abort too (R4-002).
  //
  // A socket that died even before the channel existed (the handler does body/settings
  // work first) cannot emit a fresh `close` for a listener registered now, so the
  // current state is checked once as well.
  if (res.destroyed === true || res.writableEnded === true) {
    finish('aborted');
  } else {
    res.on('close', handleClose);
    res.on('error', () => {
      finish('aborted');
    });
  }

  function clearTimers() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (totalTimer !== null) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
  }

  /**
   * Mark the stream terminal and release resources.
   *
   * @param {'done'|'error'|'aborted'} reason Terminal reason.
   * @param {{endResponse?: boolean}} [flags] Whether to end the HTTP response.
   * @returns {void}
   */
  function finish(reason, flags = {}) {
    if (finished) {
      return;
    }
    finished = true;
    terminalEvent = reason;
    clearTimers();
    if (reason === 'aborted') {
      if (onAbort !== null) {
        try {
          onAbort();
        } catch {
          // The abort path runs from a socket event; it must never throw.
        }
      }
      return;
    }
    if (flags.endResponse !== false) {
      try {
        res.end();
      } catch {
        // Already closed.
      }
    }
  }

  function writeRaw(chunk) {
    if (res.writableEnded || res.destroyed) {
      return false;
    }
    try {
      res.write(chunk);
      return true;
    } catch {
      finish('aborted');
      return false;
    }
  }

  function armIdle() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      emitError('UPSTREAM_TIMEOUT', 'model stream stalled', {
        details: { limit_ms: idleMs, kind: 'IDLE' },
      });
    }, idleMs);
    idleTimer.unref?.();
  }

  function handleClose() {
    if (finished) {
      return;
    }
    finish('aborted');
  }

  /**
   * Emit one event and allocate its `seq`.
   *
   * @param {string} event Event name.
   * @param {object} data Payload.
   * @returns {object|null} Envelope written, or `null` when dropped.
   */
  function sendEvent(event, data) {
    if (!started || finished || !SSE_EVENTS.includes(event)) {
      return null;
    }
    seq += 1;
    sentEvents += 1;
    const envelope = { ...(data ?? {}), seq };
    const terminal = event === 'done' || event === 'error';
    if (terminal) {
      // Flip state before writing so a concurrent close cannot re-enter as an abort.
      finished = true;
      terminalEvent = event;
      clearTimers();
    }
    const line = `event: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
    if (terminal) {
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.write(line);
        } catch {
          // Peer already gone; nothing left to deliver.
        }
        try {
          res.end();
        } catch {
          // Already closed.
        }
      }
      return envelope;
    }
    if (!writeRaw(line)) {
      return null;
    }
    armIdle();
    return envelope;
  }

  /**
   * Emit an `error` event and end the stream.
   *
   * @param {string} code Stable error code.
   * @param {string} message English sentence, no upstream body.
   * @param {{retryable?: boolean, action?: string, details?: object}} [errorOptions] Payload extras.
   * @returns {object|null} The written envelope.
   */
  function emitError(code, message, errorOptions = {}) {
    return sendEvent('error', {
      code,
      message,
      retryable: errorOptions.retryable !== false,
      action: typeof errorOptions.action === 'string' ? errorOptions.action : TIMEOUT_ACTION,
      details: errorOptions.details ?? {},
    });
  }

  return {
    /**
     * Write the SSE headers and flush them. Must be the first write on the response.
     *
     * @returns {boolean} `true` when the stream started.
     */
    start() {
      if (started) {
        return !finished;
      }
      if (finished || res.headersSent) {
        // `finished` here means the client already disconnected before the stream
        // started: the abort path has run, so there is nothing to start (and writing
        // headers on the dead response would only throw).
        return false;
      }
      started = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        // The console host is a streaming proxy; a buffering intermediary would turn
        // token-by-token output into "nothing, then everything".
        'x-accel-buffering': 'no',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        ...securityHeaders,
      });
      res.flushHeaders?.();
      heartbeatTimer = setInterval(() => {
        if (!finished) {
          writeRaw(': ping\n\n');
        }
      }, heartbeatMs);
      heartbeatTimer.unref?.();
      totalTimer = setTimeout(() => {
        emitError('UPSTREAM_TIMEOUT', 'model stream exceeded its total budget', {
          details: { limit_ms: totalMs, kind: 'TOTAL' },
        });
      }, totalMs);
      totalTimer.unref?.();
      armIdle();
      return true;
    },

    /**
     * @param {string} event Event name, one of {@link SSE_EVENTS}.
     * @param {object} data Payload.
     * @returns {object|null} Envelope written.
     */
    send(event, data) {
      return sendEvent(event, data);
    },

    /**
     * @param {string} code Stable error code.
     * @param {string} message English sentence.
     * @param {{retryable?: boolean, action?: string, details?: object}} [errorOptions] Extras.
     * @returns {object|null} Envelope written.
     */
    fail(code, message, errorOptions) {
      return emitError(code, message, errorOptions);
    },

    /**
     * End the stream without emitting another event.
     *
     * @returns {void}
     */
    end() {
      if (!started) {
        return;
      }
      finish('done');
    },

    /** @returns {boolean} `true` once the stream is terminal. */
    isTerminal: () => finished,

    /**
     * State for logging and tests: counts and enumerations only, never payload text.
     *
     * @returns {{seq: number, sentEvents: number, started: boolean, finished: boolean,
     *   terminalEvent: string|null, headersFlushed: boolean}} State.
     */
    state: () => ({
      seq,
      sentEvents,
      started,
      finished,
      terminalEvent,
      headersFlushed: res.headersSent === true,
    }),
  };
}
