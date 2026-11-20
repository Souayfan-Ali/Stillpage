/**
 * The in-page notice on the real build (P2-59): the guard turned on as the user does (`c/setPopupMode` from
 * the toolbar panel page, the worker registers the sentinel and the shim), a routed page whose click-anywhere
 * script opens a window (G11, blocked in Smart), and readers for the notice inside its closed root over CDP
 * (the page cannot pierce it): button centres, the host's box and the accessibility tree.
 */
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test';

const NOTICE_ORIGIN = 'https://notice.example';
export const AD_URL = 'https://ad.example/x';
const REGISTERED = { timeout: 60_000 };
/** `NOTICE_ARM_DELAY_MS`, the visibility gate (400 ms, observed every 100 ms) and a margin. */
export const ARMED_MS = 1_500;

/** A long page (the notice must stay in the viewport) with a click-anywhere pop-up. */
export const noticePageHtml = (dir: 'ltr' | 'rtl' = 'ltr'): string => `<!doctype html><html lang="en" dir="${dir}"><title>notice</title>
<style>body{margin:0;height:2000px;font:16px sans-serif}p{margin:40px}</style>
<p id="text">Plain article text, not a control.</p>
<script>document.addEventListener('click', () => window.open('${AD_URL}'), true);</script>`;

/** Sends a settings command from the toolbar panel page, after the install reconcile. */
export async function command(context: BrowserContext, sw: Worker, extensionId: string, type: string, payload: unknown): Promise<void> {
  await expect.poll(() => sw.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] !== undefined), REGISTERED).toBe(true);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/popup.html?tabId=1`);
  const answer: unknown = await panel.evaluate(([t, p]) => chrome.runtime.sendMessage({ v: 1, type: t, id: 'e2e-notice', payload: p }), [type, payload] as const);
  expect(answer).toMatchObject({ ok: true });
  await panel.close();
}

/** Registered `popup-*` ids, sorted. */
export const guardIds = (sw: Worker): Promise<string[]> => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id).filter((id) => id.startsWith('popup-')).sort());

/** Smart everywhere, as the user turns it on; resolves once the worker registered the guard pair. */
export async function smartGuard(context: BrowserContext, sw: Worker, extensionId: string): Promise<void> {
  await command(context, sw, extensionId, 'c/setPopupMode', { mode: 'smart' });
  await expect.poll(() => guardIds(sw), REGISTERED).toEqual(expect.arrayContaining(['popup-sentinel', 'popup-shim']));
}

/** Routes the notice page (`html`) and the ad host, and opens the page. */
export async function openNoticePage(context: BrowserContext, html = noticePageHtml()): Promise<Page> {
  await context.route(`${NOTICE_ORIGIN}/**`, (route) => route.fulfill({ body: html, contentType: 'text/html' }));
  await context.route('https://ad.example/**', (route) => route.fulfill({ body: '<title>ad</title>', contentType: 'text/html' }));
  const page = await context.newPage();
  await page.goto(`${NOTICE_ORIGIN}/`);
  return page;
}

/** Real clicks `selector`; resolves whether a new window opened. */
export async function opens(page: Page, selector: string, waitMs = 3_000): Promise<boolean> {
  const popup = page.context().waitForEvent('page', { timeout: waitMs }).then((p) => { void p.close(); return true; }, () => false);
  await page.click(selector);
  return popup;
}

interface AxNode { readonly role?: { readonly value?: string }; readonly name?: { readonly value?: string }; readonly ignored?: boolean }

/** The page's accessibility tree as `role: name` lines (closed shadow roots included, as a screen reader sees them). */
export async function axLines(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: readonly AxNode[] };
    return nodes.filter((n) => n.ignored !== true).map((n) => `${n.role?.value ?? ''}: ${n.name?.value ?? ''}`);
  } finally {
    await cdp.detach();
  }
}

/** The notice host's box and computed colours (the host is light DOM: the test reads it as the page could). */
export const noticeBox = (page: Page): Promise<{ x: number; y: number; width: number; height: number; background: string; color: string } | null> => page.evaluate(() => {
  const host = document.documentElement.lastElementChild;
  if (host === null || host === document.body || host.tagName !== 'DIV') return null;
  const r = host.getBoundingClientRect();
  const style = getComputedStyle(host);
  return { x: r.x, y: r.y, width: r.width, height: r.height, background: style.backgroundColor, color: style.color };
});
