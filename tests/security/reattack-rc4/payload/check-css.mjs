#!/usr/bin/env node
/**
 * REATTACK-RC4 / payload-v16 · check-css.mjs
 *
 * 抽检 1：[hidden] 兜底在发布载荷 v16 console（console-next 形态）里是否真实生效。
 *
 * 检材事实（不套旧路径）：
 *   dist/bundle/win32-x64-v16/console/ 没有 styles.css；
 *   真实样式为 styles/{tokens,base,components}.css + styles/demo.html 内联 <style>。
 *
 * 判据（三层）：
 *   CSS-01 存在性：至少一条“选择器含 [hidden] 且声明 display:none !important”的规则。
 *   CSS-02 层叠：对全部 display 声明做级联判定 —— 带 hidden 属性的元素会不会被其它规则显示出来。
 *           author !important 之后比特异度、再比源顺序；普通声明无法盖过 author !important。
 *           报告两类：
 *             HAZARD: 非 none 的 !important 声明，且选择器不含 [hidden]，特异度/顺序能压过兜底规则；
 *             SHADOW: 普通（非 important）display 声明 —— 记录但不判红（不可能盖过 !important）。
 *   CSS-03 内联：HTML 的 style="..." 属性与 <style> 块里的 display 声明，同样做级联判定。
 *   CSS-04 交付一致性：dist/release/0.0.1-rc.4 portable.zip 内 console/** 与 v16/console/**
 *           逐条目 sha256 比对（只读 zip，不解压覆盖）。
 *
 * 变异开关（--mutation，只在 %TEMP% 副本上动手，dist/** 只读）：
 *   M1  复制 console/ 到 %TEMP%\reattack-rc4-payload\mut\M1\，把 base.css 的
 *       `display: none !important` 去掉 !important → 期望 CSS-01 转红（退出码 1）。
 *   M1b 在 M1 副本上再追加 `.ui-drawer { display: flex !important; }` 到 components.css 末尾
 *       → 期望 CSS-02 出现 HAZARD 并判红。
 *
 * 用法：
 *   node tests/security/reattack-rc4/payload/check-css.mjs
 *   node tests/security/reattack-rc4/payload/check-css.mjs --mutation M1
 *   node tests/security/reattack-rc4/payload/check-css.mjs --bundle <dir> --zip <zip> --json <out.json>
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 参数/环境错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TEMP_ROOT = path.join(process.env.TEMP || process.env.TMP || '.', 'reattack-rc4-payload');

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { bundle: null, zip: null, json: null, mutation: 'none' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--zip') out.zip = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--mutation') out.mutation = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  out.bundle = path.resolve(out.bundle || path.join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v16'));
  out.zip = out.zip ? path.resolve(out.zip) : path.join(REPO_ROOT, 'dist', 'release', '0.0.1-rc.4', 'AIDrivenNetDefense-0.0.1-rc.4-win-x64-portable.zip');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir, filter) {
  const out = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (!filter || filter(p)) out.push(p);
    }
  })(dir);
  return out.sort();
}

// ---------------------------------------------------------------- CSS 解析
/**
 * 极简 CSS 解析：去掉注释、按顶层 `{...}` 切规则，保留源顺序。
 * 每个规则：{ selector, decls:[{prop,value,important,line}], line, file, order }
 */
function parseCss(text, file, startLine = 1, orderBase = 0) {
  const lines = text.split(/\r?\n/);
  const rules = [];
  let i = 0, order = orderBase;
  const n = text.length;
  let line = startLine;
  while (i < n) {
    // 跳空白 / 注释
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const consumed = text.slice(i, end < 0 ? n : end + 2);
      line += (consumed.match(/\n/g) || []).length;
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (/\s/.test(ch)) { if (ch === '\n') line++; i++; continue; }
    // 读 selector 直到 '{'（顶层），遇到 '@' 开头的 at-rule 视为一个“伪 selector”
    let j = i, depthP = 0;
    while (j < n && text[j] !== '{') { j++; }
    if (j >= n) break;
    const selectorRaw = text.slice(i, j).trim();
    // 找配对的 '}'
    let k = j + 1, depth = 1;
    while (k < n && depth > 0) { if (text[k] === '{') depth++; else if (text[k] === '}') depth--; k++; }
    const bodyStart = j + 1;
    const body = text.slice(bodyStart, k - 1);
    const startLine = line;
    line += (text.slice(i, k).match(/\n/g) || []).length;
    const selLine = startLine;
    if (selectorRaw.startsWith('@')) {
      // at-rule：media/supports 里可含普通规则；递归解析 body（行号偏移用近似值）
      const inner = parseCss(body, file, selLine, order + 1);
      for (const r of inner) { r.file = file; rules.push(r); order = Math.max(order, r.order) + 1; }
      i = k;
      continue;
    }
    const decls = [];
    // 逐声明（按 ';' 切，忽略嵌套括号里的 ';'）
    let d = 0, bufStart = 0, paren = 0;
    for (; d <= body.length; d++) {
      const c = body[d];
      if (c === '(') paren++;
      else if (c === ')') paren = Math.max(0, paren - 1);
      if ((c === ';' && paren === 0) || d === body.length) {
        const raw = body.slice(bufStart, d).trim();
        bufStart = d + 1;
        if (!raw) continue;
        const colon = raw.indexOf(':');
        if (colon < 0) continue;
        const prop = raw.slice(0, colon).trim().toLowerCase();
        let value = raw.slice(colon + 1).trim();
        const important = /!\s*important\s*$/i.test(value);
        if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
        // 声明在规则体里的行号（近似：规则起始行 + 前面换行数）
        const pre = body.slice(0, body.indexOf(raw));
        decls.push({ prop, value, important, line: selLine });
      }
    }
    rules.push({ selector: selectorRaw.replace(/\s+/g, ' '), decls, line: selLine, file, order: order++ });
    i = k;
  }
  return rules;
}

/** CSS 特异度（a,b,c） */
function specificity(selector) {
  let s = selector;
  // 去掉 :not(...) 内的内容先简单计算（保守：保留参数内容参与计数）
  let a = 0, b = 0, c = 0;
  const ids = s.match(/#[\w-]+/g); if (ids) a += ids.length;
  // 属性、类、伪类
  const attrs = s.match(/\[[^\]]*\]/g); if (attrs) b += attrs.length;
  const classes = s.match(/\.[\w-]+/g); if (classes) b += classes.length;
  const pseudoClasses = s.match(/:(?!:)[\w-]+/g); if (pseudoClasses) b += pseudoClasses.length;
  const pseudoEls = s.match(/::[\w-]+/g); if (pseudoEls) c += pseudoEls.length;
  // 类型选择器：去掉属性/类/伪/组合符之后剩下的以字母开头的 token
  let rest = s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+/g, ' ')
    .replace(/::[\w-]+/g, ' ')
    .replace(/:(?!:)[\w-]+(\([^)]*\))?/g, ' ');
  const types = rest.match(/(^|[\s>+~,(])([a-zA-Z][\w-]*)/g) || [];
  c += types.length;
  return [a, b, c];
}
const SPEC_CMP = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

/** 把 (a,b,c) 用于比较：>0 表示 x 大于 y */
function specGreater(x, y) { return SPEC_CMP(x, y) > 0; }
function specEqual(x, y) { return SPEC_CMP(x, y) === 0; }

// ---------------------------------------------------------------- zip 读取（标准库 zlib，只读）
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  // 找 EOCD
  let eocd = -1;
  const minEocd = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  let cdCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdSize = buf.readUInt32LE(eocd + 12);
  if (cdOffset === 0xffffffff || cdCount === 0xffff) {
    // zip64
    const loc = eocd - 20;
    if (buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(z64) === 0x06064b50) {
        cdCount = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
        cdSize = Number(buf.readBigUInt64LE(z64 + 40));
      }
    }
  }
  const entries = [];
  let p = cdOffset;
  for (let idx = 0; idx < cdCount; idx++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central dir at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800) ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
    entries.push({ name, flags, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function readZipEntryData(buf, e) {
  const p = e.localOff;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`bad local header for ${e.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 0) return comp;
  if (e.method === 8) return zlib.inflateRawSync(comp);
  throw new Error(`unsupported zip method ${e.method} for ${e.name}`);
}

// ---------------------------------------------------------------- 规则收集
function collectRules(bundleRoot) {
  const consoleRoot = path.join(bundleRoot, 'console');
  const cssFiles = walk(consoleRoot, (p) => p.toLowerCase().endsWith('.css'));
  const htmlFiles = walk(consoleRoot, (p) => /\.html?$/i.test(p));

  // 加载顺序：以 index.html 的 <link rel="stylesheet"> 出现顺序为准；未列出的 CSS 排在后面
  const indexHtml = path.join(consoleRoot, 'index.html');
  const order = [];
  if (fs.existsSync(indexHtml)) {
    const html = fs.readFileSync(indexHtml, 'utf8');
    const re = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      const p = path.resolve(consoleRoot, m[1]);
      if (!order.includes(p)) order.push(p);
    }
  }
  for (const f of cssFiles) if (!order.includes(f)) order.push(f);

  const rules = [];
  let orderBase = 0;
  for (const f of order) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const parsed = parseCss(text, path.relative(bundleRoot, f).replace(/\\/g, '/'), 1, orderBase);
    orderBase += parsed.length + 10;
    rules.push(...parsed);
  }

  // HTML 内联 <style> 块（如 demo.html）：视为作者样式表，排在各 link 之后（demo.html 自身不存在 link）
  const inlineStyleRules = [];
  for (const f of htmlFiles) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(bundleRoot, f).replace(/\\/g, '/');
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index);
      const line = (before.match(/\n/g) || []).length + 1;
      const body = m[1];
      const parsed = parseCss(body, rel, line, orderBase);
      inlineStyleRules.push(...parsed);
      orderBase += parsed.length + 10;
    }
  }
  return { cssFiles, htmlFiles, order, rules, inlineStyleRules };
}

// ---------------------------------------------------------------- 检查
const results = [];
function record(id, check, status, detail) {
  results.push({ id, check, status, detail });
  const tag = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'INFO';
  console.log(`[${tag}] ${id} · ${check}${detail ? ' · ' + detail : ''}`);
}

function runCssChecks(bundleRoot) {
  const consoleRoot = path.join(bundleRoot, 'console');
  if (!fs.existsSync(consoleRoot)) {
    record('CSS-00', 'console 目录存在', 'FAIL', `${consoleRoot} 不存在`);
    return;
  }
  const { cssFiles, htmlFiles, order, rules, inlineStyleRules } = collectRules(bundleRoot);

  // 检材事实：不存在 styles.css
  const styleDotCss = path.join(consoleRoot, 'styles.css');
  record('CSS-00', '检材形态（console-next：无 styles.css）',
    !fs.existsSync(styleDotCss) ? 'PASS' : 'INFO',
    `styles.css ${fs.existsSync(styleDotCss) ? '存在（与任务描述不符）' : '不存在（符合 console-next 形态）'}；CSS 文件=${cssFiles.length}；加载顺序=${order.map((f) => path.relative(bundleRoot, f).replace(/\\/g, '/')).join(' → ')}`);

  // 加载顺序中的“产品样式表”（index.html 显式 link 的 CSS；demo.html 是独立演示页，单列）
  const productCssSet = new Set(order);
  const isDemoCss = (p) => /[\\/]demo\.html$/i.test(p);
  const productRules = rules.filter((r) => productCssSet.has(path.resolve(bundleRoot, r.file)) || !isDemoCss(r.file));
  const productCssFiles = [...productCssSet];

  // 拆选择器列表，判断是否“通用 [hidden] 规则”（选择器列表中有一项恰为 [hidden]）
  const selectorList = (sel) => sel.split(',').map((s) => s.trim()).filter(Boolean);
  const isUniversalHidden = (sel) => selectorList(sel).some((s) => s === '[hidden]');
  const isDispNoneImportant = (r) => r.decls.some((d) => d.prop === 'display' && d.value.toLowerCase() === 'none' && d.important);
  const ruleText = (r) => r.decls.map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`).join('; ');

  // CSS-01 [hidden] 兜底存在性（产品样式表；通用选择器 + !important）
  const universalHiddenRules = [];
  const hiddenQualifiedRules = [];
  for (const r of productRules) {
    if (!/\[hidden\]/.test(r.selector)) continue;
    const fileAbs = path.resolve(bundleRoot, r.file);
    const sha = fs.existsSync(fileAbs) ? sha256(fs.readFileSync(fileAbs)) : null;
    const bytes = fs.existsSync(fileAbs) ? fs.statSync(fileAbs).size : null;
    const rec = { file: r.file, line: r.line, selector: r.selector, decl: ruleText(r), sha256: sha, bytes, order: r.order, important: isDispNoneImportant(r) };
    if (isUniversalHidden(r.selector)) universalHiddenRules.push(rec);
    else hiddenQualifiedRules.push(rec);
  }
  const universalImportant = universalHiddenRules.filter((r) => r.important);
  if (universalImportant.length === 0) {
    record('CSS-01', '通用选择器 [hidden]{display:none !important} 存在', 'FAIL',
      `产品 CSS 中通用 [hidden] !important 规则=${universalImportant.length}；通用规则=${universalHiddenRules.length}；限定规则=${hiddenQualifiedRules.length}`);
  } else {
    for (const r of universalImportant) {
      console.log(`[INFO]   ${r.file}:${r.line} 选择器="${r.selector}" 声明="{ ${r.decl} }" sha256=${r.sha256} bytes=${r.bytes}`);
    }
    record('CSS-01', '通用选择器 [hidden]{display:none !important} 存在', 'PASS',
      `${universalImportant.length} 条通用兜底（另有限定规则 ${hiddenQualifiedRules.length} 条）；取证 ${universalImportant[0].file}:${universalImportant[0].line} sha256=${universalImportant[0].sha256} bytes=${universalImportant[0].bytes}`);
  }

  // CSS-02 的“最弱可胜基准”：通用 [hidden] 规则里特异度最低者；记录其是否 important 与源顺序
  let baseSpec = [1, 0, 0], baseOrder = Number.MAX_SAFE_INTEGER, baseImportant = false;
  for (const r of productRules) {
    if (!isUniversalHidden(r.selector)) continue;
    if (!r.decls.some((d) => d.prop === 'display' && d.value.toLowerCase() === 'none')) continue;
    const sp = specificity('[hidden]');
    if (SPEC_CMP(sp, baseSpec) <= 0) { baseSpec = sp; baseOrder = Math.min(baseOrder, r.order); baseImportant = isDispNoneImportant(r); }
  }
  if (!baseImportant) {
    // 通用兜底不带 !important：任何后置/更高特异度的普通 display 声明都能盖掉它
    baseImportant = false;
  }

  // CSS-02 全部 display 规则层叠判定（产品样式表 + 所有 HTML 的 <style> 块）
  const allDisplay = [];
  const scanDisplayRules = (list, sourceKind) => {
    for (const r of list) {
      for (const d of r.decls) {
        if (d.prop !== 'display') continue;
        const val = d.value.toLowerCase();
        const hide = val === 'none';
        const hasHiddenQual = /\[hidden\]/.test(r.selector);
        const sp = specificity(r.selector === '[hidden]' ? '[hidden]' : r.selector);
        let hazard = false;
        if (!hide && !hasHiddenQual) {
          if (baseImportant) {
            // 兜底是 author !important：只有同级或更强的 !important 才可能压过
            hazard = d.important && (specGreater(sp, baseSpec) || (specEqual(sp, baseSpec) && r.order > baseOrder));
          } else {
            // 兜底只是普通声明：任何普通声明按特异度/顺序即可覆盖
            hazard = specGreater(sp, baseSpec) || (specEqual(sp, baseSpec) && r.order > baseOrder);
          }
        }
        allDisplay.push({ kind: sourceKind, file: r.file, line: d.line, selector: r.selector, value: d.value, important: d.important, hide, hasHiddenQual, hazard, shadow: !hide && !d.important && !hasHiddenQual });
      }
    }
  };
  scanDisplayRules(productRules, 'product-css');
  scanDisplayRules(inlineStyleRules, 'style-block');

  const hazards = allDisplay.filter((d) => d.hazard);
  const withHiddenQualified = allDisplay.filter((d) => d.hasHiddenQual);
  const shadows = allDisplay.filter((d) => d.shadow);
  const nonHideImportant = allDisplay.filter((d) => d.important && !d.hide);

  console.log(`[INFO]   CSS-02 基准：通用 [hidden] 选择器特异度=${JSON.stringify(baseSpec)} order=${baseOrder} !important=${baseImportant}`);
  console.log(`[INFO]   CSS-02 统计：display 声明=${allDisplay.length}（产品CSS=${allDisplay.filter((d) => d.kind === 'product-css').length}，style块=${allDisplay.filter((d) => d.kind === 'style-block').length}）；含[hidden]限定=${withHiddenQualified.length}；非none且!important=${nonHideImportant.length}；普通非隐藏声明=${shadows.length}`);
  for (const d of withHiddenQualified) {
    console.log(`[INFO]   [hidden] 限定: ${d.file}:${d.line} ${d.selector} { display:${d.value}${d.important ? ' !important' : ''} }`);
  }
  for (const d of hazards) {
    console.log(`[HAZARD] ${d.file}:${d.line} ${d.selector} { display:${d.value}${d.important ? ' !important' : ''} } 可压过 [hidden] 兜底`);
  }
  if (hazards.length > 0) {
    record('CSS-02', '带 [hidden] 的元素不可被其它规则显示化', 'FAIL',
      `${hazards.length} 条 HAZARD（兜底 !important=${baseImportant}）：` + hazards.slice(0, 12).map((d) => `${d.file}:${d.line} ${d.selector}{display:${d.value}${d.important ? '!important' : ''}}`).join(' | '));
  } else if (baseImportant && nonHideImportant.length === 0) {
    record('CSS-02', '带 [hidden] 的元素不可被其它规则显示化', 'PASS',
      `无任何“非 none 且 !important”的 display 声明（${allDisplay.length} 条 display 声明）；${shadows.length} 条普通非隐藏声明在层叠上被 author !important 压住；含 [hidden] 限定的 ${withHiddenQualified.length} 条均为隐藏或同向`);
  } else {
    record('CSS-02', '带 [hidden] 的元素不可被其它规则显示化', 'PASS',
      `${shadows.length} 条普通非隐藏声明不能覆盖 !important 兜底；${nonHideImportant.length} 条非 none 的 !important 声明特异度/顺序均不足（基准 ${JSON.stringify(baseSpec)}@${baseOrder}）`);
  }

  // CSS-05 demo.html 内联样式：独立演示页自己的 [hidden] 兜底与层叠
  const demoRules = inlineStyleRules.filter((r) => /[\\/]demo\.html$/i.test(r.file));
  const demoUniversal = demoRules.filter((r) => isUniversalHidden(r.selector));
  const demoUniversalImp = demoUniversal.filter((r) => isDispNoneImportant(r));
  const demoHazards = [];
  for (const r of demoRules) {
    for (const d of r.decls) {
      if (d.prop !== 'display') continue;
      const val = d.value.toLowerCase();
      if (val === 'none' || /\[hidden\]/.test(r.selector)) continue;
      const sp = specificity(r.selector);
      if (demoUniversalImp.length > 0) {
        if (d.important && (specGreater(sp, [0, 1, 0]) || (specEqual(sp, [0, 1, 0])))) demoHazards.push({ ...d, selector: r.selector });
      } else {
        demoHazards.push({ ...d, selector: r.selector });
      }
    }
  }
  for (const r of demoUniversal) {
    console.log(`[INFO]   demo.html 内联: ${r.file}:${r.line} 选择器="${r.selector}" 声明="{ ${ruleText(r)} }" !important=${isDispNoneImportant(r)}`);
  }
  record('CSS-05', 'demo.html 内联 [hidden] 兜底', demoUniversalImp.length > 0 ? 'PASS' : 'FAIL',
    `demo.html <style> 通用 [hidden] 规则=${demoUniversal.length}，其中 !important=${demoUniversalImp.length}；层叠 HAZARD=${demoHazards.length}`);

  // CSS-03 内联 style="" 属性
  const inlineAttr = [];
  for (const f of htmlFiles) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(bundleRoot, f).replace(/\\/g, '/');
    const re = /style\s*=\s*(["\'])([\s\S]*?)\1/gi;
    let m;
    while ((m = re.exec(text))) {
      const css = m[2];
      if (!/display\s*:/i.test(css)) continue;
      const before = text.slice(0, m.index);
      const line = (before.match(/\n/g) || []).length + 1;
      const important = /display\s*:[^;]*!\s*important/i.test(css);
      const value = (css.match(/display\s*:\s*([^;]+)/i) || [])[1] || '';
      inlineAttr.push({ file: rel, line, css: css.replace(/\s+/g, ' ').trim(), important, value: value.trim() });
    }
  }
  const inlineHazards = inlineAttr.filter((a) => a.important && !/^none/i.test(a.value));
  for (const a of inlineAttr) {
    console.log(`[INFO]   inline style: ${a.file}:${a.line} style="${a.css}"${a.important ? ' (important)' : ''}`);
  }
  record('CSS-03', 'HTML 内联 style 不覆盖 [hidden]', inlineHazards.length === 0 ? 'PASS' : 'FAIL',
    `内联 display 属性=${inlineAttr.length}；其中 !important 且非 none=${inlineHazards.length}`);

  return { cssFiles, order, universalHiddenRules, hiddenQualifiedRules, allDisplay, hazards, shadows, inlineAttr, demoRules: { count: demoRules.length, universal: demoUniversal, universalImportant: demoUniversalImp, hazards: demoHazards } };
}

// CSS-04 zip 一致性
function runZipCheck(bundleRoot, zipPath) {
  if (!fs.existsSync(zipPath)) {
    record('CSS-04', 'portable.zip console 一致性', 'FAIL', `zip 不存在：${zipPath}`);
    return null;
  }
  const { buf, entries } = readZipEntries(zipPath);
  const consoleEntries = entries.filter((e) => e.name.startsWith('console/') && !e.name.endsWith('/'));
  const bundleConsole = path.join(bundleRoot, 'console');
  const diskFiles = walk(bundleConsole).map((p) => path.relative(bundleRoot, p).replace(/\\/g, '/'));
  const zipNames = new Set(consoleEntries.map((e) => e.name));
  const missingInZip = diskFiles.filter((n) => !zipNames.has(n));
  const extraInZip = [...zipNames].filter((n) => !diskFiles.includes(n));
  let mismatch = 0, matched = 0;
  const rows = [];
  for (const e of consoleEntries) {
    const diskPath = path.join(bundleRoot, e.name.split('/').join(path.sep));
    const data = readZipEntryData(buf, e);
    const zipHash = sha256(data);
    if (!fs.existsSync(diskPath)) { rows.push({ name: e.name, status: 'missing-on-disk', zipHash }); continue; }
    const diskHash = sha256(fs.readFileSync(diskPath));
    if (diskHash === zipHash) { matched++; rows.push({ name: e.name, status: 'match', sha256: zipHash }); }
    else { mismatch++; rows.push({ name: e.name, status: 'MISMATCH', zipHash, diskHash }); }
  }
  const zipSha = sha256(buf);
  record('CSS-04', 'portable.zip console 一致性',
    mismatch === 0 && missingInZip.length === 0 && extraInZip.length === 0 ? 'PASS' : 'FAIL',
    `zip=${path.basename(zipPath)} bytes=${buf.length} sha256=${zipSha}；console 条目=${consoleEntries.length}；磁盘 console 文件=${diskFiles.length}；sha256 一致=${matched}；mismatch=${mismatch}；zip缺=${missingInZip.length}；zip多=${extraInZip.length}`);
  for (const m of missingInZip) console.log(`[INFO]   zip 缺少：${m}`);
  for (const m of extraInZip) console.log(`[INFO]   zip 多出：${m}`);
  for (const r of rows.filter((x) => x.status === 'MISMATCH')) console.log(`[INFO]   MISMATCH ${r.name} zip=${r.zipHash} disk=${r.diskHash}`);
  return { zipPath, zipSha, zipBytes: buf.length, consoleEntries: consoleEntries.length, diskFiles: diskFiles.length, matched, mismatch, missingInZip, extraInZip, rows };
}

// ---------------------------------------------------------------- 变异
function prepareMutation(kind) {
  const mutRoot = path.join(TEMP_ROOT, 'mut', kind);
  fs.rmSync(mutRoot, { recursive: true, force: true });
  fs.mkdirSync(mutRoot, { recursive: true });
  fs.cpSync(path.join(args.bundle, 'console'), path.join(mutRoot, 'console'), { recursive: true });
  const rec = { kind, mutRoot, actions: [] };
  if (kind === 'M1' || kind === 'M1b') {
    const baseCss = path.join(mutRoot, 'console', 'styles', 'base.css');
    const before = fs.readFileSync(baseCss, 'utf8');
    const after = before.replace('[hidden] {\n  display: none !important;\n}', '[hidden] {\n  display: none;\n}');
    if (after === before) {
      // 兜底：直接去掉文件中第一处 display: none !important
      fs.writeFileSync(baseCss, before.replace(/display\s*:\s*none\s*!\s*important/i, 'display: none'));
      rec.actions.push('removed !important from base.css (fallback regex)');
    } else {
      fs.writeFileSync(baseCss, after);
      rec.actions.push('base.css [hidden] display:none !important -> display:none');
    }
    rec.baseShaBefore = sha256(before);
    rec.baseShaAfter = sha256(fs.readFileSync(baseCss));
    if (kind === 'M1b') {
      const comp = path.join(mutRoot, 'console', 'styles', 'components.css');
      const prev = fs.readFileSync(comp, 'utf8');
      fs.writeFileSync(comp, prev + '\n/* mutation M1b: 后置高特异度 !important 显示规则 */\n.ui-drawer { display: flex !important; }\n');
      rec.actions.push('appended .ui-drawer { display: flex !important; } to components.css');
      rec.compShaBefore = sha256(prev);
      rec.compShaAfter = sha256(fs.readFileSync(comp));
    }
  }
  return rec;
}

// ---------------------------------------------------------------- main
console.log('='.repeat(78));
console.log('REATTACK-RC4 payload-v16 · check-css.mjs');
console.log(`bundle = ${args.bundle}`);
console.log(`zip    = ${args.zip}`);
console.log(`mutation = ${args.mutation}`);
console.log(`time   = ${new Date().toISOString()}`);
console.log('='.repeat(78));

let checkRoot = args.bundle;
let mutationInfo = null;
if (args.mutation !== 'none') {
  if (!['M1', 'M1b'].includes(args.mutation)) { console.error(`未知 mutation: ${args.mutation}`); process.exit(2); }
  mutationInfo = prepareMutation(args.mutation);
  console.log(`[MUTATION ${args.mutation}] ${JSON.stringify(mutationInfo)}`);
  checkRoot = mutationInfo.mutRoot;
}

const cssInfo = runCssChecks(checkRoot);
const zipInfo = args.mutation === 'none' ? runZipCheck(args.bundle, args.zip) : null;

const fails = results.filter((r) => r.status === 'FAIL');
console.log('-'.repeat(78));
console.log(`SUMMARY: PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${fails.length} INFO=${results.filter((r) => r.status === 'INFO').length}`);
// 变异模式的期望：M1 期望 CSS-01 FAIL；M1b 期望 CSS-01 FAIL 或 CSS-02 FAIL
let mutationVerdict = null;
if (args.mutation !== 'none') {
  const gotRed = fails.length > 0;
  mutationVerdict = gotRed ? 'MUTATION_DETECTED (检查器转红 → 判据有效)' : 'MUTATION_NOT_DETECTED (检查器未转红 → 判据无效)';
  console.log(`MUTATION VERDICT: ${args.mutation} -> ${mutationVerdict}`);
}

const payload = {
  tool: 'check-css.mjs',
  version: '1.0',
  generatedAt: new Date().toISOString(),
  bundle: args.bundle,
  checkRoot,
  zip: args.zip,
  mutation: args.mutation,
  mutationInfo,
  mutationVerdict,
  cssFiles: cssInfo ? cssInfo.cssFiles.map((p) => path.relative(checkRoot, p).replace(/\\/g, '/')) : [],
  loadOrder: cssInfo ? cssInfo.order.map((p) => path.relative(checkRoot, p).replace(/\\/g, '/')) : [],
  hiddenRules: cssInfo ? { universal: cssInfo.universalHiddenRules, qualified: cssInfo.hiddenQualifiedRules } : null,
  demoInline: cssInfo ? cssInfo.demoRules : null,
  displayDecls: cssInfo ? cssInfo.allDisplay : [],
  hazards: cssInfo ? cssInfo.hazards : [],
  inlineAttr: cssInfo ? cssInfo.inlineAttr : [],
  zip: zipInfo,
  results,
  exitCode: fails.length === 0 ? 0 : 1,
};
if (args.json) {
  fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
  fs.writeFileSync(path.resolve(args.json), JSON.stringify(payload, null, 2));
  console.log(`JSON -> ${path.resolve(args.json)}`);
}
process.exit(payload.exitCode);
