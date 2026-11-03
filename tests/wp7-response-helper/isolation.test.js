/**
 * Isolation: the helper must have no way to reach the operating system.
 *
 * A dry-run guarantee that lives only in the code review is not a guarantee. This
 * suite reads the actual sources and fails if any of them:
 *
 *   - imports a module that can touch a process, socket, filesystem or thread;
 *   - imports anything except a sibling module, `response-policy` or `contracts`;
 *   - calls a spawn/exec/fork primitive;
 *   - or names a platform command (`taskkill`, `netsh`, `iptables`, …) as a string,
 *     which is the shape a command would have to take to reach a shell.
 *
 * The scan is intentionally dumb and textual. A cleverer analysis would also be a
 * thing to get wrong; "no import of `node:fs`, anywhere, ever" is not.
 *
 * P1-2: scanning `apps/response-helper` alone was not enough. The helper's
 * "no side effect" claim also depends on everything it *reaches*: one
 * `import 'node:fs'` inside `packages/response-policy` would have given the helper
 * a filesystem path while this suite stayed green, because the dependency tree was
 * only ever *allowed*, never *read*. `describe('isolation: transitive closure')`
 * therefore resolves the real import graph from the helper's own entry point and
 * applies the same rules to every module in it.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const HELPER_ROOT = join(REPO_ROOT, 'apps', 'response-helper');
const POLICY_ROOT = join(REPO_ROOT, 'packages', 'response-policy');
const CONTRACTS_ROOT = join(REPO_ROOT, 'packages', 'contracts');
const TESTS_ROOT = HERE;

/** Modules that would give the helper an OS side effect, directly or indirectly. */
const FORBIDDEN_MODULES = Object.freeze([
  'fs',
  'fs/promises',
  'node:fs',
  'node:fs/promises',
  'child_process',
  'node:child_process',
  'net',
  'node:net',
  'dgram',
  'node:dgram',
  'http',
  'node:http',
  'https',
  'node:https',
  'os',
  'node:os',
  'cluster',
  'node:cluster',
  'worker_threads',
  'node:worker_threads',
  'vm',
  'node:vm',
  'repl',
  'node:repl',
  'v8',
  'node:v8',
  'module',
  'node:module',
]);

/** Modules the helper may import: siblings, the policy package, the contracts. */
const ALLOWED_BARE = Object.freeze(['@aegisharness/contracts']);

/**
 * Builtin modules the reachable dependency closure may use.
 *
 * Closed on purpose. `node:crypto` is the one the contracts need (canonical
 * digests); anything else appearing here is a new capability and must be argued
 * for, not silently added to an allowlist.
 */
const ALLOWED_BUILTINS = Object.freeze(['node:crypto']);

/** Bare package specifiers the closure may reach, mapped to their package roots. */
const PACKAGE_ENTRY_POINTS = Object.freeze({
  '@aegisharness/contracts': CONTRACTS_ROOT,
  '@aegisharness/response-policy': POLICY_ROOT,
});

/** Primitive call shapes that would mean "run something". */
const FORBIDDEN_CALLS = Object.freeze([
  '.spawn(',
  '.spawnSync(',
  '.exec(',
  '.execSync(',
  '.execFile(',
  '.execFileSync(',
  '.fork(',
  'process.kill(',
  'process.abort(',
  'process.exit(',
  'process.binding(',
  'process.dlopen(',
  'eval(',
  'new Function(',
  'globalThis.process',
]);

/**
 * Primitive call shapes that would mean "run something" in the dependency closure.
 *
 * Same list as {@link FORBIDDEN_CALLS} minus the bare `.exec(`. `RegExp.prototype
 * .exec` and `ChildProcess.exec` are textually identical, and the closure does use
 * the former (`response-policy/src/time.js` matches an RFC3339 pattern with it).
 * Excluding it is only safe because the real boundary — "no module that can spawn
 * anything is imported, and no dynamic import/require exists" — is checked
 * separately and unconditionally; `describe` below also asserts that every
 * remaining `.exec(` in the closure sits in a file that declares a regex literal.
 */
const CLOSURE_FORBIDDEN_CALLS = Object.freeze(
  FORBIDDEN_CALLS.filter((token) => token !== '.exec('),
);

/** Marks a file as doing regex work rather than process work. */
const REGEX_LITERAL = /(?:^|[=(,:[\s])\/(?:[^/\n\\]|\\.)+\/[gimsuy]*/u;

/** Platform commands, quoted — the only form in which one could reach an API. */
const FORBIDDEN_COMMANDS = Object.freeze([
  'taskkill',
  'Stop-Process',
  'netsh',
  'iptables',
  'ip6tables',
  'nft',
  'systemctl',
  'pkill',
  'killall',
  'schtasks',
  'sc.exe',
  'shutdown',
  'reg delete',
  'rm -rf',
  'del /f',
]);

/**
 * Every `.js` file under a directory.
 *
 * @param {string} root Directory.
 * @returns {string[]} Absolute paths.
 */
function listJsFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.cjs')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Remove comments before scanning for call shapes.
 *
 * JSDoc writes type references as `{import('./x.js').Foo}`, which is not a dynamic
 * import and cannot execute. Block comments and whole-line comments are dropped.
 *
 * Whole-line only, on purpose: an earlier version truncated each line from the
 * first `//`, so a source line such as `const p = "X//Y"; const m = await
 * import("node:fs");` would have hidden the import from every later check. A
 * scanner that can be blinded by a string is worse than no scanner.
 *
 * @param {string} source File contents.
 * @returns {string} Source with block and whole-line comments removed.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

/**
 * Static import specifiers in one source text.
 *
 * Runs on comment-stripped source: prose such as `indistinguishable from "the
 * check never ran"` otherwise parses as a bare import specifier and produces a
 * failure that has nothing to do with imports.
 *
 * @param {string} source File contents.
 * @returns {string[]} Specifiers.
 */
function importSpecifiers(source) {
  const code = stripComments(source);
  const specifiers = new Set();
  for (const match of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)) specifiers.add(match[1]);
  for (const match of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/gu)) specifiers.add(match[1]);
  return [...specifiers];
}

const SOURCE_FILES = listJsFiles(HELPER_ROOT).map((file) => ({
  file,
  relativePath: relative(REPO_ROOT, file).replaceAll('\\', '/'),
  source: readFileSync(file, 'utf8'),
}));

/**
 * The `exports['.']` entry file of one of the allowed packages.
 *
 * Read from `package.json` rather than hard-coded: if a package repoints its entry
 * (for example to a bundler-friendly file), the scan must follow it instead of
 * scanning a file the runtime no longer loads.
 *
 * @param {string} dir Package root.
 * @returns {string} Absolute entry path.
 */
function packageEntry(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const exported = manifest.exports === undefined ? undefined : manifest.exports['.'];
  const entry = typeof exported === 'string'
    ? exported
    : exported?.import ?? exported?.default;
  assert.equal(typeof entry, 'string', `${dir} must publish a single '.' export`);
  return join(dir, entry);
}

/**
 * Resolve one import specifier to a file, or `null` when it is not resolvable.
 *
 * @param {string} fromFile Importing file.
 * @param {string} specifier Import specifier.
 * @returns {string | null} Absolute path or `null`.
 */
function resolveSpecifier(fromFile, specifier) {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not this candidate; try the next one.
      }
    }
    return null;
  }
  const dir = PACKAGE_ENTRY_POINTS[specifier];
  return dir === undefined ? null : packageEntry(dir);
}

/**
 * Transitive import closure starting from the helper's entry point.
 *
 * @param {string[]} entries Absolute entry files.
 * @returns {Map<string, string>} Absolute path → source, in discovery order.
 */
function importClosure(entries) {
  const files = new Map();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    files.set(file, source);
    for (const specifier of importSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (target !== null) queue.push(target);
    }
  }
  return files;
}

/** Relative path helper for readable failure messages. */
function repoPath(file) {
  return relative(REPO_ROOT, file).replaceAll('\\', '/');
}

const CLOSURE = importClosure([join(HELPER_ROOT, 'index.js')]);
const CLOSURE_ENTRIES = [...CLOSURE].map(([file, source]) => ({
  file,
  relativePath: repoPath(file),
  source,
}));

/**
 * Every bare (non-relative) specifier in the closure, with the file that asked.
 *
 * @returns {{ specifier: string, from: string }[]} Specifiers.
 */
function closureBareSpecifiers() {
  const out = [];
  for (const entry of CLOSURE_ENTRIES) {
    for (const specifier of importSpecifiers(entry.source)) {
      if (specifier.startsWith('.')) continue;
      out.push({ specifier, from: entry.relativePath });
    }
  }
  return out;
}

/**
 * Forbidden-module violations in an arbitrary set of files.
 *
 * Factored out of the assertion so the same predicate can be pointed at a poisoned
 * copy of a dependency: that is the only way to prove the check would fire if
 * `response-policy` or `contracts` grew an `import 'node:fs'`, without editing a
 * package this task is not allowed to modify.
 *
 * @param {Map<string, string>} files Absolute path → source.
 * @returns {{ file: string, specifier: string }[]} Violations.
 */
function forbiddenImportsIn(files) {
  const out = [];
  for (const [file, source] of files) {
    for (const specifier of importSpecifiers(source)) {
      if (FORBIDDEN_MODULES.includes(specifier)) out.push({ file: repoPath(file), specifier });
    }
  }
  return out;
}

describe('isolation: helper sources', () => {
  it('has at least the expected modules, so the scan is not vacuous', () => {
    assert.ok(SOURCE_FILES.length >= 6, `expected >= 6 source files, found ${SOURCE_FILES.length}`);
    const names = SOURCE_FILES.map((entry) => entry.relativePath);
    for (const expected of [
      'apps/response-helper/index.js',
      'apps/response-helper/src/helper.js',
      'apps/response-helper/src/interface.js',
      'apps/response-helper/src/ports.js',
      'apps/response-helper/src/plan.js',
      'apps/response-helper/src/snapshot.js',
      'apps/response-helper/src/errors.js',
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  it('imports no module that can reach a process, socket, file or thread', () => {
    for (const entry of SOURCE_FILES) {
      for (const specifier of importSpecifiers(entry.source)) {
        assert.ok(
          !FORBIDDEN_MODULES.includes(specifier),
          `${entry.relativePath} imports forbidden module ${specifier}`,
        );
      }
    }
  });

  it('imports nothing outside its own tree, response-policy and contracts', () => {
    const helperRoot = HELPER_ROOT.replaceAll('\\', '/');
    const policyRoot = join(REPO_ROOT, 'packages', 'response-policy').replaceAll('\\', '/');
    for (const entry of SOURCE_FILES) {
      for (const specifier of importSpecifiers(entry.source)) {
        if (specifier.startsWith('.')) {
          assert.ok(
            specifier.includes('response-policy') || specifier.startsWith('./') || specifier.startsWith('../'),
            `${entry.relativePath} has an unexpected relative import ${specifier}`,
          );
          const resolved = resolve(dirname(entry.file), specifier).replaceAll('\\', '/');
          // Exact directory prefixes, not a substring: `../x/my-response-policy-thing`
          // would satisfy `includes('response-policy')`.
          assert.ok(
            resolved.startsWith(`${helperRoot}/`) || resolved.startsWith(`${policyRoot}/`),
            `${entry.relativePath} resolves ${specifier} outside the allowed trees`,
          );
          continue;
        }
        assert.ok(
          ALLOWED_BARE.includes(specifier),
          `${entry.relativePath} imports undeclared bare module ${specifier}`,
        );
      }
    }
  });

  it('contains no spawn/exec/fork call and no dynamic import', () => {
    for (const entry of SOURCE_FILES) {
      const code = stripComments(entry.source);
      for (const token of FORBIDDEN_CALLS) {
        assert.equal(
          code.includes(token),
          false,
          `${entry.relativePath} contains ${token}`,
        );
      }
      assert.equal(
        /\bimport\s*\(/u.test(code),
        false,
        `${entry.relativePath} uses a dynamic import`,
      );
      assert.equal(
        /\brequire\s*\(/u.test(code),
        false,
        `${entry.relativePath} uses require()`,
      );
    }
  });

  it('names no platform command that could be executed', () => {
    for (const entry of SOURCE_FILES) {
      for (const command of FORBIDDEN_COMMANDS) {
        for (const quote of ['"', "'", '`']) {
          const token = `${quote}${command}${quote}`;
          assert.equal(
            entry.source.toLowerCase().includes(token.toLowerCase()),
            false,
            `${entry.relativePath} contains the quoted command ${token}`,
          );
        }
      }
    }
  });

  it('does not mention a forbidden response action as an allowed one', () => {
    const helperSource = SOURCE_FILES
      .filter((entry) => entry.relativePath.endsWith('src/helper.js'))
      .map((entry) => entry.source)
      .join('\n');
    for (const forbidden of ['shell.exec', 'file.delete', 'process.terminate_all', 'network.flush_rules']) {
      assert.equal(
        helperSource.includes(`'${forbidden}'`),
        false,
        `helper allowlist must not contain ${forbidden}`,
      );
    }
  });
});

describe('isolation: transitive closure', () => {
  it('actually reads the dependency tree, so the scan is not vacuous', () => {
    // A closure that only found the helper's own files would pass every assertion
    // below while proving nothing about response-policy or contracts.
    assert.ok(
      CLOSURE.size >= 30,
      `expected >= 30 reachable modules, found ${CLOSURE.size}`,
    );
    const names = new Set(CLOSURE_ENTRIES.map((entry) => entry.relativePath));
    for (const expected of [
      'apps/response-helper/src/helper.js',
      'packages/response-policy/src/decision.js',
      'packages/response-policy/src/catalog.js',
      'packages/contracts/src/index.js',
      'packages/contracts/src/canonical.js',
      'packages/contracts/src/objects/execution-grant.js',
    ]) {
      assert.ok(names.has(expected), `closure is missing ${expected}`);
    }
    // The helper tree must be a subset of the closure: every source file it owns is
    // reachable from its own entry point, so nothing is shipped unexamined.
    for (const entry of SOURCE_FILES) {
      assert.ok(names.has(entry.relativePath), `${entry.relativePath} is not reachable from index.js`);
    }
  });

  it('keeps every reachable module inside the three allowed trees', () => {
    const allowed = [HELPER_ROOT, POLICY_ROOT, CONTRACTS_ROOT]
      .map((dir) => `${dir.replaceAll('\\', '/')}/`);
    for (const entry of CLOSURE_ENTRIES) {
      assert.ok(
        allowed.some((prefix) => entry.file.replaceAll('\\', '/').startsWith(prefix)),
        `${entry.relativePath} is outside the allowed trees`,
      );
    }
  });

  it('imports no OS-reaching module anywhere in the closure', () => {
    assert.deepEqual(forbiddenImportsIn(CLOSURE), []);
  });

  it('would catch a forbidden import added to a dependency', () => {
    // The exact failure mode P1-2 named: one `import 'node:fs'` in
    // `packages/response-policy` used to leave this suite green because the package
    // was allowed but never read. Point the same predicate at a poisoned copy of a
    // real dependency file and it must report that file.
    const timeFile = join(POLICY_ROOT, 'src', 'time.js');
    const poisoned = new Map([[
      timeFile,
      `${CLOSURE.get(timeFile)}\nimport { readFileSync } from 'node:fs';\n`,
    ]]);
    const violations = forbiddenImportsIn(poisoned);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].specifier, 'node:fs');
    assert.equal(violations[0].file, 'packages/response-policy/src/time.js');
  });

  it('keeps the set of bare specifiers in the closure closed', () => {
    const seen = new Set(closureBareSpecifiers().map((entry) => entry.specifier));
    const unexpected = [...seen].filter(
      (specifier) => !ALLOWED_BUILTINS.includes(specifier) && !(specifier in PACKAGE_ENTRY_POINTS),
    );
    assert.deepEqual(unexpected, [], `unexpected bare imports: ${unexpected.join(', ')}`);
    // Pinned exactly: adding a builtin (fs, net, child_process, os, worker_threads,
    // …) has to fail here first, not slip in behind an allowlist. The helper reaches
    // `response-policy` by relative path, so it does not appear as a bare specifier.
    assert.deepEqual([...seen].sort(), ['@aegisharness/contracts', 'node:crypto']);
  });

  it('contains no spawn/exec/fork primitive or dynamic import in the closure', () => {
    for (const entry of CLOSURE_ENTRIES) {
      const code = stripComments(entry.source);
      for (const token of CLOSURE_FORBIDDEN_CALLS) {
        assert.equal(code.includes(token), false, `${entry.relativePath} contains ${token}`);
      }
      assert.equal(/\bimport\s*\(/u.test(code), false, `${entry.relativePath} uses a dynamic import`);
      assert.equal(/\brequire\s*\(/u.test(code), false, `${entry.relativePath} uses require()`);
    }
  });

  it('keeps every remaining .exec( inside a file that also does regex work', () => {
    // `.exec(` is not on the closure list because `RegExp.prototype.exec` is legal
    // and present. This is the narrower rule that keeps the exemption from becoming
    // a hole: a newly added `cp.exec('whoami')` in a regex-free file fails here.
    for (const entry of CLOSURE_ENTRIES) {
      const code = stripComments(entry.source);
      if (!code.includes('.exec(')) continue;
      assert.ok(
        REGEX_LITERAL.test(code) || code.includes('new RegExp('),
        `${entry.relativePath} calls .exec( without any regex in the same file`,
      );
    }
  });

  it('names no platform command anywhere in the closure', () => {
    for (const entry of CLOSURE_ENTRIES) {
      for (const command of FORBIDDEN_COMMANDS) {
        for (const quote of ['"', "'", '`']) {
          const token = `${quote}${command}${quote}`;
          assert.equal(
            entry.source.toLowerCase().includes(token.toLowerCase()),
            false,
            `${entry.relativePath} contains the quoted command ${token}`,
          );
        }
      }
    }
  });

  it('registers the closure scanner against sources it would have to catch', () => {
    // Meta-check: the same predicates applied to a synthetic offending source must
    // fail. Without this, a refactor could neuter the scanner and every assertion
    // above would still be green, because today's closure happens to be clean.
    const synthetic = [
      "import { readFileSync } from 'node:fs';",
      "import cp from 'node:child_process';",
      "cp.exec('whoami');",
      "const args = ['taskkill'];",
      '',
    ].join('\n');
    assert.deepEqual(importSpecifiers(synthetic), ['node:fs', 'node:child_process']);
    for (const specifier of importSpecifiers(synthetic)) {
      assert.ok(FORBIDDEN_MODULES.includes(specifier), `${specifier} must be forbidden`);
    }
    assert.ok(FORBIDDEN_CALLS.some((token) => stripComments(synthetic).includes(token)));
    assert.ok(FORBIDDEN_COMMANDS.some((command) => synthetic.includes(`'${command}'`)));
  });
});

describe('isolation: test sources', () => {
  const testFiles = listJsFiles(TESTS_ROOT).map((file) => ({
    file,
    name: relative(TESTS_ROOT, file).replaceAll('\\', '/'),
    source: readFileSync(file, 'utf8'),
  }));

  it('uses no process, network or child-process API outside this scanner', () => {
    for (const entry of testFiles) {
      if (entry.name === 'isolation.test.js') continue;
      for (const specifier of importSpecifiers(entry.source)) {
        assert.ok(
          !['node:child_process', 'child_process', 'node:net', 'net', 'node:http', 'node:https'].includes(specifier),
          `${entry.name} imports ${specifier}; tests must use mocks`,
        );
      }
    }
  });

  it('touches the filesystem only from this scanner', () => {
    const other = testFiles.filter((entry) => entry.name !== 'isolation.test.js');
    for (const entry of other) {
      for (const specifier of importSpecifiers(entry.source)) {
        assert.ok(
          !['node:fs', 'fs', 'node:fs/promises'].includes(specifier),
          `${entry.name} imports ${specifier}; the helper tests must stay in memory`,
        );
      }
    }
  });
});
