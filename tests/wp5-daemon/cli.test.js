/**
 * cli.test.js — the process skeleton, exercised as a process.
 *
 * Everything else in this suite constructs the daemon in-process. The requirement
 * is "a startable daemon process", so at least one case has to actually start one:
 * argument handling, configuration loading, the readiness log line, a real
 * loopback listener and a terminated process.
 *
 * The child is always killed, and its data directory is a temporary one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { makeRulePack, makeTempDir, httpRequest } from './helpers.js';

const BIN = join(process.cwd(), 'apps', 'daemon', 'bin.js');
const NODE = process.execPath;

/** Run the CLI to completion and collect its output. */
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [BIN, ...args], { cwd: process.cwd(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 8000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Start the CLI in mock mode and resolve once it reports readiness. */
function startCli(configPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, '--config', configPath], { cwd: process.cwd(), windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`daemon did not become ready; stderr: ${stderr}`));
    }, 10_000);
    const onData = (chunk) => {
      stderr += chunk.toString('utf8');
      for (const line of stderr.split('\n')) {
        if (line.trim().length === 0 || !line.includes('daemon ready')) {
          continue;
        }
        try {
          const record = JSON.parse(line);
          if (record.msg === 'daemon ready') {
            clearTimeout(timer);
            resolve({ child, record });
            return;
          }
        } catch {
          // Partial line; wait for the rest.
        }
      }
    };
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early with code ${code}; stderr: ${stderr}`));
    });
  });
}

describe('daemon CLI', () => {
  it('prints usage for --help', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /aegis-daemon/u);
    assert.match(result.stdout, /--config/u);
  });

  it('refuses to run without a data directory or configuration', async () => {
    const result = await runCli([]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--config or --data-dir is required/u);
  });

  it('refuses --data-dir without a rule pack', async () => {
    const dir = makeTempDir();
    const result = await runCli(['--data-dir', dir, '--mock']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--rules <path> is required/u);
  });

  it('rejects an invalid configuration file without starting', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'daemon.json');
    writeFileSync(configPath, JSON.stringify({
      dataDir: dir,
      mode: 'mock',
      detection: { rulePack: makeRulePack() },
      api: { host: '0.0.0.0' },
    }), 'utf8');
    const result = await runCli(['--config', configPath]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /configuration error/u);
    assert.match(result.stderr, /loopback/u);
  });

  it('starts, serves /healthz on loopback and provisions a token file', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'daemon.json');
    writeFileSync(configPath, JSON.stringify({
      dataDir: dir,
      mode: 'mock',
      detection: { rulePack: makeRulePack() },
      api: { port: 0 },
      scheduler: { tickMs: 3600000 },
      logging: { level: 'info' },
    }), 'utf8');

    const { child, record } = await startCli(configPath);
    try {
      assert.equal(record.host, '127.0.0.1');
      assert.ok(record.port > 0);
      const health = await httpRequest(record.port, '/healthz');
      assert.equal(health.status, 200);
      assert.equal(health.body.status, 'degraded', 'no sources configured is a degradation');
      assert.equal(existsSync(join(dir, 'secrets', 'api-token')), true);

      const token = readFileSync(join(dir, 'secrets', 'api-token'), 'utf8').trim();
      const status = await httpRequest(record.port, '/api/v1/status', {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(status.status, 200);
      assert.equal(status.body.lifecycle, 'running');
      assert.equal(status.body.mode, 'mock');
      assert.equal(status.text.includes(token), false, 'the token must never appear in a response');
    } finally {
      child.kill();
      await new Promise((resolve) => child.on('exit', resolve));
    }
  });
});
