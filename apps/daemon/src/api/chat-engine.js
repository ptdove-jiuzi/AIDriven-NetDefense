/**
 * api/chat-engine.js — engine selection and the server-owned system prompts.
 *
 * Contract §2.5 fixes three engine values (`auto|broker-host|harness`) and one
 * honest status: the Harness engine is **not available in 0.0.1**. The profile is
 * not staged and no chat adapter exists, so `auto` resolves to `broker-host` and an
 * explicit `harness` request answers `ENGINE_UNAVAILABLE` with `details.tried`.
 *
 * The system prompt is a server constant, never client input: the chat body only
 * accepts `user` and `assistant` roles (§2.5), which is why a browser cannot replace
 * the operator's instructions with its own.
 */

import { CONSOLE_CODES, ConsoleError } from './console-errors.js';

/** Engine identifiers accepted in `settings.models.agent.engine`. */
export const CHAT_ENGINES = Object.freeze(['auto', 'broker-host', 'harness']);

/** Reason reported for the unavailable Harness engine (contract §2.2/§12.1). */
export const HARNESS_UNAVAILABLE_REASON = 'PROFILE_NOT_STAGED';

/**
 * Fixed system prompts, one per supported locale shape.
 *
 * A locale outside this table falls back to `en`: sending an unexpected system
 * prompt is worse than sending an English one, and the fallback is visible in the
 * response's language rather than hidden.
 */
export const SYSTEM_PROMPTS = Object.freeze({
  en: 'You are the local security analyst for AIDriven NetDefense. Answer only from the alert fields you are given; never invent facts, never repeat raw log contents, and request human approval before any response action.',
  'zh-CN': '你是「网域智防」（AIDriven NetDefense）的本地安全分析助手。只依据给出的告警字段作答，不编造未提供的事实，不重复原始日志内容；任何响应动作都必须先请求人工审批。',
  ja: 'あなたは AIDriven NetDefense のローカルなセキュリティ分析者です。与えられたアラート項目だけに基づいて回答し、事実を捏造せず、応答アクションの前に必ず人による承認を求めてください。',
  ko: '당신은 AIDriven NetDefense의 로컬 보안 분석가입니다. 주어진 경고 필드만 근거로 답하고, 사실을 꾸며내지 말며, 모든 대응 조치 전에 사람의 승인을 요청하십시오.',
  es: 'Eres el analista de seguridad local de AIDriven NetDefense. Responde solo con los campos de alerta proporcionados, no inventes hechos y solicita aprobación humana antes de cualquier acción de respuesta.',
  ru: 'Вы локальный аналитик безопасности AIDriven NetDefense. Отвечайте только по предоставленным полям оповещения, не выдумывайте факты и запрашивайте подтверждение человека перед любым действием реагирования.',
  th: 'คุณคือนักวิเคราะห์ความปลอดภัยภายในเครื่องของ AIDriven NetDefense ตอบจากฟิลด์การแจ้งเตือนที่ให้มาเท่านั้น อย่าสร้างข้อเท็จจริงขึ้นเอง และขออนุมัติจากมนุษย์ก่อนดำเนินการตอบสนองใด ๆ',
});

/**
 * Resolve a locale to a system prompt.
 *
 * @param {string|undefined} locale Requested locale.
 * @returns {string} System prompt text.
 */
export function systemPromptFor(locale) {
  if (typeof locale === 'string' && Object.hasOwn(SYSTEM_PROMPTS, locale)) {
    return SYSTEM_PROMPTS[locale];
  }
  return SYSTEM_PROMPTS.en;
}

/**
 * Create the engine selector.
 *
 * @param {{broker: object, logger?: object}} options Options.
 * @returns {object} Engine facade with `describe`, `select`, `openStream`, `isAvailable`.
 */
export function createChatEngine(options) {
  const broker = options.broker;
  const logger = options.logger ?? null;

  /**
   * Report which engine would run, for `GET /api/v1/models#engine`.
   *
   * `selected: null` when nothing can run: the Agent page then shows the guidance
   * state instead of a green pill that lies.
   *
   * @returns {{selected: string|null, harness: {available: boolean, reason: string}}} Status.
   */
  function describe() {
    const brokerAvailable = typeof broker.isAvailable === 'function' && broker.isAvailable() === true;
    return {
      selected: brokerAvailable ? 'broker-host' : null,
      harness: { available: false, reason: HARNESS_UNAVAILABLE_REASON },
    };
  }

  /**
   * Decide which engine a request may use.
   *
   * @param {string} preference `auto|broker-host|harness` from settings.
   * @returns {{ok: true, engine: string}|{ok: false, tried: string[]}} Decision.
   */
  function select(preference) {
    const brokerAvailable = typeof broker.isAvailable === 'function' && broker.isAvailable() === true;
    if (preference === 'harness') {
      return { ok: false, tried: ['harness'] };
    }
    if (preference === 'broker-host') {
      return brokerAvailable ? { ok: true, engine: 'broker-host' } : { ok: false, tried: ['broker-host'] };
    }
    // `auto`: the only runnable engine in 0.0.1. The Harness engine is reported as
    // tried-not-available so the UI can explain both halves of the failure.
    return brokerAvailable
      ? { ok: true, engine: 'broker-host' }
      : { ok: false, tried: ['broker-host', 'harness'] };
  }

  /**
   * Throw the contract's 503 unless an engine can run.
   *
   * @param {string} preference `auto|broker-host|harness`.
   * @returns {string} The selected engine id.
   * @throws {ConsoleError} `ENGINE_UNAVAILABLE` with `details.tried`.
   */
  function requireEngine(preference) {
    const decision = select(preference);
    if (decision.ok) {
      return decision.engine;
    }
    logger?.warn?.('no chat engine available', { tried: decision.tried.join(',') });
    throw new ConsoleError(CONSOLE_CODES.ENGINE_UNAVAILABLE, 'no chat engine is available', {
      tried: decision.tried,
    });
  }

  /**
   * Open one streaming chat turn on the selected engine.
   *
   * @param {object} params Engine parameters (built by `chat.js`).
   * @param {{onEvent: Function, onFault?: Function}} handlers Event sink.
   * @returns {Promise<object>} Stream handle from the broker client.
   */
  function openStream(params, handlers) {
    return broker.openChat(params, handlers);
  }

  return {
    describe,
    select,
    requireEngine,
    openStream,
    isAvailable: () => (typeof broker.isAvailable === 'function' && broker.isAvailable() === true),
  };
}
