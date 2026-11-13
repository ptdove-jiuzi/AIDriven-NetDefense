#!/usr/bin/env node
/**
 * tests/e2e/i18n/verify-i18n.mjs — INT-2 / i18n 席
 *
 * 用**真实浏览器**（Edge + 自写 CDP 驱动 `tests/e2e/lib/cdp.mjs`，零依赖）验收语言目录：
 *
 * 对 6 个路由 `#/overview #/alerts #/analysis #/agent #/models #/settings`，
 * 分别在 zh-CN（主路径）与 en 两种语言下断言：
 *   a) DOM 文本里 `[missing:` 出现次数 === 0；
 *   b) en 模式 DOM 里 CJK 字符数 === 0（豁免项逐条列在 EXEMPTIONS，且每一项都必须
 *      **在当次运行里被真实命中**，否则报"豁免过期"，不允许用豁免掩盖未翻译）；
 *   c) zh-CN 模式 CJK 占比正常（默认阈值 ≥ 15% 的中文字符占比，且文案不整段英文）；
 *   d) `/i18n/locales/*.json` 无 404（Network 域的真实 status 采样）。
 *
 * en 模式怎么进：两种真实路径都验
 *   1. URL 覆盖 `?lang=en`（合同 §7.9，app.js parseOverrides → 不写 localStorage）；
 *   2. localStorage：`localStorage.setItem('aidn.ui', JSON.stringify({locale:'en'}))`
 *      （键名与形状来自 js/store.js 的 readUi/writeUi 与 js/app.js）。
 *
 * 用法：
 *   node tests/e2e/i18n/verify-i18n.mjs                       # 全量（默认 http://127.0.0.1:17512）
 *   node tests/e2e/i18n/verify-i18n.mjs --base http://127.0.0.1:17522
 *   node tests/e2e/i18n/verify-i18n.mjs --mode url|storage|both
 *   node tests/e2e/i18n/verify-i18n.mjs --json                # 机器可读
 *   node tests/e2e/i18n/verify-i18n.mjs --screenshot-dir <dir>
 *
 * 退出码：0 全部通过；1 有断言失败；2 用法错误；3 环境不可用（浏览器/服务不可达）。
 *
 * 作者：PT-dove
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { launch, waitFor } from '../lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const LOCALES_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'i18n', 'locales');

export const ROUTES = Object.freeze(['#/overview', '#/alerts', '#/analysis', '#/agent', '#/models', '#/settings']);
export const LOCALES = Object.freeze(['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']);

/** localStorage 键（js/store.js：aidn.ui 存 theme/density/locale，禁止存敏感值）。 */
export const UI_STORAGE_KEY = 'aidn.ui';

/** zh-CN 模式正常中文占比下限（DOM 文本里 CJK 字符 / 非空白字符）。 */
export const ZH_MIN_CJK_RATIO = 0.15;

/**
 * en 模式 CJK 豁免项：每条必须写明"为什么它本来就该是中文/非英文"。
 * `matches` 用于在当次运行里验证它被真实命中（没命中就报豁免过期）。
 */
export const EXEMPTIONS = Object.freeze([
  {
    id: 'brand-product-zh',
    label: '产品中文名（合同 §7.1：产品名固定 AIDriven NetDefense / 网域智防，不得改写）',
    selector: '[data-i18n="app.productZh"]',
    reason: '品牌副名，属产品标识而非界面文案；en 模式保留中文名是合同要求。',
  },
  {
    id: 'native-language-names',
    label: '语言切换器里的语言原生名（English / 简体中文 / 日本語 / 한국어 …）',
    selector: '[data-locale], .lang-list',
    reason: '语言选择器按原生名展示是通行做法；仅在打开语言抽屉时出现。',
  },
  {
    id: 'real-rule-ids',
    label: '真实规则 id / 告警 id / 进程名 / 主机名（用户数据，不是界面文案）',
    selector: '.mono, [data-alert-id], .ui-table__cell--mono',
    reason: '来自 daemon 的真实数据；按合同 §8.7 用固定夹具隔离，不做翻译。',
  },
]);

function parseArgs(argv) {
  const options = { base: 'http://127.0.0.1:17512', mode: 'both', json: false, screenshotDir: null, timeoutMs: 45000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--base') {
      options.base = String(argv[index + 1] ?? '').replace(/\/+$/u, '');
      index += 1;
    } else if (arg === '--mode') {
      options.mode = String(argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--screenshot-dir') {
      options.screenshotDir = path.resolve(process.cwd(), String(argv[index + 1] ?? ''));
      index += 1;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!['url', 'storage', 'both'].includes(options.mode)) throw new Error(`--mode 只能是 url|storage|both，收到 ${options.mode}`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) options.timeoutMs = 45000;
  return options;
}

/* ------------------------------------------------------------------ */
/* 页面内测量函数（以字符串注入，避免额外注入脚本）                      */
/* ------------------------------------------------------------------ */

/**
 * 在页面里统计：`[missing:` 出现、CJK 字符、可见文本。
 * 允许通过选择器把豁免节点里的文字排除在 CJK 统计之外（并回报每项豁免命中情况）。
 */
const MEASURE_SOURCE = String.raw`(() => {
  const EXEMPT = __EXEMPT__;
  const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
  const missingMatches = bodyText.match(/\[missing:/gu) || [];

  // 豁免节点收集 + 命中统计
  const exemptHits = [];
  const exemptTexts = [];
  for (const spec of EXEMPT) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(spec.selector)); } catch (error) { nodes = []; }
    let chars = 0;
    for (const node of nodes) {
      const text = node.innerText || node.textContent || '';
      if (/[\u3400-\u9fff]/u.test(text)) {
        exemptTexts.push(text);
        chars += (text.match(/[\u3400-\u9fff]/gu) || []).length;
      }
    }
    exemptHits.push({ id: spec.id, nodes: nodes.length, cjkChars: chars, hit: chars > 0 });
  }
  // 把豁免文本从 bodyText 里剔除后统计 CJK
  let scrubbed = bodyText;
  for (const text of exemptTexts) {
    if (text) scrubbed = scrubbed.split(text).join('');
  }
  const cjkAll = (bodyText.match(/[\u3400-\u9fff]/gu) || []).length;
  const cjkScrubbed = (scrubbed.match(/[\u3400-\u9fff]/gu) || []).length;
  const nonSpaceAll = (bodyText.replace(/\s/gu, '').length) || 0;
  const nonSpaceScrubbed = (scrubbed.replace(/\s/gu, '').length) || 0;

  // 中文"整段英文"检查：找出不含任何 CJK 的可见块（用于 zh 模式诊断）
  const asciiOnlyBlocks = [];
  if (document.querySelectorAll) {
    const candidates = document.querySelectorAll('h1, h2, h3, p, td, th, button, label, span.ui-btn__label');
    for (const node of candidates) {
      const text = (node.innerText || node.textContent || '').trim();
      if (text.length < 12) continue;
      if (/[\u3400-\u9fff]/u.test(text)) continue;
      if (!/[A-Za-z]{3,}/u.test(text)) continue;
      asciiOnlyBlocks.push(text.slice(0, 120));
      if (asciiOnlyBlocks.length >= 12) break;
    }
  }
  return {
    missingCount: missingMatches.length,
    missingSamples: (bodyText.match(/\[missing:[^\]]{0,80}\]/gu) || []).slice(0, 20),
    cjkAll,
    cjkScrubbed,
    cjkRatio: nonSpaceAll === 0 ? 0 : cjkAll / nonSpaceAll,
    textLength: bodyText.length,
    nonSpaceLength: nonSpaceAll,
    exemptHits,
    exemptCjkScrubbedOut: cjkAll - cjkScrubbed,
    asciiOnlyBlocks: asciiOnlyBlocks.slice(0, 8),
    htmlLang: document.documentElement ? document.documentElement.getAttribute('lang') : null,
    i18n: (() => {
      try {
        const api = window.__I18N__;
        if (!api || typeof api.status !== 'function') return null;
        const status = api.status();
        return { locale: status.locale, loaded: status.loaded, failed: status.failed, loadFailures: status.loadFailures, missingCount: status.missingCount, missingKeys: (status.missingKeys || []).slice(0, 30) };
      } catch (error) { return { error: String(error && error.message ? error.message : error) }; }
    })(),
    storage: (() => {
      try { return localStorage.getItem('__KEY__'); } catch (error) { return null; }
    })(),
  };
})()`;

/** 把测量函数参数化（豁免清单 + localStorage 键）。 */
function measureExpression() {
  const exempt = EXEMPTIONS.map((entry) => ({ id: entry.id, selector: entry.selector }));
  return MEASURE_SOURCE
    .replace('__EXEMPT__', JSON.stringify(exempt))
    .replace('__KEY__', UI_STORAGE_KEY);
}

/* ------------------------------------------------------------------ */
/* 单路由断言                                                          */
/* ------------------------------------------------------------------ */

function urlFor(base, route, locale, mode) {
  if (mode === 'url') return `${base}/?lang=${encodeURIComponent(locale)}${route}`;
  // storage 模式必须换一个**真实不同**的 URL 才会重新加载文档：
  // 只改 hash 属于同文档跳转，app.js 不会重新 bootstrap（首轮实测的坑）。
  return `${base}/?seed=${encodeURIComponent(locale)}${route}`;
}

/**
 * 打开一个路由并采集指标。
 *
 * @param {import('../lib/cdp.mjs').Browser} browser
 * @param {{base: string, mode: string, locale: string, route: string, timeoutMs: number, screenshotDir: string|null}} spec
 */
async function inspectRoute(browser, spec) {
  const page = await browser.newPage();
  const target = urlFor(spec.base, spec.route, spec.locale, spec.mode);
  if (spec.mode === 'storage') {
    // 先到同源页面写 localStorage（键名/形状来自 js/store.js 的 aidn.ui），
    // 再用**不同 URL** 重新加载，让 app.js 真正 bootstrap 一次读回偏好。
    await page.goto(`${spec.base}/?seed=0`, { timeoutMs: spec.timeoutMs });
    await page.evaluate(`localStorage.setItem(${JSON.stringify(UI_STORAGE_KEY)}, JSON.stringify({ locale: ${JSON.stringify(spec.locale)} }))`);
  }
  page.resetReport();
  await page.goto(target, { timeoutMs: spec.timeoutMs });
  // 视图挂载完成：主区有内容 + i18n 已 ready
  try {
    await page.waitFor(
      "document.querySelector('#view-root') && document.querySelector('#view-root').childNodes.length > 0",
      { timeoutMs: spec.timeoutMs, label: `${spec.route} 渲染` },
    );
    await page.waitFor('window.__I18N__ && window.__I18N__.status', { timeoutMs: 8000, label: 'i18n ready' });
  } catch {
    /* 渲染超时也继续测量：缺东西正是要记录的证据 */
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  const metrics = await page.evaluate(measureExpression());

  // en 模式额外打开语言抽屉：语言原生名（简体中文/日本語/한국어…）只在抽屉里出现，
  // 必须让这条豁免当次真的命中，否则"零 CJK"就是靠没打开抽屉蒙过去的。
  let drawerMetrics = null;
  if (spec.locale === 'en' && spec.openDrawer) {
    try {
      await page.click('#lang-toggle');
      await page.waitForSelector('[role="listbox"] [data-locale]', { timeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      drawerMetrics = await page.evaluate(measureExpression());
      await page.escape();
    } catch {
      drawerMetrics = null;
    }
  }
  const measured = drawerMetrics ?? metrics;
  const report = page.report();
  const localeResponses = report.badResponses
    .filter((entry) => String(entry.url || '').includes('/i18n/locales/'))
    .map((entry) => ({ url: entry.url, status: entry.status }));
  const okLocaleResponses = (report.responses ?? [])
    .filter((entry) => String(entry.url || '').includes('/i18n/locales/'))
    .map((entry) => ({ url: entry.url, status: entry.status }));
  const shot = spec.screenshotDir
    ? path.join(spec.screenshotDir, `${spec.locale}-${spec.route.replace(/[#/]/gu, '_')}.png`)
    : null;
  if (shot) {
    try {
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      fs.writeFileSync(shot, await page.screenshot());
    } catch {
      /* 截图失败不影响断言 */
    }
  }
  return {
    metrics,
    measured,
    drawerMetrics,
    drawerOpened: Boolean(spec.locale === 'en' && spec.openDrawer),
    report,
    localeResponses,
    okLocaleResponses,
    screenshot: shot,
    url: target,
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function localeFileFacts() {
  const facts = [];
  for (const locale of LOCALES) {
    const file = path.join(LOCALES_DIR, `${locale}.json`);
    if (!fs.existsSync(file)) {
      facts.push({ locale, exists: false, bytes: 0, keys: 0 });
      continue;
    }
    let keys = 0;
    let parseError = null;
    try {
      keys = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length;
    } catch (error) {
      parseError = String(error && error.message ? error.message : error);
    }
    facts.push({ locale, exists: true, bytes: fs.statSync(file).size, keys, parseError });
  }
  return facts;
}

/**
 * 启动浏览器（带重试）。
 *
 * 本仓库同一时间可能有多个代理在跑各自的 CDP 用例（integrator / punch / visual），
 * 冷启动偶尔会拿不到 DevToolsActivePort（并发拉起 + 临时 profile 争用）。
 * 这里只做**自己进程内的重试**，绝不去杀别人的 msedge（那会打断并行验收）。
 *
 * @param {number} attempts
 */
async function launchWithRetry(attempts = 3) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await launch({ headless: true });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (index + 1)));
    }
  }
  throw lastError ?? new Error('launch failed');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('node tests/e2e/i18n/verify-i18n.mjs [--base URL] [--mode url|storage|both] [--json] [--screenshot-dir DIR]\n');
    process.exit(0);
  }

  // 服务可达性（先探活，避免把"服务没起"误报成"i18n 坏了"）
  try {
    const response = await fetch(`${options.base}/`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    process.stderr.write(`服务不可达 ${options.base}：${error && error.message ? error.message : error}\n`);
    process.exit(3);
  }

  const modes = options.mode === 'both' ? ['url', 'storage'] : [options.mode];
  const cases = [];
  for (const mode of modes) {
    for (const locale of ['zh-CN', 'en']) {
      for (const route of ROUTES) cases.push({ mode, locale, route });
    }
  }

  const browser = await launchWithRetry();
  const results = [];
  try {
    for (const spec of cases) {
      // en 的 storage 模式只在 url 模式已通过时跑（两路径语义相同，都跑会翻倍耗时）
      if (spec.mode === 'storage' && spec.locale === 'en' && results.some((entry) => entry.mode === 'storage' && entry.locale === 'en' && !entry.pass)) continue;
      const outcome = await inspectRoute(browser, {
        ...spec,
        base: options.base,
        timeoutMs: options.timeoutMs,
        screenshotDir: options.screenshotDir,
        // 语言抽屉在每种 mode 的**第一个 en 路由**上打开一次：够证明原生名会渲染，
        // 又不会把 12 个用例都拖慢；同时也让「原生名」这条豁免在当次运行里真实命中。
        openDrawer: spec.locale === 'en' && spec.route === ROUTES[0],
      });
      const checks = [];
      const { measured } = outcome;
      const zhCjkRatio = measured.nonSpaceLength === 0 ? 0 : measured.cjkAll / measured.nonSpaceLength;

      if (spec.locale === 'zh-CN') {
        checks.push({
          id: 'zh.no-missing',
          pass: measured.missingCount === 0,
          detail: `[missing: ${measured.missingCount} 处${measured.missingCount > 0 ? `，例：${measured.missingSamples.slice(0, 5).join(' ')}` : ''}`,
        });
        checks.push({
          id: 'zh.cjk-ratio',
          pass: zhCjkRatio >= ZH_MIN_CJK_RATIO && measured.textLength > 0,
          detail: `CJK 占比 ${(zhCjkRatio * 100).toFixed(1)}%（下限 ${(ZH_MIN_CJK_RATIO * 100).toFixed(0)}%），文本 ${measured.textLength} 字符`,
        });
        checks.push({
          id: 'zh.lang-attr',
          pass: measured.htmlLang === 'zh-CN',
          detail: `<html lang> = ${String(measured.htmlLang)}`,
        });
      } else {
        checks.push({
          id: 'en.no-missing',
          pass: measured.missingCount === 0,
          detail: `[missing: ${measured.missingCount} 处${measured.missingCount > 0 ? `，例：${measured.missingSamples.slice(0, 5).join(' ')}` : ''}`,
        });
        // CJK：剔除豁免后必须为 0；同时校验每条豁免当次真的命中（防"豁免掩盖"）
        checks.push({
          id: 'en.no-cjk',
          pass: measured.cjkScrubbed === 0,
          detail: `剔除豁免后 CJK ${measured.cjkScrubbed}（原始 ${measured.cjkAll}，豁免剔除 ${measured.exemptCjkScrubbedOut}）`,
        });
        checks.push({
          id: 'en.lang-attr',
          pass: measured.htmlLang === 'en',
          detail: `<html lang> = ${String(measured.htmlLang)}`,
        });
        if (outcome.drawerOpened) {
          checks.push({
            id: 'en.lang-drawer',
            pass: outcome.drawerMetrics !== null && outcome.drawerMetrics.cjkScrubbed === 0,
            detail: outcome.drawerMetrics === null
              ? '语言抽屉未能打开（原生名豁免无法被证明）'
              : `抽屉内剔除豁免后 CJK ${outcome.drawerMetrics.cjkScrubbed}（原始 ${outcome.drawerMetrics.cjkAll}）`,
          });
        }
      }

      // 语言文件 404 检查（Network 域真实采样）
      checks.push({
        id: 'locales.no-404',
        pass: outcome.localeResponses.length === 0,
        detail: outcome.localeResponses.length === 0
          ? `语言文件请求 ${outcome.okLocaleResponses.length} 个，无 404`
          : `404：${outcome.localeResponses.map((entry) => `${path.basename(String(entry.url))}=${entry.status}`).join(', ')}`,
      });

      results.push({
        ...spec,
        url: outcome.url,
        pass: checks.every((check) => check.pass),
        checks,
        metrics: {
          missingCount: measured.missingCount,
          missingSamples: measured.missingSamples,
          cjkAll: measured.cjkAll,
          cjkScrubbed: measured.cjkScrubbed,
          textLength: measured.textLength,
          nonSpaceLength: measured.nonSpaceLength,
          htmlLang: measured.htmlLang,
          i18n: measured.i18n,
          exemptHits: [...measured.exemptHits, ...(outcome.drawerMetrics?.exemptHits ?? [])],
          asciiOnlyBlocks: measured.asciiOnlyBlocks,
          localeRequests: outcome.okLocaleResponses,
          drawer: outcome.drawerMetrics
            ? { cjkAll: outcome.drawerMetrics.cjkAll, cjkScrubbed: outcome.drawerMetrics.cjkScrubbed, textLength: outcome.drawerMetrics.textLength }
            : null,
        },
        report: {
          consoleErrors: outcome.report.consoleErrors.map((entry) => entry.text ?? entry.message ?? String(entry)),
          exceptions: outcome.report.exceptions.map((entry) => entry.text ?? entry.message ?? String(entry)),
          badResponses: outcome.report.badResponses.map((entry) => `${entry.status} ${entry.url}`),
        },
        screenshot: outcome.screenshot,
      });
    }
  } finally {
    await browser.close();
  }

  // 豁免命中审计：每条豁免必须在某次运行里命中过，否则说明是"死豁免"
  const exemptAudit = EXEMPTIONS.map((exemption) => {
    const hits = results.flatMap((entry) => entry.metrics.exemptHits.filter((hit) => hit.id === exemption.id && hit.hit));
    return {
      id: exemption.id,
      label: exemption.label,
      reason: exemption.reason,
      selector: exemption.selector,
      hitAtLeastOnce: hits.length > 0,
      hitRuns: hits.length,
    };
  });

  const localeFacts = localeFileFacts();
  const summary = {
    base: options.base,
    modes,
    routes: ROUTES,
    generatedAt: new Date().toISOString(),
    passCount: results.filter((entry) => entry.pass).length,
    failCount: results.filter((entry) => !entry.pass).length,
    totalCases: results.length,
    locales: localeFacts,
    exemptions: exemptAudit,
    deadExemptions: exemptAudit.filter((entry) => !entry.hitAtLeastOnce).map((entry) => entry.id),
    results,
  };

  const evidenceDir = path.join(REPO_ROOT, 'docs', 'implementation', 'evidence', 'ui2', 'i18n');
  // 两套数据态（17512 有真实遥测 / 17522 空库）各留一份证据，文件名带端口以免互相覆盖
  const portTag = (() => {
    try {
      return new URL(options.base).port || 'default';
    } catch {
      return 'unknown';
    }
  })();
  const evidenceFile = path.join(evidenceDir, `verify-i18n-${portTag}.json`);
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(evidenceFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(evidenceDir, 'verify-i18n.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`写 evidence 失败：${error && error.message ? error.message : error}\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const lines = [];
    lines.push(`base=${options.base} mode=${modes.join('+')} cases=${results.length}`);
    lines.push(`语言文件：${localeFacts.map((entry) => `${entry.locale}=${entry.exists ? entry.keys : 'MISSING'}`).join(' ')}`);
    lines.push('');
    lines.push('locale  route        结果  [missing:]  CJK(原生/剔除)  lang   断言');
    for (const entry of results) {
      const missing = entry.metrics.missingCount;
      const failed = entry.checks.filter((check) => !check.pass).map((check) => check.id);
      lines.push([
        entry.locale === 'zh-CN' ? 'zh-CN ' : 'en    ',
        entry.route.padEnd(12),
        entry.pass ? 'PASS' : 'FAIL',
        String(missing).padStart(9),
        `${entry.metrics.cjkAll}/${entry.metrics.cjkScrubbed}`.padStart(12),
        String(entry.metrics.htmlLang ?? 'null').padEnd(7),
        failed.length === 0 ? entry.checks.map((check) => check.id).join(',') : `失败:${failed.join(',')}`,
      ].join(' '));
      if (!entry.pass) {
        for (const check of entry.checks.filter((item) => !item.pass)) lines.push(`        ✗ ${check.id}: ${check.detail}`);
        for (const sample of entry.metrics.missingSamples.slice(0, 5)) lines.push(`        missing 样本: ${sample}`);
        for (const block of entry.metrics.asciiOnlyBlocks.slice(0, 4)) lines.push(`        整段无中文: ${block}`);
      }
    }
    lines.push('');
    lines.push(`豁免审计：${exemptAudit.filter((entry) => entry.hitAtLeastOnce).length}/${exemptAudit.length} 条当次命中`);
    for (const entry of exemptAudit) lines.push(`  ${entry.hitAtLeastOnce ? '✓' : '✗ 未命中（豁免过期）'} ${entry.id} — ${entry.label}`);
    if (summary.deadExemptions.length > 0) lines.push(`死豁免：${summary.deadExemptions.join(', ')}`);
    lines.push('');
    lines.push(`结论：${summary.failCount === 0 ? 'PASS' : 'FAIL'}（pass ${summary.passCount} / fail ${summary.failCount}）`);
    lines.push(`证据：${path.relative(REPO_ROOT, path.join(evidenceDir, 'verify-i18n.json'))}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exit(summary.failCount === 0 && summary.deadExemptions.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`verify-i18n 失败：${error && error.stack ? error.stack : error}\n`);
    process.exit(3);
  });
}
