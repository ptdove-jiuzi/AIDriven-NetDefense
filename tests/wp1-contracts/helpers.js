import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { canonicalDigest, ContractError } from '../../packages/contracts/src/index.js';

export const UUID_A = '11111111-1111-4111-8111-111111111111';
export const UUID_B = '22222222-2222-4222-8222-222222222222';
export const UUID_C = '33333333-3333-4333-8333-333333333333';
export const UUID_D = '44444444-4444-4444-8444-444444444444';
export const UUID_E = '55555555-5555-4555-8555-555555555555';
export const UUID_F = '66666666-6666-4666-8666-666666666666';
export const UUID_G = '77777777-7777-4777-8777-777777777777';
export const UUID_H = '88888888-8888-4888-8888-888888888888';

export const HEX_A = 'a'.repeat(64);
export const HEX_B = 'b'.repeat(64);
export const HEX_C = 'c'.repeat(64);
export const HEX_D = 'd'.repeat(64);
export const HEX_ZERO = '0'.repeat(64);

export const BOOT_ID_HEX = '0123456789abcdef0123456789abcdef';
export const SIGNATURE = 'A'.repeat(44);
export const OPAQUE_EVIDENCE_ID = 'evidence-object-id-0123456789';

/** 生成一个 64 位小写 hex 摘要。 */
export function fixedDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 断言调用抛出指定错误码，并可选校验 path 片段。
 * 返回捕获到的错误对象，便于继续断言 details。
 */
export function expectCode(fn, code, pathContains) {
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
    assert.equal(code, error.code, `期望错误码 ${code}，实际 ${error.code}（${error.message}）`);
    if (pathContains !== undefined) {
      assert.equal(typeof error.path, 'string', 'error.path 必须是字符串');
      assert.ok(
        error.path.includes(pathContains),
        `期望 path 含 "${pathContains}"，实际 "${error.path}"`,
      );
    }
    return true;
  });
  return captured;
}

export function validTelemetryEvent(overrides = {}) {
  const payload = overrides.payload ?? { process_name: 'patch.exe', pid: 4242, elevated: false };
  return {
    schemaVersion: '1.0',
    event_id: UUID_A,
    stable_source_id: 'proc.win',
    collector_instance_id: UUID_B,
    source_generation: 3,
    boot_id: BOOT_ID_HEX,
    source_seq: 17,
    observed_at: '2026-01-01T00:00:00Z',
    received_at: '2026-01-01T00:00:00.500Z',
    type: 'process.created',
    severity: 'medium',
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
    ...overrides,
  };
}

export function validAnalysisRequest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    analysis_id: UUID_A,
    alert_id: UUID_B,
    budget_class: 'standard',
    summary_dto: { classification: 'D0', fields: {} },
    created_at: '2026-01-01T00:00:05Z',
    idempotency_key: 'idempotency-key-0123456789abcdef',
    epoch: UUID_C,
    ...overrides,
  };
}

export function validAnalysisReport(overrides = {}) {
  return {
    schemaVersion: '1.0',
    analysis_id: UUID_A,
    summary: '疑似可疑进程链，需要人工复核',
    confidence: 0.42,
    evidence_ids: [UUID_A, UUID_B],
    limitations: ['仅基于单次快照', '未读取文件内容'],
    model_meta: {
      provider_id: 'provider.local',
      model_id: 'model.small.v1',
      request_ids: [UUID_C],
    },
    ...overrides,
  };
}

export function validResponseProposal(overrides = {}) {
  return {
    schemaVersion: '1.0',
    proposal_id: UUID_A,
    analysis_id: UUID_B,
    action_id: 'process.suspend',
    normalized_target: {
      target_kind: 'process',
      digest: HEX_C,
      object_id: 'object-id-0123456789abcdef',
    },
    justification_evidence: [UUID_C, UUID_D],
    risk: 'high',
    expires_at: '2026-01-01T00:10:00Z',
    ...overrides,
  };
}

export function validApproval(overrides = {}) {
  return {
    schemaVersion: '1.0',
    approval_id: UUID_D,
    proposal_digest: HEX_A,
    policy_version: '2026.1',
    target_digest: HEX_B,
    approver_identity: {
      account_id: 'DOMAIN\\analyst',
      role_snapshot: ['analyst', 'responder'],
      reauthenticated_at: '2026-01-01T00:00:00Z',
    },
    nonce: 'approval-nonce-0123456789abcdef',
    issued_at: '2026-01-01T00:00:10Z',
    expires_at: '2026-01-01T00:05:00Z',
    epoch: UUID_E,
    state: 'approved',
    ...overrides,
  };
}

export function validExecutionGrant(overrides = {}) {
  return {
    schemaVersion: '1.0',
    execution_id: UUID_F,
    approval_id: UUID_D,
    action_id: 'process.suspend',
    action_digest: HEX_A,
    parameters_digest: HEX_D,
    target_digest: HEX_B,
    nonce: 'grant-nonce-0123456789abcdefgh',
    not_before: '2026-01-01T00:00:20Z',
    expires_at: '2026-01-01T00:04:00Z',
    epoch: UUID_E,
    signature: SIGNATURE,
    ...overrides,
  };
}

export function validFinding(overrides = {}) {
  return {
    schemaVersion: '1.0',
    finding_id: UUID_A,
    rule_id: 'proc.example-start',
    rule_version: '1.0.0',
    event_ids: [UUID_B],
    fingerprint: HEX_A,
    severity: 'high',
    status: 'new',
    first_seen: '2026-01-01T00:00:03Z',
    last_seen: '2026-01-01T00:10:00Z',
    count: 3,
    evidence_refs: [OPAQUE_EVIDENCE_ID],
    ...overrides,
  };
}

export function validAlert(overrides = {}) {
  return {
    schemaVersion: '1.0',
    alert_id: UUID_B,
    rule_id: 'proc.example-start',
    rule_version: '1.0.0',
    fingerprint: HEX_A,
    severity: 'high',
    status: 'new',
    first_seen: '2026-01-01T00:00:03Z',
    last_seen: '2026-01-01T00:10:00Z',
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2026-01-01T00:15:00Z',
    count: 2,
    event_ids: [UUID_C],
    event_ids_truncated: false,
    evidence_refs: [],
    ...overrides,
  };
}

export function validEvidenceRef(overrides = {}) {
  return {
    schemaVersion: '1.0',
    evidence_id: OPAQUE_EVIDENCE_ID,
    analysis_id: UUID_A,
    alert_id: UUID_B,
    allowed_fields: ['sequence_in_hour', 'severity_rank'],
    expires_at: '2026-01-01T00:15:00Z',
    max_bytes: 65536,
    digest: HEX_B,
    ...overrides,
  };
}

export function validModelRequest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    request_id: UUID_C,
    analysis_id: UUID_A,
    request_seq: 1,
    serialized_digest: HEX_A,
    input_upper: 4096,
    output_limit: 512,
    reserved_at: '2026-01-01T00:00:00Z',
    state: 'reserved',
    ...overrides,
  };
}

export function validAuditEvent(overrides = {}) {
  return {
    schemaVersion: '1.0',
    sequence: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    actor: { type: 'daemon', id: 'SYSTEM' },
    action: 'alert.created',
    object_digest: HEX_A,
    previous_digest: HEX_ZERO,
    payload_digest: HEX_B,
    hmac: SIGNATURE,
    ...overrides,
  };
}
