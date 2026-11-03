/**
 * 稳定来源键（stable dedupe key）的派生与只读存在性探测。
 *
 * 为什么单独成文件：T1 的判重键必须只有一处定义。此前派生写在 `ingest.js` 内部，
 * daemon 又在自己的适配器里抄了一份 —— 两份一旦漂移，"预过滤放行、T1 判重"就会
 * 各自为政（M5 P1 的根因，见 ADR-0006）。现在 T1 与探测接口都从这里取。
 *
 * ## 输出边界（ADR-0006 §2.2，硬约束）
 *
 * `hasDedupeKeys` **只能**返回布尔。不要在这里加"顺便返回命中行"的重载：
 * 本接口位于 daemon 每批热路径上，调用方不需要也不应拿到证据内容。
 * 要读事件只能走 `getEvent(eventId)`。
 */

import { STORE_CODES, StoreError } from './errors.js';

/**
 * 单次探测的 SQL 形状固定，靠句柄的 prepared-statement 缓存复用。
 *
 * 键数是每批事件数（daemon 默认 500，配置上限 100000），命中唯一索引
 * `(stable_source_id, source_generation, dedupe_key)` 的点查。
 * 成本与改造前"每事件一次 `hasEvent`"相当，不是新的全表扫描。
 */
const PROBE_SQL = `SELECT 1 AS present FROM telemetry_event
  WHERE stable_source_id = ? AND source_generation = ? AND dedupe_key = ?`;

const DEDUPE_KEY_PATTERN = /^(?:native:.+|seq:\d+)$/u;

/**
 * 从事件派生 `dedupe_key` 列的值。
 *
 * 规则与设计 §5.2 一致：**优先原生记录 ID**（日志行自带、跨重启稳定）；
 * 没有原生 ID 时退回 `source_seq`。代次变化（日志清空、record id 重用）
 * 必须由采集器递增 `source_generation`，存储层不猜。
 *
 * @param {{native_record_id?: unknown, source_seq?: unknown}} event 合同事件（只看两个字段）。
 * @returns {string} `native:<id>` 或 `seq:<n>`。
 */
export function dedupeKeyOf(event) {
  const native = event?.native_record_id;
  if (typeof native === 'string' && native.length > 0) {
    return `native:${native}`;
  }
  return `seq:${event?.source_seq}`;
}

/**
 * 派生根 `telemetry_event` 唯一索引的三元组。
 *
 * 返回冻结对象：调用方通常把它直接塞进批量查询，不希望有人中途改字段。
 *
 * @param {{stable_source_id?: unknown, source_generation?: unknown, native_record_id?: unknown, source_seq?: unknown}} event 合同事件。
 * @returns {{stable_source_id: string, source_generation: number, dedupe_key: string}} 稳定键。
 */
export function stableKeyOf(event) {
  return Object.freeze({
    stable_source_id: event?.stable_source_id,
    source_generation: event?.source_generation,
    dedupe_key: dedupeKeyOf(event),
  });
}

/**
 * 校验单个稳定键。只报位置与字段名，**不回显键值或事件内容**。
 *
 * @param {unknown} key 待校验的键。
 * @param {string} path 报错用的位置标记（`keys[3]`）。
 * @returns {{stable_source_id: string, source_generation: number, dedupe_key: string}} 规范化后的键。
 */
function assertStableKey(key, path) {
  if (key === null || typeof key !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'hasDedupeKeys expects stable key objects', {
      index: path,
      field: 'key',
    });
  }
  const { stable_source_id: sourceId, source_generation: generation, dedupe_key: dedupeKey } = key;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'stable key requires stable_source_id', {
      index: path,
      field: 'stable_source_id',
    });
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'stable key requires a non-negative integer source_generation', {
      index: path,
      field: 'source_generation',
    });
  }
  if (typeof dedupeKey !== 'string' || !DEDUPE_KEY_PATTERN.test(dedupeKey)) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'stable key requires a well-formed dedupe_key', {
      index: path,
      field: 'dedupe_key',
    });
  }
  return { stable_source_id: sourceId, source_generation: generation, dedupe_key: dedupeKey };
}

/**
 * 只读判定一批稳定键里哪些已经有行。
 *
 * 语义与 T1 的 `duplicateByDedupe` 查询**逐字一致**（同表、同三列、同一唯一索引），
 * 区别只是批量、且只回 0/1。调用方拿它做"写入前的预过滤"，最终判重仍由 T1 在事务内做。
 *
 * 只读句柄可用：不调用 `assertWritable`、不开事务、不写审计、不改任何行。
 *
 * @param {{get: (sql: string, params?: unknown[]) => object|null}} store 事件存储句柄。
 * @param {readonly {stable_source_id: string, source_generation: number, dedupe_key: string}[]} keys 稳定键数组。
 * @returns {readonly boolean[]} 与 `keys` 等长同序的布尔数组。
 */
export function hasDedupeKeys(store, keys) {
  if (store === null || typeof store !== 'object' || typeof store.get !== 'function') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'hasDedupeKeys requires a store handle');
  }
  if (!Array.isArray(keys)) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'hasDedupeKeys expects an array of stable keys');
  }
  if (keys.length === 0) {
    return Object.freeze([]);
  }
  const present = new Array(keys.length).fill(false);
  for (let index = 0; index < keys.length; index += 1) {
    const key = assertStableKey(keys[index], `keys[${index}]`);
    let row;
    try {
      row = store.get(PROBE_SQL, [key.stable_source_id, key.source_generation, key.dedupe_key]);
    } catch (error) {
      throw error instanceof StoreError ? error : new StoreError(
        STORE_CODES.ERR_STORE_SQL,
        'stable key probe failed',
        { reason: error?.code ?? 'PROBE_FAILED' },
      );
    }
    present[index] = row !== null && row !== undefined;
  }
  return Object.freeze(present);
}

/**
 * 校验一个 `dedupe_key` 字符串是否合法（供测试与外部对拍使用）。
 *
 * @param {unknown} value 待校验值。
 * @returns {boolean} 是否合法。
 */
export function isDedupeKey(value) {
  return typeof value === 'string' && DEDUPE_KEY_PATTERN.test(value);
}
