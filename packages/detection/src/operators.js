/**
 * operators.js — the closed operator table used by rule expressions.
 *
 * Every operator is a plain function over already resolved values. There is no
 * pattern evaluation and no code generation: the table is the complete surface
 * a rule author can address.
 */

import { RuleDefinitionError, UnreadableFieldError } from './errors.js';
import { isMissingValue, normalizeText } from './normalize.js';

const MAX_LIST_ITEMS = 64;

const TABLE = {
  eq: { missingResult: false, validate: validateScalar, test: (field, value) => equalish(field, value) },
  ne: { missingResult: true, validate: validateScalar, test: (field, value) => !equalish(field, value) },
  lt: { missingResult: false, validate: validateNumber, test: (field, value) => compareNumbers(field, value) === -1 },
  lte: {
    missingResult: false,
    validate: validateNumber,
    test: (field, value) => {
      const order = compareNumbers(field, value);
      return order === -1 || order === 0;
    },
  },
  gt: { missingResult: false, validate: validateNumber, test: (field, value) => compareNumbers(field, value) === 1 },
  gte: {
    missingResult: false,
    validate: validateNumber,
    test: (field, value) => {
      const order = compareNumbers(field, value);
      return order === 1 || order === 0;
    },
  },
  in: { missingResult: false, validate: validateList, test: (field, value) => memberOf(field, value) },
  not_in: { missingResult: true, validate: validateList, test: (field, value) => !memberOf(field, value) },
  contains: {
    missingResult: false,
    validate: validateText,
    test: (field, value, path) => containsValue(field, value, path),
  },
  starts_with: { missingResult: false, validate: validateText, test: (field, value) => prefixOrSuffix(field, value, true) },
  ends_with: { missingResult: false, validate: validateText, test: (field, value) => prefixOrSuffix(field, value, false) },
  exists: { missingResult: false, validate: validateNoValue, test: (field) => !isMissingValue(field) },
  absent: { missingResult: true, validate: validateNoValue, test: (field) => isMissingValue(field) },
};

/** All operator names in lexicographic order. @type {readonly string[]} */
export const OPERATOR_NAMES = Object.freeze(Object.keys(TABLE).sort());

/**
 * Report whether a name is a known operator.
 *
 * @param {unknown} name Candidate operator name.
 * @returns {boolean} `true` when the operator exists in the table.
 */
export function isOperatorName(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(TABLE, name);
}

/**
 * Validate the literal value bound to an operator during rule compilation.
 *
 * @param {string} operator Operator name.
 * @param {unknown} value Literal value from the rule.
 * @param {string} [path] Location used in the thrown error.
 * @returns {void}
 * @throws {RuleDefinitionError} When the operator is unknown or the literal does
 *   not match the operator contract.
 */
export function validateOperatorValue(operator, value, path = 'operators') {
  if (!isOperatorName(operator)) {
    throw new RuleDefinitionError(`unknown operator: ${String(operator)}`, {
      code: 'RULE_OPERATOR_UNKNOWN',
      path,
      detail: { operator: String(operator), allowed: [...OPERATOR_NAMES] },
    });
  }
  TABLE[operator].validate(value, operator, path);
}

/**
 * Evaluate an operator against a resolved field value.
 *
 * Missing values follow a fixed table: `ne`, `not_in` and `absent` are `true`,
 * every other operator is `false`. Type mismatches always evaluate to `false`
 * and never throw.
 *
 * @param {string} operator Operator name.
 * @param {unknown} fieldValue Resolved field value.
 * @param {unknown} value Literal value.
 * @param {string | null} [fieldPath] Dotted field path, for the gap detail (DEF-11).
 * @returns {boolean} Operator result.
 * @throws {RuleDefinitionError} When the operator is unknown.
 */
export function evaluateOperator(operator, fieldValue, value, fieldPath = null) {
  const entry = TABLE[operator];
  if (entry === undefined) {
    throw new RuleDefinitionError(`unknown operator: ${String(operator)}`, {
      code: 'RULE_OPERATOR_UNKNOWN',
      path: 'operator',
      detail: { operator: String(operator) },
    });
  }
  if (isMissingValue(fieldValue)) {
    return entry.missingResult;
  }
  return entry.test(fieldValue, value, fieldPath) === true;
}

function equalish(left, right) {
  if (left === right) {
    return true;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return normalizeText(left) === normalizeText(right);
  }
  return false;
}

function compareNumbers(left, right) {
  if (typeof left !== 'number' || typeof right !== 'number') {
    return null;
  }
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function memberOf(field, value) {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((item) => equalish(field, item));
}

function containsValue(field, value, fieldPath = null) {
  if (typeof field === 'string' && typeof value === 'string') {
    return field.includes(value);
  }
  if (Array.isArray(field)) {
    // 事件值上的任何方法调用都是**数据读取**（DEF-11）：`Array.isArray(proxyArray)` 为真，
    // 但读 `field.some` 会触发 Proxy 的 get 陷阱并抛错。旧实现让这个异常落到
    // `evaluateRule` 的兜底分支 → `isolateRule` → 规则被永久隔离，
    // 于是"一条带数组字段的畸形事件"就能让一条规则在后续所有批次里闭嘴。
    // 统一转成 UnreadableFieldError，由引擎降级为"本事件不命中 + 记缺口"。
    let hit;
    try {
      hit = field.some((item) => equalish(item, value));
    } catch (error) {
      const reason = error !== null && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : String(error);
      throw new UnreadableFieldError(`field "${fieldPath ?? '<value>'}" cannot be read as an array: ${reason}`, {
        path: fieldPath,
        detail: { segment: null, reason },
      });
    }
    return hit;
  }
  return false;
}

function prefixOrSuffix(field, value, prefix) {
  if (typeof field !== 'string' || typeof value !== 'string') {
    return false;
  }
  return prefix ? field.startsWith(value) : field.endsWith(value);
}

function validateScalar(value, operator, path) {
  const type = typeof value;
  if (value === null || type === 'string' || type === 'number' || type === 'boolean') {
    if (type === 'number' && !Number.isFinite(value)) {
      throw new RuleDefinitionError(`${operator} requires a finite number`, { code: 'RULE_OPERATOR_VALUE', path });
    }
    return;
  }
  throw new RuleDefinitionError(`${operator} requires a scalar literal`, { code: 'RULE_OPERATOR_VALUE', path });
}

function validateNumber(value, operator, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RuleDefinitionError(`${operator} requires a finite number literal`, { code: 'RULE_OPERATOR_VALUE', path });
  }
}

function validateText(value, operator, path) {
  if (typeof value !== 'string') {
    throw new RuleDefinitionError(`${operator} requires a string literal`, { code: 'RULE_OPERATOR_VALUE', path });
  }
}

function validateList(value, operator, path) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new RuleDefinitionError(`${operator} requires an array of at most ${MAX_LIST_ITEMS} scalars`, {
      code: 'RULE_OPERATOR_VALUE',
      path,
    });
  }
  for (const item of value) {
    validateScalar(item, operator, path);
  }
}

function validateNoValue(value, operator, path) {
  if (value !== undefined) {
    throw new RuleDefinitionError(`${operator} does not accept a value`, { code: 'RULE_OPERATOR_VALUE', path });
  }
}
