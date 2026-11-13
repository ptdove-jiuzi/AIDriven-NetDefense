#!/usr/bin/env node
/**
 * run-fixture.mjs — SEED-04 part B / mutation runner.
 *
 * Spawns the real daemon (`apps/daemon/bin.js`) with the fixture collector module
 * (`fixtures/fixture-collectors.mjs`) through the documented `--collectors` seam, samples
 * `/api/v1/status`, and judges either the rejection-bubbling criteria (B) or the
 * real-run criteria (A1/A3/A5, reused for mutations M1/M3).
 *
 * Usage:
 *   node run-fixture.mjs --mode bubble --judge b    --label b-baseline  ...
 *   node run-fixture.mjs --mode legacy --judge real --label m1-control   ...
 *   node run-fixture.mjs --mode legacy --judge real --label m1-mutated   ...
 *   node run-fixture.mjs --mode stall  --judge real --label m3-stall     ...
 *
 * Exit code 0 when the judged verdict is CLOSED, 1 otherwise (mutation runs are expected
 * to be 1 — that is the proof the criterion is not vacuous).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeRealRun, judgeRejectionRun, judgeSourceRun } from './judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

function parseArgs(argv) {
  const args = {
    mode: 'bubble',
    judge: 'b',
    label: 'fixture',
    outdir: null,
    workdir: null,
    port: 19512,
    durationS: 60,
    sampleIntervalS: 5,
    note: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[index + 1];
    switch (token) {
      case '--mode': args.mode = next(); index += 1; break;
      case '--judge': args.judge = next(); index += 1; break;
      case '--label': args.label = next(); index += 1; break;
      case '--outdir': args.outdir = next(); index += 1; break;
      case '--workdir': args.workdir = next(); index += 1; break;
      case '--port': args.port = Number(next()); index += 1; break;
      case '--duration-s': args.durationS = Number(next()); index += 1; break;
      case '--sample-interval-s': args.sampleIntervalS = Number(next()); index += 1; break;
      case '--note': args.note = next(); index += 1; break;
      default: throw new Error(`unknown argument: ${token}`);
    }
  }
  if (args.outdir === null || args.workdir === null) {
    throw new Error('--outdir and --workdir are required');
  }
  if (args.port >= 17000 && args.port <= 18000) {
    throw new Error('refusing the reserved 17000-18000 range');
  }
  return args;
}

function sha256File(filePath) {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (error) {
    return `MISSING:${error?.code ?? 'ERROR'}`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(port, urlPath, token) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` },
        timeout: 20000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ http_status: response.statusCode, body_text: text, body: parsed, error: null });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('GET timeout')));
    request.on('error', (error) => resolve({ http_status: null, body_text: '', body: null, error: String(error?.message ?? error) }));
    request.end();
  });
}

function portListening(port) {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 30000 });
  return new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'iu').test(String(result.stdout ?? ''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const runDir = path.resolve(args.workdir);
  const outDir = path.resolve(args.outdir);
  const samplesDir = path.join(outDir, 'SAMPLES', args.label);
  const dataDir = path.join(runDir, 'data');
  await fsp.mkdir(samplesDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  const token = randomBytes(32).toString('base64url');
  const rulePack = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'rulepack.seed04.json'), 'utf8'));
  const configPath = path.join(runDir, 'daemon.config.json');
  const collectorsPath = path.join(runDir, 'collectors.spec.json');
  const config = {
    dataDir: dataDir.replaceAll('\\', '/'),
    mode: 'full',
    detection: { rulePack },
    api: { enabled: true, host: '127.0.0.1', port: args.port, token },
    scheduler: { tickMs: 1000, sourceTimeoutMs: 30000, maxBatchEvents: 500, staleAfterMs: 60000 },
    logging: { level: 'info' },
  };
  const collectorsSpec = {
    collectorModule: path.join(HERE, 'fixtures', 'fixture-collectors.mjs').replaceAll('\\', '/'),
    commonModule: path.join(HERE, 'fixtures', 'fixture-common.mjs').replaceAll('\\', '/'),
    createSources: 'createSources',
    attachSources: 'attachSources',
    createRuntime: 'createRuntime',
    options: { mode: args.mode },
    bootId: null,
  };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fsp.writeFile(collectorsPath, `${JSON.stringify(collectorsSpec, null, 2)}\n`, 'utf8');

  const provenance = {
    node: process.version,
    mode: args.mode,
    judge: args.judge,
    note: args.note,
    fixture_sha256: {
      'fixtures/fixture-collectors.mjs': sha256File(path.join(HERE, 'fixtures', 'fixture-collectors.mjs')),
      'fixtures/fixture-common.mjs': sha256File(path.join(HERE, 'fixtures', 'fixture-common.mjs')),
      'fixtures/rulepack.seed04.json': sha256File(path.join(HERE, 'fixtures', 'rulepack.seed04.json')),
    },
    product_sha256: {
      'apps/daemon/src/daemon.js': sha256File(path.join(REPO, 'apps/daemon/src/daemon.js')),
      'apps/daemon/src/health.js': sha256File(path.join(REPO, 'apps/daemon/src/health.js')),
      'apps/daemon/src/scheduler.js': sha256File(path.join(REPO, 'apps/daemon/src/scheduler.js')),
      'apps/daemon/src/adapters/event-store.js': sha256File(path.join(REPO, 'apps/daemon/src/adapters/event-store.js')),
      'apps/daemon/src/adapters/collector-sources.js': sha256File(path.join(REPO, 'apps/daemon/src/adapters/collector-sources.js')),
      'packages/event-store/src/ingest.js': sha256File(path.join(REPO, 'packages/event-store/src/ingest.js')),
    },
  };

  const logPath = path.join(outDir, `daemon-${args.label}.log`);
  const logFd = fs.openSync(logPath, 'a');
  fs.writeSync(logFd, `${JSON.stringify({ at: startedAt, event: 'seed04-fixture-spawn', label: args.label, mode: args.mode, port: args.port })}\n`);

  const child = spawn(
    process.execPath,
    [path.join(REPO, 'apps/daemon/bin.js'), '--config', configPath, '--collectors', collectorsPath],
    { cwd: REPO, stdio: ['ignore', logFd, logFd], windowsHide: true },
  );
  const pid = child.pid;
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal, at: new Date().toISOString() };
  });

  const readyDeadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < readyDeadline && exitInfo === null) {
    const healthz = await httpGet(args.port, '/healthz', token);
    if (healthz.http_status === 200) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready) {
    fs.writeSync(logFd, `${JSON.stringify({ at: new Date().toISOString(), event: 'seed04-fixture-not-ready', exit: exitInfo })}\n`);
    fs.closeSync(logFd);
    const result = {
      label: args.label,
      mode: args.mode,
      ready: false,
      error: 'control API did not become ready within 60s',
      child_pid: pid,
      child_exit: exitInfo,
      log_path: logPath,
      provenance,
    };
    await fsp.writeFile(path.join(outDir, `RESULT-${args.label}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`SEED04_FIXTURE_RESULT ${JSON.stringify({ label: args.label, ready: false })}\n`);
    return 2;
  }

  const samples = [];
  const startedMs = Date.now();
  const deadline = startedMs + args.durationS * 1000;
  let index = 0;
  while (Date.now() < deadline) {
    const sampledMs = Date.now();
    const status = await httpGet(args.port, '/api/v1/status', token);
    const healthz = await httpGet(args.port, '/healthz', token);
    const record = {
      index,
      t_ms: sampledMs,
      t_iso: new Date(sampledMs).toISOString(),
      offset_s: Math.round((sampledMs - startedMs) / 100) / 10,
      http_status: status.http_status,
      error: status.error,
      healthz,
      status: status.body,
    };
    if (status.body !== null) {
      await fsp.writeFile(path.join(samplesDir, `sample-${String(index).padStart(3, '0')}.json`), `${status.body_text}\n`, 'utf8');
      record.body_file = `sample-${String(index).padStart(3, '0')}.json`;
    }
    samples.push(record);
    process.stdout.write(`[${args.label} ${index}] +${record.offset_s}s health=${status.body?.health?.status ?? '?'} rejected=${status.body?.counters?.rejected_by_store ?? '?'} sources=${(status.body?.scheduler?.sources ?? []).map((source) => `${source.id}:${source.lifecycle}/${source.events}`).join(',')}\n`);
    index += 1;
    const nextDue = sampledMs + args.sampleIntervalS * 1000;
    while (Date.now() < nextDue && Date.now() < deadline) {
      await sleep(Math.min(500, nextDue - Date.now()));
    }
  }

  let killMethod = 'already-exited';
  if (exitInfo === null) {
    killMethod = 'child.kill()';
    child.kill();
    for (let waited = 0; waited < 20 && exitInfo === null; waited += 1) {
      await sleep(250);
    }
    if (exitInfo === null) {
      killMethod = 'taskkill /F /T';
      spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { encoding: 'utf8', timeout: 30000 });
      for (let waited = 0; waited < 40 && exitInfo === null; waited += 1) {
        await sleep(250);
      }
    }
  }
  let portReleased = false;
  for (let waited = 0; waited < 20; waited += 1) {
    if (!portListening(args.port)) {
      portReleased = true;
      break;
    }
    await sleep(500);
  }
  fs.writeSync(logFd, `${JSON.stringify({ at: new Date().toISOString(), event: 'seed04-fixture-stop', killMethod, exitInfo, portReleased })}\n`);
  fs.closeSync(logFd);

  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const judge = args.judge === 'b'
    ? judgeRejectionRun(samples, logText, { suspectIds: ['seed04.reject'] })
    : args.judge === 'source'
      ? judgeSourceRun(samples)
      : judgeRealRun(samples, []);
  const finishedAt = new Date().toISOString();
  const result = {
    label: args.label,
    artifact: `SEED-04 fixture run (mode=${args.mode}, judge=${args.judge})`,
    note: args.note,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_s_requested: args.durationS,
    port: args.port,
    sample_count: samples.length,
    samples_with_status: samples.filter((sample) => sample.http_status === 200).length,
    child_pid: pid,
    child_exit: exitInfo,
    kill_method: killMethod,
    port_released: portReleased,
    log_path: logPath,
    log_line_count: logText.split(/\r?\n/).filter(Boolean).length,
    last_status_excerpt: {
      health: samples[samples.length - 1]?.status?.health ?? null,
      counters: samples[samples.length - 1]?.status?.counters ?? null,
      sources: (samples[samples.length - 1]?.status?.scheduler?.sources ?? []).map((source) => ({
        id: source.id,
        lifecycle: source.lifecycle,
        events: source.events,
        accepted: source.accepted,
        failures: source.failures,
        last_error_code: source.last_error_code,
      })),
      rejected_by_store: samples[samples.length - 1]?.status?.counters?.rejected_by_store ?? null,
    },
    provenance,
    judge,
  };
  await fsp.writeFile(path.join(outDir, `RESULT-${args.label}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`SEED04_FIXTURE_RESULT ${JSON.stringify({
    label: args.label,
    mode: args.mode,
    verdict: judge.verdict,
    failed: judge.failed,
    rejected_by_store: result.last_status_excerpt.rejected_by_store,
  })}\n`);
  return judge.verdict === 'CLOSED' ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`run-fixture failed: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
