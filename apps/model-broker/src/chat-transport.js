/**
 * Chat 流式传输层（console v2 · broker 子进程专用）。
 *
 * 只做四件事，每件都"少做一点"：
 * 1. 只往**一个已冻结的**端点 POST：`<baseUrl>/chat/completions`，`stream:true`；
 * 2. SSE 增量解析（`data:` 行、空行派发、`[DONE]` 收尾），逐块产出 delta，
 *    不把整段响应读进内存；
 * 3. 硬上限：连接+响应头 8s、单流总时长 120s、响应头 64KiB、流 8MiB；
 *    `redirect: 'manual'`——3xx 拿到状态码就失败，**绝不跟随**；
 * 4. 把失败归类成稳定错误码 `UPSTREAM_FAILED | UPSTREAM_TIMEOUT | UPSTREAM_REDIRECT`，
 *    错误消息里**不含密钥、不含 prompt 原文、不含上游响应正文**。
 *
 * 代理：Node 内置 `fetch`（undici）**默认不读** `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`，
 * 本模块也不传 `dispatcher`/`agent`，因此"忽略代理"是默认行为而不是配置项。
 * 这里显式写明并加注释，是因为"哪天有人给 fetch 加了个 dispatcher"就会静默把内网
 * 请求塞进代理——ADR-0010 §2.2 明确要求保持"无代理"。
 *
 * 端点活性：每次发送前后都复查 brand 仍属于当前注册记录（ADR-0010 §3.1 阴性用例 1），
 * 注销/替换后旧 brand 立即失败；URL 组成部分不存在"请求期覆盖"的入口。
 *
 * 依赖仅限 broker 包内部（`endpoint.js` / `errors.js`），不引入任何第三方包。
 *
 * @author PT-dove
 */

import { BrokerError } from './errors.js';
import { assertEndpointActive, assertEndpointUnchanged } from './endpoint.js';

/** 稳定的上游错误码（CONSOLE-V2-CONTRACT §2.1 / §3.2）。 */
export const CHAT_TRANSPORT_CODES = Object.freeze({
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_REDIRECT: 'UPSTREAM_REDIRECT',
});

/**
 * 传输上限。值是合同常量（§5），不是配置项：运行期没有任何"临时放宽"入口。
 * 测试可以显式传入更小的 limits 来缩短用例时长，生产路径只传默认值。
 */
export const CHAT_TRANSPORT_LIMITS = Object.freeze({
  /** 连接 + 响应头（TTFB）上限：8s。 */
  headerTimeoutMs: 8000,
  /** 单流总时长上限：120s。 */
  totalTimeoutMs: 120000,
  /** 响应头字节上限：64KiB。 */
  maxHeaderBytes: 64 * 1024,
  /** 流正文上限：8MiB。 */
  maxStreamBytes: 8 * 1024 * 1024,
  /** provider/test 的响应体上限：256KiB（合同 §2.4）。 */
  maxProbeBytes: 256 * 1024,
  /** provider/test 的连接+总时长上限：8s（合同 §2.4）。 */
  probeTimeoutMs: 8000,
  /** 请求体上限：消息在 host 侧已按字符数校验，这里再兜一层字节上限。 */
  maxBodyBytes: 128 * 1024,
  /** 单次输出 token 硬上限（host 再按 model.maxOutputTokens 收紧）。 */
  maxOutputTokens: 8192,
});

/** 传输层错误：`code` 是稳定码，`kind` 是内部归因（不跨进程承诺）。 */
export class ChatTransportError extends Error {
  /**
   * @param {string} code `CHAT_TRANSPORT_CODES` 之一。
   * @param {string} message 稳定英文短句（不含密钥/prompt/上游正文）。
   * @param {object} [details] 枚举/计数元数据。
   */
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'ChatTransportError';
    this.code = code;
    this.details = Object.freeze({ ...(details ?? {}) });
    if (Error.captureStackTrace) Error.captureStackTrace(this, ChatTransportError);
  }
}

function transportError(code, message, details) {
  return new ChatTransportError(code, message, details);
}

function isAbortLike(error) {
  if (!error) return false;
  const name = typeof error.name === 'string' ? error.name : '';
  return name === 'AbortError' || name === 'TimeoutError' || error.code === 'ABORT_ERR';
}

function timeoutError(stage, limitMs) {
  const message = stage === 'headers'
    ? `provider did not answer in ${limitMs}ms`
    : `provider did not finish within ${limitMs}ms`;
  return transportError(CHAT_TRANSPORT_CODES.UPSTREAM_TIMEOUT, message, {
    stage: stage === 'headers' ? 'HEADERS' : 'TOTAL',
    timeout_ms: limitMs,
  });
}

function abortedError() {
  return transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'request was aborted by the caller', {
    reason: 'ABORTED',
  });
}

/** 只接受"像枚举"的上游错误类型，避免把上游原文（可能含 prompt）带进 details。 */
function safeUpstreamReason(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/u.test(value) ? value : null;
}

function effectiveLimits(override) {
  if (override === undefined || override === null) return CHAT_TRANSPORT_LIMITS;
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new TypeError('chat transport limits override must be an object');
  }
  const merged = { ...CHAT_TRANSPORT_LIMITS };
  for (const key of Object.keys(override)) {
    if (!Object.hasOwn(CHAT_TRANSPORT_LIMITS, key)) {
      throw new TypeError(`unknown chat transport limit ${key}`);
    }
    const value = override[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`chat transport limit ${key} must be a positive integer`);
    }
    // 只允许收紧（测试缩短超时），不允许放宽合同常量。
    merged[key] = Math.min(value, CHAT_TRANSPORT_LIMITS[key]);
  }
  return Object.freeze(merged);
}

/** 估算响应头序列化后的字节数（undici 自身还有一个更小的硬上限，这里只做上界判定）。 */
function estimateHeaderBytes(response) {
  const headers = response?.headers;
  if (headers === null || headers === undefined || typeof headers[Symbol.iterator] !== 'function') return 0;
  let total = 0;
  for (const [key, value] of headers) {
    total += Buffer.byteLength(String(key), 'utf8') + Buffer.byteLength(String(value), 'utf8') + 4;
  }
  return total;
}

/** 读取有上限的响应体；超限主动 cancel，避免把 8MiB+ 读进内存。 */
async function readCapped(response, limitBytes) {
  if (response.body === null || response.body === undefined) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) {
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider response exceeds the byte limit', {
        reason: 'OVERSIZE',
        limit_bytes: limitBytes,
      });
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider response exceeds the byte limit', {
          reason: 'OVERSIZE',
          limit_bytes: limitBytes,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已经读到 done 时 cancel 也会 reject；不影响结论。
    }
  }
  return Buffer.concat(chunks);
}

/**
 * usage 归一化：接受 OpenAI 的 `prompt_tokens/completion_tokens` 与
 * Anthropic 风格的 `input_tokens/output_tokens`；缺字段或非法值一律 null
 * （合同要求"取不到给 null"，不得编造 0）。
 *
 * @returns {{promptTokens: number, completionTokens: number, totalTokens: number} | null}
 */
export function normalizeChatUsage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const prompt = raw.prompt_tokens ?? raw.input_tokens;
  const completion = raw.completion_tokens ?? raw.output_tokens;
  if (!Number.isSafeInteger(prompt) || prompt < 0) return null;
  if (!Number.isSafeInteger(completion) || completion < 0) return null;
  const declaredTotal = raw.total_tokens;
  const total = Number.isSafeInteger(declaredTotal) && declaredTotal >= 0 ? declaredTotal : prompt + completion;
  return Object.freeze({ promptTokens: prompt, completionTokens: completion, totalTokens: total });
}

/** 允许的 finishReason（合同 §3.2）；不认识的值按 `stop` 处理，不原样回显。 */
const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'cancelled']);
function normalizeFinishReason(value) {
  return typeof value === 'string' && FINISH_REASONS.has(value) ? value : 'stop';
}

/**
 * 增量 SSE 解析器：逐行喂入，空行派发一个事件。
 *
 * 只理解 `event:` / `data:` 两种字段（`id:`/`retry:` 忽略），注释行（`:` 开头）忽略；
 * `data:` 多行用 `\n` 拼接（SSE 规范）。产出 `{ event, data }`，由上层 JSON.parse。
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {object} limits
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
async function* decodeSse(body, limits) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let total = 0;
  let eventName = 'message';
  const dataLines = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limits.maxStreamBytes) {
        throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider response exceeds the stream limit', {
          reason: 'OVERSIZE',
          limit_bytes: limits.maxStreamBytes,
        });
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (dataLines.length > 0) {
            yield { event: eventName, data: dataLines.join('\n') };
          }
          eventName = 'message';
          dataLines.length = 0;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
        if (field === 'data') dataLines.push(fieldValue);
        else if (field === 'event') eventName = fieldValue;
      }
    }
    // 流结束时没有空行收尾：把剩余 data 行派发出去（有些 provider 不发尾部空行）。
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join('\n') };
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已结束/已取消都正常。
    }
  }
}

/** 把流里的一条 `data:` 负载解释成事件；失败一律 malformed（不回显负载）。 */
function parseStreamPayload(payload, state) {
  if (payload === '[DONE]') {
    state.sawDone = true;
    return null;
  }
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider sent a malformed stream frame', {
      reason: 'MALFORMED',
    });
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider sent a malformed stream frame', {
      reason: 'MALFORMED',
    });
  }
  if (json.error !== undefined && json.error !== null) {
    // 上游错误体可能带 prompt 片段，只取枚举型字段。
    throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider reported an error on the stream', {
      reason: 'UPSTREAM_ERROR',
      upstream_type: safeUpstreamReason(json.error?.type ?? json.error?.code),
    });
  }
  const usage = normalizeChatUsage(json.usage);
  if (usage !== null) state.usage = usage;
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  if (choice !== null && typeof choice === 'object') {
    const deltaText = choice.delta?.content;
    const messageText = choice.message?.content;
    let text = null;
    if (typeof deltaText === 'string') text = deltaText;
    else if (typeof messageText === 'string') text = messageText;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      state.finishReason = normalizeFinishReason(choice.finish_reason);
    }
    if (text !== null && text !== '') return { type: 'delta', text };
  }
  return null;
}

/**
 * 建一个 chat 传输实例。
 *
 * @param {{
 *   endpoint: object,           // endpoint.js 注册表签发的 brand（含 requestUrl）
 *   credential?: {header(): string} | null,
 *   fetchImpl?: Function,
 *   limits?: object,
 * }} options
 */
export function createChatTransport(options) {
  const { endpoint, credential = null } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const limits = effectiveLimits(options.limits);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('chat transport requires a fetch implementation');
  }

  return Object.freeze({
    endpoint,
    limits,

    /**
     * 发起一次流式 chat 请求。
     *
     * 产出事件：`{type:'delta', text}` → 可选 `{type:'usage', ...}` → `{type:'done', finishReason, totalTokens}`。
     * 失败抛 `ChatTransportError`（code ∈ UPSTREAM_*）。
     *
     * @param {{
     *   model: string,
     *   messages: Array<{role: string, content: string}>,
     *   maxTokens: number,
     *   temperature?: number,
     *   signal?: AbortSignal,
     * }} input
     */
    async *stream(input) {
      // 发送前复查：注册被注销/替换后旧 brand 立即失效。
      try {
        assertEndpointActive(endpoint);
      } catch {
        throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT, 'provider endpoint check failed', {
          reason: 'ENDPOINT_REJECTED',
        });
      }

      const maxTokens = input.maxTokens;
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > limits.maxOutputTokens) {
        throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'requested output tokens are out of range', {
          reason: 'INVALID_MAX_TOKENS',
        });
      }
      const body = JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
        // 拿得到 usage 就拿；拿不到上层显示 null（不编造 0）。
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
      });
      if (Buffer.byteLength(body, 'utf8') > limits.maxBodyBytes) {
        throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'request body exceeds the byte limit', {
          reason: 'BODY_OVERSIZE',
          limit_bytes: limits.maxBodyBytes,
        });
      }

      const controller = new AbortController();
      let externalAborted = false;
      let timedOutStage = null;
      const onExternalAbort = () => {
        externalAborted = true;
        controller.abort();
      };
      const externalSignal = input.signal;
      if (externalSignal !== undefined && externalSignal !== null) {
        if (externalSignal.aborted) throw abortedError();
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }

      // 头超时 ≈ 连接 + TTFB 上限；总超时是整条流的墙钟上限。
      const headerTimer = setTimeout(() => {
        timedOutStage = 'headers';
        controller.abort();
      }, limits.headerTimeoutMs);
      const totalTimer = setTimeout(() => {
        timedOutStage = 'total';
        controller.abort();
      }, limits.totalTimeoutMs);

      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'cache-control': 'no-store',
        ...(credential === null || credential === undefined ? {} : { authorization: credential.header() }),
      };

      try {
        let response;
        try {
          // `redirect:'manual'`：3xx 在这里是一个可归因的状态码，不是"再发一次"的信号。
          // 没有 dispatcher/agent：Node fetch 默认不读 HTTP(S)_PROXY（见文件头注释）。
          response = await fetchImpl(endpoint.requestUrl ?? endpoint.url, {
            method: 'POST',
            headers,
            body,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (error) {
          if (timedOutStage !== null) throw timeoutError(timedOutStage, timedOutStage === 'headers' ? limits.headerTimeoutMs : limits.totalTimeoutMs);
          if (externalAborted) throw abortedError();
          if (isAbortLike(error)) throw abortedError();
          // 不把底层 message 带出去：它可能包含 URL。
          throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider request failed', {
            reason: 'NETWORK',
            cause_code: typeof error?.cause?.code === 'string'
              ? error.cause.code
              : (typeof error?.code === 'string' ? error.code : null),
          });
        } finally {
          clearTimeout(headerTimer);
        }

        const status = Number(response.status);
        if (status >= 300 && status <= 399) {
          // 读完即弃（有上限），既释放连接也不把 Location 当成下一步。
          try {
            await readCapped(response, 4096);
          } catch {
            // 错误分支读失败不影响"收到 3xx"这个结论。
          }
          throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT, 'provider answered with a redirect that was not followed', {
            status,
          });
        }
        if (!(status >= 200 && status <= 299)) {
          try {
            await readCapped(response, 4096);
          } catch {
            // 同上。
          }
          throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider returned a non-success status', {
            status,
          });
        }

        try {
          assertEndpointUnchanged(endpoint, response.url ?? endpoint.requestUrl);
        } catch {
          // 注入的 fetch 实现若跟随了跳转，这里会看到"离开冻结端点"。
          throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT, 'provider answered from an unexpected endpoint', {
            reason: 'ENDPOINT_ESCAPE',
          });
        }

        const headerBytes = estimateHeaderBytes(response);
        if (headerBytes > limits.maxHeaderBytes) {
          throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider response headers exceed the limit', {
            reason: 'HEADERS_OVERSIZE',
            limit_bytes: limits.maxHeaderBytes,
          });
        }

        const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
        const state = { usage: null, finishReason: 'stop', sawDone: false };

        if (!contentType.includes('text/event-stream')) {
          // provider 忽略了 stream:true 直接给整包 JSON：按"一次性响应"兜底解析，
          // 但仍然是同样的字节上限与端点校验，不放宽任何一条。
          const buffer = await readCapped(response, limits.maxStreamBytes);
          let json;
          try {
            json = JSON.parse(buffer.toString('utf8'));
          } catch {
            throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider response is not valid JSON', {
              reason: 'MALFORMED',
            });
          }
          parseStreamPayload(JSON.stringify(json), state);
          const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
          const text = choice?.message?.content ?? choice?.delta?.content;
          if (typeof text === 'string' && text !== '') yield { type: 'delta', text };
          if (state.usage !== null) yield { type: 'usage', usage: state.usage };
          yield { type: 'done', finishReason: state.finishReason, totalTokens: state.usage?.totalTokens ?? null };
          return;
        }

        for await (const event of decodeSse(response.body, limits)) {
          if (event.event !== 'message') continue; // 只处理 data 事件；其它事件名忽略
          const parsed = parseStreamPayload(event.data, state);
          if (parsed === null) {
            if (state.sawDone) break;
            continue;
          }
          if (parsed.type === 'delta') yield parsed;
        }

        if (state.usage !== null) yield { type: 'usage', usage: state.usage };
        yield { type: 'done', finishReason: state.finishReason, totalTokens: state.usage?.totalTokens ?? null };
      } catch (error) {
        // 统一归因：超时/取消/网络/协议，全部收敛成三个稳定码之一。
        if (error instanceof ChatTransportError) throw error;
        if (timedOutStage !== null) {
          throw timeoutError(timedOutStage, timedOutStage === 'headers' ? limits.headerTimeoutMs : limits.totalTimeoutMs);
        }
        if (externalAborted) throw abortedError();
        if (error instanceof BrokerError) {
          // endpoint.js 的活性/一致性错误：目标被换掉，按 redirect 类归因。
          throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT, 'provider endpoint check failed', {
            reason: 'ENDPOINT_REJECTED',
          });
        }
        if (isAbortLike(error)) throw abortedError();
        throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider stream failed', {
          reason: 'PROTOCOL',
        });
      } finally {
        clearTimeout(headerTimer);
        clearTimeout(totalTimer);
        if (externalSignal !== undefined && externalSignal !== null) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    },
  });
}

/**
 * provider/test：`GET <baseUrl>/models`（合同 §2.4）。
 *
 * 与 chat 共享同一条传输纪律：brand 校验、`redirect:'manual'`、响应头 64KiB、
 * 超时 8s、不读代理。返回 `{status, modelCount}`；失败抛 `ChatTransportError`。
 *
 * @param {{
 *   endpoint: object,
 *   credential?: {header(): string} | null,
 *   fetchImpl?: Function,
 *   signal?: AbortSignal,
 *   limits?: object,
 * }} options
 * @returns {Promise<{status: number, modelCount: number}>}
 */
export async function probeProviderModels(options) {
  const { endpoint, credential = null } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const limits = effectiveLimits(options.limits);
  try {
    assertEndpointActive(endpoint);
  } catch {
    throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT, 'provider endpoint check failed', {
      reason: 'ENDPOINT_REJECTED',
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.probeTimeoutMs);
  const externalSignal = options.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal !== undefined && externalSignal !== null) {
    if (externalSignal.aborted) throw abortedError();
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    let response;
    try {
      response = await fetchImpl(endpoint.requestUrl ?? endpoint.url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'cache-control': 'no-store',
          ...(credential === null || credential === undefined ? {} : { authorization: credential.header() }),
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_TIMEOUT, `provider did not answer in ${limits.probeTimeoutMs}ms`, {
        stage: 'PROBE',
        timeout_ms: limits.probeTimeoutMs,
      });
      if (isAbortLike(error)) {
        throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_TIMEOUT, `provider did not answer in ${limits.probeTimeoutMs}ms`, {
          stage: 'PROBE',
          timeout_ms: limits.probeTimeoutMs,
        });
      }
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider request failed', {
        reason: 'NETWORK',
        cause_code: typeof error?.cause?.code === 'string' ? error.cause.code : null,
      });
    }
    const status = Number(response.status);
    if (timedOut) {
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_TIMEOUT, `provider did not answer in ${limits.probeTimeoutMs}ms`, {
        stage: 'PROBE',
        timeout_ms: limits.probeTimeoutMs,
      });
    }
    if (status >= 300 && status <= 399) {
      try {
        await readCapped(response, 4096);
      } catch {
        // 忽略错误体。
      }
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT, 'provider answered with a redirect that was not followed', {
        status,
      });
    }
    if (!(status >= 200 && status <= 299)) {
      try {
        await readCapped(response, 4096);
      } catch {
        // 忽略错误体。
      }
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider returned a non-success status', {
        status,
      });
    }
    try {
      assertEndpointUnchanged(endpoint, response.url ?? endpoint.requestUrl);
    } catch {
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT, 'provider answered from an unexpected endpoint', {
        reason: 'ENDPOINT_ESCAPE',
      });
    }
    if (estimateHeaderBytes(response) > limits.maxHeaderBytes) {
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider response headers exceed the limit', {
        reason: 'HEADERS_OVERSIZE',
        limit_bytes: limits.maxHeaderBytes,
      });
    }
    const buffer = await readCapped(response, limits.maxProbeBytes);
    let json;
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider response is not valid JSON', {
        reason: 'MALFORMED',
      });
    }
    const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
    return Object.freeze({ status, modelCount: list.length });
  } catch (error) {
    if (error instanceof ChatTransportError) throw error;
    if (timedOut) {
      throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_TIMEOUT, `provider did not answer in ${limits.probeTimeoutMs}ms`, {
        stage: 'PROBE',
        timeout_ms: limits.probeTimeoutMs,
      });
    }
    throw transportError(CHAT_TRANSPORT_CODES.UPSTREAM_FAILED, 'provider test failed', {
      reason: 'PROTOCOL',
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal !== undefined && externalSignal !== null) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}
