/** _debug4.mjs — 设置页只读状态诊断（临时） */
import { openBrowser, installHelpers, navigate, settle, sleep } from './lib/probe.mjs';

const base = 'http://127.0.0.1:17512';
const browser = await openBrowser();
const page = await browser.newPage();
try {
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/settings?group=ui`);
  await settle(page);
  await installHelpers(page);
  console.log('viewHead:', (await page.evaluate("document.querySelector('#view-root').innerText")).slice(0, 400).replace(/\n+/g, ' | '));
  const dump = await page.evaluate(`(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll('.settings-item'));
    return items.map((item) => {
      const code = item.querySelector('.settings-item__path');
      const ctl = item.querySelector('input, select, textarea, [role="switch"]');
      return {
        path: code ? code.textContent.trim() : '',
        tag: ctl ? ctl.tagName.toLowerCase() : null,
        type: ctl ? ctl.getAttribute('type') : null,
        readOnly: ctl ? ctl.readOnly === true : null,
        disabled: ctl ? ctl.disabled === true : null,
        itemReadOnlyAttr: item.getAttribute('data-readonly'),
        text: (item.innerText || '').replace(/\\s+/g, ' ').slice(0, 140)
      };
    });
  })()`);
  console.log(JSON.stringify(dump, null, 1));
  console.log('banners:', await page.evaluate(`Array.prototype.slice.call(document.querySelectorAll('#view-root [role="status"], #view-root .settings-banner, #view-root .ui-badge')).map(n => n.innerText.trim().slice(0,100)).slice(0, 10)`));
} finally {
  await browser.close();
}
