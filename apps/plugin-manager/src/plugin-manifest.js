// AegisHarness plugin manager — author: PT-dove
// Validation of the closed plugin.json manifest. Every content problem becomes a
// diagnostic; the validated manifest is only returned when nothing was reported.

import { ERROR_CODES, PluginCheckError } from './errors.js';
import { COMPATIBILITY_PROFILE } from './profile.js';
import { assertClosedSchema, escapePointerSegment } from './schema.js';
import { isValidToolName, toolFullName, validatePermissionList } from './permissions.js';

export const PLUGIN_JSON_REQUIRED_FIELDS = Object.freeze([
  'schemaVersion',
  'id',
  'name',
  'version',
  'api',
  'engine',
  'entry',
  'permissions',
]);

export const PLUGIN_JSON_OPTIONAL_FIELDS = Object.freeze([
  'description',
  'publisher',
  'license',
  'tools',
  'prompt',
  'configSchema',
]);

const REQUIRED = new Set(PLUGIN_JSON_REQUIRED_FIELDS);
const OPTIONAL = new Set(PLUGIN_JSON_OPTIONAL_FIELDS);

const PLUGIN_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const RESERVED_ID_PREFIXES = Object.freeze(['aegis.', 'core.', 'builtin.', 'dsh.']);
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// C0 **与** C1（\u007f DEL / \u0080-\u009f）都算控制符（DEF-05）：
// 旧正则只覆盖 C0 + DEL，`\u0080`-`\u009f` 能直接写进 name / description / prompt /
// configSchema，而 contracts 的 assertText 会拒绝它们——同一份文本在插件侧合法、
// 在事件侧非法，两个组件对"同一份内容"的解释不一致。
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const PROMPT_ALLOWED_CONTROLS = new Set(['\t', '\n']);

const TOOL_FIELDS = Object.freeze([
  'name',
  'description',
  'inputSchema',
  'outputSchema',
  'timeoutMs',
]);
const TOOL_FIELD_SET = new Set(TOOL_FIELDS);
const PROMPT_FIELDS = Object.freeze(['role', 'position', 'text']);
const PROMPT_FIELD_SET = new Set(PROMPT_FIELDS);

const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unsafePath(message) {
  return new PluginCheckError(ERROR_CODES.ENTRY_PATH_UNSAFE, message, null);
}

/**
 * Rejects anything that is not a plain, nested, forward-slash, `.js` package relative path.
 * @param {string} candidate
 * @param {{allowNested?: boolean}} [options]
 * @returns {string} the accepted POSIX path
 */
export function assertSafeRelativePath(candidate, options = {}) {
  const { allowNested = true } = options;
  if (typeof candidate !== 'string' || candidate === '') {
    throw unsafePath('path must be a non-empty string');
  }
  if (candidate.length > 512) {
    throw unsafePath('path must be at most 512 characters');
  }
  if (candidate.includes('\\')) {
    throw unsafePath('backslashes are not allowed in package relative paths');
  }
  if (candidate.includes('%')) {
    throw unsafePath('percent encoded characters are not allowed in package relative paths');
  }
  if (CONTROL_CHARACTERS.test(candidate)) {
    throw unsafePath('control characters are not allowed in package relative paths');
  }
  if (candidate.startsWith('/')) {
    throw unsafePath('absolute paths are not allowed');
  }
  if (/^[A-Za-z]:/.test(candidate)) {
    throw unsafePath('drive letter paths are not allowed');
  }
  if (candidate.endsWith('/')) {
    throw unsafePath('paths must not end with a separator');
  }
  const segments = candidate.split('/');
  if (!allowNested && segments.length > 1) {
    throw unsafePath('nested paths are not allowed here');
  }
  for (const segment of segments) {
    if (segment === '') throw unsafePath('empty path segments are not allowed');
    if (segment === '.' || segment === '..') {
      throw unsafePath('relative traversal segments are not allowed');
    }
    if (/[ .]$/.test(segment)) {
      throw unsafePath('path segments must not end with a space or a dot');
    }
    const base = segment.split('.')[0].toLowerCase();
    if (WINDOWS_RESERVED_NAMES.has(base)) {
      throw unsafePath(`"${segment}" is a reserved device name`);
    }
  }
  if (!candidate.endsWith('.js')) {
    throw unsafePath('only .js files may be referenced');
  }
  return segments.join('/');
}

/**
 * Validates a parsed plugin.json.
 * @param {unknown} raw
 * @param {{diagnostics: {add: Function}}} options
 * @returns {{manifest: object|null, toolFullNames: string[]}}
 */
export function validatePluginJson(raw, options = {}) {
  const { diagnostics } = options;
  let localErrors = 0;
  const report = (code, path, message) => {
    localErrors += 1;
    diagnostics.add(code, path, message);
  };

  if (!isPlainObject(raw)) {
    report(ERROR_CODES.SCHEMA_VIOLATION, '', 'plugin.json must be a JSON object');
    return { manifest: null, toolFullNames: [] };
  }

  for (const field of REQUIRED) {
    if (!Object.hasOwn(raw, field)) {
      report(ERROR_CODES.MISSING_FIELD, `/${field}`, `missing required field "${field}"`);
    }
  }
  for (const key of Object.keys(raw)) {
    if (REQUIRED.has(key) || OPTIONAL.has(key)) continue;
    report(ERROR_CODES.UNKNOWN_FIELD, `/${key}`, `unknown plugin.json field "${key}"`);
  }

  const manifest = {};

  if (Object.hasOwn(raw, 'schemaVersion')) {
    if (raw.schemaVersion !== COMPATIBILITY_PROFILE.manifestSchemaVersion) {
      report(
        ERROR_CODES.INVALID_VALUE,
        '/schemaVersion',
        `schemaVersion must be "${COMPATIBILITY_PROFILE.manifestSchemaVersion}"`,
      );
    } else {
      manifest.schemaVersion = raw.schemaVersion;
    }
  }

  let pluginId = null;
  if (Object.hasOwn(raw, 'id')) {
    const id = raw.id;
    if (typeof id !== 'string' || id === '') {
      report(ERROR_CODES.INVALID_VALUE, '/id', 'id must be a non-empty string');
    } else if (id.length > 128) {
      report(ERROR_CODES.INVALID_VALUE, '/id', 'id must be at most 128 characters');
    } else if (!PLUGIN_ID_PATTERN.test(id)) {
      report(
        ERROR_CODES.INVALID_VALUE,
        '/id',
        'id must be a lowercase reverse DNS name such as "com.example.anomaly-notes"',
      );
    } else if (RESERVED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
      report(
        ERROR_CODES.INVALID_VALUE,
        '/id',
        `id prefix is reserved for built-in plugins (${RESERVED_ID_PREFIXES.join(', ')})`,
      );
    } else {
      pluginId = id;
      manifest.id = id;
    }
  }

  if (Object.hasOwn(raw, 'name')) {
    const name = raw.name;
    if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
      report(ERROR_CODES.INVALID_VALUE, '/name', 'name must be a string of 1 to 64 characters');
    } else if (CONTROL_CHARACTERS.test(name)) {
      report(ERROR_CODES.INVALID_VALUE, '/name', 'name must not contain control characters');
    } else if (name !== name.trim()) {
      report(ERROR_CODES.INVALID_VALUE, '/name', 'name must not start or end with whitespace');
    } else {
      manifest.name = name;
    }
  }

  if (Object.hasOwn(raw, 'version')) {
    const version = raw.version;
    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
      report(
        ERROR_CODES.INVALID_VALUE,
        '/version',
        'version must be a strict semver value such as "1.0.0" or "1.0.0-beta.1"',
      );
    } else {
      manifest.version = version;
    }
  }

  if (Object.hasOwn(raw, 'api')) {
    if (raw.api !== COMPATIBILITY_PROFILE.api) {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        '/api',
        `api must be exactly "${COMPATIBILITY_PROFILE.api}"`,
      );
    } else {
      manifest.api = raw.api;
    }
  }

  validateEngine(raw, report, manifest);
  validateEntry(raw, report, manifest);
  const permissions = validatePermissions(raw, report, manifest);
  validateTextFields(raw, report, manifest);
  const tools = validateTools(raw, pluginId, report);
  if (tools !== null) manifest.tools = tools;
  validatePrompt(raw, report, manifest);
  validateConfigSchema(raw, report, manifest);
  validateCrossFieldRules(raw, permissions, report);

  if (localErrors > 0 || pluginId === null) {
    return { manifest: null, toolFullNames: [] };
  }

  const toolFullNames = (manifest.tools ?? []).map((tool) => toolFullName(pluginId, tool.name));
  return { manifest, toolFullNames };
}

function validateEngine(raw, report, manifest) {
  if (!Object.hasOwn(raw, 'engine')) return;
  const engine = raw.engine;
  if (!isPlainObject(engine)) {
    report(
      ERROR_CODES.ENGINE_MISMATCH,
      '/engine',
      'engine must be an object such as { "dsh": "0.2.2-alpha.2" }',
    );
    return;
  }
  for (const key of Object.keys(engine)) {
    if (key !== 'dsh') {
      report(
        ERROR_CODES.UNKNOWN_FIELD,
        `/engine/${key}`,
        `unknown engine field "${key}"; only "dsh" is allowed`,
      );
    }
  }
  if (!Object.hasOwn(engine, 'dsh')) {
    report(ERROR_CODES.MISSING_FIELD, '/engine/dsh', 'engine.dsh is required');
    return;
  }
  if (engine.dsh !== COMPATIBILITY_PROFILE.dsh) {
    report(
      ERROR_CODES.ENGINE_MISMATCH,
      '/engine/dsh',
      `engine.dsh must be exactly "${COMPATIBILITY_PROFILE.dsh}"`,
    );
    return;
  }
  manifest.engine = { dsh: engine.dsh };
}

function isStructurallyUnsafeEntry(value) {
  const probe = value.startsWith('./') ? value.slice(2) : value;
  if (probe === '') return false;
  if (/[\u0000-\u001f]/.test(probe)) return true;
  if (probe.includes('\\')) return true;
  if (probe.includes('%')) return true;
  if (probe.startsWith('/') || /^[A-Za-z]:/.test(probe)) return true;
  return probe.split('/').some((segment) => segment === '..');
}

function validateEntry(raw, report, manifest) {
  if (!Object.hasOwn(raw, 'entry')) return;
  const entry = raw.entry;
  // Structurally unsafe strings (parent segments, absolute paths, backslashes, percent
  // encodings, control characters) are reported as ENTRY_PATH_UNSAFE; a string that is merely
  // a different location, such as "dist/index.js", stays ENTRY_MISMATCH.
  if (typeof entry === 'string' && isStructurallyUnsafeEntry(entry)) {
    report(
      ERROR_CODES.ENTRY_PATH_UNSAFE,
      '/entry',
      `entry "${entry}" is not a safe package relative path`,
    );
    return;
  }
  if (typeof entry !== 'string' || entry !== COMPATIBILITY_PROFILE.entry) {
    report(
      ERROR_CODES.ENTRY_MISMATCH,
      '/entry',
      `entry must be exactly "${COMPATIBILITY_PROFILE.entry}"`,
    );
    return;
  }
  manifest.entry = entry;
}

function validatePermissions(raw, report, manifest) {
  if (!Object.hasOwn(raw, 'permissions')) return null;
  const permissionDiagnostics = validatePermissionList(raw.permissions);
  for (const item of permissionDiagnostics) {
    report(item.code, item.path, item.message);
  }
  if (permissionDiagnostics.length > 0) return null;
  const permissions = [...raw.permissions];
  manifest.permissions = permissions;
  return permissions;
}

function validateTextFields(raw, report, manifest) {
  for (const field of ['description', 'publisher', 'license']) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = raw[field];
    if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) {
      report(ERROR_CODES.INVALID_VALUE, `/${field}`, `${field} must be a plain string`);
      continue;
    }
    manifest[field] = value;
  }
}

function validateTools(raw, pluginId, report) {
  if (!Object.hasOwn(raw, 'tools')) return null;
  if (!Array.isArray(raw.tools)) {
    report(ERROR_CODES.SCHEMA_VIOLATION, '/tools', 'tools must be an array');
    return null;
  }
  if (raw.tools.length > COMPATIBILITY_PROFILE.limits.tools) {
    report(
      ERROR_CODES.LIMIT_EXCEEDED,
      '/tools',
      `at most ${COMPATIBILITY_PROFILE.limits.tools} tools may be declared`,
    );
  }
  const normalized = [];
  const names = new Set();
  raw.tools.forEach((tool, index) => {
    const basePath = `/tools/${index}`;
    let toolErrors = 0;
    const add = (code, path, message) => {
      toolErrors += 1;
      report(code, path, message);
    };

    if (!isPlainObject(tool)) {
      add(ERROR_CODES.SCHEMA_VIOLATION, basePath, 'each tool must be an object');
      return;
    }
    for (const key of Object.keys(tool)) {
      if (!TOOL_FIELD_SET.has(key)) {
        add(ERROR_CODES.UNKNOWN_FIELD, `${basePath}/${key}`, `unknown tool field "${key}"`);
      }
    }
    for (const field of ['name', 'description', 'inputSchema', 'outputSchema']) {
      if (!Object.hasOwn(tool, field)) {
        add(ERROR_CODES.MISSING_FIELD, `${basePath}/${field}`, `missing tool field "${field}"`);
      }
    }

    if (Object.hasOwn(tool, 'name')) {
      if (!isValidToolName(tool.name)) {
        add(
          ERROR_CODES.TOOL_NAME_INVALID,
          `${basePath}/name`,
          'tool name must match /^[a-z][a-z0-9_]{0,30}$/',
        );
      } else if (names.has(tool.name)) {
        add(ERROR_CODES.DUPLICATE_ENTRY, `${basePath}/name`, `duplicate tool name "${tool.name}"`);
      } else {
        names.add(tool.name);
      }
    }

    if (Object.hasOwn(tool, 'description')) {
      const description = tool.description;
      if (typeof description !== 'string' || description.length < 1 || description.length > 512) {
        add(
          ERROR_CODES.INVALID_VALUE,
          `${basePath}/description`,
          'tool description must be a string of 1 to 512 characters',
        );
      } else if (CONTROL_CHARACTERS.test(description)) {
        add(
          ERROR_CODES.INVALID_VALUE,
          `${basePath}/description`,
          'tool description must not contain control characters',
        );
      }
    }

    for (const field of ['inputSchema', 'outputSchema']) {
      if (!Object.hasOwn(tool, field)) continue;
      if (!isPlainObject(tool[field])) {
        add(ERROR_CODES.SCHEMA_VIOLATION, `${basePath}/${field}`, `${field} must be an object`);
        continue;
      }
      assertClosedSchema(tool[field], {
        path: `${basePath}/${field}`,
        diagnostics: { add },
        label: `${field} of tool ${typeof tool.name === 'string' ? tool.name : index}`,
      });
    }

    if (Object.hasOwn(tool, 'timeoutMs')) {
      const timeout = tool.timeoutMs;
      if (
        !Number.isInteger(timeout) ||
        timeout < 1 ||
        timeout > COMPATIBILITY_PROFILE.limits.toolTimeoutMs
      ) {
        add(
          ERROR_CODES.INVALID_VALUE,
          `${basePath}/timeoutMs`,
          `timeoutMs must be an integer between 1 and ${COMPATIBILITY_PROFILE.limits.toolTimeoutMs}`,
        );
      }
    }

    if (toolErrors === 0 && typeof pluginId === 'string') {
      normalized.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        timeoutMs: Object.hasOwn(tool, 'timeoutMs')
          ? tool.timeoutMs
          : COMPATIBILITY_PROFILE.limits.toolTimeoutMs,
      });
    }
  });
  return normalized;
}

function validatePrompt(raw, report, manifest) {
  if (!Object.hasOwn(raw, 'prompt')) return;
  const prompt = raw.prompt;
  if (!isPlainObject(prompt)) {
    report(ERROR_CODES.PROMPT_INVALID, '/prompt', 'prompt must be an object');
    return;
  }
  let promptErrors = 0;
  const add = (code, path, message) => {
    promptErrors += 1;
    report(code, path, message);
  };

  for (const key of Object.keys(prompt)) {
    if (!PROMPT_FIELD_SET.has(key)) {
      add(ERROR_CODES.PROMPT_INVALID, `/prompt/${key}`, `unknown prompt field "${key}"`);
    }
  }
  for (const field of PROMPT_FIELDS) {
    if (!Object.hasOwn(prompt, field)) {
      add(ERROR_CODES.MISSING_FIELD, `/prompt/${field}`, `missing prompt field "${field}"`);
    }
  }

  if (Object.hasOwn(prompt, 'role') && prompt.role !== 'user') {
    add(
      ERROR_CODES.PROMPT_INVALID,
      '/prompt/role',
      'prompt role must be "user"; plugin text never enters the system role',
    );
  }
  if (Object.hasOwn(prompt, 'position') && prompt.position !== 'analysis-context') {
    add(ERROR_CODES.PROMPT_INVALID, '/prompt/position', 'prompt position must be "analysis-context"');
  }

  let byteLength = 0;
  if (Object.hasOwn(prompt, 'text')) {
    const text = prompt.text;
    if (typeof text !== 'string' || text.length === 0) {
      add(ERROR_CODES.PROMPT_INVALID, '/prompt/text', 'prompt text must be a non-empty string');
    } else {
      byteLength = Buffer.byteLength(text, 'utf8');
      if (byteLength > COMPATIBILITY_PROFILE.limits.promptBytes) {
        add(
          ERROR_CODES.PROMPT_INVALID,
          '/prompt/text',
          `prompt text is ${byteLength} UTF-8 bytes, the limit is ${COMPATIBILITY_PROFILE.limits.promptBytes}`,
        );
      }
      for (const character of text) {
        if (!CONTROL_CHARACTERS.test(character)) continue;
        if (PROMPT_ALLOWED_CONTROLS.has(character)) continue;
        add(
          ERROR_CODES.PROMPT_INVALID,
          '/prompt/text',
          'prompt text must not contain control characters other than tab and newline',
        );
        break;
      }
    }
  }

  if (promptErrors === 0) {
    // The manifest keeps only the declared fields; the byte size is reported by inspect.
    manifest.prompt = { role: prompt.role, position: prompt.position, text: prompt.text };
  }
}

/**
 * 在 `configSchema` 里递归找第一个带控制符（含 DEL / C1）的字符串（DEF-05）。
 *
 * 为什么需要这一步：`configSchema` 是**参与摘要与批准**的内容（overlay 的
 * `manifestSha256` 覆盖它），但白名单校验只检查关键字与类型，不检查字符串内容。
 * 于是 `"\u009b"` 这种 C1 字符可以出现在 title / description / enum / property 名里，
 * 在插件侧完全合法、在事件侧被 contracts 拒绝，两个组件对同一份内容判断不一致。
 *
 * 扫描是有界的：深度上限 + 节点预算，避免一份畸形 schema 把校验变成 DoS。
 * 返回值是出错位置的 JSON Pointer 片段，或 `null`。
 */
const MAX_CONTROL_SCAN_DEPTH = 16;
const MAX_CONTROL_SCAN_NODES = 4096;

function findControlCharacter(value, path, depth, budget) {
  if (budget.nodes <= 0 || depth > MAX_CONTROL_SCAN_DEPTH) return null;
  budget.nodes -= 1;
  if (typeof value === 'string') {
    return CONTROL_CHARACTERS.test(value) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findControlCharacter(value[index], `${path}/${index}`, depth + 1, budget);
      if (found !== null) return found;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (CONTROL_CHARACTERS.test(key)) return `${path}/${escapePointerSegment(key)}`;
      const found = findControlCharacter(value[key], `${path}/${escapePointerSegment(key)}`, depth + 1, budget);
      if (found !== null) return found;
    }
  }
  return null;
}

function validateConfigSchema(raw, report, manifest) {
  if (!Object.hasOwn(raw, 'configSchema')) return;
  if (!isPlainObject(raw.configSchema)) {
    report(ERROR_CODES.SCHEMA_VIOLATION, '/configSchema', 'configSchema must be an object');
    return;
  }
  if (raw.configSchema.type !== 'object') {
    report(
      ERROR_CODES.SCHEMA_VIOLATION,
      '/configSchema/type',
      'configSchema must declare "type": "object" at its root',
    );
  }
  assertClosedSchema(raw.configSchema, {
    path: '/configSchema',
    diagnostics: { add: report },
    label: 'configSchema',
  });
  const controlPath = findControlCharacter(
    raw.configSchema,
    '/configSchema',
    0,
    { nodes: MAX_CONTROL_SCAN_NODES },
  );
  if (controlPath !== null) {
    report(
      ERROR_CODES.SCHEMA_VIOLATION,
      controlPath,
      'configSchema strings must not contain control characters (C0, DEL or C1)',
    );
    return;
  }
  manifest.configSchema = raw.configSchema;
}

function validateCrossFieldRules(raw, permissions, report) {
  const permissionSet = new Set(Array.isArray(permissions) ? permissions : []);
  const hasTools = Array.isArray(raw.tools) && raw.tools.length > 0;
  if (hasTools && !permissionSet.has('analysis.tool.register')) {
    report(
      ERROR_CODES.PERMISSION_CONFLICT,
      '/permissions',
      'declaring tools requires the "analysis.tool.register" permission',
    );
  }
  if (permissionSet.has('analysis.tool.register') && !hasTools) {
    report(
      ERROR_CODES.PERMISSION_CONFLICT,
      '/tools',
      'the "analysis.tool.register" permission requires a non-empty tools array',
    );
  }
  const hasPrompt = Object.hasOwn(raw, 'prompt');
  if (hasPrompt && !permissionSet.has('analysis.prompt.contribute')) {
    report(
      ERROR_CODES.PERMISSION_CONFLICT,
      '/permissions',
      'declaring a prompt requires the "analysis.prompt.contribute" permission',
    );
  }
  if (permissionSet.has('analysis.prompt.contribute') && !hasPrompt) {
    report(
      ERROR_CODES.PERMISSION_CONFLICT,
      '/prompt',
      'the "analysis.prompt.contribute" permission requires a prompt contribution',
    );
  }
}
