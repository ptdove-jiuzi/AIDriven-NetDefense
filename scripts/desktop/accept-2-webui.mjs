#!/usr/bin/env node
/**
 * accept-2-webui.mjs —— 验收 2：WebUI 能打开，且数据来自 daemon。
 *
 * 做法：起 exe（浏览器模式，避免弹窗），等本地界面端口就绪，然后用无头 Edge 的
 * CDP 直接读渲染后的 DOM 文本。全是真实数据链路：
 *   页面 → 壳的本地服务器 → 注入 bearer → daemon /api/v1/*
 *
 * 交叉验证：把页面显示的版本与「直接问 daemon」得到的版本比对，不同即失败——
 * 这样「页面写死了一个版本号」不可能蒙混过去。
 *
 * 用法：node scripts/desktop/accept-2-webui.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  REPO, TEMP, banner, check, cleanupTree, exePath, finish, httpJson, noProxy,
  shellPost, spawnShell, waitHttp,
} from './lib/helpers.mjs';

const BASE = join(TEMP, 'aidn-acc2');
const UI_PORT = 17821;
const NODE = 'C:/Program Files/nodejs/node.exe';

let passed = 0;
let failed = 0;
function verify(name, ok, detail) {
  const score = check(name, ok, detail);
  if (score) passed += 1; else failed += 1;
}

noProxy();
rmSync(BASE, { recursive: true, force: true });

const exe = exePath();
if (!existsSync(exe)) {
  process.stderr.write(`[FAIL] 找不到 exe：${exe}\n`);
  process.exit(1);
}

banner(`启动桌面壳：${exe} --open-mode browser --port ${UI_PORT}`);
const child = spawnShell(exe, ['--open-mode', 'browser', '--port', String(UI_PORT)], {
  AIDN_BASE_DIR: BASE, AIDN_NO_OPEN: '1',
});

try {
  await waitHttp(`http://127.0.0.1:${UI_PORT}/shell/api/state`, 60000);
  const state = (await httpJson(`http://127.0.0.1:${UI_PORT}/shell/api/state`)).body;
  process.stdout.write(`daemon 在线=${state.daemon.online} 端口=${state.daemon.port} 托盘=${state.shell.tray_installed}\n`);

  verify('daemon 已由壳拉起', state.daemon.online === true);
  verify('托盘图标已注册', state.shell.tray_installed === true);

  // 同源代理：页面拿到的 /api/v1/* 必须与 daemon 自己回答的一致
  const direct = (await httpJson(`http://127.0.0.1:${state.daemon.port}/api/v1/status`, {
    headers: { authorization: `Bearer ${readFileSync(join(BASE, 'data', 'secrets', 'api-token'), 'utf8').trim()}` },
  }));
  const proxied = (await httpJson(`http://127.0.0.1:${UI_PORT}/api/v1/status`));
  verify('代理 /api/v1/status 返回 200', proxied.status === 200, `status=${proxied.status}`);
  verify('代理未泄漏 token（响应体无 authorization）', !JSON.stringify(proxied.body).includes('Bearer'));
  verify('代理版本与 daemon 直连一致',
    direct.body?.version === proxied.body?.version,
    `${direct.body?.version} vs ${proxied.body?.version}`);

  const alerts = await httpJson(`http://127.0.0.1:${UI_PORT}/api/v1/alerts`);
  const analyses = await httpJson(`http://127.0.0.1:${UI_PORT}/api/v1/analysis`);
  verify('/api/v1/alerts 结构正确', Array.isArray(alerts.body?.alerts) && alerts.body?.page !== undefined,
    JSON.stringify(alerts.body?.page ?? null));
  verify('/api/v1/analysis 结构正确', Array.isArray(analyses.body?.analyses) && analyses.body?.page !== undefined,
    JSON.stringify(analyses.body?.page ?? null));

  banner('无头浏览器读取渲染结果');
  const probe = spawnSync(NODE, [
    join(REPO, 'scripts', 'desktop', 'webui-check.mjs'),
    '--url', `http://127.0.0.1:${UI_PORT}/`,
    '--cdp-port', '9378',
  ], { encoding: 'utf8', timeout: 90000 });
  const stdout = probe.stdout || '';
  let report = null;
  try {
    report = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
  } catch {
    report = null;
  }
  if (report === null) {
    process.stdout.write(stdout);
    process.stderr.write(probe.stderr || '');
    verify('页面 DOM 检查可解析', false);
  } else {
    process.stdout.write(`页面显示：版本=${report.snapshot.version} 时长=${report.snapshot.uptime} 模式=${report.snapshot.mode} 端口=${report.snapshot.port}\n`);
    for (const item of report.checks) verify(`页面检查 · ${item.name}`, item.ok);
    verify('页面版本 == daemon 版本（非假数据）',
      report.snapshot.version === proxied.body?.version,
      `${report.snapshot.version} vs ${proxied.body?.version}`);
  }

  banner('设置页写接口');
  const before = (await httpJson(`http://127.0.0.1:${UI_PORT}/shell/api/state`)).body.shell.open_mode;
  const updated = await shellPost(UI_PORT, '/shell/api/settings', { open_mode: 'browser' });
  verify('POST /shell/api/settings 生效',
    updated.status === 200 && updated.body?.state?.shell?.open_mode === 'browser',
    `before=${before}`);
  const rejected = await httpJson(`http://127.0.0.1:${UI_PORT}/shell/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"open_mode":"browser"}',
  });
  verify('缺少 x-aidn-shell 头被拒（403）', rejected.status === 403, `status=${rejected.status}`);
} finally {
  await shellPost(UI_PORT, '/shell/api/quit').catch(() => {});
  await delay(2500);
  cleanupTree(child.pid);
}

process.stdout.write('\n期望输出：全部 [PASS]，页面显示「daemon 在线」且版本 0.1.0-m5（与 daemon 一致），结果 0 失败。\n');
finish(passed, failed);
