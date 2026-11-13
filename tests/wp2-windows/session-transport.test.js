/**
 * The persistent interpreter transport, mostly without a real interpreter: a fake child
 * drives the line protocol so ordering, timeouts and recovery are deterministic. The last
 * two tests run the real `powershell.exe` and prove CL-5 equivalence and the no-orphan
 * contract; everything else is pure protocol.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  POWERSHELL_FLAGS,
  SESSION_SENTINELS,
  WINDOWS_ERROR_CODES,
  buildRunKeysScript,
  createCommandRunner,
  createPowerShellClient,
  encodeCommand,
} from '../../packages/collectors/windows/index.js';

const WINDOWS = process.platform === 'win32';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4_000 + Math.floor(Math.random() * 1_000);
    this.killed = false;
    this.writes = [];
    this.stdout = new EventEmitter();
    this.stdout.unref = () => {};
    this.stderr = new EventEmitter();
    this.stderr.unref = () => {};
    this.stdin = {
      unref: () => {},
      on: () => {},
      write: (chunk) => {
        this.writes.push(chunk);
        this.onWrite?.(this, chunk);
        return true;
      },
    };
  }

  unref() {}

  emitLine(text) {
    this.stdout.emit('data', Buffer.from(`${text}\n`, 'utf8'));
  }

  kill() {
    this.killed = true;
    this.emit('close', null);
  }
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeRequest(chunk) {
  return JSON.parse(Buffer.from(chunk.toString('utf8').trim(), 'base64').toString('utf8'));
}

/** Answer a request the way the bootstrap does: BEGIN, one payload line, END. */
function answer(child, chunk, { text = '{}', error = null } = {}) {
  const request = decodeRequest(chunk);
  if (error !== null) {
    child.emitLine(`${SESSION_SENTINELS.END} ${request.id} err ${base64(error)}`);
    return request;
  }
  child.emitLine(`${SESSION_SENTINELS.BEGIN} ${request.id}`);
  child.emitLine(base64(text));
  child.emitLine(`${SESSION_SENTINELS.END} ${request.id} ok`);
  return request;
}

/** Spawner whose children answer through the supplied handler. */
function createFakeSpawnerFixture(handler = null) {
  const spawned = [];
  const spawnChild = () => {
    const child = new FakeChild();
    child.onWrite = handler;
    spawned.push(child);
    setImmediate(() => child.emitLine(SESSION_SENTINELS.READY));
    return child;
  };
  return { spawnChild, spawned };
}

/** A runner double that records calls and answers with a fixed one-shot result. */
function createRunnerDouble(stdout = '[]') {
  const calls = [];
  return {
    calls,
    persistentSession: false,
    async run(request) {
      calls.push(request);
      return {
        ok: true,
        code: 0,
        signal: null,
        stdout,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    },
  };
}

test('the interpreter is started lazily, on the first read', async () => {
  const { spawnChild, spawned } = createFakeSpawnerFixture((child, chunk) => answer(child, chunk, { text: '[]' }));
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });

  assert.equal(client.sessionStats().spawns, 0, 'no interpreter may be started before the first read');
  assert.equal(spawned.length, 0);
  await client.runJson('"x"');
  assert.equal(spawned.length, 1);
  client.dispose();
});

test('three sequential reads cost exactly one interpreter start', async () => {
  const { spawnChild } = createFakeSpawnerFixture((child, chunk) => answer(child, chunk, { text: '[{"ok":true}]' }));
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });

  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(await client.runJson('"x"'), [{ ok: true }]);
  }
  const stats = client.sessionStats();
  assert.equal(stats.spawns, 1);
  assert.equal(stats.requests, 3);
  client.dispose();
});

test('concurrent reads are serialized: one request in flight, every answer to its caller', async () => {
  let inFlight = 0;
  const violations = [];
  const { spawnChild } = createFakeSpawnerFixture((child, chunk) => {
    inFlight += 1;
    if (inFlight > 1) {
      violations.push(inFlight);
    }
    const request = decodeRequest(chunk);
    setTimeout(() => {
      child.emitLine(`${SESSION_SENTINELS.BEGIN} ${request.id}`);
      child.emitLine(base64(`[{"id":"${request.id}"}]`));
      child.emitLine(`${SESSION_SENTINELS.END} ${request.id} ok`);
      inFlight -= 1;
    }, 5);
  });
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });

  const results = await Promise.all([
    client.runJson('# aegis-source:a\n"a"'),
    client.runJson('# aegis-source:b\n"b"'),
    client.runJson('# aegis-source:c\n"c"'),
  ]);
  assert.deepEqual(violations, [], 'the stdout channel must never carry two requests at once');
  assert.deepEqual(results.map((entry) => entry[0].id), ['s1', 's2', 's3'], 'answers are matched in order');
  client.dispose();
});

test('stray host output between sentinels is ignored, not parsed as the payload', async () => {
  const { spawnChild } = createFakeSpawnerFixture((child, chunk) => {
    const request = decodeRequest(chunk);
    child.emitLine('Write-Host leaked this line');
    child.emitLine(`${SESSION_SENTINELS.BEGIN} ${request.id}`);
    child.emitLine('another stray line');
    child.emitLine(base64('[{"ok":1}]'));
    child.emitLine(`${SESSION_SENTINELS.END} ${request.id} ok`);
  });
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });
  assert.deepEqual(await client.runJson('"x"'), [{ ok: 1 }]);
  client.dispose();
});

test('a payload survives newlines, quotes and non-ASCII text', async () => {
  const payload = 'a\nb "c" 中文 ünïcode\ttab';
  const { spawnChild } = createFakeSpawnerFixture((child, chunk) => answer(child, chunk, { text: payload }));
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });
  assert.equal(await client.runText('"x"'), payload);
  client.dispose();
});

test('a script error is classified and not retried on the one-shot path', async () => {
  const { spawnChild } = createFakeSpawnerFixture((child, chunk) => {
    answer(child, chunk, { error: 'Exception: Access is denied' });
  });
  const runner = createRunnerDouble();
  const client = createPowerShellClient({ runner, session: true, spawnChild });

  await assert.rejects(() => client.runJson('"x"'), (error) => error.code === WINDOWS_ERROR_CODES.ACCESS_DENIED);
  assert.equal(runner.calls.length, 0, 'a script-level failure must not be retried');
  client.dispose();
});

test('a timeout kills the interpreter and the next read starts a fresh one', async () => {
  const { spawnChild, spawned } = createFakeSpawnerFixture((child, chunk) => {
    const request = decodeRequest(chunk);
    if (request.script.includes('never answers')) {
      return;
    }
    answer(child, chunk, { text: '[{"recovered":true}]' });
  });
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });

  await assert.rejects(
    () => client.runJson('"never answers"', { timeoutMs: 40 }),
    (error) => error.code === WINDOWS_ERROR_CODES.TIMEOUT,
  );
  assert.equal(spawned[0].killed, true, 'a timed-out interpreter must be killed, not reused');

  assert.deepEqual(await client.runJson('"again"'), [{ recovered: true }]);
  assert.equal(spawned.length, 2, 'the retry must have started a fresh interpreter');
  assert.equal(client.sessionStats().spawns, 2);
  client.dispose();
});

test('an out-of-order answer is a transport failure, never data', async () => {
  const { spawnChild, spawned } = createFakeSpawnerFixture((child) => {
    child.emitLine(`${SESSION_SENTINELS.BEGIN} s999`);
    child.emitLine(base64('[{"wrong":true}]'));
    child.emitLine(`${SESSION_SENTINELS.END} s999 ok`);
  });
  const runner = createRunnerDouble('[{"from":"one-shot"}]');
  const client = createPowerShellClient({ runner, session: true, spawnChild });

  assert.deepEqual(await client.runJson('"x"'), [{ from: 'one-shot' }]);
  assert.equal(spawned[0].killed, true, 'a desynced interpreter is killed');
  assert.equal(runner.calls.length, 1, 'exactly one one-shot retry');
  client.dispose();
});

test('an interpreter that exits mid-request falls back to one-shot instead of failing the read', async () => {
  const { spawnChild, spawned } = createFakeSpawnerFixture((child) => {
    setImmediate(() => child.emit('close', 1));
  });
  const runner = createRunnerDouble('[{"from":"one-shot"}]');
  const client = createPowerShellClient({ runner, session: true, spawnChild });

  assert.deepEqual(await client.runJson('"x"'), [{ from: 'one-shot' }]);
  assert.equal(runner.calls.length, 1);
  assert.equal(spawned.length, 1);
  client.dispose();
});

test('auto mode leaves an injected execFile double on the one-shot path', async () => {
  const runner = createRunnerDouble('[{"ok":1}]');
  const { spawnChild, spawned } = createFakeSpawnerFixture();
  const client = createPowerShellClient({ runner, spawnChild });

  assert.deepEqual(await client.runJson('"x"'), [{ ok: 1 }]);
  assert.equal(spawned.length, 0, 'a runner without the persistentSession marker must not start a session');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].args.includes('-EncodedCommand'), true);
  client.dispose();
});

test('dispose() fails an in-flight read instead of leaving it pending', async () => {
  const { spawnChild, spawned } = createFakeSpawnerFixture();
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });

  const pending = client.runJson('"never answers"', { timeoutMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  client.dispose();
  await assert.rejects(() => pending, (error) => error instanceof Error);
  assert.equal(spawned[0].killed, true);
  const stats = client.sessionStats();
  assert.equal(stats.enabled, false);
  assert.equal(stats.spawns, 1, 'the counters survive dispose for the perf evidence');
});

test('the one-shot fallback still carries the script in -EncodedCommand, never stdin', () => {
  const args = [...POWERSHELL_FLAGS, encodeCommand('Get-Date')];
  assert.equal(args.includes('-Command'), false, 'the script must not travel over stdin (CL-5)');
  assert.equal(args.includes('-EncodedCommand'), true);
});

test('the slow scheduled-tasks lane does not block the general lane', async () => {
  const { spawnChild, spawned } = createFakeSpawnerFixture((child, chunk) => {
    const request = decodeRequest(chunk);
    if (request.script.includes('aegis-source:scheduled-tasks')) {
      // A 4–7 s cmdlet: never answered inside this test's budget.
      return;
    }
    answer(child, chunk, { text: '[{"ok":1}]' });
  });
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });

  const slow = client.runJson('# aegis-source:scheduled-tasks\n"slow"', { timeoutMs: 400 }).catch((error) => error.code);
  // The general-lane read must complete while the slow lane is still stuck.
  assert.deepEqual(await client.runJson('# aegis-source:services\n"fast"'), [{ ok: 1 }]);
  assert.equal(await slow, WINDOWS_ERROR_CODES.TIMEOUT);

  const stats = client.sessionStats();
  assert.equal(spawned.length, 2, 'each lane owns its own interpreter');
  assert.equal(stats.laneCount, 2);
  assert.equal(stats.lanes[0].requests, 1, 'the fast read went to lane 0');
  assert.equal(stats.lanes[1].requests, 1, 'scheduled-tasks went to lane 1');
  assert.equal(stats.lanes[1].timeouts, 1);
  assert.equal(stats.lanes[0].timeouts, 0);
  assert.equal(stats.lanes[0].exits, 0, 'the healthy lane must not be recycled by the other lane timeout');
  client.dispose();
});

test('dispose() clears every lane', async () => {
  const { spawnChild, spawned } = createFakeSpawnerFixture((child, chunk) => answer(child, chunk, { text: '[]' }));
  const client = createPowerShellClient({ runner: createRunnerDouble(), session: true, spawnChild });
  await client.runJson('# aegis-source:services\n"x"');
  await client.runJson('# aegis-source:scheduled-tasks\n"x"');
  assert.equal(spawned.length, 2);
  client.dispose();
  assert.equal(spawned.every((child) => child.killed === true), true, 'both interpreters must be killed');
  const stats = client.sessionStats();
  assert.equal(stats.enabled, false);
  assert.equal(stats.lanes.every((lane) => lane.alive === false), true);
});

test('CL-5: the same real script yields identical items cold and in a session', { skip: WINDOWS ? false : 'needs powershell.exe' }, async () => {
  const runner = createCommandRunner({ timeoutMs: 30_000 });
  const cold = createPowerShellClient({ runner, session: false, timeoutMs: 30_000 });
  const warm = createPowerShellClient({ runner, session: 'auto', timeoutMs: 30_000 });
  assert.equal(warm.sessionStats().enabled, true, 'the built-in runner must select the session transport');

  const script = buildRunKeysScript();
  const coldTable = await cold.runJson(script);
  const warmTable = await warm.runJson(script);
  const warmAgainTable = await warm.runJson(script);
  const coldRows = coldTable.values;
  const warmRows = warmTable.values;
  const warmAgain = warmAgainTable.values;

  const fieldsOf = (rows) => [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  assert.equal(coldRows.length > 0, true, 'the registry must actually have Run values on this host');
  assert.equal(warmRows.length, coldRows.length, 'the session must not lose or duplicate items');
  assert.equal(warmAgain.length, coldRows.length);
  assert.deepEqual(fieldsOf(warmRows), fieldsOf(coldRows), 'the session must not change the field set');
  assert.deepEqual(warmRows, coldRows, 'the parsed payload must be identical, not merely the same count');
  assert.deepEqual(warmTable.deniedKeys, coldTable.deniedKeys);

  const stats = warm.sessionStats();
  assert.equal(stats.spawns, 1, 'two session reads share one interpreter');
  const pid = stats.pid;
  warm.dispose();
  cold.dispose();

  // No orphan: the killed interpreter disappears from the process table.
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `interpreter ${pid} must be gone after dispose()`);
});
