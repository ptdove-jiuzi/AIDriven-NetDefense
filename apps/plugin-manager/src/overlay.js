// AegisHarness plugin manager — author: PT-dove
// Controlled overlay handling: the security projection is derived from the approved
// plugin.json, so an overlay can never widen permissions, tools, prompt or runtime.
// Only `config` may differ, and it is validated against the approved configSchema.

import { ERROR_CODES } from './errors.js';
import { COMPATIBILITY_PROFILE } from './profile.js';
import { canonicalize, digestOf } from './jcs.js';
import { validateAgainstSchema } from './schema.js';
import { validatePluginJson } from './plugin-manifest.js';

export const OVERLAY_ALLOWED_FIELDS = Object.freeze(['schemaVersion', 'plugins']);

export const OVERLAY_PLUGIN_ALLOWED_FIELDS = Object.freeze([
  'id',
  'version',
  'packageSha256',
  'manifestSha256',
  'permissions',
  'tools',
  'prompt',
  'runtime',
  'config',
]);

const ROOT_FIELDS = new Set(OVERLAY_ALLOWED_FIELDS);
const PLUGIN_FIELDS = new Set(OVERLAY_PLUGIN_ALLOWED_FIELDS);
const SECURITY_FIELDS = Object.freeze(['permissions', 'tools', 'prompt', 'runtime']);
const RESERVED_ID_PREFIXES = Object.freeze(['aegis.', 'core.', 'builtin.', 'dsh.']);
const PLUGIN_ID_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // `getPrototypeOf` 在 Proxy 上是陷阱：一个 `getPrototypeOf() { throw }` 的对象能让
  // 原始异常从"类型判断"这一行逃出校验器（DEF-06 的同源面）。类型判断必须是全函数。
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function describeError(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * 列出一个对象的自有可枚举键；`ownKeys` 陷阱抛错时登记诊断并返回空列表（DEF-06）。
 *
 * @param {object} value 待枚举对象。
 * @param {string} basePath 诊断路径。
 * @param {(code: string, path: string, message: string) => void} fail 诊断收集器。
 * @returns {string[]} 键名列表。
 */
function ownKeysOf(value, basePath, fail) {
  try {
    return Object.keys(value);
  } catch (error) {
    fail(
      ERROR_CODES.OVERLAY_SCHEMA,
      basePath,
      `the entry could not be enumerated: ${describeError(error)}`,
    );
    return [];
  }
}

/**
 * 读取 overlay 条目的一个字段，**只读一次**，并把结果快照下来（DEF-06）。
 *
 * 旧实现读同一个字段两次：`matchesProjection` 里一次（`canonicalize` 的异常被吞成
 * "不一致"），随后 `deepCopyJson(entry[field])` 又一次。于是同一个 getter 被调用两次，
 * 而且第二次抛出的异常会从 `validateOverlay` 直接逃出去——调用方拿到的是原始 `Error`，
 * 没有诊断列表，也无法归类。
 *
 * 现在每个字段只读一次：
 * - 自有数据属性 → 直接取描述符里的值，getter 一次都不执行；
 * - 自有访问器 → 调一次 getter（保持"能读出来就照常接受"的既有语义），结果即快照；
 * - 继承属性 → 走一次 `[[Get]]`（同样只一次）；
 * - 任何一步抛错 → 返回 `reason`，由调用方转成 `OVERLAY_SCHEMA` 诊断。
 *
 * @param {object} entry Overlay plugin entry.
 * @param {string} field Field name.
 * @returns {{present: boolean, value: unknown, reason: string|null}} Snapshot.
 */
function snapshotField(entry, field) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(entry, field);
  } catch (error) {
    return { present: false, value: undefined, reason: describeError(error) };
  }
  if (descriptor === undefined) {
    // 没有自有属性：保留"继承属性可读"的旧语义，但只读一次。
    try {
      if (!(field in entry)) {
        return { present: false, value: undefined, reason: null };
      }
      return { present: true, value: entry[field], reason: null };
    } catch (error) {
      return { present: false, value: undefined, reason: describeError(error) };
    }
  }
  if ('value' in descriptor) {
    return { present: true, value: descriptor.value, reason: null };
  }
  try {
    return { present: true, value: descriptor.get === undefined ? undefined : descriptor.get.call(entry), reason: null };
  } catch (error) {
    return { present: false, value: undefined, reason: describeError(error) };
  }
}

function deepCopyJson(value) {
  if (Array.isArray(value)) return value.map((entry) => deepCopyJson(entry));
  if (isPlainObject(value)) {
    const copy = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: deepCopyJson(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return value;
}

/**
 * 深拷贝一个 overlay 字段值，只接受 JSON 数据（DEF-06）。
 *
 * `deepCopyJson` 对**非纯对象**（类实例、`Date`、`Map`、带异形原型的 Proxy）是原样返回的，
 * 所以"快照"会退化成"存引用"：`validateAgainstSchema` 随后读它的属性时照样进 getter，
 * 异常仍然从 `validateOverlay` 逃出去（第 2 轮独立审查实测：
 * `PluginCheckError(INVALID_VALUE)` + 0 条诊断）。
 *
 * overlay 文档按合同就是 JSON（由 `parseStrictJson` 解析），因此这里把"不是 JSON 数据"
 * 当作**可归类的诊断**而不是"照原样传下去"：失败方向不变（不产出 Effective Manifest），
 * 但调用方拿得到诊断列表，而不是一个从深处抛出来的异常。
 *
 * @param {unknown} value 已快照的字段值。
 * @param {string} trail 已经走过的键路径（用于报错信息）。
 * @returns {unknown} 纯 JSON 拷贝。
 * @throws {TypeError} 当值不是 JSON 数据时。
 */
function copyJsonData(value, trail) {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => copyJsonData(item, `${trail}[${index}]`));
  }
  if (type === 'object' && isPlainObject(value)) {
    const copy = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: copyJsonData(value[key], `${trail}.${key}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  throw new TypeError(`${trail} is not JSON data (${type === 'object' ? 'non-plain object' : type})`);
}

/**
 * 深拷贝一个已经快照过的字段值，并把读取失败转成诊断（DEF-06）。
 *
 * `deepCopyJson` 会递归读 `value[key]`，所以"顶层字段是数据属性"并不代表整棵子树可读：
 * 嵌套访问器、Proxy 的 `ownKeys` / `get` 陷阱都能在这一步抛错。旧实现让这些异常直接
 * 逃出 `validateOverlay`，调用方只能拿到一个没有 `code` 的原始 `Error`。
 *
 * 返回值用 `{ok, value}` 而不是"失败返回 null"：`null` 本身是合法字段值（`prompt`），
 * 用空值表示失败会让调用方无法区分。
 *
 * @param {unknown} value 已快照的字段值。
 * @param {string} basePath 该条目的诊断路径。
 * @param {string} field 字段名。
 * @param {(code: string, path: string, message: string) => void} fail 诊断收集器。
 * @returns {{ok: true, value: unknown} | {ok: false, value: null}} 拷贝结果。
 */
function copySnapshot(value, basePath, field, fail) {
  try {
    return { ok: true, value: copyJsonData(value, field) };
  } catch (error) {
    fail(
      ERROR_CODES.OVERLAY_SCHEMA,
      `${basePath}/${field}`,
      `overlay field "${field}" could not be copied: ${describeError(error)}`,
    );
    return { ok: false, value: null };
  }
}

function idOf(value) {
  if (typeof value === 'string') return value;
  if (isPlainObject(value) && typeof value.id === 'string') return value.id;
  return undefined;
}

function compareById(left, right) {
  const leftId = idOf(left);
  const rightId = idOf(right);
  if (leftId === rightId) return 0;
  if (leftId === undefined) return -1;
  if (rightId === undefined) return 1;
  return leftId < rightId ? -1 : 1;
}

function builtinIdOf(entry) {
  if (typeof entry === 'string') return entry;
  if (isPlainObject(entry) && typeof entry.id === 'string') return entry.id;
  return null;
}

/**
 * Normalises a manifest document when it is a valid plugin.json, so that deriving from the raw
 * document and from `validatePluginJson` output yields the same projection. Without this, the
 * defaulted tool timeout would make the two representations disagree and raise a spurious
 * OVERLAY_TAMPER for a plugin that never changed.
 * @param {unknown} value
 * @returns {object|null}
 */
function normalisedManifest(value) {
  if (!isPlainObject(value)) return null;
  const counter = { errors: 0, add() { counter.errors += 1; } };
  const { manifest } = validatePluginJson(value, { diagnostics: counter });
  return counter.errors === 0 && isPlainObject(manifest) ? manifest : null;
}

/**
 * Deterministic security projection of an approved manifest.
 * @param {object|null} manifest
 * @param {object} [profile]
 * @returns {{permissions: string[], tools: object[], prompt: object|null, runtime: object}}
 */
export function deriveSecurityProjection(manifest, profile = COMPATIBILITY_PROFILE) {
  const source = normalisedManifest(manifest) ?? (isPlainObject(manifest) ? manifest : {});
  return {
    permissions: Array.isArray(source.permissions)
      ? source.permissions.filter((entry) => typeof entry === 'string')
      : [],
    tools: Array.isArray(source.tools) ? deepCopyJson(source.tools) : [],
    prompt: isPlainObject(source.prompt) ? deepCopyJson(source.prompt) : null,
    runtime: {
      api: profile.api,
      entry: profile.entry,
      module: 'esm',
      node: profile.nodeEngine,
      engine: { dsh: profile.dsh, cordis: profile.cordis },
      limits: {
        activateMs: 5000,
        disposeMs: 5000,
        toolMs: 5000,
        toolResultBytes: 65536,
        promptBytes: 4096,
        scratchFileBytes: 1048576,
        scratchTotalBytes: 67108864,
        rpcBytes: 65536,
      },
    },
  };
}

/**
 * Builds the Effective Manifest document plus its JCS digest.
 * @param {{builtins?: Array<object|string>, plugins?: Array<object>, profile?: object}} options
 * @returns {{document: object, digest: string}}
 */
export function buildEffectiveManifest(options = {}) {
  const { builtins = [], plugins = [], profile = COMPATIBILITY_PROFILE } = options;

  const builtinEntries = builtins
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => (typeof entry === 'string' ? entry : deepCopyJson(entry)))
    .sort(compareById);

  const pluginEntries = plugins
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({
      id: entry.id,
      version: entry.version,
      manifestSha256: entry.manifestSha256,
      packageSha256: entry.packageSha256,
      // The security projection is part of the digested document, so the digest pins the
      // permissions, tools, prompt and runtime that the broker, worker and extension host
      // compare against. Without it two overlays with the same identifiers would digest
      // identically even when their security surface differed.
      security: {
        permissions: Array.isArray(entry.permissions) ? deepCopyJson(entry.permissions) : [],
        tools: Array.isArray(entry.tools) ? deepCopyJson(entry.tools) : [],
        prompt: Object.hasOwn(entry, 'prompt') && entry.prompt !== null ? deepCopyJson(entry.prompt) : null,
        runtime: isPlainObject(entry.runtime) ? deepCopyJson(entry.runtime) : null,
      },
      config: entry.config === undefined ? null : deepCopyJson(entry.config),
    }))
    .sort(compareById);

  const document = {
    schemaVersion: COMPATIBILITY_PROFILE.overlaySchemaVersion,
    api: profile.api,
    rpc: { version: profile.rpcVersion, methods: [...profile.rpcMethods] },
    builtins: builtinEntries,
    plugins: pluginEntries,
  };

  return { document, digest: digestOf(document) };
}

function matchesProjection(snapshot, derived, field) {
  const { present, value } = snapshot;
  const derivedValue = derived[field];
  if (!present) {
    if (field === 'tools') return Array.isArray(derivedValue) && derivedValue.length === 0;
    if (field === 'prompt') return derivedValue === null;
    if (field === 'permissions') return Array.isArray(derivedValue) && derivedValue.length === 0;
    return false;
  }
  let actual;
  let expected;
  try {
    actual = canonicalize(value);
    expected = canonicalize(derivedValue);
  } catch {
    return false;
  }
  return actual === expected;
}

/**
 * Validates an overlay document against the approved manifests.
 * @param {unknown} raw
 * @param {{approved?: Map<string, object>, builtins?: Array<object|string>, diagnostics: {add: Function}, profile?: object}} options
 * @returns {{entries: object[], document: object|null, digest: string|null}}
 */
export function validateOverlay(raw, options = {}) {
  const {
    approved,
    builtins = [],
    diagnostics,
    profile = COMPATIBILITY_PROFILE,
  } = options;

  const report = (code, path, message) => diagnostics.add(code, path, message);
  const approvedMap = approved instanceof Map ? approved : new Map();
  const builtinIds = new Set(
    builtins.map((entry) => builtinIdOf(entry)).filter((id) => typeof id === 'string'),
  );

  const entries = [];
  let failed = false;
  const fail = (code, path, message) => {
    failed = true;
    report(code, path, message);
  };

  const failResult = () => ({ entries: [], document: null, digest: null });

  if (!isPlainObject(raw)) {
    fail(ERROR_CODES.OVERLAY_SCHEMA, '', 'overlay must be a JSON object');
    return failResult();
  }

  for (const key of ownKeysOf(raw, '', fail)) {
    if (!ROOT_FIELDS.has(key)) {
      fail(ERROR_CODES.OVERLAY_SCHEMA, `/${key}`, `unknown overlay field "${key}"`);
    }
  }
  const rootSchemaVersion = snapshotField(raw, 'schemaVersion');
  if (rootSchemaVersion.reason !== null) {
    fail(
      ERROR_CODES.OVERLAY_SCHEMA,
      '/schemaVersion',
      `overlay field "schemaVersion" could not be read: ${rootSchemaVersion.reason}`,
    );
    return failResult();
  }
  if (rootSchemaVersion.value !== COMPATIBILITY_PROFILE.overlaySchemaVersion) {
    fail(
      ERROR_CODES.OVERLAY_SCHEMA,
      '/schemaVersion',
      `overlay schemaVersion must be "${COMPATIBILITY_PROFILE.overlaySchemaVersion}"`,
    );
  }
  const rootPlugins = snapshotField(raw, 'plugins');
  if (rootPlugins.reason !== null) {
    fail(ERROR_CODES.OVERLAY_SCHEMA, '/plugins', `overlay field "plugins" could not be read: ${rootPlugins.reason}`);
    return failResult();
  }
  if (!Array.isArray(rootPlugins.value)) {
    fail(ERROR_CODES.OVERLAY_SCHEMA, '/plugins', 'overlay "plugins" must be an array');
    return failResult();
  }
  // 把数组也快照成纯数组：`plugins` 可以是数组的 Proxy，`forEach` 会读 `length` 与每个下标，
  // 陷阱抛错同样必须落在诊断里，而不是从校验器里逃出去（DEF-06）。
  let pluginEntries;
  try {
    pluginEntries = Array.prototype.slice.call(rootPlugins.value);
  } catch (error) {
    fail(ERROR_CODES.OVERLAY_SCHEMA, '/plugins', `overlay "plugins" could not be read: ${describeError(error)}`);
    return failResult();
  }

  const seenIds = new Set();
  pluginEntries.forEach((entry, index) => {
    const basePath = `/plugins/${index}`;
    if (!isPlainObject(entry)) {
      fail(ERROR_CODES.OVERLAY_SCHEMA, basePath, 'each overlay plugin entry must be an object');
      return;
    }
    // 先把每个字段**深快照一次**（DEF-06）：后面所有判断都只看快照，
    // 同一个 getter 不会再被第二次执行，也不会再有异常从校验器里逃出去。
    //
    // 深拷贝而不是只存引用是必须的：投影比对（`canonicalize`）、schema 校验
    // （`validateAgainstSchema`）和写入 Effective Manifest 是三处独立读取，
    // 只快照顶层引用时它们会各自再进一次嵌套 getter——校验看到 v1、落地写成 v2，
    // 结果是"校验通过但内容被换掉"（第 1 轮独立审查实测）。
    const fields = {};
    for (const field of OVERLAY_PLUGIN_ALLOWED_FIELDS) {
      const snapshot = snapshotField(entry, field);
      if (snapshot.reason !== null) {
        fail(
          ERROR_CODES.OVERLAY_SCHEMA,
          `${basePath}/${field}`,
          `overlay field "${field}" could not be read: ${snapshot.reason}`,
        );
        return;
      }
      if (!snapshot.present) {
        fields[field] = { present: false, value: undefined };
        continue;
      }
      const copy = copySnapshot(snapshot.value, basePath, field, fail);
      if (!copy.ok) {
        return;
      }
      fields[field] = { present: true, value: copy.value };
    }
    for (const key of ownKeysOf(entry, basePath, fail)) {
      if (!PLUGIN_FIELDS.has(key)) {
        fail(ERROR_CODES.OVERLAY_SCHEMA, `${basePath}/${key}`, `unknown overlay plugin field "${key}"`);
      }
    }
    for (const field of ['id', 'version', 'manifestSha256', 'packageSha256']) {
      if (!fields[field].present) {
        fail(ERROR_CODES.MISSING_FIELD, `${basePath}/${field}`, `missing overlay plugin field "${field}"`);
      }
    }

    const id = fields.id.value;
    if (typeof id !== 'string' || id === '') {
      fail(ERROR_CODES.OVERLAY_SCHEMA, `${basePath}/id`, 'overlay plugin id must be a non-empty string');
      return;
    }
    if (id.length > 128 || !PLUGIN_ID_PATTERN.test(id)) {
      fail(
        ERROR_CODES.OVERLAY_SCHEMA,
        `${basePath}/id`,
        `overlay plugin id "${id}" must be a lowercase reverse DNS identifier`,
      );
      return;
    }

    if (seenIds.has(id)) {
      fail(ERROR_CODES.OVERLAY_DUPLICATE, `${basePath}/id`, `duplicate overlay plugin id "${id}"`);
      return;
    }
    seenIds.add(id);

    if (builtinIds.has(id) || RESERVED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
      fail(
        ERROR_CODES.OVERLAY_BUILTIN_IMMUTABLE,
        `${basePath}/id`,
        `"${id}" is a built-in identifier; overlays may only add extensions, never patch, replace or delete built-ins`,
      );
      return;
    }

    const record = approvedMap.get(id);
    if (record === undefined) {
      fail(
        ERROR_CODES.OVERLAY_APPROVAL_MISMATCH,
        `${basePath}/id`,
        `plugin "${id}" has no approved manifest; refusing unapproved extension`,
      );
      return;
    }

    // The approval record is the only authority for the security projection, so the stored
    // manifest must be exactly the manifest that was digested when it was approved. Without
    // this check an updated manifest could ride on an unchanged old digest, which is the
    // "permission widening with the old digest preserved" case AT-PLG-002 must reject.
    if (isPlainObject(record.manifest) && typeof record.manifestSha256 === 'string') {
      let recordedDigest = null;
      try {
        recordedDigest = digestOf(record.manifest);
      } catch {
        recordedDigest = null;
      }
      if (recordedDigest !== record.manifestSha256) {
        fail(
          ERROR_CODES.OVERLAY_APPROVAL_MISMATCH,
          `${basePath}/manifestSha256`,
          `the approved record for "${id}" is not self consistent: the stored manifest does not hash to the stored manifestSha256`,
        );
        return;
      }
    }

    const expectedVersion =
      isPlainObject(record.manifest) && typeof record.manifest.version === 'string'
        ? record.manifest.version
        : record.version;
    if (fields.version.value !== expectedVersion) {
      fail(
        ERROR_CODES.OVERLAY_APPROVAL_MISMATCH,
        `${basePath}/version`,
        `plugin "${id}" version "${String(fields.version.value)}" does not match the approved version "${String(expectedVersion)}"`,
      );
    }
    if (fields.manifestSha256.value !== record.manifestSha256) {
      fail(
        ERROR_CODES.OVERLAY_APPROVAL_MISMATCH,
        `${basePath}/manifestSha256`,
        `plugin "${id}" manifest digest does not match the approved digest`,
      );
    }
    if (fields.packageSha256.value !== record.packageSha256) {
      fail(
        ERROR_CODES.OVERLAY_APPROVAL_MISMATCH,
        `${basePath}/packageSha256`,
        `plugin "${id}" package digest does not match the approved digest`,
      );
    }

    const derived = deriveSecurityProjection(record.manifest, profile);
    for (const field of SECURITY_FIELDS) {
      if (!matchesProjection(fields[field], derived, field)) {
        fail(
          ERROR_CODES.OVERLAY_TAMPER,
          `${basePath}/${field}`,
          `overlay field "${field}" of "${id}" is not identical to the projection derived from the approved plugin.json`,
        );
      }
    }

    let config = null;
    if (fields.config.present) {
      const manifest = isPlainObject(record.manifest) ? record.manifest : {};
      if (!isPlainObject(manifest.configSchema)) {
        fail(
          ERROR_CODES.CONFIG_INVALID,
          `${basePath}/config`,
          `plugin "${id}" has no configSchema; overlay config is not allowed`,
        );
      } else {
        let configErrors = 0;
        validateAgainstSchema(manifest.configSchema, fields.config.value, {
          path: `${basePath}/config`,
          diagnostics: {
            add: (code, at, message) => {
              configErrors += 1;
              diagnostics.add(code, at, message);
            },
          },
        });
        if (configErrors > 0) failed = true;
        else config = fields.config.value;
      }
    }

    entries.push({
      id,
      version: fields.version.value,
      manifestSha256: fields.manifestSha256.value,
      packageSha256: fields.packageSha256.value,
      // 写入的是**同一份**深快照：投影比对、schema 校验与 Effective Manifest
      // 因此看的是同一个值，不存在"校验一个、落地另一个"（DEF-06）。
      permissions: fields.permissions.present ? fields.permissions.value : deepCopyJson(derived.permissions),
      tools: fields.tools.present ? fields.tools.value : deepCopyJson(derived.tools),
      prompt: fields.prompt.present ? fields.prompt.value : deepCopyJson(derived.prompt),
      runtime: fields.runtime.present ? fields.runtime.value : deepCopyJson(derived.runtime),
      config,
    });
  });

  if (failed) {
    return { entries: [], document: null, digest: null };
  }

  // The effective manifest must pin the built-in four-layer inventory as well as the
  // approved extensions; dropping `builtins` here would leave them outside the digest.
  const { document, digest } = buildEffectiveManifest({ builtins, plugins: entries, profile });
  return { entries, document, digest };
}
