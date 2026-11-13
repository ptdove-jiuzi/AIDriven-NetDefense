/**
 * fixture-collectors.mjs — SEED-04 part B `--collectors` fixture module.
 *
 * This module is loaded by the daemon through its documented `--collectors` seam
 * (`apps/daemon/bin.js` → `adapters/collector-sources.js`), so the daemon is running
 * its **real** ingestion pipeline, real contract validation and the real SQLite store.
 * Only the source of the events is synthetic.
 *
 * Modes (`SEED04_FIXTURE_MODE`, or `options.mode` in the collectors spec):
 *
 *   bubble  (default)  one honest source (`seed04.legit`) + one source whose event is
 *                      *guaranteed* to be rejected by `packages/event-store`
 *                      (`seed04.reject`, integrity digest that cannot match the payload).
 *                      Used by the B criterion: rejection must surface, not be swallowed.
 *   legacy             one honest source + one source that returns zero events with a
 *                      *valid* `{ok:true, published:0}` shape. With today's honest
 *                      projection the daemon reports it as `empty`; with the old
 *                      "0 条却 ok" behaviour (mutation M1 removes the projection) it is
 *                      reported as `ok` with events=0 — the judge must turn red.
 *   stall              one honest source that emits two events and then goes silent.
 *                      Used by mutation M3: the "store.events must keep growing"
 *                      criterion must turn red when the stream stops.
 *
 * Event construction deliberately reuses `createEventFactory` from
 * `packages/collectors/common/events.js` so the *valid* events are exactly the shape a
 * real collector emits; the rejection is produced by taking such an event and
 * corrupting `integrity.digest` to 64 zeros, which the store rejects with
 * `ERR_INTEGRITY_DIGEST_MISMATCH` (packages/contracts/src/objects/telemetry-event.js:138-146).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
const COMMON_EVENTS = pathToFileURL(path.join(REPO, 'packages/collectors/common/events.js')).href;
const { createEventFactory } = await import(COMMON_EVENTS);

const ZERO_DIGEST = '0'.repeat(64);

function modeOf(options) {
  return (options?.mode ?? process.env.SEED04_FIXTURE_MODE ?? 'bubble');
}

/** Declare the logical sources for the requested mode. */
export function createSources(options = {}) {
  const mode = modeOf(options);
  // In `stall` mode the honest source itself is the one that goes silent after two polls.
  const declared = [{ name: 'seed04.legit', mode: mode === 'stall' ? 'stall' : 'legit' }];
  if (mode === 'legacy') {
    declared.push({ name: 'seed04.quiet', mode: 'quiet' });
  } else if (mode !== 'stall') {
    declared.push({ name: 'seed04.reject', mode: 'reject' });
  }
  return declared;
}

/**
 * Build daemon bindings. The daemon seam accepts either a flat binding or a
 * `{name, binding}` wrapper; both are produced here (flat fields first, then `binding`)
 * so the fixture cannot accidentally depend on only one accepted shape.
 */
export function attachSources({ runtime, sources } = {}) {
  const bootId = runtime?.bootId ?? null;
  let sequence = 0;
  let stallPolls = 0;
  const factory = createEventFactory({
    clock: () => Date.now(),
    idFactory: randomUUID,
    bootId,
  });

  function nextEvent({ stableSourceId, type, payload, nativeRecordId, generation = 0 }) {
    sequence += 1;
    return factory.create({
      stableSourceId,
      collectorInstanceId: randomUUID(),
      generation,
      sequence,
      type,
      severity: 'info',
      payload,
      ...(nativeRecordId === undefined ? {} : { nativeRecordId }),
    });
  }

  return (sources ?? []).map((entry) => {
    const name = entry.name ?? 'seed04.unknown';
    const mode = entry.mode ?? 'legit';
    const stableSourceId = name;
    const descriptor = {
      stableSourceId,
      type: 'windows.process',
      intervalMs: null,
    };
    const binding = {
      descriptor,
      async poll() {
        if (mode === 'reject') {
          const valid = nextEvent({
            stableSourceId,
            type: 'windows.process',
            payload: { process_name: 'seed04-fixture.exe', pid: 4242, computer: 'seed04' },
          });
          // Corrupt only the integrity digest: every other field stays contract-valid, so
          // the only possible rejection reason is the digest check inside the store.
          const rejected = { ...valid, integrity: { algorithm: 'sha256', digest: ZERO_DIGEST } };
          return { ok: true, items: [{ outcome: 'published', event: rejected }], published: 1, duplicates: 0, dropped: 0 };
        }
        if (mode === 'quiet') {
          return { ok: true, items: [], published: 0, duplicates: 0, dropped: 0, snapshot: false };
        }
        if (mode === 'stall') {
          stallPolls += 1;
          if (stallPolls > 2) {
            return { ok: true, items: [], published: 0, duplicates: 0, dropped: 0, snapshot: false };
          }
        }
        const event = nextEvent({
          stableSourceId,
          type: 'windows.process',
          payload: { process_name: 'seed04-fixture.exe', pid: 4242, computer: 'seed04' },
        });
        return { ok: true, items: [{ outcome: 'published', event }], published: 1, duplicates: 0, dropped: 0 };
      },
    };
    return { name, descriptor, collector: null, binding, ...binding };
  });
}
