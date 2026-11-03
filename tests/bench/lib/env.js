/**
 * lib/env.js — 运行环境采集。
 *
 * 基准数字只有绑在环境上才有意义：换 CPU、换磁盘介质、换 Node 版本都会改变结果。
 * 所以每次运行都把环境写进 JSON 的 `env` 段，报告正文也照抄一份。
 *
 * 不使用外部命令（wmic/PowerShell）：那会让采集本身变慢、变脆，并且在 CI 里不可用。
 * `node:os` + `node:fs.statfsSync` 已经能拿到需要的全部硬件信息。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** 仓库根目录（`tests/bench/lib/env.js` 往上三层）。 */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/**
 * 读取内置 SQLite 版本。
 *
 * 存储性能与 SQLite 版本强相关（WAL、checkpoint、页大小默认值都变过），
 * 不记录版本就没法解释跨机器的差异。
 *
 * @returns {string|null} 版本号。
 */
function sqliteVersion() {
  try {
    const database = new DatabaseSync(':memory:');
    const row = database.prepare('select sqlite_version() as v').get();
    database.close();
    return row === undefined || row === null ? null : String(row.v);
  } catch {
    return null;
  }
}

/**
 * 取磁盘容量信息。
 *
 * @param {string} targetPath 目标路径。
 * @returns {{path: string, total_bytes: number|null, free_bytes: number|null}|null} 容量信息。
 */
function diskOf(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath);
    return {
      path: targetPath,
      total_bytes: stats.blocks * stats.bsize,
      free_bytes: stats.bavail * stats.bsize,
    };
  } catch {
    return null;
  }
}

/**
 * 被测量的源码目录（相对仓库根）。
 *
 * 没有 git 时，"这份 JSON 到底测的是哪个版本的代码"只能靠内容哈希回答。
 * 尤其当另一个 Agent 在基准跑完之后改了被测文件时，没有这个哈希就无法发现
 * 证据已经过期。
 */
const MEASURED_SOURCES = Object.freeze([
  'packages/event-store/src',
  'packages/detection/src',
  'apps/daemon/src',
]);

/**
 * 递归收集目录下的文件（相对路径 + 绝对路径），按相对路径排序。
 *
 * @param {string} root 仓库根。
 * @param {string} relative 相对目录。
 * @returns {string[]} 绝对路径列表。
 */
function listSourceFiles(root, relative) {
  const absolute = path.join(root, relative);
  const output = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        output.push(full);
      }
    }
  };
  walk(absolute);
  output.sort();
  return output;
}

/**
 * 计算被测源码的内容摘要。
 *
 * 摘要覆盖"相对路径 + 文件内容"，所以文件改名、增删、改内容都会变；
 * 只改 mtime 不会。这样跨运行比较才有意义。
 *
 * @param {string} root 仓库根。
 * @returns {{digest: string, files: number, bytes: number}} 摘要。
 */
export function codeDigest(root = REPO_ROOT) {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const relative of MEASURED_SOURCES) {
    for (const file of listSourceFiles(root, relative)) {
      let content;
      try {
        content = fs.readFileSync(file);
      } catch {
        continue;
      }
      const key = path.relative(root, file).replace(/\\/gu, '/');
      hash.update(key, 'utf8');
      hash.update('\u0000', 'utf8');
      hash.update(content);
      files += 1;
      bytes += content.length;
    }
  }
  return { digest: hash.digest('hex'), files, bytes };
}

/**
 * 采集当前环境。
 *
 * @param {{tempRoot?: string}} [options] 选项；`tempRoot` 用于报告基准数据实际落在哪块盘上。
 * @returns {object} 环境快照。
 */
export function captureEnv(options = {}) {
  const cpus = os.cpus();
  const firstCpu = cpus[0] ?? {};
  const memory = process.memoryUsage();
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const sanitize = (value) => String(value)
    .split(tempRoot).join('<TEMP>')
    .split(REPO_ROOT).join('<REPO>');
  return {
    captured_at: new Date().toISOString(),
    node: {
      version: process.version,
      v8: process.versions.v8,
      openssl: process.versions.openssl ?? null,
      modules: process.versions.modules,
    },
    sqlite_version: sqliteVersion(),
    platform: {
      os: process.platform,
      release: os.release(),
      arch: process.arch,
      // 不写真实主机名：证据会进仓库，"某台机器的主机名"属于环境标识而不是性能数据。
      hostname_recorded: false,
    },
    cpu: {
      model: firstCpu.model ?? null,
      logical_cores: cpus.length,
      speed_mhz: firstCpu.speed ?? null,
    },
    memory: {
      total_bytes: os.totalmem(),
      free_bytes_before_run: os.freemem(),
      rss_bytes_at_start: memory.rss,
    },
    disk: {
      // 路径脱敏：只保留"落在哪块盘、剩多少"，不落盘绝对路径与用户名目录。
      temp_root_location: '<TEMP>',
      temp_root_disk: diskOf(tempRoot),
      repo_root_location: '<REPO>',
      repo_root_disk: diskOf(REPO_ROOT),
    },
    code_digest: codeDigest(),
    runtime: {
      // 只有在 `node --expose-gc` 下才有 gc；没有就必须在报告里说明
      // "内存下降可能来自 GC，而不是释放了持有引用"。
      gc_exposed: typeof globalThis.gc === 'function',
      argv: process.argv.slice(2).map(sanitize),
    },
  };
}

/**
 * 把字节数写成人读的 GiB 字符串。
 *
 * @param {number|null|undefined} bytes 字节。
 * @returns {string} 例如 `15.83 GiB`。
 */
export function gib(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    return 'unknown';
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
