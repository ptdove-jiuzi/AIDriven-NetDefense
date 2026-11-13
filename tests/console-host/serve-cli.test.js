/**
 * `apps/console-next/serve.mjs` command line contract (author PT-dove).
 *
 * The packaging baseline (`deploy/embedded-runtime/console-shell/serve.mjs`) is
 * the compatibility floor: same flags, same loopback refusal code 2, same
 * announcement marker. These tests pin the additions — `--token-file`, the
 * single-line JSON announcement, and the fact that the token never reaches
 * stdout/stderr — plus the pure helpers, which is also where the loopback peer
 * rule is proven (a non-loopback peer cannot be simulated from the same host).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  csrfFor,
  isLoopbackHostname,
  isLoopbackPeer,
  parseDaemon,
} from '../../apps/console-next/serve.mjs';
import {
  SERVE_PATH,
  TEST_TOKEN,
  runConsole,
  startConsole,
  startFakeDaemon,
  jsonDaemon,
} from './helpers.mjs';

const scratchDirs = [];
after(() => {
  for (const directory of scratchDirs) rmSync(directory, { recursive: true, force: true });
});

function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'aidn-console-host-cli-'));
  scratchDirs.push(directory);
  return directory;
}

describe('console host: announcement', () => {
  it('prints one single-line JSON object with listening and daemon, and never the token', async () => {
    const daemon = await startFakeDaemon(jsonDaemon());
    const host = await startConsole(['--daemon', daemon.url, '--token', TEST_TOKEN]);
    try {
      const stdout = host.stdout();
      assert.equal(stdout.trim().split(/\r?\n/u).length, 1, `expected one line, got: ${stdout}`);
      const announcement = JSON.parse(stdout.trim());
      assert.match(announcement.listening, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
      assert.equal(announcement.daemon, daemon.url);
      assert.equal(announcement.tokenInjected, true);
      assert.equal(announcement.schemaVersion, '1.0');
      assert.doesNotMatch(stdout, new RegExp(TEST_TOKEN.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        'the token must never be printed');
      assert.equal(host.stderr().includes(TEST_TOKEN), false, 'the token must never reach stderr');
    } finally {
      await host.close();
      await daemon.close();
    }
  });

  it('announces with tokenInjected false when no credential is supplied', async () => {
    const daemon = await startFakeDaemon(jsonDaemon());
    const host = await startConsole(['--daemon', daemon.url]);
    try {
      const announcement = JSON.parse(host.stdout().trim());
      assert.equal(announcement.tokenInjected, false);
      assert.equal(announcement.daemon, daemon.url);
    } finally {
      await host.close();
      await daemon.close();
    }
  });

  it('reads and trims --token-file, then injects the trimmed value', async () => {
    const directory = scratch();
    const token = `  ${TEST_TOKEN}\n\n`;
    const tokenFile = join(directory, 'daemon.token');
    writeFileSync(tokenFile, token, 'utf8');
    const daemon = await startFakeDaemon(jsonDaemon());
    const host = await startConsole(['--daemon', daemon.url, '--token-file', tokenFile]);
    try {
      const health = await fetch(`${host.url}healthz`);
      assert.equal(health.status, 200);
      assert.equal(daemon.requests.length, 1);
      assert.equal(daemon.requests[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
      assert.equal(host.stdout().includes(TEST_TOKEN), false);
      assert.equal(host.stderr().includes(TEST_TOKEN), false);
    } finally {
      await host.close();
      await daemon.close();
    }
  });
  it('--verbose logs method/path/status/duration only, and never the token', async () => {
    const daemon = await startFakeDaemon(jsonDaemon());
    const host = await startConsole(['--daemon', daemon.url, '--token', TEST_TOKEN, '--verbose']);
    try {
      const response = await fetch(`${host.url}healthz`);
      assert.equal(response.status, 200);
      // Give the response 'close' callback time to write its line.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      const stderr = host.stderr();
      assert.match(stderr, /^console-host: GET \/healthz 200 \d+\.\dms$/mu);
      assert.equal(stderr.includes(TEST_TOKEN), false, 'diagnostics must never include the token');
      assert.equal(stderr.includes('Bearer'), false, 'diagnostics must never include an Authorization value');
      assert.match(host.stdout(), /^\{.*"listening".*\}\s*$/u, 'diagnostics go to stderr, not stdout');
    } finally {
      await host.close();
      await daemon.close();
    }
  });
});

describe('console host: CLI refusals', () => {
  it('refuses a non-loopback --host with exit code 2 and a loopback-only message', async () => {
    for (const host of ['0.0.0.0', '192.168.1.5', '::']) {
      const result = await runConsole(['--daemon', 'http://127.0.0.1:9', '--host', host]);
      assert.equal(result.code, 2, `--host ${host} must be refused, stderr=${result.stderr}`);
      assert.match(result.stderr, /loopback-only/u);
    }
  });

  it('refuses an unknown argument', async () => {
    const result = await runConsole(['--daemon', 'http://127.0.0.1:9', '--bogus']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown argument: --bogus/u);
  });

  it('refuses a --token that could not be a header value', async () => {
    for (const token of ['has space', 'line\nbreak', 'x'.repeat(600)]) {
      const result = await runConsole(['--daemon', 'http://127.0.0.1:9', '--token', token]);
      assert.equal(result.code, 2, `token ${JSON.stringify(token)} must be refused`);
      assert.match(result.stderr, /cannot be sent in a header/u);
    }
  });

  it('refuses both --token and --token-file', async () => {
    const result = await runConsole(['--daemon', 'http://127.0.0.1:9',
      '--token', TEST_TOKEN, '--token-file', join(scratch(), 'x.token')]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /either --token or --token-file/u);
  });

  it('refuses an unreadable or empty --token-file', async () => {
    const directory = scratch();
    const missing = await runConsole(['--daemon', 'http://127.0.0.1:9', '--token-file', join(directory, 'nope')]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /not readable/u);

    const empty = join(directory, 'empty.token');
    writeFileSync(empty, '   \n', 'utf8');
    const emptyResult = await runConsole(['--daemon', 'http://127.0.0.1:9', '--token-file', empty]);
    assert.equal(emptyResult.code, 2);
    assert.match(emptyResult.stderr, /is empty/u);
  });

  it('refuses a --port outside 0..65535', async () => {
    for (const port of ['70000', '-1', 'abc']) {
      const result = await runConsole(['--daemon', 'http://127.0.0.1:9', '--port', port]);
      assert.equal(result.code, 2, `--port ${port} must be refused`);
      assert.match(result.stderr, /--port must be an integer 0\.\.65535/u);
    }
  });

  it('refuses a non-loopback, credentialed, or path-carrying --daemon', async () => {
    const cases = [
      ['http://192.168.1.5:7345', /non-loopback daemon/u],
      ['http://10.0.0.1', /non-loopback daemon/u],
      ['http://user:pass@127.0.0.1:7345', /must not carry credentials/u],
      ['http://127.0.0.1:7345/api', /must be an origin, not a path/u],
      ['http://127.0.0.1:7345/?x=1', /must be an origin, not a query/u],
      ['not-a-url', /is not a URL/u],
      ['ftp://127.0.0.1:7345', /must be http\(s\)/u],
    ];
    for (const [daemon, pattern] of cases) {
      const result = await runConsole(['--daemon', daemon]);
      assert.equal(result.code, 2, `--daemon ${daemon} must be refused, stderr=${result.stderr}`);
      assert.match(result.stderr, pattern);
    }
  });

  it('--help exits 0 with usage and does not listen', async () => {
    const result = await runConsole(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /usage: node console-next\/serve\.mjs --daemon/u);
  });
});

describe('console host: pure helpers', () => {
  it('accepts exactly the loopback peers', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
      assert.equal(isLoopbackPeer(address), true, address);
    }
    for (const address of ['192.168.1.7', '10.0.0.1', '127.0.0.2', '::2', '', undefined]) {
      assert.equal(isLoopbackPeer(address), false, String(address));
    }
  });

  it('accepts exactly the loopback bind hostnames', () => {
    for (const hostname of ['127.0.0.1', '::1', 'localhost']) {
      assert.equal(isLoopbackHostname(hostname), true, hostname);
    }
    for (const hostname of ['0.0.0.0', '::', '192.168.1.5', 'console.local', '', undefined]) {
      assert.equal(isLoopbackHostname(hostname), false, String(hostname));
    }
  });

  it('derives the CSRF proof exactly like apps/daemon/src/api/auth.js', () => {
    // Independently re-derived here (the test does not import the daemon module so
    // that this suite stays runnable while B8 rewrites the API surface).
    const expected = createHash('sha256').update(`aegis-csrf:${TEST_TOKEN}`, 'utf8').digest('base64url');
    assert.equal(csrfFor(TEST_TOKEN), expected);
    assert.notEqual(csrfFor(TEST_TOKEN), TEST_TOKEN);
    assert.notEqual(csrfFor(TEST_TOKEN), csrfFor(`${TEST_TOKEN}x`));
  });

  it('normalises the daemon origin and Host header for loopback spellings', () => {
    const ipv4 = parseDaemon('http://127.0.0.1:7345');
    assert.equal(ipv4.origin, 'http://127.0.0.1:7345');
    assert.equal(ipv4.hostHeader, '127.0.0.1:7345');
    assert.equal(ipv4.port, 7345);

    const localhost = parseDaemon('http://localhost:7345');
    assert.equal(localhost.hostname, 'localhost');
    assert.equal(localhost.hostHeader, '127.0.0.1:7345',
      'the daemon rejects a Host header that is not a loopback literal');

    const ipv6 = parseDaemon('http://[::1]:7345');
    assert.equal(ipv6.hostname, '::1');
    assert.equal(ipv6.hostHeader, '[::1]:7345');
  });

  it('has no child-process or browser-launch primitive', () => {
    const source = readFileSync(SERVE_PATH, 'utf8');
    for (const forbidden of ['node:child_process', 'execFile', 'spawn(', 'openExternal', 'exec(',
      'xdg-open', 'start http', 'shell.']) {
      assert.equal(source.includes(forbidden), false, `serve.mjs must not contain ${forbidden}`);
    }
  });
});
