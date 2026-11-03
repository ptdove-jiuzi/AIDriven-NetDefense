/**
 * freeze-console.mjs — pin the product console bytes before a reproducible build
 * (author PT-dove).
 *
 * Why this exists: `apps/console` is edited while bundles are assembled. A builder
 * that reads it directly has a moving input, so two builds minutes apart can ship
 * different `app.js` and the G2 gate then fails on the editor's timing rather than
 * on the builder. The pin turns "whatever the tree held at 02:31" into a directory
 * with digests that both builds consume.
 *
 * What it does: copies `apps/console` to `<dest>`, then proves the copy is a
 * coherent snapshot by re-hashing the source afterwards. If the source moved
 * during the copy — or the copy disagrees with the source — it retries. It never
 * writes outside the repository and never touches `apps/console`.
 *
 * usage: node tests/packaging/freeze-console.mjs [--source <dir>] [--dest <dir>]
 *        [--attempts <n>]
 *
 * Exit 0 prints the snapshot record as JSON:
 *   { ok, source, dest, files: [{path, sha256}], sourceDigest, snapshotDigest,
 *     attempts, stable }
 * Exit 1 when no stable snapshot could be taken, with the reason on stderr.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_SOURCE = join(REPO_ROOT, 'apps', 'console');
const DEFAULT_DEST = join(REPO_ROOT, 'dist', '_v14-inputs', 'console');

/** Every regular file under `root`, sorted, as forward-slash relative paths. */
export function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`console source contains a symlink: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Digest of a whole directory: one line per file, sorted, so two trees agree only
 * when every path and every byte agrees.
 */
export function digestTree(root) {
  const files = listFiles(root).map((path) => ({ path, sha256: sha256File(join(root, path)) }));
  const text = files.map((row) => `${row.sha256}  ${row.path}`).join('\n');
  return { files, digest: createHash('sha256').update(text).digest('hex') };
}

function parseArgs(argv) {
  const options = { source: DEFAULT_SOURCE, dest: DEFAULT_DEST, attempts: 6 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--source') options.source = resolve(argv[++index] ?? '');
    else if (token === '--dest') options.dest = resolve(argv[++index] ?? '');
    else if (token === '--attempts') options.attempts = Number(argv[++index]);
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

export function freezeConsole({ source = DEFAULT_SOURCE, dest = DEFAULT_DEST, attempts = 6 } = {}) {
  if (!existsSync(source)) throw new Error(`console source does not exist: ${source}`);
  if (!existsSync(join(source, 'index.html'))) throw new Error(`console source has no index.html: ${source}`);
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = digestTree(source);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(source, dest, {
      recursive: true,
      dereference: false,
      // mtime is not an input: the manifest hashes content, and copying timestamps
      // would make the snapshot's own metadata depend on when the copy ran.
      preserveTimestamps: false,
    });
    const after = digestTree(source);
    const copy = digestTree(dest);
    if (before.digest !== after.digest) {
      failures.push(`attempt ${attempt}: source changed during the copy (${before.digest.slice(0, 12)}… -> ${after.digest.slice(0, 12)}…)`);
      continue;
    }
    if (copy.digest !== after.digest) {
      failures.push(`attempt ${attempt}: copy ${copy.digest.slice(0, 12)}… does not match source ${after.digest.slice(0, 12)}…`);
      continue;
    }
    return {
      ok: true,
      source,
      dest,
      files: copy.files,
      fileCount: copy.files.length,
      bytes: copy.files.reduce((sum, row) => sum + statSync(join(dest, row.path)).size, 0),
      sourceDigest: after.digest,
      snapshotDigest: copy.digest,
      attempts: attempt,
      stable: true,
      failures,
    };
  }
  return { ok: false, source, dest, stable: false, attempts, failures };
}

const IS_CLI = process.argv[1] !== undefined && /freeze-console\.mjs$/.test(process.argv[1].split(/[\\/]/).join('/'));
if (IS_CLI) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = freezeConsole(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write(`freeze-console: could not take a stable snapshot of ${options.source}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`freeze-console: ${error.message}\n`);
    process.exitCode = 1;
  }
}
