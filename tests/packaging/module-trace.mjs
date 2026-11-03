/**
 * Module-load tracer for the M8 bundle boot verification.
 *
 * The prune list claims a set of packages is never loaded. Static analysis can
 * only prove "no import edge exists"; this records what Node *actually* loaded
 * during a real `initialize`/`shutdown`, so a package that the graph missed
 * (a computed specifier, a native addon resolving a sibling, a lazily registered
 * hook) shows up and fails the assertion instead of being pruned silently.
 *
 * Loaded with `--import`, alongside the network tripwire. Records one absolute
 * path per line into `$M8_MODULE_TRACE`. It never writes to stdout or stderr: the
 * worker's control channel and the stderr contract are asserted elsewhere.
 *
 * Both module systems need patching — ESM imports do not go through
 * `Module._load`, and CJS requires do not go through the ESM loader — so this
 * file patches the former and registers hooks for the latter.
 */

import Module, { register } from 'node:module';
import { appendFileSync } from 'node:fs';

const logPath = process.env.M8_MODULE_TRACE;

function record(path) {
  if (typeof logPath !== 'string' || logPath.length === 0) return;
  try {
    appendFileSync(logPath, `${path}\n`);
  } catch {
    // A missing log must not change the behaviour under test; the caller asserts
    // the log is non-empty, so a silent failure surfaces as a failed assertion.
  }
}

const originalLoad = Module._load;
Module._load = function tracedLoad(request, parent, isMain) {
  const result = originalLoad.apply(this, arguments);
  try {
    record(Module._resolveFilename(request, parent, isMain));
  } catch {
    // Resolution failures are the worker's business, not the tracer's.
  }
  return result;
};

register('./module-trace-hooks.mjs', import.meta.url);
record(`<tracer-armed>${process.pid}`);
