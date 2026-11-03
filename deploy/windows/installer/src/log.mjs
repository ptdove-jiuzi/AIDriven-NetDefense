/**
 * log.mjs — installer log.
 *
 * Two sinks: a human line on stdout/stderr, and an append-only file when `/log`
 * was given. The file is the evidence artifact, so it records the phase, the exit
 * code and the concrete paths, and it must never contain the API token (ADR §5.1:
 * only the token length and the first 8 characters of its digest are logged).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * @param {{ logPath?: string|null, echo?: boolean, stdout?: NodeJS.WritableStream }} [options]
 */
export function createLogger({ logPath = null, echo = true, stdout = process.stdout } = {}) {
  if (logPath !== null) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, '', 'utf8');
  }

  const write = (level, message, details) => {
    const suffix = details === undefined || details === null
      ? ''
      : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
    if (logPath !== null) {
      appendFileSync(logPath, `${line}\n`, 'utf8');
    }
    if (echo) {
      stdout.write(`${line}\n`);
    }
  };

  const logger = { path: logPath };
  for (const level of LEVELS) {
    logger[level] = (message, details) => write(level, message, details);
  }
  return logger;
}
