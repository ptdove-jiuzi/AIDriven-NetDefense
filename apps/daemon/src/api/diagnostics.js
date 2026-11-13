/**
 * api/diagnostics.js — the support bundle behind `diagnostics.exportBundle`.
 *
 * 作者：PT-dove（OPS-DIAG 战役 · 席位 diag-bundle）
 *
 * Owner: OPS-DIAG-COMMANDER (OPS-DIAG 战役). This is the implementation behind the
 * signature the Lead wired into `daemon.js` / `server.js`:
 *
 *   createDiagnosticsHandlers(options) -> { exportDiagnosticsBundle }
 *
 *   options = {
 *     config,                 // loadConfig() result
 *     status: () => object,   // daemon status payload
 *     diagnostics: () => object,
 *     dataDir, storePath, clock, logger,
 *     onExported?: (iso: string) => void
 *   }
 *
 *   exportDiagnosticsBundle(ctx) -> Promise<{ filename, contentType, body, summary }>
 *
 * ## What "safe to email to support" means here
 *
 * The bundle is a support artifact: it leaves the machine. Every byte of it is
 * therefore treated as an egress boundary and built in three layers, each of which
 * is sufficient on its own for the patterns it owns:
 *
 * 1. **Field allowlists.** Log lines are parsed and rebuilt from a fixed field set;
 *    an unrecognised field is dropped, not copied. The `/status` and `diagnostics()`
 *    trees are rebuilt (deep copy) with secret-looking keys redacted and
 *    payload-like keys omitted, so an event/alert body can never be carried through
 *    just because a caller added it upstream.
 * 2. **Central text sanitizer.** Every retained string goes through one set of
 *    regexes: `sk-` keys, `Bearer …`, JWT (`eyJ…`), long base64url tokens, e-mails,
 *    and user names inside `C:\Users\…`, `C:/Users/…`, `/home/…`, `/Users/…` and
 *    `%USERPROFILE%`. Counts are recorded per rule and rendered into the bundle.
 * 3. **A final sweep over the serialized JSON.** The last pass re-checks the exact
 *    bytes that are about to be returned. If a path or a key slipped through one of
 *    the builders, it is redacted here and counted, so the body that goes out is
 *    the body that was checked (not a re-rendering of an earlier state).
 *
 * Limits are deliberate and independent of the caller: 4 MiB per bundle, 512 KiB
 * read per log file, 2 MiB read across all log files, 4 000 characters per text
 * value. When a limit bites, `truncated` says so; a bundle that quietly dropped
 * half the evidence would be worse than no bundle.
 *
 * **Non-JSON log lines are dropped, not quoted.** Free text cannot be vouched for
 * by a field allowlist, and a desktop/installer text log is exactly where an alert
 * body or a user name can appear in prose (the daemon's own logger at `../log.js`
 * writes 100% JSON lines, so the daemon loses nothing). The bundle keeps the fact
 * that lines existed — file, byte count, `skipped_lines`, `non_json: DROPPED` —
 * without reproducing them.
 *
 * The database is opened **read-only** with `node:sqlite` and a missing/absent file
 * is reported (`available: false`, `reason`), never thrown: in mock mode there is no
 * database, and a support export that 500s in mock mode is useless exactly when it
 * is needed.
 */

import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DaemonError, DAEMON_CODES } from '../errors.js';

/** Schema marker of the bundle document (not the SQLite schema). */
export const BUNDLE_SCHEMA = 'aegis-diagnostics-bundle/1';

/** Hard cap for the whole rendered bundle. */
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

/** How much of one log file is read (tail only). */
export const MAX_LOG_FILE_BYTES = 512 * 1024;

/** How much is read across every candidate log file. */
export const MAX_LOG_TOTAL_BYTES = 2 * 1024 * 1024;

/** Longest single text value kept in the bundle. */
export const MAX_TEXT_CHARS = 4000;

/** Non-JSON lines are never quoted; this is the policy name reported in the bundle. */
export const NON_JSON_POLICY = 'DROPPED';

/** Total parsed/text lines kept across all files. */
export const MAX_TOTAL_LINES = 5000;

/** Log window reported by the bundle. */
export const LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Fields kept from a JSON log line. Everything else is dropped. */
export const LOG_FIELDS = Object.freeze([
  'at',
  'level',
  'msg',
  'code',
  'reason',
  'state',
  'source',
  'source_id',
  'count',
  'host',
  'port',
  'limit',
  'pid',
  'ppid',
  'uptime_ms',
  'lifecycle',
  'mode',
  'version',
  'epoch',
  'duration_ms',
  'timeout_ms',
  'attempts',
  'status',
  'queue_depth',
  'events',
  'alerts',
  'findings',
  'dropped',
  'truncated',
  'retry_after_ms',
  'bytes',
  'error',
  'error_code',
  'phase',
  'rule',
  'decision',
  'outcome',
  'tick_ms',
]);

const LOG_FIELD_SET = new Set(LOG_FIELDS);

/**
 * Rule names reported in `redaction.rules`.
 *
 * The regex sources themselves are deliberately *not* serialized: a rule list that
 * quotes its own patterns is a rule list that can match the probe it is meant to
 * satisfy (a description containing `Bearer ` would trip the bundle's own check).
 */
export const REDACTION_RULE_IDS = Object.freeze([
  'sk_secret',
  'bearer_token',
  'bearer_scheme',
  'jwt',
  'long_base64url_token',
  'email',
  'windows_user_path',
  'windows_user_path_forward',
  'posix_home',
  'macos_user_path',
  'userprofile_env',
  'secret_field',
  'omitted_field',
  'final_sweep',
]);

/**
 * Counters for values a *limit* changed (truncation), kept apart from redaction.
 *
 * The distinction matters in the bundle: "we masked 600 user names" and "we dropped
 * half the log because it was too big" are different facts about the export, and a
 * single `redaction.total` that mixed them would overstate the redaction work.
 */
export const LIMIT_IDS = Object.freeze([
  'text_truncated',
  'log_line_capped',
  'log_bytes_capped',
  'log_total_bytes_capped',
  'bundle_size_capped',
]);

/** Keys whose *value* is a credential, wherever they appear. */
const SECRET_KEY = /(token|secret|password|passwd|credential|authorization|cookie|api[-_]?key|private[-_]?key|passphrase)/iu;

/**
 * Keys whose value is raw content (event/alert/chat text, prompts, payloads).
 *
 * A support bundle is not a data export: these are replaced by `[omitted]`, which
 * also keeps a future upstream change from turning `/status` into an event dump.
 */
const OMIT_KEY = /^(?:payload|payload_json|canonical_json|raw|raw_body|body|body_text|content|prompt|completion|messages|alert_message|event_message|evidence_json|query|sql)$/iu;

/** Suffix appended when a text value is cut to `MAX_TEXT_CHARS`. */
const TRUNCATION_SUFFIX = '[truncated]';

/** Cap for a single nested value in the status/diagnostics copy. */
const MAX_TREE_DEPTH = 8;
const MAX_TREE_KEYS = 200;
const MAX_TREE_ITEMS = 200;
/** Cap for a nested string that is not a log message (keeps the bundle readable). */
const MAX_NESTED_TEXT_CHARS = 4000;

/**
 * The sanitizer rules, in application order.
 *
 * Order matters: the path rules run before the generic long-token rule so a path
 * segment is reported as a path rule rather than swallowed as an opaque token.
 * The token rule runs last so it cannot eat a user name and hide which rule fired.
 */
const TEXT_RULES = Object.freeze([
  Object.freeze({
    id: 'windows_user_path',
    pattern: /([A-Za-z]:\\{1,2}Users\\)(?!<user>)([^\\/\s"']+)/gu,
    replace: (_match, prefix) => `${prefix}<user>`,
  }),
  Object.freeze({
    id: 'windows_user_path_forward',
    pattern: /([A-Za-z]:\/Users\/)(?!<user>)([^/\s"']+)/gu,
    replace: (_match, prefix) => `${prefix}<user>`,
  }),
  Object.freeze({
    id: 'posix_home',
    pattern: /(\/home\/)(?!<user>)([^/\s"']+)/gu,
    replace: (_match, prefix) => `${prefix}<user>`,
  }),
  Object.freeze({
    id: 'macos_user_path',
    // `C:/Users/x` is the Windows-forward rule's job; the lookbehind keeps this rule
    // from claiming it a second time (double counts make the summary lie).
    pattern: /(?<![A-Za-z]:)\/Users\/(?!<user>)([^/\s"']+)/gu,
    replace: () => '/Users/<user>',
  }),
  Object.freeze({
    id: 'userprofile_env',
    pattern: /%USERPROFILE%/giu,
    replace: () => '<userprofile>',
  }),
  Object.freeze({
    id: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{1,}/giu,
    replace: () => '[redacted]',
  }),
  Object.freeze({
    // The scheme word itself is removed even when the token after it was already
    // stripped by another writer (a log line that ends in `Bearer` is still a line
    // that names the credential scheme, and a bundle must not read like a token dump).
    id: 'bearer_scheme',
    pattern: /\bBearer\b/giu,
    replace: () => '[redacted]',
  }),
  Object.freeze({
    id: 'sk_secret',
    pattern: /\bsk-[A-Za-z0-9_-]{8,}/gu,
    replace: () => '[redacted]',
  }),
  Object.freeze({
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9._-]{16,}/gu,
    replace: () => '[redacted]',
  }),
  Object.freeze({
    id: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
    replace: () => '<email>',
  }),
  Object.freeze({
    id: 'long_base64url_token',
    pattern: /[A-Za-z0-9_-]{43,}/gu,
    replace: () => '[redacted]',
  }),
]);

/**
 * Rules re-applied to the serialized body (the egress boundary check).
 *
 * `long_base64url_token` is excluded here on purpose: on already-rendered JSON it
 * could rewrite a legitimate long identifier, while the tree pass has already
 * applied it to every retained string.
 */
const SWEEP_RULES = Object.freeze(TEXT_RULES.filter((rule) => rule.id !== 'long_base64url_token'));

/**
 * Create a redactor for one bundle.
 *
 * Counts are per-export, not per-process: two exports must not report each other's
 * hits, and the summary of export N must describe export N only.
 *
 * @returns {{text: Function, tree: Function, path: Function, sweep: Function, snapshot: Function, bump: Function}} Redactor.
 */
function createRedactor() {
  /** @type {Record<string, number>} */
  const counts = Object.create(null);
  /** @type {Record<string, number>} */
  const limits = Object.create(null);

  /**
   * @param {string} id Rule id.
   * @param {number} [n] Hit count.
   * @returns {void}
   */
  function bump(id, n = 1) {
    counts[id] = (counts[id] ?? 0) + n;
  }

  /**
   * Record one truncation (a limit changed the value, nothing was hidden).
   *
   * @param {string} id Limit id.
   * @param {number} [n] Count.
   * @returns {void}
   */
  function bumpLimit(id, n = 1) {
    limits[id] = (limits[id] ?? 0) + n;
  }

  /**
   * Apply one rule to a string, counting hits.
   *
   * The regex is recreated per call: a shared `/g` RegExp carries `lastIndex`
   * between calls, which would silently skip alternating matches.
   *
   * @param {string} input Input text.
   * @param {{id: string, pattern: RegExp, replace: Function}} rule Rule.
   * @returns {string} Sanitized text.
   */
  function applyRule(input, rule) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let hits = 0;
    const output = input.replace(pattern, (...args) => {
      hits += 1;
      return rule.replace(...args);
    });
    if (hits > 0) {
      bump(rule.id, hits);
    }
    return output;
  }

  /**
   * Sanitize one string value.
   *
   * @param {unknown} value Value.
   * @param {number} [maxChars] Length cap.
   * @returns {string|null} Sanitized text.
   */
  function text(value, maxChars = MAX_TEXT_CHARS) {
    if (value === null || value === undefined) {
      return null;
    }
    let output = String(value);
    for (const rule of TEXT_RULES) {
      output = applyRule(output, rule);
    }
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_TEXT_CHARS;
    if (output.length > limit) {
      bumpLimit('text_truncated');
      output = `${output.slice(0, Math.max(0, limit - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`;
    }
    return output;
  }

  /**
   * Deep-copy a value into the bundle's safe shape.
   *
   * This is the "deep copy then redact" step for `/status` and `diagnostics()`:
   * arrays and objects are rebuilt, secret keys become `[redacted]`, payload-like
   * keys become `[omitted]`, functions/symbols are dropped, cycles are cut.
   * The returned value shares no reference with the daemon's live state.
   *
   * @param {unknown} value Value.
   * @param {number} [depth] Current depth.
   * @param {WeakSet<object>} [seen] Visited containers.
   * @returns {unknown} Safe copy.
   */
  function tree(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) {
      return null;
    }
    const kind = typeof value;
    if (kind === 'string') {
      return text(value, MAX_NESTED_TEXT_CHARS);
    }
    if (kind === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (kind === 'boolean') {
      return value;
    }
    if (kind === 'bigint') {
      return String(value);
    }
    if (kind === 'function' || kind === 'symbol') {
      bump('omitted_field');
      return undefined;
    }
    if (depth >= MAX_TREE_DEPTH) {
      bump('omitted_field');
      return '[depth-limit]';
    }
    if (seen.has(value)) {
      bump('omitted_field');
      return '[circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value.slice(0, MAX_TREE_ITEMS)) {
        const safe = tree(item, depth + 1, seen);
        if (safe !== undefined) {
          items.push(safe);
        }
      }
      if (value.length > MAX_TREE_ITEMS) {
        bump('omitted_field');
      }
      return items;
    }
    const output = {};
    let kept = 0;
    for (const key of Object.keys(value)) {
      if (kept >= MAX_TREE_KEYS) {
        bump('omitted_field');
        break;
      }
      if (SECRET_KEY.test(key)) {
        bump('secret_field');
        output[key] = '[redacted]';
        kept += 1;
        continue;
      }
      if (OMIT_KEY.test(key)) {
        bump('omitted_field');
        output[key] = '[omitted]';
        kept += 1;
        continue;
      }
      const safe = tree(value[key], depth + 1, seen);
      if (safe !== undefined) {
        output[key] = safe;
        kept += 1;
      }
    }
    return output;
  }

  /**
   * Sanitize a filesystem path (user name masking only — the path itself stays,
   * because "where is the store?" is the first support question).
   *
   * @param {unknown} value Path.
   * @returns {string|null} Masked path.
   */
  function path(value) {
    return typeof value === 'string' ? text(value, 1024) : null;
  }

  /**
   * Final sweep over the serialized body.
   *
   * The replacements contain no quotes or backslashes, so a JSON document stays
   * valid JSON after the sweep. Returns the (possibly rewritten) text plus the hit
   * count so the caller can re-render the counts before returning.
   *
   * @param {string} body Serialized bundle.
   * @returns {{text: string, hits: number}} Swept body and hit count.
   */
  function sweep(body) {
    let output = body;
    let hits = 0;
    for (const rule of SWEEP_RULES) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let before = 0;
      output = output.replace(pattern, (...args) => {
        before += 1;
        return rule.replace(...args);
      });
      if (before > 0) {
        hits += before;
        bump('final_sweep', before);
      }
    }
    return { text: output, hits };
  }

  /**
   * @returns {{counts: Record<string, number>, total: number, limits: Record<string, number>}} Snapshot.
   */
  function snapshot() {
    const copy = {};
    let total = 0;
    for (const [key, value] of Object.entries(counts)) {
      copy[key] = value;
      total += value;
    }
    if (total > 0 && copy.final_sweep === undefined) {
      copy.final_sweep = 0;
    }
    return { counts: copy, total, limits: { ...limits } };
  }

  return { text, tree, path, sweep, snapshot, bump, bumpLimit };
}

/**
 * Read the daemon's declared version from `daemon.js`.
 *
 * The import is dynamic on purpose: `daemon.js` imports *this* module, so a static
 * import would create a module cycle and would also pull the whole daemon graph
 * into mock-mode processes that only want the bundle. The value is read once and
 * cached; a failed import is reported as `unknown` instead of taking the export
 * down (a support bundle that cannot name its own version is still useful).
 *
 * @returns {Promise<string>} Version string.
 */
let cachedDaemonVersion = null;
async function daemonVersion() {
  if (typeof cachedDaemonVersion === 'string') {
    return cachedDaemonVersion;
  }
  try {
    const module = await import('../daemon.js');
    cachedDaemonVersion = typeof module.DAEMON_VERSION === 'string' ? module.DAEMON_VERSION : 'unknown';
  } catch {
    cachedDaemonVersion = 'unknown';
  }
  return cachedDaemonVersion;
}

/**
 * Read `apps/daemon/package.json` (version + package name).
 *
 * @returns {{name: string|null, version: string|null}} Manifest fields.
 */
function daemonPackage() {
  try {
    const manifestUrl = new URL('../../package.json', import.meta.url);
    const manifest = JSON.parse(readFileSyncText(fileURLToPath(manifestUrl)));
    return {
      name: typeof manifest?.name === 'string' ? manifest.name : null,
      version: typeof manifest?.version === 'string' ? manifest.version : null,
    };
  } catch {
    return { name: null, version: null };
  }
}

/**
 * Read a text file with a byte cap, or return an empty string.
 *
 * Uses `readFileSync` through a tiny wrapper only so the rest of this module does
 * not need a second import; failures are non-fatal by design (the manifest is
 * informational).
 *
 * @param {string} filePath Path.
 * @returns {string} Text.
 */
function readFileSyncText(filePath) {
  return readFileSync(filePath, 'utf8');
}

/**
 * @param {unknown} value Candidate number.
 * @returns {number|null} Finite number or `null`.
 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value Candidate string.
 * @returns {string|null} String or `null`.
 */
function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pick numeric entries of an object (config sections are numbers by design; a
 * non-number is skipped rather than coerced).
 *
 * @param {unknown} source Source object.
 * @param {readonly string[]} keys Keys of interest.
 * @returns {Record<string, number>} Numeric subset.
 */
function numbersFrom(source, keys) {
  const output = {};
  if (source === null || typeof source !== 'object') {
    return output;
  }
  for (const key of keys) {
    const value = finite(source[key]);
    if (value !== null) {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Which files are candidates for the log section.
 *
 * Order is fixed (the shell's stderr first, then the daemon's rotated logs, then
 * the parent directory's logs) so the byte budget goes to the most useful file
 * first; a caller cannot reorder it.
 *
 * @param {string} dataDir Data directory.
 * @returns {{filePath: string, kind: string}[]} Candidates that exist.
 */
function candidateLogFiles(dataDir) {
  /** @type {{filePath: string, kind: string}[]} */
  const candidates = [];
  const seen = new Set();

  /**
   * @param {string} filePath Candidate path.
   * @param {string} kind Bucket name reported in the bundle.
   * @returns {void}
   */
  function push(filePath, kind) {
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return;
      }
      if (seen.has(filePath)) {
        return;
      }
      seen.add(filePath);
      candidates.push({ filePath, kind });
    } catch {
      // Missing candidate: expected, not an error.
    }
  }

  push(joinPath(dataDir, 'shell', 'daemon.stderr.log'), 'shell_stderr');
  for (const [directory, kind] of [
    [joinPath(dataDir, 'logs'), 'data_logs'],
    [joinPath(dataDir, '..', 'logs'), 'parent_logs'],
  ]) {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const name of entries
      .filter((entry) => entry.isFile() && /\.log$/iu.test(entry.name))
      .map((entry) => entry.name)
      .sort()) {
      push(joinPath(directory, name), kind);
    }
  }
  return candidates;
}

/**
 * Join path segments without importing `node:path`.
 *
 * Kept tiny and dependency-free; the separator follows the first absolute-looking
 * segment so a Windows path stays a Windows path.
 *
 * @param {...string} segments Segments.
 * @returns {string} Joined path.
 */
function joinPath(...segments) {
  const parts = segments.filter((segment) => typeof segment === 'string' && segment.length > 0);
  if (parts.length === 0) {
    return '';
  }
  const [first, ...rest] = parts;
  const separator = first.includes('\\') ? '\\' : '/';
  let output = first;
  for (const segment of rest) {
    if (output.endsWith('/') || output.endsWith('\\')) {
      output = `${output}${segment}`;
    } else {
      output = `${output}${separator}${segment}`;
    }
  }
  return output;
}

/**
 * Read the tail of a file, never more than `maxBytes`.
 *
 * When the file is larger than the cap the first (partial) line is dropped: a
 * half-line is not evidence, it is a parsing artifact.
 *
 * @param {string} filePath Path.
 * @param {number} maxBytes Byte cap.
 * @returns {{text: string, bytes: number, head_truncated: boolean}} Tail.
 */
function readTail(filePath, maxBytes) {
  const stat = statSync(filePath);
  const bytes = Math.min(stat.size, maxBytes);
  if (bytes <= 0) {
    return { text: '', bytes: 0, head_truncated: false };
  }
  const start = stat.size - bytes;
  const buffer = Buffer.allocUnsafe(bytes);
  const descriptor = openSync(filePath, 'r');
  try {
    readSync(descriptor, buffer, 0, bytes, start);
  } finally {
    closeSync(descriptor);
  }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline >= 0 ? text.slice(newline + 1) : '';
  }
  return { text, bytes, head_truncated: start > 0 };
}

/**
 * Rebuild one parsed log line from the field allowlist.
 *
 * @param {object} record Parsed JSON object.
 * @param {object} redactor Redactor.
 * @returns {{line: object, dropped: number}} Safe line and dropped-field count.
 */
function pickLogFields(record, redactor) {
  const line = {};
  let dropped = 0;
  for (const key of Object.keys(record)) {
    if (!LOG_FIELD_SET.has(key)) {
      dropped += 1;
      continue;
    }
    const value = record[key];
    if (value === null) {
      line[key] = null;
    } else if (typeof value === 'string') {
      line[key] = redactor.text(value);
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        line[key] = value;
      } else {
        dropped += 1;
      }
    } else if (typeof value === 'boolean') {
      line[key] = value;
    } else {
      // Arrays/objects inside a whitelisted field are not a value the bundle can
      // vouch for; dropping is safer than rendering someone else's payload.
      dropped += 1;
    }
  }
  return { line, dropped };
}

/**
 * Read and sanitize the recent log window.
 *
 * @param {{dataDir: string|null, nowMs: number, redactor: object}} input Input.
 * @returns {object} Log section.
 */
function buildLogSection(input) {
  const { dataDir, nowMs, redactor } = input;
  const section = {
    window_hours: 24,
    dirs_scanned: [],
    files: [],
    lines: [],
    truncated: false,
    reason: null,
    non_json_policy: NON_JSON_POLICY,
    totals: {
      files: 0,
      lines: 0,
      parsed_lines: 0,
      non_json_dropped: 0,
      bytes_read: 0,
      dropped_fields: 0,
      skipped_old_lines: 0,
      skipped_lines: 0,
    },
  };
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    section.reason = 'NO_DATA_DIR';
    return section;
  }
  section.dirs_scanned = [
    redactor.path(joinPath(dataDir, 'shell')),
    redactor.path(joinPath(dataDir, 'logs')),
    redactor.path(joinPath(dataDir, '..', 'logs')),
  ];

  const cutoff = nowMs - LOG_WINDOW_MS;
  let budget = MAX_LOG_TOTAL_BYTES;
  const candidates = candidateLogFiles(dataDir);
  for (const candidate of candidates) {
    if (budget <= 0) {
      section.truncated = true;
      section.reason = 'LOG_TOTAL_BYTES_CAP';
      redactor.bumpLimit('log_total_bytes_capped');
      break;
    }
    if (section.lines.length >= MAX_TOTAL_LINES) {
      section.truncated = true;
      section.reason = 'LOG_TOTAL_LINES_CAP';
      redactor.bumpLimit('log_total_bytes_capped');
      break;
    }
    let stat;
    try {
      stat = statSync(candidate.filePath);
    } catch {
      continue;
    }
    // A file untouched for the whole window cannot hold lines inside it.
    if (stat.mtimeMs < cutoff) {
      continue;
    }
    const perFile = Math.min(MAX_LOG_FILE_BYTES, budget);
    let read;
    try {
      read = readTail(candidate.filePath, perFile);
    } catch (error) {
      section.files.push({
        path: redactor.path(candidate.filePath),
        kind: candidate.kind,
        error: stringOrNull(error?.code) ?? 'READ_FAILED',
      });
      continue;
    }
    budget -= read.bytes;
    if (read.head_truncated) {
      section.truncated = true;
      redactor.bumpLimit('log_bytes_capped');
    }
    const entry = {
      path: redactor.path(candidate.filePath),
      kind: candidate.kind,
      size_bytes: stat.size,
      bytes_read: read.bytes,
      head_truncated: read.head_truncated,
      parsed_lines: 0,
      non_json_policy: NON_JSON_POLICY,
      dropped_fields: 0,
      skipped_old_lines: 0,
      skipped_lines: 0,
    };
    const filePathLabel = entry.path;
    for (const rawLine of read.text.split(/\r?\n/u)) {
      if (rawLine.trim() === '') {
        continue;
      }
      if (section.lines.length >= MAX_TOTAL_LINES) {
        section.truncated = true;
        section.reason = 'LOG_TOTAL_LINES_CAP';
        redactor.bumpLimit('log_total_bytes_capped');
        break;
      }
      const trimmed = rawLine.trim();
      let parsed = null;
      if (trimmed.startsWith('{')) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = null;
        }
      }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const at = typeof parsed.at === 'string' ? parsed.at : null;
        const atMs = at === null ? null : Date.parse(at);
        if (atMs !== null && Number.isFinite(atMs) && atMs < cutoff) {
          entry.skipped_old_lines += 1;
          section.totals.skipped_old_lines += 1;
          continue;
        }
        const picked = pickLogFields(parsed, redactor);
        entry.parsed_lines += 1;
        entry.dropped_fields += picked.dropped;
        section.totals.parsed_lines += 1;
        section.totals.dropped_fields += picked.dropped;
        section.lines.push({ file: filePathLabel, ...picked.line });
        continue;
      }
      // Non-JSON line: free text, therefore not quotable. The daemon's own logger
      // emits JSON only, so this is a desktop/installer text log — exactly the
      // place where an alert body or a user name lives in prose. Count it, do not
      // copy it (support gets "this file has 412 unparsed lines", not the lines).
      if (entry.skipped_lines === 0) {
        redactor.bumpLimit('log_line_capped');
      }
      entry.skipped_lines += 1;
      section.totals.skipped_lines += 1;
      section.totals.non_json_dropped += 1;
      if (section.reason === null) {
        section.reason = 'NON_JSON_DROPPED';
      }
    }
    section.files.push(entry);
  }
  section.totals.files = section.files.length;
  section.totals.lines = section.lines.length;
  section.totals.bytes_read = section.files.reduce((sum, file) => sum + (file.bytes_read ?? 0), 0);
  return section;
}

/**
 * Read table names, row counts and the schema version from the event store.
 *
 * @param {string|null} storePath Database path (`null` in mock mode).
 * @param {object} redactor Redactor.
 * @returns {Promise<object>} Tables section.
 */
async function readTables(storePath, redactor) {
  const section = {
    available: false,
    path: redactor.path(storePath),
    schema_version: null,
    schema_version_source: null,
    tables: [],
    reason: null,
    errors: [],
  };
  if (typeof storePath !== 'string' || storePath.length === 0) {
    section.reason = 'NO_STORE_PATH';
    return section;
  }
  try {
    if (!statSync(storePath).isFile()) {
      section.reason = 'NOT_A_FILE';
      return section;
    }
  } catch (error) {
    section.reason = stringOrNull(error?.code) ?? 'ENOENT';
    return section;
  }
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    section.reason = 'SQLITE_UNAVAILABLE';
    return section;
  }
  let database = null;
  try {
    database = new DatabaseSync(storePath, { readOnly: true });
    const names = [];
    for (const row of database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()) {
      const name = row?.name;
      if (typeof name === 'string' && name.length > 0) {
        names.push(name);
      }
    }
    if (names.includes('schema_migration')) {
      try {
        const row = database.prepare('SELECT MAX(version) AS version FROM schema_migration').get();
        const version = finite(row?.version);
        if (version !== null) {
          section.schema_version = version;
          section.schema_version_source = 'schema_migration';
        }
      } catch (error) {
        section.errors.push({ table: 'schema_migration', code: stringOrNull(error?.code) ?? 'QUERY_FAILED' });
      }
    }
    if (section.schema_version === null) {
      try {
        const row = database.prepare('PRAGMA user_version').get();
        const version = finite(row?.user_version);
        if (version !== null && version > 0) {
          section.schema_version = version;
          section.schema_version_source = 'pragma_user_version';
        }
      } catch {
        // PRAGMA is best-effort: a table listing without a version is still honest.
      }
    }
    for (const name of names) {
      const entry = { name, rows: null };
      try {
        // Table names come from sqlite_master, but the quote is still doubled:
        // "trusted input" is how identifier injection happens.
        const quoted = name.replace(/"/gu, '""');
        const row = database.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`).get();
        const count = finite(row?.count);
        entry.rows = count === null ? 0 : count;
      } catch (error) {
        entry.error = stringOrNull(error?.code) ?? 'COUNT_FAILED';
        section.errors.push({ table: name, code: entry.error });
      }
      section.tables.push(entry);
    }
    section.available = true;
    if (section.tables.length === 0) {
      section.reason = 'NO_TABLES';
    }
    if (section.schema_version === null) {
      section.schema_version_source = null;
    }
  } catch (error) {
    section.available = false;
    section.reason = stringOrNull(error?.code) ?? 'OPEN_FAILED';
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a read-only handle must never fail the export.
    }
  }
  return section;
}

/**
 * Build the version/build section.
 *
 * @param {object|null} statusPayload Status payload (may be `null`).
 * @param {object} config Resolved config.
 * @returns {Promise<object>} Version section.
 */
async function buildVersionSection(statusPayload, config) {
  const manifest = daemonPackage();
  const epoch = stringOrNull(statusPayload?.epoch) ?? stringOrNull(config?.policy?.epoch);
  const versions = process.versions ?? {};
  return {
    bundle_schema: BUNDLE_SCHEMA,
    daemon_version: await daemonVersion(),
    package_name: manifest.name,
    package_version: manifest.version,
    mode: stringOrNull(config?.mode) ?? stringOrNull(statusPayload?.mode),
    epoch,
    node: process.version,
    process_versions: {
      node: stringOrNull(versions.node),
      v8: stringOrNull(versions.v8),
      uv: stringOrNull(versions.uv),
      zlib: stringOrNull(versions.zlib),
      openssl: stringOrNull(versions.openssl),
    },
    platform: process.platform,
    arch: process.arch,
    release: stringOrNull(process.release?.name),
  };
}

/**
 * Build the redacted configuration section.
 *
 * Built field by field rather than by deep-copying `config`, because the config
 * object holds the token *file* (which support needs) next to the inline token
 * *value* (which must never leave the process). Naming the fields is what keeps
 * those two apart.
 *
 * @param {object} config Resolved config.
 * @param {object} redactor Redactor.
 * @returns {object} Config section.
 */
function buildConfigSection(config, redactor) {
  const api = config?.api ?? {};
  const policy = config?.policy ?? {};
  const allowedSummaryFields = Array.isArray(policy.allowedSummaryFields)
    ? policy.allowedSummaryFields.filter((field) => typeof field === 'string').slice(0, 64).map((field) => redactor.text(field, 120))
    : [];
  return {
    mode: stringOrNull(config?.mode),
    data_dir: redactor.path(config?.dataDir),
    api: {
      enabled: api.enabled === true,
      host: stringOrNull(api.host),
      port: finite(api.port),
      ...numbersFrom(api, [
        'requestTimeoutMs',
        'headersTimeoutMs',
        'keepAliveTimeoutMs',
        'maxBodyBytes',
        'maxHeaderBytes',
        'authFailureLimit',
        'authFailureWindowMs',
      ]),
      token_file: redactor.path(api.tokenFile),
      inline_token_present: typeof api.token === 'string' && api.token.length > 0,
    },
    scheduler: numbersFrom(config?.scheduler, [
      'tickMs',
      'sourceTimeoutMs',
      'maxBatchEvents',
      'staleAfterMs',
      'maxSources',
    ]),
    detection: {
      rule_pack_inline_present: config?.detection?.rulePack !== undefined && config?.detection?.rulePack !== null,
      rule_pack_path: redactor.path(config?.detection?.rulePackPath),
      limits: numbersOnly(config?.detection?.limits),
    },
    store: {
      path: redactor.path(config?.store?.path),
      ...numbersFrom(config?.store, ['busyTimeoutMs']),
    },
    state: {
      path: redactor.path(config?.state?.path),
    },
    policy: {
      budget_class: stringOrNull(policy.budgetClass),
      alert_status: stringOrNull(policy.alertStatus),
      allowed_summary_field_count: allowedSummaryFields.length,
      allowed_summary_fields: allowedSummaryFields,
      epoch_present: (stringOrNull(policy.epoch) ?? '') !== '',
    },
    shutdown: numbersFrom(config?.shutdown, ['graceMs', 'drainMs']),
    logging: {
      level: stringOrNull(config?.logging?.level),
    },
  };
}

/**
 * Keep only finite numbers of an object (detection limits are counters).
 *
 * @param {unknown} source Source object.
 * @returns {Record<string, number>} Numeric subset.
 */
function numbersOnly(source) {
  const output = {};
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return output;
  }
  for (const [key, value] of Object.entries(source).slice(0, 64)) {
    const number = finite(value);
    if (number !== null) {
      output[key] = number;
    }
  }
  return output;
}

/**
 * Build the process/port section.
 *
 * @param {object|null} statusPayload Status payload.
 * @param {object} config Resolved config.
 * @param {number} nowMs Wall clock.
 * @returns {object} Process section.
 */
function buildProcessSection(statusPayload, config, nowMs) {
  const startedAtMs = finite(statusPayload?.started_at_ms);
  const uptimeSeconds = typeof process.uptime === 'function' ? process.uptime() : null;
  const processUptimeMs = typeof uptimeSeconds === 'number' && Number.isFinite(uptimeSeconds)
    ? Math.round(uptimeSeconds * 1000)
    : null;
  const configuredPort = finite(config?.api?.port);
  const configuredHost = stringOrNull(config?.api?.host);
  // `/status` may or may not carry the bound endpoint (the daemon's own payload does
  // not); when it does, report it as `bound`, otherwise say `null` instead of
  // repeating the configured value as if it had been observed.
  const statusPort = finite(statusPayload?.api_port)
    ?? finite(statusPayload?.api?.port)
    ?? finite(statusPayload?.port);
  const statusHost = stringOrNull(statusPayload?.api_host) ?? stringOrNull(statusPayload?.api?.host);
  return {
    pid: process.pid,
    ppid: finite(process.ppid),
    node_version: process.version,
    started_at: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
    started_at_ms: startedAtMs,
    uptime_ms: startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs),
    process_uptime_ms: processUptimeMs,
    memory_rss_bytes: typeof process.memoryUsage === 'function' ? finite(process.memoryUsage().rss) : null,
    ports: [
      {
        name: 'api',
        host: statusHost ?? configuredHost,
        configured_port: configuredPort,
        bound: statusPort,
      },
    ],
  };
}

/**
 * Build the failure/counter section.
 *
 * @param {{statusPayload: object|null, diagnosticsPayload: object|null, redactor: object}} input Input.
 * @returns {object} Failures section.
 */
function buildFailuresSection(input) {
  const { statusPayload, diagnosticsPayload, redactor } = input;
  const rawCounters = statusPayload?.counters;
  const counters = numbersOnly(rawCounters);
  const health = statusPayload?.health;
  const reasons = Array.isArray(health?.reasons)
    ? health.reasons.filter((reason) => typeof reason === 'string').slice(0, 32).map((reason) => redactor.text(reason, 200))
    : [];
  const detection = {
    faults: finite(statusPayload?.pipeline?.detection?.faults),
    frozen: statusPayload?.pipeline?.detection?.frozen === true,
    fatal: stringOrNull(statusPayload?.pipeline?.detection?.fatal),
  };
  return {
    counters: {
      source_failures: counters.source_failures ?? null,
      rejected_by_store: counters.rejected_by_store ?? null,
      contributions_dropped: counters.contributions_dropped ?? null,
      detection_faults: detection.faults,
      all: counters,
    },
    health: {
      status: stringOrNull(health?.status),
      ready: typeof health?.ready === 'boolean' ? health.ready : null,
      reasons,
    },
    detection,
    store: redactor.tree(statusPayload?.store),
    api: redactor.tree(diagnosticsPayload?.api),
    auth: redactor.tree(diagnosticsPayload?.auth),
    checkpoint: redactor.tree(diagnosticsPayload?.checkpoint),
    console: redactor.tree(diagnosticsPayload?.console),
    lifecycle_history: redactor.tree(diagnosticsPayload?.lifecycle_history),
    detection_limits: redactor.tree(diagnosticsPayload?.detection_limits),
    errors: [],
  };
}

/**
 * Derive a safe attachment filename from an ISO timestamp.
 *
 * `2026-11-05T10:45:00.000Z` becomes `diagnostics-bundle-20261105T104500Z.json`.
 * The result is restricted to `[A-Za-z0-9._-]`, so even a hostile clock value
 * (a string with separators/quotes) cannot produce a path or a header injection.
 *
 * @param {string} iso ISO timestamp.
 * @returns {string} Filename.
 */
export function bundleFilename(iso) {
  const source = typeof iso === 'string' && iso.length > 0 ? iso : new Date().toISOString();
  const compact = source
    .replace(/\.\d+/u, '')
    .replace(/[-:]/gu, '')
    .replace(/[^A-Za-z0-9]/gu, '')
    .slice(0, 32);
  const stamp = compact.length >= 8 ? compact : new Date().toISOString().replace(/\.\d+/u, '').replace(/[-:]/gu, '').replace(/[^A-Za-z0-9]/gu, '').slice(0, 32);
  return `diagnostics-bundle-${stamp}.json`;
}

/**
 * Render a bundle to the exact bytes that will be returned.
 *
 * @param {object} bundle Bundle document.
 * @returns {string} Serialized document.
 */
function renderBundle(bundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Create the diagnostics handlers.
 *
 * @param {object} options Handler options (see the module docblock).
 * @returns {{exportDiagnosticsBundle: Function}} Handlers.
 */
export function createDiagnosticsHandlers(options = {}) {
  const config = options?.config ?? {};
  const statusFn = typeof options?.status === 'function' ? options.status : () => ({});
  const diagnosticsFn = typeof options?.diagnostics === 'function' ? options.diagnostics : () => ({});
  const dataDir = stringOrNull(options?.dataDir) ?? stringOrNull(config?.dataDir);
  // `storePath: null` is a *valid* input (mock mode has no database); only an
  // explicit string is treated as a path to open.
  const storePath = typeof options?.storePath === 'string' ? options.storePath : null;
  const clock = options?.clock ?? null;
  const logger = options?.logger ?? null;
  const onExported = typeof options?.onExported === 'function' ? options.onExported : null;

  /**
   * @returns {string} Wall-clock ISO timestamp.
   */
  function nowIso() {
    if (clock !== null && typeof clock.nowIso === 'function') {
      try {
        const value = clock.nowIso();
        if (typeof value === 'string' && value.length > 0) {
          return value;
        }
      } catch {
        // Fall through to the system clock: an export must not fail on a clock.
      }
    }
    return new Date().toISOString();
  }

  /**
   * @returns {number} Wall-clock milliseconds.
   */
  function nowMs() {
    if (clock !== null && typeof clock.nowMs === 'function') {
      try {
        const value = clock.nowMs();
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value;
        }
      } catch {
        // See `nowIso`.
      }
    }
    return Date.now();
  }

  /**
   * Call one injected section provider, capturing (not propagating) its failure.
   *
   * @param {Function} provider Provider.
   * @param {object[]} errors Error accumulator.
   * @param {string} section Section name.
   * @returns {object|null} Payload or `null`.
   */
  function callSection(provider, errors, section) {
    try {
      const value = provider();
      if (value === null || value === undefined) {
        errors.push({ section, code: 'UNAVAILABLE' });
        return null;
      }
      return value;
    } catch (error) {
      errors.push({ section, code: stringOrNull(error?.code) ?? 'PROVIDER_FAILED' });
      return null;
    }
  }

  return {
    /**
     * Build the support bundle.
     *
     * The context argument is accepted so the server can hand it the same `ctx` it
     * gives every other console handler, but the bundle is derived from the daemon's
     * own state: no header, body or parameter of the request changes its content.
     *
     * @param {object} [ctx] Request context (ignored).
     * @returns {Promise<{filename: string, contentType: string, body: string, summary: object}>} Bundle.
     * @throws {DaemonError} `INTERNAL` when the bundle cannot be assembled at all.
     */
    async exportDiagnosticsBundle(ctx) {
      void ctx;
      const generatedAt = nowIso();
      const generatedAtMs = nowMs();
      const redactor = createRedactor();
      const errors = [];

      const statusPayload = callSection(statusFn, errors, 'status');
      const diagnosticsPayload = callSection(diagnosticsFn, errors, 'diagnostics');

      const statusSection = statusPayload === null
        ? { available: false, reason: 'STATUS_UNAVAILABLE' }
        : redactor.tree(statusPayload);
      const diagnosticsSection = diagnosticsPayload === null
        ? { available: false, reason: 'DIAGNOSTICS_UNAVAILABLE' }
        : redactor.tree(diagnosticsPayload);

      const versionSection = await buildVersionSection(statusPayload, config);
      const tablesSection = await readTables(storePath, redactor);
      const logsSection = buildLogSection({ dataDir, nowMs: generatedAtMs, redactor });
      const failuresSection = buildFailuresSection({ statusPayload, diagnosticsPayload, redactor });
      const processSection = buildProcessSection(statusPayload, config, generatedAtMs);
      const configSection = buildConfigSection(config, redactor);

      const bundle = {
        bundle: {
          schema: BUNDLE_SCHEMA,
          generated_at: generatedAt,
          generator: 'aegis-daemon/diagnostics',
          log_window_hours: 24,
          limits: {
            max_bundle_bytes: MAX_BUNDLE_BYTES,
            max_log_file_bytes: MAX_LOG_FILE_BYTES,
            max_log_total_bytes: MAX_LOG_TOTAL_BYTES,
            max_text_chars: MAX_TEXT_CHARS,
          },
        },
        generated_at: generatedAt,
        redaction: { applied: true, rules: [], counts: {}, total: 0 },
        limits: { hit: {} },
        version: versionSection,
        config: configSection,
        status: statusSection,
        diagnostics: diagnosticsSection,
        tables: tablesSection,
        process: processSection,
        failures: failuresSection,
        logs: logsSection,
        errors,
      };

      const filename = bundleFilename(generatedAt);
      let body = renderBundle(bundle);
      let truncated = logsSection.truncated === true;

      // --- size guard -----------------------------------------------------
      // The caps above bound every individual part; this loop bounds the whole
      // document. Only log lines are given up (they are the only unbounded part),
      // newest first kept: a support bundle without the last lines is useless.
      if (Buffer.byteLength(body, 'utf8') > MAX_BUNDLE_BYTES) {
        redactor.bumpLimit('bundle_size_capped');
        bundle.logs.truncated = true;
        truncated = true;
        while (bundle.logs.lines.length > 0 && Buffer.byteLength(body, 'utf8') > MAX_BUNDLE_BYTES) {
          bundle.logs.lines = bundle.logs.lines.slice(Math.ceil(bundle.logs.lines.length / 2));
          bundle.logs.reason = 'BUNDLE_SIZE_LIMIT';
          body = renderBundle(bundle);
        }
      }
      if (Buffer.byteLength(body, 'utf8') > MAX_BUNDLE_BYTES) {
        // Even after dropping every log line the document is too big: give up the
        // two largest free-form sections rather than returning an over-limit body.
        bundle.logs = {
          window_hours: 24,
          dirs_scanned: bundle.logs.dirs_scanned,
          files: bundle.logs.files.slice(-32),
          lines: [],
          truncated: true,
          reason: 'BUNDLE_SIZE_LIMIT',
          non_json_policy: NON_JSON_POLICY,
          totals: bundle.logs.totals,
        };
        bundle.status = { available: false, reason: 'BUNDLE_SIZE_LIMIT' };
        bundle.diagnostics = { available: false, reason: 'BUNDLE_SIZE_LIMIT' };
        truncated = true;
        body = renderBundle(bundle);
      }

      // --- counts + egress sweep -----------------------------------------
      // Re-render with fresh counts, then re-check the exact bytes. The loop is
      // bounded: a sweep that keeps finding hits means a rule rewrote text another
      // rule then re-matched, and returning a stable body matters more than an
      // exact count in that pathological case.
      let snapshot = redactor.snapshot();
      for (let pass = 0; pass < 3; pass += 1) {
        bundle.redaction = {
          applied: true,
          rules: [...REDACTION_RULE_IDS],
          counts: snapshot.counts,
          total: snapshot.total,
        };
        bundle.limits = { hit: snapshot.limits };
        body = renderBundle(bundle);
        const swept = redactor.sweep(body);
        if (swept.hits === 0) {
          break;
        }
        body = swept.text;
        snapshot = redactor.snapshot();
      }

      const finalCounts = redactor.snapshot();
      const summary = {
        filename,
        generated_at: generatedAt,
        bytes: Buffer.byteLength(body, 'utf8'),
        truncated,
        sections: {
          version: true,
          config: true,
          status: bundle.status?.available !== false,
          diagnostics: bundle.diagnostics?.available !== false,
          tables: true,
          process: true,
          failures: true,
          logs: true,
        },
        redaction: {
          applied: true,
          total: finalCounts.total,
          counts: finalCounts.counts,
        },
        logs: {
          files: Array.isArray(bundle.logs?.files) ? bundle.logs.files.length : 0,
          lines: Array.isArray(bundle.logs?.lines) ? bundle.logs.lines.length : 0,
          parsed_lines: finite(bundle.logs?.totals?.parsed_lines) ?? 0,
          non_json_dropped: finite(bundle.logs?.totals?.non_json_dropped) ?? 0,
          non_json_policy: NON_JSON_POLICY,
          bytes_read: finite(bundle.logs?.totals?.bytes_read) ?? 0,
          truncated: bundle.logs?.truncated === true,
          reason: bundle.logs?.reason ?? null,
        },
        tables: {
          available: bundle.tables?.available === true,
          count: Array.isArray(bundle.tables?.tables) ? bundle.tables.tables.length : 0,
          schema_version: bundle.tables?.schema_version ?? null,
          reason: bundle.tables?.reason ?? null,
        },
        errors: Array.isArray(bundle.errors) ? bundle.errors.length : 0,
        limits_hit: { ...finalCounts.limits },
      };

      // The read-only settings field `diagnostics.exportBundleLastAt` is advanced
      // only after a bundle actually exists; a failed assembly must not claim one.
      if (onExported !== null) {
        try {
          onExported(generatedAt);
        } catch (error) {
          logger?.warn?.('diagnostics export hook failed', { reason: stringOrNull(error?.code) ?? 'HOOK_FAILED' });
        }
      }
      logger?.info?.('diagnostics bundle exported', {
        bytes: summary.bytes,
        truncated,
        redactions: finalCounts.total,
        tables: summary.tables.count,
      });

      return {
        filename,
        contentType: 'application/json; charset=utf-8',
        body,
        summary,
        // The server builds its own `content-disposition` (and re-sanitizes the
        // name); carrying the intended value lets callers/tests assert the same
        // safe shape without duplicating the header rules.
        contentDisposition: `attachment; filename="${filename}"`,
      };
    },
  };
}

/**
 * Assemble a bundle for callers that only have loose options.
 *
 * Kept internal: the exported interface is `createDiagnosticsHandlers`, but a
 * module-level error type is re-exported so a caller can distinguish "the daemon
 * refused" from an unexpected throw.
 */
export const DIAGNOSTICS_ERROR_CODES = Object.freeze({
  INTERNAL: DAEMON_CODES.INTERNAL,
});

/**
 * @param {string} message Message.
 * @param {object} [details] Identifier-only details.
 * @returns {DaemonError} Error for a failed export.
 */
export function diagnosticsFailure(message, details) {
  return new DaemonError(DAEMON_CODES.INTERNAL, message, details);
}
