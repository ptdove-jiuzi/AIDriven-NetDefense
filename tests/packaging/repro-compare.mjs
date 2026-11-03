/**
 * ADR-0009 G2 comparison: are two bundles built from the same lockfile and the
 * same reviewed profile byte-identical?
 *
 * The gate has three parts, and they must not be collapsed into "diff the two
 * directories":
 *
 * 1. `manifests/files.sha256` is compared line by line **after removing the
 *    `bundle.json` row**. `bundle.json` cannot be compared as a file because it
 *    carries `builtAt`, so leaving its row in the manifest would make the gate
 *    fail on a value the gate is explicitly told to tolerate — and, worse, a
 *    reviewer would then be tempted to "fix" it by dropping the whole manifest.
 * 2. `bundle.json` is compared on its own, field by field, with a whitelist of
 *    fields allowed to differ (`builtAt`). Every other field — counts, digests,
 *    path list, prune gate, license record — must be identical, because those
 *    are the numbers a release claim is made from.
 * 3. The manifest is optionally re-derived from disk on both sides, so a
 *    manifest that agrees with another manifest but not with the bytes it ships
 *    cannot pass as reproducible.
 *
 * Everything here is pure except `verifyManifestAgainstDisk`, which only reads.
 * Keeping the rules in one module is what lets the unit suite exercise the
 * comparator against fixtures instead of building two 430 MiB bundles.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The one row a hash manifest may not be compared on. */
export const DEFAULT_STRIPPED_PATHS = ['bundle.json'];

/** `bundle.json` fields allowed to differ between two builds. */
export const DEFAULT_BUNDLE_WHITELIST = ['builtAt'];

const MANIFEST_ROW = /^([0-9a-f]{64}) {2}(.+)$/;

/**
 * Parse a `files.sha256` manifest.
 *
 * Rows are `<sha256>  <path>`. Comments start with `#`; blank lines are kept as
 * a count so a manifest that lost its header is visible rather than silently
 * accepted. A malformed row throws: a manifest nobody can parse is not evidence.
 */
export function parseHashManifest(text, label = 'manifest') {
  const rows = new Map();
  const duplicates = [];
  const malformed = [];
  let comments = 0;
  let blank = 0;
  const lines = String(text).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      blank += 1;
      continue;
    }
    if (line.startsWith('#')) {
      comments += 1;
      continue;
    }
    const match = MANIFEST_ROW.exec(line);
    if (match === null) {
      malformed.push({ line: index + 1, text: line.slice(0, 120) });
      continue;
    }
    const [, sha256, path] = match;
    if (rows.has(path)) duplicates.push(path);
    else rows.set(path, sha256);
  }
  if (malformed.length > 0) {
    throw new Error(`${label} has ${malformed.length} malformed row(s); first at line `
      + `${malformed[0].line}: ${JSON.stringify(malformed[0].text)}`);
  }
  return { rows, duplicates, comments, blank, lines: lines.length };
}

/**
 * Compare two manifests after removing `strip` paths from both sides.
 *
 * The stripped paths are reported, not silently dropped: the evidence has to
 * show that the exclusion happened and which rows it covered.
 */
export function compareHashManifests(leftText, rightText, { strip = DEFAULT_STRIPPED_PATHS } = {}) {
  const left = parseHashManifest(leftText, 'left manifest');
  const right = parseHashManifest(rightText, 'right manifest');
  const stripSet = new Set(strip.map((path) => String(path).split(sep).join('/')));

  const stripped = [];
  for (const path of stripSet) {
    const inLeft = left.rows.has(path);
    const inRight = right.rows.has(path);
    stripped.push({ path, inLeft, inRight });
    left.rows.delete(path);
    right.rows.delete(path);
  }

  const onlyLeft = [];
  const onlyRight = [];
  const differing = [];
  let compared = 0;
  for (const [path, sha256] of left.rows) {
    if (!right.rows.has(path)) {
      onlyLeft.push(path);
      continue;
    }
    compared += 1;
    const other = right.rows.get(path);
    if (other !== sha256) differing.push({ path, left: sha256, right: other });
  }
  for (const path of right.rows.keys()) {
    if (!left.rows.has(path)) onlyRight.push(path);
  }

  // One digest over the whole stripped manifest, rows in file order.
  //
  // This is the single value a reviewer can re-derive in one command: equal
  // digests mean the same files with the same digests in the same order, which
  // is a stronger statement than "no row differed" and does not require the
  // reviewer to trust the row-by-row report.
  const canonical = (rows) => [...rows.entries()].map(([path, sha256]) => `${sha256}  ${path}`).join('\n');
  const digestOf = (text) => createHash('sha256').update(text).digest('hex');

  // A duplicated path is not a formatting quirk: `parseHashManifest` keeps the
  // first row and drops the rest, so a manifest listing the same file twice with
  // two different digests would compare clean against a manifest that lists it
  // once. That is a silent loss of coverage, so it fails the gate outright
  // instead of being reported and ignored.
  const duplicates = { left: left.duplicates, right: right.duplicates };
  const duplicated = duplicates.left.length + duplicates.right.length;

  return {
    equal: onlyLeft.length === 0 && onlyRight.length === 0 && differing.length === 0 && duplicated === 0,
    compared,
    stripped,
    strippedRows: stripped.filter((row) => row.inLeft || row.inRight).length,
    strippedDigest: { left: digestOf(canonical(left.rows)), right: digestOf(canonical(right.rows)) },
    onlyLeft: onlyLeft.sort(),
    onlyRight: onlyRight.sort(),
    differing,
    duplicates,
    duplicatedPaths: duplicated,
    // A manifest with no rows compares as "equal" for the wrong reason.
    nonEmpty: left.rows.size > 0 && right.rows.size > 0,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flatten a JSON document into dotted leaf paths → value. */
export function flattenJson(value, prefix = '', into = new Map()) {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) into.set(prefix, { kind: 'empty-object' });
    for (const key of keys) flattenJson(value[key], prefix.length === 0 ? key : `${prefix}.${key}`, into);
    return into;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) into.set(prefix, []);
    for (const [index, item] of value.entries()) flattenJson(item, `${prefix}[${index}]`, into);
    return into;
  }
  into.set(prefix, value);
  return into;
}

/**
 * Compare two `bundle.json` documents.
 *
 * `whitelist` names the fields allowed to differ. Everything else must match,
 * including array order: a reordered package list is a different artifact even
 * though it describes the same set, because a reviewer reads it as a sequence.
 * Whitelisted fields that turned out identical are reported too — two builds
 * with the same `builtAt` are suspicious (a cached bundle, a copied directory),
 * and the evidence should say so instead of claiming two independent builds.
 */
export function compareBundleJson(left, right, { whitelist = DEFAULT_BUNDLE_WHITELIST } = {}) {
  const leftFlat = flattenJson(left);
  const rightFlat = flattenJson(right);
  const whitelistSet = new Set(whitelist);
  const differing = [];
  const onlyLeft = [];
  const onlyRight = [];
  const whitelisted = [];
  const paths = new Set([...leftFlat.keys(), ...rightFlat.keys()]);
  for (const path of paths) {
    const inLeft = leftFlat.has(path);
    const inRight = rightFlat.has(path);
    if (whitelistSet.has(path)) {
      whitelisted.push({ path, left: inLeft ? leftFlat.get(path) : undefined, right: inRight ? rightFlat.get(path) : undefined });
      continue;
    }
    if (!inRight) {
      onlyLeft.push(path);
      continue;
    }
    if (!inLeft) {
      onlyRight.push(path);
      continue;
    }
    const a = leftFlat.get(path);
    const b = rightFlat.get(path);
    if (JSON.stringify(a) !== JSON.stringify(b)) differing.push({ path, left: a, right: b });
  }
  return {
    equal: differing.length === 0 && onlyLeft.length === 0 && onlyRight.length === 0,
    differing,
    onlyLeft: onlyLeft.sort(),
    onlyRight: onlyRight.sort(),
    whitelisted,
    whitelistDiffers: whitelisted.some((row) => JSON.stringify(row.left) !== JSON.stringify(row.right)),
    // `leafPaths` counts every path the flattening produced, which expands array
    // elements (`closureRoots[3]`) into their own paths. It is *not* the number of
    // configuration fields: `arrayElementPaths` says how many of them are array
    // indices, so a reader can tell 73 settings apart from 241 positions.
    leafPaths: paths.size,
    arrayElementPaths: [...paths].filter((path) => path.includes('[')).length,
  };
}

/** Every regular file under `root`, as forward-slash relative paths. */
export function listFiles(root, { skip = ['manifests'] } = {}) {
  const skipSet = new Set(skip.map((name) => name.split(sep).join('/')));
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (skipSet.has(relativePath)) continue;
      if (entry.isSymbolicLink()) throw new Error(`bundle contains a symlink: ${relativePath}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Re-derive the manifest from disk.
 *
 * A manifest that matches another manifest proves the two builds agree; it does
 * not prove either one describes the bytes it ships. This closes that gap, and
 * it also catches a file that exists on disk but is missing from the manifest —
 * an unhashed file is exactly where a stray build artifact would hide.
 */
export function verifyManifestAgainstDisk(root, { skip = ['manifests'] } = {}) {
  const manifestPath = join(root, 'manifests', 'files.sha256');
  const manifest = parseHashManifest(readFileSync(manifestPath, 'utf8'), `${manifestPath}`);
  const onDisk = new Set(listFiles(root, { skip }));
  const mismatched = [];
  let verified = 0;
  for (const [path, expected] of manifest.rows) {
    if (!onDisk.has(path)) {
      mismatched.push({ path, reason: 'listed but absent from disk' });
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    verified += 1;
    if (actual !== expected) mismatched.push({ path, reason: 'digest differs from disk', expected, actual });
  }
  const unlisted = [...onDisk].filter((path) => !manifest.rows.has(path)).sort();
  return {
    ok: mismatched.length === 0 && unlisted.length === 0,
    verified,
    listed: manifest.rows.size,
    onDisk: onDisk.size,
    mismatched,
    unlisted,
  };
}

/**
 * Compare the `manifests/` directory file by file.
 *
 * `files.sha256` skips the whole `manifests/` directory — it cannot contain its
 * own digest — so the 186 files that live there (`trim-report.json`,
 * `third-party-packages.json`, `THIRD-PARTY-NOTICES.txt`, `license-gaps.json`,
 * `license-provenance.json`, `licenses/**`) are covered by **no** hash at all.
 * They are not decoration: the prune gate numbers, the per-licence counts and the
 * gap list that the release claims are made from are exactly these files.
 *
 * The ADR rule ("其余行逐文件哈希一致") is satisfied by `files.sha256` alone, but a
 * gate that stops there would call a build reproducible while its own evidence
 * documents drifted. So they are hashed here, and `files.sha256` itself is
 * excluded because it is already compared row by row.
 */
export function compareManifestDirectory(leftRoot, rightRoot) {
  const listing = (root) => {
    const directory = join(root, 'manifests');
    const files = [];
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.push(relative(directory, path).split(sep).join('/'));
      }
    };
    walk(directory);
    return files.sort();
  };
  const leftFiles = listing(leftRoot);
  const rightFiles = listing(rightRoot);
  const digest = (root, path) => createHash('sha256').update(readFileSync(join(root, 'manifests', ...path.split('/')))).digest('hex');
  const leftSet = new Set(leftFiles);
  const rightSet = new Set(rightFiles);
  const compared = leftFiles.filter((path) => path !== 'files.sha256' && rightSet.has(path));
  const differing = compared
    .filter((path) => digest(leftRoot, path) !== digest(rightRoot, path))
    .map((path) => ({ path: `manifests/${path}`, left: digest(leftRoot, path), right: digest(rightRoot, path) }));
  const onlyLeft = leftFiles.filter((path) => !rightSet.has(path)).map((path) => `manifests/${path}`);
  const onlyRight = rightFiles.filter((path) => !leftSet.has(path)).map((path) => `manifests/${path}`);
  return {
    equal: differing.length === 0 && onlyLeft.length === 0 && onlyRight.length === 0,
    compared: compared.length,
    totalFiles: leftFiles.length,
    excluded: leftFiles.includes('files.sha256') ? ['manifests/files.sha256'] : [],
    differing,
    onlyLeft,
    onlyRight,
  };
}

/**
 * Run the whole G2 comparison over two bundle directories.
 *
 * `verifyDisk` is off by default because it re-hashes ~47 000 files twice; the
 * evidence run turns it on so the result is about bytes, not about two files
 * agreeing with each other.
 */
export function compareBundles({
  leftRoot, rightRoot, strip = DEFAULT_STRIPPED_PATHS, whitelist = DEFAULT_BUNDLE_WHITELIST, verifyDisk = false,
}) {
  const leftManifest = readFileSync(join(leftRoot, 'manifests', 'files.sha256'), 'utf8');
  const rightManifest = readFileSync(join(rightRoot, 'manifests', 'files.sha256'), 'utf8');
  const manifests = compareHashManifests(leftManifest, rightManifest, { strip });
  const manifestDirectory = compareManifestDirectory(leftRoot, rightRoot);
  const bundleJson = compareBundleJson(
    JSON.parse(readFileSync(join(leftRoot, 'bundle.json'), 'utf8')),
    JSON.parse(readFileSync(join(rightRoot, 'bundle.json'), 'utf8')),
    { whitelist },
  );
  const disk = verifyDisk
    ? { left: verifyManifestAgainstDisk(leftRoot), right: verifyManifestAgainstDisk(rightRoot) }
    : undefined;
  const ok = manifests.equal
    && manifests.nonEmpty
    && manifestDirectory.equal
    && bundleJson.equal
    && (disk === undefined || (disk.left.ok && disk.right.ok));
  return { ok, manifests, manifestDirectory, bundleJson, disk };
}

/** `--json` friendly summary: the full detail without the 47 000 row list. */
export function summarize(result, { leftRoot, rightRoot, generatedAt, command }) {
  return {
    schemaVersion: '1.0',
    gate: 'ADR-0009 G2',
    generatedAt,
    // The exact invocation, recorded so a reviewer does not have to guess which
    // flags produced these numbers — in particular whether the strip set was
    // widened beyond the reviewed default.
    command: command ?? null,
    left: leftRoot,
    right: rightRoot,
    ok: result.ok,
    manifests: {
      equal: result.manifests.equal,
      nonEmpty: result.manifests.nonEmpty,
      comparedFiles: result.manifests.compared,
      stripped: result.manifests.stripped,
      strippedRows: result.manifests.strippedRows,
      strippedDigest: result.manifests.strippedDigest,
      onlyLeft: result.manifests.onlyLeft.slice(0, 20),
      onlyRight: result.manifests.onlyRight.slice(0, 20),
      onlyLeftCount: result.manifests.onlyLeft.length,
      onlyRightCount: result.manifests.onlyRight.length,
      differing: result.manifests.differing.slice(0, 20),
      differingCount: result.manifests.differing.length,
      duplicates: result.manifests.duplicates,
      duplicatedPaths: result.manifests.duplicatedPaths,
    },
    manifestDirectory: {
      equal: result.manifestDirectory.equal,
      comparedFiles: result.manifestDirectory.compared,
      totalFiles: result.manifestDirectory.totalFiles,
      excluded: result.manifestDirectory.excluded,
      differing: result.manifestDirectory.differing.slice(0, 20),
      differingCount: result.manifestDirectory.differing.length,
      onlyLeft: result.manifestDirectory.onlyLeft.slice(0, 20),
      onlyRight: result.manifestDirectory.onlyRight.slice(0, 20),
    },
    bundleJson: {
      equal: result.bundleJson.equal,
      leafPaths: result.bundleJson.leafPaths,
      arrayElementPaths: result.bundleJson.arrayElementPaths,
      whitelisted: result.bundleJson.whitelisted,
      whitelistDiffers: result.bundleJson.whitelistDiffers,
      differing: result.bundleJson.differing,
      onlyLeft: result.bundleJson.onlyLeft,
      onlyRight: result.bundleJson.onlyRight,
    },
    disk: result.disk === undefined ? 'not-checked' : {
      left: {
        ok: result.disk.left.ok,
        verified: result.disk.left.verified,
        listed: result.disk.left.listed,
        onDisk: result.disk.left.onDisk,
        mismatched: result.disk.left.mismatched.slice(0, 20),
        unlisted: result.disk.left.unlisted.slice(0, 20),
      },
      right: {
        ok: result.disk.right.ok,
        verified: result.disk.right.verified,
        listed: result.disk.right.listed,
        onDisk: result.disk.right.onDisk,
        mismatched: result.disk.right.mismatched.slice(0, 20),
        unlisted: result.disk.right.unlisted.slice(0, 20),
      },
    },
  };
}

function parseArgs(argv) {
  const options = { strip: [...DEFAULT_STRIPPED_PATHS], whitelist: [...DEFAULT_BUNDLE_WHITELIST], verifyDisk: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--left') options.left = argv[++index];
    else if (token === '--right') options.right = argv[++index];
    else if (token === '--json') options.json = argv[++index];
    else if (token === '--strip') options.strip = argv[++index].split(',').filter((item) => item.length > 0);
    else if (token === '--allow-field') options.whitelist = argv[++index].split(',').filter((item) => item.length > 0);
    else if (token === '--verify-disk') options.verifyDisk = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

// Entry guard: only act as a CLI when this file *is* the process entry point, so
// importing it from the unit suite cannot read a directory or exit the process.
const IS_CLI = process.argv[1] !== undefined
  && /repro-compare\.mjs$/.test(process.argv[1].split(sep).join('/'));

if (IS_CLI) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || options.left === undefined || options.right === undefined) {
      process.stdout.write('usage: node tests/packaging/repro-compare.mjs --left <bundle> --right <bundle> '
        + '[--json <file>] [--strip bundle.json] [--allow-field builtAt] [--verify-disk]\n');
      process.exit(options.help ? 0 : 2);
    }
    const result = compareBundles({
      leftRoot: options.left,
      rightRoot: options.right,
      strip: options.strip,
      whitelist: options.whitelist,
      verifyDisk: options.verifyDisk,
    });
    const document = summarize(result, {
      leftRoot: options.left,
      rightRoot: options.right,
      generatedAt: new Date().toISOString(),
      command: `node tests/packaging/repro-compare.mjs ${process.argv.slice(2).join(' ')}`,
    });
    if (options.json !== undefined) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(options.json), { recursive: true });
      writeFileSync(options.json, `${JSON.stringify(document, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`repro-compare: ${error?.message ?? String(error)}\n`);
    process.exit(2);
  }
}
