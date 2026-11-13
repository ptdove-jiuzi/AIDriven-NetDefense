/** _debug.mjs — 交互诊断（临时） */
import { openBrowser, installHelpers, navigate, settle, clickAt, pressKey, selectAll, typeText, sleep, closeOverlay } from './lib/probe.mjs';

const base = process.argv[2] || 'http://127.0.0.1:17512';
const hash = process.argv[3] || '#/settings?group=ui';
const browser = await openBrowser();
const page = await browser.newPage();
try {
  await navigate(page, `${base}/?theme=dark&lang=zh-CN${hash}`);
  await settle(page);
  await installHelpers(page);
  const fieldPath = await page.evaluate(`(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll('.settings-item'));
    for (const item of items) {
      const code = item.querySelector('.settings-item__path');
      if (code && code.textContent.trim() === 'ui.autoRefreshMs') {
        const input = item.querySelector('input');
        return input ? __punch.path(input) : null;
      }
    }
    return null;
  })()`);
  console.log('field path:', fieldPath);
  const prep = await page.evaluate(`__punch.prepare(${JSON.stringify(fieldPath)})`);
  console.log('prep:', JSON.stringify(prep));
  await clickAt(page, prep.x, prep.y);
  await sleep(250);
  console.log('active after click:', await page.evaluate('__punch.snapshot().active'));
  console.log('input value before:', await page.evaluate(`document.querySelector(${JSON.stringify(fieldPath)}).value`));
  await selectAll(page);
  await sleep(100);
  console.log('selection:', await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(fieldPath)}); return el ? [el.selectionStart, el.selectionEnd, el.value] : null; })()`));
  await typeText(page, '12000');
  await sleep(300);
  console.log('input value after:', await page.evaluate(`document.querySelector(${JSON.stringify(fieldPath)}).value`));
  console.log('savebar:', JSON.stringify(await page.evaluate('__punch.saveBar()')));
  // 场景：语言抽屉 + explain 按钮
  await page.escape();
  await sleep(200);
  await closeOverlay(page);
} finally {
  await browser.close();
}
