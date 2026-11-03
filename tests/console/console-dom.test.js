/**
 * tests/console/console-dom.test.js — 跑一次真实 boot()，断言页面最终写出的内容。
 *
 * 这一层补的是纯函数测不到的部分：id 拼错、paint 顺序、事件绑定、三态切换。
 * 用 tests/console/dom-harness.mjs 的假 DOM，不依赖浏览器自动化。
 *
 * 运行：node --test tests/console/console-dom.test.js
 *
 * 作者：PT-dove
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createHarness } from './dom-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const STATUS = read('status.json');
const ALERTS = read('alerts.json');
const ANALYSES = read('analysis.json');

describe('首屏：概览渲染', () => {
  it('版本 / 启动时长 / 告警计数 / 采集源都从响应落到 DOM', async () => {
    const harness = createHarness({ status: STATUS });
    await harness.flush();

    assert.equal(harness.get('stat-version').textContent, '0.0.0');
    assert.equal(harness.get('stat-uptime').textContent, '01:02:05');
    assert.equal(harness.get('stat-alerts').textContent, '42');
    assert.equal(harness.get('stat-reasons').textContent, '2');
    assert.equal(harness.get('stat-sources').textContent, '2');
    assert.match(harness.get('stat-sources-sub').textContent, /1 降级 · 1 陈旧/u);
    assert.equal(harness.get('stat-lifecycle').textContent, 'running');

    assert.match(harness.get('side-version').textContent, /0\.0\.0/u);
    assert.equal(harness.get('conn-text').textContent, '服务降级');
    assert.equal(harness.get('conn-pill').dataset.tone, 'warn');

    assert.match(harness.get('ov-reasons').innerHTML, /sources:degraded:1/u);
    assert.match(harness.get('ov-sources').innerHTML, /win-proc/u);
    assert.match(harness.get('ov-counters').innerHTML, /alerts_written/u);
    assert.match(harness.get('ov-runtime').innerHTML, /sqlite/u);
  });

  it('启动时长缺失时写「未提供」，不写 00:00:00 冒充', async () => {
    const status = { ...STATUS };
    delete status.uptime_ms;
    const harness = createHarness({ status });
    await harness.flush();
    assert.equal(harness.get('stat-uptime').textContent, '未提供');
  });
});

describe('离线与错误态', () => {
  it('daemon 不在时显示「服务未启动」，而不是一直转圈', async () => {
    const harness = createHarness({ failNetwork: true });
    await harness.flush();

    assert.equal(harness.get('conn-text').textContent, '服务未启动');
    assert.equal(harness.get('stat-version').textContent, '服务未启动');
    assert.match(harness.get('ov-reasons').innerHTML, /服务未启动/u);
    assert.match(harness.get('ov-reasons').innerHTML, /data-action="retry"/u);
    assert.equal(harness.get('stat-uptime').textContent, '服务未启动');
  });

  it('401 时进入认证态，并给出连接设置的入口', async () => {
    const harness = createHarness({ failStatus: 401 });
    await harness.flush();

    assert.equal(harness.get('conn-text').textContent, '读取失败');
    assert.match(harness.get('ov-reasons').innerHTML, /需要认证/u);
    assert.match(harness.get('ov-reasons').innerHTML, /连接设置/u);
  });

  it('静态服务器没转发 /api/v1 时说「没有 API 代理」，而不是谎报服务正常', async () => {
    const harness = createHarness({ failHtml: true });
    await harness.flush();

    assert.equal(harness.get('conn-text').textContent, '读取失败');
    assert.match(harness.get('ov-reasons').innerHTML, /没有 API 代理/u);
    assert.match(harness.get('ov-reasons').innerHTML, /没有转发/u);
  });
});

describe('告警页', () => {
  it('切到告警页会请求 /api/v1/alerts?limit=50 并渲染三行', async () => {
    const harness = createHarness({ status: STATUS, alerts: ALERTS });
    await harness.flush();
    await harness.go('#/alerts');

    const alertRequest = harness.requests.find((url) => url.includes('/api/v1/alerts'));
    assert.equal(alertRequest, '/api/v1/alerts?limit=50');

    const rows = harness.get('alerts-body').innerHTML;
    assert.equal((rows.match(/<tr /gu) ?? []).length, 3);
    assert.match(rows, /1f0a4c2e/u);
    assert.match(rows, /critical/u);
    assert.match(rows, /截断/u, 'evidence_truncated=true 应有标记');

    assert.match(harness.get('alerts-pageinfo').textContent, /has_more=true/u);
    assert.equal(harness.get('alerts-next').disabled, false);
    assert.equal(harness.get('alerts-prev').disabled, true);
    assert.equal(harness.get('alerts-state').hidden, true);
  });

  it('点行打开抽屉，字段齐全时不出现「未提供」', async () => {
    const harness = createHarness({ status: STATUS, alerts: ALERTS });
    await harness.flush();
    await harness.go('#/alerts');

    const row = { dataset: { kind: 'alert', id: ALERTS.alerts[0].alert_id }, classList: { add() {}, remove() {} } };
    harness.get('alerts-body').emit('click', { target: { closest: () => row } });

    assert.equal(harness.get('drawer').hidden, false);
    const body = harness.get('drawer-body').innerHTML;
    assert.match(body, new RegExp(ALERTS.alerts[0].alert_id, 'u'));
    assert.match(body, /window_end/u);
    assert.equal(body.includes('class="missing"'), false, '完整条目不应出现「未提供」');
    assert.match(body, /本抽屉只展示列表接口的白名单字段/u);
  });

  it('空页显示空态文案，而不是空白表格', async () => {
    const empty = { alerts: [], page: { limit: 50, returned: 0, has_more: false, next_cursor: null, order: 'last_seen_desc', byte_limited: false } };
    const harness = createHarness({ status: STATUS, alerts: empty });
    await harness.flush();
    await harness.go('#/alerts');

    assert.equal(harness.get('alerts-state').hidden, false);
    assert.equal(harness.get('alerts-tablewrap').hidden, true);
    assert.match(harness.get('alerts-state').innerHTML, /没有告警/u);
    assert.match(harness.get('alerts-state').innerHTML, /不是「读不到」/u);
  });

  it('筛选把整页滤空时，区分「没有匹配」与「没有数据」', async () => {
    const harness = createHarness({ status: STATUS, alerts: ALERTS });
    await harness.flush();
    await harness.go('#/alerts');

    const select = harness.get('alerts-sev');
    select.value = 'low'; // fixture 里没有 low
    select.emit('change', {});

    assert.match(harness.get('alerts-state').innerHTML, /本页没有匹配项/u);
  });
});

describe('分页与设置', () => {
  it('下一页把 cursor 发出，上一页回到不带 cursor 的首页', async () => {
    const harness = createHarness({ status: STATUS, alerts: ALERTS });
    await harness.flush();
    await harness.go('#/alerts');

    harness.get('alerts-next').emit('click', {});
    await harness.flush();
    const withCursor = harness.requests.filter((url) => url.includes('cursor='));
    assert.equal(withCursor.length, 1);
    assert.match(withCursor[0], /cursor=RklYVFVSRS1DVVJTT1ItUEFHRTItTk9ULUEtUkVBTC1NQUM/u);

    harness.get('alerts-prev').emit('click', {});
    await harness.flush();
    const last = harness.requests[harness.requests.length - 1];
    assert.equal(last.includes('cursor='), false, '回到第一页不应继续带 cursor');
  });

  it('设置页显示来源端口，并把「未接线」写清楚', async () => {
    const harness = createHarness({ status: STATUS });
    await harness.flush();
    await harness.go('#/settings');

    assert.equal(harness.get('set-port').textContent, '8788');
    assert.match(harness.get('set-port-note').textContent, /status 响应不含 api\.port/u);
    assert.equal(harness.get('set-autostart-text').textContent, '关闭');
    assert.equal(harness.get('set-autostart').checked, false);
    assert.equal(harness.get('set-mode-embedded').checked, true);
  });

  it('直连模式未填地址时给出可执行的错误，不静默失败', async () => {
    const harness = createHarness({ status: STATUS });
    await harness.flush();
    await harness.go('#/settings');

    const direct = harness.get('set-conn-direct');
    const baseInput = harness.get('set-base');
    baseInput.value = 'http://localhost:8787'; // 故意不合法：daemon 只接受字面回环
    baseInput.emit('change', {});
    direct.checked = true;
    direct.emit('change', {});
    await harness.flush();

    assert.match(harness.get('ov-reasons').innerHTML, /地址不合法/u);
    assert.match(harness.get('ov-reasons').innerHTML, /127\.0\.0\.1/u);
  });
});
