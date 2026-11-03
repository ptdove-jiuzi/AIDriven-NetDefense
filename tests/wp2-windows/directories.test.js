import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  DIRECTORIES_SOURCE_ID,
  MAX_ROOTS,
  WINDOWS_ERROR_CODES,
  assertRootPath,
  createDirectoriesSource,
  directoriesDescriptor,
  normalizeRoots,
} from '../../packages/collectors/windows/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';
import { createClock } from './helpers.js';

const BASE = 1_700_000_000_000;

function withSandbox(t) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-win-' });
  t.after(sandbox.cleanup);
  return sandbox;
}

/** Fake `io` over an in-memory tree, so permission failures can be simulated without ACLs. */
function fakeIo(tree) {
  const errors = new Map();
  return {
    fail(path, code) { errors.set(path.toLowerCase(), code); },
    readdir(path) {
      const code = errors.get(path.toLowerCase());
      if (code !== undefined) {
        throw Object.assign(new Error(code), { code });
      }
      const node = tree[path.toLowerCase()];
      if (node === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return node.children.map((child) => ({
        name: child.name,
        isDirectory: () => child.kind === 'directory',
        isSymbolicLink: () => child.kind === 'link',
      }));
    },
    lstat(path) {
      const code = errors.get(path.toLowerCase());
      if (code !== undefined) {
        throw Object.assign(new Error(code), { code });
      }
      const node = tree[path.toLowerCase()] ?? derivedNode(tree, path);
      if (node === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return {
        size: node.size ?? 0,
        mtimeMs: node.mtimeMs ?? BASE,
        isDirectory: () => node.kind === 'directory',
        isFile: () => node.kind === 'file',
        isSymbolicLink: () => node.kind === 'link',
      };
    },
  };
}

/**
 * Resolve a child that the parent listing already declared. Without this every leaf would
 * have to be repeated in the fixture and a missing entry would be indistinguishable from a
 * real ENOENT.
 */
function derivedNode(tree, path) {
  const normalized = path.toLowerCase();
  const separator = normalized.lastIndexOf('\\');
  if (separator <= 0) {
    return undefined;
  }
  const parent = tree[normalized.slice(0, separator)];
  if (parent === undefined || !Array.isArray(parent.children)) {
    return undefined;
  }
  const name = normalized.slice(separator + 1);
  const child = parent.children.find((entry) => entry.name.toLowerCase() === name);
  return child === undefined ? undefined : { kind: child.kind };
}

test('a relative path, a traversal segment or a wildcard is refused', () => {
  assert.throws(() => assertRootPath('relative\\dir'), (error) => error.code === WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED);
  assert.throws(() => assertRootPath('C:\\a\\..\\b'), (error) => error.code === WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED);
  assert.throws(() => assertRootPath('C:\\a*'), (error) => error.code === WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED);
  assert.throws(() => assertRootPath('C:\\a";calc'), (error) => error.code === WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED);
  assert.equal(assertRootPath('C:\\Windows\\System32'), 'C:\\Windows\\System32');
});

test('more than the declared root budget is a configuration error', () => {
  const roots = [];
  for (let index = 0; index < MAX_ROOTS + 1; index += 1) {
    roots.push(`C:\\roots\\r${index}`);
  }
  assert.throws(() => normalizeRoots(roots), (error) => error.code === WINDOWS_ERROR_CODES.SOURCE_LIMIT_EXCEEDED);
});

test('duplicate root ids and invalid ids are refused', () => {
  assert.throws(
    () => normalizeRoots([{ id: 'a', path: 'C:\\a' }, { id: 'a', path: 'C:\\b' }]),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG,
  );
  assert.throws(
    () => normalizeRoots([{ id: 'bad id', path: 'C:\\a' }]),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG,
  );
});

test('the descriptor declares reconciliation-only semantics and the 32-root bound', () => {
  const descriptor = directoriesDescriptor({ roots: [{ id: 'a', path: 'C:\\a' }] });
  assert.equal(descriptor.stableSourceId, DIRECTORIES_SOURCE_ID);
  assert.equal(descriptor.generationAware, false);
  assert.equal(descriptor.blindSpots.some((entry) => /ReadDirectoryChangesW/u.test(entry)), true);
  assert.equal(descriptor.blindSpots.some((entry) => /never read unless hashContent/u.test(entry)), true);
});

test('a real tree is snapshotted with metadata only and no file content', async (t) => {
  const sandbox = withSandbox(t);
  writeFileSync(join(sandbox.workRoot, 'a.txt'), 'hello');
  writeFileSync(join(sandbox.workRoot, 'b.txt'), 'world');

  const source = createDirectoriesSource({
    roots: [{ id: 'work', path: sandbox.workRoot }],
    clock: createClock(BASE),
  });
  const result = await source.read();

  assert.equal(result.snapshot, true);
  assert.equal(result.identity, null);
  assert.equal(result.records.length, 2);

  for (const record of result.records) {
    assert.equal(record.payload.root_id, 'work');
    assert.equal(record.payload.entry_kind, 'file');
    assert.equal('content_hash' in record.payload, false, 'content is not read unless configured');
    assert.match(record.payload.path_digest, /^[0-9a-f]{16}$/u);
    assert.equal(record.payload.relative_path.includes(sandbox.root), false, 'the raw root must not leak into the event');
  }
});

test('content hashing is opt-in and bounded', async (t) => {
  const sandbox = withSandbox(t);
  writeFileSync(join(sandbox.workRoot, 'small.txt'), 'abc');

  const source = createDirectoriesSource({
    roots: [{ id: 'work', path: sandbox.workRoot }],
    clock: createClock(BASE),
    hashContent: true,
    maxHashBytes: 2,
  });
  const result = await source.read();

  assert.equal('content_hash' in result.records[0].payload, false, 'a file above maxHashBytes must not be hashed');
  assert.equal(result.stats.hashSkipped, 1);

  const allowed = createDirectoriesSource({
    roots: [{ id: 'work', path: sandbox.workRoot }],
    clock: createClock(BASE),
    hashContent: true,
    maxHashBytes: 1024,
  });
  const hashed = await allowed.read();
  assert.match(hashed.records[0].payload.content_hash, /^[0-9a-f]{64}$/u);
  assert.equal(hashed.stats.hashedFiles, 1);
});

test('a deleted file is reported as removed and a rewritten one as changed', async (t) => {
  const sandbox = withSandbox(t);
  const filePath = join(sandbox.workRoot, 'watch.txt');
  writeFileSync(filePath, 'v1');
  const clock = createClock(BASE);
  const source = createDirectoriesSource({ roots: [{ id: 'work', path: sandbox.workRoot }], clock });

  await source.read();

  writeFileSync(filePath, 'v2 with a different length');
  const changed = await source.read();
  assert.equal(changed.records.length, 1);
  assert.equal(changed.records[0].payload.change, 'changed');

  const { rmSync } = await import('node:fs');
  rmSync(filePath);
  const removed = await source.read();
  assert.equal(removed.records.length, 1);
  assert.equal(removed.records[0].payload.change, 'removed');
  assert.equal(removed.records[0].payload.present, false);
});

test('a reparse point is reported but never descended', async () => {
  const root = 'C:\\roots\\a';
  const tree = {
    'c:\\roots\\a': { kind: 'directory', children: [{ name: 'jump', kind: 'link' }] },
  };
  const io = fakeIo(tree);
  const source = createDirectoriesSource({ roots: [{ id: 'a', path: root }], clock: createClock(BASE), io });
  const result = await source.read();

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.entry_kind, 'link');
  assert.equal(result.stats.linkedEntries, 1);
});

test('an unreadable subtree is counted and never reported as deleted', async () => {
  const root = 'C:\\roots\\a';
  const tree = {
    'c:\\roots\\a': { kind: 'directory', children: [{ name: 'sub', kind: 'directory' }, { name: 'x.txt', kind: 'file' }] },
    'c:\\roots\\a\\sub': { kind: 'directory', children: [{ name: 'y.txt', kind: 'file' }] },
  };
  const io = fakeIo(tree);
  const clock = createClock(BASE);
  const source = createDirectoriesSource({ roots: [{ id: 'a', path: root }], clock, io });

  const first = await source.read();
  assert.equal(first.records.length, 3, 'root entries plus the nested file');

  io.fail('c:\\roots\\a\\sub', 'EACCES');
  const second = await source.read();

  assert.equal(second.stats.unreadable, 1);
  assert.deepEqual([...second.degradedFields], ['relative_path']);
  assert.equal(
    second.records.some((record) => record.payload.change === 'removed'),
    false,
    'a permission failure must never look like a deletion',
  );
});

test('the depth bound stops descent without losing the directory entry itself', async () => {
  const root = 'C:\\roots\\a';
  const tree = {
    'c:\\roots\\a': { kind: 'directory', children: [{ name: 'd1', kind: 'directory' }] },
    'c:\\roots\\a\\d1': { kind: 'directory', children: [{ name: 'd2', kind: 'directory' }] },
    'c:\\roots\\a\\d1\\d2': { kind: 'directory', children: [{ name: 'deep.txt', kind: 'file' }] },
  };
  const io = fakeIo(tree);
  const source = createDirectoriesSource({
    roots: [{ id: 'a', path: root }],
    clock: createClock(BASE),
    io,
    maxDepth: 0,
  });
  const result = await source.read();

  assert.deepEqual(
    result.records.map((record) => record.payload.relative_path).sort(),
    ['d1'],
  );
  assert.equal(result.stats.depthLimited, 1);
});

test('a vanished root is counted instead of being reported as a mass deletion', async (t) => {
  const sandbox = withSandbox(t);
  writeFileSync(join(sandbox.workRoot, 'a.txt'), 'x');
  const clock = createClock(BASE);
  const source = createDirectoriesSource({ roots: [{ id: 'work', path: sandbox.workRoot }], clock });

  await source.read();
  const { rmSync } = await import('node:fs');
  rmSync(sandbox.workRoot, { recursive: true, force: true });

  const second = await source.read();
  assert.equal(second.stats.missingRoots, 1);
  assert.equal(second.records.length, 1, 'the previously tracked entry is reported as removed');
  assert.equal(second.records[0].payload.change, 'removed');
});

test('hitting the entry budget is reported as truncated and never as a deletion', async () => {
  // Regression: the walk capped its output exactly at the budget, so `items.length >
  // maxEntities` in the differ was unreachable and `truncated` was always false. The entries
  // past the cut were then reported as removed on the following cycle even though they still
  // existed — a silent miss plus a false deletion event.
  const root = 'C:\\roots\\a';
  const tree = {
    'c:\\roots\\a': {
      kind: 'directory',
      children: ['a0', 'a1', 'a2', 'a3', 'a4'].map((name) => ({ name, kind: 'file' })),
    },
  };
  const io = fakeIo(tree);
  const clock = createClock(BASE);
  const source = createDirectoriesSource({
    roots: [{ id: 'a', path: root }],
    clock,
    io,
    maxEntities: 4,
  });

  const first = await source.read();
  assert.equal(first.records.length, 4);
  assert.equal(first.truncated, true, 'a budget stop must be visible to the caller');
  assert.equal(first.stats.budgetExhausted, true);

  // A new name that sorts first pushes a3 past the cut; a3 was tracked, so without the
  // suppression it would be reported as deleted while still present on disk.
  tree['c:\\roots\\a'].children.unshift({ name: 'a-00', kind: 'file' });
  const second = await source.read();

  assert.equal(second.truncated, true);
  assert.equal(
    second.records.some((record) => record.payload.change === 'removed'),
    false,
    'the unseen tail must not be reported as deleted',
  );
  assert.equal(second.stats.suppressedRemovals, 1);
});

test('a denial on every declared root is an unavailable source, not an empty tree', async () => {
  const root = 'C:\\roots\\a';
  const io = fakeIo({ 'c:\\roots\\a': { kind: 'directory', children: [{ name: 'x.txt', kind: 'file' }] } });
  io.fail('c:\\roots\\a', 'EACCES');
  const source = createDirectoriesSource({ roots: [{ id: 'a', path: root }], clock: createClock(BASE), io });

  await assert.rejects(() => source.read(), (error) => error.code === WINDOWS_ERROR_CODES.ACCESS_DENIED);
});

test('a denial on one of several roots still returns the readable roots and declares the loss', async () => {
  const io = fakeIo({
    'c:\\roots\\a': { kind: 'directory', children: [{ name: 'x.txt', kind: 'file' }] },
    'c:\\roots\\b': { kind: 'directory', children: [{ name: 'y.txt', kind: 'file' }] },
  });
  io.fail('c:\\roots\\b', 'EACCES');
  const source = createDirectoriesSource({
    roots: [{ id: 'a', path: 'C:\\roots\\a' }, { id: 'b', path: 'C:\\roots\\b' }],
    clock: createClock(BASE),
    io,
  });
  const result = await source.read();

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.root_id, 'a');
  assert.deepEqual([...result.degradedFields], ['relative_path']);
});

test('the io seam is validated so a missing implementation fails loudly', () => {
  assert.throws(
    () => createDirectoriesSource({ roots: ['C:\\a'], io: {} }),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
  );
});

test('an unreadable root suppresses removals only for that root', async () => {
  // Regression: an unreadable root was recorded as the empty prefix, and `startsWith('')` is
  // true for every path — so one denied root silenced removals for every declared root, for as
  // long as that root stayed unreadable.
  //
  // The paths are built at runtime because a literal Windows path in this file is easy to get
  // wrong; `winPath` keeps them identical for the declared root, the fake tree and `fail()`.
  const BS = String.fromCharCode(92);
  const winPath = (...segments) => `C:${BS}${segments.join(BS)}`;
  const rootA = winPath('roots', 'a');
  const rootB = winPath('roots', 'b');
  const tree = {
    [rootA.toLowerCase()]: { kind: 'directory', children: [{ name: 'a.txt', kind: 'file' }] },
    [rootB.toLowerCase()]: { kind: 'directory', children: [{ name: 'b.txt', kind: 'file' }] },
  };
  const io = fakeIo(tree);
  const clock = createClock(BASE);
  const source = createDirectoriesSource({
    roots: [{ id: 'a', path: rootA }, { id: 'b', path: rootB }],
    clock,
    io,
  });

  const first = await source.read();
  assert.deepEqual(first.records.map((record) => record.payload.root_id).sort(), ['a', 'b']);

  // Root A becomes unreadable (lstat and readdir both deny), and b.txt is really deleted.
  io.fail(rootA, 'EACCES');
  tree[rootB.toLowerCase()].children = [];
  const second = await source.read();

  const removed = second.records.filter((record) => record.payload.change === 'removed');
  assert.deepEqual(
    removed.map((record) => [record.payload.root_id, record.payload.relative_path]),
    [['b', 'b.txt']],
    'the live deletion under the readable root must still be reported',
  );
  assert.equal(
    second.records.some((record) => record.payload.root_id === 'a' && record.payload.change === 'removed'),
    false,
    'the unreadable root must not be reported as deleted',
  );
  assert.equal(second.stats.suppressedRemovals, 1);
  assert.deepEqual([...second.degradedFields], ['relative_path']);
});
