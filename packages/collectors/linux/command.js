/**
 * Allowlisted command execution: the only place in this package that spawns a process.
 *
 * Constraints, in order of importance:
 *
 * 1. **Never a shell.** Arguments travel as an argv array, so nothing a source builds can
 *    be re-parsed by `/bin/sh`. `shell: true` does not appear anywhere in this file.
 * 2. **Basename allowlist.** Only `journalctl` is permitted by default. A configuration
 *    mistake therefore cannot turn this into a generic "run any binary as the daemon user"
 *    primitive.
 * 3. **Failures are values.** Timeout, truncation and non-zero exit all come back on the
 *    result object; only a programming error (unknown executable, non-string argument)
 *    throws. A source must be able to degrade, not crash, when `journalctl` is missing.
 *
 * `execFile` is injectable so tests never execute a real command: `createScriptedCommandRunner`
 * below is the fixture double used by every journald test.
 */

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertNonEmptyString,
  assertPositiveInteger,
} from './errors.js';

/**
 * Absolute paths, not basenames: `/tmp/evil/journalctl` has the right basename and must not
 * be runnable. A bare `journalctl` (resolved by PATH) is accepted only as the documented
 * convenience form, and every other path has to match this list exactly.
 */
export const DEFAULT_ALLOWLIST = Object.freeze([
  '/usr/bin/journalctl',
  '/bin/journalctl',
  '/usr/sbin/journalctl',
  '/usr/local/bin/journalctl',
  'journalctl',
]);

function normalizeExecutable(executable) {
  return typeof executable === 'string' ? executable.replace(/\/+/g, '/') : '';
}
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const STDERR_CAP_BYTES = 1024 * 1024;

function assertAllowlisted(executable, allowlist) {
  assertNonEmptyString('executable', executable);
  const normalized = normalizeExecutable(executable);
  const allowed = new Set(allowlist.map((entry) => normalizeExecutable(entry)));
  if (allowed.has(normalized)) {
    return normalized;
  }
  // A bare name is resolved by PATH; anything containing a slash must match in full, so a
  // planted `/tmp/x/journalctl` cannot masquerade as the real binary.
  if (!normalized.includes('/') && allowed.has(basename(normalized))) {
    return basename(normalized);
  }
  throw new LinuxCollectorError(
    LINUX_ERROR_CODES.EXECUTABLE_NOT_ALLOWED,
    `Executable ${normalized} is not on the command allowlist`,
    { executable: normalized, allowlist: [...allowed] },
  );
}

function assertArgs(args) {
  if (!Array.isArray(args)) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'args must be an array of strings');
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'every argument must be a string');
    }
    if (arg.includes('\0')) {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.ARGUMENT_NOT_ALLOWED,
        'an argument must not contain a NUL byte',
      );
    }
  }
  return args;
}

function spawnExecFile(executable, args, options, done) {
  const startedAt = Date.now();
  const chunks = [];
  let stdoutBytes = 0;
  let stderrText = '';
  let truncated = false;
  let timedOut = false;
  let finished = false;
  let child;

  try {
    child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    done(error);
    return;
  }

  const timer = options.timeout > 0
    ? setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The child may have exited between the timer firing and the kill.
      }
    }, options.timeout)
    : null;

  function finish(error, code = null, signal = null) {
    if (finished) {
      return;
    }
    finished = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (error !== null) {
      done(error);
      return;
    }
    const meta = { code, signal, timedOut, truncated, durationMs: Date.now() - startedAt };
    if (truncated) {
      const overflow = new Error(`stdout exceeded maxBuffer of ${options.maxBuffer} bytes`);
      overflow.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      done(overflow, Buffer.concat(chunks).toString('utf8'), stderrText, meta);
      return;
    }
    done(null, Buffer.concat(chunks).toString('utf8'), stderrText, meta);
  }

  child.on('error', (error) => {
    if (finished) {
      return;
    }
    finished = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    done(error);
  });

  child.stdout.on('data', (chunk) => {
    if (truncated) {
      return;
    }
    const nextSize = stdoutBytes + chunk.length;
    if (nextSize > options.maxBuffer) {
      const keep = options.maxBuffer - stdoutBytes;
      if (keep > 0) {
        chunks.push(chunk.subarray(0, keep));
      }
      stdoutBytes = options.maxBuffer;
      truncated = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Best effort; the close event still fires.
      }
      return;
    }
    stdoutBytes = nextSize;
    chunks.push(chunk);
  });

  child.stderr.on('data', (chunk) => {
    if (stderrText.length >= STDERR_CAP_BYTES) {
      return;
    }
    stderrText += chunk.toString('utf8');
    if (stderrText.length > STDERR_CAP_BYTES) {
      stderrText = stderrText.slice(0, STDERR_CAP_BYTES);
    }
  });

  child.on('close', (code, signal) => finish(null, code, signal));
}

function normalizeOutcome({ error, stdout, stderr, meta, durationMs, timedOutFromError }) {
  const truncated = meta?.truncated === true
    || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    || (typeof error?.message === 'string' && /maxBuffer/i.test(error.message));
  const timedOut = meta?.timedOut === true
    || (timedOutFromError && error !== null && error !== undefined);
  const code = meta?.code ?? (typeof error?.code === 'number' ? error.code : null);
  const signal = meta?.signal ?? (typeof error?.signal === 'string' ? error.signal : null);
  let stderrText = typeof stderr === 'string' ? stderr : '';
  if (stderrText.length === 0 && error instanceof Error && !truncated && !timedOut) {
    stderrText = error.message;
  }
  return Object.freeze({
    ok: (error === null || error === undefined) && !timedOut && !truncated,
    code: Number.isSafeInteger(code) ? code : null,
    signal,
    stdout: typeof stdout === 'string' ? stdout : '',
    stderr: stderrText,
    durationMs,
    timedOut,
    truncated,
  });
}

export function createCommandRunner({
  execFile = spawnExecFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
  allowlist = DEFAULT_ALLOWLIST,
} = {}) {
  if (typeof execFile !== 'function') {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'execFile must be a function');
  }
  assertPositiveInteger('timeoutMs', timeoutMs);
  assertPositiveInteger('maxBuffer', maxBuffer);
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'allowlist must be a non-empty array');
  }

  function invoke(executable, args, options) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      const settle = (outcome) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(outcome);
      };

      const done = (error = null, stdout = '', stderr = '', meta = null) => {
        const durationMs = meta?.durationMs ?? (Date.now() - startedAt);
        settle(normalizeOutcome({
          error,
          stdout,
          stderr,
          meta,
          durationMs,
          timedOutFromError: options.timeout > 0 && error != null && error.killed === true,
        }));
      };

      let returned;
      try {
        returned = execFile(executable, args, options, done);
      } catch (error) {
        done(error);
        return;
      }

      if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
        returned.then(
          (value) => {
            if (value !== null && typeof value === 'object' && 'stdout' in value) {
              done(null, value.stdout, value.stderr, value);
            } else {
              done(null, '', '', null);
            }
          },
          (error) => done(error),
        );
      }
    });
  }

  return Object.freeze({
    allowlist: Object.freeze([...allowlist]),
    timeoutMs,
    maxBuffer,

    /** Run one allowlisted command. Resolves for every runtime outcome. */
    async run({ executable, args = [], timeoutMs: callTimeoutMs = undefined } = {}) {
      assertAllowlisted(executable, allowlist);
      assertArgs(args);
      const effectiveTimeout = callTimeoutMs === undefined ? timeoutMs : callTimeoutMs;
      assertPositiveInteger('timeoutMs', effectiveTimeout);

      return invoke(executable, args, { timeout: effectiveTimeout, maxBuffer, encoding: 'utf8' });
    },
  });
}

/**
 * Fixture double: replays canned outcomes and records every invocation.
 *
 * Deliberately fails loudly when a call is not covered by the script, so a test can never
 * silently fall through to a real `journalctl`.
 */
export function createScriptedCommandRunner(script = []) {
  if (!Array.isArray(script)) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'script must be an array of steps');
  }
  const steps = script.map((step, index) => {
    if (step === null || typeof step !== 'object') {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.INVALID_ARGUMENT,
        `script step ${index} must be an object`,
      );
    }
    return {
      match: Array.isArray(step.match) ? step.match.map(String) : null,
      exitCode: step.exitCode === undefined ? 0 : step.exitCode,
      stdout: typeof step.stdout === 'string' ? step.stdout : '',
      stderr: typeof step.stderr === 'string' ? step.stderr : '',
      truncated: step.truncated === true,
      timedOut: step.timedOut === true,
      used: false,
    };
  });

  const calls = [];

  function matches(step, executable, args) {
    if (step.match === null) {
      return true;
    }
    const haystack = [basename(executable), ...args].join(' ');
    return step.match.every((needle) => haystack.includes(needle));
  }

  return Object.freeze({
    calls: () => calls.map((call) => ({ ...call })),

    async run({ executable, args = [] } = {}) {
      assertArgs(args);
      const base = basename(executable);
      calls.push({ executable: base, args: [...args] });
      const step = steps.find((candidate) => !candidate.used && matches(candidate, executable, args));
      if (step === undefined) {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_CONFIG,
          `scripted runner has no outcome for: ${base} ${args.join(' ')}`,
          { executable: base, args: [...args] },
        );
      }
      step.used = true;
      return Object.freeze({
        ok: step.exitCode === 0 && !step.timedOut && !step.truncated,
        code: step.exitCode,
        signal: null,
        stdout: step.stdout,
        stderr: step.stderr,
        durationMs: 1,
        timedOut: step.timedOut,
        truncated: step.truncated,
      });
    },
  });
}

export { spawnExecFile as defaultExecFile };
