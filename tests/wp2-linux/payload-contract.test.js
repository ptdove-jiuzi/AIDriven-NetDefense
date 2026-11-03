/**
 * DEF-04 / DEF-03 回归用例：Linux 采集 payload 必须通过 TelemetryEvent 合同。
 *
 * 修复前的实测现状（见 `docs/implementation/evidence/security-corpus/REPORT.md` §5）：
 *
 * - **DEF-04**：payload 的键是 camelCase（`byteLength`、`lineDigest`、`startTicks`、
 *   `exePath`、`unitName`、...），而合同要求 `^[a-z][a-z0-9_]{0,63}$`；值里还带 `null`，
 *   合同明确拒绝 null。结果是一条**完全正常**的 auth.log 行在 `validateTelemetryEvent`
 *   处以 `ERR_FIELD_PATTERN $.payload.byteLength` 被拒。
 * - **DEF-03**：`ESC[31m`、`NUL`、行尾 `\r`、`U+202E` 被原样带进 `payload.line`，
 *   于是"能写日志的一方"可以用一行带 ESC 的文本让整条记录作废。
 * - 另外：`payload.content` 是嵌套对象，合同只接受标量（同类标量数组），同样必被拒。
 *
 * 本文件把"每个源产出的每一条 payload 都能过合同"钉成断言，并且**不用宽松断言**：
 * 走的是真正的 `validateTelemetryEvent`，摘要用真正的 `canonicalDigest`。
 *
 * 修复前这些用例会红：`validateTelemetryEvent` 抛 ERR_FIELD_PATTERN / ERR_NULL_NOT_ALLOWED /
 * ERR_STRING_CONTROL_CHARACTER，`payload.line` 里仍含 `\u001b`。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  canonicalDigest,
  validateTelemetryEvent,
} from '../../packages/contracts/src/index.js';
import {
  AUTH_LOG_SOURCE_ID,
  MAX_PAYLOAD_BYTES,
  createAuthLogSource,
  createCronSource,
  createDeclaredDirectorySource,
  createJournaldSource,
  createMemoryFileSystem,
  createProcfsConnectionSource,
  createProcfsProcessSource,
  createScriptedCommandRunner,
  createSystemdUnitSource,
  normalizePayload,
  sanitizeText,
} from '../../packages/collectors/linux/index.js';

const BASE = 1_700_000_000_000;
const LOG_PATH = '/var/log/auth.log';

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

/** Render the journald fixture as the JSON-lines stream journalctl would print. */
function journalStdout() {
  const data = fixture('journald-output.json');
  return `${data.entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/**
 * Wrap one record payload in a minimal but *real* TelemetryEvent and validate it.
 *
 * @param {object} record Collector record.
 * @param {string} stableSourceId Descriptor id the record came from.
 * @returns {object} The validated (frozen) event.
 */
function validateAsEvent(record, stableSourceId) {
  const payload = record.payload;
  return validateTelemetryEvent({
    schemaVersion: '1.0',
    event_id: '11111111-1111-4111-8111-111111111111',
    stable_source_id: stableSourceId,
    collector_instance_id: '22222222-2222-4222-8222-222222222222',
    source_generation: 0,
    boot_id: '33333333-3333-4333-8333-333333333333',
    source_seq: Number.isSafeInteger(record.sourceSequence) ? record.sourceSequence : 0,
    observed_at: new Date(BASE).toISOString(),
    received_at: new Date(BASE).toISOString(),
    type: record.type,
    severity: record.severity,
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
  });
}

/** Assert every record of a read result round-trips through the contract. */
function assertAllPayloadsValid(records, stableSourceId) {
  assert.ok(records.length > 0, 'the fixture must produce at least one record');
  for (const record of records) {
    assert.doesNotThrow(
      () => validateAsEvent(record, stableSourceId),
      `payload of ${record.type} must satisfy the TelemetryEvent contract`,
    );
  }
}

const PAYLOAD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const ZERO_WIDTH = /[\u200b-\u200f\ufeff\u2060]/;

// ------------------------------------------------------------------ DEF-04

test('DEF-04：auth.log 的每一条 payload 都能通过 TelemetryEvent 合同', async () => {
  const content = [
    'Oct 31 10:00:01 lab-host.example.test sshd[812]: Failed password for root',
    'Oct 31 10:00:02 lab-host.example.test sshd[812]: Accepted publickey for deploy',
    'garbage line with no timestamp at all',
    '',
  ].join('\n');
  const fileSystem = createMemoryFileSystem({ files: { [LOG_PATH]: content } });
  const source = createAuthLogSource({
    fileSystem,
    clock: () => BASE,
    initialPosition: 'start',
  });
  const result = await source.read();
  assert.equal(result.status, 'ok');
  assert.equal(result.records.length, 3);

  for (const record of result.records) {
    const keys = Object.keys(record.payload);
    assert.deepEqual(
      keys.filter((key) => !PAYLOAD_KEY.test(key)),
      [],
      'every payload key is snake_case and matches the contract pattern',
    );
    assert.equal(Object.values(record.payload).includes(null), false, 'payload never carries null');
    validateAsEvent(record, AUTH_LOG_SOURCE_ID);
  }

  // 键名必须是"合同形态"而不是旧的 camelCase：这条断言在修复前会失败。
  const first = result.records[0].payload;
  for (const legacy of ['byteLength', 'lineDigest', 'lineTruncated', 'timestampStyle']) {
    assert.equal(Object.hasOwn(first, legacy), false, `legacy camelCase key "${legacy}" is gone`);
  }
  assert.equal(typeof first.byte_length, 'number');
  assert.match(first.line_digest, /^[0-9a-f]{8,64}$/u);
  assert.equal(first.timestamp_style, 'syslog');
  assert.equal(first.parsed, true);
});

test('DEF-04：其余五个源的 payload 同样通过合同（含 systemd 的 unit content）', async () => {
  const systemdFileSystem = createMemoryFileSystem(fixture('systemd.json'));
  const systemd = await createSystemdUnitSource({
    fileSystem: systemdFileSystem,
    clock: () => BASE,
    includeContent: true,
  }).read();
  assertAllPayloadsValid(systemd.records, 'linux.systemd-units');
  // 嵌套对象不能进 payload：unit content 以一条可逆的 JSON 字符串承载。
  const withContent = systemd.records.find((record) => record.payload.content_json !== undefined);
  assert.notEqual(withContent, undefined, 'opt-in unit content survives as content_json');
  assert.equal(typeof JSON.parse(withContent.payload.content_json), 'object');

  const cron = await createCronSource({
    fileSystem: createMemoryFileSystem(fixture('cron.json')),
    clock: () => BASE,
  }).read();
  assertAllPayloadsValid(cron.records, 'linux.cron');

  const directories = await createDeclaredDirectorySource({
    fileSystem: createMemoryFileSystem(fixture('directories.json')),
    clock: () => BASE,
    roots: ['/etc'],
  }).read();
  assertAllPayloadsValid(directories.records, 'linux.file-metadata');

  const processes = await createProcfsProcessSource({
    fileSystem: createMemoryFileSystem(fixture('procfs.json')),
    clock: () => BASE,
  }).read();
  assertAllPayloadsValid(processes.records, 'linux.procfs-processes');

  const connections = await createProcfsConnectionSource({
    fileSystem: createMemoryFileSystem(fixture('net.json')),
    clock: () => BASE,
  }).read();
  assertAllPayloadsValid(connections.records, 'linux.connection');

  const journald = await createJournaldSource({
    runner: createScriptedCommandRunner([{ stdout: journalStdout() }]),
    clock: () => BASE,
  }).read();
  assertAllPayloadsValid(journald.records, 'linux.journald');
});

test('DEF-04：键名不合规是编程错误，必须立刻抛出而不是静默改名', () => {
  assert.throws(
    () => normalizePayload({ byteLength: 1 }),
    (error) => error.code === 'INVALID_ARGUMENT' && /snake_case/u.test(error.message),
  );
  assert.throws(() => normalizePayload(null), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => normalizePayload([]), (error) => error.code === 'INVALID_ARGUMENT');
});

// ------------------------------------------------------------------ DEF-03

test('DEF-03：控制符 / DEL / C1 / 双向符 / 零宽字符不进 payload，可读内容仍在', async () => {
  // 一行里塞满所有类别：ANSI 转义、NUL、TAB、CR、DEL、C1(NEL)、U+202E、U+200B、NFD 组合。
  const hostile = 'Oct 31 10:00:03 lab-host.example.test sshd[812]: '
    + 'a\u001b[31mred\u001b[0m b\u0000c\td\re\u007ff\u0085g\u202eh\u200bi\u0301j';
  const fileSystem = createMemoryFileSystem({ files: { [LOG_PATH]: `${hostile}\n` } });
  const source = createAuthLogSource({
    fileSystem,
    clock: () => BASE,
    initialPosition: 'start',
  });
  const result = await source.read();
  assert.equal(result.records.length, 1);
  const payload = result.records[0].payload;

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== 'string') continue;
    assert.equal(CONTROL.test(value), false, `payload.${key} must not carry C0/C1 control characters`);
    assert.equal(BIDI.test(value), false, `payload.${key} must not carry bidi controls`);
    assert.equal(ZERO_WIDTH.test(value), false, `payload.${key} must not carry zero-width characters`);
    assert.equal(value, value.normalize('NFC'), `payload.${key} must be NFC`);
  }

  // 清洗不能变成"删内容"：可读字符必须还在，而且整条 payload 仍然能过合同。
  assert.match(payload.line, /red/u, 'the printable text inside the ANSI sequence is kept');
  for (const fragment of ['[31m', '[0m', 'bc', 'efgh']) {
    assert.equal(payload.line.includes(fragment), true, `readable fragment "${fragment}" is preserved`);
  }
  assert.equal(payload.line.includes('\u001b'), false);
  assert.equal(payload.line.includes('\u202e'), false);
  validateAsEvent(result.records[0], AUTH_LOG_SOURCE_ID);
});

test('DEF-03：journald 的 MESSAGE 同样被清洗，键名同样是合同形态', async () => {
  const entry = {
    __CURSOR: 's=abcdef;i=1;b=1;m=1;t=1;x=1',
    __REALTIME_TIMESTAMP: '1700000000000000',
    PRIORITY: '4',
    SYSLOG_IDENTIFIER: 'sshd',
    _PID: '812',
    _HOSTNAME: 'lab-host.example.test',
    MESSAGE: 'bad \u001b[1mline\u001b[0m with \u0000nul and \u0085nel and \u202eRTL',
    _TRANSPORT: 'syslog',
  };
  const runner = createScriptedCommandRunner([{ stdout: `${JSON.stringify(entry)}\n` }]);
  const journald = await createJournaldSource({ runner, clock: () => BASE }).read();
  assert.equal(journald.records.length, 1);
  const payload = journald.records[0].payload;
  assert.equal(CONTROL.test(payload.message), false);
  assert.equal(payload.message.includes('\u202e'), false);
  assert.match(payload.message, /bad .*line.*with .*nul.*nel/u);
  assert.equal(Object.hasOwn(payload, 'messageId'), false, 'camelCase key would be rejected outright');
  assert.equal(payload.identifier, 'sshd');
  validateAsEvent(journald.records[0], 'linux.journald');
});

// ------------------------------------------------------------- 预算与清洗单元

test('payload 预算：单字段超长被截断到 16 KiB 总预算内，且仍是合法合同 payload', () => {
  const huge = 'x'.repeat(64 * 1024);
  const { payload, dropped } = normalizePayload({ path: '/listed', line: huge, offset: 1 });
  assert.ok(
    Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_PAYLOAD_BYTES,
    'the rendered payload stays inside the byte budget',
  );
  assert.equal(payload.line.endsWith('...'), true, 'truncation is explicit');
  assert.equal(dropped.some((entry) => entry.reason === 'payload_budget'), true);
});

test('sanitizeText 保留可读内容并统一为 NFC', () => {
  const cleaned = sanitizeText('a\u0000b\u007fc\u009fd\u202ee\u200bfi\u0301');
  assert.equal(cleaned, 'abcdefi\u0301'.normalize('NFC'));
  assert.equal(sanitizeText(42), null);
});
