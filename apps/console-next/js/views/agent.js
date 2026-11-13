/**
 * AIDriven NetDefense · WebUI v2 · Agent 对话视图
 * B4 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md
 *   §2.5 POST /api/v1/agent/chat（body 形状 / 消息上限 / sessionId 形状）
 *   §2.7 POST /api/v1/agent/approval（必须先弹审批再调接口）
 *   §3   SSE 事件（delta/tool/usage/done/error、seq 去重、终态保留文本、中断不自动重连）
 *   §6   settings.models.agent
 *   §7.2 视图签名 export async function mount(root, ctx) → { destroy() }
 *   §7.3 api 形状（getModels / openChat / approveTool）
 *   §7.5 localStorage['aidn.agent.sessions']（≤50 会话 × 200 条）
 *   §7.7 零 innerHTML · §7.8 a11y · §12.1 已知边界（harness 未就绪 / EXECUTION_DISABLED）
 *
 * 依赖边界：只调用 `ctx.api` / `ctx.i18n` / `ctx.navigate` / `ctx.toast` 与 B1 组件；
 * 不 import `js/{app,router,store,api,sse,i18n,util}.js`（B2 所有）。
 */
import { el, icon } from '../components/ui/dom.js';
import { button } from '../components/ui/button.js';
import { empty } from '../components/ui/empty.js';
import { modal } from '../components/ui/modal.js';
import { createThread, createComposer, createModelSelect, deriveChatState, stringifyToolValue, formatNumber, formatUsd } from '../components/chat.js';
import { createSessionStore, newMessageId } from '../agent/sessions.js';

/**
 * 六态三步引导（新增文案的 key 一律落 apps/console-next/i18n/_pending/agent.json，
 * 由 T3 合并进 locales；合并前用 t(key, EnglishFallback) 的第二参数兜底，
 * 界面上不出现 [missing:...]）。
 *
 * 每态结构：[0] 去哪配 · [1] 配哪个（provider/模型/档位）· [2] 怎么验证。
 */
const SETTINGS_MODELS_HASH = '#/settings?group=models';
const SETTINGS_MODELS_TEST_HASH = '#/settings?group=models&focus=test';
const GUIDE_ID = 'agent-chat-guide';

const STEP_TITLES = [
  ['agent.guide.step.go.title', 'Where to configure'],
  ['agent.guide.step.choose.title', 'Which provider and model'],
  ['agent.guide.step.verify.title', 'How to verify'],
];

const GUIDE_CONTENT = {
  ENGINE_UNAVAILABLE: {
    icon: 'models',
    title: ['agent.guide.engine.title', 'No chat engine yet'],
    lead: [
      'agent.guide.engine.body',
      'The daemon has no chat engine configured. Model providers alone are not enough — the broker host must be running.',
    ],
    steps: [
      [
        'agent.guide.engine.step1',
        'Open Settings → Models. The models group holds the engine, providers and models in one place.',
      ],
      [
        'agent.guide.engine.step2',
        'Choose the chat engine: broker-host talks to a configured provider; harness needs a staged harness profile. Current state: {reason}.',
      ],
      [
        'agent.guide.engine.step3',
        'Save, press “Test connection” on the provider, and come back here once it reports success — then reload the model list.',
      ],
    ],
  },
  MODELS_EMPTY: {
    icon: 'models',
    title: ['agent.guide.models.title', 'No model registered'],
    lead: ['agent.guide.models.body', 'Register at least one model before chatting. The model list comes from the settings schema.'],
    steps: [
      ['agent.guide.models.step1', 'Open Settings → Models and add a provider (kind “openai-compatible”, plus its base URL).'],
      ['agent.guide.models.step2', 'Register at least one model on that provider and map it to a tier. {tiers}'],
      [
        'agent.guide.models.step3',
        'Save the API key → press “Test connection” → come back here once it succeeds; the model appears in the list above.',
      ],
    ],
  },
  EGRESS_DISABLED: {
    icon: 'globe',
    title: ['agent.guide.egress.title', 'Outbound egress is off'],
    lead: [
      'agent.guide.egress.body',
      'Outbound model access is disabled, so no request can leave this machine. Turn egress on first.',
    ],
    steps: [
      [
        'agent.guide.egress.step1',
        'Open Settings → Models and scroll to the Egress section. Outbound access is off by default (zero-outbound policy).',
      ],
      ['agent.guide.egress.step2', 'Turn on “Allow outbound provider requests”, then make sure the target provider is enabled and holds a key.'],
      [
        'agent.guide.egress.step3',
        'Save → press “Test connection”. With egress off the test is refused before any request leaves this machine; come back once it succeeds.',
      ],
    ],
  },
  CREDENTIAL_MISSING: {
    icon: 'key',
    title: ['agent.guide.credential.title', 'No API key stored'],
    lead: ['agent.guide.credential.body', 'The selected provider has no stored key. Save a key, or pick a local model.'],
    steps: [
      ['agent.guide.credential.step1', 'Open Settings → Models and find provider “{provider}”.'],
      ['agent.guide.credential.step2', 'Save an API key for “{provider}”. Model “{model}” is assigned to the {tier} tier. {tiers}'],
      ['agent.guide.credential.step3', 'Press “Save key”, then “Test connection”; come back here once the test reports success.'],
    ],
  },
  PROVIDER_DISABLED: {
    icon: 'sliders',
    title: ['agent.guide.provider.title', 'Provider disabled'],
    lead: ['agent.guide.provider.body', 'The provider behind this model is disabled. Enable it, or choose another model.'],
    steps: [
      ['agent.guide.provider.step1', 'Open Settings → Models and find provider “{provider}”.'],
      ['agent.guide.provider.step2', 'Enable “{provider}” — it already holds a key; model “{model}” ({tier} tier) becomes usable again.'],
      ['agent.guide.provider.step3', 'Save → press “Test connection” → come back here once the test reports success.'],
    ],
  },
};

/** 非 OK 态在输入框上显示的一句话原因（可见文本，不是 title）。 */
const STATE_LABELS = {
  ENGINE_UNAVAILABLE: ['agent.state.engine-unavailable', 'no chat engine'],
  MODELS_EMPTY: ['agent.state.models-empty', 'no model registered'],
  EGRESS_DISABLED: ['agent.state.egress-disabled', 'outbound access is off'],
  CREDENTIAL_MISSING: ['agent.state.credential-missing', 'no API key'],
  PROVIDER_DISABLED: ['agent.state.provider-disabled', 'provider disabled'],
};

/**
 * createTranslator(i18n) → t(key, fallback?, params?)
 *
 * 双参数形式（合同 §8 的兜底要求）：
 *   t('agent.guide.models.step1', 'Open Settings → Models…')      // 缺 key → 用英文兜底
 *   t('agent.guide.credential.step2', '…{provider}…', { provider })// 第三参数是占位符
 * 兼容旧调用 t(key, paramsObject)（chat.js 里大量这样用）；两者都不给时才渲染 [missing:key]。
 */
function createTranslator(i18n) {
  const source = i18n && typeof i18n.t === 'function' ? i18n : null;
  const MISSING_MARKER = '[missing:';

  function lookup(key) {
    if (!source) return undefined;
    try {
      return source.t(key);
    } catch (error) {
      return undefined;
    }
  }

  function interpolate(template, params) {
    if (!params || typeof params !== 'object') return template;
    let output = String(template);
    for (const name of Object.keys(params)) {
      output = output.split('{' + name + '}').join(String(params[name]));
    }
    return output;
  }

  return function translate(key, second, third) {
    const hasStringFallback = typeof second === 'string';
    const fallback = hasStringFallback ? second : '';
    const params = hasStringFallback
      ? third && typeof third === 'object'
        ? third
        : null
      : second && typeof second === 'object'
        ? second
        : null;
    const value = lookup(key);
    const missing = typeof value !== 'string' || value === '' || value.startsWith(MISSING_MARKER);
    if (missing) {
      if (!hasStringFallback) return MISSING_MARKER + key + ']';
      return interpolate(fallback, params);
    }
    return interpolate(value, params);
  };
}

// ---------- 视图内样式（scoped：全部选择器以 .agent-view 开头，不改共享 styles/**） ----------
const STYLE_ID = 'agent-view-styles';

const VIEW_STYLES = `
.agent-view { display: flex; flex-direction: column; gap: var(--sp-4); }
.agent-view .agent-view__hide { display: none !important; }
.agent-view .agent-thread { overflow: hidden; }
.agent-view .agent-thread__viewport { max-height: var(--agent-thread-max, 54vh); min-height: 160px; overflow-y: auto; padding: var(--sp-4); }
.agent-view .agent-thread__empty { margin-bottom: var(--sp-4); }
.agent-view .agent-empty { gap: var(--sp-2); }
.agent-view .agent-empty__examples { gap: var(--sp-2); }
.agent-view .agent-sessions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.agent-view .agent-session { display: flex; align-items: center; gap: var(--sp-1); }
.agent-view .agent-session[data-active="true"] { outline: 1px solid var(--c-accent); border-radius: var(--r-md); }
.agent-view .agent-models { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.agent-view .agent-notices { gap: var(--sp-3); }

/* ---- 三步引导 ---- */
.agent-view .agent-guide { border-left: 3px solid var(--c-accent); }
.agent-view .agent-guide[data-code="CREDENTIAL_MISSING"] { border-left-color: var(--c-warn); }
.agent-view .agent-guide[data-code="EGRESS_DISABLED"] { border-left-color: var(--c-warn); }
.agent-view .agent-guide[data-code="PROVIDER_DISABLED"] { border-left-color: var(--c-danger); }
.agent-view .agent-guide[data-code="ENGINE_UNAVAILABLE"] { border-left-color: var(--c-danger); }
.agent-view .agent-guide__head { display: flex; gap: var(--sp-3); align-items: flex-start; }
.agent-view .agent-guide__badge { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex: 0 0 32px; border-radius: var(--r-pill); background: var(--c-selected); color: var(--c-accent); }
.agent-view .agent-guide__head-text { display: flex; flex-direction: column; gap: var(--sp-1); }
.agent-view .agent-guide__title { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-semibold); }
.agent-view .agent-guide__lead { margin: 0; font-size: var(--fs-base); }
.agent-view .agent-guide__steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.agent-view .agent-guide__step { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3); border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-bg-elev); }
.agent-view .agent-guide__num { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: 0 0 24px; border-radius: var(--r-pill); background: var(--c-accent); color: var(--c-accent-contrast); font-size: var(--fs-sm); font-weight: var(--fw-semibold); }
.agent-view .agent-guide__step-body { display: flex; flex-direction: column; gap: var(--sp-1); }
.agent-view .agent-guide__step-title { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
.agent-view .agent-guide__step-text { margin: 0; font-size: var(--fs-base); color: var(--c-text-muted); line-height: var(--lh-relaxed); }
.agent-view .agent-guide__step-actions { margin-top: var(--sp-1); }
.agent-view .agent-guide__detail { margin-top: var(--sp-1); }
.agent-view .agent-guide__detail > summary { cursor: pointer; }

/* ---- 消息气泡 ---- */
.agent-view .agent-thread__list { display: flex; flex-direction: column; gap: var(--sp-4); }
.agent-view .chat-msg { display: flex; gap: var(--sp-3); align-items: flex-start; }
.agent-view .chat-msg[data-role="user"] { flex-direction: row-reverse; }
.agent-view .chat-msg__avatar { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: 0 0 28px; border-radius: var(--r-pill); background: var(--c-bg-elev); color: var(--c-text-muted); }
.agent-view .chat-msg[data-role="user"] .chat-msg__avatar { background: var(--c-selected); color: var(--c-accent); }
.agent-view .chat-msg__main { min-width: 0; max-width: min(78%, 760px); }
.agent-view .chat-msg__bubble { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-surface); }
.agent-view .chat-msg[data-role="user"] .chat-msg__bubble { background: var(--c-selected); border-color: var(--c-border-strong); }
.agent-view .chat-msg[data-status="error"] .chat-msg__bubble { border-color: var(--c-danger); }
.agent-view .chat-msg[data-status="interrupted"] .chat-msg__bubble { border-color: var(--c-warn); }
.agent-view .chat-msg__text { font-size: var(--fs-base); line-height: var(--lh-relaxed); overflow-wrap: anywhere; }
.agent-view .chat-msg__text .md-p { margin: 0 0 var(--sp-2); }
.agent-view .chat-msg__text .md-p:last-child { margin-bottom: 0; }
.agent-view .chat-msg__text .md-pre { overflow-x: auto; padding: var(--sp-3); border-radius: var(--r-md); background: var(--c-bg); border: 1px solid var(--c-border); }
.agent-view .chat-msg__pending { margin: 0; }
.agent-view .chat-msg__usage { display: flex; flex-wrap: wrap; gap: var(--sp-2); font-size: var(--fs-sm); }
.agent-view .chat-msg__notice { display: flex; flex-direction: column; gap: var(--sp-1); }
.agent-view .chat-msg__error { padding: var(--sp-2); border-radius: var(--r-md); border: 1px solid var(--c-danger); background: var(--c-bg-elev); }
.agent-view .chat-msg__actions { margin-top: var(--sp-1); }
.agent-view .chat-msg__tools { gap: var(--sp-2); }

/* ---- 工具调用折叠卡 ---- */
.agent-view .chat-tool { border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-bg-elev); }
.agent-view .chat-tool[data-state="proposed"] { border-left: 3px solid var(--c-warn); }
.agent-view .chat-tool[data-state="approved"] { border-left: 3px solid var(--c-accent); }
.agent-view .chat-tool[data-state="denied"] { border-left: 3px solid var(--c-danger); }
.agent-view .chat-tool[data-state="result"] { border-left: 3px solid var(--c-ok); }
.agent-view .chat-tool__toggle { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: var(--sp-2) var(--sp-3); background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--r-md); }
.agent-view .chat-tool__toggle:hover { background: var(--c-hover); }
.agent-view .chat-tool__toggle:focus-visible { outline: var(--focus-ring-w) solid var(--c-focus); outline-offset: var(--focus-ring-offset); }
.agent-view .chat-tool__chevron { display: inline-flex; transition: transform var(--dur-fast) var(--ease); }
.agent-view .chat-tool[data-open="true"] .chat-tool__chevron { transform: rotate(90deg); }
.agent-view .chat-tool__summary { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; flex-wrap: wrap; }
.agent-view .chat-tool__name { font-weight: var(--fw-semibold); }
.agent-view .chat-tool__preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
.agent-view .chat-tool__hint { margin-left: auto; }
.agent-view .chat-tool__body { padding: 0 var(--sp-3) var(--sp-3); gap: var(--sp-2); }
.agent-view .chat-tool__heading { margin: 0; font-size: var(--fs-sm); color: var(--c-text-muted); font-weight: var(--fw-medium); }
.agent-view .chat-tool__json { margin: 0; max-height: 260px; overflow: auto; padding: var(--sp-2); border-radius: var(--r-sm); background: var(--c-bg); border: 1px solid var(--c-border); font-size: var(--fs-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-view .chat-tool__note { margin: 0; font-size: var(--fs-sm); color: var(--c-text-muted); }
.agent-view .chat-tool__error { margin: 0; font-size: var(--fs-sm); color: var(--c-danger); }

/* ---- 会话累计用量条 ---- */
.agent-view .agent-stats { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--c-border); font-size: var(--fs-sm); color: var(--c-text-muted); }
.agent-view .agent-stats__label { font-weight: var(--fw-medium); color: var(--c-text); }

/* ---- 输入区 ---- */
.agent-view .chat-composer { gap: var(--sp-2); }
.agent-view .chat-composer[data-blocked="true"] .chat-composer__input { min-height: 60px; }
.agent-view .chat-composer__input { width: 100%; resize: vertical; min-height: 72px; }
.agent-view .chat-composer__blocked { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); border: 1px solid var(--c-warn); background: var(--c-bg-elev); font-size: var(--fs-base); }
.agent-view .chat-composer__blocked-text { color: var(--c-text); }
.agent-view .chat-composer__actions { align-items: center; }
`;

function ensureStyles() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.setAttribute('id', STYLE_ID);
    style.textContent = VIEW_STYLES;
    document.head.appendChild(style);
  } catch (error) {
    /* 样式注入失败不应阻断视图 */
  }
}

function removeStyles() {
  try {
    if (typeof document === 'undefined') return;
    const node = document.getElementById(STYLE_ID);
    if (node) node.remove();
  } catch (error) {
    /* ignore */
  }
}

function readSessionParam(context) {
  const params = context.params;
  if (params && typeof params === 'object') {
    if (typeof params.session === 'string' && params.session) return params.session;
    // B2 也可能传 URLSearchParams（合同只写 params，未规定具体类型）
    if (typeof params.get === 'function') {
      const fromSearch = params.get('session');
      if (typeof fromSearch === 'string' && fromSearch) return fromSearch;
    }
  }
  let hash = '';
  try {
    hash = typeof context.hash === 'string' ? context.hash : typeof location !== 'undefined' ? location.hash : '';
  } catch (error) {
    hash = '';
  }
  const match = /[?&]session=([^&#]+)/.exec(hash || '');
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (error) {
    return '';
  }
}

function normalizeApiError(error) {
  if (!error) return { code: 'UNKNOWN', message: '', retryable: false, action: null };
  if (typeof error === 'string') return { code: 'UNKNOWN', message: error, retryable: false, action: null };
  return {
    code: error.code == null ? 'UNKNOWN' : String(error.code),
    message: error.message == null ? '' : String(error.message),
    retryable: Boolean(error.retryable),
    action: error.action == null ? null : String(error.action),
  };
}

/** 把 ctx.api.openChat 的推送载荷归一化成 {type, data, seq, text}（容忍 B2 的几种合理形状） */
export function normalizeChatEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  let type = '';
  let data = payload;
  if (payload.event && typeof payload.event === 'object' && typeof payload.event.type === 'string') {
    type = payload.event.type;
    data = payload.event;
  } else if (typeof payload.type === 'string') {
    type = payload.type;
    data = payload;
  } else if (typeof payload.event === 'string') {
    type = payload.event;
    data = payload.data !== undefined && payload.data !== null ? payload.data : payload;
  } else if (typeof payload.name === 'string') {
    type = payload.name;
    data = payload.data !== undefined && payload.data !== null ? payload.data : payload;
  } else {
    return null;
  }
  // B2 可能把 SSE 的 data 字段（JSON 文本）原样透传：这里兜底解析，避免丢事件
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (error) {
      data = {};
    }
  }
  if (!data || typeof data !== 'object') data = {};
  const numericSeq = data.seq != null ? Number(data.seq) : NaN;
  const seq = Number.isFinite(numericSeq) ? numericSeq : null;
  const text = typeof data.text === 'string' ? data.text : typeof data.delta === 'string' ? data.delta : '';
  return { type, data, seq, text };
}

function accumulateUsage(target, usage) {
  if (!target || !usage) return target;
  target.usageCount += 1;
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total > 0) target.totalTokens += total;
  if (usage.estimatedCostUsd == null) target.costKnown = false;
  else if (Number.isFinite(Number(usage.estimatedCostUsd))) target.costUsd += Number(usage.estimatedCostUsd);
  else target.costKnown = false;
  return target;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * mount(root, ctx) → { destroy() }
 * ctx = {api, i18n, params, navigate, toast, store?}（合同 §7.2）；
 * 另支持可选 `ctx.storage`（getItem/setItem/removeItem）供测试注入，生产不传即用 localStorage。
 */
export async function mount(root, ctx) {
  if (!root || typeof root.appendChild !== 'function') {
    return { destroy() {} };
  }
  const controller = createAgentController(root, ctx && typeof ctx === 'object' ? ctx : {});
  await controller.start();
  return { destroy: () => controller.destroy() };
}

function createAgentController(root, context) {
  const t = createTranslator(context.i18n);
  const locale = (context.i18n && (context.i18n.locale || context.i18n.lang)) || context.locale || 'zh-CN';
  const store = createSessionStore({ storage: context.storage });

  const state = {
    destroyed: false,
    sessionId: '',
    modelsData: null,
    modelsError: null,
    modelsLoading: false,
    chatState: deriveChatState(null),
    selectedModelId: '',
    busy: false,
    stream: null,
    approvalQueue: [],
    approvalOpen: false,
    approvalOverlay: null,
    approvalQueued: new Set(),
    modelSelect: null,
    /** 当前渲染出来的引导区 code（空串=没有引导），用于 aria-describedby */
    guideCode: '',
  };

  // ---------- DOM 骨架（全部经 dom.js 构造） ----------
  const noticesEl = el('div', { class: 'agent-notices stack' });
  const modelBarEl = el('div', { class: 'agent-models' });
  const sessionBarEl = el('div', {
    class: 'agent-sessions',
    role: 'group',
    'aria-label': t('agent.sessions.aria'),
  });
  const emptySlot = el('div', { class: 'agent-thread__empty' });
  // 会话级累计用量（sessions.js 的 totals）：未知就显示"—"，绝不显示 0 或 $0.00
  const statsEl = el('div', { class: 'agent-stats', 'data-role': 'session-stats' });

  const thread = createThread({
    t,
    locale,
    handlersFor: (message) => ({
      onStop: () => stopGeneration(),
      onRetry: () => retryFrom(message.id),
      onRegenerate: () => regenerateFrom(message.id),
    }),
  });

  const composer = createComposer({
    t,
    disabled: true,
    onSubmit: (text) => sendUserMessage(text),
    onStop: () => stopGeneration(),
  });

  const newSessionButton = button({
    label: t('agent.session.new'),
    variant: 'primary',
    icon: 'plus',
    onClick: () => createSession(),
  });
  newSessionButton.setAttribute('data-action', 'new-session');
  const refreshModelsButton = button({
    icon: 'refresh',
    variant: 'ghost',
    ariaLabel: t('agent.model.refresh'),
    title: t('agent.model.refresh'),
    onClick: () => loadModels(),
  });
  refreshModelsButton.setAttribute('data-action', 'refresh-models');

  const pageHead = el('header', { class: 'page-head' }, [
    el('div', { class: 'page-head__text' }, [
      el('h1', { class: 'page-head__title', text: t('agent.title') }),
      el('p', { class: 'page-head__sub', text: t('agent.subtitle') }),
    ]),
    el('div', { class: 'page-head__actions' }, [modelBarEl, refreshModelsButton, newSessionButton]),
  ]);

  const threadBox = el('section', { class: 'agent-thread ui-card' }, [
    // 统计条放进滚动区：聊天页的首屏留给"引导 + composer"，用量是会话内容的一部分
    el('div', { class: 'agent-thread__viewport ui-card__body' }, [statsEl, emptySlot, thread.root]),
  ]);

  const layout = el('div', { class: 'agent-view stack' }, [pageHead, noticesEl, sessionBarEl, threadBox, composer.root]);

  // ---------- 工具 ----------
  function requireApi() {
    const api = context.api;
    if (!api || typeof api !== 'object') {
      const error = new Error('api unavailable');
      error.code = 'API_UNAVAILABLE';
      throw error;
    }
    return api;
  }

  function showToast(kind, text) {
    try {
      if (context.toast && typeof context.toast.show === 'function') context.toast.show({ kind, text });
      else if (typeof context.toast === 'function') context.toast({ kind, text });
    } catch (error) {
      /* toast 不可用不影响功能 */
    }
  }

  function navigateTo(hash) {
    if (typeof context.navigate === 'function') {
      try {
        context.navigate(hash);
        return;
      } catch (error) {
        /* 落回 location.hash */
      }
    }
    try {
      if (typeof location !== 'undefined') location.hash = hash;
    } catch (error) {
      /* file:// 等场景降级：不阻塞 */
    }
  }

  function syncHash(sessionId) {
    if (!sessionId) return;
    let locationObject = null;
    try {
      locationObject = typeof location !== 'undefined' ? location : null;
    } catch (error) {
      locationObject = null;
    }
    if (!locationObject) return;
    const next = '#/agent?session=' + encodeURIComponent(sessionId);
    if (locationObject.hash === next) return;
    try {
      if (typeof history !== 'undefined' && history && typeof history.replaceState === 'function') {
        history.replaceState(null, '', next);
        return;
      }
    } catch (error) {
      /* file:// 下 replaceState 被拒，落回 location.hash */
    }
    try {
      locationObject.hash = next;
    } catch (error) {
      /* URL 同步降级：功能不受影响 */
    }
  }

  function sessionMessages() {
    const session = store.get(state.sessionId);
    return session ? session.messages : [];
  }

  function findMessage(sessionId, messageId) {
    const session = store.get(sessionId);
    if (!session) return null;
    return session.messages.find((message) => message.id === messageId) || null;
  }

  // ---------- 会话 ----------
  function renderSessions() {
    const sessions = store.list();
    const nodes = sessions.map((session) => {
      const active = session.id === state.sessionId;
      const selectButton = button({
        label: session.title || t('agent.session.untitled'),
        variant: active ? 'primary' : 'ghost',
        size: 'sm',
        onClick: () => selectSession(session.id),
      });
      selectButton.setAttribute('data-session-id', session.id);
      selectButton.setAttribute('data-action', 'select-session');
      selectButton.setAttribute('aria-current', active ? 'page' : 'false');
      const deleteButton = button({
        icon: 'trash',
        variant: 'ghost',
        size: 'sm',
        ariaLabel: t('agent.session.delete'),
        title: t('agent.session.delete'),
        onClick: () => confirmDeleteSession(session),
      });
      deleteButton.setAttribute('data-action', 'delete-session');
      return el('div', { class: 'agent-session', data: { active: active ? 'true' : null } }, [selectButton, deleteButton]);
    });
    sessionBarEl.replaceChildren(...nodes);
  }

  function selectSession(sessionId) {
    if (!sessionId || sessionId === state.sessionId) return;
    if (state.stream) stopGeneration();
    if (!store.get(sessionId)) return;
    state.sessionId = sessionId;
    state.approvalQueue = [];
    state.approvalQueued.clear();
    renderSessions();
    renderThread();
    updateEmptyState();
    syncHash(sessionId);
    thread.scrollToEnd();
  }

  function createSession() {
    if (state.stream) stopGeneration();
    const session = store.create();
    state.sessionId = session.id;
    state.approvalQueue = [];
    state.approvalQueued.clear();
    renderSessions();
    renderThread();
    updateEmptyState();
    syncHash(session.id);
    composer.focus();
  }

  function confirmDeleteSession(session) {
    modal({
      title: t('agent.session.delete-title'),
      destructive: true,
      closeLabel: t('common.action.close'),
      body: el('div', { class: 'stack' }, [
        el('p', {
          class: 'muted',
          text: t('agent.session.delete-body', { title: session.title || t('agent.session.untitled') }),
        }),
        el('p', { class: 'mono faint', text: session.id }),
      ]),
      actions: [
        { label: t('common.action.cancel'), variant: 'secondary' },
        { label: t('common.action.delete'), variant: 'danger', onClick: () => performDeleteSession(session) },
      ],
    });
  }

  function performDeleteSession(session) {
    if (state.stream && state.stream.sessionId === session.id) stopGeneration();
    store.remove(session.id);
    if (state.sessionId === session.id) {
      const next = store.list()[0];
      state.sessionId = next ? next.id : store.create().id;
      state.approvalQueue = [];
      renderThread();
      updateEmptyState();
      syncHash(state.sessionId);
    }
    renderSessions();
    showToast('ok', t('agent.session.deleted'));
  }

  // ---------- 渲染 ----------
  function renderThread() {
    thread.clear();
    const session = store.get(state.sessionId);
    if (!session) {
      renderStats();
      return;
    }
    const running = { totalTokens: 0, costUsd: 0, costKnown: false, usageCount: 0 };
    for (const message of session.messages) {
      if (message.usage) accumulateUsage(running, message.usage);
      thread.add(message, running.usageCount ? { ...running } : null);
    }
    renderStats();
    thread.scrollToEnd();
  }

  /** 会话级累计（store.totals）：未知一律显示"—"，绝不显示 0 或 $0.00 */
  function renderStats() {
    const totals = typeof store.totals === 'function' ? store.totals(state.sessionId) : null;
    const messageCount = sessionMessages().length;
    const parts = [
      el('span', { class: 'agent-stats__label', text: t('agent.stats.label', 'This conversation') }),
    ];
    if (!totals || totals.usageCount === 0) {
      parts.push(el('span', { class: 'agent-stats__none faint', text: t('agent.stats.none', 'no usage recorded yet') }));
    } else {
      parts.push(
        el('span', {
          class: 'agent-stats__tokens nowrap',
          text: t('agent.stats.tokens', '{count} tokens', {
            count: totals.totalTokens > 0 ? formatNumber(totals.totalTokens, locale) : '—',
          }),
        }),
      );
      parts.push(
        el('span', {
          class: 'agent-stats__cost nowrap',
          text: t('agent.stats.cost', 'cost {cost}', {
            cost: totals.costKnown ? formatUsd(totals.costUsd, locale) : '—',
          }),
        }),
      );
    }
    parts.push(
      el('span', {
        class: 'agent-stats__messages nowrap faint',
        text: t('agent.stats.messages', '{count} messages', { count: formatNumber(messageCount, locale) }),
      }),
    );
    statsEl.replaceChildren(...parts);
  }

  function updateEmptyState() {
    const count = sessionMessages().length;
    // 引导态：即使有历史消息也保留引导（否则用户看不到"为什么不能输入"）；正常态：有消息就收起空态
    const guideVisible = state.chatState.canChat !== true && Boolean(state.guideCode);
    emptySlot.hidden = count > 0 && !guideVisible;
  }

  function refreshEmptyState() {
    emptySlot.replaceChildren();
    if (state.chatState.canChat !== true) {
      // 三步引导就是"不可用态"的空态：放在对话区，保证首屏同时看到引导与 composer 的禁用原因
      if (state.guideCode) emptySlot.appendChild(buildGuide(state.guideCode));
    } else {
      emptySlot.appendChild(buildEmptyState());
    }
    updateEmptyState();
    syncThreadHeight();
  }

  function buildEmptyState() {
    const exampleKeys = ['agent.example.1', 'agent.example.2', 'agent.example.3'];
    const examples = el('div', { class: 'agent-empty__examples stack' }, [
      el('p', { class: 'faint', text: t('agent.empty.examples', 'Try one of these') }),
      el(
        'div',
        { class: 'cluster' },
        exampleKeys.map((key, index) => {
          const label = t(key);
          const exampleButton = button({
            label,
            variant: 'ghost',
            size: 'sm',
            onClick: () => {
              composer.setValue(label);
              composer.focus();
            },
          });
          exampleButton.setAttribute('data-action', 'example');
          exampleButton.setAttribute('data-example', String(index + 1));
          return exampleButton;
        }),
      ),
    ]);
    return el('div', { class: 'agent-empty stack' }, [
      empty({ title: t('agent.empty.title'), body: t('agent.empty.body'), iconName: 'agent' }),
      examples,
    ]);
  }

  function renderModelBar() {
    modelBarEl.replaceChildren();
    if (state.modelsLoading) {
      modelBarEl.appendChild(el('span', { class: 'faint nowrap', text: t('agent.model.loading') }));
      return;
    }
    if (state.modelsError) {
      modelBarEl.appendChild(el('span', { class: 'faint nowrap', text: t('agent.model.load-failed') }));
      return;
    }
    if (!state.modelsData) return;
    const selector = createModelSelect({
      t,
      locale,
      modelsData: state.modelsData,
      value: state.selectedModelId,
      onChange: (modelId) => {
        state.selectedModelId = modelId;
      },
    });
    state.modelSelect = selector;
    if (!state.selectedModelId) state.selectedModelId = selector.value;
    modelBarEl.appendChild(selector.root);
  }

  /** 引导里要显示的 provider/模型/档位：优先取"被这个状态挡住的那个条目" */
  function guideParams(code) {
    const models = Array.isArray(state.chatState.models) ? state.chatState.models : [];
    let providerId = '';
    let modelId = '';
    let tier = '';
    if (code === 'CREDENTIAL_MISSING' || code === 'PROVIDER_DISABLED') {
      const entry = models.find((item) => item && item.blocked === code) || models[0] || null;
      if (entry) {
        if (entry.provider && typeof entry.provider.id === 'string') providerId = entry.provider.id;
        if (entry.model && typeof entry.model.id === 'string') modelId = entry.model.id;
        if (entry.model && typeof entry.model.tier === 'string') tier = entry.model.tier;
      }
    }
    const engine = state.chatState.engine || {};
    return {
      reason: engine.harnessReason || engine.selected || 'UNKNOWN',
      provider: providerId || t('agent.guide.unknown-provider', '(not registered)'),
      model: modelId || t('agent.guide.unknown-model', '(none)'),
      tier: tier ? t('agent.tier.' + tier, tier) : t('agent.guide.unknown-tier', 'not mapped'),
      tiers: t(
        'agent.guide.tiers',
        'Tiers: watch = routine checks (cheapest) · triage = suspicious alerts · respond = confirmed incidents (strongest).',
      ),
    };
  }

  /** 三步引导：1) 去哪配（真跳设置）2) 配哪个（provider/模型/档位）3) 怎么验证（测试连通） */
  function buildGuide(code) {
    const content = GUIDE_CONTENT[code] || GUIDE_CONTENT.MODELS_EMPTY;
    const params = guideParams(code);
    const titleId = GUIDE_ID + '-title';

    const steps = content.steps.map((step, index) => {
      const stepChildren = [
        el('span', { class: 'agent-guide__num', 'aria-hidden': 'true', text: String(index + 1) }),
        el('div', { class: 'agent-guide__step-body' }, [
          el('h3', { class: 'agent-guide__step-title', text: t(STEP_TITLES[index][0], STEP_TITLES[index][1]) }),
          el('p', { class: 'agent-guide__step-text', text: t(step[0], step[1], params) }),
          index === 0 || index === 2
            ? (() => {
                const isFirst = index === 0;
                const action = button({
                  label: isFirst
                    ? t('agent.guide.open-settings', 'Open model settings')
                    : t('agent.guide.open-test', 'Open settings and test'),
                  variant: isFirst ? 'secondary' : 'primary',
                  size: 'sm',
                  onClick: () => navigateTo(isFirst ? SETTINGS_MODELS_HASH : SETTINGS_MODELS_TEST_HASH),
                });
                action.setAttribute('data-action', isFirst ? 'guide-open-settings' : 'guide-open-test');
                action.setAttribute('data-step', String(index + 1));
                return el('div', { class: 'agent-guide__step-actions cluster' }, [action]);
              })()
            : null,
        ]),
      ];
      return el('li', { class: 'agent-guide__step', data: { step: String(index + 1) } }, stepChildren);
    });

    const engine = state.chatState.engine || {};
    const harnessState =
      engine.harnessAvailable === false ? 'false' : engine.harnessAvailable === true ? 'true' : 'unknown';

    return el(
      'section',
      {
        class: 'agent-guide ui-card',
        id: GUIDE_ID,
        role: 'status',
        'aria-labelledby': titleId,
        data: { code, 'guide': 'chat-unavailable' },
      },
      [
        el('div', { class: 'ui-card__body stack' }, [
          el('div', { class: 'agent-guide__head' }, [
            el('span', { class: 'agent-guide__badge', 'aria-hidden': 'true' }, [icon(content.icon || 'info', { size: 18 })]),
            el('div', { class: 'agent-guide__head-text' }, [
              el('h2', { class: 'agent-guide__title', id: titleId, text: t(content.title[0], content.title[1]) }),
              el('p', { class: 'agent-guide__lead muted', text: t(content.lead[0], content.lead[1], params) }),
            ]),
          ]),
          el('ol', { class: 'agent-guide__steps' }, steps),
          el('details', { class: 'agent-guide__detail' }, [
            el('summary', { class: 'faint', text: t('agent.guide.detail-label', 'Technical detail') }),
            el('p', {
              class: 'faint mono',
              text:
                'state=' +
                code +
                ' · engine.selected=' +
                (engine.selected || 'unknown') +
                ' · engine.harness.available=' +
                harnessState,
            }),
          ]),
        ]),
      ],
    );
  }

  function buildHarnessNotice() {
    const engine = state.chatState.engine;
    const reason = (engine && engine.harnessReason) || 'UNKNOWN';
    return el('p', { class: 'agent-note faint', role: 'status' }, [
      icon('info', { size: 14 }),
      el('span', { text: t('agent.engine.harness-notice', { reason }) }),
    ]);
  }

  function buildModelsErrorNotice(error) {
    const retryButton = button({
      label: t('common.action.retry'),
      variant: 'secondary',
      onClick: () => loadModels(),
    });
    retryButton.setAttribute('data-action', 'retry-models');
    return el('section', { class: 'agent-guide ui-card', role: 'status', data: { code: error.code || 'UNKNOWN' } }, [
      el('div', { class: 'ui-card__body stack' }, [
        el('h2', { class: 'agent-guide__title', text: t('agent.model.error-title') }),
        el('p', {
          class: 'muted',
          text: t('agent.model.error-body', { code: error.code || 'UNKNOWN', message: error.message || '' }),
        }),
        el('div', { class: 'cluster' }, [retryButton]),
      ]),
    ]);
  }

  function renderGuidance() {
    noticesEl.replaceChildren();
    state.guideCode = '';
    if (state.modelsError) {
      noticesEl.appendChild(buildModelsErrorNotice(state.modelsError));
      toggleHidden(sessionBarEl, true);
      return;
    }
    if (!state.modelsData) return;
    const canChat = state.chatState.canChat === true;
    // 不可用态：会话条上的"新建对话"没有任何作用（发了也没人处理），隐藏掉而不是留个死按钮
    toggleHidden(sessionBarEl, !canChat);
    if (!canChat) {
      // 三步引导由 refreshEmptyState 渲染进对话区（见该函数注释）；这里只记录 code 供 aria-describedby 使用
      state.guideCode = state.chatState.code;
      return;
    }
    if (state.chatState.engine && state.chatState.engine.harnessAvailable === false) {
      noticesEl.appendChild(buildHarnessNotice());
    }
  }

  /** class 级隐藏（hidden 属性会被 display:flex 之类的样式覆盖，class + CSS 才可靠） */
  function toggleHidden(node, hide) {
    if (!node || !node.classList || typeof node.classList.toggle !== 'function') return;
    node.classList.toggle('agent-view__hide', Boolean(hide));
  }

  function renderComposerState() {
    const canChat = state.chatState.canChat === true;
    composer.setDisabled(!canChat);
    composer.setBusy(state.busy);
    if (canChat) {
      composer.setPlaceholder(t('agent.composer.placeholder', 'Ask about alerts, collectors or rules…'));
      composer.setBlocked(null);
      composer.setDescribedBy([]);
      return;
    }
    composer.setPlaceholder(t('agent.composer.disabled', 'Chat is unavailable until a model is ready.'));
    const code = state.chatState.code;
    const label = STATE_LABELS[code] || STATE_LABELS.MODELS_EMPTY;
    const reason = state.modelsLoading ? t('agent.model.loading', 'Loading…') : t(label[0], label[1]);
    // 可见的禁用原因（不是只放 title）+ 一个仍然可点击的"去配置"按钮
    composer.setBlocked({
      text: t('agent.composer.blocked', 'Input disabled: {reason}', { reason }),
      actionLabel: t('agent.composer.blocked-action', 'Configure now'),
      onAction: () => navigateTo(SETTINGS_MODELS_HASH),
    });
    composer.setDescribedBy(state.guideCode ? [GUIDE_ID] : []);
  }

  // ---------- 模型 ----------
  async function loadModels() {
    if (state.destroyed) return;
    state.modelsLoading = true;
    state.modelsError = null;
    renderModelBar();
    renderComposerState();
    let nextData = null;
    let nextError = null;
    try {
      const api = requireApi();
      if (typeof api.getModels !== 'function') {
        const error = new Error('api.getModels unavailable');
        error.code = 'API_UNAVAILABLE';
        throw error;
      }
      nextData = await api.getModels();
    } catch (error) {
      nextError = normalizeApiError(error);
    }
    if (state.destroyed) return;
    state.modelsLoading = false;
    if (nextError) {
      state.modelsData = null;
      state.modelsError = nextError;
    } else {
      state.modelsData = nextData && typeof nextData === 'object' ? nextData : {};
      state.modelsError = null;
    }
    state.chatState = deriveChatState(state.modelsData);
    const availableIds = state.chatState.availableModels.map((entry) => entry.model.id);
    if (!state.selectedModelId || availableIds.indexOf(state.selectedModelId) < 0) {
      state.selectedModelId = state.chatState.defaultModelId || state.selectedModelId || '';
    }
    renderModelBar();
    renderGuidance();
    refreshEmptyState();
    renderComposerState();
    if (state.chatState.canChat && !state.busy) composer.focus();
  }

  // ---------- 发送 / 流式 ----------
  function buildChatBody(session, assistantMessageId) {
    const messages = [];
    for (const message of session.messages) {
      if (message.id === assistantMessageId) continue;
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      if (message.role === 'assistant' && message.status && message.status !== 'done' && message.status !== 'streaming') continue;
      const content = String(message.content == null ? '' : message.content).slice(0, 8000);
      if (!content.trim()) continue;
      messages.push({ role: message.role, content });
    }
    // 合同 §2.5：messages 1..40 条；首条必须是 user（服务端不接受 system）
    const trimmed = messages.slice(-40);
    while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
    return {
      sessionId: session.id,
      modelId: state.selectedModelId,
      locale,
      messages: trimmed,
    };
  }

  function sendUserMessage(text) {
    const content = String(text == null ? '' : text).trim();
    if (!content || state.busy || !state.chatState.canChat) return;
    const session = store.get(state.sessionId);
    if (!session || !state.selectedModelId) return;
    const stored = store.addMessage(session.id, {
      id: newMessageId(),
      role: 'user',
      content,
      status: 'done',
      createdAt: nowIso(),
      usage: null,
      error: null,
      tools: [],
    });
    if (!stored) return;
    thread.add(stored, null);
    store.setTitleFromFirstUserMessage(session.id, content);
    renderSessions();
    updateEmptyState();
    beginAssistant(store.get(session.id));
  }

  function beginAssistant(session) {
    if (!session || state.busy || state.destroyed) return;
    // 硬闸：非 OK 态（无 key / 无模型 / 出网关闭 / 供应商停用 / 引擎不可用）绝不发请求，
    // 也绝不插入空 assistant 气泡——界面上零"假装在回答"。
    if (state.chatState.canChat !== true) return;
    if (!state.selectedModelId) return;
    const stored = store.addMessage(session.id, {
      id: newMessageId(),
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: nowIso(),
      modelId: state.selectedModelId,
      usage: null,
      error: null,
      tools: [],
    });
    if (!stored) return;
    const view = thread.add(stored, null);
    state.busy = true;
    renderComposerState();
    updateEmptyState();
    thread.scrollToEnd();

    const stream = {
      sessionId: session.id,
      message: stored,
      view,
      handle: null,
      finalized: false,
      aborted: false,
      seqs: new Set(),
      unknownEvents: 0,
    };
    state.stream = stream;

    const body = buildChatBody(store.get(session.id), stored.id);
    try {
      const api = requireApi();
      if (typeof api.openChat !== 'function') {
        const error = new Error('api.openChat unavailable');
        error.code = 'API_UNAVAILABLE';
        throw error;
      }
      const handle = api.openChat(body, makeStreamHandlers(stream));
      stream.handle = handle && typeof handle === 'object' ? handle : null;
      if (stream.handle && stream.handle.done && typeof stream.handle.done.then === 'function') {
        stream.handle.done.then(
          () => {
            // 没有终态事件就结束 → 按"中断"处理：保留文本，给重试，不自动重连（合同 §3.3）
            if (!stream.finalized && !state.destroyed) finalizeStream(stream, 'interrupted');
          },
          (error) => {
            if (stream.finalized) return;
            stream.message.error = normalizeApiError(error);
            finalizeStream(stream, 'error');
          },
        );
      }
    } catch (error) {
      stream.message.error = normalizeApiError(error);
      finalizeStream(stream, 'error');
    }
  }

  function makeStreamHandlers(stream) {
    return {
      onEvent: (payload) => handleStreamEvent(stream, payload),
      onError: (error) => {
        if (!stream || stream.finalized) return;
        stream.message.error = normalizeApiError(error);
        finalizeStream(stream, 'error');
      },
      // api.openStream 的 done 结果带 terminal：'done' | 'error' | 'aborted' | 'interrupted'。
      // 只有真的收到 done 才算成功；半截断流一律 interrupted（保留已收文本，给重试，不自动重连）。
      onDone: (result) => {
        if (!stream || stream.finalized) return;
        const terminal = result && typeof result.terminal === 'string' ? result.terminal : '';
        if (terminal === 'error') {
          if (!stream.message.error) stream.message.error = normalizeApiError((result && result.error) || null);
          finalizeStream(stream, 'error');
          return;
        }
        if (terminal === 'aborted') {
          finalizeStream(stream, stream.aborted ? 'interrupted' : 'cancelled');
          return;
        }
        if (terminal === 'interrupted') {
          finalizeStream(stream, 'interrupted');
          return;
        }
        finalizeStream(stream, 'done');
      },
      onOpen: () => {
        /* 200 已建立；无 UI 副作用 */
      },
    };
  }

  function handleStreamEvent(stream, payload) {
    if (!stream || stream.finalized || state.destroyed) return;
    const event = normalizeChatEvent(payload);
    if (!event) return;
    if (event.seq != null) {
      if (stream.seqs.has(event.seq)) return; // seq 去重（乱序/重复不插重复文本）
      stream.seqs.add(event.seq);
    }
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    switch (event.type) {
      case 'delta': {
        if (!event.text) return;
        stream.message.content += event.text;
        stream.view.appendDelta(event.text);
        thread.scrollToEnd();
        return;
      }
      case 'tool': {
        applyToolEvent(stream, data);
        return;
      }
      case 'usage': {
        stream.message.usage = {
          promptTokens: data.promptTokens == null ? null : Number(data.promptTokens),
          completionTokens: data.completionTokens == null ? null : Number(data.completionTokens),
          totalTokens: data.totalTokens == null ? null : Number(data.totalTokens),
          estimatedCostUsd:
            data.estimatedCostUsd == null || !Number.isFinite(Number(data.estimatedCostUsd))
              ? null
              : Number(data.estimatedCostUsd),
          providerId: data.providerId == null ? null : String(data.providerId),
          modelId: data.modelId == null ? null : String(data.modelId),
          tier: data.tier == null ? null : String(data.tier),
        };
        stream.view.setUsage(stream.message.usage, store.totals(stream.sessionId));
        store.updateMessage(stream.sessionId, stream.message.id, { usage: stream.message.usage });
        return;
      }
      case 'done': {
        if (!stream.message.usage && data.totalTokens != null) {
          stream.message.usage = { promptTokens: null, completionTokens: null, totalTokens: Number(data.totalTokens), estimatedCostUsd: null, providerId: null, modelId: null, tier: null };
        }
        finalizeStream(stream, 'done');
        return;
      }
      case 'error': {
        stream.message.error = {
          code: data.code == null ? 'UNKNOWN' : String(data.code),
          message: data.message == null ? '' : String(data.message),
          retryable: Boolean(data.retryable),
          action: data.action == null ? null : String(data.action),
        };
        finalizeStream(stream, 'error');
        return;
      }
      default: {
        stream.unknownEvents += 1; // 未知事件名忽略但计数（合同 §3.1）
      }
    }
  }

  function applyToolEvent(stream, data) {
    const callId = String(data.callId == null ? '' : data.callId);
    if (!callId) return;
    const tools = Array.isArray(stream.message.tools) ? stream.message.tools : (stream.message.tools = []);
    let tool = tools.find((item) => item.callId === callId) || null;
    if (!tool) {
      tool = {
        callId,
        name: data.name == null ? null : String(data.name),
        arguments: data.arguments === undefined ? null : data.arguments,
        state: 'proposed',
        requiresApproval: Boolean(data.requiresApproval),
        decision: null,
        executed: null,
        reason: null,
        latencyMs: null,
        result: null,
        errorMessage: null,
      };
      tools.push(tool);
    } else {
      if (data.name != null) tool.name = String(data.name);
      if (data.arguments !== undefined) tool.arguments = data.arguments;
      if (data.requiresApproval != null) tool.requiresApproval = Boolean(data.requiresApproval);
    }
    const stateName = typeof data.state === 'string' && data.state ? data.state : tool.state || 'proposed';
    tool.state = stateName;
    if (data.latencyMs != null) tool.latencyMs = Number(data.latencyMs);
    if (data.executed !== undefined && data.executed !== null) tool.executed = Boolean(data.executed);
    if (data.reason != null) tool.reason = String(data.reason);
    if (data.decision != null) tool.decision = String(data.decision);
    if (stateName === 'approved') tool.decision = 'approve';
    if (stateName === 'denied' && !tool.decision) tool.decision = 'deny';
    if (data.result !== undefined) tool.result = data.result;
    if (tool.reason === 'EXECUTION_DISABLED') tool.disabledNotice = true;

    stream.view.setTools(tools);
    store.updateMessage(stream.sessionId, stream.message.id, { tools });

    if (tool.requiresApproval && stateName === 'proposed') {
      const key = stream.message.id + ':' + callId;
      if (!state.approvalQueued.has(key)) {
        state.approvalQueued.add(key);
        queueApproval({ sessionId: stream.sessionId, messageId: stream.message.id, callId });
      }
    }
  }

  function finalizeStream(stream, status) {
    if (!stream || stream.finalized) return;
    stream.finalized = true;
    // 显式终态优先；没有显式状态时才按 aborted 推断（用户在流式中点停止 → interrupted）
    const finalStatus =
      typeof status === 'string' && status !== '' ? status : stream.aborted ? 'interrupted' : 'done';
    stream.message.status = finalStatus;
    store.updateMessage(stream.sessionId, stream.message.id, {
      content: stream.message.content,
      status: finalStatus,
      usage: stream.message.usage,
      error: stream.message.error,
      tools: stream.message.tools,
    });
    // 终态：一次性 markdown 渲染 + usage/累计花费/动作按钮（单次替换，不是每帧重建）
    stream.view.update(stream.message, store.totals(stream.sessionId));
    if (state.stream === stream) state.stream = null;
    state.busy = false;
    renderComposerState();
    renderSessions();
    renderStats();
    thread.scrollToEnd();
  }

  function stopGeneration() {
    const stream = state.stream;
    if (!stream) return;
    stream.aborted = true;
    try {
      if (stream.handle && typeof stream.handle.abort === 'function') stream.handle.abort();
    } catch (error) {
      /* abort 失败也要本地收尾 */
    }
    // 停止 = 中断：保留已经收到的文本，标 interrupted（可重试），绝不自动重连
    finalizeStream(stream, 'interrupted');
  }

  /** 非 OK 态下点"重试/重新生成"：不发请求，只提示原因并把人引到引导区。 */
  function refuseWhenUnavailable() {
    if (state.chatState.canChat === true) return false;
    const code = state.chatState.code;
    const label = STATE_LABELS[code] || STATE_LABELS.MODELS_EMPTY;
    const reason = state.modelsLoading ? t('agent.model.loading', 'Loading…') : t(label[0], label[1]);
    showToast('warn', t('agent.composer.blocked', 'Input disabled: {reason}', { reason }));
    if (state.guideCode) {
      const guide = typeof layout.querySelector === 'function' ? layout.querySelector('[data-guide="chat-unavailable"]') : null;
      if (guide && typeof guide.focus === 'function') {
        if (!guide.hasAttribute('tabindex')) guide.setAttribute('tabindex', '-1');
        try {
          guide.focus();
        } catch (error) {
          /* 焦点移动失败不影响语义 */
        }
      }
    }
    return true;
  }

  function retryFrom(assistantMessageId) {
    if (state.busy) return;
    if (refuseWhenUnavailable()) return;
    const session = store.get(state.sessionId);
    if (!session) return;
    const index = session.messages.findIndex((message) => message.id === assistantMessageId);
    if (index < 0) return;
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (session.messages[i].role === 'user') {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    // 重发上一条用户提示：保留原失败消息（审计痕迹），追加一次新尝试
    beginAssistant(session);
  }

  function regenerateFrom(assistantMessageId) {
    if (state.busy) return;
    if (refuseWhenUnavailable()) return;
    const session = store.get(state.sessionId);
    if (!session) return;
    const index = session.messages.findIndex((message) => message.id === assistantMessageId);
    if (index < 0) return;
    // 重新生成必须有可重发的用户提示；否则不动（不伪造一次空请求）
    const hasUserPrompt = session.messages.slice(0, index).some((message) => message.role === 'user');
    if (!hasUserPrompt) return;
    const removals = [];
    for (let i = index; i < session.messages.length; i += 1) {
      if (session.messages[i].role === 'assistant') removals.push(session.messages[i].id);
    }
    for (const id of removals) {
      store.removeMessage(session.id, id);
      thread.remove(id);
    }
    renderSessions();
    updateEmptyState();
    renderStats();
    beginAssistant(store.get(session.id));
  }

  // ---------- 审批 ----------
  function queueApproval(item) {
    state.approvalQueue.push(item);
    pumpApprovals();
  }

  function pumpApprovals() {
    if (state.approvalOpen || !state.approvalQueue.length || state.destroyed) return;
    const item = state.approvalQueue.shift();
    state.approvalOpen = true;
    let decision = null;
    const message = findMessage(item.sessionId, item.messageId);
    const tool = message ? (message.tools || []).find((entry) => entry.callId === item.callId) : null;
    state.approvalOverlay = modal({
      title: t('agent.approval.title'),
      closeLabel: t('common.action.close'),
      body: el('div', { class: 'stack agent-approval' }, [
        el('p', { class: 'muted', text: t('agent.approval.body') }),
        el('dl', { class: 'agent-approval__meta' }, [
          el('dt', { class: 'faint', text: t('agent.approval.tool') }),
          el('dd', { class: 'mono', text: tool && tool.name ? String(tool.name) : 'tool' }),
        ]),
        tool && tool.arguments != null
          ? el('pre', { class: 'chat-tool__json mono', text: stringifyToolValue(tool.arguments) })
          : null,
        el('p', { class: 'faint mono', text: 'callId: ' + item.callId }),
        el('p', { class: 'faint', text: t('agent.approval.execution-disabled') }),
      ]),
      actions: [
        {
          label: t('agent.approval.approve'),
          variant: 'primary',
          onClick: () => {
            decision = 'approve';
          },
        },
        {
          label: t('agent.approval.deny'),
          variant: 'secondary',
          onClick: () => {
            decision = 'deny';
          },
        },
      ],
      onClose: () => {
        state.approvalOpen = false;
        state.approvalOverlay = null;
        if (state.destroyed) return;
        // Esc/遮罩/关闭按钮 = 拒绝，绝不静默批准（合同 §2.7 前端规则）
        commitApproval(item, decision || 'deny');
        pumpApprovals();
      },
    });
  }

  function refreshToolView(sessionId, messageId, tools) {
    if (sessionId !== state.sessionId) return;
    const view = thread.get(messageId);
    if (view) view.setTools(tools);
  }

  async function commitApproval(item, decision) {
    const message = findMessage(item.sessionId, item.messageId);
    if (!message) return;
    const tools = Array.isArray(message.tools) ? message.tools : (message.tools = []);
    const tool = tools.find((entry) => entry.callId === item.callId);
    if (!tool) return;
    tool.decision = decision;
    tool.state = decision === 'approve' ? 'approved' : 'denied';
    refreshToolView(item.sessionId, message.id, tools);
    store.updateMessage(item.sessionId, message.id, { tools });

    try {
      const api = requireApi();
      if (typeof api.approveTool !== 'function') {
        const error = new Error('api.approveTool unavailable');
        error.code = 'API_UNAVAILABLE';
        throw error;
      }
      const result = await api.approveTool({ sessionId: item.sessionId, callId: item.callId, decision });
      if (state.destroyed) return;
      tool.state = 'result';
      if (result && typeof result === 'object') {
        if (result.decision != null) tool.decision = String(result.decision);
        tool.executed = result.executed === true;
        tool.reason = result.reason == null ? null : String(result.reason);
        if (result.result !== undefined) tool.result = result.result;
        if (tool.reason === 'EXECUTION_DISABLED') tool.disabledNotice = true;
      }
    } catch (error) {
      const normalized = normalizeApiError(error);
      tool.state = 'result';
      tool.errorMessage = normalized.message || normalized.code;
      if (normalized.code === 'EXECUTION_DISABLED') {
        tool.reason = 'EXECUTION_DISABLED';
        tool.disabledNotice = true;
      } else if (normalized.code === 'CALL_UNKNOWN') {
        tool.reason = 'CALL_UNKNOWN';
      }
    }
    if (state.destroyed) return;
    refreshToolView(item.sessionId, message.id, tools);
    store.updateMessage(item.sessionId, message.id, { tools });
    if (decision === 'deny') showToast('info', t('agent.approval.denied'));
  }

  // ---------- 启动 / 销毁 ----------
  /**
   * 让"对话区 + composer"落在首屏：量出对话区可用高度，写进 --agent-thread-max。
   * 纯测量、不改其它元素尺寸；拿不到布局（Node 夹具/隐藏态）就静默跳过，回落到 54vh。
   */
  function syncThreadHeight() {
    if (state.destroyed) return;
    try {
      const viewportHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 0;
      if (!viewportHeight || typeof layout.getBoundingClientRect !== 'function') return;
      const rect = layout.getBoundingClientRect();
      const pageTop = rect.top + (typeof window.scrollY === 'number' ? window.scrollY : 0);
      const heightOf = (node) => {
        try {
          return node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect().height || 0 : 0;
        } catch (error) {
          return 0;
        }
      };
      // 兄弟节点的固定开销：页头 + 通知 + 会话条 + 统计条 + composer + 4 个 gap + 底部留白 24px
      const fixed = heightOf(pageHead) + heightOf(noticesEl) + heightOf(sessionBarEl) + heightOf(composer.root) + heightOf(statsEl);
      const available = viewportHeight - pageTop - 24 - fixed - 4 * 16;
      if (!Number.isFinite(available)) return;
      const height = Math.max(240, Math.round(available));
      if (layout.style && typeof layout.style.setProperty === 'function') {
        const next = height + 'px';
        if (layout.style.getPropertyValue('--agent-thread-max') !== next) layout.style.setProperty('--agent-thread-max', next);
      }
    } catch (error) {
      /* 测量失败不影响功能 */
    }
  }

  function onResize() {
    syncThreadHeight();
  }

  /** 页面上下文的尺寸变化（如 shell 首启引导卡被收起）也要重算，否则会留下"少算一屏"的空洞 */
  let layoutObserver = null;
  function observeLayout() {
    if (typeof ResizeObserver !== 'function') return;
    try {
      const watched = typeof layout.closest === 'function' ? layout.closest('main') || layout.parentElement : layout.parentElement;
      layoutObserver = new ResizeObserver(() => syncThreadHeight());
      if (watched) layoutObserver.observe(watched);
      layoutObserver.observe(pageHead);
      layoutObserver.observe(composer.root);
    } catch (error) {
      layoutObserver = null;
    }
  }

  async function start() {
    ensureStyles();
    restoreSession();
    renderSessions();
    renderThread();
    refreshEmptyState();
    renderComposerState();
    await loadModels();
    if (state.destroyed) return;
    refreshEmptyState();
    renderStats();
    syncHash(state.sessionId);
    updateEmptyState();
    syncThreadHeight();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', onResize);
    }
    observeLayout();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => syncThreadHeight());
  }

  function restoreSession() {
    const requested = readSessionParam(context);
    let sessionId = '';
    if (requested && store.get(requested)) sessionId = requested;
    if (!sessionId) {
      const list = store.list();
      if (list.length) sessionId = list[0].id;
    }
    if (!sessionId) sessionId = store.create().id;
    state.sessionId = sessionId;
  }

  function destroy() {
    if (state.destroyed) return;
    const stream = state.stream;
    if (stream && !stream.finalized) {
      try {
        if (stream.handle && typeof stream.handle.abort === 'function') stream.handle.abort();
      } catch (error) {
        /* 忽略 */
      }
      // 离开页面：保留已生成文本，标记中断（下次进入可重试；不自动重连）
      store.updateMessage(stream.sessionId, stream.message.id, {
        content: stream.message.content,
        status: 'interrupted',
      });
      state.stream = null;
    }
    state.destroyed = true;
    state.busy = false;
    state.approvalQueue = [];
    state.approvalQueued.clear();
    if (state.approvalOverlay && typeof state.approvalOverlay.close === 'function') {
      try {
        state.approvalOverlay.close('api');
      } catch (error) {
        /* 忽略 */
      }
    }
    state.approvalOverlay = null;
    if (layoutObserver && typeof layoutObserver.disconnect === 'function') {
      try {
        layoutObserver.disconnect();
      } catch (error) {
        /* 忽略 */
      }
    }
    layoutObserver = null;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      try {
        window.removeEventListener('resize', onResize);
      } catch (error) {
        /* 忽略 */
      }
    }
    store.save();
    thread.destroy();
    composer.destroy();
    layout.remove();
    removeStyles();
  }

  root.replaceChildren(layout);
  return { start, destroy };
}
