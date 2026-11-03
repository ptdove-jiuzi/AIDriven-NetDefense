/**
 * Public surface of @aegisharness/collector-common.
 *
 * Platform adapters (Windows event log, journald, procfs, file watchers) are out of scope
 * here: this package only holds the platform-neutral identity, cursor, dedupe,
 * backpressure, gap and capability logic they share.
 */

export * from './capability.js';
export * from './cursor-store.js';
export * from './dedupe-window.js';
export * from './errors.js';
export * from './event-queue.js';
export * from './events.js';
export * from './gap-ledger.js';
export * from './generation.js';
export * from './ids.js';
export * from './limits.js';
export * from './rate-limiter.js';
export * from './runtime.js';
export * from './source-collector.js';
