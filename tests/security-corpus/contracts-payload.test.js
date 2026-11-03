// author: PT-dove
// M9 对抗语料 —— TelemetryEvent / payload 负向语料（AT-DATA-003 / AT-IPC-002 的子集）。
//
// 关注点：payload 是唯一可以携带"来自被观测系统"的自由文本的地方。它因此是
// 注入（ANSI / 双向符 / 零宽 / 代理项）与走私（隐藏键、原型污染、类型混淆）的
// 主要入口。这里逐条钉住"必须拒绝"。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractError,
  ERROR_CODES,
  LIMITS,
  canonicalDigest,
  parseTelemetryEvent,
  validateTelemetryEvent,
} from '../../packages/contracts/src/index.js';
import { PAYLOAD_REJECTIONS } from './support/corpus.js';
import { expectRejection } from './support/harness.js';
import { telemetryEvent, UUID_A } from './support/fixtures.js';

const KNOWN_CODES = new Set(Object.values(ERROR_CODES));

test('payload 语料表自洽：id 唯一、错误码合法、样本数量不缩水', () => {
  const ids = new Set();
  for (const entry of PAYLOAD_REJECTIONS) {
    assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(KNOWN_CODES.has(entry.code), `${entry.id} uses unknown code ${entry.code}`);
    assert.ok(entry.note.length > 0, `${entry.id} needs a reason`);
  }
  assert.ok(PAYLOAD_REJECTIONS.length >= 25, 'the payload rejection corpus must not silently shrink');
});

for (const entry of PAYLOAD_REJECTIONS) {
  test(`payload 拒绝：${entry.id}（${entry.note}）`, () => {
    // 摘要用固定占位值：部分恶意 payload（NaN / 孤立代理项）连规范化都过不了，
    // 若让 fixture 现算摘要，抛错的会是 fixture 而不是被测的校验逻辑，
    // 断言就变成了"测我的测试代码"。
    const event = {
      ...telemetryEvent(),
      payload: entry.payload,
      integrity: { algorithm: 'sha256', digest: 'a'.repeat(64) },
    };
    expectRejection(() => validateTelemetryEvent(event), {
      code: entry.code,
      type: ContractError,
      label: entry.id,
    });
  });
}

test('合法 payload 通过并返回冻结的规范记录', () => {
  const event = telemetryEvent({ payload: { process_name: 'example.exe', pid: 4242, elevated: false } });
  const record = validateTelemetryEvent(event);
  assert.equal(record.schemaVersion, '1.0');
  assert.match(record.digest, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.value));
  assert.ok(Object.isFrozen(record.value.payload));
});

test('摘要被替换（内容与摘要不一致）必须拒绝', () => {
  const event = telemetryEvent();
  const tampered = { ...event, integrity: { algorithm: 'sha256', digest: 'b'.repeat(64) } };
  expectRejection(() => validateTelemetryEvent(tampered), {
    code: ERROR_CODES.ERR_INTEGRITY_DIGEST_MISMATCH,
    type: ContractError,
    pathIncludes: '$.integrity.digest',
  });
});

test('摘要算法被换成 md5 / 大写 SHA256 必须拒绝', () => {
  const event = telemetryEvent();
  for (const algorithm of ['md5', 'SHA256', 'sha512', '']) {
    expectRejection(
      () => validateTelemetryEvent({ ...event, integrity: { algorithm, digest: event.integrity.digest } }),
      { code: ERROR_CODES.ERR_FIELD_ENUM, type: ContractError },
    );
  }
});

test('信封多一个字段 / 少一个字段都必须拒绝（封闭对象）', () => {
  const event = telemetryEvent();
  expectRejection(() => validateTelemetryEvent({ ...event, extra: 1 }), {
    code: ERROR_CODES.ERR_UNKNOWN_FIELD,
    type: ContractError,
  });
  const { severity, ...withoutSeverity } = event;
  assert.equal(severity, 'medium');
  expectRejection(() => validateTelemetryEvent(withoutSeverity), {
    code: ERROR_CODES.ERR_MISSING_FIELD,
    type: ContractError,
  });
});

test('observed_at 晚于 received_at 必须拒绝（时间倒流）', () => {
  const event = telemetryEvent({
    observed_at: '2026-01-01T00:00:10Z',
    received_at: '2026-01-01T00:00:00Z',
  });
  expectRejection(() => validateTelemetryEvent(event), {
    code: ERROR_CODES.ERR_TIMESTAMP_ORDER,
    type: ContractError,
  });
});

test('时间戳不是严格 RFC3339 UTC 必须拒绝', () => {
  for (const observed_at of ['2026-01-01 00:00:00', '2026-01-01T00:00:00+08:00', '2026-13-01T00:00:00Z', 'not-a-time']) {
    expectRejection(() => validateTelemetryEvent(telemetryEvent({ observed_at })), {
      code: ERROR_CODES.ERR_TIMESTAMP_FORMAT,
      type: ContractError,
    });
  }
});

test('event_id 不是 UUIDv4 必须拒绝（含全零 UUID 与大写）', () => {
  const withLetters = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const eventId of ['00000000-0000-0000-0000-000000000000', withLetters.toUpperCase(), 'evt-1']) {
    expectRejection(() => validateTelemetryEvent(telemetryEvent({ event_id: eventId })), {
      code: ERROR_CODES.ERR_FIELD_PATTERN,
      type: ContractError,
    });
  }
});

test('event_id 被加长一字节时先撞长度上限', () => {
  expectRejection(() => validateTelemetryEvent(telemetryEvent({ event_id: `x${UUID_A}` })), {
    code: ERROR_CODES.ERR_MAX_STRING_BYTES,
    type: ContractError,
  });
});

test('payload 键 "constructor" 作为纯数据被接受，且不污染原型（与 JSON 文本解析器策略不同）', () => {
  // 文本解析器把 __proto__/constructor/prototype 列为禁用键；payload 走对象路径，
  // 键名只要匹配 ^[a-z][a-z0-9_]{0,63}$ 即可。因为规范化用 defineProperty 定义**自有**
  // 属性、且从不做深合并，这里没有原型污染面。用断言把"接受"与"安全"同时钉住。
  const payload = JSON.parse('{"constructor":"data-only"}');
  const record = validateTelemetryEvent({ ...telemetryEvent(), payload, integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) } });
  assert.equal(record.value.payload.constructor, 'data-only');
  assert.equal(Object.getPrototypeOf(record.value.payload), Object.prototype);
  assert.equal({}.dataOnly, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(record.value.payload, 'constructor'), true);
});

test('稳定来源 id 必须是受限标识符：路径与空格一律拒绝', () => {
  for (const stableSourceId of ['../../etc/passwd', 'proc win', 'proc/win']) {
    expectRejection(() => validateTelemetryEvent(telemetryEvent({ stable_source_id: stableSourceId })), {
      code: ERROR_CODES.ERR_FIELD_PATTERN,
      type: ContractError,
    });
  }
});

test('稳定来源 id 超长时先撞字节上限（错误码按实际校验顺序）', () => {
  expectRejection(() => validateTelemetryEvent(telemetryEvent({ stable_source_id: 'a'.repeat(129) })), {
    code: ERROR_CODES.ERR_MAX_STRING_BYTES,
    type: ContractError,
  });
});

test('稳定来源 id 里的控制符由文本规则先拦下（错误码按实际校验顺序）', () => {
  expectRejection(() => validateTelemetryEvent(telemetryEvent({ stable_source_id: 'proc\u0000win' })), {
    code: ERROR_CODES.ERR_STRING_CONTROL_CHARACTER,
    type: ContractError,
  });
});

test('source_generation / source_seq 不接受负数与超出安全整数的值', () => {
  expectRejection(() => validateTelemetryEvent(telemetryEvent({ source_generation: -1 })), {
    code: ERROR_CODES.ERR_INTEGER_RANGE,
    type: ContractError,
  });
  expectRejection(() => validateTelemetryEvent(telemetryEvent({ source_seq: 9007199254740992 })), {
    code: ERROR_CODES.ERR_INTEGER_RANGE,
    type: ContractError,
  });
});

test('payload 的 getter 只被读取一次，值被快照进冻结记录（无 TOCTOU）', () => {
  let calls = 0;
  const payload = {};
  Object.defineProperty(payload, 'process_name', {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      return `v${calls}`;
    },
  });
  const event = telemetryEvent();
  const target = {
    ...event,
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest({ process_name: 'v1' }) },
  };

  const record = validateTelemetryEvent(target);
  assert.equal(calls, 1, 'validation must read the property exactly once and snapshot it');
  assert.equal(record.value.payload.process_name, 'v1');
  assert.ok(Object.isFrozen(record.value.payload), 'the snapshot must be frozen, not a live view');
  assert.equal(Object.getOwnPropertyDescriptor(record.value.payload, 'process_name').get, undefined);

  // 快照之后的再次读取不再触碰调用方的对象。
  assert.equal(record.value.payload.process_name, 'v1');
  assert.equal(calls, 1);
});

test('payload 的 getter 返回不合法值时按值拒绝，而不是按"它是 getter"拒绝', () => {
  const payload = {};
  Object.defineProperty(payload, 'process_name', {
    enumerable: true,
    get() {
      return 'x\u0007y';
    },
  });
  const event = telemetryEvent();
  expectRejection(
    () => validateTelemetryEvent({ ...event, payload, integrity: { algorithm: 'sha256', digest: 'a'.repeat(64) } }),
    { code: ERROR_CODES.ERR_STRING_CONTROL_CHARACTER, type: ContractError },
  );
});

test('生产级别的 payload 大小上限：261120 字节通过、超限拒绝', () => {
  // raw_evidence 通道单字符串上限 262144，总上限同值，因此 261120 加信封仍有空间。
  const text = 'A'.repeat(261120);
  const ok = telemetryEvent({ payload: { raw_evidence: { encoding: 'utf-8', text } } });
  assert.equal(validateTelemetryEvent(ok).value.payload.raw_evidence.text.length, text.length);

  const tooBig = 'A'.repeat(LIMITS.maxRawEvidenceStringBytes + 1);
  expectRejection(
    () => validateTelemetryEvent(telemetryEvent({ payload: { raw_evidence: { encoding: 'utf-8', text: tooBig } } })),
    { code: ERROR_CODES.ERR_MAX_STRING_BYTES, type: ContractError },
  );
});

test('二进制式日志（非 UTF-8）必须走 raw_evidence，而不是塞进普通字符串', () => {
  const bytesLike = '\u00ff\u00fe\u0000binary';
  expectRejection(() => validateTelemetryEvent(telemetryEvent({ payload: { blob: bytesLike } })), {
    code: ERROR_CODES.ERR_STRING_CONTROL_CHARACTER,
    type: ContractError,
  });
});

test('parseTelemetryEvent 对重复键文本拒绝，且允许 raw_evidence 里的换行', () => {
  const duplicated = `{"schemaVersion":"1.0","schemaVersion":"1.0"}`;
  expectRejection(() => parseTelemetryEvent(duplicated), {
    code: ERROR_CODES.ERR_DUPLICATE_KEY,
    type: ContractError,
  });

  const payload = { raw_evidence: { encoding: 'utf-8', text: 'line1\nline2\tline3\rline4' } };
  const event = telemetryEvent({ payload });
  const text = JSON.stringify(event);
  const parsed = parseTelemetryEvent(text);
  assert.equal(parsed.value.payload.raw_evidence.text, payload.raw_evidence.text);
  assert.equal(parsed.digest, canonicalDigest(parsed.value));
});

test('parseTelemetryEvent 拒绝把换行放进普通 payload 字段', () => {
  const event = telemetryEvent({ payload: { cmd: 'a\nb' } });
  expectRejection(() => parseTelemetryEvent(JSON.stringify(event)), {
    code: ERROR_CODES.ERR_STRING_CONTROL_CHARACTER,
    type: ContractError,
  });
});
