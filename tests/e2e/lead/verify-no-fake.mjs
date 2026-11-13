/**
 * verify-no-fake.mjs — hard criterion: when a capability is unavailable, the UI must say so
 * instead of inventing data or pretending an AI answered.
 *
 * Three experiments against the real daemon (no model credential, egress disabled):
 *   1. alert "AI explanation" → the daemon answers 409 EGRESS_DISABLED; the UI must surface
 *      an error, not a fabricated explanation paragraph;
 *   2. agent chat → the composer must be disabled with a visible reason (not a fake reply);
 *   3. model connectivity test → must report the honest 409 reason, not "ok".
 *
 * usage: node tests/e2e/lead/verify-no-fake.mjs [--base http://127.0.0.1:17512] [--out <dir>]
 */

import { launch } from '../lib/cdp.mjs';
import { Checker, parseArgs, viewUrl, writeEvidence } from './common.mjs';

/** Words that would indicate a fabricated model answer rather than an honest refusal. */
const FABRICATION = /(?:建议立即|综上所述|根据分析|风险评分|i recommend|in summary|the risk score)/iu;

async function settle(page, ms = 2500) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checker = new Checker('unavailable capabilities are reported honestly (no invented data, no fake AI)');
  const runs = {};
  const browser = await launch({ width: 1440, height: 900 });
  try {
    const page = await browser.newPage();

    // ---- 1) AI explanation trusts the daemon's 409 --------------------------
    await page.goto(viewUrl(args.base, 'alerts', { theme: 'dark', lang: 'zh-CN' }));
    await page.waitFor(`document.querySelectorAll('[data-action="explain-row"]').length > 0`, {
      timeoutMs: 20_000, label: 'alert rows with an explain action',
    });
    page.resetReport();
    await page.click('[data-action="explain-row"]');
    await page.waitFor(`document.querySelector('.ui-drawer') !== null`, { timeoutMs: 8000, label: 'explain drawer' });
    // Wait for the refusal to arrive instead of guessing a duration: the daemon's own
    // pre-flight is quick but this box is shared with five other browser runs, and
    // "generating…" is the honest intermediate state, not the final one.
    const refused = await (async () => {
      try {
        await page.waitFor(`/模型不可用|EGRESS_DISABLED|重试|retry|无法/u.test(document.querySelector('.ui-drawer')?.innerText ?? '')`,
          { timeoutMs: 40_000, intervalMs: 250, label: 'honest refusal in the explain drawer' });
        return true;
      } catch {
        return false;
      }
    })();
    checker.ok(refused, 'the explanation drawer eventually shows a refusal instead of a spinner');
    const explain = await page.evaluate(`(() => {
      const drawer = document.querySelector('.ui-drawer');
      const text = (drawer?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      return {
        text: text.slice(0, 1200),
        hasError: /EGRESS_DISABLED|egress|未启用|禁用|no credential|缺少凭据|模型不可用|无法|failed|错误/iu.test(text),
        hasRetry: drawer !== null && /retry|重试/iu.test(text),
        // A streaming answer would put long prose here; a refusal is short.
        proseLength: text.length,
        fabricates: ${FABRICATION.toString()}.test(text),
        stillGenerating: /正在生成|generating/iu.test(text),
      };
    })()`);
    runs.explain = { ...explain, devtools: page.report().badResponses };
    checker.ok(explain.hasError === true, 'explanation failure is surfaced to the user', explain.text);
    checker.ok(explain.fabricates === false, 'no fabricated analysis text is shown', explain.text);
    checker.ok(explain.proseLength < 900, 'the drawer stays a refusal, not a long invented answer', explain.proseLength);
    checker.ok(page.report().badResponses.some((entry) => entry.status === 409) === true,
      'the browser really saw the daemon 409 (no silent swallowing)', page.report().badResponses);
    await page.escape();
    await settle(page, 400);

    // ---- 2) agent chat is disabled with a reason, not faked ----------------
    await page.goto(viewUrl(args.base, 'agent', { theme: 'dark', lang: 'zh-CN' }));
    await settle(page, 2500);
    const agent = await page.evaluate(`(() => {
      const textarea = document.querySelector('textarea');
      const root = document.querySelector('#view-root');
      const text = (root?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      return {
        hasComposer: textarea !== null,
        composerDisabled: textarea === null ? null : textarea.disabled === true,
        placeholder: textarea?.getAttribute('placeholder') ?? null,
        text: text.slice(0, 700),
        mentionsUnavailable: /engine|harness|credential|凭据|未配置|不可用|disabled/iu.test(text),
        fabricates: ${FABRICATION.toString()}.test(text),
      };
    })()`);
    runs.agent = agent;
    checker.ok(agent.hasComposer === true, 'agent page has a composer');
    checker.ok(agent.composerDisabled === true, 'composer is disabled when chat is not available', agent);
    checker.ok(agent.mentionsUnavailable === true, 'the page explains why chat is unavailable', agent.text);
    checker.ok(agent.fabricates === false, 'agent page shows no fabricated answer', agent.text);

    // ---- 3) model connectivity must not claim health without a credential --
    const models = await page.evaluate(`(async () => {
      const response = await fetch('/api/v1/models');
      return { status: response.status, body: await response.text() };
    })()`);
    const payload = JSON.parse(models.body);
    const provider = payload.providers?.[0] ?? {};
    runs.models = { hasCredential: provider.hasCredential, healthy: provider.healthy, egressEnabled: payload.egressEnabled };
    checker.ok(provider.hasCredential === false, 'daemon reports no credential (honest state)', provider.hasCredential);
    checker.ok(provider.healthy === null || provider.healthy === false,
      'provider is not reported healthy without a credential', provider.healthy);
    checker.equal(payload.egressEnabled, false, 'egress is reported disabled');

    // And the settings page must not present the provider as connected.
    await page.goto(viewUrl(args.base, 'models', { theme: 'dark', lang: 'zh-CN' }));
    await settle(page, 2500);
    const modelsPage = await page.evaluate(`(() => {
      const root = document.querySelector('#view-root');
      const text = (root?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      return { textLength: text.length, text: text.slice(0, 500), claimsConnected: /已连接|connected|正常|healthy/iu.test(text) && !/未|not|no /iu.test(text) };
    })()`);
    runs.modelsPage = modelsPage;
    checker.ok(modelsPage.textLength > 500, 'models page renders its groups', modelsPage.textLength);
    checker.ok(modelsPage.claimsConnected === false, 'models page does not claim a connected provider', modelsPage.text);
  } finally {
    await browser.close();
  }

  const summary = checker.summary();
  const evidence = writeEvidence(args.out, 'no-fake.json', { at: new Date().toISOString(), base: args.base, runs, summary });
  process.stdout.write(`${JSON.stringify({ summary, evidence }, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verify-no-fake: ${error?.stack ?? error}\n`);
  process.exit(1);
});

