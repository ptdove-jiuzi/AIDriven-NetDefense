import { ContractError, ERROR_CODES } from '../errors.js';
import {
  osAccountId,
  policyVersion,
  rfc3339Utc,
  sha256Hex,
  timestampToEpochMs,
  uuidV4,
  opaqueToken,
} from '../fields.js';
import { LIMITS } from '../limits.js';
import { assertClosedObject, buildContractRecord } from '../schema.js';
import { parseStrictJson } from '../strict-json.js';
import { negotiateSchemaVersion } from '../version.js';

export const ROLE_NAMES = Object.freeze(['viewer', 'analyst', 'responder', 'budget-admin', 'admin']);
export const APPROVAL_STATES = Object.freeze([
  'proposed',
  'pending',
  'approved',
  'rejected',
  'expired',
  'consumed',
  'invalidated',
]);

const APPROVER_IDENTITY_SPEC = Object.freeze({
  account_id: { ...osAccountId, required: true },
  role_snapshot: {
    required: true,
    type: 'array',
    arrayOf: { required: true, type: 'string', enum: ROLE_NAMES },
    minItems: 1,
    maxItems: ROLE_NAMES.length,
    unique: true,
  },
  reauthenticated_at: { ...rfc3339Utc, required: true },
});

const APPROVAL_SPEC = Object.freeze({
  schemaVersion: {
    required: true,
    type: 'string',
    validator: (value, path) => negotiateSchemaVersion(value, { securityBoundary: true, path }),
  },
  approval_id: { ...uuidV4, required: true },
  proposal_digest: { ...sha256Hex, required: true },
  policy_version: { ...policyVersion, required: true },
  target_digest: { ...sha256Hex, required: true },
  approver_identity: { required: true, type: 'object', fields: APPROVER_IDENTITY_SPEC },
  nonce: { ...opaqueToken, required: true },
  issued_at: { ...rfc3339Utc, required: true },
  expires_at: { ...rfc3339Utc, required: true },
  epoch: { ...uuidV4, required: true },
  state: { required: true, type: 'string', enum: APPROVAL_STATES },
});

export function validateApproval(value, options = {}) {
  const normalized = assertClosedObject(value, APPROVAL_SPEC, '$', options);
  const identity = normalized.approver_identity;

  if (!identity.role_snapshot.includes('responder')) {
    throw new ContractError(
      ERROR_CODES.ERR_ROLE_NOT_PERMITTED,
      '$.approver_identity.role_snapshot',
      'Approval requires the responder role in the identity snapshot',
    );
  }

  const issuedAt = timestampToEpochMs(normalized.issued_at);
  const expiresAt = timestampToEpochMs(normalized.expires_at);
  if (expiresAt <= issuedAt) {
    throw new ContractError(
      ERROR_CODES.ERR_TIMESTAMP_ORDER,
      '$.expires_at',
      'expires_at must be strictly after issued_at',
    );
  }

  const reauthenticatedAt = timestampToEpochMs(identity.reauthenticated_at);
  if (reauthenticatedAt > issuedAt) {
    throw new ContractError(
      ERROR_CODES.ERR_TIMESTAMP_ORDER,
      '$.approver_identity.reauthenticated_at',
      'reauthenticated_at must not be after issued_at',
    );
  }
  if (issuedAt - reauthenticatedAt > LIMITS.approvalReverifyMs) {
    throw new ContractError(
      ERROR_CODES.ERR_REAUTH_TOO_STALE,
      '$.approver_identity.reauthenticated_at',
      `Reauthentication is older than ${LIMITS.approvalReverifyMs} ms`,
    );
  }

  return buildContractRecord(normalized);
}

export function parseApproval(source, options = {}) {
  const isJsonSource = typeof source === 'string' || source instanceof Uint8Array;
  const value = isJsonSource
    ? parseStrictJson(source, { maxStringBytes: options.maxStringBytes ?? LIMITS.maxStringBytes })
    : source;
  return validateApproval(value, options);
}
