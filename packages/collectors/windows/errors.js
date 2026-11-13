/**
 * Error taxonomy for the Windows adapter.
 *
 * Codes are stable strings so the collector set can classify a failure without parsing
 * messages: permission problems latch a source as `unavailable`, everything else degrades
 * it. Every failure carries a remediation sentence because §5.1 requires the snapshot to
 * explain what an operator has to fix.
 */

export const WINDOWS_ERROR_CODES = Object.freeze({
  EXECUTABLE_NOT_ALLOWED: 'EXECUTABLE_NOT_ALLOWED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_RECORD: 'INVALID_RECORD',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  TIMEOUT: 'TIMEOUT',
  OUTPUT_TRUNCATED: 'OUTPUT_TRUNCATED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  NO_EVENTS: 'NO_EVENTS',
  BAD_JSON: 'BAD_JSON',
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  COMMAND_FAILED: 'COMMAND_FAILED',
  SOURCE_LIMIT_EXCEEDED: 'SOURCE_LIMIT_EXCEEDED',
  SOURCE_UNKNOWN: 'SOURCE_UNKNOWN',
});

export const DEFAULT_REMEDIATION =
  'Inspect the collector log for the recorded command failure and verify the collector account can run PowerShell';

const REMEDIATIONS = Object.freeze({
  EXECUTABLE_NOT_ALLOWED:
    'Only powershell.exe and pwsh.exe may be executed; fix the adapter configuration instead of widening the allowlist at runtime',
  INVALID_ARGUMENT: 'Fix the adapter call site; this is a programming error, not an environment problem',
  INVALID_CONFIG: 'Fix the collector configuration and restart the collector',
  INVALID_RECORD:
    'The adapter produced a record or payload the contract rejects; this is an adapter bug, not an environment problem',
  PATH_NOT_ALLOWED:
    'Use an absolute local or UNC path without quotes, wildcards or traversal segments',
  TIMEOUT:
    'Raise the collector timeout or reduce the query scope (shorter interval, fewer records per read)',
  OUTPUT_TRUNCATED:
    'Raise maxBuffer or reduce the query output; the truncated read was discarded rather than partially parsed',
  ACCESS_DENIED:
    'Grant the collector account read access (Event Log Readers group for event channels, administrator for other users process and network detail) and restart the collector',
  CHANNEL_NOT_FOUND:
    'Check the configured event channel name on this host; the channel does not exist on this Windows build',
  NO_EVENTS: 'No action required: the channel or query simply has no matching records yet',
  BAD_JSON:
    'The PowerShell output was not valid JSON; verify the local PowerShell version emits ConvertTo-Json output and that no profile writes to stdout',
  EMPTY_OUTPUT:
    'The interpreter exited successfully but printed nothing. A JSON-producing script must always emit at least one object; an empty stdout means the script did not run (truncation, profile, or wrong interpreter). Never treat it as "no new events"',
  INVALID_OUTPUT:
    'The interpreter exited successfully but printed a degenerate JSON value (`null` or `{}`) instead of a result structure. That is a script/serialization defect, not an empty read; inspect the generated script and make sure no profile writes to stdout',
  COMMAND_FAILED:
    'Run the failing PowerShell command manually under the collector account to see the full error',
  SOURCE_LIMIT_EXCEEDED:
    'Reduce the number of configured roots so the source stays inside its declared bound',
  SOURCE_UNKNOWN: 'Register the source before polling it',
});

export function remediationFor(code, fallback = DEFAULT_REMEDIATION) {
  return REMEDIATIONS[code] ?? fallback;
}

export class WindowsCollectorError extends Error {
  code;

  details;

  remediation;

  constructor(code, message, { details = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WindowsCollectorError';
    this.code = code;
    this.details = details;
    this.remediation = remediationFor(code);
  }
}

export function isWindowsCollectorError(value) {
  return value instanceof WindowsCollectorError;
}

/**
 * Normalize anything thrown by a source into the adapter error shape. Unexpected errors
 * keep their original message as `details.cause` so the snapshot stays actionable without
 * leaking a stack trace into a telemetry event.
 *
 * An error that already carries a non-empty string `code` (a `CollectorError` from the common
 * layer, for instance) keeps it as `details.originalCode`: the adapter taxonomy does not own
 * that failure, and rewriting it would point the operator at the wrong remediation.
 */
export function asWindowsCollectorError(error) {
  if (isWindowsCollectorError(error)) {
    return error;
  }
  const originalCode = typeof error?.code === 'string' && error.code.length > 0 ? error.code : null;
  return new WindowsCollectorError(
    WINDOWS_ERROR_CODES.COMMAND_FAILED,
    error instanceof Error ? error.message : String(error),
    {
      details: {
        cause: error instanceof Error ? error.name : typeof error,
        ...(originalCode === null ? {} : { originalCode }),
      },
    },
  );
}
