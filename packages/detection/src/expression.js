/**
 * expression.js — compilation and evaluation of the closed expression schema.
 *
 * A compiled expression is an immutable tree of `all` / `any` / `not` / leaf
 * nodes. Compilation enforces node count, depth, width and field declarations
 * once, at registration time, so evaluation is a bounded tree walk.
 */

import { RuleDefinitionError } from './errors.js';
import { isValidPath, resolveField } from './normalize.js';
import { evaluateOperator, isOperatorName, validateOperatorValue } from './operators.js';

/** Maximum number of nodes in one expression. */
export const MAX_EXPRESSION_NODES = 64;
/** Maximum nesting depth of one expression. */
export const MAX_EXPRESSION_DEPTH = 8;
/** Maximum number of children of one `all` / `any` node. */
export const MAX_BRANCH_WIDTH = 8;

const GROUP_KEYS = ['all', 'any', 'not', 'field'];
const LEAF_KEYS = ['field', 'operator', 'value'];

/**
 * Compile an expression against a declared field set.
 *
 * @param {unknown} expression Raw expression from the rule pack.
 * @param {{ declaredFields: ReadonlySet<string>, path?: string }} context Compilation context.
 * @returns {object} Frozen compiled tree.
 * @throws {RuleDefinitionError} When the schema, limits or field declarations are violated.
 */
export function compileExpression(expression, context) {
  const state = { nodes: 0, declaredFields: context.declaredFields, basePath: context.path ?? 'expression' };
  return compileNode(expression, state, 0);
}

/**
 * Evaluate a compiled expression.
 *
 * @param {object} compiled Result of {@link compileExpression}.
 * @param {object} event Event being evaluated.
 * @param {{ steps: number }} counter Step counter incremented once per leaf visit.
 * @returns {boolean} Expression result.
 */
export function evaluateExpression(compiled, event, counter) {
  return evaluateNode(compiled, event, counter);
}

function compileNode(node, state, depth, path = state.basePath) {
  const nodePath = path;
  if (depth > MAX_EXPRESSION_DEPTH) {
    throw new RuleDefinitionError(`expression exceeds maximum depth ${MAX_EXPRESSION_DEPTH}`, {
      code: 'RULE_EXPRESSION_DEPTH',
      path: nodePath,
    });
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new RuleDefinitionError('expression node must be an object', {
      code: 'RULE_EXPRESSION_SHAPE',
      path: nodePath,
    });
  }
  state.nodes += 1;
  if (state.nodes > MAX_EXPRESSION_NODES) {
    throw new RuleDefinitionError(`expression exceeds maximum node count ${MAX_EXPRESSION_NODES}`, {
      code: 'RULE_EXPRESSION_NODES',
      path: nodePath,
    });
  }
  const keys = Object.keys(node);
  const discriminants = keys.filter((key) => GROUP_KEYS.includes(key));
  if (discriminants.length !== 1) {
    throw new RuleDefinitionError('expression node must contain exactly one of all/any/not/field', {
      code: 'RULE_EXPRESSION_SHAPE',
      path: nodePath,
      detail: { keys },
    });
  }
  const discriminant = discriminants[0];
  if (discriminant === 'field') {
    return compileLeaf(node, state, nodePath);
  }
  if (keys.length !== 1) {
    throw new RuleDefinitionError(`expression node ${discriminant} has unknown keys`, {
      code: 'RULE_EXPRESSION_UNKNOWN_KEY',
      path: nodePath,
      detail: { keys },
    });
  }
  if (discriminant === 'not') {
    return Object.freeze({ kind: 'not', child: compileNode(node.not, state, depth + 1, `${nodePath}.not`) });
  }
  const children = node[discriminant];
  if (!Array.isArray(children) || children.length < 1 || children.length > MAX_BRANCH_WIDTH) {
    throw new RuleDefinitionError(`${discriminant} requires 1..${MAX_BRANCH_WIDTH} child expressions`, {
      code: 'RULE_EXPRESSION_WIDTH',
      path: nodePath,
    });
  }
  const compiledChildren = children.map((child, index) =>
    compileNode(child, state, depth + 1, `${nodePath}.${discriminant}[${index}]`),
  );
  return Object.freeze({ kind: discriminant, children: Object.freeze(compiledChildren) });
}

function compileLeaf(node, state, nodePath) {
  const keys = Object.keys(node);
  for (const key of keys) {
    if (!LEAF_KEYS.includes(key)) {
      throw new RuleDefinitionError(`expression leaf has unknown key ${key}`, {
        code: 'RULE_EXPRESSION_UNKNOWN_KEY',
        path: nodePath,
        detail: { keys },
      });
    }
  }
  const field = node.field;
  if (!isValidPath(field)) {
    throw new RuleDefinitionError(`expression field path is not usable: ${String(field)}`, {
      code: 'RULE_FIELD_PATH',
      path: nodePath,
    });
  }
  if (!state.declaredFields.has(field)) {
    throw new RuleDefinitionError(`expression reads undeclared field ${field}`, {
      code: 'RULE_FIELD_UNDECLARED',
      path: nodePath,
      detail: { field },
    });
  }
  const operator = node.operator;
  if (!isOperatorName(operator)) {
    throw new RuleDefinitionError(`unknown operator: ${String(operator)}`, {
      code: 'RULE_OPERATOR_UNKNOWN',
      path: nodePath,
      detail: { operator: String(operator) },
    });
  }
  validateOperatorValue(operator, node.value, nodePath);
  const hasValue = operator !== 'exists' && operator !== 'absent';
  if (!hasValue && node.value !== undefined) {
    throw new RuleDefinitionError(`${operator} does not accept a value`, {
      code: 'RULE_OPERATOR_VALUE',
      path: nodePath,
    });
  }
  return Object.freeze({ kind: 'leaf', field, operator, value: node.value });
}

function evaluateNode(node, event, counter) {
  if (node.kind === 'leaf') {
    counter.steps += 1;
    // 把字段路径一并传下去：数据故障的缺口要能指到具体字段（DEF-11）。
    return evaluateOperator(node.operator, resolveField(event, node.field), node.value, node.field);
  }
  if (node.kind === 'not') {
    return !evaluateNode(node.child, event, counter);
  }
  if (node.kind === 'all') {
    for (const child of node.children) {
      if (!evaluateNode(child, event, counter)) {
        return false;
      }
    }
    return true;
  }
  for (const child of node.children) {
    if (evaluateNode(child, event, counter)) {
      return true;
    }
  }
  return false;
}
