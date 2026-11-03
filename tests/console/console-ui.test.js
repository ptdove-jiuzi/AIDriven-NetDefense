/**
 * tests/console/console-ui.test.js — 控制台的静态断言。
 *
 * 这些断言刻意**不依赖浏览器自动化**：app.js 是经典脚本、渲染层返回 HTML 字符串，
 * 因此可以在 node 里用 `vm` 载入并直接调用纯函数与渲染函数。这样做的代价是
 * 不验证真实排版，收益是断言能失败、能定位、能在 CI 里跑。
 *
 * 覆盖三件最容易出错的事：
 *   1. 前端字段白名单与 daemon `query.js` 的投影逐字一致（防止编造后端没有的字段）；
 *   2. 凭据不进 URL、CSRF 头只随非 GET 发送；
 *   3. 空态 / 错误态 / 缺失字段各有确定输出，而不是 undefined 或空白。
 *
 * 运行：node --test tests/console/console-ui.test.js
 *
 * 作者：PT-dove
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CONSOLE_DIR = path.join(REPO, 'apps', 'console');
const FIXTURES = path.join(HERE, 'fixtures');

const HTML = fs.readFileSync(path.join(CONSOLE_DIR, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(CONSOLE_DIR, 'styles.css'), 'utf8');
const JS = fs.readFileSync(path.join(CONSOLE_DIR, 'app.js'), 'utf8');
const QUERY_SOURCE = fs.readFileSync(path.join(REPO, 'apps', 'daemon', 'src', 'api', 'query.js'), 'utf8');

const STATUS_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'status.json'), 'utf8'));
const ALERTS_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'alerts.json'), 'utf8'));
const ANALYSIS_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'analysis.json'), 'utf8'));

/** 载入 app.js 的纯函数层。sandbox 里没有 document，因此不会自动 boot。 */
function loadCore() {
  const sandbox = { URLSearchParams, console };
  vm.createContext(sandbox);
  vm.runInContext(JS, sandbox, { filename: 'apps/console/app.js' });
  return sandbox.NDConsole;
}

const Core = loadCore();

/** vm 里造出的对象属于另一个 realm，deepStrictEqual 会因原型不同而失败。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 从 daemon 源码里抽出投影键，用于和前端白名单对照。 */
function projectKeys(functionName) {
  const pattern = new RegExp(
    `export function ${functionName}\\(row\\)\\s*\\{[\\s\\S]*?return \\{([\\s\\S]*?)\\n {2}\\};`,
    'u',
  );
  const match = pattern.exec(QUERY_SOURCE);
  assert.notEqual(match, null, `query.js 里没有找到 ${functionName}() 的返回对象，正则失效`);
  const body = match[1];
  const keys = [];
  for (const line of body.split('\n')) {
    const found = /^ {4}([a-z][a-z0-9_]*):/u.exec(line);
    if (found !== null) {
      keys.push(found[1]);
    }
  }
  return keys;
}

describe('apps/console/index.html', () => {
  it('不含任何外部依赖：无 CDN、无 module 脚本、无外链字体/样式', () => {
    const external = /(?:src|href)\s*=\s*["'](?:https?:)?\/\//iu.exec(HTML);
    assert.equal(external, null, `发现外部资源：${external?.[0] ?? ''}`);
    assert.equal(/<script[^>]*type\s*=\s*["']module["']/iu.test(HTML), false, '不允许 type=module（file:// 下会被 CORS 拦）');
    assert.equal(/@import/iu.test(CSS), false, 'styles.css 不允许 @import');
    assert.equal(/url\(\s*['"]?https?:/iu.test(CSS), false, 'styles.css 不允许远程 url()');
    // 会触发网络请求的属性逐个检查；正文里的 http://127.0.0.1 是文档示例，不是资源引用。
    const loaded = [...HTML.matchAll(/\b(?:src|href|srcset|poster|action)\s*=\s*"([^"]*)"/gu)]
      .map((match) => match[1]);
    assert.ok(loaded.length > 0, '没有找到任何资源引用，正则可能失效');
    for (const value of loaded) {
      assert.equal(/^(?:https?:)?\/\//iu.test(value), false, `资源引用指向外部：${value}`);
      assert.equal(/^data:/iu.test(value), false, `不允许内联 data: 资源：${value.slice(0, 24)}`);
    }
  });

  it('四个视图与关键锚点都存在，脚本与样式各只有一份本地引用', () => {
    for (const view of ['overview', 'alerts', 'analysis', 'settings']) {
      assert.match(HTML, new RegExp(`id="view-${view}"`, 'u'), `缺少视图 ${view}`);
      assert.match(HTML, new RegExp(`data-view="${view}"`, 'u'), `缺少 data-view ${view}`);
    }
    const requiredIds = [
      'stat-lifecycle', 'stat-version', 'stat-uptime', 'stat-alerts',
      'alerts-body', 'alerts-state', 'alerts-prev', 'alerts-next', 'alerts-limit',
      'ana-body', 'ana-state-box',
      'set-mode-embedded', 'set-mode-browser', 'set-autostart', 'set-port', 'set-token',
      'drawer', 'drawer-body', 'file-warning',
    ];
    for (const id of requiredIds) {
      assert.match(HTML, new RegExp(`id="${id}"`, 'u'), `缺少 #${id}`);
    }
    const scripts = HTML.match(/<script\b[^>]*src="([^"]+)"/gu) ?? [];
    const styles = HTML.match(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gu) ?? [];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], /app\.js/u);
    assert.equal(styles.length, 1);
    assert.match(styles[0], /styles\.css/u);
  });

  it('深色主题是默认值，且等宽字体覆盖 IP/哈希列', () => {
    assert.match(CSS, /color-scheme:\s*dark/u);
    assert.match(CSS, /--bg:\s*#[0-9a-f]{6}/iu);
    assert.match(CSS, /--mono:/u);
    assert.match(CSS, /\.col-id[^{]*\{[^}]*mono/iu, '.col-id 应使用等宽字体');
  });
});

describe('格式化', () => {
  it('formatUptime 只接受有限非负数，其余返回 null', () => {
    assert.equal(Core.formatUptime(0), '00:00:00');
    assert.equal(Core.formatUptime(3725000), '01:02:05');
    assert.equal(Core.formatUptime(90061000), '1d 01:01:01');
    assert.equal(Core.formatUptime(-1), null);
    assert.equal(Core.formatUptime(null), null);
    assert.equal(Core.formatUptime(undefined), null);
    assert.equal(Core.formatUptime(Number.NaN), null);
  });

  it('formatTimeUTC 按 UTC 渲染，解析失败时保留原始字符串', () => {
    assert.equal(Core.formatTimeUTC('2026-11-03T22:14:05.000Z'), '2026-11-03 22:14:05');
    assert.equal(Core.formatTimeUTC('not-a-date'), 'not-a-date');
    assert.equal(Core.formatTimeUTC(null), null);
    assert.equal(Core.formatTimeUTC(''), null);
  });

  it('pick 区分「键不存在」与「键为 null」', () => {
    const nullValue = Core.pick({ a: null }, 'a');
    assert.equal(nullValue.present, true);
    assert.equal(nullValue.value, null);

    const absent = Core.pick({ a: 1 }, 'b');
    assert.equal(absent.present, false);
    assert.equal(absent.value, undefined);

    const noRow = Core.pick(null, 'a');
    assert.equal(noRow.present, false);
  });
});

describe('字段白名单与 daemon 投影一致', () => {
  it('ALERT_FIELDS 与 projectAlert() 的键集合完全相同', () => {
    const fromSource = projectKeys('projectAlert');
    assert.equal(fromSource.length, 12, `从 query.js 抽到 ${fromSource.length} 个键，期望 12`);
    assert.equal(fromSource.includes('evidence_truncated'), true, '抽样自检：应含 evidence_truncated');
    assert.deepEqual([...Core.ALERT_FIELDS].sort(), [...fromSource].sort());
  });

  it('ANALYSIS_FIELDS 与 projectAnalysis() 的键集合完全相同', () => {
    const fromSource = projectKeys('projectAnalysis');
    assert.equal(fromSource.length, 9, `从 query.js 抽到 ${fromSource.length} 个键，期望 9`);
    assert.deepEqual([...Core.ANALYSIS_FIELDS].sort(), [...fromSource].sort());
  });

  it('渲染结果里不出现被契约排除的字段名', () => {
    const forbidden = [
      'event_ids', 'evidence_refs', 'fingerprint', 'canonical_json', 'canonical_digest',
      'summary_json', 'summary_digest', 'idempotency_key', 'owner', 'failure_reason',
      'lease', 'prompt', 'token',
    ];
    const item = {
      ...ALERTS_FIXTURE.alerts[0],
      event_ids: ['SHOULD-NOT-LEAK'],
      fingerprint: 'SHOULD-NOT-LEAK',
      idempotency_key: 'SHOULD-NOT-LEAK',
    };
    const drawer = Core.renderAlertDrawer(item);
    const row = Core.renderAlertRow(item);
    assert.equal(row.includes('SHOULD-NOT-LEAK'), false, '行渲染展开了整行');
    assert.equal(drawer.includes('SHOULD-NOT-LEAK'), false, '抽屉展开了整行');
    for (const key of forbidden) {
      assert.equal(row.includes(key), false, `行渲染泄漏了 ${key}`);
    }
    // 抽屉里会有一句「本抽屉不含 event_ids …」的说明，因此只检查真正作为字段渲染的键。
    const renderedKeys = [...drawer.matchAll(/field-key">([A-Za-z_]+)</gu)].map((match) => match[1]);
    assert.ok(renderedKeys.length >= 12, `抽屉只渲染了 ${renderedKeys.length} 个字段`);
    for (const key of renderedKeys) {
      assert.equal(Core.ALERT_FIELDS.includes(key), true, `抽屉渲染了白名单外的字段 ${key}`);
    }

    const analysis = {
      ...ANALYSIS_FIXTURE.analyses[0],
      event_ids: ['SHOULD-NOT-LEAK'],
      failure_reason: 'SHOULD-NOT-LEAK',
    };
    const analysisHtml = Core.renderAnalysisRow(analysis) + Core.renderAnalysisDrawer(analysis);
    assert.equal(analysisHtml.includes('SHOULD-NOT-LEAK'), false);
    const analysisKeys = [...Core.renderAnalysisDrawer(analysis).matchAll(/field-key">([A-Za-z_]+)</gu)]
      .map((match) => match[1]);
    for (const key of analysisKeys) {
      assert.equal(Core.ANALYSIS_FIELDS.includes(key), true, `抽屉渲染了白名单外的字段 ${key}`);
    }
  });

  it('缺失字段渲染为「未提供」，不产生 undefined / NaN / [object Object]', () => {
    const sparse = { alert_id: 'only-id' };
    const row = Core.renderAlertRow(sparse);
    assert.match(row, /class="missing"[^>]*>未提供</u);
    assert.equal(/undefined/u.test(row), false);
    assert.equal(/NaN/u.test(row), false);
    assert.equal(/\[object Object\]/u.test(row), false);

    const drawer = Core.renderAlertDrawer(sparse);
    assert.match(drawer, /未提供/u);
    assert.equal(/undefined/u.test(drawer), false);
  });

  it('渲染对 HTML 做转义，不把数据当标记', () => {
    const evil = {
      alert_id: '<img src=x onerror=alert(1)>',
      rule_id: '</td><script>alert(1)</script>',
      rule_version: '1.0.0',
      severity: 'high',
      status: 'new',
      count: 1,
      first_seen: '2026-11-04T00:00:00.000Z',
      last_seen: '2026-11-04T00:00:00.000Z',
      window_start: '2026-11-04T00:00:00.000Z',
      window_end: '2026-11-04T00:00:00.000Z',
      evidence_count: 1,
      evidence_truncated: false,
    };
    const html = Core.renderAlertRow(evil);
    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /&lt;img src=x/u);
  });
});

describe('查询串与凭据', () => {
  it('buildQuery 只接受 limit / cursor，其余直接抛错', () => {
    assert.equal(Core.buildQuery({ limit: 25 }), '?limit=25');
    assert.equal(Core.buildQuery({}), '');
    assert.equal(Core.buildQuery({ limit: 10, cursor: 'abc' }), '?limit=10&cursor=abc');
    assert.throws(() => Core.buildQuery({ severity: 'high' }), /not allowed/u);
    assert.throws(() => Core.buildQuery({ limit: 10, offset: 200 }), /not allowed/u);
  });

  it('token 不进入 URL；地址只拼 base + path + 查询串', () => {
    const url = Core.buildRequestUrl('http://127.0.0.1:8787', '/api/v1/alerts', { limit: 50 });
    assert.equal(url, 'http://127.0.0.1:8787/api/v1/alerts?limit=50');
    assert.equal(url.includes('token'), false);
    assert.equal(Core.buildRequestUrl('', '/api/v1/status', {}), '/api/v1/status');
  });

  it('Base 只接受字面回环地址', () => {
    assert.equal(Core.isLoopbackBase('http://127.0.0.1:8787'), true);
    assert.equal(Core.isLoopbackBase('http://[::1]:8787/'), true);
    assert.equal(Core.isLoopbackBase('http://localhost:8787'), false);
    assert.equal(Core.isLoopbackBase('https://127.0.0.1:8787'), false);
    assert.equal(Core.isLoopbackBase('http://127.0.0.1:8787/x'), false);
  });

  it('请求头：同源代理不带凭据，直连只加 Bearer，非 GET 才加 CSRF', () => {
    assert.deepEqual(plain(Core.buildHeaders({ method: 'GET', mode: 'proxy', token: 'secret-token' })), {});

    const directGet = plain(Core.buildHeaders({ method: 'GET', mode: 'direct', token: 'secret-token', csrf: 'csrf-1' }));
    assert.deepEqual(directGet, { authorization: 'Bearer secret-token' });

    const directPost = plain(Core.buildHeaders({ method: 'POST', mode: 'direct', token: 'secret-token', csrf: 'csrf-1' }));
    assert.deepEqual(directPost, { authorization: 'Bearer secret-token', 'x-aegis-csrf': 'csrf-1' });

    const noToken = plain(Core.buildHeaders({ method: 'GET', mode: 'direct', token: '' }));
    assert.deepEqual(noToken, {});
  });
});

describe('错误映射', () => {
  it('连不上就是「服务未启动」，不是空列表也不是无限加载', () => {
    const result = Core.classifyError({ network: true });
    assert.equal(result.kind, 'offline');
    assert.equal(result.title, '服务未启动');
  });

  it('file:// 直接给出可执行的替代方案', () => {
    const result = Core.classifyError({ protocol: 'file:' });
    assert.equal(result.kind, 'file');
    assert.match(result.hint, /http\.server/u);
  });

  it('401 / 429 / 503 / 400 各有独立语义与错误码', () => {
    const auth = Core.classifyError({ status: 401, code: 'AUTH_REQUIRED' });
    assert.equal(auth.kind, 'auth');
    assert.equal(auth.code, 'AUTH_REQUIRED');

    const limited = Core.classifyError({ status: 429, code: 'AUTH_RATE_LIMITED', retryAfter: '60' });
    assert.equal(limited.kind, 'rate');
    assert.match(limited.detail, /60/u);

    const store = Core.classifyError({ status: 503, code: 'STORE_UNAVAILABLE' });
    assert.equal(store.kind, 'store');
    assert.match(store.detail, /不等于|不要/u, '503 必须说明「不是没有数据」');

    const bad = Core.classifyError({ status: 400, code: 'QUERY_INVALID' });
    assert.equal(bad.kind, 'bad-request');
    assert.equal(bad.code, 'QUERY_INVALID');
  });
});

describe('分页与筛选', () => {
  it('cursor 栈：前进压栈、后退出栈、无 next_cursor 时不前进', () => {
    let pager = Core.createPager(50);
    assert.equal(Core.pagerCursor(pager), null);
    assert.equal(Core.pagerCanNext(pager, { has_more: false, next_cursor: null }), false);

    pager = Core.pagerNext(pager, { has_more: true, next_cursor: 'C1' });
    assert.equal(Core.pagerCursor(pager), 'C1');
    assert.equal(Core.pagerCanPrev(pager), true);

    pager = Core.pagerNext(pager, { has_more: true, next_cursor: 'C2' });
    assert.equal(Core.pagerCursor(pager), 'C2');
    assert.equal(pager.stack.length, 3);

    pager = Core.pagerPrev(pager);
    assert.equal(Core.pagerCursor(pager), 'C1');
    pager = Core.pagerPrev(pager);
    assert.equal(Core.pagerCursor(pager), null);
    assert.equal(Core.pagerCanPrev(pager), false);

    const frozen = Core.pagerNext(Core.createPager(10), { has_more: true, next_cursor: null });
    assert.equal(frozen.index, 0, 'has_more 但没有 cursor 时不得产生空页');
  });

  it('筛选只作用于传入的那一页数据', () => {
    const items = ALERTS_FIXTURE.alerts;
    assert.equal(Core.filterItems(items, {}).length, 3);
    assert.equal(Core.filterItems(items, { severity: 'critical' }).length, 1);
    assert.equal(Core.filterItems(items, { status: 'new' }).length, 1);
    assert.equal(Core.filterItems(items, { query: 'auth.failed' }).length, 1);
    assert.equal(Core.filterItems(items, { query: 'zzz' }).length, 0);
    assert.equal(Core.filterItems(items, { severity: 'low' }).length, 0);

    const analyses = ANALYSIS_FIXTURE.analyses;
    assert.equal(Core.filterItems(analyses, { state: 'queued' }).length, 1);
    assert.equal(Core.filterItems(analyses, { report: 'true' }).length, 1);
    assert.equal(Core.filterItems(analyses, { report: 'false' }).length, 2);
  });

  it('pagerLabel 如实报告 has_more / order / byte_limited', () => {
    const pager = { limit: 50, stack: [null], index: 0, page: ALERTS_FIXTURE.page };
    const label = Core.pagerLabel(pager);
    assert.match(label, /第 1 页/u);
    assert.match(label, /has_more=true/u);
    assert.match(label, /order=last_seen_desc/u);
    assert.equal(label.includes('byte_limited'), false);

    const limitedLabel = Core.pagerLabel({ ...pager, page: { ...ALERTS_FIXTURE.page, byte_limited: true } });
    assert.match(limitedLabel, /byte_limited=true/u);
  });
});

describe('概览派生值', () => {
  it('版本、时长、告警计数与采集源统计都来自响应字段', () => {
    const summary = Core.summarizeStatus(STATUS_FIXTURE);
    assert.equal(summary.version, '0.0.0');
    assert.equal(summary.lifecycle, 'running');
    assert.equal(Core.formatUptime(summary.uptimeMs), '01:02:05');
    assert.equal(summary.alertWrites, 42);
    assert.equal(summary.reasons.length, 2);
    assert.equal(summary.sources.length, 2);
    assert.equal(summary.degradedSources, 1);
    assert.equal(summary.staleSources, 1);
    assert.equal(summary.healthReady, true);
  });

  it('csrf_token 不会出现在任何渲染输出里', () => {
    const csrf = STATUS_FIXTURE.csrf_token;
    const outputs = [
      Core.renderAlertRow(ALERTS_FIXTURE.alerts[0]),
      Core.renderAlertDrawer(ALERTS_FIXTURE.alerts[0]),
      Core.renderAnalysisRow(ANALYSIS_FIXTURE.analyses[0]),
      Core.renderAnalysisDrawer(ANALYSIS_FIXTURE.analyses[0]),
      Core.renderReasons(STATUS_FIXTURE.health.reasons),
      Core.renderSourceList(STATUS_FIXTURE.scheduler.sources),
    ];
    for (const output of outputs) {
      assert.equal(output.includes(csrf), false, '控制台把 CSRF 证明渲染进 DOM 了');
    }
  });
});

describe('mock 服务（同源代理形态）', () => {
  const port = 18900 + Math.floor(Math.random() * 400);
  let child = null;
  let base = '';

  before(async () => {
    child = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs'), String(port)], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        const response = await fetch(`${base}/api/v1/status`);
        if (response.ok) {
          break;
        }
      } catch (error) {
        // 还没起来，继续等。
      }
      if (Date.now() > deadline) {
        throw new Error('mock-server 没有在 8s 内起来');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  after(() => {
    if (child !== null) {
      child.kill();
    }
  });

  it('静态页与三个 JSON 都能取到，且 page 键与契约一致', async () => {
    const html = await fetch(`${base}/`).then((response) => response.text());
    assert.match(html, /网域智防/u);

    const alerts = await fetch(`${base}/api/v1/alerts?limit=2`).then((response) => response.json());
    assert.deepEqual(Object.keys(alerts).sort(), ['alerts', 'page']);
    assert.deepEqual(Object.keys(alerts.page).sort(), [...Core.PAGE_FIELDS].sort());
    assert.equal(alerts.page.limit, 2);
    assert.equal(alerts.alerts.length, 2);
    for (const item of alerts.alerts) {
      for (const key of Object.keys(item)) {
        assert.equal(Core.ALERT_FIELDS.includes(key), true, `响应里出现了白名单外的键 ${key}`);
      }
    }

    const analyses = await fetch(`${base}/api/v1/analysis`).then((response) => response.json());
    assert.deepEqual(Object.keys(analyses).sort(), ['analyses', 'page']);
    for (const item of analyses.analyses) {
      for (const key of Object.keys(item)) {
        assert.equal(Core.ANALYSIS_FIELDS.includes(key), true, `响应里出现了白名单外的键 ${key}`);
      }
    }

    const status = await fetch(`${base}/api/v1/status`).then((response) => response.json());
    assert.equal(status.schema_version, '1.0');
    assert.equal(typeof status.uptime_ms, 'number');
    assert.equal(Array.isArray(status.health.reasons), true);
  });

  it('未知查询参数被拒为 400 QUERY_INVALID（服务端不忽略筛选条件）', async () => {
    const response = await fetch(`${base}/api/v1/alerts?severity=high`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'QUERY_INVALID');
    assert.equal(body.error.details.parameter, 'severity');
  });

  it('第二页返回空数组 + has_more=false，不会谎称还有数据', async () => {
    const page2 = await fetch(`${base}/api/v1/alerts?limit=2&cursor=CURSOR-X`).then((response) => response.json());
    assert.equal(page2.alerts.length, 0);
    assert.equal(page2.page.has_more, false);
    assert.equal(page2.page.next_cursor, null);
    assert.equal(page2.page.returned, 0);
  });
});
