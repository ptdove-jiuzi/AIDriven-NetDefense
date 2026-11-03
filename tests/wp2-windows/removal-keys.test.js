/**
 * Regression tests for the dedupe-window interaction of `removed` / reverted events.
 *
 * These deliberately run against a **real** `createSourceCollector` + `createCursorStore`
 * (through `createTestCollector`), not a stub: the bug only exists at the seam between the
 * differ's native record id and the common layer's dedupe window keyed on it. A stub would
 * reproduce the key but not the loss.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  DIRECTORIES_INTERVAL_MS,
  DIRECTORIES_SOURCE_ID,
  SERVICES_INTERVAL_MS,
  SERVICES_SOURCE_ID,
  createDirectoriesSource,
  createServicesSource,
  createSourceBinding,
} from '../../packages/collectors/windows/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';
import { createClock, createScriptedPowerShell, createTestCollector } from './helpers.js';

const BASE = 1_700_000_000_000;

function withSandbox(t) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-removal-' });
  t.after(sandbox.cleanup);
  return sandbox;
}

/** Bind a source onto a real collector with its own cursor store and dedupe window. */
function bind(sandbox, source, clock, { stableSourceId, intervalMs }) {
  const { collector, capability } = createTestCollector({
    sandbox,
    source: { stableSourceId, kind: 'poll', intervalMs },
    clock,
  });
  const binding = createSourceBinding({ source, collector, clock });
  return { binding, collector, capability };
}

function service(overrides = {}) {
  return {
    name: 'Spooler',
    displayName: 'Print Spooler',
    state: 'Running',
    startMode: 'Auto',
    logonAccount: 'LocalSystem',
    binaryPath: 'C:\\Windows\\System32\\spoolsv.exe',
    serviceType: 'Own Process',
    processId: 1420,
    ...overrides,
  };
}

test('a real collector publishes the removal instead of deduplicating it away', async (t) => {
  // Regression: the removal reused the digest of the last observed state, so its stable key was
  // byte-identical to the `snapshot` event published one poll earlier. The dedupe window
  // reported `duplicates 1` and the deletion was lost for the full 24 h TTL.
  const sandbox = withSandbox(t);
  const clock = createClock(BASE);
  // The cursor store lives in workRoot, so the walked root is a dedicated subdirectory:
  // otherwise the store own file would join the snapshot and skew every count.
  const root = join(sandbox.workRoot, 'scan');
  mkdirSync(root, { recursive: true });
  const filePath = join(root, 'watched.txt');
  writeFileSync(filePath, 'v1');

  const source = createDirectoriesSource({ roots: [{ id: 'work', path: root }], clock });
  const { binding } = bind(sandbox, source, clock, {
    stableSourceId: DIRECTORIES_SOURCE_ID,
    intervalMs: DIRECTORIES_INTERVAL_MS,
  });

  const first = await binding.poll();
  assert.equal(first.published, 1);
  assert.equal(first.items[0].event.payload.change, 'snapshot');

  rmSync(filePath);
  const second = await binding.poll();

  assert.equal(second.published, 1, 'the removal must reach the queue');
  assert.equal(second.duplicates, 0, 'the removal key must differ from the present key');
  assert.equal(second.items[0].event.payload.change, 'removed');
  assert.equal(second.items[0].event.payload.present, false);
});

test('a state reverted to a previously seen value is published after A -> B -> A', async (t) => {
  // Regression: reverting to a value the entity had already been observed in produced the very
  // same stable key as the earlier event, so the revert was dropped as a duplicate.
  const sandbox = withSandbox(t);
  const clock = createClock(BASE);
  const routes = { services: [service({ binaryPath: 'C:\\one\\a.exe' })] };
  const source = createServicesSource({ powershell: createScriptedPowerShell(routes), clock });
  const { binding } = bind(sandbox, source, clock, {
    stableSourceId: SERVICES_SOURCE_ID,
    intervalMs: SERVICES_INTERVAL_MS,
  });

  const first = await binding.poll();
  assert.equal(first.published, 1);

  routes.services = [service({ binaryPath: 'C:\\two\\b.exe' })];
  const second = await binding.poll();
  assert.equal(second.published, 1);
  assert.equal(second.items[0].event.payload.change, 'changed');

  routes.services = [service({ binaryPath: 'C:\\one\\a.exe' })];
  const third = await binding.poll();
  assert.equal(third.published, 1, 'the revert back to A must be published');
  assert.equal(third.duplicates, 0);
  assert.equal(third.items[0].event.payload.change, 'changed');
  assert.equal(third.items[0].event.payload.binary_path, 'C:\\one\\a.exe');
  assert.notEqual(third.items[0].stableKey, first.items[0].stableKey);
});

test('an entity that stays gone does not re-publish its removal on every poll', async (t) => {
  const sandbox = withSandbox(t);
  const clock = createClock(BASE);
  // The cursor store lives in workRoot, so the walked root is a dedicated subdirectory:
  // otherwise the store own file would join the snapshot and skew every count.
  const root = join(sandbox.workRoot, 'scan');
  mkdirSync(root, { recursive: true });
  const filePath = join(root, 'gone.txt');
  writeFileSync(filePath, 'v1');

  const source = createDirectoriesSource({ roots: [{ id: 'work', path: root }], clock });
  const { binding } = bind(sandbox, source, clock, {
    stableSourceId: DIRECTORIES_SOURCE_ID,
    intervalMs: DIRECTORIES_INTERVAL_MS,
  });

  await binding.poll();
  rmSync(filePath);
  const removed = await binding.poll();
  assert.equal(removed.published, 1);

  const third = await binding.poll();
  assert.equal(third.published, 0, 'the removal is a one-shot transition, not a per-poll event');
  assert.equal(third.duplicates, 0);
  assert.equal(third.items.length, 0);
});

test('a restart replay of an unchanged table is still absorbed by the dedupe window', async (t) => {
  // The revision must not turn the documented restart replay into a flood of duplicates: an
  // entity that never changed is re-observed at revision 1, which is the key it was first
  // published under.
  const sandbox = withSandbox(t);
  const clock = createClock(BASE);
  // The cursor store lives in workRoot, so the walked root is a dedicated subdirectory:
  // otherwise the store own file would join the snapshot and skew every count.
  const root = join(sandbox.workRoot, 'scan');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'stable.txt'), 'v1');

  const makeSource = () => createDirectoriesSource({
    roots: [{ id: 'work', path: root }],
    clock,
  });

  // One collector, therefore one dedupe window: only the source (and its in-memory differ) is
  // re-created, which is exactly the state after a collector restart.
  const { collector } = createTestCollector({
    sandbox,
    source: { stableSourceId: DIRECTORIES_SOURCE_ID, kind: 'poll', intervalMs: DIRECTORIES_INTERVAL_MS },
    clock,
  });
  const initial = await createSourceBinding({ source: makeSource(), collector, clock }).poll();
  assert.equal(initial.published, 1);

  const replay = await createSourceBinding({ source: makeSource(), collector, clock }).poll();

  assert.equal(replay.published, 0, 'an unchanged table must not be re-published after a restart');
  assert.equal(replay.duplicates, 1);
});

test('a removal followed by a re-creation is published again on the same collector', async (t) => {
  const sandbox = withSandbox(t);
  const clock = createClock(BASE);
  // The cursor store lives in workRoot, so the walked root is a dedicated subdirectory:
  // otherwise the store own file would join the snapshot and skew every count.
  const root = join(sandbox.workRoot, 'scan');
  mkdirSync(root, { recursive: true });
  const filePath = join(root, 'phoenix.txt');
  writeFileSync(filePath, 'v1');

  const source = createDirectoriesSource({ roots: [{ id: 'work', path: root }], clock });
  const { binding } = bind(sandbox, source, clock, {
    stableSourceId: DIRECTORIES_SOURCE_ID,
    intervalMs: DIRECTORIES_INTERVAL_MS,
  });

  await binding.poll();
  rmSync(filePath);
  const removed = await binding.poll();
  assert.equal(removed.published, 1);

  writeFileSync(filePath, 'v1');
  const recreated = await binding.poll();
  assert.equal(recreated.published, 1, 'the re-created entity is a new transition');
  assert.equal(recreated.duplicates, 0);
  assert.equal(recreated.items[0].event.payload.change, 'added');
});
