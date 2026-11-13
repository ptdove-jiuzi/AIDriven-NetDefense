#!/usr/bin/env node
/**
 * run-real-sources.mjs — SEED-04 part A: 10-minute `full` mode run against the real
 * Windows collector sources, with independent sampling and an independent SQLite read.
 *
 * What this script does (all of it is *our own* execution, no self-report consumed):
 *   1. Builds its own daemon config + `--collectors` spec inside a caller-chosen work
 *      directory (never inside the repository).
 *   2. Spawns `node apps/daemon/bin.js --config <cfg> --collectors <spec>` detached from
 *      the caller, with stdout/stderr redirected to a raw log file.
 *   3. Samples `GET /api/v1/status` (bearer auth) every `--sample-interval-s` seconds for
 *      the whole window; every response body is written verbatim to
 *      `<outdir>/SAMPLES/<label>/sample-NNN.json`.
 *   4. At every sample also runs db-probe.py against the live SQLite file (read-only,
 *      independent of the product's own driver) and records the raw JSON.
 *   5. Stops the daemon, verifies the port is released, runs judge.mjs over the raw
 *      artefacts and writes `<outdir>/RESULT-<label>.json`.
 *
 * Usage:
 *   node tests/security/reattack-rc4/seed04/run-real-sources.mjs \
 *     --outdir  docs/implementation/evidence/review/reattack-rc4/seed04 \
 *     --workdir "%TEMP%\reattack-rc4-seed04\run-a" \
 *     --port 19511 --duration-s 620 --sample-interval-s 30 --label run-a
 *
 * Exit code: 0 when the run completed and was judged CLOSED, 1 otherwise. The result
 * file is written either way.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeRealRun } from './judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const PYTHON = process.env.SEED04_PYTHON ?? 'D:\\Python311\\python.exe';
const DB_PROBE = path.join(HERE, 'db-probe.py');

function parseArgs(argv) {
  const args = {
    outdir: null,
    workdir: null,
    port: 19511,
    durationS: 620,
    sampleIntervalS: 30,
    label: 'run-a',
    node: process.execPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[index + 1];
    switch (token) {
      case '--outdir': args.outdir = next(); index += 1; break;
      case '--workdir': args.workdir = next(); index += 1; break;
      case '--port': args.port = Number(next()); index += 1; break;
      case '--duration-s': args.durationS = Number(next()); index += 1; break;
      case '--sample-interval-s': args.sampleIntervalS = Number(next()); index += 1; break;
      case '--label': args.label = next(); index += 1; break;
      case '--node': args.node = next(); index += 1; break;
      default: throw new Error(`unknown argument: ${token}`);
    }
  }
  if (args.outdir === null || args.workdir === null) {
    throw new Error('--outdir and --workdir are required');
  }
  if (!(args.port >= 1024 && args.port <= 65535) || (args.port >= 17000 && args.port <= 18000)) {
    throw new Error(`refusing to use port ${args.port} (17000-18000 is someone else's stack)`);
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
        headers: {
          authorization: `Bearer ${token}`,
          host: `127.0.0.1:${port}`,
        },
        timeout: 30000,
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
    request.on('timeout', () => {
      request.destroy(new Error('GET timeout'));
    });
    request.on('error', (error) => {
      resolve({ http_status: null, body_text: '', body: null, error: String(error?.message ?? error) });
    });
    request.end();
  });
}

/** Independent read-only SQLite probe; retried because the daemon may be committing. */
function probeDatabase(dbPath) {
  const startedMs = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(PYTHON, [DB_PROBE, dbPath], { encoding: 'utf8', timeout: 30000 });
    const text = String(result.stdout ?? '').trim();
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop());
        if (parsed.ok === true || attempt === 3) {
          return { ...parsed, t_ms: startedMs, t_iso: new Date(startedMs).toISOString(), attempts: attempt };
        }
        lastError = parsed.error ?? 'probe not ok';
      } catch (error) {
        lastError = `unparseable probe output: ${text.slice(0, 200)}`;
      }
    } else {
      lastError = String(result.stderr ?? '').trim().slice(0, 300) || 'empty probe output';
    }
    spawnSync(PYTHON, ['-c', 'import time; time.sleep(0.4)'], { timeout: 5000 });
  }
  return {
    ok: false,
    db_path: dbPath,
    error: lastError,
    t_ms: startedMs,
    t_iso: new Date(startedMs).toISOString(),
    attempts: 3,
  };
}

function portListening(port) {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 30000 });
  const text = String(result.stdout ?? '');
  const pattern = new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'iu');
  return pattern.test(text);
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
  await fsp.mkdir(outDir, { recursive: true });

  const token = randomBytes(32).toString('base64url');
  const rulePack = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'rulepack.seed04.json'), 'utf8'));
  const configPath = path.join(runDir, 'daemon.config.json');
  const collectorsPath = path.join(runDir, 'collectors.spec.json');
  const config = {
    dataDir: dataDir.replaceAll('\\', '/'),
    mode: 'full',
    detection: { rulePack },
    api: { enabled: true, host: '127.0.0.1', port: args.port, token },
    scheduler: { tickMs: 1000, sourceTimeoutMs: 90000, maxBatchEvents: 500, staleAfterMs: 60000 },
    logging: { level: 'info' },
  };
  const collectorsSpec = {
    collectorModule: path.join(REPO, 'packages', 'collectors', 'windows', 'index.js').replaceAll('\\', '/'),
    commonModule: path.join(REPO, 'packages', 'collectors', 'common', 'index.js').replaceAll('\\', '/'),
    createSources: 'createWindowsSources',
    attachSources: 'attachWindowsSources',
    createRuntime: 'createCollectorRuntime',
    options: {
      include: ['processes', 'services', 'scheduledTasks', 'runKeys', 'eventLog', 'directories'],
      channels: ['System'],
      roots: ['C:\\Program Files', 'C:\\ProgramData'],
      timeoutMs: 90000,
    },
    bootId: null,
  };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fsp.writeFile(collectorsPath, `${JSON.stringify(collectorsSpec, null, 2)}\n`, 'utf8');

  const provenance = {
    node: process.version,
    node_executable: args.node,
    platform: process.platform,
    repo_root: REPO,
    config_sha256: sha256File(configPath),
    collectors_sha256: sha256File(collectorsPath),
    product_sha256: {
      'apps/daemon/bin.js': sha256File(path.join(REPO, 'apps/daemon/bin.js')),
      'apps/daemon/src/daemon.js': sha256File(path.join(REPO, 'apps/daemon/src/daemon.js')),
      'apps/daemon/src/health.js': sha256File(path.join(REPO, 'apps/daemon/src/health.js')),
      'apps/daemon/src/scheduler.js': sha256File(path.join(REPO, 'apps/daemon/src/scheduler.js')),
      'apps/daemon/src/pipeline.js': sha256File(path.join(REPO, 'apps/daemon/src/pipeline.js')),
      'apps/daemon/src/adapters/event-store.js': sha256File(path.join(REPO, 'apps/daemon/src/adapters/event-store.js')),
      'apps/daemon/src/adapters/collector-sources.js': sha256File(path.join(REPO, 'apps/daemon/src/adapters/collector-sources.js')),
      'packages/collectors/windows/index.js': sha256File(path.join(REPO, 'packages/collectors/windows/index.js')),
      'packages/event-store/src/ingest.js': sha256File(path.join(REPO, 'packages/event-store/src/ingest.js')),
    },
  };

  const logPath = path.join(outDir, `daemon-${args.label}.log`);
  const logFd = fs.openSync(logPath, 'a');
  fs.writeSync(logFd, `${JSON.stringify({ at: new Date().toISOString(), event: 'seed04-spawn', label: args.label, port: args.port, configPath, collectorsPath })}\n`);

  const child = spawn(
    args.node,
    [path.join(REPO, 'apps/daemon/bin.js'), '--config', configPath, '--collectors', collectorsPath],
    {
      cwd: REPO,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    },
  );
  const pid = child.pid;
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal, at: new Date().toISOString() };
  });

  // --- wait for the control API ------------------------------------------------
  const readyDeadline = Date.now() + 180000;
  let ready = false;
  let lastHealthz = null;
  while (Date.now() < readyDeadline) {
    if (exitInfo !== null) {
      break;
    }
    lastHealthz = await httpGet(args.port, '/healthz', token);
    if (lastHealthz.http_status === 200) {
      ready = true;
      break;
    }
    await sleep(2000);
  }
  const readyAt = new Date().toISOString();
  if (!ready) {
    fs.writeSync(logFd, `${JSON.stringify({ at: readyAt, event: 'seed04-not-ready', exit: exitInfo, lastHealthz })}\n`);
    fs.closeSync(logFd);
    const result = {
      label: args.label,
      started_at: startedAt,
      ready: false,
      error: 'control API did not become ready within 180s',
      child_pid: pid,
      child_exit: exitInfo,
      log_path: logPath,
      provenance,
    };
    await fsp.writeFile(path.join(outDir, `RESULT-${args.label}.json`), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`SEED04_RESULT ${JSON.stringify({ label: args.label, verdict: 'unreproducible', error: result.error })}\n`);
    return 1;
  }

  // --- sampling loop -----------------------------------------------------------
  const samples = [];
  const dbReads = [];
  const dbPath = path.join(dataDir, 'store', 'aegis.db');
  const startedMs = Date.now();
  const deadline = startedMs + args.durationS * 1000;
  let index = 0;
  while (Date.now() < deadline) {
    const sampledMs = Date.now();
    const sampledIso = new Date(sampledMs).toISOString();
    const status = await httpGet(args.port, '/api/v1/status', token);
    const healthz = await httpGet(args.port, '/healthz', token);
    const sampleFile = path.join(samplesDir, `sample-${String(index).padStart(3, '0')}.json`);
    const record = {
      index,
      t_ms: sampledMs,
      t_iso: sampledIso,
      offset_s: Math.round((sampledMs - startedMs) / 100) / 10,
      http_status: status.http_status,
      error: status.error,
      healthz,
    };
    if (status.body !== null) {
      // Raw body verbatim: the evidence is what the API said, byte for byte.
      await fsp.writeFile(sampleFile, `${status.body_text}\n`, 'utf8');
      record.body_file = path.basename(sampleFile);
    }
    samples.push({ ...record, status: status.body });

    const probe = probeDatabase(dbPath);
    dbReads.push({ ...probe, index });
    await fsp.writeFile(
      path.join(samplesDir, `db-probe-${String(index).padStart(3, '0')}.json`),
      `${JSON.stringify(probe)}\n`,
      'utf8',
    );

    process.stdout.write(`[sample ${index}] +${record.offset_s}s http=${status.http_status} health=${status.body?.health?.status ?? '?'} events=${status.body?.store?.events ?? '?'} rejected=${status.body?.counters?.rejected_by_store ?? '?'} db=${probe.ok ? probe.count : `ERR:${probe.error}`}\n`);

    index += 1;
    const nextDue = sampledMs + args.sampleIntervalS * 1000;
    while (Date.now() < nextDue && Date.now() < deadline) {
      await sleep(Math.min(1000, nextDue - Date.now()));
    }
  }

  // --- stop the daemon ---------------------------------------------------------
  const stopAt = new Date().toISOString();
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
  fs.writeSync(logFd, `${JSON.stringify({ at: new Date().toISOString(), event: 'seed04-stop', killMethod, exitInfo, portReleased })}\n`);
  fs.closeSync(logFd);

  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const judge = judgeRealRun(samples, dbReads);
  const finishedAt = new Date().toISOString();
  const result = {
    label: args.label,
    artifact: 'SEED-04/A real-source 10-minute run',
    started_at: startedAt,
    ready_at: readyAt,
    finished_at: finishedAt,
    stop_at: stopAt,
    duration_s_requested: args.durationS,
    duration_s_actual: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 100) / 10,
    port: args.port,
    sample_interval_s: args.sampleIntervalS,
    sample_count: samples.length,
    samples_with_status: samples.filter((sample) => sample.http_status === 200).length,
    db_probe_count: dbReads.length,
    db_probe_ok: dbReads.filter((probe) => probe.ok === true).length,
    child_pid: pid,
    child_exit: exitInfo,
    kill_method: killMethod,
    port_released: portReleased,
    log_path: logPath,
    log_line_count: logText.split(/\r?\n/).filter(Boolean).length,
    provenance,
    judge,
  };
  await fsp.writeFile(path.join(outDir, `RESULT-${args.label}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`SEED04_RESULT ${JSON.stringify({
    label: args.label,
    verdict: judge.verdict,
    failed: judge.failed,
    sample_count: samples.length,
    last_store_events: samples[samples.length - 1]?.status?.store?.events ?? null,
  })}\n`);
  return judge.verdict === 'CLOSED' ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`run-real-sources failed: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
