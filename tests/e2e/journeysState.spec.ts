/**
 * Journeys J6 (pause and expiry) and J14 (corrupted settings), P1-46, testing notes §6, on the real build
 * with the fixture corpus. Settings reach the worker the way commands store them (the vault, then
 * `c/reconcile`), and from the panel's pause menu (P2-10, keyboard only); "Restore a backup" is P2-37, so
 * that step is `fixme`. The pause alarm is shown to wake a stopped worker exactly once (boot counter, D-17).
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type { Catalog } from '../../src/core/catalog/types.js';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import { loadFixtures, type FixtureEntry } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { lastRunSince, stopWorker } from './helpers/bootCounter.js';
import { closeAll, expectNoSurvivors } from './helpers/browser.js';
import { applySettings, createCorpusExtension, type CorpusExtension } from './helpers/corpus.js';
import { expectFixture } from './helpers/observe.js';
import { catalogOf, expectReconciled, openPanel, startSession, tabIdOf, vaultValue, type Session } from './helpers/session.js';

const ALL = loadFixtures();
const byId = (id: string): FixtureEntry => {
  const found = ALL.find((f) => f.id === id);
  if (found === undefined) throw new Error(`${id} missing`);
  return found;
};
const PAUSE_EXPIRY = byId('levels/pause-expiry');
const LEVEL_OFF = byId('levels/off');
const LEVEL_STANDARD = byId('levels/standard');
const LEVELS_HOST = new URL(LEVEL_STANDARD.page).hostname;
/** Long enough to check the paused state and stop the worker before the alarm; short enough to wait for. */
const PAUSE_MS = 12_000;
const ALARM_POLL = { timeout: 30_000, intervals: [250, 500] };
const POLL = { timeout: 10_000, intervals: [50, 100, 250] };
const JOURNEY_TIMEOUT_MS = 90_000;
/** A value no schema accepts: wrong types throughout, as a damaged or hand-edited store would hold. */
const CORRUPTED = { schemaVersion: 1, defaultLevel: 'turbo', siteLevels: 'everything', pauses: [] };

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

const start = (): Promise<Session> => startSession(server, extension.dir, contexts);

async function panelForLevelsPage(s: Session): Promise<ReturnType<typeof openPanel>> {
  const page = await s.context.newPage();
  await page.goto(LEVEL_STANDARD.page);
  return openPanel(s, await tabIdOf(s.probe.page, `https://${LEVELS_HOST}/`));
}

test('J6 pause and expiry: off now, the panel says paused, back on after the alarm wakes the stopped worker once', async () => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const s = await start();
  const since = Date.now();
  await applySettings(s.context, s.worker, s.id, { ...createDefaultSettings(), pauses: { [LEVELS_HOST]: { until: since + PAUSE_MS } } });
  await expectFixture(server, s.context, PAUSE_EXPIRY, PAUSE_EXPIRY.setup?.duringPause ?? [], { afterChange: true });
  const panel = await panelForLevelsPage(s);
  await expect(panel.locator('[data-state="paused"]')).toContainText('Paused for');
  await panel.close();

  await stopWorker(s.profile, s.id);
  const before = await s.probe.boots();
  // The alarm is still ahead of a stopped worker, so the wake below is the alarm's.
  expect(await s.probe.page.evaluate(async () => (await chrome.alarms.get('pause-expiry'))?.scheduledTime ?? 0)).toBeGreaterThan(Date.now());
  expect((await s.probe.last())?.reason).toBe('command');
  await expect.poll(async () => (await s.probe.last())?.reason, ALARM_POLL).toBe('pause-expiry');
  const run = await lastRunSince(s.probe, since, /^pause-expiry$/);
  expect(run.status).toBe('applied');
  expect(await s.probe.boots(), 'the alarm wakes the worker once').toBe(before + 1);

  await expectFixture(server, s.context, PAUSE_EXPIRY, PAUSE_EXPIRY.expect, { afterChange: true });
  await expectReconciled(s.probe.page, catalog);
  expect(await s.probe.page.evaluate(() => chrome.alarms.getAll())).toEqual([]);
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});

/** Presses Tab until `name` has focus (the panel re-renders after a command, so the count varies). */
async function tabTo(panel: Page, name: string, max = 8): Promise<void> {
  const target = panel.getByRole('button', { name });
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await panel.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

test('J6 pause from the panel pause menu, keyboard only: paused 30 minutes, the panel reloads the tab (P2-10)', async () => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const s = await start();
  const page = await s.context.newPage();
  await page.goto(LEVEL_STANDARD.page);
  const panel = await openPanel(s, await tabIdOf(s.probe.page, `https://${LEVELS_HOST}/`));
  await expect(panel.locator('[data-state="normal"]')).toContainText('Protected — Standard');

  await tabTo(panel, 'Pause on this site');
  await panel.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Pause on this site' })).toHaveAttribute('aria-expanded', 'true');
  await panel.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: '30 minutes' })).toBeFocused();
  const since = Date.now();
  await panel.keyboard.press('Enter');
  await expect(panel.locator('[data-state="paused"]')).toContainText('Paused for 30 more minutes');
  const stored = (await vaultValue(s.probe.page, 'settings')) as { pauses: Record<string, { until: number }> };
  const until = stored.pauses[LEVELS_HOST]?.until ?? 0;
  expect(until - since).toBeGreaterThanOrEqual(30 * 60_000 - 1_000);
  expect(until - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  await expectReconciled(s.probe.page, catalog);

  // "Reload page" reloads the fixture tab with tabs.reload (no `tabs` permission; design review, P2-10).
  await tabTo(panel, 'Reload page');
  const ad = page.waitForResponse((r) => r.url() === 'https://lvl-ads.example/ad.js');
  const loaded = page.waitForEvent('load');
  await panel.keyboard.press('Enter');
  await loaded;
  expect((await ad).ok(), 'paused: the ad request goes through after the reload').toBe(true);
  expect(await page.evaluate(() => document.documentElement.dataset['probe'] ?? null), 'paused: no content script').toBeNull();
  await expect(panel.getByText('Page reloaded.')).toBeVisible();
  expect(await s.probe.page.evaluate(async () => (await chrome.alarms.get('pause-expiry'))?.scheduledTime)).toBe(until);
  expect((await lastRunSince(s.probe, since, /^command$/)).status).toBe('applied');
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});

test('J14 corrupted settings: defaults applied, the panel shows the reset notice, no crash', async () => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const s = await start();
  await applySettings(s.context, s.worker, s.id, { ...createDefaultSettings(), siteLevels: { [LEVELS_HOST]: 'off' } });
  await expectFixture(server, s.context, LEVEL_OFF, LEVEL_OFF.expect, { afterChange: true });

  const since = Date.now();
  await applySettings(s.context, s.worker, s.id, CORRUPTED);
  expect(await lastRunSince(s.probe, since, /^command$/)).toMatchObject({ status: 'applied' });

  // Defaults: the site is back at Standard, and Chrome's state is the defaults' desired state.
  await expectFixture(server, s.context, LEVEL_STANDARD, LEVEL_STANDARD.expect, { afterChange: true });
  await expectReconciled(s.probe.page, catalog);
  expect(await vaultValue(s.probe.page, 'notice')).toMatchObject({ kind: 'settings-reset', reason: 'invalid' });
  // Never a silent overwrite: the damaged value stays until the user changes a setting.
  expect(await vaultValue(s.probe.page, 'settings')).toEqual(CORRUPTED);

  const panel = await panelForLevelsPage(s);
  await expect(panel.locator('[data-state="reset"]')).toContainText('Your settings were reset because they could not be read');
  // Its "Restore a backup" action is not drawn until backups exist (P2-37, fixme below).
  await expect(panel.getByRole('button', { name: 'Restore a backup' })).toHaveCount(0);
  // D-32: dismissing clears the stored notice; the settings themselves are left as they are.
  await panel.getByRole('button', { name: 'Dismiss' }).click();
  await expect(panel.locator('[data-state="normal"]')).toContainText('Protected — Standard');
  await expect.poll(() => vaultValue(s.probe.page, 'notice'), POLL).toMatchObject({ kind: 'settings-reset', dismissedAt: expect.any(Number) });
  await panel.reload();
  await expect(panel.locator('[data-state="normal"]')).toContainText('Protected — Standard');
  expect(await vaultValue(s.probe.page, 'settings')).toEqual(CORRUPTED);

  // No crash: the worker still answers commands and runs cleanly.
  const again: unknown = await s.probe.page.evaluate(() => chrome.runtime.sendMessage<object, unknown>({ v: 1, type: 'c/reconcile', id: 'j14', payload: {} }));
  expect(again).toEqual({ ok: true, data: { status: 'unchanged', skippedPacks: [] } });
  await expect.poll(async () => (await s.probe.last())?.status, POLL).toBe('unchanged');
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});

test.fixme('J14 "Restore a backup" from the reset notice, and the notice cleared afterwards — P2-37', () => {
  // Backup import (P2-37) delivers the restore; no task names clearing the notice yet (logged as a follow-up).
});
