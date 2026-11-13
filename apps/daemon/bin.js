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
 * ## Collector sources (`--collectors`)
 *
 * `full` mode fails closed when no collector source is injected, because a daemon that
 * silently collects nothing would look healthy while producing no telemetry. Until now
 * the only way to inject sources was to write a host application (`apps/service-host`),
 * which meant the payload's own entry point could never leave `mock` mode
 * (COLLECTOR-LIVE §2). `--collectors <path>` closes that gap without teaching the daemon
 * any platform: the file names the collector module and the wiring entry points, the
 * mapping itself lives in `src/adapters/collector-sources.js`, and the module is imported
 * dynamically at start (A2-SHAPE §5).
 *
 * Usage:
 *   node apps/daemon/bin.js --config <path> [--collectors <path>]
 *   node apps/daemon/bin.js --data-dir <path> --rules <path> --mock
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDaemon } from './src/daemon.js';
import { loadCollectorSpec, buildSourcesFromSpec } from './src/adapters/collector-sources.js';
import { loadConfig } from './src/config.js';
import { createLogger } from './src/log.js';

function parseArgs(argv) {
  const args = { config: null, dataDir: null, rules: null, collectors: null, mock: false, help: false };
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
    } else if (token === '--collectors') {
      args.collectors = argv[index + 1] ?? null;
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

  --config <path>       JSON configuration file
  --data-dir <path>     absolute data directory (when no config file is used)
  --rules <path>        rule pack JSON (required with --data-dir)
  --collectors <path>   collector spec JSON: the module and entry points that produce
                        the daemon's sources (required for full mode)
  --mock                run with the in-memory event store (no SQLite, no collectors)
  -h, --help            show this help
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

  // --- collector wiring ---------------------------------------------------
  let sources = [];
  if (args.collectors !== null) {
    try {
      const spec = loadCollectorSpec(args.collectors);
      const wiring = await buildSourcesFromSpec(spec, { logger });
      sources = [...wiring.sources];
      const wired = sources.map((source) => `${source.id}(${source.kind})`).join(', ');
      logger.info('collector sources wired', {
        count: sources.length,
        boot_id: wiring.bootId,
        sources: wired,
      });
    } catch (error) {
      logger.error('collector wiring failed', { code: error?.code ?? 'COLLECTOR_WIRING_FAILED', message: error?.message });
      process.stderr.write(`aegis-daemon: collector wiring failed: ${error?.message ?? error}\n`);
      process.exitCode = 1;
      return 1;
    }
  } else if (config.mode === 'full') {
    // Say what is missing instead of leaving the operator with the generic fail-closed
    // message: the payload's hand-written argv previously had no way to pass sources.
    logger.info('no collector sources were injected', { hint: 'pass --collectors <path> to run full mode' });
  }

  const daemon = createDaemon({ config, logger, sources });

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

/** Only run when executed as a program: tests import this module for `parseArgs`. */
export function isMainModule() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

export { parseArgs, main };

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`aegis-daemon: fatal: ${error?.message ?? 'unknown'}\n`);
    process.exit(1);
  });
}

