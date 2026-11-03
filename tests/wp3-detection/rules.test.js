/**
 * rules.test.js — declarative rule semantics: operators, declared fields, closed
 * schema, thresholds and allowlists.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RuleDefinitionError } from '../../packages/detection/index.js';
import { createTestEngine, deepFreeze, makeConditionRule, makeEvent, makePack } from './helpers.js';

function detectionsFor(when, event, declaredFields = ['process.name']) {
  const rule = makeConditionRule({ when, fields: declaredFields, fingerprint: [declaredFields[0]] });
  const engine = createTestEngine({ rules: [rule] });
  return engine.ingest([event]).detections;
}

function eventWith(fields) {
  return makeEvent({ fields });
}

function expectRuleError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof RuleDefinitionError, `expected RuleDefinitionError, received ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('operator semantics', () => {
  it('matches and rejects equality and inequality', () => {
    const matching = eventWith({ process: { name: '  example-process  ' } });
    assert.equal(detectionsFor({ field: 'process.name', operator: 'eq', value: 'example-process' }, matching).length, 1);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'eq', value: 'other-process' }, matching).length, 0);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'ne', value: 'other-process' }, matching).length, 1);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'ne', value: 'example-process' }, matching).length, 0);
  });

  it('matches and rejects list membership', () => {
    const event = eventWith({ process: { name: 'example-process' } });
    const list = ['example-process', 'example-helper'];
    assert.equal(detectionsFor({ field: 'process.name', operator: 'in', value: list }, event).length, 1);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'in', value: ['other-process'] }, event).length, 0);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'not_in', value: ['other-process'] }, event).length, 1);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'not_in', value: list }, event).length, 0);
  });

  it('compares numbers only when both sides are numbers', () => {
    const numeric = eventWith({ process: { pid: 4242 } });
    const textual = eventWith({ process: { pid: '4242' } });
    assert.equal(detectionsFor({ field: 'process.pid', operator: 'gt', value: 4000 }, numeric, ['process.pid']).length, 1);
    assert.equal(detectionsFor({ field: 'process.pid', operator: 'gt', value: 5000 }, numeric, ['process.pid']).length, 0);
    assert.equal(detectionsFor({ field: 'process.pid', operator: 'gte', value: 4242 }, numeric, ['process.pid']).length, 1);
    assert.equal(detectionsFor({ field: 'process.pid', operator: 'lt', value: 4242 }, numeric, ['process.pid']).length, 0);
    assert.equal(detectionsFor({ field: 'process.pid', operator: 'lte', value: 4242 }, numeric, ['process.pid']).length, 1);
    assert.equal(detectionsFor({ field: 'process.pid', operator: 'gt', value: 4000 }, textual, ['process.pid']).length, 0);
  });

  it('handles substring and prefix/suffix checks', () => {
    const event = eventWith({ process: { name: 'example-process', path: '/tmp/example/tool' } });
    assert.equal(
      detectionsFor({ field: 'process.path', operator: 'contains', value: '/tmp/example' }, event, ['process.path']).length,
      1,
    );
    assert.equal(
      detectionsFor({ field: 'process.path', operator: 'contains', value: '/TMP/EXAMPLE' }, event, ['process.path']).length,
      0,
    );
    assert.equal(
      detectionsFor({ field: 'process.path', operator: 'starts_with', value: '/tmp/' }, event, ['process.path']).length,
      1,
    );
    assert.equal(
      detectionsFor({ field: 'process.path', operator: 'starts_with', value: '/var/' }, event, ['process.path']).length,
      0,
    );
    assert.equal(
      detectionsFor({ field: 'process.name', operator: 'ends_with', value: '-process' }, event, ['process.name']).length,
      1,
    );
    assert.equal(
      detectionsFor({ field: 'process.name', operator: 'ends_with', value: '-helper' }, event, ['process.name']).length,
      0,
    );
  });

  it('contains matches array elements', () => {
    const event = eventWith({ user: { roles: ['example-admin', 'example-user'] } });
    assert.equal(detectionsFor({ field: 'user.roles', operator: 'contains', value: 'example-admin' }, event, ['user.roles']).length, 1);
    assert.equal(detectionsFor({ field: 'user.roles', operator: 'contains', value: 'example-guest' }, event, ['user.roles']).length, 0);
  });

  it('distinguishes present and absent fields', () => {
    const present = eventWith({ process: { name: 'example-process' } });
    const missing = eventWith({ process: { path: '/tmp/example/tool' } });
    assert.equal(detectionsFor({ field: 'process.name', operator: 'exists' }, present).length, 1);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'absent' }, present).length, 0);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'exists' }, missing).length, 0);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'absent' }, missing).length, 1);
  });

  it('applies the fixed missing value table', () => {
    const missing = eventWith({ process: { path: '/tmp/example/tool' } });
    assert.equal(detectionsFor({ field: 'process.name', operator: 'ne', value: 'example-process' }, missing).length, 1);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'not_in', value: ['example-process'] }, missing).length, 1);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'gt', value: 0 }, missing).length, 0);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'eq', value: 'example-process' }, missing).length, 0);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'in', value: ['example-process'] }, missing).length, 0);
  });

  it('never throws on type mismatch', () => {
    const event = eventWith({ process: { name: { nested: 'example' } } });
    assert.equal(detectionsFor({ field: 'process.name', operator: 'eq', value: 'example-process' }, event).length, 0);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'contains', value: 'example' }, event).length, 0);
    assert.equal(detectionsFor({ field: 'process.name', operator: 'gte', value: 1 }, event).length, 0);
  });

  it('reads top level event fields as field paths', () => {
    const event = makeEvent({ type: 'network_connect' });
    assert.equal(detectionsFor({ field: 'type', operator: 'eq', value: 'network_connect' }, event, ['type']).length, 1);
  });
});

describe('registration time validation', () => {
  it('rejects fields that are not declared', () => {
    expectRuleError(
      () =>
        createTestEngine({
          rules: [makeConditionRule({ when: { field: 'process.parent', operator: 'eq', value: 'x' }, fields: ['process.name'] })],
        }),
      'RULE_FIELD_UNDECLARED',
    );
  });

  it('rejects unknown keys inside expression nodes', () => {
    expectRuleError(
      () =>
        createTestEngine({
          rules: [
            makeConditionRule({
              when: { field: 'process.name', operator: 'eq', value: 'x', script: 'return true' },
            }),
          ],
        }),
      'RULE_EXPRESSION_UNKNOWN_KEY',
    );
  });

  it('rejects unknown operators', () => {
    expectRuleError(
      () => createTestEngine({ rules: [makeConditionRule({ when: { field: 'process.name', operator: 'matches', value: '.*' } })] }),
      'RULE_OPERATOR_UNKNOWN',
    );
    expectRuleError(
      () => createTestEngine({ rules: [makeConditionRule({ when: { field: 'process.name', operator: 'gte', value: '10' } })] }),
      'RULE_OPERATOR_VALUE',
    );
  });

  it('rejects expressions that are too deep', () => {
    let expression = { field: 'process.name', operator: 'eq', value: 'example-process' };
    for (let index = 0; index < 9; index += 1) {
      expression = { not: expression };
    }
    expectRuleError(() => createTestEngine({ rules: [makeConditionRule({ when: expression })] }), 'RULE_EXPRESSION_DEPTH');
  });

  it('rejects expressions that are too wide', () => {
    const children = [];
    for (let index = 0; index < 9; index += 1) {
      children.push({ field: 'process.name', operator: 'eq', value: 'example-process' });
    }
    expectRuleError(
      () => createTestEngine({ rules: [makeConditionRule({ when: { all: children } })] }),
      'RULE_EXPRESSION_WIDTH',
    );
  });

  it('rejects expressions with too many nodes', () => {
    const groups = [];
    for (let outer = 0; outer < 8; outer += 1) {
      const children = [];
      for (let inner = 0; inner < 8; inner += 1) {
        children.push({ field: 'process.name', operator: 'eq', value: 'example-process' });
      }
      groups.push({ any: children });
    }
    expectRuleError(() => createTestEngine({ rules: [makeConditionRule({ when: { all: groups } })] }), 'RULE_EXPRESSION_NODES');
  });

  it('rejects rule packs that carry executable looking keys', () => {
    expectRuleError(
      () => createTestEngine({ rules: [makeConditionRule({ script: 'process.exit(0)' })] }),
      'RULE_UNKNOWN_KEY',
    );
    expectRuleError(
      () => createTestEngine({ rules: [makeConditionRule({ when: { field: 'process.name', operator: 'eq', value: 'x', type: 'condition' } })] }),
      'RULE_EXPRESSION_UNKNOWN_KEY',
    );
  });
});

describe('threshold rules', () => {
  const thresholdRule = {
    ruleId: 'proc.burst',
    version: '2.0.0',
    type: 'threshold',
    severity: 'medium',
    fields: ['process.name'],
    groupBy: ['process.name'],
    count: { operator: 'gte', value: 3 },
    windowMs: 60000,
  };

  function burstEvent(index, observedAt) {
    return makeEvent({
      eventId: `evt-burst-${index}`,
      observedAt,
      fields: { process: { name: 'example-process' } },
    });
  }

  it('fires once at the threshold and stays quiet inside the window', () => {
    const engine = createTestEngine({ rules: [thresholdRule] });
    const first = engine.ingest([burstEvent(1, 1000), burstEvent(2, 2000), burstEvent(3, 3000)]);
    assert.equal(first.detections.length, 1);
    assert.equal(first.detections[0].observations, 3);
    assert.equal(first.detections[0].ruleType, 'threshold');
    const second = engine.ingest([burstEvent(4, 4000), burstEvent(5, 5000)]);
    assert.equal(second.detections.length, 0);
    assert.equal(engine.stats().detections, 1);
  });

  it('re-arms after the window drains and ignores hits outside the window', () => {
    const engine = createTestEngine({ rules: [thresholdRule] });
    engine.ingest([burstEvent(1, 1000), burstEvent(2, 2000), burstEvent(3, 3000)]);
    const drained = engine.ingest([burstEvent(4, 200000)]);
    assert.equal(drained.detections.length, 0);
    const rearmed = engine.ingest([burstEvent(5, 201000), burstEvent(6, 202000)]);
    assert.equal(rearmed.detections.length, 1);
    assert.equal(rearmed.detections[0].observations, 3);
  });

  it('does not count hits that fail the optional expression', () => {
    const gated = {
      ...thresholdRule,
      when: { field: 'process.name', operator: 'eq', value: 'example-process' },
    };
    const engine = createTestEngine({ rules: [gated] });
    const result = engine.ingest([
      burstEvent(1, 1000),
      makeEvent({ eventId: 'evt-other-1', observedAt: 2000, fields: { process: { name: 'other-process' } } }),
      makeEvent({ eventId: 'evt-other-2', observedAt: 3000, fields: { process: { name: 'other-process' } } }),
    ]);
    assert.equal(result.detections.length, 0);
  });

  it('rejects threshold rules with unknown count operators', () => {
    expectRuleError(
      () => createTestEngine({ rules: [{ ...thresholdRule, count: { operator: 'gt', value: 3 } }] }),
      'RULE_COUNT_INVALID',
    );
    expectRuleError(() => createTestEngine({ rules: [{ ...thresholdRule, windowMs: 999 }] }), 'RULE_RANGE_INVALID');
  });
});

describe('allowlist', () => {
  const allowEntry = {
    allowId: 'allow.example',
    reason: 'synthetic maintenance window',
    fields: ['process.name'],
    when: { field: 'process.name', operator: 'eq', value: 'example-process' },
  };

  it('suppresses matching events without touching the caller object', () => {
    const engine = createTestEngine({ rules: [makeConditionRule()], allowlist: [allowEntry] });
    const event = deepFreeze(
      makeEvent({ eventId: 'evt-allow-1', fields: { process: { name: 'example-process', path: '/tmp/example/tool' } } }),
    );
    const snapshot = JSON.parse(JSON.stringify(event));
    const result = engine.ingest([event]);
    assert.equal(result.detections.length, 0);
    assert.equal(result.alerts.length, 0);
    assert.equal(result.eventsSuppressed, 1);
    assert.equal(result.decisions[0].outcome, 'suppressed');
    assert.equal(result.decisions[0].allowId, 'allow.example');
    assert.deepEqual(event, snapshot);
    assert.equal(engine.stats().eventsSuppressed, 1);
    assert.deepEqual(engine.suppressions(), [
      { allowId: 'allow.example', eventId: 'evt-allow-1', at: 0, reason: 'synthetic maintenance window' },
    ]);
  });

  it('ignores expired entries and counts them once', () => {
    const engine = createTestEngine({
      rules: [makeConditionRule()],
      allowlist: [{ ...allowEntry, expiresAt: 500 }],
      startAt: 1000,
    });
    const result = engine.ingest([makeEvent({ eventId: 'evt-allow-2', observedAt: 1000 })]);
    assert.equal(result.detections.length, 1);
    assert.equal(result.eventsSuppressed, 0);
    assert.equal(engine.stats().allowlistExpired, 1);
  });

  it('limits suppression to the listed rules only', () => {
    const otherRule = makeConditionRule({ ruleId: 'proc.example-other', severity: 'low' });
    const engine = createTestEngine({
      rules: [makeConditionRule(), otherRule],
      allowlist: [{ ...allowEntry, ruleIds: ['proc.example-start'] }],
    });
    const result = engine.ingest([makeEvent({ eventId: 'evt-allow-3' })]);
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].ruleId, 'proc.example-other');
    assert.equal(result.decisions[0].outcome, 'suppressed');
    assert.deepEqual(result.decisions[0].ruleIds, ['proc.example-other']);
  });

  it('rejects allowlist expressions that read undeclared fields', () => {
    expectRuleError(
      () =>
        createTestEngine({
          rules: [makeConditionRule()],
          allowlist: [{ ...allowEntry, when: { field: 'process.parent', operator: 'eq', value: 'x' } }],
        }),
      'RULE_FIELD_UNDECLARED',
    );
  });
});

describe('rule pack shape', () => {
  it('keeps rule order and exposes tags on detections', () => {
    const tagged = makeConditionRule({ tags: ['process', 'synthetic'] });
    const engine = createTestEngine({ rules: [tagged] });
    const result = engine.ingest([makeEvent({ eventId: 'evt-tag-1' })]);
    assert.deepEqual(result.detections[0].tags, ['process', 'synthetic']);
    assert.equal(result.detections[0].ruleVersion, '1.0.0');
    assert.equal(result.detections[0].eventIds[0], 'evt-tag-1');
  });

  it('rejects duplicate rule identifiers inside one pack', () => {
    expectRuleError(
      () => createTestEngine({ rulePack: makePack([makeConditionRule(), makeConditionRule()]) }),
      'RULE_ID_DUPLICATE',
    );
  });
});
