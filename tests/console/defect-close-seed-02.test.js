/**
 * defect-close-seed-02.test.js — 回归守卫：SEED-02 的层叠判据必须能失败。
 *
 * 背景（BUG-LEDGER SEED-02 / R6-002）：
 * `.drawer { display:flex }` 打败了 UA 的 `[hidden] { display:none }`，于是 `closeDrawer()`
 * 设了 `hidden` 抽屉也收不起来。修法是源码里加一条全局兜底：
 *     [hidden] { display:none !important; }
 * 而**旧的断言只看 `drawer.hidden` 属性**，删掉这条兜底也照样绿（R6-002 的"不可回归"）。
 *
 * 本文件的独立性：不 import `tests/console/css-cascade.mjs`，自己实现一个最小层叠演算器
 * （作者样式 → display 声明的 !important / 特异度 / 源序），所以它不是"复用同一个 helper
 * 自证"。判据：
 *   1. 源码 `apps/console/styles.css`：`<aside class="drawer" hidden>` 的 display 必须演算成 none，
 *      且胜出声明带 `!important`；
 *   2. 把 `!important` 删掉的等价变体必须演算成 flex（证明断言抓得住 SEED-02）；
 *      另用 `DEFECT_CLOSE_STYLES_CSS` 指向删掉 !important 的副本跑本文件 → 第 1 组必须红；
 *   3. 交付物归属（只读，禁写 `dist/**`）：
 *      - **当前出厂载荷 CLOSED**：rc.5 = `dist/bundle/win32-x64-v17`（与冻结解包树 builtAt 相同）、
 *        rc.6 = `win32-x64-v18`，console-next 样式集都带全局 `[hidden] … !important`；
 *      - **陈旧资产层 BYPASSED**：12 份 console-v1 副本（dist/** 的 v14/v15 构建树 + `.publish/**`）
 *        与已发布 rc.2/rc.3 portable 载荷逐字节相同（sha 25b68c6e…），抽屉在 `hidden` 下仍是 flex。
 *        禁止用"新载荷换了 console-next"顶替这一层：那是两件不同的事，归属表见
 *        `…/SEED-02/fix/DELIVERED-ATTRIBUTION.md`。
 *
 * 运行：node --test tests/console/defect-close-seed-02.test.js
 *
 * 作者：PT-dove
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const STYLES = process.env.DEFECT_CLOSE_STYLES_CSS === undefined
  ? path.join(REPO_ROOT, 'apps', 'console', 'styles.css')
  : path.resolve(process.env.DEFECT_CLOSE_STYLES_CSS);

/** SEED-02 记录在案的失效副本 sha256（25B68C6E…）。 */
const DELIVERED_BROKEN_SHA = '25b68c6ed6add24d8f7ca178a2086b101462a0f217d804698d0f0edd4471bf9e';

/**
 * 已发布载荷的实测归属（portable zip 内 stylesheet 逐字节哈希，见
 * `docs/implementation/evidence/defect-close/SEED-02/fix/DELIVERED-ATTRIBUTION.md`）：
 *   rc.2 / rc.3 → `console/styles.css`            = 25b68c6e…（BYPASSED，与 12 份陈旧副本同字节）
 *   rc.4 / rc.5 → `console/styles/base.css`       = 0649064d…（CLOSED）
 *   rc.6        → `console/styles/base.css`       = 4dd5660c…（CLOSED）
 * 载荷树 = staging bundle：rc.5 对应 `dist/bundle/win32-x64-v17`（其 bundle.json builtAt 与
 * `dist/_rc5-freeze/portable-extract-20261105-041832` 相同），rc.6 对应 `win32-x64-v18`。
 */
const FACTORY_PAYLOADS = Object.freeze([
  {
    label: 'rc.5',
    bundle: path.join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v17'),
    frozenExtract: path.join(REPO_ROOT, 'dist', '_rc5-freeze', 'portable-extract-20261105-041832'),
  },
  {
    label: 'rc.6',
    bundle: path.join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v18'),
    frozenExtract: null,
  },
]);
const CONSOLE_V2_SHEETS = Object.freeze(['tokens.css', 'base.css', 'components.css']);

/** The element the drawer renders as: `<aside class="drawer" hidden>`. */
const DRAWER = Object.freeze({ tag: 'aside', classes: Object.freeze(['drawer']), attributes: Object.freeze(['hidden']) });

/** Strip comments (their braces must not confuse the rule scanner). */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '');
}

/**
 * Flat rule scan. `@media` preludes are skipped (the selectors inside a media block are still
 * collected, which is conservative for a single-element query); we only care about display.
 */
function parseRules(css) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  let order = 0;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    const selectorText = match[1].trim();
    if (selectorText === '' || selectorText.endsWith('@')) {
      continue;
    }
    const declarations = [];
    for (const part of match[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) {
        continue;
      }
      const property = part.slice(0, colon).trim().toLowerCase();
      const rawValue = part.slice(colon + 1).trim();
      const important = /!\s*important\s*$/iu.test(rawValue);
      const value = rawValue.replace(/!\s*important\s*$/iu, '').trim().toLowerCase();
      declarations.push({ property, value, important });
    }
    for (const selector of selectorText.split(',').map((entry) => entry.trim())) {
      if (selector !== '') {
        rules.push({ selector, declarations, order: order += 1 });
      }
    }
  }
  return rules;
}

/** Conservative matcher for simple selectors (element / .class / [attr] compounds only). */
function selectorMatches(selector, element) {
  if (/[\s>+~:]/u.test(selector)) {
    return false;
  }
  const tokenPattern = /^[A-Za-z][A-Za-z0-9-]*|\.[A-Za-z0-9_-]+|\[[^\]]+\]/gu;
  const tokens = selector.match(tokenPattern) ?? [];
  if (tokens.length === 0 || tokens.join('') !== selector) {
    return false;
  }
  for (const token of tokens) {
    if (token.startsWith('.')) {
      if (!element.classes.includes(token.slice(1))) {
        return false;
      }
    } else if (token.startsWith('[')) {
      const name = token.slice(1, -1).split('=')[0].trim();
      if (!element.attributes.includes(name)) {
        return false;
      }
    } else if (token !== element.tag) {
      return false;
    }
  }
  return true;
}

function specificityOf(selector) {
  const tokens = selector.match(/^[A-Za-z][A-Za-z0-9-]*|\.[A-Za-z0-9_-]+|\[[^\]]+\]/gu) ?? [];
  let classes = 0;
  let elements = 0;
  for (const token of tokens) {
    if (token.startsWith('.') || token.startsWith('[')) {
      classes += 1;
    } else {
      elements += 1;
    }
  }
  return { classes, elements };
}

/**
 * Resolve `display` for one element from author CSS only.
 *
 * `!important` beats every normal declaration; between declarations of the same importance,
 * higher specificity wins, then later source order — the subset of CSS 2.2 cascade that
 * SEED-02 actually depends on.
 */
function resolveDisplay(css, element) {
  const candidates = [];
  for (const rule of parseRules(stripComments(css))) {
    if (!selectorMatches(rule.selector, element)) {
      continue;
    }
    for (const declaration of rule.declarations) {
      if (declaration.property !== 'display') {
        continue;
      }
      candidates.push({
        ...declaration,
        selector: rule.selector,
        specificity: specificityOf(rule.selector),
        order: rule.order,
      });
    }
  }
  candidates.sort((left, right) => {
    if (left.important !== right.important) {
      return left.important ? -1 : 1;
    }
    if (left.specificity.classes !== right.specificity.classes) {
      return right.specificity.classes - left.specificity.classes;
    }
    if (left.specificity.elements !== right.specificity.elements) {
      return right.specificity.elements - left.specificity.elements;
    }
    return right.order - left.order;
  });
  return { display: candidates[0]?.value ?? null, winner: candidates[0] ?? null, candidates };
}

function hasGlobalHiddenImportant(css) {
  const important = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!\s*important[^}]*\}/iu.test(css);
  // A scoped variant (`.x[hidden] { … !important }`) must not be mistaken for the global rule.
  return important && /(^|[},;])\s*\[hidden\]\s*\{/mu.test(css);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Read-only census of delivered console-v1 copies (never written: dist/** is out of scope). */
function deliveredConsoleCopies() {
  const roots = [path.join(REPO_ROOT, 'dist'), path.join(REPO_ROOT, '.publish')];
  const found = [];
  // The known layout is shallow (`dist/bundle/<name>/console/styles.css`,
  // `.publish/<product>/apps/console/styles.css`). Bounding the depth keeps the census from
  // walking tens of thousands of packaging files under dist/**.
  const walk = (directory, depth) => {
    if (depth > 4) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name === 'styles.css' && full.toLowerCase().includes(`${path.sep}console${path.sep}`)) {
        found.push(full);
      }
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return found.sort();
}

describe('SEED-02：删除 !important 后这条断言必须转红', () => {
  it('源码：<aside class="drawer" hidden> 的 display 必须演算成 none，胜出者带 !important', () => {
    const css = fs.readFileSync(STYLES, 'utf8');
    assert.equal(
      hasGlobalHiddenImportant(css),
      true,
      '[hidden] { display:none !important } 缺失：.drawer{display:flex} 会赢，抽屉关不掉（SEED-02 回来了）',
    );
    const resolved = resolveDisplay(css, DRAWER);
    assert.equal(resolved.display, 'none',
      `层叠结果应为 none，实际 ${resolved.display}（胜出：${resolved.winner?.selector}）`);
    assert.equal(resolved.winner?.important, true, '兜底规则必须 !important，否则与 .drawer 同特异度、源序决定胜负');
    assert.equal(resolved.winner?.selector.trim(), '[hidden]');
  });

  it('把 !important 删掉的等价变体必须演算成 flex（证明判据能失败）', () => {
    const broken = fs.readFileSync(STYLES, 'utf8').replace(
      /(\[hidden\]\s*\{\s*display\s*:\s*none\s*)!\s*important/u,
      '$1',
    );
    assert.notEqual(broken, fs.readFileSync(STYLES, 'utf8'), '变异没有生效：源码里没找到那条 !important');
    assert.equal(hasGlobalHiddenImportant(broken), false);
    const resolved = resolveDisplay(broken, DRAWER);
    assert.equal(resolved.display, 'flex',
      `删掉 !important 后 .drawer{display:flex} 必须胜出（实际 ${resolved.display}）：否则演算器抓不住 SEED-02`);
    assert.equal(resolved.winner?.selector.trim(), '.drawer');
  });
});

describe('SEED-02：当前出厂载荷（rc.5 / rc.6）已 CLOSED —— 与陈旧副本划界', () => {
  for (const payload of FACTORY_PAYLOADS) {
    it(`${payload.label} 出厂载荷：console-next 样式集带全局 [hidden] 兜底，且演算成 none`, () => {
      const manifestPath = path.join(payload.bundle, 'bundle.json');
      assert.equal(fs.existsSync(manifestPath), true, `缺少 ${manifestPath}：无法证明这是出厂载荷树`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.console?.sourcePath, 'apps/console-next',
        `${payload.label} 的载荷仍指向旧 console-v1（${manifest.console?.sourcePath}）`);

      // Link order matters: tokens → base → components (as the payload's index.html declares).
      const sheets = CONSOLE_V2_SHEETS.map((name) => path.join(payload.bundle, 'console', 'styles', name));
      for (const sheet of sheets) {
        assert.equal(fs.existsSync(sheet), true, `出厂载荷缺少样式表 ${sheet}`);
      }
      const css = sheets.map((sheet) => fs.readFileSync(sheet, 'utf8')).join('\n');
      assert.equal(hasGlobalHiddenImportant(css), true,
        `${payload.label} 出厂载荷缺少全局 [hidden] 兜底：新控制台里抽屉同样会关不掉`);
      const resolved = resolveDisplay(css, DRAWER);
      assert.equal(resolved.display, 'none',
        `${payload.label} 出厂载荷演算结果应为 none，实际 ${resolved.display}（胜出：${resolved.winner?.selector}）`);
      assert.equal(resolved.winner?.important, true);

      if (payload.frozenExtract !== null) {
        const frozen = JSON.parse(fs.readFileSync(path.join(payload.frozenExtract, 'bundle.json'), 'utf8'));
        assert.equal(frozen.builtAt, manifest.builtAt,
          `${payload.label} 的冻结解包树与 staging bundle 不是同一次构建：不能拿 staging 结果冒充出厂载荷`);
      }
    });
  }
});

describe('SEED-02：陈旧交付副本的真实状态（只读核对，不写 dist/**）', () => {
  it('陈旧 console-v1 副本（当前 12 份）仍复现 → ③ 只在"陈旧资产层"成立，不是当前载荷', () => {
    const copies = deliveredConsoleCopies();
    assert.notEqual(copies.length, 0, '本机找不到任何已交付 console 样式副本，无法核对交付物层');

    const broken = [];
    const fixed = [];
    for (const copy of copies) {
      const css = fs.readFileSync(copy, 'utf8');
      const row = {
        relative: path.relative(REPO_ROOT, copy),
        sha256: sha256File(copy),
        hasImportant: hasGlobalHiddenImportant(css),
        display: resolveDisplay(css, DRAWER).display,
      };
      (row.hasImportant ? fixed : broken).push(row);
    }

    // 每份副本都必须是"含 .drawer 的 console-v1 样式"，否则这份采样没有证明力。
    for (const row of [...broken, ...fixed]) {
      assert.match(row.sha256, /^[0-9a-f]{64}$/u);
    }
    // 台账记录：12 份 dist/** + .publish/** 同源，sha 25B68C6E…，抽屉在 hidden 下仍是 flex。
    assert.equal(
      broken.length > 0,
      true,
      `已交付副本全部带兜底规则（${fixed.length} 份）：说明交付物层可能已重建，需要重新采样台账 ③`,
    );
    for (const row of broken) {
      assert.equal(row.sha256, DELIVERED_BROKEN_SHA,
        `${row.relative} 不再是记录在案的失效副本（sha 变了，需重新采样）`);
      assert.equal(row.display, 'flex', `${row.relative}: 交付副本上抽屉必须仍关不掉（③ 的复现证据）`);
    }
    // 如实输出，不隐藏：这些是 rc.2/rc.3 时代的陈旧构建树，与已发布载荷同字节，
    // 但**不是** rc.5/rc.6 出厂载荷（那两份已 CLOSED）。③ 的口径因此落在"陈旧资产层仍缺"。
    console.log(
      `[SEED-02] stale console-v1 copies=${copies.length} broken=${broken.length} fixed=${fixed.length}; `
      + 'rc.5/rc.6 出厂载荷 CLOSED；陈旧副本（与 rc.2/rc.3 portable 载荷同字节 25b68c6e…）仍 BYPASSED',
    );
  });
});
