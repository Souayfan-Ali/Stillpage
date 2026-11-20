/**
 * The element hider in the real build, shared by J8 (`userFilters.spec.ts`) and the hidden-items list
 * (`dashboardHidden.spec.ts`): a fixture page on a routed origin, the toolbar panel as a popup window
 * (Playwright cannot click the toolbar button), "Hide something", and a pick saved with "Hide always".
 */
import { expect, type BrowserContext, type Frame, type Page, type Worker } from '@playwright/test';
import { armed } from './pickerPanel.js';

export const HIDE_ORIGIN = 'https://hide.example';
/** A reconcile runs over the full registration set: ≈ 10 s on a loaded machine. */
export const RECONCILE = { timeout: 60_000 };
const PAGE = `<!doctype html><title>hide</title><style>body{margin:0}div,p{width:300px;height:120px;margin:20px;background:#ddd}</style>
<div id="ad" class="banner">ad</div><p id="keep">keep</p>`;

export async function openHidePage(context: BrowserContext): Promise<Page> {
  await context.route(`${HIDE_ORIGIN}/**`, (route) => route.fulfill({ body: PAGE, contentType: 'text/html' }));
  const page = await context.newPage();
  await page.goto(`${HIDE_ORIGIN}/`);
  await page.bringToFront();
  return page;
}

const tabId = (sw: Worker): Promise<number> => sw.evaluate(async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0]?.id ?? -1, HIDE_ORIGIN);

/** The install reconcile is done (under load it takes seconds; a save during it waits for the vault). */
const installed = (sw: Worker): Promise<void> =>
  expect.poll(() => sw.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] !== undefined), { timeout: 60_000 }).toBe(true);

/** The toolbar panel for the fixture page's tab, as a popup window. */
export async function openPanel(context: BrowserContext, sw: Worker): Promise<Page> {
  await installed(sw);
  const id = await tabId(sw);
  const opened = context.waitForEvent('page');
  await sw.evaluate(async (tab) => { await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?tabId=${String(tab)}`), type: 'popup' }); }, id);
  return opened;
}

/** The toolbar panel, then "Hide something". */
export async function hideSomething(context: BrowserContext, sw: Worker): Promise<void> {
  const popup = await openPanel(context, sw);
  await popup.getByRole('button', { name: 'Hide something' }).click();
}

export const overlayOpen = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.children.length === 3);
export const display = (page: Page, sel: string): Promise<string> => page.locator(sel).evaluate((el) => getComputedStyle(el).display);
export const mirror = (sw: Worker): Promise<Record<string, unknown>> => sw.evaluate(() => chrome.storage.local.get(null));
export const userScript = (sw: Worker): Promise<boolean> => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).some((s) => s.id === 'user-cosmetic'));

async function panelOf(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes('picker-panel.html'))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes('picker-panel.html'));
  if (frame === undefined) throw new Error('no panel');
  return frame;
}

/** Picks `selector` with the mouse and saves it with "Hide always"; resolves with the panel frame (toast shown). */
export async function pickAndHideAlways(page: Page, selector: string): Promise<Frame> {
  await expect.poll(() => overlayOpen(page)).toBe(true);
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error('no box');
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.click(box.x + 10, box.y + 10);
  const panel = await panelOf(page);
  await expect(panel.locator('code')).toHaveText(selector);
  await (await armed(panel.locator('button[data-hide]'))).click();
  await expect(panel.locator('.toast')).toContainText('Hidden.', { timeout: 15_000 });
  return panel;
}
