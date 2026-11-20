/**
 * P2-39: every dashboard section on the real build, axe 0 in light, dark and the manual theme override
 * (`data-theme`, the setting's effect), reached keyboard-only from the section nav. The sections' own
 * journeys (with their deeper states) are in `dashboard*.spec.ts` and `journeyBackup.spec.ts`. Hidden items (P2-22)
 * is drawn empty here; filled in `pickerKeyboard.spec.ts` and `dashboardHidden.spec.ts`.
 */
import { test, expect, type Page } from '@playwright/test';
import { SECTIONS } from '../../../src/features/dashboard/strings.js';
import { english } from '../../helpers/chromeI18n.js';
import { BUILD_DIR } from '../helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from '../helpers/browser.js';
import { expectAccessible, expectThemeOverrides, openPage, POLL, settled } from '../helpers/settingsPages.js';

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

/** Keyboard only: Tab until the nav link `name` has focus, then Enter. */
async function follow(page: Page, name: string, max = 40): Promise<void> {
  const link = page.getByRole('navigation').getByRole('link', { name, exact: true });
  for (let i = 0; i < max; i += 1) {
    if (await link.evaluate((el) => el === document.activeElement).catch(() => false)) break;
    await page.keyboard.press('Tab');
  }
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
}

test('each dashboard section: axe 0 in light, dark and both theme overrides; nav by keyboard', async () => {
  test.setTimeout(180_000);
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'dashboard.html');
  await settled(page);
  await page.reload();
  for (const section of SECTIONS) {
    const title = english(`dash_section_${section}`);
    await follow(page, title);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: POLL.timeout });
    await expectAccessible(page);
    await expectThemeOverrides(page);
  }
});
