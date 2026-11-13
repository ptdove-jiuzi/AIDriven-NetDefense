/**
 * windows-collector-module.mjs — host-side wiring module for `--collectors <spec>`.
 *
 * Why this file exists: `packages/collectors/windows/index.js` `attachWindowsSources()`
 * returns `{name, descriptor, collector, binding}` wrappers while the daemon adapter
 * `createCollectorDaemonSource()` expects the flat binding (`poll()` at the top level).
 * The two shapes do not line up in this tree right now (2026-11-04, A2 area).
 *
 * This module is a *host* adapter, exactly the seam `--collectors` was built for: it keeps
 * `packages/collectors/**` and `apps/daemon/src/**` untouched (neither is this task's write
 * domain) and presents the flat shape the daemon consumes. Delete it once the collector
 * module and the daemon adapter agree again.
 */

import { createWindowsSources, attachWindowsSources } from '../../../packages/collectors/windows/index.js';

export { createWindowsSources };

/** Flatten `attachWindowsSources()` wrappers into daemon bindings. */
export function attachSourcesFlat({ runtime, sources } = {}) {
  return attachWindowsSources({ runtime, sources }).map((entry) => ({
    name: entry.name,
    descriptor: entry.descriptor,
    collector: entry.collector,
    ...entry.binding,
  }));
}
