/**
 * UI-POLISH · T2 settings · 持久化与「每一项都能改」回归
 * 作者：PT-dove
 *
 * 判据（shared task task-2）：
 * 1. 8 组 schema 盘点：kind / immediate / readOnly / 501 / 未接线 全部有据可查；
 * 2. **每一项可写项**：改 → PUT → 重新 GET 回读一致（用 daemon 真实的
 *    createSettingsStore + createSettingsHandlers，写真实临时文件，不是 stub 假装）；
 * 3. 每一项可写项在页面上都有控件（registry 覆盖 = 没有"schema 有、界面没有"的黑洞）；
 * 4. 逐组驱动真实 DOM 控件 → 点保存 → 重新 GET 一致；
 * 5. 危险操作（移除持有密钥的 provider）必须二次确认，且只有 discardCredential 才真的删。
 *
 * 为什么用真 daemon 处理器而不是 tests/console-next/fake-daemon.mjs：
 * fake-daemon 的 PUT 只回显请求体，不做校验也不落盘 —— 那样"存得住"是自证。
 * 这里直接复用 apps/daemon/src/api/settings.js（只读导入，不修改），
 * 于是 SETTINGS_INVALID / SETTINGS_LOCKED / appliedNow 都是真判定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installDom, makeEvent, serialize } from './dom-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

const EN = JSON.parse(readFileSync(path.join(REPO, 'apps/console-next/i18n/locales/en.json'), 'utf8'));
const DICT = EN;
const t = (key, fallback) => {
  const value = DICT[key];
  return typeof value === 'string' && value !== '' ? value : fallback == null ? key : fallback;
};

const SETTINGS_MODULE = pathToFileURL(path.join(REPO, 'apps/console-next/js/views/settings/index.js')).href;

function flush(times = 6) {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return chain;
}

/* -------------------------------------------------------------------------
 * 真实 daemon settings 栈（临时目录 + 真磁盘文件 + 真校验）
 * ---------------------------------------------------------------------- */

async function createDaemonRig(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aidn-t2-settings-'));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响断言 */
    }
  });

  const { createSettingsStore, createSettingsHandlers } = await import(
    '../../apps/daemon/src/api/settings.js'
  );

  const credentials = new Set(options.credentials ?? []);
  const deletedProviders = [];
  const capturedKeys = [];
  const calls = { gets: 0, puts: 0, discarded: [] };
  const filePath = path.join(dir, 'settings.json');
  const store = createSettingsStore({ filePath });
  const handlers = createSettingsHandlers({
    store,
    broker: {
      describeCredentials: async (ids) =>
        // 真实 broker 的形状是 Map<id, {hasCredential}>（见 settings.js::credentialPresence）
        new Map(ids.map((id) => [String(id), { hasCredential: credentials.has(String(id)) }])),
      deleteCredential: async (id) => {
        credentials.delete(String(id));
        deletedProviders.push(String(id));
      },
    },
    readOnly: () => ({}),
  });

  const projection = options.projection ?? {
    providers: [],
    models: [],
    usage: { available: false, reason: 'NO_LEDGER', byProvider: [], byTier: [], escalations: 0 },
    engine: { selected: 'none', harness: { available: false, reason: 'PROFILE_NOT_STAGED' } },
  };

  const api = {
    getSettingsSchema: async () => handlers.getSettingsSchema(),
    getSettings: async () => {
      calls.gets += 1;
      return handlers.getSettings();
    },
    putSettings: async (settings, opts) => {
      calls.puts += 1;
      if (opts && opts.discardCredential === true) calls.discarded.push(true);
      return handlers.putSettings({
        body: {
          settings,
          ...(opts && opts.dryRun === true ? { dryRun: true } : {}),
          ...(opts && opts.discardCredential === true ? { discardCredential: true } : {}),
        },
      });
    },
    getModels: async () => projection,
    putCredential: async (providerId, key) => {
      capturedKeys.push({ providerId: String(providerId), key: String(key) });
      return null;
    },
    deleteCredential: async (providerId) => {
      deletedProviders.push(String(providerId));
      return null;
    },
    testProvider: async () => ({ ok: true, status: 200, latencyMs: 7, modelCount: 2 }),
  };

  return {
    dir,
    filePath,
    store,
    handlers,
    api,
    calls,
    credentials,
    deletedProviders,
    capturedKeys,
    readFile: () => (existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null),
  };
}

/* -------------------------------------------------------------------------
 * DOM + 视图挂载
 * ---------------------------------------------------------------------- */

async function mountSettings(t, rig, extraCtx = {}) {
  const dom = installDom();
  const root = dom.document.createElement('div');
  root.id = 'view-root';
  dom.document.body.appendChild(root);
  const { mount } = await import(SETTINGS_MODULE);
  const ctx = {
    api: rig.api,
    i18n: { t: (key) => DICT[key] },
    store: extraCtx.store ?? null,
    params: {},
    navigate() {},
    toast() {},
    ...extraCtx,
  };
  const handle = await mount(root, ctx);
  await flush();
  return { dom, root, ctx, handle };
}

function itemNode(root, itemPath) {
  return (
    root
      .querySelectorAll('.settings-item')
      .find((node) => node.getAttribute('data-path') === itemPath) ?? null
  );
}

function groupTabs(root) {
  return root.querySelectorAll('.ui-tab');
}

async function selectGroup(root, groupId) {
  const tab = groupTabs(root).find((node) => node.getAttribute('data-tab') === groupId);
  assert.ok(tab, `tab for group "${groupId}" must exist`);
  tab.dispatchEvent(makeEvent('click'));
  await flush(3);
}

/** 驱动一个普通控件（boolean/enum/string/integer/number）。返回是否找到控件。 */
function driveControl(dom, root, item, value) {
  const node = itemNode(root, item.path);
  if (!node) return false;
  const host = node.querySelector('.settings-item__control') || node;
  if (item.type === 'boolean') {
    const button = host.querySelector('.ui-switch') || host.querySelector('button');
    if (!button) return false;
    button.dispatchEvent(makeEvent('click'));
    return true;
  }
  if (item.type === 'enum') {
    const selectNode = host.querySelector('select');
    if (!selectNode) return false;
    selectNode.value = String(value);
    selectNode.dispatchEvent(makeEvent('change'));
    return true;
  }
  const inputNode = host.querySelector('input');
  if (!inputNode) return false;
  inputNode.value = String(value);
  inputNode.dispatchEvent(makeEvent('input'));
  return true;
}

function saveButton(root) {
  const bar = root.querySelector('#settings-savebar') || root.querySelector('.settings-savebar');
  if (!bar) return null;
  return bar.querySelectorAll('button').find((node) => /save/i.test(node.textContent || '')) ?? null;
}

/* -------------------------------------------------------------------------
 * 值生成：为每个可写 schema 项造一个合法且与当前不同的值
 * ---------------------------------------------------------------------- */

function nextValueFor(item, current, base) {
  const type = item.type;
  if (type === 'boolean') return current !== true;
  if (type === 'integer' || type === 'number') {
    const min = item.min == null ? null : Number(item.min);
    const max = item.max == null ? null : Number(item.max);
    const step = type === 'number' ? 0.1 : 1;
    let next = Math.round((Number(current == null ? min ?? 0 : current) + step) * 100) / 100;
    if (max != null && next > max) next = Math.round((Number(current) - step) * 100) / 100;
    if (min != null && next < min) next = min;
    return next;
  }
  if (type === 'enum') {
    const values = item.values || [];
    return values.find((value) => value !== current) ?? current;
  }
  if (type === 'string') {
    if (item.path === 'models.routing.uniformModelId') {
      const models = base && base.models && Array.isArray(base.models.models) ? base.models.models : [];
      return models.length ? String(models[0].id) : 'probe-model';
    }
    return current == null || current === '' ? 'probe-value' : String(current) + '-probe';
  }
  if (type === 'string[]') {
    if (Array.isArray(item.values) && item.values.length > 1) return item.values.slice(0, 2);
    return ['probe-entry'];
  }
  if (type === 'object[]') {
    if (!Array.isArray(current) && current && typeof current === 'object') {
      // severityMapping / actionMatrix：键固定，改第一个键的值（候选=现有值集合）
      const keys = Object.keys(current);
      const first = keys.find((key) => typeof current[key] === 'string');
      if (!first) return current;
      const candidates = [...new Set(Object.values(current).filter((value) => typeof value === 'string'))];
      const alternative = candidates.find((value) => value !== current[first]);
      return alternative ? Object.assign({}, current, { [first]: alternative }) : current;
    }
    if (!Array.isArray(current) || current.length === 0) return current;
    const clone = JSON.parse(JSON.stringify(current));
    if (item.path === 'models.providers') {
      clone.push(Object.assign({}, clone[0], { id: 'probe-provider', enabled: false }));
      return clone;
    }
    if (item.path === 'models.models') {
      clone.push(Object.assign({}, clone[0], { id: 'probe-model' }));
      return clone;
    }
    // allowlist 这类：复制首行并换掉唯一的文本字段，保证仍合法
    const row = clone[0];
    const textField = Object.keys(row).find((key) => typeof row[key] === 'string' && key !== 'kind');
    if (textField) row[textField] = String(row[textField]) + '-probe';
    clone.push(row);
    return clone;
  }
  return current;
}

/* =========================================================================
 * 1 · schema 盘点
 * ====================================================================== */

test('T2-P1 · schema 盘点：8 组 / 可写项 / 只读项 / 501 动作全部可枚举', async (t) => {
  const rig = await createDaemonRig(t);
  const schema = await rig.api.getSettingsSchema();

  assert.equal(schema.groups.length, 8, 'settings schema must describe 8 groups');
  assert.deepEqual(
    schema.groups.map((group) => group.id),
    ['models', 'collection', 'detection', 'response', 'ui', 'update', 'diagnostics', 'about'],
  );

  const items = schema.groups.flatMap((group) => group.items);
  const writable = items.filter((item) => item.readOnly !== true);
  const readOnly = items.filter((item) => item.readOnly === true);
  assert.equal(items.length, 59, 'item count changed — update the inventory in the REPORT');
  assert.equal(writable.length, 50);
  assert.equal(readOnly.length, 9);
  assert.deepEqual(
    readOnly.map((item) => item.path).sort(),
    [
      'about.changelog',
      'about.license',
      'about.privacy',
      'about.version',
      'diagnostics.apiPort',
      'diagnostics.exportBundleLastAt',
      'response.executionEnabled',
      'update.currentVersion',
      'update.lastCheckedAt',
    ].sort(),
  );

  // 未接线（0.0.1 存得下但不生效）：必须由 schema 明说，界面据此标注
  const unwired = items.filter((item) => item.wired === false).map((item) => item.path).sort();
  assert.deepEqual(unwired, ['ui.autostart', 'ui.trayBehavior', 'update.autoCheck'].sort());

  // 动作接线状态必须由 schema 明说，不能有"看起来能点但后端 501"的动作。
  // OPS-DIAG（N-037）把两个取证动作接线了：它们是 available:true + endpoint；
  // 其余三个仍是 0.0.1 未接线（available:false + NOT_IMPLEMENTED_0_0_1）。
  const actions = schema.actions;
  assert.equal(actions.length, 5);
  assert.deepEqual(
    actions.map((action) => action.id).sort(),
    ['diagnostics.exportBundle', 'diagnostics.rotateToken', 'response.runAction', 'update.checkNow', 'update.rollback'].sort(),
  );
  const wired = actions.filter((action) => action.available === true);
  assert.deepEqual(wired.map((action) => action.id).sort(), ['diagnostics.exportBundle', 'diagnostics.rotateToken'].sort());
  for (const action of wired) {
    assert.equal(action.reason, null, `${action.id} 已接线，不应再有 501 reason`);
    assert.match(action.endpoint, /^\/api\/v1\/diagnostics\//u);
  }
  const unwiredActions = actions.filter((action) => action.available === false);
  assert.equal(unwiredActions.length, 3);
  for (const action of unwiredActions) {
    assert.equal(action.reason, 'NOT_IMPLEMENTED_0_0_1', `${action.id} 未接线必须给出 501 reason`);
  }
});

/* =========================================================================
 * 2 · 每一项可写项：PUT → 重新 GET 回读一致（真校验 + 真落盘）
 * ====================================================================== */

test('T2-P2 · 每一项可写项都能改且存得住（真 daemon 处理器，PUT 后 GET 回读一致）', async (t) => {
  const rig = await createDaemonRig(t);
  const schema = await rig.api.getSettingsSchema();
  const { mergeSchemaDefaults, payloadForSave, getPath, setPath } = await import(
    '../../apps/console-next/js/views/settings/shared.js'
  );

  const snapshot = await rig.api.getSettings();
  const base = mergeSchemaDefaults(schema, snapshot.settings);
  const failures = [];
  let checked = 0;

  for (const item of schema.groups.flatMap((group) => group.items)) {
    if (item.readOnly === true) continue;
    const current = getPath(base, item.path);
    const next = nextValueFor(item, current, base);
    const document = JSON.parse(JSON.stringify(base));
    setPath(document, item.path, next);
    // uniform 路由模式需要同一份文档里给出 uniformModelId（真实 UI 也是这么校验的）
    if (item.path === 'models.routing.mode' && next === 'uniform') {
      const models = base.models.models;
      setPath(document, 'models.routing.uniformModelId', String(models[0].id));
    }
    try {
      const payload = payloadForSave(schema, document);
      await rig.api.putSettings(payload, {});
      const readBack = await rig.api.getSettings();
      const got = getPath(readBack.settings, item.path);
      if (JSON.stringify(got) !== JSON.stringify(next)) {
        failures.push(`${item.path}: got ${JSON.stringify(got)} want ${JSON.stringify(next)}`);
      } else {
        checked += 1;
      }
    } catch (error) {
      failures.push(`${item.path}: ${error.code || error.name}: ${error.message} ${JSON.stringify(error.details || {})}`);
    }
  }

  assert.deepEqual(failures, [], `every writable item must round-trip:\n${failures.join('\n')}`);
  assert.equal(checked, 50, 'every writable item was exercised');
});

test('T2-P2b · 变更落到磁盘文件（不是只存在内存里）', async (t) => {
  const rig = await createDaemonRig(t);
  const schema = await rig.api.getSettingsSchema();
  const snapshot = await rig.api.getSettings();
  const settings = JSON.parse(JSON.stringify(snapshot.settings));
  settings.collection.pollIntervalMs = 12345;
  const { payloadForSave } = await import('../../apps/console-next/js/views/settings/shared.js');
  await rig.api.putSettings(payloadForSave(schema, settings), {});

  const onDisk = rig.readFile();
  // 磁盘格式 = {schemaVersion, updatedAt, settings}（apps/daemon/src/api/settings.js save()）
  assert.ok(onDisk && onDisk.settings, 'settings.json must exist after a real PUT');
  assert.equal(onDisk.settings.collection.pollIntervalMs, 12345);
  assert.equal(typeof onDisk.updatedAt, 'string');
  const readBack = await rig.api.getSettings();
  assert.equal(readBack.settings.collection.pollIntervalMs, 12345);
});

/* =========================================================================
 * 3 · 每一项可写项在页面上都有控件
 * ====================================================================== */

test('T2-P3 · 每一项可写项都能在页面上找到控件（8 组全覆盖）', async (t) => {
  const rig = await createDaemonRig(t);
  const schema = await rig.api.getSettingsSchema();
  const { root, handle } = await mountSettings(t, rig);

  const rendered = new Set();
  for (const group of schema.groups) {
    await selectGroup(root, group.id);
    const body = root.querySelector('#settings-body');
    for (const node of body.querySelectorAll('.settings-item')) {
      const itemPath = node.getAttribute('data-path');
      if (itemPath) rendered.add(itemPath);
    }
  }

  const missing = schema.groups
    .flatMap((group) => group.items)
    .filter((item) => item.readOnly !== true && !rendered.has(item.path))
    .map((item) => item.path);

  // models.providers / models.models 是自定义 section（provider 卡片 / 模型表），
  // 不是 .settings-item —— 它们由 models.js 的 providersSection/modelsSection 渲染。
  assert.deepEqual(missing.sort(), ['models.models', 'models.providers'].sort());

  handle.destroy();
});

/* =========================================================================
 * 4 · 逐组驱动真实控件 → 保存 → 回读一致
 * ====================================================================== */

test('T2-P4 · 逐组改一个真实控件 → 点保存 → 重新 GET 一致', async (t) => {
  const rig = await createDaemonRig(t);
  const schema = await rig.api.getSettingsSchema();
  const { root, handle } = await mountSettings(t, rig);
  const { getPath } = await import('../../apps/console-next/js/views/settings/shared.js');
  const { payloadForSave } = await import('../../apps/console-next/js/views/settings/shared.js');

  const targets = [
    { group: 'collection', path: 'collection.pollIntervalMs', value: 15000 },
    { group: 'detection', path: 'detection.thresholds.count', value: 9 },
    { group: 'response', path: 'response.cooldownSeconds', value: 120 },
    { group: 'ui', path: 'ui.autoRefreshMs', value: 20000 },
    { group: 'update', path: 'update.checkIntervalHours', value: 6 },
    { group: 'diagnostics', path: 'diagnostics.healthCheckIntervalMs', value: 45000 },
  ];

  for (const target of targets) {
    await selectGroup(root, target.group);
    const item = schema.groups
      .find((group) => group.id === target.group)
      .items.find((entry) => entry.path === target.path);
    assert.ok(item, `${target.path} must exist in the schema`);
    const driven = driveControl(rig.dom, root, item, target.value);
    assert.ok(driven, `${target.path} must have a control in the ${target.group} group`);

    // dirty → 保存栏必须显示未保存，且保存按钮可用
    const save = saveButton(root);
    assert.ok(save, `the save button must exist for group ${target.group}`);
    assert.equal(save.hasAttribute('disabled'), false, `the save button must be enabled after editing ${target.path}`);

    const putsBefore = rig.calls.puts;
    save.dispatchEvent(makeEvent('click'));
    for (let index = 0; index < 40 && rig.calls.puts === putsBefore; index += 1) {
      await flush(1);
    }
    assert.ok(rig.calls.puts > putsBefore, `saving ${target.path} must issue a PUT`);
    await flush(12);
    const readBack = await rig.api.getSettings();
    assert.equal(getPath(readBack.settings, target.path), target.value);
  }

  // 保存后视图必须显示"没有未保存更改"，而不是继续显示"未保存：N"
  const bar = root.querySelector('#settings-savebar');
  assert.ok(bar, 'save bar must still be mounted');
  const noChanges = String(DICT['settings.no-changes'] || 'No unsaved changes');
  assert.ok(
    (bar.textContent || '').includes(noChanges),
    `after a successful save the bar must say "${noChanges}", got "${bar.textContent}"`,
  );

  void payloadForSave;
  handle.destroy();
});

/* =========================================================================
 * 5 · 危险操作：移除持有密钥的 provider 必须二次确认 + discardCredential
 * ====================================================================== */

test('T2-P5 · 移除持有密钥的 provider：二次确认 → SETTINGS_LOCKED → discardCredential 才真的删', async (t) => {
  const rig = await createDaemonRig(t);
  const { payloadForSave } = await import('../../apps/console-next/js/views/settings/shared.js');
  const schema = await rig.api.getSettingsSchema();

  // 先真实落盘一个"待移除的 provider"（不挂任何模型，避免模型引用校验干扰）
  const snapshot = await rig.api.getSettings();
  const document = JSON.parse(JSON.stringify(snapshot.settings));
  const template = document.models.providers[0];
  document.models.providers.push(
    Object.assign({}, JSON.parse(JSON.stringify(template)), {
      id: 'probe-remove',
      // 模板 provider 的 kind 是厂商专用（强制 https）；纯文本 loopback 只对兼容类放开。
      kind: 'openai-compatible',
      enabled: false,
      baseUrl: 'http://127.0.0.1:8080/v1',
      allowLoopback: true,
    }),
  );
  await rig.api.putSettings(payloadForSave(schema, document), {});
  const seeded = await rig.api.getSettings();
  assert.equal(seeded.settings.models.providers.length, document.models.providers.length);
  // 让 broker 侧声明它持有密钥 → 裸移除必定被 SETTINGS_LOCKED 拦下
  rig.credentials.add('probe-remove');

  const { root, handle, dom } = await mountSettings(t, rig);
  await selectGroup(root, 'models');

  const removeButton = root
    .querySelectorAll('[data-role="remove-provider"]')
    .find((node) => node.getAttribute('data-provider-id') === 'probe-remove');
  assert.ok(removeButton, 'the provider card must expose a remove control');

  // ① 移除 = destructive 二次确认（不是直接删）
  removeButton.dispatchEvent(makeEvent('click'));
  await flush(3);
  const modalRoot = dom.document.getElementById('modal-root');
  const firstConfirm = modalRoot.querySelectorAll('[data-destructive="true"]');
  assert.equal(firstConfirm.length, 1, 'removing a stored provider must open a destructive confirm dialog');

  // ①b 取消 = 什么都没发生：草稿不变、请求计数不变（危险操作必须可反悔）
  const cancelButton = firstConfirm[0]
    .querySelectorAll('button')
    .find((node) => /cancel/i.test(node.textContent || ''));
  assert.ok(cancelButton, 'the confirm dialog must offer Cancel');
  const putsAtStart = rig.calls.puts;
  cancelButton.dispatchEvent(makeEvent('click'));
  await flush(3);
  assert.equal(rig.calls.puts, putsAtStart, 'cancelling a destructive confirm must not send any request');
  assert.equal(
    (await rig.api.getSettings()).settings.models.providers.filter((p) => p.id === 'probe-remove').length,
    1,
    'cancelling must leave the provider in place',
  );

  // ①c 再来一次并确认移除（只改草稿，还没保存）
  removeButton.dispatchEvent(makeEvent('click'));
  await flush(3);
  const confirmRemove = modalRoot
    .querySelectorAll('[data-destructive="true"]')
    .pop()
    .querySelectorAll('button')
    .find((node) => /remove/i.test(node.textContent || ''));
  assert.ok(confirmRemove, 'the confirm dialog must offer the destructive action');
  confirmRemove.dispatchEvent(makeEvent('click'));
  await flush(4);

  // ② 保存：先过"危险变更"确认（移除 provider 属于危险变更），才发 PUT
  const save = saveButton(root);
  assert.ok(save, 'save bar must exist');
  save.dispatchEvent(makeEvent('click'));
  await flush(4);
  const dangerConfirm = modalRoot
    .querySelectorAll('[data-destructive="true"]')
    .pop();
  assert.ok(dangerConfirm, 'saving a provider removal must ask once more before the daemon is called');
  const applyDanger = dangerConfirm
    .querySelectorAll('button')
    .find((node) => /apply/i.test(node.textContent || ''));
  assert.ok(applyDanger, 'the danger dialog must offer "Apply"');
  const putsBefore = rig.calls.puts;
  applyDanger.dispatchEvent(makeEvent('click'));
  for (let index = 0; index < 40 && rig.calls.puts === putsBefore; index += 1) {
    await flush(1);
  }
  assert.ok(rig.calls.puts > putsBefore, 'the confirmed save must reach the daemon');
  for (let index = 0; index < 40 && rig.calls.discarded.length === 0; index += 1) {
    await flush(1);
  }
  await flush(12);

  // ③ 危险变更确认之后，请求必须声明 discardCredential，provider 才真的消失、密钥才真的被删
  assert.deepEqual(rig.calls.discarded, [true], 'the confirmed PUT must declare discardCredential');
  const final = await rig.api.getSettings();
  assert.ok(
    !final.settings.models.providers.some((provider) => provider.id === 'probe-remove'),
    'the provider must be gone after the confirmed save',
  );
  assert.ok(rig.deletedProviders.includes('probe-remove'), 'the credential delete must be issued before the write');

  handle.destroy();
});

/* =========================================================================
 * 6 · SETTINGS_LOCKED 兜底：daemon 仍然说"还持有密钥" → 再确认一次
 * ====================================================================== */

test('T2-P6 · daemon 回 SETTINGS_LOCKED：必须二次确认后才能带 discardCredential 重试', async (t) => {
  const rig = await createDaemonRig(t);
  let lockedOnce = false;
  const inner = rig.api.putSettings;
  rig.api.putSettings = async (settings, opts) => {
    if (!lockedOnce) {
      lockedOnce = true;
      const error = new Error('a removed provider still holds a credential');
      error.code = 'SETTINGS_LOCKED';
      error.details = { providerId: 'deepseek', providers: ['deepseek'] };
      throw error;
    }
    return inner(settings, opts);
  };

  const schema = await rig.api.getSettingsSchema();
  const { payloadForSave, setPath } = await import('../../apps/console-next/js/views/settings/shared.js');
  const { root, handle, dom } = await mountSettings(t, rig);
  await selectGroup(root, 'models');

  const save = saveButton(root);
  assert.ok(save, 'save bar must exist');
  save.dispatchEvent(makeEvent('click'));
  await flush(6);

  const modalRoot = dom.document.getElementById('modal-root');
  const lockedDialog = modalRoot.querySelectorAll('[data-destructive="true"]');
  assert.equal(lockedDialog.length, 1, 'SETTINGS_LOCKED must open an explicit "the key will be deleted" dialog');
  assert.ok(/key/i.test(lockedDialog[0].textContent || ''), 'the dialog must name the credential consequence');

  const discard = lockedDialog[0]
    .querySelectorAll('button')
    .find((node) => /delete|key/i.test(node.textContent || ''));
  assert.ok(discard, 'the dialog must offer the explicit discard action');
  discard.dispatchEvent(makeEvent('click'));
  for (let index = 0; index < 40 && rig.calls.discarded.length === 0; index += 1) {
    await flush(1);
  }
  assert.deepEqual(rig.calls.discarded, [true], 'the retry after SETTINGS_LOCKED must declare discardCredential');

  void schema;
  void payloadForSave;
  void setPath;
  handle.destroy();
});

/* =========================================================================
 * 7 · 密钥区：只回显掩码，零明文，fingerprint 缺失时整行不渲染
 * ====================================================================== */

test('T2-P7 · 密钥区只回显掩码：DOM 无明文、无假 fingerprint、保存后输入框清空、localStorage 无敏感值', async (t) => {
  const providerId = 'deepseek';
  // strict 曝光（FIX R5-003）的真实形状：fingerprint 为 null
  const strictProjection = {
    providers: [
      {
        id: providerId,
        hasCredential: true,
        credential: {
          masked: '••••',
          fingerprint: null,
          lengthBucket: '40-63',
          updatedAt: '2026-11-05T03:00:00.000Z',
        },
      },
    ],
    models: [],
    usage: { available: false, reason: 'NO_LEDGER', byProvider: [], byTier: [], escalations: 0 },
    engine: { selected: 'none', harness: { available: false, reason: 'PROFILE_NOT_STAGED' } },
  };
  const rig = await createDaemonRig(t, { projection: strictProjection });
  const { root, handle, dom } = await mountSettings(t, rig, {});
  await selectGroup(root, 'models');
  await flush(6);

  const credHost = root.querySelectorAll('.settings-creds')[0];
  assert.ok(credHost, 'the provider card must render a credential block');
  const credText = credHost.textContent || '';
  assert.ok(credText.includes('••••'), 'the mask must be the only visible form of the key');
  assert.ok(!/sk-[A-Za-z0-9_-]{6,}/.test(credText), 'no plaintext key may appear in the DOM');
  assert.ok(!/null|undefined/.test(credText), `no null/undefined placeholder may be printed, got "${credText}"`);
  assert.ok(
    !/Fingerprint/i.test(credText),
    'a missing fingerprint must remove the whole row instead of rendering an empty one',
  );
  assert.equal(
    credHost.querySelectorAll('[data-role="credential-strict-note"]').length,
    1,
    'strict mode must explain that only the mask/length/time are available',
  );

  // 保存一把钥匙：明文只发一次，输入框立刻清空，界面上不会出现明文
  const input = credHost.querySelectorAll('[data-role="secret-input"]')[0].querySelectorAll('input')[0];
  assert.ok(input, 'the credential block must expose a secret input');
  input.value = 'sk-plaintext-should-never-echo-0123456789';
  const saveKey = credHost.querySelectorAll('[data-role="save-key"]')[0];
  assert.ok(saveKey, 'the credential block must expose a save action');
  saveKey.dispatchEvent(makeEvent('click'));
  await flush(16);

  assert.equal(rig.capturedKeys.length, 1, 'exactly one key submission must be sent');
  assert.equal(rig.capturedKeys[0].key, 'sk-plaintext-should-never-echo-0123456789');
  const inputAfter = root.querySelectorAll('[data-role="secret-input"]')[0];
  const valueAfter = inputAfter ? inputAfter.querySelectorAll('input')[0].value : '';
  assert.equal(valueAfter, '', 'the input must be cleared immediately after saving');

  const domText = root.textContent || '';
  assert.ok(!domText.includes('sk-plaintext'), 'the plaintext key must never be rendered anywhere in the view');
  const storage = dom.window.localStorage;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    const value = String(storage.getItem(key) || '');
    assert.ok(!value.includes('sk-plaintext'), `localStorage["${key}"] must not carry the plaintext key`);
  }

  handle.destroy();
});

/* =========================================================================
 * 8 · 连通性测试三态：未测 / 成功（状态+延迟+模型）/ 失败（错误码+建议+重试）
 * ====================================================================== */

test('T2-P8 · 连通性三态分明：未测 ≠ 成功，失败必须给错误码+建议+重试且不能显示成成功', async (t) => {
  const rig = await createDaemonRig(t);
  const { root, handle } = await mountSettings(t, rig);
  await selectGroup(root, 'models');
  await flush(6);

  const testBlock = () => root.querySelectorAll('.settings-test')[0];
  assert.ok(testBlock(), 'the provider card must render a connectivity block');

  // ① 未测：明确说"从未测试"，且不显示成功
  assert.equal(testBlock().getAttribute('data-phase'), 'untested');
  assert.equal(root.querySelectorAll('[data-role="test-untested"]').length, 1);
  assert.equal(root.querySelectorAll('[data-role="test-ok"]').length, 0);
  assert.equal(root.querySelectorAll('[data-role="test-error"]').length, 0);

  // ② 成功：HTTP 状态 + 延迟 + 模型清单
  const runTest = () =>
    root
      .querySelectorAll('[data-role="test"]')[0]
      .dispatchEvent(makeEvent('click'));
  runTest();
  await flush(16);
  assert.equal(testBlock().getAttribute('data-phase'), 'ok');
  const okBlock = root.querySelectorAll('[data-role="test-ok"]');
  assert.equal(okBlock.length, 1, 'a successful test must render the ok state');
  assert.ok(/HTTP 200/.test(okBlock[0].textContent || ''), 'the ok state must show the HTTP status');
  assert.ok(/7 ms/.test(okBlock[0].textContent || ''), 'the ok state must show the latency');
  assert.equal(root.querySelectorAll('[data-role="test-error"]').length, 0);

  // ③ 失败：错误码 + 建议动作 + 重试按钮，且视觉上不是成功
  const failure = new Error('401 invalid api key');
  failure.code = 'PROVIDER_UNAUTHORIZED';
  failure.details = { action: 'UPDATE_CREDENTIAL' };
  rig.api.testProvider = async () => {
    throw failure;
  };
  runTest();
  await flush(16);

  assert.equal(testBlock().getAttribute('data-phase'), 'fail', 'a failed test must switch the block to the fail phase');
  assert.equal(root.querySelectorAll('[data-role="test-ok"]').length, 0, 'a failure must never keep the success block');
  const errorBlock = root.querySelectorAll('[data-role="test-error"]');
  assert.equal(errorBlock.length, 1, 'a failure must render the explicit error block');
  const errorText = errorBlock[0].textContent || '';
  assert.ok(errorText.includes('PROVIDER_UNAUTHORIZED'), `the failure must show the error code, got "${errorText}"`);
  assert.ok(/suggest/i.test(errorText), `the failure must suggest an action, got "${errorText}"`);
  assert.ok(
    errorBlock[0].querySelectorAll('button').some((node) => /again|retry/i.test(node.textContent || '')),
    'the failure state must offer a retry button',
  );

  handle.destroy();
});
