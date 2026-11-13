# tests/e2e/shell-link —— 壳联动（托盘「打开界面」加载的是哪份界面）

- 作者：PT-dove
- 任务：INT-6（UI2-INTEGRATION 的壳联动席位）
- 结论与证据：`docs/implementation/evidence/ui2/shell-link/{CHAIN-MAP,STATUS,NEEDED-DESKTOP-CHANGE}.md`

## 三个探针（都不改别人的文件）

| 文件 | 证明什么 | 怎么跑 |
|---|---|---|
| `paths-probe.py` | **直接 import 真实模块**调用 `aidn.paths.console_dir()` / `aidn.app._pick_web_root()` / `aidn.server.LocalServer`，证明托盘会从哪个目录取界面、以及壳服务器对写请求回什么 | `python tests/e2e/shell-link/paths-probe.py [--json]` |
| `probe-live.mjs` | 活体：对 17512/17522 断言 6 个 `data-route`、CSP、`x-console-v2` 403 闸门、带头写请求到达 daemon（PUT dryRun 200），并用**真实浏览器**（自写 CDP 驱动 `tests/e2e/lib/cdp.mjs`）数渲染后的导航项；同时**真启动旧壳** `console-shell/serve.mjs` 做同请求差分（405） | `node tests/e2e/shell-link/probe-live.mjs --base http://127.0.0.1:17512` |
| `chain.test.js` | 把上面两层收成 `node --test` 断言：链路静态事实（paths/app/tray/server.py 行号级）、v15 bundle 里实际 stage 的 console、新旧判据、console-shell 的 v2 让位规则、Python 直接调用、活体与旧壳差分 | `node --test tests/e2e/shell-link/chain.test.js` |

网络不可用（17512 没起）时，`chain.test.js` 的活体用例**自动 skip**；没有 python 时 Python 用例
**自动 skip**；`--no-browser` 时浏览器两项记为 `null`（不适用），不会假通过。

## 边界

- **只读** `apps/desktop/**`、`apps/console/**`、`apps/console-next/**`、
  `deploy/embedded-runtime/build.mjs`：本目录任何脚本都不得写它们。
- `paths-probe.py` 只在系统临时目录里拷贝 `apps/console-next` 做"如果它是 console/ 会怎样"的
  反事实实验，结束时删除。
- 本目录唯一会动的活体资源是**临时启动**一个 `console-shell/serve.mjs`（随机端口，用完 kill）；
  不重启 17511/17512/17521/17522 的栈。

## 关键判据（详见 CHAIN-MAP §4）

- `data-route` 数量：新 = 6，旧 = 0 —— 主判据。
- 写闸门：新宿主缺 `x-console-v2: 1` → **403 CONSOLE_HEADER_REQUIRED**；旧壳非 GET/HEAD → **405**。
- `mark.svg` 两代**相同**（合同要求），因此**不能**用它判断新旧。
- CSP / `x-frame-options` 能把 console-next 与 console-shell 分开，**不能**把 console-next 与
  `apps/desktop` 的 Python 壳分开（两者头同形）。
