import assert from 'node:assert/strict';
import test from 'node:test';

import {
  negotiateSchemaVersion,
  parseSchemaVersion,
  parseSchemaVersion as parseVersion,
  SUPPORTED_SCHEMA_VERSIONS,
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

test("'1.0' 被接受且 exact 为 true", () => {
  const parsed = parseSchemaVersion('1.0');
  assert.deepStrictEqual({ ...parsed }, { raw: '1.0', major: 1, minor: 0 });
  const negotiated = negotiateSchemaVersion('1.0');
  assert.equal(negotiated.exact, true);
  assert.ok(Object.isFrozen(negotiated));
  assert.ok(Object.isFrozen(parsed));
});

test('受支持版本清单是冻结的且只含 1.0', () => {
  assert.ok(Object.isFrozen(SUPPORTED_SCHEMA_VERSIONS));
  assert.deepStrictEqual([...SUPPORTED_SCHEMA_VERSIONS], ['1.0']);
});

test('格式非法的版本号全部拒绝', () => {
  const invalid = ['1', '1.0.0', 'v1.0', '01.0', '1.00', '', ' 1.0', '1.0 ', '1.-1', null, 1.0];
  for (const value of invalid) {
    expectCode(() => parseVersion(value), 'ERR_SCHEMA_VERSION_INVALID', '$');
  }
});

test("major 不同的 '2.0' 被拒绝", () => {
  expectCode(() => negotiateSchemaVersion('2.0'), 'ERR_SCHEMA_MAJOR_MISMATCH', '$');
});

test("安全边界下 '1.1' 被拒绝", () => {
  expectCode(() => negotiateSchemaVersion('1.1'), 'ERR_SCHEMA_MINOR_UNSUPPORTED', '$');
  expectCode(
    () => negotiateSchemaVersion('1.1', { securityBoundary: true }),
    'ERR_SCHEMA_MINOR_UNSUPPORTED',
    '$',
  );
});

test("非安全边界下 '1.1' 被接受且 exact 为 false", () => {
  const negotiated = negotiateSchemaVersion('1.1', { securityBoundary: false });
  assert.equal(negotiated.exact, false);
  assert.equal(negotiated.major, 1);
  assert.equal(negotiated.minor, 1);
});

test('对象缺少 schemaVersion 报 ERR_MISSING_FIELD 且 path 精确', () => {
  const event = validTelemetryEvent();
  delete event.schemaVersion;
  expectCode(() => validateTelemetryEvent(event), 'ERR_MISSING_FIELD', '$.schemaVersion');
});

test('版本错误的六个对象全部被拒绝', () => {
  const cases = [
    [validateTelemetryEvent, validTelemetryEvent],
    [validateAnalysisRequest, validAnalysisRequest],
    [validateAnalysisReport, validAnalysisReport],
    [validateResponseProposal, validResponseProposal],
    [validateApproval, validApproval],
    [validateExecutionGrant, validExecutionGrant],
  ];
  for (const [validate, build] of cases) {
    expectCode(() => validate({ ...build(), schemaVersion: '2.0' }), 'ERR_SCHEMA_MAJOR_MISMATCH', '$.schemaVersion');
    expectCode(() => validate({ ...build(), schemaVersion: '1.1' }), 'ERR_SCHEMA_MINOR_UNSUPPORTED', '$.schemaVersion');
  }
});

test('非安全边界协商不会把 1.0 标记为非精确', () => {
  const negotiated = negotiateSchemaVersion('1.0', { securityBoundary: false });
  assert.equal(negotiated.exact, true);
});
