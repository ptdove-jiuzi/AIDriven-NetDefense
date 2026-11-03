/**
 * apps/console/app.js — 网域智防本地控制台（纯静态，无构建、无框架、无 CDN）。
 *
 * 设计约束（与 docs/product/06-api.md、apps/daemon/src/api/query.js 对齐）：
 *
 * 1. **字段只认白名单。** ALERT_FIELDS / ANALYSIS_FIELDS 与 projectAlert() /
 *    projectAnalysis() 一一对应。响应里没有的键渲染为「未提供」，不做补全、不做推测。
 * 2. **查询面封闭。** 只发 limit 与 cursor。筛选和搜索都在前端对「已加载页」生效，
 *    因为向服务端追加 severity= 之类的参数会得到 400 QUERY_INVALID。
 * 3. **凭据不进 URL。** 直连模式才带 Authorization: Bearer；同源代理模式前端不持有
 *    token。CSRF 证明只在内存里，只随非 GET 请求发出。
 * 4. **三态齐全。** loading / empty / error 各有独立渲染；连不上 daemon 时明确显示
 *    「服务未启动」，不转圈。
 *
 * 作者：PT-dove
 */

(function (global) {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════
     1. 常量：枚举与字段白名单
     ══════════════════════════════════════════════════════════════════════ */

  /** 与 packages/contracts SEVERITY_LEVELS 一致。 */
  const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

  const SEVERITY_LABEL = {
    info: '信息', low: '低', medium: '中', high: '高', critical: '严重',
  };

  /** 与 apps/daemon/src/config.js 的 alertStatus 校验一致。 */
  const ALERT_STATUSES = ['new', 'acknowledged', 'resolved', 'suppressed'];

  const ALERT_STATUS_LABEL = {
    new: '新建', acknowledged: '已确认', resolved: '已解决', suppressed: '已抑制',
  };

  /** 与 packages/event-store/src/analysis.js 的状态机一致。 */
  const ANALYSIS_STATES = ['queued', 'dispatched', 'running', 'succeeded', 'degraded', 'failed', 'cancelled'];

  const ANALYSIS_STATE_LABEL = {
    queued: '排队中', dispatched: '已派发', running: '运行中', succeeded: '成功',
    degraded: '降级完成', failed: '失败', cancelled: '已取消',
  };

  /** projectAlert() 的返回键，顺序即契约顺序。 */
  const ALERT_FIELDS = [
    'alert_id', 'rule_id', 'rule_version', 'severity', 'status', 'count',
    'first_seen', 'last_seen', 'window_start', 'window_end',
    'evidence_count', 'evidence_truncated',
  ];

  /** projectAnalysis() 的返回键。 */
  const ANALYSIS_FIELDS = [
    'analysis_id', 'alert_id', 'state', 'budget_class', 'attempts',
    'created_at', 'updated_at', 'completed_at', 'report_available',
  ];

  /** buildPage() 的 page 键。 */
  const PAGE_FIELDS = ['limit', 'returned', 'has_more', 'next_cursor', 'order', 'byte_limited'];

  /** 唯一被允许出现在查询串里的参数。 */
  const ALLOWED_QUERY = ['limit', 'cursor'];

  /** daemon 只监听字面回环地址，直连地址必须与之一致。 */
  const LOOPBACK_BASE = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/u;

  const PREFS_KEY = 'nd.console.prefs.v1';
  const TOKEN_KEY = 'nd.console.token';
  const LIMITS = [10, 25, 50, 100];

  /* ══════════════════════════════════════════════════════════════════════
     2. 纯函数：格式化与取值
     ══════════════════════════════════════════════════════════════════════ */

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/gu, (character) => ESCAPES[character]);
  }

  /**
   * 判断键是否真实存在于响应里。
   * 「键不存在」与「键存在但值为 null」是两件事：前者是后端没给，后者是后端给了空。
   */
  function pick(object, key) {
    const present = object !== null && typeof object === 'object'
      && Object.prototype.hasOwnProperty.call(object, key);
    return { present, value: present ? object[key] : undefined };
  }

  function isMissing(value) {
    return value === undefined;
  }

  /** 千分位，不依赖 locale。 */
  function groupNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    const sign = value < 0 ? '-' : '';
    const digits = String(Math.abs(Math.trunc(value)));
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  }

  /**
   * 毫秒时长 → `3d 04:07:12` / `04:07:12`。
   * 非有限数或负数返回 null，由渲染层写「未提供」，不猜一个 0。
   */
  function formatUptime(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      return null;
    }
    const total = Math.floor(ms / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (value) => String(value).padStart(2, '0');
    const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    return days > 0 ? `${days}d ${clock}` : clock;
  }

  /**
   * RFC 3339 → `YYYY-MM-DD HH:MM:SS`（UTC）。
   * 无法解析时原样返回字符串：宁可展示原始值，也不静默改成当前时间。
   */
  function formatTimeUTC(iso) {
    if (typeof iso !== 'string' || iso.length === 0) {
      return null;
    }
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      return iso;
    }
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
      + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }

  /** 标识符缩写；不足 8 位就原样。 */
  function shortId(value, head = 8) {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    return value.length <= head ? value : value.slice(0, head);
  }

  function severityRank(severity) {
    const index = SEVERITIES.indexOf(severity);
    return index === -1 ? -1 : index;
  }

  function severityTone(severity) {
    return severityRank(severity) === -1 ? 'idle' : severity;
  }

  const ALERT_STATUS_TONE = {
    new: 'info', acknowledged: 'warn', resolved: 'ok', suppressed: 'idle',
  };

  const ANALYSIS_STATE_TONE = {
    queued: 'idle', dispatched: 'info', running: 'warn', succeeded: 'ok',
    degraded: 'high', failed: 'bad', cancelled: 'idle',
  };

  function alertStatusTone(status) {
    return ALERT_STATUS_TONE[status] ?? 'idle';
  }

  function analysisStateTone(state) {
    return ANALYSIS_STATE_TONE[state] ?? 'idle';
  }

  function healthTone(status) {
    if (status === 'ok') return 'ok';
    if (status === 'degraded') return 'warn';
    if (status === 'failed') return 'bad';
    return 'idle';
  }

  function clampLimit(value) {
    const parsed = Number(value);
    return LIMITS.includes(parsed) ? parsed : 50;
  }

  /* ══════════════════════════════════════════════════════════════════════
     3. 查询串与请求头
     ══════════════════════════════════════════════════════════════════════ */

  function normalizeBase(base) {
    const value = typeof base === 'string' ? base.trim() : '';
    return value === '' ? '' : value.replace(/\/+$/u, '');
  }

  function isLoopbackBase(base) {
    return LOOPBACK_BASE.test(normalizeBase(base));
  }

  /**
   * 构造查询串。白名单以外的键直接抛错——这类参数服务端会以
   * 400 QUERY_INVALID 拒绝，前端不应该先发出去再解释。
   */
  function buildQuery(params) {
    if (params === undefined || params === null) {
      return '';
    }
    const search = new URLSearchParams();
    for (const key of Object.keys(params)) {
      if (!ALLOWED_QUERY.includes(key)) {
        throw new Error(`query parameter is not allowed: ${key}`);
      }
      const value = params[key];
      if (value === undefined || value === null || value === '') {
        continue;
      }
      search.set(key, String(value));
    }
    const encoded = search.toString();
    return encoded === '' ? '' : `?${encoded}`;
  }

  /** 完整请求地址。token 永远不参与拼接。 */
  function buildRequestUrl(base, path, params) {
    return `${normalizeBase(base)}${path}${buildQuery(params)}`;
  }

  /**
   * 请求头。
   * - 同源代理：不带任何凭据，token 由代理注入。
   * - 直连：带 Authorization；非 GET 额外带 x-aegis-csrf。
   */
  function buildHeaders(options) {
    const settings = options ?? {};
    const method = String(settings.method ?? 'GET').toUpperCase();
    const headers = {};
    if (settings.mode !== 'direct') {
      return headers;
    }
    if (typeof settings.token === 'string' && settings.token.length > 0) {
      headers.authorization = `Bearer ${settings.token}`;
    }
    if (method !== 'GET' && typeof settings.csrf === 'string' && settings.csrf.length > 0) {
      headers['x-aegis-csrf'] = settings.csrf;
    }
    return headers;
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. 错误分类：把 {status, code} 翻成一句人能执行的话
     ══════════════════════════════════════════════════════════════════════ */

  const STATUS_HINTS = {
    400: '查询参数不合法。控制台只会发 limit / cursor，出现这个码通常意味着地址被改写过。',
    401: 'daemon 要求 Bearer token。直连模式下请在「设置 → 连接」里填入 token；同源代理模式下应由代理注入。',
    403: '被 Origin / CSRF 或对端地址判定拒绝。daemon 只接受回环对端，且状态变更请求的 Origin 必须是它自己的 loopback 端点。',
    404: '路径不存在。v0 没有单条详情路由，也没有静态文件路由。',
    405: '方法不被接受。只读端点只允许 GET；非 GET/POST 在认证之前就被拒绝。',
    408: 'daemon 处理超时。',
    413: '请求体超过上限。',
    421: 'Host 头不是回环端点。反向代理或自定义域名会触发这一条。',
    429: '认证失败次数超限。等待 Retry-After 后重试，不要连续猜。',
    500: 'daemon 内部错误。',
    503: '存储不可用或服务未就绪。这不等于「没有数据」。',
  };

  /**
   * 把一次失败归类。返回结构固定，供渲染层与测试共同使用。
   *
   * @param {{protocol?: string, network?: boolean, status?: number, code?: string,
   *   details?: object, retryAfter?: string, message?: string}} input 失败信息。
   * @returns {{kind: string, title: string, detail: string, code: string|null, hint: string}}
   */
  function classifyError(input) {
    const failure = input ?? {};

    if (failure.protocol === 'file:') {
      return {
        kind: 'file',
        title: '需要本地服务器',
        detail: '当前页面以 file:// 打开，浏览器不会把 /api/v1/* 发到 daemon。',
        code: null,
        hint: '用 python -m http.server 8788 --directory apps/console 起静态页，或让同源代理同时提供本页与 /api/v1/*。',
      };
    }

    if (failure.network === true) {
      return {
        kind: 'offline',
        title: '服务未启动',
        detail: '无法连接 daemon：连接被拒绝或跨域被拦截。页面不会重试转圈，需要先确认服务在监听。',
        code: null,
        hint: '确认 daemon 已启动、api.port 是固定端口且与访问地址一致；跨端口直连还需要浏览器允许跨源请求。',
      };
    }

    const status = typeof failure.status === 'number' ? failure.status : 0;
    const code = typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : null;
    const hint = STATUS_HINTS[status] ?? '未预期的响应状态。';

    if (status === 401) {
      return { kind: 'auth', title: '需要认证', detail: '请求被拒绝：缺少或错误的 Bearer token。', code, hint };
    }
    if (status === 429) {
      const wait = typeof failure.retryAfter === 'string' ? ` Retry-After: ${failure.retryAfter}s。` : '';
      return { kind: 'rate', title: '认证被限流', detail: `同一回环地址的失败次数超过窗口上限。${wait}`, code, hint };
    }
    if (status === 403) {
      return { kind: 'forbidden', title: '请求被拒绝', detail: 'Origin / CSRF / 对端地址校验未通过。', code, hint };
    }
    if (status === 400) {
      return { kind: 'bad-request', title: '请求不被接受', detail: '参数或游标不合法，客户端应停止重试。', code, hint };
    }
    if (status === 404) {
      return { kind: 'not-found', title: '接口不存在', detail: '路径未命中任何 v0 路由。', code, hint };
    }
    if (status === 405) {
      return { kind: 'method', title: '方法不被允许', detail: '只读端点只接受 GET。', code, hint };
    }
    if (status === 421) {
      return { kind: 'host', title: 'Host 不被接受', detail: 'Host 头不是 daemon 绑定的回环端点。', code, hint };
    }
    if (status === 503) {
      return { kind: 'store', title: '服务未就绪', detail: '存储不可用或服务尚未就绪；不要把它当作「没有数据」。', code, hint };
    }
    if (status >= 500) {
      return { kind: 'server', title: '服务内部错误', detail: 'daemon 报告未预期故障。', code, hint };
    }
    if (status > 0) {
      return { kind: 'error', title: `请求失败（HTTP ${status}）`, detail: '未归类的响应状态。', code, hint };
    }
    return {
      kind: 'error',
      title: '读取失败',
      detail: typeof failure.message === 'string' && failure.message ? failure.message : '未预期的失败。',
      code,
      hint,
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
     5. 分页：cursor 栈，不做 offset
     ══════════════════════════════════════════════════════════════════════ */

  function createPager(limit) {
    return { limit: clampLimit(limit), stack: [null], index: 0, page: null };
  }

  function pagerCursor(pager) {
    return pager.stack[pager.index] ?? null;
  }

  function pagerCanPrev(pager) {
    return pager.index > 0;
  }

  function pagerCanNext(pager, page) {
    const source = page === undefined ? pager.page : page;
    return Boolean(source && source.has_more === true
      && typeof source.next_cursor === 'string' && source.next_cursor.length > 0);
  }

  /** 前进：把 next_cursor 压栈。没有更多数据时原样返回，不产生空页。 */
  function pagerNext(pager, page) {
    if (!pagerCanNext(pager, page)) {
      return pager;
    }
    const stack = pager.stack.slice(0, pager.index + 1);
    stack.push(page.next_cursor);
    return { limit: pager.limit, stack, index: stack.length - 1, page };
  }

  /** 后退：弹出栈顶。回到第一页时 cursor 为 null。 */
  function pagerPrev(pager) {
    if (!pagerCanPrev(pager)) {
      return pager;
    }
    return { limit: pager.limit, stack: pager.stack, index: pager.index - 1, page: null };
  }

  function pagerReset(pager, limit) {
    return createPager(limit === undefined ? pager.limit : limit);
  }

  function pagerLabel(pager) {
    const page = pager.page;
    const index = `第 ${pager.index + 1} 页`;
    if (!page) {
      return index;
    }
    const parts = [
      index,
      `返回 ${page.returned ?? '—'}/${page.limit ?? pager.limit}`,
      `has_more=${page.has_more === true}`,
      `order=${page.order ?? '—'}`,
    ];
    if (page.byte_limited === true) {
      parts.push('byte_limited=true（因字节上限裁过行）');
    }
    return parts.join(' · ');
  }

  /* ══════════════════════════════════════════════════════════════════════
     6. 前端筛选（只作用于已加载页）
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * @param {object[]} items 已加载的条目。
   * @param {{severity?: string, status?: string, state?: string, report?: string, query?: string}} filter
   * @returns {object[]} 命中的条目。
   */
  function filterItems(items, filter) {
    const list = Array.isArray(items) ? items : [];
    const spec = filter ?? {};
    const query = typeof spec.query === 'string' ? spec.query.trim().toLowerCase() : '';
    return list.filter((item) => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      if (spec.severity && item.severity !== spec.severity) return false;
      if (spec.status && item.status !== spec.status) return false;
      if (spec.state && item.state !== spec.state) return false;
      if (spec.report === 'true' && item.report_available !== true) return false;
      if (spec.report === 'false' && item.report_available !== false) return false;
      if (query !== '') {
        const haystack = [item.alert_id, item.rule_id, item.analysis_id, item.budget_class]
          .filter((value) => typeof value === 'string')
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     7. 渲染：返回 HTML 字符串（DOM 层只负责挂载）
     ══════════════════════════════════════════════════════════════════════ */

  const MISSING_HTML = '<span class="missing" title="该字段不在 v0 响应白名单里">未提供</span>';

  function badge(text, attribute, tone, title) {
    const safeText = escapeHtml(text);
    const caption = title === undefined ? safeText : ` title="${escapeHtml(title)}"`;
    return `<span class="badge" ${attribute}="${escapeHtml(tone)}"${caption}>${safeText}</span>`;
  }

  function severityBadge(severity) {
    if (isMissing(severity) || severity === null) {
      return MISSING_HTML;
    }
    const label = SEVERITY_LABEL[severity] ?? '未知';
    return badge(severity, 'data-sev', severityTone(severity), `严重度 ${severity}（${label}）`);
  }

  function alertStatusBadge(status) {
    if (isMissing(status) || status === null) {
      return MISSING_HTML;
    }
    const label = ALERT_STATUS_LABEL[status] ?? '未知';
    return badge(status, 'data-tone', alertStatusTone(status), `状态 ${status}（${label}）`);
  }

  function analysisStateBadge(state) {
    if (isMissing(state) || state === null) {
      return MISSING_HTML;
    }
    const label = ANALYSIS_STATE_LABEL[state] ?? '未知';
    return badge(state, 'data-tone', analysisStateTone(state), `分析状态 ${state}（${label}）`);
  }

  /** 告警行。字段全部按白名单取值，绝不 `...item` 展开。 */
  function renderAlertRow(item) {
    const row = item ?? {};
    const alertId = pick(row, 'alert_id');
    const ruleId = pick(row, 'rule_id');
    const ruleVersion = pick(row, 'rule_version');
    const severity = pick(row, 'severity');
    const status = pick(row, 'status');
    const count = pick(row, 'count');
    const lastSeen = pick(row, 'last_seen');
    const evidenceCount = pick(row, 'evidence_count');
    const truncated = pick(row, 'evidence_truncated');

    const time = formatTimeUTC(lastSeen.value);
    const timeCell = isMissing(lastSeen.value) || lastSeen.value === null
      ? MISSING_HTML
      : `<span title="${escapeHtml(lastSeen.value)}">${escapeHtml(time)}</span>`;

    const evidenceCell = isMissing(evidenceCount.value) || evidenceCount.value === null
      ? MISSING_HTML
      : `${escapeHtml(groupNumber(evidenceCount.value) ?? evidenceCount.value)}`
        + (truncated.value === true ? '<span class="trunc" title="evidence_truncated=true：事件 id 列表被截断">截断</span>' : '');

    const ruleCell = isMissing(ruleId.value) || ruleId.value === null
      ? MISSING_HTML
      : `<div class="rule-cell"><span class="rule-id" title="${escapeHtml(ruleId.value)}">${escapeHtml(ruleId.value)}</span>`
        + `<span class="rule-ver">${isMissing(ruleVersion.value) || ruleVersion.value === null ? MISSING_HTML : `v${escapeHtml(ruleVersion.value)}`}</span></div>`;

    const idCell = isMissing(alertId.value) || alertId.value === null
      ? MISSING_HTML
      : `<span title="${escapeHtml(alertId.value)}">${escapeHtml(shortId(alertId.value))}</span>`;

    return `<tr data-kind="alert" data-id="${escapeHtml(alertId.value ?? '')}" tabindex="0">
      <td class="col-time">${timeCell}</td>
      <td class="col-sev">${severityBadge(severity.value)}</td>
      <td class="col-status">${alertStatusBadge(status.value)}</td>
      <td>${ruleCell}</td>
      <td class="col-num">${isMissing(count.value) || count.value === null ? MISSING_HTML : escapeHtml(groupNumber(count.value) ?? count.value)}</td>
      <td class="col-num">${evidenceCell}</td>
      <td class="col-id">${idCell}</td>
    </tr>`;
  }

  /** 分析行。 */
  function renderAnalysisRow(item) {
    const row = item ?? {};
    const analysisId = pick(row, 'analysis_id');
    const state = pick(row, 'state');
    const budget = pick(row, 'budget_class');
    const attempts = pick(row, 'attempts');
    const createdAt = pick(row, 'created_at');
    const completedAt = pick(row, 'completed_at');
    const report = pick(row, 'report_available');

    const createdText = formatTimeUTC(createdAt.value);
    const createdCell = isMissing(createdAt.value) || createdAt.value === null
      ? MISSING_HTML
      : `<span title="${escapeHtml(createdAt.value)}">${escapeHtml(createdText)}</span>`;

    let completedCell;
    if (isMissing(completedAt.value)) {
      completedCell = MISSING_HTML;
    } else if (completedAt.value === null) {
      completedCell = '<span class="dim" title="completed_at 为 null：未完成">未完成</span>';
    } else {
      completedCell = `<span title="${escapeHtml(completedAt.value)}">${escapeHtml(formatTimeUTC(completedAt.value))}</span>`;
    }

    const reportCell = isMissing(report.value) || report.value === null
      ? MISSING_HTML
      : (report.value === true
        ? badge('有报告', 'data-tone', 'ok')
        : badge('无报告', 'data-tone', 'idle', 'report_available=false：没有报告行，不代表分析失败'));

    const budgetCell = isMissing(budget.value) || budget.value === null
      ? MISSING_HTML
      : `<span class="mono">${escapeHtml(budget.value)}</span>`;

    const idCell = isMissing(analysisId.value) || analysisId.value === null
      ? MISSING_HTML
      : `<span title="${escapeHtml(analysisId.value)}">${escapeHtml(shortId(analysisId.value))}</span>`;

    return `<tr data-kind="analysis" data-id="${escapeHtml(analysisId.value ?? '')}" tabindex="0">
      <td class="col-time">${createdCell}</td>
      <td class="col-status">${analysisStateBadge(state.value)}</td>
      <td class="col-budget">${budgetCell}</td>
      <td class="col-num">${isMissing(attempts.value) || attempts.value === null ? MISSING_HTML : escapeHtml(String(attempts.value))}</td>
      <td class="col-time">${completedCell}</td>
      <td class="col-flag">${reportCell}</td>
      <td class="col-id">${idCell}</td>
    </tr>`;
  }

  function renderState(state) {
    const tone = state.kind === 'offline' || state.kind === 'error' || state.kind === 'server'
      ? 'bad'
      : (state.kind === 'auth' || state.kind === 'rate' || state.kind === 'no-api' || state.kind === 'file' ? 'warn' : 'idle');
    const icon = tone === 'bad' ? 'i-alert' : 'i-info';
    const code = state.code === null || state.code === undefined
      ? ''
      : `<span class="state-code">code ${escapeHtml(state.code)}</span>`;
    const hint = state.hint ? `<div class="state-detail">${escapeHtml(state.hint)}</div>` : '';
    const action = state.action === true
      ? '<div class="state-actions"><button class="btn" type="button" data-action="retry">重试</button>'
        + '<button class="btn btn-ghost" type="button" data-action="settings">连接设置</button></div>'
      : '';
    return `<div class="state" data-kind="${escapeHtml(state.kind)}">
      <div class="state-title"><svg class="ic" aria-hidden="true"><use href="#${icon}"/></svg>${escapeHtml(state.title)}</div>
      <div class="state-detail">${escapeHtml(state.detail)}</div>
      ${hint}
      ${code}
      ${action}
    </div>`;
  }

  function renderSkeleton(rows) {
    const count = Math.max(3, Math.min(10, rows ?? 5));
    let html = '<div class="skeleton" aria-label="加载中">';
    for (let index = 0; index < count; index += 1) {
      html += '<span></span>';
    }
    return `${html}</div>`;
  }

  /** 抽屉里的单行：键 / 值 / 「未提供」标记。 */
  function drawerField(key, value, options) {
    const settings = options ?? {};
    let rendered;
    if (isMissing(value)) {
      rendered = MISSING_HTML;
    } else if (value === null) {
      rendered = '<span class="field-val is-null">null</span>';
    } else if (typeof value === 'boolean') {
      rendered = value ? 'true' : 'false';
    } else if (settings.time === true) {
      rendered = `${escapeHtml(formatTimeUTC(value))}<span class="dim"> · ${escapeHtml(String(value))}</span>`;
    } else {
      rendered = escapeHtml(String(value));
    }
    return `<div class="field-row"><span class="field-key">${escapeHtml(key)}</span>`
      + `<span class="field-val${settings.mono === true ? ' mono' : ''}">${rendered}</span></div>`;
  }

  const DRAWER_EXCLUSION = '本抽屉只展示列表接口的白名单字段。v0 的 /api/v1/alerts 与 /api/v1/analysis '
    + '不含 event_ids、evidence_refs、fingerprint、summary、idempotency_key 或任何 lease 字段，'
    + '也没有单条详情路由，因此不会出现「证据明细」或「原始载荷」。';

  function renderAlertDrawer(item) {
    const row = item ?? {};
    const sections = [
      ['标识', [
        ['alert_id', pick(row, 'alert_id').value, { mono: true }],
        ['rule_id', pick(row, 'rule_id').value, { mono: true }],
        ['rule_version', pick(row, 'rule_version').value, { mono: true }],
      ]],
      ['判定', [
        ['severity', pick(row, 'severity').value, { mono: true }],
        ['status', pick(row, 'status').value, { mono: true }],
      ]],
      ['时间（UTC）', [
        ['first_seen', pick(row, 'first_seen').value, { time: true }],
        ['last_seen', pick(row, 'last_seen').value, { time: true }],
        ['window_start', pick(row, 'window_start').value, { time: true }],
        ['window_end', pick(row, 'window_end').value, { time: true }],
      ]],
      ['计数', [
        ['count', pick(row, 'count').value, {}],
        ['evidence_count', pick(row, 'evidence_count').value, {}],
        ['evidence_truncated', pick(row, 'evidence_truncated').value, {}],
      ]],
    ];
    let html = '';
    for (const [title, fields] of sections) {
      html += `<div class="section-label">${escapeHtml(title)}</div>`;
      for (const [label, value, options] of fields) {
        html += drawerField(label, value, options);
      }
    }
    html += `<p class="drawer-note">${escapeHtml(DRAWER_EXCLUSION)}</p>`;
    html += '<p class="drawer-note">evidence_count 是告警行里已留存的 <b>事件 id 条数</b>，不是 evidence 表的行数；'
      + 'count 是聚合次数，可能大于它。</p>';
    return html;
  }

  function renderAnalysisDrawer(item) {
    const row = item ?? {};
    const sections = [
      ['标识', [
        ['analysis_id', pick(row, 'analysis_id').value, { mono: true }],
        ['alert_id', pick(row, 'alert_id').value, { mono: true }],
      ]],
      ['状态', [
        ['state', pick(row, 'state').value, { mono: true }],
        ['budget_class', pick(row, 'budget_class').value, { mono: true }],
        ['attempts', pick(row, 'attempts').value, {}],
        ['report_available', pick(row, 'report_available').value, {}],
      ]],
      ['时间（UTC）', [
        ['created_at', pick(row, 'created_at').value, { time: true }],
        ['updated_at', pick(row, 'updated_at').value, { time: true }],
        ['completed_at', pick(row, 'completed_at').value, { time: true }],
      ]],
    ];
    let html = '';
    for (const [title, fields] of sections) {
      html += `<div class="section-label">${escapeHtml(title)}</div>`;
      for (const [label, value, options] of fields) {
        html += drawerField(label, value, options);
      }
    }
    html += `<p class="drawer-note">${escapeHtml(DRAWER_EXCLUSION)}</p>`;
    html += '<p class="drawer-note">report_available=false 只表示没有报告行。'
      + '分析链路的下游未接线，daemon 只把请求写进 analysis_outbox。</p>';
    return html;
  }

  function renderKeyValues(pairs) {
    let html = '<dl class="kv">';
    for (const [key, value] of pairs) {
      const rendered = isMissing(value)
        ? MISSING_HTML
        : (value === null ? '<span class="muted">null</span>' : escapeHtml(String(value)));
      html += `<dt>${escapeHtml(key)}</dt><dd>${rendered}</dd>`;
    }
    return `${html}</dl>`;
  }

  function renderReasons(reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) {
      return '<div class="empty-inline">health.reasons 为空 —— 没有上报的降级原因。</div>';
    }
    return `<ul class="reasons">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`;
  }

  function renderSourceList(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
      return '<div class="empty-inline">没有采集源。0.0.1 不随程序分发采集器，full 模式下需要宿主注入。</div>';
    }
    let html = '<table class="table"><thead><tr><th>id</th><th>kind</th><th>lifecycle</th>'
      + '<th class="col-num">polls</th><th class="col-num">events</th><th class="col-num">fail</th>'
      + '<th class="col-time">last_success_at</th></tr></thead><tbody>';
    for (const source of sources) {
      const lifecycle = source.lifecycle;
      const tone = lifecycle === 'degraded' ? 'bad' : (lifecycle === 'running' ? 'ok' : 'idle');
      html += `<tr style="cursor:default">
        <td class="col-id">${escapeHtml(source.id ?? '—')}</td>
        <td class="dim">${escapeHtml(source.kind ?? '—')}</td>
        <td>${badge(String(lifecycle ?? '—'), 'data-tone', tone)}${source.stale === true ? ' <span class="trunc">stale</span>' : ''}</td>
        <td class="col-num">${escapeHtml(String(source.polls ?? '—'))}</td>
        <td class="col-num">${escapeHtml(String(source.events ?? '—'))}</td>
        <td class="col-num">${escapeHtml(String(source.consecutive_failures ?? '—'))}</td>
        <td class="col-time">${escapeHtml(formatTimeUTC(source.last_success_at) ?? '—')}</td>
      </tr>`;
    }
    return `${html}</tbody></table>`;
  }

  /* ══════════════════════════════════════════════════════════════════════
     8. 状态
     ══════════════════════════════════════════════════════════════════════ */

  const DEFAULT_PREFS = {
    uiMode: 'embedded',
    autostart: false,
    connMode: 'proxy',
    base: 'http://127.0.0.1:8787',
    autoRefresh: true,
  };

  const state = {
    prefs: { ...DEFAULT_PREFS },
    token: '',
    csrf: '',
    view: 'overview',
    status: { phase: 'idle', data: null, error: null, at: null },
    alerts: { phase: 'idle', data: null, error: null, at: null, page: createPager(50) },
    analyses: { phase: 'idle', data: null, error: null, at: null, page: createPager(50) },
    filter: { alerts: { severity: '', status: '', query: '' }, analyses: { state: '', report: '', query: '' } },
    drawer: { kind: null, item: null },
    timer: null,
  };

  /* ══════════════════════════════════════════════════════════════════════
     9. 存储（失败即静默降级，不影响读取）
     ══════════════════════════════════════════════════════════════════════ */

  function readPrefs() {
    try {
      const raw = global.localStorage.getItem(PREFS_KEY);
      if (raw === null) return { ...DEFAULT_PREFS };
      const parsed = JSON.parse(raw);
      return {
        uiMode: parsed.uiMode === 'browser' ? 'browser' : 'embedded',
        autostart: parsed.autostart === true,
        connMode: parsed.connMode === 'direct' ? 'direct' : 'proxy',
        base: typeof parsed.base === 'string' && parsed.base ? parsed.base : DEFAULT_PREFS.base,
        autoRefresh: parsed.autoRefresh !== false,
      };
    } catch (error) {
      return { ...DEFAULT_PREFS };
    }
  }

  function writePrefs() {
    try {
      global.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch (error) {
      // 隐私模式或 file:// 下可能不可写；偏好丢失不影响读取。
    }
  }

  function readToken() {
    try {
      return global.sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch (error) {
      return state.token;
    }
  }

  function writeToken(value) {
    state.token = value;
    try {
      if (value === '') {
        global.sessionStorage.removeItem(TOKEN_KEY);
      } else {
        global.sessionStorage.setItem(TOKEN_KEY, value);
      }
    } catch (error) {
      // sessionStorage 不可用时只保留在内存里，仍是本标签页生命周期。
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     10. 传输层
     ══════════════════════════════════════════════════════════════════════ */

  function apiBase() {
    return state.prefs.connMode === 'direct' ? normalizeBase(state.prefs.base) : '';
  }

  function makeError(classified, extra) {
    return { classified, ...extra };
  }

  async function apiGet(path, params) {
    if (global.location !== undefined && global.location.protocol === 'file:') {
      throw makeError(classifyError({ protocol: 'file:' }));
    }
    const base = apiBase();
    if (state.prefs.connMode === 'direct' && !isLoopbackBase(base)) {
      throw makeError({
        kind: 'bad-base',
        title: '地址不合法',
        detail: '直连模式只接受 http://127.0.0.1:端口 或 http://[::1]:端口。',
        code: null,
        hint: 'daemon 只监听回环地址；localhost、https 与路径都会被拒绝。',
      });
    }
    const url = buildRequestUrl(base, path, params);
    const headers = buildHeaders({
      method: 'GET', mode: state.prefs.connMode, token: state.token,
    });

    let response;
    try {
      response = await global.fetch(url, {
        method: 'GET',
        headers,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (error) {
      throw makeError(classifyError({ network: true }), { cause: error });
    }

    let body = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
    }

    if (!response.ok) {
      // 非 JSON 的失败响应不是 daemon 发出来的：daemon 的每个错误体都是
      // `{error:{code,message}}`。这种情况几乎总是「静态服务器没转发 /api/v1/*」。
      if (body === null) {
        throw makeError({
          kind: 'no-api',
          title: '没有 API 代理',
          detail: `当前地址返回了非 JSON 的 HTTP ${response.status}，说明它只提供静态文件，没有转发 /api/v1/*。`,
          code: null,
          hint: '用 tests/console/mock-server.mjs 起一个带 mock 的同源服务，或让代理把 /api/v1/* 转到 daemon。',
        });
      }
      const payload = body !== null && typeof body === 'object' && body.error ? body.error : {};
      throw makeError(classifyError({
        status: response.status,
        code: typeof payload.code === 'string' ? payload.code : undefined,
        retryAfter: response.headers.get('retry-after') ?? undefined,
      }));
    }

    if (body === null || typeof body !== 'object') {
      throw makeError({
        kind: 'server',
        title: '响应不是 JSON',
        detail: 'daemon 的所有响应都是 application/json；拿到别的说明中间有代理或错误页。',
        code: null,
        hint: '检查同源代理的转发规则是否把非 /api/v1/* 的请求也一并吞掉了。',
      });
    }
    return body;
  }

  async function loadStatus() {
    state.status.phase = state.status.data === null ? 'loading' : 'refreshing';
    paintStatus();
    try {
      const body = await apiGet('/api/v1/status');
      state.status = { phase: 'ready', data: body, error: null, at: new Date() };
      // CSRF 证明只留在内存里，不落盘、不进 DOM。
      state.csrf = typeof body.csrf_token === 'string' ? body.csrf_token : '';
    } catch (error) {
      state.status = { phase: 'error', data: state.status.data, error, at: null };
    }
    paintStatus();
    paintChrome();
  }

  async function loadAlerts(options) {
    const settings = options ?? {};
    if (settings.reset === true) {
      state.alerts.page = pagerReset(state.alerts.page, clampLimit(dom.alertsLimit?.value ?? state.alerts.page.limit));
    }
    state.alerts.phase = 'loading';
    paintAlerts();
    try {
      const body = await apiGet('/api/v1/alerts', {
        limit: state.alerts.page.limit,
        cursor: pagerCursor(state.alerts.page),
      });
      state.alerts = {
        phase: 'ready',
        data: body,
        error: null,
        at: new Date(),
        page: { ...state.alerts.page, page: body.page ?? null },
      };
    } catch (error) {
      state.alerts.phase = 'error';
      state.alerts.error = error;
    }
    paintAlerts();
    paintChrome();
  }

  async function loadAnalyses(options) {
    const settings = options ?? {};
    if (settings.reset === true) {
      state.analyses.page = pagerReset(state.analyses.page, clampLimit(dom.anaLimit?.value ?? state.analyses.page.limit));
    }
    state.analyses.phase = 'loading';
    paintAnalyses();
    try {
      const body = await apiGet('/api/v1/analysis', {
        limit: state.analyses.page.limit,
        cursor: pagerCursor(state.analyses.page),
      });
      state.analyses = {
        phase: 'ready',
        data: body,
        error: null,
        at: new Date(),
        page: { ...state.analyses.page, page: body.page ?? null },
      };
    } catch (error) {
      state.analyses.phase = 'error';
      state.analyses.error = error;
    }
    paintAnalyses();
    paintChrome();
  }

  /* ══════════════════════════════════════════════════════════════════════
     11. DOM 句柄与通用写入
     ══════════════════════════════════════════════════════════════════════ */

  const dom = {};

  function byId(id) {
    return global.document.getElementById(id);
  }

  function cacheDom() {
    const ids = [
      'app', 'view-title', 'view-sub', 'conn-pill', 'conn-text', 'last-fetch', 'btn-refresh',
      'auto-refresh', 'file-warning', 'side-dot', 'side-lifecycle', 'side-version', 'side-endpoint',
      'stat-lifecycle', 'stat-health', 'stat-version', 'stat-schema', 'stat-uptime', 'stat-started',
      'stat-alerts', 'stat-alerts-sub', 'stat-reasons', 'stat-sources', 'stat-sources-sub',
      'ov-reasons', 'ov-counters', 'ov-sources', 'ov-runtime', 'health-status-note',
      'alerts-sev', 'alerts-status', 'alerts-q', 'alerts-limit', 'alerts-reload', 'alerts-body',
      'alerts-state', 'alerts-tablewrap', 'alerts-pageinfo', 'alerts-prev', 'alerts-next',
      'ana-state', 'ana-report', 'ana-q', 'ana-limit', 'ana-reload', 'ana-body',
      'ana-state-box', 'ana-tablewrap', 'ana-pageinfo', 'ana-prev', 'ana-next',
      'set-mode-embedded', 'set-mode-browser', 'set-autostart', 'set-autostart-text',
      'set-conn-proxy', 'set-conn-direct', 'set-base', 'set-token', 'set-token-clear',
      'set-port', 'set-port-note', 'set-test', 'set-reset', 'set-diag', 'set-about',
      'drawer', 'drawer-backdrop', 'drawer-title', 'drawer-body', 'drawer-close',
    ];
    for (const id of ids) {
      const key = id.replace(/-([a-z])/gu, (_, character) => character.toUpperCase());
      dom[key] = byId(id);
    }
  }

  function setText(element, value, missingLabel) {
    if (!element) return;
    if (value === null || value === undefined || value === '') {
      element.textContent = missingLabel ?? '未提供';
      element.classList.add('is-missing');
      return;
    }
    element.textContent = String(value);
    element.classList.remove('is-missing');
  }

  function setTone(element, tone) {
    if (element) {
      element.dataset.tone = tone;
    }
  }

  function setState(element, wrap, payload) {
    if (!element || !wrap) return;
    if (payload === null) {
      element.hidden = true;
      element.innerHTML = '';
      wrap.hidden = false;
      return;
    }
    element.hidden = false;
    element.innerHTML = payload;
    wrap.hidden = true;
  }

  /* ══════════════════════════════════════════════════════════════════════
     12. 渲染：概览
     ══════════════════════════════════════════════════════════════════════ */

  function summarizeStatus(body) {
    const source = body ?? {};
    const health = source.health ?? {};
    const counters = source.counters ?? {};
    const sources = Array.isArray(source.scheduler?.sources) ? source.scheduler.sources : [];
    return {
      version: pick(source, 'version').value,
      schemaVersion: pick(source, 'schema_version').value,
      lifecycle: pick(source, 'lifecycle').value,
      mode: pick(source, 'mode').value,
      startedAt: pick(source, 'started_at').value,
      uptimeMs: pick(source, 'uptime_ms').value,
      epoch: pick(source, 'epoch').value,
      now: pick(source, 'now').value,
      healthStatus: pick(health, 'status').value,
      healthReady: pick(health, 'ready').value,
      reasons: Array.isArray(health.reasons) ? health.reasons : [],
      alertWrites: pick(counters, 'alerts_written').value,
      counters,
      sources,
      degradedSources: sources.filter((entry) => entry.lifecycle === 'degraded').length,
      staleSources: sources.filter((entry) => entry.stale === true).length,
      storeKind: pick(source.store ?? {}, 'kind').value,
      storeOpen: pick(source.store ?? {}, 'open').value,
      storeKeys: Object.keys(source.store ?? {}),
    };
  }

  function paintStatus() {
    const phase = state.status.phase;
    const body = state.status.data;

    if (phase === 'loading' && body === null) {
      for (const id of ['statLifecycle', 'statVersion', 'statUptime', 'statAlerts', 'statReasons', 'statSources']) {
        if (dom[id]) {
          dom[id].textContent = '读取中';
          dom[id].classList.add('is-missing');
        }
      }
      if (dom.ovReasons) dom.ovReasons.innerHTML = renderSkeleton(3);
      if (dom.ovCounters) dom.ovCounters.innerHTML = renderSkeleton(6);
      if (dom.ovSources) dom.ovSources.innerHTML = renderSkeleton(2);
      if (dom.ovRuntime) dom.ovRuntime.innerHTML = renderSkeleton(5);
      return;
    }

    if (phase === 'error' && body === null) {
      const error = state.status.error?.classified ?? classifyError({});
      if (dom.ovReasons) {
        dom.ovReasons.innerHTML = renderState({
          ...error,
          action: true,
        });
      }
      for (const id of ['statLifecycle', 'statVersion', 'statUptime', 'statAlerts', 'statReasons', 'statSources']) {
        if (dom[id]) {
          dom[id].textContent = error.kind === 'offline' ? '服务未启动' : '读取失败';
          dom[id].classList.add('is-missing');
        }
      }
      if (dom.ovCounters) dom.ovCounters.innerHTML = '<div class="empty-inline">状态读取失败，没有可用计数。</div>';
      if (dom.ovSources) dom.ovSources.innerHTML = '<div class="empty-inline">状态读取失败，没有可用采集源信息。</div>';
      if (dom.ovRuntime) dom.ovRuntime.innerHTML = '<div class="empty-inline">状态读取失败。</div>';
      return;
    }

    if (body === null) {
      return;
    }

    // 读取失败但手里还有上一次的数据：卡片保留旧值，但必须把失败原因顶到最前面，
    // 否则「pill 变红、下面一切正常」会让人以为数据是新的。
    const failure = phase === 'error'
      ? (state.status.error?.classified ?? classifyError({}))
      : null;

    const summary = summarizeStatus(body);

    setText(dom.statLifecycle, summary.lifecycle);
    setText(dom.statHealth, `health ${summary.healthStatus ?? '—'} · ready=${summary.healthReady === undefined ? '—' : String(summary.healthReady)}`);

    setText(dom.statVersion, summary.version);
    setText(dom.statSchema, `schema ${summary.schemaVersion ?? '—'} · mode ${summary.mode ?? '—'}`);

    setText(dom.statUptime, formatUptime(summary.uptimeMs));
    setText(dom.statStarted, summary.startedAt ? `启动 ${formatTimeUTC(summary.startedAt)} UTC` : 'started_at 未提供');

    setText(dom.statAlerts, groupNumber(summary.alertWrites));
    if (dom.statAlertsSub) {
      dom.statAlertsSub.textContent = 'counters.alerts_written 累计写入，非当前告警总数';
    }

    setText(dom.statReasons, String(summary.reasons.length));
    setText(dom.statSources, String(summary.sources.length));
    if (dom.statSourcesSub) {
      dom.statSourcesSub.textContent = `${summary.degradedSources} 降级 · ${summary.staleSources} 陈旧`;
    }

    if (dom.healthStatusNote) {
      dom.healthStatusNote.textContent = `health.status=${summary.healthStatus ?? '—'} · ready=${String(summary.healthReady)}`;
      setTone(dom.healthStatusNote, healthTone(summary.healthStatus));
    }

    if (dom.ovReasons) {
      const reasonsHtml = renderReasons(summary.reasons);
      dom.ovReasons.innerHTML = failure === null
        ? reasonsHtml
        : `${renderState({ ...failure, action: true })}<div class="empty-inline">下方数值来自最近一次成功读取，可能已经过期。</div>${reasonsHtml}`;
    }

    if (dom.ovCounters) {
      const keys = Object.keys(summary.counters);
      dom.ovCounters.innerHTML = keys.length === 0
        ? '<div class="empty-inline">counters 为空。</div>'
        : renderKeyValues(keys.map((key) => [key, summary.counters[key]]));
    }

    if (dom.ovSources) dom.ovSources.innerHTML = renderSourceList(summary.sources);

    if (dom.ovRuntime) {
      const pairs = [
        ['mode', summary.mode],
        ['store.kind', summary.storeKind],
        ['store.open', summary.storeOpen === undefined ? undefined : String(summary.storeOpen)],
        ['epoch', summary.epoch],
        ['now', summary.now],
      ];
      for (const key of summary.storeKeys) {
        if (key === 'kind' || key === 'open') continue;
        pairs.push([`store.${key}`, JSON.stringify(body.store[key])]);
      }
      dom.ovRuntime.innerHTML = renderKeyValues(pairs);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     13. 渲染：告警 / 分析
     ══════════════════════════════════════════════════════════════════════ */

  function paintAlerts() {
    const slice = state.alerts;
    const filter = state.filter.alerts;

    if (slice.phase === 'loading') {
      setState(dom.alertsState, dom.alertsTablewrap, renderSkeleton(6));
      if (dom.alertsPrev) dom.alertsPrev.disabled = true;
      if (dom.alertsNext) dom.alertsNext.disabled = true;
      if (dom.alertsPageinfo) dom.alertsPageinfo.textContent = '读取中…';
      return;
    }

    if (slice.phase === 'error') {
      const error = slice.error?.classified ?? classifyError({});
      setState(dom.alertsState, dom.alertsTablewrap, renderState({ ...error, action: true }));
      if (dom.alertsBody) dom.alertsBody.innerHTML = '';
      if (dom.alertsPrev) dom.alertsPrev.disabled = !pagerCanPrev(slice.page);
      if (dom.alertsNext) dom.alertsNext.disabled = true;
      if (dom.alertsPageinfo) dom.alertsPageinfo.textContent = '—';
      return;
    }

    if (slice.phase !== 'ready' || slice.data === null) {
      setState(dom.alertsState, dom.alertsTablewrap, renderState({
        kind: 'idle',
        title: '尚未读取',
        detail: '点击「读取」从 /api/v1/alerts 拉一页。',
        code: null,
        hint: null,
        action: false,
      }));
      return;
    }

    const items = Array.isArray(slice.data.alerts) ? slice.data.alerts : [];
    const visible = filterItems(items, filter);

    if (items.length === 0) {
      setState(dom.alertsState, dom.alertsTablewrap, renderState({
        kind: 'empty',
        title: '没有告警',
        detail: '服务端返回 alerts 为空数组。这是「确实没有」，不是「读不到」——读不到会以 503 报错而不是空列表。',
        code: null,
        hint: null,
        action: false,
      }));
    } else if (visible.length === 0) {
      setState(dom.alertsState, dom.alertsTablewrap, renderState({
        kind: 'empty',
        title: '本页没有匹配项',
        detail: `当前页 ${items.length} 条告警，被筛选条件全部滤掉。筛选只作用于已加载页，服务端不支持按条件查询。`,
        code: null,
        hint: '清空筛选，或翻页后重试。',
        action: false,
      }));
    } else {
      setState(dom.alertsState, dom.alertsTablewrap, null);
      if (dom.alertsBody) {
        dom.alertsBody.innerHTML = visible.map((item) => renderAlertRow(item)).join('');
      }
    }

    if (dom.alertsPageinfo) dom.alertsPageinfo.textContent = pagerLabel(slice.page);
    if (dom.alertsPrev) dom.alertsPrev.disabled = !pagerCanPrev(slice.page);
    if (dom.alertsNext) dom.alertsNext.disabled = !pagerCanNext(slice.page);
  }

  function paintAnalyses() {
    const slice = state.analyses;
    const filter = state.filter.analyses;

    if (slice.phase === 'loading') {
      setState(dom.anaStateBox, dom.anaTablewrap, renderSkeleton(6));
      if (dom.anaPrev) dom.anaPrev.disabled = true;
      if (dom.anaNext) dom.anaNext.disabled = true;
      if (dom.anaPageinfo) dom.anaPageinfo.textContent = '读取中…';
      return;
    }

    if (slice.phase === 'error') {
      const error = slice.error?.classified ?? classifyError({});
      setState(dom.anaStateBox, dom.anaTablewrap, renderState({ ...error, action: true }));
      if (dom.anaBody) dom.anaBody.innerHTML = '';
      if (dom.anaPrev) dom.anaPrev.disabled = !pagerCanPrev(slice.page);
      if (dom.anaNext) dom.anaNext.disabled = true;
      if (dom.anaPageinfo) dom.anaPageinfo.textContent = '—';
      return;
    }

    if (slice.phase !== 'ready' || slice.data === null) {
      setState(dom.anaStateBox, dom.anaTablewrap, renderState({
        kind: 'idle',
        title: '尚未读取',
        detail: '点击「读取」从 /api/v1/analysis 拉一页。',
        code: null,
        hint: null,
        action: false,
      }));
      return;
    }

    const items = Array.isArray(slice.data.analyses) ? slice.data.analyses : [];
    const visible = filterItems(items, filter);

    if (items.length === 0) {
      setState(dom.anaStateBox, dom.anaTablewrap, renderState({
        kind: 'empty',
        title: '没有分析记录',
        detail: '分析请求由检测阶段写入 analysis_outbox；当前链路下游未接线，出现长期为空是预期现象。',
        code: null,
        hint: null,
        action: false,
      }));
    } else if (visible.length === 0) {
      setState(dom.anaStateBox, dom.anaTablewrap, renderState({
        kind: 'empty',
        title: '本页没有匹配项',
        detail: `当前页 ${items.length} 条记录被筛选条件全部滤掉。`,
        code: null,
        hint: '清空筛选，或翻页后重试。',
        action: false,
      }));
    } else {
      setState(dom.anaStateBox, dom.anaTablewrap, null);
      if (dom.anaBody) {
        dom.anaBody.innerHTML = visible.map((item) => renderAnalysisRow(item)).join('');
      }
    }

    if (dom.anaPageinfo) dom.anaPageinfo.textContent = pagerLabel(slice.page);
    if (dom.anaPrev) dom.anaPrev.disabled = !pagerCanPrev(slice.page);
    if (dom.anaNext) dom.anaNext.disabled = !pagerCanNext(slice.page);
  }

  /* ══════════════════════════════════════════════════════════════════════
     14. 渲染：顶栏、侧栏、设置、关于
     ══════════════════════════════════════════════════════════════════════ */

  function paintChrome() {
    const ready = state.status.phase === 'ready' && state.status.data !== null;
    const error = state.status.error?.classified ?? null;
    const summary = ready ? summarizeStatus(state.status.data) : null;

    let tone = 'idle';
    let label = '未连接';
    if (state.status.phase === 'loading' && state.status.data === null) {
      tone = 'busy';
      label = '连接中';
    } else if (ready) {
      tone = healthTone(summary.healthStatus);
      label = summary.healthStatus === 'ok' ? '服务在线' : (summary.healthStatus === 'degraded' ? '服务降级' : '服务异常');
    } else if (error !== null) {
      tone = error.kind === 'offline' ? 'bad' : 'warn';
      label = error.kind === 'offline' ? '服务未启动' : '读取失败';
    }

    if (dom.connPill) {
      dom.connPill.dataset.tone = tone;
      const dot = dom.connPill.querySelector('.dot');
      if (dot) dot.dataset.tone = tone;
    }
    if (dom.connText) dom.connText.textContent = label;
    if (dom.sideDot) dom.sideDot.dataset.tone = tone;
    if (dom.sideLifecycle) dom.sideLifecycle.textContent = ready ? summary.lifecycle : label;

    if (dom.sideVersion) {
      dom.sideVersion.textContent = ready && summary.version ? `版本 ${summary.version}` : '版本 —';
    }
    if (dom.sideEndpoint) {
      const base = apiBase();
      dom.sideEndpoint.textContent = state.prefs.connMode === 'direct'
        ? (base || '直连地址未设置')
        : `同源 ${global.location?.host || '—'}`;
      dom.sideEndpoint.title = state.prefs.connMode === 'direct' ? base : '同源代理';
    }

    const stamp = state.status.at ?? state.alerts.at ?? state.analyses.at;
    if (dom.lastFetch) {
      dom.lastFetch.textContent = stamp instanceof Date
        ? `更新 ${stamp.toTimeString().slice(0, 8)}`
        : '尚未更新';
      dom.lastFetch.title = stamp instanceof Date ? stamp.toISOString() : '还没有成功读取过';
    }

    paintPort();
    paintAbout(ready ? state.status.data : null);
  }

  function paintPort() {
    if (!dom.setPort) return;
    const location = global.location ?? {};
    const host = typeof location.host === 'string' ? location.host : '';
    const match = /:(\d{1,5})$/u.exec(host);
    const originPort = match ? match[1] : (location.protocol === 'https:' ? '443' : '80');
    const directPort = /:(\d{1,5})$/u.exec(normalizeBase(state.prefs.base));

    if (state.prefs.connMode === 'direct' && directPort) {
      dom.setPort.textContent = directPort[1];
      if (dom.setPortNote) {
        dom.setPortNote.textContent = '取自你在上方填写的直连地址；status 响应本身不含 api.port。';
      }
      return;
    }

    dom.setPort.textContent = originPort || '—';
    if (dom.setPortNote) {
      dom.setPortNote.textContent = '当前页面来源端口（不是 daemon 的端口）。'
        + 'status 响应不含 api.port，daemon 默认 api.port=0 为临时端口。';
    }
  }

  function paintAbout(body) {
    if (!dom.setAbout) return;
    const pairs = [
      ['产品', 'AIDriven NetDefense / 网域智防'],
      ['作者', 'PT-dove'],
      ['开发树版本', body ? (pick(body, 'version').value ?? '未提供') : '未连接'],
      ['契约', 'v0 只读（/api/v1/alerts、/api/v1/analysis）'],
      ['不提供', '写操作、审批、响应执行、单条详情、遥测读取'], 
      ['已知边界', '无安装器 / 无服务单元 / 无桌面壳；分析链路下游未接线'],
    ];
    dom.setAbout.innerHTML = renderKeyValues(pairs);
  }

  function paintSettings() {
    if (dom.setModeEmbedded) dom.setModeEmbedded.checked = state.prefs.uiMode === 'embedded';
    if (dom.setModeBrowser) dom.setModeBrowser.checked = state.prefs.uiMode === 'browser';
    if (dom.setAutostart) dom.setAutostart.checked = state.prefs.autostart === true;
    if (dom.setAutostartText) dom.setAutostartText.textContent = state.prefs.autostart ? '开启（仅记录）' : '关闭';
    if (dom.setConnProxy) dom.setConnProxy.checked = state.prefs.connMode === 'proxy';
    if (dom.setConnDirect) dom.setConnDirect.checked = state.prefs.connMode === 'direct';
    if (dom.setBase) dom.setBase.value = state.prefs.base;
    if (dom.setToken) dom.setToken.value = state.token;
    if (dom.autoRefresh) dom.autoRefresh.checked = state.prefs.autoRefresh === true;
    paintPort();
  }

  /* ══════════════════════════════════════════════════════════════════════
     15. 路由
     ══════════════════════════════════════════════════════════════════════ */

  const VIEW_META = {
    overview: { title: '概览', sub: 'GET /api/v1/status · 只读' },
    alerts: { title: '告警', sub: 'GET /api/v1/alerts · keyset 分页' },
    analysis: { title: '分析结果', sub: 'GET /api/v1/analysis · keyset 分页' },
    settings: { title: '设置', sub: '本机偏好 · 不入库' },
  };

  function currentRoute() {
    const hash = String(global.location.hash ?? '').replace(/^#\/?/u, '');
    return Object.prototype.hasOwnProperty.call(VIEW_META, hash) ? hash : 'overview';
  }

  function route() {
    const view = currentRoute();
    state.view = view;
    for (const name of Object.keys(VIEW_META)) {
      const section = global.document.querySelector(`section.view[data-view="${name}"]`);
      if (section) section.hidden = name !== view;
      const nav = byId(`nav-${name}`);
      if (nav) {
        nav.classList.toggle('is-active', name === view);
        nav.setAttribute('aria-current', name === view ? 'page' : 'false');
      }
    }
    const meta = VIEW_META[view];
    if (dom.viewTitle) dom.viewTitle.textContent = meta.title;
    if (dom.viewSub) dom.viewSub.textContent = meta.sub;
    closeDrawer();

    if (view === 'alerts' && state.alerts.phase === 'idle') loadAlerts();
    if (view === 'analysis' && state.analyses.phase === 'idle') loadAnalyses();
    if (view === 'settings') paintSettings();
  }

  /* ══════════════════════════════════════════════════════════════════════
     16. 抽屉
     ══════════════════════════════════════════════════════════════════════ */

  function openDrawer(kind, item) {
    state.drawer = { kind, item };
    if (!dom.drawer || !dom.drawerBackdrop) return;
    dom.drawerTitle.textContent = kind === 'alert' ? '告警详情' : '分析详情';
    dom.drawerBody.innerHTML = kind === 'alert' ? renderAlertDrawer(item) : renderAnalysisDrawer(item);
    dom.drawer.hidden = false;
    dom.drawer.setAttribute('aria-hidden', 'false');
    dom.drawerBackdrop.hidden = false;
    const close = byId('drawer-close');
    if (close) close.focus();
  }

  function closeDrawer() {
    state.drawer = { kind: null, item: null };
    if (dom.drawer) {
      dom.drawer.hidden = true;
      dom.drawer.setAttribute('aria-hidden', 'true');
    }
    if (dom.drawerBackdrop) dom.drawerBackdrop.hidden = true;
    for (const row of global.document.querySelectorAll('tr.is-open')) {
      row.classList.remove('is-open');
    }
  }

  function findRow(kind, id) {
    const slice = kind === 'alert' ? state.alerts : state.analyses;
    const list = kind === 'alert'
      ? (Array.isArray(slice.data?.alerts) ? slice.data.alerts : [])
      : (Array.isArray(slice.data?.analyses) ? slice.data.analyses : []);
    return list.find((item) => {
      const key = kind === 'alert' ? 'alert_id' : 'analysis_id';
      return item && item[key] === id;
    }) ?? null;
  }

  /* ══════════════════════════════════════════════════════════════════════
     17. 事件绑定
     ══════════════════════════════════════════════════════════════════════ */

  function fillEnumOptions(select, values, labels) {
    if (!select) return;
    const fragment = global.document.createDocumentFragment();
    select.innerHTML = '<option value="">全部</option>';
    for (const value of values) {
      const option = global.document.createElement('option');
      option.value = value;
      option.textContent = `${labels[value] ?? value} (${value})`;
      fragment.appendChild(option);
    }
    select.appendChild(fragment);
  }

  function bindNav() {
    global.addEventListener('hashchange', route);
  }

  function bindToolbar() {
    if (dom.btnRefresh) {
      dom.btnRefresh.addEventListener('click', () => {
        loadStatus();
        if (state.view === 'alerts') loadAlerts();
        if (state.view === 'analysis') loadAnalyses();
      });
    }

    if (dom.autoRefresh) {
      dom.autoRefresh.checked = state.prefs.autoRefresh === true;
      dom.autoRefresh.addEventListener('change', () => {
        state.prefs.autoRefresh = dom.autoRefresh.checked;
        writePrefs();
        scheduleRefresh();
      });
    }

    if (dom.alertsSev) {
      dom.alertsSev.addEventListener('change', () => {
        state.filter.alerts.severity = dom.alertsSev.value;
        paintAlerts();
      });
    }
    if (dom.alertsStatus) {
      dom.alertsStatus.addEventListener('change', () => {
        state.filter.alerts.status = dom.alertsStatus.value;
        paintAlerts();
      });
    }
    if (dom.alertsQ) {
      dom.alertsQ.addEventListener('input', () => {
        state.filter.alerts.query = dom.alertsQ.value;
        paintAlerts();
      });
    }
    if (dom.alertsLimit) {
      dom.alertsLimit.addEventListener('change', () => loadAlerts({ reset: true }));
    }
    if (dom.alertsReload) dom.alertsReload.addEventListener('click', () => loadAlerts());
    if (dom.alertsPrev) {
      dom.alertsPrev.addEventListener('click', () => {
        state.alerts.page = pagerPrev(state.alerts.page);
        loadAlerts();
      });
    }
    if (dom.alertsNext) {
      dom.alertsNext.addEventListener('click', () => {
        state.alerts.page = pagerNext(state.alerts.page, state.alerts.page.page);
        loadAlerts();
      });
    }

    if (dom.anaState) {
      dom.anaState.addEventListener('change', () => {
        state.filter.analyses.state = dom.anaState.value;
        paintAnalyses();
      });
    }
    if (dom.anaReport) {
      dom.anaReport.addEventListener('change', () => {
        state.filter.analyses.report = dom.anaReport.value;
        paintAnalyses();
      });
    }
    if (dom.anaQ) {
      dom.anaQ.addEventListener('input', () => {
        state.filter.analyses.query = dom.anaQ.value;
        paintAnalyses();
      });
    }
    if (dom.anaLimit) dom.anaLimit.addEventListener('change', () => loadAnalyses({ reset: true }));
    if (dom.anaReload) dom.anaReload.addEventListener('click', () => loadAnalyses());
    if (dom.anaPrev) {
      dom.anaPrev.addEventListener('click', () => {
        state.analyses.page = pagerPrev(state.analyses.page);
        loadAnalyses();
      });
    }
    if (dom.anaNext) {
      dom.anaNext.addEventListener('click', () => {
        state.analyses.page = pagerNext(state.analyses.page, state.analyses.page.page);
        loadAnalyses();
      });
    }
  }

  function bindRows() {
    const handler = (event) => {
      const row = event.target.closest?.('tr[data-kind]');
      if (!row) return;
      const id = row.dataset.id;
      const kind = row.dataset.kind;
      const item = findRow(kind, id);
      if (item === null) return;
      for (const other of global.document.querySelectorAll('tr.is-open')) {
        other.classList.remove('is-open');
      }
      row.classList.add('is-open');
      openDrawer(kind, item);
    };
    for (const body of [dom.alertsBody, dom.anaBody]) {
      if (!body) continue;
      body.addEventListener('click', handler);
      body.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handler(event);
        }
      });
    }
  }

  function bindStateActions() {
    for (const box of [dom.alertsState, dom.anaStateBox, dom.ovReasons]) {
      if (!box) continue;
      box.addEventListener('click', (event) => {
        const action = event.target.closest?.('[data-action]')?.dataset.action;
        if (!action) return;
        if (action === 'retry') {
          loadStatus();
          if (box === dom.anaStateBox) loadAnalyses();
          else if (box === dom.alertsState) loadAlerts();
        }
        if (action === 'settings') {
          global.location.hash = '#/settings';
        }
      });
    }
  }

  function bindSettings() {
    const onUiMode = () => {
      state.prefs.uiMode = dom.setModeBrowser?.checked ? 'browser' : 'embedded';
      writePrefs();
    };
    for (const radio of [dom.setModeEmbedded, dom.setModeBrowser]) {
      if (radio) radio.addEventListener('change', onUiMode);
    }

    if (dom.setAutostart) {
      dom.setAutostart.addEventListener('change', () => {
        state.prefs.autostart = dom.setAutostart.checked;
        if (dom.setAutostartText) {
          dom.setAutostartText.textContent = state.prefs.autostart ? '开启（仅记录）' : '关闭';
        }
        writePrefs();
      });
    }

    const onConnMode = () => {
      state.prefs.connMode = dom.setConnDirect?.checked ? 'direct' : 'proxy';
      writePrefs();
      paintPort();
      paintChrome();
      loadStatus();
    };
    for (const radio of [dom.setConnProxy, dom.setConnDirect]) {
      if (radio) radio.addEventListener('change', onConnMode);
    }

    if (dom.setBase) {
      dom.setBase.addEventListener('change', () => {
        state.prefs.base = dom.setBase.value.trim();
        writePrefs();
        paintPort();
        if (state.prefs.connMode === 'direct') loadStatus();
      });
    }

    if (dom.setToken) {
      dom.setToken.addEventListener('change', () => {
        writeToken(dom.setToken.value.trim());
        if (state.prefs.connMode === 'direct') loadStatus();
      });
    }

    if (dom.setTokenClear) {
      dom.setTokenClear.addEventListener('click', () => {
        writeToken('');
        if (dom.setToken) dom.setToken.value = '';
      });
    }

    if (dom.setReset) {
      dom.setReset.addEventListener('click', () => {
        state.prefs = { ...DEFAULT_PREFS };
        writePrefs();
        writeToken('');
        paintSettings();
        loadStatus();
      });
    }

    if (dom.setTest) dom.setTest.addEventListener('click', runDiagnostics);
  }

  function bindDrawer() {
    if (dom.drawerClose) dom.drawerClose.addEventListener('click', closeDrawer);
    if (dom.drawerBackdrop) dom.drawerBackdrop.addEventListener('click', closeDrawer);
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDrawer();
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     18. 自检
     ══════════════════════════════════════════════════════════════════════ */

  async function runDiagnostics() {
    if (!dom.setDiag) return;
    const lines = [];
    const stamp = new Date().toISOString();
    lines.push(`# ${stamp}`);
    lines.push(`mode=${state.prefs.connMode} base=${state.prefs.connMode === 'direct' ? (apiBase() || '(空)') : '(同源)'}`);
    lines.push(`token=${state.token ? `已设置（${state.token.length} 字符）` : '未设置'}`);
    lines.push(`file://=${global.location?.protocol === 'file:'}`);
    dom.setDiag.textContent = `${lines.join('\n')}\n\n请求中…`;

    const targets = [
      ['/api/v1/status', {}],
      ['/api/v1/alerts', { limit: 1 }],
      ['/api/v1/analysis', { limit: 1 }],
    ];

    for (const [path, params] of targets) {
      const started = global.performance?.now?.() ?? Date.now();
      try {
        const body = await apiGet(path, params);
        const elapsed = Math.round((global.performance?.now?.() ?? Date.now()) - started);
        const keys = Object.keys(body).sort().join(',');
        lines.push(`OK   ${path} ${elapsed}ms`);
        lines.push(`     keys: ${keys}`);
        if (body.page) {
          lines.push(`     page: limit=${body.page.limit} returned=${body.page.returned} has_more=${body.page.has_more} order=${body.page.order}`);
        }
      } catch (error) {
        const classified = error.classified ?? classifyError({});
        lines.push(`FAIL ${path} → ${classified.kind} ${classified.title}${classified.code ? ` (${classified.code})` : ''}`);
        lines.push(`     ${classified.detail}`);
      }
    }
    lines.push('');
    lines.push('说明：只读端点不需要 Origin / CSRF。状态变更请求才需要 x-aegis-csrf，'
      + '本控制台不发任何写请求，因此自检不会触碰 CSRF。');
    dom.setDiag.textContent = lines.join('\n');
    loadStatus();
  }

  /* ══════════════════════════════════════════════════════════════════════
     19. 自动刷新
     ══════════════════════════════════════════════════════════════════════ */

  function scheduleRefresh() {
    if (state.timer !== null) {
      global.clearInterval(state.timer);
      state.timer = null;
    }
    if (state.prefs.autoRefresh !== true) {
      return;
    }
    state.timer = global.setInterval(() => {
      if (global.document.hidden === true) {
        return;
      }
      loadStatus();
    }, 10000);
  }

  /* ══════════════════════════════════════════════════════════════════════
     20. 启动
     ══════════════════════════════════════════════════════════════════════ */

  function boot() {
    cacheDom();
    state.prefs = readPrefs();
    state.token = readToken();

    fillEnumOptions(dom.alertsSev, SEVERITIES, SEVERITY_LABEL);
    fillEnumOptions(dom.alertsStatus, ALERT_STATUSES, ALERT_STATUS_LABEL);
    fillEnumOptions(dom.anaState, ANALYSIS_STATES, ANALYSIS_STATE_LABEL);

    if (dom.fileWarning) {
      dom.fileWarning.hidden = global.location?.protocol !== 'file:';
    }

    bindNav();
    bindToolbar();
    bindRows();
    bindStateActions();
    bindSettings();
    bindDrawer();
    paintSettings();
    route();
    paintChrome();
    loadStatus();
    scheduleRefresh();
  }

  /* ══════════════════════════════════════════════════════════════════════
     21. 导出（供 node 侧断言使用；浏览器里挂在 globalThis 上）
     ══════════════════════════════════════════════════════════════════════ */

  const Core = {
    SEVERITIES,
    SEVERITY_LABEL,
    ALERT_STATUSES,
    ALERT_STATUS_LABEL,
    ANALYSIS_STATES,
    ANALYSIS_STATE_LABEL,
    ALERT_FIELDS,
    ANALYSIS_FIELDS,
    PAGE_FIELDS,
    ALLOWED_QUERY,
    LIMITS,
    DEFAULT_PREFS,
    escapeHtml,
    pick,
    groupNumber,
    formatUptime,
    formatTimeUTC,
    shortId,
    severityRank,
    severityTone,
    alertStatusTone,
    analysisStateTone,
    healthTone,
    clampLimit,
    normalizeBase,
    isLoopbackBase,
    buildQuery,
    buildRequestUrl,
    buildHeaders,
    classifyError,
    createPager,
    pagerCursor,
    pagerCanPrev,
    pagerCanNext,
    pagerNext,
    pagerPrev,
    pagerReset,
    pagerLabel,
    filterItems,
    renderAlertRow,
    renderAnalysisRow,
    renderState,
    renderSkeleton,
    renderReasons,
    renderSourceList,
    renderKeyValues,
    renderAlertDrawer,
    renderAnalysisDrawer,
    summarizeStatus,
  };

  global.NDConsole = Core;

  if (typeof global.document !== 'undefined' && global.document.getElementById('app') !== null) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
