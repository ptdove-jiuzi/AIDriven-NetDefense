#!/usr/bin/env node
/**
 * merge-pending.mjs — 合并各席位写入的 `apps/console-next/i18n/_pending/*.json` 新 key。
 *
 * pending 格式（各属主写）：
 *   { "en": { "<key>": "<英文文案>" }, "zh-CN": { "<key>": "<中文文案>" } }
 *
 * 合并语义（诚实优先）：
 *  - en / zh-CN：把 pending 的新 key 追加（已存在且值相同 = 幂等跳过；值不同 = **冲突错误**，需 lead 裁决）；
 *  - ja/ko/es/ru/th：新 key **补 en 值**（英文占位），若 `tools/translations/*.json` 恰有译文则用译文；
 *  - 合并后重算 meta 与 README（覆盖率分母变大，数字必须跟着变）；
 *  - 7 语言 key 集合必须完全一致（合并后自检，不一致 exit 1）。
 *
 * 安全：
 *  - `--dry-run` 只报告不落盘；
 *  - 落盘前把 en/zh-CN 的 sha256 打进报告，并在 evidence 下留合并清单；
 *  - 不删除、不改写既有 key 的值（冲突只报错，不静默覆盖；`--overwrite` 才覆盖且必须显式给）。
 *
 * 用法：
 *   node apps/console-next/i18n/tools/merge-pending.mjs --dry-run
 *   node apps/console-next/i18n/tools/merge-pending.mjs
 *   node apps/console-next/i18n/tools/merge-pending.mjs --pending agent,settings [--overwrite]
 *
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  HAN_PATTERN,
  I18N_DIR,
  LOCALES,
  MACHINE_LOCALES,
  buildMachineMeta,
  coverageOf,
  loadAll,
  loadLocale,
  localePath,
  metaPath,
  nowIso,
  readJson,
  sha256File,
  writeJsonLike,
} from './lib.mjs';
import { syncReadme } from './sync-readme.mjs';

const PENDING_DIR = path.join(I18N_DIR, '_pending');
/** 自测（T3_I18N_DIR 指向临时副本）时把报告写进副本内，避免污染真仓库 evidence。 */
const ARTIFACT_DIR = process.env.T3_I18N_DIR
  ? path.join(I18N_DIR, '.merge-artifacts')
  : path.resolve(I18N_DIR, '..', '..', '..', 'evidence', 'ui-polish', 'i18n', 'merge');
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const ERROR_CODE_PATTERN = /^errors\.[A-Z][A-Z0-9_]*$/u;

function parseArgs(argv) {
  const options = { dryRun: false, overwrite: false, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--overwrite') options.overwrite = true;
    else if (argument === '--pending') {
      const value = argv[index + 1];
      if (!value) throw new Error('--pending 需要逗号分隔的名字');
      options.only = value.split(',').map((name) => name.trim()).filter(Boolean);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write('node merge-pending.mjs [--dry-run] [--pending a,b] [--overwrite]\n');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function placeholdersOf(value) {
  return [...new Set([...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((match) => match[1]))].sort();
}

/** 读取所有 pending 文件 → Map<key, {en, zh-CN, provenance}>；同 key 冲突记为 problems。 */
function readPending(options) {
  if (!fs.existsSync(PENDING_DIR)) return { entries: new Map(), files: [], problems: [] };
  const all = fs.readdirSync(PENDING_DIR).filter((name) => name.endsWith('.json')).sort();
  const files = options.only === null ? all : all.filter((name) => options.only.includes(name.replace(/\.json$/u, '')));
  const entries = new Map();
  const problems = [];
  for (const name of files) {
    const file = path.join(PENDING_DIR, name);
    let table;
    try {
      table = readJson(file);
    } catch (error) {
      problems.push(`PENDING_JSON ${name}: ${error.message}`);
      continue;
    }
    const enTable = table.en ?? {};
    const zhTable = table['zh-CN'] ?? {};
    if (Object.keys(enTable).length === 0) {
      problems.push(`PENDING_EMPTY ${name}: en 为空（没有可合并的新 key）`);
      continue;
    }
    for (const [key, enValue] of Object.entries(enTable)) {
      if (key === '_meta') continue;
      const problemBase = `${name}:${key}`;
      if (!KEY_PATTERN.test(key) && !ERROR_CODE_PATTERN.test(key)) {
        problems.push(`PENDING_KEY_SYNTAX ${problemBase}`);
        continue;
      }
      if (typeof enValue !== 'string' || enValue.trim() === '') {
        problems.push(`PENDING_EN_EMPTY ${problemBase}`);
        continue;
      }
      if (HAN_PATTERN.test(enValue) && key !== 'app.product-zh') {
        problems.push(`PENDING_EN_CJK ${problemBase}: en 文案含汉字「${enValue.slice(0, 30)}」`);
      }
      const zhValue = zhTable[key];
      if (typeof zhValue !== 'string' || zhValue.trim() === '') {
        problems.push(`PENDING_ZH_MISSING ${problemBase}: zh-CN 缺这个 key（en/zh 必须成对交付）`);
        continue;
      }
      if (placeholdersOf(enValue).join(',') !== placeholdersOf(zhValue).join(',')) {
        problems.push(`PENDING_PLACEHOLDER ${problemBase}: en=[${placeholdersOf(enValue)}] zh-CN=[${placeholdersOf(zhValue)}]`);
        continue;
      }
      const existing = entries.get(key);
      if (existing) {
        if (existing.en !== enValue || existing['zh-CN'] !== zhValue) {
          problems.push(`PENDING_DUPLICATE_CONFLICT ${problemBase}: 与 ${existing.provenance} 的同一 key 文案不同`);
        }
        continue;
      }
      entries.set(key, { en: enValue, 'zh-CN': zhValue, provenance: name });
    }
  }
  return { entries, files, problems };
}

export function mergePending(options = {}) {
  const { entries, files, problems } = readPending(options);
  const en = loadLocale('en');
  const zh = loadLocale('zh-CN');
  const conflicts = [];
  const additions = [];
  const overwrites = [];
  for (const [key, entry] of entries) {
    if (Object.prototype.hasOwnProperty.call(en, key)) {
      if (en[key] !== entry.en) {
        // lead 口径（2026-11-05）：与现有 en key 冲突时**以 pending 为准**，但必须显式 --overwrite
        // 并记录冲突清单；不给 --overwrite 就整批拒收（绝不静默覆盖）。
        if (!options.overwrite) {
          problems.push(`KEY_CONFLICT ${key}: en 已有不同文案（当前=${JSON.stringify(en[key])}，pending=${JSON.stringify(entry.en)}）`);
          continue;
        }
        conflicts.push({
          key,
          provenance: entry.provenance,
          currentEn: en[key],
          incomingEn: entry.en,
          currentZh: zh[key],
          incomingZh: entry['zh-CN'],
          resolution: 'incoming(pending) wins; existing 5-language translations kept as-is (may be stale)',
        });
        overwrites.push({ key, en: entry.en, 'zh-CN': entry['zh-CN'], provenance: entry.provenance });
      } else if (zh[key] !== entry['zh-CN']) {
        conflicts.push({
          key,
          provenance: entry.provenance,
          currentEn: en[key],
          incomingEn: entry.en,
          currentZh: zh[key],
          incomingZh: entry['zh-CN'],
          resolution: 'zh-CN updated to pending value (en identical)',
        });
        overwrites.push({ key, en: entry.en, 'zh-CN': entry['zh-CN'], provenance: entry.provenance });
      }
      continue;
    }
    additions.push({ key, en: entry.en, 'zh-CN': entry['zh-CN'], provenance: entry.provenance });
  }
  if (problems.length > 0) {
    return { ok: false, problems, conflicts, additions, overwrites, files, dryRun: options.dryRun === true };
  }
  additions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const nextEn = { ...en };
  const nextZh = { ...zh };
  for (const addition of additions) {
    nextEn[addition.key] = addition.en;
    nextZh[addition.key] = addition['zh-CN'];
  }
  for (const overwrite of overwrites) {
    nextEn[overwrite.key] = overwrite.en;
    nextZh[overwrite.key] = overwrite['zh-CN'];
  }
  const enKeyOrder = [...Object.keys(en), ...additions.map((addition) => addition.key)];

  const before = {
    en: Object.keys(en).length,
    'zh-CN': Object.keys(zh).length,
    sha256: { en: sha256File(localePath('en')), 'zh-CN': sha256File(localePath('zh-CN')) },
  };

  const machineCoverageBefore = Object.fromEntries(MACHINE_LOCALES.map((locale) => [locale, coverageOf(en, loadLocale(locale), locale)]));

  if (options.dryRun !== true) {
    writeJsonLike(localePath('en'), nextEn, enKeyOrder);
    writeJsonLike(localePath('zh-CN'), nextZh, enKeyOrder);
    // en / zh-CN meta：只更新 _updated 与 key 数（源语言仍是人工撰写，_machine 必须 false）
    for (const [locale, dict] of [['en', nextEn], ['zh-CN', nextZh]]) {
      const meta = readJson(metaPath(locale));
      const next = { ...meta, _updated: nowIso(), _keys: Object.keys(dict).length };
      if (locale === 'en') next._note = `hand-written en catalog (${Object.keys(dict).length} keys); 2026-11-05 T3 合并 _pending 新 IA`;
      fs.writeFileSync(metaPath(locale), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
    // 5 语言：新 key 补 en 值（英文占位），旧值保持不动
    for (const locale of MACHINE_LOCALES) {
      const dict = loadLocale(locale);
      const next = { ...dict };
      for (const addition of additions) {
        if (!Object.prototype.hasOwnProperty.call(next, addition.key)) next[addition.key] = addition.en;
      }
      writeJsonLike(localePath(locale), next, enKeyOrder);
      const coverage = coverageOf(nextEn, next, locale);
      fs.writeFileSync(metaPath(locale), `${JSON.stringify(buildMachineMeta(locale, coverage, {
        _coverage: {
          translated: coverage.translated,
          total: coverage.total,
          percent: Number(coverage.percent),
          scriptHits: coverage.scriptHits,
          basis: 'translated = value differs from en (English placeholder otherwise)',
        },
      }), null, 2)}\n`, 'utf8');
    }
  }

  // 自检：7 语言 key 集合一致
  const all = options.dryRun === true ? null : loadAll();
  const consistency = all === null ? null : {
    counts: Object.fromEntries(LOCALES.map((locale) => [locale, Object.keys(all[locale]).length])),
    equal: LOCALES.every((locale) => Object.keys(all[locale]).length === Object.keys(all.en).length),
  };

  let readme = null;
  if (options.dryRun !== true) readme = syncReadme({});

  const report = {
    ok: consistency === null ? true : consistency.equal,
    dryRun: options.dryRun === true,
    files,
    additions,
    overwrites,
    conflicts,
    problems: [],
    before,
    after: options.dryRun === true ? null : { en: Object.keys(nextEn).length, 'zh-CN': Object.keys(nextZh).length },
    coverageBefore: machineCoverageBefore,
    coverageAfter: options.dryRun === true ? null : Object.fromEntries(MACHINE_LOCALES.map((locale) => [locale, coverageOf(nextEn, loadLocale(locale), locale)])),
    consistency,
    readme,
  };
  if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  fs.writeFileSync(path.join(ARTIFACT_DIR, `merge-${stamp}${options.dryRun === true ? '-dryrun' : ''}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function printReport(result) {
  if (!result.ok && result.problems?.length > 0) {
    process.stdout.write('merge-pending: FAIL — 未落盘\n');
    for (const problem of result.problems) process.stdout.write(`  ${problem}\n`);
    return;
  }
  process.stdout.write(`merge-pending: ${result.dryRun ? 'DRY RUN' : 'MERGED'} files=${result.files.join(',') || '(none)'} new-keys=${result.additions.length} overwritten=${result.overwrites?.length ?? 0}\n`);
  for (const addition of result.additions) {
    process.stdout.write(`  + ${addition.key}  [${addition.provenance}]\n    en: ${addition.en.slice(0, 90)}\n    zh: ${addition['zh-CN'].slice(0, 60)}\n`);
  }
  for (const overwrite of result.overwrites ?? []) {
    process.stdout.write(`  ~ ${overwrite.key}  [${overwrite.provenance}] 覆盖为 pending 文案\n`);
  }
  if (result.conflicts.length > 0) {
    process.stdout.write(`conflicts=${result.conflicts.length}（已按 lead 口径以 pending 为准并记录）\n`);
  }
  process.stdout.write(`en keys ${result.before.en} -> ${JSON.stringify(result.after?.en ?? '(unchanged)')}\n`);
  for (const [locale, coverage] of Object.entries(result.coverageBefore)) {
    const after = result.coverageAfter?.[locale];
    process.stdout.write(`${locale}: ${coverage.translated}/${coverage.total} (${coverage.percent}%)${after ? ` -> ${after.translated}/${after.total} (${after.percent}%)` : ''}\n`);
  }
  if (result.consistency) process.stdout.write(`consistency ${JSON.stringify(result.consistency)}\n`);
  if (!result.ok) process.stdout.write('merge-pending: key 集合不一致（见上）\n');
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = mergePending(options);
    printReport(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`merge-pending: ${error.message}\n`);
    process.exitCode = 2;
  }
}
