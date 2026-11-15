# CLI 使用说明（`aegis-cli`）

> **版本状态：0.0.1 未发布，不可作为正式版本分发。**
>
> 本文只描述当前源码树里**真实存在**的命令、选项与退出码。
> 没有全局安装包、没有 `npm i -g` 的发布路径，也没有自动补全脚本。

- 包：`@aegisharness/cli`（私有）
- 命令名：`aegis-cli`
- 作者：PT-dove

---

## 1. 它是什么

一个**只读**的回环客户端：向本机 daemon 问四个问题并把答案渲染出来。

设计上被刻意削掉的东西（不是遗漏）：

- 没有 `--force` / `--yes`，没有任何写动词；
- 命令行不能覆盖端点（端点只能来自配置文件）；
- 不能构造任意路径（路由是闭集，见 `apps/cli/src/routes.js`），cursor 只能原样转发、不能自己拼；
- 只发 `GET`，不跟随重定向；
- 不打印 bearer token，也不打印请求头。

---

## 2. 调用方式

当前安装态下 `node_modules/.bin/` 里**没有** `aegis-cli` 链接（只有 `aegis-daemon` 与 `aegis-harness-worker`），
因此直接调用入口文件：

```bash
cd <path-to-checkout>
node apps/cli/bin.js --help
node apps/cli/bin.js status --config ./cli.json
```

前置条件：本机有 Node `>= 24.9.0`（实测环境为 `v24.20.0`），且 daemon 已在回环上监听。

---

## 3. 帮助原文

以下为 `node apps/cli/bin.js --help` 的实际输出（本轮复跑，EXIT=0，38 行，逐行 diff 与文档代码块相同）：

```text
aegis-cli — read-only AegisHarness daemon client

Usage:
  aegis-cli <command> [options]

Commands:
  status                 lifecycle, health, scheduler, pipeline and store counters
  health                 liveness and readiness probes (no token required)
  alerts [--limit N]     recent alerts, newest first
  analysis [<id>]        analysis jobs, or one job by id; --limit is list-only
  help                   this text

Options:
  --json                 one JSON document on stdout, same exit codes
  --config <path>        client configuration (default: $AEGIS_CLI_CONFIG)
  --timeout <ms>         request deadline, 100..120000 (default: 5000)
  --limit <n>            page size for the alerts/analysis lists, 1..100 (default: 50)
  --cursor <opaque>      continue a list from the cursor a previous run printed (max 512 chars)
  --all                  follow next_cursor until the list ends (bounded by --max-pages)
  --max-pages <n>        page cap for --all, 1..100 (default: 10)
  -h, --help             this text

Exit codes:
   0 ok                      7 timeout              13 unhealthy
   1 internal                8 bad response
   2 usage                   9 response too large
   3 config                 10 endpoint unavailable
   4 unreachable            11 rate limited
   5 auth                   12 daemon error
   6 forbidden

Every command is read-only. This client only ever sends GET, never follows a
redirect, never prints the bearer token or a request header, and never reads the
event store, the database or any file other than its own configuration and token.

A cursor is opaque: this client copies it, never decodes or builds one. It is
bound to one endpoint and to the current token, so a rotated token invalidates
every cursor and --cursor then exits 8 asking you to start from the first page.
```

> 本文旧版记录的是**只有 `--limit`、不能翻页**的那一版帮助。翻页选项（`--cursor` / `--all` / `--max-pages`）
> 是 2026-11-03 下午落地的，正文其余各节已按新版对账。若你机器上的帮助与上面不同，以你机器为准。

---

## 4. 命令

| 命令 | 参数 | 需要 token | 说明 |
|---|---|---|---|
| `status` | 无 | 是 | 生命周期、健康、调度器与源、管道、存储计数、计数器 |
| `health` | 无 | **否** | 同时请求 `/healthz` 与 `/readyz`；未就绪时退出码 13 |
| `alerts` | `--limit N`、`--cursor`、`--all`、`--max-pages N` | 是 | 告警列表，按 `last_seen` 降序 |
| `analysis` | `--limit N`、`--cursor`、`--all`、`--max-pages N` | 是 | 分析任务列表，按 `created_at` 降序 |
| `analysis <id>` | 无（**不接受任何翻页选项**） | 是 | 单任务详情。**v0 服务端没有该路由**，当前必然失败（退出码 10） |
| `help` / `-h` / `--help` | 无 | 否 | 输出上文 |

### 参数规则

| 规则 | 行为 |
|---|---|
| `--limit` / `--cursor` / `--all` / `--max-pages` 只被 `alerts` 与 `analysis` 列表接受 | 用在 `status`/`health` 上 → 退出码 2 |
| `analysis <id>` 不接受任何翻页选项 | 同时给 → 退出码 2（detail 模式没有页，也没有页大小） |
| `--max-pages` 必须与 `--all` 同时出现 | 只给 `--max-pages` → 退出码 2（它只约束 `--all`，单独给出没有意义） |
| `--limit` 只接受规范十进制 | `05`、`+5`、`1e2`、`5.0`、含空格 → 退出码 2 |
| `--max-pages` 同规则 | 规范十进制，`1..100`，默认 `10` |
| `--limit` 范围 | `1..100`，默认 `50` |
| `--cursor` 文法 | 非空、≤ `512` 字符、仅 `[A-Za-z0-9._~-]`；不合法 → 退出码 2，**不回声**原值 |
| `--timeout` 范围 | `100..120000` 毫秒，默认 `5000` |
| `--json` 只作开关 | `--json=true` → 退出码 2 |
| 未知选项 / 缺值 | 退出码 2，不回声原始 argv |
| `<id>` 文法 | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`，且不含 `..` |

### 翻页语义（`--cursor` / `--all` / `--max-pages`）

- 默认只取**一页**：`has_more: true` 时把 `next_cursor` 打印出来，不自动续页。
- `--all` 会跟着 `next_cursor` 一路读完，最多 `--max-pages` 页（默认 10，上限 100）；
  因页数上限停下时结果是 `truncated: true` + `has_more: true`，**不是失败**（退出码仍 0）。
- cursor 是**不透明**的：客户端只复制、不解码、不构造。它绑定「一个端点 + 当前 token」，
  轮换 token 后所有旧 cursor 失效，daemon 会以 `400 CURSOR_INVALID` 拒绝，客户端报
  `BAD_RESPONSE`（退出码 8）并提示从第一页重取。
- 同一次走查内如果 daemon 返回重复 cursor（`PAGINATION_LOOP`）或跨页重复同一 id
  （`PAGINATION_DUPLICATE`），客户端按退出码 8 报错，而不是把重复行拼进结果。
- `alerts` 的排序键 `last_seen` 会被合并抬高，所以翻页**只用于浏览/回溯，不用于完整导出**；
  一致性边界见 [06-api.md](./06-api.md) §5。

---

## 5. 配置

### 5.1 位置

优先级：`--config <path>` > 环境变量 `AEGIS_CLI_CONFIG`。两者都没有 → 退出码 3（`CONFIG_NOT_FOUND`）。

### 5.2 允许的键（只这四个）

| 键 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `endpoint` | string | 是 | 必须是 `http://` + 字面回环地址（`127.0.0.1` 或 `[::1]`）+ **显式端口**；不得带路径、查询串、片段或凭据 |
| `tokenFile` | string | 认证命令必填 | 普通文件（非符号链接）；POSIX 上不得组/其他可读（`0600`）；内容为 32..512 个 `[A-Za-z0-9_-]` |
| `timeoutMs` | integer | 否 | `100..120000`，默认 `5000` |
| `maxResponseBytes` | integer | 否 | `1024..8388608`，默认 `1048576` |

**未知键直接报错**（`CONFIG_INVALID`，退出码 3），不会静默忽略——避免拼错的
`maxResponseByte` 让人误以为限值生效。

### 5.3 示例

```json
{
  "endpoint": "http://127.0.0.1:8787",
  "tokenFile": "<data-dir>/secrets/api-token",
  "timeoutMs": 5000,
  "maxResponseBytes": 1048576
}
```

说明：

- `8787` 只是示例。daemon 默认 `api.port = 0`（临时端口），必须显式配一个固定端口才能对得上；
  否则要从 daemon 启动日志里的 `daemon ready` 记录里读出实际端口。
- `tokenFile` 的相对路径按**配置文件所在目录**解析，不按当前工作目录。
- `endpoint` 写 `localhost` 会被拒绝：daemon 只接受字面回环地址的 `Host`，用域名会绕过这层一致性检查。

### 5.4 token 文件

- daemon 首次启动会在 `<dataDir>/secrets/api-token` 生成，权限 `0600`。
- CLI 侧只做三件事：`lstat` 检查（非符号链接、普通文件）、POSIX 权限检查、读取后按文法校验。
- token 值**不会**出现在 `--json` 的 `error.details` 里（details 是键白名单）。

---

## 6. 退出码

| 码 | 含义 | 典型触发 |
|---|---|---|
| 0 | 成功 | 命令完成 |
| 1 | 内部错误 | 未登记的异常（不会被静默吞掉） |
| 2 | 用法错误 | 未知命令/选项、`--limit` 越界、`analysis <id> --limit` |
| 3 | 配置错误 | 找不到配置文件、JSON 非法、未知键、端点不合格、token 文件不合规 |
| 4 | 连不上 | 端口没监听、连接被拒 |
| 5 | 认证失败 | 未带 bearer / token 不匹配 |
| 6 | 被拒绝 | 非回环对端（`PEER_REJECTED`）等 |
| 7 | 超时 | 超过 `--timeout` / `timeoutMs` |
| 8 | 响应不合契约 | 缺 `page`、`page.returned` 与行数不一致、元素不是对象、cursor 被 daemon 拒绝（`CURSOR_INVALID`）、翻页重复 cursor / 重复 id |
| 9 | 响应过大 | 超过 `maxResponseBytes` |
| 10 | 端点不可用 | 404/405，包括 v0 未提供的 `analysis <id>` |
| 11 | 被限流 | 认证失败次数超窗口（带 `Retry-After`） |
| 12 | daemon 侧错误 | daemon 返回 `5xx` 且带错误码 |
| 13 | 未就绪 | `health` 收到 `ready:false` |

> 脚本请分支退出码，不要 grep 文案。文案会变，退出码是契约。

---

## 7. `--json` 输出

**无论成功失败，stdout 只有一个 JSON 文档**；退出码仍然承载失败原因。

成功：

```json
{
  "schema_version": "1.0",
  "ok": true,
  "command": "alerts",
  "data": {
    "limit": 50,
    "returned": 0,
    "has_more": false,
    "byte_limited": false,
    "order": "last_seen_desc",
    "pages": 1,
    "truncated": false,
    "next_cursor": null,
    "items": []
  }
}
```

失败：

```json
{
  "schema_version": "1.0",
  "ok": false,
  "command": "status",
  "error": {
    "code": "CONFIG_NOT_FOUND",
    "message": "no client configuration: pass --config <path> or set AEGIS_CLI_CONFIG",
    "exit_code": 3
  }
}
```

> 上面两段是**结构示意**（取自实现的信封定义），不是某次运行的抓取结果。
> 真实字段值以你机器上的 daemon 状态为准。

### 各命令的 `data` 形状

| 命令 | `data` 键 |
|---|---|
| `status` | `daemon`、`health`、`scheduler`（含 `sources[]`）、`pipeline`（含 `detection`）、`store`（`kind`/`open`/`counts`）、`counters`、`csrf_token_present` |
| `health` | `ok`、`liveness`（`status`/`version`/`http_status`）、`readiness`（`ready`/`lifecycle`/`reasons`/`http_status`） |
| `alerts` | `limit`、`returned`、`has_more`、`byte_limited`、`order`、`pages`、`truncated`、`next_cursor`、`items[]` |
| `analysis`（列表） | 同上结构，`items[]` 为分析行 |
| `analysis <id>` | `id`、`item` |

列表视图里三个翻页字段的口径：

- `returned` 是**本次走查合并后的总行数**（`--all` 走多页时不是最后一页的行数）。
- `pages` 是这次调用实际发出的请求数；单页读时为 `1`。
- `truncated` 只在 `--all` 撞到 `--max-pages` 且仍有数据时为 `true`，用来区分
  「daemon 说还有」（`has_more`）和「这次没读完」（`truncated`）。
- `next_cursor` 可直接喂给 `--cursor`；没有更多数据时为 `null`。

告警行字段：`alert_id`、`rule_id`、`rule_version`、`severity`、`status`、`count`、
`first_seen`、`last_seen`、`window_start`、`window_end`、`evidence_count`、`evidence_truncated`。

分析行字段：`analysis_id`、`alert_id`、`state`、`budget_class`、`attempts`、
`created_at`、`updated_at`、`completed_at`、`report_available`。

`status` 里只报 `csrf_token_present`（布尔），**不输出** token 值。

---

## 8. 已知限制

| 限制 | 后果 | 规避 |
|---|---|---|
| `analysis <id>` 在 v0 不可用 | 退出码 10 | 用 `analysis --limit` 看列表 |
| 翻页是 keyset，不是快照 | 翻页期间被合并的告警会被跳过（不会重复），`has_more` 可能提前变 `false` | 需要完整视图时从首页 + 时间窗口重读；不要把它当导出 |
| `--all` 有页数上限 | 超过 `--max-pages`（默认 10，上限 100）就停，结果标 `truncated: true` | 用打印出的 `next_cursor` 接着走 |
| 未与真实 daemon 端到端验证 | 测试全部走进程内 mock loopback | 首次对真机使用时按「配置 → health → status → alerts」逐步排查 |
| 端点必须是字面回环 + 显式端口 | `localhost`、缺端口、`https` 均被拒 | 照 5.3 示例写 |
| 无全局 bin | 只能 `node apps/cli/bin.js` | 自行建别名或用绝对路径 |
| 不做重定向 | daemon 若返回 3xx 会按协议错误处理 | 不要在前面挂代理 |

---

## 9. 排查顺序

```text
1. node apps/cli/bin.js health --config <cfg>
   ├─ 退出码 3 → 配置/端点/token 路径问题，看 §5
   ├─ 退出码 4 → daemon 没起，或端口不对（读 daemon 日志的 "daemon ready" 行）
   └─ 退出码 13 → daemon 起来了但未就绪，看 readiness.reasons

2. node apps/cli/bin.js status --config <cfg>
   ├─ 退出码 5 → token 不匹配：确认用的是同一个 dataDir 下的 token 文件
   └─ 退出码 8 → 响应不符合契约，检查 daemon 版本与 CLI 是否同源

3. node apps/cli/bin.js alerts --limit 20 --config <cfg>
   └─ 空列表不等于没告警：先确认 daemon 真的有采集源在跑（full 模式需宿主注入）
```
