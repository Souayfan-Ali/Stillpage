/**
 * A page whose pop-up the sentinel blocked (P2-62, P2-60b journeys): `popup-sentinel.js` registered by the test on
 * `guard.example`, where the default mode `off` registers no guard (the panel only needs a sentinel to ask), a routed page with one swapped-href link, a real
 * click on it, and the panel opened for that tab; plus keyboard-only helpers for the panel.
 */
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test';

const GUARD_ORIGIN = 'https://guard.example';
export const GUARD_HOST = 'guard.example';
const PAGE = `<!doctype html><title>guard</title><style>body{margin:0} a{display:inline-block;margin:20px;padding:10px;background:#eee}</style>
<a id="swap" target="_blank" href="https://news.example/story">swap</a>
<script>document.getElementById('swap').addEventListener('pointerdown', (e) => { e.currentTarget.href = 'https://ads.example/landing'; });</script>`;

async function registerSentinel(sw: Worker): Promise<void> {
  // The install reconcile removes registrations it does not know: register only after it finished.
  await expect.poll(() => sw.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] !== undefined), { timeout: 60_000 }).toBe(true);
  await sw.evaluate(async (origin) => {
    await chrome.scripting.registerContentScripts([
      { id: 'e2e-sentinel', js: ['popup-sentinel.js'], matches: [`${origin}/*`], runAt: 'document_start', allFrames: false, world: 'ISOLATED', persistAcrossSessions: false },
    ]);
  }, GUARD_ORIGIN);
}

/** The guard page with one pop-up blocked by the sentinel (a swapped href, G9/G10). */
export async function pageWithBlockedPopup(context: BrowserContext, sw: Worker): Promise<{ readonly page: Page; readonly tabId: number }> {
  await registerSentinel(sw);
  await context.route(`${GUARD_ORIGIN}/**`, (route) => route.fulfill({ body: PAGE, contentType: 'text/html' }));
  await context.route('https://*.example/**', (route) => (route.request().url().startsWith(GUARD_ORIGIN) ? route.fallback() : route.fulfill({ body: '<title>x</title>', contentType: 'text/html' })));
  const page = await context.newPage();
  await page.goto(`${GUARD_ORIGIN}/`);
  const popup = context.waitForEvent('page', { timeout: 4_000 }).then((p) => { void p.close(); return true; }, () => false);
  await page.click('#swap');
  expect(await popup, 'the sentinel blocked the swapped-href pop-up').toBe(false);
  const tabId = await sw.evaluate(async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0]?.id ?? -1, GUARD_ORIGIN);
  return { page, tabId };
}

export async function openPanelFor(context: BrowserContext, extensionId: string, tabId: number, host = GUARD_HOST): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/popup.html?tabId=${String(tabId)}`);
  await expect(p.getByRole('heading', { level: 2, name: host })).toBeVisible();
  return p;
}

/** Keyboard only: Tab until the control named `name` (role `role`) has focus. */
export async function tabTo(p: Page, name: string | RegExp, role: 'button' | 'combobox' | 'checkbox' = 'button', max = 16): Promise<void> {
  const target = p.getByRole(role, { name, exact: typeof name === 'string' });
  await expect(target, `${role} ${String(name)}`).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement, undefined, { timeout: 2_000 }).catch(() => false)) break;
    await p.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Keyboard only: Tab to the button `name`, then Enter. */
export async function press(p: Page, name: string | RegExp): Promise<void> {
  await tabTo(p, name);
  await p.keyboard.press('Enter');
}

/** The site's stored pop-up policy, read from the vault on an extension page. */
export const sitePolicy = (p: Page, host = GUARD_HOST): Promise<unknown> => p.evaluate(async (h) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('vault', 1);
    req.onsuccess = () => { resolve(req.result); };
    req.onerror = () => { reject(req.error ?? new Error('open')); };
  });
  const value = await new Promise<unknown>((resolve) => {
    const req = db.transaction('kv').objectStore('kv').get('settings');
    req.onsuccess = () => { resolve(req.result); };
  });
  db.close();
  return (value as { popups?: { sites?: Record<string, string> } } | undefined)?.popups?.sites?.[h] ?? null;
}, host);
