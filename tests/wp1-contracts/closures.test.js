import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAnalysisReport,
  validateAnalysisReport,
  validateExecutionGrant,
  validateTelemetryEvent,
} from '../../packages/contracts/src/index.js';
import { normalizeScalar } from '../../packages/contracts/src/schema.js';
import { expectCode, validAnalysisReport, validExecutionGrant, validTelemetryEvent } from './helpers.js';

/*
 * 本文件钉死"封闭性不可由调用方关闭"与"必填只看自有属性"两条不变量。
 * 旧实现里 options.allowedExtraKeys 能让未知字段被静默丢弃，
 * 而 value[key] 的原型链读取能让 Object.prototype 污染把整份字段补齐。
 */

test('allowedExtraKeys 旁路已删除：validateAnalysisReport 仍拒绝未知字段', () => {
  const report = { ...validAnalysisReport(), auto_approve: true };
  const error = expectCode(
    () => validateAnalysisReport(report, { allowedExtraKeys: ['auto_approve'] }),
    'ERR_UNKNOWN_FIELD',
    '$.auto_approve',
  );
  assert.equal(error.path, '$.auto_approve');
});

test('allowedExtraKeys 旁路已删除：validateExecutionGrant 仍拒绝未知字段', () => {
  const grant = { ...validExecutionGrant(), auto_approve: true };
  const error = expectCode(
    () => validateExecutionGrant(grant, { allowedExtraKeys: ['auto_approve'] }),
    'ERR_UNKNOWN_FIELD',
    '$.auto_approve',
  );
  assert.equal(error.path, '$.auto_approve');
});

test('allowedExtraKeys 旁路已删除：parseAnalysisReport 仍拒绝未知字段', () => {
  const text = JSON.stringify({ ...validAnalysisReport(), auto_approve: true });
  const error = expectCode(
    () => parseAnalysisReport(text, { allowedExtraKeys: ['auto_approve'] }),
    'ERR_UNKNOWN_FIELD',
    '$.auto_approve',
  );
  assert.equal(error.path, '$.auto_approve');
});

test('allowedExtraKeys 选项本身被忽略而不是报错', () => {
  const record = validateAnalysisReport(validAnalysisReport(), { allowedExtraKeys: ['auto_approve'] });
  assert.equal(record.schemaVersion, '1.0');
  assert.equal(Object.prototype.hasOwnProperty.call(record.value, 'auto_approve'), false);
});

test('Object.prototype 被污染时空对象仍然按缺字段拒绝', () => {
  const keys = ['schemaVersion', 'analysis_id', 'summary', 'confidence', 'evidence_ids', 'limitations', 'model_meta'];
  try {
    for (const key of keys) {
      Object.defineProperty(Object.prototype, key, {
        value: key === 'confidence' ? 0.5 : 'polluted',
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    expectCode(() => validateAnalysisReport({}), 'ERR_MISSING_FIELD', '$.schemaVersion');
  } finally {
    for (const key of keys) delete Object.prototype[key];
  }
  assert.equal(({}).schemaVersion, undefined);
  assert.equal(({}).confidence, undefined);
});

test('顶层自有 __proto__ 键报 ERR_UNKNOWN_FIELD，payload 内报 ERR_FIELD_PATTERN', () => {
  const report = { ...validAnalysisReport() };
  Object.defineProperty(report, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  expectCode(() => validateAnalysisReport(report), 'ERR_UNKNOWN_FIELD', '$.__proto__');

  const event = validTelemetryEvent();
  const payload = { ...event.payload };
  Object.defineProperty(payload, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  expectCode(
    () => validateTelemetryEvent({ ...event, payload }),
    'ERR_FIELD_PATTERN',
    '$.payload.__proto__',
  );

  assert.equal(({}).polluted, undefined);
});

test('带 Symbol 键的合法对象报 ERR_UNKNOWN_FIELD 并给出符号描述', () => {
  const report = { ...validAnalysisReport() };
  report[Symbol('hidden_field')] = 1;
  const error = expectCode(() => validateAnalysisReport(report), 'ERR_UNKNOWN_FIELD', '$');
  assert.deepStrictEqual([...error.details.symbols], ['hidden_field']);
});

/*
 * 封闭性必须覆盖"所有自有键"，而不只是可枚举的字符串键：
 * Object.keys 看不见非枚举自有键，旧实现因此留下
 * defineProperty(obj, 'auto_approve', { enumerable: false }) 的隐形旁路。
 */

test('非枚举未知键在 AnalysisReport 顶层被拒绝', () => {
  const report = { ...validAnalysisReport() };
  Object.defineProperty(report, 'auto_approve', {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  assert.equal(Object.keys(report).includes('auto_approve'), false);
  const error = expectCode(() => validateAnalysisReport(report), 'ERR_UNKNOWN_FIELD', '$.auto_approve');
  assert.equal(error.path, '$.auto_approve');
});

test('非枚举未知键在 payload 里被拒绝', () => {
  const event = validTelemetryEvent();
  Object.defineProperty(event.payload, 'auto_approve', {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  assert.equal(Object.keys(event.payload).includes('auto_approve'), false);
  expectCode(() => validateTelemetryEvent(event), 'ERR_UNKNOWN_FIELD', '$.payload.auto_approve');
});

test('payload 带 Symbol 键被拒绝且 details.symbols 非空', () => {
  const event = validTelemetryEvent();
  event.payload[Symbol('hidden_payload')] = 1;
  const error = expectCode(() => validateTelemetryEvent(event), 'ERR_UNKNOWN_FIELD', '$.payload');
  assert.ok(Array.isArray(error.details.symbols));
  assert.ok(error.details.symbols.length > 0);
  assert.deepStrictEqual([...error.details.symbolKeys], ['Symbol(hidden_payload)']);
});

test('payload.raw_evidence 子对象的非枚举未知键同样被拒绝', () => {
  const event = validTelemetryEvent({ payload: { raw_evidence: { encoding: 'utf-8', text: 'line1\nline2' } } });
  Object.defineProperty(event.payload.raw_evidence, 'auto_approve', {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  expectCode(
    () => validateTelemetryEvent(event),
    'ERR_UNKNOWN_FIELD',
    '$.payload.raw_evidence.auto_approve',
  );
});

test('反例：全部可枚举的合法对象仍然通过（未误伤冻结对象、解析产物与克隆体）', () => {
  const report = validAnalysisReport();
  const declared = { ...report };
  Object.defineProperty(declared, 'summary', {
    value: report.summary,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const expected = validateAnalysisReport(report).digest;
  assert.equal(validateAnalysisReport(declared).digest, expected);
  assert.equal(validateAnalysisReport(JSON.parse(JSON.stringify(report))).digest, expected);
  assert.equal(validateAnalysisReport(structuredClone(report)).digest, expected);
  const frozen = validateTelemetryEvent(validTelemetryEvent());
  assert.ok(Object.isFrozen(frozen.value));
  assert.equal(validateTelemetryEvent(validTelemetryEvent()).digest, frozen.digest);
});

test('normalizeScalar 对非安全整数报 ERR_NUMBER_PRECISION_LOSS', () => {
  const error = expectCode(() => normalizeScalar(2 ** 53, '$.value'), 'ERR_NUMBER_PRECISION_LOSS', '$.value');
  assert.equal(error.code, 'ERR_NUMBER_PRECISION_LOSS');
  expectCode(() => normalizeScalar(Number.NaN, '$.value'), 'ERR_NUMBER_PRECISION_LOSS', '$.value');
  assert.equal(normalizeScalar(42, '$.value'), 42);
});
