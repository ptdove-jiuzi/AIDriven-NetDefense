# 控制台术语对照表（i18n glossary）

- 状态：生效（2026-11-04）
- 适用：`apps/console/i18n/locales/*.json` 全部词条，以及后续桌面壳、安装器复用同一套词条。
- 规则来源：`docs/design/I18N.md` §6。**§6 已定义的 11 条术语逐字沿用，不得改写。**

## 使用规则

1. **先入表，再入词条。** 新术语必须先在本文件补齐七语，才能出现在 `en.json` 及其它语言里。
2. **不得自行发挥。** 同一概念在七种语言里只能有一个对应词；同一语言内不允许同义词轮换。
3. **不翻译**：产品名 `AIDriven NetDefense` / `网域智防`、协议名（HTTP / CSRF / CORS）、
   字段名（`alert_id` / `budget_class` / `last_seen` / `has_more` / `byte_limited`）、
   文件名、日志原文、错误码（`QUERY_INVALID`）、命令（`python -m http.server`）。
4. **接口路径不翻译**：`/api/v1/alerts`、`/api/v1/analysis`、`/api/v1/status` 原样出现在任何语言里。
5. 术语进句子时仍要遵守目标语言的语法（日语加助词、俄语变格、泰语不加空格），
   但术语的**词干**必须是本表给出的那一个。

## 复数类目规则

`en.json` 同时落 `one / few / many / other` 四类，是为了让七份文件的 key 集合完全一致
（CI 要求 key 集合逐字相同）。实际使用情况：

| 语言 | CLDR 会选中的类目 | 未使用类目的处理 |
|---|---|---|
| en / es | `one`, `other` | `few` / `many` 的值与 `other` 相同（永不被选中） |
| ru | `one`, `few`, `many`, `other` | 四类都必须写真实变格 |
| ja / ko / th / zh-CN | `other` | 其余三类与 `other` 相同 |

校验脚本 `scripts/i18n-check.mjs` 额外核对「每种语言的 CLDR 类目是否齐全」，
所以俄语缺 `few` 会直接红。

## §6 官方术语（逐字沿用）

| key | en | zh-CN | ja | ko | es | ru | th |
|---|---|---|---|---|---|---|---|
| term.alert | alert | 告警 | アラート | 경보 | alerta | оповещение | การแจ้งเตือน |
| term.event | event | 事件 | イベント | 이벤트 | evento | событие | เหตุการณ์ |
| term.detection | detection | 检测 | 検出 | 탐지 | detección | обнаружение | การตรวจจับ |
| term.response | response | 响应 | 対応 | 대응 | respuesta | реагирование | การตอบสนอง |
| term.evidence | evidence | 证据 | 証拠 | 증거 | evidencia | доказательство | หลักฐาน |
| term.severity | severity | 严重度 | 重大度 | 심각도 | gravedad | критичность | ระดับความรุนแรง |
| term.policy | policy | 策略 | ポリシー | 정책 | política | политика | นโยบาย |
| term.sandbox | sandbox | 沙箱 | サンドボックス | 샌드박스 | sandbox | песочница | แซนด์บ็อกซ์ |
| term.model | model | 模型 | モデル | 모델 | modelo | модель | โมเดล |
| term.provider | provider | 提供方 | プロバイダー | 공급자 | proveedor | провайдер | ผู้ให้บริการ |
| term.budget | budget | 预算 | 予算 | 예산 | presupuesto | бюджет | งบประมาณ |

## 扩展术语（由 `en.json` 现有词条抽出）

| key | en | zh-CN | ja | ko | es | ru | th |
|---|---|---|---|---|---|---|---|
| term.analysis | analysis | 分析 | 分析 | 분석 | análisis | анализ | การวิเคราะห์ |
| term.report | report | 报告 | レポート | 보고서 | informe | отчёт | รายงาน |
| term.collector | collector | 采集源 | コレクター | 수집기 | colector | коллектор | ตัวเก็บข้อมูล |
| term.counter | counter | 计数器 | カウンター | 카운터 | contador | счётчик | ตัวนับ |
| term.lifecycle | lifecycle | 生命周期 | ライフサイクル | 수명 주기 | ciclo de vida | жизненный цикл | วงจรชีวิต |
| term.health | health | 健康状态 | ヘルス状態 | 헬스 상태 | estado de salud | состояние | สุขภาพระบบ |
| term.degraded | degraded | 降级 | 縮退 | 성능 저하 | degradado | деградация | ประสิทธิภาพลดลง |
| term.stale | stale | 陈旧 | 古い | 오래됨 | obsoleto | устаревший | ล้าสมัย |
| term.whitelist | whitelist | 白名单 | ホワイトリスト | 화이트리스트 | lista blanca | белый список | รายการที่อนุญาต |
| term.cursor | cursor | 游标 | カーソル | 커서 | cursor | курсор | เคอร์เซอร์ |
| term.keyset-pagination | keyset pagination | 键集分页 | キーセットページング | 키셋 페이지네이션 | paginación por clave | выборка по ключу | การแบ่งหน้าด้วยคีย์ |
| term.loopback | loopback | 回环 | ループバック | 루프백 | loopback | петлевой интерфейс | ลูปแบ็ก |
| term.token | token | 令牌 | トークン | 토큰 | token | токен | โทเค็น |
| term.proxy | proxy | 代理 | プロキシ | 프록시 | proxy | прокси | พร็อกซี |
| term.daemon | daemon | 守护进程 | デーモン | 데몬 | daemon | демон | เดมอน |
| term.read-only | read-only | 只读 | 読み取り専用 | 읽기 전용 | solo lectura | только для чтения | อ่านอย่างเดียว |
| term.self-check | self-check | 自检 | セルフチェック | 자체 점검 | autocomprobación | самопроверка | การตรวจสอบตนเอง |
| term.budget-class | budget class | 预算档位 | 予算クラス | 예산 등급 | clase de presupuesto | класс бюджета | ระดับงบประมาณ |
| term.attempts | attempts | 尝试次数 | 試行回数 | 시도 횟수 | intentos | попытки | จำนวนครั้งที่ลอง |
| term.origin | Origin header | Origin 头 | Origin ヘッダー | Origin 헤더 | cabecera Origin | заголовок Origin | ส่วนหัว Origin |

## 各级语言的用词约定

| 语言 | 语体 | 技术名词 | 标点 | 特别注意 |
|---|---|---|---|---|
| zh-CN | 简体书面语 | 用本表中文列 | 全角，句末带句号 | 「告警」不写「警报」；「证据」不写「凭证」 |
| ja | です・ます体 | 片假名，首次出现保留英文括注 | 半角数字，全角句读 | 「アラート」不写「警報」；不用「あなた」 |
| ko | 해요体 | 按 KS 标准转写 | 半角标点 | 「경보」不写「알람」；技术名词不硬翻译成汉字词 |
| es | 中性拉美西语 | 用本表西语列 | 半角，问号感叹号成对 | 避免 `ordenador` / `vosotros` 等地区词 |
| ru | 正式体，无缩写口语 | 用本表俄语列 | 半角 | 四类复数必须真实变格；`оповещение` 不写 `алерт` |
| th | 礼貌体 | 用本表泰语列 | 词间不加空格，句末不加句号 | 长度按 en 的 1.3× 预留 |

## 与词条的对应关系

本表的 `term.*` 只是**对照记录**，不写进 `en.json`——`en.json` 的 key 集合由界面语义决定
（`alerts.filter.severity` 这类）。术语表的用途是：写新词条时按本表选词，避免七语各写一套。
