/**
 * PowerShell client: wraps a script, parses JSON, classifies failures.
 *
 * The interpreter is invoked as
 *   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64>
 *
 * `-EncodedCommand` takes the whole script base64-encoded (UTF-16LE) as one argument, so
 * there is no quoting layer, no cmd.exe in between and **no stdin**.
 *
 * Why not stdin (COLLECTOR-LIVE §4 CL-5): Windows PowerShell 5.1 truncates a script that
 * is fed through `-Command -` as soon as the script contains a **multi-line brace block**
 * — everything after the block is silently dropped, with exit code 0 and empty stderr.
 * Three sources (event log ×3, run keys, scheduled tasks) therefore returned zero rows
 * while reporting `ok`. `-EncodedCommand` is fixed-length and opaque: the interpreter
 * decodes the entire script before it runs anything, so a block cannot cut it short.
 *
 * `-NoProfile` matters for correctness, not only for speed: a profile that writes to stdout
 * would corrupt every `ConvertTo-Json` parse.
 *
 * The preamble forces terminating errors, UTF-8 output and no progress stream. Progress
 * rendering writes to the host and would otherwise interleave with the JSON body.
 *
 * ## Persistent session transport (PERF-CPU)
 *
 * A cold `powershell.exe` costs ~812 ms of CPU before it runs a single line of the script;
 * polling six sources every 30–60 s paid that floor nineteen times a minute. The session
 * transport starts **one** interpreter per collector process (`-EncodedCommand`, so the
 * bootstrap itself is still immune to CL-5) and then feeds it one request per line:
 *
 * - host → child: one line, base64(UTF-8 JSON `{id, script}`) — the script therefore never
 *   touches a command line, and there is no length budget at all (the 24 000-character
 *   `-EncodedCommand` cap only applies to the one-shot fallback);
 * - child → host: `@@AIDN_BEGIN <id>`, one line base64(UTF-8 result text), then
 *   `@@AIDN_END <id> ok` or `@@AIDN_END <id> err <base64 error text>`.
 *
 * Why this shape and not `-Command -`: CL-5 (above) is a *stdin* truncation bug, and the
 * bootstrap is not the multi-line script that trips it — the scripts are executed with
 * `[ScriptBlock]::Create()`, which decodes the whole text before running anything. The
 * result travels base64-encoded so a `ConvertTo-Json` body can never be mistaken for a
 * sentinel line, and any stray host output (`Write-Host`) is ignored by the parser.
 *
 * Contracts the transport owes its caller:
 * - **Serialized**: requests are queued, never interleaved on the single stdout channel.
 * - **Self-healing**: a timeout, a protocol desync or an interpreter exit kills the child;
 *   the next request starts a fresh one.
 * - **Bounded**: an oversized response kills the session instead of growing without limit.
 * - **No orphans**: `process.on('exit')` kills every live child, and because the child's
 *   stdin is a pipe, a parent that dies without running that hook (SIGKILL, console close)
 *   delivers EOF to `[Console]::In.ReadLine()`, so the interpreter exits by itself.
 * - **Falls back**: any transport-level failure (spawn error, desync, dead interpreter) is
 *   retried once on the original one-shot path, which stays fully functional.
 */

import { spawnSessionChild } from './runner.js';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from './errors.js';

export const POWERSHELL_FLAGS = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
]);

/**
 * Windows caps a command line at 32 767 characters. The base64 of a UTF-16LE script is
 * ~2.7× the script text; keeping the encoded argument under this bound leaves room for the
 * executable path and the flags, and fails loudly instead of being truncated by the OS.
 */
export const MAX_ENCODED_COMMAND_CHARS = 24_000;

export const SCRIPT_PREAMBLE = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue';";

const STDERR_EXCERPT_LIMIT = 512;

const ACCESS_DENIED_PATTERNS = [
  /access is denied/i,
  /拒绝访问/u,
  /unauthorizedaccessexception/i,
  /requires elevation/i,
  /requires administrator/i,
  /cannot open .* log/i,
  /do not have permission/i,
];

const CHANNEL_NOT_FOUND_PATTERNS = [
  /the specified channel could not be found/i,
  /channel .* could not be found/i,
  /no such channel/i,
];

const NO_EVENTS_PATTERNS = [
  /no events were found/i,
  /nomatchingeventsfound/i,
  /no events that match/i,
  /no events match the/i,
  // zh-CN Windows: "找不到与指定的选择条件匹配的事件。" / "找不到任何与指定的选择条件匹配的事件。"
  // The same condition, in another language. The script fixes this at the source (see
  // `event-log.js`); this entry keeps the *fallback* classification correct on a zh-CN host
  // instead of turning an idle channel into a COMMAND_FAILED.
  /找不到任何与指定的选择条件匹配的事件/u,
  /找不到与指定的选择条件匹配的事件/u,
];

/** Escape a value for a single-quoted PowerShell literal. */
export function escapePsLiteral(value) {
  return String(value).replace(/'/g, "''");
}

/** Quote a value as a PowerShell single-quoted literal. */
export function psQuote(value) {
  return `'${escapePsLiteral(value)}'`;
}

/**
 * Build the full script text handed to the interpreter: preamble, marker, body.
 * The body keeps its own `# aegis-source:<name>` marker as the first line so tests can
 * route a fixture by inspecting the script instead of by call order.
 */
export function wrapScript(body) {
  return `${SCRIPT_PREAMBLE}\n${String(body)}\n`;
}

/**
 * Encode the wrapped script the way `-EncodedCommand` expects: base64 of UTF-16LE.
 *
 * @param {string} script Script body (no preamble).
 * @returns {string} Base64 argument.
 * @throws {WindowsCollectorError} `INVALID_ARGUMENT` when the script is empty or too long
 *   to fit a Windows command line.
 */
export function encodeCommand(script) {
  if (typeof script !== 'string' || script.trim().length === 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'script must be a non-empty string');
  }
  const encoded = Buffer.from(wrapScript(script), 'utf16le').toString('base64');
  if (encoded.length > MAX_ENCODED_COMMAND_CHARS) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      `the script encodes to ${encoded.length} characters, over the ${MAX_ENCODED_COMMAND_CHARS} command-line budget`,
      { details: { encodedChars: encoded.length, limit: MAX_ENCODED_COMMAND_CHARS } },
    );
  }
  return encoded;
}

export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * `ConvertTo-Json` emits a bare object instead of a one-element array when the pipeline
 * produced exactly one item, so every table reader has to accept both shapes.
 */
export function toArray(value) {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function toInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function toText(value) {
  if (typeof value === 'string') {
    return value.length === 0 ? null : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/**
 * Normalize a PowerShell date. Windows PowerShell 5.1 serializes DateTime as
 * `/Date(1700000000000)/`; PowerShell 7 emits an ISO 8601 string. Both are accepted, and
 * an unparseable value yields null rather than `Invalid Date`.
 */
export function parseWindowsDate(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value.trim());
    if (match !== null) {
      const epochMs = Number(match[1]);
      return Number.isSafeInteger(epochMs) ? epochMs : null;
    }
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (value instanceof Date) {
    const epochMs = value.getTime();
    return Number.isSafeInteger(epochMs) ? epochMs : null;
  }
  return null;
}

function excerpt(text) {
  const normalized = String(text ?? '').replace(/\u0000/g, '').trim();
  return normalized.length > STDERR_EXCERPT_LIMIT
    ? `${normalized.slice(0, STDERR_EXCERPT_LIMIT)}…`
    : normalized;
}

/* ------------------------------------------------------------------------------------ *
 * Persistent session transport
 * ------------------------------------------------------------------------------------ */

/** Protocol sentinels. One line each; a payload is one base64 line between them. */
export const SESSION_SENTINELS = Object.freeze({
  READY: '@@AIDN_READY',
  BEGIN: '@@AIDN_BEGIN',
  END: '@@AIDN_END',
});

export const SESSION_START_TIMEOUT_MS = 20_000;
export const SESSION_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SESSION_STDERR_CAP_BYTES = 64 * 1024;
const SESSION_PROTOCOL_BUDGET_MS = 5_000;
/** A protocol payload line: base64, no padding beyond the end. Empty means empty output. */
const BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * The interpreter bootstrap. Kept to **one line** on purpose: the CL-5 trap is a multi-line
 * brace block reaching a *stdin* script, and while this text travels through
 * `-EncodedCommand` (immune to it), a single-line bootstrap means there is nothing to
 * truncate even if the transport is later changed.
 *
 * Every request is decoded from base64 and executed with `[ScriptBlock]::Create()`, so the
 * script keeps its own line breaks and blocks; the result is captured, converted to text
 * and echoed back base64-encoded between the sentinels. `[Console]::Out` is used instead of
 * `Write-Output` so the host's formatting layer can never rewrite a protocol line, and the
 * stream is flushed after every request.
 *
 * When stdin reaches EOF (parent killed, stdout pipe closed) the loop breaks and the
 * interpreter exits: that is what keeps the collector from leaving orphan processes.
 */
export const SESSION_BOOTSTRAP_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
  "$ProgressPreference='SilentlyContinue';",
  `[Console]::Out.WriteLine('${SESSION_SENTINELS.READY}');`,
  '[Console]::Out.Flush();',
  'while ($true) {',
  '$line=[Console]::In.ReadLine();',
  'if ($null -eq $line) { break };',
  'if ($line.Length -eq 0) { continue };',
  "$id='';$out=@();$ok=$true;$errText='';",
  'try {',
  '$request=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line))|ConvertFrom-Json;',
  '$id=[string]$request.id;',
  '$block=[ScriptBlock]::Create([string]$request.script);',
  '$out=@(& $block)',
  '} catch {',
  '$ok=$false;',
  "$errText='Exception: '+[string]$_.FullyQualifiedErrorId+' :: '+$_.Exception.Message+[Environment]::NewLine+($_|Out-String -Width 4096)",
  '};',
  '$text=@($out|ForEach-Object{ if ($_ -is [string]) { $_ } else { ($_|Out-String -Width 4096) } })-join "`n";',
  "$status='ok';",
  "if (-not $ok) { $status='err' };",
  `[Console]::Out.WriteLine('${SESSION_SENTINELS.BEGIN} '+$id);`,
  '[Console]::Out.WriteLine([System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text)));',
  "$errB64='';",
  "if (-not $ok) { $errB64=' '+[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($errText)) };",
  `[Console]::Out.WriteLine('${SESSION_SENTINELS.END} '+$id+' '+$status+$errB64);`,
  '[Console]::Out.Flush()',
  '}',
].join('');

/**
 * Children that are alive right now, so a normal process exit can kill them synchronously.
 * Hard exits (SIGKILL, console close) are covered by stdin EOF in the bootstrap instead.
 */
const liveSessionChildren = new Set();
let sessionExitHookInstalled = false;

function trackSessionChild(child) {
  liveSessionChildren.add(child);
  if (sessionExitHookInstalled) {
    return;
  }
  sessionExitHookInstalled = true;
  process.on('exit', () => {
    for (const live of liveSessionChildren) {
      try {
        live.kill('SIGKILL');
      } catch {
        // The child is already gone; nothing to clean up.
      }
    }
    liveSessionChildren.clear();
  });
}

/**
 * A transport-level failure (as opposed to a script failure). The client retries the same
 * script once on the one-shot path, so a wedged session can never turn into a data gap.
 */
function sessionTransportError(message, details = null) {
  const error = new WindowsCollectorError(WINDOWS_ERROR_CODES.COMMAND_FAILED, message, { details });
  error.transportFailure = true;
  return error;
}

export function isSessionTransportFailure(error) {
  return error !== null && typeof error === 'object' && error.transportFailure === true;
}

/**
 * Build the long-lived interpreter transport.
 *
 * @param {object} [options]
 * @param {string} [options.executable] Allowlisted interpreter basename.
 * @param {Function} [options.spawnChild] Injectable spawner (tests only).
 * @param {number} [options.startTimeoutMs] Budget for the interpreter to print READY.
 * @param {number} [options.maxResponseBytes] Response cap; exceeding it kills the session.
 * @returns {{run: Function, dispose: Function, stats: Function}} Transport handle.
 */
export function createSessionTransport({
  executable = 'powershell.exe',
  spawnChild = spawnSessionChild,
  startTimeoutMs = SESSION_START_TIMEOUT_MS,
  maxResponseBytes = SESSION_MAX_RESPONSE_BYTES,
} = {}) {
  const stats = {
    spawns: 0,
    requests: 0,
    desyncs: 0,
    timeouts: 0,
    exits: 0,
  };
  const internal = { generation: 0 };
  let child = null;
  let buffer = null;
  let childStderr = '';
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let pending = null;
  let disposed = false;
  let tail = Promise.resolve();
  let startFailures = 0;

  function clearPending() {
    const current = pending;
    pending = null;
    if (current !== null) {
      clearTimeout(current.timer);
    }
    return current;
  }

  function failPending(error) {
    const current = clearPending();
    if (current !== null) {
      current.reject(error);
    }
  }

  function dropChild() {
    const current = child;
    child = null;
    buffer = null;
    readyPromise = null;
    const rejectReady = readyReject;
    readyResolve = null;
    readyReject = null;
    if (rejectReady !== null) {
      // A queued request may be waiting for READY; dropping the child without settling it
      // would leave that request pending forever instead of falling back to one-shot.
      rejectReady(sessionTransportError('the interpreter session was dropped'));
    }
    if (current !== null) {
      liveSessionChildren.delete(current);
      try {
        current.kill('SIGKILL');
      } catch {
        // Already exited.
      }
    }
  }

  function failReady(error) {
    const reject = readyReject;
    readyPromise = null;
    readyResolve = null;
    readyReject = null;
    if (reject !== null) {
      reject(error);
    }
  }

  function handleEndLine(line) {
    const current = pending;
    const rest = line.slice(SESSION_SENTINELS.END.length + 1);
    const parts = rest.split(' ');
    const id = parts[0] ?? '';
    const status = parts[1] ?? '';
    if (id !== current.id) {
      stats.desyncs += 1;
      failPending(sessionTransportError('the interpreter answered a different request id', {
        expected: current.id,
        received: id,
      }));
      dropChild();
      return;
    }
    const payload = current.hasPayload ? current.payload : '';
    pending = null;
    clearTimeout(current.timer);
    let stdout = '';
    if (payload.length > 0) {
      stdout = Buffer.from(payload, 'base64').toString('utf8');
    }
    let stderr = '';
    if (status === 'err' && typeof parts[2] === 'string' && parts[2].length > 0) {
      stderr = Buffer.from(parts[2], 'base64').toString('utf8');
    }
    current.resolve({
      ok: status === 'ok',
      code: status === 'ok' ? 0 : 1,
      signal: null,
      stdout,
      stderr,
      durationMs: Date.now() - current.startedAt,
      timedOut: false,
      truncated: false,
    });
  }

  function handleLine(line) {
    if (line.length === 0) {
      return;
    }
    if (line === SESSION_SENTINELS.READY) {
      const resolve = readyResolve;
      readyResolve = null;
      readyReject = null;
      if (resolve !== null) {
        resolve(true);
      }
      return;
    }
    if (pending === null) {
      // Stray host output between requests (a script that uses Write-Host) is ignored.
      return;
    }
    if (line.startsWith(`${SESSION_SENTINELS.END} `)) {
      handleEndLine(line);
      return;
    }
    if (pending.phase === 'waiting') {
      if (line === `${SESSION_SENTINELS.BEGIN} ${pending.id}`) {
        pending.phase = 'body';
      }
      return;
    }
    if (!pending.hasPayload) {
      // The payload is one base64 line. A line that is not base64 is host output that leaked
      // into the same stream (`Write-Host`, a warning), not a truncated payload: accepting it
      // would corrupt the body, and failing the read over it would blame the script for the
      // host's stray write.
      if (!BASE64_LINE.test(line)) {
        return;
      }
      pending.payload = line;
      pending.hasPayload = true;
    }
  }

  function onData(chunk) {
    if (buffer === null) {
      return;
    }
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    if (buffer.length > maxResponseBytes) {
      failPending(new WindowsCollectorError(
        WINDOWS_ERROR_CODES.OUTPUT_TRUNCATED,
        `the interpreter produced more than ${maxResponseBytes} bytes for one request`,
        { details: { limit: maxResponseBytes } },
      ));
      dropChild();
      return;
    }
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/u, '');
      buffer = buffer.subarray(newline + 1);
      handleLine(line);
      if (buffer === null) {
        return;
      }
      newline = buffer.indexOf(0x0a);
    }
  }

  function onChildExit(exitCode) {
    stats.exits += 1;
    const wasReadyPending = readyReject !== null;
    child = null;
    buffer = null;
    readyPromise = null;
    if (wasReadyPending) {
      failReady(sessionTransportError('the interpreter exited before it was ready', { exitCode }));
    }
    if (pending !== null) {
      failPending(sessionTransportError('the interpreter exited while a request was in flight', {
        exitCode,
        stderr: excerpt(childStderr),
      }));
    }
  }

  function ensureReady(callTimeoutMs) {
    if (child !== null && readyPromise !== null) {
      return readyPromise;
    }
    if (disposed) {
      return Promise.reject(sessionTransportError('the session transport was disposed'));
    }
    const budget = Math.min(startTimeoutMs, Math.max(callTimeoutMs, SESSION_PROTOCOL_BUDGET_MS));
    let spawned;
    try {
      const args = [...POWERSHELL_FLAGS, encodeCommand(SESSION_BOOTSTRAP_SCRIPT)];
      spawned = spawnChild({ executable, args });
    } catch (error) {
      startFailures += 1;
      return Promise.reject(sessionTransportError('the interpreter could not be started', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
    stats.spawns += 1;
    internal.generation += 1;
    const generation = internal.generation;
    child = spawned;
    buffer = Buffer.alloc(0);
    childStderr = '';
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    trackSessionChild(spawned);

    const startupTimer = setTimeout(() => {
      if (internal.generation !== generation || readyReject === null) {
        return;
      }
      failReady(sessionTransportError('the interpreter did not report ready within the start budget', { budgetMs: budget }));
      dropChild();
    }, budget);

    // The long-lived child must never be the reason the collector process cannot exit: the
    // request timers keep the loop alive while work is in flight, and `process.on('exit')`
    // (normal exit) or stdin EOF (hard kill) closes the child. Without this an abandoned
    // session would hold `node --test` (or a shutting-down daemon) open forever.
    if (typeof spawned.unref === 'function') {
      spawned.unref();
    }
    for (const stream of [spawned.stdin, spawned.stdout, spawned.stderr]) {
      if (stream && typeof stream.unref === 'function') {
        stream.unref();
      }
    }

    const settleReady = () => clearTimeout(startupTimer);
    readyPromise.then(settleReady, settleReady);

    spawned.on('error', (error) => {
      if (internal.generation !== generation) {
        return;
      }
      startFailures += 1;
      failReady(sessionTransportError('the interpreter failed to start', {
        cause: error instanceof Error ? error.message : String(error),
      }));
      dropChild();
    });
    spawned.stdin?.on('error', (error) => {
      if (internal.generation !== generation) {
        return;
      }
      failPending(sessionTransportError('the interpreter stdin closed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
      dropChild();
    });
    spawned.stdout?.on('data', (chunk) => {
      if (internal.generation !== generation) {
        return;
      }
      onData(chunk);
    });
    spawned.stderr?.on('data', (chunk) => {
      if (internal.generation !== generation) {
        return;
      }
      if (childStderr.length < SESSION_STDERR_CAP_BYTES) {
        childStderr += chunk.toString('utf8');
      }
    });
    spawned.on('close', (exitCode) => {
      if (internal.generation !== generation) {
        return;
      }
      onChildExit(exitCode);
    });
    return readyPromise;
  }

  function writeRequest(script, callTimeoutMs) {
    stats.requests += 1;
    const id = `s${stats.requests}`;
    const line = Buffer.from(JSON.stringify({ id, script }), 'utf8').toString('base64');
    const target = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending === null || pending.id !== id) {
          return;
        }
        stats.timeouts += 1;
        failPending(new WindowsCollectorError(
          WINDOWS_ERROR_CODES.TIMEOUT,
          'The PowerShell request exceeded its timeout',
          { details: { timeoutMs: callTimeoutMs, transport: 'session' } },
        ));
        dropChild();
      }, callTimeoutMs);
      pending = {
        id,
        phase: 'waiting',
        payload: '',
        hasPayload: false,
        resolve,
        reject,
        timer,
        startedAt: Date.now(),
      };
      if (target === null || target.stdin === null || typeof target.stdin.write !== 'function') {
        failPending(sessionTransportError('the interpreter has no stdin to write to'));
        dropChild();
        return;
      }
      target.stdin.write(`${line}\n`, (error) => {
        if (error === null || error === undefined || pending === null || pending.id !== id) {
          return;
        }
        failPending(sessionTransportError('the request could not be written to the interpreter', {
          cause: error instanceof Error ? error.message : String(error),
        }));
        dropChild();
      });
    });
  }

  async function dispatch(script, callTimeoutMs) {
    if (typeof script !== 'string' || script.trim().length === 0) {
      throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'script must be a non-empty string');
    }
    await ensureReady(callTimeoutMs);
    if (disposed) {
      throw sessionTransportError('the session transport was disposed');
    }
    return writeRequest(script, callTimeoutMs);
  }

  return Object.freeze({
    /**
     * Run one script on the shared interpreter. Requests are serialized: the stdout channel
     * carries exactly one request at a time, so concurrent sources cannot interleave.
     */
    run(script, callTimeoutMs = 15_000) {
      const task = tail.then(
        () => dispatch(script, callTimeoutMs),
        () => dispatch(script, callTimeoutMs),
      );
      tail = task.then(() => undefined, () => undefined);
      return task;
    },

    /** Kill the interpreter and fail anything in flight; later calls restart it. */
    dispose() {
      disposed = true;
      internal.generation += 1;
      failPending(sessionTransportError('the session transport was disposed'));
      dropChild();
    },

    stats() {
      return Object.freeze({
        spawns: stats.spawns,
        requests: stats.requests,
        desyncs: stats.desyncs,
        timeouts: stats.timeouts,
        exits: stats.exits,
        startFailures,
        alive: child !== null,
        pid: child === null ? null : child.pid ?? null,
        disposed,
      });
    },
  });
}


function matchesAny(patterns, haystack) {
  return patterns.some((pattern) => pattern.test(haystack));
}

/**
 * Map a failed runner result onto the adapter error codes. Order is deliberate:
 * a permission error often also mentions the channel, and reporting it as
 * CHANNEL_NOT_FOUND would hide an actionable ACL problem behind a configuration typo.
 */
export function classifyFailure(result) {
  if (result.timedOut === true) {
    return new WindowsCollectorError(
      WINDOWS_ERROR_CODES.TIMEOUT,
      'The PowerShell command exceeded its timeout',
      { details: { durationMs: result.durationMs } },
    );
  }
  if (result.truncated === true) {
    return new WindowsCollectorError(
      WINDOWS_ERROR_CODES.OUTPUT_TRUNCATED,
      'The PowerShell command produced more output than maxBuffer allows',
      { details: { durationMs: result.durationMs } },
    );
  }

  const stderr = String(result.stderr ?? '');
  const stdout = String(result.stdout ?? '');
  const haystack = `${stderr}\n${stdout}`;

  if (matchesAny(ACCESS_DENIED_PATTERNS, haystack)) {
    return new WindowsCollectorError(
      WINDOWS_ERROR_CODES.ACCESS_DENIED,
      'The collector account is not allowed to read the requested Windows data',
      { details: { stderr: excerpt(stderr), exitCode: result.code ?? null } },
    );
  }
  if (matchesAny(CHANNEL_NOT_FOUND_PATTERNS, haystack)) {
    return new WindowsCollectorError(
      WINDOWS_ERROR_CODES.CHANNEL_NOT_FOUND,
      'The requested event channel does not exist on this host',
      { details: { stderr: excerpt(stderr), exitCode: result.code ?? null } },
    );
  }
  if (matchesAny(NO_EVENTS_PATTERNS, haystack)) {
    return new WindowsCollectorError(
      WINDOWS_ERROR_CODES.NO_EVENTS,
      'The query matched no records',
      { details: { stderr: excerpt(stderr), exitCode: result.code ?? null } },
    );
  }

  return new WindowsCollectorError(
    WINDOWS_ERROR_CODES.COMMAND_FAILED,
    'The PowerShell command failed',
    { details: { stderr: excerpt(stderr), exitCode: result.code ?? null, signal: result.signal ?? null } },
  );
}

function parseJsonOutput(stdout, context) {
  const text = stripBom(stdout).trim();
  if (text.length === 0) {
    // CL-5: an exit-0 interpreter that prints nothing is a *defect*, not an empty read.
    // Returning `null` here is what let three sources report `ok` with zero events for
    // ten minutes; the failure mode is indistinguishable from "the script never ran".
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.EMPTY_OUTPUT,
      'The PowerShell command exited successfully but produced no output',
      {
        details: {
          marker: typeof context?.marker === 'string' ? context.marker : null,
          durationMs: context?.durationMs ?? null,
          exitCode: context?.exitCode ?? null,
        },
      },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.BAD_JSON,
      'The PowerShell output was not valid JSON',
      { details: { excerpt: excerpt(text), reason: error.name } },
    );
  }
  // R3-005: a literal `null` or `{}` is what `ConvertTo-Json` prints when the script's
  // result variable was never assigned. Such a value carries no structure at all, so the
  // source that consumed it reported `ok` with zero records — indistinguishable from a
  // genuine zero-record read. Both are degenerate output, not an empty read.
  // An empty *array* stays valid on purpose: the table sources really do serialize
  // zero rows as `[]` (PowerShell `ConvertTo-Json -InputObject @()` → `[]`), so rejecting
  // it here would turn a legitimate empty snapshot into a failure. The object-contract
  // sources validate their own keys on top of this (see `run-keys.js splitTable`).
  if (parsed === null) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_OUTPUT,
      'The PowerShell command exited successfully but printed the JSON literal null',
      {
        details: {
          marker: typeof context?.marker === 'string' ? context.marker : null,
          durationMs: context?.durationMs ?? null,
          exitCode: context?.exitCode ?? null,
        },
      },
    );
  }
  if (typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_OUTPUT,
      'The PowerShell command exited successfully but printed an empty JSON object',
      {
        details: {
          marker: typeof context?.marker === 'string' ? context.marker : null,
          durationMs: context?.durationMs ?? null,
          exitCode: context?.exitCode ?? null,
        },
      },
    );
  }
  return parsed;
}

/** First `# aegis-source:<name>` marker in the script, for diagnostics only. */
function scriptMarker(script) {
  const match = /^#\s*aegis-source:([A-Za-z0-9-]+)/mu.exec(String(script));
  return match === null ? null : match[1];
}

/**
 * Lane routing for the session pool.
 *
 * `scheduled-tasks` is the one read that legitimately takes 4–7 s of wall time (194 tasks ×
 * `Get-ScheduledTaskInfo`), so on a single serialized interpreter it is a head-of-line block:
 * every other source polled in the same tick queued behind it and hit the 5 s source timeout
 * (measured: `services` returned 0 rows in some windows, 294 in others). Giving that marker
 * its own interpreter keeps each lane serialized — the CL-5-safe invariant — while two
 * unrelated sources can be in flight at once.
 */
const SLOW_SESSION_MARKERS = Object.freeze(['scheduled-tasks', 'event-log']);

/**
 * A fixed set of lazily started session lanes. Lane 0 is the general lane; the slow marker
 * gets lane 1. Lanes are independent: a wedged or crashed interpreter only ever affects the
 * scripts routed to it.
 *
 * @param {object} options Same options as {@link createSessionTransport} plus `lanes`.
 * @returns {{run: Function, dispose: Function, stats: Function}} Pool handle.
 */
function createSessionLanePool({ lanes = 2, ...transportOptions } = {}) {
  const count = Number.isSafeInteger(lanes) && lanes > 0 ? lanes : 1;
  const transports = new Array(count).fill(null);

  function laneFor(script) {
    if (count < 2) {
      return 0;
    }
    return SLOW_SESSION_MARKERS.includes(scriptMarker(script)) ? 1 : 0;
  }

  function transportAt(index) {
    if (transports[index] === null) {
      transports[index] = createSessionTransport(transportOptions);
    }
    return transports[index];
  }

  return Object.freeze({
    run(script, callTimeoutMs) {
      return transportAt(laneFor(script)).run(script, callTimeoutMs);
    },

    dispose() {
      for (const transport of transports) {
        if (transport !== null) {
          transport.dispose();
        }
      }
    },

    stats() {
      const perLane = transports.map((transport, index) => (transport === null
        ? Object.freeze({ lane: index, spawns: 0, requests: 0, alive: false, pid: null })
        : Object.freeze({ lane: index, ...transport.stats() })));
      const alive = perLane.filter((lane) => lane.alive === true);
      return Object.freeze({
        laneCount: count,
        lanes: Object.freeze(perLane),
        spawns: perLane.reduce((sum, lane) => sum + lane.spawns, 0),
        requests: perLane.reduce((sum, lane) => sum + lane.requests, 0),
        desyncs: perLane.reduce((sum, lane) => sum + (lane.desyncs ?? 0), 0),
        timeouts: perLane.reduce((sum, lane) => sum + (lane.timeouts ?? 0), 0),
        exits: perLane.reduce((sum, lane) => sum + (lane.exits ?? 0), 0),
        startFailures: perLane.reduce((sum, lane) => sum + (lane.startFailures ?? 0), 0),
        alive: alive.length > 0,
        pid: alive.length > 0 ? alive[0].pid : null,
        pids: Object.freeze(alive.map((lane) => lane.pid)),
      });
    },
  });
}

export function createPowerShellClient({
  runner,
  executable = 'powershell.exe',
  timeoutMs = 15_000,
  session = 'auto',
  spawnChild = spawnSessionChild,
  startTimeoutMs = SESSION_START_TIMEOUT_MS,
  sessionLanes = 2,
} = {}) {
  if (!runner || typeof runner.run !== 'function') {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'a command runner exposing run() is required',
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'timeoutMs must be a positive integer');
  }

  // `auto` engages the session only for the built-in spawn-based runner; an injected
  // execFile is a test double and keeps the one-shot path so its recorded calls stay
  // one-per-script. An explicit `session: true` lets a test inject a fake spawner instead.
  const sessionWanted = session === 'auto'
    ? runner.persistentSession === true
    : session === true;
  let transport = sessionWanted
    ? createSessionLanePool({ lanes: sessionLanes, executable, spawnChild, startTimeoutMs })
    : null;
  let archived = null;

  /**
   * The original transport: one interpreter per call, script in the argument list as
   * base64 (`-EncodedCommand`), never on stdin (CL-5). Kept as the fallback and as the
   * path every injected runner takes.
   */
  async function executeOneShot(script, effectiveTimeout) {
    // The script travels in the argument list as base64, never on stdin (CL-5).
    const result = await runner.run({
      executable,
      args: [...POWERSHELL_FLAGS, encodeCommand(script)],
      tag: scriptMarker(script),
      timeoutMs: effectiveTimeout,
    });
    if (result.ok !== true) {
      throw classifyFailure(result);
    }
    return { stdout: stripBom(result.stdout), durationMs: result.durationMs, exitCode: result.code ?? null };
  }

  async function execute(script, callTimeoutMs) {
    if (typeof script !== 'string' || script.trim().length === 0) {
      throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'script must be a non-empty string');
    }
    const effectiveTimeout = callTimeoutMs === undefined ? timeoutMs : callTimeoutMs;
    if (transport !== null) {
      let outcome = null;
      try {
        outcome = await transport.run(script, effectiveTimeout);
      } catch (error) {
        if (!isSessionTransportFailure(error)) {
          // TIMEOUT / OUTPUT_TRUNCATED are the caller's business; retrying them on the
          // one-shot path would only double the wall time.
          throw error;
        }
        // Transport-level failure: retry this script once on the one-shot path. After
        // repeated start failures the session is abandoned for good, so a host where the
        // interpreter cannot hold a session pays the fallback exactly once.
        if (transport.stats().startFailures >= 3) {
          transport.dispose();
          transport = null;
        }
        outcome = null;
      }
      if (outcome !== null) {
        if (outcome.ok !== true) {
          throw classifyFailure(outcome);
        }
        return { stdout: stripBom(outcome.stdout), durationMs: outcome.durationMs, exitCode: outcome.code ?? null };
      }
    }
    return executeOneShot(script, effectiveTimeout);
  }

  return Object.freeze({
    executable,
    /**
     * True for the real client. A test double (or any injected transport) declares false so a
     * source that *may* use a native reader keeps replaying its fixture instead of touching
     * the live host; the native path is an optimisation of the real transport, not a
     * behaviour change the fixtures should have to model.
     */
    nativeCapable: true,

    /** Run a script that ends in `ConvertTo-Json` and return the parsed value. */
    async runJson(script, { timeoutMs: callTimeoutMs } = {}) {
      const { stdout, durationMs, exitCode } = await execute(script, callTimeoutMs);
      return parseJsonOutput(stdout, {
        marker: scriptMarker(script),
        durationMs,
        exitCode,
      });
    },

    /** Run a script and return its stdout without BOM or trailing newlines. */
    async runText(script, { timeoutMs: callTimeoutMs } = {}) {
      const { stdout, durationMs, exitCode } = await execute(script, callTimeoutMs);
      const text = stdout.replace(/\r?\n+$/, '');
      if (text.trim().length === 0) {
        throw new WindowsCollectorError(
          WINDOWS_ERROR_CODES.EMPTY_OUTPUT,
          'The PowerShell command exited successfully but produced no output',
          { details: { marker: scriptMarker(script), durationMs, exitCode } },
        );
      }
      return text;
    },

    /** Cheap liveness probe: interpreter present, allowlist satisfied, stdin works. */
    async probe() {
      const startedAt = Date.now();
      try {
        await execute('$PSVersionTable.PSVersion.Major', 5_000);
        return Object.freeze({ ok: true, durationMs: Date.now() - startedAt, errorCode: null });
      } catch (error) {
        return Object.freeze({
          ok: false,
          durationMs: Date.now() - startedAt,
          errorCode: error.code ?? WINDOWS_ERROR_CODES.COMMAND_FAILED,
        });
      }
    },

    /** Kill the shared interpreter. Safe to call twice; later calls use the one-shot path. */
    dispose() {
      if (transport !== null) {
        transport.dispose();
        // Archived *after* the kill so live is the truth, not a stale pre-dispose read.
        archived = transport.stats();
        transport = null;
      }
    },

    /** Session counters (spawns, requests, restarts) for tests and the perf evidence. */
    sessionStats() {
      return transport === null
        ? Object.freeze({ enabled: false, ...(archived ?? { spawns: 0, requests: 0, alive: false }) })
        : Object.freeze({ enabled: true, ...transport.stats() });
    },
  });
}

