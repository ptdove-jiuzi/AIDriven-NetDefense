/**
 * lib/tempdir.js — 临时目录与"绝不碰真实数据"的守卫。
 *
 * 这是本任务最重要的一段代码，比任何测量逻辑都重要：一个写错路径的基准会
 * 直接清空用户真实的 `GoalLedgerData`/事件库/日志。所以守卫是**主动拒绝**，
 * 不是靠调用方自律：
 *
 * 1. 临时根必须位于系统临时目录之下；
 * 2. 临时根不得位于仓库目录之下（否则清理逻辑可能扫到源码）；
 * 3. 任何要交给 event-store 的路径都要过 {@link assertHarmlessPath}，
 *    在创建目录**之前**就拒绝，而不是创建完再后悔。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT } from './env.js';

/** 系统临时目录的真实路径（解析符号链接，Windows 上短路径也要归一）。 */
const SYSTEM_TEMP = (() => {
  try {
    return fs.realpathSync(os.tmpdir());
  } catch {
    return path.resolve(os.tmpdir());
  }
})();

/**
 * 路径是否位于 `parent` 之内（含自身）。
 *
 * Windows 路径大小写不敏感，比较前统一小写；分隔符统一为 `path.sep`。
 *
 * @param {string} child 子路径（绝对）。
 * @param {string} parent 父路径（绝对）。
 * @returns {boolean} 是否在内部。
 */
export function isInside(child, parent) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/u, '').toLowerCase();
  const childNorm = normalize(child);
  const parentNorm = normalize(parent);
  if (childNorm === parentNorm) {
    return true;
  }
  return childNorm.startsWith(`${parentNorm}${path.sep}`);
}

/**
 * 把路径解析到"真实"位置，允许目标尚不存在。
 *
 * `path.resolve` 只看字符串，不认符号链接与 Windows junction。一个
 * `%TEMP%\evil` → 仓库的 junction 会让"看起来在临时目录里"的路径实际写进仓库。
 * 这里对**最近的存在祖先**做 `realpathSync.native`，再拼回不存在的尾部。
 *
 * @param {string} target 目标路径。
 * @returns {string} 解析后的真实路径。
 */
export function realpathLoose(target) {
  const resolved = path.resolve(target);
  let current = resolved;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length === 0 ? real : path.join(real, ...tail.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// 模块加载即自检：如果系统临时目录本身就在仓库里（例如 TMP 被指到仓库内），
// 那么后面所有"临时目录"都不安全。这种情况必须立刻炸，而不是等某个用例才发现。
if (isInside(realpathLoose(SYSTEM_TEMP), realpathLoose(REPO_ROOT))) {
  throw new Error(
    `tempdir: the OS temporary directory resolves inside the repository (${SYSTEM_TEMP}). `
      + 'Refusing to run: every benchmark write would land in the source tree.',
  );
}

/**
 * 断言一个路径是"无害的基准数据路径"。
 *
 * @param {string} target 待检查路径。
 * @param {string} label 用于报错的上下文标签。
 * @returns {string} 解析后的绝对路径。
 * @throws {Error} 当路径不在系统临时目录下，或落在仓库目录内。
 */
export function assertHarmlessPath(target, label = 'path') {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error(`${label}: expected a non-empty path`);
  }
  const resolved = realpathLoose(target);
  if (isInside(resolved, realpathLoose(REPO_ROOT))) {
    throw new Error(
      `${label}: refusing to use a path inside the repository (${resolved}). `
        + 'Benchmarks must only write under the OS temporary directory.',
    );
  }
  if (!isInside(resolved, realpathLoose(SYSTEM_TEMP))) {
    throw new Error(
      `${label}: refusing to use a path outside the OS temporary directory (${resolved}, temp=${SYSTEM_TEMP}).`,
    );
  }
  return resolved;
}

/**
 * 创建一个受守卫保护的临时根目录。
 *
 * @param {string} label 目录名前缀，用于在系统临时目录里辨认来源。
 * @returns {{root: string, dir: (name: string) => string, cleanup: () => void}} 句柄。
 */
export function createTempRoot(label = 'aegis-bench') {
  // 先校验父目录再 mkdtemp：原实现是"先建目录、后断言"，一旦断言失败，
  // 目录已经落在（可能是仓库的）父目录里，而 cleanup 永远不会被调用。
  assertHarmlessPath(SYSTEM_TEMP, 'temp parent');
  const root = fs.mkdtempSync(path.join(SYSTEM_TEMP, `${label}-`));
  assertHarmlessPath(root, 'temp root');
  let cleaned = false;
  return {
    root,
    /**
     * 在临时根下解析子路径，并再次守卫。
     *
     * @param {string} name 相对名。
     * @returns {string} 绝对路径。
     */
    dir(name) {
      return assertHarmlessPath(path.join(root, name), `temp subpath ${name}`);
    },
    cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      } catch {
        // 临时目录残留不该让基准变红；真实断言失败另有报错。
      }
    },
  };
}

/**
 * 目录总字节数（递归）。
 *
 * @param {string} target 目录。
 * @returns {number} 字节数；目录不存在返回 0。
 */
export function directoryBytes(target) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(full);
      continue;
    }
    try {
      total += fs.statSync(full).size;
    } catch {
      // 文件在扫描期间被删除：忽略。
    }
  }
  return total;
}

/**
 * 文件字节数。
 *
 * @param {string} target 文件。
 * @returns {number} 字节数；不存在返回 0。
 */
export function fileBytes(target) {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}
