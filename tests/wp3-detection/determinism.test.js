/**
 * determinism.test.js — byte identical replays, source level red lines and
 * caller object immutability.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createManualClock, createDetectionEngine, createSequenceIdFactory } from '../../packages/detection/index.js';
import { deepFreeze, makeEvent } from './helpers.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../packages/detection/', import.meta.url));

const FORBIDDEN_TOKENS = [
  'eval(',
  'new Function',
  'node:vm',
  'child_process',
  'Math.random',
  'Date.now(',
  'new Date(',
  'performance.now(',
  'import(',
  'require(',
];

const mixedPack = {
  schemaVersion: '1.0',
  packId: 'determinism-pack',
  packVersion: '3.1.4',
  rules: [
    {
      ruleId: 'proc.deterministic',
      version: '1.0.0',
      type: 'condition',
      severity: 'high',
      fields: ['process.name', 'process.path'],
      fingerprint: [{ path: 'process.path', transform: 'path' }],
      when: { field: 'process.name', operator: 'starts_with', value: 'example-' },
      tags: ['process'],
    },
    {
      ruleId: 'proc.burst',
      version: '1.1.0',
      type: 'threshold',
      severity: 'medium',
      fields: ['process.name'],
      groupBy: ['process.name'],
      count: { operator: 'gte', value: 2 },
      windowMs: 30000,
    },
    {
      ruleId: 'chain.example',
      version: '1.0.0',
      type: 'correlation',
      severity: 'critical',
      fields: ['process.name'],
      groupBy: ['process.name'],
      withinMs: 30000,
      steps: [
        { name: 'spawn', when: { field: 'process.name', operator: 'eq', value: 'example-process' } },
        { name: 'connect', when: { field: 'process.name', operator: 'eq', value: 'example-net' } },
      ],
    },
  ],
  allowlist: [
    {
      allowId: 'allow.deterministic',
      reason: 'synthetic allow entry',
      fields: ['process.name'],
      when: { field: 'process.name', operator: 'eq', value: 'example-allowed' },
    },
  ],
};

const deterministicEvents = [
  makeEvent({ eventId: 'evt-det-1', observedAt: 1000, fields: { process: { name: 'example-process', path: 'C:\\TMP\\Example\\' } } }),
  makeEvent({ eventId: 'evt-det-2', observedAt: 2000, fields: { process: { name: 'example-net', path: '/tmp/example/net' } } }),
  makeEvent({ eventId: 'evt-det-3', observedAt: 3000, fields: { process: { name: 'example-allowed', path: '/tmp/example/allowed' } } }),
  makeEvent({ eventId: 'evt-det-4', observedAt: 4000, severity: 'critical', fields: { process: { name: 'example-process', path: 'c:/tmp/example' } } }),
  makeEvent({ eventId: 'evt-det-5', observedAt: 31000, fields: { process: { name: 'example-process', path: '/tmp/example/tool' } } }),
];

function replay() {
  const clock = createManualClock(0);
  // 标识现在是随机 UUIDv4，字节相同只能靠注入的确定性工厂来保证：
  // 两台引擎各自新建 createSequenceIdFactory(1)，因此得到同一段序列。
  const engine = createDetectionEngine({ rulePack: mixedPack, clock, ids: createSequenceIdFactory(1) });
  const output = [];
  output.push(engine.ingest(deterministicEvents.slice(0, 2)));
  output.push(engine.ingest(deterministicEvents.slice(2)));
  output.push(engine.advanceTo(1000000));
  output.push(engine.ingest([makeEvent({ eventId: 'evt-det-6', observedAt: 1000001 })]));
  return { output, stats: engine.stats(), rules: engine.ruleStates() };
}

describe('determinism', () => {
  it('produces byte identical output for identical input and clock', () => {
    const first = replay();
    const second = replay();
    assert.equal(JSON.stringify(first.output), JSON.stringify(second.output));
    assert.equal(JSON.stringify(first.stats), JSON.stringify(second.stats));
    assert.equal(JSON.stringify(first.rules), JSON.stringify(second.rules));
    assert.equal(first.output[0].detections.length, 2);
    assert.notEqual(first.output[0].detections[0].fingerprint, first.output[0].detections[1].fingerprint);
    assert.equal(first.stats.analysisRequests > 0, true);
  });

  it('sorts every result array deterministically', () => {
    const result = replay().output[1];
    const alertKeys = result.alerts.map((alert) => [alert.windowStart, alert.fingerprint]);
    assert.deepEqual(alertKeys, [...alertKeys].sort((left, right) => comparePairs(left, right)));
    const gapPairs = result.gaps.map((gap) => [gap.kind, gap.ruleId ?? '', gap.at]);
    assert.deepEqual(gapPairs, [...gapPairs].sort((left, right) => comparePairs(left, right)));
    const detectionKeys = result.detections.map((detection) => [
      detection.observedAt,
      detection.ruleId,
      detection.fingerprint,
    ]);
    assert.deepEqual(detectionKeys, [...detectionKeys].sort((left, right) => comparePairs(left, right)));
    const requestKeys = result.analysisRequests.map((request) => [
      request.hourStart,
      request.fingerprint,
      request.sequenceInHour,
    ]);
    assert.deepEqual(requestKeys, [...requestKeys].sort((left, right) => comparePairs(left, right)));
  });

  it('keeps the package free of dynamic code, hidden clocks and side channels', () => {
    const sources = collectSources();
    assert.equal(sources.length >= 17, true);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const token of FORBIDDEN_TOKENS) {
        assert.equal(text.includes(token), false, `${file} must not contain ${token}`);
      }
      // 熵源红线收窄为"只允许一个文件碰 CSPRNG"：随机只服务于标识生成。
      // 名单覆盖 Node 与 WebCrypto 两套 API，避免"换个函数名就绕过"。
      const entropyApi = ENTROPY_APIS.find((token) => text.includes(token));
      if (entropyApi !== undefined) {
        assert.equal(
          file.endsWith(`${sep}ids.js`),
          true,
          `${file} must not reference ${entropyApi} (only src/ids.js may mint randomness)`,
        );
      }
      // 说明符扫描必须同时认单引号和双引号：只认单引号时，`from "@aegisharness/contracts"`
      // 这种改写可以整条绕过本门禁（上一轮审查 P2-5 的实测缺口）。
      for (const specifier of importSpecifiersOf(text)) {
        const internal = specifier.startsWith('./') || specifier.startsWith('../');
        if (specifier.startsWith('node:')) {
          assert.equal(
            ['node:crypto', 'node:fs', 'node:path'].includes(specifier),
            true,
            `${file} imports ${specifier}`,
          );
          continue;
        }
        if (internal) {
          continue;
        }
        // 唯一的裸包说明符是合同包，且只允许出现在契约适配层这一处。
        assert.equal(specifier, '@aegisharness/contracts', `${file} imports ${specifier}`);
        assert.equal(file.endsWith(`${sep}contracts-adapter.js`), true, `${file} must not import ${specifier}`);
      }
    }
    // 上面只查直接 import。真正的红线是"引擎核心不依赖 contracts"，而这条边可以
    // 通过中间文件传递进来（review 实测：rate-limit → contracts-adapter 就能把
    // contracts 拖进 engine 的模块图，而按文件的直接 import 检查完全看不见）。
    // 因此从 src/engine.js 出发做一次传递闭包：它的任何一个相对依赖都不许是适配层。
    // 包入口 index.js 例外——它本来就要 re-export 适配层，那是包的对外表面。
    const engineEntry = join(PACKAGE_ROOT, 'src', 'engine.js');
    const reached = contractsReachableFrom(engineEntry, sources);
    assert.equal(reached, null, `the engine core reaches @aegisharness/contracts through ${reached}`);
    // 适配层要自己格式化时间，绝不允许借道 Date。
    const adapter = readFileSync(join(PACKAGE_ROOT, 'src', 'contracts-adapter.js'), 'utf8');
    for (const token of ['Date.now(', 'new Date(', 'Math.random']) {
      assert.equal(adapter.includes(token), false, `contracts-adapter.js must not contain ${token}`);
    }
  });

  it('only rule-pack.js touches the filesystem', () => {
    for (const file of collectSources()) {
      const text = readFileSync(file, 'utf8');
      const touchesFileSystem = text.includes('node:fs');
      assert.equal(touchesFileSystem, file.endsWith('rule-pack.js'), `${file} filesystem usage mismatch`);
    }
  });

  it('processes deeply frozen caller objects without mutating them', () => {
    const engine = createDetectionEngine({ rulePack: mixedPack, clock: createManualClock(0) });
    const event = deepFreeze(
      makeEvent({
        eventId: 'evt-frozen-1',
        observedAt: 1000,
        fields: { process: { name: 'example-process', path: '/tmp/example/tool' } },
      }),
    );
    const snapshot = JSON.stringify(event);
    const result = engine.ingest([event]);
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].ruleId, 'proc.deterministic');
    assert.equal(JSON.stringify(event), snapshot);
    assert.equal(Object.isFrozen(event.fields.process), true);
  });
});

/**
 * Entropy APIs that must stay confined to `src/ids.js`.
 *
 * The old gate only banned the literal `randomUUID`, so `randomBytes`,
 * `getRandomValues` or a `crypto.subtle` call would have passed unnoticed.
 */
const ENTROPY_APIS = ['randomUUID', 'randomBytes', 'randomFillSync', 'randomInt', 'getRandomValues', 'crypto.subtle'];

/**
 * Extract every module specifier from a source file, quote style agnostic.
 *
 * @param {string} text File contents.
 * @returns {string[]} Import specifiers in source order.
 */
function importSpecifiersOf(text) {
  return [...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]);
}

/**
 * Resolve a relative specifier to an absolute file inside the package.
 *
 * @param {string} fromFile Absolute path of the importing file.
 * @param {string} specifier Relative specifier, already known to be relative.
 * @returns {string | null} Absolute target path, or `null` when it is not a package file.
 */
function resolveRelative(fromFile, specifier) {
  const base = join(fromFile, '..', specifier);
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // 继续试下一个候选
    }
  }
  return null;
}

/**
 * Walk the relative import graph from one file and report how contracts was reached.
 *
 * @param {string} entry Absolute path of the starting file.
 * @param {readonly string[]} packageFiles Every source file of the package.
 * @returns {string | null} A `->`-joined path that reaches contracts, or `null`.
 */
function contractsReachableFrom(entry, packageFiles) {
  const known = new Set(packageFiles);
  const queue = [[entry, entry.split(sep).pop()]];
  const visited = new Set([entry]);
  while (queue.length > 0) {
    const [file, trail] = queue.shift();
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of importSpecifiersOf(text)) {
      if (specifier === '@aegisharness/contracts') {
        return `${trail} -> ${specifier}`;
      }
      if (!(specifier.startsWith('./') || specifier.startsWith('../'))) {
        continue;
      }
      const target = resolveRelative(file, specifier);
      if (target === null || visited.has(target) || !known.has(target)) {
        continue;
      }
      visited.add(target);
      queue.push([target, `${trail} -> ${target.split(sep).pop()}`]);
    }
  }
  return null;
}

/**
 * Collect every source file of the package, recursively.
 *
 * The old version only looked at `src/*.js` plus `index.js`, so a new
 * `src/sub/anything.js` was invisible to every red line in this file.
 *
 * @returns {string[]} Absolute source paths in a stable order.
 */
function collectSources() {
  const files = [join(PACKAGE_ROOT, 'index.js')];
  const pending = [join(PACKAGE_ROOT, 'src')];
  while (pending.length > 0) {
    const directory = pending.shift();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      left.name.localeCompare(right.name, 'en')
    ))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.name.endsWith('.js')) {
        files.push(absolute);
      }
    }
  }
  return files;
}

function comparePairs(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) {
        return a - b;
      }
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}
