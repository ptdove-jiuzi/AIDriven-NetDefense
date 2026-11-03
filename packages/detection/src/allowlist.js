/**
 * allowlist.js — declarative suppression entries.
 *
 * An entry matches an event through its own expression and can be limited to a
 * set of rule identifiers. Expiry is evaluated against supplied time only, so
 * matching stays deterministic and never consults a clock.
 */

import { RuleDefinitionError } from './errors.js';
import { compileExpression, evaluateExpression } from './expression.js';

/**
 * Compile allowlist entries against the rule identifiers of the pack.
 *
 * @param {unknown} entries Raw allowlist array.
 * @param {{ declaredRuleIds: ReadonlySet<string>, path?: string }} context Compilation context.
 * @returns {readonly object[]} Frozen compiled entries.
 * @throws {RuleDefinitionError} When an entry is malformed or references an unknown rule.
 */
export function compileAllowlist(entries, context) {
  if (entries === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(entries)) {
    throw new RuleDefinitionError('allowlist must be an array', {
      code: 'RULE_ALLOWLIST_SHAPE',
      path: context.path ?? 'allowlist',
    });
  }
  const seen = new Set();
  const compiled = entries.map((entry, index) => compileEntry(entry, index, context, seen));
  return Object.freeze(compiled);
}

/**
 * Create the per-engine allowlist runtime that tracks expiry.
 *
 * @param {readonly object[]} compiledEntries Result of {@link compileAllowlist}.
 * @returns {{
 *   match: (event: object, at: number, counter: { steps: number }) => { entry: object | null, expired: number },
 *   expiredCount: () => number
 * }} Runtime handle. `expired` reports newly expired entries for the calling batch.
 */
export function createAllowlistRuntime(compiledEntries) {
  const expiredIds = new Set();

  function match(event, at, counter) {
    let expired = 0;
    let matched = null;
    for (const entry of compiledEntries) {
      if (entry.expiresAt !== null && entry.expiresAt <= at) {
        if (!expiredIds.has(entry.allowId)) {
          expiredIds.add(entry.allowId);
          expired += 1;
        }
        continue;
      }
      if (matched === null && evaluateExpression(entry.when, event, counter)) {
        matched = entry;
      }
    }
    return { entry: matched, expired };
  }

  return {
    match,
    expiredCount() {
      return expiredIds.size;
    },
  };
}

function compileEntry(entry, index, context, seen) {
  const path = `${context.path ?? 'allowlist'}[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new RuleDefinitionError('allowlist entry must be an object', { code: 'RULE_ALLOWLIST_SHAPE', path });
  }
  for (const key of Object.keys(entry)) {
    if (!ALLOWLIST_KEYS.includes(key)) {
      throw new RuleDefinitionError(`allowlist entry has unknown key ${key}`, {
        code: 'RULE_ALLOWLIST_UNKNOWN_KEY',
        path,
        detail: { keys: Object.keys(entry) },
      });
    }
  }
  const allowId = entry.allowId;
  if (typeof allowId !== 'string' || allowId.length === 0 || allowId.length > 64) {
    throw new RuleDefinitionError('allowId must be a non-empty string of at most 64 characters', {
      code: 'RULE_ALLOWLIST_SHAPE',
      path,
    });
  }
  if (seen.has(allowId)) {
    throw new RuleDefinitionError(`duplicate allowId ${allowId}`, { code: 'RULE_ALLOWLIST_DUPLICATE', path });
  }
  seen.add(allowId);
  const reason = entry.reason;
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) {
    throw new RuleDefinitionError('allowlist reason must be a non-empty string of at most 200 characters', {
      code: 'RULE_ALLOWLIST_SHAPE',
      path,
    });
  }
  if (entry.expiresAt !== undefined && (!Number.isInteger(entry.expiresAt) || entry.expiresAt < 0)) {
    throw new RuleDefinitionError('allowlist expiresAt must be a non-negative integer epoch millisecond value', {
      code: 'RULE_ALLOWLIST_SHAPE',
      path: `${path}.expiresAt`,
    });
  }
  const fields = entry.fields;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 16) {
    throw new RuleDefinitionError('allowlist fields must declare 1..16 readable field paths', {
      code: 'RULE_ALLOWLIST_FIELDS',
      path: `${path}.fields`,
    });
  }
  for (const field of fields) {
    if (typeof field !== 'string') {
      throw new RuleDefinitionError('allowlist field paths must be strings', {
        code: 'RULE_ALLOWLIST_FIELDS',
        path: `${path}.fields`,
      });
    }
  }
  const declaredFields = new Set(fields);
  if (declaredFields.size !== fields.length) {
    throw new RuleDefinitionError('allowlist field paths must be unique', {
      code: 'RULE_ALLOWLIST_FIELDS',
      path: `${path}.fields`,
    });
  }
  let ruleIds = null;
  if (entry.ruleIds !== undefined) {
    if (!Array.isArray(entry.ruleIds) || entry.ruleIds.length < 1 || entry.ruleIds.length > 32) {
      throw new RuleDefinitionError('allowlist ruleIds must contain 1..32 rule identifiers', {
        code: 'RULE_ALLOWLIST_RULES',
        path: `${path}.ruleIds`,
      });
    }
    for (const ruleId of entry.ruleIds) {
      if (typeof ruleId !== 'string' || !context.declaredRuleIds.has(ruleId)) {
        throw new RuleDefinitionError(`allowlist references unknown rule ${String(ruleId)}`, {
          code: 'RULE_ALLOWLIST_RULES',
          path: `${path}.ruleIds`,
        });
      }
    }
    ruleIds = Object.freeze([...new Set(entry.ruleIds)]);
  }
  return Object.freeze({
    allowId,
    reason,
    expiresAt: entry.expiresAt === undefined ? null : entry.expiresAt,
    ruleIds,
    fields: Object.freeze([...fields]),
    when: compileExpression(entry.when, { declaredFields, path: `${path}.when` }),
  });
}

const ALLOWLIST_KEYS = ['allowId', 'reason', 'expiresAt', 'ruleIds', 'fields', 'when'];
