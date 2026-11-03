// author: PT-dove
// M9 对抗语料 —— detection 表达式 / 运算符 / 规则包。
//
// 重点回答两个问题：
// 1. 有没有"正则求值面"？答案必须是**没有**：规则作者只能选封闭运算符表里的一格，
//    `contains` 是字面量子串匹配，不是模式编���。恶意正则因此不是"被拒绝"，
//    而是**根本不存在可注入的地方**——这两件事的测试写法不一样，这里取后者。
// 2. 表达式树的规模上限（节点数 / 深度 / 宽度）在注册期一次判定，运行期只剩有界遍历。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_BRANCH_WIDTH,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_NODES,
  OPERATOR_NAMES,
  RuleDefinitionError,
  compileExpression,
  evaluateExpression,
  evaluateOperator,
  isOperatorName,
  validateOperatorValue,
  validateRulePack,
} from '../../packages/detection/index.js';
import { expectRejection } from './support/harness.js';
import { detectionEvent, rulePack } from './support/fixtures.js';

const DECLARED = new Set(['process.name', 'process.path', 'event.type']);

function compile(expression) {
  return compileExpression(expression, { declaredFields: DECLARED, path: 'when' });
}

function leaf(overrides = {}) {
  return { field: 'process.name', operator: 'eq', value: 'x', ...overrides };
}

test('运算符表是封闭的：没有 matches / regex / glob 之类的模式求值入口', () => {
  assert.deepEqual([...OPERATOR_NAMES], [
    'absent',
    'contains',
    'ends_with',
    'eq',
    'exists',
    'gt',
    'gte',
    'in',
    'lt',
    'lte',
    'ne',
    'not_in',
    'starts_with',
  ]);
  for (const forbidden of ['matches', 'regex', 'regexp', 'glob', 'like', 'match', 'script']) {
    assert.equal(isOperatorName(forbidden), false, `${forbidden} must not exist`);
    expectRejection(() => validateOperatorValue(forbidden, 'x'), {
      code: 'RULE_OPERATOR_UNKNOWN',
      type: RuleDefinitionError,
      label: forbidden,
    });
  }
});

test('contains 是字面子串匹配，不是模式匹配（"恶意正则"没有落点）', () => {
  // 如果 contains 走了 RegExp，`^root$` 会匹配 "root"；字面匹配则不会。
  assert.equal(evaluateOperator('contains', 'root', '^root$'), false);
  assert.equal(evaluateOperator('contains', 'x^root$y', '^root$'), true);
  // `(a+)+$` 这类灾难性回溯模式在这里只是一串普通字符。
  assert.equal(evaluateOperator('contains', 'a'.repeat(40000), '(a+)+$'), false);
  assert.equal(evaluateOperator('contains', `x(a+)+$y`, '(a+)+$'), true);
});

test('starts_with / ends_with / eq 同样不做模式解释', () => {
  assert.equal(evaluateOperator('starts_with', 'abc', '.*'), false);
  assert.equal(evaluateOperator('ends_with', 'abc', '$'), false);
  assert.equal(evaluateOperator('eq', 'abc', 'a.c'), false);
  assert.equal(evaluateOperator('eq', 'abc', 'ABC'), false, 'eq 对大小写敏感');
});

test('字符串比较前做 NFKC 归一化：全角与半角等价，但不是"模糊匹配"', () => {
  assert.equal(evaluateOperator('eq', 'ＡＢＣ', 'ABC'), true, 'NFKC folds full-width forms');
  assert.equal(evaluateOperator('eq', 'ABC ', 'ABC'), true, 'trailing whitespace is trimmed');
  assert.equal(evaluateOperator('eq', 'A  B', 'A B'), true, 'whitespace runs collapse');
  assert.equal(evaluateOperator('eq', 'ABC', 'AB'), false);
});

test('类型不匹配永远返回 false 而不是抛错（恶意字段类型不能中断求值）', () => {
  const hostileFieldValues = [null, undefined, 42, true, [], {}, Symbol('s'), () => 1, new Map()];
  for (const value of hostileFieldValues) {
    assert.equal(evaluateOperator('contains', value, 'x'), false);
    assert.equal(evaluateOperator('starts_with', value, 'x'), false);
    assert.equal(evaluateOperator('lt', value, 1), false);
    assert.equal(evaluateOperator('in', value, ['x']), false);
  }
});

test('缺失值的语义固定：ne / not_in / absent 为真，其余为假', () => {
  const missing = [undefined, null];
  for (const value of missing) {
    assert.equal(evaluateOperator('eq', value, 'x'), false);
    assert.equal(evaluateOperator('ne', value, 'x'), true);
    assert.equal(evaluateOperator('not_in', value, ['x']), true);
    assert.equal(evaluateOperator('absent', value), true);
    assert.equal(evaluateOperator('exists', value), false);
  }
});

test('in / not_in 的列表上限 64，超限在注册期拒绝', () => {
  const tooLong = Array.from({ length: 65 }, (_, index) => `v${index}`);
  expectRejection(() => validateOperatorValue('in', tooLong), {
    code: 'RULE_OPERATOR_VALUE',
    type: RuleDefinitionError,
  });
  const atLimit = Array.from({ length: 64 }, (_, index) => `v${index}`);
  validateOperatorValue('in', atLimit);
  assert.equal(evaluateOperator('in', 'v63', atLimit), true);
});

test('运算符字面量类型错误在注册期拒绝', () => {
  expectRejection(() => validateOperatorValue('lt', '1'), { code: 'RULE_OPERATOR_VALUE', type: RuleDefinitionError });
  expectRejection(() => validateOperatorValue('lt', Number.NaN), {
    code: 'RULE_OPERATOR_VALUE',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateOperatorValue('contains', 1), {
    code: 'RULE_OPERATOR_VALUE',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateOperatorValue('eq', { a: 1 }), {
    code: 'RULE_OPERATOR_VALUE',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateOperatorValue('exists', 'x'), {
    code: 'RULE_OPERATOR_VALUE',
    type: RuleDefinitionError,
  });
});

test('表达式节点数上限：57 个节点通过，73 个拒绝', () => {
  const leaves = (count) => Array.from({ length: count }, () =>
    leaf({ field: 'process.name', value: 'example-process' }));

  // 1 个根 + 7 个 any + 49 个叶子 = 57 个节点。
  const withinBudget = { all: Array.from({ length: 7 }, () => ({ any: leaves(7) })) };
  const compiled = compile(withinBudget);
  const counter = { steps: 0 };
  evaluateExpression(compiled, detectionEvent(), counter);
  // any 在第一个为真的孩子处短路：7 个分组各访问 1 个叶子 = 7 步。
  // 断言精确值而不是区间，才能证明"求值次数由表达式结构决定"，而不是看运气。
  assert.equal(counter.steps, 7, 'each any short-circuits on its first matching leaf');
  assert.ok(counter.steps <= 57, 'evaluated leaves stay inside the node budget');
  assert.ok(57 <= MAX_EXPRESSION_NODES);

  // 1 个根 + 8 个 any + 64 个叶子 = 73 个节点 > 64。
  const overBudget = { all: Array.from({ length: 8 }, () => ({ any: leaves(8) })) };
  expectRejection(() => compile(overBudget), { code: 'RULE_EXPRESSION_NODES', type: RuleDefinitionError });
});

test('表达式深度上限：叶子落在第 8 层通过，第 9 层拒绝', () => {
  // compileNode 从 depth=0 起算，每一层 not/all 让 depth+1。
  let ok = leaf();
  for (let depth = 0; depth < MAX_EXPRESSION_DEPTH; depth += 1) ok = { not: ok };
  compile(ok);

  let tooDeep = leaf();
  for (let depth = 0; depth <= MAX_EXPRESSION_DEPTH; depth += 1) tooDeep = { not: tooDeep };
  expectRejection(() => compile(tooDeep), { code: 'RULE_EXPRESSION_DEPTH', type: RuleDefinitionError });
});

test('分支宽度上限：8 个孩子通过，9 个拒绝', () => {
  const children = (count) => Array.from({ length: count }, (_, index) => leaf({ value: `v${index}` }));
  compile({ any: children(MAX_BRANCH_WIDTH) });
  expectRejection(() => compile({ any: children(MAX_BRANCH_WIDTH + 1) }), {
    code: 'RULE_EXPRESSION_WIDTH',
    type: RuleDefinitionError,
  });
  expectRejection(() => compile({ all: [] }), { code: 'RULE_EXPRESSION_WIDTH', type: RuleDefinitionError });
});

test('形状违规：非对象节点、两个判别键、多余键、未知键都拒绝', () => {
  for (const node of [null, 1, 'x', [], true]) {
    expectRejection(() => compile(node), { code: 'RULE_EXPRESSION_SHAPE', type: RuleDefinitionError });
  }
  expectRejection(() => compile({ all: [leaf()], any: [leaf()] }), {
    code: 'RULE_EXPRESSION_SHAPE',
    type: RuleDefinitionError,
  });
  expectRejection(() => compile({ ...leaf(), extra: 1 }), {
    code: 'RULE_EXPRESSION_UNKNOWN_KEY',
    type: RuleDefinitionError,
  });
  expectRejection(() => compile({ all: [leaf()], extra: 1 }), {
    code: 'RULE_EXPRESSION_UNKNOWN_KEY',
    type: RuleDefinitionError,
  });
});

test('字段路径：危险段、数字段、空段、超长一律拒绝（RULE_FIELD_PATH）', () => {
  for (const field of ['__proto__', 'process.__proto__', 'constructor', 'a..b', 'a.0', 'a'.repeat(300), '']) {
    expectRejection(() => compile(leaf({ field })), { code: 'RULE_FIELD_PATH', type: RuleDefinitionError });
  }
});

test('字段路径合法但未声明时按未声明拒绝（错误码区分"不能用"与"没声明"）', () => {
  expectRejection(() => compile(leaf({ field: 'process.unknown' })), {
    code: 'RULE_FIELD_UNDECLARED',
    type: RuleDefinitionError,
  });
  // 已声明的路径照常编译通过，证明上一条不是"路径接收器一律报错"。
  compile(leaf({ field: 'event.type', value: 'process_start' }));
});

test('读取未声明字段在注册期拒绝（不能靠字符串拼出隐藏字段）', () => {
  const expression = { field: 'process.name', operator: 'eq', value: 'x' };
  expectRejection(() => compileExpression(expression, { declaredFields: new Set(['other.field']), path: 'when' }), {
    code: 'RULE_FIELD_UNDECLARED',
    type: RuleDefinitionError,
  });
});

test('exists / absent 带 value 时拒绝（避免"看起来生效但其实被忽略"的规则）', () => {
  expectRejection(() => compile(leaf({ operator: 'exists', value: 1 })), {
    code: 'RULE_OPERATOR_VALUE',
    type: RuleDefinitionError,
  });
});

test('规则包：未知键、缺规则、重复 ruleId、非法版本、保留字段全部拒绝', () => {
  const base = rulePack();
  expectRejection(() => validateRulePack({ ...base, extra: 1 }), {
    code: 'RULE_PACK_UNKNOWN_KEY',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateRulePack({ ...base, rules: [] }), {
    code: 'RULE_PACK_RULES',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateRulePack({ ...base, schemaVersion: '2.0' }), {
    code: 'RULE_PACK_VERSION_MISMATCH',
    type: RuleDefinitionError,
  });
  expectRejection(
    () => validateRulePack({ ...base, rules: [base.rules[0], { ...base.rules[0] }] }),
    { code: 'RULE_ID_DUPLICATE', type: RuleDefinitionError },
  );
  expectRejection(
    () => validateRulePack({ ...base, rules: [{ ...base.rules[0], ruleId: 'AEGIS.Core' }] }),
    { code: 'RULE_ID_INVALID', type: RuleDefinitionError },
  );
  expectRejection(
    () => validateRulePack({ ...base, rules: [{ ...base.rules[0], version: '1.0' }] }),
    { code: 'RULE_VERSION_INVALID', type: RuleDefinitionError },
  );
  expectRejection(
    () => validateRulePack({ ...base, rules: [{ ...base.rules[0], type: 'script' }] }),
    { code: 'RULE_TYPE_INVALID', type: RuleDefinitionError },
  );
  expectRejection(
    () => validateRulePack({ ...base, rules: [{ ...base.rules[0], severity: 'apocalyptic' }] }),
    { code: 'RULE_SEVERITY_INVALID', type: RuleDefinitionError },
  );
});

test('规则包：windowMs / count.value 的边界在注册期裁剪', () => {
  const threshold = {
    ...rulePack().rules[0],
    type: 'threshold',
    groupBy: ['process.name'],
    count: { operator: 'gte', value: 2 },
    windowMs: 60_000,
  };
  const pack = (rule) => ({ ...rulePack(), rules: [rule] });
  validateRulePack(pack(threshold));
  expectRejection(() => validateRulePack(pack({ ...threshold, windowMs: 999 })), {
    code: 'RULE_RANGE_INVALID',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateRulePack(pack({ ...threshold, windowMs: 3_600_001 })), {
    code: 'RULE_RANGE_INVALID',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateRulePack(pack({ ...threshold, count: { operator: 'gte', value: 0 } })), {
    code: 'RULE_RANGE_INVALID',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateRulePack(pack({ ...threshold, count: { operator: 'gt', value: 2 } })), {
    code: 'RULE_COUNT_INVALID',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateRulePack(pack({ ...threshold, count: 2 })), {
    code: 'RULE_COUNT_INVALID',
    type: RuleDefinitionError,
  });
});

test('关联规则的步骤数量与重名在注册期拒绝', () => {
  const base = rulePack().rules[0];
  const step = { name: 'a', when: leaf() };
  const correlation = {
    ruleId: base.ruleId,
    version: base.version,
    type: 'correlation',
    severity: 'high',
    fields: ['process.name'],
    fingerprint: ['process.name'],
    withinMs: 60_000,
    steps: [step, { ...step, name: 'b' }],
  };
  const pack = (rule) => ({ ...rulePack(), rules: [rule] });
  validateRulePack(pack(correlation));
  expectRejection(() => validateRulePack(pack({ ...correlation, steps: [step] })), {
    code: 'RULE_STEPS_INVALID',
    type: RuleDefinitionError,
  });
  expectRejection(() => validateRulePack(pack({ ...correlation, steps: [step, step] })), {
    code: 'RULE_STEPS_INVALID',
    type: RuleDefinitionError,
  });
  expectRejection(
    () => validateRulePack(pack({ ...correlation, steps: [{ ...step, extra: 1 }, { ...step, name: 'b' }] })),
    { code: 'RULE_STEPS_INVALID', type: RuleDefinitionError },
  );
});

test('已编译规则包直接返回（幂等），重复校验不会因为编译器状态漂移', () => {
  const first = validateRulePack(rulePack());
  const second = validateRulePack(first);
  assert.equal(first, second);
  assert.ok(Object.isFrozen(first));
});

test('指纹规格上限 8 个字段，超限拒绝', () => {
  const rule = {
    ...rulePack().rules[0],
    fields: ['process.name'],
    fingerprint: Array.from({ length: 9 }, () => 'process.name'),
  };
  expectRejection(() => validateRulePack({ ...rulePack(), rules: [rule] }), {
    code: 'RULE_FINGERPRINT_INVALID',
    type: RuleDefinitionError,
  });
});

test('标签与描述的长度上限在注册期拒绝', () => {
  const base = rulePack().rules[0];
  expectRejection(
    () => validateRulePack({ ...rulePack(), rules: [{ ...base, tags: Array.from({ length: 9 }, () => 't') }] }),
    { code: 'RULE_TAGS_INVALID', type: RuleDefinitionError },
  );
  expectRejection(
    () => validateRulePack({ ...rulePack(), rules: [{ ...base, tags: ['x'.repeat(33)] }] }),
    { code: 'RULE_TAGS_INVALID', type: RuleDefinitionError },
  );
  expectRejection(
    () => validateRulePack({ ...rulePack(), rules: [{ ...base, description: 'x'.repeat(201) }] }),
    { code: 'RULE_SHAPE', type: RuleDefinitionError },
  );
});
