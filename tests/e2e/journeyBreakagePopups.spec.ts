/**
 * J9 and J10 extended for pop-ups (P2-62, UI notes §6, §4): the page's sentinel (`popup-sentinel.js`, registered
 * by the test on a site where the default mode `off` registers no guard) blocks a swapped-href pop-up; then, from the toolbar
 * panel opened for that tab, keyboard only:
 * - the privacy panel says "Pop-ups blocked: 1" (and never names the destination);
 * - "The page looks broken" starts with "Allow pop-ups on this site"; trying it stores the site's Allow policy;
 * - the report line carries the pop-up mode, the count and the rule code, no destination host;
 * - the fourth ladder ("An ad opened in a new tab or window"): reload, then Strict pop-ups on this site (the
 *   guard ships, P2-58).
 */
import { expect } from '@playwright/test';
import { test } from './fixtures.js';
import { openPanelFor as panel, pageWithBlockedPopup, press, sitePolicy } from './helpers/guardPage.js';

test.beforeEach(() => {
  test.setTimeout(120_000);
});

test('J10: the privacy panel says how many pop-ups were blocked, never where they went', async ({ context, serviceWorker, extensionId }) => {
  const { tabId } = await pageWithBlockedPopup(context, serviceWorker);
  const p = await panel(context, extensionId, tabId);
  await press(p, /What was blocked on this page/);
  await expect(p.locator('[data-state="popups"]')).toHaveText('Pop-ups blocked: 1');
  expect(await p.locator('main').innerText()).not.toMatch(/ads\.example|news\.example/);
});

test('J9 page broken after a blocked pop-up, keyboard only: "Allow pop-ups" is the first step; the report names mode, count and code only', async ({ context, serviceWorker, extensionId }) => {
  const { tabId } = await pageWithBlockedPopup(context, serviceWorker);
  const p = await panel(context, extensionId, tabId);
  await press(p, 'Something wrong with this page?');
  await press(p, 'The page looks broken or will not work');
  await expect(p.getByRole('heading', { level: 4, name: 'Allow pop-ups on this site' })).toBeVisible();
  await expect(p.getByRole('heading', { level: 3 })).toContainText('Step 1 of 4');
  // Reported before any trial: a trial reloads the page, which starts the sentinel's page-lifetime log afresh.
  await press(p, 'Report this (you review everything first)');
  const preview = p.getByRole('textbox', { name: 'Report (you can edit it before sending)' });
  await expect(preview).toHaveValue(/Pop-ups: off · blocked 1 \(G(?:9|10)\)/);
  expect(await preview.inputValue()).not.toMatch(/ads\.example|news\.example|https?:/);
});

test('J9 page broken, keyboard only: trying "Allow pop-ups" stores the Allow policy; still broken undoes it and offers Light', async ({ context, serviceWorker, extensionId }) => {
  const { tabId } = await pageWithBlockedPopup(context, serviceWorker);
  const p = await panel(context, extensionId, tabId);
  await press(p, 'Something wrong with this page?');
  await press(p, 'The page looks broken or will not work');
  await press(p, 'Allow and reload');
  await expect.poll(() => sitePolicy(p)).toBe('allow');
  await press(p, 'Still broken');
  await expect.poll(() => sitePolicy(p)).toBeNull();
  await expect(p.getByRole('heading', { level: 4, name: 'Try Light mode' })).toBeVisible();
  await expect(p.getByRole('heading', { level: 3 })).toContainText('Step 2 of 4');
});

test('J9 fourth ladder, keyboard only: an ad opened a new tab → reload, then Strict pop-ups on this site', async ({ context, serviceWorker, extensionId }) => {
  const { page, tabId } = await pageWithBlockedPopup(context, serviceWorker);
  const p = await panel(context, extensionId, tabId);
  await press(p, 'Something wrong with this page?');
  await press(p, 'An ad opened in a new tab or window');
  const loaded = page.waitForEvent('load');
  await press(p, 'Reload');
  await loaded;
  await press(p, 'Still broken');
  await expect(p.getByRole('heading', { level: 4, name: 'Strict pop-ups on this site' })).toBeVisible();
  const reloaded = page.waitForEvent('load');
  await press(p, 'Turn it on and reload');
  await reloaded;
  await press(p, 'Still broken');
  await expect(p.getByText('Nothing here fixed it. You can report the problem.')).toBeVisible();
  await expect(p.getByRole('textbox')).toHaveValue(/Problem: an ad opened in a new tab or window · tried: reloading \(still broken\)/);
});
