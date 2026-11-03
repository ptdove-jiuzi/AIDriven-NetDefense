/**
 * @aegisharness/contracts —— 封闭、带版本的数据合同公共出口。
 *
 * 本包刻意只暴露「解析 / 校验 / 规范化 / 协商 / 绑定核对」这类纯函数：
 * 不存在任何把展示对象升级为执行授权的隐式转换入口。
 */

import { canonicalDigest, canonicalSize, canonicalize } from './canonical.js';
import { ContractError, ERROR_CODES } from './errors.js';
import { LIMITS } from './limits.js';
import { parseStrictJson } from './strict-json.js';
import { parseSchemaVersion, negotiateSchemaVersion, SUPPORTED_SCHEMA_VERSIONS } from './version.js';

import { parseTelemetryEvent, validateTelemetryEvent, SEVERITY_LEVELS } from './objects/telemetry-event.js';
import {
  parseAnalysisRequest,
  validateAnalysisRequest,
  DATA_CLASSIFICATIONS,
} from './objects/analysis-request.js';
import { parseAnalysisReport, validateAnalysisReport } from './objects/analysis-report.js';
import {
  parseResponseProposal,
  validateResponseProposal,
  RISK_LEVELS,
  TARGET_KINDS,
} from './objects/response-proposal.js';
import { parseApproval, validateApproval, APPROVAL_STATES, ROLE_NAMES } from './objects/approval.js';
import { parseExecutionGrant, validateExecutionGrant } from './objects/execution-grant.js';
import { parseFinding, validateFinding } from './objects/finding.js';
import { parseAlert, validateAlert, ALERT_STATUSES } from './objects/alert.js';
import { parseEvidenceRef, validateEvidenceRef } from './objects/evidence-ref.js';
import { parseModelRequest, validateModelRequest, MODEL_REQUEST_STATES } from './objects/model-request.js';
import {
  parseAuditEvent,
  validateAuditEvent,
  verifyAuditChain,
  AUDIT_ACTOR_TYPES,
} from './objects/audit-event.js';
import {
  verifyGrantApprovalBinding,
  verifyProposalApprovalBinding,
} from './objects/binding.js';

export {
  ContractError,
  ERROR_CODES,
  LIMITS,
  SUPPORTED_SCHEMA_VERSIONS,
  parseSchemaVersion,
  negotiateSchemaVersion,
  parseStrictJson,
  canonicalize,
  canonicalDigest,
  canonicalSize,
  parseTelemetryEvent,
  validateTelemetryEvent,
  parseAnalysisRequest,
  validateAnalysisRequest,
  parseAnalysisReport,
  validateAnalysisReport,
  parseResponseProposal,
  validateResponseProposal,
  parseApproval,
  validateApproval,
  parseExecutionGrant,
  validateExecutionGrant,
  parseFinding,
  validateFinding,
  parseAlert,
  validateAlert,
  parseEvidenceRef,
  validateEvidenceRef,
  parseModelRequest,
  validateModelRequest,
  parseAuditEvent,
  validateAuditEvent,
  verifyAuditChain,
  verifyProposalApprovalBinding,
  verifyGrantApprovalBinding,
  SEVERITY_LEVELS,
  RISK_LEVELS,
  APPROVAL_STATES,
  ROLE_NAMES,
  DATA_CLASSIFICATIONS,
  TARGET_KINDS,
  ALERT_STATUSES,
  AUDIT_ACTOR_TYPES,
  MODEL_REQUEST_STATES,
};

export const contracts = Object.freeze({
  ContractError,
  ERROR_CODES,
  LIMITS,
  SUPPORTED_SCHEMA_VERSIONS,
  parseSchemaVersion,
  negotiateSchemaVersion,
  parseStrictJson,
  canonicalize,
  canonicalDigest,
  canonicalSize,
  parseTelemetryEvent,
  validateTelemetryEvent,
  parseAnalysisRequest,
  validateAnalysisRequest,
  parseAnalysisReport,
  validateAnalysisReport,
  parseResponseProposal,
  validateResponseProposal,
  parseApproval,
  validateApproval,
  parseExecutionGrant,
  validateExecutionGrant,
  parseFinding,
  validateFinding,
  parseAlert,
  validateAlert,
  parseEvidenceRef,
  validateEvidenceRef,
  parseModelRequest,
  validateModelRequest,
  parseAuditEvent,
  validateAuditEvent,
  verifyAuditChain,
  verifyProposalApprovalBinding,
  verifyGrantApprovalBinding,
  SEVERITY_LEVELS,
  RISK_LEVELS,
  APPROVAL_STATES,
  ROLE_NAMES,
  DATA_CLASSIFICATIONS,
  TARGET_KINDS,
  ALERT_STATUSES,
  AUDIT_ACTOR_TYPES,
  MODEL_REQUEST_STATES,
});

export default contracts;
