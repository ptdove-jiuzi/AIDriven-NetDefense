/**
 * M6 model-broker 控制面。
 *
 * 一次请求的固定顺序（顺序本身就是安全属性，不能重排）：
 *
 *   1. 出域检查（分级 → allowlist → 脱敏 → 大小上限）
 *   2. 身份来源校验（token 推导的 analysis/attempt，不信任请求体自报）
 *   3. 凭据存在性 + 熔断门
 *   4. 有界并发队列（排队期间可零成本取消/超时）
 *   5. 读取余额，为本次调用定尺寸（output_limit）→ 定稿最终报文与摘要
 *   6. **原子预扣**（唯一权威准入；失败即止，绝不发请求）
 *   7. 预留 → sent（此后不再可能 void）
 *   8. 发送（超时/取消/网络失败一律保留债务）
 *   9. 结算（有 usage 用 usage；无 usage / 结果未知按上界保守结清）
 *
 * 失败关闭的四条硬规则：
 * - 预扣之前失败 → 零网络、零账本行；
 * - 预扣之后失败 → **unknown → 按上界结清**，禁止 void、禁止自动重试；
 * - 鉴权/配额类提供方错误 → 熔断立即打开，后续请求在预扣前被拒；
 * - 结算异常不改变"债务已发生"的事实，只记录并继续失败关闭。
 */

import { BrokerError, BROKER_CODES, asBrokerError } from './errors.js';
import { assertBudgetPort, readPreview } from './budget-port.js';
import { assertEndpointActive, isResolvedEndpoint, resolveFixedEndpoint } from './endpoint.js';
import { assertProviderBudgetPort } from './endpoint-budget.js';
import { assertEscalationLedger, createEscalationLedger } from './escalation-ledger.js';
import { BROKER_LIMITS, CIRCUIT_POLICY, resolveLimits } from './policy.js';
import { RequestQueue } from './queue.js';
import { buildOutboundPayload, estimateInputUpper, finalizeOutbound } from './redaction.js';
import { createHttpTransport, ProviderTransportError, TRANSPORT_FAILURES } from './transport.js';
import { isUuid, uuid } from './util.js';

const NULL_LOGGER = Object.freeze({ emit() {} });

const CIRCUIT_CLOSED = 'closed';
const CIRCUIT_OPEN = 'open';
const CIRCUIT_HALF_OPEN = 'half_open';

/**
 * tier 顺序（ADR-0010 §2.4）。
 *
 * 故意不 import `packages/policy`：broker 不该依赖判据包（那会把"选路"与"发不发"重新耦合）。
 * 三值闭集是日志契约的一部分，由 `routing-record.test.js` 交叉校验它和 `TIERS` 一致。
 */
const TIER_ORDER = Object.freeze({ watch: 0, triage: 1, respond: 2 });

/** 指纹/决策原因的字符集：只允许能安全写进单行日志的字符（挡换行注入）。 */
const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DECISION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

/** 没有路由决策时的记录形状：键始终存在，值为 null（聚合时不会漏行）。 */
const NULL_ROUTING = Object.freeze({ tier: null, fingerprint: null, decision: null, escalated_from: null });

function brief(value, max = 64) {
  if (typeof value !== 'string') return value === undefined ? null : value;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 身份必须来自调用方已认证的通道（单次 token），这里只做结构与一致性校验。 */
function readIdentity(derived, intent) {
  if (derived === null || typeof derived !== 'object') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'identity resolver returned nothing');
  }
  if (!isUuid(derived.analysis_id)) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'derived analysis_id must be a UUID');
  }
  const attemptId = derived.attempt_id ?? null;
  if (attemptId !== null && !isUuid(attemptId)) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'derived attempt_id must be a UUID when present');
  }
  // 请求体自报的身份只能用于"交叉核对"，永远不能作为权威。
  if (intent?.analysis_id !== undefined && intent.analysis_id !== derived.analysis_id) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'request body analysis_id does not match the authenticated identity', {
      body_analysis_id: brief(intent.analysis_id),
      token_analysis_id: derived.analysis_id,
    });
  }
  if (intent?.attempt_id !== undefined && intent.attempt_id !== null && intent.attempt_id !== attemptId) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'request body attempt_id does not match the authenticated identity', {
      body_attempt_id: brief(intent.attempt_id),
      token_attempt_id: attemptId,
    });
  }
  return { analysisId: derived.analysis_id, attemptId };
}

/** 模型路由固定：请求体自报的模型必须等于**已选定**的模型，否则说明路由被改写。 */
function assertModelRoute(payload, model) {
  if (payload.model !== undefined && payload.model !== model) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'requested model does not match the selected provider model', {
      configured: model,
      requested: brief(payload.model),
    });
  }
}

/**
 * 读调用方给的**路由决策**（ADR-0010 §2.7）。
 *
 * broker 不选路：它只接收 `selectRoute` 的结论并原样记进日志。因此这里只做形态校验，
 * 不做任何"猜一个 tier"的事——猜出来的 tier 会让用量页按错误口径聚合。
 *
 * 唯一要判的语义是 `escalatedFrom`：它必须是一个**更低的** tier（升级只能向上）。
 * 这条校验挡的是"把降级/原地不动标成升级"，否则升级计数会被污染。
 *
 * @param {unknown} value `requestOptions.routing`。
 * @returns {{tier: string|null, fingerprint: string|null, decision: string|null, escalated_from: string|null}} 冻结记录。
 */
function readRoutingDecision(value) {
  if (value === undefined || value === null) return NULL_ROUTING;
  const fail = (field, reason) => new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'routing decision is malformed', {
    reason: 'routing_decision_invalid',
    field,
    detail: reason,
  });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('routing', 'routing must be a plain object');
  }
  if (typeof value.tier !== 'string' || !Object.hasOwn(TIER_ORDER, value.tier)) {
    throw fail('routing.tier', 'tier must be watch, triage or respond');
  }
  if (typeof value.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(value.fingerprint)) {
    throw fail('routing.fingerprint', 'fingerprint must be 1..128 characters of [A-Za-z0-9._:-]');
  }
  if (typeof value.decision !== 'string' || !DECISION_PATTERN.test(value.decision)) {
    throw fail('routing.decision', 'decision must be 1..64 characters of [A-Za-z0-9._:-]');
  }
  let escalatedFrom = value.escalatedFrom ?? null;
  if (escalatedFrom !== null) {
    if (typeof escalatedFrom !== 'string' || !Object.hasOwn(TIER_ORDER, escalatedFrom)) {
      throw fail('routing.escalatedFrom', 'escalatedFrom must be a tier or null');
    }
    if (TIER_ORDER[escalatedFrom] >= TIER_ORDER[value.tier]) {
      throw fail('routing.escalatedFrom', 'escalatedFrom must be a strictly lower tier than tier');
    }
  }
  return Object.freeze({
    tier: value.tier,
    fingerprint: value.fingerprint,
    decision: value.decision,
    escalated_from: escalatedFrom,
  });
}

/**
 * 解析本次 broker 实例锁定的路由。
 *
 * 两种入口，**都不接受运行期的 URL**：
 * - 注册表入口（ADR-0010）：`{registry, providerId, modelId}`。providerId 必须已在
 *   注册表中注册，modelId 必须是该 provider 声明过的模型（"校验其存在"，tier 选择不在这里）；
 * - 单端点入口（向后兼容）：`{endpoint|endpointUrl, model}`，等价于"注册表只有一项"。
 *
 * 路由在构造期定死：`request()` 里没有任何参数能改 host/port/path，也没有第二 endpoint。
 */
function resolveBrokerRoute(options) {
  if (options.registry !== undefined && options.registry !== null) {
    const registry = options.registry;
    if (typeof registry.resolve !== 'function' || typeof registry.assertActive !== 'function') {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_ENDPOINT, 'endpoint registry must implement resolve() and assertActive()');
    }
    const providerId = options.providerId;
    if (typeof providerId !== 'string' || providerId === '') {
      throw new BrokerError(
        BROKER_CODES.ERR_BROKER_ENDPOINT,
        'createModelBroker requires providerId when an endpoint registry is supplied',
      );
    }
    const endpoint = registry.resolve(providerId);
    if (!isResolvedEndpoint(endpoint)) {
      // 注册表返回了非 brand 对象：要么注册表被替换成了假的，要么有人绕过本模块签发了端点。
      throw new BrokerError(
        BROKER_CODES.ERR_BROKER_ENDPOINT,
        'endpoint registry returned an object that was not issued by the broker resolver',
      );
    }
    // 显式给了 modelId 就必须是有效字符串（空串是调用方错误，不能悄悄回落到默认模型）；
    // 完全没给时才允许用 provider 上唯一的模型（单模型 provider 的正常配置）。
    const explicit = options.modelId !== undefined && options.modelId !== null;
    const modelId = explicit ? options.modelId : endpoint.model;
    if (typeof modelId !== 'string' || modelId === '') {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'a registered model id must be selected', {
        provider_id: providerId,
      });
    }
    if (!endpoint.models.includes(modelId)) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'selected model is not registered for this provider', {
        reason: endpoint.models.length === 0 ? 'provider_declares_no_models' : 'model_not_registered',
        provider_id: providerId,
        model_id: brief(modelId),
      });
    }
    return { endpoint, model: modelId, providerId };
  }

  const endpoint = isResolvedEndpoint(options.endpoint)
    ? options.endpoint
    : resolveFixedEndpoint(options.endpoint ?? options.endpointUrl, {
      allowInsecureLoopback: options.allowInsecureLoopback === true,
      model: options.model,
    });
  const model = typeof endpoint.model === 'string' && endpoint.model !== '' ? endpoint.model : options.model;
  if (typeof model !== 'string' || model === '') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'a fixed provider model id is required');
  }
  return { endpoint, model, providerId: endpoint.providerId ?? null };
}

/** 把传输层异常归类成：对外错误码 + 熔断类别 + 账本原因。 */
function classifyTransportFailure(error, context) {
  if (error instanceof ProviderTransportError) {
    switch (error.kind) {
      case TRANSPORT_FAILURES.ABORTED:
        // 超时是提供方健康信号（挂住不响应），计入可重试失败；
        // 客户端取消则与提供方无关，不进熔断计数。
        return context.timedOut
          ? { code: BROKER_CODES.ERR_BROKER_TIMEOUT, circuit: 'retryable', reason: 'timeout' }
          : { code: BROKER_CODES.ERR_BROKER_CANCELLED, circuit: 'none', reason: 'cancelled_after_send' };
      case TRANSPORT_FAILURES.NETWORK:
        // 已发送但没拿到应答：无法证明提供方没处理，只能按 unknown 保留债务。
        return { code: BROKER_CODES.ERR_BROKER_UNKNOWN, circuit: 'retryable', reason: 'transport_unknown' };
      case TRANSPORT_FAILURES.OVERSIZE:
        return { code: BROKER_CODES.ERR_BROKER_PROVIDER, circuit: 'retryable', reason: 'response_oversize' };
      case TRANSPORT_FAILURES.MALFORMED:
        return { code: BROKER_CODES.ERR_BROKER_PROVIDER, circuit: 'retryable', reason: 'response_malformed' };
      case TRANSPORT_FAILURES.STATUS: {
        const status = Number(error.details?.status);
        if (status >= 300 && status < 400) {
          // ADR-0010 §2.2：3xx 一律失败，不跟随、不换端点重试。这里保留 UNKNOWN 的
          // 对外错误码（我们无法证明提供方在重定向前是否已处理正文，债务按上界保留），
          // 但归因写成 redirect_refused，让运维能区分"被重定向"与"连接断了"。
          return { code: BROKER_CODES.ERR_BROKER_UNKNOWN, circuit: 'retryable', reason: 'redirect_refused' };
        }
        if (status === 401 || status === 403) {
          return { code: BROKER_CODES.ERR_BROKER_PROVIDER, circuit: 'fatal', reason: 'provider_auth' };
        }
        if (status === 429) {
          return { code: BROKER_CODES.ERR_BROKER_PROVIDER, circuit: 'fatal', reason: 'provider_quota' };
        }
        if (status >= 500) {
          return { code: BROKER_CODES.ERR_BROKER_PROVIDER, circuit: 'retryable', reason: 'provider_server' };
        }
        return { code: BROKER_CODES.ERR_BROKER_PROVIDER, circuit: 'none', reason: 'provider_client' };
      }
      default:
        return { code: BROKER_CODES.ERR_BROKER_UNKNOWN, circuit: 'retryable', reason: 'transport_unknown' };
    }
  }
  if (error instanceof BrokerError && error.code === BROKER_CODES.ERR_BROKER_CREDENTIAL) {
    return { code: BROKER_CODES.ERR_BROKER_CREDENTIAL, circuit: 'fatal', reason: 'credential_missing' };
  }
  // 未知异常一律按"结果不可证明"处理，宁可多扣不可少扣。
  return { code: BROKER_CODES.ERR_BROKER_UNKNOWN, circuit: 'retryable', reason: 'transport_unknown' };
}

/**
 * @param {{
 *   budgetPort: object,
 *   resolveIdentity: (input: {intent: object, options?: object}) => {analysis_id: string, attempt_id?: string|null},
 *   endpoint?: string|object,
 *   endpointUrl?: string,
 *   registry?: object,
 *   providerId?: string,
 *   modelId?: string,
 *   model?: string,
 *   credential?: object|null,
 *   credentials?: Record<string, object>,
 *   transport?: object,
 *   fetchImpl?: Function,
 *   allowInsecureLoopback?: boolean,
 *   limits?: object,
 *   timeoutMs?: number,
 *   now?: () => number,
 *   logger?: { emit: Function },
 *   circuitStatePort?: { load: Function, save: Function } | null,
 *   providerBudgetPort?: object,
 *   escalationLedger?: object,
 * }} options
 */
export function createModelBroker(options = {}) {
  const limits = resolveLimits(options.limits);
  const budgetPort = assertBudgetPort(options.budgetPort);
  // 身份来源必须显式提供：默认"相信请求体"等于没有身份边界（设计 §8.2 第 3 条）。
  if (typeof options.resolveIdentity !== 'function') {
    throw new BrokerError(
      BROKER_CODES.ERR_BROKER_ROUTE,
      'createModelBroker requires resolveIdentity() derived from the single-use worker token',
    );
  }
  const resolveIdentity = options.resolveIdentity;
  const route = resolveBrokerRoute(options);
  const endpoint = route.endpoint;
  // 凭据按 provider 归属：注册表入口优先取该 provider 的槽，缺省才回落到单一凭据。
  const credential = options.credential !== undefined
    ? options.credential
    : (options.credentials?.[route.providerId] ?? null);
  const transport = options.transport ?? createHttpTransport({
    endpoint,
    credential,
    fetchImpl: options.fetchImpl,
    limits,
  });
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const logger = options.logger ?? NULL_LOGGER;
  // ---- 每端点日预算（ADR §2.1 / §2.5 第 5 条）-------------------------------
  // 声明了预算就必须能执行：没有端口时**拒绝启动**，而不是"记下了但不拦"。
  // 这是审查 P1-1 的核心要求——"接受但不生效"比"拒绝"危险得多。
  const providerBudget = options.providerBudgetPort === undefined || options.providerBudgetPort === null
    ? null
    : assertProviderBudgetPort(options.providerBudgetPort);
  const declaresProviderBudget = endpoint.dailyInputTokens !== null || endpoint.dailyOutputTokens !== null;
  if (declaresProviderBudget && providerBudget === null) {
    throw new BrokerError(
      BROKER_CODES.ERR_BROKER_ADAPTER,
      'provider declares a daily token budget but no providerBudgetPort was supplied',
      { reason: 'provider_budget_port_missing', provider_id: route.providerId },
    );
  }
  if (providerBudget !== null) {
    if (typeof route.providerId !== 'string' || route.providerId === '') {
      throw new BrokerError(
        BROKER_CODES.ERR_BROKER_ADAPTER,
        'provider budget port requires a registered provider id',
        { reason: 'provider_budget_port_missing', provider_id: null },
      );
    }
    providerBudget.register(route.providerId, {
      dailyInputTokens: endpoint.dailyInputTokens,
      dailyOutputTokens: endpoint.dailyOutputTokens,
    });
  }
  // ---- 升级账本（ADR §2.5 第 3、4 条的唯一生产者）----------------------------
  // 缺省给一个进程内账本：没有生产者时，冷却与小时上限就是摆设（审查 P1-6）。
  const escalationLedger = options.escalationLedger === undefined || options.escalationLedger === null
    ? createEscalationLedger({ now })
    : assertEscalationLedger(options.escalationLedger);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, limits.defaultTimeoutMs)
    : limits.defaultTimeoutMs;
  const circuitStatePort = options.circuitStatePort ?? null;
  const queue = new RequestQueue({ maxConcurrent: limits.maxConcurrentRequests, maxDepth: limits.maxQueueDepth });

  const circuit = {
    state: CIRCUIT_CLOSED,
    openedAt: 0,
    consecutiveRetryable: 0,
    probeInFlight: false,
    /** 每次 open 递增：让"在途成功"无法关掉"别人刚打开的"熔断。 */
    generation: 0,
  };

  // 熔断状态必须能跨进程重启保留（设计 §9.2）。这里不做持久化本身，
  // 只提供端口：生产由服务层注入 store/文件，测试注入内存对象。
  if (circuitStatePort !== null && typeof circuitStatePort?.load === 'function') {
    try {
      const snapshot = circuitStatePort.load();
      if (snapshot !== null && typeof snapshot === 'object') {
        if ([CIRCUIT_CLOSED, CIRCUIT_OPEN, CIRCUIT_HALF_OPEN].includes(snapshot.state)) {
          circuit.state = snapshot.state;
        }
        // 快照字段必须逐个校验：一个"未来时间"的 opened_at 会让熔断永久打开，
        // 一个负的 consecutive_retryable 会让阈值永远达不到（fail-open）。
        const openedAt = snapshot.opened_at;
        if (Number.isFinite(openedAt) && openedAt >= 0 && openedAt <= now()) {
          circuit.openedAt = openedAt;
        }
        const consecutive = snapshot.consecutive_retryable;
        if (Number.isInteger(consecutive) && consecutive >= 0
          && consecutive <= CIRCUIT_POLICY.retryableFailureThreshold) {
          circuit.consecutiveRetryable = consecutive;
        }
        // 外部快照说"open"但拿不到可信的 opened_at：按"刚打开"处理，
        // 这会把 openMs 重新计满（宁可多等 15 分钟，也不要拿未来时间永久锁死）。
        if (circuit.state === CIRCUIT_OPEN && circuit.openedAt === 0) {
          circuit.openedAt = now();
        }
        if (circuit.state !== CIRCUIT_CLOSED) circuit.generation += 1;
      }
    } catch {
      // 读不回来就按"未打开"启动是危险的，但比启动失败更安全：
      // 记事件让运维可见，且后续鉴权失败会立刻重新打开。
      emit('circuit.restore_failed', {});
    }
  }

  const inFlightPerAnalysis = new Map();

  /**
   * R5-005：同一 fingerprint 的升级请求准入串行化。
   *
   * 冷却判据在调用方（`selectRoute`）读 `recent`，而账本写入在"已 markSent 之后"——
   * 两个并发请求会在账本仍为空时同时通过判据，把冷却窗口放大成 maxConcurrentRequests 次。
   * 这里在**预扣之前**用同步的 in-flight 集合把同一 fingerprint 的升级串起来：
   * 后来的那个直接拒绝（fail-closed，宁可少升级，不可多花钱）。占位在请求终态释放。
   */
  const inFlightEscalations = new Set();

  function claimEscalation(routing) {
    if (routing.escalated_from === null || routing.escalated_from === undefined) return null;
    const fingerprint = routing.fingerprint;
    if (inFlightEscalations.has(fingerprint)) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_ROUTE, 'a concurrent escalation for the same fingerprint is in flight', {
        reason: 'escalation_in_flight',
        fingerprint: String(fingerprint).slice(0, 128),
      });
    }
    inFlightEscalations.add(fingerprint);
    return () => {
      inFlightEscalations.delete(fingerprint);
    };
  }

  const stats = {
    requests: 0,
    reserved: 0,
    settled: 0,
    settled_at_upper_bound: 0,
    rejected: 0,
    timed_out: 0,
    cancelled: 0,
    provider_errors: 0,
    unknown_outcome: 0,
    settlement_discrepancies: 0,
    voided: 0,
    queue_timeouts: 0,
    unsettled: 0,
    provider_budget_rejections: 0,
  };

  function emit(event, details) {
    try {
      logger.emit(Object.freeze({ event, at: now(), ...details }));
    } catch {
      // 日志本身不该成为失败路径：管道断了不能改变请求结论。
    }
  }

  function persistCircuit() {
    if (circuitStatePort === null || typeof circuitStatePort?.save !== 'function') return;
    try {
      circuitStatePort.save(Object.freeze({
        state: circuit.state,
        opened_at: circuit.openedAt,
        consecutive_retryable: circuit.consecutiveRetryable,
      }));
    } catch {
      // 持久化失败不阻断请求（否则一个磁盘问题会停掉整个模型面），但必须可见。
      emit('circuit.persist_failed', { state: circuit.state });
    }
  }

  function openCircuit(reason) {
    circuit.state = CIRCUIT_OPEN;
    circuit.openedAt = now();
    circuit.generation += 1;
    emit('circuit.opened', { reason, consecutive_retryable: circuit.consecutiveRetryable });
    persistCircuit();
  }

  /**
   * 熔断门。返回的 finish 必须被调用一次（幂等），否则半开名额会被永久占住。
   *
   * `success` 只在"本次 attempt 启动之后没有别人打开过熔断"时才关闭电路：
   * 否则一个 401 打开的熔断会被同时飞行的 200 顺手关掉，坏凭据就会一直被使用。
   * `none` = 与提供方健康无关的失败（客户端取消、4xx 客户端错误、预算拒绝）。
   */
  function beginCircuitAttempt() {
    if (circuit.state === CIRCUIT_OPEN) {
      if (now() - circuit.openedAt >= CIRCUIT_POLICY.openMs) {
        circuit.state = CIRCUIT_HALF_OPEN;
        emit('circuit.half_open', {});
      } else {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN, 'model circuit is open', {
          opened_ms_ago: now() - circuit.openedAt,
        });
      }
    }
    const halfOpen = circuit.state === CIRCUIT_HALF_OPEN;
    if (halfOpen) {
      if (circuit.probeInFlight) {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN, 'model circuit half-open probe is in flight');
      }
      circuit.probeInFlight = true;
    }
    const startGeneration = circuit.generation;
    let finished = false;
    return {
      claimedProbe: halfOpen,
      finish(kind) {
        if (finished) return;
        finished = true;
        // 先释放探针名额：无论结局如何，这次尝试都不再占用半开通道。
        if (halfOpen) circuit.probeInFlight = false;
        // 本次尝试期间熔断被别人打开、或被管理员重置过：这次的结果不再有权改变状态。
        // 否则"清熔断"会被一个 reset 之前启动的在途失败立刻推翻。
        if (circuit.generation !== startGeneration) return;
        if (kind === 'success') {
          circuit.state = CIRCUIT_CLOSED;
          circuit.consecutiveRetryable = 0;
          persistCircuit();
          return;
        }
        if (kind === 'fatal') {
          circuit.consecutiveRetryable += 1;
          openCircuit('fatal_provider_failure');
          return;
        }
        if (kind === 'retryable') {
          circuit.consecutiveRetryable += 1;
          if (halfOpen || circuit.consecutiveRetryable >= CIRCUIT_POLICY.retryableFailureThreshold) {
            openCircuit('retryable_failure_threshold');
          } else {
            // 连续失败计数也必须落盘：否则重启即清零，"连续 5 次"永远打不开。
            persistCircuit();
          }
          return;
        }
        // kind === 'none'：与提供方健康无关，不改变计数。
        if (circuit.state === CIRCUIT_CLOSED) persistCircuit();
      },
    };
  }

  function acquireAnalysisSlot(analysisId) {
    const limit = limits.maxInFlightPerAnalysis;
    const current = inFlightPerAnalysis.get(analysisId) ?? 0;
    if (current >= limit) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'analysis already has a request in flight', {
        reason: 'analysis_in_flight',
        analysis_id: analysisId,
        limit,
      });
    }
    inFlightPerAnalysis.set(analysisId, current + 1);
  }

  function releaseAnalysisSlot(analysisId) {
    const current = inFlightPerAnalysis.get(analysisId) ?? 0;
    if (current <= 1) inFlightPerAnalysis.delete(analysisId);
    else inFlightPerAnalysis.set(analysisId, current - 1);
  }

  /**
   * 释放端点预留（只在"能证明没发出去"时调用）。
   *
   * 端点账失败不改变请求结论：全局账本才是权威，端点账是附加上限。
   * 但**必须可见**——否则"端点额度慢慢漏光"会变成无法解释的拒绝。
   */
  function voidProviderReservation(requestId, reason) {
    if (providerBudget === null) return;
    try {
      providerBudget.voidReservation({ request_id: requestId, provedNotSent: true });
    } catch (error) {
      emit('provider_budget.void_failed', {
        request_id: requestId,
        reason,
        code: asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'provider void failed').code,
      });
    }
  }

  /** 端点预留按上界结清（结果未知 / 结算失败时的保守处理）。 */
  function settleProviderAtUpperBound(requestId, reason) {
    if (providerBudget === null) return;
    try {
      providerBudget.settleUnknownAtUpperBound({ request_id: requestId });
    } catch (error) {
      // 结不清也不能假装结清：端点账停在 reserved，只会让后续请求更保守（fail-closed）。
      emit('provider_budget.settle_failed', {
        request_id: requestId,
        reason,
        code: asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'provider settle failed').code,
      });
    }
  }

  /**
   * 按请求的 token 结算端点账。
   *
   * 失败只记录不抛：全局账本此时已经结算成功，把请求标成失败会与真实结果矛盾。
   * 端点账的偏差由 `provider_budget.settle_failed` 事件暴露给运维。
   */
  function settleProvider(requestId, usage) {
    if (providerBudget === null) return;
    try {
      providerBudget.settle({ request_id: requestId, usage });
    } catch (error) {
      emit('provider_budget.settle_failed', {
        request_id: requestId,
        reason: 'settle_rejected',
        code: asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'provider settle failed').code,
      });
    }
  }

  /**
   * 记一笔升级（ADR §2.5 第 3、4 条的输入）。
   *
   * 时机是"已 markSent、尚未 send"：只有真正要发出去的升级才算发生过。
   * 用 broker 自己的时钟（`now`），而不是账本的默认时钟——否则判据与账本会活在两个时区里。
   */
  function recordEscalation(routing) {
    if (routing.escalated_from === null) return;
    try {
      escalationLedger.record(routing.fingerprint, now());
    } catch (error) {
      emit('escalation.record_failed', {
        code: asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'escalation record failed').code,
      });
    }
  }

  /**
   * 预扣之后、发送之后的失败收尾：**只保留债务，不放额度**。
   *
   * 这是整个 broker 最容易被"优化"错的地方：取消/超时/500 看起来都像
   * "没成功所以该退款"，但请求已经出去了，退款等于允许无限免费重发。
   *
   * @returns {boolean} 债务是否已经落到"按上界结清"。false 表示账本停在
   *   unknown/sent，需要人工核对——调用方不得再宣称 settled。
   */
  function holdDebt(requestId, reason) {
    // 端点账先结：全局账本有两条失败分支（下方 catch 会提前 return），
    // 把端点结算放在最后会让"结不清全局"的那条路径把端点预留永久占住。
    settleProviderAtUpperBound(requestId, reason);
    try {
      budgetPort.markUnknown({ request_id: requestId, reason });
    } catch (error) {
      // 状态已经不是 reserved/sent（例如并发结算），仍然继续尝试结清。
      emit('debt.mark_unknown_failed', {
        request_id: requestId,
        code: asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'markUnknown failed').code,
      });
    }
    try {
      budgetPort.settleUnknownAtUpperBound({ request_id: requestId });
    } catch (error) {
      // 结不清也不能假装结清：账本留 unknown，管理员可见，后续核对处理。
      emit('debt.settle_failed', {
        request_id: requestId,
        code: asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'settleUnknownAtUpperBound failed').code,
      });
      return false;
    }
    stats.settled_at_upper_bound += 1;
    return true;
  }

  async function execute(payload, identity, signal, attempt, routing) {
    const { analysisId, attemptId } = identity;

    // 排队期间熔断可能已经打开，或有别的请求抢到了半开探针；预扣前再检查一次：
    // 判定必须发生在"花钱之前"。自己就是这个探针时（claimedProbe）放行。
    if (circuit.state === CIRCUIT_OPEN) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN, 'model circuit opened while the request was queued');
    }
    if (circuit.state === CIRCUIT_HALF_OPEN && circuit.probeInFlight && attempt.claimedProbe !== true) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN, 'model circuit half-open probe is in flight');
    }
    // 排队期间被取消：此时还没预扣，直接零成本结束。
    if (signal?.aborted) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_CANCELLED, 'request cancelled before reservation');
    }
    // 排队期间注册可能被注销/替换：同样必须在预扣之前失败，且零网络。
    assertEndpointActive(endpoint);

    acquireAnalysisSlot(analysisId);
    try {
      const preview = readPreview(budgetPort, analysisId);

      if (preview.requests_used >= limits.maxRequestsPerAnalysis) {
        stats.rejected += 1;
        throw new BrokerError(BROKER_CODES.ERR_BROKER_BUDGET, 'per-analysis request cap reached (broker side)', {
          reason: 'requests',
          requests_used: preview.requests_used,
          limit: limits.maxRequestsPerAnalysis,
        });
      }
      if (preview.requests_remaining < 1) {
        stats.rejected += 1;
        throw new BrokerError(BROKER_CODES.ERR_BROKER_BUDGET, 'per-analysis request budget is exhausted', {
          reason: 'requests',
          requests_used: preview.requests_used,
        });
      }
      const outputLimit = Math.min(
        preview.analysis_output_remaining,
        preview.daily_output_remaining,
        limits.maxOutputTokens,
      );
      if (!Number.isInteger(outputLimit) || outputLimit < 1) {
        stats.rejected += 1;
        throw new BrokerError(BROKER_CODES.ERR_BROKER_BUDGET, 'no output budget remains for this request', {
          reason: 'output',
          remaining: Math.max(0, outputLimit),
        });
      }

      // 定稿最终报文：摘要与 64KiB 上限都按真正要发出去的字符串判定。
      const wire = finalizeOutbound(payload, { model: route.model, maxTokens: outputLimit, limits });
      const inputUpper = estimateInputUpper(wire.body, payload.messages.length);

      /**
       * 结算日志（ADR §4-10 的唯一口径来源）。
       *
       * 账本按上界结清就报上界，结不清就报 **null** —— 报 0 会让"没结清"看起来像"没花钱"，
       * 而 §4-10 要求用量页与日志逐条求和 ±0：只要有一条已落账的请求没写 token，
       * 两边就永远对不上。所以"发送成功但 usage 不可用""发送后断连""预扣后适配器违约"
       * 三条路径都必须走这里，不能只在成功路径写。
       */
      const emitSettled = (requestId, settled, latencyMs) => {
        emit('request.settled', {
          request_id: requestId,
          provider_id: route.providerId,
          model_id: route.model,
          usage_source: settled ? 'upper_bound' : 'unsettled',
          input_tokens: settled ? inputUpper : null,
          output_tokens: settled ? outputLimit : null,
          latency_ms: latencyMs,
          tier: routing.tier,
          fingerprint: routing.fingerprint,
          decision: routing.decision,
          escalated_from: routing.escalated_from,
        });
      };

      if (preview.analysis_input_remaining < inputUpper) {
        stats.rejected += 1;
        throw new BrokerError(BROKER_CODES.ERR_BROKER_BUDGET, 'per-analysis input budget is insufficient', {
          reason: 'analysis_input',
          remaining: preview.analysis_input_remaining,
          requested: inputUpper,
        });
      }
      if (preview.daily_input_remaining < inputUpper) {
        stats.rejected += 1;
        throw new BrokerError(BROKER_CODES.ERR_BROKER_BUDGET, 'daily input budget is insufficient', {
          reason: 'daily_input',
          remaining: preview.daily_input_remaining,
          requested: inputUpper,
        });
      }

      // ---- 端点日预算准入：仍在"花钱之前"，失败即零网络、零全局账本行 ----
      // 顺序上先于全局预扣：端点拒绝是最便宜的那条路径，不需要补偿一次全局预留。
      const requestId = uuid();
      if (providerBudget !== null) {
        try {
          providerBudget.reserve({
            provider_id: route.providerId,
            request_id: requestId,
            input_upper: inputUpper,
            output_limit: outputLimit,
          });
        } catch (error) {
          stats.rejected += 1;
          stats.provider_budget_rejections += 1;
          const mapped = asBrokerError(error, BROKER_CODES.ERR_BROKER_BUDGET, 'provider budget reservation was rejected');
          emit('request.rejected', {
            stage: 'provider_reserve',
            code: mapped.code,
            reason: mapped.details?.reason ?? null,
            provider_id: route.providerId,
          });
          throw mapped;
        }
      }

      // ---- 原子预扣：此行的成功与否是唯一准入结论，之后才有网络动作 ----
      let reservation;
      try {
        reservation = budgetPort.reserve({
          analysis_id: analysisId,
          attempt_id: attemptId,
          request_id: requestId,
          serialized_digest: wire.digest,
          input_upper: inputUpper,
          output_limit: outputLimit,
        });
      } catch (error) {
        // 全局拒绝 → 端点预留必须原样退回（它还没变成已花）。
        voidProviderReservation(requestId, 'global_reserve_rejected');
        stats.rejected += 1;
        const mapped = asBrokerError(error, BROKER_CODES.ERR_BROKER_BUDGET, 'budget reservation was rejected');
        emit('request.rejected', { stage: 'reserve', code: mapped.code, reason: mapped.details?.store_code ?? null });
        throw mapped;
      }
      stats.reserved += 1;

      if (reservation === null || typeof reservation !== 'object' || !Number.isInteger(reservation.request_seq)) {
        // 预扣成功了但适配器没给出序号：账本已经记账，只能按已发送处理，避免"记了账却当没发生"。
        // 这条路径同样要把结算数字写进日志：账本已经按上界落账，日志不报就再也对不上。
        emitSettled(requestId, holdDebt(requestId, 'adapter_contract_violation'), 0);
        throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'budget reservation returned no request_seq');
      }

      // 预留之后、发送之前：唯一还能"证明未发送"的窗口。
      if (signal?.aborted) {
        try {
          budgetPort.voidReservation({ request_id: requestId, provedNotSent: true });
          stats.voided += 1;
        } catch (error) {
          emit('request.void_failed', {
            request_id: requestId,
            code: asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'void failed').code,
          });
        }
        voidProviderReservation(requestId, 'cancelled_before_send');
        stats.cancelled += 1;
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CANCELLED, 'request cancelled before send', {
          request_id: requestId,
        });
      }

      try {
        budgetPort.markSent({ request_id: requestId });
      } catch (error) {
        // 连 sent 都标不上：证明尚未发送，退回预留是正确的（不是"放额度给别人花"）。
        try {
          budgetPort.voidReservation({ request_id: requestId, provedNotSent: true });
          stats.voided += 1;
        } catch (voidError) {
          emit('request.void_failed', {
            request_id: requestId,
            code: asBrokerError(voidError, BROKER_CODES.ERR_BROKER_ADAPTER, 'void failed').code,
          });
        }
        voidProviderReservation(requestId, 'mark_sent_failed');
        throw asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'could not mark the request as sent');
      }

      // ---- 从这里开始：任何失败都必须保留债务，不存在 void ----
      // 升级账本在"已 markSent、尚未 send"写入：这就是"升级请求发出前"的落点。
      recordEscalation(routing);
      emit('request.sent', {
        request_id: requestId,
        analysis_id: analysisId,
        request_seq: reservation.request_seq,
        provider_id: route.providerId,
        model_id: route.model,
        // ADR-0010 §2.7：按请求记录必须带 tier / fingerprint / decision / escalatedFrom。
        tier: routing.tier,
        fingerprint: routing.fingerprint,
        decision: routing.decision,
        escalated_from: routing.escalated_from,
        input_upper: inputUpper,
        output_limit: outputLimit,
        redactions: payload.redactions.length,
      });

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      // 不 unref：这次请求必须被超时推进到终态，timer 是它唯一的兜底。
      const composite = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

      const startedAt = now();
      let response;
      try {
        response = await transport.send({ body: wire.body, signal: composite, requestId });
      } catch (error) {
        clearTimeout(timer);
        const failure = classifyTransportFailure(error, { timedOut });
        // 已发送但失败：账本会按上界保留债务（settleUnknownAtUpperBound），日志必须报同一个数字，
        // 否则 §4-10 的「用量页 = 日志逐条求和 ±0」在任何一次断连/超时之后都不成立。
        const settled = holdDebt(requestId, failure.reason);
        attempt.finish(failure.circuit);
        if (failure.code === BROKER_CODES.ERR_BROKER_TIMEOUT) stats.timed_out += 1;
        if (failure.code === BROKER_CODES.ERR_BROKER_CANCELLED) stats.cancelled += 1;
        if (failure.code === BROKER_CODES.ERR_BROKER_UNKNOWN) stats.unknown_outcome += 1;
        if (failure.code === BROKER_CODES.ERR_BROKER_PROVIDER) stats.provider_errors += 1;
        emit('request.failed', {
          request_id: requestId,
          code: failure.code,
          reason: failure.reason,
          tier: routing.tier,
          fingerprint: routing.fingerprint,
          decision: routing.decision,
          escalated_from: routing.escalated_from,
        });
        // 失败也是"这笔钱已经落账"：结算事件紧随失败事件，字段与成功路径完全一致。
        emitSettled(requestId, settled, now() - startedAt);
        throw asBrokerError(error, failure.code, 'model request failed after send', {
          request_id: requestId,
          reason: failure.reason,
        });
      }
      clearTimeout(timer);

      const latencyMs = now() - startedAt;

      // usage 不可用或不可信：非空请求报告的输入 token 为 0 说明用量没被真实统计，
      // 按上界保守结清（AT-TOKEN-004：缺失/异常 usage 保守扣款）。
      const usageUnusable = response.usage === null || response.usage.input_tokens < 1;
      if (usageUnusable) {
        const settled = holdDebt(requestId, response.usage === null ? 'usage_missing' : 'usage_implausible');
        attempt.finish('success');
        if (settled) stats.settled += 1;
        else stats.unsettled += 1;
        emitSettled(requestId, settled, latencyMs);
        return Object.freeze({
          request_id: requestId,
          request_seq: reservation.request_seq,
          analysis_id: analysisId,
          attempt_id: attemptId,
          // 结不清时不允许宣称 settled：账本停在 unknown，需人工核对。
          state: settled ? 'settled' : 'unsettled',
          content: response.content,
          // 只有真正按上界结清时才报上界用量；否则报 null，避免"报了个数却没落账"。
          usage: settled ? Object.freeze({ input_tokens: inputUpper, output_tokens: outputLimit }) : null,
          usage_source: settled ? 'upper_bound' : 'unsettled',
          serialized_digest: wire.digest,
          redactions: payload.redactions,
          latency_ms: latencyMs,
          discrepancy: null,
        });
      }

      // 提供方报告的用量超过我们预留的上界：结算差异必须可见，并立即停止后续请求。
      const overInput = response.usage.input_tokens > inputUpper;
      const overOutput = response.usage.output_tokens > outputLimit;
      let discrepancy = null;
      try {
        budgetPort.settle({ request_id: requestId, usage: response.usage });
        settleProvider(requestId, response.usage);
        stats.settled += 1;
      } catch (error) {
        // 结算失败不能释放债务。把行标成 unknown 让它在核对视图里可见，
        // 而不是永久停在 sent；这是本地存储故障，不该算进提供方健康计数。
        try {
          budgetPort.markUnknown({ request_id: requestId, reason: 'settle_failed' });
        } catch {
          // 连 unknown 都写不上：账本保持原状，债务仍然占着额度。
        }
        attempt.finish('none');
        emit('settle.failed', {
          request_id: requestId,
          code: asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'settle failed').code,
        });
        throw asBrokerError(error, BROKER_CODES.ERR_BROKER_ADAPTER, 'provider usage could not be settled');
      }

      if (overInput || overOutput) {
        discrepancy = Object.freeze({
          input_tokens_over: overInput ? response.usage.input_tokens - inputUpper : 0,
          output_tokens_over: overOutput ? response.usage.output_tokens - outputLimit : 0,
        });
        stats.settlement_discrepancies += 1;
        attempt.finish('fatal');
        emit('settle.discrepancy', { request_id: requestId });
      } else {
        attempt.finish('success');
      }

      emit('request.settled', {
        request_id: requestId,
        provider_id: route.providerId,
        model_id: route.model,
        usage_source: 'provider',
        // ADR §2.7 / §4-10：真实 token 数必须落进日志，用量页才能与账本逐条对账。
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        latency_ms: latencyMs,
        discrepancy: discrepancy !== null,
        tier: routing.tier,
        fingerprint: routing.fingerprint,
        decision: routing.decision,
        escalated_from: routing.escalated_from,
      });

      return Object.freeze({
        request_id: requestId,
        request_seq: reservation.request_seq,
        analysis_id: analysisId,
        attempt_id: attemptId,
        state: 'settled',
        content: response.content,
        usage: response.usage,
        usage_source: 'provider',
        serialized_digest: wire.digest,
        redactions: payload.redactions,
        latency_ms: latencyMs,
        discrepancy,
      });
    } finally {
      releaseAnalysisSlot(analysisId);
    }
  }

  return Object.freeze({
    endpoint,

    /**
     * 升级账本（ADR §2.5 第 3、4 条的**生产者**）。
     *
     * daemon 组装 `selectRoute` 入参时应当读它：
     * `recent: broker.escalationLedger.recent(now, { windowMs: cooldownSeconds * 1000 })`。
     * 把它暴露出来而不是"内部记账"，是为了让"冷却到底有没有生效"可被测试与排查。
     */
    escalationLedger,

    /**
     * 本实例锁定的路由（构造期定死，运行期只读）。
     *
     * 故意只给 `{scheme, host, port, pathPrefix}` 与 id：不给完整 URL 之外的可变入口，
     * 也不含凭据。
     */
    route: Object.freeze({
      providerId: route.providerId,
      modelId: route.model,
      scheme: endpoint.scheme,
      host: endpoint.host,
      port: endpoint.port,
      pathPrefix: endpoint.pathPrefix,
    }),

    async request(intent, requestOptions = {}) {
      const signal = requestOptions?.signal;
      stats.requests += 1;
      // 0. 路由决策先校验：它是日志契约的一部分，畸形值不该走到预扣、更不该出网。
      //    （未知的选项键仍然被忽略 —— RT-1 要求"请求期任何 URL 覆盖都无效"。）
      let routing;
      try {
        routing = readRoutingDecision(requestOptions?.routing);
      } catch (error) {
        stats.rejected += 1;
        throw error;
      }
      // 1. 出域检查最先做：不合规的 DTO 不占队列、不预扣、不出网。
      let payload;
      try {
        payload = buildOutboundPayload(intent, { limits });
      } catch (error) {
        stats.rejected += 1;
        throw error;
      }
      // 2. 身份来自已认证通道，请求体只能被核对、不能被采信。
      let identity;
      try {
        let derived;
        try {
          derived = resolveIdentity({ intent, options: requestOptions });
        } catch (error) {
          throw asBrokerError(error, BROKER_CODES.ERR_BROKER_ROUTE, 'identity resolution failed');
        }
        identity = readIdentity(derived, intent);
        assertModelRoute(payload, route.model);
        // 3. 端点活性：注册被注销/替换后，同一 brand 的请求必须在这里失败——
        //    不能靠"对象还在内存里"继续往旧主机发凭据（ADR §3.1 阴性用例 1、2）。
        assertEndpointActive(endpoint);
      } catch (error) {
        stats.rejected += 1;
        throw error;
      }
      // 4. 凭据门：没有凭据就没有"要不要发"的问题。
      if (credential === null) {
        stats.rejected += 1;
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'provider credential is not configured');
      }
      let attempt;
      try {
        attempt = beginCircuitAttempt();
      } catch (error) {
        stats.rejected += 1;
        throw error;
      }
      let release;
      try {
        release = await queue.acquire({ signal, timeoutMs: limits.queueTimeoutMs });
      } catch (error) {
        attempt.finish('none');
        stats.rejected += 1;
        if (error instanceof BrokerError && error.code === BROKER_CODES.ERR_BROKER_TIMEOUT) stats.queue_timeouts += 1;
        throw error;
      }
      try {
        // R5-005：升级准入门在预扣之前同步占位。execute() 的首个 await 在发送处，
        // 因此这里的"检查 + 占位"对并发请求是原子的：第二个同 fingerprint 的升级
        // 在这里就失败，不会进入预算/网络路径。
        const releaseEscalation = claimEscalation(routing);
        try {
          return await execute(payload, identity, signal, attempt, routing);
        } finally {
          if (releaseEscalation !== null) releaseEscalation();
        }
      } catch (error) {
        // 预算/队列/取消等"未出网"的失败不应影响熔断计数（finish 幂等）。
        attempt.finish('none');
        throw error;
      } finally {
        release();
      }
    },

    stats() {
      return Object.freeze({
        ...stats,
        queue_active: queue.active,
        queue_waiting: queue.waiting,
        in_flight_analyses: inFlightPerAnalysis.size,
      });
    },

    circuit() {
      return Object.freeze({
        state: circuit.state,
        consecutive_retryable: circuit.consecutiveRetryable,
        opened_at: circuit.openedAt === 0 ? null : circuit.openedAt,
        half_open_in_flight: circuit.probeInFlight,
        persistent: circuitStatePort !== null && typeof circuitStatePort?.save === 'function',
      });
    },

    /** 管理员动作：清熔断。Agent 无权限，只暴露给运维入口。 */
    resetCircuit() {
      circuit.state = CIRCUIT_CLOSED;
      circuit.openedAt = 0;
      circuit.consecutiveRetryable = 0;
      circuit.probeInFlight = false;
      circuit.generation += 1;
      persistCircuit();
      return this.circuit();
    },
  });
}

export { BROKER_LIMITS };
