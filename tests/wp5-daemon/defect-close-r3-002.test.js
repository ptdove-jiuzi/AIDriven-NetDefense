/**
 * defect-close-r3-002.test.js — 回归守卫：wp5-daemon 门禁不得整段挂起，产品也不得把同步 poll 改成异步。
 *
 * 背景（BUG-LEDGER R3-002 / N-014 / N-015）：
 * - 旧 `tests/wp5-daemon/restart-recovery.test.js` 只等 "poll 发生" 就 stop（竞态），失败路径没有
 *   `try/finally` 关掉第二个 daemon → 监听器泄漏 → 整个 `node --test` 永不退出。
 * - 同一条链上还有一个产品侧回退：`apps/daemon/src/daemon.js` 的 `observeSourcePoll` 曾被写成
 *   `async poll(ctx) { … await poll.call(…) … }`，多出来的一个 microtask 让 `scheduler.js`
 *   "poll 在 stop 后才落地就不推进游标" 的规则命中同步 source，游标被静默丢弃。
 *
 * 本文件补的缺口（③）：
 * 1. **同步记录不许多吃一个 microtask** —— poll 返回后队列里的第一个 microtask 必须已经能在
 *    `/status` 里看到这次 poll 的结果。把 wrapper 改回 `async` 包裹，这条直接转红。
 * 2. **有界退出**：stop 必须在预算内完成；本文件本身也必须在预算内跑完（子进程实测退出码）。
 * 3. **失败路径不泄漏**：断言失败时 `finally` 仍然关掉 listener；泄漏计数必须回到基线。
 * 4. **游标恢复**：等到 ingest 完成再 stop，第二次启动必须拿到持久化游标。
 *
 * 变异证明（attacker 请按这个打）：`DEFECT_CLOSE_DAEMON_MODULE` 可指向
 * `docs/implementation/evidence/defect-close/R3-002/fix/mutated-async-daemon.mjs`
 * （由 `mutate-daemon-async-poll.mjs` 生成，只把 `poll(ctx)` 改回 `async poll` + `await`）。
 * 缺省时导入仓库真实 `apps/daemon/src/daemon.js`。
 *
 * 运行：node --test tests/wp5-daemon/defect-close-r3-002.test.js
 *
 * 作者：PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createManualClock } from '../../apps/daemon/src/clock.js';
import { BASE_MS, makeConfig, makeEvent, makeTempDir, settle, waitFor } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DAEMON_SOURCE = path.join(REPO_ROOT, 'apps', 'daemon', 'src', 'daemon.js');
const DAEMON_MODULE = process.env.DEFECT_CLOSE_DAEMON_MODULE === undefined
  ? DAEMON_SOURCE
  : path.resolve(process.env.DEFECT_CLOSE_DAEMON_MODULE);
const SELF = fileURLToPath(import.meta.url);
const NESTED = process.env.DEFECT_CLOSE_R3_002_NESTED === '1';

// The module under test: the repository file, or a mutated copy for the mutation proof.
const { createDaemon } = await import(pathToFileURL(DAEMON_MODULE).href);

/** Active TCP server handles: a leaked control API listener shows up here. */
function tcpServerCount() {
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
}

function storeEvents(daemon) {
  try {
    return daemon.status().store.stats().events;
  } catch {
    return 0;
  }
}

async function boot(dir, source) {
  const daemon = createDaemon({
    config: makeConfig(dir, { top: { mode: 'full' } }),
    sources: source === null ? [] : [source],
    clock: createManualClock(BASE_MS),
  });
  await daemon.start();
  return daemon;
}

/** Strip comments so "the code must not say async" is not tripped by the explanation of why. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

/** Extract one top-level function body by brace matching (comments already stripped). */
function functionBody(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in ${DAEMON_MODULE}`);
  const braceStart = source.indexOf('{', start);
  assert.notEqual(braceStart, -1, `${name} must have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return assert.fail(`${name} body is unbalanced in ${DAEMON_MODULE}`);
}

describe('R3-002：daemon 的同步 poll 观测必须是同步的（产品回退转红）', () => {
  it('observeSourcePoll 的 poll 不许是 async，也不许 await 生产者', () => {
    const body = stripComments(functionBody(fs.readFileSync(DAEMON_MODULE, 'utf8'), 'observeSourcePoll'));

    assert.equal(
      /\basync\s+poll\s*\(/u.test(body),
      false,
      'observeSourcePoll 的 poll 被改回 async：同步 source 的结果会晚一个 microtask 落地（N-014）',
    );
    assert.equal(
      /\bawait\b/u.test(body),
      false,
      'observeSourcePoll 里出现了 await：同步 source 会被推到一个 microtask 之后',
    );
    // The synchronous path must record before returning, in the same stack.
    const recordIndex = body.indexOf('recordOutcome(result);');
    const returnIndex = body.indexOf('return result;');
    assert.notEqual(recordIndex, -1, '同步路径必须在返回前记录 outcome');
    assert.notEqual(returnIndex, -1, '同步路径必须原样返回 poll 的结果');
    assert.ok(recordIndex < returnIndex, '必须先 recordOutcome(result) 再 return result');
    // The thenable branch must survive: async collectors still record on resolution.
    assert.equal(
      body.includes("typeof result.then === 'function'"),
      true,
      'thenable 分支被删掉：异步 source 的结果不会再被记录',
    );
  });

  it('同步 poll 的 outcome 在下一个 microtask 就能被 /status 看到', async () => {
    const dir = makeTempDir();
    const events = [makeEvent({ source_seq: 1 })];
    const sourceId = 'synthetic.microtask';
    let calls = 0;
    let probe = null;

    const source = {
      id: sourceId,
      kind: 'process',
      intervalMs: 3_600_000,
      poll() {
        calls += 1;
        if (calls === 1) {
          return { events, cursor: { offset: events.length } };
        }
        const code = `DEFECT_CLOSE_MICROTASK_${calls}`;
        // Queued *inside* the poll: it runs before the wrapper's continuation only if the
        // wrapper recorded the outcome synchronously. An `async` wrapper defers that.
        probe = new Promise((resolve) => {
          queueMicrotask(() => {
            let seen;
            try {
              seen = daemon.status().scheduler.status()
                .find((row) => row.id === sourceId)?.last_empty_code ?? null;
            } catch (error) {
              seen = `STATUS_ERROR:${error?.message ?? error}`;
            }
            resolve({ seen, code });
          });
        });
        return { events: [], empty: { code, reason: 'defect-close microtask probe' } };
      },
    };

    const daemon = await boot(dir, source);
    try {
      await waitFor(() => storeEvents(daemon) === 1, { label: '第一次 poll 已完成 ingest' });
      await settle();
      const pollPromise = daemon.pollSource(sourceId);
      await waitFor(() => probe !== null, { label: '第二次 poll 已安装探针' });
      const observed = await probe;
      await pollPromise;

      assert.equal(
        observed.seen,
        observed.code,
        '同步 poll 的结果必须在这个 microtask 里就可见；为 null 说明 wrapper 多吃了 microtask（async 回退）',
      );
    } finally {
      await daemon.stop('probe-done');
    }
  });
});

describe('R3-002：有界停止、失败不泄漏、游标可恢复', () => {
  it('stop 在有界时间内完成，并且不留下监听器', async () => {
    const dir = makeTempDir();
    const events = [makeEvent({ source_seq: 1 })];
    const daemon = await boot(dir, {
      id: 'synthetic.bounded',
      kind: 'process',
      intervalMs: 3_600_000,
      poll: () => ({ events, cursor: { offset: events.length } }),
    });
    try {
      await waitFor(() => storeEvents(daemon) === 1, { label: 'ingest 完成' });
      assert.ok(tcpServerCount() >= 1, '控制 API 监听器应当在运行期存在（对照，防止"没有监听器"恒真）');
      const startedAt = Date.now();
      await daemon.stop('bounded');
      const elapsed = Date.now() - startedAt;
      assert.equal(elapsed < 15_000, true, `stop() 用了 ${elapsed}ms，超过 15s 预算：门禁会在这一段挂住`);
      assert.equal(daemon.address(), null, 'stop() 之后控制 API 必须被关闭并清空');
      // The accept handle unregisters on the turn after close(), so a bounded wait is the
      // honest assertion; a real leak never reaches zero and times out here.
      await waitFor(() => tcpServerCount() === 0, { label: 'stop() 之后不泄漏 TCPServerWrap 句柄' });
    } finally {
      await daemon.stop('finally');
    }
  });

  it('断言失败的路径里 finally 仍关掉 listener，不留句柄', async () => {
    const dir = makeTempDir();
    const daemon = await boot(dir, {
      id: 'synthetic.quiet',
      kind: 'process',
      intervalMs: 3_600_000,
      poll: () => ({ events: [], empty: { code: 'DEFECT_CLOSE_QUIET', reason: 'no rows' } }),
    });
    await assert.rejects(
      async () => {
        try {
          assert.equal(daemon.state(), 'running');
          // The exact shape of the old defect: an assertion that fails *after* the daemon
          // booted. Without the `finally` the listener would stay alive and `node --test`
          // would never exit (R3-002).
          assert.fail('simulated assertion failure after boot');
        } finally {
          await daemon.stop('failed-assertion');
        }
      },
      /simulated assertion failure/u,
    );
    assert.equal(daemon.address(), null, '失败路径上的 stop() 必须真的执行');
    await waitFor(() => tcpServerCount() === 0, { label: '失败路径不允许泄漏 listener' });
  });

  it('等到 ingest 完成再 stop，第二次启动恢复持久化游标', async () => {
    const dir = makeTempDir();
    const events = [makeEvent({ source_seq: 1 })];
    const cursorsFirst = [];
    let first = null;
    try {
      first = await boot(dir, {
        id: 'synthetic.replay',
        kind: 'process',
        intervalMs: 3_600_000,
        poll(ctx) {
          cursorsFirst.push(ctx.cursor);
          return { events, cursor: { offset: events.length } };
        },
      });
      // Wait for the *ingest*, not merely for the poll to be called: stopping while a poll
      // is in flight legitimately drops the cursor (scheduler), which made the old test a
      // race rather than a recovery defect.
      await waitFor(() => storeEvents(first) === 1, { label: '第一次 ingest 完成' });
      assert.equal(cursorsFirst[0], null, '第一次启动没有游标');
    } finally {
      if (first !== null) {
        await first.stop('restart');
      }
    }

    const cursorsSecond = [];
    let second = null;
    try {
      second = await boot(dir, {
        id: 'synthetic.replay',
        kind: 'process',
        intervalMs: 3_600_000,
        poll(ctx) {
          cursorsSecond.push(ctx.cursor);
          return { events, cursor: { offset: events.length } };
        },
      });
      await waitFor(() => cursorsSecond.length >= 1, { label: '第二次启动已 poll' });
      assert.deepEqual(cursorsSecond[0], { offset: 1 }, '第二次启动必须从持久化游标恢复');
    } finally {
      if (second !== null) {
        await second.stop('done');
      }
    }
  });
});

describe('R3-002：整段门禁必须在预算内退出（不是挂起）', () => {
  it('以子进程重跑本文件：有退出码、失败数为 0、远低于 120s', () => {
    if (NESTED) {
      // The nested run must not spawn another copy; it is the subject under measurement.
      assert.equal(process.env.DEFECT_CLOSE_R3_002_NESTED, '1');
      return;
    }
    const startedAt = Date.now();
    // The test runner exports NODE_TEST_CONTEXT to its children; inherited, it makes the
    // nested `node --test` think it is a recursively started run and skip the file. Remove
    // it so the child is an ordinary top-level run.
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.startsWith('NODE_TEST') === false),
    );
    const result = spawnSync(process.execPath, ['--test', SELF], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...childEnv, DEFECT_CLOSE_R3_002_NESTED: '1' },
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(
      result.status,
      0,
      `子进程 node --test 未在预算内干净退出（status=${result.status}, signal=${result.signal}，${elapsed}ms）`
        + `——这正是 R3-002 的挂起形态。stderr 尾部：\n${String(result.stderr).slice(-2000)}`,
    );
    assert.equal(elapsed < 120_000, true, `子进程用了 ${elapsed}ms`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /ℹ fail 0/u, '子进程里出现了失败用例');
    assert.match(output, /ℹ skipped 0/u, '子进程里出现了跳过用例（等于把门禁变空转）');
  });
});
