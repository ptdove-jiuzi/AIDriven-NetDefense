/**
 * lib/sampler.js — 资源采样。
 *
 * 纪律：
 * 1. **RSS 是唯一覆盖原生内存的指标**。`heapUsed` 只算 V8 堆；SQLite 的页缓存、
 *    WAL 映射、`node:sqlite` 的原生缓冲都不在里面。只看 heapUsed 会得出
 *    "内存零增长"的假结论，而进程实际上在涨。所以两组数都采，并写清语义。
 * 2. **采样本身要有成本上限**。采样间隔内做的查询必须是常数级（PRAGMA / COUNT），
 *    否则"观测"会变成被测负载的一部分。COUNT(*) 在大表上不是常数级——所以
 *    行数只在明确标注的阶段边界采，不在高频循环里采。
 * 3. **不强制 GC**。除非 `--expose-gc`，否则不调用 `global.gc()`；强行 GC 会把
 *    真实的持有引用掩盖掉。是否可用记在 `env.runtime.gc_exposed`。
 */

import { fileBytes } from './tempdir.js';

/** 行数统计用到的表（只读这些表，不触碰业务数据）。 */
const COUNTED_TABLES = Object.freeze(['telemetry_event', 'finding', 'alert', 'audit_event', 'analysis_outbox']);

/**
 * 当前进程内存快照，单位字节。
 *
 * @returns {{rss: number, heap_total: number, heap_used: number, external: number,
 *   array_buffers: number, t_ms: number}} 快照。
 */
export function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heap_total: usage.heapTotal,
    heap_used: usage.heapUsed,
    external: usage.external,
    array_buffers: usage.arrayBuffers ?? 0,
    t_ms: Date.now(),
  };
}

/**
 * event-store 的物理统计（不含 COUNT，开销常数级）。
 *
 * @param {object} store 已打开的 store 句柄。
 * @returns {object} `stats()` 结果，附加 WAL/SHM 的实测文件大小。
 */
export function storePhysicalStats(store) {
  const stats = store.stats();
  return {
    ...stats,
    wal_bytes_measured: fileBytes(`${stats.path}-wal`),
    shm_bytes_measured: fileBytes(`${stats.path}-shm`),
    db_bytes_measured: fileBytes(stats.path),
  };
}

/**
 * 表行数。
 *
 * 明确标注为"慢采样"：`COUNT(*)` 在 `telemetry_event` 上是全表扫描，
 * 十万行级别要几十毫秒。只在阶段边界调用。
 *
 * @param {object} store 已打开的 store 句柄。
 * @returns {Record<string, number>} 表名 → 行数。
 */
export function tableCounts(store) {
  const output = {};
  for (const table of COUNTED_TABLES) {
    try {
      const row = store.get(`SELECT COUNT(*) AS c FROM ${table}`);
      output[table] = row === null ? 0 : Number(row.c);
    } catch {
      output[table] = -1;
    }
  }
  return output;
}
