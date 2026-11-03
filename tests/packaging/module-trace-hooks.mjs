/**
 * ESM resolve hook that records every module URL the worker resolves.
 *
 * Runs on the loader thread; the log path comes from the same environment the
 * tracer used. `file:` URLs are recorded as plain paths so the caller can map
 * them back to packages without a second transformation.
 */

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const logPath = process.env.M8_MODULE_TRACE;

function record(url) {
  if (typeof logPath !== 'string' || logPath.length === 0) return;
  if (typeof url !== 'string' || !url.startsWith('file:')) return;
  try {
    appendFileSync(logPath, `${fileURLToPath(url)}\n`);
  } catch {
    // Ignored on purpose: the caller asserts the log exists and is non-empty.
  }
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  record(result.url);
  return result;
}
