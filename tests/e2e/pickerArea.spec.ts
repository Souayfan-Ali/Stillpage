/**
 * D-81 (P3-17 item B): "Bigger area" / "Smaller area" in the picker panel, keyboard only, with axe. The
 * panel says only "widen" / "narrow"; the picker walks its own chain and answers with fresh candidates.
 * On a wrapper fixture: pick the inner box, Bigger area offers the wrapper (count and preview follow, focus
 * stays on the button), Smaller area comes back, and Hide leaves no empty box. A box covering half the
 * viewport or more shows the warning. The picker is started as `picker.spec.ts` does (local fixtures).
 */
import { expect, type BrowserContext, type Frame, type Page, type Worker } from '@playwright/test';
import { test } from './fixtures.js';
import { armed } from './helpers/pickerPanel.js';
import { expectAccessible } from './helpers/settingsPages.js';

const ORIGIN = 'https://area.example';
const NONCE = 'e2eAreaNonce_0123456789';
const WRAPPER = `<!doctype html><title>area</title><style>body{margin:0;font:16px sans-serif}
#wrap{width:400px;padding:24px;background:#eee}#inner{height:60px;background:#c66}#keep{height:40px}</style>
<div id="wrap"><div id="inner">ad</div></div><p id="keep">keep</p>`;
const LARGE = `<!doctype html><title>large</title><style>body{margin:0}#big{width:100vw;height:90vh;background:#eee}#part{width:200px;height:50px;background:#c66}</style>
<section id="big"><div id="part">x</div></section>`;

async function openFixture(context: BrowserContext, path: string): Promise<Page> {
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ body: new URL(route.request().url()).pathname === '/large.html' ? LARGE : WRAPPER, contentType: 'text/html' }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}${path}`);
  await page.bringToFront();
  return page;
}

/** The worker's start, done from the worker (as `picker.spec.ts`). */
async function startPicker(sw: Worker): Promise<void> {
  await sw.evaluate(async ({ origin, nonce }) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    const tabId = tab?.id ?? -1;
    await chrome.storage.session.set({ [`picker:${nonce}`]: { tabId, hostname: 'area.example', mode: 'hide', createdAt: Date.now(), claimed: false } });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'x/pickerStart', nonce, mode: 'hide' }, { frameId: 0 });
  }, { origin: ORIGIN, nonce: NONCE });
}

async function pick(page: Page, sw: Worker, selector: string): Promise<Frame> {
  await startPicker(sw);
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(3);
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error('no box');
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.click(box.x + 5, box.y + 5);
  await expect.poll(() => page.frames().some((f) => f.url().includes('picker-panel.html'))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes('picker-panel.html'));
  if (frame === undefined) throw new Error('no panel frame');
  await frame.locator('[role="dialog"]').waitFor();
  await expect(frame.locator('code')).toHaveText(selector);
  return frame;
}

const display = (page: Page, sel: string): Promise<string> => page.locator(sel).evaluate((el) => getComputedStyle(el).display);
const focused = (panel: Frame): Promise<string | null> => panel.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? null);

test('Bigger / Smaller area: keyboard only, focus kept, count and preview follow, Hide leaves no empty box', async ({ context, serviceWorker }) => {
  test.setTimeout(90_000);
  const page = await openFixture(context, '/');
  const panel = await pick(page, serviceWorker, '#inner');
  await expect(panel.getByRole('button', { name: 'Smaller area' })).toHaveAttribute('aria-disabled', 'true');
  expect(await display(page, '#inner')).toBe('none');
  expect(await display(page, '#wrap')).not.toBe('none');

  // The slider has focus; the Area buttons come before it.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await focused(panel)).toBe('Bigger area');
  await page.keyboard.press('Enter');
  await expect(panel.locator('code')).toHaveText('#wrap');
  await expect(panel.locator('[data-count]')).toHaveText('Hides 1 item on this page');
  await expect.poll(() => display(page, '#wrap')).toBe('none');
  expect(await focused(panel)).toBe('Bigger area');
  await expect(panel.getByRole('button', { name: 'Smaller area' })).toHaveAttribute('aria-disabled', 'false');
  await expect(panel.getByRole('button', { name: 'Bigger area' })).toHaveAttribute('aria-disabled', 'true');
  await expect(panel.locator('[data-area]')).toHaveText('This is the biggest area you can pick.');
  await expectAccessible(page, panel);

  await page.keyboard.press('Tab');
  expect(await focused(panel)).toBe('Smaller area');
  await page.keyboard.press('Enter');
  await expect(panel.locator('code')).toHaveText('#inner');
  expect(await focused(panel)).toBe('Smaller area');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(panel.locator('code')).toHaveText('#wrap');

  await panel.locator('input[value="once"]').check();
  await (await armed(panel.locator('button[data-hide]'))).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length), { timeout: 20_000 }).toBe(2);
  expect(await display(page, '#wrap')).toBe('none');
  expect(await page.locator('#wrap').boundingBox()).toBeNull();
  expect((await page.locator('#keep').boundingBox())?.y).toBeLessThan(30);
});

test('a box covering half the viewport or more shows the warning (not a block)', async ({ context, serviceWorker }) => {
  test.setTimeout(90_000);
  const page = await openFixture(context, '/large.html');
  const panel = await pick(page, serviceWorker, '#part');
  await expect(panel.locator('[data-area]')).toHaveText('');
  await panel.getByRole('button', { name: 'Bigger area' }).click();
  await expect(panel.locator('code')).toHaveText('#big');
  await expect(panel.locator('[data-area]')).toContainText('This is a large part of the page.');
  await expect(panel.locator('button[data-hide]')).toBeVisible();
  await expectAccessible(page, panel);
});

/** D-109: the panel fits its frame without scrolling, with Hide and the selector summary in view. */
const fit = (panel: Frame): Promise<{ readonly fits: boolean; readonly scrollY: number; readonly summary: boolean; readonly hide: boolean }> => panel.evaluate(() => {
  const bottom = (sel: string): number => document.querySelector(sel)?.getBoundingClientRect().bottom ?? Infinity;
  const root = document.documentElement;
  return { fits: root.scrollHeight <= root.clientHeight, scrollY, summary: bottom('summary') <= innerHeight, hide: bottom('button[data-hide]') <= innerHeight };
});

/** D-110: the label above, then the two ends and the slider on one line, each end on a single line. */
const sliderLayout = (panel: Frame): Promise<{ readonly labelAbove: boolean; readonly oneLine: boolean; readonly endLines: readonly number[] }> => panel.evaluate(() => {
  const rect = (el: Element | null | undefined): DOMRect => el?.getBoundingClientRect() ?? new DOMRect();
  const input = document.querySelector('#spread');
  const ends = [...(input?.parentElement?.querySelectorAll('span[aria-hidden="true"]') ?? [])];
  const range = rect(input);
  const overlaps = (r: DOMRect): boolean => r.top < range.bottom && range.top < r.bottom;
  return {
    labelAbove: rect(document.querySelector('label[for="spread"]')).bottom <= range.top,
    oneLine: ends.length === 2 && ends.every((s) => overlaps(rect(s))),
    endLines: ends.map((s) => s.getClientRects().length),
  };
});

test('D-109: every control fits the frame at 1280×720; a short viewport scrolls', async ({ context, serviceWorker }) => {
  test.setTimeout(120_000);
  const fits = { fits: true, scrollY: 0, summary: true, hide: true };
  const first = await openFixture(context, '/');
  await first.setViewportSize({ width: 1280, height: 720 });
  const one = await pick(first, serviceWorker, '#inner');
  await one.getByRole('button', { name: 'Bigger area' }).click();
  await expect(one.locator('[data-area]')).toHaveText('This is the biggest area you can pick.');
  expect(await fit(one)).toEqual(fits);
  expect(await sliderLayout(one)).toEqual({ labelAbove: true, oneLine: true, endLines: [1, 1] });
  await first.close();

  const page = await openFixture(context, '/large.html');
  await page.setViewportSize({ width: 1280, height: 720 });
  const panel = await pick(page, serviceWorker, '#part');
  await panel.getByRole('button', { name: 'Bigger area' }).click();
  await expect(panel.locator('[data-area]')).toContainText('This is a large part of the page.');
  expect(await fit(panel)).toEqual(fits);
  expect(await sliderLayout(panel)).toEqual({ labelAbove: true, oneLine: true, endLines: [1, 1] });

  await page.setViewportSize({ width: 1280, height: 400 });
  await expect.poll(() => panel.evaluate(() => innerHeight)).toBe(368);
  expect(await panel.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight)).toBe(true);
  await panel.locator('summary').scrollIntoViewIfNeeded();
  const summary = await panel.locator('summary').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  });
  expect(summary).toBe(true);
});
