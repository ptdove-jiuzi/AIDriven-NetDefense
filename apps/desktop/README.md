# 桌面壳（apps/desktop）

AIDriven NetDefense / 网域智防 的 Windows 桌面外壳：托盘 + WebView2 窗口 + 设置，
把 `apps/daemon` 作为子进程托管起来，并给界面提供一个只监听回环的静态服务器与
同源 `/api` 代理。作者：PT-dove。

## 目录

```text
apps/desktop/
  main.py              入口：单实例 → 日志 → daemon → 本地服务器 → 托盘 → 窗口
  build.py             PyInstaller 单文件打包（产物 dist/desktop/AIDrivenNetDefense.exe）
  aidn/                壳本体，按职责分层，互不反向依赖
    paths.py           只回答「文件在哪」，不做 IO
    settings.py        shell/settings.json 的读写 + HKCU Run 开机自启
    daemon.py          daemon 子进程生命周期（端口 +1、Job Object 防孤儿、看门狗）
    server.py          静态页 + 同源 /api 代理 + 壳管理接口
    tray.py            Shell_NotifyIcon 托盘（不依赖 pystray / PIL）
    logsetup.py        desktop-YYYYMMDD.log + 崩溃栈 + 日志目录热切换
    app.py             把上面拼起来
  webui/               内置界面（概览 / 告警 / 分析 / 设置）
  assets/app.ico       托盘与 exe 图标
  assets/rules/        内置规则包（启动时复制进数据目录，daemon 只接受 dataDir 内的路径）
```

> 说明：目录里另有 `settings/`、`updater/` 两个包和 `AIDrivenNetDefense.spec`，由另一并行
> 会话新增，当前**没有任何代码 import 它们**（`settings/shell_api.py`、`updater/shell_api.py`
> 里的路由仍是注释示例）。壳运行所需的一切都在 `main.py` + `aidn/` 内。归属未定前请勿把
> `import settings` 当成「壳的设置模块」——那是 `aidn/settings.py`。

## 运行

```bash
# 开发态（需要本机 node）
python apps/desktop/main.py --port 17801

# 打包
python apps/desktop/build.py --clean
```

打包后 `dist/desktop/AIDrivenNetDefense.exe` 是单文件、无控制台窗口。它按
「安装布局」找 daemon：`<exe 同级>\daemon\apps\daemon\bin.js`；开发态则回落到仓库
根。两种情况都可以用 `AIDN_DAEMON_ENTRY` / `AIDN_NODE` 覆盖。

## 测试

```bash
# 单元测试（不启 GUI、不写真实用户目录）
python tests/desktop/run-tests.py

# 端到端验收（真的拉起 exe 与 daemon，逐条核对验收项）
python tests/desktop/acceptance.py
```

两个脚本都用 `AIDN_BASE_DIR` 指到临时目录，并在前后比对真实
`%LOCALAPPDATA%\AIDriven NetDefense`，断言零改动。开机自启在测试里走
`AIDN_RUN_KEY` 指向的隔离注册表子键，不会动用户真实的 Run 项。

## 行为约定

- 关窗口 = 隐藏到托盘，daemon 继续跑；只有托盘「退出」或 `/shell/api/quit` 才结束进程。
- 托盘左键：显示/隐藏；右键：打开界面 / 在浏览器中打开 / 设置 / 退出。
- 壳被强杀时，daemon 由 Job Object（kill-on-close）一起带走，不留孤儿。
- daemon 端口被占用时逐个 +1，并把真实端口写回设置。
- 界面永远拿不到 daemon 的 bearer token：请求由壳在服务端注入。

## 环境隔离变量（测试与排障用）

| 变量 | 作用 |
| --- | --- |
| `AIDN_BASE_DIR` | 数据/日志根，默认 `%LOCALAPPDATA%\AIDriven NetDefense` |
| `AIDN_DATA_DIR` | 单独覆盖数据目录 |
| `AIDN_LOG_DIR` | 单独覆盖日志目录（设置里的日志目录优先于此） |
| `AIDN_NODE` / `AIDN_DAEMON_ENTRY` | 指定 node 与 daemon 入口 |
| `AIDN_RUN_KEY` / `AIDN_RUN_VALUE` | 开机自启写到哪个注册表键（测试隔离用） |
| `AIDN_NO_OPEN` | `1` 时不真的拉起浏览器（验收脚本用） |
