#!/usr/bin/env node
/**
 * bin.js — process wrapper.
 *
 * Everything interesting is in `src/main.js`; this file only decides the process exit
 * status and keeps a closed pipe from turning a successful query into a crash. `head`
 * and `less` close stdout early, and Node surfaces that as an `EPIPE` write error —
 * which is normal, not a failure of the command.
 */

import { run } from './src/main.js';

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') {
    return;
  }
  throw error;
});
process.stderr.on('error', (error) => {
  if (error?.code === 'EPIPE') {
    return;
  }
  throw error;
});

const exitCode = await run(process.argv.slice(2));
process.exitCode = exitCode;
