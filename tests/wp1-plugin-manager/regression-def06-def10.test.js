/**
 * DEF-06 / DEF-10 回归用例（M9 P3 修复）。
 *
 * DEF-06：`validateOverlay` 读同一个 overlay 字段两次——`matchesProjection` 一次
 * （`canonicalize` 的异常被吞成"不一致"），随后 `deepCopyJson(entry[field])` 又一次。
 * 于是 getter 被调用两次，第二次抛出的异常会从 `validateOverlay` 直接逃出去：
 * 调用方拿到的是没有 `code` 的原始 `Error`，也没有诊断列表。
 *
 * 修复后的契约：每个字段只读一次；读不出来（getter 抛错 / 描述符陷阱 / 嵌套子树不可读）
 * 一律转成 `OVERLAY_SCHEMA` 诊断，失败方向不变（不产出 Effective Manifest）。
 *
 * DEF-10：包内 `package.json` 是包外文件的硬链接时被接受。`lstat` 看到的是普通文件、
 * `realpath` 也仍在包内（硬链接没有自己的路径），于是"包的身份"绑在路径而不是内容上：
 * 能写包外那份文件的一方可以在批准之后换掉它。
 *
 * 修复后的契约：包内文件的 `nlink > 1` 一律拒绝（`PACKAGE_HARDLINK`），
 * `package.json` / `plugin.json` 的读取再做一次 realpath 归属校验。
 */

import assert from 'node:assert/strict';
import { linkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDiagnostics,
  deriveSecurityProjection,
  digestOf,
  ERROR_CODES,
  inspectPluginDirectory,
  validateOverlay,
  validatePluginJson,
} from '../../apps/plugin-manager/src/index.js';

import {
  codesOf,
  createSandbox,
  ENTRY_PATH,
  ENTRY_SOURCE_OK,
  manifestFixture,
  packageFixture,
} from './helpers.js';

const TOOL = {
  name: 'notes',
  description: 'Summarize authorized DTO',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const MANIFEST = manifestFixture({
  id: 'com.example.anomaly-notes',
  permissions: ['analysis.tool.register'],
  tools: [TOOL],
});

const CONFIG_SCHEMA = {
  type: 'object',
  properties: { retries: { type: 'integer', minimum: 0, maximum: 10 } },
  additionalProperties: false,
};

const CONFIG_MANIFEST = manifestFixture({
  id: 'com.example.configurable-notes',
  name: 'Configurable Notes',
  permissions: ['analysis.tool.register'],
  tools: [TOOL],
  configSchema: CONFIG_SCHEMA,
});

function approve(rawManifest) {
  const diagnostics = createDiagnostics();
  const { manifest } = validatePluginJson(rawManifest, { diagnostics });
  assert.deepEqual(diagnostics.list(), [], 'fixture manifest must be valid');
  return { manifest, manifestSha256: digestOf(manifest), packageSha256: 'b'.repeat(64) };
}

const APPROVAL = approve(MANIFEST);
const CONFIG_APPROVAL = approve(CONFIG_MANIFEST);
const APPROVED = new Map([
  [MANIFEST.id, APPROVAL],
  [CONFIG_MANIFEST.id, CONFIG_APPROVAL],
]);

function overlayEntry(overrides = {}, approval = APPROVAL) {
  return {
    id: approval.manifest.id,
    version: approval.manifest.version,
    manifestSha256: approval.manifestSha256,
    packageSha256: approval.packageSha256,
    ...deriveSecurityProjection(approval.manifest),
    ...overrides,
  };
}

function runOverlay(plugins) {
  const diagnostics = createDiagnostics();
  let captured = null;
  let result = null;
  try {
    result = validateOverlay({ schemaVersion: '1.0', plugins }, { approved: APPROVED, diagnostics });
  } catch (error) {
    captured = error;
  }
  const listed = diagnostics.list();
  return { result, captured, diagnostics: listed, codes: codesOf(listed) };
}

// ------------------------------------------------------------------ DEF-06

test('DEF-06：overlay 字段只读一次，抛错的 getter 变成诊断而不是穿透', () => {
  const entry = overlayEntry();
  let reads = 0;
  Object.defineProperty(entry, 'permissions', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      throw new Error('hostile getter');
    },
  });

  const outcome = runOverlay([entry]);

  // 1) 不再有原始异常逃出校验器：调用方拿得到诊断列表。
  assert.equal(outcome.captured, null, `validateOverlay must not throw: ${outcome.captured?.message}`);
  // 2) 失败方向不变：不产出 Effective Manifest，也没有摘要。
  assert.equal(outcome.result.document, null);
  assert.equal(outcome.result.digest, null);
  // 3) 错误类型可归类，路径指向那个字段。
  assert.deepEqual(outcome.codes, [ERROR_CODES.OVERLAY_SCHEMA]);
  assert.ok(
    outcome.diagnostics.some((item) => item.path === '/plugins/0/permissions'),
    `expected a diagnostic at /plugins/0/permissions, received ${JSON.stringify(outcome.diagnostics)}`,
  );
  assert.match(outcome.diagnostics[0].message, /hostile getter/u);
  // 4) 只读一次（旧实现读两次）。
  assert.equal(reads, 1, `the field must be read exactly once, was read ${reads} times`);
});

test('DEF-06：能读出来的 getter 仍然被接受，但同样只读一次', () => {
  const derived = deriveSecurityProjection(APPROVAL.manifest);
  const entry = overlayEntry();
  let reads = 0;
  Object.defineProperty(entry, 'permissions', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return derived.permissions;
    },
  });

  const outcome = runOverlay([entry]);

  assert.equal(outcome.captured, null);
  assert.deepEqual(outcome.codes, [], 'a readable accessor keeps working');
  assert.ok(outcome.result.digest !== null);
  assert.equal(reads, 1, `the getter must be read exactly once, was read ${reads} times`);
});

test('DEF-06：嵌套子树里的 getter 也变成诊断，不再从校验器里逃出去', () => {
  const hostileTool = { name: 'notes' };
  Object.defineProperty(hostileTool, 'description', {
    enumerable: true,
    configurable: true,
    get() {
      throw new RangeError('nested hostile getter');
    },
  });
  // 顶层是数据属性（因此能被快照），毒在下一层：旧的 `deepCopyJson` 会在这里抛。
  const entry = overlayEntry({ tools: [hostileTool] });

  const outcome = runOverlay([entry]);

  assert.equal(outcome.captured, null, `validateOverlay must not throw: ${outcome.captured?.message}`);
  assert.equal(outcome.result.document, null);
  assert.equal(outcome.codes.includes(ERROR_CODES.OVERLAY_SCHEMA), true, JSON.stringify(outcome.codes));
  assert.ok(
    outcome.diagnostics.some((item) => item.path === '/plugins/0/tools'),
    JSON.stringify(outcome.diagnostics),
  );
});

test('DEF-06：字段描述符陷阱抛错时同样是诊断', () => {
  const entry = overlayEntry();
  const poisoned = new Proxy(entry, {
    getOwnPropertyDescriptor() {
      throw new TypeError('hostile descriptor trap');
    },
  });

  const outcome = runOverlay([poisoned]);

  assert.equal(outcome.captured, null, `validateOverlay must not throw: ${outcome.captured?.message}`);
  assert.equal(outcome.result.document, null);
  assert.equal(outcome.codes.includes(ERROR_CODES.OVERLAY_SCHEMA), true, JSON.stringify(outcome.codes));
});

test('DEF-06：正常 overlay 的语义没有变化（投影一致就通过）', () => {
  const outcome = runOverlay([overlayEntry()]);
  assert.deepEqual(outcome.codes, []);
  assert.equal(outcome.result.digest, digestOf(outcome.result.document));
  // 对照：真的改权限仍然是 OVERLAY_TAMPER，没有被"读一次"改宽。
  const tampered = runOverlay([overlayEntry({ permissions: ['analysis.dto.read'] })]);
  assert.deepEqual(tampered.codes, [ERROR_CODES.OVERLAY_TAMPER]);
  assert.equal(tampered.result.digest, null);
});

test('DEF-06：config 里的抛错 getter 同样是诊断（不再从 schema 校验里穿透）', () => {
  // 第 1 轮独立审查实测：`validateAgainstSchema` 直接读 `entry.config[key]`，
  // 只快照顶层引用时异常会从 `schema.js` 逃出去。
  const config = {};
  Object.defineProperty(config, 'retries', {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error('hostile config getter');
    },
  });

  const outcome = runOverlay([overlayEntry({ config }, CONFIG_APPROVAL)]);

  assert.equal(outcome.captured, null, `validateOverlay must not throw: ${outcome.captured?.message}`);
  assert.equal(outcome.result.document, null);
  assert.equal(outcome.result.digest, null);
  assert.equal(outcome.codes.includes(ERROR_CODES.OVERLAY_SCHEMA), true, JSON.stringify(outcome.codes));
  assert.match(outcome.diagnostics[0].message, /hostile config getter/u);
});

test('DEF-06：config 被读两次会让"校验通过、落地是另一个值"，这里必须只有一个值', () => {
  // 状态型 getter：第 1 次读 0（满足 minimum: 0），第 2 次读 -5（非法）。
  // 旧实现：校验看 0、Effective Manifest 写 -5，且 0 条诊断 —— fail-open。
  let reads = 0;
  const config = {};
  Object.defineProperty(config, 'retries', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? 0 : -5;
    },
  });

  const outcome = runOverlay([overlayEntry({ config }, CONFIG_APPROVAL)]);

  assert.equal(reads, 1, `the config getter must be read exactly once, was read ${reads} times`);
  assert.equal(outcome.captured, null);
  assert.deepEqual(outcome.codes, [], 'the validated value is the value that is written');
  assert.equal(outcome.result.entries[0].config.retries, 0, 'the effective config must be the validated value');
});

test('DEF-06：tools 里的状态型 getter 不能让落地值与投影比对值不同', () => {
  // 用批准的投影作为基准（含默认 timeoutMs），只把 `name` 换成状态型 getter：
  // 第 1 次读真名（与投影一致），第 2 次读别的名字（"批准一个、运行另一个"）。
  const derivedTool = deriveSecurityProjection(APPROVAL.manifest).tools[0];
  let reads = 0;
  const tool = { ...derivedTool };
  Object.defineProperty(tool, 'name', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? derivedTool.name : 'swapped-tool';
    },
  });

  const outcome = runOverlay([overlayEntry({ tools: [tool] })]);

  assert.equal(reads, 1, `the tool getter must be read exactly once, was read ${reads} times`);
  assert.equal(outcome.captured, null);
  assert.deepEqual(outcome.codes, [], 'the compared value is the value that is written');
  assert.equal(
    outcome.result.entries[0].tools[0].name,
    derivedTool.name,
    'the effective tool must not be swapped after the projection check',
  );
});

test('DEF-06：config 是类实例（非 JSON 数据）时是诊断，不是从深处抛出的异常', () => {
  // 第 2 轮独立审查实测：`deepCopyJson` 对非纯对象原样返回，于是"快照"退化成"存引用"，
  // `validateAgainstSchema` 读它的属性时照样进 getter，异常以
  // `PluginCheckError(INVALID_VALUE)` 逃出、且诊断列表是空的。
  class Config {
    constructor() {
      Object.defineProperty(this, 'retries', {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error('own getter on a class instance');
        },
      });
    }
  }

  const outcome = runOverlay([overlayEntry({ config: new Config() }, CONFIG_APPROVAL)]);

  assert.equal(outcome.captured, null, `validateOverlay must not throw: ${outcome.captured?.message}`);
  assert.equal(outcome.result.document, null);
  assert.equal(outcome.result.digest, null);
  assert.deepEqual(outcome.codes, [ERROR_CODES.OVERLAY_SCHEMA]);
  assert.ok(
    outcome.diagnostics.some((item) => item.path === '/plugins/0/config'),
    JSON.stringify(outcome.diagnostics),
  );
  assert.match(outcome.diagnostics[0].message, /not JSON data/u);
});

test('DEF-06：Date 这类非 JSON 值同样被归类为诊断（不是静默通过）', () => {
  const outcome = runOverlay([overlayEntry({ config: new Date(0) }, CONFIG_APPROVAL)]);
  assert.equal(outcome.captured, null);
  assert.equal(outcome.result.document, null);
  assert.deepEqual(outcome.codes, [ERROR_CODES.OVERLAY_SCHEMA]);
});

// ------------------------------------------------------------------ DEF-10

test('DEF-10：包内 package.json 是包外文件的硬链接时被拒绝', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const directory = sandbox.mkdir('plugin');
  sandbox.write('plugin/plugin.json', `${JSON.stringify(MANIFEST, null, 2)}\n`);
  sandbox.write(`plugin/${ENTRY_PATH}`, ENTRY_SOURCE_OK);
  const outside = sandbox.write('outside-package.json', `${JSON.stringify(packageFixture(), null, 2)}\n`);
  linkSync(outside, join(directory, 'package.json'));

  const report = inspectPluginDirectory(directory);

  assert.equal(report.ok, false, 'a hard-linked package.json must not be accepted');
  assert.equal(
    report.diagnostics.some((entry) => entry.code === ERROR_CODES.PACKAGE_HARDLINK),
    true,
    `expected PACKAGE_HARDLINK, received ${JSON.stringify(report.diagnostics.map((entry) => entry.code))}`,
  );
  assert.equal(report.staticScanOnly, true);
  assert.deepEqual(report.sideEffects, { writes: 0, executedPluginCode: false, staged: false });
});

test('DEF-10：入口模块被硬链接到包外时同样被拒绝', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const directory = sandbox.mkdir('plugin');
  sandbox.write('plugin/package.json', `${JSON.stringify(packageFixture(), null, 2)}\n`);
  sandbox.write('plugin/plugin.json', `${JSON.stringify(MANIFEST, null, 2)}\n`);
  const outside = sandbox.write('outside-entry.js', ENTRY_SOURCE_OK);
  sandbox.mkdir(`plugin/${ENTRY_PATH.split('/')[0]}`);
  linkSync(outside, join(directory, ...ENTRY_PATH.split('/')));

  const report = inspectPluginDirectory(directory);

  assert.equal(report.ok, false);
  assert.equal(
    report.diagnostics.some((entry) => entry.code === ERROR_CODES.PACKAGE_HARDLINK),
    true,
    JSON.stringify(report.diagnostics.map((entry) => entry.code)),
  );
  assert.equal(report.entry, null, 'no entry digest may be produced from an outside inode');
});

test('DEF-10：普通（单链接）文件不受影响，摘要仍然照常产出', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const directory = sandbox.mkdir('plugin');
  sandbox.write('plugin/package.json', `${JSON.stringify(packageFixture(), null, 2)}\n`);
  sandbox.write('plugin/plugin.json', `${JSON.stringify(MANIFEST, null, 2)}\n`);
  sandbox.write(`plugin/${ENTRY_PATH}`, ENTRY_SOURCE_OK);

  // 对照：证明拒绝的是 nlink，而不是"所有文件"。
  assert.equal(lstatSync(join(directory, 'package.json')).nlink, 1);

  const report = inspectPluginDirectory(directory);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.ok, true);
  assert.match(report.digests.packageSha256, /^[0-9a-f]{64}$/u);
  assert.equal(report.entry.path, ENTRY_PATH);
});

// ------------------------------------------------- DEF-06（config 分支）

/**
 * `config` 是九个允许字段里唯一"值会被继续解释"的一个：它要过 `configSchema` 校验，
 * 再落进 Effective Manifest。只快照顶层是不够的——嵌套访问器在 schema 校验那一层
 * 仍会被执行，抛错同样会以"没有 code、没有诊断列表"的原始 Error 逃出 `validateOverlay`。
 *
 * 下面三条钉住：嵌套异常转 `OVERLAY_SCHEMA` 诊断、`ownKeys` 陷阱同样转诊断、
 * 可读的嵌套 getter 只执行一次且落地的是数据属性（不是调用方对象的别名）。
 */

test('DEF-06：config 里的嵌套 getter 抛错是 OVERLAY_SCHEMA 诊断，不是穿透', () => {
  const config = {};
  Object.defineProperty(config, 'retries', {
    enumerable: true,
    configurable: true,
    get() {
      throw new RangeError('nested config getter');
    },
  });

  const outcome = runOverlay([overlayEntry({ config }, CONFIG_APPROVAL)]);

  assert.equal(outcome.captured, null, `validateOverlay must not throw: ${outcome.captured?.message}`);
  assert.equal(outcome.result.document, null, 'a failed overlay must not produce an Effective Manifest');
  assert.equal(outcome.result.digest, null);
  assert.deepEqual(outcome.codes, [ERROR_CODES.OVERLAY_SCHEMA]);
  assert.ok(
    outcome.diagnostics.some((item) => item.path === '/plugins/0/config'),
    JSON.stringify(outcome.diagnostics),
  );
  assert.match(outcome.diagnostics[0].message, /nested config getter/u);
});

test('DEF-06：config 的 ownKeys 陷阱抛错同样是诊断', () => {
  const config = new Proxy({ retries: 3 }, {
    ownKeys() {
      throw new TypeError('hostile config ownKeys');
    },
  });

  const outcome = runOverlay([overlayEntry({ config }, CONFIG_APPROVAL)]);

  assert.equal(outcome.captured, null, `validateOverlay must not throw: ${outcome.captured?.message}`);
  assert.equal(outcome.result.document, null);
  assert.equal(
    outcome.codes.includes(ERROR_CODES.OVERLAY_SCHEMA),
    true,
    JSON.stringify(outcome.codes),
  );
  assert.ok(
    outcome.diagnostics.some((item) => item.path === '/plugins/0/config'),
    JSON.stringify(outcome.diagnostics),
  );
});

test('DEF-06：config 的嵌套 getter 只读一次，落地的是数据属性', () => {
  let reads = 0;
  const config = {};
  Object.defineProperty(config, 'retries', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 3;
    },
  });

  const outcome = runOverlay([overlayEntry({ config }, CONFIG_APPROVAL)]);

  assert.equal(outcome.captured, null, `validateOverlay must not throw: ${outcome.captured?.message}`);
  assert.deepEqual(outcome.codes, [], 'a readable config keeps working');
  assert.ok(outcome.result.document !== null);
  assert.equal(reads, 1, `the config getter must be read exactly once, was read ${reads} times`);
  const effective = outcome.result.entries[0].config;
  assert.equal(effective.retries, 3);
  assert.equal(
    Object.getOwnPropertyDescriptor(effective, 'retries').get,
    undefined,
    'the Effective Manifest must hold data properties, not the caller accessor',
  );
});
