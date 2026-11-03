#!/usr/bin/env node
/**
 * bin.js — process entry point.
 *
 * Responsibilities, all of them boring on purpose:
 * 1. Resolve the configuration (file path or `--data-dir`).
 * 2. Install signal handlers **before** starting, so a SIGTERM during startup is
 *    not lost.
 * 3. Start; on failure exit non-zero with a code an operator can look up.
 * 4. Shut down once, on the first signal, and exit with a status that tells the
 *    service manager whether the stop was clean.
 *
 * No collector adapter is bundled: `full` mode fails closed when no source is
 * injected by the host application, because a daemon that silently collects
 * nothing would look healthy while producing no telemetry.
 *
 * Usage:
 *   node apps/daemon/bin.js --config <path>            # JSON configuration file
 *   node apps/daemon/bin.js --data-dir <path> --mock   # explicit mock mode
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createDaemon } from './src/daemon.js';
import { loadConfig } from './src/config.js';
import { createLogger } from './src/log.js';

function parseArgs(argv) {
  const args = { config: null, dataDir: null, rules: null, mock: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') {
      args.config = argv[index + 1] ?? null;
      index += 1;
    } else if (token === '--data-dir') {
      args.dataDir = argv[index + 1] ?? null;
      index += 1;
    } else if (token === '--rules') {
      args.rules = argv[index + 1] ?? null;
      index += 1;
    } else if (token === '--mock') {
      args.mock = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  return args;
}

const USAGE = `aegis-daemon — AegisHarness core daemon

  --config <path>     JSON configuration file
  --data-dir <path>   absolute data directory (when no config file is used)
  --rules <path>      rule pack JSON (required with --data-dir)
  --mock              run with the in-memory event store (no SQLite, no collectors)
  -h, --help          show this help
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let config;
  try {
    if (args.config !== null) {
      config = loadConfig(JSON.parse(readFileSync(resolve(args.config), 'utf8')));
    } else {
      if (args.dataDir === null) {
        process.stderr.write('aegis-daemon: --config or --data-dir is required\n');
        process.exitCode = 2;
        return 2;
      }
      if (args.rules === null) {
        // No implicit rule pack: a daemon with no rules would report healthy while
        // detecting nothing.
        process.stderr.write('aegis-daemon: --rules <path> is required with --data-dir\n');
        process.exitCode = 2;
        return 2;
      }
      config = loadConfig({
        dataDir: resolve(args.dataDir),
        mode: args.mock ? 'mock' : 'full',
        detection: { rulePackPath: resolve(args.rules) },
      });
    }
  } catch (error) {
    process.stderr.write(`aegis-daemon: configuration error: ${error.message}\n`);
    process.exitCode = 2;
    return 2;
  }

  const logger = createLogger({ level: config.logging.level });
  const daemon = createDaemon({ config, logger });

  let exiting = false;
  const onSignal = (signal) => {
    if (exiting) {
      logger.warn('second signal received; shutdown already in progress', { signal });
      return;
    }
    exiting = true;
    logger.info('signal received', { signal });
    daemon.shutdown(signal).then((result) => {
      const failures = result.errors.length;
      process.exit(failures === 0 ? 0 : 1);
    }).catch(() => process.exit(1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const started = await daemon.start();
    logger.info('daemon ready', {
      epoch: started.epoch,
      host: started.address?.host ?? null,
      port: started.address?.port ?? null,
    });
  } catch (error) {
    logger.error('daemon failed to start', { code: error.code ?? 'START_FAILED', message: error.message });
    process.exitCode = 1;
    return 1;
  }

  // Stay alive: the scheduler and the API hold the work. Nothing else is needed.
  await new Promise(() => {});
  return 0;
}

main().catch((error) => {
  process.stderr.write(`aegis-daemon: fatal: ${error?.message ?? 'unknown'}\n`);
  process.exit(1);
});
