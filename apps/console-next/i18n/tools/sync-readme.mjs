#!/usr/bin/env node
/**
 * sync-readme.mjs — 用磁盘事实重写 `apps/console-next/i18n/README.md` 的规模/覆盖率章节。
 *
 * 背景：README 原本由 `tests/e2e/i18n/make-readme.mjs` 生成（不在本席位写域）。
 * 本轮由本脚本**手工同步**：只改 §1（文件与规模）与 §2（命名空间分布）两段，
 * 其余（v1→v2 映射表、维护规则）原样保留，并在段首显式注明"生成器在 tests/e2e/i18n/，本轮手工同步"。
 *
 * 用法：
 *   node apps/console-next/i18n/tools/sync-readme.mjs          # 写回
 *   node apps/console-next/i18n/tools/sync-readme.mjs --check  # 只校验表格与磁盘是否一致（exit 1 = 过期）
 *
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  EN_CJK_WHITELIST,
  HAN_PATTERN,
  I18N_DIR,
  LOCALES,
  LOCALES_DIR,
  MACHINE_LOCALES,
  coverageOf,
  loadAll,
  sha256File,
} from './lib.mjs';

const README = path.join(I18N_DIR, 'README.md');
const BEGIN = '<!-- T3:AUTO:BEGIN -->';
const END = '<!-- T3:AUTO:END -->';
const MANUAL_NOTE = '**生成器在 `tests/e2e/i18n/`（make-readme.mjs）；本节由 `apps/console-next/i18n/tools/sync-readme.mjs` 本轮手工同步（与磁盘现读一致，改 locale 后重跑即可）。**';

function bytesOf(file) {
  return fs.statSync(file).size;
}

function statusOf(locale, coverage) {
  if (locale === 'en' || locale === 'zh-CN') return '人工撰写（源语言）';
  if (coverage.translated === 0) return '全英文占位（未翻译）';
  if (coverage.translated === coverage.total) return '全量翻译';
  return `部分翻译（${coverage.translated}/${coverage.total} 条）`;
}

function buildBlock(en, dicts) {
  const dictionaries = { ...dicts, en };
  const coverages = Object.fromEntries(
    LOCALES.map((locale) => [locale, coverageOf(en, dictionaries[locale] ?? {}, locale)]),
  );
  const lines = [];
  lines.push(BEGIN);
  lines.push(`> ${MANUAL_NOTE}`);
  lines.push('');
  lines.push('## 1. 文件与规模（本表由磁盘现读，不是手写）');
  lines.push('');
  lines.push('| 文件 | key 数 | 字节 | 状态 | meta |');
  lines.push('|---|---|---|---|---|');
  for (const locale of LOCALES) {
    const file = path.join(LOCALES_DIR, `${locale}.json`);
    const metaFile = path.join(LOCALES_DIR, `${locale}.meta.json`);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      meta = {};
    }
    lines.push(
      `| \`locales/${locale}.json\` | ${Object.keys(dictionaries[locale] ?? {}).length} | ${bytesOf(file)} | ${statusOf(locale, coverages[locale])} `
      + `| \`_machine:${String(meta._machine)}\`, \`_source:${String(meta._source)}\` |`,
    );
  }
  lines.push('');
  lines.push(`- 语言数：${LOCALES.length}；en 基准 key：**${Object.keys(en).length}**；7 语言 key 集合以 \`scripts/i18n-check.mjs\` 为准。`);
  lines.push(`- \`zh-CN\`：默认语言（主路径），人工撰写；\`en\` / \`zh-CN\` 是源语言（\`_machine:false\`）。`);
  lines.push('- 5 个机翻语言的 meta 由 `tools/apply-translations.mjs` 按磁盘真实覆盖率生成，不写死、不虚报。');
  lines.push('- 未翻译的 key **回退英文**（不是 404、不是 `[missing:]`），但**不是真翻译**，不得当作已本地化。');
  lines.push('');
  lines.push('## 2. 5 语言真实翻译覆盖率（诚实口径）');
  lines.push('');
  lines.push('> `translated` = 值**与 en 不同**的 key 数（可证不是英文占位）；`target-script` = 值中含目标语言脚本字符的 key 数（日文假名/韩文/西里尔/泰文；es 用重音符号，天然偏低，仅作第二证据）。');
  lines.push('');
  lines.push('| locale | translated / total | 覆盖率 | target-script | 未翻译（英文占位） |');
  lines.push('|---|---|---|---|---|');
  for (const locale of MACHINE_LOCALES) {
    const coverage = coverages[locale];
    lines.push(
      `| \`${locale}\` | ${coverage.translated} / ${coverage.total} | ${coverage.percent}% | ${coverage.scriptHits} | ${coverage.identical} |`,
    );
  }
  lines.push('');
  const worst = MACHINE_LOCALES.reduce((low, locale) => (coverages[locale].translated < coverages[low].translated ? locale : low), MACHINE_LOCALES[0]);
  lines.push(`- **未完成项（如实）**：5 语言均**不是全量翻译**；最低的 \`${worst}\` 只有 ${coverages[worst].translated}/${coverages[worst].total}（${coverages[worst].percent}%）。`);
  lines.push('- 已译范围：`nav.*`、`common.*`、`app.*`（品牌位除外）、`agent.guide.*`/`agent.action.*`/`agent.empty.*`/`agent.error.*`、`settings.group.*`/`settings.title`/`settings.save*`、empty states、`status.*`、`severity.*`、`errors.*`（全部错误码）、`a11y.*`、`about.*`。');
  lines.push('- 未译范围：`settings.*` 的 schema 字段/枚举/说明（584 条中的绝大部分）、`alerts.*`/`analysis.*`/`overview.*` 的表格列与详情文案。');
  lines.push('');
  lines.push('## 3. en 的 CJK 白名单（最小、显式）');
  lines.push('');
  const cjkKeys = Object.entries(en).filter(([, value]) => HAN_PATTERN.test(String(value))).map(([key]) => key);
  lines.push(`en 里含 CJK 的 key：**${cjkKeys.length} 个**（字符数 ${cjkKeys.reduce((sum, key) => sum + (String(en[key]).match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) ?? []).length, 0)} 个 CJK 汉字）。`);
  lines.push('');
  lines.push('| key | 值 | 判定 |');
  lines.push('|---|---|---|');
  for (const key of cjkKeys) {
    const judgement = EN_CJK_WHITELIST[key] ?? '**不在白名单 → 视为漏翻（i18n-check 判红）**';
    lines.push(`| \`${key}\` | ${JSON.stringify(en[key])} | ${judgement} |`);
  }
  lines.push('');
  lines.push('白名单外新增任何 CJK 都会被 `scripts/i18n-check.mjs` 判 `EN_CJK` 错误（`--strict-en-cjk` 时白名单也判红）。');
  lines.push('');
  lines.push('## 4. 命名空间分布（en.json 现读）');
  lines.push('');
  lines.push('| 命名空间 | 条数 |');
  lines.push('|---|---|');
  const namespaces = new Map();
  for (const key of Object.keys(en)) {
    const namespace = key.split('.')[0];
    namespaces.set(namespace, (namespaces.get(namespace) ?? 0) + 1);
  }
  for (const [namespace, count] of [...namespaces.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`.${namespace}\` | ${count} |`);
  }
  lines.push('');
  lines.push('## 5. 本轮（UI-POLISH T3）工具与命令');
  lines.push('');
  lines.push('```bash');
  lines.push('node apps/console-next/i18n/tools/apply-translations.mjs --dry-run   # 预览 5 语言覆盖率，不写盘');
  lines.push('node apps/console-next/i18n/tools/apply-translations.mjs             # 并入译文表 + 更新 meta/README');
  lines.push('node apps/console-next/i18n/tools/merge-pending.mjs --dry-run        # 预览 _pending 合并（等 lead 通知后跑）');
  lines.push('node apps/console-next/i18n/tools/merge-pending.mjs                  # 真合并 + 其余 5 语言补 en 值');
  lines.push('node apps/console-next/i18n/tools/sync-readme.mjs --check            # README 与磁盘一致性校验（exit 1 = 过期）');
  lines.push('node scripts/i18n-check.mjs                                          # 仓库级门禁（7 语言一致/占位符/CJK/泄漏/回落）');
  lines.push('```');
  lines.push('');
  lines.push('## 6. 维护规则（本轮更新）');
  lines.push('');
  lines.push('1. `locales/*.json` 一律用脚本改（`tools/apply-translations.mjs` / `tools/merge-pending.mjs`），不手改 1000 行 JSON。');
  lines.push('2. key 集合必须与 `en.json` 完全一致；占位符 `{name}` 集合必须一致（`scripts/i18n-check.mjs` 判红）。');
  lines.push('3. 新增/修改代码里的文案 → 先加 en，再在 `tools/translations/*.json` 补 5 语言译文，然后跑 apply。');
  lines.push('4. 每轮翻译后 `meta._note` 与 README 覆盖率必须等于磁盘真实数字；**禁止写"已全量翻译"**。');
  lines.push('5. 回落链（2026-11-05 起）：`当前语言 → en`，**不再回落 zh-CN**（`js/i18n.js` 的 `SECOND_FALLBACK_LOCALE` 仅为兼容导出）。');
  lines.push(END);
  return lines.join('\n');
}

const HEADER_OLD = [
  '- **本文件由 `tests/e2e/i18n/make-readme.mjs` 生成，手改会被覆盖。**',
  '  改 locale 事实请改磁盘文件（或 `tests/e2e/i18n/build-locales.mjs`），改映射表请改',
  '  `tests/e2e/i18n/readme-mapping.md`。',
].join('\n');
const HEADER_NEW = [
  '- **§1–§6 由 `apps/console-next/i18n/tools/sync-readme.mjs` 从磁盘重写**（生成器仍在',
  '  `tests/e2e/i18n/make-readme.mjs`，本轮由 T3 手工同步；如需改数字请重跑工具，不要手改本节）。',
  '- 改 locale 事实请改磁盘文件（`locales/*.json`）或译文表（`tools/translations/*.json`），',
  '  改 v1→v2 映射请改 `tests/e2e/i18n/readme-mapping.md`。',
].join('\n');

/** 只重写 AUTO 区块；没有标记时替换 §1..§4 旧区段（首次迁移用）。 */
function replaceBlock(text, block) {
  const headed = text.includes(HEADER_OLD) ? text.replace(HEADER_OLD, HEADER_NEW) : text;
  if (headed.includes(BEGIN) && headed.includes(END)) {
    const start = headed.indexOf(BEGIN);
    const end = headed.indexOf(END) + END.length;
    return `${headed.slice(0, start)}${block}${headed.slice(end)}`;
  }
  const startMarker = '## 1. 文件与规模';
  const endMarker = '## 3. 怎么改（唯一正确姿势）';
  const start = headed.indexOf(startMarker);
  const end = headed.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('README 结构已变：既没有 T3:AUTO 标记，也找不到 §1/§3 边界');
  }
  return `${headed.slice(0, start)}${block}\n\n${headed.slice(end)}`;
}

export function syncReadme({ en = null, dicts = null, write = true } = {}) {
  const all = loadAll();
  const base = en ?? all.en;
  const dictionaries = dicts ?? all;
  const before = fs.readFileSync(README, 'utf8');
  const block = buildBlock(base, dictionaries);
  const after = replaceBlock(before, block);
  const changed = after !== before;
  if (write && changed) fs.writeFileSync(README, after, 'utf8');
  return {
    path: README,
    changed,
    sha256: write ? sha256File(README) : null,
    coverage: Object.fromEntries(MACHINE_LOCALES.map((locale) => [locale, coverageOf(base, dictionaries[locale] ?? {}, locale)])),
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  try {
    const result = syncReadme({ write: !check });
    process.stdout.write(`sync-readme: ${check ? (result.changed ? 'STALE（README 与磁盘不一致，需重跑）' : 'OK（README 与磁盘一致）') : `wrote ${path.relative(process.cwd(), result.path)} sha256=${result.sha256}`}\n`);
    for (const [locale, coverage] of Object.entries(result.coverage)) {
      process.stdout.write(`  ${locale}: ${coverage.translated}/${coverage.total} (${coverage.percent}%)\n`);
    }
    process.exitCode = check && result.changed ? 1 : 0;
  } catch (error) {
    process.stderr.write(`sync-readme: ${error.message}\n`);
    process.exitCode = 2;
  }
}
