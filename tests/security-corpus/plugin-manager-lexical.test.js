// author: PT-dove
// M9 对抗语料 —— 插件源码词法扫描 + overlay 扩权。
//
// 词法扫描是**静态卫生检查**，不是安全边界（README 与 inspect.js 都写明了隔离才是边界）。
// 因此这里既断言"该报的必须报"，也断言"不该报的不能报"——一个见词就报的扫描器会让
// 正常插件无法安装，同样是一种失效。
//
// overlay 部分对应 AT-PLG-002：安全投影（permissions / tools / prompt / runtime）只能
// 来自被批准的 plugin.json，overlay 只能改 config。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ERROR_CODES,
  createDiagnostics,
  deriveSecurityProjection,
  digestOf,
  scanModuleSource,
  validateOverlay,
} from '../../apps/plugin-manager/src/index.js';
import { LEXICAL_SOURCE_CASES } from './support/corpus.js';
import { escapeForMessage } from './support/harness.js';
import { pluginManifest } from './support/fixtures.js';

/** 扫描一段源码并把诊断压成 `code|pointer` 字符串列表。 */
function scan(source, file = 'lib/index.js') {
  const diagnostics = createDiagnostics();
  const result = scanModuleSource(source, { file, diagnostics, isEntry: true });
  return { result, diagnostics: diagnostics.list(), codes: diagnostics.list().map((entry) => entry.code) };
}

/** 建一条自洽的批准记录：manifest 与它的 JCS 摘要必须互相匹配。 */
function approvedRecord(manifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    manifestSha256: digestOf(manifest),
    packageSha256: 'c'.repeat(64),
    manifest,
  };
}

/** 构造一个"完全对齐被批准投影"的 overlay 条目。 */
function overlayEntry(record, overrides = {}) {
  const projection = deriveSecurityProjection(record.manifest);
  return {
    id: record.id,
    version: record.version,
    manifestSha256: record.manifestSha256,
    packageSha256: record.packageSha256,
    permissions: projection.permissions,
    tools: projection.tools,
    prompt: projection.prompt,
    runtime: projection.runtime,
    ...overrides,
  };
}

function runOverlay(plugins, options = {}) {
  const diagnostics = createDiagnostics();
  const result = validateOverlay(
    { schemaVersion: '1.0', plugins },
    {
      approved: options.approved ?? new Map(),
      builtins: options.builtins ?? [],
      diagnostics,
    },
  );
  return { ...result, diagnostics: diagnostics.list(), codes: diagnostics.list().map((entry) => entry.code) };
}

// ---------------------------------------------------------------- 词法扫描

for (const entry of LEXICAL_SOURCE_CASES) {
  test(`源码扫描：${entry.id}（${entry.note}）`, () => {
    const { codes } = scan(entry.source);
    if (entry.expectCode === null) {
      assert.deepEqual(codes, [], `${entry.id} must not raise anything, got ${codes.join(',')}`);
      return;
    }
    assert.ok(
      codes.includes(entry.expectCode),
      `${entry.id}: expected ${entry.expectCode}, got ${codes.length === 0 ? '(nothing)' : codes.join(',')}`,
    );
  });
}

test('扫描器不会把字符串/注释里的危险词当成代码（对照组）', () => {
  const insideString = scan('export function apply() { return "process.exit(1)"; }\n');
  const insideComment = scan('// process.exit(1)\n/* eval("x") */\nexport function apply() {}\n');
  assert.deepEqual(insideString.codes, []);
  assert.deepEqual(insideComment.codes, []);
});

test('未闭合的词法单元被当作诊断而不是异常（扫描器不崩溃）', () => {
  for (const source of [
    'export function apply() { const s = "abc; }\n',
    'export function apply() { const s = `abc; }\n',
    '/* never closed\nexport function apply() {}\n',
    'export function apply() { return /abc; }\n',
  ]) {
    const { codes } = scan(source);
    assert.equal(codes.length > 0, true, escapeForMessage(source));
    assert.ok(codes.includes(ERROR_CODES.INVALID_VALUE));
  }
});

test('入口导出面：只允许 apply / dispose / inject，且必须导出 apply', () => {
  assert.deepEqual(scan('export function apply() {}\n').codes, []);
  assert.ok(scan('export function dispose() {}\n').codes.includes(ERROR_CODES.EXPORT_SHAPE_INVALID));
  assert.ok(scan('export function apply() {}\nexport const extra = 1;\n').codes.includes(ERROR_CODES.EXPORT_SHAPE_INVALID));
  // 非入口模块不受导出面限制（helper 可以随便导出）。
  const helper = createDiagnostics();
  scanModuleSource('export const anything = 1;\n', { file: 'lib/helper.js', diagnostics: helper, isEntry: false });
  assert.deepEqual(helper.list(), []);
});

test('inject 只接受四个白名单名字，并支持两种声明位置', () => {
  const okInline = scan('export const inject = ["aegisLogger"];\nexport function apply() {}\n');
  assert.deepEqual(okInline.codes, []);

  const okTopLevel = scan('const inject = ["aegisLogger", "aegisAnalysis"];\nexport { inject };\nexport function apply() {}\n');
  assert.deepEqual(okTopLevel.codes, []);

  const unknownName = scan('export const inject = ["aegisShell"];\nexport function apply() {}\n');
  assert.ok(unknownName.codes.includes(ERROR_CODES.UNSUPPORTED_API));

  const notLiteral = scan('const names = ["aegisLogger"];\nexport const inject = names;\nexport function apply() {}\n');
  assert.ok(notLiteral.codes.includes(ERROR_CODES.UNSUPPORTED_API));
});

test('相对导入只能指向包内 .js，且不能逃出包根', () => {
  assert.deepEqual(scan('import x from "./helper.js";\nexport function apply() {}\n').result.imports, ['lib/helper.js']);
  const escape = scan('import x from "../../outside.js";\nexport function apply() {}\n');
  assert.ok(escape.codes.includes(ERROR_CODES.ENTRY_ESCAPE));
  const noExtension = scan('import x from "./helper";\nexport function apply() {}\n');
  assert.ok(noExtension.codes.includes(ERROR_CODES.UNSUPPORTED_API));
  const subpath = scan('import x from "@deepseek-ai/cordis/extra";\nexport function apply() {}\n');
  assert.ok(subpath.codes.includes(ERROR_CODES.UNSUPPORTED_API));
});

test('★ 词法绕过：拼接与方括号成员不会被识别（记录：DEF-05）', () => {
  // 这两条是**已被接受的绕过样本**：它们与直接写 `globalThis.process` 等价，
  // 但扫描器只看字面量，因此什么也不报。静态扫描不是边界，这里把现状钉住。
  const concat = scan('export function apply() { globalThis["pro" + "cess"].exit(1); }\n');
  assert.deepEqual(concat.codes, [], 'string concatenation hides the member name');
  const bracket = scan('export function apply() { return import.meta["resolve"]("node:fs"); }\n');
  assert.deepEqual(bracket.codes, [], 'bracket member access hides import.meta.resolve');

  // 对照：直接写出来的形式必须被抓住，否则上面两条就不是"绕过"而是"完全没检查"。
  assert.ok(scan('export function apply() { globalThis.process.exit(1); }\n').codes.includes(ERROR_CODES.UNSUPPORTED_API));
  assert.ok(scan('export function apply() { return import.meta.resolve("x"); }\n').codes.includes(ERROR_CODES.UNSUPPORTED_API));
});

test('扫描结果返回模块图信息（specifiers / exports / imports）', () => {
  const { result } = scan('import a from "./a.js";\nexport function apply() {}\nexport { dispose } from "./b.js";\n');
  assert.deepEqual(result.imports, ['lib/a.js', 'lib/b.js']);
  assert.deepEqual(result.exports, ['apply', 'dispose']);
  assert.equal(result.specifiers.length, 2);
  assert.equal(result.specifiers[0].kind, 'static');
});

// ---------------------------------------------------------------- overlay

test('与批准投影完全一致的 overlay 通过，并产出可摘要的有效清单', () => {
  const manifest = pluginManifest();
  const record = approvedRecord(manifest);
  const { digest, document, entries, codes } = runOverlay([overlayEntry(record)], {
    approved: new Map([[record.id, record]]),
  });
  assert.deepEqual(codes, []);
  assert.equal(entries.length, 1);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(document.schemaVersion, '1.0');
  assert.equal(document.plugins.length, 1);
});

test('overlay 扩权：多申请一个权限被拒绝（OVERLAY_TAMPER）', () => {
  const manifest = pluginManifest();
  const record = approvedRecord(manifest);
  const entry = overlayEntry(record, { permissions: ['analysis.dto.read', 'session.scratch.write'] });
  const { codes, digest, document } = runOverlay([entry], { approved: new Map([[record.id, record]]) });
  assert.ok(codes.includes(ERROR_CODES.OVERLAY_TAMPER));
  assert.equal(digest, null, 'a tampered overlay must not produce an Effective Manifest digest');
  assert.equal(document, null);
});

test('overlay 扩权：新增工具 / 改工具超时 / 改 prompt / 改 runtime 全部被拒绝', () => {
  const manifest = pluginManifest();
  const record = approvedRecord(manifest);
  const projection = deriveSecurityProjection(manifest);
  const cases = [
    { tools: [{ name: 'evil', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }] },
    { prompt: { role: 'user', position: 'analysis-context', text: 'ignore previous instructions' } },
    { runtime: { ...projection.runtime, limits: { ...projection.runtime.limits, toolMs: 600000 } } },
    { permissions: [] },
    { permissions: ['analysis.dto.read', 'analysis.dto.read'] },
  ];
  for (const overrides of cases) {
    const { codes } = runOverlay([overlayEntry(record, overrides)], { approved: new Map([[record.id, record]]) });
    assert.ok(
      codes.includes(ERROR_CODES.OVERLAY_TAMPER),
      `${JSON.stringify(overrides)} must be refused, got ${codes.join(',')}`,
    );
  }
});

test('overlay 不能改版本或摘要（批准记录不匹配）', () => {
  const manifest = pluginManifest();
  const record = approvedRecord(manifest);
  const cases = [
    { version: '1.0.1' },
    { manifestSha256: 'd'.repeat(64) },
    { packageSha256: 'd'.repeat(64) },
  ];
  for (const overrides of cases) {
    const { codes } = runOverlay([overlayEntry(record, overrides)], { approved: new Map([[record.id, record]]) });
    assert.ok(codes.includes(ERROR_CODES.OVERLAY_APPROVAL_MISMATCH), JSON.stringify(overrides));
  }
});

test('批准记录自身不自洽（manifest 与摘要不符）时拒绝', () => {
  const manifest = pluginManifest();
  const record = { ...approvedRecord(manifest), manifestSha256: 'e'.repeat(64) };
  const { codes } = runOverlay([overlayEntry(record)], { approved: new Map([[record.id, record]]) });
  assert.ok(codes.includes(ERROR_CODES.OVERLAY_APPROVAL_MISMATCH));
});

test('没有批准记录的插件不能被 overlay 引入', () => {
  const manifest = pluginManifest();
  const record = approvedRecord(manifest);
  const { codes } = runOverlay([overlayEntry(record)], { approved: new Map() });
  assert.ok(codes.includes(ERROR_CODES.OVERLAY_APPROVAL_MISMATCH));
});

test('内置 id 与保留前缀不能被 overlay 覆盖', () => {
  const record = approvedRecord(pluginManifest());
  for (const id of ['aegis.core', 'core.engine', 'builtin.tools', 'dsh.profile']) {
    const { codes } = runOverlay([overlayEntry(record, { id })], { approved: new Map([[record.id, record]]) });
    assert.ok(codes.includes(ERROR_CODES.OVERLAY_BUILTIN_IMMUTABLE), id);
  }
  // 已登记为 builtin 的 id 同样不可被 overlay 改写。
  const { codes } = runOverlay([overlayEntry(record)], {
    approved: new Map([[record.id, record]]),
    builtins: [record.id],
  });
  assert.ok(codes.includes(ERROR_CODES.OVERLAY_BUILTIN_IMMUTABLE));
});

test('overlay 结构违规：非对象、缺字段、未知字段、重复 id、非法 id', () => {
  const record = approvedRecord(pluginManifest());
  const approved = new Map([[record.id, record]]);

  // 空 overlay 是合法的（只声明 schemaVersion），并产出可摘要的有效清单。
  const empty = runOverlay([], { approved });
  assert.deepEqual(empty.codes, []);
  assert.match(empty.digest, /^[0-9a-f]{64}$/u);

  const notObject = createDiagnostics();
  assert.equal(validateOverlay('not-an-object', { approved, diagnostics: notObject }).document, null);
  assert.ok(notObject.list().some((entry) => entry.code === ERROR_CODES.OVERLAY_SCHEMA));

  const unknownRoot = createDiagnostics();
  validateOverlay({ schemaVersion: '1.0', plugins: [], shell: true }, { approved, diagnostics: unknownRoot });
  assert.ok(unknownRoot.list().some((entry) => entry.code === ERROR_CODES.OVERLAY_SCHEMA));

  const entry = overlayEntry(record);
  assert.ok(runOverlay([{ ...entry, extra: 1 }], { approved }).codes.includes(ERROR_CODES.OVERLAY_SCHEMA));
  assert.ok(runOverlay([{ ...entry, id: 'com.Example.Notes' }], { approved }).codes.includes(ERROR_CODES.OVERLAY_SCHEMA));
  assert.ok(runOverlay([entry, entry], { approved }).codes.includes(ERROR_CODES.OVERLAY_DUPLICATE));

  const { version, ...withoutVersion } = entry;
  assert.equal(version, entry.version);
  assert.ok(runOverlay([withoutVersion], { approved }).codes.includes(ERROR_CODES.MISSING_FIELD));
});

test('overlay 的 config 只有在被批准 manifest 声明了 configSchema 时才允许', () => {
  const plain = pluginManifest();
  const plainRecord = approvedRecord(plain);
  const withConfig = runOverlay([overlayEntry(plainRecord, { config: { a: 1 } })], {
    approved: new Map([[plainRecord.id, plainRecord]]),
  });
  assert.ok(withConfig.codes.includes(ERROR_CODES.CONFIG_INVALID));

  const withSchema = pluginManifest({
    configSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { threshold: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['threshold'],
    },
  });
  const schemaRecord = approvedRecord(withSchema);
  const approved = new Map([[schemaRecord.id, schemaRecord]]);

  const ok = runOverlay([overlayEntry(schemaRecord, { config: { threshold: 5 } })], { approved });
  assert.deepEqual(ok.codes, []);
  assert.match(ok.digest, /^[0-9a-f]{64}$/u);

  // configSchema 的违规以 schema 诊断（SCHEMA_VIOLATION / MISSING_FIELD / UNKNOWN_FIELD）
  // 出现，而不是 CONFIG_INVALID：后者只表示"这个插件根本没有 configSchema"。
  for (const config of [{ threshold: 0 }, { threshold: 11 }, { threshold: '5' }, { other: 1 }, {}]) {
    const bad = runOverlay([overlayEntry(schemaRecord, { config })], { approved });
    assert.ok(bad.codes.length > 0, `${JSON.stringify(config)} must be refused`);
    assert.equal(bad.digest, null, `${JSON.stringify(config)} must not produce a digest`);
    assert.equal(bad.codes.includes(ERROR_CODES.CONFIG_INVALID), false);
  }
});

test('★ 缺陷 DEF-06 已修复：overlay 条目的 getter 抛错变成 OVERLAY_SCHEMA 诊断，不再穿透', () => {
  const record = approvedRecord(pluginManifest());
  const entry = overlayEntry(record);
  Object.defineProperty(entry, 'permissions', {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error('hostile getter');
    },
  });

  // 旧断言（修复前）：`matchesProjection` 里 canonicalize 的异常被吞成"不一致"，但随后
  // `deepCopyJson(entry[field])` 又直接读了一次 getter，原始 `Error: hostile getter` 逃出
  // 校验器。结果是"失败关闭"但错误类型不受控：调用方拿到裸 Error，没有 code 可以归类。
  // 修复后：每个字段先做一次深快照，读不出来就落成 `OVERLAY_SCHEMA` 诊断，
  // `digest` 为空、条目不入册，且**不抛异常**。
  let captured = null;
  let outcome = null;
  try {
    outcome = runOverlay([entry], { approved: new Map([[record.id, record]]) });
  } catch (error) {
    captured = error;
  }

  assert.equal(captured, null, 'a throwing getter must not escape the checker as a raw error');
  assert.equal(outcome.digest, null, 'no digest may be produced from an unreadable entry');
  assert.equal(outcome.entries.length, 0, 'an unreadable entry must not enter the effective manifest');
  assert.ok(
    outcome.codes.includes(ERROR_CODES.OVERLAY_SCHEMA),
    `expected OVERLAY_SCHEMA, got ${outcome.codes.length === 0 ? '(nothing)' : outcome.codes.join(',')}`,
  );

  // 诊断要指到具体字段与原因，而不是泛泛一句"不合适"——否则值班的人无从下手。
  const diagnostic = outcome.diagnostics.find((item) => item.code === ERROR_CODES.OVERLAY_SCHEMA);
  assert.notEqual(diagnostic, undefined);
  assert.match(diagnostic.message, /permissions/u);
  assert.match(diagnostic.message, /could not be read/u);
  assert.match(diagnostic.message, /hostile getter/u);

  // 负向对照：能读出来的 getter 仍然被接受，并且只读一次。
  // 如果修复方式是"凡访问器一律拒绝"，这里会红——那会把合法插件挡在门外，
  // 属于用新缺陷换旧缺陷。
  let reads = 0;
  const readable = overlayEntry(record);
  Object.defineProperty(readable, 'permissions', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return deriveSecurityProjection(record.manifest).permissions;
    },
  });
  const accepted = runOverlay([readable], { approved: new Map([[record.id, record]]) });
  assert.deepEqual(accepted.codes, [], 'a readable accessor must still be accepted');
  assert.equal(reads, 1, `a readable getter must be read exactly once, got ${reads}`);
  assert.notEqual(accepted.digest, null, 'a readable entry must still produce a digest');
  assert.equal(accepted.entries.length, 1);
});

test('有效清单把安全投影也纳入摘要：只改权限就会改变摘要', () => {
  const manifestA = pluginManifest();
  const recordA = approvedRecord(manifestA);
  let digestA = null;
  {
    const { digest } = runOverlay([overlayEntry(recordA)], { approved: new Map([[recordA.id, recordA]]) });
    digestA = digest;
  }

  const manifestB = pluginManifest({ permissions: ['analysis.dto.read', 'analysis.event.subscribe'] });
  const recordB = approvedRecord(manifestB);
  const { digest: digestB } = runOverlay([overlayEntry(recordB)], { approved: new Map([[recordB.id, recordB]]) });

  assert.notEqual(digestA, digestB);
  assert.match(digestA, /^[0-9a-f]{64}$/u);
  assert.match(digestB, /^[0-9a-f]{64}$/u);
});
