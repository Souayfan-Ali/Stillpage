/**
 * P2-22 (J8 "remove from list", keyboard-only) on the real build: a filter saved with the element hider
 * shows in the toolbar panel's footer link ("Hidden items") and in the dashboard's Hidden
 * items section, grouped by site (axe in light and dark); a backup carries it (format version 2);
 * Remove, keyboard only, takes it out of the vault and the `uf:*` mirror and the element shows again
 * after a reload; restoring the backup brings it back.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.js';
import { display, hideSomething, HIDE_ORIGIN, mirror, openHidePage, openPanel, pickAndHideAlways, RECONCILE, userScript } from './helpers/hider.js';
import { expectAccessible, POLL } from './helpers/settingsPages.js';

/** Presses Tab until `name`'s button or link has focus (keyboard-only: no clicks on the list). */
async function tabTo(page: Page, role: 'button' | 'link', name: string): Promise<void> {
  const target = page.getByRole(role, { name, exact: true });
  for (let i = 0; i < 40; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`${name} was not reached with Tab`);
}

test('hidden items: panel link, dashboard list, backup, keyboard-only remove, restore', async ({ context, serviceWorker }, info) => {
  test.setTimeout(240_000);
  const site = await openHidePage(context);
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(site, '#ad');
  await expect.poll(() => userScript(serviceWorker), RECONCILE).toBe(true);

  // Toolbar panel: the footer link, with the count for this site, opens the list in a new tab.
  const panel = await openPanel(context, serviceWorker);
  const link = panel.getByRole('link', { name: 'Hidden items' });
  await expect(link).toHaveAttribute('href', '/dashboard.html#hidden', { timeout: POLL.timeout });
  const opened = context.waitForEvent('page');
  await link.focus();
  await panel.keyboard.press('Enter');
  const dash = await opened;
  await expect(dash.getByRole('heading', { level: 1, name: 'Hidden items' })).toBeVisible({ timeout: POLL.timeout });
  await expect(dash.getByRole('link', { name: 'Hidden items' })).toHaveAttribute('aria-current', 'page');
  const region = dash.getByRole('region', { name: 'hide.example' });
  await expect(region.locator('code')).toHaveText(['#ad']);
  await expect(dash.getByText('1 thing hidden on 1 site.')).toBeVisible();
  await expectAccessible(dash);

  // Backup (version 2) carries the filter.
  await dash.getByRole('link', { name: 'Backup' }).focus();
  await dash.keyboard.press('Enter');
  await tabTo(dash, 'button', 'Save backup file');
  const download = dash.waitForEvent('download');
  await dash.keyboard.press('Enter');
  const file = path.join(info.outputDir, (await download).suggestedFilename());
  await (await download).saveAs(file);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 2, userFilters: { 'hide.example': ['#ad'] } });

  // Remove, keyboard only: vault and mirror emptied, focus kept in the section, the element back after a reload.
  await dash.getByRole('link', { name: 'Hidden items' }).focus();
  await dash.keyboard.press('Enter');
  await tabTo(dash, 'button', 'Remove #ad on hide.example');
  await dash.keyboard.press('Enter');
  await expect(dash.getByRole('status')).toHaveText('Removed. It shows again on that site. If a page still hides it, reload that page.', { timeout: POLL.timeout });
  await expect(dash.getByRole('heading', { name: 'Nothing hidden yet' })).toBeVisible();
  await expect(dash.locator('#hidden-heading')).toBeFocused();
  await expectAccessible(dash);
  await expect.poll(() => mirror(serviceWorker), RECONCILE).toEqual({});
  await expect.poll(() => userScript(serviceWorker), RECONCILE).toBe(false);
  await site.reload();
  expect(await display(site, '#ad')).not.toBe('none');

  // Restore the backup: the preview names the hidden item, and the filter is back.
  await dash.getByRole('link', { name: 'Backup' }).focus();
  await dash.keyboard.press('Enter');
  await dash.getByLabel('Backup file').setInputFiles(file);
  await expect(dash.getByText('Hidden items: 1 added')).toBeVisible({ timeout: POLL.timeout });
  await tabTo(dash, 'button', 'Restore');
  await dash.keyboard.press('Enter');
  await expect(dash.getByText('Backup restored.')).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => mirror(serviceWorker), RECONCILE).toEqual({ 'uf:hide.example': { v: 1, s: ['#ad'] } });
  await site.goto(`${HIDE_ORIGIN}/`);
  await expect.poll(() => display(site, '#ad'), RECONCILE).toBe('none');
});
