/**
 * tests/console/i18n/i18n-loader.test.js — 加载器行为断言（框架阶段门禁）。
 *
 * 覆盖：detect 三条回落、缺 key 显示、插值、复数（en/es/ru/ja）、
 * 切换持久化、切换即时重渲染、三种 DOM 绑定、debug 标记开关。
 *
 * 作者：PT-dove
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDocument, createElement, createStorage } from './dom-stub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const I18N_DIR = path.join(ROOT, 'apps', 'console', 'i18n');

await import(pathToFileURL(path.join(I18N_DIR, 'index.js')).href);
const NDI18N = globalThis.NDI18N;

/** 测试专用词条：key 与真实产品词条无关，只用来验证机制。 */
const TABLES = {
  en: {
    'nav.overview': 'Overview',
    'test.greet': 'Hello {name}',
    'test.only-en': 'English only',
    'test.items.one': '1 item',
    'test.items.few': '{count} items',
    'test.items.many': '{count} items',
    'test.items.other': '{count} items',
  },
  'zh-CN': {
    'nav.overview': '概览',
    'test.greet': '你好 {name}',
    'test.only-en': '仅英文',
    'test.items.one': '1 项',
    'test.items.few': '{count} 项',
    'test.items.many': '{count} 项',
    'test.items.other': '{count} 项',
  },
  ja: {
    'nav.overview': '概要',
    'test.greet': 'こんにちは {name}',
    'test.items.one': '1 件',
    'test.items.few': '{count} 件',
    'test.items.many': '{count} 件',
    'test.items.other': '{count} 件',
  },
  es: {
    'nav.overview': 'Resumen',
    'test.greet': 'Hola {name}',
    'test.items.one': '1 elemento',
    'test.items.few': '{count} elementos',
    'test.items.many': '{count} elementos',
    'test.items.other': '{count} elementos',
  },
  ru: {
    'nav.overview': 'Обзор',
    'test.greet': 'Привет, {name}',
    'test.items.one': '{count} элемент',
    'test.items.few': '{count} элемента',
    'test.items.many': '{count} элементов',
    'test.items.other': '{count} элемента',
  },
  ko: { 'nav.overview': '개요', 'test.greet': '안녕하세요 {name}' },
  th: { 'nav.overview': 'ภาพรวม', 'test.greet': 'สวัสดี {name}' },
};

/**
 * 造一个注入了假 DOM / 假存储 / 假文件源的实例。
 *
 * @param {{locale?: string, doc?: object, storage?: object, debug?: boolean, reject?: string[]}} [options]
 * @returns {object} i18n 实例。
 */
function makeI18n(options = {}) {
  const reject = Array.isArray(options.reject) ? options.reject : [];
  return NDI18N.createI18n({
    document: options.doc ?? createDocument(),
    storage: options.storage ?? createStorage(),
    debug: options.debug === true,
    loadJson(locale) {
      if (reject.includes(locale)) return Promise.reject(new Error(`no file: ${locale}`));
      const table = TABLES[locale];
      return Promise.resolve(table ? JSON.parse(JSON.stringify(table)) : {});
    },
  });
}

test('normalizeLocale 把常见标签收敛到受支持列表', () => {
  assert.equal(NDI18N.normalizeLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(NDI18N.normalizeLocale('zh-TW'), 'zh-CN');
  assert.equal(NDI18N.normalizeLocale('ja-JP'), 'ja');
  assert.equal(NDI18N.normalizeLocale('ru'), 'ru');
  assert.equal(NDI18N.normalizeLocale('de-DE'), null);
  assert.equal(NDI18N.normalizeLocale(''), null);
  assert.equal(NDI18N.normalizeLocale(undefined), null);
});

test('detect：localStorage 里的选择优先于浏览器语言', () => {
  const storage = createStorage({ 'ui.locale': 'ru' });
  assert.equal(NDI18N.detectLocale({ storage, languages: ['ja-JP', 'en-US'] }), 'ru');
});

test('detect：没有存储时按 navigator.languages 顺序取第一个支持的', () => {
  const storage = createStorage();
  assert.equal(NDI18N.detectLocale({ storage, languages: ['de-DE', 'zh-Hans-CN', 'en'] }), 'zh-CN');
});

test('detect：全都不支持时回落 en', () => {
  assert.equal(NDI18N.detectLocale({ storage: createStorage(), languages: ['de-DE', 'fr-FR'] }), 'en');
  assert.equal(NDI18N.detectLocale({ storage: null, languages: [] }), 'en');
});

test('load：目标语言文件失败时回落 en，且标记 source=fallback', async () => {
  const i18n = makeI18n({ reject: ['ja'] });
  await i18n.init({ locale: 'ja' });
  assert.equal(i18n.getLocale(), 'ja');
  assert.equal(i18n.t('nav.overview'), 'Overview');
  assert.equal(i18n.resolve('nav.overview').source, 'fallback');
});

test('t：locale 与 en 都没有的 key 显示 [missing:key]，不返回空串', async () => {
  const i18n = makeI18n();
  await i18n.init({ locale: 'zh-CN' });
  assert.equal(i18n.t('test.absent.key'), '[missing:test.absent.key]');
  assert.deepEqual(i18n.missingKeys(), ['test.absent.key']);
});

test('interpolate：{name} 插值，未知占位符原样保留', () => {
  assert.equal(NDI18N.interpolate('Hello {name}', { name: 'Ada' }), 'Hello Ada');
  assert.equal(NDI18N.interpolate('Hello {name}', {}), 'Hello {name}');
  assert.equal(NDI18N.interpolate('{count} / {limit}', { count: 3 }), '3 / {limit}');
});

test('复数 en：1 用 one，2 用 other', async () => {
  const i18n = makeI18n();
  await i18n.init({ locale: 'en' });
  assert.equal(i18n.t('test.items', { count: 1 }), '1 item');
  assert.equal(i18n.t('test.items', { count: 2 }), '2 items');
});

test('复数 es：1 用 one，0 与 5 用 other', async () => {
  const i18n = makeI18n();
  await i18n.init({ locale: 'es' });
  assert.equal(i18n.t('test.items', { count: 1 }), '1 elemento');
  assert.equal(i18n.t('test.items', { count: 5 }), '5 elementos');
  assert.equal(i18n.t('test.items', { count: 0 }), '0 elementos');
});

test('复数 ru：one / few / many / other 四类都命中', async () => {
  const i18n = makeI18n();
  await i18n.init({ locale: 'ru' });
  assert.equal(i18n.t('test.items', { count: 1 }), '1 элемент');
  assert.equal(i18n.t('test.items', { count: 23 }), '23 элемента');
  assert.equal(i18n.t('test.items', { count: 25 }), '25 элементов');
  assert.equal(i18n.t('test.items', { count: 21 }), '21 элемент');
});

test('复数 ja：只有一种形式，1 与 5 文本相同', async () => {
  const i18n = makeI18n();
  await i18n.init({ locale: 'ja' });
  assert.equal(i18n.t('test.items', { count: 1 }), '1 件');
  assert.equal(i18n.t('test.items', { count: 5 }), '5 件');
});

test('setLocale：写入 localStorage，并即时重渲染绑定节点（不刷新页面）', async () => {
  const node = createElement('h1');
  node.setAttribute('data-i18n', 'nav.overview');
  const doc = createDocument([node]);
  const storage = createStorage();
  const i18n = makeI18n({ doc, storage });

  await i18n.init({ locale: 'en' });
  i18n.bind();
  assert.equal(node.textContent, 'Overview');

  await i18n.setLocale('zh-CN');
  assert.equal(node.textContent, '概览');
  assert.equal(storage.getItem('ui.locale'), 'zh-CN');
  assert.equal(i18n.getLocale(), 'zh-CN');
});

test('bind：data-i18n / data-i18n-attr / data-i18n-title 三种绑定都生效', async () => {
  const text = createElement('span');
  text.setAttribute('data-i18n', 'nav.overview');
  const attr = createElement('input');
  attr.setAttribute('data-i18n-attr', 'placeholder:test.greet');
  attr.setAttribute('data-i18n-count', '3');
  const titled = createElement('button');
  titled.setAttribute('data-i18n', 'nav.overview');
  titled.setAttribute('data-i18n-title', 'test.only-en');

  const doc = createDocument([text, attr, titled]);
  const i18n = makeI18n({ doc });
  await i18n.init({ locale: 'zh-CN' });
  const bound = i18n.bind();

  assert.equal(bound, 4); // text + placeholder + (按钮文本 + 按钮 title)
  assert.equal(text.textContent, '概览');
  assert.equal(attr.getAttribute('placeholder'), '你好 {name}');
  assert.equal(titled.getAttribute('title'), '仅英文');
});

test('debug 模式：缺词条加 i18n-missing 类，回落加 i18n-fallback 类', async () => {
  const missing = createElement('span');
  missing.setAttribute('data-i18n', 'test.absent.key');
  const fallback = createElement('span');
  fallback.setAttribute('data-i18n', 'test.only-en');
  const doc = createDocument([missing, fallback]);

  const i18n = makeI18n({ doc, debug: true });
  await i18n.init({ locale: 'ja' });
  i18n.bind();

  assert.equal(missing.textContent, '[missing:test.absent.key]');
  assert.equal(missing.classList.contains('i18n-missing'), true);
  assert.equal(fallback.classList.contains('i18n-fallback'), true);
});

test('生产模式：不加调试类，但缺词条仍显示 [missing:key]', async () => {
  const missing = createElement('span');
  missing.setAttribute('data-i18n', 'test.absent.key');
  const fallback = createElement('span');
  fallback.setAttribute('data-i18n', 'test.only-en');
  const doc = createDocument([missing, fallback]);

  const i18n = makeI18n({ doc, debug: false });
  await i18n.init({ locale: 'ja' });
  i18n.bind();

  assert.equal(missing.textContent, '[missing:test.absent.key]');
  assert.equal(missing.classList.contains('i18n-missing'), false);
  assert.equal(fallback.classList.contains('i18n-fallback'), false);
});

test('mountLanguageSelector：七个选项只显示自称，change 后即时生效并持久化', async () => {
  const host = createElement('div');
  const storage = createStorage();
  const i18n = makeI18n({ doc: createDocument([host]), storage });
  await i18n.init({ locale: 'en' });

  const select = i18n.mountLanguageSelector(host, { labelKey: 'nav.overview' });
  assert.equal(select.children.length, 7);
  assert.deepEqual(select.children.map((option) => option.value), ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']);
  assert.deepEqual(
    select.children.map((option) => option.textContent),
    ['English', '简体中文', '日本語', '한국어', 'Español', 'Русский', 'ไทย'],
  );
  assert.equal(select.getAttribute('aria-label'), 'Overview');
  assert.equal(select.value, 'en');

  select.value = 'ja';
  select.dispatch('change');
  await i18n.ready();
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(i18n.getLocale(), 'ja');
  assert.equal(storage.getItem('ui.locale'), 'ja');
  assert.equal(i18n.t('nav.overview'), '概要');
});

test('setLocale：不受支持的语言收敛到 en 并写回存储', async () => {
  const storage = createStorage({ 'ui.locale': 'ja' });
  const i18n = makeI18n({ storage });
  await i18n.init();
  assert.equal(i18n.getLocale(), 'ja');
  const applied = await i18n.setLocale('de-DE');
  assert.equal(applied, 'en');
  assert.equal(storage.getItem('ui.locale'), 'en');
});

test('readDebugFlag：只认 ?i18n=debug（含 =1 / =true）', () => {
  assert.equal(NDI18N.readDebugFlag('?i18n=debug'), true);
  assert.equal(NDI18N.readDebugFlag('?a=1&i18n=1'), true);
  assert.equal(NDI18N.readDebugFlag('?i18n=false'), false);
  assert.equal(NDI18N.readDebugFlag(''), false);
});
