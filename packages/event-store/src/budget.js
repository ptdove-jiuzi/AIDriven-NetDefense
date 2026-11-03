/**
 * T2 预算预扣与模型请求账本。
 *
 * 余额公式（设计 §9.1 第 4 条）：
 *
 *     settled_actual + Σ(reserved/sent/unknown 的上界) + 新上界 <= 预算
 *
 * 关键是 **Σ 不按 epoch 过滤**：恢复后旧 epoch 的 reserved/sent 已经原子转成
 * `unknown`，如果按 epoch 过滤就等于"恢复即免单"，债务会凭空消失。
 *
 * 迁移只允许：
 *   reserved → sent → settled
 *   reserved/sent → unknown（无法证明未发送）
 *   reserved → void（仅在**证明未发送**时）
 * `unknown` 是终态的一种：不允许自动回到 sent，也不允许被自动重试。
 */

import { STORE_CODES, StoreError } from './errors.js';
import { AUDIT_ACTIONS, appendAudit } from './audit.js';
import { msFromIso, sha256Hex, utcDayOf, uuid } from './util.js';

export const DEFAULT_BUDGET_POLICY = Object.freeze({
  perAnalysisInputTokens: 12000,
  perAnalysisOutputTokens: 2000,
  perAnalysisRequests: 3,
  dailyInputTokens: 30000,
  dailyOutputTokens: 6000,
});

const INFLIGHT_STATES = "('reserved','sent','unknown')";

/** 容量临界时上层会写 `capability_state='blocked'`；准入点必须真的读它，否则降级只是装饰。 */
export function assertAnalysisCapabilityOpen(store) {
  const row = store.get('SELECT state FROM capability_state WHERE capability = ?', ['analysis']);
  if (row !== null && String(row.state) === 'blocked') {
    throw new StoreError(
      STORE_CODES.ERR_CAPACITY_CRITICAL,
      'analysis capability is blocked by the capacity policy',
      { capability: 'analysis' },
    );
  }
}

function resolvePolicy(store, override) {
  const base = override ?? store.budgetPolicy ?? DEFAULT_BUDGET_POLICY;
  const policy = { ...DEFAULT_BUDGET_POLICY, ...base };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `budget policy ${key} must be a non-negative integer`);
    }
  }
  if (policy.perAnalysisRequests < 1) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'perAnalysisRequests must be at least 1');
  }
  return policy;
}

function queryRow(store, sql, params) {
  const row = store.get(sql, params);
  return row === null ? { input: 0, output: 0 } : { input: Number(row.input ?? 0), output: Number(row.output ?? 0) };
}

/**
 * 时间可信性检查。
 *
 * 三种情况一律拒绝新请求并等待管理员登记（不自动"修正"高水位）：
 * - `meta.time_uncertain = 1`；
 * - 当前 UTC 早于持久高水位（回拨）；
 * - UTC 日桶比持久日桶更早（跨日回退）。
 */
/** wall 与单调时钟允许的最大偏差：超过它说明系统时间被调整过或发生休眠唤醒。 */
export const MAX_CLOCK_SKEW_MS = 300000;

function assertMonoCoherent(store, now) {
  if (store.monoMs === null) return;
  const openWall = Number(store.getMeta('open_wall_ms'));
  const openMono = Number(store.getMeta('open_mono_ms'));
  if (!Number.isFinite(openWall) || !Number.isFinite(openMono)) return;
  const wallDelta = msFromIso(now) - openWall;
  const monoDelta = store.monoMs() - openMono;
  if (Math.abs(wallDelta - monoDelta) > MAX_CLOCK_SKEW_MS) {
    throw new StoreError(
      STORE_CODES.ERR_BUDGET_TIME_UNTRUSTED,
      'wall clock and monotonic clock diverge by more than 5 minutes',
      { wall_delta_ms: wallDelta, mono_delta_ms: monoDelta },
    );
  }
}

/**
 * wall/mono 一致性**对所有路径**都检查。
 *
 * 早期版本只在"调用方没传 now"时检查，结果留下一个真实绕过：
 * 只要永远显式传一个未来的 now，单调校验就被跳过，前跳一天即可重置日预算。
 * 显式传 now 的合法场景（回放、测试）必须让注入时钟同步前进——那正是
 * `clock.advance()` 的语义；只有 wall 单独跳变才应当被拒。
 */
function assertTimeTrusted(store, now, day) {
  if (store.getMeta('time_uncertain') === '1') {
    throw new StoreError(STORE_CODES.ERR_BUDGET_TIME_UNTRUSTED, 'time is marked uncertain; new requests are blocked');
  }
  assertMonoCoherent(store, now);
  const lastTrusted = store.getMeta('last_trusted_utc');
  if (lastTrusted !== null && msFromIso(now) < msFromIso(lastTrusted)) {
    throw new StoreError(
      STORE_CODES.ERR_BUDGET_TIME_UNTRUSTED,
      'current UTC is earlier than the persisted high watermark',
      { now, last_trusted_utc: lastTrusted },
    );
  }
  const lastDay = store.getMeta('last_utc_day');
  if (lastDay !== null && day < lastDay) {
    throw new StoreError(
      STORE_CODES.ERR_BUDGET_TIME_UNTRUSTED,
      'UTC day moved backwards',
      { day, last_utc_day: lastDay },
    );
  }
}

function advanceWatermarks(store, now, day) {
  const lastTrusted = store.getMeta('last_trusted_utc');
  if (lastTrusted === null || msFromIso(now) > msFromIso(lastTrusted)) {
    store.setMeta('last_trusted_utc', now);
  }
  const lastDay = store.getMeta('last_utc_day');
  if (lastDay === null || day > lastDay) {
    store.setMeta('last_utc_day', day);
  }
}

/**
 * T2：为一次真实 provider 请求原子预占预算。
 *
 * @param {object} store
 * @param {{
 *   analysis_id: string,
 *   attempt_id?: string|null,
 *   request_id?: string,
 *   serialized_digest: string,
 *   input_upper: number,
 *   output_limit: number,
 *   now?: string,
 *   policy?: object,
 *   actorId?: string,
 * }} input
 * @returns {{ request_id: string, request_seq: number, epoch: string, utc_day: string, state: 'reserved', remaining: object }}
 */
export function reserveModelRequest(store, input) {
  store.assertWritable('reserveModelRequest');
  if (input === null || typeof input !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'reserveModelRequest requires an input object');
  }
  const analysisId = input.analysis_id;
  if (typeof analysisId !== 'string' || analysisId.length === 0) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'analysis_id is required');
  }
  const inputUpper = input.input_upper;
  const outputLimit = input.output_limit;
  if (!Number.isInteger(inputUpper) || inputUpper < 1) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'input_upper must be a positive integer');
  }
  if (!Number.isInteger(outputLimit) || outputLimit < 1) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'output_limit must be a positive integer');
  }

  return store.tx('T2', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const day = utcDayOf(now);
    const policy = resolvePolicy(store, input.policy);

    assertTimeTrusted(store, now, day);

    const analysis = store.get('SELECT analysis_id, epoch FROM analysis_outbox WHERE analysis_id = ?', [analysisId]);
    if (analysis === null) {
      throw new StoreError(STORE_CODES.ERR_ANALYSIS_NOT_FOUND, `unknown analysis ${analysisId}`, { analysis_id: analysisId });
    }
    if (String(analysis.epoch) !== store.epoch()) {
      throw new StoreError(STORE_CODES.ERR_EPOCH_MISMATCH, 'analysis epoch does not match the current epoch', {
        analysis_epoch: String(analysis.epoch),
        current: store.epoch(),
      });
    }
    assertAnalysisCapabilityOpen(store);

    const seqRow = store.get(
      'SELECT MAX(request_seq) AS seq FROM model_request_ledger WHERE analysis_id = ?',
      [analysisId],
    );
    const requestSeq = (seqRow === null || seqRow.seq === null ? 0 : Number(seqRow.seq)) + 1;
    if (requestSeq > policy.perAnalysisRequests) {
      throw new StoreError(
        STORE_CODES.ERR_BUDGET_EXCEEDED,
        `analysis ${analysisId} already used ${policy.perAnalysisRequests} requests`,
        { analysis_id: analysisId, request_seq: requestSeq, limit: policy.perAnalysisRequests },
      );
    }

    const analysisInflight = queryRow(
      store,
      `SELECT COALESCE(SUM(input_upper), 0) AS input, COALESCE(SUM(output_limit), 0) AS output
         FROM model_request_ledger WHERE analysis_id = ? AND state IN ${INFLIGHT_STATES}`,
      [analysisId],
    );
    const analysisSettled = queryRow(
      store,
      `SELECT COALESCE(SUM(settled_input), 0) AS input, COALESCE(SUM(settled_output), 0) AS output
         FROM model_request_ledger WHERE analysis_id = ? AND state = 'settled'`,
      [analysisId],
    );
    if (analysisSettled.input + analysisInflight.input + inputUpper > policy.perAnalysisInputTokens) {
      throw new StoreError(
        STORE_CODES.ERR_BUDGET_EXCEEDED,
        'per-analysis input budget would be exceeded',
        {
          analysis_id: analysisId,
          used: analysisSettled.input + analysisInflight.input,
          requested: inputUpper,
          limit: policy.perAnalysisInputTokens,
        },
      );
    }
    if (analysisSettled.output + analysisInflight.output + outputLimit > policy.perAnalysisOutputTokens) {
      throw new StoreError(
        STORE_CODES.ERR_BUDGET_EXCEEDED,
        'per-analysis output budget would be exceeded',
        {
          analysis_id: analysisId,
          used: analysisSettled.output + analysisInflight.output,
          requested: outputLimit,
          limit: policy.perAnalysisOutputTokens,
        },
      );
    }

    // 跨 epoch 汇总：故意不加 epoch 条件。
    const dailyInflight = queryRow(
      store,
      `SELECT COALESCE(SUM(input_upper), 0) AS input, COALESCE(SUM(output_limit), 0) AS output
         FROM model_request_ledger WHERE utc_day = ? AND state IN ${INFLIGHT_STATES}`,
      [day],
    );
    const dailySettled = queryRow(
      store,
      `SELECT COALESCE(SUM(settled_input), 0) AS input, COALESCE(SUM(settled_output), 0) AS output
         FROM model_request_ledger WHERE utc_day = ? AND state = 'settled'`,
      [day],
    );
    if (dailySettled.input + dailyInflight.input + inputUpper > policy.dailyInputTokens) {
      throw new StoreError(
        STORE_CODES.ERR_BUDGET_EXCEEDED,
        'daily input budget would be exceeded',
        {
          utc_day: day,
          settled: dailySettled.input,
          inflight: dailyInflight.input,
          requested: inputUpper,
          limit: policy.dailyInputTokens,
        },
      );
    }
    if (dailySettled.output + dailyInflight.output + outputLimit > policy.dailyOutputTokens) {
      throw new StoreError(
        STORE_CODES.ERR_BUDGET_EXCEEDED,
        'daily output budget would be exceeded',
        {
          utc_day: day,
          settled: dailySettled.output,
          inflight: dailyInflight.output,
          requested: outputLimit,
          limit: policy.dailyOutputTokens,
        },
      );
    }

    const requestId = typeof input.request_id === 'string' && input.request_id.length > 0 ? input.request_id : uuid();
    const epoch = store.epoch();
    store.run(
      `INSERT INTO model_request_ledger (
         request_id, analysis_id, attempt_id, request_seq, serialized_digest, input_upper, output_limit,
         reserved_at, reserved_at_ms, state, settled_input, settled_output, unknown_reason, epoch, utc_day, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, NULL, ?, ?, ?)`,
      [
        requestId,
        analysisId,
        input.attempt_id ?? null,
        requestSeq,
        String(input.serialized_digest),
        inputUpper,
        outputLimit,
        now,
        msFromIso(now),
        epoch,
        day,
        now,
      ],
    );
    advanceWatermarks(store, now, day);

    appendAudit(store, {
      action: AUDIT_ACTIONS.BUDGET_RESERVE,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? 'aegis-broker',
      objectDigest: String(input.serialized_digest),
      payload: { request_id: requestId, analysis_id: analysisId, request_seq: requestSeq, input_upper: inputUpper, output_limit: outputLimit },
      timestamp: now,
    });

    return Object.freeze({
      request_id: requestId,
      request_seq: requestSeq,
      epoch,
      utc_day: day,
      state: 'reserved',
      remaining: Object.freeze({
        daily_input: policy.dailyInputTokens - (dailySettled.input + dailyInflight.input + inputUpper),
        daily_output: policy.dailyOutputTokens - (dailySettled.output + dailyInflight.output + outputLimit),
        analysis_input: policy.perAnalysisInputTokens - (analysisSettled.input + analysisInflight.input + inputUpper),
        analysis_output: policy.perAnalysisOutputTokens - (analysisSettled.output + analysisInflight.output + outputLimit),
      }),
    });
  });
}

function loadRequest(store, requestId) {
  const row = store.get('SELECT * FROM model_request_ledger WHERE request_id = ?', [requestId]);
  if (row === null) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `unknown model request ${requestId}`, { request_id: requestId });
  }
  return row;
}

/**
 * 预占 → 发送。只有 `reserved` 能前进。
 *
 * 对 `unknown` 调用本函数**必定失败**：这是"未证明未执行时禁止自动重试"的
 * 代码级落点——任何重试路径都必须先经过这里，绕不过去。
 */
export function markModelRequestSent(store, input) {
  store.assertWritable('markModelRequestSent');
  return store.tx('T2-sent', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadRequest(store, input.request_id);
    const state = String(row.state);
    if (state === 'sent') {
      return Object.freeze({ request_id: String(row.request_id), state, duplicate: true });
    }
    if (state === 'unknown') {
      throw new StoreError(
        STORE_CODES.ERR_RETRY_NOT_PROVEN,
        'request outcome is unknown; automatic retry is forbidden',
        { request_id: input.request_id },
      );
    }
    if (state !== 'reserved') {
      throw new StoreError(STORE_CODES.ERR_REQUEST_STATE, `cannot send a ${state} request`, {
        request_id: input.request_id,
        state,
      });
    }
    store.run(
      "UPDATE model_request_ledger SET state = 'sent', updated_at = ? WHERE request_id = ? AND state = 'reserved'",
      [now, input.request_id],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.BUDGET_TRANSITION,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? 'aegis-broker',
      objectDigest: String(row.serialized_digest),
      payload: { request_id: input.request_id, from: 'reserved', to: 'sent' },
      timestamp: now,
    });
    return Object.freeze({ request_id: String(row.request_id), state: 'sent', duplicate: false });
  });
}

/**
 * 结算：`reserved|sent|unknown → settled`。
 *
 * `unknown` 走到 `settled` 是合法的（人工核对/提供方查询后的结论），
 * 但必须携带 usage；缺 usage 时**不允许**编造 0，只能按上界结算。
 */
export function settleModelRequest(store, input) {
  store.assertWritable('settleModelRequest');
  return store.tx('T2-settle', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadRequest(store, input.request_id);
    const state = String(row.state);
    if (state === 'settled') {
      return Object.freeze({
        request_id: String(row.request_id),
        state,
        duplicate: true,
        usage: Object.freeze({ input_tokens: Number(row.settled_input), output_tokens: Number(row.settled_output) }),
      });
    }
    if (state === 'void') {
      throw new StoreError(STORE_CODES.ERR_REQUEST_STATE, 'a void request cannot be settled', {
        request_id: input.request_id,
      });
    }
    if (state === 'reserved') {
      // 从未发送的预占不能"结算"：结算会给它一个实际用量，等于凭空释放额度。
      // 合法出路只有 voidModelRequest（带未发送证明）或 markModelRequestUnknown。
      throw new StoreError(
        STORE_CODES.ERR_REQUEST_STATE,
        'a reserved request was never sent; prove it with voidModelRequest or mark it unknown',
        { request_id: input.request_id, state },
      );
    }
    const usage = input.usage;
    // 提供方用量证据（自由文本，最小长度门槛；结构校验属于 broker）。
    const evidence = typeof input.providerEvidence === 'string' ? input.providerEvidence.trim() : '';
    if (usage === null || typeof usage !== 'object'
      || !Number.isInteger(usage.input_tokens) || usage.input_tokens < 0
      || !Number.isInteger(usage.output_tokens) || usage.output_tokens < 0) {
      throw new StoreError(
        STORE_CODES.ERR_STORE_INPUT,
        'settling requires usage with non-negative integer input_tokens/output_tokens',
      );
    }
    if (state === 'unknown') {
      // 结果未知的请求只能"按上界保守结清"，除非提供方给了可核对的用量证据。
      const upper = { input_tokens: Number(row.input_upper), output_tokens: Number(row.output_limit) };
      const exactUpper = usage.input_tokens === upper.input_tokens && usage.output_tokens === upper.output_tokens;
      if (!exactUpper && evidence.length < 16) {
        throw new StoreError(
          STORE_CODES.ERR_REQUEST_STATE,
          'an unknown request may only settle at the upper bound unless providerEvidence is supplied',
          { request_id: input.request_id, upper, actual: usage },
        );
      }
    }
    store.run(
      `UPDATE model_request_ledger
          SET state = 'settled', settled_input = ?, settled_output = ?, updated_at = ?
        WHERE request_id = ? AND state IN ('sent','unknown')`,
      [usage.input_tokens, usage.output_tokens, now, input.request_id],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.BUDGET_TRANSITION,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? 'aegis-broker',
      objectDigest: String(row.serialized_digest),
      payload: {
        request_id: input.request_id,
        from: state,
        to: 'settled',
        usage,
        provider_evidence: evidence.length >= 16 ? sha256Hex(evidence) : null,
      },
      timestamp: now,
    });
    return Object.freeze({
      request_id: String(row.request_id),
      state: 'settled',
      duplicate: false,
      usage: Object.freeze({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }),
    });
  });
}

/** `reserved|sent → unknown`：结果不确定，按上界占用预算，等待核对。 */
export function markModelRequestUnknown(store, input) {
  store.assertWritable('markModelRequestUnknown');
  return store.tx('T2-unknown', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadRequest(store, input.request_id);
    const state = String(row.state);
    if (state === 'unknown') {
      return Object.freeze({ request_id: String(row.request_id), state, duplicate: true });
    }
    if (state !== 'reserved' && state !== 'sent') {
      throw new StoreError(STORE_CODES.ERR_REQUEST_STATE, `cannot mark a ${state} request unknown`, {
        request_id: input.request_id,
        state,
      });
    }
    store.run(
      `UPDATE model_request_ledger
          SET state = 'unknown', unknown_reason = ?, updated_at = ?
        WHERE request_id = ? AND state IN ('reserved','sent')`,
      [input.reason ?? 'outcome_unverifiable', now, input.request_id],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.BUDGET_TRANSITION,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? 'aegis-broker',
      objectDigest: String(row.serialized_digest),
      payload: { request_id: input.request_id, from: state, to: 'unknown' },
      timestamp: now,
    });
    return Object.freeze({ request_id: String(row.request_id), state: 'unknown', duplicate: false });
  });
}

/**
 * `reserved → void`：仅当**已证明未发送**。
 *
 * `provedNotSent !== true` 一律拒绝。没有这个布尔量就只有两种结局：
 * 按上界结算，或转 unknown 等待核对——不存在"先退了再说"。
 */
export function voidModelRequest(store, input) {
  store.assertWritable('voidModelRequest');
  if (input === null || typeof input !== 'object' || input.provedNotSent !== true) {
    throw new StoreError(
      STORE_CODES.ERR_RETRY_NOT_PROVEN,
      'voiding a reservation requires provedNotSent === true',
      { request_id: input && input.request_id ? input.request_id : null },
    );
  }
  return store.tx('T2-void', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const row = loadRequest(store, input.request_id);
    const state = String(row.state);
    if (state === 'void') {
      return Object.freeze({ request_id: String(row.request_id), state, duplicate: true });
    }
    if (state !== 'reserved') {
      throw new StoreError(
        STORE_CODES.ERR_RETRY_NOT_PROVEN,
        `only a reserved request can be voided; current state is ${state}`,
        { request_id: input.request_id, state },
      );
    }
    store.run("UPDATE model_request_ledger SET state = 'void', updated_at = ? WHERE request_id = ? AND state = 'reserved'", [
      now,
      input.request_id,
    ]);
    appendAudit(store, {
      action: AUDIT_ACTIONS.BUDGET_TRANSITION,
      actorType: input.actorType ?? 'broker',
      actorId: input.actorId ?? 'aegis-broker',
      objectDigest: String(row.serialized_digest),
      payload: { request_id: input.request_id, from: 'reserved', to: 'void' },
      timestamp: now,
    });
    return Object.freeze({ request_id: String(row.request_id), state: 'void', duplicate: false });
  });
}

/** 无 usage 的未知请求按上界结算（保守扣款），而不是释放额度。 */
export function settleUnknownAtUpperBound(store, input) {
  const row = loadRequest(store, input.request_id);
  if (String(row.state) !== 'unknown') {
    throw new StoreError(STORE_CODES.ERR_REQUEST_STATE, 'only unknown requests settle at upper bound', {
      request_id: input.request_id,
      state: String(row.state),
    });
  }
  return settleModelRequest(store, {
    request_id: input.request_id,
    usage: { input_tokens: Number(row.input_upper), output_tokens: Number(row.output_limit) },
    now: input.now,
    actorType: input.actorType,
    actorId: input.actorId,
  });
}

/** 账本视图：给 T2 以外的调用方核对"今天还能不能发"。 */
export function summarizeBudget(store, options = {}) {
  const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
  const day = utcDayOf(now);
  const policy = resolvePolicy(store, options.policy);
  const inflight = queryRow(
    store,
    `SELECT COALESCE(SUM(input_upper), 0) AS input, COALESCE(SUM(output_limit), 0) AS output
       FROM model_request_ledger WHERE utc_day = ? AND state IN ${INFLIGHT_STATES}`,
    [day],
  );
  const settled = queryRow(
    store,
    `SELECT COALESCE(SUM(settled_input), 0) AS input, COALESCE(SUM(settled_output), 0) AS output
       FROM model_request_ledger WHERE utc_day = ? AND state = 'settled'`,
    [day],
  );
  const byEpoch = [];
  for (const row of store.all(
    `SELECT epoch, state, COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN state = 'settled' THEN settled_input ELSE input_upper END), 0) AS input_upper
       FROM model_request_ledger
      WHERE utc_day = ? AND state IN ${INFLIGHT_STATES}
      GROUP BY epoch, state ORDER BY epoch`,
    [day],
  )) {
    byEpoch.push(Object.freeze({
      epoch: String(row.epoch),
      state: String(row.state),
      requests: Number(row.requests),
      input_upper: Number(row.input_upper),
    }));
  }
  return Object.freeze({
    utc_day: day,
    policy,
    daily: Object.freeze({
      settled_input: settled.input,
      settled_output: settled.output,
      inflight_input: inflight.input,
      inflight_output: inflight.output,
      remaining_input: policy.dailyInputTokens - settled.input - inflight.input,
      remaining_output: policy.dailyOutputTokens - settled.output - inflight.output,
    }),
    by_epoch: Object.freeze(byEpoch),
  });
}

/**
 * 恢复 epoch 切换（设计 §7.3）。
 *
 * `reserved`/`sent` 一律原子转 `unknown`：恢复之后无法证明它们是否已经发出，
 * 于是既不能释放额度，也不能重发。财务债务跨 epoch 保留。
 */
export function rotateEpoch(store, options = {}) {
  store.assertWritable('rotateEpoch');
  return store.tx('T2-epoch', () => {
    const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
    const previous = store.epoch();
    const next = typeof options.epoch === 'string' && options.epoch.length > 0 ? options.epoch : uuid();
    if (next === previous) {
      throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'new epoch must differ from the current epoch');
    }
    const demoted = store.run(
      `UPDATE model_request_ledger
          SET state = 'unknown', unknown_reason = COALESCE(unknown_reason, 'epoch_rotated'), updated_at = ?
        WHERE state IN ('reserved','sent')`,
      [now],
    );
    store.setMeta('epoch', next);
    store.setMeta('epoch_rotated_at', now);
    appendAudit(store, {
      action: AUDIT_ACTIONS.EPOCH_ROTATE,
      actorType: options.actorType ?? 'daemon',
      actorId: options.actorId ?? 'aegis-core',
      objectDigest: sha256Hex(String(previous)),
      payload: { from: previous, to: next, demoted_to_unknown: Number(demoted.changes) },
      timestamp: now,
    });
    return Object.freeze({ previous, epoch: next, demoted_to_unknown: Number(demoted.changes) });
  });
}

export function listRequests(store, options = {}) {
  const where = [];
  const params = [];
  if (typeof options.analysis_id === 'string') {
    where.push('analysis_id = ?');
    params.push(options.analysis_id);
  }
  if (typeof options.state === 'string') {
    where.push('state = ?');
    params.push(options.state);
  }
  const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  return store.all(`SELECT * FROM model_request_ledger${clause} ORDER BY reserved_at_ms, request_seq`, params);
}
