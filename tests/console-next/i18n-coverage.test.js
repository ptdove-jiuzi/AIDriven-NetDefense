/**
 * UI-POLISH T3 · i18n 一致性与"缺 key 不落中文"门禁（独立于 scripts/i18n-check.mjs 重算一遍）
 *
 * 覆盖（每条都是可复现的真实断言，不是"看起来翻译了"）：
 *  1. 7 语言 key 集合完全一致（与 en 相等）；key 语法合法；无空值；
 *  2. 占位符 {name} 集合跨语言一致；
 *  3. en 零 CJK（白名单**恰好** 3 个 key：品牌中文名 + 2 个语言原生名）；
 *  4. 回落链：locale=en 缺 key **绝不**回落 zh-CN（即使 zh-CN 字典已加载）→ 界面零中文的第一判据；
 *     非 en 语言同理；zh-CN 本体仍能回落 en；
 *  5. 5 语言真翻译覆盖率 ≥ 150/1018 且 meta 的 `_note` 数字与磁盘**逐字一致**（禁止虚报）；
 *     未全量时不得出现"全量/100%/complete"之类声称；
 *  6. 目标语言脚本证据：ja 假名、ko 谚文、ru 西里尔、th 泰文在已翻译子集里真实出现；
 *  7. 中文泄漏：机翻语言不得整句照抄 zh-CN（zh 自己已翻译的条目）；
 *  8. README 覆盖率表与磁盘一致（防"README 写已翻译、磁盘还是英文"）；
 *  9. `node scripts/i18n-check.mjs --json` exit 0、error=0、coverage 字段与本文件重算一致、
 *     运行期回落探针 en/ja 都不出现汉字。
 *
 * 运行：`node --test tests/console-next/i18n-coverage.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const I18N_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'i18n');
const LOCALES_DIR = path.join(I18N_DIR, 'locales');
const LANGS = ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th'];
const MACHINE = ['ja', 'ko', 'es', 'ru', 'th'];
/** 已翻译的**下限**（本轮真实值 186/183；只允许涨不允许跌穿）：防"回退成英文占位"。 */
const MIN_TRANSLATED = 150;

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const SCRIPT = {
  ja: /[\u3040-\u30ff]/u,
  ko: /[\uac00-\ud7af]/u,
  ru: /[\u0400-\u04ff]/u,
  th: /[\u0e00-\u0e7f]/u,
};

const readLocale = (lang) => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8'));
const readMeta = (lang) => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.meta.json`), 'utf8'));
const placeholdersOf = (value) => [...new Set([...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((match) => match[1]))].sort();

const en = readLocale('en');
const dicts = Object.fromEntries(LANGS.map((lang) => [lang, lang === 'en' ? en : readLocale(lang)]));

function coverageOf(lang) {
  const dict = dicts[lang];
  const translated = Object.keys(en).filter((key) => dict[key] !== en[key]).length;
  return { translated, total: Object.keys(en).length, percent: (translated / Object.keys(en).length) * 100 };
}

test('7 语言 key 集合与 en 完全一致（缺/多均为 0），key 语法合法、无空值', (t) => {
  const enKeys = Object.keys(en).sort();
  assert.ok(enKeys.length >= 1018, `en key count ${enKeys.length} < 1018`);
  for (const lang of LANGS.slice(1)) {
    const keys = Object.keys(dicts[lang]).sort();
    assert.deepEqual(keys, enKeys, `${lang} key set must equal en exactly`);
    const bad = Object.entries(dicts[lang]).filter(([, value]) => typeof value !== 'string' || value.trim() === '');
    assert.deepEqual(bad.map(([key]) => key), [], `${lang} has empty values`);
  }
  const invalid = enKeys.filter((key) => !(
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(key) || /^errors\.[A-Z][A-Z0-9_]*$/u.test(key)
  ));
  assert.deepEqual(invalid, [], `invalid key syntax: ${invalid.slice(0, 5).join(',')}`);
  t.diagnostic(`en keys=${enKeys.length}`);
});

test('占位符跨语言一致：同一 key 的 {name} 集合与 en 完全相同', () => {
  const mismatches = [];
  for (const key of Object.keys(en)) {
    const expected = placeholdersOf(en[key]).join(',');
    for (const lang of LANGS.slice(1)) {
      const actual = placeholdersOf(dicts[lang][key]).join(',');
      if (expected !== actual) mismatches.push(`${key}@${lang}: en=[${expected}] ${lang}=[${actual}]`);
    }
  }
  assert.deepEqual(mismatches, [], `placeholder mismatch: ${mismatches.slice(0, 5).join(' | ')}`);
});

test('en 零 CJK：白名单恰好 3 个 key（品牌中文名 + 2 个语言原生名）', () => {
  const WHITELIST = ['app.product-zh', 'settings.enum.ui.locale.ja', 'settings.enum.ui.locale.zh-cn'];
  const hits = Object.entries(en).filter(([, value]) => HAN.test(String(value))).map(([key]) => key);
  assert.deepEqual(hits.sort(), [...WHITELIST].sort(), `en CJK whitelist drifted: ${hits.join(',')}`);
  assert.equal(en['app.product-zh'], '网域智防', '产品中文专名必须原样保留');
  assert.equal(en['settings.enum.ui.locale.ja'], '日本語');
  assert.equal(en['settings.enum.ui.locale.zh-cn'], '简体中文');
});

test('回落链：locale=en 缺 key 绝不回落 zh-CN（即使 zh-CN 已加载）；ja 同理；zh-CN 仍回落 en', async () => {
  const { createI18n } = await import(pathToFileURL(path.join(REPO_ROOT, 'apps', 'console-next', 'js', 'i18n.js')).href);
  const basePath = 'http://fallback-fixture.invalid/locales/';
  const fixtureFetch = (tables) => async (url) => {
    const name = decodeURIComponent(String(url).split('/').pop().replace(/\.json$/u, ''));
    const table = tables[name];
    if (table === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => table };
  };
  const zhOnly = { 'probe.zh-only': '只有中文的探针文案' };
  const enOnly = { 'probe.en-only': 'English probe text' };

  const enI18n = createI18n({ locale: 'en', basePath, fetchImpl: fixtureFetch({ en: enOnly, 'zh-CN': zhOnly }), warnMissing: false });
  await enI18n.ready();
  await enI18n.load('zh-CN'); // 故意把中文词典加载进来：回落链也不许用它
  assert.equal(enI18n.t('probe.zh-only'), '[missing:probe.zh-only]', 'locale=en must render [missing:] not Chinese');
  assert.doesNotMatch(enI18n.t('probe.zh-only'), HAN, 'locale=en must never render Han characters');
  assert.equal(enI18n.t('probe.en-only'), 'English probe text');

  const jaI18n = createI18n({ locale: 'ja', basePath, fetchImpl: fixtureFetch({ ja: {}, en: enOnly, 'zh-CN': zhOnly }), warnMissing: false });
  await jaI18n.ready();
  await jaI18n.load('zh-CN');
  assert.equal(jaI18n.t('probe.zh-only'), '[missing:probe.zh-only]', 'locale=ja must never fall back to zh-CN');

  const zhI18n = createI18n({ locale: 'zh-CN', basePath, fetchImpl: fixtureFetch({ 'zh-CN': {}, en: enOnly }), warnMissing: false });
  await zhI18n.ready();
  assert.equal(zhI18n.t('probe.en-only'), 'English probe text', 'zh-CN must still fall back to en');
});

test(`5 语言真翻译 ≥ ${MIN_TRANSLATED} 条，meta 数字与磁盘逐字一致，且不虚报"全量"`, (t) => {
  for (const lang of MACHINE) {
    const coverage = coverageOf(lang);
    assert.ok(coverage.translated >= MIN_TRANSLATED, `${lang} translated ${coverage.translated} < ${MIN_TRANSLATED}`);
    const meta = readMeta(lang);
    assert.equal(meta._machine, true, `${lang} must be _machine:true`);
    assert.equal(meta._source, 'en');
    const note = String(meta._note ?? '');
    const match = note.match(/(\d+)\/(\d+) keys translated \(([\d.]+)%\)/u);
    assert.ok(match, `${lang}.meta.json _note must carry real numbers: ${JSON.stringify(note)}`);
    assert.equal(Number(match[1]), coverage.translated, `${lang} meta says ${match[1]} but disk has ${coverage.translated}`);
    assert.equal(Number(match[2]), coverage.total);
    assert.ok(Math.abs(Number(match[3]) - Number(coverage.percent.toFixed(1))) < 0.05, `${lang} meta percent ${match[3]} vs disk ${coverage.percent.toFixed(1)}`);
    // 未全量时禁止"已全量"措辞
    if (coverage.translated < coverage.total) {
      assert.doesNotMatch(note, /100\.0?%|complete|all keys|fully/iu, `${lang} claims completeness falsely: ${note}`);
    }
    if (meta._coverage) {
      assert.equal(meta._coverage.translated, coverage.translated, `${lang}.meta._coverage drift`);
      assert.equal(meta._coverage.total, coverage.total);
    }
    t.diagnostic(`${lang}: ${coverage.translated}/${coverage.total} (${coverage.percent.toFixed(1)}%)`);
  }
});

test('目标语言脚本证据：已翻译子集里 ja/ko/ru/th 必须有本语言脚本，es 至少 50 条带重音', (t) => {
  const diagnostics = {};
  for (const lang of ['ja', 'ko', 'ru', 'th']) {
    const dict = dicts[lang];
    const translatedKeys = Object.keys(en).filter((key) => dict[key] !== en[key]);
    const hits = translatedKeys.filter((key) => SCRIPT[lang].test(dict[key]));
    assert.ok(hits.length >= 100, `${lang}: only ${hits.length} translated values contain ${lang} script`);
    diagnostics[lang] = hits.length;
  }
  const esAccent = Object.keys(en).filter((key) => dicts.es[key] !== en[key] && /[áéíóúñü¿¡]/iu.test(dicts.es[key])).length;
  assert.ok(esAccent >= 50, `es: only ${esAccent} translated values carry Spanish accents`);
  diagnostics.es = esAccent;
  t.diagnostic(JSON.stringify(diagnostics));
});

test('中文泄漏：机翻语言不得整句照抄 zh-CN（zh 自己已翻译的 ≥6 字条目）', () => {
  const zh = dicts['zh-CN'];
  const offenders = [];
  for (const lang of MACHINE) {
    for (const key of Object.keys(en)) {
      if (key === 'app.product-zh' || key.startsWith('settings.enum.ui.locale.')) continue;
      const zhValue = zh[key];
      if (typeof zhValue !== 'string' || zhValue === en[key]) continue;
      if (zhValue.length >= 6 && dicts[lang][key] === zhValue) offenders.push(`${key}@${lang}`);
    }
  }
  assert.deepEqual(offenders, [], `zh-CN copied into machine locales: ${offenders.slice(0, 8).join(', ')}`);
});

test('README 覆盖率表与磁盘一致（防"README 写已翻译、磁盘还是英文"）', () => {
  const readme = fs.readFileSync(path.join(I18N_DIR, 'README.md'), 'utf8');
  for (const lang of MACHINE) {
    const coverage = coverageOf(lang);
    const row = new RegExp(`\\|\\s*\`${lang}\`\\s*\\|\\s*(\\d+)\\s*/\\s*(\\d+)\\s*\\|\\s*([\\d.]+)%`, 'u').exec(readme);
    assert.ok(row, `README missing coverage row for ${lang}`);
    assert.equal(Number(row[1]), coverage.translated, `README ${lang} translated ${row[1]} ≠ disk ${coverage.translated}`);
    assert.equal(Number(row[2]), coverage.total);
    assert.ok(Math.abs(Number(row[3]) - Number(coverage.percent.toFixed(1))) < 0.05, `README ${lang} percent ${row[3]} ≠ disk ${coverage.percent.toFixed(1)}`);
  }
  // 排除"禁止写已全量翻译"这类**禁止性措辞**（它们本身是否定句），只抓真正的声称。
  const claims = readme.split(/\r?\n/u)
    .filter((line) => /已全量翻译|fully translated/iu.test(line))
    .filter((line) => !/禁止|不得|不是|未|must not|do not/iu.test(line));
  assert.deepEqual(claims, [], `README claims full translation: ${claims.join(' | ')}`);
});

test('`node scripts/i18n-check.mjs --json`：exit 0、error=0、coverage/回落探针与磁盘一致', (t) => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'i18n-check.mjs'), '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180000,
  });
  assert.equal(result.status, 0, `i18n-check --json must exit 0; stderr=${(result.stderr ?? '').slice(-1000)}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.errorCount, 0);
  assert.ok(payload.coverage && payload.coverage.en, 'payload must carry coverage');
  for (const lang of MACHINE) {
    const coverage = coverageOf(lang);
    assert.equal(payload.coverage[lang].translated, coverage.translated, `checker coverage ${lang} mismatch`);
  }
  assert.ok(payload.fallbackChain, 'checker must report runtime fallback probe');
  assert.equal(payload.fallbackChain.en, '[missing:probe.zh-only]', 'checker probe: locale=en must be [missing:]');
  assert.equal(payload.fallbackChain.ja, '[missing:probe.zh-only]', 'checker probe: locale=ja must be [missing:]');
  assert.equal(payload.fallbackChain['zh-CN'], 'English probe text', 'checker probe: zh-CN must fall back to en');
  t.diagnostic(`checker json: keys=${JSON.stringify(payload.keyCounts)} warnings=${payload.warningCount}`);
});
