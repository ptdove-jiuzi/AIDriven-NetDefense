/**
 * 提供方 HTTP 传输层。
 *
 * 它只做四件事，而且每件都是"少做一点"：
 * 1. 只往**一个**固定 URL 发 POST，`redirect: 'manual'`——3xx 拿到状态码就失败，
 *    既不跟随、也没有"跟着 Location 再发一次"的代码路径；
 * 2. 响应体按字节上限流式截断，不把整段响应先读进内存；
 * 3. 把传输失败归类成稳定 kind，交给上判断"是否已发送"并保留债务；
 * 4. 不打印、不记录、不回显任何 header 或正文。
 *
 * 明确不做的：不重试、不降级到备用端点、不读 `http_proxy`/`https_proxy`
 * （Node 内置 fetch 不读代理环境变量，这里也不额外加），不缓存。
 *
 * 注册表时代多一条：发送前必须复查端点仍然有效（ADR §3.1 阴性用例 1）。
 * 否则"注销后仍在飞的那个请求"会绕过 broker 的活性检查。
 */

import { BrokerError, BROKER_CODES } from './errors.js';
import { assertEndpointActive, assertEndpointUnchanged } from './endpoint.js';
import { BROKER_LIMITS } from './policy.js';

/** 传输失败的稳定分类。只有 `aborted`/`timeout` 之外的都属于"结果不可证明"。 */
export const TRANSPORT_FAILURES = Object.freeze({
  NETWORK: 'network',
  ABORTED: 'aborted',
  OVERSIZE: 'oversize',
  MALFORMED: 'malformed',
  STATUS: 'status',
});

export class ProviderTransportError extends Error {
  constructor(kind, message, details) {
    super(`${kind}: ${message}`);
    this.name = 'ProviderTransportError';
    this.kind = kind;
    this.details = Object.freeze({ ...(details ?? {}) });
    if (Error.captureStackTrace) Error.captureStackTrace(this, ProviderTransportError);
  }
}

function isAbortError(error) {
  if (!error) return false;
  const name = typeof error.name === 'string' ? error.name : '';
  return name === 'AbortError' || name === 'TimeoutError' || error.code === 'ABORT_ERR';
}

async function readCapped(response, maxBytes) {
  // 先看 `content-length`：声明就超限的直接拒绝，不必先读进内存再判断。
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderTransportError(TRANSPORT_FAILURES.OVERSIZE, 'provider response declares more bytes than allowed', {
      declared,
      limit: maxBytes,
    });
  }
  const body = response.body;
  if (body === null || body === undefined) {
    // 没有可读流（只可能来自注入的 fetch 实现）：读完之后再判上限，
    // 并明确标注这一点——真实 fetch 总是给 body。
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ProviderTransportError(TRANSPORT_FAILURES.OVERSIZE, 'provider response exceeds the byte limit', {
        bytes: buffer.byteLength,
        limit: maxBytes,
      });
    }
    return buffer;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // 超限就主动断开：既省内存，也让提供方知道我们不要了。
      try {
        await reader.cancel();
      } catch {
        // 取消失败不影响"超限即失败"的结论。
      }
      throw new ProviderTransportError(TRANSPORT_FAILURES.OVERSIZE, 'provider response exceeds the byte limit', {
        limit: maxBytes,
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** 提供方 usage 归一化：两种常见字段名都接受，缺失或非法一律 null。 */
export function normalizeUsage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0) return null;
  if (!Number.isSafeInteger(output) || output < 0) return null;
  return Object.freeze({ input_tokens: input, output_tokens: output });
}

function extractContent(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const candidate = choice?.message?.content ?? json?.content;
  if (typeof candidate === 'string') return candidate;
  if (Array.isArray(candidate)) {
    // 只接受纯文本片段；其他类型（图片、工具调用）不在这里解释。
    const parts = [];
    for (const part of candidate) {
      if (part !== null && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
    }
    return parts.length === 0 ? null : parts.join('');
  }
  return null;
}

/**
 * @param {{
 *   endpoint: object,
 *   credential: object|null,
 *   fetchImpl?: Function,
 *   limits?: object,
 * }} options
 */
export function createHttpTransport(options) {
  const { endpoint, credential } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const limits = options.limits ?? BROKER_LIMITS;
  if (typeof fetchImpl !== 'function') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ENDPOINT, 'no fetch implementation available');
  }

  return Object.freeze({
    endpoint,

    /**
     * @param {{ body: string, signal?: AbortSignal, requestId: string }} input
     * @returns {Promise<{status: number, content: string|null, usage: object|null}>}
     */
    async send(input) {
      // 注册被注销/替换后，任何"已经拿在手里的 brand"都不再可用。
      assertEndpointActive(endpoint);
      if (credential === null || credential === undefined) {
        // 没有凭据就不发：这是"凭据只从受保护配置读取"的落点。
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'provider credential is not configured');
      }
      let response;
      try {
        // 打到冻结的完整请求路径（`requestUrl` = scheme+host+port+保存期算好的 requestPath）。
        // 这里不从参数拼任何一段 URL，也不存在第二个候选地址。
        response = await fetchImpl(endpoint.requestUrl ?? endpoint.url, {
          method: 'POST',
          headers: Object.freeze({
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: credential.header(),
          }),
          body: input.body,
          // `manual` 而不是 `error`：3xx 要变成"可归因的状态码失败"（reason=redirect_refused），
          // 不能被 undici 归成"网络未知"。两者都不跟随跳转，但前者能证明"我们收到了 302 且没走"。
          redirect: 'manual',
          signal: input.signal,
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw new ProviderTransportError(TRANSPORT_FAILURES.ABORTED, 'request aborted', {
            request_id: input.requestId,
          });
        }
        // 不把原始 message 带出去：它可能包含 URL 或代理地址。
        throw new ProviderTransportError(TRANSPORT_FAILURES.NETWORK, 'provider request failed', {
          request_id: input.requestId,
          cause_code: typeof error?.cause?.code === 'string' ? error.cause.code : null,
        });
      }

      assertEndpointUnchanged(endpoint, response.url ?? endpoint.url);

      const status = Number(response.status);
      if (!(status >= 200 && status <= 299)) {
        // 先判状态码再读正文：否则一个 4xx/5xx 的 1MiB 错误页会被完整读入，
        // 并让"提供方返回错误"被误报成"响应超限"，误导运维归因。
        try {
          await readCapped(response, Math.min(limits.maxResponseBytes, 4096));
        } catch {
          // 错误分支读完即弃，读失败不影响状态码这个结论。
        }
        throw new ProviderTransportError(TRANSPORT_FAILURES.STATUS, 'provider returned a non-success status', {
          status,
        });
      }

      let buffer;
      try {
        buffer = await readCapped(response, limits.maxResponseBytes);
      } catch (error) {
        if (error instanceof ProviderTransportError) throw error;
        // 正文读取阶段被中止（超时/客户端取消）：必须包成 ABORTED，
        // 否则会落到"结果未知"分支，把超时误报成网络异常（归因错误）。
        if (isAbortError(error)) {
          throw new ProviderTransportError(TRANSPORT_FAILURES.ABORTED, 'request aborted while reading the body', {
            request_id: input.requestId,
          });
        }
        throw new ProviderTransportError(TRANSPORT_FAILURES.NETWORK, 'provider response could not be read', {
          request_id: input.requestId,
          cause_code: typeof error?.code === 'string' ? error.code : null,
        });
      }

      let json;
      try {
        json = JSON.parse(buffer.toString('utf8'));
      } catch {
        throw new ProviderTransportError(TRANSPORT_FAILURES.MALFORMED, 'provider response is not valid JSON', {
          status,
          bytes: buffer.byteLength,
        });
      }
      const content = extractContent(json);
      if (content === null) {
        // 200 + 合法 JSON 但没有消息正文（例如把错误体当 200 返回）：
        // 这是协议违规，按 schema 失败处理——不能当成一次成功响应，
        // 否则它会关闭半开熔断，还会让调用方拿到 null 内容。
        throw new ProviderTransportError(TRANSPORT_FAILURES.MALFORMED, 'provider response carries no message content', {
          status,
        });
      }
      return Object.freeze({
        status,
        content,
        usage: normalizeUsage(json?.usage),
        model: typeof json?.model === 'string' ? json.model : null,
      });
    },
  });
}
