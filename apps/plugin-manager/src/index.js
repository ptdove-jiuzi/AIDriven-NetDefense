// AegisHarness plugin manager — author: PT-dove
// Public surface of the offline plugin directory checker. This package inspects
// already unpacked directories; it never unpacks, installs, enables or runs plugins.

export const PLUGIN_MANAGER_CAPABILITIES = Object.freeze({
  installs: false,
  unpacksArchives: false,
  enablesPlugins: false,
  executesPluginCode: false,
  writesFiles: false,
  network: false,
});

export { ERROR_CODES, PluginCheckError } from './errors.js';
export { createDiagnostics, pushDiagnostic } from './diagnostics.js';
export { decodeUtf8Strict, parseStrictJson } from './json.js';
export { canonicalize, canonicalizeJson, digestOf, sha256Hex } from './jcs.js';
export { COMPATIBILITY_PROFILE } from './profile.js';
export {
  ALLOWED_EVENTS,
  ALLOWED_EXPORTS,
  INJECT_NAMES,
  PERMISSIONS,
  PERMISSION_API,
  TOOL_NAME_PATTERN,
  isValidToolName,
  toolFullName,
  validatePermissionList,
} from './permissions.js';
export {
  ALLOWED_SCHEMA_KEYWORDS,
  assertClosedSchema,
  validateAgainstSchema,
} from './schema.js';
export { PACKAGE_JSON_ALLOWED_FIELDS, validatePackageJson } from './package-manifest.js';
export {
  PLUGIN_JSON_OPTIONAL_FIELDS,
  PLUGIN_JSON_REQUIRED_FIELDS,
  assertSafeRelativePath,
  validatePluginJson,
} from './plugin-manifest.js';
export { collectModuleGraph, scanModuleSource, tokenize } from './source-scan.js';
export {
  OVERLAY_ALLOWED_FIELDS,
  OVERLAY_PLUGIN_ALLOWED_FIELDS,
  buildEffectiveManifest,
  deriveSecurityProjection,
  validateOverlay,
} from './overlay.js';
export { inspectPluginDirectory } from './inspect.js';
