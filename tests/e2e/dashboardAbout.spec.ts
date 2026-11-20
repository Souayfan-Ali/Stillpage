/** About and Credits (P2-38) on the real build: the manifest's version, the credits, axe in light and dark. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from './helpers/browser.js';
import { expectAccessible, openPage, POLL } from './helpers/settingsPages.js';

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

test('About shows the build version and the credits; accessible', async () => {
  const { version } = JSON.parse(await readFile(path.join(BUILD_DIR, 'manifest.json'), 'utf8')) as { version: string };
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'dashboard.html#about');
  await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible({ timeout: POLL.timeout });
  await expect(page.getByText(version, { exact: true })).toBeVisible();
  // D-99: the filter lists sit behind "Filter lists (N)".
  await page.getByText(/^Filter lists \(\d+\)$/).click();
  await expect(page.getByRole('link', { name: 'EasyList', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  await expectAccessible(page);
});
