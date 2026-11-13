/**
 * _recon.mjs — PUNCH 点测侦察脚本（临时，只读）
 * 目的：确认真实可点元素规模、抽屉/表格结构、i18n 缺失现状。
 */
import { launch } from '../lib/cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:17512';
const ROUTES = ['#/overview', '#/alerts', '#/analysis', '#/agent', '#/models', '#/settings'];

const ENUM_JS = `(() => {
  const SEL = 'button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], select, input, textarea, summary, tr[data-clickable="true"], tr[tabindex="0"]';
  const all = [...document.querySelectorAll(SEL)];
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const path = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + '#' + CSS.escape(cur.id)); break; }
      const parent = cur.parentNode;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const out = [];
  const seen = new Set();
  for (const el of all) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 48);
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      text,
      aria: el.getAttribute('aria-label'),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      sel: path(el),
    });
  }
  return { count: out.length, items: out };
})()`;

const browser = await launch({ headless: true, width: 1440, height: 900 });
console.log('browser ok');
for (const route of ROUTES) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/?theme=dark&lang=zh-CN${route}`);
  await page.waitFor('document.querySelector("#view-root") && document.querySelectorAll("#view-root *").length > 3');
  await new Promise((r) => setTimeout(r, 900));
  const info = await page.evaluate(`(() => ({
    hash: location.hash,
    rootChildren: document.querySelector('#view-root').childNodes.length,
    viewTextLen: document.querySelector('#view-root').innerText.length,
    viewHead: document.querySelector('#view-root').innerText.slice(0, 120).replace(/\\s+/g, ' '),
    drawer: document.querySelectorAll('#drawer-root > *').length,
    modal: document.querySelectorAll('#modal-root > *').length,
    toast: document.querySelector('#toast-root').innerText,
    settingsError: !!document.querySelector('#view-root').innerText.match(/failed to render|checkbox is not defined|not defined/),
    i18nMissing: (document.body.innerText.match(/\\[missing:/g) || []).length
  }))()`);
  const enumRes = await page.evaluate(ENUM_JS);
  console.log(JSON.stringify({ route, info, enumCount: enumRes.count }));
  if (route === '#/alerts') {
    console.log(JSON.stringify(enumRes.items.map((i) => `${i.tag}${i.role ? '[' + i.role + ']' : ''} | ${i.text.slice(0, 30)} | ${i.sel.slice(-60)}`), null, 0));
    const rows = await page.evaluate(`document.querySelectorAll('tr[data-clickable="true"], tr[tabindex="0"]').length`);
    console.log('alert rows clickable:', rows);
  }
  const report = page.report();
  console.log('report:', JSON.stringify({ err: report.consoleErrors.length, exc: report.exceptions.length, logErr: report.logErrors.length, bad: report.badResponses.length, sample: report.consoleErrors.slice(0, 2).map((e) => e.text.slice(0, 100)) }));
  await page.connection.send('Target.closeTarget', { targetId: page.targetId });
}
await browser.close();
