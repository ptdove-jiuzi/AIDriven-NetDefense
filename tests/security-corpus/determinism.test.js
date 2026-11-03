// author: PT-dove
// M9 对抗语料 —— 语料自身的纪律检查（元测试）。
//
// 这一组断言不测生产代码，测的是"语料能不能被信任"：
// 1. 确定性：没有 Math.random / Date.now / 真实路径参与生成；
// 2. 唯一性：任何两条样本的 id 不重复（否则覆盖表会悄悄少一条）；
// 3. 封闭性：测试不触网、不读真实日志、不写仓库外的地方（临时目录除外）；
// 4. 可失败性：每条期望错误码都必须真实存在，否则断言可能永远为真。

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES } from '../../packages/contracts/src/index.js';
import { ERROR_CODES as PLUGIN_CODES } from '../../apps/plugin-manager/src/index.js';
import { STORE_CODES } from '../../packages/event-store/src/index.js';
import {
  AUTH_LOG_LINE_CASES,
  INVALID_PLUGIN_IDS,
  LEXICAL_SOURCE_CASES,
  PAYLOAD_REJECTIONS,
  STRICT_JSON_ACCEPTANCES,
  STRICT_JSON_OPTION_ATTEMPTS,
  STRICT_JSON_REJECTIONS,
  UNSAFE_ENTRY_PATHS,
  WINDOWS_PAYLOAD_BAD_KEYS,
  WINDOWS_PAYLOAD_SANITIZE_CASES,
} from './support/corpus.js';
import { createDeterministicRandom, deterministicTokens } from './support/harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPPORT = path.join(HERE, 'support');

/**
 * 不参与"语料纪律"扫描的文件：运行器本身要起子进程并写时间戳，它属于工具而非样本。
 * @type {ReadonlySet<string>}
 */
const NOT_CORPUS = new Set(['determinism.test.js', 'run.mjs']);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(target);
  }
  return files.sort();
}

const CORPUS_TABLES = Object.freeze({
  STRICT_JSON_REJECTIONS,
  STRICT_JSON_ACCEPTANCES,
  STRICT_JSON_OPTION_ATTEMPTS,
  PAYLOAD_REJECTIONS,
  WINDOWS_PAYLOAD_BAD_KEYS,
  WINDOWS_PAYLOAD_SANITIZE_CASES,
  AUTH_LOG_LINE_CASES,
  LEXICAL_SOURCE_CASES,
  UNSAFE_ENTRY_PATHS,
  INVALID_PLUGIN_IDS,
});

test('语料表的规模不缩水（每个类别都有最低条数）', () => {
  const minimums = {
    STRICT_JSON_REJECTIONS: 45,
    STRICT_JSON_ACCEPTANCES: 10,
    STRICT_JSON_OPTION_ATTEMPTS: 6,
    PAYLOAD_REJECTIONS: 25,
    WINDOWS_PAYLOAD_BAD_KEYS: 8,
    WINDOWS_PAYLOAD_SANITIZE_CASES: 7,
    AUTH_LOG_LINE_CASES: 8,
    LEXICAL_SOURCE_CASES: 35,
    UNSAFE_ENTRY_PATHS: 18,
    INVALID_PLUGIN_IDS: 13,
  };
  for (const [name, minimum] of Object.entries(minimums)) {
    const table = CORPUS_TABLES[name];
    assert.ok(Array.isArray(table), `${name} must be an array`);
    assert.ok(
      table.length >= minimum,
      `${name} has ${table.length} cases, the corpus requires at least ${minimum}`,
    );
  }
});

test('所有语料表的 id 全局唯一（重复 id 会让覆盖计数虚高）', () => {
  const seen = new Map();
  for (const [table, entries] of Object.entries(CORPUS_TABLES)) {
    for (const entry of entries) {
      assert.equal(typeof entry.id, 'string', `${table} has an entry without an id`);
      assert.ok(entry.id.length > 0, `${table} has an empty id`);
      if (seen.has(entry.id)) {
        assert.fail(`duplicate corpus id ${entry.id} in ${table} and ${seen.get(entry.id)}`);
      }
      seen.set(entry.id, table);
    }
  }
  assert.ok(seen.size >= 150, `expected at least 150 distinct corpus entries, got ${seen.size}`);
});

test('每条期望错误码都真实存在于对应模块（防止拼写错误让断言永远为真）', () => {
  const contractCodes = new Set(Object.values(ERROR_CODES));
  const pluginCodes = new Set(Object.values(PLUGIN_CODES));
  const storeCodes = new Set(Object.values(STORE_CODES));

  for (const entry of STRICT_JSON_REJECTIONS) {
    assert.ok(contractCodes.has(entry.code), `${entry.id}: unknown contract code ${entry.code}`);
  }
  for (const entry of PAYLOAD_REJECTIONS) {
    assert.ok(contractCodes.has(entry.code), `${entry.id}: unknown contract code ${entry.code}`);
  }
  for (const entry of AUTH_LOG_LINE_CASES) {
    if (entry.rejectCode === null) continue;
    assert.ok(contractCodes.has(entry.rejectCode), `${entry.id}: unknown contract code ${entry.rejectCode}`);
  }
  for (const entry of LEXICAL_SOURCE_CASES) {
    if (entry.expectCode === null) continue;
    if (entry.expectCode === 'INVALID_VALUE') continue; // 由 tokenizer 直接抛，见 plugin-manager/src/errors.js
    assert.ok(pluginCodes.has(entry.expectCode), `${entry.id}: unknown plugin code ${entry.expectCode}`);
  }
  assert.ok(storeCodes.has('ERR_STORE_LOCKED') && storeCodes.has('ERR_TX_CONTROL'));
});

test('固定种子的随机源完全可复现：两次生成逐字相同', () => {
  const first = deterministicTokens(0x5eed, 32, 16);
  const second = deterministicTokens(0x5eed, 32, 16);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 32, 'the generator must not repeat itself inside one run');

  const different = deterministicTokens(0x5eee, 32, 16);
  assert.notDeepEqual(first, different, 'a different seed must produce different tokens');

  const generator = createDeterministicRandom(1);
  const values = Array.from({ length: 8 }, () => generator());
  for (const value of values) {
    assert.ok(value >= 0 && value < 1, 'the generator must stay in [0, 1)');
  }
  assert.deepEqual(values, Array.from({ length: 8 }, (() => {
    const again = createDeterministicRandom(1);
    return () => again();
  })()));
});

/**
 * 去掉整行注释后再扫描。
 *
 * 逐字扫描会把"注释里写着不许用 Math.random"这句话本身当成违规——那种元测试
 * 只能靠不断加例外维持，最后失去意义。这里只剔除整行 `//` 与 JSDoc 行，
 * 保留代码行，足以覆盖真实用法。
 *
 * @param {string} text 源文本。
 * @returns {string} 去注释后的文本。
 */
function readableLines(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

test('语料与测试代码里没有 Math.random / Date.now 参与断言内容', () => {
  const offenders = [];
  for (const file of [...walk(HERE), ...walk(SUPPORT)]) {
    const relative = path.relative(HERE, file).split(path.sep).join('/');
    if (NOT_CORPUS.has(relative)) continue;
    const text = readableLines(readFileSync(file, 'utf8'));
    for (const pattern of [/Math\.random\s*\(/gu, /Date\.now\s*\(/gu, /new Date\(\s*\)/gu, /performance\.now\s*\(/gu]) {
      if (pattern.test(text)) offenders.push(`${relative}: ${pattern.source}`);
    }
  }
  assert.deepEqual(offenders, [], 'no test may depend on wall clock or RNG for its content');
});

test('没有真实日志 / 真实用户目录被读取（fs 调用不带系统绝对路径字面量）', () => {
  // 样本里出现 "/var/../../etc/passwd" 是**攻击输入**，必须允许；要证明的是
  // "没有任何 fs 调用拿系统绝对路径当参数"，所以这里只看调用点，不看字符串常量。
  const fsCall = /(?:readFileSync|readdirSync|openSync|statSync|lstatSync|createReadStream)\(\s*(['"`])([^'"`]*)\1/gu;
  const offenders = [];
  for (const file of [...walk(HERE), ...walk(SUPPORT)]) {
    const relative = path.relative(HERE, file).split(path.sep).join('/');
    if (NOT_CORPUS.has(relative)) continue;
    const text = readableLines(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(fsCall)) {
      const argument = match[2];
      const absolute = argument.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(argument);
      const userDirectory = /Users[\\/]|home[\\/]|\.ssh/iu.test(argument);
      if (absolute || userDirectory) offenders.push(`${relative}: ${argument}`);
    }
  }
  assert.deepEqual(offenders, [], 'reads must go through the injected filesystem or a temp directory');
  // 唯一允许的"看起来像系统路径"的字符串是虚拟路径，由内存文件系统解释。
  const linux = readFileSync(path.join(HERE, 'collectors-linux.test.js'), 'utf8');
  assert.match(linux, /const LOG_PATH = '\/var\/log\/auth\.log';/u);
  assert.match(linux, /createMemoryFileSystem/u, 'the auth.log cases run against an in-memory filesystem');
});

test('只有三处会起子进程：崩溃夹具的父进程、崩溃夹具本身、Linux 专属 mkfifo 分支', () => {
  const allowed = new Set(['fixtures/crash-ingest.mjs', 'plugin-manager-manifest.test.js', 'event-store-negative.test.js']);
  const offenders = [];
  for (const file of [...walk(HERE), ...walk(SUPPORT)]) {
    const relative = path.relative(HERE, file).split(path.sep).join('/');
    if (NOT_CORPUS.has(relative) || allowed.has(relative)) continue;
    const text = readFileSync(file, 'utf8');
    if (/node:child_process/u.test(text)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], 'spawning processes must stay confined to the documented places');

  // 崩溃夹具只允许重新启动 node 自身，不允许调用任何外部程序。
  const crashFixture = readFileSync(path.join(HERE, 'fixtures', 'crash-ingest.mjs'), 'utf8');
  assert.equal(/node:child_process/u.test(crashFixture), false, 'the fixture is run BY a child, it must not spawn one');

  // 父进程只允许用 process.execPath 重跑夹具与占锁子进程，不允许起 shell。
  const parent = readFileSync(path.join(HERE, 'event-store-negative.test.js'), 'utf8');
  const spawns = [...parent.matchAll(/spawn(?:Sync)?\(\s*([^,\n]+)/gu)].map((match) => match[1].trim());
  assert.ok(spawns.length >= 2, 'the crash and lock-contention cases both need a child');
  for (const target of spawns) {
    assert.equal(target, 'process.execPath', `refusing to spawn ${target}; only the current node binary is allowed`);
  }
  assert.equal(/shell:\s*true/u.test(parent), false, 'no shell is ever involved');
});

test('没有真实网络访问（不引入 http/https/net/dns/fetch）', () => {
  const offenders = [];
  for (const file of [...walk(HERE), ...walk(SUPPORT)]) {
    const relative = path.relative(HERE, file).split(path.sep).join('/');
    if (NOT_CORPUS.has(relative)) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of [
      /from 'node:http'/gu,
      /from 'node:https'/gu,
      /from 'node:net'/gu,
      /from 'node:dns'/gu,
      /\bfetch\s*\(/gu,
      /XMLHttpRequest/u,
    ]) {
      if (pattern.test(text)) offenders.push(`${relative}: ${pattern.source}`);
    }
  }
  assert.deepEqual(offenders, [], 'no test may reach the network');
});

test('语料样本里不含任何看起来像真实凭据的字符串', () => {
  const suspicious = [
    /AKIA[0-9A-Z]{16}/u,
    /ghp_[A-Za-z0-9]{36}/u,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
    /password\s*=\s*['"][^'"]{6,}['"]/iu,
  ];
  const offenders = [];
  for (const file of [...walk(HERE), ...walk(SUPPORT)]) {
    const relative = path.relative(HERE, file).split(path.sep).join('/');
    if (NOT_CORPUS.has(relative)) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of suspicious) {
      if (pattern.test(text)) offenders.push(`${relative}: ${pattern.source}`);
    }
  }
  assert.deepEqual(offenders, [], 'no credential-shaped string may enter the corpus');
});

test('审计用的固定数值与 wina 无关：所有时间戳都是显式常量', () => {
  // 复核者常用"这个数字是哪来的"来质疑语料。这里把所有时间常量列出来，
  // 任何一个不含 2023/2026 年的时间戳都视为新增未审查常量。
  const text = readFileSync(path.join(HERE, 'support', 'fixtures.js'), 'utf8');
  const stamps = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/gu) ?? [];
  assert.ok(stamps.length >= 3, 'fixtures must declare explicit timestamps');
  for (const stamp of stamps) {
    assert.match(stamp, /^(2023|2026)-/u, `unexpected timestamp literal ${stamp}`);
  }
});
