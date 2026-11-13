/** _debug6.mjs — 关键结论复核：键盘可用性 + 只读根因 + 用 select 走通保存链路 + modal 触发（临时证据） */
import { openBrowser, installHelpers, navigate, settle, clickAt, pressKey, sleep, selectAll, typeText } from './lib/probe.mjs';
import { writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:17512';
const browser = await openBrowser();
const page = await browser.newPage();
const out = { at: new Date().toISOString(), buildHint: 'apps/console-next', checks: {} };

async function keyChars(text) {
  for (const ch of text) {
    await page.connection.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, code: 'Key' + ch.toUpperCase(),
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    }, page.sessionId);
    await page.connection.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(),
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    }, page.sessionId);
  }
}

try {
  // 1) agent 页 composer（可编辑 textarea）→ 验证 CDP 键盘通道本身可用
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/agent`);
  await settle(page);
  await installHelpers(page);
  const ta = await page.evaluate("(() => { const t = document.querySelector('#view-root textarea'); return t ? { path: __punch.path(t), readonly: t.readOnly, disabled: t.disabled } : null; })()");
  out.checks.agentTextarea = ta;
  if (ta) {
    const p = await page.evaluate(`__punch.prepare(${JSON.stringify(ta.path)})`);
    await clickAt(page, p.x, p.y);
    await sleep(200);
    await keyChars('hello');
    await sleep(300);
    out.checks.agentTyped = await page.evaluate(`document.querySelector(${JSON.stringify(ta.path)}).value`);
    console.log('agent textarea typed =>', JSON.stringify(out.checks.agentTyped), 'readonly=', ta.readonly);
  }

  // 2) alerts 搜索框（field.input 产物）
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/alerts`);
  await settle(page);
  await installHelpers(page);
  const si = await page.evaluate("(() => { const t = document.querySelector('#view-root input'); return t ? { path: __punch.path(t), readonly: t.readOnly, attr: t.getAttribute('readonly') } : null; })()");
  out.checks.alertsSearch = si;
  if (si) {
    const p = await page.evaluate(`__punch.prepare(${JSON.stringify(si.path)})`);
    await clickAt(page, p.x, p.y);
    await sleep(150);
    await keyChars('shell');
    await sleep(400);
    out.checks.alertsSearchTyped = await page.evaluate(`document.querySelector(${JSON.stringify(si.path)}).value`);
    console.log('alerts search typed =>', JSON.stringify(out.checks.alertsSearchTyped), 'readonly=', si.readonly, 'attr=', si.attr);
  }

  // 3) 用 select 字段（density）走通保存链路：改 → 保存 → GET 对比 → 刷新
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/settings?group=ui`);
  await settle(page);
  await installHelpers(page);
  const before = await (await fetch(`${base}/api/v1/settings`)).json();
  const origDensity = before.settings.ui.density;
  const selPath = await page.evaluate(`(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll('.settings-item'));
    for (const item of items) {
      const code = item.querySelector('.settings-item__path');
      if (code && code.textContent.trim() === 'ui.density') {
        const s = item.querySelector('select');
        return s ? { path: __punch.path(s), value: s.value, readonly: s.readOnly } : null;
      }
    }
    return null;
  })()`);
  out.checks.densitySelect = selPath;
  if (selPath) {
    const p = await page.evaluate(`__punch.prepare(${JSON.stringify(selPath.path)})`);
    await clickAt(page, p.x, p.y);
    await sleep(150);
    await page.escape();
    await sleep(120);
    await pressKey(page, 'ArrowDown', 'ArrowDown', 40);
    await sleep(400);
    out.checks.densityAfterChange = await page.evaluate(`document.querySelector(${JSON.stringify(selPath.path)}).value`);
    out.checks.saveBarAfterChange = await page.evaluate('__punch.saveBar()');
    // 点保存（第 3 个动作按钮）
    const bar = out.checks.saveBarAfterChange;
    const saveBtn = bar.buttons[2];
    const sp = await page.evaluate(`__punch.prepare(${JSON.stringify(saveBtn.path)})`);
    if (sp.ok && !saveBtn.disabled) {
      await clickAt(page, sp.x, sp.y);
      await sleep(1800);
    }
    out.checks.saveBarAfterSave = await page.evaluate('__punch.saveBar()');
    const after = await (await fetch(`${base}/api/v1/settings`)).json();
    out.checks.serverDensity = after.settings.ui.density;
    await navigate(page, `${base}/?theme=dark&lang=zh-CN#/settings?group=ui`);
    await settle(page);
    await installHelpers(page);
    out.checks.reloadDensity = await page.evaluate(`(() => {
      const items = Array.prototype.slice.call(document.querySelectorAll('.settings-item'));
      for (const item of items) {
        const code = item.querySelector('.settings-item__path');
        if (code && code.textContent.trim() === 'ui.density') { const s = item.querySelector('select'); return s ? s.value : null; }
      }
      return null;
    })()`);
    console.log('density save flow =>', JSON.stringify({ orig: origDensity, changed: out.checks.densityAfterChange, server: out.checks.serverDensity, reload: out.checks.reloadDensity }));
    // 恢复原值
    if (out.checks.serverDensity !== origDensity) {
      await navigate(page, `${base}/?theme=dark&lang=zh-CN#/settings?group=ui`);
      await settle(page);
      await installHelpers(page);
      const s2 = await page.evaluate(`(() => {
        const items = Array.prototype.slice.call(document.querySelectorAll('.settings-item'));
        for (const item of items) {
          const code = item.querySelector('.settings-item__path');
          if (code && code.textContent.trim() === 'ui.density') { const s = item.querySelector('select'); return s ? __punch.path(s) : null; }
        }
        return null;
      })()`);
      if (s2) {
        const p2 = await page.evaluate(`__punch.prepare(${JSON.stringify(s2)})`);
        await clickAt(page, p2.x, p2.y);
        await sleep(120);
        await page.escape();
        await sleep(100);
        // 循环 ArrowDown 直到值为原值（最多 3 次）
        for (let i = 0; i < 3; i += 1) {
          const cur = await page.evaluate(`document.querySelector(${JSON.stringify(s2)}).value`);
          if (cur === origDensity) break;
          await pressKey(page, 'ArrowDown', 'ArrowDown', 40);
          await sleep(250);
        }
        const bar2 = await page.evaluate('__punch.saveBar()');
        const b2 = bar2.buttons[2];
        if (b2 && !b2.disabled) {
          const bp = await page.evaluate(`__punch.prepare(${JSON.stringify(b2.path)})`);
          await clickAt(page, bp.x, bp.y);
          await sleep(1500);
        }
        out.checks.densityRestored = (await (await fetch(`${base}/api/v1/settings`)).json()).settings.ui.density;
      }
    }
  }

  // 4) models 组：是否存在 provider 移除按钮（modal 触发器）
  await navigate(page, `${base}/?theme=dark&lang=zh-CN#/models`);
  await settle(page);
  await installHelpers(page);
  const btns = await page.evaluate(`__punch.enumerate().items.filter((i) => i.tag === 'button').map((i) => ({ text: i.text.slice(0, 40), path: i.path.slice(-70) }))`);
  out.checks.modelsButtons = btns;
  console.log('models buttons:', JSON.stringify(btns.map((b) => b.text)));
} finally {
  writeFileSync('docs/implementation/evidence/ui2/punch/key-recheck.json', JSON.stringify(out, null, 1), 'utf8');
  await browser.close();
}
