// author: PT-dove
// M9 对抗语料 —— Windows 采集器的解析与构造面。
//
// Windows 侧的设计选择是"值坏了就丢，键坏了就抛"：键名违规是包自身的编程错误，
// 必须立刻炸；值不可表示是运行期数据，必须清洗/丢弃并计数，否则一条畸形记录会
// 让整批消失。本文件把这条分界逐项变成断言，并且把清洗后的 payload 真的喂给
// contracts 校验一次——"清洗到位"不能只由清洗函数自己证明。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOWS_ERROR_CODES,
  WindowsCollectorError,
  assertChannelName,
  buildPayload,
  channelSourceId,
  createPowerShellClient,
  escapePsLiteral,
  normalizePayload,
  parseWindowsDate,
  psQuote,
  sanitizeText,
  toInteger,
  toText,
  truncateUtf8,
} from '../../packages/collectors/windows/index.js';
import { validateTelemetryEvent } from '../../packages/contracts/src/index.js';
import {
  WINDOWS_PAYLOAD_BAD_KEYS,
  WINDOWS_PAYLOAD_SANITIZE_CASES,
} from './support/corpus.js';
import { escapeForMessage, expectRejection } from './support/harness.js';
import { telemetryEvent } from './support/fixtures.js';

/** 假 runner：只记录请求并返回预设结果，绝不执行任何命令。 */
function fakeRunner(response) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      return { ok: true, code: 0, signal: null, stderr: '', durationMs: 1, timedOut: false, truncated: false, ...response };
    },
  };
}

for (const entry of WINDOWS_PAYLOAD_BAD_KEYS) {
  test(`payload 键违规必须显式抛错：${entry.id}（${entry.note}）`, () => {
    const error = expectRejection(() => normalizePayload({ [entry.key]: 1 }), {
      code: WINDOWS_ERROR_CODES.INVALID_RECORD,
      type: WindowsCollectorError,
      label: entry.id,
    });
    assert.equal(error.details?.key, entry.key);
  });
}

for (const entry of WINDOWS_PAYLOAD_SANITIZE_CASES) {
  test(`payload 值被清洗而不是让整批失败：${entry.id}（${entry.note}）`, () => {
    const { payload, dropped } = normalizePayload({ [entry.key]: entry.value });
    const cleaned = payload[entry.key];
    assert.equal(typeof cleaned, 'string', `${entry.id}: the value must survive as text`);
    assert.equal(
      cleaned.includes(entry.mustNotContain),
      false,
      `${entry.id}: ${escapeForMessage(cleaned)} still contains ${escapeForMessage(entry.mustNotContain)}`,
    );
    assert.equal(dropped.length, 0, `${entry.id}: sanitizing is not dropping`);
    // 归一化结果必须已经是 NFC，否则下游 contracts 会拒绝。
    assert.equal(cleaned.normalize('NFC'), cleaned);
    // "清洗"不等于"清空"：至少一个可打印字符必须留下，否则一个 `return ''` 的实现也能全绿。
    assert.ok(
      /[\x20-\x7e]/u.test(cleaned) || /[^\u0000-\u001f\u007f-\u009f]/u.test(cleaned),
      `${entry.id}: sanitizing must keep the readable content, got ${escapeForMessage(cleaned)}`,
    );
  });
}

test('payload 键 "__proto__" 在赋值之前就被键名规则拦住（不会污染原型）', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  // 计算属性名构造的是**自有**键，等价于 JSON 文本里的 "__proto__"。
  const source = { ['__proto__']: { polluted: true } };
  expectRejection(() => normalizePayload(source), {
    code: WINDOWS_ERROR_CODES.INVALID_RECORD,
    type: WindowsCollectorError,
  });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(','), before);
});

test('payload 键 "constructor" 通过键名规则，但只作为自有数据属性写入', () => {
  const { payload } = normalizePayload(JSON.parse('{"constructor":"data-only"}'));
  assert.equal(payload.constructor, 'data-only');
  assert.equal(Object.getPrototypeOf(payload), Object.prototype, 'the prototype must not be replaced');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'constructor'), true);
});

test('清洗后的 payload 真的能通过 contracts 校验（跨模块闭环）', () => {
  const hostile = {
    message: '\u001b[31mFailed password\u001b[0m\r\n\tfor root\u0000',
    provider: 'gnp\u202eexe',
    user: `bad${String.fromCharCode(0xd800)}name`,
    command_line: 'a'.repeat(200 * 1024),
    record_id: 9007199254740993,
    pid: 4242,
  };
  const { payload, dropped } = normalizePayload(hostile);
  assert.ok(dropped.length >= 1, 'the unsafe integer must be dropped, not rounded');
  assert.equal(Object.hasOwn(payload, 'record_id'), false);

  const event = telemetryEvent({ payload });
  const record = validateTelemetryEvent(event);
  assert.equal(record.value.payload.pid, 4242);
  assert.ok(record.value.payload.message.length > 0);
  assert.equal(record.value.payload.message.includes('\u001b'), false);
});

test('总字节预算：40 个 4 KiB 字符串被压到 16 KiB 以内，且契约仍然接受', () => {
  const source = {};
  for (let index = 0; index < 40; index += 1) source[`k${index}`] = 'x'.repeat(4000);
  const { payload, dropped } = normalizePayload(source);
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.ok(bytes <= 16 * 1024, `payload is ${bytes} bytes, the budget is 16384`);
  assert.ok(Object.keys(payload).length >= 1, 'the budget must not empty the payload entirely');
  assert.ok(dropped.some((entry) => entry.reason === 'payload_budget' || entry.reason === 'payload_budget_dropped'));
  assert.equal(validateTelemetryEvent(telemetryEvent({ payload })).value.payload.pid, undefined);
});

test('数组也是预算的一部分：256 个长字符串不会撑出 52 KiB', () => {
  const source = { paths: Array.from({ length: 256 }, (_, index) => `${index}:${'y'.repeat(400)}`) };
  const { payload } = normalizePayload(source);
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 16 * 1024);
  // 数组只能被整体丢弃（预算只收缩字符串），因此要么存在且合规，要么不存在。
  if (Object.hasOwn(payload, 'paths')) {
    assert.ok(Array.isArray(payload.paths));
  }
});

test('值类型规则：嵌套对象、混合数组、非安全整数、浮点都被丢弃并记录原因', () => {
  const { payload, dropped } = normalizePayload({
    nested: { a: 1 },
    mixed: [1, 'a'],
    float: 1.5,
    huge: 9007199254740993,
    nan: Number.NaN,
    negative_zero: -0,
    empty_array: [],
  });
  assert.deepEqual(Object.keys(payload).sort(), ['negative_zero']);
  assert.equal(Object.is(payload.negative_zero, -0), false, '-0 must be normalized to 0');
  const reasons = new Set(dropped.map((entry) => entry.reason));
  assert.ok(reasons.has('unsupported_type'), 'nested objects are dropped as unsupported');
  assert.ok(reasons.has('mixed_array_types'));
  assert.ok(reasons.has('non_integer_number'));
});

test('键数上限：超出 maxKeys 的键被丢弃并记录，不会静默截断', () => {
  const source = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, index]));
  const { payload, dropped } = normalizePayload(source, { maxKeys: 4 });
  assert.equal(Object.keys(payload).length, 4);
  assert.equal(dropped.filter((entry) => entry.reason === 'too_many_keys').length, 8);
});

test('truncateUtf8 按码点截断，不切碎代理对', () => {
  const emoji = '\u{1F600}'.repeat(10);
  const cut = truncateUtf8(emoji, 13);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 13);
  assert.equal(cut.isWellFormed(), true, 'a truncated string must never contain half a surrogate pair');
  assert.equal(truncateUtf8('abcdef', 100), 'abcdef');
  assert.equal(truncateUtf8('abcdef', 0), '');
  assert.equal(truncateUtf8('abcdef', 3), '', 'below 4 bytes there is no room for content plus the ellipsis');
});

test('sanitizeText 对非字符串返回 null，对空串返回空串', () => {
  assert.equal(sanitizeText(undefined), null);
  assert.equal(sanitizeText(42), null);
  assert.equal(sanitizeText({}), null);
  assert.equal(sanitizeText(''), '');
});

test('PowerShell 输出不是 JSON 时按 BAD_JSON 失败，并带截断摘要', () => {
  const client = createPowerShellClient({ runner: fakeRunner({ stdout: 'not json at all' }) });
  return assert.rejects(
    () => client.runJson('Get-Item'),
    (error) => {
      assert.equal(error.code, WINDOWS_ERROR_CODES.BAD_JSON);
      assert.equal(typeof error.details.excerpt, 'string');
      assert.ok(error.details.excerpt.length <= 512);
      return true;
    },
  );
});

test('PowerShell 空输出被当成"没有结果"，不是解析失败', async () => {
  const client = createPowerShellClient({ runner: fakeRunner({ stdout: '   \n' }) });
  assert.equal(await client.runJson('Get-Item'), null);
});

test('PowerShell 输出带 BOM 时先剥 BOM 再解析', async () => {
  const client = createPowerShellClient({ runner: fakeRunner({ stdout: '\ufeff{"a":1}' }) });
  assert.deepEqual(await client.runJson('Get-Item'), { a: 1 });
});

test('PowerShell 输出里的重复键是 last-wins（记录：DEF-06，与 plugin-manager 策略不同）', async () => {
  // `parseJsonOutput` 用 JSON.parse：它看不见重复键。这里的数据源是本机受信进程，
  // 风险低于跨进程 IPC，但"同一份文本在不同组件里解释不同"仍是 AT-IPC-002 要盯的点。
  const client = createPowerShellClient({ runner: fakeRunner({ stdout: '{"a":1,"a":2}' }) });
  assert.deepEqual(await client.runJson('Get-Item'), { a: 2 });
});

test('脚本始终通过 stdin 传入，命令行参数固定（没有拼接式注入面）', async () => {
  const runner = fakeRunner({ stdout: '{}' });
  const client = createPowerShellClient({ runner });
  await client.runJson('Get-Item');
  const [call] = runner.calls;
  assert.deepEqual(call.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']);
  assert.equal(typeof call.stdin, 'string');
  assert.equal(call.stdin.includes("$ErrorActionPreference='Stop'"), true);
});

test('单引号字面量转义：引号被双写，无法闭合字符串', () => {
  assert.equal(escapePsLiteral("a'b"), "a''b");
  assert.equal(psQuote("a'b"), "'a''b'");
  assert.equal(psQuote("'; Remove-Item -Recurse /"), "'''; Remove-Item -Recurse /'");
});

test('事件通道名：注入字符一律拒绝', () => {
  const hostile = [
    "Security'; Remove-Item -Recurse C:\\",
    'Security$(Get-Process)',
    'Security`whoami`',
    'Security; Get-Process',
    'Security|Out-File x',
    'Security\nGet-Process',
    'Security\tGet-Process',
    'Security"x',
    '',
  ];
  for (const channel of hostile) {
    expectRejection(() => assertChannelName(channel), {
      code: WINDOWS_ERROR_CODES.INVALID_CONFIG,
      type: WindowsCollectorError,
      label: escapeForMessage(channel),
    });
  }
});

test('事件通道名：合法名字通过，且大小写不产生两个来源 id', () => {
  assert.equal(assertChannelName('Security'), 'Security');
  assert.equal(assertChannelName('Microsoft-Windows-Sysmon/Operational'), 'Microsoft-Windows-Sysmon/Operational');
  assert.equal(
    channelSourceId('Sysmon/Operational'),
    channelSourceId('sysmon/operational'),
    'channel names are case-insensitive on Windows, so the stable id must be too',
  );
  // 有损 slug 必须带摘要后缀，否则 'A.B' 与 'A/B' 会共用同一个来源 id。
  assert.notEqual(channelSourceId('A.B'), channelSourceId('A/B'));
});

test('日期解析：/Date(...)/ 与 ISO 都接受，垃圾值返回 null 而不是 Invalid Date', () => {
  assert.equal(parseWindowsDate('/Date(1700000000000)/'), 1_700_000_000_000);
  assert.equal(parseWindowsDate('/Date(1700000000000+0800)/'), 1_700_000_000_000);
  assert.equal(parseWindowsDate('2023-11-14T22:13:20Z'), Date.UTC(2023, 10, 14, 22, 13, 20));
  assert.equal(parseWindowsDate(1_700_000_000_000), 1_700_000_000_000);
  for (const bad of ['not-a-date', '/Date(abc)/', '', null, {}, Number.NaN, -1]) {
    assert.equal(parseWindowsDate(bad), null, `${String(bad)} must not produce a date`);
  }
});

test('整数解析：超出安全整数返回 null（不四舍五入成另一个 pid）', () => {
  assert.equal(toInteger(42), 42);
  assert.equal(toInteger(' 42 '), 42);
  assert.equal(toInteger('-7'), -7);
  assert.equal(toInteger('9007199254740993'), null);
  assert.equal(toInteger(9007199254740993), null);
  assert.equal(toInteger(1.5), null);
  assert.equal(toInteger('1.5'), null);
  assert.equal(toInteger('0x10'), null);
  assert.equal(toInteger(true), null);
});

test('文本解析：数字与布尔转成字符串，其余返回 null', () => {
  assert.equal(toText('x'), 'x');
  assert.equal(toText(''), null);
  assert.equal(toText(7), '7');
  assert.equal(toText(false), 'false');
  assert.equal(toText(null), null);
  assert.equal(toText({}), null);
});

test('buildPayload 返回冻结对象（调用方不能事后改摘要覆盖的内容）', () => {
  const built = buildPayload({ pid: 1 });
  assert.ok(Object.isFrozen(built));
  assert.ok(Object.isFrozen(built.payload));
  assert.ok(Object.isFrozen(built.dropped));
});
