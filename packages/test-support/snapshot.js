import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

function assertContained(parent, child, label, allowEqual = false) {
  const pathFromParent = relative(parent, child);
  const outside = pathFromParent.startsWith(`..${sep}`)
    || pathFromParent === '..'
    || isAbsolute(pathFromParent);
  if (outside || (!allowEqual && pathFromParent === '')) {
    throw new Error(`${label} must be contained in ${parent}`);
  }
}

function safeRealPath(path, label) {
  const absolute = resolve(path);
  return realpathSync.native(absolute, { throwIfNoEntry: true });
}

export function createTestSandbox({ prefix = 'aegisharness-wp0-', parentDir } = {}) {
  if (!/^[a-z0-9-]+$/.test(prefix)) {
    throw new Error('Sandbox prefix must contain only lowercase letters, digits, and hyphens');
  }

  // `parentDir` lets a suite place its sandbox under a neutral analysis root
  // (for example `%ProgramData%\AegisHarness\analysis`) instead of %TEMP%.
  // Cleanup keeps using the same base, so the removal guard still applies.
  const baseRoot = realpathSync(parentDir ?? tmpdir());
  const root = realpathSync(mkdtempSync(join(baseRoot, prefix)));
  const mockRealRoot = join(root, 'mock-real-root');
  const workRoot = join(root, 'work');
  mkdirSync(mockRealRoot);
  mkdirSync(workRoot);

  let cleaned = false;
  return Object.freeze({
    root,
    mockRealRoot,
    workRoot,
    cleanup() {
      if (cleaned) return;
      assertContained(baseRoot, root, 'Sandbox root');
      rmSync(root, { recursive: true, force: true });
      cleaned = true;
    },
  });
}

function metadataFor(stat) {
  return {
    mode: Number(stat.mode & 0o7777n),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function snapshotEntry(root, relativePath) {
  const absolutePath = relativePath === '.' ? root : join(root, relativePath);
  const stat = lstatSync(absolutePath, { bigint: true });
  const base = { path: relativePath, ...metadataFor(stat) };

  if (stat.isSymbolicLink()) {
    return { ...base, type: 'symlink', target: readlinkSync(absolutePath) };
  }
  if (stat.isDirectory()) {
    return { ...base, type: 'directory' };
  }
  if (stat.isFile()) {
    return {
      ...base,
      type: 'file',
      size: stat.size.toString(),
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
    };
  }
  throw new Error(`Unsupported filesystem entry in protected root: ${relativePath}`);
}

export function snapshotDirectory(root) {
  const resolvedRoot = safeRealPath(root, 'Snapshot root');
  const entries = [];
  const pending = ['.'];

  while (pending.length > 0) {
    const relativePath = pending.shift();
    entries.push(snapshotEntry(resolvedRoot, relativePath));
    const absolutePath = relativePath === '.' ? resolvedRoot : join(resolvedRoot, relativePath);
    if (!lstatSync(absolutePath).isDirectory()) continue;

    const children = readdirSync(absolutePath, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
    for (const child of children) {
      pending.push(relativePath === '.' ? child : join(relativePath, child));
    }
  }

  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { formatVersion: 1, entries };
}

export function createSnapshotGuard({ sandboxRoot, protectedRoot, sandboxBase }) {
  if (!sandboxRoot || !protectedRoot) {
    throw new Error('sandboxRoot and protectedRoot must be explicitly configured');
  }

  const sandboxRealPath = safeRealPath(sandboxRoot, 'Sandbox root');
  const protectedRealPath = safeRealPath(protectedRoot, 'Protected root');
  // The sandbox no longer has to live in %TEMP%: a suite that stages its work
  // under a neutral analysis root passes that root as `sandboxBase`.
  const tempRoot = realpathSync(sandboxBase ?? tmpdir());
  assertContained(tempRoot, sandboxRealPath, 'Sandbox root');
  assertContained(sandboxRealPath, protectedRealPath, 'Protected root');
  if (basename(protectedRealPath) !== 'mock-real-root') {
    throw new Error('Protected root must be the mock-real-root inside the test sandbox');
  }

  function assertSafeConfiguration() {
    const currentSandbox = safeRealPath(sandboxRoot, 'Sandbox root');
    const currentProtected = safeRealPath(protectedRoot, 'Protected root');
    if (currentSandbox !== sandboxRealPath || currentProtected !== protectedRealPath) {
      throw new Error('Sandbox or protected root was replaced during the test');
    }
    assertContained(tempRoot, currentSandbox, 'Sandbox root');
    assertContained(currentSandbox, currentProtected, 'Protected root');
  }

  return Object.freeze({
    protectedRoot: protectedRealPath,
    capture() {
      assertSafeConfiguration();
      return snapshotDirectory(protectedRealPath);
    },
    assertUnchanged(before) {
      const after = this.capture();
      const beforeEntries = new Map(before.entries.map((entry) => [entry.path, entry]));
      const afterEntries = new Map(after.entries.map((entry) => [entry.path, entry]));
      const paths = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])].sort();
      const changes = paths.filter((path) => (
        JSON.stringify(beforeEntries.get(path)) !== JSON.stringify(afterEntries.get(path))
      ));
      if (changes.length > 0) {
        const error = new Error(`Protected mock real directory changed: ${changes.join(', ')}`);
        error.code = 'ERR_PROTECTED_DIRECTORY_CHANGED';
        error.changes = changes;
        throw error;
      }
      return true;
    },
  });
}
