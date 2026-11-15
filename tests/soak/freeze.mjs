/**
 * freeze.mjs — 冻结一份可执行的字节副本，并出具全量哈希清单。
 *
 * 为什么需要它（这是 M9-BENCH-SOAK 当初 blocked 的真正解药）：
 * 那次浸泡的失败项是 `soak.code_stable_during_run` —— 运行期间有**别的会话**在改
 * `apps/daemon/src` 与 `packages/detection/src`，于是 `code_digest` 前后不等，证据自判失败。
 * 处置被写成「等所有写者停写后重跑」，而在这台机器上那个条件永远不成立。
 *
 * 正确的做法不是等仓库静止，而是**冻一份字节**：
 *   - 复制到一个独立目录（仓库外），运行期只读那份副本；
 *   - 记下副本里每个文件的 sha256，形成清单，并给清单本身一个可复算的 sha256；
 *   - 判据改成「**这份副本的字节在运行期内没变**」。
 * 活仓库继续被别的会话改写与我们无关——因为我们根本没跑它。
 *
 * 第二个理由（最容易踩的坑）：
 * 仓库的 `node_modules/@aegisharness/*` 是 **指向活仓库的符号链接**。
 * 直接复制会把链接原样带过去，副本于是照样加载活仓库的代码——看起来冻结了，实际没冻。
 * 所以副本里的链接必须**重建为指向副本自身**（用 junction，Windows 上不需要管理员权限）。
 *
 * 用法：
 *   node tests/soak/freeze.mjs --out $AIDN_HOME/_soak-freeze/2026-11-04
 *   node tests/soak/freeze.mjs --out ... --force      # 仅用于重做（会先清空目标）
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from '../bench/lib/env.js';

/** 清单结构版本。 */
export const FREEZE_SCHEMA = 'aegis.soak.freeze/1';

/**
 * 复制范围：**跑长稳真正会加载的东西**。
 *
 * 不复制整个仓库是有意的：
 *   - `tests/` 下 26 MB 是 wp0 的历史证据，长稳不加载；
 *   - `spike/` 122 MB、`node_modules/` 数千包；长稳的依赖只有 `node:` 内置与
 *     `@aegisharness/*`（后者用 junction 重建，不复制实体）；
 *   - `dist/`、`build/`、`.publish/` 是构建产物，不是源码。
 * 代价：这份副本**不是整仓库快照**，所以报告里必须写清范围（`scope` 字段）。
 */
export const COPY_SCOPE = Object.freeze([
  'apps',
  'packages',
  'tests/bench',
  'tests/soak',
  'package.json',
  'LICENSE',
  'NOTICE',
]);

/** 复制时跳过的目录名（与 COPY_SCOPE 配合，防止把产物卷进来）。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.publish', '.git', 'evidence']);

/**
 * sha256。
 *
 * @param {Buffer|string} content 内容。
 * @returns {string} 摘要。
 */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 递归复制；符号链接一律不跟随。
 *
 * 「不跟随」是安全属性而不是优化：源里任何一个指向活仓库或用户目录的链接，
 * 跟随之后副本就不再是副本。
 *
 * @param {string} source 源。
 * @param {string} target 目标。
 * @param {string[]} sink 收集已复制的绝对路径。
 * @returns {void}
 */
function copyTree(source, target, sink) {
  const stats = fs.lstatSync(source);
  if (stats.isSymbolicLink()) {
    return;
  }
  if (stats.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      copyTree(path.join(source, entry.name), path.join(target, entry.name), sink);
    }
    return;
  }
  if (stats.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    sink.push(target);
  }
}

/**
 * 列出目录下所有文件（相对 root，`/` 分隔，字典序）；符号链接与 node_modules 不算。
 *
 * @param {string} root 根。
 * @returns {string[]} 相对路径。
 */
function listFiles(root) {
  const output = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue; // junction 指向副本内部，不是独立字节，不进清单。
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        output.push(path.relative(root, full).replace(/\\/gu, '/'));
      }
    }
  };
  walk(root);
  output.sort();
  return output;
}

/**
 * 重建 `node_modules/@aegisharness/*`，让副本只依赖**副本自己**。
 *
 * @param {string} out 副本根。
 * @returns {{created: string[], skipped: string[]}} 结果。
 */
export function relinkWorkspaces(out) {
  const source = path.join(REPO_ROOT, 'node_modules', '@aegisharness');
  const targetDir = path.join(out, 'node_modules', '@aegisharness');
  const created = [];
  const skipped = [];
  if (!fs.existsSync(source)) {
    return { created, skipped };
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    let realTarget;
    try {
      realTarget = fs.realpathSync(sourcePath);
    } catch {
      skipped.push(`${entry.name}（无法解析）`);
      continue;
    }
    const relative = path.relative(REPO_ROOT, realTarget).replace(/\\/gu, '/');
    if (relative.startsWith('..')) {
      skipped.push(`${entry.name}（指向仓库外：${realTarget}）`);
      continue;
    }
    const outTarget = path.join(out, relative);
    if (!fs.existsSync(outTarget)) {
      skipped.push(`${entry.name}（副本里没有 ${relative}）`);
      continue;
    }
    const linkPath = path.join(targetDir, entry.name);
    try {
      if (fs.existsSync(linkPath)) {
        fs.rmSync(linkPath, { recursive: false, force: true });
      }
      fs.symlinkSync(outTarget, linkPath, 'junction');
      created.push(`${entry.name} -> ${outTarget}`);
    } catch (error) {
      skipped.push(`${entry.name}（${error.message}）`);
    }
  }
  return { created, skipped };
}

/**
 * 主流程。
 *
 * @returns {number} 退出码。
 */
function main() {
  const argv = process.argv.slice(2);
  let out = null;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      out = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--force') {
      force = true;
    } else {
      process.stderr.write(`freeze: unknown argument ${argv[index]}\n`);
      return 1;
    }
  }
  if (out === null || path.isAbsolute(out) === false) {
    process.stderr.write('freeze: --out must be an absolute path outside the repository\n');
    return 1;
  }
  const outRoot = path.resolve(out);
  const repoLower = path.resolve(REPO_ROOT).toLowerCase();
  if (outRoot.toLowerCase() === repoLower || outRoot.toLowerCase().startsWith(`${repoLower}${path.sep}`)) {
    process.stderr.write(`freeze: refusing to freeze inside the repository (${outRoot})\n`);
    return 1;
  }
  if (fs.existsSync(outRoot)) {
    const existing = fs.readdirSync(outRoot);
    if (existing.length > 0) {
      if (force === false) {
        process.stderr.write(`freeze: ${outRoot} is not empty; pass --force to rebuild it\n`);
        return 1;
      }
      for (const name of existing) {
        fs.rmSync(path.join(outRoot, name), { recursive: true, force: true });
      }
    }
  }
  fs.mkdirSync(outRoot, { recursive: true });

  const copied = [];
  for (const relative of COPY_SCOPE) {
    const source = path.join(REPO_ROOT, relative);
    if (!fs.existsSync(source)) {
      process.stderr.write(`freeze: missing source path ${relative}\n`);
      return 1;
    }
    copyTree(source, path.join(outRoot, relative), copied);
  }

  const links = relinkWorkspaces(outRoot);

  const files = {};
  let totalBytes = 0;
  for (const relative of listFiles(outRoot)) {
    const content = fs.readFileSync(path.join(outRoot, relative));
    files[relative] = sha256(content);
    totalBytes += content.length;
  }
  // 清单自身的摘要：对「排序后的 `sha256  path` 行」求 sha256。
  // 这样清单是可复算的，而不是「我记了一串数，你爱信不信」。
  const canonical = Object.keys(files).map((relative) => `${files[relative]}  ${relative}\n`).join('');
  const manifestSha = sha256(canonical);

  const manifest = {
    schema: FREEZE_SCHEMA,
    created_at: new Date().toISOString(),
    source_root: REPO_ROOT,
    root: outRoot,
    scope: COPY_SCOPE,
    excluded: [
      'node_modules（@aegisharness 用 junction 重建，不复制实体）',
      'dist', 'build', '.publish', '.git', 'evidence',
      'tests/ 下 bench 与 soak 之外的目录',
      'spike', 'docs', 'deploy',
    ],
    note: '判据比较的是这份副本的字节，不是「活仓库是否静止」。',
    file_count: Object.keys(files).length,
    total_bytes: totalBytes,
    manifest_sha256: manifestSha,
    copied_files: copied.length,
    workspace_links: links.created,
    workspace_links_skipped: links.skipped,
    files,
  };
  fs.writeFileSync(path.join(outRoot, 'FREEZE.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  process.stdout.write(`freeze: root=${outRoot}\n`);
  process.stdout.write(`freeze: files=${manifest.file_count} bytes=${totalBytes}\n`);
  process.stdout.write(`freeze: manifest_sha256=${manifestSha}\n`);
  process.stdout.write(`freeze: workspace links=${links.created.length} skipped=${links.skipped.length}\n`);
  for (const item of links.skipped) {
    process.stdout.write(`freeze:   skipped: ${item}\n`);
  }
  process.stdout.write(`freeze: manifest=${path.join(outRoot, 'FREEZE.json')}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}
