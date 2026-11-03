/**
 * lib/prng.js — 可复现的伪随机源。
 *
 * 纪律：
 * 1. **不用 `Math.random()`**。基准的负载必须能靠一个种子完整重放，否则
 *    "这次比上次慢" 无法区分是代码退化还是负载不同。
 * 2. **每个场景一条独立子流**。子流由 `deriveSeed(基准种子, 标签)` 生成，
 *    这样新增/删除一个场景不会改变其它场景的负载序列——否则一次无关的
 *    改动会让所有历史数字失去可比性。
 * 3. mulberry32 是 32 位状态，周期 2^32。单个场景的抽样量远小于这个数，
 *    够用；不要用它做密码学用途（这里也不需要）。
 */

/**
 * FNV-1a 32 位哈希，用于把标签字符串折成子种子。
 *
 * @param {string} text 标签。
 * @returns {number} 无符号 32 位整数。
 */
export function hashLabel(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 由基准种子与标签派生子种子。
 *
 * @param {number} seed 基准种子（正整数）。
 * @param {string} label 子流标签，例如 `event-store/t1`。
 * @returns {number} 子种子。
 */
export function deriveSeed(seed, label) {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new TypeError('deriveSeed: seed must be a non-negative integer');
  }
  // 先与种子混合再与标签哈希混合，避免不同种子下标签碰撞对齐。
  const mixed = (Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0) ^ hashLabel(label);
  const scrambled = Math.imul(mixed ^ (mixed >>> 16), 0xc2b2ae35) >>> 0;
  return (scrambled ^ (scrambled >>> 15)) >>> 0;
}

/**
 * 创建 mulberry32 伪随机流。
 *
 * @param {number} seed 种子。
 * @returns {{
 *   seed: number,
 *   next: () => number,
 *   int: (maxExclusive: number) => number,
 *   between: (minInclusive: number, maxInclusive: number) => number,
 *   pick: <T>(items: readonly T[]) => T,
 *   bool: (probability: number) => boolean,
 *   hex: (length: number) => string,
 *   uuid: () => string,
 *   shuffle: <T>(items: readonly T[]) => T[],
 *   take: () => number
 * }} 随机流。
 */
export function createRng(seed) {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new TypeError('createRng: seed must be a non-negative integer');
  }
  let state = seed >>> 0;
  let draws = 0;

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    draws += 1;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    seed,
    next,
    int(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
        throw new RangeError('rng.int: maxExclusive must be a positive integer');
      }
      return Math.floor(next() * maxExclusive);
    },
    between(minInclusive, maxInclusive) {
      return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
    },
    pick(items) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new RangeError('rng.pick: items must be a non-empty array');
      }
      return items[Math.floor(next() * items.length)];
    },
    bool(probability = 0.5) {
      return next() < probability;
    },
    hex(length) {
      let output = '';
      while (output.length < length) {
        output += Math.floor(next() * 16).toString(16);
      }
      return output;
    },
    /** contract 要求 UUIDv4 形态（第 13 位 4，第 17 位 ∈ 89ab）。 */
    uuid() {
      const raw = this.hex(32).split('');
      raw[12] = '4';
      raw[16] = '89ab'[Math.floor(next() * 4)];
      const text = raw.join('');
      return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
    },
    shuffle(items) {
      const output = [...items];
      for (let index = output.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        const swap = output[index];
        output[index] = output[other];
        output[other] = swap;
      }
      return output;
    },
    /** 已经抽过多少次——用来证明负载确实由 PRNG 生成而不是常量。 */
    take() {
      return draws;
    },
  };
}
