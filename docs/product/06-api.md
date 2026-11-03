# 只读查询 API（v0）

> **版本状态：0.0.1 未发布，不可作为正式版本分发。**
>
> 本文是 `docs/implementation/M7_API_CONTRACT.md` 的**使用向摘要**。
> 两者冲突时以契约为准；契约变更必须升版本，不得静默修改。

- 契约版本：`v0`（只读）
- 作者：PT-dove
- 服务端：`apps/daemon/src/api/`

---

## 1. 范围

本 API 是 daemon 的**只读查询面**，只绑定回环地址，只有两个端点，且都只接受 `GET`：

```text
GET /api/v1/alerts
GET /api/v1/analysis
```

**不在本契约内**：任何写操作、响应执行、审批、单条详情路由。
`GET /api/v1/alerts/{id}` 与 `GET /api/v1/analysis/{id}` 在 v0 **不提供**，请求返回 `404 NOT_FOUND`。

> 单条详情在实现里有一条「前向兼容」分支（CLI 的 `analysis <id>`），但服务端不提供，因此当前一定失败。

---

## 2. 同进程的其它端点（真实存在，但不属于本契约）

| 端点 | 方法 | 认证 | 用途 |
|---|---|---|---|
| `/healthz` | GET | 无 | 存活探针，返回 `{ status, version }` |
| `/readyz` | GET | 无 | 就绪探针，返回 `{ ready, lifecycle, reasons }`，未就绪时 `503` |
| `/api/v1/status` | GET | Bearer | 运维状态快照（CLI `status` 使用） |
| `/api/v1/collectors/{id}/poll` | POST | Bearer + Origin + CSRF | **内部**采集轮询，供采集器取任务；不属于对外只读契约，本文不提供用法 |

`/healthz` 与 `/readyz` 位于认证之前，所以服务管理器可以在没有凭据的情况下区分「没起来」和「起来了但没准备好」。
`/api/v1/status` 的响应里带一个 CSRF 证明，供状态变更请求使用；只读客户端不会使用它，也不应转发或落盘。

---

## 3. 准入顺序

顺序固定，任一环失败即拒绝，后续环节不执行（与 `apps/daemon/src/api/server.js` 的 `dispatch()` 逐环对应）：

```text
peer 必须是回环
  → [内部] 监听态
  → Host 必须是回环端点
  → 方法族（仅 GET/POST）
  → /healthz、/readyz：此处直接返回（探针在认证之前短路，不需要 Bearer）
  → /api/v1/ 前缀之外的路径：404（仍在认证之前）
  → [/api/v1/*] Bearer token
  → [仅状态变更请求] Origin + CSRF
  → 路由与动词
  → 处理器
```

> 上面前两行不是本契约的端点，但在同一条判定链上，漏掉它们会得出「探针要 Bearer」的错误结论。
> 契约 §2 只描述 `/api/v1/*` 那一段。

| 情形 | 错误码 | 状态 |
|---|---|---|
| 未携带 bearer | `AUTH_REQUIRED` | `401` |
| bearer 与预期 token 不匹配 | `AUTH_FAILED` | `401` |
| 同 peer 窗口内失败次数超限 | `AUTH_RATE_LIMITED` | `429`（带 `Retry-After`） |
| peer 非回环 | `PEER_REJECTED` | `403` |
| `Host` 非回环端点 | `HOST_REJECTED` | `421` |

两处 `404`/`405` 发生在不同环节，容易误判：

| 请求 | 结果 | 原因 |
|---|---|---|
| 未认证 `OPTIONS /api/v1/alerts` | `405` | 方法族先于认证 |
| 未认证 `GET /nope` | `404` | `/api/v1/` 前缀先于认证 |
| 未认证 `POST /api/v1/alerts` | `401` | 前缀内先认证 |
| 未认证 `GET /api/v1/nope` | `401` | 同上，不是 404 |
| 已认证 `PUT /api/v1/alerts` | `405` | 方法族环节就拒了，与认证无关；未认证的 `PUT` 同样 405 |

只读端点**不**要求 `Origin` / CSRF。

### 响应头（所有响应，含错误）

```text
cache-control: no-store
x-content-type-options: nosniff
referrer-policy: no-referrer
content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'
x-frame-options: DENY
content-type: application/json; charset=utf-8
```

---

## 4. 查询参数（封闭表面）

只接受 `limit` 与 `cursor`。未知参数、重复参数、空值参数 → `400 QUERY_INVALID`。

| 参数 | 规则 | 默认 |
|---|---|---|
| `limit` | 十进制整数 `1..100`；`+5`、`1e2`、`05`、`5.0`、含空格一律拒绝 | `50` |
| `cursor` | 不透明字符串，≤ `512` 字符；不得解析、修改、拼接、跨端点复用 | 无 |

解析口径：

- 参数名在 percent-decoding **之后**按**大小写敏感**精确匹配（`LIMIT` 是未知参数）。
- 空段（尾随 `&`）忽略；但出现过的参数其值不得为空（`?limit=` 直接 `400`）。
- 同一参数出现两次即 `400`，即使取值相同。

---

## 5. 分页

采用 keyset（游标）翻页，不做 offset。

| 端点 | 排序 | 排序键可变性 |
|---|---|---|
| `alerts` | `last_seen` 降序，`alert_id` 降序 tiebreak | **可变**：合并新事件会抬高 `last_seen` |
| `analysis` | `created_at` 降序，`analysis_id` 降序 | 不可变，写入后不变 |

`next_cursor` 仅在还有更多数据时非空。

### cursor 编码

```text
cursor = base64url(载荷) + "." + base64url(HMAC-SHA256(密钥, 载荷))
```

- 载荷：版本(0x01) | 端点标签(0x01=alerts, 0x02=analysis) | 起始毫秒(int64 大端) | id 长度 | id 字节。
- 密钥由 API token **单向派生**：轮换 token 会让所有旧 cursor 失效（`CURSOR_INVALID`，从首屏重取即可）。
- 拒绝原因：`malformed` / `signature` / `kind` / `too_long`，都返回 `400 CURSOR_INVALID`。
- 错误响应**不回显** cursor 内容。

### 一致性边界（重要）

| 情形 | 结果 |
|---|---|
| 翻页期间该行未被合并更新 | 严格不重不漏 |
| 翻页期间该行被合并、`last_seen` 抬到游标之前 | 本次序列**不会**再返回它；后续 `has_more` 可能已为 `false` |
| 翻页期间新插入行 | 可能出现在较早页（keyset 固有行为） |

因此：**alerts 分页用于浏览/回溯，不用于「完整导出」**。
需要完整视图时按首页 + 时间窗口重读。该漂移不会造成重复（谓词是严格 `<`），只会漏，且从首屏重拉可自愈。

---

## 6. 响应体

### `GET /api/v1/alerts`

```json
{
  "alerts": [],
  "page": {
    "limit": 50,
    "returned": 0,
    "has_more": false,
    "next_cursor": null,
    "order": "last_seen_desc",
    "byte_limited": false
  }
}
```

### `GET /api/v1/analysis`

```json
{
  "analyses": [],
  "page": {
    "limit": 50,
    "returned": 0,
    "has_more": false,
    "next_cursor": null,
    "order": "created_at_desc",
    "byte_limited": false
  }
}
```

`page` 字段：`limit`（生效页大小）、`returned`（实际条数）、`has_more`、`next_cursor`、
`order`（字面常量，不随请求变化）、`byte_limited`（是否因字节上限裁过行；裁行后 `next_cursor` 指向被裁处，不丢行）。

空结果返回空数组，不省略键。

---

## 7. 字段（白名单）

字段是白名单：条目里**恰好**这些字段，多一个都不行。

### 7.1 alerts

| 字段 | 类型 | 说明 |
|---|---|---|
| `alert_id` | string | 告警标识 |
| `rule_id` | string | 规则标识 |
| `rule_version` | string | 规则语义化版本 |
| `severity` | string | 严重度枚举 |
| `status` | string | `new` / `acknowledged` / `resolved` / `suppressed` |
| `count` | integer | 聚合次数 |
| `first_seen` / `last_seen` / `window_start` / `window_end` | string | RFC 3339 UTC；`last_seen` 是排序主键 |
| `evidence_count` | integer | 告警行内**已留存事件 id 的条数**（`count` 可能大于它） |
| `evidence_truncated` | boolean | 事件 id 列表是否被截断 |

`evidence_count` 的口径唯一：它是 `alert` 行里 `event_ids` 列表的长度，**不是** `evidence` 表的行数。

### 7.2 analysis

| 字段 | 类型 | 说明 |
|---|---|---|
| `analysis_id` | string | 分析标识 |
| `alert_id` | string | 关联告警 |
| `state` | string | 分析状态 |
| `budget_class` | string | 预算档位 |
| `attempts` | integer | 已尝试次数 |
| `created_at` / `updated_at` | string | 排序主键为 `created_at` |
| `completed_at` | string \| null | 未完成时为 `null` |
| `report_available` | boolean | 是否已有报告行；未知时 `false` |

---

## 8. 脱敏硬约束（作用于第 1 节的两个查询端点）

**作用域**：`GET /api/v1/alerts` 与 `GET /api/v1/analysis`（契约 §7 的约束对象）。这两个端点的响应体任何位置都不得出现：

```text
event_ids 原数组、evidence_refs、fingerprint、canonical_json / canonical_digest、
summary_json / summary_digest、idempotency_key、owner、failure_reason、
任何 lease 字段、任何文件系统路径、token / CSRF 值、prompt、
原始 telemetry 载荷、规则包内容
```

投影必须逐字段显式取值（白名单），不得整行展开后删字段——否则新增存储列会自动泄漏。

**不在本节作用域内**：`/api/v1/status`（第 2 节）**会**回传 `csrf_token`，那是状态变更请求要用的证明。它不是查询端点的字段，也不属于契约 §7 的约束对象，但性质等同凭据：不得落盘、不得转发。详见 [02-security-boundary.md](./02-security-boundary.md) §6.2。

---

## 9. 错误码

统一形状：

```json
{
  "error": {
    "code": "QUERY_INVALID",
    "message": "query parameter is not accepted",
    "details": { "parameter": "offset" }
  }
}
```

| 错误码 | 状态 | 含义 |
|---|---|---|
| `QUERY_INVALID` | 400 | 查询参数不合法（未知/重复/空值/`limit` 格式或越界） |
| `CURSOR_INVALID` | 400 | cursor 不合法（`malformed` / `signature` / `kind` / `too_long`） |
| `AUTH_REQUIRED` | 401 | 未携带 bearer |
| `AUTH_FAILED` | 401 | token 不匹配 |
| `AUTH_RATE_LIMITED` | 429 | 认证失败超限，带 `Retry-After` |
| `PEER_REJECTED` | 403 | 对端非回环 |
| `HOST_REJECTED` | 421 | `Host` 非回环端点 |
| `METHOD_NOT_ALLOWED` | 405 | 认证通过后对这两个端点使用非 `GET`；`PUT`/`DELETE`/`PATCH`/`OPTIONS` 更早，在方法族一环就被拒（未认证同样 405） |
| `NOT_FOUND` | 404 | 无此端点（含 `/api/v1/analysis/{id}`） |
| `REQUEST_TIMEOUT` | 408 | 处理超时 |
| `STORE_UNAVAILABLE` | 503 | 存储不可用（未打开/打不开/损坏/读超时/不可表示为 cursor 的行） |
| `INTERNAL` | 500 | 未预期故障 |
| `MALFORMED_REQUEST` | 400 | 传输层拒绝（请求行/头无法解析或超限），不经过 API 路由 |

`details` 只放标识符、计数器与短原因词，不含路径与堆栈；`details.parameter` 超过 64 字符时整体替换为 `"<unknown>"`。

---

## 10. 上限

| 项 | 值 |
|---|---|
| `limit` 默认 / 上限 | `50` / `100` |
| `cursor` 长度上限 | `512` 字符 |
| 单响应体上限 | `256 KiB`（`262144` 字节） |

响应体超限时**按行裁剪**而非报错，至少保留 1 行，被裁处用 `next_cursor` 续页，此时 `byte_limited: true`。

> 可达性说明（契约原文）：`limit ≤ 100` 且字段集固定时，单条投影约 300–450 字节，整页最大约 40 KB，
> 远低于 256 KiB，**正常数据下 `byte_limited: true` 不会被触发**。它是护栏，不是常规路径；
> 裁剪与续页逻辑只有 `buildPage` 的小 `byteCap` 单测覆盖，端点级用例覆盖不到。

---

## 11. 数据来源与一致性

- 读取走只读句柄 `openStore({ path, readOnly: true })`；首次查询时打开并缓存，大库上首个请求可能明显慢。
- **只读不等于目录只读**：SQLite 在 WAL 库上会创建 `-wal` / `-shm`，数据目录必须可写，否则 `503`。
- **不存在跨页快照**：没有全局事务，翻页期间的并发写入可见。
- 存储不可用 → `503 STORE_UNAVAILABLE`，**不得**返回空列表冒充「没有告警」。

---

## 12. 兼容性

属于兼容性契约、改名即破坏客户端的部分：

- 信封键 `alerts` / `analyses` / `page`；
- `page` 内的键名与 `order` 字面量（`last_seen_desc` / `created_at_desc`）；
- 第 7 节全部字段名；
- `limit` 上限 `100`（CLI 的 `?limit` 正则同为 `(?:[1-9]|[1-9]\d|100)`）。

v0 之后任何下列变化都必须升版本并单独独立审查：

- 字段增删或改名；
- 排序键或方向变化；
- 错误码增删或状态码变化；
- cursor 格式（载荷布局、标签、MAC、密钥派生）变化；
- `page` 结构或上限值变化。

---

## 13. 未验证项（不要当成已保证）

| 项 | 状态 |
|---|---|
| `SQLITE_BUSY → 503` | 未实测 |
| `byte_limited` 的端点级触发 | 正常数据不可达，仅单测覆盖 |
| 真实 daemon + 真实客户端的端到端调用 | CLI 侧测试全部为进程内 mock loopback，未做真实进程对跑 |
| 大库首次查询的延迟 | 无实测数据 |
| 多客户端并发翻页 | 未做并发压测 |
