// AegisHarness plugin manager — author: PT-dove
// Offline inspection of an unpacked plugin directory. Only read APIs are used: the
// package is stat'ed, listed and read as text, never imported, loaded or modified.

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ERROR_CODES, PluginCheckError } from './errors.js';
import { createDiagnostics } from './diagnostics.js';
import { COMPATIBILITY_PROFILE } from './profile.js';
import { decodeUtf8Strict, parseStrictJson } from './json.js';
import { digestOf, sha256Hex } from './jcs.js';
import { validatePackageJson } from './package-manifest.js';
import { validatePluginJson } from './plugin-manifest.js';
import { toolFullName } from './permissions.js';
import { collectModuleGraph } from './source-scan.js';

const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_FILES = 8192;

const INCOMPATIBILITY_CODES = new Set([
  ERROR_CODES.UNSUPPORTED_API,
  ERROR_CODES.ENGINE_MISMATCH,
  ERROR_CODES.CORDIS_MISMATCH,
  ERROR_CODES.UNSUPPORTED_PERMISSION,
  ERROR_CODES.EXPORT_SHAPE_INVALID,
]);

const SIDE_EFFECTS = Object.freeze({
  writes: 0,
  executedPluginCode: false,
  staged: false,
});

function pointer(relative) {
  return relative === '' ? '' : `/${relative}`;
}

function toRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function walkPackageTree(root, diagnostics) {
  /** @type {Map<string, number>} */
  const files = new Map();
  let fatal = false;
  const stack = [{ absolute: root, relative: '' }];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true });
    } catch (error) {
      diagnostics.add(
        ERROR_CODES.IO_ERROR,
        pointer(current.relative),
        `cannot list directory "${current.relative || '.'}": ${describeError(error)}`,
      );
      fatal = true;
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      const childAbsolute = path.join(current.absolute, entry.name);
      const childRelative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;

      let stats;
      try {
        stats = lstatSync(childAbsolute);
      } catch (error) {
        diagnostics.add(
          ERROR_CODES.IO_ERROR,
          pointer(childRelative),
          `cannot stat "${childRelative}": ${describeError(error)}`,
        );
        fatal = true;
        continue;
      }

      if (stats.isSymbolicLink()) {
        diagnostics.add(
          ERROR_CODES.PACKAGE_SYMLINK,
          pointer(childRelative),
          'symbolic links are not allowed inside a plugin package',
        );
        fatal = true;
        continue;
      }
      if (stats.isDirectory()) {
        stack.push({ absolute: childAbsolute, relative: childRelative });
        continue;
      }
      if (!stats.isFile()) {
        diagnostics.add(
          ERROR_CODES.ENTRY_NOT_REGULAR,
          pointer(childRelative),
          'only regular files are allowed inside a plugin package',
        );
        fatal = true;
        continue;
      }
      // DEF-10：硬链接把"包的身份"绑到了 inode 而不是路径。`lstat` 对硬链接看到的是
      // 普通文件，`realpath` 也仍落在包内（硬链接没有自己的路径），唯一可判定的信号是
      // `nlink > 1`——这个 inode 至少还有一个包外的名字，能写那份文件的一方可以在批准
      // 之后换掉包内看到的 package.json / plugin.json / 入口模块（TOCTOU）。
      //
      // 代价：用 `cp -l` / pnpm 之类硬链接去重过的目录会被拒绝。插件包按定义是一份
      // 独立归档（npm 打包不保留硬链接），所以这里选择"拒绝"而不是"照读"。
      if (stats.nlink > 1) {
        diagnostics.add(
          ERROR_CODES.PACKAGE_HARDLINK,
          pointer(childRelative),
          `file has ${stats.nlink} hard links; a package file must not be reachable from outside the package`,
        );
        fatal = true;
        continue;
      }
      if (stats.size > MAX_PACKAGE_FILE_BYTES) {
        diagnostics.add(
          ERROR_CODES.PACKAGE_TOO_LARGE,
          pointer(childRelative),
          `file is ${stats.size} bytes, the package file limit is ${MAX_PACKAGE_FILE_BYTES}`,
        );
        fatal = true;
        continue;
      }
      if (files.size >= MAX_PACKAGE_FILES) {
        diagnostics.add(
          ERROR_CODES.LIMIT_EXCEEDED,
          pointer(childRelative),
          `package contains more than ${MAX_PACKAGE_FILES} files`,
        );
        fatal = true;
        stack.length = 0;
        break;
      }
      files.set(childRelative, stats.size);
    }
  }

  return { files, fatal };
}

function computePackageDigest(root, files) {
  const records = [];
  for (const relative of [...files.keys()].sort()) {
    const absolute = path.join(root, ...relative.split('/'));
    const buffer = readFileSync(absolute);
    records.push(`${relative}\u0000${sha256Hex(buffer)}\u0000${buffer.length}\n`);
  }
  return sha256Hex(records.join(''));
}

function readJsonDocument(root, relative, maxBytes, diagnostics, knownFiles) {
  // Reads are restricted to files the tree walk already proved to be regular files, so a
  // symlinked package.json/plugin.json can never pull content from outside the package.
  if (knownFiles !== undefined && !knownFiles.has(relative)) {
    diagnostics.add(
      ERROR_CODES.ENTRY_MISSING,
      pointer(relative),
      `${relative} is not a regular file inside the package (missing, symlinked or not a file)`,
    );
    return null;
  }
  const absolute = path.join(root, ...relative.split('/'));
  // 纵深防御（DEF-10）：符号链接与硬链接已在树遍历阶段拒绝，这里再确认一次
  // "读到的路径确实解析在 realRoot 之内"，避免将来有人放宽树遍历时把包外内容读进来。
  try {
    const real = realpathSync(absolute);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (real !== root && !real.startsWith(prefix)) {
      diagnostics.add(
        ERROR_CODES.ENTRY_ESCAPE,
        pointer(relative),
        `${relative} resolves outside the plugin package root`,
      );
      return null;
    }
  } catch (error) {
    diagnostics.add(
      ERROR_CODES.ENTRY_MISSING,
      pointer(relative),
      `${relative} is missing or unreadable: ${describeError(error)}`,
    );
    return null;
  }
  let buffer;
  try {
    buffer = readFileSync(absolute);
  } catch (error) {
    diagnostics.add(
      ERROR_CODES.ENTRY_MISSING,
      pointer(relative),
      `${relative} is missing or unreadable: ${describeError(error)}`,
    );
    return null;
  }
  let text;
  try {
    text = decodeUtf8Strict(buffer, relative);
  } catch (error) {
    const code = error instanceof PluginCheckError ? error.code : ERROR_CODES.INVALID_UNICODE;
    diagnostics.add(code, pointer(relative), describeError(error));
    return null;
  }
  try {
    const value = parseStrictJson(text, { label: relative, maxBytes, maxDepth: 32 });
    return { value, bytes: buffer.length };
  } catch (error) {
    const code = error instanceof PluginCheckError ? error.code : ERROR_CODES.INVALID_JSON;
    diagnostics.add(code, pointer(relative), describeError(error));
    return null;
  }
}

function relativeImportsOf(module) {
  const directory = path.posix.dirname(module.path);
  const imports = [];
  for (const entry of module.specifiers) {
    if (typeof entry.specifier !== 'string') continue;
    if (!entry.specifier.startsWith('./') && !entry.specifier.startsWith('../')) continue;
    const resolved = path.posix.normalize(
      directory === '.' ? entry.specifier : path.posix.join(directory, entry.specifier),
    );
    if (!imports.includes(resolved)) imports.push(resolved);
  }
  return imports;
}

/**
 * Inspects an unpacked plugin directory without writing or executing anything.
 * @param {string} directory
 * @param {{profile?: object}} [options]
 * @returns {object}
 */
export function inspectPluginDirectory(directory, options = {}) {
  const profile = options?.profile ?? COMPATIBILITY_PROFILE;
  // A caller supplied profile must still be complete; a partial object would otherwise fail
  // later with a native TypeError or silently relax a limit.
  if (
    profile === null ||
    typeof profile !== 'object' ||
    typeof profile.api !== 'string' ||
    typeof profile.entry !== 'string' ||
    profile.limits === null ||
    typeof profile.limits !== 'object' ||
    !Number.isInteger(profile.limits.packageJsonBytes) ||
    !Number.isInteger(profile.limits.pluginJsonBytes) ||
    !Number.isInteger(profile.limits.sourceFiles)
  ) {
    throw new PluginCheckError(
      ERROR_CODES.INVALID_ARGUMENT,
      'options.profile must be a complete compatibility profile object',
    );
  }

  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new PluginCheckError(
      ERROR_CODES.INVALID_ARGUMENT,
      'inspectPluginDirectory expects a non-empty directory path string',
    );
  }

  const requested = path.resolve(directory);
  let stats;
  try {
    stats = lstatSync(requested);
  } catch (error) {
    throw new PluginCheckError(
      ERROR_CODES.IO_ERROR,
      `cannot stat "${requested}": ${describeError(error)}`,
    );
  }
  if (stats.isSymbolicLink()) {
    throw new PluginCheckError(
      ERROR_CODES.INVALID_ARGUMENT,
      `"${requested}" is a symbolic link; pass the real plugin directory`,
    );
  }
  if (!stats.isDirectory()) {
    throw new PluginCheckError(ERROR_CODES.INVALID_ARGUMENT, `"${requested}" is not a directory`);
  }

  let realRoot;
  try {
    realRoot = realpathSync(requested);
  } catch (error) {
    throw new PluginCheckError(
      ERROR_CODES.IO_ERROR,
      `cannot resolve "${requested}": ${describeError(error)}`,
    );
  }

  const diagnostics = createDiagnostics();
  const tree = walkPackageTree(realRoot, diagnostics);

  let packageSha256 = null;
  if (!tree.fatal) {
    try {
      packageSha256 = computePackageDigest(realRoot, tree.files);
    } catch (error) {
      diagnostics.add(
        ERROR_CODES.IO_ERROR,
        '',
        `cannot read the package tree: ${describeError(error)}`,
      );
    }
  }

  const packageDocument = readJsonDocument(
    realRoot,
    'package.json',
    profile.limits.packageJsonBytes,
    diagnostics,
    tree.files,
  );
  const packageInfo = packageDocument
    ? validatePackageJson(packageDocument.value, { diagnostics })
    : null;

  const pluginDocument = readJsonDocument(
    realRoot,
    'plugin.json',
    profile.limits.pluginJsonBytes,
    diagnostics,
    tree.files,
  );
  const pluginResult = pluginDocument
    ? validatePluginJson(pluginDocument.value, { diagnostics })
    : { manifest: null, toolFullNames: [] };
  const manifest = pluginResult.manifest;

  let manifestSha256 = null;
  if (pluginDocument !== null) {
    try {
      manifestSha256 = digestOf(pluginDocument.value);
    } catch (error) {
      diagnostics.add(
        ERROR_CODES.INVALID_VALUE,
        '/plugin.json',
        `cannot canonicalise plugin.json: ${describeError(error)}`,
      );
    }
  }

  if (packageInfo !== null && manifest !== null) {
    if (packageInfo.main !== null && packageInfo.main !== manifest.entry) {
      diagnostics.add(
        ERROR_CODES.ENTRY_MISMATCH,
        '/main',
        `package.json "main" ("${packageInfo.main}") must equal plugin.json entry ("${manifest.entry}")`,
      );
    }
    const expectedExport = `./${manifest.entry}`;
    if (packageInfo.exportsDefault !== null && packageInfo.exportsDefault !== expectedExport) {
      diagnostics.add(
        ERROR_CODES.ENTRY_MISMATCH,
        '/exports/./default',
        `exports["."].default must equal "${expectedExport}"`,
      );
    }
    // package.json "name" is npm metadata (often a scoped name such as "@scope/pkg") and is
    // not required to equal the reverse DNS plugin id; the plugin identity is plugin.json.id.
    if (
      packageInfo.version !== null &&
      manifest.version !== null &&
      packageInfo.version !== manifest.version
    ) {
      diagnostics.add(
        ERROR_CODES.INVALID_VALUE,
        '/version',
        `package.json version ("${packageInfo.version}") must equal plugin.json version ("${manifest.version}")`,
      );
    }
  }

  let entry = null;
  /** @type {Array<{path: string, sha256: string, bytes: number, imports: string[]}>} */
  let modules = [];

  if (manifest !== null) {
    const entryPath = manifest.entry;
    if (!tree.files.has(entryPath)) {
      diagnostics.add(
        ERROR_CODES.ENTRY_MISSING,
        pointer(entryPath),
        `entry "${entryPath}" is not present in the package as a regular file`,
      );
    } else {
      const entryAbsolute = path.join(realRoot, ...entryPath.split('/'));
      let escaped = false;
      try {
        const realEntry = realpathSync(entryAbsolute);
        const prefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
        if (!realEntry.startsWith(prefix)) escaped = true;
      } catch (error) {
        diagnostics.add(
          ERROR_CODES.IO_ERROR,
          pointer(entryPath),
          `cannot resolve entry "${entryPath}": ${describeError(error)}`,
        );
        escaped = true;
      }

      if (escaped) {
        diagnostics.add(
          ERROR_CODES.ENTRY_ESCAPE,
          pointer(entryPath),
          `entry "${entryPath}" resolves outside the plugin package root`,
        );
      } else {
        let entryBytes = null;
        try {
          entryBytes = readFileSync(entryAbsolute);
        } catch (error) {
          diagnostics.add(
            ERROR_CODES.IO_ERROR,
            pointer(entryPath),
            `cannot read entry "${entryPath}": ${describeError(error)}`,
          );
        }
        if (entryBytes !== null) {
          entry = {
            path: entryPath,
            sha256: sha256Hex(entryBytes),
            bytes: entryBytes.length,
          };
          const graph = collectModuleGraph({
            packageRoot: realRoot,
            entryRelativePath: entryPath,
            readFile: (absolute) => {
              const relative = toRelative(realRoot, absolute);
              if (!tree.files.has(relative)) {
                throw new Error(`"${relative}" is not a regular file inside the package`);
              }
              return readFileSync(absolute);
            },
            diagnostics,
            profile,
          });
          modules = graph.modules.map((module) => ({
            path: module.path,
            sha256: module.sha256,
            bytes: module.bytes,
            imports: relativeImportsOf(module),
          }));
        }
      }
    }
  }

  const listedDiagnostics = diagnostics.list();
  const incompatibilities = [];
  for (const item of listedDiagnostics) {
    if (!INCOMPATIBILITY_CODES.has(item.code)) continue;
    incompatibilities.push({ code: item.code, detail: item.message });
  }

  return {
    ok: listedDiagnostics.length === 0,
    directory: realRoot,
    pluginId: manifest?.id ?? null,
    version: manifest?.version ?? null,
    name: manifest?.name ?? null,
    publisher: manifest?.publisher ?? null,
    license: manifest?.license ?? null,
    api: manifest?.api ?? null,
    engine: {
      dsh: profile.dsh,
      cordis: profile.cordis,
      node: profile.nodeEngine,
    },
    entry,
    digests: {
      manifestSha256,
      packageSha256,
    },
    // The exact document the manifest digest was taken from. Approval records must store this
    // object (not the normalised manifest, which gains defaults such as the tool timeout) so
    // that the record stays self consistent for `validateOverlay`.
    manifestDocument: pluginDocument?.value ?? null,
    // Declared runtime dependencies are surfaced for the operator, but installing and hashing
    // them is out of scope here; dependency lock enforcement belongs to the install stage.
    dependencies: packageInfo?.dependencies ?? {},
    permissions: manifest?.permissions ? [...manifest.permissions] : [],
    tools: (manifest?.tools ?? []).map((tool) => ({
      name: tool.name,
      fullName: toolFullName(manifest.id, tool.name),
      timeoutMs: tool.timeoutMs,
    })),
    prompt: manifest?.prompt
      ? {
          role: manifest.prompt.role,
          position: manifest.prompt.position,
          bytes: Buffer.byteLength(manifest.prompt.text, 'utf8'),
        }
      : null,
    modules,
    incompatibilities,
    diagnostics: listedDiagnostics,
    // `ok` is a compatibility verdict only. Isolation of the extension process is the security
    // boundary; a pass here must never be treated as permission to load or run the package.
    staticScanOnly: true,
    sideEffects: SIDE_EFFECTS,
  };
}
