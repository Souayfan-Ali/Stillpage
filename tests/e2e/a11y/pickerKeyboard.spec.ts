/**
 * P2-39 on the real build, axe on every state in light, dark and the manual theme override:
 * - the keyboard-only variant of J8 (testing notes §7): "Hide something" from the toolbar panel by Tab and Enter;
 *   the overlay by arrow keys and Enter; in the picker panel dialog, focus on "Similar ones too?", Tab to "Hide" and
 *   Enter ("Hide always" is the default); the toast takes focus on Undo and Enter removes the filter again;
 * - with a saved filter (P2-22): the toolbar panel with its footer link "Hidden items", which
 *   Enter follows to the dashboard's Hidden items list, filled. "Remove from the list", keyboard only, and that
 *   list in light and dark (filled and empty) are `dashboardHidden.spec.ts`'s.
 */
import { expect, type Frame, type Page } from '@playwright/test';
import { test } from '../fixtures.js';
import { press } from '../helpers/guardPage.js';
import { display, hideSomething, mirror, openHidePage, openPanel, pickAndHideAlways, RECONCILE } from '../helpers/hider.js';
import { armed } from '../helpers/pickerPanel.js';
import { expectAccessible, expectThemeOverrides, POLL } from '../helpers/settingsPages.js';

test.beforeEach(() => {
  test.setTimeout(240_000);
});

async function panelOf(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes('picker-panel.html'))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes('picker-panel.html'));
  if (frame === undefined) throw new Error('no panel');
  await frame.locator('[role="dialog"]').waitFor();
  return frame;
}

/** Tab inside the picker panel until `name` has focus (key events go to the focused frame). */
async function tabInPanel(page: Page, panel: Frame, name: string, max = 12): Promise<void> {
  const target = panel.getByRole('button', { name, exact: true });
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

test('J8 keyboard only: Hide something, pick with the arrows, Hide always, Undo; axe 0 on the panel and the toast', async ({ context, serviceWorker }) => {
  const page = await openHidePage(context);
  // The panel calls `window.close()` once the picker started; Playwright does not report it for this window.
  await press(await openPanel(context, serviceWorker), 'Hide something');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length), RECONCILE).toBe(3);
  // The overlay starts on the element at the viewport's centre: here <body>. Down reaches its first block.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  const panel = await panelOf(page);
  await expect(panel.getByRole('slider', { name: 'Similar ones too?' })).toBeFocused();
  await expect(panel.getByRole('radio', { name: /Hide always/ })).toBeChecked();
  await expectAccessible(page, panel);
  await expectThemeOverrides(page, panel);
  await armed(panel.locator('button[data-hide]'));
  await tabInPanel(page, panel, 'Hide');
  await page.keyboard.press('Enter');

  await expect(panel.locator('.toast')).toContainText('Hidden.', { timeout: 15_000 });
  await expect(panel.getByRole('button', { name: 'Undo' })).toBeFocused();
  await expectAccessible(page, panel);
  expect(await mirror(serviceWorker)).toEqual({ 'uf:hide.example': { v: 1, s: ['#ad'] } });
  await armed(panel.getByRole('button', { name: 'Undo' }));
  await page.keyboard.press('Enter');
  await expect.poll(() => display(page, '#ad'), RECONCILE).not.toBe('none');
  await expect.poll(() => mirror(serviceWorker), RECONCILE).toEqual({});
});

test('a saved filter: panel footer link and the filled Hidden items list, axe 0; the link followed by keyboard', async ({ context, serviceWorker }) => {
  const page = await openHidePage(context);
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(page, '#ad');
  const popup = await openPanel(context, serviceWorker);
  const link = popup.getByRole('link', { name: 'Hidden items' });
  await expect(link).toBeVisible({ timeout: POLL.timeout });
  await expectAccessible(popup);
  await expectThemeOverrides(popup);
  const opened = context.waitForEvent('page');
  await link.focus();
  await popup.keyboard.press('Enter');
  const dash = await opened;
  await expect(dash.getByRole('region', { name: 'hide.example' }).locator('code')).toHaveText(['#ad'], { timeout: POLL.timeout });
  await expectAccessible(dash);
  await expectThemeOverrides(dash);
});
