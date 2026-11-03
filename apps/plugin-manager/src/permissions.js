// AegisHarness plugin manager — author: PT-dove
// The six permissions, the four allowed inject names and the tool naming contract.

import { ERROR_CODES } from './errors.js';

export const PERMISSIONS = Object.freeze([
  'analysis.dto.read',
  'analysis.tool.register',
  'analysis.prompt.contribute',
  'analysis.event.subscribe',
  'analysis.report.render',
  'session.scratch.write',
]);

export const INJECT_NAMES = Object.freeze([
  'aegisAnalysis',
  'aegisReport',
  'aegisScratch',
  'aegisLogger',
]);

export const ALLOWED_EVENTS = Object.freeze([
  'analysis.started',
  'dto.received',
  'tool.completed',
  'finished',
]);

export const ALLOWED_EXPORTS = Object.freeze(['apply', 'dispose', 'inject']);

export const PERMISSION_API = Object.freeze({
  'analysis.dto.read': 'analysis.getDto',
  'analysis.tool.register': 'tools.register',
  'analysis.prompt.contribute': 'manifest.prompt',
  'analysis.event.subscribe': 'analysis.subscribe',
  'analysis.report.render': 'report.registerRenderer',
  'session.scratch.write': 'scratch',
});

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidToolName(name) {
  return typeof name === 'string' && TOOL_NAME_PATTERN.test(name);
}

/**
 * @param {string} pluginId
 * @param {string} toolName
 * @returns {string}
 */
export function toolFullName(pluginId, toolName) {
  return `plugin.${pluginId}.${toolName}`;
}

/**
 * Validates a permission list and returns the resulting diagnostics as plain data.
 * @param {unknown} list
 * @returns {Array<{code: string, path: string, message: string}>}
 */
export function validatePermissionList(list) {
  /** @type {Array<{code: string, path: string, message: string}>} */
  const out = [];
  if (!Array.isArray(list)) {
    out.push({
      code: ERROR_CODES.INVALID_VALUE,
      path: '/permissions',
      message: 'permissions must be an array of permission strings',
    });
    return out;
  }
  if (list.length > PERMISSIONS.length) {
    out.push({
      code: ERROR_CODES.LIMIT_EXCEEDED,
      path: '/permissions',
      message: `at most ${PERMISSIONS.length} permissions may be declared`,
    });
  }
  const seen = new Set();
  list.forEach((entry, index) => {
    const path = `/permissions/${index}`;
    if (typeof entry !== 'string') {
      out.push({
        code: ERROR_CODES.INVALID_VALUE,
        path,
        message: 'permission entries must be strings',
      });
      return;
    }
    if (!PERMISSIONS.includes(entry)) {
      out.push({
        code: ERROR_CODES.UNSUPPORTED_PERMISSION,
        path,
        message: `unsupported permission "${entry}"; allowed: ${PERMISSIONS.join(', ')}`,
      });
      return;
    }
    if (seen.has(entry)) {
      out.push({
        code: ERROR_CODES.DUPLICATE_ENTRY,
        path,
        message: `duplicate permission "${entry}"`,
      });
      return;
    }
    seen.add(entry);
  });
  return out;
}
