/**
 * UI2-B11 · 变异验证工具
 *
 * 原则：**不改被测实现**。做法是把源码复制到临时目录、对副本做单点删除/篡改，
 * 再用与正式测试相同的"判据函数"跑一遍：正式实现必须绿，变异副本必须红。
 * 每一步都打印真实断言错误（写到 `t.diagnostic`），供状态文件/证据引用。
 *
 * @author PT-dove
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function makeMutationDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `b11-mutation-${label}-`));
}

export function copyDir(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

export function copyFiles(sourceDir, destinationDir, names) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(sourceDir, name), path.join(destinationDir, name));
}

/**
 * 单点替换。必须恰好命中一次——命中 0 次说明"变异没打上"，必须让测试自己报红。
 */
export function patchFile(filePath, search, replacement) {
  const source = fs.readFileSync(filePath, 'utf8');
  const occurrences = source.split(search).length - 1;
  if (occurrences !== 1) {
    throw new Error(`mutation patch must match exactly once in ${path.basename(filePath)} (matched ${occurrences})`);
  }
  fs.writeFileSync(filePath, source.replace(search, replacement));
}

/** 带 query 的 import，避免与正式实现的模块实例/缓存混在一起。 */
export function importFresh(filePath, label = 'mutant') {
  return import(`${pathToFileURL(filePath).href}?b11=${label}-${Date.now()}`);
}

/**
 * 把一个断言函数跑成"结论文本"：绿 → {ok:true}；红 → {ok:false,message}。
 * 用法：`captureOracle(() => { ...assert... })`。
 */
export function captureOracle(oracle) {
  try {
    oracle();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `${error?.name ?? 'Error'}: ${error?.message ?? error}` };
  }
}

export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  } catch {
    // 临时目录残留不影响结论。
  }
}
