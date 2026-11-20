/**
 * P2-59, the in-page notice on the real build, guard on in Smart as the user turns it on: a click on plain text
 * that a page script answers with `window.open` is blocked (G11) and the notice drawn.
 * - Keyboard and screen reader: Tab reaches the notice's buttons without it ever taking focus itself, Enter on
 *   "Open it" after the arm delay opens the address (and gives the page no window of its own), Esc dismisses;
 *   the accessibility tree has the status line and three named buttons.
 * - Coalescing: a second block while it shows reads "2 pop-ups blocked · <host>".
 * - The dashboard toggle: off registers `popup-quiet` and blocks stay silent; on again draws the notice.
 * - Visual: light, dark, right-to-left and 200 % zoom: inside the viewport on a long page (top-right, or
 *   top-left on a right-to-left page), within the notice size bounds, system colours per scheme; screenshots
 *   are attached for review.
 */
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.js';
import { buttonCentre } from './hostile/closedShadow.js';
import { AD_URL, ARMED_MS, axLines, command, guardIds, noticeBox, noticePageHtml, openNoticePage, opens, smartGuard } from './helpers/noticePage.js';

/** The notice's bounds the sentinel enforces (`MAX_BOX` in notice.ts). */
const MAX_BOX = { width: 480, height: 160 } as const;
const VIEWPORT = { width: 1280, height: 720 } as const;
/** 200 % zoom: the same window lays out in half the CSS pixels. */
const ZOOMED = { width: 640, height: 360 } as const;

test.beforeEach(() => {
  test.setTimeout(120_000);
});

async function blocked(page: Page): Promise<void> {
  expect(await opens(page, '#text'), 'the click-anywhere window is blocked').toBe(false);
  await expect.poll(() => noticeBox(page).then((b) => b !== null)).toBe(true);
}

test('keyboard and screen reader: named status and buttons; Tab, Enter on Open it opens only that address; Esc dismisses', async ({ context, serviceWorker, extensionId }) => {
  await smartGuard(context, serviceWorker, extensionId);
  const page = await openNoticePage(context);
  await blocked(page);
  const lines = await axLines(page);
  expect(lines).toEqual(expect.arrayContaining(['status: ', 'StaticText: Pop-up blocked · ad.example', 'button: Open it', 'button: Allow on this page', 'button: Dismiss']));
  // It never takes focus: the page keeps it until the user moves it.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.waitForTimeout(ARMED_MS);
  await page.keyboard.press('Tab');
  const opened: string[] = [];
  context.on('page', (p) => { opened.push(p.url()); });
  const tab = context.waitForEvent('page', { timeout: 5_000 });
  await page.keyboard.press('Enter');
  const next = await tab;
  await next.waitForLoadState().catch(() => undefined);
  expect(next.url()).toBe(AD_URL);
  // The page's click-anywhere script saw the click on our button and tried again: blocked (one window only).
  await page.waitForTimeout(1_000);
  expect(opened).toHaveLength(1);
  await next.close();
  await blocked(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => noticeBox(page)).toBeNull();
});

test('coalescing: a second block while the notice shows updates its count', async ({ context, serviceWorker, extensionId }) => {
  await smartGuard(context, serviceWorker, extensionId);
  const page = await openNoticePage(context);
  await blocked(page);
  expect(await opens(page, '#text')).toBe(false);
  await expect.poll(async () => (await axLines(page)).includes('StaticText: 2 pop-ups blocked · ad.example')).toBe(true);
  expect(await page.evaluate(() => [...document.documentElement.children].filter((c) => c.tagName === 'DIV').length)).toBe(1);
});

test('the dashboard toggle is honoured: off registers popup-quiet and blocks stay silent; on draws the notice again', async ({ context, serviceWorker, extensionId }) => {
  await smartGuard(context, serviceWorker, extensionId);
  await command(context, serviceWorker, extensionId, 'c/setPopupNotice', { enabled: false });
  await expect.poll(() => guardIds(serviceWorker), { timeout: 30_000 }).toContain('popup-quiet');
  const page = await openNoticePage(context);
  expect(await opens(page, '#text')).toBe(false);
  await page.waitForTimeout(1_000);
  expect(await noticeBox(page)).toBeNull();
  expect(await buttonCentre(page, 'Allow on this page')).toBeNull();
  await command(context, serviceWorker, extensionId, 'c/setPopupNotice', { enabled: true });
  await expect.poll(() => guardIds(serviceWorker), { timeout: 30_000 }).not.toContain('popup-quiet');
  await page.reload();
  await blocked(page);
});

for (const variant of [
  { name: 'light', scheme: 'light', dir: 'ltr', viewport: VIEWPORT },
  { name: 'dark', scheme: 'dark', dir: 'ltr', viewport: VIEWPORT },
  { name: 'right-to-left', scheme: 'light', dir: 'rtl', viewport: VIEWPORT },
  { name: '200 % zoom', scheme: 'light', dir: 'ltr', viewport: ZOOMED },
] as const) {
  test(`visual, ${variant.name}: in the viewport on a long page, in its corner, within bounds, a real click on Allow still works`, async ({ context, serviceWorker, extensionId }) => {
    await smartGuard(context, serviceWorker, extensionId);
    const page = await openNoticePage(context, noticePageHtml(variant.dir));
    await page.setViewportSize(variant.viewport);
    await page.emulateMedia({ colorScheme: variant.scheme });
    await blocked(page);
    const box = await noticeBox(page);
    if (box === null) throw new Error('no notice');
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(variant.viewport.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(variant.viewport.width);
    expect(box.width).toBeLessThanOrEqual(MAX_BOX.width);
    expect(box.height).toBeLessThanOrEqual(MAX_BOX.height);
    const centre = box.x + box.width / 2;
    expect(variant.dir === 'rtl' ? centre < variant.viewport.width / 2 : centre > variant.viewport.width / 2).toBe(true);
    // System colours: light background and dark text in the light scheme, the reverse in the dark one.
    const luminance = (rgb: string): number => (/\d+/.exec(rgb) === null ? 0 : Number(/\d+/.exec(rgb)?.[0]));
    expect(variant.scheme === 'dark' ? luminance(box.background) < luminance(box.color) : luminance(box.background) > luminance(box.color)).toBe(true);
    await test.info().attach(`notice-${variant.name}.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.waitForTimeout(ARMED_MS);
    const allow = await buttonCentre(page, 'Allow on this page');
    if (allow === null) throw new Error('no Allow button');
    await page.mouse.click(allow.x, allow.y);
    await expect.poll(async () => (await axLines(page)).includes('StaticText: Now repeat what you did')).toBe(true);
  });
}
