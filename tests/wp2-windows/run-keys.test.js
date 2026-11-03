import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_DECLARED_KEYS,
  RUN_KEYS_SOURCE_ID,
  RUN_KEY_PATHS,
  WINDOWS_ERROR_CODES,
  assertRegistryKey,
  buildRunKeysScript,
  createRunKeysSource,
  runKeysDescriptor,
} from '../../packages/collectors/windows/index.js';
import { createClock, createScriptedPowerShell } from './helpers.js';

const BASE = 1_700_000_000_000;
const HKCU_RUN = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';

function value(overrides = {}) {
  return { keyPath: HKCU_RUN, valueName: 'OneDrive', command: 'C:\\Users\\u\\OneDrive.exe /background', ...overrides };
}

test('the declared keys cover both the native and the WOW6432Node views', () => {
  assert.equal(RUN_KEY_PATHS.some((key) => key.includes('WOW6432Node')), true);
  assert.equal(RUN_KEY_PATHS.some((key) => key.startsWith('HKLM')), true);
  assert.equal(RUN_KEY_PATHS.some((key) => key.startsWith('HKCU')), true);
  for (const key of RUN_KEY_PATHS) {
    assert.equal(assertRegistryKey(key), key);
  }
});

test('a hostile registry path is rejected before any script is built', () => {
  for (const hostile of [
    "HKCU\\Run'; Start-Process calc.exe; '",
    'HKCU\\Run$(calc)',
    'HKLM\\..\\..\\Windows',
    'HKLM\\Run*',
    'HKEY_USERS\\S-1-5-18\\Run',
    'HKLM\\Run\nNew-Item',
  ]) {
    assert.throws(() => assertRegistryKey(hostile), (error) => error.code === WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED, hostile);
  }
});

test('the script quotes every declared key and uses -LiteralPath', () => {
  const script = buildRunKeysScript([HKCU_RUN]);
  assert.match(script, /^# aegis-source:run-keys/mu);
  assert.equal(script.includes("$targets = @('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run')"), true);
  assert.match(script, /-LiteralPath \$k/u);
  assert.equal(/-Path \$k/u.test(script), false, 'wildcard expansion must be impossible');
  assert.equal(/Invoke-Expression|\biex\b/u.test(script), false);
});

test('more declared keys than the bound is a configuration error', () => {
  const tooMany = [];
  for (let index = 0; index < MAX_DECLARED_KEYS + 1; index += 1) {
    tooMany.push(`HKCU\\SOFTWARE\\Vendor${index}\\Run`);
  }
  assert.throws(
    () => buildRunKeysScript(tooMany),
    (error) => error.code === WINDOWS_ERROR_CODES.SOURCE_LIMIT_EXCEEDED,
  );
});

test('the descriptor is a declared poll source with an explicit scope limit', () => {
  const descriptor = runKeysDescriptor();
  assert.equal(descriptor.stableSourceId, RUN_KEYS_SOURCE_ID);
  assert.equal(descriptor.kind, 'poll');
  assert.equal(descriptor.intervalMs, 60_000);
  assert.equal(descriptor.blindSpots.some((entry) => /Only the declared Run\/RunOnce keys/u.test(entry)), true);
  assert.equal(descriptor.gapSemantics.some((entry) => /missing key is not a gap/u.test(entry)), true);
});

test('the first read emits hive, kind and architecture derived from the key path', async () => {
  const powershell = createScriptedPowerShell({
    'run-keys': [
      value(),
      value({ keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce', valueName: 'Updater' }),
    ],
  });
  const source = createRunKeysSource({ powershell, clock: createClock(BASE) });
  const result = await source.read();

  const [native, wow] = result.records;
  assert.equal(native.payload.hive, 'HKCU');
  assert.equal(native.payload.run_kind, 'run');
  assert.equal(native.payload.architecture, 'native');
  assert.equal(wow.payload.hive, 'HKLM');
  assert.equal(wow.payload.run_kind, 'runonce');
  assert.equal(wow.payload.architecture, 'x86');
  assert.equal(native.payload.present, true);
});

test('a value removed from the key is reported as removed', async () => {
  const clock = createClock(BASE);
  const routes = { 'run-keys': [value()] };
  const source = createRunKeysSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes['run-keys'] = [];
  const second = await source.read();

  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].payload.change, 'removed');
  assert.equal(second.records[0].payload.present, false);
});

test('a changed command is a changed event, and an unchanged one is silent', async () => {
  const clock = createClock(BASE);
  const routes = { 'run-keys': [value()] };
  const source = createRunKeysSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  assert.deepEqual((await source.read()).records, []);

  routes['run-keys'] = [value({ command: 'powershell -w hidden -c calc' })];
  const changed = await source.read();
  assert.equal(changed.records.length, 1);
  assert.equal(changed.records[0].payload.change, 'changed');
});

test('keys without values are counted, never reported as a failed read', async () => {
  const powershell = createScriptedPowerShell({ 'run-keys': [value()] });
  const source = createRunKeysSource({ powershell, clock: createClock(BASE), keys: [HKCU_RUN, 'HKLM\\SOFTWARE\\Zzz\\Run'] });
  const result = await source.read();

  assert.equal(result.stats.declaredKeys, 2);
  assert.equal(result.stats.populatedKeys, 1);
  assert.equal(result.stats.missingKeys, 1);
  assert.equal(result.records.length, 1);
});

test('a value name containing a colon or hash is hashed into a safe entity id', async () => {
  const powershell = createScriptedPowerShell({ 'run-keys': [value({ valueName: 'name:with#delims', command: 'x.exe' })] });
  const source = createRunKeysSource({ powershell, clock: createClock(BASE) });
  const result = await source.read();

  assert.equal(result.records[0].payload.value_name, 'name:with#delims');
  assert.equal(/[#:]/.test(result.records[0].nativeRecordId), false, 'both characters delimit a stable key');
});

test('the script classifies a refused key instead of folding it into "missing"', () => {
  const script = buildRunKeysScript([HKCU_RUN]);

  // Both read paths (Get-Item and GetValueNames) must record the denial, and the reported
  // key list has to be part of the output rather than a comment.
  assert.equal(script.split('$deniedKeys += $k').length - 1, 2, 'both catch blocks must record the denied key');
  assert.match(script, /Test-AccessDenied \$_\u002eException/u);
  assert.match(script, /System\.UnauthorizedAccessException/u);
  assert.match(script, /deniedKeys = @\(\$deniedKeys\)/u);
  assert.equal(/catch \{ continue \}/u.test(script), false, 'a bare "catch { continue }" is exactly the bug');
  assert.match(script, /-LiteralPath \$k/u);
  assert.equal(/-Path \$k/u.test(script), false, 'wildcard expansion must remain impossible');
});

test('a key that denies access is never reported as a removal, and the read degrades', async () => {
  const clock = createClock(BASE);
  const routes = { 'run-keys': [value()] };
  const source = createRunKeysSource({
    powershell: createScriptedPowerShell(routes),
    clock,
    keys: [HKCU_RUN],
  });

  const first = await source.read();
  assert.equal(first.records.length, 1);
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.denials, []);

  // Second read: the key exists but the account may no longer open it. Zero rows here means
  // "not observed", not "deleted", so nothing may be emitted as `removed`.
  routes['run-keys'] = { values: [], deniedKeys: [HKCU_RUN] };
  const second = await source.read();

  assert.deepEqual(second.records, [], 'a denied key must not fabricate a removed record');
  assert.equal(second.records.some((record) => record.payload.present === false), false);
  assert.equal(second.status, 'partial', 'a partially blind read must not claim to be ok');
  assert.notEqual(second.degradedFields.length, 0, 'the unreadable fields must be declared');
  assert.equal(second.stats.suppressedRemovals, 1);
  assert.equal(second.stats.deniedKeys, 1);
  assert.equal(second.stats.missingKeys, 0, 'a denied key is not a missing key');
  assert.equal(second.denials.length, 1);
  assert.equal(second.denials[0].path, HKCU_RUN);
  assert.equal(second.denials[0].outcome, 'permission_denied');
});

test('a denial for one key does not suppress a genuine removal under another key', async () => {
  const hklmRunOnce = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
  const clock = createClock(BASE);
  const routes = {
    'run-keys': [
      value(),
      value({ keyPath: hklmRunOnce, valueName: 'Updater', command: 'C:\\Updater.exe' }),
    ],
  };
  const source = createRunKeysSource({
    powershell: createScriptedPowerShell(routes),
    clock,
    keys: [HKCU_RUN, hklmRunOnce],
  });
  await source.read();

  // HKCU is refused while the HKLM value really is gone from a key that answered normally.
  routes['run-keys'] = {
    values: [],
    deniedKeys: [HKCU_RUN],
  };
  const second = await source.read();

  assert.equal(second.records.length, 1, 'the readable key must still report its removal');
  assert.equal(second.records[0].payload.key_path, hklmRunOnce);
  assert.equal(second.records[0].payload.value_name, 'Updater');
  assert.equal(second.records[0].payload.change, 'removed');
  assert.equal(second.records[0].payload.present, false);
  assert.equal(second.status, 'partial');
  assert.equal(second.stats.suppressedRemovals, 1, 'only the denied key is suppressed');
});

test('a malformed deniedKeys field is a failed read, not an empty denial list', async () => {
  const powershell = createScriptedPowerShell({ 'run-keys': { values: [], deniedKeys: HKCU_RUN } });
  const source = createRunKeysSource({ powershell, clock: createClock(BASE) });

  await assert.rejects(
    () => source.read(),
    (error) => error.code === WINDOWS_ERROR_CODES.BAD_JSON,
  );
});
