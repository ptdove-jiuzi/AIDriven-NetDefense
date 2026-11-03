/**
 * Provider Registry：有限集合的冻结端点。
 *
 * 历史：设计不变量 2 与 AT-DATA-004（v1）要求 broker 只能连**一个固定的 HTTPS 端点**。
 * ADR-0010（Accepted，2026-11-04T01:56）把它换成「登记在册的 ≤8 个端点」，
 * 并授权改写 AT-DATA-004 判据（ADR §3.1）。本文件是那次改写的落点。
 *
 * 为什么不是"放宽 URL 校验"：早期版本的教训是形状校验可以被形状伪造。
 * 因此这里保留两个机制，一个都没有降级：
 *
 * 1. **brand（WeakSet）**：只有本模块签发的对象才在集合里。调用方自己拼一个
 *    `{url:'http://attacker/…', origin:…, host:…}` 冻住传进来，形状完全一致也没用。
 * 2. **保存期冻结**：`{scheme, host, port, pathPrefix}` 在注册时算好并冻结，
 *    运行期只读；请求期不存在"用参数覆盖某一段 URL"的入口。
 *
 * 新增第三层（ADR §3.1 的三条阴性用例要求）：**活性（liveness）**。
 * brand 记住自己属于哪个注册表的哪条记录；记录被 `unregister` 删掉、或被
 * `replace` 换成新记录后，旧 brand 立刻失效——不能靠"对象还在内存里"继续用。
 * 这一层只能靠记录对象身份判定，任何"看起来像"的普通对象都进不来。
 *
 * 依旧拒绝的（比单端点时代更宽，但仍是白名单，不是正则）：
 * - `userinfo`（`https://user:pass@host`）：会把凭据写进 URL 并进代理日志；
 * - `query`/`hash`：是"每次请求可变"的合法外衣，能把端点变成任意上游；
 * - 重定向：第一跳可信不代表第二跳可信（transport 侧 `redirect: 'manual'`）；
 * - 非回环的 `http:`：明文把 Bearer 凭据发出去；
 * - 明文 + `localhost`：解析结果取决于 hosts/DNS，改指向外部主机时这条"本地调试
 *   开关"就成了外带通道。ADR §2.2 文字里列了 `localhost`，实现仍从严（见状态文件
 *   「与 ADR 文本的差异」），只接受字面量 `127.0.0.0/8` 与 `::1`。
 */

import { BrokerError, BROKER_CODES } from './errors.js';

/** 注册表容量上限（ADR §2.1：超过 8 个就不是个人安防软件，而是网关）。 */
export const MAX_REGISTERED_ENDPOINTS = 8;

/** 单个 provider 可声明的模型 id 上限：防御"配置里塞一万个模型"的形态。 */
const MAX_MODELS_PER_PROVIDER = 32;

/** 只有本模块签发的 brand 会被登记在这里（形状校验挡不住伪造，这个可以）。 */
const RESOLVED_ENDPOINTS = new WeakSet();

/** brand → { registry, record }：使用期判定"这条注册还在不在"的唯一依据。 */
const BRAND_ORIGIN = new WeakMap();

/** 精确回环判定：绝不用 `startsWith('127.')`——`127.0.0.1.evil.example` 也会命中。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

/** ADR §2.1 的 kind 取值：决定请求/响应适配器，不在这个集合里的一律拒绝。 */
export const ENDPOINT_KINDS = Object.freeze(['openai-compatible', 'deepseek', 'ollama']);

/**
 * 每种适配器的固定请求后缀。
 *
 * ADR 的 `baseUrl` 是**前缀**（`https://api.deepseek.com/v1`），不是完整请求路径；
 * 真正要 POST 的路径 = pathPrefix + 这里的后缀，两者都在保存期算进冻结结果。
 * 后缀是常量表的一部分，不由调用方传入，也不参与任何"运行时拼接"。
 */
const REQUEST_PATH_SUFFIX = Object.freeze({
  'openai-compatible': '/chat/completions',
  deepseek: '/chat/completions',
  ollama: '/chat/completions',
});

const PROVIDER_ID = /^[a-z0-9-]{2,32}$/u;

export function isLoopbackHost(hostname) {
  const value = String(hostname ?? '').toLowerCase();
  if (LOOPBACK_HOSTS.has(value)) return true;
  if (!LOOPBACK_V4.test(value)) return false;
  // 每段必须是 0-255 的十进制：`127.1.1.999` 不是地址。
  return value.split('.').every((part) => Number(part) <= 255);
}

/** 字面量回环地址（不含主机名，因此不依赖任何解析结果）。 */
export function isLiteralLoopback(hostname) {
  const value = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/gu, '');
  return value === '::1' || LOOPBACK_V4.test(value);
}

/** 该对象是否由本模块签发（brand 检查，不是形状检查）。 */
export function isResolvedEndpoint(value) {
  return value !== null && typeof value === 'object' && RESOLVED_ENDPOINTS.has(value);
}

function endpointError(message, details) {
  return new BrokerError(BROKER_CODES.ERR_BROKER_ENDPOINT, message, details);
}

function effectivePort(url) {
  if (url.port !== '') return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

/** IPv6 主机在拼接 URL 时必须带方括号（`URL.hostname` 已经带，这里只是兜底）。 */
function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function isDefaultPort(scheme, port) {
  return (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80');
}

function normalizeKind(kind) {
  if (kind === undefined || kind === null) return 'openai-compatible';
  if (typeof kind !== 'string' || !ENDPOINT_KINDS.includes(kind)) {
    throw endpointError('provider kind is not one of the supported adapters', { kind: typeof kind === 'string' ? kind : null });
  }
  return kind;
}

function normalizeModels(input, fallbackModel) {
  const source = input === undefined || input === null
    ? (typeof fallbackModel === 'string' ? [fallbackModel] : [])
    : input;
  if (!Array.isArray(source)) {
    throw endpointError('provider models must be an array of model ids', { field: 'models' });
  }
  if (source.length > MAX_MODELS_PER_PROVIDER) {
    throw endpointError('provider declares too many model ids', { count: source.length, limit: MAX_MODELS_PER_PROVIDER });
  }
  const seen = new Set();
  const models = [];
  for (const item of source) {
    if (typeof item !== 'string') {
      throw endpointError('provider model ids must be strings', { field: 'models' });
    }
    const value = item.trim();
    if (value === '' || value.length > 128) {
      throw endpointError('provider model id must be 1..128 characters', { field: 'models' });
    }
    if (seen.has(value)) {
      // 重复的 model id 会让"选中的是哪一个"变得不可判定，直接拒绝。
      throw endpointError('provider model ids must be unique', { model_id: value });
    }
    seen.add(value);
    models.push(value);
  }
  return Object.freeze(models);
}

/**
 * 保存期解析：把可变的字符串收敛成冻结的 `{scheme, host, port, pathPrefix}`。
 *
 * 返回值不是 brand，只是"已冻结的目标"；brand 由注册表签发（见 `buildRecord`）。
 */
function freezeTarget(raw, options) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw endpointError('provider endpoint url is required');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw endpointError('provider endpoint url is not absolute');
  }
  if (url.username !== '' || url.password !== '') {
    throw endpointError('provider endpoint must not carry userinfo');
  }
  if (url.search !== '' || url.hash !== '') {
    throw endpointError('provider endpoint must not carry query or fragment');
  }
  const pathPrefix = url.pathname.replace(/\/+$/u, '');
  if (pathPrefix === '') {
    throw endpointError('provider endpoint must name an exact path prefix');
  }
  // 后缀只能来自常量表或显式配置（legacy 单端点传 ''），不允许请求期拼接。
  let suffix;
  if (options.pathSuffix === undefined) {
    suffix = REQUEST_PATH_SUFFIX[options.kind] ?? '';
  } else if (typeof options.pathSuffix !== 'string' || (options.pathSuffix !== '' && !options.pathSuffix.startsWith('/'))) {
    throw endpointError('provider pathSuffix must be empty or start with "/"', { field: 'pathSuffix' });
  } else {
    suffix = options.pathSuffix;
  }
  const requestPath = `${pathPrefix}${suffix}`;
  if (requestPath.length > 512) {
    throw endpointError('provider request path is too long', { length: requestPath.length });
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:') {
    // 明文 HTTP 只在"本地/自建 provider"这一种情形下允许，且必须显式打开。
    if (!(url.protocol === 'http:' && loopback && options.allowLoopback === true && options.kind !== 'deepseek')) {
      throw endpointError('provider endpoint must use https', {
        protocol: url.protocol,
        loopback,
      });
    }
    if (!isLiteralLoopback(url.hostname)) {
      throw endpointError(
        'insecure loopback endpoints must use a literal 127.0.0.0/8 or ::1 address',
        { hostname: url.hostname },
      );
    }
  }
  return Object.freeze({
    scheme: url.protocol.slice(0, -1),
    // host 冻结成小写：URL 已经把主机名规范化为小写，这里再显式固定一次，
    // 避免任何"大小写不同所以不算同一端点"的绕过思路。
    host: url.hostname.toLowerCase(),
    port: effectivePort(url),
    pathPrefix,
    requestPath,
    pathSuffix: suffix,
    // 以下字段只为向后兼容旧的 brand 消费者（broker/transport/测试）。
    url: url.href,
    origin: url.origin,
    pathname: url.pathname,
    hostname: url.hostname,
    protocol: url.protocol,
    loopback,
  });
}

/**
 * 建一个注册表。容量由调用方给定，公开工厂只给 `MAX_REGISTERED_ENDPOINTS`：
 * "最多 8 个"是产品约束，不提供配置项。
 */
function createRegistry(capacity) {
  /** @type {Map<string, object>} */
  const entries = new Map();

  const registry = {
    capacity,
    get size() {
      return entries.size;
    },

    isCurrent(record) {
      return record !== null && typeof record === 'object'
        && record.revoked !== true
        && entries.get(record.id) === record;
    },

    /** 注册一个新 provider。同 id + 同冻结目标 = 幂等；同 id + 不同目标 = 必须显式 replace。 */
    register(config) {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw endpointError('provider registration must be an object');
      }
      const id = validateProviderId(config.id);
      const next = buildRecord(registry, id, config);
      const existing = entries.get(id);
      if (existing) {
        if (existing.signature === next.signature) return existing.brand;
        throw endpointError('provider id is already registered with a different endpoint', {
          reason: 'duplicate_id',
          provider_id: id,
        });
      }
      if (entries.size >= capacity) {
        throw endpointError('provider registry is full', {
          reason: 'capacity',
          capacity,
          size: entries.size,
        });
      }
      entries.set(id, next);
      return next.brand;
    },

    /**
     * 替换某 provider 的冻结目标（用户改配置里的 baseUrl）。
     *
     * **旧 brand 立即失效**：不是"更新一个字段"，而是换一条记录。这样任何持有旧
     * brand 的 broker/传输层都无法继续往旧主机发请求（ADR §3.1 阴性用例 2）。
     */
    replace(id, config) {
      const providerId = validateProviderId(id);
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw endpointError('provider registration must be an object');
      }
      if (config.id !== undefined && config.id !== providerId) {
        throw endpointError('provider id cannot be renamed; a new id is a new provider', {
          reason: 'rename_forbidden',
          provider_id: providerId,
        });
      }
      const existing = entries.get(providerId);
      if (!existing) {
        throw endpointError('provider is not registered', { reason: 'provider_unknown', provider_id: providerId });
      }
      const next = buildRecord(registry, providerId, config);
      if (next.signature === existing.signature) return existing.brand;
      existing.revoked = true;
      entries.set(providerId, next);
      return next.brand;
    },

    /** 注销：返回是否真的删掉了一条。旧 brand 的每一次后续使用都会失败。 */
    unregister(id) {
      const record = entries.get(id);
      if (record === undefined) return false;
      record.revoked = true;
      entries.delete(id);
      return true;
    },

    clear() {
      for (const record of entries.values()) record.revoked = true;
      entries.clear();
      return true;
    },

    get(id) {
      const record = entries.get(id);
      return record === undefined ? null : record.brand;
    },

    /** 取 brand 或抛错：broker 构造期用它把"provider 不存在"变成显式错误。 */
    resolve(id) {
      const record = entries.get(id);
      if (record === undefined) {
        throw endpointError('provider is not registered', {
          reason: 'provider_unknown',
          provider_id: typeof id === 'string' ? id : null,
        });
      }
      return record.brand;
    },

    /** 该 brand 是否属于本注册表且仍然有效。 */
    isActive(brand) {
      if (!isResolvedEndpoint(brand)) return false;
      const origin = BRAND_ORIGIN.get(brand);
      return origin !== undefined && origin.registry === registry && registry.isCurrent(origin.record);
    },

    assertActive(brand) {
      assertEndpointActive(brand);
      if (!registry.isActive(brand)) {
        throw endpointError('provider endpoint belongs to a different registry', { reason: 'foreign_registry' });
      }
      return true;
    },

    /** 只给运维/审计看的描述，不含任何凭据内容（credentialRef 只是指针）。 */
    list() {
      return Object.freeze([...entries.values()].map((record) => Object.freeze({
        id: record.id,
        kind: record.brand.kind,
        scheme: record.brand.scheme,
        host: record.brand.host,
        port: record.brand.port,
        pathPrefix: record.brand.pathPrefix,
        loopback: record.brand.loopback,
        allowLoopback: record.brand.allowLoopback,
        credentialRef: record.brand.credentialRef,
        models: record.brand.models,
      })));
    },
  };

  Object.freeze(registry);
  return registry;
}

function validateProviderId(id) {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) {
    throw endpointError('provider id must match [a-z0-9-]{2,32}', {
      field: 'id',
      length: typeof id === 'string' ? id.length : null,
    });
  }
  return id;
}

function buildRecord(registry, id, config) {
  const kind = normalizeKind(config.kind);
  const allowLoopback = config.allowLoopback === true;
  if (kind === 'deepseek' && allowLoopback) {
    // 官方适配器指向回环没有合法用途，这个组合只可能是配置写错或被改写。
    throw endpointError('the deepseek adapter must not target a loopback endpoint', { kind, provider_id: id });
  }
  const frozen = freezeTarget(config.baseUrl ?? config.url, {
    allowLoopback,
    kind,
    pathSuffix: config.pathSuffix,
  });
  const models = normalizeModels(config.models, config.model);
  const model = typeof config.model === 'string' && config.model !== ''
    ? config.model
    : (models.length === 1 ? models[0] : null);
  let credentialRef = null;
  if (config.credentialRef !== undefined && config.credentialRef !== null) {
    if (typeof config.credentialRef !== 'string' || config.credentialRef.length === 0 || config.credentialRef.length > 256) {
      throw endpointError('provider credentialRef must be a short pointer string', { field: 'credentialRef' });
    }
    credentialRef = config.credentialRef;
  }

  const requestUrl = `${frozen.scheme}://${formatHost(frozen.host)}${isDefaultPort(frozen.scheme, frozen.port) ? '' : `:${frozen.port}`}${frozen.requestPath}`;

  const brand = Object.freeze({
    ...frozen,
    requestUrl,
    // `id` 与 `providerId` 同值：前者对齐配置字段名，后者是 broker 侧读的名字。
    id,
    providerId: id,
    kind,
    allowLoopback,
    credentialRef,
    models,
    model,
  });

  RESOLVED_ENDPOINTS.add(brand);

  const record = {
    id,
    brand,
    frozen,
    revoked: false,
    // 幂等判定只看"已冻结结果 + 适配器口径"，不看原始字符串：
    // `https://h/v1` 与 `https://h/v1/` 冻出来是同一个端点，重复注册不该报错。
    signature: [
      frozen.scheme,
      frozen.host,
      frozen.port,
      frozen.pathPrefix,
      kind,
      allowLoopback ? '1' : '0',
      credentialRef ?? '',
      models.join(','),
    ].join('|'),
  };
  BRAND_ORIGIN.set(brand, { registry, record });
  return record;
}

/** 公开工厂：容量固定为 8，不提供放宽入口。 */
export function createEndpointRegistry() {
  return createRegistry(MAX_REGISTERED_ENDPOINTS);
}

/**
 * 使用期活性判定：brand 必须仍指向**当前**那条注册记录。
 *
 * 这是"注销/替换后旧 brand 立即失效"的落点。任何普通对象（哪怕形状一模一样）
 * 都到不了这里——`isResolvedEndpoint` 先把它挡掉。
 */
export function assertEndpointActive(brand) {
  if (!isResolvedEndpoint(brand)) {
    throw endpointError('endpoint was not issued by the broker resolver');
  }
  const origin = BRAND_ORIGIN.get(brand);
  if (origin === undefined || !origin.registry.isCurrent(origin.record)) {
    throw endpointError('provider endpoint is no longer registered', { reason: 'endpoint_revoked' });
  }
  return true;
}

export function isEndpointActive(brand) {
  try {
    return assertEndpointActive(brand);
  } catch {
    return false;
  }
}

/**
 * 旧接口：单一固定端点。
 *
 * 语义不变，实现改为"建一个只有一项的私有注册表"。这样单 provider 配置与
 * "注册表里只有一项"走完全同一条代码路径（ADR §3 的兼容性要求），而它不会占用
 * 共享注册表的 8 个名额、也不会被别人的注销操作影响。
 *
 * @param {string|{url: string, model?: string}} input
 * @param {{ allowInsecureLoopback?: boolean, model?: string }} [options]
 */
export function resolveFixedEndpoint(input, options = {}) {
  if (isResolvedEndpoint(input)) return input;
  const raw = typeof input === 'string' ? input : input?.url;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw endpointError('provider endpoint url is required');
  }
  const model = typeof options.model === 'string' && options.model.length > 0
    ? options.model
    : (typeof input === 'object' && typeof input.model === 'string' ? input.model : null);
  if (model === null) {
    throw endpointError('fixed provider model id is required');
  }
  const registry = createRegistry(1);
  return registry.register({
    id: 'legacy',
    baseUrl: raw,
    allowLoopback: options.allowInsecureLoopback === true,
    // 旧接口的 URL 就是**完整请求路径**，因此后缀为空——这条兼容路径完全保留
    // 单端点时代的行为，"注册表只有一项"不是新的语义。
    pathSuffix: '',
    models: [model],
    model,
  });
}

/** 请求前后各校验一次：防止注入的 transport/中间件把目标改掉，或注册已被撤销。 */
export function assertEndpointUnchanged(endpoint, candidateUrl) {
  assertEndpointActive(endpoint);
  let url;
  try {
    url = new URL(String(candidateUrl));
  } catch {
    throw endpointError('response url is not absolute');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw endpointError('response url must not carry userinfo, query or fragment');
  }
  if (url.protocol !== `${endpoint.scheme}:`
    || url.hostname.toLowerCase() !== endpoint.host
    || effectivePort(url) !== endpoint.port) {
    throw endpointError('request left the fixed provider endpoint', {
      expected_origin: endpoint.origin,
      actual_origin: url.origin,
    });
  }
  // 路径按保存期算好的**完整请求路径**逐字符比对：既不是"前缀相近就放行"，
  // 也不是运行期拼接（后缀来自常量表，见 REQUEST_PATH_SUFFIX）。
  if (url.pathname !== endpoint.requestPath) {
    throw endpointError('request left the frozen provider path', {
      expected_path: endpoint.requestPath,
      actual_path: url.pathname,
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// 默认注册表：本地配置装载器（后续由 daemon 调用）直接用它。
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY = createEndpointRegistry();

/** 注册一个 provider，返回 brand。最多 8 个，id 唯一。 */
export function registerEndpoint(config) {
  return DEFAULT_REGISTRY.register(config);
}

/** 替换某 provider 的冻结目标；旧 brand 立即失效。 */
export function replaceEndpoint(id, config) {
  return DEFAULT_REGISTRY.replace(id, config);
}

/** 注销某 provider；旧 brand 立即失效。返回是否真的删掉了一条。 */
export function unregisterEndpoint(id) {
  return DEFAULT_REGISTRY.unregister(id);
}

export function getRegisteredEndpoint(id) {
  return DEFAULT_REGISTRY.get(id);
}

export function listRegisteredEndpoints() {
  return DEFAULT_REGISTRY.list();
}

export function defaultEndpointRegistry() {
  return DEFAULT_REGISTRY;
}

/** 仅供测试/管理员重置：清空默认注册表并让所有旧 brand 失效。 */
export function resetEndpointRegistry() {
  return DEFAULT_REGISTRY.clear();
}
