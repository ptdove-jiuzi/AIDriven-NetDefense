/** _debug3.mjs — 键盘事件通道矩阵诊断（临时） */
import { openBrowser, installHelpers, navigate, settle, clickAt, sleep } from './lib/probe.mjs';

const base = 'http://127.0.0.1:17512';
const browser = await openBrowser();
const page = await browser.newPage();
const sel = 'section#settings-group-ui > div:nth-of-type(2) > div:nth-of-type(5) > div:nth-of-type(2) > input';

async function value() { return page.evaluate(`document.querySelector(${JSON.stringify(sel)}).value`); }
async function reset() {
  await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.value : null; })()`);
}

try {
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/settings?group=ui`);
  await settle(page);
  await installHelpers(page);
  const prep = await page.evaluate(`__punch.prepare(${JSON.stringify(sel)})`);
  await clickAt(page, prep.x, prep.y);
  await sleep(200);
  console.log('hasFocus:', await page.evaluate('document.hasFocus()'), 'active:', await page.evaluate('document.activeElement.tagName + "|" + (document.activeElement.getAttribute("aria-label")||"")'));
  console.log('readOnly/disabled:', await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return [el.readOnly, el.disabled, el.type]; })()`));
  try { await page.connection.send('Page.bringToFront', {}, page.sessionId); } catch (e) { console.log('bringToFront err', e.message); }

  // 1) char only
  await page.connection.send('Input.dispatchKeyEvent', { type: 'char', text: '1', unmodifiedText: '1', key: '1' }, page.sessionId);
  await sleep(150);
  console.log('1 char-only ->', await value());

  // 2) rawKeyDown + char + keyUp
  await page.connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 }, page.sessionId);
  await page.connection.send('Input.dispatchKeyEvent', { type: 'char', text: '2', unmodifiedText: '2', key: '2' }, page.sessionId);
  await page.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 }, page.sessionId);
  await sleep(150);
  console.log('2 raw+char+up ->', await value());

  // 3) insertText with commands
  await page.connection.send('Input.insertText', { text: '3' }, page.sessionId);
  await sleep(150);
  console.log('3 insertText ->', await value());

  // 4) 全选 ctrl+a（rawKeyDown）+ insertText
  await page.connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, page.sessionId);
  await page.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, page.sessionId);
  await sleep(100);
  await page.connection.send('Input.insertText', { text: '999' }, page.sessionId);
  await sleep(150);
  console.log('4 ctrlA+insert ->', await value());
  console.log('savebar:', (await page.evaluate('__punch.saveBar()')).text);

  // 5) 用 Input.dispatchKeyEvent 的 commands（Chrome 专有）
  try {
    await page.connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] }, page.sessionId);
    await page.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, page.sessionId);
    await sleep(100);
    await page.connection.send('Input.insertText', { text: '777' }, page.sessionId);
    await sleep(200);
    console.log('5 commands selectAll+insert ->', await value());
  } catch (e) { console.log('5 err', e.message); }
  console.log('final savebar:', (await page.evaluate('__punch.saveBar()')).text);
} finally {
  await browser.close();
}
