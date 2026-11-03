/**
 * Staging primitives for the embedded-runtime bundle.
 *
 * Everything here copies from the repository or from the installed Node
 * runtime. Nothing installs, downloads, writes to the repository, or follows a
 * symlink out of the bundle root.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { isInside } from './paths.mjs';

export const AUTHOR = 'PT-dove';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function canRead(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Copy one installed package into the staged `node_modules` tree, preserving the
 * lockfile path (`node_modules/a/node_modules/b`) so nested versions stay nested.
 * Nested `node_modules` folders are skipped: every closure member has its own
 * entry and is copied exactly once.
 *
 * A symlink anywhere inside the package would either be dereferenced into copied
 * foreign content or become an escape hatch out of the bundle, so it is refused
 * rather than dereferenced.
 */
export function stagePackage(node, appRoot) {
  const destination = join(appRoot, node.key);
  if (!existsSync(node.sourceDir)) throw new Error(`package source missing: ${node.sourceDir}`);
  const links = symlinksUnder(node.sourceDir, node.sourceDir);
  if (links.length > 0) {
    throw new Error(`package ${node.name} contains symlinks, refusing to stage it: ${links.slice(0, 5).join(', ')}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(node.sourceDir, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
    filter: (source) => {
      if (source === node.sourceDir) return true;
      const name = basename(source);
      if (name === 'node_modules') return false;
      if (name === '.bin') return false;
      return true;
    },
  });
  return destination;
}

/** Every symlink below `directory`, reported relative to `root`. */
function symlinksUnder(directory, root) {
  const found = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        found.push(relative(root, child).split(sep).join('/'));
      } else if (entry.isDirectory() && entry.name !== 'node_modules') {
        walk(child);
      }
    }
  };
  walk(directory);
  return found;
}

/**
 * Copy the bundled Node runtime and its license text into the bundle.
 *
 * The Windows MSI installation of Node ships `node.exe` without a LICENSE file,
 * so the text is taken from an explicit local source (`--node-license`). Node's
 * LICENSE contains no version string at all, so guessing the version from the
 * text (a regex over "Node.js v24.x") can only ever return "unknown" — that
 * check was removed because it produced a permanent `false` that looked like
 * evidence.
 *
 * Instead the provenance must be *stated*: `--node-license-attestation <json>`
 * records `{ version, sha256, source }` for the text, and the builder refuses a
 * text whose digest or version does not match the binary it is about to ship.
 * Without an attestation the build fails unless `--allow-license-gap` is passed,
 * in which case the gap is written into the bundle's release gaps, not papered
 * over.
 */
export function stageNodeRuntime({
  nodeExecutable, runtimeDir, nodeLicense, attestation, allowUnattested = false, recordBase,
}) {
  if (!canRead(nodeExecutable)) throw new Error(`Node executable is not readable: ${nodeExecutable}`);
  mkdirSync(runtimeDir, { recursive: true });
  const target = join(runtimeDir, 'node.exe');
  copyFileSync(nodeExecutable, target);
  const candidates = [
    nodeLicense,
    join(dirname(nodeExecutable), 'LICENSE'),
    join(dirname(nodeExecutable), 'LICENSE.txt'),
    join(dirname(nodeExecutable), 'LICENSE.md'),
  ].filter((path) => typeof path === 'string' && path.length > 0);
  const licenseSource = candidates.find((path) => existsSync(path));
  if (licenseSource === undefined) {
    throw new Error('Node license text not found: the Windows Node installation ships none next to node.exe. '
      + 'Pass --node-license <path> with a local copy of the Node LICENSE file; refusing to ship a runtime without attribution');
  }
  copyFileSync(licenseSource, join(runtimeDir, 'LICENSE-NODE.txt'));
  const version = execNodeVersion(nodeExecutable);
  const bundledVersions = execNodeVersions(nodeExecutable);
  const licenseTextSha256 = sha256File(licenseSource);

  const problems = [];
  if (attestation === undefined) {
    problems.push('no --node-license-attestation was supplied, so the license text cannot be tied to the bundled binary');
  } else {
    if (attestation.version !== version) {
      problems.push(`the attestation names ${attestation.version} but the bundled runtime is ${version}`);
    }
    if (attestation.sha256 !== licenseTextSha256) {
      problems.push(`the attestation digest ${String(attestation.sha256).slice(0, 12)}… does not match the license text ${licenseTextSha256.slice(0, 12)}…`);
    }
    if (typeof attestation.source !== 'string' || attestation.source.length === 0) {
      problems.push('the attestation does not say where the license text came from');
    }
  }
  const attested = problems.length === 0;
  if (!attested && !allowUnattested) {
    throw new Error('the bundled Node license text has no verifiable provenance, so this bundle would ship a '
      + `license that nobody can tie to ${version}:\n  ${problems.join('\n  ')}\n`
      + 'Supply --node-license-attestation <json> with { version, sha256, source }, or pass '
      + '--allow-license-gap to build a bundle that records the gap as a release blocker instead of claiming compliance.');
  }

  writeJson(join(runtimeDir, 'runtime.json'), {
    schemaVersion: '1.0',
    author: AUTHOR,
    runtime: 'node',
    version,
    executable: 'runtime/node/node.exe',
    license: 'MIT',
    licenseFile: 'runtime/node/LICENSE-NODE.txt',
    // The build host's own path is not recorded: the bundle must not disclose
    // where it was assembled, and the digest identifies the text well enough.
    //
    // The base used to be `process.cwd()`, which made this string — and therefore
    // this shipped byte — depend on the directory the builder happened to be
    // launched from. Two builds of the same lockfile and profile from different
    // working directories then disagreed on one line of `runtime.json` and the
    // reproducibility gate failed on an artefact of the shell, not on an input.
    // `recordBase` is now the repository, which is an input; when the text lives
    // outside it, only the leaf name is kept.
    licenseSource: typeof recordBase === 'string' && isInside(licenseSource, recordBase)
      ? relative(recordBase, licenseSource).split(sep).join('/')
      : `<external>/${basename(licenseSource)}`,
    licenseTextSha256,
    licenseProvenance: attested ? 'attested' : 'unattested',
    licenseMatchesBundledVersion: attested,
    bundledVersions,
    attestation: attested ? attestation : undefined,
    note: attested
      ? 'The license text is attested for this exact runtime version by an external record.'
      : 'THE LICENSE TEXT IS NOT TIED TO THIS BINARY. This is a recorded release blocker: the formal release '
        + 'must ship the LICENSE file of the exact bundled distribution, and the builder now refuses such a '
        + 'bundle unless --allow-license-gap is passed explicitly.',
    source: 'https://nodejs.org/dist/',
  });
  return {
    executable: target,
    version,
    licenseSource,
    licenseTextSha256,
    licenseMatches: attested,
    problems,
    releaseGap: attested ? undefined : {
      id: 'node-license-provenance',
      severity: 'blocker',
      detail: problems.join('; '),
      action: `Ship the LICENSE file from the official distribution of Node ${version} and attest it with `
        + '{ version, sha256, source }.',
    },
  };
}

/** `process.versions` of the bundled binary, as shipped-runtime evidence. */
function execNodeVersions(nodeExecutable) {
  const { execFileSync } = process.getBuiltinModule('node:child_process');
  try {
    const raw = execFileSync(nodeExecutable, ['-p', 'JSON.stringify(process.versions)'], { encoding: 'utf8' });
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function execNodeVersion(nodeExecutable) {
  // Deliberately does not import child_process at module scope: the build runs
  // exactly one synchronous version probe.
  const { execFileSync } = process.getBuiltinModule('node:child_process');
  return execFileSync(nodeExecutable, ['--version'], { encoding: 'utf8' }).trim();
}

/**
 * Place the reviewed profile files byte-for-byte. The worker verifies their
 * SHA-256 against `approved-hashes.json` before it will boot, so any rewrite
 * here (reformatting, newline normalisation) would fail closed at runtime.
 */
export function stageProfile({
  profileSource,
  toolsSource,
  dshHome,
  profileSourceMirror,
  toolsSourceMirror,
}) {
  const profileDir = join(dshHome, 'profiles', 'aegis-analysis');
  const toolsDir = join(profileDir, 'node_modules', '@aegisharness', 'dsh-defense-tools');
  mkdirSync(profileDir, { recursive: true });
  for (const filename of ['package.json', 'profile.json', 'cordis.patch.yml', 'approved-hashes.json']) {
    copyFileSync(join(profileSource, filename), join(profileDir, filename));
  }
  cpSync(toolsSource, toolsDir, {
    recursive: true,
    filter: (source) => source === toolsSource || !relative(toolsSource, source).split(sep).includes('node_modules'),
  });

  // `@aegisharness/harness-adapter` derives its profile source root from its own
  // location (`new URL('../../', import.meta.url)`), so inside a bundle that root
  // is `<app>/node_modules/plugins`. Mirror both packages there instead of editing
  // adapter source.
  mkdirSync(profileSourceMirror, { recursive: true });
  mkdirSync(toolsSourceMirror, { recursive: true });
  copyFileSync(join(profileSource, 'package.json'), join(profileSourceMirror, 'package.json'));
  copyFileSync(join(profileSource, 'profile.json'), join(profileSourceMirror, 'profile.json'));
  copyFileSync(join(profileSource, 'cordis.patch.yml'), join(profileSourceMirror, 'cordis.patch.yml'));
  copyFileSync(join(profileSource, 'approved-hashes.json'), join(profileSourceMirror, 'approved-hashes.json'));
  cpSync(toolsSource, toolsSourceMirror, {
    recursive: true,
    filter: (source) => source === toolsSource || !relative(toolsSource, source).split(sep).includes('node_modules'),
  });
  return { profileDir, toolsDir };
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|unlicense|copyright)(?:\.[a-z0-9]+)?$/i;

/**
 * Load the recorded licence provenance and refuse a text that does not match it.
 *
 * `license-attestations.json` names, for each text kept under `licenses/`, where
 * it came from and what its SHA-256 was when it was fetched. Re-hashing here is
 * what stops the file from becoming an unverifiable blob: editing a text without
 * updating the record fails the build, and so does an unrecorded extra file.
 *
 * Absence is not an error — a repository state with no attestations simply keeps
 * every missing text in the gap list, which is the pre-existing behaviour.
 */
export function loadLicenseAttestations({ path, baseDir }) {
  if (!existsSync(path)) return { node: undefined, byPackage: new Map(), unobtainable: [], verified: [] };
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const verified = [];
  const check = (record, label) => {
    if (record === undefined) return undefined;
    const target = join(baseDir, ...String(record.file).split('/'));
    if (!existsSync(target)) {
      throw new Error(`license attestation for ${label} points at a missing file: ${record.file}`);
    }
    const actual = sha256File(target);
    if (actual !== record.sha256) {
      throw new Error(`license attestation for ${label} does not match the text on disk:\n`
        + `  recorded ${String(record.sha256).slice(0, 16)}…\n  on disk  ${actual.slice(0, 16)}…\n`
        + 'The text is not what was traced from upstream; fix the file or the record before building.');
    }
    verified.push({ label, file: record.file, sha256: actual });
    return { ...record, path: target };
  };
  const node = check(document.node, 'node');
  const byPackage = new Map();
  for (const record of document.packages ?? []) {
    const resolved = check(record, `${record.name}@${record.version}`);
    if (resolved === undefined) continue;
    byPackage.set(`${record.name}@${record.version}`, resolved);
  }
  return {
    node,
    byPackage,
    unobtainable: document.unobtainable ?? [],
    verified,
  };
}

/**
 * Copy every license/notice file of one staged package into the manifest tree.
 *
 * Package roots are searched by filename, then one level of conventional licence
 * subdirectories (`licenses/`, `license/`, `NOTICE/`) is searched by extension
 * only: upstreams there name their texts by component (`LibreOffice-MPL-2.0.txt`),
 * so requiring a filename match would silently drop MPL/LGPL obligations.
 */
function collectLicenseFiles(node, destination, licensesRoot) {
  if (!existsSync(destination)) return [];
  const TEXT_FILE = /\.(?:txt|md|html?|rtf|json)$/i;
  const files = [];
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (entry.isFile() && LICENSE_FILE.test(entry.name)) {
      files.push(join(destination, entry.name));
    } else if (entry.isDirectory() && /^(?:licen[cs]es?|notice|copyright)$/i.test(entry.name)) {
      const directory = join(destination, entry.name);
      for (const inner of readdirSync(directory, { withFileTypes: true })) {
        if (inner.isFile() && (LICENSE_FILE.test(inner.name) || TEXT_FILE.test(inner.name))) {
          files.push(join(directory, inner.name));
        }
      }
    }
  }
  files.sort();
  const collected = [];
  const key = `${node.name}@${node.version}`;
  const targetDir = join(licensesRoot, key.replace(/[\\/:*?"<>|]/g, '_'));
  for (const file of files) {
    mkdirSync(targetDir, { recursive: true });
    const name = relative(destination, file).split(sep).join('__');
    copyFileSync(file, join(targetDir, name));
    collected.push(`licenses/${basename(targetDir)}/${name}`);
  }
  return collected;
}

/** Write the third-party inventory, per-package license texts and the notice file. */
export function writeThirdPartyManifests({
  nodes, appRoot, manifestsDir, projectNotice, pruned = [], pathPrefix = 'app',
  projectLicenseFile, firstPartyPrefix = '@aegisharness/', supplemental = new Map(),
}) {
  const licensesRoot = join(manifestsDir, 'licenses');
  mkdirSync(licensesRoot, { recursive: true });
  const packages = [...nodes.values()]
    .map((node) => ({
      name: node.name,
      version: node.version,
      license: node.license,
      path: `${pathPrefix}/${node.key.split(sep).join('/')}`,
      licenseFiles: collectLicenseFiles(node, join(appRoot, node.key), licensesRoot),
    }))
    .map((pkg) => {
      // First-party packages carry the repository's own license, which is not
      // inside their directory because they are workspace sources. Copying it
      // into the bundle is what makes "Apache-2.0" an actual text rather than an
      // identifier: without it these four would sit in the gap list forever.
      if (pkg.licenseFiles.length > 0) return pkg;
      if (!pkg.name.startsWith(firstPartyPrefix)) return pkg;
      if (typeof projectLicenseFile !== 'string' || !existsSync(projectLicenseFile)) return pkg;
      const targetDir = join(licensesRoot, `${pkg.name}@${pkg.version}`.replace(/[\\/:*?"<>|]/g, '_'));
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(projectLicenseFile, join(targetDir, 'PROJECT-LICENSE.txt'));
      return { ...pkg, licenseFiles: [`licenses/${basename(targetDir)}/PROJECT-LICENSE.txt`] };
    })
    .map((pkg) => {
      // A package whose published tarball omits its own license text still has a
      // real upstream text — it just lives in the release it was cut from. The
      // attestation record says which one, and the digest was already re-checked
      // while loading, so this copies a traced document rather than a guess.
      if (pkg.licenseFiles.length > 0) return pkg;
      const record = supplemental.get(`${pkg.name}@${pkg.version}`);
      if (record === undefined) return pkg;
      if (record.license !== pkg.license) {
        throw new Error(`the attested text for ${pkg.name}@${pkg.version} is ${record.license} but the bundle `
          + `inventories it as ${pkg.license}; refusing to file a licence under the wrong identifier`);
      }
      const targetDir = join(licensesRoot, `${pkg.name}@${pkg.version}`.replace(/[\\/:*?"<>|]/g, '_'));
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(record.path, join(targetDir, 'UPSTREAM-LICENSE.txt'));
      return {
        ...pkg,
        licenseFiles: [`licenses/${basename(targetDir)}/UPSTREAM-LICENSE.txt`],
        licenseProvenance: {
          kind: 'upstream-release',
          source: record.source,
          sourcePath: record.sourcePath,
          sha256: record.sha256,
        },
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'en') || left.version.localeCompare(right.version, 'en'));

  const byLicense = new Map();
  for (const pkg of packages) byLicense.set(pkg.license, (byLicense.get(pkg.license) ?? 0) + 1);
  writeJson(join(manifestsDir, 'third-party-packages.json'), {
    schemaVersion: '1.0',
    author: AUTHOR,
    count: packages.length,
    byLicense: Object.fromEntries([...byLicense.entries()].sort((left, right) => left[0].localeCompare(right[0], 'en'))),
    packages,
  });

  const missingText = packages.filter((pkg) => pkg.licenseFiles.length === 0);
  const supplied = packages.filter((pkg) => pkg.licenseProvenance?.kind === 'upstream-release');
  const prunedTotal = pruned.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
  const lines = [
    'AegisHarness embedded runtime — third-party notices',
    '===================================================',
    '',
    `Generated by deploy/embedded-runtime/build.mjs for author ${AUTHOR}.`,
    'This file lists every npm package copied into this bundle with its SPDX',
    'license identifier. Where the upstream package ships license or notice text,',
    'the full text is under manifests/licenses/<name>@<version>/.',
    '',
    `Packages with bundled license text: ${packages.length - missingText.length} of ${packages.length}.`,
    ...(supplied.length === 0 ? [] : [
      `Of those, ${supplied.length} package(s) publish no license file of their own; the text filed for them`,
      'comes from the release they were cut from and is recorded in manifests/license-provenance.json:',
      ...supplied.map((pkg) => `  - ${pkg.name}@${pkg.version} <- ${pkg.licenseProvenance.source}`),
      '',
    ]),
    missingText.length === 0
      ? 'Every package carries its own text.'
      : `Upstream ships no license file for ${missingText.length} package(s); their SPDX id above is the `
        + 'only attribution available from the copy installed here, which is recorded rather than invented:',
    ...missingText.map((pkg) => `  - ${pkg.name}@${pkg.version} (${pkg.license})`),
    '',
    `The same ${missingText.length} package(s) are listed as open items in manifests/license-gaps.json.`,
    'They are NOT covered by any license text in this bundle and must not be described as compliant.',
    '',
  ];
  if (pruned.length > 0) {
    lines.push(
      'Pruned dependencies',
      '-------------------',
      `This bundle does not contain ${pruned.length} package(s) from the lockfile production closure`,
      `(${(prunedTotal / 1048576).toFixed(1)} MiB) because the reviewed profile provably never loads them.`,
      'The evidence for every removal is in manifests/trim-report.json; nothing was removed without it.',
      '',
      ...pruned.map((row) => `  - ${row.name}@${row.version} (${row.license})`),
      '',
    );
  }
  lines.push(
    'The bundle is assembled from the repository lockfile; it is not an install',
    'and it carries no package manager metadata beyond the copied manifests.',
    '',
    `Packages: ${packages.length}`,
    '',
    ...packages.map((pkg) => `${pkg.name}@${pkg.version}\t${pkg.license}`),
    '',
    'Bundled Node.js runtime',
    '-----------------------',
    'Node.js is distributed under the MIT license; the full text and the',
    'third-party notices it carries are in runtime/node/LICENSE-NODE.txt.',
    'See runtime/node/runtime.json for whether that text is attested for the exact',
    'bundled version; an unattested text is listed as a release blocker.',
    '',
    'Licence provenance',
    '------------------',
    'manifests/license-provenance.json names the upstream release every text filed',
    'under manifests/licenses/ was taken from. manifests/license-attestations.json is',
    'the build input behind it, copied in so the digests can be re-checked from the',
    'bundle alone.',
    '',
    'Project notice',
    '--------------',
    projectNotice.trimEnd(),
    '',
  );
  writeFileSync(join(manifestsDir, 'THIRD-PARTY-NOTICES.txt'), `${lines.join('\n')}\n`);
  writeJson(join(manifestsDir, 'license-provenance.json'), {
    schemaVersion: '1.0',
    author: AUTHOR,
    policy: 'Only texts traced from an upstream release are listed here. A package whose text came from its own '
      + 'installed tarball has no entry; a package with no text at all is an open gap in license-gaps.json.',
    count: supplied.length,
    packages: supplied.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      file: pkg.licenseFiles[0],
      textSha256: sha256File(join(manifestsDir, pkg.licenseFiles[0])),
      ...pkg.licenseProvenance,
    })),
  });
  return { packages, byLicense, supplied };
}

/**
 * Per-package record of the packages that ship no upstream license text.
 *
 * These are compliance *todos*, not a claim: the SPDX id from the installed
 * manifest is all the evidence that exists locally, so the obligation stays open
 * until someone obtains the upstream text.
 */
export function writeLicenseGaps({ packages, manifestsDir, author }) {
  const gaps = packages
    .filter((pkg) => pkg.licenseFiles.length === 0)
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      bundledIn: pkg.path,
      reason: 'the installed copy ships no LICENSE/COPYING/NOTICE file and no licenses/ directory',
      obligation: `distribute the ${pkg.license} text with this package`,
      action: 'obtain the upstream LICENSE/COPYING text for this exact version from the package tarball or its repository, '
        + 'then add it to manifests/licenses/ during the release build',
      status: 'open',
    }));
  const byLicense = {};
  for (const gap of gaps) byLicense[gap.license] = (byLicense[gap.license] ?? 0) + 1;
  writeJson(join(manifestsDir, 'license-gaps.json'), {
    schemaVersion: '1.0',
    author,
    count: gaps.length,
    byLicense: Object.fromEntries(Object.entries(byLicense).sort((left, right) => left[0].localeCompare(right[0], 'en'))),
    policy: 'A package with no upstream license text is recorded here. Its SPDX identifier is not a substitute for the '
      + 'text, and this bundle must not be described as license-complete while count > 0.',
    packages: gaps,
  });
  return { gaps, byLicense };
}

/** The reviewed prune decision and the evidence behind every removal. */
export function writeTrimReport({ manifestsDir, author, pruneList, summary, entries, gate, scope }) {
  writeJson(join(manifestsDir, 'trim-report.json'), {
    schemaVersion: '1.0',
    author,
    scope: {
      ...scope,
      note: 'This decision holds for exactly this lockfile and this reviewed profile configuration. Changing a '
        + 'plugin config value (not only which plugins are mounted) can change what loads at runtime, so a config '
        + 'change requires regenerating the prune list rather than reusing this report.',
    },
    pruneList,
    gate,
    summary,
    pruned: entries,
  });
}

/** Every regular file under `root`, as forward-slash relative paths, sorted. */
export function listBundleFiles(root, { skip = [] } = {}) {
  const files = [];
  const skipSet = new Set(skip.map((name) => name.split(sep).join('/')));
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (skipSet.has(relativePath)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`bundle contains a symlink, which would escape the bundle root: ${relativePath}`);
      }
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  walk(root);
  return files.sort();
}

/** SHA-256 over every bundle file except the manifest directory itself. */
export function writeHashManifest({ bundleRoot, manifestsDir, skip = ['manifests'] }) {
  const files = listBundleFiles(bundleRoot, { skip });
  const rows = files.map((path) => `${sha256File(join(bundleRoot, path))}  ${path}`);
  const text = [
    '# AegisHarness embedded runtime bundle — SHA-256 manifest',
    '# Format: <sha256>  <path relative to bundle root>, two spaces, no quotes.',
    '# The manifests/ directory is excluded: it cannot contain its own digest.',
    '',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(join(manifestsDir, 'files.sha256'), text);
  return { count: files.length, files };
}

export function directorySize(directory) {
  let total = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  };
  walk(directory);
  return total;
}
