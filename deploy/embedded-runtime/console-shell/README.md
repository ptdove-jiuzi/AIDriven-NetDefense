# console-shell —— 打包层的最小控制台壳（不是产品界面）

- 作者：PT-dove
- 角色：`deploy/embedded-runtime/profiles/{daemon-console,desktop}.json` 里
  `assets.console.shellSource / serverFallback` 指向的**兜底**静态服务器。
- 适用对象：**旧版产品页** `apps/console/`（478 行的 `index.html` + `app.js` + `styles.css`），
  它的页面只读，全部请求都是 `GET /healthz`、`GET /api/v1/{status,alerts,analysis}`。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 只绑 `127.0.0.1` 的静态服务器（服务与 `serve.mjs` 同目录的文件） | 不是认证边界（token 校验在 daemon） |
| `/healthz`、`/readyz`、`/api/v1/*` 的**只读**窄代理，服务端注入 Bearer | 不做 POST/PUT/DELETE 转发 |
| 扩展名白名单 + 无目录列表 + 无点文件 | 不是 WebUI v2 的宿主 |

`GET`/`HEAD` 之外的任何方法一律 `405`（`serve.mjs` 的请求入口）。这是刻意的：v2 的写链路
（`PUT /api/v1/settings`、`PUT|DELETE /api/v1/credentials/:id`、`POST /api/v1/agent/chat`、
`POST /api/v1/alerts/:id/explain`、SSE）需要同源写代理 + `x-console-v2` 闸门 + CSRF 派生，
全部在 `apps/console-next/serve.mjs` 里，本壳一条都没有。

## 让位规则（2026-11-04 新增）

如果与 `serve.mjs` 同目录的 `index.html` 是 **WebUI v2 页面**（`data-route="…"` 导航项
≥ 6 个，合同 §7.1 的冻结形状），本壳**拒绝启动**：

- 退出码 `3`（与「参数错误 2」「监听失败 1」区分）；
- stderr 说明原因并给出唯一正确做法（见下）。

这样做而不是"照发页面"：v2 页面渲染出来后，每一次保存/凭据/对话都会静默失败，
用户看到的是一台"装好了但存不上"的机器。拒绝启动会把问题暴露在启动日志里。

`--help`、参数校验、非回环 `--host` 拒绝（退出码 2）、单行 JSON 公告形状都保持不变；
公告里新增 `generation` 字段（`legacy` / `v2` / `unknown`），老解析器读 `listening` 不受影响。

## 正确的打包方式（可执行建议，`build.mjs` 不在本目录写域）

`build.mjs::stageProfileAssets()` 的选择顺序是
**`--console-source` 钉扎 > profile 的 `preferredSource`（`apps/console`）> `shellSource`**，
并且**staged console 自带 `serve.mjs` 时不会再补本壳**。所以让 v2 上新界面的可执行做法只有一条：

```bash
node deploy/embedded-runtime/build.mjs --profile desktop \
  --console-source apps/console-next \
  --out dist/bundle/win32-x64-v15-console-next \
  --allow-repo-output
```

结果（构建后自查）：

```bash
# 1) 进 bundle 的页面是 v2（6 个 nav 项）而不是旧页（0 个）
node -e "const fs=require('fs');const h=fs.readFileSync('dist/bundle/<out>/console/index.html','utf8');console.log('data-route', (h.match(/data-route=/g)||[]).length)"

# 2) bundle 的 console/serve.mjs 是 console-next 的那一份，不是本壳
node -e "const fs=require('fs'),c=require('crypto');const h=(p)=>c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');console.log(h('dist/bundle/<out>/console/serve.mjs')===h('apps/console-next/serve.mjs'))"

# 3) 起壳后写闸门在场：无 x-console-v2 的 PUT → 403；带 → 200（dryRun）
node dist/bundle/<out>/console/serve.mjs --daemon http://127.0.0.1:17511 --port 17512
```

**不要**只把 `apps/console-next` 的文件拷进 `console/` 而不带它的 `serve.mjs`：那会退回本壳，
被上面的让位规则拒绝启动（退出码 3）——这正是该规则要拦住的情形。

## 验证命令（本目录改动后必跑）

```bash
node --test tests/packaging/v14-bundle.test.js      # 打包契约：bundle 的 console/serve.mjs 仍能服务旧页
node --test tests/e2e/shell-link/chain.test.js      # 让位规则 + 链路断言（本任务）
```

回归证据与结论：`docs/implementation/evidence/ui2/shell-link/STATUS.md`。
