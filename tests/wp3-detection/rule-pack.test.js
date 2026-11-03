/**
 * rule-pack.test.js — loading rule packs from disk, rejecting malformed packs and
 * keeping file access confined to the temporary directory.
 */

import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RuleDefinitionError, createDetectionEngine, createManualClock, loadRulePack } from '../../packages/detection/index.js';
import { makeEvent, withTempDir } from './helpers.js';

const validPack = {
  schemaVersion: '1.0',
  packId: 'disk-pack',
  packVersion: '2.4.1',
  minEngineVersion: '0.1.0',
  signature: { algorithm: 'ed25519', keyId: 'example-key', value: 'example-signature' },
  rules: [
    {
      ruleId: 'proc.disk',
      version: '1.0.0',
      type: 'condition',
      severity: 'high',
      fields: ['process.name'],
      fingerprint: ['process.name'],
      when: { field: 'process.name', operator: 'eq', value: 'example-process' },
      tags: ['process'],
    },
  ],
  allowlist: [
    {
      allowId: 'allow.disk',
      reason: 'synthetic allow entry',
      fields: ['process.name'],
      when: { field: 'process.name', operator: 'eq', value: 'example-allowed' },
    },
  ],
};

function writePack(directory, name, content) {
  const file = join(directory, name);
  writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  return file;
}

function expectPackError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof RuleDefinitionError, `expected RuleDefinitionError, received ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('rule pack loading', () => {
  it('loads a valid pack from disk and detects with it', (t) => {
    const directory = withTempDir(t);
    const file = writePack(directory, 'pack.json', validPack);
    assert.deepEqual(readdirSync(directory), ['pack.json']);
    const pack = loadRulePack(file);
    assert.equal(pack.packId, 'disk-pack');
    assert.equal(pack.packVersion, '2.4.1');
    assert.equal(pack.rules.length, 1);
    assert.equal(pack.allowlist.length, 1);
    assert.equal(pack.signature.keyId, 'example-key');

    const engine = createDetectionEngine({ rulePack: pack, clock: createManualClock(0) });
    const result = engine.ingest([makeEvent({ eventId: 'evt-pack-1' })]);
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].ruleId, 'proc.disk');
    assert.deepEqual(readdirSync(directory), ['pack.json']);
  });

  it('rejects a path that does not exist', (t) => {
    const directory = withTempDir(t);
    expectPackError(() => loadRulePack(join(directory, 'missing.json')), 'RULE_PACK_UNREADABLE');
  });

  it('rejects a file that is not JSON', (t) => {
    const directory = withTempDir(t);
    const file = writePack(directory, 'broken.json', '{ not json');
    expectPackError(() => loadRulePack(file), 'RULE_PACK_PARSE_ERROR');
  });

  it('rejects a mismatched schema version', (t) => {
    const directory = withTempDir(t);
    const file = writePack(directory, 'pack.json', { ...validPack, schemaVersion: '2.0' });
    expectPackError(() => loadRulePack(file), 'RULE_PACK_VERSION_MISMATCH');
  });

  it('rejects a pack whose rules are not an array', (t) => {
    const directory = withTempDir(t);
    const file = writePack(directory, 'pack.json', { ...validPack, rules: { ruleId: 'proc.disk' } });
    expectPackError(() => loadRulePack(file), 'RULE_PACK_RULES');
  });

  it('rejects duplicate rule identifiers', (t) => {
    const directory = withTempDir(t);
    const file = writePack(directory, 'pack.json', {
      ...validPack,
      rules: [validPack.rules[0], { ...validPack.rules[0], version: '1.0.1' }],
    });
    expectPackError(() => loadRulePack(file), 'RULE_ID_DUPLICATE');
  });

  it('rejects unknown top level keys', (t) => {
    const directory = withTempDir(t);
    const file = writePack(directory, 'pack.json', { ...validPack, include: 'example-include.json' });
    expectPackError(() => loadRulePack(file), 'RULE_PACK_UNKNOWN_KEY');
  });

  it('rejects packs that reference unknown rules from the allowlist', (t) => {
    const directory = withTempDir(t);
    const file = writePack(directory, 'pack.json', {
      ...validPack,
      allowlist: [{ ...validPack.allowlist[0], ruleIds: ['proc.unknown'] }],
    });
    expectPackError(() => loadRulePack(file), 'RULE_ALLOWLIST_RULES');
  });

  it('rejects non-string paths without touching the filesystem', () => {
    expectPackError(() => loadRulePack(''), 'RULE_PACK_PATH_INVALID');
    expectPackError(() => loadRulePack(undefined), 'RULE_PACK_PATH_INVALID');
  });
});
