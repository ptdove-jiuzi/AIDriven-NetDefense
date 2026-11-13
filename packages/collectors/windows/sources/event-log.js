/**
 * Event log source (§5.1 "安全/认证日志"): one source per channel.
 *
 * `Get-WinEvent` is used instead of `wevtutil`/`Get-EventLog` because it exposes the
 * `EventRecordID` through an XPath filter, which is the only cursor that is monotonic
 * within a generation and survives an eviction of older records.
 *
 * Cursor: `{ channel, lastRecordId, generation, lastObservedAt }`.
 * - `lastRecordId` is the highest record id delivered so far. A read asks for
 *   `EventRecordID > lastRecordId`, sorts ascending and takes at most 500 rows, so a large
 *   backlog is drained over several reads instead of being dropped.
 * - `EventRecordID` is reused after `wevtutil cl` (the counter restarts at 1). When the
 *   newest id on the channel is smaller than the last delivered id, the log was cleared;
 *   the adapter re-reads from 0 and returns a `reset` instruction so the caller can advance
 *   the generation *before* publishing. The gap window is
 *   `[lastObservedAt, first record of the new generation]`.
 *
 * `Get-WinEvent -FilterHashtable @{LogName=…; StartTime=…}` is deliberately not used: it
 * filters on wall-clock time, misses records written with a skewed clock and cannot
 * express "greater than this record id".
 *
 * Generation detection lives *inside* this source (record-id regression), not in
 * `collector.detectIdentityChange`. A cleared log is exactly a record-id regression, so the
 * source is authoritative here; calling `evaluateSourceIdentity` on top would additionally
 * report `log_truncated` for the same event and double-advance the generation. The returned
 * `identity` is diagnostic only (`size` = newest record id).
 *
 * The channel name reaches PowerShell only through {@link assertChannelName} plus
 * {@link psQuote}: it is validated against a conservative character class and then embedded
 * as a single-quoted literal, so it can never terminate the string or start a subexpression.
 */

import { createHash } from 'node:crypto';
import { createSourceDescriptor } from '../descriptor.js';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from '../errors.js';
import { buildPayload } from '../payload.js';
import { parseWindowsDate, psQuote, toArray, toInteger, toText } from '../powershell.js';

export const EVENT_LOG_KIND = 'event';
export const EVENT_LOG_TYPE = 'windows.event_log';
export const EVENT_LOG_PROBE_INTERVAL_MS = 30_000;
export const MAX_RECORDS_PER_READ = 500;
export const MAX_MESSAGE_CHARS = 1024;

const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,254}$/;

/** Reject anything that could terminate the quoted literal or start a subexpression. */
export function assertChannelName(channel) {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_CONFIG, 'channel must be a non-empty string');
  }
  if (!CHANNEL_PATTERN.test(channel) || /['"`$;|&<>\r\n\t]/.test(channel)) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_CONFIG,
      'channel name contains characters that are not allowed in an event channel name',
      { details: { channel } },
    );
  }
  return channel;
}

/** `windows.event-log.security` for channel `Security`. */
export function channelSourceId(channel) {
  assertChannelName(channel);
  const lowered = channel.toLowerCase();
  const slug = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // The slug transformation is lossy ('A.B', 'A/B' and 'A B' all become 'a-b'), so a plain
  // slug is used only when it is the identity mapping — which is the common case for
  // Security/System/Application. Everything else gets a digest suffix to stay injective.
  const faithful = slug === lowered;
  // The digest is taken over the *lower-cased* channel: Windows channel names are
  // case-insensitive, so `Sysmon/Operational` and `sysmon/operational` are the same channel
  // and must not produce two different stable source ids (which would orphan the cursor and
  // replay the whole backlog as new events).
  const digestOf = () => createHash('sha256').update(lowered, 'utf8').digest('hex').slice(0, 8);
  const suffix = faithful ? '' : `-${digestOf()}`;
  const candidate = `windows.event-log.${slug}${suffix}`;
  if (candidate.length <= 96) {
    return candidate;
  }
  // `assertStableSourceId` caps the id at 96 characters.
  const tail = `-${digestOf()}`;
  const head = slug.slice(0, 96 - 'windows.event-log.'.length - tail.length);
  return `windows.event-log.${head}${tail}`;
}

export const WINDOWS_LEVEL_SEVERITY = Object.freeze({
  1: 'critical',
  2: 'high',
  3: 'medium',
  4: 'low',
  5: 'info',
});

export function severityForLevel(level) {
  return WINDOWS_LEVEL_SEVERITY[level] ?? 'info';
}

export const EVENT_LOG_FIELDS = Object.freeze([
  { name: 'channel', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'record_id', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'event_id', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'level', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'provider', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'message', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
  { name: 'time_created', type: 'string', completeness: 'always', sensitivity: 'D1' },
]);

export function describeEventLog(channel, { intervalMs = EVENT_LOG_PROBE_INTERVAL_MS } = {}) {
  assertChannelName(channel);
  const security = channel.toLowerCase() === 'security';
  return createSourceDescriptor({
    stableSourceId: channelSourceId(channel),
    type: EVENT_LOG_TYPE,
    kind: EVENT_LOG_KIND,
    intervalMs,
    permissions: {
      required: [
        security
          ? 'Read access to the Security channel (Administrator or Event Log Readers)'
          : `Read access to the ${channel} channel`,
      ],
      optional: ['Event Log Readers group membership for non-administrator collectors'],
      degradedWithout: [
        'all records of this channel: a denied channel is reported unavailable, never as an empty result',
      ],
    },
    fields: EVENT_LOG_FIELDS,
    blindSpots: [
      'Records evicted by the channel retention policy before a read are gone; the gap is only visible through the record id jump',
      'A cleared log is detected by a record id regression, which cannot distinguish a clear from a channel truncation',
      'Message text is truncated and may contain user-controlled content',
      'Records written between two reads with an id below the cursor are never re-read',
    ],
    gapSemantics: [
      'cleared log: generation +1 with an unknown-count gap from the last delivered event time to the first record of the new generation',
      'record id jump without a regression: the missing range was evicted by retention; it is reported by the record id gap, not as a separate event',
      'zero records is not a gap: an event source is stale only when the subscription probe is overdue',
    ],
    rotation: 'record id regression or reset to zero => log_cleared; the generation is advanced before the new records are published',
  });
}

function truncateMessage(value) {
  const text = toText(value);
  if (text === null) {
    return null;
  }
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}...` : text;
}

/**
 * Locale-independent "this query matched nothing" predicate, emitted into every read script.
 *
 * `Get-WinEvent` reports an empty page by *throwing*. The original catch matched the English
 * message only (`no events were found`), so on a zh-CN host — where the message is
 * "找不到与指定的选择条件匹配的事件。" — the exception was re-thrown, the whole read failed and
 * an idle channel produced `COMMAND_FAILED` on every poll (prof-collector, probe-once.json).
 *
 * The fix keys on the `FullyQualifiedErrorId` first (`NoMatchingEventsFound,…`), which is a
 * locale-invariant identifier emitted by the cmdlet itself, and keeps the bilingual message
 * as a second signal for hosts that rewrite the error id. Anything else — a denied channel,
 * a missing channel, a provider failure — is still re-thrown: this must not become "any
 * exception means the log is empty".
 */
export const NO_EVENTS_PREDICATE = [
  'function Test-AegisNoEvents([System.Management.Automation.ErrorRecord] $record) {',
  '  if ([string]$record.FullyQualifiedErrorId -match "(?i)^NoMatchingEventsFound") { return $true }',
  '  $text = [string]$record.Exception.Message',
  '  if ($text -match "(?i)no events were found") { return $true }',
  '  if ($text -match "找不到任何与指定的选择条件匹配的事件") { return $true }',
  '  if ($text -match "找不到与指定的选择条件匹配的事件") { return $true }',
  '  return $false',
  '}',
].join('\n');

export function buildReadScript(channel, afterRecordId, maxRecords = MAX_RECORDS_PER_READ) {
  assertChannelName(channel);
  if (!Number.isSafeInteger(afterRecordId) || afterRecordId < 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'afterRecordId must be a non-negative integer');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'maxRecords must be a positive integer');
  }
  return [
    '# aegis-source:event-log',
    NO_EVENTS_PREDICATE,
    `$channel = ${psQuote(channel)}`,
    `$after = ${afterRecordId}`,
    // CL-10: the previous filter was `EventRecordID > $after` with a client-side
    // `Sort-Object` over the *whole* channel (27 561 records on Application ≈ >120 s, so
    // every first read timed out). Bounding the id range in XPath keeps the matched set at
    // one page, so the sort is over ≤ maxRecords rows and the provider can use its record-id
    // index instead of materialising the channel.
    `$until = $after + ${maxRecords}`,
    '$newest = [long]0',
    'try {',
    '  $probe = @(Get-WinEvent -LogName $channel -MaxEvents 1 -ErrorAction Stop)',
    '  if ($probe.Count -gt 0) { $newest = [long]$probe[0].RecordId }',
    '} catch {',
    '  if (-not (Test-AegisNoEvents $_)) { throw }',
    '}',
    '$xpath = "*[System[EventRecordID > $after and EventRecordID <= $until]]"',
    '$rows = @()',
    'try {',
    `  $rows = @(Get-WinEvent -LogName $channel -FilterXPath $xpath -ErrorAction Stop | Sort-Object RecordId | Select-Object -First ${maxRecords} | ForEach-Object { [pscustomobject]@{ recordId = [long]$_.RecordId; timeCreated = $_.TimeCreated; eventId = [int]$_.Id; level = [int]$_.Level; provider = [string]$_.ProviderName; message = [string]$_.Message } })`,
    '} catch {',
    '  if (-not (Test-AegisNoEvents $_)) { throw }',
    '}',
    'ConvertTo-Json -InputObject ([pscustomobject]@{ newestRecordId = $newest; events = $rows }) -Depth 5 -Compress',
  ].join('\n');
}

export function buildProbeScript(channel) {
  assertChannelName(channel);
  return [
    '# aegis-source:event-log-probe',
    `$null = Get-WinEvent -LogName ${psQuote(channel)} -MaxEvents 1 -ErrorAction Stop`,
    "'ok'",
  ].join('\n');
}

function normalizeCursor(cursor, channel, generation) {
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
    return { lastRecordId: 0, lastObservedAt: null };
  }
  if (cursor.channel !== channel) {
    return { lastRecordId: 0, lastObservedAt: null };
  }
  // A cursor written under another generation cannot describe positions in this one.
  if (Number.isSafeInteger(cursor.generation) && cursor.generation !== generation) {
    return { lastRecordId: 0, lastObservedAt: null };
  }
  const lastRecordId = toInteger(cursor.lastRecordId);
  const lastObservedAt = toInteger(cursor.lastObservedAt);
  return {
    lastRecordId: lastRecordId === null || lastRecordId < 0 ? 0 : lastRecordId,
    lastObservedAt: lastObservedAt === null || lastObservedAt < 0 ? null : lastObservedAt,
  };
}

function toRecords(channel, rows, observedAtFallback) {
  const records = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      continue;
    }
    const recordId = toInteger(row.recordId);
    if (recordId === null || recordId < 0) {
      continue;
    }
    const createdMs = parseWindowsDate(row.timeCreated);
    const level = toInteger(row.level);
    const { payload } = buildPayload({
      channel,
      record_id: recordId,
      event_id: toInteger(row.eventId),
      level: level === null ? undefined : level,
      provider: toText(row.provider),
      message: truncateMessage(row.message),
      time_created: createdMs === null ? null : new Date(createdMs).toISOString(),
    });
    records.push({
      nativeRecordId: String(recordId),
      // RecordId is the stable position within the generation; the stable key still uses
      // nativeRecordId, and sourceSequence keeps `source_seq` monotonic for readers.
      sourceSequence: recordId,
      type: EVENT_LOG_TYPE,
      severity: severityForLevel(level),
      observedAt: createdMs === null ? observedAtFallback : createdMs,
      payload,
    });
  }
  // Numeric order, not lexicographic: "10" must sort before "9".
  records.sort((left, right) => Number(left.nativeRecordId) - Number(right.nativeRecordId));
  return records;
}

export function createEventLogSource({
  powershell,
  channel,
  clock = Date.now,
  intervalMs = EVENT_LOG_PROBE_INTERVAL_MS,
  maxRecordsPerRead = MAX_RECORDS_PER_READ,
} = {}) {
  if (!powershell || typeof powershell.runJson !== 'function') {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'a PowerShell client exposing runJson() is required',
    );
  }
  const safeChannel = assertChannelName(channel);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'intervalMs must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRecordsPerRead) || maxRecordsPerRead < 1) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'maxRecordsPerRead must be a positive integer',
    );
  }

  const descriptor = describeEventLog(safeChannel, { intervalMs });

  async function readPage(afterRecordId) {
    const page = await powershell.runJson(buildReadScript(safeChannel, afterRecordId, maxRecordsPerRead));
    return {
      newestRecordId: toInteger(page?.newestRecordId) ?? 0,
      rows: toArray(page?.events),
    };
  }

  return Object.freeze({
    descriptor,
    sourceId: channelSourceId(safeChannel),
    channel: safeChannel,

    async read({ cursor = null, generation = 0 } = {}) {
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new WindowsCollectorError(
          WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
          'generation must be a non-negative integer',
        );
      }
      const state = normalizeCursor(cursor, safeChannel, generation);
      const now = clock();
      const page = await readPage(state.lastRecordId);

      const cleared = state.lastRecordId > 0
        && (page.newestRecordId === 0 || page.newestRecordId < state.lastRecordId);

      if (cleared) {
        // The record id counter restarted: re-read from the beginning of the new
        // generation. Nothing from the old range can be recovered, which is exactly why
        // the generation is advanced and an unknown-count gap is recorded.
        const recovery = await readPage(0);
        const records = toRecords(safeChannel, recovery.rows, now);
        const gapEnd = records.length > 0 ? records[0].observedAt : now;
        const lastRecordId = records.length > 0
          ? toInteger(records[records.length - 1].nativeRecordId)
          : recovery.newestRecordId;
        const observedAt = records.length > 0 ? records[records.length - 1].observedAt : now;
        const hasMore = recovery.rows.length >= maxRecordsPerRead;
        return {
          records,
          nextCursor: {
            channel: safeChannel,
            lastRecordId: lastRecordId ?? 0,
            // The caller advances the generation *before* publishing this batch, so the
            // persisted cursor must already describe the new generation.
            generation: generation + 1,
            lastObservedAt: observedAt,
          },
          identity: {
            channel: safeChannel,
            fileId: `channel:${safeChannel}`,
            size: recovery.newestRecordId,
            lastRecordId: recovery.newestRecordId,
          },
          reset: {
            reason: 'log_cleared',
            gapStart: state.lastObservedAt ?? now,
            gapEnd,
          },
          snapshot: false,
          // A full page means "there is a backlog", which is `hasMore`, not data loss.
          // `truncated` is reserved for reads that really dropped records (a table above
          // maxEntities, an unreadable subtree); conflating the two made every busy host
          // report a truncation gap on every cycle.
          truncated: false,
          hasMore,
          skippedRows: recovery.rows.length - records.length,
        };
      }

      const records = toRecords(safeChannel, page.rows, now);
      // Rows without a usable record id cannot be delivered, but they must not pin the cursor
      // in place: when every row was skipped the cursor still moves to the channel's newest id
      // so the same page is not re-read forever.
      const lastRecordId = records.length > 0
        ? toInteger(records[records.length - 1].nativeRecordId)
        : page.newestRecordId;
      const observedAt = records.length > 0 ? records[records.length - 1].observedAt : now;
      const hasMore = page.rows.length >= maxRecordsPerRead;

      return {
        records,
        nextCursor: {
          channel: safeChannel,
          lastRecordId: lastRecordId ?? 0,
          generation,
          lastObservedAt: observedAt,
        },
        identity: {
          channel: safeChannel,
          fileId: `channel:${safeChannel}`,
          size: page.newestRecordId,
          lastRecordId: page.newestRecordId,
        },
        reset: null,
        snapshot: false,
        truncated: false,
        hasMore,
        skippedRows: page.rows.length - records.length,
      };
    },

    async probe() {
      try {
        await powershell.runText(buildProbeScript(safeChannel));
        return { ok: true, errorCode: null };
      } catch (error) {
        // "No events were found" means the channel exists and is readable; an idle
        // channel is not a failed subscription.
        if (error.code === WINDOWS_ERROR_CODES.NO_EVENTS) {
          return { ok: true, errorCode: null };
        }
        return { ok: false, errorCode: error.code ?? WINDOWS_ERROR_CODES.COMMAND_FAILED };
      }
    },
  });
}
