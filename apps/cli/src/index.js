/**
 * index.js — public surface of the read-only CLI.
 *
 * Exported so tests (and a future packaging step) can drive the same code path the
 * executable uses. Nothing here opens a database, spawns a process or writes a file.
 */

export { run, OUTPUT_SCHEMA_VERSION, USAGE } from './main.js';
export { CLI_CODES, CLI_EXIT, CliError, exitForCode, isCliError, toCliError } from './errors.js';
export {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  LOOPBACK_HOSTS,
  RESPONSE_BYTES_RANGE,
  TIMEOUT_RANGE,
  TOKEN_PATTERN,
  loadCliConfig,
  parseEndpoint,
  readTokenFile,
} from './config.js';
export { createLoopbackClient, readJson } from './http-client.js';
export { CURSOR_MAX_LENGTH, isCursorToken, isReadOnlyPath, ROUTES } from './routes.js';
export {
  DEFAULT_LIMIT,
  DEFAULT_MAX_PAGES,
  LIMIT_RANGE,
  MAX_PAGES_RANGE,
  assertAnalysisId,
  fetchAlerts,
  fetchAnalysis,
  fetchHealth,
  fetchStatus,
  parseCursor,
  parseLimit,
  parseMaxPages,
  projectStatus,
} from './commands.js';
export { displayWidth, formatUptime, sanitizeText, truncateToWidth } from './format.js';
export { renderAlerts, renderAnalysis, renderHealth, renderStatus } from './views.js';
