/**
 * J1 (P2-33, testing notes §6): install → onboarding → protected, on the real build with throwaway profiles.
 * The worker opens the first-run tab on install (kept here; every other launcher closes it, D-46); the
 * default rulesets are on and the install run finishes; the steps are walked keyboard-only with axe
 * in light and dark; a pack chosen on step 2 is applied on Next; Finish stores the completion; closing
 * the tab early leaves the safe defaults; reduced motion stops the demo animation.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from './helpers/browser.js';
import { enabledRulesets, expectAccessible, POLL, send } from './helpers/settingsPages.js';

test.setTimeout(240_000);
/** J1: the install run (rulesets, rules and registrations) finishes within 5 s. */
const INSTALL_RUN_BUDGET_MS = 5_000;
const PACK_RUN_MS = 150_000;

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

async function onboardingTab(context: BrowserContext): Promise<Page> {
  await expect.poll(() => context.pages().some((p) => p.url().endsWith('/onboarding.html')), POLL).toBe(true);
  const page = context.pages().find((p) => p.url().endsWith('/onboarding.html'));
  if (page === undefined) throw new Error('no onboarding tab');
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** Presses Tab until the button `name` has focus. */
async function tabTo(page: Page, name: string, max = 20): Promise<void> {
  const target = page.getByRole('button', { name, exact: true });
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

interface LastRun {
  readonly reason: string;
  readonly status: string;
  readonly durationMs: number;
}

test('J1: install opens onboarding; protected; keyboard-only through the steps; Finish stored', async () => {
  const context = await launch(await newProfile(), BUILD_DIR, { keepOnboarding: true });
  const page = await onboardingTab(context);
  await expect(page.getByRole('heading', { level: 1, name: 'You are protected.' })).toBeVisible();
  expect(await enabledRulesets(page)).toEqual(expect.arrayContaining(['easylist', 'easyprivacy', 'ubo', 'badware', 'urlhaus', 'popups']));
  await expect.poll(async () => ((await page.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] as LastRun | undefined)) ?? { reason: '' }).reason, POLL).toBe('installed:install');
  const run = (await page.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'])) as LastRun;
  expect(run.status, JSON.stringify(run)).not.toBe('failed');
  expect(run.durationMs, `install run ${String(run.durationMs)} ms`).toBeLessThanOrEqual(INSTALL_RUN_BUDGET_MS);
  await expect(page.getByText('Site access: allowed on all sites')).toBeVisible();
  // D18: the stepper shows the names; each step's label starts "Step N of 3".
  await expect(page.getByRole('list', { name: 'Setup steps' }).getByRole('listitem')).toHaveText(['Protection', 'Extras', 'Tools']);
  await expect(page.getByRole('listitem', { name: 'Step 1 of 3: Protection' })).toHaveAttribute('aria-current', 'step');
  await expectAccessible(page);

  await tabTo(page, 'Next');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Choose extras' })).toBeFocused();
  await expectAccessible(page);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Hide cookie banners')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Hide cookie banners')).toBeChecked();
  expect(await enabledRulesets(page)).not.toContain('cookies');

  await tabTo(page, 'Next');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Three things to know' })).toBeVisible({ timeout: PACK_RUN_MS });
  // D20: "Saved." belonged to step 2; step 3 starts with an empty status line.
  await expect(page.getByRole('status')).toHaveText('');
  // D-106: the hiding tip names the right-click entry and the panel button.
  await expect(page.getByText('Right-click what you want gone and choose "Hide this…", or open the toolbar panel and choose "Hide something".')).toBeVisible();
  // D19: the focused step heading draws no ring.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('outline-style', 'none');
  expect(await enabledRulesets(page)).toContain('cookies');
  await expectAccessible(page);

  await tabTo(page, 'Finish');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'All set.' })).toBeVisible({ timeout: POLL.timeout });
  await expectAccessible(page);
  const snapshot = (await send(page, 'q/dashboard', {})) as { data: { settings: { onboarding: { completedAt: number | null } } } };
  expect(snapshot.data.settings.onboarding.completedAt).toEqual(expect.any(Number));
});

test('J1: closing the tab on step 2 leaves the safe defaults; reduced motion stops the demo', async () => {
  const context = await launch(await newProfile(), BUILD_DIR, { keepOnboarding: true });
  const page = await onboardingTab(context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Hide cookie banners').check();
  await page.getByLabel(/do not sell or share/).check();
  const probe = await context.newPage();
  await probe.goto(page.url().replace('onboarding.html', 'dashboard.html'));
  await page.close();
  const snapshot = (await send(probe, 'q/dashboard', {})) as { data: { settings: { cookieBanners: string; gpc: boolean; onboarding: { completedAt: number | null } } } };
  expect(snapshot.data.settings).toMatchObject({ cookieBanners: 'leave', gpc: false, onboarding: { completedAt: null } });
  expect(await enabledRulesets(probe)).not.toContain('cookies');
  await expect(probe.getByRole('link', { name: 'Finish setup' })).toBeVisible({ timeout: POLL.timeout });

  const again = await context.newPage();
  await again.emulateMedia({ reducedMotion: 'reduce' });
  await again.goto(probe.url().replace(/dashboard\.html.*$/, 'onboarding.html'));
  await again.getByRole('button', { name: 'Next' }).click();
  await again.getByRole('button', { name: 'Next' }).click();
  const demo = again.locator('[aria-hidden="true"] span').nth(1);
  await expect(demo).toBeVisible({ timeout: POLL.timeout });
  expect(await demo.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
