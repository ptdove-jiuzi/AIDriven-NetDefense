import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSnapshotGuard,
  createTestSandbox,
} from '@aegisharness/test-support';

const fixture = fileURLToPath(new URL('../fixtures/synthetic-security-events.json', import.meta.url));

test('temporary workload leaves the explicitly configured mock real directory unchanged', (t) => {
  const sandbox = createTestSandbox();
  t.after(sandbox.cleanup);
  copyFileSync(fixture, join(sandbox.mockRealRoot, 'security-events.json'));

  const guard = createSnapshotGuard({
    sandboxRoot: sandbox.root,
    protectedRoot: sandbox.mockRealRoot,
  });
  const before = guard.capture();
  const events = JSON.parse(readFileSync(join(sandbox.mockRealRoot, 'security-events.json'), 'utf8'));
  writeFileSync(join(sandbox.workRoot, 'derived.json'), `${JSON.stringify({ count: events.length })}\n`);

  assert.equal(guard.assertUnchanged(before), true);
  assert.equal(JSON.parse(readFileSync(join(sandbox.workRoot, 'derived.json'), 'utf8')).count, 2);
  assert.notEqual(sandbox.root, process.cwd());
  assert.equal(dirname(sandbox.mockRealRoot), sandbox.root);
});

test('snapshot guard fails on content mutation and reports the changed path', (t) => {
  const sandbox = createTestSandbox();
  t.after(sandbox.cleanup);
  const protectedFile = join(sandbox.mockRealRoot, 'security-events.json');
  copyFileSync(fixture, protectedFile);
  const guard = createSnapshotGuard({
    sandboxRoot: sandbox.root,
    protectedRoot: sandbox.mockRealRoot,
  });
  const before = guard.capture();

  appendFileSync(protectedFile, '\n');
  assert.throws(
    () => guard.assertUnchanged(before),
    (error) => error.code === 'ERR_PROTECTED_DIRECTORY_CHANGED'
      && error.changes.includes('security-events.json'),
  );
});

test('snapshot guard fails on added or removed directory entries', (t) => {
  const sandbox = createTestSandbox();
  t.after(sandbox.cleanup);
  const guard = createSnapshotGuard({
    sandboxRoot: sandbox.root,
    protectedRoot: sandbox.mockRealRoot,
  });
  const before = guard.capture();
  writeFileSync(join(sandbox.mockRealRoot, 'unexpected.log'), 'synthetic mutation\n');

  assert.throws(
    () => guard.assertUnchanged(before),
    (error) => error.code === 'ERR_PROTECTED_DIRECTORY_CHANGED'
      && error.changes.includes('unexpected.log'),
  );
});

test('snapshot guard rejects roots outside the test temporary sandbox before scanning', (t) => {
  const sandbox = createTestSandbox();
  t.after(sandbox.cleanup);
  assert.throws(
    () => createSnapshotGuard({
      sandboxRoot: sandbox.root,
      protectedRoot: dirname(sandbox.root),
    }),
    /Protected root must be contained/,
  );
  assert.throws(
    () => createSnapshotGuard({
      sandboxRoot: process.cwd(),
      protectedRoot: join(process.cwd(), 'mock-real-root'),
    }),
    /Sandbox root must be contained|ENOENT/,
  );
});
