/**
 * P2-22b "Show on page" (D-50) on the real build, keyboard only, with axe: a filter saved with the element
 * hider is listed in the toolbar panel's "What you hid on this site" view; "Show on page" un-hides and
 * outlines it in the tab (the panel's own `scripting.executeScript`), then the page reverts on the timer and
 * when the panel closes. Nothing is written: `storage.local` is unchanged, and a hostile page that snapshots
 * its DOM, its globals and its style sheets finds them exactly as before once the preview is over.
 */
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.js';
import { display, hideSomething, mirror, openHidePage, openPanel, pickAndHideAlways, RECONCILE, userScript } from './helpers/hider.js';
import { expectAccessible, POLL } from './helpers/settingsPages.js';

/** `SHOW_MS` of `features/popup/hidden/preview.ts`. */
const SHOW_MS = 20_000;
/** The close revert must come well before the timer would. */
const CLOSE_REVERT_MS = 8_000;

/** Presses Tab until the named control has focus (keyboard only: no clicks in the panel). */
async function tabTo(page: Page, role: 'button' | 'link' | 'heading', name: string): Promise<void> {
  const target = page.getByRole(role, { name, exact: true });
  for (let i = 0; i < 40; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`${name} was not reached with Tab`);
}

/** What a hostile page can read about itself, in its own (main) world. */
const pageView = (site: Page): Promise<unknown> =>
  site.evaluate(() => ({
    html: document.documentElement.outerHTML,
    globals: Object.getOwnPropertyNames(window).length,
    sheets: document.styleSheets.length,
    adopted: document.adoptedStyleSheets.length,
    adStyle: document.getElementById('ad')?.getAttribute('style') ?? null,
  }));

const outlined = (site: Page): Promise<string> => site.locator('#ad').evaluate((el) => getComputedStyle(el).outlineStyle);

async function openList(panel: Page): Promise<void> {
  await expect(panel.getByRole('button', { name: 'What you hid on this site (1)' })).toBeVisible({ timeout: POLL.timeout });
  await tabTo(panel, 'button', 'What you hid on this site (1)');
  await panel.keyboard.press('Enter');
  await expect(panel.getByRole('heading', { level: 2, name: 'Hidden on hide.example' })).toBeFocused({ timeout: POLL.timeout });
}

async function showAd(panel: Page): Promise<void> {
  await tabTo(panel, 'button', 'Show on page: #ad');
  await panel.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Shown on the page: 1 match. Hidden again in 20 seconds.', { timeout: POLL.timeout });
  await expect(panel.getByRole('button', { name: 'Show on page: #ad' })).toHaveAttribute('aria-pressed', 'true');
}

test('show on page: keyboard only, reverts on the timer and on panel close, nothing left behind', async ({ context, serviceWorker }) => {
  test.setTimeout(240_000);
  const site = await openHidePage(context);
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(site, '#ad');
  await expect.poll(() => userScript(serviceWorker), RECONCILE).toBe(true);
  await site.reload();
  await expect.poll(() => display(site, '#ad'), RECONCILE).toBe('none');
  const before = await pageView(site);
  const stored = await mirror(serviceWorker);

  // The list and the preview, keyboard only; axe in light and dark, before and while showing.
  const panel = await openPanel(context, serviceWorker);
  await openList(panel);
  await expect(panel.locator('li code')).toHaveText(['#ad']);
  await expectAccessible(panel);
  await showAd(panel);
  expect(await display(site, '#ad')).not.toBe('none');
  expect(await outlined(site)).toBe('solid');
  await expectAccessible(panel);

  // Revert on the timer: the page and the panel both come back on their own.
  await expect.poll(() => display(site, '#ad'), { timeout: SHOW_MS + 10_000 }).toBe('none');
  await expect(panel.getByRole('status')).toHaveText('Hidden again.', { timeout: POLL.timeout });
  await expect(panel.getByRole('button', { name: 'Show on page: #ad' })).toHaveAttribute('aria-pressed', 'false');
  expect(await pageView(site)).toEqual(before);

  // Revert when the panel closes, well before the timer.
  await showAd(panel);
  expect(await display(site, '#ad')).not.toBe('none');
  const closed = Date.now();
  await panel.close({ runBeforeUnload: true });
  await expect.poll(() => display(site, '#ad'), { timeout: CLOSE_REVERT_MS }).toBe('none');
  expect(Date.now() - closed).toBeLessThan(CLOSE_REVERT_MS);
  expect(await pageView(site)).toEqual(before);

  // Nothing written: the stored filters are as they were, and nothing else appeared in storage.local.
  expect(await mirror(serviceWorker)).toEqual(stored);
});
