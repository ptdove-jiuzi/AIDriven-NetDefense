/**
 * tests/console/i18n/i18n-check.test.js — 证明 CI 校验会红。
 *
 * 这里全部用临时目录里的假词条：故意删 key、加 key、改占位符、留空值、缺语言文件，
 * 逐条验证 scripts/i18n-check.mjs 的退出码非 0。一个永远为真的检查脚本没有价值，
 * 所以这组断言必须先确认「能红」。
 *
 * SEED-03 / FG-01 追加：校验器还必须能对「词条目录没被入口引用」转红 ——
 * console-v1 入口不加载 i18n 加载器（ENTRY_NOT_WIRED）或加载了不启动
 * （ENTRY_LOADER_UNUSED）都必须非 0 退出，否则死载荷永远抓不到。
 *
 * 作者：PT-dove
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cleanup, writeLocales } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'i18n-check.mjs');
const CONSOLE_ENTRY = path.join(ROOT, 'apps', 'console', 'index.html');

/** 跑一次校验脚本。 */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** 写一个临时入口文件（用于入口引用断言）。 */
function writeEntry(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-entry-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html, 'utf8');
  return { dir, file };
}

test('干净的七语言 fixture + 真实入口：退出码 0', () => {
  const dir = writeLocales();
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /PASS/u);
  } finally {
    cleanup(dir);
  }
});

test('故意缺 key：退出码 1 且报 KEY_MISSING', () => {
  const dir = writeLocales((tables) => { delete tables.ja['list.one']; });
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /KEY_MISSING/u);
    assert.match(result.out, /list\.one/u);
  } finally {
    cleanup(dir);
  }
});

test('故意多 key：退出码 1 且报 KEY_EXTRA', () => {
  const dir = writeLocales((tables) => { tables.ko['extra.key'] = '여분'; });
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /KEY_EXTRA/u);
  } finally {
    cleanup(dir);
  }
});

test('占位符被改拼写：退出码 1 且报 PLACEHOLDER_MISMATCH', () => {
  const dir = writeLocales((tables) => { tables.es['greet.hello'] = 'Hola {nombre}'; });
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /PLACEHOLDER_MISMATCH/u);
    assert.match(result.out, /greet\.hello/u);
  } finally {
    cleanup(dir);
  }
});

test('空值：退出码 1 且报 EMPTY_VALUE', () => {
  const dir = writeLocales((tables) => { tables.th['action.save'] = '   '; });
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /EMPTY_VALUE/u);
  } finally {
    cleanup(dir);
  }
});

test('缺语言文件：退出码 1 且报 LOCALE_MISSING', () => {
  const dir = writeLocales((tables) => { delete tables.ru; });
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /LOCALE_MISSING/u);
  } finally {
    cleanup(dir);
  }
});

test('把英文原样抄进 ja：退出码 1 且报 LOCALE_NOT_TRANSLATED', () => {
  const dir = writeLocales((tables) => {
    for (const key of Object.keys(tables.ja)) tables.ja[key] = tables.en[key];
  });
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /LOCALE_NOT_TRANSLATED/u);
  } finally {
    cleanup(dir);
  }
});

test('SEED-03：入口不加载 i18n 加载器 → ENTRY_NOT_WIRED（词条未被入口引用必须转红）', () => {
  const dir = writeLocales();
  const entry = writeEntry('<!doctype html><html><body><script src="app.js" defer></script></body></html>');
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir, '--entry', entry.file]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /ENTRY_NOT_WIRED/u);
  } finally {
    cleanup(dir);
    cleanup(entry.dir);
  }
});

test('SEED-03：入口加载了加载器但从不启动 → ENTRY_LOADER_UNUSED', () => {
  const dir = writeLocales();
  const entry = writeEntry('<!doctype html><html><body><script src="i18n/index.js" defer></script></body></html>');
  try {
    const result = run(['--profile', 'console-v1', '--dir', dir, '--entry', entry.file]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /ENTRY_LOADER_UNUSED/u);
  } finally {
    cleanup(dir);
    cleanup(entry.dir);
  }
});

test('SEED-03：真实 console 入口已接线，整条检查（真实词条 + 真实入口）退出码 0', () => {
  const result = run(['--profile', 'console-v1']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /PASS/u);
});

test('SEED-03：真实入口确实引用了加载器并启动它（不依赖校验器的独立读法）', () => {
  const text = fs.readFileSync(CONSOLE_ENTRY, 'utf8');
  assert.match(text, /(?:\bsrc\s*=\s*"[^"]*i18n\/index\.js|\.src\s*=\s*'i18n\/index\.js')/u, 'the console entry must reference the i18n loader');
  assert.match(text, /NDI18N\s*\.\s*autoStart\s*\(/u, 'the console entry must start the i18n loader');
});
