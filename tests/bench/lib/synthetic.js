/**
 * lib/synthetic.js — 合成负载。
 *
 * 原则：
 * 1. **契约合法**。负载要走真实的 `validateTelemetryEvent`，不能为了快而绕过校验——
 *    绕过之后测出来的吞吐不是生产路径的吞吐。
 * 2. **完全由种子决定**。同一 `(seed, label, count)` 必须生成逐字节相同的序列，
 *    这样才能用摘要（{@link workloadDigest}）证明两次运行跑的是同一批负载。
 * 3. **无害**。进程名、路径、用户都是保留字样的假数据（`example-*` / `synthetic-*`），
 *    不含任何真实主机、账号或日志内容。
 * 4. **两种事件形态分开**：event-store 用契约事件（snake_case 信封），detection 用
 *    引擎原生事件（camelCase + `fields` 嵌套）。混用会让"校验开销"落到错误的模块上。
 */

import { canonicalDigest, validateAlert, validateFinding } from '../../../packages/contracts/src/index.js';
import { createRng, deriveSeed } from './prng.js';

/** 合成负载里出现的进程名（都是假的）。 */
export const PROCESS_NAMES = Object.freeze([
  'example-shell.exe',
  'example-updater.exe',
  'example-agent.exe',
  'example-service.exe',
  'synthetic-runner.exe',
]);

/** 合成负载里出现的用户（都是假的）。 */
export const USER_NAMES = Object.freeze(['synthetic-user', 'example-operator', 'synthetic-service']);

const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

/**
 * 基准时钟：每次读取都前进固定步长。
 *
 * 为什么不用 `Date.now()`：T2 的 `assertTimeTrusted` 会比较 wall 与 mono 的偏移，
 * 真实时钟在长跑里会被 NTP 调整，导致偶发 `ERR_BUDGET_TIME_UNTRUSTED`——
 * 那是环境噪声，不是被测代码的问题。用一个 wall 与 mono 同步前进的确定性时钟，
 * 两个偏移恒等，基准结果可复现。
 *
 * 代价：时间戳与真实时间无关。T1/T2 都不依赖真实时间，故可接受；这一点写进报告。
 *
 * @param {{startIso?: string, stepMs?: number}} [options] 选项。
 * @returns {{nowIso: () => string, nowMs: () => number, monoMs: () => number,
 *   advance: (ms: number) => void, reads: () => number}} 时钟。
 */
export function createBenchClock(options = {}) {
  const startMs = options.startIso === undefined
    ? Date.UTC(2026, 10, 2, 0, 0, 0)
    : Date.parse(options.startIso);
  const stepMs = options.stepMs ?? 1;
  let wall = startMs;
  let mono = startMs;
  let reads = 0;
  const tick = () => {
    wall += stepMs;
    mono += stepMs;
    reads += 1;
    return wall;
  };
  return {
    nowIso: () => new Date(tick()).toISOString(),
    nowMs: () => tick(),
    monoMs: () => tick(),
    advance(ms) {
      wall += ms;
      mono += ms;
    },
    reads: () => reads,
  };
}

/**
 * 构造一个合成工作负载生成器。
 *
 * @param {{
 *   seed: number,
 *   label: string,
 *   payloadBytes?: number,
 *   baseIso?: string,
 *   withNativeRecordId?: boolean
 * }} options 选项。
 * @returns {{
 *   seed: number,
 *   rng: object,
 *   event: (index: number) => object,
 *   finding: (event: object, index: number, fingerprintSeed?: string) => object,
 *   alert: (event: object, index: number, fingerprintSeed?: string) => object,
 *   detectionEvent: (index: number) => object,
 *   batch: (startIndex: number, count: number) => object[]
 * }} 生成器。
 */
export function createWorkload(options) {
  const seed = options.seed;
  const rng = createRng(deriveSeed(seed, options.label));
  const baseMs = options.baseIso === undefined
    ? Date.UTC(2026, 10, 2, 0, 0, 0)
    : Date.parse(options.baseIso);
  const payloadBytes = options.payloadBytes ?? 220;
  const withNativeRecordId = options.withNativeRecordId !== false;
  // 固定实例 id：同一工作负载的所有事件来自同一个采集器实例，这是真实形态。
  const collectorInstanceId = rng.uuid();
  const bootId = rng.hex(32);
  const padding = 'x'.repeat(Math.max(0, payloadBytes));

  /**
   * 生成契约事件。
   *
   * `source_seq` 与 `event_id` 都由 index 派生，保证唯一且可重放；
   * `native_record_id` 也由 index 派生——它参与 `dedupe_key`，重复投递才会被判重。
   *
   * @param {number} index 全局序号。
   * @returns {object} 契约 TelemetryEvent 值。
   */
  function event(index) {
    const observedMs = baseMs + index;
    const payload = {
      process_name: PROCESS_NAMES[index % PROCESS_NAMES.length],
      user_name: USER_NAMES[index % USER_NAMES.length],
      pid: 1000 + (index % 30000),
      command_line: `${padding.slice(0, Math.min(padding.length, 160))}-${index}`,
    };
    const value = {
      schemaVersion: '1.0',
      event_id: deterministicUuid(index),
      stable_source_id: 'synthetic.process',
      collector_instance_id: collectorInstanceId,
      source_generation: 1,
      boot_id: bootId,
      source_seq: index,
      observed_at: new Date(observedMs).toISOString(),
      received_at: new Date(observedMs + 1).toISOString(),
      type: 'process.start',
      severity: SEVERITIES[index % SEVERITIES.length],
      payload,
      integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
    };
    if (withNativeRecordId) {
      value.native_record_id = `synthetic-record-${index}`;
    }
    return value;
  }

  /**
   * 生成契约 Finding。
   *
   * `fingerprintSeed` 相同 → 同一聚合行（走 UPDATE 路径）；
   * 不给 → 每次唯一（走 INSERT 路径）。两种路径的成本必须分开测。
   *
   * @param {object} owningEvent 归属事件。
   * @param {number} index 序号。
   * @param {string} [fingerprintSeed] 聚合键种子。
   * @returns {object} 契约 Finding 值。
   */
  function finding(owningEvent, index, fingerprintSeed) {
    return validateFinding({
      schemaVersion: '1.0',
      finding_id: deterministicUuid(index + 10_000_000),
      rule_id: 'synthetic.process-start',
      rule_version: '1.0.0',
      event_ids: [owningEvent.event_id],
      fingerprint: canonicalDigest({ fingerprint: fingerprintSeed ?? `f-${index}` }),
      severity: owningEvent.severity,
      status: 'new',
      first_seen: owningEvent.observed_at,
      last_seen: owningEvent.received_at,
      count: 1,
      evidence_refs: [],
    }).value;
  }

  /**
   * 生成契约 Alert。
   *
   * @param {object} owningEvent 归属事件。
   * @param {number} index 序号。
   * @param {string} [fingerprintSeed] 聚合键种子。
   * @returns {object} 契约 Alert 值。
   */
  function alert(owningEvent, index, fingerprintSeed) {
    const observedMs = Date.parse(owningEvent.observed_at);
    return validateAlert({
      schemaVersion: '1.0',
      alert_id: deterministicUuid(index + 20_000_000),
      rule_id: 'synthetic.process-start',
      rule_version: '1.0.0',
      fingerprint: canonicalDigest({ alert: fingerprintSeed ?? `a-${index}` }),
      severity: owningEvent.severity,
      status: 'new',
      first_seen: owningEvent.observed_at,
      last_seen: owningEvent.received_at,
      window_start: new Date(observedMs).toISOString(),
      window_end: new Date(observedMs + 900_000).toISOString(),
      count: 1,
      event_ids: [owningEvent.event_id],
      event_ids_truncated: false,
      evidence_refs: [],
    }).value;
  }

  /**
   * 生成 detection 引擎原生事件。
   *
   * @param {number} index 序号。
   * @returns {object} 引擎事件。
   */
  function detectionEvent(index) {
    return {
      eventId: `evt-${index}`,
      observedAt: baseMs + index,
      type: 'process_start',
      source: `10.0.${(index >> 8) % 250}.${index % 250}`,
      severity: SEVERITIES[index % SEVERITIES.length],
      fields: {
        process: {
          name: PROCESS_NAMES[index % PROCESS_NAMES.length],
          path: `/synthetic/example/${PROCESS_NAMES[index % PROCESS_NAMES.length]}`,
          parent: PROCESS_NAMES[(index + 1) % PROCESS_NAMES.length],
        },
        user: { name: USER_NAMES[index % USER_NAMES.length] },
        network: { remoteAddress: `192.0.2.${index % 250}` },
      },
    };
  }

  return {
    seed,
    rng,
    event,
    finding,
    alert,
    detectionEvent,
    batch(startIndex, count) {
      const output = new Array(count);
      for (let offset = 0; offset < count; offset += 1) {
        output[offset] = detectionEvent(startIndex + offset);
      }
      return output;
    },
  };
}

/**
 * 由序号派生确定性 UUIDv4。
 *
 * 不用 PRNG：序号 → id 必须是纯函数，这样"第 7 个事件的 id"在任何调用顺序下都一致，
 * 重放才能逐字节相同。
 *
 * @param {number} index 序号。
 * @returns {string} UUIDv4 形态字符串。
 */
function deterministicUuid(index) {
  const hex = (index >>> 0).toString(16).padStart(8, '0');
  // 必须用 Math.imul：`index * 常数` 在 index 上千万后会超出 2^53，尾数丢精度 → id 撞车。
  const tail = (Math.imul(index, 0x9e3779b1) >>> 0).toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${tail}0000`;
}

/**
 * 计算一组事件/对象的负载摘要。
 *
 * 用摘要而不是"看起来一样"来证明两次运行跑的是同一批负载：
 * 改了生成器而忘记升版本时，摘要会变，历史数字立刻失去可比性。
 *
 * @param {Array<object>} items 对象数组。
 * @param {number} [limit] 只取前 N 个（避免摘要本身成为瓶颈）。
 * @returns {{count: number, digest: string, sampled: number}} 摘要。
 */
export function workloadDigest(items, limit = 256) {
  const sampled = Math.min(items.length, limit);
  const digest = canonicalDigest(items.slice(0, sampled));
  return { count: items.length, digest, sampled };
}
