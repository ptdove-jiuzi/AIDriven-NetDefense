/**
 * tests/console/console-cascade.test.js — SEED-02 / R6-002 的层叠判据。
 *
 * SEED-02 的缺陷不是「DOM 属性没设置」，而是层叠：`.drawer { display:flex }`
 * 打败了 UA 的 `[hidden] { display:none }`。旧断言（只看 `drawer.hidden`）删掉
 * `[hidden] { display:none !important }` 也照样绿 —— 本文件让这件事能失败。
 *
 * 三件事：
 * 1. 源码 `apps/console/styles.css`：抽屉在 `hidden` 下必须演算出 `display:none`；
 * 2. 缺陷等价变体（删 `!important`）与**真实已交付副本**（sha 25B68C6E…）必须演算出
 *    `display:flex` —— 证明判据抓得住 SEED-02，不是自说自话；
 * 3. 用仓库冻结脚本 `tests/packaging/freeze-console.mjs` 把 `apps/console` 冻结到
 *    **系统临时目录**（绝不写 `dist/**`），断言新载荷带兜底规则且与源码逐字节一致。
 *
 * 运行：node --test tests/console/console-cascade.test.js
 *
 * 作者：PT-dove
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { freezeConsole, sha256File } from '../packaging/freeze-console.mjs';
import {
  assertAtRulesHarmless,
  defectVariant,
  drawerElement,
  hasGlobalHiddenImportant,
  resolveDisplay,
} from './css-cascade.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CONSOLE_DIR = path.join(REPO_ROOT, 'apps', 'console');
const STYLES = path.join(CONSOLE_DIR, 'styles.css');

/** SEED-02 记录在案的失效副本 sha256（12 份 dist/** + .publish/** 同源）。 */
const DELIVERED_BROKEN_SHA = '25b68c6ed6add24d8f7ca178a2086b101462a0f217d804698d0f0edd4471bf9e';

/** 已知的已交付副本（只读；存在就取第一份做真实缺陷样本）。 */
const DELIVERED_CANDIDATES = [
  path.join(REPO_ROOT, '.publish', 'AIDriven-NetDefense', 'apps', 'console', 'styles.css'),
  path.join(REPO_ROOT, 'dist', '_v14-inputs', 'console', 'styles.css'),
  path.join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v15', 'console', 'styles.css'),
];

const readStyles = () => fs.readFileSync(STYLES, 'utf8');

describe('SEED-02 / R6-002：抽屉关闭的层叠判据', () => {
  it('源码 style：<aside class="drawer" hidden> 最终 display 必须是 none', () => {
    const css = readStyles();
    assertAtRulesHarmless(css);

    assert.equal(hasGlobalHiddenImportant(css), true,
      '[hidden] { display:none !important } 被删掉：.drawer{display:flex} 会赢，抽屉关不掉');

    const resolved = resolveDisplay(css, drawerElement());
    assert.equal(resolved.display, 'none', `层叠结果应为 none，实际 ${resolved.display}（胜出：${resolved.winner.selector}）`);
    assert.equal(resolved.winner.important, true, '兜底规则必须是 !important，否则与 .drawer 同优先级、源码顺序决定胜负');
    assert.equal(resolved.winner.selector.trim(), '[hidden]');
  });

  it('把 !important 删掉的缺陷等价变体必须演算出 flex（证明断言能失败）', () => {
    const broken = defectVariant(readStyles());
    assert.equal(hasGlobalHiddenImportant(broken), false);
    const resolved = resolveDisplay(broken, drawerElement());
    assert.equal(resolved.display, 'flex',
      `删掉 !important 后 .drawer{display:flex} 应胜出（实际 ${resolved.display}）：这条不成立说明演算器抓不住 SEED-02`);
    assert.equal(resolved.winner.selector.trim(), '.drawer');
  });

  it('真实已交付副本（sha 25B68C6E…）必须演算出 flex —— 断言不是自说自话', (t) => {
    const delivered = DELIVERED_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (!delivered) {
      t.diagnostic('交付副本不在本机（.publish / dist 未构建），跳过真实缺陷样本比对');
      return;
    }
    const sha = sha256File(delivered);
    assert.equal(sha, DELIVERED_BROKEN_SHA,
      `${delivered} 不是 SEED-02 记录的失效副本，证据锚点变了，需要重新采样`);
    const css = fs.readFileSync(delivered, 'utf8');
    assert.equal(hasGlobalHiddenImportant(css), false, '交付副本本来就不含兜底规则');
    assert.equal(resolveDisplay(css, drawerElement()).display, 'flex',
      '交付副本上抽屉关不掉的根因就是这条层叠结果');
  });
});

describe('SEED-02：新载荷必须带兜底规则（冻结到临时目录，不写 dist/**）', () => {
  it('freeze-console 的副本含 [hidden]{display:none !important} 且与源码逐字节一致', () => {
    const sourceCss = readStyles();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-shell-freeze-'));
    try {
      const result = freezeConsole({ source: CONSOLE_DIR, dest, attempts: 3 });
      assert.equal(result.ok, true, `冻结失败：${(result.failures ?? []).join(' | ')}`);
      assert.equal(result.stable, true);
      assert.equal(result.snapshotDigest, result.sourceDigest, '冻结副本必须与源码目录摘要一致');

      const copied = path.join(dest, 'styles.css');
      assert.equal(fs.existsSync(copied), true);
      assert.equal(sha256File(copied), sha256File(STYLES), '新载荷里的 styles.css 必须与源码同字节');

      const copyCss = fs.readFileSync(copied, 'utf8');
      assert.equal(hasGlobalHiddenImportant(copyCss), true, '新载荷缺 [hidden]{display:none !important}：SEED-02 未随载荷修复');
      assert.match(copyCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/u);
      assert.equal(resolveDisplay(copyCss, drawerElement()).display, 'none', '新载荷上抽屉必须关得掉');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
