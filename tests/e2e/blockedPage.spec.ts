/**
 * J18 with the blocked page (P2-55, pop-up notes §6.2, testing notes §6). The real build (its own manifest, so
 * `blocked.html` is web-accessible, and the real `popup-destinations.json` / `popups` ruleset) with the
 * boot counter; every host resolves to the local fixture server, so a request that escaped the rules
 * would show in its log. Rows: a fresh pop-up to a listed host closes itself (≥ 99 of 100, created →
 * removed p95 ≤ 150 ms, 0 worker boots); a typed visit stays with Close tab first; a same-tab navigation
 * stays with Go back first; a hostile fragment shows no host and no Proceed once; with site access
 * "on click" the listed host is blocked by Chrome and never loaded. axe 0 on the shown page. A lifted
 * destination (D-55 / D-55a: a-ads.com, which easylist/ubo also document-block) shows the blocked page
 * instead of Chrome's error page, names the exact address, and Proceed once opens that address only.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PRODUCT_NAME } from '../../src/core/brand.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { closeAll, expectNoSurvivors } from './helpers/browser.js';
import { withBootCounter } from './helpers/bootCounter.js';
import { reconciledSince, setSiteAccess } from './helpers/corpus.js';
import { BUILD_DIR, TEMP_PREFIX } from './helpers/fixtureExtension.js';
import { expectBudget } from './helpers/perf.js';
import { PROPAGATION_WINDOW_MS } from './helpers/settle.js';
import { startSession, type Session } from './helpers/session.js';

const POPUPS = 100;
const CLOSED_MIN = 99;
const CLOSE_P95_MS = 150;
/** How long to wait for a pop-up to close itself: a bound, not the budget (`CLOSE_P95_MS`, asserted by test:perf). */
const CLOSE_WAIT_MS = 10_000;
const OPENER = 'https://opener.test/';
const AXE_SOURCE = readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

let server: FixtureServer;
let extensionRoot: string;
let listed: string;
const LIFTED = 'a-ads.com';
const LIFT_OPENER = 'https://lift-opener.test/';
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extensionRoot = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  const dir = path.join(extensionRoot, 'ext');
  await cp(BUILD_DIR, dir, { recursive: true });
  await writeFile(path.join(dir, 'background.js'), withBootCounter(await readFile(path.join(dir, 'background.js'), 'utf8')));
  // The boot-counter probe page the session helper opens (the corpus extension adds the same file).
  await writeFile(path.join(dir, 'fx.html'), '<!doctype html><title>fx</title>');
  const hosts = JSON.parse(await readFile(path.join(dir, 'popup-destinations.json'), 'utf8')) as string[];
  // An ordinary (not lifted) destination: its Proceed once is host-wide and the page never shows the address.
  const lifted = new Set(Object.values(JSON.parse(await readFile(path.join(dir, 'popup-lifted.json'), 'utf8')) as Record<string, string[]>).flat());
  expect(lifted.has(LIFTED)).toBe(true);
  const ordinary = hosts.filter((h) => !lifted.has(h));
  listed = ordinary[Math.floor(ordinary.length / 2)] ?? '';
});

test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});

test.afterAll(async () => {
  await server.close();
  await rm(extensionRoot, { recursive: true, force: true });
  await expectNoSurvivors();
});

async function session(): Promise<Session> {
  const s = await startSession(server, path.join(extensionRoot, 'ext'), contexts);
  await s.context.route(OPENER, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>opener</title>
    <button id="pop">pop</button><button id="same">same</button>
    <script>document.getElementById('pop').onclick=()=>{window.open('https://${listed}/landing?x=1')};
    document.getElementById('same').onclick=()=>{location.href='https://${listed}/same'};</script>` }));
  // The redirect rules exist only with all-sites access; wait until the reconciler installed them.
  await expect.poll(() => s.worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.action.type === 'redirect').length)).toBeGreaterThan(0);
  return s;
}

const reachedListed = (): boolean => server.log().some((r) => r.host === listed);

/** Turns the guard on (Smart) as the product does: auto-close needs the opener's sentinel to confirm (design review, P2-58). */
async function guardOn(s: Session): Promise<void> {
  const page = await s.context.newPage();
  await page.goto(`chrome-extension://${s.id}/popup.html?tabId=1`);
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ v: 1, type: 'c/setPopupMode', id: 'j18', payload: { mode: 'smart' } }))).toMatchObject({ ok: true });
  await expect.poll(() => s.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).some((r) => r.id === 'popup-shim')), { timeout: 60_000 }).toBe(true);
  await page.close();
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(await AXE_SOURCE);
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { id: string }[] }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
    return r.violations.map((v) => v.id);
  });
}

const pctl = (values: readonly number[], q: number): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? Infinity;

test('J18 guard on: fresh pop-ups a page script opens to a listed host close themselves; never reached; 0 worker boots', { tag: '@budget' }, async () => {
  test.setTimeout(240_000);
  const s = await session();
  await guardOn(s);
  const opener = await s.context.newPage();
  await opener.goto(OPENER);
  server.clearLog();
  const boots = await s.probe.boots();
  const latencies: number[] = [];
  let closed = 0;
  for (let i = 0; i < POPUPS; i += 1) {
    const created = s.context.waitForEvent('page');
    await opener.click('#pop');
    const popup = await created;
    const t0 = Date.now();
    const gone = await popup.waitForEvent('close', { timeout: CLOSE_WAIT_MS }).then(() => true, () => false);
    if (gone) {
      closed += 1;
      latencies.push(Date.now() - t0);
    } else await popup.close().catch(() => undefined);
  }
  test.info().annotations.push({ type: 'J18 close', description: `${String(closed)} / ${String(POPUPS)} closed; created → removed p50 ${String(pctl(latencies, 0.5))} ms, p95 ${String(pctl(latencies, 0.95))} ms` });
  expect(closed).toBeGreaterThanOrEqual(CLOSED_MIN);
  expectBudget('created → removed p95 (ms)', pctl(latencies, 0.95), CLOSE_P95_MS);
  expect(reachedListed()).toBe(false);
  expect(await s.probe.boots()).toBe(boots);
});

test('J18 guard off: a script-opened pop-up to a listed host stays on the blocked page, Close tab first; never reached', async () => {
  const s = await session();
  const opener = await s.context.newPage();
  await opener.goto(OPENER);
  server.clearLog();
  const created = s.context.waitForEvent('page');
  await opener.click('#pop');
  const popup = await created;
  await expect(popup.locator('h1')).toHaveText('This page was blocked');
  await expect(popup.locator('.actions button').first()).toHaveText('Close tab');
  expect(reachedListed()).toBe(false);
});

test('J18 guard on: a tab the user opens to a listed host is never auto-closed (openerTabId is set for user tabs too)', async () => {
  const s = await session();
  await guardOn(s);
  const opener = await s.context.newPage();
  await opener.goto(OPENER);
  const page = await s.context.newPage();
  await page.goto(`https://${listed}/typed`).catch(() => undefined);
  await expect(page.locator('h1')).toHaveText('This page was blocked');
  await page.waitForTimeout(500);
  expect(page.isClosed()).toBe(false);
});

test('J18: a typed visit in a tab stays (Go back first: the tab has history; host as text, axe 0); Close tab; Proceed once opens it in that tab only', async () => {
  const s = await session();
  const page = await s.context.newPage();
  await page.goto(`https://${listed}/typed?secret=1`).catch(() => undefined);
  await expect(page.locator('h1')).toHaveText('This page was blocked');
  expect(new URL(page.url()).pathname).toBe('/blocked.html');
  await expect(page.locator('strong')).toHaveText(listed);
  expect(await page.locator('body').textContent()).not.toContain('secret=1');
  // A tab Playwright opens has an `about:blank` entry, so history.length is 2, as for an address typed into
  // an existing tab: Go back first. The fresh-tab rows (no history) are the unit table's.
  await expect(page.locator('.actions button')).toHaveText(['Go back', 'Close tab']);
  // E22 / E23: the product name in the band; Proceed once a text link under the safe buttons.
  await expect(page.locator('.band .brand')).toHaveText(PRODUCT_NAME);
  await expect(page.locator('.proceed button.link')).toHaveText('Proceed once');
  expect(await axeViolations(page)).toEqual([]);
  // Close tab first, on a copy, so the Proceed-once tab can be checked afterwards.
  const copy = await s.context.newPage();
  await copy.goto(`https://${listed}/copy`).catch(() => undefined);
  await expect(copy.locator('h1')).toHaveText('This page was blocked');
  const closing = copy.waitForEvent('close');
  // The click closes the page it was made in; Playwright then reports the page gone, which is the point.
  await copy.click('text=Close tab', { noWaitAfter: true }).catch(() => undefined);
  await closing;
  // Proceed once: the worker adds a session allow rule for this host in this tab, then the page goes there.
  server.clearLog();
  await page.click('text=Proceed once');
  await expect.poll(() => page.url()).toBe(`https://${listed}/typed?secret=1`);
  await expect.poll(reachedListed).toBe(true);
  // Only this tab: another tab is still sent to the blocked page.
  const other = await s.context.newPage();
  await other.goto(`https://${listed}/other`).catch(() => undefined);
  await expect(other.locator('h1')).toHaveText('This page was blocked');
  expect(await s.worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.condition.requestDomains))).toEqual([[listed]]);
});

test('J18: a same-tab navigation stays with Go back first and goes back', async () => {
  const s = await session();
  const page = await s.context.newPage();
  await page.goto(OPENER);
  await page.click('#same');
  await expect(page.locator('h1')).toHaveText('This page was blocked');
  await expect(page.locator('.actions button')).toHaveText(['Go back', 'Close tab']);
  // Chrome sends no referrer across the DNR redirect to the extension page, so no "sent here by" line (recorded).
  await expect(page.locator('[data-sender]')).toHaveCount(0);
  await page.click('text=Go back');
  await expect.poll(() => page.url()).toBe(OPENER);
});

test('hostile fragment: no host, no Proceed once, nothing rendered as markup', async () => {
  const s = await session();
  const page = await s.context.newPage();
  await page.goto(`chrome-extension://${s.id}/blocked.html#javascript:alert(1)//<img src=x onerror=alert(2)>`);
  await expect(page.locator('h1')).toHaveText('This page was blocked');
  expect(await page.locator('img, strong').count()).toBe(0);
  await expect(page.locator('button')).toHaveText(['Go back', 'Close tab']);
});

/** D-95 E22: the visible gap between the mark's shape (it ends at 29/32 of its box) and the name is `--space-4`. */
const BRAND_OFFSETS = [{ width: 1280, offset: 106 }, { width: 390, offset: 79 }] as const;

test('E22 (D-95): the product name starts 16 px after the mark\'s shape, on a wide and a phone screen', async () => {
  const s = await session();
  const page = await s.context.newPage();
  for (const { width, offset } of BRAND_OFFSETS) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`chrome-extension://${s.id}/blocked.html`);
    await expect(page.locator('.band .brand')).toHaveText(PRODUCT_NAME);
    const left = await page.evaluate(() => {
      const box = (sel: string): number => document.querySelector(sel)?.getBoundingClientRect().left ?? NaN;
      return box('.band .brand') - box('.band');
    });
    expect(Math.abs(left - offset), `brand offset at ${String(width)} px`).toBeLessThanOrEqual(1);
  }
});

test('J18 site access "on click": the listed host is blocked by Chrome, not redirected, never loaded', async () => {
  const s = await session();
  const since = Date.now();
  await setSiteAccess(s.context, s.id, 'none', OPENER);
  await reconciledSince(s.worker, since, /^permissions$/);
  await expect.poll(() => s.worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.action.type === 'redirect').length)).toBe(0);
  server.clearLog();
  const page = await s.context.newPage();
  // The redirect rules' removal can reach new loads a little after the API resolved (`helpers/settle.ts`).
  await expect
    .poll(() => page.goto(`https://${listed}/typed`).then(() => page.url(), (e: unknown) => String(e)), { timeout: PROPAGATION_WINDOW_MS, intervals: [250, 500, 1_000] })
    .toMatch(/ERR_BLOCKED_BY_CLIENT/);
  expect(page.url()).not.toContain('blocked.html');
  expect(reachedListed()).toBe(false);
});

test('J18 lifted destination (D-55 / D-55a): a-ads.com shows the blocked page with its exact address, not Chrome\'s error page; Proceed once opens that address only', async () => {
  const s = await session();
  await expect.poll(() => s.worker.evaluate(async (h) => (await chrome.declarativeNetRequest.getDynamicRules())
    .some((r) => r.priority === 5_000_000 && (r.condition.requestDomains ?? []).includes(h)), LIFTED)).toBe(true);
  await s.context.route(LIFT_OPENER, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>opener</title>
    <button id="pop">pop</button><script>document.getElementById('pop').onclick=()=>{window.open('https://${LIFTED}/landing?x=1#top')};</script>` }));
  const opener = await s.context.newPage();
  await opener.goto(LIFT_OPENER);
  server.clearLog();
  const created = s.context.waitForEvent('page');
  await opener.click('#pop');
  const popup = await created;
  await expect(popup.locator('h1')).toHaveText('This page was blocked');
  expect(new URL(popup.url()).pathname).toBe('/blocked.html');
  await expect(popup.locator('[data-exact-url] code')).toHaveText(`https://${LIFTED}/landing?x=1`);
  expect(await axeViolations(popup)).toEqual([]);
  expect(server.log().some((r) => r.host === LIFTED)).toBe(false);
  await popup.getByRole('button', { name: 'Proceed once' }).click();
  // The exact address the rule names, without the fragment (Chromium matches navigations with it).
  await expect.poll(() => popup.url()).toBe(`https://${LIFTED}/landing?x=1`);
  await expect.poll(() => server.log().some((r) => r.host === LIFTED)).toBe(true);
  // One exact address: another address on the host, in the same tab, meets the blocked page again.
  await popup.goto(`https://${LIFTED}/other`).catch(() => undefined);
  await expect(popup.locator('h1')).toHaveText('This page was blocked');
  expect(await s.worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((r) => [r.priority, r.condition.urlFilter])))
    .toEqual([[5_000_001, `|https://${LIFTED}/landing?x=1|`]]);
});
