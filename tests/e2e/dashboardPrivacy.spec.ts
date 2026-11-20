/**
 * Privacy section and privacy page (P2-36) on the real build: GPC on from the page switches on the
 * `gpc-x` ruleset; the badge option is accepted by Chrome without any extra permission and follows the
 * setting; the permissions table lists what the built manifest declares; axe in light and dark.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from './helpers/browser.js';
import { enabledRulesets, expectAccessible, openPage, POLL, send, settled } from './helpers/settingsPages.js';

test.setTimeout(120_000);

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

test('Privacy: GPC and badge from the page; permissions match the manifest; accessible', async () => {
  const manifest = JSON.parse(await readFile(path.join(BUILD_DIR, 'manifest.json'), 'utf8')) as { permissions: string[]; host_permissions: string[] };
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'dashboard.html#privacy');
  await settled(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  // D-101 C: the one way a report reaches GitHub is named on the page.
  await expect(page.getByText(/makes no network requests\..*The one exception is yours to make: "Open a new issue" in a problem report opens github\.com in a browser tab with the report you reviewed\.$/)).toBeVisible();

  const codes = await page.locator('table').first().locator('tbody code').allTextContents();
  expect(codes.sort()).toEqual([...manifest.permissions, ...manifest.host_permissions].sort());

  await page.getByLabel(/do not sell or share/).check();
  await expect(page.getByRole('status')).toHaveText('Saved.', { timeout: POLL.timeout });
  await expect.poll(() => enabledRulesets(page), POLL).toContain('gpc-x');

  // Chrome accepts the action-count option with our permissions (no declarativeNetRequestFeedback).
  await page.evaluate(() => chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true }));
  await page.getByLabel(/number of blocked requests/).uncheck();
  await expect(page.getByRole('status')).toHaveText('Saved.', { timeout: POLL.timeout });
  expect(await send(page, 'q/dashboard', {})).toMatchObject({ ok: true, data: { settings: { ui: { showBadge: false } } } });
  await expectAccessible(page);
});
