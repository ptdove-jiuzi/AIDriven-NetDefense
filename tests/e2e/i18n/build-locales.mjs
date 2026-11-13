#!/usr/bin/env node
/**
 * tests/e2e/i18n/build-locales.mjs — INT-2 / i18n 席
 *
 * 唯一构建入口：把 `catalog/*.mjs` 的人工词条 + schema 快照推导出的字段词条，
 * 合并成 `apps/console-next/i18n/locales/<locale>.json`（扁平点键）。
 *
 * 为什么用构建脚本而不是手写 JSON：
 *   1. en / zh-CN 的 key 集合与占位符集合在这里**硬校验**，不可能漂移；
 *   2. 设置页大量 key 由 daemon schema 形状决定（labelKey/hintKey/枚举/子字段/索引行），
 *      手写必然漏；这里按 schema 快照推导，漏一个就报错；
 *   3. 另外 5 个 locale 从 en 落盘（0.0.1 只要求不 404），保证 7 个文件 key 集合一致。
 *
 * 用法：
 *   node tests/e2e/i18n/build-locales.mjs            # 校验 + 写盘
 *   node tests/e2e/i18n/build-locales.mjs --check    # 只校验，不写盘（CI/复跑用）
 *   node tests/e2e/i18n/build-locales.mjs --json     # 机器可读摘要
 *
 * 退出码：0 通过；1 校验失败；2 用法错误。
 *
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { en as viewsEn, zh as viewsZh } from './catalog/views.mjs';
import { en as settingsEn, zh as settingsZh } from './catalog/settings.mjs';
import {
  ENUM_PATH_OVERRIDES,
  ENUM_VALUE_TEXT,
  EXTRA_ENUM_DERIVATIONS,
  EXTRA_ENUM_SOURCE,
  INDEX_RANGE,
  en as schemaEn,
  zh as schemaZh,
} from './catalog/schema-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const LOCALES_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'i18n', 'locales');
const SNAPSHOT_FILE = path.join(HERE, 'schema-snapshot.json');

/** 合同 §8.1/§8.2：7 语言；en 与 zh-CN 必须 100% 完整，其余 5 个从 en 落盘。 */
export const ALL_LOCALES = Object.freeze(['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']);
export const FALLBACK_FROM_EN = Object.freeze(['ja', 'ko', 'es', 'ru', 'th']);

/** 合同 §8.3 key 语法（唯一例外 errors.<UPPER_SNAKE>）。 */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;
const ERROR_CODE_PATTERN = /^errors\.[A-Z][A-Z0-9_]*$/u;
const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/gu;

/** en.json 里允许出现 CJK 的 key（品牌名/语言原生名，不是遗漏翻译）。 */
export const EN_CJK_ALLOWED = Object.freeze([
  'app.product-zh',
  'settings.enum.ui.locale.zh-cn',
  'settings.enum.ui.locale.ja',
  'settings.enum.ui.locale.ko',
  'settings.enum.ui.locale.ru',
  'settings.enum.ui.locale.th',
]);

/* ------------------------------------------------------------------ */
/* 形状工具（与 apps/console-next/js/views/settings/shared.js 逐字一致） */
/* ------------------------------------------------------------------ */

/** shared.js:toKebab —— 必须与运行时实现完全一致，否则 key 对不上。 */
export function toKebab(value) {
  return String(value == null ? '' : value)
    .replace(/\[(\d+)\]/gu, '.$1')
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/(^|\.)-+/gu, '$1')
    .replace(/-+(?=\.|$)/gu, '');
}

/** shared.js:keyPath —— settings 文档路径 → i18n key 片段。 */
export function keyPath(value) {
  return String(value == null ? '' : value)
    .replace(/\[(\d+)\]/gu, '.$1')
    .split('.')
    .map((segment) => toKebab(segment))
    .filter(Boolean)
    .join('.');
}

function placeholdersOf(value) {
  const found = [];
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER_PATTERN.exec(value)) !== null) found.push(match[1]);
  return found.sort();
}

/* ------------------------------------------------------------------ */
/* 从 schema 快照推导 key                                               */
/* ------------------------------------------------------------------ */

function enumValuesOf(item) {
  if (Array.isArray(item.values)) return item.values.map(String);
  if (Array.isArray(item.enum)) return item.enum.map(String);
  return [];
}

function defaultValueKeys(item) {
  const value = item.default;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value);
  return [];
}

/**
 * 按 schema 快照生成所有"形状派生"的 key（含需要人工文本的 key）。
 *
 * @param {object} schema `GET /api/v1/settings/schema` 的响应体
 * @param {(key: string) => string[]} enumTextFor 取某个枚举 key 的 [en, zh]
 * @returns {{derived: Map<string, {en: string, zh: string}>, requiredText: Set<string>}}
 */
export function deriveSchemaKeys(schema, enumTextFor) {
  const derived = new Map();
  const requiredText = new Set();
  const addDerived = (key, pair) => {
    if (derived.has(key)) return;
    derived.set(key, pair);
  };

  const walkItems = (items) => {
    for (const item of items ?? []) {
      if (typeof item.labelKey === 'string' && item.labelKey !== '') requiredText.add(item.labelKey);
      if (typeof item.hintKey === 'string' && item.hintKey !== '') requiredText.add(item.hintKey);
      const itemSlug = keyPath(item.path);
      const values = enumValuesOf(item);
      const fields = Array.isArray(item.fields) ? item.fields : [];

      // 1. 枚举 / 多选（值域来自 schema.values）
      if (values.length > 0 && fields.length === 0) {
        for (const value of values) {
          addDerived(`settings.enum.${itemSlug}.${toKebab(value)}`, enumTextFor(`settings.enum.${itemSlug}`, value));
        }
      }

      // 2. object[] 子字段标签 + 行内枚举（设置页用带索引的 path 查表，见 shared.js objectRow）
      for (const field of fields) {
        if (typeof field.name !== 'string' || field.name === '') continue;
        const fieldSlug = toKebab(field.name);
        requiredText.add(`settings.field.${itemSlug}.${fieldSlug}`);
        const fieldValues = Array.isArray(field.values) ? field.values.map(String) : [];
        if (fieldValues.length === 0) continue;
        for (let index = 0; index < INDEX_RANGE; index += 1) {
          for (const value of fieldValues) {
            const key = `settings.enum.${itemSlug}.${index}.${fieldSlug}.${toKebab(value)}`;
            addDerived(key, enumTextFor(`settings.enum.${itemSlug}.${fieldSlug}`, value));
          }
        }
      }

      // 3. keyed object（severityMapping / actionMatrix）：keyedObjectEditor
      const keyedKeys = defaultValueKeys(item);
      if (keyedKeys.length > 0) {
        const candidates = item.path === 'response.actionMatrix'
          ? (Array.isArray(schema.actionCatalog) ? schema.actionCatalog.map((entry) => String(entry.id)) : [])
          : keyedKeys;
        for (const key of keyedKeys) {
          requiredText.add(`settings.keyed.${itemSlug}.${toKebab(key)}`);
        }
        for (const key of keyedKeys) {
          const rowSlug = `${itemSlug}.${toKebab(key)}`;
          const options = item.path === 'response.actionMatrix' ? ['allow', 'needs_approval', 'deny'] : candidates;
          for (const candidate of options) {
            addDerived(`settings.enum.${rowSlug}.${toKebab(candidate)}`, enumTextFor(`settings.enum.${rowSlug}`, candidate));
          }
        }
      }

      walkItems(item.items);
    }
  };

  for (const group of schema.groups ?? []) {
    requiredText.add(`settings.group.${toKebab(String(group.id))}`);
    walkItems(group.items);
  }

  // 源码里写死 path 的 enumLabel 调用点（schema 推导不出来，见 EXTRA_ENUM_SOURCE）
  for (const extra of EXTRA_ENUM_DERIVATIONS) {
    const slug = keyPath(extra.path);
    for (const value of extra.values) {
      addDerived(`settings.enum.${slug}.${toKebab(value)}`, enumTextFor(`settings.enum.${slug}`, value));
    }
  }
  return { derived, requiredText };
}

/* ------------------------------------------------------------------ */
/* 合并 / 校验                                                          */
/* ------------------------------------------------------------------ */

function makeEnumTextFor() {
  return (slugPrefix, value) => {
    const valueSlug = toKebab(value);
    const overrides = ENUM_PATH_OVERRIDES[slugPrefix] ?? {};
    const override = overrides[valueSlug] ?? overrides[value];
    if (override) return { en: override[0], zh: override[1] };
    const pair = ENUM_VALUE_TEXT[valueSlug];
    if (!pair) return { en: valueSlug, zh: valueSlug, missingText: true };
    return { en: pair[0], zh: pair[1] };
  };
}

/**
 * 构建七语言词条表并返回校验结果（不写盘）。
 */
export function buildTables() {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  const schema = snapshot.schema ?? snapshot;
  const enumTextFor = makeEnumTextFor();
  const { derived, requiredText } = deriveSchemaKeys(schema, enumTextFor);

  const en = { ...viewsEn, ...settingsEn, ...schemaEn };
  const zh = { ...viewsZh, ...settingsZh, ...schemaZh };
  const errors = [];
  const warnings = [];

  // 派生 key 合入（en/zh 同源文本对）
  const missingEnumText = [];
  for (const [key, pair] of derived) {
    if (!(key in en)) en[key] = pair.en;
    if (!(key in zh)) zh[key] = pair.zh;
    if (pair.missingText) missingEnumText.push(key);
  }
  if (missingEnumText.length > 0) {
    warnings.push(`枚举值缺少人工文案 ${missingEnumText.length} 条（已回退为值名）：${missingEnumText.slice(0, 8).join(', ')}`);
  }

  // schema 要求但 catalog 没写的文本
  const missingRequiredText = [...requiredText].filter((key) => !(key in en)).sort();
  if (missingRequiredText.length > 0) {
    errors.push(`schema 下发的 key 缺英文文案 ${missingRequiredText.length} 条：${missingRequiredText.slice(0, 12).join(', ')}`);
  }
  const missingRequiredZh = [...requiredText].filter((key) => !(key in zh)).sort();
  if (missingRequiredZh.length > 0) {
    errors.push(`schema 下发的 key 缺中文文案 ${missingRequiredZh.length} 条：${missingRequiredZh.slice(0, 12).join(', ')}`);
  }

  // key 集合一致性
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  const onlyEn = enKeys.filter((key) => !(key in zh));
  const onlyZh = zhKeys.filter((key) => !(key in en));
  if (onlyEn.length > 0) errors.push(`zh-CN 缺 ${onlyEn.length} 个 key：${onlyEn.slice(0, 12).join(', ')}`);
  if (onlyZh.length > 0) errors.push(`zh-CN 多 ${onlyZh.length} 个 key：${onlyZh.slice(0, 12).join(', ')}`);

  for (const key of enKeys) {
    if (!KEY_PATTERN.test(key) && !ERROR_CODE_PATTERN.test(key)) errors.push(`非法 key 语法：${key}`);
    const enValue = en[key];
    const zhValue = zh[key];
    if (typeof enValue !== 'string') errors.push(`en 值不是字符串：${key}`);
    if (typeof zhValue !== 'string') errors.push(`zh 值不是字符串：${key}`);
    if (typeof enValue === 'string' && enValue.trim() === '') errors.push(`en 空值：${key}`);
    if (typeof zhValue === 'string' && zhValue.trim() === '') errors.push(`zh 空值：${key}`);
    if (typeof enValue === 'string' && /<[a-z/][^>]*>/iu.test(enValue)) errors.push(`en 值含 HTML：${key}`);
    if (typeof zhValue === 'string' && /<[a-z/][^>]*>/iu.test(zhValue)) errors.push(`zh 值含 HTML：${key}`);
    if (typeof enValue === 'string' && typeof zhValue === 'string') {
      const enPh = placeholdersOf(enValue);
      const zhPh = placeholdersOf(zhValue);
      if (enPh.join(',') !== zhPh.join(',')) {
        errors.push(`占位符不一致 ${key}：en=[${enPh.join(',')}] zh=[${zhPh.join(',')}]`);
      }
    }
  }

  // zh-CN 必须真的翻译过（除显式豁免：品牌名、纯符号值）
  const zhCjkExempt = new Set(['app.product-zh', 'app.title', 'common.value.unavailable', 'alerts.value.unavailable']);
  const notTranslated = enKeys.filter((key) => {
    if (zhCjkExempt.has(key)) return false;
    const value = zh[key];
    return typeof value === 'string' && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(value);
  });
  if (notTranslated.length > 0) {
    warnings.push(`zh-CN 无中日韩字符 ${notTranslated.length} 条（多为术语/协议名）：${notTranslated.slice(0, 12).join(', ')}`);
  }

  // en 不得含 CJK（白名单除外）
  const enCjk = enKeys.filter((key) => {
    if (EN_CJK_ALLOWED.includes(key)) return false;
    return /[\u3400-\u9fff]/u.test(en[key]);
  });
  if (enCjk.length > 0) errors.push(`en 含 CJK ${enCjk.length} 条：${enCjk.slice(0, 12).join(', ')}`);

  const sortKeys = (table) => {
    const out = {};
    for (const key of Object.keys(table).sort()) out[key] = table[key];
    return out;
  };

  const tables = { en: sortKeys(en), 'zh-CN': sortKeys(zh) };
  // 其余 5 语言：**保留盘上已有译文**（并行翻译体可能已经机翻了一部分），
  // 缺的 key 用 en 补齐。绝不整体覆盖成 en —— 那会抹掉别人的翻译工作。
  const preserve = {};
  for (const locale of FALLBACK_FROM_EN) {
    const file = path.join(LOCALES_DIR, `${locale}.json`);
    const merged = { ...en };
    let kept = 0;
    if (fs.existsSync(file)) {
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        existing = null;
      }
      if (existing !== null && typeof existing === 'object') {
        for (const [key, value] of Object.entries(existing)) {
          if (typeof value !== 'string' || value.trim() === '') continue;
          if (!(key in merged)) continue; // 不在 en 里的多余 key 丢弃（由校验统一管）
          if (value !== en[key]) kept += 1;
          merged[key] = value;
        }
      }
    }
    tables[locale] = sortKeys(merged);
    preserve[locale] = { translated: kept };
  }

  return {
    tables,
    errors,
    warnings,
    preserve,
    stats: {
      enKeys: enKeys.length,
      zhKeys: zhKeys.length,
      derivedKeys: derived.size,
      schemaRequiredText: requiredText.size,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 写盘                                                               */
/* ------------------------------------------------------------------ */

function writeLocales(result) {
  fs.mkdirSync(LOCALES_DIR, { recursive: true });
  const written = [];
  for (const locale of ALL_LOCALES) {
    const table = result.tables[locale];
    const file = path.join(LOCALES_DIR, `${locale}.json`);
    fs.writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
    written.push({ file, keys: Object.keys(table).length });
    // meta 口径**按内容推导**，不写死：
    //   - en / zh-CN：人工撰写；
    //   - 其余语言：translated=0 → 占位副本（_machine:false）；
    //                translated>0 → 部分机翻（_machine:true，note 写明 N/M）。
    const translated = locale === 'en' || locale === 'zh-CN'
      ? Object.keys(table).length
      : (result.preserve?.[locale]?.translated ?? 0);
    const total = Object.keys(table).length;
    let meta;
    if (locale === 'en' || locale === 'zh-CN') {
      meta = {
        _machine: false,
        _source: locale,
        _updated: new Date().toISOString(),
        _note: `hand-written ${locale} catalog; regenerate with tests/e2e/i18n/build-locales.mjs`,
      };
    } else if (translated === 0) {
      meta = {
        _machine: false,
        _source: 'en',
        _updated: new Date().toISOString(),
        _note: 'PLACEHOLDER exact copy of en pending translation (not machine-translated); UI falls back to en for this locale',
      };
    } else {
      meta = {
        _machine: true,
        _source: 'en',
        _updated: new Date().toISOString(),
        _note: `partial machine translation: ${translated}/${total} keys translated; the remaining ${total - translated} keys are English placeholders pending translation`,
      };
    }
    fs.writeFileSync(path.join(LOCALES_DIR, `${locale}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }
  return written;
}

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const json = argv.includes('--json');
  const unknown = argv.filter((arg) => !['--check', '--json'].includes(arg));
  if (unknown.length > 0) {
    process.stderr.write(`未知参数：${unknown.join(' ')}\n`);
    process.exit(2);
  }
  const result = buildTables();
  const written = checkOnly ? [] : writeLocales(result);
  const summary = {
    ok: result.errors.length === 0,
    locale: 'en+zh-CN',
    ...result.stats,
    extraEnumSource: EXTRA_ENUM_SOURCE,
    files: written,
    errors: result.errors,
    warnings: result.warnings,
    localesDir: path.relative(REPO_ROOT, LOCALES_DIR),
    checkedOnly: checkOnly,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const lines = [];
    lines.push(`en key 数：${summary.enKeys}，zh-CN key 数：${summary.zhKeys}，schema 派生：${summary.derivedKeys}，schema 必需文本：${summary.schemaRequiredText}`);
    if (written.length > 0) lines.push(`写入：${written.map((entry) => `${path.basename(entry.file)}(${entry.keys})`).join(' ')}`);
    lines.push(`错误：${result.errors.length}`);
    for (const error of result.errors.slice(0, 40)) lines.push(`  ✗ ${error}`);
    if (result.preserve && Object.keys(result.preserve).length > 0) {
      lines.push(`保留盘上译文：${Object.entries(result.preserve).map(([locale, info]) => `${locale}=${info.translated}`).join(' ')}（0 表示仍是 en 占位）`);
    }
    lines.push(`警告：${result.warnings.length}`);
    for (const warning of result.warnings.slice(0, 20)) lines.push(`  ! ${warning}`);
    lines.push(`结论：${result.errors.length === 0 ? 'PASS' : 'FAIL'}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exit(result.errors.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
