/**
 * 有界并发队列。
 *
 * 为什么需要它而不是直接并发发请求：
 * - 设计 §9.1 限制"最多 2 个分析并发"，这个限制必须在**预扣之前**生效，
 *   否则并发额度靠预留去挤，等于把准入变成竞速；
 * - 队列本身有界（设计 §12：有界排队后停止新分析），满了就明确拒绝，
 *   不无限堆 Promise；
 * - 排队必须有时间上界：单请求的墙钟上限如果只覆盖"发送"阶段，
 *   排队可以无限长，"90 秒内完成或放弃"就成了一句空话。
 *
 * 取消语义：排队期间被取消或超时 → 直接出队、**不预扣、不发请求**，
 * 这是唯一可以"零成本"结束的阶段。一旦预扣成功，取消就必须走 unknown。
 */

import { BrokerError, BROKER_CODES } from './errors.js';

export class RequestQueue {
  #limit;

  #maxDepth;

  #active = 0;

  #waiters = [];

  constructor(options = {}) {
    const limit = options.maxConcurrent;
    const maxDepth = options.maxDepth;
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('maxConcurrent must be >= 1');
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError('maxDepth must be >= 0');
    this.#limit = limit;
    this.#maxDepth = maxDepth;
  }

  get active() {
    return this.#active;
  }

  get waiting() {
    return this.#waiters.length;
  }

  /**
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<() => void>} 释放函数（幂等）。
   */
  acquire(options = {}) {
    const { signal } = options;
    const timeoutMs = options.timeoutMs;
    if (signal?.aborted) {
      return Promise.reject(new BrokerError(BROKER_CODES.ERR_BROKER_CANCELLED, 'request cancelled before admission'));
    }
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.#makeRelease());
    }
    if (this.#waiters.length >= this.#maxDepth) {
      return Promise.reject(new BrokerError(BROKER_CODES.ERR_BROKER_QUEUE_FULL, 'model request queue is full', {
        waiting: this.#waiters.length,
        max_depth: this.#maxDepth,
      }));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null, timer: null, detach: null };
      const detach = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        if (waiter.timer !== null) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        if (waiter.onAbort !== null && signal) {
          signal.removeEventListener('abort', waiter.onAbort);
          waiter.onAbort = null;
        }
      };
      waiter.detach = detach;
      if (signal) {
        waiter.onAbort = () => {
          detach();
          reject(new BrokerError(BROKER_CODES.ERR_BROKER_CANCELLED, 'request cancelled while queued'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          detach();
          reject(new BrokerError(BROKER_CODES.ERR_BROKER_TIMEOUT, 'request timed out while queued', {
            queue_timeout_ms: timeoutMs,
          }));
        }, timeoutMs);
        // 刻意**不** unref：排队中的请求只有这个 timer 能把它推进到终态。
        // unref 之后一旦没有其它活跃 handle，Promise 就永远不会 settle。
      }
      this.#waiters.push(waiter);
    });
  }

  #makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#drain();
    };
  }

  #drain() {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#active -= 1;
      return;
    }
    waiter.detach();
    // 直接把名额转交，`#active` 不变：避免"先减后加"之间被新请求插队。
    waiter.resolve(this.#makeRelease());
  }
}
