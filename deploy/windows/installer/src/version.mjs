/**
 * version.mjs — the three-version relation and the downgrade floor.
 *
 * The floor is `max(package trust.json.hardFloorVersion, machine's persisted
 * hardFloorMax)` (ADR-0009 §8.7 / D11). Reading only the package's own claim is
 * useless: a compliant package always declares a floor at or below itself, so
 * "toVersion < packageFloor" is false for every honest package and the check would
 * pass while doing nothing. The persisted value is what makes the check real — it is
 * the machine remembering "this box has already run 0.0.2".
 *
 * Corruption of `version-floor.json` is **not** recoverable by falling back to the
 * package floor: that would silently lower the floor, which is the exact downgrade
 * the file exists to prevent. It is a precheck failure (code 10).
 */

import { pathExists, readJson } from './fsx.mjs';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

export class VersionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VersionError';
    this.code = code;
  }
}

/**
 * @param {string} text Version string.
 * @returns {[number, number, number]}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') {
    throw new VersionError(10, `版本必须是字符串：${String(text)}`);
  }
  const match = SEMVER.exec(text.trim());
  if (match === null) {
    // Pre-release tags are refused rather than compared approximately: `1.0.0-rc1`
    // ordered by a naive numeric compare would outrank `1.0.0`, and the floor is a
    // security control, not a display string.
    throw new VersionError(10, `版本格式不支持（只接受 X.Y.Z）：${text}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function maxVersion(left, right) {
  return compareVersions(left, right) >= 0 ? left : right;
}

/**
 * @param {string} path `install\version-floor.json`.
 * @returns {{state: 'absent'} | {state: 'ok', hardFloorMax: string, updatedAt: string|null} | {state: 'corrupt', reasons: string[]}}
 */
export function readVersionFloor(path) {
  if (!pathExists(path)) return { state: 'absent' };
  let data;
  try {
    data = readJson(path);
  } catch (error) {
    return { state: 'corrupt', reasons: [`version-floor.json 不是合法 JSON：${error.message}`] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { state: 'corrupt', reasons: ['version-floor.json 顶层不是对象'] };
  }
  if (typeof data.hardFloorMax !== 'string') {
    return { state: 'corrupt', reasons: ['缺少字符串字段 hardFloorMax'] };
  }
  try {
    parseVersion(data.hardFloorMax);
  } catch {
    return { state: 'corrupt', reasons: [`hardFloorMax 不是合法版本：${data.hardFloorMax}`] };
  }
  return { state: 'ok', hardFloorMax: data.hardFloorMax, updatedAt: data.updatedAt ?? null };
}

/**
 * @param {string} path `manifests\trust.json` inside the payload.
 * @returns {{state: 'absent'} | {state: 'ok', version: string|null, hardFloorVersion: string} | {state: 'corrupt', reasons: string[]}}
 */
export function readTrust(path) {
  if (!pathExists(path)) return { state: 'absent' };
  let data;
  try {
    data = readJson(path);
  } catch (error) {
    return { state: 'corrupt', reasons: [`trust.json 不是合法 JSON：${error.message}`] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { state: 'corrupt', reasons: ['trust.json 顶层不是对象'] };
  }
  const hardFloorVersion = data.hardFloorVersion ?? '0.0.0';
  try {
    parseVersion(hardFloorVersion);
  } catch {
    return { state: 'corrupt', reasons: [`hardFloorVersion 不是合法版本：${String(hardFloorVersion)}`] };
  }
  const version = typeof data.version === 'string' ? data.version : null;
  if (version !== null) {
    try {
      parseVersion(version);
    } catch {
      return { state: 'corrupt', reasons: [`trust.json.version 不是合法版本：${version}`] };
    }
  }
  return { state: 'ok', version, hardFloorVersion };
}

/**
 * Decide whether this package may be installed over what is already there.
 *
 * @param {{ toVersion: string, fromVersion: string|null, trust: ReturnType<typeof readTrust>, floor: ReturnType<typeof readVersionFloor> }} input
 * @returns {{ code: number, emitCode: number, op: 'install'|'upgrade'|'repair', floor: string, reasons: string[] }}
 */
export function evaluateVersionRelation({ toVersion, fromVersion, trust, floor }) {
  const reasons = [];
  const errors = [];

  const to = parseVersion(toVersion); // throws VersionError(10)

  if (trust.state === 'corrupt') {
    errors.push(...trust.reasons);
  }
  if (floor.state === 'corrupt') {
    // RC-DG-4: fail closed. Never rebuild the floor from a lower value.
    errors.push(...floor.reasons);
  }
  if (errors.length > 0) {
    return { code: 10, emitCode: 10, op: 'install', floor: '0.0.0', reasons: errors };
  }

  // RC-DG-3: a package whose own floor exceeds its own version is self-contradictory.
  const trustFloor = trust.state === 'ok' ? trust.hardFloorVersion : '0.0.0';
  if (compareVersions(trustFloor, toVersion) > 0) {
    return {
      code: 10,
      emitCode: 10,
      op: 'install',
      floor: trustFloor,
      reasons: [`包自身违约：hardFloorVersion ${trustFloor} > version ${toVersion}`],
    };
  }
  if (trust.state === 'ok' && trust.version !== null && trust.version !== toVersion) {
    return {
      code: 10,
      emitCode: 10,
      op: 'install',
      floor: trustFloor,
      reasons: [`trust.json.version ${trust.version} 与待装版本 ${toVersion} 不一致`],
    };
  }

  const persistedFloor = floor.state === 'ok' ? floor.hardFloorMax : '0.0.0';
  const effectiveFloor = maxVersion(trustFloor, persistedFloor);

  if (compareVersions(toVersion, effectiveFloor) < 0) {
    return {
      code: 14,
      emitCode: 14,
      op: 'install',
      floor: effectiveFloor,
      reasons: [`待装版本 ${toVersion} 低于地板 ${effectiveFloor}（包内 ${trustFloor} / 本机 ${persistedFloor}）`],
    };
  }

  if (fromVersion === null) {
    return { code: 0, emitCode: 0, op: 'install', floor: effectiveFloor, reasons: [] };
  }

  const relation = compareVersions(toVersion, fromVersion);
  if (relation > 0) return { code: 0, emitCode: 0, op: 'upgrade', floor: effectiveFloor, reasons: [] };
  if (relation === 0) {
    // ADR §6.4: same version is a repair — payload and manifest only, data untouched.
    return { code: 0, emitCode: 0, op: 'repair', floor: effectiveFloor, reasons: [] };
  }
  return {
    code: 14,
    emitCode: 14,
    op: 'install',
    floor: effectiveFloor,
    reasons: [`降级被阻断：${fromVersion} → ${toVersion}`],
  };
}

/** The floor may only ever rise. */
export function nextFloorRecord(previous, incoming, now = new Date().toISOString()) {
  const previousMax = previous.state === 'ok' ? previous.hardFloorMax : '0.0.0';
  const max = maxVersion(previousMax, incoming);
  return { hardFloorMax: max, updatedAt: now };
}
