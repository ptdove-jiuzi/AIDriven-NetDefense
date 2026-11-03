/**
 * log.js — structured line logging with a hard redaction boundary.
 *
 * The daemon handles a bearer token and a CSRF token. Both must be impossible to
 * leak through a log line, a status response or an error message, so redaction is
 * applied centrally here rather than at every call site.
 *
 * Format: one JSON object per line on the provided stream. No colours, no ANSI,
 * no timestamps from the host locale — a log line must be parseable by a machine
 * and must not depend on the terminal.
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/** Keys whose values are always replaced before a record is emitted. */
const SECRET_KEY = /(token|secret|password|passwd|credential|authorization|cookie|api[-_]?key|private[-_]?key)/iu;

const REDACTED = '[redacted]';
const MAX_DEPTH = 4;

/**
 * Replace secret-looking values in a structured value.
 *
 * Cycles are cut with `[circular]` rather than throwing: logging must never be the
 * thing that takes the daemon down.
 *
 * @param {unknown} value Arbitrary value.
 * @param {number} [depth] Current depth.
 * @param {WeakSet<object>} [seen] Visited containers.
 * @returns {unknown} Redacted copy.
 */
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  if (depth >= MAX_DEPTH) {
    return '[depth-limit]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((item) => redact(item, depth + 1, seen));
  }
  if (value instanceof Error) {
    return { name: value.name, code: value.code ?? null, message: value.message };
  }
  const output = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    if (SECRET_KEY.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redact(value[key], depth + 1, seen);
  }
  return output;
}

/**
 * Create a logger.
 *
 * @param {{
 *   stream?: {write: (chunk: string) => unknown},
 *   level?: 'debug' | 'info' | 'warn' | 'error' | 'silent',
 *   clock?: {nowIso: () => string},
 *   bindings?: object
 * }} [options] Logger options.
 * @returns {object} Logger with level methods and `child`.
 */
export function createLogger(options = {}) {
  const stream = options.stream ?? process.stderr;
  const level = options.level ?? 'info';
  if (typeof LEVELS[level] !== 'number') {
    throw new TypeError(`unknown log level: ${String(level)}`);
  }
  const clock = options.clock ?? { nowIso: () => new Date().toISOString() };
  const bindings = Object.freeze({ ...(options.bindings ?? {}) });
  const threshold = LEVELS[level];

  function emit(levelName, message, fields) {
    if (LEVELS[levelName] < threshold) {
      return;
    }
    const record = {
      at: clock.nowIso(),
      level: levelName,
      msg: String(message),
    };
    Object.assign(record, redact(bindings), fields === undefined ? {} : redact(fields));
    try {
      stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // A broken stream (closed pipe, full disk) must not fail the operation that
      // was being logged. There is nowhere left to report this.
    }
  }

  return Object.freeze({
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    /** Derive a logger with extra bound fields (e.g. `{source_id}`). */
    child(extra) {
      return createLogger({ stream, level, clock, bindings: { ...bindings, ...(extra ?? {}) } });
    },
  });
}

/** Logger that discards everything; used as the default in tests. */
export const nullLogger = Object.freeze({
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
});
