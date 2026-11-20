/**
 * Toolbar panel against the real worker (P1-41, testing notes §6): J5 (level per site, keyboard only) and
 * J7 (site access withheld / granted / revoked). The fixture corpus extension (P1-42) runs under the
 * HTTPS fixture server; the panel is opened as a tab for the fixture page's tab id (performance notes §3), so
 * the worker reads that tab with `tabs.get` exactly as it does for the toolbar panel. After every
 * change the worker's dynamic rules, registrations and rulesets are compared with `computeDesired`
 * over the vault, the grants and the catalog, and the page is reloaded to see the effect.
 *
 * Chrome's site-access prompt cannot be clicked in a test, so `permissions.request` in the panel is
 * replaced by a stub that records the request and waits; the test then grants access the way the
 * extensions menu does (S-10) and lets the stub answer `true`, as the prompt would.
 */
import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { Catalog } from '../../src/core/catalog/types.js';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import { loadFixtures } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { applySettings, createCorpusExtension, launchCorpus, reconciledSince, setSiteAccess, type CorpusExtension } from './helpers/corpus.js';
import { closeAll, expectNoSurvivors, extensionWorker, newProfile } from './helpers/browser.js';
import { catalogOf, expectReconciled as expectStateReconciled, openPanel, tabIdOf } from './helpers/session.js';
import { PROPAGATION_WINDOW_MS, settleVisits } from './helpers/settle.js';

const LEVELS_PAGE = 'https://levels.example/levels/page.html';
const PERM_PAGE = 'https://perm.example/permissions/page.html';
const LEVEL_AD = 'https://lvl-ads.example/ad.js';
const PERM_AD = 'https://perm-ads.example/ad.js';
const PAUSE_MS = 10 * 60_000;

let server: FixtureServer;
let extension: CorpusExtension;
let catalog: Catalog;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createCorpusExtension(loadFixtures());
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

interface Session {
  readonly context: BrowserContext;
  readonly worker: Worker;
  readonly id: string;
  readonly profile: string;
}

/** Test-only stand-in for Chrome's site-access prompt (see the file comment). */
function stubAccessPrompt(): void {
  // Runs in every page of the context; only extension pages have `chrome.permissions`.
  if (typeof chrome === 'undefined' || !('permissions' in chrome)) return;
  const asked: unknown[] = [];
  let answer: (granted: boolean) => void = () => undefined;
  const w = window as unknown as { __asked: unknown[]; __answer: (granted: boolean) => void };
  w.__asked = asked;
  w.__answer = (granted) => {
    answer(granted);
  };
  const permissions = chrome.permissions as unknown as { request: (q: unknown) => Promise<boolean> };
  permissions.request = (query) => {
    asked.push(query);
    return new Promise<boolean>((resolve) => {
      answer = resolve;
    });
  };
}

async function start(): Promise<Session> {
  const profile = await newProfile();
  const since = Date.now();
  const context = await launchCorpus(profile, extension.dir, server.chromiumArgs);
  contexts.add(context);
  await context.addInitScript(stubAccessPrompt);
  const worker = await extensionWorker(context);
  await reconciledSince(worker, since, /^installed:/);
  return { context, worker, id: new URL(worker.url()).host, profile };
}

/** Whether the server saw `url` and whether the probe content script ran, after a fresh reload. */
/**
 * Every reload here follows a level or access change, which Chrome applies to new loads a little after the
 * API resolved (`helpers/settle.ts`): reload until the page shows `wanted` or the window is spent.
 */
async function reloadUntil(page: Page, url: string, wanted: { request: string; probe: string | null }): Promise<{ request: string; probe: string | null }> {
  const result = await settleVisits(async () => {
    const seen = await reloadAndObserve(page, url);
    return { wanted: [wanted.request, wanted.probe], actual: [seen.request, seen.probe] };
  }, PROPAGATION_WINDOW_MS);
  return { request: String(result.actual[0]), probe: (result.actual[1] as string | null) ?? null };
}

async function reloadAndObserve(page: Page, url: string): Promise<{ request: string; probe: string | null }> {
  server.clearLog();
  await page.reload({ waitUntil: 'load' });
  // A blocked script never reaches the server; `load` waits for every script, so the log is complete.
  const seen = server.log().some((r) => `https://${r.host}${r.path}` === url);
  // The probe registration runs at `document_idle`, which may come after `load`.
  await page.waitForLoadState('networkidle');
  return { request: seen ? 'loaded' : 'blocked', probe: await page.evaluate(() => document.documentElement.getAttribute('data-probe')) };
}

/** Chrome's actual state equals `computeDesired(vault settings, grants, catalog)`. */
async function expectReconciled(s: Session): Promise<void> {
  const page = await s.context.newPage();
  try {
    await page.goto(`chrome-extension://${s.id}/fx.html`);
    await expectStateReconciled(page, catalog);
  } finally {
    await page.close();
  }
}

async function chooseLevelByKeyboard(panel: Page, key: 'ArrowLeft' | 'ArrowRight', expected: string): Promise<void> {
  await panel.keyboard.press(key);
  await expect(panel.getByRole('radio', { name: expected })).toBeChecked();
  await expect(panel.getByText('Saved. Reload the page in a few seconds to see the change.')).toBeVisible();
}

test('J5 level per site, keyboard only: Standard → Light → Thorough, then Resume now ends a pause', async () => {
  const s = await start();
  const page = await s.context.newPage();
  await page.goto(LEVELS_PAGE);
  const tabId = await tabIdOf(s.worker, 'https://levels.example/');
  const panel = await openPanel(s, tabId);
  await expect(panel.locator('[data-state="normal"]')).toContainText('Protected — Standard');
  await panel.keyboard.press('Tab');
  await expect(panel.getByRole('radio', { name: 'Standard' })).toBeFocused();

  await chooseLevelByKeyboard(panel, 'ArrowLeft', 'Light');
  await expectReconciled(s);
  expect(await reloadUntil(page, LEVEL_AD, { request: 'blocked', probe: null })).toEqual({ request: 'blocked', probe: null });

  await chooseLevelByKeyboard(panel, 'ArrowRight', 'Standard');
  await chooseLevelByKeyboard(panel, 'ArrowRight', 'Thorough');
  await expectReconciled(s);
  expect(await reloadUntil(page, LEVEL_AD, { request: 'blocked', probe: 'ran' })).toEqual({ request: 'blocked', probe: 'ran' });

  const now = Date.now();
  await applySettings(s.context, s.worker, s.id, { ...createDefaultSettings(), pauses: { 'levels.example': { until: now + PAUSE_MS } } });
  expect(await reloadUntil(page, LEVEL_AD, { request: 'loaded', probe: null })).toEqual({ request: 'loaded', probe: null });
  await panel.reload();
  await expect(panel.locator('[data-state="paused"]')).toContainText('Paused for');
  await panel.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Resume now' })).toBeFocused();
  const since = Date.now();
  await panel.keyboard.press('Enter');
  await reconciledSince(s.worker, since, /^command$/);
  await expect(panel.locator('[data-state="normal"]')).toContainText('Protected — Standard');
  await expectReconciled(s);
  expect(await reloadUntil(page, LEVEL_AD, { request: 'blocked', probe: 'ran' })).toEqual({ request: 'blocked', probe: 'ran' });
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});

async function changeAccess(s: Session, access: 'all' | 'none' | 'site'): Promise<void> {
  const since = Date.now();
  await setSiteAccess(s.context, s.id, access, PERM_PAGE);
  await reconciledSince(s.worker, since, /^permissions$/);
}

/** Clicks the panel's "Allow on all sites", checks what it asked Chrome for, then grants it. */
async function allowAllFromPanel(s: Session, panel: Page): Promise<void> {
  await panel.getByRole('button', { name: 'Allow on all sites' }).click();
  await expect.poll(() => panel.evaluate(() => (window as unknown as { __asked: unknown[] }).__asked)).toEqual([{ origins: ['<all_urls>'] }]);
  await changeAccess(s, 'all');
  await panel.evaluate(() => {
    (window as unknown as { __answer: (granted: boolean) => void }).__answer(true);
  });
  await expect(panel.getByText('Site access allowed.')).toBeVisible();
}

test('J7 site access: withheld → reduced (Light), granted from the panel, this site only → limited, revoked → reduced', async () => {
  const s = await start();
  const page = await s.context.newPage();
  await page.goto(PERM_PAGE);
  const tabId = await tabIdOf(s.worker, 'https://perm.example/');
  const panelFor = (): Promise<Page> => openPanel(s, tabId);

  await changeAccess(s, 'none');
  expect(await reloadUntil(page, PERM_AD, { request: 'blocked', probe: null })).toEqual({ request: 'blocked', probe: null });
  await expectReconciled(s);
  const reduced = await panelFor();
  await expect(reduced.locator('[data-state="reduced"]')).toContainText('Running as Light: site access is off');
  await expect(reduced.getByRole('button').and(reduced.locator(':not([data-opens])')).filter({ hasNotText: 'Hide something' })).toHaveText(['Allow on all sites']);
  await expect(reduced.getByText('Open a website in this tab to choose a level.')).toBeVisible();
  await allowAllFromPanel(s, reduced);
  await expect(reduced.locator('[data-state="normal"]')).toContainText('Protected — Standard');
  await expectReconciled(s);
  expect(await reloadUntil(page, PERM_AD, { request: 'blocked', probe: 'ran' })).toEqual({ request: 'blocked', probe: 'ran' });
  expect(await page.evaluate(() => (window as unknown as { __surrogate?: string }).__surrogate ?? null)).toBe('fx-noop');

  await changeAccess(s, 'site');
  const limited = await panelFor();
  await expect(limited.locator('[data-state="limited"]')).toContainText('Replacement scripts and the pop-up blocked page need access to all sites');
  await expect(limited.getByRole('button').and(limited.locator(':not([data-opens])')).filter({ hasNotText: 'Hide something' })).toHaveText(['Allow on all sites', 'Pause on this site']);
  await expectReconciled(s);
  expect(await reloadUntil(page, PERM_AD, { request: 'blocked', probe: 'ran' })).toEqual({ request: 'blocked', probe: 'ran' });

  await changeAccess(s, 'none');
  await limited.reload();
  await expect(limited.locator('[data-state="reduced"]')).toBeVisible();
  await expectReconciled(s);
  expect(await reloadUntil(page, PERM_AD, { request: 'blocked', probe: null })).toEqual({ request: 'blocked', probe: null });
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});
