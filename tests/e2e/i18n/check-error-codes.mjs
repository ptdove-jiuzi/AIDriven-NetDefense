#!/usr/bin/env node
/**
 * tests/e2e/i18n/check-error-codes.mjs — INT-2 / i18n 席
 *
 * 回归门禁：**每一个可能出现在界面上的错误码，本地化必须有对应 `errors.<CODE>` 文案**。
 *
 * 为什么需要它：`errors.<CODE>` 的 key 不在前端源码里——前端拿到的是 daemon / console host
 * 返回的**运行时字符串**。缺一条的后果是真实的：
 *   - `js/api.js:messageForCode` 会回落成 "Something went wrong. (CODE)"（丢人话）；
 *   - `js/views/settings/shared.js` 的适配器**始终**拼 `[missing:errors.CODE]`（§8.5 禁止静默），
 *     于是高负载下设置页真的会出现 `[missing:errors.DAEMON_TIMEOUT]`。
 *
 * 码源（全部静态可得，无需起服务）：
 *   1. `apps/console-next/serve.mjs` —— console host 网关层码（合同 §12.1 点名 DAEMON_TIMEOUT/DAEMON_UNREACHABLE）；
 *   2. `apps/daemon/src/api/console-errors.js` —— daemon 稳定错误码表；
 *   3. `apps/console-next/js/api.js` —— HTTP 状态兜底码 + 传输层码；
 *   4. `apps/console-next/js/**` 里 `code: '<CODE>'` / `new ApiError('<CODE>')` 字面量（视图内部码）。
 *
 * 用法：
 *   node tests/e2e/i18n/check-error-codes.mjs
 *   node tests/e2e/i18n/check-error-codes.mjs --json
 *
 * 退出码：0 全覆盖；1 有缺失；2 用法错误。
 *
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const LOCALES_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'i18n', 'locales');
const CONSOLE_JS = path.join(REPO_ROOT, 'apps', 'console-next', 'js');
const SERVE = path.join(REPO_ROOT, 'apps', 'console-next', 'serve.mjs');
const DAEMON_ERRORS = path.join(REPO_ROOT, 'apps', 'daemon', 'src', 'api', 'console-errors.js');

/** 只收集"大写稳定码"，并排掉明显不是错误码的常量。 */
const NOT_CODES = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'JSON', 'HTML', 'CSS', 'UTF', 'HTTP', 'HTTPS',
  'API', 'URL', 'URI', 'ID', 'OK', 'SSE', 'CSP', 'CORS', 'CSRF', 'UI', 'DOM', 'EOF', 'NaN', 'TRUE', 'FALSE',
]);

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 汇总所有码源。
 * @returns {{code: string, source: string, line: number}[]}
 */
export function collectErrorCodes() {
  const found = [];
  const seen = new Set();
  const add = (code, source, line) => {
    if (typeof code !== 'string' || code === '') return;
    if (!/^[A-Z][A-Z0-9_]{2,}$/u.test(code)) return;
    if (NOT_CODES.has(code)) return;
    const id = `${code}@${source}:${line}`;
    if (seen.has(id)) return;
    seen.add(id);
    found.push({ code, source, line });
  };
  const lineOf = (text, index) => text.slice(0, index).split('\n').length;

  // 1. console host
  if (fs.existsSync(SERVE)) {
    const src = fs.readFileSync(SERVE, 'utf8');
    for (const match of src.matchAll(/'([A-Z][A-Z0-9_]{2,})'/gu)) {
      // 只认出现在 failOnce/sendJson 调用里的码
      const before = src.slice(Math.max(0, match.index - 120), match.index);
      if (!/(?:failOnce|sendJson)\(/u.test(before)) continue;
      add(match[1], 'apps/console-next/serve.mjs', lineOf(src, match.index));
    }
  }

  // 2. daemon 稳定码表
  if (fs.existsSync(DAEMON_ERRORS)) {
    const src = fs.readFileSync(DAEMON_ERRORS, 'utf8');
    for (const match of src.matchAll(/^\s*([A-Z][A-Z0-9_]{2,})\s*:/gmu)) {
      add(match[1], 'apps/daemon/src/api/console-errors.js', lineOf(src, match.index));
    }
  }

  // 3. api.js 的状态兜底码 + 传输层码
  const apiFile = path.join(CONSOLE_JS, 'api.js');
  if (fs.existsSync(apiFile)) {
    const src = fs.readFileSync(apiFile, 'utf8');
    for (const match of src.matchAll(/^\s*\d{3}:\s*'([A-Z][A-Z0-9_]+)'/gmu)) {
      add(match[1], 'apps/console-next/js/api.js', lineOf(src, match.index));
    }
    for (const match of src.matchAll(/TRANSPORT_CODES\s*=\s*Object\.freeze\(\[([^\]]+)\]/gu)) {
      for (const codeMatch of match[1].matchAll(/'([A-Z][A-Z0-9_]+)'/gu)) {
        add(codeMatch[1], 'apps/console-next/js/api.js', lineOf(src, match.index));
      }
    }
  }

  // 4. 视图内部码字面量
  for (const file of walkJs(CONSOLE_JS)) {
    if (path.basename(file) === 'i18n.js') continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(/(?:code:\s*|new ApiError\(\s*)'([A-Z][A-Z0-9_]{2,})'/gu)) {
      add(match[1], path.relative(REPO_ROOT, file).split(path.sep).join('/'), lineOf(src, match.index));
    }
  }
  return found;
}

function readLocale(locale) {
  const file = path.join(LOCALES_DIR, `${locale}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const unknown = argv.filter((arg) => arg !== '--json');
  if (unknown.length > 0) {
    process.stderr.write(`未知参数：${unknown.join(' ')}\n`);
    process.exit(2);
  }
  const codes = collectErrorCodes();
  const unique = [...new Set(codes.map((entry) => entry.code))].sort();
  const tables = { en: readLocale('en'), 'zh-CN': readLocale('zh-CN') };
  const report = { totalCodes: unique.length, locales: {}, missing: {}, ok: true };
  for (const [locale, table] of Object.entries(tables)) {
    if (table === null) {
      report.locales[locale] = 'MISSING FILE';
      report.ok = false;
      continue;
    }
    const present = unique.filter((code) => typeof table[`errors.${code}`] === 'string');
    const missing = unique.filter((code) => typeof table[`errors.${code}`] !== 'string');
    report.locales[locale] = { present: present.length, missing: missing.length };
    report.missing[locale] = missing.map((code) => {
      const first = codes.find((entry) => entry.code === code);
      return { key: `errors.${code}`, source: first ? `${first.source}:${first.line}` : null };
    });
    if (missing.length > 0) report.ok = false;
  }
  report.sources = [...new Map(codes.map((entry) => [entry.source, true])).keys()];

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [`错误码总数：${report.totalCodes}`, `码源：${report.sources.join(', ')}`];
    for (const [locale, stats] of Object.entries(report.locales)) {
      lines.push(`${locale}: ${typeof stats === 'string' ? stats : `覆盖 ${stats.present}/${report.totalCodes}，缺 ${stats.missing}`}`);
      for (const item of report.missing[locale] ?? []) lines.push(`  ✗ ${item.key}  ← ${item.source}`);
    }
    lines.push(`结论：${report.ok ? 'PASS' : 'FAIL'}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
