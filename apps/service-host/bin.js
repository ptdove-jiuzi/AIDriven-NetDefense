#!/usr/bin/env node
/**
 * bin.js — the Windows service host application (P2).
 *
 * This process is what `aegis-svc.exe` spawns. It is the "host application" that
 * `apps/daemon/bin.js` is not: it injects the collector sources the daemon refuses to
 * invent for itself, and it speaks the two-line control protocol the SCM shim needs.
 *
 * Process contract (see `src/control-channel.mjs`, mirrored by `src/supervisor.mjs`):
 *
 *   stdout  {"event":"ready","port":8787,"pid":1234}   once, after the API is serving
 *   stdin   {"cmd":"stop"}                             graceful stop request
 *   exit    0 = clean stop, 1 = startup or shutdown failure
 *
 * Everything the daemon logs still goes to stderr, so stdout carries control messages
 * only — a log line in the middle of the handshake would be a protocol bug.
 *
 * Usage:
 *   node apps/service-host/bin.js --config <path>
 *   node apps/service-host/bin.js --config <path> --dry-run
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDaemon } from '../daemon/src/daemon.js';
import { loadConfig } from '../daemon/src/config.js';
import { createLogger } from '../daemon/src/log.js';

import { encodeControl, parseControlLine, readLines, readyEvent } from './src/control-channel.mjs';
import { buildSources } from './src/sources.mjs';

const USAGE = `aegis-service-host — ${'AIDriven NetDefense'} 服务宿主

  --config <path>   守护进程配置（必填）
  --dry-run         只校验配置与采集源装配，不启动守护进程
  -h, --help        显示帮助
`;

export function parseHostArgs(argv) {
  const args = { config: null, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') {
      args.config = argv[index + 1] ?? null;
      index += 1;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      throw new Error(`无法识别的参数：${token}`);
    }
  }
  return args;
}

/**
 * @param {readonly string[]} argv
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, stdin?: NodeJS.ReadableStream }} [io]
 * @returns {Promise<number>}
 */
export async function runHost(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;

  let args;
  try {
    args = parseHostArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (args.config === null) {
    stderr.write(`缺少 --config\n\n${USAGE}`);
    return 1;
  }

  let config;
  try {
    config = loadConfig(JSON.parse(readFileSync(resolve(args.config), 'utf8')));
  } catch (error) {
    stderr.write(`aegis-service-host: 配置无效：${error.message}\n`);
    return 1;
  }

  let sources;
  try {
    sources = await buildSources();
  } catch (error) {
    stderr.write(`aegis-service-host: 采集源装配失败：${error.message}\n`);
    return 1;
  }
  if (sources.sources.length === 0) {
    stderr.write(`aegis-service-host: ${sources.reason}\n`);
    if (!args.dryRun) return 1;
  }
  for (const note of sources.notes ?? []) stderr.write(`aegis-service-host: 注意：${note}\n`);

  if (args.dryRun) {
    stdout.write(`${encodeControl({
      event: 'dry-run',
      dataDir: config.dataDir,
      mode: config.mode,
      apiPort: config.api.port,
      sources: sources.sources.map((entry) => entry.name),
    })}`);
    return 0;
  }

  const logger = createLogger({ level: config.logging.level });
  const daemon = createDaemon({ config, logger, sources: sources.sources });

  let started;
  try {
    started = await daemon.start();
  } catch (error) {
    stderr.write(`aegis-service-host: 守护进程启动失败：${error.message}\n`);
    return 1;
  }

  stdout.write(`${encodeControl(readyEvent({ port: started.address?.port ?? config.api.port, pid: process.pid }))}`);

  let stopping = false;
  let detachStdin = () => {};
  let resolveExit;
  const exited = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });

  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    stdout.write(`${encodeControl({ event: 'stopping', reason })}`);
    try {
      const result = await daemon.shutdown(reason);
      process.exitCode = result.errors.length === 0 ? 0 : 1;
    } catch {
      process.exitCode = 1;
    } finally {
      // The stdin reader keeps the event loop alive; drop it so the process can exit.
      detachStdin();
      resolveExit(process.exitCode ?? 0);
    }
  };

  detachStdin = readLines(stdin, (line) => {
    const message = parseControlLine(line);
    if (message !== null && message.kind === 'command' && message.cmd === 'stop') {
      void shutdown(message.payload.reason ?? 'service-stop');
    }
  });

  process.on('SIGTERM', () => void shutdown('sigterm'));
  process.on('SIGINT', () => void shutdown('sigint'));

  // Resolve only when the daemon has actually stopped, so the SCM sees a clean exit code.
  return exited;
}

/** True only when this file is the process entry point (Windows-safe comparison). */
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runHost(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`aegis-service-host: 致命错误：${error?.message ?? 'unknown'}\n`);
    process.exitCode = 1;
  });
}
