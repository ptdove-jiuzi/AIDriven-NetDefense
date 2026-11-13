/** _debug5.mjs — 全站输入控件只读性机器化检查（临时证据脚本） */
import { openBrowser, installHelpers, navigate, settle, sleep } from './lib/probe.mjs';
import { writeFileSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:17512';
const ROUTES = ['#/overview', '#/alerts', '#/analysis', '#/agent', '#/models', '#/settings'];
const browser = await openBrowser();
const page = await browser.newPage();
const out = { base, at: new Date().toISOString(), routes: [] };
try {
  for (const route of ROUTES) {
    await navigate(page, `${base}/?theme=dark&lang=zh-CN${route}`);
    await settle(page);
    await installHelpers(page);
    const info = await page.evaluate(`(() => {
      const root = document.querySelector('#view-root');
      const nodes = Array.prototype.slice.call(document.querySelectorAll('#view-root input, #view-root textarea'));
      return {
        hash: location.hash,
        inputs: nodes.map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type'),
          id: el.id || null,
          aria: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder'),
          readonlyProp: el.readOnly === true,
          readonlyAttr: el.hasAttribute('readonly'),
          readonlyAttrValue: el.getAttribute('readonly'),
          disabled: el.disabled === true,
          path: __punch.path(el)
        }))
      };
    })()`);
    out.routes.push({ route, ...info });
    console.log(route, 'inputs=' + info.inputs.length, 'readonly=' + info.inputs.filter((i) => i.readonlyProp).length);
    for (const i of info.inputs.slice(0, 8)) console.log('   ', [i.tag, i.type, i.aria || i.placeholder || i.id || '', 'readonly=' + i.readonlyProp, 'attr=' + i.readonlyAttr + ':' + JSON.stringify(i.readonlyAttrValue)].join(' '));
    await sleep(120);
  }
} finally {
  writeFileSync('docs/implementation/evidence/ui2/punch/inputs-readonly.json', JSON.stringify(out, null, 1), 'utf8');
  await browser.close();
}
