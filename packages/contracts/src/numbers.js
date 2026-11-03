import { ContractError, ERROR_CODES } from './errors.js';

const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;
const FLOAT_TOKEN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** -0 规范化为 0，其余原样返回。 */
export function normalizeZero(value) {
  return value === 0 ? 0 : value;
}

export function assertFiniteNumber(value, path = '$') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractError(
      ERROR_CODES.ERR_NUMBER_NOT_FINITE,
      path,
      'Number must be a finite IEEE-754 double',
    );
  }
  return normalizeZero(value);
}

export function assertSafeInteger(value, path = '$') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ContractError(
      ERROR_CODES.ERR_NUMBER_PRECISION_LOSS,
      path,
      'Integer must be inside the IEEE-754 safe integer range',
    );
  }
  return normalizeZero(value);
}

/**
 * 解析整数 token：既要落在安全整数内，也要保证十进制原文与双精度值一致，
 * 这样 9007199254740993 这类"看起来是整数"的字面量不会被静默截断。
 */
export function parseIntegerToken(token, path = '$') {
  if (!INTEGER_TOKEN.test(token)) {
    throw new ContractError(ERROR_CODES.ERR_JSON_SYNTAX, path, 'Malformed integer token');
  }
  const value = Number(token);
  if (!Number.isSafeInteger(value)) {
    throw new ContractError(
      ERROR_CODES.ERR_NUMBER_PRECISION_LOSS,
      path,
      'Integer literal exceeds Number.MAX_SAFE_INTEGER',
    );
  }
  if (BigInt(token) !== BigInt(value)) {
    throw new ContractError(
      ERROR_CODES.ERR_NUMBER_PRECISION_LOSS,
      path,
      'Integer literal cannot be represented exactly as a double',
    );
  }
  return normalizeZero(value);
}

const FLOAT_PARTS = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

/**
 * 把十进制字面量归一化成 `{ negative, digits, exponent }`：
 * 数值 = `digits * 10 ** exponent`，`digits` 已去掉前导零与尾随零（全零时为 `''`）。
 *
 * 归一化的目的不是求值，而是**比较两份十进制写法是否表示同一个十进制数**：
 * `1000` / `1e3` / `1000.0` 都归一成 `1e3`，而 `1.0000000000000001` 归一成
 * `10000000000000001e-16`，与 `1` 不同。这样"字面量"与"双精度值"可以直接对账，
 * 不需要构造有理数、也不会因为指数很大而展开十次幂。
 *
 * @param {string} token 十进制字面量（已通过语法校验）。
 * @returns {{negative: boolean, digits: string, exponent: number} | null}
 */
function canonicalDecimal(token) {
  const match = FLOAT_PARTS.exec(token);
  if (match === null) {
    return null;
  }
  const fraction = match[3] ?? '';
  const raw = `${match[2]}${fraction}`.replace(/^0+/u, '');
  if (raw === '') {
    // 全零：符号与指数都不改变"这是 0"。
    return { negative: false, digits: '', exponent: 0 };
  }
  const digits = raw.replace(/0+$/u, '');
  const exponent = Number(match[4] ?? '0') - fraction.length + (raw.length - digits.length);
  return { negative: match[1] === '-', digits, exponent };
}

function sameDecimal(left, right) {
  return left.negative === right.negative
    && left.digits === right.digits
    && left.exponent === right.exponent;
}

/**
 * 解析带小数或指数的 token。
 *
 * 与整数路径对齐（DEF-01）：不仅要求有限，还要求**字面量本身就能精确表示成这个
 * 双精度值**。判据是"最短往返"——`String(value)` 给出的是唯一能往返的最短十进制写法，
 * 字面量归一化后必须与它相等：
 *
 * - `1e-400` → 双精度值是 `0`，但 `0` 的最短写法是 `"0"`，两者不等 → 拒绝下溢；
 * - `1.0000000000000001` → 双精度值是 `1`，最短写法 `"1"` → 拒绝静默舍入；
 * - `0.1` / `1.5` / `1e3` / `100.0` → 与最短写法一致 → 照常接受。
 *
 * 这条判据是"精度丢失"与"合法浮点"的分界：`0.1` 在二进制里确实不精确，但它是
 * 双精度值 `0.1000000000000000055511151231257827` 的唯一最短十进制写法，字面量
 * 与值一一对应，摘要不会把两份不同的字节混成一个；而 `1.0000000000000001` 会被
 * 静默压成 `1`，同一份内容因此有多种字节表示、却只有一个摘要。
 *
 * @param {string} token 数字字面量。
 * @param {string} [path] 出错时的 JSON 路径。
 * @returns {number} 归一化后的有限双精度值（`-0` 归一为 `0`）。
 * @throws {ContractError} `ERR_JSON_SYNTAX` / `ERR_NUMBER_NOT_FINITE` / `ERR_NUMBER_PRECISION_LOSS`。
 */
export function parseFloatToken(token, path = '$') {
  if (!FLOAT_TOKEN.test(token)) {
    throw new ContractError(ERROR_CODES.ERR_JSON_SYNTAX, path, 'Malformed numeric token');
  }
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new ContractError(
      ERROR_CODES.ERR_NUMBER_NOT_FINITE,
      path,
      'Numeric literal is not representable as a finite double',
    );
  }
  const literal = canonicalDecimal(token);
  const shortest = canonicalDecimal(String(value));
  if (literal === null || shortest === null || !sameDecimal(literal, shortest)) {
    throw new ContractError(
      ERROR_CODES.ERR_NUMBER_PRECISION_LOSS,
      path,
      'Float literal cannot be represented exactly as a double: its value has a different '
        + 'shortest decimal form, so two different literals would share one digest',
    );
  }
  return normalizeZero(value);
}
