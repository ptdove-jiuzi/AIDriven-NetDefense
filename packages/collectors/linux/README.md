# Linux 采集器适配层（WP2-LINUX）

作者：PT-dove。所有结论以 `*.js` 与测试为准，本文只做索引与集成说明。

## 1. 分层

| 文件 | 职责 |
|---|---|
| `errors.js` | `LinuxCollectorError` 与文件系统结果分类（permission / not_found / not_directory / io_error） |
| `fs-reader.js` | 可注入的文件读取抽象：`createNodeFileSystem({ root })` 与 `createMemoryFileSystem(fixture)` |
| `command.js` | 唯一允许 spawn 的地方：`journalctl` 白名单、argv 数组、无 shell；`createScriptedCommandRunner` 供测试 |
| `diff.js` | 快照实体身份、状态摘要、added/changed/removed 差分 |
| `sources/*.js` | 每个来源一个模块，各自导出经过 `assertSourceDescriptor` 校验的声明 |
| `runtime.js` | 接入 `packages/collectors/common`，并把"读到什么"翻译成"来源生命周期是什么" |

平台差异全部留在本目录内；检测层只消费 `linux.*` 事件类型。

## 2. 来源矩阵与声明

| stable_source_id | 机制 | 间隔 | 无 root 的字段损失 | 不要求 root |
|---|---|---|---|---|
| `linux.procfs-processes` | `/proc/<pid>/{stat,status,cmdline,exe}` | 5 s | `cmdline`、`exePath`（他人进程） | 是 |
| `linux.procfs-connections` | `/proc/net/{tcp,tcp6,udp,udp6}` + `/proc/<pid>/fd` | 5 s | `pid`、`processName` | 是 |
| `linux.journald` | `journalctl --output=json --system`（cursor） | 事件 + 30 s 探活 | 无 journal 权限时整体不可用 | 是 |
| `linux.auth-log` | `/var/log/auth.log` 或 `/var/log/secure`（字节偏移 + 尾部摘要校验） | 5 s | 无读权限时整体不可用 | 是 |
| `linux.systemd-units` | 三个声明单元目录的元数据 | 60 s | 受限目录下的单元 | 是 |
| `linux.cron` | `/etc/crontab`、`/etc/cron.d`、spool、`cron.*` 脚本目录 | 60 s | spool crontab 只有元数据 | 是 |
| `linux.declared-directories` | 声明根目录的元数据（默认不读内容） | 60 s | 受限子目录/文件 | 是 |

journald 的可见性不是看退出码：非 root 且不在 `systemd-journal`/`adm` 组时，`journalctl`
会打印 "not seeing messages from other users" 提示后**仍然以 0 退出**。因此适配层同时看
stderr 提示与"首读是否为空页"，探活也改为拉 1 条记录（`--lines=1`）——`--lines=0` 对看不见
journal 的账号同样返回 0 行，无法作为证据。为此不加 `--quiet`。

每个描述符在数据里声明七项：`permissions`（required/optional/degradedWithout）、
`intervalMs`、`fields`（逐字段 completeness: `always`/`admin`/`best_effort`/`opt_in`）、
`blindSpots`（含短寿对象）、`rotation`、`gapSemantics`、`degradation`
（`neverHealthyWhenEmpty: true` 是强制项）。`tests/wp2-linux/descriptors.test.js` 逐条断言。

## 3. 降级语义（本目录的核心约定）

来源 `read()` 返回 `status`，`runtime.readSource()` 据此决定动作：

| status | 发布记录 | 游标 | 生命周期 | 缺口 |
|---|---|---|---|---|
| `ok` | 是 | 提交 | `ready` | 无（`truncated`/`backlogRisk` 仍会补 `io_error`/`read_overlap_skipped`） |
| `partial` | 是 | 提交 | `degraded` | 有 denials → `permission_denied`，否则 `io_error` |
| `denied` | **否** | **不前进** | `unavailable` | `permission_denied`（count 0 = 数量未知） |
| `error` | 否 | 不前进 | `degraded` | `io_error` |
| `rotated` | 否 | 代次 +1 | `degraded` | `log_rotated`/`log_truncated`（count 0，未知） |

`denied` 不提交是硬要求：无权限时若提交空批次，poll 源会被记为"成功推进"并显示新鲜，
这正是任务禁止的"伪正常空结果"。恢复权限后下一次成功读取会 `setPermissions({missing: []})`
解锁，并清空 degraded 标记。

### 3.1 两种"看不见"必须分开

| | 含义 | 影响 | 落地方式 |
|---|---|---|---|
| **结构性缺失**（denial） | 一个我们本该读的对象读不到（`/proc/<pid>/stat`、日志文件、整张 net 表） | 降级，且**抑制该对象的 removed 事件** | `denials[]` → `partial`/`denied` + `permission_denied` 缺口 |
| **字段缺口**（field gap） | 某个声明为 `admin` 的字段拿不到（他人进程的 `cmdline`、socket→pid） | 不降级，只标记字段不可用 | `fieldGaps[]` + `stats`，不进 `denials` |

不区分这两者的后果是：非 root 主机上每个源永久 `degraded`（信号被淹没），或者把"读不到"
发布成"进程全部退出"（伪造负向证据）。`diff.js` 的 `suppressRemovalsFor` 负责后者：
只有被拒对象自身的移除被抑制，可读范围内的真实删除照常上报。

`denied` 的判定还包含三种"空表"：`/proc` 列出 0 个进程、systemd 目录 0 个单元、cron 全部
声明路径都不存在、四张 net 表全缺 —— 一律 `denied`/`error`，不做成 `ok + 0 条`。

## 4. 集成接口

```js
import { createCursorStore, createEventQueue } from '../common/index.js';
import {
  createLinuxCollectorRuntime, createNodeFileSystem,
  createProcfsProcessSource, createProcfsConnectionSource,
  createJournaldSource, createAuthLogSource,
  createSystemdUnitSource, createCronSource, createDeclaredDirectorySource,
} from '../linux/index.js';

const runtime = createLinuxCollectorRuntime({
  store: createCursorStore({ directory: '/var/lib/aegis/state' }),
  queue: createEventQueue(),
  bootId,                 // 契约要求非空，交由上层注入
});

runtime.addSource({ adapter: createProcfsProcessSource({ fileSystem: createNodeFileSystem(), bootId }) });
runtime.addSource({ adapter: createJournaldSource({ runner: commandRunner /* 见 command.js */ }) });
// ...

const outcome = await runtime.readSource('linux.procfs-processes'); // 不抛：失败即降级
await runtime.probeSource('linux.journald');                        // 事件源每 30 s
runtime.report();      // 每源 lifecycle/freshness/permissions/last_error/last_gap
runtime.gaps.drain();  // 必须由 daemon 落库，否则重启后缺口消失
```

`boot_id`、`integrity`、`native_record_id` 的补齐仍属契约层职责（见
`packages/collectors/common/INTEGRATION.md` §9），本适配层不代做。

## 5. 已知未验证项

- 未在真实 Linux 主机上运行：测试全部使用 JSON fixtures 与内存文件系统，`journalctl`
  由脚本化 runner 代替，测试会断言其 argv，因此不存在"测试里偷偷跑了真实 journalctl"的路径。
- 真实环境中"非 root + 未加入 journal 组"的 `journalctl` 提示文案未实测（本机禁止运行），
  当前按英文提示匹配；本地化环境会被判成 `io_error` 而不是 `permission_denied`。
- 命令白名单是绝对路径列表（`/usr/bin/journalctl` 等），外加裸名 `journalctl` 走 PATH。
- `startTime` 由 `/proc/stat btime + starttime/CLK_TCK` 推导，假设 `CLK_TCK=100`，声明为 `best_effort`；
  `startTicks` 才是权威身份字段。
- `/proc/net/tcp6` 的地址解码按"四个 32 位字、字内字节反序"实现，未在真实 IPv6 主机上交叉验证。
- systemd 单元内容读取为 opt-in（默认只取元数据），drop-in 覆盖与运行时生成单元不在覆盖范围。
