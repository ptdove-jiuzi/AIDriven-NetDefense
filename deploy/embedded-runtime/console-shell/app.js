/*
 * app.js — the shipped console page.
 *
 * It talks only to its own origin: the local shell (console/serve.mjs) serves
 * this file and forwards /healthz and /api/v1/* to the daemon. Nothing here
 * reaches the network directly, holds a token, or stores anything.
 *
 * Every fetch is explicit and user-visible. There is no polling loop, no timer
 * that starts itself, and no auto-navigation: if the page is idle, that is the
 * intended state.
 */

const HEALTH = '/healthz';
const STATUS = '/api/v1/status';
const ALERTS = '/api/v1/alerts?limit=20';

const el = (id) => document.getElementById(id);

function setBadge(state, text) {
  const badge = el('badge');
  badge.dataset.state = state;
  badge.textContent = text;
}

function showError(message) {
  const node = el('error');
  node.textContent = message;
  node.hidden = message === '';
}

function text(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

async function getJSON(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' });
  const body = await response.text();
  let parsed;
  try {
    parsed = body === '' ? null : JSON.parse(body);
  } catch {
    throw new Error(`${path}: 返回的不是 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const code = parsed?.error?.code ?? `HTTP ${response.status}`;
    throw new Error(`${path}: ${code}`);
  }
  return parsed;
}

async function refresh() {
  showError('');
  try {
    const health = await getJSON(HEALTH);
    el('k-health').textContent = text(health.status);
    el('k-version').textContent = text(health.version);
    el('k-status').textContent = text(health.lifecycle ?? health.status);
    el('k-collect').textContent = text(health.collectors?.last_success_at ?? health.last_event_at);
    setBadge(health.status === 'ok' ? 'ok' : 'warn', health.status === 'ok' ? '健康' : text(health.status));
  } catch (error) {
    setBadge('bad', '不可用');
    showError(error.message);
    return;
  }

  try {
    const status = await getJSON(STATUS);
    el('k-status').textContent = text(status.lifecycle ?? status.status ?? el('k-status').textContent);
  } catch (error) {
    // /api/v1/status needs a token. That is not a page failure: say so plainly
    // instead of showing an empty panel that looks like "no data".
    showError(`状态接口：${error.message}`);
  }

  try {
    const alerts = await getJSON(ALERTS);
    renderAlerts(Array.isArray(alerts.items) ? alerts.items : []);
  } catch (error) {
    renderAlerts([], error.message);
  }

  el('stamp').textContent = `读取于 ${new Date().toLocaleTimeString()}`;
}

function renderAlerts(items, failure) {
  const body = document.querySelector('#alerts tbody');
  body.textContent = '';
  if (items.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'empty';
    cell.textContent = failure === undefined ? '没有告警' : `读取失败：${failure}`;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const alert of items) {
    const row = document.createElement('tr');
    for (const value of [alert.severity, alert.rule_id, alert.computer, alert.window_start]) {
      const cell = document.createElement('td');
      cell.textContent = text(value);
      row.append(cell);
    }
    body.append(row);
  }
}

el('refresh').addEventListener('click', refresh);
