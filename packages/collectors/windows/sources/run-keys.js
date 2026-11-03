/**
 * Startup persistence source: the `Run` / `RunOnce` registry keys (§5.1 "任务/启动持久化").
 *
 * Registry reads are performed with `Get-Item`/`GetValueNames`, never with `reg.exe`, so
 * there is no second parsing layer and no console encoding to get wrong.
 *
 * Command-injection surface: the key list is a **closed allowlist** returned by
 * {@link RUN_KEY_PATHS}. Nothing from configuration, telemetry or the user is interpolated
 * into the script beyond values that already passed {@link assertRegistryKey}; each key is
 * then embedded with `psQuote`, and the read uses `-LiteralPath` so wildcard characters in a
 * value name cannot broaden the query.
 *
 * Missing keys are normal (a stock host has no `RunOnce` values for most users), so an absent
 * key contributes zero rows and is counted in `stats.missingKeys` instead of being reported
 * as a failure.
 *
 * A key that *exists but denies access* is not an absent key. `Get-Item` throws
 * `UnauthorizedAccessException` for the first and `ItemNotFoundException` for the second; the
 * original script caught both with `catch { continue }`, so an ACL change looked exactly like
 * "the autostart entry was deleted" and the differ emitted a fabricated `removed` record —
 * false negative evidence, which is worse than a missed read. The script now classifies the
 * exception, reports the key in `deniedKeys`, and `read()` suppresses removals for exactly
 * those keys, degrades the result to `partial` and names the keys in `denials`.
 */

import {
  DEFAULT_MAX_ENTITIES,
  buildSnapshotRecord,
  createSnapshotDiffer,
  identityToken,
  stateDigest,
} from '../diff.js';
import { createSourceDescriptor } from '../descriptor.js';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from '../errors.js';
import { buildPayload } from '../payload.js';
import { psQuote, toArray, toText } from '../powershell.js';

export const RUN_KEYS_SOURCE_ID = 'windows.run-key';
export const RUN_KEYS_INTERVAL_MS = 60_000;
export const RUN_KEYS_TYPE = 'windows.run_key';
export const MAX_DECLARED_KEYS = 16;

const RUN_KEY_PATTERN = /^HK(LM|CU)\\[A-Za-z0-9\\ ._-]{1,240}$/;

/**
 * The declared keys. Keep this list static: it is the whole point of a declared source.
 * Both the native and the WOW6432Node (32-bit) views are covered, because a 32-bit
 * installer writes to the WOW6432Node path and a 64-bit-only read would miss it.
 */
export const RUN_KEY_PATHS = Object.freeze([
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
]);

export const RUN_KEYS_FIELDS = Object.freeze([
  { name: 'hive', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'key_path', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'value_name', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'command', type: 'string', completeness: 'always', sensitivity: 'D2' },
  { name: 'run_kind', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'architecture', type: 'string', completeness: 'always', sensitivity: 'D1' },
]);

/** Reject anything that is not a plain `HKLM\…` / `HKCU\…` registry path. */
export function assertRegistryKey(keyPath) {
  if (typeof keyPath !== 'string' || keyPath.length === 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_CONFIG, 'registry key path must be a non-empty string');
  }
  if (!RUN_KEY_PATTERN.test(keyPath) || /['"`$;|&<>*?\r\n\t]/.test(keyPath) || keyPath.includes('..')) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED,
      'registry key path must be a plain HKLM\\ or HKCU\\ path without wildcards, quotes or traversal',
      { details: { keyPath } },
    );
  }
  return keyPath;
}

function assertDeclaredKeys(keys) {
  const declared = (Array.isArray(keys) && keys.length > 0 ? keys : RUN_KEY_PATHS).map(assertRegistryKey);
  if (declared.length > MAX_DECLARED_KEYS) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.SOURCE_LIMIT_EXCEEDED,
      `at most ${MAX_DECLARED_KEYS} registry keys may be declared`,
      { details: { declared: declared.length } },
    );
  }
  return Object.freeze(declared);
}

export function runKeysDescriptor({ intervalMs = RUN_KEYS_INTERVAL_MS } = {}) {
  return createSourceDescriptor({
    stableSourceId: RUN_KEYS_SOURCE_ID,
    type: RUN_KEYS_TYPE,
    kind: 'poll',
    intervalMs,
    permissions: {
      required: ['Read access to the declared Run/RunOnce registry keys'],
      optional: ['Administrator to read keys whose DACL excludes the collector account'],
      degradedWithout: [
        'command: a key that denies read access is reported as partial with the key named in denials, and no removal is claimed for it',
      ],
    },
    fields: RUN_KEYS_FIELDS,
    blindSpots: [
      'Only the declared Run/RunOnce keys are read; other autostart mechanisms are separate sources and are not claimed',
      'A value written and removed between two polls (shorter than intervalMs) is never observed',
      'The persisted command is not expanded or resolved to an on-disk binary',
      'Both the native and WOW6432Node views are covered only for the keys listed above',
    ],
    gapSemantics: [
      'poll: a failed read produces no records and no gap; the source degrades through last_error and goes stale after two intervals',
      'poll: a missing key is not a gap; the declared key simply has no values on this host',
    ],
    rotation: 'none: registry values are a point-in-time snapshot keyed by hive, key path and value name',
  });
}

export const RUN_KEYS_DESCRIPTOR = runKeysDescriptor();

export function buildRunKeysScript(keys = RUN_KEY_PATHS) {
  const declared = assertDeclaredKeys(keys);
  const list = declared.map((key) => psQuote(key)).join(', ');
  return [
    '# aegis-source:run-keys',
    `$targets = @(${list})`,
    '$entries = @()',
    '$deniedKeys = @()',
    '# Walks the InnerException chain: Get-Item wraps the ACL failure while GetValueNames',
    '# raises it directly, and a missing key must stay distinguishable from a refused one.',
    'function Test-AccessDenied($exception) {',
    '  while ($exception -ne $null) {',
    '    if (($exception -is [System.UnauthorizedAccessException]) -or ($exception -is [System.Security.SecurityException])) { return $true }',
    '    $exception = $exception.InnerException',
    '  }',
    '  return $false',
    '}',
    'foreach ($k in $targets) {',
    '  $key = $null',
    '  try { $key = Get-Item -LiteralPath $k -ErrorAction Stop }',
    '  catch {',
    '    if (Test-AccessDenied $_.Exception) { $deniedKeys += $k }',
    '    continue',
    '  }',
    '  try { $names = @($key.GetValueNames()) }',
    '  catch {',
    '    if (Test-AccessDenied $_.Exception) { $deniedKeys += $k }',
    '    continue',
    '  }',
    '  foreach ($n in $names) {',
    '    $entries += [pscustomobject]@{ keyPath = $k; valueName = [string]$n; command = [string]$key.GetValue($n) }',
    '  }',
    '}',
    'ConvertTo-Json -InputObject ([pscustomobject]@{ values = @($entries); deniedKeys = @($deniedKeys) }) -Depth 4 -Compress',
  ].join('\n');
}

function describeKey(keyPath) {
  const separator = keyPath.indexOf('\\');
  const hive = keyPath.slice(0, separator);
  const rest = keyPath.slice(separator + 1).toLowerCase();
  return {
    hive,
    keyPath,
    runKind: rest.endsWith('runonce') ? 'runonce' : 'run',
    architecture: rest.includes('wow6432node') ? 'x86' : 'native',
  };
}

function normalizeRow(row) {
  const keyPath = toText(row.keyPath);
  const valueName = toText(row.valueName);
  if (keyPath === null || valueName === null) {
    return null;
  }
  const key = describeKey(keyPath);
  const { payload } = buildPayload({
    hive: key.hive,
    key_path: keyPath,
    value_name: valueName,
    command: toText(row.command),
    run_kind: key.runKind,
    architecture: key.architecture,
  });

  return {
    entityId: `run-${identityToken(`${keyPath}\\${valueName}`.toLowerCase())}`,
    digest: stateDigest({ command: payload.command ?? null }),
    payload,
  };
}

/**
 * Split the script output into value rows and the keys the account was not allowed to read.
 *
 * The script emits `{ values, deniedKeys }`. A bare array of rows is still accepted because
 * that is the shape a fixture (and any pre-existing caller of `buildRunKeysScript`) replays;
 * in that case nothing is denied. A `deniedKeys` field that is present but not an array is a
 * malformed read, not an empty denial list: swallowing it would restore exactly the bug this
 * source now prevents.
 */
function splitTable(payload) {
  if (payload === null || payload === undefined) {
    return { rows: [], deniedKeys: [] };
  }
  if (Array.isArray(payload)) {
    return { rows: payload, deniedKeys: [] };
  }
  if (payload.deniedKeys !== undefined && payload.deniedKeys !== null && !Array.isArray(payload.deniedKeys)) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.BAD_JSON,
      'the run-keys script must report deniedKeys as an array',
      { details: { type: typeof payload.deniedKeys } },
    );
  }
  return {
    rows: Array.isArray(payload.values) ? payload.values : [payload],
    deniedKeys: toArray(payload.deniedKeys).filter((key) => typeof key === 'string' && key.length > 0),
  };
}

export function createRunKeysSource({
  powershell,
  clock = Date.now,
  intervalMs = RUN_KEYS_INTERVAL_MS,
  keys = RUN_KEY_PATHS,
  maxEntities = DEFAULT_MAX_ENTITIES,
} = {}) {
  if (!powershell || typeof powershell.runJson !== 'function') {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'a PowerShell client exposing runJson() is required',
    );
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'intervalMs must be a positive integer');
  }

  const declared = assertDeclaredKeys(keys);
  const script = buildRunKeysScript(declared);
  const differ = createSnapshotDiffer({ maxEntities });
  const descriptor = runKeysDescriptor({ intervalMs });

  return Object.freeze({
    descriptor,
    sourceId: RUN_KEYS_SOURCE_ID,

    async read() {
      const { rows, deniedKeys } = splitTable(await powershell.runJson(script));
      const items = [];
      const seenKeys = new Set();
      for (const row of rows) {
        if (row === null || typeof row !== 'object') {
          continue;
        }
        const normalized = normalizeRow(row);
        if (normalized !== null) {
          items.push(normalized);
          seenKeys.add(normalized.payload.key_path);
        }
      }

      // A key that refused access says nothing about whether its values still exist. Without
      // this, the second read after an ACL change looked like "every value was removed" and
      // emitted fabricated `removed` records for entries the collector never observed going
      // away. Suppression is per key on purpose: a denial for `HKCU\…\Run` must not hide a
      // genuine removal under `HKLM\…\RunOnce`.
      const denied = new Set(deniedKeys.map((key) => key.toLowerCase()));
      const observedAt = clock();
      const diff = differ.diff(items, {
        suppressRemovalsFor: denied.size === 0
          ? null
          : ({ item }) => denied.has(String(item?.payload?.key_path ?? '').toLowerCase()),
      });
      const deniedDeclared = declared.filter((key) => denied.has(key.toLowerCase())).length;
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: RUN_KEYS_TYPE,
          entityId: entry.entityId,
          digest: entry.digest,
          revision: entry.revision,
          observedAt,
          change: entry.kind,
          payload: entry.kind === 'removed'
            ? { ...entry.item.payload, present: false }
            : { ...entry.item.payload, present: true },
        }))
        .sort((left, right) => (left.nativeRecordId < right.nativeRecordId ? -1 : 1));

      return {
        records,
        nextCursor: null,
        identity: null,
        reset: null,
        snapshot: diff.snapshot,
        truncated: diff.truncated,
        // A partial read is not a healthy read: the denied keys are named in `denials` and
        // the fields they would have filled are declared degraded.
        status: denied.size === 0 ? 'ok' : 'partial',
        denials: Object.freeze([...deniedKeys].map((keyPath) => Object.freeze({
          path: keyPath,
          code: WINDOWS_ERROR_CODES.ACCESS_DENIED,
          outcome: 'permission_denied',
        }))),
        degradedFields: denied.size === 0
          ? Object.freeze([])
          : Object.freeze(['value_name', 'command']),
        stats: Object.freeze({
          values: items.length,
          declaredKeys: declared.length,
          populatedKeys: seenKeys.size,
          // Missing keys are counted, never treated as a failed read; a denied key is not
          // missing, so it is excluded from this count and reported separately.
          missingKeys: declared.length - seenKeys.size - deniedDeclared,
          deniedKeys: deniedDeclared,
          duplicateEntities: diff.duplicateEntities,
          suppressedRemovals: diff.suppressedRemovals,
        }),
      };
    },
  });
}
