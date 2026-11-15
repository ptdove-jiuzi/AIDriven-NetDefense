/**
 * verify-secrets.mjs — hard criterion: a plaintext API key must never appear in the DOM,
 * in localStorage/sessionStorage, or in any log file.
 *
 * Method (not a code review — an experiment):
 *   1. generate a high-entropy canary string;
 *   2. PUT it through the console host exactly like the settings page does
 *      (`PUT /api/v1/credentials/deepseek` + `x-console-v2: 1`);
 *   3. visit all six views, plus the settings provider editor, and snapshot what the
 *      browser can see (DOM text/attributes, storage, resource URLs, console output);
 *   4. grep the console-host log and the daemon log on disk;
 *   5. DELETE the canary and confirm the credential is cleared.
 *
 * Any single occurrence fails the run.
 *
 * usage: node tests/e2e/lead/verify-secrets.mjs [--base http://127.0.0.1:17512]
 *        [--logs <dir>] [--out <dir>] [--canary <string>]
 */

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { launch } from '../lib/cdp.mjs';
import { Checker, parseArgs, viewUrl, writeEvidence, VIEWS } from './common.mjs';

const LOG_DIR = process.env.AIDN_QA_LOGS || 'qa-int/logs';

/** Read every regular file under `dir` (one level of recursion is enough for our logs). */
function readLogFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isFile()) files.push({ file: full, text: readFileSync(full, 'utf8') });
    } catch {
      /* a log that vanished mid-run is not evidence */
    }
  }
  return files;
}

const CANARY_ATTR = 'data-canary-scan';

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    logs: LOG_DIR,
    canary: `sk-canary-${randomBytes(12).toString('hex')}`,
  });
  const canary = args.canary;
  const checker = new Checker('API key plaintext must not appear anywhere observable');
  const browser = await launch({ width: 1440, height: 900 });
  const surfaces = {};
  let putStatus = null;
  let deleteStatus = null;
  try {
    const page = await browser.newPage();
    await page.goto(viewUrl(args.base, 'settings', { theme: 'dark', lang: 'zh-CN' }));
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 1) Put the canary through the same origin and the same header the UI uses.
    putStatus = await page.evaluate(`(async () => {
      const response = await fetch('/api/v1/credentials/deepseek', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-console-v2': '1' },
        body: JSON.stringify({ apiKey: ${JSON.stringify(canary)} }),
      });
      return { status: response.status, text: (await response.text()).slice(0, 400) };
    })()`);
    checker.equal(putStatus.status, 204, 'PUT /api/v1/credentials/deepseek returns 204');

    // 2) GET must never echo it back (there is no credential GET at all).
    const getCredential = await page.evaluate(`(async () => {
      const response = await fetch('/api/v1/credentials/deepseek', { headers: { 'x-console-v2': '1' } });
      return { status: response.status, text: (await response.text()).slice(0, 400) };
    })()`);
    checker.equal(getCredential.status, 405, 'GET /api/v1/credentials/:id is 405 (no read path)');

    // 3) Walk every view and snapshot every observable surface.
    const walk = [];
    for (const view of VIEWS) {
      await page.goto(viewUrl(args.base, view, { theme: 'dark', lang: 'zh-CN' }));
      await new Promise((resolve) => setTimeout(resolve, 900));
      const snapshot = await page.evaluate(`(() => {
        const storage = {};
        for (const area of ['localStorage', 'sessionStorage']) {
          try {
            const store = window[area];
            for (let index = 0; index < store.length; index += 1) {
              const key = store.key(index);
              storage[area + ':' + key] = store.getItem(key);
            }
          } catch { /* storage disabled */ }
        }
        const attributes = [];
        for (const node of document.querySelectorAll('*')) {
          for (const attribute of node.attributes ?? []) {
            if (attribute.value.length > 8) attributes.push(attribute.name + '=' + attribute.value);
          }
        }
        return {
          domText: document.body?.innerText ?? '',
          domHtml: document.documentElement?.outerHTML ?? '',
          attributes: attributes.join('\\n'),
          storage,
          resourceUrls: performance.getEntriesByType('resource').map((entry) => entry.name).join('\\n'),
          cookie: document.cookie,
        };
      })()`);
      const hits = {
        domText: snapshot.domText.includes(canary),
        domHtml: snapshot.domHtml.includes(canary),
        attributes: snapshot.attributes.includes(canary),
        storage: Object.values(snapshot.storage).some((value) => String(value).includes(canary)),
        resourceUrls: snapshot.resourceUrls.includes(canary),
        cookie: snapshot.cookie.includes(canary),
        console: page.report().consoleErrors.some((entry) => entry.text.includes(canary)),
      };
      walk.push({ view, hits, storageKeys: Object.keys(snapshot.storage), storageBytes: JSON.stringify(snapshot.storage).length });
      for (const [surface, hit] of Object.entries(hits)) {
        if (hit) surfaces[`${view}.${surface}`] = true;
      }
    }

    // 4) The daemon's own view of the credential must be metadata only.
    const models = await page.evaluate(`(async () => {
      const response = await fetch('/api/v1/models');
      return { status: response.status, body: await response.text() };
    })()`);
    checker.equal(models.status, 200, 'GET /api/v1/models returns 200');
    checker.ok(!models.body.includes(canary), 'GET /api/v1/models never contains the plaintext key');
    const parsed = JSON.parse(models.body);
    const provider = parsed.providers?.[0] ?? {};
    checker.ok(provider.hasCredential === true, 'provider reports hasCredential=true after PUT', provider.hasCredential);
    checker.ok(typeof provider.credential?.masked === 'string' && provider.credential.masked.length > 0,
      'provider reports a masked credential', provider.credential);
    checker.ok(provider.credential?.masked === undefined || !String(provider.credential.masked).includes(canary.slice(3, 15)),
      'masked credential does not carry a usable substring of the key', provider.credential?.masked);

    // 5) Disk logs.
    const logs = readLogFiles(args.logs);
    const logHits = logs.filter((entry) => entry.text.includes(canary)).map((entry) => entry.file);
    checker.ok(logHits.length === 0, 'no log file on disk contains the plaintext key', logHits);

    // 6) Clean up: the canary must be removable, and removal must be idempotent.
    deleteStatus = await page.evaluate(`(async () => {
      const response = await fetch('/api/v1/credentials/deepseek', { method: 'DELETE', headers: { 'x-console-v2': '1' } });
      return { status: response.status, text: (await response.text()).slice(0, 200) };
    })()`);
    checker.equal(deleteStatus.status, 204, 'DELETE /api/v1/credentials/deepseek returns 204');
    const afterDelete = await page.evaluate(`(async () => {
      const response = await fetch('/api/v1/models');
      return await response.text();
    })()`);
    checker.ok(JSON.parse(afterDelete).providers?.[0]?.hasCredential === false,
      'hasCredential=false after DELETE');

    checker.ok(Object.keys(surfaces).length === 0,
      'canary absent from every DOM/storage/log surface', Object.keys(surfaces));
  } finally {
    await browser.close();
  }

  const summary = checker.summary();
  const evidence = writeEvidence(args.out, 'secrets.json', {
    at: new Date().toISOString(),
    base: args.base,
    canaryLength: canary.length,
    canaryPreview: `${canary.slice(0, 6)}…${canary.slice(-3)}`,
    putStatus,
    deleteStatus,
    leaks: Object.keys(surfaces),
    summary,
  });
  process.stdout.write(`${JSON.stringify({ summary, evidence }, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verify-secrets: ${error?.stack ?? error}\n`);
  process.exit(1);
});
