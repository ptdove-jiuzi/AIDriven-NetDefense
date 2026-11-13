/** _debug9.mjs — 测试连接 409 的界面文案取证 */
import { openBrowser, installHelpers, navigate, settle, clickAt, sleep } from './lib/probe.mjs';
import { writeFileSync } from 'node:fs';
const base = 'http://127.0.0.1:17512';
const browser = await openBrowser();
const page = await browser.newPage();
const out = { at: new Date().toISOString() };
try {
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/models`);
  await settle(page);
  await installHelpers(page);
  const info = await page.evaluate(`(() => {
    const btns = Array.prototype.slice.call(document.querySelectorAll('#view-root button'));
    return {
      total: btns.length,
      candidates: btns.map((b) => ({ text: (b.innerText || '').trim().slice(0, 20), action: b.getAttribute('data-action'), disabled: b.disabled, path: __punch.path(b) })).filter((b) => b.text.includes('测试') || b.action === 'test')
    };
  })()`);
  out.buttons = info;
  const hit = info.candidates.find((b) => !b.disabled);
  if (hit) {
    const p = await page.evaluate(`__punch.prepare(${JSON.stringify(hit.path)})`);
    await clickAt(page, p.x, p.y);
    await sleep(3500);
    const after = await page.evaluate(`(() => {
      const root = document.querySelector('#view-root');
      const errors = Array.prototype.slice.call(root.querySelectorAll('[role="alert"], .settings-test__error, .settings-provider, [data-tone="danger"]')).map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 220)).filter(Boolean);
      return { errorTexts: errors.slice(0, 6), viewLen: root.innerText.length, toast: document.querySelector('#toast-root').innerText.trim() };
    })()`);
    out.after = after;
    console.log(JSON.stringify(out, null, 1));
  } else {
    console.log(JSON.stringify(out, null, 1));
  }
} finally {
  writeFileSync('docs/implementation/evidence/ui2/punch/models-test411.json', JSON.stringify(out, null, 1), 'utf8');
  await browser.close();
}
