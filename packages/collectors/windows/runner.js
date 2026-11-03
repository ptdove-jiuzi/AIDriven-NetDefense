/**
 * Subprocess runner: the only module in this package that spawns a process.
 *
 * Design constraints:
 * - Never `shell: true`. Arguments are an explicit array; the script travels on stdin so
 *   nothing the adapter builds can ever be re-parsed by cmd.exe.
 * - An allowlist of interpreter basenames (`powershell.exe`, `pwsh.exe`) keeps a
 *   configuration mistake from turning this into a generic "run any binary" primitive.
 * - Failures are values, not exceptions: timeout, truncation and non-zero exit are all
 *   reported on the result object so the caller can classify them. Only a programming
 *   error (bad executable / bad argument types) throws.
 *
 * `execFile` is injectable so tests never execute a real command. The injected function
 * may either use the node:child_process callback signature `(file, args, options, done)`
 * or return a promise; both are normalized here. The default implementation wraps
 * `spawn` because `child_process.execFile` cannot feed stdin.
 */

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { WINDOWS_ERROR_CODES, WindowsCollectorError, asWindowsCollectorError, isWindowsCollectorError } from './errors.js';

export const DEFAULT_ALLOWLIST = Object.freeze(['powershell.exe', 'pwsh.exe']);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const STDERR_CAP_BYTES = 1024 * 1024;

function assertAllowlisted(executable, allowlist) {
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'executable must be a non-empty string',
    );
  }
  const allowed = new Set(allowlist.map((name) => name.toLowerCase()));
  const resolved = basename(executable).toLowerCase();
  if (!allowed.has(resolved)) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.EXECUTABLE_NOT_ALLOWED,
      `Executable ${resolved} is not on the command allowlist`,
      { details: { executable: resolved, allowlist: [...allowed] } },
    );
  }
}

function assertArgs(args) {
  if (!Array.isArray(args)) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'args must be an array of strings');
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'every argument must be a string');
    }
  }
}

/**
 * A zero timeout is rejected on purpose: it disables the timer entirely, and a hung
 * interpreter would then never settle the promise, leaving the source's `busy` flag stuck
 * forever and silently skipping every later read.
 */
function assertTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      `${label} must be a positive safe integer`,
    );
  }
}

/**
 * spawn-based execFile replacement. Same callback shape as node:child_process.execFile,
 * plus `options.input` (written to stdin) and a richer fourth callback argument carrying
 * timeout/truncation detail that the promise API of execFile would otherwise hide.
 */
function spawnExecFile(executable, args, options, done) {
  const startedAt = Date.now();
  const chunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;
  let finished = false;
  let child;

  try {
    child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
        // The process may have exited between the timer firing and the kill.
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
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    const meta = {
      code,
      signal,
      timedOut,
      truncated,
      durationMs: Date.now() - startedAt,
    };
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
    // The cap is a byte budget, not a character count: a 1024 "character" cap on UTF-8
    // CJK stderr text would keep three times the intended memory.
    if (stderrBytes >= STDERR_CAP_BYTES) {
      return;
    }
    const remaining = STDERR_CAP_BYTES - stderrBytes;
    const piece = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    stderrBytes += piece.length;
    stderrChunks.push(piece);
  });

  child.on('close', (code, signal) => finish(null, code, signal));

  if (typeof options.input === 'string' && options.input.length > 0) {
    child.stdin.on('error', () => {
      // EPIPE means the interpreter exited before reading stdin; the close event reports
      // the real failure and must not be masked by an unhandled stream error.
    });
    child.stdin.end(options.input, 'utf8');
  } else {
    child.stdin.end();
  }
}

function classifyErrorCode({ error, timedOut, truncated, exitCode }) {
  if (isWindowsCollectorError(error)) {
    return error.code;
  }
  if (timedOut) {
    return WINDOWS_ERROR_CODES.TIMEOUT;
  }
  if (truncated) {
    return WINDOWS_ERROR_CODES.OUTPUT_TRUNCATED;
  }
  // A non-zero exit arrives through `close` (or a promise value), not through an error, so
  // it has to be part of this decision; otherwise `ok: false` and `errorCode: null` coexist.
  if ((error !== null && error !== undefined) || (exitCode !== null && exitCode !== 0)) {
    return WINDOWS_ERROR_CODES.COMMAND_FAILED;
  }
  return null;
}

function normalizeOutcome({ error, stdout, stderr, meta, durationMs, timedOutFromError }) {
  const truncated = meta?.truncated === true
    || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    || (typeof error?.message === 'string' && /maxBuffer/i.test(error.message));
  const timedOut = meta?.timedOut === true || (timedOutFromError && error !== null && error !== undefined);
  const code = meta?.code ?? (typeof error?.code === 'number' ? error.code : null);
  const signal = meta?.signal ?? (typeof error?.signal === 'string' ? error.signal : null);
  const exitCode = Number.isSafeInteger(code) ? code : null;
  let stderrText = typeof stderr === 'string' ? stderr : '';
  if (stderrText.length === 0 && error instanceof Error && !truncated && !timedOut) {
    stderrText = error.message;
  }
  const stdoutText = typeof stdout === 'string' ? stdout : '';

  // A non-zero exit code is a failed command even though `spawn` reports it through the
  // `close` event instead of an error object. Judging success by `error === null` alone
  // (as this module originally did) silently accepted every failing PowerShell script.
  // `code === null` covers both the injected promise-style runner, which reports no exit
  // code at all, and signal termination (which sets `signal` and fails via `timedOut`).
  const exitedCleanly = exitCode === null || exitCode === 0;
  const ok = (error === null || error === undefined) && !timedOut && !truncated && exitedCleanly;

  if (!ok && stderrText.length === 0 && !(error instanceof Error)) {
    stderrText = timedOut
      ? 'command exceeded its timeout and was terminated'
      : `command exited with code ${String(exitCode)}${signal === null ? '' : ` (signal ${signal})`}`;
  }

  return {
    ok,
    code: exitCode,
    signal,
    stdout: stdoutText,
    stderr: stderrText,
    durationMs,
    timedOut,
    truncated,
    // Classified here so callers do not have to re-derive "why did this fail" from the
    // stderr text; the outer catch in `run()` uses the same taxonomy.
    errorCode: ok ? null : classifyErrorCode({ error, timedOut, truncated, exitCode }),
  };
}

export function createCommandRunner({
  execFile = spawnExecFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
  allowlist = DEFAULT_ALLOWLIST,
} = {}) {
  if (typeof execFile !== 'function') {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'execFile must be a function');
  }
  assertTimeout(timeoutMs, 'timeoutMs');
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'maxBuffer must be a positive integer');
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'allowlist must be a non-empty array');
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
        // node's execFile marks a timeout only through `killed` plus a signal, so it has
        // to be inferred; our own implementation reports it explicitly in `meta`.
        const timedOutFromError = options.timeout > 0
          && error !== null
          && error !== undefined
          && error.killed === true;
        settle(normalizeOutcome({
          error,
          stdout,
          stderr,
          meta,
          durationMs,
          timedOutFromError,
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
            if (value === null || typeof value !== 'object') {
              // A runner that resolves with a non-object told us nothing. Treating that as an
              // empty success is how a broken injected runner turns into "the log was cleared"
              // downstream, so it is reported as a failed command instead.
              done(new Error('execFile resolved without a result object'));
              return;
            }
            // Normalize a promise-shaped result into the same meta the callback path uses.
            // The earlier version only looked for `stdout` and silently reported
            // `{ code: 1, stderr: 'Access is denied' }` as a successful empty read, which
            // downstream turned into a bogus "log cleared" and a generation bump.
            done(null, typeof value.stdout === 'string' ? value.stdout : '', typeof value.stderr === 'string' ? value.stderr : '', {
              code: Number.isSafeInteger(value.code) ? value.code : null,
              signal: typeof value.signal === 'string' ? value.signal : null,
              timedOut: value.timedOut === true,
              truncated: value.truncated === true,
              durationMs: Number.isSafeInteger(value.durationMs) ? value.durationMs : null,
            });
          },
          (error) => done(error),
        );
      }
    });
  }

  return Object.freeze({
    /**
     * Run one allowlisted command. Resolves for every outcome except a rejected
     * executable/argument, which is a caller bug and throws.
     */
    async run({ executable, args = [], stdin = null, timeoutMs: callTimeoutMs = undefined } = {}) {
      assertAllowlisted(executable, allowlist);
      assertArgs(args);
      if (stdin !== null && typeof stdin !== 'string') {
        throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'stdin must be null or a string');
      }
      const effectiveTimeout = callTimeoutMs === undefined ? timeoutMs : callTimeoutMs;
      assertTimeout(effectiveTimeout, 'timeoutMs');

      try {
        return await invoke(executable, args, {
          timeout: effectiveTimeout,
          maxBuffer,
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
          input: stdin,
        });
      } catch (error) {
        // A rejected promise from an injected execFile is still a command outcome.
        const normalized = asWindowsCollectorError(error);
        return {
          ok: false,
          code: null,
          signal: null,
          stdout: '',
          stderr: normalized.message,
          durationMs: 0,
          timedOut: false,
          truncated: false,
          errorCode: normalized.code,
        };
      }
    },
  });
}

export { spawnExecFile as defaultExecFile };
