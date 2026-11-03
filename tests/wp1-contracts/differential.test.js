import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  ContractError,
  negotiateSchemaVersion,
  parseAnalysisReport,
  parseAnalysisRequest,
  parseApproval,
  parseExecutionGrant,
  parseResponseProposal,
  parseStrictJson,
  parseTelemetryEvent,
  validateAnalysisReport,
  validateAnalysisRequest,
  validateApproval,
  validateExecutionGrant,
  validateResponseProposal,
  validateTelemetryEvent,
} from '../../packages/contracts/src/index.js';
import {
  expectCode,
  validAnalysisReport,
  validAnalysisRequest,
  validApproval,
  validExecutionGrant,
  validResponseProposal,
  validTelemetryEvent,
} from './helpers.js';

const CORPUS = [
  '{"a":1,"b":[true,false,null],"c":{"d":"文本"}}',
  '[1,2.5,-3e2,"x",{"k":null}]',
  '"裸字符串"',
  '{"nested":[[{"deep":1}]]}',
  '{"unicode":"\\u4e2d\\u6587"}',
  '{"empty":{},"list":[]}',
];

test('严格解析结果与 JSON.parse 逐条深度相等', () => {
  for (const text of CORPUS) {
    assert.deepStrictEqual(parseStrictJson(text), JSON.parse(text), text);
  }
});

test('六个对象的 parse 与 validate 产出一致的 value 与 digest', () => {
  const cases = [
    [parseTelemetryEvent, validateTelemetryEvent, validTelemetryEvent],
    [parseAnalysisRequest, validateAnalysisRequest, validAnalysisRequest],
    [parseAnalysisReport, validateAnalysisReport, validAnalysisReport],
    [parseResponseProposal, validateResponseProposal, validResponseProposal],
    [parseApproval, validateApproval, validApproval],
    [parseExecutionGrant, validateExecutionGrant, validExecutionGrant],
  ];
  for (const [parse, validate, build] of cases) {
    const object = build();
    const text = JSON.stringify(object);
    const direct = parse(text);
    const staged = validate(parseStrictJson(text));
    assert.deepStrictEqual(direct.value, staged.value);
    assert.equal(direct.digest, staged.digest);
    assert.equal(direct.schemaVersion, staged.schemaVersion);
    // 对象输入走 validate 也必须是同一份结果
    const fromObject = validate(object);
    assert.equal(fromObject.digest, direct.digest);
  }
});

test('不同键序、不同空白、不同转义写法的同一对象摘要一致', () => {
  const report = validAnalysisReport({ summary: '疑似中文摘要' });
  const reversed = Object.fromEntries(Object.entries(report).reverse());
  const variants = [
    JSON.stringify(report),
    JSON.stringify(reversed, null, 2),
    JSON.stringify(report).replace('疑似中文摘要', '\\u7591\\u4f3c\\u4e2d\\u6587\\u6458\\u8981'),
  ];
  const digests = variants.map((text) => parseAnalysisReport(text).digest);
  assert.equal(digests[0], digests[1]);
  assert.equal(digests[1], digests[2]);
});

test('报告与提案互不兼容，任何方向都不存在隐式转换', () => {
  const report = validateAnalysisReport(validAnalysisReport());
  const proposal = validateResponseProposal(validResponseProposal());
  // 两个 DTO 的字段集互不相交，跨类型喂入一律落到封闭性检查。
  expectCode(() => validateResponseProposal(report.value), 'ERR_UNKNOWN_FIELD', '$.summary');
  expectCode(() => validateAnalysisReport(proposal.value), 'ERR_UNKNOWN_FIELD', '$.proposal_id');
  expectCode(() => validateExecutionGrant(report.value), 'ERR_UNKNOWN_FIELD', '$.analysis_id');
  expectCode(() => validateExecutionGrant(proposal.value), 'ERR_UNKNOWN_FIELD', '$.proposal_id');
});

test('NFD 输入直接抛错，不会先规范化再返回摘要', () => {
  const report = validAnalysisReport({ summary: 'e\u0301tude' });
  let record;
  assert.throws(() => {
    record = parseAnalysisReport(JSON.stringify(report));
  }, (error) => error instanceof ContractError && error.code === 'ERR_STRING_NOT_NFC');
  assert.equal(record, undefined);
});

test('时间先后按瞬时比较而不是字符串比较', () => {
  const event = validTelemetryEvent({
    observed_at: '2026-01-01T00:00:00Z',
    received_at: '2026-01-01T00:00:00.500Z',
  });
  const record = validateTelemetryEvent(event);
  assert.equal(record.value.received_at, '2026-01-01T00:00:00.500Z');
  assert.equal(record.value.observed_at, '2026-01-01T00:00:00Z');
  // 毫秒精度不影响同一逻辑时刻的排序结论：反过来就必须拒绝。
  expectCode(
    () => validateTelemetryEvent({
      ...event,
      observed_at: '2026-01-01T00:00:00.500Z',
      received_at: '2026-01-01T00:00:00Z',
    }),
    'ERR_TIMESTAMP_ORDER',
    '$.received_at',
  );
  // 摘要对整份归一化 DTO 稳定，不随毫秒写法漂移。
  assert.equal(
    record.digest,
    validateTelemetryEvent({ ...event }).digest,
  );
});

test('版本差分三个错误码互不相同', () => {
  const ok = negotiateSchemaVersion('1.0');
  assert.equal(ok.exact, true);
  const minorError = expectCode(
    () => negotiateSchemaVersion('1.1'),
    'ERR_SCHEMA_MINOR_UNSUPPORTED',
    '$',
  );
  const majorError = expectCode(
    () => negotiateSchemaVersion('2.0'),
    'ERR_SCHEMA_MAJOR_MISMATCH',
    '$',
  );
  assert.deepStrictEqual(
    [ok.raw, minorError.code, majorError.code],
    ['1.0', 'ERR_SCHEMA_MINOR_UNSUPPORTED', 'ERR_SCHEMA_MAJOR_MISMATCH'],
  );
});

test('同一 payload 在不同键序下 integrity 摘要不变', () => {
  const payload = { pid: 1, name: 'patch.exe', flags: [true, false] };
  const reordered = { flags: [true, false], name: 'patch.exe', pid: 1 };
  assert.equal(canonicalDigest(payload), canonicalDigest(reordered));
  const record = validateTelemetryEvent(validTelemetryEvent({ payload: reordered }));
  assert.equal(record.value.integrity.digest, canonicalDigest(payload));
});
