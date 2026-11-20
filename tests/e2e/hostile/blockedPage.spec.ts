/**
 * J15 · the blocked page (P2-55): crafted addresses that land on it, a page that frames it, an opener that
 * holds its window, and "Proceed once" forged by script or for an address that is not listed. The listed
 * destination is the harness's `$popup` host; the reconciler redirects it to `blocked.html` (all-sites access).
 */
import { test, expect, type Page } from '@playwright/test';
import { expectNoExtensionNetwork, LISTED, openHostile, POLL, SESSION_TIMEOUT_MS, startHostile, stopHostile, type Hostile } from './harness.js';

/** The opener's probes run 50 and 300 ms after its `window.open`. */
const OPENER_PROBES_MS = 600;

let h: Hostile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(SESSION_TIMEOUT_MS);
  h = await startHostile();
  // The redirect rules exist only with all-sites access; the install reconcile adds them.
  await expect.poll(() => h.worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.action.type === 'redirect').length), POLL).toBeGreaterThan(0);
});
test.afterAll(async () => { await stopHostile(); });

const sessionRules = (): Promise<number> => h.worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).length);
const reachedListed = (): boolean => h.server.log().some((r) => r.host === LISTED);
const dynamicUrl = (): Promise<string> => h.worker.evaluate(() => chrome.runtime.getURL('blocked.html'));

async function landOn(url: string): Promise<Page> {
  const tab = await h.context.newPage();
  await tab.goto(url).catch(() => undefined);
  await expect(tab.locator('h1')).toHaveText('This page was blocked');
  return tab;
}

test('a crafted address shows the host as text only: no markup, no path, no query', async () => {
  const tab = await landOn(`https://${LISTED}/"><img src=x onerror="document.title='pwned'"><script>document.title='pwned'</script>?q=<svg/onload=alert(1)>&secret=1`);
  await expect(tab.locator('strong')).toHaveText(LISTED);
  expect(await tab.locator('main img, main script, main svg, main iframe').count()).toBe(0);
  const text = await tab.locator('body').textContent();
  expect(text).not.toContain('secret');
  expect(text).not.toContain('onerror');
  expect(await tab.title()).not.toBe('pwned');
  await tab.close();
});

/** Runs `expression` in the tab without a user gesture (Playwright's `evaluate` carries one). */
async function scriptWithoutGesture(tab: Page, expression: string): Promise<unknown> {
  const cdp = await h.context.newCDPSession(tab);
  try {
    const { result } = (await cdp.send('Runtime.evaluate', { userGesture: false, returnByValue: true, expression })) as { result: { value?: unknown } };
    return result.value;
  } finally {
    await cdp.detach();
  }
}

test('a script click on Proceed once adds no rule and goes nowhere, even while the page has transient activation', async () => {
  // Measured: blocked.html starts with transient activation (≈ 5 s) however the tab got there, so
  // `navigator.userActivation` alone does not tell a script click from the user's; the click must be trusted.
  const tab = await openHostile(h, 'blocked-frame');
  await scriptWithoutGesture(tab, `location.href = 'https://${LISTED}/forged'`);
  await expect(tab.locator('h1')).toHaveText('This page was blocked');
  test.info().annotations.push({ type: 'activation at load', description: String(await scriptWithoutGesture(tab, 'navigator.userActivation.isActive')) });
  const before = await sessionRules();
  await scriptWithoutGesture(tab, `(() => {
    const proceed = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Proceed once');
    proceed.click();
    proceed.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await tab.waitForTimeout(1_000);
  expect(new URL(tab.url()).pathname).toBe('/blocked.html');
  expect(await sessionRules()).toBe(before);
  expect(reachedListed()).toBe(false);
  await tab.close();
});

test('a forged fragment for an unlisted host: a real click on Proceed once is refused by the worker', async () => {
  const tab = await landOn(`${await dynamicUrl()}#https://unlisted.hostile-dest.example/x`);
  await expect(tab.locator('strong')).toHaveText('unlisted.hostile-dest.example');
  const before = await sessionRules();
  await tab.getByRole('button', { name: 'Proceed once' }).click();
  await expect(tab.locator('[role="alert"]')).toHaveText('Could not open it. Try again, or go back.');
  expect(new URL(tab.url()).pathname).toBe('/blocked.html');
  expect(await sessionRules()).toBe(before);
  await tab.close();
});

test('credentials, javascript: and an oversized fragment: no host and no Proceed once', async () => {
  const base = await dynamicUrl();
  for (const fragment of [`https://user:pass@${LISTED}/`, 'javascript:alert(1)//https://x.example/', `https://${LISTED}/${'a'.repeat(9_000)}`, `https://${LISTED}%2fevil.example/`]) {
    const tab = await landOn(`${base}#${fragment}`);
    await expect(tab.locator('strong')).toHaveCount(0);
    await expect(tab.getByRole('button', { name: 'Proceed once' })).toHaveCount(0);
    expect(await tab.locator('body').textContent()).not.toContain('pass');
    await tab.close();
  }
});

test('a web page cannot frame the blocked page by its static address; a framed dynamic copy draws and does nothing', async () => {
  const tab = await openHostile(h, 'blocked-frame');
  expect(await tab.evaluate(() => (window as unknown as { __runtime: () => string }).__runtime())).toBe('undefined');
  const before = await sessionRules();
  await tab.evaluate((url) => (window as unknown as { __frame: (u: string) => Promise<unknown> }).__frame(url), `chrome-extension://${h.session.id}/blocked.html#https://${LISTED}/`);
  // Refused: `use_dynamic_url` makes the static address unreachable from web pages (an error frame).
  expect(tab.frames().map((f) => f.url())).toContain('chrome-error://chromewebdata/');
  expect(tab.frames().some((f) => f.url().includes('blocked.html'))).toBe(false);
  // Worst case: the page somehow holds the dynamic address.
  const framed = await tab.evaluate((url) => (window as unknown as { __frame: (u: string) => Promise<{ readable: boolean }> }).__frame(url), `${await dynamicUrl()}#https://${LISTED}/`);
  expect(framed.readable).toBe(false);
  // The framed document reports the real id, as the picker panel does (P2-19).
  const copy = tab.frames().find((f) => f.url().includes('/blocked.html'));
  expect(copy).toBeDefined();
  expect(await copy?.locator('button').count()).toBe(0);
  expect(await copy?.evaluate(() => document.body.children.length)).toBe(0);
  expect(await sessionRules()).toBe(before);
  expect(await tab.evaluate(() => (window as unknown as { __errors: string[] }).__errors)).toEqual([]);
  await tab.close();
});

test('the opener holding the pop-up window can neither read, re-target nor drive the blocked page', async () => {
  const tab = await openHostile(h, 'blocked-opener');
  h.server.clearLog();
  const before = await sessionRules();
  const popup = h.context.waitForEvent('page');
  await tab.evaluate((url) => (window as unknown as { __open: (u: string) => boolean }).__open(url), `https://${LISTED}/landing?x=1`);
  const opened = await popup;
  // The default mode is `off`: no sentinel on the opener to confirm a script open, so the blocked page stays,
  // with "Close tab" first and the listed host as text (P2-58, design review: it closes itself only on that confirmation).
  await expect(opened.locator('h1')).toHaveText('This page was blocked', POLL);
  await expect(opened.locator('strong')).toHaveText(LISTED);
  await expect(opened.locator('button').first()).toHaveText('Close tab');
  await tab.waitForTimeout(OPENER_PROBES_MS);
  const probe = await tab.evaluate(() => (window as unknown as { __probe: string[] }).__probe);
  // Before the redirect commits the window is still the opener's initial about:blank (same origin, harmless);
  // once it is the blocked page, nothing of it is readable.
  expect(probe.filter((p) => p.startsWith('href:') && p !== 'href:SecurityError' && p !== 'href:about:blank')).toEqual([]);
  test.info().annotations.push({ type: 'opener probe', description: probe.join(' ') });
  // The opener's posts and fragment writes changed nothing on the page.
  expect(opened.isClosed()).toBe(false);
  await expect(opened.locator('strong')).toHaveText(LISTED);
  expect(await opened.locator('body').textContent()).not.toContain('evil');
  await opened.close();
  expect(reachedListed()).toBe(false);
  expect(await sessionRules()).toBe(before);
  await tab.close();
});

test('J16 row: no extension-initiated request during the blocked-page probes', () => {
  expectNoExtensionNetwork(h);
});
