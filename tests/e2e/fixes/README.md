# tests/e2e/fixes — 回修回归用例（fixer / INT-5）

本目录放**回修缺陷的回归用例**：每条用例对应 `docs/implementation/evidence/ui2/defects.md` 的一个编号，
且必须能在 `node --test` 下独立跑（用真实浏览器 `tests/e2e/lib/cdp.mjs` + 已起好的 17512/17522 栈）。

## 运行

```powershell
# 单条缺陷
node --test tests/e2e/fixes/settings-p0-2.test.js

# 换栈（默认 17512 有数据 / 17522 空数据）
$env:FIXES_DATA_BASE='http://127.0.0.1:17512'; $env:FIXES_MOCK_BASE='http://127.0.0.1:17522'
node --test tests/e2e/fixes/*.test.js
```

**前提**：17xxx 两套栈已由集成会话起好且健康；本目录的用例**不启动、不重启、不 kill 任何服务**。
栈不可用时用例会失败（带页面诊断），不会静默 skip。

## 约定（不假绿）

1. 每条用例先在盘面上复现缺陷（红），修好后转绿；若缺陷是别人修的、修前字节已不可得，
   就用 `lib/mutate-module.mjs` 在**传输层**做等价变异，精确复现旧症状，作为"红侧证明"（磁盘零改动）。
2. 断言只绑定可观测事实（DOM 文本、tab 数、异常/4xx、整页字符数），不放宽、不吞错。
3. 每次运行把受测文件的 sha256 打进 `t.diagnostic`，结论绑定具体版本（`apps/console-next/js/**` 是移动靶）。

## 文件

| 文件 | 用途 |
|---|---|
| `settings-p0-2.test.js` | D2/P0-2：`#/settings`、`#/models` 8 组全渲染；变异转红复现 `checkbox is not defined` |
| `lib/mutate-module.mjs` | CDP Fetch 传输层变异：删掉某模块 import 里的一个绑定（只读、不落盘） |
| `capture-p0-2-evidence.mjs` | 生成 D2 的截图 + 机器可读证据（写 `docs/implementation/evidence/ui2/fixes/`） |

证据与结论：`docs/implementation/evidence/ui2/fixes/VERIFY-P0-2.md`。
