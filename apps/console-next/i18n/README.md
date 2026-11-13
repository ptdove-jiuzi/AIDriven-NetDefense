# WebUI v2 i18n（`apps/console-next/i18n/`）

- 作者：PT-dove
- 合同：`docs/implementation/CONSOLE-V2-CONTRACT.md` §8（v1.2 key 语法）
- 检查脚本：`node scripts/i18n-check.mjs --dir apps/console-next/i18n/locales`
- **§1–§6 由 `apps/console-next/i18n/tools/sync-readme.mjs` 从磁盘重写**（生成器仍在
  `tests/e2e/i18n/make-readme.mjs`，本轮由 T3 手工同步；如需改数字请重跑工具，不要手改本节）。
- 改 locale 事实请改磁盘文件（`locales/*.json`）或译文表（`tools/translations/*.json`），
  改 v1→v2 映射请改 `tests/e2e/i18n/readme-mapping.md`。

<!-- T3:AUTO:BEGIN -->
> **生成器在 `tests/e2e/i18n/`（make-readme.mjs）；本节由 `apps/console-next/i18n/tools/sync-readme.mjs` 本轮手工同步（与磁盘现读一致，改 locale 后重跑即可）。**

## 1. 文件与规模（本表由磁盘现读，不是手写）

| 文件 | key 数 | 字节 | 状态 | meta |
|---|---|---|---|---|
| `locales/en.json` | 1127 | 74064 | 人工撰写（源语言） | `_machine:false`, `_source:en` |
| `locales/zh-CN.json` | 1127 | 72833 | 人工撰写（源语言） | `_machine:false`, `_source:zh-CN` |
| `locales/ja.json` | 1127 | 76956 | 部分翻译（186/1127 条） | `_machine:true`, `_source:en` |
| `locales/ko.json` | 1127 | 75863 | 部分翻译（186/1127 条） | `_machine:true`, `_source:en` |
| `locales/es.json` | 1127 | 75042 | 部分翻译（183/1127 条） | `_machine:true`, `_source:en` |
| `locales/ru.json` | 1127 | 78612 | 部分翻译（186/1127 条） | `_machine:true`, `_source:en` |
| `locales/th.json` | 1127 | 81832 | 部分翻译（186/1127 条） | `_machine:true`, `_source:en` |

- 语言数：7；en 基准 key：**1127**；7 语言 key 集合以 `scripts/i18n-check.mjs` 为准。
- `zh-CN`：默认语言（主路径），人工撰写；`en` / `zh-CN` 是源语言（`_machine:false`）。
- 5 个机翻语言的 meta 由 `tools/apply-translations.mjs` 按磁盘真实覆盖率生成，不写死、不虚报。
- 未翻译的 key **回退英文**（不是 404、不是 `[missing:]`），但**不是真翻译**，不得当作已本地化。

## 2. 5 语言真实翻译覆盖率（诚实口径）

> `translated` = 值**与 en 不同**的 key 数（可证不是英文占位）；`target-script` = 值中含目标语言脚本字符的 key 数（日文假名/韩文/西里尔/泰文；es 用重音符号，天然偏低，仅作第二证据）。

| locale | translated / total | 覆盖率 | target-script | 未翻译（英文占位） |
|---|---|---|---|---|
| `ja` | 186 / 1127 | 16.5% | 186 | 941 |
| `ko` | 186 / 1127 | 16.5% | 186 | 941 |
| `es` | 183 / 1127 | 16.2% | 93 | 944 |
| `ru` | 186 / 1127 | 16.5% | 186 | 941 |
| `th` | 186 / 1127 | 16.5% | 186 | 941 |

- **未完成项（如实）**：5 语言均**不是全量翻译**；最低的 `es` 只有 183/1127（16.2%）。
- 已译范围：`nav.*`、`common.*`、`app.*`（品牌位除外）、`agent.guide.*`/`agent.action.*`/`agent.empty.*`/`agent.error.*`、`settings.group.*`/`settings.title`/`settings.save*`、empty states、`status.*`、`severity.*`、`errors.*`（全部错误码）、`a11y.*`、`about.*`。
- 未译范围：`settings.*` 的 schema 字段/枚举/说明（584 条中的绝大部分）、`alerts.*`/`analysis.*`/`overview.*` 的表格列与详情文案。

## 3. en 的 CJK 白名单（最小、显式）

en 里含 CJK 的 key：**3 个**（字符数 11 个 CJK 汉字）。

| key | 值 | 判定 |
|---|---|---|
| `app.product-zh` | "网域智防" | 产品中文专名「网域智防」（合同 §7.1；产品名不是待译文案） |
| `settings.enum.ui.locale.ja` | "日本語" | 语言原生名 日本語（语言切换列表按 native name 展示） |
| `settings.enum.ui.locale.zh-cn` | "简体中文" | 语言原生名 简体中文（同上） |

白名单外新增任何 CJK 都会被 `scripts/i18n-check.mjs` 判 `EN_CJK` 错误（`--strict-en-cjk` 时白名单也判红）。

## 4. 命名空间分布（en.json 现读）

| 命名空间 | 条数 |
|---|---|
| `.settings` | 604 |
| `.agent` | 128 |
| `.alerts` | 107 |
| `.overview` | 65 |
| `.errors` | 59 |
| `.onboarding` | 48 |
| `.analysis` | 46 |
| `.common` | 24 |
| `.app` | 18 |
| `.status` | 11 |
| `.nav` | 7 |
| `.severity` | 5 |
| `.about` | 4 |
| `.a11y` | 1 |

## 5. 本轮（UI-POLISH T3）工具与命令

```bash
node apps/console-next/i18n/tools/apply-translations.mjs --dry-run   # 预览 5 语言覆盖率，不写盘
node apps/console-next/i18n/tools/apply-translations.mjs             # 并入译文表 + 更新 meta/README
node apps/console-next/i18n/tools/merge-pending.mjs --dry-run        # 预览 _pending 合并（等 lead 通知后跑）
node apps/console-next/i18n/tools/merge-pending.mjs                  # 真合并 + 其余 5 语言补 en 值
node apps/console-next/i18n/tools/sync-readme.mjs --check            # README 与磁盘一致性校验（exit 1 = 过期）
node scripts/i18n-check.mjs                                          # 仓库级门禁（7 语言一致/占位符/CJK/泄漏/回落）
```

## 6. 维护规则（本轮更新）

1. `locales/*.json` 一律用脚本改（`tools/apply-translations.mjs` / `tools/merge-pending.mjs`），不手改 1000 行 JSON。
2. key 集合必须与 `en.json` 完全一致；占位符 `{name}` 集合必须一致（`scripts/i18n-check.mjs` 判红）。
3. 新增/修改代码里的文案 → 先加 en，再在 `tools/translations/*.json` 补 5 语言译文，然后跑 apply。
4. 每轮翻译后 `meta._note` 与 README 覆盖率必须等于磁盘真实数字；**禁止写"已全量翻译"**。
5. 回落链（2026-11-05 起）：`当前语言 → en`，**不再回落 zh-CN**（`js/i18n.js` 的 `SECOND_FALLBACK_LOCALE` 仅为兼容导出）。
<!-- T3:AUTO:END -->

## 3. 怎么改（唯一正确姿势）

```bash
# 1) 源码变了先重抽 key（看新增/消失）
node tests/e2e/i18n/extract-keys.mjs
# 2) 改人工词条（en+zh 成对；唯一手改入口）
#    tests/e2e/i18n/catalog/views.mjs        app/nav/common/errors/overview/alerts/analysis/agent
#    tests/e2e/i18n/catalog/settings.mjs     设置页骨架
#    tests/e2e/i18n/catalog/schema-text.mjs  schema 下发的 label/hint、子字段、枚举值
# 3) 构建（硬校验 key 集合/占位符/空值/HTML/en 含 CJK/schema 必需文本）
node tests/e2e/i18n/build-locales.mjs
# 4) 错误码覆盖门禁（errors.<CODE> 缺一条就红）
node tests/e2e/i18n/check-error-codes.mjs
# 5) 真浏览器验收（6 路由 × zh/en × 2 条切语言路径）
node tests/e2e/i18n/verify-i18n.mjs --base http://127.0.0.1:17512 --mode both
# 6) 仓库级校验 + 重生成本文件
node scripts/i18n-check.mjs --dir apps/console-next/i18n/locales
node tests/e2e/i18n/make-readme.mjs
```

<!-- v1→v2 映射数据（人工维护，由 make-readme.mjs 原样嵌入 README）。
     来源：UI2-LEAD 的 evidence/console-v2/b10/make-readme.mjs 生成物，2026-11-04T22:1x 冻结为数据文件。 -->

## 2. 旧 console v1（159 条）映射

统计：keep **24** / move **21** / drop **114** / add **941**（v2 新增）。

| 旧 key | 决定 | 新 key | 说明 |
|---|---|---|---|
| `nav.overview` | keep | `nav.overview` | 同名沿用 |
| `nav.alerts` | keep | `nav.alerts` | 同名沿用 |
| `nav.analysis` | keep | `nav.analysis` | 同名沿用 |
| `nav.settings` | keep | `nav.settings` | 同名沿用 |
| `chrome.refresh` | move | `common.action.refresh` | 英文值一致；按 v2 结构改名 |
| `chrome.auto-refresh` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `chrome.auto-refresh-hint` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `chrome.last-fetch-hint` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `chrome.updated` | move | `common.updated-at` | 英文值一致；按 v2 结构改名 |
| `chrome.connecting` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `chrome.disconnected` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `chrome.online` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `chrome.degraded` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `chrome.offline` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `chrome.read-failed` | drop | — | v1 顶栏（v2 由 conn-pill/refresh/语言/主题按钮重做） |
| `banner.file.title` | drop | — | v1 file:// 打开提示（v2 由 serve.mjs 同源提供，不再需要） |
| `banner.file.body` | drop | — | v1 file:// 打开提示（v2 由 serve.mjs 同源提供，不再需要） |
| `banner.file.hint` | drop | — | v1 file:// 打开提示（v2 由 serve.mjs 同源提供，不再需要） |
| `overview.card.lifecycle` | drop | — | v1 概览卡片（v2 重排为 overview.stat.*） |
| `overview.card.version` | move | `overview.stat.version` | 英文值一致；按 v2 结构改名 |
| `overview.card.uptime` | move | `overview.stat.uptime` | 英文值一致；按 v2 结构改名 |
| `overview.card.alerts` | drop | — | v1 概览卡片（v2 重排为 overview.stat.*） |
| `overview.card.reasons` | move | `overview.health.reasons` | 英文值一致；按 v2 结构改名 |
| `overview.card.sources` | move | `overview.stat.sources` | 英文值一致；按 v2 结构改名 |
| `overview.meta.schema` | drop | — | v1 元信息行（v2 用 overview.stat.schema / overview.health.*） |
| `overview.meta.health` | drop | — | v1 元信息行（v2 用 overview.stat.schema / overview.health.*） |
| `overview.meta.started` | drop | — | v1 元信息行（v2 用 overview.stat.schema / overview.health.*） |
| `overview.panel.reasons` | move | `overview.health.reasons` | 英文值一致；按 v2 结构改名 |
| `overview.panel.counters` | drop | — | v1 概览面板（v2 重排为 overview.stat / overview.counters / overview.sources） |
| `overview.panel.runtime` | drop | — | v1 概览面板（v2 重排为 overview.stat / overview.counters / overview.sources） |
| `overview.empty.reasons` | drop | — | v1 空态（v2 overview.sources.empty.*） |
| `overview.stale` | drop | — | v2 无对应界面（文案由新结构重写） |
| `common.action.read` | drop | — | v2 无对应界面（文案由新结构重写） |
| `common.action.retry` | keep | `common.action.retry` | 同名沿用 |
| `common.action.close` | keep | `common.action.close` | 同名沿用 |
| `common.filter.all` | move | `alerts.filter.all` | 英文值一致；按 v2 结构改名 |
| `common.filter.search` | drop | — | v2 无对应界面（文案由新结构重写） |
| `common.filter.per-page` | drop | — | v1 每页条数（v2 虚拟滚动无分页） |
| `common.pager.previous` | drop | — | v1 分页（v2 表格虚拟滚动 + load-more） |
| `common.pager.next` | drop | — | v1 分页（v2 表格虚拟滚动 + load-more） |
| `common.pager.summary` | drop | — | v1 分页（v2 表格虚拟滚动 + load-more） |
| `common.missing` | drop | — | v1 字段缺失提示（v2 用 common.value.unavailable） |
| `common.missing-title` | drop | — | v1 字段缺失提示（v2 用 common.value.unavailable） |
| `common.unknown` | drop | — | v2 无对应界面（文案由新结构重写） |
| `alerts.sub` | drop | — | v1 副标题（v2 alerts.subtitle） |
| `alerts.filter.severity` | keep | `alerts.filter.severity` | 同名沿用 |
| `alerts.filter.status` | keep | `alerts.filter.status` | 同名沿用 |
| `alerts.filter.search-placeholder` | keep | `alerts.filter.search-placeholder` | 同名沿用 |
| `alerts.scope` | drop | — | v1 数据范围说明（v2 alerts.loaded + alerts.work-set 说明） |
| `alerts.col.time` | drop | — | v2 无对应界面（文案由新结构重写） |
| `alerts.col.rule` | move | `alerts.column.rule` | 英文值一致；按 v2 结构改名 |
| `alerts.col.count` | move | `alerts.sort.count` | 英文值一致；按 v2 结构改名 |
| `alerts.col.evidence` | drop | — | v2 无对应界面（文案由新结构重写） |
| `alerts.state.not-read` | drop | — | v1 列表状态行（v2 alerts.empty* / alerts.loaded） |
| `alerts.state.not-read-detail` | drop | — | v1 列表状态行（v2 alerts.empty* / alerts.loaded） |
| `alerts.state.empty` | drop | — | v1 列表状态行（v2 alerts.empty* / alerts.loaded） |
| `alerts.state.empty-detail` | drop | — | v1 列表状态行（v2 alerts.empty* / alerts.loaded） |
| `alerts.state.filtered` | drop | — | v1 列表状态行（v2 alerts.empty* / alerts.loaded） |
| `alerts.state.filtered-detail` | drop | — | v1 列表状态行（v2 alerts.empty* / alerts.loaded） |
| `alerts.result.one` | drop | — | v1 复数结果句（v2 alerts.loaded 单句） |
| `alerts.result.few` | drop | — | v1 复数结果句（v2 alerts.loaded 单句） |
| `alerts.result.many` | drop | — | v1 复数结果句（v2 alerts.loaded 单句） |
| `alerts.result.other` | drop | — | v1 复数结果句（v2 alerts.loaded 单句） |
| `detail.title` | move | `settings.action.details` | 英文值一致；按 v2 结构改名 |
| `detail.section.identity` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `detail.section.verdict` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `detail.section.time` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `detail.note.whitelist` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `detail.note.evidence` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `detail.note.report` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `detail.completed.none` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `detail.report.yes` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `detail.report.no` | move | `analysis.report.no` | 英文值一致；按 v2 结构改名 |
| `detail.evidence.truncated` | drop | — | v1 告警详情抽屉（v2 alerts.detail.* 字段重排） |
| `severity.info` | keep | `severity.info` | 同名沿用 |
| `severity.low` | keep | `severity.low` | 同名沿用 |
| `severity.medium` | keep | `severity.medium` | 同名沿用 |
| `severity.high` | keep | `severity.high` | 同名沿用 |
| `severity.critical` | keep | `severity.critical` | 同名沿用 |
| `alert.status.new` | move | `status.new` | 英文值一致；按 v2 结构改名 |
| `alert.status.acknowledged` | move | `status.acknowledged` | 英文值一致；按 v2 结构改名 |
| `alert.status.resolved` | move | `status.resolved` | 英文值一致；按 v2 结构改名 |
| `alert.status.suppressed` | move | `status.suppressed` | 英文值一致；按 v2 结构改名 |
| `analysis.sub` | drop | — | v1 副标题（v2 analysis.subtitle） |
| `analysis.filter.state` | keep | `analysis.filter.state` | 同名沿用 |
| `analysis.filter.report` | keep | `analysis.filter.report` | 同名沿用 |
| `analysis.filter.search-placeholder` | drop | — | v2 无对应界面（文案由新结构重写） |
| `analysis.hint` | drop | — | v2 无对应界面（文案由新结构重写） |
| `analysis.col.created` | drop | — | v2 无对应界面（文案由新结构重写） |
| `analysis.col.budget` | drop | — | v2 无对应界面（文案由新结构重写） |
| `analysis.col.attempts` | keep | `analysis.col.attempts` | 同名沿用 |
| `analysis.col.completed` | drop | — | v2 无对应界面（文案由新结构重写） |
| `analysis.state.empty` | drop | — | v1 空态（v2 analysis.empty.*） |
| `analysis.state.empty-detail` | drop | — | v1 空态（v2 analysis.empty.*） |
| `analysis.state.queued` | keep | `analysis.state.queued` | 同名沿用 |
| `analysis.state.dispatched` | keep | `analysis.state.dispatched` | 同名沿用 |
| `analysis.state.running` | keep | `analysis.state.running` | 同名沿用 |
| `analysis.state.succeeded` | keep | `analysis.state.succeeded` | 同名沿用 |
| `analysis.state.degraded` | keep | `analysis.state.degraded` | 同名沿用 |
| `analysis.state.failed` | keep | `analysis.state.failed` | 同名沿用 |
| `analysis.state.cancelled` | keep | `analysis.state.cancelled` | 同名沿用 |
| `analysis.result.one` | drop | — | v1 复数结果句（v2 analysis.loaded 单句） |
| `analysis.result.few` | drop | — | v1 复数结果句（v2 analysis.loaded 单句） |
| `analysis.result.many` | drop | — | v1 复数结果句（v2 analysis.loaded 单句） |
| `analysis.result.other` | drop | — | v1 复数结果句（v2 analysis.loaded 单句） |
| `settings.sub` | drop | — | v2 无对应界面（文案由新结构重写） |
| `settings.panel.appearance` | drop | — | v1 设置面板（v2 settings.group.* 8 组） |
| `settings.ui-mode` | drop | — | v1 运行模式（v2 由桌面壳/serve.mjs 决定，界面不再提供该开关） |
| `settings.ui-mode.embedded` | drop | — | v1 运行模式（v2 由桌面壳/serve.mjs 决定，界面不再提供该开关） |
| `settings.ui-mode.browser` | drop | — | v1 运行模式（v2 由桌面壳/serve.mjs 决定，界面不再提供该开关） |
| `settings.ui-mode.warning` | drop | — | v1 运行模式（v2 由桌面壳/serve.mjs 决定，界面不再提供该开关） |
| `settings.language` | move | `settings.ui.locale.label` | 英文值一致；按 v2 结构改名 |
| `settings.language-hint` | drop | — | v1 语言说明（v2 顶栏语言切换 + settings.ui.locale） |
| `settings.language-note` | drop | — | v1 语言说明（v2 顶栏语言切换 + settings.ui.locale） |
| `settings.model` | move | `agent.model.label` | 英文值一致；按 v2 结构改名 |
| `settings.model-hint` | drop | — | v1 单一模型设置（v2 settings.models.* 多 provider/model） |
| `settings.model-id` | drop | — | v1 单一模型设置（v2 settings.models.* 多 provider/model） |
| `settings.model-vendor` | move | `settings.field.models.models.provider-id` | 英文值一致；按 v2 结构改名 |
| `settings.model-note` | drop | — | v1 单一模型设置（v2 settings.models.* 多 provider/model） |
| `settings.budget` | drop | — | v1 预算（v2 settings.models.budget.*） |
| `settings.budget-hint` | drop | — | v1 预算（v2 settings.models.budget.*） |
| `settings.budget-class` | move | `analysis.col.budget-class` | 英文值一致；按 v2 结构改名 |
| `settings.budget-used` | drop | — | v1 预算（v2 settings.models.budget.*） |
| `settings.budget-remaining` | drop | — | v1 预算（v2 settings.models.budget.*） |
| `settings.budget-note` | drop | — | v1 预算（v2 settings.models.budget.*） |
| `settings.panel.connection` | drop | — | v1 设置面板（v2 settings.group.* 8 组） |
| `settings.conn.source` | drop | — | v1 连接信息面板（v2 settings.diagnostics.*） |
| `settings.conn.proxy` | drop | — | v1 连接信息面板（v2 settings.diagnostics.*） |
| `settings.conn.direct` | drop | — | v1 连接信息面板（v2 settings.diagnostics.*） |
| `settings.conn.base` | drop | — | v1 连接信息面板（v2 settings.diagnostics.*） |
| `settings.conn.token` | drop | — | v1 连接信息面板（v2 settings.diagnostics.*） |
| `settings.conn.token-placeholder` | drop | — | v1 连接信息面板（v2 settings.diagnostics.*） |
| `settings.conn.port` | drop | — | v1 连接信息面板（v2 settings.diagnostics.*） |
| `settings.diag.run` | drop | — | v1 诊断按钮（v2 settings.diagnostics.actions.*） |
| `settings.diag.reset` | drop | — | v1 诊断按钮（v2 settings.diagnostics.actions.*） |
| `error.file.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.file.detail` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.file.hint` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.offline.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.offline.detail` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.auth.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.auth.detail` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.rate.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.rate.detail` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.rate.wait` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.forbidden.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.bad-request.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.not-found.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.store.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.server.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.http.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.read.title` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.unknown` | move | `errors.unknown` | 命名空间改为 errors. |
| `error.hint.400` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.hint.401` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.hint.429` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.hint.503` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.hint.unknown` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |
| `error.action.settings` | drop | — | v1 错误面板（v2 errors.<CODE> 失败码 + 视图级错误文案） |

## 3. v2 新增 key 按命名空间

| 命名空间 | 新增条数 |
|---|---|
| `.a11y` | 1 |
| `.about` | 4 |
| `.agent` | 86 |
| `.alerts` | 101 |
| `.analysis` | 34 |
| `.app` | 18 |
| `.common` | 20 |
| `.errors` | 45 |
| `.nav` | 3 |
| `.overview` | 61 |
| `.settings` | 561 |
| `.status` | 7 |

新增 key 来自 B4（Agent）/ B5（告警）/ B6（概览+分析）/ B7（设置 8 组）/ B2（应用外壳）。

## 4. 维护规则

1. **不要手改 `locales/*.json`**：它们是 `build-locales.mjs` 的产物，手改会被覆盖并绕过硬校验。
2. key 集合必须与 `en.json` 完全一致（多/少都会被 `build-locales.mjs --check` 与 `scripts/i18n-check.mjs` 判失败）。
3. key 全小写 + kebab；错误码命名空间例外见合同 §8.3。
4. `{name}` 占位符集合跨语言必须一致；数值/日期格式化用 `Intl`，不要在文案里手拼。
5. 新增错误码时同步加 `errors.<CODE>`，否则 `check-error-codes.mjs` 会红（P1-2 就是这么漏的）。
6. 补齐 ja/ko/es/ru/th：把对应 `locales/<locale>.json` 的值换成真翻译，并把 meta 改成
   `_machine:true` + `_source:"en"` + 真实 `_note`；key 集合不得变动。
7. 改完必须跑 §3 的 1–6，并把真实输出写进 `docs/implementation/evidence/ui2/i18n/STATUS.md`。

---

作者：PT-dove
