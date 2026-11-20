/**
 * Toolbar panel in real Chromium (P1-40, P1-41): the built `popup.html`, opened as a tab the way
 * performance notes §3 and S-06 do. Every header state of UI notes §3 is drawn from the state fixtures
 * (`tests/fixtures/panel/tabStates.ts`): an init script answers the panel's `q/tabState` with the
 * fixture, so axe-core (colour contrast included) runs on the real CSS in light and dark. A keyboard-only
 * pass changes the level with the arrow keys. The real-worker journeys J5 and J7 are in
 * `panelJourneys.spec.ts`.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type { HeaderKind } from '../../src/features/popup/header.js';
import { HEADER_BUTTONS, HEADER_TEXT, TAB_STATES } from '../fixtures/panel/tabStates.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile } from './helpers/browser.js';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const KINDS = Object.keys(TAB_STATES) as HeaderKind[];
const THEMES = ['light', 'dark'] as const;
/** Extra fixture: reduced mode on a tab whose address Chrome does not report. */
const NO_HOST = 'reduced-no-host';
/** The paused fixture is relative to the fixture clock; the panel uses the real one, so only the prefix is compared. */
const PAUSED_PREFIX = 'Paused for ';
/** A tab id Chrome has not handed out in this short-lived profile. */
const NO_SUCH_TAB = 999_999_999;

interface Sent {
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Test-only: answers the panel's messages from a fixture and records what it sent. Runs in the
 * extension page before the panel's script; nothing of this is in the build.
 */
function stubWorker(fixtures: Record<string, unknown>): void {
  const kind = new URLSearchParams(location.search).get('fixture');
  if (kind === null) return;
  const sent: unknown[] = [];
  (window as unknown as { __sent: unknown[] }).__sent = sent;
  const runtime = chrome.runtime as unknown as {
    sendMessage: (m: { type: string; payload: unknown }) => Promise<unknown>;
  };
  // Remembers the last level it was told, like the worker would.
  let state = fixtures[kind] as Record<string, unknown>;
  runtime.sendMessage = (message) => {
    sent.push({ type: message.type, payload: message.payload });
    if (message.type === 'q/tabState') return Promise.resolve({ ok: true, data: state });
    const { level } = message.payload as { level?: string };
    if (message.type === 'c/setSiteLevel' && level !== undefined && level !== 'inherit') state = { ...state, level, setOn: state['host'] };
    return Promise.resolve({ ok: true, data: { status: 'applied' } });
  };
  const permissions = chrome.permissions as unknown as {
    request: (q: unknown) => Promise<boolean>;
  };
  permissions.request = (query) => {
    sent.push({ type: 'permissions.request', payload: query });
    return Promise.resolve(false);
  };
}

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await launch(await newProfile(), BUILD_DIR);
  extensionId = new URL((await extensionWorker(context)).url()).host;
  await context.addInitScript(stubWorker, {
    ...TAB_STATES,
    [NO_HOST]: { ...TAB_STATES.reduced, host: null },
  });
});

test.afterAll(async () => {
  await closeAll();
  await expectNoSurvivors();
});

async function openPanel(kind: HeaderKind, theme: (typeof THEMES)[number] = 'light'): Promise<Page> {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`chrome-extension://${extensionId}/popup.html?tabId=1&fixture=${kind}`);
  return page;
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(await AXE_SOURCE);
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (c: Document, o: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

const sent = (page: Page): Promise<Sent[]> => page.evaluate(() => (window as unknown as { __sent: Sent[] }).__sent);

test('the build has a static shell that paints before the script', async () => {
  const html = await readFile(`${BUILD_DIR}/popup.html`, 'utf8');
  // Empty: its words would be English whatever the locale; the copy comes from _locales (P2-40).
  expect(html).toMatch(/<div id="app"><p[^>]*><\/p><\/div>/);
  expect(html).toMatch(/<script type="module"[^>]*src="\/chunks\/popup-[^"]+\.js">/);
});

for (const theme of THEMES) {
  for (const kind of KINDS) {
    test(`${kind} (${theme}): planned text and buttons, axe 0 violations`, async () => {
      const page = await openPanel(kind, theme);
      const state = page.locator(`[data-state="${kind}"]`);
      const text = kind === 'paused' ? PAUSED_PREFIX : HEADER_TEXT[kind];
      await expect(state).toContainText(text);
      // The header's own buttons; the privacy card and "Something wrong…" (`data-opens`, P2-12 / P2-14) are checked elsewhere; so is "Hide something" (P2-21).
      await expect(page.getByRole('button').and(page.locator(':not([data-opens])')).filter({ hasNotText: 'Hide something' })).toHaveText([...HEADER_BUTTONS[kind]]);
      expect(await page.title()).toBe('Glassmere');
      expect(await axeViolations(page)).toEqual([]);
      await page.close();
    });
  }
}

test('keyboard only: Tab reaches the level control, arrow keys change the level, one command each', async () => {
  const page = await openPanel('normal');
  await expect(page.getByRole('radio', { name: 'Standard' })).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: 'Standard' })).toBeFocused();
  const label = page.locator('label', { hasText: 'Standard' });
  expect(await label.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Thorough' })).toBeChecked();
  await expect(page.getByText('Also scans each page for generic ad boxes. Slightly slower.')).toBeVisible();
  await expect(page.getByText('Saved. Reload the page in a few seconds to see the change.')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked();
  await expect
    .poll(async () => (await sent(page)).filter((m) => m.type === 'c/setSiteLevel').at(-1)?.payload)
    .toEqual({ hostname: 'news.example.com', level: 'light' });
  const levels = (await sent(page)).filter((m) => m.type === 'c/setSiteLevel').map((m) => (m.payload as { level: string }).level);
  expect(levels[0]).toBe('thorough');
  expect(levels.at(-1)).toBe('light');
  await page.close();
});

test('keyboard only: the reduced-mode banner actions are reachable and ask Chrome for access', async () => {
  const page = await openPanel('reduced');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Allow on this site' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Allow on all sites' })).toBeFocused();
  await page.keyboard.press('Space');
  await expect
    .poll(async () => (await sent(page)).filter((m) => m.type === 'permissions.request').map((m) => m.payload))
    .toEqual([{ origins: ['*://news.example.com/*'] }, { origins: ['<all_urls>'] }]);
  await expect(page.getByText('Site access was not allowed.')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: 'Standard' })).toBeFocused();
  await page.close();
});

test('forced colours: the focused checked option still shows its focus, and the check mark stays', async () => {
  const page = await openPanel('normal');
  await page.emulateMedia({ forcedColors: 'active' });
  await page.keyboard.press('Tab');
  const label = page.locator('label', { hasText: 'Standard' });
  expect(await label.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  expect(await label.evaluate((el) => getComputedStyle(el, '::before').content)).toContain('✓');
  await page.close();
});

test('without a known address the level control is disabled with a reason, axe 0 violations', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?tabId=1&fixture=${NO_HOST}`);
  await expect(page.getByText('Open a website in this tab to choose a level.')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Standard' })).toBeDisabled();
  expect(await axeViolations(page)).toEqual([]);
  await page.close();
});

/** A 360 px panel at 200 % zoom lays out in 180 CSS px. */
const ZOOMED_WIDTH = 180;

test('usable at 200 % zoom: nothing is cut off sideways', async () => {
  const page = await openPanel('limited');
  await page.setViewportSize({ width: ZOOMED_WIDTH, height: 560 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.close();
});

test('against the real worker the panel never guesses: for a tab that does not exist it says it cannot read it', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?tabId=${String(NO_SUCH_TAB)}`);
  await expect(page.locator('[data-state="unavailable"]')).toContainText('Could not read the state of this tab');
  expect(await axeViolations(page)).toEqual([]);
  await page.close();
});
