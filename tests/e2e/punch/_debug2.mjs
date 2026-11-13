/** _debug2.mjs — 键盘输入通道诊断（临时） */
import { openBrowser, installHelpers, navigate, settle, clickAt, sleep } from './lib/probe.mjs';

const base = 'http://127.0.0.1:17512';
const browser = await openBrowser();
const page = await browser.newPage();

async function keyChars(text) {
  for (const ch of text) {
    await page.connection.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, code: 'Digit' + ch,
      windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
    }, page.sessionId);
    await page.connection.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ch, code: 'Digit' + ch,
      windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
    }, page.sessionId);
  }
}

async function ctrlA() {
  await page.connection.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
  }, page.sessionId);
  await page.connection.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
  }, page.sessionId);
}

try {
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/settings?group=ui`);
  await settle(page);
  await installHelpers(page);
  const sel = 'section#settings-group-ui > div:nth-of-type(2) > div:nth-of-type(5) > div:nth-of-type(2) > input';
  const prep = await page.evaluate(`__punch.prepare(${JSON.stringify(sel)})`);
  await clickAt(page, prep.x, prep.y);
  await sleep(200);
  console.log('active:', await page.evaluate('__punch.snapshot().active'));
  // 方案 A：Ctrl+A + insertText
  await ctrlA();
  await sleep(80);
  await page.connection.send('Input.insertText', { text: '11111' }, page.sessionId);
  await sleep(200);
  console.log('A insertText ->', await page.evaluate(`document.querySelector(${JSON.stringify(sel)}).value`));
  // 方案 B：Ctrl+A + 逐字符 key
  await ctrlA();
  await sleep(80);
  await keyChars('22222');
  await sleep(250);
  console.log('B keyChars ->', await page.evaluate(`document.querySelector(${JSON.stringify(sel)}).value`));
  // 方案 C：逐字符 key（不清空）
  await keyChars('333');
  await sleep(250);
  console.log('C append ->', await page.evaluate(`document.querySelector(${JSON.stringify(sel)}).value`));
  console.log('savebar:', JSON.stringify(await page.evaluate('__punch.saveBar()')));
  // 搜索框测试（alerts 页）
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/alerts`);
  await settle(page);
  await installHelpers(page);
  const ipath = await page.evaluate("(() => { const i = document.querySelector('#view-root input'); return i ? __punch.path(i) : null; })()");
  console.log('search input:', ipath);
  const ip = await page.evaluate(`__punch.prepare(${JSON.stringify(ipath)})`);
  await clickAt(page, ip.x, ip.y);
  await sleep(200);
  await keyChars('shell');
  await sleep(900);
  console.log('search hash:', await page.evaluate('location.hash'));
  console.log('search value:', await page.evaluate(`document.querySelector(${JSON.stringify(ipath)}).value`));
  console.log('rows:', await page.evaluate("document.querySelectorAll('tbody tr[data-row=\"true\"]').length"));
} finally {
  await browser.close();
}
