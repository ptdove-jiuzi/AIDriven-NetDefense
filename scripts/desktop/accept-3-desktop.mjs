#!/usr/bin/env node
/**
 * accept-3-desktop.mjs —— 验收 3：托盘、窗口、关窗留驻、退出清场。
 *
 * 会真的弹出一个窗口（这是被测对象），随后按顺序验证：
 *   1. exe 启动后本地界面端口可达、托盘已注册、窗口已创建并可见；
 *   2. 「关窗口」走的是与用户点 X 相同的函数（`closing` 事件处理），断言：
 *      窗口变为隐藏、**进程仍在**、daemon 仍在；
 *   3. 再次显示窗口 → 可见；
 *   4. 「退出」走的是与托盘菜单「退出」相同的函数，断言：exe 进程消失、
 *      daemon 子进程消失。
 *
 * 局限（如实写进 status）：托盘图标的「鼠标点击」本身没有被脚本模拟，
 * 脚本调用的是菜单项绑定的同一个回调；点击 → 回调这一跳需要人工确认。
 *
 * 用法：node scripts/desktop/accept-3-desktop.mjs
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  TEMP, banner, check, cleanupTree, exePath, finish, httpJson, noProxy, pidAlive,
  shellPost, spawnShell, waitFor, waitHttp,
} from './lib/helpers.mjs';

const BASE = join(TEMP, 'aidn-acc3');
const UI_PORT = 17831;

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

banner(`启动内嵌窗口模式：${exe} --port ${UI_PORT}`);
const child = spawnShell(exe, ['--port', String(UI_PORT)], { AIDN_BASE_DIR: BASE });
let shellPid = child.pid;

try {
  await waitHttp(`http://127.0.0.1:${UI_PORT}/shell/api/state`, 60000);
  // 等窗口确实被创建（pywebview 在 start 之后才创建原生窗口）
  const state = await waitFor(async () => {
    const { body } = await httpJson(`http://127.0.0.1:${UI_PORT}/shell/api/state`, { timeout: 3000 });
    return body?.shell?.window_available === true ? body : null;
  }, { timeout: 30000, label: '窗口创建' });
  shellPid = state.shell.pid;

  const daemonPid = state.daemon.pid;
  process.stdout.write(`壳 pid=${shellPid}  daemon pid=${daemonPid}  端口=${state.daemon.port}\n`);

  verify('窗口已创建', state.shell.window_available === true);
  verify('窗口初始可见', state.shell.window_visible === true);
  verify('托盘已注册', state.shell.tray_installed === true);
  verify('daemon 在线', state.daemon.online === true);
  verify('daemon 子进程存在', pidAlive(daemonPid), `pid=${daemonPid}`);

  banner('关闭窗口（与用户点 X 同一函数）');
  const closed = await shellPost(UI_PORT, '/shell/api/window/close');
  await delay(800);
  verify('关闭接口返回 hidden', closed.body?.window === 'hidden', JSON.stringify(closed.body?.window));
  verify('壳进程仍在', pidAlive(shellPid), `pid=${shellPid}`);
  verify('daemon 仍在运行', pidAlive(daemonPid), `pid=${daemonPid}`);
  const afterClose = (await httpJson(`http://127.0.0.1:${UI_PORT}/shell/api/state`)).body;
  verify('状态接口仍可访问（界面服务没停）', afterClose.shell.window_visible === false);

  banner('从托盘「打开界面」恢复窗口（调用菜单同一回调）');
  await shellPost(UI_PORT, '/shell/api/window/show');
  await delay(600);
  const shown = (await httpJson(`http://127.0.0.1:${UI_PORT}/shell/api/state`)).body;
  verify('窗口恢复可见', shown.shell.window_visible === true);

  banner('退出（与托盘菜单「退出」同一函数）');
  await shellPost(UI_PORT, '/shell/api/quit');
  await delay(3000);
  const exeGone = !pidAlive(shellPid);
  const daemonGone = await waitFor(() => !pidAlive(daemonPid), { timeout: 15000, interval: 500, label: 'daemon 退出' }).catch(() => false);
  verify('壳进程已退出', exeGone, `pid=${shellPid}`);
  verify('daemon 子进程已消失', daemonGone === true, `pid=${daemonPid}`);
} finally {
  cleanupTree(child.pid);
  cleanupTree(shellPid);
}

process.stdout.write('\n期望输出：全部 [PASS]，且「托盘已注册」为 true —— 托盘图标在测试期间真实出现在通知区。\n');
process.stdout.write('人工确认项：通知区图标右键菜单四项可点、点击「打开界面」真的把窗口叫回前台。\n');
finish(passed, failed);
