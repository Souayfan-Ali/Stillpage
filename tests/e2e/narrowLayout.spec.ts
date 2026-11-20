/**
 * P3-16 (narrow screens): the dashboard (every section, with a site row and a hidden item), the first-run
 * page (every step) and the blocked page on the real build at 360 CSS px, as on a phone browser that runs
 * extensions: no sideways scroll, and every control a finger uses is at least 44 × 44 px (WCAG 2.5.8 asks
 * 24; 44 is the touch size the owner asked for). Inline links inside a sentence are exempt, as in 2.5.8.
 * axe-core runs on each page in light and dark at that width. Throwaway profile; no web pages.
 */
import { expect, test, type Page } from '@playwright/test';
import { SECTIONS } from '../../src/features/dashboard/strings.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from './helpers/browser.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { expectAccessible, openPage, POLL, send, settled } from './helpers/settingsPages.js';

const PHONE = { width: 360, height: 780 } as const;
const TOUCH_PX = 44;
/** Sub-pixel rounding of a 44 px box. */
const ROUNDING = 0.5;

test.setTimeout(180_000);

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

/** Sideways overflow of the document, in CSS px (0 when nothing scrolls sideways). */
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * Visible controls smaller than `min` in either direction. A check box or radio counts by its label when it
 * sits in one (the label is what a finger hits); a link counts unless it sits inside running text.
 */
function smallTargets(page: Page, min: number): Promise<string[]> {
  return page.evaluate((size) => {
    const CONTROLS = 'button, select, summary, input, a[href]';
    const inSentence = (el: Element): boolean => el.tagName === 'A' && el.closest('p, li:not(nav li), dd, td') !== null && el.parentElement?.childNodes.length !== 1;
    const out: string[] = [];
    for (const el of document.querySelectorAll(CONTROLS)) {
      const closed = el.closest('details:not([open])');
      const folded = closed !== null && el !== closed.querySelector(':scope > summary');
      if (el.closest('.visually-hidden') !== null || folded || inSentence(el)) continue;
      const box = (el.matches('input[type=checkbox], input[type=radio]') ? el.closest('label') ?? el : el).getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || style.visibility === 'hidden') continue;
      if (box.width + 0.5 < size || box.height + 0.5 < size) out.push(`${el.tagName.toLowerCase()} "${(el.textContent.trim() === '' ? el.getAttribute('aria-label') ?? '' : el.textContent).trim().slice(0, 30)}" ${box.width.toFixed(0)}×${box.height.toFixed(0)}`);
    }
    return out;
  }, min - ROUNDING);
}

async function expectPhoneReady(page: Page, where: string): Promise<void> {
  expect(await overflow(page), `${where}: sideways scroll`).toBeLessThanOrEqual(0);
  expect(await smallTargets(page, TOUCH_PX), `${where}: targets under ${String(TOUCH_PX)} px`).toEqual([]);
}

test('dashboard at 360 px: every section fits, every control is a 44 px target, axe 0', async () => {
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'dashboard.html');
  await settled(page);
  await send(page, 'c/setSiteLevel', { hostname: 'news.example', level: 'thorough' });
  await page.setViewportSize(PHONE);
  for (const section of SECTIONS) {
    await page.goto(page.url().replace(/#.*$/, '') + `#${section}`);
    await page.reload();
    await expect(page.locator('h1')).toBeVisible(POLL);
    await expect(page.locator('main')).not.toContainText('Loading', POLL);
    await expectPhoneReady(page, section);
  }
  await page.goto(page.url().replace(/#.*$/, '') + '#sites');
  await expect(page.getByRole('rowheader', { name: 'news.example' })).toBeVisible(POLL);
  await expectAccessible(page);
});

test('first-run page at 360 px: every step fits, every control is a 44 px target, axe 0', async () => {
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'onboarding.html');
  await page.setViewportSize(PHONE);
  for (const heading of ['You are protected.', 'Choose extras', 'Three things to know']) {
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible(POLL);
    await expectPhoneReady(page, heading);
    await expectAccessible(page);
    await page.getByRole('button', { name: /^(Next|Finish)$/ }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'All set.' })).toBeVisible(POLL);
  await expectPhoneReady(page, 'done');
});

test('blocked page at 360 px: fits, its buttons and disclosure are 44 px targets, axe 0', async () => {
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'popup.html?tabId=1');
  await page.setViewportSize(PHONE);
  await page.goto(page.url().replace(/popup\.html.*$/, 'blocked.html#https://ads.example/landing?x=1'));
  await expect(page.getByRole('heading', { level: 1, name: 'This page was blocked' })).toBeVisible(POLL);
  await expectPhoneReady(page, 'blocked');
  await expectAccessible(page);
});
