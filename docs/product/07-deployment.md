# 部署前置条件与已知限制

> **版本状态：0.0.1 未发布，不可作为正式版本分发。**
>
> **本文不是安装指南。** 0.0.1 没有安装器、没有安装包、没有服务单元、没有升级通道。
>
> **2026-11-05 订正**（原文上一段成文于 2026-11-03）：Windows **已有**安装链与候选包——
> `deploy/windows/installer/`（`VERSION`=`0.0.1-rc.5`）已产出
> `dist/release/0.0.1-rc.5/AIDrivenNetDefense-Setup-0.0.1-rc.5.exe`（67 860 347 B，
> sha256 `ca0297d0…`，**未签名**）与便携包；安装/卸载/升级（覆盖安装）都有代码路径，
> 非提权装→卸已实测（`docs/implementation/evidence/rc5/accept/FINAL/RESULT.json`）。
> **仍然没有**的是：签名、服务单元（`deploy/systemd/` 仍为空）、四 OS 包、
> 以及**提权安装的验收结论**（`blocked(uac-cancelled)`）。
> 面向用户的安装步骤见 `docs/install/`，不是本文。
> 下文只描述「在一台开发机上把源码树跑起来」需要什么，以及会在哪里卡住。
> 不存在可写的下载地址、发布页或校验和清单；任何声称有的材料都不是本项目产物。

- 作者：PT-dove
- 适用对象：内部开发/验证人员，不是终端用户

---

## 1. 一句话

当前只能**从源码树以开发态运行**，且真实采集与真实处置都跑不通；
它不具备「装到别人机器上就能用」的形态。

---

## 2. 前置条件

| 项 | 要求 | 依据 |
|---|---|---|
| 操作系统 | **仅 win32-x64 实测过**。Linux/macOS/win32-arm64 无运行证据 | `RELEASE_STATUS.md` §4 第 1 项 |
| Node.js | `>= 24.9.0`；实测 `v24.20.0`（`C:\Program Files\nodejs\node.exe`） | 根 `package.json` `engines`；工具链门禁 |
| npm | `>= 11.6.0 < 12.0.0`；实测 `11.19.0` | 同上 |
| 依赖 | 使用仓库安装态的 `node_modules`（按根 `package-lock.json`）。重建安装请在临时副本里做 | 根 `package-lock.json` |
| 数据目录 | 必须显式给出；必须**可写**（SQLite WAL 需要写 `-wal`/`-shm`） | `apps/daemon/src/config.js` |
| 磁盘 | 数据卷可用空间 **≥ 8 GiB**（低于此值按临界水位处理）；库上限 2 GiB、WAL 上限 1 GiB | `packages/event-store/src/maintenance.js` |
| 端口 | 回环 `127.0.0.1` 或 `::1` 上的一个固定端口（默认 `0` 为临时端口） | `apps/daemon/src/config.js` `api.port` |
| 规则包 | 必须提供，`schemaVersion = "1.0"`，至少一条规则；文件必须位于 `dataDir` 内 | `packages/detection/src/rule-pack.js` |
| 采集源 | `full` 模式要求**宿主注入至少一个**采集源 | `apps/daemon/src/daemon.js` |
| 权限 | 能创建数据目录、能监听回环端口；POSIX 上 token 文件需 `0600` | `apps/daemon/src/api/auth.js` |

> 注意「采集源」这一行：仓库自带入口 `apps/daemon/bin.js` **不注入任何采集源**，
> 因此 `full` 模式用自带入口启动会直接失败（fail-closed，不是 bug）。
> 想在开发机上看 API 有响应，只能用 `mock` 模式——它是内存存储、无采集、重启即空。

---

## 3. 开发态运行（真实命令）

### 3.1 daemon

两种启动方式：

```bash
# A. 配置文件方式
node apps/daemon/bin.js --config <path-to-config.json>

# B. 命令行方式（规则包是必需的）
node apps/daemon/bin.js --data-dir <abs-data-dir> --rules <path-to-rule-pack.json>
node apps/daemon/bin.js --data-dir <abs-data-dir> --rules <path> --mock   # 内存存储，无采集
```

> 同时给出 `--config` 与 `--data-dir/--rules/--mock` **不会报错**：实现里 `--config` 优先，其余参数被
> 静默忽略（`apps/daemon/bin.js`）。所以别指望「多给一个参数」会被拦住——要哪种形态就只给那一组。

其它参数：

```text
--mock      以内存事件存储运行（无 SQLite、无采集器）
-h, --help  显示帮助
```

启动成功的判据：**stderr** 上出现一条 JSON 日志 `"daemon ready"`，其中带 `host` 与 `port`
（`logging.level` 为 `silent` 时不会有任何日志）。
日志是 JSON 行（`apps/daemon/src/log.js` 写 stderr），不是给人读的散文。

```text
{"level":"info","msg":"daemon ready","epoch":"...","host":"127.0.0.1","port":8787,...}
```

进程行为：

- 收到 `SIGINT` / `SIGTERM` 各触发一次优雅关闭（优雅期 5000ms、排空 2000ms）；第二次信号只记日志。
- 关闭有错误时退出码 1，否则 0。
- 它是常驻进程，不会自己退出。

### 3.2 配置示例（daemon）

只列真实存在的键；**未知键会被拒绝**（`CONFIG_INVALID`，退出码 2）：

```json
{
  "dataDir": "C:/AIUSE/nd-data",
  "mode": "mock",
  "api": {
    "host": "127.0.0.1",
    "port": 8787,
    "tokenFile": "secrets/api-token"
  },
  "detection": {
    "rulePackPath": "rules/pack.json"
  },
  "logging": { "level": "info" }
}
```

要点：

| 键 | 说明 |
|---|---|
| `dataDir` | 顶层必填；所有派生路径都被约束在它内部 |
| `mode` | `full`（默认）或 `mock`；两者都要求规则包 |
| `api.host` | 只能是 `127.0.0.1` 或 `::1` |
| `api.port` | `0..65535`；`0` 表示临时端口，CLI 无法稳定连接 |
| `api.tokenFile` | 相对路径按 `dataDir` 解析，默认 `secrets/api-token`；也可用 `api.token` 内联（32..512 字符） |
| `detection.rulePackPath` | **相对路径按 `dataDir` 解析**；也可以内联 `detection.rulePack`，二者只能选一个 |
| `policy.allowedSummaryFields` | 可出域的摘要字段白名单，默认 4 个 D0 计数器 |
| `store.path` / `state.path` | 同样被约束在 `dataDir` 内 |

### 3.3 CLI

见 [05-cli.md](./05-cli.md)。最小验证顺序：

```bash
node apps/cli/bin.js health  --config ./cli.json   # 不需要 token
node apps/cli/bin.js status  --config ./cli.json   # 需要 token
node apps/cli/bin.js alerts --limit 20 --config ./cli.json
```

`cli.json` 的 `endpoint` 端口必须与 `api.port` 一致。

---

## 4. 数据目录

| 内容 | 默认位置（相对 `dataDir`） | 说明 |
|---|---|---|
| SQLite 库 | `store/aegis.db`（+ `-wal` / `-shm`） | `mock` 模式不创建 |
| 状态文件 | `daemon-state.json` | 记录调度游标等，用于重启恢复 |
| API token | `secrets/api-token` | `0600`，首次启动生成或沿用 |
| 规则包 | 由 `detection.rulePackPath` 指定 | 必须位于 `dataDir` 内 |

**清理方式**：整个 `dataDir` 可以直接删除（没有任何系统级注册、服务、注册表项、计划任务）。
没有「卸载程序」，因为这个产品还没安装过。

---

## 5. 已知限制

### 5.1 启动与运行

| 限制 | 现象 | 说明 |
|---|---|---|
| `full` 模式无采集源 | 启动失败：「full mode requires at least one collector source」 | **2026-11-05 订正**：自带入口现已支持 `--collectors <path>`（`apps/daemon/bin.js:51` → `src/adapters/collector-sources.js`），不再必须有宿主程序；**不传时仍 fail-closed**，这是设计 |
| 只能用 `mock` 做端到端冒烟 | API 有响应但告警永远为空、重启即丢 | 内存存储 |
| 默认端口 0 | 每次启动端口不同，CLI 连不上 | 必须显式配 `api.port` |
| 无 UI | 只能 CLI / HTTP | **2026-11-05 订正**：`apps/console/` 15 个文件、`apps/console-next/` 6 页，已随 rc.5 载荷 `console/`（63 文件）分发；但桌面壳默认 **mock + 0 采集源**，`/healthz` 返回 `degraded` 是诚实值 |
| 无服务化 | 关掉终端进程就没了 | **2026-11-05 订正**：`deploy/windows/` **不再为空**，安装版有开始菜单项、卸载项与可选开机自启（`/AUTOSTART`，实测写在 `HKCU\...\Run\AIDrivenNetDefense`）；`deploy/systemd/` 仍为空，Linux 无服务化 |
| 无日志轮转 | stderr 输出，交给外部收集 | 没有内置文件日志管理 |
| 单写者 | 设计上只允许 daemon 一根可写连接；两个进程指向同一 `dataDir` 的实际行为**未验证**，不要这样做 | 设计约束，不是可配置项 |

### 5.2 能力边界

| 限制 | 说明 |
|---|---|
| 无安装/升级/回滚 | 没有安装包，也没有补丁通道 |
| 无代码签名 | 交付物无法验证来源 |
| 跨平台未验证 | 仅 win32-x64 有运行证据 |
| 真实采集未验证 | 采集器只在虚拟文件系统 / mock 源上跑过 |
| 真实响应不存在 | `EXECUTION_ENABLED = false`，只会出计划 |
| 模型链路未接生产凭据 | 只有回环桩 broker |
| 分析链路未连通 | 告警不会自动进入 Harness，报告不会回写 |
| 审批无接口 | 数据模型有，HTTP 面没有 |
| 无备份/恢复演练 | `recovery_manifest` 表在，流程未验证 |
| bundle 非安装包 | `deploy/embedded-runtime` 产物是可删的开发验证物，且不能 `npm ci` |

### 5.3 测试与门禁

| 限制 | 说明 |
|---|---|
| 门禁只管本机 | `npm test` / `npm run check` 只证明当前 win32-x64 树 |
| packaging 不在 `npm test` 内 | 需单独进 `tests/packaging` 跑 |
| bench/soak 不在门禁内 | 性能与长稳结论不随门禁更新 |
| 两条 skip | Windows 无符号链接权限导致，不是功能通过 |

---

## 6. 关于 `npm ci` 与干净安装

- 在**开发树原地**执行 `npm ci` 会重写安装态；需要验证干净安装时，复制到临时目录再装。
- `deploy/embedded-runtime` 产出的 bundle **不能** `npm ci`：它保留指向已裁剪包的声明依赖，
  `tests/packaging/manifests.test.js` 对此显式放行。bundle 是运行产物，不是可安装工程。
- 测试只允许使用临时目录与无害合成数据；禁止读、清、改真实用户日志或真实数据目录。

---

## 7. 不要做的事

| 禁止 | 原因 |
|---|---|
| 把 `api.host` 改成 `0.0.0.0` 或做端口映射 | daemon 只接受回环；破坏边界后没有任何认证加固能补偿 |
| 在前面挂反向代理 / TLS 终止 | 无此形态，`Host` 校验会拒绝，且未验证 |
| 把 token 文件放进版本库、共享盘、聊天记录 | 单 token 即全部权限 |
| 用真实生产日志做测试数据 | 违反 `SECURITY.md` 与测试安全基线 |
| 把 bundle 当安装包分发 | 它是开发验证物，无签名、无升级、许可文本口径特殊 |
| 对外宣称「已发布 / 跨平台 / 可处置」 | 与事实不符，见 [04-gaps.md](./04-gaps.md) |

---

## 8. 如果你只是想看看它长什么样

最小可行路径（全部在本机、无真实数据）：

1. 建一个临时数据目录，例如 `C:/AIUSE/nd-data`。
2. 放一个 `schemaVersion` 为 `1.0` 的规则包到 `C:/AIUSE/nd-data/rules/pack.json`（至少一条规则）。
3. 用 §3.2 的配置（`mode: "mock"`、`port: 8787`）启动 daemon，确认 stderr 出现 `daemon ready`。
4. 用 §3.3 的 `health` 与 `status` 验证 CLI 能连上。
5. 结束后直接删掉临时目录。

这条路径能证明的只有「组件能起来、API 能响应」。
它**不能**证明检测有效、采集真实、响应可用、跨平台可用。
