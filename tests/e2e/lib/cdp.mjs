/**
 * cdp.mjs — a zero-dependency Chrome DevTools Protocol driver (author PT-dove).
 *
 * Why this exists: the repo has no Playwright/Puppeteer (dependency lockfile is frozen),
 * but Edge is installed and Node 24 ships a global `WebSocket`. That is enough to drive a
 * real browser engine: launch, navigate, evaluate, screenshot, and — the part that matters
 * for "no white screen, zero red DevTools" — collect console errors, uncaught exceptions
 * and failed network requests per page.
 *
 * Scope discipline: this is a test harness. It never writes into apps/**, and it is not
 * shipped.
 *
 * Usage:
 *   const browser = await launch({ headless: true, width: 1440, height: 900 });
 *   const page = await browser.newPage();
 *   await page.goto('http://127.0.0.1:17512/#/overview');
 *   await page.waitFor(() => document.querySelectorAll('#view-root *').length > 5);
 *   const shot = await page.screenshot();          // Buffer
 *   const report = page.report();                  // errors/runtime/log summary
 *   await browser.close();
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Candidate browser executables, first existing one wins. */
export const BROWSER_CANDIDATES = Object.freeze([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]);

/** Locate a Chromium-family browser, or return `undefined`. */
export function findBrowser(explicit) {
  const candidates = explicit === undefined ? BROWSER_CANDIDATES : [explicit, ...BROWSER_CANDIDATES];
  return candidates.find((candidate) => typeof candidate === 'string' && existsSync(candidate));
}

/** Wait for a predicate, resolving to its value or throwing after `timeoutMs`. */
export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Minimal CDP connection: id correlation, session routing, event listeners. */
class Connection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== 1) return Promise.reject(new Error('CDP socket is not open'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000).unref?.();
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
  }
}

/** One page (target) driven through a flat session. */
export class Page {
  constructor(connection, sessionId, targetId, viewport) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.viewport = viewport;
    this.consoleEntries = [];
    this.exceptions = [];
    this.logEntries = [];
    this.failedRequests = [];
    this.responses = [];
    this.#attach();
  }

  #attach() {
    this.connection.on((message) => {
      if (message.sessionId !== this.sessionId) return;
      const { method, params } = message;
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
        this.consoleEntries.push({ type: params.type, text, at: Date.now() });
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails ?? {};
        this.exceptions.push({
          text: details.exception?.description ?? details.text ?? 'exception',
          url: details.url ?? null,
          line: details.lineNumber ?? null,
          at: Date.now(),
        });
      } else if (method === 'Log.entryAdded') {
        const entry = params.entry ?? {};
        this.logEntries.push({ level: entry.level, source: entry.source, text: entry.text, url: entry.url ?? null });
      } else if (method === 'Network.loadingFailed') {
        this.failedRequests.push({
          requestId: params.requestId,
          errorText: params.errorText,
          canceled: params.canceled === true,
          type: params.type ?? null,
        });
      } else if (method === 'Network.responseReceived') {
        this.responses.push({ url: params.response?.url, status: params.response?.status });
      }
    });
  }

  /** Enable the domains the report depends on. */
  async enable() {
    await this.connection.send('Runtime.enable', {}, this.sessionId);
    await this.connection.send('Log.enable', {}, this.sessionId);
    await this.connection.send('Page.enable', {}, this.sessionId);
    await this.connection.send('Network.enable', {}, this.sessionId);
  }

  /** Navigate and wait for `load`. */
  async goto(url, { timeoutMs = 20_000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.connection.on((message) => {
        if (message.sessionId !== this.sessionId) return;
        if (message.method === 'Page.loadEventFired') {
          off();
          resolve();
        }
      });
      setTimeout(() => {
        off();
        resolve();
      }, timeoutMs).unref?.();
    });
    const result = await this.connection.send('Page.navigate', { url }, this.sessionId);
    await loaded;
    return result;
  }

  /** Evaluate an expression in the page; throws when the page threw. */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.connection.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    }, this.sessionId);
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`page evaluation failed: ${text}`);
    }
    return result.result?.value;
  }

  /** Poll an expression until truthy (in-page). */
  async waitFor(expression, options = {}) {
    const { timeoutMs = 10_000, intervalMs = 100, label = expression } = options;
    return waitFor(async () => {
      try {
        return await this.evaluate(`Boolean(${expression})`);
      } catch {
        return false;
      }
    }, { timeoutMs, intervalMs, label });
  }

  /** Wait for a selector to exist. */
  async waitForSelector(selector, options = {}) {
    return this.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, {
      label: `selector ${selector}`,
      ...options,
    });
  }

  /** PNG bytes of the current viewport. */
  async screenshot({ fullPage = false } = {}) {
    const params = { format: 'png', captureBeyondViewport: fullPage };
    const result = await this.connection.send('Page.captureScreenshot', params, this.sessionId);
    return Buffer.from(result.data, 'base64');
  }

  /** Keyboard: press a key with optional modifiers. */
  async press(key, { code, keyCode, modifiers = 0 } = {}) {
    const base = { key, code: code ?? key, windowsVirtualKeyCode: keyCode ?? 0, nativeVirtualKeyCode: keyCode ?? 0, modifiers };
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, this.sessionId);
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId);
  }

  /** A single Tab press (used by keyboard nav tests). */
  async tab({ shift = false } = {}) {
    await this.connection.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
      modifiers: shift ? 8 : 0,
    }, this.sessionId);
    await this.connection.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
      modifiers: shift ? 8 : 0,
    }, this.sessionId);
  }

  /** Escape key. */
  async escape() {
    await this.connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, this.sessionId);
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, this.sessionId);
  }

  /**
   * Click an element by CSS selector, centre of its box.
   *
   * The element is scrolled into view first: the alert table lives in its own
   * horizontally scrollable region, so at 1440px the actions column is off-screen and a
   * raw `getBoundingClientRect()` centre would land outside the window, where the mouse
   * event is silently dropped. Scrolling is what a person does before clicking.
   *
   * Virtualised tables re-render after a scroll, so the coordinates are re-read and checked
   * against `elementFromPoint` immediately before each press; a stale coordinate would
   * otherwise click a neighbouring row and look like "the button did nothing".
   */
  async click(selector, { retries = 3 } = {}) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, w: r.width, h: r.height,
        hits: hit === el || (hit !== null && (el.contains(hit) || hit.contains(el))),
        // Only the *click point* must be on screen. A panel that overhangs the viewport by a
        // few pixels is still clickable at its centre, and treating that as "off screen"
        // turns a cosmetic overhang into a false failure.
        inViewport: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight };
    })()`);
    if (box === null) throw new Error(`click target not found: ${selector}`);
    if (box.inViewport !== true) {
      throw new Error(`click target ${selector} is outside the viewport after scrolling (${box.x},${box.y})`);
    }
    if (box.hits !== true) {
      // The list re-rendered between the scroll and the measurement: settle one frame and
      // retry with fresh coordinates rather than clicking whatever is now under the point.
      if (retries <= 0) throw new Error(`click target ${selector} is obscured by another element`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return this.click(selector, { retries: retries - 1 });
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.connection.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      }, this.sessionId);
    }
    return box;
  }

  /** Set the emulated colour scheme (`light` / `dark`). */
  async setColorScheme(value) {
    await this.connection.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    }, this.sessionId);
  }

  /** Resize the viewport. */
  async setViewport(width, height) {
    await this.connection.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    }, this.sessionId);
    this.viewport = { width, height };
  }

  /** Everything a "DevTools is red" check needs. */
  report() {
    const errors = this.consoleEntries.filter((entry) => entry.type === 'error');
    const warnings = this.consoleEntries.filter((entry) => entry.type === 'warning' || entry.type === 'warn');
    const logErrors = this.logEntries.filter((entry) => entry.level === 'error');
    const badResponses = this.responses.filter((entry) => typeof entry.status === 'number' && entry.status >= 400);
    return {
      consoleErrors: errors,
      consoleWarnings: warnings,
      exceptions: this.exceptions,
      logErrors,
      failedRequests: this.failedRequests.filter((entry) => entry.canceled !== true),
      badResponses,
      total: errors.length + this.exceptions.length + logErrors.length
        + this.failedRequests.filter((entry) => entry.canceled !== true).length,
    };
  }

  /** Clear collected diagnostics (so each route starts from zero). */
  resetReport() {
    this.consoleEntries = [];
    this.exceptions = [];
    this.logEntries = [];
    this.failedRequests = [];
    this.responses = [];
  }
}

/** A launched browser with one implicit browser-level CDP connection. */
export class Browser {
  constructor(process, connection, userDataDir, browserWsUrl) {
    this.process = process;
    this.connection = connection;
    this.userDataDir = userDataDir;
    this.browserWsUrl = browserWsUrl;
    this.pages = [];
  }

  /** Open a page target and enable the diagnostic domains. */
  async newPage({ width = 1440, height = 900 } = {}) {
    const { targetId } = await this.connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.connection, sessionId, targetId, { width, height });
    await page.enable();
    await page.setViewport(width, height);
    this.pages.push(page);
    return page;
  }

  /** Navigate a fresh page to `url` with a clean diagnostic slate. */
  async open(url, options = {}) {
    const page = await this.newPage(options);
    await page.goto(url);
    return page;
  }

  async close() {
    try {
      await this.connection.send('Browser.close', {});
    } catch {
      /* the browser may already be gone */
    }
    this.connection.close();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      this.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      this.process.kill();
    } catch {
      /* already gone */
    }
    try {
      rmSync(this.userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Launch a Chromium-family browser headlessly and connect over CDP.
 *
 * @param {{executable?: string, headless?: boolean, width?: number, height?: number,
 *   args?: string[], timeoutMs?: number}} [options]
 * @returns {Promise<Browser>}
 */
export async function launch(options = {}) {
  const executable = findBrowser(options.executable);
  if (executable === undefined) throw new Error('no Chromium-family browser found (set --browser)');
  const userDataDir = mkdtempSync(join(tmpdir(), 'aegis-cdp-'));
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  const args = [
    options.headless === false ? '--headless=old' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    'about:blank',
    ...(options.args ?? []),
  ];
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const timeoutMs = options.timeoutMs ?? 20_000;
  let active;
  try {
    active = await waitFor(() => (existsSync(portFile) ? readFileSync(portFile, 'utf8') : false), {
      timeoutMs,
      label: 'DevToolsActivePort',
    });
  } catch (error) {
    child.kill();
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
  const [portLine, pathLine] = active.trim().split(/\r?\n/u);
  const port = Number(portLine);
  const browserPath = pathLine ?? '/devtools/browser';
  const browserWsUrl = `ws://127.0.0.1:${port}${browserPath}`;

  const socket = await connectSocket(browserWsUrl, Math.min(timeoutMs, 10_000));
  const connection = new Connection(socket);
  return new Browser(child, connection, userDataDir, browserWsUrl);
}

/** Open a WebSocket, resolving once it is open. */
export function connectSocket(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`WebSocket timeout: ${url}`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket failed: ${url} ${event?.message ?? ''}`.trim()));
    }, { once: true });
  });
}
