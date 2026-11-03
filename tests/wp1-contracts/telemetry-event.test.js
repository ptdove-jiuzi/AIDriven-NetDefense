import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  canonicalSize,
  ContractError,
  LIMITS,
  parseTelemetryEvent,
  SEVERITY_LEVELS,
  validateTelemetryEvent,
} from '../../packages/contracts/src/index.js';
import { expectCode, UUID_A, validTelemetryEvent } from './helpers.js';

test('合法遥测事件通过并返回冻结的合同记录', () => {
  const event = validTelemetryEvent();
  const record = validateTelemetryEvent(event);
  assert.equal(record.schemaVersion, '1.0');
  assert.match(record.digest, /^[0-9a-f]{64}$/);
  assert.equal(record.digest, canonicalDigest(record.value));
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.value));
  assert.ok(Object.isFrozen(record.value.payload));
  assert.equal(record.value.event_id, UUID_A);
});

test('native_record_id 可省略也可给出', () => {
  assert.equal(validateTelemetryEvent(validTelemetryEvent()).value.native_record_id, undefined);
  const withId = validTelemetryEvent({ native_record_id: '4688-12345' });
  assert.equal(validateTelemetryEvent(withId).value.native_record_id, '4688-12345');
});

test('缺失 event_id 报 ERR_MISSING_FIELD', () => {
  const event = validTelemetryEvent();
  delete event.event_id;
  expectCode(() => validateTelemetryEvent(event), 'ERR_MISSING_FIELD', '$.event_id');
});

test('event_id 非 v4 UUID 被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ event_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' })),
    'ERR_FIELD_PATTERN',
    '$.event_id',
  );
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ event_id: 'ABCDEF01-2345-4678-9ABC-DEF012345678' })),
    'ERR_FIELD_PATTERN',
    '$.event_id',
  );
});

test('source_generation 为负整数被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ source_generation: -1 })),
    'ERR_INTEGER_RANGE',
    '$.source_generation',
  );
});

test('severity 不在枚举内被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ severity: 'urgent' })),
    'ERR_FIELD_ENUM',
    '$.severity',
  );
  assert.deepStrictEqual([...SEVERITY_LEVELS], ['info', 'low', 'medium', 'high', 'critical']);
});

test('type 含大写或没有点时被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ type: 'Process.Created' })),
    'ERR_FIELD_PATTERN',
    '$.type',
  );
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ type: 'processcreated' })),
    'ERR_FIELD_PATTERN',
    '$.type',
  );
});

test('observed_at 晚于 received_at 被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({
      observed_at: '2026-01-01T00:00:02Z',
      received_at: '2026-01-01T00:00:01Z',
    })),
    'ERR_TIMESTAMP_ORDER',
    '$.received_at',
  );
});

test('带 +00:00 偏移的时间戳被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ observed_at: '2026-01-01T00:00:00+00:00' })),
    'ERR_TIMESTAMP_FORMAT',
    '$.observed_at',
  );
});

test('不存在的日期 2026-02-30 被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ observed_at: '2026-02-30T00:00:00Z' })),
    'ERR_TIMESTAMP_FORMAT',
    '$.observed_at',
  );
});

test('integrity.digest 被篡改时报 ERR_INTEGRITY_DIGEST_MISMATCH', () => {
  const event = validTelemetryEvent();
  const tampered = { ...event, integrity: { algorithm: 'sha256', digest: 'f'.repeat(64) } };
  expectCode(() => validateTelemetryEvent(tampered), 'ERR_INTEGRITY_DIGEST_MISMATCH', '$.integrity.digest');
});

test('payload 出现嵌套对象被拒绝', () => {
  const event = validTelemetryEvent({ payload: { nested: { deep: true } } });
  expectCode(() => validateTelemetryEvent(event), 'ERR_FIELD_TYPE', '$.payload.nested');
});

/*
 * normalizeScalarOrArray 只接受"同一种标量类型"的数组：混入 boolean + integer 或
 * string + integer 时，path 必须精确定位到出问题的元素，而不是整个字段。
 */
test('payload 数组混入不同类型标量被拒绝，path 指向首个类型不一致的元素', () => {
  const flags = expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload: { flags: [true, 1] } })),
    'ERR_FIELD_TYPE',
    '$.payload.flags[1]',
  );
  assert.equal(flags.path, '$.payload.flags[1]');
  assert.ok(flags.message.includes('Arrays must contain a single scalar type'));

  const mix = expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload: { mix: ['a', 1] } })),
    'ERR_FIELD_TYPE',
    '$.payload.mix[1]',
  );
  assert.equal(mix.path, '$.payload.mix[1]');

  // 反向顺序同样按"与首元素不同"报错。
  const reversed = expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload: { mix: [1, 'a'] } })),
    'ERR_FIELD_TYPE',
    '$.payload.mix[1]',
  );
  assert.equal(reversed.path, '$.payload.mix[1]');

  // 同类型标量数组必须继续可用。
  const record = validateTelemetryEvent(validTelemetryEvent({
    payload: { flags: [true, false], names: ['a', 'b'], nums: [1, 2] },
  }));
  assert.deepStrictEqual([...record.value.payload.flags], [true, false]);
  assert.deepStrictEqual([...record.value.payload.names], ['a', 'b']);
  assert.deepStrictEqual([...record.value.payload.nums], [1, 2]);
});

test('payload 数组元素类型非法时 path 指向该元素', () => {
  const error = expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload: { nums: [1, 'mixed'] } })),
    'ERR_FIELD_TYPE',
    '$.payload.nums[1]',
  );
  assert.equal(error.path, '$.payload.nums[1]');
});

test('payload 键名大写或含连字符被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload: { ProcessName: 'x' } })),
    'ERR_FIELD_PATTERN',
    '$.payload.ProcessName',
  );
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload: { 'process-name': 'x' } })),
    'ERR_FIELD_PATTERN',
    '$.payload.process-name',
  );
});

test('payload 超过 16 KiB 时报 ERR_OBJECT_TOO_LARGE', () => {
  const payload = {
    first: 'a'.repeat(6000),
    second: 'b'.repeat(6000),
    third: 'c'.repeat(6000),
  };
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload })),
    'ERR_OBJECT_TOO_LARGE',
    '$.payload',
  );
});

test('raw_evidence 通道接受 200 KiB 文本', () => {
  const text = 'a'.repeat(200 * 1024);
  const payload = { raw_evidence: { encoding: 'utf-8', text }, pid: 1 };
  const record = validateTelemetryEvent(validTelemetryEvent({ payload }));
  assert.equal(record.value.payload.raw_evidence.text.length, 200 * 1024);
});

test('200 KiB 字符串放在普通 payload 键上被拒绝', () => {
  const payload = { process_name: 'a'.repeat(200 * 1024) };
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload })),
    'ERR_MAX_STRING_BYTES',
    '$.payload.process_name',
  );
});

test('未知顶层字段被拒绝', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ foo: 'bar' })),
    'ERR_UNKNOWN_FIELD',
    '$.foo',
  );
});

test('解析字符串输入与校验对象输入得到相同的 value 与 digest', () => {
  const event = validTelemetryEvent();
  const fromText = parseTelemetryEvent(JSON.stringify(event));
  const fromObject = validateTelemetryEvent(event);
  assert.deepStrictEqual(fromText.value, fromObject.value);
  assert.equal(fromText.digest, fromObject.digest);
});

test('非对象输入被拒绝且抛 ContractError', () => {
  assert.throws(() => validateTelemetryEvent('{"a":1}'.replace('{"a":1}', 'null')), ContractError);
  expectCode(() => validateTelemetryEvent(null), 'ERR_INPUT_NOT_OBJECT', '$');
});

test('可选字段 native_record_id 传 null 报 ERR_NULL_NOT_ALLOWED', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ native_record_id: null })),
    'ERR_NULL_NOT_ALLOWED',
    '$.native_record_id',
  );
});

function buildPayloadKeys(count) {
  const payload = {};
  for (let index = 0; index < count; index += 1) payload[`k${index}`] = index;
  return payload;
}

test('payload 128 个键被接受', () => {
  const record = validateTelemetryEvent(validTelemetryEvent({ payload: buildPayloadKeys(128) }));
  assert.equal(Object.keys(record.value.payload).length, 128);
});

test('payload 129 个键报 ERR_MAX_OBJECT_KEYS', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload: buildPayloadKeys(129) })),
    'ERR_MAX_OBJECT_KEYS',
    '$.payload',
  );
});

test('raw_evidence.text 接受多行文本且 round-trip 内容不变', () => {
  const text = `line1\nline2\tTAB\r\n${'a'.repeat(200 * 1024)}`;
  const payload = { raw_evidence: { encoding: 'utf-8', text }, pid: 1 };
  const event = validTelemetryEvent({ payload });
  const record = validateTelemetryEvent(event);
  assert.equal(record.value.payload.raw_evidence.text, text);
  // 走解析路径也必须接受同一份字节，而不是只在 validate 路径上放行。
  const fromText = parseTelemetryEvent(JSON.stringify(event));
  assert.equal(fromText.value.payload.raw_evidence.text, text);
  assert.equal(fromText.digest, record.digest);
});

test('raw_evidence.text 里的 ESC 控制符仍然被拒绝', () => {
  const payload = { raw_evidence: { encoding: 'utf-8', text: '\u001b[31mred\u001b[0m' } };
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload })),
    'ERR_STRING_CONTROL_CHARACTER',
    '$.payload.raw_evidence.text',
  );
  expectCode(
    () => parseTelemetryEvent(JSON.stringify(validTelemetryEvent({ payload }))),
    'ERR_STRING_CONTROL_CHARACTER',
    '$.payload.raw_evidence.text',
  );
});

test('raw_evidence.text 里的双向覆盖符 U+202E 仍然被拒绝', () => {
  const payload = { raw_evidence: { encoding: 'utf-8', text: 'safe\u202Eevil' } };
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload })),
    'ERR_STRING_BIDI_OVERRIDE',
    '$.payload.raw_evidence.text',
  );
});

test('普通 payload 键不接受换行', () => {
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload: { process_name: 'a\nb' } })),
    'ERR_STRING_CONTROL_CHARACTER',
    '$.payload.process_name',
  );
});

/*
 * 256 KiB 原始证据边界：这是设计数值的算术结果，不是缺陷。
 * maxRawEvidenceStringBytes 是"单字符串"上限（262144），而单事件 / payload 的总限
 * 同样是 262144，信封开销（键名、引号、encoding 等）必然先撞总限，
 * 所以"文本恰好 262144 字节"一定失败，260000 字节仍然可用。
 * 不要为了让单字符串拿满 256KiB 而调大 LIMITS —— 那会破坏与设计文档的对齐。
 */
test('256 KiB 边界：文本恰 262144 字节撞总限，是设计数值的算术结果而非缺陷', () => {
  assert.equal(LIMITS.maxRawEvidenceStringBytes, 262144);
  assert.equal(LIMITS.maxEventBytes, 262144);
  const text = 'a'.repeat(LIMITS.maxRawEvidenceStringBytes);
  const payload = { raw_evidence: { encoding: 'utf-8', text } };
  expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload })),
    'ERR_OBJECT_TOO_LARGE',
    '$.payload',
  );
});

test('256 KiB 边界：260000 字节文本仍被接受（信封开销之外的净文本上限）', () => {
  const text = 'a'.repeat(260000);
  const payload = { raw_evidence: { encoding: 'utf-8', text } };
  const record = validateTelemetryEvent(validTelemetryEvent({ payload }));
  assert.equal(record.value.payload.raw_evidence.text.length, 260000);
  // 解析路径同样接受，证明边界不是只在 validate 路径上成立。
  const fromText = parseTelemetryEvent(JSON.stringify(validTelemetryEvent({ payload })));
  assert.equal(fromText.value.payload.raw_evidence.text.length, 260000);
});

/*
 * 整事件 256 KiB 上限：payload 自身仍在 262144 字节以内，但加上信封（键名、引号、
 * 时间戳、integrity 等，实测约 494 字节）后总字节越界。这条路径过去零覆盖，
 * 必须由 validateTelemetryEvent 末尾的 canonicalSize(normalized) 检查兜住，
 * 且 path 是 '$'（整事件），与 payload 内部路径（'$.payload'）区分开。
 */
test('整事件 256 KiB 上限：payload 未超限但事件总字节超限时报事件级 ERR_OBJECT_TOO_LARGE', () => {
  const text = 'a'.repeat(261900);
  const payload = { raw_evidence: { encoding: 'utf-8', text } };
  // 前置条件：payload 单独看确实没有越界，否则测到的就不是整事件上限。
  const payloadBytes = canonicalSize(payload);
  assert.ok(payloadBytes <= LIMITS.maxEventBytes, `payload ${payloadBytes} 不应超过 maxEventBytes`);
  assert.ok(payloadBytes > LIMITS.maxEventBytes - 1024, `payload ${payloadBytes} 应贴近上限窗口`);

  const error = expectCode(
    () => validateTelemetryEvent(validTelemetryEvent({ payload })),
    'ERR_OBJECT_TOO_LARGE',
    '$',
  );
  assert.equal(error.path, '$', '整事件超限的 path 必须是 $，不能是 payload 内部路径');
  assert.match(error.message, /Event exceeds 262144 canonical bytes/);
});
