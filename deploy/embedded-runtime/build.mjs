/**
 * AegisHarness M8 embedded-runtime bundle builder (packaging PoC).
 *
 * Assembles a self-contained Windows x64 directory outside the repository:
 *
 *   <out>/runtime/node/node.exe        bundled Node 24 runtime
 *   <out>/app/node_modules/...         @deepseek-ai/dsh + production closure,
 *                                      harness-worker, harness-adapter, profile mirrors
 *   <out>/dsh-home/profiles/aegis-analysis/   reviewed profile + defense tools
 *   <out>/launch/                      fixed-absolute-path launcher + launch plan
 *   <out>/manifests/                   SHA-256 file list, third-party licenses, notices
 *
 * Invariants this builder holds:
 * - never writes inside the repository (refuses an output path under it);
 * - never runs npm/npx/install/fetch: dependencies are copied from the committed
 *   lockfile's already-installed tree;
 * - the reviewed profile and defense-tool files are copied byte-for-byte, because
 *   the worker verifies their SHA-256 before booting.
 *
 * Usage: node deploy/embedded-runtime/build.mjs [--profile <name|file>] [--out <dir>] [--node <exe>]
 *        [--node-license <LICENSE>] [--node-license-attestation <json>]
 *        [--license-attestations <json>] [--allow-license-gap]
 *        [--prune <prune-list.json>] [--plan-only]
 *        [--profile-snapshot <dir>] [--allow-repo-output] [--force]
 *
 * A *profile* is the composition, not the Cordis analysis profile: it names the
 * closure roots and the loose assets (console, rule packs) that a given payload
 * ships. `worker` reproduces v13 exactly; `daemon-console` adds the daemon and a
 * console so an installation has a server and a UI. The profile is an input, so
 * the builder records its digest in `bundle.json` and never infers it from the
 * output directory name.
 *
 * `--prune` removes reviewed dependencies from the *staged* copy only. The gate
 * in `lib/usage.mjs` re-derives the evidence on every build, so a stale or
 * over-eager prune list fails the build instead of shipping a bundle whose
 * worker cannot boot. `--plan-only` runs the same gate and prints the plan
 * without writing anything.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeClosure, loadLockfile } from './lib/closure.mjs';
import { assertPlainAbsolutePath, canonicalize, isInside, overlaps, portableRelative } from './lib/paths.mjs';
import { DEFAULT_PROFILE, PROFILES_DIR, loadProfile } from './lib/profiles.mjs';
import {
  AUTHOR,
  directorySize,
  listBundleFiles,
  loadLicenseAttestations,
  sha256File,
  stageNodeRuntime,
  stagePackage,
  stageProfile,
  writeHashManifest,
  writeJson,
  writeLicenseGaps,
  writeThirdPartyManifests,
  writeTrimReport,
} from './lib/stage.mjs';
import {
  analyzeUsage,
  buildDependentsIndex,
  evaluateCandidate,
  loadReachedCorpus,
  pruneCandidates,
} from './lib/usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_OUT = join(dirname(REPO_ROOT), '_m8_poc', 'bundle', 'aegis-embedded-win32-x64-v13-relocatable');
const DEFAULT_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const DEFAULT_ATTESTATIONS = join(HERE, 'license-attestations.json');
/**
 * The only place inside the repository a bundle may be written.
 *
 * `dist/bundle/` is the delivered-artifact tree, so an in-repo bundle there is
 * the intended outcome rather than the accident that the old blanket refusal was
 * preventing. Every other repository path stays refused: the guard was never
 * about "inside vs outside", it was about not scattering build output over
 * sources, and a one-entry allowlist keeps that meaning intact.
 */
const REPO_OUTPUT_ROOT = join(REPO_ROOT, 'dist', 'bundle');

function parseArguments(argv) {
  const options = {
    out: DEFAULT_OUT,
    node: DEFAULT_NODE,
    nodeLicense: process.env.M8_NODE_LICENSE,
    nodeLicenseAttestation: process.env.M8_NODE_LICENSE_ATTESTATION,
    attestations: DEFAULT_ATTESTATIONS,
    allowLicenseGap: false,
    // The formal stage ships a trimmed bundle by default: a build whose default
    // output is named "-v9-pruned" but which silently stages all 654 packages
    // would be a trap. `--no-prune` opts out explicitly.
    prune: existsSync(join(HERE, 'prune-list.json')) ? join(HERE, 'prune-list.json') : undefined,
    // A per-profile list (`prune-list-<profile>.json`) replaces the default one
    // when it exists, because a prune decision is only valid for the closure it was
    // derived from. `--prune`/`--no-prune` still win: an explicit choice is never
    // overridden by a filename convention.
    pruneExplicit: false,
    planOnly: false,
    profileSnapshot: process.env.M8_PROFILE_SNAPSHOT,
    profile: process.env.M8_BUNDLE_PROFILE ?? DEFAULT_PROFILE,
    // Pins the console asset to a frozen copy. `apps/console` is edited by another
    // writer while a bundle is being assembled, so "the product console" is not a
    // stable input by itself: two builds minutes apart would ship different bytes
    // and the reproducibility gate would fail on a moving target rather than on
    // the builder. A pinned directory is an input like `--profile-snapshot`.
    consoleSource: process.env.M8_CONSOLE_SOURCE,
    allowRepoOutput: false,
    outExplicit: false,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--out') {
      options.out = resolve(argv[++index] ?? '');
      options.outExplicit = true;
    } else if (token === '--profile') options.profile = argv[++index] ?? DEFAULT_PROFILE;
    else if (token === '--node') options.node = resolve(argv[++index] ?? '');
    else if (token === '--node-license') options.nodeLicense = resolve(argv[++index] ?? '');
    else if (token === '--node-license-attestation') options.nodeLicenseAttestation = resolve(argv[++index] ?? '');
    else if (token === '--license-attestations') options.attestations = resolve(argv[++index] ?? '');
    else if (token === '--no-license-attestations') options.attestations = undefined;
    else if (token === '--allow-license-gap') options.allowLicenseGap = true;
    else if (token === '--prune') {
      options.prune = resolve(argv[++index] ?? '');
      options.pruneExplicit = true;
    } else if (token === '--no-prune') {
      options.prune = undefined;
      options.pruneExplicit = true;
    }     else if (token === '--plan-only') options.planOnly = true;
    else if (token === '--profile-snapshot') options.profileSnapshot = resolve(argv[++index] ?? '');
    else if (token === '--console-source') {
      options.consoleSource = resolve(argv[++index] ?? '');
      options.consoleSourceExplicit = true;
    } else if (token === '--allow-repo-output') options.allowRepoOutput = true;
    else if (token === '--force') options.force = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}


/**
 * Resolve the reviewed plugin sources.
 *
 * Default: the repository itself. `--profile-snapshot <dir>` pins them to a
 * frozen copy placed outside the repository, which is what a reproducible bundle
 * needs when another writer is concurrently editing the plugin tree.
 */
function resolveProfileSources(snapshot) {
  if (snapshot === undefined || snapshot === null) {
    return {
      kind: 'repository',
      dir: REPO_ROOT,
      profileSource: join(REPO_ROOT, 'plugins', 'dsh-defense-profile'),
      toolsSource: join(REPO_ROOT, 'plugins', 'dsh-defense-tools'),
    };
  }
  const root = resolve(snapshot);
  return {
    kind: 'frozen-snapshot',
    dir: root,
    profileSource: join(root, 'dsh-defense-profile'),
    toolsSource: join(root, 'dsh-defense-tools'),
  };
}

/**
 * Fail closed unless the staged inputs are exactly the reviewed bytes.
 *
 * The worker verifies the same six digests before it will boot, so a bundle built
 * from a tree whose `approved-hashes.json` has drifted would ship a worker that
 * refuses to start. Catching it here names the offending file instead of leaving
 * a confusing runtime failure. This already happened once in this repository: a
 * concurrent writer edited `dsh-defense-tools/lib/runtime-inspect.js` without
 * regenerating the whitelist, which makes the working tree itself unbootable.
 */
function verifyApprovedInputs({ profileSource, toolsSource }) {
  const approvedPath = join(profileSource, 'approved-hashes.json');
  if (!existsSync(approvedPath)) throw new Error(`approved-hashes.json is missing at ${approvedPath}`);
  const approved = JSON.parse(readFileSync(approvedPath, 'utf8'));
  const verified = {};
  const drifted = [];
  for (const [source, record] of Object.entries(approved.files)) {
    const target = source.startsWith('plugins/dsh-defense-profile/')
      ? join(profileSource, source.slice('plugins/dsh-defense-profile/'.length))
      : source.startsWith('plugins/dsh-defense-tools/')
        ? join(toolsSource, source.slice('plugins/dsh-defense-tools/'.length))
        : undefined;
    if (target === undefined) throw new Error(`approved hash names an unexpected source: ${source}`);
    if (!existsSync(target)) {
      drifted.push(`${source}: missing`);
      continue;
    }
    const actual = sha256File(target);
    if (actual !== record.sha256) drifted.push(`${source}: approved ${record.sha256.slice(0, 12)}…, on disk ${actual.slice(0, 12)}…`);
    verified[source] = { sha256: actual, approved: record.sha256 === actual };
  }
  if (drifted.length > 0) {
    throw new Error('reviewed plugin bytes and approved-hashes.json disagree, so the packaged worker would fail '
      + `its own preflight:\n  ${drifted.join('\n  ')}\n`
      + 'Fix the whitelist in the owning task, or pass --profile-snapshot with a frozen approved copy.');
  }
  return { approved, verified, approvedHashesSha256: sha256File(approvedPath) };
}

function assertOutsideRepository(out, { allowRepoOutput = false } = {}) {
  assertPlainAbsolutePath(out, '--out');
  if (!overlaps(out, REPO_ROOT)) return;
  // The delivered-artifact tree is the one place inside the repository a bundle
  // may live, and only when the caller asked for it in so many words. The check is
  // against the narrower root, so `dist/` itself, `dist/bundle/../../apps`, and the
  // shared `dist/bundle/` parent all still fail.
  if (allowRepoOutput) {
    if (!isInside(out, REPO_OUTPUT_ROOT)) {
      throw new Error(`--allow-repo-output only permits ${canonicalize(REPO_OUTPUT_ROOT)} and below, refusing ${canonicalize(out)}`);
    }
    if (resolve(out) === resolve(REPO_OUTPUT_ROOT)) {
      throw new Error(`refusing to use ${canonicalize(REPO_OUTPUT_ROOT)} itself as the bundle root; name a versioned directory under it`);
    }
    return;
  }
  throw new Error(`refusing to build inside the repository or over its parent (${canonicalize(out)}); `
    + `pass --allow-repo-output to place it under dist/bundle/, or build outside ${canonicalize(REPO_ROOT)}`);
}

function assertNotSystemPath(out) {
  // The OS temp directory is scratch space by definition, so an attempt-shaped
  // output under %TEMP% is allowed; everything else under the profile is not.
  const temp = resolve(process.env.TEMP ?? process.env.TMP ?? tmpdir());
  if (isInside(out, temp)) return;
  const forbidden = [process.env.SystemRoot, process.env.ProgramFiles, process.env.ProgramData, process.env.USERPROFILE]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => resolve(value));
  for (const path of forbidden) {
    if (isInside(out, path)) throw new Error(`refusing to write the bundle under a protected system path: ${out}`);
  }
}

function prepareOutput(out, force, { allowRepoOutput = false } = {}) {
  if (existsSync(out)) {
    const marker = join(out, 'bundle.json');
    if (!force || !existsSync(marker)) {
      throw new Error(`output already exists: ${out} (pass --force to replace a previous PoC bundle bearing bundle.json)`);
    }
    // Re-assert every guard on the canonical path immediately before a recursive
    // delete: a link, a short name or a system path must not be reachable here
    // just because the first check ran against a different spelling.
    assertOutsideRepository(out, { allowRepoOutput });
    assertNotSystemPath(out);
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Emit the built-in rule pack seeder.
 *
 * The daemon validates `detection.rulePackPath` with `resolveInside(dataDir, …)`,
 * so `<bundle>/rules/defense-seed-pack.json` is refused at startup with
 * "must stay inside the data directory". That is a deliberate daemon invariant
 * (nothing the daemon reads may live outside the one writable root), and it is
 * not a packaging bug — but a bundle that documents `--rules <bundle>/rules/...`
 * ships an instruction that does not work.
 *
 * The seeder closes that gap in the packaging layer: it copies the built-in packs
 * into `<data dir>/rules/`, verifies every digest against the recorded manifest,
 * and refuses to overwrite a different file at the same path. The shipped
 * `.cmd` launcher runs it before the daemon, which is why the launcher's argv can
 * point inside the data directory honestly.
 */
function writeRuleSeeder({ out, packs }) {
  const script = [
    '#!/usr/bin/env node',
    `// AegisHarness embedded runtime — built-in rule pack seeder (author ${AUTHOR}).`,
    '//',
    '// usage: node launch/seed-rules.mjs --data-dir <absolute dir> [--force]',
    '//',
    '// Why this exists: the daemon refuses a rule pack outside its data directory',
    '// (detection.rulePackPath is resolved inside it), so the bundle\'s own rules/',
    '// path cannot be handed to --rules. This copies the shipped packs into',
    '// <data dir>/rules/ and verifies each digest against manifests/rule-packs.json,',
    '// which the builder wrote from the bytes it actually staged.',
    '//',
    '// Idempotent: an identical file is left untouched; a different file at the same',
    '// path is a refusal, not a silent overwrite, because the operator may have',
    '// pinned a reviewed pack there.',
    '',
    "import { createHash } from 'node:crypto';",
    "import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { basename, dirname, isAbsolute, join, resolve } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    '// Derived from this file, never stored: the bundle has to survive being copied.',
    "const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');",
    "const RECORD = join(BUNDLE_ROOT, 'manifests', 'rule-packs.json');",
    '',
    'function sha256(path) {',
    "  return createHash('sha256').update(readFileSync(path)).digest('hex');",
    '}',
    '',
    'function fail(message, code = 1) {',
    "  process.stderr.write(`seed-rules: ${message}\\n`);",
    '  process.exit(code);',
    '}',
    '',
    'const argv = process.argv.slice(2);',
    'let dataDir;',
    'let force = false;',
    'for (let index = 0; index < argv.length; index += 1) {',
    "  if (argv[index] === '--data-dir') dataDir = argv[++index];",
    "  else if (argv[index] === '--force') force = true;",
    "  else if (argv[index] === '--help' || argv[index] === '-h') {",
    "    process.stdout.write('usage: node launch/seed-rules.mjs --data-dir <absolute dir> [--force]\\n');",
    '    process.exit(0);',
    "  } else fail(`unknown argument: ${argv[index]}`, 2);",
    '}',
    "if (typeof dataDir !== 'string' || dataDir.length === 0) fail('--data-dir is required', 2);",
    'if (!isAbsolute(dataDir)) fail(`--data-dir must be absolute: ${dataDir}`, 2);',
    'const root = resolve(dataDir);',
    'if (!existsSync(RECORD)) fail(`rule pack record missing: ${RECORD}`);',
    "const record = JSON.parse(readFileSync(RECORD, 'utf8'));",
    "if (!Array.isArray(record.packs) || record.packs.length === 0) fail('the record lists no rule packs');",
    '',
    'mkdirSync(join(root, \'rules\'), { recursive: true });',
    'const seeded = [];',
    'const refused = [];',
    'for (const pack of record.packs) {',
    '  const source = join(BUNDLE_ROOT, ...pack.path.split(\'/\'));',
    "  if (!existsSync(source)) { refused.push(`${pack.path}: missing from the bundle`); continue; }",
    '  const sourceDigest = sha256(source);',
    "  if (sourceDigest !== pack.sha256) {",
    '    refused.push(`${pack.path}: staged digest ${sourceDigest.slice(0, 12)}… does not match the recorded ${String(pack.sha256).slice(0, 12)}…`);',
    '    continue;',
    '  }',
    '  // The daemon reads <data dir>/rules/<basename>; keeping the leaf name means',
    '  // the pack id in a log line still names the file an operator can find.',
    "  const target = join(root, 'rules', basename(pack.path));",
    '  if (existsSync(target)) {',
    '    if (sha256(target) === sourceDigest) { seeded.push({ name: basename(pack.path), path: target, sha256: sourceDigest, action: \'unchanged\' }); continue; }',
    "    if (!force) { refused.push(`${target}: a different rule pack already exists there (pass --force to replace it)`); continue; }",
    '  }',
    '  copyFileSync(source, target);',
    '  const copiedDigest = sha256(target);',
    '  if (copiedDigest !== sourceDigest) { refused.push(`${target}: copy digest ${copiedDigest.slice(0, 12)}… does not match ${sourceDigest.slice(0, 12)}…`); continue; }',
    '  seeded.push({ name: basename(pack.path), path: target, sha256: copiedDigest, action: \'created\' });',
    '}',
    '',
    'if (refused.length > 0) {',
    '  for (const line of refused) process.stderr.write(`seed-rules: ${line}\\n`);',
    '  process.exit(1);',
    '}',
    'process.stdout.write(`${JSON.stringify({',
    "  schemaVersion: '1.0',",
    '  bundleRoot: BUNDLE_ROOT,',
    '  dataDir: root,',
    "  rulesDir: join(root, 'rules'),",
    '  seeded,',
    "}, null, 2)}\\n`);",
    '',
  ].join('\n');
  const path = join(out, 'launch', 'seed-rules.mjs');
  // `launch/` is created by the launcher, which is written after this file: the
  // seeder has to stand on its own rather than depend on that ordering.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, script);
  // A record of what was staged, so the seeder can verify the bundle's own bytes
  // without trusting the directory as it happens to be later.
  writeJson(join(out, 'manifests', 'rule-packs.json'), {
    schemaVersion: '1.0',
    author: AUTHOR,
    count: packs.length,
    packs: packs.map((pack) => ({ path: pack.path, sha256: pack.sha256, packId: pack.packId })),
    note: 'Written from the bytes the builder staged. launch/seed-rules.mjs re-hashes both sides before copying '
      + 'them into a data directory, because the daemon refuses a rule pack that lives outside it.',
  });
  return path;
}

/**
 * Emit the reference attempt preparer.
 *
 * Booting the profile makes the Cordis loader write `.cordis/resolve.mjs` into
 * its profile directory. If `DSH_HOME` pointed at the bundle, the first launch
 * would mutate the shipped bytes and invalidate `manifests/files.sha256`. The
 * broker is required to give every attempt its own `DSH_HOME` anyway, so the
 * bundle ships the reviewed profile as a template and this preparer materialises
 * one attempt-scoped copy. It is shipped code, not test-only code, so the
 * verification exercises the same path a real broker would.
 */
function writeAttemptPreparer({ out }) {
  const script = `#!/usr/bin/env node
// AegisHarness embedded runtime — attempt-scoped environment preparer (author PT-dove).
//
// usage: node prepare-attempt.mjs --root <absolute attempt root> [--broker-base-url <url>] [--broker-token <token>]
//
// Creates a disposable attempt tree, copies the reviewed profile into its own
// DSH_HOME, and prints the resulting environment as JSON. It never touches the
// bundle, never resolves anything through PATH, and never reaches the network.

import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundle root is discovered from this file's own location, never recorded.
// \`launch/\` is a sibling of \`runtime/\`, \`app/\` and \`dsh-home/\`, so the root is
// one level up. Hard-coding the build directory here is what used to make a copied
// bundle keep materialising attempts out of the directory it was built in.
const BUNDLE_ROOT = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PROFILE_TEMPLATE = join(BUNDLE_ROOT, 'dsh-home', 'profiles', 'aegis-analysis');
const PROFILE_FILES = ['package.json', 'profile.json', 'cordis.patch.yml', 'approved-hashes.json'];
// ADR-0005: the analysis cwd must live under the profile's neutral root, because
// the working-directory text reaches the model context and must not leak user
// paths. This default is a placeholder only; the broker supplies the real token.
const DEFAULT_BROKER_BASE_URL = 'http://127.0.0.1:9/anthropic';
const DEFAULT_BROKER_TOKEN = 'm8-poc-harmless-single-attempt-token';
const PROFILE_DIR = join(BUNDLE_ROOT, 'app', 'node_modules', 'plugins', 'dsh-defense-profile');
const NEUTRAL_ROOT = JSON.parse(readFileSync(join(PROFILE_DIR, 'profile.json'), 'utf8'))
  .effectiveConfig.analysisCwdRoots[process.platform];

function fail(message) {
  process.stderr.write(\`prepare-attempt: \${message}\\n\`);
  process.exit(1);
}

/**
 * The neutral root decides where an attempt may live, so it must be the reviewed
 * value: compare the bundled profile against the bundled whitelist before using
 * it. A tampered profile would otherwise widen the allowed attempt location.
 */
function assertProfileIsReviewed() {
  const approved = JSON.parse(readFileSync(join(PROFILE_DIR, 'approved-hashes.json'), 'utf8'));
  const record = approved.files['plugins/dsh-defense-profile/profile.json'];
  if (record === undefined) fail('approved-hashes.json does not cover profile.json');
  const actual = createHash('sha256').update(readFileSync(join(PROFILE_DIR, 'profile.json'))).digest('hex');
  if (actual !== record.sha256) fail('profile.json in this bundle does not match approved-hashes.json; refusing to trust its paths');
}

/** Canonical form of a path that may not exist yet. */
function canonicalize(path) {
  const absolute = resolve(path);
  const missing = [];
  let current = absolute;
  for (let guard = 0; guard < 256; guard += 1) {
    try {
      const canonical = realpathSync.native(current);
      return missing.length === 0 ? canonical : join(canonical, ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
  return absolute;
}

function fold(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** Containment on canonical paths, so links, short names and case cannot lie. */
function isInside(child, parent) {
  const left = fold(canonicalize(child));
  const right = fold(canonicalize(parent));
  if (left === right) return true;
  return left.startsWith(right.endsWith(sep) ? right : \`\${right}\${sep}\`);
}

const argv = process.argv.slice(2);
let root;
let brokerBaseURL = DEFAULT_BROKER_BASE_URL;
let brokerToken = DEFAULT_BROKER_TOKEN;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--root') root = argv[++index];
  else if (argv[index] === '--broker-base-url') brokerBaseURL = argv[++index];
  else if (argv[index] === '--broker-token') brokerToken = argv[++index];
  else fail(\`unknown argument: \${argv[index]}\`);
}
if (typeof root !== 'string' || root.length === 0) {
  root = join(NEUTRAL_ROOT, \`attempt-\${Date.now().toString(36)}-\${randomUUID().slice(0, 8)}\`);
}
assertProfileIsReviewed();
if (/^\\\\\\\\[?.]\\\\/.test(root)) fail('--root must not use an extended-length or device prefix');
if (!isAbsolute(root)) fail('--root must be absolute');
if (isInside(root, BUNDLE_ROOT)) fail('an attempt root must not be inside the bundle');
if (typeof NEUTRAL_ROOT !== 'string' || !isAbsolute(NEUTRAL_ROOT)) {
  fail('the profile must declare an absolute analysis cwd root for this platform');
}
// The neutral root is shared by every attempt, so it must not itself be a target:
// a drive root, a system directory, or the repository would all be unsafe parents.
if (canonicalize(NEUTRAL_ROOT) === canonicalize(dirname(canonicalize(NEUTRAL_ROOT)))) {
  fail(\`the declared analysis cwd root must not be a filesystem root: \${NEUTRAL_ROOT}\`);
}
for (const forbidden of [process.env.SystemRoot, process.env.ProgramFiles, process.env.USERPROFILE]) {
  if (typeof forbidden !== 'string' || forbidden.length === 0) continue;
  if (isInside(NEUTRAL_ROOT, forbidden) || isInside(forbidden, NEUTRAL_ROOT)) {
    fail(\`the declared analysis cwd root overlaps a protected system path (\${forbidden}): \${NEUTRAL_ROOT}\`);
  }
}
if (!isInside(root, NEUTRAL_ROOT) || canonicalize(root) === canonicalize(NEUTRAL_ROOT)) {
  fail(\`--root must be a subdirectory of the neutral analysis root \${NEUTRAL_ROOT}\`);
}
if (!existsSync(join(PROFILE_TEMPLATE, 'profile.json'))) fail(\`profile template missing at \${PROFILE_TEMPLATE}\`);
if (existsSync(root)) {
  mkdirSync(root, { recursive: true });
  const preexisting = readdirSync(root);
  if (preexisting.length > 0) {
    fail(\`attempt root must be empty; found \${preexisting.length} entr\${preexisting.length === 1 ? 'y' : 'ies'}: \${preexisting.slice(0, 5).join(', ')}\`);
  }
}

const home = join(root, 'home');
const tmp = join(root, 'tmp');
const cwd = join(root, 'cwd');
const session = join(root, 'session');
const dshHome = join(root, 'dsh-home');
const profileDir = join(dshHome, 'profiles', 'aegis-analysis');
const toolsDir = join(profileDir, 'node_modules', '@aegisharness', 'dsh-defense-tools');
for (const directory of [home, tmp, cwd, session, profileDir]) mkdirSync(directory, { recursive: true });
for (const filename of PROFILE_FILES) {
  cpSync(join(PROFILE_TEMPLATE, filename), join(profileDir, filename), { force: false, errorOnExist: true });
}
cpSync(join(PROFILE_TEMPLATE, 'node_modules', '@aegisharness', 'dsh-defense-tools'), toolsDir, {
  recursive: true,
  force: false,
  errorOnExist: true,
});

const env = {
  HOME: home,
  USERPROFILE: home,
  TMP: tmp,
  TEMP: tmp,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  AEGIS_ANALYSIS_CWD: cwd,
  AEGIS_SESSION_ROOT: session,
  AEGIS_BROKER_BASE_URL: brokerBaseURL,
  AEGIS_BROKER_TOKEN: brokerToken,
  AEGIS_RUNTIME_MANIFEST: join(session, 'runtime.json'),
  NO_COLOR: '1',
};
// Host facts the child cannot invent, but which are not attempt-scoped.
for (const name of ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'OS']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}

process.stdout.write(\`\${JSON.stringify({
  schemaVersion: '1.0',
  root,
  home,
  tmp,
  cwd,
  session,
  dshHome,
  profileDir,
  toolsDir,
  runtimeManifest: env.AEGIS_RUNTIME_MANIFEST,
  env,
}, null, 2)}\\n\`);
`;
  const path = join(out, 'launch', 'prepare-attempt.mjs');
  writeFileSync(path, script);
  return path;
}

/** Every file under `directory`, sorted, so staging order cannot vary by build. */
function listFilesSorted(directory) {
  const files = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`asset source contains a symlink: ${relative(REPO_ROOT, path)}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  if (existsSync(directory)) walk(directory);
  return files;
}

/**
 * Stage the loose assets a profile declares: the console front end and the rule
 * packs. Both are plain files, so they are copied one at a time in sorted order
 * and hashed afterwards; a directory-level copy would carry whatever the source
 * tree happened to hold that day.
 */
async function stageProfileAssets({ out, profile, consoleSource }) {
  const staged = { console: undefined, rules: undefined };

  const consoleSpec = profile.assets.console;
  if (consoleSpec !== undefined) {
    // A pinned source replaces the profile's preferred directory *and* counts as
    // the product tree: pinning exists to hold the bytes steady, not to swap the
    // console for something else.
    const declaredSource = consoleSpec.preferredSource;
    const preferredSource = consoleSource ?? declaredSource;
    const preferredFiles = preferredSource === undefined ? [] : listFilesSorted(preferredSource);
    let source = preferredSource;
    let origin = consoleSource === undefined ? 'workspace' : 'pinned-workspace';
    if (preferredFiles.length === 0) {
      // apps/console is the product console; when it holds nothing, the
      // packaging-owned shell is staged instead. This is recorded, never silent:
      // bundle.json says which one is inside and the bundle README repeats it.
      if (consoleSource !== undefined) {
        throw new Error(`--console-source ${consoleSource} is empty, so the pin would silently fall back to the `
          + 'packaging shell; refusing to pin a directory that holds no console');
      }
      source = consoleSpec.shellSource;
      origin = 'packaging-shell';
      if (source === undefined) {
        throw new Error('assets.console is empty and the profile declares no shellSource: refusing to ship a bundle with no console');
      }
    }
    const files = listFilesSorted(source);
    if (files.length === 0) throw new Error(`console source is empty: ${source}`);
    const entry = consoleSpec.requireEntry;
    if (entry !== undefined && !files.some((file) => relative(source, file).split(sep).join('/') === entry)) {
      throw new Error(`console source ${source} has no ${entry}; the staged page would 404`);
    }
    const targetDir = join(out, consoleSpec.target);
    mkdirSync(targetDir, { recursive: true });
    const copied = [];
    for (const file of files) {
      const relativePath = relative(source, file).split(sep).join('/');
      const target = join(targetDir, ...relativePath.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
      copied.push({ path: `${consoleSpec.target}/${relativePath}`, sha256: sha256File(target) });
    }
    // The product pages and the server that serves them are separate inputs. A
    // console directory with pages but no server is a directory an operator has to
    // guess how to open, and the launch plan already promised a server entry — so
    // either the fallback fills the hole or the build stops here.
    let serverFallback;
    const hasServer = copied.some((row) => row.path.endsWith('/serve.mjs'));
    if (!hasServer) {
      const fallback = consoleSpec.serverFallbackSource;
      if (fallback === undefined || !existsSync(fallback)) {
        throw new Error(`the staged console ${consoleSpec.target}/ has no serve.mjs and the profile declares no usable `
          + `serverFallback (${fallback ?? 'none'}), so launch/launch-plan.json would name a file that does not exist`);
      }
      const target = join(targetDir, 'serve.mjs');
      copyFileSync(fallback, target);
      serverFallback = {
        sourcePath: relative(REPO_ROOT, fallback).split(sep).join('/'),
        path: `${consoleSpec.target}/serve.mjs`,
        sha256: sha256File(target),
        note: 'Copied from the packaging shell because the console pages ship no server of their own. It serves only '
          + 'the files next to it, on loopback, and proxies /healthz, /readyz and /api/v1/* to the daemon.',
      };
      copied.push({ path: serverFallback.path, sha256: serverFallback.sha256 });
      copied.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    }
    staged.console = {
      target: consoleSpec.target,
      origin,
      sourcePath: consoleSource === undefined
        ? relative(REPO_ROOT, source).split(sep).join('/')
        : `<pinned>/${basename(source)}`,
      pinned: consoleSource !== undefined,
      pinnedPath: consoleSource === undefined ? undefined : relative(REPO_ROOT, consoleSource).split(sep).join('/'),
      declaredSourcePath: declaredSource === undefined ? undefined : relative(REPO_ROOT, declaredSource).split(sep).join('/'),
      preferredSourcePath: declaredSource === undefined
        ? undefined
        : relative(REPO_ROOT, declaredSource).split(sep).join('/'),
      preferredSourceFiles: preferredFiles.length,
      entry: entry === undefined ? undefined : `${consoleSpec.target}/${entry}`,
      server: copied.some((row) => row.path.endsWith('/serve.mjs')) ? `${consoleSpec.target}/serve.mjs` : undefined,
      serverFallback,
      isProductUi: origin === 'workspace' || origin === 'pinned-workspace',
      files: copied,
    };
  }

  const rulesSpec = profile.assets.rules;
  if (rulesSpec !== undefined) {
    if (rulesSpec.source === undefined) throw new Error('assets.rules needs a source directory');
    const suffix = (rulesSpec.requirePattern ?? '*.json').replace(/^\*/, '');
    const files = listFilesSorted(rulesSpec.source).filter((file) => file.endsWith(suffix));
    if (files.length === 0) throw new Error(`no rule pack matching ${rulesSpec.requirePattern ?? '*.json'} under ${relative(REPO_ROOT, rulesSpec.source)}`);
    // Validate with the repository's own detection package before shipping: a
    // pack the daemon will reject at startup must fail here, where the message
    // names the file, not on the target machine at 3am.
    const detectionEntry = join(REPO_ROOT, 'packages', 'detection', 'src', 'rule-pack.js');
    if (!existsSync(detectionEntry)) throw new Error(`rule validation needs ${relative(REPO_ROOT, detectionEntry)}`);
    const detection = await import(pathToFileURL(detectionEntry).href);
    const targetDir = join(out, rulesSpec.target);
    mkdirSync(targetDir, { recursive: true });
    const packs = [];
    for (const file of files) {
      const relativePath = relative(rulesSpec.source, file).split(sep).join('/');
      const target = join(targetDir, ...relativePath.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
      let validated;
      try {
        validated = detection.loadRulePack(target);
      } catch (error) {
        throw new Error(`rule pack ${relative(REPO_ROOT, file)} does not validate (${error.code ?? 'error'}): ${error.message}`);
      }
      packs.push({
        path: `${rulesSpec.target}/${relativePath}`,
        sha256: sha256File(target),
        packId: validated.packId,
        packVersion: validated.packVersion,
        schemaVersion: validated.schemaVersion,
        rules: validated.rules.length,
        ruleIds: validated.rules.map((rule) => rule.ruleId).sort(),
      });
    }
    staged.rules = {
      target: rulesSpec.target,
      sourcePath: relative(REPO_ROOT, rulesSpec.source).split(sep).join('/'),
      packs,
    };
  }

  // Single-file assets. A tray executable is one file, so a profile that ships it
  // names a file, not a directory: unpacking it into a directory would invent a
  // layout nobody asked for. Staging it here — before the launcher and before
  // `manifests/files.sha256` — is what puts those exact bytes under the manifest's
  // coverage, which is the only thing that makes "the shell is in the payload"
  // checkable after the fact.
  //
  // Fails closed on every input that would otherwise ship a bundle whose entry point
  // is missing or empty: the installer's whole job is to refuse such a payload, and
  // finding out at build time is cheaper than finding out at install time.
  const DIRECTORY_ASSETS = new Set(['console', 'rules']);
  const fileAssets = {};
  for (const [kind, spec] of Object.entries(profile.assets)) {
    if (DIRECTORY_ASSETS.has(kind)) continue;
    if (spec.source === undefined) {
      throw new Error(`assets.${kind} needs "source": a single-file asset cannot be staged from a preferred/shell source`);
    }
    if (!existsSync(spec.source) || !statSync(spec.source).isFile()) {
      throw new Error(`assets.${kind}.source is not a file: ${relative(REPO_ROOT, spec.source)}`);
    }
    const declaredBytes = statSync(spec.source).size;
    if (declaredBytes === 0) throw new Error(`assets.${kind}.source is empty: ${relative(REPO_ROOT, spec.source)}`);
    const targetPath = join(out, ...spec.target.split('/'));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(spec.source, targetPath);
    const stagedBytes = statSync(targetPath).size;
    if (stagedBytes !== declaredBytes) {
      throw new Error(`assets.${kind}: staged ${spec.target} is ${stagedBytes} bytes, the source is ${declaredBytes}`);
    }
    fileAssets[kind] = {
      target: spec.target,
      sourcePath: relative(REPO_ROOT, spec.source).split(sep).join('/'),
      bytes: stagedBytes,
      sha256: sha256File(targetPath),
    };
  }
  staged.files = fileAssets;

  return staged;
}

/**
 * Write the `apps/<name>/bin.js` forwarders a profile asks for.
 *
 * A forwarder exists because the install tree is `app/node_modules` (the layout
 * v13 shipped and every existing test asserts), while an operator reasonably
 * types `node <bundle>/apps/daemon/bin.js`. The forwarder is four lines and
 * resolves nothing itself: the real module's own location decides where its bare
 * specifiers resolve, so this adds a path, not a second copy.
 */
function stageEntryForwarders({ out, profile }) {
  const rows = [];
  for (const forwarder of profile.entryForwarders) {
    const packageDir = join(out, 'app', 'node_modules', ...forwarder.package.split('/'));
    if (!existsSync(packageDir)) {
      throw new Error(`entry forwarder for ${forwarder.package} has no staged package at ${relative(out, packageDir).split(sep).join('/')}`);
    }
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
    if (typeof bin !== 'string') throw new Error(`${forwarder.package} declares no bin entry to forward to`);
    const realEntry = join(packageDir, bin);
    if (!existsSync(realEntry)) throw new Error(`${forwarder.package} bin ${bin} is missing from the staged package`);
    const targetDir = join(out, ...forwarder.target.split('/'));
    mkdirSync(targetDir, { recursive: true });
    const forwarderPath = join(targetDir, 'bin.js');
    const specifier = relative(targetDir, realEntry).split(sep).join('/').replace(/^([^.]|$)/, './$1');
    writeFileSync(forwarderPath, [
      '#!/usr/bin/env node',
      `// Entry forwarder for ${forwarder.package} (author ${AUTHOR}).`,
      '//',
      '// The install tree is app/node_modules; this file re-enters the packaged module',
      '// so that <bundle>/apps/<name>/bin.js works as typed. It resolves no dependency',
      '// itself: the real entry\'s location decides that.',
      '//',
      '// rc.4 fix: a bare `import` was a silent no-op for a package whose entry guards',
      '// its main with `import.meta.url === pathToFileURL(process.argv[1])` - the daemon',
      '// does. The desktop shell runs `node <bundle>/apps/daemon/bin.js --config ...`, so',
      '// the guard saw the forwarder\'s path, skipped main(), and the daemon exited 0 at',
      '// once; the shell then reported DAEMON_OFFLINE and /healthz answered 503. Point',
      '// argv[1] at the real entry before importing it, and main() runs in this process',
      '// (no second copy of the package, no extra node).',
      "import { fileURLToPath } from 'node:url';",
      `const realEntry = fileURLToPath(new URL(${JSON.stringify(specifier)}, import.meta.url));`,
      'process.argv[1] = realEntry;',
      `await import(${JSON.stringify(specifier)});`,
      '',
    ].join('\n'));
    rows.push({
      path: relative(out, forwarderPath).split(sep).join('/'),
      package: forwarder.package,
      target: relative(out, realEntry).split(sep).join('/'),
      sha256: sha256File(forwarderPath),
    });
  }
  return rows;
}

function buildLauncher({ out, nodeVersion, profile, assets }) {
  const bundleRoot = out;
  const nodeExe = join(bundleRoot, 'runtime', 'node', 'node.exe');
  const workerEntry = join(
    bundleRoot, 'app', 'node_modules', '@aegisharness', 'harness-worker', 'bin.js',
  );
  const dshHome = join(bundleRoot, 'dsh-home');
  const launchDir = join(bundleRoot, 'launch');
  mkdirSync(launchDir, { recursive: true });
  /** Shipped path: relative to the bundle root, forward slashes, never absolute. */
  const shipped = (target, label) => portableRelative(bundleRoot, target, label);

  /**
   * What this payload deliberately does not do.
   *
   * A profile may state it, and v15 does: the daemon-console default still says
   * "no formal installer / updater", which stopped being true the moment rc.3
   * shipped a double-click installer. A non-goal list that describes an older
   * payload is worse than none — it reads as a claim about this one.
   */
  const defaultNonGoals = [
    'code signing',
    'formal installer / uninstaller',
    'updater',
    'four-OS packaging',
    'model weights',
    ...(profile.launchers.includes('daemon')
      ? ['broker / sandbox-launcher integration', 'service registration (apps/service-host is not in this payload)']
      : ['daemon / broker / sandbox integration']),
  ];
  const declaredNonGoals = profile.document?.nonGoals;
  const nonGoals = Array.isArray(declaredNonGoals) && declaredNonGoals.length > 0
    ? declaredNonGoals
    : defaultNonGoals;

  const plan = {
    schemaVersion: '1.1',
    author: AUTHOR,
    kind: 'packaging-poc',
    platform: 'win32-x64',
    // Every path below is relative to the bundle root. Recording the directory
    // the bundle was assembled in would make the very first copy or rename fatal:
    // the launcher would keep pointing at the build machine. The root is instead
    // discovered at launch — the stub does it with `%~dp0..`, and the preparer
    // with its own `import.meta.url` — and every stored path is joined onto it.
    pathConvention: {
      kind: 'bundle-relative',
      root: 'the directory containing launch/, runtime/, app/, dsh-home/ and manifests/',
      separator: 'forward slash in this file; convert with path.join() on the host',
      resolve: 'join(dirname(<this file>), "..") — never stored, always derived at launch',
      example: 'join(bundleRoot, plan.node.executable)',
      rationale: 'A bundle that stores its build directory cannot be relocated, and relocation is what a '
        + 'distributable has to survive. Absolute paths exist only inside a running process.',
    },
    bundleRoot: '.',
    node: {
      executable: shipped(nodeExe, 'node.executable'),
      version: nodeVersion,
      note: 'Bundled runtime, resolved from the bundle root. Never resolved through PATH, npx or npm.',
    },
    worker: {
      entry: shipped(workerEntry, 'worker.entry'),
      argv: ['--profile', 'aegis-analysis'],
      note: 'argv must match exactly; the worker preflight rejects overlays and plugin commands.',
    },
    ...(profile.launchers.includes('daemon') ? {
      daemon: {
        entry: shipped(join(bundleRoot, 'apps', 'daemon', 'bin.js'), 'daemon.entry'),
        packageEntry: shipped(join(bundleRoot, 'app', 'node_modules', '@aegisharness', 'daemon', 'bin.js'), 'daemon.packageEntry'),
        // `--rules` points *inside the data directory*, not at the bundle's own
        // rules/: the daemon validates that path with resolveInside(dataDir, …) and
        // refuses anything else, so the bundle's copy has to be seeded first. The
        // launcher runs launch/seed-rules.mjs, which is what makes this argv true.
        argv: [
          '--data-dir', '<absolute data dir>',
          '--rules', '<absolute data dir>/rules/defense-seed-pack.json',
          '--mock',
        ],
        seeder: shipped(join(bundleRoot, 'launch', 'seed-rules.mjs'), 'daemon.seeder'),
        builtInRulePack: shipped(join(bundleRoot, 'rules', 'defense-seed-pack.json'), 'daemon.builtInRulePack'),
        listen: '<loopback only, chosen by the configuration>',
        note: 'The entry is a forwarder into app/node_modules; the package itself is staged once. '
          + '--rules has no implicit default: a daemon with no rules would report healthy while detecting nothing. '
          + 'Passing the bundle\'s rules/ path directly is rejected by config validation — run the seeder first, '
          + 'which is exactly what launch/aegis-daemon.cmd does.',
      },
    } : {}),
    ...(profile.assets.console === undefined ? {} : {
      console: {
        entry: assets.console.entry,
        // Only named when the staged directory actually holds it: the plan is a
        // promise about files, and a `server` key pointing at nothing was exactly
        // the shape of the v14 defect this profile now prevents.
        ...(assets.console.server === undefined ? {} : { server: assets.console.server }),
        argv: ['--daemon', '<http://127.0.0.1:<daemon port>>', '--port', '0'],
        note: 'The shell serves the static page on loopback and proxies /healthz and /api/v1/* to the daemon, '
          + 'injecting the token server-side. It never opens a browser and never polls by itself.',
      },
    }),
    ...(assets.files?.desktop === undefined ? {} : {
      desktop: {
        executable: assets.files.desktop.target,
        sha256: assets.files.desktop.sha256,
        argv: ['--port', '<local UI port>'],
        note: 'The tray shell. It resolves its install root from its own location, so the executable is at the '
          + 'bundle root and finds apps/daemon/bin.js, runtime/node/node.exe and console/ beside it. Started with '
          + 'no arguments it opens its window and parks in the tray; a second start exits 0 after waking the first.',
      },
    }),
    profile: {
      templateDir: shipped(join(dshHome, 'profiles', 'aegis-analysis'), 'profile.templateDir'),
      templateToolsDir: shipped(
        join(dshHome, 'profiles', 'aegis-analysis', 'node_modules', '@aegisharness', 'dsh-defense-tools'),
        'profile.templateToolsDir',
      ),
      sourceMirror: shipped(
        join(bundleRoot, 'app', 'node_modules', 'plugins', 'dsh-defense-profile'),
        'profile.sourceMirror',
      ),
      preparer: shipped(join(bundleRoot, 'launch', 'prepare-attempt.mjs'), 'profile.preparer'),
      dshHomePolicy: 'attempt-scoped',
      note: 'DSH_HOME must be an absolute per-attempt directory. The Cordis loader writes .cordis/* into the '
        + 'profile directory, so pointing DSH_HOME at the bundle would mutate the shipped bytes and invalidate '
        + 'manifests/files.sha256. Materialise one attempt with launch/prepare-attempt.mjs --root <absolute dir>.',
    },
    environment: {
      required: {
        HOME: '<absolute per-attempt home>',
        USERPROFILE: '<must equal HOME on win32>',
        TMP: '<absolute per-attempt temp>',
        TEMP: '<absolute per-attempt temp>',
        DSH_HOME: '<absolute per-attempt dir from launch/prepare-attempt.mjs>',
        DSH_TELEMETRY_DISABLED: '1',
        AEGIS_ANALYSIS_CWD: '<absolute per-attempt cwd; must equal process cwd>',
        AEGIS_SESSION_ROOT: '<absolute per-attempt session root>',
        AEGIS_BROKER_BASE_URL: '<http://127.0.0.1:<port>>',
        AEGIS_BROKER_TOKEN: '<single-attempt broker token>',
        AEGIS_RUNTIME_MANIFEST: '<absolute path inside AEGIS_SESSION_ROOT>',
      },
      passthrough: ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'],
      cleared: [
        'NODE_OPTIONS',
        'NODE_PATH',
        'NODE_EXTRA_CA_CERTS',
        'NODE_TLS_REJECT_UNAUTHORIZED',
        'NODE_V8_COVERAGE',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'npm_config_registry',
      ],
      note: 'Clearing NODE_OPTIONS means the shipped .cmd cannot be instrumented from outside; '
        + 'the zero-egress claim is established on the direct-spawn path, not through the stub. '
        + 'PATH is passed through for the harness shell only; the launcher never uses it to locate Node.',
    },
    network: {
      policy: 'no-egress',
      brokerHostAllowlist: ['127.0.0.1', '::1'],
      note: 'Only the loopback broker endpoint is permitted. The bundle performs no runtime download.',
    },
    nonGoals,
  };
  writeJson(join(launchDir, 'launch-plan.json'), plan);

  const stub = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'rem AegisHarness embedded runtime launcher (M8 packaging PoC, author PT-dove).',
    'rem Every path is derived from this file\'s own location, so a copied or renamed bundle',
    'rem still launches itself. No PATH lookup, no npx, no npm, no runtime download.',
    'rem Attempt-scoped environment (HOME/TMP/AEGIS_*) must be supplied by the caller.',
    'for %%I in ("%~dp0..") do set "AEGIS_BUNDLE_ROOT=%%~fI"',
    'if not defined AEGIS_BUNDLE_ROOT ( echo aegis-harness-worker: cannot resolve bundle root 1>&2 & exit /b 92 )',
    'set "NODE_EXE=%AEGIS_BUNDLE_ROOT%\\runtime\\node\\node.exe"',
    'set "WORKER_ENTRY=%AEGIS_BUNDLE_ROOT%\\app\\node_modules\\@aegisharness\\harness-worker\\bin.js"',
    'set "NODE_OPTIONS="',
    'set "NODE_PATH="',
    'set "NODE_EXTRA_CA_CERTS="',
    'set "NODE_TLS_REJECT_UNAUTHORIZED="',
    'set "NODE_V8_COVERAGE="',
    'set "HTTP_PROXY="',
    'set "HTTPS_PROXY="',
    'set "ALL_PROXY="',
    'set "npm_config_registry="',
    'if not exist "%NODE_EXE%" ( echo aegis-harness-worker: bundled runtime missing 1>&2 & exit /b 90 )',
    'if not exist "%WORKER_ENTRY%" ( echo aegis-harness-worker: worker entry missing 1>&2 & exit /b 91 )',
    '"%NODE_EXE%" "%WORKER_ENTRY%" --profile aegis-analysis',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  writeFileSync(join(launchDir, 'aegis-harness-worker.cmd'), stub);

  const stubs = [join(launchDir, 'aegis-harness-worker.cmd')];
  const common = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'for %%I in ("%~dp0..") do set "AEGIS_BUNDLE_ROOT=%%~fI"',
    'set "NODE_EXE=%AEGIS_BUNDLE_ROOT%\\runtime\\node\\node.exe"',
    'set "NODE_OPTIONS="',
    'set "NODE_PATH="',
    'set "NODE_EXTRA_CA_CERTS="',
    'set "NODE_TLS_REJECT_UNAUTHORIZED="',
    'set "NODE_V8_COVERAGE="',
    'set "HTTP_PROXY="',
    'set "HTTPS_PROXY="',
    'set "ALL_PROXY="',
    'set "npm_config_registry="',
    'if not exist "%NODE_EXE%" ( echo aegis: bundled runtime missing 1>&2 & exit /b 90 )',
  ];

  if (profile.launchers.includes('daemon')) {
    const daemonStub = [
      ...common,
      'rem AegisHarness daemon launcher (author PT-dove). Paths derive from this file; no PATH lookup.',
      'rem The daemon confines its rule pack to the data directory, so this launcher seeds the',
      'rem built-in pack into <data-dir>\\rules\\ first and then starts the daemon against it.',
      'set "DAEMON_ENTRY=%AEGIS_BUNDLE_ROOT%\\apps\\daemon\\bin.js"',
      'set "RULES_FILE=%AEGIS_BUNDLE_ROOT%\\rules\\defense-seed-pack.json"',
      'set "SEEDER=%AEGIS_BUNDLE_ROOT%\\launch\\seed-rules.mjs"',
      'if not exist "%DAEMON_ENTRY%" ( echo aegis-daemon: entry missing 1>&2 & exit /b 91 )',
      'if not exist "%RULES_FILE%" ( echo aegis-daemon: rule pack missing 1>&2 & exit /b 93 )',
      'if /i not "%~1"=="--data-dir" ( echo usage: aegis-daemon.cmd --data-dir ^<absolute dir^> [--mock] 1>&2 & exit /b 2 )',
      'set "AEGIS_DATA_DIR=%~2"',
      'if "%AEGIS_DATA_DIR%"=="" ( echo usage: aegis-daemon.cmd --data-dir ^<absolute dir^> [--mock] 1>&2 & exit /b 2 )',
      '"%NODE_EXE%" "%SEEDER%" --data-dir "%AEGIS_DATA_DIR%"',
      'if errorlevel 1 ( echo aegis-daemon: rule pack could not be seeded into the data directory 1>&2 & exit /b 95 )',
      'set "AEGIS_MODE="',
      'if /i "%~3"=="--mock" set "AEGIS_MODE=--mock"',
      '"%NODE_EXE%" "%DAEMON_ENTRY%" --data-dir "%AEGIS_DATA_DIR%" --rules "%AEGIS_DATA_DIR%\\rules\\defense-seed-pack.json" %AEGIS_MODE%',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
    const path = join(launchDir, 'aegis-daemon.cmd');
    writeFileSync(path, daemonStub);
    stubs.push(path);
  }

  if (profile.assets.console !== undefined) {
    const consoleServer = assets.console.server;
    if (consoleServer === undefined) {
      throw new Error('the profile stages a console but no server, so there is nothing for a console launcher to run');
    }
    const consoleStub = [
      ...common,
      'rem AegisHarness console shell launcher (author PT-dove). Loopback only; prints a URL, opens nothing.',
      `set "CONSOLE_SERVER=%AEGIS_BUNDLE_ROOT%\\${consoleServer.split('/').join('\\\\')}"`,
      'if not exist "%CONSOLE_SERVER%" ( echo aegis-console: shell missing 1>&2 & exit /b 94 )',
      'if not defined AEGIS_DAEMON_URL set "AEGIS_DAEMON_URL=http://127.0.0.1:7345"',
      '"%NODE_EXE%" "%CONSOLE_SERVER%" --daemon "%AEGIS_DAEMON_URL%" %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
    const path = join(launchDir, 'aegis-console.cmd');
    writeFileSync(path, consoleStub);
    stubs.push(path);
  }

  return { plan, stubPath: stubs[0], stubs };
}

function writeBundleReadme({
  out, nodeVersion, counts, uniquePackages, sizeBytes, pruned, prunedMiB, licenseGaps, nodeLicenseAttested,
  profile, assets, forwarders,
}) {
  const text = `# AegisHarness 内置运行时 bundle（${profile.name}，M8 打包 PoC）

- 作者：${AUTHOR}
- 组合 profile：\`${profile.recordPath}\`（sha256 \`${profile.sha256}\`）
- 平台：Windows x64 单目录自包含
- 内置 Node：${nodeVersion}
- 包数量：${counts} 个安装副本 / ${uniquePackages} 个唯一包名
  （从 lockfile 生产闭包中裁剪掉 ${pruned} 个本 profile 不会加载的包名，约 ${prunedMiB} MiB）
- 目录体积：约 ${(sizeBytes / 1048576).toFixed(1)} MiB（在写入 manifests/files.sha256 之前测量）

## 这是什么

一个**验证用**目录，用来证明目标机不安装 Node、不安装 dsh、无外网时，
payload 仍能启动。

启动方式见 \`launch/launch-plan.json\`；\`launch/aegis-harness-worker.cmd\` 是 worker 存根${
  profile.launchers.includes('daemon') ? '，`launch/aegis-daemon.cmd` 起守护进程，`launch/aegis-console.cmd` 起控制台壳' : ''
}。

${profile.launchers.includes('daemon') ? `## 本载荷新增的两个部件（相对 v13）

- **服务端**：\`apps/daemon/bin.js\`（转发入口）→ \`app/node_modules/@aegisharness/daemon/bin.js\`。
  安装之后不再只有 stdio worker，而是有可启动的守护进程。
- **界面**：\`${assets.console?.entry ?? 'console/index.html'}\`。来源为
  \`${assets.console?.sourcePath ?? '未声明'}\`（\`${assets.console?.origin ?? 'n/a'}\`）${
    assets.console?.isProductUi === false
      ? '。**这不是产品控制台实现，而是打包层提供的最小静态壳**：`apps/console` 在写这个 profile 时是空目录，'
        + '壳放在 `deploy/embedded-runtime/console-shell/`，一旦 `apps/console` 有内容就会自动改用它'
      : ''
  }。
- **内置规则包**：\`${assets.rules?.target ?? 'rules'}/\` 下 ${assets.rules?.packs.length ?? 0} 个包，构建期用仓库自带的
  detection 包逐个校验通过（packId / packVersion / 规则条数见 \`bundle.json.rules\`）。
- **转发入口**：${forwarders.length === 0 ? '无' : forwarders.map((row) => `\`${row.path}\` → \`${row.target}\``).join('、')}。${
  assets.files?.desktop === undefined ? '' : `
- **桌面壳**：\`${assets.files.desktop.target}\`（${(assets.files.desktop.bytes / 1048576).toFixed(1)} MiB，
  sha256 \`${assets.files.desktop.sha256}\`）。来源 \`${assets.files.desktop.sourcePath}\`。
  它放在 bundle 根而不是 \`app/\`：桌面壳用**自身所在目录**当安装根，再去那里找
  \`apps/daemon/bin.js\`、\`runtime/node/node.exe\` 与 \`console/\`；放进 \`app/\` 也能起，
  但 daemon 会以 \`DAEMON_OFFLINE\` 报找不到入口。`
}

` : ''}
## 可搬迁性

本目录**不含任何构建机的绝对路径**：\`launch-plan.json\` 里存的是相对 bundle 根的路径，
\`.cmd\` 存根用 \`%~dp0..\` 现场推导 bundle 根，\`prepare-attempt.mjs\` 用自身
\`import.meta.url\` 推导。因此整个目录可以**直接复制或改名到任意路径**（包括换盘符、
带空格或中文的目录）后照常启动，不需要重建，也不会回指原来的构建目录。

注意这只覆盖"路径不再写死"这一件事，不等于安装器/升级器；移动后
\`manifests/files.sha256\` 仍然逐文件校验，改过的字节依旧会被发现。

## 依赖裁剪

每个被删掉的包都在 \`manifests/trim-report.json\` 里有证据：它不在从
profile 实际挂载的插件出发的模块图里、没有被任何可达文件以字符串形式引用、
也不是任何可达包的可选平台变体。想还原全部依赖，用 \`--no-prune\` 重新构建
（并换一个 \`--out\`，否则这个目录名会名不副实）。

## 这**不是**什么（明确不包含）

- 不是正式安装包：没有安装器、卸载器、注册表项、开始菜单项、服务注册。
- 没有代码签名，也没有信任根、签名者校验或撤销检查。
- 没有升级器，没有增量更新与回滚。
- 只有 Windows x64 一种形态，没有四 OS 打包。
- 没有模型权重、没有真实 API Key、没有任何凭据。
- ${profile.launchers.includes('daemon')
    ? '没有 broker、sandbox-launcher 与服务注册（`apps/service-host` 不在本载荷内）；daemon 只能以内联方式起，'
      + '企图的采集源需由宿主注入。控制台是打包层最小壳，不是产品 UI。'
    : '没有 daemon、broker、sandbox-launcher、UI；worker 只能启动到 stdio 阶段。'}
  模型请求会因缺少真实 broker 而失败，这是预期行为。

## 完整性

\`manifests/files.sha256\` 覆盖除 \`manifests/\` 自身以外的所有文件。
\`manifests/third-party-packages.json\` 与 \`manifests/THIRD-PARTY-NOTICES.txt\`
给出每个 npm 包的 SPDX 标识，全文在 \`manifests/licenses/\`。

校验和只用于完整性，不建立信任。

## 许可状态（不得当作合规声明）

- 内置 Node 的许可文本${nodeLicenseAttested ? '已按版本溯源（attested）' : '**尚未与捆绑版本建立可验证溯源**'}，见
  \`runtime/node/runtime.json\` 的 \`licenseProvenance\`。
- ${licenseGaps} 个包上游未随包提供许可全文，清单在 \`manifests/license-gaps.json\`，
  状态为 open；在这些条目清零前，这个 bundle **不能**被称为许可完备。

## 可删除说明

整个目录是一次性 PoC 产物，删除它不影响仓库、不影响已安装依赖。
重跑 \`node deploy/embedded-runtime/build.mjs --force\` 可重建。
`;
  writeFileSync(join(out, 'README-BUNDLE.md'), text);
}

/**
 * Every spelling of a build-host path that must never appear in a shipped file.
 *
 * The three spellings matter because the same path is written three ways: natively
 * (`D:\x`), forward-slashed in most config formats (`D:/x`), and backslash-escaped
 * inside JSON (`D:\\x`). A guard that only knew one of them would pass a bundle
 * whose `launch-plan.json` leaks the build directory.
 *
 * A filesystem root is skipped: banning `D:\` would match unrelated text in every
 * third-party package and turn the gate into noise. Short needles are skipped for
 * the same reason.
 */
function hostPathNeedles(out) {
  const candidates = [
    ['repository', REPO_ROOT],
    ['repository parent', dirname(REPO_ROOT)],
    ['bundle output', out],
    ['bundle output parent', dirname(out)],
    ['build user profile', process.env.USERPROFILE],
  ];
  const seen = new Set();
  const needles = [];
  for (const [label, value] of candidates) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const absolute = resolve(value);
    if (dirname(absolute) === absolute) continue;
    const spellings = [absolute, absolute.split(sep).join('/'), absolute.split(sep).join('\\\\')];
    // Case-folded duplicates are added too: some tools normalise a drive letter to
    // lower case, and a case-sensitive gate would wave that straight through.
    for (const spelling of [...spellings, ...spellings.map((item) => item.toLowerCase())]) {
      if (spelling.length < 6 || seen.has(spelling)) continue;
      seen.add(spelling);
      needles.push({ label, spelling, bytes: Buffer.from(spelling, 'utf8') });
    }
  }
  return needles;
}

/**
 * Refuse to ship any path that names the machine that assembled the bundle.
 *
 * The families checked are the repository, the directory the repository sits in
 * (that is where the scratch build tree lives), the output directory itself, and
 * the build user's profile. The output directory is the one that used to slip
 * through: every launch artifact recorded it, so a copy kept launching from the
 * original location and looked portable while being nothing of the sort.
 *
 * Every file type is scanned, not just text extensions: `.map`, `.node`, `.dll`,
 * `.exe` and extensionless files are where a leaked path would otherwise hide.
 * Files above the cap are skipped and counted, so the gap is visible rather than
 * silent.
 */
function assertNoRepositoryPathLeak(out) {
  const needles = hostPathNeedles(out);
  const offenders = [];
  let skipped = 0;
  const cap = 256 * 1024 * 1024;
  // `manifests/` is scanned too: it is generated from the same inputs and can
  // carry a path just as easily. It contains no `files.sha256` yet at this point
  // (that manifest is written last), so there is no self-reference to exclude.
  for (const path of listBundleFiles(out)) {
    const full = join(out, path);
    if (statSync(full).size > cap) {
      skipped += 1;
      continue;
    }
    const bytes = readFileSync(full);
    for (const needle of needles) {
      if (bytes.includes(needle.bytes)) offenders.push(`${path} (${needle.label}: ${needle.spelling})`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`bundle leaks a build-host absolute path, so it could not be relocated: ${offenders.slice(0, 5).join(', ')}`);
  }
  if (skipped > 0) {
    throw new Error(`leak scan skipped ${skipped} file(s) above ${cap} bytes; the guarantee must cover the whole bundle`);
  }
  return { scanned: listBundleFiles(out).length - skipped, skipped, needles: needles.length };
}

/**
 * Every plugin the reviewed profile mounts must exist in the staged closure.
 *
 * The closure is seeded from four packages, so a plugin added to
 * `cordis.patch.yml` that lives only in a devDependency chain would be missing
 * from the bundle and would only fail at boot. Checking the yml against the
 * closure turns that into a build error that names the plugin.
 */
function verifyPatchPluginNames({ patchPath, nodes }) {
  const names = new Set([...nodes.values()].map((node) => node.name));
  const declared = readFileSync(patchPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1])
    // Relative/absolute paths are local plugin files, not registry packages.
    .filter((name) => !name.startsWith('.') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name));
  const missing = declared.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`cordis.patch.yml mounts plugins that the staged closure does not contain: ${missing.join(', ')}`);
  }
  return declared;
}

/**
 * Re-check every reviewed digest against every copy that will ship.
 *
 * The profile preflight only hashes two locations at run time; the bundle holds
 * more copies of the same package (installation scope, `plugins/*` mirror,
 * template). If they disagree, the worker verifies one and executes another.
 */
function auditApprovedCopies({ out, approved, profileSource, toolsSource }) {
  const copies = [];
  for (const [source, record] of Object.entries(approved.files)) {
    const relativePath = source.startsWith('plugins/dsh-defense-profile/')
      ? { packageName: '@aegisharness/dsh-defense-profile', rest: source.slice('plugins/dsh-defense-profile/'.length) }
      : { packageName: '@aegisharness/dsh-defense-tools', rest: source.slice('plugins/dsh-defense-tools/'.length) };
    const candidates = [
      join(out, 'app', 'node_modules', relativePath.packageName, relativePath.rest),
      join(out, 'app', 'node_modules', 'plugins', relativePath.packageName.replace('@aegisharness/', ''), relativePath.rest),
      relativePath.packageName === '@aegisharness/dsh-defense-tools'
        ? join(out, 'dsh-home', 'profiles', 'aegis-analysis', 'node_modules', '@aegisharness', 'dsh-defense-tools', relativePath.rest)
        : join(out, 'dsh-home', 'profiles', 'aegis-analysis', relativePath.rest),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      copies.push({ source, candidate, expected: record.sha256, actual: sha256File(candidate) });
    }
    // The frozen/working input itself must match too, otherwise the "reviewed"
    // label would be applied to bytes nobody reviewed.
    const origin = source.startsWith('plugins/dsh-defense-profile/')
      ? join(profileSource, relativePath.rest)
      : join(toolsSource, relativePath.rest);
    copies.push({ source, candidate: origin, expected: record.sha256, actual: sha256File(origin) });
  }
  const drifted = copies.filter((row) => row.expected !== row.actual);
  if (drifted.length > 0) {
    throw new Error(`approved bytes are not what the bundle ships:\n  ${
      drifted.slice(0, 10).map((row) => `${row.source} at ${row.candidate}: ${row.actual.slice(0, 12)}… != ${row.expected.slice(0, 12)}…`).join('\n  ')
    }`);
  }
  return copies.length;
}

/**
 * Re-derive the evidence behind a reviewed prune list and refuse anything the
 * gate cannot clear.
 *
 * The list is an *input*, never an authority: every build recomputes the module
 * graph, the string-reference corpus and the platform-variant closure, so a list
 * that survived review last week still has to prove itself against today's tree.
 * That is what makes "prune a used package" fail loudly instead of producing a
 * bundle that cannot boot.
 */
function resolvePrunePlan({ options, nodes, profile, repoRoot, closureRoots }) {
  const protectedNames = new Set(closureRoots);
  for (const packageName of Object.values(profile.pluginPackages ?? {})) protectedNames.add(packageName);
  for (const node of nodes.values()) {
    if (isInside(node.sourceDir, join(repoRoot, 'plugins'))) protectedNames.add(node.name);
  }

  if (options.prune === undefined) {
    return { pruned: new Set(), entries: [], gate: { mode: 'unpruned' }, pruneList: undefined };
  }
  if (!existsSync(options.prune)) throw new Error(`prune list not found: ${options.prune}`);
  const document = JSON.parse(readFileSync(options.prune, 'utf8'));
  const listed = Array.isArray(document) ? document : document.packages;
  if (!Array.isArray(listed)) throw new Error(`${options.prune}: expected an array of entries or { packages: [...] }`);
  const names = new Set();
  for (const entry of listed) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || name.length === 0) throw new Error(`${options.prune}: an entry has no package name`);
    names.add(name);
  }

  const usage = analyzeUsage({ repoRoot, nodes, profile, closureRoots });
  const corpus = loadReachedCorpus({ usage, repoRoot });
  const dependentsIndex = buildDependentsIndex({ nodes });

  const failures = [];
  const entries = [];
  for (const name of [...names].sort()) {
    const evaluation = evaluateCandidate({
      candidate: { name }, usage, nodes, corpus, protectedNames,
      declaredBy: dependentsIndex.get(name) ?? [],
    });
    const copies = [...nodes.values()].filter((node) => node.name === name);
    if (copies.length === 0) {
      failures.push(`${name}: not in the production closure (nothing to prune, so the list is stale)`);
      continue;
    }
    if (!evaluation.allowed) {
      failures.push(`${name}: ${evaluation.blockers.join('; ')}`);
      continue;
    }
    for (const copy of copies) {
      entries.push({
        name,
        version: copy.version,
        license: copy.license,
        lockfileKey: copy.key,
        sizeBytes: packageSize(copy.sourceDir),
        declaredBy: dependentsIndex.get(name) ?? [],
        evidence: evaluation.evidence,
      });
    }
  }
  if (failures.length > 0) {
    throw new Error(`the prune list cannot be justified, refusing to build (${failures.length} of ${names.size} entries):\n  ${
      failures.slice(0, 20).join('\n  ')
    }`);
  }
  return {
    pruned: names,
    entries,
    // Never record an absolute path: the bundle must not carry the build tree's
    // location, and the leak scan refuses to ship one.
    pruneList: {
      path: isInside(options.prune, repoRoot)
        ? relative(repoRoot, options.prune).split(sep).join('/')
        : `<external>/${relative(dirname(options.prune), options.prune)}`,
      sha256: sha256File(options.prune),
      entries: names.size,
    },
    gate: {
      mode: 'reviewed-prune-list',
      closurePackages: nodes.size,
      moduleGraphReachable: usage.reachableNames.size,
      reachedFiles: usage.reachedFiles.size,
      corpusFiles: corpus.entries.length,
      corpusSkipped: corpus.skipped.length,
      dynamicSpecifierSites: usage.dynamicSites.length,
      unresolvedEdges: usage.unresolved.length,
      protectedPackages: protectedNames.size,
    },
  };
}

/** Bytes of one installed package, excluding nested `node_modules`. */
function packageSize(directory) {
  let total = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(child);
      } else if (entry.isFile()) total += statSync(child).size;
    }
  };
  walk(directory);
  return total;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('usage: node build.mjs [--profile <name|file>] [--out <dir>] [--node <node.exe>] '
      + '[--node-license <LICENSE>] [--node-license-attestation <json>] [--allow-license-gap] '
      + '[--prune <prune-list.json> | --no-prune] [--plan-only] [--profile-snapshot <dir>] '
      + '[--console-source <dir>] [--allow-repo-output] [--force]\n'
      + '[--license-attestations <json> | --no-license-attestations]\n'
      + `  default profile: ${DEFAULT_PROFILE} (profiles: ${readdirSync(PROFILES_DIR).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, '')).sort().join(', ')})\n`
      + `  default out: ${DEFAULT_OUT}\n`
      + `  in-repo output: only with --allow-repo-output, and only under ${relative(REPO_ROOT, REPO_OUTPUT_ROOT).split(sep).join('/')}/\n`
      + `  default prune list: ${join(HERE, 'prune-list.json')} (pass --no-prune to stage all packages)\n`
      + `  default license attestations: ${DEFAULT_ATTESTATIONS}\n`);
    return;
  }
  const profile = loadProfile(options.profile);
  // A profile that declares its own output keeps the delivered artifact inside the
  // repository; the guard still runs, so the declaration can only point into
  // dist/bundle/ and never anywhere else.
  let out = resolve(options.out);
  let allowRepoOutput = options.allowRepoOutput;
  if (!options.outExplicit && profile.defaultOut !== undefined) {
    out = join(REPO_ROOT, ...profile.defaultOut.split('/'));
    allowRepoOutput = true;
  }
  assertOutsideRepository(out, { allowRepoOutput });
  assertNotSystemPath(out);
  if (options.consoleSource !== undefined) {
    // Inside the repository on purpose: the pinned bytes are an input the evidence
    // has to be able to point at with a relative path, and a pin kept outside would
    // be one more thing a recipient of this bundle cannot check.
    if (!isInside(options.consoleSource, REPO_ROOT)) {
      throw new Error(`--console-source must be inside the repository (${canonicalize(REPO_ROOT)}), got ${canonicalize(options.consoleSource)}`);
    }
    if (!existsSync(options.consoleSource)) throw new Error(`--console-source does not exist: ${options.consoleSource}`);
  }
  if (!options.pruneExplicit) {
    const perProfile = join(HERE, `prune-list-${profile.name}.json`);
    if (existsSync(perProfile)) options.prune = perProfile;
  }

  const { packages } = loadLockfile(REPO_ROOT);
  const sources = resolveProfileSources(options.profileSnapshot);
  const reviewed = verifyApprovedInputs(sources);
  /**
   * Pin every workspace package that lives under `plugins/` to the reviewed
   * source. Without this the closure would copy `app/node_modules/@aegisharness/*`
   * from the live working tree, so a bundle could verify one copy of the defense
   * tools in the profile and execute a different copy from the installation.
   */
  const sourceOverrides = new Map();
  for (const name of ['@aegisharness/dsh-defense-profile', '@aegisharness/dsh-defense-tools']) {
    const directory = name === '@aegisharness/dsh-defense-profile' ? sources.profileSource : sources.toolsSource;
    sourceOverrides.set(name, directory);
  }
  const closure = computeClosure({ repoRoot: REPO_ROOT, packages, roots: profile.closureRoots, sourceOverrides });
  const profileDocument = JSON.parse(readFileSync(join(sources.profileSource, 'profile.json'), 'utf8'));
  const plan = resolvePrunePlan({
    options, nodes: closure.nodes, profile: profileDocument, repoRoot: REPO_ROOT, closureRoots: profile.closureRoots,
  });
  const kept = new Map([...closure.nodes].filter(([, node]) => !plan.pruned.has(node.name)));
  verifyPatchPluginNames({
    patchPath: join(sources.profileSource, 'cordis.patch.yml'),
    nodes: kept,
  });

  if (options.planOnly) {
    const prunedBytes = plan.entries.reduce((sum, row) => sum + row.sizeBytes, 0);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      planOnly: true,
      out,
      closurePackages: closure.nodes.size,
      keptPackages: kept.size,
      prunedPackages: plan.pruned.size,
      prunedMiB: Number((prunedBytes / 1048576).toFixed(1)),
      gate: plan.gate,
      pruneList: plan.pruneList,
      pruned: plan.entries.map((row) => ({
        name: row.name, version: row.version, sizeMiB: Number((row.sizeBytes / 1048576).toFixed(2)),
      })),
    }, null, 2)}\n`);
    return;
  }
  prepareOutput(out, options.force, { allowRepoOutput });

  const appRoot = join(out, 'app');
  const dshHome = join(out, 'dsh-home');
  mkdirSync(join(appRoot, 'node_modules'), { recursive: true });

  for (const node of kept.values()) stagePackage(node, appRoot);
  writeJson(join(appRoot, 'package.json'), {
    name: '@aegisharness/embedded-runtime-bundle',
    version: '0.0.0',
    private: true,
    author: AUTHOR,
    license: 'Apache-2.0',
    type: 'module',
    description: 'Self-contained AegisHarness harness worker bundle (M8 packaging PoC)',
  });

  const attestations = options.attestations === undefined
    ? { node: undefined, byPackage: new Map(), unobtainable: [], verified: [] }
    : loadLicenseAttestations({ path: options.attestations, baseDir: dirname(options.attestations) });
  // An attested Node text is preferred over "whatever sits next to node.exe":
  // the Windows installer ships none, and the recorded one comes from the
  // release archive the binary itself was taken from. The digest is re-checked
  // inside stageNodeRuntime, so this cannot silently ship a different text.
  const nodeLicensePath = options.nodeLicense ?? attestations.node?.path;
  const attestation = options.nodeLicenseAttestation !== undefined
    ? JSON.parse(readFileSync(options.nodeLicenseAttestation, 'utf8'))
    : attestations.node === undefined
      ? undefined
      : {
        version: attestations.node.version,
        sha256: attestations.node.sha256,
        source: `${attestations.node.source} (member ${attestations.node.sourceMember}; `
          + `archive sha256 ${attestations.node.container?.sha256 ?? 'unrecorded'})`,
      };
  const runtime = stageNodeRuntime({
    nodeExecutable: options.node,
    runtimeDir: join(out, 'runtime', 'node'),
    nodeLicense: nodeLicensePath,
    attestation,
    allowUnattested: options.allowLicenseGap,
    // Record the license text relative to the repository, never to the shell's
    // working directory: `runtime.json` is a shipped byte, so its content must
    // depend on the inputs and not on where `node build.mjs` was typed.
    recordBase: REPO_ROOT,
  });
  const { profileDir, toolsDir } = stageProfile({
    profileSource: sources.profileSource,
    toolsSource: sources.toolsSource,
    dshHome,
    profileSourceMirror: join(appRoot, 'node_modules', 'plugins', 'dsh-defense-profile'),
    toolsSourceMirror: join(appRoot, 'node_modules', 'plugins', 'dsh-defense-tools'),
  });

  // Loose assets and forwarders are staged before the launcher so
  // `launch-plan.json` can only name files that exist; the console shell and the
  // rule packs are plain copies, and both are re-hashed into `bundle.json`.
  const assets = await stageProfileAssets({ out, profile, consoleSource: options.consoleSource });
  const forwarders = stageEntryForwarders({ out, profile });
  // The seeder is written before the launcher so `launch-plan.json` can only name a
  // file that exists, and it implies `manifests/rule-packs.json`, which the bundle's
  // own seeder verifies against instead of trusting the directory.
  if (assets.rules !== undefined) writeRuleSeeder({ out, packs: assets.rules.packs });
  const launch = buildLauncher({ out, nodeVersion: runtime.version, profile, assets });
  const preparer = writeAttemptPreparer({ out });

  const approvedCopies = auditApprovedCopies({
    out,
    approved: reviewed.approved,
    profileSource: sources.profileSource,
    toolsSource: sources.toolsSource,
  });

  const manifestsDir = join(out, 'manifests');
  mkdirSync(manifestsDir, { recursive: true });
  // Ship the attestation record itself. A digest that can only be re-computed
  // against a file left behind in the build tree is not verifiable from the
  // bundle, and "the record proves the text" would then be a claim about a file
  // the recipient does not have.
  if (options.attestations !== undefined) {
    copyFileSync(options.attestations, join(manifestsDir, 'license-attestations.json'));
  }
  const thirdParty = writeThirdPartyManifests({
    nodes: kept,
    appRoot,
    manifestsDir,
    projectNotice: readFileSync(join(REPO_ROOT, 'NOTICE'), 'utf8'),
    projectLicenseFile: join(REPO_ROOT, 'LICENSE'),
    pruned: plan.entries,
    supplemental: attestations.byPackage,
  });
  const licenseGaps = writeLicenseGaps({
    packages: thirdParty.packages,
    manifestsDir,
    author: AUTHOR,
  });
  const keptBytes = [...kept.values()].reduce((sum, node) => sum + packageSize(node.sourceDir), 0);
  const prunedBytes = plan.entries.reduce((sum, row) => sum + row.sizeBytes, 0);
  writeTrimReport({
    manifestsDir,
    author: AUTHOR,
    pruneList: plan.pruneList,
    gate: plan.gate,
    scope: {
      lockfileSha256: sha256File(join(REPO_ROOT, 'package-lock.json')),
      // Two different digests, named apart: `profile.json` is the reviewed
      // configuration, `approved-hashes.json` pins the reviewed plugin bytes.
      // Collapsing them under one key makes a future cross-check read as "stale".
      profileSha256: sha256File(join(sources.profileSource, 'profile.json')),
      approvedHashesSha256: reviewed.approvedHashesSha256,
      closureRoots: profile.closureRoots,
      bundleProfile: { name: profile.name, path: profile.recordPath, sha256: profile.sha256 },
    },
    summary: {
      closurePackages: closure.nodes.size,
      keptPackages: kept.size,
      // Names and lockfile copies differ: one pruned name can remove two nested
      // copies, and the inventory counts copies. Both numbers are kept so a
      // reviewer never has to reconcile them by hand.
      prunedNames: plan.pruned.size,
      prunedNodes: plan.entries.length,
      prunedBytes,
      prunedMiB: Number((prunedBytes / 1048576).toFixed(1)),
      keptBytes,
      keptMiB: Number((keptBytes / 1048576).toFixed(1)),
    },
    entries: plan.entries,
  });

  writeJson(join(out, 'bundle.json'), {
    schemaVersion: '1.0',
    author: AUTHOR,
    kind: 'packaging-poc',
    builtAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    bundledNode: runtime.version,
    // The composition this bundle was built from, by digest. Without it a reader
    // cannot tell a v13-shaped payload from a daemon+console one except by
    // listing the tree, and "which inputs produced this" has to be in the file.
    bundleProfile: {
      name: profile.name,
      document: profile.recordPath,
      sha256: profile.sha256,
      description: profile.description,
      closureRoots: profile.closureRoots,
      launchers: profile.launchers,
    },
    nodeLicenseMatchesBundledVersion: runtime.licenseMatches,
    license: {
      node: {
        provenance: runtime.licenseMatches ? 'attested' : 'unattested',
        licenseTextSha256: runtime.licenseTextSha256,
        matchesBundledVersion: runtime.licenseMatches,
        attestedVersion: runtime.licenseMatches ? runtime.version : undefined,
        source: runtime.licenseMatches ? attestation?.source : undefined,
      },
      packagesWithoutLicenseText: licenseGaps.gaps.length,
      packagesSuppliedFromUpstreamRelease: thirdParty.supplied.length,
      licenseGapsFile: 'manifests/license-gaps.json',
      licenseProvenanceFile: 'manifests/license-provenance.json',
      attestationsFile: options.attestations === undefined ? undefined : 'manifests/license-attestations.json',
      attestationsInput: options.attestations === undefined
        ? undefined
        : relative(HERE, options.attestations).split(sep).join('/'),
      attestationsSha256: options.attestations === undefined ? undefined : sha256File(options.attestations),
      complete: runtime.licenseMatches && licenseGaps.gaps.length === 0,
    },
    releaseGaps: [
      ...(runtime.releaseGap === undefined ? [] : [runtime.releaseGap]),
      ...(licenseGaps.gaps.length === 0 ? [] : [{
        id: 'third-party-license-texts',
        severity: licenseGaps.gaps.length > 0 ? 'blocker' : 'none',
        detail: `${licenseGaps.gaps.length} bundled package(s) ship no upstream license text`,
        action: 'see manifests/license-gaps.json',
      }]),
    ],
    prune: {
      applied: plan.pruned.size > 0,
      list: plan.pruneList,
      gate: plan.gate,
      prunedNames: plan.pruned.size,
      prunedNodes: plan.entries.length,
      keptPackages: kept.size,
      report: 'manifests/trim-report.json',
    },
    source: {
      repository: 'AegisHarness',
      lockfileSha256: sha256File(join(REPO_ROOT, 'package-lock.json')),
      lockfilePackages: Object.keys(packages).length,
      closureRoots: profile.closureRoots,
      closurePackages: closure.nodes.size,
      absentOptional: closure.absent,
      profileInputs: {
        kind: sources.kind,
        // Never record the repository's absolute path: the bundle must not carry
        // it, and the leak scan below would (correctly) refuse to ship it. A
        // `--profile-snapshot` directory is subject to the same rule — the leaf
        // name is kept for reproducibility, the parents are not, because the
        // snapshot usually lives outside every path the leak scan knows about.
        directory: sources.kind === 'repository' ? '<repository>' : '<frozen-snapshot>',
        directoryName: sources.kind === 'repository' ? undefined : basename(sources.dir),
        approvedHashesSha256: reviewed.approvedHashesSha256,
        verified: reviewed.verified,
        approvedCopiesChecked: approvedCopies,
      },
    },
    counts: {
      packages: thirdParty.packages.length,
      prunedNames: plan.pruned.size,
      byLicense: Object.fromEntries([...thirdParty.byLicense.entries()]),
    },
    // Assets are recorded with per-file digests, not just a directory name: the
    // console page is the part a recipient actually opens, and "it is in there"
    // is not a statement `files.sha256` can refute.
    ...(assets.console === undefined ? {} : {
      console: {
        origin: assets.console.origin,
        isProductUi: assets.console.isProductUi,
        sourcePath: assets.console.sourcePath,
        pinned: assets.console.pinned,
        pinnedPath: assets.console.pinnedPath,
        declaredSourcePath: assets.console.declaredSourcePath,
        preferredSourcePath: assets.console.preferredSourcePath,
        preferredSourceFiles: assets.console.preferredSourceFiles,
        target: assets.console.target,
        entry: assets.console.entry,
        server: assets.console.server,
        serverFallback: assets.console.serverFallback,
        files: assets.console.files,
        note: assets.console.origin === 'packaging-shell'
          ? 'apps/console held no files when this bundle was built, so the packaging-owned shell was staged. '
            + 'This is a minimal static shell, not the product console implementation.'
          : assets.console.pinned
            ? 'Staged from a pinned copy of apps/console, the product console. The pin exists because another writer '
              + 'edits apps/console while bundles are assembled; the digests above are the bytes that shipped.'
            : 'Staged from apps/console, the product console.',
      },
    }),
    ...(assets.rules === undefined ? {} : {
      rules: {
        sourcePath: assets.rules.sourcePath,
        target: assets.rules.target,
        packs: assets.rules.packs,
      },
    }),
    // Single-file assets carry their digest here for the same reason the console
    // does: "the shell is in the payload" is not a statement `files.sha256` can
    // refute, and the installer needs the declared target to insist on it.
    ...(Object.keys(assets.files ?? {}).length === 0 ? {} : {
      assets: Object.fromEntries(Object.entries(assets.files).map(([kind, row]) => [kind, {
        target: row.target,
        sourcePath: row.sourcePath,
        bytes: row.bytes,
        sha256: row.sha256,
      }])),
    }),
    ...(forwarders.length === 0 ? {} : {
      entryForwarders: forwarders,
    }),
    paths: {
      node: relative(out, runtime.executable).split(sep).join('/'),
      worker: relative(out, join(appRoot, 'node_modules', '@aegisharness', 'harness-worker', 'bin.js')).split(sep).join('/'),
      profile: relative(out, profileDir).split(sep).join('/'),
      tools: relative(out, toolsDir).split(sep).join('/'),
      launcher: relative(out, launch.stubPath).split(sep).join('/'),
      launchPlan: 'launch/launch-plan.json',
      preparer: relative(out, preparer).split(sep).join('/'),
      // Present only when the profile stages them, so a v13-shaped bundle keeps the
      // exact key set it shipped with.
      ...(assets.console === undefined ? {} : {
        console: assets.console.entry,
        consoleServer: assets.console.server,
        consoleDirectory: assets.console.target,
      }),
      ...(assets.rules === undefined ? {} : {
        rules: assets.rules.packs[0].path,
        rulesDirectory: assets.rules.target,
      }),
      ...(forwarders.length === 0 ? {} : {
        daemonEntry: forwarders[0].path,
        daemonPackageEntry: forwarders[0].target,
      }),
      ...(assets.files?.desktop === undefined ? {} : {
        desktopExe: assets.files.desktop.target,
      }),
    },
    nonGoals: launch.plan.nonGoals,
  });

  const sizeBytes = directorySize(out);
  writeBundleReadme({
    out,
    nodeVersion: runtime.version,
    counts: thirdParty.packages.length,
    uniquePackages: new Set(thirdParty.packages.map((pkg) => pkg.name)).size,
    sizeBytes,
    pruned: plan.pruned.size,
    prunedMiB: Number((prunedBytes / 1048576).toFixed(1)),
    licenseGaps: licenseGaps.gaps.length,
    nodeLicenseAttested: runtime.licenseMatches,
    profile,
    assets,
    forwarders,
  });
  const leakScan = assertNoRepositoryPathLeak(out);
  const hashManifest = writeHashManifest({ bundleRoot: out, manifestsDir });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    out,
    sizeMiB: Number((directorySize(out) / 1048576).toFixed(1)),
    closurePackages: closure.nodes.size,
    keptPackages: kept.size,
    prunedNames: plan.pruned.size,
    prunedMiB: Number((prunedBytes / 1048576).toFixed(1)),
    hashedFiles: hashManifest.count,
    leakScan,
    bundledNode: runtime.version,
    nodeLicenseAttested: runtime.licenseMatches,
    packagesWithoutLicenseText: licenseGaps.gaps.length,
    packagesSuppliedFromUpstreamRelease: thirdParty.supplied.length,
    licenseAttestationsVerified: attestations.verified.length,
    launcher: launch.stubPath,
    launchStubs: launch.stubs.map((path) => relative(out, path).split(sep).join('/')),
    bundleProfile: profile.name,
    console: assets.console === undefined ? undefined : {
      origin: assets.console.origin,
      entry: assets.console.entry,
      files: assets.console.files.length,
      server: assets.console.server,
      pinned: assets.console.pinned,
      serverFallback: assets.console.serverFallback?.path,
    },
    rules: assets.rules === undefined ? undefined : assets.rules.packs.map((pack) => ({
      path: pack.path,
      packId: pack.packId,
      rules: pack.rules,
    })),
    desktop: assets.files?.desktop === undefined ? undefined : {
      executable: assets.files.desktop.target,
      bytes: assets.files.desktop.bytes,
      sha256: assets.files.desktop.sha256,
    },
    entryForwarders: forwarders.map((row) => row.path),
  }, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(`build-embedded-runtime: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
