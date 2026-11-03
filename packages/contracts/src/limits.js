/** 全局硬上限。所有校验器都必须从这里取数，不得就地写魔数。 */
export const LIMITS = Object.freeze({
  maxDepth: 6,
  maxObjectKeys: 128,
  maxArrayItems: 256,
  maxStringBytes: 16384,
  maxRawEvidenceStringBytes: 262144,
  maxMessageBytes: 1048576,
  maxEventBytes: 262144,
  maxPayloadBytes: 16384,
  maxReportBytes: 65536,
  maxRequestIds: 3,
  maxSafeInteger: Number.MAX_SAFE_INTEGER,
  approvalReverifyMs: 300000,
  maxEvidenceFields: 64,
  maxToolResultBytes: 65536,
  maxInputUpperTokens: 1000000,
  maxOutputLimitTokens: 2000,
});
