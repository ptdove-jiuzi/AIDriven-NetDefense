/**
 * Version relation and the downgrade floor.
 *
 * RC-DG-1..4 from `release/windows-install.md` §7.1 live here in executable form. The
 * point of the floor is that the *machine* remembers a higher version; a check that only
 * reads the incoming package is always true for a compliant package, i.e. it tests
 * nothing.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareVersions,
  evaluateVersionRelation,
  maxVersion,
  nextFloorRecord,
  parseVersion,
  readTrust,
  readVersionFloor,
} from '../../deploy/windows/installer/src/version.mjs';
import { tempRoot } from './fixtures/payload.mjs';

const OK_FLOOR = { state: 'absent' };

test('parseVersion accepts X.Y.Z and refuses anything it cannot compare', () => {
  assert.deepEqual(parseVersion('0.0.1'), [0, 0, 1]);
  for (const bad of ['0.1', '0.0.1-rc1', 'v0.0.1', '', '0.0.1.2']) {
    assert.throws(() => parseVersion(bad), /版本/u, `accepted ${JSON.stringify(bad)}`);
  }
});

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('0.0.10', '0.0.9'), 1);
  assert.equal(compareVersions('0.0.1', '0.0.1'), 0);
  assert.equal(compareVersions('0.1.0', '0.0.9'), 1);
});

test('maxVersion picks the higher floor', () => {
  assert.equal(maxVersion('0.0.2', '0.0.10'), '0.0.10');
});

test('a fresh install above every floor is allowed and classified as install', () => {
  const result = evaluateVersionRelation({
    toVersion: '0.0.1', fromVersion: null, trust: { state: 'absent' }, floor: OK_FLOOR,
  });
  assert.equal(result.code, 0);
  assert.equal(result.op, 'install');
});

test('the same version is a repair, not an install', () => {
  const result = evaluateVersionRelation({
    toVersion: '0.0.1', fromVersion: '0.0.1', trust: { state: 'absent' }, floor: OK_FLOOR,
  });
  assert.equal(result.code, 0);
  assert.equal(result.op, 'repair');
});

test('a higher version is classified as upgrade (the caller refuses what it cannot do)', () => {
  const result = evaluateVersionRelation({
    toVersion: '0.0.2', fromVersion: '0.0.1', trust: { state: 'absent' }, floor: OK_FLOOR,
  });
  assert.equal(result.code, 0);
  assert.equal(result.op, 'upgrade');
});

test('RC-DG-1: a lower version than the installed one is blocked with 14', () => {
  const result = evaluateVersionRelation({
    toVersion: '0.0.1', fromVersion: '0.0.2', trust: { state: 'absent' }, floor: OK_FLOOR,
  });
  assert.equal(result.code, 14);
  assert.match(result.reasons.join(' '), /降级被阻断/u);
});

test('a lower version than the persisted floor is blocked even with no install present', () => {
  const result = evaluateVersionRelation({
    toVersion: '0.0.1',
    fromVersion: null,
    trust: { state: 'absent' },
    floor: { state: 'ok', hardFloorMax: '0.0.2', updatedAt: null },
  });
  assert.equal(result.code, 14);
  assert.match(result.reasons.join(' '), /低于地板/u);
});

test('RC-DG-4: a corrupt floor file fails closed with 10, never rebuilds a lower value', () => {
  const result = evaluateVersionRelation({
    toVersion: '0.0.3',
    fromVersion: null,
    trust: { state: 'absent' },
    floor: { state: 'corrupt', reasons: ['version-floor.json 不是合法 JSON'] },
  });
  assert.equal(result.code, 10);
  assert.match(result.reasons.join(' '), /version-floor/u);
});

test('RC-DG-3: a package whose own floor exceeds its version is refused with 10', () => {
  const result = evaluateVersionRelation({
    toVersion: '0.0.1',
    fromVersion: null,
    trust: { state: 'ok', version: '0.0.1', hardFloorVersion: '0.0.2' },
    floor: OK_FLOOR,
  });
  assert.equal(result.code, 10);
  assert.match(result.reasons.join(' '), /包自身违约/u);
});

test('trust.json.version must agree with the version being installed', () => {
  const result = evaluateVersionRelation({
    toVersion: '0.0.1',
    fromVersion: null,
    trust: { state: 'ok', version: '0.0.9', hardFloorVersion: '0.0.0' },
    floor: OK_FLOOR,
  });
  assert.equal(result.code, 10);
  assert.match(result.reasons.join(' '), /不一致/u);
});

test('readVersionFloor distinguishes absent, valid and corrupt', (t) => {
  const root = tempRoot(t);
  const path = join(root, 'version-floor.json');

  assert.equal(readVersionFloor(path).state, 'absent');

  writeFileSync(path, JSON.stringify({ hardFloorMax: '0.0.2', updatedAt: '2026-01-01T00:00:00.000Z' }));
  const ok = readVersionFloor(path);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.hardFloorMax, '0.0.2');

  writeFileSync(path, '{"hardFloorMax": "not-a-version"}');
  assert.equal(readVersionFloor(path).state, 'corrupt');

  writeFileSync(path, '{"nofloor": true}');
  assert.equal(readVersionFloor(path).state, 'corrupt');

  writeFileSync(path, 'not json at all');
  assert.equal(readVersionFloor(path).state, 'corrupt');
});

test('readTrust treats a malformed trust.json as corrupt, not as "no floor"', (t) => {
  const root = tempRoot(t);
  const path = join(root, 'trust.json');
  writeFileSync(path, JSON.stringify({ hardFloorVersion: 'x.y.z' }));
  assert.equal(readTrust(path).state, 'corrupt');
});

test('nextFloorRecord never lowers the floor and bumps updatedAt', () => {
  const previous = { state: 'ok', hardFloorMax: '0.0.2', updatedAt: '2026-01-01T00:00:00.000Z' };
  const lowered = nextFloorRecord(previous, '0.0.1', '2026-02-02T00:00:00.000Z');
  assert.equal(lowered.hardFloorMax, '0.0.2');
  assert.equal(lowered.updatedAt, '2026-02-02T00:00:00.000Z');

  const raised = nextFloorRecord(previous, '0.1.0');
  assert.equal(raised.hardFloorMax, '0.1.0');
});
