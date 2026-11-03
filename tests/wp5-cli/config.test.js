/**
 * config.test.js — endpoint admission and how the token is read.
 *
 * The point of most of these cases is negative: an endpoint that is not a literal
 * loopback address, a token file that is not private, a configuration key that is not
 * known. Each one is a way the CLI could quietly talk to the wrong thing or read a
 * secret it should refuse.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  loadCliConfig,
  parseEndpoint,
  readTokenFile,
} from '../../apps/cli/src/config.js';
import { CLI_CODES, CliError } from '../../apps/cli/src/errors.js';
import { TEST_TOKEN, makeTempDir, writeClientConfig } from './helpers.js';

/**
 * Assert that a thunk throws a CLI error with a specific code.
 *
 * @param {() => unknown} thunk Call.
 * @param {string} code Expected code.
 * @returns {CliError} The thrown error.
 */
function expectCode(thunk, code) {
  try {
    thunk();
  } catch (error) {
    assert.ok(error instanceof CliError, `expected a CliError, got ${error?.name ?? typeof error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
}

describe('parseEndpoint', () => {
  it('accepts a literal IPv4 loopback endpoint with an explicit port', () => {
    const endpoint = parseEndpoint('http://127.0.0.1:8443');
    assert.equal(endpoint.host, '127.0.0.1');
    assert.equal(endpoint.port, 8443);
    assert.equal(endpoint.protocol, 'http:');
  });

  it('accepts an IPv6 loopback endpoint and drops the brackets', () => {
    const endpoint = parseEndpoint('http://[::1]:8443');
    assert.equal(endpoint.host, '::1');
    assert.equal(endpoint.port, 8443);
  });

  it('accepts a trailing slash', () => {
    assert.equal(parseEndpoint('http://127.0.0.1:8443/').port, 8443);
  });

  it('rejects localhost because the daemon rejects that Host header', () => {
    const error = expectCode(() => parseEndpoint('http://localhost:8443'), CLI_CODES.ENDPOINT_REJECTED);
    assert.match(error.message, /literal loopback/u);
  });

  it('rejects https, which the daemon has no listener for', () => {
    const error = expectCode(() => parseEndpoint('https://127.0.0.1:8443'), CLI_CODES.ENDPOINT_REJECTED);
    assert.match(error.message, /http:/u);
  });

  it('rejects credentials embedded in the URL', () => {
    expectCode(() => parseEndpoint('http://user:pass@127.0.0.1:8443'), CLI_CODES.ENDPOINT_REJECTED);
  });

  it('rejects a path', () => {
    expectCode(() => parseEndpoint('http://127.0.0.1:8443/api/v1/status'), CLI_CODES.ENDPOINT_REJECTED);
  });

  it('rejects a query string', () => {
    expectCode(() => parseEndpoint('http://127.0.0.1:8443/?x=1'), CLI_CODES.ENDPOINT_REJECTED);
  });

  it('rejects a missing port instead of guessing a default', () => {
    const error = expectCode(() => parseEndpoint('http://127.0.0.1'), CLI_CODES.ENDPOINT_REJECTED);
    assert.match(error.message, /explicit port/u);
  });

  it('rejects port 0', () => {
    expectCode(() => parseEndpoint('http://127.0.0.1:0'), CLI_CODES.ENDPOINT_REJECTED);
  });

  it('accepts port 80 even though the URL parser normalises it away', () => {
    // `new URL('http://host:80').port` is the empty string. Treating that as "no port was
    // written" would print a false diagnosis, so the written form is recognised.
    assert.equal(parseEndpoint('http://127.0.0.1:80').port, 80);
    assert.equal(parseEndpoint('http://[::1]:80').port, 80);
    // Zero-padded spellings normalise the same way and must not be misdiagnosed either.
    assert.equal(parseEndpoint('http://127.0.0.1:080').port, 80);
    assert.equal(parseEndpoint('http://127.0.0.1:0080').port, 80);
  });

  it('rejects whitespace and control characters', () => {
    expectCode(() => parseEndpoint('http://127.0.0.1:8443\n'), CLI_CODES.ENDPOINT_REJECTED);
    expectCode(() => parseEndpoint(' http://127.0.0.1:8443'), CLI_CODES.ENDPOINT_REJECTED);
  });

  it('rejects a non-string or empty value', () => {
    expectCode(() => parseEndpoint(undefined), CLI_CODES.ENDPOINT_REJECTED);
    expectCode(() => parseEndpoint(''), CLI_CODES.ENDPOINT_REJECTED);
    expectCode(() => parseEndpoint(8443), CLI_CODES.ENDPOINT_REJECTED);
  });

  it('rejects a remote host', () => {
    expectCode(() => parseEndpoint('http://192.0.2.10:8443'), CLI_CODES.ENDPOINT_REJECTED);
  });
});

describe('loadCliConfig', () => {
  it('requires a configuration path or AEGIS_CLI_CONFIG', () => {
    const error = expectCode(() => loadCliConfig({ env: {} }), CLI_CODES.CONFIG_NOT_FOUND);
    assert.match(error.message, /--config/u);
  });

  it('uses AEGIS_CLI_CONFIG when no flag is given', () => {
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: 8443 });
    const config = loadCliConfig({ env: { AEGIS_CLI_CONFIG: configPath } });
    assert.equal(config.endpoint.port, 8443);
  });

  it('prefers an explicit --config over the environment', () => {
    const first = makeTempDir();
    const second = makeTempDir();
    const a = writeClientConfig(first, { port: 8443 });
    const b = writeClientConfig(second, { port: 9443 });
    const config = loadCliConfig({ configPath: b.configPath, env: { AEGIS_CLI_CONFIG: a.configPath } });
    assert.equal(config.endpoint.port, 9443);
  });

  it('reports a missing file as CONFIG_NOT_FOUND', () => {
    expectCode(
      () => loadCliConfig({ configPath: join(makeTempDir(), 'absent.json'), env: {} }),
      CLI_CODES.CONFIG_NOT_FOUND,
    );
  });

  it('reports malformed JSON as CONFIG_INVALID', () => {
    const directory = makeTempDir();
    const configPath = join(directory, 'broken.json');
    writeFileSync(configPath, '{ "endpoint": ', 'utf8');
    expectCode(() => loadCliConfig({ configPath, env: {} }), CLI_CODES.CONFIG_INVALID);
  });

  it('rejects a non-object document', () => {
    const directory = makeTempDir();
    const configPath = join(directory, 'array.json');
    writeFileSync(configPath, '[]', 'utf8');
    expectCode(() => loadCliConfig({ configPath, env: {} }), CLI_CODES.CONFIG_INVALID);
  });

  it('rejects an unknown key rather than silently ignoring it', () => {
    const directory = makeTempDir();
    const configPath = join(directory, 'unknown.json');
    writeFileSync(configPath, JSON.stringify({ endpoint: 'http://127.0.0.1:8443', maxResponseByte: 4096 }), 'utf8');
    const error = expectCode(() => loadCliConfig({ configPath, env: {} }), CLI_CODES.CONFIG_INVALID);
    assert.match(error.message, /unknown key/u);
  });

  it('sanitizes an unknown key that contains control characters', () => {
    const directory = makeTempDir();
    const configPath = join(directory, 'control.json');
    writeFileSync(configPath, '{"endpoint":"http://127.0.0.1:8443","bad\\u001b[2Jkey":1}', 'utf8');
    const error = expectCode(() => loadCliConfig({ configPath, env: {} }), CLI_CODES.CONFIG_INVALID);
    assert.equal(error.message.includes('\u001b'), false, 'the error must not echo an escape sequence');
  });

  it('applies the documented defaults', () => {
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: 8443 });
    const config = loadCliConfig({ configPath, env: {} });
    assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  });

  it('rejects an out-of-range timeout', () => {
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: 8443, timeoutMs: 10 });
    expectCode(() => loadCliConfig({ configPath, env: {} }), CLI_CODES.CONFIG_INVALID);
  });

  it('rejects an out-of-range response cap', () => {
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: 8443, maxResponseBytes: 10 });
    expectCode(() => loadCliConfig({ configPath, env: {} }), CLI_CODES.CONFIG_INVALID);
  });

  it('resolves a relative token path against the configuration directory', () => {
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: 8443, tokenFile: 'secrets/api-token' });
    const config = loadCliConfig({ configPath, env: {} });
    assert.equal(config.tokenFile, join(directory, 'secrets', 'api-token'));
    assert.equal(config.loadToken(), TEST_TOKEN);
  });

  it('allows a configuration without a token only for unauthenticated commands', () => {
    const directory = makeTempDir();
    const configPath = join(directory, 'no-token.json');
    writeFileSync(configPath, JSON.stringify({ endpoint: 'http://127.0.0.1:8443' }), 'utf8');
    const config = loadCliConfig({ configPath, env: {} });
    assert.equal(config.tokenFile, null);
    const error = expectCode(() => config.loadToken(), CLI_CODES.CONFIG_INVALID);
    assert.match(error.message, /tokenFile is required/u);
  });

  it('never exposes the token as a configuration field', () => {
    const directory = makeTempDir();
    const { configPath } = writeClientConfig(directory, { port: 8443 });
    const config = loadCliConfig({ configPath, env: {} });
    assert.equal(Object.keys(config).includes('token'), false);
    assert.equal(JSON.stringify(config).includes(TEST_TOKEN), false);
  });
});

describe('readTokenFile', () => {
  it('reads a private token file', () => {
    const directory = makeTempDir();
    const { tokenPath } = writeClientConfig(directory, { port: 8443 });
    assert.equal(readTokenFile(tokenPath), TEST_TOKEN);
  });

  it('reports a missing file without echoing a path', () => {
    const directory = makeTempDir();
    const error = expectCode(
      () => readTokenFile(join(directory, 'absent')),
      CLI_CODES.CONFIG_NOT_FOUND,
    );
    assert.equal(error.message.includes(directory), false);
  });

  it('rejects content that is not a bearer token, and never echoes it', () => {
    const directory = makeTempDir();
    const tokenPath = join(directory, 'short-token');
    writeFileSync(tokenPath, 'too-short\n', 'utf8');
    const error = expectCode(() => readTokenFile(tokenPath), CLI_CODES.CONFIG_INVALID);
    assert.equal(error.message.includes('too-short'), false);
  });

  it('rejects a token with characters outside the bearer grammar', () => {
    const directory = makeTempDir();
    const tokenPath = join(directory, 'bad-chars');
    writeFileSync(tokenPath, `${'a'.repeat(30)}:${'b'.repeat(10)}\n`, 'utf8');
    expectCode(() => readTokenFile(tokenPath), CLI_CODES.CONFIG_INVALID);
  });

  it('rejects a directory', () => {
    const directory = makeTempDir();
    const nested = join(directory, 'not-a-file');
    mkdirSync(nested);
    expectCode(() => readTokenFile(nested), CLI_CODES.TOKEN_UNPROTECTED);
  });

  it('rejects a symbolic link', (t) => {
    const directory = makeTempDir();
    const { tokenPath } = writeClientConfig(directory, { port: 8443 });
    const linkPath = join(directory, 'link-token');
    try {
      symlinkSync(tokenPath, linkPath);
    } catch {
      // Creating a symlink needs elevation on some Windows configurations.
      t.skip('symbolic links are not available in this environment');
      return;
    }
    expectCode(() => readTokenFile(linkPath), CLI_CODES.TOKEN_UNPROTECTED);
  });

  it('rejects a group- or world-readable token file on POSIX', () => {
    const directory = makeTempDir();
    const { tokenPath } = writeClientConfig(directory, { port: 8443 });
    try {
      chmodSync(tokenPath, 0o644);
    } catch {
      // Windows has no POSIX mode bits and reports 0666 for a regular file, which is
      // already permissive enough for the check below to trigger.
    }
    // The platform is injected: the mode branch is the same on every host, and the
    // assertion must not silently pass on Windows just because the host has no bits.
    const error = expectCode(
      () => readTokenFile(tokenPath, { platform: 'linux' }),
      CLI_CODES.TOKEN_UNPROTECTED,
    );
    assert.match(error.message, /mode 600/u);
  });

  it('has no mode check on win32, and that gap is asserted rather than assumed', (t) => {
    if (process.platform !== 'win32') {
      // On POSIX this same file is 0600 and would take the accepted path; that positive
      // case is covered by the "reads a private token file" test on a POSIX host.
      t.skip('POSIX hosts enforce the mode check, which the previous test covers');
      return;
    }
    const directory = makeTempDir();
    const { tokenPath } = writeClientConfig(directory, { port: 8443 });
    // Windows has no POSIX mode bits: Node reports 0666 for an ordinary file, so the mode
    // branch cannot apply and the ACL inherited from the data directory is what protects
    // the file. Recorded here so the limitation is a test, not a footnote.
    assert.equal(readTokenFile(tokenPath), TEST_TOKEN);
    expectCode(() => readTokenFile(tokenPath, { platform: 'linux' }), CLI_CODES.TOKEN_UNPROTECTED);
  });
});
