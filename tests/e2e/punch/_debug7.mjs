/** _debug7.mjs — modal 三关关闭实测（models 组「移除提供方」触发） */
import { openBrowser, installHelpers, navigate, settle, clickAt, sleep } from './lib/probe.mjs';
import { writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:17512';
const browser = await openBrowser();
const page = await browser.newPage();
const out = { at: new Date().toISOString(), steps: [] };
try {
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/models`);
  await settle(page);
  await installHelpers(page);
  const btn = await page.evaluate(`(() => {
    const btns = Array.prototype.slice.call(document.querySelectorAll('#view-root button'));
    const hit = btns.find((b) => (b.innerText || '').trim() === '移除提供方');
    return hit ? { path: __punch.path(hit), text: hit.innerText.trim(), disabled: hit.disabled } : null;
  })()`);
  out.trigger = btn;
  if (btn) {
    const p = await page.evaluate(`__punch.prepare(${JSON.stringify(btn.path)})`);
    out.prep = p;
    await clickAt(page, p.x, p.y);
    await sleep(500);
    let ov = await page.evaluate('__punch.overlayInfo()');
    out.steps.push({ name: '打开 modal', modal: ov.modal });
    // X
    const xp = await page.evaluate("__punch.clickClose('modal')");
    if (xp.ok) { await clickAt(page, xp.x, xp.y); await sleep(300); }
    ov = await page.evaluate('__punch.overlayInfo()');
    out.steps.push({ name: 'X 关闭', closed: !ov.modal });
    // reopen + backdrop
    const p2 = await page.evaluate(`__punch.prepare(${JSON.stringify(btn.path)})`);
    await clickAt(page, p2.x, p2.y);
    await sleep(450);
    ov = await page.evaluate('__punch.overlayInfo()');
    out.steps.push({ name: '重开 modal', modal: ov.modal });
    const bp = await page.evaluate('__punch.backdropPoint()');
    if (bp.ok) { await clickAt(page, bp.x, bp.y); await sleep(300); }
    ov = await page.evaluate('__punch.overlayInfo()');
    out.steps.push({ name: '遮罩关闭', closed: !ov.modal, point: bp });
    // reopen + Esc
    const p3 = await page.evaluate(`__punch.prepare(${JSON.stringify(btn.path)})`);
    await clickAt(page, p3.x, p3.y);
    await sleep(450);
    ov = await page.evaluate('__punch.overlayInfo()');
    const activeInModal = await page.evaluate("(() => { const m = document.querySelector('#modal-root > *'); return m ? m.contains(document.activeElement) : false; })()");
    await page.escape();
    await sleep(300);
    ov = await page.evaluate('__punch.overlayInfo()');
    out.steps.push({ name: 'Esc 关闭', closed: !ov.modal, focusInsideBeforeEsc: activeInModal });
    // 焦点是否回到触发按钮
    out.focusAfterClose = await page.evaluate('__punch.snapshot().active');
  }
  console.log(JSON.stringify(out, null, 1));
} finally {
  writeFileSync('docs/implementation/evidence/ui2/punch/modal-three-close.json', JSON.stringify(out, null, 1), 'utf8');
  await browser.close();
}
