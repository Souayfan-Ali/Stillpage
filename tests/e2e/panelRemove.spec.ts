/**
 * P3-17 item 3: Remove in the toolbar panel's "What you hid on this site" view, keyboard only, with axe.
 * It sends the existing `c/removeUserFilter` (no new worker message): the item leaves the panel's list at
 * once, focus moves to the next Remove, and the vault, the `uf:*` mirror and the dashboard's Hidden items
 * list no longer have it.
 */
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.js';
import { hideSomething, mirror, openHidePage, openPanel, pickAndHideAlways, RECONCILE, userScript } from './helpers/hider.js';
import { expectAccessible, POLL } from './helpers/settingsPages.js';

/** Presses Tab until the named control has focus (keyboard only: no clicks in the panel). */
async function tabTo(page: Page, name: string): Promise<void> {
  const target = page.getByRole('button', { name, exact: true });
  for (let i = 0; i < 40; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`${name} was not reached with Tab`);
}

test('panel Remove: keyboard only, gone from the panel list, the mirror and the dashboard list', async ({ context, serviceWorker }) => {
  test.setTimeout(240_000);
  const site = await openHidePage(context);
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(site, '#ad');
  // The first pick's undo toast stays for 30 s; a reload clears it before the second pick.
  await site.reload();
  await site.bringToFront();
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(site, '#keep');
  await expect.poll(() => mirror(serviceWorker), RECONCILE).toEqual({ 'uf:hide.example': { v: 1, s: ['#ad', '#keep'] } });
  await expect.poll(() => userScript(serviceWorker), RECONCILE).toBe(true);

  const panel = await openPanel(context, serviceWorker);
  await expect(panel.getByRole('button', { name: 'What you hid on this site (2)' })).toBeVisible({ timeout: POLL.timeout });
  await tabTo(panel, 'What you hid on this site (2)');
  await panel.keyboard.press('Enter');
  await expect(panel.getByRole('heading', { level: 2, name: 'Hidden on hide.example' })).toBeFocused({ timeout: POLL.timeout });
  await expect(panel.locator('li code')).toHaveText(['#ad', '#keep']);
  await expectAccessible(panel);

  await tabTo(panel, 'Remove #ad on hide.example');
  await panel.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText(/^Removed\./, { timeout: POLL.timeout });
  await expect(panel.locator('li code')).toHaveText(['#keep']);
  await expect(panel.getByRole('button', { name: 'Remove #keep on hide.example', exact: true })).toBeFocused();
  await expectAccessible(panel);
  await expect.poll(() => mirror(serviceWorker), RECONCILE).toEqual({ 'uf:hide.example': { v: 1, s: ['#keep'] } });

  const dash = await context.newPage();
  await dash.goto(serviceWorker.url().replace('background.js', 'dashboard.html#hidden'));
  await expect(dash.getByRole('region', { name: 'hide.example' }).locator('code')).toHaveText(['#keep'], { timeout: POLL.timeout });
});
