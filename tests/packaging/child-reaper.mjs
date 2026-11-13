/**
 * Child-process reaper for the packaging suites (author PT-dove).
 *
 * Why this file exists: `node --test` gives a test file **no** watchdog. If a test
 * spawns a long-lived shipped process (the daemon, the console server) and an
 * assertion throws before the `finally`, that child stays alive with its stdout and
 * stderr pumps still attached to the test runner's child process. The event loop of
 * that child never drains, so the file never reports, so the runner waits forever —
 * and the summary is only flushed when someone kills it. That is exactly the
 * "47 passed, then the runner never exited" symptom, and it is silent: no failing
 * assertion points at the leak.
 *
 * So every spawn in these suites goes through `trackedSpawn`, and every suite ends
 * with `after(reapAll)`. A test that forgets its own cleanup now fails loudly with
 * the pid instead of hanging the gate.
 */

import { spawn } from 'node:child_process';

/** Children that have been started and not yet observed to exit. */
const live = new Set();

/** Attach a child to the live set; it leaves the set the moment it exits. */
export function track(child) {
  live.add(child);
  child.once('exit', () => live.delete(child));
  child.once('error', () => live.delete(child));
  return child;
}

/** `spawn`, but remembered. Use this instead of `spawn` in packaging tests. */
export function trackedSpawn(command, args, options) {
  return track(spawn(command, args, options));
}

/**
 * Resolve `true` when the child exits within `timeoutMs`, `false` when it does not.
 *
 * The exit code is re-checked after the listener is attached, because a child that
 * died between the caller's check and this call would otherwise be waited on
 * forever — the classic "cleanup itself hangs" bug.
 */
export function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

/** Terminate one child and wait for it. Returns quietly when it is already gone. */
export async function stop(child, label = 'child') {
  if (child === undefined || child === null) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (await waitForExit(child, 5_000)) {
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.stdin?.removeAllListeners();
    return;
  }
  child.kill('SIGKILL');
  if (await waitForExit(child, 3_000)) {
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.stdin?.removeAllListeners();
    return;
  }
  throw new Error(`${label} (pid ${child.pid}) is still alive after SIGKILL; `
    + 'a leaked child would keep the test runner from ever exiting');
}

/**
 * Stop every tracked child. Intended for `after(reapAll)` at suite level, so a
 * leaked process fails the suite by pid instead of hanging the whole gate.
 */
export async function reapAll() {
  const problems = [];
  for (const child of [...live]) {
    try {
      await stop(child, 'tracked child');
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (problems.length > 0) throw new Error(`leaked child processes:\n${problems.join('\n')}`);
}

/** How many children are still tracked; used by a suite-level assertion. */
export function liveChildCount() {
  return live.size;
}
