/**
 * P3-18: the toolbar panel fits Chrome's panel without a vertical scroll bar. Chrome sizes the panel to its
 * document, up to 600 px tall (and 800 wide); past that the panel scrolls. The built `popup.html` is opened at
 * the panel's real size (its own 360 px width, 600 px tall) in its fullest common state: a web page at
 * Thorough just chosen (the "Saved. Reload the page" banner with its button), the blocked-requests card with
 * three categories, the pop-up row, two hidden things and "Something wrong with this page?". The paused,
 * no-access and off states are checked too, in light and dark. The worker's answers come from fixtures
 * (as in `panel.spec.ts`); nothing reaches the network.
 *
 * The fit depends on the font `system-ui` resolves to, so the font is pinned (D-139): on Linux each browser
 * gets a `FONTCONFIG_FILE` from `tests/e2e/fonts/` and the test first checks which font really drew the text.
 * `reference` (Noto Sans) is the gate: no scroll bar. `wide` (DejaVu Sans, the default sans of several Linux
 * desktops, about a sixth wider in bold) may scroll down by a bounded amount, never sideways (D-140).
 */
import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type { HeaderKind } from '../../src/features/popup/header.js';
import { TAB_STATES } from '../fixtures/panel/tabStates.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile } from './helpers/browser.js';

/** Chrome's largest toolbar panel height, and the panel's own width (Popup.module.css). */
const PANEL = { width: 360, height: 600 } as const;
const THEMES = ['light', 'dark'] as const;
const FULLEST = 'fullest';
/** A bound, not a budget: how far the panel may run past 600 px in the wide font (measured: 97 px fullest, 42 px no-access). */
const WIDE_MAX_DOWN_PX = 120;
/** fontconfig is what Chromium asks on Linux only; elsewhere the reference check runs in the system font. */
const PINS_FONTS = process.platform === 'linux';
const FONT_DIR = path.resolve(import.meta.dirname, 'fonts');
const FONTS = [
  { name: 'reference', family: 'Noto Sans', conf: 'reference.conf', debPackage: 'fonts-noto-core', maxDown: 0 },
  { name: 'wide', family: 'DejaVu Sans', conf: 'wide.conf', debPackage: 'fonts-dejavu-core', maxDown: WIDE_MAX_DOWN_PX },
] as const;

const COUNTS = {
  kind: 'counts', stale: false, at: 1_800_000_000_000, total: 27,
  groups: [
    { category: 'ads', count: 14, buckets: [{ id: 'google', name: 'Google', count: 6 }, { id: 'other:ads', name: null, count: 8 }] },
    { category: 'tracking', count: 13, buckets: [{ id: 'meta', name: 'Meta', count: 4 }, { id: 'other:tracking', name: null, count: 9 }] },
  ],
  rules: [{ rulesetId: 'ubo', ruleId: 4411 }], moreRules: 11,
};

/** Test-only, runs in the extension page before the panel's script: answers its messages from fixtures. */
function stubWorker(data: { readonly states: Record<string, unknown>; readonly counts: unknown }): void {
  const kind = new URLSearchParams(location.search).get('fixture');
  if (kind === null) return;
  let state = data.states[kind] as Record<string, unknown>;
  const runtime = chrome.runtime as unknown as { sendMessage: (m: { type: string; payload: unknown }) => Promise<unknown> };
  runtime.sendMessage = (message) => {
    if (message.type === 'q/tabState') return Promise.resolve({ ok: true, data: state });
    if (message.type === 'q/matchedRules') return Promise.resolve({ ok: true, data: data.counts });
    const { level } = (message.payload ?? {}) as { level?: string };
    if (message.type === 'c/setSiteLevel' && level !== undefined) state = { ...state, level, setOn: state['host'] };
    return Promise.resolve({ ok: true, data: { status: 'applied' } });
  };
}

/** How far the document runs past the panel, down and sideways, in CSS px (0 when it fits). */
const overflow = (page: Page): Promise<{ readonly down: number; readonly sideways: number }> =>
  page.evaluate(() => ({
    down: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));

/** The fonts that really drew the element's text (what the family list resolved to), from DevTools. */
async function drawnFonts(page: Page, selector: string): Promise<readonly string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map((font) => font.familyName);
  } finally {
    await cdp.detach();
  }
}

for (const font of FONTS) {
  test.describe(`${font.name} font`, () => {
    test.skip(!PINS_FONTS && font.name !== 'reference', 'fonts are pinned through fontconfig, on Linux only');

    let context: BrowserContext;
    let extensionId: string;

    test.beforeAll(async () => {
      const env = PINS_FONTS ? { env: { FONTCONFIG_FILE: path.join(FONT_DIR, font.conf) } } : {};
      context = await launch(await newProfile(), BUILD_DIR, env);
      extensionId = new URL((await extensionWorker(context)).url()).host;
      await context.addInitScript(stubWorker, { states: { ...TAB_STATES, [FULLEST]: { ...TAB_STATES.normal, hidden: ['.ad-box', '#promo'] } }, counts: COUNTS });
    });

    test.afterAll(async () => {
      await closeAll();
      await expectNoSurvivors();
    });

    async function openPanel(fixture: string, theme: (typeof THEMES)[number]): Promise<Page> {
      const page = await context.newPage();
      await page.setViewportSize(PANEL);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(`chrome-extension://${extensionId}/popup.html?tabId=1&fixture=${fixture}`);
      return page;
    }

    const claim = font.maxDown === 0 ? 'fits the panel with no scroll bar' : `runs at most ${String(font.maxDown)} px past the panel, never sideways`;

    /** Fits when `maxDown` is 0; in the wide font it may scroll down by at most `maxDown`, never sideways. */
    async function expectFits(page: Page): Promise<void> {
      const { down, sideways } = await overflow(page);
      expect({ down: Math.max(0, down - font.maxDown), sideways }).toEqual({ down: 0, sideways: 0 });
    }

    test(`the panel's text is drawn in ${font.family}`, async () => {
      test.skip(!PINS_FONTS, 'fonts are pinned through fontconfig, on Linux only');
      const page = await openPanel('normal', 'light');
      await expect(page.getByRole('heading', { name: 'news.example.com' })).toBeVisible();
      expect(await drawnFonts(page, 'h2'), `${font.family} must be installed (Debian/Ubuntu: ${font.debPackage})`).toEqual([font.family]);
      await page.close();
    });

    for (const theme of THEMES) {
      test(`fullest common state ${claim} (${theme})`, async () => {
        const page = await openPanel(FULLEST, theme);
        await expect(page.getByRole('button', { name: /27 blocked on this page/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /What you hid on this site/ })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Something wrong with this page?' })).toBeVisible();
        await expect(page.locator('[data-state="popup-row"]')).toBeVisible();
        await page.getByRole('radio', { name: 'Thorough' }).focus();
        await page.keyboard.press('Space');
        await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();
        await expect(page.getByText('Saved. Reload the page in a few seconds to see the change.')).toBeVisible();
        await expectFits(page);
        await page.close();
      });

      for (const kind of ['paused', 'reduced', 'off'] as const satisfies readonly HeaderKind[]) {
        test(`${kind} ${claim} (${theme})`, async () => {
          const page = await openPanel(kind, theme);
          await expect(page.locator(`[data-state="${kind}"]`)).toBeVisible();
          await expect(page.getByRole('button', { name: /blocked on this page/ })).toBeVisible();
          await expectFits(page);
          await page.close();
        });
      }
    }
  });
}
