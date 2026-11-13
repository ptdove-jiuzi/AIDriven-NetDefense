/**
 * AIDriven NetDefense · WebUI v2 · Agent 对话组件（气泡 / 流式 / tool 卡 / 模型选择器）
 * B4 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §2.2（/models 投影）· §3（SSE 事件）
 *       §7.6（只用 B1 组件 + dom.js）· §7.7（零 innerHTML）· §7.8（a11y）· §12.1（已知边界文案）
 *
 * 设计要点：
 * - 流式只对**单个 text node** 追加数据（appendData），不重建 DOM；只在终态把累积文本
 *   一次性交给 markdown 渲染（一次替换，不是每帧重建）。
 * - 所有文案由调用方注入 `t(key, params)`，本文件不写死任何语言。
 * - 所有节点经 `dom.js` 的 `el()` 构造；tool 参数/结果用 `<pre>` + textContent。
 *
 * 导出：analyzeModels / deriveChatState / createModelSelect / createThread /
 *       createMessageView / createToolCard / createComposer / formatNumber / formatUsd
 */
import { el, icon } from './ui/dom.js';
import { button } from './ui/button.js';
import { badge } from './ui/badge.js';
import { renderMarkdown } from './markdown.js';

/** tier 默认选择顺序（任务要求：triage → watch → respond 中第一个可用） */
const TIER_ORDER = ['triage', 'watch', 'respond'];
const TIER_LIST = ['watch', 'triage', 'respond'];
const TOOL_STATE_TONE = { proposed: 'warn', approved: 'accent', denied: 'danger', result: 'ok' };
const DECISION_KEY = { approve: 'agent.approval.approve', deny: 'agent.approval.deny' };

export function formatNumber(value, locale) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  try {
    return new Intl.NumberFormat(locale || undefined).format(number);
  } catch (error) {
    return String(number);
  }
}

export function formatUsd(value, locale) {
  // null/未配置单价：绝不显示 0.00（合同 §6：pricing 为 null → estimatedCostUsd=null）
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(number);
  } catch (error) {
    return '$' + number.toFixed(6);
  }
}

function asText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** engine 状态：v1 可用引擎是 broker-host；harness 未就绪时如实给出 reason */
export function engineStatus(modelsData) {
  const engine = modelsData && typeof modelsData === 'object' ? modelsData.engine : null;
  if (!engine || typeof engine !== 'object') {
    // 老 daemon 没有 engine 字段：不误判为不可用（不阻塞既有功能）
    return { ok: true, known: false, selected: null, harnessAvailable: null, harnessReason: null };
  }
  const selected = typeof engine.selected === 'string' ? engine.selected : null;
  const harness = engine.harness && typeof engine.harness === 'object' ? engine.harness : {};
  const harnessAvailable = harness.available === true ? true : harness.available === false ? false : null;
  const harnessReason = harness.reason == null ? null : asText(harness.reason);
  if (selected === 'harness') {
    return { ok: harnessAvailable === true, known: true, selected, harnessAvailable, harnessReason };
  }
  if (selected === 'broker-host') {
    return { ok: true, known: true, selected, harnessAvailable, harnessReason };
  }
  if (selected === 'auto') {
    return { ok: harnessAvailable !== false, known: true, selected, harnessAvailable, harnessReason };
  }
  return { ok: harnessAvailable === true, known: true, selected, harnessAvailable, harnessReason };
}

/**
 * analyzeModels(modelsData) → 投影 + 每个模型的可用性判定
 * 可用（可发起 chat）= egressEnabled && provider.enabled && provider.hasCredential
 */
export function analyzeModels(modelsData) {
  const data = modelsData && typeof modelsData === 'object' ? modelsData : {};
  const providers = Array.isArray(data.providers) ? data.providers.filter((item) => item && typeof item.id === 'string') : [];
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const rawModels = Array.isArray(data.models) ? data.models : [];
  const egressEnabled = data.egressEnabled !== false;

  const models = rawModels
    .filter((model) => model && typeof model.id === 'string' && model.id)
    .map((model) => {
      const provider = providerById.get(model.providerId) || null;
      const hasCredential = Boolean(provider && provider.hasCredential === true);
      const providerEnabled = Boolean(provider) && provider.enabled !== false;
      const available = egressEnabled && providerEnabled && hasCredential;
      let blocked = null;
      if (!egressEnabled) blocked = 'EGRESS_DISABLED';
      else if (!provider) blocked = 'PROVIDER_UNKNOWN';
      else if (!providerEnabled) blocked = 'PROVIDER_DISABLED';
      else if (!hasCredential) blocked = 'CREDENTIAL_MISSING';
      return { model, provider, available, blocked, hasCredential, providerEnabled };
    });

  const byTier = { watch: [], triage: [], respond: [] };
  for (const entry of models) {
    const tier = typeof entry.model.tier === 'string' ? entry.model.tier : '';
    if (byTier[tier]) byTier[tier].push(entry);
  }
  const availableModels = models.filter((entry) => entry.available);
  let defaultModel = null;
  for (const tier of TIER_ORDER) {
    defaultModel = availableModels.find((entry) => entry.model.tier === tier) || null;
    if (defaultModel) break;
  }
  if (!defaultModel) defaultModel = availableModels[0] || null;

  return {
    egressEnabled,
    providers,
    models,
    availableModels,
    byTier,
    defaultModel,
    totalModels: models.length,
  };
}

/**
 * deriveChatState(modelsData) → {code, canChat, engine, analysis, defaultModelId}
 * code ∈ OK | ENGINE_UNAVAILABLE | MODELS_EMPTY | EGRESS_DISABLED | CREDENTIAL_MISSING | PROVIDER_DISABLED
 */
export function deriveChatState(modelsData) {
  const analysis = analyzeModels(modelsData);
  const engine = engineStatus(modelsData);
  let code = 'OK';
  if (!engine.ok) {
    code = 'ENGINE_UNAVAILABLE';
  } else if (!analysis.totalModels) {
    code = 'MODELS_EMPTY';
  } else if (!analysis.egressEnabled) {
    code = 'EGRESS_DISABLED';
  } else if (!analysis.availableModels.length) {
    code = analysis.models.some((entry) => entry.hasCredential) ? 'PROVIDER_DISABLED' : 'CREDENTIAL_MISSING';
  }
  return {
    code,
    canChat: code === 'OK',
    engine,
    analysis,
    models: analysis.models,
    availableModels: analysis.availableModels,
    tiers: analysis.byTier,
    defaultModelId: analysis.defaultModel ? analysis.defaultModel.model.id : '',
  };
}

function modelOptionLabel(entry, t) {
  const model = entry.model;
  const tier = t('agent.tier.' + (typeof model.tier === 'string' ? model.tier : 'watch'));
  const costClass = model.costClass == null ? '—' : asText(model.costClass);
  const maxIn = model.maxInputTokens == null ? '—' : formatNumber(model.maxInputTokens);
  const maxOut = model.maxOutputTokens == null ? '—' : formatNumber(model.maxOutputTokens);
  const keyState = entry.hasCredential ? t('agent.model.has-key') : t('agent.model.no-key');
  return [model.id, tier, costClass, maxIn + '/' + maxOut, keyState].join(' · ');
}

/**
 * createModelSelect({t, modelsData, value, onChange})
 * 原生 <select> + <optgroup> 按 tier 分组（B1 select() 不支持 optgroup，此处用 dom.js 组合同一 .ui-select 类）。
 * 返回 {root, select, analysis, value, disabled, setValue(id)}
 */
export function createModelSelect(options) {
  const opts = options == null ? {} : options;
  const t = typeof opts.t === 'function' ? opts.t : (key) => '[' + key + ']';
  const analysis = analyzeModels(opts.modelsData);
  const locale = opts.locale;

  const selectEl = el('select', { class: 'ui-select chat-models__select', 'aria-label': t('agent.model.aria') });
  if (!analysis.totalModels) {
    selectEl.appendChild(el('option', { value: '', disabled: true, text: t('agent.model.none') }));
  }
  for (const tier of TIER_LIST) {
    const group = analysis.byTier[tier];
    if (!group.length) continue;
    const optgroup = el('optgroup', { label: t('agent.tier.' + tier) });
    for (const entry of group) {
      optgroup.appendChild(
        el('option', {
          value: entry.model.id,
          disabled: !entry.available,
          text: modelOptionLabel(entry, t),
        }),
      );
    }
    selectEl.appendChild(optgroup);
  }

  const detail = el('span', { class: 'chat-models__detail faint' });

  function entryFor(idValue) {
    return analysis.models.find((entry) => entry.model.id === idValue) || null;
  }

  function renderDetail() {
    const entry = entryFor(selectEl.value);
    if (!entry) {
      detail.textContent = '';
      return;
    }
    const model = entry.model;
    const parts = [];
    parts.push(t('agent.model.max-tokens', {
      maxIn: model.maxInputTokens == null ? '—' : formatNumber(model.maxInputTokens, locale),
      maxOut: model.maxOutputTokens == null ? '—' : formatNumber(model.maxOutputTokens, locale),
    }));
    parts.push(model.costClass == null ? t('agent.model.cost-class-unknown') : t('agent.model.cost-class', { costClass: asText(model.costClass) }));
    parts.push(entry.hasCredential ? t('agent.model.has-key') : t('agent.model.no-key'));
    if (!entry.available && entry.blocked) {
      // key 全小写 kebab（合同 §8.3 新规则）：CREDENTIAL_MISSING → agent.model.blocked.credential-missing
      const blockedKey = String(entry.blocked).toLowerCase().replace(/_/g, '-');
      parts.push(t('agent.model.blocked.' + blockedKey));
    }
    detail.textContent = parts.join(' · ');
  }

  const initial = opts.value == null ? '' : String(opts.value);
  const hasInitial = Boolean(entryFor(initial));
  if (hasInitial) selectEl.value = initial;
  else if (analysis.defaultModel) selectEl.value = analysis.defaultModel.model.id;
  else selectEl.value = '';
  selectEl.disabled = analysis.availableModels.length === 0;
  renderDetail();

  selectEl.addEventListener('change', () => {
    renderDetail();
    if (typeof opts.onChange === 'function') opts.onChange(selectEl.value);
  });

  const root = el('div', { class: 'cluster chat-models' }, [
    el('span', { class: 'chat-models__label faint', text: t('agent.model.label') }),
    selectEl,
    detail,
  ]);

  return {
    root,
    select: selectEl,
    analysis,
    get value() {
      return selectEl.value;
    },
    get disabled() {
      return selectEl.disabled;
    },
    setValue(idValue) {
      if (entryFor(String(idValue))) {
        selectEl.value = String(idValue);
        renderDetail();
      }
    },
    destroy() {
      root.remove();
    },
  };
}

/** 把任意值转成 <pre> 里的文本（对象走 JSON.stringify，字符串原样） */
export function stringifyToolValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

/** 参数摘要单行预览的最大字符数（超出截断，完整值在展开后的 <pre> 里）。 */
const TOOL_PREVIEW_CHARS = 72;
/** 展开后 <pre> 的最大字符数（超长工具结果不整棵塞进 DOM）。 */
const TOOL_PRE_MAX_CHARS = 4000;
let toolCardSeq = 0;

function toSingleLine(value, max) {
  const text = stringifyToolValue(value).replace(/\s+/gu, ' ').trim();
  if (!text) return '';
  if (!Number.isFinite(max) || text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * createToolCard(tool, t) → {root, update(tool), collapse(), expand(), isOpen()}
 *
 * 折叠卡片：**原生 <button aria-expanded aria-controls>** + 受控 region（键盘 Tab 可达，
 * Enter/Space 切换）。默认收起；摘要行显示工具名 / 参数摘要 / 状态色 / 决策与耗时；
 * 长值在摘要行截断、在展开区再按 TOOL_PRE_MAX_CHARS 截断并显式标注"已截断"。
 */
export function createToolCard(tool, t) {
  const translate = typeof t === 'function' ? t : (key) => '[' + key + ']';
  let current = { state: 'proposed', ...(tool || {}) };
  toolCardSeq += 1;
  const bodyId = 'chat-tool-body-' + toolCardSeq;

  const summary = el('span', { class: 'chat-tool__summary' });
  const hint = el('span', { class: 'chat-tool__hint faint nowrap' });
  const toggle = el('button', {
    type: 'button',
    class: 'chat-tool__toggle',
    'aria-expanded': 'false',
    'aria-controls': bodyId,
  });
  const body = el('div', {
    class: 'chat-tool__body stack',
    id: bodyId,
    role: 'region',
    hidden: true,
  });
  const root = el('div', { class: 'chat-tool', data: { state: 'proposed', open: 'false' } }, [toggle, body]);

  function setOpen(open) {
    const next = Boolean(open);
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    body.hidden = !next;
    root.setAttribute('data-open', next ? 'true' : 'false');
    hint.textContent = next ? translate('agent.tool.collapse', 'Hide details') : translate('agent.tool.expand', 'Show details');
  }

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  // 某些宿主把 <button> 的 Space 当滚动：显式处理一次，保证键盘切换一致。
  toggle.addEventListener('keydown', (event) => {
    if (event && (event.key === ' ' || event.key === 'Spacebar')) {
      event.preventDefault();
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    }
  });

  function resultPayload(state) {
    const payload = {};
    if (state.executed !== null && state.executed !== undefined) payload.executed = state.executed;
    if (state.reason != null) payload.reason = state.reason;
    if (state.result !== null && state.result !== undefined) payload.result = state.result;
    if (state.errorMessage) payload.error = state.errorMessage;
    return Object.keys(payload).length ? payload : null;
  }

  function jsonBlock(labelKey, labelFallback, value) {
    const parts = [el('h4', { class: 'chat-tool__heading', text: translate(labelKey, labelFallback) })];
    const raw = stringifyToolValue(value);
    if (raw.length > TOOL_PRE_MAX_CHARS) {
      parts.push(el('pre', { class: 'chat-tool__json mono', text: raw.slice(0, TOOL_PRE_MAX_CHARS) }));
      parts.push(
        el('p', {
          class: 'chat-tool__note faint',
          text: translate('agent.tool.truncated', '… truncated (the value has {total} characters in total)', {
            total: formatNumber(raw.length),
          }),
        }),
      );
    } else {
      parts.push(el('pre', { class: 'chat-tool__json mono', text: raw }));
    }
    return parts;
  }

  function render() {
    const state = current && typeof current === 'object' ? current : {};
    const stateName = typeof state.state === 'string' ? state.state : 'proposed';
    root.setAttribute('data-state', stateName);
    if (state.callId) root.setAttribute('data-call-id', String(state.callId));
    else root.removeAttribute('data-call-id');

    const name = state.name == null ? 'tool' : String(state.name);
    const summaryParts = [
      el('span', { class: 'chat-tool__chevron', 'aria-hidden': 'true' }, [icon('chevron-right')]),
      el('span', { class: 'chat-tool__name mono', text: name }),
      badge({
        tone: TOOL_STATE_TONE[stateName] || 'neutral',
        text: translate('agent.tool.state.' + stateName, stateName),
      }),
    ];
    if (state.arguments !== null && state.arguments !== undefined) {
      const preview = toSingleLine(state.arguments, TOOL_PREVIEW_CHARS);
      if (preview) summaryParts.push(el('span', { class: 'chat-tool__preview mono faint', text: preview }));
    }
    if (state.requiresApproval) {
      summaryParts.push(
        el('span', {
          class: 'chat-tool__flag faint nowrap',
          text: '· ' + translate('agent.tool.requires-approval', 'requires approval'),
        }),
      );
    }
    if (state.latencyMs != null) {
      summaryParts.push(
        el('span', {
          class: 'chat-tool__latency faint nowrap',
          text: '· ' + translate('agent.tool.latency', '{ms} ms', { ms: formatNumber(state.latencyMs) }),
        }),
      );
    }
    summary.replaceChildren(...summaryParts);
    toggle.replaceChildren(summary, hint);

    const bodyParts = [];
    if (state.arguments !== null && state.arguments !== undefined) {
      bodyParts.push(...jsonBlock('agent.tool.arguments', 'Arguments', state.arguments));
    }
    const payload = resultPayload(state);
    if (payload) {
      bodyParts.push(...jsonBlock('agent.tool.result', 'Result', payload));
    }
    if (state.decision) {
      bodyParts.push(
        el('p', {
          class: 'chat-tool__decision faint',
          text: translate('agent.tool.decision', 'Decision: {decision}', {
            decision: translate(DECISION_KEY[state.decision] || 'agent.approval.deny', state.decision),
          }),
        }),
      );
    }
    if (state.reason === 'EXECUTION_DISABLED' || state.disabledNotice) {
      bodyParts.push(
        el('p', {
          class: 'chat-tool__note',
          text: translate('agent.tool.execution-disabled', 'Response actions are not executed in this version.'),
        }),
      );
    }
    if (state.errorMessage) {
      bodyParts.push(el('p', { class: 'chat-tool__error', text: String(state.errorMessage) }));
    }
    body.replaceChildren(...bodyParts);
    setOpen(toggle.getAttribute('aria-expanded') === 'true');
  }

  render();

  return {
    root,
    update(next) {
      current = { ...current, ...(next || {}) };
      render();
    },
    get data() {
      return current;
    },
    isOpen() {
      return toggle.getAttribute('aria-expanded') === 'true';
    },
    collapse() {
      setOpen(false);
    },
    expand() {
      setOpen(true);
    },
  };
}

/**
 * createMessageView({message, t, locale, handlers})
 * handlers: {onStop, onRetry, onRegenerate}
 * 返回 {root, appendDelta, setContent, setStatus, setTools, setUsage, setError, update, message}
 */
export function createMessageView(options) {
  const opts = options == null ? {} : options;
  const t = typeof opts.t === 'function' ? opts.t : (key) => '[' + key + ']';
  const locale = opts.locale;
  const handlers = opts.handlers && typeof opts.handlers === 'object' ? opts.handlers : {};
  const message = opts.message && typeof opts.message === 'object' ? opts.message : {};
  const role = message.role === 'user' ? 'user' : 'assistant';

  const pendingEl = el('p', {
    class: 'chat-msg__pending faint',
    role: 'status',
    text: t('agent.stream.waiting', 'Request sent — waiting for the model to answer…'),
  });
  pendingEl.hidden = true;
  const textEl = el('div', { class: 'chat-msg__text' });
  const toolsEl = el('div', { class: 'chat-msg__tools stack' });
  const usageEl = el('div', { class: 'chat-msg__usage faint' });
  const noticeEl = el('div', { class: 'chat-msg__notice' });
  const actionsEl = el('div', { class: 'chat-msg__actions cluster' });
  const bubble = el('div', { class: 'chat-msg__bubble' }, [pendingEl, textEl, toolsEl, usageEl, noticeEl, actionsEl]);
  const root = el(
    'article',
    {
      class: 'chat-msg',
      data: { role },
      'data-status': 'done',
      'aria-label': role === 'user' ? t('agent.msg.user') : t('agent.msg.assistant'),
    },
    [
      el('div', { class: 'chat-msg__avatar', 'aria-hidden': 'true' }, [icon(role === 'user' ? 'user' : 'agent')]),
      el('div', { class: 'chat-msg__main' }, [bubble]),
    ],
  );

  const toolCards = new Map();
  let streamNode = null;
  let status = typeof message.status === 'string' ? message.status : 'done';
  let content = typeof message.content === 'string' ? message.content : '';
  let usage = message.usage || null;
  let error = message.error || null;
  let tools = Array.isArray(message.tools) ? message.tools.slice() : [];
  let totals = opts.totals && typeof opts.totals === 'object' ? opts.totals : null;

  function renderActions() {
    const nodes = [];
    if (status === 'streaming' && typeof handlers.onStop === 'function') {
      const stopButton = button({
        label: t('agent.action.stop', 'Stop'),
        ariaLabel: t('agent.action.stop-aria', 'Stop generating the reply'),
        variant: 'secondary',
        size: 'sm',
        icon: 'close',
        onClick: handlers.onStop,
      });
      stopButton.setAttribute('data-action', 'stop');
      nodes.push(stopButton);
    }
    if (role === 'assistant' && status !== 'streaming') {
      if (typeof handlers.onRegenerate === 'function' && content) {
        const regenerateButton = button({
          label: t('agent.action.regenerate', 'Regenerate'),
          ariaLabel: t('agent.action.regenerate-aria', 'Regenerate this reply from the same prompt'),
          variant: 'ghost',
          size: 'sm',
          icon: 'refresh',
          onClick: () => handlers.onRegenerate(),
        });
        regenerateButton.setAttribute('data-action', 'regenerate');
        nodes.push(regenerateButton);
      }
      if (status === 'error' || status === 'interrupted' || status === 'cancelled') {
        if (typeof handlers.onRetry === 'function') {
          const retryButton = button({
            label: t('agent.action.retry', 'Retry'),
            ariaLabel: t('agent.action.retry-aria', 'Retry this request'),
            variant: 'secondary',
            size: 'sm',
            icon: 'refresh',
            onClick: () => handlers.onRetry(),
          });
          retryButton.setAttribute('data-action', 'retry');
          nodes.push(retryButton);
        }
      }
    }
    actionsEl.replaceChildren(...nodes);
    actionsEl.hidden = nodes.length === 0;
  }

  function renderNotice() {
    noticeEl.replaceChildren();
    if (status === 'error' && error) {
      noticeEl.appendChild(
        el('div', { class: 'chat-msg__error', role: 'status' }, [
          el('div', { class: 'cluster' }, [
            badge({ tone: 'danger', text: t('agent.error.title') }),
            el('span', { class: 'mono faint', text: asText(error.code) || 'UNKNOWN' }),
          ]),
          el('p', { class: 'muted', text: asText(error.message) }),
          error.retryable ? el('p', { class: 'faint', text: t('agent.error.retryable') }) : null,
          error.action ? el('p', { class: 'faint mono', text: asText(error.action) }) : null,
        ]),
      );
      return;
    }
    if (status === 'interrupted') {
      noticeEl.appendChild(
        el('p', {
          class: 'chat-msg__interrupted muted',
          text: t('agent.status.interrupted', 'Generation stopped — the partial reply was kept.'),
          role: 'status',
        }),
      );
      return;
    }
    if (status === 'cancelled') {
      noticeEl.appendChild(
        el('p', {
          class: 'chat-msg__cancelled faint',
          text: t('agent.status.stopped', 'Generation stopped.'),
        }),
      );
    }
  }

  function knownTokenCount(value) {
    const prompt = Number(value.promptTokens);
    const completion = Number(value.completionTokens);
    const total = Number(value.totalTokens);
    if (Number.isFinite(total) && total > 0) return total;
    if (Number.isFinite(prompt) && prompt > 0) return prompt + (Number.isFinite(completion) && completion > 0 ? completion : 0);
    return null;
  }

  function renderUsage() {
    usageEl.replaceChildren();
    if (!usage || role !== 'assistant') {
      usageEl.hidden = true;
      return;
    }
    usageEl.hidden = false;
    // 未知就显示"—"：绝不把"不知道"渲染成 0 或 $0.00（合同 §6：pricing=null → estimatedCostUsd=null）
    const total = knownTokenCount(usage);
    const parts = [
      el('span', {
        class: 'chat-msg__tokens nowrap',
        text: t('agent.usage.tokens', '{count} tokens', { count: total == null ? '—' : formatNumber(total, locale) }),
        title:
          usage.promptTokens == null && usage.completionTokens == null
            ? ''
            : 'prompt ' +
              formatNumber(usage.promptTokens, locale) +
              ' / completion ' +
              formatNumber(usage.completionTokens, locale),
      }),
    ];
    if (usage.estimatedCostUsd == null) {
      parts.push(
        el('span', {
          class: 'chat-msg__cost nowrap',
          text: '· ' + t('agent.usage.cost-unknown', 'cost unknown'),
        }),
      );
    } else {
      parts.push(
        el('span', {
          class: 'chat-msg__cost nowrap',
          text: '· ' + t('agent.usage.cost', '{cost}', { cost: formatUsd(usage.estimatedCostUsd, locale) }),
        }),
      );
    }
    if (totals && totals.usageCount > 0) {
      const cumulativeTokens = totals.totalTokens > 0 ? formatNumber(totals.totalTokens, locale) : '—';
      const cumulativeCost = totals.costKnown
        ? t('agent.usage.cost', '{cost}', { cost: formatUsd(totals.costUsd, locale) })
        : t('agent.usage.cost-unknown', 'cost unknown');
      parts.push(
        el('span', {
          class: 'chat-msg__cumulative nowrap',
          text:
            '· ' +
            t('agent.usage.cumulative', '{tokens} tokens · {cost} in this conversation', {
              tokens: cumulativeTokens,
              cost: cumulativeCost,
            }),
        }),
      );
    }
    usageEl.replaceChildren(...parts);
  }

  function renderTools() {
    const seen = new Set();
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue;
      const callId = asText(tool.callId);
      if (!callId) continue;
      seen.add(callId);
      const existing = toolCards.get(callId);
      if (existing) {
        existing.update(tool);
      } else {
        const card = createToolCard(tool, t);
        toolCards.set(callId, card);
        toolsEl.appendChild(card.root);
      }
    }
    for (const [callId, card] of Array.from(toolCards.entries())) {
      if (seen.has(callId)) continue;
      card.root.remove();
      toolCards.delete(callId);
    }
    toolsEl.hidden = tools.length === 0;
  }

  function applyStatus(next) {
    status = typeof next === 'string' ? next : 'done';
    root.setAttribute('data-status', status);
    // 流式但一个字都还没收到时，只显示"请求已发出"的静态说明（无动画、不伪造内容）
    pendingEl.hidden = !(status === 'streaming' && content.trim() === '');
    renderActions();
    renderNotice();
  }

  // 初始渲染
  if (content) textEl.replaceChildren(renderMarkdown(content));
  renderTools();
  renderUsage();
  applyStatus(status);

  return {
    root,
    message,
    get status() {
      return status;
    },
    /** 流式增量：只 appendData 到同一个 text node，绝不重建整棵 DOM */
    appendDelta(chunk) {
      const piece = asText(chunk);
      if (!piece) return;
      content += piece;
      pendingEl.hidden = true;
      if (!streamNode) {
        textEl.replaceChildren();
        streamNode = document.createTextNode('');
        textEl.appendChild(streamNode);
      }
      // 真浏览器走 CharacterData.appendData（不重建 DOM）；无该 API 的极简 DOM 夹具退化为追加 data。
      if (typeof streamNode.appendData === 'function') streamNode.appendData(piece);
      else streamNode.data = String(streamNode.data == null ? '' : streamNode.data) + piece;
    },
    /** 终态：一次性 markdown 渲染（单次替换，不是每帧） */
    setContent(nextContent) {
      content = asText(nextContent);
      streamNode = null;
      textEl.replaceChildren(renderMarkdown(content));
    },
    setStatus: applyStatus,
    setTools(nextTools) {
      tools = Array.isArray(nextTools) ? nextTools.slice() : [];
      renderTools();
    },
    setUsage(nextUsage, nextTotals) {
      usage = nextUsage || null;
      if (nextTotals !== undefined) totals = nextTotals;
      renderUsage();
    },
    setError(nextError) {
      error = nextError || null;
      renderNotice();
    },
    /** 全量同步（切换会话/终态）：一次替换内容 + 状态 + tool + usage */
    update(nextMessage, nextTotals) {
      const source = nextMessage && typeof nextMessage === 'object' ? nextMessage : {};
      if (source !== message) Object.assign(message, source);
      content = asText(source.content);
      tools = Array.isArray(source.tools) ? source.tools.slice() : [];
      usage = source.usage || null;
      error = source.error || null;
      if (nextTotals !== undefined) totals = nextTotals;
      streamNode = null;
      textEl.replaceChildren(renderMarkdown(content));
      renderTools();
      renderUsage();
      applyStatus(source.status);
    },
    destroy() {
      root.remove();
    },
  };
}

/** createThread({t, locale, handlers}) → 消息列表（role="log" + aria-live="polite"） */
export function createThread(options) {
  const opts = options == null ? {} : options;
  const t = typeof opts.t === 'function' ? opts.t : (key) => '[' + key + ']';
  const views = new Map();
  const root = el('div', {
    class: 'agent-thread__list',
    role: 'log',
    'aria-live': 'polite',
    'aria-relevant': 'additions text',
    'aria-label': t('agent.thread.aria'),
  });

  return {
    root,
    add(message, totals) {
      const view = createMessageView({
        message,
        t,
        locale: opts.locale,
        handlers: opts.handlersFor ? opts.handlersFor(message) : opts.handlers,
        totals: totals !== undefined ? totals : opts.totalsFor ? opts.totalsFor(message) : undefined,
      });
      views.set(message.id, view);
      root.appendChild(view.root);
      return view;
    },
    get(id) {
      return views.get(id) || null;
    },
    remove(id) {
      const view = views.get(id);
      if (!view) return false;
      view.root.remove();
      views.delete(id);
      return true;
    },
    clear() {
      root.replaceChildren();
      views.clear();
    },
    get size() {
      return views.size;
    },
    scrollToEnd() {
      try {
        root.scrollTop = root.scrollHeight;
      } catch (error) {
        /* 非滚动容器（无 CSS 高度约束）时忽略 */
      }
    },
    destroy() {
      root.replaceChildren();
      views.clear();
      root.remove();
    },
  };
}

/**
 * createComposer({t, disabled, onSubmit, onStop})
 * Enter 发送 / Shift+Enter 换行；输入框有 aria-label；发送中把发送按钮换成停止。
 *
 * 非 OK 态（disabled=true）时：textarea disabled + aria-disabled + aria-describedby 指向
 * 引导区；发送按钮 disabled；**界面上有一条可见的禁用原因**（不是只写 title）以及
 * “去配置”按钮（引导本身仍然可聚焦、可点击）。
 */
export function createComposer(options) {
  const opts = options == null ? {} : options;
  const t = typeof opts.t === 'function' ? opts.t : (key) => '[' + key + ']';
  let disabled = Boolean(opts.disabled);
  let busy = false;
  let composing = false;
  let blocked = null;
  let describedByIds = Array.isArray(opts.describedBy) ? opts.describedBy.filter(Boolean).map(String) : [];
  let blockedSeq = (createComposer.seq = (createComposer.seq || 0) + 1);
  const reasonId = 'agent-composer-blocked-' + blockedSeq;

  const textarea = el('textarea', {
    class: 'ui-textarea chat-composer__input',
    rows: 3,
    placeholder: t('agent.composer.placeholder', 'Ask about alerts, collectors or rules…'),
    'aria-label': t('agent.composer.aria', 'Message to the agent'),
    spellcheck: false,
    on: {
      compositionstart: () => {
        composing = true;
      },
      compositionend: () => {
        composing = false;
      },
      keydown: (event) => {
        if (event.key !== 'Enter' || event.shiftKey || composing || event.isComposing) return;
        event.preventDefault();
        submit();
      },
    },
  });
  textarea.setAttribute('data-role', 'composer-input');

  const blockedText = el('span', { class: 'chat-composer__blocked-text' });
  const blockedAction = button({
    label: t('agent.composer.blocked-action', 'Configure now'),
    variant: 'secondary',
    size: 'sm',
    onClick: () => {
      if (blocked && typeof blocked.onAction === 'function') blocked.onAction();
    },
  });
  blockedAction.setAttribute('data-action', 'composer-configure');
  const blockedEl = el(
    'p',
    {
      class: 'chat-composer__blocked',
      id: reasonId,
      role: 'status',
      data: { 'composer-blocked': 'true' },
    },
    [blockedText, blockedAction],
  );
  blockedEl.hidden = true;

  const sendButton = button({
    label: t('agent.action.send', 'Send'),
    variant: 'primary',
    icon: 'agent',
    onClick: () => submit(),
  });
  const stopButton = button({
    label: t('agent.action.stop', 'Stop'),
    ariaLabel: t('agent.action.stop-aria', 'Stop generating the reply'),
    variant: 'secondary',
    icon: 'close',
    onClick: () => {
      if (typeof opts.onStop === 'function') opts.onStop();
    },
  });
  stopButton.hidden = true;
  sendButton.setAttribute('data-action', 'send');
  stopButton.setAttribute('data-action', 'stop');

  const hint = el('span', {
    class: 'chat-composer__hint faint',
    text: t('agent.composer.hint', 'Enter to send · Shift+Enter for a new line'),
  });
  const root = el(
    'form',
    {
      class: 'chat-composer stack',
      on: {
        submit: (event) => {
          event.preventDefault();
          submit();
        },
      },
    },
    [blockedEl, textarea, el('div', { class: 'cluster chat-composer__actions' }, [sendButton, stopButton, hint])],
  );

  function syncDescribedBy() {
    const ids = describedByIds.slice();
    if (blocked) ids.unshift(reasonId);
    if (ids.length === 0) textarea.removeAttribute('aria-describedby');
    else textarea.setAttribute('aria-describedby', ids.join(' '));
  }

  function refresh() {
    textarea.disabled = disabled;
    if (typeof root.setAttribute === 'function') root.setAttribute('data-blocked', disabled && blocked && blocked.text ? 'true' : 'false');
    sendButton.hidden = busy;
    stopButton.hidden = !busy;
    sendButton.disabled = disabled || busy;
    sendButton.setAttribute('aria-disabled', disabled || busy ? 'true' : 'false');
    stopButton.disabled = !busy;
    textarea.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    const isBlocked = disabled && blocked && blocked.text;
    blockedEl.hidden = !isBlocked;
    blockedAction.hidden = !(isBlocked && blocked && typeof blocked.onAction === 'function');
    hint.textContent = disabled
      ? t('agent.composer.hint-disabled', 'Nothing is sent while chat is unavailable — the steps above are the only way forward.')
      : t('agent.composer.hint', 'Enter to send · Shift+Enter for a new line');
    syncDescribedBy();
  }

  function submit() {
    if (disabled || busy) return;
    const value = String(textarea.value || '').trim();
    if (!value) return;
    textarea.value = '';
    if (typeof opts.onSubmit === 'function') opts.onSubmit(value);
  }

  refresh();

  return {
    root,
    textarea,
    sendButton,
    stopButton,
    blockedEl,
    onSubmit: submit,
    setValue(value) {
      textarea.value = value == null ? '' : String(value);
    },
    getValue() {
      return String(textarea.value || '');
    },
    setDisabled(next) {
      disabled = Boolean(next);
      refresh();
    },
    setBusy(next) {
      busy = Boolean(next);
      refresh();
    },
    setPlaceholder(value) {
      textarea.placeholder = asText(value);
    },
    /**
     * setBlocked({text, onAction}) — 非 OK 态的可见禁用原因；text 为空即隐藏。
     * 传 null 清除；action 按钮只在有 onAction 时出现（仍然可聚焦、可点击）。
     */
    setBlocked(next) {
      if (!next || typeof next !== 'object') {
        blocked = null;
        blockedText.textContent = '';
      } else {
        blocked = {
          text: asText(next.text),
          onAction: typeof next.onAction === 'function' ? next.onAction : null,
        };
        blockedText.textContent = blocked.text;
        if (next.actionLabel) {
          const labelNode = typeof blockedAction.querySelector === 'function' ? blockedAction.querySelector('.ui-btn__label') : null;
          if (labelNode) labelNode.textContent = String(next.actionLabel);
          else blockedAction.textContent = String(next.actionLabel);
        }
      }
      refresh();
    },
    /** 指向引导区（aria-describedby），按给定顺序拼接，空数组即移除。 */
    setDescribedBy(ids) {
      describedByIds = Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
      syncDescribedBy();
    },
    focus() {
      if (!disabled) textarea.focus();
    },
    destroy() {
      root.remove();
    },
  };
}
