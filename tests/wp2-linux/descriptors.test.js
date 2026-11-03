/**
 * Every source must declare, in data: permissions, polling interval, field completeness,
 * short-lived-object blind spots, rotation handling, gap semantics and the no-permission
 * degradation rule. These tests are the enforcement of that requirement; without them the
 * seven declarations would just be comments.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { GAP_REASONS, isValidStableSourceId } from '../../packages/collectors/common/index.js';
import {
  AUTH_LOG_DESCRIPTOR,
  CONNECTION_DESCRIPTOR,
  CRON_DESCRIPTOR,
  DIRECTORY_SOURCE_ID,
  FIELD_COMPLETENESS,
  GAP_REASON_BY_CONDITION,
  JOURNALD_DESCRIPTOR,
  LINUX_SOURCE_IDS,
  PROCESS_DESCRIPTOR,
  SENSITIVITY_LEVELS,
  SYSTEMD_DESCRIPTOR,
  assertAllSourceDescriptors,
  assertReadResult,
  assertSourceDescriptor,
  defaultLinuxSourceDescriptors,
  describeDeclaredDirectorySource,
  gapReasonFor,
} from '../../packages/collectors/linux/index.js';

const ALL_DESCRIPTORS = Object.freeze([
  PROCESS_DESCRIPTOR,
  CONNECTION_DESCRIPTOR,
  JOURNALD_DESCRIPTOR,
  AUTH_LOG_DESCRIPTOR,
  SYSTEMD_DESCRIPTOR,
  CRON_DESCRIPTOR,
  describeDeclaredDirectorySource(),
]);

test('the registry exposes exactly the seven first-version Linux sources', () => {
  const ids = defaultLinuxSourceDescriptors().map((descriptor) => descriptor.stableSourceId);
  assert.deepEqual([...ids].sort(), Object.values(LINUX_SOURCE_IDS).sort());
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, ids.length, 'stable source ids must be unique');
});

test('every descriptor declares permissions, interval, fields, blind spots, rotation, gaps and degradation', () => {
  for (const descriptor of assertAllSourceDescriptors()) {
    assert.ok(descriptor.permissions.required.length > 0, `${descriptor.stableSourceId} must declare a required permission`);
    assert.ok(descriptor.intervalMs >= 1, `${descriptor.stableSourceId} must declare a positive interval`);
    assert.ok(descriptor.fields.length > 0);
    assert.ok(descriptor.blindSpots.length > 0, `${descriptor.stableSourceId} must declare blind spots`);
    assert.equal(typeof descriptor.rotation, 'string');
    assert.ok(descriptor.rotation.length > 10);
    assert.ok(descriptor.gapSemantics.length > 0);
    assert.equal(descriptor.degradation.neverHealthyWhenEmpty, true);
    assert.ok(descriptor.declaredPaths.length > 0);
  }
});

test('the design matrix cadence is what the descriptors declare', () => {
  assert.equal(PROCESS_DESCRIPTOR.intervalMs, 5_000, 'process: 5 s poll');
  assert.equal(CONNECTION_DESCRIPTOR.intervalMs, 5_000, 'network: 5 s poll');
  assert.equal(SYSTEMD_DESCRIPTOR.intervalMs, 60_000, 'services: 60 s');
  assert.equal(CRON_DESCRIPTOR.intervalMs, 60_000, 'tasks: 60 s');
  assert.equal(describeDeclaredDirectorySource().intervalMs, 60_000, 'file metadata: 60 s reconciliation');
  assert.equal(JOURNALD_DESCRIPTOR.kind, 'event');
  assert.equal(JOURNALD_DESCRIPTOR.subscriptionProbeIntervalMs, 30_000, 'event sources probe every 30 s');
});

test('no first-version source requires root', () => {
  for (const descriptor of ALL_DESCRIPTORS) {
    assert.equal(descriptor.requiresRoot, false, `${descriptor.stableSourceId} must work without root`);
    assert.ok(
      descriptor.permissions.optional.length > 0,
      `${descriptor.stableSourceId} must state what root would additionally give`,
    );
  }
});

test('every declared field has a valid completeness and sensitivity level', () => {
  for (const descriptor of ALL_DESCRIPTORS) {
    for (const field of descriptor.fields) {
      assert.ok(FIELD_COMPLETENESS.includes(field.completeness), `${descriptor.stableSourceId}.${field.name}`);
      assert.ok(SENSITIVITY_LEVELS.includes(field.sensitivity), `${descriptor.stableSourceId}.${field.name}`);
    }
  }
});

test('fields that need elevated read access are declared admin, never always', () => {
  const processExe = PROCESS_DESCRIPTOR.fields.find((field) => field.name === 'exe_path');
  const processCmdline = PROCESS_DESCRIPTOR.fields.find((field) => field.name === 'cmdline');
  const connectionPid = CONNECTION_DESCRIPTOR.fields.find((field) => field.name === 'pid');
  assert.equal(processExe.completeness, 'admin');
  assert.equal(processCmdline.completeness, 'admin');
  assert.equal(connectionPid.completeness, 'admin');
  // The degraded fields must be the ones named in degradedWithout.
  assert.deepEqual([...PROCESS_DESCRIPTOR.permissions.degradedWithout].sort(), ['cmdline', 'exe_path']);
  assert.deepEqual([...CONNECTION_DESCRIPTOR.permissions.degradedWithout].sort(), ['pid', 'process_name']);
});

test('every emitted gap reason belongs to the shared closed reason set', () => {
  const known = new Set(GAP_REASONS);
  for (const descriptor of ALL_DESCRIPTORS) {
    for (const reason of descriptor.emittedGapReasons) {
      assert.ok(known.has(reason), `${descriptor.stableSourceId} emits unknown gap reason ${reason}`);
    }
  }
});

test('every source-specific condition maps onto a shared gap reason', () => {
  const known = new Set(GAP_REASONS);
  for (const condition of Object.keys(GAP_REASON_BY_CONDITION)) {
    const mapped = gapReasonFor(condition);
    assert.ok(known.has(mapped), `${condition} maps to unknown ${mapped}`);
  }
  assert.throws(() => gapReasonFor('not_a_condition'), /No gap reason mapping/);
});

test('blind spots mention short-lived objects for every polling table source', () => {
  const pollSources = [PROCESS_DESCRIPTOR, CONNECTION_DESCRIPTOR];
  for (const descriptor of pollSources) {
    const text = descriptor.blindSpots.join(' ').toLowerCase();
    assert.match(text, /shorter than|inside one/, `${descriptor.stableSourceId} must declare the short-life blind spot`);
  }
  assert.match(CRON_DESCRIPTOR.blindSpots.join(' '), /at jobs/);
  assert.match(SYSTEMD_DESCRIPTOR.blindSpots.join(' '), /Drop-in/);
});

test('rotation is described for every source, including the ones that cannot rotate', () => {
  for (const descriptor of ALL_DESCRIPTORS) {
    assert.match(descriptor.rotation, /^(none|file identity|journald cursor)/, descriptor.stableSourceId);
  }
  assert.match(AUTH_LOG_DESCRIPTOR.rotation, /dev:ino/);
  assert.match(JOURNALD_DESCRIPTOR.rotation, /cursor/);
});

test('a descriptor missing any of the seven declarations is rejected', () => {
  const base = { ...PROCESS_DESCRIPTOR };
  const cases = [
    ['permissions', { ...base, permissions: undefined }],
    ['intervalMs', { ...base, intervalMs: undefined }],
    ['fields', { ...base, fields: undefined }],
    ['blindSpots', { ...base, blindSpots: [] }],
    ['rotation', { ...base, rotation: '' }],
    ['gapSemantics', { ...base, gapSemantics: [] }],
    ['degradation', { ...base, degradation: undefined }],
  ];
  for (const [label, candidate] of cases) {
    assert.throws(
      () => assertSourceDescriptor(candidate),
      (error) => error.name === 'LinuxCollectorError' && /must be/.test(error.message),
      `${label} must be required`,
    );
  }
});

test('a degradation declaration that would allow a healthy empty read is rejected', () => {
  assert.throws(() => assertSourceDescriptor({
    ...PROCESS_DESCRIPTOR,
    degradation: { ...PROCESS_DESCRIPTOR.degradation, neverHealthyWhenEmpty: false },
  }), /neverHealthyWhenEmpty/);
});

test('a descriptor declaring an unknown gap reason is rejected', () => {
  assert.throws(() => assertSourceDescriptor({
    ...PROCESS_DESCRIPTOR,
    emittedGapReasons: ['definitely_not_a_reason'],
  }), /Unknown shared gap reason/);
});

test('duplicate stable source ids are rejected by the registry validator', () => {
  const duplicated = [PROCESS_DESCRIPTOR, PROCESS_DESCRIPTOR];
  assert.throws(() => assertAllSourceDescriptors(duplicated), /duplicate Linux stable source id/);
});

test('stable source ids follow the shared lowercase dot-separated format', () => {
  for (const descriptor of ALL_DESCRIPTORS) {
    assert.equal(isValidStableSourceId(descriptor.stableSourceId), true, descriptor.stableSourceId);
    assert.match(descriptor.stableSourceId, /^linux\./);
  }
});

test('the directories source refuses more than the design limit of 32 roots', () => {
  const roots = Array.from({ length: 33 }, (_, index) => `/srv/root${index}`);
  assert.throws(() => describeDeclaredDirectorySource({ roots }), /at most 32 declared roots/);
  const accepted = describeDeclaredDirectorySource({ roots: roots.slice(0, 32) });
  assert.equal(accepted.declaredPaths.length, 32);
});

test('the directories source names the inotify reconciliation relationship in its gap semantics', () => {
  const descriptor = describeDeclaredDirectorySource();
  const text = descriptor.gapSemantics.join(' ');
  assert.match(text, /maxEntriesPerRoot|unreadable root|unchanged tree/);
  assert.match(descriptor.blindSpots.join(' '), /60 s reconciliation/);
  assert.match(descriptor.blindSpots.join(' '), /Metadata only/);
  assert.equal(descriptor.stableSourceId, DIRECTORY_SOURCE_ID);
});

test('a read result that omits denials is validated, not crashed on', () => {
  // A source that never denies anything legitimately omits the field. The validator
  // normalizes it to `[]` and must judge the "ok cannot hide denials" invariant on that
  // normalized value: reading `result.denials.length` threw
  // `TypeError: Cannot read properties of undefined (reading 'length')` on a perfectly
  // valid `{status:'ok', records:[]}`.
  const omitted = { status: 'ok', records: [] };
  assert.equal(assertReadResult(omitted, { stableSourceId: 'linux.test' }), omitted);
  assert.equal(assertReadResult({ status: 'ok', records: [], denials: [] }).status, 'ok');

  // The invariant itself is unchanged: a partial read may carry denials, an ok read may not.
  const partial = { status: 'partial', records: [], denials: [{ path: '/var/log/auth.log', code: 'EACCES' }] };
  assert.equal(assertReadResult(partial).status, 'partial');
  assert.throws(
    () => assertReadResult({ status: 'ok', records: [], denials: [{ path: '/var/log/auth.log', code: 'EACCES' }] }),
    /must report status partial or denied, never ok/u,
  );
  // And an omitted field must not become a way to smuggle a non-array through.
  assert.throws(() => assertReadResult({ status: 'ok', records: [], denials: null }), /denials must be an array/u);
});
