#!/usr/bin/env node
/**
 * accept-4-installer.mjs —— 验收 4：静默安装 / 覆盖升级 / 卸载。
 *
 * 全程在临时目录里做，不碰 %ProgramFiles%、不写真实卸载注册表（/NOREG）：
 *   1. `Setup.cmd /S /DIR=<temp> /NOREG /NOSHORTCUT` → 退出码 0，exe 存在；
 *   2. 启动装好的 exe（独立数据目录）→ 本地界面可达、daemon 在线；退出；
 *   3. 再装一次 → 输出「升级完成」且 install.json 的 upgradedFrom 有值；
 *   4. `Setup.cmd /S /uninstall /DIR=<temp> /NOREG` → 退出码 0，目录被删空。
 *
 * 用法：node scripts/desktop/accept-4-installer.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  REPO, TEMP, banner, check, cleanupTree, finish, httpJson, noProxy, shellPost,
  spawnShell, waitHttp,
} from './lib/helpers.mjs';

const SETUP_DIR = join(REPO, 'dist', 'installer-desktop', '0.0.1-rc.1');
const TARGET = join(TEMP, 'aidn-install-target');
const DATA_BASE = join(TEMP, 'aidn-install-data');
const UI_PORT = 17841;

let passed = 0;
let failed = 0;
function verify(name, ok, detail) {
  const score = check(name, ok, detail);
  if (score) passed += 1; else failed += 1;
}

function runSetup(args) {
  const result = spawnSync('cmd.exe', ['/c', join(SETUP_DIR, 'Setup.cmd'), ...args], {
    encoding: 'utf8',
    timeout: 240000,
    env: { ...process.env, AIDN_SETUP_DEFAULT_DIR: join(TEMP, 'aidn-not-used') },
  });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

function readInstallRecord(root) {
  // PowerShell 的 Set-Content -Encoding UTF8 会带 BOM，JSON.parse 不认。
  const text = readFileSync(join(root, 'install', 'install.json'), 'utf8').replace(/^\uFEFF/u, '');
  return JSON.parse(text);
}

noProxy();
rmSync(TARGET, { recursive: true, force: true });
rmSync(DATA_BASE, { recursive: true, force: true });

if (!existsSync(join(SETUP_DIR, 'Setup.cmd'))) {
  process.stderr.write(`[FAIL] 安装包不存在：${SETUP_DIR}\n`);
  process.exit(1);
}

banner('1. 静默安装到临时目录');
const first = runSetup(['/S', `/DIR=${TARGET}`, '/NOREG', '/NOSHORTCUT']);
process.stdout.write(`${first.out.trim()}\n`);
verify('安装退出码 0', first.code === 0, `code=${first.code}`);
verify('exe 已安装', existsSync(join(TARGET, 'AIDrivenNetDefense.exe')));
verify('daemon 已随包安装', existsSync(join(TARGET, 'daemon', 'apps', 'daemon', 'bin.js')));
verify('node 运行时已随包安装', existsSync(join(TARGET, 'runtime', 'node', 'node.exe')));
verify('install.json 已写入', existsSync(join(TARGET, 'install', 'install.json')));
const record1 = existsSync(join(TARGET, 'install', 'install.json')) ? readInstallRecord(TARGET) : {};
verify('install.json 记录安装路径', record1.installPath === TARGET, record1.installPath);
verify('首次安装 upgradedFrom 为空', record1.upgradedFrom === null || record1.upgradedFrom === undefined,
  String(record1.upgradedFrom));

banner('2. 启动装好的 exe');
const child = spawnShell(join(TARGET, 'AIDrivenNetDefense.exe'), ['--open-mode', 'browser', '--port', String(UI_PORT)], {
  AIDN_BASE_DIR: DATA_BASE, AIDN_NO_OPEN: '1',
});
try {
  await waitHttp(`http://127.0.0.1:${UI_PORT}/shell/api/state`, 60000);
  const state = (await httpJson(`http://127.0.0.1:${UI_PORT}/shell/api/state`)).body;
  verify('装好的 exe 可启动（界面可达）', state?.shell?.version === '0.0.1-rc.1', state?.shell?.version);
  verify('装好的 exe 拉起了 daemon', state?.daemon?.online === true);
  verify('node 来自安装目录', (state?.shell?.node_path || '').startsWith(TARGET), state?.shell?.node_path);
  await shellPost(UI_PORT, '/shell/api/quit');
  await delay(2500);
} finally {
  cleanupTree(child.pid);
}

banner('3. 覆盖升级（第二次安装同一目录）');
const second = runSetup(['/S', `/DIR=${TARGET}`, '/NOREG', '/NOSHORTCUT']);
process.stdout.write(`${second.out.trim()}\n`);
verify('升级退出码 0', second.code === 0, `code=${second.code}`);
// 中文在 GBK 控制台里会被转码成乱码，所以断言取的是与编码无关的部分：
// 版本箭头。文案本身仍是「升级完成：<旧> -> <新>」。
verify('输出包含版本升级箭头（旧 -> 新）', /->\s*0\.0\.1-rc\.1/u.test(second.out));
const record2 = readInstallRecord(TARGET);
verify('install.json 记录 upgradedFrom', Boolean(record2.upgradedFrom), String(record2.upgradedFrom));

banner('4. 静默卸载');
const removal = runSetup(['/S', '/uninstall', `/DIR=${TARGET}`, '/NOREG']);
process.stdout.write(`${removal.out.trim()}\n`);
verify('卸载退出码 0', removal.code === 0, `code=${removal.code}`);
await delay(1500);
const left = existsSync(TARGET) ? readdirSync(TARGET) : [];
verify('安装目录已清空', !existsSync(TARGET) || left.length === 0, JSON.stringify(left));

rmSync(DATA_BASE, { recursive: true, force: true });

process.stdout.write('\n期望输出：四段全 [PASS]；安装段打印「安装完成：0.0.1-rc.1」，升级段打印「升级完成：0.0.1-rc.1 -> 0.0.1-rc.1」。\n');
finish(passed, failed);
