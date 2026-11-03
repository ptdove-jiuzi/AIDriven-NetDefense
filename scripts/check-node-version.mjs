/**
 * Toolchain gate.
 *
 * Node.js: `>=24.9.0` (unchanged).
 *
 * npm: a bounded 11.x window — `>=11.6.0 <12.0.0`.
 * The floor is the version this repository was originally pinned to; it is a
 * hard floor and must never be lowered. The ceiling exists so a future major
 * cannot silently change lockfile or lifecycle behaviour underneath the gate.
 * See `docs/implementation/adr/ADR-0001-npm-toolchain-gate.md` for the decision,
 * the evidence behind it, and why an exact 11.6.0 pin was rejected.
 *
 * This gate is deliberately fail-closed: an unparseable or out-of-window npm
 * version fails the run instead of being ignored.
 */

const NODE_MINIMUM = [24, 9, 0];
const NPM_MINIMUM = [11, 6, 0];
const NPM_MAXIMUM_EXCLUSIVE = [12, 0, 0];

/**
 * Compare two `[major, minor, patch]` triples.
 *
 * @param {number[]} left Left version.
 * @param {number[]} right Right version.
 * @returns {number} Negative when `left < right`, 0 when equal, positive otherwise.
 */
function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

/**
 * Parse a `major.minor.patch` string into a numeric triple.
 *
 * @param {string} value Version string.
 * @returns {number[] | null} Triple, or `null` when the string is not a full semver core.
 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const actualNode = parseVersion(process.versions.node.split('-')[0]);
const nodeSupported = actualNode !== null && compareVersions(actualNode, NODE_MINIMUM) >= 0;

const userAgent = process.env.npm_config_user_agent;
const rawNpmVersion = userAgent?.match(/\bnpm\/(\d+(?:\.\d+){0,2})\b/)?.[1];
const actualNpm = rawNpmVersion === undefined ? null : parseVersion(rawNpmVersion);
const npmSupported = actualNpm !== null
  && compareVersions(actualNpm, NPM_MINIMUM) >= 0
  && compareVersions(actualNpm, NPM_MAXIMUM_EXCLUSIVE) < 0;

if (!nodeSupported) {
  console.error(`Node.js >=24.9.0 is required; actual runtime is ${process.version}`);
  process.exitCode = 1;
} else if (userAgent !== undefined && !npmSupported) {
  // `npm_config_user_agent` 存在但解析不出完整 npm 版本时同样必须失败：
  // 否则伪造/损坏的 UA 会退化成"未由 npm 调用"从而放行（fail-open）。
  console.error(
    rawNpmVersion === undefined
      ? 'npm >=11.6.0 <12.0.0 is required; the npm version in '
        + `npm_config_user_agent could not be parsed (${JSON.stringify(userAgent)}). `
        + 'An exact pin no longer applies: see ADR-0001. Do not bypass this gate.'
      : `npm >=11.6.0 <12.0.0 is required; actual npm is ${rawNpmVersion}. `
        + 'An exact pin no longer applies: see ADR-0001. Do not bypass this gate.',
  );
  process.exitCode = 1;
} else {
  console.log(
    `Toolchain gate passed: Node.js ${process.version}, `
      + `npm ${rawNpmVersion ?? 'not invoked by npm'}`,
  );
}
