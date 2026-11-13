#!/usr/bin/env node
/**
 * tests/console-next/i18n/extract-keys.mjs — i18n key 静态抽取器（INT-2 / i18n 席）
 *
 * 目的：把 `apps/console-next` 里**实际会被请求的** i18n key 全部找出来，作为
 * `apps/console-next/i18n/locales/*.json` 的唯一权威来源。抽取不是"猜"：
 * 每个 key 都带来源文件 + 行号，动态 key 必须登记取值域（DOMAIN）。
 *
 * 抽取四类来源：
 *   1. `js/**` 里 `t('k')` / `env.t('k')` / `i18n.t('k')` 的**字面量**第一参数；
 *   2. `js/**` 里**动态**第一参数（`t('settings.action.' + kind)`、`` t(`app.conn.${s}`) ``）
 *      —— 打印出来供人工登记取值域（DOMAIN_TABLE），不做字符串猜测；
 *   3. `index.html` 的 `data-i18n` / `data-i18n-aria` / `data-i18n-title`；
 *   4. `FALLBACK`/`KEY_*` 字样表里的 key（settings/views 的内置英文兜底，必须被 locale 覆盖，
 *      否则中文模式会露出英文）；
 *   5. 运行期 schema（daemon `GET /api/v1/settings/schema` 的 labelKey/hintKey）——这些 key
 *      不在前端源码里，是服务端下发的，必须实测枚举，否则设置页必然 [missing:]。
 *
 * 用法：
 *   node tests/console-next/i18n/extract-keys.mjs               # 打印摘要 + 写 evidence JSON
 *   node tests/console-next/i18n/extract-keys.mjs --json        # 只输出机器可读 JSON
 *   node tests/console-next/i18n/extract-keys.mjs --no-runtime  # 不连 daemon/schema（离线）
 *   node tests/console-next/i18n/extract-keys.mjs --verbose     # 打印每个 key 的来源行
 *
 * 退出码：0 抽取成功（不代表覆盖完整）；2 用法错误；3 抽取器自身异常。
 *
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'console-next');
export const JS_ROOT = path.join(CONSOLE_ROOT, 'js');
export const INDEX_HTML = path.join(CONSOLE_ROOT, 'index.html');
export const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'implementation', 'evidence', 'ui2', 'i18n');

/** 合同 §8.3 的 key 语法（唯一例外 errors.<UPPER_SNAKE>）。 */
export const KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;
export const ERROR_CODE_PATTERN = /^errors\.[A-Z][A-Z0-9_]*$/u;

/** 合法命名空间（合同 §8.3）。不在其中的字面量一律视为抽取噪音。 */
export const NAMESPACES = Object.freeze([
  'a11y',
  'about',
  'agent',
  'alerts',
  'analysis',
  'app',
  'common',
  'errors',
  'models',
  'nav',
  'overview',
  'settings',
  'severity',
  'status',
  'time',
  'units',
]);

export function isValidKey(key) {
  return KEY_PATTERN.test(key) || ERROR_CODE_PATTERN.test(key);
}

function namespaceOf(key) {
  const head = key.split('.')[0];
  return NAMESPACES.includes(head) ? head : null;
}

/* ==========================================================================
   词法扫描：标记"代码位"，收集字符串/模板字面量
   ========================================================================== */

/**
 * 扫描源码，返回 `{ codeMask, literals }`。
 * codeMask[i] === 1 表示第 i 个字符处于代码位置（不是注释/字符串内容）。
 * literals 里的每个元素记录 kind/start/end/line/value。
 *
 * @param {string} src
 */
export function tokenize(src) {
  const n = src.length;
  const codeMask = new Uint8Array(n);
  const literals = [];
  let line = 1;
  const lineAt = (index) => {
    let current = 1;
    for (let i = 0; i < index && i < n; i += 1) if (src[i] === '\n') current += 1;
    return current;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let value = '';
      while (j < n) {
        const d = src[j];
        if (d === '\\') {
          value += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (d === quote || d === '\n') break;
        value += d;
        j += 1;
      }
      literals.push({ kind: 'string', start: i, end: j + 1, value, line: lineAt(i) });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '$' && src[j + 1] === '{') {
          depth += 1;
          j += 2;
          continue;
        }
        if (d === '}' && depth > 0) {
          depth -= 1;
          j += 1;
          continue;
        }
        if (d === '`' && depth === 0) break;
        j += 1;
      }
      const raw = src.slice(i + 1, j);
      literals.push({ kind: 'template', start: i, end: j + 1, value: raw, line: lineAt(i) });
      i = j + 1;
      continue;
    }
    codeMask[i] = 1;
    i += 1;
  }
  void line;
  return { codeMask, literals };
}

/** 递归列出目录下的 .js 文件（确定性顺序）。 */
export function listJsFiles(dir = JS_ROOT) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * 从 `openParen` 位置（必须是 '('）开始，找到配对的 ')'，返回其下标。
 * 字符串/模板/注释内的括号不计。
 */
function findCloseParen(src, mask, literals, openParen) {
  let depth = 0;
  let i = openParen;
  const n = src.length;
  const literalStarts = new Map();
  for (const literal of literals) literalStarts.set(literal.start, literal);
  while (i < n) {
    const literal = literalStarts.get(i);
    if (literal) {
      i = literal.end;
      continue;
    }
    if (mask[i] === 1) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    i += 1;
  }
  return -1;
}

/** 按顶层逗号切参数（括号/字符串内的逗号不切）。 */
function splitTopLevelArgs(src, mask, literals, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  let i = from;
  const literalStarts = new Map();
  for (const literal of literals) literalStarts.set(literal.start, literal);
  while (i < to) {
    const literal = literalStarts.get(i);
    if (literal) {
      i = Math.min(literal.end, to);
      continue;
    }
    if (mask[i] === 1) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (c === ',' && depth === 0) {
        parts.push(src.slice(start, i).trim());
        start = i + 1;
      }
    }
    i += 1;
  }
  const tail = src.slice(start, to).trim();
  if (tail !== '') parts.push(tail);
  return parts;
}

/**
 * 找 `t(` / `.t(` / `env.t(` 调用点（排除 function/方法定义），返回
 * `{ line, firstArg, args, dynamic }`。
 */
export function findTLocalCalls(file, src) {
  const { codeMask, literals } = tokenize(src);
  const literalStarts = new Map(literals.map((literal) => [literal.start, literal]));
  const calls = [];
  const n = src.length;
  let line = 1;
  let lineIndex = 0;
  for (let i = 0; i < n; i += 1) {
    if (src[i] === '\n') {
      line += 1;
      lineIndex = i + 1;
    }
    if (src[i] !== 't') continue;
    if (codeMask[i] !== 1) continue;
    if (src[i + 1] !== '(') continue;
    const prev = i === 0 ? '' : src[i - 1];
    if (/[\w$]/u.test(prev)) continue; // 排除 at( / st( / ut( 等
    // 排除 `function t(` / `async function t(`
    const before = src.slice(Math.max(0, i - 40), i);
    if (/function\s+$/u.test(before)) continue;
    // 排除方法简写定义：`t(key, vars) {`
    const close = findCloseParen(src, codeMask, literals, i + 1);
    if (close === -1) continue;
    let after = close + 1;
    while (after < n && /\s/u.test(src[after])) after += 1;
    if (src[after] === '{') continue; // 方法定义体，不是调用
    if (src[after] === '=' && src[after + 1] === '>') continue; // 不应出现（t() 后不会跟箭头）
    const args = splitTopLevelArgs(src, codeMask, literals, i + 2, close);
    const firstArg = args[0] ?? '';
    const column = i - lineIndex + 1;
    calls.push({ file: path.relative(REPO_ROOT, file), line, column, firstArg, args });
  }
  // 记录字面量用于"FALLBACK 表里的 key"
  return { calls, literals, codeMask };
}

/**
 * 从 t(key[, fallback], vars) 的参数里取占位符名。
 *
 * 两种调用形状都要支持：
 *   - i18n.js / 视图：`t('k', { count: n })`        → 第二参数是 vars
 *   - settings/shared.js：`t('k', 'fallback', {count})` → 第三参数才是 vars
 *
 * 返回排序后的占位符名数组；找不到对象字面量返回 null（动态，需人工登记）。
 */
export function placeholdersFromArgs(args) {
  const list = args && args.length > 0 ? args.slice(1) : [];
  const objectArg = list.find((arg) => String(arg).trim().startsWith('{'));
  if (!objectArg) return [];
  const text = String(objectArg).trim();
  const names = [];
  const pattern = /(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names.sort();
}

/** 分析第一参数：字面量 / 模板 / 拼接 / 未知。 */
export function classifyFirstArg(firstArg) {
  const text = String(firstArg ?? '').trim();
  if (text === '') return { kind: 'empty', value: '' };
  const quoted = /^(['"])((?:\\.|(?!\1).)*)\1$/u.exec(text);
  if (quoted) return { kind: 'literal', value: quoted[2] };
  const templateOnly = /^`([^`$]*)`$/u.exec(text);
  if (templateOnly) return { kind: 'literal', value: templateOnly[1] };
  const concat = /^(['"])([^'"]*)\1\s*\+/u.exec(text);
  if (concat) return { kind: 'concat', prefix: concat[2], expr: text.slice(concat[0].length).trim() };
  const template = /^`([^`]*)`$/u.exec(text);
  if (template && template[1].includes('${')) {
    const prefix = template[1].split('${')[0];
    return { kind: 'template', prefix, expr: text };
  }
  const templateTail = /^`([^`]*)\$\{/u.exec(text);
  if (templateTail) return { kind: 'template', prefix: templateTail[1], expr: text };
  return { kind: 'unknown', expr: text };
}

/**
 * 从字面量池里找 `t('k'` 之后紧跟的字面量 key（已在 findTLocalCalls 里覆盖），
 * 另外把「FALLBACK 表 / KEY_* 表」里的 key 也收进来：
 * 这些 key 有内置英文兜底，是最容易"看起来没坏、其实没翻译"的一类。
 */
export function findTableKeys(file, src) {
  const { literals } = tokenize(src);
  const out = [];
  for (const literal of literals) {
    if (literal.kind !== 'string') continue;
    const value = literal.value;
    if (!isValidKey(value)) continue;
    if (namespaceOf(value) === null) continue;
    out.push({ file: path.relative(REPO_ROOT, file), line: literal.line, key: value });
  }
  return out;
}

/**
 * 收集"英文原文线索"：这些 key 在源码里已经有英文文本，locale 文件应当沿用/审校，
 * **不要凭 key 名猜**。三类来源：
 *   1. i18n.js 的 BUILTIN_EN（内置 en 安全网）；
 *   2. settings/shared.js 的 FALLBACK 表（设置页骨架文案）；
 *   3. 调用点自带的第二参数英文兜底 `t('key', 'English text')`。
 *
 * @returns {Map<string, {text: string, source: string}>}
 */
export function collectEnglishHints() {
  const hints = new Map();
  // 1. BUILTIN_EN
  const i18nFile = path.join(JS_ROOT, 'i18n.js');
  const i18nSrc = fs.readFileSync(i18nFile, 'utf8');
  const builtinStart = i18nSrc.indexOf('export const BUILTIN_EN');
  if (builtinStart !== -1) {
    const open = i18nSrc.indexOf('{', builtinStart);
    const close = i18nSrc.indexOf('\n});', open);
    const body = i18nSrc.slice(open, close === -1 ? i18nSrc.length : close);
    const { literals } = tokenize(body);
    const list = literals.filter((literal) => literal.kind === 'string');
    for (let index = 0; index + 1 < list.length; index += 2) {
      const key = list[index].value;
      const value = list[index + 1].value;
      if (!hints.has(key)) hints.set(key, { text: value, source: 'i18n.js BUILTIN_EN' });
    }
  }
  // 2. FALLBACK 表
  const sharedFile = path.join(JS_ROOT, 'views', 'settings', 'shared.js');
  if (fs.existsSync(sharedFile)) {
    const src = fs.readFileSync(sharedFile, 'utf8');
    const start = src.indexOf('export const FALLBACK');
    if (start !== -1) {
      const open = src.indexOf('{', start);
      const close = src.indexOf('\n});', open);
      const body = src.slice(open, close === -1 ? src.length : close);
      const { literals } = tokenize(body);
      const list = literals.filter((literal) => literal.kind === 'string');
      for (let index = 0; index + 1 < list.length; index += 2) {
        const key = list[index].value;
        const value = list[index + 1].value;
        if (!hints.has(key)) hints.set(key, { text: value, source: 'settings/shared.js FALLBACK' });
      }
    }
  }
  // 3. 调用点英文兜底（第二参数是字符串字面量，且不是 vars 对象）
  for (const file of listJsFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const { calls } = findTLocalCalls(file, src);
    for (const call of calls) {
      const classified = classifyFirstArg(call.firstArg);
      if (classified.kind !== 'literal' || !isValidKey(classified.value)) continue;
      const second = String(call.args[1] ?? '').trim();
      const quoted = /^(['"])((?:\\.|(?!\1).)*)\1$/u.exec(second);
      if (!quoted) continue;
      const text = quoted[2];
      if (text === classified.value || text.startsWith('settings.') || text.startsWith('errors.')) continue;
      if (hints.has(classified.value)) continue;
      hints.set(classified.value, {
        text,
        source: `${path.relative(REPO_ROOT, file)}:${call.line} 调用点兜底`,
      });
    }
  }
  return hints;
}

/** index.html 的 data-i18n* 属性。 */
export function extractHtmlKeys(html = fs.readFileSync(INDEX_HTML, 'utf8'), fileLabel = 'apps/console-next/index.html') {
  const out = [];
  const lines = html.split('\n');
  const attributePattern = /data-i18n(?:-aria|-title)?\s*=\s*"([^"]*)"/gu;
  lines.forEach((line, index) => {
    let match;
    attributePattern.lastIndex = 0;
    while ((match = attributePattern.exec(line)) !== null) {
      out.push({ file: fileLabel, line: index + 1, key: match[1] });
    }
  });
  return out;
}

/** i18n.js 导出的内置字典 key（BUILTIN_EN）——en 的合并底线。 */
export function extractBuiltinEnKeys() {
  const file = path.join(JS_ROOT, 'i18n.js');
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('export const BUILTIN_EN');
  if (start === -1) return [];
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n});', open);
  const body = src.slice(open, close === -1 ? src.length : close);
  const out = [];
  const pattern = /^\s*'([^']+)':/gmu;
  let match;
  let line = 1;
  let bodyLine = body.slice(0, 0).split('\n').length;
  void bodyLine;
  while ((match = pattern.exec(body)) !== null) {
    const before = body.slice(0, match.index);
    line = before.split('\n').length;
    out.push({ file: 'apps/console-next/js/i18n.js', line, key: match[1] });
  }
  return out;
}

/**
 * 运行期 schema 的 labelKey/hintKey（daemon 下发，前端源码里没有）。
 * 离线时返回 `{ keys: [], error }`，不抛错。
 */
export async function extractSchemaKeys({ base = 'http://127.0.0.1:17512', timeoutMs = 4000 } = {}) {
  try {
    if (typeof fetch !== 'function') return { keys: [], error: 'fetch unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${base}/api/v1/settings/schema`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { keys: [], error: `HTTP ${response.status}` };
    const body = await response.json();
    const keys = [];
    const seen = new Set();
    const visit = (value, trail) => {
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, trail));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [name, child] of Object.entries(value)) {
        if ((name === 'labelKey' || name === 'hintKey') && typeof child === 'string') {
          if (!seen.has(child)) {
            seen.add(child);
            keys.push({ file: `runtime:${base}/api/v1/settings/schema`, line: 0, key: child });
          }
          continue;
        }
        visit(child, trail);
      }
    };
    visit(body, []);
    return { keys, error: null };
  } catch (error) {
    return { keys: [], error: String((error && error.message) || error) };
  }
}

/** 从 daemon 错误码表拿 errors.<CODE> 全集（前端只动态拼，不在源码里）。 */
export function extractDaemonErrorCodes() {
  const out = new Set();
  const candidates = [
    path.join(REPO_ROOT, 'apps', 'daemon', 'src', 'api', 'console-errors.js'),
    path.join(REPO_ROOT, 'apps', 'console-next', 'js', 'i18n.js'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const pattern = /\b([A-Z][A-Z0-9_]{2,})\s*:/gu;
    let match;
    while ((match = pattern.exec(src)) !== null) {
      const code = match[1];
      if (/^(?:HTTP|GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|JSON|UTF|API|UI|SSE|HTML|CSS|URL|ID|OK)$/u.test(code)) continue;
      out.add(`errors.${code}`);
    }
  }
  return [...out].map((key) => ({ file: 'derived:daemon error code table', line: 0, key }));
}

/**
 * 动态 key 取值域登记表（人工维护，抽取器只校验不生成）。
 * 每条对应一个动态调用点；`values` 必须能从源码里找到出处（注释写清）。
 */
export const DOMAIN_TABLE = Object.freeze([
  {
    callSite: 'apps/console-next/js/app.js',
    keyPrefix: 'app.theme.',
    expr: '`app.theme.${preference}`',
    values: ['system', 'dark', 'light'],
    source: 'app.js THEME_CYCLE = [system, dark, light]',
  },
  {
    callSite: 'apps/console-next/js/app.js',
    keyPrefix: 'app.conn.',
    expr: '`app.conn.${state}`',
    values: ['online', 'degraded', 'offline', 'idle'],
    source: "app.js renderConn(): state ∈ ['online','degraded','offline','idle']",
  },
]);

/** 汇总抽取结果。 */
export async function extractAll(options = {}) {
  const opts = options == null ? {} : options;
  const runtime = opts.runtime !== false;
  const files = listJsFiles();
  const staticKeys = new Map(); // key -> [{file,line,source}]
  const placeholderMap = new Map(); // key -> Set<placeholder>
  const dynamicPlaceholders = new Map(); // key -> Set<placeholder>（动态取值域展开）
  const dynamicCallSites = [];
  const unknownCallSites = [];

  const addPlaceholders = (key, names) => {
    if (!Array.isArray(names)) return;
    const set = placeholderMap.get(key) ?? new Set();
    for (const name of names) set.add(name);
    placeholderMap.set(key, set);
  };

  const add = (key, origin) => {
    if (typeof key !== 'string' || key === '') return;
    const list = staticKeys.get(key) ?? [];
    list.push(origin);
    staticKeys.set(key, list);
  };

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const { calls } = findTLocalCalls(file, src);
    for (const call of calls) {
      const classified = classifyFirstArg(call.firstArg);
      const placeholders = placeholdersFromArgs(call.args);
      if (classified.kind === 'literal') {
        if (isValidKey(classified.value) && namespaceOf(classified.value) !== null) {
          add(classified.value, { file: call.file, line: call.line, source: 't() 字面量' });
          addPlaceholders(classified.value, placeholders);
        }
        continue;
      }
      if (classified.kind === 'concat' || classified.kind === 'template') {
        dynamicCallSites.push({
          file: call.file,
          line: call.line,
          kind: classified.kind,
          expr: call.firstArg,
          prefix: classified.prefix,
          placeholders,
        });
        continue;
      }
      if (classified.kind === 'unknown' || classified.kind === 'empty') {
        unknownCallSites.push({ file: call.file, line: call.line, expr: call.firstArg, placeholders });
      }
    }
    for (const entry of findTableKeys(file, src)) {
      add(entry.key, { file: entry.file, line: entry.line, source: '源码字面量表（FALLBACK/映射）' });
    }
  }

  for (const entry of extractHtmlKeys()) {
    add(entry.key, { file: entry.file, line: entry.line, source: 'index.html data-i18n*' });
  }
  for (const entry of extractBuiltinEnKeys()) {
    add(entry.key, { file: entry.file, line: entry.line, source: 'i18n.js BUILTIN_EN' });
  }
  // 合同 §8.3：errors.unknown 是规定的回落键
  add('errors.unknown', { file: 'docs/implementation/CONSOLE-V2-CONTRACT.md', line: 575, source: '合同 §8.3 回落键' });
  for (const entry of extractDaemonErrorCodes()) {
    add(entry.key, { file: entry.file, line: entry.line, source: 'daemon 错误码表' });
  }

  let schemaResult = { keys: [], error: 'skipped' };
  if (runtime) {
    schemaResult = await extractSchemaKeys({ base: opts.base });
    for (const entry of schemaResult.keys) {
      add(entry.key, { file: entry.file, line: entry.line, source: 'runtime schema labelKey/hintKey' });
    }
  }

  // 动态取值域展开
  const expanded = [];
  for (const entry of DOMAIN_TABLE) {
    for (const value of entry.values) {
      const key = `${entry.keyPrefix}${value}`;
      expanded.push({ key, file: entry.callSite, line: 0, source: `动态取值域 ${entry.source}` });
      add(key, { file: entry.callSite, line: 0, source: `动态取值域 ${entry.source}` });
      if (Array.isArray(entry.placeholders)) {
        dynamicPlaceholders.set(key, new Set(entry.placeholders));
      }
    }
  }

  // 未知动态调用点：不猜，原样报出（人工登记后写进 DOMAIN_TABLE）
  const unknownPrefixes = dynamicCallSites.map((call) => `${call.file}:${call.line} ${call.expr}`);

  // 英文原文线索（有出处的英文；没有出处的必须人工撰写并在 catalog 里登记）
  const hints = opts.hints === false ? new Map() : collectEnglishHints();

  return {
    files: files.map((file) => path.relative(REPO_ROOT, file)),
    staticKeys: [...staticKeys.entries()]
      .map(([key, origins]) => {
        const set = new Set(placeholderMap.get(key) ?? []);
        for (const name of dynamicPlaceholders.get(key) ?? []) set.add(name);
        const hint = hints.get(key) ?? null;
        return {
          key,
          origins,
          placeholders: [...set].sort(),
          englishHint: hint ? hint.text : null,
          englishHintSource: hint ? hint.source : null,
        };
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    dynamicCallSites,
    unknownPrefixes,
    unknownCallSites,
    domainExpanded: expanded,
    schema: schemaResult,
    hintCount: hints.size,
  };
}

function printSummary(result, options) {
  const lines = [];
  lines.push(`扫描源文件：${result.files.length} 个 js + index.html`);
  lines.push(`字面量/表抽取 key：${result.staticKeys.length} 条`);
  lines.push(`动态调用点（需取值域登记）：${result.dynamicCallSites.length} 处`);
  for (const call of result.dynamicCallSites) lines.push(`  · ${call.file}:${call.line}  ${call.kind}  ${call.expr.replace(/\s+/gu, ' ').slice(0, 90)}`);
  lines.push(`无法识别第一参数的 t() 调用：${result.unknownCallSites.length} 处`);
  for (const call of result.unknownCallSites) lines.push(`  · ${call.file}:${call.line}  ${call.expr.replace(/\s+/gu, ' ').slice(0, 90)}`);
  lines.push(`取值域展开 key：${result.domainExpanded.length} 条`);
  for (const entry of result.domainExpanded) lines.push(`  · ${entry.key}  ← ${entry.source}`);
  lines.push(`runtime schema：${result.schema.error ? `失败（${result.schema.error}）` : `${result.schema.keys.length} 条 labelKey/hintKey`}`);
  if (options.verbose) {
    lines.push('');
    lines.push('—— 全部 key ——');
    for (const entry of result.staticKeys) {
      lines.push(`${entry.key}\t${entry.origins.map((origin) => `${origin.file}:${origin.line}`).join(',')}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const options = {
    json: argv.includes('--json'),
    verbose: argv.includes('--verbose'),
    runtime: !argv.includes('--no-runtime'),
  };
  const unknownArgs = argv.filter((arg) => !['--json', '--verbose', '--no-runtime'].includes(arg));
  if (unknownArgs.length > 0) {
    process.stderr.write(`未知参数：${unknownArgs.join(' ')}\n`);
    process.exit(2);
  }
  const result = await extractAll(options);
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFiles: result.files,
    staticKeyCount: result.staticKeys.length,
    domainExpandedCount: result.domainExpanded.length,
    keys: result.staticKeys,
    dynamicCallSites: result.dynamicCallSites,
    unknownCallSites: result.unknownCallSites,
    domainExpanded: result.domainExpanded,
    schema: result.schema,
  };
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'keys-extracted.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`写 evidence 失败：${error.message}\n`);
  }
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${printSummary(result, options)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`extract-keys 失败：${error && error.stack ? error.stack : error}\n`);
    process.exit(3);
  });
}
