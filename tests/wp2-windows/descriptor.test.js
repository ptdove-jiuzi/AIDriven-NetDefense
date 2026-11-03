import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPLETENESS,
  WINDOWS_ERROR_CODES,
  assessPermissions,
  connectionsDescriptor,
  createSourceDescriptor,
  degradedFields,
  describeEventLog,
  directoriesDescriptor,
  processDescriptor,
  runKeysDescriptor,
  scheduledTasksDescriptor,
  servicesDescriptor,
} from '../../packages/collectors/windows/index.js';

const POLL_DESCRIPTORS = [
  processDescriptor(),
  connectionsDescriptor(),
  servicesDescriptor(),
  scheduledTasksDescriptor(),
  runKeysDescriptor(),
  directoriesDescriptor({ roots: [{ id: 'a', path: 'C:\\a' }] }),
];

function validConfig(overrides = {}) {
  return {
    stableSourceId: 'windows.demo-table',
    type: 'windows.demo',
    kind: 'poll',
    intervalMs: 5_000,
    permissions: { required: ['read'], optional: [], degradedWithout: [] },
    fields: [{ name: 'pid', type: 'integer', completeness: 'always', sensitivity: 'D1' }],
    blindSpots: ['nothing'],
    gapSemantics: ['none'],
    rotation: 'none',
    ...overrides,
  };
}

test('every poll source declares permissions, interval, field completeness, blind spots and rotation', () => {
  for (const descriptor of POLL_DESCRIPTORS) {
    assert.equal(descriptor.kind, 'poll', descriptor.stableSourceId);
    assert.equal(descriptor.permissions.required.length > 0, true, `${descriptor.stableSourceId} has no required permission`);
    assert.equal(descriptor.blindSpots.length > 0, true, `${descriptor.stableSourceId} claims no blind spot`);
    assert.equal(descriptor.gapSemantics.length > 0, true, `${descriptor.stableSourceId} declares no gap semantics`);
    assert.equal(typeof descriptor.rotation, 'string');
    assert.match(descriptor.rotation, /none|record_id_reuse|log_cleared/u, `${descriptor.stableSourceId} rotation must state its semantics`);
    assert.equal(descriptor.generationAware, false, `${descriptor.stableSourceId} must not take part in generation detection`);
    for (const field of descriptor.fields) {
      assert.equal(COMPLETENESS.includes(field.completeness), true);
      assert.match(field.name, /^[a-z][a-z0-9_]*$/u, 'field names are payload keys');
    }
  }
});

test('the event-log descriptor is declared per channel and is generation aware', () => {
  const security = describeEventLog('Security');
  const sysmon = describeEventLog('Microsoft-Windows-Sysmon/Operational');

  assert.notEqual(security.stableSourceId, sysmon.stableSourceId);
  assert.equal(security.generationAware, true);
  assert.equal(security.kind, 'event');
  assert.match(security.permissions.required[0], /Security/u);
  assert.match(sysmon.permissions.required[0], /Microsoft-Windows-Sysmon/u);
});

test('a descriptor missing a declaration is rejected instead of published half-documented', () => {
  assert.throws(() => createSourceDescriptor(validConfig({ permissions: undefined })), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG);
  assert.throws(() => createSourceDescriptor(validConfig({ blindSpots: [] })), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG);
  assert.throws(() => createSourceDescriptor(validConfig({ gapSemantics: [] })), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG);
  assert.throws(() => createSourceDescriptor(validConfig({ rotation: '' })), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG);
  assert.throws(() => createSourceDescriptor(validConfig({ type: 'windows' })), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG);
});

test('a descriptor with an invalid interval, kind, field or sensitivity is rejected', () => {
  assert.throws(() => createSourceDescriptor(validConfig({ intervalMs: 0 })), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG);
  assert.throws(() => createSourceDescriptor(validConfig({ kind: 'stream' })), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG);
  assert.throws(
    () => createSourceDescriptor(validConfig({ fields: [{ name: 'imagePath', type: 'string', completeness: 'always', sensitivity: 'D1' }] })),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG,
  );
  assert.throws(
    () => createSourceDescriptor(validConfig({ fields: [{ name: 'pid', type: 'integer', completeness: 'sometimes', sensitivity: 'D1' }] })),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG,
  );
  assert.throws(
    () => createSourceDescriptor(validConfig({ fields: [{ name: 'pid', type: 'integer', completeness: 'always', sensitivity: 'D9' }] })),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG,
  );
});

test('an invalid stable source id is rejected by the shared identity contract', () => {
  assert.throws(
    () => createSourceDescriptor(validConfig({ stableSourceId: 'WindowsDemo' })),
    (error) => error.code === 'INVALID_SOURCE_ID',
  );
});

test('the highest declared sensitivity is surfaced so the pipeline can classify the source', () => {
  const descriptor = createSourceDescriptor(validConfig({
    fields: [
      { name: 'pid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
      { name: 'command_line', type: 'string', completeness: 'admin', sensitivity: 'D2' },
    ],
  }));
  assert.equal(descriptor.sensitivity, 'D2');
});

test('field loss without elevation is derived from the declaration, not guessed', () => {
  const descriptor = processDescriptor();
  assert.deepEqual([...degradedFields(descriptor, { elevated: false })], ['image_path', 'command_line']);
  assert.deepEqual([...degradedFields(descriptor, { elevated: true })], []);
});

test('assessing held permissions separates "unavailable" from "partial view"', () => {
  const descriptor = processDescriptor();

  const complete = assessPermissions(descriptor, [...descriptor.permissions.required]);
  assert.equal(complete.available, true);
  assert.deepEqual([...complete.missing], []);
  assert.deepEqual([...complete.degraded], [], 'a fully privileged read loses no field');

  const denied = assessPermissions(descriptor, []);
  assert.equal(denied.available, false);
  assert.deepEqual([...denied.missing], [...descriptor.permissions.required]);
  assert.deepEqual([...denied.degraded], ['image_path', 'command_line']);
});
