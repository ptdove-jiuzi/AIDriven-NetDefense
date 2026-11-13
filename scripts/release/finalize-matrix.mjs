#!/usr/bin/env node
/**
 * Write the multi-asset `latest.json` and `SHA256SUMS.txt` from the **final** files.
 *
 * This is the matrix counterpart of `finalize-release.mjs`. The Windows-only version
 * knew about exactly two assets, because a Release used to carry exactly two packages.
 * A Release now carries four, and the manifest has to describe them well enough that a
 * client can pick the right file without parsing its name:
 *
 *   { version, notes, minVersion,
 *     assets: [{ platform, arch, kind, name, size, sha256, url }] }
 *
 *   platform  "win32" | "linux"        — `process.platform` spelling, not "windows"
 *   arch      "x64"                    — one value today; the field exists so adding
 *                                        arm64 later is not a breaking change
 *   kind      "installer" | "portable" | "deb"
 *   sha256    of the bytes that get uploaded, nothing else
 *
 * The ordering rule from DIST-DECISION §4 is enforced, not promised: every hash is
 * computed from the file on disk, and after `latest.json` and `SHA256SUMS.txt` are
 * written the four artefacts are stat-ed and hashed **again**. If anything changed in
 * between (a stray copy, a second packer run, an editor writing in place) the build
 * fails instead of publishing a manifest that lies.
 *
 * usage:
 *   node scripts/release/finalize-matrix.mjs --dir <release-dir> --version <ver>
 *     --repo <owner/name> --tag <tag> [--notes <file.md>] [--min-version <ver>]
 *
 * Author: PT-dove
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The four release assets, in the order they are described in the notes.
 * `name` is a function of the version so the filename rule lives in exactly one place
 * per script; `verify-assets.mjs` deliberately keeps its own copy — a gate that shares
 * the generator's table cannot catch a wrong table.
 */
export const ASSETS = Object.freeze([
  {
    name: (version) => `AIDrivenNetDefense-Setup-${version}-win-x64.exe`,
    platform: 'win32',
    arch: 'x64',
    kind: 'installer',
    summary: 'Windows installer (payload embedded)',
  },
  {
    name: (version) => `AIDrivenNetDefense-${version}-win-x64-portable.zip`,
    platform: 'win32',
    arch: 'x64',
    kind: 'portable',
    summary: 'Windows portable archive',
  },
  {
    name: (version) => `AIDrivenNetDefense-${version}-linux-x64.tar.gz`,
    platform: 'linux',
    arch: 'x64',
    kind: 'portable',
    summary: 'Linux archive (no service registration)',
  },
  {
    name: (version) => `aidriven-netdefense_${version}_amd64.deb`,
    platform: 'linux',
    arch: 'x64',
    kind: 'deb',
    summary: 'Debian/Ubuntu package (registers systemd unit)',
  },
]);

function parseArgs(argv) {
  const options = { dir: undefined, version: undefined, repo: undefined, tag: undefined, notes: undefined, minVersion: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') options.dir = argv[++index];
    else if (arg === '--version') options.version = argv[++index];
    else if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--tag') options.tag = argv[++index];
    else if (arg === '--notes') options.notes = argv[++index];
    else if (arg === '--min-version') options.minVersion = argv[++index] ?? '';
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node scripts/release/finalize-matrix.mjs --dir d --version v --repo owner/name --tag t [--notes f] [--min-version v]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`finalize-matrix: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  for (const key of ['dir', 'version', 'repo', 'tag']) {
    if (!options[key]) {
      process.stderr.write(`finalize-matrix: --${key} is required\n`);
      process.exit(2);
    }
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(options.repo)) {
    process.stderr.write(`finalize-matrix: --repo must look like owner/name, got ${options.repo}\n`);
    process.exit(2);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.version)) {
    process.stderr.write(`finalize-matrix: --version is not a semantic version: ${options.version}\n`);
    process.exit(2);
  }
  return options;
}

function sha256OfFile(path) {
  const digest = createHash('sha256');
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let read = 0;
    while ((read = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
}

function defaultNotes({ version, repo, tag, assets }) {
  const lines = [
    `AIDriven NetDefense ${version}`,
    '',
    '发布资产 / release assets:',
    ...assets.map((asset) => `- \`${asset.name}\` — ${asset.summary} (${(asset.size / 1024 / 1024).toFixed(1)} MiB)`),
    '- `latest.json` — 更新清单 / update manifest (four assets, one schema)',
    '- `SHA256SUMS.txt` — 四件校验和 / checksums for all four packages',
    '',
    '安装 / install:',
    '- Windows 安装版：双击 Setup.exe；写卸载项与开始菜单。',
    '- Windows 便携版：解压即用，不写注册表。与安装版载荷相同。',
    '- Linux deb：`sudo apt install ./aidriven-netdefense_<ver>_amd64.deb`，注册 systemd 单元',
    '  并创建系统用户 `aegis`；数据在 `/var/lib/aidriven-netdefense`。',
    '- Linux tar.gz：解压到 `/` 手动部署，**不**注册服务，步骤见包内 `INSTALL.txt`。',
    '',
    '**未签名 / unsigned.** 本版本没有代码签名证书。Windows SmartScreen 会提示',
    '「Windows 已保护你的电脑 / Windows protected your PC」，文件名可能显示为',
    '「未知发布者 / Unknown publisher」。这是预期行为，不是安装包损坏：',
    '请核对下方 SHA256SUMS.txt 里的 sha256，与 GitHub 上本页给出的值逐个字符比对，',
    '一致再选择「更多信息 → 仍要运行」。本项目不会、也无法通过任何手段规避该提示。',
    '',
    'Unsigned build: SmartScreen will warn. That is expected, not a corrupted download.',
    'Compare the sha256 with SHA256SUMS.txt on this page before running it.',
    '',
    `Source: https://github.com/${repo}/tree/${tag}`,
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolve(options.dir);
  const base = `https://github.com/${options.repo}/releases/download/${encodeURIComponent(options.tag)}`;

  const missing = [];
  for (const spec of ASSETS) {
    const path = join(dir, spec.name(options.version));
    if (!existsSync(path)) missing.push(path);
    else if (statSync(path).size === 0) missing.push(`${path} (empty)`);
  }
  if (missing.length > 0) {
    for (const path of missing) process.stderr.write(`finalize-matrix: missing or empty artefact ${path}\n`);
    process.exit(1);
  }

  const measured = ASSETS.map((spec) => {
    const name = spec.name(options.version);
    const path = join(dir, name);
    const stats = statSync(path);
    return {
      path,
      spec,
      name,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      sha256: sha256OfFile(path),
      url: `${base}/${encodeURIComponent(name)}`,
    };
  });

  const notes = options.notes
    ? readFileSync(resolve(options.notes), 'utf8')
    : defaultNotes({
      version: options.version,
      repo: options.repo,
      tag: options.tag,
      assets: measured.map((entry) => ({ name: entry.name, size: entry.size, summary: entry.spec.summary })),
    });

  const latest = {
    version: options.version,
    notes,
    minVersion: options.minVersion ?? '',
    assets: measured.map((entry) => ({
      platform: entry.spec.platform,
      arch: entry.spec.arch,
      kind: entry.spec.kind,
      name: entry.name,
      size: entry.size,
      sha256: entry.sha256,
      url: entry.url,
    })),
  };

  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'RELEASE-NOTES.md'), notes, 'utf8');
  writeFileSync(
    join(dir, 'SHA256SUMS.txt'),
    `${[...measured]
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .map((entry) => `${entry.sha256}  ${entry.name}`)
      .join('\n')}\n`,
    'utf8',
  );

  // DIST-DECISION §4, checked instead of asserted: the manifest was written from these
  // bytes, so the bytes must still hash to the same value right after.
  for (const entry of measured) {
    const after = statSync(entry.path);
    if (after.size !== entry.size || after.mtimeMs !== entry.mtimeMs) {
      process.stderr.write(
        `finalize-matrix: ${entry.name} changed while latest.json was being written; refusing to publish a stale hash\n`,
      );
      process.exit(1);
    }
    const again = sha256OfFile(entry.path);
    if (again !== entry.sha256) {
      process.stderr.write(`finalize-matrix: ${entry.name} hash changed (${entry.sha256} -> ${again})\n`);
      process.exit(1);
    }
  }

  process.stdout.write(`release dir: ${dir}\n`);
  for (const entry of measured) {
    process.stdout.write(
      `  ${entry.name}\n    ${entry.spec.platform}/${entry.spec.arch}/${entry.spec.kind}\n    bytes  ${entry.size}\n    sha256 ${entry.sha256}\n`,
    );
  }
  process.stdout.write(`  latest.json  (version ${latest.version}, ${latest.assets.length} assets, minVersion ${JSON.stringify(latest.minVersion)})\n`);
  process.stdout.write(`  SHA256SUMS.txt (${measured.length} rows)\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
