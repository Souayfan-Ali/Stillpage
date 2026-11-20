/**
 * P2-39: axe-core (WCAG 2.2 A/AA and best practice, contrast included) on the toolbar panel's states that
 * `panel.spec.ts` (the nine header states, from fixtures) does not reach, on the real build and the real
 * worker: the pop-up row with its list open, the pause menu open, the privacy view, the breakage flow's
 * first screen and the first step of each of its four ladders; light, dark and the manual theme override.
 * Reached keyboard-only. The deeper breakage steps are checked in `journeyBreakage.spec.ts`.
 */
import { expect, type Page } from '@playwright/test';
import { english } from '../../helpers/chromeI18n.js';

/** The four complaints, in English (copy modules read chrome.i18n, which Node has not). */
const COMPLAINTS = ['broken', 'ad_through', 'anti_adblock', 'popup_opened'].map((c) => english(`breakage_complaint_${c}`));
import { test } from '../fixtures.js';
import { openPanelFor, pageWithBlockedPopup, press, tabTo } from '../helpers/guardPage.js';
import { expectAccessible, expectThemeOverrides } from '../helpers/settingsPages.js';

test.beforeEach(() => {
  test.setTimeout(180_000);
});

async function backToMain(panel: Page): Promise<void> {
  await press(panel, 'Back');
  await expect(panel.getByRole('heading', { level: 2, name: 'guard.example' })).toBeVisible();
}

test('panel main view, pop-up row open, pause menu open, privacy view: axe 0 in every theme, keyboard only', async ({ context, serviceWorker, extensionId }) => {
  const { tabId } = await pageWithBlockedPopup(context, serviceWorker);
  const panel = await openPanelFor(context, extensionId, tabId);
  await expectAccessible(panel);
  await expectThemeOverrides(panel);

  await press(panel, '1 blocked here');
  await expect(panel.getByRole('button', { name: '1 blocked here' })).toHaveAttribute('aria-expanded', 'true');
  await expectAccessible(panel);

  await press(panel, 'Pause on this site');
  await expect(panel.getByRole('button', { name: '30 minutes' })).toBeVisible();
  await expectAccessible(panel);
  await panel.keyboard.press('Tab');
  await panel.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: 'Pause on this site' })).toBeFocused();

  await press(panel, /What was blocked on this page/);
  await expect(panel.getByRole('heading', { name: /What was blocked/ })).toBeFocused();
  await expectAccessible(panel);
  await backToMain(panel);
});

test('breakage flow: the question and the first step of each ladder, axe 0 in light and dark, keyboard only', async ({ context, serviceWorker, extensionId }) => {
  const { tabId } = await pageWithBlockedPopup(context, serviceWorker);
  const panel = await openPanelFor(context, extensionId, tabId);
  await press(panel, 'Something wrong with this page?');
  await expect(panel.getByRole('heading', { name: 'Fix this page' })).toBeFocused();
  await expectAccessible(panel);
  await expectThemeOverrides(panel);
  for (const complaint of COMPLAINTS) {
    await press(panel, complaint);
    await expect(panel.getByRole('heading', { level: 3 })).toContainText('Step 1 of');
    await expectAccessible(panel);
    await press(panel, /^Cancel/);
    await expect(panel.getByRole('group', { name: 'What is wrong?' })).toBeVisible();
  }
  await tabTo(panel, 'Back');
});
