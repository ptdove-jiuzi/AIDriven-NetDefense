/**
 * @aegisharness/daemon — core control plane.
 *
 * Scope (design §3): scheduling, detection wiring, alert persistence, the
 * loopback control API, the single-writer boundary and health.
 *
 * Explicitly **not** here, and not reachable from this package's module graph:
 * process supervision, the Harness, any model or provider client, the response
 * helper, the sandbox launcher, the plugin runtime, and the UI. Removing every one
 * of those leaves this package able to collect, detect, persist and report — which
 * is exactly the invariant `AT-CORE-001` asks about.
 *
 * Reading order for a newcomer:
 *   1. `config.js` — what a legal daemon configuration is, and what is refused.
 *   2. `daemon.js` — wiring plus the shutdown order.
 *   3. `scheduler.js` → `pipeline.js` → `detection-bridge.js` — the data path.
 *   4. `api/server.js` → `api/auth.js` — the control boundary.
 */

export { DAEMON_CODES, DaemonError, isDaemonError, toDaemonError } from './errors.js';

export {
  DEFAULT_SUMMARY_FIELDS,
  DAEMON_MODES,
  LOOPBACK_HOSTS,
  assertLoopbackHost,
  loadConfig,
  loadConfigFile,
  resolveInside,
} from './config.js';

export { toIso, fromIso, createSystemClock, createManualClock, assertClock } from './clock.js';

export { createLogger, nullLogger, redact } from './log.js';

export { LIFECYCLE_STATES, createLifecycle } from './lifecycle.js';

export {
  STATE_SCHEMA_VERSION,
  atomicWriteJson,
  createEmptyState,
  createStateFile,
  normalizeState,
} from './state-store.js';

export {
  SOURCE_KINDS,
  assertSource,
  assertSources,
  createScriptedSource,
} from './adapters/collector.js';

export {
  COLLECTOR_KIND_BY_TYPE,
  COLLECTOR_SPEC_KEYS,
  EMPTY_REASONS,
  buildSourcesFromSpec,
  createBootId,
  createCollectorDaemonSource,
  createCollectorSources,
  daemonKindFor,
  emptyReasonFor,
  loadCollectorSpec,
  parseCollectorSpec,
} from './adapters/collector-sources.js';

export {
  createEventStoreAdapter,
  createMemoryEventStoreAdapter,
} from './adapters/event-store.js';

export {
  MAX_ALERT_EVENT_IDS,
  buildWritePlan,
  toDetectionBatch,
  toDetectionEvent,
} from './detection-bridge.js';

export { createPipeline } from './pipeline.js';

export { SOURCE_LIFECYCLES, createScheduler } from './scheduler.js';

export { HEALTH_LEVELS, buildStatusPayload, computeHealth, isStoreOpen } from './health.js';

export {
  CSRF_HEADER,
  MIN_TOKEN_LENGTH,
  TOKEN_PATTERN,
  createAuthGuard,
  isUsableToken,
  generateToken,
  isAllowedHost,
  isAllowedOrigin,
  provisionApiToken,
  readBearer,
  safeEqual,
} from './api/auth.js';

export { createControlApi, isLoopbackPeer } from './api/server.js';

export { DAEMON_VERSION, createDaemon } from './daemon.js';
