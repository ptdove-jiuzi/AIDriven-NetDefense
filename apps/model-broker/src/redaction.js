/**
 * 出域数据检查：分级 → allowlist → 脱敏 → 秘密扫描 → 大小上限 → 最终报文定稿。
 *
 * 设计 §8.3 / §12：无法确定 DTO 合规时**禁止外发**。所以这个模块的默认结局
 * 是"拒绝"，只有一条路径能产出可发送的载荷。
 *
 * 四个刻意的取舍，写在这里免得后面被"优化"掉：
 *
 * 1. **只接受结构化 DTO，不接受自由文本**。`{role, content: "一段话"}` 一律拒绝：
 *    自由文本没有任何字段身份，allowlist 无从下手，等价于把原始证据整包放行。
 *    需要放文本时必须显式声明分级并落到 allowlist 字段上。
 * 2. **字段按 allowlist 声明顺序序列化**。这样同样的内容永远得到同样的
 *    `serialized_digest`，与调用方拼字段的顺序无关——预算账本的可核对性依赖它。
 * 3. **原始值先扫一次、脱敏后再扫一次**。只扫脱敏后的文本存在一个真实漏洞：
 *    掩码会把秘密的一部分吃掉（`user:pass@host` 被邮箱规则替换），从此再也
 *    匹配不到；只扫原始值又会漏掉"掩码拼接出新秘密形态"。两次都做。
 * 4. **摘要与字节上限算在最终报文上**（`finalizeOutbound`）。只算 `{messages}`
 *    会漏掉 `model`/`max_tokens` 这几十个字节：出域上限会被突破一个包装的差，
 *    而且 digest 不绑定实际发送的请求（设计 §9.1 第 1 条要求对最终请求取摘要）。
 */

import { BrokerError, BROKER_CODES } from './errors.js';
import { BROKER_LIMITS, resolveLimits } from './policy.js';
import { byteLength, sha256Hex } from './util.js';

/** 允许的对话角色。`tool` 不在其中：工具结果必须折叠进 user 的 DTO 字段。 */
export const ALLOWED_ROLES = Object.freeze(['system', 'user', 'assistant']);

/** 允许的出域分级。D2/D3 永远不允许。 */
export const ALLOWED_CLASSIFICATIONS = Object.freeze(['D0', 'D1']);

/**
 * D0（公开版本、规则 ID、计数、状态）：可出域。
 * 注意 `event_type` / `platform` 不在这里：设计 §8.3 把它们列在 D1，
 * 归到 D0 会让调用方用一次 D0 声明就夹带它们。
 */
export const D0_FIELDS = Object.freeze([
  'rule_id',
  'rule_version',
  'policy_version',
  'severity',
  'status',
  'count',
]);

/** D1（规范化时间、事件类型、平台、脱敏网络/进程元数据）：仅 allowlist 出域。 */
export const D1_FIELDS = Object.freeze([
  'observed_at',
  'event_type',
  'platform',
  'process_name',
  'image_basename',
  'protocol',
  'dest_port',
  'source_port',
  'direction',
]);

/** 声明顺序即序列化顺序（决定 digest 的稳定性）。 */
export const ALLOWED_FIELDS = Object.freeze([...D0_FIELDS, ...D1_FIELDS]);

const FIELD_CLASS = new Map([
  ...D0_FIELDS.map((field) => [field, 'D0']),
  ...D1_FIELDS.map((field) => [field, 'D1']),
]);

/**
 * 秘密形态。命中即失败关闭——不做"部分打码后放行"。
 *
 * 这里不宣称通用秘密识别：它只拦已知形态；真正的边界是 allowlist 与分级
 * （设计 §8.3 末段原话："不宣称通用秘密识别能发现所有编码秘密"）。
 *
 * 每条规则都是**工厂**而不是共享正则实例：`/g` 正则的 `lastIndex` 是跨调用状态，
 * 共享实例会让第二次扫描从上次停下的位置开始，静默漏检。
 */
const SECRET_RULES = Object.freeze([
  ['private_key_block', () => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u],
  ['aws_access_key_id', () => /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ['bearer_token', () => /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu],
  ['prefixed_api_key', () => /\b(?:sk|pk|rk|ghp|gho|ghu|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/u],
  ['jwt', () => /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
  ['credential_assignment', () => /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|authorization)\b\s*[:=]\s*\S{6,}/iu],
  ['cookie_header', () => /\b(?:set-)?cookie\s*:/iu],
  ['connection_string', () => /\b(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s/]+:[^\s@]+@/iu],
  // R5-009：裸 `key=` / `token=` 赋值（不带 api/access 前缀的常见写法）。
  ['bare_key_or_token_assignment', () => /\b(?:key|token|apikey|api_key|auth)\s*[:=]\s*[A-Za-z0-9._~+/=-]{6,}/iu],
  // R5-009：URL userinfo（`scheme://user:pass@host`）—— 凭据常被整段贴进日志/报错。
  ['url_userinfo', () => /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu],
  // R5-009：URL query 里的短凭据参数（`?key=zzz` / `&token=…`），值可以很短。
  ['url_query_credential', () => /[?&](?:key|token|api[_-]?key|apikey|access[_-]?token|auth)=[^&\s#]{1,}/iu],
  // R5-009：HuggingFace 形态令牌（`hf_` + 至少 8 位字母数字）。
  ['huggingface_token', () => /\bhf_[A-Za-z0-9]{8,}\b/u],
]);

const CONTROL_ESCAPE_SOURCE = '\\u001B\\[[0-9;?]*[ -/]*[@-~]';
const C0_CONTROL_SOURCE = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]';
const WINDOWS_PROFILE_SOURCE = '([A-Za-z]:[\\\\/](?:Users|Documents and Settings)[\\\\/])[^\\\\/\\s"\',;]+';
const POSIX_HOME_SOURCE = '(/(?:home|Users)/)[^/\\s"\',;]+';
const EMAIL_SOURCE = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';

/** 每次调用新建正则：共享 `/g` 正则的 `lastIndex` 是状态，跨调用会漏替换。 */
function pattern(source, flags = 'gu') {
  return new RegExp(source, flags);
}

/** 错误 details 里的调用方输入一律截断：details 会被写日志/回 IPC。 */
function brief(value, max = 64) {
  if (typeof value !== 'string') return value === undefined ? null : value;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 只返回命中的规则名，绝不返回命中的原文（原文就是秘密本身）。 */
export function scanSecrets(text) {
  const hits = [];
  for (const [name, factory] of SECRET_RULES) {
    if (factory().test(text)) hits.push(name);
  }
  return hits;
}

function stripControl(value, redactions) {
  let text = value;
  if (pattern(CONTROL_ESCAPE_SOURCE).test(text)) {
    text = text.replace(pattern(CONTROL_ESCAPE_SOURCE), '');
    redactions.push('ansi_escape');
  }
  if (pattern(C0_CONTROL_SOURCE).test(text)) {
    text = text.replace(pattern(C0_CONTROL_SOURCE), '');
    redactions.push('control_char');
  }
  return text;
}

/**
 * 脱敏单条字符串值。
 *
 * @returns {{ value: string, redactions: string[] }}
 */
export function redactValue(value, limits = BROKER_LIMITS) {
  if (typeof value !== 'string') {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'redaction target must be a string');
  }
  if (byteLength(value) > limits.maxValueBytes) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_LIMIT, 'field value exceeds the per-value byte limit', {
      bytes: byteLength(value),
      limit: limits.maxValueBytes,
    });
  }
  const redactions = [];
  // 先扫**原始值**：掩码会销毁证据本身。`postgres://svc:hunter2@db.internal`
  // 里的 `hunter2@db.internal` 会被邮箱规则替换成 `<email>`，连接串规则就再也
  // 匹配不到了——那是"脱敏成功、秘密照旧出域"。所以原始命中直接失败关闭。
  const rawHits = scanSecrets(value);
  if (rawHits.length > 0) {
    throw new BrokerError(
      BROKER_CODES.ERR_BROKER_REDACTION_FAILED,
      'payload contains a secret pattern and cannot be cleaned by masking',
      { rules: rawHits },
    );
  }
  let text = stripControl(value, redactions);
  if (pattern(WINDOWS_PROFILE_SOURCE).test(text)) {
    text = text.replace(pattern(WINDOWS_PROFILE_SOURCE), '$1<user>');
    redactions.push('windows_profile_path');
  }
  if (pattern(POSIX_HOME_SOURCE).test(text)) {
    text = text.replace(pattern(POSIX_HOME_SOURCE), '$1<user>');
    redactions.push('posix_home_path');
  }
  if (pattern(EMAIL_SOURCE).test(text)) {
    text = text.replace(pattern(EMAIL_SOURCE), '<email>');
    redactions.push('email');
  }
  // 脱敏之后再扫一次：替换/截断可能把原本分开的片段拼成秘密形态。
  const hits = scanSecrets(text);
  if (hits.length > 0) {
    throw new BrokerError(
      BROKER_CODES.ERR_BROKER_REDACTION_FAILED,
      'redaction could not prove the payload free of secrets',
      { rules: hits },
    );
  }
  if (byteLength(text) > limits.maxValueBytes) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_LIMIT, 'redacted value still exceeds the byte limit', {
      bytes: byteLength(text),
      limit: limits.maxValueBytes,
    });
  }
  return { value: text, redactions };
}

function sanitizeScalar(field, value, limits) {
  if (typeof value === 'string') return redactValue(value, limits);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'numeric field must be a safe integer', { field });
    }
    return { value, redactions: [] };
  }
  if (typeof value === 'boolean') return { value, redactions: [] };
  // null / undefined / 数组 / 嵌套对象 / 函数：一律拒绝，不做递归"尽力脱敏"。
  throw new BrokerError(
    BROKER_CODES.ERR_BROKER_INPUT,
    'field value must be a string, safe integer or boolean',
    { field, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value },
  );
}

/**
 * 把 worker 的意图 DTO 收敛成可外发载荷（只含 messages）。
 *
 * 最终报文由 `finalizeOutbound` 生成：那里才绑定 `model`/`max_tokens` 并取摘要。
 *
 * @param {object} intent `{ analysis_id, attempt_id?, model?, messages }`
 * @param {{ limits?: object }} [options]
 */
export function buildOutboundPayload(intent, options = {}) {
  const limits = resolveLimits(options.limits);
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'request intent must be an object');
  }
  const rawMessages = intent.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'messages must be a non-empty array');
  }
  if (rawMessages.length > limits.maxMessages) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_LIMIT, 'too many messages', {
      count: rawMessages.length,
      limit: limits.maxMessages,
    });
  }

  const messages = [];
  const redactions = [];
  // 边扫边累计：8×64×16KiB≈8MiB 的输入不该先被完整扫描两遍再拒绝。
  let runningBytes = 0;

  for (let index = 0; index < rawMessages.length; index += 1) {
    const message = rawMessages[index];
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'message must be an object', { message_index: index });
    }
    if (!ALLOWED_ROLES.includes(message.role)) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'message role is not allowed', {
        message_index: index,
        role: brief(message.role),
      });
    }
    const content = message.content;
    if (content === null || typeof content !== 'object' || Array.isArray(content)) {
      // 自由文本没有字段身份，无法走 allowlist —— 这是本模块最重要的一条拒绝。
      throw new BrokerError(
        BROKER_CODES.ERR_BROKER_ALLOWLIST,
        'message content must be a classified field DTO, not free text',
        { message_index: index },
      );
    }
    const classification = content.classification;
    if (!ALLOWED_CLASSIFICATIONS.includes(classification)) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_CLASSIFICATION, 'classification is not allowed out of domain', {
        message_index: index,
        classification: brief(classification),
      });
    }
    const fields = content.fields;
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'content.fields must be an object', {
        message_index: index,
      });
    }
    const keys = Object.keys(fields);
    if (keys.length === 0) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_INPUT, 'content.fields must not be empty', {
        message_index: index,
      });
    }
    if (keys.length > limits.maxFields) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_LIMIT, 'too many fields in one message', {
        message_index: index,
        count: keys.length,
        limit: limits.maxFields,
      });
    }
    for (const key of keys) {
      if (byteLength(key) > limits.maxFieldKeyLength) {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_LIMIT, 'field name exceeds the byte limit', {
          message_index: index,
          limit: limits.maxFieldKeyLength,
        });
      }
      const fieldClass = FIELD_CLASS.get(key);
      if (fieldClass === undefined) {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_ALLOWLIST, 'field is not on the outbound allowlist', {
          message_index: index,
          field: brief(key),
        });
      }
      if (classification === 'D0' && fieldClass !== 'D0') {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CLASSIFICATION, 'field requires a D1 declaration', {
          message_index: index,
          field: brief(key),
          declared: classification,
          required: fieldClass,
        });
      }
    }

    // 按 allowlist 声明顺序输出：同内容同 digest，与调用方顺序无关。
    const ordered = {};
    for (const field of ALLOWED_FIELDS) {
      if (!Object.hasOwn(fields, field)) continue;
      const sanitized = sanitizeScalar(field, fields[field], limits);
      ordered[field] = sanitized.value;
      if (sanitized.redactions.length > 0) {
        redactions.push({ message_index: index, field, rules: Object.freeze([...sanitized.redactions]) });
      }
      runningBytes += byteLength(field) + byteLength(typeof sanitized.value === 'string' ? sanitized.value : String(sanitized.value));
      if (runningBytes > limits.maxRequestBytes) {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_LIMIT, 'outbound payload exceeds the byte limit', {
          bytes: runningBytes,
          limit: limits.maxRequestBytes,
        });
      }
    }
    messages.push(Object.freeze({
      role: message.role,
      content: Object.freeze({ classification, fields: Object.freeze(ordered) }),
    }));
  }

  const serialized = JSON.stringify({ messages });
  const bytes = byteLength(serialized);
  if (bytes > limits.maxRequestBytes) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_LIMIT, 'serialized request exceeds the outbound byte limit', {
      bytes,
      limit: limits.maxRequestBytes,
    });
  }

  return Object.freeze({
    messages: Object.freeze(messages),
    serialized,
    redactions: Object.freeze(redactions),
    model: typeof intent.model === 'string' ? intent.model : undefined,
  });
}

/**
 * 定稿最终报文：绑定 model 与 max_tokens，并对**真正要发出去的字符串**取摘要。
 *
 * `digest` 因此同时绑定"发了什么内容"和"按什么模型/多少输出预算"，与设计 §9.1
 * 第 1 条一致；64KiB 上限也按真实报文字节数判定。
 */
export function finalizeOutbound(payload, options) {
  const limits = resolveLimits(options.limits);
  const model = options.model;
  const maxTokens = options.maxTokens;
  if (typeof model !== 'string' || model.length === 0) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_ENDPOINT, 'final outbound body requires a fixed model id');
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_BUDGET, 'final outbound body requires a positive max_tokens');
  }
  const body = JSON.stringify({ model, messages: payload.messages, max_tokens: maxTokens });
  const bytes = byteLength(body);
  if (bytes > limits.maxRequestBytes) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_LIMIT, 'wire body exceeds the outbound byte limit', {
      bytes,
      limit: limits.maxRequestBytes,
    });
  }
  return Object.freeze({ body, bytes, digest: sha256Hex(body), max_tokens: maxTokens, model });
}

/**
 * `input_upper` 的保守上界：最终报文的 UTF-8 字节数 + 每条消息的 role/特殊标记开销。
 *
 * 依据（设计 §9.1 第 2 条）：无法证明 tokenizer 时，采用完整序列化请求的
 * UTF-8 字节数加经合同验证的标记上界。对 UTF-8 文本，BPE 类 tokenizer 的
 * 一个 token 至少覆盖一个字节，因此**字节数是 token 数的上界**；
 * 再加 8 字节/消息与 16 字节信封余量，覆盖 role 与起止标记。
 */
export function estimateInputUpper(body, messageCount) {
  const bytes = typeof body === 'string' ? byteLength(body) : body.bytes;
  return bytes + messageCount * 8 + 16;
}
