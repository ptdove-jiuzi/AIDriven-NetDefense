#!/usr/bin/env node
/**
 * accept-1-daemon.mjs —— 验收 1：daemon 能被子进程拉起。
 *
 * 两段：
 *   A. 用文档里写死的那条命令（`--data-dir --rules --mock`）起 daemon，打印
 *      /healthz 与 /readyz 的原始 JSON。
 *   B. 演示「端口冲突 → 换端口 → 写回配置」：先占住 daemon 想要的端口，再启动
 *      桌面壳，断言它换到了别的端口并把新端口写回 settings.json。
 *
 * 用法：node scripts/desktop/accept-1-daemon.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import {
  REPO, TEMP, banner, check, cleanupTree, exePath, finish, httpJson, readJson,
  shellPost, spawnShell, waitFor, waitHttp, noProxy,
} from './lib/helpers.mjs';

const DATA = join(TEMP, 'aidn-acc1', 'data');
const BASE = join(TEMP, 'aidn-acc1');
const RULES_SOURCE = join(REPO, 'apps', 'desktop', 'assets', 'rules', 'builtin-rules.json');

let passed = 0;
let failed = 0;
function verify(name, ok, detail) {
  const score = check(name, ok, detail);
  if (score) passed += 1; else failed += 1;
}

function prepare() {
  rmSync(join(TEMP, 'aidn-acc1'), { recursive: true, force: true });
  mkdirSync(join(DATA, 'rules'), { recursive: true });
  writeFileSync(join(DATA, 'rules', 'builtin-rules.json'), readFileSync(RULES_SOURCE));
}

/** 场景 A：文档里那条命令，原样执行。 */
async function scenarioA() {
  banner('A. `node apps/daemon/bin.js --data-dir … --rules … --mock`');
  const node = 'C:/Program Files/nodejs/node.exe';
  const entry = join(REPO, 'apps', 'daemon', 'bin.js');
  const rules = join(DATA, 'rules', 'builtin-rules.json');
  process.stdout.write(`$ "${node}" apps/daemon/bin.js --data-dir "${DATA}" --rules "${rules}" --mock\n\n`);

  const child = spawn(node, [entry, '--data-dir', DATA, '--rules', rules, '--mock'], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (chunk) => { log += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => { log += chunk.toString('utf8'); });

  try {
    const port = await waitFor(() => {
      const match = /"msg":"daemon ready".*?"port":(\d+)/u.exec(log);
      return match ? Number(match[1]) : null;
    }, { timeout: 25000, label: 'daemon ready 日志行' });

    const health = await httpJson(`http://127.0.0.1:${port}/healthz`);
    const ready = await httpJson(`http://127.0.0.1:${port}/readyz`);
    process.stdout.write(`GET http://127.0.0.1:${port}/healthz → ${health.status}\n${JSON.stringify(health.body)}\n`);
    process.stdout.write(`GET http://127.0.0.1:${port}/readyz  → ${ready.status}\n${JSON.stringify(ready.body)}\n\n`);

    verify('healthz 返回 200', health.status === 200, `status=${health.status}`);
    verify('healthz 含 version 字段', typeof health.body?.version === 'string', health.body?.version);
    verify('readyz 返回 200 且 ready=true', ready.status === 200 && ready.body?.ready === true, JSON.stringify(ready.body));
    verify('daemon 实际监听 127.0.0.1', log.includes('"host":"127.0.0.1"'));
  } finally {
    child.kill();
    await delay(500);
  }
}

/** 场景 B：端口被占 → 换端口 → 写回 settings.json。 */
async function scenarioB() {
  banner('B. 端口冲突 → 换端口 → 写回配置');
  const exe = exePath();
  if (!existsSync(exe)) {
    verify('桌面壳 exe 存在', false, exe);
    return;
  }
  // 先占住默认 daemon 端口 17802
  const blocker = net.createServer(() => {});
  await new Promise((res) => blocker.listen(17802, '127.0.0.1', res));
  process.stdout.write('已占用 127.0.0.1:17802（模拟端口冲突）\n');

  const child = spawnShell(exe, ['--open-mode', 'browser', '--port', '17811'], {
    AIDN_BASE_DIR: BASE, AIDN_NO_OPEN: '1',
  });
  try {
    await waitHttp('http://127.0.0.1:17811/shell/api/state', 45000);
    const { body } = await httpJson('http://127.0.0.1:17811/shell/api/state');
    const port = body.daemon.port;
    const settings = readJson(join(BASE, 'data', 'shell', 'settings.json'));
    process.stdout.write(`daemon 实际端口=${port}，settings.json 记录 daemon_port=${settings.daemon_port}\n`);

    verify('daemon 在线', body.daemon.online === true);
    verify('端口已换到 17802 之外', port !== 17802, `port=${port}`);
    verify('新端口已写回 settings.json', settings.daemon_port === port, `${settings.daemon_port} vs ${port}`);
    verify('托盘已注册', body.shell.tray_installed === true);

    await shellPost(17811, '/shell/api/quit');
    await delay(2500);
  } finally {
    blocker.close();
    cleanupTree(child.pid);
  }
}

noProxy();
prepare();
await scenarioA();
await scenarioB();

process.stdout.write(`\n期望输出：/healthz {"status":"degraded","version":"0.1.0-m5"}；/readyz {"ready":true,...}；\n`);
process.stdout.write('场景 B 打印的 daemon 端口不是 17802，且 settings.json 里 daemon_port 等于该端口。\n');
finish(passed, failed);
