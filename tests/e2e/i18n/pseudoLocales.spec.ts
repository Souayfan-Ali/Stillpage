/**
 * P2-40 (UI notes §10, testing notes §7): every page of the real build in two pseudo-locales, swapped into a copy
 * of the build's `_locales/en` (never shipped): `long` (accented, bracketed, ≥ 40 % longer) and `rtl`
 * (right-to-left words, `dir=rtl`). Each state: `lang` and `dir` from the catalog, no sideways scroll, no
 * element whose text is cut or spills out of its box, the start edge on the right in RTL, and in `long`
 * no visible English left (a string the catalog does not hold). Screenshots for review go to
 * `test-results/i18n/` (reviewed for P2-40; see the log).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { PRODUCT_NAME } from '../../../src/core/brand.js';
import { SECTIONS } from '../../../src/features/dashboard/strings.js';
import { englishCatalog, resolveMessage } from '../../helpers/chromeI18n.js';
import { pseudoCatalog, type PseudoLocale } from '../../helpers/pseudoLocale.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile } from '../helpers/browser.js';
import { createFixtureExtension, type FixtureExtension } from '../helpers/fixtureExtension.js';
import { openPage, POLL, settled } from '../helpers/settingsPages.js';

const SCREENS = path.resolve(import.meta.dirname, '../../../test-results/i18n');
const SITE = 'https://news.example';
const SITE_PAGE = '<!doctype html><title>news</title><style>body{margin:0}div{width:300px;height:120px;margin:20px;background:#ddd}</style><div id="box">box</div>';
const NARROW = { width: 360, height: 800 } as const;
const WIDE = { width: 1024, height: 800 } as const;
/** Data, not copy, that may stay in Latin letters: host names, the product name, selectors. */
const DATA = new RegExp(`[\\w.-]+\\.example|${PRODUCT_NAME}|#box|div`, 'g');

interface Build {
  readonly extension: FixtureExtension;
  readonly say: (key: string, ...substitutions: readonly string[]) => string;
}

async function pseudoBuild(locale: PseudoLocale): Promise<Build> {
  const extension = await createFixtureExtension({ real: true });
  const catalog = pseudoCatalog(englishCatalog(), locale);
  await writeFile(path.join(extension.dir, '_locales/en/messages.json'), JSON.stringify(catalog));
  return { extension, say: (key, ...subs) => resolveMessage(catalog, key, subs) };
}

/** Layout problems in one document: sideways scroll, cut or spilling text, and (long) visible English. */
function audit(target: Page | Frame, locale: PseudoLocale): Promise<string[]> {
  return target.evaluate(([checkEnglish, data]) => {
    const out: string[] = [];
    const root = document.documentElement;
    const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`} "${(el.textContent).trim().slice(0, 40)}"`;
    // Read, not drawn: inside `.visually-hidden`, or the same clip on a module class (the Pop-ups legend under its
    // heading, D-96; a stacked table's header row on a phone, D-98).
    const clipped = (el: Element): boolean => {
      for (let at: Element | null = el; at !== null; at = at.parentElement) if (at.classList.contains('visually-hidden') || getComputedStyle(at).clipPath === 'inset(50%)') return true;
      return false;
    };
    if (root.scrollWidth > root.clientWidth + 1) out.push(`the page scrolls sideways (${String(root.scrollWidth)} > ${String(root.clientWidth)})`);
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.display === 'inline' || cs.visibility === 'hidden' || clipped(el)) continue;
      if (/auto|scroll/.test(cs.overflowX) || el.getBoundingClientRect().width === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1 && el.textContent.trim() !== '') out.push(`${name(el)} is wider than its box (${String(el.scrollWidth)} > ${String(el.clientWidth)})`);
    }
    if (!checkEnglish) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (parent?.closest('code, .visually-hidden, [translate="no"]') !== null || parent.getClientRects().length === 0) continue;
      const left = (n.textContent ?? '').replace(new RegExp(data, 'g'), '');
      if (/[A-Za-z]{2,}/.test(left)) out.push(`English text: "${left.trim().slice(0, 60)}"`);
    }
    return out;
  }, [locale === 'long', DATA.source] as const);
}

/** `lang`/`dir` of the catalog, the audit, and (RTL) the first heading starts on the right. */
async function check(target: Page | Frame, locale: PseudoLocale, shot: string): Promise<void> {
  const want = locale === 'rtl' ? { lang: 'ar', dir: 'rtl' } : { lang: 'en-XA', dir: 'ltr' };
  expect(await target.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir })), shot).toEqual(want);
  expect(await audit(target, locale), shot).toEqual([]);
  if (locale === 'rtl') {
    const edge = await target.evaluate(() => {
      const h = document.querySelector('h1, h2');
      if (h === null) return null;
      const r = h.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(h);
      const text = range.getBoundingClientRect();
      return { start: r.right - text.right, end: text.left - r.left };
    });
    if (edge !== null) expect(edge.start, `${shot}: RTL heading text starts at the right`).toBeLessThanOrEqual(edge.end);
  }
  const page = 'page' in target ? target.page() : target;
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, `${locale}-${shot}.png`), fullPage: true });
}

async function panelFor(context: BrowserContext): Promise<Page> {
  await context.route(`${SITE}/**`, (route) => route.fulfill({ body: SITE_PAGE, contentType: 'text/html' }));
  const site = await context.newPage();
  await site.goto(`${SITE}/`);
  const worker = await extensionWorker(context);
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] !== undefined), POLL).toBe(true);
  const tabId = await worker.evaluate(async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0]?.id ?? -1, SITE);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html?tabId=${String(tabId)}`);
  await expect(panel.getByRole('heading', { level: 2, name: 'news.example' })).toBeVisible();
  return panel;
}

async function pickerPanel(site: Page): Promise<Frame> {
  await expect.poll(() => site.evaluate(() => document.documentElement.children.length), POLL).toBe(3);
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await expect.poll(() => site.frames().some((f) => f.url().includes('picker-panel.html'))).toBe(true);
  const frame = site.frames().find((f) => f.url().includes('picker-panel.html'));
  if (frame === undefined) throw new Error('no picker panel');
  await frame.locator('[role="dialog"]').waitFor();
  return frame;
}

let build: Build | null = null;

test.afterEach(async () => {
  await closeAll();
  await build?.extension.remove();
  build = null;
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

for (const locale of ['long', 'rtl'] as const) {
  test(`${locale}: toolbar panel, its pause menu, what was blocked, the breakage flow and the element hider`, async () => {
    test.setTimeout(240_000);
    build = await pseudoBuild(locale);
    const { say } = build;
    const context = await launch(await newProfile(), build.extension.dir);
    const panel = await panelFor(context);
    await check(panel, locale, 'panel');

    await panel.getByRole('button', { name: say('panel_pause_open') }).click();
    await expect(panel.getByRole('button', { name: say('panel_pause_thirty') })).toBeVisible();
    await check(panel, locale, 'panel-pause');
    await panel.keyboard.press('Escape');

    await panel.getByRole('button', { name: say('privacy_title_no_host') }).click();
    await expect(panel.getByRole('heading', { level: 2, name: say('privacy_title', 'news.example') })).toBeVisible();
    await check(panel, locale, 'panel-blocked');
    await panel.getByRole('button', { name: say('common_back') }).click();

    await panel.getByRole('button', { name: say('panel_something_wrong') }).click();
    await expect(panel.getByRole('heading', { level: 2, name: say('breakage_title') })).toBeVisible();
    await check(panel, locale, 'breakage-question');
    await panel.getByRole('button', { name: say('breakage_complaint_broken') }).click();
    await expect(panel.getByRole('heading', { level: 3 })).toBeVisible();
    await check(panel, locale, 'breakage-step');
    await panel.getByRole('button', { name: say('breakage_cancel') }).click();
    await panel.getByRole('button', { name: say('common_back') }).click();

    const site = context.pages().find((p) => p.url().startsWith(SITE));
    if (site === undefined) throw new Error('no site page');
    // As the toolbar opens it: a popup window over the page's tab (Playwright cannot click the toolbar button).
    await site.bringToFront();
    const worker = await extensionWorker(context);
    const opened = context.waitForEvent('page');
    await worker.evaluate(async (url) => { await chrome.windows.create({ url, type: 'popup' }); }, panel.url());
    await (await opened).getByRole('button', { name: say('panel_hide_something') }).click();
    await site.bringToFront();
    const frame = await pickerPanel(site);
    await check(frame, locale, 'picker-panel');
  });

  test(`${locale}: every dashboard section, wide and narrow, and the first-run page`, async () => {
    test.setTimeout(240_000);
    build = await pseudoBuild(locale);
    const { say } = build;
    const context = await launch(await newProfile(), build.extension.dir);
    const page = await openPage(context, 'dashboard.html');
    await settled(page);
    for (const [label, size] of [['wide', WIDE], ['narrow', NARROW]] as const) {
      await page.setViewportSize(size);
      for (const section of SECTIONS) {
        await page.goto(page.url().replace(/#.*$/, '') + `#${section}`);
        await expect(page.getByRole('heading', { level: 1, name: say(`dash_section_${section}`) })).toBeVisible();
        await check(page, locale, `dashboard-${section}-${label}`);
      }
    }

    const first = await openPage(context, 'onboarding.html');
    await first.setViewportSize(NARROW);
    const steps = [['protection', 'onboarding_protected_heading'], ['extras', 'onboarding_extras_heading'], ['tools', 'onboarding_tools_heading']] as const;
    for (const [step, heading] of steps) {
      await expect(first.getByRole('heading', { level: 1, name: say(heading) })).toBeVisible(POLL);
      await check(first, locale, `onboarding-${step}`);
      await first.getByRole('button', { name: step === 'tools' ? say('onboarding_finish') : say('common_next'), exact: true }).click();
    }
    await expect(first.getByRole('heading', { name: say('onboarding_done_heading') })).toBeVisible(POLL);
    await check(first, locale, 'onboarding-done');
  });
}
