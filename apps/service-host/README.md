# `@aegisharness/service-host` — P2 服务宿主

- 上游：`docs/implementation/adr/ADR-0009-release-distribution.md` D3、§3.2、§5.2
- 状态：**JS 宿主可实现并已测；原生 SCM 垫片只有源码，未构建**
- 作者：PT-dove

## 1. 为什么需要它

`apps/daemon/bin.js` 明确拒绝在 `full` 模式下凭空造采集源（「full mode requires at least one
collector source」），因为一个采集不到东西却显示健康的守护进程比不启动更糟。采集源必须由**宿主程序**
注入——这就是本应用。

```text
aegis-svc.exe (native, SCM)  ──spawn──▶  node apps/service-host/bin.js --config <path>
        │                                        │
        │  Job Object KILL_ON_JOB_CLOSE          ├─ loadConfig()        （daemon 的校验器）
        │  STOP/PRESHUTDOWN ⇒ stdin {"cmd":"stop"} ├─ buildSources()     （7 类 Windows 采集器）
        ▼                                        ├─ createDaemon({config, logger, sources})
   SCM 状态机                                    └─ stdout {"event":"ready","port":…}
```

## 2. 进程契约（唯一）

| 方向 | 消息 | 时机 |
|---|---|---|
| child → host | `{"event":"ready","port":8787,"pid":1234}` | API 已开始服务，**一次** |
| child → host | `{"event":"stopping","reason":"service-stop"}` | 收到停止请求后 |
| host → child | `{"cmd":"stop","reason":"service-stop"}` | SCM 的 STOP / SHUTDOWN / PRESHUTDOWN |
| 退出码 | `0` 干净停止；`1` 启动或关闭失败 | — |

词汇是**封闭**的：`parseControlLine` 只认这三种，其他一律丢弃并记日志。控制通道放开词汇，
就等于开了第二个没人审的 API。

## 3. 文件

| 文件 | 职责 |
|---|---|
| `bin.js` | 宿主入口：配置校验、采集源装配、`createDaemon`、ready 行、stdin 停止命令 |
| `src/sources.mjs` | 采集源装配。`directories` 源必须给出监视根，否则它拒绝构造（本文件显式声明） |
| `src/health.mjs` | loopback 探活：`/healthz` 再看 `/api/v1/status` + Bearer token |
| `src/supervisor.mjs` | 原生宿主的**参考实现**：ready 超时、stop 转发、超时强杀整树 |
| `src/control-channel.mjs` | NDJSON 读/写与封闭词汇 |
| `native/aegis-svc.cpp` | SCM 垫片源码（`--install-service` / 服务模式 / `--uninstall-service`）**未编译** |
| `native/build.md` | 构建与签名步骤、构建后必须补的五条证据 |

## 4. 权限

| 项 | 值 |
|---|---|
| 服务账号 | `NT SERVICE\AIDrivenNetDefenseDaemon`（虚拟账号，无密码） |
| **不是** | `LocalSystem`（D4 明令禁止） |
| 额外组 | `S-1-5-32-573`（Event Log Readers）——**按 SID**，不用本地化组名 |
| 启动类型 | delayed-auto |
| 进程树 | Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：宿主退出 ⇒ 整树回收 |

## 5. 已验证 / 未验证

已验证（`node --test tests/installer/service-host.test.js`，12 条）：

- ready 行被正确识别，`stop` 后被干净停止（退出 0，未强杀）；
- 子进程在 ready 之前退出 ⇒ 立即失败并透传退出码，不等满超时；
- 子进程忽略 stop ⇒ 超时后强杀并标记 `killed: true`；
- 控制词汇封闭，未知消息不转发；
- 探活：token 不匹配（401）与 health 失败（503）都被判为"未就绪"；
- 配置非法时宿主退出 1，不启动守护进程；
- `--dry-run` 能装配出 9 个源（event log 每个频道一个源，另有 6 个轮询源）。

未验证（不计为完成）：

- `aegis-svc.exe` 未构建，因此 **SCM 注册、PRESHUTDOWN、Job Object 整树回收全部没有实测**；
- `bin.js` 没有与真实 SQLite store + 真实采集器一起跑过（那需要一次真实安装，属 G5a）；
- 服务级权限收敛（B1–B7 判据）见 `deploy/windows/README.md` §5。
