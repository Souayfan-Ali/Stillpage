/**
 * J15 · the pop-up sentinel and its notice (P2-57, P2-59). The guard runs as shipped: the test sets "Strict"
 * for the hostile site from the toolbar panel page (`c/setSitePopupPolicy`), so the worker registers the
 * sentinel, the shim and the Strict flag there; an explicit `_blank` link is then blocked and the notice drawn.
 * Clicks are real (trusted) mouse events aimed at the notice's buttons inside its closed root (found over CDP;
 * the page cannot).
 *
 * The J15 finding (pass-through decoys luring a real click onto "Allow on this page") is fixed by P2-59's
 * IntersectionObserver v2 gate: those probes now pass as plain tests.
 */
import { test, expect, type Page } from '@playwright/test';
import { buttonCentre } from './closedShadow.js';
import { call, expectNoExtensionNetwork, HOST, strictSite, openHostile, POLL, SESSION_TIMEOUT_MS, startHostile, stopHostile, type Hostile } from './harness.js';

/** `NOTICE_ARM_DELAY_MS`, the visibility gate (400 ms visible, observed every 100 ms) and a margin: armed. */
const ARMED_MS = 1_500;
const OPENS_WAIT_MS = 3_000;

let h: Hostile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(SESSION_TIMEOUT_MS);
  h = await startHostile();
  await strictSite(h, HOST);
});
test.afterAll(async () => { await stopHostile(); });


async function opens(tab: Page, selector: string): Promise<boolean> {
  const popup = tab.context().waitForEvent('page', { timeout: OPENS_WAIT_MS }).then((p) => { void p.close(); return true; }, () => false);
  await tab.click(selector);
  return popup;
}

/** Opens the page and gets the explicit link blocked: the notice shows. */
async function blockedWithNotice(): Promise<Page> {
  const tab = await openHostile(h, 'sentinel');
  expect(await opens(tab, '#explicit')).toBe(false);
  await expect.poll(() => call(tab, '__noticeHost').then((v) => v !== null), POLL).toBe(true);
  return tab;
}

/** A real click on "Allow on this page" (where it is drawn after `prepare`); resolves whether the blocked link opens afterwards. */
async function lured(prepare: (tab: Page) => Promise<unknown>, beforeClick?: (tab: Page) => Promise<unknown>): Promise<boolean> {
  const tab = await blockedWithNotice();
  await prepare(tab);
  await tab.waitForTimeout(ARMED_MS);
  const allow = await buttonCentre(tab, 'Allow on this page');
  if (allow === null) throw new Error('no Allow button');
  await beforeClick?.(tab);
  await tab.mouse.click(allow.x, allow.y);
  await call(tab, '__uncover');
  const opened = await opens(tab, '#explicit');
  await tab.close();
  return opened;
}

test('positive control: an uncovered real click on "Allow on this page" after the arm delay works', async () => {
  expect(await lured(() => Promise.resolve())).toBe(true);
});

test('script-made events at the notice and a script click on a hidden ad link do nothing; forged messages raise nothing', async () => {
  const tab = await blockedWithNotice();
  await tab.waitForTimeout(ARMED_MS);
  const windows = h.context.pages().length;
  expect(await call(tab, '__synthetic')).toBe(true);
  expect(await call(tab, '__forge')).toBe('undefined');
  await tab.waitForTimeout(OPENS_WAIT_MS);
  expect(h.context.pages().length).toBe(windows);
  expect(await opens(tab, '#explicit')).toBe(false);
  expect(await tab.evaluate(() => (window as unknown as { __errors: string[] }).__errors)).toEqual([]);
  await tab.close();
});

test('a page modal over the notice: the click cannot reach it', async () => {
  expect(await lured((tab) => call(tab, '__modal'))).toBe(false);
});

test('a pass-through cover after the notice: the lured click leaves the link blocked', async () => {
  expect(await lured((tab) => call(tab, '__decoy', false))).toBe(false);
});

test('a pass-through top-layer popover decoy: the lured click leaves the link blocked', async () => {
  expect(await lured((tab) => call(tab, '__decoy', true))).toBe(false);
});

test('a decoy taken away 50 ms before the click: the click leaves the link blocked', async () => {
  expect(await lured((tab) => call(tab, '__decoy', false), async (tab) => { await call(tab, '__uncover'); await tab.waitForTimeout(50); })).toBe(false);
});

test('a notice shrunk by a root zoom: a real click on the tiny Allow leaves the link blocked', async () => {
  expect(await lured((tab) => call(tab, '__shrink'))).toBe(false);
});

test('J16 row: no extension-initiated request during the sentinel probes', () => {
  expectNoExtensionNetwork(h);
});
