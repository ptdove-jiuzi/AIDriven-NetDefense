#!/usr/bin/env node
/**
 * webui-check.mjs —— 用无头 Edge 的 CDP 接口验证「页面真的渲染出了数据」。
 *
 * 为什么需要它：`curl` 只能证明服务器返回了 HTML，不能证明脚本跑起来、fetch
 * 拿到 daemon 数据、状态卡被填上。这里等页面稳定后直接读 DOM 文本，读不到就失败。
 *
 * 用法：
 *   node scripts/desktop/webui-check.mjs --url http://127.0.0.1:17801/ [--json out.json]
 *
 * 退出码：0 = 四项检查全过；1 = 有检查未通过（打印实际值）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function cdpTargets(port, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 端口还没起来，继续等
    }
    await delay(250);
  }
  throw new Error('CDP 端点没有就绪');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`CDP 超时：${method}`));
            }, 15000);
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id && pending.has(payload.id)) {
        const entry = pending.get(payload.id);
        pending.delete(payload.id);
        if (payload.error) entry.rej(new Error(payload.error.message));
        else entry.res(payload.result);
      }
    });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });
}

async function main() {
  const url = arg('--url', 'http://127.0.0.1:17801/');
  const port = Number(arg('--cdp-port', '9377'));
  const edge = findEdge();
  if (!edge) throw new Error('找不到 msedge.exe');

  const child = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    '--user-data-dir=' + `${process.env.TEMP || '/tmp'}/aidn-cdp-profile`,
    'about:blank',
  ], { stdio: 'ignore' });

  let client;
  try {
    const target = await cdpTargets(port);
    client = await connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });

    // 等状态卡出现真实版本号（最多 12 秒）。轮询而不是死等固定时间，避免机器慢时误判。
    const startedAt = Date.now();
    let snapshot = null;
    while (Date.now() - startedAt < 12000) {
      await delay(400);
      const result = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const text = (id) => (document.getElementById(id)?.textContent ?? '').trim();
          return JSON.stringify({
            label: text('st-label'),
            version: text('st-version'),
            uptime: text('st-uptime'),
            mode: text('st-mode'),
            port: text('st-port'),
            conn: text('conn-text'),
            health: text('st-health'),
            stamp: text('stamp'),
            alertsEmpty: document.getElementById('alerts-empty')?.hidden === false,
            title: document.title,
          });
        })()`,
        returnByValue: true,
      });
      snapshot = JSON.parse(result.result.value);
      if (snapshot.version && snapshot.version !== '—') break;
    }

    const checks = [
      ['页面标题', snapshot.title === 'AIDriven NetDefense · 网域智防'],
      ['状态卡显示在线', snapshot.label.includes('在线')],
      ['版本来自 daemon', /^[0-9]+\.[0-9]+\.[0-9]+/.test(snapshot.version)],
      ['启动时长已计算', snapshot.uptime !== '—' && snapshot.uptime.length > 0],
      ['运行模式非空', snapshot.mode !== '—'],
      ['daemon 端口可见', /^\d+$/.test(snapshot.port)],
      ['侧栏连接状态', snapshot.conn.includes('在线')],
      ['刷新时间戳', snapshot.stamp.startsWith('更新于')],
    ];

    const failures = checks.filter(([, ok]) => !ok);
    const report = {
      url,
      checked_at: new Date().toISOString(),
      snapshot,
      checks: checks.map(([name, ok]) => ({ name, ok })),
      passed: checks.length - failures.length,
      failed: failures.length,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failures.length > 0) {
      process.stderr.write(`\n[webui-check] ${failures.length} 项未通过：${failures.map(([n]) => n).join('、')}\n`);
      process.exitCode = 1;
    }
  } finally {
    try {
      client?.close();
    } catch {
      // 关不掉也不影响结论
    }
    child.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`[webui-check] 失败：${error.message}\n`);
  process.exit(1);
});
