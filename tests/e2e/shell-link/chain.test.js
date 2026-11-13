/**
 * chain.test.js — 「托盘打开界面」这条链路到底把哪份界面交到浏览器，是可执行的判据
 * （author PT-dove）。
 *
 * 本套件只读别人的文件，不改：它断言的是链路三个关节的事实
 *
 *   1. **目录解析**（apps/desktop/aidn）：`install_root()/console` ← `_pick_web_root()`；
 *   2. **打包输入**（deploy/embedded-runtime）：`--console-source` / profile 的 console 源
 *      怎么决定 stage 进 bundle 的是旧 console 还是 console-next；
 *   3. **服务器能力**（apps/desktop/aidn/server.py vs console-next/serve.mjs）：新界面的写
 *      动作（PUT/POST + x-console-v2）在旧壳里会得到什么响应。
 *
 * 其中目录解析与壳服务器的行为不是复刻：`paths-probe.py` **直接 import 真实模块并调用**，
 * 本套件断言它的 JSON 输出。活体主机（17512）与旧壳差分由 `probe-live.mjs` 证明，网络/浏览器
 * 不可用时该条自动 skip，不会假装通过。
 *
 * 运行：
 *   node --test tests/e2e/shell-link/chain.test.js
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const read = (...segments) => readFileSync(join(REPO_ROOT, ...segments), 'utf8');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sha256Of = (...segments) => sha256(readFileSync(join(REPO_ROOT, ...segments)));

const AIDN = ['apps', 'desktop', 'aidn'];
const BUNDLE_V15 = ['dist', 'bundle', 'win32-x64-v15'];
const BUNDLE_HAS_CONSOLE = existsSync(join(REPO_ROOT, ...BUNDLE_V15, 'console', 'index.html'));

const dataRouteCount = (html) => (html.match(/data-route=/gu) ?? []).length;
const titleOf = (html) => /<title>([\s\S]*?)<\/title>/u.exec(html)?.[1]?.trim() ?? null;

/** Read a top-level function body by its `def name` line, up to the next top-level def. */
function pythonFunction(source, name) {
  const start = source.indexOf(`def ${name}(`);
  assert.ok(start >= 0, `paths/app source has no def ${name}`);
  const rest = source.slice(start + 1);
  const nextDef = rest.search(/\ndef /u);
  return nextDef === -1 ? source.slice(start) : source.slice(start, start + 1 + nextDef);
}

// ---------------------------------------------------------------- 1. 目录解析
describe('链关节 1：托盘界面的目录解析（apps/desktop/aidn，只读断言）', () => {
  const pathsPy = read(...AIDN, 'paths.py');
  const appPy = read(...AIDN, 'app.py');
  const trayPy = read(...AIDN, 'tray.py');
  const serverPy = read(...AIDN, 'server.py');

  it('console_dir() 就是 install_root()/"console"：没有 console-next 分支', () => {
    const body = pythonFunction(pathsPy, 'console_dir');
    assert.match(body, /install_root\(\)\s*\/\s*"console"/u,
      'console_dir 不再是 install_root()/console，整条链的结论要重算');
    assert.doesNotMatch(pathsPy, /console-next/u, 'paths.py 里出现了 console-next');
  });

  // post-fix expectation (D4)：
  //   旧期望：壳源码任何一份都不得出现 serve.mjs / console-next（= 壳只是 GET-only 静态宿主）。
  //   新期望：壳升级成 v2 宿主后，server.py 的注释会点名 console-next（说明它现在支持 v2 写/SSE），
  //           但「目录解析 / 启动决策认 console-next」仍不成立，也仍然不拉起 node 宿主（serve.mjs）。
  it('壳不拉起 node 控制台宿主；console-next 只出现在 server.py（v2 宿主说明），不在目录解析里', () => {
    for (const name of ['paths.py', 'app.py', 'tray.py', 'daemon.py']) {
      const text = read(...AIDN, name);
      assert.doesNotMatch(text, /serve\.mjs/u, `${name} 提到了 serve.mjs，链路结论需要更新`);
      assert.doesNotMatch(text, /console-next/u, `${name} 提到了 console-next（目录解析/启动决策不该认它）`);
    }
    // server.py 的注释会引用 console-next/serve.mjs（说明闸门同形），那不是拉起；
    // 只断言「没有真的用子进程去起它」。
    assert.doesNotMatch(read(...AIDN, 'server.py'),
      /(?:Popen|subprocess\.(?:run|call|check_output|check_call)|spawn)\s*\([^)]*serve\.mjs/u,
      'server.py 不能拉起 node 宿主');
  });

  it('_pick_web_root() 只看 console/index.html 是否存在，否则退回内置 webui/', () => {
    const body = pythonFunction(appPy, '_pick_web_root');
    assert.match(body, /paths\.console_dir\(\)/u);
    assert.match(body, /\(external \/ "index\.html"\)\.is_file\(\)/u);
    assert.match(body, /paths\.webui_dir\(\)/u);
    assert.match(body, /\(bundled \/ "index\.html"\)\.is_file\(\)/u);
    // 服务器启动时用的就是它
    assert.match(pythonFunction(appPy, 'start_server'), /_pick_web_root\(\)/u);
  });

  it('托盘「打开界面」= show → toggle_window → 壳自己的 LocalServer URL', () => {
    assert.match(trayPy, /ID_OPEN:\s*"show"/u);
    assert.match(trayPy, /AppendMenuW\(menu, MF_STRING, ID_OPEN, "打开界面"\)/u);
    assert.match(appPy, /"show":\s*self\.toggle_window/u);
    assert.match(pythonFunction(appPy, 'toggle_window'), /return self\.open_in_browser\(\)/u);
    assert.match(pythonFunction(appPy, 'open_in_browser'), /url = self\.url/u);
    // url → 壳的本地服务器
    const urlProperty = appPy.slice(appPy.indexOf('    def url(self)'));
    assert.match(urlProperty.slice(0, 400), /self\._server\.url/u);
  });
});

// ------------------------------------------------ 2. 壳服务器的写能力（GET-only）
describe('链关节 2：托盘壳内置服务器（server.py）的写能力', () => {
  const serverPy = read(...AIDN, 'server.py');

  // post-fix expectation (D4)：
  //   旧期望：只实现 GET/HEAD/POST，POST 只认 /shell/api/*，其余 405。
  //   新期望：补齐 PUT/DELETE；`/api/*` 的写方法先过宿主闸门（x-console-v2）再代发到 daemon；
  //           `/shell/api/*` 的既有规则不变。
  it('实现 GET/HEAD/POST/PUT/DELETE；/api/* 写走宿主闸门代理，/shell/api/* 规则不变', () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
      assert.match(serverPy, new RegExp(`def do_${method}\\(self\\)`, 'u'), `server.py 缺少 do_${method}`);
    }
    const postBody = pythonFunction(serverPy, 'do_POST');
    assert.match(postBody, /if path\.startswith\("\/api\/"\):\s*\n\s*return self\._proxy_write\(path\)/u,
      'POST /api/* 必须先走写代理');
    assert.match(postBody, /if not path\.startswith\("\/shell\/api\/"\):/u);
    assert.match(postBody, /405, "METHOD_NOT_ALLOWED", "只读端点不接受 POST"/u);
    const writeBody = pythonFunction(serverPy, '_proxy_write');
    assert.match(writeBody, /CONSOLE_HEADER_REQUIRED/u, '跨源写闸门必须留在宿主侧');
    assert.match(writeBody, /ORIGIN_REJECTED/u);
    assert.match(writeBody, /proxy_write\(self\.command/u);
  });

  it('读代理仍整包 read()；写代理注入 Bearer+CSRF，SSE 用 read1 流式转发', () => {
    // post-fix expectation (D4)：
    //   旧期望：代理只发 GET，且把响应整包 read() 完（SSE 无法流式）。
    //   新期望：GET 代理保持不变；写代理注入 Authorization + CSRF 派生值；
    //           SSE 走 `_send_stream` 的 read1 + chunked，边读边写。
    const proxyBody = pythonFunction(serverPy, 'proxy_get');
    assert.match(proxyBody, /connection\.request\("GET", path, headers=headers\)/u);
    assert.match(proxyBody, /response\.read\(\)/u);
    const writeBody = pythonFunction(serverPy, 'proxy_write');
    assert.match(writeBody, /\["authorization"\] = f"Bearer \{token\}"/u);
    assert.match(writeBody, /CSRF_HEADER\] = csrf_token_for\(token\)/u);
    const streamBody = pythonFunction(serverPy, '_send_stream');
    assert.match(streamBody, /read1/u, 'SSE 必须用 read1（read(n) 会攒满 n 字节才转发）');
    assert.match(streamBody, /transfer-encoding", "chunked"/u);
    assert.match(serverPy, /text\/event-stream/iu);
  });

  it('壳响应头含 frame-ancestors \'none\'（与新宿主同形，因此 CSP 不是区分判据）', () => {
    assert.match(serverPy, /frame-ancestors 'none'/u);
    assert.match(read('apps', 'console-next', 'serve.mjs'), /frame-ancestors 'none'/u);
  });
});

// ------------------------------------------------------- 3. 打包链路（谁能进 bundle）
describe('链关节 3：打包输入决定 stage 的是旧 console 还是 console-next', () => {
  const build = read('deploy', 'embedded-runtime', 'build.mjs');
  const profile = JSON.parse(read('deploy', 'embedded-runtime', 'profiles', 'daemon-console.json'));

  it('profile 的默认 console 源是 apps/console，兜底服务器是 console-shell/serve.mjs', () => {
    assert.equal(profile.assets.console.preferredSource, 'apps/console');
    assert.equal(profile.assets.console.shellSource, 'deploy/embedded-runtime/console-shell');
    assert.equal(profile.assets.console.serverFallback, 'deploy/embedded-runtime/console-shell/serve.mjs');
    assert.equal(profile.assets.console.target, 'console');
    assert.equal(profile.assets.console.requireEntry, 'index.html');
  });

  it('stageProfileAssets：--console-source 钉扎 > preferredSource > shellSource', () => {
    assert.match(build, /const preferredSource = consoleSource \?\? declaredSource;/u);
    assert.match(build, /source = consoleSpec\.shellSource;/u);
    assert.match(build, /origin = 'packaging-shell';/u);
    assert.match(build, /throw new Error\(`--console-source \$\{consoleSource\} is empty/u);
  });

  it('staged console 自带 serve.mjs 时不再补 console-shell；没有才补 fallback', () => {
    assert.match(build, /const hasServer = copied\.some\(\(row\) => row\.path\.endsWith\('\/serve\.mjs'\)\);/u);
    assert.match(build, /const fallback = consoleSpec\.serverFallbackSource;/u);
    assert.match(build, /copyFileSync\(fallback, target\)/u);
  });

  it('launch plan 的 console.server 是 console/serve.mjs，aegis-console.cmd 用 node 起它', () => {
    assert.match(build, /entry: assets\.console\.entry,/u);
    assert.match(build, /server: assets\.console\.server/u);
    assert.match(build, /"%NODE_EXE%" "%CONSOLE_SERVER%" --daemon "%AEGIS_DAEMON_URL%" %\*/u);
    assert.match(build, /if \(profile\.assets\.console !== undefined\) \{\n    const consoleServer = assets\.console\.server;/u);
  });

  it('已发布的 v15 bundle（rc.3 载荷）里 stage 的是**旧** console', { skip: !BUNDLE_HAS_CONSOLE }, () => {
    const bundle = JSON.parse(read(...BUNDLE_V15, 'bundle.json'));
    assert.equal(bundle.console.isProductUi, true);
    assert.equal(bundle.console.origin, 'pinned-workspace');
    assert.equal(bundle.console.pinnedPath, 'dist/_v14-inputs/console-v2');
    assert.equal(bundle.console.entry, 'console/index.html');
    assert.equal(bundle.console.server, 'console/serve.mjs');
    // 「旧」的可执行判据：bundle 里的 index.html 与 apps/console 字节相同、0 个 data-route
    assert.equal(sha256Of(...BUNDLE_V15, 'console', 'index.html'), sha256Of('apps', 'console', 'index.html'));
    assert.equal(dataRouteCount(read(...BUNDLE_V15, 'console', 'index.html')), 0);
    assert.notEqual(sha256Of(...BUNDLE_V15, 'console', 'index.html'),
      sha256Of('apps', 'console-next', 'index.html'));
    // 壳服务器就是打包层的旧 serve.mjs（GET/HEAD only）——注意 bundle 是冻结产物，
    // 它的 sha 记录在 bundle.json 里；与工作树当前的 console-shell 不必相同（本任务改过它）。
    assert.equal(sha256Of(...BUNDLE_V15, 'console', 'serve.mjs'),
      bundle.console.serverFallback.sha256);
    assert.equal(bundle.console.serverFallback.sourcePath,
      'deploy/embedded-runtime/console-shell/serve.mjs');
    assert.notEqual(sha256Of(...BUNDLE_V15, 'console', 'serve.mjs'),
      sha256Of('apps', 'console-next', 'serve.mjs'));
    assert.doesNotMatch(read(...BUNDLE_V15, 'console', 'serve.mjs'), /CONSOLE_HEADER_REQUIRED/u);
  });
});

// ------------------------------------------------------------ 4. 新/旧界面判据
describe('新/旧界面的可执行判据（文件层）', () => {
  const nextIndex = read('apps', 'console-next', 'index.html');
  const oldIndex = read('apps', 'console', 'index.html');
  const shellIndex = read('deploy', 'embedded-runtime', 'console-shell', 'index.html');
  const nextServe = read('apps', 'console-next', 'serve.mjs');
  const shellServe = read('deploy', 'embedded-runtime', 'console-shell', 'serve.mjs');

  it('data-route 数量：新 = 6，旧 = 0（打包壳 = 0）', () => {
    assert.equal(dataRouteCount(nextIndex), 6);
    assert.deepEqual([...nextIndex.matchAll(/data-route="([^"]+)"/gu)].map((row) => row[1]),
      ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings']);
    assert.equal(dataRouteCount(oldIndex), 0);
    assert.equal(dataRouteCount(shellIndex), 0);
  });

  it('标题：新 = "AIDriven NetDefense · 网域智防"，旧 = "网域智防 · 本地控制台"', () => {
    assert.equal(titleOf(nextIndex), 'AIDriven NetDefense · 网域智防');
    assert.equal(titleOf(oldIndex), '网域智防 · 本地控制台');
    assert.notEqual(titleOf(nextIndex), titleOf(oldIndex));
  });

  it('mark.svg 两代完全相同 → 不能用它区分新/旧（记录这个坑）', () => {
    assert.equal(sha256Of('apps', 'console', 'assets', 'mark.svg'),
      sha256Of('apps', 'console-next', 'assets', 'mark.svg'));
  });

  it('serve.mjs 的形状：新宿主有 x-console-v2 写闸门，旧壳只有 GET/HEAD', () => {
    assert.match(nextServe, /x-console-v2/u);
    assert.match(nextServe, /CONSOLE_HEADER_REQUIRED/u);
    assert.match(shellServe, /if \(req\.method !== 'GET' && req\.method !== 'HEAD'\)/u);
    assert.match(shellServe, /send\(res, 405, 'method not allowed'\)/u);
    // 旧壳只在注释/让位规则里提到 x-console-v2，从不校验它（没有闸门实现）
    assert.doesNotMatch(shellServe, /CONSOLE_HEADER_REQUIRED/u);
    assert.doesNotMatch(shellServe, /CONSOLE_HEADER\b/u);
  });
});

// --------------------------- 5. 直接调用真实 Python 模块（paths/app/server）
describe('直接调用 apps/desktop/aidn 的真实函数（paths-probe.py）', () => {
  const probe = join(HERE, 'paths-probe.py');
  const pythonCandidates = ['python', 'py'];
  let python;
  let run;
  for (const candidate of pythonCandidates) {
    const attempt = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (attempt.status === 0) { python = candidate; break; }
  }
  if (python !== undefined) {
    run = spawnSync(python, [probe, '--json'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, windowsHide: true,
    });
  }
  const parsed = (() => {
    if (run === undefined || run.status !== 0) return undefined;
    try {
      return JSON.parse(run.stdout.trim().split(/\r?\n/u).pop());
    } catch {
      return undefined;
    }
  })();
  const skip = python === undefined ? 'no python on PATH (cannot call paths.py directly)'
    : parsed === undefined ? `paths-probe failed: ${run?.stderr?.slice(-400) ?? ''}` : false;
  // 写代理的断言需要 live daemon（17511）才有「到达 daemon」的判据；不在就跳过而不是假装通过。
  const daemonUp = parsed?.daemon_up === true;
  const writeSkip = skip || (daemonUp ? false : 'live daemon 17511 not up (write proxy assertions need it)');

  it('探针可运行且全部适用断言通过', { skip }, () => {
    assert.equal(run.status, 0, `paths-probe exit ${run.status}: ${run.stderr?.slice(-500)}`);
    assert.equal(parsed.all_applicable_assertions_pass, true, JSON.stringify(parsed.assertions));
  });

  it('console_dir() = <install_root>/console（真实调用，不是复刻）', { skip }, () => {
    assert.match(parsed.cases.dev_default.console_dir.replace(/\\/gu, '/'), /\/console$/u);
    // post-fix expectation (D4)：旧期望是「任何壳源码都不得提 console-next」；
    // 新期望收窄为「目录解析/启动决策（paths/app/tray/daemon）不认 console-next，
    // 且壳不拉起 node 宿主」——server.py 的 v2 宿主注释不算破坏链路。
    assert.equal(parsed.shell_sources_mention_console_next, false,
      '壳的目录解析/启动决策里出现了 console-next，链路结论要更新');
    assert.equal(parsed.shell_sources_launch_node_host, false,
      '壳源码里出现了 serve.mjs：托盘壳不该拉起 node 控制台宿主');
  });

  it('安装根 = v15 bundle 时，_pick_web_root() 选中的是**旧** console/index.html', { skip }, () => {
    const bundle = parsed.cases.bundle_v15;
    assert.match(bundle.picked_web_root.replace(/\\/gu, '/'), /\/console$/u);
    assert.equal(bundle.page.data_route_count, 0);
    assert.equal(bundle.page.sha256, sha256Of('apps', 'console', 'index.html'));
  });

  it('把 console-next 放进 console/ 时：静态层照发新界面，写请求也到达 daemon（D4 已修）', { skip: writeSkip }, () => {
    // post-fix expectation (D4)：旧期望「静态层照发新界面（但写仍然死，405/501）」；
    // 新期望 = 静态层不变，且同一台真实 LocalServer 对新界面的写请求已代发到 daemon。
    const nextAs = parsed.cases.console_next_as_console;
    assert.equal(nextAs.page.data_route_count, 6);
    assert.equal(nextAs.page.sha256, sha256Of('apps', 'console-next', 'index.html'));
    const newServer = parsed.desktop_server_new_console;
    assert.equal(newServer.post_settings_without_v2.error_code, 'CONSOLE_HEADER_REQUIRED',
      '无闸门的写必须被宿主拦下');
    const post = newServer.post_settings_with_v2;
    assert.ok(post.status === 200 || post.status === 400
      || /not supported for this endpoint/u.test(post.body_head ?? ''),
    `POST 写应到达 daemon，实际 status=${post.status} body=${post.body_head}`);
    assert.ok([200, 400].includes(newServer.put_settings_with_v2.status),
      `PUT 写应到达 daemon（400 SETTINGS_INVALID / 200），实际 ${newServer.put_settings_with_v2.status}`);
  });

  it('真实 LocalServer：GET 正常；写方法过 x-console-v2 闸门后到达 daemon（D4 已修）', { skip: writeSkip }, () => {
    // post-fix expectation (D4)：
    //   旧：GET 正常、POST /api/v1/settings = 405（无/有 v2 都 405）、PUT = 501（stdlib）。
    //   新：POST 无 v2 → 403 CONSOLE_HEADER_REQUIRED（宿主闸门）；
    //       POST 有 v2 → 到达 daemon（daemon 自己的 405 文案 "not supported for this endpoint"）；
    //       PUT  有 v2 → 到达 daemon（400 SETTINGS_INVALID 或 200）。
    const server = parsed.desktop_server_old_console;
    assert.equal(server.get_index.status, 200);
    assert.equal(server.served_page_is_web_root_index, true);
    assert.equal(server.post_settings_without_v2.status, 403);
    assert.equal(server.post_settings_without_v2.error_code, 'CONSOLE_HEADER_REQUIRED');
    assert.match(server.post_settings_with_v2.body_head, /not supported for this endpoint/u,
      'POST 应到达 daemon（daemon 自己的错误文案），而不是旧壳的 405');
    assert.ok([200, 400].includes(server.put_settings_with_v2.status),
      `PUT 应到达 daemon（旧壳是 501），实际 ${server.put_settings_with_v2.status}`);
    // 唯一仍由壳自己处理的写入口是 /shell/api/*，且要自定义头。
    assert.equal(server.post_shell_api_without_header.error_code, 'SHELL_HEADER_REQUIRED');
  });
});

// ------------- 7. 本任务在写域内的落实：console-shell 对 v2 页面"让位"
describe('console-shell/ 的让位规则（本任务写域内的改动）', () => {
  const shellDir = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'console-shell');
  const shellServe = join(shellDir, 'serve.mjs');

  /** Start a described server and resolve once it announces `listening`. */
  function startAnnouncing(script, args) {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`no announcement in 15s; stdout=${stdout.slice(-400)} stderr=${stderr.slice(-400)}`));
      }, 15_000);
      const poll = setInterval(() => {
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.listening === undefined) return;
          clearInterval(poll);
          clearTimeout(timer);
          resolvePromise({ child, announcement: parsed, stderr: () => stderr });
        } catch {
          /* not a complete document yet */
        }
      }, 25);
      child.once('exit', (code) => {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error(`exited ${code}: ${stderr.slice(-400)}`));
      });
    });
  }

  async function close(child) {
    if (child.exitCode !== null) return;
    child.kill();
    await new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 3000);
      child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    });
  }

  it('旧页面（本目录自带 index.html）照常服务：公告 generation=legacy，写仍是 405', async () => {
    const server = await startAnnouncing(shellServe, ['--daemon', 'http://127.0.0.1:9', '--port', '0']);
    try {
      assert.equal(server.announcement.generation, 'legacy');
      assert.match(server.announcement.listening, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
      const response = await fetch(`${server.announcement.listening}api/v1/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-console-v2': '1' },
        body: '{}',
      });
      assert.equal(response.status, 405);
      await response.text();
    } finally {
      await close(server.child);
    }
  });

  it('目录里是 WebUI v2 页面时拒绝启动（退出码 3，并点名 --console-source）', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'aidn-console-shell-v2-'));
    try {
      cpSync(join(REPO_ROOT, 'apps', 'console-next'), scratch, { recursive: true });
      copyFileSync(shellServe, join(scratch, 'serve.mjs'));
      const result = spawnSync(process.execPath, [join(scratch, 'serve.mjs'),
        '--daemon', 'http://127.0.0.1:9', '--port', '0'], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 20_000, windowsHide: true,
      });
      assert.equal(result.status, 3, `expected the v2 refusal (3); stderr=${result.stderr}`);
      assert.match(result.stderr, /WebUI v2/u);
      assert.match(result.stderr, /--console-source apps\/console-next/u);
      assert.match(result.stderr, /GET\/HEAD only/u);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// ------------------------------------- 6. 活体主机 + 旧壳差分（网络/浏览器不可用则 skip）
describe('活体证明：17512 上托底的是新宿主，不是旧壳（probe-live.mjs）', () => {
  const base = process.env.SHELL_LINK_BASE ?? 'http://127.0.0.1:17512';
  let reachable = false;
  try {
    const probe = spawnSync(process.execPath, ['-e',
      `fetch(${JSON.stringify(base)}, { signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))`],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    reachable = probe.status === 0;
  } catch {
    reachable = false;
  }
  const skip = reachable ? false : `console host not reachable at ${base}`;
  const run = reachable ? spawnSync(process.execPath, [join(HERE, 'probe-live.mjs'), '--base', base, '--json', '--no-browser'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000, windowsHide: true,
  }) : undefined;
  const live = (() => {
    if (run === undefined || run.status !== 0) return undefined;
    try {
      return JSON.parse(run.stdout.trim().split(/\r?\n/u).pop());
    } catch {
      return undefined;
    }
  })();

  it('活体断言全通过（含旧壳差分）', { skip }, () => {
    assert.equal(run.status, 0, `probe-live exit ${run.status}: ${run.stderr?.slice(-600)}`);
    assert.equal(live.verdict, 'PASS', JSON.stringify(live.assertions));
    assert.equal(live.assertions.landing_has_six_data_route, true);
    assert.equal(live.assertions.csp_frame_ancestors_none, true);
    assert.equal(live.assertions.post_without_marker_is_console_gate, true);
    assert.equal(live.assertions.put_with_marker_is_accepted, true);
    assert.equal(live.assertions.old_shell_rejects_put_with_405, true);
  });
});
