/**
 * profiles.mjs — the bundle-composition profile reader (author PT-dove).
 *
 * A profile is the input that decides *what ships*: the closure roots plus the
 * loose assets (console, rule packs). It is not the Cordis analysis profile under
 * `plugins/dsh-defense-profile`; that one configures the worker at runtime, this
 * one configures the packager.
 *
 * It lives in `lib/` because two callers need the same answer: the builder (which
 * stages the payload) and the prune generator (which must derive its evidence
 * from the same roots, or the list it writes would describe a different bundle).
 * Two copies of this parser would drift, and the drift would show up as a bundle
 * that prunes a package the other profile needs.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isInside } from './paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this file (`deploy/embedded-runtime/lib/`). */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

/** Directory holding the shipped profiles. */
export const PROFILES_DIR = join(HERE, '..', 'profiles');

/** Profile used when the caller names none: the v13 payload, unchanged. */
export const DEFAULT_PROFILE = 'worker';

/** Names available on disk, for error messages and `--help`. */
export function listProfiles() {
  return readdirSync(PROFILES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Load and validate a bundle profile.
 *
 * `spec` is a bare profile name (`worker`, `daemon-console`) resolved under
 * `deploy/embedded-runtime/profiles/`, or a path to a JSON document. Validation is
 * strict on purpose: a typo that silently dropped a closure root would ship a
 * bundle that boots to a missing package instead of failing the build.
 */
export function loadProfile(spec, { repoRoot = REPO_ROOT } = {}) {
  const candidate = existsSync(resolve(spec)) ? resolve(spec) : join(PROFILES_DIR, `${spec}.json`);
  if (!existsSync(candidate)) {
    throw new Error(`bundle profile not found: ${spec} (looked for ${candidate}; known profiles: ${listProfiles().join(', ')})`);
  }
  const document = JSON.parse(readFileSync(candidate, 'utf8'));
  if (document.schemaVersion !== '1.0') throw new Error(`${candidate}: schemaVersion must be "1.0"`);
  if (typeof document.name !== 'string' || document.name.length === 0) throw new Error(`${candidate}: name is required`);
  if (!Array.isArray(document.closureRoots) || document.closureRoots.length === 0) {
    throw new Error(`${candidate}: closureRoots must be a non-empty array`);
  }
  for (const root of document.closureRoots) {
    if (typeof root !== 'string' || root.length === 0) throw new Error(`${candidate}: closureRoots contains a non-string entry`);
  }
  const assets = document.assets ?? {};
  if (assets === null || typeof assets !== 'object' || Array.isArray(assets)) {
    throw new Error(`${candidate}: assets must be an object`);
  }

  const repositoryPath = (value, label) => {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${candidate}: ${label} must be a non-empty string`);
    if (value.includes('\\')) throw new Error(`${candidate}: ${label} must use forward slashes: ${value}`);
    const absolute = resolve(repoRoot, value);
    if (!isInside(absolute, repoRoot)) throw new Error(`${candidate}: ${label} escapes the repository: ${value}`);
    return absolute;
  };
  const bundlePath = (value, label) => {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${candidate}: ${label} must be a non-empty string`);
    if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
      throw new Error(`${candidate}: ${label} must be a bundle-relative forward-slash path: ${value}`);
    }
    const segments = value.split('/');
    if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
      throw new Error(`${candidate}: ${label} must not climb or collapse: ${value}`);
    }
    return value;
  };

  const resolvedAssets = {};
  for (const [kind, spec2] of Object.entries(assets)) {
    if (spec2 === null || typeof spec2 !== 'object' || Array.isArray(spec2)) {
      throw new Error(`${candidate}: assets.${kind} must be an object`);
    }
    const entry = { kind, target: bundlePath(spec2.target, `assets.${kind}.target`) };
    if (spec2.preferredSource !== undefined) entry.preferredSource = repositoryPath(spec2.preferredSource, `assets.${kind}.preferredSource`);
    if (spec2.shellSource !== undefined) entry.shellSource = repositoryPath(spec2.shellSource, `assets.${kind}.shellSource`);
    if (spec2.source !== undefined) entry.source = repositoryPath(spec2.source, `assets.${kind}.source`);
    // A single-file fallback, not a directory: the console's pages and its server
    // are separate inputs, and a profile may take one from the product tree and
    // the other from the packaging shell.
    if (spec2.serverFallback !== undefined) {
      entry.serverFallbackSource = repositoryPath(spec2.serverFallback, `assets.${kind}.serverFallback`);
    }
    if (entry.preferredSource === undefined && entry.shellSource === undefined && entry.source === undefined) {
      throw new Error(`${candidate}: assets.${kind} declares no source`);
    }
    if (spec2.requireEntry !== undefined) entry.requireEntry = String(spec2.requireEntry);
    if (spec2.requirePattern !== undefined) entry.requirePattern = String(spec2.requirePattern);
    resolvedAssets[kind] = entry;
  }

  const forwarders = Array.isArray(document.entryForwarders) ? document.entryForwarders : [];
  for (const forwarder of forwarders) {
    if (typeof forwarder?.package !== 'string' || forwarder.package.length === 0) {
      throw new Error(`${candidate}: entryForwarders entry needs a package name`);
    }
    bundlePath(forwarder.target, 'entryForwarders.target');
  }

  return {
    name: document.name,
    bundleName: document.bundleName,
    description: document.description,
    closureRoots: document.closureRoots,
    assets: resolvedAssets,
    entryForwarders: forwarders.map((item) => ({ package: item.package, target: item.target })),
    launchers: Array.isArray(document.launchers) ? document.launchers : ['worker'],
    // Optional repo-relative default output. A profile that declares one names the
    // delivered-artifact location itself, so the builder cannot guess a path
    // outside the repository by accident (which is how v13's payload ended up in a
    // scratch directory three levels above the project).
    defaultOut: document.defaultOut === undefined
      ? undefined
      : bundlePath(document.defaultOut, 'defaultOut'),
    document,
    path: candidate,
    sha256: sha256File(candidate),
    // Repo-relative and forward-slashed, so the record travels with the bundle
    // without naming the machine that built it.
    recordPath: relative(repoRoot, candidate).split(sep).join('/'),
  };
}
