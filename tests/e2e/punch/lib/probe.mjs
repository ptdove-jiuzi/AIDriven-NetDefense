/**
 * probe.mjs — PUNCH 点测探测层（tests/e2e/punch 专用，只读消费 runtime）
 * 作者：PT-dove
 *
 * 职责：把"机器化枚举 + 真实鼠标事件 + 前后快照"封装成可复用函数。
 * 不修改 apps/**、packages/**、tests/e2e/lib/**。
 *
 * 设计要点：
 * - 点击一律走 Input.dispatchMouseEvent（真实鼠标事件），不用 el.click() 冒充用户；
 * - 元素枚举完全在页面内按选择器集合机器生成，不手写清单；
 * - 快照包含：#view-root 文本长度/文本 hash、hash/URL、drawer/modal 数量、toast 文本、
 *   localStorage aidn.ui、data-theme、html lang、activeElement、目标元素 aria 属性；
 * - MutationObserver 统计点击窗口内 DOM 变化量，并先测一段"静默基线"用来扣除环境噪声。
 */
import { launch } from '../../lib/cdp.mjs';

export { launch };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 页面内注入的持久助手（每次导航后重新注入）。 */
export const HELPERS_JS = String.raw`(() => {
  const P = (window.__punch = window.__punch || {});
  P.textOf = (el) => {
    try { return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80); } catch (e) { return ''; }
  };
  P.path = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + '#' + CSS.escape(cur.id)); break; }
      const parent = cur.parentNode;
      if (parent && parent.children) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };
  P.desc = (el) => {
    if (!el) return 'null';
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
    const tag = el.tagName ? el.tagName.toLowerCase() : '?';
    const id = el.id ? '#' + el.id : '';
    const aria = el.getAttribute ? el.getAttribute('aria-label') : null;
    return tag + id + (aria ? '[' + String(aria).slice(0, 40) + ']' : '');
  };
  P.hash32 = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
  };
  P.snapshot = () => {
    const q = (s) => document.querySelector(s);
    const view = q('#view-root');
    const viewText = view ? view.innerText : '';
    let ui = null;
    try { ui = localStorage.getItem('aidn.ui'); } catch (e) { ui = null; }
    return {
      hash: location.hash,
      url: location.href,
      viewLen: viewText.length,
      viewSig: P.hash32(viewText),
      viewNodes: view ? view.querySelectorAll('*').length : 0,
      drawer: document.querySelectorAll('#drawer-root > *').length,
      modal: document.querySelectorAll('#modal-root > *').length,
      toast: ((q('#toast-root') || {}).innerText || '').trim().slice(0, 240),
      toastCount: document.querySelectorAll('#toast-root > *').length,
      active: P.desc(document.activeElement),
      theme: document.body ? document.body.getAttribute('data-theme') : null,
      lang: document.documentElement.lang,
      ui: ui,
      scrollY: window.scrollY
    };
  };
  P.overlayInfo = () => {
    const pick = (rootSel, kind) => {
      const el = document.querySelector(rootSel + ' > *');
      if (!el) return null;
      const panel = el.firstElementChild;
      return {
        kind: kind,
        cls: String(el.className || ''),
        destructive: panel ? panel.getAttribute('data-destructive') === 'true' : false,
        title: ((el.querySelector('h2') || {}).textContent || '').trim().slice(0, 100),
        focusables: el.querySelectorAll('button, select, input:not([type="hidden"]), textarea, a[href]').length,
        nodeCount: el.querySelectorAll('*').length
      };
    };
    return { drawer: pick('#drawer-root', 'drawer'), modal: pick('#modal-root', 'modal') };
  };
  P.enumerate = (scopeSel) => {
    const scope = scopeSel ? document.querySelector(scopeSel) : document;
    if (!scope) return { count: 0, items: [] };
    const SEL = 'button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], select, input:not([type="hidden"]), textarea, summary, tr[data-clickable="true"], tr[tabindex="0"]';
    const raw = Array.prototype.slice.call(scope.querySelectorAll(SEL));
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      if (el.closest('[hidden]')) return false;
      if (el.closest('#toast-root')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const items = [];
    const seen = new Set();
    for (const el of raw) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const type = el.getAttribute('type');
      const text = P.textOf(el);
      const aria = el.getAttribute('aria-label');
      const path = P.path(el);
      const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-busy') === 'true';
      items.push({
        tag: tag,
        role: role,
        type: type,
        text: text,
        aria: aria,
        title: el.getAttribute('title'),
        href: el.getAttribute('href'),
        tab: el.getAttribute('data-tab'),
        locale: el.getAttribute('data-locale'),
        dataAction: el.getAttribute('data-action') || el.getAttribute('data-role') || el.getAttribute('data-sort'),
        disabled: disabled,
        path: path,
        sig: tag + '|' + (role || '') + '|' + (type || '') + '|' + (aria || '') + '|' + text.slice(0, 50) + '|' + path
      });
    }
    return { count: items.length, items: items };
  };
  P.prepare = (path) => {
    const el = document.querySelector(path);
    if (!el) return { ok: false, reason: 'stale' };
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (el.tagName === 'TR') x = r.left + Math.min(28, Math.max(8, r.width / 5));
    const inView = r.width > 1 && r.height > 1 && x > 0 && y > 0 && x < vw - 1 && y < vh - 1;
    let coveredBy = null;
    if (inView) {
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) coveredBy = P.path(hit);
    }
    return { ok: inView, x: x, y: y, w: r.width, h: r.height, coveredBy: coveredBy, scrollY: window.scrollY };
  };
  P.targetAttrs = (path) => {
    const el = document.querySelector(path);
    if (!el) return { exists: false, attrs: {}, text: '' };
    const attrs = {};
    const names = ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'disabled', 'aria-disabled', 'aria-sort', 'aria-busy', 'value'];
    for (const name of names) {
      const v = name === 'value' ? (typeof el.value === 'string' ? el.value : null) : el.getAttribute(name);
      if (v !== null) attrs[name] = v;
    }
    return { exists: true, attrs: attrs, text: P.textOf(el), disabled: el.disabled === true };
  };
  P.observeStart = () => {
    const st = { n: 0, child: 0, attr: 0, char: 0, added: 0, removed: 0, samples: [] };
    const obs = new MutationObserver((recs) => {
      st.n += recs.length;
      for (const rec of recs) {
        if (rec.type === 'childList') {
          st.child += 1;
          st.added += rec.addedNodes.length;
          st.removed += rec.removedNodes.length;
          if (st.samples.length < 3) {
            const t = rec.target && rec.target.nodeType === 1 ? rec.target.tagName.toLowerCase() : String(rec.target && rec.target.nodeName);
            st.samples.push(t + '+' + rec.addedNodes.length + '-' + rec.removedNodes.length);
          }
        } else if (rec.type === 'attributes') {
          st.attr += 1;
          if (st.samples.length < 3) st.samples.push('@' + (rec.attributeName || '?'));
        } else if (rec.type === 'characterData') {
          st.char += 1;
        }
      }
    });
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__punchObs = { st: st, obs: obs };
    return true;
  };
  P.observeStop = () => {
    const h = window.__punchObs;
    if (!h) return { n: 0, child: 0, attr: 0, char: 0, added: 0, removed: 0, samples: [] };
    h.obs.disconnect();
    window.__punchObs = null;
    return h.st;
  };
  P.isActive = (path) => {
    const el = document.querySelector(path);
    return Boolean(el) && document.activeElement === el;
  };
  P.clickClose = (kind) => {
    const btn = document.querySelector('#' + kind + '-root .ui-' + kind + '__close');
    if (!btn) return { ok: false };
    const r = btn.getBoundingClientRect();
    return { ok: r.width > 0 && r.height > 0, x: r.left + r.width / 2, y: r.top + r.height / 2, label: btn.getAttribute('aria-label') || '' };
  };
  P.backdropPoint = () => {
    const el = document.querySelector('#drawer-root > *, #modal-root > *');
    if (!el) return { ok: false };
    const r = el.getBoundingClientRect();
    const panel = el.firstElementChild;
    const pr = panel ? panel.getBoundingClientRect() : null;
    let x = 8;
    let y = 8;
    if (pr && !(x < pr.left || x > pr.right || y < pr.top || y > pr.bottom)) {
      x = Math.max(2, Math.round(pr.left) - 10);
      y = Math.min(window.innerHeight - 2, Math.max(2, Math.round(pr.top) + 20));
    }
    return { ok: r.width > 0, x: x, y: y };
  };
  P.findText = (sel, text) => {
    const nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    const hit = nodes.find((n) => (n.textContent || '').includes(text));
    return hit ? P.path(hit) : null;
  };
  P.errorSignals = () => {
    const SEL = '[role="alert"], .ui-toast[data-kind="danger"], [data-tone="danger"], .settings-item__error:not([hidden]), .ui-field__error:not([hidden]), [data-error="true"], .ui-banner[data-tone="danger"]';
    const out = [];
    for (const node of Array.prototype.slice.call(document.querySelectorAll(SEL))) {
      if (node.closest('[hidden]')) continue;
      const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
      if (t) out.push(t);
      if (out.length >= 6) break;
    }
    return out;
  };
  P.findByOptionValue = (value) => {
    const selects = Array.prototype.slice.call(document.querySelectorAll('select'));
    for (const sel of selects) {
      const values = Array.prototype.slice.call(sel.options).map((o) => o.value);
      if (values.indexOf(String(value)) >= 0) return P.path(sel);
    }
    return null;
  };
  P.saveBar = () => {
    const bar = document.querySelector('#settings-savebar');
    if (!bar) return null;
    const buttons = Array.prototype.slice.call(bar.querySelectorAll('button')).map((b) => ({ label: P.textOf(b), disabled: b.disabled === true, path: P.path(b) }));
    return { text: (bar.innerText || '').trim().slice(0, 200), buttons: buttons };
  };
  return true;
})()`;

/** 启动浏览器。 */
export async function openBrowser(options = {}) {
  return launch({ headless: true, width: options.width ?? 1440, height: options.height ?? 900, ...options });
}

/** 在页面内安装助手。 */
export async function installHelpers(page) {
  await page.evaluate(HELPERS_JS);
}

/** 导航到目标 URL（先 about:blank 保证是整页重载，hash 变化不会复用同文档）。 */
export async function navigate(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
}

/** 等到视图进入"稳定可见"状态：__AIDN__ 就绪 + view-root 有节点 + 无 loading/skeleton + 文本连续稳定。 */
export async function settle(page, timeoutMs = 15_000) {
  const started = Date.now();
  let prevLen = -1;
  let stable = 0;
  for (;;) {
    let snapshot = null;
    try {
      snapshot = await page.evaluate(`(() => {
        const root = document.querySelector('#view-root');
        const text = root ? root.innerText : '';
        return {
          booted: Boolean(window.__AIDN__),
          nodes: root ? root.querySelectorAll('*').length : 0,
          len: text.length,
          busy: root ? root.querySelectorAll('[aria-busy="true"]').length : 0,
          skeleton: root ? root.querySelectorAll('.ui-skeleton').length : 0,
          loadingText: /加载中|Loading|載入中|Загрузка/i.test(text)
        };
      })()`);
    } catch {
      snapshot = null;
    }
    const ready = snapshot && snapshot.booted && snapshot.nodes > 2 && snapshot.len > 20
      && snapshot.busy === 0 && snapshot.skeleton === 0 && snapshot.loadingText === false;
    if (ready) {
      if (snapshot.len === prevLen) stable += 1;
      else stable = 0;
      prevLen = snapshot.len;
      if (stable >= 5) break;
    } else {
      stable = 0;
    }
    if (Date.now() - started > timeoutMs) break;
    await sleep(140);
  }
  await sleep(260);
}

/** 真实鼠标点击（视口坐标）。 */
export async function clickAt(page, x, y) {
  await page.connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, page.sessionId);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.connection.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, page.sessionId);
  }
}

/** 真实按键（单键，含按下/抬起）。 */
export async function pressKey(page, key, code, keyCode, modifiers = 0) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await page.connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, page.sessionId);
  await page.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, page.sessionId);
}

/** Ctrl+A（真实键盘事件）。 */
export async function selectAll(page) {
  const base = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
  await page.connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, page.sessionId);
  await page.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, page.sessionId);
}

/** 真实文本输入。 */
export async function typeText(page, text) {
  await page.connection.send('Input.insertText', { text: String(text) }, page.sessionId);
}

/** 读取页面里的 JSON（用 JSON.parse 绕过 returnByValue 的深层对象限制）。 */
export async function evalJson(page, expression) {
  const raw = await page.evaluate(`JSON.stringify(${expression})`);
  return raw === undefined ? undefined : JSON.parse(raw);
}

/** 控制台/异常/网络 游标。 */
export function cursor(page) {
  return { c: page.consoleEntries.length, e: page.exceptions.length, l: page.logEntries.length, r: page.responses.length };
}

/** 游标之后的诊断增量。 */
export function delta(page, cur) {
  return {
    consoleErrors: page.consoleEntries.slice(cur.c).filter((x) => x.type === 'error').map((x) => x.text.slice(0, 400)),
    consoleAll: page.consoleEntries.slice(cur.c).map((x) => x.type + ': ' + x.text.slice(0, 200)),
    exceptions: page.exceptions.slice(cur.e).map((x) => String(x.text).slice(0, 400)),
    logErrors: page.logEntries.slice(cur.l).filter((x) => x.level === 'error').map((x) => (x.source + ': ' + x.text + ' ' + (x.url || '')).slice(0, 400)),
    badResponses: page.responses.slice(cur.r).filter((x) => typeof x.status === 'number' && x.status >= 400).map((x) => x.status + ' ' + x.url),
    requests: page.responses.slice(cur.r).map((x) => x.status + ' ' + x.url),
  };
}

/** 关闭当前打开的 drawer/modal：先 Esc，再 X，再遮罩；返回每种方式是否有效。 */
export async function closeOverlay(page) {
  const result = { present: true, escClosed: false, xClosed: false, backdropClosed: false, finalOpen: true };
  let ov = await page.evaluate('__punch.overlayInfo()');
  if (!ov.drawer && !ov.modal) return { present: false, finalOpen: false };
  await page.escape();
  await sleep(180);
  ov = await page.evaluate('__punch.overlayInfo()');
  if (!ov.drawer && !ov.modal) {
    result.escClosed = true;
    result.finalOpen = false;
    return result;
  }
  const kind = ov.modal ? 'modal' : 'drawer';
  const xp = await page.evaluate(`__punch.clickClose(${JSON.stringify(kind)})`);
  if (xp && xp.ok) {
    await clickAt(page, xp.x, xp.y);
    await sleep(180);
  }
  ov = await page.evaluate('__punch.overlayInfo()');
  if (!ov.drawer && !ov.modal) {
    result.xClosed = true;
    result.finalOpen = false;
    return result;
  }
  const bp = await page.evaluate('__punch.backdropPoint()');
  if (bp && bp.ok) {
    await clickAt(page, bp.x, bp.y);
    await sleep(180);
  }
  ov = await page.evaluate('__punch.overlayInfo()');
  if (!ov.drawer && !ov.modal) {
    result.backdropClosed = true;
    result.finalOpen = false;
  }
  return result;
}

/** 已知问题（他人负责、不重复报）：i18n 目录缺失 / settings checkbox ReferenceError。 */
export function isKnownIssue(text) {
  const t = String(text || '');
  return /i18n\/locales\//.test(t) || /checkbox is not defined/.test(t) || /\[missing:/.test(t);
}

/** 合同 §12.1 已声明边界：未实现扩展点 501 / 引擎未就绪 / 用量为空 —— 不算缺陷。 */
export function isDeclaredBoundary(text) {
  const t = String(text || '');
  return /EXECUTION_DISABLED/.test(t) || /HARNESS_UNAVAILABLE/.test(t) || /engine\.harness\.available/.test(t)
    || /501\b/.test(t) && /not.?implemented|NOT_IMPLEMENTED/i.test(t);
}

/** 读取页面统计。 */
export async function pageStats(page) {
  return page.evaluate(`(() => {
    const root = document.querySelector('#view-root');
    const text = root ? root.innerText : '';
    return {
      viewLen: text.length,
      viewHead: text.slice(0, 160).replace(/\s+/g, ' '),
      i18nMissing: (text.match(/\\[missing:/g) || []).length,
      drawer: document.querySelectorAll('#drawer-root > *').length,
      modal: document.querySelectorAll('#modal-root > *').length,
      theme: document.body ? document.body.getAttribute('data-theme') : null,
      lang: document.documentElement.lang,
      ready: Boolean(window.__AIDN__)
    };
  })()`);
}
