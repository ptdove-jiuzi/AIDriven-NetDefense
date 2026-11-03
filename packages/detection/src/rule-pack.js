/**
 * rule-pack.js — rule pack validation, compilation and the only file reader of
 * the package.
 *
 * Rule packs are pure declarations. Validation runs once at registration time,
 * rejects unknown keys, and compiles every expression so runtime evaluation can
 * never reach an unvalidated shape.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileAllowlist } from './allowlist.js';
import { RuleDefinitionError } from './errors.js';
import { compileExpression } from './expression.js';
import { FINGERPRINT_TRANSFORMS, isValidPath } from './normalize.js';
import { isSeverity } from './severity.js';

/** Supported rule pack schema version. */
export const SUPPORTED_SCHEMA_VERSION = '1.0';

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

const COMMON_RULE_KEYS = [
  'ruleId',
  'version',
  'type',
  'enabled',
  'severity',
  'severityFrom',
  'fields',
  'fingerprint',
  'tags',
  'description',
];

const TYPE_RULE_KEYS = {
  condition: ['when'],
  threshold: ['when', 'groupBy', 'count', 'windowMs', 'maxEvents'],
  correlation: ['steps', 'withinMs', 'groupBy'],
};

const PACK_KEYS = ['schemaVersion', 'packId', 'packVersion', 'minEngineVersion', 'signature', 'rules', 'allowlist'];

const COMPILED_PACK = Symbol('compiledRulePack');

/**
 * Load and validate a rule pack from a JSON file.
 *
 * This is the single place in the package that touches the filesystem.
 *
 * @param {string} filePath Absolute or relative path to a JSON rule pack.
 * @returns {object} Compiled rule pack.
 * @throws {RuleDefinitionError} With `code` set to `RULE_PACK_PATH_INVALID`,
 *   `RULE_PACK_UNREADABLE`, `RULE_PACK_PARSE_ERROR`, `RULE_PACK_VERSION_MISMATCH`
 *   or a rule validation code.
 */
export function loadRulePack(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new RuleDefinitionError('rule pack path must be a non-empty string', {
      code: 'RULE_PACK_PATH_INVALID',
    });
  }
  const resolvedPath = resolve(filePath);
  let text;
  try {
    text = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    throw new RuleDefinitionError(`rule pack is not readable: ${resolvedPath}`, {
      code: 'RULE_PACK_UNREADABLE',
      detail: { path: resolvedPath, reason: errorCodeOf(error) },
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RuleDefinitionError(`rule pack is not valid JSON: ${resolvedPath}`, {
      code: 'RULE_PACK_PARSE_ERROR',
      detail: { path: resolvedPath, reason: errorCodeOf(error) },
    });
  }
  return validateRulePack(parsed);
}

/**
 * Validate and compile an in-memory rule pack.
 *
 * @param {unknown} pack Candidate rule pack.
 * @returns {{
 *   schemaVersion: string,
 *   packId: string,
 *   packVersion: string,
 *   minEngineVersion: string | null,
 *   signature: object | null,
 *   rules: readonly object[],
 *   allowlist: readonly object[]
 * }} Compiled pack.
 * @throws {RuleDefinitionError} When the pack is malformed or a rule is invalid.
 */
export function validateRulePack(pack) {
  if (isCompiledRulePack(pack)) {
    return pack;
  }
  if (pack === null || typeof pack !== 'object' || Array.isArray(pack)) {
    throw new RuleDefinitionError('rule pack must be an object', { code: 'RULE_PACK_SHAPE', path: 'pack' });
  }
  for (const key of Object.keys(pack)) {
    if (!PACK_KEYS.includes(key)) {
      throw new RuleDefinitionError(`rule pack has unknown key ${key}`, {
        code: 'RULE_PACK_UNKNOWN_KEY',
        path: 'pack',
        detail: { keys: Object.keys(pack) },
      });
    }
  }
  if (pack.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new RuleDefinitionError(
      `rule pack schemaVersion must be ${SUPPORTED_SCHEMA_VERSION}, received ${String(pack.schemaVersion)}`,
      { code: 'RULE_PACK_VERSION_MISMATCH', path: 'schemaVersion' },
    );
  }
  const packId = requireNonEmptyString(pack.packId, 'packId');
  const packVersion = requireVersion(pack.packVersion, 'packVersion');
  if (pack.minEngineVersion !== undefined) {
    requireVersion(pack.minEngineVersion, 'minEngineVersion');
  }
  if (pack.signature !== undefined) {
    validateSignature(pack.signature);
  }
  if (!Array.isArray(pack.rules)) {
    throw new RuleDefinitionError('rule pack rules must be an array', { code: 'RULE_PACK_RULES', path: 'rules' });
  }
  if (pack.rules.length === 0) {
    throw new RuleDefinitionError('rule pack must declare at least one rule', {
      code: 'RULE_PACK_RULES',
      path: 'rules',
    });
  }
  const ruleIds = new Set();
  const rules = pack.rules.map((rule, index) => compileRule(rule, index, ruleIds));
  const allowlist = compileAllowlist(pack.allowlist, {
    declaredRuleIds: ruleIds,
    path: 'allowlist',
  });
  const compiled = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    packId,
    packVersion,
    minEngineVersion: pack.minEngineVersion ?? null,
    signature: pack.signature === undefined ? null : Object.freeze({ ...pack.signature }),
    rules: Object.freeze(rules),
    allowlist,
  };
  Object.defineProperty(compiled, COMPILED_PACK, { value: true, enumerable: false });
  return Object.freeze(compiled);
}

/**
 * Report whether a value is an already compiled rule pack.
 *
 * @param {unknown} pack Candidate value.
 * @returns {boolean} `true` for packs produced by {@link validateRulePack} or {@link loadRulePack}.
 */
export function isCompiledRulePack(pack) {
  return pack !== null && typeof pack === 'object' && pack[COMPILED_PACK] === true;
}

function compileRule(rule, index, ruleIds) {
  const path = `rules[${index}]`;
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new RuleDefinitionError('rule must be an object', { code: 'RULE_SHAPE', path });
  }
  const type = rule.type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(TYPE_RULE_KEYS, type)) {
    throw new RuleDefinitionError(`rule type must be condition, threshold or correlation, received ${String(type)}`, {
      code: 'RULE_TYPE_INVALID',
      path: `${path}.type`,
    });
  }
  const allowedKeys = [...COMMON_RULE_KEYS, ...TYPE_RULE_KEYS[type]];
  for (const key of Object.keys(rule)) {
    if (!allowedKeys.includes(key)) {
      throw new RuleDefinitionError(`rule has unknown key ${key}`, {
        code: 'RULE_UNKNOWN_KEY',
        path,
        detail: { keys: Object.keys(rule) },
      });
    }
  }
  const ruleId = rule.ruleId;
  if (typeof ruleId !== 'string' || !RULE_ID_PATTERN.test(ruleId)) {
    throw new RuleDefinitionError(`ruleId must match ${RULE_ID_PATTERN.source}`, {
      code: 'RULE_ID_INVALID',
      path: `${path}.ruleId`,
    });
  }
  if (ruleIds.has(ruleId)) {
    throw new RuleDefinitionError(`duplicate ruleId ${ruleId}`, { code: 'RULE_ID_DUPLICATE', path: `${path}.ruleId` });
  }
  ruleIds.add(ruleId);
  const version = requireVersion(rule.version, `${path}.version`);
  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
    throw new RuleDefinitionError('rule enabled must be a boolean', { code: 'RULE_SHAPE', path: `${path}.enabled` });
  }
  const fields = requireFields(rule.fields, path);
  const declaredFields = new Set(fields);
  let groupBy = null;
  if (type === 'threshold') {
    groupBy = requireGroupBy(rule.groupBy, declaredFields, path);
  } else if (type === 'correlation' && rule.groupBy !== undefined) {
    groupBy = requireGroupBy(rule.groupBy, declaredFields, path);
  }
  const severity = rule.severity;
  if (severity !== undefined && !isSeverity(severity)) {
    throw new RuleDefinitionError('rule severity must be a known severity level', {
      code: 'RULE_SEVERITY_INVALID',
      path: `${path}.severity`,
    });
  }
  if (rule.severityFrom !== undefined && !declaredFields.has(rule.severityFrom)) {
    throw new RuleDefinitionError(`severityFrom reads undeclared field ${String(rule.severityFrom)}`, {
      code: 'RULE_FIELD_UNDECLARED',
      path: `${path}.severityFrom`,
    });
  }
  if (severity === undefined) {
    throw new RuleDefinitionError('rule must declare a static severity level', {
      code: 'RULE_SEVERITY_INVALID',
      path: `${path}.severity`,
    });
  }
  const fingerprint = compileFingerprint(rule.fingerprint, groupBy ?? fields, declaredFields, path);
  const tags = compileTags(rule.tags, path);
  if (rule.description !== undefined && (typeof rule.description !== 'string' || rule.description.length > 200)) {
    throw new RuleDefinitionError('rule description must be a string of at most 200 characters', {
      code: 'RULE_SHAPE',
      path: `${path}.description`,
    });
  }
  const base = {
    ruleId,
    version,
    type,
    enabled: rule.enabled !== false,
    severity: severity ?? null,
    severityFrom: rule.severityFrom ?? null,
    fields: Object.freeze([...fields]),
    fingerprint,
    tags,
    description: rule.description ?? '',
  };
  if (type === 'condition') {
    return Object.freeze({
      ...base,
      when: compileExpression(rule.when, { declaredFields, path: `${path}.when` }),
      groupBy: null,
    });
  }
  if (type === 'threshold') {
    return Object.freeze({
      ...base,
      when: rule.when === undefined ? null : compileExpression(rule.when, { declaredFields, path: `${path}.when` }),
      groupBy: Object.freeze(groupBy),
      count: compileCount(rule.count, path),
      windowMs: requireIntegerInRange(rule.windowMs, `${path}.windowMs`, 1000, 3600000),
      maxEvents:
        rule.maxEvents === undefined ? null : requireIntegerInRange(rule.maxEvents, `${path}.maxEvents`, 1, 100000),
      steps: null,
      withinMs: null,
    });
  }
  return Object.freeze({
    ...base,
    when: null,
    steps: compileSteps(rule.steps, declaredFields, path),
    withinMs: requireIntegerInRange(rule.withinMs, `${path}.withinMs`, 1000, 3600000),
    groupBy: groupBy === null ? null : Object.freeze(groupBy),
    count: null,
    maxEvents: null,
  });
}

function compileFingerprint(specification, defaultPaths, declaredFields, path) {
  if (specification === undefined) {
    return Object.freeze(defaultPaths.map((field) => Object.freeze({ path: field, transform: 'none' })));
  }
  if (!Array.isArray(specification) || specification.length < 1 || specification.length > 8) {
    throw new RuleDefinitionError('fingerprint must declare 1..8 fields', {
      code: 'RULE_FINGERPRINT_INVALID',
      path: `${path}.fingerprint`,
    });
  }
  const compiled = specification.map((item, index) => {
    const itemPath = `${path}.fingerprint[${index}]`;
    if (typeof item === 'string') {
      return compileFingerprintItem(item, 'none', declaredFields, itemPath);
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new RuleDefinitionError('fingerprint item must be a path string or { path, transform }', {
        code: 'RULE_FINGERPRINT_INVALID',
        path: itemPath,
      });
    }
    for (const key of Object.keys(item)) {
      if (key !== 'path' && key !== 'transform') {
        throw new RuleDefinitionError(`fingerprint item has unknown key ${key}`, {
          code: 'RULE_FINGERPRINT_INVALID',
          path: itemPath,
        });
      }
    }
    const transform = item.transform ?? 'none';
    if (!FINGERPRINT_TRANSFORMS.includes(transform)) {
      throw new RuleDefinitionError(`fingerprint transform must be one of ${FINGERPRINT_TRANSFORMS.join(', ')}`, {
        code: 'RULE_FINGERPRINT_INVALID',
        path: `${itemPath}.transform`,
      });
    }
    return compileFingerprintItem(item.path, transform, declaredFields, itemPath);
  });
  return Object.freeze(compiled);
}

function compileFingerprintItem(fieldPath, transform, declaredFields, path) {
  if (!isValidPath(fieldPath)) {
    throw new RuleDefinitionError(`fingerprint path is not usable: ${String(fieldPath)}`, {
      code: 'RULE_FINGERPRINT_INVALID',
      path,
    });
  }
  if (!declaredFields.has(fieldPath)) {
    throw new RuleDefinitionError(`fingerprint reads undeclared field ${fieldPath}`, {
      code: 'RULE_FIELD_UNDECLARED',
      path,
    });
  }
  return Object.freeze({ path: fieldPath, transform });
}

function compileTags(tags, path) {
  if (tags === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(tags) || tags.length > 8) {
    throw new RuleDefinitionError('tags must be an array of at most 8 strings', {
      code: 'RULE_TAGS_INVALID',
      path: `${path}.tags`,
    });
  }
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > 32) {
      throw new RuleDefinitionError('each tag must be a non-empty string of at most 32 characters', {
        code: 'RULE_TAGS_INVALID',
        path: `${path}.tags`,
      });
    }
  }
  return Object.freeze([...tags]);
}

function compileSteps(steps, declaredFields, path) {
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 8) {
    throw new RuleDefinitionError('correlation steps must contain 2..8 entries', {
      code: 'RULE_STEPS_INVALID',
      path: `${path}.steps`,
    });
  }
  const names = new Set();
  return Object.freeze(
    steps.map((step, index) => {
      const stepPath = `${path}.steps[${index}]`;
      if (step === null || typeof step !== 'object' || Array.isArray(step)) {
        throw new RuleDefinitionError('correlation step must be an object', {
          code: 'RULE_STEPS_INVALID',
          path: stepPath,
        });
      }
      for (const key of Object.keys(step)) {
        if (key !== 'name' && key !== 'when') {
          throw new RuleDefinitionError(`correlation step has unknown key ${key}`, {
            code: 'RULE_STEPS_INVALID',
            path: stepPath,
          });
        }
      }
      const name = step.name;
      if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
        throw new RuleDefinitionError('correlation step name must be a non-empty string of at most 64 characters', {
          code: 'RULE_STEPS_INVALID',
          path: `${stepPath}.name`,
        });
      }
      if (names.has(name)) {
        throw new RuleDefinitionError(`duplicate correlation step name ${name}`, {
          code: 'RULE_STEPS_INVALID',
          path: `${stepPath}.name`,
        });
      }
      names.add(name);
      return Object.freeze({
        name,
        when: compileExpression(step.when, { declaredFields, path: `${stepPath}.when` }),
      });
    }),
  );
}

function compileCount(count, path) {
  if (count === null || typeof count !== 'object' || Array.isArray(count)) {
    throw new RuleDefinitionError('threshold count must be an object', {
      code: 'RULE_COUNT_INVALID',
      path: `${path}.count`,
    });
  }
  for (const key of Object.keys(count)) {
    if (key !== 'operator' && key !== 'value') {
      throw new RuleDefinitionError(`threshold count has unknown key ${key}`, {
        code: 'RULE_COUNT_INVALID',
        path: `${path}.count`,
      });
    }
  }
  if (count.operator !== 'gte') {
    throw new RuleDefinitionError('threshold count operator must be gte', {
      code: 'RULE_COUNT_INVALID',
      path: `${path}.count.operator`,
    });
  }
  return Object.freeze({
    operator: 'gte',
    value: requireIntegerInRange(count.value, `${path}.count.value`, 1, 100000),
  });
}

function requireFields(fields, path) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 32) {
    throw new RuleDefinitionError('rule fields must declare 1..32 readable field paths', {
      code: 'RULE_FIELDS_INVALID',
      path: `${path}.fields`,
    });
  }
  const seen = new Set();
  for (const field of fields) {
    if (!isValidPath(field)) {
      throw new RuleDefinitionError(`field path is not usable: ${String(field)}`, {
        code: 'RULE_FIELDS_INVALID',
        path: `${path}.fields`,
      });
    }
    if (seen.has(field)) {
      throw new RuleDefinitionError(`duplicate field path ${field}`, {
        code: 'RULE_FIELDS_INVALID',
        path: `${path}.fields`,
      });
    }
    seen.add(field);
  }
  return fields;
}

function requireGroupBy(groupBy, declaredFields, path) {
  if (!Array.isArray(groupBy) || groupBy.length < 1 || groupBy.length > 4) {
    throw new RuleDefinitionError('groupBy must declare 1..4 field paths', {
      code: 'RULE_GROUPBY_INVALID',
      path: `${path}.groupBy`,
    });
  }
  for (const field of groupBy) {
    if (!isValidPath(field)) {
      throw new RuleDefinitionError(`groupBy path is not usable: ${String(field)}`, {
        code: 'RULE_GROUPBY_INVALID',
        path: `${path}.groupBy`,
      });
    }
    if (!declaredFields.has(field)) {
      throw new RuleDefinitionError(`groupBy reads undeclared field ${field}`, {
        code: 'RULE_FIELD_UNDECLARED',
        path: `${path}.groupBy`,
      });
    }
  }
  return [...groupBy];
}

function requireIntegerInRange(value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RuleDefinitionError(`${path} must be an integer in ${min}..${max}`, {
      code: 'RULE_RANGE_INVALID',
      path,
      detail: { min, max },
    });
  }
  return value;
}

function requireNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new RuleDefinitionError(`${path} must be a non-empty string of at most 128 characters`, {
      code: 'RULE_PACK_SHAPE',
      path,
    });
  }
  return value;
}

function requireVersion(value, path) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new RuleDefinitionError(`${path} must be a semantic version like 1.2.3`, {
      code: 'RULE_VERSION_INVALID',
      path,
    });
  }
  return value;
}

function validateSignature(signature) {
  if (signature === null || typeof signature !== 'object' || Array.isArray(signature)) {
    throw new RuleDefinitionError('signature must be an object', { code: 'RULE_SIGNATURE_INVALID', path: 'signature' });
  }
  for (const key of Object.keys(signature)) {
    if (key !== 'algorithm' && key !== 'keyId' && key !== 'value') {
      throw new RuleDefinitionError(`signature has unknown key ${key}`, {
        code: 'RULE_SIGNATURE_INVALID',
        path: 'signature',
      });
    }
  }
  for (const key of ['algorithm', 'keyId', 'value']) {
    if (typeof signature[key] !== 'string' || signature[key].length === 0) {
      throw new RuleDefinitionError(`signature.${key} must be a non-empty string`, {
        code: 'RULE_SIGNATURE_INVALID',
        path: `signature.${key}`,
      });
    }
  }
}

function errorCodeOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return error.code;
  }
  return 'unknown';
}
