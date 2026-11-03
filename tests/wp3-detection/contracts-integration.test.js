/**
 * contracts-integration.test.js — proves the workspace resolution of
 * `@aegisharness/contracts` from the detection test suite, and pins the shape
 * of every DTO the adapter builds.
 *
 * Imports use the bare package specifier on purpose: a relative fallback would
 * hide a broken workspace link and let the suite pass while `npm install` is
 * unable to resolve the dependency declared in package.json.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ContractError,
  validateAlert,
  validateAnalysisRequest,
  validateEvidenceRef,
  validateFinding,
} from '@aegisharness/contracts';

import {
  DEFAULT_SUMMARY_FIELDS,
  DetectionConfigError,
  buildSummaryDto,
  toAlert,
  toAnalysisRequest,
  toEvidenceRef,
  toFinding,
} from '../../packages/detection/index.js';
import { createTestEngine, makeConditionRule, makeEvent } from './helpers.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const EPOCH = '22222222-2222-4222-8222-222222222222';
const EVIDENCE_ID = 'evidence-handle-0123456789abc';
const EXPIRES_AT = '1970-01-01T01:00:00.000Z';
const ALLOWED_SUMMARY_FIELDS = Object.freeze([
  'sequence_in_hour',
  'severity_rank',
  'alert_count',
  'rule_type',
]);

/** 一次 ingest 产出的 detection / alert / analysisRequest 三元组。 */
function runOnce() {
  const engine = createTestEngine({ rules: [makeConditionRule()] });
  const result = engine.ingest([makeEvent({ eventId: EVENT_ID, observedAt: 1000 })]);
  assert.equal(result.detections.length, 1);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.analysisRequests.length, 1);
  return {
    detection: result.detections[0],
    alert: result.alerts[0],
    request: result.analysisRequests[0],
  };
}

function buildRequestDto() {
  const { request, alert } = runOnce();
  const dto = toAnalysisRequest(request, alert, {
    epoch: EPOCH,
    allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
  });
  return { request, alert, dto };
}

/** 断言抛出指定错误码的 ContractError，并返回该错误以便继续断言 path。 */
function expectContractCode(fn, code) {
  let captured;
  assert.throws(() => {
    try {
      fn();
    } catch (error) {
      captured = error;
      throw error;
    }
  }, (error) => {
    assert.ok(
      error instanceof ContractError,
      `期望 ContractError，实际 ${error?.constructor?.name}: ${error?.message}`,
    );
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}（${error.message}）`);
    return true;
  });
  return captured;
}

describe('analysis request adapter', () => {
  it('toAnalysisRequest 的返回值再次通过 validateAnalysisRequest（幂等）', () => {
    const { request, dto } = buildRequestDto();
    const again = validateAnalysisRequest(dto, { allowedSummaryFields: ALLOWED_SUMMARY_FIELDS });
    assert.equal(again.schemaVersion, '1.0');
    assert.deepEqual({ ...again.value }, { ...dto });
    assert.equal(dto.analysis_id, request.requestId);
    assert.equal(dto.alert_id, request.alertId);
    assert.equal(dto.idempotency_key, request.idempotencyKey);
    assert.equal(dto.epoch, EPOCH);
    assert.match(dto.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  it('summary_dto 是 {classification, fields}，sequenceInHour 只在 fields 内', () => {
    const { request, dto } = buildRequestDto();
    assert.deepEqual(Object.keys(dto.summary_dto), ['classification', 'fields']);
    assert.equal(dto.summary_dto.classification, 'D0');
    assert.equal(Object.prototype.hasOwnProperty.call(dto.summary_dto, 'sequenceInHour'), false);
    assert.equal(dto.summary_dto.fields.sequence_in_hour, request.sequenceInHour);
    assert.equal(dto.summary_dto.fields.alert_count, request.summaryDto.fields.alert_count);
  });

  it('allowedSummaryFields 为空时 fields 为空对象且仍通过校验', () => {
    const { request, alert } = runOnce();
    const dto = toAnalysisRequest(request, alert, { epoch: EPOCH, allowedSummaryFields: [] });
    assert.deepEqual({ ...dto.summary_dto.fields }, {});
    const again = validateAnalysisRequest(dto, { allowedSummaryFields: [] });
    assert.deepEqual({ ...again.value.summary_dto.fields }, {});
  });

  it('allowedSummaryFields 只列 sequence_in_hour 时只剩该键', () => {
    const { request, alert } = runOnce();
    const dto = toAnalysisRequest(request, alert, {
      epoch: EPOCH,
      allowedSummaryFields: ['sequence_in_hour'],
    });
    assert.deepEqual(Object.keys(dto.summary_dto.fields), ['sequence_in_hour']);
    assert.equal(dto.summary_dto.fields.sequence_in_hour, request.sequenceInHour);
  });

  it('缺 epoch 时报 DetectionConfigError', () => {
    const { request, alert } = runOnce();
    assert.throws(
      () => toAnalysisRequest(request, alert, { allowedSummaryFields: [] }),
      (error) => error instanceof DetectionConfigError
        && error.code === 'DETECTION_CONFIG_INVALID'
        && error.path === 'options.epoch',
    );
    assert.throws(
      () => toAnalysisRequest(request, alert),
      (error) => error instanceof DetectionConfigError && error.path === 'options.epoch',
    );
  });

  it('buildSummaryDto 默认返回四个键，顺序与 DEFAULT_SUMMARY_FIELDS 一致', () => {
    const { request, alert } = runOnce();
    const dto = buildSummaryDto(request, alert);
    assert.equal(dto.classification, 'D0');
    assert.deepEqual(Object.keys(dto.fields), [...DEFAULT_SUMMARY_FIELDS]);
    assert.equal(dto.fields.sequence_in_hour, request.sequenceInHour);
    assert.equal(dto.fields.severity_rank, 3);
    assert.equal(dto.fields.alert_count, alert.count);
    assert.equal(dto.fields.rule_type, 'condition');
  });

  it('buildSummaryDto 不允许调用方把 classification 提成 D1/D2', () => {
    const { request, alert } = runOnce();
    // 审查 P2-2：导出的构造器必须守住"只有 D0 可出域"，而不是把分类交给调用方。
    for (const classification of ['D1', 'D2', 'D3', 'd0', '', null]) {
      assert.throws(
        () => buildSummaryDto(request, alert, { classification }),
        (error) => error instanceof DetectionConfigError
          && error.path === 'options.classification'
          && error.detail.requested === classification,
        `classification ${JSON.stringify(classification)} 必须被拒绝`,
      );
    }
    // 显式传 D0 是允许的（与默认值等价），不改变输出。
    const dto = buildSummaryDto(request, alert, { classification: 'D0' });
    assert.equal(dto.classification, 'D0');
    assert.deepEqual(dto, buildSummaryDto(request, alert));
  });

  it('toAnalysisRequest 产出的 summary_dto 恒定 D0，即使调用方试图覆盖', () => {
    const { request, alert } = runOnce();
    // 复核 P2：旧断言根本没传 classification，恒真。这里真的传 'D1'，
    // 并按实测行为锁死：toAnalysisRequest 把它**静默忽略**（不 fail-closed），
    // DTO 仍是 D0——因为 buildSummaryDto 只收到 allowedFields，classification 不透传。
    const attempted = toAnalysisRequest(request, alert, {
      epoch: EPOCH,
      allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
      classification: 'D1',
    });
    assert.equal(attempted.summary_dto.classification, 'D0');
    assert.deepEqual(
      attempted,
      toAnalysisRequest(request, alert, { epoch: EPOCH, allowedSummaryFields: ALLOWED_SUMMARY_FIELDS }),
      'classification 必须被忽略，输出与不传时逐字段相同',
    );
    assert.equal(
      validateAnalysisRequest(attempted, { allowedSummaryFields: ALLOWED_SUMMARY_FIELDS }).value.summary_dto.classification,
      'D0',
    );
  });
});

describe('finding / alert / evidence adapters', () => {
  it('toFinding 通过 validateFinding：单次观测 count=1 且首末时间相同', () => {
    const { detection } = runOnce();
    const record = validateFinding(toFinding(detection));
    assert.equal(record.schemaVersion, '1.0');
    assert.equal(record.value.finding_id, detection.detectionId);
    assert.equal(record.value.count, 1);
    assert.equal(record.value.first_seen, record.value.last_seen);
    assert.deepEqual(record.value.event_ids, [EVENT_ID]);
    assert.equal(record.value.rule_id, detection.ruleId);
  });

  it('toAlert 通过 validateAlert：窗口有序且 event_ids 与告警一致', () => {
    const { alert } = runOnce();
    const record = validateAlert(toAlert(alert));
    assert.equal(record.value.alert_id, alert.alertId);
    assert.ok(record.value.window_start < record.value.window_end, 'window_start 必须早于 window_end');
    assert.equal(record.value.window_start, '1970-01-01T00:00:00.000Z');
    assert.equal(record.value.window_end, '1970-01-01T00:15:00.000Z');
    assert.deepEqual(record.value.event_ids, alert.eventIds);
    assert.equal(record.value.count, alert.count);
    assert.equal(record.value.event_ids_truncated, alert.eventIdsTruncated);
  });

  it('toEvidenceRef 通过 validateEvidenceRef，且同一告警两次调用摘要相同', () => {
    const { request, alert } = runOnce();
    const options = {
      evidenceId: EVIDENCE_ID,
      analysisId: request.requestId,
      expiresAt: EXPIRES_AT,
      maxBytes: 65536,
      allowedFields: ['sequence_in_hour'],
    };
    const first = toEvidenceRef(alert, options);
    const second = toEvidenceRef(alert, options);
    const record = validateEvidenceRef(first);
    assert.match(record.value.evidence_id, /^[A-Za-z0-9_-]{22,128}$/u);
    assert.equal(record.value.evidence_id, EVIDENCE_ID);
    // 构造不校验：max_bytes 原样透传，上界由 validateEvidenceRef 负责。
    assert.equal(record.value.max_bytes, options.maxBytes);
    assert.match(record.value.digest, /^[0-9a-f]{64}$/u);
    // 句柄摘要由告警内容派生：同一快照重放得到同一摘要。
    assert.equal(first.digest, second.digest);
    assert.equal(record.value.alert_id, alert.alertId);
    assert.deepEqual(record.value.allowed_fields, ['sequence_in_hour']);
  });

  it('max_bytes 传 65537（超出 maxToolResultBytes）时 validateEvidenceRef 报 ERR_INTEGER_RANGE', () => {
    const { request, alert } = runOnce();
    const dto = toEvidenceRef(alert, {
      evidenceId: EVIDENCE_ID,
      analysisId: request.requestId,
      expiresAt: EXPIRES_AT,
      maxBytes: 65537,
      allowedFields: ['sequence_in_hour'],
    });
    // toEvidenceRef 只构造不校验，因此这里必须由持有方校验才能发现越界。
    assert.equal(dto.max_bytes, 65537);
    const error = expectContractCode(() => validateEvidenceRef(dto), 'ERR_INTEGER_RANGE');
    assert.equal(error.path, '$.max_bytes');
  });

  it('toEvidenceRef 缺必填选项报 DetectionConfigError', () => {
    const { alert } = runOnce();
    assert.throws(
      () => toEvidenceRef(alert, { evidenceId: EVIDENCE_ID }),
      (error) => error instanceof DetectionConfigError && error.path === 'options.analysisId',
    );
  });
});

describe('adapter negative cases', () => {
  it('analysis_id 换成 32 位 hex 报 ERR_FIELD_PATTERN', () => {
    const { dto } = buildRequestDto();
    const error = expectContractCode(
      () => validateAnalysisRequest({ ...dto, analysis_id: 'a'.repeat(32) }, {
        allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
      }),
      'ERR_FIELD_PATTERN',
    );
    assert.equal(error.path, '$.analysis_id');
  });

  it('summary_dto 换成 { sequenceInHour } 被拒，并给出具体错误码', () => {
    const { dto } = buildRequestDto();
    const error = expectContractCode(
      () => validateAnalysisRequest({ ...dto, summary_dto: { sequenceInHour: 1 } }, {
        allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
      }),
      'ERR_UNKNOWN_FIELD',
    );
    assert.equal(error.path, '$.summary_dto.sequenceInHour');
  });

  it('idempotency_key 换成 8 位短串报 ERR_FIELD_PATTERN', () => {
    const { dto } = buildRequestDto();
    const error = expectContractCode(
      () => validateAnalysisRequest({ ...dto, idempotency_key: 'abcd1234' }, {
        allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
      }),
      'ERR_FIELD_PATTERN',
    );
    assert.equal(error.path, '$.idempotency_key');
  });

  it('toAlert 结果的 event_ids 清空后 validateAlert 报错', () => {
    const { alert } = runOnce();
    const dto = toAlert(alert);
    const error = expectContractCode(() => validateAlert({ ...dto, event_ids: [] }), 'ERR_ARRAY_EMPTY');
    assert.equal(error.path, '$.event_ids');
  });
});
