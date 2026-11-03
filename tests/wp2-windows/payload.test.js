import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PAYLOAD_BYTES,
  MAX_PAYLOAD_STRING_BYTES,
  WINDOWS_ERROR_CODES,
  normalizePayload,
  sanitizeText,
  truncateUtf8,
} from '../../packages/collectors/windows/index.js';
// Read-only cross-check: the adapter must produce payloads the contract layer accepts.
import { validatePayload } from '../../packages/contracts/src/objects/telemetry-event.js';

test('a camelCase payload key is rejected instead of silently failing at delivery', () => {
  // This is the exact shape the pre-audit sources emitted.
  assert.throws(
    () => normalizePayload({ imagePath: 'C:\\x.exe' }),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_RECORD && /imagePath/u.test(error.message),
  );
});

test('null values are omitted so "unknown" is expressed by absence, not by a rejected field', () => {
  const { payload, dropped } = normalizePayload({ pid: 4, image_path: null, command_line: undefined });
  assert.deepEqual(payload, { pid: 4 });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'image_path'), false);
  assert.deepEqual(dropped, []);
});

test('non-integer numbers are dropped rather than rounded into a different object', () => {
  const { payload, dropped } = normalizePayload({ pid: 4, port: 1.5, huge: Number.MAX_SAFE_INTEGER + 2 });
  assert.deepEqual(payload, { pid: 4 });
  assert.deepEqual(dropped.map((entry) => entry.key), ['port', 'huge']);
  assert.equal(dropped[0].reason, 'non_integer_number');
});

test('control characters, bidi marks and zero-width characters are removed and NFC is applied', () => {
  const raw = 'line1\r\nline2\tcol\u0000\u001B[31mred\u202Eevil\u200Bzero';
  const cleaned = sanitizeText(raw);

  assert.equal(cleaned, 'line1 line2 col[31mredevilzero');
  assert.equal(cleaned.includes('\n'), false);
  assert.equal(/[\u200B-\u200F\u202A-\u202E]/.test(cleaned), false);
  assert.equal(cleaned.normalize('NFC'), cleaned);
});

test('a decomposed string is normalized so two spellings cannot become two events', () => {
  const decomposed = 'e\u0301';  // e + combining acute
  const composed = '\u00E9';
  assert.equal(sanitizeText(decomposed), composed);
});

test('an unpaired surrogate becomes a replacement character instead of an invalid event', () => {
  assert.equal(sanitizeText('ok\uD800bad'), 'ok\uFFFDbad');
});

test('a string is truncated by UTF-8 bytes without splitting a character', () => {
  const text = '中'.repeat(10);
  const truncated = truncateUtf8(text, 10);
  assert.equal(Buffer.byteLength(truncated, 'utf8') <= 10, true);
  assert.equal(truncated.endsWith('...'), true);
  assert.equal(truncated.includes('\uFFFD'), false, 'a split code point must not produce a replacement char');
});

test('the whole payload is held under the contract byte budget', () => {
  const { payload } = normalizePayload({ message: 'x'.repeat(40_000), provider: 'p' });
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.equal(size <= MAX_PAYLOAD_BYTES, true, `payload was ${size} bytes`);
  assert.equal(payload.provider, 'p');
});

test('an oversized array is shrunk or dropped instead of blowing the byte budget', () => {
  // Regression: the budget pass only looked at top-level strings, so a 256-item array of long
  // strings produced a 52 KiB payload that the contract then rejected.
  const longStrings = Array.from({ length: 256 }, () => 'y'.repeat(200));
  const { payload, dropped } = normalizePayload({ long_array: longStrings, pid: 7 });

  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.equal(size <= MAX_PAYLOAD_BYTES, true, `payload was ${size} bytes`);
  const validated = validatePayload(payload);
  assert.equal(validated.pid, 7);
  assert.equal(dropped.length > 0, true, 'the loss must be reported, not silently swallowed');
});

test('mixed-type and non-scalar arrays are dropped instead of being sent to a closed schema', () => {
  const { payload, dropped } = normalizePayload({ mixed: ['a', 1], objects: [{ a: 1 }], empty: [] });
  assert.deepEqual(payload, {});
  assert.deepEqual(dropped.map((entry) => entry.reason), ['mixed_array_types', 'non_scalar_array_item']);
});

test('a homogeneous scalar array survives, including booleans and integers', () => {
  const { payload } = normalizePayload({ flags: [true, false], ports: [80, 443] });
  assert.deepEqual(payload, { flags: [true, false], ports: [80, 443] });
});

test('every sanitized payload passes the real contract validator', () => {
  const hostile = {
    channel: 'Security',
    record_id: 42,
    event_id: 4624,
    provider: 'Microsoft-Windows-\u202ESecurity',
    message: 'line1\r\nline2\twith tab and \u0000 null',
    time_created: '2023-11-14T22:13:20.000Z',
    level: 4,
    present: true,
  };
  const { payload } = normalizePayload(hostile);

  // Throws a ContractError if any rule (keys, nulls, controls, NFC, size) is violated.
  const validated = validatePayload(payload);
  assert.equal(validated.record_id, 42);
  assert.equal(validated.message.includes('\r'), false);
});

test('the default string budget is the contract per-string limit, not the payload budget', () => {
  assert.equal(MAX_PAYLOAD_STRING_BYTES, 16 * 1024);
  const long = sanitizeText('a'.repeat(MAX_PAYLOAD_STRING_BYTES + 100));
  assert.equal(Buffer.byteLength(long, 'utf8') <= MAX_PAYLOAD_STRING_BYTES, true);
});

test('a real source payload passes the contract validator', () => {
  // The generic sanitizer test above feeds a hand-built object; this one runs an actual
  // source end to end, which is what the daemon will actually deliver.
  return import('../../packages/collectors/windows/index.js').then(async (windows) => {
    const powershell = {
      async runJson() {
        return [{
          ProcessId: 4321,
          ParentProcessId: 4,
          Name: 'x.exe',
          ExecutablePath: 'C:\\x.exe',
          CommandLine: 'x.exe --a\tb\r\nc',
          CreationDate: '/Date(1700000000000)/',
        }];
      },
    };
    const source = windows.createProcessSource({ powershell, clock: () => 1_700_000_000_000 });
    const result = await source.read();
    const validated = validatePayload(result.records[0].payload);
    assert.equal(validated.pid, 4321);
    assert.equal(validated.command_line.includes('\n'), false);
  });
});
