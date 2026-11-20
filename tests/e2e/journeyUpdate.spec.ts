/**
 * Journey J13 (P1-46, testing notes §6): a simulated extension update, ruleset-only and full, applied in
 * place with CDP `Extensions.loadUnpacked` (same id, `onInstalled(update)`, S-07/S-17). A ruleset-only
 * release is a repack (update-strategy notes §3): one safe ruleset file and `version` change. A full release also
 * changes code and the catalog. Afterwards: the user's state is kept (vault settings, dynamic rules,
 * the running pause and its alarm), Chrome's state equals `computeDesired`, the new rules work, and
 * the update window is within D-19 — at fixture scale only; the full-scale gate is `reconcileScale`.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type BrowserContext } from '@playwright/test';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import { loadFixtures } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { lastRunSince, openProbe, type ExtensionProbe } from './helpers/bootCounter.js';
import { closeAll, expectNoSurvivors, updateInPlace } from './helpers/browser.js';
import { applySettings, createCorpusExtension, type CorpusExtension } from './helpers/corpus.js';
import { expectFixture, navigate } from './helpers/observe.js';
import { expectBudget } from './helpers/perf.js';
import { catalogOf, expectReconciled, startSession, vaultValue } from './helpers/session.js';

const ALL = loadFixtures();
const LEVEL_OFF = ALL.find((f) => f.id === 'levels/off');
/** D-19 (performance notes §2.2), as upper bounds at fixture scale. */
const SCRIPTLETS_MS = 500;
const ALL_REGISTRATIONS_MS = 3_000;
const WINDOW_MS = 3_500;
const HOUR_MS = 3_600_000;
const NEW_HOST = 'j13-update.example';
const NEW_PAGE = `https://${NEW_HOST}/page`;
const NEW_REGISTRATION = 'iso:fx:j13';
const JOURNEY_TIMEOUT_MS = 90_000;

let server: FixtureServer;
const extensions: CorpusExtension[] = [];
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
});

test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
  await Promise.all(extensions.splice(0).map((e) => e.remove()));
});

test.afterAll(async () => {
  try {
    await (server as FixtureServer | undefined)?.close();
  } finally {
    await expectNoSurvivors();
  }
});

async function editJson(file: string, change: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await writeFile(file, JSON.stringify(change(JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>)));
}

/** Repack: a new safe block rule in `fx.json` (a page on a new host), and a higher version. */
async function rulesetOnly(dir: string): Promise<void> {
  const file = path.join(dir, 'rulesets/fx.json');
  const rules = JSON.parse(await readFile(file, 'utf8')) as { id: number }[];
  const id = Math.max(...rules.map((r) => r.id)) + 1;
  const added = { id, priority: 1, action: { type: 'block' }, condition: { urlFilter: `||${NEW_HOST}^`, resourceTypes: ['main_frame'] } };
  await writeFile(file, JSON.stringify([...rules, added]));
  await editJson(path.join(dir, 'manifest.json'), (m) => ({ ...m, version: '0.0.2' }));
}

/** Full release: changed worker code and a new registration in the catalog, and a higher version. */
async function fullRelease(dir: string): Promise<void> {
  await appendFile(path.join(dir, 'background.js'), '\n// J13 full release\n');
  await editJson(path.join(dir, 'catalog.json'), (c) => {
    const packs = c['packs'] as { ads: { registrations: object[] } };
    const added = { id: NEW_REGISTRATION, world: 'ISOLATED', js: ['cs/fx-probe.js'], hosts: [NEW_HOST] };
    return { ...c, packs: { ...packs, ads: { ...packs.ads, registrations: [...packs.ads.registrations, added] } } };
  });
  await editJson(path.join(dir, 'manifest.json'), (m) => ({ ...m, version: '0.0.2' }));
}

interface Kept {
  readonly settings: unknown;
  readonly dynamic: unknown;
  readonly alarm: number | undefined;
  readonly scripts: readonly string[];
}

async function kept(probe: ExtensionProbe): Promise<Kept> {
  const chromeSide = await probe.page.evaluate(async () => ({
    dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
    alarm: (await chrome.alarms.get('pause-expiry'))?.scheduledTime,
    scripts: (await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id).sort(),
  }));
  return { settings: await vaultValue(probe.page, 'settings'), ...chromeSide };
}

/** Installs, stores a site level and a running pause, updates in place; returns the state before. */
async function updateJourney(prepare: (dir: string) => Promise<void>): Promise<{ before: Kept; after: Kept; probe: ExtensionProbe; dir: string }> {
  if (LEVEL_OFF === undefined) throw new Error('levels/off missing');
  const extension = await createCorpusExtension(ALL);
  extensions.push(extension);
  const s = await startSession(server, extension.dir, contexts);
  const settings = { ...createDefaultSettings(), siteLevels: { [new URL(LEVEL_OFF.page).hostname]: 'off' }, pauses: { 'perm.example': { until: Date.now() + HOUR_MS } } };
  await applySettings(s.context, s.worker, s.id, settings);
  expect(await navigate(s.context, NEW_PAGE)).toBe('loaded');
  const before = await kept(s.probe);

  await prepare(extension.dir);
  const { startedAt } = await updateInPlace(s.context, s.profile, extension.dir);
  // The update closes the extension's pages: read through a new probe.
  const probe = await openProbe(s.context, s.id);
  const run = await lastRunSince(probe, startedAt, /^installed:update$/);
  expect(run.status).toBe('applied');
  const windowMs = run.at - startedAt;
  test.info().annotations.push({ type: 'update window (fixture scale)', description: `${String(windowMs)} ms; run ${String(run.durationMs)} ms; scriptlets ${String(run.scriptletsMs)} ms` });
  expectBudget('update window (ms)', windowMs, WINDOW_MS);
  expectBudget('all registrations restored (ms)', run.durationMs, ALL_REGISTRATIONS_MS);
  if (run.scriptletsMs !== undefined) expectBudget('scriptlets restored (ms)', run.scriptletsMs, SCRIPTLETS_MS);

  await expectFixture(server, s.context, LEVEL_OFF, LEVEL_OFF.expect, { afterChange: true });
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
  return { before, after: await kept(probe), probe, dir: extension.dir };
}

test('J13 ruleset-only update: state kept, registrations back as they were, the new rule blocks', { tag: '@budget' }, async () => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const { before, after, probe, dir } = await updateJourney(rulesetOnly);
  expect(after).toEqual(before);
  await expectReconciled(probe.page, await catalogOf(dir));
  expect(await navigate(probe.page.context(), NEW_PAGE)).toBe('blocked');
});

test('J13 full update: state kept, the new registration in, Chrome state is the new desired state', { tag: '@budget' }, async () => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const { before, after, probe, dir } = await updateJourney(fullRelease);
  expect({ ...after, scripts: after.scripts.filter((id) => id !== NEW_REGISTRATION) }).toEqual(before);
  expect(after.scripts).toContain(NEW_REGISTRATION);
  await expectReconciled(probe.page, await catalogOf(dir));

  const page = await probe.page.context().newPage();
  await page.goto(NEW_PAGE);
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-probe'))).toBe('ran');
});
