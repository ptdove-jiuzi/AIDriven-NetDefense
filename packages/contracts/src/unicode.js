import { ContractError, ERROR_CODES } from './errors.js';

const BIDI_PATTERN = /[\u202A-\u202E\u2066-\u2069]/;
const ZERO_WIDTH_PATTERN = /[\u200B-\u200F\uFEFF\u2060]/;

/**
 * 原始证据通道（payload.raw_evidence.text）唯一允许放行的控制符。
 * 只包含制表、换行、回车三种行结构字符；ESC(0x1B) 等其余 C0/C1 一律仍然拒绝，
 * 以免文本日志把 ANSI 转义序列带进终端。
 */
export const RAW_EVIDENCE_CONTROLS = Object.freeze(['\t', '\n', '\r']);

/** 字符串的 UTF-8 字节数。 */
export function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function fail(code, path, message) {
  throw new ContractError(code, path, message);
}

/** 检测孤立代理项。Node 24 优先使用 String.prototype.isWellFormed。 */
export function assertWellFormedSurrogates(value, path = '$') {
  if (typeof value.isWellFormed === 'function') {
    if (!value.isWellFormed()) {
      fail(ERROR_CODES.ERR_UNPAIRED_SURROGATE, path, 'String contains an unpaired surrogate code unit');
    }
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(ERROR_CODES.ERR_UNPAIRED_SURROGATE, path, 'String contains an unpaired high surrogate');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(ERROR_CODES.ERR_UNPAIRED_SURROGATE, path, 'String contains an unpaired low surrogate');
    }
  }
}

/** 字符串必须是 NFC。NFD/NFKC 变体一律拒绝，避免同形不同字节。 */
export function assertNfc(value, path = '$') {
  if (value.normalize('NFC') !== value) {
    fail(ERROR_CODES.ERR_STRING_NOT_NFC, path, 'String is not in Unicode NFC form');
  }
}

function isControlUnit(unit) {
  return unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f);
}

/**
 * 禁止 C0/C1 控制符，包括 JSON 里合法的 \n / \t / \r 数据值。
 * `allowed` 只能是 RAW_EVIDENCE_CONTROLS 中的字符数组，用于原始证据通道。
 * 不存在"全部放行"的分支：真实布尔只想表达"用原始证据通道"，也必须收敛到
 * RAW_EVIDENCE_CONTROLS，否则公开导出上就多了一个 ANSI 注入面。
 */
export function assertNoControls(value, path = '$', allowed) {
  const allowedSet = Array.isArray(allowed) ? new Set(allowed) : null;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (!isControlUnit(unit)) continue;
    if (allowedSet !== null && allowedSet.has(String.fromCharCode(unit))) continue;
    fail(ERROR_CODES.ERR_STRING_CONTROL_CHARACTER, path, 'String contains a C0/C1 control character');
  }
}

/** 禁止双向覆盖与双向隔离符。 */
export function assertNoBidi(value, path = '$') {
  if (BIDI_PATTERN.test(value)) {
    fail(ERROR_CODES.ERR_STRING_BIDI_OVERRIDE, path, 'String contains a bidirectional override or isolate');
  }
}

/** 禁止零宽字符，避免显示与比较歧义。 */
export function assertNoZeroWidth(value, path = '$') {
  if (ZERO_WIDTH_PATTERN.test(value)) {
    fail(ERROR_CODES.ERR_STRING_ZERO_WIDTH, path, 'String contains a zero-width character');
  }
}

/**
 * 允许放行的控制符只能取自 RAW_EVIDENCE_CONTROLS，调用方无法借此放宽到别的字符。
 *
 * `true` 的语义是"使用原始证据通道"，即等价于 RAW_EVIDENCE_CONTROLS（\t \n \r），
 * **不是**"全部放行"——历史上 `true` 会放过 ESC(0x1B)，构成 ANSI 注入面。
 */
function normalizeAllowedControls(allow) {
  if (allow === true) return [...RAW_EVIDENCE_CONTROLS];
  if (!Array.isArray(allow)) return undefined;
  return allow.filter((entry) => RAW_EVIDENCE_CONTROLS.includes(entry));
}

/**
 * 统一文本校验。
 * `options.allowControls` 只支持 true（等价于 RAW_EVIDENCE_CONTROLS）或字符数组
 * （逐个与 RAW_EVIDENCE_CONTROLS 求交），默认拒绝全部控制符；
 * 双向符与零宽字符不受该开关影响。
 */
export function assertText(value, path = '$', options = {}) {
  assertWellFormedSurrogates(value, path);
  assertNfc(value, path);
  assertNoControls(value, path, normalizeAllowedControls(options.allowControls));
  assertNoBidi(value, path);
  assertNoZeroWidth(value, path);
}
