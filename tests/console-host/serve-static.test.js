/**
 * `apps/console-next/serve.mjs` static surface (author PT-dove).
 *
 * Two fixtures are used on purpose:
 * - the real `apps/console-next/` directory, to prove the shipped product files
 *   (index.html, styles, mark.svg, the component modules) are servable with the
 *   MIME types an ES module page needs;
 * - a scratch copy of the same `serve.mjs` with hand-placed fixtures, because the
 *   product directory is not ours to fill with dotfiles, `.mjs` files and
 *   directories just to test the refusals.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  CONSOLE_PAGE,
  REPO_ROOT,
  closedPort,
  makeStaticFixture,
  portOf,
  rawRequest,
  startConsole,
} from './helpers.mjs';

/** The CSP contract §6, transcribed from the contract rather than imported. */
const EXPECTED_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
  + "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const fixture = makeStaticFixture();
const hosts = [];
after(async () => {
  for (const host of hosts) await host.close();
  fixture.cleanup();
});

/** Start the product host (real console directory) pointing at a dead daemon. */
async function startProductHost() {
  const port = await closedPort();
  const host = await startConsole(['--daemon', `http://127.0.0.1:${port}`]);
  hosts.push(host);
  return host;
}

/** Start the scratch host whose directory holds the fixture files. */
async function startFixtureHost() {
  const port = await closedPort();
  const host = await startConsole(['--daemon', `http://127.0.0.1:${port}`], {
    cwd: fixture.site,
    scriptPath: join(fixture.site, 'serve.mjs'),
  });
  hosts.push(host);
  return host;
}

describe('console host: security headers', () => {
  it('sends the full header set and a CSP that still allows same-origin modules', async () => {
    const host = await startProductHost();
    const response = await fetch(`${host.url}index.html`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('content-security-policy'), EXPECTED_CSP);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/u);
    assert.doesNotMatch(csp.split('; ').find((part) => part.startsWith('script-src')) ?? '', /unsafe-inline/u,
      'inline script must stay forbidden; modules are external files');
  });

  it('applies the same headers to proxy errors and 404s', async () => {
    const host = await startProductHost();
    const notFound = await fetch(`${host.url}nope.txt`);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers.get('cache-control'), 'no-store');
    assert.equal(notFound.headers.get('content-security-policy'), EXPECTED_CSP);

    const unreachable = await fetch(`${host.url}healthz`);
    assert.equal(unreachable.status, 502);
    assert.equal(unreachable.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(unreachable.headers.get('x-frame-options'), 'DENY');
  });
});

describe('console host: product files', () => {
  it('serves index.html byte-for-byte with a module-capable MIME type', async () => {
    const host = await startProductHost();
    const response = await fetch(`${host.url}index.html`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html; charset=utf-8$/u);
    assert.equal(body, readFileSync(CONSOLE_PAGE, 'utf8'));
  });

  it('serves "/" as index.html', async () => {
    const host = await startProductHost();
    const response = await fetch(host.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/u);
  });

  it('serves the design tokens and the logo', async () => {
    const host = await startProductHost();
    const css = await fetch(`${host.url}styles/tokens.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /^text\/css; charset=utf-8$/u);
    assert.ok((await css.text()).includes('--c-bg'));

    const svg = await fetch(`${host.url}assets/mark.svg`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /^image\/svg\+xml$/u);
  });

  it('serves js modules as text/javascript so `<script type="module">` can load', async () => {
    const host = await startProductHost();
    const modulePath = 'js/components/ui/dom.js';
    const response = await fetch(`${host.url}${modulePath}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await response.text(), readFileSync(join(REPO_ROOT, 'apps', 'console-next', modulePath), 'utf8'));
  });

  it('answers HEAD with the headers and no body', async () => {
    const host = await startProductHost();
    const response = await fetch(`${host.url}index.html`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('content-length')), readFileSync(CONSOLE_PAGE).length);
    assert.equal(await response.text(), '');
  });

  it('refuses non-GET/HEAD methods on static paths', async () => {
    const host = await startProductHost();
    const response = await fetch(`${host.url}index.html`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    const body = await response.json();
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });
});

describe('console host: static refusals', () => {
  it('never serves itself: .mjs is outside the extension allowlist', async () => {
    const host = await startFixtureHost();
    const response = await fetch(`${host.url}serve.mjs`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    const text = JSON.stringify(body);
    assert.equal(text.includes('createServer'), false, 'the host source must not be downloadable');
  });

  it('refuses dotfiles that really exist', async () => {
    const host = await startFixtureHost();
    const response = await fetch(`${host.url}.env`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  });

  it('refuses extensions outside the allowlist', async () => {
    const host = await startFixtureHost();
    for (const path of ['notes.md', 'secret.mjs']) {
      const response = await fetch(`${host.url}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).error.code, 'NOT_FOUND', path);
    }
  });

  it('refuses directory requests instead of listing them', async () => {
    const host = await startFixtureHost();
    for (const path of ['sub', 'sub/']) {
      const response = await fetch(`${host.url}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).error.code, 'NOT_FOUND', path);
    }
  });

  it('serves a nested allowed file', async () => {
    const host = await startFixtureHost();
    const response = await fetch(`${host.url}sub/child.txt`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), 'child\n');
  });

  it('serves a binary image without mangling it', async () => {
    const host = await startFixtureHost();
    const response = await fetch(`${host.url}image.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('refuses every traversal spelling with a JSON 404', async () => {
    const host = await startFixtureHost();
    const port = portOf(host.url);
    const probes = [
      '/../outside.txt',
      '/..%2foutside.txt',
      '/%2e%2e/outside.txt',
      '/%2e%2e%2foutside.txt',
      '/sub/..%2f..%2foutside.txt',
      '/sub/%2e%2e/%2e%2e/outside.txt',
      '/..\\outside.txt',
      '/%2e%2e%5coutside.txt',
      '/../serve.mjs',
    ];
    for (const path of probes) {
      const response = await rawRequest({ port, path });
      assert.equal(response.status, 404, `${path} must be 404, body=${response.text}`);
      assert.equal(typeof JSON.parse(response.text).error?.code, 'string', path);
      assert.equal(response.text.includes('outside'), false, `${path} leaked the sibling file`);
    }
  });

  it('refuses NUL and malformed percent escapes', async () => {
    const host = await startFixtureHost();
    const port = portOf(host.url);
    for (const path of ['/%00', '/%zz', '/%e0%a4%a']) {
      const response = await rawRequest({ port, path });
      assert.equal(response.status, 404, path);
      assert.equal(response.text.includes('outside'), false, path);
    }
  });

  it('does not answer the proxy routes from the static layer', async () => {
    const host = await startFixtureHost();
    // `/healthz` is proxied (daemon unreachable here), never served from disk.
    const response = await fetch(`${host.url}healthz`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'DAEMON_UNREACHABLE');
  });
});
