/**
 * UI-POLISH T3 · `tools/merge-pending.mjs` 的夹具自测（用 locale 副本演练，不碰产品文件）
 *
 * 为什么要这份测试：合并 _pending 是**破坏性写盘**动作（改 en/zh-CN 与 5 语言），
 * 必须先在副本上证明：①新 key 真的进 7 语言；②en/zh-CN 拿各自主语言文案；
 * ③5 语言补的是 en 占位（不是假的"已翻译"）；④key 冲突时不落盘、exit 1。
 *
 * 实现：把 `apps/console-next/i18n/locales` 与 README 复制到系统临时目录，
 * 用 `T3_I18N_DIR` 指向副本跑 CLI（工具支持该覆盖变量，仅用于自测）。
 *
 * 运行：`node --test tests/console-next/i18n-pending-merge.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const I18N_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'i18n');
const TOOL = path.join(I18N_DIR, 'tools', 'merge-pending.mjs');
const LANGS = ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th'];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-merge-'));
  fs.mkdirSync(path.join(root, 'locales'), { recursive: true });
  fs.mkdirSync(path.join(root, '_pending'), { recursive: true });
  for (const name of fs.readdirSync(path.join(I18N_DIR, 'locales'))) {
    fs.copyFileSync(path.join(I18N_DIR, 'locales', name), path.join(root, 'locales', name));
  }
  fs.copyFileSync(path.join(I18N_DIR, 'README.md'), path.join(root, 'README.md'));
  return root;
}

function runTool(root, args = []) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, T3_I18N_DIR: root },
  });
}

const readLocale = (root, lang) => JSON.parse(fs.readFileSync(path.join(root, 'locales', `${lang}.json`), 'utf8'));

test('merge-pending 夹具：新 key 进 7 语言，en/zh 各拿本语言文案，5 语言补 en 占位', (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const beforeCount = Object.keys(readLocale(root, 'en')).length;
  fs.writeFileSync(path.join(root, '_pending', 'agent.json'), `${JSON.stringify({
    en: { 'agent.selftest.title': 'Self-test title', 'agent.selftest.body': 'Probe body with {count} items' },
    'zh-CN': { 'agent.selftest.title': '自测标题', 'agent.selftest.body': '含 {count} 条目的探针正文' },
  }, null, 2)}\n`, 'utf8');

  const dry = runTool(root, ['--dry-run']);
  assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr}${dry.stdout}`);
  assert.match(dry.stdout, /new-keys=2/u);
  assert.equal(Object.keys(readLocale(root, 'en')).length, beforeCount, 'dry-run must not write');

  const run = runTool(root);
  assert.equal(run.status, 0, `merge failed: ${run.stderr}${run.stdout}`);
  assert.match(run.stdout, /MERGED/u);
  assert.match(run.stdout, /consistency .*"equal":true/u);

  for (const lang of LANGS) {
    const dict = readLocale(root, lang);
    assert.equal(Object.keys(dict).length, beforeCount + 2, `${lang} key count must grow by 2`);
    assert.ok(Object.prototype.hasOwnProperty.call(dict, 'agent.selftest.title'), `${lang} missing merged key`);
    assert.ok(Object.prototype.hasOwnProperty.call(dict, 'agent.selftest.body'), `${lang} missing merged key`);
  }
  assert.equal(readLocale(root, 'en')['agent.selftest.title'], 'Self-test title');
  assert.equal(readLocale(root, 'zh-CN')['agent.selftest.title'], '自测标题');
  for (const lang of ['ja', 'ko', 'es', 'ru', 'th']) {
    assert.equal(readLocale(root, lang)['agent.selftest.title'], 'Self-test title', `${lang} must carry the en placeholder (not a fake translation)`);
    assert.equal(readLocale(root, lang)['agent.selftest.body'], 'Probe body with {count} items');
  }
  const jaMeta = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'ja.meta.json'), 'utf8'));
  assert.equal(jaMeta._machine, true);
  assert.equal(jaMeta._coverage.total, beforeCount + 2, 'meta total must follow the new key count');
});

test('merge-pending 夹具：key 冲突默认 exit 1 且一字不写；显式 --overwrite 才以 pending 为准并记录冲突', (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(root, 'locales', 'en.json'), 'utf8');
  const beforeMeta = fs.readFileSync(path.join(root, 'locales', 'ja.meta.json'), 'utf8');
  fs.writeFileSync(path.join(root, '_pending', 'conflict.json'), `${JSON.stringify({
    en: { 'nav.overview': 'Overview (conflicting rewrite)' },
    'zh-CN': { 'nav.overview': '总览（冲突改写）' },
  }, null, 2)}\n`, 'utf8');

  // (a) 默认：拒收，不落盘
  const refused = runTool(root);
  assert.equal(refused.status, 1, 'conflicting pending must fail without --overwrite');
  assert.match(refused.stdout, /KEY_CONFLICT/u);
  assert.equal(fs.readFileSync(path.join(root, 'locales', 'en.json'), 'utf8'), before, 'en.json must be untouched');
  assert.equal(fs.readFileSync(path.join(root, 'locales', 'ja.meta.json'), 'utf8'), beforeMeta, 'meta must be untouched');

  // (b) --overwrite：以 pending 为准，且回报冲突清单；5 语言既有译文保持不动
  const jaBefore = readLocale(root, 'ja')['nav.overview'];
  const applied = runTool(root, ['--overwrite']);
  assert.equal(applied.status, 0, `--overwrite merge failed: ${applied.stderr}${applied.stdout}`);
  assert.match(applied.stdout, /conflicts=1/u);
  assert.equal(readLocale(root, 'en')['nav.overview'], 'Overview (conflicting rewrite)');
  assert.equal(readLocale(root, 'zh-CN')['nav.overview'], '总览（冲突改写）');
  assert.equal(readLocale(root, 'ja')['nav.overview'], jaBefore, 'existing 5-language translation must be preserved');
});

test('merge-pending 夹具：zh-CN 缺 key / en 含汉字 / 占位符不一致 都拒收（不写盘）', (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(root, 'locales', 'zh-CN.json'), 'utf8');
  fs.writeFileSync(path.join(root, '_pending', 'bad.json'), `${JSON.stringify({
    en: {
      'agent.bad.zh-missing': 'Only English provided',
      'agent.bad.en-cjk': '这是中文漏进 en 了',
      'agent.bad.placeholder': 'Uses {count} placeholder',
    },
    'zh-CN': {
      'agent.bad.en-cjk': '中文没问题',
      'agent.bad.placeholder': '占位符写错 {total}',
    },
  }, null, 2)}\n`, 'utf8');

  const run = runTool(root);
  assert.equal(run.status, 1, 'invalid pending must fail');
  for (const code of ['PENDING_ZH_MISSING', 'PENDING_EN_CJK', 'PENDING_PLACEHOLDER']) {
    assert.match(run.stdout, new RegExp(code, 'u'), `expected ${code} in output`);
  }
  assert.equal(fs.readFileSync(path.join(root, 'locales', 'zh-CN.json'), 'utf8'), before, 'zh-CN.json must be untouched');
});
