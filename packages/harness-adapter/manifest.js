import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

export function digestJson(value) {
  return sha256Bytes(stableJson(value));
}

function fileEntry(root, path) {
  const stat = lstatSync(path);
  const name = relative(root, path).split(sep).join('/');
  if (stat.isSymbolicLink()) {
    return { path: name, type: 'symlink', target: readlinkSync(path) };
  }
  if (!stat.isFile()) return undefined;
  return {
    path: name,
    type: 'file',
    size: Number(stat.size),
    sha256: sha256File(path),
  };
}

export function hashPackageFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.shift();
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isDirectory()) pending.push(path);
      else {
        const entry = fileEntry(root, path);
        if (entry) files.push(entry);
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function packageName(location, entry) {
  if (entry.name) return entry.name;
  const marker = 'node_modules/';
  return location.slice(location.lastIndexOf(marker) + marker.length);
}

/** Build package evidence from the real lockfile and installed release files. */
export function buildPackageLayer(repositoryRoot) {
  const lockPath = join(repositoryRoot, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const packages = [];
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!location.includes('node_modules/') || entry.link) continue;
    const absolute = join(repositoryRoot, location);
    const installed = existsSync(absolute);
    if (!installed && !entry.optional) {
      throw new Error(`Required locked package is not installed: ${location}`);
    }
    const files = installed ? hashPackageFiles(absolute) : [];
    packages.push({
      name: packageName(location, entry),
      version: entry.version,
      lockfilePath: location,
      resolved: entry.resolved,
      integrity: entry.integrity,
      license: entry.license,
      dev: entry.dev === true,
      optional: entry.optional === true,
      installed,
      packageJsonSha256: installed && existsSync(join(absolute, 'package.json'))
        ? sha256File(join(absolute, 'package.json'))
        : null,
      files,
      filesSha256: digestJson(files),
    });
  }
  packages.sort((left, right) => left.lockfilePath.localeCompare(right.lockfilePath, 'en'));
  return {
    schemaVersion: '1.0',
    source: 'package-lock.json + installed npm release files',
    lockfileSha256: sha256File(lockPath),
    packageCount: packages.length,
    installedPackageCount: packages.filter((entry) => entry.installed).length,
    packages,
  };
}

export function buildFourLayerManifest({ policy, packageLayer, runtime, stdio, overlayEvidence }) {
  const manifest = {
    schemaVersion: '1.0',
    author: 'PT-dove',
    profile: policy.profile,
    upstream: policy.upstream,
    package: packageLayer,
    plugins: overlayEvidence ? { ...runtime.plugins, overlaySourceFiles: overlayEvidence } : runtime.plugins,
    services: runtime.services,
    model: runtime.model,
    ...(stdio ? { stdio } : {}),
  };
  return {
    ...manifest,
    layerDigests: {
      package: digestJson(manifest.package),
      plugins: digestJson(manifest.plugins),
      services: digestJson(manifest.services),
      model: digestJson(manifest.model),
    },
    manifestSha256: digestJson(manifest),
  };
}

/**
 * Project a validated four-layer manifest onto a reviewable evidence document.
 * The complete per-file package inventory stays in its own evidence file; this
 * view keeps the layer digest so the projection cannot silently drift from the
 * file it points at.
 */
export function projectManifestEvidence(manifest, { packageLayerFile = 'harness-package-layer.json' } = {}) {
  const { packages, ...packageHeader } = manifest.package;
  return {
    ...manifest,
    package: {
      ...packageHeader,
      fileEvidence: packageLayerFile,
      layerSha256: digestJson(manifest.package),
      packages: packages.map((entry) => {
        const { files, ...rest } = entry;
        return { ...rest, fileCount: files.length };
      }),
    },
  };
}

/** Re-attach the full package inventory so evidence can be re-validated offline. */
export function rehydrateManifestEvidence(view, packageLayer) {
  return { ...view, package: packageLayer };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
