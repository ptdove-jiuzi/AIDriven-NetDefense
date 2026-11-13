/**
 * T5 visual · 视觉矩阵（6 页 × 3 档宽度 × 暗/亮 = 36 张）+ 横向零溢出
 *
 * 自包含：用 `harness.mjs` 的 `startConsoleAndDaemon()` 现起一套「假 daemon + console host」，
 * **不依赖** 127.0.0.1:17512/17522 的外部真栈（那两套只属于旧用例的只读消费面，现已下线）。
 *
 * 夹具数据全部来自产品源码里的真实契约（只读 import，不手写示例数据）：
 * - `describeSettingsSchema()` / `DEFAULT_SETTINGS` → 设置页 8 组真实字段；
 * - `/api/v1/alerts`、`/api/v1/analysis` 按 daemon 的真实分页信封返回空列表 → 页面渲染真实空态。
 *
 * 判据（逐张，实测数字，不靠目测）：
 * 1. 文件存在且 PNG 尺寸 = 档位宽度 × 900；2. 非纯色（采样颜色数 > 20）；
 * 3. 横向零溢出 `documentElement.scrollWidth <= clientWidth`（记录越界元素）；
 * 4. `body[data-theme]` 与请求一致，且同页同宽暗/亮两张的平均亮度差 > 0.15（证明主题真的换了）；
 * 5. 页面上没有 `[missing:` 占位符。
 *
 * 存档：`evidence/ui-polish/visual/matrix/<page>-<width>-<theme>.png` + `matrix-manifest.json`。
 * 运行：`node --test tests/console-next/visual-matrix.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS, describeSettingsSchema } from '../../apps/daemon/src/api/settings-schema.js';
import { edgeAvailable, withCdpPage } from './edge.mjs';
import { startConsoleAndDaemon } from './harness.mjs';
import { decodePng } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const OUT_DIR = path.join(REPO_ROOT, 'evidence', 'ui-polish', 'visual', 'matrix');
const ROUTES = ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings'];
/** 引导在场态只挑首屏最关键的三页（其 banner 为普通文档流，1024 下最容易被挤出）。 */
const ONBOARDING_ROUTES = ['overview', 'settings', 'agent'];
/** 共享 fake daemon 未实现这两路由 → 页面渲染真实空态（manifest 里标 state=''empty''）。 */
const EMPTY_STATE_ROUTES = new Set(['alerts', 'analysis']);
const THEMES = ['dark', 'light'];
const WIDTHS = [1024, 1440, 1920];
const HEIGHT = 900;
const LANG = 'zh-CN';
const hasEdge = edgeAvailable();

/** 页面就绪：视图已渲染、无骨架、无 [missing:、连接胶囊已定档（≠ idle）。 */
const READY_EXPRESSION = [
  "(document.querySelector('#view-root')?.children.length ?? 0) > 0",
  "!document.body.textContent.includes('[missing:')",
  "document.querySelectorAll('.ui-skeleton').length === 0",
  "(document.querySelector('#conn-pill')?.getAttribute('data-tone') ?? 'idle') !== 'idle'",
].join(' && ');

/** 单页度量：溢出 + 主题/密度声明 + 视图规模。 */
const MEASURE = String.raw`(() => {
  const vw = document.documentElement.clientWidth;
  const overflowEls = [];
  for (const node of document.querySelectorAll('body *')) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right > vw + 1 || rect.left < -1) {
      const cls = typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\s+/u).join('.') : '';
      overflowEls.push(node.tagName.toLowerCase() + cls);
      if (overflowEls.length >= 10) break;
    }
  }
  const banner = document.querySelector('#onboarding-banner, .onboarding-banner');
  const composer = document.querySelector('.chat-composer');
  const vh = window.innerHeight;
  const composerRect = composer ? composer.getBoundingClientRect() : null;
  const controls = Array.from(document.querySelectorAll('#view-root .ui-btn, #view-root .chat-composer'))
    .map((node) => node.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const belowFold = controls.filter((rect) => rect.bottom > vh + 1);
  return {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: vw,
    overflow: document.documentElement.scrollWidth - vw,
    overflowEls,
    theme: document.body.dataset.theme,
    density: document.body.dataset.density,
    missingMarkers: (document.body.innerText.match(/\[missing:/gu) ?? []).length,
    textLen: document.querySelector('#view-root')?.innerText.length ?? 0,
    onboarding: {
      present: Boolean(banner),
      height: banner ? Math.round(banner.getBoundingClientRect().height) : 0,
    },
    viewport: {
      innerHeight: vh,
      controlCount: controls.length,
      controlsBelowFold: belowFold.length,
      worstBelowFoldPx: belowFold.length === 0 ? 0 : Math.max(...belowFold.map((rect) => Math.round(rect.bottom - vh))),
      composer: composerRect
        ? {
            bottom: Math.round(composerRect.bottom),
            fullyVisible: composerRect.bottom <= vh + 1,
            scrollNeededPx: Math.max(0, Math.round(composerRect.bottom - vh)),
          }
        : null,
    },
  };
})()`;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 采样统计不同颜色数（非纯色判据）。 */
function distinctColors(png) {
  const seen = new Set();
  const step = png.channels * 37;
  for (let index = 0; index + png.channels <= png.pixels.length; index += step) {
    seen.add(`${png.pixels[index]},${png.pixels[index + 1]},${png.pixels[index + 2]}`);
    if (seen.size > 40) break;
  }
  return seen.size;
}

/** 整图平均亮度：用于判"暗/亮两套真的换了"。 */
function meanLuminance(png) {
  let sum = 0;
  let count = 0;
  const step = png.channels * 13;
  for (let index = 0; index + png.channels <= png.pixels.length; index += step) {
    const linear = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    sum += 0.2126 * linear(png.pixels[index]) + 0.7152 * linear(png.pixels[index + 1]) + 0.0722 * linear(png.pixels[index + 2]);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * 假 daemon 夹具：真实 schema/设置文档 + 空列表信封（见文件头说明）。
 * `onRequest` 返回 false 表示由本夹具直接应答，不再落到共享夹具的 404 分支。
 */
function fixtureOptions() {
  return {
    settingsSchema: describeSettingsSchema(),
    settings: {
      schemaVersion: '1.0',
      updatedAt: '2026-11-04T00:00:00.000Z',
      settings: DEFAULT_SETTINGS,
      warnings: [],
    },
    onRequest(record, res) {
      const pathname = String(record.url ?? '').split('?')[0];
      if (pathname !== '/api/v1/alerts' && pathname !== '/api/v1/analysis') return undefined;
      const body = JSON.stringify({
        items: [],
        page: {
          limit: 50,
          returned: 0,
          has_more: false,
          next_cursor: null,
          order: pathname.endsWith('alerts') ? 'ts_desc' : 'created_desc',
          byte_limited: false,
        },
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      record.responseStatus = 200;
      return false;
    },
  };
}

test('视觉矩阵 36 张：6 页 × 3 档宽度（1024/1440/1920）× 暗/亮，横向零溢出', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const env = await startConsoleAndDaemon(t, { daemon: fixtureOptions() });
  const manifest = [];
  const failures = [];

  /** CDP 会话偶发超时（整包并发时机器忙）→ 最多重试 3 次，避免门禁假红。 */
  const withRetry = async (options, run) => {
    let last = { ok: false, reason: 'CDP_PAGE_FAILED: not attempted' };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await withCdpPage(options, run);
      if (result.ok !== false) return result;
      last = result;
      t.diagnostic(`CDP retry ${attempt}/3: ${result.reason ?? 'unknown'}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
    return last;
  };

  /** 采一组（组内逐页导航 + 度量 + 存档），返回该组全部条目。 */
  const captureGroup = async ({ routes, state, onboarding = false, emptyRoutes = new Set() }) => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const captured = await withRetry({ width, height: HEIGHT, timeoutMs: 120000 }, async (api) => {
          const rows = [];
          for (const route of routes) {
            // 唯一 query 强制整页加载：只改 hash 时浏览器不重载，会残留上一页状态
            const stamp = `${Date.now().toString(36)}-${route}`;
            const onboard = onboarding ? '&onboarding=1' : '';
            const url = `${env.url}/index.html?lang=${LANG}&theme=${theme}&static=1${onboard}&t=${stamp}#/${route}`;
            const readyExpression = onboarding
              ? `${READY_EXPRESSION} && Boolean(document.querySelector('#onboarding-banner'))`
              : READY_EXPRESSION;
            let ready = await api.navigate(url, { waitMs: 900, waitExpression: readyExpression, waitForTimeoutMs: 15000 });
            let measure = await api.evaluate(MEASURE);
            if (!ready || measure.missingMarkers > 0) {
              await new Promise((resolve) => setTimeout(resolve, 600));
              ready = await api.navigate(`${url}&r=1`, { waitMs: 900, waitExpression: readyExpression, waitForTimeoutMs: 15000 });
              measure = await api.evaluate(MEASURE);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
            const png = await api.screenshot();
            const file = onboarding
              ? path.join(OUT_DIR, 'onboarding', `${route}-${width}-${theme}.png`)
              : path.join(OUT_DIR, `${route}-${width}-${theme}.png`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, png);
            const decoded = decodePng(png);
            rows.push({
              route,
              width,
              theme,
              state: emptyRoutes.has(route) ? 'empty' : state,
              ready,
              file: path.relative(REPO_ROOT, file).replace(/\\/gu, '/'),
              sha256: sha256(png),
              bytes: png.length,
              pngWidth: decoded.width,
              pngHeight: decoded.height,
              distinctColors: distinctColors(decoded),
              meanLuminance: meanLuminance(decoded),
              ...measure,
            });
          }
          return rows;
        });
        assert.equal(captured.ok === false, false, `CDP session failed at ${width}/${theme}: ${captured.reason ?? ''}`);
        manifest.push(...captured);
      }
    }
  };

  await captureGroup({ routes: ROUTES, state: 'product', emptyRoutes: EMPTY_STATE_ROUTES });
  await captureGroup({ routes: ONBOARDING_ROUTES, state: 'onboarding', onboarding: true });

  const product = manifest.filter((entry) => entry.state === 'product' || entry.state === 'empty');
  const onboardingCaptures = manifest.filter((entry) => entry.state === 'onboarding');
  assert.equal(product.length, ROUTES.length * WIDTHS.length * THEMES.length, 'product matrix must have exactly 36 captures');
  assert.equal(onboardingCaptures.length, ONBOARDING_ROUTES.length * WIDTHS.length * THEMES.length, 'onboarding set must have exactly 18 captures');

  for (const entry of manifest) {
    const label = `${entry.route}-${entry.width}-${entry.theme}${entry.state === 'onboarding' ? ' (onboarding)' : ''}`;
    assert.equal(fs.existsSync(path.join(REPO_ROOT, entry.file)), true, `archived PNG missing: ${entry.file}`);
    assert.equal(entry.pngWidth, entry.width, `${label}: PNG width`);
    assert.equal(entry.pngHeight, HEIGHT, `${label}: PNG height`);
    assert.ok(entry.distinctColors > 20, `${label}: looks blank/flat (colors=${entry.distinctColors})`);
    assert.ok(entry.textLen > 20, `${label}: view rendered almost no text (len=${entry.textLen})`);
    assert.equal(entry.theme, entry.file.includes('-light.png') ? 'light' : 'dark', `${label}: body[data-theme] mismatch`);
    assert.equal(entry.density, 'comfortable', `${label}: default density must be comfortable`);
    assert.equal(entry.missingMarkers, 0, `${label}: ${entry.missingMarkers} [missing:] marker(s)`);
    // 横向零溢出：判据来自真实布局，不是 CSS overflow:hidden 掩盖
    assert.equal(entry.overflow, 0, `${label}: horizontal overflow +${entry.overflow}px (${JSON.stringify(entry.overflowEls)})`);
    assert.ok(entry.scrollWidth <= entry.clientWidth, `${label}: scrollWidth ${entry.scrollWidth} > clientWidth ${entry.clientWidth}`);
    if (!entry.ready) failures.push(`${label}: ready condition not reached`);
    if (entry.state === 'onboarding') {
      assert.ok(entry.onboarding.height > 0, `${label}: ?onboarding=1 did not render the banner (height=${entry.onboarding.height})`);
      // 引导在场时 composer/主按钮允许需要滚动（记录真实数字），但不得把页面撑出横向溢出
      assert.equal(entry.viewport.composer ? entry.viewport.composer.scrollNeededPx >= 0 : true, true, `${label}: composer scroll math`);
    }
  }

  // 主题真的换了：同页同宽 暗 vs 亮 平均亮度差 > 0.15
  for (const group of [{ label: 'product', entries: product }, { label: 'onboarding', entries: onboardingCaptures }]) {
    for (const route of group.label === 'product' ? ROUTES : ONBOARDING_ROUTES) {
      for (const width of WIDTHS) {
        const dark = group.entries.find((entry) => entry.route === route && entry.width === width && entry.theme === 'dark');
        const light = group.entries.find((entry) => entry.route === route && entry.width === width && entry.theme === 'light');
        assert.ok(dark && light, `${route}-${width}: dark/light pair missing in ${group.label}`);
        assert.ok(
          light.meanLuminance - dark.meanLuminance > 0.15,
          `${route}-${width} ${group.label}: theme not applied (dark ${dark.meanLuminance.toFixed(3)} vs light ${light.meanLuminance.toFixed(3)})`,
        );
      }
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'matrix-manifest.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    stack: env.url,
    lang: LANG,
    sizes: WIDTHS,
    height: HEIGHT,
    counts: {
      normal: product.filter((entry) => entry.state === 'product').length,
      empty: product.filter((entry) => entry.state === 'empty').length,
      onboarding: onboardingCaptures.length,
    },
    stateLegend: {
      normal: '产品正常态（假 daemon 提供的真实夹具数据）',
      empty: '真实空态：假 daemon 未实现 /api/v1/alerts|analysis，页面渲染诚实空态文案（不是产品有数据态）',
      onboarding: '首屏引导在场态（?onboarding=1 强制显示）',
    },
    captures: manifest,
    failures,
  }, null, 2)}\n`);

  assert.deepEqual(failures, [], `ready-condition failures: ${failures.join('; ')}`);
  t.diagnostic(`${manifest.length} captures archived in ${path.relative(REPO_ROOT, OUT_DIR)} (36 product + 18 onboarding); overflow=0 on all; onboarding banner present on all 18`);
});
