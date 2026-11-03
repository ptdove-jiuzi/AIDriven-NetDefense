/**
 * Isolation: this package decides, it never acts.
 *
 * Task constraint 6 ("不实现任何真实进程、网络或文件操作") is a property that cannot
 * be proved by a behavioural test — a hidden import would only show up when it
 * ran. So it is checked statically: every source file is read and scanned for the
 * modules and calls that would let the gate touch the machine.
 *
 * The second half checks the delivery rules that are easy to break by accident:
 * author, licence, and no platform branding in files that ship with the package.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { approvedTerminateScenario } from './helpers.js';
import { evaluateResponsePolicy } from '../../packages/response-policy/index.js';

const PACKAGE_ROOT = 'packages/response-policy';

/**
 * @returns {string[]} Repository-relative source files of the package.
 */
function sourceFiles() {
  const files = [join(PACKAGE_ROOT, 'index.js')];
  for (const name of readdirSync(join(PACKAGE_ROOT, 'src'))) {
    if (name.endsWith('.js')) files.push(join(PACKAGE_ROOT, 'src', name));
  }
  return files;
}

/**
 * @param {string} file Repository-relative path.
 * @returns {number} Modification time in milliseconds.
 */
function mtimeOf(file) {
  return statSync(file).mtimeMs;
}

describe('isolation', () => {
  it('imports no I/O, process or network module', () => {
    const forbiddenModules = [
      'node:fs',
      'node:fs/promises',
      'node:net',
      'node:dgram',
      'node:tls',
      'node:http',
      'node:https',
      'node:child_process',
      'node:os',
      'node:worker_threads',
      'node:cluster',
      'node:vm',
    ];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const module of forbiddenModules) {
        assert.equal(
          source.includes(`'${module}'`) || source.includes(`"${module}"`),
          false,
          `${file} imports ${module}`,
        );
      }
    }
  });

  it('calls no process-spawning, network or file-writing API', () => {
    const forbidden = [
      /\bspawn(Sync)?\s*\(/u,
      // `(?<![.\w])` keeps `RegExp.prototype.exec(` out of the net; a bare
      // `exec(`, `execFile(` or a destructured binding is still caught.
      /(?<![.\w])exec(File|Sync|FileSync)?\s*\(/u,
      /\bfork\s*\(/u,
      /\bwriteFile(Sync)?\s*\(/u,
      /\bunlink(Sync)?\s*\(/u,
      /\brm(Sync)?\s*\(/u,
      /\bmkdir(Sync)?\s*\(/u,
      /\bconnect\s*\(/u,
      /\blisten\s*\(/u,
      /\bkill\s*\(/u,
      /\bkillProcess\s*\(/u,
      /\brequire\s*\(/u,
    ];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(source), false, `${file} matches ${pattern}`);
      }
    }
  });

  it('leaves the filesystem untouched when deciding', () => {
    const files = [...sourceFiles(), join(PACKAGE_ROOT, 'package.json')];
    const before = files.map((file) => [file, mtimeOf(file)]);
    const decision = evaluateResponsePolicy(approvedTerminateScenario().request);
    assert.equal(decision.outcome, 'allow');
    const after = files.map((file) => [file, mtimeOf(file)]);
    assert.deepEqual(after, before);
  });

  it('ships only the declared entry point and src modules', () => {
    const entries = readdirSync(PACKAGE_ROOT).sort();
    assert.deepEqual(entries, ['index.js', 'package.json', 'src']);
    const srcEntries = readdirSync(join(PACKAGE_ROOT, 'src')).sort();
    for (const name of srcEntries) {
      assert.match(name, /^[a-z][a-z-]*\.js$/u, `unexpected source file ${name}`);
    }
  });

  it('declares PT-dove as the author and Apache-2.0 as the licence', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.author, 'PT-dove');
    assert.equal(manifest.license, 'Apache-2.0');
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.private, true);
    assert.equal(manifest.exports['.'], './index.js');
    assert.deepEqual(manifest.dependencies, { '@aegisharness/contracts': '1.0.0' });
  });

  it('carries no platform or vendor branding', () => {
    // 同 security.test.js：守卫不能明文写出被禁品牌名，片段拼接 + Unicode 转义。
    const banned = [
      new RegExp(['work', 'buddy'].join(''), 'iu'),
      new RegExp('work buddy', 'iu'),
      /tencent/iu,
      /\u817e\u8baf/u,
      new RegExp(['code', 'buddy'].join(''), 'iu'),
    ];
    const files = [...sourceFiles(), join(PACKAGE_ROOT, 'package.json')];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of banned) {
        assert.equal(pattern.test(source), false, `${file} mentions ${pattern}`);
      }
    }
  });

  it('keeps its test fixtures synthetic and in-memory', () => {
    const helpers = readFileSync('tests/wp7-response-policy/helpers.js', 'utf8');
    assert.equal(helpers.includes('node:fs'), false);
    assert.equal(helpers.includes('mkdtemp'), false);
    for (const marker of ['TestSandbox', 'aegis-test']) {
      assert.ok(helpers.includes(marker), `fixtures should stay inside ${marker}`);
    }
    assert.equal(helpers.includes('AppData'), false);
    assert.equal(helpers.includes('homedir'), false);
  });
});
