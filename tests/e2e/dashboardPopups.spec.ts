/**
 * P2-60, dashboard part (a J19 sub-journey, not J19): the pop-up mode and a per-site pop-up choice set
 * keyboard-only from the dashboard, stored, the site's opener `allow` rule installed, and both kept
 * after a browser restart on the same profile. The panel row, the page's count and list are
 * `journeyPopupRow.spec.ts`; the in-page notice is `journeyPopupControls.spec.ts` and `hostile/sentinel.spec.ts`. Throwaway profile; no web pages.
 */
import { test, expect, type Page } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from './helpers/browser.js';
import { expectAccessible, openPage, POLL, send, settled } from './helpers/settingsPages.js';

test.setTimeout(150_000);

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

const allowRuleFor = (page: Page, host: string): Promise<boolean> =>
  page.evaluate(async (h) => (await chrome.declarativeNetRequest.getDynamicRules()).some((r) => r.action.type === 'allow' && (r.condition.initiatorDomains ?? []).includes(h)), host);

interface Popups {
  readonly mode: string;
  readonly sites: Record<string, string>;
}
const popupsOf = async (page: Page): Promise<Popups> => ((await send(page, 'q/dashboard', {})) as { data: { settings: { popups: Popups } } }).data.settings.popups;

test('pop-up mode and a per-site choice, keyboard only; kept after a restart', async () => {
  const profile = await newProfile();
  const first = await launch(profile, BUILD_DIR);
  const page = await openPage(first, 'dashboard.html');
  await settled(page);
  expect(await send(page, 'c/setSiteLevel', { hostname: 'pay.example', level: 'standard' })).toMatchObject({ ok: true });
  await page.reload();

  await page.getByLabel('Off', { exact: true }).last().focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await popupsOf(page)).mode, POLL).not.toBe('off');
  // The guard ships (P2-58): no "not active" note.
  await expect(page.getByText(/not active in this version yet/)).toHaveCount(0);
  await expectAccessible(page);

  await page.goto(`${page.url().split('#')[0] ?? ''}#sites`);
  const select = page.getByLabel('Pop-ups on pay.example');
  await select.focus();
  await select.selectOption('allow');
  await expect.poll(async () => (await popupsOf(page)).sites, POLL).toEqual({ 'pay.example': 'allow' });
  await expect.poll(() => allowRuleFor(page, 'pay.example'), POLL).toBe(true);
  const mode = (await popupsOf(page)).mode;
  await expectAccessible(page);
  await first.close();

  const second = await launch(profile, BUILD_DIR);
  const again = await openPage(second, 'dashboard.html#sites');
  await settled(again);
  expect(await popupsOf(again)).toEqual({ mode, sites: { 'pay.example': 'allow' }, notice: true });
  await expect.poll(() => allowRuleFor(again, 'pay.example'), POLL).toBe(true);
  await expect(again.getByLabel('Pop-ups on pay.example')).toHaveValue('allow', { timeout: POLL.timeout });
});
