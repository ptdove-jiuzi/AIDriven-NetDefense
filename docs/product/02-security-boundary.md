# 安全边界

> **版本状态：0.0.1 未发布，不可作为正式版本分发。**
>
> 本文对应开发树 `0.0.0`，描述 2026-11-03 代码中**实际存在**的边界；
> 未经实测的属性会在「不保证」一节明确列出，不得当作已满足。

- 作者：PT-dove

---

## 1. 边界总览

```text
        本机                                   本机之外
┌──────────────────────────────────┐
│  采集源 ──▶ daemon ──▶ SQLite    │
│              │                   │
│              └─▶ 回环 HTTP ──▶ CLI │   ← 唯一的入站网络面
│                                  │
│  harness-worker ─▶ model-broker ─┼──▶ 模型端点（唯一出站方向）
│                                  │
│  response-helper（只出计划）      │
└──────────────────────────────────┘
```

下面按「面」拆开说明：入站网络、准入、凭据、数据落地、出域、执行、插件、审计。

---

## 2. 入站网络面：只有回环，只有 HTTP

- daemon 的 API 只允许绑定 `127.0.0.1` 或 `::1`（`apps/daemon/src/config.js` 的 `LOOPBACK_HOSTS`）。
  **不接受 `localhost`**（会经过名称解析），不接受通配地址。
- 协议是**明文 HTTP/1.1**，没有 TLS 监听器。CLI 也因此只接受 `http://` 端点。
- daemon 自己的默认端口是 `0`（启动时由系统分配临时端口，`apps/daemon/src/config.js:48`）；
  已构建的桌面壳会先写一个固定候选端口 `17802`，被占用就 +1 重试
  （`apps/desktop/aidn/settings.py:26`、`apps/desktop/aidn/daemon.py:155-169`），
  所以装好的产品里实际端口通常不是 0——以 `data\shell\daemon.conf.json` 为准。
- 除 API 外没有其它监听端口；没有对外 UDP、没有 DNS 服务、没有内置反向代理。

**推论**：把它放到容器里做端口映射、或在前面挂反向代理，会直接破坏这条边界。
0.0.1 不支持任何非回环部署形态，也没有为此做过验证。

---

## 3. 准入链（顺序固定，任一环失败即拒绝）

`/api/v1/*` 部分来自 `docs/implementation/M7_API_CONTRACT.md` §2；整条链与 `apps/daemon/src/api/server.js` 的 `dispatch()` 判定顺序一一对应：

```text
[任何请求]
peer 必须是回环
  → [内部] 监听态
  → Host 必须是回环端点
  → 方法族（仅 GET/POST）
  → /healthz、/readyz：此处直接返回（探针在认证之前短路）
  → /api/v1/ 前缀之外的路径：404（仍在认证之前）
  → [/api/v1/*] Bearer token
  → [仅状态变更请求] Origin + CSRF
  → 路由与动词
  → 处理器
```

| 环节 | 规则 | 失败结果 |
|---|---|---|
| peer | 仅 `127.0.0.1`、`::1`、`::ffff:127.0.0.1` | `403 PEER_REJECTED` |
| Host | 必须是字面回环地址；带端口时须等于实际监听端口 | `421 HOST_REJECTED` |
| 方法族 | 只接受 `GET`/`POST`；`PUT`/`DELETE`/`PATCH`/`OPTIONS` 在认证之前拒绝 | `405 METHOD_NOT_ALLOWED` |
| 探针 | `/healthz`、`/readyz` **不要求** Bearer，也不参与限流计数；在这条链上位于认证之前 | 未就绪时 `/readyz` 返回 `503`（不是认证错误） |
| 前缀 | `/api/v1/` 之外的路径在认证前 404 | `404 NOT_FOUND` |
| 认证 | `Authorization: Bearer <token>` | `401 AUTH_REQUIRED` / `401 AUTH_FAILED` / `429 AUTH_RATE_LIMITED` |
| 路由动词 | `/api/v1/` 前缀内的路由与动词在认证**之后**判定 | `404 NOT_FOUND` / `405 METHOD_NOT_ALLOWED` |

四个容易误判的细节（契约原文有，运维常踩）：

- 未认证的 `OPTIONS /api/v1/alerts` 是 **405**（方法族先拒）；**已认证**的 `PUT /api/v1/alerts` 同样是 **405**，且原因相同——它根本没走到认证，被判在方法族这一环。
- 未认证的 `GET /nope` 是 **404**（前缀先拒）。
- 未认证的 `GET /api/v1/nope` 是 **401**，不是 404——认证先于前缀内路由。
- `GET /healthz`、`GET /readyz` 永不返回 `401`：探针在认证之前已短路返回。把它们也算作「需要 Bearer」会让服务管理器拿不到存活状态。

只读端点**不**要求 `Origin`/CSRF。所有响应（含错误响应）固定带：

```text
cache-control: no-store
x-content-type-options: nosniff
referrer-policy: no-referrer
content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'
x-frame-options: DENY
content-type: application/json; charset=utf-8
```

---

## 4. 凭据

| 项 | 事实 |
|---|---|
| 形态 | 单一 Bearer token，无用户名、无角色、无多租户 |
| 文法 | `32..512` 个 `[A-Za-z0-9_-]`（base64url 字符集） |
| 存放 | 默认 `<dataDir>/secrets/api-token`，创建时 `0600`；也允许配置内联 `api.token` |
| 生成 | daemon 启动时若文件不存在则生成；已存在则沿用 |
| 传递 | 只在 `Authorization` 头；**不得**出现在 URL、日志、响应体 |
| 客户端校验 | CLI 拒绝符号链接、拒绝非普通文件、POSIX 上拒绝组/其他可读（`mode & 0o077 != 0`） |
| 轮换 | 轮换 token 会使全部旧 cursor 失效（cursor 密钥由 token 单向派生） |

**没有做**：token 的过期、吊销列表、作用域、审计化的密钥轮换流程。
持有 token 的任何本地进程都能读取全部告警与分析元数据。

---

## 5. 数据落地

- `dataDir` 必须显式给出，没有默认值。
- 所有派生路径（库文件、状态文件、token 文件、规则包路径）都会被解析并校验**留在 `dataDir` 内**；
  越界直接拒绝启动（`apps/daemon/src/config.js` 的 `resolveInside`）。
- 数据目录**必须可写**：SQLite WAL 会创建 `-wal` / `-shm` 边车文件。
  只读查询用的是 `PRAGMA query_only=1` 连接，但目录只读会导致 `503 STORE_UNAVAILABLE`。
- 容量与保留：默认库上限 2 GiB、WAL 上限 1 GiB；80% 高水位开始清理，90% 临界停止新分析与新响应并写降级状态；
  数据卷可用空间低于 8 GiB 按临界处理。高严重度告警任何情况下不删。

---

## 6. 出域约束（API 投影与模型出口两处，另有 status 例外）

### 6.1 两个查询端点的投影白名单

**作用域只有两个端点**：`GET /api/v1/alerts` 与 `GET /api/v1/analysis`（契约 §7 的约束对象就是这两个端点）。
在这两个端点的响应体里，**任何位置**都不得出现：

```text
event_ids 原数组、evidence_refs、fingerprint、canonical_json / canonical_digest、
summary_json / summary_digest、idempotency_key、owner、failure_reason、
任何 lease 字段、任何文件系统路径、token / CSRF 值、prompt、
原始 telemetry 载荷、规则包内容
```

允许出域的只有告警/分析的元数据与计数（`severity`、`count`、`evidence_count` 等）。
投影必须逐字段显式取值（白名单），不得整行展开后删字段。

### 6.2 `/api/v1/status` 是例外：它回传 CSRF 证明

上面那张清单**不覆盖** `/api/v1/status`。实现显式回传 CSRF 证明：

```js
// apps/daemon/src/api/server.js，status 分支
return sendJson(res, 200, { ...payload, csrf_token: auth.csrfToken });
```

- 该值由 API token 单向派生（`sha256("aegis-csrf:" + token)` 的 base64url），**不是独立凭据，但足以充当状态变更请求的 `x-aegis-csrf` 头**（`apps/daemon/src/api/auth.js`）。
- 因此 `GET /api/v1/status` 的响应**不得落盘、不得转发、不得贴进工单或聊天记录**；只在内存里用，用完即弃。
- 只读客户端只投影存在性：CLI `status` 输出 `csrf_token_present`（布尔），**不输出值**（见 [05-cli.md](./05-cli.md) §7）。
- 不要把本节读成「任何响应都不带 CSRF 值」——那是修复前本文件的错误表述。契约 §7 的作用域自始至终只有 §6.1 的两个查询端点。

### 6.3 模型出口

- 设计上 `apps/model-broker` 是**唯一**模型出口：准入、预算预留、脱敏、固定端点、不重试、不自动切换模型。
- 当前只用回环桩 broker 与测试凭据验证过；**未接真实生产密钥，未观测真实出网行为**
  （见 [04-gaps.md](./04-gaps.md) 第 6 项）。
- 产物事实：rc.5 载荷 `dist/bundle/win32-x64-v17` 里**没有** `@aegisharness/model-broker`，
  全树也没有 `console-host.js`，`bundle.json` 0 处提及（核对输出见
  `evidence/docs/privacy/09-defaults-and-payload.txt`）。因此在这个产物里模型出口**不可达**，
  daemon 走到 broker 路径只会得到 503（`apps/daemon/src/api/broker-client.js:28-30`）——
  这不改变上面的设计边界，但意味着“已构建产物有没有出站面”与“设计上允许什么”要分开看。
- Harness 侧只暴露两个防御工具，模型面来自真实的 `systemPrompt.assemble()` 与工具 schema
  （`docs/implementation/status/WP0-HARNESS.md` 的记录）。

---

## 7. 执行面

- `apps/response-helper/src/build.js`：

  ```js
  export const EXECUTION_ENABLED = false;
  ```

  这是**编译期常量**，不是配置项。没有环境变量、构造参数或信封字段能打开它。
- `executeStub()` 不读取参数，恒返回 `status: 'dry_run_only'`、`performed: false`。
- 派发信封是**封闭形状**：未声明的键直接拒绝；信封里没有任何 command / argv / shell / script / path 字段，
  因此没有可注入的命令行。
- 动作允许列表是字面量 6 项：`observe.record_alert`、`process.suspend`、`process.terminate`、
  `network.block_connection`、`network.isolate`、`file.quarantine`，与策略包的动作目录有测试强制对齐。

**结论**：本构建**不具备**终止进程、封禁连接、隔离主机、隔离文件的能力。
所有「响应」产物都是计划文本，不产生副作用。

---

## 8. 插件面

- `apps/plugin-manager` 只做**离线校验**：读取解包后的插件目录，检查清单与兼容性。
- **绝不加载、绝不执行**插件代码。
- 没有 shell、没有任意文件/网络访问、没有 MCP 能力被启用。

---

## 9. 审计与保留

- 事件存储有 `audit_event` 表与哈希前驱链；保留扫描**不删审计中间行**（删了会断链）。
- 默认保留：遥测 30 天、告警 180 天、审计 180 天、分析索引 7 天。
- **未独立验证**：daemon 全链路的审计写入覆盖面、哈希链在异常中断后的可验证性。
  这是记录缺口，不是已证明的保证。

---

## 10. 明确「不保证」的安全属性

以下每一条都**没有**证据支撑，不得在对外材料中暗示成立：

| 属性 | 现状 |
|---|---|
| 交付物来源可验证 | 无代码签名、无证书、无 `signtool`/`osslsigncode` 调用 |
| 安装/升级过程安全 | 有安装器（rc.5 `AIDrivenNetDefense-Setup-0.0.1-rc.5.exe`，带卸载项）与便携版启动器，但**无代码签名**；**无升级器**（`AUTO_UPDATE_ENABLED = 0`，`apps/desktop/updater/constants.py:24`；唯一读取点 `engine.py:146`；更新器未被壳装配——`apps/desktop/aidn/**` 无引用，`apps/desktop/main.py:32-33` 只装配 `aidn.app.ShellController`）；**无服务单元**（安装/便携都不装常驻服务） |
| 传输机密性 | 明文 HTTP，无 TLS；依赖回环这一事实，不依赖加密 |
| 多用户隔离 | 不存在。单 token，单写者，所有持 token 者权限相同 |
| 执行隔离 | 无 OS 级沙箱（`apps/sandbox-launcher/` 为空目录） |
| 抗本地提权 | 未评估。有 `dataDir` 写权限的本地攻击者可替换 token 或库文件 |
| 抗恶意插件 | 只做到「不执行插件代码」；未做插件内容语义审核 |
| 真实攻击面验证 | 除 `tests/security-corpus` 420 条语料外，**未做**渗透测试、模糊测试、真实攻防对抗 |
| 长时间稳定性 | 浸泡与基准测试**不在门禁内**。认证限流（D-1）**已修**并按功能语义验证过（合法 token 不被他人失败连带拒绝、错误 token 仍 429），但**未做性能复证**；RSS 增长仍待处理 |
| 生产密钥安全 | 未接过真实凭据，轮换/吊销的真机行为未观测 |

---

## 11. 部署者必须自己承担的责任

在 0.0.1 冻结前如果要内部试用，下列事项由部署者负责，且没有产品化支撑：

1. 只在本机回环上使用，**不要**做端口转发、反向代理、容器端口映射。
2. `dataDir` 放在权限受控的位置；不要把 token 文件复制到共享目录或版本库。
3. 不要把真实生产日志、真实用户数据导入测试；测试只允许临时目录与无害合成数据。
4. 不要把它当作生产防护设备；它目前是**观测与记录**工具，不是阻断工具。
5. 发现疑似漏洞按 `SECURITY.md` 走私下报告，不要开公开 issue，不要附带凭据或未脱敏证据。

---

## 12. 与安全相关的文档索引

| 主题 | 位置 |
|---|---|
| 只读 API 完整契约（准入、脱敏、错误码） | `docs/implementation/M7_API_CONTRACT.md` |
| 漏洞报告流程 | `SECURITY.md` |
| 安全语料门禁 | `tests/security-corpus/`、`docs/implementation/status/M9-GATE.md` |
| 许可与第三方声明 | `THIRD_PARTY_NOTICES`、`sbom.cdx.json` |
| 未验证项汇总 | [04-gaps.md](./04-gaps.md) |
