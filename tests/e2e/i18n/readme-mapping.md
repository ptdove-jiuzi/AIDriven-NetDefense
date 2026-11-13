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
