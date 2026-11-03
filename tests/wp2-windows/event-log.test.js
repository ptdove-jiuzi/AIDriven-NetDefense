import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVENT_LOG_PROBE_INTERVAL_MS,
  MAX_RECORDS_PER_READ,
  WINDOWS_ERROR_CODES,
  assertChannelName,
  buildProbeScript,
  buildReadScript,
  channelSourceId,
  createEventLogSource,
  describeEventLog,
  severityForLevel,
} from '../../packages/collectors/windows/index.js';
import { createClock, createScriptedPowerShell } from './helpers.js';

const BASE = 1_700_000_000_000;

function event(recordId, overrides = {}) {
  return {
    recordId,
    timeCreated: `/Date(${BASE + recordId})/`,
    eventId: 4624,
    level: 4,
    provider: 'Microsoft-Windows-Security-Auditing',
    message: `record ${recordId}`,
    ...overrides,
  };
}

/** A route that answers `{ newestRecordId, events }` based on the `$after` value in the script. */
function pageRoute(pages) {
  return (script) => {
    const match = /\$after = (\d+)/u.exec(script);
    const after = match === null ? 0 : Number(match[1]);
    const page = pages(after);
    return { newestRecordId: page.newestRecordId, events: page.events };
  };
}

test('the channel name is validated before it can ever reach a command line', () => {
  assert.equal(assertChannelName('Security'), 'Security');
  assert.equal(assertChannelName('Microsoft-Windows-Sysmon/Operational'), 'Microsoft-Windows-Sysmon/Operational');

  for (const hostile of [
    "Security'; Start-Process calc.exe; '",
    'Security" ; whoami',
    'Security$(calc)',
    'Security`ncalc',
    'Security;calc',
    'Security|x',
    'Security\nx',
    '',
  ]) {
    assert.throws(() => assertChannelName(hostile), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG, hostile);
  }
});

test('the channel is embedded as a single-quoted literal that cannot be escaped', () => {
  const script = buildReadScript('Security', 0);
  assert.match(script, /^\$channel = 'Security'$/mu);
  assert.equal(script.includes('";'), false);

  const probe = buildProbeScript('Application');
  assert.match(probe, /^\$null = Get-WinEvent -LogName 'Application'/mu);
});

test('the record-id filter is a validated integer, not an interpolated expression', () => {
  const script = buildReadScript('Security', 1234);
  assert.match(script, /^\$after = 1234$/mu);
  assert.match(script, /EventRecordID > \$after/u);

  assert.throws(() => buildReadScript('Security', -1), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT);
  assert.throws(() => buildReadScript('Security', '1; calc'), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT);
});

test('the channel maps to a stable, restart-invariant and injective source id', () => {
  assert.equal(channelSourceId('Security'), 'windows.event-log.security');
  assert.match(channelSourceId('Microsoft-Windows-Sysmon/Operational'), /^windows\.event-log\.microsoft-windows-sysmon-operational-[0-9a-f]{8}$/u);

  // The slug transformation is lossy: A.B, A/B, A B and A-B all slug to "a-b". Distinct
  // channels must not collapse into one source id, or `runtime.addSource` fails on the second.
  const collapsed = new Set([
    channelSourceId('A.B'),
    channelSourceId('A/B'),
    channelSourceId('A B'),
    channelSourceId('A-B'),
  ]);
  assert.equal(collapsed.size, 4);

  const long = channelSourceId(`Microsoft-Windows-${'A'.repeat(150)}/Operational`);
  assert.equal(long.length <= 96, true, `${long.length} characters`);
  assert.equal(long, channelSourceId(`Microsoft-Windows-${'A'.repeat(150)}/Operational`), 'the mapping must be deterministic');

  // Windows channel names are case-insensitive. A case change in configuration must not
  // produce a second source id: the cursor would start from 0 and the backlog would be
  // replayed as new events.
  assert.equal(
    channelSourceId('Microsoft-Windows-Sysmon/Operational'),
    channelSourceId('microsoft-windows-sysmon/operational'),
  );
});

test('the descriptor declares the event kind, the probe interval and the retention blind spot', () => {
  const descriptor = describeEventLog('Security');
  assert.equal(descriptor.kind, 'event');
  assert.equal(descriptor.generationAware, true);
  assert.equal(descriptor.intervalMs, EVENT_LOG_PROBE_INTERVAL_MS);
  assert.equal(descriptor.blindSpots.some((entry) => /retention/u.test(entry)), true);
  assert.match(descriptor.rotation, /log_cleared/u);
  assert.match(descriptor.permissions.required[0], /Event Log Readers|Administrator/u);
});

test('a normal read advances the cursor to the highest delivered record id', async () => {
  const powershell = createScriptedPowerShell({
    'event-log': pageRoute((after) => ({
      newestRecordId: 12,
      events: after === 0 ? [event(11), event(12)] : [],
    })),
  });
  const source = createEventLogSource({ powershell, channel: 'Security', clock: createClock(BASE) });
  const result = await source.read({ cursor: null, generation: 0 });

  assert.equal(result.records.length, 2);
  assert.equal(result.nextCursor.lastRecordId, 12);
  assert.equal(result.nextCursor.generation, 0);
  assert.equal(result.reset, null);
  assert.equal(result.identity.size, 12);
  assert.equal(result.records[0].payload.channel, 'Security');
  assert.equal(result.records[0].payload.record_id, 11);
  assert.equal(result.records[0].nativeRecordId, '11');
});

test('records are ordered numerically so 9 comes before 10', async () => {
  const powershell = createScriptedPowerShell({
    'event-log': () => ({ newestRecordId: 10, events: [event(10), event(9), event(2)] }),
  });
  const source = createEventLogSource({ powershell, channel: 'System', clock: createClock(BASE) });
  const result = await source.read({ cursor: null, generation: 0 });

  assert.deepEqual(result.records.map((record) => record.nativeRecordId), ['2', '9', '10']);
  assert.equal(result.nextCursor.lastRecordId, 10);
});

test('a cleared log is detected as a record id regression and returns a reset instruction', async () => {
  const powershell = createScriptedPowerShell({
    'event-log': (script) => {
      const after = Number(/\$after = (\d+)/u.exec(script)[1]);
      if (after === 500) {
        // Newest id after the clear is 3, far below the cursor: the log was cleared.
        return { newestRecordId: 3, events: [] };
      }
      return { newestRecordId: 3, events: [event(1), event(2), event(3)] };
    },
  });
  const source = createEventLogSource({ powershell, channel: 'Security', clock: createClock(BASE) });
  const cursor = { channel: 'Security', lastRecordId: 500, generation: 0, lastObservedAt: BASE };
  const result = await source.read({ cursor, generation: 0 });

  assert.notEqual(result.reset, null);
  assert.equal(result.reset.reason, 'log_cleared');
  assert.equal(result.reset.gapStart, BASE);
  assert.equal(result.nextCursor.generation, 1, 'the cursor must already describe the new generation');
  assert.equal(result.nextCursor.lastRecordId, 3);
  assert.equal(result.records.length, 3);
});

test('a cleared log whose new generation is still empty does not divide by zero', async () => {
  const powershell = createScriptedPowerShell({
    'event-log': () => ({ newestRecordId: 0, events: [] }),
  });
  const source = createEventLogSource({ powershell, channel: 'Security', clock: createClock(BASE) });
  const result = await source.read({
    cursor: { channel: 'Security', lastRecordId: 42, generation: 0, lastObservedAt: BASE },
    generation: 0,
  });

  assert.equal(result.reset.reason, 'log_cleared');
  assert.equal(result.records.length, 0);
  assert.equal(result.nextCursor.lastRecordId, 0);
  assert.equal(result.nextCursor.generation, 1);
});

test('a cursor written under another generation is discarded instead of silently skipping records', async () => {
  const powershell = createScriptedPowerShell({
    'event-log': (script) => {
      const after = Number(/\$after = (\d+)/u.exec(script)[1]);
      return { newestRecordId: 5, events: after === 0 ? [event(1)] : [] };
    },
  });
  const source = createEventLogSource({ powershell, channel: 'Security', clock: createClock(BASE) });
  const result = await source.read({
    cursor: { channel: 'Security', lastRecordId: 900, generation: 3, lastObservedAt: BASE },
    generation: 4,
  });

  assert.equal(result.records.length, 1, 'a stale cursor must re-read from zero, not from the old id');
  assert.equal(result.reset, null, 'a generation mismatch is not a clear event');
});

test('a full page is reported as hasMore, not as a truncation', async () => {
  const events = [];
  for (let index = 1; index <= 4; index += 1) {
    events.push(event(index));
  }
  const powershell = createScriptedPowerShell({
    'event-log': () => ({ newestRecordId: 4, events }),
  });
  const source = createEventLogSource({
    powershell,
    channel: 'System',
    clock: createClock(BASE),
    maxRecordsPerRead: 4,
  });
  const result = await source.read({ cursor: null, generation: 0 });

  // A backlog is not data loss: `truncated` drives the "source_truncated" degradation, and a
  // busy host would otherwise report a permanent truncation gap on every cycle.
  assert.equal(result.hasMore, true);
  assert.equal(result.truncated, false);
  assert.equal(result.records.length, 4);
});

test('the severity table maps every Windows level and defaults to info', () => {
  assert.equal(severityForLevel(1), 'critical');
  assert.equal(severityForLevel(2), 'high');
  assert.equal(severityForLevel(3), 'medium');
  assert.equal(severityForLevel(4), 'low');
  assert.equal(severityForLevel(5), 'info');
  assert.equal(severityForLevel(null), 'info');
  assert.equal(severityForLevel(99), 'info');
});

test('a record without a usable record id is skipped', async () => {
  const powershell = createScriptedPowerShell({
    'event-log': () => ({ newestRecordId: 2, events: [event(1), { recordId: 'x' }, null] }),
  });
  const source = createEventLogSource({ powershell, channel: 'System', clock: createClock(BASE) });
  const result = await source.read({ cursor: null, generation: 0 });
  assert.deepEqual(result.records.map((record) => record.nativeRecordId), ['1']);
});

test('an idle channel is a healthy subscription, a denied channel is not', async () => {
  const idle = createScriptedPowerShell({
    'event-log-probe': () => {
      throw Object.assign(new Error('No events were found'), { code: WINDOWS_ERROR_CODES.NO_EVENTS });
    },
  });
  const idleSource = createEventLogSource({ powershell: idle, channel: 'Security', clock: createClock(BASE) });
  assert.deepEqual(await idleSource.probe(), { ok: true, errorCode: null });

  const denied = createScriptedPowerShell({
    'event-log-probe': () => {
      throw Object.assign(new Error('Access is denied'), { code: WINDOWS_ERROR_CODES.ACCESS_DENIED });
    },
  });
  const deniedSource = createEventLogSource({ powershell: denied, channel: 'Security', clock: createClock(BASE) });
  const probe = await deniedSource.probe();
  assert.equal(probe.ok, false);
  assert.equal(probe.errorCode, WINDOWS_ERROR_CODES.ACCESS_DENIED);
});

test('the default page size is bounded so one read cannot pull an unbounded backlog', () => {
  assert.equal(MAX_RECORDS_PER_READ, 500);
  assert.match(buildReadScript('Security', 0), /Select-Object -First 500/u);
});
