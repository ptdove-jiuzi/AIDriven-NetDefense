#!/usr/bin/env node
/**
 * apply-translations.mjs — 把人工译文表并入 5 个机翻语言（ja/ko/es/ru/th）。
 *
 * 语义（诚实优先）：
 *  - 译文表里有的 key → 目标语言真译文；
 *  - 译文表里没有的 key → **保持 en 英文占位**（不是"已翻译"）；
 *  - meta 的 `_note` 按磁盘真实覆盖率生成（`N/M keys translated (P%)`），绝不写"已全量翻译"；
 *  - README 的规模/覆盖率表由脚本重写（与磁盘一致）。
 *
 * 校验（任一不通过即 exit 1，不落盘）：
 *  1. 译文 key 必须存在于 en.json；
 *  2. 译文非空、必须是字符串；
 *  3. `{name}` 占位符集合必须与 en 完全一致；
 *  4. 目标语言值不得整句照抄 zh-CN（中文泄漏），en 值不得含 CJK（白名单除外）。
 *
 * 用法：
 *   node apps/console-next/i18n/tools/apply-translations.mjs --dry-run
 *   node apps/console-next/i18n/tools/apply-translations.mjs
 *   node apps/console-next/i18n/tools/apply-translations.mjs --table tools/translations/visible-core.json
 *
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  EN_CJK_WHITELIST,
  HERE,
  MACHINE_LOCALES,
  buildMachineMeta,
  coverageOf,
  loadAll,
  loadLocale,
  localePath,
  metaPath,
  placeholdersOf,
  readJson,
  sha256File,
  writeJsonLike,
} from './lib.mjs';
import { syncReadme } from './sync-readme.mjs';

const TABLES_DIR = path.join(HERE, 'translations');

function parseArgs(argv) {
  const options = { dryRun: false, tables: [], noMeta: false, noReadme: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--no-meta') options.noMeta = true;
    else if (argument === '--no-readme') options.noReadme = true;
    else if (argument === '--quiet') options.quiet = true;
    else if (argument === '--table') {
      const value = argv[index + 1];
      if (!value) throw new Error('--table 需要文件路径');
      options.tables.push(path.resolve(process.cwd(), value));
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write('node apply-translations.mjs [--dry-run] [--table <json>]... [--no-meta] [--no-readme]\n');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (options.tables.length === 0) {
    options.tables = fs.readdirSync(TABLES_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(TABLES_DIR, name));
  }
  return options;
}

/** 读取并合并所有译文表；重复 key 以后读到的表为准（后者覆盖）。 */
function readTables(files) {
  /** @type {Map<string, Record<string,string>>} */
  const merged = new Map();
  const provenance = [];
  for (const file of files) {
    const table = readJson(file);
    let entries = 0;
    for (const [key, value] of Object.entries(table)) {
      if (key === '_meta') continue;
      entries += 1;
      merged.set(key, value);
    }
    provenance.push({ file: path.relative(process.cwd(), file), entries });
  }
  return { merged, provenance };
}

/**
 * 译文表校验。
 *
 * 语言脚本规则（避免"把合法日文汉字当泄漏"的假红）：
 *  - ja：汉字 + 假名合法；判红只看"整句照抄 zh-CN"；
 *  - ko/es/ru/th：不应出现汉字（현대 한국어 UI 不用汉자；es/ru/th 更不该有），
 *    白名单只允许产品专名「网域智防」；
 *  - 所有机翻语言：与 zh-CN 同值（整句照抄）或含 ≥8 字连续 zh-CN 片段 → 判红。
 */
function validate(en, merged) {
  const problems = [];
  const zhCN = loadLocale('zh-CN');
  const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const noHanLocales = new Set(['ko', 'es', 'ru', 'th']);
  for (const [key, value] of merged) {
    if (!Object.prototype.hasOwnProperty.call(en, key)) {
      problems.push(`TABLE_KEY_UNKNOWN ${key}（en.json 没有这个 key）`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`TABLE_VALUE_SHAPE ${key}（译文必须是 {locale: string} 对象）`);
      continue;
    }
    const expected = placeholdersOf(en[key]).join(',');
    const zh = typeof zhCN[key] === 'string' ? zhCN[key] : '';
    for (const locale of Object.keys(value)) {
      if (!MACHINE_LOCALES.includes(locale)) {
        problems.push(`TABLE_LOCALE_UNKNOWN ${key} → ${locale}`);
        continue;
      }
      const text = value[locale];
      if (typeof text !== 'string' || text.trim() === '') {
        problems.push(`TABLE_VALUE_EMPTY ${key}@${locale}`);
        continue;
      }
      const actual = placeholdersOf(text).join(',');
      if (expected !== actual) {
        problems.push(`TABLE_PLACEHOLDER ${key}@${locale}：en=[${expected}] 实际=[${actual}]`);
      }
      const brandOnly = /^网域智防$/u.test(text);
      if (noHanLocales.has(locale) && HAN.test(text) && !brandOnly) {
        problems.push(`TABLE_HAN_LEAK ${key}@${locale}：${locale} 译文出现汉字「${text.slice(0, 30)}」`);
      }
      // 与 zh-CN 完全同值：**日文短汉字词**（停止/分析/更新/保存/高/低…）是共享汉字，
      // 属合法日文而非抄袭；sentence 级别的同值才是未翻译。规则显式写在这里，便于复核。
      const shortSharedKanjiLabel = locale === 'ja' && text.length <= 4 && !/[。、，；：！？]/u.test(text);
      if (zh !== '' && text === zh) {
        if (!shortSharedKanjiLabel) problems.push(`TABLE_ZH_COPY ${key}@${locale}：译文与 zh-CN 完全相同（未翻译）`);
      } else if (zh.length >= 8) {
        // 只把「连续 8 个以上纯汉字」的 zh 片段当抄袭证据；标点/占位符/数字不参与。
        for (let start = 0; start + 8 <= zh.length; start += 1) {
          const piece = zh.slice(start, start + 8);
          if (/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{8}$/u.test(piece) && text.includes(piece)) {
            problems.push(`TABLE_ZH_FRAGMENT ${key}@${locale}：译文含 zh-CN 原文片段「${piece}」`);
            break;
          }
        }
      }
    }
  }
  // en 值自检：白名单外不得含**汉字**（防止把漏翻塞进 en）
  for (const [key, text] of Object.entries(en)) {
    if (HAN.test(String(text)) && !Object.prototype.hasOwnProperty.call(EN_CJK_WHITELIST, key)) {
      problems.push(`EN_CJK_LEAK ${key}：en 值含汉字且不在白名单`);
    }
  }
  return problems;
}

export function applyTranslations(options = {}) {
  const dryRun = options.dryRun === true;
  const tables = options.tables ?? fs.readdirSync(TABLES_DIR).filter((n) => n.endsWith('.json')).sort()
    .map((name) => path.join(TABLES_DIR, name));
  const en = loadLocale('en');
  const { merged, provenance } = readTables(tables);
  const problems = validate(en, merged);
  if (problems.length > 0) {
    return { ok: false, problems, provenance, applied: 0 };
  }

  const enKeys = Object.keys(en);
  const before = Object.fromEntries(MACHINE_LOCALES.map((locale) => [locale, coverageOf(en, loadLocale(locale), locale)]));
  const after = {};
  const written = [];

  for (const locale of MACHINE_LOCALES) {
    const current = loadLocale(locale);
    const next = {};
    for (const key of enKeys) {
      const translation = merged.get(key)?.[locale];
      next[key] = typeof translation === 'string' ? translation : (typeof current[key] === 'string' && current[key] !== en[key] ? current[key] : en[key]);
    }
    const coverage = coverageOf(en, next, locale);
    after[locale] = coverage;
    if (!dryRun) {
      const file = localePath(locale);
      const shaBefore = sha256File(file);
      writeJsonLike(file, next, enKeys);
      written.push({ file, locale, shaBefore, shaAfter: sha256File(file) });
      if (!options.noMeta) {
        const meta = buildMachineMeta(locale, coverage, {
          _coverage: {
            translated: coverage.translated,
            total: coverage.total,
            percent: Number(coverage.percent),
            scriptHits: coverage.scriptHits,
            basis: 'translated = value differs from en (English placeholder otherwise)',
          },
        });
        fs.writeFileSync(metaPath(locale), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      }
    }
  }

  let readme = null;
  if (!dryRun && !options.noReadme) {
    readme = syncReadme({});
  }

  return {
    ok: true,
    problems: [],
    provenance,
    tableKeys: merged.size,
    applied: provenance.reduce((sum, item) => sum + item.entries, 0),
    before,
    after,
    written,
    readme,
    dryRun,
  };
}

function printReport(result) {
  if (!result.ok) {
    process.stdout.write(`apply-translations: FAIL — 译文表校验失败（未落盘）\n`);
    for (const problem of result.problems) process.stdout.write(`  ${problem}\n`);
    return;
  }
  process.stdout.write(`apply-translations: tables=${result.provenance.map((p) => `${p.file}(${p.entries})`).join(' ')}\n`);
  process.stdout.write('locale  before            after             script-hits\n');
  for (const locale of MACHINE_LOCALES) {
    const before = result.before[locale];
    const after = result.after[locale];
    process.stdout.write(
      `${locale.padEnd(6)}  ${`${before.translated}/${before.total} (${before.percent}%)`.padEnd(18)}`
      + `${`${after.translated}/${after.total} (${after.percent}%)`.padEnd(18)}${after.scriptHits}\n`,
    );
  }
  if (result.dryRun) process.stdout.write('apply-translations: DRY RUN — 未写盘\n');
  else for (const item of result.written) process.stdout.write(`wrote ${path.relative(process.cwd(), item.file)}  ${item.shaBefore} -> ${item.shaAfter}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = applyTranslations(options);
    if (!options.quiet) printReport(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`apply-translations: ${error.message}\n`);
    process.exitCode = 2;
  }
}
