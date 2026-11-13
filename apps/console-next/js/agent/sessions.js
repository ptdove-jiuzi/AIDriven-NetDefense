/**
 * AIDriven NetDefense · WebUI v2 · Agent 会话持久化
 * B4 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.5 / §2.5
 * - localStorage 键固定 `aidn.agent.sessions`（≤ 50 会话 × 每会话 200 条消息，超出丢最旧）。
 * - **只存非敏感值**：不写 apiKey、token、csrf、请求头；消息里只留 role/content/usage/tool 元数据。
 * - sessionId 形状 `^s_[0-9a-f]{32}$`（合同 §2.5 chat body 校验）；messageId 内部用 `m_<hex>`。
 * - 存储不可用（隐私模式/被禁用/配额满）时降级为内存态，不抛错、不丢当前会话。
 *
 * 导出：STORAGE_KEY / MAX_SESSIONS / MAX_MESSAGES / SESSION_ID_PATTERN
 *       newSessionId() / newMessageId()
 *       createSessionStore({storage, key}) → store
 */
export const STORAGE_KEY = 'aidn.agent.sessions';
export const MAX_SESSIONS = 50;
export const MAX_MESSAGES = 200;
export const SESSION_ID_PATTERN = /^s_[0-9a-f]{32}$/;
export const SCHEMA_VERSION = 1;
const MAX_TITLE_CHARS = 40;
const MAX_CONTENT_CHARS = 100000;

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes) {
  const size = Math.max(1, Number(bytes) || 1);
  const out = [];
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buffer = new Uint8Array(size);
    cryptoObj.getRandomValues(buffer);
    for (const byte of buffer) out.push(byte.toString(16).padStart(2, '0'));
    return out.join('');
  }
  // 兜底（无 WebCrypto 的测试环境）：仍然产出正确长度的 hex，但非密码学随机
  for (let i = 0; i < size; i += 1) {
    out.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  }
  return out.join('');
}

/** newSessionId() → 's_' + 32 hex */
export function newSessionId() {
  return 's_' + randomHex(16);
}

/** newMessageId() → 'm_' + 24 hex */
export function newMessageId() {
  return 'm_' + randomHex(12);
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 浏览器里优先用真实 localStorage；不可用则内存兜底（并把原因记在 store.storageMode） */
function resolveStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const probe = '__aidn_b4_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return { storage: localStorage, mode: 'localStorage' };
    }
  } catch (error) {
    return { storage: memoryStorage(), mode: 'memory', reason: String((error && error.message) || error) };
  }
  return { storage: memoryStorage(), mode: 'memory', reason: 'localStorage unavailable' };
}

function clampText(value, max) {
  const text = String(value == null ? '' : value);
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role === 'user' ? 'user' : raw.role === 'assistant' ? 'assistant' : '';
  if (!role) return null;
  const message = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newMessageId(),
    role,
    content: clampText(raw.content, MAX_CONTENT_CHARS),
    status: typeof raw.status === 'string' ? raw.status : 'done',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
    usage: null,
    error: null,
    tools: [],
  };
  if (raw.usage && typeof raw.usage === 'object') {
    message.usage = {
      promptTokens: raw.usage.promptTokens == null ? null : Number(raw.usage.promptTokens),
      completionTokens: raw.usage.completionTokens == null ? null : Number(raw.usage.completionTokens),
      totalTokens: raw.usage.totalTokens == null ? null : Number(raw.usage.totalTokens),
      estimatedCostUsd:
        raw.usage.estimatedCostUsd == null || !Number.isFinite(Number(raw.usage.estimatedCostUsd))
          ? null
          : Number(raw.usage.estimatedCostUsd),
      providerId: raw.usage.providerId == null ? null : String(raw.usage.providerId),
      modelId: raw.usage.modelId == null ? null : String(raw.usage.modelId),
      tier: raw.usage.tier == null ? null : String(raw.usage.tier),
    };
  }
  if (raw.error && typeof raw.error === 'object') {
    message.error = {
      code: raw.error.code == null ? 'UNKNOWN' : String(raw.error.code),
      message: raw.error.message == null ? '' : String(raw.error.message),
      retryable: Boolean(raw.error.retryable),
      action: raw.error.action == null ? null : String(raw.error.action),
    };
  }
  if (Array.isArray(raw.tools)) {
    for (const tool of raw.tools) {
      if (!tool || typeof tool !== 'object') continue;
      message.tools.push({
        callId: String(tool.callId == null ? '' : tool.callId),
        name: tool.name == null ? null : String(tool.name),
        arguments: tool.arguments === undefined ? null : tool.arguments,
        state: typeof tool.state === 'string' ? tool.state : 'proposed',
        requiresApproval: Boolean(tool.requiresApproval),
        decision: tool.decision == null ? null : String(tool.decision),
        executed: tool.executed === undefined ? null : Boolean(tool.executed),
        reason: tool.reason == null ? null : String(tool.reason),
        latencyMs: tool.latencyMs == null || !Number.isFinite(Number(tool.latencyMs)) ? null : Number(tool.latencyMs),
        result: tool.result === undefined ? null : tool.result,
        errorMessage: tool.errorMessage == null ? null : String(tool.errorMessage),
      });
    }
  }
  return message;
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && SESSION_ID_PATTERN.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const messages = [];
  if (Array.isArray(raw.messages)) {
    for (const item of raw.messages) {
      const message = normalizeMessage(item);
      if (message) messages.push(message);
    }
  }
  const trimmed = messages.slice(-MAX_MESSAGES);
  return {
    id,
    title: clampText(raw.title, 120) || '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    messages: trimmed,
  };
}

function sortByUpdatedAt(sessions) {
  return sessions.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function loadSessions(storage, key) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    return [];
  }
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.sessions) ? parsed.sessions : [];
  const sessions = [];
  for (const item of items) {
    const session = normalizeSession(item);
    if (session) sessions.push(session);
  }
  return sortByUpdatedAt(sessions).slice(0, MAX_SESSIONS);
}

/**
 * createSessionStore({storage, key})
 * storage 缺省用 localStorage；测试可注入任意 getItem/setItem/removeItem。
 */
export function createSessionStore(options) {
  const opts = options == null ? {} : options;
  const resolved = opts.storage ? { storage: opts.storage, mode: 'injected' } : resolveStorage();
  const storage = resolved.storage;
  const key = typeof opts.key === 'string' && opts.key ? opts.key : STORAGE_KEY;
  let sessions = loadSessions(storage, key);
  let lastPersistOk = true;

  function dropOldestForRoom() {
    // 按 updatedAt 找最旧的一个（时间戳相同的保留先插入的 = 更旧的），逐个裁到上限
    while (sessions.length > MAX_SESSIONS) {
      let oldestIndex = 0;
      for (let i = 1; i < sessions.length; i += 1) {
        if (String(sessions[i].updatedAt) < String(sessions[oldestIndex].updatedAt)) oldestIndex = i;
      }
      sessions.splice(oldestIndex, 1);
    }
  }

  function persist() {
    const payload = { version: SCHEMA_VERSION, savedAt: nowIso(), sessions };
    const write = (value) => {
      storage.setItem(key, JSON.stringify(value));
    };
    try {
      write(payload);
      lastPersistOk = true;
      return true;
    } catch (error) {
      // 配额满：丢最旧会话后重试一次；仍失败则保持内存态（不抛错、不丢当前会话）
      if (sessions.length > 1) {
        sessions = sessions.slice(0, Math.max(1, sessions.length - 1));
        try {
          write({ version: SCHEMA_VERSION, savedAt: nowIso(), sessions });
          lastPersistOk = true;
          return true;
        } catch (retryError) {
          lastPersistOk = false;
          return false;
        }
      }
      lastPersistOk = false;
      return false;
    }
  }

  function touch(session) {
    session.updatedAt = nowIso();
  }

  function find(sessionId) {
    return sessions.find((session) => session.id === sessionId) || null;
  }

  function list() {
    return sortByUpdatedAt(sessions);
  }

  return {
    key,
    storageMode: resolved.mode,
    storageReason: resolved.reason || null,
    get persistOk() {
      return lastPersistOk;
    },
    list,
    get: find,
    /** create() → 新会话（已在列表头部） */
    create(title) {
      const session = {
        id: newSessionId(),
        title: clampText(title, 120) || '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        messages: [],
      };
      sessions.push(session);
      dropOldestForRoom();
      persist();
      return session;
    },
    /** remove(id) → boolean */
    remove(sessionId) {
      const before = sessions.length;
      sessions = sessions.filter((session) => session.id !== sessionId);
      if (sessions.length === before) return false;
      persist();
      return true;
    },
    rename(sessionId, title) {
      const session = find(sessionId);
      if (!session) return false;
      session.title = clampText(title, 120);
      touch(session);
      persist();
      return true;
    },
    /** 标题自动取首条用户消息前 40 字（代码点计数，不切碎代理对） */
    setTitleFromFirstUserMessage(sessionId, content) {
      const session = find(sessionId);
      if (!session) return '';
      if (session.title) return session.title;
      const chars = Array.from(String(content == null ? '' : content).trim());
      const title = chars.slice(0, MAX_TITLE_CHARS).join('').trim();
      if (!title) return '';
      session.title = title;
      touch(session);
      persist();
      return title;
    },
    /** addMessage(sessionId, message) → 规范化后的消息（已持久化） */
    addMessage(sessionId, message) {
      const session = find(sessionId);
      if (!session) return null;
      const normalized = normalizeMessage(message);
      if (!normalized) return null;
      session.messages.push(normalized);
      if (session.messages.length > MAX_MESSAGES) {
        session.messages.splice(0, session.messages.length - MAX_MESSAGES);
      }
      touch(session);
      persist();
      return normalized;
    },
    /** updateMessage(sessionId, messageId, patch) → 合并 patch 后持久化 */
    updateMessage(sessionId, messageId, patch) {
      const session = find(sessionId);
      if (!session) return null;
      const index = session.messages.findIndex((message) => message.id === messageId);
      if (index < 0) return null;
      if (patch && typeof patch === 'object') Object.assign(session.messages[index], patch);
      if (session.messages[index].content) {
        session.messages[index].content = clampText(session.messages[index].content, MAX_CONTENT_CHARS);
      }
      touch(session);
      persist();
      return session.messages[index];
    },
    removeMessage(sessionId, messageId) {
      const session = find(sessionId);
      if (!session) return false;
      const before = session.messages.length;
      session.messages = session.messages.filter((message) => message.id !== messageId);
      if (session.messages.length === before) return false;
      touch(session);
      persist();
      return true;
    },
    /** 累计用量：totalTokens 求和；任一条 estimatedCostUsd=null 且已有用量 → costKnown=false */
    totals(sessionId) {
      const session = find(sessionId);
      const result = { totalTokens: 0, costUsd: 0, costKnown: true, usageCount: 0, promptTokens: 0, completionTokens: 0 };
      if (!session) return result;
      for (const message of session.messages) {
        const usage = message && message.usage;
        if (!usage) continue;
        result.usageCount += 1;
        const total = Number(usage.totalTokens);
        if (Number.isFinite(total) && total > 0) result.totalTokens += total;
        const prompt = Number(usage.promptTokens);
        if (Number.isFinite(prompt) && prompt > 0) result.promptTokens += prompt;
        const completion = Number(usage.completionTokens);
        if (Number.isFinite(completion) && completion > 0) result.completionTokens += completion;
        if (usage.estimatedCostUsd == null) result.costKnown = false;
        else if (Number.isFinite(Number(usage.estimatedCostUsd))) result.costUsd += Number(usage.estimatedCostUsd);
        else result.costKnown = false;
      }
      if (result.usageCount === 0) result.costKnown = false;
      return result;
    },
    save: persist,
    /** 仅供测试/诊断：直接读当前内存快照 */
    snapshot() {
      return JSON.parse(JSON.stringify({ version: SCHEMA_VERSION, sessions }));
    },
  };
}
