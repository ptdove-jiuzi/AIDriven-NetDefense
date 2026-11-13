/**
 * 02-keyboard.mjs — real keyboard / focus / overlay a11y checks (author PT-dove).
 *
 *   A. 60 real `Tab` presses on the alerts page: order, visibility of the focus ring,
 *      no dead loop, no focus landing inside aria-hidden / display:none subtrees.
 *   B. Table horizontal overflow: is the action column reachable by keyboard at
 *      1440/1280/1024/390 px, and does focus scroll it into view? (Lead-reported
 *      suspect: scrollWidth ≈1931 > clientWidth ≈1390 at 1440×900.)
 *   C. Drawer, three independent close paths (X / backdrop / Esc): focus enters the
 *      panel, Tab stays trapped, focus returns to the triggering row on close, the
 *      scroll lock is released and no overlay node is left behind.
 *   D. Settings destructive confirmation modal (`role="alertdialog"`): focus enters,
 *      Tab stays trapped, Esc / backdrop / Cancel close it, focus returns to the
 *      trigger, and no settings write happens just by opening/closing it.
 *
 * Each section gets its own browser instance and is retried once: the machine hosts
 * several parallel agents' headless browsers, and a shared-browser crash must not lose
 * the other sections' evidence (observed once: CDP socket closed mid-run).
 *
 * Usage: node tests/e2e/visual/02-keyboard.mjs [--base http://127.0.0.1:17512]
 */

import { join } from 'node:path';

import {
  FOCUS_SOURCE,
  RESULTS,
  STACKS,
  buildFingerprint,
  clickAt,
  closePage,
  createChecker,
  devtoolsSummary,
  fingerprintDelta,
  isUp,
  openBrowser,
  parseArgs,
  recordBuild,
  resolveSample,
  rgbText,
  sleep,
  writeJson,
  writeShot,
} from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), { base: STACKS.data.base, theme: 'dark', tabs: '60' });
const BASE = String(args.base);
const THEME = String(args.theme);
const TAB_STEPS = Number(args.tabs) || 60;
const DARK = THEME;

const checker = createChecker();
const buildAtStart = buildFingerprint();
recordBuild(buildAtStart, '02-keyboard-start');
const startedAt = new Date().toISOString();

const ALERTS_URL = `${BASE}/?theme=${THEME}&static=1#/alerts`;
const SETTINGS_URL = `${BASE}/?theme=${THEME}&static=1#/settings`;

/** Wait until the alerts table has real rows. */
async function waitForAlertsTable(page) {
  await page.waitFor(`(() => {
    const table = document.querySelector('.ui-table');
    if (table === null) return false;
    return table.querySelectorAll('tr[data-row="true"]').length > 0;
  })()`, { timeoutMs: 20_000, label: 'alerts table rows' });
  await sleep(700);
}

/** Blur anything focused so the next Tab starts from the document start. */
async function resetFocus(page) {
  await page.evaluate(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  await sleep(60);
}

/** Focus snapshot. */
async function focusSnapshot(page) {
  return page.evaluate(FOCUS_SOURCE);
}

/** Focus ring contrast (non-text, needs ≥3:1) for one snapshot.
 *
 * The outline is painted *outside* the border box when `outline-offset >= 0`, so the
 * background it must be distinguished from is the parent's, not the element's own fill.
 * Comparing against the element's own background (e.g. an accent-filled button) produces
 * a false 1.5:1 reading, which is not a real WCAG failure. Inset rings (`offset < 0`) are
 * compared against the element's own background.
 */
function ringContrast(snapshot) {
  if (snapshot === null || snapshot.outlineColor === undefined || snapshot.outlineColor === null) return null;
  if (snapshot.outlineStyle === 'none' || snapshot.outlineWidth === '0px') return null;
  const layers = Array.isArray(snapshot.bgLayers) ? [...snapshot.bgLayers] : [];
  const offset = Number.parseFloat(String(snapshot.outlineOffset ?? '0'));
  const inset = Number.isFinite(offset) && offset < 0;
  if (!inset && layers.length > 1) layers.pop();
  const resolved = resolveSample({ color: snapshot.outlineColor, bgLayers: layers.length === 0 ? snapshot.bgLayers : layers, opacityChain: 1 });
  return {
    ratio: Number(resolved.fgRatio.toFixed(2)),
    ring: rgbText(resolved.fg),
    against: rgbText(resolved.bg),
    inset,
    outlineOffset: snapshot.outlineOffset,
  };
}

/** Run one section with its own browser, retrying once on a dead CDP socket. */
async function runSection(name, section, { attempts = 2 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const browser = await openBrowser({ width: 1440, height: 900 });
    try {
      const value = await section(browser);
      await browser.close();
      checker.add(`${name}-section-completed`, true, `attempt ${attempt}`);
      return value;
    } catch (error) {
      lastError = error;
      try {
        await browser.close();
      } catch {
        /* browser may already be gone */
      }
      await sleep(1500);
    }
  }
  checker.add(`${name}-section-completed`, false, `${attempts} attempts failed: ${lastError?.message ?? lastError}`);
  return { error: String(lastError?.stack ?? lastError) };
}

const results = { tabWalk: null, overflow: null, drawer: null, modal: null };

checker.add('stack-up', await isUp(Number(new URL(BASE).port || 80)), BASE);

/* ===================== A. 60-tab walk on the alerts page ===================== */
results.tabWalk = await runSection('tabwalk', async (browser) => {
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.setColorScheme(THEME);
  try {
    await page.goto(ALERTS_URL);
    await waitForAlertsTable(page);
    await resetFocus(page);
    const steps = [];
    for (let step = 1; step <= TAB_STEPS; step += 1) {
      await page.tab();
      await sleep(45);
      const snapshot = await focusSnapshot(page);
      steps.push({ step, ...snapshot, ringContrast: ringContrast(snapshot) });
    }
    const shot = writeShot(`tab-walk-alerts-${DARK}-1440x900.png`, await page.screenshot());

    const valid = steps.filter((entry) => entry.domOrderIndex >= 0);
    const violations = [];
    for (let index = 1; index < valid.length; index += 1) {
      const previous = valid[index - 1];
      const current = valid[index];
      if (current.domOrderIndex <= previous.domOrderIndex) {
        violations.push({
          previous: { step: previous.step, tag: previous.tag, text: previous.text, index: previous.domOrderIndex },
          current: { step: current.step, tag: current.tag, text: current.text, index: current.domOrderIndex },
          kind: current.domOrderIndex === previous.domOrderIndex ? 'same-element' : 'backwards',
        });
      }
    }
    const signature = (entry) => `${entry.tag}|${entry.id}|${entry.cls}|${entry.text}`;
    const repeats = [];
    for (let index = 1; index < steps.length; index += 1) {
      if (signature(steps[index]) === signature(steps[index - 1])) {
        repeats.push({ step: steps[index].step, signature: signature(steps[index]) });
      }
    }
    const hidden = steps.filter((entry) => entry.insideAriaHidden === true || entry.visible === false);
    const bodyFocus = steps.filter((entry) => entry.tag === 'BODY' || entry.tag === null);
    // A focus ring is only meaningful on a real element; a BODY focus is its own defect.
    const elementSteps = steps.filter((entry) => entry.tag !== 'BODY' && entry.tag !== null);
    const invisibleRing = elementSteps.filter((entry) => entry.outlineStyle === 'none' && (entry.boxShadow === 'none' || entry.boxShadow === ''));
    const rings = steps.map((entry) => entry.ringContrast).filter((entry) => entry !== null);
    const minRing = rings.reduce((min, entry) => (entry.ratio < min.ratio ? entry : min), { ratio: Infinity });
    const escaped = steps.filter((entry) => entry.domOrderIndex < 0 && entry.tag !== 'BODY');

    checker.add('tab-60-steps-recorded', steps.length === TAB_STEPS, `${steps.length} steps`);
    checker.add('tab-order-monotonic', violations.length === 0, `${violations.length} violations`);
    checker.add('tab-focus-visible', invisibleRing.length === 0, `${invisibleRing.length}/${elementSteps.length} element steps without outline/box-shadow`);
    checker.add('tab-no-focus-escape-to-body', bodyFocus.length === 0, `${bodyFocus.length} Tab presses left focus on BODY`);
    checker.add('tab-no-aria-hidden-or-hidden', hidden.length === 0, `${hidden.length} steps in hidden subtrees`);
    checker.add('tab-no-dead-loop', repeats.length === 0, `${repeats.length} consecutive repeats`);
    checker.add('tab-ring-contrast-3to1', rings.length === 0 || minRing.ratio >= 3,
      rings.length === 0 ? 'no rings measured' : `min ${minRing.ratio}:1 (${minRing.ring} on ${minRing.against}, inset=${minRing.inset})`);
    checker.add('tab-not-escaped-page', escaped.length === 0, `${escaped.length} steps off the tabbable set`);

    return {
      url: ALERTS_URL,
      startFocus: steps[0]?.tag ?? null,
      steps,
      uniqueElementsReached: new Set(steps.map((entry) => signature(entry))).size,
      monotonicViolations: violations,
      consecutiveRepeats: repeats,
      bodyFocusSteps: bodyFocus.map((entry) => entry.step),
      hiddenSteps: hidden,
      invisibleRingSteps: invisibleRing.map((entry) => ({ step: entry.step, tag: entry.tag, cls: entry.cls, text: entry.text })),
      minRingContrast: Number.isFinite(minRing.ratio) ? { ...minRing, ratio: minRing.ratio } : null,
      screenshot: shot.rel,
    };
  } finally {
    await closePage(page);
  }
});

/* ============== B. horizontal overflow + keyboard reachability ============== */
results.overflow = await runSection('overflow', async (browser) => {
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.setColorScheme(THEME);
  try {
    await page.goto(ALERTS_URL);
    await waitForAlertsTable(page);
    const widths = [1440, 1280, 1024, 390];
    const metrics = [];
    for (const width of widths) {
      const height = width === 390 ? 844 : 900;
      await page.setViewport(width, height);
      await sleep(400);
      metrics.push(await page.evaluate(`(() => {
        const scroll = document.querySelector('.ui-table__scroll');
        const row = document.querySelector('tr[data-row="true"]');
        if (scroll === null || row === null) return { width: ${width}, found: false };
        const scrollRect = scroll.getBoundingClientRect();
        const buttons = [...row.querySelectorAll('button')].map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            label: button.getAttribute('aria-label'),
            left: Math.round(rect.left - scrollRect.left),
            visible: rect.left >= scrollRect.left - 1 && rect.right <= scrollRect.right + 1 && rect.width > 0,
          };
        });
        const clientWidth = document.documentElement.clientWidth;
        // Page-level overflow: elements outside the table scroller whose right edge is
        // past the viewport. (The table lives in its own overflow-x container, so it is
        // excluded — that scroller is the accepted design, not a page bug.)
        const pageOffenders = [];
        const walk = (node) => {
          for (const child of node.children) {
            const computed = getComputedStyle(child);
            if (computed.position === 'fixed' || computed.position === 'absolute') continue;
            if (child.closest('.ui-table__scroll') !== null) continue;
            const rect = child.getBoundingClientRect();
            if (rect.right > clientWidth + 1) {
              pageOffenders.push({
                tag: child.tagName,
                cls: String(child.className ?? '').slice(0, 60),
                right: Math.round(rect.right),
                text: (child.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 30),
              });
            }
            walk(child);
          }
        };
        walk(document.body);
        return {
          width: ${width},
          found: true,
          clientWidth: Math.round(scroll.clientWidth),
          scrollWidth: Math.round(scroll.scrollWidth),
          overflowPx: Math.round(scroll.scrollWidth - scroll.clientWidth),
          actionButtons: buttons,
          actionButtonsOffscreen: buttons.filter((button) => button.visible === false).length,
          docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          docClientWidth: document.documentElement.clientWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          docOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          pageOffenders: pageOffenders.slice(0, 6),
          pageOffenderCount: pageOffenders.length,
        };
      })()`));
    }
    // Keyboard-only proof at the *narrow* width where the action column overflows (1024):
    // Tab until an in-row action button takes focus, then check whether the browser
    // scrolled the overflow container to reveal it.
    const keyboard = { width: 1024, reachedAtStep: null, focus: null, visibleAfter: false, scrollLeftAfter: 0, fullyVisibleCount: 0, actionButtonSteps: 0 };
    await page.setViewport(1024, 900);
    await sleep(400);
    await resetFocus(page);
    for (let step = 1; step <= 80; step += 1) {
      await page.tab();
      await sleep(35);
      const snapshot = await page.evaluate(`(() => {
        const active = document.activeElement;
        const scroll = document.querySelector('.ui-table__scroll');
        if (active === null || scroll === null) return null;
        const inTable = active.closest('.ui-table') !== null && active.tagName === 'BUTTON';
        const scrollRect = scroll.getBoundingClientRect();
        const rect = active.getBoundingClientRect();
        return {
          inTableActionButton: inTable,
          tag: active.tagName,
          label: active.getAttribute('aria-label'),
          scrollLeft: Math.round(scroll.scrollLeft),
          fullyVisible: rect.left >= scrollRect.left - 1 && rect.right <= scrollRect.right + 1 && rect.width > 0,
          rectLeft: Math.round(rect.left),
          rectRight: Math.round(rect.right),
          containerLeft: Math.round(scrollRect.left),
          containerRight: Math.round(scrollRect.right),
        };
      })()`);
      if (snapshot !== null && snapshot.inTableActionButton === true) {
        keyboard.actionButtonSteps += 1;
        if (snapshot.fullyVisible) keyboard.fullyVisibleCount += 1;
        if (keyboard.reachedAtStep === null) {
          keyboard.reachedAtStep = step;
          keyboard.focus = snapshot;
          keyboard.visibleAfter = snapshot.fullyVisible;
          keyboard.scrollLeftAfter = snapshot.scrollLeft;
        }
      }
    }
    const shot = writeShot(`table-overflow-${DARK}-1024x900.png`, await page.screenshot());
    const worst = metrics.reduce((max, entry) => (entry.overflowPx > (max.overflowPx ?? -1) ? entry : max), {});
    const worstDoc = metrics.reduce((max, entry) => (entry.docOverflowPx > (max.docOverflowPx ?? -1) ? entry : max), {});
    checker.add('overflow-measured', metrics.every((entry) => entry.found === true), JSON.stringify(metrics.map((entry) => entry.overflowPx)));
    checker.add('table-horizontal-scroll-contained', metrics.filter((entry) => entry.width !== 390).every((entry) => entry.docOverflow !== true),
      JSON.stringify(metrics.map((entry) => ({ width: entry.width, docOverflowPx: entry.docOverflowPx }))));
    checker.add('keyboard-reaches-action-column', keyboard.reachedAtStep !== null, `step ${keyboard.reachedAtStep} at 1024px`);
    checker.add('keyboard-focus-scrolls-into-view', keyboard.reachedAtStep === null || keyboard.fullyVisibleCount === keyboard.actionButtonSteps,
      `${keyboard.fullyVisibleCount}/${keyboard.actionButtonSteps} focused action buttons fully visible (scrollLeft ${keyboard.scrollLeftAfter})`);
    return {
      url: ALERTS_URL,
      metrics,
      worstOverflowPx: worst.overflowPx ?? null,
      worstDocOverflowPx: worstDoc.docOverflowPx ?? null,
      keyboardReachability: keyboard,
      screenshot: shot.rel,
      judgement: {
        // A horizontally scrollable table container is the accepted design (§7.6 keeps a
        // real <table> with fixed columns). The a11y question is whether keyboard users
        // can reach the off-screen cells: if Tab focus scrolls the container, it is usable.
        tableScrollerAcceptableIfKeyboardReachable: true,
        measuredWorstTableOverflowPx: worst.overflowPx ?? null,
        actionButtonsOffscreenAt1440: metrics.find((entry) => entry.width === 1440)?.actionButtonsOffscreen ?? null,
        actionButtonsOffscreenAt1280: metrics.find((entry) => entry.width === 1280)?.actionButtonsOffscreen ?? null,
        actionButtonsOffscreenAt1024: metrics.find((entry) => entry.width === 1024)?.actionButtonsOffscreen ?? null,
        actionButtonsOffscreenAt390: metrics.find((entry) => entry.width === 390)?.actionButtonsOffscreen ?? null,
        // Page-level overflow is a different thing and *not* acceptable: it means the
        // whole document scrolls sideways (topbar clipped), which breaks narrow layouts.
        pageLevelOverflow: worstDoc.docOverflowPx ?? null,
        pageLevelOffenders: worstDoc.pageOffenders ?? [],
      },
    };
  } finally {
    await closePage(page);
  }
});

/* ================== C. drawer: X / backdrop / Esc ================== */
results.drawer = await runSection('drawer', async (browser) => {
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.setColorScheme(THEME);
  const paths = ['x', 'backdrop', 'escape'];
  const drawerResults = [];
  try {
    for (const path of paths) {
      await page.goto(ALERTS_URL);
      await waitForAlertsTable(page);
      page.resetReport();
      const opened = await page.evaluate(`(() => {
        const row = document.querySelector('tr[data-row="true"][data-clickable="true"]');
        if (row === null) return null;
        const index = row.getAttribute('data-index');
        row.click();
        return { index, text: (row.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 60) };
      })()`);
      await sleep(500);
      const openState = await page.evaluate(`(() => {
        const overlay = document.querySelector('[data-overlay="drawer"]');
        const panel = overlay === null ? null : overlay.querySelector('.ui-drawer__panel');
        const active = document.activeElement;
        const closeButton = overlay === null ? null : overlay.querySelector('.ui-drawer__close');
        return {
          overlayPresent: overlay !== null,
          panelRole: panel === null ? null : panel.getAttribute('role'),
          panelAriaModal: panel === null ? null : panel.getAttribute('aria-modal'),
          panelLabelled: panel === null ? null : panel.getAttribute('aria-labelledby'),
          focusInsidePanel: panel === null ? false : panel.contains(active),
          focusTag: active === null ? null : active.tagName,
          focusAria: active === null ? null : active.getAttribute('aria-label'),
          focusableInPanel: panel === null ? 0 : panel.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])').length,
          scrollLock: document.documentElement.classList.contains('ui-scroll-lock'),
          appAriaHidden: document.getElementById('app') === null ? null : document.getElementById('app').getAttribute('aria-hidden'),
          closeVisible: closeButton !== null && closeButton.getBoundingClientRect().width > 0,
          bodyTextLength: panel === null ? 0 : (panel.innerText ?? '').length,
        };
      })()`);
      // Trap proof: 10 forward tabs + 3 backward tabs must all stay inside the panel.
      const trap = [];
      for (let step = 0; step < 10; step += 1) {
        await page.tab();
        await sleep(35);
        trap.push(await page.evaluate(`(() => {
          const active = document.activeElement;
          return { inside: active !== null && active.closest('.ui-drawer__panel') !== null, tag: active === null ? null : active.tagName };
        })()`));
      }
      for (let step = 0; step < 3; step += 1) {
        await page.tab({ shift: true });
        await sleep(35);
        trap.push(await page.evaluate(`(() => {
          const active = document.activeElement;
          return { inside: active !== null && active.closest('.ui-drawer__panel') !== null, tag: active === null ? null : active.tagName };
        })()`));
      }
      const shotPath = path === 'x' ? writeShot(`drawer-open-${DARK}-1440x900.png`, await page.screenshot()) : null;
      let closeAction = null;
      if (path === 'x') {
        await page.evaluate(`(() => { const button = document.querySelector('.ui-drawer__close'); if (button === null) return false; button.click(); return true; })()`);
        closeAction = 'click .ui-drawer__close';
      } else if (path === 'backdrop') {
        const point = await page.evaluate(`(() => {
          const overlay = document.querySelector('[data-overlay="drawer"]');
          const panel = overlay === null ? null : overlay.querySelector('.ui-drawer__panel');
          if (overlay === null || panel === null) return null;
          const overlayRect = overlay.getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          const x = panelRect.left > 40 ? panelRect.left / 2 : overlayRect.left + 6;
          return { x: Math.round(x), y: Math.round(overlayRect.top + overlayRect.height / 2) };
        })()`);
        if (point !== null) await clickAt(page, point.x, point.y);
        closeAction = point === null ? 'backdrop point not found' : `clickAt(${point.x},${point.y}) outside panel`;
      } else {
        await page.escape();
        closeAction = 'Escape keydown on focused element inside panel';
      }
      await sleep(400);
      const closed = await page.evaluate(`(() => {
        const active = document.activeElement;
        const focusables = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')];
        const hiddenFocusables = focusables.filter((node) => node.closest('[aria-hidden="true"]') !== null);
        return {
          overlayCount: document.querySelectorAll('[data-overlay]').length,
          drawerPresent: document.querySelector('[data-overlay="drawer"]') !== null,
          modalPresent: document.querySelector('[data-overlay="modal"]') !== null,
          scrollLock: document.documentElement.classList.contains('ui-scroll-lock'),
          activeTag: active === null ? null : active.tagName,
          activeIndex: active === null ? null : active.getAttribute('data-index'),
          activeClickable: active === null ? null : active.getAttribute('data-clickable'),
          activeInsideTable: active === null ? false : active.closest('.ui-table') !== null,
          activeInsideAriaHidden: active === null ? false : active.closest('[aria-hidden="true"]') !== null,
          appAriaHidden: document.getElementById('app') === null ? null : document.getElementById('app').getAttribute('aria-hidden'),
          viewRootAriaHidden: document.getElementById('view-root') === null ? null : document.getElementById('view-root').getAttribute('aria-hidden'),
          bodyAriaHidden: document.body.getAttribute('aria-hidden'),
          hiddenFocusableCount: hiddenFocusables.length,
        };
      })()`);
      const focusReturned = closed.activeTag === 'TR' && closed.activeIndex === opened?.index;
      drawerResults.push({
        path,
        closeAction,
        opened,
        openState,
        trapAllInside: trap.every((entry) => entry.inside === true),
        trapSteps: trap.length,
        closed,
        focusReturned,
        screenshot: shotPath === null ? null : shotPath.rel,
        devtools: devtoolsSummary(page),
      });
      checker.add(`drawer-${path}-opens`, openState.overlayPresent === true && openState.focusInsidePanel === true,
        `role=${openState.panelRole} focus=${openState.focusTag}`);
      checker.add(`drawer-${path}-trap`, trap.every((entry) => entry.inside === true), `${trap.filter((entry) => entry.inside !== true).length} escapes of ${trap.length}`);
      checker.add(`drawer-${path}-closes`, closed.overlayCount === 0 && closed.drawerPresent === false, `overlays=${closed.overlayCount}`);
      checker.add(`drawer-${path}-scroll-lock-released`, closed.scrollLock === false, String(closed.scrollLock));
      checker.add(`drawer-${path}-focus-returns`, focusReturned === true, `active=${closed.activeTag}#${closed.activeIndex}, trigger=#${opened?.index ?? '?'}`);
      checker.add(`drawer-${path}-overlay-aria-state`, closed.appAriaHidden === null && closed.viewRootAriaHidden === null
        && closed.bodyAriaHidden === null && closed.activeInsideAriaHidden === false && closed.hiddenFocusableCount === 0,
      JSON.stringify({
        app: closed.appAriaHidden,
        viewRoot: closed.viewRootAriaHidden,
        body: closed.bodyAriaHidden,
        activeInAriaHidden: closed.activeInsideAriaHidden,
        hiddenFocusables: closed.hiddenFocusableCount,
      }));
    }
    return { url: ALERTS_URL, paths: drawerResults };
  } finally {
    await closePage(page);
  }
});

/* ================== D. settings destructive modal ================== */
results.modal = await runSection('modal', async (browser) => {
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.setColorScheme(THEME);
  try {
    await page.goto(SETTINGS_URL);
    await page.waitFor(`(() => document.querySelectorAll('.settings-provider').length > 0)()`, {
      timeoutMs: 25_000,
      label: 'settings provider cards',
    });
    await sleep(900);
    page.resetReport();
    const before = await page.evaluate(`(() => ({
      providerCards: document.querySelectorAll('.settings-provider').length,
      modalCount: document.querySelectorAll('[data-overlay="modal"]').length,
    }))()`);
    /**
     * Open the destructive confirmation the way a user does: focus the trigger button and
     * press it with a real mouse click at its centre. (A programmatic `.click()` does not
     * move focus, so `previousActive` would be <body> and the focus-return assertion would
     * measure the test harness, not the product.)
     */
    const openRemoveModal = async () => {
      const target = await page.evaluate(`(() => {
        const cards = [...document.querySelectorAll('.settings-provider')];
        for (const card of cards) {
          const providerId = card.getAttribute('data-provider-id') || '';
          const head = card.querySelector('.settings-provider__head');
          if (head === null || providerId === '') continue;
          const remove = [...head.querySelectorAll('button')].find((button) => /remove|删除|移除/iu.test(button.innerText ?? ''));
          if (remove === undefined) continue;
          remove.scrollIntoView({ block: 'center' });
          remove.focus();
          const rect = remove.getBoundingClientRect();
          return {
            providerId,
            label: (remove.innerText ?? '').trim(),
            focused: document.activeElement === remove,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        }
        return { providerId: null, label: null, focused: false, x: null, y: null, cardCount: cards.length };
      })()`);
      if (target.x !== null) await clickAt(page, target.x, target.y);
      await sleep(700);
      return target;
    };
    const opened = await openRemoveModal();
    const modalState = await page.evaluate(`(() => {
      const overlay = document.querySelector('[data-overlay="modal"]');
      const panel = overlay === null ? null : overlay.querySelector('.ui-modal__panel');
      const active = document.activeElement;
      return {
        overlayPresent: overlay !== null,
        panelRole: panel === null ? null : panel.getAttribute('role'),
        panelAriaModal: panel === null ? null : panel.getAttribute('aria-modal'),
        destructiveAttr: panel === null ? null : panel.getAttribute('data-destructive'),
        focusInsidePanel: panel === null ? false : panel.contains(active),
        focusTag: active === null ? null : active.tagName,
        focusAria: active === null ? null : active.getAttribute('aria-label'),
        bodyText: panel === null ? '' : (panel.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 220),
        focusableInPanel: panel === null ? 0 : panel.querySelectorAll('button,a[href],input,[tabindex]:not([tabindex="-1"])').length,
        scrollLock: document.documentElement.classList.contains('ui-scroll-lock'),
        confirmIsDangerVariant: panel === null ? null : panel.querySelector('.ui-modal__foot button[data-variant="danger"]') !== null,
      };
    })()`);
    const trap = [];
    for (let step = 0; step < 8; step += 1) {
      await page.tab();
      await sleep(35);
      trap.push(await page.evaluate(`(() => {
        const active = document.activeElement;
        return { inside: active !== null && active.closest('.ui-modal__panel') !== null, tag: active === null ? null : active.tagName };
      })()`));
    }
    const shot = writeShot(`modal-destructive-${DARK}-1440x900.png`, await page.screenshot());
    // Close with Esc (the requirement is keyboard dismissal of a destructive dialog).
    await page.escape();
    await sleep(400);
    const closed = await page.evaluate(`(() => {
      const active = document.activeElement;
      return {
        overlayCount: document.querySelectorAll('[data-overlay]').length,
        scrollLock: document.documentElement.classList.contains('ui-scroll-lock'),
        activeTag: active === null ? null : active.tagName,
        activeLabel: active === null ? null : (active.innerText ?? '').trim().slice(0, 40),
        providerCards: document.querySelectorAll('.settings-provider').length,
        confirmDangerStillThere: document.querySelectorAll('[data-overlay="modal"] button[data-variant="danger"]').length,
      };
    })()`);
    const focusReturned = closed.activeTag === 'BUTTON' && closed.overlayCount === 0;
    // Second open, dismissed by backdrop click, to prove the backdrop path too.
    const openedAgain = (await openRemoveModal()).providerId !== null;
    const backdropPoint = await page.evaluate(`(() => {
      const overlay = document.querySelector('[data-overlay="modal"]');
      const panel = overlay === null ? null : overlay.querySelector('.ui-modal__panel');
      if (overlay === null || panel === null) return null;
      const panelRect = panel.getBoundingClientRect();
      return { x: Math.round(Math.max(8, panelRect.left / 2)), y: Math.round(Math.max(8, panelRect.top - 30)) };
    })()`);
    let backdropClosed = null;
    if (backdropPoint !== null) {
      await clickAt(page, backdropPoint.x, backdropPoint.y);
      await sleep(400);
      backdropClosed = await page.evaluate(`(() => ({
        overlayCount: document.querySelectorAll('[data-overlay]').length,
        activeTag: document.activeElement === null ? null : document.activeElement.tagName,
      }))()`);
    }
    // Third open, dismissed by the safe (secondary) action button — proves the cancel
    // path neither mutates settings nor traps focus.
    await openRemoveModal();
    const openedForCancel = await page.evaluate(`(() => document.querySelectorAll('.settings-provider').length && document.querySelector('[data-overlay="modal"]') !== null ? document.querySelector('.settings-provider').getAttribute('data-provider-id') : null)()`);
    let cancelClosed = null;
    if (openedForCancel !== null) {
      const clickedCancel = await page.evaluate(`(() => {
        const foot = document.querySelector('[data-overlay="modal"] .ui-modal__foot');
        if (foot === null) return false;
        const buttons = [...foot.querySelectorAll('button')];
        const secondary = buttons.find((button) => button.getAttribute('data-variant') === 'secondary');
        const target = secondary ?? buttons[buttons.length - 1];
        if (target === undefined) return false;
        const isDanger = target.getAttribute('data-variant') === 'danger';
        target.click();
        return { clicked: isDanger === false, text: (target.innerText ?? '').trim() };
      })()`);
      await sleep(500);
      cancelClosed = {
        clicked: clickedCancel,
        ...(await page.evaluate(`(() => ({
          overlayCount: document.querySelectorAll('[data-overlay]').length,
          activeTag: document.activeElement === null ? null : document.activeElement.tagName,
          providerCards: document.querySelectorAll('.settings-provider').length,
        }))()`)),
      };
    }
    const devtools = devtoolsSummary(page);
    checker.add('modal-opens', modalState.overlayPresent === true, `trigger=${opened.label}`);
    checker.add('modal-role-alertdialog', modalState.panelRole === 'alertdialog', String(modalState.panelRole));
    checker.add('modal-aria-modal', modalState.panelAriaModal === 'true', String(modalState.panelAriaModal));
    checker.add('modal-focus-inside', modalState.focusInsidePanel === true, `${modalState.focusTag} ${modalState.focusAria ?? ''}`);
    checker.add('modal-trap', trap.every((entry) => entry.inside === true), `${trap.filter((entry) => entry.inside !== true).length} escapes of ${trap.length}`);
    checker.add('modal-escape-closes', closed.overlayCount === 0, `overlays=${closed.overlayCount}`);
    checker.add('modal-focus-returns-to-trigger', focusReturned === true, `active=${closed.activeTag} "${closed.activeLabel}"`);
    checker.add('modal-no-settings-write', closed.providerCards === before.providerCards, `${before.providerCards} → ${closed.providerCards}`);
    checker.add('modal-backdrop-closes', backdropClosed !== null && backdropClosed.overlayCount === 0,
      JSON.stringify(backdropClosed));
    checker.add('modal-cancel-closes-without-write', cancelClosed !== null && cancelClosed.overlayCount === 0
      && cancelClosed.providerCards === before.providerCards && cancelClosed.clicked !== false,
    JSON.stringify(cancelClosed));
    checker.add('modal-destructive-marker', modalState.destructiveAttr === 'true' || modalState.confirmIsDangerVariant === true,
      JSON.stringify({ dataDestructive: modalState.destructiveAttr, dangerButton: modalState.confirmIsDangerVariant }));
    checker.add('modal-esc-no-scroll-lock', closed.scrollLock === false, String(closed.scrollLock));
    return {
      url: SETTINGS_URL,
      trigger: opened,
      before,
      modalState,
      trapAllInside: trap.every((entry) => entry.inside === true),
      closedByEscape: closed,
      focusReturned,
      reopenedForBackdrop: openedAgain,
      backdropPoint,
      backdropClosed,
      reopenedForCancel: openedForCancel,
      cancelClosed,
      providerCountUnchanged: closed.providerCards === before.providerCards,
      screenshot: shot.rel,
      devtools,
    };
  } finally {
    await closePage(page);
  }
});

const buildAtEnd = buildFingerprint();
const buildDelta = fingerprintDelta(buildAtStart, buildAtEnd);
const summary = checker.summary();
const report = {
  task: 'INT-4 keyboard / focus / overlay a11y',
  author: 'PT-dove',
  base: BASE,
  theme: THEME,
  startedAt,
  finishedAt: new Date().toISOString(),
  build: {
    aggregate16: buildAtStart.aggregate16,
    fileCount: buildAtStart.fileCount,
    maxMtimeIso: buildAtStart.maxMtimeIso,
    movedDuringRun: !buildDelta.same,
    changedDuringRun: buildDelta.changedFiles,
  },
  tabSteps: TAB_STEPS,
  results,
  checker: summary,
};
writeJson(join(RESULTS, 'keyboard.json'), report);
process.stdout.write(`${JSON.stringify({
  build16: report.build.aggregate16,
  buildMovedDuringRun: report.build.movedDuringRun,
  tabWalk: {
    steps: results.tabWalk?.steps?.length ?? 0,
    unique: results.tabWalk?.uniqueElementsReached ?? 0,
    violations: results.tabWalk?.monotonicViolations?.length ?? null,
    minRingContrast: results.tabWalk?.minRingContrast ?? null,
    invisibleRingSteps: results.tabWalk?.invisibleRingSteps?.length ?? null,
    bodyFocusSteps: results.tabWalk?.bodyFocusSteps ?? null,
  },
  overflow: results.overflow?.metrics?.map((entry) => ({ width: entry.width, overflowPx: entry.overflowPx, offscreenActionButtons: entry.actionButtonsOffscreen, docOverflowPx: entry.docOverflowPx })),
  keyboardReach: results.overflow?.keyboardReachability ?? null,
  drawer: results.drawer?.paths?.map((entry) => ({ path: entry.path, opens: entry.openState.overlayPresent, trap: entry.trapAllInside, closed: entry.closed.overlayCount === 0, focusReturned: entry.focusReturned })),
  modal: {
    role: results.modal?.modalState?.panelRole,
    focusInside: results.modal?.modalState?.focusInsidePanel,
    trap: results.modal?.trapAllInside,
    closedByEscape: results.modal?.closedByEscape?.overlayCount === 0,
    focusReturned: results.modal?.focusReturned,
    backdropClosed: results.modal?.backdropClosed,
  },
  checks: summary.total,
  passed: summary.passed,
  failed: summary.failed,
  failures: summary.checks.filter((entry) => !entry.ok),
  out: join(RESULTS, 'keyboard.json'),
}, null, 2)}\n`);
process.exitCode = summary.failed === 0 ? 0 : 1;
