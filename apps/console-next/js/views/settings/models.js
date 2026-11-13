/**
 * B7 · 设置组 `models`（模型与用量）——字段全部来自 GET /settings/schema
 * 作者：PT-dove
 *
 * 这里叠加三类 **API 行为**（不属于 settings 文档，但合同 §2.2/§2.3/§2.4 要求）：
 * 1. 凭据：PUT/DELETE /api/v1/credentials/:providerId（只写不读；保存后清空输入，只显示掩码）；
 * 2. 连通性测试：POST /api/v1/models/:providerId/test（四态：未测/测试中/成功/失败）；
 * 3. 运行态投影：GET /api/v1/models（掩码、健康缓存、usage NO_LEDGER、engine 状态）。
 *
 * 明文纪律（合同 §4）：密钥只存在于 secretInput 的 input.value 与一次函数调用的局部变量；
 * 保存时先清空 DOM 再发请求，绝不写入 draft/localStorage/console/toast/DOM 持久节点。
 */
import { el } from '../../components/ui/dom.js';
import { button } from '../../components/ui/button.js';
import { badge } from '../../components/ui/badge.js';
import { secretInput, checkbox } from '../../components/ui/field.js';
import { select } from '../../components/ui/select.js';
import { toggle } from '../../components/ui/toggle.js';
import { skeleton } from '../../components/ui/skeleton.js';
import {
  apiErrorInfo,
  asArray,
  banner,
  credentialFactNodes,
  defaultObjectRow,
  enumLabel,
  errorText,
  findItem,
  formatTimestamp,
  getPath,
  groupItems,
  humanize,
  keyPath,
  notify,
  providerFacts,
  renderControl,
  renderItem,
  section,
  setPath,
  testActionText,
  testStateText,
  toKebab,
  validateProviderUrl,
  confirmDestructive,
} from './shared.js';

export const id = 'models';

/** 每挂载视图一份的模型运行态缓存（index.js 通过 env.modelState 传入同一个对象）。 */
export function createModelState() {
  return {
    projection: null,
    projectionError: null,
    loading: false,
    tests: new Map(),
    credBusy: new Map(),
    credError: new Map(),
    projectionsFetches: 0,
  };
}

function ensureState(env) {
  if (!env.modelState) env.modelState = createModelState();
  return env.modelState;
}

function loadProjection(env) {
  const state = ensureState(env);
  if (state.projection || state.loading) return;
  if (!env.api || typeof env.api.getModels !== 'function') {
    state.projectionError = { code: 'API_MISSING', message: 'api.getModels is not available' };
    return;
  }
  state.loading = true;
  Promise.resolve()
    .then(() => env.api.getModels())
    .then((projection) => {
      state.projection = projection;
      state.projectionError = null;
      state.loading = false;
      env.rerender();
    })
    .catch((error) => {
      state.projectionError = apiErrorInfo(error);
      state.loading = false;
      env.rerender();
    });
}

function refreshProjection(env) {
  const state = ensureState(env);
  state.projection = null;
  state.loading = false;
  loadProjection(env);
}

/* ==========================================================================
 * 渲染入口
 * ========================================================================== */

export function render(env) {
  const { t, draft, schema } = env;
  const state = ensureState(env);
  loadProjection(env);

  const providersItem = findItem(schema, 'models.providers');
  const modelsItem = findItem(schema, 'models.models');
  const egressItem = findItem(schema, 'models.egressEnabled');
  const routingItem = findItem(schema, 'models.routing.mode');
  const uniformItem = findItem(schema, 'models.routing.uniformModelId');
  const providers = asArray(getPath(draft, 'models.providers'));
  const models = asArray(getPath(draft, 'models.models'));

  return el('div', { class: 'stack settings-models' }, [
    egressSection(env, egressItem),
    providersSection(env, providersItem, providers, state),
    routingSection(env, routingItem, uniformItem, modelsItem, models, state),
    budgetSection(env),
    agentSection(env, state),
    usageSection(env, state),
  ]);
}

/* ==========================================================================
 * 零外联 / egress
 * ========================================================================== */

function egressSection(env, egressItem) {
  const { t, draft } = env;
  const bannerSlot = el('div');
  const renderBanner = () => {
    const enabled = getPath(draft, 'models.egressEnabled') === true;
    bannerSlot.replaceChildren(
      banner(
        enabled ? 'danger' : 'info',
        enabled
          ? t('settings.provider.egress-on', 'Egress is on (providers still need to be enabled individually).')
          : t('settings.provider.egress-off', 'Egress is off — testing and chat are refused before any outbound request.'),
        t(
          'settings.models.egress-body',
          'The daemon checks this flag before spawning the broker child; the child checks it again (defence in depth).',
        ),
      ),
    );
  };
  renderBanner();

  const control = toggle({
    checked: getPath(draft, 'models.egressEnabled') === true,
    onChange: (next) => {
      setPath(draft, 'models.egressEnabled', next === true);
      env.onChange('models.egressEnabled');
      renderBanner();
    },
  });
  control.setAttribute('aria-label', t('settings.models.egress-toggle', 'Allow outbound provider requests'));

  const itemPath = 'models.egressEnabled';
  const errorNode = el('p', { class: 'settings-item__error', hidden: true });
  env.registry.set(itemPath, {
    path: itemPath,
    wrapper: control,
    control,
    errorNode,
    setError(message) {
      if (!message) {
        errorNode.setAttribute('hidden', '');
        return;
      }
      errorNode.removeAttribute('hidden');
      errorNode.textContent = message;
      control.setAttribute('aria-invalid', 'true');
    },
  });

  const itemRow = el('div', { class: 'settings-item', data: { path: itemPath } }, [
    el('div', { class: 'settings-item__head' }, [
      el('span', {
        class: 'settings-item__label',
        text: egressItem ? t(egressItem.labelKey || '', 'Allow outbound requests') : 'Allow outbound requests',
      }),
      el('code', { class: 'settings-item__path', text: itemPath }),
      badge({ tone: 'danger', text: t('settings.dangerous', 'Dangerous') }),
      badge({ tone: 'info', text: t('settings.applies-at.immediate', 'Applies immediately') }),
    ]),
    el('div', { class: 'settings-item__control' }, [control]),
    errorNode,
  ]);

  return section({
    id: 'settings-models-egress',
    title: t('settings.models.egress-section', 'Egress (zero-outbound by default)'),
    note: t(
      'settings.models.egress-note',
      'Every outbound request is refused while this is off, before any socket is opened. Providers must also be enabled individually, and a key must be stored.',
    ),
    body: [bannerSlot, itemRow],
  });
}

/* ==========================================================================
 * Providers
 * ========================================================================== */

function providersSection(env, providersItem, providers, state) {
  const { t, schema } = env;
  const maxItems = Number.isFinite(Number(providersItem && providersItem.maxItems))
    ? Number(providersItem.maxItems)
    : 8;
  const list = el('div', { class: 'settings-providers' });
  const sectionError = el('p', { class: 'settings-item__error', hidden: true });

  providers.forEach((provider, index) => {
    list.appendChild(providerCard(env, provider, index, providersItem, state));
  });
  if (providers.length === 0) {
    list.appendChild(el('p', { class: 'faint', text: t('settings.provider.none', 'No providers registered') }));
  }

  env.registry.set('models.providers', {
    path: 'models.providers',
    wrapper: list,
    errorNode: sectionError,
    control: list,
    setError(message) {
      if (!message) {
        sectionError.setAttribute('hidden', '');
        sectionError.textContent = '';
        return;
      }
      sectionError.removeAttribute('hidden');
      sectionError.textContent = message;
    },
  });

  const addButton = button({
    label: t('settings.provider.add', 'Add provider'),
    icon: 'plus',
    size: 'sm',
    disabled: providers.length >= maxItems,
    onClick: () => {
      const rows = asArray(getPath(env.draft, 'models.providers'));
      const template = defaultObjectRow(asArray(providersItem && providersItem.fields));
      template.pricing = null;
      rows.push(template);
      setPath(env.draft, 'models.providers', rows);
      env.onChange('models.providers');
      env.rerender();
    },
  });

  const projectionBanner = state.projectionError
    ? banner(
        'warn',
        t('settings.models.projection-failed', 'Could not read the model runtime state'),
        errorText(t, state.projectionError.code, state.projectionError.message),
        [
          button({
            label: t('settings.error.retry', 'Retry'),
            size: 'sm',
            onClick: () => {
              state.projectionError = null;
              refreshProjection(env);
              env.rerender();
            },
          }),
        ],
      )
    : null;

  return section({
    id: 'settings-models-providers',
    title: t('settings.models.providers', 'Providers'),
    note: t(
      'settings.models.providers-note',
      'Up to {limit} providers. Plaintext HTTP is only accepted for a literal loopback host with allowLoopback and a non-deepseek kind; userinfo, query and fragment are rejected.',
      { limit: maxItems },
    ),
    actions: [
      addButton,
      el('span', { class: 'faint', text: String(providers.length) + ' / ' + String(maxItems) }),
    ],
    body: [projectionBanner, sectionError, list],
  });
}

/** provider 卡片：schema 子字段 + 凭据 + 连通性测试。 */
function providerCard(env, provider, index, providersItem, state) {
  const { t, schema, draft } = env;
  const facts = providerFacts(state.projection, provider.id);
  const saved = isSavedProvider(env, provider.id);
  const fields = asArray(providersItem && providersItem.fields);
  const path = 'models.providers[' + index + ']';
  const grid = el('div', { class: 'settings-provider__grid' });
  const urlError = el('p', {
    class: 'settings-item__error',
    hidden: true,
    data: { 'error-for': path + '.baseUrl' },
  });

  for (const fieldDef of fields) {
    if (fieldDef.name === 'pricing') {
      grid.appendChild(pricingEditor(env, provider, index));
      continue;
    }
    const fieldPath = path + '.' + fieldDef.name;
    const labelText = t(
      'settings.field.' + keyPath('models.providers') + '.' + toKebab(fieldDef.name),
      humanize(fieldDef.name),
    );
    const readOnly = fieldDef.name === 'id' && saved;
    const control = renderControl({
      type: fieldDef.type === 'enum' ? 'enum' : fieldDef.type,
      value: provider[fieldDef.name],
      values: asArray(fieldDef.values),
      min: fieldDef.min,
      max: fieldDef.max,
      path: fieldPath,
      label: labelText,
      readOnly,
      mono: fieldDef.name === 'baseUrl' || fieldDef.name === 'id',
      placeholder: fieldDef.pattern || '',
      t,
      onInput: (next) => {
        provider[fieldDef.name] = next;
        setPath(draft, fieldPath, next);
        env.onChange(fieldPath);
        if (fieldDef.name === 'baseUrl' || fieldDef.name === 'kind' || fieldDef.name === 'allowLoopback') {
          updateUrlError();
        }
        if (fieldDef.name === 'enabled') env.rerender();
      },
    });
    const fieldNote = fieldDef.name === 'id' && saved
      ? t('settings.provider.id-locked', 'Provider id cannot change after it is saved; remove and re-add it instead.')
      : '';
    grid.appendChild(
      el('div', { class: 'settings-subfield', data: { path: fieldPath } }, [
        el('span', { class: 'settings-subfield__label', text: labelText }),
        control,
        fieldNote ? el('span', { class: 'faint', text: fieldNote }) : null,
      ]),
    );
    env.registry.set(fieldPath, {
      path: fieldPath,
      wrapper: control,
      control,
      errorNode: null,
      setError(message) {
        if (!message) return;
        updateUrlError(message);
      },
    });
  }

  function updateUrlError(explicit) {
    if (explicit) {
      urlError.removeAttribute('hidden');
      urlError.textContent = explicit;
      return;
    }
    const result = validateProviderUrl(provider.baseUrl, {
      allowLoopback: provider.allowLoopback === true,
      kind: provider.kind,
    });
    if (result.ok) {
      urlError.setAttribute('hidden', '');
      urlError.textContent = '';
      return;
    }
    urlError.removeAttribute('hidden');
    urlError.textContent = t(
      'settings.error.url.' + toKebab(result.reason),
      'baseUrl rejected: ' + result.reason,
    );
  }
  updateUrlError();

  const removeButton = button({
    label: t('settings.provider.remove', 'Remove provider'),
    icon: 'trash',
    variant: 'danger',
    size: 'sm',
    onClick: () => removeProvider(env, index, provider, facts),
  });
  removeButton.setAttribute('data-role', 'remove-provider');
  removeButton.setAttribute('data-provider-id', String(provider.id || ''));

  const head = el('div', { class: 'settings-provider__head' }, [
    el('code', { class: 'mono', text: saved ? provider.id : t('settings.provider.new', 'new provider') }),
    badge({
      tone: provider.enabled === true ? 'ok' : 'neutral',
      text: provider.enabled === true ? t('settings.enum.yes', 'Enabled') : t('settings.enum.no', 'Disabled'),
    }),
    facts.hasCredential ? badge({ tone: 'info', text: t('settings.provider.credential-set', 'Key stored') }) : null,
    el('span', { class: 'grow' }),
    removeButton,
  ]);

  return el(
    'div',
    { class: 'settings-provider', data: { providerId: provider.id || '', index: String(index) } },
    [
      head,
      grid,
      urlError,
      credentialBlock(env, provider, index, facts, saved, state),
      connectivityBlock(env, provider, facts, saved, state),
    ],
  );
}

function isSavedProvider(env, providerId) {
  const serverProviders = asArray(getPath(env.server && env.server.settings, 'models.providers'));
  return serverProviders.some((entry) => entry && entry.id === providerId);
}

/**
 * `pricing` 在 schema 里是 `type:"secret"` 的可空对象（null 或两档单价）。
 * 契约 §6：pricing 为 null ⇒ usage.estimatedCostUsd=null（UI 显示"— 未配置单价"，不得编造）。
 */
function pricingEditor(env, provider, index) {
  const { t } = env;
  const path = 'models.providers[' + index + '].pricing';
  const current = provider.pricing && typeof provider.pricing === 'object' ? provider.pricing : null;
  const configured = current !== null;
  const host = el('div', { class: 'settings-subfield', data: { path } });
  const errorNode = el('p', { class: 'settings-item__error', hidden: true });

  const toggleNode = checkbox({
    label: t('settings.provider.pricing-set', 'Configure price (USD / MTok)'),
    checked: configured,
    onChange: (on) => {
      provider.pricing = on ? { inputUsdPerMTok: 0, outputUsdPerMTok: 0 } : null;
      setPath(env.draft, path, provider.pricing);
      env.onChange(path);
      env.rerender();
    },
  });
  host.appendChild(toggleNode);

  if (configured) {
    const grid = el('div', { class: 'settings-provider__grid' });
    for (const key of ['inputUsdPerMTok', 'outputUsdPerMTok']) {
      const value = current && current[key] != null ? current[key] : 0;
      grid.appendChild(
        el('div', { class: 'settings-subfield', data: { path: path + '.' + key } }, [
          el('span', { class: 'settings-subfield__label', text: key }),
          renderControl({
            type: 'number',
            value,
            min: 0,
            max: 1000000,
            path: path + '.' + key,
            label: key,
            t,
            onInput: (next) => {
              const pricing = provider.pricing && typeof provider.pricing === 'object' ? provider.pricing : {};
              pricing[key] = next;
              provider.pricing = pricing;
              setPath(env.draft, path, pricing);
              env.onChange(path);
            },
          }),
        ]),
      );
    }
    host.appendChild(grid);
  }
  host.appendChild(
    el('p', {
      class: 'faint',
      text: configured
        ? t('settings.provider.pricing-hint', 'Used only for cost estimates; leave it off to show “— no price configured”.')
        : t('settings.provider.pricing-off', 'No price configured: cost estimates stay null (never 0).'),
    }),
  );
  host.appendChild(errorNode);
  env.registry.set(path, {
    path,
    wrapper: host,
    control: host,
    errorNode,
    setError(message) {
      if (!message) {
        errorNode.setAttribute('hidden', '');
        return;
      }
      errorNode.removeAttribute('hidden');
      errorNode.textContent = message;
    },
  });
  return host;
}

function removeProvider(env, index, provider, facts) {
  const { t } = env;
  const saved = isSavedProvider(env, provider.id);
  const apply = () => {
    const rows = asArray(getPath(env.draft, 'models.providers'));
    rows.splice(index, 1);
    setPath(env.draft, 'models.providers', rows);
    env.onChange('models.providers');
    if (saved && facts.hasCredential) env.noteCredentialDiscard(provider.id);
    env.rerender();
  };
  if (!saved) {
    apply();
    return;
  }
  confirmDestructive(env.ctx, {
    t,
    title: t('settings.provider.remove-title', 'Remove provider “{id}”?', { id: provider.id }),
    body: t(
      'settings.provider.remove-body',
      'The provider is removed from the saved settings. If it still holds a key, the key is deleted in the same request (discardCredential).',
    ),
    consequences: facts.hasCredential
      ? [
          t('settings.danger.provider-removed', 'Provider “{id}” will be removed.', { id: provider.id }),
          t('settings.danger.provider-credential-lost', 'Its stored API key is deleted too — this cannot be undone.'),
        ]
      : [t('settings.danger.provider-removed', 'Provider “{id}” will be removed.', { id: provider.id })],
    confirmLabel: t('settings.provider.remove', 'Remove provider'),
    onConfirm: apply,
  });
}

/* ==========================================================================
 * 凭据（只写不读）
 * ========================================================================== */

function credentialBlock(env, provider, index, facts, saved, state) {
  const { t } = env;
  const busy = state.credBusy.get(provider.id) === true;
  const error = state.credError.get(provider.id) || '';
  // 只回显真实存在的字段：掩码 + 长度桶 + 更新时间 +（**有则**）指纹前 8。
  // strict 曝光（FIX R5-003）下 fingerprint 为 null —— 此时整行不渲染，
  // 并如实说明"只能证明存过一把这个长度的钥匙，不能证明是哪一把"。
  const factNodes = credentialFactNodes(t, facts, env.locale);
  const factsRow = el('div', { class: 'settings-creds__facts settings-credential-facts' }, factNodes.nodes);
  const strictNote =
    facts.hasCredential && factNodes.proof === 'masked-only'
      ? el('p', {
          class: 'faint',
          'data-role': 'credential-strict-note',
          text: t(
            'settings.provider.strict-note',
            'The host exposes this key in strict mode: only the mask, length bucket and timestamp are available. The console can prove that a key of this length was stored at that time — it cannot prove which key it is.',
          ),
        })
      : null;

  const errorNode = el('p', { class: 'settings-item__error', hidden: error === '' });
  if (error) errorNode.textContent = error;

  let secretWrap = null;
  if (!saved) {
    errorNode.removeAttribute('hidden');
    errorNode.textContent = t('settings.provider.credential-unavailable', 'Save the provider before storing a key.');
  } else {
    secretWrap = secretInput({
      placeholder: 'sk-…',
      ariaLabel: t('settings.provider.credential', 'API key'),
      showLabel: t('settings.provider.show-key', 'Show key'),
      hideLabel: t('settings.provider.hide-key', 'Hide key'),
      autoComplete: 'off',
    });
  }
  const keyInput = secretWrap ? secretWrap.childNodes[0] : null;

  async function saveKey() {
    if (!keyInput) return;
    const raw = keyInput.value;
    keyInput.value = ''; // 先清空 DOM，再做任何异步/分支
    let key = String(raw == null ? '' : raw);
    const shape = validateKeyShape(key);
    if (!shape.ok) {
      key = '';
      state.credError.set(provider.id, t('settings.provider.key-invalid', 'A key must be 8–512 characters on a single line.'));
      env.rerender();
      return;
    }
    state.credError.delete(provider.id);
    state.credBusy.set(provider.id, true);
    env.rerender();
    try {
      await env.api.putCredential(provider.id, key);
      key = '';
      state.credBusy.delete(provider.id);
      notify(env.ctx, 'ok', t('settings.provider.credential-saved', 'Key saved. Only the mask is shown from now on.'));
      refreshProjection(env);
    } catch (caught) {
      key = '';
      const info = apiErrorInfo(caught);
      state.credBusy.delete(provider.id);
      state.credError.set(provider.id, errorText(t, info.code, info.message));
      env.rerender();
    }
  }

  async function deleteKey() {
    state.credBusy.set(provider.id, true);
    state.credError.delete(provider.id);
    env.rerender();
    try {
      await env.api.deleteCredential(provider.id);
      state.credBusy.delete(provider.id);
      notify(env.ctx, 'ok', t('settings.provider.credential-deleted', 'Key deleted.'));
      refreshProjection(env);
    } catch (caught) {
      const info = apiErrorInfo(caught);
      state.credBusy.delete(provider.id);
      state.credError.set(provider.id, errorText(t, info.code, info.message));
      env.rerender();
    }
  }

  const saveKeyButton = button({
    label: t('settings.provider.save-key', 'Save key'),
    variant: 'primary',
    size: 'sm',
    busy,
    onClick: saveKey,
  });
  saveKeyButton.setAttribute('data-role', 'save-key');
  const deleteKeyButton = button({
    label: t('settings.provider.delete-key', 'Delete key'),
    variant: 'danger',
    size: 'sm',
    disabled: busy,
    onClick: () => {
      confirmDestructive(env.ctx, {
        t,
        title: t('settings.provider.delete-key-title', 'Delete the stored key for “{id}”?', { id: provider.id }),
        body: t(
          'settings.provider.delete-key-body',
          'Chat and connection tests for this provider will fail until a new key is saved.',
        ),
        confirmLabel: t('settings.provider.delete-key', 'Delete key'),
        onConfirm: deleteKey,
      });
    },
  });
  deleteKeyButton.setAttribute('data-role', 'delete-key');
  const actions = el('div', { class: 'settings-actions' }, [saved ? saveKeyButton : null, saved && facts.hasCredential ? deleteKeyButton : null]);

  if (secretWrap) secretWrap.setAttribute('data-role', 'secret-input');

  return el('div', { class: 'settings-creds', data: { providerId: provider.id } }, [
    el('div', { class: 'settings-creds__head' }, [
      el('span', { class: 'settings-subfield__label', text: t('settings.provider.credential', 'API key') }),
      factsRow,
      strictNote,
    ]),
    secretWrap,
    el('p', { class: 'faint', text: t('settings.provider.key-hint', 'The plaintext key is sent once, then cleared.') }),
    actions,
    errorNode,
  ]);
}

function validateKeyShape(key) {
  if (typeof key !== 'string' || key === '') return { ok: false, reason: 'EMPTY' };
  if (key.includes('\n') || key.includes('\r')) return { ok: false, reason: 'MULTILINE' };
  const trimmed = key.trim();
  if (trimmed.length < 8) return { ok: false, reason: 'TOO_SHORT' };
  if (trimmed.length > 512) return { ok: false, reason: 'TOO_LONG' };
  return { ok: true };
}

/* ==========================================================================
 * 连通性测试（四态）
 * ========================================================================== */

function initialTestState(facts) {
  if (facts.healthy === true) {
    return { phase: 'ok', testedAt: facts.lastCheckedAt, fromCache: true };
  }
  if (facts.healthy === false) {
    return {
      phase: 'fail',
      code: facts.lastError && facts.lastError.code ? String(facts.lastError.code) : 'UPSTREAM_FAILED',
      action: facts.lastError && facts.lastError.action ? String(facts.lastError.action) : null,
      message: facts.lastError && facts.lastError.message ? String(facts.lastError.message) : '',
      testedAt: facts.lastCheckedAt,
      fromCache: true,
    };
  }
  return { phase: 'untested' };
}


/** 连通性测试按钮（带 data-role 便于 B11/自测定位）。 */
function testButton(spec) {
  const node = button({
    label: spec.testing
      ? spec.t('settings.provider.testing', 'Testing…')
      : spec.t('settings.provider.test', 'Test connection'),
    size: 'sm',
    busy: spec.testing,
    disabled: spec.testing || !spec.saved,
    onClick: spec.runTest,
  });
  node.setAttribute('data-role', 'test');
  return node;
}
function connectivityBlock(env, provider, facts, saved, state) {
  const { t } = env;
  const cached = state.tests.get(provider.id);
  const current = cached || initialTestState(facts);
  const testing = current.phase === 'testing';

  const tone =
    current.phase === 'ok' ? 'ok' : current.phase === 'fail' ? 'danger' : current.phase === 'testing' ? 'info' : 'neutral';

  async function runTest() {
    state.tests.set(provider.id, { phase: 'testing' });
    env.rerender();
    try {
      const response = await env.api.testProvider(provider.id);
      state.tests.set(provider.id, normalizeTestResponse(response));
    } catch (caught) {
      const info = apiErrorInfo(caught);
      const details = info.details || {};
      state.tests.set(provider.id, {
        phase: 'fail',
        code: info.code || 'UNKNOWN',
        action: details.action || actionForCode(info.code),
        message: info.message,
        testedAt: new Date().toISOString(),
      });
    }
    env.rerender();
  }

  return el('div', { class: 'settings-test', data: { providerId: provider.id, phase: current.phase } }, [
    el('div', { class: 'settings-test__head' }, [
      el('span', { class: 'settings-subfield__label', text: t('settings.provider.test', 'Test connection') }),
      // 三态：未测 / 成功（状态+延迟+模型数）/ 失败（错误码+建议+重试）。
      // 失败永不用 ok/warn 视觉；未测也不用灰色"看起来没问题"的措辞。
      badge({ tone, text: testStateText(t, current, env.locale) }),
      el('span', { class: 'grow' }),
      testButton({
        testing,
        saved,
        runTest,
        t,
      }),
    ]),
    current.phase === 'fail'
      ? el('p', { class: 'settings-test__error', data: { role: 'test-error' } }, [
          el('span', { class: 'faint', text: t('settings.provider.test-code', 'Error code') + ': ' }),
          el('code', { class: 'mono', text: current.code || 'UPSTREAM_FAILED' }),
          current.action
            ? el('span', {
                text: ' · ' + t('settings.provider.test-suggest', 'Suggested action: {action}', {
                  action: testActionText(t, current.action),
                }),
              })
            : null,
          current.message ? el('span', { class: 'faint', text: ' · ' + String(current.message) }) : null,
          // 可重试：失败态永远给一个明确的"再测一次"，而不是让用户以为按钮没反应。
          button({
            label: t('settings.provider.test-retry', 'Test again'),
            size: 'sm',
            variant: 'secondary',
            disabled: testing || !saved,
            onClick: runTest,
          }),
        ])
      : null,
    current.phase === 'ok'
      ? el('div', { class: 'stack', 'data-role': 'test-ok' }, [
          current.status != null
            ? el('p', { class: 'faint', text: 'HTTP ' + String(current.status) + ' · ' + String(current.latencyMs == null ? '—' : current.latencyMs) + ' ms' })
            : null,
          el('p', { class: 'faint' }, [
            el('span', { text: t('settings.provider.models', 'models') + ': ' }),
            el('code', {
              class: 'mono',
              text:
                asArray(getPath(env.draft, 'models.models'))
                  .filter((model) => model && String(model.providerId) === String(provider.id))
                  .map((model) => String(model.id))
                  .join(', ') || '—',
            }),
          ]),
        ])
      : null,
    current.phase === 'untested'
      ? el('p', {
          class: 'faint',
          'data-role': 'test-untested',
          text: t('settings.provider.untested-hint', 'Never tested. A successful test is the only proof this provider can be reached — an untested provider is not a working one.'),
        })
      : null,
    !saved
      ? el('p', { class: 'faint', text: t('settings.provider.credential-unavailable', 'Save the provider before storing a key.') })
      : null,
  ]);
}

function normalizeTestResponse(response) {
  if (response && response.ok === true) {
    return {
      phase: 'ok',
      status: Number.isFinite(Number(response.status)) ? Number(response.status) : null,
      latencyMs: Number.isFinite(Number(response.latencyMs)) ? Number(response.latencyMs) : null,
      modelCount: Number.isFinite(Number(response.modelCount)) ? Number(response.modelCount) : null,
      testedAt: response.testedAt || new Date().toISOString(),
    };
  }
  const error = response && response.error && typeof response.error === 'object' ? response.error : null;
  return {
    phase: 'fail',
    code: error && error.code ? String(error.code) : 'UPSTREAM_FAILED',
    action: error && error.action ? String(error.action) : null,
    message: error && error.message ? String(error.message) : '',
    testedAt: (response && response.testedAt) || new Date().toISOString(),
  };
}

/** 409 前置失败没有 error.action，用合同 §3.2 的枚举补一条可操作建议。 */
function actionForCode(code) {
  if (code === 'EGRESS_DISABLED' || code === 'PROVIDER_DISABLED') return 'OPEN_SETTINGS_MODELS';
  if (code === 'CREDENTIAL_MISSING') return 'CHECK_KEY';
  if (code === 'CREDENTIAL_STORE_UNAVAILABLE') return 'RETRY_LATER';
  return null;
}

/* ==========================================================================
 * 路由 / tier 映射 / 预算 / agent / usage
 * ========================================================================== */

function routingSection(env, routingItem, uniformItem, modelsItem, models, state) {
  const { t, draft } = env;
  const mode = getPath(draft, 'models.routing.mode');
  const items = groupItems(env.schema, 'models').filter(
    (item) => item.path === 'models.routing.defaultTier' || item.path.indexOf('models.routing.escalation.') === 0,
  );
  const tierField = asArray(modelsItem && modelsItem.fields).find((field) => field.name === 'tier');
  const tiers = tierField && Array.isArray(tierField.values) ? tierField.values : ['watch', 'triage', 'respond'];
  const uniformValue = getPath(draft, 'models.routing.uniformModelId');
  const uniformMissing = mode === 'uniform' && (uniformValue == null || uniformValue === '');

  const uniformControl = select({
    options: models
      .filter((model) => model && model.id)
      .map((model) => ({
        value: String(model.id),
        label: String(model.id) + ' · ' + String(model.providerId || ''),
      })),
    value: uniformValue == null ? '' : String(uniformValue),
    placeholder: t('settings.models.uniform-placeholder', 'Choose the main model…'),
    ariaLabel: uniformItem ? t(uniformItem.labelKey || '', humanize('uniformModelId')) : 'uniformModelId',
    onChange: (next) => {
      setPath(draft, 'models.routing.uniformModelId', next === '' ? null : next);
      env.onChange('models.routing.uniformModelId');
      env.rerender();
    },
  });
  env.registry.set('models.routing.uniformModelId', {
    path: 'models.routing.uniformModelId',
    wrapper: uniformControl,
    control: uniformControl,
    errorNode: null,
    setError(message) {
      if (message) uniformControl.setAttribute('aria-invalid', 'true');
    },
  });

  const tierCards = tiers.map((tier) => {
    const assigned = models.filter((model) => model && model.tier === tier);
    return el('div', { class: 'settings-tier__card', data: { tier: String(tier) } }, [
      el('div', { class: 'settings-tier__head' }, [
        el('strong', { text: enumLabel(t, 'models.models.tier', tier) }),
        badge({
          tone: assigned.length ? 'accent' : 'neutral',
          text: String(assigned.length),
        }),
      ]),
      assigned.length
        ? el(
            'ul',
            { class: 'settings-tier__list' },
            assigned.map((model) =>
              el('li', { class: 'mono', text: String(model.id) + ' · ' + String(model.providerId || '') }),
            ),
          )
        : el('p', { class: 'faint', text: t('settings.tier.empty', 'No model assigned to this tier') }),
    ]);
  });

  return el('div', { class: 'stack' }, [
    section({
      id: 'settings-models-routing',
      title: t('settings.models.routing', 'Routing & tier mapping'),
      note: t(
        'settings.models.routing-note',
        'tiered uses the model assigned to each tier; uniform sends every request to the main model and therefore requires one to be chosen.',
      ),
      body: [
        routingItem ? renderItem(routingItem, env) : null,
        el('div', { class: 'settings-item', data: { path: 'models.routing.uniformModelId' } }, [
          el('div', { class: 'settings-item__head' }, [
            el('span', { class: 'settings-item__label', text: t('settings.models.uniform-model', 'Main model (uniform)') }),
            el('code', { class: 'settings-item__path', text: 'models.routing.uniformModelId' }),
            mode === 'uniform' ? badge({ tone: 'warn', text: 'uniform' }) : null,
          ]),
          el('div', { class: 'settings-item__control' }, [uniformControl]),
          uniformMissing
            ? el('p', {
                class: 'settings-item__error',
                text: t('settings.tier.uniform-required', 'Choose the main model before saving in uniform mode.'),
              })
            : null,
        ]),
        el('h3', { class: 'settings-section__title', text: t('settings.tier.heading', 'Tier mapping') }),
        el('div', { class: 'settings-tier' }, tierCards),
        el('div', { class: 'settings-stack' }, items.map((item) => renderItem(item, env))),      ],
    }),
    modelsSection(env, modelsItem, models, state),
  ]);
}

function modelsSection(env, modelsItem, models, state) {
  const { t } = env;
  const list = el('div', { class: 'settings-list' });
  const errorNode = el('p', { class: 'settings-item__error', hidden: true });
  const fields = asArray(modelsItem && modelsItem.fields);

  models.forEach((model, index) => {
    const row = el('div', {
      class: 'settings-array__row',
      data: { index: String(index), 'model-id': String(model && model.id ? model.id : ''), path: 'models.models[' + index + ']' },
    }, [
      el('div', { class: 'settings-array__head' }, [
        el('span', { class: 'settings-array__title', text: 'models.models[' + index + ']' }),
        button({
          icon: 'trash',
          variant: 'ghost',
          size: 'sm',
          ariaLabel: t('settings.model.remove', 'Remove model'),
          onClick: () => {
            const rows = asArray(getPath(env.draft, 'models.models'));
            rows.splice(index, 1);
            setPath(env.draft, 'models.models', rows);
            env.onChange('models.models');
            env.rerender();
          },
        }),
      ]),
      el(
        'div',
        { class: 'settings-array__grid' },
        fields.map((fieldDef) => {
          const fieldPath = 'models.models[' + index + '].' + fieldDef.name;
          const labelText = t('settings.field.' + keyPath('models.models') + '.' + toKebab(fieldDef.name), humanize(fieldDef.name));
          const control = renderControl({
            type: fieldDef.type === 'enum' ? 'enum' : fieldDef.type,
            value: model[fieldDef.name],
            values: asArray(fieldDef.values),
            min: fieldDef.min,
            max: fieldDef.max,
            path: fieldPath,
            label: labelText,
            mono: fieldDef.name === 'id',
            t,
            onInput: (next) => {
              model[fieldDef.name] = next;
              setPath(env.draft, fieldPath, next);
              env.onChange(fieldPath);
              if (fieldDef.name === 'tier') env.rerender();
            },
          });
          env.registry.set(fieldPath, {
            path: fieldPath,
            wrapper: control,
            control,
            errorNode: null,
            setError(message) {
              if (message) control.setAttribute('aria-invalid', 'true');
            },
          });
          return el('div', { class: 'settings-subfield', data: { path: fieldPath } }, [
            el('span', { class: 'settings-subfield__label', text: labelText }),
            control,
          ]);
        }),
      ),
    ]);
    list.appendChild(row);
  });

  if (models.length === 0) {
    list.appendChild(el('p', { class: 'faint', text: t('settings.model.none', 'No models registered') }));
  }

  const maxItems = Number.isFinite(Number(modelsItem && modelsItem.maxItems)) ? Number(modelsItem.maxItems) : 32;
  env.registry.set('models.models', {
    path: 'models.models',
    wrapper: list,
    control: list,
    errorNode,
    setError(message) {
      if (!message) {
        errorNode.setAttribute('hidden', '');
        errorNode.textContent = '';
        return;
      }
      errorNode.removeAttribute('hidden');
      errorNode.textContent = message;
    },
  });

  return section({
    title: t('settings.models.models', 'Model registry'),
    note: t(
      'settings.models.models-note',
      'Each model belongs to a provider and a tier. A model id must be unique; a provider that does not exist is refused by the daemon.',
    ),
    actions: [
      button({
        label: t('settings.model.add', 'Add model'),
        icon: 'plus',
        size: 'sm',
        disabled: models.length >= maxItems,
        onClick: () => {
          const rows = asArray(getPath(env.draft, 'models.models'));
          rows.push(defaultObjectRow(fields));
          setPath(env.draft, 'models.models', rows);
          env.onChange('models.models');
          env.rerender();
        },
      }),
      el('span', { class: 'faint', text: String(models.length) + ' / ' + String(maxItems) }),
    ],
    body: [errorNode, list],
  });
}

function budgetSection(env) {
  const { t } = env;
  const items = groupItems(env.schema, 'models').filter((item) => item.path.indexOf('models.budget.') === 0);
  return section({
    title: t('settings.models.budget', 'Budgets'),
    note: t(
      'settings.models.budget-note',
      'Hard ceilings enforced by the daemon before an analysis starts; a request that would exceed them is refused, not silently truncated.',
    ),
    body: items.map((item) => renderItem(item, env)),
  });
}

function agentSection(env, state) {
  const { t } = env;
  const items = groupItems(env.schema, 'models').filter((item) => item.path.indexOf('models.agent.') === 0);
  const engine = state.projection && state.projection.engine ? state.projection.engine : null;
  const harness = engine && engine.harness ? engine.harness : null;
  const harnessNote = harness
    ? banner(
        harness.available === true ? 'info' : 'warn',
        harness.available === true
          ? t('settings.models.harness-ready', 'Harness engine is available')
          : t('settings.models.harness-unavailable', 'Harness engine is not ready'),
        harness.available === true
          ? ''
          : t(
              'settings.models.harness-reason',
              'Available engine: {engine}. Harness reports: {reason}.',
              {
                engine: String((engine && engine.selected) || '—'),
                reason: String(harness.reason || 'PROFILE_NOT_STAGED'),
              },
            ),
      )
    : null;

  return section({
    title: t('settings.models.agent', 'Agent engine'),
    note: t(
      'settings.models.agent-note',
      'Engine changes apply to the next chat request. If the harness profile is not staged, the broker-host engine is the honest fallback.',
    ),
    body: [harnessNote, ...items.map((item) => renderItem(item, env))],
  });
}

function usageSection(env, state) {
  const { t } = env;
  const projection = state.projection;
  if (!projection) {
    return section({
      title: t('settings.usage.title', 'Usage'),
      body: [skeleton({ lines: 3, height: 14 })],
    });
  }
  const usage = projection.usage && typeof projection.usage === 'object' ? projection.usage : null;
  if (!usage || usage.available !== true) {
    return section({
      id: 'settings-models-usage',
      title: t('settings.usage.title', 'Usage'),
      note: t('settings.usage.ledger', 'The ledger has no writer in 0.0.1, so no cost numbers are shown.'),
      body: [
        banner(
          'info',
          t('settings.usage.unavailable', 'No usage records (reason: {reason}). A missing ledger is not “zero spend”.', {
            reason: String((usage && usage.reason) || 'NO_LEDGER'),
          }),
          t(
            'settings.usage.unavailable-hint',
            'Showing zero tokens or a zero bill here would be a claim the daemon cannot support.',
          ),
        ),
      ],
    });
  }

  const byProvider = asArray(usage.byProvider);
  const byTier = asArray(usage.byTier);
  return section({
    title: t('settings.usage.title', 'Usage'),
    note: t('settings.usage.note', 'Aggregated from the daemon ledger. A null price means “not configured”, never 0.'),
    body: [
      el('h3', { class: 'settings-section__title', text: t('settings.usage.by-provider', 'By provider') }),
      el(
        'div',
        { class: 'settings-kv' },
        byProvider.flatMap((entry) => [
          el('span', { class: 'settings-kv__key', text: String(entry.providerId || '—') }),
          el('span', {
            text:
              String(entry.inputTokens == null ? '—' : entry.inputTokens) +
              ' / ' +
              String(entry.outputTokens == null ? '—' : entry.outputTokens) +
              ' · ' +
              (entry.estimatedCostUsd == null
                ? t('settings.usage.cost-unknown', '— no price configured')
                : String(entry.estimatedCostUsd)),
          }),
        ]),
      ),
      el('h3', { class: 'settings-section__title', text: t('settings.usage.by-tier', 'By tier') }),
      el(
        'div',
        { class: 'settings-kv' },
        byTier.flatMap((entry) => [
          el('span', { class: 'settings-kv__key', text: String(entry.tier || '—') }),
          el('span', { text: String(entry.totalTokens == null ? '—' : entry.totalTokens) }),
        ]),
      ),
      el('p', {
        class: 'faint',
        text: t('settings.usage.escalations', 'Escalations: {count}', { count: String(usage.escalations == null ? 0 : usage.escalations) }),
      }),
    ],
  });
}


