/**
 * J10 privacy panel (P2-12, testing notes §6) on the real build with the fixture corpus.
 *
 * `getMatchedRules` needs `activeTab` granted by a real toolbar click, which Playwright cannot make
 * (no toolbar in headless). So this spec runs a **test-only copy** of the corpus extension whose
 * manifest adds `declarativeNetRequestFeedback`, with a `buckets.json` for the fixture ruleset `fx`
 * (design review, P2-11). The build itself refuses that permission (`wxt.config.ts`), and the `activeTab` path
 * is a manual release-checklist item (`docs/permissions.md`). A second, unmodified copy shows the
 * honest "unavailable" state when the panel was not opened from the toolbar.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { loadFixtures, type FixtureEntry } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { closeAll, expectNoSurvivors } from './helpers/browser.js';
import { createCorpusExtension, type CorpusExtension } from './helpers/corpus.js';
import { patchForMatchedRules } from './helpers/feedbackCopy.js';
import { openPanel, startSession, tabIdOf, type Session } from './helpers/session.js';
import { expectAccessible } from './helpers/settingsPages.js';

const ALL = loadFixtures();
const byId = (id: string): FixtureEntry => {
  const found = ALL.find((f) => f.id === id);
  if (found === undefined) throw new Error(`${id} missing`);
  return found;
};
const THIRD_PARTY = byId('net/third-party');
const BY_TYPE = byId('net/by-type');

let server: FixtureServer;
let withFeedback: CorpusExtension;
let plain: CorpusExtension;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  [withFeedback, plain] = await Promise.all([createCorpusExtension(ALL), createCorpusExtension(ALL)]);
  await patchForMatchedRules(withFeedback.dir);
});

test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});

test.afterAll(async () => {
  try {
    await (server as FixtureServer | undefined)?.close();
    await (withFeedback as CorpusExtension | undefined)?.remove();
    await (plain as CorpusExtension | undefined)?.remove();
  } finally {
    await expectNoSurvivors();
  }
});

/**
 * Playwright reports the blocked request a little before Chrome lists the match for the tab; a panel opened in
 * between counts 0 and keeps that answer for MATCHED_CACHE_MS. With `settled`, wait until Chrome lists it.
 * Only the copy with `declarativeNetRequestFeedback` can ask, at most once per POLL_MS.
 */
const POLL_MS = 250;
const SETTLE_MS = 5_000;

async function matchedRulesListed(s: Session, tabId: number): Promise<void> {
  const count = (id: number): Promise<number> => chrome.declarativeNetRequest.getMatchedRules({ tabId: id }).then((r) => r.rulesMatchedInfo.length);
  await expect.poll(() => s.worker.evaluate(count, tabId), { intervals: [POLL_MS], timeout: SETTLE_MS }).toBeGreaterThan(0);
}

async function panelFor(s: Session, fixture: FixtureEntry, blocked: string, settled = false): Promise<Page> {
  const page = await s.context.newPage();
  const failed = page.waitForEvent('requestfailed', (r) => r.url() === blocked);
  await page.goto(fixture.page);
  await failed;
  const tabId = await tabIdOf(s.probe.page, fixture.page);
  if (settled) await matchedRulesListed(s, tabId);
  return openPanel(s, tabId);
}

test('J10 privacy panel: counts and buckets match the fixture requests; nothing but hostnames and counts', async () => {
  const s = await startSession(server, withFeedback.dir, contexts);
  const panel = await panelFor(s, THIRD_PARTY, 'https://ads.example/ad.js', true);
  const card = panel.getByRole('button', { name: /1 blocked on this page/ });
  await expect(card).toContainText('1 company · 1 ad');
  await card.focus();
  await panel.keyboard.press('Enter');
  await expect(panel.getByRole('heading', { name: 'What was blocked on news.example' })).toBeFocused();
  await expect(panel.locator('[data-category="ads"]')).toHaveText('Advertising1Acme Ads1');
  await expect(panel.getByText('1 blocked request matched 1 rule.')).toBeHidden();
  await panel.getByText('How this is counted').click();
  await expect(panel.getByText('1 blocked request matched 1 rule.')).toBeVisible();
  await expect(panel.getByText(/never the address of the request/)).toBeVisible();
  await expectAccessible(panel);
  const text = await panel.locator('main').innerText();
  expect(text).not.toMatch(/https?:\/\/|ad\.js|\/net\//);
  await panel.getByRole('button', { name: 'Back' }).click();
  await expect(card).toBeFocused();

  // A rule whose host is outside the map counts as "Other advertising".
  const other = await panelFor(s, BY_TYPE, 'https://pixel.example/p.gif', true);
  await other.getByRole('button', { name: /1 blocked on this page/ }).click();
  await expect(other.locator('[data-category="ads"]')).toHaveText('Advertising1Other advertising1');
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});

test('J10 without an activeTab grant: the panel says how to see the counts instead of guessing', async () => {
  const s = await startSession(server, plain.dir, contexts);
  const panel = await panelFor(s, THIRD_PARTY, 'https://ads.example/ad.js');
  await panel.getByRole('button', { name: /What was blocked on this page/ }).click();
  await expect(panel.locator('[data-state="unavailable"]')).toContainText('open this panel with the toolbar button');
  await expectAccessible(panel);
});
