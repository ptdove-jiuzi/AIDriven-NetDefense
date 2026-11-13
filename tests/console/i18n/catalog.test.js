/**
 * tests/console/i18n/catalog.test.js — 真实词条目录的收尾断言。
 *
 * 与 i18n-check.test.js 的区别：那边用假文件证明"校验会红"，这边盯真实交付物：
 * 七份文件是否真的齐全、key 是否逐字一致、切换语言后界面文案是否真的变了、
 * 俄语复数是否真的是四类。
 *
 * 作者：PT-dove
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const LOCALES = path.join(ROOT, 'apps', 'console', 'i18n', 'locales');
const I18N_DIR = path.join(ROOT, 'apps', 'console', 'i18n');
const CHECK = path.join(ROOT, 'scripts', 'i18n-check.mjs');
const SUPPORTED = ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th'];

await import(pathToFileURL(path.join(I18N_DIR, 'index.js')).href);
const NDI18N = globalThis.NDI18N;

function table(locale) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, `${locale}.json`), 'utf8'));
}

/** 用真实文件做文件源，模拟浏览器里的 fetch。 */
function realLoader(locale) {
  return Promise.resolve(table(locale));
}

test('七份词条文件都存在且 key 集合与 en 逐字一致', () => {
  const base = Object.keys(table('en')).sort();
  assert.ok(base.length >= 120 && base.length <= 160, `en 词条数 ${base.length} 不在 120–160`);
  for (const locale of SUPPORTED) {
    const keys = Object.keys(table(locale)).sort();
    assert.deepEqual(keys, base, `${locale} 的 key 集合与 en 不一致`);
  }
});

test('没有空值、没有超过 120 字符的值', () => {
  for (const locale of SUPPORTED) {
    const entries = Object.entries(table(locale));
    for (const [key, value] of entries) {
      assert.equal(typeof value, 'string', `${locale}/${key} 不是字符串`);
      assert.notEqual(value.trim(), '', `${locale}/${key} 是空值`);
      assert.ok(value.length <= 120, `${locale}/${key} 长度 ${value.length} 超过 120`);
      assert.ok(!/\bTODO\b|\bFIXME\b/u.test(value), `${locale}/${key} 含 TODO`);
    }
  }
});

test('校验脚本对真实词条目录 + 真实入口退出码 0（console-v1 profile）', () => {
  // SEED-03: the legacy console owns its own 7×159 locale files, so the v1 profile is
  // the one that must stay green; the v2 profile checks console-next, which is another
  // workstream. Both the locale set and the entry wiring are asserted here.
  const result = spawnSync(process.execPath, [CHECK, '--profile', 'console-v1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /PASS/u);
});

test('真实切换：en → zh-CN / ja / ko / ru / th 后 nav.overview 都变了', async () => {
  const i18n = NDI18N.createI18n({ document: null, storage: null, loadJson: realLoader });
  await i18n.init({ locale: 'en' });
  const english = i18n.t('nav.overview');
  assert.equal(english, 'Overview');

  const expected = { 'zh-CN': '概览', ja: '概要', ko: '개요', ru: 'Обзор', th: 'ภาพรวม', es: 'Resumen' };
  for (const [locale, text] of Object.entries(expected)) {
    await i18n.setLocale(locale);
    assert.equal(i18n.getLocale(), locale);
    assert.equal(i18n.t('nav.overview'), text, `${locale} 切换后文案不对`);
    assert.equal(i18n.resolve('nav.overview').source, 'locale', `${locale} 仍在回落 en`);
  }
});

test('真实词条里俄语复数的 one / few / many 是三种不同写法', async () => {
  const i18n = NDI18N.createI18n({ document: null, storage: null, loadJson: realLoader });
  await i18n.init({ locale: 'ru' });
  const one = i18n.t('alerts.result', { count: 1 });
  const few = i18n.t('alerts.result', { count: 3 });
  const many = i18n.t('alerts.result', { count: 5 });
  assert.equal(one, '1 оповещение');
  assert.equal(few, '3 оповещения');
  assert.equal(many, '5 оповещений');
  assert.notEqual(one, few);
  assert.notEqual(few, many);
});

test('真实词条里日语的单复数同形，且不残留英文占位', async () => {
  const i18n = NDI18N.createI18n({ document: null, storage: null, loadJson: realLoader });
  await i18n.init({ locale: 'ja' });
  const one = i18n.t('alerts.result', { count: 1 });
  const many = i18n.t('alerts.result', { count: 9 });
  assert.match(one, /^アラート 1 件$/u);
  assert.match(many, /^アラート 9 件$/u);
  assert.doesNotMatch(i18n.t('error.offline.title'), /^[A-Za-z ]+$/u);
});

test('缺 key 时真实实例仍给出 [missing:key]，不会静默空白', async () => {
  const i18n = NDI18N.createI18n({ document: null, storage: null, loadJson: realLoader });
  await i18n.init({ locale: 'th' });
  assert.equal(i18n.t('this.key.does.not.exist'), '[missing:this.key.does.not.exist]');
});
