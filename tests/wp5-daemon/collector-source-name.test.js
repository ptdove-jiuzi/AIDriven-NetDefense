/**
 * collector-source-name.test.js — the wiring layer must not drop the collector's name.
 *
 * `attachWindowsSources` (after the D3 fix) returns a **flat** object: the binding's
 * `poll()` is at the top level, next to `name` / `descriptor` / `collector` / `binding`.
 * `createCollectorSources()` classifies that as the flat branch, and the branch used to
 * hard-code `name: null` — so `service-host --dry-run` reported `sources: [null ×9]`
 * (BUG-LEDGER R3-003 shape regression). The name is a diagnostic label the host prints;
 * it must survive on the flat contract, while a bare binding (which has no name) must
 * still report `null` instead of inventing one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCollectorSources } from '../../apps/daemon/src/adapters/collector-sources.js';

const BOOT_ID = '0123456789abcdef0123456789abcdef';

/** A collector binding as `createSourceBinding()` returns it. */
function makeBinding(name) {
  const descriptor = Object.freeze({
    stableSourceId: `windows.${name}`,
    kind: 'poll',
    intervalMs: 30_000,
  });
  const collector = Object.freeze({
    identity: () => ({ cursor: null, generation: 0, sequence: 0 }),
  });
  return Object.freeze({
    descriptor,
    collector,
    poll: async () => ({ ok: true, published: 0, empty: true, items: [] }),
  });
}

/** D3 flat shape: `{ name, ...binding, descriptor, collector, binding }`. */
function flatAttached(name) {
  const binding = makeBinding(name);
  return Object.freeze({
    name,
    ...binding,
    descriptor: binding.descriptor,
    collector: binding.collector,
    binding,
  });
}

/** Legacy wrapper shape: `{ name, descriptor, collector, binding }` without top-level poll. */
function wrappedAttached(name) {
  const binding = makeBinding(name);
  return Object.freeze({
    name,
    descriptor: binding.descriptor,
    collector: binding.collector,
    binding,
  });
}

/** Wire one attach result through the real `createCollectorSources()`. */
function wire(attached) {
  return createCollectorSources({
    createSources: () => Object.freeze([{ name: 'declared', source: {} }]),
    createRuntime: () => ({}),
    attachSources: () => Object.freeze(attached),
    cursorStore: {},
    bootId: BOOT_ID,
  });
}

describe('collector source wiring keeps the collector name (R3-003 regression)', () => {
  it('keeps the name of a flat D3 wrapper (top-level poll + name)', () => {
    const wired = wire([flatAttached('processes')]);
    assert.equal(wired.sources.length, 1);
    assert.equal(wired.sources[0].id, 'windows.processes');
    assert.equal(wired.sources[0].name, 'processes', 'the flat branch must inherit entry.name');
  });

  it('keeps every name of a multi-source flat assembly', () => {
    const names = ['processes', 'connections', 'eventLog:Security'];
    const wired = wire(names.map((name) => flatAttached(name)));
    assert.deepEqual(wired.sources.map((source) => source.name), names);
  });

  it('still keeps the name of the legacy wrapper shape', () => {
    const wired = wire([wrappedAttached('eventLog:System')]);
    assert.equal(wired.sources[0].name, 'eventLog:System');
  });

  it('reports null for a bare binding that has no name', () => {
    const wired = wire([makeBinding('directories')]);
    assert.equal(wired.sources[0].id, 'windows.directories');
    assert.equal(wired.sources[0].name, null, 'a bare binding must not invent a name');
  });
});
