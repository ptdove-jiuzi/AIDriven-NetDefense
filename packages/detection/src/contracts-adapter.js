/**
 * contracts-adapter.js — the single bridge between the detection package and
 * the closed data contracts.
 *
 * Nothing else in this package may import `@aegisharness/contracts`: keeping the
 * bridge in one file means the detection engine stays a pure, dependency free
 * calculator, and every place that can produce a contract DTO is visible in a
 * single diff.
 *
 * Time is rendered with integer arithmetic only. `Date` is banned package wide
 * because it silently depends on the host time zone and the host clock; the
 * engine must stay a pure function of `(events, clock values it was given)`.
 */

import {
  validateAlert,
  validateAnalysisRequest,
  validateFinding,
} from '@aegisharness/contracts';

import { canonicalStringify, sha256Hex } from './canonical.js';
import { DetectionConfigError } from './errors.js';
import { severityRank } from './severity.js';
import { DEFAULT_SUMMARY_FIELDS, SUMMARY_CLASSIFICATION } from './summary-contract.js';

// 常量定义在无依赖的 summary-contract.js 里，这里只做转出，保持对外表面不变；
// 这样 rate-limit.js 取用它们时不会把 contracts 拖进引擎核心的模块图。
export { DEFAULT_SUMMARY_FIELDS, SUMMARY_CLASSIFICATION };

const CONTRACT_SCHEMA_VERSION = '1.0';
const MS_PER_SECOND = 1000;
const SECONDS_PER_DAY = 86400;
const MS_PER_DAY = MS_PER_SECOND * SECONDS_PER_DAY;
const MS_PER_HOUR = 3600000;
const MS_PER_MINUTE = 60000;
/** RFC3339 的 year 字段是 4 位十进制，边界与 contracts 的 rfc3339Utc 对齐。 */
const MIN_RFC3339_YEAR = 1000;
const MAX_RFC3339_YEAR = 9999;

function pad(value, width) {
  return String(value).padStart(width, '0');
}

/**
 * Convert a day count since 1970-01-01 into a proleptic Gregorian date.
 *
 * This is Howard Hinnant's `civil_from_days` shifted by 719468 days (the epoch
 * to 0000-03-01), rearranged so every division is a floor of a non-negative
 * integer. It stays exact for the whole representable range and never consults
 * the host calendar.
 *
 * @param {number} days Days since the Unix epoch, `>= 0`.
 * @returns {[number, number, number]} `[year, month, day]` with `month` in `1..12`.
 */
function civilFromDays(days) {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return [year, month, day];
}

/**
 * Render epoch milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
 *
 * @param {number} epochMs Non-negative safe integer of epoch milliseconds.
 * @returns {string} RFC3339 UTC timestamp with millisecond precision.
 * @throws {DetectionConfigError} When `epochMs` is not a non-negative safe integer,
 *   or when it falls outside the years RFC3339 can express with a 4 digit field.
 */
export function formatRfc3339Utc(epochMs) {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new DetectionConfigError('epochMs must be a non-negative safe integer', { path: 'epochMs' });
  }
  const days = Math.floor(epochMs / MS_PER_DAY);
  const msOfDay = epochMs - days * MS_PER_DAY;
  const hour = Math.floor(msOfDay / MS_PER_HOUR);
  const minute = Math.floor((msOfDay - hour * MS_PER_HOUR) / MS_PER_MINUTE);
  const second = Math.floor((msOfDay - hour * MS_PER_HOUR - minute * MS_PER_MINUTE) / MS_PER_SECOND);
  const milli = msOfDay - hour * MS_PER_HOUR - minute * MS_PER_MINUTE - second * MS_PER_SECOND;
  const [year, month, day] = civilFromDays(days);
  // 年字段固定 4 位：超出 1000..9999 会产出 3 位或 6 位年，随后被 contracts 以
  // ERR_TIMESTAMP_FORMAT 拒收。这里提前失败，让错误落在输入侧而不是适配侧。
  if (year < MIN_RFC3339_YEAR || year > MAX_RFC3339_YEAR) {
    throw new DetectionConfigError(
      `epochMs renders the year ${year}, outside ${MIN_RFC3339_YEAR}..${MAX_RFC3339_YEAR}`,
      { path: 'epochMs', detail: { year } },
    );
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
    + `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(milli, 3)}Z`;
}

function summarySource(request, alert) {
  const record = request === null || request === undefined ? {} : request;
  const view = alert === null || alert === undefined ? {} : alert;
  const nested =
    record.summaryDto !== undefined && record.summaryDto !== null && typeof record.summaryDto.fields === 'object'
      ? record.summaryDto.fields
      : {};
  return {
    sequence_in_hour: typeof record.sequenceInHour === 'number' ? record.sequenceInHour : nested.sequence_in_hour,
    severity_rank: severityRank(view.severity === undefined ? record.severity : view.severity),
    alert_count: typeof view.count === 'number' ? view.count : nested.alert_count,
    rule_type: view.ruleType === undefined ? (nested.rule_type === undefined ? record.ruleId : nested.rule_type) : view.ruleType,
  };
}

/**
 * Build the exportable `{ classification, fields }` summary.
 *
 * `classification` is **not** caller selectable: only D0 summaries may leave the
 * detection boundary, so the exported constructor enforces the same invariant
 * the comment above states. Passing `classification: 'D0'` is accepted (it is a
 * no-op); passing anything else fails closed instead of quietly minting a D1/D2
 * summary that the rest of the pipeline would have to trust.
 *
 * `fields` keeps only the intersection of what the engine produces and what the
 * caller allows, and always in {@link DEFAULT_SUMMARY_FIELDS} order so two runs
 * serialize identically. An empty allowlist therefore yields `{}`: the caller can
 * minimise a request down to "no detail at all" without failing validation.
 *
 * @param {object} request Analysis request produced by the engine.
 * @param {object} alert Alert record or alert view the request refers to.
 * @param {{ allowedFields?: readonly string[], classification?: string }} [options] Selection options.
 * @returns {{ classification: string, fields: Record<string, unknown> }} Summary DTO.
 * @throws {DetectionConfigError} When `allowedFields` is not an array of names, or
 *   when `classification` names anything other than {@link SUMMARY_CLASSIFICATION}.
 */
export function buildSummaryDto(request, alert, options = {}) {
  // options 归一化与 toAnalysisRequest 保持一致：null/undefined 视为"没传"，
  // 其它非对象一律拒绝。否则 buildSummaryDto(req, alert, null) 会抛 TypeError，
  // 把配置错误伪装成程序错误（审查 P2-4）。
  const source = options === null || options === undefined ? {} : options;
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new DetectionConfigError('options must be an object', { path: 'options' });
  }
  const allowedFields = source.allowedFields === undefined ? DEFAULT_SUMMARY_FIELDS : source.allowedFields;
  if (!Array.isArray(allowedFields) || allowedFields.some((field) => typeof field !== 'string')) {
    throw new DetectionConfigError('allowedFields must be an array of field names', {
      path: 'options.allowedFields',
    });
  }
  if (source.classification !== undefined && source.classification !== SUMMARY_CLASSIFICATION) {
    throw new DetectionConfigError(
      `classification must be ${SUMMARY_CLASSIFICATION}; only D0 summaries may leave the detection boundary`,
      { path: 'options.classification', detail: { requested: source.classification } },
    );
  }
  const classification = SUMMARY_CLASSIFICATION;
  const produced = summarySource(request, alert);
  const fields = {};
  for (const name of DEFAULT_SUMMARY_FIELDS) {
    if (!allowedFields.includes(name)) {
      continue;
    }
    if (produced[name] === undefined) {
      continue;
    }
    fields[name] = produced[name];
  }
  return { classification, fields };
}

function requireOptions(options, keys) {
  const source = options === null || options === undefined ? {} : options;
  for (const key of keys) {
    if (source[key] === undefined) {
      throw new DetectionConfigError(`options.${key} is required`, { path: `options.${key}` });
    }
  }
  return source;
}

/**
 * Build and validate an AnalysisRequest DTO.
 *
 * @param {object} request Analysis request produced by the engine.
 * @param {object} alert Alert record or alert view the request refers to.
 * @param {{ epoch: string, allowedSummaryFields?: readonly string[], budgetClass?: string }} options Epoch is required.
 * @returns {object} Normalized AnalysisRequest value.
 * @throws {DetectionConfigError} When `epoch` is missing.
 */
export function toAnalysisRequest(request, alert, options = {}) {
  const source = options === null || options === undefined ? {} : options;
  if (source.epoch === undefined) {
    throw new DetectionConfigError('epoch is required', { path: 'options.epoch' });
  }
  const allowedSummaryFields = source.allowedSummaryFields === undefined ? [] : source.allowedSummaryFields;
  const dto = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    analysis_id: request.requestId,
    alert_id: request.alertId,
    budget_class: source.budgetClass === undefined ? request.budgetClass : source.budgetClass,
    summary_dto: buildSummaryDto(request, alert, { allowedFields: allowedSummaryFields }),
    created_at: formatRfc3339Utc(request.createdAt),
    idempotency_key: request.idempotencyKey,
    epoch: source.epoch,
  };
  return validateAnalysisRequest(dto, { allowedSummaryFields }).value;
}

/**
 * Build and validate a Finding DTO from one engine detection.
 *
 * A single detection covers exactly one observation, hence `count: 1` and the
 * same instant for `first_seen` and `last_seen`.
 *
 * @param {object} detection Detection produced by the engine.
 * @param {{ status?: string, evidenceRefs?: readonly string[] }} [options] Status and evidence handles.
 * @returns {object} Normalized Finding value.
 */
export function toFinding(detection, options = {}) {
  const source = options === null || options === undefined ? {} : options;
  const seen = formatRfc3339Utc(detection.observedAt);
  const dto = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    finding_id: detection.detectionId,
    rule_id: detection.ruleId,
    rule_version: detection.ruleVersion,
    event_ids: [...detection.eventIds],
    fingerprint: detection.fingerprint,
    severity: detection.severity,
    status: source.status === undefined ? 'new' : source.status,
    first_seen: seen,
    last_seen: seen,
    count: 1,
    evidence_refs: source.evidenceRefs === undefined ? [] : [...source.evidenceRefs],
  };
  return validateFinding(dto).value;
}

/**
 * Build and validate an Alert DTO from an engine alert view.
 *
 * @param {object} alertView View returned by `alertView()` / the engine result.
 * @param {{ status?: string, evidenceRefs?: readonly string[] }} [options] Status and evidence handles.
 * @returns {object} Normalized Alert value.
 */
export function toAlert(alertView, options = {}) {
  const source = options === null || options === undefined ? {} : options;
  const dto = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    alert_id: alertView.alertId,
    rule_id: alertView.ruleId,
    rule_version: alertView.ruleVersion,
    fingerprint: alertView.fingerprint,
    severity: alertView.severity,
    status: source.status === undefined ? alertView.status : source.status,
    first_seen: formatRfc3339Utc(alertView.firstSeen),
    last_seen: formatRfc3339Utc(alertView.lastSeen),
    window_start: formatRfc3339Utc(alertView.windowStart),
    window_end: formatRfc3339Utc(alertView.windowEnd),
    count: alertView.count,
    event_ids: [...alertView.eventIds],
    event_ids_truncated: alertView.eventIdsTruncated,
    evidence_refs: source.evidenceRefs === undefined ? [] : [...source.evidenceRefs],
  };
  return validateAlert(dto).value;
}

/**
 * Build an EvidenceRef DTO. Validation is deliberately left to the caller: the
 * handle is issued together with the payload whose digest it carries, and the
 * broker that owns that payload is the only party able to check the whole thing
 * with `validateEvidenceRef`. Building it here only fixes the shape.
 *
 * @param {object} alertView Alert view the evidence belongs to.
 * @param {{
 *   evidenceId: string,
 *   analysisId: string,
 *   expiresAt: string,
 *   maxBytes: number,
 *   allowedFields: readonly string[]
 * }} options All fields are required.
 * @returns {object} Plain EvidenceRef DTO, ready for `validateEvidenceRef`.
 * @throws {DetectionConfigError} When a required option is missing.
 */
export function toEvidenceRef(alertView, options) {
  const source = requireOptions(options, ['evidenceId', 'analysisId', 'expiresAt', 'maxBytes', 'allowedFields']);
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    evidence_id: source.evidenceId,
    analysis_id: source.analysisId,
    alert_id: alertView.alertId,
    allowed_fields: [...source.allowedFields],
    expires_at: source.expiresAt,
    max_bytes: source.maxBytes,
    // 句柄摘要绑定的是"发出句柄时的告警快照"：同一告警换一份证据不会得到同一句柄，
    // 而同一份内容重放会得到同一摘要，持有方可以据此核对句柄没有指向别处。
    digest: sha256Hex(canonicalStringify(alertView)),
  };
}

// 本桥是包内唯一允许 import @aegisharness/contracts 的文件，三个校验器都在这里
// 显式登记，用于 to* 的自校验。EvidenceRef 是例外：toEvidenceRef 只构造不校验，
// 校验留给持有证据的 broker 调用 validateEvidenceRef（见该函数的注释），
// 因此本文件不 import 它——未使用的导入只会让"必须校验"这件事看起来已经做到。
