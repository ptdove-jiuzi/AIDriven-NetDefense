import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

test('root workspace contract is ESM-only, exact, locked, and authored by PT-dove', () => {
  assert.equal(manifest.author, 'PT-dove');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.private, true);
  assert.equal(manifest.engines.node, '>=24.9.0');
  assert.equal(manifest.packageManager, 'npm@11.6.0');
  assert.ok(Array.isArray(manifest.workspaces), 'Root must declare npm workspaces');
  assert.ok(
    manifest.workspaces.includes('packages/test-support'),
    'Workspace list must include packages/test-support without excluding future workspaces',
  );
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.ok(lock.packages['packages/test-support']);
  assert.ok(lock.packages['node_modules/@aegisharness/test-support'].link);

  for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must use an exact version`);
    assert.ok(lock.packages[`node_modules/${name}`], `${name} must be present in lockfile`);
  }
});

test('required WP0 commands and test-support workspace are present', () => {
  for (const command of ['test', 'test:wp0', 'sbom:generate', 'sbom:check', 'license:check']) {
    assert.equal(typeof manifest.scripts[command], 'string', `Missing npm script ${command}`);
  }
  const testSupport = JSON.parse(readFileSync('packages/test-support/package.json', 'utf8'));
  assert.equal(testSupport.author, 'PT-dove');
  assert.equal(testSupport.license, 'Apache-2.0');
  assert.equal(testSupport.type, 'module');
  assert.equal(testSupport.private, true);
});

/*
 * 逐名登记 workspace 集合。
 *
 * 复核 R5-P1 指出：SBOM/许可门禁里的 `local` 计数是动态算出来的，只要把某个包从
 * `workspaces` 删掉并同步重生成 lock/SBOM，**没有任何断言会红**（门禁失去覆盖）。
 * 这里把"必须存在的 workspace"写成显式清单，删掉任何一个都会在此失败；
 * 新增 workspace 时同步扩这张表（只允许增，不允许为过门禁而删条目）。
 */
test('every merged workspace is registered by name, so removal cannot pass silently', () => {
  const required = [
    'apps/daemon',
    'apps/harness-worker',
    'apps/model-broker',
    'apps/plugin-manager',
    'packages/collectors/common',
    'packages/collectors/linux',
    'packages/collectors/windows',
    'packages/contracts',
    'packages/detection',
    'packages/event-store',
    'packages/harness-adapter',
    'packages/response-policy',
    'packages/test-support',
    'plugins/dsh-defense-profile',
    'plugins/dsh-defense-tools',
  ];
  for (const workspace of required) {
    assert.ok(
      manifest.workspaces.includes(workspace),
      `workspace ${workspace} must stay registered (removal would silently drop it from SBOM and licence gates)`,
    );
    assert.ok(
      lock.packages[`node_modules/${(JSON.parse(readFileSync(`${workspace}/package.json`, 'utf8'))).name}`]?.link,
      `${workspace} must be linked into node_modules by the lockfile`,
    );
  }
});
