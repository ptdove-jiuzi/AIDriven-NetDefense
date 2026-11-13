#!/usr/bin/env node
/**
 * Assemble the **linux-x64** payload tree for the .deb / tar.gz, from a checked-out
 * workspace with `node_modules` already installed on Linux.
 *
 * Why this exists instead of reusing `deploy/embedded-runtime/build.mjs`:
 * that builder hardcodes `platform: 'win32-x64'`, writes `runtime/node/node.exe` and
 * `.cmd` launchers, and its prune lists are compiled per Windows profile. It is the
 * authority for the Windows bundle, and `deploy/**` is outside this task's write scope,
 * so the Linux composition lives here as a separate, deliberately narrow assembler
 * rather than as a second opinion patched into the Windows one.
 *
 * The output root is a *bundle root*, exactly the shape the Windows payload has, so
 * that `/opt/aidriven-netdefense/app/…` in ADR-0009 §5.3 maps onto it one-to-one:
 *
 *   <bundle>/app/node_modules/…      dependencies (symlinks dereferenced)
 *   <bundle>/app/node_modules/@aegisharness/cli/…   the client, staged as a package
 *   <bundle>/apps/daemon/bin.js      forwarder into app/node_modules
 *   <bundle>/apps/cli/bin.js         forwarder into app/node_modules
 *   <bundle>/runtime/node/bin/node   official Node.js linux-x64, unmodified
 *   <bundle>/console/…               console front end + its static server
 *   <bundle>/rules/…                 built-in rule pack
 *   <bundle>/manifests/files.sha256  relative-path manifest, manifests/ excluded
 *   <bundle>/bundle.json             identity of this payload
 *
 * The Node runtime is pinned twice: by the constant below and by the official
 * `SHASUMS256.txt` fetched at build time. Both must agree with the downloaded archive,
 * so a tampered CDN or a wrong constant fails the build instead of shipping a runtime
 * nobody validated.
 *
 * usage:
 *   node scripts/release/build-linux-payload.mjs --out <dir> --version <ver>
 *     [--node-version v24.20.0] [--cache <dir>] [--repo-root .] [--force]
 *
 * Author: PT-dove
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** The one Node version this release line ships, on every platform (ADR-0009 §9). */
const NODE_VERSION = 'v24.20.0';

/**
 * sha256 of node-v24.20.0-linux-x64.tar.xz as published in
 * https://nodejs.org/dist/v24.20.0/SHASUMS256.txt (read 2026-11-04).
 * Kept as a constant so the build does not depend on the network for its pin; the
 * SHASUMS file is still fetched and compared, which catches a constant that has gone
 * stale against upstream.
 */
const NODE_SHA256 = '2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2';

const LOG = (message) => process.stdout.write(`${message}\n`);

function fatal(message) {
  process.stderr.write(`build-linux-payload: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    out: undefined,
    version: undefined,
    nodeVersion: NODE_VERSION,
    cache: undefined,
    repoRoot: '.',
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') options.out = argv[++index];
    else if (arg === '--version') options.version = argv[++index];
    else if (arg === '--node-version') options.nodeVersion = argv[++index];
    else if (arg === '--cache') options.cache = argv[++index];
    else if (arg === '--repo-root') options.repoRoot = argv[++index];
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') {
      LOG('usage: node scripts/release/build-linux-payload.mjs --out d --version v [--node-version v] [--cache d] [--repo-root d] [--force]');
      process.exit(0);
    } else {
      fatal(`unknown argument ${arg}`);
    }
  }
  if (!options.out) fatal('--out is required');
  if (!options.version) fatal('--version is required');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.version)) fatal(`not a semantic version: ${options.version}`);
  return options;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  if (response.body === null) throw new Error(`${url} -> empty body`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

/**
 * Every path in the manifest is relative to the bundle root with forward slashes, and
 * `manifests/` is excluded because it cannot contain its own digest. `sha256sum -c`
 * ignores the `#` header lines, so postinst can run the file verbatim.
 */
function writeManifest(bundleRoot) {
  const rows = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(bundleRoot, absolute).split(sep).join('/');
      if (relativePath === 'manifests' || relativePath.startsWith('manifests/')) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) rows.push({ path: relativePath, sha256: sha256File(absolute) });
      else fatal(`unexpected non-file entry in the payload: ${relativePath}`);
    }
  };
  walk(bundleRoot);
  rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const header = [
    '# AegisHarness embedded runtime bundle — SHA-256 manifest',
    '# Format: <sha256>  <path relative to bundle root>, two spaces, no quotes.',
    '# The manifests/ directory is excluded: it cannot contain its own digest.',
  ];
  writeFileSync(
    join(bundleRoot, 'manifests', 'files.sha256'),
    `${header.concat(rows.map((row) => `${row.sha256}  ${row.path}`)).join('\n')}\n`,
    'utf8',
  );
  return rows.length;
}

function copyTree(source, destination, options = {}) {
  if (!existsSync(source)) fatal(`missing source directory: ${source}`);
  cpSync(source, destination, { recursive: true, dereference: true, force: true, ...options });
}

function stageNodeRuntime({ cache, nodeVersion, bundleRoot }) {
  const archiveName = `node-${nodeVersion}-linux-x64.tar.xz`;
  const archivePath = join(cache, archiveName);
  const url = `https://nodejs.org/dist/${nodeVersion}/${archiveName}`;

  if (!existsSync(archivePath)) {
    LOG(`  downloading ${url}`);
    const downloader = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', archivePath, url], { encoding: 'utf8' });
    if (downloader.status !== 0) fatal(`download failed: ${downloader.stderr ?? ''}`);
  }
  const actual = sha256File(archivePath);
  if (actual !== NODE_SHA256) {
    fatal(
      `Node archive sha256 mismatch for ${nodeVersion}\n  pinned ${NODE_SHA256}\n  actual ${actual}\n`
        + '  Refusing to build a payload around an unverified runtime.',
    );
  }

  const extractRoot = join(cache, `extract-${nodeVersion}`);
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  run('tar', ['-xJf', archivePath, '-C', extractRoot]);
  const distribution = join(extractRoot, `node-${nodeVersion}-linux-x64`);
  if (!existsSync(join(distribution, 'bin', 'node'))) fatal(`archive did not contain bin/node: ${distribution}`);

  const runtime = join(bundleRoot, 'runtime', 'node');
  mkdirSync(runtime, { recursive: true });
  cpSync(join(distribution, 'bin', 'node'), join(runtime, 'bin', 'node'), { recursive: false });
  chmodSync(join(runtime, 'bin', 'node'), 0o755);
  copyTree(join(distribution, 'lib'), join(runtime, 'lib'));
  // npm/corepack are not part of the shipped product and are the largest removable
  // pieces of the distribution; the payload runs node, it never installs packages.
  rmSync(join(runtime, 'lib', 'node_modules', 'npm'), { recursive: true, force: true });
  rmSync(join(runtime, 'lib', 'node_modules', 'corepack'), { recursive: true, force: true });
  for (const extra of ['include', 'share']) {
    rmSync(join(runtime, extra), { recursive: true, force: true });
  }
  for (const licence of ['LICENSE', 'README.md']) {
    if (existsSync(join(distribution, licence))) cpSync(join(distribution, licence), join(runtime, licence));
  }

  const reported = run(join(runtime, 'bin', 'node'), ['--version']).trim();
  if (reported !== nodeVersion) fatal(`bundled runtime reports ${reported}, expected ${nodeVersion}`);
  return { archiveName, sha256: actual, reported };
}

async function main() {
  if (process.platform !== 'linux') {
    fatal(
      `this assembler only runs on Linux (found ${process.platform}).\n`
        + 'It produces a linux-x64 payload from linux-installed node_modules; a Windows\n'
        + 'build host cannot supply the platform-specific prebuilds and must not pretend to.',
    );
  }

  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(options.repoRoot);
  const bundleRoot = resolve(options.out);
  const cache = resolve(options.cache ?? join(process.env.RUNNER_TEMP ?? '/tmp', 'aidn-node-cache'));

  for (const required of ['apps/daemon/bin.js', 'apps/cli/bin.js', 'apps/console', 'node_modules']) {
    if (!existsSync(join(repoRoot, required))) fatal(`workspace is incomplete: missing ${required}`);
  }

  if (existsSync(bundleRoot) && readdirSync(bundleRoot).length > 0) {
    if (!options.force) fatal(`--out is not empty: ${bundleRoot} (pass --force to rebuild)`);
    rmSync(bundleRoot, { recursive: true, force: true });
  }
  mkdirSync(bundleRoot, { recursive: true });
  mkdirSync(cache, { recursive: true });

  LOG(`payload → ${bundleRoot}`);
  LOG(`  version ${options.version}, node ${options.nodeVersion}`);

  // The pin is a constant, but a stale constant is still a bug: cross-check it against
  // the official SHASUMS before trusting it.
  const shasums = await fetchText(`https://nodejs.org/dist/${options.nodeVersion}/SHASUMS256.txt`);
  const published = shasums
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts.length === 2 && parts[1] === `node-${options.nodeVersion}-linux-x64.tar.xz`);
  if (published === undefined) fatal(`SHASUMS256.txt has no entry for node-${options.nodeVersion}-linux-x64.tar.xz`);
  if (published[0] !== NODE_SHA256) {
    fatal(`upstream SHASUMS disagrees with the pin for ${options.nodeVersion}: ${published[0]} != ${NODE_SHA256}`);
  }
  LOG('  node pin agrees with upstream SHASUMS256.txt');

  // 1. dependencies, symlinks dereferenced: dpkg and tar both ship symlinks, but a
  //    workspace link pointing outside the payload would dangle on the target host.
  LOG('  staging app/node_modules');
  copyTree(join(repoRoot, 'node_modules'), join(bundleRoot, 'app', 'node_modules'), {
    filter: (source) => !source.includes(`${sep}.cache${sep}`) && !source.endsWith(`${sep}.cache`),
  });

  // 2. the client ships as a package, not as a bare directory: its imports of
  //    @aegisharness/* resolve against app/node_modules, the only place they exist.
  LOG('  staging @aegisharness/cli');
  const cliTarget = join(bundleRoot, 'app', 'node_modules', '@aegisharness', 'cli');
  rmSync(cliTarget, { recursive: true, force: true });
  copyTree(join(repoRoot, 'apps', 'cli'), cliTarget);

  // 3. entry forwarders, same shape as the Windows payload: they import through a
  //    relative path so the real entry decides dependency resolution.
  mkdirSync(join(bundleRoot, 'apps', 'daemon'), { recursive: true });
  mkdirSync(join(bundleRoot, 'apps', 'cli'), { recursive: true });
  writeFileSync(
    join(bundleRoot, 'apps', 'daemon', 'bin.js'),
    [
      '#!/usr/bin/env node',
      '// Entry forwarder for @aegisharness/daemon (author PT-dove).',
      '//',
      '// The install tree is app/node_modules; this file only re-enters the packaged',
      '// module so that <bundle>/apps/<name>/bin.js works as typed. It resolves no',
      '// dependency itself: the real entry\'s location decides that.',
      'import "../../app/node_modules/@aegisharness/daemon/bin.js";',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(bundleRoot, 'apps', 'cli', 'bin.js'),
    [
      '#!/usr/bin/env node',
      '// Entry forwarder for @aegisharness/cli (author PT-dove).',
      '//',
      '// The install tree is app/node_modules; this file only re-enters the packaged',
      '// module so that <bundle>/apps/<name>/bin.js works as typed. It resolves no',
      '// dependency itself: the real entry\'s location decides that.',
      'import "../../app/node_modules/@aegisharness/cli/bin.js";',
      '',
    ].join('\n'),
    'utf8',
  );

  // 4. console + rule pack
  LOG('  staging console and rules');
  copyTree(join(repoRoot, 'apps', 'console'), join(bundleRoot, 'console'));
  const shellServer = join(repoRoot, 'deploy', 'embedded-runtime', 'console-shell', 'serve.mjs');
  if (existsSync(shellServer)) cpSync(shellServer, join(bundleRoot, 'console', 'serve.mjs'));
  copyTree(join(repoRoot, 'deploy', 'embedded-runtime', 'rules'), join(bundleRoot, 'rules'));

  // 5. runtime
  LOG('  staging runtime/node');
  const nodeFacts = stageNodeRuntime({ cache, nodeVersion: options.nodeVersion, bundleRoot });

  // 6. manifests
  mkdirSync(join(bundleRoot, 'manifests', 'licenses'), { recursive: true });
  if (existsSync(join(bundleRoot, 'runtime', 'node', 'LICENSE'))) {
    cpSync(join(bundleRoot, 'runtime', 'node', 'LICENSE'), join(bundleRoot, 'manifests', 'licenses', 'node-LICENSE'));
  }
  const manifestRows = writeManifest(bundleRoot);

  // 7. identity
  const bundle = {
    schemaVersion: '1.0',
    author: 'PT-dove',
    kind: 'packaging-poc',
    builtAt: new Date().toISOString(),
    platform: 'linux-x64',
    host: { platform: process.platform, arch: process.arch, node: process.version },
    bundledNode: options.nodeVersion,
    runtime: { archive: nodeFacts.archiveName, sha256: nodeFacts.sha256, reported: nodeFacts.reported },
    bundleProfile: {
      name: 'daemon-console-linux',
      document: 'scripts/release/build-linux-payload.mjs',
      note: 'Linux composition of the daemon-console profile. Adds apps/cli to the payload because ADR-0009 §5.3 requires /usr/bin/aegis-cli; the Windows payload does not ship the client yet.',
    },
    entry: 'apps/daemon/bin.js',
    manifest: { path: 'manifests/files.sha256', rows: manifestRows },
    installedVersion: options.version,
  };
  writeFileSync(join(bundleRoot, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  writeFileSync(
    join(bundleRoot, 'README-BUNDLE.md'),
    [
      '# AIDriven NetDefense — embedded runtime bundle (linux-x64)',
      '',
      `- version: ${options.version}`,
      `- node: ${options.nodeVersion} (official linux-x64, sha256 ${nodeFacts.sha256})`,
      `- manifest: manifests/files.sha256, ${manifestRows} rows`,
      '',
      'Every path in `manifests/files.sha256` is relative to this directory. Verify with:',
      '',
      '```sh',
      'cd /opt/aidriven-netdefense/app && sha256sum -c manifests/files.sha256',
      '```',
      '',
      'The daemon entry is `apps/daemon/bin.js`; the client entry is `apps/cli/bin.js`.',
      'Both are forwarders into `app/node_modules`, which is where dependencies live.',
      '',
      'Author: PT-dove',
      '',
    ].join('\n'),
    'utf8',
  );

  LOG(`  manifest rows ${manifestRows}`);
  LOG(`  bundle.json written`);
  LOG('payload complete');
}

main().catch((error) => {
  process.stderr.write(`build-linux-payload: ${error?.stack ?? error}\n`);
  process.exit(1);
});
