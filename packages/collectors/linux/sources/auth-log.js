/**
 * File-backed authentication log adapter (`/var/log/auth.log`, `/var/log/secure`).
 *
 * Why keep it next to journald: on a system without a persistent journal (or where the
 * collector account may read the distro log but not the journal) this is the only
 * authentication source. Both feed the same `linux.auth` event type, so the detection layer
 * never has to know which one produced the record.
 *
 * Cursor: a byte offset into one file identity (`dev:ino`) plus the size observed with it.
 * - `sourceSequence` is the byte offset of the line start, which is exactly the "stable
 *   position inside this generation" the shared collector asks for: re-reading a committed
 *   range rebuilds identical stable keys.
 * - Rotation is `dev:ino` changing; truncation is a smaller size than the current offset.
 *   Both are reported to the caller so the runtime can advance the generation instead of
 *   silently restarting at offset 0 with an unknown missing range.
 * - Only complete lines are consumed: a partially written trailing line stays unread until
 *   the writer finishes it, so no record is ever cut in half.
 *
 * Permission: `/var/log/auth.log` is `0640 root:adm` on Debian and `/var/log/secure` is
 * `0600 root:root` on RHEL. A non-root collector is therefore *expected* to be denied; the
 * read reports `denied`, never `ok` with zero records.
 */

import { stateDigest } from '../diff.js';
import { normalizePayload } from '../payload.js';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertPositiveInteger,
} from '../errors.js';
import { assertSourceDescriptor } from './descriptor.js';

export const AUTH_LOG_SOURCE_ID = 'linux.auth-log';
export const AUTH_LOG_INTERVAL_MS = 5_000;
export const DEFAULT_AUTH_LOG_PATHS = Object.freeze(['/var/log/auth.log', '/var/log/secure']);
export const DEFAULT_MAX_BYTES_PER_READ = 512 * 1024;
export const DEFAULT_MAX_LINES_PER_READ = 1_000;
export const DEFAULT_MAX_LINE_CHARS = 2_048;

const MONTHS = Object.freeze({
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
});

const SYSLOG_LINE = /^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\S+) ([^:\[]+)(?:\[(\d+)\])?: ?(.*)$/;
const ISO_LINE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2}) (\S+) ([^:\[]+)(?:\[(\d+)\])?: ?(.*)$/;

export const AUTH_LOG_FIELDS = Object.freeze([
  { name: 'line', type: 'string', completeness: 'always', sensitivity: 'D2' },
  { name: 'host', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'identifier', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'pid', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'message', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
  { name: 'offset', type: 'integer', completeness: 'always', sensitivity: 'D1' },
]);

export const AUTH_LOG_DESCRIPTOR = assertSourceDescriptor({
  stableSourceId: AUTH_LOG_SOURCE_ID,
  kind: 'poll',
  intervalMs: AUTH_LOG_INTERVAL_MS,
  requiresRoot: false,
  emits: ['linux.auth'],
  declaredPaths: [...DEFAULT_AUTH_LOG_PATHS],
  permissions: {
    required: ['read access to an authentication log file (root, adm/syslog group, or an ACL grant)'],
    optional: ['root, which is the only account that can read both auth.log and secure on every distribution'],
    degradedWithout: ['all authentication records from this file'],
  },
  fields: AUTH_LOG_FIELDS,
  blindSpots: [
    'A line written before the collector first starts is not delivered unless initialPosition=start is configured; the default is end (tail)',
    'A rotation that happens between two polls is detected by a changed dev:ino, but lines written to the old file after the last read are lost with the old inode',
    'A copy-and-truncate rotation is detected by the newline alignment plus the stored digest of the 64 bytes before the offset; a rewrite that keeps the inode, the size and that exact tail is still invisible',
    'The tail digest only exists after a read that consumed at least one line, so a collector started at end-of-file has alignment-only evidence until its first non-empty read',
    'Lines are truncated at maxLineChars; the tail of a very long line is dropped from the payload',
    'The syslog timestamp carries no year, so observedAt is inferred from the collector clock and can be off by a year for a log left over from a previous year',
  ],
  rotation: 'file identity dev:ino: a different dev:ino is log_rotated; a size smaller than the stored offset, an offset that no longer lands on a line boundary, or a mismatch of the stored tail digest is log_truncated; all three force a generation advance so old offsets are never reused for the new file',
  gapSemantics: [
    'poll: a failed read publishes nothing and does not advance the offset; the source goes stale after two intervals instead of reporting an empty healthy page',
    'poll: a rotation or truncation produces an unknown-count gap ([lastObservedAt, now]) because the unwritten-to-disk tail of the old file cannot be counted',
    'poll: reads are bounded by maxBytesPerRead/maxLinesPerRead; the remainder is read on the next poll and the read reports hasMore instead of dropping it',
    'poll: a partially written trailing line stays unread until its newline arrives, so a record is never split',
  ],
  degradation: {
    onDenied: 'status=denied with the file path in permissions.missing; the offset does not advance and nothing is published',
    onPartial: 'status=partial when only one of the configured candidate files exists and is readable',
    onEmptyTable: 'an unreadable file is never an empty page; a missing file is not_found and is reported separately from a denial',
    neverHealthyWhenEmpty: true,
  },
  emittedGapReasons: ['permission_denied', 'log_rotated', 'log_truncated', 'io_error', 'cursor_reset'],
});

/** Parse an `auth.log` line; returns null when the line has neither a syslog nor an ISO stamp. */
export function parseAuthLine(line, { nowMs = Date.now() } = {}) {
  if (typeof line !== 'string' || line.length === 0) {
    return null;
  }
  const syslog = SYSLOG_LINE.exec(line);
  if (syslog !== null) {
    const [, monthName, day, hour, minute, second, host, identifier, pid, message] = syslog;
    const month = MONTHS[monthName];
    if (month === undefined) {
      return null;
    }
    const now = new Date(nowMs);
    let year = now.getUTCFullYear();
    let stamp = Date.UTC(year, month, Number(day), Number(hour), Number(minute), Number(second));
    // A December line read in January belongs to the previous year, not the future.
    if (stamp > nowMs + 86_400_000) {
      year -= 1;
      stamp = Date.UTC(year, month, Number(day), Number(hour), Number(minute), Number(second));
    }
    return Object.freeze({
      timestampMs: stamp,
      timestampStyle: 'syslog',
      host,
      identifier: identifier.trim(),
      pid: pid === undefined ? null : Number.parseInt(pid, 10),
      message: message ?? '',
    });
  }

  const iso = ISO_LINE.exec(line);
  if (iso !== null) {
    const [, , , , , , , zone, host, identifier, pid, message] = iso;
    const normalized = zone === 'Z' ? line.slice(0, 19) : line.slice(0, 19);
    const stamp = Date.parse(`${normalized}${zone === 'Z' ? 'Z' : zone}`);
    return Object.freeze({
      timestampMs: Number.isSafeInteger(stamp) ? stamp : null,
      timestampStyle: 'iso8601',
      host,
      identifier: identifier.trim(),
      pid: pid === undefined ? null : Number.parseInt(pid, 10),
      message: message ?? '',
    });
  }

  return null;
}

const AUTH_PATTERNS = Object.freeze([
  { pattern: /Failed password|authentication failure|Invalid user|FAILED LOGIN/i, severity: 'medium' },
  { pattern: /Failed publickey|error: PAM|pam_unix\(.*\): auth failure/i, severity: 'medium' },
  { pattern: /BREAK-IN ATTEMPT|refused connect from|possible break-in/i, severity: 'high' },
  { pattern: /Accepted (password|publickey|keyboard-interactive)/i, severity: 'low' },
  { pattern: /session (opened|closed)|new session/i, severity: 'info' },
  { pattern: /More authentication failures|too many authentication failures|pam_faillock/i, severity: 'high' },
]);

export function severityForAuthLine(message) {
  if (typeof message !== 'string' || message.length === 0) {
    return 'info';
  }
  for (const entry of AUTH_PATTERNS) {
    if (entry.pattern.test(message)) {
      return entry.severity;
    }
  }
  return 'info';
}

/**
 * Split on the 0x0A byte, not on a decoded string: a log line that is not valid UTF-8 would
 * otherwise be re-encoded with U+FFFD (three bytes) and every subsequent offset would drift.
 */
function splitBufferLines(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0A) {
      lines.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  return { lines, remainder: buffer.subarray(start) };
}

const PROBE_BYTES = 512;
const TAIL_BYTES = 64;

/**
 * Verify that a stored offset still points into the *same* content.
 *
 * `size < offset` catches a plain truncation, but a copy-truncate rotation followed by enough
 * new writes to pass the old offset is invisible that way: the next read would resume in the
 * middle of a line and reuse byte offsets that were already delivered, which the shared
 * dedupe window silently discards (a real data loss, see common INTEGRATION.md §2).
 *
 * The evidence is a fixed-size digest of the bytes immediately *before* the offset plus a
 * newline-boundary check. A digest of the last 64 bytes is used rather than "the last line"
 * because a line can be longer than any probe window: with a line-based digest the check
 * silently disables itself for long lines and for small files, which is exactly when a
 * copytruncate is easiest to miss.
 *
 * Returns a reason string when the cursor is stale, or null when it is still valid (or when
 * the check cannot be performed, in which case no rotation is invented).
 */
async function verifyCursorAlignment({ fileSystem, path, offset, expectedDigest }) {
  const windowBytes = Math.min(offset, PROBE_BYTES);
  const probe = await fileSystem.readText(path, { offset: offset - windowBytes, maxBytes: windowBytes });
  if (!probe.ok) {
    return null;
  }
  const buffer = probe.bytes ?? Buffer.from(probe.text, 'utf8');
  if (buffer.length === 0) {
    return null;
  }
  if (buffer[buffer.length - 1] !== 0x0A) {
    // The byte before the offset is not a newline: we would resume mid-line.
    return 'not_at_line_boundary';
  }
  if (typeof expectedDigest !== 'string') {
    return null;
  }
  const tail = tailOf(buffer, offset);
  return stateDigest(tail.toString('utf8')) === expectedDigest ? null : 'tail_changed';
}

/** The fixed-size tail the cursor digest is computed over: the last TAIL_BYTES before offset. */
function tailOf(buffer, offset) {
  const size = Math.min(offset, TAIL_BYTES);
  return buffer.subarray(Math.max(0, buffer.length - size));
}

/**
 * Digest of the same fixed-size tail, read straight from the file. Computing it from the file
 * (instead of from the lines a chunk happened to contain) keeps it reproducible by
 * `verifyCursorAlignment` for any line length and any chunk boundary.
 */
async function digestTail(fileSystem, path, offset) {
  if (!Number.isSafeInteger(offset) || offset <= 0) {
    return null;
  }
  const size = Math.min(offset, TAIL_BYTES);
  const probe = await fileSystem.readText(path, { offset: offset - size, maxBytes: size });
  if (!probe.ok) {
    return null;
  }
  return stateDigest((probe.bytes ?? Buffer.from(probe.text, 'utf8')).toString('utf8'));
}

export function createAuthLogSource({
  fileSystem,
  clock = Date.now,
  path = DEFAULT_AUTH_LOG_PATHS[0],
  candidatePaths = null,
  intervalMs = AUTH_LOG_INTERVAL_MS,
  maxBytesPerRead = DEFAULT_MAX_BYTES_PER_READ,
  maxLinesPerRead = DEFAULT_MAX_LINES_PER_READ,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
  initialPosition = 'end',
  stableSourceId = AUTH_LOG_SOURCE_ID,
} = {}) {
  if (!fileSystem || typeof fileSystem.stat !== 'function' || typeof fileSystem.readText !== 'function') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a file system exposing stat/readText is required',
    );
  }
  assertPositiveInteger('intervalMs', intervalMs);
  assertPositiveInteger('maxBytesPerRead', maxBytesPerRead);
  assertPositiveInteger('maxLinesPerRead', maxLinesPerRead);
  assertPositiveInteger('maxLineChars', maxLineChars);
  if (initialPosition !== 'end' && initialPosition !== 'start') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      "initialPosition must be 'end' or 'start'",
      { initialPosition: String(initialPosition) },
    );
  }

  const candidates = candidatePaths === null ? [path] : [...candidatePaths];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.startsWith('/')) {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        `candidate log paths must be absolute: ${String(candidate)}`,
      );
    }
  }

  const descriptor = assertSourceDescriptor({
    ...AUTH_LOG_DESCRIPTOR,
    stableSourceId,
    declaredPaths: candidates,
  });

  return Object.freeze({
    descriptor,

    async read({ cursor = null, generation = 0 } = {}) {
      const observedAt = clock();

      let chosen = null;
      const denials = [];
      for (const candidate of candidates) {
        const stat = await fileSystem.stat(candidate);
        if (stat.ok && stat.kind === 'file') {
          chosen = { path: candidate, stat };
          break;
        }
        if (!stat.ok && stat.outcome === 'permission_denied') {
          denials.push({ path: candidate, code: stat.code, outcome: stat.outcome });
        }
      }

      if (chosen === null) {
        const denied = denials.length > 0;
        return Object.freeze({
          status: denied ? 'denied' : 'error',
          records: [],
          denials: denials.length > 0
            ? denials
            : candidates.map((candidate) => ({ path: candidate, code: 'ENOENT', outcome: 'not_found' })),
          permissions: {
            granted: [],
            missing: denied ? denials.map((entry) => entry.path) : [],
          },
          nextCursor: null,
          rotation: null,
          identity: null,
          hasMore: false,
          observedAt,
          error: {
            code: denied ? 'EACCES' : 'ENOENT',
            message: denied
              ? 'the authentication log exists but is not readable by this account'
              : 'no candidate authentication log exists on this system',
          },
        });
      }

      const fileId = `${chosen.stat.dev}:${chosen.stat.ino}`;
      const size = chosen.stat.size;
      const isFirst = cursor === null;

      // The first read positions itself: at the end by default, so a fresh collector does
      // not replay the whole historic log as one burst, or at the start when the operator
      // explicitly asked for the backlog. `initialPosition: 'start'` therefore delivers
      // records on the very first read instead of needing a second poll.
      //
      // After a generation advance (rotation/truncation) there is no cursor and generation
      // is > 0: the new file must be read from its head, or the first lines of every rotated
      // log would be lost until the next write.
      const startAtEnd = isFirst && generation === 0 && initialPosition === 'end';
      const previousOffset = isFirst
        ? (startAtEnd ? size : 0)
        : (Number.isSafeInteger(cursor.offset) ? cursor.offset : 0);

      if (!isFirst && cursor.fileId !== fileId) {
        return Object.freeze({
          status: 'rotated',
          records: [],
          denials: [],
          permissions: { granted: [chosen.path], missing: [] },
          nextCursor: null,
          rotation: {
            reason: 'log_rotated',
            previousFileId: cursor.fileId,
            fileId,
            previousSize: Number.isSafeInteger(cursor.size) ? cursor.size : null,
            size,
          },
          identity: { fileId, size },
          hasMore: false,
          observedAt,
          error: null,
        });
      }
      if (!isFirst && previousOffset > 0) {
        // A truncation that has already regrown past the old offset is caught here.
        const stale = await verifyCursorAlignment({
          fileSystem,
          path: chosen.path,
          offset: previousOffset,
          expectedDigest: cursor.tailDigest ?? null,
        });
        if (stale !== null) {
          return Object.freeze({
            status: 'rotated',
            records: [],
            denials: [],
            permissions: { granted: [chosen.path], missing: [] },
            nextCursor: null,
            rotation: {
              reason: 'log_truncated',
              detail: stale,
              previousFileId: cursor.fileId,
              fileId,
              previousSize: previousOffset,
              size,
            },
            identity: { fileId, size },
            hasMore: false,
            observedAt,
            error: null,
          });
        }
      }

      if (!isFirst && size < previousOffset) {
        return Object.freeze({
          status: 'rotated',
          records: [],
          denials: [],
          permissions: { granted: [chosen.path], missing: [] },
          nextCursor: null,
          rotation: {
            reason: 'log_truncated',
            previousFileId: cursor.fileId,
            fileId,
            previousSize: previousOffset,
            size,
          },
          identity: { fileId, size },
          hasMore: false,
          observedAt,
          error: null,
        });
      }

      if (size === previousOffset) {
        return Object.freeze({
          status: 'ok',
          records: [],
          denials: [],
          permissions: { granted: [chosen.path], missing: [] },
          nextCursor: {
            path: chosen.path,
            fileId,
            offset: previousOffset,
            size,
            // Carrying the digest across an idle poll is what keeps the next copytruncate
            // detectable: dropping it here downgrades the check to "is a newline" only.
            // On the very first read the digest is computed here, so even the window between
            // startup and the first poll is covered.
            tailDigest: isFirst
              ? await digestTail(fileSystem, chosen.path, previousOffset)
              : (cursor.tailDigest ?? null),
          },
          rotation: null,
          identity: { fileId, size },
          initialized: isFirst,
          initialPosition: isFirst ? initialPosition : null,
          hasMore: false,
          observedAt,
          error: null,
        });
      }

      const chunk = await fileSystem.readText(chosen.path, {
        offset: previousOffset,
        maxBytes: maxBytesPerRead,
      });
      if (!chunk.ok) {
        const denied = chunk.outcome === 'permission_denied';
        return Object.freeze({
          status: denied ? 'denied' : 'error',
          records: [],
          denials: [{ path: chosen.path, code: chunk.code, outcome: chunk.outcome }],
          permissions: {
            granted: [],
            missing: denied ? [chosen.path] : [],
          },
          nextCursor: null,
          rotation: null,
          identity: { fileId, size },
          hasMore: false,
          observedAt,
          error: { code: chunk.code, message: `cannot read ${chosen.path}` },
        });
      }

      const buffer = chunk.bytes ?? Buffer.from(chunk.text, 'utf8');
      const { lines: lineBuffers, remainder } = splitBufferLines(buffer);
      const limited = lineBuffers.slice(0, maxLinesPerRead);
      const limitedBytes = limited.reduce((total, line) => total + line.length + 1, 0);
      const effectiveOffset = previousOffset + limitedBytes;
      // A trailing partial line (or a truncated chunk) must not be consumed: it will be
      // completed by the writer and read again on the next poll.
      const hasMore = chunk.truncated || remainder.length > 0 || effectiveOffset < size || limited.length < lineBuffers.length;

      let lineOffset = previousOffset;
      const records = [];
      for (const lineBytes of limited) {
        const lineStart = lineOffset;
        lineOffset += lineBytes.length + 1;
        // The byte offset is the identity of the record; the decoded text is only a payload.
        const line = lineBytes.toString('utf8');
        if (line.trim().length === 0) {
          continue;
        }
        const parsed = parseAuthLine(line, { nowMs: observedAt });
        const message = parsed === null
          ? line
          : (parsed.message.length > maxLineChars ? parsed.message.slice(0, maxLineChars) : parsed.message);
        records.push({
          // No native record id exists in a text log: the byte offset of the line start is
          // the documented stable position inside this generation.
          sourceSequence: lineStart,
          type: 'linux.auth',
          severity: severityForAuthLine(message),
          observedAt: parsed?.timestampMs ?? observedAt,
          payload: normalizePayload({
            source: 'auth-log',
            path: chosen.path,
            offset: lineStart,
            // DEF-04：键必须是 snake_case，且不能出现 null；DEF-03：控制符 / 双向符 / C1
            // 不得原样进入 payload。normalizePayload 同时负责清洗与 16 KiB 预算。
            byte_length: lineBytes.length + 1,
            line: line.length > maxLineChars ? line.slice(0, maxLineChars) : line,
            line_truncated: line.length > maxLineChars,
            line_digest: stateDigest(line),
            host: parsed?.host ?? null,
            identifier: parsed?.identifier ?? null,
            pid: parsed?.pid ?? null,
            message,
            timestamp_style: parsed?.timestampStyle ?? null,
            parsed: parsed !== null,
          }).payload,
        });
      }

      // The tail digest is what makes "appended" distinguishable from "truncated and regrown
      // past the old offset" on the next read.
      const tailDigest = limited.length > 0
        ? await digestTail(fileSystem, chosen.path, effectiveOffset)
        : (isFirst ? null : (cursor.tailDigest ?? null));

      // A bounded read is not a degraded read: the rest is picked up on the next poll, so
      // the status stays `ok` and `hasMore` carries the "there is more to do" signal.
      return Object.freeze({
        status: 'ok',
        records,
        denials: [],
        permissions: { granted: [chosen.path], missing: [] },
        nextCursor: {
          path: chosen.path,
          fileId,
          offset: effectiveOffset,
          size,
          tailDigest,
        },
        rotation: null,
        identity: { fileId, size },
        initialized: isFirst,
        initialPosition: isFirst ? initialPosition : null,
        hasMore,
        observedAt,
        stats: Object.freeze({
          lines: limited.length,
          skipped: lineBuffers.length - limited.length,
          remainderBytes: remainder.length,
        }),
        error: null,
      });
    },
  });
}
