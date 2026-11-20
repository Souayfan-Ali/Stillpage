/**
 * J9 breakage flow (P2-14, testing notes §6), keyboard only, on the real build with the fixture corpus. The
 * three ladders of P2-13 (the fourth, pop-ups, is P2-62). The `levels/` fixture page tells the levels
 * apart: its ad request is blocked at Light and above, its probe content script runs at Standard and
 * above. Each trial reloads the tab from the panel (`tabs.reload`); the panel is closed and opened
 * again in between, so the flow is shown to survive the reload from `storage.session`. The report step's
 * preview names the host only (P2-15). axe (light and dark) on each step reached (P2-39).
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type { Catalog } from '../../src/core/catalog/types.js';
import { loadFixtures, type FixtureEntry } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { closeAll, expectNoSurvivors } from './helpers/browser.js';
import { createCorpusExtension, type CorpusExtension } from './helpers/corpus.js';
import { catalogOf, expectReconciled, openPanel, startSession, tabIdOf, vaultValue, type Session } from './helpers/session.js';
import { expectAccessible } from './helpers/settingsPages.js';

const ALL = loadFixtures();
const STANDARD = ((): FixtureEntry => {
  const found = ALL.find((f) => f.id === 'levels/standard');
  if (found === undefined) throw new Error('levels/standard missing');
  return found;
})();
const HOST = new URL(STANDARD.page).hostname;
const AD = 'https://lvl-ads.example/ad.js';
const POLL = { timeout: 10_000, intervals: [100, 250, 500] };

let server: FixtureServer;
let extension: CorpusExtension;
let catalog: Catalog;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createCorpusExtension(ALL);
  catalog = await catalogOf(extension.dir);
});

test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});

test.afterAll(async () => {
  try {
    await (server as FixtureServer | undefined)?.close();
    await (extension as CorpusExtension | undefined)?.remove();
  } finally {
    await expectNoSurvivors();
  }
});

/** Presses Tab until the control named `name` has focus. */
async function tabTo(panel: Page, name: string | RegExp, max = 12): Promise<void> {
  const target = panel.getByRole('button', { name });
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await panel.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Keyboard only: focus the control by Tab, then Enter. */
async function press(panel: Page, name: string | RegExp): Promise<void> {
  await tabTo(panel, name);
  await panel.keyboard.press('Enter');
}

interface Fixture {
  readonly page: Page;
  readonly tabId: number;
}

async function openFixture(s: Session): Promise<Fixture> {
  const page = await s.context.newPage();
  await page.goto(STANDARD.page);
  return { page, tabId: await tabIdOf(s.probe.page, `https://${HOST}/`) };
}

/** Opens the panel for the fixture tab and goes to the breakage flow by keyboard. */
async function openFlow(s: Session, fx: Fixture): Promise<Page> {
  const panel = await openPanel(s, fx.tabId);
  await expect(panel.locator('[data-state="normal"], [data-state="off"], [data-state="paused"]').first()).toBeVisible();
  await press(panel, 'Something wrong with this page?');
  await expect(panel.getByRole('heading', { name: 'Fix this page' })).toBeFocused();
  return panel;
}

/**
 * Runs a "Try it" step by keyboard and waits for the reload it causes; reports what the page did. The
 * probe attribute is polled briefly (a content script may run just after `load` under load).
 */
async function tryAndReload(panel: Page, fx: Fixture, action: string, probe: string | null = null): Promise<{ ad: 'blocked' | 'loaded'; probe: string | null }> {
  const loaded = fx.page.waitForEvent('load');
  const ad = new Promise<'blocked' | 'loaded'>((resolve) => {
    fx.page.on('requestfinished', (r) => {
      if (r.url() === AD) resolve('loaded');
    });
    fx.page.on('requestfailed', (r) => {
      if (r.url() === AD) resolve('blocked');
    });
  });
  await press(panel, action);
  await loaded;
  const read = (): Promise<string | null> => fx.page.evaluate(() => document.documentElement.dataset['probe'] ?? null);
  await expect.poll(read, POLL).toBe(probe);
  return { ad: await ad, probe: await read() };
}

const siteLevels = async (s: Session): Promise<unknown> => ((await vaultValue(s.probe.page, 'settings')) as { siteLevels?: unknown } | undefined)?.siteLevels ?? {};

test('J9 page broken, keyboard only: Light tried, survives a closed panel, Still broken → Off, Fixed keeps Off', async () => {
  const s = await startSession(server, extension.dir, contexts);
  const fx = await openFixture(s);
  let panel = await openFlow(s, fx);
  await press(panel, 'The page looks broken or will not work');
  await expect(panel.getByRole('heading', { level: 3 })).toContainText('Step 1 of 3');
  expect(await tryAndReload(panel, fx, 'Try it and reload')).toEqual({ ad: 'blocked', probe: null });
  await expect.poll(() => siteLevels(s), POLL).toEqual({ [HOST]: 'light' });

  // The panel closes on a real reload; opened again, the flow is at "After the reload".
  await panel.close();
  panel = await openFlow(s, fx);
  await expect(panel.getByText('After the reload:')).toBeVisible();
  await expectAccessible(panel);
  await press(panel, 'Still broken');
  await expect(panel.getByRole('heading', { level: 3 })).toContainText('Step 2 of 3');
  await expect.poll(() => siteLevels(s), POLL).toEqual({});
  expect(await tryAndReload(panel, fx, 'Try it and reload')).toEqual({ ad: 'loaded', probe: null });
  await press(panel, 'Fixed');
  await expect(panel.getByText('Glad it works now. “Turn off on this site” stays on for this site.')).toBeVisible();
  await expectAccessible(panel);
  expect(await siteLevels(s)).toEqual({ [HOST]: 'off' });
  expect(await s.probe.page.evaluate(async (tab) => (await chrome.storage.session.get(`breakage:${String(tab)}`))[`breakage:${String(tab)}`], fx.tabId)).toBeUndefined();
  await expectReconciled(s.probe.page, catalog);
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});

test('J9 anti-adblock wall, keyboard only: Thorough, then a 30-minute pause, both undone, then the report step', async () => {
  const s = await startSession(server, extension.dir, contexts);
  const fx = await openFixture(s);
  const panel = await openFlow(s, fx);
  await press(panel, 'The site says I use an ad blocker');
  expect(await tryAndReload(panel, fx, 'Try it and reload', 'ran')).toEqual({ ad: 'blocked', probe: 'ran' });
  await expect.poll(() => siteLevels(s), POLL).toEqual({ [HOST]: 'thorough' });
  await press(panel, 'Still broken');
  await expect(panel.getByRole('heading', { name: 'Pause for 30 minutes' })).toBeVisible();
  await expectAccessible(panel);
  expect(await tryAndReload(panel, fx, 'Try it and reload')).toEqual({ ad: 'loaded', probe: null });
  await expect(panel.getByText('After the reload:')).toBeVisible();
  await press(panel, 'Still broken');
  await expect(panel.getByText('Nothing here fixed it. You can report the problem.')).toBeVisible();
  // P2-15: the preview names the host only, never the page's path or query.
  const preview = panel.getByRole('textbox', { name: 'Report (you can edit it before sending)' });
  await expect(preview).toHaveValue(new RegExp(`^Site: ${HOST.replace(/\./g, '\\.')} \\(path and query are never included\\)`));
  const report = await preview.inputValue();
  expect(report).toContain('tried: Thorough here (still broken), a 30-minute pause (still broken)');
  expect(report).not.toContain(new URL(STANDARD.page).pathname);
  expect(report).not.toMatch(/https?:\/\//);
  // D-88: the public tracker is set, so the report can open a prefilled issue (not clicked: no live web).
  await expect(panel.getByRole('button', { name: 'Open a new issue' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy report' })).toBeVisible();
  await expectAccessible(panel);
  const settings = (await vaultValue(s.probe.page, 'settings')) as { siteLevels: object; pauses: object };
  expect(settings).toMatchObject({ siteLevels: {}, pauses: {} });
  await expectReconciled(s.probe.page, catalog);
});

test('J9 ad got through, keyboard only: reload, then hide it or Thorough; Cancel undoes the pending trial', async () => {
  const s = await startSession(server, extension.dir, contexts);
  const fx = await openFixture(s);
  const panel = await openFlow(s, fx);
  await press(panel, 'An ad or banner got through');
  expect(await tryAndReload(panel, fx, 'Reload', 'ran')).toEqual({ ad: 'blocked', probe: 'ran' });
  await press(panel, 'Still broken');
  await expect(panel.getByRole('heading', { name: 'Hide it yourself' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Try Thorough here' })).toBeVisible();
  await expectAccessible(panel);
  expect(await tryAndReload(panel, fx, 'Try it and reload', 'ran')).toEqual({ ad: 'blocked', probe: 'ran' });
  await expect.poll(() => siteLevels(s), POLL).toEqual({ [HOST]: 'thorough' });
  await press(panel, 'Cancel and undo');
  await expect(panel.getByRole('group', { name: 'What is wrong?' })).toBeVisible();
  await expect.poll(() => siteLevels(s), POLL).toEqual({});
  await expectReconciled(s.probe.page, catalog);
});
