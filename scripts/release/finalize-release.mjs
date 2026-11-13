#!/usr/bin/env node
/**
 * Write `latest.json` and `SHA256SUMS.txt` from the **final** release files.
 *
 * This script is the last thing that touches the artefacts before upload, and its
 * whole job is to make one ordering rule impossible to break:
 *
 *   the sha256 in `latest.json` is computed from the bytes that will be uploaded,
 *   never written first and patched afterwards.
 *
 * How that is enforced rather than promised:
 *   1. hashes are computed from the files on disk, not from a report or an env var;
 *   2. after `latest.json` and `SHA256SUMS.txt` are written, both artefacts are
 *      hashed **again** and the values must be identical — any concurrent rewrite
 *      (a stray copy step, a re-run of the packing script) fails the build instead of
 *      shipping a manifest that lies;
 *   3. `verify-release.mjs` repeats the check independently right before upload.
 *
 * `latest.json` keeps exactly the field set from ADR-0011 §2 — no extra fields, so a
 * client written against the ADR cannot trip over something we invented:
 *
 *   { version, notes, minVersion, assets: [{ name, size, sha256, url }] }
 *
 *   version     the tag's version, without the leading `v`
 *   notes       release body (what the Release page shows)
 *   minVersion  **empty string by default.**  An empty string means "no security
 *               floor is published": the client must treat it as absent and never
 *               compare it numerically, because "" is not a version — comparing it
 *               would make every installed version look older and turn a routine
 *               check into a forced update.  It is filled only for a security
 *               release, and then it is a real version string.
 *   assets[].url  the final download URL of the same GitHub Release; the client must
 *               refuse asset URLs pointing at another host or another release.
 *
 * usage:
 *   node scripts/release/finalize-release.mjs --dir <release-dir> --version <ver>
 *     --repo <owner/name> --tag <tag> [--notes <file.md>] [--min-version <ver>]
 *
 * Author: PT-dove
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETUP_NAME = (version) => `AIDrivenNetDefense-Setup-${version}.exe`;
export const PORTABLE_NAME = (version) => `AIDrivenNetDefense-${version}-win-x64-portable.zip`;

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
        'usage: node scripts/release/finalize-release.mjs --dir d --version v --repo owner/name --tag t [--notes f] [--min-version v]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`finalize-release: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  for (const key of ['dir', 'version', 'repo', 'tag']) {
    if (!options[key]) {
      process.stderr.write(`finalize-release: --${key} is required\n`);
      process.exit(2);
    }
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(options.repo)) {
    process.stderr.write(`finalize-release: --repo must look like owner/name, got ${options.repo}\n`);
    process.exit(2);
  }
  return options;
}

function sha256OfFile(path) {
  const digest = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let read = 0;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

function defaultNotes({ version, repo, tag, assets }) {
  const lines = [
    `AIDriven NetDefense ${version}`,
    '',
    '发布资产 / release assets:',
    ...assets.map((asset) => `- \`${asset.name}\` (${(asset.size / 1024 / 1024).toFixed(1)} MiB)`),
    '- `latest.json` — 更新清单 / update manifest',
    '- `SHA256SUMS.txt` — 两包校验和 / checksums for both packages',
    '',
    '安装 / install:',
    '- 安装版：下载 Setup.exe 双击安装，可写卸载项与开始菜单；卸载在「应用和功能」里。',
    '- 便携版：解压即可运行，不写注册表。两者载荷相同。',
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
  return lines.join('\n') + '\n';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolve(options.dir);
  const setupPath = join(dir, SETUP_NAME(options.version));
  const portablePath = join(dir, PORTABLE_NAME(options.version));

  for (const path of [setupPath, portablePath]) {
    if (!existsSync(path)) {
      process.stderr.write(`finalize-release: missing artefact ${path}\n`);
      process.exit(1);
    }
    if (statSync(path).size === 0) {
      process.stderr.write(`finalize-release: artefact is empty ${path}\n`);
      process.exit(1);
    }
  }

  const base = `https://github.com/${options.repo}/releases/download/${encodeURIComponent(options.tag)}`;
  const measure = (path, name) => {
    const stats = statSync(path);
    return { path, name, size: stats.size, mtimeMs: stats.mtimeMs, sha256: sha256OfFile(path), url: `${base}/${encodeURIComponent(name)}` };
  };

  const assets = [
    measure(setupPath, SETUP_NAME(options.version)),
    measure(portablePath, PORTABLE_NAME(options.version)),
  ];

  const notes = options.notes
    ? readFileSync(resolve(options.notes), 'utf8')
    : defaultNotes({ version: options.version, repo: options.repo, tag: options.tag, assets });

  const latest = {
    version: options.version,
    notes,
    minVersion: options.minVersion ?? '',
    assets: assets.map(({ name, size, sha256, url }) => ({ name, size, sha256, url })),
  };

  const latestPath = join(dir, 'latest.json');
  const sumsPath = join(dir, 'SHA256SUMS.txt');
  const notesPath = join(dir, 'RELEASE-NOTES.md');
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
  // The same text goes to the Release body, so a user reading either place sees the
  // same unsigned-build warning.  `latest.json` carries it as `notes` because the
  // update client shows it verbatim.
  writeFileSync(notesPath, notes, 'utf8');
  writeFileSync(
    sumsPath,
    [...assets]
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .map((asset) => `${asset.sha256}  ${asset.name}`)
      .join('\n') + '\n',
    'utf8',
  );

  // The rule from DIST-DECISION §4, checked instead of asserted in prose.
  for (const asset of assets) {
    const after = statSync(asset.path);
    if (after.size !== asset.size || after.mtimeMs !== asset.mtimeMs) {
      process.stderr.write(
        `finalize-release: ${asset.name} changed while latest.json was being written; refusing to publish a stale hash\n`,
      );
      process.exit(1);
    }
    const again = sha256OfFile(asset.path);
    if (again !== asset.sha256) {
      process.stderr.write(`finalize-release: ${asset.name} hash changed (${asset.sha256} -> ${again})\n`);
      process.exit(1);
    }
  }

  process.stdout.write(`release dir: ${dir}\n`);
  for (const asset of assets) {
    process.stdout.write(`  ${asset.name}\n    bytes  ${asset.size}\n    sha256 ${asset.sha256}\n`);
  }
  process.stdout.write(`  latest.json  (version ${latest.version}, minVersion ${JSON.stringify(latest.minVersion)})\n`);
  process.stdout.write(`  SHA256SUMS.txt (${assets.length} rows)\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
