/**
 * correlation.test.js — ordered correlation steps, time windows, slot budget.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestEngine, makeEvent } from './helpers.js';

const correlationRule = {
  ruleId: 'chain.example',
  version: '1.0.0',
  type: 'correlation',
  severity: 'high',
  fields: ['process.name', 'user.name'],
  groupBy: ['user.name'],
  withinMs: 60000,
  steps: [
    { name: 'spawn', when: { field: 'process.name', operator: 'eq', value: 'example-process' } },
    { name: 'connect', when: { field: 'process.name', operator: 'eq', value: 'example-net' } },
  ],
};

function chainEvent(eventId, observedAt, processName, userName = 'example-user') {
  return makeEvent({
    eventId,
    observedAt,
    fields: { process: { name: processName }, user: { name: userName } },
  });
}

describe('ordered correlation', () => {
  it('fires once when the steps arrive in order', () => {
    const engine = createTestEngine({ rules: [correlationRule] });
    const result = engine.ingest([chainEvent('evt-c1', 1000, 'example-process'), chainEvent('evt-c2', 2000, 'example-net')]);
    assert.equal(result.detections.length, 1);
    assert.deepEqual(result.detections[0].matchedSteps, ['spawn', 'connect']);
    assert.equal(result.detections[0].ruleType, 'correlation');
    assert.equal(result.detections[0].observedAt, 2000);
    assert.equal(result.alerts.length, 1);
  });

  it('does not fire when the steps arrive in reverse order', () => {
    const engine = createTestEngine({ rules: [correlationRule] });
    const result = engine.ingest([chainEvent('evt-c3', 1000, 'example-net'), chainEvent('evt-c4', 2000, 'example-process')]);
    assert.equal(result.detections.length, 0);
    assert.equal(engine.stats().detections, 0);
  });

  it('does not fire when the chain exceeds the window', () => {
    const engine = createTestEngine({ rules: [correlationRule] });
    const result = engine.ingest([chainEvent('evt-c5', 1000, 'example-process'), chainEvent('evt-c6', 70000, 'example-net')]);
    assert.equal(result.detections.length, 0);
    assert.equal(engine.stats().expiredStates, 1);
  });

  it('accepts a second chain after the slot is cleared', () => {
    const engine = createTestEngine({ rules: [correlationRule] });
    engine.ingest([chainEvent('evt-c7', 1000, 'example-process'), chainEvent('evt-c8', 2000, 'example-net')]);
    const second = engine.ingest([chainEvent('evt-c9', 3000, 'example-process'), chainEvent('evt-c10', 4000, 'example-net')]);
    assert.equal(second.detections.length, 1);
    assert.deepEqual(second.detections[0].eventIds, ['evt-c10']);
    assert.equal(engine.stats().detections, 2);
  });

  it('keeps the first step armed while an unexpected step arrives', () => {
    const engine = createTestEngine({ rules: [correlationRule] });
    const result = engine.ingest([
      chainEvent('evt-c11', 1000, 'example-process'),
      chainEvent('evt-c12', 2000, 'example-other'),
      chainEvent('evt-c13', 3000, 'example-net'),
    ]);
    assert.equal(result.detections.length, 1);
    assert.deepEqual(result.detections[0].matchedSteps, ['spawn', 'connect']);
  });

  it('rejects new slots past the global slot budget and reports a gap', () => {
    const engine = createTestEngine({ rules: [correlationRule], limits: { maxCorrelationSlots: 1 } });
    const result = engine.ingest([
      chainEvent('evt-c14', 1000, 'example-process', 'example-user'),
      chainEvent('evt-c15', 2000, 'example-process', 'example-other'),
    ]);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].kind, 'correlation-slot-limit');
    assert.equal(result.gaps[0].ruleId, 'chain.example');
    assert.equal(engine.stats().gapsByKind['correlation-slot-limit'], 1);
    assert.equal(engine.stats().correlationSlots, 1);
    assert.equal(result.detections.length, 0);
  });

  it('reports live correlation slots in stats', () => {
    const engine = createTestEngine({ rules: [correlationRule] });
    assert.equal(engine.stats().correlationSlots, 0);
    engine.ingest([chainEvent('evt-slot-1', 1000, 'example-process')]);
    assert.equal(engine.stats().correlationSlots, 1);
    engine.ingest([chainEvent('evt-slot-2', 2000, 'example-net')]);
    assert.equal(engine.stats().correlationSlots, 0);
    engine.ingest([chainEvent('evt-slot-3', 3000, 'example-process')]);
    assert.equal(engine.stats().correlationSlots, 1);
    engine.advanceTo(700000);
    assert.equal(engine.stats().correlationSlots, 0);
    assert.equal(engine.stats().expiredStates, 1);
  });

  it('rejects correlation rules that declare a rule level expression', () => {
    assert.throws(
      () =>
        createTestEngine({
          rules: [
            {
              ...correlationRule,
              when: { field: 'process.name', operator: 'eq', value: 'example-process' },
            },
          ],
        }),
      (error) => error.code === 'RULE_UNKNOWN_KEY',
    );
  });

  it('rejects correlation rules with too few or duplicated steps', () => {
    assert.throws(
      () => createTestEngine({ rules: [{ ...correlationRule, steps: [correlationRule.steps[0]] }] }),
      (error) => error.code === 'RULE_STEPS_INVALID',
    );
    assert.throws(
      () => createTestEngine({ rules: [{ ...correlationRule, steps: [correlationRule.steps[0], correlationRule.steps[0]] }] }),
      (error) => error.code === 'RULE_STEPS_INVALID',
    );
  });
});
