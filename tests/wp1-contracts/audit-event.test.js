import assert from 'node:assert/strict';
import test from 'node:test';

import * as auditEventModule from '../../packages/contracts/src/objects/audit-event.js';
import {
  canonicalDigest,
  AUDIT_ACTOR_TYPES,
  parseAuditEvent,
  validateAuditEvent,
  verifyAuditChain,
} from '../../packages/contracts/src/index.js';
import {
  expectCode,
  HEX_B,
  HEX_C,
  HEX_D,
  HEX_ZERO,
  SIGNATURE,
  validAuditEvent,
} from './helpers.js';

/** 另一组合法 base64：44 字符、全为 base64 字符、长度为 4 的倍数。 */
const HMAC_OTHER = 'B'.repeat(44);

/** 生成长度为 `count`、序号从 1 起连续、摘要首尾相接的链。 */
function chainOf(sequences) {
  const records = [];
  let previousDigest = HEX_ZERO;
  for (const sequence of sequences) {
    const record = validateAuditEvent(validAuditEvent({ sequence, previous_digest: previousDigest }));
    records.push(record);
    previousDigest = record.digest;
  }
  return records;
}

/** 替换记录里的某个 value 字段，得到一条新的（摘要已不同步的）链条目。 */
function withValue(record, patch) {
  return { ...record, value: { ...record.value, ...patch } };
}

/** 改 value 并重算 digest，得到一条"自洽但被重写"的链条目（无密钥时无法发现）。 */
function reseal(record, patch) {
  const value = { ...record.value, ...patch };
  return { ...record, digest: canonicalDigest(value), value };
}

test('AuditEvent 合法样例通过：schemaVersion、64 位摘要与深冻结', () => {
  const record = validateAuditEvent(validAuditEvent());
  assert.equal(record.schemaVersion, '1.0');
  assert.match(record.digest, /^[0-9a-f]{64}$/u);
  assert.equal(record.value.sequence, 1);
  assert.equal(record.value.actor.type, 'daemon');
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.value));
  assert.ok(Object.isFrozen(record.value.actor));
});

test('创世记录用 64 个 0 作为 previous_digest，null 不被接受', () => {
  const record = validateAuditEvent(validAuditEvent({ previous_digest: HEX_ZERO }));
  assert.equal(record.value.previous_digest, HEX_ZERO);
  const error = expectCode(
    () => validateAuditEvent(validAuditEvent({ previous_digest: null })),
    'ERR_NULL_NOT_ALLOWED',
    '$.previous_digest',
  );
  assert.equal(error.path, '$.previous_digest');
});

test('合法链：sequence 1..3 且前驱摘要接得上，链校验返回 ok/length', () => {
  const records = chainOf([1, 2, 3]);
  assert.equal(records[1].value.previous_digest, records[0].digest);
  assert.equal(records[2].value.previous_digest, records[1].digest);
  const result = verifyAuditChain(records);
  assert.deepEqual(result, { ok: true, length: 3 });
  assert.ok(Object.isFrozen(result));
});

test('断链：前驱摘要对不上报 ERR_AUDIT_CHAIN_BROKEN 并指向 previous_digest', () => {
  const records = chainOf([1, 2, 3]);
  // 用 validateAuditEvent 造一条"自身摘要自洽、但指向错误前驱"的记录：
  // 这样失败点只能是链接，而不是摘要自洽性。
  const brokenLink = validateAuditEvent(validAuditEvent({ sequence: 2, previous_digest: HEX_C }));
  const broken = [records[0], brokenLink, records[2]];
  const error = expectCode(() => verifyAuditChain(broken), 'ERR_AUDIT_CHAIN_BROKEN', '$.records[1]');
  assert.equal(error.path, '$.records[1].previous_digest');
  assert.equal(error.details.expected, records[0].digest);
  assert.equal(error.details.actual, HEX_C);
});

test('跳号：sequence 1,2,5 报 ERR_AUDIT_CHAIN_BROKEN 并给出 expected/actual', () => {
  const records = chainOf([1, 2, 5]);
  const error = expectCode(() => verifyAuditChain(records), 'ERR_AUDIT_CHAIN_BROKEN', '$.records[2]');
  assert.equal(error.path, '$.records[2].sequence');
  assert.equal(error.details.expected, 3);
  assert.equal(error.details.actual, 5);
});

test('篡改已校验记录的 digest 字段（不动 value）被自洽性检查拒绝，path 指向该记录的 digest', () => {
  const records = chainOf([1, 2]);
  assert.notEqual(records[0].digest, HEX_D);
  const tampered = { ...records[0], digest: HEX_D };
  const error = expectCode(
    () => verifyAuditChain([tampered, records[1]]),
    'ERR_AUDIT_CHAIN_BROKEN',
    '$.records[0].digest',
  );
  assert.equal(error.path, '$.records[0].digest');
  assert.equal(error.details.expected, records[0].digest);
  assert.equal(error.details.actual, HEX_D);
});

test('AuditEvent 多一个键报 ERR_UNKNOWN_FIELD 并指向该键', () => {
  const error = expectCode(
    () => validateAuditEvent({ ...validAuditEvent(), signature: SIGNATURE }),
    'ERR_UNKNOWN_FIELD',
    '$.signature',
  );
  assert.equal(error.path, '$.signature');
});

test('只改 value.hmac 而不重算 digest：被自洽性检查拒绝', () => {
  const records = chainOf([1, 2]);
  assert.equal(records[0].value.hmac, SIGNATURE);
  const tamperedFirst = withValue(records[0], { hmac: HMAC_OTHER });
  // 换过的 hmac 仍是合法 base64，字段级校验也放行——它只是形状约束。
  assert.equal(validateAuditEvent({ ...tamperedFirst.value }).value.hmac, HMAC_OTHER);
  // 但 digest 仍覆盖旧 value，重算后对不上，链校验必须拒绝。
  const error = expectCode(
    () => verifyAuditChain([tamperedFirst, records[1]]),
    'ERR_AUDIT_CHAIN_BROKEN',
    '$.records[0].digest',
  );
  assert.equal(error.path, '$.records[0].digest');
  assert.equal(error.details.expected, canonicalDigest(tamperedFirst.value));
  assert.equal(error.details.actual, records[0].digest);
});

test('改 value.hmac 并用 canonicalDigest 重算整条链后仍然通过（本包不做 HMAC 验签）', () => {
  const records = chainOf([1, 2]);
  const forgedFirst = reseal(records[0], { hmac: HMAC_OTHER });
  const forgedSecond = reseal(records[1], { hmac: HMAC_OTHER, previous_digest: forgedFirst.digest });
  // 签名被换掉、内容被重封，但结构完全自洽——无密钥则无法发现。
  // 这条断言钉死「ok:true 不是审计未被重写的证明」，避免后来者误以为验签已覆盖。
  assert.deepEqual(verifyAuditChain([forgedFirst, forgedSecond]), { ok: true, length: 2 });
  assert.deepEqual(verifyAuditChain([forgedFirst]), { ok: true, length: 1 });
});

test('手搓记录：digest 与 value 不自洽时被拒', () => {
  const handMade = {
    digest: 'f'.repeat(64),
    value: { sequence: 1, previous_digest: HEX_ZERO },
  };
  const error = expectCode(() => verifyAuditChain([handMade]), 'ERR_AUDIT_CHAIN_BROKEN', '$.records[0].digest');
  assert.equal(error.path, '$.records[0].digest');
  assert.equal(error.details.expected, canonicalDigest(handMade.value));
  assert.equal(error.details.actual, 'f'.repeat(64));
});

test('sequence 为 1 但 previous_digest 非全 0：违反创世约定被拒', () => {
  const record = validateAuditEvent(validAuditEvent({ sequence: 1, previous_digest: HEX_B }));
  const error = expectCode(
    () => verifyAuditChain([record]),
    'ERR_AUDIT_CHAIN_BROKEN',
    '$.records[0].previous_digest',
  );
  assert.equal(error.path, '$.records[0].previous_digest');
  assert.equal(error.details.expected, HEX_ZERO);
  assert.equal(error.details.actual, HEX_B);
});

test('起始 sequence 为 5 且 previous_digest 非全 0：不受创世约定约束，通过', () => {
  const record = validateAuditEvent(validAuditEvent({ sequence: 5, previous_digest: HEX_B }));
  assert.deepEqual(verifyAuditChain([record]), { ok: true, length: 1 });
});

test('不可伪造边界：audit-event 模块不导出任何签发/补链/重算入口', () => {
  const exported = Object.keys(auditEventModule);
  assert.deepEqual(
    [...exported].sort(),
    ['AUDIT_ACTOR_TYPES', 'parseAuditEvent', 'validateAuditEvent', 'verifyAuditChain'],
  );
  for (const forbidden of [
    'signAuditEvent',
    'computeHmac',
    'appendAuditEvent',
    'sealAuditEvent',
    'rebuildChain',
    'repairChain',
  ]) {
    assert.equal(exported.includes(forbidden), false, `不应导出签发类入口 ${forbidden}`);
  }
});

test('AuditEvent 缺 sequence 报 ERR_MISSING_FIELD', () => {
  const value = validAuditEvent();
  delete value.sequence;
  expectCode(() => validateAuditEvent(value), 'ERR_MISSING_FIELD', '$.sequence');
});

test('AuditEvent sequence 为 0 报 ERR_INTEGER_RANGE', () => {
  expectCode(() => validateAuditEvent(validAuditEvent({ sequence: 0 })), 'ERR_INTEGER_RANGE', '$.sequence');
});

test('AuditEvent actor.type 不在枚举内报 ERR_FIELD_ENUM', () => {
  const error = expectCode(
    () => validateAuditEvent(validAuditEvent({ actor: { type: 'intruder', id: 'SYSTEM' } })),
    'ERR_FIELD_ENUM',
    '$.actor.type',
  );
  assert.equal(error.path, '$.actor.type');
  assert.ok(!AUDIT_ACTOR_TYPES.includes('intruder'));
});

test('AuditEvent action 大小写不符（Alert.Created）报 ERR_FIELD_PATTERN', () => {
  expectCode(() => validateAuditEvent(validAuditEvent({ action: 'Alert.Created' })), 'ERR_FIELD_PATTERN', '$.action');
});

test('AuditEvent object_digest 不是 64 位小写 hex 报 ERR_FIELD_PATTERN', () => {
  expectCode(
    () => validateAuditEvent(validAuditEvent({ object_digest: 'A'.repeat(64) })),
    'ERR_FIELD_PATTERN',
    '$.object_digest',
  );
  expectCode(
    () => validateAuditEvent(validAuditEvent({ object_digest: HEX_B.slice(0, 63) })),
    'ERR_FIELD_PATTERN',
    '$.object_digest',
  );
});

test('AuditEvent 空原型对象报 ERR_INPUT_NOT_OBJECT', () => {
  const value = Object.assign(Object.create(null), validAuditEvent());
  const error = expectCode(() => validateAuditEvent(value), 'ERR_INPUT_NOT_OBJECT', '$');
  assert.equal(error.path, '$');
});

test('AuditEvent 非枚举自有键报 ERR_UNKNOWN_FIELD', () => {
  const value = validAuditEvent();
  Object.defineProperty(value, 'x', { value: 1, enumerable: false, configurable: true, writable: true });
  const error = expectCode(() => validateAuditEvent(value), 'ERR_UNKNOWN_FIELD', '$.x');
  assert.equal(error.path, '$.x');
});

test('verifyAuditChain 只接受数组：非数组报 ERR_INPUT_NOT_OBJECT，空链返回 length 0', () => {
  expectCode(() => verifyAuditChain('not-an-array'), 'ERR_INPUT_NOT_OBJECT', '$');
  expectCode(() => verifyAuditChain([{}]), 'ERR_INPUT_NOT_OBJECT', '$.records[0]');
  assert.deepEqual(verifyAuditChain([]), { ok: true, length: 0 });
});

test('parseAuditEvent 接受 JSON 文本与已解析对象，产出相同 digest', () => {
  const object = validAuditEvent({ sequence: 7, previous_digest: HEX_D });
  const fromText = parseAuditEvent(JSON.stringify(object));
  const fromObject = parseAuditEvent(object);
  assert.equal(fromText.digest, fromObject.digest);
  assert.equal(fromText.value.sequence, 7);
  assert.equal(fromText.value.previous_digest, HEX_D);
});

test('parseAuditEvent 拒绝非法 JSON', () => {
  expectCode(() => parseAuditEvent('not json'), 'ERR_JSON_SYNTAX', '$');
});
