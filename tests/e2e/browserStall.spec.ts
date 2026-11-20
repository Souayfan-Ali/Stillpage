/**
 * P2-65 (D-79b): no settings change may stall Chrome's browser process. A level change to or from Thorough used
 * to freeze the whole browser ≈ 1.5 s (Chrome re-processed 36,735 persistent patterns on every registration
 * call; the owner saw GNOME's "not responding" dialog). A CDP ping every 25 ms measures the longest gap while
 * each change is applied. Bar: ≤ 150 ms on a quiet machine (`test:perf`), ≤ 450 ms always (3×, load).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from './helpers/browser.js';
import { expectBudget } from './helpers/perf.js';
import { openPage, send, settled } from './helpers/settingsPages.js';

const QUIET_BAR_MS = 150;
const LOADED_BAR_MS = QUIET_BAR_MS * 3;
const PING_EVERY_MS = 25;
const SETTLE_AFTER_MS = 300;

test.setTimeout(240_000);
test.afterEach(async () => { await closeAll(); });
test.afterAll(async () => { await expectNoSurvivors(); });

/** The longest browser-process ping gap while `action` runs and the reconciler settles afterwards. */
async function longestStall(context: BrowserContext, page: Page, action: () => Promise<unknown>): Promise<number> {
  const cdp = await context.newCDPSession(page);
  const stop = new AbortController();
  let worst = 0;
  const pinger = (async () => {
    while (!stop.signal.aborted) {
      const started = performance.now();
      await cdp.send('Browser.getVersion');
      worst = Math.max(worst, performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, PING_EVERY_MS));
    }
  })();
  try {
    expect(await action()).toMatchObject({ ok: true });
    await settled(page);
    await page.waitForTimeout(SETTLE_AFTER_MS);
  } finally {
    stop.abort();
    await pinger;
    await cdp.detach();
  }
  return Math.round(worst);
}

const CHANGES: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['a site to Thorough', 'c/setSiteLevel', { hostname: 'news.example', level: 'thorough' }],
  ['the site back to Standard', 'c/setSiteLevel', { hostname: 'news.example', level: 'standard' }],
  ['Thorough as the default', 'c/setDefaultLevel', { level: 'thorough' }],
  ['Standard as the default', 'c/setDefaultLevel', { level: 'standard' }],
  ['the cookie pack on', 'c/setPack', { pack: 'cookies', enabled: true }],
  ['the cookie pack off', 'c/setPack', { pack: 'cookies', enabled: false }],
  ['the pop-up guard on', 'c/setPopupMode', { mode: 'smart' }],
  ['the pop-up guard off', 'c/setPopupMode', { mode: 'off' }],
  ['GPC on', 'c/setGpc', { enabled: true }],
  ['GPC off', 'c/setGpc', { enabled: false }],
];

test('@budget no settings change stalls the browser process (D-79b)', async () => {
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'dashboard.html');
  await settled(page);
  const stalls: (readonly [string, number])[] = [];
  for (const [what, type, payload] of CHANGES) {
    stalls.push([what, await longestStall(context, page, () => send(page, type, payload))]);
  }
  for (const [what, ms] of stalls) expectBudget(`browser stall, ${what} (ms)`, ms, QUIET_BAR_MS);
  expect(stalls.filter(([, ms]) => ms > LOADED_BAR_MS)).toEqual([]);
});
