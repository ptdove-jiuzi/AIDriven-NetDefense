/**
 * UI-POLISH · T1 · Agent 面板「无 key / 不可用」零假装 + 三步引导 + composer 禁用
 *
 * 判据（任务正文 1/2/3）：
 *   (a) 六态下不出现任何"假装在回答"的东西：无 assistant 气泡、无 usage/token/花费数字、
 *       无 streaming 占位、无空 assistant 消息被写进 store；
 *   (b) 六态各自有**三步**引导（去哪配 / 配哪个 / 怎么验证），文案互不相同，
 *       第 1、3 步的按钮可聚焦、可点击，点击真的跳 #/settings?group=models；
 *   (c) composer disabled：textarea disabled + aria-disabled=true + aria-describedby 指向引导，
 *       Enter 不发送、发送按钮 disabled，禁用原因在界面上**可见**（不是只放 title）。
 *
 * @author PT-dove
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installDom, makeEvent, visibleText } from './dom-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const EN_DICT = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps', 'console-next', 'i18n', 'locales', 'en.json'), 'utf8'));

let viewModule = null;
async function loadView() {
  if (!viewModule) viewModule = await import('../../apps/console-next/js/views/agent.js');
  return viewModule;
}

/** 真实 i18n 的缺 key 行为（[missing:key]）：这样 t(key, fallback) 的第二参数才会被验证。 */
function translator() {
  return (key) => (typeof EN_DICT[key] === 'string' ? EN_DICT[key] : '[missing:' + key + ']');
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: (key) => map.delete(String(key)),
    dump: () => Object.fromEntries(map.entries()),
  };
}

function baseModels() {
  return {
    egressEnabled: true,
    providers: [
      { id: 'local', kind: 'openai-compatible', enabled: true, hasCredential: true },
    ],
    models: [
      { id: 'local-chat', providerId: 'local', tier: 'triage', maxInputTokens: 4096, maxOutputTokens: 512, costClass: 'free-local' },
    ],
    engine: { selected: 'broker-host', harness: { available: false, reason: 'PROFILE_NOT_STAGED' } },
  };
}

const STATES = {
  ENGINE_UNAVAILABLE: {
    ...baseModels(),
    engine: { selected: 'harness', harness: { available: false, reason: 'PROFILE_NOT_STAGED' } },
  },
  MODELS_EMPTY: { ...baseModels(), models: [], providers: [] },
  EGRESS_DISABLED: { ...baseModels(), egressEnabled: false },
  CREDENTIAL_MISSING: {
    ...baseModels(),
    providers: [{ id: 'local', kind: 'openai-compatible', enabled: true, hasCredential: false }],
  },
  PROVIDER_DISABLED: {
    ...baseModels(),
    providers: [{ id: 'local', kind: 'openai-compatible', enabled: false, hasCredential: true }],
  },
};

const GUIDE_STATE_ORDER = ['ENGINE_UNAVAILABLE', 'MODELS_EMPTY', 'EGRESS_DISABLED', 'CREDENTIAL_MISSING', 'PROVIDER_DISABLED'];

async function mountAgent(t, modelsData, options = {}) {
  const dom = installDom();
  t.after(() => dom.cleanup());
  const { document } = dom;
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const calls = { openChat: 0, approveTool: 0, navigations: [], toasts: [] };
  const storage = options.storage ?? memoryStorage();
  const ctx = {
    api: {
      getModels: async () => {
        if (options.modelsError) throw options.modelsError;
        return modelsData;
      },
      openChat: () => {
        calls.openChat += 1;
        throw new Error('openChat must not be called while chat is unavailable');
      },
      approveTool: async () => {
        calls.approveTool += 1;
        return {};
      },
    },
    i18n: { locale: 'en', t: translator() },
    navigate: (hash) => calls.navigations.push(String(hash)),
    toast: (payload) => calls.toasts.push(payload),
    storage,
  };
  const view = await loadView();
  const handle = await view.mount(mount, ctx);
  t.after(() => handle.destroy());
  return { dom, mount, root: mount, calls, storage, handle };
}

function assertNoFakeAnswer(root, label) {
  assert.equal(root.querySelectorAll('[data-role="assistant"]').length, 0, label + '：不得有 assistant 气泡');
  assert.equal(root.querySelectorAll('.chat-msg').length, 0, label + '：不得有消息气泡');
  assert.equal(root.querySelectorAll('[data-status="streaming"]').length, 0, label + '：不得有 streaming 占位');
  assert.equal(root.querySelectorAll('.chat-msg__usage').length, 0, label + '：不得有 usage 行');
  assert.equal(root.querySelectorAll('.chat-msg__pending').length, 0, label + '：不得有等待占位');
  const text = visibleText(root);
  assert.ok(!/\btokens?\b/iu.test(text), label + '：非 OK 态不得出现 token 数字，实际：' + text);
  assert.ok(!/\$\s*\d/u.test(text), label + '：非 OK 态不得出现花费数字，实际：' + text);
  assert.ok(!/0\.00/u.test(text), label + '：非 OK 态不得出现 0.00');
  assert.ok(!/\[missing:/u.test(text), label + '：不得渲染 [missing:key]，实际：' + text);
}

test('无 key 六态：零助理气泡 / 零 token / 零花费 / 零 [missing:]，且没有 assistant 消息落盘', async (t) => {
  for (const code of GUIDE_STATE_ORDER) {
    const models = code === 'ENGINE_UNAVAILABLE' ? STATES[code] : { ...STATES[code] };
    const { root, calls, storage } = await mountAgent(t, models);
    assert.equal(root.querySelectorAll('.agent-guide').length, 1, code + '：必须渲染引导');
    assert.equal(root.querySelector('.agent-guide').getAttribute('data-code'), code, code + '：引导 code 必须匹配');
    assertNoFakeAnswer(root, code);
    assert.equal(calls.openChat, 0, code + '：挂载期间绝不发请求');
    const snapshot = JSON.parse(storage.dump()['aidn.agent.sessions'] ?? '{"sessions":[]}');
    const messages = (snapshot.sessions ?? []).reduce((sum, session) => sum + (session.messages ?? []).length, 0);
    assert.equal(messages, 0, code + '：不得写入任何消息（含空 assistant）');
  }
});

test('六态三步引导：三步齐全、文案各不相同、每步都有标题与正文', async (t) => {
  const leads = new Map();
  const stepTexts = new Map();
  for (const code of GUIDE_STATE_ORDER) {
    const { root } = await mountAgent(t, STATES[code]);
    const steps = root.querySelectorAll('.agent-guide__step');
    assert.equal(steps.length, 3, code + '：必须恰好三步');
    for (let index = 0; index < steps.length; index += 1) {
      const title = visibleText(steps[index].querySelector('.agent-guide__step-title'));
      const body = visibleText(steps[index].querySelector('.agent-guide__step-text'));
      assert.ok(title.length > 0, code + '：第 ' + (index + 1) + ' 步必须有标题');
      assert.ok(body.length > 20, code + '：第 ' + (index + 1) + ' 步正文太短：' + body);
      assert.equal(steps[index].querySelector('.agent-guide__num').textContent, String(index + 1));
    }
    const lead = visibleText(root.querySelector('.agent-guide__lead'));
    assert.ok(lead.length > 10, code + '：引导必须有导语文案');
    leads.set(code, lead);
    stepTexts.set(code, steps.map((step) => visibleText(step.querySelector('.agent-guide__step-text'))).join('\n'));
  }
  assert.equal(new Set(leads.values()).size, GUIDE_STATE_ORDER.length, '六态导语必须互不相同：' + JSON.stringify([...leads]));
  assert.equal(new Set(stepTexts.values()).size, GUIDE_STATE_ORDER.length, '六态三步正文必须互不相同');
  // "没有模型 ≠ 没有密钥 ≠ 出网被关 ≠ 供应商停用 ≠ 引擎不可用"：关键区别词必须在文案里
  assert.match(leads.get('CREDENTIAL_MISSING'), /key/iu);
  assert.match(leads.get('MODELS_EMPTY'), /model/iu);
  assert.match(leads.get('EGRESS_DISABLED'), /outbound|egress/iu);
  assert.match(leads.get('PROVIDER_DISABLED'), /provider/iu);
  assert.match(leads.get('ENGINE_UNAVAILABLE'), /engine/iu);
});

test('引导按钮可聚焦可点击：第 1 步跳 #/settings?group=models，第 3 步跳测试连通', async (t) => {
  for (const code of GUIDE_STATE_ORDER) {
    const { root, calls, dom } = await mountAgent(t, STATES[code]);
    const stepButtons = root.querySelectorAll('.agent-guide__step-actions button');
    assert.equal(stepButtons.length, 2, code + '：第 1、3 步各有一个按钮');
    for (const node of stepButtons) {
      assert.equal(node.tagName.toLowerCase(), 'button', code + '：必须是真 button');
      assert.equal(node.disabled, false, code + '：引导按钮不得被禁用（引导必须可点）');
      assert.notEqual(node.getAttribute('tabindex'), '-1', code + '：引导按钮必须可达');
    }
    const first = root.querySelector('[data-action="guide-open-settings"]');
    const third = root.querySelector('[data-action="guide-open-test"]');
    first.focus();
    assert.equal(dom.document.activeElement, first, code + '：第 1 步按钮必须可聚焦');
    first.dispatchEvent(makeEvent('click'));
    third.dispatchEvent(makeEvent('click'));
    assert.deepEqual(calls.navigations, ['#/settings?group=models', '#/settings?group=models&focus=test'], code + '：按钮必须真跳设置页');
  }
});

test('composer 禁用闭环：disabled + aria-disabled + aria-describedby + Enter 不发送 + 原因可见', async (t) => {
  for (const code of GUIDE_STATE_ORDER) {
    const { root, calls } = await mountAgent(t, STATES[code]);
    const textarea = root.querySelector('textarea');
    const send = root.querySelector('[data-action="send"]');
    assert.equal(textarea.disabled, true, code + '：textarea 必须 disabled');
    assert.equal(textarea.getAttribute('aria-disabled'), 'true', code + '：aria-disabled 必须为 true');
    assert.equal(send.disabled, true, code + '：发送按钮必须 disabled');
    const describedBy = textarea.getAttribute('aria-describedby') ?? '';
    assert.match(describedBy, /agent-chat-guide/u, code + '：aria-describedby 必须指向引导区');
    const guide = root.querySelector('#agent-chat-guide');
    assert.ok(guide, code + '：引导区必须带固定 id 供 aria-describedby 引用');

    textarea.value = 'should never be sent';
    textarea.dispatchEvent(makeEvent('keydown', { key: 'Enter' }));
    assert.equal(calls.openChat, 0, code + '：禁用态按 Enter 不得发送');

    const blocked = root.querySelector('[data-composer-blocked]');
    assert.ok(blocked, code + '：必须有可见的禁用原因节点');
    assert.equal(blocked.hidden, false, code + '：禁用原因必须可见（不是只放 title）');
    const blockedText = visibleText(blocked);
    assert.match(blockedText, /Input disabled:/u, code + '：禁用原因文案缺失：' + blockedText);
    assert.ok(!textarea.hasAttribute('title') || (textarea.getAttribute('title') ?? '') === '', code + '：原因不能只写在 title 上');
    const configure = blocked.querySelector('[data-action="composer-configure"]');
    assert.ok(configure && configure.disabled === false, code + '：禁用原因旁必须有一个仍可点的配置按钮');
    configure.dispatchEvent(makeEvent('click'));
    assert.equal(calls.navigations.at(-1), '#/settings?group=models', code + '：配置按钮必须真跳设置页');
  }
});

test('非 OK 态：示例输入不出现（不能点了没反应），引导本身充当空态', async (t) => {
  for (const code of GUIDE_STATE_ORDER) {
    const { root } = await mountAgent(t, STATES[code]);
    assert.equal(root.querySelectorAll('[data-action="example"]').length, 0, code + '：禁用态不得渲染示例按钮');
    const guide = root.querySelector('[data-guide="chat-unavailable"]');
    assert.ok(guide, code + '：必须渲染三步引导');
    const viewport = root.querySelector('.agent-thread__viewport');
    assert.ok(viewport && viewport.contains(guide), code + '：引导必须在对话区里（首屏可见，而不是被挤到首屏外）');
  }
});

test('OK 态对照：引导消失、composer 可用、示例可点（证明禁用来自状态而不是永远禁用）', async (t) => {
  const { root, calls } = await mountAgent(t, baseModels());
  assert.equal(root.querySelectorAll('.agent-guide').length, 0, 'OK 态不应渲染引导');
  const textarea = root.querySelector('textarea');
  assert.equal(textarea.disabled, false, 'OK 态 textarea 必须可用');
  assert.equal(root.querySelector('[data-action="send"]').disabled, false, 'OK 态发送按钮必须可用');
  assert.equal(root.querySelector('[data-composer-blocked]').hidden, true, 'OK 态不得显示禁用原因');
  assert.ok(!textarea.getAttribute('aria-describedby'), 'OK 态不应挂着引导的 aria-describedby');
  assert.equal(root.querySelectorAll('[data-action="example"]').length, 3, 'OK 态示例可用');
  assert.equal(calls.openChat, 0, '只挂载不发请求');
});

test('模型接口报错时：显示错误 + 不渲染引导 + composer 仍禁用且原因可见', async (t) => {
  const { root, calls } = await mountAgent(t, null, {
    modelsError: Object.assign(new Error('boom'), { code: 'NETWORK', retryable: true }),
  });
  // 拿不到模型数据时：渲染"加载失败 + 重试"错误提示，但**不**渲染三步引导（引导需要真实状态）
  assert.equal(root.querySelectorAll('[data-guide="chat-unavailable"]').length, 0, '拿不到模型数据时不渲染三步引导');
  assert.ok(root.querySelector('[data-action="retry-models"]'), '必须有重试按钮');
  const text = visibleText(root);
  assert.match(text, /Input disabled:/u);
  assert.equal(root.querySelector('textarea').disabled, true);
  assert.equal(calls.openChat, 0);
  assert.ok(!/\[missing:/u.test(text), '错误态也不得出现 [missing:]');
});
