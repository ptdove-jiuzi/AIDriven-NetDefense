#!/usr/bin/env node
/**
 * make-diff.mjs — 生成 unified diff（仓库无 git，Windows 无 diff(1) 时用）。
 *
 * 用法：
 *   node apps/console-next/i18n/tools/make-diff.mjs <before> <after> <out.diff> [labelBefore] [labelAfter]
 *
 * 纯 LCS/DP 实现，只用于小文件（≤ 3000 行）的审计留证。
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';

const CONTEXT = 3;

function lcsMatrix(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** 把 a/b 展开成 op 序列：[{type:' '|'-'|'+', a:i, b:j}] */
function diffOps(a, b) {
  const dp = lcsMatrix(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', a: i, b: j });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', a: i });
      i += 1;
    } else {
      ops.push({ type: '+', b: j });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ type: '-', a: i });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ type: '+', b: j });
    j += 1;
  }
  return ops;
}

function unified(a, b, labelA, labelB) {
  const ops = diffOps(a, b);
  const changed = ops.map((op, index) => (op.type === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return '';
  const hunks = [];
  let start = Math.max(0, changed[0] - CONTEXT);
  let end = Math.min(ops.length - 1, changed[0] + CONTEXT);
  for (const index of changed.slice(1)) {
    if (index - CONTEXT <= end + 1) {
      end = Math.min(ops.length - 1, index + CONTEXT);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, index - CONTEXT);
      end = Math.min(ops.length - 1, index + CONTEXT);
    }
  }
  hunks.push([start, end]);

  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to + 1);
    const aLen = slice.filter((op) => op.type !== '+').length;
    const bLen = slice.filter((op) => op.type !== '-').length;
    const aStart = slice.find((op) => op.type !== '+')?.a ?? (slice[0].b ?? 0);
    const bStart = slice.find((op) => op.type !== '-')?.b ?? (slice[0].a ?? 0);
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    for (const op of slice) {
      if (op.type === ' ') out.push(` ${a[op.a]}`);
      else if (op.type === '-') out.push(`-${a[op.a]}`);
      else out.push(`+${b[op.b]}`);
    }
  }
  return out.join('\n') + '\n';
}

const [beforeArg, afterArg, outArg, labelA = 'before', labelB = 'after'] = process.argv.slice(2);
if (!beforeArg || !afterArg) {
  process.stderr.write('usage: make-diff.mjs <before> <after> [out.diff] [labelA] [labelB]\n');
  process.exit(2);
}
const a = fs.readFileSync(beforeArg, 'utf8').split(/\r?\n/u);
const b = fs.readFileSync(afterArg, 'utf8').split(/\r?\n/u);
const text = unified(a, b, labelA, labelB);
if (outArg) {
  fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true });
  fs.writeFileSync(outArg, text, 'utf8');
}
process.stdout.write(text);
