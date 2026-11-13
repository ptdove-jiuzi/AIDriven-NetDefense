/**
 * lib.mjs — i18n 词条工具公共库（写域：apps/console-next/i18n/tools/**）
 *
 * 目标：locale 文件是**大 JSON**，一律用脚本改，不手改 1000 行。
 * 本库提供：读取 / 稳定写回（保持 en 的 key 顺序）/ 覆盖率统计 / meta 与 README 同步。
 *
 * 作者：PT-dove
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 词条根目录。`T3_I18N_DIR` 仅用于自测/夹具（把 locales 复制到临时目录后演练合并，不碰产品文件）。 */
export const I18N_DIR = process.env.T3_I18N_DIR ? path.resolve(process.env.T3_I18N_DIR) : path.resolve(HERE, '..');
export const LOCALES_DIR = path.join(I18N_DIR, 'locales');
export const REPO_ROOT = path.resolve(I18N_DIR, '..', '..', '..');

export const LOCALES = Object.freeze(['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']);
export const BASE_LOCALE = 'en';
/** 需要真翻译的 5 个语言（en/zh-CN 是源语言）。 */
export const MACHINE_LOCALES = Object.freeze(['ja', 'ko', 'es', 'ru', 'th']);

/** 目标语言脚本特征：用来给"真翻译"提供第二证据（不只是"与 en 不同"）。 */
export const SCRIPT_PATTERN = Object.freeze({
  ja: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u,
  ko: /[\uac00-\ud7af]/u,
  es: /[áéíóúñü¿¡]/iu,
  ru: /[\u0400-\u04ff]/u,
  th: /[\u0e00-\u0e7f]/u,
});

export const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;
/** 仅汉字（判断"en 里混入中文"用；假名/谚文不算中文）。与 scripts/i18n-check.mjs 口径一致。 */
export const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/** en 里允许保留 CJK 的 key（白名单必须最小且显式）。 */
export const EN_CJK_WHITELIST = Object.freeze({
  'app.product-zh': '产品中文专名「网域智防」（合同 §7.1；产品名不是待译文案）',
  'settings.enum.ui.locale.ja': '语言原生名 日本語（语言切换列表按 native name 展示）',
  'settings.enum.ui.locale.zh-cn': '语言原生名 简体中文（同上）',
});

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 稳定写回：2 空格缩进 + 末尾换行 + 按给定 key 顺序（默认 en 顺序）。 */
export function writeJsonLike(file, dict, keyOrder) {
  const order = keyOrder ?? Object.keys(dict);
  const out = {};
  for (const key of order) {
    if (Object.prototype.hasOwnProperty.call(dict, key)) out[key] = dict[key];
  }
  for (const key of Object.keys(dict)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = dict[key];
  }
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return file;
}

export function localePath(locale, dir = LOCALES_DIR) {
  return path.join(dir, `${locale}.json`);
}

export function metaPath(locale, dir = LOCALES_DIR) {
  return path.join(dir, `${locale}.meta.json`);
}

export function loadLocale(locale, dir = LOCALES_DIR) {
  return readJson(localePath(locale, dir));
}

export function loadAll(dir = LOCALES_DIR) {
  return Object.fromEntries(LOCALES.map((locale) => [locale, loadLocale(locale, dir)]));
}

export function placeholdersOf(value) {
  const names = new Set();
  for (const match of String(value).matchAll(/\{([A-Za-z0-9_]+)\}/gu)) names.add(match[1]);
  return [...names].sort();
}

/**
 * 覆盖率统计（诚实口径）：
 *  - translated = 与 en **值不同** 的 key 数（这是"不是英文占位"的可证证据）
 *  - scriptHits = 值里出现目标语言脚本特征的 key 数（第二证据；es 用重音符号，天然偏低）
 *  - 全部 key 数 total（= en key 数）
 */
export function coverageOf(en, dict, locale) {
  const keys = Object.keys(en);
  const pattern = SCRIPT_PATTERN[locale];
  let translated = 0;
  let scriptHits = 0;
  const namespaces = new Map();
  for (const key of keys) {
    const value = dict[key];
    const namespace = key.split('.')[0];
    const bucket = namespaces.get(namespace) ?? { total: 0, translated: 0 };
    bucket.total += 1;
    if (typeof value === 'string' && value !== en[key]) {
      translated += 1;
      bucket.translated += 1;
      if (pattern && pattern.test(value)) scriptHits += 1;
    }
    namespaces.set(namespace, bucket);
  }
  const total = keys.length;
  return {
    locale,
    total,
    translated,
    identical: total - translated,
    ratio: total === 0 ? 0 : translated / total,
    percent: total === 0 ? '0.0' : ((translated / total) * 100).toFixed(1),
    scriptHits,
    namespaces,
  };
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

/** ISO 秒级 UTC（meta `_updated` 用）。 */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** 生成机翻语言的诚实 meta（绝不写"已全量翻译"）。 */
export function buildMachineMeta(locale, coverage, extra = {}) {
  const { total, translated, percent } = coverage;
  const pending = total - translated;
  return {
    _machine: true,
    _source: 'en',
    _updated: nowIso(),
    _note: `partial machine translation: ${translated}/${total} keys translated (${percent}%); the remaining ${pending} keys are English placeholders pending translation`,
    ...extra,
  };
}
