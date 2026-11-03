#!/usr/bin/env node
/**
 * Compare bundles and list the reclaimable ones (author PT-dove).
 *
 * usage:
 *   node deploy/embedded-runtime/report.mjs <bundle-a> <bundle-b>
 *   node deploy/embedded-runtime/report.mjs --siblings <directory> [--current <bundle>]
 *   node deploy/embedded-runtime/report.mjs <bundle> --json
 *
 * Read-only: it walks directories and reads manifests. It never deletes, and it
 * deliberately reports deletable bundles rather than acting on them — deciding
 * which bundle is still needed is the maintainer's call.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function measure(directory) {
  let bytes = 0;
  let files = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(child).size;
      }
    }
  };
  walk(directory);
  return { bytes, files };
}

/**
 * Describe one candidate directory, or `undefined` when it does not exist.
 *
 * A reclaim report is only useful if it survives the very trees it is meant to
 * clean up. Two of them have no usable `bundle.json`:
 *
 * - an interrupted build never wrote one at all;
 * - a killed build can leave a truncated one.
 *
 * Both still occupy disk and are still deletable, so both are *listed* rather
 * than skipped or thrown on: a report that omits 735 MiB, or that dies on the
 * first damaged directory and prints no total, cannot be used to decide what to
 * reclaim. Neither case is allowed to look like a healthy bundle — `marked`
 * stays false and the reason travels with the row.
 */
function describe(directory) {
  const root = resolve(directory);
  if (!existsSync(root)) return undefined;
  const markerPath = join(root, 'bundle.json');
  const markerSha256 = existsSync(markerPath)
    ? process.getBuiltinModule('node:crypto').createHash('sha256').update(readFileSync(markerPath)).digest('hex')
    : undefined;
  const unmarked = (size, bundleJsonError) => ({
    path: root,
    name: basename(root),
    builtAt: undefined,
    marked: false,
    packages: 0,
    prunedPackages: 0,
    prunedMiB: 0,
    files: size.files,
    manifestRows: 0,
    logicalMiB: Number((size.bytes / 1048576).toFixed(2)),
    licenseGaps: 0,
    nodeLicense: 'unknown',
    bundleJsonSha256: markerSha256,
    bundleJsonError,
  });
  if (!existsSync(markerPath)) {
    return unmarked(measure(root), 'bundle.json is absent, so the build was interrupted');
  }
  let bundle;
  try {
    bundle = readJson(markerPath);
  } catch (error) {
    return unmarked(measure(root), `bundle.json is unreadable: ${error?.message ?? String(error)}`);
  }
  const inventory = existsSync(join(root, 'manifests', 'third-party-packages.json'))
    ? readJson(join(root, 'manifests', 'third-party-packages.json'))
    : { count: 0, byLicense: {} };
  const trim = existsSync(join(root, 'manifests', 'trim-report.json'))
    ? readJson(join(root, 'manifests', 'trim-report.json'))
    : undefined;
  const gaps = existsSync(join(root, 'manifests', 'license-gaps.json'))
    ? readJson(join(root, 'manifests', 'license-gaps.json'))
    : { count: 0 };
  const manifestPath = join(root, 'manifests', 'files.sha256');
  const manifestRows = existsSync(manifestPath)
    ? readFileSync(manifestPath, 'utf8').split('\n').filter((line) => line.length > 0 && !line.startsWith('#')).length
    : 0;
  const size = measure(root);
  return {
    path: root,
    name: basename(root),
    builtAt: bundle.builtAt,
    marked: true,
    packages: inventory.count,
    prunedPackages: trim === undefined ? 0 : trim.summary.prunedNames,
    prunedMiB: trim === undefined ? 0 : trim.summary.prunedMiB,
    files: size.files,
    manifestRows,
    logicalMiB: Number((size.bytes / 1048576).toFixed(2)),
    licenseGaps: gaps.count,
    nodeLicense: bundle.license?.node?.provenance ?? 'unknown',
    bundleJsonSha256: markerSha256,
    bundleJsonError: undefined,
  };
}

function format(row) {
  // Never assume the marker digest exists: an interrupted or truncated build has
  // none, and the whole point of this report is that those directories are still
  // counted instead of crashing the run.
  const marker = typeof row.bundleJsonSha256 === 'string'
    ? `${row.bundleJsonSha256.slice(0, 16)}…`
    : 'missing';
  const because = row.bundleJsonError === undefined ? '' : `  [${row.bundleJsonError}]`;
  return [
    `${row.name}${row.marked === false ? '  [no usable bundle.json — interrupted build]' : ''}`,
    `  built        ${row.builtAt ?? 'unknown'}`,
    `  packages     ${row.packages}${row.prunedPackages > 0 ? ` (trimmed ${row.prunedPackages} / ${row.prunedMiB} MiB)` : ''}`,
    `  files        ${row.files} (manifest ${row.manifestRows})`,
    `  size         ${row.logicalMiB} MiB logical`,
    `  licenses     ${row.licenseGaps} gap(s), node license ${row.nodeLicense}`,
    `  bundle.json  ${marker}${because}`,
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const siblingsIndex = argv.indexOf('--siblings');

  if (siblingsIndex !== -1) {
    if (argv[siblingsIndex + 1] === undefined) throw new Error('--siblings needs a directory');
    const directory = resolve(argv[siblingsIndex + 1]);
    const currentIndex = argv.indexOf('--current');
    const current = currentIndex === -1 ? undefined : resolve(argv[currentIndex + 1] ?? '');
    if (!existsSync(directory)) throw new Error(`directory not found: ${directory}`);
    if (current !== undefined && !existsSync(current)) throw new Error(`--current does not exist: ${current}`);
    const rows = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const described = describe(join(directory, entry.name));
      if (described !== undefined) rows.push(described);
    }
    // Bounded bundles first, newest last; interrupted ones follow, ordered by
    // name. Sorting on the literal string "undefined" instead would scatter them
    // through the list and read as a timestamp.
    rows.sort((left, right) => {
      if (left.marked !== right.marked) return left.marked ? -1 : 1;
      const byBuiltAt = String(left.builtAt ?? '').localeCompare(String(right.builtAt ?? ''));
      return byBuiltAt === 0 ? left.name.localeCompare(right.name, 'en') : byBuiltAt;
    });
    const totalMiB = rows.reduce((sum, row) => sum + row.logicalMiB, 0);
    const output = {
      directory,
      current,
      bundles: rows,
      totalMiB: Number(totalMiB.toFixed(2)),
      deletable: rows
        .filter((row) => current === undefined || row.path !== current)
        .map((row) => ({ path: row.path, name: row.name, logicalMiB: row.logicalMiB })),
    };
    if (asJson) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      for (const row of rows) {
        process.stdout.write(`${row.path === current ? '* ' : '  '}${format(row)}\n\n`);
      }
      process.stdout.write(`total ${totalMiB.toFixed(1)} MiB across ${rows.length} bundle(s); `
        + `${output.deletable.length} not marked current — nothing was deleted\n`);
    }
    return;
  }

  const paths = argv.filter((token) => !token.startsWith('--'));
  if (paths.length === 0) throw new Error('usage: report.mjs <bundle-a> [bundle-b] [--json] | --siblings <dir> [--current <bundle>]');
  const rows = paths.map((path) => {
    const described = describe(path);
    if (described === undefined) throw new Error(`not a directory: ${path}`);
    return described;
  });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows.length === 2 ? { before: rows[0], after: rows[1], delta: delta(rows[0], rows[1]) } : rows, null, 2)}\n`);
    return;
  }
  for (const row of rows) process.stdout.write(`${format(row)}\n\n`);
  if (rows.length === 2) {
    const d = delta(rows[0], rows[1]);
    process.stdout.write([
      'delta (after - before)',
      `  packages     ${signed(d.packages)}`,
      `  files        ${signed(d.files)}`,
      `  size         ${d.logicalMiB >= 0 ? '+' : ''}${d.logicalMiB.toFixed(2)} MiB `
        + `(${d.percentMiB >= 0 ? '+' : ''}${d.percentMiB.toFixed(1)}%)`,
      `  license gaps ${signed(d.licenseGaps)}`,
      '',
    ].join('\n'));
  }
}

function delta(before, after) {
  return {
    packages: after.packages - before.packages,
    files: after.files - before.files,
    logicalMiB: Number((after.logicalMiB - before.logicalMiB).toFixed(2)),
    percentMiB: before.logicalMiB === 0 ? 0 : Number((((after.logicalMiB - before.logicalMiB) / before.logicalMiB) * 100).toFixed(1)),
    licenseGaps: after.licenseGaps - before.licenseGaps,
  };
}

function signed(value) {
  return value >= 0 ? `+${value}` : String(value);
}

try {
  main();
} catch (error) {
  process.stderr.write(`report: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}
