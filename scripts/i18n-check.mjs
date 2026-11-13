#!/usr/bin/env node
/**
 * scripts/i18n-check.mjs — 词条完整性校验（CONSOLE-V2-CONTRACT.md §8 / I18N v1 兼容）
 *
 * 默认校验 WebUI v2 的 `apps/console-next/i18n/locales`（合同 §8.9 的唯一检查入口）：
 *
 *  1. 7 个 `<locale>.json` 存在且 JSON 可解析                  → JSON_PARSE
 *  2. key 集合与 en 完全一致（缺/多都算错）                    → KEY_MISSING / KEY_EXTRA
 *  3. key 语法：全小写 + kebab；唯一例外 `errors.<UPPER_SNAKE>` 与 `errors.unknown`
 *                                                            → KEY_SYNTAX
 *  4. 同一 key 在 7 种语言里的 `{占位符}` 集合完全一致          → PLACEHOLDER_MISMATCH
 *  5. en 的值不得含 CJK（固定品牌名 / 语言原生名白名单除外；`--strict-en-cjk` 关闭白名单）
 *                                                            → EN_CJK
 *  6. `<locale>.meta.json` 存在、可解析、字段合法               → META_INVALID
 *  7. `_machine` 与内容不一致：
 *     - 与 en 相同比例 **> 90% 且 `_machine !== true`** → **error** META_MACHINE_FLAG_MISSING
 *     - 全部相同且 `_machine:true` → META_MACHINE_UNTRANSLATED（warning / --strict error）
 *     - 全部相同且 `_machine:false` → META_UNTRANSLATED_CLAIM（warning / --strict error）
 *     - >90% 但非全部相同 → META_MOSTLY_UNTRANSLATED（透明告警）
 *  8. 空值 / 非字符串值                                        → EMPTY_VALUE / VALUE_TYPE
 *
 * 2026-11-05（UI-POLISH T3）新增/强化（检查 9–13）：
 *
 *  9. en 的 CJK 白名单**最小化且显式**：白名单表里每个 key 必须真实存在于 en 且仍含 CJK
 *     （否则 → EN_CJK_EXEMPT_STALE）；`--strict-en-cjk` 时白名单本身判红（EN_CJK）。
 * 10. 目标语言脚本泄漏：机翻语言的值整句照抄 zh-CN（>6 字且非短汉字词）→ LOCALE_ZH_COPY；
 *     ko/es/ru/th 出现汉字（品牌/语言原生名白名单除外）→ LOCALE_HAN_LEAK。
 * 11. 回落链（静态）：`apps/console-next/js/i18n.js` 的 chain() 不得再含 SECOND_FALLBACK_LOCALE，
 *     且 FALLBACK_LOCALE 必须是 'en'                         → FALLBACK_TO_ZH
 * 12. 回落链（运行期，真模块 + 假 fetch）：构造"只有 zh-CN 有的 key"，
 *     locale=en / locale=ja 必须得到 `[missing:]` 或 **非汉字** 结果；locale=zh-CN 必须仍能回落 en
 *                                                             → FALLBACK_EN_TO_ZH / FALLBACK_JA_TO_ZH / FALLBACK_ZH_NO_EN
 * 13. 覆盖率汇总：每个语言 translated/total/百分比/目标脚本命中数打到 stdout 与 --json
 *     （**如实数字**；不因为有英文占位就假装已翻译）。
 *
 * 退出码（语义明确）：
 *   0 = 通过（可能有 warning）；1 = 有 error；2 = 用法/IO 错误（参数错、目录不可读、模块导入失败）。
 *
 * 兼容 v1：`--profile console-v1` 校验旧 `apps/console/i18n/locales`（I18N.md §9 规则：
 * JSON 可解析、key 集合一致、占位符一致、空值/TODO、目标语言脚本特征、值长度）。
 *
 * 用法：
 *   node scripts/i18n-check.mjs                     # v2 默认目录
 *   node scripts/i18n-check.mjs --json              # 机器可读
 *   node scripts/i18n-check.mjs --dir <localesDir>  # 校验另一套词条（fixture 用）
 *   node scripts/i18n-check.mjs --strict            # 机翻未翻（与 en 全同）算 error
 *   node scripts/i18n-check.mjs --allow-missing     # 缺语言文件只告警（分语言推进用）
 *   node scripts/i18n-check.mjs --profile console-v1 [--dir apps/console/i18n/locales]
 *
 * 退出码：0 通过（可以有 warning）；1 有 error；2 用法/IO 错误。
 *
 * 作者：PT-dove
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

export const LOCALES = Object.freeze(['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']);
export const BASE_LOCALE = 'en';
export const FALLBACK_KEY = 'errors.unknown';

/** v2 key 语法（合同 §8.3 v1.2）。 */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;
/** 唯一例外：错误码命名空间。 */
const ERROR_CODE_PATTERN = /^errors\.[A-Z][A-Z0-9_]*$/u;

/** en 值允许保留 CJK 的 key（固定品牌名 / 语言原生名，均有合同依据）。 */
const EN_CJK_EXEMPT = new Map([
  ['app.product-zh', '品牌中文名固定（合同 §7.1：AIDriven NetDefense / 网域智防）'],
  ['settings.enum.ui.locale.ja', '语言原生名（语言切换器按 native name 显示，合同 §7.1/§8）'],
  ['settings.enum.ui.locale.zh-cn', '语言原生名（同上）'],
]);

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
/** 仅汉字（假名/谚文不算）——用于"中文泄漏"判定。 */
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
/** 目标语言脚本（"真翻译"的第二证据；es 用重音符号，天然偏低）。 */
const TARGET_SCRIPT = Object.freeze({
  ja: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u,
  ko: /[\uac00-\ud7af]/u,
  es: /[áéíóúñü¿¡]/iu,
  ru: /[\u0400-\u04ff]/u,
  th: /[\u0e00-\u0e7f]/u,
});
/** 机翻语言（en/zh-CN 是源语言）。 */
const MACHINE_LOCALES = Object.freeze(['ja', 'ko', 'es', 'ru', 'th']);
/** 汉字在目标语言里必须被白名单放行的 key（品牌专名 + 语言原生名）。 */
const HAN_LEAK_EXEMPT = new Set(['app.product-zh', 'settings.enum.ui.locale.ja', 'settings.enum.ui.locale.zh-cn', 'settings.enum.ui.locale.ko']);
/** 运行时回落链检查用到的模块路径。 */
const I18N_MODULE = path.join(REPO_ROOT, 'apps', 'console-next', 'js', 'i18n.js');
const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/gu;

/** v1 目标语言脚本特征（仅 `--profile console-v1` 使用）。 */
const V1_SCRIPT_PATTERN = {
  'zh-CN': /[\u4e00-\u9fff]/u,
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/u,
  ko: /[\uac00-\ud7af]/u,
  ru: /[\u0400-\u04ff]/u,
  th: /[\u0e00-\u0e7f]/u,
};

const V1_MAX_VALUE_LENGTH = 120;
const V1_LABEL_EN_LIMIT = 24;
const V1_LABEL_RATIO = 1.35;
const V1_LABEL_KEY = /^(nav|chrome|common\.(action|filter|pager)|severity|alert\.status|analysis\.state|settings\.(ui-mode|language|model|budget|diag)|error\.action)\./u;
const V1_NON_LABEL_SUFFIX = /\.(placeholder|note|hint|warning|detail|title|body|scope|sub)$/u;
const V1_SCRIPT_EXEMPT = new Set([
  'overview.meta.schema',
  'overview.meta.health',
  'alerts.col.time',
  'alerts.filter.search-placeholder',
  'analysis.filter.search-placeholder',
  'analysis.col.created',
  'analysis.col.budget',
  'analysis.col.attempts',
  'analysis.col.completed',
  'settings.conn.token',
  'settings.conn.token-placeholder',
]);

const DEFAULT_V2_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'i18n', 'locales');
const DEFAULT_V1_DIR = path.join(REPO_ROOT, 'apps', 'console', 'i18n', 'locales');
const DEFAULT_V1_ENTRY = path.join(REPO_ROOT, 'apps', 'console', 'index.html');

function usage() {
  return [
    'node scripts/i18n-check.mjs [--dir <localesDir>] [--json] [--strict] [--allow-missing]',
    '                             [--profile console-v2|console-v1] [--entry <htmlFile>]',
    '                             [--strict-en-cjk] [--help]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    dir: null,
    json: false,
    strict: false,
    strictEnCjk: false,
    allowMissing: false,
    profile: 'console-v2',
    entry: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--strict') options.strict = true;
    else if (argument === '--strict-en-cjk') options.strictEnCjk = true;
    else if (argument === '--allow-missing') options.allowMissing = true;
    else if (argument === '--dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--dir 需要目录参数');
      options.dir = path.resolve(process.cwd(), value);
      index += 1;
    } else if (argument === '--entry') {
      const value = argv[index + 1];
      if (!value) throw new Error('--entry 需要 HTML 文件参数');
      options.entry = path.resolve(process.cwd(), value);
      index += 1;
    } else if (argument.startsWith('--profile=')) {
      options.profile = argument.slice('--profile='.length);
    } else if (argument === '--profile') {
      const value = argv[index + 1];
      if (!value) throw new Error('--profile 需要参数');
      options.profile = value;
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (options.profile !== 'console-v2' && options.profile !== 'console-v1') {
    throw new Error(`--profile 只支持 console-v2 / console-v1，收到：${options.profile}`);
  }
  if (options.dir === null) options.dir = options.profile === 'console-v1' ? DEFAULT_V1_DIR : DEFAULT_V2_DIR;
  return options;
}

function placeholdersOf(value) {
  const set = new Set();
  if (typeof value !== 'string') return set;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER_PATTERN.exec(value)) !== null) set.add(match[1]);
  return set;
}

function isV2KeyLegal(key) {
  return KEY_PATTERN.test(key) || ERROR_CODE_PATTERN.test(key) || key === FALLBACK_KEY;
}

class Report {
  constructor(profile) {
    this.profile = profile;
    this.errors = [];
    this.warnings = [];
  }

  error(code, message, detail = undefined) {
    this.errors.push({ code, message, ...(detail === undefined ? {} : { detail }) });
  }

  warn(code, message, detail = undefined) {
    this.warnings.push({ code, message, ...(detail === undefined ? {} : { detail }) });
  }

  get ok() {
    return this.errors.length === 0;
  }
}

function readLocaleJson(report, dir, locale, { allowMissing }) {
  const file = path.join(dir, `${locale}.json`);
  if (!fs.existsSync(file)) {
    if (allowMissing) {
      report.warn('LOCALE_MISSING', `缺少语言文件：${path.relative(process.cwd(), file)}`);
      return null;
    }
    report.error('LOCALE_MISSING', `缺少语言文件：${path.relative(process.cwd(), file)}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    report.error('JSON_PARSE', `${locale}.json 不是合法 JSON：${error.message}`);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    report.error('JSON_PARSE', `${locale}.json 顶层必须是对象`);
    return null;
  }
  return parsed;
}

function readMeta(report, dir, locale) {
  const file = path.join(dir, `${locale}.meta.json`);
  if (!fs.existsSync(file)) {
    report.error('META_INVALID', `缺少 meta 文件：${path.relative(process.cwd(), file)}`);
    return null;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    report.error('META_INVALID', `${locale}.meta.json 不是合法 JSON：${error.message}`);
    return null;
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    report.error('META_INVALID', `${locale}.meta.json 顶层必须是对象`);
    return null;
  }
  if (typeof meta._machine !== 'boolean') {
    report.error('META_INVALID', `${locale}.meta.json 的 _machine 必须是布尔值`, { value: meta._machine });
  }
  if (typeof meta._source !== 'string' || !LOCALES.includes(meta._source)) {
    report.error('META_INVALID', `${locale}.meta.json 的 _source 必须是 7 语言之一`, { value: meta._source });
  }
  if (typeof meta._updated !== 'string' || Number.isNaN(Date.parse(meta._updated))) {
    report.error('META_INVALID', `${locale}.meta.json 的 _updated 必须是 ISO 时间`, { value: meta._updated });
  }
  return meta;
}

/** console-v2 校验（合同 §8）。 */
function checkV2(options) {
  const report = new Report('console-v2');
  const dir = options.dir;
  if (!fs.existsSync(dir)) {
    report.error('DIR_MISSING', `locales 目录不存在：${dir}`);
    return { report, dicts: {} };
  }
  const dicts = {};
  for (const locale of LOCALES) {
    const dict = readLocaleJson(report, dir, locale, options);
    if (dict) dicts[locale] = dict;
  }
  const metas = {};
  for (const locale of LOCALES) {
    // --allow-missing：缺语言文件时连它的 meta 一起跳过（分语言推进用）。
    if (!dicts[locale] && options.allowMissing) continue;
    metas[locale] = readMeta(report, dir, locale);
  }

  const en = dicts[BASE_LOCALE] ?? null;
  if (en === null) {
    report.error('BASE_MISSING', 'en.json 缺失或不可解析，无法做 key 集合校验');
    return { report, dicts };
  }
  const enKeys = Object.keys(en);

  // 值类型 / 空值 + key 语法（以 en 为准，其余语言也要过语法）
  for (const locale of Object.keys(dicts)) {
    for (const [key, value] of Object.entries(dicts[locale])) {
      if (typeof value !== 'string') {
        report.error('VALUE_TYPE', `${locale}.json 的 ${key} 不是字符串`, { locale, key });
        continue;
      }
      if (value.trim() === '') report.error('EMPTY_VALUE', `${locale}.json 的 ${key} 为空值`, { locale, key });
      if (options.profile === 'console-v2' && locale === BASE_LOCALE && !isV2KeyLegal(key)) {
        report.error('KEY_SYNTAX', `key 不符合 v1.2 语法（全小写+kebab，errors.<UPPER_SNAKE> 例外）：${key}`, { key });
      }
    }
  }

  // key 集合一致（缺 / 多）
  for (const locale of Object.keys(dicts)) {
    if (locale === BASE_LOCALE) continue;
    const keys = new Set(Object.keys(dicts[locale]));
    for (const key of enKeys) {
      if (!keys.has(key)) report.error('KEY_MISSING', `${locale}.json 缺 key：${key}`, { locale, key });
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(en, key)) {
        report.error('KEY_EXTRA', `${locale}.json 多出 en 没有的 key：${key}`, { locale, key });
      }
    }
  }

  // 占位符一致
  for (const locale of Object.keys(dicts)) {
    if (locale === BASE_LOCALE) continue;
    for (const key of enKeys) {
      if (!Object.prototype.hasOwnProperty.call(dicts[locale], key)) continue;
      const expected = [...placeholdersOf(en[key])].sort().join(',');
      const actual = [...placeholdersOf(dicts[locale][key])].sort().join(',');
      if (expected !== actual) {
        report.error('PLACEHOLDER_MISMATCH', `${locale}.json 的 ${key} 占位符不一致（en=[${expected}] 实际=[${actual}]）`, {
          locale,
          key,
          en: [...placeholdersOf(en[key])],
          actual: [...placeholdersOf(dicts[locale][key])],
        });
      }
    }
  }

  // en 含 CJK（品牌/原生名白名单，--strict-en-cjk 关闭白名单）
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== 'string' || !CJK_PATTERN.test(value)) continue;
    const exemption = options.strictEnCjk ? undefined : EN_CJK_EXEMPT.get(key);
    if (exemption) {
      report.warn('EN_CJK_EXEMPT', `en 的 ${key} 按白名单保留 CJK：${exemption}`, { key });
      continue;
    }
    report.error('EN_CJK', `en 的值含 CJK（应为纯英文）：${key}`, { key, value });
  }

  // 未翻译检测（与 en 逐字节完全相同）——只对**机翻语言**生效：
  //   en 与 zh-CN 是源语言（合同 §8.2：en/zh-CN 人工），不参与"机翻未翻"判定。
  //  - 与 en 相同比例 > 90% 且 `_machine !== true` → **error**（META_MACHINE_FLAG_MISSING，
  //    lead 2026-11-04 最终指令：机翻语言大面积未翻却不标 machine，必须失败）
  //  - `_machine:true` 但全部相同 → META_MACHINE_UNTRANSLATED（占位冒充机翻，warning / --strict error）
  //  - `_machine:false` 但全部相同 → META_UNTRANSLATED_CLAIM（meta 与内容不一致，warning / --strict error）
  //  - >90% 但非全部相同 → META_MOSTLY_UNTRANSLATED（透明告警）
  const SOURCE_LOCALES = new Set([BASE_LOCALE, 'zh-CN']);
  for (const locale of LOCALES) {
    if (SOURCE_LOCALES.has(locale) || !dicts[locale] || !metas[locale]) continue;
    if (enKeys.length === 0) continue;
    const meta = metas[locale];
    const identical = enKeys.filter((key) => dicts[locale][key] === en[key]).length;
    const ratio = identical / enKeys.length;
    const percent = (ratio * 100).toFixed(1);
    if (ratio > 0.9 && meta._machine !== true) {
      report.error(
        'META_MACHINE_FLAG_MISSING',
        `${locale}.json 与 en 完全相同比例 ${percent}%（>90%）但 meta _machine=${String(meta._machine)}（必须标 true）`,
        { locale, identical, total: enKeys.length, ratio },
      );
    }
    if (identical === enKeys.length) {
      const code = meta._machine === true ? 'META_MACHINE_UNTRANSLATED' : 'META_UNTRANSLATED_CLAIM';
      const message = meta._machine === true
        ? `${locale}.json 的 meta 标 _machine:true，但全部 ${enKeys.length} 条与 en 完全相同（占位冒充机翻）`
        : `${locale}.json 的 meta 标 _machine:false，但全部 ${enKeys.length} 条与 en 完全相同（meta 与内容不一致：实为英文占位）`;
      if (options.strict) report.error(code, message, { locale, identical, total: enKeys.length });
      else report.warn(code, message, { locale, identical, total: enKeys.length });
    } else if (ratio > 0.9) {
      report.warn(
        'META_MOSTLY_UNTRANSLATED',
        `${locale}.json 有 ${percent}% 的 key 与 en 相同（机翻覆盖 ${enKeys.length - identical}/${enKeys.length} 条）`,
        { locale, identical, total: enKeys.length, ratio },
      );
    }
  }

  // 检查 9：白名单最小化（条目必须仍存在于 en 且仍含 CJK）
  checkEnCjkWhitelist(report, en);
  // 检查 10：目标语言脚本泄漏（整句抄 zh-CN / ko·es·ru·th 出现汉字）
  checkLocaleScriptLeak(report, dicts);

  return { report, dicts };
}
function checkV1(options) {
  const report = new Report('console-v1');
  const dir = options.dir;
  if (!fs.existsSync(dir)) {
    report.error('DIR_MISSING', `locales 目录不存在：${dir}`);
    return { report, dicts: {} };
  }  const dicts = {};
  for (const locale of LOCALES) {
    const dict = readLocaleJson(report, dir, locale, options);
    if (dict) dicts[locale] = dict;
  }
  const en = dicts[BASE_LOCALE] ?? null;
  if (en === null) {
    report.error('BASE_MISSING', 'en.json 缺失或不可解析');
    return { report, dicts };
  }
  const enKeys = Object.keys(en);
  for (const locale of Object.keys(dicts)) {
    const keys = new Set(Object.keys(dicts[locale]));
    if (locale !== BASE_LOCALE) {
      for (const key of enKeys) if (!keys.has(key)) report.error('KEY_MISSING', `${locale} 缺 key：${key}`, { locale, key });
      for (const key of keys) if (!Object.prototype.hasOwnProperty.call(en, key)) report.error('KEY_EXTRA', `${locale} 多 key：${key}`, { locale, key });
    }
    for (const [key, value] of Object.entries(dicts[locale])) {
      if (typeof value !== 'string') {
        report.error('VALUE_TYPE', `${locale} 的 ${key} 不是字符串`, { locale, key });
        continue;
      }
      if (value.trim() === '') report.error('EMPTY_VALUE', `${locale} 的 ${key} 为空`, { locale, key });
      if (/\b(TODO|TBD|FIXME)\b/u.test(value)) report.error('VALUE_TODO', `${locale} 的 ${key} 含 TODO/TBD`, { locale, key });
      if (value.length > V1_MAX_VALUE_LENGTH) report.error('VALUE_TOO_LONG', `${locale} 的 ${key} 超过 ${V1_MAX_VALUE_LENGTH} 字符`, { locale, key });
      if (locale !== BASE_LOCALE) {
        for (const other of Object.keys(dicts)) {
          if (other === locale || other === BASE_LOCALE) continue;
          if (!Object.prototype.hasOwnProperty.call(dicts[other], key)) continue;
          const expected = [...placeholdersOf(en[key])].sort().join(',');
          const actual = [...placeholdersOf(dicts[locale][key])].sort().join(',');
          if (expected !== actual) {
            report.error('PLACEHOLDER_MISMATCH', `${locale} 的 ${key} 占位符与 en 不一致`, { locale, key });
            break;
          }
        }
      }
    }
  }
  // 目标语言脚本特征（非豁免 key 至少出现一次目标脚本字符，否则视为未翻译）
  for (const locale of Object.keys(dicts)) {
    const pattern = V1_SCRIPT_PATTERN[locale];
    if (!pattern) continue;
    let translated = 0;
    let considered = 0;
    for (const key of enKeys) {
      if (V1_SCRIPT_EXEMPT.has(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(dicts[locale], key)) continue;
      considered += 1;
      if (pattern.test(String(dicts[locale][key]))) translated += 1;
    }
    if (considered > 0 && translated === 0) {
      report.error('LOCALE_NOT_TRANSLATED', `${locale}.json 找不到任何 ${locale} 目标语言字符（疑似未翻译）`, { locale });
    }
  }
  // 短标签长度比例（只告警）
  for (const locale of Object.keys(dicts)) {
    if (locale === BASE_LOCALE) continue;
    for (const key of enKeys) {
      if (!V1_LABEL_KEY.test(key) || V1_NON_LABEL_SUFFIX.test(key)) continue;
      if (String(en[key]).length > V1_LABEL_EN_LIMIT) continue;
      const value = dicts[locale][key];
      if (typeof value !== 'string') continue;
      if (value.length > en[key].length * V1_LABEL_RATIO) {
        report.warn('LABEL_TOO_LONG', `${locale} 的短标签 ${key} 超出 en 的 ${V1_LABEL_RATIO}×`, { locale, key });
      }
    }
  }
  return { report, dicts };
}

/**
 * 入口引用校验（SEED-03 / FG-01）。
 *
 * 旧校验器只读 `apps/console/i18n/locales/*.json`，从不读入口 —— 于是 console 入口
 * （`apps/console/index.html:475` 只加载 `app.js`）从未引用过那 7×159 条词条，校验器
 * 仍然 PASS。这是"断言执行链没接上被测对象"的假绿：词条是死载荷，检查器无论如何都绿。
 *
 * 判据：console-v1 的入口必须
 *   ① 加载 `i18n/index.js`（`ENTRY_NOT_WIRED`，否则词条目录是死载荷）；
 *   ② 真正启动加载器（`NDI18N.autoStart()` / `NDI18N.init()`，`ENTRY_LOADER_UNUSED`，
 *      否则脚本只是被引入、词条永远不会被读取）。
 *
 * @param {Report} report 报告对象。
 * @param {{entry: string|null, profile: string}} options 参数。
 */
function checkEntryReference(report, options) {
  const entry = options.entry
    ?? (options.profile === 'console-v1' ? DEFAULT_V1_ENTRY : null);
  if (entry === null) return;
  let text;
  try {
    text = fs.readFileSync(entry, 'utf8');
  } catch (error) {
    report.error('ENTRY_MISSING', `入口文件不可读：${path.relative(process.cwd(), entry) || entry}（${error.message}）`);
    return;
  }
  const relative = path.relative(process.cwd(), entry) || entry;
  // The loader may be referenced by a static <script src="i18n/index.js"> or injected at
  // runtime (`loader.src = 'i18n/index.js'`). Both keep the locale directory live; the
  // check is about the *reference existing*, which is what FG-01 showed was missing.
  const loaderReference = /(?:\bsrc\s*=\s*["'][^"']*i18n\/index\.js|\.src\s*=\s*["'][^"']*i18n\/index\.js)/u;
  if (!loaderReference.test(text)) {
    report.error(
      'ENTRY_NOT_WIRED',
      `入口 ${relative} 没有加载 i18n 加载器（i18n/index.js）：locales 词条是死载荷，永远不会被读取`,
    );
  }
  if (!/NDI18N\s*\.\s*(?:autoStart|init)\s*\(/u.test(text)) {
    report.error(
      'ENTRY_LOADER_UNUSED',
      `入口 ${relative} 引入了 i18n/index.js 但从未启动它（NDI18N.autoStart()/NDI18N.init()）：词条不会被加载`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 2026-11-05（UI-POLISH T3）新增检查 9–13
 * ------------------------------------------------------------------ */

/**
 * 检查 9：en 的 CJK 白名单必须**最小且显式**——白名单里的 key 必须仍在 en 中且仍含 CJK。
 * 反向（en 里含 CJK 但不在白名单）由 checkV2 既有的 EN_CJK 错误覆盖。
 *
 * @param {Report} report
 * @param {Record<string,string>} en
 */
function checkEnCjkWhitelist(report, en) {
  for (const key of EN_CJK_EXEMPT.keys()) {
    if (!Object.prototype.hasOwnProperty.call(en, key)) {
      report.error('EN_CJK_EXEMPT_STALE', `en CJK 白名单条目已过期：${key} 在 en.json 中不存在`, { key });
      continue;
    }
    if (!CJK_PATTERN.test(String(en[key]))) {
      report.error('EN_CJK_EXEMPT_STALE', `en CJK 白名单条目已过期：${key} 的值已不含 CJK`, { key });
    }
  }
}

/**
 * 检查 10：目标语言脚本泄漏。
 *  - 整句照抄 zh-CN（≥6 字且与 zh-CN 同值，短汉字词如「停止/分析」不算——那是共享汉字）→ LOCALE_ZH_COPY
 *  - ko/es/ru/th 出现汉字（品牌专名/语言原生名白名单除外）→ LOCALE_HAN_LEAK
 *
 * @param {Report} report
 * @param {Record<string, Record<string,string>>} dicts
 */
function checkLocaleScriptLeak(report, dicts) {
  const zh = dicts['zh-CN'];
  const en = dicts[BASE_LOCALE];
  if (!zh || !en) return;
  const hANLocales = new Set(['ko', 'es', 'ru', 'th']);
  for (const locale of MACHINE_LOCALES) {
    const dict = dicts[locale];
    if (!dict) continue;
    const zhCopies = [];
    const hanLeaks = [];
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== 'string' || HAN_LEAK_EXEMPT.has(key)) continue;
      // 「与 zh-CN 同值」只有在 zh-CN 自己**确实翻译过**（≠ en）时才是中文泄漏证据；
      // 若 en 与 zh-CN 同值（技术缩写/产品名），机翻语言沿用英文属正常占位。
      const zhIsTranslated = typeof zh[key] === 'string' && zh[key] !== en[key];
      if (zhIsTranslated && zh[key] === value && value.length >= 6) {
        zhCopies.push(`${key}=${JSON.stringify(value).slice(0, 30)}`);
      }
      if (hANLocales.has(locale) && HAN_PATTERN.test(value)) {
        hanLeaks.push(`${key}=${JSON.stringify(value).slice(0, 30)}`);
      }
    }
    if (zhCopies.length > 0) {
      report.error(
        'LOCALE_ZH_COPY',
        `${locale}.json 有 ${zhCopies.length} 条与 zh-CN 完全相同（≥6 字，疑似未翻译直接复制中文）`,
        { locale, count: zhCopies.length, examples: zhCopies.slice(0, 5) },
      );
    }
    if (hanLeaks.length > 0) {
      report.error(
        'LOCALE_HAN_LEAK',
        `${locale}.json 有 ${hanLeaks.length} 条含汉字（${locale} 界面不应出现中文文案）`,
        { locale, count: hanLeaks.length, examples: hanLeaks.slice(0, 5) },
      );
    }
  }
}

/**
 * 检查 11：回落链静态检查——chain() 里不得再出现 SECOND_FALLBACK_LOCALE。
 * 背景：原实现 `当前 → en → zh-CN` 会让 locale=en 时缺 key 渲染中文（英文界面漏中文）。
 *
 * @param {Report} report
 */
function checkFallbackStatic(report) {
  if (!fs.existsSync(I18N_MODULE)) {
    report.warn('FALLBACK_MODULE_MISSING', `回落链静态检查跳过：${path.relative(process.cwd(), I18N_MODULE)} 不存在`);
    return;
  }
  const source = fs.readFileSync(I18N_MODULE, 'utf8');
  if (!/export const FALLBACK_LOCALE = 'en';/u.test(source)) {
    report.error('FALLBACK_NOT_EN', 'js/i18n.js 的 FALLBACK_LOCALE 必须仍是 \'en\'');
  }
  const chainMatch = source.match(/function chain\(\)\s*\{([\s\S]*?)\n {2}\}/u);
  if (!chainMatch) {
    report.error('FALLBACK_CHAIN_UNREADABLE', 'js/i18n.js 中找不到 chain() 实现，无法静态检查回落链');
    return;
  }
  if (chainMatch[1].includes('SECOND_FALLBACK_LOCALE')) {
    report.error(
      'FALLBACK_TO_ZH',
      'js/i18n.js 的 chain() 仍包含 SECOND_FALLBACK_LOCALE：locale=en 缺 key 会回落中文（英文界面漏中文）',
    );
  }
}

/**
 * 检查 12：回落链**运行期**行为（真模块 + 假 fetch）。
 * 不是只看源码字符串：真跑 createI18n，构造"只有 zh-CN 有的 key"，逐语言断言。
 *
 * @param {Report} report
 * @returns {Promise<object|null>}
 */
async function checkFallbackRuntime(report) {
  if (!fs.existsSync(I18N_MODULE)) {
    report.warn('FALLBACK_RUNTIME_SKIPPED', '回落链运行期检查跳过：i18n.js 不存在');
    return null;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(I18N_MODULE).href);
  } catch (error) {
    report.error('FALLBACK_IMPORT_FAILED', `无法导入 js/i18n.js：${error.message}`);
    return null;
  }
  if (typeof mod.createI18n !== 'function') {
    report.error('FALLBACK_IMPORT_FAILED', 'js/i18n.js 未导出 createI18n');
    return null;
  }
  const basePath = 'http://fallback-fixture.invalid/locales/';
  const fixtureFetch = (tables) => async (url) => {
    const name = decodeURIComponent(String(url).split('/').pop().replace(/\.json$/u, ''));
    const table = tables[name];
    if (table === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => table };
  };
  const zhOnly = { 'probe.zh-only': '只有中文的探针文案' };
  const enOnly = { 'probe.en-only': 'English probe text' };
  const observed = {};

  // (b1) locale=en：即使 zh-CN 字典已加载，也绝不能拿中文
  const enProbe = mod.createI18n({ locale: 'en', basePath, fetchImpl: fixtureFetch({ en: enOnly, 'zh-CN': zhOnly }), warnMissing: false });
  await enProbe.ready();
  await enProbe.load('zh-CN');
  observed.en = enProbe.t('probe.zh-only');
  if (HAN_PATTERN.test(observed.en)) {
    report.error('FALLBACK_EN_TO_ZH', `locale=en 缺 key 时渲染了中文：${JSON.stringify(observed.en)}`);
  } else if (observed.en !== '[missing:probe.zh-only]') {
    report.warn('FALLBACK_EN_NOT_MARKED', `locale=en 缺 key 未渲染 [missing:] 标记（得到 ${JSON.stringify(observed.en)}）`);
  }
  if (enProbe.t('probe.en-only') !== 'English probe text') {
    report.error('FALLBACK_EN_OWN_MISSING', 'locale=en 自己的 key 反而取不到（内置 en 兜底失效）');
  }

  // (b2) locale=ja：缺 key 也不能回落到中文
  const jaProbe = mod.createI18n({ locale: 'ja', basePath, fetchImpl: fixtureFetch({ ja: {}, en: enOnly, 'zh-CN': zhOnly }), warnMissing: false });
  await jaProbe.ready();
  await jaProbe.load('zh-CN');
  observed.ja = jaProbe.t('probe.zh-only');
  if (HAN_PATTERN.test(observed.ja)) {
    report.error('FALLBACK_JA_TO_ZH', `locale=ja 缺 key 时渲染了中文：${JSON.stringify(observed.ja)}`);
  }

  // (b3) locale=zh-CN：中文本体不受影响，缺 key 仍回落 en
  const zhProbe = mod.createI18n({ locale: 'zh-CN', basePath, fetchImpl: fixtureFetch({ 'zh-CN': {}, en: enOnly }), warnMissing: false });
  await zhProbe.ready();
  observed['zh-CN'] = zhProbe.t('probe.en-only');
  if (observed['zh-CN'] !== 'English probe text') {
    report.error('FALLBACK_ZH_NO_EN', `locale=zh-CN 缺 key 时未能回落 en（得到 ${JSON.stringify(observed['zh-CN'])}）`);
  }

  return observed;
}

/**
 * 检查 13：7 语言真实翻译覆盖率（translated = 值与 en 不同；目标脚本命中数作为第二证据）。
 *
 * @param {Record<string,string>} en
 * @param {Record<string, Record<string,string>>} dicts
 */
function computeCoverage(en, dicts) {
  const total = Object.keys(en).length;
  const out = {};
  for (const locale of LOCALES) {
    const dict = dicts[locale];
    if (!dict) continue;
    const pattern = TARGET_SCRIPT[locale];
    let translated = 0;
    let scriptHits = 0;
    for (const [key, value] of Object.entries(en)) {
      if (!Object.prototype.hasOwnProperty.call(dict, key)) continue;
      if (dict[key] === value) continue;
      translated += 1;
      if (pattern && typeof dict[key] === 'string' && pattern.test(dict[key])) scriptHits += 1;
    }
    out[locale] = {
      translated: locale === BASE_LOCALE ? total : translated,
      total,
      percent: locale === BASE_LOCALE ? 100 : (total === 0 ? 0 : Number(((translated / total) * 100).toFixed(1))),
      scriptHits: locale === BASE_LOCALE ? total : scriptHits,
      source: locale === BASE_LOCALE || locale === 'zh-CN',
    };
  }
  return out;
}

function summarize(dicts) {
  return Object.fromEntries(Object.entries(dicts).map(([locale, dict]) => [locale, Object.keys(dict).length]));
}

/** 收集所有**同步**检查（词典层：9–11 + 既有 1–8 + 入口引用）。 */
function evaluate(options) {
  const { report, dicts } = options.profile === 'console-v1' ? checkV1(options) : checkV2(options);
  checkEntryReference(report, options);
  // 元素级检查对 v1 profile 同样适用（v1 目录也应有共识：不回落中文、不抄中文）
  if (options.profile === 'console-v1') {
    const en = dicts[BASE_LOCALE] ?? null;
    if (en) checkEnCjkWhitelist(report, en);
    checkLocaleScriptLeak(report, dicts);
  }
  checkFallbackStatic(report);
  const en = dicts[BASE_LOCALE] ?? {};
  return { report, dicts, coverage: computeCoverage(en, dicts) };
}

function buildPayload(options, report, dicts, coverage, extra = {}) {
  return {
    ok: report.ok,
    profile: options.profile,
    dir: options.dir,
    locales: LOCALES,
    keyCounts: summarize(dicts),
    coverage,
    cjkWhitelist: [...EN_CJK_EXEMPT.entries()].map(([key, reason]) => ({ key, reason, present: Object.prototype.hasOwnProperty.call(dicts[BASE_LOCALE] ?? {}, key) })),
    errorCount: report.errors.length,
    warningCount: report.warnings.length,
    errors: report.errors,
    warnings: report.warnings,
    ...extra,
  };
}

/** 同步入口（保留给既有调用方）：不做动态 import 的运行期回落检查。 */
export function run(options) {
  const { report, dicts, coverage } = evaluate(options);
  return buildPayload(options, report, dicts, coverage);
}

/** 完整入口：同步检查 + 检查 12（运行期回落链，需 await）。 */
export async function runAsync(options) {
  const { report, dicts, coverage } = evaluate(options);
  const fallback = await checkFallbackRuntime(report);
  return buildPayload(options, report, dicts, coverage, { fallbackChain: fallback });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`i18n-check: ${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  let payload;
  try {
    payload = await runAsync(options);
  } catch (error) {
    process.stderr.write(`i18n-check: ${error && error.message ? error.message : error}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    const keys = payload.keyCounts;
    const keySummary = Object.entries(keys).map(([locale, count]) => `${locale}=${count}`).join(' ');
    process.stdout.write(`i18n-check: profile=${payload.profile} dir=${path.relative(process.cwd(), payload.dir) || '.'}\n`);
    process.stdout.write(`i18n-check: keys ${keySummary || '(none)'}\n`);
    // 检查 13：真实覆盖率（translated = 值 ≠ en；不是"英文占位算已翻译"）
    const coverageText = Object.entries(payload.coverage)
      .map(([locale, item]) => `${locale}=${item.translated}/${item.total}(${item.percent}%)`)
      .join(' ');
    process.stdout.write(`i18n-check: coverage ${coverageText || '(none)'}\n`);
    if (payload.fallbackChain) {
      process.stdout.write(`i18n-check: fallback-chain probe ${JSON.stringify(payload.fallbackChain)}\n`);
    }
    for (const warning of payload.warnings) process.stdout.write(`WARN ${warning.code} ${warning.message}\n`);
    for (const error of payload.errors) process.stdout.write(`ERROR ${error.code} ${error.message}\n`);
    process.stdout.write(
      payload.ok
        ? `i18n-check: PASS (${payload.errorCount} error, ${payload.warningCount} warning)\n`
        : `i18n-check: FAIL (${payload.errorCount} error, ${payload.warningCount} warning)\n`,
    );
  }
  process.exitCode = payload.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`i18n-check: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 2;
  });
}
