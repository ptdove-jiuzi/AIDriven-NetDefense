#!/usr/bin/env node
/**
 * tests/e2e/i18n/make-readme.mjs — INT-2 / i18n 席
 *
 * 生成 `apps/console-next/i18n/README.md`。
 *
 * 为什么要有生成器：
 *   README 里的"每个 locale 有多少条 / key 集合是否一致 / meta 标了什么"是**磁盘事实**，
 *   手写必然漂移（曾出现过 README 写 `_machine:true`、磁盘已是 `_machine:false` 的冲突，
 *   还触发 `scripts/i18n-check.mjs` 的 `META_MACHINE_UNTRANSLATED` 警告）。
 *   现在这些表格一律从 `locales/*.json` 与 `locales/*.meta.json` 现读现写；
 *   v1→v2 映射表这类**历史数据**放在 `tests/e2e/i18n/readme-mapping.md` 里原样嵌入。
 *
 * 口径（2026-11-04 定）：
 *   - `en` / `zh-CN`：人工撰写，`_machine:false`；
 *   - `ja` / `ko` / `es` / `ru` / `th`：**en 的精确副本（占位）**，`_machine:false`
 *     （不是机翻，不能标 true），`_note` 写明 PLACEHOLDER，UI 对这些语言回退英文。
 *
 * 用法：
 *   node tests/e2e/i18n/make-readme.mjs            # 重新生成 README
 *   node tests/e2e/i18n/make-readme.mjs --check    # 只比对，不写盘（README 过期则 exit 1）
 *
 * 退出码：0；1 README 过期（--check）；2 用法错误。
 *
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const I18N_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'i18n');
const LOCALES_DIR = path.join(I18N_DIR, 'locales');
const README = path.join(I18N_DIR, 'README.md');
const MAPPING = path.join(HERE, 'readme-mapping.md');

const ALL_LOCALES = ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th'];
const HAND_WRITTEN = new Set(['en', 'zh-CN']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function localeFacts() {
  const enTable = fs.existsSync(path.join(LOCALES_DIR, 'en.json'))
    ? readJson(path.join(LOCALES_DIR, 'en.json'))
    : {};
  return ALL_LOCALES.map((locale) => {
    const file = path.join(LOCALES_DIR, `${locale}.json`);
    const metaFile = path.join(LOCALES_DIR, `${locale}.meta.json`);
    const exists = fs.existsSync(file);
    const table = exists ? readJson(file) : {};
    const meta = fs.existsSync(metaFile) ? readJson(metaFile) : {};
    const keys = Object.keys(table);
    const translated = HAND_WRITTEN.has(locale)
      ? keys.length
      : keys.filter((key) => typeof table[key] === 'string' && table[key] !== enTable[key]).length;
    return {
      locale,
      exists,
      keys: keys.length,
      bytes: exists ? fs.statSync(file).size : 0,
      machine: meta._machine,
      source: meta._source,
      note: typeof meta._note === 'string' ? meta._note : '',
      handWritten: HAND_WRITTEN.has(locale),
      translated,
      total: keys.length,
    };
  });
}

/** key 命名空间统计。 */
function namespaceFacts(table) {
  const counts = new Map();
  for (const key of Object.keys(table)) {
    const head = key.split('.')[0];
    counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function buildReadme() {
  const facts = localeFacts();
  const base = facts.find((entry) => entry.locale === 'en');
  const zh = facts.find((entry) => entry.locale === 'zh-CN');
  const table = readJson(path.join(LOCALES_DIR, 'en.json'));
  const namespaces = namespaceFacts(table);
  const mapping = fs.readFileSync(MAPPING, 'utf8').trimEnd();
  const sameKeySet = facts.every((entry) => entry.exists && entry.keys === base.keys);
  const cjkEntries = Object.entries(table)
    .filter(([, value]) => /[\u3400-\u9fff]/u.test(value))
    .map(([key]) => key);

  const lines = [];
  lines.push('# WebUI v2 i18n（`apps/console-next/i18n/`）');
  lines.push('');
  lines.push('- 作者：PT-dove');
  lines.push('- 合同：`docs/implementation/CONSOLE-V2-CONTRACT.md` §8（v1.2 key 语法）');
  lines.push('- 检查脚本：`node scripts/i18n-check.mjs --dir apps/console-next/i18n/locales`');
  lines.push('- **本文件由 `tests/e2e/i18n/make-readme.mjs` 生成，手改会被覆盖。**');
  lines.push('  改 locale 事实请改磁盘文件（或 `tests/e2e/i18n/build-locales.mjs`），改映射表请改');
  lines.push('  `tests/e2e/i18n/readme-mapping.md`。');
  lines.push('');
  lines.push('## 1. 文件与规模（本表由磁盘现读，不是手写）');
  lines.push('');
  lines.push('| 文件 | key 数 | 字节 | 状态 | meta |');
  lines.push('|---|---|---|---|---|');
  for (const entry of facts) {
    if (!entry.exists) {
      lines.push(`| \`locales/${entry.locale}.json\` | **缺失** | 0 | ✗ | — |`);
      continue;
    }
    const state = entry.handWritten
      ? '人工撰写'
      : entry.translated === 0
        ? 'en 副本（占位，0 条翻译）'
        : `部分机翻（${entry.translated}/${entry.total} 条）`;
    const meta = `\`_machine:${String(entry.machine)}\`, \`_source:${String(entry.source)}\``;
    lines.push(`| \`locales/${entry.locale}.json\` | ${entry.keys} | ${entry.bytes} | ${state} | ${meta} |`);
  }
  lines.push('');
  lines.push(`- 语言数：${facts.length}；en 基准 key：**${base.keys}**；7 语言 key 集合${sameKeySet ? '**完全一致**' : '**不一致（缺陷）**'}。`);
  lines.push(`- \`zh-CN\`：${zh.exists ? zh.keys : 0} 条，**默认语言（主路径）**，人工撰写、100% 完整。`);
  lines.push('- `en` / `zh-CN` 是源语言（`_machine:false`，人工撰写）。');
  lines.push('- 其余 5 语言的 meta **按内容自动推导**（`build-locales.mjs`），不写死：');
  lines.push('  - 一条都没翻译（全部与 en 相同）→ `_machine:false` + `_note:"PLACEHOLDER exact copy of en pending translation"`；');
  lines.push('  - 翻译了一部分 → `_machine:true` + `_note:"partial machine translation: N/M keys translated; …"`。');
  lines.push('  - 未翻译的部分 **UI 回退英文**：不 404、不出现 `[missing:]`，但不是真翻译，不得当成已本地化。');
  const partials = facts.filter((entry) => !entry.handWritten && entry.translated > 0);
  if (partials.length > 0) {
    lines.push(`- 当前状态：${partials.map((entry) => `\`${entry.locale}\` ${entry.translated}/${entry.total}`).join('、')} 条已机翻，`);
    lines.push('  其余仍是英文占位；完整翻译待补。');
  }
  lines.push(`- key 语法：\`^[a-z][a-z0-9]*(?:\\.[a-z0-9-]+)+$\`；唯一例外 \`errors.<UPPER_SNAKE>\` 与回落键 \`errors.unknown\`（合同 §8.3）。`);
  lines.push(`- en.json 里保留 CJK 的 key（白名单，${cjkEntries.length} 条）：${cjkEntries.map((key) => `\`${key}\``).join('、')}`);
  lines.push('  —— 品牌中文名 + 语言原生名，属产品标识，不是漏译。');
  lines.push('');
  lines.push('## 2. 命名空间分布（en.json 现读）');
  lines.push('');
  lines.push('| 命名空间 | 条数 |');
  lines.push('|---|---|');
  for (const [name, count] of namespaces) lines.push(`| \`.${name}\` | ${count} |`);
  lines.push('');
  lines.push('## 3. 怎么改（唯一正确姿势）');
  lines.push('');
  lines.push('```bash');
  lines.push('# 1) 源码变了先重抽 key（看新增/消失）');
  lines.push('node tests/e2e/i18n/extract-keys.mjs');
  lines.push('# 2) 改人工词条（en+zh 成对；唯一手改入口）');
  lines.push('#    tests/e2e/i18n/catalog/views.mjs        app/nav/common/errors/overview/alerts/analysis/agent');
  lines.push('#    tests/e2e/i18n/catalog/settings.mjs     设置页骨架');
  lines.push('#    tests/e2e/i18n/catalog/schema-text.mjs  schema 下发的 label/hint、子字段、枚举值');
  lines.push('# 3) 构建（硬校验 key 集合/占位符/空值/HTML/en 含 CJK/schema 必需文本）');
  lines.push('node tests/e2e/i18n/build-locales.mjs');
  lines.push('# 4) 错误码覆盖门禁（errors.<CODE> 缺一条就红）');
  lines.push('node tests/e2e/i18n/check-error-codes.mjs');
  lines.push('# 5) 真浏览器验收（6 路由 × zh/en × 2 条切语言路径）');
  lines.push('node tests/e2e/i18n/verify-i18n.mjs --base http://127.0.0.1:17512 --mode both');
  lines.push('# 6) 仓库级校验 + 重生成本文件');
  lines.push('node scripts/i18n-check.mjs --dir apps/console-next/i18n/locales');
  lines.push('node tests/e2e/i18n/make-readme.mjs');
  lines.push('```');
  lines.push('');
  lines.push(mapping);
  lines.push('');
  lines.push('## 4. 维护规则');
  lines.push('');
  lines.push('1. **不要手改 `locales/*.json`**：它们是 `build-locales.mjs` 的产物，手改会被覆盖并绕过硬校验。');
  lines.push('2. key 集合必须与 `en.json` 完全一致（多/少都会被 `build-locales.mjs --check` 与 `scripts/i18n-check.mjs` 判失败）。');
  lines.push('3. key 全小写 + kebab；错误码命名空间例外见合同 §8.3。');
  lines.push('4. `{name}` 占位符集合跨语言必须一致；数值/日期格式化用 `Intl`，不要在文案里手拼。');
  lines.push('5. 新增错误码时同步加 `errors.<CODE>`，否则 `check-error-codes.mjs` 会红（P1-2 就是这么漏的）。');
  lines.push('6. 补齐 ja/ko/es/ru/th：把对应 `locales/<locale>.json` 的值换成真翻译，并把 meta 改成');
  lines.push('   `_machine:true` + `_source:"en"` + 真实 `_note`；key 集合不得变动。');
  lines.push('7. 改完必须跑 §3 的 1–6，并把真实输出写进 `docs/implementation/evidence/ui2/i18n/STATUS.md`。');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('作者：PT-dove');
  lines.push('');
  return { text: lines.join('\n'), facts, sameKeySet };
}

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`未知参数：${unknown.join(' ')}\n`);
    process.exit(2);
  }
  const { text, facts, sameKeySet } = buildReadme();
  const current = fs.existsSync(README) ? fs.readFileSync(README, 'utf8') : '';
  if (checkOnly) {
    if (current !== text) {
      process.stderr.write('README 与磁盘事实不一致（跑 node tests/e2e/i18n/make-readme.mjs 重生成）\n');
      process.exit(1);
    }
    process.stdout.write('README 与磁盘事实一致\n');
    process.exit(0);
  }
  fs.writeFileSync(README, text, 'utf8');
  process.stdout.write(
    `README 已生成：${path.relative(REPO_ROOT, README)}（${facts.map((entry) => `${entry.locale}=${entry.keys}`).join(' ')}，key 集合${sameKeySet ? '一致' : '不一致'}，${text.length} 字节）\n`,
  );
  process.exit(sameKeySet ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
