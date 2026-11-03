/**
 * harness-absence.test.js — AT-CORE-001, statically and at runtime.
 *
 * The requirement is that the core keeps working with the Harness "completely
 * removed": no package, no credentials, no DSH_HOME. A behavioural test alone
 * cannot prove that, because the code could still depend on the Harness being
 * present and merely not notice in a happy path. So this file does three things:
 *
 * 1. **Scans the daemon source** for any import or reference to the Harness, the
 *    model broker, the sandbox launcher, the response helper or the plugin runtime.
 * 2. **Scans for outbound-network primitives** — the daemon serves on loopback and
 *    must never dial out.
 * 3. **Runs the whole core path** (collect → detect → alert → persist → status) with
 *    none of those components installed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createDaemon } from '../../apps/daemon/src/daemon.js';
import { createScriptedSource } from '../../apps/daemon/src/adapters/collector.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { BASE_MS, httpRequest, makeConfig, makeEvent, makeTempDir, TEST_TOKEN, waitFor } from './helpers.js';

const DAEMON_ROOT = join(process.cwd(), 'apps', 'daemon');

/** Collect every JavaScript source file of the daemon, excluding this file's own tree. */
function daemonSources() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith('.js') || full.endsWith('.json')) {
        files.push(full);
      }
    }
  };
  walk(DAEMON_ROOT);
  return files;
}

const FORBIDDEN_MODULES = [
  '@deepseek-ai/dsh',
  'harness-adapter',
  'dsh-defense-profile',
  'dsh-defense-tools',
  'model-broker',
  'response-helper',
  'sandbox-launcher',
  'plugin-manager',
  'harness-worker',
];

describe('daemon source has no Harness or response dependency', () => {
  it('imports nothing from the Harness, broker, sandbox, helper or plugin runtime', () => {
    const offenders = [];
    for (const file of daemonSources()) {
      if (file.endsWith('package.json')) {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      for (const module of FORBIDDEN_MODULES) {
        // Match an import/require of the module, not a mention in a comment.
        const pattern = new RegExp(`(?:from|require\\()\\s*['"][^'"]*${module.replace(/[/.]/gu, '\\$&')}`, 'u');
        if (pattern.test(text)) {
          offenders.push(`${relative(process.cwd(), file)} → ${module}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'the core must not depend on optional components');
  });

  it('declares only the core workspace dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(DAEMON_ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
      '@aegisharness/contracts',
      '@aegisharness/detection',
      '@aegisharness/event-store',
    ]);
    assert.equal(manifest.author, 'PT-dove');
  });

  it('has no outbound network or process-spawning primitive', () => {
    const offenders = [];
    for (const file of daemonSources()) {
      if (file.endsWith('package.json')) {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      if (/from 'node:child_process'|require\('node:child_process'\)/u.test(text)) {
        offenders.push(`${relative(process.cwd(), file)} → child_process`);
      }
      if (/\bfetch\s*\(/u.test(text)) {
        offenders.push(`${relative(process.cwd(), file)} → fetch(`);
      }
      if (/https?\.request|https?\.get\b/u.test(text)) {
        offenders.push(`${relative(process.cwd(), file)} → http client`);
      }
      if (/node:https|'node:tls'|require\('node:net'\)/u.test(text)) {
        offenders.push(`${relative(process.cwd(), file)} → network client module`);
      }
    }
    assert.deepEqual(offenders, [], 'the daemon must serve loopback only and never dial out');
  });

  it('has no provider, credential or model configuration surface', () => {
    const text = daemonSources()
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const forbidden of ['apiKey', 'api_key', 'providerToken', 'ANTHROPIC_API', 'OPENAI_API', 'dsh']) {
      assert.equal(text.includes(forbidden), false, `source must not mention ${forbidden}`);
    }
  });
});

describe('core works with everything optional absent', () => {
  it('collects, detects, persists and reports without any Harness component', async () => {
    const previousDshHome = process.env.DSH_HOME;
    delete process.env.DSH_HOME;
    const dir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dir, { top: { mode: 'full' } }),
      sources: [createScriptedSource({
        id: 'synthetic.process',
        kind: 'process',
        script: [[makeEvent({ source_seq: 1 }), makeEvent({ source_seq: 2 })]],
      })],
      clock: createManualClock(BASE_MS),
    });
    try {
      await daemon.start();
      await waitFor(() => daemon.status().store.stats().events === 2, { label: 'core path persisted events' });
      const storeStats = daemon.status().store.stats();
      assert.equal(storeStats.events, 2);
      assert.equal(storeStats.alerts, 1);
      assert.equal(storeStats.findings, 2);
      assert.equal(storeStats.analyses, 1);
      assert.equal(daemon.health().status, 'ok');
      assert.equal(daemon.health().ready, true);

      // The control API still answers on loopback.
      const status = await httpRequest(daemon.address().port, '/api/v1/status', {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      assert.equal(status.status, 200);
      assert.equal(status.body.store.events, 2);
      assert.equal(status.body.pipeline.analysis_requests, 1);
    } finally {
      await daemon.stop('test');
      if (previousDshHome !== undefined) {
        process.env.DSH_HOME = previousDshHome;
      }
    }
  });

  it('keeps the analysis queue bounded and explicit with no broker present', async () => {
    const dir = makeTempDir();
    const daemon = createDaemon({
      config: makeConfig(dir, { top: { mode: 'full' } }),
      sources: [createScriptedSource({
        id: 'synthetic.process',
        kind: 'process',
        script: [[makeEvent({ source_seq: 1 })]],
      })],
      clock: createManualClock(BASE_MS),
    });
    await daemon.start();
    try {
      await waitFor(() => daemon.status().store.stats().analyses === 1, { label: 'one queued analysis' });
      // With no broker, the request simply stays queued: it is persisted, counted and
      // visible, never retried in a loop and never silently dropped.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      assert.equal(daemon.status().store.stats().analyses, 1);
      assert.equal(daemon.status().pipeline.stats().analysis_requests, 1);
      assert.equal(daemon.health().status, 'ok', 'a missing broker is not a core health failure');
    } finally {
      await daemon.stop('test');
    }
  });
});
