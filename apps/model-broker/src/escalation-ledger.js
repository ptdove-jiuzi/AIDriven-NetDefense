/**
 * 升级账本（ADR-0010 §2.5 第 3、4 条的唯一生产者）。
 *
 * 为什么单独一个模块：`selectRoute` 是纯函数，冷却与小时上限只能读调用方给的 `recent`。
 * 审查 P1-6 的事实是——**全仓没有任何模块写入"某 fingerprint 何时升级过"**，于是两条判据
 * 接上 daemon 后必然恒不生效（`recent` 永远是 `[]`）。判据本身没错，缺的是生产者。
 *
 * 生产者放在 broker 而不是 daemon，是因为只有 broker 知道"这次请求**真的发出去了**"：
 * 在 `markSent` 成功之后、`transport.send` 之前记一笔，符合"升级请求发出前写入"的口径，
 * 并且天然保守——发失败也算发生过，宁可少升级，不可多花钱。
 *
 * 读取方（daemon 组 `selectRoute` 入参时）应当这样用：
 *
 *   recent: broker.escalationLedger.recent(now, { windowMs: cooldownSeconds * 1000 })
 *
 * `windowMs` 用于覆盖"冷却时间 > 1 小时"的配置：1 小时窗口查不到 90 分钟前的升级记录，
 * 冷却判据就会失效。窗口取 `max(1h, windowMs)`，永远不会小于 ADR 的小时上限口径。
 */

import fs from 'node:fs';
import path from 'node:path';

import { BrokerError, BROKER_CODES } from './errors.js';

/** 1 小时（ADR §2.5 第 4 条窗口）。 */
export const ESCALATION_WINDOW_MS = 60 * 60 * 1000;

/** 指纹的字符集：只允许可安全写入单行日志的字符（挡住换行注入）。 */
const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function ledgerError(message, details) {
  return new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, message, { reason: 'escalation_ledger_invalid', ...details });
}

/**
 * 校验外部注入的账本形状（跨进程共享同一份账本时由 daemon 注入）。
 *
 * @param {unknown} ledger 候选账本。
 * @returns {object} 原账本。
 */
export function assertEscalationLedger(ledger) {
  if (ledger === null || typeof ledger !== 'object'
    || typeof ledger.record !== 'function'
    || typeof ledger.recent !== 'function') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ADAPTER, 'escalation ledger must implement record() and recent()', {
      reason: 'escalation_ledger_invalid',
    });
  }
  return ledger;
}

/**
 * 进程内升级账本。
 *
 * 容量有界：`maxEntries` 之外的旧记录被丢弃（先丢最旧）。丢记录只会让限流**更松**一点点，
 * 所以上限取得比"一小时可能发生的升级次数"大得多（默认 1024，而 ADR 的小时上限是 20）。
 *
 * @param {{ now?: () => number, maxEntries?: number, windowMs?: number }} [options]
 */
export function createEscalationLedger(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries >= 1 ? options.maxEntries : 1024;
  const defaultWindow = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : ESCALATION_WINDOW_MS;

  /** @type {{fingerprint: string, at: number}[]} 按写入顺序（升序） */
  const entries = [];

  /**
   * R5-010：可选的文件快照。不给 `filePath` 时行为与旧版一致（纯进程内）；
   * 返回值里的 `persistent:false` 是**明确降级声称**（重启即忘），不再是隐含事实。
   * 给了 `filePath` 时，每笔记录同步落盘、构造时恢复，重启后冷却/小时上限仍生效。
   */
  const filePath = typeof options.filePath === 'string' && options.filePath.trim() !== ''
    ? path.resolve(options.filePath.trim())
    : null;

  function loadSnapshot() {
    if (filePath === null) return;
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw ledgerError('escalation ledger snapshot could not be read', { step: 'load' });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 损坏的快照不能静默当成"没有升级过"（那会放开冷却）→ fail-closed。
      throw ledgerError('escalation ledger snapshot is not valid JSON', { step: 'load' });
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw ledgerError('escalation ledger snapshot has an unknown shape', { step: 'load' });
    }
    for (const entry of parsed.entries) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(entry.fingerprint)) continue;
      if (!Number.isFinite(entry.at)) continue;
      entries.push(Object.freeze({ fingerprint: entry.fingerprint, at: entry.at }));
    }
    entries.sort((left, right) => left.at - right.at);
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
  }

  function saveSnapshot() {
    if (filePath === null) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
    } catch {
      throw ledgerError('escalation ledger snapshot could not be written', { step: 'save' });
    }
  }

  loadSnapshot();

  return Object.freeze({
    /** R5-010：`persistent:false` = 重启即忘的明确降级声称；给了 filePath 才是 true。 */
    persistent: filePath !== null,
    storage: filePath === null ? 'memory' : 'file',

    get size() {
      return entries.length;
    },

    /**
     * 记一笔升级。`at` 默认取账本自己的时钟；broker 会显式传入**它自己的**时钟，
     * 避免"判据用注入时钟、账本用真实时钟"造成的复盘不一致。
     */
    record(fingerprint, at = now()) {
      if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
        throw ledgerError('fingerprint must be 1..128 characters of [A-Za-z0-9._:-]', {
          field: 'fingerprint',
        });
      }
      if (!Number.isFinite(at)) {
        throw ledgerError('escalation timestamp must be a finite epoch-millisecond number', { field: 'at' });
      }
      entries.push(Object.freeze({ fingerprint, at }));
      if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
      saveSnapshot();
      return entries.length;
    },

    /**
     * 取窗口内的升级历史（可直接作为 `selectRoute` 的 `recent`）。
     *
     * 未来时间戳同样计入（`at - entry.at` 为负必然小于窗口）——时钟回拨不能成为绕过限流的口子。
     */
    recent(at = now(), readOptions = {}) {
      const requested = Number.isFinite(readOptions.windowMs) && readOptions.windowMs > 0
        ? readOptions.windowMs
        : 0;
      const window = Math.max(ESCALATION_WINDOW_MS, defaultWindow, requested);
      const hit = [];
      for (const entry of entries) {
        if (at - entry.at < window) hit.push(entry);
      }
      hit.sort((left, right) => left.at - right.at);
      return Object.freeze(hit.map((entry) => Object.freeze({ fingerprint: entry.fingerprint, at: entry.at })));
    },
  });
}
