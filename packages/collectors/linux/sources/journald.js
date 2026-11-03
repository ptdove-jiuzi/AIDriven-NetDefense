/**
 * journald adapter (§5.1 "安全/认证日志": journald JSON, follow + rotation check).
 *
 * Why `journalctl --output=json` and not `/var/log/syslog`: the JSON stream carries
 * `__CURSOR`, which is the only position token journald itself guarantees across rotation
 * and vacuuming. A byte offset into a text log is not comparable between files.
 *
 * Why this module never runs `journalctl` itself: it only talks to an injected runner. The
 * production runner is `createCommandRunner()` (`journalctl` is the only allowlisted
 * binary); the test runner is `createScriptedCommandRunner()`. The test suite asserts the
 * exact argv, so "we never execute a real journalctl in tests" is a checked property, not
 * a convention.
 *
 * Cursor semantics:
 * - cursor state is `{ cursor, lastRealtimeUs }`, both JSON round-trip safe;
 * - `nativeRecordId` is `j<sha256(cursor)[0..32]>` because a raw journald cursor contains
 *   `;` and `=` and is not guaranteed to stay free of `:` (which delimits a stable key);
 * - a cursor journald rejects (`Failed to seek to cursor`, or a vacuumed journal) is
 *   reported as `INVALID_CURSOR` with `resetCursor: true`; the runtime then advances the
 *   generation with `adapter_reset` instead of silently restarting from the head of the
 *   journal without a gap.
 *
 * Backlog: `--after-cursor` combined with `--lines` returns the *last* N entries after the
 * cursor, so a backlog larger than N loses its oldest entries. That is declared as a blind
 * spot and surfaced as `backlogRisk: true` whenever the read exactly fills the page.
 */

import { createHash } from 'node:crypto';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertPositiveInteger,
} from '../errors.js';
import { assertSourceDescriptor } from './descriptor.js';
import { findDuplicateJsonKey } from '../json-guard.js';
import { normalizePayload } from '../payload.js';

export const JOURNALD_SOURCE_ID = 'linux.journald';
export const JOURNALD_PROBE_INTERVAL_MS = 30_000;
export const DEFAULT_JOURNALCTL = '/usr/bin/journalctl';
export const DEFAULT_MAX_RECORDS_PER_READ = 500;
export const DEFAULT_MAX_MESSAGE_CHARS = 1024;

/** syslog priority → shared severity. */
export const JOURNALD_PRIORITY_SEVERITY = Object.freeze({
  0: 'critical',
  1: 'critical',
  2: 'critical',
  3: 'high',
  4: 'medium',
  5: 'low',
  6: 'info',
  7: 'info',
});

export const JOURNALD_SEVERITY_NAMES = Object.freeze([
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
]);

/** Identifiers that make a record an authentication event rather than a plain log line. */
export const AUTH_IDENTIFIERS = Object.freeze([
  'sshd',
  'sshd-session',
  'sudo',
  'su',
  'login',
  'systemd-logind',
  'polkitd',
  'pam_unix',
  'gdm',
  'gdm-password',
  'sssd',
  'krb5kdc',
  'cron',
  'atd',
]);

const AUTH_IDENTIFIER_SET = new Set(AUTH_IDENTIFIERS);

export const JOURNALD_OUTPUT_FIELDS = Object.freeze([
  '__CURSOR',
  '__REALTIME_TIMESTAMP',
  '__MONOTONIC_TIMESTAMP',
  '_BOOT_ID',
  '_HOSTNAME',
  '_TRANSPORT',
  'PRIORITY',
  'SYSLOG_FACILITY',
  'SYSLOG_IDENTIFIER',
  'MESSAGE',
  'MESSAGE_ID',
  '_PID',
  '_UID',
  '_GID',
  '_COMM',
  '_EXE',
  '_SYSTEMD_UNIT',
  '_SYSTEMD_CGROUP',
]);

export const JOURNALD_FIELDS = Object.freeze([  { name: 'cursor', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'realtime', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'priority', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'syslogSeverity', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'identifier', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'pid', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'uid', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'comm', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
  { name: 'unit', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'hostname', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'transport', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'message', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
]);

/**
 * The two locations journald writes to. `declaredPaths` has to name real paths, not a
 * wildcard: the descriptor validator resolves them like every other source.
 */
export const JOURNAL_PATHS = Object.freeze(['/run/log/journal', '/var/log/journal']);

export const JOURNALD_DESCRIPTOR = assertSourceDescriptor({
  stableSourceId: JOURNALD_SOURCE_ID,
  kind: 'event',
  intervalMs: JOURNALD_PROBE_INTERVAL_MS,
  subscriptionProbeIntervalMs: JOURNALD_PROBE_INTERVAL_MS,
  requiresRoot: false,
  emits: ['linux.journal', 'linux.auth'],
  declaredPaths: JOURNAL_PATHS,
  permissions: {
    required: [
      'membership in the systemd-journal group (or systemd-journald read ACL) to read the system journal',
      'an executable journalctl at one of the allowlisted absolute paths (/usr/bin, /bin, /usr/sbin, /usr/local/bin)',
    ],
    optional: ['root for journals of other users and for --system-only access without group membership'],
    degradedWithout: ['all journal records: without journal access the source is unavailable, not empty'],
  },
  fields: JOURNALD_FIELDS,
  blindSpots: [
    'A record written while the adapter is not reading is only recovered on the next read; records vacuumed in between are gone permanently',
    'journalctl --after-cursor together with --lines returns the last N entries after the cursor, so a backlog larger than the page loses its oldest entries (reported as backlogRisk)',
    'A journal rotated and vacuumed past the stored cursor invalidates the cursor; the adapter reports INVALID_CURSOR and the generation advances with adapter_reset',
    'Visibility is judged from journalctl stderr plus "did the first read return any record": a locale that translates the hint into another language would be misread as io_error rather than permission_denied',
    'Binary (non UTF-8) MESSAGE payloads are recorded as a hex digest plus a truncated preview, not as text',
    'Only the journals visible to the collector account are read; per-user journals of other users require root',
  ],
  rotation: 'journald cursor: a cursor stays valid across file rotation and vacuuming only while the journal stack keeps the entry; an invalid cursor is detected from the journalctl error text and forces a generation advance (adapter_reset) with an unknown-count gap',
  gapSemantics: [
    'event: zero business events is not a failure; liveness is judged only by the 30 s subscription probe, which fetches one record because zero records is also what a blind account sees',
    'event: a first read that returns no record at all is reported as denied (EMPTY_JOURNAL), because an account with read access always sees at least one system entry',
    'event: a failed probe degrades the source (subscription_probe_failed) without advancing the cursor',
    'event: a page that exactly fills maxRecordsPerRead sets backlogRisk and records a read_overlap_skipped gap, because older entries of that range were skipped by journalctl itself',
    'event: malformed JSON lines are counted and reported, the surrounding batch is still published as partial',
  ],
  degradation: {
    onDenied: 'status=denied, permissions.missing names the journal access requirement, nothing is published and the cursor does not advance',
    onPartial: 'status=partial, the parsed records are published and the malformed/incomplete counts are reported in the payload of the read result',
    onEmptyTable: 'an unreadable journal must never be reported as an empty page: a non-zero exit, the "not seeing messages from other users" hint on a zero exit, and an empty first page all resolve to denied',
    neverHealthyWhenEmpty: true,
  },
  emittedGapReasons: ['permission_denied', 'subscription_failed', 'io_error', 'read_overlap_skipped', 'generation_reset'],
});

/** Build the journald descriptor for a specific filter (unit / identifier list). */
export function describeJournald({ stableSourceId = JOURNALD_SOURCE_ID, identifiers = null, unit = null } = {}) {
  const filters = [];
  if (unit !== null) {
    filters.push(`unit=${unit}`);
  }
  if (identifiers !== null && identifiers.length > 0) {
    filters.push(`identifier in [${identifiers.join(', ')}]`);
  }
  return assertSourceDescriptor({
    ...JOURNALD_DESCRIPTOR,
    stableSourceId,
    declaredPaths: [...JOURNAL_PATHS],
    blindSpots: [
      ...JOURNALD_DESCRIPTOR.blindSpots,
      ...(filters.length === 0
        ? []
        : [`filtered view: only records matching ${filters.join(' and ')} are emitted, everything else is invisible to this source`]),
    ],
  });
}

export function severityForPriority(priority) {
  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    return 'info';
  }
  return JOURNALD_PRIORITY_SEVERITY[priority] ?? 'info';
}

export function severityName(priority) {
  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    return null;
  }
  return JOURNALD_SEVERITY_NAMES[priority] ?? null;
}

/** `j<32 hex>`: a cursor is not safe to embed in a stable key verbatim. */
export function nativeIdForCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a journald cursor must be a non-empty string',
    );
  }
  return `j${createHash('sha256').update(cursor, 'utf8').digest('hex').slice(0, 32)}`;
}

function decodeMessage(raw, maxChars) {
  if (typeof raw === 'string') {
    const text = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    return { message: text, encoding: 'utf8', truncated: raw.length > maxChars, bytes: null };
  }
  if (Array.isArray(raw)) {
    // journald emits a byte array when MESSAGE is not valid UTF-8.
    const bytes = Buffer.from(raw.map((value) => (Number.isInteger(value) ? value & 0xff : 0)));
    const hex = bytes.toString('hex');
    return {
      message: hex.slice(0, maxChars),
      encoding: 'hex',
      truncated: hex.length > maxChars,
      bytes: bytes.length,
    };
  }
  if (raw !== null && typeof raw === 'object') {
    const text = JSON.stringify(raw);
    return {
      message: text.length > maxChars ? text.slice(0, maxChars) : text,
      encoding: 'json',
      truncated: text.length > maxChars,
      bytes: null,
    };
  }
  return { message: '', encoding: 'absent', truncated: false, bytes: null };
}

function toIntegerField(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalize one journald JSON entry. Returns `null` when the entry has no cursor, because
 * without a cursor the record has no stable identity and replaying it would duplicate.
 */
export function parseJournaldEntry(entry, { maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS } = {}) {
  if (entry === null || typeof entry !== 'object') {
    return null;
  }
  const cursor = typeof entry.__CURSOR === 'string' && entry.__CURSOR.length > 0 ? entry.__CURSOR : null;
  if (cursor === null) {
    return null;
  }
  const realtimeUs = toIntegerField(entry.__REALTIME_TIMESTAMP);
  const priorityRaw = toIntegerField(entry.PRIORITY);
  const priority = priorityRaw !== null && priorityRaw >= 0 && priorityRaw <= 7 ? priorityRaw : 6;
  const message = decodeMessage(entry.MESSAGE, maxMessageChars);
  const identifier = typeof entry.SYSLOG_IDENTIFIER === 'string'
    ? entry.SYSLOG_IDENTIFIER.slice(0, 64)
    : (typeof entry._COMM === 'string' ? entry._COMM.slice(0, 64) : null);
  const observedAtMs = realtimeUs === null ? null : Math.trunc(realtimeUs / 1000);

  return Object.freeze({
    cursor,
    nativeRecordId: nativeIdForCursor(cursor),
    observedAtMs,
    priority,
    severity: severityForPriority(priority),
    severityName: severityName(priority),
    identifier,
    unit: typeof entry._SYSTEMD_UNIT === 'string' ? entry._SYSTEMD_UNIT.slice(0, 128) : null,
    pid: toIntegerField(entry._PID),
    uid: toIntegerField(entry._UID),
    gid: toIntegerField(entry._GID),
    comm: typeof entry._COMM === 'string' ? entry._COMM.slice(0, 64) : null,
    exe: typeof entry._EXE === 'string' ? entry._EXE.slice(0, 512) : null,
    hostname: typeof entry._HOSTNAME === 'string' ? entry._HOSTNAME.slice(0, 255) : null,
    transport: typeof entry._TRANSPORT === 'string' ? entry._TRANSPORT.slice(0, 32) : null,
    messageId: typeof entry.MESSAGE_ID === 'string' ? entry.MESSAGE_ID.slice(0, 64) : null,
    syslogFacility: toIntegerField(entry.SYSLOG_FACILITY),
    message: message.message,
    messageEncoding: message.encoding,
    messageTruncated: message.truncated,
    messageBytes: message.bytes,
  });
}

export function isAuthIdentifier(identifier) {
  return typeof identifier === 'string' && AUTH_IDENTIFIER_SET.has(identifier);
}

/** Split a journalctl JSON stream into entries plus a malformed count. */
export function parseJournaldOutput(stdout, { maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS } = {}) {
  const entries = [];
  let malformed = 0;
  let withoutCursor = 0;
  if (typeof stdout !== 'string' || stdout.length === 0) {
    return Object.freeze({ entries: Object.freeze(entries), malformed, withoutCursor });
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    // DEF-07：`JSON.parse` 看不见重复键，`{"__CURSOR":"s=a","__CURSOR":"s=b"}` 会被静默
    // 解释成 last-wins。contracts 与 plugin-manager 的解析器都拒绝重复键，同一份文本在
    // 不同组件里得到不同解释。这里按同一条规则拒收整行（计入 malformed），
    // 而不是继续用 `JSON.parse` 的 last-wins 语义。
    //
    // 只用"重复键"这一条规则、不搬 `parseStrictJson` 整体，是因为 journald 的 MESSAGE
    // 是日志原文，合法地带 ESC 等控制符（payload 阶段才清洗）；严格解析器会整条拒收，
    // 那正好是 DEF-03 的攻击面（写日志的一方用一行 ESC 让自己的记录消失）。
    if (findDuplicateJsonKey(trimmed) !== null) {
      malformed += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    const normalized = parseJournaldEntry(parsed, { maxMessageChars });
    if (normalized === null) {
      withoutCursor += 1;
      continue;
    }
    entries.push(normalized);
  }
  return Object.freeze({ entries: Object.freeze(entries), malformed, withoutCursor });
}

const CURSOR_ERROR_PATTERN = /failed to seek|cursor.*not valid|invalid cursor|no such cursor/i;
const PERMISSION_ERROR_PATTERN = /permission denied|access denied|insufficient permission/i;
const NO_JOURNAL_PATTERN = /no journal files were found/i;
/**
 * journalctl does not always fail when it cannot see the system journal: for a non-root
 * account outside the `systemd-journal`/`adm` groups it prints this hint on stderr and still
 * exits 0 (it shows only the caller's own user journal). That is why visibility is judged on
 * stderr text and on "did we actually get any record", not on the exit code alone.
 */
const PARTIAL_VISIBILITY_PATTERN = /not seeing messages from other users|failed to determine whether it/i;

/**
 * Classify journalctl's failure *or* its visibility hint. A zero exit with the
 * "not seeing messages from other users" hint is a permission problem, not a healthy page.
 */
export function classifyJournalctlFailure({ stderr = '', code = null } = {}) {
  const text = typeof stderr === 'string' ? stderr : '';
  if (CURSOR_ERROR_PATTERN.test(text)) {
    return { kind: 'invalid_cursor', resetCursor: true };
  }
  if (PARTIAL_VISIBILITY_PATTERN.test(text)) {
    return { kind: 'permission_denied', resetCursor: false, hint: true };
  }
  if (PERMISSION_ERROR_PATTERN.test(text)) {
    return { kind: 'permission_denied', resetCursor: false };
  }
  if (NO_JOURNAL_PATTERN.test(text)) {
    // "no journal files" means the account sees no journal at all: a missing permission for
    // the collector's purposes, and it must not become a healthy empty page.
    return { kind: 'permission_denied', resetCursor: false };
  }
  if (code !== null && code !== 0) {
    return { kind: 'io_error', resetCursor: false, code };
  }
  return { kind: 'ok', resetCursor: false };
}

export function createJournaldSource({
  runner,
  clock = Date.now,
  stableSourceId = JOURNALD_SOURCE_ID,
  unit = null,
  identifiers = null,
  executable = DEFAULT_JOURNALCTL,
  maxRecordsPerRead = DEFAULT_MAX_RECORDS_PER_READ,
  maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS,
  includeOutputFields = true,
  typeForRecord = null,
  systemOnly = true,
} = {}) {
  if (!runner || typeof runner.run !== 'function') {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'a command runner exposing run() is required');
  }
  assertPositiveInteger('maxRecordsPerRead', maxRecordsPerRead);
  assertPositiveInteger('maxMessageChars', maxMessageChars);
  if (identifiers !== null && (!Array.isArray(identifiers) || identifiers.some((item) => typeof item !== 'string'))) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'identifiers must be null or an array of strings',
    );
  }

  const descriptor = describeJournald({ stableSourceId, identifiers, unit });

  function baseArgs() {
    // `--quiet` is deliberately absent: it suppresses the "not seeing messages from other
    // users" hint, which is the only signal a non-root collector gets that it is blind.
    const args = ['--no-pager', '--output=json'];
    if (systemOnly) {
      args.push('--system');
    }
    if (includeOutputFields) {
      args.push(`--output-fields=${JOURNALD_OUTPUT_FIELDS.join(',')}`);
    }
    if (unit !== null) {
      args.push(`--unit=${unit}`);
    }
    for (const identifier of identifiers ?? []) {
      args.push(`--identifier=${identifier}`);
    }
    return args;
  }

  function deniedResult({ at, code, message, detail, observedAtMs = at }) {
    return Object.freeze({
      status: 'denied',
      records: [],
      denials: [{ path: `journalctl:${systemOnly ? 'system' : 'all'}${unit === null ? '' : `:${unit}`}`, code, outcome: 'permission_denied' }],
      permissions: { granted: [], missing: [detail] },
      nextCursor: null,
      resetCursor: false,
      errorCode: code,
      observedAt: observedAtMs,
      error: { code, message: String(message ?? code).slice(0, 512) },
    });
  }

  return Object.freeze({
    descriptor,

    /**
     * Independent liveness check (§5.1: event sources probe the subscription every 30 s).
     * It fetches one record on purpose: `--lines=0` returns zero lines for a blind account
     * too, so it cannot tell "readable" from "invisible".
     */
    async probe() {
      // `--lines=0` cannot prove anything: zero lines is also what a blind account sees.
      // One real record plus an empty stderr is the only cheap evidence of visibility.
      const result = await runner.run({
        executable,
        args: [...baseArgs(), '--lines=1'],
      });
      const classified = classifyJournalctlFailure(result);
      if (!result.ok || classified.kind !== 'ok') {
        return Object.freeze({
          ok: false,
          code: classified.kind === 'ok' ? 'io_error' : classified.kind,
          message: (result.stderr || `journalctl exited with ${result.code}`).slice(0, 512),
          at: clock(),
        });
      }
      const entries = parseJournaldOutput(result.stdout, { maxMessageChars }).entries;
      if (entries.length === 0) {
        // A readable system journal always has at least one entry; zero means we are blind.
        return Object.freeze({
          ok: false,
          code: 'empty_journal',
          message: 'journalctl returned no entry at all, which means this account cannot see the journal',
          at: clock(),
        });
      }
      return Object.freeze({ ok: true, code: null, message: null, at: clock() });
    },

    async read({ cursor = null } = {}) {
      const observedAt = clock();
      // The persisted cursor is an object (`{cursor, lastRealtimeUs}`); a bare string is
      // accepted too so the adapter can be exercised directly.
      const cursorText = typeof cursor === 'string'
        ? cursor
        : (cursor !== null && typeof cursor === 'object' && typeof cursor.cursor === 'string'
          ? cursor.cursor
          : null);
      const args = [...baseArgs(), `--lines=${maxRecordsPerRead}`];
      if (typeof cursorText === 'string' && cursorText.length > 0) {
        args.push(`--after-cursor=${cursorText}`);
      }

      const result = await runner.run({ executable, args });
      // The classification runs even on a zero exit: journalctl exits 0 while printing the
      // "not seeing messages from other users" hint, and that hint is a permission verdict.
      const classifiedFirst = classifyJournalctlFailure(result);
      if (!result.ok || classifiedFirst.kind !== 'ok') {
        const classified = classifiedFirst;
        const denied = classified.kind === 'permission_denied';
        const emptyResult = {
          status: denied ? 'denied' : 'error',
          records: [],
          denials: [{
            path: `journalctl:${unit === null ? 'system' : unit}`,
            code: classified.kind,
            outcome: denied ? 'permission_denied' : 'io_error',
          }],
          permissions: {
            granted: [],
            missing: denied
              ? ['systemd-journal group membership (or root) to read the system journal']
              : [],
          },
          nextCursor: null,
          resetCursor: classified.resetCursor === true,
          errorCode: classified.kind,
          observedAt,
          error: {
            code: classified.kind,
            message: (result.stderr || `journalctl exited with ${result.code}`).slice(0, 512),
            timedOut: result.timedOut === true,
            truncated: result.truncated === true,
          },
        };
        return Object.freeze(emptyResult);
      }

      const parsed = parseJournaldOutput(result.stdout, { maxMessageChars });

      // First read that returns nothing at all is not "a quiet journal": an account with read
      // access to the system journal always sees at least one entry. Without this check a
      // permission-restricted journal would look like a healthy empty page.
      if (cursorText === null && parsed.entries.length === 0) {
        return deniedResult({
          at: observedAt,
          code: 'EMPTY_JOURNAL',
          message: 'the first journal read returned no entry at all; this account cannot see the system journal',
          detail: 'read access to the system journal (systemd-journal/adm group membership, or root)',
        });
      }

      const records = parsed.entries.map((entry) => ({
        nativeRecordId: entry.nativeRecordId,
        type: typeForRecord === null
          ? (isAuthIdentifier(entry.identifier) ? 'linux.auth' : 'linux.journal')
          : typeForRecord(entry),
        severity: entry.severity,
        observedAt: entry.observedAtMs === null ? observedAt : entry.observedAtMs,
        payload: normalizePayload({
          cursor: entry.cursor,
          realtime: entry.observedAtMs === null ? null : new Date(entry.observedAtMs).toISOString(),
          priority: entry.priority,
          syslog_severity: entry.severityName,
          identifier: entry.identifier,
          unit: entry.unit,
          pid: entry.pid,
          uid: entry.uid,
          gid: entry.gid,
          comm: entry.comm,
          exe: entry.exe,
          hostname: entry.hostname,
          transport: entry.transport,
          message_id: entry.messageId,
          syslog_facility: entry.syslogFacility,
          message: entry.message,
          message_encoding: entry.messageEncoding,
          message_truncated: entry.messageTruncated,
          message_bytes: entry.messageBytes,
        }).payload,
      }));

      const last = parsed.entries.length === 0 ? null : parsed.entries[parsed.entries.length - 1];
      const nextCursor = last === null
        // An empty page keeps the previous cursor rather than resetting to null, which would
        // make the next read start from the head of the journal.
        ? (cursorText === null ? null : { cursor: cursorText, lastRealtimeUs: null })
        : { cursor: last.cursor, lastRealtimeUs: last.observedAtMs === null ? null : last.observedAtMs * 1000 };

      // journalctl tail-anchors an --after-cursor page, so a full page means older entries
      // of the same range were skipped.
      const backlogRisk = parsed.entries.length >= maxRecordsPerRead;
      const status = parsed.malformed > 0 || parsed.withoutCursor > 0 ? 'partial' : 'ok';

      return Object.freeze({
        status,
        records,
        denials: [],
        permissions: { granted: ['journal'], missing: [] },
        nextCursor,
        resetCursor: false,
        backlogRisk,
        stats: Object.freeze({
          entries: parsed.entries.length,
          malformed: parsed.malformed,
          withoutCursor: parsed.withoutCursor,
          pageSize: maxRecordsPerRead,
        }),
        observedAt,
        error: null,
      });
    },
  });
}

/** journald restricted to authentication identifiers (`sshd`, `sudo`, `su`, ...). */
export function createJournaldAuthSource(options = {}) {
  const { stableSourceId = 'linux.auth.journald', ...rest } = options;
  return createJournaldSource({
    ...rest,
    stableSourceId,
    identifiers: rest.identifiers ?? AUTH_IDENTIFIERS,
    typeForRecord: () => 'linux.auth',
  });
}
