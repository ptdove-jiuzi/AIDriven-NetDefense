/*
 * app.js — 桌面壳内置控制台的前端。
 *
 * 数据来源只有两个同源端点，没有任何写死的示例值：
 *   /api/v1/status    daemon 的鉴权状态负载（由桌面壳代理并注入 bearer）
 *   /api/v1/alerts    告警分页（同上）
 *   /api/v1/analysis  分析分页（同上）
 *   /shell/api/state  桌面壳自身的运行时信息（端口、进程号、安装路径、设置）
 *
 * 拿不到就显示「离线 / —」，不编造。所有 daemon 版本、时长、计数都来自响应体。
 */
'use strict';

const state = {
  view: 'overview',
  shell: null,
  status: null,
  alerts: { items: [], cursor: null, hasMore: false },
  analysis: { items: [], cursor: null, hasMore: false },
  timer: null,
};

const $ = (id) => document.getElementById(id);

/* -------------------------------------------------------------- formatting */

function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function fmtTime(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtClock(d) {
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function text(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function el(tag, cls, content) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined) node.textContent = content;
  return node;
}

/* ------------------------------------------------------------------ network */

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body?.error?.code || `HTTP_${res.status}`;
    throw err;
  }
  return body;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aidn-shell': '1' },
    body: JSON.stringify(payload ?? {}),
    cache: 'no-store',
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

/* ---------------------------------------------------------------- rendering */

function setConn(online, label) {
  const dot = $('conn-dot');
  dot.className = `dot ${online ? 'ok' : 'bad'}`;
  $('conn-text').textContent = label;
}

function renderStatus() {
  const s = state.status;
  const shell = state.shell;

  const dot = $('st-dot');
  const label = $('st-label');
  const hint = $('st-hint');
  const badge = $('st-health');

  $('st-port').textContent = shell?.daemon?.port ? String(shell.daemon.port) : '—';

  if (s === null) {
    dot.className = 'dot dot-lg bad';
    label.textContent = 'daemon 离线';
    hint.textContent = shell?.daemon?.last_error
      ? `启动失败：${shell.daemon.last_error}`
      : '桌面壳没有从 daemon 拿到 /api/v1/status';
    badge.textContent = '离线';
    badge.style.background = 'var(--bad-soft)';
    badge.style.color = 'var(--bad)';
    $('st-version').textContent = '—';
    $('st-uptime').textContent = '—';
    $('st-mode').textContent = '—';
    $('st-reasons').hidden = true;
    return;
  }

  const health = s.health ?? {};
  const okState = health.status === 'ok';
  const bad = health.status === 'failed';
  dot.className = `dot dot-lg ${okState ? 'ok' : bad ? 'bad' : 'warn'}`;
  label.textContent = 'daemon 在线';
  hint.textContent = `已连接 ${shell?.daemon?.host ?? '127.0.0.1'}:${shell?.daemon?.port ?? '—'} · 进程 ${shell?.daemon?.pid ?? '—'}`;
  badge.textContent = health.status === 'ok' ? '健康' : health.status === 'failed' ? '故障' : '降级';
  badge.style.background = okState ? 'var(--ok-soft)' : bad ? 'var(--bad-soft)' : 'var(--warn-soft)';
  badge.style.color = okState ? 'var(--ok)' : bad ? 'var(--bad)' : 'var(--warn)';

  $('st-version').textContent = text(s.version);
  $('st-uptime').textContent = fmtDuration(s.uptime_ms);
  $('st-mode').textContent = text(s.mode);

  const reasons = $('st-reasons');
  reasons.replaceChildren();
  const list = Array.isArray(health.reasons) ? health.reasons : [];
  if (list.length === 0) {
    reasons.hidden = true;
  } else {
    for (const reason of list) reasons.appendChild(el('span', 'reason', reason));
    reasons.hidden = false;
  }

  $('about-daemon').textContent = text(s.version);
  $('about-shell').textContent = text(shell?.shell?.version);
}

function renderRuntime() {
  const shell = state.shell;
  const kv = $('runtime-kv');
  kv.replaceChildren();
  if (shell === null) {
    kv.appendChild(el('dt', null, '状态'));
    kv.appendChild(el('dd', null, '桌面壳信息不可用'));
    return;
  }
  const rows = [
    ['界面地址', shell.shell?.url],
    ['daemon 端点', shell.daemon?.endpoint],
    ['数据目录', shell.shell?.data_dir],
    ['安装目录', shell.shell?.install_root],
    ['node 运行时', shell.shell?.node_path],
    ['日志目录', shell.shell?.log_dir],
    ['桌面壳进程', String(shell.shell?.pid ?? '—')],
  ];
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', null, k));
    kv.appendChild(el('dd', null, text(v)));
  }
}

function sevClass(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low' || s === 'info') return `sev sev-${s}`;
  return 'sev sev-unknown';
}

function fillMini(listId, countId, items, kind) {
  const list = $(listId);
  list.replaceChildren();
  $(countId).textContent = `${items.length} 条`;
  if (items.length === 0) {
    list.appendChild(el('li', 'mini-empty', kind === 'alert' ? '暂无告警' : '暂无分析结果'));
    return;
  }
  for (const item of items.slice(0, 5)) {
    const li = el('li');
    if (kind === 'alert') {
      li.appendChild(el('span', sevClass(item.severity), text(item.severity)));
      li.appendChild(el('span', 'mini-main', text(item.rule_id)));
      li.appendChild(el('span', 'mini-side', fmtTime(item.last_seen)));
    } else {
      li.appendChild(el('span', 'sev sev-info', text(item.state)));
      li.appendChild(el('span', 'mini-main', text(item.analysis_id)));
      li.appendChild(el('span', 'mini-side', fmtTime(item.created_at)));
    }
    list.appendChild(li);
  }
}

function renderOverview() {
  fillMini('ov-alerts', 'ov-alert-count', state.alerts.items, 'alert');
  fillMini('ov-analysis', 'ov-analysis-count', state.analysis.items, 'analysis');
  renderRuntime();
}

function renderAlerts() {
  const body = $('alerts-body');
  body.replaceChildren();
  const items = state.alerts.items;
  $('alerts-count').textContent = `${items.length} 条`;
  $('alerts-empty').hidden = items.length > 0;
  for (const a of items) {
    const tr = el('tr');
    const tdSev = el('td');
    tdSev.appendChild(el('span', sevClass(a.severity), text(a.severity)));
    tr.appendChild(tdSev);
    tr.appendChild(el('td', 'mono', text(a.rule_id)));
    tr.appendChild(el('td', null, text(a.status)));
    tr.appendChild(el('td', 'num', text(a.count)));
    tr.appendChild(el('td', 'time', fmtTime(a.first_seen)));
    tr.appendChild(el('td', 'time', fmtTime(a.last_seen)));
    tr.appendChild(el('td', 'num', a.evidence_truncated ? `${text(a.evidence_count)}（截断）` : text(a.evidence_count)));
    body.appendChild(tr);
  }
  $('alerts-more').hidden = !state.alerts.hasMore;
}

function renderAnalysis() {
  const body = $('analysis-body');
  body.replaceChildren();
  const items = state.analysis.items;
  $('analysis-count').textContent = `${items.length} 条`;
  $('analysis-empty').hidden = items.length > 0;
  for (const a of items) {
    const tr = el('tr');
    tr.appendChild(el('td', 'mono', text(a.analysis_id)));
    tr.appendChild(el('td', 'mono', text(a.alert_id)));
    tr.appendChild(el('td', null, text(a.state)));
    tr.appendChild(el('td', null, text(a.budget_class)));
    tr.appendChild(el('td', 'num', text(a.attempts)));
    tr.appendChild(el('td', 'time', fmtTime(a.created_at)));
    tr.appendChild(el('td', 'time', fmtTime(a.completed_at)));
    body.appendChild(tr);
  }
  $('analysis-more').hidden = !state.analysis.hasMore;
}

function renderSettings() {
  const shell = state.shell;
  const settings = shell?.settings ?? null;
  const mode = settings?.open_mode ?? shell?.shell?.open_mode ?? 'embedded';
  for (const btn of $('open-mode').querySelectorAll('button')) {
    btn.classList.toggle('on', btn.dataset.value === mode);
  }
  const auto = $('autostart');
  auto.checked = shell?.shell?.autostart === true;
  auto.disabled = shell === null;

  // 输入框只在「用户没在编辑」时回填，否则每 4 秒的轮询会把正在输入的内容冲掉。
  const uiPort = shell?.shell?.ui_port ?? settings?.ui_port;
  const inUi = $('in-ui-port');
  if (document.activeElement !== inUi) inUi.value = uiPort ?? '';
  const inDaemon = $('in-daemon-port');
  if (document.activeElement !== inDaemon) inDaemon.value = shell?.daemon?.port ?? settings?.daemon_port ?? '';
  const inLog = $('in-log-dir');
  if (document.activeElement !== inLog) inLog.value = settings?.log_dir || '';
  inLog.placeholder = settings?.default_log_dir ? `留空 = ${settings.default_log_dir}` : '留空 = 默认目录';
  $('log-hint').textContent = shell?.shell?.log_file
    ? `当前文件 ${shell.shell.log_file}`
    : '日志文件名 desktop-YYYYMMDD.log';

  const kv = $('service-kv');
  kv.replaceChildren();
  const rows = [
    ['daemon 状态', state.status === null ? '已断开' : '在线'],
    ['daemon 端点', shell?.daemon?.endpoint],
    ['daemon 进程', shell?.daemon?.pid ? String(shell.daemon.pid) : '—'],
    ['重启次数', String(shell?.daemon?.restarts ?? 0)],
    ['最近错误', shell?.daemon?.last_error || '无'],
    ['规则包', shell?.shell?.rules_path],
    ['设置文件', settings?.settings_file],
  ];
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', null, k));
    kv.appendChild(el('dd', null, text(v, '无')));
  }
}

/* -------------------------------------------------------------------- calls */

async function loadShell() {
  try {
    state.shell = await getJson('/shell/api/state');
  } catch {
    state.shell = null;
  }
}

async function loadStatus() {
  try {
    state.status = await getJson('/api/v1/status');
    return true;
  } catch (error) {
    state.status = null;
    return false;
  }
}

async function loadAlerts(reset = true) {
  const url = reset || !state.alerts.cursor
    ? '/api/v1/alerts?limit=50'
    : `/api/v1/alerts?limit=50&cursor=${encodeURIComponent(state.alerts.cursor)}`;
  try {
    const body = await getJson(url);
    const items = Array.isArray(body.alerts) ? body.alerts : [];
    state.alerts.items = reset ? items : state.alerts.items.concat(items);
    state.alerts.cursor = body.page?.next_cursor ?? null;
    state.alerts.hasMore = body.page?.has_more === true && state.alerts.cursor !== null;
  } catch {
    if (reset) state.alerts = { items: [], cursor: null, hasMore: false };
  }
}

async function loadAnalysis(reset = true) {
  const url = reset || !state.analysis.cursor
    ? '/api/v1/analysis?limit=50'
    : `/api/v1/analysis?limit=50&cursor=${encodeURIComponent(state.analysis.cursor)}`;
  try {
    const body = await getJson(url);
    const items = Array.isArray(body.analyses) ? body.analyses : [];
    state.analysis.items = reset ? items : state.analysis.items.concat(items);
    state.analysis.cursor = body.page?.next_cursor ?? null;
    state.analysis.hasMore = body.page?.has_more === true && state.analysis.cursor !== null;
  } catch {
    if (reset) state.analysis = { items: [], cursor: null, hasMore: false };
  }
}

function renderBanner(online) {
  const banner = $('offline-banner');
  if (online) {
    banner.hidden = true;
    return;
  }
  const shell = state.shell;
  const reason = shell?.daemon?.last_error
    || shell?.shell?.tray_error
    || '本地 daemon 无响应，界面上的数据已停止更新';
  $('offline-hint').textContent = reason;
  banner.hidden = false;
}

function renderAll() {
  renderStatus();
  renderOverview();
  renderAlerts();
  renderAnalysis();
  renderSettings();
  const online = state.status !== null;
  setConn(online, online ? 'daemon 在线' : '服务已断开');
  renderBanner(online);
  const endpoint = $('endpoint');
  endpoint.textContent = state.shell?.daemon?.endpoint || state.shell?.shell?.url || '—';
  $('stamp').textContent = `更新于 ${fmtClock(new Date())}`;
}

async function refreshAll() {
  await loadShell();
  const online = await loadStatus();
  if (online) {
    await Promise.all([loadAlerts(true), loadAnalysis(true)]);
  } else {
    state.alerts = { items: [], cursor: null, hasMore: false };
    state.analysis = { items: [], cursor: null, hasMore: false };
  }
  renderAll();
  return online;
}

/* ------------------------------------------------------------------- views */

const VIEW_META = {
  overview: ['概览', '本机单机代理 · 只监听 127.0.0.1'],
  alerts: ['告警', '来自 /api/v1/alerts 的分页结果'],
  analysis: ['分析结果', '来自 /api/v1/analysis 的分页结果'],
  settings: ['设置', '界面与服务 · 立即生效'],
};

function showView(name) {
  if (!VIEW_META[name]) name = 'overview';
  state.view = name;
  for (const btn of $('nav').querySelectorAll('.nav-item')) {
    btn.classList.toggle('on', btn.dataset.view === name);
  }
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${name}`;
  }
  $('view-title').textContent = VIEW_META[name][0];
  $('view-sub').textContent = VIEW_META[name][1];
  if (location.hash !== `#/${name}`) history.replaceState(null, '', `#/${name}`);
}

function toast(message, bad = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { node.hidden = true; }, 3200);
}

/* ------------------------------------------------------------------- wiring */

async function applyOpenMode(value) {
  try {
    const body = await postJson('/shell/api/settings', { open_mode: value });
    state.shell = body.state ?? state.shell;
    renderSettings();
    toast(value === 'browser' ? '已切换为默认浏览器打开' : '已切换为内嵌窗口');
  } catch (error) {
    toast(`设置失败：${error.message}`, true);
  }
}

async function applyAutostart(checked) {
  try {
    const body = await postJson('/shell/api/settings', { autostart: checked });
    state.shell = body.state ?? state.shell;
    renderSettings();
    toast(checked ? '已开启开机自启' : '已关闭开机自启');
  } catch (error) {
    toast(`设置失败：${error.message}`, true);
    $('autostart').checked = !checked;
  }
}

async function applySetting(payload, successText, button) {
  if (button) button.disabled = true;
  try {
    const body = await postJson('/shell/api/settings', payload);
    if (body.state) state.shell = body.state;
    renderAll();
    const notes = Array.isArray(body.notes) ? body.notes : [];
    toast(notes.length > 0 ? notes.join('；') : (successText || '已保存'));
  } catch (error) {
    toast(`设置失败：${error.message}`, true);
    await refreshAll();
  } finally {
    if (button) button.disabled = false;
  }
}

async function reconnect() {
  const button = $('btn-reconnect');
  button.disabled = true;
  button.textContent = '正在重启…';
  try {
    await postJson('/shell/api/daemon/restart', {});
    const online = await refreshAll();
    toast(online ? 'daemon 已重新上线' : 'daemon 仍未响应，请查看日志', !online);
  } catch (error) {
    toast(`重启失败：${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = '一键重启';
  }
}

function bind() {
  $('nav').addEventListener('click', (event) => {
    const btn = event.target.closest('.nav-item');
    if (btn) showView(btn.dataset.view);
  });
  for (const link of document.querySelectorAll('[data-goto]')) {
    link.addEventListener('click', () => showView(link.dataset.goto));
  }
  $('btn-refresh').addEventListener('click', () => { refreshAll(); });
  $('btn-reconnect').addEventListener('click', reconnect);

  $('alerts-more').addEventListener('click', async () => { await loadAlerts(false); renderAlerts(); });
  $('analysis-more').addEventListener('click', async () => { await loadAnalysis(false); renderAnalysis(); });

  $('open-mode').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-value]');
    if (btn) applyOpenMode(btn.dataset.value);
  });
  $('autostart').addEventListener('change', (event) => applyAutostart(event.target.checked));

  $('btn-ui-port').addEventListener('click', () => {
    const value = Number($('in-ui-port').value);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      toast('界面端口必须是 1..65535 的整数', true);
      return;
    }
    // 换端口会让当前页面失效：壳会把窗口导航到新地址，浏览器模式需要用户手动开新地址。
    if (value !== state.shell?.shell?.ui_port) {
      toast(`界面即将切换到 127.0.0.1:${value}`);
    }
    applySetting({ ui_port: value }, `界面端口已改为 ${value}`, $('btn-ui-port'));
  });

  $('btn-daemon-port').addEventListener('click', () => {
    const value = Number($('in-daemon-port').value);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      toast('daemon 端口必须是 1..65535 的整数', true);
      return;
    }
    applySetting({ daemon_port: value }, `daemon 已在 ${value} 重启`, $('btn-daemon-port'));
  });

  $('btn-log-dir').addEventListener('click', () => {
    applySetting({ log_dir: $('in-log-dir').value.trim() }, '日志目录已切换', $('btn-log-dir'));
  });
  $('btn-log-dir-default').addEventListener('click', () => {
    $('in-log-dir').value = '';
    applySetting({ log_dir: '' }, '已恢复默认日志目录', $('btn-log-dir-default'));
  });

  $('btn-restart').addEventListener('click', async () => {
    $('btn-restart').disabled = true;
    try {
      await postJson('/shell/api/daemon/restart', {});
      toast('daemon 已重启');
      await refreshAll();
    } catch (error) {
      toast(`重启失败：${error.message}`, true);
    } finally {
      $('btn-restart').disabled = false;
    }
  });
  $('btn-logs').addEventListener('click', async () => {
    try {
      await postJson('/shell/api/logs/open', {});
    } catch (error) {
      toast(`无法打开日志目录：${error.message}`, true);
    }
  });

  window.addEventListener('hashchange', () => showView((location.hash || '#/overview').slice(2)));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll();
  });
}

/*
 * 轮询节奏分两档：在线 3s（够用且不吵），断开 1.2s（用户杀掉 daemon 后要尽快看到
 * 「服务已断开」，验收要求 5 秒内，3s 的在线间隔刚好卡在边界上）。
 */
const POLL_ONLINE_MS = 3000;
const POLL_OFFLINE_MS = 1200;

function schedule() {
  clearTimeout(state.timer);
  const delay = state.status === null ? POLL_OFFLINE_MS : POLL_ONLINE_MS;
  state.timer = setTimeout(async () => {
    if (!document.hidden) await refreshAll();
    schedule();
  }, delay);
}

function boot() {
  bind();
  showView((location.hash || '#/overview').slice(2));
  refreshAll().then(schedule, schedule);
}
