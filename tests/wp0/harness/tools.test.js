import assert from 'node:assert/strict';
import test from 'node:test';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import {
  apply,
  createDefenseToolDefinitions,
  DEFENSE_TOOL_NAMES,
} from '../../../plugins/dsh-defense-tools/lib/index.js';

test('only two closed defense tools are registered and guard rejects every other tool', () => {
  const registered = [];
  let guard;
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
      },
      guard(callback) {
        guard = callback;
      },
    },
  };
  apply(ctx);
  assert.deepEqual(registered.map((definition) => definition.name), DEFENSE_TOOL_NAMES);
  assert.equal(typeof guard, 'function');
  assert.equal(guard({ name: 'evidence.get_summary' }), undefined);
  assert.match(guard({ name: 'shell.exec' }), /not approved/);
  assert.match(guard({ name: 'fs.read' }), /not approved/);
  assert.match(guard({ name: 'working-directory.set' }), /not approved/);
  for (const definition of registered) {
    assert.equal(definition.parameters.additionalProperties, false);
  }
});

test('tool argument validation rejects unknown fields before any broker call', async () => {
  const [evidence] = createDefenseToolDefinitions();
  const valid = { evidenceRef: 'synthetic-ref', fields: ['severity'] };
  assert.deepEqual(validateJsonSchemaValue(evidence.parameters, valid, ''), []);
  assert.ok(validateJsonSchemaValue(evidence.parameters, { ...valid, rawPath: 'C:/real/secret.log' }, '').length > 0);
  await assert.rejects(
    async () => evidence.execute({ ...valid, rawPath: 'C:/real/secret.log' }, {}),
    (error) => error.code === 'INVALID_ARGS',
  );
  await assert.rejects(
    async () => evidence.execute(valid, {}),
    (error) => error.code === 'WP0_BROKER_UNAVAILABLE',
  );
});
