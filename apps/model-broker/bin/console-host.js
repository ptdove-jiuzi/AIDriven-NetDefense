#!/usr/bin/env node
/**
 * AIDriven NetDefense · broker 子进程宿主（console v2）。
 *
 * 拓扑（CONSOLE-V2-CONTRACT §1）：
 *
 *   daemon ──spawn(stdio, newline-delimited JSON-RPC 2.0)──▶ 本进程
 *   本进程独占：`<dataDir>/secrets/providers/*.json` 与全部出站 HTTPS。
 *
 * 硬边界：
 * 1. **stdout 只允许 JSON-RPC 帧**（每行一个）；任何诊断/审计一律走 stderr，
 *    且 stderr 只写结构化 JSON —— 不打印 prompt、不打印密钥、不打印上游正文。
 * 2. 端点每次调用都经 `endpoint.js` 注册表签发 brand（`register` + 使用前
 *    `assertEndpointActive`），请求期不存在"用参数覆盖 URL 某一段"的入口；
 *    非回环必须 https、拒绝 userinfo/query/hash、3xx 不跟随。
 * 3. 明文密钥只在 `.readSecretForRuntime()` 与 `Authorization` header 之间流动；
 *    JSON-RPC 响应里只有 masked/fingerprint/updatedAt/lengthBucket。
 * 4. `chat/cancel` 或 stdin EOF：立刻 abort 上游 fetch、清计时器；没有在途 chat
 *    后进程自行退出（退出码 0），不留定时器/句柄。
 *
 * 方法（请求/响应参数见 `docs/implementation/status/UI2-B9.md` 的协议表）：
 * - `host/hello`            → 握手（协议版本、能力、存储可用性；不含路径/密钥）
 * - `credentials/put`       → `{providerId, apiKey}` → `{ok:true}`（不回显）
 * - `credentials/delete`    → `{providerId}` → `{ok:true, deleted}`
 * - `credentials/info`      → `{providerIds:[…]}` → 批量掩码信息
 * - `provider/test`         → `{provider}` → 合同 §2.4 的 `{ok,latencyMs,…}`
 * - `chat/start`            → `{requestId, provider, modelId, messages, …}`
 *                             → 立即 `{accepted:true}`，随后用 `chat/event` 通知推流
 * - `chat/cancel`           → `{requestId}` → `{ok:true, cancelled}`
 * - `shutdown`              → `{ok:true}` 后退出（退出码 0）
 *
 * 作者：PT-dove
 */

import process from 'node:process';
import readline from 'node:readline';
import util from 'node:util';

import { createCredentialStore, CREDENTIAL_STORE_CODES, PROVIDER_ID_PATTERN } from '../src/credential-store.js';
import { createDpapiEnvelopeProtector } from '../src/secret-protector.js';
import { assertEndpointActive, createEndpointRegistry, ENDPOINT_KINDS } from '../src/endpoint.js';
import {
  CHAT_TRANSPORT_CODES,
  ChatTransportError,
  createChatTransport,
  probeProviderModels,
} from '../src/chat-transport.js';

const PROTOCOL_VERSION = '1.0';
const HOST_NAME = 'aegis-model-broker-host';

/** JSON-RPC 2.0 标准错误码。 */
const RPC_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** 领域错误：`data.code` 才是 daemon 映射 HTTP 状态的依据。 */
  DOMAIN_ERROR: -32000,
});

/** 单行输入上限：IPC 帧不该有兆级 JSON（prompt 在 host 侧已按字符数限制）。 */
const MAX_STDIN_LINE_BYTES = 1024 * 1024;

/** chat body 合同限制（§2.5；systemPrompt/locale 见合同 §1.1 v1.1）。 */
const CHAT_LIMITS = Object.freeze({
  maxMessages: 40,
  maxContentChars: 8000,
  maxTotalChars: 32000,
  maxOutputTokens: 8192,
  minTemperature: 0,
  maxTemperature: 2,
  /** `chat/start.systemPrompt` 的长度上限（合同 §1.1）。 */
  maxSystemPromptChars: 2000,
  /** 同一 host 进程内同时在途的 chat 上限（daemon 侧还有全局 2 的上限）。 */
  maxConcurrentChats: 2,
});

/** UI 支持的语言集合（合同 §1.1：locale ∈ 7 语言，与 i18n 一致）。 */
const SUPPORTED_LOCALES = Object.freeze(['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']);

/** 语言指令模板：固定英文句，避免把用户输入拼成新指令。 */
function languageInstructionFor(locale) {
  return `Reply in ${locale}.`;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

// ---------------------------------------------------------------------------
// stderr：唯一允许的诊断通道（结构化 JSON、无明文）
// ---------------------------------------------------------------------------

function logStructured(event) {
  const record = { ts: new Date().toISOString(), ...event };
  try {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // stderr 写失败（管道已关）不该改变进程行为。
  }
}

// ---------------------------------------------------------------------------
// 协议错误
// ---------------------------------------------------------------------------

class RpcError extends Error {
  /**
   * @param {number} rpcCode JSON-RPC 标准码。
   * @param {string} message 稳定英文短句，不含密钥/prompt。
   * @param {object} [data] `{code, reason, …}`：`code` 用 daemon 的 console 错误码。
   */
  constructor(rpcCode, message, data) {
    super(message);
    this.name = 'RpcError';
    this.rpcCode = rpcCode;
    this.data = data === undefined ? undefined : { ...data };
  }
}

function invalidParams(message, reason, code = 'PROVIDER_INVALID') {
  return new RpcError(RPC_CODES.INVALID_PARAMS, message, { code, reason });
}

function domainError(code, message, details) {
  return new RpcError(RPC_CODES.DOMAIN_ERROR, message, { code, ...(details ?? {}) });
}

function internalError(message, code, details) {
  return new RpcError(RPC_CODES.INTERNAL_ERROR, message, { code, ...(details ?? {}) });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * 只认 `--data-dir/--dataDir`（空格或 `=` 两种写法）。其余参数记一条结构化警告，
 * 不打印用法到 stdout（stdout 只允许 JSON-RPC 帧）。
 */
function parseArgv(argv) {
  const result = { dataDir: null, unknown: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--data-dir' || argument === '--dataDir') {
      const next = argv[index + 1];
      if (typeof next === 'string' && next !== '') {
        result.dataDir = next;
        index += 1;
      }
      continue;
    }
    if (argument.startsWith('--data-dir=')) {
      result.dataDir = argument.slice('--data-dir='.length);
      continue;
    }
    if (argument.startsWith('--dataDir=')) {
      result.dataDir = argument.slice('--dataDir='.length);
      continue;
    }
    result.unknown.push(argument);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 凭据封装：给 transport 的 `header()`，但不可被序列化/打印出明文
// ---------------------------------------------------------------------------

function wrapRuntimeCredential(secret) {
  const credential = {
    header: () => `Bearer ${secret}`,
    toString: () => '[REDACTED]',
    toJSON: () => '[REDACTED]',
  };
  credential[util.inspect.custom] = () => 'RuntimeCredential([REDACTED])';
  return Object.freeze(credential);
}

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

function startHost() {
  const argv = parseArgv(process.argv.slice(2));
  for (const unknown of argv.unknown) {
    logStructured({ event: 'host.warn', reason: 'UNKNOWN_ARGUMENT', argument: unknown });
  }

  const envDataDir = typeof process.env.AEGIS_DATA_DIR === 'string' && process.env.AEGIS_DATA_DIR.trim() !== ''
    ? process.env.AEGIS_DATA_DIR.trim()
    : null;
  const configuredDataDir = argv.dataDir ?? envDataDir;

  /** @type {ReturnType<typeof createCredentialStore> | null} */
  let store = null;
  let storeErrorCode = null;
  let storeErrorReason = null;
  if (configuredDataDir !== null) {
    try {
      // R5-002：凭据静态保护（DPAPI envelope）+ R5-003：strict 暴露模式
      // （跨进程只回"有没有凭据/更新时间/长度桶"，不回落盘指纹与后 4 位）。
      const protector = createDpapiEnvelopeProtector({ dataDir: configuredDataDir });
      store = createCredentialStore({
        dataDir: configuredDataDir,
        protectAtRest: protector,
        exposure: 'strict',
      });
      // R5-002 迁移：旧明文槽位改写成保护格式；失败只记日志，不阻断 host（读路径仍兼容明文）。
      try {
        const migration = store.migrateLegacySlots();
        if (migration.migrated > 0 || migration.failed > 0) {
          logStructured({
            event: 'credentials.migrate',
            migrated: migration.migrated,
            skipped: migration.skipped,
            failed: migration.failed,
          });
        }
      } catch {
        logStructured({ event: 'credentials.migrate', outcome: 'failed' });
      }
    } catch (error) {
      storeErrorCode = typeof error?.code === 'string' ? error.code : CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE;
      storeErrorReason = typeof error?.details?.reason === 'string' ? error.details.reason : 'STORE_UNAVAILABLE';
    }
  } else {
    storeErrorCode = CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE;
    storeErrorReason = 'DATA_DIR_REQUIRED';
  }

  const startedAt = new Date().toISOString();
  /** @type {Map<string, {controller: AbortController, cancelled: boolean}>} */
  const activeChats = new Map();
  let exiting = false;
  let stdoutBroken = false;

  function requireStore() {
    if (store === null) {
      throw domainError(
        CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
        'credential store is not available in this host process',
        { reason: storeErrorReason ?? 'STORE_UNAVAILABLE' },
      );
    }
    return store;
  }

  // -------------------------------------------------------------------------
  // stdout：只写 JSON-RPC 帧
  // -------------------------------------------------------------------------

  function writeFrame(frame) {
    // 注意：退出流程中仍允许写**响应**帧（否则最后一条 chat/cancel 的响应会被截断），
    // 只抑制通知（见 notifyChatEvent）。进程退出前会先刷 stdout。
    if (stdoutBroken) return;
    try {
      process.stdout.write(`${JSON.stringify(frame)}\n`);
    } catch {
      stdoutBroken = true;
    }
  }

  function writeResult(id, result) {
    writeFrame({ jsonrpc: '2.0', id, result });
  }

  function writeError(id, error) {
    if (error instanceof RpcError) {
      writeFrame({ jsonrpc: '2.0', id, error: { code: error.rpcCode, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } });
      return;
    }
    // 未预期异常：只回稳定文案与枚举，不带 message/栈（可能含路径或上游字符串）。
    const causeCode = typeof error?.code === 'string' && /^[A-Z_]{3,64}$/u.test(error.code) ? error.code : null;
    writeFrame({
      jsonrpc: '2.0',
      id,
      error: {
        code: RPC_CODES.INTERNAL_ERROR,
        message: 'host failed to handle the request',
        data: { code: 'INTERNAL_ERROR', ...(causeCode === null ? {} : { cause_code: causeCode }) },
      },
    });
    logStructured({ event: 'host.error', reason: 'UNHANDLED', error_name: typeof error?.name === 'string' ? error.name : null });
  }

  function notifyChatEvent(requestId, event) {
    if (exiting) return;
    writeFrame({ jsonrpc: '2.0', method: 'chat/event', params: { requestId, event } });
  }

  // -------------------------------------------------------------------------
  // provider 参数校验 + 端点注册（ADR-0010 §2.2 / §3.1）
  // -------------------------------------------------------------------------

  /**
   * 校验 daemon 下发的 provider 描述，并把它登记进一个**每次调用新建**的注册表。
   * 注册表容量 8；本函数不缓存 brand，调用方拿到后立刻用、用完即弃。
   *
   * @param {unknown} input
   * @param {'/chat/completions'|'/models'} pathSuffix
   * @returns {{brand: object, provider: {id: string, kind: string, baseUrl: string, allowLoopback: boolean}}}
   */
  function registerProvider(input, pathSuffix) {
    if (!isPlainObject(input)) {
      throw invalidParams('provider must be an object', 'PROVIDER_SHAPE');
    }
    const id = input.id;
    const kind = input.kind ?? 'openai-compatible';
    const baseUrl = input.baseUrl;
    const allowLoopback = input.allowLoopback === true;
    if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
      throw invalidParams('provider id must match [a-z0-9-]{2,32}', 'PROVIDER_ID', 'PROVIDER_INVALID');
    }
    if (typeof kind !== 'string' || !ENDPOINT_KINDS.includes(kind)) {
      throw invalidParams('provider kind is not supported', 'PROVIDER_KIND', 'PROVIDER_INVALID');
    }
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '' || baseUrl.length > 2048) {
      throw invalidParams('provider baseUrl is required', 'PROVIDER_BASE_URL', 'PROVIDER_INVALID');
    }
    if (typeof input.allowLoopback !== 'undefined' && typeof input.allowLoopback !== 'boolean') {
      throw invalidParams('provider allowLoopback must be a boolean', 'PROVIDER_ALLOW_LOOPBACK', 'PROVIDER_INVALID');
    }
    const registry = createEndpointRegistry();
    let brand;
    try {
      brand = registry.register({
        id,
        kind,
        baseUrl: baseUrl.trim(),
        allowLoopback,
        // 请求路径后缀来自本文件的常量表（'/chat/completions' 或 '/models'），
        // 不来自请求参数；baseUrl 只作为前缀，运行期没有任何 URL 拼接入口。
        pathSuffix,
      });
    } catch (error) {
      // endpoint.js 的错误消息是稳定英文，不含输入原文；仍然只保留枚举 reason。
      throw invalidParams('provider endpoint is not allowed', 'PROVIDER_ENDPOINT', 'PROVIDER_INVALID');
    }
    return { brand, provider: { id, kind, baseUrl: baseUrl.trim(), allowLoopback } };
  }

  function credentialFor(brand, provider) {
    const storeImpl = requireStore();
    const secret = storeImpl.readSecretForRuntime(provider.id);
    if (secret === null) {
      // 回环 provider（本地 Ollama / 自建服务）允许无密钥；
      // 其余 provider 一律失败关闭，绝不用空 Authorization 去试。
      if (brand.loopback === true) return null;
      throw domainError('CREDENTIAL_MISSING', 'provider credential is not configured', { providerId: provider.id });
    }
    return wrapRuntimeCredential(secret);
  }

  // -------------------------------------------------------------------------
  // 方法实现
  // -------------------------------------------------------------------------

  const handlers = Object.freeze({
    'host/hello'(params) {
      void params;
      return Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        host: HOST_NAME,
        pid: process.pid,
        node: process.versions.node,
        startedAt,
        store: Object.freeze({
          available: store !== null,
          ...(store === null
            ? { reason: storeErrorReason ?? 'STORE_UNAVAILABLE' }
            : { protection: store.protection, exposure: store.exposure }),
        }),
        capabilities: Object.freeze([
          'credentials/put',
          'credentials/delete',
          'credentials/info',
          'provider/test',
          'chat/start',
          'chat/cancel',
        ]),
        limits: Object.freeze({
          maxMessages: CHAT_LIMITS.maxMessages,
          maxContentChars: CHAT_LIMITS.maxContentChars,
          maxTotalChars: CHAT_LIMITS.maxTotalChars,
          maxOutputTokens: CHAT_LIMITS.maxOutputTokens,
          maxSystemPromptChars: CHAT_LIMITS.maxSystemPromptChars,
          locales: SUPPORTED_LOCALES,
        }),
      });
    },

    'credentials/put'(params) {
      if (!isPlainObject(params)) throw invalidParams('params must be an object', 'PARAMS_SHAPE');
      const storeImpl = requireStore();
      try {
        storeImpl.putCredential(params.providerId, params.apiKey);
      } catch (error) {
        if (error?.code === CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID) {
          throw domainError(
            CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID,
            'provider credential shape is invalid',
            { reason: error?.details?.reason ?? 'EMPTY' },
          );
        }
        if (error?.code === CREDENTIAL_STORE_CODES.PROVIDER_INVALID) {
          throw invalidParams('provider id must match [a-z0-9-]{2,32}', 'PROVIDER_ID', 'PROVIDER_INVALID');
        }
        throw domainError(
          CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
          'credential store is not writable',
          { reason: typeof error?.details?.step === 'string' ? String(error.details.step).toUpperCase() : 'WRITE' },
        );
      }
      // 合同 §2.3：成功不回显掩码/指纹/任何片段。
      logStructured({ event: 'credentials.put', providerId: params.providerId, outcome: 'ok' });
      return Object.freeze({ ok: true });
    },

    'credentials/delete'(params) {
      if (!isPlainObject(params)) throw invalidParams('params must be an object', 'PARAMS_SHAPE');
      const storeImpl = requireStore();
      let deleted;
      try {
        deleted = storeImpl.deleteCredential(params.providerId).deleted === true;
      } catch (error) {
        if (error?.code === CREDENTIAL_STORE_CODES.PROVIDER_INVALID) {
          throw invalidParams('provider id must match [a-z0-9-]{2,32}', 'PROVIDER_ID', 'PROVIDER_INVALID');
        }
        throw domainError(
          CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
          'credential slot could not be removed',
          { reason: typeof error?.details?.step === 'string' ? String(error.details.step).toUpperCase() : 'DELETE' },
        );
      }
      logStructured({ event: 'credentials.delete', providerId: params.providerId, outcome: deleted ? 'deleted' : 'absent' });
      return Object.freeze({ ok: true, deleted });
    },

    'credentials/info'(params) {
      if (!isPlainObject(params)) throw invalidParams('params must be an object', 'PARAMS_SHAPE');
      const storeImpl = requireStore();
      let result;
      try {
        result = storeImpl.infoBatch(params.providerIds);
      } catch (error) {
        throw invalidParams('providerIds must be an array of provider ids', 'PROVIDER_IDS', 'PROVIDER_INVALID');
      }
      return result;
    },

    async 'provider/test'(params) {
      if (!isPlainObject(params)) throw invalidParams('params must be an object', 'PARAMS_SHAPE');
      const { brand, provider } = registerProvider(params.provider, '/models');
      const credential = credentialFor(brand, provider);
      const startedAtMs = Date.now();
      const testedAt = new Date().toISOString();
      let outcome = 'ok';
      try {
        // 使用前再确认一次：注册记录被替换/注销后旧 brand 必须立刻失败。
        assertEndpointActive(brand);
        const probe = await probeProviderModels({ endpoint: brand, credential });
        logStructured({
          event: 'egress',
          kind: 'test',
          providerId: provider.id,
          host: brand.host,
          outcome: 'ok',
          latencyMs: Date.now() - startedAtMs,
        });
        return Object.freeze({
          ok: true,
          latencyMs: Date.now() - startedAtMs,
          modelCount: probe.modelCount,
          error: null,
          testedAt,
        });
      } catch (error) {
        outcome = typeof error?.code === 'string' ? error.code : 'UPSTREAM_FAILED';
        const latencyMs = Date.now() - startedAtMs;
        logStructured({
          event: 'egress',
          kind: 'test',
          providerId: provider.id,
          host: brand.host,
          outcome,
          latencyMs,
        });
        // 合同 §2.4：失败仍是 HTTP 200 + ok:false（由 daemon 映射）。
        return Object.freeze({
          ok: false,
          latencyMs,
          modelCount: null,
          error: Object.freeze(probeFailure(error)),
          testedAt,
        });
      }
    },

    'chat/start'(params) {
      if (!isPlainObject(params)) throw invalidParams('params must be an object', 'PARAMS_SHAPE', 'CHAT_INVALID');
      const requestId = params.requestId;
      if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
        throw invalidParams('requestId must match [A-Za-z0-9._:-]{1,64}', 'REQUEST_ID', 'CHAT_INVALID');
      }
      if (activeChats.has(requestId)) {
        throw domainError('CHAT_BUSY', 'a chat request with this id is already in flight', { requestId });
      }
      if (activeChats.size >= CHAT_LIMITS.maxConcurrentChats) {
        throw domainError('CHAT_BUSY', 'too many chat requests are in flight', {
          limit: CHAT_LIMITS.maxConcurrentChats,
        });
      }
      const normalized = normalizeChatRequest(params);
      const { brand, provider } = registerProvider(params.provider, '/chat/completions');

      const controller = new AbortController();
      const chat = { controller, cancelled: false };
      activeChats.set(requestId, chat);

      // 先回复"已接受"，随后一切结果都走 `chat/event` 通知（合同 §3.2）。
      setImmediate(() => {
        runChat({ requestId, chat, brand, provider, normalized }).catch((error) => {
          logStructured({
            event: 'host.error',
            reason: 'RUN_CHAT',
            error_name: typeof error?.name === 'string' ? error.name : null,
          });
        });
      });
      return Object.freeze({ accepted: true, requestId });
    },

    'chat/cancel'(params) {
      if (!isPlainObject(params)) throw invalidParams('params must be an object', 'PARAMS_SHAPE');
      const requestId = params.requestId;
      if (typeof requestId !== 'string') {
        throw invalidParams('requestId is required', 'REQUEST_ID', 'CHAT_INVALID');
      }
      const chat = activeChats.get(requestId);
      if (chat === undefined) return Object.freeze({ ok: true, cancelled: false });
      chat.cancelled = true;
      // 立刻中止上游 fetch：这是 250ms 断言语义的落点（剩余计时器由传输层 finally 清理）。
      chat.controller.abort();
      logStructured({ event: 'chat.cancel', requestId });
      return Object.freeze({ ok: true, cancelled: true });
    },

    shutdown() {
      // 响应在返回后由 handleLine 写出；这里只安排退出。
      setImmediate(() => requestExit('shutdown'));
      return Object.freeze({ ok: true });
    },
  });

  /**
   * 合同 §2.4 的失败映射：code + action。
   * @returns {{code: string, message: string, action: string}}
   */
  function probeFailure(error) {
    const code = typeof error?.code === 'string' ? error.code : CHAT_TRANSPORT_CODES.UPSTREAM_FAILED;
    if (code === CHAT_TRANSPORT_CODES.UPSTREAM_TIMEOUT) {
      return {
        code,
        message: 'provider did not answer in 8000ms',
        action: 'CHECK_BASE_URL_OR_NETWORK',
      };
    }
    if (code === CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT) {
      return {
        code,
        message: 'provider answered with a redirect that was not followed',
        action: 'CHECK_REDIRECT',
      };
    }
    const status = Number(error?.details?.status);
    if (status === 401 || status === 403) {
      return { code, message: 'provider rejected the credential', action: 'CHECK_KEY' };
    }
    if (status === 429) {
      return { code, message: 'provider rate limit or quota exhausted', action: 'CHECK_PROVIDER_QUOTA' };
    }
    if (Number.isFinite(status) && status >= 500) {
      return { code, message: 'provider is unavailable', action: 'RETRY_LATER' };
    }
    return { code, message: 'provider request failed', action: 'CHECK_BASE_URL_OR_NETWORK' };
  }

  /** 合同 §3.2 的 error 事件映射（message 不含 prompt/上游正文）。 */
  function chatErrorEvent(error) {
    const code = typeof error?.code === 'string'
      ? error.code
      : (typeof error?.data?.code === 'string' ? error.data.code : CHAT_TRANSPORT_CODES.UPSTREAM_FAILED);
    if (code === 'CREDENTIAL_MISSING') {
      return Object.freeze({
        type: 'error',
        code,
        message: 'provider credential is not configured',
        retryable: false,
        action: 'CHECK_KEY',
        details: Object.freeze({}),
      });
    }
    const failure = probeFailure(error);
    let action = failure.action;
    if (code === CHAT_TRANSPORT_CODES.UPSTREAM_FAILED && action === 'CHECK_BASE_URL_OR_NETWORK') {
      // 网络/协议类失败在 chat 场景里更可能是模型配置或 provider 状态问题。
      action = 'CHECK_MODEL_SETTINGS';
    }
    return Object.freeze({
      type: 'error',
      code,
      message: failure.message,
      retryable: code !== CHAT_TRANSPORT_CODES.UPSTREAM_REDIRECT,
      action,
      details: Object.freeze({}),
    });
  }

  /**
   * 校验 chat body（合同 §2.5 + §1.1 v1.1）：
   * - 客户端 `messages`：role 只允许 user/assistant（**system 一律拒绝**）、1..40 条、
   *   单条 1..8000 字符、总 ≤32000 字符；
   * - `systemPrompt?`（由 daemon 提供，客户端不可注入）：1..2000 字符，合法时成为出站
   *   `messages` 的第一条 `system` 消息；
   * - `locale?`：∈ 7 语言，合法时追加固定语言指令 "Reply in <locale>."。
   *
   * 校验失败一律 `CHAT_INVALID` + 枚举 `details.reason`，**不回显内容**。
   */
  function normalizeChatRequest(params) {
    const messages = params.messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > CHAT_LIMITS.maxMessages) {
      throw invalidParams('messages must be an array of 1..40 items', 'MESSAGES_SHAPE', 'CHAT_INVALID');
    }
    let totalChars = 0;
    const normalizedMessages = messages.map((message) => {
      if (!isPlainObject(message)) {
        throw invalidParams('each message must be an object', 'MESSAGE_SHAPE', 'CHAT_INVALID');
      }
      if (message.role !== 'user' && message.role !== 'assistant') {
        // `system` 只能由 daemon 的 systemPrompt 提供：客户端注入一律拒绝，不借道。
        throw invalidParams('message role must be user or assistant', 'MESSAGE_ROLE', 'CHAT_INVALID');
      }
      if (typeof message.content !== 'string') {
        throw invalidParams('message content must be a string', 'MESSAGE_CONTENT', 'CHAT_INVALID');
      }
      const chars = [...message.content].length;
      if (chars < 1 || chars > CHAT_LIMITS.maxContentChars) {
        throw invalidParams('message content must be 1..8000 characters', 'MESSAGE_CONTENT_LENGTH', 'CHAT_INVALID');
      }
      totalChars += chars;
      if (totalChars > CHAT_LIMITS.maxTotalChars) {
        throw invalidParams('total message content exceeds 32000 characters', 'MESSAGES_TOTAL_LENGTH', 'CHAT_INVALID');
      }
      return Object.freeze({ role: message.role, content: message.content });
    });

    // systemPrompt：可选；非法形状/空串/超长都不回显内容，只给枚举 reason。
    let systemPrompt = null;
    if (params.systemPrompt !== undefined && params.systemPrompt !== null) {
      if (typeof params.systemPrompt !== 'string') {
        throw invalidParams('systemPrompt must be a string', 'SYSTEM_PROMPT_SHAPE', 'CHAT_INVALID');
      }
      if (params.systemPrompt.trim() === '') {
        throw invalidParams('systemPrompt must not be empty', 'SYSTEM_PROMPT_EMPTY', 'CHAT_INVALID');
      }
      if ([...params.systemPrompt].length > CHAT_LIMITS.maxSystemPromptChars) {
        throw invalidParams('systemPrompt must be at most 2000 characters', 'SYSTEM_PROMPT_TOO_LONG', 'CHAT_INVALID');
      }
      systemPrompt = params.systemPrompt;
    }

    // locale：可选；只接受 7 个 UI 语言，非法值不回显。
    let locale = null;
    if (params.locale !== undefined && params.locale !== null) {
      if (typeof params.locale !== 'string' || !SUPPORTED_LOCALES.includes(params.locale)) {
        throw invalidParams('locale is not one of the supported UI languages', 'LOCALE', 'CHAT_INVALID');
      }
      locale = params.locale;
    }

    // 组装出站 messages：system（daemon 常量提示词 + 语言指令）永远在第一位；
    // 语言指令拼在 systemPrompt 尾部（没有 systemPrompt 时单独成一条 system）。
    let systemContent = systemPrompt;
    if (locale !== null) {
      const instruction = languageInstructionFor(locale);
      systemContent = systemContent === null ? instruction : `${systemContent}\n\n${instruction}`;
    }
    const outboundMessages = systemContent === null
      ? [...normalizedMessages]
      : [{ role: 'system', content: systemContent }, ...normalizedMessages];

    const modelId = params.modelId;
    if (typeof modelId !== 'string' || !MODEL_ID_PATTERN.test(modelId)) {
      throw invalidParams('modelId must match [A-Za-z0-9._:-]{1,64}', 'MODEL_ID', 'CHAT_INVALID');
    }
    const maxOutputTokens = params.maxOutputTokens === undefined ? 1024 : params.maxOutputTokens;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > CHAT_LIMITS.maxOutputTokens) {
      throw invalidParams('maxOutputTokens must be 1..8192', 'MAX_OUTPUT_TOKENS', 'CHAT_INVALID');
    }
    const temperature = params.temperature === undefined ? 0.2 : params.temperature;
    if (typeof temperature !== 'number' || !Number.isFinite(temperature)
      || temperature < CHAT_LIMITS.minTemperature || temperature > CHAT_LIMITS.maxTemperature) {
      throw invalidParams('temperature must be a number in 0..2', 'TEMPERATURE', 'CHAT_INVALID');
    }
    return Object.freeze({
      messages: Object.freeze(outboundMessages.map((message) => Object.freeze({ ...message }))),
      modelId,
      maxOutputTokens,
      temperature,
    });
  }

  /**
   * 跑一次 chat：产出 delta/usage/done/error 事件。
   * 失败不抛给事件循环（否则就是未捕获异常）；一切都变成 `error` 事件。
   */
  async function runChat({ requestId, chat, brand, provider, normalized }) {
    const startedAtMs = Date.now();
    let outcome = 'ok';
    let totalTokens = null;
    let usageSeen = null;
    let finishReason = 'stop';
    try {
      const credential = credentialFor(brand, provider);
      const transport = createChatTransport({ endpoint: brand, credential });

      for await (const event of transport.stream({
        model: normalized.modelId,
        messages: normalized.messages,
        maxTokens: normalized.maxOutputTokens,
        temperature: normalized.temperature,
        signal: chat.controller.signal,
      })) {
        if (chat.cancelled) break;
        if (event.type === 'delta') {
          notifyChatEvent(requestId, Object.freeze({ type: 'delta', text: event.text }));
          continue;
        }
        if (event.type === 'usage') {
          usageSeen = event.usage;
          totalTokens = event.usage.totalTokens;
          notifyChatEvent(requestId, Object.freeze({
            type: 'usage',
            promptTokens: event.usage.promptTokens,
            completionTokens: event.usage.completionTokens,
            totalTokens: event.usage.totalTokens,
          }));
          continue;
        }
        if (event.type === 'done') {
          finishReason = event.finishReason;
          totalTokens = event.totalTokens ?? totalTokens;
        }
      }

      if (chat.cancelled) {
        outcome = 'cancelled';
        notifyChatEvent(requestId, Object.freeze({ type: 'done', finishReason: 'cancelled', totalTokens: usageSeen?.totalTokens ?? null }));
      } else {
        notifyChatEvent(requestId, Object.freeze({ type: 'done', finishReason, totalTokens }));
      }
    } catch (error) {
      if (chat.cancelled) {
        outcome = 'cancelled';
        notifyChatEvent(requestId, Object.freeze({ type: 'done', finishReason: 'cancelled', totalTokens: usageSeenGuard(totalTokens) }));
      } else {
        outcome = typeof error?.code === 'string' ? error.code : CHAT_TRANSPORT_CODES.UPSTREAM_FAILED;
        notifyChatEvent(requestId, chatErrorEvent(error));
      }
    } finally {
      activeChats.delete(requestId);
      logStructured({
        event: 'egress',
        kind: 'chat',
        providerId: provider.id,
        host: brand.host,
        outcome,
        latencyMs: Date.now() - startedAtMs,
      });
      // 取消是"这次调用结束"的信号：没有别的在途 chat 时就退出（退出码 0），
      // 不把 120s 计时器/keep-alive 句柄留给 daemon 去 SIGKILL。
      if (!exiting && chat.cancelled && activeChats.size === 0) {
        requestExit('chat_cancelled');
      }
    }
  }

  /** usage 可能从未出现：null 而不是 0（合同：取不到给 null，不编造）。 */
  function usageSeenGuard(value) {
    return Number.isSafeInteger(value) ? value : null;
  }

  // -------------------------------------------------------------------------
  // 退出
  // -------------------------------------------------------------------------

  /**
   * 退出路径：中止所有在途 chat → 关 stdin → 刷 stdout → exit(0)。
   * 任何分支都不留定时器；上游 fetch 的清理由传输层 finally 负责。
   */
  function requestExit(reason) {
    if (exiting) return;
    exiting = true;
    logStructured({ event: 'host.exit', reason });
    for (const chat of activeChats.values()) {
      chat.cancelled = true;
      try {
        chat.controller.abort();
      } catch {
        // abort 不该抛；抛了也不影响退出。
      }
    }
    activeChats.clear();
    try {
      readlineInterface.close();
    } catch {
      // 已经关了。
    }
    try {
      process.stdin.pause();
    } catch {
      // 忽略。
    }
    const exitNow = () => process.exit(0);
    // 等 stdout 缓冲刷完再退出：否则最后一条响应/通知可能被截断。
    if (process.stdout.writableLength === 0) setImmediate(exitNow);
    else process.stdout.write('', exitNow);
  }

  // -------------------------------------------------------------------------
  // 帧处理
  // -------------------------------------------------------------------------

  async function dispatch(message) {
    const method = message.method;
    if (typeof method !== 'string' || method === '') {
      throw new RpcError(RPC_CODES.INVALID_REQUEST, 'method is required');
    }
    if (!Object.hasOwn(handlers, method)) {
      throw new RpcError(RPC_CODES.METHOD_NOT_FOUND, `unknown method ${method}`);
    }
    return handlers[method](message.params ?? {});
  }

  async function handleLine(line) {
    if (line.trim() === '') return;
    if (Buffer.byteLength(line, 'utf8') > MAX_STDIN_LINE_BYTES) {
      writeError(null, new RpcError(RPC_CODES.INVALID_REQUEST, 'request frame is too large'));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeError(null, new RpcError(RPC_CODES.PARSE_ERROR, 'request frame is not valid JSON'));
      return;
    }
    if (!isPlainObject(message) || message.jsonrpc !== '2.0') {
      writeError(isPlainObject(message) && Object.hasOwn(message, 'id') ? message.id : null,
        new RpcError(RPC_CODES.INVALID_REQUEST, 'request must be a JSON-RPC 2.0 object'));
      return;
    }
    const id = message.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      // 通知（无 id）不需要响应；本服务端没有客户端通知语义，直接忽略。
      if (id === undefined || id === null) return;
      writeError(null, new RpcError(RPC_CODES.INVALID_REQUEST, 'request id must be a number or string'));
      return;
    }
    try {
      const result = await dispatch(message);
      writeResult(id, result);
    } catch (error) {
      writeError(id, error);
    }
  }

  const readlineInterface = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  // 顺序处理：同一时刻只解一条帧，避免响应乱序；chat 的流事件不受此限（异步通知）。
  let queue = Promise.resolve();
  readlineInterface.on('line', (line) => {
    queue = queue.then(() => handleLine(line)).catch((error) => {
      logStructured({ event: 'host.error', reason: 'LINE_HANDLER', error_name: typeof error?.name === 'string' ? error.name : null });
    });
  });

  readlineInterface.on('close', () => {
    // stdin EOF：daemon 已经走了，没有在途 chat 需要保活。
    requestExit('stdin_eof');
  });

  process.on('SIGTERM', () => requestExit('sigterm'));
  process.on('SIGINT', () => requestExit('sigint'));

  process.on('uncaughtException', (error) => {
    logStructured({ event: 'host.fatal', reason: 'UNCAUGHT_EXCEPTION', error_name: typeof error?.name === 'string' ? error.name : null });
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    logStructured({ event: 'host.fatal', reason: 'UNHANDLED_REJECTION', error_name: typeof error?.name === 'string' ? error.name : null });
    process.exit(1);
  });

  logStructured({
    event: 'host.start',
    pid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    storeAvailable: store !== null,
    ...(store === null ? { storeReason: storeErrorReason } : {}),
  });

  return Object.freeze({
    pid: process.pid,
    requestExit,
    storeAvailable: store !== null,
  });
}

startHost();
