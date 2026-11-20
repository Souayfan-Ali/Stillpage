/**
 * Sites section (P2-35) on the real build: keyboard-only add of a site at Off (Chrome gets the
 * site's allow-all dynamic rule), level change from the row, search, bulk remove (the rule goes), axe
 * in light and dark. Throwaway profile; no web pages.
 */
import { test, expect, type Page } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from './helpers/browser.js';
import { expectAccessible, openPage, POLL, settled } from './helpers/settingsPages.js';

test.setTimeout(120_000);

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

/** Hosts named by our dynamic rules' `requestDomains` / `initiatorDomains`. */
const ruleHosts = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.flatMap((r) => [...(r.condition.requestDomains ?? []), ...(r.condition.initiatorDomains ?? [])]);
  });

test('Sites: add keyboard-only, change, search, bulk remove; Chrome follows', async () => {
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'dashboard.html#sites');
  await settled(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sites' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sites' })).toHaveAttribute('aria-current', 'page');

  await page.getByLabel('Site address').focus();
  await page.keyboard.type('Shop.Example.COM');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('rowheader', { name: 'shop.example.com' })).toBeVisible({ timeout: POLL.timeout });
  await expect.poll(() => ruleHosts(page), POLL).toContain('shop.example.com');

  await page.getByLabel('Site address').fill('news.example');
  await page.getByLabel('Level', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByLabel('Level for news.example')).toHaveValue('light', { timeout: POLL.timeout });
  await page.getByLabel('Level for news.example').selectOption('thorough');
  await expect(page.getByRole('status')).toHaveText('Saved.', { timeout: POLL.timeout });
  await expectAccessible(page);

  // D-97: no search box below 8 sites.
  await expect(page.getByLabel('Search sites')).toHaveCount(0);
  const more = ['s1.example', 's2.example', 's3.example', 's4.example', 's5.example', 's6.example'];
  for (const host of more) {
    await page.getByLabel('Site address').fill(host);
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('rowheader', { name: host })).toBeVisible({ timeout: POLL.timeout });
  }
  await page.getByLabel('Search sites').fill('shop');
  await expect(page.getByRole('rowheader')).toHaveCount(1);
  await page.getByLabel('Search sites').fill('');

  for (const host of ['shop.example.com', 'news.example', ...more]) await page.getByLabel(`Select ${host}`).check();
  await page.getByRole('button', { name: 'Remove 8 selected sites' }).click();
  await expect(page.getByText(/^No sites yet\./)).toBeVisible({ timeout: POLL.timeout });
  // D-97, D-121: the removed rows held focus; the empty text takes it.
  await expect(page.getByText(/^No sites yet\./)).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Your sites' })).toHaveCount(0);
  await expect.poll(() => ruleHosts(page), POLL).not.toContain('shop.example.com');

  await page.getByLabel('Site address').fill('https://bad/path');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a site address');
  await expectAccessible(page);
});

test('navigation: links move focus to the section heading; unknown hash shows Protection', async () => {
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'dashboard.html#nothing');
  await expect(page.getByRole('heading', { level: 1, name: 'Protection' })).toBeVisible({ timeout: POLL.timeout });
  await page.getByRole('link', { name: 'Sites' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Sites' })).toBeFocused();
  await expect(page).toHaveTitle('Sites · Glassmere');
});
