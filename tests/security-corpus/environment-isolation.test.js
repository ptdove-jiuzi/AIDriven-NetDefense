// author: PT-dove
// M9 对抗语料 —— 环境隔离（沙箱根目录可控 + 清理不越界）。
//
// 门禁要能在别人的机器上跑，所以"临时目录在哪"不能是硬编码：
// 1. 默认行为不变：仍然落在系统临时目录，仍然不碰仓库和用户目录；
// 2. `AEGIS_M9_TMP_ROOT` 可以把根目录整体挪到 CI 的作业目录，让残留随作业回收；
// 3. 覆盖只改"放在哪"，不改"必须是临时目录"这条纪律，`cleanup()` 也仍然只删自己那一个。

import assert from 'node:assert/strict';
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SANDBOX_PREFIX, TEMP_ROOT_ENV, createSandbox, resolveTempRoot } from './support/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * 在临时环境变量下执行一段代码，结束后原样恢复（包括"原本没有这个变量"）。
 *
 * @param {string | undefined} value 要设置的值，`undefined` 表示删除。
 * @param {() => void} body 主体。
 * @returns {void}
 */
function withTempRoot(value, body) {
  const previous = process.env[TEMP_ROOT_ENV];
  try {
    if (value === undefined) delete process.env[TEMP_ROOT_ENV];
    else process.env[TEMP_ROOT_ENV] = value;
    body();
  } finally {
    if (previous === undefined) delete process.env[TEMP_ROOT_ENV];
    else process.env[TEMP_ROOT_ENV] = previous;
  }
}

/**
 * `child` 是否位于 `parent` 之下（按真实路径比较，避免 `..` 与符号链接的歧义）。
 *
 * @param {string} parent 父目录。
 * @param {string} child 子目录。
 * @returns {boolean} 是否包含。
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

test('默认临时根就是系统临时目录的真实路径', () => {
  withTempRoot(undefined, () => {
    const root = resolveTempRoot();
    assert.equal(root, realpathSync(tmpdir()), 'the default must stay os.tmpdir()');
    assert.equal(statSync(root).isDirectory(), true);
  });
});

test(`${TEMP_ROOT_ENV} 可以把沙箱挪到指定目录（CI 可控 fixture）`, (t) => {
  const outer = createSandbox();
  t.after(() => outer.cleanup());

  withTempRoot(outer.root, () => {
    const inner = createSandbox();
    // 断言失败也要兜住：否则失败路径自己会漏一个沙箱，把"失败"变成"泄漏 + 失败"。
    t.after(() => inner.cleanup());
    assert.equal(relative(outer.root, inner.root).startsWith('..'), false, 'the inner sandbox must live under the override');
    assert.equal(isInside(outer.root, inner.root), true);
    assert.equal(inner.tempRoot, outer.root);
    inner.cleanup();
    assert.equal(existsSync(inner.root), false, 'cleanup must still remove the sandbox under an override');
  });
});

test('覆盖目录不存在时自动创建（CI 作业目录常常还没建）', (t) => {
  const outer = createSandbox();
  t.after(() => outer.cleanup());
  const nested = join(outer.root, 'job-tmp', 'deep');
  assert.equal(existsSync(nested), false);

  withTempRoot(nested, () => {
    const inner = createSandbox();
    t.after(() => inner.cleanup());
    assert.equal(isInside(realpathSync(nested), inner.root), true);
    inner.cleanup();
  });
  assert.equal(existsSync(realpathSync(nested)), true, 'creating the root must not delete the root itself');
});

test('每个沙箱都以固定前缀命名，便于残留盘点', (t) => {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  assert.equal(basename(sandbox.root).startsWith(SANDBOX_PREFIX), true);
  // 残留盘点靠前缀匹配，前缀一旦换掉，泄漏就会变成"看不见的泄漏"。
  const siblings = readdirSync(sandbox.tempRoot).filter((name) => name.startsWith(SANDBOX_PREFIX));
  assert.ok(siblings.includes(basename(sandbox.root)), 'the runner counts leftovers by this prefix');
});

test('cleanup 只删自己那一个目录，重复调用不抛', (t) => {
  const keeper = createSandbox();
  t.after(() => keeper.cleanup());
  const victim = createSandbox();
  t.after(() => victim.cleanup());

  victim.cleanup();
  assert.equal(existsSync(victim.root), false);
  assert.equal(existsSync(keeper.root), true, 'cleanup must never touch a sibling sandbox');
  // 重复调用是 no-op（不抛）。注意这半条**不能**单独证明幂等：`rmSync(force)` 对
  // 不存在的路径本来就不抛，所以标题只声称到这里。
  victim.cleanup();
  assert.equal(existsSync(keeper.root), true);
});

test('拒绝把临时根指向仓库或用户数据（覆盖不等于放宽纪律）', (t) => {
  // 守卫必须在建目录**之前**触发：否则"拦住了"也已经在仓库里留了一个空目录。
  // 万一守卫回归（这条用例存在的意义就是抓它回归），收尾要替它擦干净，否则它自己
  // 会变成"把仓库搞脏"的那个。
  const repoProbe = join(REPO_ROOT, 'tmp-should-never-exist');
  t.after(() => rmSync(repoProbe, { recursive: true, force: true }));
  withTempRoot(repoProbe, () => {
    assert.throws(() => resolveTempRoot(), /refusing a temp root inside the repository/u);
  });
  assert.equal(existsSync(repoProbe), false, 'the guard must fire before the directory is created');

  const homeProbe = join(homedir(), '.ssh', 'm9-should-never-exist');
  t.after(() => rmSync(homeProbe, { recursive: true, force: true }));
  withTempRoot(homeProbe, () => {
    assert.throws(() => resolveTempRoot(), /refusing user data \(\.ssh\)/u);
  });
  assert.equal(existsSync(homeProbe), false);
});
