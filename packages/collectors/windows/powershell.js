/**
 * PowerShell client: wraps a script, parses JSON, classifies failures.
 *
 * The interpreter is invoked as
 *   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -
 * with the script on stdin. `-Command -` reads the whole stdin stream as one script, so
 * there is no quoting layer, no `-EncodedCommand` base64 limit and no cmd.exe in between.
 * `-NoProfile` matters for correctness, not only for speed: a profile that writes to stdout
 * would corrupt every `ConvertTo-Json` parse.
 *
 * The preamble forces terminating errors, UTF-8 output and no progress stream. Progress
 * rendering writes to the host and would otherwise interleave with the JSON body.
 */

import { WINDOWS_ERROR_CODES, WindowsCollectorError } from './errors.js';

export const POWERSHELL_FLAGS = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  '-',
]);

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
 * route a fixture by inspecting stdin instead of by call order.
 */
export function wrapScript(body) {
  return `${SCRIPT_PREAMBLE}\n${String(body)}\n`;
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

function parseJsonOutput(stdout) {
  const text = stripBom(stdout).trim();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.BAD_JSON,
      'The PowerShell output was not valid JSON',
      { details: { excerpt: excerpt(text), reason: error.name } },
    );
  }
}

export function createPowerShellClient({
  runner,
  executable = 'powershell.exe',
  timeoutMs = 15_000,
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

  async function execute(script, callTimeoutMs) {
    if (typeof script !== 'string' || script.trim().length === 0) {
      throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'script must be a non-empty string');
    }
    const result = await runner.run({
      executable,
      args: POWERSHELL_FLAGS,
      stdin: wrapScript(script),
      timeoutMs: callTimeoutMs === undefined ? timeoutMs : callTimeoutMs,
    });
    if (result.ok !== true) {
      throw classifyFailure(result);
    }
    return { stdout: stripBom(result.stdout), durationMs: result.durationMs };
  }

  return Object.freeze({
    executable,

    /** Run a script that ends in `ConvertTo-Json` and return the parsed value. */
    async runJson(script, { timeoutMs: callTimeoutMs } = {}) {
      const { stdout } = await execute(script, callTimeoutMs);
      return parseJsonOutput(stdout);
    },

    /** Run a script and return its stdout without BOM or trailing newlines. */
    async runText(script, { timeoutMs: callTimeoutMs } = {}) {
      const { stdout } = await execute(script, callTimeoutMs);
      return stdout.replace(/\r?\n+$/, '');
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
  });
}
