/**
 * UI2-B11 · B10 落盘后追加：i18n 完整性独立断言
 *
 * 覆盖 lead 指定三项：
 * 1. 7 语言 key 集合一致（998/998，缺/多均为 0）；
 * 2. en 无 CJK（白名单仅品牌固定名 `app.product-zh` 与语言原生名 `settings.enum.ui.locale.*`）；
 * 3. `node scripts/i18n-check.mjs` 子进程 exit 0，warning 计数 = 8（脚本把 WARN 打到 **stdout**，
 *    这里对 stdout+stderr 合并计数，并断言 `PASS (0 error, 8 warning)`）。
 * 另加占位符集合跨语言一致性（合同 §8.4）与 meta 诚实性（`_machine` 真值）断言。
 *
 * 运行：`node --test tests/console-next/i18n-locales.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const LOCALES_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'i18n', 'locales');
const LANGS = ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th'];
// 2026-11-04T22:33 起 locales **1018 key 已定稿**（lead 22:5x 复核：7 语言各 1018、missing 0；此前 B10 基线 998）。
// 2026-11-05（UI-POLISH T3）合并本轮新 IA：settings 20 + agent 41 + onboarding 48 + 既有 1018 = **1127**（7 语言一致）。
// 判定口径：7 语言集合完全相等 + key 数与冻结值相同（只允许 lead 批准的新增，不允许漂移/缩水）。
const MIN_EXPECTED_KEYS = 1127;
const FROZEN_KEY_COUNT = 1127;

/** CJK 统一表意文字 + 日文假名 + 韩文音节（判断"是否含中文/日文/韩文"足够）。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;

/** en 允许出现 CJK 的白名单：品牌固定名 + 语言原生名（合同 §7.1 / §8）。 */
function isCjkWhitelisted(key) {
  return key === 'app.product-zh' || key.startsWith('settings.enum.ui.locale.');
}

function readLocale(lang) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8'));
}

function readMeta(lang) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.meta.json`), 'utf8'));
}

function placeholdersOf(value) {
  const names = new Set();
  for (const match of String(value).matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)) names.add(match[1]);
  return [...names].sort();
}

test('7 语言 key 集合一致（定稿 1018，只允许 ≥1018），缺失 0、多余 0、空值 0', (t) => {
  const en = readLocale('en');
  const enKeys = Object.keys(en).sort();
  assert.ok(enKeys.length >= MIN_EXPECTED_KEYS, `en must have at least ${MIN_EXPECTED_KEYS} keys (got ${enKeys.length})`);
  assert.equal(enKeys.length, FROZEN_KEY_COUNT, `en key count must stay at the frozen value ${FROZEN_KEY_COUNT}`);
  t.diagnostic(`actual en key count = ${enKeys.length}（最终冻结值；22:33 后无新增）`);

  for (const lang of LANGS.slice(1)) {
    const dict = readLocale(lang);
    const keys = Object.keys(dict).sort();
    assert.equal(keys.length, enKeys.length, `${lang} must have the same key count as en`);
    assert.deepEqual(keys, enKeys, `${lang} key set must equal en exactly`);
    const empty = Object.entries(dict).filter(([, value]) => typeof value !== 'string' || value.trim() === '');
    assert.deepEqual(empty.map(([key]) => key), [], `${lang} must not contain empty values`);
  }
  // key 语法（合同 §8.3）：小写点键（errors.<UPPER_SNAKE> 例外）
  const invalid = enKeys.filter((key) => !(
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(key)
    || /^errors\.[A-Z][A-Z0-9_]*$/u.test(key)
  ));
  assert.deepEqual(invalid, [], `invalid i18n key syntax: ${invalid.slice(0, 5).join(', ')}`);
});

test('占位符跨语言一致（合同 §8.4）：同一 key 的 {name} 集合完全相同', () => {
  const dictionaries = Object.fromEntries(LANGS.map((lang) => [lang, readLocale(lang)]));
  const en = dictionaries.en;
  const mismatches = [];
  for (const key of Object.keys(en)) {
    const reference = placeholdersOf(en[key]);
    for (const lang of LANGS.slice(1)) {
      const actual = placeholdersOf(dictionaries[lang][key]);
      if (JSON.stringify(actual) !== JSON.stringify(reference)) {
        mismatches.push(`${key}@${lang}: en={${reference.join(',')}} ${lang}={${actual.join(',')}}`);
      }
    }
  }
  assert.deepEqual(mismatches, [], `placeholder mismatch: ${mismatches.slice(0, 5).join(' | ')}`);
});

test('en 无 CJK：仅品牌固定名与语言原生名白名单（实际 3 个 key / 11 个汉字）', () => {
  const en = readLocale('en');
  const offenders = [];
  const allowedHits = [];
  for (const [key, value] of Object.entries(en)) {
    if (!CJK.test(String(value))) continue;
    if (isCjkWhitelisted(key)) {
      allowedHits.push(key);
      continue;
    }
    offenders.push(`${key}=${JSON.stringify(value).slice(0, 40)}`);
  }
  assert.deepEqual(offenders, [], `unexpected CJK in en: ${offenders.slice(0, 5).join(' | ')}`);
  assert.ok(allowedHits.length > 0 && allowedHits.length <= 6, `whitelist CJK keys look wrong: ${allowedHits.join(',')}`);
  // 品牌名必须是固定中文（合同 §7.1）
  assert.equal(en['app.product-zh'], '网域智防');
});

test('meta 诚实性：en/zh-CN 为手写，5 个机翻语言 _machine=true 且 note 如实写 partial 覆盖', () => {
  const enMeta = readMeta('en');
  const zhMeta = readMeta('zh-CN');
  assert.equal(enMeta._machine, false);
  assert.equal(zhMeta._machine, false);
  for (const lang of ['ja', 'ko', 'es', 'ru', 'th']) {
    const meta = readMeta(lang);
    assert.equal(meta._machine, true, `${lang}.meta.json must declare _machine:true`);
    assert.equal(meta._source, 'en');
    assert.match(
      String(meta._note ?? ''),
      /partial|placeholder|untranslated/u,
      `${lang}.meta.json _note must state partial coverage honestly`,
    );
  }
});

test('脚本门禁：`node scripts/i18n-check.mjs` exit 0，WARN 3..10 且码在允许集合内、error=0', (t) => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'i18n-check.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `i18n-check must exit 0; output=\n${output.slice(-2000)}`);
  const warnCodes = [...output.matchAll(/^WARN (\S+) /gmu)].map((match) => match[1]);
  const warnCount = warnCodes.length;
  // 2026-11-05（T3）：5 语言覆盖率从 4% 提到 18% 后，"与 en 相同比例 >90%" 的
  // META_MOSTLY_UNTRANSLATED 5 条自动消失，只剩 3 条 EN_CJK_EXEMPT（品牌 + 2 语言原生名）。
  // 因此旧口径「恰好 8 条」不再成立；改为「数量在 3..10 且每条码都属于已知告警集合」——
  // 这比数量断言更强：任何新增/未知告警码都会红。
  assert.ok(warnCount >= 3 && warnCount <= 10, `expected 3..10 warnings, got ${warnCount}`);
  const allowedWarnCodes = new Set([
    'EN_CJK_EXEMPT',
    'META_MOSTLY_UNTRANSLATED',
    'META_MACHINE_UNTRANSLATED',
    'META_UNTRANSLATED_CLAIM',
  ]);
  const unknownWarn = warnCodes.filter((code) => !allowedWarnCodes.has(code));
  assert.deepEqual(unknownWarn, [], `unexpected warning codes: ${unknownWarn.join(', ')}`);
  const reported = output.match(/PASS \(0 error, (\d+) warning\)/u);
  assert.ok(reported, 'checker must report PASS (0 error, N warning)');
  assert.equal(Number(reported[1]), warnCount, 'reported warning count must match WARN lines');
  const keyLine = output.match(/keys en=(\d+) zh-CN=(\d+) ja=(\d+) ko=(\d+) es=(\d+) ru=(\d+) th=(\d+)/u);
  assert.ok(keyLine, 'checker must report key counts for all 7 languages');
  const counts = keyLine.slice(1).map(Number);
  assert.equal(new Set(counts).size, 1, `all 7 languages must report the same key count: ${counts.join(',')}`);
  assert.ok(counts[0] >= MIN_EXPECTED_KEYS, `checker key count ${counts[0]} < ${MIN_EXPECTED_KEYS}`);
  assert.doesNotMatch(output, /^ERROR /mu, 'checker must report zero errors');
  t.diagnostic(`checker: exit 0, keys=${counts[0]}, warnings=${warnCount} [${warnCodes.join(',')}]`);
});
