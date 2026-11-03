// AegisHarness plugin manager — author: PT-dove
// Closed JSON Schema subset. Anything outside the whitelist is a hard violation, so a
// manifest can never smuggle in remote references, unions or pattern based keywords.

import { ERROR_CODES } from './errors.js';

export const ALLOWED_SCHEMA_KEYWORDS = Object.freeze([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'enum',
  'const',
  'title',
  'description',
]);

const KEYWORDS = new Set(ALLOWED_SCHEMA_KEYWORDS);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const TYPE_KEYWORDS = Object.freeze({
  object: new Set(['properties', 'required', 'additionalProperties']),
  array: new Set(['items', 'minItems', 'maxItems']),
  string: new Set(['minLength', 'maxLength']),
  number: new Set(['minimum', 'maximum']),
  integer: new Set(['minimum', 'maximum']),
  boolean: new Set(),
  null: new Set(),
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isJsonScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

export function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

export function escapePointerSegment(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function typeMatches(declared, value) {
  const actual = jsonTypeOf(value);
  if (declared === 'number') return actual === 'number' || actual === 'integer';
  return declared === actual;
}

function joinPath(base, segment) {
  return `${base}/${escapePointerSegment(segment)}`;
}

function checkSubSchema(schema, path, diagnostics, label) {
  assertClosedSchema(schema, { path, diagnostics, label });
}

/**
 * Validates the schema document itself (not an instance).
 * @param {unknown} schema
 * @param {{path?: string, diagnostics: {add: Function}, label?: string}} options
 */
export function assertClosedSchema(schema, options = {}) {
  const { path = '', diagnostics, label = 'schema' } = options;
  const report = (code, at, message) => diagnostics.add(code, at, message);
  const where = path === '' ? '/' : path;

  if (!isPlainObject(schema)) {
    report(ERROR_CODES.SCHEMA_VIOLATION, path, `${label}: schema at ${where} must be an object`);
    return;
  }

  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, key),
        `${label}: unsupported schema keyword "${key}" at ${where}`,
      );
    }
  }

  const declaredType = schema.type;
  if (typeof declaredType !== 'string' || !TYPES.has(declaredType)) {
    report(
      ERROR_CODES.SCHEMA_VIOLATION,
      joinPath(path, 'type'),
      `${label}: schema at ${where} must declare exactly one type out of object/array/string/number/integer/boolean/null`,
    );
  }

  for (const annotation of ['title', 'description']) {
    if (annotation in schema && typeof schema[annotation] !== 'string') {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, annotation),
        `${label}: "${annotation}" must be a string`,
      );
    }
  }

  if (typeof declaredType === 'string' && TYPES.has(declaredType)) {
    const allowedHere = TYPE_KEYWORDS[declaredType];
    for (const key of Object.keys(schema)) {
      if (!KEYWORDS.has(key)) continue;
      if (['type', 'title', 'description', 'enum', 'const'].includes(key)) continue;
      if (!allowedHere.has(key)) {
        report(
          ERROR_CODES.SCHEMA_VIOLATION,
          joinPath(path, key),
          `${label}: keyword "${key}" is not valid for type "${declaredType}"`,
        );
      }
    }
  }

  if (declaredType === 'object') {
    if (!isPlainObject(schema.properties)) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, 'properties'),
        `${label}: object schema at ${where} must declare a "properties" object`,
      );
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        checkSubSchema(sub, joinPath(joinPath(path, 'properties'), name), diagnostics, label);
      }
    }
    if (schema.additionalProperties !== false) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, 'additionalProperties'),
        `${label}: object schema at ${where} must set "additionalProperties": false`,
      );
    }
    if ('required' in schema) {
      if (!Array.isArray(schema.required)) {
        report(
          ERROR_CODES.SCHEMA_VIOLATION,
          joinPath(path, 'required'),
          `${label}: "required" must be an array of property names`,
        );
      } else {
        const seen = new Set();
        schema.required.forEach((name, index) => {
          if (typeof name !== 'string') {
            report(
              ERROR_CODES.SCHEMA_VIOLATION,
              joinPath(joinPath(path, 'required'), String(index)),
              `${label}: "required" entries must be strings`,
            );
            return;
          }
          if (seen.has(name)) {
            report(
              ERROR_CODES.SCHEMA_VIOLATION,
              joinPath(joinPath(path, 'required'), String(index)),
              `${label}: duplicate required entry "${name}"`,
            );
            return;
          }
          seen.add(name);
          if (!isPlainObject(schema.properties) || !Object.hasOwn(schema.properties, name)) {
            report(
              ERROR_CODES.SCHEMA_VIOLATION,
              joinPath(joinPath(path, 'required'), String(index)),
              `${label}: required property "${name}" is not declared in "properties"`,
            );
          }
        });
      }
    }
  }

  if (declaredType === 'array') {
    if (!isPlainObject(schema.items)) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, 'items'),
        `${label}: array schema at ${where} must declare a single "items" schema object`,
      );
    } else {
      checkSubSchema(schema.items, joinPath(path, 'items'), diagnostics, label);
    }
    for (const key of ['minItems', 'maxItems']) {
      if (!(key in schema)) continue;
      const bound = schema[key];
      if (!Number.isInteger(bound) || bound < 0) {
        report(
          ERROR_CODES.SCHEMA_VIOLATION,
          joinPath(path, key),
          `${label}: "${key}" must be a non-negative integer`,
        );
      }
    }
    if (
      Number.isInteger(schema.minItems) &&
      Number.isInteger(schema.maxItems) &&
      schema.minItems > schema.maxItems
    ) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, 'minItems'),
        `${label}: "minItems" must not exceed "maxItems"`,
      );
    }
  }

  if (declaredType === 'string') {
    for (const key of ['minLength', 'maxLength']) {
      if (!(key in schema)) continue;
      const bound = schema[key];
      if (!Number.isInteger(bound) || bound < 0) {
        report(
          ERROR_CODES.SCHEMA_VIOLATION,
          joinPath(path, key),
          `${label}: "${key}" must be a non-negative integer`,
        );
      }
    }
    if (
      Number.isInteger(schema.minLength) &&
      Number.isInteger(schema.maxLength) &&
      schema.minLength > schema.maxLength
    ) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, 'minLength'),
        `${label}: "minLength" must not exceed "maxLength"`,
      );
    }
  }

  if (declaredType === 'number' || declaredType === 'integer') {
    for (const key of ['minimum', 'maximum']) {
      if (!(key in schema)) continue;
      const bound = schema[key];
      if (typeof bound !== 'number' || !Number.isFinite(bound)) {
        report(
          ERROR_CODES.SCHEMA_VIOLATION,
          joinPath(path, key),
          `${label}: "${key}" must be a finite number`,
        );
      }
    }
    if (
      typeof schema.minimum === 'number' &&
      typeof schema.maximum === 'number' &&
      schema.minimum > schema.maximum
    ) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, 'minimum'),
        `${label}: "minimum" must not exceed "maximum"`,
      );
    }
  }

  if ('enum' in schema) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, 'enum'),
        `${label}: "enum" must be a non-empty array`,
      );
    } else if (typeof declaredType === 'string' && TYPES.has(declaredType)) {
      schema.enum.forEach((candidate, index) => {
        if (!typeMatches(declaredType, candidate)) {
          report(
            ERROR_CODES.SCHEMA_VIOLATION,
            joinPath(joinPath(path, 'enum'), String(index)),
            `${label}: enum entry does not match type "${declaredType}"`,
          );
        }
      });
    }
  }

  if ('const' in schema && typeof declaredType === 'string' && TYPES.has(declaredType)) {
    if (!typeMatches(declaredType, schema.const)) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        joinPath(path, 'const'),
        `${label}: "const" does not match type "${declaredType}"`,
      );
    }
  }
}

/**
 * Validates a JSON instance against an already asserted closed schema.
 * @param {unknown} schema
 * @param {unknown} value
 * @param {{path?: string, diagnostics: {add: Function}}} options
 */
export function validateAgainstSchema(schema, value, options = {}) {
  const { path = '', diagnostics } = options;
  if (!isPlainObject(schema)) return;
  const report = (code, at, message) => diagnostics.add(code, at, message);
  const declaredType = schema.type;

  if (typeof declaredType === 'string' && TYPES.has(declaredType)) {
    if (!typeMatches(declaredType, value)) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        path,
        `expected type "${declaredType}" but received "${jsonTypeOf(value)}"`,
      );
      return;
    }
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const matched = schema.enum.some((candidate) => deepJsonEqual(candidate, value));
    if (!matched) {
      report(ERROR_CODES.SCHEMA_VIOLATION, path, 'value is not part of the declared "enum"');
      return;
    }
  }

  if ('const' in schema && !deepJsonEqual(schema.const, value)) {
    report(ERROR_CODES.SCHEMA_VIOLATION, path, 'value does not equal the declared "const"');
    return;
  }

  if (declaredType === 'object' && isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) {
      if (!Object.hasOwn(value, name)) {
        report(
          ERROR_CODES.MISSING_FIELD,
          joinPath(path, name),
          `missing required property "${name}"`,
        );
      }
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        report(ERROR_CODES.UNKNOWN_FIELD, joinPath(path, key), `unknown property "${key}"`);
        continue;
      }
      validateAgainstSchema(properties[key], value[key], {
        path: joinPath(path, key),
        diagnostics,
      });
    }
    return;
  }

  if (declaredType === 'array' && Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        path,
        `array has ${value.length} entries, minimum is ${schema.minItems}`,
      );
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        path,
        `array has ${value.length} entries, maximum is ${schema.maxItems}`,
      );
    }
    if (isPlainObject(schema.items)) {
      value.forEach((entry, index) => {
        validateAgainstSchema(schema.items, entry, {
          path: joinPath(path, String(index)),
          diagnostics,
        });
      });
    }
    return;
  }

  if (declaredType === 'string' && typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        path,
        `string length ${value.length} is below the minimum ${schema.minLength}`,
      );
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      report(
        ERROR_CODES.SCHEMA_VIOLATION,
        path,
        `string length ${value.length} exceeds the maximum ${schema.maxLength}`,
      );
    }
    return;
  }

  if ((declaredType === 'number' || declaredType === 'integer') && typeof value === 'number') {
    if (!Number.isFinite(value)) {
      report(ERROR_CODES.SCHEMA_VIOLATION, path, 'number must be finite');
      return;
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      report(ERROR_CODES.SCHEMA_VIOLATION, path, `number is below the minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      report(ERROR_CODES.SCHEMA_VIOLATION, path, `number exceeds the maximum ${schema.maximum}`);
    }
  }
}

function deepJsonEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;
  if (typeof left !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    return left.every((entry, index) => deepJsonEqual(entry, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!deepJsonEqual(left[key], right[key])) return false;
  }
  return true;
}
