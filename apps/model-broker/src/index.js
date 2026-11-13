/**
 * `@aegisharness/model-broker` 公共出口。
 *
 * 只导出控制面所需的东西。刻意不导出内部状态对象，也不导出任何能构造
 * "跳过预扣"路径的入口。`finalizeOutbound` 是"最终报文 + 摘要"的唯一来源，
 * 不要在别处再拼一份 body/digest。
 */

export { BROKER_CODES, BrokerError, asBrokerError, isBrokerError } from './errors.js';
export { BROKER_LIMITS, CIRCUIT_POLICY, resolveLimits } from './policy.js';
export {
  ALLOWED_CLASSIFICATIONS,
  ALLOWED_FIELDS,
  ALLOWED_ROLES,
  D0_FIELDS,
  D1_FIELDS,
  buildOutboundPayload,
  estimateInputUpper,
  finalizeOutbound,
  redactValue,
  scanSecrets,
} from './redaction.js';
export {
  CREDENTIAL_ENV_NAME,
  CREDENTIAL_FILE_ENV_NAME,
  ProviderCredential,
  loadProviderCredential,
} from './credentials.js';
export {
  ENDPOINT_KINDS,
  MAX_REGISTERED_ENDPOINTS,
  assertEndpointActive,
  assertEndpointUnchanged,
  createEndpointRegistry,
  defaultEndpointRegistry,
  getRegisteredEndpoint,
  isEndpointActive,
  isLiteralLoopback,
  isLoopbackHost,
  isResolvedEndpoint,
  listRegisteredEndpoints,
  registerEndpoint,
  replaceEndpoint,
  resetEndpointRegistry,
  resolveFixedEndpoint,
  unregisterEndpoint,
} from './endpoint.js';
export { createHttpTransport, normalizeUsage, ProviderTransportError, TRANSPORT_FAILURES } from './transport.js';
export { BUDGET_PORT_OPERATIONS, assertBudgetPort, readPreview } from './budget-port.js';
export {
  PROVIDER_BUDGET_OPERATIONS,
  assertProviderBudgetPort,
  createProviderBudgetLedger,
} from './endpoint-budget.js';
export {
  ESCALATION_WINDOW_MS,
  assertEscalationLedger,
  createEscalationLedger,
} from './escalation-ledger.js';
export { createEventStoreBudgetPort } from './adapters/event-store-budget.js';
export { RequestQueue } from './queue.js';
export { createModelBroker } from './broker.js';
export { isUuid, sha256Hex, uuid } from './util.js';
