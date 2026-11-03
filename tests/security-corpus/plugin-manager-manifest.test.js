// author: PT-dove
// M9 对抗语料 —— plugin-manager：严格 JSON、manifest、路径词法、包目录检查。
//
// 插件系统是唯一允许"第三方代码进入本机"的通道，所以这里的每条负向样本都对应
// 一个真实的越权路径：坏 manifest 想多要权限、路径想穿越出包、符号链接想把
// 包外的文件当自己的、JSON 文本想用重复键或超范围数字让"批准"与"运行"看到不同内容。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ERROR_CODES,
  PluginCheckError,
  assertSafeRelativePath,
  createDiagnostics,
  inspectPluginDirectory,
  parseStrictJson,
  validatePackageJson,
  validatePluginJson,
} from '../../apps/plugin-manager/src/index.js';
import {
  INVALID_PLUGIN_IDS,
  UNSAFE_ENTRY_PATHS,
} from './support/corpus.js';
import { createSandbox, escapeForMessage, expectRejection } from './support/harness.js';
import {
  PLUGIN_ENTRY,
  PLUGIN_ENTRY_SOURCE,
  pluginManifest,
  pluginPackageJson,
  writePluginDirectory,
} from './support/fixtures.js';

/** 收集诊断而不是抛错：manifest 校验的设计是"内容问题进诊断"。 */
function diagnose(manifest) {
  const diagnostics = createDiagnostics();
  const result = validatePluginJson(manifest, { diagnostics });
  return { ...result, diagnostics: diagnostics.list() };
}

function codesOf(list) {
  return list.map((entry) => entry.code);
}

// ---------------------------------------------------------------- 严格 JSON

test('plugin JSON：重复键、深嵌套、非有限数一律拒绝', () => {
  const cases = [
    { text: '{"a":1,"a":2}', code: ERROR_CODES.DUPLICATE_KEY },
    { text: `{"a":{"b":1,"b":2}}`, code: ERROR_CODES.DUPLICATE_KEY },
    { text: `${'['.repeat(40)}${']'.repeat(40)}`, code: ERROR_CODES.LIMIT_EXCEEDED },
    { text: '1e400', code: ERROR_CODES.INVALID_JSON },
    { text: '-1e400', code: ERROR_CODES.INVALID_JSON },
    { text: '{"a":01}', code: ERROR_CODES.INVALID_JSON },
    { text: '{"a":1,}', code: ERROR_CODES.INVALID_JSON },
    { text: '{"a":1}//c', code: ERROR_CODES.INVALID_JSON },
    { text: '{"a":1}{"b":2}', code: ERROR_CODES.INVALID_JSON },
    { text: '{"a":"\\ud800"}', code: ERROR_CODES.INVALID_UNICODE },
    { text: '{"a":"\\udc00"}', code: ERROR_CODES.INVALID_UNICODE },
    { text: `{"a":"x${String.fromCharCode(0xd800)}y"}`, code: ERROR_CODES.INVALID_UNICODE },
    { text: '{"a":"x\u0001y"}', code: ERROR_CODES.INVALID_JSON },
    { text: '{"a":"\\q"}', code: ERROR_CODES.INVALID_JSON },
    { text: '{"a":}', code: ERROR_CODES.INVALID_JSON },
    { text: '{"a":1', code: ERROR_CODES.INVALID_JSON },
    { text: '{}', code: null },
  ];
  for (const entry of cases) {
    if (entry.code === null) {
      assert.deepEqual(parseStrictJson(entry.text), {});
      continue;
    }
    expectRejection(() => parseStrictJson(entry.text), {
      code: entry.code,
      type: PluginCheckError,
      label: escapeForMessage(entry.text),
    });
  }
});

test('plugin JSON：字节上限与非法 UTF-8 在解析前拦下', () => {
  expectRejection(() => parseStrictJson(`{"a":"${'x'.repeat(70000)}"}`), {
    code: ERROR_CODES.LIMIT_EXCEEDED,
    type: PluginCheckError,
  });
  expectRejection(() => parseStrictJson('{"a":1}', { maxBytes: 4 }), {
    code: ERROR_CODES.LIMIT_EXCEEDED,
    type: PluginCheckError,
  });
  // 非字符串输入是参数错误，不是内容错误。
  expectRejection(() => parseStrictJson(Buffer.from('{"a":1}')), {
    code: ERROR_CODES.INVALID_ARGUMENT,
    type: PluginCheckError,
  });
});

test('plugin JSON：__proto__ 只作为自有键存在，不改变原型', () => {
  const parsed = parseStrictJson('{"__proto__":{"polluted":true},"a":1}');
  assert.deepEqual(Object.keys(parsed).sort(), ['__proto__', 'a']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  // 关键：它必须是**自有**属性，否则规范化会静默丢掉这段内容。
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), true);
  assert.equal(Object.prototype.propertyIsEnumerable.call(parsed, '__proto__'), true);
});

test('DEF-05（修复后）：超出安全整数的字面量被拒绝，不再静默取整', () => {
  // contracts 的 parseStrictJson 用 BigInt 校验"字面量 == 双精度值"；修复前 plugin-manager
  // 只用 Number()，于是 2^53+1 与 2^53 得到同一个值、同一个 JCS 摘要 ——
  // "批准一个、运行另一个"成立。修复后两边的策略一致。
  expectRejection(() => parseStrictJson('9007199254740993'), {
    code: ERROR_CODES.INVALID_JSON,
    type: PluginCheckError,
    label: '2^53+1 literal',
  });
  expectRejection(() => parseStrictJson('{"config":{"maxItems":9007199254740993}}'), {
    code: ERROR_CODES.INVALID_JSON,
    type: PluginCheckError,
    label: '2^53+1 nested in config',
  });
  // 2^53 本身也不可安全表示（MAX_SAFE_INTEGER = 2^53-1）；contracts 同样拒绝。
  expectRejection(() => parseStrictJson('9007199254740992'), {
    code: ERROR_CODES.INVALID_JSON,
    type: PluginCheckError,
    label: '2^53 literal',
  });

  // 对照：可精确表示的上界仍必须被接受 —— 拒绝的是"取整"，不是"大数"。
  assert.equal(parseStrictJson('9007199254740991'), 9007199254740991);
  assert.equal(parseStrictJson('{"config":{"maxItems":9007199254740991}}').config.maxItems, 9007199254740991);
});

test('plugin JSON：DEL 与 C1 控制符在字符串里被接受（记录：DEF-05 的同类面）', () => {
  // 0x7F 与 0x80-0x9F 不是"原始控制字符"（<0x20），解析器放行；
  // 上层只有 name/description/prompt 会再查一次 CONTROL_CHARACTERS，
  // config / configSchema 里的字符串不会被检查。
  assert.equal(parseStrictJson('"a\u007fb"'), 'a\u007fb');
  assert.equal(parseStrictJson('"a\u009fb"'), 'a\u009fb');
});

// ---------------------------------------------------------------- manifest

for (const entry of INVALID_PLUGIN_IDS) {
  test(`非法插件 id 被拒绝：${entry.id}（${entry.note}）`, () => {
    const result = diagnose(pluginManifest({ id: entry.value }));
    assert.equal(result.manifest, null);
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.INVALID_VALUE),
      `expected INVALID_VALUE for ${escapeForMessage(entry.value)}, got ${codesOf(result.diagnostics).join(',')}`,
    );
  });
}

test('manifest 未知字段被拒绝（封闭对象，不能偷偷加字段）', () => {
  const result = diagnose({ ...pluginManifest(), capabilities: ['shell'] });
  assert.equal(result.manifest, null);
  assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.UNKNOWN_FIELD));
});

test('manifest 缺必需字段被逐项报告', () => {
  const result = diagnose({ schemaVersion: '1.0' });
  assert.equal(result.manifest, null);
  const codes = codesOf(result.diagnostics);
  assert.ok(codes.filter((code) => code === ERROR_CODES.MISSING_FIELD).length >= 6);
});

test('manifest 的 schemaVersion / api / engine 必须精确匹配', () => {
  for (const overrides of [
    { schemaVersion: '2.0' },
    { api: 'aegis-extension-v2' },
    { engine: { dsh: '0.3.0' } },
    { engine: { dsh: '0.2.2-alpha.2', cordis: '1.0.0' } },
    { engine: {} },
  ]) {
    const result = diagnose(pluginManifest(overrides));
    assert.equal(result.manifest, null, JSON.stringify(overrides));
  }
});

test('version 必须是严格 semver（前导零、缺段、范围符都拒绝）', () => {
  for (const version of ['1.0', '1.0.0.0', '01.0.0', 'v1.0.0', '^1.0.0', '1.0.0-', '']) {
    const result = diagnose(pluginManifest({ version }));
    assert.equal(result.manifest, null, `${version} must be rejected`);
  }
  assert.equal(diagnose(pluginManifest({ version: '1.0.0-beta.1' })).manifest.version, '1.0.0-beta.1');
});

test('name / description 里的控制字符与首尾空白被拒绝', () => {
  for (const name of [' leading', 'trailing ', 'nul\u0000name', 'del\u007fname']) {
    const result = diagnose(pluginManifest({ name }));
    assert.equal(result.manifest, null, escapeForMessage(name));
  }
  const result = diagnose(pluginManifest({ description: 'line\nbreak' }));
  assert.equal(result.manifest, null);
});

for (const entry of UNSAFE_ENTRY_PATHS) {
  test(`不安全的 entry 路径被拒绝：${entry.id}（${entry.note}）`, () => {
    expectRejection(() => assertSafeRelativePath(entry.path), {
      code: ERROR_CODES.ENTRY_PATH_UNSAFE,
      type: PluginCheckError,
      label: entry.id,
    });
  });
}

test('entry 必须是固定入口（不同位置是 ENTRY_MISMATCH，穿越才是 ENTRY_PATH_UNSAFE）', () => {
  const mismatch = diagnose(pluginManifest({ entry: 'dist/index.js' }));
  assert.equal(mismatch.manifest, null);
  assert.ok(codesOf(mismatch.diagnostics).includes(ERROR_CODES.ENTRY_MISMATCH));

  const unsafe = diagnose(pluginManifest({ entry: '../lib/index.js' }));
  assert.equal(unsafe.manifest, null);
  assert.ok(codesOf(unsafe.diagnostics).includes(ERROR_CODES.ENTRY_PATH_UNSAFE));
});

test('权限：未知权限、重复权限、非字符串、超量都被拒绝', () => {
  for (const permissions of [
    ['analysis.shell.exec'],
    ['analysis.dto.read', 'analysis.dto.read'],
    ['analysis.dto.read', 42],
    ['analysis.dto.read', 'analysis.tool.register', 'analysis.prompt.contribute', 'analysis.event.subscribe', 'analysis.report.render', 'session.scratch.write', 'analysis.dto.read'],
  ]) {
    const result = diagnose(pluginManifest({ permissions }));
    assert.equal(result.manifest, null, JSON.stringify(permissions));
  }
});

test('跨字段规则：声明工具必须同时申请 analysis.tool.register', () => {
  const tool = {
    name: 'lookup',
    description: 'lookup a value',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: { type: 'object', additionalProperties: false, properties: {} },
  };
  const withoutPermission = diagnose(pluginManifest({ tools: [tool] }));
  assert.equal(withoutPermission.manifest, null);
  assert.ok(codesOf(withoutPermission.diagnostics).includes(ERROR_CODES.PERMISSION_CONFLICT));

  const withPermission = diagnose(pluginManifest({ permissions: ['analysis.tool.register'], tools: [tool] }));
  assert.notEqual(withPermission.manifest, null);
  assert.deepEqual(withPermission.toolFullNames, ['plugin.com.example.anomaly-notes.lookup']);
});

test('工具名 / 描述 / 超时 / schema 的边界', () => {
  const base = {
    name: 'lookup',
    description: 'ok',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: { type: 'object', additionalProperties: false, properties: {} },
  };
  const withTool = (overrides) => diagnose(pluginManifest({
    permissions: ['analysis.tool.register'],
    tools: [{ ...base, ...overrides }],
  }));
  assert.equal(withTool({}).manifest === null, false);
  assert.equal(withTool({ name: 'Lookup' }).manifest, null, 'uppercase tool name');
  assert.equal(withTool({ name: '1lookup' }).manifest, null, 'digit first');
  assert.equal(withTool({ name: 'a'.repeat(32) }).manifest, null, 'tool name too long');
  assert.equal(withTool({ timeoutMs: 0 }).manifest, null);
  assert.equal(withTool({ timeoutMs: 999999 }).manifest, null);
  assert.equal(withTool({ timeoutMs: 1.5 }).manifest, null);
  assert.equal(withTool({ inputSchema: { type: 'object', $ref: 'http://evil.example/schema.json' } }).manifest, null, 'remote $ref');
  assert.equal(withTool({ inputSchema: { type: 'object', patternProperties: {} } }).manifest, null, 'unsupported keyword');
});

test('prompt：role 只能是 user、position 固定、文本不得含控制符', () => {
  const prompt = (overrides) => diagnose(pluginManifest({
    permissions: ['analysis.prompt.contribute'],
    prompt: { role: 'user', position: 'analysis-context', text: 'consider this', ...overrides },
  }));
  assert.notEqual(prompt({}).manifest, null);
  assert.equal(prompt({ role: 'system' }).manifest, null, 'plugin text must never enter the system role');
  assert.equal(prompt({ position: 'system-prompt' }).manifest, null);
  assert.equal(prompt({ text: 'x\u001by' }).manifest, null);
  assert.equal(prompt({ text: 'x'.repeat(5000) }).manifest, null);
  assert.equal(prompt({ text: '' }).manifest, null);
});

test('configSchema：根必须是 object，且只能使用白名单关键字', () => {
  const withSchema = (configSchema) => diagnose(pluginManifest({ configSchema }));
  assert.notEqual(withSchema({ type: 'object', properties: {}, additionalProperties: false }).manifest, null);
  assert.equal(withSchema({ type: 'array' }).manifest, null);
  assert.equal(withSchema({ type: 'object', $ref: '#' }).manifest, null);
  assert.equal(withSchema({ type: 'object', anyOf: [] }).manifest, null);
});

// ---------------------------------------------------------------- package.json

test('package.json：禁止字段（scripts/bin/imports）与未知字段都被报告', () => {
  const diagnostics = createDiagnostics();
  validatePackageJson(
    { ...pluginPackageJson(), type: 'commonjs', scripts: { postinstall: 'node x.js' }, bin: { x: 'x.js' }, imports: {} },
    { diagnostics },
  );
  const codes = diagnostics.list().map((entry) => entry.code);
  assert.ok(codes.includes(ERROR_CODES.MODULE_TYPE_INVALID), 'plugins must be ESM');
  assert.ok(codes.includes(ERROR_CODES.INVALID_VALUE), 'scripts / bin / imports are forbidden, not merely unknown');

  const unknown = createDiagnostics();
  validatePackageJson({ ...pluginPackageJson(), workspaces: ['packages/*'] }, { diagnostics: unknown });
  assert.ok(unknown.list().some((entry) => entry.code === ERROR_CODES.INVALID_VALUE));

  const reallyUnknown = createDiagnostics();
  validatePackageJson({ ...pluginPackageJson(), mystery: true }, { diagnostics: reallyUnknown });
  assert.ok(reallyUnknown.list().some((entry) => entry.code === ERROR_CODES.UNKNOWN_FIELD));
});

test('package.json：cordis peer 依赖必须精确声明', () => {
  const diagnostics = createDiagnostics();
  validatePackageJson({ ...pluginPackageJson(), peerDependencies: {} }, { diagnostics });
  assert.ok(diagnostics.list().some((entry) => entry.code === ERROR_CODES.CORDIS_MISMATCH));
});

test('package.json：exports 必须精确指向入口', () => {
  const diagnostics = createDiagnostics();
  validatePackageJson(
    { name: 'x', version: '1.0.0', type: 'module', main: PLUGIN_ENTRY, exports: { '.': { default: './other.js' } } },
    { diagnostics },
  );
  assert.ok(diagnostics.list().some((entry) => entry.code === ERROR_CODES.ENTRY_MISMATCH));
});

// ---------------------------------------------------------------- 目录检查（符号链接）

test('包内符号链接目录被拒绝（PACKAGE_SYMLINK）', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const directory = writePluginDirectory(sandbox);
  const outside = sandbox.mkdir('outside');
  // Windows 上普通用户无法创建文件符号链接，但可以创建目录 junction；
  // Node 的 lstat 对 junction 同样报 isSymbolicLink()。
  symlinkSync(outside, join(directory, 'linked'), 'junction');

  const report = inspectPluginDirectory(directory);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === ERROR_CODES.PACKAGE_SYMLINK));
  assert.equal(report.staticScanOnly, true);
  assert.deepEqual(report.sideEffects, { writes: 0, executedPluginCode: false, staged: false });
});

test('★ 缺陷 DEF-10 已修复：包内 package.json 是包外硬链接时被拒绝（PACKAGE_HARDLINK）', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const directory = sandbox.mkdir('plugin');
  sandbox.write('plugin/plugin.json', JSON.stringify(pluginManifest(), null, 2));
  sandbox.write(`plugin/${PLUGIN_ENTRY}`, PLUGIN_ENTRY_SOURCE);
  // 包外放一份"看起来合法"的 package.json，然后用硬链接把它挂进包内。
  // 硬链接不是符号链接：`lstat()` 看到的是普通文件，树遍历因此曾经放行。
  const outsideFile = sandbox.write('outside-package.json', JSON.stringify(pluginPackageJson(), null, 2));
  linkSync(outsideFile, join(directory, 'package.json'));

  // 旧断言（修复前）：`report.ok === true` 且 `diagnostics` 为空 —— 包外内容被当作包内
  // package.json 接受。这等于把"包的身份"绑在路径而不是 inode 上：能写包外那份文件的一方
  // 可以在批准之后换掉 package.json，而包内看到的仍是"普通文件"。
  // 修复后：树遍历对每个普通文件检查 `nlink > 1`，命中即 `PACKAGE_HARDLINK` 且 fatal——
  // 不产出摘要，不进入后续比对。
  const report = inspectPluginDirectory(directory);
  assert.equal(report.ok, false, 'a hard-linked package.json must be refused');
  const codes = report.diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes(ERROR_CODES.PACKAGE_HARDLINK),
    `expected PACKAGE_HARDLINK, got ${codes.length === 0 ? '(nothing)' : codes.join(',')}`,
  );
  const hardlink = report.diagnostics.find((entry) => entry.code === ERROR_CODES.PACKAGE_HARDLINK);
  assert.match(hardlink.message, /hard link/u);

  // 没有包摘要：一旦产出 `packageSha256`，调用方就可能拿它去认一个"包外可变"的内容。
  // 实测被拒时 `digests.packageSha256 === null`（树都没走完，不该有包级摘要）。
  // 注意同一文件还会附带一条 ENTRY_MISSING（M9-P3-CLEANUP 已登记为 P3 文案问题），
  // 本用例不对它断言——否则一次纯文案修复就会误伤门禁。
  assert.equal(report.digests.packageSha256, null, 'a refused package must not get a package digest');
  assert.equal(report.staticScanOnly, true);
  assert.deepEqual(report.sideEffects, { writes: 0, executedPluginCode: false, staged: false });

  // 负向对照：同样的内容做成普通文件（不硬链接）必须通过。
  // 证明拒绝的是"inode 可被包外改写"，不是"包里不该有 package.json"。
  const clean = createSandbox();
  t.after(() => clean.cleanup());
  const cleanReport = inspectPluginDirectory(writePluginDirectory(clean));
  assert.equal(cleanReport.ok, true, `a plain package must pass; diagnostics: ${JSON.stringify(cleanReport.diagnostics)}`);
  assert.equal(
    cleanReport.diagnostics.some((entry) => entry.code === ERROR_CODES.PACKAGE_HARDLINK),
    false,
    'a plain file must not be flagged as a hard link',
  );
  assert.match(
    cleanReport.digests.packageSha256,
    /^[0-9a-f]{64}$/u,
    'a clean package must still produce a real package digest',
  );
});

test('传入的目录本身是符号链接时直接拒绝（不做 realpath 后继续）', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const real = writePluginDirectory(sandbox);
  const link = join(sandbox.root, 'plugin-link');
  symlinkSync(real, link, 'junction');

  let captured = null;
  try {
    inspectPluginDirectory(link);
  } catch (error) {
    captured = error;
  }
  assert.notEqual(captured, null, 'a symlinked root must not be silently resolved');
  assert.equal(captured.code, ERROR_CODES.INVALID_ARGUMENT);
  assert.match(captured.message, /symbolic link/iu);
});

test('包内出现非普通文件（管道）被拒绝：ENTRY_NOT_REGULAR', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const directory = writePluginDirectory(sandbox);
  if (process.platform !== 'linux') {
    // 命名管道是 POSIX 概念，Windows 上没有等价的可移植构造；这里只在
    // 干净包上断言"检查器本身是可用的"，避免用一条永远为真的断言冒充覆盖。
    const report = inspectPluginDirectory(directory);
    assert.equal(report.ok, true, `a clean package must pass; diagnostics: ${JSON.stringify(report.diagnostics)}`);
    return;
  }
  execFileSync('mkfifo', [join(directory, 'pipe')]);
  const report = inspectPluginDirectory(directory);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === ERROR_CODES.ENTRY_NOT_REGULAR));
});

test('入口缺失 / 入口不是 .js / 模块图缺失都被报告', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const directory = writePluginDirectory(sandbox, {
    entrySource: 'import x from "./missing.js";\nexport function apply() {}\n',
  });
  const report = inspectPluginDirectory(directory);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === ERROR_CODES.ENTRY_MISSING));
});
