#!/usr/bin/env node
import { join } from 'node:path';
import {
  preflightWorker,
  PROFILE_SOURCE,
  readJson,
} from '@aegisharness/harness-adapter';

try {
  const approved = readJson(join(PROFILE_SOURCE, 'approved-hashes.json'));
  const profileDir = join(process.env.DSH_HOME ?? '', 'profiles', 'aegis-analysis');
  preflightWorker({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    profileDir,
    toolsDir: join(profileDir, 'node_modules', '@aegisharness', 'dsh-defense-tools'),
    approved,
  });
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js');
  await runCli();
} catch (error) {
  const message = `aegis-harness-worker: ${error?.message ?? String(error)}\n`;
  process.stderr.write(message.slice(0, 4096));
  process.exitCode = 1;
}
