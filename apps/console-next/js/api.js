/**
 * AIDriven NetDefense · WebUI v2 · HTTP API 客户端
 * B2 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.3（导出形状）/ §2.1（错误包络）
 *
 * 红线（合同 §1.1）：
 * - 浏览器不持有任何凭据：本文件**不发** Authorization、**不发** x-aegis-csrf 头、
 *   **不读** CSRF 派生字段或任何 cookie；Bearer 与 CSRF 由 console host（B3）注入。
 * - 唯一额外头发送的是 host 层写保护标记 `x-console-v2: 1`（B3 serve.mjs 要求，
 *   挡跨站表单 POST；非凭据、无秘密、值固定）。
 * - 只请求同源：`/api/v1/*`、`/healthz`、`/readyz`（静态资源由浏览器加载，不在此列）。
 * - 错误统一成 `ApiError{code, message, details, retryAfter}`；`message` 走 i18n
 *   `errors.<CODE>`，缺 key → `errors.UNKNOWN` + 原始 code（不静默、不丢码）。
 * - `/api/v1/status` 的响应体历史上带 CSRF 派生字段：本客户端在返回前**剔除**它，
 *   保证它不会流进 store/DOM/localStorage。
 */

import { i18n } from './i18n.js';
import { openSsePost } from './sse.js';
import { isPlainObject, toQueryString } from './util.js';

/** API 基址（同源相对路径；console host 负责代理到 daemon）。 */
export const API_BASE = '/api/v1';

/**
 * 写请求的 console 标记头（B3 的 `serve.mjs` 要求 POST/PUT/DELETE 带 `x-console-v2: 1`，
 * 用来挡住跨站表单的简单 POST；它不是凭据、不是 CSRF token，值固定为 '1'）。
 * 合同 §2.1 未列此头，属于 B2↔B3 的 host 层协议，已在状态文件与回报里点名。
 */
export const CONSOLE_MARKER_HEADER = 'x-console-v2';
export const CONSOLE_MARKER_VALUE = '1';

/** 公开健康检查路径（合同 §7.3 允许的出站集合）。 */
export const HEALTH_PATH = '/healthz';
export const READY_PATH = '/readyz';

/** HTTP 状态 → 兜底错误码（响应不是 JSON 包络时使用）。 */
const CODE_BY_STATUS = Object.freeze({
  400: 'QUERY_INVALID',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'BODY_TOO_LARGE',
  415: 'CONTENT_TYPE_REJECTED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
  501: 'NOT_IMPLEMENTED',
  502: 'UPSTREAM_FAILED',
  503: 'INTERNAL',
  504: 'UPSTREAM_TIMEOUT',
});

/** 传输层错误码（非服务端包络）。 */
export const TRANSPORT_CODES = Object.freeze(['NETWORK', 'ABORTED', 'BAD_RESPONSE', 'HTTP_ERROR', 'SSE_MALFORMED']);

/**
 * 控制台 API 错误。
 *
 * @property {string} code
 * @property {string} message 已本地化的人话（errors.<CODE>）
 * @property {object|null} details
 * @property {number|null} retryAfter 秒（429 的 retry-after）
 * @property {number|null} status HTTP 状态（传输层错误为 null）
 * @property {string|null} action 上游建议动作（§2.4 枚举）
 * @property {boolean} retryable
 */
export class ApiError extends Error {
  constructor(code, message, details = null, extra = {}) {
    super(String(message ?? ''));
    this.name = 'ApiError';
    this.code = typeof code === 'string' && code !== '' ? code : 'unknown';
    this.details = isPlainObject(details) ? details : null;
    this.retryAfter = Number.isFinite(Number(extra.retryAfter)) ? Number(extra.retryAfter) : null;
    this.status = Number.isFinite(Number(extra.status)) ? Number(extra.status) : null;
    this.action = typeof extra.action === 'string' ? extra.action : null;
    this.retryable = extra.retryable === true || this.retryAfter !== null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      retryAfter: this.retryAfter,
      status: this.status,
      action: this.action,
      retryable: this.retryable,
    };
  }
}

/** @param {unknown} value @returns {boolean} */
export function isApiError(value) {
  return value instanceof ApiError;
}

/**
 * 错误码 → 本地化消息（合同 §7.3）。
 * 缺失 errors.<CODE> 时退回 errors.UNKNOWN，并把原始 code 附在括号里（不隐藏）。
 *
 * @param {string} code
 * @param {string} [serverMessage] 服务端英文稳定句（仅在 i18n 全缺时兜底）
 * @returns {string}
 */
export function messageForCode(code, serverMessage = '') {
  const safeCode = typeof code === 'string' && code !== '' ? code : 'unknown';
  const key = `errors.${safeCode}`;
  if (i18n.has(key)) {
    const text = i18n.t(key);
    if (typeof text === 'string' && text !== '' && !text.startsWith('[missing:')) return text;
  }
  // 回落键：合同 §8.3 v1.2 的合法写法是 errors.unknown；errors.UNKNOWN 是 §7.3 的过渡别名。
  let unknown = serverMessage || 'Something went wrong.';
  for (const fallbackKey of ['errors.unknown', 'errors.UNKNOWN']) {
    if (!i18n.has(fallbackKey)) continue;
    const text = i18n.t(fallbackKey);
    if (typeof text === 'string' && text !== '' && !text.startsWith('[missing:')) {
      unknown = text;
      break;
    }
  }
  return safeCode === 'unknown' ? unknown : `${unknown} (${safeCode})`;
}

/**
 * 把 `{error:{code,message,details}}` 包络 / HTTP 状态映射成 ApiError。
 *
 * @param {{status?:number|null, payload?:*, retryAfter?:number|null}} input
 * @returns {ApiError}
 */
export function toApiError(input = {}) {
  const status = Number.isFinite(Number(input.status)) ? Number(input.status) : null;
  const payload = input.payload;
  const envelope =
    isPlainObject(payload) && isPlainObject(payload.error)
      ? payload.error
      : isPlainObject(payload) && typeof payload.code === 'string'
        ? payload
        : null;
  let code = envelope && typeof envelope.code === 'string' && envelope.code !== '' ? envelope.code : null;
  if (code === null) {
    code = status !== null && CODE_BY_STATUS[status] ? CODE_BY_STATUS[status] : status !== null && status >= 500 ? 'INTERNAL' : 'HTTP_ERROR';
  }
  const serverMessage = envelope && typeof envelope.message === 'string' ? envelope.message : '';
  const details = envelope && isPlainObject(envelope.details) ? envelope.details : null;
  return new ApiError(code, messageForCode(code, serverMessage), details, {
    retryAfter: input.retryAfter,
    status,
    action: envelope && typeof envelope.action === 'string' ? envelope.action : null,
    retryable: envelope && envelope.retryable === true,
  });
}

/** 顶层剔除令牌类字段（仅 status 用；不递归，避免误伤 settings.schema 的 action id）。 */
function stripTopLevelTokenFields(payload) {
  if (!isPlainObject(payload)) return payload;
  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/^(?:csrf(?:[_-]?token)?|xsrf|access[_-]?token|refresh[_-]?token|authorization)$/iu.test(key)) continue;
    if (/^x-aegis-csrf$/iu.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * 创建 API 客户端。
 *
 * @param {{basePath?:string, fetchImpl?:Function|null}} [options]
 */
export function createApi(options = {}) {
  const opts = options == null ? {} : options;
  const basePath = typeof opts.basePath === 'string' && opts.basePath !== '' ? opts.basePath.replace(/\/+$/u, '') : API_BASE;
  const injectedFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null;

  function resolveFetch() {
    if (injectedFetch) return injectedFetch;
    return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  }

  function buildUrl(path, query) {
    const suffix = toQueryString(query);
    return suffix === '' ? path : `${path}?${suffix}`;
  }

  /**
   * 普通 JSON 请求。
   *
   * @param {string} path 以 `/` 开头的路径
   * @param {{method?:string, query?:object|null, body?:*, signal?:AbortSignal, base?:string}} [requestOptions]
   * @returns {Promise<*>}
   */
  async function request(path, requestOptions = {}) {
    const method = String(requestOptions.method ?? 'GET').toUpperCase();
    const base = requestOptions.base === undefined ? basePath : requestOptions.base;
    const url = buildUrl(`${base}${path}`, requestOptions.query);
    const headers = { accept: 'application/json' };
    if (method !== 'GET') headers[CONSOLE_MARKER_HEADER] = CONSOLE_MARKER_VALUE;
    const init = {
      method,
      headers,
      credentials: 'same-origin',
      signal: requestOptions.signal ?? undefined,
    };
    if (requestOptions.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(requestOptions.body);
    }
    const fetchFn = resolveFetch();
    if (!fetchFn) throw new ApiError('NETWORK', messageForCode('NETWORK'), { reason: 'fetch unavailable' });
    let response;
    try {
      response = await fetchFn(url, init);
    } catch (error) {
      if (error && error.name === 'AbortError') throw new ApiError('ABORTED', messageForCode('ABORTED'));
      throw new ApiError('NETWORK', messageForCode('NETWORK'), { reason: 'network' });
    }
    return handleResponse(response);
  }

  async function handleResponse(response) {
    if (!response) throw new ApiError('NETWORK', messageForCode('NETWORK'), { reason: 'empty response' });
    const status = Number.isFinite(response.status) ? Number(response.status) : null;
    let retryAfter = null;
    try {
      const header = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('retry-after')
        : null;
      const parsed = Number(header);
      if (Number.isFinite(parsed)) retryAfter = parsed;
    } catch {
      retryAfter = null;
    }
    if (status === 204) return null;
    let payload = null;
    let parseFailed = false;
    if (typeof response.json === 'function') {
      try {
        payload = await response.json();
      } catch {
        parseFailed = true;
      }
    } else {
      parseFailed = true;
    }
    if (response.ok === false || (status !== null && status >= 400)) {
      throw toApiError({ status, payload, retryAfter });
    }
    if (parseFailed) throw new ApiError('BAD_RESPONSE', messageForCode('BAD_RESPONSE'), { status });
    return payload;
  }

  /**
   * SSE 流 + ApiError 映射（§7.4）。返回 {abort, done}，done 永不 reject。
   */
  function openStream(path, body, handlers = {}) {
    const safeHandlers = isPlainObject(handlers) ? handlers : {};
    const stream = openSsePost(path === '' ? basePath : `${basePath}${path}`, body ?? {}, {
      fetchImpl: resolveFetch(),
      headers: { [CONSOLE_MARKER_HEADER]: CONSOLE_MARKER_VALUE },
      onEvent: safeHandlers.onEvent,
      onOpen: safeHandlers.onOpen,
      signal: safeHandlers.signal,
    });
    const done = stream.done.then((result) => {
      const mapped = { ...result };
      if (result.terminal === 'error') {
        if (result.httpError) {
          mapped.error = toApiError({
            status: result.httpError.status,
            payload: {
              error: {
                code: result.httpError.code,
                message: result.httpError.message,
                details: result.httpError.details,
              },
            },
            retryAfter: result.httpError.retryAfter,
          });
        } else if (isPlainObject(result.error)) {
          mapped.error = new ApiError(result.error.code, messageForCode(result.error.code, result.error.message), result.error.details, {
            action: result.error.action,
            retryable: result.error.retryable,
            status: 200,
          });
        } else {
          mapped.error = new ApiError('unknown', messageForCode('unknown'));
        }
      }
      if (mapped.error && typeof safeHandlers.onError === 'function') {
        try {
          safeHandlers.onError(mapped.error);
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) console.error('[api] onError handler failed', error);
        }
      }
      if (typeof safeHandlers.onDone === 'function') {
        try {
          safeHandlers.onDone(mapped);
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) console.error('[api] onDone handler failed', error);
        }
      }
      return mapped;
    });
    return {
      abort: () => stream.abort(),
      done,
      stream,
      get terminal() {
        return stream.terminal;
      },
    };
  }

  return {
    /** GET /api/v1/status（剔除顶层令牌字段）。 */
    getStatus: () => request('/status').then(stripTopLevelTokenFields),
    /** GET /api/v1/alerts?limit=&cursor= */
    listAlerts: (params = {}) =>
      request('/alerts', { query: { limit: params.limit, cursor: params.cursor } }),
    /** GET /api/v1/analysis?limit=&cursor= */
    listAnalyses: (params = {}) =>
      request('/analysis', { query: { limit: params.limit, cursor: params.cursor } }),
    /** GET /api/v1/models */
    getModels: () => request('/models'),
    /** POST /api/v1/models/:providerId/test（零出站前置由服务端判定）。 */
    testProvider: (providerId) =>
      request(`/models/${encodeURIComponent(String(providerId))}/test`, { method: 'POST', body: {} }),
    /** PUT /api/v1/credentials/:providerId（204，无 body；密钥只在请求体内，不落任何本地存储）。 */
    putCredential: (providerId, apiKey) =>
      request(`/credentials/${encodeURIComponent(String(providerId))}`, {
        method: 'PUT',
        body: { apiKey },
      }),
    /** DELETE /api/v1/credentials/:providerId（204，幂等）。 */
    deleteCredential: (providerId) =>
      request(`/credentials/${encodeURIComponent(String(providerId))}`, { method: 'DELETE' }),
    /** GET /api/v1/settings */
    getSettings: () => request('/settings'),
    /**
     * PUT /api/v1/settings {settings, dryRun, discardCredential?}
     * `discardCredential`（合同 §2.8）：删除仍持密钥的 provider 时必须显式带 true，
     * 否则服务端 409 SETTINGS_LOCKED（UI 会如实报错且永远重试不成功）。
     */
    putSettings: (settings, putOptions = {}) =>
      request('/settings', {
        method: 'PUT',
        body: {
          settings,
          dryRun: putOptions.dryRun === true,
          ...(putOptions.discardCredential === true ? { discardCredential: true } : {}),
        },
      }),
    /** GET /api/v1/settings/schema（设置页唯一渲染来源）。 */
    getSettingsSchema: () => request('/settings/schema'),
    /** POST /api/v1/agent/chat（SSE）→ {abort(), done} */
    openChat: (body, handlers = {}) => openStream('/agent/chat', body, handlers),
    /** POST /api/v1/alerts/:id/explain（SSE）→ {abort(), done} */
    explainAlert: (alertId, body, handlers = {}) =>
      openStream(`/alerts/${encodeURIComponent(String(alertId))}/explain`, body ?? {}, handlers),
    /** POST /api/v1/agent/approval（0.0.1 只登记不执行）。 */
    approveTool: (payload = {}) =>
      request('/agent/approval', {
        method: 'POST',
        body: {
          sessionId: payload.sessionId,
          callId: payload.callId,
          decision: payload.decision,
        },
      }),
    /**
     * GET /healthz（加法：合同 §7.3 的出站白名单包含它，conn-pill 需要读健康态）。
     * 响应 {status:'healthy'|'degraded'|'failed', version}。
     */
    getHealth: () => request(HEALTH_PATH, { base: '' }),
    /** GET /readyz（加法，同上）。 */
    getReady: () => request(READY_PATH, { base: '' }),
  };
}

/** 应用单例（index.html 的 app.js 使用）。 */
export const api = createApi();
