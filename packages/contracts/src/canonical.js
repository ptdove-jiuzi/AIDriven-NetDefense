import { createHash } from 'node:crypto';
import { ContractError, ERROR_CODES, isContractError } from './errors.js';
import { LIMITS } from './limits.js';
import { assertWellFormedSurrogates } from './unicode.js';

function fail(code, path, message, details) {
  throw new ContractError(code, path, message, details);
}

function describeError(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * 访问器 / Proxy 陷阱把异常送出来的统一出口（DEF-02、DEF-12）。
 *
 * 规范化是"内容的函数"这一前提，要求实现只读**数据属性**：一旦允许读访问器，
 * 同一个对象两次规范化就可能得到不同摘要，摘要就不再唯一对应一份内容。
 * 因此这里不执行 getter，也不让 getter / Proxy 的原始异常逃出合同边界，
 * 而是统一转成 `ERR_INPUT_UNREADABLE`，调用方可以只凭 `instanceof ContractError`
 * 分类，不必猜"这个 TypeError 是输入不合法还是解析器被毒对象打断"。
 */
function unreadable(path, detail) {
  return new ContractError(
    ERROR_CODES.ERR_INPUT_UNREADABLE,
    path,
    `Cannot canonicalize an unreadable object graph: ${detail}`,
  );
}

/** 在合同错误边界内执行一次可能触发陷阱的操作。 */
function guarded(path, action) {
  try {
    return action();
  } catch (error) {
    if (isContractError(error)) throw error;
    throw unreadable(path, describeError(error));
  }
}

/**
 * 只读取自有**数据**属性：不执行 getter，不沿原型链取值。
 * 属性在遍历过程中消失（getter 改成可配置属性、Proxy 前后不一致）同样失败关闭，
 * 否则同一个 key 会被静默跳过，两个内容不同的对象会撞摘要。
 */
function readDataProperty(target, key, path) {
  const descriptor = guarded(path, () => Object.getOwnPropertyDescriptor(target, key));
  if (descriptor === undefined) {
    throw unreadable(path, `property "${key}" disappeared during traversal`);
  }
  if (!('value' in descriptor)) {
    throw unreadable(path, `property "${key}" is an accessor, only plain data can be canonicalized`);
  }
  return descriptor.value;
}

/**
 * 规范化字符串：只转义 `"`、`\` 与 U+0000–U+001F（\u00xx 小写十六进制）。
 * 其余字符（含中文、emoji、U+2028/U+2029）原样输出，随后由 UTF-8 编码落盘。
 *
 * 孤立代理项一律拒绝：`\ud800` 与 `\ud801` 若都被编码成 U+FFFD（或原样写出非法
 * UTF-8），两个不同的输入会得到同一份摘要，破坏"摘要唯一对应一份字节"的前提。
 */
function quote(value, path) {
  assertWellFormedSurrogates(value, path);
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22) out += '\\"';
    else if (unit === 0x5c) out += '\\\\';
    else if (unit < 0x20) out += `\\u${unit.toString(16).padStart(4, '0')}`;
    else out += value[index];
  }
  return `${out}"`;
}

function writeNumber(value, path) {
  if (!Number.isFinite(value)) {
    fail(ERROR_CODES.ERR_NUMBER_NOT_FINITE, path, 'Cannot canonicalize a non-finite number');
  }
  if (value === 0) return '0';
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    fail(ERROR_CODES.ERR_NUMBER_PRECISION_LOSS, path, 'Cannot canonicalize an unsafe integer');
  }
  return String(value);
}

/** 稀疏数组（含空洞）无法序列化成合法 JSON，按第一个空洞下标报错。 */
function assertDenseArray(value, length, path) {
  for (let index = 0; index < length; index += 1) {
    const descriptor = guarded(path, () => Object.getOwnPropertyDescriptor(value, String(index)));
    if (descriptor === undefined) {
      fail(ERROR_CODES.ERR_FIELD_TYPE, `${path}[${index}]`, 'Cannot canonicalize a sparse array');
    }
  }
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * 数组只能有 length 与"真正落在长度内"的数字索引这两类自有键。
 *
 * `arr = [1]; arr.x = 'y'` 过去会被序列化成 `[1]`，与 `[1]` 得到同一份摘要，
 * 等于让内容凭空消失；这里一律拒绝，并在 details.key 里给出违规键名。
 *
 * 只靠正则判定索引是不够的：`'4294967295'`（2**32-1，超出数组索引上界）与
 * `'01'` 一样能匹配到"数字样"的键，但都不会被写进 `[...]`，`arr['4294967295'] = 'HIDDEN'`
 * 依然会与 `[1]` 撞摘要。因此索引还必须满足 `key < value.length`——length 之外的
 * 自有数字键同样不属于序列化范围，必须 fail-closed。
 */
function assertNoExtraArrayKeys(value, length, path) {
  const names = guarded(path, () => Object.getOwnPropertyNames(value));
  for (const key of names) {
    if (key === 'length') continue;
    if (!ARRAY_INDEX.test(key)) {
      fail(
        ERROR_CODES.ERR_FIELD_TYPE,
        `${path}.${key}`,
        `Cannot canonicalize an array carrying the non-index key "${key}"`,
        { key },
      );
    }
    if (!(Number(key) < length)) {
      fail(
        ERROR_CODES.ERR_FIELD_TYPE,
        `${path}.${key}`,
        `Cannot canonicalize the array key "${key}" outside the array length`,
        { key },
      );
    }
    const enumerable = guarded(path, () => Object.prototype.propertyIsEnumerable.call(value, key));
    if (!enumerable) {
      fail(
        ERROR_CODES.ERR_FIELD_TYPE,
        `${path}[${key}]`,
        'Cannot canonicalize a non-enumerable array index',
        { key },
      );
    }
  }
  const symbols = guarded(path, () => Object.getOwnPropertySymbols(value));
  if (symbols.length > 0) {
    fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Cannot canonicalize symbol-keyed arrays', {
      symbols: symbols.map((symbol) => String(symbol)),
    });
  }
}

/**
 * 普通对象只能暴露可枚举的字符串键：Symbol 键与非枚举字符串键都无法写进规范化
 * 文本，若静默跳过，两个内容不同的对象会得到同一份摘要。
 */
function assertCanonicalObjectKeys(value, path) {
  const symbols = guarded(path, () => Object.getOwnPropertySymbols(value));
  if (symbols.length > 0) {
    fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Cannot canonicalize symbol-keyed objects', {
      symbols: symbols.map((symbol) => String(symbol)),
    });
  }
  const names = guarded(path, () => Object.getOwnPropertyNames(value));
  for (const key of names) {
    const enumerable = guarded(path, () => Object.prototype.propertyIsEnumerable.call(value, key));
    if (!enumerable) {
      fail(
        ERROR_CODES.ERR_FIELD_TYPE,
        `${path}.${key}`,
        `Cannot canonicalize the hidden key "${key}"`,
        { key },
      );
    }
  }
}

/**
 * 递归下降的深度上限（DEF-02）。
 *
 * `LIMITS.maxDepth` 过去只作用于 JSON 文本解析（`strict-json.js`），内存对象图的
 * 递归下降没有任何计数：4000 层嵌套会以原生 `RangeError` 结束，调用方拿到的是
 * 栈溢出而不是合同错误，而且"多深算合法"没有可判定答案。这里复用同一个常量，
 * 让两条入口（文本 / 对象图）的上限一致。
 *
 * 计数从根（深度 1）开始，只在进入对象/数组时递增；标量不占用深度。
 */
function serialize(value, path, stack, depth) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string') return quote(value, path);
  if (type === 'number') return writeNumber(value, path);
  if (type === 'object') {
    if (depth > LIMITS.maxDepth) {
      fail(
        ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED,
        path,
        `Cannot canonicalize deeper than ${LIMITS.maxDepth} levels`,
      );
    }
    if (stack.includes(value)) {
      fail(ERROR_CODES.ERR_INPUT_NOT_OBJECT, path, 'Cannot canonicalize a circular structure');
    }
    stack.push(value);
    let out;
    const isArray = Array.isArray(value);
    if (isArray) {
      const length = guarded(path, () => value.length);
      if (!Number.isSafeInteger(length) || length < 0) {
        fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Cannot canonicalize an array with an invalid length');
      }
      assertDenseArray(value, length, path);
      assertNoExtraArrayKeys(value, length, path);
      const items = [];
      for (let index = 0; index < length; index += 1) {
        const itemPath = `${path}[${index}]`;
        items.push(serialize(readDataProperty(value, String(index), itemPath), itemPath, stack, depth + 1));
      }
      out = `[${items.join(',')}]`;
    } else if (guarded(path, () => Object.getPrototypeOf(value)) === Object.prototype) {
      assertCanonicalObjectKeys(value, path);
      const keys = guarded(path, () => Object.keys(value)).sort();
      out = `{${keys
        .map((key) => {
          const keyPath = `${path}.${key}`;
          return `${quote(key, path)}:${serialize(readDataProperty(value, key, keyPath), keyPath, stack, depth + 1)}`;
        })
        .join(',')}}`;
    } else {
      fail(ERROR_CODES.ERR_INPUT_NOT_OBJECT, path, 'Only plain objects and arrays can be canonicalized');
    }
    stack.pop();
    return out;
  }
  fail(ERROR_CODES.ERR_FIELD_TYPE, path, `Cannot canonicalize a value of type ${type}`);
  return '';
}

/** 与键序、空白、转义写法无关的规范化 JSON 文本。 */
export function canonicalize(value) {
  try {
    return serialize(value, '$', [], 1);
  } catch (error) {
    if (isContractError(error)) throw error;
    // 兜底：任何仍未归类的异常都不得以原始类型逃出合同边界。
    throw unreadable('$', describeError(error));
  }
}

/** 规范化文本的 SHA-256，64 位小写 hex。 */
export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** 规范化文本的 UTF-8 字节数，用于对象大小上限判定。 */
export function canonicalSize(value) {
  return Buffer.byteLength(canonicalize(value), 'utf8');
}
