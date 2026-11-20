/**
 * D-80 (P3-17 item A): a hide saved in one tab applies in another open tab of the same site, and in its
 * same-site frame, without a reload; a Remove in the dashboard shows it there again. The `user-cosmetic`
 * script re-reads its own `uf:` keys on `storage.onChanged` and replaces its one adopted sheet: the page
 * sees no DOM mutation and no change to its adopted sheets.
 */
import { expect, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { test } from './fixtures.js';
import { hideSomething, HIDE_ORIGIN, mirror, pickAndHideAlways, RECONCILE, userScript } from './helpers/hider.js';
import { POLL } from './helpers/settingsPages.js';

const PAGE = `<!doctype html><title>live</title><style>body{margin:0}div,p,iframe{display:block;width:300px;height:120px;margin:20px;background:#ddd}</style>
<div id="ad" class="banner">ad</div><p id="keep">keep</p><iframe src="/frame.html" title="same site"></iframe>`;
const FRAME = '<!doctype html><style>p{height:40px}</style><p id="keep">frame keep</p>';

async function openLive(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${HIDE_ORIGIN}/`);
  return page;
}

const shown = (target: Page | Frame, sel: string): Promise<string> => target.locator(sel).evaluate((el) => getComputedStyle(el).display);
const frameOf = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.url().endsWith('/frame.html'));
  if (frame === undefined) throw new Error('no frame');
  return frame;
};

/** What the page itself can see: DOM mutations since `watch`, and its adopted sheets. */
const watch = (page: Page): Promise<void> => page.evaluate(() => {
  const w = window as unknown as { records: number };
  w.records = 0;
  new MutationObserver((list) => { w.records += list.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
});
const seen = (page: Page): Promise<{ records: number; adopted: number }> =>
  page.evaluate(() => ({ records: (window as unknown as { records: number }).records, adopted: document.adoptedStyleSheets.length }));

test('live: a hide saved in tab 1 applies in tab 2 and its frame without reload; a dashboard Remove undoes it', async ({ context, serviceWorker }) => {
  test.setTimeout(240_000);
  await context.route(`${HIDE_ORIGIN}/**`, (route) => route.fulfill({ body: new URL(route.request().url()).pathname === '/frame.html' ? FRAME : PAGE, contentType: 'text/html' }));
  const first = await openLive(context);
  await first.bringToFront();
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(first, '#ad');
  await expect.poll(() => userScript(serviceWorker), RECONCILE).toBe(true);

  const second = await openLive(context);
  await expect.poll(() => shown(second, '#ad'), POLL).toBe('none');
  expect(await shown(second, '#keep')).not.toBe('none');
  expect(await shown(frameOf(second), '#keep')).not.toBe('none');
  await watch(second);
  const before = await seen(second);

  // Save a second filter in tab 1 (reload first: the first pick's undo toast is still up).
  await first.reload();
  await first.bringToFront();
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(first, '#keep');
  await expect.poll(() => mirror(serviceWorker), RECONCILE).toEqual({ 'uf:hide.example': { v: 1, s: ['#ad', '#keep'] } });
  await expect.poll(() => shown(second, '#keep'), POLL).toBe('none');
  await expect.poll(() => shown(frameOf(second), '#keep'), POLL).toBe('none');

  // Remove it in the dashboard: tab 2 and its frame show it again, still without a reload.
  const dash = await context.newPage();
  await dash.goto(serviceWorker.url().replace('background.js', 'dashboard.html#hidden'));
  await dash.getByRole('button', { name: 'Remove #keep on hide.example', exact: true }).click();
  await expect(dash.getByRole('status')).toHaveText('Removed. It shows again on that site. If a page still hides it, reload that page.', { timeout: POLL.timeout });
  await expect.poll(() => shown(second, '#keep'), POLL).not.toBe('none');
  await expect.poll(() => shown(frameOf(second), '#keep'), POLL).not.toBe('none');
  expect(await shown(second, '#ad')).toBe('none');
  expect(await seen(second)).toEqual(before);
  expect(before.records).toBe(0);
});
