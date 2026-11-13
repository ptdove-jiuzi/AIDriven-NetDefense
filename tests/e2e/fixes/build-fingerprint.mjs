/**
 * tests/e2e/fixes/build-fingerprint.mjs — 计算 `apps/console-next` 的 build 指纹（作者 PT-dove）
 *
 * 用途：回修把结论绑定到具体 build，避免"移动靶"（N-006/N-007：并行会话仍在写 js/**）。
 * 指纹 = `sha256( 排序后的 "<相对路径>\t<文件 sha256>" 清单 )`，并给出文件数与最新 mtime。
 *
 * 运行：node tests/e2e/fixes/build-fingerprint.mjs [--out <json>]
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { REPO_ROOT } from './lib/mutate-module.mjs';

const ROOT = join(REPO_ROOT, 'apps/console-next');

function walk(directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function fingerprint(root = ROOT) {
  const files = walk(root)
    .map((full) => ({
      path: relative(root, full).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
      bytes: statSync(full).size,
      mtime: statSync(full).mtime.toISOString(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest = files.map((file) => `${file.path}\t${file.sha256}`).join('\n');
  const latest = files.reduce((best, file) => (file.mtime > best.mtime ? file : best), files[0]);
  return {
    root: relative(REPO_ROOT, root).replaceAll('\\', '/'),
    fileCount: files.length,
    sha256: createHash('sha256').update(manifest).digest('hex'),
    latestMtime: latest ? latest.mtime : null,
    latestFile: latest ? latest.path : null,
    files,
  };
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex === -1 ? null : args[outIndex + 1];

const result = {
  schemaVersion: 1,
  tool: 'tests/e2e/fixes/build-fingerprint.mjs',
  node: process.version,
  generatedAt: new Date().toISOString(),
  consoleNext: fingerprint(),
  js: fingerprint(join(ROOT, 'js')),
};
if (outPath !== null) writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  out: outPath,
  consoleNext: { fileCount: result.consoleNext.fileCount, sha256: result.consoleNext.sha256, latestFile: result.consoleNext.latestFile },
  js: { fileCount: result.js.fileCount, sha256: result.js.sha256, latestMtime: result.js.latestMtime, latestFile: result.js.latestFile },
}, null, 2)}\n`);
