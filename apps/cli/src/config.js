/**
 * config.js — where the CLI learns which daemon to talk to and which token to use.
 *
 * The security model of this file, and why it looks stricter than "read a JSON file":
 *
 * 1. **Loopback, by literal address, with an explicit port.** The daemon binds a
 *    literal `127.0.0.1` / `::1` and refuses a `Host` header naming anything else,
 *    so `localhost` (which goes through the resolver) is rejected here too. A
 *    default port is refused: the daemon's default is 0 (an ephemeral port chosen at
 *    start), so a guessed default would produce a confusing connection error instead
 *    of a configuration error.
 * 2. **No credentials in the configuration file, and none in argv.** The token lives
 *    in its own 0600 file, exactly as the daemon writes it. Putting it on the command
 *    line would publish it to every process on the box via the process list.
 * 3. **The token file must look protected.** A regular file (not a symlink, not a
 *    device, not a directory) that is not group- or world-readable on POSIX. This is
 *    the same "readable only through a private file" property the daemon relies on;
 *    a CLI that happily reads a 0644 token file would silently undo it.
 * 4. **The token never enters a serializable object.** `loadToken` is a closure, so
 *    there is no `config.token` field for a future `JSON.stringify(config)` to leak.
 * 5. **Unknown keys are rejected.** A misspelled `maxResponseByte` must not silently
 *    fall back to the default and leave the operator believing a limit is in force.
 *
 * Residual risk, stated rather than hidden: `lstat` followed by `open` is not atomic.
 * A local attacker who can replace the token file between the two calls could get a
 * different file read. That attacker already has write access to the data directory,
 * i.e. the ability to replace the token outright, so the race adds no capability.
 * The descriptor is re-checked after `open` to catch the ordinary case.
 */

import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { CliError, CLI_CODES } from './errors.js';
import { sanitizeText } from './format.js';

/** Configuration keys. Nothing else is accepted. */
const TOP_KEYS = Object.freeze(['endpoint', 'tokenFile', 'timeoutMs', 'maxResponseBytes']);

/** Literal loopback addresses the daemon may bind. `localhost` is deliberately absent. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);

/** Default request deadline in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Default response size cap in bytes. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1048576;

/** Accepted range for `timeoutMs` (also used by `--timeout`). */
export const TIMEOUT_RANGE = Object.freeze({ min: 100, max: 120000 });

/** Accepted range for `maxResponseBytes`. */
export const RESPONSE_BYTES_RANGE = Object.freeze({ min: 1024, max: 8388608 });

/**
 * Bearer token grammar.
 *
 * Kept identical to the daemon's `TOKEN_PATTERN`: a token the daemon would reject is
 * a configuration error here, not a 401 at run time.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;

function invalid(message) {
  return new CliError(CLI_CODES.CONFIG_INVALID, message);
}

/**
 * Parse and validate the daemon endpoint.
 *
 * @param {unknown} value Configuration value.
 * @returns {Readonly<{protocol: 'http:', host: string, port: number}>} Endpoint.
 * @throws {CliError} `ENDPOINT_REJECTED` when the value is not a literal loopback
 *   HTTP endpoint with an explicit port.
 */
export function parseEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(CLI_CODES.ENDPOINT_REJECTED, 'endpoint must be a non-empty string');
  }
  // A control character or a space in a URL is never a typo we can interpret.
  if (/[\u0000-\u0020\u007f]/u.test(value)) {
    throw new CliError(CLI_CODES.ENDPOINT_REJECTED, 'endpoint must not contain whitespace or control characters');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(CLI_CODES.ENDPOINT_REJECTED, 'endpoint is not a valid URL');
  }
  if (url.protocol !== 'http:') {
    throw new CliError(
      CLI_CODES.ENDPOINT_REJECTED,
      'endpoint must use http:// — the daemon serves plain HTTP/1.1 on loopback and has no TLS listener',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new CliError(CLI_CODES.ENDPOINT_REJECTED, 'endpoint must not carry credentials; the token file is the only credential source');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new CliError(CLI_CODES.ENDPOINT_REJECTED, 'endpoint must not carry a query string or fragment');
  }
  if (url.pathname !== '/') {
    throw new CliError(CLI_CODES.ENDPOINT_REJECTED, 'endpoint must not carry a path; requests are built from fixed route templates');
  }
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new CliError(
      CLI_CODES.ENDPOINT_REJECTED,
      `endpoint host must be a literal loopback address (${LOOPBACK_HOSTS.join(' or ')}); the daemon rejects every other Host header`,
    );
  }
  // WHATWG URL normalises the scheme-default port away, so `http://127.0.0.1:80` arrives
  // with an empty `url.port`. Reporting that as "an explicit port is required" would be
  // wrong — the operator did write one. The written form is read back from the raw string
  // (which also covers `:080` and `:0080`, both normalised to 80 by the parser); only a
  // genuinely absent port is rejected.
  const writtenPort = /:(\d{1,5})\/?$/u.exec(value);
  const port = url.port === ''
    ? (writtenPort === null ? null : Number(writtenPort[1]))
    : Number(url.port);
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(
      CLI_CODES.ENDPOINT_REJECTED,
      'endpoint must carry an explicit port (1..65535): the daemon binds an operator-chosen port, never a fixed default',
    );
  }
  return Object.freeze({ protocol: 'http:', host, port });
}

/**
 * Read a bearer token from its protected file.
 *
 * @param {string} filePath Absolute path.
 * @param {{platform?: string}} [options] Injectable platform for tests.
 * @returns {string} Token.
 * @throws {CliError} When the file is missing, not a regular file, too permissive
 *   or does not contain a usable token. The token value is never echoed.
 */
export function readTokenFile(filePath, options = {}) {
  const platform = options.platform ?? process.platform;
  let entry;
  try {
    entry = lstatSync(filePath);
  } catch (error) {
    const code = error?.code === 'ENOENT' ? CLI_CODES.CONFIG_NOT_FOUND : CLI_CODES.CONFIG_INVALID;
    throw new CliError(code, error?.code === 'ENOENT'
      ? 'token file does not exist'
      : 'token file is not accessible');
  }
  if (entry.isSymbolicLink()) {
    throw new CliError(CLI_CODES.TOKEN_UNPROTECTED, 'token file must be a regular file, not a symbolic link');
  }
  if (!entry.isFile()) {
    throw new CliError(CLI_CODES.TOKEN_UNPROTECTED, 'token file must be a regular file');
  }
  if (platform !== 'win32' && (entry.mode & 0o077) !== 0) {
    throw new CliError(
      CLI_CODES.TOKEN_UNPROTECTED,
      'token file must not be readable or writable by group or others; restrict it to mode 600',
    );
  }

  let descriptor = null;
  let text;
  try {
    descriptor = openSync(filePath, 'r');
    const opened = fstatSync(descriptor);
    // Re-check through the descriptor: `lstat` and `open` are two separate lookups.
    if (!opened.isFile()) {
      throw new CliError(CLI_CODES.TOKEN_UNPROTECTED, 'token file must be a regular file');
    }
    if (platform !== 'win32' && (opened.mode & 0o077) !== 0) {
      throw new CliError(
        CLI_CODES.TOKEN_UNPROTECTED,
        'token file must not be readable or writable by group or others; restrict it to mode 600',
      );
    }
    text = readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(CLI_CODES.CONFIG_INVALID, 'token file could not be read');
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Nothing left to close.
      }
    }
  }

  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new CliError(
      CLI_CODES.CONFIG_INVALID,
      'token file does not contain a usable bearer token (expected 32..512 characters of [A-Za-z0-9_-])',
    );
  }
  return token;
}

function integerIn(value, label, range, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw invalid(`${label} must be an integer in ${range.min}..${range.max}`);
  }
  return value;
}

/**
 * Load the CLI configuration.
 *
 * @param {{
 *   configPath?: string|null,
 *   env?: Record<string, string|undefined>,
 *   platform?: string
 * }} [options] Options.
 * @returns {Readonly<{
 *   configPath: string,
 *   endpoint: {protocol: string, host: string, port: number},
 *   tokenFile: string|null,
 *   timeoutMs: number,
 *   maxResponseBytes: number,
 *   loadToken: () => string
 * }>} Configuration with a lazy token accessor.
 * @throws {CliError} When the file is missing, unreadable, not JSON, or invalid.
 */
export function loadCliConfig(options = {}) {
  const env = options.env ?? process.env;
  const explicit = options.configPath ?? null;
  const fromEnv = typeof env.AEGIS_CLI_CONFIG === 'string' && env.AEGIS_CLI_CONFIG.length > 0
    ? env.AEGIS_CLI_CONFIG
    : null;
  const selected = explicit ?? fromEnv;
  if (selected === null) {
    throw new CliError(
      CLI_CODES.CONFIG_NOT_FOUND,
      'no client configuration: pass --config <path> or set AEGIS_CLI_CONFIG',
    );
  }
  if (typeof selected !== 'string' || selected.length === 0) {
    throw invalid('configuration path must be a non-empty string');
  }
  const configPath = isAbsolute(selected) ? resolve(selected) : resolve(process.cwd(), selected);

  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = error?.code === 'ENOENT' ? CLI_CODES.CONFIG_NOT_FOUND : CLI_CODES.CONFIG_INVALID;
    throw new CliError(code, error?.code === 'ENOENT'
      ? 'client configuration file does not exist'
      : 'client configuration file is not readable');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid('client configuration file is not valid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('client configuration must be a JSON object');
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) {
      // The key name is local text, but it is still sanitized: it may be anything.
      throw invalid(`client configuration has unknown key "${sanitizeText(key, 40)}"`);
    }
  }

  const endpoint = parseEndpoint(raw.endpoint);

  let tokenFile = null;
  if (raw.tokenFile !== undefined) {
    if (typeof raw.tokenFile !== 'string' || raw.tokenFile.length === 0) {
      throw invalid('tokenFile must be a non-empty string');
    }
    // A relative token path is resolved against the configuration file, not the
    // caller's working directory: the file and the secret belong together.
    tokenFile = isAbsolute(raw.tokenFile) ? resolve(raw.tokenFile) : resolve(dirname(configPath), raw.tokenFile);
  }

  const timeoutMs = integerIn(raw.timeoutMs, 'timeoutMs', TIMEOUT_RANGE, DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = integerIn(
    raw.maxResponseBytes,
    'maxResponseBytes',
    RESPONSE_BYTES_RANGE,
    DEFAULT_MAX_RESPONSE_BYTES,
  );

  let cachedToken = null;
  const loadToken = () => {
    if (tokenFile === null) {
      throw invalid('tokenFile is required for commands that authenticate against the daemon');
    }
    if (cachedToken === null) {
      cachedToken = readTokenFile(tokenFile, { platform: options.platform });
    }
    return cachedToken;
  };

  return Object.freeze({
    configPath,
    endpoint,
    tokenFile,
    timeoutMs,
    maxResponseBytes,
    loadToken,
  });
}
